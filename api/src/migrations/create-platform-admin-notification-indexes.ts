/**
 * Notifications internes de l'administration — migration d'INDEX
 * idempotente : aucune donnée lue ni écrite, AUCUNE notification créée
 * (aucun événement historique), aucune capacité attribuée.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:platform-admin-notification-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-platform-admin-notification-indexes.js
 * Vérification en LECTURE SEULE des index requis : ajouter `--check`.
 *
 * Lancée par `migrate:predeploy`. Rejouable sans effet ; échoue (code 1)
 * sans rien écraser si un index homonyme diffère. Sans les index requis,
 * seules les notifications de l'administration sont indisponibles (503,
 * collecte suspendue) : le reste de l'administration et les commerces ne
 * sont pas affectés. Ne journalise JAMAIS l'URI.
 */
import { createConnection } from 'mongoose';
import {
  checkPlatformAdminNotificationIndexes,
  ensurePlatformAdminNotificationIndexes,
} from '../platform-admin/platform-admin-notification-indexes';

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
      const problems = await checkPlatformAdminNotificationIndexes(connection);
      if (problems.length > 0) {
        console.error(
          `Notifications de l'administration : ${problems.join(', ')} (lecture seule).`,
        );
        process.exitCode = 1;
      } else {
        console.log(
          "Notifications de l'administration : tous les index requis sont présents (lecture seule).",
        );
      }
      return;
    }
    const { created, present } =
      await ensurePlatformAdminNotificationIndexes(connection);
    console.log(
      `Notifications de l'administration : ${created.length} index créé(s), ${present.length} déjà présent(s).`,
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration des index des notifications de l’administration échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
