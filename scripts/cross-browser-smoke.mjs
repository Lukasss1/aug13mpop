#!/usr/bin/env node
/** Lightweight compatibility smoke for the built public/staff shell. */
import { chromium, firefox, webkit } from 'playwright';

const base = process.env.MP_BASE || 'http://127.0.0.1:4173';
const engines = { chromium, firefox, webkit };
const routes = ['/', '/menu/', '/stores/', '/contact/', '/staff/login/'];
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const route of routes) {
      errors.length = 0;
      const response = await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.locator('body').waitFor({ state: 'visible' });
      const facts = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        h1: document.querySelectorAll('h1').length,
        main: Boolean(document.querySelector('main, #main, [role="main"]')),
      }));
      check(`${name} ${route} returns a document`, Boolean(response) && (response.status() < 500), `status ${response?.status()}`);
      check(`${name} ${route} has language, title, one h1 and main`, Boolean(facts.lang) && facts.title.length > 0 && facts.h1 === 1 && facts.main, JSON.stringify(facts));
      check(`${name} ${route} has no uncaught page error`, errors.length === 0, errors[0] || '');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const hamburger = page.locator('#mobile-menu-hamburger');
    await hamburger.waitFor({ state: 'visible' });
    await hamburger.click();
    check(`${name} mobile navigation opens`, await hamburger.getAttribute('aria-expanded') === 'true');
    await page.keyboard.press('Escape');
    check(`${name} mobile navigation closes with Escape`, await hamburger.getAttribute('aria-expanded') === 'false');
  } finally {
    await browser.close();
  }
}

console.log(`\nCROSS-BROWSER SMOKE — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
