#!/usr/bin/env node
/**
 * Lot 1-23A — Tournage : captures RÉELLES de l'application de démonstration.
 *
 * Préalable : pile `motion-23a` démarrée et peuplée (seed-royalvibe.js).
 * Chaque plan est une vraie action locale (vente, droits, vente hors ligne puis
 * synchronisation, export) ; aucune interface n'est composée ni retouchée.
 *
 * Sortie : film/assets/captures/<id>.png (téléphone 390 × 844 à l'échelle 3 =
 * 1170 × 2532 ; bureau 1440 × 900 à l'échelle 2) et captures.json (pour chaque
 * image : appareil, compte, URL, boîtes des éléments touchés en px CSS).
 * Vérifications consignées dans capture-checks.json (stock, unicité de la
 * vente synchronisée, téléchargement).
 *
 * Usage : node demo/capture.js [--only=<plan>,<plan>]
 * Attention : les ventes et le changement de droits sont RÉELLEMENT
 * enregistrés dans la base de démonstration (rejouer après `motion-demo.js reset`).
 */
'use strict';

process.env.RECIPE_PROFILE = 'motion-23a';
const RECIPE = '../../../api/test/recipe';
require(`${RECIPE}/preload.cjs`);
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const C = require(`${RECIPE}/recipe-common`);
const D = require(`${RECIPE}/db-tools`);

const WEB = C.WEB_ORIGIN;
const OUT = path.resolve(__dirname, '../film/assets/captures');
const ACCOUNTS = {
  owner: 'mireille@royalvibe.example.test',
  junior: 'junior@royalvibe.example.test',
  grace: 'grace@royalvibe.example.test',
};
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
};
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

const manifest = {};
const checks = {};
const say = (line) => process.stdout.write(`[tournage] ${line}\n`);

async function open(browser, who, device = PHONE) {
  const context = await browser.newContext({
    ...device,
    locale: 'fr-FR',
    timezoneId: 'Africa/Douala',
    colorScheme: 'light',
    acceptDownloads: true,
  });
  // Aucun service externe : tout reste sur 127.0.0.1.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') (checks.consoleErrors ||= []).push(`${who}: ${m.text()}`);
  });
  await page.goto(`${WEB}/auth/login`);
  await page.fill('#email', ACCOUNTS[who]);
  await page.fill('#password', C.PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 });
  await dismissNotice(page);
  return { context, page, who, device: device === PHONE ? 'phone' : 'desktop' };
}

/** Bandeau « Notifications bloquées » du navigateur de test : « Plus tard ». */
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

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {});
  // Images chargées (photos signées du stockage simulé).
  await page
    .evaluate(() =>
      Promise.all(
        [...document.images]
          .filter((i) => !i.complete)
          .map((i) => new Promise((r) => (i.onload = i.onerror = r))),
      ),
    )
    .catch(() => {});
  await page.waitForTimeout(ms);
}

async function box(locator) {
  const b = await locator.first().boundingBox().catch(() => null);
  return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}

async function shot(s, id, targets = {}, { fullPage = false } = {}) {
  const file = `${id}.png`;
  // Pleine page : les éléments fixes ou collants (barre de navigation…) sont
  // masqués le temps de la prise, sinon ils restent figés au milieu de
  // l'image longue. Le film superpose la vraie barre (capture normale).
  let fixed = [];
  if (fullPage) {
    fixed = await s.page.evaluate(() => {
      const found = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && cs.visibility !== 'hidden') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            found.push({ tag: el.tagName, position: cs.position, y: Math.round(r.y), h: Math.round(r.height) });
            el.setAttribute('data-capture-hidden', '1');
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        }
      }
      return found;
    });
  }
  await s.page.screenshot({ path: path.join(OUT, file), fullPage });
  if (fullPage) {
    await s.page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-capture-hidden]')) {
        el.style.removeProperty('visibility');
        el.removeAttribute('data-capture-hidden');
      }
    });
  }
  const boxes = {};
  for (const [name, locator] of Object.entries(targets)) boxes[name] = await box(locator);
  manifest[id] = {
    file,
    device: s.device,
    account: s.who,
    url: s.page.url().replace(WEB, ''),
    fullPage,
    hiddenFixed: fixed,
    boxes,
    at: new Date().toISOString(),
  };
  say(`${id}`);
}

async function ids() {
  const login = await C.api('POST', '/auth/login', {
    body: { email: ACCOUNTS.owner, password: C.PASSWORD },
  });
  const token = login.body.access_token;
  const sections = (await C.api('GET', '/sections', { token })).body;
  const find = async (sectionPrefix, productPart) => {
    const section = sections.find((s) => s.name.startsWith(sectionPrefix));
    const list = (await C.api('GET', `/products?sectionId=${section._id}`, { token })).body;
    const product = list.map((x) => x.product).find((p) => p.name.includes(productPart));
    return { section: section._id, product: product && product._id, token };
  };
  return {
    huiles: await find('Huiles', 'argan'),
    laits: await find('Laits', 'karité'),
    gels: await find('Gels', 'Savon noir'),
    token,
  };
}

async function stockOf(token, productId) {
  const res = await C.api('GET', `/products/${productId}`, { token });
  const p = res.body.product || res.body;
  return p.remainingQuantity;
}

// ─── Plans ───────────────────────────────────────────────────────────────────

const PLANS = {
  /** Accueil et catalogue (propriétaire). */
  async catalogue(browser, ref) {
    const s = await open(browser, 'owner');
    await settle(s.page);
    await shot(s, 'p01-accueil', { catalogue: s.page.getByText('Catalogue', { exact: true }) });
    await s.page.goto(`${WEB}/app/catalog`);
    await settle(s.page);
    await shot(s, 'p02-rayons', { laits: s.page.getByText('Laits corporels').first() });
    await s.page.goto(`${WEB}/app/catalog/${ref.laits.section}`);
    await settle(s.page, 1500);
    await shot(s, 'p03-rayon-laits');
    await shot(s, 'p03-rayon-laits-long', {}, { fullPage: true });
    await s.page.goto(`${WEB}/app/catalog/${ref.huiles.section}`);
    await settle(s.page, 1500);
    await shot(s, 'p04-rayon-huiles', {
      argan: s.page.getByText('Huile d’argan 50 ml').first(),
    });
    await s.context.close();
    // Bureau : même rayon en grille.
    const d = await open(browser, 'owner', DESKTOP);
    await d.page.goto(`${WEB}/app/catalog/${ref.laits.section}`);
    await settle(d.page, 1500);
    await shot(d, 'd01-rayon-laits');
    await d.context.close();
  },

  /** Vente par Junior (droit « Voir le détail du stock ») : le stock suit. */
  async vente(browser, ref) {
    const before = await stockOf(ref.token, ref.huiles.product);
    const s = await open(browser, 'junior');
    await s.page.goto(`${WEB}/app/catalog/products/${ref.huiles.product}`);
    await settle(s.page, 1500);
    const record = s.page.getByRole('button', { name: 'Enregistrer une vente' });
    await shot(s, 'p05-produit-avant', {
      record,
      stock: s.page.getByText('Stock restant').first(),
    });
    await record.first().click();
    await s.page.locator('#s-qty').waitFor();
    await s.page.waitForTimeout(600);
    const confirm = s.page.getByRole('button', { name: 'Confirmer la vente' });
    await shot(s, 'p06-fenetre-vente', {
      quantity: s.page.locator('#s-qty'),
      price: s.page.locator('#s-price'),
      confirm,
    });
    await confirm.click();
    await s.page.getByText('Vente enregistrée').first().waitFor({ timeout: 15000 });
    await s.page.waitForTimeout(700);
    await shot(s, 'p07-vente-enregistree', {
      toast: s.page.getByText('Vente enregistrée').first(),
      stock: s.page.getByText('Stock restant').first(),
    });
    await s.page.waitForTimeout(2500);
    await settle(s.page, 800);
    await shot(s, 'p08-produit-apres', {
      stock: s.page.getByText('Stock restant').first(),
    });
    await s.context.close();
    checks.vente = { product: 'Huile d’argan 50 ml', before, after: await stockOf(ref.token, ref.huiles.product) };
  },

  /** Équipe : notification reçue, droits attribués à Grâce. */
  async equipe(browser) {
    const s = await open(browser, 'owner');
    await settle(s.page);
    await shot(s, 'p09-cloche', { bell: s.page.getByRole('link', { name: /otification/ }).first() });
    await s.page.goto(`${WEB}/app/notifications`);
    await settle(s.page);
    await shot(s, 'p10-notifications');
    await s.page.goto(`${WEB}/app/organization/members`);
    await settle(s.page);
    await shot(s, 'p11-membres', {
      junior: s.page.getByText('Junior Tchoumi').first(),
      grace: s.page.getByText('Grâce Ewane').first(),
      editGrace: s.page.getByRole('button', { name: /Modifier/ }).nth(2),
    });
    await s.page.getByRole('button', { name: /Modifier/ }).nth(2).click();
    // Permission citée par la voix off : « voir toutes les ventes ».
    const right = s.page.getByLabel('Voir toutes les ventes');
    await right.waitFor();
    await s.page.waitForTimeout(500);
    await shot(s, 'p12-droits-avant', { right });
    await right.check();
    await s.page.waitForTimeout(400);
    const save = s.page.getByRole('button', { name: 'Enregistrer', exact: true });
    await shot(s, 'p13-droits-coches', { right, save });
    await save.click();
    await s.page.waitForTimeout(1500);
    await settle(s.page);
    await shot(s, 'p14-membres-apres', { grace: s.page.getByText('Grâce Ewane').first() });
    await s.context.close();
  },

  /** Hors ligne : Grâce vend sans réseau, puis la vente se synchronise une fois. */
  async horsligne(browser, ref) {
    const before = await stockOf(ref.token, ref.gels.product);
    const s = await open(browser, 'grace');
    // Session et catalogue préparés EN LIGNE (service worker, catalogue local).
    await s.page.goto(`${WEB}/app/catalog`);
    await settle(s.page, 1500);
    await s.page.goto(`${WEB}/app/catalog/${ref.gels.section}`);
    await settle(s.page, 1500);
    await s.page.goto(`${WEB}/app/catalog/products/${ref.gels.product}`);
    await settle(s.page, 2500);
    await s.context.setOffline(true);
    await s.page.waitForTimeout(1500);
    await shot(s, 'p15-hors-ligne-produit', {
      record: s.page.getByRole('button', { name: 'Enregistrer une vente' }),
    });
    await s.page.getByRole('button', { name: 'Enregistrer une vente' }).first().click();
    await s.page.locator('#s-qty').waitFor();
    await s.page.locator('#s-qty').fill('2');
    await s.page.waitForTimeout(500);
    await shot(s, 'p16-hors-ligne-fenetre', {
      offlineNote: s.page.getByText('La vente sera enregistrée sur cet appareil').first(),
      quantity: s.page.locator('#s-qty'),
      confirm: s.page.getByRole('button', { name: 'Confirmer la vente' }),
    });
    await s.page.getByRole('button', { name: 'Confirmer la vente' }).click();
    await s.page.getByText('en attente de synchronisation').first().waitFor({ timeout: 15000 });
    await s.page.waitForTimeout(600);
    await shot(s, 'p17-hors-ligne-en-attente', {
      toast: s.page.getByText('en attente de synchronisation').first(),
    });
    // Navigation INTERNE (hors ligne) : indicateur « ventes en attente » de
    // l'en-tête → panneau des ventes locales du catalogue hors ligne.
    const pending = s.page.getByRole('link', { name: /en attente/ }).first();
    await shot(s, 'p17b-indicateur', { pending });
    await pending.click();
    await s.page.waitForTimeout(1500);
    await shot(s, 'p18-ventes-en-attente');
    const serverBefore = await countGraceSoap(ref);
    // Retour du réseau, application ouverte : envoi automatique attendu.
    await s.context.setOffline(false);
    const deadline = Date.now() + 90_000;
    let synced = serverBefore;
    while (Date.now() < deadline) {
      synced = await countGraceSoap(ref);
      if (synced.count > serverBefore.count) break;
      await s.page.waitForTimeout(1000);
    }
    await s.page.waitForTimeout(2500);
    // Page hors ligne restée ouverte : son affichage n'est pas rafraîchi par
    // l'envoi (constat), d'où la relecture en ligne ci-dessous.
    await shot(s, 'p19-synchronisee');
    await s.page.goto(`${WEB}/app/sales/pending`);
    await settle(s.page, 1500);
    await shot(s, 'p19b-recemment-synchronisees');
    const recent = s.page.getByText(/Récemment synchronisées/).first();
    if (await recent.count()) {
      await recent.click();
      await s.page.waitForTimeout(800);
      await shot(s, 'p19c-synchronisee-detail', { status: s.page.getByText('Synchronisée').first() });
    }
    await s.context.close();
    const serverAfter = await countGraceSoap(ref);
    checks.horsligne = {
      product: 'Savon noir artisanal 250 g',
      stockBefore: before,
      stockAfter: await stockOf(ref.token, ref.gels.product),
      salesOnServerBeforeReconnect: serverBefore.count,
      salesOnServerAfterReconnect: serverAfter.count,
      newSales: serverAfter.count - serverBefore.count,
      duplicateOperationIds: serverAfter.duplicates,
    };
    // Vue propriétaire : la vente apparaît une seule fois.
    const o = await open(browser, 'owner');
    await o.page.goto(`${WEB}/app/sales`);
    await settle(o.page);
    await shot(o, 'p20-ventes-proprietaire');
    await o.context.close();
  },

  /** Historique et analyse (téléphone et bureau), export Excel réel. */
  async analyse(browser, ref) {
    // Chiffres affichés, relevés par l'API (repris tels quels par le film).
    const overview = (await C.api('GET', '/analytics/overview', { token: ref.token })).body;
    checks.facts = {
      revenueXaf: overview.totalRevenue,
      transactions: overview.totalTransactions,
      unitsSold: overview.unitsSold,
      lowStockCount: overview.lowStockCount,
      products: overview.productsCount,
    };
    const s = await open(browser, 'owner');
    await s.page.goto(`${WEB}/app/analytics`);
    await settle(s.page, 2000);
    await shot(s, 'p21-analyse');
    await shot(s, 'p21-analyse-long', {}, { fullPage: true });
    await s.page.goto(`${WEB}/app/sales`);
    await settle(s.page);
    await shot(s, 'p22-historique');
    await s.context.close();
    const d = await open(browser, 'owner', DESKTOP);
    await d.page.goto(`${WEB}/app/analytics`);
    await settle(d.page, 2000);
    await shot(d, 'd02-analyse');
    await shot(d, 'd02-analyse-long', {}, { fullPage: true });
    const excel = d.page.getByRole('button', { name: 'Télécharger en Excel' });
    if (await excel.count()) {
      await excel.first().scrollIntoViewIfNeeded();
      await d.page.waitForTimeout(500);
      await shot(d, 'd03-export', { excel });
      const [download] = await Promise.all([
        d.page.waitForEvent('download', { timeout: 30000 }),
        excel.first().click(),
      ]);
      const target = path.join(C.PERSISTENT.root, 'exports', download.suggestedFilename());
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await download.saveAs(target);
      checks.export = { file: path.basename(target), bytes: fs.statSync(target).size };
    }
    await d.context.close();
  },
};

/** Ventes de savon noir par Grâce sur le serveur, et identifiants dupliqués. */
async function countGraceSoap(ref) {
  const state = C.requireRunningState();
  const connection = await D.connect(state.mongodbUri);
  try {
    const { Types } = C.apiRequire('mongoose');
    const grace = await connection.db.collection('users').findOne({ email: ACCOUNTS.grace });
    const sales = await connection.db
      .collection('sales')
      .find({ productId: new Types.ObjectId(ref.gels.product), sellerId: grace._id })
      .toArray();
    const ops = sales.map((x) => x.clientOperationId).filter(Boolean);
    const dupes = ops.filter((v, i) => ops.indexOf(v) !== i);
    // Les opérations idempotentes sont dans `sale_operations`.
    const operations = await connection.db
      .collection('sale_operations')
      .aggregate([
        { $match: { productId: new Types.ObjectId(ref.gels.product) } },
        { $group: { _id: '$clientOperationId', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray()
      .catch(() => []);
    return { count: sales.length, duplicates: dupes.length + operations.length };
  } finally {
    await connection.close();
  }
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '')
    .slice('--only='.length)
    .split(',')
    .filter(Boolean);
  C.requireRunningState();
  fs.mkdirSync(OUT, { recursive: true });
  const manifestFile = path.join(OUT, 'captures.json');
  if (fs.existsSync(manifestFile)) Object.assign(manifest, JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const ref = await ids();
  const browser = await chromium.launch();
  try {
    for (const [name, plan] of Object.entries(PLANS)) {
      if (only.length && !only.includes(name)) continue;
      say(`plan ${name}`);
      await plan(browser, ref);
    }
  } finally {
    await browser.close();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    const checksFile = path.join(OUT, 'capture-checks.json');
    const previous = fs.existsSync(checksFile) ? JSON.parse(fs.readFileSync(checksFile, 'utf8')) : {};
    fs.writeFileSync(checksFile, JSON.stringify({ ...previous, ...checks, at: new Date().toISOString() }, null, 1));
  }
  say(`vérifications : ${JSON.stringify(checks)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
