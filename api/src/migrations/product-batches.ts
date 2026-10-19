/**
 * Suivi par lots (lot A) — inventaire, installation de la garde et outils
 * de retour arrière. N'est PAS lancé par le pré-déploiement : aucune
 * écriture tant qu'un opérateur ne le demande pas explicitement.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:product-batches
 *   MONGODB_URI=... pnpm --filter api migrate:product-batches -- --install [--apply]
 *   MONGODB_URI=... pnpm --filter api migrate:product-batches -- --strip-permission [--apply]
 *   MONGODB_URI=... pnpm --filter api migrate:product-batches -- --remove-validator [--apply]
 *
 * - Sans option : INVENTAIRE en lecture seule (produits suivis, lots,
 *   permission accordée, état de la garde).
 * - `--install --apply` : validateur de `products` et index uniques des
 *   lots et des opérations (idempotent). PRÉREQUIS de toute activation
 *   (l'API refuse l'activation sans eux).
 * - `--strip-permission --apply` : retrait de TOUTES les permissions des
 *   lots A à C (dont `stock.manage_batches`) des memberships et
 *   invitations, AVANT de redéployer une API antérieure aux lots.
 * - `--strip-lot-c-permissions --apply` : retrait des SEULES permissions du
 *   lot C (`stock.quarantine_batches`, `stock.record_losses`,
 *   `products.manage_expiry_alerts`), avant de redéployer une API du lot B
 *   (qui refuserait ces permissions et garde `stock.manage_batches`).
 * - `--remove-validator --apply` : retrait du validateur, REFUSÉ tant qu'un
 *   produit est suivi par lots.
 * Sans `--apply` : aperçu, aucune écriture. Ne journalise jamais l'URI, une
 * adresse ni un identifiant.
 */
import { createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import { INVITATIONS_COLLECTION } from '../organizations/invitation-account-index';
import {
  PRODUCTS_COLLECTION,
  ProductBatchGuardError,
  describeProductBatchGuardProblem,
  ensureProductBatchGuard,
  removeProductBatchValidator,
} from '../products/batches/product-batch-guard';
import { PRODUCT_BATCHES_COLLECTION } from '../products/batches/schemas/product-batch.schema';
import { PRODUCT_BATCH_OPERATIONS_COLLECTION } from '../products/batches/schemas/product-batch-operation.schema';
import { STOCK_LOSSES_COLLECTION } from '../products/batches/schemas/stock-loss.schema';

export const BATCH_PERMISSION = 'stock.manage_batches';
/**
 * Permissions des lots A à C : toutes retirées par `--strip-permission`
 * avant de redéployer une API qui ne les connaît pas (elle les refuserait).
 */
export const LOT_C_PERMISSIONS = [
  'stock.quarantine_batches',
  'stock.record_losses',
  'products.manage_expiry_alerts',
];
export const LOT_PERMISSIONS = [BATCH_PERMISSION, ...LOT_C_PERMISSIONS];
const MEMBERSHIPS_COLLECTION = 'organizationmemberships';

export interface ProductBatchInventory {
  trackedProducts: number;
  batches: number;
  operations: number;
  /**
   * Pertes enregistrées (lot C). Non nul : AUCUN retour vers une API
   * antérieure au lot C (sa purge compterait ces pertes comme vendues).
   */
  losses: number;
  permission: { memberships: number; invitations: number };
  guard: string;
}

export async function inventoryProductBatches(
  connection: Connection,
): Promise<ProductBatchInventory> {
  const count = (collection: string, filter: object = {}) =>
    connection.collection(collection).countDocuments(filter);
  const [
    trackedProducts,
    batches,
    operations,
    losses,
    memberships,
    invitations,
  ] = await Promise.all([
    count(PRODUCTS_COLLECTION, { stockTracking: 'batches' }),
    count(PRODUCT_BATCHES_COLLECTION),
    count(PRODUCT_BATCH_OPERATIONS_COLLECTION),
    count(STOCK_LOSSES_COLLECTION),
    count(MEMBERSHIPS_COLLECTION, {
      permissions: { $in: LOT_PERMISSIONS },
    }),
    count(INVITATIONS_COLLECTION, {
      permissions: { $in: LOT_PERMISSIONS },
    }),
  ]);
  const problem = await describeProductBatchGuardProblem(connection);
  return {
    trackedProducts,
    batches,
    operations,
    losses,
    permission: { memberships, invitations },
    guard: problem ?? 'installée',
  };
}

/**
 * Retire des memberships et invitations les permissions `permissions` :
 * toutes celles des lots A à C (`--strip-permission`, retour avant A), ou
 * SEULEMENT celles du lot C (`--strip-lot-c-permissions`, retour vers une
 * API du lot B qui garde `stock.manage_batches`).
 */
export async function stripBatchPermission(
  connection: Connection,
  permissions: readonly string[] = LOT_PERMISSIONS,
): Promise<{ memberships: number; invitations: number }> {
  const filter = { permissions: { $in: [...permissions] } };
  const pull = { $pull: { permissions: { $in: [...permissions] } } };
  const [memberships, invitations] = await Promise.all([
    connection
      .collection<{ permissions: string[] }>(MEMBERSHIPS_COLLECTION)
      .updateMany(filter, pull),
    connection
      .collection<{ permissions: string[] }>(INVITATIONS_COLLECTION)
      .updateMany(filter, pull),
  ]);
  return {
    memberships: memberships.modifiedCount,
    invitations: invitations.modifiedCount,
  };
}

const ACTIONS = [
  '--install',
  '--strip-permission',
  '--strip-lot-c-permissions',
  '--remove-validator',
];

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const apply = args.includes('--apply');
  const actions = args.filter((a) => ACTIONS.includes(a));
  if (
    args.some((a) => a !== '--apply' && !ACTIONS.includes(a)) ||
    actions.length > 1 ||
    (apply && actions.length === 0)
  ) {
    console.error(
      'Usage : [--install | --strip-permission | --strip-lot-c-permissions | --remove-validator] [--apply]',
    );
    process.exitCode = 2;
    return;
  }
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    console.log(JSON.stringify(await inventoryProductBatches(connection)));
    const [action] = actions;
    if (!action) return;
    if (!apply) {
      console.log(`Aperçu (${action}) : aucune écriture (ajouter --apply).`);
      return;
    }
    if (action === '--install') {
      console.log(`Garde : ${await ensureProductBatchGuard(connection)}.`);
    } else if (
      action === '--strip-permission' ||
      action === '--strip-lot-c-permissions'
    ) {
      const removed = await stripBatchPermission(
        connection,
        action === '--strip-permission' ? LOT_PERMISSIONS : LOT_C_PERMISSIONS,
      );
      console.log(
        `Retrait : ${removed.memberships} membership(s), ${removed.invitations} invitation(s).`,
      );
    } else {
      console.log(
        `Validateur : ${await removeProductBatchValidator(connection)}.`,
      );
    }
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration du suivi par lots échouée :',
      error instanceof ProductBatchGuardError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
