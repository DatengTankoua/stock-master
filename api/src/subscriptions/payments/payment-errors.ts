import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PAYMENT_RATE_LIMIT_CODE,
  PAYMENT_RATE_LIMIT_MESSAGE,
} from '../../common/subscription-payment-rate-limiting';

/** 1-14D.2B — Codes STABLES des routes de paiement (aucune donnée interne). */
export const PAYMENT_ERROR_CODES = Object.freeze({
  SERVICE_UNAVAILABLE: 'PAYMENT_SERVICE_UNAVAILABLE',
  STATUS_UNAVAILABLE: 'PAYMENT_STATUS_UNAVAILABLE',
  CONFIRMATION_PENDING: 'PAYMENT_CONFIRMATION_PENDING',
  ALREADY_PENDING: 'PAYMENT_ALREADY_PENDING',
  OPERATION_CONFLICT: 'PAYMENT_OPERATION_CONFLICT',
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  INVALID_PAYER_PHONE: 'INVALID_PAYER_PHONE',
  UNEXPECTED_BODY: 'UNEXPECTED_BODY',
  CHANGE_UNAVAILABLE: 'PAYMENT_CHANGE_UNAVAILABLE',
  RECEIPT_UNAVAILABLE: 'PAYMENT_RECEIPT_UNAVAILABLE',
} as const);

/** 1-22D : `Retry-After` posé par le filtre global (`retryAfterSeconds`). */
const withRetryAfter = <T extends HttpException>(
  exception: T,
  retryAfterSeconds?: number,
): T =>
  retryAfterSeconds === undefined
    ? exception
    : Object.assign(exception, { retryAfterSeconds });

export const paymentServiceUnavailable = (retryAfterSeconds?: number) =>
  withRetryAfter(
    new ServiceUnavailableException({
      code: PAYMENT_ERROR_CODES.SERVICE_UNAVAILABLE,
      message: 'Le paiement est momentanément indisponible.',
    }),
    retryAfterSeconds,
  );

export const paymentStatusUnavailable = (retryAfterSeconds?: number) =>
  withRetryAfter(
    new ServiceUnavailableException({
      code: PAYMENT_ERROR_CODES.STATUS_UNAVAILABLE,
      message:
        'Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.',
    }),
    retryAfterSeconds,
  );

/**
 * 1-22D — Quota d'appels au prestataire de l'organisation COURANTE atteint
 * (création, vérification et changement de forfait confondus) : même code
 * que la limitation des routes ; rien n'a été créé ni modifié.
 */
export const paymentRateLimited = (retryAfterSeconds: number) =>
  withRetryAfter(
    new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: PAYMENT_RATE_LIMIT_CODE,
        message: PAYMENT_RATE_LIMIT_MESSAGE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ),
    retryAfterSeconds,
  );

/**
 * Succès vérifié mais transaction non aboutie dans le budget (ou contention
 * persistante) : TEMPORAIRE. Aucun changement d'état, aucune nouvelle
 * collecte ; une confirmation ultérieure retrouve un éventuel commit.
 */
export const paymentConfirmationPending = () =>
  new ServiceUnavailableException({
    code: PAYMENT_ERROR_CODES.CONFIRMATION_PENDING,
    message:
      'Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.',
  });

/** Autre demande alors qu'un paiement reste ouvert (id de ce paiement). */
export const paymentAlreadyPending = (paymentId: string) =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.ALREADY_PENDING,
    message: 'Un paiement est déjà en cours pour ce commerce.',
    paymentId,
  });

/** `clientOperationId` déjà utilisé pour une demande différente. */
export const paymentOperationConflict = () =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.OPERATION_CONFLICT,
    message: 'Cette opération a déjà été utilisée pour une autre demande.',
  });

/** 404 UNIFORME : inexistant, autre organisation ou identifiant invalide. */
export const paymentNotFound = () =>
  new NotFoundException({
    code: PAYMENT_ERROR_CODES.NOT_FOUND,
    message: 'Paiement introuvable.',
  });

export const invalidPayerPhone = () =>
  new BadRequestException({
    code: PAYMENT_ERROR_CODES.INVALID_PAYER_PHONE,
    message: 'Numéro Mobile Money camerounais invalide.',
  });

/**
 * 1-21E — « Changer de forfait » sans page hébergée à fermer (collecte
 * poussée sur le téléphone) : rien n'est modifié.
 */
export const paymentChangeUnavailable = () =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.CHANGE_UNAVAILABLE,
    message: 'Ce paiement ne peut pas être remplacé pour le moment.',
  });

/**
 * 1-21E — Reçu demandé pour un paiement dont l'encaissement n'est PAS
 * confirmé côté serveur (en attente, échoué, clos sans paiement).
 */
export const paymentReceiptUnavailable = () =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.RECEIPT_UNAVAILABLE,
    message: "Aucun reçu : ce paiement n'a pas été encaissé.",
  });

export const unexpectedBody = () =>
  new BadRequestException({
    code: PAYMENT_ERROR_CODES.UNEXPECTED_BODY,
    message: 'Aucun paramètre attendu.',
  });
