/**
 * 1-21D — Capacité incluse : fiches produit CONSERVÉES par organisation.
 *
 * SOURCE UNIQUE du plafond : l'API l'applique (création) et le renvoie
 * (`GET /products/capacity`) ; le web l'importe au build pour les conditions
 * d'abonnement (même procédé que `subscription-pricing.ts`). Module PUR :
 * aucune dépendance ni I/O.
 *
 * Décompte : un document `products` = une fiche (le catalogue n'a pas de
 * variantes : chaque produit est sa propre fiche), quelle que soit sa
 * quantité en stock, rupture comprise, corbeille (`deletedAt`) comprise.
 * Seule la suppression définitive libère une place. Ventes et historiques
 * ne comptent pas. Même capacité pour toutes les durées d'abonnement.
 */
export const PRODUCT_CAPACITY = 1000;

/** Code d'erreur d'une création refusée au plafond (409). */
export const PRODUCT_CAPACITY_REACHED = 'PRODUCT_CAPACITY_REACHED';

/** Une nouvelle fiche est-elle refusée ? (au plafond ou au-delà) */
export function productCapacityReached(conserved: number): boolean {
  return conserved >= PRODUCT_CAPACITY;
}
