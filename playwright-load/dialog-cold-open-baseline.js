require('./load-env');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = (process.env.BASE_URL || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const USE_AUTH_STATE = (process.env.USE_AUTH_STATE || 'true').trim().toLowerCase() !== 'false';
const NAV_TIMEOUT_MS = toPositiveInt(process.env.NAV_TIMEOUT_MS, 90000);
const HEADLESS = (process.env.HEADLESS || 'true').trim().toLowerCase() !== 'false';
const RUNS = toPositiveInt(process.env.BASELINE_RUNS, 5);
const PASS_THRESHOLD_MS = toPositiveInt(process.env.BASELINE_DIALOG_THRESHOLD_MS, 400);
const OUTPUT_PATH = (process.env.OUTPUT_PATH || './playwright-load/results/summary-dialog-baseline.json').trim();
const POST_LOGIN_URL_CONTAINS = (process.env.POST_LOGIN_URL_CONTAINS || '').trim();

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isMicrosoftLoginUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('login.microsoftonline.com') || value.includes('microsoft.com');
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

async function runSingleMeasurement(browser, contextOptions, index) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    const navStart = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const navMs = Date.now() - navStart;

    const currentUrl = page.url();
    if (isMicrosoftLoginUrl(currentUrl)) {
      return {
        ok: false,
        run: index,
        reason: 'redirected-to-microsoft-login',
        finalUrl: currentUrl,
        navMs,
      };
    }

    if (POST_LOGIN_URL_CONTAINS && !currentUrl.includes(POST_LOGIN_URL_CONTAINS)) {
      return {
        ok: false,
        run: index,
        reason: 'post-login-url-mismatch',
        finalUrl: currentUrl,
        navMs,
      };
    }

    return {
      ok: true,
      run: index,
      navMs,
      coldOpenMs: navMs,
      finalUrl: currentUrl,
    };
  } catch (error) {
    return {
      ok: false,
      run: index,
      reason: String(error && error.message ? error.message : error),
      finalUrl: page.url(),
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function main() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is required.');
  }

  const contextOptions = {
    ignoreHTTPSErrors: true,
  };

  if (USE_AUTH_STATE) {
    const statePath = path.resolve(AUTH_STATE_PATH);
    if (fs.existsSync(statePath)) {
      contextOptions.storageState = statePath;
    } else {
      throw new Error(`Auth state file not found at ${statePath}. Run auth-bootstrap-ms.js first.`);
    }
  }

  console.log(
    `Starting baseline case: runs=${RUNS}, thresholdMs=${PASS_THRESHOLD_MS}`
  );

  const browser = await chromium.launch({ headless: HEADLESS });
  const startedAt = new Date().toISOString();

  try {
    const results = [];
    for (let i = 1; i <= RUNS; i += 1) {
      const row = await runSingleMeasurement(browser, contextOptions, i);
      results.push(row);
      if (row.ok) {
        console.log(`Run ${i}/${RUNS}: coldOpenMs=${row.coldOpenMs}`);
      } else {
        console.log(`Run ${i}/${RUNS}: failed=${row.reason}`);
      }
    }

    const okRows = results.filter((r) => r.ok);
    const failedRows = results.filter((r) => !r.ok);
    const coldOpenMsValues = okRows.map((r) => r.coldOpenMs);
    const stats = latencySummary(coldOpenMsValues);

    const summary = {
      testCaseId: 'LT-BL-01',
      scenario: 'Single User Dialog Cold Open Baseline',
      objective: 'Record unloaded cold dialog open time baseline for concurrent test comparison',
      expectedResult: `Average launch time is under ${PASS_THRESHOLD_MS} ms`,
      startedAt,
      endedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      runs: RUNS,
      successfulRuns: okRows.length,
      failedRuns: failedRows.length,
      thresholdMs: PASS_THRESHOLD_MS,
      averageLaunchMs: stats.avgMs,
      latencyMs: stats,
      passed: okRows.length > 0 && stats.avgMs < PASS_THRESHOLD_MS,
      details: results,
      failures: failedRows,
    };

    const output = path.resolve(OUTPUT_PATH);
    const outputDir = path.dirname(output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(output, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Summary written to ${output}`);

    if (!summary.passed) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Baseline dialog cold-open test failed:', error);
  process.exit(1);
});
