import type { Locale } from "@/i18n/settings";

// 1-16G — Langue de l'appareil pour le service worker (qui ne lit ni les
// cookies ni le stockage local) : une seule valeur `fr` ou `en`, aucune
// donnée personnelle. Lue par `public/sw.js` pour son unique message de
// repli (« Notifications désactivées sur cet appareil »). Toute erreur est
// silencieuse : le service worker retombe alors sur le français.
export const DEVICE_LOCALE_DB = "stockmaster-preferences";
const STORE = "preferences";
const KEY = "locale";

// 1-22C.1 : aussi la langue des pages publiques servies hors ligne. La
// promesse se résout à la fin de l'écriture, réussie ou non (jamais rejetée).
export function writeDeviceLocale(locale: Locale): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve();
      const request = indexedDB.open(DEVICE_LOCALE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
      request.onsuccess = () => {
        const db = request.result;
        const done = () => {
          db.close();
          resolve();
        };
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(locale, KEY);
          tx.oncomplete = done;
          tx.onerror = done;
          tx.onabort = done;
        } catch {
          done();
        }
      };
    } catch {
      // stockage indisponible : le service worker utilisera le français
      resolve();
    }
  });
}
