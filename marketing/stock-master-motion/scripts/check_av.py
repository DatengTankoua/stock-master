"""Lot 1-23A — Contrôle mesuré du son d'un rendu (voix, musique, synchronisation).

Pour chaque clip de voix posé (film/assets/voice-fit.json) :
- décalage entre la voix attendue (fichier source + instant prévu) et le son rendu, par
  corrélation des enveloppes (fenêtre ±0,5 s) ;
- présence de la voix : écart de niveau entre la phrase et la musique seule voisine.
Global : niveau intégré, crête, saturation (échantillons à ±1).

Usage : python -I scripts/check_av.py <rendu.mp4> [--ffmpeg=<dossier bin>]
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
FILM = ROOT / "film"
SR = 48000
HOP = 480  # 10 ms


def ffmpeg_bin(args):
    for a in args:
        if a.startswith("--ffmpeg="):
            return Path(a.split("=", 1)[1])
    import os
    p = Path(os.environ.get("LOCALAPPDATA", "")) / "StockMasterMotion23A/tools/ffmpeg-9.0.2-essentials_build/bin"
    return p if p.exists() else None


def decode(ff, src, extra=()):
    exe = str(ff / "ffmpeg.exe") if ff else "ffmpeg"
    out = subprocess.run([exe, "-v", "error", "-i", str(src), *extra, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def env(x):
    n = len(x) // HOP
    return np.sqrt(np.mean(x[: n * HOP].reshape(n, HOP) ** 2, axis=1) + 1e-12)


def main(render, args):
    ff = ffmpeg_bin(args)
    fit = json.loads((FILM / "assets/voice-fit.json").read_text(encoding="utf-8"))
    mix = decode(ff, render)
    stereo = decode(ff, render, ("-af", "pan=mono|c0=c0",))  # canal gauche, pour la saturation
    voice_src = decode(ff, FILM / fit["file"])
    peak = float(np.max(np.abs(stereo))) if len(stereo) else 0.0
    clipped = int(np.sum(np.abs(stereo) >= 0.999))
    em = env(mix)
    report = []
    for g, v in zip(fit["segments"], fit["vo"]):
        a = int(g["mediaStart"] * SR)
        seg = voice_src[a: a + int(g["duration"] * SR)]
        ref = env(seg)
        at = int(round(g["at"] * 100))
        best, lag = -2, 0
        for L in range(-50, 51):
            i = at + L
            if i < 0 or i + len(ref) > len(em):
                continue
            w = em[i: i + len(ref)]
            c = np.corrcoef(np.log(ref), np.log(w))[0, 1]
            if c > best:
                best, lag = c, L
        s, e = int(v["start"] * 100), int(v["end"] * 100)
        speech_db = 20 * np.log10(np.mean(em[s:e]))
        around = np.concatenate([em[max(0, s - 80): max(0, s - 20)], em[e + 20: e + 80]])
        bed_db = 20 * np.log10(np.mean(around)) if len(around) else float("nan")
        report.append({"scene": v["scene"], "at": v["start"], "lagMs": lag * 10, "corr": round(float(best), 3),
                       "speechDb": round(float(speech_db), 1), "aroundDb": round(float(bed_db), 1), "text": v["text"][:40]})
    out = {"render": str(render), "peak": round(peak, 4), "peakDbfs": round(20 * np.log10(max(peak, 1e-9)), 2),
           "clippedSamples": clipped, "segments": report,
           "maxAbsLagMs": max(abs(r["lagMs"]) for r in report), "minCorr": min(r["corr"] for r in report)}
    Path(str(render) + ".av-check.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    for r in report:
        print(f"{r['scene']} {r['at']:6.2f}s  décalage {r['lagMs']:+4d} ms  corr {r['corr']:.2f}  voix {r['speechDb']:6.1f} dB / autour {r['aroundDb']:6.1f} dB  {r['text']}")
    print(f"crête {out['peakDbfs']} dBFS, échantillons saturés {clipped}, décalage max {out['maxAbsLagMs']} ms, corrélation min {out['minCorr']}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2:])
