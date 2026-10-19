// Invitation aux notifications push (correctif « demande répétée ») —
// décision pure, sans accès au navigateur ni au réseau.
//
// Appelée APRÈS la vérification de l'appareil (état serveur, puis
// réconciliation si la permission est déjà accordée) : rien n'est proposé
// tant que cette vérification n'est pas terminée.

/** « Plus tard » : aucune nouvelle invitation push sur cet appareil. */
export const PUSH_DEFER_MS = 7 * 24 * 60 * 60 * 1000;
export const PUSH_DEFERRED_UNTIL_KEY =
  "stockmaster.engagement.pushDeferredUntil";

/**
 * - `push` : permission jamais demandée — le clic « Activer » ouvrira la
 *   demande du navigateur ;
 * - `push-link` : permission DÉJÀ accordée mais cet appareil n'est pas
 *   relié au compte connecté (autre compte avant, abonnement retiré hors
 *   ligne, clé serveur changée…) — un clic suffit, sans demande du
 *   navigateur ;
 * - `push-denied` : refus du navigateur — seulement l'aide aux réglages,
 *   jamais un nouvel appel à `requestPermission`.
 */
export type PushInvitationKind = "push" | "push-link" | "push-denied";

export interface PushInvitationInput {
  permission: NotificationPermission | null;
  /** Appareil rattaché au membre courant (après réconciliation). */
  registered: boolean;
  /** Notifications désactivées volontairement dans Stock Master. */
  optedOut: boolean;
  deferredUntil: number | null;
  now: number;
}

export function decidePushInvitation(
  input: PushInvitationInput,
): PushInvitationKind | null {
  if (input.registered || input.permission === null) return null;
  if (input.optedOut) return null;
  if (input.deferredUntil !== null && input.now < input.deferredUntil) {
    return null;
  }
  switch (input.permission) {
    case "granted":
      return "push-link";
    case "denied":
      return "push-denied";
    default:
      return "push";
  }
}
