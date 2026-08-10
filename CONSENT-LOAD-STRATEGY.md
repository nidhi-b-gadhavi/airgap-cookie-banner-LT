# Cookie Consent Load Testing – Playwright vs k6 Strategy

## Why This Is Uniquely Complex

The consent banner uses a **closed Shadow DOM** (`mode: "closed"` on `#transcend-consent-manager`).
There is **no API call** when a user accepts or rejects — the result is written entirely client-side:
- Cookie: `tcm` on `.lilly.com`
- localStorage: `tcmConsent`

This means **only real browser execution** can click the button, read the result, and verify the outcome.
k6 HTTP mode alone cannot do this — it has no DOM access.

---

## Tool Capability Matrix

| Capability | Playwright | k6 HTTP | k6 Browser |
|---|---|---|---|
| Real browser UI | Yes | No | Yes |
| Shadow DOM interaction | Yes (evaluate) | No | Yes (evaluate) |
| Click Accept / Reject | Yes | No | Yes |
| Verify tcm cookie after click | Yes | No | Yes |
| Verify tcmConsent localStorage | Yes | No | Yes |
| Microsoft SSO auth | Yes (saved state) | No | Yes (saved state) |
| Concurrent users | Yes (CONCURRENCY) | Yes (vus) | Yes (but heavier) |
| Raw URL load 200+ users | Limited | Yes | Limited |
| Machine RAM per user | High (real browser) | Very low | High (real browser) |

---

## Concurrency Guide

### 1–20 Users — Playwright accept_verify / reject_verify

Each virtual user opens a real browser tab, clicks Accept All or Reject All inside the shadow DOM, waits, then verifies `tcm` cookie and `tcmConsent` localStorage.

Accept All verify (CMD):
```
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=accept_verify&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set CONCURRENCY=20&& set ITERATIONS=1&& set BATCH_SIZE=1&& set BATCH_DELAY_MS=2500&& set HEADLESS=false&& set CONTEXT_MODE=shared&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set PREFLIGHT_RETRIES=8&& set AUTH_RETURN_WAIT_MS=90000&& set OUTPUT_PATH=.\playwright-load\results\summary-accept-verify-20.json&& node .\playwright-load\airgap.js
```

Reject All verify (CMD):
```
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=reject_verify&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set CONCURRENCY=20&& set ITERATIONS=1&& set BATCH_SIZE=1&& set BATCH_DELAY_MS=2500&& set HEADLESS=false&& set CONTEXT_MODE=shared&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set PREFLIGHT_RETRIES=8&& set AUTH_RETURN_WAIT_MS=90000&& set OUTPUT_PATH=.\playwright-load\results\summary-reject-verify-20.json&& node .\playwright-load\airgap.js
```

Pass criteria: `cookieBanner.successRatePct = 100`, `hasCookie = true`, `hasLocalStorage = true` for all users.

---

### 20–50 Users — Playwright with stricter batching

Same as above, increase CONCURRENCY and slow down batch pacing to avoid SSO throttling.

Accept All verify at 50 users (CMD):
```
set OUTPUT_FORMAT=table&& set COOKIE_ACTION=accept_verify&& set COOKIE_BANNER_SELECTOR=#transcend-consent-manager&& set CONCURRENCY=50&& set ITERATIONS=1&& set BATCH_SIZE=1&& set BATCH_DELAY_MS=3000&& set HEADLESS=true&& set CONTEXT_MODE=shared&& set PREFLIGHT_ENABLED=true&& set PREFLIGHT_STRICT=true&& set PREFLIGHT_RETRIES=8&& set PREFLIGHT_DELAY_MS=3000&& set AUTH_RETURN_WAIT_MS=90000&& set OUTPUT_PATH=.\playwright-load\results\summary-accept-verify-50.json&& node .\playwright-load\airgap.js
```

If auth fails at 50 users: run `script_loaded` mode first to confirm auth stability, then retry with `accept_verify`.

---

### 50–100 Users — k6 Browser module

**How it works:**
1. Playwright bootstrap runs once and saves `auth-state-ms.json`.
2. k6 browser script loads that saved session into each virtual user browser context — no SSO redirect per user.
3. Each k6 virtual user navigates to BASE_URL, uses `page.evaluate()` to click Accept/Reject inside the shadow DOM, then reads and verifies cookie and localStorage.
4. k6 aggregates pass/fail and latency across all virtual users with built-in ramp/hold/cooldown profiles.

**Advantage at this scale:**
Lower orchestration overhead per virtual user than Playwright at 100 concurrent, and k6 has better built-in threshold and ramp reporting.

**Implementation needed:** `k6/consent-verify.js` (not yet built)

---

### 100–200 Users — k6 Browser ramp profile or distributed execution

**Option A — Single machine k6 browser:**
Run k6 with a staged ramp profile to reach 100–200 virtual browser users.
Each browser context uses approximately 50–80 MB RAM.
200 users requires approximately 10–16 GB RAM just for browser contexts.
Realistic only on a machine with 16 GB+ RAM.

**Option B — Distributed execution (recommended for 200+):**
Run multiple instances of Playwright or k6 on separate machines or CI agents, each handling 50 users, all targeting the same BASE_URL.
No additional tooling required — same scripts on different machines.

**Option C — k6 HTTP for raw load only (not consent verification):**
k6 HTTP can hit BASE_URL at 200–500+ concurrent users at very low cost.
Cannot verify shadow DOM, cookie, or localStorage.
Use only to confirm server response time and stability under heavy request load.

Raw URL load at 200 users (CMD):
```
set BASE_URL=https://pharmacy-patient-portal.dev.apps.lilly.com&& set CONCURRENCY=200&& set TIMEOUT_MS=30000&& set OUTPUT_PATH=.\playwright-load\results\summary-url-200.json&& node .\playwright-load\url-hit-load.js
```

---

## Recommended Execution Phases for Client

| Phase | Users | Tool | Mode | What is verified |
|---|---|---|---|---|
| Smoke | 1 | Playwright | accept_verify | Shadow DOM click + tcm cookie + tcmConsent localStorage |
| Smoke | 1 | Playwright | reject_verify | Shadow DOM click + tcm cookie + tcmConsent localStorage |
| Functional load | 20 | Playwright | accept_verify | Same, 20 concurrent browser users |
| Functional load | 20 | Playwright | reject_verify | Same, 20 concurrent browser users |
| Scale load | 50 | Playwright | accept_verify | Same, staggered batching |
| Scale load | 50–100 | k6 browser | consent-verify | Same via pre-seeded auth state |
| Raw load | 100–200 | url-hit-load.js | HTTP GET | Server response, latency, error rate |
| Raw load | 200+ | k6 HTTP | HTTP GET | Same at higher concurrency |

---

## Auth State Reuse Strategy

Both Playwright and k6 browser share the same `playwright-load/auth-state-ms.json`.

1. Run `npm run auth:bootstrap` once.
2. All Playwright runs load session cookies from that file automatically.
3. k6 browser script reads the same file and injects storage state per virtual user context — no SSO redirect per user.
4. Re-run bootstrap when session expires (typically every 8–24 hours depending on AAD policy).

---

## Build Status

| Item | Status | File |
|---|---|---|
| Playwright accept_verify mode | Pending re-apply | playwright-load/airgap.js |
| Playwright reject_verify mode | Pending re-apply | playwright-load/airgap.js |
| k6 browser consent-verify script | Not yet built | k6/consent-verify.js |
| k6 HTTP raw load script | Not yet built | k6/url-load.js |
