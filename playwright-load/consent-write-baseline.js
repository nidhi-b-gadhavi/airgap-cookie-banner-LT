require('./load-env');
const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE_URL = (process.env.BASE_URL || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const USE_AUTH_STATE = (process.env.USE_AUTH_STATE || 'true').trim().toLowerCase() !== 'false';
const OUTPUT_PATH = (process.env.OUTPUT_PATH || './playwright-load/results/summary-consent-write-baseline.json').trim();

const CONSENT_WRITE_ENDPOINT = (process.env.CONSENT_WRITE_ENDPOINT || '/api/consent').trim();
const CONSENT_WRITE_METHOD = (process.env.CONSENT_WRITE_METHOD || 'POST').trim().toUpperCase();
const CONSENT_PAYLOAD_JSON = (process.env.CONSENT_PAYLOAD_JSON || '').trim();

const BASELINE_RUNS = toPositiveInt(process.env.BASELINE_RUNS, 5);
const WRITE_THRESHOLD_MS = toPositiveInt(process.env.BASELINE_WRITE_THRESHOLD_MS, 100);
const REQUEST_TIMEOUT_MS = toPositiveInt(process.env.TIMEOUT_MS, 30000);
const NAV_TIMEOUT_MS = toPositiveInt(process.env.NAV_TIMEOUT_MS, 90000);
const HEADLESS = (process.env.HEADLESS || 'true').trim().toLowerCase() !== 'false';

const COOKIE_ACTION = (process.env.COOKIE_ACTION || 'accept').trim().toLowerCase();
const COOKIE_BANNER_SELECTOR =
  (process.env.COOKIE_BANNER_SELECTOR || '[id*=cookie], [class*=cookie], [aria-label*=cookie], [data-testid*=cookie]').trim();
const COOKIE_ACCEPT_SELECTOR =
  (process.env.COOKIE_ACCEPT_SELECTOR || 'button:has-text("Accept all"), button:has-text("Accept"), [id*=accept]').trim();
const COOKIE_REJECT_SELECTOR =
  (process.env.COOKIE_REJECT_SELECTOR || 'button:has-text("Reject all"), button:has-text("Reject"), [id*=reject]').trim();
const COOKIE_MORE_SELECTOR =
  (process.env.COOKIE_MORE_SELECTOR || 'button:has-text("More choices"), button:has-text("Manage"), [id*=preferences]').trim();

const CONSENT_COOKIE_KEY = (process.env.CONSENT_COOKIE_KEY || 'tcm').trim();
const CONSENT_LOCALSTORAGE_KEY = (process.env.CONSENT_LOCALSTORAGE_KEY || 'tcmConsent').trim();

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function latencySummary(values) {
  if (!values.length) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    avgMs: Number((total / sorted.length).toFixed(2)),
  };
}

function resolveUrl(baseUrl, endpoint) {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  const prefix = endpoint.startsWith('/') ? '' : '/';
  return `${baseUrl}${prefix}${endpoint}`;
}

function defaultConsentPayload() {
  return {
    purposes: {
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
    },
    timestamp: new Date().toISOString(),
    confirmed: true,
    prompted: true,
    updated: true,
  };
}

function buildPayload() {
  if (!CONSENT_PAYLOAD_JSON) {
    return defaultConsentPayload();
  }

  try {
    return JSON.parse(CONSENT_PAYLOAD_JSON);
  } catch (error) {
    throw new Error(`CONSENT_PAYLOAD_JSON is not valid JSON: ${error.message}`);
  }
}

function isMicrosoftLoginUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('login.microsoftonline.com') || value.includes('microsoft.com');
}

function cookieSelectorForAction(action) {
  if (action === 'reject') return COOKIE_REJECT_SELECTOR;
  if (action === 'more') return COOKIE_MORE_SELECTOR;
  return COOKIE_ACCEPT_SELECTOR;
}

function actionMatchers(action) {
  if (action === 'reject') {
    return {
      text: ['reject all', 'reject'],
      attr: ['reject'],
    };
  }

  if (action === 'more') {
    return {
      text: ['more choices', 'manage', 'preferences'],
      attr: ['more', 'manage', 'preference'],
    };
  }

  return {
    text: ['accept all', 'accept'],
    attr: ['accept'],
  };
}

async function clickCookieActionFromShadowDom(page, action) {
  const matchers = actionMatchers(action);

  return page.evaluate(({ textMatchers, attrMatchers }) => {
    function normalize(value) {
      return String(value || '').toLowerCase().trim();
    }

    function allRoots(startRoot) {
      const roots = [startRoot];
      for (let i = 0; i < roots.length; i += 1) {
        const root = roots[i];
        const tree = root.querySelectorAll('*');
        for (const node of tree) {
          if (node.shadowRoot) {
            roots.push(node.shadowRoot);
          }
        }
      }
      return roots;
    }

    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function scoreElement(el) {
      const text = normalize(el.innerText || el.textContent || '');
      const attrs = normalize(
        [
          el.getAttribute('id'),
          el.getAttribute('class'),
          el.getAttribute('name'),
          el.getAttribute('aria-label'),
          el.getAttribute('data-testid'),
          el.getAttribute('title'),
          el.getAttribute('value'),
        ]
          .filter(Boolean)
          .join(' ')
      );

      let score = 0;
      for (const m of textMatchers) {
        if (text.includes(m)) score += 10;
      }
      for (const m of attrMatchers) {
        if (attrs.includes(m)) score += 6;
      }
      if (isVisible(el)) score += 5;
      return { score, text, attrs };
    }

    const roots = allRoots(document);
    const candidates = [];
    const selector = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

    for (const root of roots) {
      const elements = root.querySelectorAll(selector);
      for (const el of elements) {
        const s = scoreElement(el);
        if (s.score > 0) {
          candidates.push({ el, score: s.score, text: s.text, attrs: s.attrs });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length) {
      return { clicked: false, reason: 'no-matching-action-control-found-in-shadow-dom' };
    }

    const target = candidates[0].el;
    try {
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'center' });
      }

      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();

      return {
        clicked: true,
        reason: 'clicked-via-shadow-dom-fallback',
        topScore: candidates[0].score,
      };
    } catch (error) {
      return {
        clicked: false,
        reason: `shadow-dom-click-failed:${String(error && error.message ? error.message : error)}`,
      };
    }
  }, {
    textMatchers: matchers.text,
    attrMatchers: matchers.attr,
  });
}

async function verifyConsentArtifacts() {
  const statePath = path.resolve(AUTH_STATE_PATH);
  const contextOptions = {
    ignoreHTTPSErrors: true,
  };

  if (USE_AUTH_STATE) {
    if (!fs.existsSync(statePath)) {
      throw new Error(`Auth state file not found at ${statePath}. Run auth-bootstrap-ms.js first.`);
    }
    contextOptions.storageState = statePath;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    if (isMicrosoftLoginUrl(page.url())) {
      throw new Error('Redirected to Microsoft login while verifying cookie consent. Refresh auth state first.');
    }

    // Clear any existing consent so the banner appears again on reload.
    await context.clearCookies();
    await page.evaluate((storageKey) => {
      localStorage.removeItem(storageKey);
    }, CONSENT_LOCALSTORAGE_KEY);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Wait for the Transcend SDK to initialise and render the banner.
    await page.waitForFunction(() => Boolean(window.transcend && window.transcend.ready), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const selector = cookieSelectorForAction(COOKIE_ACTION);
    let clickResult = { clicked: false, reason: 'not-attempted' };

    try {
      const button = page.locator(selector).first();
      await button.click({ timeout: 5000 });
      clickResult = { clicked: true, reason: 'clicked-via-playwright-selector' };
    } catch (_error) {
      clickResult = await clickCookieActionFromShadowDom(page, COOKIE_ACTION);
      if (!clickResult.clicked) {
        throw new Error(
          `Cookie action click failed for action=${COOKIE_ACTION}. ` +
            `Selector="${selector}", fallbackReason="${clickResult.reason}"`
        );
      }
    }

    await page.waitForTimeout(1000);

    const cookies = await context.cookies();
    const hasConsentCookie = cookies.some((cookie) =>
      String(cookie && cookie.name ? cookie.name : '').toLowerCase().includes(CONSENT_COOKIE_KEY.toLowerCase())
    );

    const localStorageKeys = await page.evaluate(() => Object.keys(localStorage || {}));
    const hasConsentLocalStorage = localStorageKeys.includes(CONSENT_LOCALSTORAGE_KEY);

    return {
      cookieAction: COOKIE_ACTION,
      consentCookieKey: CONSENT_COOKIE_KEY,
      consentLocalStorageKey: CONSENT_LOCALSTORAGE_KEY,
      hasConsentCookie,
      hasConsentLocalStorage,
      passed: hasConsentCookie && hasConsentLocalStorage,
      clickResult,
      localStorageKeys,
      cookieNames: cookies.map((cookie) => cookie.name),
      finalUrl: page.url(),
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close();
  }
}

async function main() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required.');
  }

  if (!['accept', 'reject', 'more'].includes(COOKIE_ACTION)) {
    throw new Error('COOKIE_ACTION must be one of: accept, reject, more');
  }

  const consentCheck = await verifyConsentArtifacts();
  if (!consentCheck.passed) {
    throw new Error(
      `Consent artifact check failed for COOKIE_ACTION=${COOKIE_ACTION}. ` +
        `Expected cookie containing "${CONSENT_COOKIE_KEY}" and localStorage key "${CONSENT_LOCALSTORAGE_KEY}".`
    );
  }

  const url = resolveUrl(BASE_URL, CONSENT_WRITE_ENDPOINT);
  const payloadTemplate = buildPayload();

  const contextOptions = {
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: BASE_URL,
    },
  };

  if (USE_AUTH_STATE) {
    const statePath = path.resolve(AUTH_STATE_PATH);
    if (!fs.existsSync(statePath)) {
      throw new Error(`Auth state file not found at ${statePath}. Run auth-bootstrap-ms.js first.`);
    }
    contextOptions.storageState = statePath;
  }

  const apiContext = await request.newContext(contextOptions);
  const startedAt = new Date().toISOString();

  try {
    const rows = [];
    for (let i = 1; i <= BASELINE_RUNS; i += 1) {
      const payload = {
        ...payloadTemplate,
        timestamp: new Date().toISOString(),
      };

      const start = Date.now();
      try {
        const response = await apiContext.fetch(url, {
          method: CONSENT_WRITE_METHOD,
          timeout: REQUEST_TIMEOUT_MS,
          data: payload,
        });
        const durationMs = Date.now() - start;

        rows.push({
          run: i,
          ok: response.ok(),
          status: response.status(),
          durationMs,
        });
      } catch (error) {
        rows.push({
          run: i,
          ok: false,
          status: 0,
          durationMs: Date.now() - start,
          error: String(error && error.message ? error.message : error),
        });
      }
    }

    const successes = rows.filter((r) => r.ok);
    const failures = rows.filter((r) => !r.ok);
    const writeDurations = successes.map((r) => r.durationMs);
    const stats = latencySummary(writeDurations);

    const summary = {
      testCaseId: 'LT-BW-01',
      scenario: 'Single User Consent API Write Baseline',
      objective: 'Record unloaded consent API write latency baseline for concurrent write tests',
      expectedResult: `Average write latency < ${WRITE_THRESHOLD_MS} ms`,
      startedAt,
      endedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      endpoint: url,
      method: CONSENT_WRITE_METHOD,
      runs: BASELINE_RUNS,
      successfulRuns: successes.length,
      failedRuns: failures.length,
      thresholdMs: WRITE_THRESHOLD_MS,
      cookieConsentValidation: consentCheck,
      averageWriteLatencyMs: stats.avgMs,
      latencyMs: stats,
      passed: successes.length > 0 && failures.length === 0 && stats.avgMs < WRITE_THRESHOLD_MS,
      details: rows,
    };

    const outPath = path.resolve(OUTPUT_PATH);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Summary written to ${outPath}`);

    if (!summary.passed) {
      process.exitCode = 1;
    }
  } finally {
    await apiContext.dispose();
  }
}

main().catch((error) => {
  console.error('Consent write baseline test failed:', error);
  process.exit(1);
});
