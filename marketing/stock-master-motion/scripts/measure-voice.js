#!/usr/bin/env node
/**
 * Lot 1-23A — Mesure de la voix off livrée (aucune modification du fichier).
 *
 * - durée, fréquence, canaux, niveau intégré (ffprobe, ffmpeg ebur128) ;
 * - silences (ffmpeg silencedetect) ; les silences les plus longs séparent les scènes
 *   de la prise complète (`<long pause>`).
 * Sortie : film/assets/audio/voice/<fichier>.measure.json, résumé à l'écran.
 * Usage : node scripts/measure-voice.js [fichier] [--noise=-38dB] [--min=0.55]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VOICE = path.resolve(__dirname, '..', 'film', 'assets', 'audio', 'voice');
const BIN = path.join(process.env.LOCALAPPDATA || '', 'StockMasterMotion23A', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin');
const tool = (n) => (fs.existsSync(path.join(BIN, `${n}.exe`)) ? path.join(BIN, `${n}.exe`) : n);

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split('=')[1];
const file = path.resolve(VOICE, args.find((a) => !a.startsWith('--')) || 'voiceover-fr.wav');
if (!fs.existsSync(file)) throw new Error(`Fichier absent : ${file}`);

const probe = JSON.parse(
  spawnSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels,codec_name', '-of', 'json', file], { encoding: 'utf8' }).stdout,
);
const err = spawnSync(
  tool('ffmpeg'),
  ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${opt('noise', '-38dB')}:d=${opt('min', '0.55')},ebur128=framelog=quiet`, '-f', 'null', '-'],
  { encoding: 'utf8' },
).stderr;
const silences = [];
let start = null;
for (const line of err.split('\n')) {
  const s = /silence_start: ([\d.]+)/.exec(line);
  const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
  if (s) start = Number(s[1]);
  if (e) silences.push({ start, end: Number(e[1]), duration: Number(e[2]) });
}
const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(err);
const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(err);
const result = {
  file: path.basename(file),
  duration: Number(probe.format.duration),
  stream: probe.streams[0],
  integratedLufs: integrated ? Number(integrated[1]) : null,
  truePeakDbfs: peak ? Number(peak[1]) : null,
  silences,
  sceneBreaks: [...silences].sort((a, b) => b.duration - a.duration).slice(0, 6).sort((a, b) => a.start - b.start),
};
fs.writeFileSync(file.replace(/\.wav$/i, '.measure.json'), JSON.stringify(result, null, 2));
process.stdout.write(
  `${result.file} : ${result.duration.toFixed(2)} s, ${result.integratedLufs} LUFS ; ${silences.length} silences ; coupures de scène probables : ${result.sceneBreaks.map((b) => `${b.start.toFixed(2)}–${b.end.toFixed(2)}`).join(', ')}\n`,
);
