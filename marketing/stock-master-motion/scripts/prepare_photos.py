"""Lot 1-23A — Téléchargement, recadrage et inventaire des photos produit.

Entrée : scripts/photo-selection.json (clé produit → id Pexels, famille,
cadrage). Les métadonnées (auteur, page) viennent des planches de candidats
(`<candidats>/<famille>/meta.json`, produites par gather_pexels.py).

Sortie :
  media/photos/<clé>.jpg       1200 × 1200, JPEG q85 (recadrage carré, aucune
                               autre retouche ; aucun filigrane supprimé)
  media/photos-inventory.json  source, auteur, licence, date de récupération
  <travail>/selection-sheet.jpg planche de sélection

Usage : python -I prepare_photos.py <dossier candidats> <dossier travail>
Téléchargements par curl (vérification TLS du magasin Windows).
"""
import datetime, io, json, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1200


def curl(url):
    return subprocess.run(["curl", "-sSfL", "--max-time", "60", url],
                          capture_output=True, check=True).stdout


def main(candidates, work):
    candidates, work = Path(candidates), Path(work)
    selection = json.loads((ROOT / "scripts" / "photo-selection.json").read_text(encoding="utf-8"))
    out = ROOT / "media" / "photos"
    out.mkdir(parents=True, exist_ok=True)
    (work / "originals").mkdir(parents=True, exist_ok=True)
    meta = {}
    for fam in {s["family"] for s in selection}:
        for it in json.loads((candidates / fam / "meta.json").read_text(encoding="utf-8")):
            meta[str(it["id"])] = it
    today = datetime.date.today().isoformat()
    inventory, tiles = [], []
    for s in selection:
        it = meta[str(s["id"])]
        raw = work / "originals" / f"pexels-{s['id']}.jpg"
        if not raw.exists():
            raw.write_bytes(curl(it["image"] + "?auto=compress&cs=tinysrgb&w=2000"))
        im = ImageOps.exif_transpose(Image.open(raw)).convert("RGB")
        # Carré : côté = plus petite dimension × zoom, centré sur (fx, fy).
        zoom = s.get("zoom", 1.0)
        side = int(min(im.size) / zoom)
        fx, fy = s.get("fx", 0.5), s.get("fy", 0.5)
        left = min(max(int(im.width * fx - side / 2), 0), im.width - side)
        top = min(max(int(im.height * fy - side / 2), 0), im.height - side)
        crop = im.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS)
        crop.save(out / f"{s['key']}.jpg", quality=85, optimize=True, progressive=True)
        inventory.append({
            "file": f"media/photos/{s['key']}.jpg", "product": s["key"],
            "source": "Pexels", "page": it["page"], "author": it["author"],
            "author_profile": f"https://www.pexels.com/@{it['author_username']}" if it.get("author_username") else None,
            "license": "Licence Pexels (https://www.pexels.com/license/)",
            "retrieved": today, "original_size": [it["width"], it["height"]],
            "edits": "recadrage carré, redimensionnement 1200 px, JPEG q85",
        })
        t = crop.resize((300, 300))
        tile = Image.new("RGB", (300, 336), (250, 250, 250))
        tile.paste(t, (0, 0))
        ImageDraw.Draw(tile).text((6, 308), f"{s['key']}  ({s['id']})", fill=(20, 20, 20))
        tiles.append(tile)
    (ROOT / "media" / "photos-inventory.json").write_text(
        json.dumps(inventory, indent=1, ensure_ascii=False), encoding="utf-8")
    cols = 6
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 304, rows * 340), (255, 255, 255))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 304, (i // cols) * 340))
    sheet.save(work / "selection-sheet.jpg", quality=85)
    print(len(inventory), "photos")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
