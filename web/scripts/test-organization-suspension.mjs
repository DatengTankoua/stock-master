// Administration de la plateforme — suspension d'un commerce, côté web :
// décisions de la file des ventes hors ligne (src/lib/offline-sales-policy.ts)
// et levée explicite du blocage (src/lib/offline-sales-outbox-db.ts, lecture
// du source). Une suspension ne doit jamais abandonner une vente en attente.
//
// Exécution : `node scripts/test-organization-suspension.mjs` depuis `web/`.
// Même principe que test-security-headers.mjs (module transpilé en mémoire).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const src = (...parts) => readFileSync(path.join(here, "..", "src", ...parts), "utf8");

const { outputText } = ts.transpileModule(src("lib", "offline-sales-policy.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = { exports: {} };
new Function("module", "exports", "require", outputText)(loaded, loaded.exports, require);
const { classifySaleSyncOutcome, describeOperationError } = loaded.exports;

test("refus pour suspension : vente conservée en attente, partition arrêtée (jamais un conflit)", () => {
  const decision = classifySaleSyncOutcome({
    kind: "http",
    status: 403,
    code: "ORGANIZATION_SUSPENDED",
  });
  assert.equal(decision.action, "stop-block");
  assert.equal(decision.error.code, "ORGANIZATION_SUSPENDED");
  assert.notEqual(decision.action, "conflict");
});

test("message propre à la suspension", () => {
  assert.equal(
    describeOperationError({ kind: "auth", httpStatus: 403, code: "ORGANIZATION_SUSPENDED" }),
    "organizationSuspended",
  );
});

test("blocage « suspended » : propre à la partition, levé par le signal serveur, jamais par un simple changement de jeton", () => {
  const sync = src("lib", "offline-sales-sync.ts");
  assert.match(sync, /meta\.blocked\.reason === "suspended"/);
  assert.match(sync, /decision\.error\.code === ORGANIZATION_SUSPENDED/);
  const outbox = src("lib", "offline-sales-outbox-db.ts");
  assert.match(outbox, /meta\.blocked\?\.reason !== "suspended"/);
  // Partition = utilisateur + commerce : les autres commerces continuent.
  assert.match(outbox, /return `\$\{userId\}:\$\{organizationId\}`;/);
});

test("shell : la suspension n'efface jamais la file des ventes", () => {
  const layout = src("app", "app", "layout.tsx");
  const branch = layout.slice(layout.indexOf("setSuspension(readOrganizationSuspended(reason))") - 400, layout.indexOf("setSuspension(readOrganizationSuspended(reason))") + 1200);
  assert.doesNotMatch(branch, /purgeAllOfflineData|clearOutbox|deleteOperation/);
});
