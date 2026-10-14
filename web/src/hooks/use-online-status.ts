"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Indicateur online/offline (1-11A) : lecture initiale synchrone de
// navigator.onLine (pas de flash "en ligne" pendant l'hydratation), puis
// écoute des événements online/offline avec nettoyage à l'unmount. Aucune
// mutation, file d'attente ou synchronisation automatique déclenchée ici.
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}

function subscribeOnlineStatus(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * 1-22C.1 — Même indicateur pour une page rendue côté serveur : « en ligne »
 * pendant l'hydratation (aucun écart avec le HTML serveur ou la copie du
 * service worker), puis l'état réel du navigateur.
 */
export function useHydratedOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeOnlineStatus,
    () => navigator.onLine,
    () => true,
  );
}
