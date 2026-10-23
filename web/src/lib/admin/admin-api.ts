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
    throw new AdminApiError(
      response.status,
      code,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return data as T;
}

/** Session à refaire : retour à la connexion de l'administration. */
export function needsSignIn(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.code === "PLATFORM_ADMIN_SESSION_EXPIRED" ||
      error.code === "PLATFORM_ADMIN_MFA_REQUIRED" ||
      error.code === "PLATFORM_ADMIN_ACCESS_DENIED")
  );
}

export type AdminErrorKey =
  | "errors.unavailable"
  | "errors.csrf"
  | "errors.network"
  | "errors.sessionExpired"
  | "errors.accessDenied"
  | "errors.credentials"
  | "errors.emailNotVerified"
  | "errors.challengeRequired"
  | "errors.codeInvalid"
  | "errors.challengeInvalid"
  | "errors.rateLimited"
  | "errors.stepUpRequired"
  | "errors.alreadyEnrolled"
  | "errors.notFound"
  | "errors.generic";

/** Clé de traduction d'une erreur (jamais le texte brut de l'API). */
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
    PLATFORM_ADMIN_ACCESS_DENIED: "errors.accessDenied",
    PLATFORM_ADMIN_CODE_INVALID: "errors.codeInvalid",
    PLATFORM_ADMIN_CHALLENGE_INVALID: "errors.challengeInvalid",
    PLATFORM_ADMIN_RATE_LIMITED: "errors.rateLimited",
    AUTH_RATE_LIMITED: "errors.rateLimited",
    AUTH_CHALLENGE_REQUIRED: "errors.challengeRequired",
    PLATFORM_ADMIN_STEP_UP_REQUIRED: "errors.stepUpRequired",
    PLATFORM_ADMIN_ALREADY_ENROLLED: "errors.alreadyEnrolled",
    PLATFORM_ADMIN_NOT_FOUND: "errors.notFound",
    EMAIL_NOT_VERIFIED: "errors.emailNotVerified",
  };
  if (error.code && byCode[error.code])
    return { key: byCode[error.code], seconds };
  if (error.status === 401) return { key: "errors.credentials", seconds };
  if (error.status === 404) return { key: "errors.notFound", seconds };
  if (error.status === 503) return { key: "errors.unavailable", seconds };
  return { key: "errors.generic", seconds };
}

// ─── Formes des réponses ────────────────────────────────────────────────

export type AdminStage = "enroll" | "verify" | "ready";

export interface AdminStatus {
  stage: AdminStage;
  user: { name: string; email: string };
  session: { idleExpiresAt: string; absoluteExpiresAt: string };
  recoveryCodesRemaining?: number;
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
  "trial" | "paid" | "manual" | "scheduled" | "expired" | "none";

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
