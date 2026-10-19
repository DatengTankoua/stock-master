import type { Connection } from 'mongoose';
import {
  PRODUCT_BATCHES_COLLECTION,
  PRODUCT_BATCH_REFERENCE_INDEX_KEY,
} from './schemas/product-batch.schema';
import {
  PRODUCT_BATCH_OPERATIONS_COLLECTION,
  PRODUCT_BATCH_OPERATION_INDEX_KEY,
} from './schemas/product-batch-operation.schema';
import {
  STOCK_LOSSES_COLLECTION,
  STOCK_LOSS_PERIOD_INDEX_KEY,
  STOCK_LOSS_PRODUCT_INDEX_KEY,
} from './schemas/stock-loss.schema';
import {
  SALE_REGULARIZATION_REQUESTS_COLLECTION,
  SALE_REGULARIZATION_REQUEST_INDEX_KEY,
} from '../../sales/schemas/sale-regularization-request.schema';

/**
 * Garde de la BASE pour le suivi par lots (prérequis de toute activation).
 *
 * 1. Validateur de la collection `products` : un produit suivi par lots
 *    (`stockTracking: 'batches'`) doit avoir `remainingQuantity` ÉGAL à
 *    `batchTracking.totalQuantity`. Seul le service des lots met à jour les
 *    deux ensemble (même écriture, même transaction que les lots). Toute
 *    écriture qui ignore les lots — ancienne API pendant un déploiement
 *    progressif ou après un retour arrière, `$inc` du stock seul, `save()`
 *    d'un ajustement — est REFUSÉE par MongoDB (erreur 121), quel que soit
 *    le code qui l'émet. Les produits sans lots ne sont pas concernés.
 * 2. Index uniques des lots (référence par produit) et des opérations
 *    idempotentes (`{ organizationId, clientOperationId }`).
 *
 * `ensureProductBatchGuard` : création explicite et idempotente (migration
 * `migrate:product-batches -- --install --apply`, tests éphémères). Un
 * validateur DIFFÉRENT déjà présent n'est jamais écrasé.
 * `describeProductBatchGuardProblem` : lecture seule, appelée à chaque
 * activation (refus 503 si la garde manque).
 */

export const PRODUCTS_COLLECTION = 'products';

export const PRODUCT_BATCH_GUARD_VALIDATOR = Object.freeze({
  $or: [
    { stockTracking: null },
    {
      stockTracking: 'batches',
      'batchTracking.totalQuantity': { $gte: 0 },
      $expr: {
        $eq: ['$remainingQuantity', '$batchTracking.totalQuantity'],
      },
    },
  ],
});

export class ProductBatchGuardError extends Error {
  constructor(reason: string) {
    super(
      `Garde du suivi par lots invalide : ${reason}. ` +
        'Exécuter `pnpm --filter api migrate:product-batches -- --install --apply`.',
    );
    this.name = 'ProductBatchGuardError';
  }
}

interface IndexDescription {
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: number;
  collation?: unknown;
}

interface CollectionInfo {
  name: string;
  options?: {
    validator?: unknown;
    validationLevel?: string;
    validationAction?: string;
  };
}

const NAMESPACE_NOT_FOUND = 26;

/** Sérialisation à clés triées : comparaison exacte indépendante de l'ordre. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasExactKey(
  key: Record<string, unknown>,
  expected: Readonly<Record<string, number>>,
): boolean {
  const actual = Object.entries(key);
  const wanted = Object.entries(expected);
  return (
    actual.length === wanted.length &&
    wanted.every(([f, d], i) => actual[i][0] === f && actual[i][1] === d)
  );
}

function uniqueIndexProblem(
  indexes: readonly IndexDescription[],
  expected: Readonly<Record<string, number>>,
  label: string,
): string | null {
  const index = indexes.find((i) => hasExactKey(i.key, expected));
  if (!index) return `index ${label} absent`;
  if (index.unique !== true) return `index ${label} non unique`;
  if (
    index.partialFilterExpression !== undefined ||
    index.sparse === true ||
    index.expireAfterSeconds !== undefined ||
    index.collation !== undefined
  ) {
    return `index ${label} mal configuré`;
  }
  return null;
}

function plainIndexProblem(
  indexes: readonly IndexDescription[],
  expected: readonly Readonly<Record<string, number>>[],
  label: string,
): string | null {
  return expected.every((key) => indexes.some((i) => hasExactKey(i.key, key)))
    ? null
    : `index ${label} absent`;
}

export function validatorProblem(
  info: CollectionInfo | undefined,
): string | null {
  const options = info?.options ?? {};
  if (!options.validator) return 'validateur des produits absent';
  if (
    canonicalJson(options.validator) !==
    canonicalJson(PRODUCT_BATCH_GUARD_VALIDATOR)
  ) {
    return 'validateur des produits différent';
  }
  if (options.validationLevel && options.validationLevel !== 'strict') {
    return 'niveau de validation non strict';
  }
  if (options.validationAction && options.validationAction !== 'error') {
    return 'action de validation non bloquante';
  }
  return null;
}

function database(connection: Connection) {
  const db = connection.db;
  if (!db) throw new ProductBatchGuardError('connexion MongoDB non prête');
  return db;
}

async function productsCollectionInfo(
  connection: Connection,
): Promise<CollectionInfo | undefined> {
  const [info] = (await database(connection)
    .listCollections({ name: PRODUCTS_COLLECTION })
    .toArray()) as CollectionInfo[];
  return info;
}

async function listIndexes(
  connection: Connection,
  collection: string,
): Promise<IndexDescription[]> {
  try {
    return (await database(connection)
      .collection(collection)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Raison du refus, ou `null` si la garde est EXACTEMENT en place. */
export async function describeProductBatchGuardProblem(
  connection: Connection,
): Promise<string | null> {
  const problem = validatorProblem(await productsCollectionInfo(connection));
  if (problem) return problem;
  return (
    uniqueIndexProblem(
      await listIndexes(connection, PRODUCT_BATCHES_COLLECTION),
      PRODUCT_BATCH_REFERENCE_INDEX_KEY,
      'des références de lots',
    ) ??
    uniqueIndexProblem(
      await listIndexes(connection, PRODUCT_BATCH_OPERATIONS_COLLECTION),
      PRODUCT_BATCH_OPERATION_INDEX_KEY,
      'des opérations de lots',
    ) ??
    // Lot B : une demande de régularisation par opération de vente.
    uniqueIndexProblem(
      await listIndexes(connection, SALE_REGULARIZATION_REQUESTS_COLLECTION),
      SALE_REGULARIZATION_REQUEST_INDEX_KEY,
      'des demandes de régularisation',
    ) ??
    // Lot C : historique des pertes (par produit, par période).
    plainIndexProblem(
      await listIndexes(connection, STOCK_LOSSES_COLLECTION),
      [STOCK_LOSS_PRODUCT_INDEX_KEY, STOCK_LOSS_PERIOD_INDEX_KEY],
      'des pertes',
    )
  );
}

export async function verifyProductBatchGuard(
  connection: Connection,
): Promise<void> {
  const problem = await describeProductBatchGuardProblem(connection);
  if (problem) throw new ProductBatchGuardError(problem);
}

/**
 * Idempotent : installe le validateur (création de la collection si besoin,
 * sinon `collMod`) et les deux index uniques, puis revérifie. Un validateur
 * différent déjà présent provoque un échec, sans rien écraser.
 */
export async function ensureProductBatchGuard(
  connection: Connection,
): Promise<'already-present' | 'installed'> {
  if (!(await describeProductBatchGuardProblem(connection))) {
    return 'already-present';
  }
  const db = database(connection);
  const info = await productsCollectionInfo(connection);
  const validation = {
    validator: PRODUCT_BATCH_GUARD_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
  } as const;
  if (!info) {
    await db.createCollection(PRODUCTS_COLLECTION, validation);
  } else {
    const current = info.options?.validator;
    const empty =
      !current ||
      (typeof current === 'object' && Object.keys(current).length === 0);
    if (
      !empty &&
      canonicalJson(current) !== canonicalJson(PRODUCT_BATCH_GUARD_VALIDATOR)
    ) {
      throw new ProductBatchGuardError(
        'un autre validateur existe déjà sur les produits (non écrasé)',
      );
    }
    await db.command({ collMod: PRODUCTS_COLLECTION, ...validation });
  }
  await db
    .collection(PRODUCT_BATCHES_COLLECTION)
    .createIndex({ ...PRODUCT_BATCH_REFERENCE_INDEX_KEY }, { unique: true });
  await db
    .collection(PRODUCT_BATCH_OPERATIONS_COLLECTION)
    .createIndex({ ...PRODUCT_BATCH_OPERATION_INDEX_KEY }, { unique: true });
  await db
    .collection(SALE_REGULARIZATION_REQUESTS_COLLECTION)
    .createIndex(
      { ...SALE_REGULARIZATION_REQUEST_INDEX_KEY },
      { unique: true },
    );
  await db
    .collection(STOCK_LOSSES_COLLECTION)
    .createIndex({ ...STOCK_LOSS_PRODUCT_INDEX_KEY });
  await db
    .collection(STOCK_LOSSES_COLLECTION)
    .createIndex({ ...STOCK_LOSS_PERIOD_INDEX_KEY });
  await verifyProductBatchGuard(connection);
  return 'installed';
}

/**
 * Retrait du SEUL validateur (retour arrière), refusé tant qu'un produit est
 * suivi par lots : la garde ne peut jamais être levée sous un stock réparti.
 * Les index restent (sans effet sur une API antérieure).
 */
export async function removeProductBatchValidator(
  connection: Connection,
): Promise<'removed' | 'absent'> {
  const db = database(connection);
  const tracked = await db
    .collection(PRODUCTS_COLLECTION)
    .countDocuments({ stockTracking: 'batches' });
  if (tracked > 0) {
    throw new ProductBatchGuardError(
      `${tracked} produit(s) suivi(s) par lots : validateur conservé`,
    );
  }
  const info = await productsCollectionInfo(connection);
  if (!info?.options?.validator) return 'absent';
  if (validatorProblem(info) === 'validateur des produits différent') {
    throw new ProductBatchGuardError(
      'validateur des produits inconnu (non retiré)',
    );
  }
  await db.command({ collMod: PRODUCTS_COLLECTION, validator: {} });
  return 'removed';
}
