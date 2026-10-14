import type { ConfigModuleOptions, ConfigService } from '@nestjs/config';
import type { MongooseModuleOptions } from '@nestjs/mongoose';
import { validateEnvironment } from './jwt-secret-policy';

/**
 * 1-22D.1 — Configuration et connexion d'`AppModule` (API, CLI).
 *
 * Isolées dans ce module pour que le dispositif e2e les REMPLACE
 * (`test/jest-e2e.json`, `moduleNameMapper` → `test/e2e/e2e-app-config.ts`) :
 * aucun `.env` lu, environnement lu au démarrage de chaque application de
 * test, URI vérifiée par la garde avant toute connexion.
 * Production : comportement inchangé (`.env` puis environnement du
 * processus, figés et validés au chargement, `JWT_SECRET` compris).
 */
export const E2E_APP_CONFIG = false;

export const APP_CONFIG_OPTIONS: ConfigModuleOptions = {
  isGlobal: true,
  validate: validateEnvironment,
};

export function appMongooseOptions(
  config: ConfigService,
): MongooseModuleOptions {
  return { uri: config.get<string>('MONGODB_URI') };
}
