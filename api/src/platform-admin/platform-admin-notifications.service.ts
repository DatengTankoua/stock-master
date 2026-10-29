import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Types, type mongo } from 'mongoose';
import { PlatformAdminRuntime } from './platform-admin-runtime';
import {
  adminUnavailable,
  PlatformAdminErrorCode,
} from './platform-admin-errors';
import { checkPlatformAdminNotificationIndexes } from './platform-admin-notification-indexes';
import { PLATFORM_ADMIN_COLLECTIONS } from './platform-admin-store';
import type { PlatformAdminRequestContext } from './platform-admin.service';
import {
  MARK_ALL_BATCH,
  MARK_ALL_MAX,
  NOTIFICATION_PAGE_SIZE,
  TYPE_CATEGORY,
  toNotificationView,
  visibleCategories,
  type NotificationTargetKind,
  type NotificationView,
  type PlatformAdminNotificationDoc,
  type PlatformAdminNotificationReadDoc,
} from './platform-admin-notifications';

/** Nouvelle vérification des index après un échec (pas à chaque requête). */
const INDEX_RECHECK_MS = 60_000;
const DUPLICATE_KEY = 11000;

export type NotificationFilter = 'all' | 'unread';

export interface NotificationPage {
  page: number;
  pageSize: number;
  total: number;
  filter: NotificationFilter;
  unread: number;
  items: NotificationView[];
}

/** Événement à enregistrer (date d'entrée posée par le service). */
export type NotificationEvent = Omit<
  PlatformAdminNotificationDoc,
  '_id' | 'createdAt' | 'category'
>;

const TARGET_COLLECTIONS: Readonly<Record<NotificationTargetKind, string>> =
  Object.freeze({
    organization: 'organizations',
    payment: 'subscription_payments',
    campaign: PLATFORM_ADMIN_COLLECTIONS.campaigns,
  });

function isDuplicateOnly(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    writeErrors?: Array<{ code?: unknown }>;
  };
  if (e.code === DUPLICATE_KEY && !e.writeErrors) return true;
  return (
    Array.isArray(e.writeErrors) &&
    e.writeErrors.length > 0 &&
    e.writeErrors.every((w) => w.code === DUPLICATE_KEY)
  );
}

/**
 * Notifications internes de l'administration : enregistrement idempotent
 * des événements (collecte) et lecture par administrateur.
 *
 * Destinataires : tout administrateur à session complète (MFA), pour les
 * catégories que ses capacités ACTUELLES permettent de consulter
 * (`CATEGORY_CAPABILITY`), à partir de l'attribution de son accès
 * (`grantedAt`). L'identité vient de la session, jamais du navigateur.
 * État de lecture : une ligne par administrateur et notification ; lire ne
 * change rien pour les autres.
 */
@Injectable()
export class PlatformAdminNotificationsService {
  private readonly logger = new Logger('PlatformAdminNotifications');
  private indexesReady = false;
  private lastIndexCheck = 0;

  constructor(private readonly runtime: PlatformAdminRuntime) {}

  private get db() {
    return this.runtime.collections();
  }

  private now(): Date {
    return this.runtime.clock();
  }

  /** Index requis présents (relu au plus une fois par minute s'ils manquent). */
  async ready(): Promise<boolean> {
    if (this.indexesReady) return true;
    const now = Date.now();
    if (
      this.lastIndexCheck !== 0 &&
      now - this.lastIndexCheck < INDEX_RECHECK_MS
    ) {
      return false;
    }
    this.lastIndexCheck = now;
    try {
      const problems = await checkPlatformAdminNotificationIndexes(
        this.runtime.connection,
      );
      if (problems.length > 0) {
        this.logger.warn(
          `Notifications de l'administration suspendues, index absents ou différents (migrate:predeploy) : ${problems.join(', ')}`,
        );
        return false;
      }
      this.indexesReady = true;
      return true;
    } catch {
      this.logger.warn('Vérification des index des notifications impossible.');
      return false;
    }
  }

  private async requireReady(): Promise<void> {
    if (!(await this.ready())) throw adminUnavailable();
  }

  // ─── Enregistrement (collecte) ─────────────────────────────────────────

  /**
   * Upsert par `eventKey` (index unique) : un rejeu, un redémarrage ou deux
   * passes concurrentes ne créent jamais de doublon, et un événement déjà
   * enregistré n'est jamais modifié. Renvoie le nombre de créations.
   */
  async record(events: readonly NotificationEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const createdAt = this.now();
    const operations: mongo.AnyBulkWriteOperation<PlatformAdminNotificationDoc>[] =
      events.map((event) => ({
        updateOne: {
          filter: { eventKey: event.eventKey },
          update: {
            $setOnInsert: {
              eventKey: event.eventKey,
              type: event.type,
              category: TYPE_CATEGORY[event.type],
              occurredAt: event.occurredAt,
              createdAt,
              target: event.target,
              params: event.params,
            },
          },
          upsert: true,
        },
      }));
    try {
      const result = await this.db.notifications.bulkWrite(operations, {
        ordered: false,
      });
      return result.upsertedCount;
    } catch (error) {
      // Création concurrente du même événement : la première gagne.
      if (!isDuplicateOnly(error)) throw error;
      const result = (error as { result?: { upsertedCount?: number } }).result;
      return result?.upsertedCount ?? 0;
    }
  }

  // ─── Lecture par administrateur ────────────────────────────────────────

  private viewer(context: PlatformAdminRequestContext) {
    const user = context.user;
    const since = context.grantedAt;
    // Garde `mfa` : session complète, accès actif relu à cette requête.
    if (!user || !(since instanceof Date)) throw adminUnavailable();
    const categories = visibleCategories(context.capabilities);
    const base: mongo.Filter<PlatformAdminNotificationDoc> = {
      category: { $in: categories },
      createdAt: { $gte: since },
    };
    const reads: mongo.Filter<PlatformAdminNotificationReadDoc> = {
      userId: user._id,
      category: { $in: categories },
      notificationCreatedAt: { $gte: since },
    };
    return { userId: user._id, categories, base, reads };
  }

  async unreadCount(
    context: PlatformAdminRequestContext,
  ): Promise<{ unread: number }> {
    await this.requireReady();
    return { unread: await this.countUnread(this.viewer(context)) };
  }

  private async countUnread(
    viewer: ReturnType<PlatformAdminNotificationsService['viewer']>,
  ): Promise<number> {
    if (viewer.categories.length === 0) return 0;
    // Chaque ligne de lecture recopie catégorie et date de SA notification :
    // même filtre des deux côtés, compteur exact sans jointure.
    const [total, read] = await Promise.all([
      this.db.notifications.countDocuments(viewer.base),
      this.db.notificationReads.countDocuments(viewer.reads),
    ]);
    return Math.max(0, total - read);
  }

  async list(
    context: PlatformAdminRequestContext,
    filter: NotificationFilter,
    page: number,
    pageSize: number = NOTIFICATION_PAGE_SIZE,
  ): Promise<NotificationPage> {
    await this.requireReady();
    const viewer = this.viewer(context);
    const empty = {
      page,
      pageSize,
      total: 0,
      filter,
      unread: 0,
      items: [],
    };
    if (viewer.categories.length === 0) return empty;
    const skip = (page - 1) * pageSize;
    const unread = await this.countUnread(viewer);
    let docs: PlatformAdminNotificationDoc[];
    let total: number;
    if (filter === 'unread') {
      total = unread;
      docs = await this.db.notifications
        .aggregate<PlatformAdminNotificationDoc>([
          { $match: viewer.base },
          { $sort: { createdAt: -1, _id: -1 } },
          ...this.withoutReadBy(viewer.userId),
          { $skip: skip },
          { $limit: pageSize },
        ])
        .toArray();
    } else {
      [total, docs] = await Promise.all([
        this.db.notifications.countDocuments(viewer.base),
        this.db.notifications
          .find(viewer.base)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray(),
      ]);
    }
    const [readAt, available] = await Promise.all([
      this.readDates(
        viewer.userId,
        docs.map((d) => d._id),
      ),
      this.availableTargets(docs),
    ]);
    return {
      page,
      pageSize,
      total,
      filter,
      unread,
      items: docs.map((doc) =>
        toNotificationView(
          doc,
          readAt.get(doc._id.toHexString()) ?? null,
          available.has(`${doc.target.kind}:${doc.target.id}`),
        ),
      ),
    };
  }

  /** Étapes d'agrégation : garde les notifications non lues par `userId`. */
  private withoutReadBy(userId: Types.ObjectId) {
    return [
      {
        $lookup: {
          from: PLATFORM_ADMIN_COLLECTIONS.notificationReads,
          let: { notificationId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', userId] },
                    { $eq: ['$notificationId', '$$notificationId'] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'readBy',
        },
      },
      { $match: { readBy: { $size: 0 } } },
      { $project: { readBy: 0 } },
    ];
  }

  private async readDates(
    userId: Types.ObjectId,
    ids: Types.ObjectId[],
  ): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.notificationReads
      .find(
        { userId, notificationId: { $in: ids } },
        { projection: { notificationId: 1, readAt: 1 } },
      )
      .toArray();
    return new Map(rows.map((r) => [r.notificationId.toHexString(), r.readAt]));
  }

  /**
   * Cibles encore présentes (`kind:id`). Une cible disparue garde son
   * résumé minimal ; l'interface affiche « Élément indisponible » sans lien.
   */
  private async availableTargets(
    docs: PlatformAdminNotificationDoc[],
  ): Promise<Set<string>> {
    const db = this.runtime.connection.db;
    if (!db) throw new Error('connexion MongoDB non prête');
    const byKind = new Map<NotificationTargetKind, Types.ObjectId[]>();
    for (const doc of docs) {
      if (!Types.ObjectId.isValid(doc.target.id)) continue;
      const list = byKind.get(doc.target.kind) ?? [];
      list.push(new Types.ObjectId(doc.target.id));
      byKind.set(doc.target.kind, list);
    }
    const found = new Set<string>();
    await Promise.all(
      [...byKind].map(async ([kind, ids]) => {
        const rows = await db
          .collection<{ _id: Types.ObjectId }>(TARGET_COLLECTIONS[kind])
          .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
          .toArray();
        for (const row of rows) found.add(`${kind}:${row._id.toHexString()}`);
      }),
    );
    return found;
  }

  // ─── Écritures de lecture (idempotentes) ───────────────────────────────

  /**
   * Marque UNE notification comme lue pour l'administrateur de la session.
   * Invisible pour lui (autre catégorie, antérieure à son accès, inconnue) :
   * 404, rien n'est écrit. Un second appel renvoie la même date.
   */
  async markRead(
    context: PlatformAdminRequestContext,
    id: string,
  ): Promise<{ id: string; read: true; readAt: string }> {
    await this.requireReady();
    const viewer = this.viewer(context);
    const notification =
      viewer.categories.length > 0 && /^[0-9a-f]{24}$/.test(id)
        ? await this.db.notifications.findOne({
            ...viewer.base,
            _id: new Types.ObjectId(id),
          })
        : null;
    if (!notification) {
      throw new NotFoundException({
        code: PlatformAdminErrorCode.NOT_FOUND,
        message: 'Notification introuvable.',
      });
    }
    await this.insertReads(viewer.userId, [notification]);
    const row = await this.db.notificationReads.findOne({
      userId: viewer.userId,
      notificationId: notification._id,
    });
    return { id, read: true, readAt: row!.readAt.toISOString() };
  }

  /**
   * « Tout marquer comme lu » : BORNE SERVEUR = les notifications non lues
   * visibles au moment de la lecture faite ici (identifiants relevés une
   * fois, puis marqués). Une notification enregistrée après cette lecture
   * reste non lue. Au plus `MARK_ALL_MAX` par demande (`remaining`).
   */
  async markAllRead(
    context: PlatformAdminRequestContext,
  ): Promise<{ marked: number; remaining: boolean }> {
    await this.requireReady();
    const viewer = this.viewer(context);
    if (viewer.categories.length === 0) return { marked: 0, remaining: false };
    const snapshot = await this.db.notifications
      .aggregate<
        Pick<PlatformAdminNotificationDoc, '_id' | 'category' | 'createdAt'>
      >([
        { $match: viewer.base },
        { $sort: { createdAt: -1, _id: -1 } },
        ...this.withoutReadBy(viewer.userId),
        { $limit: MARK_ALL_MAX },
        { $project: { _id: 1, category: 1, createdAt: 1 } },
      ])
      .toArray();
    let marked = 0;
    for (let i = 0; i < snapshot.length; i += MARK_ALL_BATCH) {
      marked += await this.insertReads(
        viewer.userId,
        snapshot.slice(i, i + MARK_ALL_BATCH),
      );
    }
    return { marked, remaining: snapshot.length === MARK_ALL_MAX };
  }

  private async insertReads(
    userId: Types.ObjectId,
    notifications: ReadonlyArray<
      Pick<PlatformAdminNotificationDoc, '_id' | 'category' | 'createdAt'>
    >,
  ): Promise<number> {
    if (notifications.length === 0) return 0;
    const readAt = this.now();
    const operations: mongo.AnyBulkWriteOperation<PlatformAdminNotificationReadDoc>[] =
      notifications.map((n) => ({
        updateOne: {
          filter: { userId, notificationId: n._id },
          update: {
            $setOnInsert: {
              userId,
              notificationId: n._id,
              category: n.category,
              notificationCreatedAt: n.createdAt,
              readAt,
            },
          },
          upsert: true,
        },
      }));
    try {
      const result = await this.db.notificationReads.bulkWrite(operations, {
        ordered: false,
      });
      return result.upsertedCount;
    } catch (error) {
      // Double clic ou deux onglets : la première écriture gagne.
      if (!isDuplicateOnly(error)) throw error;
      const result = (error as { result?: { upsertedCount?: number } }).result;
      return result?.upsertedCount ?? 0;
    }
  }
}
