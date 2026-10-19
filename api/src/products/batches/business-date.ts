import { processTimeZone } from '../../analytics/month-range';

/**
 * Règle de date COMMUNE au commerce pour les lots.
 *
 * - « Aujourd'hui » est le jour civil dans le fuseau de l'API
 *   (`processTimeZone`, variable `TZ` : `Africa/Douala` en production), le
 *   même que l'Analyse et l'historique mensuel. Aucune organisation n'a de
 *   fuseau propre : ce choix est documenté et ne dépend jamais du fuseau du
 *   téléphone.
 * - Un lot dont la date de péremption est D est « dépassé » à partir du
 *   lendemain de D (D reste le dernier jour utilisable), comme la date de la
 *   fiche.
 * - Rien n'est stocké : l'état est recalculé à chaque lecture.
 */
export function businessDate(
  now: Date = new Date(),
  timeZone: string = processTimeZone(),
): string {
  // `en-CA` formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export type ExpiryState = 'unknown' | 'valid' | 'expired';

/**
 * Lot B — règle temporelle d'une vente sur un lot daté (date E), évaluée
 * par le SERVEUR au moment où il reçoit la vente :
 *
 * - `valid` : E ≥ aujourd'hui (jour du commerce, horloge serveur). Acceptée,
 *   quelle que soit l'heure déclarée par le client.
 * - `expired` : E < aujourd'hui ET le jour déclaré de la vente est APRÈS E.
 *   La vente déclarée elle-même porte sur un lot dépassé : refus définitif.
 * - `expired_at_sync` : E < aujourd'hui mais le jour déclaré de la vente
 *   est ≤ E (vente hors ligne saisie avant la péremption, synchronisée
 *   après). L'heure déclarée vient de l'appareil : elle ne suffit pas à
 *   établir la validité. Conflit, jamais accepté ni effacé
 *   silencieusement ; seule une régularisation explicite et autorisée
 *   l'enregistre (jamais une autorisation de vendre aujourd'hui).
 */
export type SaleExpiryCheck = 'valid' | 'expired' | 'expired_at_sync';

export function saleExpiryCheck(
  expiryDate: string,
  today: string,
  saleDay: string,
): SaleExpiryCheck {
  if (expiryDate >= today) return 'valid';
  return saleDay > expiryDate ? 'expired' : 'expired_at_sync';
}

/** Comparaison lexicale exacte de deux dates civiles `AAAA-MM-JJ`. */
export function expiryState(
  expiryDate: string | null,
  today: string,
): ExpiryState {
  if (!expiryDate) return 'unknown';
  return expiryDate < today ? 'expired' : 'valid';
}
