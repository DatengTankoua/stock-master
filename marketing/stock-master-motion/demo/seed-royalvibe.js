#!/usr/bin/env node
/**
 * Lot 1-23A — Peuplement REPRODUCTIBLE de RoyalVibe Cosmétique (démonstration).
 *
 * Préalable : pile de démonstration démarrée avec le profil `motion-23a` et
 * le fournisseur SasPay SIMULÉ :
 *   RECIPE_PROFILE=motion-23a node api/test/recipe/recipe.js start --provider=saspay
 * Les comptes (propriétaire, administratrice, deux vendeurs) sont créés au
 * premier démarrage par les services réels (`seed-fixtures.js`).
 *
 * Ce script passe ensuite par l'API RÉELLE (127.0.0.1) :
 *   1. identité visuelle : logo RoyalVibe original (octets inchangés) et couleur ;
 *   2. droits des vendeurs ;
 *   3. rayons, puis produits avec photo (stockage simulé) ;
 *   4. abonnement annuel payé par le SasPay SIMULÉ (aucun paiement réel) ;
 *   5. historique : ventes datées sur 13 jours (`occurredAt`, plage admise
 *      par l'API : 14 jours), enregistrées par chaque vendeur ;
 *   6. un réassort par le vendeur qui a le droit « Ajuster le stock ».
 * Seule écriture directe (test, documentée, `alignTimeline`) : les
 * HORODATAGES. L'API enregistre la date réelle d'une vente (`occurredAt`)
 * mais date son enregistrement (`createdAt`) au moment du peuplement ; les
 * listes l'affichent. Ils sont alignés comme si chaque vente avait été
 * saisie le jour même, ainsi que le journal, les dates de création du
 * commerce, des rayons et des produits. Les notifications produites en masse
 * par le peuplement (et un bilan d'un mois antérieur au commerce) sont
 * retirées. Aucune quantité ni aucun montant n'est écrit hors de l'API.
 * `--align-timeline` rejoue seulement cette étape.
 *
 * Garde : la cible MongoDB et l'API sont celles du profil `motion-23a`
 * (`assertRecipeUri` : 127.0.0.1:27230, base stockmaster_motion_23a). Le
 * script refuse une base déjà peuplée (rayons existants).
 *
 * Usage : node marketing/stock-master-motion/demo/seed-royalvibe.js [--logo=<chemin>]
 */
'use strict';

process.env.RECIPE_PROFILE = 'motion-23a';
const RECIPE = '../../../api/test/recipe';
require(`${RECIPE}/preload.cjs`);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require(`${RECIPE}/recipe-common`);
const D = require(`${RECIPE}/db-tools`);
const { ACCOUNTS } = require(`${RECIPE}/fixtures`);
const {
  SECTIONS,
  PRODUCTS,
  SELLER_PERMISSIONS,
  BRAND_COLOR,
} = require('./catalog');

const PHOTOS = path.resolve(__dirname, '../media/photos');
const DEFAULT_LOGO = path.join(
  process.env.USERPROFILE || '',
  'Downloads',
  'royalvibe-logo.jpeg',
);
const DAY = 86_400_000;
const HISTORY_DAYS = 13;

const account = (key) => ACCOUNTS.find((a) => a.key === key);
const say = (line) => process.stdout.write(`[royalvibe] ${line}\n`);

function flags() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function expectOk(label, response, statuses = [200, 201]) {
  if (!statuses.includes(response.status)) {
    throw new Error(
      `${label} : HTTP ${response.status} ${String(response.text).slice(0, 300)}`,
    );
  }
  return response.body;
}

async function login(email) {
  const res = await C.api('POST', '/auth/login', {
    body: { email, password: C.PASSWORD },
  });
  const body = await expectOk(`connexion ${email}`, res, [200, 201]);
  if (!body || !body.access_token)
    throw new Error(`connexion ${email} : jeton absent`);
  return body.access_token;
}

/** Requête multipart (fichier + champs) vers l'API locale. */
async function multipart(method, url, token, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (file) {
    const bytes = fs.readFileSync(file.path);
    form.append(
      file.field,
      new Blob([bytes], { type: file.type }),
      path.basename(file.path),
    );
  }
  const response = await fetch(`${C.API_URL}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // corps non JSON
  }
  return { status: response.status, body, text };
}

function preflight(logoPath) {
  const missing = PRODUCTS.filter(
    (p) => !fs.existsSync(path.join(PHOTOS, p.photo)),
  ).map((p) => p.photo);
  if (missing.length)
    throw new Error(`Photos absentes de media/photos : ${missing.join(', ')}`);
  if (!fs.existsSync(logoPath))
    throw new Error(
      `Logo RoyalVibe introuvable : ${logoPath} (préciser --logo=<chemin>)`,
    );
}

async function main() {
  const options = flags();
  const logoPath = path.resolve(options.logo || DEFAULT_LOGO);
  preflight(logoPath);

  const state = C.requireRunningState(); // URI revalidée par la garde
  if (options['align-timeline']) {
    await alignTimeline(state, await login(account('owner').email));
    return;
  }
  if (C.PROFILE_NAME !== 'motion-23a' || new URL(C.API_URL).port !== '4230')
    throw new Error('Profil de démonstration inattendu.');
  if (state.provider !== 'saspay')
    throw new Error(
      'Démarrer la pile avec --provider=saspay (paiement SasPay simulé).',
    );

  const tokens = {};
  for (const a of ACCOUNTS) tokens[a.key] = await login(a.email);
  const owner = tokens.owner;

  const existing = await expectOk(
    'rayons',
    await C.api('GET', '/sections', { token: owner }),
  );
  if (Array.isArray(existing) && existing.length > 0)
    throw new Error(
      'Base déjà peuplée (rayons existants). Réinitialiser : motion-demo.js reset',
    );

  // 1. Identité visuelle : logo ORIGINAL, octets inchangés.
  say('logo et couleur de RoyalVibe …');
  await expectOk(
    'identité visuelle',
    await multipart(
      'PATCH',
      '/organizations/current/branding',
      owner,
      { brandColor: BRAND_COLOR },
      { field: 'logo', path: logoPath, type: 'image/jpeg' },
    ),
  );

  // 2. Droits des vendeurs.
  say('droits des vendeurs …');
  const members = await expectOk(
    'membres',
    await C.api('GET', '/organizations/members', { token: owner }),
  );
  const list = Array.isArray(members) ? members : members.items || [];
  for (const [key, permissions] of Object.entries(SELLER_PERMISSIONS)) {
    const email = account(key).email;
    const member = list.find(
      (m) => (m.user && m.user.email) === email || m.email === email,
    );
    if (!member) throw new Error(`membre introuvable : ${email}`);
    await expectOk(
      `droits ${email}`,
      await C.api(
        'PATCH',
        `/organizations/members/${member.membershipId}?permissionsCatalog=2`,
        { token: owner, body: { permissions } },
      ),
    );
  }

  // 3. Rayons et produits (photos réelles, stockage simulé).
  say('rayons et produits …');
  const sectionIds = {};
  for (const s of SECTIONS) {
    const created = await expectOk(
      `rayon ${s.name}`,
      await C.api('POST', '/sections', {
        token: owner,
        body: { name: s.name, description: s.description },
      }),
    );
    sectionIds[s.key] = String(created._id || created.id);
  }
  const productIds = {};
  for (const p of PRODUCTS) {
    const created = await expectOk(
      `produit ${p.name}`,
      await multipart(
        'POST',
        '/products',
        owner,
        {
          sectionId: sectionIds[p.section],
          name: p.name,
          purchasePrice: p.purchase,
          salePrice: p.sale,
          initialQuantity: p.qty,
        },
        {
          field: 'image',
          path: path.join(PHOTOS, p.photo),
          type: 'image/jpeg',
        },
      ),
    );
    productIds[p.key] = String(created._id || created.id);
  }

  // 4. Abonnement annuel par le SasPay SIMULÉ.
  say('abonnement annuel (SasPay simulé) …');
  const payment = await expectOk(
    'paiement',
    await C.api('POST', '/organizations/current/subscription/payments', {
      token: owner,
      body: { term: 'annual', clientOperationId: crypto.randomUUID() },
    }),
  );
  const checkout = payment.checkoutUrl || payment.providerCheckoutUrl;
  const slug = checkout && /\/checkout\/([^/?#]+)/.exec(checkout);
  if (!slug) throw new Error('paiement : page SasPay simulée absente');
  await C.control('/sim/saspay/pay', {
    slug: slug[1],
    outcome: 'SUCCESS',
    notify: true,
  });
  const paymentId = payment.id || payment._id || payment.paymentId;
  if (paymentId) {
    await C.api(
      'POST',
      `/organizations/current/subscription/payments/${paymentId}/refresh`,
      { token: owner },
    );
  }

  // 5. Historique de ventes (déterministe).
  say('historique de ventes …');
  const random = prng(23);
  const remaining = Object.fromEntries(PRODUCTS.map((p) => [p.key, p.qty]));
  const sellers = [
    ['sellerStock', 0.4],
    ['sellerBasic', 0.35],
    ['admin', 0.15],
    ['owner', 0.1],
  ];
  const pickSeller = () => {
    let r = random();
    for (const [key, share] of sellers) {
      if ((r -= share) <= 0) return key;
    }
    return 'owner';
  };
  const totalWeight = PRODUCTS.reduce((t, p) => t + p.weight, 0);
  const pickProduct = () => {
    let r = random() * totalWeight;
    for (const p of PRODUCTS) if ((r -= p.weight) <= 0) return p;
    return PRODUCTS[0];
  };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let count = 0;
  let amount = 0;
  for (let d = HISTORY_DAYS; d >= 1; d--) {
    // Plus d'activité en fin de semaine (samedi), sans dimanche vide.
    const day = new Date(today.getTime() - d * DAY);
    const weekday = day.getUTCDay();
    const n = 6 + Math.floor(random() * 6) + (weekday === 6 ? 4 : 0);
    const times = Array.from(
      { length: n },
      // 08:00–19:30 heure de Douala (UTC+1).
      () => day.getTime() + (7 * 60 + Math.floor(random() * 690)) * 60_000,
    ).sort((a, b) => a - b);
    for (const at of times) {
      const p = pickProduct();
      const quantity = random() < 0.75 ? 1 : random() < 0.8 ? 2 : 3;
      const floor = p.floor ?? 3;
      if (remaining[p.key] - quantity < floor) continue;
      const seller = pickSeller();
      await expectOk(
        `vente ${p.name}`,
        await C.api('POST', '/sales', {
          token: tokens[seller],
          body: {
            productId: productIds[p.key],
            quantity,
            salePrice: p.sale,
            clientOperationId: crypto.randomUUID(),
            occurredAt: new Date(at).toISOString(),
          },
        }),
      );
      remaining[p.key] -= quantity;
      count += 1;
      amount += quantity * p.sale;
    }
  }

  // 6. Réassort par le vendeur qui a le droit « Ajuster le stock ».
  say('réassort (vendeur avec droit « Ajuster le stock ») …');
  await expectOk(
    'réassort',
    await multipart(
      'PATCH',
      `/products/${productIds['lait-karite']}`,
      tokens.sellerStock,
      { additionalStock: 12 },
    ),
  );
  remaining['lait-karite'] += 12;

  // 7. Chronologie : horodatages alignés sur deux semaines d'usage.
  await alignTimeline(state, owner);

  const summary = {
    sections: SECTIONS.length,
    products: PRODUCTS.length,
    sales: count,
    salesAmountXaf: amount,
    lowStock: PRODUCTS.filter((p) => remaining[p.key] <= p.qty * 0.2).map(
      (p) => `${p.name} (${remaining[p.key]})`,
    ),
    remaining,
  };
  fs.writeFileSync(
    path.join(C.PERSISTENT.root, 'seed-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  say(`terminé : ${JSON.stringify({ ...summary, remaining: undefined })}`);
}

/**
 * Écriture de TEST (horodatages seulement), limitée au commerce RoyalVibe.
 * Début de l'historique : il y a 13 jours, 06:00 à Douala (05:00 UTC).
 */
async function alignTimeline(state, ownerToken) {
  say('chronologie : horodatages alignés sur les dates réelles …');
  const { Types } = C.apiRequire('mongoose');
  const orgId = new Types.ObjectId(
    JSON.parse(
      Buffer.from(ownerToken.split('.')[1], 'base64url').toString('utf8'),
    ).orgId,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const opening = new Date(today.getTime() - HISTORY_DAYS * DAY + 5 * 3_600_000);
  const connection = await D.connect(state.mongodbUri);
  try {
    const db = connection.db;
    const scope = { organizationId: orgId };
    await db
      .collection('organizations')
      .updateOne({ _id: orgId }, { $set: { createdAt: opening } });
    await db
      .collection('sections')
      .updateMany(scope, { $set: { createdAt: opening } });
    const productsAt = new Date(opening.getTime() + 30 * 60_000);
    await db
      .collection('products')
      .updateMany(scope, { $set: { createdAt: productsAt } });
    await db
      .collection('auditlogs')
      .updateMany(
        { ...scope, action: 'created' },
        { $set: { createdAt: productsAt } },
      );
    let aligned = 0;
    const sales = await db
      .collection('sales')
      .find({ ...scope, occurredAt: { $ne: null } })
      .toArray();
    for (const sale of sales) {
      await db
        .collection('sales')
        .updateOne({ _id: sale._id }, { $set: { createdAt: sale.occurredAt } });
      await db
        .collection('auditlogs')
        .updateMany(
          { ...scope, action: 'sold', 'details.saleId': sale._id },
          { $set: { createdAt: sale.occurredAt } },
        );
      await db
        .collection('auditlogs')
        .updateMany(
          { ...scope, action: 'sold', 'details.saleId': String(sale._id) },
          { $set: { createdAt: sale.occurredAt } },
        );
      aligned += 1;
    }
    const notifications = await db
      .collection('notifications')
      .deleteMany(scope);
    const jobs = await db.collection('push_jobs').deleteMany(scope);
    const reports = await db.collection('monthly_reports').deleteMany({
      ...scope,
      period: { $lt: opening.toISOString().slice(0, 7) },
    });
    say(
      `chronologie : ${aligned} ventes alignées ; retirés : ${notifications.deletedCount} notifications, ${jobs.deletedCount} envois push simulés, ${reports.deletedCount} bilan(s) antérieur(s).`,
    );
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(`[royalvibe] ÉCHEC : ${error.message}`);
  process.exit(1);
});
