/**
 * Capacités de l'administration de la PLATEFORME. Espace de noms `platform.`
 * totalement distinct des permissions délégables des commerces
 * (`DELEGABLE_PERMISSIONS`) : aucune invitation, aucun rôle de commerce,
 * aucune route ne peut les accorder. Seule la commande opérateur
 * `platform-admin capability-add|capability-remove` les modifie (lecture
 * seule par défaut, `--apply`, motif, audit).
 *
 * Autorisation sans champ `capabilities` (créée avant ce lot) ou nouvelle
 * autorisation : lecture seule (`platform.read`).
 */
export const PLATFORM_CAPABILITIES = [
  /** Consulter les données administratives (vue d'ensemble, fiches, paiements, audit). */
  'platform.read',
  /** Suspendre et réactiver un commerce. */
  'platform.organizations.suspend',
  /** Accorder une prolongation commerciale offerte. */
  'platform.subscriptions.extend',
  /**
   * Envoyer (ou relancer) un message de service aux membres d'un commerce
   * par le centre de notifications (et le push qui l'accompagne).
   */
  'platform.communications.notify',
  /** Envoyer (ou relancer) un message de service par e-mail. */
  'platform.communications.email',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export const DEFAULT_PLATFORM_CAPABILITIES: readonly PlatformCapability[] =
  Object.freeze(['platform.read']);

export function isPlatformCapability(
  value: unknown,
): value is PlatformCapability {
  return (
    typeof value === 'string' &&
    (PLATFORM_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Capacités effectives d'une autorisation ACTIVE (valeurs inconnues ignorées). */
export function effectiveCapabilities(grant: {
  capabilities?: readonly unknown[] | null;
}): ReadonlySet<PlatformCapability> {
  const stored = Array.isArray(grant.capabilities)
    ? grant.capabilities.filter(isPlatformCapability)
    : [...DEFAULT_PLATFORM_CAPABILITIES];
  return new Set(stored);
}
