import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { PlatformCapability } from './platform-admin-capabilities';
import { MESSAGE_CHANNELS, type MessageChannel } from './platform-admin-store';
import {
  OFFERED_EXTENSION_MAX_DAYS,
  OFFERED_EXTENSION_MIN_DAYS,
} from '../subscriptions/subscription-terms';

/**
 * Contenu CONFIRMÉ d'une action administrative, sous forme canonique. La
 * vérification renforcée (step-up) est liée à l'empreinte de ce contenu :
 * action, organisation, identifiant d'opération et paramètres. Toute
 * modification après confirmation change l'empreinte et impose une
 * nouvelle vérification.
 */
export type ActionIntent =
  OrganizationActionIntent | MessageIntent | MessageRetryIntent;

/**
 * Message de service : destinataires (identifiants d'utilisateur triés,
 * sans doublon) et canaux (triés) exacts, titre et texte brut normalisés.
 */
export interface MessageIntent {
  action: 'organization_message';
  organizationId: string;
  operationId: string;
  channels: MessageChannel[];
  recipientUserIds: string[];
  title: string;
  body: string;
}

/** Relance de livraisons existantes d'UN message, pour UN canal. */
export interface MessageRetryIntent {
  action: 'organization_message_retry';
  organizationId: string;
  operationId: string;
  messageId: string;
  channel: MessageChannel;
  deliveryIds: string[];
}

/** Actions sur l'état d'un commerce (lot « actions »). */
export type OrganizationActionIntent =
  | {
      action: 'organization_suspend';
      organizationId: string;
      operationId: string;
      internalReason: string;
      clientMessage: string;
    }
  | {
      action: 'organization_reactivate';
      organizationId: string;
      operationId: string;
      reason: string;
    }
  | {
      action: 'subscription_extend';
      organizationId: string;
      operationId: string;
      days: number;
      reason: string;
      /** Fin de couverture affichée à la confirmation (ISO), `null` si aucune. */
      expectedCoverageEndsAt: string | null;
    };

export const ACTION_CAPABILITY: Readonly<
  Record<OrganizationActionIntent['action'], PlatformCapability>
> = Object.freeze({
  organization_suspend: 'platform.organizations.suspend',
  organization_reactivate: 'platform.organizations.suspend',
  subscription_extend: 'platform.subscriptions.extend',
});

/** Un canal = une capacité ; « les deux » exige les deux. */
export const CHANNEL_CAPABILITY: Readonly<
  Record<MessageChannel, PlatformCapability>
> = Object.freeze({
  in_app: 'platform.communications.notify',
  email: 'platform.communications.email',
});

/** Capacités TOUTES exigées par une action (preuve et exécution). */
export function intentCapabilities(intent: ActionIntent): PlatformCapability[] {
  switch (intent.action) {
    case 'organization_message':
      return intent.channels.map((c) => CHANNEL_CAPABILITY[c]);
    case 'organization_message_retry':
      return [CHANNEL_CAPABILITY[intent.channel]];
    default:
      return [ACTION_CAPABILITY[intent.action]];
  }
}

/** Capacité inscrite à l'audit : `null` quand deux sont exigées. */
export function auditCapability(
  intent: ActionIntent,
): PlatformCapability | null {
  const required = intentCapabilities(intent);
  return required.length === 1 ? required[0] : null;
}

export function isOrganizationActionIntent(
  intent: ActionIntent,
): intent is OrganizationActionIntent {
  return intent.action in ACTION_CAPABILITY;
}

/** Bornes d'un message de service (miroir web : admin-api.ts). */
export const MESSAGE_TITLE_MAX_LENGTH = 150;
export const MESSAGE_BODY_MAX_LENGTH = 5_000;
/** Destinataires d'un message ; au-delà : refus, jamais de troncature. */
export const MESSAGE_MAX_RECIPIENTS = 50;

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;
export const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

const invalid = (field: string) =>
  new BadRequestException({
    code: 'PLATFORM_ADMIN_ACTION_INVALID',
    message: 'Paramètre invalide.',
    field,
  });

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim().replace(/\r\n/g, '\n');
  if (
    trimmed.length < REASON_MIN_LENGTH ||
    trimmed.length > REASON_MAX_LENGTH
  ) {
    throw invalid(field);
  }
  return trimmed;
}

/** Caractères de contrôle refusés (hors tabulation et retour à la ligne). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/**
 * Texte brut d'un message : fins de ligne unifiées, espaces de bord
 * retirés ; titre sur une ligne. Aucun HTML n'est interprété : l'affichage
 * échappe tout (web, e-mail).
 */
function messageText(
  value: unknown,
  field: 'title' | 'body',
  max: number,
): string {
  if (typeof value !== 'string') throw invalid(field);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    CONTROL.test(normalized) ||
    (field === 'title' && /[\n\t]/.test(normalized))
  ) {
    throw invalid(field);
  }
  return normalized;
}

/** Identifiants triés et dédupliqués (1 à `max`) ; au-delà : refus. */
function objectIdList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid(field);
  if (!value.every((v) => typeof v === 'string' && OBJECT_ID_PATTERN.test(v))) {
    throw invalid(field);
  }
  const unique = [...new Set(value as string[])].sort();
  if (unique.length > max) {
    throw new BadRequestException({
      code: 'PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT',
      message: 'Trop de destinataires pour un seul message.',
      limit: max,
    });
  }
  return unique;
}

function channel(value: unknown): MessageChannel {
  if (!(MESSAGE_CHANNELS as readonly unknown[]).includes(value)) {
    throw invalid('channel');
  }
  return value as MessageChannel;
}

function channelList(value: unknown): MessageChannel[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid('channels');
  const unique = [...new Set(value.map(channel))];
  return MESSAGE_CHANNELS.filter((c) => unique.includes(c));
}

/**
 * Validation et forme canonique (espaces de bord retirés, date ISO). Toute
 * valeur absente, mal typée ou hors bornes → 400, jamais une conversion
 * permissive.
 */
export function normalizeIntent(raw: Record<string, unknown>): ActionIntent {
  const organizationId = raw.organizationId;
  const operationId = raw.operationId;
  if (
    typeof organizationId !== 'string' ||
    !OBJECT_ID_PATTERN.test(organizationId)
  ) {
    throw invalid('organizationId');
  }
  if (
    typeof operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw invalid('operationId');
  }
  switch (raw.action) {
    case 'organization_suspend':
      return {
        action: 'organization_suspend',
        organizationId,
        operationId,
        internalReason: text(raw.internalReason, 'internalReason'),
        clientMessage: text(raw.clientMessage, 'clientMessage'),
      };
    case 'organization_reactivate':
      return {
        action: 'organization_reactivate',
        organizationId,
        operationId,
        reason: text(raw.reason, 'reason'),
      };
    case 'subscription_extend': {
      const days = raw.days;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < OFFERED_EXTENSION_MIN_DAYS ||
        days > OFFERED_EXTENSION_MAX_DAYS
      ) {
        throw invalid('days');
      }
      const expected = raw.expectedCoverageEndsAt;
      let expectedCoverageEndsAt: string | null = null;
      if (expected !== null) {
        const date = typeof expected === 'string' ? new Date(expected) : null;
        if (!date || Number.isNaN(date.getTime())) {
          throw invalid('expectedCoverageEndsAt');
        }
        expectedCoverageEndsAt = date.toISOString();
      }
      return {
        action: 'subscription_extend',
        organizationId,
        operationId,
        days,
        reason: text(raw.reason, 'reason'),
        expectedCoverageEndsAt,
      };
    }
    case 'organization_message':
      return {
        action: 'organization_message',
        organizationId,
        operationId,
        channels: channelList(raw.channels),
        recipientUserIds: objectIdList(
          raw.recipientUserIds,
          'recipientUserIds',
          MESSAGE_MAX_RECIPIENTS,
        ),
        title: messageText(raw.title, 'title', MESSAGE_TITLE_MAX_LENGTH),
        body: messageText(raw.body, 'body', MESSAGE_BODY_MAX_LENGTH),
      };
    case 'organization_message_retry': {
      const messageId = raw.messageId;
      if (typeof messageId !== 'string' || !OBJECT_ID_PATTERN.test(messageId)) {
        throw invalid('messageId');
      }
      return {
        action: 'organization_message_retry',
        organizationId,
        operationId,
        messageId,
        channel: channel(raw.channel),
        deliveryIds: objectIdList(
          raw.deliveryIds,
          'deliveryIds',
          MESSAGE_MAX_RECIPIENTS,
        ),
      };
    }
    default:
      throw invalid('action');
  }
}

/** `normalizeIntent` restreint aux actions sur l'état d'un commerce. */
export function normalizeOrganizationAction(
  raw: Record<string, unknown>,
): OrganizationActionIntent {
  const intent = normalizeIntent(raw);
  if (!isOrganizationActionIntent(intent)) throw invalid('action');
  return intent;
}

/** Empreinte SHA-256 du contenu canonique (clés dans un ordre fixe). */
export function actionContentHash(intent: ActionIntent): string {
  const ordered: Array<[string, unknown]> = Object.entries(intent).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return createHash('sha256')
    .update(
      `stockmaster:platform-admin-action:v1\u0000${JSON.stringify(ordered)}`,
    )
    .digest('hex');
}
