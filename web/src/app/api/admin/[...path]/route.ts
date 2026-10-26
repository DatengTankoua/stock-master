import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_CSRF_HEADER,
  ADMIN_RESPONSE_HEADERS,
  adminCookieName,
  adminCookieOptions,
  checkAdminRequest,
  clearsCookieAlways,
  clientAddress,
  extractSession,
  filterAdminQuery,
  newErrorReference,
  PUBLIC_INVALID_REQUEST,
  PUBLIC_UNAVAILABLE,
  publicError,
  resolveAdminBffConfig,
  resolveAdminRoute,
} from "@/lib/admin/bff-policy";

// Administration de la plateforme — BFF de même origine. Relaie vers
// `/platform-admin/*` de l'API, côté serveur uniquement : le secret partagé
// et le jeton de session ne sont jamais visibles du navigateur. Règles :
// `lib/admin/bff-policy.ts`. Le CORS de l'API n'est pas modifié.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16_384;
const UPSTREAM_TIMEOUT_MS = 15_000;

type Context = { params: Promise<{ path: string[] }> };

function reply(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: ADMIN_RESPONSE_HEADERS });
}

/**
 * Erreur relayée : code PUBLIC et référence opaque seulement ; le détail
 * (route, statut et code de l'API) part dans le journal serveur sous la même
 * référence. Aucun secret, jeton ni donnée saisie n'y figure.
 */
function failure(
  method: string,
  path: string,
  status: number,
  code: string,
  detail: string,
): NextResponse {
  const reference = newErrorReference();
  console.warn(
    `[admin-bff] ref=${reference} ${method} ${path} → ${status} ${code} (${detail})`,
  );
  return reply(status, { statusCode: status, code, reference });
}

const unavailable = (method: string, path: string, detail: string) =>
  failure(method, path, 503, PUBLIC_UNAVAILABLE, detail);

async function relay(request: NextRequest, context: Context) {
  const config = resolveAdminBffConfig(process.env);
  if (!config)
    return unavailable(
      request.method,
      "-",
      "BFF configuration missing or invalid",
    );

  const { path: segments } = await context.params;
  const method = request.method;
  const path = resolveAdminRoute(method, segments ?? []);
  if (!path) return reply(404, { statusCode: 404, code: "NOT_FOUND" });

  const verdict = checkAdminRequest({
    method,
    csrfHeader: request.headers.get(ADMIN_CSRF_HEADER),
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    allowedOrigin: config.allowedOrigin,
  });
  if (verdict !== "ok") {
    return reply(403, {
      statusCode: 403,
      code: "PLATFORM_ADMIN_CSRF_REJECTED",
    });
  }

  let body: string | undefined;
  if (method === "POST") {
    body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      return failure(
        method,
        path,
        400,
        PUBLIC_INVALID_REQUEST,
        "request body too large",
      );
    }
    if (body === "") body = "{}";
  }

  const cookieName = adminCookieName(config.secureCookie);
  const sessionToken = request.cookies.get(cookieName)?.value;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-platform-admin-proxy": config.proxySecret,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (sessionToken) headers["x-platform-admin-session"] = sessionToken;
  const address = clientAddress(request.headers, config.clientIpHeader);
  if (address) headers["x-platform-admin-client-ip"] = address;
  const language = request.headers.get("accept-language");
  if (language) headers["accept-language"] = language.slice(0, 100);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${config.apiUrl}/platform-admin/${path}${filterAdminQuery(request.nextUrl.searchParams)}`,
      {
        method,
        headers,
        body,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch {
    const failed = unavailable(method, path, "API unreachable or timed out");
    if (clearsCookieAlways(path)) {
      failed.cookies.set(cookieName, "", {
        ...adminCookieOptions(config.secureCookie),
        maxAge: 0,
      });
    }
    return failed;
  }

  const parsed: unknown = await upstream.json().catch(() => null);
  const { body: safeBody, token, clear } = extractSession(parsed);
  let response: NextResponse;
  if (upstream.ok) {
    response = reply(upstream.status, safeBody);
  } else {
    // Erreur : jamais le corps de l'API (message, validation, chemin).
    const upstreamCode =
      typeof (safeBody as { code?: unknown } | null)?.code === "string"
        ? (safeBody as { code: string }).code
        : null;
    const shown = publicError(path, upstream.status, upstreamCode);
    response = failure(
      method,
      path,
      shown.status,
      shown.code,
      `API ${upstream.status} ${upstreamCode ?? "no-code"}`,
    );
  }
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter && /^\d{1,6}$/.test(retryAfter)) {
    response.headers.set("Retry-After", retryAfter);
  }
  if (token) {
    response.cookies.set(
      cookieName,
      token,
      adminCookieOptions(config.secureCookie),
    );
  } else if (clear || clearsCookieAlways(path)) {
    response.cookies.set(cookieName, "", {
      ...adminCookieOptions(config.secureCookie),
      maxAge: 0,
    });
  }
  return response;
}

export const GET = relay;
export const POST = relay;
