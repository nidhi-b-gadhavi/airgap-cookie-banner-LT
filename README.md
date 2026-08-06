# Playwright Test Execution Guide

This directory contains Playwright-based load and consent test runners.

## Prerequisites

1. Node.js 18+
2. Dependencies installed:

```cmd
npm install
```

3. Update `.env` if needed (especially `BASE_URL`).

## Run Order (CMD)

Run these commands from the project root:

### 1) Bootstrap auth session

```cmd
npm run auth:bootstrap
```

### 2) Capture consent interaction and payload

```cmd
set HEADLESS=false&& set OUTPUT_PATH=.\playwright-load\results\consent-event-capture.json&& npm run consent:capture
```

Action while browser is open:
- Click More choices
- Click checkbox(es)
- Save/apply
- Press Enter in terminal

### 3) Run 1-user content-check smoke test (table output)

```cmd
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=content_check&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set COOKIE_EXPECTED_TEXT=Cookie ConsentLilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set COOKIE_EXPECTED_TEXT_FALLBACK=Lilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set CONTENT_PASS_MIN_PCT=100&& set CONCURRENCY=1&& set ITERATIONS=1&& set HEADLESS=false&& set CONTEXT_MODE=isolated&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set OUTPUT_PATH=.\playwright-load\results\summary-airgap-1user.json&& node .\playwright-load\airgap.js
```

### 4) Run 20-user content-check (table output)

```cmd
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=content_check&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set COOKIE_EXPECTED_TEXT=Cookie ConsentLilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set COOKIE_EXPECTED_TEXT_FALLBACK=Lilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set CONTENT_PASS_MIN_PCT=100&& set CONCURRENCY=20&& set ITERATIONS=1&& set HEADLESS=false&& set CONTEXT_MODE=isolated&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set OUTPUT_PATH=.\playwright-load\results\summary-airgap-20user.json&& node .\playwright-load\airgap.js
```

### 5) Optional: Run 25-user content-check (table output)

```cmd
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=content_check&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set COOKIE_EXPECTED_TEXT=Cookie ConsentLilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set COOKIE_EXPECTED_TEXT_FALLBACK=Lilly and our partners use optional cookies for analytics, personalization, and marketing. Some cookies may process health information. Accept or Reject optional cookies.&& set CONTENT_PASS_MIN_PCT=100&& set CONCURRENCY=25&& set ITERATIONS=1&& set HEADLESS=false&& set CONTEXT_MODE=isolated&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set OUTPUT_PATH=.\playwright-load\results\summary-airgap-25user.json&& node .\playwright-load\airgap.js
```

### 6) Optional: Run 100 concurrent URL hits

```cmd
set BASE_URL=https://pharmacy-patient-portal.dev.apps.lilly.com&& set CONCURRENCY=100&& set TIMEOUT_MS=30000&& set OUTPUT_PATH=.\playwright-load\results\summary-url-100.json&& node .\playwright-load\url-hit-load.js
```

### 6.1) Optional: Run 50-user auth stability check (PowerShell)

```powershell
$env:OUTPUT_FORMAT="table"; $env:COOKIE_ACTION="script_loaded"; $env:AIRGAP_SCRIPT_MATCH="airgap.js"; $env:CONCURRENCY="50"; $env:ITERATIONS="1"; $env:CONTEXT_MODE="shared"; $env:BATCH_SIZE="1"; $env:BATCH_DELAY_MS="2500"; $env:HEADLESS="false"; $env:PREFLIGHT_ENABLED="true"; $env:PREFLIGHT_STRICT="true"; $env:PREFLIGHT_RETRIES="8"; $env:PREFLIGHT_DELAY_MS="3000"; $env:AUTH_RETURN_WAIT_MS="90000"; $env:OUTPUT_PATH=".\playwright-load\results\summary-airgap-auth-50.json"; node .\playwright-load\airgap.js
```

### 7) Generate one tabular execution report from outputs

```cmd
npm run report:table
```

This prints table summaries in terminal and writes:

- `playwright-load/results/test-execution-report.md`

## Expected Outcome

Use this section to quickly decide whether each step passed.

### Auth bootstrap

- Command: `npm run auth:bootstrap`
- Expected: Browser login flow completes and `playwright-load/auth-state-ms.json` is created or refreshed.
- Fail signal: You remain stuck on Microsoft login or auth state file is missing.

### Consent capture

- Output file: `playwright-load/results/consent-event-capture.json`
- Expected: `consentPayloadValidation.passed` is `true`.
- If false: Check `consentPayloadValidation.sampleCandidates` for mismatch details.

### 1-user content-check

- Output file: `playwright-load/results/summary-airgap-1user.json`
- Expected:
	- `totals.failureCount = 0`
	- `cookieBanner.successRatePct = 100`
	- `passCriteria.passed = true`
- Purpose: Smoke validation before concurrent load.

### 20-user content-check

- Output file: `playwright-load/results/summary-airgap-20user.json`
- Expected:
	- `totals.failureCount = 0`
	- `cookieBanner.successRatePct = 100`
	- `passCriteria.passed = true`
- If failures exist: Inspect `sampleFailures` for first failing user and reason.

### 25-user content-check (optional)

- Output file: `playwright-load/results/summary-airgap-25user.json`
- Expected: Same pass criteria as 20-user run.

### 100 URL-hit run (optional)

- Output file: `playwright-load/results/summary-url-100.json`
- Expected:
	- `requests = 100`
	- `failureCount` near 0 (or per your tolerance)
	- Latency and throughput within your benchmark target.

### Tabular report

- Command: `npm run report:table`
- Expected:
	- Tables printed in terminal.
	- Report written to `playwright-load/results/test-execution-report.md`.

## Useful npm shortcuts

```cmd
npm run auth:bootstrap
npm run consent:capture
npm run report:table
npm run airgap:100
npm run airgap:500
```

## Output files

Most results are written under:

- `playwright-load/results/`

Examples:

- `consent-event-capture.json`
- `summary-airgap-1user.json`
- `summary-airgap-20user.json`
- `summary-airgap-25user.json`
- `summary-url-100.json`
- `test-execution-report.md`
