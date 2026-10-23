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
  for (const [method, segments] of [
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
  });
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

test("adresse du client et paramètres relayés", () => {
  const headers = (map) => ({ get: (name) => map[name] ?? null });
  assert.equal(clientAddress(headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
  assert.equal(clientAddress(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assert.equal(clientAddress(headers({ "x-real-ip": "<script>" })), null);
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
