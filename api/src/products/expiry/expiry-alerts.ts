/**
 * Lot C — alertes de péremption (règles PURES, aucune E/S).
 *
 * Jour du commerce (`businessDate`, lot A) : une date E reste valide le
 * jour E, elle est dépassée à partir de E+1. Rien ne dépend du téléphone.
 *
 * Deux étapes par cible (lot, ou produit sans lots) et par échéance :
 * - `soon` : entrée dans la période d'anticipation (jour ≥ E − délai) ;
 * - `expired` : date dépassée (jour > E).
 * Une cible découverte déjà dépassée ne reçoit QUE `expired`.
 *
 * Déduplication PERSISTANTE par cible, échéance et étape :
 * - clé d'événement `expiry-<étape>:<cible>:<E>` (index unique des travaux,
 *   conservés sans TTL) : jamais deux alertes, même entre instances ou
 *   après un redémarrage ;
 * - marques sur la cible (`expiryAlerts.soonFor` / `expiredFor` = échéance
 *   déjà annoncée) et prochaine date de contrôle (`expiryAlertNextOn`),
 *   seule clé de l'index partiel du planificateur (cibles en stock).
 *
 * Changement de date : la nouvelle échéance a ses propres étapes (une
 * alerte déjà émise pour une AUTRE date ne compte pas) ; revenir à une
 * date déjà annoncée ne réémet rien (clé existante). Changement de délai :
 * seules les cibles pas encore annoncées sont replanifiées. Une cible vide
 * sort de l'index partiel et y revient à son réapprovisionnement, sans
 * réarmer une étape déjà annoncée.
 */

export const EXPIRY_ALERT_LEAD_DAYS_DEFAULT = 30;
export const EXPIRY_ALERT_LEAD_DAYS_MAX = 365;

export type ExpiryAlertStage = 'soon' | 'expired';

export interface ExpiryAlertMarks {
  soonFor?: string | null;
  expiredFor?: string | null;
}

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date civile + n jours (calcul UTC sur la date seule, sans fuseau). */
export function addCivilDays(date: string, days: number): string {
  const m = CIVIL.exec(date);
  if (!m) throw new Error('date civile invalide');
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export function normalizeLeadDays(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= EXPIRY_ALERT_LEAD_DAYS_MAX
    ? value
    : EXPIRY_ALERT_LEAD_DAYS_DEFAULT;
}

/**
 * Prochain jour où une étape devient due, ou `null` (aucune date, ou
 * toutes les étapes de cette échéance déjà annoncées).
 */
export function nextExpiryAlertOn(
  expiryDate: string | null | undefined,
  leadDays: number,
  marks: ExpiryAlertMarks | null | undefined,
): string | null {
  if (!expiryDate) return null;
  if (marks?.expiredFor === expiryDate) return null;
  if (marks?.soonFor === expiryDate) return addCivilDays(expiryDate, 1);
  return addCivilDays(expiryDate, -leadDays);
}

/**
 * Étape due AUJOURD'HUI pour une cible, et marques / prochaine date après
 * son émission. `null` : rien à annoncer (date absente, hors période, ou
 * déjà annoncé).
 */
export function dueExpiryAlert(
  expiryDate: string | null | undefined,
  today: string,
  leadDays: number,
  marks: ExpiryAlertMarks | null | undefined,
): {
  stage: ExpiryAlertStage;
  marks: ExpiryAlertMarks;
  nextOn: string | null;
} | null {
  if (!expiryDate) return null;
  if (expiryDate < today) {
    if (marks?.expiredFor === expiryDate) return null;
    return {
      stage: 'expired',
      marks: { ...marks, expiredFor: expiryDate },
      nextOn: null,
    };
  }
  if (today < addCivilDays(expiryDate, -leadDays)) return null;
  if (marks?.soonFor === expiryDate) return null;
  return {
    stage: 'soon',
    marks: { ...marks, soonFor: expiryDate },
    nextOn: addCivilDays(expiryDate, 1),
  };
}

/** Clé d'événement : cible + échéance + étape. */
export function expiryAlertEventKey(
  stage: ExpiryAlertStage,
  target: { kind: 'batch' | 'product'; id: string },
  expiryDate: string,
): string {
  return `expiry-${stage}:${target.kind}:${target.id}:${expiryDate}`;
}
