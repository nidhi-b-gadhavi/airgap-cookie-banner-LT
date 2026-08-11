import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || '';
const TIMEOUT_MS = Number(__ENV.TIMEOUT_MS || '30000');
const THINK_TIME_S = Number(__ENV.THINK_TIME_S || '1');
const AUTH_STATE_PATH = __ENV.AUTH_STATE_PATH || '../playwright-load/auth-state-ms.json';

// read auth cookies once in init context; filter to cookies whose domain matches BASE_URL
const _authCookieHeader = (function () {
  try {
    const raw = open(AUTH_STATE_PATH);
    const state = JSON.parse(raw);
    const cookies = (state.cookies || []).filter((c) => {
      const domain = (c.domain || '').replace(/^\./, '');
      return BASE_URL.includes(domain);
    });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    return '';
  }
})();

const pageLoadDuration = new Trend('page_load_duration_ms', true);
const successCount = new Counter('success_count');
const failCount = new Counter('fail_count');
const successRate = new Rate('success_rate');

export const options = {
  scenarios: {
    url_load: {
      executor: 'ramping-vus',
      stages: [
        { duration: __ENV.RAMP_DURATION || '30s', target: Number(__ENV.TARGET_VUS || '100') },
        { duration: __ENV.HOLD_DURATION || '60s', target: Number(__ENV.TARGET_VUS || '100') },
        { duration: __ENV.COOLDOWN_DURATION || '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    success_rate: [`rate>=${Number(__ENV.PASS_RATE || '0.95')}`],
    page_load_duration_ms: [`p(95)<${Number(__ENV.P95_MS || '3000')}`],
    http_req_failed: [`rate<${Number(__ENV.MAX_ERROR_RATE || '0.05')}`],
  },
};

// log first failure per VU to expose actual status code / error without flooding output
let _firstFailLogged = false;

export default function () {
  const start = Date.now();
  const headers = { 'User-Agent': 'k6-load-test' };
  if (_authCookieHeader) headers['Cookie'] = _authCookieHeader;

  const res = http.get(BASE_URL, {
    timeout: `${TIMEOUT_MS}ms`,
    redirects: 10,
    headers,
  });

  const duration = Date.now() - start;
  pageLoadDuration.add(duration);

  const ok = res.status >= 200 && res.status < 400;
  successRate.add(ok);

  if (ok) {
    successCount.add(1);
  } else {
    failCount.add(1);
    if (!_firstFailLogged) {
      _firstFailLogged = true;
      console.error(`[VU${__VU}] FAIL status=${res.status} error="${res.error}" url=${BASE_URL}`);
    }
  }

  check(res, {
    'status is 2xx or 3xx': (r) => r.status >= 200 && r.status < 400,
    'response time < p95 threshold': () => duration < Number(__ENV.P95_MS || '3000'),
  });

  sleep(THINK_TIME_S);
}
