import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { SubscriptionPaymentsService } from './subscription-payments.service';

/**
 * 1-21E — Rapprochement périodique des paiements, démarré UNIQUEMENT par le
 * processus HTTP (`main.ts`) ; les CLI ne l'activent jamais. Couvre le cas
 * d'un webhook jamais reçu et d'un client qui ne revient pas : aucune
 * dépendance au seul bouton « Vérifier ».
 *
 * `PAYMENT_RECONCILIATION_SWEEP_SECONDS` : intervalle (défaut 300 s ; `0`
 * désactive). Par passe : au plus 10 paiements (≤ 30 appels SasPay, sous la
 * limite locale de 120 / min), chacun non vérifié depuis 10 min ; tentatives
 * closes surveillées 72 h. Une passe à la fois ; minuterie `unref`.
 * Créations SasPay restées `initiating` plus de 10 min : reclassées
 * `uncertain` (au plus 5 par passe, sans appel), puis vérifiées ainsi.
 */
export const PAYMENT_SWEEP_DEFAULT_SECONDS = 300;
export const PAYMENT_SWEEP_LIMIT = 10;
export const PAYMENT_SWEEP_STALE_MS = 10 * 60 * 1000;
export const PAYMENT_SWEEP_LATE_WINDOW_MS = 72 * 60 * 60 * 1000;

export function paymentSweepSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAYMENT_RECONCILIATION_SWEEP_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return PAYMENT_SWEEP_DEFAULT_SECONDS;
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400) {
    throw new Error(
      'PAYMENT_RECONCILIATION_SWEEP_SECONDS doit être un entier de 0 à 86400.',
    );
  }
  return seconds;
}

export function startPaymentReconciliationSweep(
  app: INestApplicationContext,
): () => void {
  const seconds = paymentSweepSeconds();
  const logger = new Logger('PaymentReconciliationSweep');
  if (seconds === 0) {
    logger.log('Rapprochement périodique des paiements désactivé.');
    return () => undefined;
  }
  const payments = app.get(SubscriptionPaymentsService);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void payments
      .sweepOnce({
        limit: PAYMENT_SWEEP_LIMIT,
        staleMs: PAYMENT_SWEEP_STALE_MS,
        lateWindowMs: PAYMENT_SWEEP_LATE_WINDOW_MS,
      })
      .then((report) => {
        if (report.examined > 0 || report.recovered > 0) {
          logger.log(
            `Rapprochement : ${report.examined} vérifié(s), ${report.failed} à reprendre, ${report.recovered} création(s) reprise(s).`,
          );
        }
      })
      .catch(() => logger.warn('Rapprochement impossible (nouvelle passe).'))
      .finally(() => {
        running = false;
      });
  }, seconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
