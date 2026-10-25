import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { PlatformCapability } from './platform-admin-capabilities';
import type { PlatformAdminActionKind } from './platform-admin-store';
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
  Record<PlatformAdminActionKind, PlatformCapability>
> = Object.freeze({
  organization_suspend: 'platform.organizations.suspend',
  organization_reactivate: 'platform.organizations.suspend',
  subscription_extend: 'platform.subscriptions.extend',
});

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
    default:
      throw invalid('action');
  }
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
