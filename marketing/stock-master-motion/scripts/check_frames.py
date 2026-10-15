"""Lot 1-23A — Contrôle de TOUTES les images d'un rendu (complète l'inspection visuelle).

Décode chaque image (réduite à 192 × 108, niveaux de gris) et signale :
- images isolées aberrantes : une image très différente de ses deux voisines alors que ces
  voisines se ressemblent (flash, image parasite) ;
- écrans presque noirs ou presque blancs uniformes ;
- coupes franches (changement d'image massif) : listées pour vérification, non fautives.
Usage : python -I scripts/check_frames.py <rendu.mp4>
"""
import json, os, subprocess, sys
from pathlib import Path
import numpy as np

W, H = 192, 108


def main(src):
    ff = Path(os.environ.get("LOCALAPPDATA", "")) / "StockMasterMotion23A/tools/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe"
    exe = str(ff) if ff.exists() else "ffmpeg"
    raw = subprocess.run([exe, "-v", "error", "-i", str(src), "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    f = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H, W).astype(np.float32)
    n = len(f)
    d = np.mean(np.abs(np.diff(f, axis=0)), axis=(1, 2))  # d[i] = écart image i -> i+1
    isolated = []
    for i in range(1, n - 1):
        skip = np.mean(np.abs(f[i + 1] - f[i - 1]))
        if d[i - 1] > 12 and d[i] > 12 and skip < 0.35 * min(d[i - 1], d[i]):
            isolated.append({"frame": i, "t": round(i / 30, 3), "in": round(float(d[i - 1]), 1), "out": round(float(d[i]), 1)})
    mean = f.mean(axis=(1, 2))
    std = f.std(axis=(1, 2))
    flat = [{"frame": i, "t": round(i / 30, 3), "mean": round(float(mean[i]), 1)} for i in range(n) if std[i] < 2.0]
    cuts = [{"t": round((i + 1) / 30, 3), "diff": round(float(d[i]), 1)} for i in range(n - 1) if d[i] > 40]
    out = {"render": str(src), "frames": n, "durationAt30": round(n / 30, 3), "isolatedFrames": isolated,
           "uniformFrames": flat[:50], "uniformCount": len(flat), "hardCuts": cuts,
           "maxStep": round(float(d.max()), 1), "maxStepAt": round(float((d.argmax() + 1) / 30), 3)}
    Path(str(src) + ".frames-check.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"{n} images ({n / 30:.3f} s) ; images isolées aberrantes : {len(isolated)} ; images uniformes : {len(flat)} ; "
          f"coupes franches : {len(cuts)} ; plus grand saut {out['maxStep']} à {out['maxStepAt']} s")
    for c in cuts:
        print(f"  coupe franche à {c['t']} s (écart {c['diff']})")
    for x in isolated[:20]:
        print(f"  image isolée {x['frame']} à {x['t']} s")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
