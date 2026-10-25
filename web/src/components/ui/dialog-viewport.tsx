"use client";

import * as React from "react";

// Fenêtres modales sur téléphone : `fixed` se place dans la zone d'affichage
// de mise en page, qui ne rétrécit ni avec le clavier virtuel (iOS, Chrome
// Android récent) ni toujours avec les barres du navigateur. La zone
// réellement visible (`visualViewport`) est publiée en variables CSS tant
// qu'une fenêtre est ouverte ; sans elle, repli sur `100dvh`.

let openPopups = 0;

function publish() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement.style;
  root.setProperty("--dialog-vv-height", `${viewport.height}px`);
  root.setProperty("--dialog-vv-top", `${viewport.offsetTop}px`);
  root.setProperty("--dialog-vv-width", `${viewport.width}px`);
  root.setProperty("--dialog-vv-left", `${viewport.offsetLeft}px`);
}

// Clavier ouvert : la zone visible rétrécit après la prise de focus. Le champ
// actif d'une fenêtre est ramené dans sa zone défilante. Les fenêtres n'ont
// aucune transition de géométrie (`transition-none`) : la nouvelle taille
// est appliquée dès l'image suivante.
function revealFocusedField() {
  publish();
  const field = document.activeElement;
  if (
    field instanceof HTMLElement &&
    field.matches("input, textarea, select") &&
    field.closest(
      "[data-slot=dialog-content], [data-slot=alert-dialog-content]",
    )
  ) {
    // Après application de la nouvelle hauteur (image suivante).
    requestAnimationFrame(() => field.scrollIntoView({ block: "nearest" }));
  }
}

/** À rendre DANS le popup : actif seulement tant que la fenêtre est montée. */
export function DialogViewportSync() {
  React.useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    openPopups += 1;
    publish();
    viewport.addEventListener("resize", revealFocusedField);
    viewport.addEventListener("scroll", publish);
    return () => {
      viewport.removeEventListener("resize", revealFocusedField);
      viewport.removeEventListener("scroll", publish);
      openPopups -= 1;
      if (openPopups === 0) {
        const root = document.documentElement.style;
        root.removeProperty("--dialog-vv-height");
        root.removeProperty("--dialog-vv-top");
        root.removeProperty("--dialog-vv-width");
        root.removeProperty("--dialog-vv-left");
      }
    };
  }, []);
  return null;
}

// Centrée dans la zone visible, marges de 1rem hors zones sûres, jamais plus
// haute ni plus large que cette zone : le contenu défile à l'intérieur. Une
// page plus large que l'écran (zone de mise en page élargie sur mobile) ne
// décale donc jamais la fenêtre.
export const DIALOG_VIEWPORT_CLASSES =
  "left-[calc(var(--dialog-vv-left,0px)+var(--dialog-vv-width,100%)/2)] top-[calc(var(--dialog-vv-top,0px)+(var(--dialog-vv-height,100dvh)+env(safe-area-inset-top)-env(safe-area-inset-bottom))/2)] max-h-[calc(var(--dialog-vv-height,100dvh)-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-w-[calc(var(--dialog-vv-width,100%)-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))]";
