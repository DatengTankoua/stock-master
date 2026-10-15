#!/usr/bin/env node
/**
 * Lot 1-23A — Exploration en lecture seule des fenêtres (aucune validation) :
 * modification d'un membre (ouverte puis annulée), fiche produit vue par un
 * vendeur, fenêtre de vente (ouverte puis fermée), analyse.
 * Usage : node demo/explore-dialogs.js <sortie>
 */
'use strict';

process.env.RECIPE_PROFILE = 'motion-23a';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const C = require('../../../api/test/recipe/recipe-common');

const WEB = C.WEB_ORIGIN;

/** Bandeau « Notifications bloquées » : refermé par son bouton « Plus tard ». */
async function dismissNotice(page) {
  const later = page.getByRole('button', { name: 'Plus tard' });
  try {
    await later.first().waitFor({ timeout: 4000 });
    await later.first().click();
    await page.waitForTimeout(300);
  } catch {
    // aucun bandeau
  }
}

async function session(browser, email) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    locale: 'fr-FR',
    timezoneId: 'Africa/Douala',
    colorScheme: 'light',
    hasTouch: true,
    isMobile: true,
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const page = await context.newPage();
  await page.goto(`${WEB}/auth/login`);
  await page.fill('#email', email);
  await page.fill('#password', C.PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 });
  await dismissNotice(page);
  return { context, page };
}

async function main() {
  const out = process.argv[2] || 'explore-dialogs';
  C.requireRunningState();
  fs.mkdirSync(out, { recursive: true });
  const shot = (page, name) =>
    page.screenshot({ path: path.join(out, `${name}.png`) });
  const browser = await chromium.launch();

  const owner = await session(browser, 'mireille@royalvibe.example.test');
  await owner.page.goto(`${WEB}/app/organization/members`, { waitUntil: 'networkidle' });
  await dismissNotice(owner.page);
  await shot(owner.page, 'members');
  const edit = owner.page.getByRole('button', { name: /Modifier/ });
  process.stdout.write(`boutons Modifier : ${await edit.count()}\n`);
  if (await edit.count()) {
    await edit.nth(2).click();
    await owner.page.waitForTimeout(800);
    await shot(owner.page, 'member-edit');
    await owner.page.screenshot({ path: path.join(out, 'member-edit-full.png'), fullPage: true });
    await owner.page.keyboard.press('Escape');
  }
  await owner.page.goto(`${WEB}/app/analytics`, { waitUntil: 'networkidle' });
  await owner.page.waitForTimeout(1500);
  await shot(owner.page, 'analytics');
  await owner.page.goto(`${WEB}/app/organization/branding`, { waitUntil: 'networkidle' });
  await shot(owner.page, 'branding');
  await owner.context.close();

  const junior = await session(browser, 'junior@royalvibe.example.test');
  await junior.page.goto(`${WEB}/app/catalog`, { waitUntil: 'networkidle' });
  await junior.page.getByText('Huiles corporelles').first().click();
  await junior.page.waitForLoadState('networkidle');
  await shot(junior.page, 'junior-section');
  await junior.page.getByText('Huile d’argan 50 ml').first().click();
  await junior.page.waitForLoadState('networkidle');
  await junior.page.waitForTimeout(800);
  await shot(junior.page, 'junior-product');
  const record = junior.page.getByRole('button', { name: 'Enregistrer une vente' });
  if (await record.count()) {
    await record.first().click();
    await junior.page.waitForTimeout(800);
    await shot(junior.page, 'junior-sale-dialog');
    await junior.page.keyboard.press('Escape');
  }
  await junior.context.close();

  const grace = await session(browser, 'grace@royalvibe.example.test');
  await grace.page.goto(`${WEB}/app`, { waitUntil: 'networkidle' });
  await shot(grace.page, 'grace-home');
  await grace.context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
