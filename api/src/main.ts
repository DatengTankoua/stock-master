import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './events/origin.helpers';
import {
  applyTrustProxy,
  describeTrustProxySetting,
  resolveTrustProxySetting,
  trustProxyProductionWarning,
} from './common/trust-proxy';
import type { ExpressSettings } from './common/trust-proxy';
import { API_APPLICATION_OPTIONS } from './common/application-options';
import { resolveWebPushConfig } from './push/push-config';
import { startNotifications } from './push/push-bootstrap';
import { PlatformMessageDeliveryService } from './platform-admin/platform-message-delivery.service';
import { configureProcessTimeZone } from './analytics/month-range';
import { startStorageRecovery } from './storage-quota/storage-recovery';
import { startPaymentReconciliationSweep } from './subscriptions/payments/payment-reconciliation-sweep';
import { resolveTurnstileConfig } from './anti-bot/turnstile-config';
import { resolveAntiAbuseConfig } from './common/rate-limit/anti-abuse-config';
import {
  expiryAlertsEnabled,
  expiryAlertsFlagInvalid,
  expiryAlertsScope,
} from './products/expiry/expiry-alerts-config';
import type { OrganizationScope } from './common/organization-scope';

/** Portée annoncée au démarrage (jamais les identifiants eux-mêmes). */
function describeScope(scope: OrganizationScope): string {
  if (scope.kind === 'all') return 'TOUS les commerces (activation globale)';
  if (scope.kind === 'none') {
    return 'AUCUN commerce (liste de commerces absente : indiquer des identifiants ou all)';
  }
  if (scope.kind === 'invalid') {
    return 'AUCUN commerce (liste de commerces invalide)';
  }
  return `${scope.ids.size} commerce(s) pilote(s)`;
}
import {
  productBatchesEnabled,
  productBatchesFlagInvalid,
  productBatchesScope,
} from './products/batches/product-batches-config';

async function bootstrap() {
  // 1-16D : fuseau des mois (Analyse, historique exportable, bilan
  // mensuel), validé et appliqué AVANT toute création de date. Lancement
  // au Cameroun : TZ=Africa/Douala (README, variables de production).
  const timeZone = configureProcessTimeZone();
  new Logger('Bootstrap').log(`Fuseau des bornes mensuelles : ${timeZone}`);
  // CORS HTTP fermé (phase 0B.4) : la config est parsée UNE FOIS au
  // démarrage via le parser strict de 0B.3 — aucune `?? true`, aucun
  // wildcard. En production, `parseCORSOrigin` lève OriginConfigError si
  // CORS_ORIGIN est absente ou invalide => démarrage bloqué (garde
  // vérifiée E2E et par origin.helpers.spec.ts).
  const environment =
    process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const corsAllowlist = buildOriginAllowlist(
    parseCORSOrigin(process.env.CORS_ORIGIN, environment),
  );

  // Reverse proxy (0B.6, 1-14D.2E) : confiance parsée de façon STRICTE
  // avant la création de l'app. Défaut : aucun proxy approuvé (on ne se fie
  // PAS à `X-Forwarded-For`). `TRUST_PROXY_ADDRESSES` (adresses exactes des
  // proxys identifiés) ou `TRUST_PROXY_HOPS` (N sauts), jamais les deux ;
  // toute valeur invalide → erreur fatale au démarrage.
  const trustProxy = resolveTrustProxySetting(process.env);
  // 1-22C : mode journalisé ; avertissement si rien n'est approuvé en production.
  new Logger('Bootstrap').log(
    `Confiance proxy : ${describeTrustProxySetting(trustProxy)}`,
  );
  const trustProxyWarning = trustProxyProductionWarning(
    trustProxy,
    process.env.NODE_ENV,
  );
  if (trustProxyWarning) new Logger('Bootstrap').warn(trustProxyWarning);

  // 1-18C : anti-robot de l'inscription et plafonds persistants, validés
  // STRICTEMENT (valeur invalide, clé de test ou simulation en production →
  // erreur fatale). Seul le mode est journalisé, jamais le secret.
  const turnstile = resolveTurnstileConfig(process.env);
  resolveAntiAbuseConfig(process.env);
  new Logger('Bootstrap').log(
    `Anti-robot de l'inscription : ${turnstile.mode}`,
  );
  if (turnstile.mode === 'unconfigured') {
    // 1-18D : demandes de liens (réinitialisation, vérification) refusées
    // sans vérification anti-robot possible.
    new Logger('Bootstrap').warn(
      'Turnstile non configuré : demandes de réinitialisation et de vérification d’e-mail refusées (503).',
    );
  }
  if (
    turnstile.mode === 'unconfigured' &&
    process.env.PUBLIC_REGISTRATION_ENABLED === 'true'
  ) {
    new Logger('Bootstrap').warn(
      'Inscription publique ouverte sans Turnstile : chaque inscription sera refusée (503).',
    );
  }

  // Web Push (1-16A) : désactivé par défaut ; `WEB_PUSH_ENABLED=true` avec
  // une configuration VAPID invalide → erreur fatale au démarrage.
  const webPush = resolveWebPushConfig(process.env);

  // Suivi par lots (lot A) : désactivé par défaut ; valeur inconnue signalée
  // et traitée comme désactivée.
  if (productBatchesFlagInvalid(process.env)) {
    new Logger('Bootstrap').warn(
      'PRODUCT_BATCHES_ENABLED doit valoir true ou false : suivi par lots désactivé.',
    );
  } else if (productBatchesEnabled(process.env)) {
    new Logger('Bootstrap').warn(
      `Suivi par lots ACTIVÉ : ${describeScope(productBatchesScope(process.env))}.`,
    );
  }

  // Lot C : alertes de péremption, activation distincte.
  if (expiryAlertsFlagInvalid(process.env)) {
    new Logger('Bootstrap').warn(
      'EXPIRY_ALERTS_ENABLED doit valoir true ou false : alertes de péremption désactivées.',
    );
  } else if (expiryAlertsEnabled(process.env)) {
    new Logger('Bootstrap').warn(
      `Alertes de péremption ACTIVÉES : ${describeScope(expiryAlertsScope(process.env))}.`,
    );
  }

  const app = await NestFactory.create(AppModule, API_APPLICATION_OPTIONS);

  // trust proxy : réglé UNIQUEMENT si un proxy est approuvé. Express calcule
  // alors `req.ip` depuis les sauts/adresses approuvés ; sinon `req.ip` est
  // l'adresse de la socket (aucune lecture manuelle de `X-Forwarded-For`).
  applyTrustProxy(
    app.getHttpAdapter().getInstance() as ExpressSettings,
    trustProxy,
  );

  // Factory UNIQUE des options CORS strictes (partagée avec les E2E) :
  // origines exactes ; Origin absent ou inconnu SANS en-tête CORS et SANS
  // 500 ; méthodes/headers explicites ; pas de `credentials` (Bearer).
  app.enableCors(buildHttpCorsOptions(corsAllowlist));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  // Centre de notifications et traitement de fond (1-16A.1), push si
  // configuré : démarrage HTTP UNIQUEMENT (les CLI chargent `AppModule` sans
  // jamais passer par ici).
  await startNotifications(app, webPush);
  // Messages de service de l'administration : livraisons (centre, push,
  // e-mail) traitées en fond, processus HTTP uniquement.
  app.get(PlatformMessageDeliveryService).start();
  // 1-17B : reprise des envois et suppressions de fichiers interrompus
  // (processus HTTP uniquement).
  startStorageRecovery(app);
  // 1-21E : rapprochement périodique borné des paiements (webhook manqué).
  startPaymentReconciliationSweep(app);

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
