#!/usr/bin/env node
/**
 * Lot 1-23A — Recalage du montage sur la voix réelle (prise complète Gemini).
 *
 * Principe : la voix n'est JAMAIS accélérée, ralentie ni coupée au milieu d'une phrase.
 * 1. Mesure des silences (ffmpeg silencedetect). Les 6 silences internes les plus longs
 *    séparent les 7 scènes (`<long pause>` du texte) ; dans une scène, les silences les plus
 *    longs séparent ses phrases (`<short pause>`).
 * 2. Chaque phrase devient un clip du même fichier (`data-media-start`), coupé dans les
 *    silences qui l'entourent, et posé à son instant prévu (au plus tôt après la phrase
 *    précédente + un silence minimal). Si la voix ne tient pas dans 90 s, tout le minutage
 *    prévu est resserré d'un même facteur alpha (rapporté) ; sous alpha = 0,5, échec :
 *    raccourcir le texte ou les pauses.
 * 3. Les instants prévus des plans suivent les débuts réels des phrases (correspondance
 *    linéaire par morceaux) ; les durées d'animation ne changent pas.
 * Sortie : film/assets/voice-fit.json ; puis lancer `node scripts/sync-cues.js --mode=…`.
 *
 * Usage : node scripts/fit-voice.js [chemin du WAV] [--noise=-40dB] [--min=0.16] [--total=90]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILM = path.join(ROOT, 'film');
const BIN = path.join(process.env.LOCALAPPDATA || '', 'StockMasterMotion23A', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin');
const tool = (n) => (fs.existsSync(path.join(BIN, `${n}.exe`)) ? path.join(BIN, `${n}.exe`) : n);
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const r3 = (x) => Math.round(x * 1000) / 1000;

function loadCues() {
  const sb = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(FILM, 'assets', 'cues.js'), 'utf8'), sb);
  return sb.window.FILM_CUES;
}

function measure(file) {
  const dur = Number(
    spawnSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout,
  );
  const err = spawnSync(
    tool('ffmpeg'),
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${opt('noise', '-40dB')}:d=${opt('min', '0.16')}`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  ).stderr;
  const sil = [];
  let s = null;
  for (const line of err.split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (a) s = Math.max(0, Number(a[1]));
    if (b && s !== null) {
      sil.push({ start: s, end: Number(b[1]) });
      s = null;
    }
  }
  if (s !== null) sil.push({ start: s, end: dur }); // silence final sans fin détectée
  return { dur, sil: sil.map((x) => ({ ...x, d: x.end - x.start })) };
}

function main() {
  const cues = loadCues();
  const total = Number(opt('total', cues.duration));
  const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(FILM, 'assets', 'audio', 'voice', 'voiceover-fr.wav'));
  if (!fs.existsSync(file)) throw new Error(`Voix absente : ${file}`);
  const { dur, sil } = measure(file);

  const speechStart = sil.length && sil[0].start <= 0.01 ? sil[0].end : 0;
  const last = sil[sil.length - 1];
  const speechEnd = last && Math.abs(last.end - dur) < 0.02 ? last.start : dur;
  const inner = sil.filter((x) => x.start > speechStart && x.end < speechEnd);

  const scenes = cues.scenes;
  // Alignement sur le texte : parmi les silences, choisir les coupures entre phrases dont les
  // durées collent le mieux à la longueur (en caractères) de chaque phrase ; un silence plus
  // long est légèrement favorisé. Fonctionne que les pauses longues se distinguent ou non.
  const sentencesAll = cues.vo;
  const N = sentencesAll.length;
  const chars = sentencesAll.map((v) => v.text.replace(/\s+/g, ' ').length);
  const C = chars.reduce((x, y) => x + y, 0);
  const cand = inner.filter((x) => x.d >= 0.3);
  const M = cand.length;
  if (M < N - 1) throw new Error(`Seulement ${M} silences pour ${N - 1} coupures de phrases.`);
  const topPauses = [...cand].sort((x, y) => y.d - x.d).slice(0, N - 1).reduce((t, x) => t + x.d, 0);
  const rate = (speechEnd - speechStart - topPauses) / C;
  const exp = chars.map((c) => c * rate);
  const cost = (d, k) => ((d - exp[k]) ** 2) / exp[k];
  // dp[k][j] : phrases 0..k placées, phrase k finissant au silence j.
  const INF = 1e18;
  const dp = Array.from({ length: N - 1 }, () => new Array(M).fill(INF));
  const from = Array.from({ length: N - 1 }, () => new Array(M).fill(-1));
  for (let j = 0; j < M; j++) dp[0][j] = cost(cand[j].start - speechStart, 0) - 0.6 * cand[j].d;
  for (let k = 1; k < N - 1; k++) {
    for (let j = k; j < M; j++) {
      for (let i = k - 1; i < j; i++) {
        if (dp[k - 1][i] >= INF) continue;
        const v = dp[k - 1][i] + cost(cand[j].start - cand[i].end, k) - 0.6 * cand[j].d;
        if (v < dp[k][j]) { dp[k][j] = v; from[k][j] = i; }
      }
    }
  }
  let bestJ = -1, best = INF;
  for (let j = N - 2; j < M; j++) {
    const v = dp[N - 2][j] + cost(speechEnd - cand[j].end, N - 1);
    if (v < best) { best = v; bestJ = j; }
  }
  const cuts = new Array(N - 1);
  for (let k = N - 2, j = bestJ; k >= 0; k--) { cuts[k] = cand[j]; j = from[k][j]; }
  const bounds = sentencesAll.map((v, k) => ({ srcStart: k === 0 ? speechStart : cuts[k - 1].end, srcEnd: k === N - 1 ? speechEnd : cuts[k].start }));
  const breaks = scenes.slice(0, -1).map((sc) => {
    const lastIdx = sentencesAll.map((v) => v.scene).lastIndexOf(sc.id);
    return cuts[lastIdx];
  });
  const nBreaks = breaks.length;
  const weakest = Math.min(...breaks.map((x) => x.d));
  const sceneSpeech = scenes.map((sc) => {
    const idx = sentencesAll.map((v, k) => (v.scene === sc.id ? k : -1)).filter((k) => k >= 0);
    const planned = idx.map((k) => sentencesAll[k]);
    const sentences = idx.map((k) => ({ ...sentencesAll[k], ...bounds[k], expected: exp[k] }));
    const a2 = sentences[0].srcStart, b2 = sentences[sentences.length - 1].srcEnd;
    return { id: sc.id, a: a2, b: b2, speech: b2 - a2, planned, sentences, lead: planned[0].start - sc.start, plannedDur: sc.end - sc.start };
  });
  const report = sceneSpeech.map((s) => `${s.id}: parlé ${s.speech.toFixed(2)} s (scène prévue ${s.plannedDur} s)`);

  // Pose phrase par phrase : chaque phrase est un clip coupé dans les silences qui l'entourent
  // (jamais dans la parole) et posé à son instant prévu. Si la voix ne tient pas, tout le
  // minutage prévu est resserré du même facteur alpha (signalé), jamais une action isolée.
  const GAP_IN = 0.35; // silence minimal entre deux phrases d'une même scène
  const GAP_OUT = 0.8; // silence minimal entre deux scènes
  const HOLD = 2.5; // tenue minimale après la dernière phrase (logo, adresse)
  const flat = [];
  sceneSpeech.forEach((s, i) => s.sentences.forEach((x, k) => flat.push({ ...x, sceneIndex: i, first: k === 0, d: x.srcEnd - x.srcStart })));
  const place = (alpha) => {
    let prevEnd = -Infinity;
    return flat.map((x, j) => {
      const want = x.start * alpha;
      const gap = j === 0 ? 0 : x.first ? GAP_OUT : GAP_IN;
      const start = Math.max(want, prevEnd + gap);
      prevEnd = start + x.d;
      return start;
    });
  };
  let alpha = 1;
  let starts = place(alpha);
  const fits = (st) => st[st.length - 1] + flat[flat.length - 1].d + HOLD <= total;
  if (!fits(starts)) {
    let lo = 0.5, hi = 1;
    if (!fits(place(lo))) {
      process.stderr.write(`${report.join('\n')}\n`);
      throw new Error(`La voix ne tient pas dans ${total} s même en resserrant le minutage de moitié : raccourcir le texte ou les pauses.`);
    }
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (fits(place(mid))) lo = mid; else hi = mid;
    }
    alpha = lo;
    starts = place(alpha);
  }

  // Clips : marges prises dans les silences voisins (au plus la moitié de chacun).
  const segments = [];
  const vo = [];
  flat.forEach((x, j) => {
    const prevSrcEnd = j === 0 ? 0 : flat[j - 1].srcEnd;
    const nextSrcStart = j === flat.length - 1 ? dur : flat[j + 1].srcStart;
    const pre = Math.min(0.12, (x.srcStart - prevSrcEnd) / 2);
    const post = Math.min(0.25, (nextSrcStart - x.srcEnd) / 2);
    segments.push({ scene: x.scene, mediaStart: r3(x.srcStart - pre), duration: r3(x.d + pre + post), at: r3(starts[j] - pre) });
    vo.push({ scene: x.scene, text: x.text, screen: x.screen, plannedStart: x.start, plannedEnd: x.end, start: r3(starts[j]), end: r3(starts[j] + x.d) });
  });

  // Correspondance prévu -> réel : débuts de phrases (les plans suivent la voix) ; avant la
  // première phrase d'une scène, le décalage de la scène est conservé.
  const anchors = [[0, 0]];
  vo.forEach((v) => anchors.push([v.plannedStart, v.start]));
  anchors.push([cues.duration, total]);
  const timemap = [];
  for (const [a2, b2] of anchors.sort((x, y) => x[0] - y[0])) {
    const lastA = timemap[timemap.length - 1];
    if (lastA && (a2 <= lastA[0] || b2 <= lastA[1])) continue;
    timemap.push([r3(a2), r3(b2)]);
  }
  // Rapport de rythme : plus petit rapport réel/prévu entre deux ancres (1 = rythme prévu).
  let minRatio = Infinity;
  for (let i = 1; i < timemap.length; i++) {
    minRatio = Math.min(minRatio, (timemap[i][1] - timemap[i - 1][1]) / (timemap[i][0] - timemap[i - 1][0]));
  }
  const Tm = (t) => {
    for (let i = 1; i < timemap.length; i++) {
      const [a0, b0] = timemap[i - 1], [a1, b1] = timemap[i];
      if (t <= a1) return b0 + ((t - a0) * (b1 - b0)) / (a1 - a0);
    }
    return t;
  };
  const actualScenes = scenes.map((sc) => ({ id: sc.id, start: r3(Tm(sc.start)), end: r3(Tm(sc.end)) }));
  const slack = total - (vo[vo.length - 1].end + HOLD);

  // Niveau intégré de la prise (EBU R128), pour caler la voix vers −16 LUFS avant le master.
  const lufsErr = spawnSync(tool('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const lufsM = /I:\s+(-?[\d.]+) LUFS/.exec(lufsErr);
  const voiceLufs = lufsM ? Number(lufsM[1]) : null;
  const voiceGain = voiceLufs === null ? 1 : Math.min(3.98, Math.max(0.25, Math.pow(10, (-16 - voiceLufs) / 20)));

  const fit = {
    voiceLufs,
    voiceGain: r3(voiceGain),
    file: path.relative(FILM, file).replace(/\\/g, '/'),
    measuredAt: new Date().toISOString(),
    voiceDuration: r3(dur),
    speech: [r3(speechStart), r3(speechEnd)],
    sceneBreakMinSilence: r3(weakest),
    total,
    alpha: r3(alpha),
    minPaceRatio: r3(minRatio),
    holdAfterLastLine: r3(total - vo[vo.length - 1].end),
    slack: r3(slack),
    scenes: actualScenes,
    segments,
    vo,
    timemap,
  };
  fs.writeFileSync(path.join(FILM, 'assets', 'voice-fit.json'), JSON.stringify(fit, null, 2));
  process.stdout.write(
    `${report.join('\n')}\nvoix ${dur.toFixed(2)} s (parole ${speechStart.toFixed(2)}–${speechEnd.toFixed(2)} s) ; plus court silence entre scènes ${weakest.toFixed(2)} s\n` +
      `scènes : ${actualScenes.map((s) => `${s.id} ${s.start}–${s.end}`).join(' · ')}\n` +
      `resserrement alpha ${alpha.toFixed(3)} ; rythme minimal ${minRatio.toFixed(2)} × le prévu ; tenue finale ${(total - vo[vo.length - 1].end).toFixed(2)} s\n`,
  );
}

try {
  main();
} catch (e) {
  process.stderr.write(`ÉCHEC : ${e.message}\n`);
  process.exit(1);
}
