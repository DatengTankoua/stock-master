import type { Connection } from 'mongoose';

/**
 * Lot C — index partiels du planificateur des alertes de péremption,
 * installés par `migrate:expiry-alerts -- --apply` et VÉRIFIÉS avant chaque
 * balayage : sans eux, le balayage ne s'exécute pas (aucun parcours massif
 * de secours) et l'erreur est journalisée.
 *
 * - `expiry_alert_due` : balayage de tous les commerces (portée `all`) ;
 * - `expiry_alert_due_org` : balayage d'un commerce pilote, filtré dans la
 *   requête (les cibles des autres commerces ne sont pas lues).
 */
export const EXPIRY_ALERT_INDEX_NAME = 'expiry_alert_due';
export const EXPIRY_ALERT_INDEX_KEY = Object.freeze({
  expiryAlertNextOn: 1,
  _id: 1,
} as const);
export const EXPIRY_ALERT_ORG_INDEX_NAME = 'expiry_alert_due_org';
export const EXPIRY_ALERT_ORG_INDEX_KEY = Object.freeze({
  organizationId: 1,
  expiryAlertNextOn: 1,
  _id: 1,
} as const);
export const EXPIRY_ALERT_INDEX_FILTER = Object.freeze({
  remainingQuantity: { $gt: 0 },
  expiryAlertNextOn: { $type: 'string' },
});
export const EXPIRY_ALERT_COLLECTIONS = ['products', 'productbatches'] as const;
/** Index requis sur chaque collection de `EXPIRY_ALERT_COLLECTIONS`. */
export const EXPIRY_ALERT_INDEXES = [
  { name: EXPIRY_ALERT_INDEX_NAME, key: EXPIRY_ALERT_INDEX_KEY },
  { name: EXPIRY_ALERT_ORG_INDEX_NAME, key: EXPIRY_ALERT_ORG_INDEX_KEY },
] as const;

interface IndexInfo {
  name?: string;
  key?: Record<string, unknown>;
  partialFilterExpression?: unknown;
}

/** Raison de l'absence (collection : problème), ou `null` si tout est en place. */
export async function describeExpiryAlertIndexProblem(
  connection: Connection,
): Promise<string | null> {
  const db = connection.db;
  if (!db) return 'connexion MongoDB non prête';
  for (const name of EXPIRY_ALERT_COLLECTIONS) {
    const indexes = (await db
      .collection(name)
      .indexes()
      .catch(() => [])) as IndexInfo[];
    for (const required of EXPIRY_ALERT_INDEXES) {
      const index = indexes.find((i) => i.name === required.name);
      if (!index) return `${name} : index ${required.name} absent`;
      const key = Object.entries(index.key ?? {});
      const expected = Object.entries(required.key);
      if (
        key.length !== expected.length ||
        expected.some(([f, d], i) => key[i][0] !== f || key[i][1] !== d) ||
        !index.partialFilterExpression
      ) {
        return `${name} : index ${required.name} mal configuré`;
      }
    }
  }
  return null;
}
