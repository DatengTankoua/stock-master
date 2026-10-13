/**
 * 1-22C — Contrôle du `JWT_SECRET` avec la MÊME règle que le démarrage de
 * production (`jwtSecretRejection`, appelée par `validateEnvironment`).
 *
 *   node /app/api/dist/migrations/check-jwt-secret.js
 *
 * N'importe pas `AppModule` : aucune connexion, aucun démarrage, aucune
 * lecture de fichier `.env`. Seule la variable `JWT_SECRET` de
 * l'environnement est lue, et la règle est appliquée quel que soit
 * `NODE_ENV`. Sortie : « conforme » (code 0) ou la raison du refus (code 1),
 * jamais la valeur ni sa longueur.
 */
import { jwtSecretRejection } from '../common/config/jwt-secret-policy';

export interface JwtSecretCheck {
  ok: boolean;
  message: string;
}

export function checkJwtSecret(env: NodeJS.ProcessEnv): JwtSecretCheck {
  const reason = jwtSecretRejection(env.JWT_SECRET);
  return reason === null
    ? {
        ok: true,
        message: 'JWT_SECRET conforme à la politique de production (1-22C).',
      }
    : { ok: false, message: `JWT_SECRET refusé en production : ${reason}.` };
}

if (require.main === module) {
  const result = checkJwtSecret(process.env);
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
