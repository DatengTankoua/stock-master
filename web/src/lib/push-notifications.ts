// Notifications Web Push (1-16A) — côté navigateur.
//
// - Permission demandée UNIQUEMENT depuis une action explicite (bouton
//   « Activer les notifications »), jamais au chargement.
// - Le service worker EXISTANT (`/sw.js`, même scope) reçoit les messages ;
//   aucun second worker n'est enregistré.
// - Utilisateur, organisation et droits sont décidés par le serveur : ce
//   module n'envoie que l'abonnement du navigateur et des préférences.
// - Aucune donnée personnelle n'est conservée localement : l'abonnement vit
//   dans le navigateur (PushManager) et côté serveur ; seul un indicateur
//   « désactivé volontairement sur cet appareil » est mémorisé.
// - Trois notions distinctes : permission du navigateur (par origine),
//   abonnement PushManager (par origine et service worker), rattachement
//   de cet abonnement à un compte (serveur, avec ses préférences).
import axios from "axios";
import { apiClient } from "./api";
import { withTimeout } from "./offline-db-utils";

export type PushCategory =
  | "stock-depleted"
  | "stock-low"
  | "sale-created"
  | "subscription-ending"
  | "payment-succeeded"
  | "monthly-report"
  // 1-19A.
  | "member-joined"
  | "member-activity"
  // Lot C.
  | "expiry-soon"
  | "expiry-expired"
  | "regularization-requested";

export interface PushPreferences {
  stockDepleted: boolean;
  stockLow: boolean;
  saleCreated: boolean;
  subscriptionEnding: boolean;
  paymentSucceeded: boolean;
  monthlyReport: boolean;
  memberJoined: boolean;
  memberActivity: boolean;
  expirySoon: boolean;
  expiryExpired: boolean;
  regularizationRequested: boolean;
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  categories: PushCategory[];
}

export interface PushDeviceState {
  registered: boolean;
  preferences: PushPreferences | null;
}

/**
 * - `supported` : Push API disponible ;
 * - `ios-install-required` : iPhone/iPad dans un onglet Safari — le Web Push
 *   n'y est proposé qu'aux applications ajoutées à l'écran d'accueil ;
 * - `unsupported` : navigateur sans Push API, service worker ou
 *   notifications (ou contexte non sécurisé).
 */
export type PushSupport = "supported" | "ios-install-required" | "unsupported";

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS se présente comme un Mac tactile.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function getPushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const available =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (available) return "supported";
  if (isAppleMobile() && !isStandalone()) return "ios-install-required";
  return "unsupported";
}

export function getNotificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey + "=".repeat((4 - (publicKey.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(
  subscription: PushSubscription,
  expected: Uint8Array,
): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === expected.length && bytes.every((b, i) => b === expected[i])
  );
}

/** Enregistrement du service worker existant (jamais un autre script). */
async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await existingRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

function serialize(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

// ─── API ─────────────────────────────────────────────────────────────────────

export async function fetchPushConfig(): Promise<PushConfig> {
  const { data } = await apiClient.get<PushConfig>(
    "/notifications/push/config",
  );
  return data;
}

/** État de CET appareil pour le membre courant (jamais d'endpoint renvoyé). */
export async function fetchPushDeviceState(): Promise<PushDeviceState> {
  const subscription = await currentSubscription();
  if (!subscription) return { registered: false, preferences: null };
  const { data } = await apiClient.post<PushDeviceState>(
    "/notifications/push/subscription/status",
    { endpoint: subscription.endpoint },
  );
  return data;
}

/** Désactivation volontaire depuis Stock Master sur CET appareil. */
export const PUSH_OPTED_OUT_KEY = "stockmaster.push.optedOut";

export function isPushOptedOut(): boolean {
  try {
    return localStorage.getItem(PUSH_OPTED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setPushOptedOut(value: boolean): void {
  try {
    if (value) localStorage.setItem(PUSH_OPTED_OUT_KEY, "1");
    else localStorage.removeItem(PUSH_OPTED_OUT_KEY);
  } catch {
    // stockage indisponible : choix simplement non mémorisé
  }
}

// Déconnexion en cours : aucune nouvelle réconciliation n'est envoyée. Une
// réconciliation DÉJÀ partie est neutralisée par le serveur (`release`
// marque la session ; sa réconciliation est refusée quel que soit l'ordre
// de traitement).
let releasing = false;

/**
 * Réconciliation SANS action de l'utilisateur ni `requestPermission` :
 * uniquement si la permission est DÉJÀ accordée et qu'un abonnement local
 * créé avec la clé serveur courante existe. Le serveur ne le rattache qu'au
 * même utilisateur qu'avant (session vérifiée) ; sinon l'appareil reste
 * absent et une action explicite est nécessaire.
 */
export async function reconcilePushSubscription(
  publicKey: string,
): Promise<PushDeviceState> {
  const absent: PushDeviceState = { registered: false, preferences: null };
  if (releasing || getNotificationPermission() !== "granted") return absent;
  const subscription = await currentSubscription();
  if (
    releasing ||
    !subscription ||
    !sameKey(subscription, applicationServerKey(publicKey))
  ) {
    return absent;
  }
  const { data } = await apiClient.post<PushDeviceState>(
    "/notifications/push/subscription/reconcile",
    { subscription: serialize(subscription) },
  );
  return data;
}

export class PushPermissionDeniedError extends Error {
  constructor() {
    // Message technique (jamais affiché : l'interface traduit ce cas).
    super("PUSH_PERMISSION_DENIED");
    this.name = "PushPermissionDeniedError";
  }
}

/**
 * Activation : À APPELER DEPUIS UN CLIC. Demande la permission, abonne le
 * navigateur via le service worker existant puis enregistre l'appareil
 * pour le membre courant.
 */
export async function enablePushNotifications(
  publicKey: string,
): Promise<PushDeviceState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionDeniedError();
  const registration = await navigator.serviceWorker.ready;
  const key = applicationServerKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // Clé serveur changée (rotation VAPID) : ancien abonnement inutilisable.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const { data } = await apiClient.post<PushDeviceState>(
    "/notifications/push/subscription",
    { subscription: serialize(subscription) },
  );
  setPushOptedOut(false);
  return data;
}

export async function updatePushPreferences(
  preferences: Partial<PushPreferences>,
): Promise<PushDeviceState> {
  const subscription = await currentSubscription();
  if (!subscription) return { registered: false, preferences: null };
  const { data } = await apiClient.patch<PushDeviceState>(
    "/notifications/push/subscription",
    { endpoint: subscription.endpoint, preferences },
  );
  return data;
}

/** Désactivation explicite : retrait serveur PUIS désabonnement local. */
export async function disablePushNotifications(): Promise<void> {
  // Choix respecté : plus d'invitation automatique sur cet appareil (les
  // réglages permettent toujours de réactiver).
  setPushOptedOut(true);
  const subscription = await currentSubscription();
  if (!subscription) return;
  try {
    await apiClient.post("/notifications/push/subscription/remove", {
      endpoint: subscription.endpoint,
    });
  } finally {
    await subscription.unsubscribe().catch(() => false);
  }
}

/**
 * Déconnexion : best effort, borné, jamais bloquant. Détachement serveur
 * avec le jeton de la session qui se termine (client HTTP brut : un refus
 * ne déclenche aucune redirection) : plus aucun envoi vers ce navigateur,
 * préférences conservées. CONFIRMÉ par le serveur, l'abonnement local est
 * gardé : à la reconnexion du MÊME compte, il est réconcilié sans nouvelle
 * demande. Sinon (hors ligne, erreur, API plus ancienne), désabonnement
 * local comme avant : l'endpoint devient invalide (404/410 au prochain
 * envoi) et le service worker n'affiche de toute façon aucun contenu sans
 * identité locale correspondante.
 */
export async function releasePushOnLogout(token: string | null): Promise<void> {
  releasing = true;
  const run = async () => {
    const subscription = await currentSubscription();
    if (!subscription) return;
    let released = false;
    if (token && navigator.onLine !== false) {
      released = await axios
        .post(
          `${process.env.NEXT_PUBLIC_API_URL ?? ""}/notifications/push/subscription/release`,
          { endpoint: subscription.endpoint },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 2000 },
        )
        .then(
          (res) => res.status === 204,
          () => false,
        );
    }
    if (!released) await subscription.unsubscribe().catch(() => false);
  };
  try {
    await withTimeout(
      run().catch(() => undefined),
      3000,
      () => {
        // Délai dépassé (détachement non confirmé) : désabonnement local.
        void currentSubscription()
          .then((subscription) => subscription?.unsubscribe())
          .catch(() => false);
      },
    );
  } finally {
    releasing = false;
  }
}
