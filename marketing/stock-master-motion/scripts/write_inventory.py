"""Lot 1-23A — Génère media/MEDIA-INVENTORY.md depuis les métadonnées relevées.

Usage : python -I scripts/write_inventory.py <candidates.json de la musique>
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(music_json):
    inv = json.loads((ROOT / "media" / "photos-inventory.json").read_text(encoding="utf-8"))
    mus = json.loads(Path(music_json).read_text(encoding="utf-8"))
    L = ["# Inventaire des médias et licences — lot 1-23A", ""]
    L += [
        "Récupération le 14 octobre 2026. Aucun fichier n'est lié à distance dans les captures ou le film :",
        "tout est téléchargé. Aucun filigrane n'a été retiré (aucun n'était présent).",
        "",
        "## Photos des produits (24)",
        "",
        "Source : Pexels. Licence Pexels (<https://www.pexels.com/license/>) : usage commercial et",
        "modification autorisés, attribution non obligatoire ; interdits notamment : revendre la photo telle",
        "quelle, laisser croire à une approbation par les personnes ou marques représentées.",
        "Photos choisies **sans marque ni texte lisible**. Une image a été écartée pour un texte de type",
        "marque (`lait-familial`, première sélection Pexels 13516802) ; une autre recadrée pour exclure un",
        "texte de magazine (`masque-argile`). Retouche : recadrage carré et redimensionnement à 1200 px",
        "seulement (`scripts/prepare_photos.py`, sélection `scripts/photo-selection.json`).",
        "",
        "| Fichier | Page source | Auteur |",
        "|---|---|---|",
    ]
    L += [f"| `{x['file']}` | <{x['page']}> | {x['author']} |" for x in inv]
    L += [
        "",
        "## Marques",
        "",
        "| Fichier | Origine | Droits |",
        "|---|---|---|",
        "| `film/assets/brand/stock-master-logo-horizontal.png`, `stock-master-icon.png` | `web/public/brand/` du dépôt | Logo officiel de Stock Master |",
        "| `film/assets/brand/royalvibe-logo.jpeg` | copie octet pour octet de `Downloads/royalvibe-logo.jpeg` (SHA-256 identique `d1218789…7e51`) ; original non modifié ; envoyé tel quel comme logo du commerce de démonstration | Fourni par le commanditaire |",
        "",
        "## Polices et code embarqués",
        "",
        "| Élément | Version | Licence |",
        "|---|---|---|",
        "| Geist, Geist Mono (`film/assets/fonts/`), police de l'application | npm `geist@1.7.2` | SIL Open Font License 1.1 (`film/assets/fonts/OFL-Geist.txt`) |",
        "| GSAP (`film/assets/vendor/gsap.min.js`) | npm `gsap@3.14.2` | GSAP Standard « no charge » License (<https://gsap.com/standard-license>) |",
        "",
        "Outils non embarqués : HyperFrames `0.8.75` (télémétrie désactivée), Playwright `1.62.1`,",
        "saas-motion-kit commit `bc7a414d6b66ceb09dfaa511e6237f382571bc84` (MIT), ffmpeg 9.0.2 (gyan.dev, SHA-256 vérifié).",
        "",
        "## Musique",
        "",
        "**Retenue (provisoire, 14/10/2026) : « Afro House » d'Artsiom Bialou**, copiée dans `film/assets/audio/music/afro-house-455843.mp3`. Présélection d'origine :",
        "",
        "Source : Pixabay Music. Licence de contenu Pixabay (<https://pixabay.com/service/license-summary/>) :",
        "usage gratuit, attribution non requise, interdiction de distribuer la piste seule. Filtre appliqué :",
        "piste **non enregistrée dans YouTube Content ID** (risque de réclamation à la publication),",
        "**non générée par IA**, durée ≥ 90 s. Fichiers hors dépôt :",
        "`%LOCALAPPDATA%\\StockMasterMotion23A\\music-src\\candidates\\`.",
        "",
        "| Titre | Auteur | Page | Durée |",
        "|---|---|---|---|",
    ]
    L += [f"| {m['title']} | {m['author']} ({m['username']}) | <{m['page']}> | {m['duration']} s |" for m in mus]
    L += [
        "",
        "## Effets sonores",
        "",
        "Prévus : synthétisés localement par `tools/warm_sfx.py` du kit (sons générés, aucun échantillon tiers).",
        "",
        "## Voix",
        "",
        "À générer par le commanditaire avec Gemini TTS (`voice/`). L'animatique n'a pas de voix off finale.",
        "",
        "## Référence",
        "",
        "Vidéo de référence étudiée seulement (`storyboard/REFERENCES.md`) : rien n'est repris dans le film.",
        "",
    ]
    (ROOT / "media" / "MEDIA-INVENTORY.md").write_text("\n".join(L), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main(sys.argv[1])
