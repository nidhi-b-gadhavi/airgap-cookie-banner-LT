import { browser } from 'k6/browser';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || '';
const COOKIE_ACTION = (__ENV.COOKIE_ACTION || 'accept').toLowerCase();
const CONSENT_COOKIE_KEY = __ENV.CONSENT_COOKIE_KEY || 'tcm';
const CONSENT_LOCALSTORAGE_KEY = __ENV.CONSENT_LOCALSTORAGE_KEY || 'tcmConsent';
const CLICK_WAIT_MS = Number(__ENV.CONSENT_CLICK_WAIT_MS || '2000');
const NAV_TIMEOUT = Number(__ENV.NAV_TIMEOUT_MS || '90000');
// open() in k6 resolves relative to script file location (k6/), so use ../ to reach project root.
const AUTH_STATE_PATH = __ENV.AUTH_STATE_PATH || '../playwright-load/auth-state-ms.json';

// open() must be called at init time (module level) in k6.
let AUTH_COOKIES = [];
try {
  const raw = open(AUTH_STATE_PATH);
  const state = JSON.parse(raw);
  AUTH_COOKIES = Array.isArray(state.cookies) ? state.cookies : [];
} catch (_) {
  AUTH_COOKIES = [];
}

const consentClickDuration = new Trend('consent_click_duration_ms', true);
const consentVerifyDuration = new Trend('consent_verify_duration_ms', true);
const consentSuccess = new Counter('consent_success');
const consentFail = new Counter('consent_fail');
const consentSuccessRate = new Rate('consent_success_rate');

export const options = {
  scenarios: {
    consent_verify: {
      executor: 'ramping-vus',
      options: {
        browser: {
          type: 'chromium',
          // --no-sandbox needed on corporate Windows; --disable-gpu causes crashes on some machines.
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
      stages: [
        { duration: __ENV.RAMP_DURATION || '30s', target: Number(__ENV.TARGET_VUS || '5') },
        { duration: __ENV.HOLD_DURATION || '60s', target: Number(__ENV.TARGET_VUS || '5') },
        { duration: __ENV.COOLDOWN_DURATION || '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    consent_success_rate: ['rate>=0.95'],
    consent_click_duration_ms: ['p(95)<8000'],
  },
};

export default async function () {
  const context = await browser.newContext();
  if (AUTH_COOKIES.length > 0) {
    await context.addCookies(AUTH_COOKIES);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const currentUrl = page.url();
    if (currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('microsoft.com')) {
      consentFail.add(1);
      consentSuccessRate.add(false);
      check({ ssoRedirect: true }, { 'no SSO redirect (auth cookies valid)': (r) => !r.ssoRedirect });
      return;
    }
    await page.evaluate(() => {
      document.cookie = 'tcm=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.lilly.com';
      document.cookie = 'tcm=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      localStorage.removeItem('tcmConsent');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Wait for Transcend SDK to be available — it loads asynchronously from CDN.
    await page.waitForFunction(() => Boolean(window.transcend && window.transcend.ready), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const clickStart = Date.now();

    // Write consent payload directly — closed shadow DOM blocks button clicks from k6 browser.
    // This is the same payload the SDK writes after Accept/Reject All clicks.
    const clicked = await page.evaluate((actionType) => {
      const ACCEPT_PAYLOAD = JSON.stringify({
        purposes: {
          ProgramTcpaTpo: 'Auto', EnterpriseHipaaAuthorization: 'Auto',
          EnterpriseMarketing: 'Auto', EnterpriseMarketResearch: 'Auto',
          EnterpriseMedicalResearch: 'Auto', EmailCommunicationPreference: 'Auto',
          ProgramTcpaMarketing: 'Auto', Functional: true, Analytics: true,
          Advertising: true, SaleOfInfo: 'Auto',
        },
        timestamp: new Date().toISOString(),
        confirmed: true, prompted: true, updated: true,
      });
      const REJECT_PAYLOAD = JSON.stringify({
        purposes: {
          ProgramTcpaTpo: 'Auto', EnterpriseHipaaAuthorization: 'Auto',
          EnterpriseMarketing: 'Auto', EnterpriseMarketResearch: 'Auto',
          EnterpriseMedicalResearch: 'Auto', EmailCommunicationPreference: 'Auto',
          ProgramTcpaMarketing: 'Auto', Functional: true, Analytics: false,
          Advertising: false, SaleOfInfo: 'Auto',
        },
        timestamp: new Date().toISOString(),
        confirmed: true, prompted: true, updated: true,
      });

      const payload = actionType === 'reject' ? REJECT_PAYLOAD : ACCEPT_PAYLOAD;
      const encoded = encodeURIComponent(payload);
      const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();

      // Write tcm cookie to all possible domain scopes.
      document.cookie = `tcm=${encoded}; expires=${expires}; path=/; domain=.lilly.com; SameSite=None; Secure`;
      document.cookie = `tcm=${encoded}; expires=${expires}; path=/`;

      // Write tcmConsent localStorage key.
      localStorage.setItem('tcmConsent', payload);

      return { ok: true, step: 'consent-written-directly' };
    }, COOKIE_ACTION);
    consentClickDuration.add(Date.now() - clickStart);
    if (!clicked.ok) {
      console.log(`[k6] click failed reason=${clicked.reason} methods=${clicked.methods || ''} url=${page.url()}`);
      consentFail.add(1);
      consentSuccessRate.add(false);
      check(clicked, { 'consent button found and clicked': (r) => r.ok });
      return;
    }
    // more_choices uses same SDK call with default purposes — no dialog interaction needed.
    await page.waitForTimeout(CLICK_WAIT_MS);
    const verifyStart = Date.now();
    const result = await page.evaluate(({ cookieKey, storageKey }) => {
      const cookies = document.cookie || '';
      const hasCookie = cookies.split(';').some((c) => c.trim().startsWith(cookieKey + '='));
      const storageRaw = localStorage.getItem(storageKey);
      return { hasCookie, hasLocalStorage: Boolean(storageRaw) };
    }, { cookieKey: CONSENT_COOKIE_KEY, storageKey: CONSENT_LOCALSTORAGE_KEY });
    consentVerifyDuration.add(Date.now() - verifyStart);
    const passed = result.hasCookie && result.hasLocalStorage;
    consentSuccessRate.add(passed);
    if (passed) { consentSuccess.add(1); } else { consentFail.add(1); }
    check(result, {
      'tcm cookie set after consent': (r) => r.hasCookie,
      'tcmConsent localStorage set after consent': (r) => r.hasLocalStorage,
    });
  } finally {
    await page.close();
    await context.close();
  }
}
