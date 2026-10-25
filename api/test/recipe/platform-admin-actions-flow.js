/**
 * Recette isolée — actions de l'administration de la plateforme, par le
 * serveur web de la recette (BFF `/api/admin`, cookie HttpOnly) :
 *
 *   attribution + capacités (commande opérateur réelle) → enrôlement →
 *   aperçu et prolongation offerte (preuve liée, rejeu idempotent) →
 *   suspension (connexion du commerce : espace limité, autres commerces
 *   intacts) → réactivation → audit → révocation.
 *
 * Usage : `recipe.js start --platform-admin`, puis
 * `recipe.js platform-admin-actions-flow`. Comptes et clés FICTIFS, base
 * éphémère. Administrateur : `admin.actif@recette.local` ; commerce visé :
 * celui de `proprietaire.revue@recette.local`. Relançable (remise à zéro au
 * début). Sortie : JSON des étapes ; code 1 au premier écart.
 */
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const C = require('./recipe-common');
const D = require('./db-tools');

const ADMIN_EMAIL = 'admin.actif@recette.local';
const TARGET_OWNER = 'proprietaire.revue@recette.local';
const REASON = 'Recette locale des actions administratives';

function cookieJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    store(lines) {
      for (const line of lines) {
        const [pair, ...attributes] = line.split(';');
        const [name, value] = pair.split('=');
        const expired = attributes.some((a) => /max-age=0/i.test(a.trim()));
        if (expired || value === '') jar.delete(name.trim());
        else jar.set(name.trim(), value);
      }
    },
    size: () => jar.size,
  };
}

function request(base, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${base}${route}`,
      {
        method,
        agent: false,
        headers: {
          ...headers,
          ...(payload !== null
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : null,
            setCookie: res.headers['set-cookie'] ?? [],
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function main() {
  const state = C.requireRunningState();
  const { Secret, TOTP } = C.apiRequire('otpauth');
  const jar = cookieJar();
  const steps = [];
  const check = (condition, label, detail) => {
    steps.push({ step: label, ok: Boolean(condition), ...(condition ? {} : { detail }) });
    if (!condition) {
      console.log(JSON.stringify({ result: 'failed', steps }, null, 2));
      process.exit(1);
    }
  };
  const admin = async (method, route, body) => {
    const res = await request(C.WEB_ORIGIN, method, `/api/admin/${route}`, body, {
      'x-stockmaster-admin': '1',
      ...(method === 'POST' ? { origin: C.WEB_ORIGIN } : {}),
      ...(jar.size() ? { cookie: jar.header() } : {}),
    });
    jar.store(res.setCookie);
    return res;
  };
  const cli = (...args) => {
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, 'recipe.js'), 'platform-admin', ...args],
      { encoding: 'utf8', env: process.env },
    );
    const line = r.stdout.trim().split('\n').pop() ?? '';
    return line.startsWith('{') ? JSON.parse(line) : null;
  };
  const withDb = async (fn) => {
    const connection = await D.connect(state.mongodbUri);
    try {
      return await fn(connection.db);
    } finally {
      await connection.close();
    }
  };

  // 0. Remise à zéro (relance) par les commandes réelles.
  const initial = cli('status', `--email=${ADMIN_EMAIL}`);
  if (initial?.access === 'active') {
    cli('revoke', `--email=${ADMIN_EMAIL}`, '--reason=Relance de la recette locale', '--operator=recette', '--apply');
  }
  if (initial?.mfa === 'active') {
    cli('reset-mfa', `--email=${ADMIN_EMAIL}`, '--reason=Relance de la recette locale', '--operator=recette', '--identity-check=recette-locale', '--apply');
  }
  const target = await withDb((db) => D.account(db, TARGET_OWNER));
  const organizationId = target.memberships.find((m) => m.role === 'owner').organizationId;
  await withDb((db) =>
    db.collection('organizations').updateOne(
      { _id: new (C.apiRequire('mongoose').Types.ObjectId)(organizationId), status: 'suspended' },
      { $set: { status: 'active', suspension: null } },
    ),
  );

  // 1. Attribution (lecture seule par défaut), puis capacités une par une.
  const granted = cli('grant', `--email=${ADMIN_EMAIL}`, `--reason=${REASON}`, '--operator=recette', '--apply');
  check(granted?.result === 'granted' && granted.capabilities.join() === 'platform.read', 'attribution : lecture seule', granted);
  for (const capability of ['platform.organizations.suspend', 'platform.subscriptions.extend']) {
    const dry = cli('capability-add', `--email=${ADMIN_EMAIL}`, `--capability=${capability}`, `--reason=${REASON}`, '--operator=recette');
    check(dry?.result === 'dry-run:capability-add', `capacité ${capability} : lecture seule`, dry);
    const added = cli('capability-add', `--email=${ADMIN_EMAIL}`, `--capability=${capability}`, `--reason=${REASON}`, '--operator=recette', '--apply');
    check(added?.result === 'capability-added', `capacité ${capability} accordée`, added);
  }

  // 2. Connexion et enrôlement.
  const login = await admin('POST', 'auth/login', { email: ADMIN_EMAIL, password: C.PASSWORD });
  check(login.status === 200 && login.body.stage === 'enroll', 'connexion : enrôlement', login.body);
  const start = await admin('POST', 'mfa/enrollment/start');
  const totp = new TOTP({ secret: Secret.fromBase32(start.body.manualKey.replace(/ /g, '')), digits: 6, period: 30, algorithm: 'SHA1' });
  const confirm = await admin('POST', 'mfa/enrollment/confirm', { challengeToken: start.body.challenge.token, code: totp.generate() });
  check(confirm.status === 200, 'enrôlement confirmé', confirm.body);
  const recovery = [...confirm.body.recoveryCodes];
  const status = await admin('GET', 'auth/status');
  check(status.body.capabilities?.length === 3, 'capacités visibles par l’interface', status.body);

  // Preuve renforcée liée : code de récupération (aucune attente de pas TOTP).
  const stepUp = async (intent) => {
    const res = await admin('POST', 'security/step-up', { password: C.PASSWORD, recoveryCode: recovery.shift(), intent });
    check(res.status === 200, `preuve liée : ${intent.action}`, res.body);
    return res.body.stepUpToken;
  };

  // 3. Prolongation offerte.
  const preview = await admin('GET', `organizations/${organizationId}/extension-preview?days=7`);
  check(preview.status === 200 && preview.body.plan.ok, 'aperçu de la prolongation', preview.body);
  const extend = {
    action: 'subscription_extend',
    organizationId,
    operationId: randomUUID(),
    days: 7,
    reason: REASON,
    expectedCoverageEndsAt: preview.body.plan.previousCoverageEndsAt,
  };
  const extendBody = (token) => ({
    operationId: extend.operationId,
    stepUpToken: token,
    days: 7,
    reason: REASON,
    expectedCoverageEndsAt: extend.expectedCoverageEndsAt,
  });
  const token = await stepUp(extend);
  const tampered = await admin('POST', `organizations/${organizationId}/extend`, { ...extendBody(token), days: 8 });
  check(tampered.status === 403, 'contenu modifié après confirmation : refus', tampered.body);
  const extended = await admin('POST', `organizations/${organizationId}/extend`, extendBody(token));
  check(extended.status === 200 && extended.body.result.source === 'offered', 'prolongation appliquée', extended.body);
  const replay = await admin('POST', `organizations/${organizationId}/extend`, extendBody(token));
  check(replay.status === 200 && replay.body.replayed === true, 'rejeu : résultat existant, aucun second effet', replay.body);

  // 4. Suspension, vue par le commerce.
  const suspend = {
    action: 'organization_suspend',
    organizationId,
    operationId: randomUUID(),
    internalReason: 'Recette : motif interne jamais montré au commerce',
    clientMessage: 'Recette : votre commerce est suspendu, contactez le support.',
  };
  const suspended = await admin('POST', `organizations/${organizationId}/suspend`, {
    operationId: suspend.operationId,
    stepUpToken: await stepUp(suspend),
    internalReason: suspend.internalReason,
    clientMessage: suspend.clientMessage,
  });
  check(suspended.status === 200, 'suspension appliquée', suspended.body);
  const ownerLogin = await request(C.API_URL, 'POST', '/auth/login', { email: TARGET_OWNER, password: C.PASSWORD, organizationId }, { origin: C.WEB_ORIGIN });
  check(
    ownerLogin.status === 403 &&
      ownerLogin.body.code === 'ORGANIZATION_SUSPENDED' &&
      ownerLogin.body.suspension.message === suspend.clientMessage &&
      !JSON.stringify(ownerLogin.body).includes('motif interne') &&
      !ownerLogin.body.access_token,
    'propriétaire : espace limité, message client seul',
    ownerLogin.body,
  );
  const detail = await admin('GET', `organizations/${organizationId}`);
  check(
    detail.body.suspension?.internalReason === suspend.internalReason &&
      detail.body.actions.length >= 2,
    'fiche : motif interne, message et historique',
    detail.body.suspension,
  );

  // 5. Réactivation.
  const reactivate = { action: 'organization_reactivate', organizationId, operationId: randomUUID(), reason: REASON };
  const reactivated = await admin('POST', `organizations/${organizationId}/reactivate`, {
    operationId: reactivate.operationId,
    stepUpToken: await stepUp(reactivate),
    reason: REASON,
  });
  check(reactivated.status === 200, 'réactivation appliquée', reactivated.body);
  const back = await request(C.API_URL, 'POST', '/auth/login', { email: TARGET_OWNER, password: C.PASSWORD, organizationId }, { origin: C.WEB_ORIGIN });
  check([201, 403].includes(back.status) && back.body.code !== 'ORGANIZATION_SUSPENDED', 'propriétaire : accès rétabli (abonnement inchangé)', back.body);

  // 6. Audit, puis révocation.
  const audit = await admin('GET', 'audit?action=subscription_extend');
  check(audit.body.items.some((i) => i.outcome === 'success'), 'audit de la prolongation', audit.body.items[0]);
  const revoked = cli('revoke', `--email=${ADMIN_EMAIL}`, '--reason=Fin de la recette locale', '--operator=recette', '--apply');
  check(revoked?.result === 'revoked', 'révocation', revoked);
  check((await admin('GET', 'overview')).status === 401, 'session fermée après révocation');

  console.log(JSON.stringify({ result: 'ok', steps }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message} ${error.cause ?? ''}` : error);
  process.exit(1);
});
