require('./load-env');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = (process.env.BASE_URL || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const CONCURRENCY = toPositiveInt(process.env.CONCURRENCY, 30);
const ITERATIONS = toPositiveInt(process.env.ITERATIONS, 1);
const NAV_TIMEOUT_MS = toPositiveInt(process.env.NAV_TIMEOUT_MS, 90000);
const OUTPUT_PATH = (process.env.OUTPUT_PATH || './playwright-load/summary-airgap.json').trim();
const OUTPUT_FORMAT = (process.env.OUTPUT_FORMAT || 'json').trim().toLowerCase();
const BATCH_SIZE = toPositiveInt(process.env.BATCH_SIZE, CONCURRENCY);
const BATCH_DELAY_MS = toPositiveInt(process.env.BATCH_DELAY_MS, 0);
const HEADLESS = (process.env.HEADLESS || 'true').trim().toLowerCase() !== 'false';
const VISIBILITY_PASS_MIN_PCT = toPositiveInt(process.env.VISIBILITY_PASS_MIN_PCT, 95);
const PRESENCE_PASS_MIN_PCT = toPositiveInt(process.env.PRESENCE_PASS_MIN_PCT, 100);
const CONTENT_PASS_MIN_PCT = toPositiveInt(process.env.CONTENT_PASS_MIN_PCT, 100);
const VERIFY_PASS_MIN_PCT = toPositiveInt(process.env.VERIFY_PASS_MIN_PCT, 100);
const CONSENT_COOKIE_KEY = (process.env.CONSENT_COOKIE_KEY || 'tcm').trim();
const CONSENT_LOCALSTORAGE_KEY = (process.env.CONSENT_LOCALSTORAGE_KEY || 'tcmConsent').trim();
const CONSENT_CLICK_WAIT_MS = toPositiveInt(process.env.CONSENT_CLICK_WAIT_MS, 2000);
const MAX_ERROR_RATE_PCT = Number(process.env.MAX_ERROR_RATE_PCT || 5);
const CONTEXT_MODE = (process.env.CONTEXT_MODE || 'shared').trim().toLowerCase();
const PREFLIGHT_ENABLED = (process.env.PREFLIGHT_ENABLED || 'true').trim().toLowerCase() !== 'false';
const PREFLIGHT_STRICT = (process.env.PREFLIGHT_STRICT || 'false').trim().toLowerCase() === 'true';
const PREFLIGHT_RETRIES = toPositiveInt(process.env.PREFLIGHT_RETRIES, 3);
const PREFLIGHT_DELAY_MS = toPositiveInt(process.env.PREFLIGHT_DELAY_MS, 2000);

const COOKIE_ACTION = (process.env.COOKIE_ACTION || 'accept').trim().toLowerCase();
const AIRGAP_SCRIPT_MATCH = (process.env.AIRGAP_SCRIPT_MATCH || 'airgap.js').trim().toLowerCase();
const COOKIE_BANNER_SELECTOR =
  (process.env.COOKIE_BANNER_SELECTOR || '[id*=cookie], [class*=cookie], [aria-label*=cookie], [data-testid*=cookie]').trim();
const COOKIE_ACCEPT_SELECTOR =
  (process.env.COOKIE_ACCEPT_SELECTOR || 'button:has-text("Accept all"), button:has-text("Accept"), [id*=accept]').trim();
const COOKIE_REJECT_SELECTOR =
  (process.env.COOKIE_REJECT_SELECTOR || 'button:has-text("Reject all"), button:has-text("Reject"), [id*=reject]').trim();
const COOKIE_MORE_SELECTOR =
  (process.env.COOKIE_MORE_SELECTOR || 'button:has-text("More choices"), button:has-text("Manage"), [id*=preferences]').trim();
const COOKIE_EXPECTED_TEXT = (
  process.env.COOKIE_EXPECTED_TEXT ||
  'Cookie Consent Lilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.'
).trim();
const COOKIE_EXPECTED_TEXT_FALLBACK = (
  process.env.COOKIE_EXPECTED_TEXT_FALLBACK ||
  'Lilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.'
).trim();
const POST_LOGIN_URL_CONTAINS = (process.env.POST_LOGIN_URL_CONTAINS || '').trim();
const POST_LOGIN_SELECTOR = (process.env.POST_LOGIN_SELECTOR || '').trim();
const AUTH_RETURN_WAIT_MS = toPositiveInt(process.env.AUTH_RETURN_WAIT_MS, 20000);

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function latencySummary(values) {
  if (!values.length) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1],
    avgMs: Number((total / sorted.length).toFixed(2)),
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSummaryTable(summary) {
  const rows = [
    ['Scenario', summary.scenario],
    ['Base URL', summary.baseUrl],
    ['Cookie Action', summary.cookieAction],
    ['Users', summary.concurrency],
    ['Iterations/User', summary.iterationsPerUser],
    ['Requests', summary.totals.requests],
    ['Success', summary.totals.successCount],
    ['Failures', summary.totals.failureCount],
    ['Error Rate %', summary.totals.errorRatePct],
    ['Throughput RPS', summary.totals.throughputRps],
    ['Avg E2E ms', summary.latencyMs.endToEnd.avgMs],
    ['Cookie Success %', summary.cookieBanner.successRatePct],
    ['Passed', summary.passCriteria.passed ? 'Yes' : 'No'],
  ];

  const metricWidth = Math.max('Metric'.length, ...rows.map((r) => String(r[0]).length));
  const valueWidth = Math.max('Value'.length, ...rows.map((r) => String(r[1]).length));
  const border = `+-${'-'.repeat(metricWidth)}-+-${'-'.repeat(valueWidth)}-+`;

  const pad = (value, width) => {
    const text = String(value);
    if (text.length >= width) return text;
    return text + ' '.repeat(width - text.length);
  };

  console.log('\nAirgap Summary');
  console.log(border);
  console.log(`| ${pad('Metric', metricWidth)} | ${pad('Value', valueWidth)} |`);
  console.log(border);
  for (const [metric, value] of rows) {
    console.log(`| ${pad(metric, metricWidth)} | ${pad(value, valueWidth)} |`);
  }
  console.log(border);

  if (Array.isArray(summary.sampleFailures) && summary.sampleFailures.length > 0) {
    const failure = summary.sampleFailures[0];
    console.log('\nFirst Failure Snapshot');
    console.log(`status: ${failure.status || 'N/A'}`);
    console.log(`reason: ${failure.reason || 'N/A'}`);
  }
}

function printSummaryOutput(summary) {
  if (OUTPUT_FORMAT === 'table') {
    printSummaryTable(summary);
    return;
  }

  if (OUTPUT_FORMAT === 'both') {
    printSummaryTable(summary);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(JSON.stringify(summary, null, 2));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCompact(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, '');
}

function countOccurrences(haystack, needle) {
  const source = String(haystack || '');
  const target = String(needle || '');
  if (!target) return 0;

  let count = 0;
  let index = 0;
  while (true) {
    index = source.indexOf(target, index);
    if (index === -1) break;
    count += 1;
    index += target.length;
  }
  return count;
}

function preflightErrorMessage(result) {
  return `Preflight auth-check failed: authenticated=${result.authenticated}, status=${result.status}, finalUrl=${result.finalUrl}`;
}

function isMicrosoftLoginUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('login.microsoftonline.com') || value.includes('microsoft.com');
}

async function isAirgapScriptLoaded(page) {
  const match = AIRGAP_SCRIPT_MATCH;
  const loaded = await page.evaluate((matchValue) => {
    const lower = String(matchValue || '').toLowerCase();

    const fromScripts = Array.from(document.scripts || []).some((s) =>
      String((s && s.src) || '').toLowerCase().includes(lower)
    );
    if (fromScripts) return true;

    const resources = performance.getEntriesByType('resource') || [];
    return resources.some((r) => String((r && r.name) || '').toLowerCase().includes(lower));
  }, match);

  return loaded;
}

async function isCookieBannerPresent(page) {
  const banner = page.locator(COOKIE_BANNER_SELECTOR).first();
  const attached = await banner.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);
  if (!attached) return false;
  return banner.evaluate((el) => Boolean(el && el.isConnected)).catch(() => false);
}

async function checkCookieBannerContent(page) {
  const present = await isCookieBannerPresent(page);
  if (!present) {
    return {
      ok: false,
      details: {
        hasExpectedContent: false,
        acceptAllCount: 0,
        rejectAllCount: 0,
        hasMoreChoices: false,
        hasPrivacyStatement: false,
        hasSwitchLanguage: false,
        extractedTextSample: '',
        spanNodeCount: 0,
        bannerPresent: false,
      },
    };
  }

  const client = await page.context().newCDPSession(page);
  const selectorLower = COOKIE_BANNER_SELECTOR.toLowerCase();
  const selectorIdMatch = selectorLower.match(/#([a-z0-9_-]+)/);
  const selectorId = selectorIdMatch ? selectorIdMatch[1] : '';
  const scopeKeywords = ['consent', 'cookie', 'transcend', 'cm-', 'modal-container'];

  const extractScopedContent = async () => {
    const snapshot = await client.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: false,
      includePaintOrder: false,
    });

    const strings = snapshot.strings || [];
    const documents = snapshot.documents || [];

    const allTextParts = [];
    const spanTexts = [];

    for (const doc of documents) {
      const nodes = doc && doc.nodes ? doc.nodes : null;
      if (!nodes) continue;

      const nodeName = nodes.nodeName || [];
      const nodeValue = nodes.nodeValue || [];
      const parentIndex = nodes.parentIndex || [];
      const nodeAttributes = nodes.attributes || [];

      const attrMapCache = new Map();
      const getAttrMap = (index) => {
        if (attrMapCache.has(index)) return attrMapCache.get(index);
        const map = new Map();
        const raw = nodeAttributes[index] || [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const name = String(strings[raw[i]] || '').toLowerCase();
          const value = String(strings[raw[i + 1]] || '');
          map.set(name, value);
        }
        attrMapCache.set(index, map);
        return map;
      };

      const scopeCache = new Map();
      const isInConsentScope = (index) => {
        if (scopeCache.has(index)) return scopeCache.get(index);

        let current = index;
        while (current >= 0) {
          const attrs = getAttrMap(current);
          const idValue = String(attrs.get('id') || '').toLowerCase();
          const classValue = String(attrs.get('class') || '').toLowerCase();
          const dataTestId = String(attrs.get('data-testid') || '').toLowerCase();

          if (selectorId && idValue === selectorId) {
            scopeCache.set(index, true);
            return true;
          }

          const joined = `${idValue} ${classValue} ${dataTestId}`;
          if (scopeKeywords.some((k) => joined.includes(k))) {
            scopeCache.set(index, true);
            return true;
          }

          current = parentIndex[current];
        }

        scopeCache.set(index, false);
        return false;
      };

      const childrenByParent = new Map();
      for (let i = 0; i < parentIndex.length; i += 1) {
        const parent = parentIndex[i];
        if (parent < 0) continue;
        if (!childrenByParent.has(parent)) {
          childrenByParent.set(parent, []);
        }
        childrenByParent.get(parent).push(i);
      }

      for (let i = 0; i < nodeName.length; i += 1) {
        const name = strings[nodeName[i]] || '';
        if (name === '#text') {
          const parent = parentIndex[i];
          const parentName = parent >= 0 ? String(strings[nodeName[parent]] || '').toLowerCase() : '';
          if (parentName === 'script' || parentName === 'style' || parentName === 'noscript') {
            continue;
          }
          if (parent < 0 || !isInConsentScope(parent)) {
            continue;
          }
          const text = normalizeText(strings[nodeValue[i]] || '');
          if (text) allTextParts.push(text);
        }
      }

      const collectText = (index) => {
        const currentName = strings[nodeName[index]] || '';
        if (currentName === '#text') {
          return normalizeText(strings[nodeValue[index]] || '');
        }

        const children = childrenByParent.get(index) || [];
        const childText = [];
        for (const childIndex of children) {
          const part = collectText(childIndex);
          if (part) childText.push(part);
        }
        return normalizeText(childText.join(' '));
      };

      for (let i = 0; i < nodeName.length; i += 1) {
        const name = strings[nodeName[i]] || '';
        if (name.toLowerCase() !== 'span') continue;
        if (!isInConsentScope(i)) continue;
        const text = collectText(i);
        if (text) spanTexts.push(text);
      }
    }

    const pageText = normalizeText(allTextParts.join(' '));
    const pageTextLower = pageText.toLowerCase();
    const requiredContentCompact = normalizeCompact(COOKIE_EXPECTED_TEXT);
    const fallbackContentCompact = normalizeCompact(COOKIE_EXPECTED_TEXT_FALLBACK);
    const pageTextCompact = normalizeCompact(pageText);
    const acceptCount = countOccurrences(pageTextLower, 'accept all');
    const rejectCount = countOccurrences(pageTextLower, 'reject all');
    const hasMoreChoices = pageTextLower.includes('more choices');
    const hasPrivacyStatement = pageTextLower.includes('privacy statement');
    const hasSwitchLanguage = pageTextLower.includes('switch language');
    const hasExpectedContent =
      pageTextCompact.includes(requiredContentCompact) || pageTextCompact.includes(fallbackContentCompact);

    const ok =
      hasExpectedContent &&
      acceptCount >= 1 &&
      rejectCount >= 1 &&
      hasMoreChoices &&
      hasPrivacyStatement &&
      hasSwitchLanguage;

    return {
      ok,
      pageText,
      details: {
        hasExpectedContent,
        acceptAllCount: acceptCount,
        rejectAllCount: rejectCount,
        hasMoreChoices,
        hasPrivacyStatement,
        hasSwitchLanguage,
        extractedTextSample: pageText.slice(0, 500),
        spanNodeCount: spanTexts.length,
        bannerPresent: true,
      },
    };
  };

  let lastResult = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt === 1) {
      await sleepMs(1200);
    } else {
      await sleepMs(900);
    }

    const attemptResult = await extractScopedContent();
    lastResult = attemptResult;

    if (attemptResult.ok) {
      return { ok: true, details: attemptResult.details };
    }

    // If no scoped text was found yet, keep waiting for the consent dialog to render.
    if (!attemptResult.pageText) {
      continue;
    }
  }

  if (!lastResult) {
    return {
      ok: false,
      details: {
        hasExpectedContent: false,
        acceptAllCount: 0,
        rejectAllCount: 0,
        hasMoreChoices: false,
        hasPrivacyStatement: false,
        hasSwitchLanguage: false,
        extractedTextSample: '',
        spanNodeCount: 0,
        bannerPresent: true,
      },
    };
  }

  return { ok: false, details: lastResult.details };
}

// Clicks Accept/Reject inside closed shadow DOM then verifies tcm cookie and tcmConsent localStorage.
async function clickAndVerifyConsent(page, action) {
  // Clear existing consent state so Transcend always shows the banner fresh.
  await page.evaluate(({ cookieKey, storageKey }) => {
    document.cookie = `${cookieKey}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.lilly.com`;
    document.cookie = `${cookieKey}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    localStorage.removeItem(storageKey);
  }, { cookieKey: CONSENT_COOKIE_KEY, storageKey: CONSENT_LOCALSTORAGE_KEY });

  await page.reload({ waitUntil: 'domcontentloaded' });

  // Wait for consent host to attach after reload — Transcend loads asynchronously.
  const hostAttached = await page
    .waitForSelector('#transcend-consent-manager', { state: 'attached', timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  if (!hostAttached) {
    return { attempted: true, success: false, reason: 'host-not-found-after-reload', details: {} };
  }

  // Give shadow DOM time to render buttons after host attaches.
  await sleepMs(1500);

  const clicked = await page.evaluate((actionType) => {
    const host = document.querySelector('#transcend-consent-manager');
    if (!host || !host.shadowRoot) return { ok: false, reason: 'host-not-found' };
    const buttons = Array.from(host.shadowRoot.querySelectorAll('button'));

    if (actionType === 'more') {
      const moreBtn = buttons.find((b) => /more choices/i.test(b.textContent || ''));
      if (!moreBtn) return { ok: false, reason: 'more-choices-button-not-found', available: buttons.map((b) => (b.textContent || '').trim()).join(', ') };
      moreBtn.click();
      return { ok: true, reason: 'more-opened' };
    }

    const target = actionType === 'accept'
      ? buttons.find((b) => /accept all/i.test(b.textContent || ''))
      : buttons.find((b) => /reject all/i.test(b.textContent || ''));
    if (!target) {
      return { ok: false, reason: `button-not-found:${actionType}`, available: buttons.map((b) => (b.textContent || '').trim()).join(', ') };
    }
    target.click();
    return { ok: true, reason: 'clicked' };
  }, action);

  if (!clicked.ok) {
    return { attempted: true, success: false, reason: clicked.reason, details: { available: clicked.available || '' } };
  }

  // For more choices: wait for dialog then click the Save/Confirm button.
  if (action === 'more') {
    await sleepMs(2000);
    const confirmed = await page.evaluate(() => {
      const host = document.querySelector('#transcend-consent-manager');
      if (!host || !host.shadowRoot) return { ok: false, reason: 'host-not-found-for-dialog' };
      const allButtons = Array.from(host.shadowRoot.querySelectorAll('button'));
      const saveBtn = allButtons.find((b) => /save|confirm|done|submit/i.test(b.textContent || ''));
      if (!saveBtn) return { ok: false, reason: 'save-button-not-found', available: allButtons.map((b) => (b.textContent || '').trim()).join(', ') };
      saveBtn.click();
      return { ok: true };
    });
    if (!confirmed.ok) {
      return { attempted: true, success: false, reason: confirmed.reason, details: { available: confirmed.available || '' } };
    }
  }

  await sleepMs(CONSENT_CLICK_WAIT_MS);

  const verification = await page.evaluate(({ cookieKey, storageKey }) => {
    const cookies = document.cookie || '';
    const hasCookie = cookies.split(';').some((c) => c.trim().startsWith(cookieKey + '='));
    const match = cookies.split(';').find((c) => c.trim().startsWith(cookieKey + '='));
    const cookieValue = match ? decodeURIComponent(match.trim().slice(cookieKey.length + 1)).slice(0, 500) : null;
    const storageRaw = localStorage.getItem(storageKey);
    return { hasCookie, cookieValue, hasLocalStorage: Boolean(storageRaw), localStorageValue: storageRaw ? storageRaw.slice(0, 500) : null };
  }, { cookieKey: CONSENT_COOKIE_KEY, storageKey: CONSENT_LOCALSTORAGE_KEY });

  const ok = verification.hasCookie && verification.hasLocalStorage;
  return {
    attempted: true,
    success: ok,
    reason: ok ? `${action}-verified` : `${action}-verification-failed`,
    details: {
      action,
      hasCookie: verification.hasCookie,
      cookieKey: CONSENT_COOKIE_KEY,
      cookieValue: verification.cookieValue,
      hasLocalStorage: verification.hasLocalStorage,
      localStorageKey: CONSENT_LOCALSTORAGE_KEY,
      localStorageValue: verification.localStorageValue,
    },
  };
}

async function applyCookieAction(page) {
  try {
    if (COOKIE_ACTION === 'script_loaded') {
      const loaded = await isAirgapScriptLoaded(page);
      return {
        attempted: true,
        success: loaded,
        reason: loaded ? 'airgap-script-loaded' : `airgap-script-not-found:${AIRGAP_SCRIPT_MATCH}`,
      };
    }

    if (COOKIE_ACTION === 'present') {
      const present = await isCookieBannerPresent(page);
      return {
        attempted: true,
        success: present,
        reason: present ? 'banner-present-only' : 'banner-not-present',
      };
    }

    if (COOKIE_ACTION === 'content_check') {
      const contentResult = await checkCookieBannerContent(page);
      return {
        attempted: true,
        success: contentResult.ok,
        reason: contentResult.ok ? 'banner-content-matched' : 'banner-content-mismatch',
        details: contentResult.details,
      };
    }

    if (COOKIE_ACTION === 'accept_verify' || COOKIE_ACTION === 'reject_verify' || COOKIE_ACTION === 'more_verify') {
      const action = COOKIE_ACTION === 'accept_verify' ? 'accept' : COOKIE_ACTION === 'reject_verify' ? 'reject' : 'more';
      return await clickAndVerifyConsent(page, action);
    }

    const banner = page.locator(COOKIE_BANNER_SELECTOR).first();
    const hasBanner = await banner.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasBanner) {
      return { attempted: false, success: false, reason: 'banner-not-visible' };
    }

    if (COOKIE_ACTION === 'visible') {
      return { attempted: true, success: true, reason: 'banner-visible-only' };
    }

    let selector;
    if (COOKIE_ACTION === 'reject') {
      selector = COOKIE_REJECT_SELECTOR;
    } else if (COOKIE_ACTION === 'more') {
      selector = COOKIE_MORE_SELECTOR;
    } else {
      selector = COOKIE_ACCEPT_SELECTOR;
    }

    const actionButton = page.locator(selector).first();
    await actionButton.click({ timeout: 7000 });
    return { attempted: true, success: true, reason: 'clicked' };
  } catch (error) {
    return { attempted: true, success: false, reason: String(error && error.message ? error.message : error) };
  }
}

async function validateAuthenticated(page) {
  const url = page.url();
  if (isMicrosoftLoginUrl(url)) {
    return false;
  }

  if (POST_LOGIN_URL_CONTAINS && !url.includes(POST_LOGIN_URL_CONTAINS)) {
    return false;
  }

  if (POST_LOGIN_SELECTOR) {
    const ok = await page.locator(POST_LOGIN_SELECTOR).first().isVisible({ timeout: 5000 }).catch(() => false);
    return ok;
  }

  return true;
}

async function navigateAndWaitForAuthReturn(page) {
  const initialResponse = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  if (!isMicrosoftLoginUrl(page.url())) {
    return initialResponse;
  }

  // Some SSO flows briefly land on Microsoft domains before redirecting back.
  // Wait for return to app URL before declaring authentication failure.
  await page
    .waitForURL((url) => !isMicrosoftLoginUrl(url.toString()), {
      timeout: AUTH_RETURN_WAIT_MS,
    })
    .catch(() => {});

  return initialResponse;
}

async function runUser(browser, userIndex, sharedContext) {
  const results = [];
  const authDurations = [];
  const cookieDurations = [];
  const pageDurations = [];
  let cookieAttempted = 0;
  let cookieSuccess = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = Date.now();
    const context = sharedContext || (await browser.newContext({ storageState: AUTH_STATE_PATH }));
    const page = await context.newPage();

    try {
      const navStart = Date.now();
      const navResponse = await navigateAndWaitForAuthReturn(page);
      const navDuration = Date.now() - navStart;
      authDurations.push(navDuration);

      const navStatus = navResponse ? navResponse.status() : 0;
      if (navStatus >= 400) {
        results.push({
          ok: false,
          userIndex,
          iteration: i + 1,
          status: `http-${navStatus}`,
          finalUrl: page.url(),
          durationMs: Date.now() - start,
        });
        await page.close().catch(() => {});
        if (!sharedContext) {
          await context.close().catch(() => {});
        }
        continue;
      }

      const authOk = await validateAuthenticated(page);
      if (!authOk) {
        results.push({
          ok: false,
          userIndex,
          iteration: i + 1,
          status: 'not-authenticated',
          finalUrl: page.url(),
          durationMs: Date.now() - start,
        });
        await page.close().catch(() => {});
        if (!sharedContext) {
          await context.close().catch(() => {});
        }
        continue;
      }

      const cookieStart = Date.now();
      const cookieResult = await applyCookieAction(page);
      const cookieDuration = Date.now() - cookieStart;
      cookieDurations.push(cookieDuration);
      if (cookieResult.attempted) cookieAttempted += 1;
      if (cookieResult.success) cookieSuccess += 1;
      if (!cookieResult.success) {
        results.push({
          ok: false,
          userIndex,
          iteration: i + 1,
          status: 'cookie-check-failed',
          reason: cookieResult.reason,
          details: cookieResult.details,
          finalUrl: page.url(),
          durationMs: Date.now() - start,
        });
        continue;
      }

      if (
        COOKIE_ACTION !== 'visible' &&
        COOKIE_ACTION !== 'script_loaded' &&
        COOKIE_ACTION !== 'present' &&
        COOKIE_ACTION !== 'content_check' &&
        COOKIE_ACTION !== 'accept_verify' &&
        COOKIE_ACTION !== 'reject_verify' &&
        COOKIE_ACTION !== 'more_verify'
      ) {
        const finalStart = Date.now();
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        const finalDuration = Date.now() - finalStart;
        pageDurations.push(finalDuration);
      }

      results.push({
        ok: true,
        userIndex,
        iteration: i + 1,
        status: 'ok',
        durationMs: Date.now() - start,
      });
    } catch (error) {
      results.push({
        ok: false,
        userIndex,
        iteration: i + 1,
        status: 'error',
        durationMs: Date.now() - start,
        error: String(error && error.message ? error.message : error),
      });
    } finally {
      await page.close().catch(() => {});
      if (!sharedContext) {
        await context.close().catch(() => {});
      }
    }
  }

  return {
    results,
    authDurations,
    cookieDurations,
    pageDurations,
    cookieAttempted,
    cookieSuccess,
  };
}

async function runPreflightCheck(context) {
  const page = await context.newPage();
  try {
    const response = await navigateAndWaitForAuthReturn(page);
    const status = response ? response.status() : 0;
    const authenticated = await validateAuthenticated(page);

    return {
      ok: authenticated && (status === 0 || status < 400),
      status,
      authenticated,
      finalUrl: page.url(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required.');
  }

  const statePath = path.resolve(AUTH_STATE_PATH);
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `Auth state file not found at ${statePath}. Run auth-bootstrap-ms.js first to capture Microsoft login session.`
    );
  }

  console.log(
    `Starting airgap load: concurrency=${CONCURRENCY}, iterations=${ITERATIONS}, cookieAction=${COOKIE_ACTION}, baseUrl=${BASE_URL}`
  );
  console.log(
    `Execution config: contextMode=${CONTEXT_MODE}, preflightEnabled=${PREFLIGHT_ENABLED}, preflightStrict=${PREFLIGHT_STRICT}, preflightRetries=${PREFLIGHT_RETRIES}`
  );

  const browser = await chromium.launch({ headless: HEADLESS });
  const wallStart = Date.now();

  try {
    const useSharedContext = CONTEXT_MODE !== 'isolated';
    const sharedContext = useSharedContext
      ? await browser.newContext({ storageState: AUTH_STATE_PATH })
      : null;

    if (PREFLIGHT_ENABLED) {
      let preflight = null;
      for (let attempt = 1; attempt <= PREFLIGHT_RETRIES; attempt += 1) {
        const preflightContext = sharedContext || (await browser.newContext({ storageState: AUTH_STATE_PATH }));
        preflight = await runPreflightCheck(preflightContext);
        if (!sharedContext) {
          await preflightContext.close().catch(() => {});
        }

        if (preflight.ok) {
          console.log(`Preflight passed on attempt ${attempt}/${PREFLIGHT_RETRIES}`);
          break;
        }

        console.log(`${preflightErrorMessage(preflight)} (attempt ${attempt}/${PREFLIGHT_RETRIES})`);
        if (attempt < PREFLIGHT_RETRIES) {
          await sleepMs(PREFLIGHT_DELAY_MS);
        }
      }

      if (preflight && !preflight.ok) {
        const message = `${preflightErrorMessage(preflight)}. Re-capture auth state or adjust SSO/WAF allowlist.`;
        if (PREFLIGHT_STRICT) {
          throw new Error(message);
        }
        console.log(`WARNING: ${message} Continuing because PREFLIGHT_STRICT=false.`);
      }
    }

    const outputs = [];
    for (let startIndex = 0; startIndex < CONCURRENCY; startIndex += BATCH_SIZE) {
      const batchTasks = [];
      const batchEnd = Math.min(startIndex + BATCH_SIZE, CONCURRENCY);
      for (let i = startIndex; i < batchEnd; i += 1) {
        batchTasks.push(runUser(browser, i + 1, sharedContext));
      }
      const batchResults = await Promise.all(batchTasks);
      outputs.push(...batchResults);

      if (BATCH_DELAY_MS > 0 && batchEnd < CONCURRENCY) {
        await sleepMs(BATCH_DELAY_MS);
      }
    }

    if (sharedContext) {
      await sharedContext.close().catch(() => {});
    }

    const allResults = outputs.flatMap((o) => o.results);
    const allDurations = allResults.map((r) => r.durationMs);
    const authDurations = outputs.flatMap((o) => o.authDurations);
    const cookieDurations = outputs.flatMap((o) => o.cookieDurations);
    const pageDurations = outputs.flatMap((o) => o.pageDurations);

    const cookieAttempted = outputs.reduce((a, o) => a + o.cookieAttempted, 0);
    const cookieSuccess = outputs.reduce((a, o) => a + o.cookieSuccess, 0);

    const totalRequests = allResults.length;
    const failures = allResults.filter((r) => !r.ok);
    const successCount = totalRequests - failures.length;
    const errorRatePct = totalRequests ? (failures.length / totalRequests) * 100 : 100;
    const totalDurationMs = Date.now() - wallStart;

    const summary = {
      scenario: 'airgap-authenticated-cookie-banner',
      baseUrl: BASE_URL,
      concurrency: CONCURRENCY,
      iterationsPerUser: ITERATIONS,
      execution: {
        batchSize: BATCH_SIZE,
        batchDelayMs: BATCH_DELAY_MS,
        headless: HEADLESS,
        contextMode: CONTEXT_MODE,
      },
      authStatePath: statePath,
      cookieAction: COOKIE_ACTION,
      totals: {
        requests: totalRequests,
        successCount,
        failureCount: failures.length,
        errorRatePct: Number(errorRatePct.toFixed(2)),
        totalDurationMs,
        throughputRps: totalDurationMs > 0 ? Number((totalRequests / (totalDurationMs / 1000)).toFixed(2)) : 0,
      },
      latencyMs: {
        endToEnd: latencySummary(allDurations),
        initialNavigation: latencySummary(authDurations),
        cookieAction: latencySummary(cookieDurations),
        finalPageLoad: latencySummary(pageDurations),
      },
      cookieBanner: {
        attempted: cookieAttempted,
        success: cookieSuccess,
        successRatePct: cookieAttempted > 0 ? Number(((cookieSuccess / cookieAttempted) * 100).toFixed(2)) : 0,
      },
      sampleFailures: failures.slice(0, 10),
    };

    const checks = [];
    if (COOKIE_ACTION === 'visible') {
      checks.push({
        name: 'cookie_visibility_success_rate',
        expected: `>= ${VISIBILITY_PASS_MIN_PCT}`,
        actual: summary.cookieBanner.successRatePct,
        passed: summary.cookieBanner.successRatePct >= VISIBILITY_PASS_MIN_PCT,
      });
    }
    if (COOKIE_ACTION === 'present') {
      checks.push({
        name: 'cookie_presence_success_rate',
        expected: `>= ${PRESENCE_PASS_MIN_PCT}`,
        actual: summary.cookieBanner.successRatePct,
        passed: summary.cookieBanner.successRatePct >= PRESENCE_PASS_MIN_PCT,
      });
    }
    if (COOKIE_ACTION === 'content_check') {
      checks.push({
        name: 'cookie_content_success_rate',
        expected: `>= ${CONTENT_PASS_MIN_PCT}`,
        actual: summary.cookieBanner.successRatePct,
        passed: summary.cookieBanner.successRatePct >= CONTENT_PASS_MIN_PCT,
      });
    }
    if (COOKIE_ACTION === 'accept_verify' || COOKIE_ACTION === 'reject_verify' || COOKIE_ACTION === 'more_verify') {
      checks.push({
        name: 'consent_verify_success_rate',
        expected: `>= ${VERIFY_PASS_MIN_PCT}`,
        actual: summary.cookieBanner.successRatePct,
        passed: summary.cookieBanner.successRatePct >= VERIFY_PASS_MIN_PCT,
      });
    }
    checks.push({
      name: 'max_error_rate_pct',
      expected: `<= ${MAX_ERROR_RATE_PCT}`,
      actual: summary.totals.errorRatePct,
      passed: summary.totals.errorRatePct <= MAX_ERROR_RATE_PCT,
    });

    summary.passCriteria = {
      passed: checks.every((c) => c.passed),
      checks,
    };

    const resolvedOutput = path.resolve(OUTPUT_PATH);
    fs.writeFileSync(resolvedOutput, JSON.stringify(summary, null, 2), 'utf8');

    printSummaryOutput(summary);
    console.log(`Summary written to ${resolvedOutput}`);

    if (!summary.passCriteria.passed) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('airgap load test failed:', error);
  process.exit(1);
});
