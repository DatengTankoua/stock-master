import { NextRequest, NextResponse } from "next/server";
import { createProxy } from "next-i18next/proxy";
import { LOCALE_HEADER, baseI18nConfig } from "@/i18n/settings";
import {
  buildContentSecurityPolicy,
  createNonce,
} from "@/lib/security-headers";
import {
  englishBasePath,
  isLocalizedPublicPath,
} from "@/lib/seo/public-routes";

// 1-16G — Langue de chaque requête de page (URL inchangées). Ordre :
// cookie de préférence `stockmaster.lang`, sinon en-tête Accept-Language du
// navigateur (proposition initiale de l'anglais), sinon français. Exception
// (référencement) : pages publiques bilingues, voir plus bas. Le
// résultat est transmis au rendu serveur par un en-tête interne, réécrit à
// chaque requête (une valeur envoyée par le client est remplacée). Le proxy
// ne pose aucun cookie et ne lit aucune session.
const i18nProxy = createProxy(baseI18nConfig);

// 1-22F — CSP à nonce, appliquée (pas Report-Only). Toutes les pages sont
// déjà rendues à la demande (la langue est lue dans la requête) : le nonce
// ne change pas le mode de rendu. Next.js lit la CSP de la REQUÊTE pour
// poser le nonce sur ses scripts ; la même valeur part dans la réponse.
// Les valeurs envoyées par le client sous ces noms sont remplacées.
export function proxy(request: NextRequest): NextResponse | Response {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    imageOrigins: process.env.CSP_IMAGE_ORIGINS,
  });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  // Référencement — pages publiques bilingues (`lib/seo/public-routes.ts`) :
  // l'URL détermine toujours la langue, quels que soient le cookie et
  // Accept-Language. `/en/...` (routes `app/en/*`, qui réexportent les
  // pages françaises) est servi en anglais, l'URL sans préfixe toujours en
  // français. Les autres routes gardent la détection ci-dessous.
  const { pathname } = request.nextUrl;
  let response: NextResponse | Response;
  if (englishBasePath(pathname)) {
    headers.set(LOCALE_HEADER, "en");
    response = NextResponse.next({ request: { headers } });
  } else if (isLocalizedPublicPath(pathname)) {
    headers.set(LOCALE_HEADER, "fr");
    response = NextResponse.next({ request: { headers } });
  } else {
    response = i18nProxy(new NextRequest(request, { headers }));
  }
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Exclus : fichiers statiques et versionnés, service worker, manifeste,
// icônes et images publiques (aucun document HTML, aucune CSP utile). Les
// routes API et sockets sont servies par l'API (autre origine) et ne
// passent jamais ici.
export const config = {
  matcher: [
    "/((?!api|socket\\.io|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|favicon\\.ico|icons/|brand/|marketing/|robots\\.txt|sitemap\\.xml|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
