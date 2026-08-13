#!/usr/bin/env node
/**
 * Live authenticated browser smoke.
 *
 * Uses the real protected production owner identity. It does not mutate business
 * records: it proves sign-in, optional TOTP challenge, owner Admin access,
 * cross-tab session hydration, and cross-tab logout revocation.
 */
import { chromium, webkit } from 'playwright';
import { totp } from './lib/totp.mjs';

const base = (process.env.SMOKE_SITE_URL || '').replace(/\/+$/, '');
const email = process.env.SMOKE_OWNER_EMAIL || '';
const password = process.env.SMOKE_OWNER_PASSWORD || '';
const totpSecret = (process.env.SMOKE_OWNER_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();
if (!base || !email || !password) {
  console.error('SMOKE_SITE_URL, SMOKE_OWNER_EMAIL and SMOKE_OWNER_PASSWORD are required.');
  process.exit(2);
}

async function waitForEither(page, selectors, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const selector of selectors) {
      if (await page.locator(selector).isVisible().catch(() => false)) return selector;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for: ${selectors.join(', ')}`);
}

const browserName = process.env.SMOKE_BROWSER || 'chromium';
const engine = { chromium, webkit }[browserName];
if (!engine) { console.error('SMOKE_BROWSER must be chromium or webkit.'); process.exit(2); }
const browser = await engine.launch();
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

try {
  await page.goto(`${base}/staff/login/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#staff-email').fill(email);
  await page.locator('#staff-password').fill(password);
  await page.locator('#staff-signin-submit').click();

  const state = await waitForEither(page, ['#staff-mfa-code', '#hub-tab-admin-dash', 'text=Set up two-step verification']);
  if (state === 'text=Set up two-step verification') {
    throw new Error('The smoke owner account is not MFA-enrolled. Enrol it manually once before enabling this gate.');
  }
  if (state === '#staff-mfa-code') {
    if (!totpSecret) throw new Error('The owner account requested MFA but SMOKE_OWNER_TOTP_SECRET is missing.');
    const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (remaining < 4) await page.waitForTimeout((remaining + 1) * 1000);
    await page.locator('#staff-mfa-code').fill(totp(totpSecret));
    await page.locator('#staff-mfa-submit').click();
    await page.locator('#hub-tab-admin-dash').waitFor({ state: 'visible', timeout: 20_000 });
  }

  await page.locator('#hub-tab-admin-dash').click();
  await page.locator('#admin-root-container').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('heading', { name: 'Admin Control Panel' }).waitFor({ state: 'visible' });
  if (!(await page.locator('#global-admin-search').count())) throw new Error('Admin secure search was not rendered.');

  const peer = await context.newPage();
  await peer.goto(`${base}/staff/`, { waitUntil: 'domcontentloaded' });
  await peer.locator('#hub-tab-admin-dash').waitFor({ state: 'visible', timeout: 20_000 });

  await page.getByRole('button', { name: 'Staff dashboard' }).click();
  await page.locator('#hub-tab-admin-dash').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#nav-logout-btn').click();
  await page.locator('#staff-signin-submit').waitFor({ state: 'visible', timeout: 20_000 });
  await peer.locator('#staff-signin-submit').waitFor({ state: 'visible', timeout: 20_000 });

  if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`);
  if (consoleErrors.length) throw new Error(`Browser console error: ${consoleErrors[0]}`);
  console.log(`AUTHENTICATED BROWSER SMOKE PASS [${browserName}] — owner login, MFA, Admin access, cross-tab hydration and logout revocation`);
} finally {
  await browser.close();
}
