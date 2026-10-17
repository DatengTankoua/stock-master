/**
 * Date de péremption et seuil de stock faible — inventaire (lecture seule)
 * et, pour un RETOUR ARRIÈRE seulement, retrait des deux permissions
 * délégables `products.manage_expiry` et `stock.manage_thresholds`.
 *
 * Aucune migration n'est nécessaire au déploiement : les champs produit
 * (`expiryDate`, `lowStockThreshold`) sont facultatifs et absents des
 * produits existants (règle par défaut, aucune date) ; aucune permission
 * n'est attribuée implicitement.
 *
 * Retour arrière vers une API antérieure :
 * - elle REFUSE ces permissions à la validation : toute écriture d'une
 *   membership ou d'une invitation qui les porte échouerait. Les SEULES
 *   collections concernées sont `organizationmemberships` et
 *   `organizationinvitations` (même périmètre que 1-19A) ;
 * - les champs produit restent en base sans effet : une API antérieure ne
 *   les lit ni ne les expose (projection par liste blanche), ses écritures
 *   ciblées ne les effacent pas. Les seuils personnalisés cessent d'être
 *   appliqués (règle par défaut) jusqu'au redéploiement de cette version.
 *   Ils sont comptés ici, jamais supprimés.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:product-field-permissions
 *   MONGODB_URI=... pnpm --filter api migrate:product-field-permissions --strip
 *   MONGODB_URI=... pnpm --filter api migrate:product-field-permissions --strip --apply
 *
 * - Sans option : INVENTAIRE en lecture seule.
 * - `--strip` : aperçu du retrait, aucune écriture.
 * - `--strip --apply` : retrait (`$pull`) idempotent dans les deux
 *   collections, à exécuter QU'AVANT de redéployer une API antérieure.
 * - Ne journalise jamais l'URI, une adresse ni un identifiant.
 */
import { createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import { INVITATIONS_COLLECTION } from '../organizations/invitation-account-index';

export const PRODUCT_FIELD_PERMISSIONS = [
  'products.manage_expiry',
  'stock.manage_thresholds',
] as const;
export const MEMBERSHIPS_COLLECTION = 'organizationmemberships';
export const PRODUCTS_COLLECTION = 'products';

interface PermissionHolder {
  permissions: string[];
}

const carrying = { permissions: { $in: [...PRODUCT_FIELD_PERMISSIONS] } };

export interface ProductFieldInventory {
  memberships: Record<string, number>;
  invitations: Record<string, number>;
  products: { withExpiryDate: number; withLowStockThreshold: number };
}

async function countPerPermission(
  connection: Connection,
  collection: string,
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    PRODUCT_FIELD_PERMISSIONS.map(
      async (permission) =>
        [
          permission,
          await connection
            .collection(collection)
            .countDocuments({ permissions: permission }),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Inventaire en lecture seule. */
export async function inventoryProductFields(
  connection: Connection,
): Promise<ProductFieldInventory> {
  const products = connection.collection(PRODUCTS_COLLECTION);
  const [memberships, invitations, withExpiryDate, withLowStockThreshold] =
    await Promise.all([
      countPerPermission(connection, MEMBERSHIPS_COLLECTION),
      countPerPermission(connection, INVITATIONS_COLLECTION),
      products.countDocuments({ expiryDate: { $type: 'string' } }),
      products.countDocuments({ lowStockThreshold: { $type: 'number' } }),
    ]);
  return {
    memberships,
    invitations,
    products: { withExpiryDate, withLowStockThreshold },
  };
}

/** Retrait des permissions (retour arrière) ; documents modifiés. */
export async function stripProductFieldPermissions(
  connection: Connection,
): Promise<{ memberships: number; invitations: number }> {
  const pull = {
    $pull: { permissions: { $in: [...PRODUCT_FIELD_PERMISSIONS] } },
  };
  const [memberships, invitations] = await Promise.all([
    connection
      .collection<PermissionHolder>(MEMBERSHIPS_COLLECTION)
      .updateMany(carrying, pull),
    connection
      .collection<PermissionHolder>(INVITATIONS_COLLECTION)
      .updateMany(carrying, pull),
  ]);
  return {
    memberships: memberships.modifiedCount,
    invitations: invitations.modifiedCount,
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const strip = args.includes('--strip');
  const apply = args.includes('--apply');
  if (
    args.some((a) => a !== '--strip' && a !== '--apply') ||
    (apply && !strip)
  ) {
    console.error('Usage : [--strip [--apply]]');
    process.exitCode = 2;
    return;
  }
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    console.log(JSON.stringify(await inventoryProductFields(connection)));
    if (!strip) return;
    if (!apply) {
      console.log('Aperçu du retrait : aucune écriture (ajouter --apply).');
      return;
    }
    const removed = await stripProductFieldPermissions(connection);
    console.log(
      `Retrait : ${removed.memberships} membership(s), ${removed.invitations} invitation(s).`,
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Inventaire des permissions produit échoué :',
      error instanceof Error ? error.name : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
