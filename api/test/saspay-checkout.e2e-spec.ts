import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
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
import {
  PAYMENT_RETURN_ORIGIN,
  SubscriptionPaymentsService,
} from './../src/subscriptions/payments/subscription-payments.service';
import {
  SASPAY_LOOKUP_MAX_PAGES,
  SasPayPaymentProvider,
} from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import { SASPAY_WEBHOOK_CONFIG } from './../src/subscriptions/payments/saspay/saspay-webhook.service';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { PaymentReconciliationService } from './../src/subscriptions/payments/reconciliation/payment-reconciliation.service';
import { ensureReconciliationIndexes } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';
import { ReconciliationReason } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema';
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
 * 1-21B — Paiement d'abonnement par PAGE HÉBERGÉE SasPay, de bout en bout
 * contre un FAUX SasPay (transport de l'adaptateur RÉEL), base éphémère.
 *
 * Documenté (contrat officiel) : création de session sans idempotence,
 * consultation par trois routes, liste paginée, webhook HMAC du corps brut.
 * HYPOTHÈSES simulées, à vérifier en bac à sable : une transaction
 * rattachée par session, succès possible après `EXPIRED`, cohérence des
 * routes de session (une incohérence est testée comme telle).
 */

const TEST_JWT_SECRET = 'saspay-checkout-21b-e2e-only-secret';
const WEBHOOK_SECRET = 'saspay-webhook-secret-21b-e2e-only';
const PASSWORD = 'pay-21b-pw-!1x';
const RETURN_ORIGIN = 'https://app.saspay-e2e.example';

const fake = new FakeSasPay();
// 1-21E : horloge monotone avancée d'une minute avant chaque cas : la limite
// locale de 120 appels / min (par processus) vaut pour chaque cas, pas pour
// toute la suite.
let monotonicOffset = 0;
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport: fake.transport,
  monotonic: () => performance.now() + monotonicOffset,
});

function signed(body: unknown, ageSeconds = 0, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return { raw, timestamp, signature };
}

describe('Paiement par page hébergée SasPay (e2e 1-21B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let payments: SubscriptionPaymentsService;
  let seq = 0;
  const emailSender = createE2eEmailSender();

  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const base = '/organizations/current/subscription/payments';

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-21b@pay.test`;
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
      email,
      orgId: reg.owner!.organization._id,
      token: login.body.access_token as string,
    };
  }

  const create = (
    token: string,
    body: Record<string, unknown> = {},
  ): request.Test => {
    clearThrottle();
    return request(server())
      .post(base)
      .set('Authorization', `Bearer ${token}`)
      .send({ term: 'monthly', clientOperationId: randomUUID(), ...body });
  };
  const refresh = (token: string, id: string) => {
    clearThrottle();
    return request(server())
      .post(`${base}/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`);
  };
  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const periodsFor = (id: string) =>
    periodModel
      .find({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .lean()
      .exec();
  const notify = (
    body: unknown,
    options: { ageSeconds?: number; secret?: string; tamper?: boolean } = {},
  ) => {
    clearThrottle();
    const s = signed(body, options.ageSeconds, options.secret);
    return request(server())
      .post('/payments/webhooks/saspay')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', s.signature)
      .set('X-Webhook-Timestamp', s.timestamp)
      .set('X-Webhook-Event', (body as { event: string }).event)
      .send(options.tamper ? s.raw.replace('PAIEMENT', 'PAIEMENT ') : s.raw);
  };
  const event = (transactionId: string, name = 'transaction.success') => ({
    event: name,
    data: {
      id: transactionId,
      reference: 'TXN-x',
      type: 'PAIEMENT',
      status: 'SUCCESS',
      amount: '3500.00',
      currency: 'XAF',
    },
  });

  async function pendingPayment(token: string) {
    const res = await create(token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    const stored = await doc(res.body.paymentId as string);
    return {
      id: res.body.paymentId as string,
      reference: res.body.reference as string,
      sessionId: stored!.providerReference!,
      body: res.body as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://saspay-e2e.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
        .useValue([provider])
        .overrideProvider(SASPAY_WEBHOOK_CONFIG)
        .useValue({ enabled: true, secret: WEBHOOK_SECRET })
        .overrideProvider(PAYMENT_RETURN_ORIGIN)
        .useValue(RETURN_ORIGIN)
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
      const connection = moduleFixture.get(getConnectionToken());
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureSubscriptionPaymentIndexes(connection);
      await ensureReconciliationIndexes(connection);
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      payments = moduleFixture.get(SubscriptionPaymentsService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    monotonicOffset += 61_000;
    fake.envelope = true;
    fake.nextCreate = 'normal';
    fake.statusOutage = false;
    fake.inconsistentStatusRoute = false;
    fake.cancelBehavior = 'normal';
    fake.beforeCancel = null;
    fake.omitTransactionField = null;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  // ─── Création ──────────────────────────────────────────────────────────────

  it('1. capacités : page hébergée ; création sans numéro, valeurs serveur, page validée, aucun secret renvoyé', async () => {
    const o = await owner('create');
    const caps = await request(server())
      .get(`${base}/capabilities`)
      .set('Authorization', `Bearer ${o.token}`);
    // 1-21D : catalogue COURANT exposé en lecture (tarifs réellement déployés).
    expect(caps.body).toEqual({
      available: true,
      method: 'hosted-checkout',
      pricing: {
        version: 2,
        currency: 'XAF',
        prices: [
          { term: 'monthly', months: 1, amount: 3500 },
          { term: 'quarterly', months: 3, amount: 10000 },
          { term: 'semiannual', months: 6, amount: 18500 },
          { term: 'annual', months: 12, amount: 35000 },
        ],
      },
    });

    const p = await pendingPayment(o.token);
    expect(p.body.payerPhoneMasked).toBeNull();
    expect(String(p.body.checkoutUrl)).toMatch(
      /^https:\/\/pay\.saspay\.me\/checkout\/[0-9a-f]+$/,
    );
    expect(JSON.stringify(p.body)).not.toContain(FAKE_SASPAY_KEY);
    const session = fake.sessions.get(p.sessionId)!;
    expect(session).toMatchObject({
      amount: '3500.00',
      currency: 'XAF',
      customer_email: o.email,
      customer_name: expect.stringContaining('Gérant'),
      return_url: `${RETURN_ORIGIN}/app/organization/subscription?payment=${p.id}`,
      metadata: { merchantReference: p.reference },
    });
    expect(session.description).toContain(p.reference);
    const stored = await doc(p.id);
    expect(stored).toMatchObject({
      provider: 'saspay',
      status: 'pending',
      open: true,
      amount: 3500,
      payerPhoneMasked: null,
    });
  });

  it('2. rejeu du même UUID : même paiement, aucune seconde session ; créations concurrentes : une seule ouverte', async () => {
    const o = await owner('replay');
    const op = randomUUID();
    const first = await create(o.token, { clientOperationId: op });
    const again = await create(o.token, { clientOperationId: op });
    expect(again.status).toBe(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(again.body.checkoutUrl).toBe(first.body.checkoutUrl);
    expect(
      [...fake.sessions.values()].filter(
        (s) => s.metadata.merchantReference === first.body.reference,
      ),
    ).toHaveLength(1);

    const other = await owner('concurrent');
    const before = fake.sessions.size;
    const results = await Promise.all([1, 2, 3].map(() => create(other.token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.body.code === 'PAYMENT_ALREADY_PENDING').length,
    ).toBe(2);
    expect(fake.sessions.size - before).toBe(1);
  });

  it('3. réponse perdue : incertain, aucune seconde session au rejeu ; vérification → session retrouvée par metadata et adoptée', async () => {
    const o = await owner('lost');
    const op = randomUUID();
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token, { clientOperationId: op });
    expect(lost.status).toBe(201);
    expect(lost.body.status).toBe('uncertain');
    expect(lost.body.checkoutUrl).toBeNull();
    const replay = await create(o.token, { clientOperationId: op });
    expect(replay.body.replayed).toBe(true);
    expect(fake.sessionByReference(lost.body.reference)).toBeDefined();
    const created = [...fake.sessions.values()].filter(
      (s) => s.metadata.merchantReference === lost.body.reference,
    );
    expect(created).toHaveLength(1);

    const adopted = await refresh(o.token, lost.body.paymentId);
    expect(adopted.status).toBe(200);
    expect(adopted.body.status).toBe('pending');
    expect(adopted.body.checkoutUrl).toMatch(/^https:\/\/pay\.saspay\.me\//);
    expect((await doc(lost.body.paymentId))!.providerReference).toBe(
      created[0].id,
    );
  });

  it('4. réponse perdue sans session trouvée, ou 500 après création : reste incertain, aucune nouvelle session ; refus 422 : échec sans session', async () => {
    const o = await owner('notfound');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    const session = fake.sessionByReference(lost.body.reference)!;
    fake.sessions.delete(session.id); // introuvable dans les pages lues
    const before = fake.sessions.size;
    const still = await refresh(o.token, lost.body.paymentId);
    expect(still.body.status).toBe('uncertain');
    expect(fake.sessions.size).toBe(before);
    expect(fake.count('POST', '/checkout-sessions/')).toBeGreaterThan(0);

    const o2 = await owner('err500');
    fake.nextCreate = 'error-500-after-create';
    const r500 = await create(o2.token);
    expect(r500.body.status).toBe('uncertain');

    const o3 = await owner('reject');
    fake.nextCreate = 'reject-422';
    const rejected = await create(o3.token);
    expect(rejected.body.status).toBe('failed');

    const o4 = await owner('foreign-url');
    fake.nextCreate = 'foreign-checkout-url';
    const foreign = await create(o4.token);
    expect(foreign.body.status).toBe('uncertain');
    expect(foreign.body.checkoutUrl).toBeNull();
  });

  it('5. correspondances multiples : jamais départagées → vérification opérateur', async () => {
    const o = await owner('ambiguous');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    fake.addForeignSession(lost.body.reference);
    const res = await refresh(o.token, lost.body.paymentId);
    expect(res.body.status).toBe('review');
    expect((await doc(lost.body.paymentId))!.incidentCode).toBe(
      'provider_inconsistent',
    );
  });

  it('6. recherche bornée : au plus 5 pages lues ; au-delà, aucune preuve d’absence (reste incertain)', async () => {
    const o = await owner('bounded');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(o.token);
    for (let i = 0; i < 100 * SASPAY_LOOKUP_MAX_PAGES + 5; i += 1) {
      fake.addForeignSession(`SMOTHER${i}`);
    }
    const listed = () =>
      fake.calls.filter(
        (c) => c.method === 'GET' && c.path === '/checkout-sessions/',
      ).length;
    const before = listed();
    const res = await refresh(o.token, lost.body.paymentId);
    expect(res.body.status).toBe('uncertain');
    expect(listed() - before).toBe(SASPAY_LOOKUP_MAX_PAGES);
    // Nettoyage : sessions étrangères retirées pour les tests suivants.
    for (const [id, s] of fake.sessions) {
      if (String(s.metadata.merchantReference).startsWith('SMOTHER')) {
        fake.sessions.delete(id);
      }
    }
  });

  // ─── Confirmation ──────────────────────────────────────────────────────────

  it('7. succès vérifié par les trois routes : une période, transaction rattachée, page retirée de la vue', async () => {
    const o = await owner('success');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    const res = await refresh(o.token, p.id);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.checkoutUrl).toBeNull();
    expect(await periodsFor(p.id)).toHaveLength(1);
    expect((await doc(p.id))!.providerTransactionId).toBe(tx);
    // Rejeu : aucune seconde période.
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('7b. frais ADD_ON (1-21C) : débit = prix + frais confirmés → une période, confirmations répétées sans effet ; frais incohérents → vérification', async () => {
    const o = await owner('addon');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS', {
      feeMode: 'ADD_ON',
      clientFee: '105.50',
      debited: '3605.50',
    });
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    await Promise.all([
      refresh(o.token, p.id),
      notify(event(tx)),
      payments.confirmPayment(new Types.ObjectId(p.id)),
    ]);
    expect((await doc(p.id))!.providerTransactionId).toBe(tx);
    expect(await periodsFor(p.id)).toHaveLength(1);

    const o2 = await owner('addon-mismatch');
    const p2 = await pendingPayment(o2.token);
    fake.attempt(p2.sessionId, 'SUCCESS', {
      feeMode: 'ADD_ON',
      clientFee: '105.50',
      debited: '3700.00',
    });
    expect((await refresh(o2.token, p2.id)).body.status).toBe('review');
    expect(await periodsFor(p2.id)).toHaveLength(0);
  });

  it('8. attente, tentative échouée sur page ouverte, page expirée (vérification), succès tardif accepté', async () => {
    const o = await owner('states');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'PENDING');
    expect((await refresh(o.token, p.id)).body.status).toBe('pending');
    fake.settle(tx, 'FAILED');
    const failedOnOpenPage = await refresh(o.token, p.id);
    expect(failedOnOpenPage.body.status).toBe('pending');
    expect(failedOnOpenPage.body.checkoutUrl).not.toBeNull();

    fake.close(p.sessionId, 'EXPIRED');
    const closed = await refresh(o.token, p.id);
    expect(closed.body.status).toBe('uncertain');
    expect(closed.body.checkoutUrl).toBeNull();
    expect(await doc(p.id)).toMatchObject({
      open: true,
      incidentCode: 'checkout_unresolved',
    });
    // Aucune nouvelle tentative libérée automatiquement.
    expect((await create(o.token)).body.code).toBe('PAYMENT_ALREADY_PENDING');

    // Succès tardif (hypothèse à vérifier en bac à sable) : attribué.
    fake.settle(tx, 'SUCCESS');
    const late = await refresh(o.token, p.id);
    expect(late.body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('9. discordances → vérification, jamais d’attribution : débit ≠ prix, devise, metadata absente, transaction désignée différemment', async () => {
    const cases: Array<(sessionId: string) => void> = [
      (s) => fake.attempt(s, 'SUCCESS', { debited: '3553.00' }),
      (s) => fake.attempt(s, 'SUCCESS', { currency: 'XOF' }),
      (s) => {
        fake.sessions.get(s)!.metadata = {};
        fake.attempt(s, 'SUCCESS');
      },
      (s) => {
        fake.attempt(s, 'SUCCESS');
        fake.inconsistentStatusRoute = true;
      },
    ];
    for (const prepare of cases) {
      fake.inconsistentStatusRoute = false;
      const o = await owner('mismatch');
      const p = await pendingPayment(o.token);
      prepare(p.sessionId);
      const res = await refresh(o.token, p.id);
      expect(res.body.status).toBe('review');
      expect(await periodsFor(p.id)).toHaveLength(0);
    }
  });

  it('10. confirmations concurrentes (refresh ×5, webhooks ×3, moteur ×2) : une seule période', async () => {
    const o = await owner('race');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    await Promise.all([
      ...[1, 2, 3, 4, 5].map(() => refresh(o.token, p.id)),
      ...[1, 2, 3].map(() => notify(event(tx))),
      payments.confirmPayment(new Types.ObjectId(p.id)),
      payments.confirmPayment(new Types.ObjectId(p.id)),
    ]);
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  // ─── Webhook ───────────────────────────────────────────────────────────────

  it('11. webhook : signature invalide, corps altéré, horodatage hors tolérance → 401, aucune lecture', async () => {
    const calls = fake.calls.length;
    expect(
      (await notify(event(randomUUID()), { secret: 'autre-secret-0000000' }))
        .status,
    ).toBe(401);
    expect((await notify(event(randomUUID()), { tamper: true })).status).toBe(
      401,
    );
    expect(
      (await notify(event(randomUUID()), { ageSeconds: 301 })).status,
    ).toBe(401);
    expect(fake.calls.length).toBe(calls);
  });

  it('12. webhook arrivé AVANT le rattachement : rapprochement borné, rattachement puis attribution ; rejeu : sans effet', async () => {
    const o = await owner('early');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    expect((await doc(p.id))!.providerTransactionId).toBeNull();
    const res = await notify(event(tx));
    expect(res.status).toBe(200);
    expect(await doc(p.id)).toMatchObject({
      status: 'succeeded',
      providerTransactionId: tx,
    });
    expect((await notify(event(tx))).status).toBe(200);
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('13. webhook : transaction étrangère sans candidat → accusé ; événement hors transaction → accusé ; panne SasPay → 503 temporaire, état conservé', async () => {
    // Aucun paiement candidat récent sans transaction : accusé.
    await paymentModel
      .updateMany(
        { provider: 'saspay', providerTransactionId: null, open: true },
        { $set: { initiatedAt: new Date(Date.now() - 48 * 3600 * 1000) } },
      )
      .exec();
    expect((await notify(event(randomUUID()))).status).toBe(200);
    expect(
      (await notify({ event: 'wallet_transfer.completed', data: { id: 'x' } }))
        .status,
    ).toBe(200);

    const o = await owner('outage');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    fake.statusOutage = true;
    const res = await notify(event(tx));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect((await doc(p.id))!.status).toBe('pending');
    fake.statusOutage = false;
    expect((await notify(event(tx))).status).toBe(200);
    expect((await doc(p.id))!.status).toBe('succeeded');
  });

  it('14. base indisponible pendant le webhook → 503 (SasPay renverra)', async () => {
    const spy = jest
      .spyOn(payments, 'findByProviderTransaction')
      .mockRejectedValueOnce(new Error('base indisponible'));
    try {
      expect((await notify(event(randomUUID()))).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it('15. enveloppe absente (exemples documentés) : même résultat', async () => {
    fake.envelope = false;
    const o = await owner('bare');
    const p = await pendingPayment(o.token);
    fake.attempt(p.sessionId, 'SUCCESS');
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
  });

  it('16. une transaction ne sert jamais deux paiements (index unique)', async () => {
    const a = await owner('dupA');
    const pa = await pendingPayment(a.token);
    const tx = fake.attempt(pa.sessionId, 'PENDING');
    expect((await refresh(a.token, pa.id)).body.status).toBe('pending');
    const b = await owner('dupB');
    const pb = await pendingPayment(b.token);
    // Session de B désignant (à tort) la transaction de A.
    fake.sessions.get(pb.sessionId)!.transaction = tx;
    const res = await refresh(b.token, pb.id);
    expect(res.body.status).toBe('review');
    expect((await doc(pb.id))!.providerTransactionId).toBeNull();
  });

  it('17. procédure opérateur : page close après une tentative échouée → plan bloqué ; clôture explicite (--close-unresolved) → échec, nouvelle tentative possible', async () => {
    const o = await owner('operator');
    const p = await pendingPayment(o.token);
    // 1-21E : sans tentative, la page close serait close automatiquement.
    fake.attempt(p.sessionId, 'FAILED');
    fake.close(p.sessionId, 'EXPIRED');
    expect((await refresh(o.token, p.id)).body.status).toBe('uncertain');
    const reconciliation = moduleFixture.get(PaymentReconciliationService);
    const blocked = await reconciliation.plan(p.id, null);
    expect(blocked).toMatchObject({
      decision: 'blocked',
      reason: 'provider-unresolved',
    });
    const ready = await reconciliation.plan(p.id, null, {
      closeUnresolved: true,
    });
    expect(ready).toMatchObject({ decision: 'ready', action: 'fail' });
    if (ready.decision !== 'ready') throw new Error('plan');
    const applied = await reconciliation.apply(
      p.id,
      null,
      {
        operationId: randomUUID(),
        operatorId: 'ops.e2e',
        reasonCode: ReconciliationReason.PROVIDER_CHECKOUT_CLOSED,
        reasonTicket: null,
        planToken: ready.planToken,
      },
      { closeUnresolved: true },
    );
    expect(applied).toMatchObject({ result: 'applied', action: 'fail' });
    expect(await doc(p.id)).toMatchObject({ status: 'failed', open: false });
    expect(await periodsFor(p.id)).toHaveLength(0);
    // Option sans objet sur un paiement non concerné : refus.
    const other = await owner('operator2');
    const q = await pendingPayment(other.token);
    expect(
      await reconciliation.plan(q.id, null, { closeUnresolved: true }),
    ).toMatchObject({ decision: 'blocked' });
    expect((await create(o.token)).status).toBe(201);
  });

  // ─── 1-21E : reprise, expiration, changement de forfait ────────────────────

  const abandon = (token: string, id: string, body?: unknown) => {
    clearThrottle();
    const req = request(server())
      .post(`${base}/${id}/abandon`)
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body as object);
  };
  const read = (token: string, id: string) =>
    request(server())
      .get(`${base}/${id}`)
      .set('Authorization', `Bearer ${token}`);
  const cancelCalls = (sessionId: string) =>
    fake.count('POST', `/checkout-sessions/${sessionId}/cancel/`);
  /**
   * Échéance atteinte : `expires_at` passé chez SasPay ET enregistré ici ; la
   * session peut rester `PENDING` un instant avant d'être close.
   */
  const expireLocally = async (id: string) => {
    const past = new Date(Date.now() - 1000);
    const stored = await doc(id);
    fake.sessions.get(stored!.providerReference!)!.expires_at =
      past.toISOString();
    await paymentModel
      .updateOne({ _id: id }, { $set: { providerCheckoutExpiresAt: past } })
      .exec();
  };

  it('E1. création sans paiement puis rechargements : même session, même lien, même échéance (jamais repoussée), aucune nouvelle session', async () => {
    const o = await owner('e1');
    const before = fake.count('POST', '/checkout-sessions/');
    const p = await pendingPayment(o.token);
    expect(p.body).toMatchObject({
      situation: 'checkout-open',
      checkoutExpiresAt: fake.sessions.get(p.sessionId)!.expires_at,
    });
    expect(p.body.checkoutExpiresInMs).toBeGreaterThan(29 * 60 * 1000);
    expect(p.body.checkoutExpiresInMs).toBeLessThanOrEqual(30 * 60 * 1000);
    const stored = await doc(p.id);
    expect(stored!.providerCheckoutExpiresAt!.toISOString()).toBe(
      p.body.checkoutExpiresAt,
    );
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 3; i += 1) {
      const again = await read(o.token, p.id);
      expect(again.body).toMatchObject({
        checkoutUrl: p.body.checkoutUrl,
        checkoutExpiresAt: p.body.checkoutExpiresAt,
        situation: 'checkout-open',
        amount: 3500,
        term: 'monthly',
      });
      expect(again.body.checkoutExpiresInMs).toBeLessThan(
        p.body.checkoutExpiresInMs as number,
      );
    }
    // Vérification : expiration RELUE chez SasPay, inchangée.
    const checked = await refresh(o.token, p.id);
    expect(checked.body.checkoutExpiresAt).toBe(p.body.checkoutExpiresAt);
    expect(fake.count('POST', '/checkout-sessions/') - before).toBe(1);
  });

  it('E2. changer de forfait avant ouverture : session FERMÉE chez SasPay et relue close, paiement clos (historique conservé, montant inchangé), nouveau forfait libéré', async () => {
    const o = await owner('e2');
    const p = await pendingPayment(o.token);
    // Corps strictement vide.
    expect((await abandon(o.token, p.id, { term: 'annual' })).status).toBe(400);
    const res = await abandon(o.token, p.id);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('released');
    expect(res.body.payment).toMatchObject({
      status: 'failed',
      situation: 'checkout-closed',
      checkoutUrl: null,
      amount: 3500,
    });
    expect(fake.sessions.get(p.sessionId)!.status).toBe('CANCELLED');
    expect(cancelCalls(p.sessionId)).toBe(1);
    expect(await doc(p.id)).toMatchObject({
      status: 'failed',
      open: false,
      incidentCode: 'checkout_closed',
      amount: 3500,
      providerReference: p.sessionId,
    });
    // Rejeu : sans nouvel appel.
    expect((await abandon(o.token, p.id)).body.outcome).toBe('released');
    expect(cancelCalls(p.sessionId)).toBe(1);
    // Nouveau forfait : nouvelle session, nouveau montant ; l'ancien reste.
    const next = await create(o.token, { term: 'quarterly' });
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ status: 'pending', amount: 10000 });
    expect(next.body.paymentId).not.toBe(p.id);
    const list = await request(server())
      .get(base)
      .set('Authorization', `Bearer ${o.token}`);
    expect(
      (list.body.items as Array<{ paymentId: string }>).map((i) => i.paymentId),
    ).toEqual([next.body.paymentId, p.id]);
    expect(await periodsFor(p.id)).toHaveLength(0);
  });

  it('E3. retour arrière depuis SasPay puis rechargement : lien conservé ; annulation de la tentative → close ; ancien lien (autre onglet) refusé par SasPay', async () => {
    const o = await owner('e3');
    const p = await pendingPayment(o.token);
    // Retour (paramètre `?payment=`) : une vérification, rien ne change.
    const back = await refresh(o.token, p.id);
    expect(back.body).toMatchObject({
      status: 'pending',
      situation: 'checkout-open',
      checkoutUrl: p.body.checkoutUrl,
    });
    const reloaded = await read(o.token, p.id);
    expect(reloaded.body.checkoutUrl).toBe(p.body.checkoutUrl);
    expect((await abandon(o.token, p.id)).body.outcome).toBe('released');
    // L'ancien lien, resté ouvert ailleurs : la page n'encaisse plus rien.
    expect(fake.payOnPage(p.sessionId, 'SUCCESS')).toBeNull();
    const after = await refresh(o.token, p.id);
    expect(after.body).toMatchObject({ status: 'failed', checkoutUrl: null });
    expect(await periodsFor(p.id)).toHaveLength(0);
  });

  it('E4. expiration atteinte, page ouverte : lien retiré immédiatement (lecture), aucun lien après rechargement ; vérification → close sans transaction, nouvelle tentative possible', async () => {
    const o = await owner('e4');
    const p = await pendingPayment(o.token);
    await expireLocally(p.id);
    // SasPay n'a pas encore fermé la session : jamais de lien expiré proposé.
    for (let i = 0; i < 2; i += 1) {
      const view = await read(o.token, p.id);
      expect(view.body).toMatchObject({
        status: 'pending',
        situation: 'checkout-expired',
        checkoutUrl: null,
        checkoutExpiresInMs: null,
      });
    }
    // Tant que SasPay la dit ouverte : rien n'est libéré.
    expect((await refresh(o.token, p.id)).body).toMatchObject({
      status: 'pending',
      checkoutUrl: null,
    });
    expect((await create(o.token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
    fake.close(p.sessionId, 'EXPIRED');
    const closed = await refresh(o.token, p.id);
    expect(closed.body).toMatchObject({
      status: 'failed',
      situation: 'checkout-closed',
    });
    expect((await create(o.token)).status).toBe(201);
  });

  it('E5. expiration après une tentative échouée : à vérifier (jamais « échec »), explication dédiée, aucune nouvelle tentative ; changer de forfait → attente de résolution, aucune fermeture', async () => {
    const o = await owner('e5');
    const p = await pendingPayment(o.token);
    fake.attempt(p.sessionId, 'FAILED');
    fake.close(p.sessionId, 'EXPIRED');
    const view = await refresh(o.token, p.id);
    expect(view.body).toMatchObject({
      status: 'uncertain',
      situation: 'attempt-unresolved',
      checkoutUrl: null,
    });
    const res = await abandon(o.token, p.id);
    expect(res.body.outcome).toBe('awaiting-resolution');
    expect(cancelCalls(p.sessionId)).toBe(0);
    expect(await doc(p.id)).toMatchObject({ status: 'uncertain', open: true });
    expect((await create(o.token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
  });

  it('E6. paiement réussi avant l’expiration, confirmation reçue après : attribué une fois ; webhook et vérifications répétées sans seconde période', async () => {
    const o = await owner('e6');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    await expireLocally(p.id);
    expect((await read(o.token, p.id)).body.checkoutUrl).toBeNull();
    expect((await notify(event(tx))).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    }
    expect((await notify(event(tx))).status).toBe(200);
    expect(await periodsFor(p.id)).toHaveLength(1);
    // Changer de forfait ensuite : succès signalé, rien n'est annulé.
    const res = await abandon(o.token, p.id);
    expect(res.body.outcome).toBe('succeeded');
    expect(cancelCalls(p.sessionId)).toBe(0);
  });

  it('E7. paiement validé PENDANT la demande d’annulation : SasPay refuse la fermeture (409), succès attribué une fois, jamais présenté comme annulé', async () => {
    const o = await owner('e7');
    const p = await pendingPayment(o.token);
    let tx = '';
    fake.beforeCancel = (session) => {
      tx = fake.attempt(session.id, 'SUCCESS');
    };
    const res = await abandon(o.token, p.id);
    expect(res.body.outcome).toBe('succeeded');
    expect(res.body.payment.status).toBe('succeeded');
    expect(fake.sessions.get(p.sessionId)!.status).toBe('PAID');
    expect((await notify(event(tx))).status).toBe(200);
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('E8. changer de forfait en concurrence avec une confirmation (refresh, webhook) : une seule période, aucune fermeture d’une session payée', async () => {
    const o = await owner('e8');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    const [a, b, r, w] = await Promise.all([
      abandon(o.token, p.id),
      abandon(o.token, p.id),
      refresh(o.token, p.id),
      notify(event(tx)),
    ]);
    expect([a.body.outcome, b.body.outcome]).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(r.body.status).toBe('succeeded');
    expect(w.status).toBe(200);
    expect(cancelCalls(p.sessionId)).toBe(0);
    expect(await periodsFor(p.id)).toHaveLength(1);
  });

  it('E9. transaction en cours ou tentative échouée sur page ouverte : rien n’est fermé, page toujours proposée, explication dédiée', async () => {
    const o = await owner('e9');
    const p = await pendingPayment(o.token);
    const tx = fake.attempt(p.sessionId, 'PENDING');
    const inProgress = await abandon(o.token, p.id);
    expect(inProgress.body.outcome).toBe('in-progress');
    fake.settle(tx, 'FAILED');
    const recorded = await abandon(o.token, p.id);
    expect(recorded.body.outcome).toBe('attempt-recorded');
    expect(recorded.body.payment).toMatchObject({
      status: 'pending',
      checkoutUrl: p.body.checkoutUrl,
    });
    expect(cancelCalls(p.sessionId)).toBe(0);
    expect(fake.sessions.get(p.sessionId)!.status).toBe('PENDING');
  });

  it('E10. résultat SasPay indisponible ou ambigu : rien n’est libéré ni annoncé annulé', async () => {
    const o = await owner('e10');
    const p = await pendingPayment(o.token);
    // Consultation impossible : 503, aucune fermeture demandée.
    fake.statusOutage = true;
    const outage = await abandon(o.token, p.id);
    expect(outage.status).toBe(503);
    expect(outage.body.code).toBe('PAYMENT_STATUS_UNAVAILABLE');
    fake.statusOutage = false;
    expect(cancelCalls(p.sessionId)).toBe(0);
    // Fermeture non transmise : 503, état conservé.
    fake.cancelBehavior = 'not-sent';
    const notSent = await abandon(o.token, p.id);
    expect(notSent.status).toBe(503);
    expect(notSent.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    expect(await doc(p.id)).toMatchObject({ status: 'pending', open: true });
    // 200 sans effet : session relue ouverte → non confirmée, rien libéré.
    fake.cancelBehavior = 'ignored';
    const ignored = await abandon(o.token, p.id);
    expect(ignored.body.outcome).toBe('cancel-unconfirmed');
    expect(ignored.body.payment).toMatchObject({
      status: 'pending',
      checkoutUrl: p.body.checkoutUrl,
    });
    // Réponse perdue APRÈS fermeture : la relecture établit la clôture.
    fake.cancelBehavior = 'lost-after-cancel';
    const lost = await abandon(o.token, p.id);
    expect(lost.body.outcome).toBe('released');
    expect(fake.sessions.get(p.sessionId)!.status).toBe('CANCELLED');

    // Réponse perdue à la création, session introuvable : jamais une preuve.
    const u = await owner('e10b');
    fake.nextCreate = 'lost-after-create';
    const lostCreate = await create(u.token);
    const session = fake.sessionByReference(lostCreate.body.reference)!;
    fake.sessions.delete(session.id);
    const notFound = await abandon(u.token, lostCreate.body.paymentId);
    expect(notFound.body.outcome).toBe('not-found-at-provider');
    expect(notFound.body.payment).toMatchObject({
      status: 'uncertain',
      situation: 'checkout-link-missing',
    });
  });

  it('E11. lien pas encore récupéré (réponse perdue) : « Vérifier » retrouve la MÊME session et son lien ; annulation possible ensuite', async () => {
    const o = await owner('e11');
    fake.nextCreate = 'error-500-after-create';
    const lost = await create(o.token);
    expect(lost.body).toMatchObject({
      status: 'uncertain',
      checkoutUrl: null,
      situation: 'checkout-link-missing',
    });
    const found = await refresh(o.token, lost.body.paymentId);
    const session = fake.sessionByReference(lost.body.reference)!;
    expect(found.body).toMatchObject({
      status: 'pending',
      situation: 'checkout-open',
      checkoutUrl: `https://pay.saspay.me/checkout/${session.slug}`,
    });
    expect((await abandon(o.token, lost.body.paymentId)).body.outcome).toBe(
      'released',
    );
  });

  // 1-21E (suite) : A remplacée par B → l'encaissement tardif de A est
  // enregistré (jamais perdu) mais l'ancien forfait n'est pas attribué ;
  // la poursuite de B est suspendue (page fermée, sans transaction).
  it('E12. notification tardive après annulation puis remplacement : rattachée, encaissement enregistré en résolution, aucune période, remplaçante suspendue', async () => {
    const o = await owner('e12');
    const p = await pendingPayment(o.token);
    expect((await abandon(o.token, p.id)).body.outcome).toBe('released');
    const next = await create(o.token, { term: 'quarterly' });
    expect(next.status).toBe(201);
    const tx = fake.lateTransaction(p.sessionId, 'SUCCESS');
    expect((await notify(event(tx))).status).toBe(200);
    expect(await doc(p.id)).toMatchObject({
      status: 'review',
      incidentCode: 'replaced_payment_collected',
      providerTransactionId: tx,
    });
    expect((await notify(event(tx))).status).toBe(200);
    expect(await periodsFor(p.id)).toHaveLength(0);
    expect(await doc(next.body.paymentId)).toMatchObject({
      status: 'failed',
      incidentCode: 'checkout_closed',
    });
  });

  it('E13. paiement antérieur à 1-21E (échéance non enregistrée) : échéance = création + 30 min, jamais repoussée', async () => {
    const o = await owner('e13');
    const p = await pendingPayment(o.token);
    // Écriture brute : `createdAt` est géré par Mongoose (immuable).
    await paymentModel.collection.updateOne(
      { _id: new Types.ObjectId(p.id) },
      {
        $set: {
          providerCheckoutExpiresAt: null,
          createdAt: new Date(Date.now() - 31 * 60 * 1000),
        },
      },
    );
    const view = await read(o.token, p.id);
    expect(view.body).toMatchObject({
      situation: 'checkout-expired',
      checkoutUrl: null,
    });
  });

  // ─── 1-21E (suite) : renouvellement, encaissements tardifs, reçus ─────────

  const receipt = (token: string, id: string) =>
    request(server())
      .get(`${base}/${id}/receipt`)
      .set('Authorization', `Bearer ${token}`);
  /** Périodes `payment` attribuées à l'organisation (tous paiements). */
  const paymentPeriodsOf = (orgId: string) =>
    periodModel
      .find({
        organizationId: new Types.ObjectId(orgId),
        source: SubscriptionSource.PAYMENT,
      })
      .lean()
      .exec();
  /** A ouverte, puis remplacée par B (changement de forfait). */
  async function replaced(label: string) {
    const o = await owner(label);
    const a = await pendingPayment(o.token);
    expect((await abandon(o.token, a.id)).body.outcome).toBe('released');
    const res = await create(o.token, { term: 'quarterly' });
    expect(res.status).toBe(201);
    const stored = await doc(res.body.paymentId as string);
    const b = {
      id: res.body.paymentId as string,
      sessionId: stored!.providerReference!,
    };
    return { o, a, b };
  }

  it('R1. remplacement A → B : même renouvellement, relation durable, montants et références propres ; achat après renouvellement terminé = nouveau renouvellement', async () => {
    const { o, a, b } = await replaced('r1');
    const [da, db] = [await doc(a.id), await doc(b.id)];
    expect(String(db!.renewalId)).toBe(a.id);
    expect(String(db!.replacesPaymentId)).toBe(a.id);
    expect(db).toMatchObject({ amount: 10000, term: 'quarterly' });
    expect(da).toMatchObject({ amount: 3500, term: 'monthly' });
    expect(da!.merchantReference).not.toBe(db!.merchantReference);
    const tx = fake.attempt(b.sessionId, 'SUCCESS');
    expect((await notify(event(tx))).status).toBe(200);
    expect(await doc(b.id)).toMatchObject({ status: 'succeeded' });
    expect(String((await doc(b.id))!.autoGrantRenewalId)).toBe(a.id);
    // Achat supplémentaire volontaire : nouveau renouvellement.
    const c = await create(o.token);
    expect(c.status).toBe(201);
    const dc = await doc(c.body.paymentId as string);
    expect(String(dc!.renewalId)).toBe(c.body.paymentId);
    expect(dc!.replacesPaymentId).toBeNull();
  });

  it('R2. B réussit puis A (remplacée) réussit tardivement : une seule période, second encaissement enregistré, incident, jamais « échoué » ; rejeux sans effet', async () => {
    const { o, a, b } = await replaced('r2');
    const txB = fake.attempt(b.sessionId, 'SUCCESS');
    expect((await notify(event(txB))).status).toBe(200);
    const txA = fake.lateTransaction(a.sessionId, 'SUCCESS');
    expect((await notify(event(txA))).status).toBe(200);
    expect(await doc(a.id)).toMatchObject({
      status: 'review',
      open: false,
      incidentCode: 'replaced_payment_collected',
      providerTransactionId: txA,
      periodId: null,
    });
    expect((await doc(a.id))!.collectedAt).toBeInstanceOf(Date);
    for (let i = 0; i < 3; i += 1) {
      expect((await notify(event(txA))).status).toBe(200);
      expect((await notify(event(txB))).status).toBe(200);
      await refresh(o.token, a.id);
      await refresh(o.token, b.id);
    }
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(1);
    expect(await periodsFor(b.id)).toHaveLength(1);
    const view = await read(o.token, a.id);
    expect(view.body).toMatchObject({
      status: 'review',
      situation: 'collected-in-resolution',
      collected: true,
    });
    // L'accès acquis par B est conservé ; un nouveau paiement reste possible.
    expect((await create(o.token)).status).toBe(201);
  });

  it('R3. A remplacée réussit AVANT B : encaissement enregistré, ancien forfait non attribué, B suspendue puis fermée chez SasPay (sans transaction)', async () => {
    const { o, a, b } = await replaced('r3');
    const txA = fake.lateTransaction(a.sessionId, 'SUCCESS');
    expect((await notify(event(txA))).status).toBe(200);
    expect(await doc(a.id)).toMatchObject({
      status: 'review',
      incidentCode: 'replaced_payment_collected',
      periodId: null,
    });
    expect(fake.sessions.get(b.sessionId)!.status).toBe('CANCELLED');
    expect(await doc(b.id)).toMatchObject({
      status: 'failed',
      incidentCode: 'checkout_closed',
    });
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(0);
  });

  it('R3b. A remplacée réussit pendant que B a une transaction en cours : B suspendue (aucun lien), non fermée ; succès de B attribué une fois', async () => {
    const { o, a, b } = await replaced('r3b');
    const txB = fake.attempt(b.sessionId, 'PENDING');
    const txA = fake.lateTransaction(a.sessionId, 'SUCCESS');
    expect((await notify(event(txA))).status).toBe(200);
    const vb = await read(o.token, b.id);
    expect(vb.body).toMatchObject({
      status: 'pending',
      situation: 'renewal-suspended',
      checkoutUrl: null,
    });
    expect(fake.sessions.get(b.sessionId)!.status).toBe('PENDING');
    fake.settle(txB, 'SUCCESS');
    expect((await notify(event(txB))).status).toBe(200);
    expect(await doc(b.id)).toMatchObject({ status: 'succeeded' });
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(1);
  });

  it('R4. A et B réussissent simultanément : une seule attribution (B, choix actuel) ; A enregistrée en résolution', async () => {
    const { o, a, b } = await replaced('r4');
    const txB = fake.attempt(b.sessionId, 'SUCCESS');
    const txA = fake.lateTransaction(a.sessionId, 'SUCCESS');
    await Promise.all([
      notify(event(txA)),
      notify(event(txB)),
      refresh(o.token, a.id),
      refresh(o.token, b.id),
      payments.confirmPayment(new Types.ObjectId(a.id)).catch(() => null),
      payments.confirmPayment(new Types.ObjectId(b.id)).catch(() => null),
    ]);
    await refresh(o.token, a.id);
    await refresh(o.token, b.id);
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(1);
    expect(await periodsFor(b.id)).toHaveLength(1);
    expect((await doc(a.id))!.status).toBe('review');
  });

  it('R5. garantie en BASE : deux tentatives non remplacées d’un même renouvellement réussissent en concurrence → une seule attribution automatique (index unique), l’autre encaissée en résolution', async () => {
    const x = await owner('r5x');
    const px = await pendingPayment(x.token);
    const y = await owner('r5y');
    const py = await pendingPayment(y.token);
    // Même renouvellement, même organisation, sans relation de remplacement
    // (course entre création et attribution) : écritures brutes de test.
    await paymentModel.collection.updateOne(
      { _id: new Types.ObjectId(py.id) },
      {
        $set: {
          renewalId: new Types.ObjectId(px.id),
          organizationId: new Types.ObjectId(x.orgId),
          open: false,
        },
      },
    );
    const tx1 = fake.attempt(px.sessionId, 'SUCCESS');
    const tx2 = fake.attempt(py.sessionId, 'SUCCESS');
    await Promise.all([
      notify(event(tx1)),
      notify(event(tx2)),
      payments.confirmPayment(new Types.ObjectId(px.id)).catch(() => null),
      payments.confirmPayment(new Types.ObjectId(py.id)).catch(() => null),
    ]);
    await payments.confirmPayment(new Types.ObjectId(px.id)).catch(() => null);
    await payments.confirmPayment(new Types.ObjectId(py.id)).catch(() => null);
    const statuses = [(await doc(px.id))!, (await doc(py.id))!];
    const succeeded = SubscriptionPaymentStatus.SUCCEEDED;
    expect(statuses.filter((d) => d.status === succeeded)).toHaveLength(1);
    const loser = statuses.find((d) => d.status !== succeeded)!;
    expect(loser).toMatchObject({
      status: 'review',
      incidentCode: 'renewal_already_granted',
    });
    expect(loser.collectedAt).toBeInstanceOf(Date);
    expect(await paymentPeriodsOf(x.orgId)).toHaveLength(1);
  });

  it('R6. fermeture ambiguë : champ de transaction absent → rien fermé ni libéré (changer de forfait, expiration)', async () => {
    for (const omitted of ['detail', 'status'] as const) {
      const o = await owner(`r6${omitted}`);
      const p = await pendingPayment(o.token);
      fake.omitTransactionField = omitted;
      const res = await abandon(o.token, p.id);
      expect(res.body.outcome).toBe('provider-incomplete');
      expect(cancelCalls(p.sessionId)).toBe(0);
      fake.close(p.sessionId, 'EXPIRED');
      const after = await refresh(o.token, p.id);
      expect(after.body).toMatchObject({
        status: 'uncertain',
        situation: 'closure-unconfirmed',
      });
      expect((await create(o.token)).body.code).toBe('PAYMENT_ALREADY_PENDING');
      fake.omitTransactionField = null;
    }
  });

  it('R7. reprise après redémarrage entre fermeture et remplacement : relation dérivée de la base seule', async () => {
    const o = await owner('r7');
    const a = await pendingPayment(o.token);
    // Fermeture écrite par un processus précédent (aucun état mémoire).
    fake.close(a.sessionId, 'CANCELLED');
    await paymentModel.collection.updateOne(
      { _id: new Types.ObjectId(a.id) },
      {
        $set: {
          status: 'failed',
          open: false,
          incidentCode: 'checkout_closed',
          failedAt: new Date(),
          providerCheckoutUrl: null,
        },
      },
    );
    const b = await create(o.token, { term: 'annual' });
    expect(b.status).toBe(201);
    expect(
      String((await doc(b.body.paymentId as string))!.replacesPaymentId),
    ).toBe(a.id);
  });

  it('R8. paiement antérieur au modèle (sans renouvellement ni encaissement enregistrés) : remplacé correctement ; reçu exact à son ancien prix', async () => {
    const o = await owner('r8');
    const old = await pendingPayment(o.token);
    const tx = fake.attempt(old.sessionId, 'SUCCESS');
    expect((await notify(event(tx))).status).toBe(200);
    // Forme d'avant 1-21E, au prix de la version 1 (3 000).
    await paymentModel.collection.updateOne(
      { _id: new Types.ObjectId(old.id) },
      {
        $set: { amount: 3000, pricingVersion: 1 },
        $unset: {
          renewalId: '',
          replacesPaymentId: '',
          autoGrantRenewalId: '',
          collectedAt: '',
          paidAmountMinor: '',
          providerCheckoutExpiresAt: '',
          renewalConflictAt: '',
        },
      },
    );
    const r = await receipt(o.token, old.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: 'payment-receipt',
      amountPaidMinor: 300000,
      currency: 'XAF',
      application: 'applied',
    });
    expect(r.body.period).not.toBeNull();
    // Paiement antérieur clos sans encaissement, puis remplacé.
    const o2 = await owner('r8b');
    const a = await pendingPayment(o2.token);
    fake.close(a.sessionId, 'EXPIRED');
    await refresh(o2.token, a.id);
    await paymentModel.collection.updateOne(
      { _id: new Types.ObjectId(a.id) },
      { $unset: { renewalId: '', replacesPaymentId: '', collectedAt: '' } },
    );
    const b = await create(o2.token);
    expect(String((await doc(b.body.paymentId as string))!.renewalId)).toBe(
      a.id,
    );
  });

  it('R9. reçu : encaissement confirmé seulement, valeurs enregistrées, période réelle, aucune donnée privée ; isolation ; en résolution sans période', async () => {
    const o = await owner('r9');
    const p = await pendingPayment(o.token);
    expect((await receipt(o.token, p.id)).body.code).toBe(
      'PAYMENT_RECEIPT_UNAVAILABLE',
    );
    const tx = fake.attempt(p.sessionId, 'SUCCESS');
    expect((await notify(event(tx))).status).toBe(200);
    const r = await receipt(o.token, p.id);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const stored = await doc(p.id);
    const period = await periodModel.findById(stored!.periodId).lean().exec();
    expect(r.body).toEqual({
      kind: 'payment-receipt',
      receiptNumber: p.reference,
      paymentId: p.id,
      issuer: { name: 'Stock Master' },
      organization: { name: expect.stringContaining('Boutique') },
      term: 'monthly',
      months: 1,
      amountPaidMinor: 350000,
      currency: 'XAF',
      paidAt: stored!.collectedAt!.toISOString(),
      provider: 'saspay',
      providerTransactionId: tx,
      application: 'applied',
      refundedAt: null,
      period: {
        startsAt: period!.startsAt.toISOString(),
        endsAt: period!.endsAt.toISOString(),
      },
    });
    const raw = JSON.stringify(r.body);
    for (const leak of ['checkout', 'pay.saspay', FAKE_SASPAY_KEY, o.email]) {
      expect(raw).not.toContain(leak);
    }
    // Autre organisation : 404 uniforme.
    const other = await owner('r9other');
    expect((await receipt(other.token, p.id)).status).toBe(404);
    // Encaissement en résolution : reçu, sans période ni activation.
    const { o: o2, a, b } = await replaced('r9conflict');
    const txB = fake.attempt(b.sessionId, 'SUCCESS');
    await notify(event(txB));
    const txA = fake.lateTransaction(a.sessionId, 'SUCCESS');
    await notify(event(txA));
    const conflict = await receipt(o2.token, a.id);
    expect(conflict.body).toMatchObject({
      application: 'in-resolution',
      period: null,
      amountPaidMinor: 350000,
    });
    // Tentative close sans paiement : aucun reçu.
    const closed = await owner('r9closed');
    const c = await pendingPayment(closed.token);
    await abandon(closed.token, c.id);
    expect((await receipt(closed.token, c.id)).status).toBe(409);
  });

  it('R10. webhook jamais reçu : le rapprochement périodique borné confirme un paiement ouvert et un succès tardif sur une tentative close ; réservation entre passes concurrentes', async () => {
    const o = await owner('r10');
    const p = await pendingPayment(o.token);
    fake.attempt(p.sessionId, 'SUCCESS');
    const o2 = await owner('r10b');
    const c = await pendingPayment(o2.token);
    expect((await abandon(o2.token, c.id)).body.outcome).toBe('released');
    fake.lateTransaction(c.sessionId, 'SUCCESS');
    // Paiements des autres cas : vérifiés à l'instant (hors de cette passe).
    await paymentModel
      .updateMany(
        { _id: { $nin: [p.id, c.id] } },
        { $set: { lastCheckedAt: new Date() } },
      )
      .exec();
    // Marquées comme vérifiées il y a longtemps (dernière passe ancienne).
    await paymentModel
      .updateMany(
        { _id: { $in: [p.id, c.id] } },
        { $set: { lastCheckedAt: new Date(Date.now() - 3_600_000) } },
      )
      .exec();
    const options = { limit: 50, staleMs: 60_000, lateWindowMs: 3_600_000 };
    const reports = await Promise.all([
      payments.sweepOnce(options),
      payments.sweepOnce(options),
    ]);
    expect(reports.reduce((n, r) => n + r.examined, 0)).toBeGreaterThanOrEqual(
      2,
    );
    expect(await doc(p.id)).toMatchObject({ status: 'succeeded' });
    // Tentative close non remplacée : encaissement tardif attribué.
    expect(await doc(c.id)).toMatchObject({ status: 'succeeded' });
    expect(await periodsFor(p.id)).toHaveLength(1);
    expect(await periodsFor(c.id)).toHaveLength(1);
    // Passe suivante : rien à revérifier avant `staleMs`.
    const again = await payments.sweepOnce(options);
    expect(again.failed).toBe(0);
    expect(await doc(p.id)).toMatchObject({ status: 'succeeded' });
  });

  // ─── 1-21E (clôture) : attribution manuelle, remboursement, au-delà ─────

  const reconciliationOf = () =>
    moduleFixture.get(PaymentReconciliationService);
  /** Plan puis application d'un rapprochement opérateur (CLI). */
  async function operate(
    paymentId: string,
    options: Record<string, unknown>,
    reason: ReconciliationReason = ReconciliationReason.CUSTOMER_EVIDENCE,
  ) {
    const service = reconciliationOf();
    const plan = await service.plan(paymentId, null, options);
    if (plan.decision !== 'ready') return { plan, applied: null };
    const applied = await service
      .apply(
        paymentId,
        null,
        {
          operationId: randomUUID(),
          operatorId: 'ops.e2e',
          reasonCode: reason,
          reasonTicket: 'T-1',
          planToken: plan.planToken,
        },
        options,
      )
      .catch((error: unknown) => ({ error }));
    return { plan, applied };
  }
  /** A remplacée par B ; B engagée (transaction en cours) ; A encaissée. */
  async function collectedReplaced(label: string) {
    const r = await replaced(label);
    const txB = fake.attempt(r.b.sessionId, 'PENDING');
    const txA = fake.lateTransaction(r.a.sessionId, 'SUCCESS');
    expect((await notify(event(txA))).status).toBe(200);
    expect(await doc(r.a.id)).toMatchObject({
      status: 'review',
      incidentCode: 'replaced_payment_collected',
    });
    return { ...r, txA, txB };
  }

  it('V1. forfait initial retenu (CLI `renewal`, accord du client) puis B réussit → une seule période, B encaissée en résolution', async () => {
    const { o, a, b, txB } = await collectedReplaced('v1');
    // Sans mode : refusé.
    expect((await reconciliationOf().plan(a.id, null, {})).decision).toBe(
      'blocked',
    );
    const { applied } = await operate(a.id, {
      grantRenewalConflict: 'renewal',
    });
    expect(applied).toMatchObject({ result: 'applied' });
    expect(String((await doc(a.id))!.autoGrantRenewalId)).toBe(a.id);
    // Poursuite de B suspendue (transaction engagée : page non fermée).
    expect((await doc(b.id))!.renewalConflictAt).toBeInstanceOf(Date);
    fake.settle(txB, 'SUCCESS');
    await notify(event(txB));
    await refresh(o.token, b.id);
    await payments.sweepOnce({ limit: 5, staleMs: 0, lateWindowMs: 3_600_000 });
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(1);
    expect(await periodsFor(a.id)).toHaveLength(1);
    expect(await doc(b.id)).toMatchObject({
      status: 'review',
      incidentCode: 'renewal_already_granted',
    });
    expect((await doc(b.id))!.collectedAt).toBeInstanceOf(Date);
    // Le CLI ne règle pas une seconde fois ce renouvellement.
    expect(
      (
        await reconciliationOf().plan(b.id, null, {
          grantRenewalConflict: 'renewal',
        })
      ).decision,
    ).toBe('blocked');
  });

  it('V2. attribution manuelle `renewal` concurrente de la confirmation de B : une seule période, issue cohérente', async () => {
    const { o, a, b, txB } = await collectedReplaced('v2');
    const plan = await reconciliationOf().plan(a.id, null, {
      grantRenewalConflict: 'renewal',
    });
    if (plan.decision !== 'ready') throw new Error('plan');
    fake.settle(txB, 'SUCCESS');
    const [applied] = await Promise.all([
      reconciliationOf()
        .apply(
          a.id,
          null,
          {
            operationId: randomUUID(),
            operatorId: 'ops.e2e',
            reasonCode: ReconciliationReason.CUSTOMER_EVIDENCE,
            reasonTicket: 'T-2',
            planToken: plan.planToken,
          },
          { grantRenewalConflict: 'renewal' },
        )
        .catch((error: unknown) => ({ error })),
      notify(event(txB)),
      refresh(o.token, b.id),
      payments.confirmPayment(new Types.ObjectId(b.id)).catch(() => null),
    ]);
    await refresh(o.token, b.id);
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(1);
    const da = (await doc(a.id))!;
    const dbb = (await doc(b.id))!;
    const succeeded = SubscriptionPaymentStatus.SUCCEEDED;
    const granted = [da, dbb].filter((d) => d.status === succeeded);
    expect(granted).toHaveLength(1);
    if (dbb.status === succeeded) {
      // B l'a emporté : le CLI est refusé, rien n'est appliqué.
      expect(applied).not.toMatchObject({ result: 'applied' });
      expect(da.status).toBe('review');
    } else {
      expect(applied).toMatchObject({ result: 'applied' });
      expect(dbb).toMatchObject({
        status: 'review',
        incidentCode: 'renewal_already_granted',
      });
    }
  });

  it('V3. achat supplémentaire accepté (CLI `additional`) : seconde période EXPLICITE ; `renewal` refusé si B a déjà réglé le renouvellement ; rejeux sans effet', async () => {
    const { o, a, b, txA, txB } = await collectedReplaced('v3');
    fake.settle(txB, 'SUCCESS');
    await notify(event(txB));
    expect(await doc(b.id)).toMatchObject({ status: 'succeeded' });
    expect(
      await reconciliationOf().plan(a.id, null, {
        grantRenewalConflict: 'renewal',
      }),
    ).toMatchObject({ decision: 'blocked', reason: 'renewal-already-settled' });
    const { applied } = await operate(a.id, {
      grantRenewalConflict: 'additional',
    });
    expect(applied).toMatchObject({ result: 'applied' });
    expect((await doc(a.id))!.autoGrantRenewalId).toBeNull();
    for (let i = 0; i < 2; i += 1) {
      await notify(event(txA));
      await notify(event(txB));
      await refresh(o.token, a.id);
    }
    expect(await paymentPeriodsOf(o.orgId)).toHaveLength(2);
  });

  it('V4. remboursement externe consigné (CLI `--record-refund`, audité) : plus aucune attribution par webhook, refresh, sweep ou CLI ; reçu « remboursé »', async () => {
    const { o, a, txA } = await collectedReplaced('v4');
    const { applied } = await operate(
      a.id,
      { recordRefund: true },
      ReconciliationReason.REFUNDED_OUTSIDE,
    );
    expect(applied).toMatchObject({
      result: 'applied',
      action: 'record-refund',
    });
    expect(await doc(a.id)).toMatchObject({
      status: 'review',
      open: false,
      incidentCode: 'refunded_outside',
      periodId: null,
    });
    expect((await doc(a.id))!.refundedAt).toBeInstanceOf(Date);
    expect((await doc(a.id))!.collectedAt).toBeInstanceOf(Date);
    for (let i = 0; i < 2; i += 1) {
      expect((await notify(event(txA))).status).toBe(200);
      await refresh(o.token, a.id);
    }
    // Passe ciblée : seul A est à revérifier.
    await paymentModel
      .updateMany({}, { $set: { lastCheckedAt: new Date() } })
      .exec();
    await paymentModel
      .updateOne({ _id: a.id }, { $set: { lastCheckedAt: null } })
      .exec();
    const swept = await payments.sweepOnce({
      limit: 50,
      staleMs: 60_000,
      lateWindowMs: 3_600_000,
    });
    expect(swept.examined).toBe(0);
    for (const options of [
      { grantRenewalConflict: 'renewal' as const },
      { grantRenewalConflict: 'additional' as const },
      {},
      { recordRefund: true },
    ]) {
      expect(await reconciliationOf().plan(a.id, null, options)).toMatchObject({
        decision: 'blocked',
        reason: 'refunded',
      });
    }
    expect(await periodsFor(a.id)).toHaveLength(0);
    const view = await read(o.token, a.id);
    expect(view.body).toMatchObject({ situation: 'refunded', collected: true });
    const r = await receipt(o.token, a.id);
    expect(r.body).toMatchObject({ application: 'refunded', period: null });
    expect(typeof r.body.refundedAt).toBe('string');
    // Sans objet sur un paiement non encaissé.
    const other = await owner('v4other');
    const p = await pendingPayment(other.token);
    expect(
      await reconciliationOf().plan(p.id, null, { recordRefund: true }),
    ).toMatchObject({ decision: 'blocked' });
  });

  it('V5. succès tardif au-delà des fenêtres automatiques (webhook manqué, > 72 h) : ignoré par le sweep, rapproché par le CLI depuis la référence SM…', async () => {
    const o = await owner('v5');
    const p = await pendingPayment(o.token);
    expect((await abandon(o.token, p.id)).body.outcome).toBe('released');
    await paymentModel
      .updateOne(
        { _id: p.id },
        { $set: { failedAt: new Date(Date.now() - 5 * 86_400_000) } },
      )
      .exec();
    fake.lateTransaction(p.sessionId, 'SUCCESS');
    await paymentModel
      .updateMany({}, { $set: { lastCheckedAt: new Date() } })
      .exec();
    await paymentModel
      .updateOne({ _id: p.id }, { $set: { lastCheckedAt: null } })
      .exec();
    await payments.sweepOnce({
      limit: 50,
      staleMs: 60_000,
      lateWindowMs: 72 * 3_600_000,
    });
    expect(await doc(p.id)).toMatchObject({ status: 'failed' });
    // Référence marchand (relevé SasPay, libellé) → identifiant du paiement.
    const paymentId = p.reference.slice(2).toLowerCase();
    expect(paymentId).toBe(p.id);
    const { plan, applied } = await operate(
      paymentId,
      {},
      ReconciliationReason.PROVIDER_STATEMENT,
    );
    expect(plan).toMatchObject({ decision: 'ready', action: 'succeed' });
    expect(applied).toMatchObject({ result: 'applied' });
    expect(await periodsFor(p.id)).toHaveLength(1);
  });
});
