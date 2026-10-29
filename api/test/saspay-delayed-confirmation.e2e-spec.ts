import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { API_APPLICATION_OPTIONS } from './../src/common/application-options';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
} from './../src/subscriptions/schemas/subscription-period.schema';
import { ensureSubscriptionPeriodIndexes } from './../src/subscriptions/subscription-period-indexes';
import { SubscriptionSource } from './../src/subscriptions/subscription-terms';
import { SUBSCRIPTION_CLOCK } from './../src/subscriptions/subscription-clock';
import {
  SubscriptionPayment,
  SubscriptionPaymentDocument,
  SubscriptionPaymentStatus,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
} from './../src/subscriptions/payments/payment-provider';
import { SubscriptionPaymentsService } from './../src/subscriptions/payments/subscription-payments.service';
import { SasPayPaymentProvider } from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import { SASPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/saspay/saspay-webhook.service';
import {
  PAYMENT_SWEEP_LATE_WINDOW_MS,
  PAYMENT_SWEEP_LIMIT,
  PAYMENT_SWEEP_STALE_MS,
} from './../src/subscriptions/payments/payment-reconciliation-sweep';
import { PAYMENT_CONFIRMATION_DELAY_MS } from './../src/subscriptions/payments/payment-confirmation-delay';
import { OrganizationStatus } from './../src/organizations/permissions';
import { ensurePlatformAdminIndexes } from '../src/platform-admin/platform-admin-indexes';
import { ensurePlatformAdminNotificationIndexes } from '../src/platform-admin/platform-admin-notification-indexes';
import { PlatformAdminNotificationSweep } from '../src/platform-admin/platform-admin-notification-sweep.service';
import { PlatformAdminNotificationsService } from '../src/platform-admin/platform-admin-notifications.service';
import {
  PLATFORM_ADMIN_CLOCK,
  PlatformAdminRuntime,
} from '../src/platform-admin/platform-admin-runtime';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { FAKE_SASPAY_KEY, FakeSasPay } from './e2e/fake-saspay';

/**
 * Retards de confirmation SasPay : un paiement réussi peut rester « en
 * attente » chez SasPay (ticket après 24 h). Faux SasPay (adaptateur RÉEL),
 * horloge contrôlée (abonnements ET administration), base éphémère.
 *
 * - message du propriétaire (`confirmationPending`) avant / après 24 h, absent
 *   pour un paiement confirmé ou clos ;
 * - alerte d'administration unique au seuil, même SANS écriture du paiement,
 *   malgré passes répétées, concurrentes et redémarrage ; aucun changement
 *   d'état ; rien de rétroactif au premier déploiement ;
 * - confirmation tardive : webhook, rapprochement et vérification
 *   concurrents → une période, une notification de confirmation ;
 * - commerce suspendu : période enregistrée, suspension conservée.
 */

const WEBHOOK_SECRET = 'saspay-delayed-webhook-secret-e2e-only';
const PASSWORD = 'pay-delayed-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const HOUR_MS = 3_600_000;

const fake = new FakeSasPay();
let monotonicOffset = 0;
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport: fake.transport,
  monotonic: () => performance.now() + monotonicOffset,
});

/** Horloge commune (abonnements, administration) ; décalage nul par défaut. */
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return { raw, timestamp, signature };
}

describe('Retards de confirmation SasPay (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let payments: SubscriptionPaymentsService;
  let sweep: PlatformAdminNotificationSweep;
  let seq = 0;
  /** Paiement déjà ancien AVANT la première passe (premier déploiement). */
  let legacyPaymentId: string;
  const emailSender = createE2eEmailSender();
  const base = '/organizations/current/subscription/payments';

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const db = () => connection.db!;

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-delayed@pay.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: `Gérant ${seq}`,
      email,
      password: PASSWORD,
      organizationName: `Boutique ${seq}`,
    });
    expect(reg.status).toBe(202);
    clearThrottle();
    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
    return {
      orgId: reg.owner!.organization._id,
      token: login.body.access_token as string,
    };
  }

  const view = async (token: string, id: string) => {
    clearThrottle();
    const res = await request(server())
      .get(`${base}/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as {
      status: string;
      reference: string;
      confirmationPending: { since: string; delayed: boolean } | null;
    };
  };
  const refresh = (token: string, id: string) => {
    clearThrottle();
    return request(server())
      .post(`${base}/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };
  const notify = (transactionId: string) => {
    clearThrottle();
    const s = signed({
      event: 'transaction.success',
      data: {
        id: transactionId,
        reference: 'TXN-delayed',
        type: 'PAIEMENT',
        status: 'SUCCESS',
        amount: '3500.00',
        currency: 'XAF',
      },
    });
    return request(server())
      .post('/payments/webhooks/saspay')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', s.signature)
      .set('X-Webhook-Timestamp', s.timestamp)
      .set('X-Webhook-Event', 'transaction.success')
      .send(s.raw);
  };
  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const periodsFor = (id: string) =>
    periodModel
      .countDocuments({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .exec();
  const alerts = (id: string) =>
    db()
      .collection('platform_admin_notifications')
      .find({ eventKey: `payment_confirmation_delayed:${id}` })
      .toArray();
  const confirmations = (id: string) =>
    db()
      .collection('platform_admin_notifications')
      .countDocuments({ eventKey: `payment_confirmed:${id}` });

  /**
   * Le payeur valide sur la page ; SasPay garde la transaction `PENDING`
   * et la page expire. « Vérifier » rattache la transaction (paiement
   * `pending`, transaction connue, page close).
   */
  async function engagedPayment(token: string) {
    clearThrottle();
    const created = await request(server())
      .post(base)
      .set('Authorization', `Bearer ${token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    expect(created.status).toBe(201);
    const id = created.body.paymentId as string;
    const sessionId = (await doc(id))!.providerReference!;
    const transactionId = fake.attempt(sessionId, 'PENDING');
    fake.close(sessionId, 'EXPIRED');
    const checked = await refresh(token, id);
    expect(checked.status).toBe(200);
    expect(checked.body.status).toBe('pending');
    expect((await doc(id))!.providerTransactionId).toBe(transactionId);
    return {
      id,
      sessionId,
      transactionId,
      reference: created.body.reference as string,
    };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = randomBytes(48).toString('base64url');
      process.env.CORS_ORIGIN = 'https://saspay-delayed.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL = 'https://app.saspay-delayed.e2e.test';
      process.env.PLATFORM_ADMIN_ENABLED = 'true';
      process.env.PLATFORM_ADMIN_MFA_KEYS = `e2e1:${randomBytes(32).toString('base64')}`;
      process.env.PLATFORM_ADMIN_MFA_ACTIVE_KEY = 'e2e1';
      process.env.PLATFORM_ADMIN_PROXY_SECRET = PROXY_SECRET;
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
        .useValue([provider])
        .overrideProvider(SASPAY_WEBHOOK_CONFIG)
        .useValue({ enabled: true, secret: WEBHOOK_SECRET })
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(clock)
        .overrideProvider(PLATFORM_ADMIN_CLOCK)
        .useValue(clock)
        .compile();
      app = moduleFixture.createNestApplication(API_APPLICATION_OPTIONS);
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      autoConfirmVerificationEmails(app, emailSender);
      connection = moduleFixture.get(getConnectionToken());
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureSubscriptionPaymentIndexes(connection);
      await ensurePlatformAdminIndexes(connection);
      await ensurePlatformAdminNotificationIndexes(connection);
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      payments = moduleFixture.get(SubscriptionPaymentsService);
      sweep = app.get(PlatformAdminNotificationSweep);

      // Premier déploiement : paiement SasPay ouvert depuis 3 jours, déjà en
      // base AVANT la première passe de cette version.
      const legacy = new Types.ObjectId();
      const old = new Date(Date.now() - 3 * 24 * HOUR_MS);
      await db()
        .collection('subscription_payments')
        .insertOne({
          _id: legacy,
          organizationId: new Types.ObjectId(),
          requestedBy: new Types.ObjectId(),
          clientOperationId: randomUUID(),
          requestFingerprint: 'legacy',
          term: 'monthly',
          amount: 3500,
          currency: 'XAF',
          pricingVersion: 2,
          provider: 'saspay',
          merchantReference: `SM${legacy.toHexString().toUpperCase()}`,
          providerReference: randomUUID(),
          providerTransactionId: randomUUID(),
          status: 'pending',
          open: true,
          periodId: null,
          collectedAt: null,
          refundedAt: null,
          createdAt: old,
          updatedAt: old,
        });
      legacyPaymentId = legacy.toHexString();
      // Première passe : points d'activation (général et retards).
      await sweep.runOnce();
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    clockOffsetMs = 0;
    monotonicOffset += 61_000;
    emailSender.reset();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. avant 24 h : message client sans assistance, aucune alerte ; après 24 h sans écriture : une seule alerte, état inchangé', async () => {
    const o = await owner('seuil');
    const p = await engagedPayment(o.token);

    const fresh = await view(o.token, p.id);
    expect(fresh.status).toBe('pending');
    expect(fresh.confirmationPending).toEqual({
      since: expect.any(String),
      delayed: false,
    });

    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS - 60_000;
    await sweep.runOnce();
    expect(await alerts(p.id)).toHaveLength(0);
    expect((await view(o.token, p.id)).confirmationPending?.delayed).toBe(
      false,
    );

    // Aucune écriture du paiement entre-temps (ni webhook ni vérification).
    const untouched = (await doc(p.id))!;
    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS + 60_000;
    await sweep.runOnce();
    const [alert] = await alerts(p.id);
    expect(alert).toMatchObject({
      type: 'payment_confirmation_delayed',
      category: 'payments',
      target: { kind: 'payment', id: p.id, organizationId: o.orgId },
      params: {
        reference: p.reference,
        transactionReference: p.transactionId,
        startedAt: untouched.createdAt!.toISOString(),
        amount: 3500,
        currency: 'XAF',
      },
    });
    expect(alert.occurredAt).toEqual(
      new Date(untouched.createdAt!.getTime() + PAYMENT_CONFIRMATION_DELAY_MS),
    );
    // Aucune URL de paiement ni identifiant de session dans l'alerte.
    expect(JSON.stringify(alert)).not.toContain('pay.saspay.me');
    expect(JSON.stringify(alert)).not.toContain(p.sessionId);

    // L'alerte ne transforme jamais le paiement.
    const after = (await doc(p.id))!;
    expect(after.status).toBe(SubscriptionPaymentStatus.PENDING);
    expect(after.open).toBe(true);
    expect(after.updatedAt).toEqual(untouched.updatedAt);

    const delayed = await view(o.token, p.id);
    expect(delayed.confirmationPending?.delayed).toBe(true);
    expect(delayed.reference).toBe(p.reference);

    // Passes répétées, concurrentes et nouvelle instance (redémarrage).
    await sweep.runOnce();
    await Promise.all([sweep.runOnce(), sweep.runOnce()]);
    const restarted = new PlatformAdminNotificationSweep(
      app.get(PlatformAdminRuntime),
      app.get(PlatformAdminNotificationsService),
    );
    await restarted.runOnce();
    clockOffsetMs += 5 * 24 * HOUR_MS;
    await restarted.runOnce();
    expect(await alerts(p.id)).toHaveLength(1);
  });

  it('2. premier déploiement : un paiement déjà ancien n’est pas signalé rétroactivement', async () => {
    clockOffsetMs = 2 * PAYMENT_CONFIRMATION_DELAY_MS;
    await sweep.runOnce();
    expect(await alerts(legacyPaymentId)).toHaveLength(0);
  });

  it('3. paiement confirmé, clos sans transaction ou à examiner : ni alerte ni message', async () => {
    // Confirmé.
    const a = await owner('confirme');
    const paid = await engagedPayment(a.token);
    fake.settle(paid.transactionId, 'SUCCESS');
    expect((await refresh(a.token, paid.id)).body.status).toBe('succeeded');
    expect((await view(a.token, paid.id)).confirmationPending).toBeNull();

    // Page close sans transaction, affirmée par SasPay : définitivement clos.
    const b = await owner('clos');
    clearThrottle();
    const created = await request(server())
      .post(base)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    const closedId = created.body.paymentId as string;
    fake.close((await doc(closedId))!.providerReference!, 'EXPIRED');
    expect((await refresh(b.token, closedId)).body.status).toBe('failed');
    expect((await view(b.token, closedId)).confirmationPending).toBeNull();

    // À examiner : déjà signalé par `payment_review`.
    const c = await owner('examen');
    const review = await engagedPayment(c.token);
    await paymentModel.updateOne(
      { _id: review.id },
      { $set: { status: SubscriptionPaymentStatus.REVIEW } },
    );
    expect((await view(c.token, review.id)).confirmationPending).toBeNull();

    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS + HOUR_MS;
    await sweep.runOnce();
    for (const id of [paid.id, closedId, review.id]) {
      expect(await alerts(id)).toHaveLength(0);
    }
  });

  it('4. confirmation tardive : webhook, rapprochement et vérification concurrents → une période, une notification de confirmation, alerte conservée', async () => {
    const o = await owner('tardif');
    const p = await engagedPayment(o.token);
    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS + 2 * HOUR_MS;
    await sweep.runOnce();
    const [alert] = await alerts(p.id);
    expect(alert).toBeDefined();

    // SasPay actualise enfin le statut, plus de 24 h après.
    fake.settle(p.transactionId, 'SUCCESS');
    const [hook, hookAgain, swept, checked] = await Promise.all([
      notify(p.transactionId),
      notify(p.transactionId),
      payments.sweepOnce({
        limit: PAYMENT_SWEEP_LIMIT,
        staleMs: PAYMENT_SWEEP_STALE_MS,
        lateWindowMs: PAYMENT_SWEEP_LATE_WINDOW_MS,
      }),
      refresh(o.token, p.id),
    ]);
    expect(hook.status).toBe(200);
    expect(hookAgain.status).toBe(200);
    expect(swept.failed).toBe(0);
    expect(checked.status).toBe(200);
    expect(await notify(p.transactionId).then((r) => r.status)).toBe(200);

    const stored = (await doc(p.id))!;
    expect(stored.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(stored.periodId).not.toBeNull();
    expect(await periodsFor(p.id)).toBe(1);
    expect((await view(o.token, p.id)).confirmationPending).toBeNull();

    await sweep.runOnce();
    await Promise.all([sweep.runOnce(), sweep.runOnce()]);
    expect(await confirmations(p.id)).toBe(1);
    // Historique de l'alerte conservé, jamais modifié.
    expect(await alerts(p.id)).toEqual([alert]);
  });

  it('5. commerce suspendu : confirmation tardive enregistrée sans réactivation', async () => {
    const o = await owner('suspendu');
    const p = await engagedPayment(o.token);
    const organizations = db().collection('organizations');
    await organizations.updateOne(
      { _id: new Types.ObjectId(o.orgId) },
      { $set: { status: OrganizationStatus.SUSPENDED } },
    );
    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS + HOUR_MS;
    await sweep.runOnce();
    expect(await alerts(p.id)).toHaveLength(1);

    fake.settle(p.transactionId, 'SUCCESS');
    expect((await notify(p.transactionId)).status).toBe(200);
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(await periodsFor(p.id)).toBe(1);
    const org = await organizations.findOne({
      _id: new Types.ObjectId(o.orgId),
    });
    expect(org!.status).toBe(OrganizationStatus.SUSPENDED);
  });
});
