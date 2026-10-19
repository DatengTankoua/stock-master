import { expiryAlertsEnabledFor } from '../products/expiry/expiry-alerts-config';
import { productBatchesEnabledFor } from '../products/batches/product-batches-config';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import {
  PushSubscriptionDisabledReason,
  PushSubscriptionDocument,
  PushSubscriptionRecord,
  PushSubscriptionStatus,
} from './schemas/push-subscription.schema';
import {
  DEFAULT_PUSH_PREFERENCES,
  PushCategory,
  PushPreferences,
  offeredCategories,
} from './schemas/push-category';
import { validatePushSubscriptionInput } from './push-endpoint-policy';
import { PUSH_CLOCK, PushRuntime } from './push-runtime';
import type { PushClock } from './push-runtime';
import type {
  PushPreferencesDto,
  RegisterPushSubscriptionDto,
} from './dto/push-subscription.dto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { currentSessionVersion } from '../auth/session-version';
import {
  DelegablePermission,
  OrganizationRole,
} from '../organizations/permissions';

/** Appareils actifs par membre et organisation ; le plus ancien est remplacé. */
export const MAX_PUSH_DEVICES_PER_MEMBER = 10;

export const PUSH_DISABLED = 'PUSH_DISABLED';
export const PUSH_SUBSCRIPTION_INVALID = 'PUSH_SUBSCRIPTION_INVALID';
export const PUSH_SUBSCRIPTION_NOT_FOUND = 'PUSH_SUBSCRIPTION_NOT_FOUND';

/** Contexte serveur (`OrganizationGuard`), jamais le corps. */
export interface PushMemberContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  permissions: readonly DelegablePermission[];
}

export interface PushConfigView {
  enabled: boolean;
  publicKey: string | null;
  /** Catégories auxquelles CE membre peut prétendre aujourd'hui. */
  categories: PushCategory[];
}

export interface PushDeviceView {
  registered: boolean;
  preferences: PushPreferences | null;
}

const endpointHash = (endpoint: string) =>
  createHash('sha256').update(endpoint).digest('hex');

/** Catégories ouvertes au membre (aide à l'interface ; revalidé à l'envoi). */
export function availablePushCategories(
  context: Pick<PushMemberContext, 'role' | 'permissions' | 'organizationId'>,
): PushCategory[] {
  return offeredCategories(context, {
    expiryAlerts: expiryAlertsEnabledFor(context.organizationId),
    productBatches: productBatchesEnabledFor(context.organizationId),
  });
}

const PREFERENCE_KEYS = Object.keys(
  DEFAULT_PUSH_PREFERENCES,
) as (keyof PushPreferences)[];

/** Préférences complètes (clé absente d'un ancien document : active). */
export function completePreferences(
  stored: Partial<PushPreferences> | null | undefined,
): PushPreferences {
  const result = { ...DEFAULT_PUSH_PREFERENCES };
  for (const key of PREFERENCE_KEYS) {
    if (typeof stored?.[key] === 'boolean') result[key] = stored[key];
  }
  return result;
}

function mergePreferences(
  base: PushPreferences,
  update: PushPreferencesDto | undefined,
): PushPreferences {
  const result = { ...base };
  for (const key of PREFERENCE_KEYS) {
    const value = update?.[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/**
 * 1-16A — Gestion des abonnements push de l'appareil courant.
 *
 * Un appareil n'est jamais lu, modifié ni retiré qu'au nom de l'utilisateur
 * (et, sauf retrait, de l'organisation) du contexte serveur. Aucune réponse
 * ne renvoie l'endpoint ni les clés ; une requête sur l'appareil d'un autre
 * titulaire est indistinguable d'un appareil absent.
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(
    @InjectModel(PushSubscriptionRecord.name)
    private readonly subscriptionModel: Model<PushSubscriptionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly runtime: PushRuntime,
    @Inject(PUSH_CLOCK) private readonly clock: PushClock,
  ) {}

  config(context: PushMemberContext): PushConfigView {
    if (!this.runtime.pushActive) {
      return { enabled: false, publicKey: null, categories: [] };
    }
    return {
      enabled: true,
      publicKey: this.runtime.publicKey,
      categories: availablePushCategories(context),
    };
  }

  /**
   * Activation (ou réactivation) de l'appareil pour le membre courant. Un
   * endpoint déjà rattaché à un AUTRE titulaire (changement de compte ou
   * d'organisation sur un appareil partagé) lui est retiré et repart des
   * préférences par défaut, enregistré à l'heure courante : aucun événement
   * antérieur ne lui sera livré.
   */
  async register(
    context: PushMemberContext,
    dto: RegisterPushSubscriptionDto,
  ): Promise<PushDeviceView> {
    if (!this.runtime.pushActive) {
      throw new ServiceUnavailableException({
        code: PUSH_DISABLED,
        message: 'Notifications indisponibles.',
      });
    }
    const subscription = validatePushSubscriptionInput(dto.subscription);
    if (!subscription) {
      throw new BadRequestException({
        code: PUSH_SUBSCRIPTION_INVALID,
        message: 'Abonnement aux notifications refusé.',
      });
    }
    const userId = new Types.ObjectId(context.userId);
    const organizationId = new Types.ObjectId(context.organizationId);
    const user = await this.userModel
      .findById(userId)
      .select({ authVersion: 1 })
      .lean<{ authVersion?: number | null }>()
      .exec();
    if (!user) throw new NotFoundException();
    const hash = endpointHash(subscription.endpoint);
    const now = this.clock();

    for (let attempt = 0; ; attempt += 1) {
      const existing = await this.subscriptionModel
        .findOne({ endpointHash: hash })
        .lean<PushSubscriptionRecord>()
        .exec();
      const sameHolder =
        existing?.status === PushSubscriptionStatus.ACTIVE &&
        existing.userId.equals(userId) &&
        existing.organizationId.equals(organizationId);
      // Même utilisateur (déconnecté, autre organisation…) : ses choix sur
      // cet appareil sont conservés, jamais remis « tout activé ».
      const preferences = mergePreferences(
        existing?.userId.equals(userId)
          ? completePreferences(existing.preferences)
          : { ...DEFAULT_PUSH_PREFERENCES },
        dto.preferences,
      );
      try {
        await this.subscriptionModel
          .updateOne(
            { endpointHash: hash },
            {
              $set: {
                userId,
                organizationId,
                endpoint: subscription.endpoint,
                p256dh: subscription.p256dh,
                auth: subscription.auth,
                preferences,
                authVersion: currentSessionVersion(user),
                status: PushSubscriptionStatus.ACTIVE,
                disabledReason: null,
                disabledAt: null,
                registeredAt: sameHolder ? existing.registeredAt : now,
                // Activation explicite : remplace tout détachement antérieur.
                releasedSession: null,
              },
              $setOnInsert: { lastDeliveredAt: null },
            },
            { upsert: true, runValidators: true },
          )
          .exec();
        break;
      } catch (error) {
        // Insertion concurrente du même endpoint : une relecture suffit.
        if ((error as { code?: unknown }).code !== 11000 || attempt > 0) {
          throw error;
        }
      }
    }
    await this.enforceDeviceLimit(userId, organizationId);
    return this.view(context, subscription.endpoint);
  }

  async status(
    context: PushMemberContext,
    endpoint: string,
  ): Promise<PushDeviceView> {
    return this.view(context, endpoint);
  }

  /**
   * Réconciliation SANS action de l'utilisateur, appelée par le navigateur
   * quand la permission est déjà accordée et qu'un abonnement local existe.
   * Seul le MÊME utilisateur (contexte serveur, session vérifiée par les
   * gardes) récupère l'appareil, avec ses préférences :
   * - actif pour une autre de ses organisations → rattaché à l'organisation
   *   courante ;
   * - désactivé par déconnexion ou révocation de session → réactivé.
   * Jamais d'attribution à un autre utilisateur : un appareil encore actif
   * pour un autre compte est seulement DÉTACHÉ (plus aucun envoi à l'ancien
   * titulaire sur ce navigateur), et la réponse reste celle d'un appareil
   * absent. Événements antérieurs jamais livrés (`registeredAt`).
   */
  async reconcile(
    context: PushMemberContext,
    dto: { subscription: RegisterPushSubscriptionDto['subscription'] },
    session: string,
  ): Promise<PushDeviceView> {
    const absent: PushDeviceView = { registered: false, preferences: null };
    if (!this.runtime.pushActive) return absent;
    const subscription = validatePushSubscriptionInput(dto.subscription);
    if (!subscription) return absent;
    const hash = endpointHash(subscription.endpoint);
    const userId = new Types.ObjectId(context.userId);
    const organizationId = new Types.ObjectId(context.organizationId);
    const existing = await this.subscriptionModel
      .findOne({ endpointHash: hash })
      .lean<PushSubscriptionRecord & { _id: Types.ObjectId }>()
      .exec();
    if (!existing) return absent;

    if (!existing.userId.equals(userId)) {
      if (existing.status === PushSubscriptionStatus.ACTIVE) {
        await this.subscriptionModel
          .updateOne(
            { _id: existing._id, status: PushSubscriptionStatus.ACTIVE },
            {
              $set: {
                status: PushSubscriptionStatus.DISABLED,
                disabledReason: PushSubscriptionDisabledReason.SIGNED_OUT,
                disabledAt: this.clock(),
              },
            },
          )
          .exec();
      }
      return absent;
    }

    const active = existing.status === PushSubscriptionStatus.ACTIVE;
    if (active && existing.organizationId.equals(organizationId)) {
      return this.view(context, subscription.endpoint);
    }
    // Session déjà déconnectée de cet appareil : requête arrivée (ou traitée)
    // après son `release` — jamais de réactivation.
    if (existing.releasedSession === session) return absent;
    const reclaimable =
      active ||
      existing.disabledReason === PushSubscriptionDisabledReason.SIGNED_OUT ||
      existing.disabledReason ===
        PushSubscriptionDisabledReason.SESSION_REVOKED;
    if (!reclaimable) return absent;

    const user = await this.userModel
      .findById(userId)
      .select({ authVersion: 1 })
      .lean<{ authVersion?: number | null }>()
      .exec();
    if (!user) return absent;
    // Filtre sur l'état relu : une écriture concurrente (autre compte,
    // retrait explicite, `release` de CETTE session entre la lecture et
    // l'écriture) l'emporte, l'appareil reste alors absent.
    await this.subscriptionModel
      .updateOne(
        {
          _id: existing._id,
          userId,
          status: existing.status,
          organizationId: existing.organizationId,
          releasedSession: { $ne: session },
        },
        {
          $set: {
            organizationId,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
            preferences: completePreferences(existing.preferences),
            authVersion: currentSessionVersion(user),
            status: PushSubscriptionStatus.ACTIVE,
            disabledReason: null,
            disabledAt: null,
            registeredAt: this.clock(),
          },
        },
        { runValidators: true },
      )
      .exec();
    await this.enforceDeviceLimit(userId, organizationId);
    return this.view(context, subscription.endpoint);
  }

  /**
   * Déconnexion : ce navigateur cesse de recevoir, sans perdre les
   * préférences de son titulaire ; l'abonnement local peut alors être
   * conservé pour une reconnexion du même compte. Le titulaire actif est
   * détaché QUEL QU'IL SOIT (l'endpoint, jamais renvoyé par l'API, désigne
   * ce navigateur ; un compte précédent dont la session a simplement expiré
   * n'y reçoit donc plus rien non plus). Réponse identique dans tous les cas.
   */
  async release(endpoint: string, session: string): Promise<void> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) return;
    const active = { $eq: ['$status', PushSubscriptionStatus.ACTIVE] };
    // UNE écriture atomique, quel que soit l'état : la session est marquée
    // (toute réconciliation qu'elle porte, même déjà partie, est refusée) et
    // un appareil actif est détaché.
    await this.subscriptionModel
      .updateOne(
        { endpointHash: endpointHash(endpoint) },
        [
          {
            $set: {
              releasedSession: session,
              status: {
                $cond: [active, PushSubscriptionStatus.DISABLED, '$status'],
              },
              disabledReason: {
                $cond: [
                  active,
                  PushSubscriptionDisabledReason.SIGNED_OUT,
                  '$disabledReason',
                ],
              },
              disabledAt: { $cond: [active, this.clock(), '$disabledAt'] },
            },
          },
        ],
        { updatePipeline: true },
      )
      .exec();
  }

  async updatePreferences(
    context: PushMemberContext,
    endpoint: string,
    update: PushPreferencesDto,
  ): Promise<PushDeviceView> {
    const current = await this.view(context, endpoint);
    if (!current.registered || !current.preferences) {
      throw new NotFoundException({
        code: PUSH_SUBSCRIPTION_NOT_FOUND,
        message: 'Notifications non activées sur cet appareil.',
      });
    }
    const preferences = mergePreferences(current.preferences, update);
    await this.subscriptionModel
      .updateOne(this.holderFilter(context, endpoint), {
        $set: { preferences },
      })
      .exec();
    return this.view(context, endpoint);
  }

  /**
   * Retrait de l'appareil (désactivation, déconnexion) : supprimé s'il
   * appartient à l'utilisateur courant, quelle que soit l'organisation.
   * Silencieux sinon (aucune information sur les autres titulaires).
   */
  async remove(userId: string, endpoint: string): Promise<void> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) return;
    await this.subscriptionModel
      .deleteOne({
        endpointHash: endpointHash(endpoint),
        userId: new Types.ObjectId(userId),
      })
      .exec();
  }

  private holderFilter(context: PushMemberContext, endpoint: string) {
    return {
      endpointHash: endpointHash(endpoint),
      userId: new Types.ObjectId(context.userId),
      organizationId: new Types.ObjectId(context.organizationId),
      status: PushSubscriptionStatus.ACTIVE,
    };
  }

  private async view(
    context: PushMemberContext,
    endpoint: string,
  ): Promise<PushDeviceView> {
    const record = await this.subscriptionModel
      .findOne(this.holderFilter(context, endpoint))
      .select({ preferences: 1 })
      .lean<{ preferences: PushPreferences }>()
      .exec();
    return record
      ? {
          registered: true,
          preferences: completePreferences(record.preferences),
        }
      : { registered: false, preferences: null };
  }

  private async enforceDeviceLimit(
    userId: Types.ObjectId,
    organizationId: Types.ObjectId,
  ): Promise<void> {
    const surplus = await this.subscriptionModel
      .find({ userId, organizationId, status: PushSubscriptionStatus.ACTIVE })
      .sort({ registeredAt: -1, _id: -1 })
      .skip(MAX_PUSH_DEVICES_PER_MEMBER)
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    if (surplus.length === 0) return;
    await this.subscriptionModel
      .updateMany(
        { _id: { $in: surplus.map((s) => s._id) } },
        {
          $set: {
            status: PushSubscriptionStatus.DISABLED,
            disabledReason: PushSubscriptionDisabledReason.REPLACED,
            disabledAt: this.clock(),
          },
        },
      )
      .exec();
  }
}
