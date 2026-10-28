/**
 * Migration idempotente : collections `marketing_consents`,
 * `marketing_consent_events`, `marketing_consent_wordings` et index de
 * lecture `{ userId, at }` des preuves.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:marketing-consent-indexes
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/create-marketing-consent-indexes.js
 * Vérification en LECTURE SEULE : ajouter `--check` (sortie 1 si absent).
 *
 * - Rejouable sans effet : no-op si l'index exact existe déjà.
 * - Échoue (code 1) si un index homonyme a d'autres options : rien n'est
 *   écrasé ni supprimé. Aucune donnée lue ni écrite : aucun utilisateur
 *   n'est inscrit aux e-mails promotionnels.
 * - Ne journalise JAMAIS l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  MARKETING_CONSENT_EVENTS_INDEX_NAME,
  checkMarketingConsentIndexes,
  ensureMarketingConsentIndexes,
} from '../marketing-consent/marketing-consent-indexes';

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
      const problem = await checkMarketingConsentIndexes(connection);
      if (problem) {
        console.error(`marketing_consent_events : ${problem} (lecture seule).`);
        process.exitCode = 1;
      } else {
        console.log(
          `marketing_consent_events : index ${MARKETING_CONSENT_EVENTS_INDEX_NAME} présent (lecture seule).`,
        );
      }
      return;
    }
    const result = await ensureMarketingConsentIndexes(connection);
    console.log(
      result === 'created'
        ? 'marketing_consent_events : collections et index créés et vérifiés.'
        : 'marketing_consent_events : index déjà présent (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Migration marketing_consent échouée :',
      error instanceof Error ? error.message : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
