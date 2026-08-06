# Airgap Cookie Banner — Load Test Guide

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Git](https://git-scm.com/)

---

## 1. Clone the Repository

```bash
git clone https://github.com/nidhi-b-gadhavi/airgap-cookie-banner-LT.git
cd airgap-cookie-banner-LT/playwright-load
```

---

## 2. Install Dependencies

```bash
cd ..
npm install
npx playwright install chromium
```

---

## 3. Configure Environment

Copy or create a `.env` file in the root with at minimum:

```env
BASE_URL=https://your-target-site.com
```

> Refer to `playwright-load/load-env.js` for all supported environment variables.

---

## 4. Authenticate (if required)

Run the auth bootstrap to generate the auth state before load testing:

```bash
npm run auth:bootstrap
```

---

## 5. Run Load Tests
