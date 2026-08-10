# Playwright and k6 Commands with Summary

This document is a single quick reference for running Playwright and k6 load tests in this workspace.

## Prerequisites

- Node.js 18+
- Dependencies installed: `npm install`
- k6 installed and available on PATH: `k6 version`
- BASE_URL set in `.env` or environment variables

---

## Playwright Commands

Run from project root.

### 1) Bootstrap authentication session

```cmd
npm run auth:bootstrap
```

Summary:
- Generates or refreshes `playwright-load/auth-state-ms.json`.
- Use this first when Microsoft login is required.

### 2) Capture consent event payload

```cmd
npm run consent:capture
```

Summary:
- Captures consent interaction details.
- Output file: `playwright-load/results/consent-event-capture.json`.

### 3) Baseline script-loaded validation (1 user)

```cmd
npm run airgap:script-loaded:1
```

Summary:
- Verifies basic page flow and Airgap script presence with 1 concurrent user.

### 4) 20-user Playwright load run

```cmd
npm run airgap:20
```

Summary:
- Runs 20 concurrent users in headless mode.
- Good first concurrency step after 1-user validation.

### 5) Stable 20-user variant (batched)

```cmd
npm run airgap:20:stable
```

Summary:
- Uses batching (`BATCH_SIZE=2`, `BATCH_DELAY_MS=1200`) to reduce instability.

### 6) Optional high-load Playwright runs

```cmd
npm run airgap:100
npm run airgap:500
```

Summary:
- Stress-style concurrency runs.
- Use only after low and medium load runs are stable.

### 7) Render combined table report

```cmd
npm run report:table
```

Summary:
- Prints terminal table output.
- Writes report markdown to results folder.

---

## k6 Commands

Run from project root.

### 1) Default k6 browser run (repo defaults)

```cmd
npm run k6:airgap
```

Summary:
- Runs `playwright-load/k6-airgap-browser.mjs` with current defaults.

### 2) 20-user k6 browser run

```cmd
npm run k6:airgap:20
```

Summary:
- Sets `CONCURRENCY=20`, `DURATION=2m`, `COOKIE_ACTION=script_loaded`.

### 3) Direct minimal validation run (PowerShell)

```powershell
$env:CONCURRENCY="1"
$env:DURATION="30s"
$env:COOKIE_ACTION="script_loaded"
$env:K6_BROWSER_HEADLESS="true"
k6 run .\playwright-load\k6-airgap-browser.mjs
```

Summary:
- Fast sanity check before larger runs.

### 4) Consent verification scenarios (k6 script)

```cmd
npm run k6:consent:accept:20
npm run k6:consent:accept:50
npm run k6:consent:accept:100
npm run k6:consent:reject:20
npm run k6:consent:more:20
npm run k6:consent:more:50
```

Summary:
- Executes consent action specific tests using `k6/consent-verify.js`.
- Useful for behavior coverage under increasing load.

### 5) URL load scenarios (k6 script)

```cmd
npm run k6:url:100
npm run k6:url:200
```

Summary:
- Executes URL-focused load checks using `k6/url-load.js`.

---

## Result Summary Checklist

Use this checklist after each run:

- Functional pass:
  - Cookie banner action/check succeeded.
  - Airgap script detected where expected.
- Stability pass:
  - No unexpected flow errors.
  - Authentication state applied consistently (if enabled).
- Performance pass:
  - p95 navigation and flow timing within your target.
  - No major latency spikes as concurrency increases.
- Reporting artifacts:
  - JSON outputs present in `playwright-load/results/`.
  - Table report generated when using `npm run report:table`.

---

## Recommended Execution Order

1. `npm install`
2. `npm run auth:bootstrap`
3. `npm run airgap:script-loaded:1`
4. `npm run airgap:20`
5. `npm run k6:airgap`
6. `npm run k6:airgap:20`
7. `npm run report:table`

This progression helps separate setup issues from true load/performance issues.
