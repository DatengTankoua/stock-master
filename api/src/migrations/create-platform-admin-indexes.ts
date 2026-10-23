/**
 * Administration de la plateforme — migration d'INDEX idempotente (aucune
 * donnée lue ni écrite, aucun accès accordé) : index des collections
 * `platform_admin_*` et index `createdAt_-1` de `organizations`.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:platform-admin-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-platform-admin-indexes.js
 * Vérification en LECTURE SEULE : ajouter `--check` (sortie 1 si absent).
 *
 * Lancée par `migrate:predeploy`. Rejouable sans effet ; échoue (code 1)
 * sans rien écraser si un index homonyme diffère. Sans ces index, l'espace
 * d'administration reste fermé (503) ; les commerces ne sont pas affectés.
 * Ne journalise JAMAIS l'URI.
 */
import { createConnection } from 'mongoose';
import {
  checkPlatformAdminIndexes,
  ensurePlatformAdminIndexes,
} from '../platform-admin/platform-admin-indexes';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const checkOnly = process.argv.includes('--check');
  const connection = await createConnection(uri).asPromise();
  try {
    if (checkOnly) {
      const problems = await checkPlatformAdminIndexes(connection);
      if (problems.length > 0) {
        console.error(
          `Administration : ${problems.join(', ')} (lecture seule).`,
        );
        process.exitCode = 1;
      } else {
        console.log(
          'Administration : tous les index sont présents (lecture seule).',
        );
      }
      return;
    }
    const { created, present } = await ensurePlatformAdminIndexes(connection);
    console.log(
      `Administration : ${created.length} index créé(s), ${present.length} déjà présent(s).`,
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des index de l’administration échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
