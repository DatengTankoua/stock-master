// Administration de la plateforme — appels du navigateur vers le BFF de même
// origine (`/api/admin/*`). Aucun jeton n'est manipulé ici : la session vit
// dans un cookie HttpOnly. Aucune réponse n'est conservée (ni stockage local,
// ni IndexedDB, ni cache HTTP).
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE } from "@/lib/admin/bff-policy";

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfter: number | null,
    /** Référence opaque (journaux serveur), jamais une information. */
    readonly reference: string | null = null,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = "AdminApiError";
  }
}

export async function adminRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/admin/${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new AdminApiError(0, "NETWORK", null);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      data && typeof (data as { code?: unknown }).code === "string"
        ? (data as { code: string }).code
        : null;
    const retry = Number(response.headers.get("retry-after"));
    const reference = (data as { reference?: unknown } | null)?.reference;
    throw new AdminApiError(
      response.status,
      code,
      Number.isFinite(retry) && retry > 0 ? retry : null,
      typeof reference === "string" && /^[0-9a-f]{12}$/.test(reference)
        ? reference
        : null,
    );
  }
  return data as T;
}

/**
 * Marqueur « déconnexion d'administration en attente » (aucun secret : une
 * simple valeur `1`). Posé quand la requête n'a pas pu atteindre le serveur
 * web (hors ligne, délai dépassé) : le cookie HttpOnly reste alors sur
 * l'appareil. Retiré dès qu'une réponse du serveur web arrive (le BFF efface
 * toujours le cookie à la déconnexion).
 */
export const ADMIN_LOGOUT_PENDING_KEY = "stockmaster.admin.logout-pending";

function setLogoutPending(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(ADMIN_LOGOUT_PENDING_KEY, "1");
    else localStorage.removeItem(ADMIN_LOGOUT_PENDING_KEY);
  } catch {
    // Stockage indisponible (navigation privée) : aucune relance possible.
  }
}

export function adminLogoutPending(): boolean {
  try {
    return localStorage.getItem(ADMIN_LOGOUT_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Déconnexion d'administration (déconnexion générale d'un commerce ou
 * bouton de la console). Jamais bloquante (3 s au plus), aucune erreur
 * remontée. Renvoie `pending` si le serveur web n'a pas été atteint : le
 * marqueur est posé et la déconnexion sera rejouée au retour du réseau, au
 * prochain chargement et avant toute ouverture de la console.
 */
export async function endAdminSessionQuietly(): Promise<"done" | "pending"> {
  let reached = false;
  try {
    await fetch("/api/admin/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    });
    // Toute réponse HTTP vient du serveur web, qui a effacé le cookie.
    reached = true;
  } catch {
    // Hors ligne ou délai dépassé : le cookie est toujours là.
  }
  setLogoutPending(!reached);
  return reached ? "done" : "pending";
}

/** Rejoue une déconnexion restée en attente (sans effet sinon). */
export async function retryPendingAdminLogout(): Promise<void> {
  if (adminLogoutPending()) await endAdminSessionQuietly();
}

/** Session à refaire : retour à la connexion de l'administration. */
export function needsSignIn(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.code === "PLATFORM_ADMIN_SESSION_EXPIRED" ||
      error.code === "PLATFORM_ADMIN_MFA_REQUIRED")
  );
}

export type AdminErrorKey =
  | "errors.unavailable"
  | "errors.csrf"
  | "errors.network"
  | "errors.sessionExpired"
  | "errors.loginFailed"
  | "errors.invalidRequest"
  | "errors.challengeRequired"
  | "errors.antiBotFailed"
  | "errors.antiBotUnavailable"
  | "errors.codeInvalid"
  | "errors.challengeInvalid"
  | "errors.rateLimited"
  | "errors.stepUpRequired"
  | "errors.alreadyEnrolled"
  | "errors.notFound"
  | "errors.capabilityRequired"
  | "errors.operationConflict"
  | "errors.stateChanged"
  | "errors.extensionRefused"
  | "errors.messageRecipientLimit"
  | "errors.messageRateLimited"
  | "errors.messageRecipientsChanged"
  | "errors.messageNotRetryable"
  | "errors.messageRetryWindowExpired"
  | "errors.generic";

/**
 * Référence affichée sous un message d'erreur : identifiant opaque et
 * aléatoire posé par le BFF, à rapprocher de son journal serveur. Ne
 * contient aucune information sur l'application (ni code, ni statut).
 */
export function adminErrorReference(error: unknown): string | null {
  return error instanceof AdminApiError ? error.reference : null;
}

/**
 * Clé de traduction d'une erreur, à partir des seuls codes PUBLICS du BFF
 * (`bff-policy.ts`, `publicError`). Les messages ne citent ni configuration,
 * ni composant, ni l'existence d'un compte.
 */
export function adminErrorKey(error: unknown): {
  key: AdminErrorKey;
  seconds: number;
} {
  const seconds =
    error instanceof AdminApiError ? (error.retryAfter ?? 60) : 60;
  if (!(error instanceof AdminApiError))
    return { key: "errors.generic", seconds };
  const byCode: Record<string, AdminErrorKey> = {
    NETWORK: "errors.network",
    PLATFORM_ADMIN_UNAVAILABLE: "errors.unavailable",
    PLATFORM_ADMIN_CSRF_REJECTED: "errors.csrf",
    PLATFORM_ADMIN_SESSION_EXPIRED: "errors.sessionExpired",
    PLATFORM_ADMIN_MFA_REQUIRED: "errors.sessionExpired",
    PLATFORM_ADMIN_LOGIN_FAILED: "errors.loginFailed",
    PLATFORM_ADMIN_INVALID_REQUEST: "errors.invalidRequest",
    PLATFORM_ADMIN_CODE_INVALID: "errors.codeInvalid",
    PLATFORM_ADMIN_CHALLENGE_INVALID: "errors.challengeInvalid",
    PLATFORM_ADMIN_RATE_LIMITED: "errors.rateLimited",
    AUTH_RATE_LIMITED: "errors.rateLimited",
    AUTH_CHALLENGE_REQUIRED: "errors.challengeRequired",
    TURNSTILE_FAILED: "errors.antiBotFailed",
    TURNSTILE_REQUIRED: "errors.antiBotFailed",
    TURNSTILE_UNAVAILABLE: "errors.antiBotUnavailable",
    PLATFORM_ADMIN_STEP_UP_REQUIRED: "errors.stepUpRequired",
    PLATFORM_ADMIN_ALREADY_ENROLLED: "errors.alreadyEnrolled",
    PLATFORM_ADMIN_NOT_FOUND: "errors.notFound",
    PLATFORM_ADMIN_CAPABILITY_REQUIRED: "errors.capabilityRequired",
    PLATFORM_ADMIN_OPERATION_CONFLICT: "errors.operationConflict",
    PLATFORM_ADMIN_STATE_CHANGED: "errors.stateChanged",
    PLATFORM_ADMIN_EXTENSION_REFUSED: "errors.extensionRefused",
    PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT: "errors.messageRecipientLimit",
    PLATFORM_ADMIN_MESSAGE_RATE_LIMITED: "errors.messageRateLimited",
    PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED:
      "errors.messageRecipientsChanged",
    PLATFORM_ADMIN_MESSAGE_NOT_RETRYABLE: "errors.messageNotRetryable",
    PLATFORM_ADMIN_MESSAGE_RETRY_WINDOW_EXPIRED:
      "errors.messageRetryWindowExpired",
  };
  if (error.code && byCode[error.code])
    return { key: byCode[error.code], seconds };
  // Mot de passe faux pendant une vérification renforcée (session ouverte).
  if (error.status === 401) return { key: "errors.loginFailed", seconds };
  if (error.status >= 500) return { key: "errors.unavailable", seconds };
  return { key: "errors.generic", seconds };
}

// ─── Formes des réponses ────────────────────────────────────────────────

export type AdminStage = "enroll" | "verify" | "ready";

export interface AdminStatus {
  stage: AdminStage;
  user: { name: string; email: string };
  session: { idleExpiresAt: string; absoluteExpiresAt: string };
  recoveryCodesRemaining?: number;
  /** Capacités plateforme (session complète seulement). */
  capabilities?: PlatformCapability[];
}

export interface AdminChallenge {
  token: string;
  expiresAt: string;
}

export interface AdminPage<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export type SubscriptionClass =
  "trial" | "paid" | "offered" | "manual" | "scheduled" | "expired" | "none";

export interface AdminOverview {
  generatedAt: string;
  organizations: { total: number; suspended: number };
  subscriptions: Record<SubscriptionClass, number>;
  registrations: { last7Days: number; last30Days: number };
  payments: {
    collected30Days: { count: number; amount: number; currency: string };
    toReview: number;
  };
}

export interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  createdAt: string;
  subscription: SubscriptionClass;
  coverageEndsAt: string | null;
  activeMembers: number;
}

export interface AdminPaymentRow {
  id: string;
  organization: { id: string; name: string | null };
  term: string;
  amount: number;
  currency: string;
  provider: string;
  providerReference: string | null;
  merchantReference: string;
  status: string;
  incidentCode: string | null;
  createdAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  period: { startsAt: string; endsAt: string } | null;
}

export interface AdminOrganizationDetail {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  currency: string;
  createdAt: string;
  owner: { name: string; email: string; emailVerified: boolean } | null;
  members: { owner: number; admin: number; seller: number; total: number };
  quotas: {
    products: { used: number; trashed: number; limit: number };
    storage: {
      usedBytes: number;
      reservedBytes: number;
      limitBytes: number;
      enforced: boolean;
    } | null;
  };
  subscription: {
    class: SubscriptionClass;
    coverageEndsAt: string | null;
    periods: Array<{
      kind: string;
      source: string;
      term: string | null;
      startsAt: string;
      endsAt: string;
      current: boolean;
    }>;
  };
  features: { productBatches: boolean; expiryAlerts: boolean };
  recentPayments: AdminPaymentRow[];
  /** Suspension administrative : motif interne et message, séparés. */
  suspension: {
    suspendedAt: string | null;
    suspendedBy: string | null;
    internalReason: string | null;
    clientMessage: string | null;
  } | null;
  actions: AdminActionHistoryEntry[];
}

export interface AdminAuditRow {
  id: string;
  at: string;
  actorType: "admin" | "operator" | "anonymous";
  actor: { name: string; email: string } | null;
  actorLabel: string | null;
  action: string;
  outcome: "success" | "failure" | "denied";
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
}

export interface AdminProvisioning {
  uri: string;
  manualKey: string;
  challenge: AdminChallenge;
}

export type PlatformCapability =
  | "platform.read"
  | "platform.organizations.suspend"
  | "platform.subscriptions.extend"
  | "platform.communications.notify"
  | "platform.communications.email";

export type AdminActionKind =
  "organization_suspend" | "organization_reactivate" | "subscription_extend";

export interface AdminActionHistoryEntry {
  operationId: string;
  action: AdminActionKind;
  at: string;
  actor: string | null;
  reason: string;
  result: Record<string, unknown>;
}

export interface AdminExtensionPreview {
  organizationId: string;
  days: number;
  organizationStatus: string;
  state: {
    state: "none" | "active" | "expired" | "scheduled";
    currentPeriodKind: string | null;
    coverageEndsAt: string | null;
  };
  plan:
    | {
        ok: true;
        basis: "extend-coverage" | "start-now";
        previousCoverageEndsAt: string | null;
        startsAt: string;
        endsAt: string;
        scheduledPeriods: number;
      }
    | {
        ok: false;
        refusal: "SCHEDULED_WITHOUT_CURRENT" | "DISCONTINUOUS_COVERAGE";
      };
}

export interface AdminActionOutcome {
  operationId: string;
  action: AdminActionKind;
  replayed: boolean;
  result: Record<string, unknown>;
}

// ─── Messages de service ────────────────────────────────────────────────

export type MessageChannel = "in_app" | "email";

/** Bornes miroir de l'API (refus au-delà, jamais de troncature). */
export const MESSAGE_TITLE_MAX = 150;
export const MESSAGE_BODY_MAX = 5_000;

export interface AdminMessageRecipients {
  organization: { id: string; name: string; status: "active" | "suspended" };
  /** Canaux ouverts par les capacités de la session. */
  channels: MessageChannel[];
  members: Array<{
    userId: string;
    name: string;
    email: string;
    role: "owner" | "admin" | "seller";
    /** Compte vérifié : joignable. */
    eligible: boolean;
  }>;
  limits: {
    maxRecipients: number;
    titleMaxLength: number;
    bodyMaxLength: number;
    organization: { max: number; windowHours: number; used: number };
    actor: { max: number; windowHours: number; used: number };
  };
}

export type MessageDeliveryStatus =
  | "pending"
  | "sending"
  | "created"
  | "accepted"
  | "skipped"
  | "failed"
  | "uncertain";

export interface AdminMessageDelivery {
  id: string;
  userId: string;
  channel: MessageChannel;
  status: MessageDeliveryStatus;
  reason: string | null;
  attempts: number;
  manualRetries: number;
  updatedAt: string;
  completedAt: string | null;
  uncertain: boolean;
  retryable: boolean;
  retryWindowExpired: boolean;
}

export interface AdminMessage {
  id: string;
  operationId: string;
  at: string;
  actor: string | null;
  title: string;
  body: string;
  channels: MessageChannel[];
  recipients: Array<{
    userId: string;
    name: string | null;
    email: string | null;
  }>;
  deliveries: AdminMessageDelivery[];
}

export interface AdminMessageOutcome {
  operationId: string;
  action: "organization_message" | "organization_message_retry";
  replayed: boolean;
  result: Record<string, unknown>;
}
