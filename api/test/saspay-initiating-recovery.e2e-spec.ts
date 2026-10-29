import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
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
  SubscriptionPaymentIncident,
  SubscriptionPaymentStatus,
} from './../src/subscriptions/payments/schemas/subscription-payment.schema';
import { ensureSubscriptionPaymentIndexes } from './../src/subscriptions/payments/subscription-payment-indexes';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
} from './../src/subscriptions/payments/payment-provider';
import {
  INITIATING_RECOVERY_DELAY_MS,
  SubscriptionPaymentsService,
} from './../src/subscriptions/payments/subscription-payments.service';
import { SasPayPaymentProvider } from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import type { SasPayTransport } from './../src/subscriptions/payments/saspay/saspay-transport';
import { SASPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/saspay/saspay-webhook.service';
import {
  PAYMENT_SWEEP_LATE_WINDOW_MS,
  PAYMENT_SWEEP_LIMIT,
  PAYMENT_SWEEP_STALE_MS,
} from './../src/subscriptions/payments/payment-reconciliation-sweep';
import { PAYMENT_CONFIRMATION_DELAY_MS } from './../src/subscriptions/payments/payment-confirmation-delay';
import { merchantReferenceFor } from './../src/subscriptions/payments/payment-request';
import { OrganizationStatus } from './../src/organizations/permissions';
import { ensurePlatformAdminIndexes } from '../src/platform-admin/platform-admin-indexes';
import { ensurePlatformAdminNotificationIndexes } from '../src/platform-admin/platform-admin-notification-indexes';
import { PlatformAdminNotificationSweep } from '../src/platform-admin/platform-admin-notification-sweep.service';
import { PLATFORM_ADMIN_CLOCK } from '../src/platform-admin/platform-admin-runtime';
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
 * Créations SasPay restées `initiating` après une interruption de l'API :
 * reprise par le rapprochement périodique, faux SasPay (adaptateur RÉEL),
 * horloge contrôlée, interruptions simulées en base.
 *
 * Garanties vérifiées : aucune seconde session (aucune idempotence de la
 * création), aucun échec sur délai, une seule période, aucune réactivation
 * d'un commerce suspendu, création lente jamais doublée ni écrasée, cas
 * irrécupérable visible (client, administration) et non résolu, journaux
 * sans URL de paiement ni secret.
 */

const PASSWORD = 'pay-initiating-pw-!1x';
const WEBHOOK_SECRET = 'saspay-initiating-webhook-secret-e2e-only';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const PRICE = 3500;

const fake = new FakeSasPay();
/** Création retenue (création lente) tant que `hold` est défini. */
let hold: Promise<void> | null = null;
const transport: SasPayTransport = async (req) => {
  if (req.method === 'POST' && req.url.endsWith('/checkout-sessions/')) {
    if (hold) await hold;
  }
  return fake.transport(req);
};
let monotonicOffset = 0;
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport,
  monotonic: () => performance.now() + monotonicOffset,
});

let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
const AFTER_DELAY = INITIATING_RECOVERY_DELAY_MS + 60_000;

describe('Reprise des créations SasPay restées initiating (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let payments: SubscriptionPaymentsService;
  let adminSweep: PlatformAdminNotificationSweep;
  let seq = 0;
  const logged: string[] = [];
  const emailSender = createE2eEmailSender();
  const base = '/organizations/current/subscription/payments';

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const db = () => connection.db!;
  const creates = () => fake.count('POST', '/checkout-sessions/');
  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const periodsFor = (id: string) =>
    periodModel
      .countDocuments({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .exec();
  const sweep = () =>
    payments.sweepOnce({
      limit: PAYMENT_SWEEP_LIMIT,
      staleMs: PAYMENT_SWEEP_STALE_MS,
      lateWindowMs: PAYMENT_SWEEP_LATE_WINDOW_MS,
    });

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-initiating@pay.test`;
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
    const user = await db().collection('users').findOne({ email });
    return {
      orgId: reg.owner!.organization._id,
      userId: user!._id,
      token: login.body.access_token as string,
    };
  }

  /**
   * Interruption simulée : document `initiating` tel qu'inséré par
   * `createPayment` avant l'appel externe (champs de 1-21E compris, ou forme
   * ancienne minimale), réponse jamais enregistrée.
   */
  async function interrupted(
    o: { orgId: string; userId: Types.ObjectId },
    options: { legacy?: boolean } = {},
  ) {
    const _id = new Types.ObjectId();
    const now = new Date();
    await db()
      .collection('subscription_payments')
      .insertOne({
        _id,
        organizationId: new Types.ObjectId(o.orgId),
        requestedBy: o.userId,
        clientOperationId: randomUUID(),
        requestFingerprint: 'interrupted',
        term: 'monthly',
        amount: PRICE,
        currency: 'XAF',
        pricingVersion: 2,
        provider: 'saspay',
        merchantReference: merchantReferenceFor(_id),
        providerReference: null,
        status: 'initiating',
        open: true,
        ...(options.legacy
          ? {}
          : {
              payerPhoneMasked: null,
              renewalId: _id,
              replacesPaymentId: null,
              periodId: null,
              incidentCode: null,
              initiatedAt: null,
              lastCheckedAt: null,
            }),
        createdAt: now,
        updatedAt: now,
      });
    return { id: _id.toHexString(), reference: merchantReferenceFor(_id) };
  }

  /** Appel de création RÉEL de l'adaptateur (le faux crée la session). */
  const createAtSasPay = (reference: string) =>
    provider.initiate({
      merchantReference: reference,
      amount: PRICE,
      currency: 'XAF',
      payerPhone: null,
      description: `Abonnement Stock Master (1 mois) ${reference}`,
      customer: { email: 'payeur@pay.test', name: 'Payeur' },
    });

  const view = async (token: string, id: string) => {
    clearThrottle();
    const res = await request(server())
      .get(`${base}/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as {
      status: string;
      situation: string | null;
      creationUnresolved: { since: string; delayed: boolean } | null;
    };
  };
  const refresh = (token: string, id: string) => {
    clearThrottle();
    return request(server())
      .post(`${base}/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = randomBytes(48).toString('base64url');
      process.env.CORS_ORIGIN = 'https://saspay-initiating.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL = 'https://app.saspay-initiating.e2e.test';
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
      adminSweep = app.get(PlatformAdminNotificationSweep);
      await adminSweep.runOnce();
      // Journaux de l'application capturés (aucune URL, aucun secret).
      for (const level of ['log', 'warn', 'error'] as const) {
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(' '));
          });
      }
    } catch (error) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(async () => {
    clockOffsetMs = 0;
    monotonicOffset += 61_000;
    fake.nextCreate = 'normal';
    fake.statusOutage = false;
    hold = null;
    // Chaque cas part sans création restée ouverte d'un cas précédent.
    await db()
      .collection('subscription_payments')
      .updateMany(
        { status: { $in: ['initiating', 'uncertain', 'pending'] } },
        { $set: { lastCheckedAt: new Date(Date.now() + 365 * 86_400_000) } },
      );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. interruption avant l’appel : rien avant le délai ; ensuite issue inconnue, jamais d’échec ni de nouvelle session', async () => {
    const o = await owner('avant-appel');
    const p = await interrupted(o);
    const before = creates();

    clockOffsetMs = INITIATING_RECOVERY_DELAY_MS - 60_000;
    expect((await sweep()).recovered).toBe(0);
    expect((await doc(p.id))!.status).toBe(
      SubscriptionPaymentStatus.INITIATING,
    );

    clockOffsetMs = AFTER_DELAY;
    const report = await sweep();
    expect(report.recovered).toBe(1);
    const stored = (await doc(p.id))!;
    expect(stored.status).toBe(SubscriptionPaymentStatus.UNCERTAIN);
    expect(stored.incidentCode).toBe(
      SubscriptionPaymentIncident.INITIATION_UNCERTAIN,
    );
    expect(stored.open).toBe(true);
    expect(stored.providerReference).toBeNull();
    expect(creates()).toBe(before);

    // Recherche sans résultat : jamais une preuve, rien n'est clos.
    clockOffsetMs = AFTER_DELAY + 2 * PAYMENT_SWEEP_STALE_MS;
    await sweep();
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.UNCERTAIN);
    expect(creates()).toBe(before);
    expect((await sweep()).recovered).toBe(0);
  });

  it('2. session créée, réponse perdue : session retrouvée, rattachée, puis payée une fois', async () => {
    const o = await owner('reponse-perdue');
    const p = await interrupted(o);
    fake.nextCreate = 'lost-after-create';
    await expect(createAtSasPay(p.reference)).rejects.toThrow();
    const sessions = creates();

    clockOffsetMs = AFTER_DELAY;
    const report = await sweep();
    expect(report.recovered).toBe(1);
    const stored = (await doc(p.id))!;
    const session = fake.sessionByReference(p.reference)!;
    expect(stored.status).toBe(SubscriptionPaymentStatus.PENDING);
    expect(stored.providerReference).toBe(session.id);
    expect(creates()).toBe(sessions);

    fake.attempt(session.id, 'SUCCESS');
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    clockOffsetMs += 2 * PAYMENT_SWEEP_STALE_MS;
    await sweep();
    expect(await periodsFor(p.id)).toBe(1);
    expect(creates()).toBe(sessions);
  });

  it('3. réponse reçue, écriture locale perdue ; ancien document sans les champs récents', async () => {
    const o = await owner('ecriture-perdue');
    const p = await interrupted(o, { legacy: true });
    const accepted = await createAtSasPay(p.reference);
    expect(accepted.outcome).toBe('accepted');
    const sessions = creates();

    clockOffsetMs = AFTER_DELAY;
    expect((await sweep()).recovered).toBe(1);
    const stored = (await doc(p.id))!;
    expect(stored.status).toBe(SubscriptionPaymentStatus.PENDING);
    expect(stored.providerReference).toBe(
      accepted.outcome === 'accepted' ? accepted.providerReference : null,
    );
    expect(creates()).toBe(sessions);
  });

  it('4. création lente en cours : jamais reprise avant le délai, jamais écrasée après', async () => {
    const o = await owner('lente');
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    clearThrottle();
    const pending = request(server())
      .post(base)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    const started = pending.then((r) => r);
    let row: SubscriptionPaymentDocument | null = null;
    for (let i = 0; i < 100 && !row; i += 1) {
      row = await paymentModel.findOne({
        organizationId: new Types.ObjectId(o.orgId),
        status: SubscriptionPaymentStatus.INITIATING,
      });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).not.toBeNull();
    const id = row!._id.toHexString();

    // Passe pendant la création : rien (délai de sécurité).
    expect((await sweep()).recovered).toBe(0);
    expect((await doc(id))!.status).toBe(SubscriptionPaymentStatus.INITIATING);

    // Processus figé au-delà du délai : reprise, puis la réponse arrive.
    clockOffsetMs = AFTER_DELAY;
    expect((await sweep()).recovered).toBe(1);
    release();
    const created = await started;
    expect(created.status).toBe(201);
    // Écriture de la création refusée (état relu) : rien n'est écrasé.
    expect((await doc(id))!.status).toBe(SubscriptionPaymentStatus.UNCERTAIN);
    expect(creates()).toBeGreaterThan(0);
    const sessions = creates();

    // La session est retrouvée par sa référence marchand, jamais recréée.
    clockOffsetMs += 2 * PAYMENT_SWEEP_STALE_MS;
    await sweep();
    const stored = (await doc(id))!;
    expect(stored.status).toBe(SubscriptionPaymentStatus.PENDING);
    expect(stored.providerReference).toBe(
      fake.sessionByReference(stored.merchantReference)!.id,
    );
    expect(creates()).toBe(sessions);
  });

  it('5. deux reprises concurrentes et vérification simultanée : une reprise, une période', async () => {
    const o = await owner('concurrence');
    const p = await interrupted(o);
    const accepted = await createAtSasPay(p.reference);
    if (accepted.outcome !== 'accepted') throw new Error('création');
    fake.attempt(accepted.providerReference, 'SUCCESS');
    const sessions = creates();

    clockOffsetMs = AFTER_DELAY;
    const [a, b, checked] = await Promise.all([
      sweep(),
      sweep(),
      refresh(o.token, p.id),
    ]);
    expect(a.recovered + b.recovered).toBeLessThanOrEqual(1);
    expect(checked.status).toBe(200);
    clockOffsetMs += 2 * PAYMENT_SWEEP_STALE_MS;
    await Promise.all([sweep(), refresh(o.token, p.id)]);
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(await periodsFor(p.id)).toBe(1);
    expect(creates()).toBe(sessions);
  });

  it('6. commerce suspendu : reprise et période enregistrée, suspension conservée', async () => {
    const o = await owner('suspendu');
    const p = await interrupted(o);
    const accepted = await createAtSasPay(p.reference);
    if (accepted.outcome !== 'accepted') throw new Error('création');
    fake.attempt(accepted.providerReference, 'SUCCESS');
    const organizations = db().collection('organizations');
    await organizations.updateOne(
      { _id: new Types.ObjectId(o.orgId) },
      { $set: { status: OrganizationStatus.SUSPENDED } },
    );
    clockOffsetMs = AFTER_DELAY;
    await sweep();
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(await periodsFor(p.id)).toBe(1);
    const org = await organizations.findOne({
      _id: new Types.ObjectId(o.orgId),
    });
    expect(org!.status).toBe(OrganizationStatus.SUSPENDED);
  });

  it('7. reprise interrompue (SasPay indisponible) puis redémarrage : la passe suivante termine', async () => {
    const o = await owner('reprise');
    const p = await interrupted(o);
    await createAtSasPay(p.reference);
    clockOffsetMs = AFTER_DELAY;
    fake.statusOutage = true;
    const first = await sweep();
    expect(first.recovered).toBe(1);
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.UNCERTAIN);
    // Aucun état en mémoire : la passe suivante repart de la base seule.
    fake.statusOutage = false;
    clockOffsetMs += 2 * PAYMENT_SWEEP_STALE_MS;
    await sweep();
    expect((await doc(p.id))!.status).toBe(SubscriptionPaymentStatus.PENDING);
  });

  it('8. aucun moyen fiable de retrouver la session : non résolu, nouvelle tentative refusée, assistance et alerte unique', async () => {
    const o = await owner('introuvable');
    const p = await interrupted(o);
    const before = creates();
    clockOffsetMs = AFTER_DELAY;
    await sweep();
    const early = await view(o.token, p.id);
    expect(early.status).toBe('uncertain');
    expect(early.situation).toBe('checkout-link-missing');
    expect(early.creationUnresolved).toEqual({
      since: expect.any(String),
      delayed: false,
    });

    clearThrottle();
    const retry = await request(server())
      .post(base)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('PAYMENT_ALREADY_PENDING');

    clockOffsetMs = PAYMENT_CONFIRMATION_DELAY_MS + 60_000;
    await sweep();
    await adminSweep.runOnce();
    await adminSweep.runOnce();
    const alerts = await db()
      .collection('platform_admin_notifications')
      .find({ eventKey: `payment_confirmation_delayed:${p.id}` })
      .toArray();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].params).toMatchObject({
      reference: p.reference,
      transactionReference: null,
      incidentCode: 'initiation_uncertain',
    });
    const late = await view(o.token, p.id);
    expect(late.status).toBe('uncertain');
    expect(late.creationUnresolved?.delayed).toBe(true);
    expect((await doc(p.id))!.open).toBe(true);
    expect(creates()).toBe(before);
  });

  it('9. paiements pending et uncertain existants : rapprochement inchangé', async () => {
    const o = await owner('regression');
    clearThrottle();
    const created = await request(server())
      .post(base)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID() });
    expect(created.body.status).toBe('pending');
    const id = created.body.paymentId as string;
    fake.attempt((await doc(id))!.providerReference!, 'SUCCESS');
    await paymentModel.updateOne(
      { _id: id },
      { $set: { lastCheckedAt: null } },
    );
    const report = await sweep();
    expect(report.recovered).toBe(0);
    expect((await doc(id))!.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(await periodsFor(id)).toBe(1);
  });

  it('10. journaux : identifiants internes seulement, ni URL de paiement ni secret', () => {
    expect(logged.some((l) => l.includes('Création restée en cours'))).toBe(
      true,
    );
    for (const line of logged) {
      expect(line).not.toMatch(/https?:\/\//);
      expect(line).not.toContain(FAKE_SASPAY_KEY);
      expect(line).not.toContain(WEBHOOK_SECRET);
    }
  });
});
