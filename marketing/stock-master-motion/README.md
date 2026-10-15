# Stock Master — film de présentation (lot 1-23A)

Outillage marketing **isolé** : dépendances propres (`package.json`, npm), jamais chargées par l'API ni
par le web. Documentation complète : `docs/architecture/phase-1-23a-stock-master-motion.md`.

| Dossier | Rôle |
|---|---|
| `demo/` | démonstration locale RoyalVibe : démarrage, peuplement, tournage (`motion-demo.js`) |
| `film/` | composition HyperFrames (`index.html`), minutage (`assets/cues.js`), captures réelles, médias |
| `storyboard/` | brief, références, storyboard, point de validation |
| `voice/` | texte de voix off et consignes Gemini TTS |
| `media/` | photos des produits et inventaire des licences |
| `scripts/` | photos, inventaire, synchronisation du minutage, lanceur HyperFrames, mesure de la voix |
| `exports/` | rendus (hors Git) |

Démarrage rapide (depuis ce dossier, après `npm ci` et `pnpm --filter api build` à la racine) :

```bash
node demo/motion-demo.js start        # terminal 1
node demo/motion-demo.js seed         # base vierge seulement
node demo/motion-demo.js capture      # tournage (écrit réellement dans la base de démo)
node scripts/sync-cues.js
npm run preview
```
