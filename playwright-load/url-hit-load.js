require('./load-env');
const fs = require('fs');
const path = require('path');
const { request } = require('playwright');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function runBatch(url, concurrentUsers, timeoutMs) {
  const apiContext = await request.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'User-Agent': 'playwright-load-test',
    },
  });

  const startWall = Date.now();
  const tasks = [];

  for (let i = 0; i < concurrentUsers; i += 1) {
    tasks.push(
      (async () => {
        const start = Date.now();
        try {
          const res = await apiContext.get(url, {
            timeout: timeoutMs,
          });
          const duration = Date.now() - start;
          return {
            ok: res.ok(),
            status: res.status(),
            duration,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            ok: false,
            status: 0,
            duration,
            error: String(error && error.message ? error.message : error),
          };
        }
      })()
    );
  }

  const results = await Promise.all(tasks);
  const totalDurationMs = Date.now() - startWall;
  await apiContext.dispose();

  return {
    url,
    concurrentUsers,
    timeoutMs,
    totalDurationMs,
    results,
  };
}

function summarize(run) {
  const durations = run.results.map((r) => r.duration).sort((a, b) => a - b);
  const successCount = run.results.filter((r) => r.ok).length;
  const failureCount = run.results.length - successCount;
  const errorRate = run.results.length ? (failureCount / run.results.length) * 100 : 0;
  const rps = run.totalDurationMs > 0 ? run.results.length / (run.totalDurationMs / 1000) : 0;

  const byStatus = {};
  for (const row of run.results) {
    const key = String(row.status);
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  return {
    url: run.url,
    concurrentUsers: run.concurrentUsers,
    timeoutMs: run.timeoutMs,
    requests: run.results.length,
    successCount,
    failureCount,
    errorRate: Number(errorRate.toFixed(2)),
    totalDurationMs: run.totalDurationMs,
    throughputRps: Number(rps.toFixed(2)),
    latency: {
      minMs: durations[0] || 0,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations[durations.length - 1] || 0,
      avgMs: durations.length
        ? Number((durations.reduce((acc, v) => acc + v, 0) / durations.length).toFixed(2))
        : 0,
    },
    statusCounts: byStatus,
    sampleErrors: run.results
      .filter((r) => !r.ok && r.error)
      .slice(0, 10)
      .map((r) => ({ status: r.status, error: r.error })),
  };
}

async function main() {
  const url = process.env.BASE_URL;
  if (!url) {
    throw new Error('BASE_URL is required. Example: BASE_URL=https://test.example.com');
  }

  const concurrentUsers = parsePositiveInt(process.env.CONCURRENCY, 100);
  const timeoutMs = parsePositiveInt(process.env.TIMEOUT_MS, 30000);
  const outputPath = (process.env.OUTPUT_PATH || '').trim();

  console.log(`Starting Playwright URL-hit load test: ${concurrentUsers} concurrent requests to ${url}`);
  const run = await runBatch(url, concurrentUsers, timeoutMs);
  const summary = summarize(run);

  console.log(JSON.stringify(summary, null, 2));

  if (outputPath) {
    const fullOutputPath = path.resolve(outputPath);
    fs.writeFileSync(fullOutputPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`Summary written to ${fullOutputPath}`);
  }

  const failOnErrorRate = parseFloat(process.env.FAIL_ON_ERROR_RATE || '100');
  if (summary.errorRate > failOnErrorRate) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Load test failed to execute:', error);
  process.exit(1);
});
