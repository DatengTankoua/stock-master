import type { ConfigModuleOptions, ConfigService } from '@nestjs/config';
import type { MongooseModuleOptions } from '@nestjs/mongoose';
import { validateEnvironment } from '../../src/common/config/jwt-secret-policy';
import { assertEphemeralUri } from './ephemeral-mongodb';

/**
 * 1-22D.1 — Remplace `src/common/config/app-config.ts` dans TOUTES les
 * suites e2e (`jest-e2e.json`, `moduleNameMapper`), quel que soit le
 * répertoire de lancement :
 * - aucun fichier `.env` lu (`ignoreEnvFile`) ;
 * - `JWT_SECRET` validé comme en production (`validateEnvironment`), mais
 *   AUCUNE copie figée de l'environnement : `ConfigService` lit
 *   `process.env` à la création de chaque application, après l'installation
 *   de l'URI temporaire par la suite (`beforeAll`) ;
 * - URI EFFECTIVEMENT transmise au connecteur vérifiée par la garde e2e
 *   avant toute connexion : sinon, échec sans connexion ni écriture.
 */
export const E2E_APP_CONFIG = true;

export const APP_CONFIG_OPTIONS: ConfigModuleOptions = {
  isGlobal: true,
  ignoreEnvFile: true,
  validate: (config: Record<string, unknown>) => {
    validateEnvironment(config);
    return {};
  },
};

export function appMongooseOptions(
  config: ConfigService,
): MongooseModuleOptions {
  const uri = config.get<string>('MONGODB_URI');
  if (!uri) throw new Error('E2E refused: MONGODB_URI not set by the suite.');
  return { uri: assertEphemeralUri(uri) };
}
