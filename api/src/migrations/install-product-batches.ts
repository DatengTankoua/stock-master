/**
 * Lots A à C — pré-déploiement : garde du suivi par lots, équivalent de
 * `migrate:product-batches -- --install --apply` (même fonction interne).
 *
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/install-product-batches.js
 * Lancé par `predeploy-migrations` ; la commande manuelle reste disponible
 * pour l'inventaire et le diagnostic.
 *
 * - Validateur de `products` (`remainingQuantity` = total des lots, seuls les
 *   produits suivis par lots sont contraints) et index uniques des lots,
 *   opérations, demandes de régularisation, index des pertes.
 * - Idempotent et reprenable : no-op si tout est en place ; après une
 *   installation partielle, seuls les éléments manquants sont ajoutés.
 * - Ne remplace JAMAIS un autre validateur ni un index homonyme différent :
 *   échec (code 1), rien n'est écrasé.
 * - N'active rien, ne convertit aucun produit, ne retire aucune permission,
 *   ne crée aucune notification. Aucune opération de retour arrière.
 * Ne journalise jamais l'URI ni aucune donnée.
 */
import { createConnection } from 'mongoose';
import {
  ProductBatchGuardError,
  ensureProductBatchGuard,
} from '../products/batches/product-batch-guard';

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
    const result = await ensureProductBatchGuard(connection);
    console.log(
      result === 'installed'
        ? 'Suivi par lots : garde installée et vérifiée.'
        : 'Suivi par lots : garde déjà présente (aucune modification).',
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Garde du suivi par lots échouée :',
      error instanceof ProductBatchGuardError
        ? error.message
        : error instanceof Error
          ? `${error.name}${'codeName' in error ? ` (${String(error.codeName)})` : ''}`
          : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
