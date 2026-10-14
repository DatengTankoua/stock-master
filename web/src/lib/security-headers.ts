// 1-22F — En-têtes de sécurité navigateur. Module pur (aucune dépendance
// Next.js) : partagé par `next.config.ts` (en-têtes fixes, toutes les
// réponses) et `proxy.ts` (CSP à nonce, documents HTML uniquement).
// Détails, exceptions et recette :
// docs/architecture/phase-1-22f-browser-security-headers.md.

/** Script officiel Turnstile (chargé à la demande) et son iframe. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** HSTS : hôte exact seulement, ni includeSubDomains ni preload. */
export const HSTS_VALUE = "max-age=63072000";

/** En-têtes fixes, identiques pour toute réponse du site web. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{
  key: string;
  value: string;
}> = [
  { key: "Strict-Transport-Security", value: HSTS_VALUE },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Doublon historique de `frame-ancestors 'none'` (anciens navigateurs).
  { key: "X-Frame-Options", value: "DENY" },
  // Capacités jamais utilisées. Les photos passent par `<input type=file>`
  // (sélecteur du système, hors `camera`) ; notifications, presse-papiers
  // et service worker ne sont pas concernés.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

export interface CspOptions {
  nonce: string;
  /** `next dev` : React a besoin d'`eval` (jamais en production). */
  development: boolean;
  /** `NEXT_PUBLIC_API_URL` : API REST et Socket.IO. */
  apiUrl?: string;
  /**
   * `CSP_IMAGE_ORIGINS` : origines des images signées (R2 en production),
   * séparées par des virgules. Le web ne connaît pas cet hôte (images
   * `unoptimized`, signées par l'API) : il doit être déclaré.
   */
  imageOrigins?: string;
}

function originOf(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Origines http(s) exactes ; toute autre valeur est ignorée. */
function parseOrigins(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((item) => originOf(item.trim()))
    .filter(
      (url): url is URL =>
        url !== null &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin !== "null",
    )
    .map((url) => url.origin);
}

/**
 * CSP appliquée aux documents HTML. Scripts : nonce par requête +
 * `'strict-dynamic'` (scripts Next.js et Turnstile chargés par un script de
 * confiance) ; `'self'` et l'origine Turnstile ne servent qu'aux navigateurs
 * sans CSP 3, qui ignorent `'strict-dynamic'`.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const api = originOf(options.apiUrl);
  const connect = ["'self'"];
  if (api) {
    const wsScheme = api.protocol === "https:" ? "wss:" : "ws:";
    connect.push(api.origin, `${wsScheme}//${api.host}`);
  }
  // Exception tant que `CSP_IMAGE_ORIGINS` n'est pas déclarée : toute image
  // HTTPS (une image n'exécute aucun script). Pile locale : MinIO publié
  // sur la machine, comme `images.remotePatterns` de next.config.ts.
  const declared = parseOrigins(options.imageOrigins);
  const images = [
    "'self'",
    "data:",
    "blob:",
    ...(declared.length > 0 ? declared : ["https:"]),
    ...(declared.length === 0 && api && isLoopback(api)
      ? ["http://localhost:9000"]
      : []),
  ];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      TURNSTILE_ORIGIN,
      ...(options.development ? ["'unsafe-eval'"] : []),
    ],
    // Exception : `sonner` et `next-themes` insèrent des balises <style>
    // sans nonce, et React rend des attributs `style`. Un style injecté ne
    // peut pas exécuter de script.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": images,
    "font-src": ["'self'"],
    "connect-src": connect,
    "frame-src": [TURNSTILE_ORIGIN],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** Nonce imprévisible, unique par requête (128 bits, base64). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
