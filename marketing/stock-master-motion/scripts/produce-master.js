#!/usr/bin/env node
/**
 * Lot 1-23A — Production du master à réception de la voix Gemini (prise complète).
 *
 *   node scripts/produce-master.js [film/assets/audio/voice/voiceover-fr.wav]
 *
 * 1. fit-voice : mesure et recalage (échec explicite si la voix ne tient pas dans 90 s) ;
 * 2. sync-cues --mode=master, rendu → renders/master.mp4 ;
 * 3. sync-cues --mode=master-subtitled, rendu → renders/master-sous-titres.mp4 ;
 * 4. deliver : masters normalisés, copies de partage, miniature (exports/master/) ;
 * 5. contrôles : check_av.py (synchronisation et niveaux), check_frames.py (toutes les images) ;
 * 6. retour au mode animatic (le montage reste recalé sur la voix).
 * Le SRT synchronisé est écrit dans voice/stock-master-fr.srt et copié dans exports/master/.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const voice = path.resolve(process.argv[2] || path.join(ROOT, 'film', 'assets', 'audio', 'voice', 'voiceover-fr.wav'));
const PY = path.join(process.env.LOCALAPPDATA || '', 'StockMasterMotion23A', 'tools', 'venv', 'Scripts', 'python.exe');
const RENDERS = path.join(ROOT, 'exports', 'renders');
const OUT = path.join(ROOT, 'exports', 'master');

function step(label, cmd, args, opts = {}) {
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`Étape échouée : ${label}`);
}
const node = (script, ...a) => [process.execPath, [path.join('scripts', script), ...a]];
const render = (name) =>
  node('hf.js', 'render', '--fps', '30', '--quality', 'looks', '--resolution', 'landscape', '--workers', '4', '-o', path.join(RENDERS, name));

fs.mkdirSync(RENDERS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(voice)) throw new Error(`Voix absente : ${voice}`);
step('recalage sur la voix', ...node('fit-voice.js', voice));
step('montage : master', ...node('sync-cues.js', '--mode=master'));
step('rendu : master', ...render('master.mp4'));
step('montage : master sous-titré', ...node('sync-cues.js', '--mode=master-subtitled'));
step('rendu : master sous-titré', ...render('master-sous-titres.mp4'));
step('livrables', ...node('deliver.js', path.join(RENDERS, 'master.mp4'), path.join(RENDERS, 'master-sous-titres.mp4'), '--out=exports/master'));
fs.copyFileSync(path.join(ROOT, 'voice', 'stock-master-fr.srt'), path.join(OUT, 'stock-master-fr.srt'));
for (const f of ['stock-master-1920x1080.mp4', 'stock-master-sous-titres-partage-1280x720.mp4']) {
  step(`contrôle son : ${f}`, PY, ['-I', path.join('scripts', 'check_av.py'), path.join(OUT, f)]);
}
step('contrôle images : master sous-titré', PY, ['-I', path.join('scripts', 'check_frames.py'), path.join(OUT, 'stock-master-sous-titres-1920x1080.mp4')]);
step('retour au mode animatic', ...node('sync-cues.js', '--mode=animatic'));
process.stdout.write(`\nLivrables : ${OUT}\n`);
