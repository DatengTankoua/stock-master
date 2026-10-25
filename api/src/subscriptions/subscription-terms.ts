/**
 * 1-14B — Règles PURES des périodes d'abonnement (aucune I/O).
 *
 * - Essai : exactement 7 × 24 h.
 * - Abonnement : 1, 3, 6 ou 12 mois calendaires UTC ; jour ramené au
 *   dernier jour valide du mois cible (31 janv. + 1 mois → 28/29 févr.),
 *   heure UTC conservée.
 * - Validité : `startsAt` inclus, `endsAt` exclu.
 * - L'état se calcule à une date donnée (heure serveur), sans tâche cron.
 */

export enum SubscriptionPeriodKind {
  TRIAL = 'trial',
  SUBSCRIPTION = 'subscription',
}

export enum SubscriptionTerm {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMIANNUAL = 'semiannual',
  ANNUAL = 'annual',
}

export enum SubscriptionSource {
  TRIAL = 'trial',
  MANUAL = 'manual',
  /** 1-14D.2A : attribution consécutive à un paiement confirmé (serveur). */
  PAYMENT = 'payment',
  /**
   * Prolongation commerciale OFFERTE par l'administration de la plateforme
   * (1 à 90 jours, aucune durée de forfait, aucun paiement).
   */
  OFFERED = 'offered',
}

/** Bornes de la prolongation offerte (jours de 24 h). */
export const OFFERED_EXTENSION_MIN_DAYS = 1;
export const OFFERED_EXTENSION_MAX_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type OfferedExtensionRefusal =
  /** Aucune période en cours mais une période programmée : début ambigu. */
  | 'SCHEDULED_WITHOUT_CURRENT'
  /** Couverture en cours suivie d'une interruption avant une période future. */
  | 'DISCONTINUOUS_COVERAGE';

export type OfferedExtensionPlan =
  | {
      ok: true;
      /** `extend-coverage` : à la fin de la couverture continue ; `start-now` : heure serveur. */
      basis: 'extend-coverage' | 'start-now';
      /** Fin de couverture avant l'opération (`null` : aucune couverture). */
      previousCoverageEndsAt: Date | null;
      startsAt: Date;
      endsAt: Date;
      /** Périodes futures déjà programmées, conservées telles quelles. */
      scheduledPeriods: number;
    }
  | { ok: false; refusal: OfferedExtensionRefusal };

/**
 * Calcul PUR de la prolongation offerte, à l'heure serveur `now` :
 * - une période couvre `now` : la prolongation commence à la fin de la
 *   couverture CONTINUE (périodes futures jointives comprises, donc après
 *   les périodes déjà programmées, qui restent inchangées) ;
 * - aucune période ne couvre `now` et aucune n'est programmée (essai ou
 *   abonnement expiré, ou aucune période) : elle commence à `now` ;
 * - refus, sans rien réécrire : période programmée sans couverture en cours
 *   (le début serait ambigu) ou interruption entre la couverture continue et
 *   une période future.
 * Durée : `days` × 24 h exactement (pas de mois calendaires).
 */
export function planOfferedExtension(
  periods: readonly Pick<SubscriptionPeriodSnapshot, 'startsAt' | 'endsAt'>[],
  now: Date,
  days: number,
): OfferedExtensionPlan {
  const at = now.getTime();
  const sorted = [...periods].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const covering = sorted.some(
    (p) => p.startsAt.getTime() <= at && at < p.endsAt.getTime(),
  );
  const future = sorted.filter((p) => p.startsAt.getTime() > at);
  if (!covering) {
    if (future.length > 0) {
      return { ok: false, refusal: 'SCHEDULED_WITHOUT_CURRENT' };
    }
    return {
      ok: true,
      basis: 'start-now',
      previousCoverageEndsAt: null,
      startsAt: new Date(at),
      endsAt: new Date(at + days * DAY_MS),
      scheduledPeriods: 0,
    };
  }
  let end = at;
  for (const p of sorted) {
    if (p.startsAt.getTime() <= end && p.endsAt.getTime() > end) {
      end = p.endsAt.getTime();
    }
  }
  if (future.some((p) => p.startsAt.getTime() > end)) {
    return { ok: false, refusal: 'DISCONTINUOUS_COVERAGE' };
  }
  return {
    ok: true,
    basis: 'extend-coverage',
    previousCoverageEndsAt: new Date(end),
    startsAt: new Date(end),
    endsAt: new Date(end + days * DAY_MS),
    scheduledPeriods: future.length,
  };
}

/** Sources d'un abonnement (jamais l'essai, attribué à la création seule). */
export type GrantableSubscriptionSource =
  SubscriptionSource.MANUAL | SubscriptionSource.PAYMENT;

export function isGrantableSubscriptionSource(
  value: unknown,
): value is GrantableSubscriptionSource {
  return (
    value === SubscriptionSource.MANUAL || value === SubscriptionSource.PAYMENT
  );
}

export const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Opérateur système de l'essai (jamais un userId du commerce). */
export const TRIAL_GRANTOR = 'system';

export const SUBSCRIPTION_REFERENCE_MAX_LENGTH = 200;
export const SUBSCRIPTION_GRANTOR_MAX_LENGTH = 100;

export const TERM_MONTHS: Readonly<Record<SubscriptionTerm, number>> =
  Object.freeze({
    [SubscriptionTerm.MONTHLY]: 1,
    [SubscriptionTerm.QUARTERLY]: 3,
    [SubscriptionTerm.SEMIANNUAL]: 6,
    [SubscriptionTerm.ANNUAL]: 12,
  });

export function isSubscriptionTerm(value: unknown): value is SubscriptionTerm {
  return (
    typeof value === 'string' &&
    (Object.values(SubscriptionTerm) as string[]).includes(value)
  );
}

/** Référence déterministe de l'essai : une seule par organisation. */
export function trialSourceReference(organizationId: string): string {
  return `trial:${organizationId}`;
}

/** Ajout de mois calendaires UTC, jour ramené au dernier jour valide. */
export function addUtcMonthsClamped(start: Date, months: number): Date {
  const monthIndex = start.getUTCMonth() + months;
  const year = start.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

export function computeTrialEndsAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() + TRIAL_DURATION_MS);
}

export function computeSubscriptionEndsAt(
  startsAt: Date,
  term: SubscriptionTerm,
): Date {
  return addUtcMonthsClamped(startsAt, TERM_MONTHS[term]);
}

/**
 * Début d'un renouvellement : `max(now, fin de couverture déjà accordée)`.
 * La couverture inclut les périodes futures (ex. abonnement acheté pendant
 * l'essai) : le temps déjà accordé n'est jamais perdu.
 */
export function computeRenewalStartsAt(
  now: Date,
  coverageEndsAt: Date | null,
): Date {
  return coverageEndsAt && coverageEndsAt.getTime() > now.getTime()
    ? new Date(coverageEndsAt.getTime())
    : new Date(now.getTime());
}

// ─── État ────────────────────────────────────────────────────────────────────

export interface SubscriptionPeriodSnapshot {
  sequence: number;
  kind: SubscriptionPeriodKind;
  term: SubscriptionTerm | null;
  startsAt: Date;
  endsAt: Date;
}

export type SubscriptionStateName = 'none' | 'active' | 'expired' | 'scheduled';

export interface SubscriptionStateView {
  state: SubscriptionStateName;
  /** Période qui couvre `now` (null hors état `active`). */
  currentPeriod: {
    kind: SubscriptionPeriodKind;
    term: SubscriptionTerm | null;
    startsAt: Date;
    endsAt: Date;
  } | null;
  /**
   * `active`/`scheduled` : fin de la couverture CONTINUE (renouvellements
   * futurs compris) ; `expired` : fin de la dernière période ; `none` : null.
   */
  coverageEndsAt: Date | null;
  /** `scheduled` uniquement : début de la prochaine période. */
  nextPeriodStartsAt: Date | null;
}

const covers = (p: SubscriptionPeriodSnapshot, now: number): boolean =>
  p.startsAt.getTime() <= now && now < p.endsAt.getTime();

/** Fin de couverture continue à partir de `end` (périodes jointives). */
function continuousEnd(
  sorted: readonly SubscriptionPeriodSnapshot[],
  end: number,
): number {
  let result = end;
  for (const p of sorted) {
    if (p.startsAt.getTime() <= result && p.endsAt.getTime() > result) {
      result = p.endsAt.getTime();
    }
  }
  return result;
}

export function computeSubscriptionState(
  periods: readonly SubscriptionPeriodSnapshot[],
  now: Date,
): SubscriptionStateView {
  const at = now.getTime();
  if (periods.length === 0) {
    return {
      state: 'none',
      currentPeriod: null,
      coverageEndsAt: null,
      nextPeriodStartsAt: null,
    };
  }
  const sorted = [...periods].sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() || a.sequence - b.sequence,
  );

  // Plus récente période couvrant `now` (les chaînes ne se chevauchent pas ;
  // défensif si c'était le cas).
  const current = sorted
    .filter((p) => covers(p, at))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (current) {
    return {
      state: 'active',
      currentPeriod: {
        kind: current.kind,
        term: current.term,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
      },
      coverageEndsAt: new Date(continuousEnd(sorted, current.endsAt.getTime())),
      nextPeriodStartsAt: null,
    };
  }

  // Une période future n'accorde JAMAIS d'accès avant son `startsAt`.
  const next = sorted.find((p) => p.startsAt.getTime() > at);
  if (next) {
    return {
      state: 'scheduled',
      currentPeriod: null,
      coverageEndsAt: new Date(continuousEnd(sorted, next.endsAt.getTime())),
      nextPeriodStartsAt: next.startsAt,
    };
  }

  return {
    state: 'expired',
    currentPeriod: null,
    coverageEndsAt: new Date(
      Math.max(...sorted.map((p) => p.endsAt.getTime())),
    ),
    nextPeriodStartsAt: null,
  };
}
