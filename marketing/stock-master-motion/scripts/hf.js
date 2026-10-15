#!/usr/bin/env node
/**
 * Lot 1-23A — Lance la CLI HyperFrames du dossier marketing dans `film/`, avec :
 * - télémétrie coupée (DO_NOT_TRACK, HYPERFRAMES_NO_TELEMETRY) ;
 * - aucune clé Gemini transmise (pas d'analyse d'images payante par `snapshot`) ;
 * - ffmpeg local du lot en tête du PATH s'il existe.
 * Usage : node scripts/hf.js <commande HyperFrames> [options]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const env = { ...process.env, DO_NOT_TRACK: '1', HYPERFRAMES_NO_TELEMETRY: '1' };
delete env.GEMINI_API_KEY;
delete env.GOOGLE_API_KEY;
const ffmpeg = path.join(
  process.env.LOCALAPPDATA || '',
  'StockMasterMotion23A',
  'tools',
  'ffmpeg-9.0.2-essentials_build',
  'bin',
);
if (fs.existsSync(ffmpeg)) env.PATH = `${ffmpeg}${path.delimiter}${env.PATH || env.Path || ''}`;

const bin = path.join(ROOT, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: path.join(ROOT, 'film'),
  env,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
