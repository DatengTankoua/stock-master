/**
 * Portée d'une activation par COMMERCE (pilote), lue dans une variable
 * d'environnement `<FONCTION>_ORGANIZATIONS` à côté de `<FONCTION>_ENABLED`.
 * Portée EXPLICITE, refus par défaut :
 *
 * - `all` (valeur exacte, casse indifférente) : activation GLOBALE (tous
 *   les commerces), signalée au démarrage ;
 * - liste d'identifiants d'organisation séparés par des virgules : seuls
 *   ces commerces ; les autres restent exactement inchangés ;
 * - absente ou vide : AUCUN commerce ;
 * - toute autre valeur (identifiant invalide, `all` mêlé à une liste) :
 *   AUCUN commerce, signalé au démarrage.
 *
 * Lu à chaque appel (aucun état figé), comme les drapeaux d'activation.
 * Ce n'est pas un système général de feature flags : seules les deux
 * activations des lots l'utilisent.
 */
export type OrganizationScope =
  | { kind: 'all' }
  | { kind: 'list'; ids: ReadonlySet<string> }
  | { kind: 'none' }
  | { kind: 'invalid' };

/** Valeur explicite de l'activation globale. */
export const ALL_ORGANIZATIONS = 'all';

const OBJECT_ID = /^[0-9a-f]{24}$/;

export function parseOrganizationScope(
  value: string | undefined,
): OrganizationScope {
  if (value === undefined || value.trim() === '') return { kind: 'none' };
  if (value.trim().toLowerCase() === ALL_ORGANIZATIONS) return { kind: 'all' };
  const ids = value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !OBJECT_ID.test(id))) {
    return { kind: 'invalid' };
  }
  return { kind: 'list', ids: new Set(ids) };
}

export function inOrganizationScope(
  scope: OrganizationScope,
  organizationId: string,
): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind !== 'list') return false;
  return scope.ids.has(organizationId.toLowerCase());
}

/** Filtre MongoDB d'un balayage : `null` = tous ; liste vide = aucun. */
export function organizationScopeIds(
  scope: OrganizationScope,
): string[] | null {
  if (scope.kind === 'all') return null;
  if (scope.kind !== 'list') return [];
  return [...scope.ids];
}
