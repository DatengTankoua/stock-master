/**
 * Recette isolée — parcours complet de l'administration de la plateforme,
 * par le serveur web de la recette (BFF `/api/admin`, cookie HttpOnly), comme
 * le ferait un navigateur (sans moteur de rendu) :
 *
 *   refus avant attribution → attribution locale (commande opérateur, lecture
 *   seule puis --apply) → enrôlement (TOTP + codes) → consultation → contrôles
 *   anti-CSRF et cache → déconnexion → connexion par code de récupération
 *   (usage unique) → révocation → refus.
 *
 * Usage : `recipe.js start --platform-admin` (terminal 1), puis
 * `recipe.js platform-admin-flow` (terminal 2). Comptes et secrets FICTIFS,
 * base éphémère, aucun message externe. Sortie : JSON des étapes ; code 1 au
 * premier écart. `RECIPE_FLOW_DEBUG=1` : statut et code de chaque réponse.
 *
 * Relançable (révocation et récupération d'urgence au début), mais chaque
 * passage fait UN échec volontaire (code de récupération réutilisé) : au-delà
 * de 4 passages en 15 minutes, le plafond persistant de 5 échecs par compte
 * répond 429, comme voulu. Attendre la fin de la fenêtre.
 */
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./recipe-common');
const D = require('./db-tools');

const ADMIN_EMAIL = 'proprietaire.actif@recette.local';
const EVIL_ORIGIN = 'https://evil.example';

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
        this.lastAttributes = attributes.map((a) => a.trim().toLowerCase());
      }
    },
    lastAttributes: [],
    size: () => jar.size,
  };
}

function check(condition, label, steps) {
  steps.push({ step: label, ok: Boolean(condition) });
  if (!condition) {
    console.log(JSON.stringify({ result: 'failed', steps }, null, 2));
    process.exit(1);
  }
}

async function main() {
  const state = C.requireRunningState();
  const { Secret, TOTP } = C.apiRequire('otpauth');
  const jar = cookieJar();
  const steps = [];

  // `node:http` sans agent : une connexion par requête. Avec `fetch`, une
  // connexion inactive réutilisée après un appel de la commande (plusieurs
  // secondes) peut être fermée par le serveur web (ECONNRESET) ; un
  // navigateur rejoue alors la requête, ce script ne le ferait pas.
  const call = (method, route, body, options = {}) =>
    new Promise((resolve, reject) => {
      const payload = method === 'POST' ? JSON.stringify(body ?? {}) : null;
      const request = http.request(
        `${C.WEB_ORIGIN}/api/admin/${route}`,
        {
          method,
          agent: false,
          headers: {
            ...(options.noCsrf ? {} : { 'x-stockmaster-admin': '1' }),
            ...(payload !== null
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                  origin: options.origin ?? C.WEB_ORIGIN,
                }
              : {}),
            ...(jar.size() ? { cookie: jar.header() } : {}),
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => {
            jar.store(response.headers['set-cookie'] ?? []);
            if (process.env.RECIPE_FLOW_DEBUG === '1') {
              // Statut et code seulement (jamais le corps : codes, secrets).
              const code = /"code":"([A-Z_]+)"/.exec(text)?.[1] ?? '';
              console.error(`${method} ${route} → ${response.statusCode} ${code}`);
            }
            resolve({
              status: response.statusCode,
              body: text ? JSON.parse(text) : null,
              text,
              cacheControl: response.headers['cache-control'] ?? null,
            });
          });
        },
      );
      request.on('error', reject);
      if (payload !== null) request.write(payload);
      request.end();
    });

  const cli = (...args) => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'recipe.js'), 'platform-admin', ...args],
      { encoding: 'utf8', env: process.env },
    );
    const line = result.stdout.trim().split('\n').pop() ?? '';
    return { code: result.status, json: line.startsWith('{') ? JSON.parse(line) : null };
  };

  const closed = await call('GET', 'auth/status');
  if (closed.status === 503) {
    throw new Error(
      'Administration fermée : démarrer la recette avec `start --platform-admin`.',
    );
  }

  // 0. Relance : remise à l'état initial par les commandes opérateur réelles
  //    (révocation, puis récupération d'urgence si un facteur existe).
  const initial = cli('status', `--email=${ADMIN_EMAIL}`).json;
  if (initial?.access === 'active') {
    cli('revoke', `--email=${ADMIN_EMAIL}`, '--reason=Relance de la recette locale', '--operator=recette', '--apply');
  }
  if (initial?.mfa === 'active') {
    const reset = cli('reset-mfa', `--email=${ADMIN_EMAIL}`, '--reason=Relance de la recette locale', '--operator=recette', '--identity-check=recette-locale', '--apply');
    check(reset.json?.result === 'mfa-reset', 'récupération d’urgence (relance)', steps);
  }

  // 1. Propriétaire d'un commerce, pas encore administrateur : refus.
  const denied = await call('POST', 'auth/login', { email: ADMIN_EMAIL, password: C.PASSWORD });
  check(denied.status === 403 && denied.body.code === 'PLATFORM_ADMIN_ACCESS_DENIED', 'commerce seul : refus', steps);

  // 2. Attribution locale : lecture seule, puis --apply.
  const reason = '--reason=Recette locale de l’administration';
  const dry = cli('grant', `--email=${ADMIN_EMAIL}`, reason, '--operator=recette');
  check(dry.code === 0 && dry.json?.result === 'dry-run:grant', 'attribution : lecture seule par défaut', steps);
  const granted = cli('grant', `--email=${ADMIN_EMAIL}`, reason, '--operator=recette', '--apply');
  check(granted.code === 0 && ['granted', 'already-active'].includes(granted.json?.result), 'attribution appliquée', steps);

  // 3. Mot de passe seul : enrôlement exigé, aucune donnée.
  const login = await call('POST', 'auth/login', { email: ADMIN_EMAIL, password: C.PASSWORD });
  check(login.status === 200 && login.body.stage === 'enroll', 'mot de passe : enrôlement exigé', steps);
  check(!login.text.includes('"session"') && jar.size() === 1, 'jeton en cookie seulement', steps);
  check(jar.lastAttributes.includes('httponly') && jar.lastAttributes.includes('samesite=strict'), 'cookie HttpOnly SameSite=Strict', steps);
  const early = await call('GET', 'overview');
  check(early.status === 401 && early.body.code === 'PLATFORM_ADMIN_MFA_REQUIRED', 'données fermées avant le second facteur', steps);

  // 4. Enrôlement.
  const start = await call('POST', 'mfa/enrollment/start');
  check(start.status === 200 && start.body.uri.startsWith('otpauth://totp/'), 'secret et URI de configuration', steps);
  const secret = Secret.fromBase32(start.body.manualKey.replace(/ /g, ''));
  const totp = new TOTP({ secret, digits: 6, period: 30, algorithm: 'SHA1' });
  const confirm = await call('POST', 'mfa/enrollment/confirm', {
    challengeToken: start.body.challenge.token,
    code: totp.generate(),
  });
  check(confirm.status === 200 && confirm.body.recoveryCodes.length === 10, 'enrôlement : 10 codes de récupération', steps);
  const recoveryCodes = confirm.body.recoveryCodes;

  // 5. Consultation.
  const overview = await call('GET', 'overview');
  check(overview.status === 200 && overview.body.organizations.total > 0, 'vue d’ensemble', steps);
  check(/no-store/.test(overview.cacheControl ?? ''), 'réponse no-store', steps);
  const organizations = await call('GET', 'organizations?subscription=trial&page=1');
  check(organizations.status === 200, 'liste des organisations', steps);
  const owner = await D.connect(state.mongodbUri).then(async (connection) => {
    try {
      return await D.account(connection.db, ADMIN_EMAIL);
    } finally {
      await connection.close();
    }
  });
  const orgId = owner.memberships[0].organizationId;
  const detail = await call('GET', `organizations/${orgId}`);
  check(detail.status === 200 && detail.body.owner?.email === ADMIN_EMAIL, 'fiche organisation', steps);
  check((await call('GET', 'payments')).status === 200, 'paiements', steps);
  const audit = await call('GET', 'audit?action=access_grant');
  check(audit.status === 200 && audit.body.items.some((i) => i.actorLabel === 'recette'), 'audit : attribution tracée', steps);
  const everything = [overview.text, organizations.text, detail.text, audit.text].join('');
  check(
    !everything.includes(start.body.manualKey.replace(/ /g, '')) &&
      !recoveryCodes.some((c) => everything.includes(c)) &&
      !everything.includes(C.FAKE.platformAdminProxySecret),
    'aucun secret dans les réponses',
    steps,
  );

  // 6. Anti-CSRF.
  check((await call('POST', 'auth/logout', {}, { noCsrf: true })).status === 403, 'CSRF : en-tête dédié exigé', steps);
  check((await call('POST', 'auth/logout', {}, { origin: EVIL_ORIGIN })).status === 403, 'CSRF : origine tierce refusée', steps);

  // 7. Déconnexion.
  const out = await call('POST', 'auth/logout');
  check(out.status === 200 && jar.size() === 0, 'déconnexion : cookie effacé', steps);

  // 8. Connexion par code de récupération (usage unique).
  const second = await call('POST', 'auth/login', { email: ADMIN_EMAIL, password: C.PASSWORD });
  check(second.body.stage === 'verify', 'connexion suivante : second facteur', steps);
  const recovered = await call('POST', 'mfa/verify', {
    challengeToken: second.body.challenge.token,
    recoveryCode: recoveryCodes[0],
  });
  check(recovered.status === 200 && recovered.body.recoveryCodesRemaining === 9, 'récupération : accès, 9 codes restants', steps);
  await call('POST', 'auth/logout');
  const third = await call('POST', 'auth/login', { email: ADMIN_EMAIL, password: C.PASSWORD });
  const reused = await call('POST', 'mfa/verify', {
    challengeToken: third.body.challenge.token,
    recoveryCode: recoveryCodes[0],
  });
  check(reused.status === 401, 'code de récupération réutilisé : refus', steps);
  const fresh = await call('POST', 'mfa/verify', {
    challengeToken: third.body.challenge.token,
    recoveryCode: recoveryCodes[1],
  });
  check(fresh.status === 200, 'autre code : accès', steps);

  // 9. Révocation : effet immédiat sur la session ouverte.
  const revoked = cli('revoke', `--email=${ADMIN_EMAIL}`, '--reason=Fin de la recette locale', '--operator=recette', '--apply');
  check(revoked.code === 0 && revoked.json?.result === 'revoked', 'révocation appliquée', steps);
  const after = await call('GET', 'overview');
  check(after.status === 401 && jar.size() === 0, 'session révoquée, cookie effacé', steps);

  console.log(JSON.stringify({ result: 'ok', steps }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message} ${error.cause ?? ""}` : error);
  process.exit(1);
});
