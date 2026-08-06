require('./load-env');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const LOGIN_URL = (process.env.LOGIN_URL || process.env.BASE_URL || '').trim();
const AUTH_STATE_PATH = (process.env.AUTH_STATE_PATH || './playwright-load/auth-state-ms.json').trim();
const POST_LOGIN_URL_CONTAINS = (process.env.POST_LOGIN_URL_CONTAINS || '').trim();
const WAIT_FOR_REDIRECT_MS = Number(process.env.WAIT_FOR_REDIRECT_MS || 180000);
const ALLOW_ENTER_FALLBACK = (process.env.ALLOW_ENTER_FALLBACK || 'true').trim().toLowerCase() !== 'false';

function isMicrosoftDomain(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('login.microsoftonline.com') || value.includes('microsoft.com');
}

function isPostLoginUrl(url) {
  if (!url) return false;
  if (POST_LOGIN_URL_CONTAINS && !String(url).includes(POST_LOGIN_URL_CONTAINS)) {
    return false;
  }
  return !isMicrosoftDomain(url);
}

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('After completing sign-in, press Enter to save session (manual fallback)... ', () => {
      rl.close();
      resolve();
    });
  });
}

async function waitForPostLoginRedirect(page) {
  await page.waitForURL((url) => isPostLoginUrl(url.toString()), {
    timeout: WAIT_FOR_REDIRECT_MS,
  });
}

async function main() {
  if (!LOGIN_URL) {
    throw new Error('LOGIN_URL or BASE_URL is required.');
  }

  const statePath = path.resolve(AUTH_STATE_PATH);
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Opening login page: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  console.log('Complete Microsoft sign-in (including MFA if prompted).');
  console.log('Waiting for redirect back to app URL...');

  let savedBy = 'redirect';
  try {
    await waitForPostLoginRedirect(page);
    console.log(`Detected post-login URL: ${page.url()}`);
  } catch (redirectError) {
    if (!ALLOW_ENTER_FALLBACK) {
      throw new Error(
        `Did not detect post-login redirect within ${WAIT_FOR_REDIRECT_MS}ms. Last URL: ${page.url()}`
      );
    }

    savedBy = 'manual-enter';
    console.log(
      `Auto-detect timed out after ${WAIT_FOR_REDIRECT_MS}ms. Last URL: ${page.url()}`
    );
    console.log('Using manual fallback.');
    await waitForEnter();
  }

  await context.storageState({ path: statePath });
  const stateStats = fs.statSync(statePath);
  await browser.close();

  console.log(`Auth state saved (${savedBy}): ${statePath}`);
  console.log(`Auth state size: ${stateStats.size} bytes`);
}

main().catch((error) => {
  console.error('Failed to capture Microsoft auth state:', error);
  process.exit(1);
});
