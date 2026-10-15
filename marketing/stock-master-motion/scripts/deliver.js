#!/usr/bin/env node
/**
 * Lot 1-23A — Livrables à partir des rendus HyperFrames (aucune retouche d'image).
 *
 *   node scripts/deliver.js <rendu master.mp4> <rendu master sous-titré.mp4> [--out=exports/master] [--thumb=3.2]
 *
 * - Masters 1920 × 1080 : vidéo copiée telle quelle (H.264 du rendu), son normalisé en deux
 *   passes (EBU R128 : −14 LUFS, crête vraie −1,5 dBTP, usage réseaux sociaux), AAC 192 kb/s,
 *   index en tête (lecture web et téléphone).
 * - Copies de partage 1280 × 720 (WhatsApp, réseaux) : H.264 Main, deux passes visant ≤ 15 Mo,
 *   AAC 128 kb/s, index en tête ; une propre et une sous-titrée.
 * - Miniature 1280 × 720 (JPEG) depuis le master propre.
 * - Rapport ffprobe + mesures (deliver-report.json).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(process.env.LOCALAPPDATA || '', 'StockMasterMotion23A', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin');
const tool = (n) => (fs.existsSync(path.join(BIN, `${n}.exe`)) ? path.join(BIN, `${n}.exe`) : n);
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const [clean, subbed] = args.filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));
if (!clean || !subbed) throw new Error('Usage : deliver.js <master.mp4> <master-sous-titre.mp4>');
const OUT = path.resolve(ROOT, opt('out', 'exports/master'));
fs.mkdirSync(OUT, { recursive: true });

function run(bin, a) {
  const r = spawnSync(tool(bin), a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} a échoué :\n${(r.stderr || '').slice(-2000)}`);
  return r;
}

const LN = 'I=-14:TP=-1.5:LRA=11';
function loudnormParams(src) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', `loudnorm=${LN}:print_format=json`, '-f', 'null', '-']);
  const m = /\{[\s\S]*?"target_offset"[\s\S]*?\}/.exec(r.stderr);
  return JSON.parse(m[0]);
}
const lnFilter = (p) =>
  `loudnorm=${LN}:measured_I=${p.input_i}:measured_TP=${p.input_tp}:measured_LRA=${p.input_lra}:measured_thresh=${p.input_thresh}:offset=${p.target_offset}:linear=true,` +
  // Limiteur de sécurité (−2 dBFS) : l'encodage AAC peut faire dépasser la crête visée.
  'alimiter=limit=0.79:attack=5:release=50:level=false';

function master(src, name) {
  const p = loudnormParams(src);
  const out = path.join(OUT, name);
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', lnFilter(p),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);
  return out;
}

function share(src, name) {
  const out = path.join(OUT, name);
  const p = loudnormParams(src);
  const passlog = path.join(OUT, `.${name}.passlog`);
  const v = ['-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-level', '3.1',
    '-pix_fmt', 'yuv420p', '-b:v', '1150k', '-maxrate', '1600k', '-bufsize', '3000k', '-r', '30'];
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, ...v, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'mp4', process.platform === 'win32' ? 'NUL' : '/dev/null']);
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, ...v, '-pass', '2', '-passlogfile', passlog, '-af', lnFilter(p),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', out]);
  for (const f of fs.readdirSync(OUT)) if (f.startsWith(`.${name}.passlog`)) fs.rmSync(path.join(OUT, f), { force: true });
  return out;
}

function probe(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size,bit_rate:stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,nb_frames,sample_rate,channels',
    '-of', 'json', file]).stdout);
  const e = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']).stderr;
  const head = fs.readFileSync(file).subarray(0, 1 << 20).toString('latin1');
  return {
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    sizeMB: Math.round((Number(j.format.size) / 1048576) * 100) / 100,
    duration: Number(j.format.duration),
    streams: j.streams,
    integratedLufs: Number((/I:\s+(-?[\d.]+) LUFS/.exec(e) || [])[1]),
    truePeakDbfs: Number((/Peak:\s+(-?[\d.]+) dBFS/.exec(e) || [])[1]),
    moovFirst: head.indexOf('moov') !== -1 && (head.indexOf('mdat') === -1 || head.indexOf('moov') < head.indexOf('mdat')),
  };
}

const outputs = [
  master(clean, 'stock-master-1920x1080.mp4'),
  master(subbed, 'stock-master-sous-titres-1920x1080.mp4'),
  share(subbed, 'stock-master-sous-titres-partage-1280x720.mp4'),
  share(clean, 'stock-master-partage-1280x720.mp4'),
];
const thumb = path.join(OUT, 'stock-master-miniature-1280x720.jpg');
run('ffmpeg', ['-v', 'error', '-y', '-ss', opt('thumb', '3.2'), '-i', clean, '-frames:v', '1', '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', thumb]);
const report = { at: new Date().toISOString(), outputs: outputs.map(probe), thumbnail: path.relative(ROOT, thumb).replace(/\\/g, '/') };
fs.writeFileSync(path.join(OUT, 'deliver-report.json'), JSON.stringify(report, null, 2));
for (const o of report.outputs) {
  const v = o.streams.find((s) => s.width);
  process.stdout.write(`${o.file} : ${o.duration.toFixed(3)} s, ${v.width}×${v.height} ${v.r_frame_rate} ${v.profile}, ${o.sizeMB} Mo, ${o.integratedLufs} LUFS, crête ${o.truePeakDbfs} dBFS, index en tête ${o.moovFirst}\n`);
}
