#!/usr/bin/env node
/**
 * Lot 1-23A — Point d'entrée de la démonstration RoyalVibe (profil de recette `motion-23a`).
 *
 *   node demo/motion-demo.js start     pile locale (premier plan ; Ctrl+C ou `stop` pour arrêter)
 *   node demo/motion-demo.js status    état de la pile
 *   node demo/motion-demo.js stop      arrêt (données conservées)
 *   node demo/motion-demo.js seed      peuplement de RoyalVibe (base vierge uniquement)
 *   node demo/motion-demo.js capture [--only=catalogue,vente,equipe,horsligne,analyse]
 *   node demo/motion-demo.js reset     efface la base et le stockage de la démonstration (pile arrêtée)
 *
 * Toutes les cibles sont celles du profil (127.0.0.1, MongoDB 27230, base stockmaster_motion_23a) ;
 * la garde de la recette refuse toute autre URI.
 */
'use strict';

process.env.RECIPE_PROFILE = 'motion-23a';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../..');
const RECIPE = path.join(REPO, 'api', 'test', 'recipe', 'recipe.js');
const C = require(path.join(REPO, 'api', 'test', 'recipe', 'recipe-common'));

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], {
    stdio: 'inherit',
    cwd: REPO,
    env: { ...process.env, RECIPE_PROFILE: 'motion-23a' },
  });
  process.exitCode = result.status ?? 1;
}

/** Réinitialisation : uniquement le dossier persistant du profil, pile arrêtée. */
function reset() {
  const state = C.readState();
  if (state && C.isAlive(state.launcherPid))
    throw new Error('Pile en cours : arrêter d’abord (motion-demo.js stop).');
  const root = path.resolve(C.PERSISTENT.root);
  const expected = path.resolve(
    process.env.LOCALAPPDATA || os.homedir(),
    'StockMasterMotion23A',
    'demo',
  );
  if (root !== expected || path.basename(root) !== 'demo')
    throw new Error(`Chemin inattendu, rien n'est supprimé : ${root}`);
  for (const entry of ['mongo', 'storage', 'exports', 'seed-summary.json']) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  process.stdout.write(`Démonstration réinitialisée : ${root}\n`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'start':
    run(RECIPE, ['start', '--provider=saspay', ...rest]);
    break;
  case 'status':
  case 'stop':
    run(RECIPE, [command]);
    break;
  case 'seed':
    run(path.join(__dirname, 'seed-royalvibe.js'), rest);
    break;
  case 'capture':
    run(path.join(__dirname, 'capture.js'), rest);
    break;
  case 'reset':
    reset();
    break;
  default:
    process.stdout.write(
      'Usage : node demo/motion-demo.js start|status|stop|seed|capture [--only=…]|reset\n',
    );
}
