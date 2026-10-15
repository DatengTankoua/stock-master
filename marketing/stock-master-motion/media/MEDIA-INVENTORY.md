# Inventaire des médias et licences — lot 1-23A

Récupération le 14 octobre 2026. Aucun fichier n'est lié à distance dans les captures ou le film :
tout est téléchargé. Aucun filigrane n'a été retiré (aucun n'était présent).

## Photos des produits (24)

Source : Pexels. Licence Pexels (<https://www.pexels.com/license/>) : usage commercial et
modification autorisés, attribution non obligatoire ; interdits notamment : revendre la photo telle
quelle, laisser croire à une approbation par les personnes ou marques représentées.
Photos choisies **sans marque ni texte lisible**. Une image a été écartée pour un texte de type
marque (`lait-familial`, première sélection Pexels 13516802) ; une autre recadrée pour exclure un
texte de magazine (`masque-argile`). Retouche : recadrage carré et redimensionnement à 1200 px
seulement (`scripts/prepare_photos.py`, sélection `scripts/photo-selection.json`).

| Fichier | Page source | Auteur |
|---|---|---|
| `media/photos/lait-karite.jpg` | <https://www.pexels.com/photo/white-and-black-pump-bottle-8054404/> | Ksenia Chernaya |
| `media/photos/lait-aloe.jpg` | <https://www.pexels.com/photo/close-up-shot-of-a-lotion-bottle-on-pink-surface-8533228/> | Hanna Pad |
| `media/photos/lait-cacao.jpg` | <https://www.pexels.com/photo/pump-bottle-mockup-8217467/> | MART  PRODUCTION |
| `media/photos/lait-coco.jpg` | <https://www.pexels.com/photo/light-nature-texture-mockup-8533219/> | Hanna Pad |
| `media/photos/lait-familial.jpg` | <https://www.pexels.com/photo/two-white-pump-bottles-on-yellow-surface-4176566/> | Edward Jenner |
| `media/photos/gel-citron.jpg` | <https://www.pexels.com/photo/plastic-bottle-of-yellow-body-oil-4465828/> |    https://kaboompics.com/ |
| `media/photos/gel-aloe.jpg` | <https://www.pexels.com/photo/round-green-soap-dispenser-on-marble-countertop-38031452/> | sparkle light |
| `media/photos/savon-karite.jpg` | <https://www.pexels.com/photo/close-up-photograph-of-a-stack-of-soap-bars-7814808/> | Mikhail Nilov |
| `media/photos/savon-noir.jpg` | <https://www.pexels.com/photo/bar-soaps-on-top-of-a-marble-surface-6621471/> | Monstera Production |
| `media/photos/savon-liquide.jpg` | <https://www.pexels.com/photo/elegant-glass-soap-dispenser-by-window-38417093/> | Laura Chouette |
| `media/photos/creme-jour.jpg` | <https://www.pexels.com/photo/white-jar-with-gray-lid-18350286/> | Carlos Diaz |
| `media/photos/creme-nuit.jpg` | <https://www.pexels.com/photo/a-jar-of-cream-on-a-yellow-background-27544670/> | Deepa Nishad |
| `media/photos/serum-c.jpg` | <https://www.pexels.com/photo/brown-dropper-bottle-on-glass-surface-35899861/> | Mirа Fialkova |
| `media/photos/gommage.jpg` | <https://www.pexels.com/photo/plastic-container-on-wood-in-close-up-view-8489916/> | PNW Production |
| `media/photos/masque-argile.jpg` | <https://www.pexels.com/photo/clear-glass-jar-with-clay-mask-6167443/> | Vie Studio |
| `media/photos/huile-coco.jpg` | <https://www.pexels.com/photo/clear-glass-bottle-with-yellow-liquid-7796318/> | Alesia  Kozik |
| `media/photos/huile-karite.jpg` | <https://www.pexels.com/photo/amber-dropper-on-brown-textile-7795849/> | Alesia  Kozik |
| `media/photos/huile-ricin.jpg` | <https://www.pexels.com/photo/brown-and-black-dropper-bottle-8709582/> | Liana Horodetska |
| `media/photos/huile-argan.jpg` | <https://www.pexels.com/photo/beauty-product-in-bottle-on-table-8490234/> | PNW Production |
| `media/photos/shampoing.jpg` | <https://www.pexels.com/photo/a-close-up-shot-of-a-plastic-bottle-13006788/> | Stephen Audu |
| `media/photos/apres-shampoing.jpg` | <https://www.pexels.com/photo/a-brown-pump-bottle-8167172/> | Daria Liudnaya |
| `media/photos/masque-avocat.jpg` | <https://www.pexels.com/photo/mask-in-a-box-in-a-studio-10650934/> | Anastasiia Lopushynska |
| `media/photos/creme-coiffante.jpg` | <https://www.pexels.com/photo/a-plastic-tube-bottle-leaning-on-an-empty-container-8015480/> | Cup of  Couple |
| `media/photos/lait-capillaire.jpg` | <https://www.pexels.com/photo/silicone-travel-bottle-8533266/> | Hanna Pad |

## Marques

| Fichier | Origine | Droits |
|---|---|---|
| `film/assets/brand/stock-master-logo-horizontal.png`, `stock-master-icon.png` | `web/public/brand/` du dépôt | Logo officiel de Stock Master |
| `film/assets/brand/royalvibe-logo.jpeg` | copie octet pour octet de `Downloads/royalvibe-logo.jpeg` (SHA-256 identique `d1218789…7e51`) ; original non modifié ; envoyé tel quel comme logo du commerce de démonstration | Fourni par le commanditaire |

## Polices et code embarqués

| Élément | Version | Licence |
|---|---|---|
| Geist, Geist Mono (`film/assets/fonts/`), police de l'application | npm `geist@1.7.2` | SIL Open Font License 1.1 (`film/assets/fonts/OFL-Geist.txt`) |
| GSAP (`film/assets/vendor/gsap.min.js`) | npm `gsap@3.14.2` | GSAP Standard « no charge » License (<https://gsap.com/standard-license>) |

Outils non embarqués : HyperFrames `0.8.75` (télémétrie désactivée), Playwright `1.62.1`,
saas-motion-kit commit `bc7a414d6b66ceb09dfaa511e6237f382571bc84` (MIT), ffmpeg 9.0.2 (gyan.dev, SHA-256 vérifié).

## Musique

**Retenue (provisoire, 14/10/2026) : « Afro House » d'Artsiom Bialou**, copiée dans `film/assets/audio/music/afro-house-455843.mp3`. Présélection d'origine :

Source : Pixabay Music. Licence de contenu Pixabay (<https://pixabay.com/service/license-summary/>) :
usage gratuit, attribution non requise, interdiction de distribuer la piste seule. Filtre appliqué :
piste **non enregistrée dans YouTube Content ID** (risque de réclamation à la publication),
**non générée par IA**, durée ≥ 90 s. Fichiers hors dépôt :
`%LOCALAPPDATA%\StockMasterMotion23A\music-src\candidates\`.

| Titre | Auteur | Page | Durée |
|---|---|---|---|
| Afro House | Artsiom Bialou (ArtIssizm) | <https://pixabay.com/music/afrobeat-afro-house-455843/> | 132 s |
| Uplifting - Friend | Easy_Eva (Easy_Eva) | <https://pixabay.com/music/corporate-uplifting-friend-605770/> | 203 s |
| Corporate Calm Background | Alexey Kazantsev (331music) | <https://pixabay.com/music/corporate-corporate-calm-background-598386/> | 147 s |

## Effets sonores

Prévus : synthétisés localement par `tools/warm_sfx.py` du kit (sons générés, aucun échantillon tiers).

## Voix

À générer par le commanditaire avec Gemini TTS (`voice/`). L'animatique n'a pas de voix off finale.

## Référence

Vidéo de référence étudiée seulement (`storyboard/REFERENCES.md`) : rien n'est repris dans le film.
