/**
 * Lot C — alertes de péremption : index et planification initiale. N'est
 * PAS lancé par le pré-déploiement ; prérequis de `EXPIRY_ALERTS_ENABLED`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:expiry-alerts [-- --organizations=<id,id>]
 *   MONGODB_URI=... pnpm --filter api migrate:expiry-alerts -- --apply
 *
 * - Sans `--apply` : inventaire en lecture seule (cibles datées, cibles à
 *   planifier, index présents) et premières alertes prévisibles par
 *   commerce (agrégat ; détail des commerces pilotes de `--organizations`,
 *   par position dans la liste).
 * - `--apply` (idempotent) :
 *   1. index PARTIELS sur `products` et `productbatches` (cibles en stock
 *      planifiées seulement) : `expiry_alert_due` (`{ expiryAlertNextOn,
 *      _id }`, portée `all`) et `expiry_alert_due_org` (`{ organizationId,
 *      expiryAlertNextOn, _id }`, commerces pilotes filtrés dans la requête) ;
 *   2. première date de contrôle (`expiryAlertNextOn`) des cibles datées
 *      jamais planifiées (champ absent) : produits SANS lots avec une date,
 *      lots avec une date. Délai du commerce (30 j par défaut). Une cible
 *      déjà dépassée ne recevra que l'alerte « périmé ».
 * Aucune donnée existante n'est modifiée au-delà de ce champ. Ne journalise
 * jamais l'URI, une adresse ni un identifiant.
 */
import { createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import {
  dueExpiryAlert,
  nextExpiryAlertOn,
  normalizeLeadDays,
} from '../products/expiry/expiry-alerts';
import { businessDate } from '../products/batches/business-date';
import {
  EXPIRY_ALERT_INDEXES,
  EXPIRY_ALERT_INDEX_FILTER,
  EXPIRY_ALERT_INDEX_KEY,
  EXPIRY_ALERT_INDEX_NAME,
  EXPIRY_ALERT_ORG_INDEX_KEY,
  EXPIRY_ALERT_ORG_INDEX_NAME,
} from '../products/expiry/expiry-alert-index';

export {
  EXPIRY_ALERT_INDEX_FILTER,
  EXPIRY_ALERT_INDEX_KEY,
  EXPIRY_ALERT_INDEX_NAME,
  EXPIRY_ALERT_ORG_INDEX_KEY,
  EXPIRY_ALERT_ORG_INDEX_NAME,
};
const COLLECTIONS = ['products', 'productbatches'] as const;

/** Filtre des cibles datées jamais planifiées. */
function unplannedFilter(collection: (typeof COLLECTIONS)[number]) {
  return {
    expiryDate: { $type: 'string' },
    expiryAlertNextOn: { $exists: false },
    ...(collection === 'products' ? { stockTracking: { $ne: 'batches' } } : {}),
  };
}

export async function inventoryExpiryAlerts(connection: Connection) {
  const result: Record<string, unknown> = {};
  for (const name of COLLECTIONS) {
    const collection = connection.collection(name);
    const indexes: { name?: string }[] = await collection
      .indexes()
      .catch(() => []);
    result[name] = {
      dated: await collection.countDocuments({
        expiryDate: { $type: 'string' },
      }),
      unplanned: await collection.countDocuments(unplannedFilter(name)),
      // Les deux index requis (tous les commerces ; par commerce pilote).
      index: EXPIRY_ALERT_INDEXES.every((required) =>
        indexes.some((i) => i.name === required.name),
      ),
    };
  }
  return result;
}

/**
 * Premières alertes PRÉVISIBLES (lecture seule) : cibles qui recevraient
 * une alerte au premier balayage (« bientôt » ou « périmé »), selon le
 * jour du commerce et le délai de chaque commerce. Agrégat sur tous les
 * commerces (nombre de commerces, total, maximum par commerce) et, pour
 * les commerces pilotes fournis, détail par POSITION dans la liste (jamais
 * un identifiant journalisé).
 */
export async function firstAlertInventory(
  connection: Connection,
  pilotOrganizationIds: string[] = [],
  now: Date = new Date(),
) {
  const today = businessDate(now);
  const perOrg = new Map<string, { soon: number; expired: number }>();
  const leads = new Map<string, number>();
  const leadOf = async (organizationId: Types.ObjectId) => {
    const key = organizationId.toHexString();
    if (!leads.has(key)) {
      const org = await connection
        .collection('organizations')
        .findOne(
          { _id: organizationId },
          { projection: { expiryAlertLeadDays: 1 } },
        );
      leads.set(key, normalizeLeadDays(org?.expiryAlertLeadDays));
    }
    return leads.get(key)!;
  };
  const count = async (row: {
    organizationId: Types.ObjectId;
    expiryDate: string;
    expiryAlerts?: { soonFor?: string; expiredFor?: string };
  }) => {
    const due = dueExpiryAlert(
      row.expiryDate,
      today,
      await leadOf(row.organizationId),
      row.expiryAlerts,
    );
    if (!due) return;
    const key = row.organizationId.toHexString();
    const entry = perOrg.get(key) ?? { soon: 0, expired: 0 };
    entry[due.stage === 'soon' ? 'soon' : 'expired'] += 1;
    perOrg.set(key, entry);
  };
  const products = connection.collection('products');
  const activeTracked = new Set<string>();
  for await (const p of products.find(
    { deletedAt: null, stockTracking: 'batches' },
    { projection: { _id: 1 } },
  )) {
    activeTracked.add(String(p._id));
  }
  for await (const row of products.find(
    {
      deletedAt: null,
      stockTracking: { $ne: 'batches' },
      expiryDate: { $type: 'string' },
      remainingQuantity: { $gt: 0 },
    },
    { projection: { organizationId: 1, expiryDate: 1, expiryAlerts: 1 } },
  )) {
    await count(row as never);
  }
  for await (const row of connection.collection('productbatches').find(
    { expiryDate: { $type: 'string' }, remainingQuantity: { $gt: 0 } },
    {
      projection: {
        organizationId: 1,
        productId: 1,
        expiryDate: 1,
        expiryAlerts: 1,
      },
    },
  )) {
    if (!activeTracked.has(String(row.productId))) continue;
    await count(row as never);
  }
  const totals = [...perOrg.values()].map((v) => v.soon + v.expired);
  return {
    businessDate: today,
    organizations: perOrg.size,
    soon: [...perOrg.values()].reduce((s, v) => s + v.soon, 0),
    expired: [...perOrg.values()].reduce((s, v) => s + v.expired, 0),
    maxPerOrganization: totals.length ? Math.max(...totals) : 0,
    pilots: pilotOrganizationIds.map((id, index) => ({
      pilot: index + 1,
      ...(perOrg.get(id.toLowerCase()) ?? { soon: 0, expired: 0 }),
    })),
  };
}

export async function installExpiryAlerts(
  connection: Connection,
): Promise<{ planned: number }> {
  for (const name of COLLECTIONS) {
    for (const required of EXPIRY_ALERT_INDEXES) {
      await connection.collection(name).createIndex(
        { ...required.key },
        {
          name: required.name,
          partialFilterExpression: { ...EXPIRY_ALERT_INDEX_FILTER },
        },
      );
    }
  }
  const leads = new Map<string, number>();
  const leadOf = async (organizationId: Types.ObjectId) => {
    const key = organizationId.toHexString();
    if (!leads.has(key)) {
      const org = await connection
        .collection('organizations')
        .findOne(
          { _id: organizationId },
          { projection: { expiryAlertLeadDays: 1 } },
        );
      leads.set(key, normalizeLeadDays(org?.expiryAlertLeadDays));
    }
    return leads.get(key)!;
  };
  let planned = 0;
  for (const name of COLLECTIONS) {
    const collection = connection.collection(name);
    const cursor = collection.find(unplannedFilter(name), {
      projection: { organizationId: 1, expiryDate: 1, expiryAlerts: 1 },
    });
    for await (const row of cursor) {
      const next = nextExpiryAlertOn(
        row.expiryDate as string,
        await leadOf(row.organizationId as Types.ObjectId),
        row.expiryAlerts as { soonFor?: string; expiredFor?: string },
      );
      const written = await collection.updateOne(
        { _id: row._id, expiryAlertNextOn: { $exists: false } },
        { $set: { expiryAlertNextOn: next } },
      );
      planned += written.modifiedCount;
    }
  }
  return { planned };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const pilotsArg = args.find((a) => a.startsWith('--organizations='));
  const pilots = pilotsArg
    ? pilotsArg
        .slice('--organizations='.length)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
  if (
    args.some((a) => a !== '--apply' && !a.startsWith('--organizations=')) ||
    pilots.some((id) => !/^[0-9a-fA-F]{24}$/.test(id))
  ) {
    console.error('Usage : [--organizations=<id,id>] [--apply]');
    process.exitCode = 2;
    return;
  }
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    console.log(JSON.stringify(await inventoryExpiryAlerts(connection)));
    // Premières alertes prévisibles (lecture seule, aucun identifiant).
    console.log(JSON.stringify(await firstAlertInventory(connection, pilots)));
    if (!args.includes('--apply')) {
      console.log('Aperçu : aucune écriture (ajouter --apply).');
      return;
    }
    const { planned } = await installExpiryAlerts(connection);
    console.log(`Index installés ; ${planned} cible(s) planifiée(s).`);
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des alertes de péremption échouée :',
      error instanceof Error ? error.name : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
