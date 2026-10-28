import type { Connection } from 'mongoose';
import {
  MARKETING_CONSENTS_COLLECTION,
  MARKETING_CONSENT_EVENTS_COLLECTION,
  MARKETING_CONSENT_WORDINGS_COLLECTION,
} from './schemas/marketing-consent.schema';

/**
 * Index de lecture des preuves (`{ userId, at }` : historique d'un compte).
 * L'unicité de l'état courant et d'un libellé archivé repose sur `_id`
 * (natif) : cet index n'est pas requis pour l'exactitude et n'est pas
 * vérifié au démarrage. La migration crée aussi les trois collections, pour
 * que les premières écritures, faites en transaction, n'en dépendent pas.
 *
 * Aucune donnée lue ni écrite : aucun utilisateur n'est inscrit.
 */
export const MARKETING_CONSENT_EVENTS_INDEX_NAME = 'userId_1_at_-1';

const NAMESPACE_NOT_FOUND = 26;
const NAMESPACE_EXISTS = 48;

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export function describeMarketingConsentIndexProblem(
  indexes: readonly IndexDescription[],
): string | null {
  const index = indexes.find(
    (i) => i.name === MARKETING_CONSENT_EVENTS_INDEX_NAME,
  );
  if (!index) return 'index userId absent';
  const key = Object.entries(index.key);
  if (
    key.length !== 2 ||
    key[0][0] !== 'userId' ||
    key[0][1] !== 1 ||
    key[1][0] !== 'at' ||
    key[1][1] !== -1
  ) {
    return 'clé inattendue';
  }
  if (index.unique || index.expireAfterSeconds !== undefined) {
    return 'options inattendues';
  }
  return null;
}

async function listIndexes(
  connection: Connection,
): Promise<IndexDescription[]> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  try {
    return (await db
      .collection(MARKETING_CONSENT_EVENTS_COLLECTION)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Vérification en LECTURE SEULE (`listIndexes` uniquement). */
export async function checkMarketingConsentIndexes(
  connection: Connection,
): Promise<string | null> {
  return describeMarketingConsentIndexProblem(await listIndexes(connection));
}

export async function ensureMarketingConsentIndexes(
  connection: Connection,
): Promise<'already-present' | 'created'> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  for (const name of [
    MARKETING_CONSENTS_COLLECTION,
    MARKETING_CONSENT_EVENTS_COLLECTION,
    MARKETING_CONSENT_WORDINGS_COLLECTION,
  ]) {
    try {
      await db.createCollection(name);
    } catch (error) {
      if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS) throw error;
    }
  }
  if (!describeMarketingConsentIndexProblem(await listIndexes(connection))) {
    return 'already-present';
  }
  await db
    .collection(MARKETING_CONSENT_EVENTS_COLLECTION)
    .createIndex(
      { userId: 1, at: -1 },
      { name: MARKETING_CONSENT_EVENTS_INDEX_NAME },
    );
  const problem = describeMarketingConsentIndexProblem(
    await listIndexes(connection),
  );
  if (problem) {
    throw new Error(`Index marketing_consent_events invalide : ${problem}`);
  }
  return 'created';
}
