/**
 * Lot C — pré-déploiement : index et planification initiale des alertes de
 * péremption, équivalent de `migrate:expiry-alerts -- --apply` (mêmes
 * fonctions internes). Après `install-product-batches.js`.
 *
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/install-expiry-alerts.js
 * Lancé par `predeploy-migrations` ; la commande manuelle reste disponible
 * pour l'inventaire et le diagnostic.
 *
 * - Index partiels `expiry_alert_due` et `expiry_alert_due_org`, vérifiés
 *   après installation (échec code 1 sinon ; un index homonyme différent
 *   n'est jamais écrasé).
 * - `expiryAlertNextOn` des cibles datées jamais planifiées, par lots,
 *   chaque écriture conditionnée à l'état lu (aucun écrasement d'une date
 *   ou d'une planification modifiée en parallèle). Reprenable.
 * - N'active rien (drapeaux et portées inchangés), ne crée aucun travail
 *   ni aucune notification, ne modifie aucun autre champ.
 * Ne journalise jamais l'URI ni aucune donnée (comptes seulement).
 */
import { createConnection } from 'mongoose';
import { describeExpiryAlertIndexProblem } from '../products/expiry/expiry-alert-index';
import { installExpiryAlerts } from './expiry-alerts';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    const { planned, skipped } = await installExpiryAlerts(connection);
    const problem = await describeExpiryAlertIndexProblem(connection);
    if (problem) {
      console.error(`Alertes de péremption : ${problem}.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Alertes de péremption : index vérifiés ; ${planned} cible(s) planifiée(s)` +
        (skipped
          ? `, ${skipped} modifiée(s) en parallèle, reprises au prochain passage.`
          : '.'),
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Alertes de péremption échouées :',
      error instanceof Error
        ? `${error.name}${'codeName' in error ? ` (${String(error.codeName)})` : ''}`
        : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
