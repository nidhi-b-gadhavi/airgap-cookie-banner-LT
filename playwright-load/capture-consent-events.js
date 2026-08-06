require('./load-env');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const BASE_URL = (process.env.BASE_URL || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const OUTPUT_PATH =
  (process.env.OUTPUT_PATH || './playwright-load/results/consent-event-capture.json').trim();
const HEADLESS = (process.env.HEADLESS || 'false').trim().toLowerCase() === 'true';
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 90000);

const EXPECTED_PURPOSES = {
  ProgramTcpaTpo: 'Auto',
  EnterpriseHipaaAuthorization: 'Auto',
  EnterpriseMarketing: 'Auto',
  EnterpriseMarketResearch: 'Auto',
  EnterpriseMedicalResearch: 'Auto',
  EmailCommunicationPreference: 'Auto',
  ProgramTcpaMarketing: 'Auto',
  Functional: true,
  Analytics: true,
  Advertising: false,
  SaleOfInfo: 'Auto',
};

function isMicrosoftLoginUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('login.microsoftonline.com') || value.includes('microsoft.com');
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\nAfter you click More choices and checkbox(es), press Enter here to finish capture...\n', () => {
      rl.close();
      resolve();
    });
  });
}

function waitForPrompt(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function extractJsonCandidatesFromText(text) {
  const candidates = [];
  const raw = String(text || '');
  if (!raw) return candidates;

  const direct = safeJsonParse(raw);
  if (direct && typeof direct === 'object') {
    candidates.push(direct);
  }

  const decoded = decodeURIComponentSafe(raw);
  if (decoded !== raw) {
    const parsedDecoded = safeJsonParse(decoded);
    if (parsedDecoded && typeof parsedDecoded === 'object') {
      candidates.push(parsedDecoded);
    }
  }

  const pairs = raw.split('&');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    const val = idx >= 0 ? pair.slice(idx + 1) : pair;
    const valDecoded = decodeURIComponentSafe(val);
    const parsed = safeJsonParse(valDecoded);
    if (parsed && typeof parsed === 'object') {
      candidates.push(parsed);
    }
  }

  const objectLikeMatches = raw.match(/\{[\s\S]{20,}\}/g) || [];
  for (const match of objectLikeMatches) {
    const parsed = safeJsonParse(match);
    if (parsed && typeof parsed === 'object') {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function findConsentLikePayloads(input, maxDepth = 5) {
  const results = [];
  const seen = new Set();

  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > maxDepth) return;
    if (seen.has(value)) return;
    seen.add(value);

    const hasPurposes = Object.prototype.hasOwnProperty.call(value, 'purposes');
    const hasFlags =
      Object.prototype.hasOwnProperty.call(value, 'confirmed') ||
      Object.prototype.hasOwnProperty.call(value, 'prompted') ||
      Object.prototype.hasOwnProperty.call(value, 'updated');

    if (hasPurposes || hasFlags) {
      results.push(value);
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        walk(child, depth + 1);
      }
    }
  };

  walk(input, 0);
  return results;
}

function validateConsentPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { passed: false, reason: 'payload-not-object' };
  }

  const purposes = payload.purposes;
  if (!purposes || typeof purposes !== 'object') {
    return { passed: false, reason: 'missing-purposes' };
  }

  for (const [key, expected] of Object.entries(EXPECTED_PURPOSES)) {
    if (purposes[key] !== expected) {
      return {
        passed: false,
        reason: 'purpose-mismatch',
        mismatch: { key, expected, actual: purposes[key] },
      };
    }
  }

  if (payload.confirmed !== true || payload.prompted !== true || payload.updated !== true) {
    return {
      passed: false,
      reason: 'flags-mismatch',
      flags: {
        confirmed: payload.confirmed,
        prompted: payload.prompted,
        updated: payload.updated,
      },
    };
  }

  const ts = String(payload.timestamp || '');
  if (!ts || Number.isNaN(Date.parse(ts))) {
    return { passed: false, reason: 'invalid-timestamp', timestamp: payload.timestamp };
  }

  return { passed: true };
}

function buildConsentPayloadValidation(network, capture) {
  const candidates = [];

  for (const item of network) {
    if (item.kind !== 'request') continue;
    const postData = item.postData || '';
    const parsed = extractJsonCandidatesFromText(postData);
    for (const p of parsed) {
      const nested = findConsentLikePayloads(p);
      if (nested.length) {
        for (const n of nested) {
          candidates.push({ source: 'network.postData', url: item.url, payload: n });
        }
      } else {
        candidates.push({ source: 'network.postData', url: item.url, payload: p });
      }
    }
  }

  const logs = capture && Array.isArray(capture.logs) ? capture.logs : [];
  for (const log of logs) {
    const args = Array.isArray(log.args) ? log.args : [];
    for (const arg of args) {
      const parsed = extractJsonCandidatesFromText(arg);
      for (const p of parsed) {
        const nested = findConsentLikePayloads(p);
        if (nested.length) {
          for (const n of nested) {
            candidates.push({ source: 'console.log', payload: n });
          }
        } else {
          candidates.push({ source: 'console.log', payload: p });
        }
      }
    }
  }

  const storage = capture && capture.storageSnapshot ? capture.storageSnapshot : null;
  if (storage) {
    const sources = [
      ...(Array.isArray(storage.localStorage) ? storage.localStorage.map((x) => ({ ...x, kind: 'localStorage' })) : []),
      ...(Array.isArray(storage.sessionStorage) ? storage.sessionStorage.map((x) => ({ ...x, kind: 'sessionStorage' })) : []),
      ...(Array.isArray(storage.cookies) ? storage.cookies.map((x) => ({ ...x, kind: 'cookie' })) : []),
    ];

    for (const entry of sources) {
      const text = entry.value;
      const parsed = extractJsonCandidatesFromText(text);
      for (const p of parsed) {
        const nested = findConsentLikePayloads(p);
        if (nested.length) {
          for (const n of nested) {
            candidates.push({
              source: `storage.${entry.kind}`,
              key: entry.key || entry.name || null,
              payload: n,
            });
          }
        } else {
          candidates.push({
            source: `storage.${entry.kind}`,
            key: entry.key || entry.name || null,
            payload: p,
          });
        }
      }
    }
  }

  const validations = candidates.map((entry) => {
    const result = validateConsentPayload(entry.payload);
    return {
      source: entry.source,
      url: entry.url || null,
      key: entry.key || null,
      passed: result.passed,
      reason: result.reason || null,
      mismatch: result.mismatch || null,
      flags: result.flags || null,
      timestamp: entry.payload && entry.payload.timestamp ? entry.payload.timestamp : null,
      payload: entry.payload,
    };
  });

  const firstPass = validations.find((v) => v.passed);

  return {
    passed: Boolean(firstPass),
    expectedPurposes: EXPECTED_PURPOSES,
    matchedPayload: firstPass || null,
    checkedCandidates: validations.length,
    sampleCandidates: validations.slice(0, 10),
  };
}

async function addConsentCaptureInit(page) {
  await page.addInitScript(() => {
    const capture = {
      startedAt: new Date().toISOString(),
      events: [],
      logs: [],
      transcendCalls: [],
    };

    const maxEvents = 500;
    const now = () => Date.now();

    const textOf = (el) => {
      if (!el || typeof el !== 'object') return '';
      const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return raw.slice(0, 160);
    };

    const describeNode = (node) => {
      if (!node || typeof node !== 'object') return null;
      const tag = node.tagName ? String(node.tagName).toLowerCase() : String(node.nodeName || '').toLowerCase();
      const id = node.id || '';
      const className = typeof node.className === 'string' ? node.className : '';
      const role = node.getAttribute ? node.getAttribute('role') : null;
      return {
        tag,
        id,
        className: className ? className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '',
        role,
        text: textOf(node),
      };
    };

    const pushEvent = (type, ev) => {
      if (!capture || !capture.events) return;
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      const pathSummary = Array.isArray(path) ? path.slice(0, 8).map(describeNode).filter(Boolean) : [];

      const target = describeNode(ev.target);
      const active = describeNode(document.activeElement);
      capture.events.push({
        ts: now(),
        type,
        isTrusted: Boolean(ev.isTrusted),
        target,
        activeElement: active,
        path: pathSummary,
      });

      if (capture.events.length > maxEvents) {
        capture.events.shift();
      }
    };

    document.addEventListener('click', (ev) => pushEvent('click', ev), true);
    document.addEventListener('change', (ev) => pushEvent('change', ev), true);
    document.addEventListener('input', (ev) => pushEvent('input', ev), true);

    const originalLog = console.log;
    console.log = function patchedLog(...args) {
      try {
        capture.logs.push({ ts: now(), level: 'log', args: args.map((a) => String(a)).slice(0, 5) });
      } catch (_) {}
      return originalLog.apply(this, args);
    };

    const originalWarn = console.warn;
    console.warn = function patchedWarn(...args) {
      try {
        capture.logs.push({ ts: now(), level: 'warn', args: args.map((a) => String(a)).slice(0, 5) });
      } catch (_) {}
      return originalWarn.apply(this, args);
    };

    const patchTranscend = () => {
      if (!window.transcend || window.transcend.__capturePatched) return;
      const transcend = window.transcend;
      transcend.__capturePatched = true;

      const wrapMethod = (name) => {
        if (typeof transcend[name] !== 'function') return;
        const original = transcend[name];
        transcend[name] = function wrappedTranscendMethod(...args) {
          capture.transcendCalls.push({ ts: now(), method: name, args: args.map((a) => String(a)).slice(0, 5) });
          return original.apply(this, args);
        };
      };

      wrapMethod('showConsentManager');
      wrapMethod('hideConsentManager');
      wrapMethod('setConsent');
    };

    patchTranscend();
    setInterval(patchTranscend, 1000);

    window.__consentCapture = capture;
  });
}

async function main() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required.');
  }

  const statePath = path.resolve(AUTH_STATE_PATH);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Auth state file not found at ${statePath}. Run auth-bootstrap-ms.js first.`);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ storageState: AUTH_STATE_PATH });
  const page = await context.newPage();

  const network = [];
  const consentPattern = /(consent|cookie|transcend)/i;

  page.on('request', (request) => {
    const url = request.url();
    if (!consentPattern.test(url)) return;
    network.push({
      ts: Date.now(),
      kind: 'request',
      method: request.method(),
      url,
      postData: request.postData() ? request.postData().slice(0, 1000) : null,
    });
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!consentPattern.test(url)) return;
    network.push({
      ts: Date.now(),
      kind: 'response',
      status: response.status(),
      url,
    });
  });

  await addConsentCaptureInit(page);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  if (isMicrosoftLoginUrl(page.url())) {
    console.log('\nAuth state appears stale. Complete Microsoft login in the browser, then continue.');
    await waitForPrompt('After login completes and app page is visible, press Enter here...\n');
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

    if (isMicrosoftLoginUrl(page.url())) {
      console.log('Still on Microsoft login page after manual step. Re-run auth bootstrap and retry.');
      await browser.close();
      process.exit(1);
    }
  }

  console.log('\nCapture mode is ON. Perform these actions in the opened browser window:');
  console.log('1) Open More choices in cookie banner');
  console.log('2) Click one or more checkboxes in the dialog');
  console.log('3) Optional: save/apply in the dialog');

  await waitForEnter();

  const capture = await page.evaluate(() => window.__consentCapture || null);
  const storageSnapshot = await page.evaluate(() => {
    const ls = [];
    const ss = [];

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      ls.push({ key, value: key ? localStorage.getItem(key) : null });
    }

    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      ss.push({ key, value: key ? sessionStorage.getItem(key) : null });
    }

    return {
      localStorage: ls,
      sessionStorage: ss,
      documentCookie: document.cookie,
    };
  });

  const browserCookies = await context.cookies();
  const storageSnapshotWithCookies = {
    ...storageSnapshot,
    cookies: browserCookies.map((c) => ({ name: c.name, domain: c.domain, value: c.value })),
  };

  const captureWithStorage = {
    ...(capture || {}),
    storageSnapshot: storageSnapshotWithCookies,
  };
  const consentPayloadValidation = buildConsentPayloadValidation(network, captureWithStorage);
  const output = {
    scenario: 'consent-event-capture',
    baseUrl: BASE_URL,
    capturedAt: new Date().toISOString(),
    finalUrl: page.url(),
    capture: captureWithStorage,
    network,
    consentPayloadValidation,
    hints: [
      'Look at capture.events for click/change target and composed path.',
      'Look at capture.transcendCalls for SDK method invocations.',
      'Look at network for consent/cookie/transcend request payloads.',
    ],
  };

  const resolvedOutput = path.resolve(OUTPUT_PATH);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nCapture complete. Output saved to ${resolvedOutput}`);
  console.log(`Consent payload validation passed: ${consentPayloadValidation.passed}`);
  console.log(`Checked payload candidates: ${consentPayloadValidation.checkedCandidates}`);

  await browser.close();
}

main().catch((error) => {
  console.error('consent event capture failed:', error);
  process.exit(1);
});
