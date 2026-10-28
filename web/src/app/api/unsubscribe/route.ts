import { NextRequest, NextResponse } from "next/server";

// Désabonnement en un clic (RFC 8058) : adresse de l'en-tête
// `List-Unsubscribe` des e-mails promotionnels, appelée par la messagerie du
// destinataire avec `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
//
// - POST : relaie le jeton à l'API (corps JSON, jamais dans l'URL de l'API)
//   et désabonne directement, sans page, sans session ni cookie, sans
//   exigence CSRF (seul le jeton fait foi). Réponse vide.
// - GET : AUCUN retrait (analyseurs de liens) ; redirige vers la page de
//   confirmation.
// - Le jeton n'est jamais journalisé ; aucune donnée personnelle renvoyée.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UPSTREAM_TIMEOUT_MS = 10_000;
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

function empty(status: number): NextResponse {
  return new NextResponse(null, { status, headers: HEADERS });
}

export async function POST(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!TOKEN.test(token)) return empty(404);
  const api = (process.env.NEXT_PUBLIC_API_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\//.test(api)) return empty(503);
  let upstream: Response;
  try {
    upstream = await fetch(`${api}/marketing/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    console.warn("[unsubscribe] upstream unavailable");
    return empty(503);
  }
  await upstream.body?.cancel().catch(() => undefined);
  if (upstream.ok) return empty(200);
  return empty(upstream.status === 404 || upstream.status === 400 ? 404 : 503);
}

export function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const target = new URL("/auth/unsubscribe", request.nextUrl.origin);
  if (TOKEN.test(token)) target.searchParams.set("token", token);
  return NextResponse.redirect(target, { status: 303, headers: HEADERS });
}
