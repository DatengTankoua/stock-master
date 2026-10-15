#!/usr/bin/env node
/**
 * Lot 1-23A — Exploration en lecture seule de l'interface de démonstration :
 * connexion d'un compte fictif puis capture des écrans listés (téléphone).
 * Usage : node demo/explore.js <sortie> [email] [routes...]
 */
'use strict';

process.env.RECIPE_PROFILE = 'motion-23a';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const C = require('../../../api/test/recipe/recipe-common');

const WEB = C.WEB_ORIGIN;

async function main() {
  const [out = 'explore', email = 'mireille@royalvibe.example.test', ...routes] =
    process.argv.slice(2);
  C.requireRunningState();
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    locale: 'fr-FR',
    timezoneId: 'Africa/Douala',
    colorScheme: 'light',
    hasTouch: true,
    isMobile: true,
  });
  // Aucun service externe : seuls 127.0.0.1 et les polices déjà intégrées.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${WEB}/auth/login`);
  await page.fill('#email', email);
  await page.fill('#password', C.PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 });
  const list = routes.length
    ? routes
    : ['/app', '/app/catalog', '/app/sales', '/app/analytics', '/app/notifications', '/app/organization', '/app/organization/members'];
  for (const route of list) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const name = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    process.stdout.write(`${route} → ${name}.png\n`);
  }
  process.stdout.write(`erreurs console : ${errors.length}\n${errors.slice(0, 5).join('\n')}\n`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
