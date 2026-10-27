import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { RateLimitedException } from '../common/auth-rate-limiting';

/**
 * Codes stables de l'administration de la plateforme (le web affiche ses
 * propres textes FR/EN à partir du code). Aucun message ne contient de
 * secret, de code saisi ni d'information sur l'existence d'un compte.
 */
export const PlatformAdminErrorCode = Object.freeze({
  UNAVAILABLE: 'PLATFORM_ADMIN_UNAVAILABLE',
  ACCESS_DENIED: 'PLATFORM_ADMIN_ACCESS_DENIED',
  SESSION_EXPIRED: 'PLATFORM_ADMIN_SESSION_EXPIRED',
  MFA_REQUIRED: 'PLATFORM_ADMIN_MFA_REQUIRED',
  ENROLLMENT_REQUIRED: 'PLATFORM_ADMIN_ENROLLMENT_REQUIRED',
  ALREADY_ENROLLED: 'PLATFORM_ADMIN_ALREADY_ENROLLED',
  CHALLENGE_INVALID: 'PLATFORM_ADMIN_CHALLENGE_INVALID',
  CODE_INVALID: 'PLATFORM_ADMIN_CODE_INVALID',
  STEP_UP_REQUIRED: 'PLATFORM_ADMIN_STEP_UP_REQUIRED',
  RATE_LIMITED: 'PLATFORM_ADMIN_RATE_LIMITED',
  NOT_FOUND: 'PLATFORM_ADMIN_NOT_FOUND',
  CAPABILITY_REQUIRED: 'PLATFORM_ADMIN_CAPABILITY_REQUIRED',
  OPERATION_CONFLICT: 'PLATFORM_ADMIN_OPERATION_CONFLICT',
  STATE_CHANGED: 'PLATFORM_ADMIN_STATE_CHANGED',
  EXTENSION_REFUSED: 'PLATFORM_ADMIN_EXTENSION_REFUSED',
  MESSAGE_RECIPIENT_LIMIT: 'PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT',
  MESSAGE_RATE_LIMITED: 'PLATFORM_ADMIN_MESSAGE_RATE_LIMITED',
  MESSAGE_RECIPIENTS_CHANGED: 'PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED',
  MESSAGE_NOT_RETRYABLE: 'PLATFORM_ADMIN_MESSAGE_NOT_RETRYABLE',
  MESSAGE_RETRY_WINDOW_EXPIRED: 'PLATFORM_ADMIN_MESSAGE_RETRY_WINDOW_EXPIRED',
});

const body = (code: string, message: string) => ({ code, message });

export const adminUnavailable = () =>
  new ServiceUnavailableException(
    body(
      PlatformAdminErrorCode.UNAVAILABLE,
      "L'administration de la plateforme n'est pas disponible.",
    ),
  );

export const adminAccessDenied = () =>
  new ForbiddenException(
    body(
      PlatformAdminErrorCode.ACCESS_DENIED,
      "Ce compte n'a pas accès à l'administration de la plateforme.",
    ),
  );

export const adminSessionExpired = () =>
  new UnauthorizedException(
    body(
      PlatformAdminErrorCode.SESSION_EXPIRED,
      'Session administrative expirée. Reconnectez-vous.',
    ),
  );

export const adminMfaRequired = () =>
  new UnauthorizedException(
    body(
      PlatformAdminErrorCode.MFA_REQUIRED,
      'Validez la double authentification.',
    ),
  );

export const adminEnrollmentRequired = () =>
  new ForbiddenException(
    body(
      PlatformAdminErrorCode.ENROLLMENT_REQUIRED,
      'Configurez la double authentification.',
    ),
  );

export const adminAlreadyEnrolled = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.ALREADY_ENROLLED,
      'La double authentification est déjà configurée.',
    ),
    HttpStatus.CONFLICT,
  );

export const adminChallengeInvalid = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.CHALLENGE_INVALID,
      'Vérification expirée ou déjà utilisée. Recommencez.',
    ),
    HttpStatus.CONFLICT,
  );

export const adminCodeInvalid = () =>
  new UnauthorizedException(
    body(PlatformAdminErrorCode.CODE_INVALID, 'Code incorrect.'),
  );

export const adminStepUpRequired = () =>
  new ForbiddenException(
    body(
      PlatformAdminErrorCode.STEP_UP_REQUIRED,
      'Confirmez votre mot de passe et votre second facteur.',
    ),
  );

export const adminRateLimited = (retryAfterSeconds: number) =>
  new RateLimitedException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: PlatformAdminErrorCode.RATE_LIMITED,
      message: 'Trop de tentatives. Réessayez plus tard.',
    },
    retryAfterSeconds,
  );

export const adminCapabilityRequired = () =>
  new ForbiddenException(
    body(
      PlatformAdminErrorCode.CAPABILITY_REQUIRED,
      'Votre accès ne permet pas cette action.',
    ),
  );

/** Même identifiant d'opération, contenu différent. */
export const adminOperationConflict = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.OPERATION_CONFLICT,
      'Identifiant d’opération déjà utilisé pour une autre demande.',
    ),
    HttpStatus.CONFLICT,
  );

/** L'état a changé depuis la confirmation (autre administrateur, paiement). */
export const adminStateChanged = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.STATE_CHANGED,
      'La situation a changé depuis votre confirmation. Vérifiez puis recommencez.',
    ),
    HttpStatus.CONFLICT,
  );

export const adminExtensionRefused = (refusal: string) =>
  new HttpException(
    {
      ...body(
        PlatformAdminErrorCode.EXTENSION_REFUSED,
        'Prolongation impossible sans réécrire les périodes existantes.',
      ),
      refusal,
    },
    HttpStatus.CONFLICT,
  );

/** Limite de fréquence des messages (organisation ou administrateur). */
export const adminMessageRateLimited = (retryAfterSeconds: number) =>
  new RateLimitedException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: PlatformAdminErrorCode.MESSAGE_RATE_LIMITED,
      message: 'Limite d’envoi de messages atteinte. Réessayez plus tard.',
    },
    retryAfterSeconds,
  );

/** Un destinataire confirmé n'est plus membre actif ou son compte inactif. */
export const adminMessageRecipientsChanged = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.MESSAGE_RECIPIENTS_CHANGED,
      'Un destinataire n’est plus membre actif de ce commerce. Rechargez la liste.',
    ),
    HttpStatus.CONFLICT,
  );

export const adminMessageNotRetryable = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.MESSAGE_NOT_RETRYABLE,
      'Cette livraison ne peut pas être relancée.',
    ),
    HttpStatus.CONFLICT,
  );

/** Résultat incertain hors de la fenêtre d'idempotence du prestataire. */
export const adminMessageRetryWindowExpired = () =>
  new HttpException(
    body(
      PlatformAdminErrorCode.MESSAGE_RETRY_WINDOW_EXPIRED,
      'Le résultat est incertain et ne peut plus être relancé sans risque de doublon.',
    ),
    HttpStatus.CONFLICT,
  );
