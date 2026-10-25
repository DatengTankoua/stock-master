import type { Connection } from 'mongoose';
import { PLATFORM_ADMIN_COLLECTIONS } from './platform-admin-store';

/**
 * Index de l'administration de la plateforme. Les index uniques portent
 * les garanties (un accès et un facteur par utilisateur, empreintes de
 * jeton et de code uniques) ; les TTL ne font que nettoyer (sessions un
 * jour après leur expiration absolue, challenges à leur échéance).
 *
 * Créés par la migration `create-platform-admin-indexes` (pré-déploiement),
 * idempotente : rien n'est écrasé si un index homonyme diffère (échec).
 * Vérifiés en lecture seule avant d'ouvrir l'espace : sans eux, 503.
 * L'audit n'a PAS de TTL (rétention à décider par l'exploitant).
 */
export interface PlatformAdminIndexSpec {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export const SESSION_TTL_GRACE_SECONDS = 86_400;

export const PLATFORM_ADMIN_INDEXES: readonly PlatformAdminIndexSpec[] =
  Object.freeze<PlatformAdminIndexSpec[]>([
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.grants,
      name: 'userId_1_unique',
      key: { userId: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.factors,
      name: 'userId_1_unique',
      key: { userId: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.recoveryCodes,
      name: 'userId_1_codeHash_1_unique',
      key: { userId: 1, codeHash: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.recoveryCodes,
      name: 'userId_1_batch_1',
      key: { userId: 1, batch: 1 },
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.sessions,
      name: 'tokenHash_1_unique',
      key: { tokenHash: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.sessions,
      name: 'userId_1',
      key: { userId: 1 },
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.sessions,
      name: 'absoluteExpiresAt_1_ttl',
      key: { absoluteExpiresAt: 1 },
      expireAfterSeconds: SESSION_TTL_GRACE_SECONDS,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.challenges,
      name: 'tokenHash_1_unique',
      key: { tokenHash: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.challenges,
      name: 'expiresAt_1_ttl',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.audit,
      name: 'at_-1',
      key: { at: -1 },
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.audit,
      name: 'action_1_at_-1',
      key: { action: 1, at: -1 },
    },
    // Historique des actions d'une organisation (fiche), plus récentes d'abord.
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.operations,
      name: 'organizationId_1_createdAt_-1',
      key: { organizationId: 1, createdAt: -1 },
    },
    // Liste des organisations (tri par inscription) et inscriptions
    // récentes de la vue d'ensemble : seul index ajouté à une collection
    // métier.
    {
      collection: 'organizations',
      name: 'createdAt_-1',
      key: { createdAt: -1 },
    },
  ]);

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
}

const NAMESPACE_NOT_FOUND = 26;

function sameKey(
  actual: Record<string, unknown>,
  expected: Record<string, 1 | -1>,
): boolean {
  const a = Object.entries(actual);
  const e = Object.entries(expected);
  return (
    a.length === e.length &&
    a.every(([field, dir], i) => field === e[i][0] && dir === e[i][1])
  );
}

/** `null` si l'index existe à l'identique ; sinon le problème. */
export function describeIndexProblem(
  spec: PlatformAdminIndexSpec,
  indexes: readonly IndexDescription[],
): 'absent' | 'différent' | null {
  const index = indexes.find((i) => i.name === spec.name);
  if (!index) return 'absent';
  if (
    !sameKey(index.key, spec.key) ||
    Boolean(index.unique) !== Boolean(spec.unique) ||
    index.expireAfterSeconds !== spec.expireAfterSeconds ||
    index.partialFilterExpression !== undefined
  ) {
    return 'différent';
  }
  return null;
}

async function listIndexes(
  connection: Connection,
  collection: string,
): Promise<IndexDescription[]> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  try {
    return (await db
      .collection(collection)
      .listIndexes()
      .toArray()) as IndexDescription[];
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Lecture seule : liste des problèmes (vide si tout est en place). */
export async function checkPlatformAdminIndexes(
  connection: Connection,
): Promise<string[]> {
  const problems: string[] = [];
  const cache = new Map<string, IndexDescription[]>();
  for (const spec of PLATFORM_ADMIN_INDEXES) {
    if (!cache.has(spec.collection)) {
      cache.set(
        spec.collection,
        await listIndexes(connection, spec.collection),
      );
    }
    const problem = describeIndexProblem(spec, cache.get(spec.collection)!);
    if (problem) problems.push(`${spec.collection}.${spec.name} ${problem}`);
  }
  return problems;
}

/** Crée les index manquants ; échoue sans rien écraser si l'un diffère. */
export async function ensurePlatformAdminIndexes(
  connection: Connection,
): Promise<{ created: string[]; present: string[] }> {
  const db = connection.db;
  if (!db) throw new Error('connexion MongoDB non prête');
  const created: string[] = [];
  const present: string[] = [];
  for (const spec of PLATFORM_ADMIN_INDEXES) {
    const label = `${spec.collection}.${spec.name}`;
    const problem = describeIndexProblem(
      spec,
      await listIndexes(connection, spec.collection),
    );
    if (problem === null) {
      present.push(label);
      continue;
    }
    if (problem === 'différent') {
      throw new Error(
        `Index ${label} existant mais différent : aucune modification.`,
      );
    }
    await db.collection(spec.collection).createIndex(spec.key, {
      name: spec.name,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.expireAfterSeconds !== undefined
        ? { expireAfterSeconds: spec.expireAfterSeconds }
        : {}),
    });
    created.push(label);
  }
  const remaining = await checkPlatformAdminIndexes(connection);
  if (remaining.length > 0) {
    throw new Error(`Index invalides après création : ${remaining.join(', ')}`);
  }
  return { created, present };
}
