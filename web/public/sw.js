// Service worker Stock Master (1-11A/1-11B) — precache minimal + deny-by-
// default : seules les routes publiques listées, l'unique document d'app
// shell générique (/app/catalog) et les assets statiques versionnés
// bénéficient d'une stratégie de cache. Voir
// docs/architecture/phase-1-11b-offline-catalog.md pour le détail exact.
// 1-21D : v4 — icônes PWA sur fond blanc (précachées : nouvelle version
// pour qu'un appareil déjà installé les récupère).
// 1-22C.1 : v5 — lancement hors ligne depuis l'icône (start_url /app),
// pages publiques FR/EN préparées à l'installation avec leurs ressources,
// écran de secours pour toute page non préparée. Voir
// docs/architecture/phase-1-22c1-pwa-offline-entry.md.
const CACHE_VERSION = "v5";
const CACHE_NAME = `stockmaster-${CACHE_VERSION}`;
// 1-22C.1 : documents publics localisés, dans un cache distinct (aucune
// autre réponse n'y est jamais écrite).
const PAGES_CACHE_NAME = `stockmaster-pages-${CACHE_VERSION}`;
const CURRENT_CACHES = [CACHE_NAME, PAGES_CACHE_NAME];
const OFFLINE_URL = "/offline";
// Document statique générique (aucune donnée personnalisée : page
// entièrement "use client", zéro fetch serveur) — seul point d'entrée
// hors ligne pour le catalogue. 1-22C.1 : les chunks /_next/static/* qu'il
// référence sont précachés avec lui (avant : uniquement après une visite en
// ligne du catalogue, sinon « This page couldn't load » hors ligne).
const APP_SHELL_URL = "/app/catalog";
// 1-22C.1 : `start_url` du manifeste. Hors ligne, redirigé vers le shell
// ci-dessus, qui applique ses propres règles de session.
const APP_ENTRY_URL = "/app";

// Chemins stables (sans hash de build) ; les chunks référencés par les
// documents précachés sont extraits de leur HTML (voir cacheDocumentAssets).
const PRECACHE_URLS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/stock-master-logo-horizontal.png",
  "/brand/stock-master-icon.png",
];

// 1-22C.1 — Pages publiques disponibles hors ligne, en français et en
// anglais (même URL, langue choisie par le serveur). Jamais : /app/*,
// /access, liens à jeton (invitation, vérification, réinitialisation).
const LOCALES = ["fr", "en"];
const PUBLIC_PAGES = [
  "/",
  OFFLINE_URL,
  "/guide",
  "/contact",
  "/conditions-utilisation",
  "/conditions-abonnement",
  "/confidentialite",
  "/cookies",
  "/mentions-legales",
  "/traitement-donnees",
  "/auth/login",
  "/auth/register",
  "/auth/forgot-password",
];
const PUBLIC_NAVIGATIONS = new Set(PUBLIC_PAGES);

// Actualisation des pages publiques en ligne (tarifs, textes juridiques) :
// à chaque visite (réseau d'abord) et, pour les pages non visitées, au plus
// une fois toutes les 12 h sur demande d'une page ouverte en ligne.
const REFRESH_PUBLIC_MESSAGE = "stockmaster:refresh-public-pages";
const PUBLIC_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_REFRESH_MARKER = "/__stockmaster-sw/public-pages-refreshed";
const CACHED_AT_HEADER = "X-Stockmaster-Cached-At";
// Ressources indispensables d'un document (JS, CSS, polices). Borne de
// sécurité : un document qui en référencerait davantage n'est pas préparé.
const STATIC_ASSET_PATTERN =
  /\/_next\/static\/[A-Za-z0-9_\-./~]+\.(?:js|css|woff2)(?:\?[A-Za-z0-9_=-]+)?/g;
const MAX_ASSETS_PER_DOCUMENT = 120;

// Correction sécurité : le lien d'acceptation d'invitation porte le token
// en query string (?token=...) — jamais de cache/precache/fallback pour ce
// chemin, quel que soit le mode de requête, vérifié AVANT toute autre
// stratégie.
// 1-18B : tout le parcours d'invitation, dont la page de création de compte
// (lien envoyé à l'adresse invitée, ?token=...).
function isInvitationAcceptPath(pathname) {
  return pathname.startsWith("/auth/invitations/");
}

// 1-13A : même règle pour le lien de vérification d'email (?token=...) —
// jamais de cache, precache ni fallback, quel que soit le mode de requête.
function isEmailVerificationPath(pathname) {
  return pathname.startsWith("/auth/verify-email");
}

// 1-13B : même règle pour le lien de réinitialisation du mot de passe.
function isPasswordResetPath(pathname) {
  return pathname.startsWith("/auth/reset-password");
}

// Jamais caché : API, Socket.IO, pages/données organisationnelles (/app),
// et par construction (origin check ci-dessous) toute image privée S3
// servie sur un autre host.
function isAppOrApiPath(pathname) {
  return (
    pathname.startsWith("/app") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/socket.io")
  );
}

function isVersionedAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/brand/")
  );
}

// 1-22C.1 : requête de données de navigation Next.js (RSC) — jamais lue ni
// écrite en cache, jamais remplacée par un document HTML (et inversement).
function isRscRequest(request, url) {
  return request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
}

// Filet de sécurité supplémentaire (défense en profondeur) : même hors de
// /auth/invitations/accept, jamais de cache.put pour une URL dont le
// chemin ou la query contient un identifiant sensible d'invitation/session.
const SENSITIVE_URL_PATTERN = /token|access_token|code|invitation|verify-email|reset-password/i;
function isSensitiveUrl(url) {
  return SENSITIVE_URL_PATTERN.test(url.pathname) || SENSITIVE_URL_PATTERN.test(url.search);
}

// ─── Documents publics localisés (1-22C.1) ──────────────────────────────────
// Clé interne par langue : la même URL est rendue en FR ou en EN selon le
// cookie, que le service worker ne lit pas. La langue d'un document est
// celle de son `<html lang>`.
function publicPageKey(pathname, locale) {
  return new Request(`${self.location.origin}${pathname}?__sw_locale=${locale}`);
}

function documentLocale(html) {
  const match = /<html[^>]*\slang="(fr|en)"/.exec(html.slice(0, 2000));
  return match ? match[1] : null;
}

function isHtmlResponse(response) {
  return (response.headers.get("Content-Type") || "").includes("text/html");
}

// Ressources /_next/static référencées par un document (HTML et en-tête
// Link, qui porte les polices préchargées), mises en cache AVANT le
// document : une copie enregistrée n'est jamais incomplète. Échec réseau ou
// HTTP → exception, le document n'est alors pas remplacé.
async function cacheDocumentAssets(html, linkHeader) {
  const source = `${html}
${linkHeader || ""}`;
  const paths = [...new Set(source.match(STATIC_ASSET_PATTERN) || [])];
  if (paths.length > MAX_ASSETS_PER_DOCUMENT) throw new Error("too-many-assets");
  const cache = await caches.open(CACHE_NAME);
  await runPool(paths, 6, async (path) => {
    const request = new Request(`${self.location.origin}${path}`);
    if (await cache.match(request)) return;
    const response = await fetch(request);
    if (!response.ok) throw new Error("asset-unavailable");
    await cache.put(request, response);
  });
}

// Copie normalisée (sans les en-têtes Vary/no-store de Next.js) et datée.
function storedDocument(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      [CACHED_AT_HEADER]: new Date().toISOString(),
    },
  });
}

// Enregistre une réponse de page publique sous sa langue réelle. Ignore
// silencieusement toute réponse non exploitable (erreur HTTP, redirection,
// autre type) : la copie précédente reste en place.
async function storePublicPage(pathname, response) {
  if (!response.ok || response.redirected || !isHtmlResponse(response)) return false;
  if (new URL(response.url).pathname !== pathname) return false;
  const html = await response.text();
  const locale = documentLocale(html);
  if (!locale) return false;
  await cacheDocumentAssets(html, response.headers.get("Link"));
  const cache = await caches.open(PAGES_CACHE_NAME);
  await cache.put(publicPageKey(pathname, locale), storedDocument(html));
  return true;
}

// Téléchargement explicite d'une page dans une langue : sans cookie (jamais
// de réponse liée à une session), langue imposée par Accept-Language.
function fetchPublicPage(pathname, locale) {
  return fetch(pathname, {
    credentials: "omit",
    cache: "no-store",
    headers: { "Accept-Language": locale },
  });
}

// Préparation complète (installation) : un échec réseau ou serveur (5xx)
// fait échouer l'installation, l'ancienne version reste alors active avec
// ses caches. Une page absente (4xx, redirection) est seulement ignorée.
async function precachePublicPages() {
  const jobs = PUBLIC_PAGES.flatMap((pathname) =>
    LOCALES.map((locale) => ({ pathname, locale })),
  );
  await runPool(jobs, 4, async ({ pathname, locale }) => {
    const response = await fetchPublicPage(pathname, locale);
    if (response.status >= 500) throw new Error("page-unavailable");
    await storePublicPage(pathname, response);
  });
}

async function precacheAppShell() {
  const response = await fetch(APP_SHELL_URL, { credentials: "omit", cache: "no-store" });
  if (!response.ok || response.redirected || !isHtmlResponse(response)) {
    throw new Error("app-shell-unavailable");
  }
  const html = await response.text();
  await cacheDocumentAssets(html, response.headers.get("Link"));
  const cache = await caches.open(CACHE_NAME);
  await cache.put(APP_SHELL_URL, storedDocument(html));
}

// Actualisation en ligne : chaque page n'est remplacée qu'en cas de succès
// complet (document + ressources) ; un échec garde la copie précédente.
async function refreshPublicPagesIfStale() {
  const cache = await caches.open(PAGES_CACHE_NAME);
  const marker = await cache.match(PUBLIC_REFRESH_MARKER);
  const last = marker ? Date.parse(marker.headers.get(CACHED_AT_HEADER) || "") : NaN;
  if (Number.isFinite(last) && Date.now() - last < PUBLIC_REFRESH_INTERVAL_MS) return;
  await cache.put(PUBLIC_REFRESH_MARKER, storedDocument(""));
  const jobs = PUBLIC_PAGES.flatMap((pathname) =>
    LOCALES.map((locale) => ({ pathname, locale })),
  );
  await runPool(jobs, 2, async ({ pathname, locale }) => {
    try {
      await storePublicPage(pathname, await fetchPublicPage(pathname, locale));
    } catch {
      // copie précédente conservée
    }
  });
}

// Langue de l'appareil d'abord (écrite par la page), puis l'autre langue.
async function cachedPublicPage(pathname) {
  const preferred = await readDeviceLocale();
  const cache = await caches.open(PAGES_CACHE_NAME);
  for (const locale of [preferred, ...LOCALES.filter((l) => l !== preferred)]) {
    const cached = await cache.match(publicPageKey(pathname, locale));
    if (cached) return cached;
  }
  return null;
}

// Copie servie hors ligne : `<html data-offline-copy="<date>">` permet à la
// page d'indiquer qu'il s'agit d'une version enregistrée (attribut toléré à
// l'hydratation : `suppressHydrationWarning` sur <html>).
async function markedOfflineCopy(cached) {
  const cachedAt = cached.headers.get(CACHED_AT_HEADER) || "";
  const html = (await cached.text()).replace(
    /<html(\s|>)/,
    `<html data-offline-copy="${cachedAt.replace(/[^0-9TZ:.-]/g, "")}"$1`,
  );
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function runPool(items, size, worker) {
  let index = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await precacheAppShell();
      await precachePublicPages();
      const pages = await caches.open(PAGES_CACHE_NAME);
      await pages.put(PUBLIC_REFRESH_MARKER, storedDocument(""));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Purge limitée au namespace stockmaster-* : jamais un cache d'un
        // autre namespace/application partageant la même origine. Les ventes
        // locales et l'identité hors ligne sont en IndexedDB : jamais
        // touchées ici.
        Promise.all(
          keys
            .filter((key) => key.startsWith("stockmaster-") && !CURRENT_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === REFRESH_PUBLIC_MESSAGE) {
    event.waitUntil(refreshPublicPagesIfStale().catch(() => {}));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // jamais POST/PATCH/DELETE
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // jamais cross-origin
  if (isInvitationAcceptPath(url.pathname)) return; // token en query : jamais de cache, réseau natif
  if (isEmailVerificationPath(url.pathname)) return; // 1-13A : idem (lien de vérification)
  if (isPasswordResetPath(url.pathname)) return; // 1-13B : idem (lien de réinitialisation)
  if (isRscRequest(request, url)) return; // 1-22C.1 : données Next.js, réseau natif

  // Exception UNIQUE et étroite (1-11B) : uniquement la navigation exacte
  // vers /app/catalog, SANS aucune query string (clé précachée invariante,
  // jamais devinable/paramétrable). Jamais de cache.put d'une réponse
  // live/personnalisée ici — seul le document précaché à l'install sert de
  // secours. Aucun autre chemin /app/* n'est concerné (exclusion normale
  // ci-dessous inchangée pour tout le reste, y compris /app/catalog/[id]
  // et /app/catalog/products/[id]).
  if (request.mode === "navigate" && url.pathname === APP_SHELL_URL && url.search === "") {
    event.respondWith(appShellFallback(request));
    return;
  }

  // 1-22C.1 : ouverture depuis l'icône (start_url), sans query string.
  if (request.mode === "navigate" && url.pathname === APP_ENTRY_URL && url.search === "") {
    event.respondWith(appEntry(request));
    return;
  }

  if (request.mode === "navigate") {
    if (PUBLIC_NAVIGATIONS.has(url.pathname)) {
      event.respondWith(networkFirstPublicNavigation(event, url));
      return;
    }
    // 1-22C.1 : toute autre page (dont /app/*) part au réseau, sans lecture
    // ni écriture de cache pour cette URL ; seul un ÉCHEC RÉSEAU affiche
    // l'écran hors ligne public. Une réponse HTTP (401, 403, 404, 5xx) est
    // toujours rendue telle quelle.
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/socket.io")) return;
    event.respondWith(networkOrOfflineScreen(request));
    return;
  }

  if (isAppOrApiPath(url.pathname)) return; // jamais /app, /api, /socket.io

  if (isVersionedAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
  // Tout le reste : laissé au réseau natif, sans interception ni cache.
});

// Réseau d'abord ; en cas d'échec uniquement, repli vers le document générique
// précaché à l'install — jamais un cache.put ici (la réponse live n'est
// JAMAIS écrite, qu'elle réussisse ou échoue).
async function appShellFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(APP_SHELL_URL);
    return cached ?? Response.error();
  }
}

// Réseau d'abord ; échec réseau → shell du catalogue hors ligne (ses règles
// de session décident : identité vérifiée localement ou connexion requise).
async function appEntry(request) {
  try {
    return await fetch(request);
  } catch {
    if (await caches.match(APP_SHELL_URL)) {
      return Response.redirect(new URL(APP_SHELL_URL, self.location.origin).href, 302);
    }
    return offlineScreen();
  }
}

async function networkOrOfflineScreen(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineScreen();
  }
}

async function offlineScreen() {
  const cached = await cachedPublicPage(OFFLINE_URL);
  return cached ?? Response.error();
}

async function networkFirstPublicNavigation(event, url) {
  try {
    const response = await fetch(event.request);
    // Seule l'URL exacte (sans query) est enregistrée : une variante
    // paramétrée n'écrase jamais la copie de référence.
    if (url.search === "" && !isSensitiveUrl(url)) {
      event.waitUntil(storePublicPage(url.pathname, response.clone()).catch(() => {}));
    }
    return response;
  } catch {
    const cached = await cachedPublicPage(url.pathname);
    if (cached) return url.pathname === OFFLINE_URL ? cached : markedOfflineCopy(cached);
    return offlineScreen();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && !isSensitiveUrl(new URL(request.url))) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

// ─── Notifications Web Push (1-16A) ─────────────────────────────────────────
// Ajout au service worker EXISTANT : aucun changement de scope, de cache
// (CACHE_VERSION inchangée), de stratégie fetch ni de l'outbox des ventes.
// Ces gestionnaires n'émettent AUCUNE requête réseau : ni vente, ni
// confirmation de paiement, ni échange de session, ni passe d'outbox.
//
// Contrôle local minimal avant affichage : le message chiffré porte son
// titulaire (`aud` : utilisateur, organisation), comparé au pointeur
// d'identité hors ligne de l'appareil (`stockmaster-offline-identity`, écrit
// après chaque contexte authentifié, effacé à la déconnexion). Sans identité
// ou pour un autre compte (déconnexion hors ligne, appareil partagé), aucun
// contenu métier n'est affiché et l'abonnement du navigateur est retiré.
const PUSH_IDENTITY_DB = "stockmaster-offline-identity";
const PUSH_IDENTITY_STORE = "identity";
const PUSH_IDENTITY_KEY = "current";
const PUSH_NAVIGATE_MESSAGE = "stockmaster:push-navigate";
const PUSH_ICON = "/icons/icon-192.png";

// 1-16G — Langue de l'appareil (`stockmaster-preferences`, écrite par la
// page) pour l'unique texte propre au service worker. Les messages push
// eux-mêmes arrivent déjà dans la langue du destinataire (serveur).
// Lecture sans création, repli français.
const DEVICE_LOCALE_DB = "stockmaster-preferences";
const PUSH_DISABLED_BODY = {
  fr: "Notifications désactivées sur cet appareil.",
  en: "Notifications turned off on this device.",
};

function readDeviceLocale() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value === "en" ? "en" : "fr");
      }
    };
    setTimeout(() => done("fr"), 1000);
    let request;
    try {
      request = indexedDB.open(DEVICE_LOCALE_DB);
    } catch {
      done("fr");
      return;
    }
    request.onupgradeneeded = () => {
      request.transaction.abort();
    };
    request.onerror = () => done("fr");
    request.onblocked = () => done("fr");
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains("preferences")) {
          db.close();
          done("fr");
          return;
        }
        const get = db
          .transaction("preferences", "readonly")
          .objectStore("preferences")
          .get("locale");
        get.onsuccess = () => {
          db.close();
          done(get.result);
        };
        get.onerror = () => {
          db.close();
          done("fr");
        };
      } catch {
        db.close();
        done("fr");
      }
    };
  });
}

// Lecture SANS création : si la base n'existe pas, la mise à niveau est
// annulée (aucune base vide n'est laissée, le schéma de la page reste seul
// maître de sa création).
function readPushIdentity() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    setTimeout(() => done(null), 2000);
    let request;
    try {
      request = indexedDB.open(PUSH_IDENTITY_DB);
    } catch {
      done(null);
      return;
    }
    request.onupgradeneeded = () => {
      request.transaction.abort();
    };
    request.onerror = () => done(null);
    request.onblocked = () => done(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(PUSH_IDENTITY_STORE)) {
          db.close();
          done(null);
          return;
        }
        const get = db
          .transaction(PUSH_IDENTITY_STORE, "readonly")
          .objectStore(PUSH_IDENTITY_STORE)
          .get(PUSH_IDENTITY_KEY);
        get.onsuccess = () => {
          db.close();
          const value = get.result;
          done(
            value && typeof value.userId === "string" && typeof value.organizationId === "string"
              ? { userId: value.userId, organizationId: value.organizationId }
              : null,
          );
        };
        get.onerror = () => {
          db.close();
          done(null);
        };
      } catch {
        db.close();
        done(null);
      }
    };
  });
}

// Seuls les chemins internes de l'application sont ouverts.
function safeAppPath(url) {
  return typeof url === "string" && /^\/app(\/[A-Za-z0-9/_-]*)?$/.test(url) && !url.includes("//")
    ? url
    : "/app";
}

function parsePushMessage(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (
      !data ||
      data.v !== 1 ||
      typeof data.title !== "string" ||
      typeof data.body !== "string" ||
      typeof data.tag !== "string" ||
      !data.aud ||
      typeof data.aud.u !== "string" ||
      typeof data.aud.o !== "string"
    ) {
      return null;
    }
    return {
      title: data.title.slice(0, 80),
      body: data.body.slice(0, 200),
      tag: data.tag.slice(0, 120),
      url: safeAppPath(data.url),
      aud: data.aud,
    };
  } catch {
    return null;
  }
}

async function handlePush(event) {
  const message = parsePushMessage(event);
  const identity = await readPushIdentity();
  if (
    !message ||
    !identity ||
    identity.userId !== message.aud.u ||
    identity.organizationId !== message.aud.o
  ) {
    try {
      const subscription = await self.registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {
      // Désabonnement best effort : le serveur désactivera l'endpoint (404/410).
    }
    // Les navigateurs exigent un affichage pour chaque message reçu : texte
    // neutre, sans aucune donnée métier.
    const locale = await readDeviceLocale();
    return self.registration.showNotification("Stock Master", {
      body: PUSH_DISABLED_BODY[locale],
      tag: "stockmaster-push-disabled",
      icon: PUSH_ICON,
      data: { url: "/app" },
    });
  }
  return self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    data: { url: message.url },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function openFromNotification(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (existing) {
    // Navigation côté client dans la fenêtre ouverte (aucun rechargement).
    existing.postMessage({ type: PUSH_NAVIGATE_MESSAGE, url });
    try {
      // Autorisé pendant `notificationclick` ; refus éventuel sans effet sur
      // la navigation déjà demandée.
      await existing.focus();
    } catch {
      // fenêtre non focalisable
    }
    return;
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeAppPath(event.notification.data && event.notification.data.url);
  event.waitUntil(openFromNotification(url));
});
