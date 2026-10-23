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
  PROXY_REQUIRED: 'PLATFORM_ADMIN_PROXY_REQUIRED',
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
});

const body = (code: string, message: string) => ({ code, message });

export const adminUnavailable = () =>
  new ServiceUnavailableException(
    body(
      PlatformAdminErrorCode.UNAVAILABLE,
      "L'administration de la plateforme n'est pas disponible.",
    ),
  );

export const adminProxyRequired = () =>
  new ForbiddenException(
    body(PlatformAdminErrorCode.PROXY_REQUIRED, 'Accès refusé.'),
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
