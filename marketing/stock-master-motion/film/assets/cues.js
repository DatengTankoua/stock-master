/*
 * Lot 1-23A — Minutage du film (source unique, secondes).
 * Animatique : minutage PRÉVU (aucune voix finale). Après réception de la voix Gemini,
 * `scripts/retime.js` réécrira ces valeurs à partir des durées et silences mesurés.
 *
 * vo     : répliques de voix off (texte parlé ; `screen` = forme écrite si elle diffère)
 * scenes : bornes des sept séquences
 * sfx    : effets doux (fichiers de assets/audio/sfx), volume 0–1
 */
window.FILM_CUES = {
  status: "planned",
  duration: 90,
  scenes: [
    { id: "s1", start: 0, end: 8 },
    { id: "s2", start: 8, end: 20 },
    { id: "s3", start: 20, end: 35 },
    { id: "s4", start: 35, end: 48 },
    { id: "s5", start: 48, end: 63 },
    { id: "s6", start: 63, end: 77 },
    { id: "s7", start: 77, end: 90 },
  ],
  vo: [
    { scene: "s1", start: 0.4, end: 2.6, text: "Combien reste-t-il de lait de karité en rayon ?" },
    { scene: "s1", start: 2.8, end: 4.4, text: "Qui a vendu quoi aujourd'hui ?" },
    { scene: "s1", start: 5.4, end: 7.4, text: "Avec Stock Master, vous le savez." },
    { scene: "s2", start: 8.6, end: 13.6, text: "Chez Royal Vibe Cosmétique, chaque produit a sa fiche : sa photo, son prix en francs CFA, son stock.", screen: "Chez RoyalVibe Cosmétique, chaque produit a sa fiche : sa photo, son prix en francs CFA, son stock." },
    { scene: "s2", start: 14.4, end: 16.2, text: "Et tout est rangé par rayon." },
    { scene: "s3", start: 20.6, end: 22.6, text: "Une cliente prend une huile d'argan." },
    { scene: "s3", start: 23.0, end: 27.2, text: "Junior enregistre la vente… et le stock passe de trois à deux." },
    { scene: "s3", start: 28.4, end: 31.0, text: "Stock Master signale aussitôt un stock faible." },
    { scene: "s4", start: 35.6, end: 37.6, text: "Mireille, la propriétaire, est prévenue." },
    { scene: "s4", start: 40.4, end: 46.0, text: "C'est elle qui choisit les droits de chacun : vendre, ajuster le stock, voir toutes les ventes." },
    { scene: "s5", start: 48.6, end: 49.8, text: "Le réseau coupe ?" },
    { scene: "s5", start: 50.2, end: 51.8, text: "Grâce continue de vendre." },
    { scene: "s5", start: 56.4, end: 61.4, text: "Au retour de la connexion, la vente est envoyée, une seule fois, et le stock se met à jour." },
    { scene: "s6", start: 63.6, end: 69.6, text: "Le soir, l'analyse fait le point : le montant des ventes, les produits classés par montant vendu, et les stocks faibles." },
    { scene: "s6", start: 71.0, end: 74.6, text: "L'historique du mois se télécharge en Excel ou en PDF." },
    { scene: "s7", start: 78.0, end: 81.4, text: "Vos produits, vos ventes, votre équipe : tout est au même endroit." },
    { scene: "s7", start: 82.0, end: 85.4, text: "Découvrez Stock Master sur stock tiret master point app.", screen: "Découvrez Stock Master sur stock-master.app" },
  ],
  sfx: [
    { at: 5.5, file: "reveal", v: 0.35 },
    { at: 9.7, file: "tick", v: 0.45 },
    { at: 13.9, file: "whoosh-soft", v: 0.3 },
    { at: 21.8, file: "tick", v: 0.45 },
    { at: 25.6, file: "tick", v: 0.45 },
    { at: 26.4, file: "confirm", v: 0.4 },
    { at: 35.2, file: "pop", v: 0.4 },
    { at: 41.6, file: "tick", v: 0.45 },
    { at: 43.6, file: "tick", v: 0.45 },
    { at: 45.0, file: "confirm", v: 0.35 },
    { at: 47.7, file: "whoosh-soft", v: 0.35 },
    { at: 52.6, file: "tick", v: 0.45 },
    { at: 54.2, file: "tick", v: 0.45 },
    { at: 57.0, file: "confirm", v: 0.4 },
    { at: 73.6, file: "tick", v: 0.45 },
    { at: 77.4, file: "reveal", v: 0.35 },
  ],
};
