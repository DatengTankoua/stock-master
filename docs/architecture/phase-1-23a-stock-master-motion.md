# Lot 1-23A — Film de présentation Stock Master (90 s)

État : **direction et progression validées ; montage prêt à recevoir la prise Gemini complète.**
Animatique v2 rendu (loupes sur les zones utilisées, condition hors ligne courte, « Historique du
mois · Excel / PDF »). Master, master sous-titré, SRT et copies de partage : à la réception de la voix,
par `scripts/produce-master.js`.
Aucun commit, push, déploiement ni publication. Aucun `.env` réel lu.

## 1. Référence

| Élément | Valeur |
|---|---|
| Branche | `marketing/phase-1-23a-stock-master-motion`, créée depuis `fix/phase-1-22h1-cors-retry-after` |
| Commit de base | `d6945a6dac617eba1b866bccfa10cad41af3637b` (arbre propre ; `stash@{0}` conservé, vidéo de référence non suivie laissée en place) |
| Skill | saas-motion-kit, commit `bc7a414d6b66ceb09dfaa511e6237f382571bc84` (v1.4, MIT), lu et examiné ; cloné hors dépôt |
| Moteur | HyperFrames `0.8.75` (version validée par le kit), télémétrie désactivée ; pas d'autre moteur |
| Outils | Playwright `1.62.1` (Chromium 1234 déjà installé), ffmpeg 9.0.2 (gyan.dev, SHA-256 vérifié), Python 3.11 + numpy 2.2.6 / Pillow 11.3.0 / soundfile 0.13.1 dans un venv hors dépôt |

Isolation : `marketing/stock-master-motion/` a son propre `package.json` + `package-lock.json` (npm),
hors workspace pnpm (`pnpm-workspace.yaml` : `api`, `web`). Ni HyperFrames ni Playwright n'entrent dans
les dépendances de l'API ou du web ; `pnpm-lock.yaml` est inchangé.

## 2. Démonstration locale (RoyalVibe Cosmétique)

Réutilisation de la recette `api/test/recipe/` (garde anti-`.env`, environnements construits, copie web
isolée, simulateurs e-mail / push / SasPay / stockage). Ajout d'un **profil** `RECIPE_PROFILE=motion-23a` :

| | Recette par défaut (inchangée) | Profil `motion-23a` |
|---|---|---|
| Base | éphémère `stockmaster_recipe` | **persistante** `stockmaster_motion_23a`, `127.0.0.1:27230`, données `%LOCALAPPDATA%\StockMasterMotion23A\demo\mongo` |
| Ports | 3200 / 4200 / 4299 / 4298 | 3230 / 4230 / 4239 / 4238 |
| Stockage simulé | mémoire | mémoire + disque (`…\demo\storage`) |
| Fuseau API/web | celui de la machine | `TZ=Africa/Douala` |
| Comptes | `fixtures.js` | `fixtures-motion-23a.js` (4 comptes `@royalvibe.example.test`), créés seulement sur base vierge |

Garde : `assertRecipeUri` refuse, dans ce profil, tout hôte non local, tout port autre que 27230, toute
base autre que `stockmaster_motion_23a`, toute URI avec identifiants ; un profil inconnu est refusé.
Vérifié sur 5 URI (1 acceptée, 4 refusées) et sur le profil par défaut (inchangé).

Peuplement `demo/seed-royalvibe.js`, par l'API réelle : logo original (octets inchangés) et couleur,
droits des vendeurs, 5 rayons, 24 produits avec photo, abonnement annuel via SasPay **simulé**,
115 ventes datées sur 13 jours (`occurredAt`, plage de 14 jours de l'API), réassort par le vendeur
autorisé. Seule écriture directe (test) : les **horodatages** (enregistrement des ventes aligné sur leur
date, journal, créations), plus le retrait des 202 notifications et 118 envois push simulés produits en
masse par le peuplement et d'un bilan de septembre antérieur au commerce. Aucune quantité ni montant.

Constat (non corrigé, hors périmètre) : les listes de ventes et l'historique produit affichent la date
d'**enregistrement** (`createdAt`), pas la date réelle (`occurredAt`) ; une vente synchronisée après une
coupure apparaît donc à l'heure de sa synchronisation.

Tournage rejoué après validation (réinitialisation puis peuplement) pour que la permission citée par
la voix soit celle réellement attribuée : Grâce reçoit « Voir toutes les ventes ». Résultats identiques
au premier tournage (`film/assets/captures/capture-checks.json`).

## 3. Commandes

Depuis `marketing/stock-master-motion/` (après `npm ci` et `pnpm --filter api build`) :

```bash
node demo/motion-demo.js start      # pile locale, premier plan (fournisseur SasPay simulé)
node demo/motion-demo.js seed       # base vierge seulement
node demo/motion-demo.js capture    # tournage : vente, droits, hors ligne, analyse (écrit réellement)
node demo/motion-demo.js stop       # arrêt, données conservées
node demo/motion-demo.js reset      # efface la démonstration (pile arrêtée, chemin vérifié)
npm run preview                     # studio HyperFrames (film/)
npm run check:film                  # lint + vérifications
npm run snapshot -- --at 3.2,29.5   # images clés (sans analyse Gemini)
node scripts/sync-cues.js           # minutage (assets/cues.js) → audio, atténuation musique, facts.js
node scripts/hf.js render --fps 30 --quality looks --resolution landscape --workers 4 -o ../exports/animatique/<nom>.mp4
node scripts/measure-voice.js       # mesure seule : durée, niveau, silences
node scripts/produce-master.js      # à réception de film/assets/audio/voice/voiceover-fr.wav : tout le reste
```

### Réception de la voix (prise complète)

`produce-master.js` enchaîne :
1. `fit-voice.js` : silences mesurés ; les 6 plus longs séparent les 7 scènes, les plus longs de
   chaque scène séparent ses phrases. Chaque phrase devient un clip du même fichier
   (`data-media-start`), coupé **dans les silences**, posé à son instant prévu ou après la phrase
   précédente (+ 0,35 s dans une scène, + 0,8 s entre scènes). Les plans suivent les débuts réels des
   phrases ; les durées d'animation ne changent pas. Si la voix ne tient pas dans 90 s (avec 2,5 s de
   tenue finale), tout le minutage prévu est resserré d'un même facteur, rapporté ; sous 0,5, échec
   explicite : raccourcir le texte ou les pauses. **La voix n'est jamais accélérée.** Le niveau de la
   prise est mesuré (EBU R128) et calé vers −16 LUFS avant le mixage.
2. `sync-cues.js --mode=master` puis `--mode=master-subtitled` : fenêtres des scènes, clips de voix,
   musique atténuée sous chaque phrase, effets, sous-titres (2 lignes de 42 caractères au plus,
   espaces insécables avant ? ! : ;), `voice/stock-master-fr.srt`.
3. Deux rendus HyperFrames, puis `deliver.js` : masters 1920 × 1080 (vidéo copiée, son normalisé
   en deux passes à −14 LUFS, limiteur −2 dBFS, AAC 192 kb/s, index en tête), copies de partage
   1280 × 720 H.264 Main ≈ 14 Mo (WhatsApp), miniature, rapport.
4. `check_av.py` (décalage voix attendue/voix rendue par phrase, niveaux, saturation) et
   `check_frames.py` (les 2 700 images : images isolées aberrantes, écrans uniformes, coupes franches).

Modes : `animatic` (étiquette « ANIMATIQUE » + bande « VO PRÉVUE ») ; `master` (aucune des deux ;
« Données de démonstration » conservé discrètement) ; `master-subtitled` (sous-titres incrustés).

Le minutage (scènes, répliques, effets) a une source unique : `film/assets/cues.js`. Les chiffres
affichés viennent de `film/assets/facts.js`, généré depuis les vérifications du tournage.

Photos : `scripts/gather_pexels.py` (candidats), `scripts/prepare_photos.py` (téléchargement, recadrage,
inventaire), `scripts/write_inventory.py`.

## 4. Fichiers

| Emplacement | Contenu |
|---|---|
| `marketing/stock-master-motion/demo/` | démonstration : catalogue, peuplement, tournage, explorations |
| `marketing/stock-master-motion/film/` | composition HyperFrames, captures réelles (`assets/captures`, `captures.json`, `capture-checks.json`), photos, polices, logos, GSAP, emplacement audio |
| `marketing/stock-master-motion/storyboard/` | brief, références, storyboard + registre, point de validation |
| `marketing/stock-master-motion/voice/` | `voiceover-fr.txt`, `gemini-tts-direction-fr.md` |
| `marketing/stock-master-motion/media/` | photos (24), inventaire des licences |
| `api/test/recipe/` | profil `motion-23a` (recipe-common, launcher, storage-sim, fixtures, seed-fixtures) |
| `%LOCALAPPDATA%\StockMasterMotion23A\` (hors Git) | outils, base et stockage de la démonstration, référence, candidats photo et musique, images clés |

Pendant que la pile tourne, `.stockmaster-motion-web/` (copie web isolée) apparaît à la racine : ne
pas l'ajouter à un commit ; elle est supprimée à l'arrêt.

## 5. Remplacer la voix, les images, les textes

- Voix : déposer `voiceover-fr.wav` (prise complète, à privilégier) ou des reprises `vo-s<n>.wav` dans
  `film/assets/audio/voice/` ; mesurer (`measure-voice.js`), recaler `cues.js`, relancer `sync-cues.js`.
- Musique : remplacer `film/assets/audio/music/afro-house-455843.mp3` (même nom) ou modifier `sync-cues.js`.
- Photos : modifier `scripts/photo-selection.json`, relancer `prepare_photos.py`, puis `reset`, `seed`, `capture`.
- Textes à l'écran : `film/index.html` (fonctions `words(...)`) ; voix : `voice/voiceover-fr.txt`.

## 6. Vérifications faites (point de validation)

| Vérification | Résultat |
|---|---|
| Concordance des chiffres | Analyse = API = base = export Excel : 440 700 FCFA, 117 ventes, 140 unités ; stock initial − restant = unités vendues |
| Vente | Huile d'argan : 3 → 2, « Stock faible », notifications réelles chez la propriétaire |
| Hors ligne | Session et catalogue ouverts en ligne, réseau coupé dans le navigateur de test, vente « en attente », réseau rétabli : **1** vente reçue, 0 doublon d'opération, stock 37 → 35 |
| Export | `historique-royalvibe-cosmetique-…-2026-10.xlsx` (14 404 octets), contenu recoupé |
| Audit de variété du kit | 16 plans, aucune répétition signalée |
| Lint HyperFrames | 0 erreur ; avertissements de structure à traiter dans l'animatique (une sous-composition par scène) |

## 7. Animatique

`marketing/stock-master-motion/exports/animatique/` (hors Git) : MP4 « sans voix off finale », quatre
images clés et planche. Il porte l'étiquette « ANIMATIQUE · sans voix off finale » et une bande
« VO PRÉVUE » (répliques au minutage prévu), toutes deux absentes du master final. Musique « Afro House »
atténuée sous les répliques prévues ; effets doux synthétisés.

Vérifications de l'animatique : `ffprobe` (90,000 s ; 2 700 images à 30 i/s ; 1920 × 1080 ; H.264
High yuv420p ; AAC 48 kHz stéréo ; index `moov` en tête) ; `ebur128` (−28 LUFS, crête −7,8 dBFS, aucune
saturation) ; `silencedetect` (aucun trou > 1 s) ; visionnage complet à 2 images/s (180 images) et
inspection des raccords ; contrôle de lisibilité à 640 px de large. Défauts trouvés et corrigés avant
le rendu final : mots visibles avant leur entrée, titre masqué au recul vers l'ordinateur, ancien titre
resté au bord de l'écran, valeur débordant d'une carte, raccord pastille/téléphone à 76 s.

### Essai de la chaîne (voix de test locale, non livrée)

Prise de test générée localement (voix Windows « Hortense », fr-FR, même texte et mêmes pauses,
85,3 s), copiée sous `_TEST-…`, puis **retirée** avec tous ses produits. Résultats : 7 scènes et
17 phrases repérées ; aucun resserrement (facteur 1,000) ; tenue finale 4,2 s ; rendu d'essai :
17/17 phrases à 0 ms de décalage (résolution 10 ms), voix 4 à 11 dB au-dessus de la musique voisine,
0 échantillon saturé ; 2 700 images sans image isolée ni écran uniforme ; livraison : 90,000 s,
−14,4 LUFS, crêtes sous 0 dBFS après ajout du limiteur, copies de partage ≈ 13,4 Mo. Défauts trouvés
et corrigés : découpe des sous-titres, crête des copies AAC, apparition brusque de la séquence vente,
compression des actions muettes par la première méthode de recalage.

## 8. Limites et points ouverts

- La durée des scènes est celle prévue ; elle sera recalée sur la voix Gemini mesurée.
- **Visionnage en temps réel avec le son : non réalisable par l'agent** (ni lecture, ni écoute).
  Il est complété par les contrôles mesurés ci-dessus, mais doit être fait par une personne sur le
  master et sur la copie WhatsApp, sur un téléphone.
- Le repérage des phrases suppose que la prise respecte les `<long pause>` entre scènes (silence
  nettement plus long que les pauses courtes) ; sinon, fournir des reprises par scène.
- Encadré « Condition » du hors ligne : réécrit en titre de 40 px + deux lignes de 30 px.
- `hyperframes lint` : avertissements de structure (fichier unique, scènes non découpées en sous-compositions) acceptés ; 0 erreur.
- Pas de mention d'essai gratuit (décision du 14/10/2026).
- Les premières commandes `hyperframes --help` / `docs` ont été lancées avant la désactivation de la
  télémétrie (données d'usage anonymes, sans contenu selon l'éditeur).
- Notifications push : simulées ; seul le centre de notifications de l'application est montré.
- Un dossier vide `C:\c\Users\daten\AppData\Local\StockMasterMotion23A\explore` a été créé par erreur
  (conversion de chemin Git Bash) ; ses fichiers ont été déplacés, sa suppression est laissée à
  l'utilisateur.
