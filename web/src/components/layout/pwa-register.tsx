"use client";

import { useEffect } from "react";
import { listenForInstallEvents } from "@/lib/pwa-install";

// 1-22C.1 : message lu par public/sw.js — actualise les pages publiques
// enregistrées (au plus toutes les 12 h, décidé par le service worker).
const REFRESH_PUBLIC_MESSAGE = "stockmaster:refresh-public-pages";

function requestPublicPagesRefresh(): void {
  if (!navigator.onLine) return;
  void navigator.serviceWorker.ready
    .then((registration) =>
      registration.active?.postMessage({ type: REFRESH_PUBLIC_MESSAGE }),
    )
    .catch(() => {
      // actualisation facultative
    });
}

export function PwaRegister() {
  useEffect(() => {
    // 1-16A.1 : capture précoce de `beforeinstallprompt` / `appinstalled`.
    listenForInstallEvents();
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(requestPublicPagesRefresh)
      .catch(() => {
        // SW registration failure is non-fatal
      });
    window.addEventListener("online", requestPublicPagesRefresh);
    return () =>
      window.removeEventListener("online", requestPublicPagesRefresh);
  }, []);
  return null;
}
