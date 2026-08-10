import { browser } from 'k6/browser';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = resolveBaseUrl();
const CONCURRENCY = toPositiveInt(__ENV.CONCURRENCY, 20);
const DURATION = String(__ENV.DURATION || '2m').trim();
const THINK_TIME_S = toPositiveFloat(__ENV.THINK_TIME_S, 0.2);
const NAV_TIMEOUT_MS = toPositiveInt(__ENV.NAV_TIMEOUT_MS, 60000);
const WAIT_SELECTOR = String(__ENV.WAIT_SELECTOR || '').trim();
const USE_AUTH_STATE = toBoolean(readConfigValue('USE_AUTH_STATE', 'true'));
const AUTH_STATE_PATH = String(readConfigValue('AUTH_STATE_PATH', './playwright-load/auth-state-ms.json')).trim();
const POST_LOGIN_URL_CONTAINS = String(readConfigValue('POST_LOGIN_URL_CONTAINS', '')).trim();
const AUTH_STORAGE_STATE = loadAuthStorageState();

const COOKIE_ACTION = String(__ENV.COOKIE_ACTION || 'script_loaded').trim().toLowerCase();
const AIRGAP_SCRIPT_MATCH = String(__ENV.AIRGAP_SCRIPT_MATCH || 'airgap.js').trim().toLowerCase();
const COOKIE_BANNER_SELECTOR = String(
  __ENV.COOKIE_BANNER_SELECTOR ||
    '[id*=cookie], [class*=cookie], [aria-label*=cookie], [data-testid*=cookie], #transcend-consent-manager'
).trim();
const COOKIE_ACCEPT_SELECTOR = String(
  __ENV.COOKIE_ACCEPT_SELECTOR || 'button:has-text("Accept all"), button:has-text("Accept"), [id*=accept]'
).trim();
const COOKIE_REJECT_SELECTOR = String(
  __ENV.COOKIE_REJECT_SELECTOR || 'button:has-text("Reject all"), button:has-text("Reject"), [id*=reject]'
).trim();
const COOKIE_MORE_SELECTOR = String(
  __ENV.COOKIE_MORE_SELECTOR || 'button:has-text("More choices"), button:has-text("Manage"), [id*=preferences]'
).trim();
const COOKIE_EXPECTED_TEXT = String(
  __ENV.COOKIE_EXPECTED_TEXT ||
    'Lilly and our partners use optional cookies for analytics, personalization, and marketing.'
).trim();

const navigationMs = new Trend('navigation_ms');
const flowMs = new Trend('flow_ms');
const cookieActionSuccess = new Rate('cookie_action_success');
const airgapScriptLoaded = new Rate('airgap_script_loaded');
const flowErrors = new Counter('flow_errors');
const authStateApplied = new Rate('auth_state_applied');

function resolveBaseUrl() {
  const fromEnv = String(readConfigValue('BASE_URL', '')).trim();
  if (fromEnv) {
    return fromEnv;
  }

  const fromDotEnv = readDotEnvValue('BASE_URL');
  if (fromDotEnv) {
    return fromDotEnv;
  }

  return '';
}

function readConfigValue(key, fallback) {
  const fromEnv = __ENV[key];
  if (typeof fromEnv !== 'undefined' && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }

  const fromDotEnv = readDotEnvValue(key);
  if (fromDotEnv) {
    return fromDotEnv;
  }

  return fallback;
}

function readDotEnvValue(key) {
  let content = '';
  try {
    content = open('../.env');
  } catch (_) {
    try {
      content = open('.env');
    } catch (_) {
      return '';
    }
  }

  const lines = String(content || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex < 1) {
      continue;
    }

    const foundKey = line.slice(0, eqIndex).trim();
    if (foundKey !== key) {
      continue;
    }

    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    return value;
  }

  return '';
}

export const options = {
  scenarios: {
    browser_flow: {
      executor: 'constant-vus',
      vus: CONCURRENCY,
      duration: DURATION,
      options: {
        browser: {
          type: 'chromium',
        },
      },
    },
  },
  thresholds: {
    checks: ['rate>0.95'],
    flow_errors: ['count<1'],
    auth_state_applied: USE_AUTH_STATE ? ['rate>0.90'] : [],
    airgap_script_loaded: ['rate>0.90'],
    cookie_action_success: ['rate>0.90'],
    navigation_ms: ['p(95)<10000'],
    flow_ms: ['p(95)<20000'],
  },
};

export default async function () {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required, for example: set BASE_URL=https://example.com');
  }

  let currentStage = 'creating browser context';
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    currentStage = 'applying saved authentication state';
    const authApplied = await applyAuthState(context);
    authStateApplied.add(authApplied ? 1 : 0);

    currentStage = `navigating to ${BASE_URL}`;
    const navStart = Date.now();
    await page.goto(BASE_URL, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
    navigationMs.add(Date.now() - navStart);

    currentStage = 'validating authenticated destination';
    ensureAuthenticatedUrl(page.url());

    if (WAIT_SELECTOR) {
      currentStage = `waiting for selector: ${WAIT_SELECTOR}`;
      await page.locator(WAIT_SELECTOR).first().waitFor({
        state: 'visible',
        timeout: NAV_TIMEOUT_MS,
      });
    }

    currentStage = `running cookie action: ${COOKIE_ACTION}`;
    const actionOk = await runCookieAction(page);
    cookieActionSuccess.add(actionOk ? 1 : 0);

    currentStage = `checking Airgap script match: ${AIRGAP_SCRIPT_MATCH}`;
    const scriptLoaded = await isAirgapLoaded(page, AIRGAP_SCRIPT_MATCH);
    airgapScriptLoaded.add(scriptLoaded ? 1 : 0);

    check(page, {
      'cookie action succeeded': () => actionOk,
      'airgap script loaded': () => scriptLoaded,
    });
  } catch (error) {
    flowErrors.add(1);
    check(page, {
      'browser flow completed': () => false,
    });
    console.error(buildFlowErrorMessage(error, currentStage, page));
  } finally {
    flowMs.add(Date.now() - startedAt);
    await page.close();
    await context.close();
    sleep(THINK_TIME_S);
  }
}

async function runCookieAction(page) {
  if (COOKIE_ACTION === 'script_loaded') {
    return true;
  }

  if (COOKIE_ACTION === 'visible') {
    return await isBannerVisible(page);
  }

  if (COOKIE_ACTION === 'content_check') {
    const text = await readBannerText(page);
    return normalizeText(text).includes(normalizeText(COOKIE_EXPECTED_TEXT));
  }

  const selector =
    COOKIE_ACTION === 'accept'
      ? COOKIE_ACCEPT_SELECTOR
      : COOKIE_ACTION === 'reject'
      ? COOKIE_REJECT_SELECTOR
      : COOKIE_ACTION === 'more'
      ? COOKIE_MORE_SELECTOR
      : '';

  if (!selector) {
    return false;
  }

  const target = await firstVisibleLocator(page, selector);
  if (!target) {
    return false;
  }

  await target.click({ timeout: 10000 });
  return true;
}

async function isBannerVisible(page) {
  const banner = await firstVisibleLocator(page, COOKIE_BANNER_SELECTOR);
  return Boolean(banner);
}

async function readBannerText(page) {
  const selectors = splitSelectors(COOKIE_BANNER_SELECTOR);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const text = await locator.textContent().catch(() => '');
    if (text) {
      return String(text);
    }
  }
  return '';
}

async function firstVisibleLocator(page, selectorCsv) {
  const selectors = splitSelectors(selectorCsv);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return locator;
    }
  }
  return null;
}

async function isAirgapLoaded(page, scriptName) {
  return await page.evaluate((matchValue) => {
    const match = String(matchValue || '').toLowerCase();

    const scriptFound = Array.from(document.scripts || []).some((script) =>
      String((script && script.src) || '').toLowerCase().includes(match)
    );

    if (scriptFound) {
      return true;
    }

    const entries = performance.getEntriesByType('resource') || [];
    return entries.some((entry) => String((entry && entry.name) || '').toLowerCase().includes(match));
  }, scriptName);
}

function splitSelectors(selectorCsv) {
  return String(selectorCsv || '')
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean);
}

async function applyAuthState(context) {
  if (!USE_AUTH_STATE) {
    return true;
  }

  const cookies = normalizeStorageStateCookies(AUTH_STORAGE_STATE);
  if (!cookies.length) {
    throw new Error(
      `Authentication state file did not contain usable cookies: ${AUTH_STATE_PATH}. Run auth bootstrap again.`
    );
  }

  await context.addCookies(cookies);
  return true;
}

function loadAuthStorageState() {
  if (!USE_AUTH_STATE) {
    return null;
  }

  return readStorageState(AUTH_STATE_PATH);
}

function readStorageState(filePath) {
  const candidates = buildAuthStatePathCandidates(filePath);
  let content = '';
  let resolvedPath = '';
  for (const candidate of candidates) {
    try {
      content = open(candidate);
      resolvedPath = candidate;
      break;
    } catch (_) {
      // Try the next candidate path.
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `Authentication state file not found. Tried: ${candidates.join(', ')}. Run npm run auth:bootstrap before running k6.`
    );
  }

  try {
    return JSON.parse(String(content || '{}'));
  } catch (_) {
    throw new Error(`Authentication state file is not valid JSON: ${resolvedPath}`);
  }
}

function buildAuthStatePathCandidates(filePath) {
  const rawPath = String(filePath || '').trim().replace(/\\/g, '/');
  const candidates = [];

  addCandidate(candidates, rawPath);
  addCandidate(candidates, rawPath.replace(/^\.\//, ''));
  addCandidate(candidates, `../${rawPath.replace(/^\.\//, '')}`);
  addCandidate(candidates, rawPath.replace(/^\.?\/?playwright-load\//, ''));

  return candidates.filter(Boolean);
}

function addCandidate(candidates, value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidates.includes(candidate)) {
    return;
  }
  candidates.push(candidate);
}

function normalizeStorageStateCookies(storageState) {
  const rawCookies = Array.isArray(storageState && storageState.cookies) ? storageState.cookies : [];
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  return rawCookies
    .filter((cookie) => cookie && cookie.name && cookie.value && cookie.domain && cookie.path)
    .filter((cookie) => !isExpiredCookie(cookie, nowEpochSeconds))
    .map((cookie) => ({
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain),
      path: String(cookie.path || '/'),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: normalizeSameSite(cookie.sameSite),
      expires: normalizeCookieExpiry(cookie.expires),
    }));
}

function isExpiredCookie(cookie, nowEpochSeconds) {
  const expires = Number(cookie && cookie.expires);
  return Number.isFinite(expires) && expires > 0 && expires <= nowEpochSeconds;
}

function normalizeCookieExpiry(value) {
  const expires = Number(value);
  if (!Number.isFinite(expires) || expires <= 0) {
    return undefined;
  }
  return Math.floor(expires);
}

function normalizeSameSite(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'strict') {
    return 'Strict';
  }
  if (normalized === 'lax') {
    return 'Lax';
  }
  return 'None';
}

function ensureAuthenticatedUrl(currentUrl) {
  const url = String(currentUrl || '').trim();
  if (!url) {
    return;
  }

  const normalizedUrl = url.toLowerCase();
  const requiresLogin =
    normalizedUrl.includes('login.microsoftonline.com') ||
    normalizedUrl.includes('microsoftonline.com') ||
    normalizedUrl.includes('login.live.com');

  if (requiresLogin) {
    throw new Error(buildAuthRequiredMessage(url));
  }

  if (POST_LOGIN_URL_CONTAINS && !url.includes(POST_LOGIN_URL_CONTAINS)) {
    throw new Error(
      `Expected authenticated app URL containing "${POST_LOGIN_URL_CONTAINS}", but landed on: ${url}. Microsoft authentication may be required again.`
    );
  }
}

function buildAuthRequiredMessage(currentUrl) {
  return [
    `Microsoft authentication is required again. Current URL: ${currentUrl}`,
    'Refresh the saved login session with: npm run auth:bootstrap',
    `Then rerun k6 with AUTH_STATE_PATH=${AUTH_STATE_PATH}`,
  ].join(' ');
}

function buildFlowErrorMessage(error, stage, page) {
  const message = String(error && error.message ? error.message : error || 'Unknown error');
  const currentUrl = safelyReadPageUrl(page);
  const hints = buildErrorHints(message, currentUrl);

  return [
    'Flow error details:',
    `- stage: ${stage}`,
    `- baseUrl: ${BASE_URL}`,
    `- currentUrl: ${currentUrl || '(unavailable)'}`,
    `- useAuthState: ${USE_AUTH_STATE}`,
    `- authStatePath: ${AUTH_STATE_PATH}`,
    `- postLoginUrlContains: ${POST_LOGIN_URL_CONTAINS || '(not set)'}`,
    `- waitSelector: ${WAIT_SELECTOR || '(not set)'}`,
    `- cookieAction: ${COOKIE_ACTION}`,
    `- airgapScriptMatch: ${AIRGAP_SCRIPT_MATCH}`,
    `- message: ${message}`,
    hints ? `- nextStep: ${hints}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function safelyReadPageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? String(page.url() || '').trim() : '';
  } catch (_) {
    return '';
  }
}

function buildErrorHints(message, currentUrl) {
  const normalizedMessage = String(message || '').toLowerCase();
  const normalizedUrl = String(currentUrl || '').toLowerCase();

  if (
    normalizedMessage.includes('authentication is required again') ||
    normalizedUrl.includes('login.microsoftonline.com') ||
    normalizedUrl.includes('login.live.com')
  ) {
    return 'Run "npm run auth:bootstrap" to refresh the Microsoft session, then rerun the k6 command.';
  }

  if (normalizedMessage.includes('authentication state file not found')) {
    return `Check AUTH_STATE_PATH and regenerate the file with "npm run auth:bootstrap".`;
  }

  if (normalizedMessage.includes('did not contain usable cookies')) {
    return 'The saved auth file exists but the cookies are expired or empty. Refresh it with "npm run auth:bootstrap".';
  }

  if (normalizedMessage.includes('waiting for selector') || normalizedMessage.includes('timeout')) {
    return 'Verify WAIT_SELECTOR, increase NAV_TIMEOUT_MS if needed, and confirm the page is not stalled on login or consent.';
  }

  if (normalizedMessage.includes('expected authenticated app url')) {
    return 'Check POST_LOGIN_URL_CONTAINS and confirm the app redirects to the expected post-login URL.';
  }

  return 'Review the stage and currentUrl above; they identify whether the failure happened during auth, navigation, selector wait, or page validation.';
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toPositiveFloat(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function toBoolean(value) {
  return String(value || '')
    .trim()
    .toLowerCase() !== 'false';
}
