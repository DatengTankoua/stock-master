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

/** Adresse du client posée par la plateforme d'hébergement (jamais le corps). */
export function clientAddress(headers: {
  get(name: string): string | null;
}): string | null {
  const real = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const value = real || forwarded || "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : null;
}

export interface AdminBffConfig {
  apiUrl: string;
  proxySecret: string;
  allowedOrigin: string;
  secureCookie: boolean;
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
  };
}

/** En-têtes de toute réponse de la route (privée, jamais en cache). */
export const ADMIN_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex, nofollow",
};

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
  const session = record.session as { token?: unknown } | undefined;
  const token =
    session &&
    typeof session.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(session.token)
      ? session.token
      : null;
  delete record.session;
  const clear =
    record.sessionCleared === true ||
    (typeof record.code === "string" &&
      SESSION_CLEARING_CODES.has(record.code));
  return { body: record, token, clear };
}
