import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * 1-16D — protection de la génération des historiques mensuels (Excel et
 * PDF, construits en mémoire).
 *
 * Indépendante du `ThrottlerModule` partagé : une fenêtre nommée de plus y
 * imposerait une exclusion sur chaque autre contrôleur limité, sans quoi
 * leurs gardes consommeraient ce compteur. Ici, aucun autre compteur n'est
 * lu ni modifié. Mémoire d'une seule instance d'API (comme les autres
 * limitations du projet).
 *
 * - 1-22E : ADMISSION DES DEMANDES, avant toute requête coûteuse (le
 *   comptage lit toutes les ventes du commerce) : quota de demandes par
 *   compte et commerce (429), comptages simultanés bornés (503). Distincte
 *   du quota de génération : un 422 consomme une demande, pas une
 *   génération.
 * - Quota de GÉNÉRATIONS par compte ET commerce sur une fenêtre fixe : 429.
 * - Borne de générations SIMULTANÉES (globale et par commerce) : 503.
 * - 1-22E : volume maximal d'un export (lignes, par format) : 422, vérifié
 *   AVANT la lecture des ventes ; et capacité globale exprimée en COÛT
 *   (lignes × coût du format) : le rendu est synchrone, les rendus admis
 *   ensemble se succèdent sur la boucle d'événements, donc leur coût
 *   cumulé borne l'attente imposée aux autres requêtes du processus. Le
 *   coût admis au comptage est AJUSTÉ (`resize`) aux lignes réellement
 *   chargées avant le rendu ; 503 si le budget ne le permet plus.
 * Aucun rapport n'est jamais tronqué : une demande est servie entière ou
 * refusée, avec `Retry-After` quand réessayer peut aboutir.
 */
export type ReportFileFormat = 'xlsx' | 'pdf';

export interface ReportGenerationLimits {
  /** Durée de la fenêtre des quotas (ms). */
  windowMs: number;
  /** Demandes (comptage compris) admises par compte et commerce et par fenêtre. */
  maxRequestsPerWindow: number;
  /** Comptages simultanés, toutes organisations confondues. */
  maxCountingGlobal: number;
  /** Comptages simultanés d'un même commerce. */
  maxCountingPerOrganization: number;
  /** Générations admises par compte et commerce et par fenêtre. */
  maxPerWindow: number;
  /** Générations simultanées, toutes organisations confondues. */
  maxActiveGlobal: number;
  /** Générations simultanées d'un même commerce (Excel et PDF ensemble). */
  maxActivePerOrganization: number;
  /** `Retry-After` (s) quand une borne de simultanéité est atteinte. */
  busyRetryAfterSeconds: number;
  /** Lignes (ventes + corrections et annulations) admises par export. */
  maxRows: Readonly<Record<ReportFileFormat, number>>;
  /** Coût relatif d'une ligne selon le format (temps de rendu mesuré). */
  rowCost: Readonly<Record<ReportFileFormat, number>>;
  /** Coût cumulé des générations simultanées, toutes organisations. */
  maxActiveCost: number;
}

/**
 * Paramètres centralisés (valeurs de production). Seuils 1-22E mesurés
 * localement (docs/architecture/phase-1-22e-monthly-export-limits.md) :
 * rendu PDF ≈ 0,22 ms et Excel ≈ 0,055 ms par ligne, d'où un coût 4
 * contre 1 ; un export au plafond a bloqué la boucle ≈ 1 s sur le poste
 * de mesure. Budget global : 1,5 export au plafond.
 */
export const REPORT_GENERATION_LIMITS: Readonly<ReportGenerationLimits> =
  Object.freeze({
    windowMs: 10 * 60_000,
    // Deux demandes par génération admise : quelques refus (422, 503)
    // n'empêchent pas d'utiliser tout le quota de génération.
    maxRequestsPerWindow: 40,
    maxCountingGlobal: 4,
    maxCountingPerOrganization: 2,
    maxPerWindow: 20,
    maxActiveGlobal: 3,
    maxActivePerOrganization: 2,
    busyRetryAfterSeconds: 10,
    maxRows: Object.freeze({ xlsx: 20_000, pdf: 5_000 }),
    rowCost: Object.freeze({ xlsx: 1, pdf: 4 }),
    maxActiveCost: 30_000,
  });

/** Coût d'un export de `rows` lignes (au moins 1 : une génération à vide). */
export function reportCost(
  limits: Pick<ReportGenerationLimits, 'rowCost'>,
  format: ReportFileFormat,
  rows: number,
): number {
  return Math.max(1, rows) * limits.rowCost[format];
}

export const REPORT_GENERATION_LIMITS_TOKEN = Symbol(
  'REPORT_GENERATION_LIMITS',
);
export const REPORT_GENERATION_CLOCK = Symbol('REPORT_GENERATION_CLOCK');

export const REPORT_RATE_LIMITED = 'REPORT_RATE_LIMITED';
export const REPORT_REQUESTS_LIMITED = 'REPORT_REQUESTS_LIMITED';
export const REPORT_GENERATION_BUSY = 'REPORT_GENERATION_BUSY';
export const REPORT_TOO_LARGE = 'REPORT_TOO_LARGE';

export type ReportGenerationDecision =
  | {
      admitted: true;
      /**
       * Remplace le coût réservé (lignes réellement chargées). `false` si
       * le budget global ne le permet pas : réservation inchangée, que
       * l'appelant libère.
       */
      resize: (cost: number) => boolean;
      release: () => void;
    }
  | {
      admitted: false;
      code: typeof REPORT_RATE_LIMITED | typeof REPORT_GENERATION_BUSY;
      retryAfterSeconds: number;
    };

export type ReportRequestDecision =
  | { admitted: true; release: () => void }
  | {
      admitted: false;
      code: typeof REPORT_REQUESTS_LIMITED | typeof REPORT_GENERATION_BUSY;
      retryAfterSeconds: number;
    };

interface QuotaWindow {
  startedAt: number;
  count: number;
}

@Injectable()
export class ReportGenerationLimiter {
  private readonly windows = new Map<string, QuotaWindow>();
  private readonly requestWindows = new Map<string, QuotaWindow>();
  private readonly countingByOrganization = new Map<string, number>();
  private countingTotal = 0;
  private readonly activeByOrganization = new Map<string, number>();
  private activeTotal = 0;
  private activeCost = 0;

  constructor(
    @Optional()
    @Inject(REPORT_GENERATION_LIMITS_TOKEN)
    readonly limits: ReportGenerationLimits = REPORT_GENERATION_LIMITS,
    @Optional()
    @Inject(REPORT_GENERATION_CLOCK)
    private readonly now: () => number = Date.now,
  ) {}

  /** Générations en cours (contrôle des verrous dans les tests). */
  get active(): number {
    return this.activeTotal;
  }

  /** Coût des générations en cours. */
  get activeCostTotal(): number {
    return this.activeCost;
  }

  /** Comptages en cours. */
  get counting(): number {
    return this.countingTotal;
  }

  /**
   * Admet une DEMANDE avant son comptage : quota de demandes, puis place
   * de comptage (refus sans rien consommer). `release` (idempotente) DOIT
   * être appelée une fois le comptage et l'admission de génération faits.
   */
  admitRequest(userId: string, organizationId: string): ReportRequestDecision {
    const now = this.now();
    this.prune(now);
    const key = `${userId}:${organizationId}`;
    const window = this.requestWindows.get(key);
    if (window && window.count >= this.limits.maxRequestsPerWindow) {
      return {
        admitted: false,
        code: REPORT_REQUESTS_LIMITED,
        retryAfterSeconds: this.retryAfter(window, now),
      };
    }
    const orgCounting = this.countingByOrganization.get(organizationId) ?? 0;
    if (
      this.countingTotal >= this.limits.maxCountingGlobal ||
      orgCounting >= this.limits.maxCountingPerOrganization
    ) {
      return {
        admitted: false,
        code: REPORT_GENERATION_BUSY,
        retryAfterSeconds: this.limits.busyRetryAfterSeconds,
      };
    }
    if (window) window.count += 1;
    else this.requestWindows.set(key, { startedAt: now, count: 1 });
    this.countingTotal += 1;
    this.countingByOrganization.set(organizationId, orgCounting + 1);
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.countingTotal -= 1;
        decrement(this.countingByOrganization, organizationId);
      },
    };
  }

  /**
   * Admet une génération de coût `cost` (`reportCost`, export déjà borné
   * par `maxRows`) ou la refuse temporairement. En cas d'admission,
   * `release` DOIT être appelée (bloc `finally`) ; elle est idempotente.
   */
  acquire(
    userId: string,
    organizationId: string,
    cost: number,
  ): ReportGenerationDecision {
    const now = this.now();
    this.prune(now);
    const key = `${userId}:${organizationId}`;
    const window = this.windows.get(key);
    if (window && window.count >= this.limits.maxPerWindow) {
      return {
        admitted: false,
        code: REPORT_RATE_LIMITED,
        retryAfterSeconds: this.retryAfter(window, now),
      };
    }
    const orgActive = this.activeByOrganization.get(organizationId) ?? 0;
    if (
      this.activeTotal >= this.limits.maxActiveGlobal ||
      orgActive >= this.limits.maxActivePerOrganization ||
      this.activeCost + cost > this.limits.maxActiveCost
    ) {
      // Refus de simultanéité : le quota n'est pas consommé.
      return {
        admitted: false,
        code: REPORT_GENERATION_BUSY,
        retryAfterSeconds: this.limits.busyRetryAfterSeconds,
      };
    }
    if (window) window.count += 1;
    else this.windows.set(key, { startedAt: now, count: 1 });
    this.activeTotal += 1;
    this.activeCost += cost;
    this.activeByOrganization.set(organizationId, orgActive + 1);

    let reserved = cost;
    let released = false;
    return {
      admitted: true,
      // Synchrone : aucune autre admission ne s'intercale (boucle unique).
      resize: (next: number) => {
        if (released) return false;
        if (this.activeCost - reserved + next > this.limits.maxActiveCost) {
          return false;
        }
        this.activeCost += next - reserved;
        reserved = next;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.activeTotal -= 1;
        this.activeCost -= reserved;
        decrement(this.activeByOrganization, organizationId);
      },
    };
  }

  private retryAfter(window: QuotaWindow, now: number): number {
    return Math.max(
      1,
      Math.ceil((window.startedAt + this.limits.windowMs - now) / 1000),
    );
  }

  /** Fenêtres expirées retirées : mémoire bornée aux comptes récents. */
  private prune(now: number): void {
    for (const windows of [this.windows, this.requestWindows]) {
      for (const [key, window] of windows) {
        if (now - window.startedAt >= this.limits.windowMs) {
          windows.delete(key);
        }
      }
    }
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const left = (map.get(key) ?? 1) - 1;
  if (left > 0) map.set(key, left);
  else map.delete(key);
}
