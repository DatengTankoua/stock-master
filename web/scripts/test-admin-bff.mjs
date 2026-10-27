// Administration de la plateforme — règles du BFF `/api/admin/*`
// (src/lib/admin/bff-policy.ts) : routes relayées, anti-CSRF et origine,
// cookie, configuration, retrait du jeton de session des réponses.
//
// Exécution : `node scripts/test-admin-bff.mjs` depuis `web/`. Même principe
// que test-security-headers.mjs : runner `node:test`, module transpilé en
// mémoire par le TypeScript déjà installé, aucune dépendance. Vérifie aussi
// que le service worker n'intercepte jamais l'administration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  path.join(here, "..", "src", "lib", "admin", "bff-policy.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = { exports: {} };
new Function("module", "exports", "require", outputText)(loaded, loaded.exports, require);
const {
  ADMIN_RESPONSE_HEADERS,
  adminCookieName,
  adminCookieOptions,
  checkAdminRequest,
  clearsCookieAlways,
  clientAddress,
  extractSession,
  filterAdminQuery,
  resolveAdminBffConfig,
  resolveAdminRoute,
} = loaded.exports;

const ORIGIN = "https://www.stock-master.app";
const SECRET = "s".repeat(10) + "0123456789abcdefghijklmnopqrstuv";
const TOKEN = "A".repeat(43);

test("seules les routes déclarées sont relayées, avec leur méthode", () => {
  assert.equal(resolveAdminRoute("POST", ["auth", "login"]), "auth/login");
  assert.equal(resolveAdminRoute("GET", ["overview"]), "overview");
  assert.equal(
    resolveAdminRoute("GET", ["organizations", "0123456789abcdef01234567"]),
    "organizations/0123456789abcdef01234567",
  );
  const org = "0123456789abcdef01234567";
  assert.equal(resolveAdminRoute("POST", ["organizations", org, "suspend"]), `organizations/${org}/suspend`);
  assert.equal(resolveAdminRoute("POST", ["organizations", org, "extend"]), `organizations/${org}/extend`);
  assert.equal(resolveAdminRoute("GET", ["organizations", org, "extension-preview"]), `organizations/${org}/extension-preview`);
  for (const [method, segments] of [
    ["GET", ["organizations", org, "suspend"]],
    ["POST", ["organizations", org, "delete"]],
    ["POST", ["organizations", org, "extension-preview"]],
    ["GET", ["auth", "login"]],
    ["POST", ["overview"]],
    ["DELETE", ["audit"]],
    ["GET", ["organizations", "..", "users"]],
    ["GET", ["organizations", "not-an-id"]],
    ["GET", ["auth", "status", "x", "y"]],
    ["GET", []],
    ["GET", ["Overview"]],
  ]) {
    assert.equal(resolveAdminRoute(method, segments), null, `${method} ${segments}`);
  }
});

test("anti-CSRF : en-tête dédié, same-origin, origine exacte", () => {
  const base = { method: "POST", csrfHeader: "1", secFetchSite: "same-origin", origin: ORIGIN, allowedOrigin: ORIGIN };
  assert.equal(checkAdminRequest(base), "ok");
  assert.equal(checkAdminRequest({ ...base, csrfHeader: null }), "missing-header");
  assert.equal(checkAdminRequest({ ...base, secFetchSite: "cross-site" }), "cross-site");
  assert.equal(checkAdminRequest({ ...base, secFetchSite: "same-site" }), "cross-site");
  assert.equal(checkAdminRequest({ ...base, origin: "https://evil.example" }), "bad-origin");
  assert.equal(checkAdminRequest({ ...base, origin: null }), "bad-origin");
  assert.equal(checkAdminRequest({ ...base, origin: "null" }), "bad-origin");
  // GET même origine : Origin souvent absente, acceptée ; fausse si présente.
  assert.equal(checkAdminRequest({ ...base, method: "GET", origin: null }), "ok");
  assert.equal(
    checkAdminRequest({ ...base, method: "GET", origin: "https://evil.example" }),
    "bad-origin",
  );
  assert.equal(checkAdminRequest({ ...base, method: "GET", csrfHeader: null }), "missing-header");
});

test("cookie : HttpOnly, SameSite=Strict, Secure et préfixe __Host- en HTTPS", () => {
  assert.equal(adminCookieName(true), "__Host-sm_admin");
  assert.deepEqual(adminCookieOptions(true), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 28800,
  });
  assert.equal(adminCookieOptions(false).secure, false);
});

test("réponses privées, jamais en cache ni indexées", () => {
  assert.match(ADMIN_RESPONSE_HEADERS["Cache-Control"], /no-store/);
  assert.match(ADMIN_RESPONSE_HEADERS["Cache-Control"], /private/);
  assert.match(ADMIN_RESPONSE_HEADERS["X-Robots-Tag"], /noindex/);
});

test("le jeton de session n'atteint jamais le navigateur", () => {
  const out = extractSession({ stage: "verify", session: { token: TOKEN }, challenge: { token: "x" } });
  assert.equal(out.token, TOKEN);
  assert.equal(JSON.stringify(out.body).includes(TOKEN), false);
  assert.equal("session" in out.body, false);
  assert.equal(extractSession({ session: { token: "court" } }).token, null);
  assert.equal(extractSession({ sessionCleared: true }).clear, true);
  assert.equal(extractSession({ code: "PLATFORM_ADMIN_SESSION_EXPIRED" }).clear, true);
  assert.equal(extractSession({ code: "PLATFORM_ADMIN_CODE_INVALID" }).clear, false);
  assert.equal(extractSession(null).token, null);
});

test("statut : les échéances de session restent visibles, jamais un jeton", () => {
  const status = {
    stage: "ready",
    session: { idleExpiresAt: "2026-10-24T10:30:00.000Z", absoluteExpiresAt: "2026-10-24T18:00:00.000Z" },
  };
  const out = extractSession(status);
  assert.equal(out.token, null);
  assert.deepEqual(out.body.session, status.session);
  // Jeton et échéances ensemble : le jeton seul est retiré.
  const mixed = extractSession({ session: { token: TOKEN, idleExpiresAt: "x" } });
  assert.equal(mixed.token, TOKEN);
  assert.deepEqual(mixed.body.session, { idleExpiresAt: "x" });
  assert.equal(JSON.stringify(mixed.body).includes(TOKEN), false);
});

test("déconnexion : cookie toujours effacé, quelle que soit la réponse de l'API", () => {
  assert.equal(clearsCookieAlways("auth/logout"), true);
  assert.equal(clearsCookieAlways("auth/status"), false);
  const route = readFileSync(
    path.join(here, "..", "src", "app", "api", "admin", "[...path]", "route.ts"),
    "utf8",
  );
  // API injoignable : la réponse 502 efface aussi le cookie.
  const failure = route.slice(route.indexOf("} catch {"), route.indexOf("const parsed"));
  assert.match(failure, /clearsCookieAlways\(path\)/);
  assert.match(failure, /maxAge: 0/);
});

test("configuration : fermée par défaut, complète et cohérente sinon", () => {
  const env = {
    NODE_ENV: "production",
    PLATFORM_ADMIN_ENABLED: "true",
    PLATFORM_ADMIN_PROXY_SECRET: SECRET,
    PLATFORM_ADMIN_ALLOWED_ORIGIN: ORIGIN,
    NEXT_PUBLIC_API_URL: "https://api.example.app/",
  };
  assert.deepEqual(resolveAdminBffConfig(env), {
    apiUrl: "https://api.example.app",
    proxySecret: SECRET,
    allowedOrigin: ORIGIN,
    secureCookie: true,
    clientIpHeader: null,
  });
  assert.equal(
    resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_CLIENT_IP_HEADER: "X-Real-IP" }).clientIpHeader,
    "x-real-ip",
  );
  // En-tête non sûr déclaré : configuration refusée (espace fermé).
  assert.equal(resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_CLIENT_IP_HEADER: "x-forwarded-for" }), null);
  assert.equal(resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_ENABLED: undefined }), null);
  assert.equal(resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_PROXY_SECRET: "court" }), null);
  assert.equal(resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_ALLOWED_ORIGIN: `${ORIGIN}/admin` }), null);
  assert.equal(resolveAdminBffConfig({ ...env, PLATFORM_ADMIN_ALLOWED_ORIGIN: "http://www.stock-master.app" }), null);
  assert.equal(resolveAdminBffConfig({ ...env, NEXT_PUBLIC_API_URL: "http://api.example.app" }), null);
  const local = resolveAdminBffConfig({
    ...env,
    NODE_ENV: "development",
    PLATFORM_ADMIN_ALLOWED_ORIGIN: "http://localhost:3000",
    PLATFORM_ADMIN_API_URL: "http://localhost:4000",
  });
  assert.equal(local.secureCookie, false);
  assert.equal(local.apiUrl, "http://localhost:4000");
  // Production sans HTTPS : seulement si web ET API sont sur la boucle locale.
  const loopback = {
    ...env,
    PLATFORM_ADMIN_ALLOWED_ORIGIN: "http://127.0.0.1:3200",
    PLATFORM_ADMIN_API_URL: "http://127.0.0.1:4200",
  };
  assert.equal(resolveAdminBffConfig(loopback).secureCookie, false);
  assert.equal(
    resolveAdminBffConfig({ ...loopback, PLATFORM_ADMIN_API_URL: "http://api.example.app" }),
    null,
  );
});

test("adresse du client : seulement l'en-tête déclaré de confiance", () => {
  const headers = (map) => ({ get: (name) => map[name] ?? null });
  const forged = headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" });
  // Aucun en-tête déclaré : rien n'est relayé, quelle que soit la requête.
  assert.equal(clientAddress(forged, null), null);
  assert.equal(clientAddress(forged, "x-real-ip"), "203.0.113.9");
  // x-forwarded-for n'est jamais lu (valeur du client possible).
  assert.equal(clientAddress(headers({ "x-forwarded-for": "198.51.100.1" }), "x-real-ip"), null);
  assert.equal(
    clientAddress(headers({ "x-vercel-forwarded-for": "198.51.100.7" }), "x-vercel-forwarded-for"),
    "198.51.100.7",
  );
  assert.equal(clientAddress(headers({ "x-real-ip": "<script>" }), "x-real-ip"), null);
});

test("paramètres relayés", () => {
  const query = filterAdminQuery(new URLSearchParams("page=2&q=boutique&token=secret&page=9&status=active"));
  assert.equal(query, "?page=2&q=boutique&status=active");
  assert.equal(filterAdminQuery(new URLSearchParams("")), "");
});

test("service worker : l'administration n'est jamais interceptée ni mise en cache", () => {
  const sw = readFileSync(path.join(here, "..", "public", "sw.js"), "utf8");
  assert.match(sw, /function isPlatformAdminPath\(pathname\)/);
  const handler = sw.slice(sw.indexOf('self.addEventListener("fetch"'));
  const guard = handler.indexOf("if (isPlatformAdminPath(url.pathname)) return;");
  assert.ok(guard > 0, "garde présente dans le gestionnaire fetch");
  assert.ok(guard < handler.indexOf("respondWith"), "garde avant toute réponse du service worker");
});

// ─── Messages d'erreur de l'administration (src/lib/admin/admin-api.ts) ────
const apiSource = readFileSync(path.join(here, "..", "src", "lib", "admin", "admin-api.ts"), "utf8");
const apiModule = { exports: {} };
new Function("module", "exports", "require", ts.transpileModule(apiSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(apiModule, apiModule.exports, (id) => (id === "@/lib/admin/bff-policy" ? loaded.exports : require(id)));
const { AdminApiError, adminErrorKey, adminErrorReference } = apiModule.exports;

test("erreurs publiques : aucune information sur l'infrastructure ni sur l'existence d'un compte", () => {
  const { publicError } = loaded.exports;
  // Connexion : mot de passe faux, compte non administrateur ou non confirmé → refus unique.
  for (const [status, code] of [[401, null], [403, "PLATFORM_ADMIN_ACCESS_DENIED"], [403, "EMAIL_NOT_VERIFIED"]]) {
    assert.deepEqual(publicError("auth/login", status, code), { status: 401, code: "PLATFORM_ADMIN_LOGIN_FAILED" });
  }
  // Défi anti-robot et plafonds : conservés (identiques pour un compte connu ou non).
  assert.deepEqual(publicError("auth/login", 429, "AUTH_CHALLENGE_REQUIRED"), { status: 429, code: "AUTH_CHALLENGE_REQUIRED" });
  assert.deepEqual(publicError("auth/login", 429, "PLATFORM_ADMIN_RATE_LIMITED"), { status: 429, code: "PLATFORM_ADMIN_RATE_LIMITED" });
  // Infrastructure : secret du BFF refusé, route absente, API en panne ou injoignable → « indisponible ».
  for (const [status, code] of [[403, "PLATFORM_ADMIN_PROXY_REQUIRED"], [404, null], [500, null], [502, null], [0, null], [503, "PLATFORM_ADMIN_UNAVAILABLE"], [418, "QUELQUE_CHOSE"]]) {
    assert.deepEqual(publicError("auth/login", status, code), { status: 503, code: "PLATFORM_ADMIN_UNAVAILABLE" });
  }
  // Validation : jamais le détail des champs.
  assert.deepEqual(publicError("security/step-up", 400, null), { status: 400, code: "PLATFORM_ADMIN_INVALID_REQUEST" });
  // Session ouverte : codes utiles à l'interface conservés.
  assert.deepEqual(publicError("overview", 401, "PLATFORM_ADMIN_SESSION_EXPIRED"), { status: 401, code: "PLATFORM_ADMIN_SESSION_EXPIRED" });
  assert.deepEqual(publicError("organizations/x/suspend", 409, "PLATFORM_ADMIN_STATE_CHANGED"), { status: 409, code: "PLATFORM_ADMIN_STATE_CHANGED" });
  // Référence : aléatoire, opaque.
  const { newErrorReference } = loaded.exports;
  const a = newErrorReference();
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, newErrorReference());
});

test("route : corps d'erreur de l'API jamais relayé, détail au journal serveur seulement", () => {
  const route = readFileSync(path.join(here, "..", "src", "app", "api", "admin", "[...path]", "route.ts"), "utf8");
  assert.match(route, /if \(upstream\.ok\) \{\s+response = reply\(upstream\.status, safeBody\);/);
  assert.match(route, /publicError\(path, upstream\.status, upstreamCode\)/);
  assert.doesNotMatch(route, /PLATFORM_ADMIN_UPSTREAM|PAYLOAD_TOO_LARGE|message:/);
});

test("messages : codes publics seulement ; référence opaque, sans code ni statut", () => {
  const key = (status, code) => adminErrorKey(new AdminApiError(status, code, null)).key;
  assert.equal(key(401, "PLATFORM_ADMIN_LOGIN_FAILED"), "errors.loginFailed");
  assert.equal(key(503, "PLATFORM_ADMIN_UNAVAILABLE"), "errors.unavailable");
  assert.equal(key(400, "PLATFORM_ADMIN_INVALID_REQUEST"), "errors.invalidRequest");
  assert.equal(key(502, null), "errors.unavailable");
  assert.equal(key(418, null), "errors.generic");
  assert.equal(adminErrorReference(new AdminApiError(503, "PLATFORM_ADMIN_UNAVAILABLE", null, "a1b2c3d4e5f6")), "a1b2c3d4e5f6");
  assert.equal(adminErrorReference(new AdminApiError(503, "PLATFORM_ADMIN_UNAVAILABLE", null)), null);
  for (const lang of ["fr", "en"]) {
    const texts = readFileSync(path.join(here, "..", "src", "i18n", "resources", lang, "admin.ts"), "utf8");
    const start = texts.indexOf("\n  errors: {");
    const errors = texts.slice(start, texts.indexOf("\n  },", start));
    assert.doesNotMatch(errors, /PLATFORM_ADMIN_|API|secret|proxy|BFF|URL|n'a pas accès|non confirmée|not confirmed/i, lang);
  }
});

test("messages de service : routes relayées et codes publics", () => {
  const org = "0123456789abcdef01234567";
  assert.equal(resolveAdminRoute("GET", ["organizations", org, "message-recipients"]), `organizations/${org}/message-recipients`);
  assert.equal(resolveAdminRoute("GET", ["organizations", org, "messages"]), `organizations/${org}/messages`);
  assert.equal(resolveAdminRoute("POST", ["organizations", org, "messages"]), `organizations/${org}/messages`);
  assert.equal(resolveAdminRoute("POST", ["organizations", org, "message-retry"]), `organizations/${org}/message-retry`);
  for (const [method, segments] of [
    ["POST", ["organizations", org, "message-recipients"]],
    ["GET", ["organizations", org, "message-retry"]],
    ["POST", ["organizations", "all", "messages"]],
    ["POST", ["messages"]],
  ]) {
    assert.equal(resolveAdminRoute(method, segments), null, `${method} ${segments}`);
  }
  const { publicError } = loaded.exports;
  for (const [status, code] of [
    [400, "PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT"],
    [429, "PLATFORM_ADMIN_MESSAGE_RATE_LIMITED"],
    [409, "PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED"],
    [409, "PLATFORM_ADMIN_MESSAGE_NOT_RETRYABLE"],
    [409, "PLATFORM_ADMIN_MESSAGE_RETRY_WINDOW_EXPIRED"],
  ]) {
    assert.deepEqual(publicError(`organizations/${org}/messages`, status, code), { status, code });
  }
  // Corps d'un message de 5 000 caractères accepté, borne conservée.
  const route = readFileSync(path.join(here, "..", "src", "app", "api", "admin", "[...path]", "route.ts"), "utf8");
  assert.match(route, /const MAX_BODY_BYTES = 65_536;/);
});
