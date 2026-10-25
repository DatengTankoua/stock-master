// Administration de la plateforme — règles PURES du BFF (route serveur
// `/api/admin/*`, même origine que les pages). Aucune dépendance Next.js :
// testé par `scripts/test-admin-bff.mjs`.
//
// - Le navigateur n'a jamais de jeton administratif : le jeton de session
//   vit dans un cookie HttpOnly, SameSite=Strict, Secure en production,
//   posé et lu UNIQUEMENT ici, puis transmis à l'API en en-tête serveur.
// - Anti-CSRF : en-tête dédié obligatoire (une page tierce ne peut pas
//   l'ajouter sans pré-vérification CORS, que cette route ne sert jamais),
//   `Sec-Fetch-Site` same-origin quand le navigateur l'envoie, et Origin
//   exacte (configurée) sur toute requête qui modifie un état.
// - Seules les routes listées ici sont relayées (méthode + forme du chemin).

export const ADMIN_CSRF_HEADER = "x-stockmaster-admin";
export const ADMIN_CSRF_VALUE = "1";

/** Nom du cookie : préfixe `__Host-` en HTTPS (hôte exact, Path=/, Secure). */
export function adminCookieName(secure: boolean): string {
  return secure ? "__Host-sm_admin" : "sm_admin";
}

/** Durée maximale du cookie : l'échéance réelle est décidée par l'API. */
export const ADMIN_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface AdminCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function adminCookieOptions(secure: boolean): AdminCookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE_SECONDS,
  };
}

type Method = "GET" | "POST";

const ROUTES: ReadonlyArray<{ method: Method; pattern: RegExp }> = [
  { method: "POST", pattern: /^auth\/login$/ },
  { method: "GET", pattern: /^auth\/status$/ },
  { method: "POST", pattern: /^auth\/logout$/ },
  { method: "POST", pattern: /^mfa\/challenge$/ },
  { method: "POST", pattern: /^mfa\/verify$/ },
  { method: "POST", pattern: /^mfa\/enrollment\/(start|confirm)$/ },
  { method: "POST", pattern: /^security\/step-up$/ },
  { method: "POST", pattern: /^security\/recovery-codes$/ },
  { method: "POST", pattern: /^security\/factor\/(start|confirm)$/ },
  { method: "GET", pattern: /^overview$/ },
  { method: "GET", pattern: /^organizations$/ },
  { method: "GET", pattern: /^organizations\/[0-9a-f]{24}$/ },
  {
    method: "GET",
    pattern: /^organizations\/[0-9a-f]{24}\/extension-preview$/,
  },
  {
    method: "POST",
    pattern: /^organizations\/[0-9a-f]{24}\/(suspend|reactivate|extend)$/,
  },
  { method: "GET", pattern: /^payments$/ },
  { method: "GET", pattern: /^audit$/ },
];

/** Chemin API relayé, ou `null` (route inconnue ou méthode refusée). */
export function resolveAdminRoute(
  method: string,
  segments: readonly string[],
): string | null {
  if (segments.length === 0 || segments.length > 3) return null;
  if (!segments.every((s) => /^[a-z0-9-]{1,40}$/.test(s))) return null;
  const path = segments.join("/");
  return ROUTES.some((r) => r.method === method && r.pattern.test(path))
    ? path
    : null;
}

/** Clés de requête acceptées (les valeurs sont validées par l'API). */
const QUERY_KEYS = new Set([
  "page",
  "q",
  "status",
  "subscription",
  "organizationId",
  "action",
  "outcome",
  "days",
]);

export function filterAdminQuery(search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const [key, value] of search) {
    if (QUERY_KEYS.has(key) && !kept.has(key) && value.length <= 100) {
      kept.set(key, value);
    }
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

export type CsrfVerdict = "ok" | "missing-header" | "cross-site" | "bad-origin";

/** Contrôle anti-CSRF et d'origine, sur chaque requête relayée. */
export function checkAdminRequest(input: {
  method: string;
  csrfHeader: string | null;
  secFetchSite: string | null;
  origin: string | null;
  allowedOrigin: string;
}): CsrfVerdict {
  if (input.csrfHeader !== ADMIN_CSRF_VALUE) return "missing-header";
  if (input.secFetchSite !== null && input.secFetchSite !== "same-origin") {
    return "cross-site";
  }
  if (input.method !== "GET" && input.origin !== input.allowedOrigin) {
    return "bad-origin";
  }
  if (input.origin !== null && input.origin !== input.allowedOrigin) {
    return "bad-origin";
  }
  return "ok";
}

/**
 * En-têtes d'adresse acceptés : uniquement ceux que l'hébergeur ÉCRASE à
 * chaque requête (Vercel : `x-real-ip`, `x-vercel-forwarded-for` ; nginx du
 * dépôt : `x-real-ip` = `$remote_addr`). Jamais `x-forwarded-for` (une
 * valeur envoyée par le client peut y subsister).
 */
export const TRUSTED_CLIENT_IP_HEADERS = [
  "x-real-ip",
  "x-vercel-forwarded-for",
] as const;
export type TrustedClientIpHeader = (typeof TRUSTED_CLIENT_IP_HEADERS)[number];

/**
 * Adresse du client, lue SEULEMENT dans l'en-tête déclaré de confiance
 * (`PLATFORM_ADMIN_CLIENT_IP_HEADER`). Sans déclaration : `null`, aucune
 * adresse transmise (un en-tête que le serveur web reçoit tel quel du client
 * permettrait de contourner les plafonds par adresse).
 */
export function clientAddress(
  headers: { get(name: string): string | null },
  trusted: TrustedClientIpHeader | null,
): string | null {
  if (!trusted) return null;
  const value = headers.get(trusted)?.split(",")[0]?.trim() ?? "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : null;
}

export interface AdminBffConfig {
  apiUrl: string;
  proxySecret: string;
  allowedOrigin: string;
  secureCookie: boolean;
  /** En-tête d'adresse de confiance, ou `null` (aucune adresse relayée). */
  clientIpHeader: TrustedClientIpHeader | null;
}

/**
 * Configuration serveur (jamais `NEXT_PUBLIC_*` pour le secret). Absente ou
 * invalide → `null` : la route répond 503 et l'espace reste fermé.
 */
export function resolveAdminBffConfig(
  env: Record<string, string | undefined>,
): AdminBffConfig | null {
  if (env.PLATFORM_ADMIN_ENABLED !== "true") return null;
  const proxySecret = env.PLATFORM_ADMIN_PROXY_SECRET ?? "";
  if (proxySecret.length < 32 || /\s/.test(proxySecret)) return null;
  const apiUrl = (env.PLATFORM_ADMIN_API_URL || env.NEXT_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const allowedOrigin = (env.PLATFORM_ADMIN_ALLOWED_ORIGIN ?? "").trim();
  let api: URL;
  let origin: URL;
  try {
    api = new URL(apiUrl);
    origin = new URL(allowedOrigin);
  } catch {
    return null;
  }
  if (origin.origin !== allowedOrigin) return null;
  const ipHeader = (env.PLATFORM_ADMIN_CLIENT_IP_HEADER ?? "")
    .trim()
    .toLowerCase();
  if (
    ipHeader !== "" &&
    !(TRUSTED_CLIENT_IP_HEADERS as readonly string[]).includes(ipHeader)
  ) {
    return null;
  }
  // HTTPS exigé en production, sauf pile entièrement locale (recette
  // isolée : web ET API sur la boucle locale).
  const production = env.NODE_ENV === "production";
  const loopback = (url: URL) =>
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const https = origin.protocol === "https:" && api.protocol === "https:";
  if (production && !https && !(loopback(origin) && loopback(api))) {
    return null;
  }
  return {
    apiUrl: api.origin + api.pathname.replace(/\/+$/, ""),
    proxySecret,
    allowedOrigin,
    secureCookie: origin.protocol === "https:",
    clientIpHeader:
      ipHeader === "" ? null : (ipHeader as TrustedClientIpHeader),
  };
}

/** En-têtes de toute réponse de la route (privée, jamais en cache). */
export const ADMIN_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex, nofollow",
};

/**
 * Déconnexion : le cookie est effacé dans TOUS les cas (réponse de l'API,
 * erreur, API injoignable). Le navigateur perd le jeton même si la
 * révocation côté serveur n'a pas pu être faite ; la session serveur expire
 * alors à son délai d'inactivité (30 min au plus).
 */
export function clearsCookieAlways(path: string): boolean {
  return path === "auth/logout";
}

/** Codes après lesquels le cookie de session est effacé. */
export const SESSION_CLEARING_CODES = new Set([
  "PLATFORM_ADMIN_SESSION_EXPIRED",
  "PLATFORM_ADMIN_ACCESS_DENIED",
]);

/**
 * Sépare le jeton de session de la réponse de l'API : le corps renvoyé au
 * navigateur ne le contient jamais.
 */
export function extractSession(body: unknown): {
  body: unknown;
  token: string | null;
  clear: boolean;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body, token: null, clear: false };
  }
  const record = { ...(body as Record<string, unknown>) };
  const session = record.session;
  let token: string | null = null;
  if (
    typeof session === "object" &&
    session !== null &&
    !Array.isArray(session)
  ) {
    // Seul le JETON est retiré (et posé en cookie) ; les autres informations
    // de session (échéances renvoyées par `auth/status`) restent visibles.
    const { token: raw, ...rest } = session as Record<string, unknown>;
    if (typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
      token = raw;
    }
    if (Object.keys(rest).length > 0) record.session = rest;
    else delete record.session;
  } else {
    delete record.session;
  }
  const clear =
    record.sessionCleared === true ||
    (typeof record.code === "string" &&
      SESSION_CLEARING_CODES.has(record.code));
  return { body: record, token, clear };
}

// ─── Erreurs publiques ───────────────────────────────────────────────────
//
// Le navigateur ne reçoit qu'un CODE PUBLIC (liste ci-dessous), le statut et
// une référence opaque aléatoire. Jamais : message de l'API, détail de
// validation (noms de champs), chemin, code interne d'infrastructure (secret
// du BFF, API injoignable, configuration), ni ce qui distinguerait un
// mot de passe juste d'un compte non administrateur ou non confirmé. Le
// détail part dans les journaux SERVEUR, sous la même référence.

/** Codes que l'interface peut recevoir tels quels. */
const PUBLIC_CODES = new Set([
  "PLATFORM_ADMIN_SESSION_EXPIRED",
  "PLATFORM_ADMIN_MFA_REQUIRED",
  "PLATFORM_ADMIN_ENROLLMENT_REQUIRED",
  "PLATFORM_ADMIN_ALREADY_ENROLLED",
  "PLATFORM_ADMIN_CHALLENGE_INVALID",
  "PLATFORM_ADMIN_CODE_INVALID",
  "PLATFORM_ADMIN_STEP_UP_REQUIRED",
  "PLATFORM_ADMIN_RATE_LIMITED",
  "PLATFORM_ADMIN_NOT_FOUND",
  "PLATFORM_ADMIN_CAPABILITY_REQUIRED",
  "PLATFORM_ADMIN_OPERATION_CONFLICT",
  "PLATFORM_ADMIN_STATE_CHANGED",
  "PLATFORM_ADMIN_EXTENSION_REFUSED",
  "AUTH_RATE_LIMITED",
  "AUTH_CHALLENGE_REQUIRED",
  "TURNSTILE_FAILED",
  "TURNSTILE_REQUIRED",
  "TURNSTILE_UNAVAILABLE",
]);

/**
 * Refus de connexion UNIQUE : mot de passe faux, compte inconnu, compte sans
 * accès plateforme ou adresse non confirmée répondent à l'identique.
 */
const LOGIN_REFUSAL_CODES = new Set([
  "PLATFORM_ADMIN_ACCESS_DENIED",
  "EMAIL_NOT_VERIFIED",
]);

export const PUBLIC_UNAVAILABLE = "PLATFORM_ADMIN_UNAVAILABLE";
export const PUBLIC_LOGIN_FAILED = "PLATFORM_ADMIN_LOGIN_FAILED";
export const PUBLIC_INVALID_REQUEST = "PLATFORM_ADMIN_INVALID_REQUEST";

export interface PublicError {
  status: number;
  code: string;
}

/**
 * Erreur relayée au navigateur, à partir de la réponse de l'API (`status`
 * HTTP ; `upstreamCode` : code de l'API, `null` si absent ; `status = 0` :
 * API injoignable).
 */
export function publicError(
  path: string,
  status: number,
  upstreamCode: string | null,
): PublicError {
  if (
    path === "auth/login" &&
    (status === 401 || (upstreamCode !== null && LOGIN_REFUSAL_CODES.has(upstreamCode)))
  ) {
    return { status: 401, code: PUBLIC_LOGIN_FAILED };
  }
  if (upstreamCode !== null && PUBLIC_CODES.has(upstreamCode) && status >= 400 && status < 500) {
    return { status, code: upstreamCode };
  }
  if (status === 400 || status === 413) {
    return { status: 400, code: PUBLIC_INVALID_REQUEST };
  }
  // Tout le reste (API injoignable, 5xx, route ou secret refusés par l'API,
  // espace fermé, code inconnu) : un seul « indisponible ».
  return { status: 503, code: PUBLIC_UNAVAILABLE };
}

/** Référence opaque d'une erreur (journaux serveur ↔ écran). */
export function newErrorReference(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
