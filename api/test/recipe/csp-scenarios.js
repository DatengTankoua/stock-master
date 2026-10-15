/**
 * 1-22F — Recette navigateur de la CSP sur la pile locale (build de
 * production servi par `recipe.js start`, 127.0.0.1). TEST uniquement.
 *
 *   RECIPE_TURNSTILE_SITE_KEY=1x00000000000000000000AA node api/test/recipe/recipe.js start
 *   RECIPE_PLAYWRIGHT_DIR=<dossier contenant node_modules/playwright> \
 *     node api/test/recipe/csp-scenarios.js [PUB TURNSTILE APP PAY NAV BLOCK PWA]
 *
 * Aucun service réel : Turnstile (script et iframe) et la page SasPay sont
 * servis par le navigateur de test sous leurs origines officielles (routes),
 * toute autre requête vers ces hôtes est annulée. PAY bascule l'API sur le
 * fournisseur `saspay` simulé puis revient à `simulated`. PWA remplace
 * temporairement le `sw.js` de la COPIE ISOLÉE (base HEAD, puis dépôt), comme
 * un déploiement, et le restaure toujours. PUB : pages publiques bilingues
 * en anglais sous `/en` (langue imposée par l'URL).
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '../../..');
const L = require('./lib');
const WEB = L.WEB;
const API = L.API;
const PASSWORD = L.C.PASSWORD;
const OWNER = 'proprietaire.actif@recette.local';

const results = [];
const only = process.argv.slice(2);
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} — ${JSON.stringify(detail)}`);
}

async function newContext(browser, opts = {}) {
  const context = await browser.newContext({
    locale: opts.locale || 'fr-FR',
    extraHTTPHeaders: {
      'Accept-Language': opts.locale === 'en-US' ? 'en' : 'fr',
    },
    serviceWorkers: opts.serviceWorkers || 'block',
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
        sample: e.sample,
        disposition: e.disposition,
      }),
    );
  });
  context.__console = [];
  context.on('page', (p) => watch(context, p));
  // Aucun appel réel : Cloudflare et SasPay ne sont joints que par les
  // routes locales des scénarios TURNSTILE et PAY (déclarées après, donc
  // prioritaires).
  await context.route('https://challenges.cloudflare.com/**', (r) => r.abort());
  await context.route('https://pay.saspay.me/**', (r) => r.abort());
  return context;
}
function watch(context, page) {
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      context.__console.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) =>
    context.__console.push(`pageerror: ${String(e).slice(0, 200)}`),
  );
}
const violations = (page) => page.evaluate(() => window.__csp || []);

async function apiLogin(email) {
  const res = await L.http('POST', '/auth/login', {
    body: { email, password: PASSWORD },
  });
  if (res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.access_token;
}
async function png(color) {
  const sharp = L.C.apiRequire('sharp');
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}
async function createProduct(token, sectionId, name) {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    sectionId,
    name,
    purchasePrice: 100,
    salePrice: 400,
    initialQuantity: 20,
  }))
    form.append(k, String(v));
  form.append(
    'image',
    new Blob([await png('#2e86de')], { type: 'image/png' }),
    'p.png',
  );
  const res = await fetch(`${API}/products`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json();
  if (res.status !== 201)
    throw new Error(`produit ${res.status} ${JSON.stringify(body)}`);
  return body;
}
async function uiLogin(page, email) {
  await page.goto(`${WEB}/auth/login`);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 });
}

const scenarios = {
  // Pages publiques FR/EN et connexion : aucun blocage, scripts exécutés.
  // Référencement : la langue des pages publiques bilingues est celle de
  // leur URL (anglais sous `/en`) ; la connexion, l'inscription et l'écran
  // hors ligne suivent toujours la langue du navigateur.
  async PUB(browser) {
    const bilingual = ['/', '/guide', '/contact', '/confidentialite'];
    for (const locale of ['fr-FR', 'en-US']) {
      const context = await newContext(browser, { locale });
      const page = await context.newPage();
      watch(context, page);
      const pages = [
        '/',
        '/guide',
        '/contact',
        '/confidentialite',
        '/auth/login',
        '/auth/register',
        '/auth/forgot-password',
        '/offline',
      ].map((p) =>
        locale === 'en-US' && bilingual.includes(p)
          ? p === '/'
            ? '/en'
            : `/en${p}`
          : p,
      );
      for (const p of pages) {
        const res = await page.goto(`${WEB}${p}`, { waitUntil: 'networkidle' });
        const info = await page.evaluate(() => ({
          lang: document.documentElement.lang,
          theme: document.documentElement.style.colorScheme,
          hydrated:
            !!(window.next && window.next.version) ||
            !!document.querySelector('[data-sonner-toaster]') ||
            true,
        }));
        const csp = res.headers()['content-security-policy'] || '';
        const v = await violations(page);
        record(
          `PUB ${locale} ${p}`,
          res.status() === 200 &&
            v.length === 0 &&
            info.theme !== '' &&
            csp.includes("'strict-dynamic'") &&
            info.lang === locale.slice(0, 2),
          {
            status: res.status(),
            lang: info.lang,
            themeScript: info.theme,
            violations: v,
          },
        );
      }
      // Hydratation réelle : la connexion est un formulaire React.
      await page.goto(`${WEB}/auth/login`);
      await page.fill('#email', 'inconnu@recette.local');
      await page.fill('#password', 'mauvais-mot-de-passe');
      await page.click('button[type=submit]');
      const alert = await page
        .locator('[role=alert]')
        .first()
        .waitFor({ timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      record(
        `PUB ${locale} connexion refusée affichée (React actif)`,
        alert && (await violations(page)).length === 0,
        { alert, console: context.__console },
      );
      await context.close();
    }
  },

  // Turnstile : script et iframe servis localement sous l'origine officielle.
  async TURNSTILE(browser) {
    const context = await newContext(browser);
    let scriptServed = 0;
    let frameServed = 0;
    await context.route('https://challenges.cloudflare.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('/turnstile/v0/api.js')) {
        scriptServed += 1;
        return route.fulfill({
          contentType: 'text/javascript',
          body: `window.turnstile={render:function(el,o){var f=document.createElement('iframe');f.src='https://challenges.cloudflare.com/cdn-cgi/challenge-platform/fake';f.title='turnstile';f.id='ts-frame';el.appendChild(f);setTimeout(function(){o.callback('fake-token')},50);return 'w1'},reset:function(){},remove:function(){}};`,
        });
      }
      frameServed += 1;
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><p id="ok">widget</p>',
      });
    });
    const page = await context.newPage();
    watch(context, page);
    await page.goto(`${WEB}/auth/register`, { waitUntil: 'networkidle' });
    const frame = await page
      .waitForSelector('#ts-frame', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    const inner = frame
      ? await page
          .frameLocator('#ts-frame')
          .locator('#ok')
          .textContent({ timeout: 5000 })
          .catch(() => null)
      : null;
    const v = await violations(page);
    record(
      'TURNSTILE script dynamique + iframe challenges.cloudflare.com',
      frame && inner === 'widget' && v.length === 0 && scriptServed === 1,
      {
        scriptServed,
        frameServed,
        inner,
        violations: v,
        console: context.__console,
      },
    );
    // Contre-épreuve : une iframe d'une autre origine est bloquée.
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = 'https://example.invalid/frame';
      document.body.appendChild(f);
    });
    await page.waitForTimeout(500);
    const v2 = await violations(page);
    record(
      'TURNSTILE iframe d’une autre origine bloquée',
      v2.some(
        (x) =>
          x.directive === 'frame-src' && /example\.invalid/.test(x.blocked),
      ),
      { violations: v2 },
    );
    await context.close();
  },

  // Catalogue, photos signées, temps réel, export.
  async APP(browser) {
    const token = await apiLogin(OWNER);
    const section = await L.http('POST', '/sections', {
      token,
      body: { name: `CSP ${Date.now()}` },
    });
    const product = await createProduct(
      token,
      section.body._id,
      `Photo CSP ${Date.now()}`,
    );
    const context = await newContext(browser);
    const page = await context.newPage();
    watch(context, page);
    const sockets = [];
    page.on('websocket', (ws) => {
      const s = { url: ws.url(), frames: 0 };
      ws.on('framereceived', () => (s.frames += 1));
      sockets.push(s);
    });
    await uiLogin(page, OWNER);
    await page.goto(`${WEB}/app/catalog/${section.body._id}`, {
      waitUntil: 'networkidle',
    });
    await page.getByText(product.name).first().waitFor({ timeout: 20000 });
    const img = await page
      .waitForFunction(
        () => {
          const i = [...document.images].find((x) =>
            /127\.0\.0\.1:4298/.test(x.currentSrc || x.src),
          );
          return i && i.complete && i.naturalWidth > 0
            ? { src: (i.currentSrc || i.src).slice(0, 60), w: i.naturalWidth }
            : null;
        },
        null,
        { timeout: 20000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    record(
      'APP photo signée affichée (stockage simulé)',
      !!img && (await violations(page)).length === 0,
      { img, violations: await violations(page) },
    );

    // Temps réel : un produit ajouté ailleurs apparaît sans rechargement.
    const before = sockets.reduce((n, s) => n + s.frames, 0);
    const second = await createProduct(
      token,
      section.body._id,
      `Temps réel CSP ${Date.now()}`,
    );
    const live = await page
      .getByText(second.name)
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const after = sockets.reduce((n, s) => n + s.frames, 0);
    record(
      'APP temps réel (Socket.IO ws://127.0.0.1:4200)',
      live &&
        sockets.some((s) =>
          s.url.startsWith('ws://127.0.0.1:4200/socket.io'),
        ) &&
        after > before,
      {
        live,
        sockets: sockets.map((s) => s.url.split('?')[0]),
        framesDuring: after - before,
        violations: await violations(page),
      },
    );

    // Aperçu local d'une photo (blob:) avant envoi.
    const blobOk = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      document.body.appendChild(img);
      await new Promise((r) => {
        img.onload = r;
        img.onerror = r;
      });
      return img.naturalWidth;
    });
    record(
      'APP aperçu blob: autorisé',
      blobOk === 8 && (await violations(page)).length === 0,
      { blobOk },
    );

    // Export mensuel (Excel) : téléchargement réel.
    await page.goto(`${WEB}/app/analytics`, { waitUntil: 'networkidle' });
    const button = page.getByRole('button', { name: /Télécharger en Excel/ });
    await button.waitFor({ timeout: 20000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      button.click(),
    ]);
    const file = await download.path();
    const size = require('fs').statSync(file).size;
    record(
      'APP export Excel téléchargé',
      size > 1000 && (await violations(page)).length === 0,
      {
        name: download.suggestedFilename(),
        size,
        violations: await violations(page),
        console: context.__console,
      },
    );
    await context.close();
  },

  // Paiement SasPay simulé : départ (même onglet), retour, reçu, impression.
  async PAY(browser) {
    execFileSync(
      process.execPath,
      [path.join(REPO, 'api/test/recipe/recipe.js'), 'provider', 'saspay'],
      { stdio: 'ignore' },
    );
    // Compte existant sans paiement ouvert (la création passerait par
    // l'inscription, qui exige ici le vrai Turnstile).
    const email = OWNER;
    const context = await newContext(browser);
    let departed = null;
    await context.route('https://pay.saspay.me/checkout/**', async (route) => {
      const slug = route
        .request()
        .url()
        .split('/checkout/')[1]
        .replace(/\/.*$/, '');
      departed = slug;
      const paid = await L.C.control('/sim/saspay/pay', {
        slug,
        outcome: 'SUCCESS',
        notify: true,
      });
      return route.fulfill({
        status: 302,
        headers: { location: paid.returnUrl },
      });
    });
    await context.addInitScript(() => {
      window.__printed = 0;
      window.print = () => {
        window.__printed += 1;
      };
    });
    const page = await context.newPage();
    watch(context, page);
    await uiLogin(page, email);
    await page.goto(`${WEB}/app/organization/subscription`);
    const panel = page.locator('[data-testid=subscription-payment-panel]');
    await panel.waitFor({ timeout: 20000 });
    const renew = page.getByRole('button', { name: 'Renouveler', exact: true });
    if (await renew.count()) await renew.click();
    await page
      .getByRole('radio', { name: /^1 mois/ })
      .click()
      .catch(() => {});
    await page.locator('[data-testid=payment-submit]').click();
    await page.waitForURL(/\/app\/organization\/subscription/, {
      timeout: 30000,
    });
    await page.waitForTimeout(1000);
    const verify = page.getByRole('button', { name: 'Vérifier le paiement' });
    if (await verify.count()) await verify.first().click();
    // Reçu ouvert depuis l'historique (paiement réussi).
    const open = page.locator('[data-testid=payment-receipt-open]').first();
    await open.waitFor({ timeout: 30000 }).catch(() => {});
    if (await open.count()) await open.click();
    const print = page.locator('[data-testid=payment-receipt-print]');
    const receipt = await print
      .waitFor({ timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (receipt) await print.click();
    await page.emulateMedia({ media: 'print' });
    const printView = await page
      .evaluate(() => ({
        printed: window.__printed,
        buttonHidden:
          getComputedStyle(
            document.querySelector('[data-testid=payment-receipt-print]')
              .parentElement,
          ).display === 'none',
      }))
      .catch((e) => ({ error: String(e) }));
    await page.emulateMedia({ media: 'screen' });
    const v = await violations(page);
    record(
      'PAY départ SasPay simulé, retour, reçu, impression',
      !!departed &&
        receipt &&
        printView.printed === 1 &&
        printView.buttonHidden &&
        v.length === 0,
      {
        email,
        departed: !!departed,
        url: page.url().replace(WEB, ''),
        receipt,
        printView,
        violations: v,
        console: context.__console,
      },
    );
    await context.close();
    execFileSync(
      process.execPath,
      [path.join(REPO, 'api/test/recipe/recipe.js'), 'provider', 'simulated'],
      { stdio: 'ignore' },
    );
  },

  // Navigation Next.js côté client (sans rechargement) vers des routes dont
  // le JS n'est pas encore chargé : les préchargements du routeur sont
  // refusés, les chunks de la cible ne sont donc demandés qu'au clic.
  async NAV(browser) {
    const context = await newContext(browser);
    await context.route(`${WEB}/**`, (route) =>
      route.request().headers()['next-router-prefetch']
        ? route.abort()
        : route.continue(),
    );
    const page = await context.newPage();
    watch(context, page);
    const scripts = () =>
      page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => /\/_next\/static\/.+\.js/.test(n)),
      );
    // Marqueur posé dans la page : il disparaît si le document est rechargé.
    const sameDocument = () =>
      page.evaluate(() => window.__navMarker === 1).catch(() => false);
    const clientNavigate = async (label, click, urlPattern, ready) => {
      const before = new Set(await scripts());
      await page.evaluate(() => {
        window.__navMarker = 1;
      });
      await click();
      await page.waitForURL(urlPattern, { timeout: 20000 });
      await ready();
      const loaded = (await scripts()).filter((s) => !before.has(s));
      const v = await violations(page);
      const kept = await sameDocument();
      record(`NAV ${label}`, kept && loaded.length > 0 && v.length === 0, {
        url: page.url().replace(WEB, ''),
        sameDocument: kept,
        newChunks: loaded.length,
        violations: v,
      });
    };

    // Page publique → connexion, puis interaction (formulaire React).
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
    await clientNavigate(
      'publique → connexion (sans rechargement)',
      () => page.locator('a[href="/auth/login"]').first().click(),
      `${WEB}/auth/login`,
      () => page.locator('#email').waitFor({ timeout: 20000 }),
    );
    await page.fill('#email', 'inconnu@recette.local');
    await page.fill('#password', 'mauvais-mot-de-passe');
    await page.click('button[type=submit]');
    const alert = await page
      .locator('[role=alert]')
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    record(
      'NAV connexion interactive après navigation',
      alert && (await sameDocument()) && (await violations(page)).length === 0,
      { alert },
    );

    // Navigation entre pages de l'application.
    const token = await apiLogin(OWNER);
    const sectionName = `Navigation ${Date.now()}`;
    const section = await L.http('POST', '/sections', {
      token,
      body: { name: sectionName },
    });
    await page.fill('#email', OWNER);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    // Invitation à activer les notifications (fenêtre modale) : « Plus tard ».
    const later = page.getByRole('button', { name: 'Plus tard' });
    if (
      await later
        .first()
        .waitFor({ timeout: 10000 })
        .then(() => true)
        .catch(() => false)
    )
      await later.first().click();
    await clientNavigate(
      'application : accueil → catalogue',
      () => page.locator('a[href="/app/catalog"]:visible').first().click(),
      `${WEB}/app/catalog`,
      () => page.getByText(sectionName).first().waitFor({ timeout: 20000 }),
    );
    await clientNavigate(
      'application : catalogue → ventes',
      () => page.locator('a[href="/app/sales"]:visible').first().click(),
      `${WEB}/app/sales`,
      () => page.waitForLoadState('networkidle'),
    );
    // Précédent : même document, catalogue rendu et interactif.
    await page.evaluate(() => {
      window.__navMarker = 1;
    });
    await page.goBack();
    await page.waitForURL(`${WEB}/app/catalog`, { timeout: 20000 });
    const backList = await page
      .getByText(sectionName)
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const backSame = await sameDocument();
    await page.getByText(sectionName).first().click();
    const opened = await page
      .waitForURL(`${WEB}/app/catalog/${section.body._id}`, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const v = await violations(page);
    record(
      'NAV précédent → catalogue, puis ouverture d’un rayon',
      backList &&
        backSame &&
        opened &&
        (await sameDocument()) &&
        v.length === 0,
      { backList, backSame, opened, violations: v, console: context.__console },
    );
    await context.close();
  },

  // Script injecté dans le HTML (XSS simulée) : bloqué par la politique.
  async BLOCK(browser) {
    const context = await newContext(browser);
    await context.route(`${WEB}/guide`, async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        '</head>',
        '<script>window.__pwnedInline=1</script><script src="https://evil.invalid/x.js"></script><script nonce="devine">window.__pwnedNonce=1</script></head>',
      );
      return route.fulfill({ response, body: html });
    });
    const page = await context.newPage();
    watch(context, page);
    const res = await page.goto(`${WEB}/guide`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<img src="data:," onerror="window.__pwnedHandler=1">';
      document.body.appendChild(d);
    });
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      inline: window.__pwnedInline || 0,
      nonce: window.__pwnedNonce || 0,
      handler: window.__pwnedHandler || 0,
      theme: document.documentElement.style.colorScheme,
    }));
    const v = await violations(page);
    const header = res.headers()['content-security-policy']
      ? 'Content-Security-Policy'
      : res.headers()['content-security-policy-report-only']
        ? 'Report-Only'
        : 'aucun';
    record(
      'BLOCK scripts injectés non exécutés (politique appliquée)',
      header === 'Content-Security-Policy' &&
        state.inline === 0 &&
        state.nonce === 0 &&
        state.handler === 0 &&
        state.theme !== '' &&
        v.filter((x) => x.disposition === 'enforce').length >= 3,
      {
        header,
        state,
        violations: v.map(
          (x) => `${x.directive} ${x.blocked} ${x.disposition}`,
        ),
      },
    );
    await context.close();
  },

  // PWA : installation, CSP des copies, hors ligne, mise à jour, retour réseau.
  async PWA(browser) {
    const context = await newContext(browser, { serviceWorkers: 'allow' });
    // Mise à jour réelle : le serveur de la copie isolée sert d'abord le
    // sw.js de la base (HEAD), puis celui du dépôt, comme un déploiement.
    // Versions lues dans les fichiers (CACHE_VERSION).
    const fs = require('fs');
    const servedSw = path.join(REPO, '.stockmaster-recipe-web/public/sw.js');
    const newSw = fs.readFileSync(path.join(REPO, 'web/public/sw.js'));
    const baseSw = execFileSync('git', [
      '-C',
      REPO,
      'show',
      'HEAD:web/public/sw.js',
    ]);
    const swVersion = (buf) =>
      (/const CACHE_VERSION = "(v\d+)"/.exec(String(buf)) || [])[1];
    const oldV = swVersion(baseSw);
    const newV = swVersion(newSw);
    fs.writeFileSync(servedSw, baseSw);
    try {
      const page = await context.newPage();
      watch(context, page);
      const token = await apiLogin(OWNER);
      const sectionName = `Hors ligne ${Date.now()}`;
      const section = await L.http('POST', '/sections', {
        token,
        body: { name: sectionName },
      });
      const product = await createProduct(
        token,
        section.body._id,
        `Hors ligne CSP ${Date.now()}`,
      );
      await uiLogin(page, OWNER);
      // Attente active : version installée, ACTIVE et contrôlant la page.
      const swReady = async (version) => {
        for (let i = 0; i < 90; i++) {
          const st = await page
            .evaluate(async (v) => {
              const reg = await navigator.serviceWorker.getRegistration();
              return (
                (await caches.keys()).includes(`stockmaster-pages-${v}`) &&
                !!reg &&
                !reg.installing &&
                !reg.waiting &&
                !!reg.active &&
                !!navigator.serviceWorker.controller
              );
            }, version)
            .catch(() => false);
          if (st) return true;
          await page.waitForTimeout(1000);
        }
        return false;
      };
      const v5 = await swReady(oldV);
      record(`PWA ancienne version ${oldV} installée (base)`, v5, {
        keys: await page.evaluate(() => caches.keys()),
      });

      // Mise à jour : la nouvelle version (dépôt) remplace la base.
      fs.writeFileSync(servedSw, newSw);
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration()).update(),
      );
      const v6 = await swReady(newV);
      // Purge des anciens caches : asynchrone, pendant l'activation.
      let keys = [];
      for (let i = 0; i < 30; i++) {
        keys = await page.evaluate(() => caches.keys());
        if (!keys.some((k) => k.endsWith(`-${oldV}`))) break;
        await page.waitForTimeout(1000);
      }
      const stored = await page.evaluate(async (v) => {
        const cache = await caches.open(`stockmaster-pages-${v}`);
        const out = {};
        for (const p of ['/guide', '/offline', '/']) {
          const r =
            (await cache.match(`${location.origin}${p}?__sw_locale=fr`)) ||
            (await cache.match(`${location.origin}${p}?__sw_locale=en`));
          if (!r) {
            out[p] = null;
            continue;
          }
          const csp = r.headers.get('Content-Security-Policy') || '';
          const html = await r.text();
          const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
          out[p] = {
            csp: !!csp,
            nonceInHtml: !!nonce && html.includes(`nonce="${nonce}"`),
          };
        }
        const shell = await (
          await caches.open(`stockmaster-${v}`)
        ).match('/app/catalog');
        out.shell = shell
          ? !!shell.headers.get('Content-Security-Policy')
          : null;
        return out;
      }, newV);
      record(
        `PWA mise à jour ${oldV} → ${newV}, anciens caches purgés, copies avec leur CSP`,
        v6 &&
          !keys.includes(`stockmaster-pages-${oldV}`) &&
          Object.values(stored).every(
            (x) => x === true || (x && x.csp && x.nonceInHtml),
          ),
        { keys, stored },
      );

      // Catalogue en ligne (instantané local), puis hors ligne.
      await page.goto(`${WEB}/app/catalog/${section.body._id}`, {
        waitUntil: 'networkidle',
      });
      await page.getByText(product.name).first().waitFor({ timeout: 20000 });
      await page.goto(`${WEB}/app/catalog`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      await context.setOffline(true);

      await page.goto(`${WEB}/guide`).catch(() => {});
      const guide = await page
        .evaluate(() => ({
          offlineCopy:
            document.documentElement.getAttribute('data-offline-copy'),
          theme: document.documentElement.style.colorScheme,
          title: document.title,
        }))
        .catch((e) => ({ error: String(e) }));
      const guideNotice = await page
        .getByText(/version enregistrée|saved version|copie enregistrée/i)
        .first()
        .waitFor({ timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      const offlineEnforced = await page.evaluate(async () => {
        const d = document.createElement('div');
        d.innerHTML = '<img src="data:," onerror="window.__pwnedOffline=1">';
        document.body.appendChild(d);
        await new Promise((r) => setTimeout(r, 300));
        return {
          executed: window.__pwnedOffline || 0,
          violations: (window.__csp || []).filter(
            (x) => x.directive === 'script-src-attr',
          ).length,
        };
      });
      record(
        'PWA hors ligne : la copie enregistrée APPLIQUE sa CSP',
        offlineEnforced.executed === 0 && offlineEnforced.violations === 1,
        offlineEnforced,
      );
      await page.evaluate(() => {
        window.__csp = [];
      });
      record(
        'PWA hors ligne : page publique enregistrée, scripts autorisés',
        !!guide.offlineCopy &&
          guide.theme !== '' &&
          guideNotice &&
          (await violations(page)).length === 0,
        { guide, notice: guideNotice, violations: await violations(page) },
      );

      await page.goto(`${WEB}/app`).catch(() => {});
      await page
        .waitForURL(`${WEB}/app/catalog`, { timeout: 20000 })
        .catch(() => {});
      await page
        .getByText(sectionName)
        .first()
        .click({ timeout: 20000 })
        .catch(() => {});
      const offlineCatalog = await page
        .getByText(product.name)
        .first()
        .waitFor({ timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      record(
        'PWA lancement hors ligne (/app → catalogue hors ligne)',
        page.url() === `${WEB}/app/catalog` &&
          offlineCatalog &&
          (await violations(page)).length === 0,
        {
          url: page.url().replace(WEB, ''),
          offlineCatalog,
          violations: await violations(page),
          console: context.__console.slice(-5),
        },
      );

      await page.goto(`${WEB}/app/sales`).catch(() => {});
      const offlineScreen = await page
        .evaluate(
          () =>
            location.pathname +
            ' ' +
            (document.body.innerText || '').slice(0, 80),
        )
        .catch(() => '');
      record(
        'PWA page non préparée hors ligne → écran hors ligne',
        (await violations(page)).length === 0,
        { offlineScreen },
      );

      // Retour du réseau : document neuf, nouveau nonce.
      await context.setOffline(false);
      const res = await page.goto(`${WEB}/guide`, { waitUntil: 'networkidle' });
      const back = await page.evaluate(() => ({
        offlineCopy: document.documentElement.getAttribute('data-offline-copy'),
        theme: document.documentElement.style.colorScheme,
      }));
      record(
        'PWA retour du réseau',
        res.status() === 200 &&
          !back.offlineCopy &&
          back.theme !== '' &&
          (await violations(page)).length === 0,
        { back },
      );
      await context.close();
    } finally {
      fs.writeFileSync(servedSw, newSw);
    }
  },
};

(async () => {
  const pw = L.loadPlaywright();
  if (pw.error) throw new Error(pw.error);
  const browser = await pw.playwright.chromium.launch({
    executablePath: pw.executable,
  });
  try {
    for (const [id, run] of Object.entries(scenarios)) {
      if (only.length && !only.includes(id)) continue;
      try {
        await run(browser);
      } catch (error) {
        record(`${id} (exception)`, false, String(error).slice(0, 400));
      }
    }
  } finally {
    await browser.close();
    await L.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} réussis (Playwright ${pw.version})`,
  );
  if (process.env.RECIPE_OUT) {
    require('fs').writeFileSync(
      path.join(process.env.RECIPE_OUT, 'csp-results.json'),
      JSON.stringify(results, null, 2),
    );
  }
  process.exit(failed ? 1 : 0);
})();
