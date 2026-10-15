#!/usr/bin/env node
/**
 * Lot 1-23A — Applique le minutage au montage (film/index.html) et écrit les fichiers dérivés.
 *
 * Sources : film/assets/cues.js (minutage PRÉVU, immuable) et, si présent et si la voix existe,
 * film/assets/voice-fit.json (recalage sur la voix réelle, `scripts/fit-voice.js`).
 * Écrit :
 * - film/assets/timing.js : correspondance prévu → réel, répliques réelles, sous-titres ;
 * - film/assets/mode.js   : animatic | master | master-subtitled (`--mode=`) ;
 * - film/assets/facts.js  : chiffres réels du tournage (capture-checks.json) ;
 * - dans index.html : fenêtres des scènes (d'après `data-plan`), voix (un clip par phrase),
 *   musique atténuée sous la voix, effets sonores ;
 * - voice/stock-master-fr.srt quand la voix réelle est intégrée.
 * Usage : node scripts/sync-cues.js [--mode=animatic|master|master-subtitled] [--planned] [--no-label]
 *   --no-label : animatique sans l'étiquette « ANIMATIQUE · sans voix off finale ».
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILM = path.join(ROOT, 'film');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const MODE = opt('mode', 'animatic');
if (!['animatic', 'master', 'master-subtitled'].includes(MODE)) throw new Error(`Mode inconnu : ${MODE}`);
const r3 = (x) => Math.round(x * 1000) / 1000;
const read = (p) => fs.readFileSync(path.join(FILM, p), 'utf8');

function loadCues() {
  const sb = { window: {} };
  vm.runInNewContext(read('assets/cues.js'), sb);
  return sb.window.FILM_CUES;
}

function loadFit() {
  if (args.includes('--planned')) return null;
  const f = path.join(FILM, 'assets', 'voice-fit.json');
  if (!fs.existsSync(f)) return null;
  const fit = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!fs.existsSync(path.join(FILM, fit.file))) return null;
  return fit;
}

const mapper = (timemap) => (t) => {
  if (!timemap.length) return t;
  if (t <= timemap[0][0]) return t + (timemap[0][1] - timemap[0][0]);
  for (let i = 1; i < timemap.length; i++) {
    const [a0, b0] = timemap[i - 1], [a1, b1] = timemap[i];
    if (t <= a1) return b0 + ((t - a0) * (b1 - b0)) / (a1 - a0);
  }
  const [aN, bN] = timemap[timemap.length - 1];
  return t + (bN - aN);
};

// ── Sous-titres : 2 lignes de 42 caractères au plus, découpe aux mots ─────────
const MAX_LINE = 42;
// Typographie française : espace insécable avant ? ! : ; pour ne jamais isoler ces signes.
const nbsp = (t) => t.replace(/ ([?!:;»])/g, ' $1').replace(/« /g, '« ');
const len = (t) => t.length;
// Deux lignes équilibrées (coupure aux mots, bonus après ponctuation).
function balance(text) {
  if (len(text) <= MAX_LINE) return [text];
  const w = text.split(' ');
  let best = null;
  for (let i = 1; i < w.length; i++) {
    const l1 = w.slice(0, i).join(' '), l2 = w.slice(i).join(' ');
    if (len(l1) > MAX_LINE || len(l2) > MAX_LINE) continue;
    const score = Math.max(len(l1), len(l2)) - (/[,:;…]$/.test(l1) ? 6 : 0);
    if (!best || score < best.score) best = { score, lines: [l1, l2] };
  }
  return best ? best.lines : null;
}
// Blocs de 2 lignes au plus : découpe d'abord aux ponctuations, puis aux mots.
function chunks(text) {
  const t = nbsp(text);
  const direct = balance(t);
  if (direct) return [direct];
  const parts = t.split(/(?<=[,:;…])\s+/);
  const out = [];
  let cur = '';
  for (const part of parts) {
    const next = cur ? `${cur} ${part}` : part;
    if (cur && !balance(next)) { out.push(cur); cur = part; } else cur = next;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => {
    const b2 = balance(c);
    if (b2) return [b2];
    // Dernier recours : coupure aux mots par blocs de 2 lignes.
    const words = c.split(' '); const res = []; let l = '';
    for (const x of words) { if (l && len(l + ' ' + x) > MAX_LINE) { res.push(l); l = x; } else l = l ? `${l} ${x}` : x; }
    if (l) res.push(l);
    const blocks = []; for (let i = 0; i < res.length; i += 2) blocks.push(res.slice(i, i + 2));
    return blocks;
  });
}
function subtitles(vo) {
  const out = [];
  for (const v of vo) {
    const blocks = chunks(v.screen || v.text);
    const chars = blocks.map((c) => c.join(' ').length);
    const total = chars.reduce((a, b) => a + b, 0);
    let t = v.start;
    const span = v.end - v.start;
    blocks.forEach((c, i) => {
      const d = (span * chars[i]) / total;
      out.push({ start: r3(t), end: r3(t + d), lines: c });
      t += d;
    });
  }
  // Durée minimale 1 s et petit écart entre deux sous-titres.
  for (let i = 0; i < out.length; i++) {
    out[i].end = Math.max(out[i].end, out[i].start + 1.0);
    if (out[i + 1]) out[i].end = r3(Math.min(out[i].end + 0.25, out[i + 1].start - 0.04));
    else out[i].end = r3(out[i].end + 0.4);
  }
  return out;
}
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// ── Audio ─────────────────────────────────────────────────────────────────────
// Musique (piste à environ −10 LUFS) nettement sous la voix.
const MUSIC = { open: 0.22, gap: 0.16, under: 0.07, tail: 0.2 };
function duckLane(vo, duration) {
  const pts = [{ t: 0, v: MUSIC.open }];
  for (const c of vo) {
    const a = Math.max(0, c.start - 0.35);
    const b = c.end + 0.3;
    pts.push({ t: r3(a), v: MUSIC.gap }, { t: r3(a + 0.25), v: MUSIC.under }, { t: r3(b), v: MUSIC.under }, { t: r3(b + 0.4), v: MUSIC.gap });
  }
  pts.push({ t: r3(duration - 4), v: MUSIC.tail });
  pts.sort((x, y) => x.t - y.t);
  const out = [];
  for (const p of pts) {
    if (out.length && p.t <= out[out.length - 1].t) p.t = r3(out[out.length - 1].t + 0.01);
    out.push(p);
  }
  return { version: 1, lanes: [{ target: 'volume', points: out }] };
}

function audioBlock(cues, timing, fit, T) {
  const lines = [];
  lines.push(
    `  <audio id="bgm" class="clip" src="assets/audio/music/afro-house-455843.mp3" data-start="0" data-duration="${cues.duration}" data-track-index="10" data-volume="1" data-fade-in="1" data-fade-out="3.5" data-automation='${JSON.stringify(duckLane(timing.vo, cues.duration))}'></audio>`,
  );
  cues.sfx.forEach((s, i) => {
    lines.push(
      `  <audio id="sfx-${i}" class="clip" src="assets/audio/sfx/${s.file}.wav" data-start="${r3(T(s.at))}" data-duration="1.2" data-track-index="${11 + (i % 3)}" data-volume="${s.v}"></audio>`,
    );
  });
  if (fit) {
    fit.segments.forEach((g, i) => {
      lines.push(
        `  <audio id="vo-${i}" class="clip" src="${fit.file}" data-start="${g.at}" data-duration="${g.duration}" data-media-start="${g.mediaStart}" data-track-index="${7 + (i % 2)}" data-volume="${fit.voiceGain || 1}"></audio>`,
      );
    });
  }
  return lines.join('\n');
}

function main() {
  const cues = loadCues();
  const fit = loadFit();
  const timemap = fit ? fit.timemap : [];
  const T = mapper(timemap);
  const vo = fit
    ? fit.vo
    : cues.vo.map((v) => ({ ...v, plannedStart: v.start, plannedEnd: v.end }));
  const subs = subtitles(vo);
  const timing = { status: fit ? 'voice' : 'planned', voiceFile: fit ? fit.file : null, timemap, vo, subs };

  let html = read('index.html');
  // Fenêtres des scènes : `data-plan="début,durée"` prévu → instants réels.
  html = html.replace(/<div id="(s\d)" class="([^"]*\bscene\b[^"]*)"([^>]*?)data-start="([\d.]+)" data-duration="([\d.]+)"([^>]*)>/g, (m, id, cls, pre, st, du, post) => {
    const plan = /data-plan="([\d.]+),([\d.]+)"/.exec(m);
    const ps = plan ? Number(plan[1]) : Number(st);
    const pd = plan ? Number(plan[2]) : Number(du);
    const a = Math.max(0, T(ps));
    const b = Math.min(cues.duration, T(ps + pd));
    const keep = (pre + post).replace(/\s*data-plan="[^"]*"/, '');
    return `<div id="${id}" class="${cls}"${pre.replace(/\s*data-plan="[^"]*"/, '')}data-start="${r3(a)}" data-duration="${r3(b - a)}" data-plan="${ps},${pd}"${post.replace(/\s*data-plan="[^"]*"/, '')}>`.replace(/\s+>/, '>');
  });
  const re = /(<!-- AUDIO:BEGIN -->)[\s\S]*?(<!-- AUDIO:END -->)/;
  if (!re.test(html)) throw new Error('Marqueurs AUDIO absents de index.html');
  html = html.replace(re, `$1\n${audioBlock(cues, timing, fit, T)}\n  $2`);
  fs.writeFileSync(path.join(FILM, 'index.html'), html);

  fs.writeFileSync(
    path.join(FILM, 'assets', 'timing.js'),
    `/* Généré par scripts/sync-cues.js (${timing.status}). Ne pas modifier à la main. */\nwindow.FILM_TIMING = ${JSON.stringify(timing, null, 1)};\n`,
  );
  fs.writeFileSync(
    path.join(FILM, 'assets', 'mode.js'),
    `/* Généré par scripts/sync-cues.js : animatic | master | master-subtitled */\nwindow.FILM_MODE = ${JSON.stringify(MODE)};\nwindow.FILM_LABEL = ${!args.includes('--no-label')};\n`,
  );
  const checks = JSON.parse(read('assets/captures/capture-checks.json'));
  fs.writeFileSync(
    path.join(FILM, 'assets', 'facts.js'),
    `/* Généré par scripts/sync-cues.js depuis capture-checks.json (chiffres réels du tournage). */\nwindow.FILM_FACTS = ${JSON.stringify({ ...checks.facts, exportFile: checks.export && checks.export.file }, null, 2)};\n`,
  );
  if (fit) {
    const srt = subs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.lines.join('\n')}\n`).join('\n');
    fs.writeFileSync(path.join(ROOT, 'voice', 'stock-master-fr.srt'), srt);
  }
  process.stdout.write(
    `mode ${MODE} ; minutage ${timing.status} ; ${vo.length} répliques, ${subs.length} sous-titres ; ${fit ? `${fit.segments.length} clips de voix` : 'aucune voix'}\n`,
  );
}

main();
