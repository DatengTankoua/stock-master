// 1-22F — Politique CSP et en-têtes de sécurité (src/lib/security-headers.ts).
//
// Exécution : `node scripts/test-security-headers.mjs` depuis `web/`. Même
// principe que test-tenant-brand.mjs : runner `node:test`, module transpilé
// en mémoire par le TypeScript déjà installé, aucune dépendance.
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
  path.join(here, "..", "src", "lib", "security-headers.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const loaded = { exports: {} };
new Function("module", "exports", "require", outputText)(
  loaded,
  loaded.exports,
  require,
);
const {
  buildContentSecurityPolicy,
  createNonce,
  STATIC_SECURITY_HEADERS,
  HSTS_VALUE,
} = loaded.exports;

const directives = (csp) =>
  Object.fromEntries(
    csp.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name, values];
    }),
  );

const production = (extra = {}) =>
  directives(
    buildContentSecurityPolicy({
      nonce: "abc123",
      development: false,
      apiUrl: "https://api.stock-master.app",
      ...extra,
    }),
  );

test("scripts : nonce + strict-dynamic, jamais unsafe-inline ni unsafe-eval en production", () => {
  const d = production();
  assert.ok(d["script-src"].includes("'nonce-abc123'"));
  assert.ok(d["script-src"].includes("'strict-dynamic'"));
  assert.ok(!d["script-src"].includes("'unsafe-inline'"));
  assert.ok(!d["script-src"].includes("'unsafe-eval'"));
  assert.ok(!d["script-src"].includes("*"));
});

test("unsafe-eval seulement pour next dev", () => {
  const d = directives(
    buildContentSecurityPolicy({ nonce: "n", development: true }),
  );
  assert.ok(d["script-src"].includes("'unsafe-eval'"));
});

test("encadrement, objets, URL de base et formulaires verrouillés", () => {
  const d = production();
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'none'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["frame-src"], ["https://challenges.cloudflare.com"]);
});

test("API REST et Socket.IO : origine exacte et wss correspondant", () => {
  assert.deepEqual(production()["connect-src"], [
    "'self'",
    "https://api.stock-master.app",
    "wss://api.stock-master.app",
  ]);
  const local = directives(
    buildContentSecurityPolicy({
      nonce: "n",
      development: false,
      apiUrl: "http://127.0.0.1:4200",
    }),
  );
  assert.deepEqual(local["connect-src"], [
    "'self'",
    "http://127.0.0.1:4200",
    "ws://127.0.0.1:4200",
  ]);
});

test("images : origines déclarées exactes, sinon repli https: documenté", () => {
  const declared = production({
    imageOrigins:
      "https://acct.eu.r2.cloudflarestorage.com/bucket, javascript:alert(1), *, https://s3.stock-master.app",
  })["img-src"];
  assert.deepEqual(declared, [
    "'self'",
    "data:",
    "blob:",
    "https://acct.eu.r2.cloudflarestorage.com",
    "https://s3.stock-master.app",
  ]);
  assert.deepEqual(production()["img-src"], [
    "'self'",
    "data:",
    "blob:",
    "https:",
  ]);
  // Valeur entièrement invalide : même repli, jamais `*`.
  assert.ok(!production({ imageOrigins: "*" })["img-src"].includes("*"));
});

test("en-têtes fixes : HSTS sans includeSubDomains ni preload", () => {
  assert.equal(HSTS_VALUE, "max-age=63072000");
  const keys = STATIC_SECURITY_HEADERS.map((h) => h.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes("Content-Security-Policy-Report-Only"));
  const pp = STATIC_SECURITY_HEADERS.find(
    (h) => h.key === "Permissions-Policy",
  ).value;
  // Capacités utilisées par l'application : jamais désactivées.
  for (const used of ["clipboard-write", "fullscreen", "notifications"]) {
    assert.ok(!pp.includes(`${used}=()`));
  }
});

test("nonce : 128 bits aléatoires, base64, distincts", () => {
  const a = createNonce();
  assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(a, createNonce());
});
