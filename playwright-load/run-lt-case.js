require('./load-env');
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');

const CASE_ID = (process.env.CASE_ID || 'LT-01').trim().toUpperCase();
const BASE_URL = (process.env.BASE_URL || '').trim();
const THINK_TIME_MS = toPositiveInt(process.env.THINK_TIME_MS, 1000);
const TIMEOUT_MS = toPositiveInt(process.env.TIMEOUT_MS, 30000);
const DURATION_SCALE = toPositiveFloat(process.env.DURATION_SCALE, 1);
const OUTPUT_PATH = (process.env.OUTPUT_PATH || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const USE_AUTH_STATE = (process.env.USE_AUTH_STATE || 'true').trim().toLowerCase() !== 'false';
const INCLUDE_ERROR_BODY = (process.env.INCLUDE_ERROR_BODY || 'true').trim().toLowerCase() !== 'false';
const PAGE_ONLY_MODE = (process.env.PAGE_ONLY_MODE || 'true').trim().toLowerCase() !== 'false';
const PAGE_PATH = (process.env.PAGE_PATH || '/').trim();

const ENDPOINTS = {
  read: process.env.READ_ENDPOINT || (PAGE_ONLY_MODE ? PAGE_PATH : '/api/health'),
  write: process.env.WRITE_ENDPOINT || (PAGE_ONLY_MODE ? PAGE_PATH : '/api/orders'),
  login: process.env.LOGIN_ENDPOINT || (PAGE_ONLY_MODE ? PAGE_PATH : '/api/login'),
  dependency: process.env.DEPENDENCY_ENDPOINT || (PAGE_ONLY_MODE ? PAGE_PATH : '/api/dependency'),
};

const DELAY_PARAM_NAME = (process.env.DELAY_PARAM_NAME || 'delayMs').trim();
const DELAY_PARAM_VALUE = toPositiveInt(process.env.DELAY_PARAM_VALUE, 500);

const PROFILES = {
  'LT-01': {
    mode: 'default',
    stages: [
      { duration: '10m', target: 200, phase: 'ramp' },
      { duration: '60m', target: 200, phase: 'steady' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95AllMsMax: 2000, errorRateMaxPct: 1 },
  },
  'LT-02': {
    mode: 'default',
    stages: [
      { duration: '10m', target: 500, phase: 'ramp' },
      { duration: '60m', target: 500, phase: 'steady' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95AllMsMax: 3000, errorRateMaxPct: 2 },
  },
  'LT-03': {
    mode: 'default',
    stages: [
      { duration: '1m', target: 100, phase: 'baseline' },
      { duration: '2m', target: 800, phase: 'spike' },
      { duration: '27m', target: 800, phase: 'hold' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95AllMsMax: 4000, errorRateMaxPct: 5 },
  },
  'LT-04': {
    mode: 'default',
    stages: [
      { duration: '5m', target: 500, phase: 'step_500' },
      { duration: '5m', target: 600, phase: 'step_600' },
      { duration: '5m', target: 700, phase: 'step_700' },
      { duration: '5m', target: 800, phase: 'step_800' },
      { duration: '5m', target: 900, phase: 'step_900' },
      { duration: '5m', target: 1000, phase: 'step_1000' },
      { duration: '5m', target: 1100, phase: 'step_1100' },
      { duration: '5m', target: 1200, phase: 'step_1200' },
      { duration: '5m', target: 1300, phase: 'step_1300' },
      { duration: '5m', target: 1400, phase: 'step_1400' },
      { duration: '5m', target: 1500, phase: 'step_1500' },
      { duration: '35m', target: 1500, phase: 'saturation' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { errorRateMaxPct: 8 },
  },
  'LT-05': {
    mode: 'default',
    stages: [
      { duration: '17m', target: 250, phase: 'ramp' },
      { duration: '12h', target: 250, phase: 'soak' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95AllMsMax: 2300, errorRateMaxPct: 1 },
  },
  'LT-06': {
    mode: 'mixed_rw',
    stages: [
      { duration: '10m', target: 300, phase: 'ramp' },
      { duration: '75m', target: 300, phase: 'mix' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { transactionSuccessRateMinPct: 99, p95ReadMsMax: 2000, p95WriteMsMax: 3000 },
  },
  'LT-07': {
    mode: 'login_burst',
    stages: [
      { duration: '5m', target: 1000, phase: 'burst' },
      { duration: '20m', target: 1000, phase: 'hold' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { loginSuccessRateMinPct: 98, p95LoginMsMax: 2500 },
  },
  'LT-08': {
    mode: 'dependency_delay',
    stages: [
      { duration: '10m', target: 250, phase: 'ramp' },
      { duration: '45m', target: 250, phase: 'steady' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95DependencyMsMax: 3500, errorRateMaxPct: 3 },
  },
  'LT-09': {
    mode: 'recovery',
    stages: [
      { duration: '5m', target: 800, phase: 'overload_ramp' },
      { duration: '10m', target: 800, phase: 'overload_hold' },
      { duration: '5m', target: 100, phase: 'recovery_drop' },
      { duration: '30m', target: 100, phase: 'recovery_observe' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95RecoveryMsMax: 2000, errorRateMaxPct: 2 },
  },
  'LT-10': {
    mode: 'default',
    stages: [
      { duration: '10m', target: 200, phase: 'ramp' },
      { duration: '15m', target: 400, phase: 'wave_1' },
      { duration: '15m', target: 250, phase: 'wave_2' },
      { duration: '15m', target: 450, phase: 'wave_3' },
      { duration: '15m', target: 300, phase: 'wave_4' },
      { duration: '15m', target: 400, phase: 'wave_5' },
      { duration: '5m', target: 0, phase: 'cooldown' },
    ],
    thresholds: { p95AllMsMax: 3000, errorRateMaxPct: 2 },
  },
};

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function toPositiveFloat(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseDurationToMs(input) {
  const trimmed = String(input || '').trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  return value * 60 * 60 * 1000;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asUrl(pathOrUrl) {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }
  const prefix = pathOrUrl.startsWith('/') ? '' : '/';
  return `${BASE_URL}${prefix}${pathOrUrl}`;
}

function baseOrigin() {
  try {
    return new URL(BASE_URL).origin;
  } catch (_) {
    return BASE_URL;
  }
}

function dependencyUrl() {
  const base = ENDPOINTS.dependency;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${DELAY_PARAM_NAME}=${DELAY_PARAM_VALUE}`;
}

function createAccumulator() {
  return {
    totalRequests: 0,
    failedRequests: 0,
    statusCounts: {},
    allDurations: [],
    readDurations: [],
    writeDurations: [],
    loginDurations: [],
    dependencyDurations: [],
    recoveryDurations: [],
    transactionSuccessCount: 0,
    loginSuccessCount: 0,
    loginRequestCount: 0,
    sampleErrors: [],
    stageSnapshots: [],
  };
}

async function requestWithTiming(apiContext, method, endpoint, body) {
  const started = Date.now();
  try {
    const response =
      method === 'POST'
        ? await apiContext.post(asUrl(endpoint), {
            timeout: TIMEOUT_MS,
            data: body || {},
          })
        : await apiContext.get(asUrl(endpoint), {
            timeout: TIMEOUT_MS,
          });
    let errorBody = '';
    if (!response.ok() && INCLUDE_ERROR_BODY) {
      try {
        const text = await response.text();
        errorBody = String(text || '').slice(0, 300);
      } catch (_) {
        errorBody = '';
      }
    }

    return {
      ok: response.ok(),
      status: response.status(),
      durationMs: Date.now() - started,
      endpoint: asUrl(endpoint),
      errorBody,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - started,
      error: String(error && error.message ? error.message : error),
      endpoint: asUrl(endpoint),
    };
  }
}

function recordResult(acc, bucket, result, stagePhase) {
  acc.totalRequests += 1;
  acc.statusCounts[String(result.status)] = (acc.statusCounts[String(result.status)] || 0) + 1;
  acc.allDurations.push(result.durationMs);
  if (!result.ok) {
    acc.failedRequests += 1;
    if (acc.sampleErrors.length < 10) {
      acc.sampleErrors.push({
        status: result.status,
        error: result.error || 'HTTP status >= 400',
        stagePhase,
        endpoint: result.endpoint,
        errorBody: result.errorBody || '',
      });
    }
  } else {
    acc.transactionSuccessCount += 1;
  }

  if (bucket === 'read') acc.readDurations.push(result.durationMs);
  if (bucket === 'write') acc.writeDurations.push(result.durationMs);
  if (bucket === 'login') {
    acc.loginDurations.push(result.durationMs);
    acc.loginRequestCount += 1;
    if (result.ok) {
      acc.loginSuccessCount += 1;
    }
  }
  if (bucket === 'dependency') acc.dependencyDurations.push(result.durationMs);
  if (bucket === 'recovery') acc.recoveryDurations.push(result.durationMs);
}

async function runWorker(apiContext, profileMode, endTime, acc, stagePhase, workerId) {
  const writeMethod = PAGE_ONLY_MODE ? 'GET' : 'POST';
  const loginMethod = PAGE_ONLY_MODE ? 'GET' : 'POST';
  let iter = 0;
  while (Date.now() < endTime) {
    if (profileMode === 'mixed_rw') {
      if (Math.random() < 0.7) {
        const readRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
        recordResult(acc, 'read', readRes, stagePhase);
      } else {
        const writeRes = await requestWithTiming(apiContext, writeMethod, ENDPOINTS.write, {
          orderId: `worker-${workerId}-iter-${iter}`,
          quantity: 1,
          timestamp: new Date().toISOString(),
        });
        recordResult(acc, 'write', writeRes, stagePhase);
      }
    } else if (profileMode === 'login_burst') {
      const loginRes = await requestWithTiming(apiContext, loginMethod, ENDPOINTS.login, {
        username: process.env.TEST_USERNAME || `user_${workerId}`,
        password: process.env.TEST_PASSWORD || 'password123',
      });
      recordResult(acc, 'login', loginRes, stagePhase);

      const readRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
      recordResult(acc, 'read', readRes, stagePhase);
    } else if (profileMode === 'dependency_delay') {
      const depRes = await requestWithTiming(apiContext, 'GET', dependencyUrl());
      recordResult(acc, 'dependency', depRes, stagePhase);

      const readRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
      recordResult(acc, 'read', readRes, stagePhase);
    } else if (profileMode === 'recovery') {
      const isRecovery = stagePhase.includes('recovery');
      if (isRecovery) {
        const recRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
        recordResult(acc, 'recovery', recRes, stagePhase);
      } else {
        const readRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
        recordResult(acc, 'read', readRes, stagePhase);
        if (iter % 3 === 0) {
          const writeRes = await requestWithTiming(apiContext, writeMethod, ENDPOINTS.write, {
            orderId: `worker-${workerId}-iter-${iter}`,
            quantity: 1,
            timestamp: new Date().toISOString(),
          });
          recordResult(acc, 'write', writeRes, stagePhase);
        }
      }
    } else {
      const readRes = await requestWithTiming(apiContext, 'GET', ENDPOINTS.read);
      recordResult(acc, 'read', readRes, stagePhase);
      if (iter % 5 === 0) {
        const writeRes = await requestWithTiming(apiContext, writeMethod, ENDPOINTS.write, {
          orderId: `worker-${workerId}-iter-${iter}`,
          quantity: 1,
          timestamp: new Date().toISOString(),
        });
        recordResult(acc, 'write', writeRes, stagePhase);
      }
    }

    iter += 1;
    if (THINK_TIME_MS > 0) {
      await sleepMs(THINK_TIME_MS);
    }
  }
}

async function runStage(apiContext, profileMode, stage, acc) {
  const scaledMs = Math.max(1000, Math.floor(parseDurationToMs(stage.duration) * DURATION_SCALE));
  console.log(
    `[${CASE_ID}] Stage start: phase=${stage.phase}, targetUsers=${stage.target}, planned=${stage.duration}, scaledMs=${scaledMs}`
  );
  if (stage.target <= 0) {
    await sleepMs(scaledMs);
    acc.stageSnapshots.push({
      phase: stage.phase,
      targetUsers: stage.target,
      stageDurationMs: scaledMs,
      requestsAtEnd: acc.totalRequests,
      errorRatePctAtEnd: acc.totalRequests ? Number(((acc.failedRequests / acc.totalRequests) * 100).toFixed(2)) : 0,
    });
    console.log(
      `[${CASE_ID}] Stage complete: phase=${stage.phase}, requests=${acc.totalRequests}, errorRatePct=${acc.totalRequests ? Number(((acc.failedRequests / acc.totalRequests) * 100).toFixed(2)) : 0}`
    );
    return;
  }

  const endTime = Date.now() + scaledMs;
  const workers = [];
  for (let i = 0; i < stage.target; i += 1) {
    workers.push(runWorker(apiContext, profileMode, endTime, acc, stage.phase, i + 1));
  }

  await Promise.all(workers);
  acc.stageSnapshots.push({
    phase: stage.phase,
    targetUsers: stage.target,
    stageDurationMs: scaledMs,
    requestsAtEnd: acc.totalRequests,
    errorRatePctAtEnd: acc.totalRequests ? Number(((acc.failedRequests / acc.totalRequests) * 100).toFixed(2)) : 0,
  });
  console.log(
    `[${CASE_ID}] Stage complete: phase=${stage.phase}, requests=${acc.totalRequests}, errorRatePct=${acc.totalRequests ? Number(((acc.failedRequests / acc.totalRequests) * 100).toFixed(2)) : 0}`
  );
}

function evaluateThresholds(caseId, thresholds, acc) {
  const checks = [];

  const errorRatePct = acc.totalRequests ? (acc.failedRequests / acc.totalRequests) * 100 : 100;
  const p95All = percentile(acc.allDurations, 95);
  const p95Read = percentile(acc.readDurations, 95);
  const p95Write = percentile(acc.writeDurations, 95);
  const p95Login = percentile(acc.loginDurations, 95);
  const p95Dependency = percentile(acc.dependencyDurations, 95);
  const p95Recovery = percentile(acc.recoveryDurations, 95);
  const transactionSuccessRatePct = acc.totalRequests
    ? (acc.transactionSuccessCount / acc.totalRequests) * 100
    : 0;
  const loginSuccessRatePct = acc.loginRequestCount
    ? (acc.loginSuccessCount / acc.loginRequestCount) * 100
    : 0;

  if (typeof thresholds.errorRateMaxPct === 'number') {
    checks.push({
      name: 'error_rate_max_pct',
      expected: `<= ${thresholds.errorRateMaxPct}`,
      actual: Number(errorRatePct.toFixed(2)),
      passed: errorRatePct <= thresholds.errorRateMaxPct,
    });
  }
  if (typeof thresholds.p95AllMsMax === 'number') {
    checks.push({
      name: 'p95_all_ms_max',
      expected: `<= ${thresholds.p95AllMsMax}`,
      actual: Number(p95All.toFixed(2)),
      passed: p95All <= thresholds.p95AllMsMax,
    });
  }
  if (typeof thresholds.transactionSuccessRateMinPct === 'number') {
    checks.push({
      name: 'transaction_success_rate_min_pct',
      expected: `>= ${thresholds.transactionSuccessRateMinPct}`,
      actual: Number(transactionSuccessRatePct.toFixed(2)),
      passed: transactionSuccessRatePct >= thresholds.transactionSuccessRateMinPct,
    });
  }
  if (typeof thresholds.p95ReadMsMax === 'number') {
    checks.push({
      name: 'p95_read_ms_max',
      expected: `<= ${thresholds.p95ReadMsMax}`,
      actual: Number(p95Read.toFixed(2)),
      passed: p95Read <= thresholds.p95ReadMsMax,
    });
  }
  if (typeof thresholds.p95WriteMsMax === 'number') {
    checks.push({
      name: 'p95_write_ms_max',
      expected: `<= ${thresholds.p95WriteMsMax}`,
      actual: Number(p95Write.toFixed(2)),
      passed: p95Write <= thresholds.p95WriteMsMax,
    });
  }
  if (typeof thresholds.loginSuccessRateMinPct === 'number') {
    checks.push({
      name: 'login_success_rate_min_pct',
      expected: `>= ${thresholds.loginSuccessRateMinPct}`,
      actual: Number(loginSuccessRatePct.toFixed(2)),
      passed: loginSuccessRatePct >= thresholds.loginSuccessRateMinPct,
    });
  }
  if (typeof thresholds.p95LoginMsMax === 'number') {
    checks.push({
      name: 'p95_login_ms_max',
      expected: `<= ${thresholds.p95LoginMsMax}`,
      actual: Number(p95Login.toFixed(2)),
      passed: p95Login <= thresholds.p95LoginMsMax,
    });
  }
  if (typeof thresholds.p95DependencyMsMax === 'number') {
    checks.push({
      name: 'p95_dependency_ms_max',
      expected: `<= ${thresholds.p95DependencyMsMax}`,
      actual: Number(p95Dependency.toFixed(2)),
      passed: p95Dependency <= thresholds.p95DependencyMsMax,
    });
  }
  if (typeof thresholds.p95RecoveryMsMax === 'number') {
    checks.push({
      name: 'p95_recovery_ms_max',
      expected: `<= ${thresholds.p95RecoveryMsMax}`,
      actual: Number(p95Recovery.toFixed(2)),
      passed: p95Recovery <= thresholds.p95RecoveryMsMax,
    });
  }

  return {
    caseId,
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function buildSummary(caseId, startedAtIso, endedAtIso, profile, acc, thresholdResult) {
  const totalDurationMs = new Date(endedAtIso).getTime() - new Date(startedAtIso).getTime();
  const errorRatePct = acc.totalRequests ? (acc.failedRequests / acc.totalRequests) * 100 : 100;
  const throughputRps = totalDurationMs > 0 ? acc.totalRequests / (totalDurationMs / 1000) : 0;

  return {
    caseId,
    mode: profile.mode,
    baseUrl: BASE_URL,
    durationScale: DURATION_SCALE,
    thinkTimeMs: THINK_TIME_MS,
    timeoutMs: TIMEOUT_MS,
    startedAt: startedAtIso,
    endedAt: endedAtIso,
    totalDurationMs,
    stages: profile.stages,
    stageSnapshots: acc.stageSnapshots,
    requests: acc.totalRequests,
    successCount: acc.totalRequests - acc.failedRequests,
    failureCount: acc.failedRequests,
    errorRatePct: Number(errorRatePct.toFixed(2)),
    throughputRps: Number(throughputRps.toFixed(2)),
    latency: {
      all: latencySummary(acc.allDurations),
      read: latencySummary(acc.readDurations),
      write: latencySummary(acc.writeDurations),
      login: latencySummary(acc.loginDurations),
      dependency: latencySummary(acc.dependencyDurations),
      recovery: latencySummary(acc.recoveryDurations),
    },
    rates: {
      transactionSuccessRatePct: acc.totalRequests
        ? Number(((acc.transactionSuccessCount / acc.totalRequests) * 100).toFixed(2))
        : 0,
      loginSuccessRatePct: acc.loginRequestCount
        ? Number(((acc.loginSuccessCount / acc.loginRequestCount) * 100).toFixed(2))
        : 0,
    },
    statusCounts: acc.statusCounts,
    sampleErrors: acc.sampleErrors,
    thresholds: thresholdResult,
  };
}

function latencySummary(values) {
  if (!values.length) {
    return {
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      avgMs: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
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

async function main() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required. Example: BASE_URL=https://test.example.com');
  }

  const profile = PROFILES[CASE_ID];
  if (!profile) {
    throw new Error(`Unsupported CASE_ID: ${CASE_ID}`);
  }

  console.log(
    `[${CASE_ID}] Starting Playwright LT run against ${BASE_URL} with mode=${profile.mode}, durationScale=${DURATION_SCALE}, thinkTimeMs=${THINK_TIME_MS}, timeoutMs=${TIMEOUT_MS}`
  );
  console.log(
    `[${CASE_ID}] Endpoint config: pageOnlyMode=${PAGE_ONLY_MODE}, read=${ENDPOINTS.read}, write=${ENDPOINTS.write}, login=${ENDPOINTS.login}, dependency=${ENDPOINTS.dependency}`
  );

  const startedAt = new Date().toISOString();
  const acc = createAccumulator();

  const resolvedAuthStatePath = path.resolve(AUTH_STATE_PATH);
  const contextOptions = {
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'User-Agent': `playwright-lt-suite-${CASE_ID}`,
      Accept: 'application/json, text/plain, */*',
      Referer: BASE_URL,
      Origin: baseOrigin(),
    },
  };

  if (USE_AUTH_STATE && fs.existsSync(resolvedAuthStatePath)) {
    contextOptions.storageState = resolvedAuthStatePath;
    console.log(`[${CASE_ID}] Using auth state: ${resolvedAuthStatePath}`);
  } else if (USE_AUTH_STATE) {
    console.log(
      `[${CASE_ID}] Auth state not found at ${resolvedAuthStatePath}. Requests may return 403 until auth bootstrap is completed.`
    );
  }

  const apiContext = await request.newContext(contextOptions);

  try {
    for (const stage of profile.stages) {
      await runStage(apiContext, profile.mode, stage, acc);
    }
  } finally {
    await apiContext.dispose();
  }

  const endedAt = new Date().toISOString();
  const thresholdResult = evaluateThresholds(CASE_ID, profile.thresholds, acc);
  const summary = buildSummary(CASE_ID, startedAt, endedAt, profile, acc, thresholdResult);

  console.log(JSON.stringify(summary, null, 2));

  const resolvedOutputPath = OUTPUT_PATH
    ? path.resolve(OUTPUT_PATH)
    : path.resolve(`summary-${CASE_ID}.json`);
  fs.writeFileSync(resolvedOutputPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Summary written to ${resolvedOutputPath}`);

  if (!thresholdResult.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Playwright LT case execution failed:', error);
  process.exit(1);
});
