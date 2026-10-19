// Correctif « demande répétée d'activation des notifications » — tests
// déterministes côté web : réconciliation sans `requestPermission`,
// détachement à la déconnexion (abonnement local gardé seulement si le
// serveur confirme), report et désactivation volontaire respectés, refus
// du navigateur jamais redemandé (`push-notifications.ts`,
// `push-invitation.ts`).
//
// SIMULÉ : navigateur (Notification, PushManager, service worker,
// localStorage) et API sont des doublures en mémoire. Aucun service push
// réel, aucune notification réellement reçue.
//
// Exécution : `pnpm --filter web test:push-reconnect` (ou `node
// scripts/test-push-reconnect.mjs` depuis `web/`). Runner `node:test`,
// modules transpilés en mémoire, aucune dépendance ajoutée.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("typescript");

// ─── Doublures ───────────────────────────────────────────────────────────────

const PUBLIC_KEY =
  "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const keyBytes = (key) => {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  return Uint8Array.from(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  ).buffer;
};

const browser = {
  permission: "default",
  /** Réponse simulée à la demande native. */
  answer: "granted",
  requestPermissionCalls: 0,
  subscription: null,
  unsubscribeCalls: 0,
  seq: 0,
};

function makeSubscription(key) {
  browser.seq += 1;
  const sub = {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${browser.seq}`,
    options: { applicationServerKey: keyBytes(key) },
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      browser.unsubscribeCalls += 1;
      if (browser.subscription === sub) browser.subscription = null;
      return true;
    },
  };
  return sub;
}

const registration = {
  pushManager: {
    getSubscription: async () => browser.subscription,
    subscribe: async ({ applicationServerKey }) => {
      // Un abonnement exige la permission ; jamais de demande implicite.
      if (browser.permission !== "granted") throw new Error("NotAllowedError");
      browser.subscription = makeSubscription(
        Buffer.from(applicationServerKey).toString("base64url"),
      );
      return browser.subscription;
    },
  },
};

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.Notification = {
  get permission() {
    return browser.permission;
  },
  requestPermission: async () => {
    browser.requestPermissionCalls += 1;
    browser.permission = browser.answer;
    return browser.permission;
  },
};
const nav = {
  onLine: true,
  serviceWorker: {
    getRegistration: async () => registration,
    ready: Promise.resolve(registration),
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: nav,
  configurable: true,
});

/**
 * Serveur simulé, mêmes règles que `PushSubscriptionsService` : un endpoint,
 * un titulaire ; `release` détache, `reconcile` ne rend l'appareil qu'au
 * même utilisateur.
 */
const server = {
  session: null, // { userId, token }
  records: new Map(), // endpoint → { userId, status, preferences }
  calls: [],
  releaseFails: false,
  reconcileHangs: false,
};
const DEFAULTS = { saleCreated: true, stockLow: true };

function view(endpoint) {
  const r = server.records.get(endpoint);
  return r && r.status === "active" && r.userId === server.session?.userId
    ? { registered: true, preferences: { ...r.preferences } }
    : { registered: false, preferences: null };
}

const apiClient = {
  async post(url, body) {
    server.calls.push(url);
    const userId = server.session.userId;
    if (url.endsWith("/subscription/status")) {
      return { data: view(body.endpoint) };
    }
    if (url.endsWith("/subscription")) {
      const endpoint = body.subscription.endpoint;
      const old = server.records.get(endpoint);
      server.records.set(endpoint, {
        userId,
        status: "active",
        preferences: old?.userId === userId ? old.preferences : { ...DEFAULTS },
      });
      return { data: view(endpoint) };
    }
    if (url.endsWith("/subscription/reconcile")) {
      // Jeton de la requête figé à l'envoi ; traitement serveur éventuellement
      // différé (requête partie avant la déconnexion, traitée après).
      const token = server.session.token;
      const process = () => {
        const endpoint = body.subscription.endpoint;
        const r = server.records.get(endpoint);
        if (!r || r.releasedSession === token) {
          return { data: { registered: false, preferences: null } };
        }
        if (r.userId !== userId && r.status === "active") {
          r.status = "signed-out";
        }
        if (r.userId === userId && r.status === "signed-out") {
          r.status = "active";
        }
        return { data: view(endpoint) };
      };
      if (server.reconcileHangs) {
        return new Promise((resolve) => {
          server.unhang = () => resolve(process());
        });
      }
      return process();
    }
    if (url.endsWith("/subscription/remove")) {
      const r = server.records.get(body.endpoint);
      if (r?.userId === userId) server.records.delete(body.endpoint);
      return { status: 204 };
    }
    throw new Error(`route non prévue : ${url}`);
  },
  async patch(url, body) {
    const r = server.records.get(body.endpoint);
    Object.assign(r.preferences, body.preferences);
    return { data: view(body.endpoint) };
  },
};

const axios = {
  async post(url, body, options) {
    server.calls.push(`raw:${url}`);
    assert.equal(
      options.headers.Authorization,
      `Bearer ${server.session.token}`,
    );
    if (server.releaseFails) throw new Error("network");
    const r = server.records.get(body.endpoint);
    if (r) r.releasedSession = server.session.token;
    if (r?.status === "active") r.status = "signed-out";
    return { status: 204 };
  },
};

// ─── Chargement des modules ─────────────────────────────────────────────────

const cache = new Map();
const stubs = {
  axios: { __esModule: true, default: axios },
  "./api": { apiClient },
};
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = readFileSync(
    path.join(here, "..", "src", "lib", file),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  const localRequire = (name) => {
    if (name in stubs) return stubs[name];
    if (name.startsWith("./")) return load(`${name.slice(2)}.ts`);
    throw new Error(`module non prévu : ${name}`);
  };
  new Function("module", "exports", "require", "process", outputText)(
    loaded,
    loaded.exports,
    localRequire,
    { env: { NEXT_PUBLIC_API_URL: "https://api.example.test" } },
  );
  return loaded.exports;
}

const push = load("push-notifications.ts");
const { decidePushInvitation, PUSH_DEFER_MS } = load("push-invitation.ts");

/** Même enchaînement que `EngagementPrompt.evaluate`. */
async function invitationAfterLogin(now = Date.now()) {
  let device = await push.fetchPushDeviceState();
  const permission = push.getNotificationPermission();
  if (!device.registered && permission === "granted") {
    device = await push.reconcilePushSubscription(PUBLIC_KEY);
  }
  const deferred = Number(
    localStorage.getItem("stockmaster.engagement.pushDeferredUntil"),
  );
  return {
    device,
    kind: decidePushInvitation({
      permission,
      registered: device.registered,
      optedOut: push.isPushOptedOut(),
      deferredUntil: deferred > 0 ? deferred : null,
      now,
    }),
  };
}

const login = (userId) => {
  server.session = { userId, token: `jwt-${userId}-${Math.random()}` };
};
const logout = () => push.releasePushOnLogout(server.session.token);

beforeEach(() => {
  Object.assign(browser, {
    permission: "default",
    answer: "granted",
    requestPermissionCalls: 0,
    subscription: null,
    unsubscribeCalls: 0,
  });
  Object.assign(server, {
    session: null,
    calls: [],
    releaseFails: false,
    reconcileHangs: false,
  });
  server.records.clear();
  storage.clear();
  nav.onLine = true;
});

// ─── Décision pure ──────────────────────────────────────────────────────────

test("décision : rien si rattaché, désactivé volontairement ou reporté", () => {
  const base = {
    registered: false,
    optedOut: false,
    deferredUntil: null,
    now: 1000,
  };
  assert.equal(
    decidePushInvitation({ ...base, permission: "default" }),
    "push",
  );
  assert.equal(
    decidePushInvitation({ ...base, permission: "granted" }),
    "push-link",
  );
  assert.equal(
    decidePushInvitation({ ...base, permission: "denied" }),
    "push-denied",
  );
  assert.equal(decidePushInvitation({ ...base, permission: null }), null);
  assert.equal(
    decidePushInvitation({ ...base, permission: "granted", registered: true }),
    null,
  );
  assert.equal(
    decidePushInvitation({ ...base, permission: "default", optedOut: true }),
    null,
  );
  assert.equal(
    decidePushInvitation({
      ...base,
      permission: "denied",
      deferredUntil: 1000 + PUSH_DEFER_MS,
    }),
    null,
  );
  assert.equal(
    decidePushInvitation({
      ...base,
      permission: "default",
      deferredUntil: 999,
    }),
    "push",
  );
});

// ─── Parcours ───────────────────────────────────────────────────────────────

test("connexion → activation → déconnexion → reconnexion : aucune invitation, aucune demande native", async () => {
  login("userA");
  assert.equal((await invitationAfterLogin()).kind, "push");
  assert.equal(browser.requestPermissionCalls, 0, "jamais au chargement");

  await push.enablePushNotifications(PUBLIC_KEY); // clic « Activer »
  assert.equal(browser.requestPermissionCalls, 1);
  const endpoint = browser.subscription.endpoint;
  await apiClient.patch("", { endpoint, preferences: { saleCreated: false } });

  await logout();
  assert.ok(
    server.calls.includes(
      "raw:https://api.example.test/notifications/push/subscription/release",
    ),
  );
  assert.equal(
    server.records.get(endpoint).status,
    "signed-out",
    "plus aucun envoi",
  );
  assert.equal(
    browser.subscription?.endpoint,
    endpoint,
    "abonnement local gardé",
  );

  login("userA");
  const after = await invitationAfterLogin();
  assert.equal(after.kind, null, "aucun bandeau");
  assert.equal(after.device.registered, true);
  assert.equal(
    after.device.preferences.saleCreated,
    false,
    "préférence conservée",
  );
  assert.equal(
    browser.requestPermissionCalls,
    1,
    "requestPermission non rappelé",
  );
});

test("changement de compte : B n'hérite pas de l'appareil de A ; invitation « relier » explicite", async () => {
  browser.permission = "granted";
  login("userA");
  await push.enablePushNotifications(PUBLIC_KEY);
  const endpoint = browser.subscription.endpoint;
  await logout();

  login("userB");
  const b = await invitationAfterLogin();
  assert.equal(b.device.registered, false);
  assert.equal(b.kind, "push-link");
  assert.equal(server.records.get(endpoint).userId, "userA");
  assert.equal(server.records.get(endpoint).status, "signed-out");

  // B relie l'appareil : un clic, aucune nouvelle demande native visible
  // (permission déjà accordée), préférences par défaut.
  const calls = browser.requestPermissionCalls;
  const linked = await push.enablePushNotifications(PUBLIC_KEY);
  assert.equal(linked.preferences.saleCreated, true);
  assert.equal(browser.requestPermissionCalls, calls + 1);
  assert.equal(browser.permission, "granted");

  // Session de B terminée SANS déconnexion, A revient : B détaché, A non
  // rattaché automatiquement.
  login("userA");
  const a = await invitationAfterLogin();
  assert.equal(a.device.registered, false);
  assert.equal(a.kind, "push-link");
  assert.equal(server.records.get(endpoint).userId, "userB");
  assert.equal(server.records.get(endpoint).status, "signed-out");
});

test("déconnexion : non confirmée → abonnement local retiré ; réconciliation en vol jamais réactivée après release", async () => {
  browser.permission = "granted";
  login("userA");
  await push.enablePushNotifications(PUBLIC_KEY);

  nav.onLine = false;
  await logout();
  assert.equal(browser.subscription, null);
  assert.ok(
    !server.calls.some((c) => c.startsWith("raw:")),
    "aucune requête hors ligne",
  );

  nav.onLine = true;
  await push.enablePushNotifications(PUBLIC_KEY);
  server.releaseFails = true;
  await logout();
  assert.equal(browser.subscription, null);

  server.releaseFails = false;
  await push.enablePushNotifications(PUBLIC_KEY);
  await logout();
  login("userA");
  // Réconciliation lancée juste avant la déconnexion : abandonnée avant
  // toute requête ; le détachement a lieu normalement.
  const early = push.reconcilePushSubscription(PUBLIC_KEY);
  await logout();
  assert.equal((await early).registered, false);
  assert.ok(!server.calls.some((c) => c.endsWith("/reconcile")));
  assert.notEqual(browser.subscription, null);

  // Requête de réconciliation DÉJÀ partie, traitée par le serveur APRÈS le
  // détachement (réponses dans l'ordre inverse) : jamais réactivé.
  login("userA");
  const endpoint = browser.subscription.endpoint;
  server.reconcileHangs = true;
  const late = push.reconcilePushSubscription(PUBLIC_KEY);
  while (!server.calls.some((c) => c.endsWith("/reconcile"))) {
    await new Promise((r) => setTimeout(r, 1));
  }
  await logout();
  assert.ok(server.calls.at(-1).endsWith("/release"), "détachement envoyé");
  assert.equal(server.records.get(endpoint).status, "signed-out");
  server.unhang();
  assert.equal((await late).registered, false);
  assert.equal(
    server.records.get(endpoint).status,
    "signed-out",
    "jamais actif après release",
  );
  server.reconcileHangs = false;
  // Nouvelle session du même compte : réconciliation normale.
  login("userA");
  assert.equal(
    (await push.reconcilePushSubscription(PUBLIC_KEY)).registered,
    true,
  );
});

test("réconciliation : jamais sans permission accordée, jamais avec une autre clé serveur", async () => {
  login("userA");
  browser.permission = "default";
  assert.deepEqual(await push.reconcilePushSubscription(PUBLIC_KEY), {
    registered: false,
    preferences: null,
  });
  browser.permission = "granted";
  browser.subscription = makeSubscription(
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  );
  assert.equal(
    (await push.reconcilePushSubscription(PUBLIC_KEY)).registered,
    false,
  );
  browser.subscription = null;
  assert.equal(
    (await push.reconcilePushSubscription(PUBLIC_KEY)).registered,
    false,
  );
  assert.ok(!server.calls.some((c) => c.endsWith("/reconcile")));
  assert.equal(browser.requestPermissionCalls, 0);
});

test("refus du navigateur : aide seulement, jamais redemandé ; report respecté", async () => {
  login("userA");
  browser.permission = "denied";
  const now = Date.now();
  assert.equal((await invitationAfterLogin(now)).kind, "push-denied");
  localStorage.setItem(
    "stockmaster.engagement.pushDeferredUntil",
    String(now + PUSH_DEFER_MS),
  );
  for (let i = 0; i < 3; i += 1) {
    login("userA");
    assert.equal((await invitationAfterLogin(now + 1000)).kind, null);
  }
  assert.equal(
    (await invitationAfterLogin(now + PUSH_DEFER_MS + 1)).kind,
    "push-denied",
  );
  assert.equal(browser.requestPermissionCalls, 0);
});

test("désactivation volontaire dans Stock Master : ni réactivée ni re-proposée", async () => {
  browser.permission = "granted";
  login("userA");
  await push.enablePushNotifications(PUBLIC_KEY);
  await push.disablePushNotifications();
  assert.equal(browser.subscription, null);
  await logout();
  login("userA");
  const after = await invitationAfterLogin();
  assert.equal(after.device.registered, false);
  assert.equal(after.kind, null);
  // Réactivation explicite depuis les réglages : indicateur levé.
  await push.enablePushNotifications(PUBLIC_KEY);
  assert.equal(push.isPushOptedOut(), false);
});
