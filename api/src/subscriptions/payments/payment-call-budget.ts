import { AsyncLocalStorage } from 'async_hooks';
import { MonotonicClock, systemMonotonicClock } from '../subscription-clock';

/**
 * 1-22D — Budget d'appels sortants d'un prestataire, PAR PROCESSUS, réparti
 * entre organisations (piste 3 de 1-22A).
 *
 * Fenêtre glissante de 60 s, mémoire locale :
 * - plafond GLOBAL de tous les appels (inchangé : 120 / min) ;
 * - voie `owner` (création, vérification, changement de forfait demandés
 *   par un propriétaire) : au plus 80, et 20 par organisation, compteur
 *   COMMUN aux trois actions ;
 * - voie `confirmation` (webhook, rapprochement, CLI, tout appel hors
 *   action propriétaire) : au plus 100. Chaque voie garde ainsi une part
 *   que l'autre ne peut pas prendre (40 pour les confirmations, 20 pour les
 *   propriétaires).
 * - après un `429` du prestataire : plus aucun appel pendant 15 s.
 *
 * Une action propriétaire RÉSERVE son coût maximal AVANT toute écriture ou
 * tout appel (`reserve`) ; les appels réels consomment la réservation, le
 * reste est rendu à la fin (`release`). Un refus n'a donc jamais d'effet :
 * aucun paiement créé, fermé ni marqué échoué.
 *
 * Portée : un processus. Plusieurs instances d'API, ou le CLI de
 * rapprochement, ont chacune leur budget ; seul le plafond du compte
 * marchand chez le prestataire (300 / min documenté) borne leur somme.
 */
export type PaymentCallLane = 'owner' | 'confirmation';

export interface PaymentCallLimits {
  windowMs: number;
  global: number;
  ownerLane: number;
  confirmationLane: number;
  perOrganization: number;
  /** Pause après un refus `429` du prestataire. */
  providerCooldownMs: number;
  /** `Retry-After` fixe d'un refus de capacité (rien sur les autres). */
  capacityRetryAfterSeconds: number;
}

export const PAYMENT_CALL_LIMITS: Readonly<PaymentCallLimits> = Object.freeze({
  windowMs: 60_000,
  global: 120,
  ownerLane: 80,
  confirmationLane: 100,
  perOrganization: 20,
  providerCooldownMs: 15_000,
  capacityRetryAfterSeconds: 30,
});

/** Coûts MAXIMAUX (appels) déclarés par l'adaptateur. */
export interface PaymentCallCosts {
  initiate: number;
  statusByProvider: number;
  statusByMerchant: number;
  cancel: number;
}

export type PaymentCallAdmission =
  | { admitted: true; permit: PaymentCallPermit }
  | {
      admitted: false;
      /** `organization` : quota de l'organisation ; sinon capacité. */
      reason: 'organization' | 'capacity';
      retryAfterSeconds: number;
    };

interface Entry {
  at: number;
  lane: PaymentCallLane;
  organizationId: string | null;
}

export interface PaymentCallPermit {
  readonly organizationId: string;
  /** Rend la part non consommée ; idempotent. */
  release(): void;
}

interface Scope {
  permit: Permit;
}

class Permit implements PaymentCallPermit {
  released = false;
  constructor(
    readonly organizationId: string,
    readonly reserved: Entry[],
    private readonly onRelease: (left: Entry[]) => void,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this.reserved.splice(0));
  }
}

const scopes = new AsyncLocalStorage<Scope>();

export class PaymentCallBudget {
  private entries: Entry[] = [];
  private cooldownUntil = 0;

  constructor(
    private readonly monotonic: MonotonicClock = systemMonotonicClock,
    private readonly limits: Readonly<PaymentCallLimits> = PAYMENT_CALL_LIMITS,
  ) {}

  /**
   * Réserve `cost` appels pour une action de `organizationId`. Refus :
   * quota de l'organisation (`Retry-After` calculé sur SES seuls appels) ou
   * capacité (voie, plafond global, pause : `Retry-After` fixe).
   */
  reserve(organizationId: string, cost: number): PaymentCallAdmission {
    const now = this.prune();
    const own = this.entries
      .filter((e) => e.organizationId === organizationId)
      .sort((x, y) => x.at - y.at);
    if (own.length + cost > this.limits.perOrganization) {
      // Plus ancien appel dont l'expiration libère assez de place.
      const freed =
        own[
          Math.min(
            own.length - 1,
            own.length + cost - this.limits.perOrganization - 1,
          )
        ];
      return {
        admitted: false,
        reason: 'organization',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((freed?.at ?? now) + this.limits.windowMs - now) / 1000),
        ),
      };
    }
    if (!this.fits('owner', cost, now)) {
      return {
        admitted: false,
        reason: 'capacity',
        retryAfterSeconds: this.limits.capacityRetryAfterSeconds,
      };
    }
    const reserved: Entry[] = [];
    for (let i = 0; i < cost; i += 1) {
      reserved.push({ at: now, lane: 'owner', organizationId });
    }
    this.entries.push(...reserved);
    const permit = new Permit(organizationId, reserved, (left) => {
      const unused = new Set(left);
      this.entries = this.entries.filter((e) => !unused.has(e));
    });
    return { admitted: true, permit };
  }

  /** Exécute `work` au titre de `permit` (appels imputés à la réservation). */
  run<T>(permit: PaymentCallPermit, work: () => Promise<T>): Promise<T> {
    return scopes.run({ permit: permit as Permit }, work);
  }

  /**
   * Appel sur le point de partir : `false` = refus local, rien n'est envoyé.
   * Dans une action admise, la réservation est consommée d'abord ; au-delà,
   * l'appel est soumis aux limites de sa voie et de son organisation.
   */
  take(): boolean {
    const now = this.prune();
    const permit = scopes.getStore()?.permit;
    if (permit && !permit.released && permit.reserved.length > 0) {
      const used = permit.reserved.shift()!;
      used.at = now;
      if (!this.entries.includes(used)) this.entries.push(used);
      return true;
    }
    const lane: PaymentCallLane = permit ? 'owner' : 'confirmation';
    const organizationId = permit?.organizationId ?? null;
    if (now < this.cooldownUntil || !this.fits(lane, 1, now)) return false;
    if (
      organizationId !== null &&
      this.entries.filter((e) => e.organizationId === organizationId).length >=
        this.limits.perOrganization
    ) {
      return false;
    }
    this.entries.push({ at: now, lane, organizationId });
    return true;
  }

  /** Appels encore possibles sur la voie des confirmations. */
  confirmationHeadroom(): number {
    const now = this.prune();
    if (now < this.cooldownUntil) return 0;
    const lane = this.count('confirmation');
    return Math.max(
      0,
      Math.min(
        this.limits.global - this.entries.length,
        this.limits.confirmationLane - lane,
      ),
    );
  }

  /** Le prestataire a répondu `429` : pause courte, toutes voies. */
  providerThrottled(): void {
    this.cooldownUntil = this.monotonic() + this.limits.providerCooldownMs;
  }

  private fits(lane: PaymentCallLane, cost: number, now: number): boolean {
    if (now < this.cooldownUntil) return false;
    const laneMax =
      lane === 'owner' ? this.limits.ownerLane : this.limits.confirmationLane;
    return (
      this.entries.length + cost <= this.limits.global &&
      this.count(lane) + cost <= laneMax
    );
  }

  private count(lane: PaymentCallLane): number {
    return this.entries.filter((e) => e.lane === lane).length;
  }

  private prune(): number {
    const now = this.monotonic();
    this.entries = this.entries.filter(
      (e) => now - e.at < this.limits.windowMs,
    );
    return now;
  }
}
