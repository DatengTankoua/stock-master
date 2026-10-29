import type { Connection } from 'mongoose';
import { PLATFORM_ADMIN_COLLECTIONS } from './platform-admin-store';
import {
  checkIndexSpecs,
  ensureIndexSpecs,
  type PlatformAdminIndexSpec,
} from './platform-admin-indexes';

/**
 * Index des notifications internes de l'administration, en DEUX groupes :
 *
 * - REQUIS (garanties) : unicité de l'événement (`eventKey`) et de l'état
 *   de lecture `{userId, notificationId}`, liste et compteur filtrés par
 *   catégorie. Absents : routes des notifications en 503 et collecte
 *   suspendue ; le reste de l'administration et les commerces ne sont PAS
 *   affectés (index vérifiés séparément de `PLATFORM_ADMIN_INDEXES`).
 * - PERFORMANCE (collections métier balayées) : sans eux, la collecte
 *   fonctionne mais parcourt davantage de documents. Jamais vérifiés à
 *   l'exécution.
 *
 * Créés par la migration `create-platform-admin-notification-indexes`
 * (pré-déploiement), idempotente : rien n'est écrasé si un index homonyme
 * diffère (échec). Aucune donnée lue ni écrite, aucune notification créée.
 */
export const PLATFORM_ADMIN_NOTIFICATION_INDEXES: readonly PlatformAdminIndexSpec[] =
  Object.freeze<PlatformAdminIndexSpec[]>([
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.notifications,
      name: 'eventKey_1_unique',
      key: { eventKey: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.notifications,
      name: 'category_1_createdAt_-1__id_-1',
      key: { category: 1, createdAt: -1, _id: -1 },
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.notificationReads,
      name: 'userId_1_notificationId_1_unique',
      key: { userId: 1, notificationId: 1 },
      unique: true,
    },
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.notificationReads,
      name: 'userId_1_category_1_notificationCreatedAt_-1',
      key: { userId: 1, category: 1, notificationCreatedAt: -1 },
    },
  ]);

export const PLATFORM_ADMIN_NOTIFICATION_SOURCE_INDEXES: readonly PlatformAdminIndexSpec[] =
  Object.freeze<PlatformAdminIndexSpec[]>([
    // Paiements confirmés, par date de confirmation.
    {
      collection: 'subscription_payments',
      name: 'status_1_confirmedAt_1',
      key: { status: 1, confirmedAt: 1 },
    },
    // Paiements à examiner, par dernière modification.
    {
      collection: 'subscription_payments',
      name: 'status_1_updatedAt_1',
      key: { status: 1, updatedAt: 1 },
    },
    // Campagnes lancées (fin du traitement, audience partielle).
    {
      collection: PLATFORM_ADMIN_COLLECTIONS.campaigns,
      name: 'status_1_launchedAt_1',
      key: { status: 1, launchedAt: 1 },
    },
    // `organizations.createdAt_-1` (administration) et le TTL
    // `support_requests.createdAt` servent déjà les deux autres sources.
  ]);

export function checkPlatformAdminNotificationIndexes(
  connection: Connection,
): Promise<string[]> {
  return checkIndexSpecs(connection, PLATFORM_ADMIN_NOTIFICATION_INDEXES);
}

export async function ensurePlatformAdminNotificationIndexes(
  connection: Connection,
): Promise<{ created: string[]; present: string[] }> {
  const required = await ensureIndexSpecs(
    connection,
    PLATFORM_ADMIN_NOTIFICATION_INDEXES,
  );
  const sources = await ensureIndexSpecs(
    connection,
    PLATFORM_ADMIN_NOTIFICATION_SOURCE_INDEXES,
  );
  return {
    created: [...required.created, ...sources.created],
    present: [...required.present, ...sources.present],
  };
}
