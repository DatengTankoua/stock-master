/**
 * 1-16C.2 — Migrations d'index à exécuter AVANT l'activation d'une version
 * (Railway « Pre-deploy Command »), en une seule commande sans shell :
 *
 *   node /app/api/dist/migrations/predeploy-migrations.js
 *
 * Lance, dans l'ordre et dans des processus séparés, les migrations d'index
 * EXISTANTES (chacune idempotente : no-op si l'index exact existe, échec
 * sans rien écraser sinon), puis la garde du suivi par lots et la
 * préparation des alertes de péremption (aucune activation). S'arrête au premier échec avec le code 1 : sur
 * Railway, le déploiement ne se poursuit pas et la version en service reste
 * active. Aucun outil opérateur (`subscription:grant`, rapprochement,
 * rattrapage d'historique) n'est lancé ici.
 *
 * Chemin absolu recommandé : le dossier de lancement n'a pas d'effet (les
 * scripts résolvent leurs modules depuis leur propre emplacement). Sont lus
 * (variables du service, jamais journalisés) : `NODE_ENV` et `JWT_SECRET`
 * (1-22C, contrôle préalable en production), puis `MONGODB_URI`.
 * `/app/api` suppose l'image `api/Dockerfile` : à adapter au constructeur
 * réel du service.
 *
 * Échec partiel : les index créés par les étapes précédentes RESTENT en
 * place ; rien n'est annulé ni supprimé automatiquement. Une relance après
 * correction est sans effet sur les étapes déjà faites.
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  JwtSecretPolicyError,
  validateEnvironment,
} from '../common/config/jwt-secret-policy';

/** Ordre et rôle de chaque migration (rapports des lots cités). */
export const PREDEPLOY_MIGRATIONS: readonly string[] = Object.freeze([
  // 1-11C.1 : vérifié au démarrage en production.
  'create-sale-operations-index.js',
  // 1-14B : vérifié au démarrage en production.
  'create-subscription-period-indexes.js',
  // 1-14D.2B : vérifié au démarrage en production.
  'create-subscription-payment-indexes.js',
  // 1-14D.2G : requis par le CLI de rapprochement (`--apply`).
  'create-subscription-payment-reconciliation-indexes.js',
  // 1-16A : vérifié au démarrage en production (même push désactivé).
  'create-push-notification-indexes.js',
  // 1-16C.1 : TTL de 30 jours du registre des demandes d'assistance.
  'create-support-request-indexes.js',
  // 1-16C.2 : collections et index des preuves d'acceptation.
  'create-legal-acceptance-indexes.js',
  // 1-18B : index partiel du lien de création de compte d'un invité.
  'create-invitation-account-token-index.js',
  // 1-18C : TTL des plafonds persistants (comptes, destinataires).
  'create-rate-limit-indexes.js',
  // 1-20E : historique paginé des ventes (performance, non bloquant).
  'create-sale-history-indexes.js',
  // 1-20F : liste paginée des produits (performance, non bloquant).
  'create-product-page-indexes.js',
  // Administration de la plateforme : index seuls (espace fermé sans eux).
  // N'accorde JAMAIS d'accès : l'attribution reste une commande opérateur.
  'create-platform-admin-indexes.js',
  // Lots A à C : garde du suivi par lots (= migrate:product-batches --
  // --install --apply). N'active rien : drapeaux et portées séparés.
  'install-product-batches.js',
  // Lot C : index et planification initiale des alertes de péremption
  // (= migrate:expiry-alerts -- --apply), après la garde.
  'install-expiry-alerts.js',
]);

/**
 * 1-22C — politique du secret applicatif, vérifiée EN PREMIER : avant la
 * lecture de `MONGODB_URI`, toute connexion et toute migration. Même règle
 * que le démarrage de l'API (`validateEnvironment`) : appliquée seulement si
 * `NODE_ENV=production` (migrations locales et tests inchangés). Seul
 * l'environnement du processus est lu (aucun fichier `.env`).
 */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  try {
    validateEnvironment(env);
  } catch (error) {
    console.error(
      error instanceof JwtSecretPolicyError
        ? `[pré-déploiement] ${error.message}`
        : '[pré-déploiement] JWT_SECRET : validation impossible.',
    );
    console.error('[pré-déploiement] aucune migration exécutée.');
    return 1;
  }
  if (!env.MONGODB_URI) {
    console.error('MONGODB_URI requis.');
    return 1;
  }
  for (const file of PREDEPLOY_MIGRATIONS) {
    console.log(`[pré-déploiement] ${file}`);
    const result = spawnSync(process.execPath, [join(__dirname, file)], {
      stdio: 'inherit',
      env,
    });
    if (result.status !== 0) {
      console.error(
        `[pré-déploiement] échec de ${file} : déploiement à interrompre.`,
      );
      return 1;
    }
  }
  console.log('[pré-déploiement] toutes les migrations sont appliquées.');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}
