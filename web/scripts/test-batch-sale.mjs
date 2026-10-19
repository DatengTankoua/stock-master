// Lot B — Tests déterministes de la vente par lots côté web : jour du
// commerce sur l'appareil (jamais antérieur au serveur), validité des dates,
// FEFO, unités engagées par les ventes locales en attente, contrôle d'une
// affectation, cache hors ligne sans quantités et classement des refus de
// lots dans l'outbox (`batch-sale.ts`, `offline-catalog-db.ts`,
// `offline-sales-policy.ts`, fonctions pures).
//
// Exécution : `pnpm --filter web test:batch-sale` (ou `node
// scripts/test-batch-sale.mjs` depuis `web/`). Runner `node:test`, modules
// transpilés en mémoire, aucune dépendance ajoutée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("typescript");
const cache = new Map();
const stubs = { "./offline-db-utils": {} };

function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = readFileSync(
    path.join(here, "..", "src", "lib", file),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  const localRequire = (name) => {
    if (name in stubs) return stubs[name];
    if (name.startsWith("./")) return load(`${name.slice(2)}.ts`);
    throw new Error(`module non prévu : ${name}`);
  };
  new Function("module", "exports", "require", outputText)(
    loaded,
    loaded.exports,
    localRequire,
  );
  return loaded.exports;
}

const {
  localBusinessDate,
  batchDateState,
  classifySaleBatches,
  pendingBatchUsage,
  suggestFefo,
  allocationProblem,
} = load("batch-sale.ts");
const { toOfflineCatalogProduct } = load("offline-catalog-db.ts");
const {
  classifySaleSyncOutcome,
  allowedOperationActions,
  describeOperationError,
} = load("offline-sales-policy.ts");

const ID = (n) => String(n).padStart(24, "a");
const batch = (n, expiryDate, extra = {}) => ({
  _id: ID(n),
  reference: `L-00${n}`,
  expiryDate,
  manufacturerLot: null,
  ...extra,
});

test("jour du commerce : fuseau du commerce, jamais antérieur au jour serveur", () => {
  // 23:30 UTC le 16 : déjà le 17 à Douala.
  const at = Date.parse("2026-10-16T23:30:00Z");
  assert.equal(
    localBusinessDate("Africa/Douala", "2026-10-01", at),
    "2026-10-17",
  );
  // Horloge de l'appareil reculée : on garde le jour du serveur.
  assert.equal(
    localBusinessDate("Africa/Douala", "2026-10-20", at),
    "2026-10-20",
  );
  // Fuseau inconnu : jour du serveur.
  assert.equal(localBusinessDate("Nulle/Part", "2026-10-15", at), "2026-10-15");
});

test("validité recalculée au changement de jour, sans relecture", () => {
  const b = batch(1, "2026-10-17");
  assert.equal(batchDateState(b.expiryDate, "2026-10-16"), "valid");
  assert.equal(batchDateState(b.expiryDate, "2026-10-17"), "expires-today");
  assert.equal(batchDateState(b.expiryDate, "2026-10-18"), "expired");
  assert.equal(batchDateState(null, "2026-10-18"), "unknown");
});

test("FEFO : datés valides triés, sans date à part, dépassés exclus", () => {
  const { dated, undated, expired } = classifySaleBatches(
    [
      batch(1, "2026-11-01"),
      batch(2, null),
      batch(3, "2026-10-20"),
      batch(4, "2026-10-01"),
    ],
    "2026-10-18",
  );
  assert.deepEqual(
    dated.map((b) => b.reference),
    ["L-003", "L-001"],
  );
  assert.deepEqual(
    undated.map((b) => b.reference),
    ["L-002"],
  );
  assert.equal(expired, 1);
});

test("suggestion FEFO : quantités connues réparties, ventes en attente déduites, jamais un lot sans date", () => {
  const dated = [
    batch(3, "2026-10-20", { remainingQuantity: 4 }),
    batch(1, "2026-11-01", { remainingQuantity: 10 }),
  ];
  assert.deepEqual(suggestFefo(dated, 6), [
    { batchId: ID(3), quantity: 4 },
    { batchId: ID(1), quantity: 2 },
  ]);
  const usage = new Map([[ID(3), 3]]);
  assert.deepEqual(suggestFefo(dated, 6, usage), [
    { batchId: ID(3), quantity: 1 },
    { batchId: ID(1), quantity: 5 },
  ]);
  // Quantités inconnues (hors ligne) : tout sur le premier lot, à confirmer.
  assert.deepEqual(suggestFefo([batch(3, "2026-10-20")], 6), [
    { batchId: ID(3), quantity: 6 },
  ]);
});

test("ventes locales en attente : unités engagées par lot (réservation identique au stock indicatif)", () => {
  const op = (status, entries, productId = "p1", extra = {}) => ({
    clientOperationId: `${status}-${entries.length}`,
    status,
    attempts: 0,
    updatedAt: 0,
    payload: { productId, quantity: 1, batchAllocations: entries },
    ...extra,
  });
  const usage = pendingBatchUsage(
    [
      op("pending", [{ batchId: ID(1), quantity: 2 }]),
      op("syncing", [
        { batchId: ID(1), quantity: 1 },
        { batchId: ID(2), quantity: 3 },
      ]),
      op("abandoned", [{ batchId: ID(1), quantity: 9 }]),
      op("pending", [{ batchId: ID(1), quantity: 9 }], "p2"),
      op("conflict", [{ batchId: ID(2), quantity: 5 }], "p1", {
        lastError: {
          kind: "business",
          code: "BATCH_INSUFFICIENT",
          httpStatus: 409,
        },
      }),
    ],
    "p1",
  );
  assert.equal(usage.get(ID(1)), 3);
  assert.equal(usage.get(ID(2)), 3);
});

test("contrôle d'une affectation : somme exacte, sans date confirmé, disponible connu", () => {
  const base = {
    quantity: 3,
    undatedIds: new Set([ID(2)]),
    unknownConfirmed: false,
  };
  assert.equal(
    allocationProblem({ ...base, entries: [{ batchId: ID(1), quantity: 2 }] }),
    "sum",
  );
  assert.equal(
    allocationProblem({ ...base, entries: [{ batchId: ID(2), quantity: 3 }] }),
    "unknown-unconfirmed",
  );
  assert.equal(
    allocationProblem({
      ...base,
      entries: [{ batchId: ID(1), quantity: 3 }],
      available: new Map([[ID(1), 2]]),
    }),
    "above-available",
  );
  assert.equal(
    allocationProblem({
      ...base,
      unknownConfirmed: true,
      entries: [
        { batchId: ID(1), quantity: 1 },
        { batchId: ID(2), quantity: 2 },
      ],
    }),
    null,
  );
});

test("cache hors ligne : identité des lots seulement, jamais de quantité ; données invalides rejetées", () => {
  const product = {
    _id: ID(9),
    sectionId: ID(8),
    name: "Lait",
    salePrice: 500,
    remainingQuantity: 12,
    status: "in_stock",
    stockTracking: "batches",
    purchasePrice: 300,
    batchSale: {
      businessDate: "2026-10-18",
      timeZone: "Africa/Douala",
      batches: [{ ...batch(1, "2026-11-01"), remainingQuantity: 7 }],
    },
  };
  const copy = toOfflineCatalogProduct(product);
  assert.equal(copy.purchasePrice, undefined);
  assert.deepEqual(copy.batchSale.batches, [
    {
      _id: ID(1),
      reference: "L-001",
      expiryDate: "2026-11-01",
      manufacturerLot: null,
    },
  ]);
  const invalid = toOfflineCatalogProduct({
    ...product,
    batchSale: { ...product.batchSale, batches: [{ _id: "x" }] },
  });
  assert.equal(invalid.batchSale, undefined);
  const ordinary = toOfflineCatalogProduct({
    ...product,
    stockTracking: undefined,
  });
  assert.equal(ordinary.batchSale, undefined);
});

test("outbox : refus de lot = conflit visible et corrigeable, jamais réessayé ni bloquant", () => {
  for (const code of [
    "SALE_BATCH_ALLOCATION_REQUIRED",
    "BATCH_INSUFFICIENT",
    "BATCH_UNAVAILABLE",
    "BATCH_EXPIRED",
    "BATCH_EXPIRED_AT_SYNC",
    "BATCH_EXPIRY_UNCONFIRMED",
    "PRODUCT_BATCHES_DISABLED",
  ]) {
    const decision = classifySaleSyncOutcome({
      kind: "http",
      status: 409,
      code,
    });
    assert.equal(decision.action, "conflict", code);
    const actions = allowedOperationActions({
      status: "conflict",
      attempts: 1,
      lastError: decision.error,
    });
    assert.equal(actions.edit, true, code);
    assert.equal(actions.mayBeRecorded, false, code);
    assert.notEqual(describeOperationError(decision.error), "refused", code);
  }
});
