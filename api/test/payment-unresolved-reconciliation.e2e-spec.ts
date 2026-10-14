import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { Model } from 'mongoose';
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
  SubscriptionPaymentIncident,
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
import { PAYMENT_CALL_LIMITS } from './../src/subscriptions/payments/payment-call-budget';
import { SasPayPaymentProvider } from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import {
  SASPAY_WEBHOOK_CONFIG,
  SASPAY_WEBHOOK_MAX_CANDIDATES,
  SASPAY_WEBHOOK_REPEAT_WINDOW_MS,
} from './../src/subscriptions/payments/saspay/saspay-webhook.service';
import {
  PaymentReconciliationService,
  ReconciliationOptions,
} from './../src/subscriptions/payments/reconciliation/payment-reconciliation.service';
import {
  ReconciliationReason,
  SubscriptionPaymentReconciliation,
  SubscriptionPaymentReconciliationDocument,
} from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation.schema';
import { ensureReconciliationIndexes } from './../src/subscriptions/payments/reconciliation/subscription-payment-reconciliation-indexes';
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
 * 1-22D.3 — Résolution opérateur d'une création SasPay incertaine SANS
 * référence prestataire : recherche par référence marchand, rattachement
 * contrôlé, clôture exceptionnelle sur preuve externe, encaissement tardif.
 * SasPay simulé, base éphémère (isolation 1-22D.1), horloges contrôlées.
 */

const TEST_JWT_SECRET = 'unresolved-22d3-e2e-only-secret-value';
const WEBHOOK_SECRET = 'saspay-webhook-secret-22d3-e2e-only';
const PASSWORD = 'pay-22d3-pw-!1x';
const PROOF = 'saspay-support:TCK-48213';
const LIMITS = PAYMENT_CALL_LIMITS;

const fake = new FakeSasPay();
let monotonicOffset = 0;
let wallOffset = 0;
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport: fake.transport,
  monotonic: () => performance.now() + monotonicOffset,
});

describe('Résolution des créations SasPay sans référence (e2e 1-22D.3)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let paymentModel: Model<SubscriptionPaymentDocument>;
  let periodModel: Model<SubscriptionPeriodDocument>;
  let auditModel: Model<SubscriptionPaymentReconciliationDocument>;
  let payments: SubscriptionPaymentsService;
  let reconciliation: PaymentReconciliationService;
  let seq = 0;
  const emailSender = createE2eEmailSender();
  const server = () => app.getHttpServer();
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  const base = '/organizations/current/subscription/payments';

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-22d3@pay.test`;
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
    return {
      orgId: reg.owner!.organization._id,
      token: login.body.access_token as string,
    };
  }

  const post = (token: string, path: string, body?: object) => {
    clearThrottle();
    return request(server())
      .post(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  };
  const create = (token: string) =>
    post(token, '', { term: 'monthly', clientOperationId: randomUUID() });
  const refresh = (token: string, id: string) => post(token, `/${id}/refresh`);
  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const periodsFor = (id: string) =>
    periodModel
      .countDocuments({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .exec();
  const creations = () =>
    fake.calls.filter(
      (c) => c.method === 'POST' && c.path === '/checkout-sessions/',
    ).length;
  const nextWindow = () => {
    monotonicOffset += LIMITS.windowMs + 1_000;
  };

  /** Création reçue `429` : tentative incertaine, sans référence. */
  async function uncertain(
    token: string,
    behavior: 'rate-limited' | 'rate-limited-after-create',
  ) {
    fake.nextCreate = behavior;
    const res = await create(token);
    expect(res.body.status).toBe('uncertain');
    nextWindow(); // pause après 429 écoulée
    const id = res.body.paymentId as string;
    const row = (await doc(id))!;
    expect(row.providerReference).toBeNull();
    return {
      id,
      reference: row.merchantReference,
      session: fake.sessionByReference(row.merchantReference) ?? null,
    };
  }

  const operation = (
    reasonCode: ReconciliationReason,
    planToken: string,
    reasonTicket: string | null = null,
  ) => ({
    operationId: randomUUID(),
    operatorId: 'ops.alice',
    reasonCode,
    reasonTicket,
    planToken,
  });
  const closure: ReconciliationOptions = { closeWithoutSessionProof: PROOF };

  function notify(transactionId: string) {
    clearThrottle();
    const raw = JSON.stringify({
      event: 'transaction.success',
      data: { id: transactionId, type: 'PAIEMENT', status: 'SUCCESS' },
    });
    const timestamp = String(Math.floor((Date.now() + wallOffset) / 1000));
    const signature = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${timestamp}.${raw}`)
      .digest('hex');
    return request(server())
      .post('/payments/webhooks/saspay')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Event', 'transaction.success')
      .send(raw);
  }

  async function onlyCandidate(id: string) {
    await paymentModel.updateMany(
      { _id: { $ne: id } },
      { $set: { lastCheckedAt: new Date() } },
    );
    await paymentModel.updateOne(
      { _id: id },
      { $set: { lastCheckedAt: null } },
    );
  }
  const sweep = () =>
    payments.sweepOnce({
      limit: 10,
      staleMs: 600_000,
      lateWindowMs: 3_600_000,
    });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = 'https://unresolved-22d3.example.com';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PAYMENT_PROVIDER)
        .useValue(provider)
        .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
        .useValue([provider])
        .overrideProvider(SASPAY_WEBHOOK_CONFIG)
        .useValue({
          enabled: true,
          secret: WEBHOOK_SECRET,
          now: () => Date.now() + wallOffset,
        })
        .overrideProvider(PAYMENT_RETURN_ORIGIN)
        .useValue('https://app.unresolved-22d3.example')
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
      auditModel = moduleFixture.get(
        getModelToken(SubscriptionPaymentReconciliation.name),
      );
      payments = moduleFixture.get(SubscriptionPaymentsService);
      reconciliation = moduleFixture.get(PaymentReconciliationService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    nextWindow();
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    fake.nextCreate = 'normal';
    fake.statusOutage = false;
    fake.unlisted.clear();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. inspection et simulation sans référence : recherche sans résultat affichée, jamais une preuve ; aucune écriture', async () => {
    const o = await owner('inspect');
    const p = await uncertain(o.token, 'rate-limited');
    const inspected = await reconciliation.inspect(p.id);
    expect(inspected).toMatchObject({
      status: 'uncertain',
      reconcilable: true,
      providerReference: null,
      incidentCode: SubscriptionPaymentIncident.INITIATION_UNCERTAIN,
    });
    const before = await doc(p.id);
    const plan = await reconciliation.plan(p.id, null);
    expect(plan).toMatchObject({
      decision: 'blocked',
      reason: 'lookup-not-found',
      lookup: {
        outcome: 'not-found',
        providerReference: null,
        proofOfAbsence: false,
      },
    });
    expect(await doc(p.id)).toEqual(before);
    expect(await auditModel.countDocuments({ paymentId: p.id })).toBe(0);
  });

  it('2. session retrouvée par sa référence marchand : rattachée (audit, idempotent), sans nouvelle création, puis payée une fois', async () => {
    const o = await owner('found');
    const p = await uncertain(o.token, 'rate-limited-after-create');
    const posts = creations();
    const plan = await reconciliation.plan(p.id, null);
    expect(plan).toMatchObject({
      decision: 'ready',
      action: 'mark-pending',
      consultedReference: p.session!.id,
      referenceAttach: true,
      lookup: { outcome: 'found', providerReference: p.session!.id },
    });
    if (plan.decision !== 'ready') throw new Error('plan');
    const op = operation(
      ReconciliationReason.UNCERTAIN_INITIATION,
      plan.planToken,
    );
    const applied = await reconciliation.apply(p.id, null, op);
    expect(applied).toMatchObject({
      result: 'applied',
      referenceAttached: true,
    });
    expect((await doc(p.id))!).toMatchObject({
      status: 'pending',
      providerReference: p.session!.id,
    });
    expect(await reconciliation.apply(p.id, null, op)).toMatchObject({
      result: 'replayed',
    });
    expect(creations()).toBe(posts);

    fake.attempt(p.session!.id, 'SUCCESS');
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('3. référence fournie par l’opérateur : rattachée seulement si SA session porte cette référence marchand', async () => {
    const o = await owner('candidate');
    const p = await uncertain(o.token, 'rate-limited-after-create');
    const foreign = fake.addForeignSession('SM-SOMEONE-ELSE', '3500.00');
    const refused = await reconciliation.plan(p.id, foreign);
    expect(refused).toMatchObject({
      decision: 'blocked',
      reason: 'mismatch',
      mismatches: expect.arrayContaining(['merchantReference']),
    });
    const accepted = await reconciliation.plan(p.id, p.session!.id);
    expect(accepted).toMatchObject({
      decision: 'ready',
      action: 'mark-pending',
      referenceAttach: true,
    });
  });

  it('4. recherche indisponible ou incomplète : aucune clôture, aucune écriture', async () => {
    const o = await owner('incomplete');
    const p = await uncertain(o.token, 'rate-limited');
    const before = await doc(p.id);

    fake.statusOutage = true;
    expect(await reconciliation.plan(p.id, null, closure)).toMatchObject({
      decision: 'blocked',
      reason: 'lookup-unavailable',
      lookup: { outcome: 'unavailable' },
    });
    fake.statusOutage = false;

    // Plus de 5 pages de 100 sessions : borne atteinte.
    const added: string[] = [];
    for (let i = 0; i < 501; i += 1) {
      added.push(fake.addForeignSession(`SM-FILLER-${i}`));
    }
    try {
      nextWindow();
      expect(await reconciliation.plan(p.id, null, closure)).toMatchObject({
        decision: 'blocked',
        reason: 'lookup-incomplete',
        lookup: { outcome: 'incomplete', pagesRead: 5, proofOfAbsence: false },
      });
    } finally {
      for (const id of added) fake.sessions.delete(id);
    }
    expect(await doc(p.id)).toEqual(before);
  });

  it('5. clôture : preuve et motif exigés ; simulation sans écriture ; application auditée, idempotente, liens conservés', async () => {
    const o = await owner('close');
    const p = await uncertain(o.token, 'rate-limited');
    const before = (await doc(p.id))!;

    // Sans l'option, une recherche vide ne permet rien.
    expect(await reconciliation.plan(p.id, null)).toMatchObject({
      reason: 'lookup-not-found',
    });
    // Option sans preuve.
    expect(
      await reconciliation.plan(p.id, null, { closeWithoutSessionProof: '' }),
    ).toMatchObject({ decision: 'blocked', reason: 'proof-required' });

    const plan = await reconciliation.plan(p.id, null, closure);
    expect(plan).toMatchObject({
      decision: 'ready',
      action: 'close-without-session',
      consultedReference: null,
      verified: null,
      after: { status: 'failed', open: false, grantsPeriod: false },
      lookup: { outcome: 'not-found', proofOfAbsence: false },
    });
    if (plan.decision !== 'ready') throw new Error('plan');
    expect(await doc(p.id)).toEqual(before);

    // Motif ou preuve différents de la simulation : refus, aucune écriture.
    for (const op of [
      operation(ReconciliationReason.SUPPORT_TICKET, plan.planToken, PROOF),
      operation(
        ReconciliationReason.PROVIDER_NO_SESSION,
        plan.planToken,
        'saspay-support:TCK-99999',
      ),
    ]) {
      await expect(
        reconciliation.apply(p.id, null, op, closure),
      ).rejects.toMatchObject({ code: 'PROOF_REQUIRED' });
    }
    expect(await doc(p.id)).toEqual(before);

    const op = operation(
      ReconciliationReason.PROVIDER_NO_SESSION,
      plan.planToken,
      PROOF,
    );
    const applied = await reconciliation.apply(p.id, null, op, closure);
    expect(applied).toMatchObject({
      result: 'applied',
      action: 'close-without-session',
      consultedReference: null,
      after: { status: 'failed', providerReference: null, periodId: null },
    });
    const after = (await doc(p.id))!;
    expect(after).toMatchObject({
      status: 'failed',
      open: false,
      incidentCode: SubscriptionPaymentIncident.CHECKOUT_CLOSED,
      merchantReference: before.merchantReference,
      clientOperationId: before.clientOperationId,
      providerReference: null,
    });
    expect(String(after.renewalId)).toBe(String(before.renewalId));
    const audit = await auditModel
      .findOne({ operationId: op.operationId })
      .lean();
    expect(audit).toMatchObject({
      reasonCode: 'provider-no-session',
      reasonTicket: PROOF,
      action: 'close-without-session',
      consultedReference: null,
      verifiedState: 'no-session',
      verifiedMerchantReference: before.merchantReference,
    });
    expect(await reconciliation.apply(p.id, null, op, closure)).toMatchObject({
      result: 'replayed',
    });
    // Plus applicable une fois close.
    expect(await reconciliation.plan(p.id, null, closure)).toMatchObject({
      decision: 'blocked',
      reason: 'close-without-session-not-applicable',
    });
    // L'organisation peut de nouveau payer (aucune création par le CLI).
    expect((await create(o.token)).status).toBe(201);
  });

  it('6. succès concurrent à la clôture : plan obsolète, aucune clôture, une seule période', async () => {
    const o = await owner('race');
    const p = await uncertain(o.token, 'rate-limited-after-create');
    fake.unlisted.add(p.session!.id);
    const plan = await reconciliation.plan(p.id, null, closure);
    expect(plan.decision).toBe('ready');
    if (plan.decision !== 'ready') throw new Error('plan');

    // Entre simulation et application : la session réapparaît, est payée,
    // et le propriétaire vérifie (rattachement et attribution).
    fake.unlisted.delete(p.session!.id);
    fake.attempt(p.session!.id, 'SUCCESS');
    expect((await refresh(o.token, p.id)).body.status).toBe('succeeded');

    await expect(
      reconciliation.apply(
        p.id,
        null,
        operation(
          ReconciliationReason.PROVIDER_NO_SESSION,
          plan.planToken,
          PROOF,
        ),
        closure,
      ),
    ).resolves.toMatchObject({ decision: 'blocked' });
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('7. preuve démentie : succès tardif après clôture retrouvé par le rapprochement, attribué une fois', async () => {
    const o = await owner('late');
    const p = await uncertain(o.token, 'rate-limited-after-create');
    fake.unlisted.add(p.session!.id);
    const plan = await reconciliation.plan(p.id, null, closure);
    if (plan.decision !== 'ready') throw new Error('plan');
    await reconciliation.apply(
      p.id,
      null,
      operation(
        ReconciliationReason.PROVIDER_NO_SESSION,
        plan.planToken,
        PROOF,
      ),
      closure,
    );
    fake.unlisted.delete(p.session!.id);
    fake.attempt(p.session!.id, 'SUCCESS');
    nextWindow();
    await onlyCandidate(p.id);
    expect(await sweep()).toEqual({ examined: 1, failed: 0 });
    expect((await doc(p.id))!.status).toBe('succeeded');
    await onlyCandidate(p.id);
    await sweep();
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('8. nouvelle tentative après clôture, puis succès tardif de l’ancienne : une seule attribution du renouvellement ; remboursement consigné → jamais attribué', async () => {
    const o = await owner('renewal');
    const old = await uncertain(o.token, 'rate-limited-after-create');
    fake.unlisted.add(old.session!.id);
    const plan = await reconciliation.plan(old.id, null, closure);
    if (plan.decision !== 'ready') throw new Error('plan');
    await reconciliation.apply(
      old.id,
      null,
      operation(
        ReconciliationReason.PROVIDER_NO_SESSION,
        plan.planToken,
        PROOF,
      ),
      closure,
    );

    const next = await create(o.token);
    expect(next.status).toBe(201);
    const nextId = next.body.paymentId as string;
    const nextRow = (await doc(nextId))!;
    // Liens 1-21E : même renouvellement, remplace l'ancienne tentative.
    expect(String(nextRow.renewalId)).toBe(
      String((await doc(old.id))!.renewalId ?? old.id),
    );
    expect(String(nextRow.replacesPaymentId)).toBe(old.id);
    fake.attempt(nextRow.providerReference!, 'SUCCESS');
    expect((await refresh(o.token, nextId)).body.status).toBe('succeeded');

    // L'ancienne session était payable : succès tardif.
    fake.unlisted.delete(old.session!.id);
    fake.attempt(old.session!.id, 'SUCCESS');
    nextWindow();
    expect((await refresh(o.token, old.id)).body).toMatchObject({
      status: 'review',
      collected: true,
      situation: 'collected-in-resolution',
    });
    expect(await periodsFor(old.id)).toBe(0);
    expect(await periodsFor(nextId)).toBe(1);

    // Remboursement consigné (procédure 1-21E) : plus aucune attribution.
    const refund = await reconciliation.plan(old.id, null, {
      recordRefund: true,
    });
    if (refund.decision !== 'ready') throw new Error('refund plan');
    await reconciliation.apply(
      old.id,
      null,
      operation(
        ReconciliationReason.REFUNDED_OUTSIDE,
        refund.planToken,
        'saspay-refund:RF-77',
      ),
      { recordRefund: true },
    );
    expect(
      await reconciliation.plan(old.id, null, {
        grantRenewalConflict: 'additional',
      }),
    ).toMatchObject({ decision: 'blocked', reason: 'refunded' });
    expect((await refresh(o.token, old.id)).body.situation).toBe('refunded');
    expect(await periodsFor(old.id)).toBe(0);
  });

  it('9. webhook avant rattachement : accusé sans rattachement ni période (aucun champ authentifié ne désigne la tentative) ; récupération par le rapprochement, une seule période', async () => {
    const o = await owner('webhook');
    const p = await uncertain(o.token, 'rate-limited-after-create');
    const tx = fake.attempt(p.session!.id, 'SUCCESS');
    const calls = fake.calls.length;
    const res = await notify(tx);
    // Aucune vérification déclenchée pour cette tentative par la notification.
    expect(
      fake.calls.slice(calls).some((c) => c.path.includes(p.session!.id)),
    ).toBe(false);
    expect([200, 503]).toContain(res.status);
    expect((await doc(p.id))!).toMatchObject({
      status: 'uncertain',
      providerReference: null,
      providerTransactionId: null,
    });
    expect(await periodsFor(p.id)).toBe(0);

    // Rapprochement : retrouvée par SA référence marchand, relue, attribuée.
    nextWindow();
    await onlyCandidate(p.id);
    expect(await sweep()).toEqual({ examined: 1, failed: 0 });
    expect((await doc(p.id))!).toMatchObject({
      status: 'succeeded',
      providerReference: p.session!.id,
      providerTransactionId: tx,
    });
    // Renvoi ultérieur : transaction rattachée, état local terminal.
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    expect((await notify(tx)).status).toBe(200);
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('11. deux créations incertaines concurrentes (A puis B, plus récente) : webhook de A, rejeu, rapprochement, transaction étrangère', async () => {
    const a = await owner('concurrent-a');
    const b = await owner('concurrent-b');
    const pa = await uncertain(a.token, 'rate-limited-after-create');
    // B, plus récente : aucune session créée (429 sans création).
    const pb = await uncertain(b.token, 'rate-limited');
    expect(pb.session).toBeNull();
    const txA = fake.attempt(pa.session!.id, 'SUCCESS');
    const callsOn = (from: number) => {
      const slice = fake.calls.slice(from);
      return {
        total: slice.length,
        lookups: slice.filter((c) => c.path === '/checkout-sessions/').length,
        sessionA: slice.filter((c) => c.path.includes(pa.session!.id)).length,
      };
    };
    const state = async (id: string) => {
      const row = (await doc(id))!;
      return {
        status: row.status,
        providerReference: row.providerReference,
        providerTransactionId: row.providerTransactionId ?? null,
      };
    };
    const log: unknown[] = [];
    /** Livraisons de webhook : réponse et appels qu'elles ont déclenchés. */
    const deliveries: { http: number; calls: ReturnType<typeof callsOn> }[] =
      [];

    // 3. Webhook de succès de A, puis rejeu.
    let from = fake.calls.length;
    const first = await notify(txA);
    deliveries.push({ http: first.status, calls: callsOn(from) });
    log.push({
      step: 'webhook A',
      http: first.status,
      calls: callsOn(from),
      A: await state(pa.id),
      B: await state(pb.id),
    });
    for (let i = 0; i < 3; i += 1) {
      from = fake.calls.length;
      const replay = await notify(txA);
      deliveries.push({ http: replay.status, calls: callsOn(from) });
      log.push({
        step: `rejeu A ${i + 1}`,
        http: replay.status,
        calls: callsOn(from),
        A: await state(pa.id),
        B: await state(pb.id),
      });
    }

    // 6. Transaction étrangère pendant que A et B sont récentes.
    const foreignSession = fake.addForeignSession('SM-FOREIGN-22D3');
    const foreignTx = fake.attempt(foreignSession, 'SUCCESS');
    from = fake.calls.length;
    const foreign = await notify(foreignTx);
    deliveries.push({ http: foreign.status, calls: callsOn(from) });
    log.push({ step: 'étrangère', http: foreign.status, calls: callsOn(from) });

    // 5. Rapprochement (passes successives, comme en production).
    for (
      let pass = 0;
      pass < 6 &&
      (await doc(pa.id))!.status !== SubscriptionPaymentStatus.SUCCEEDED;
      pass += 1
    ) {
      nextWindow();
      from = fake.calls.length;
      const report = await sweep();
      log.push({
        step: `rapprochement ${pass + 1}`,
        report,
        calls: callsOn(from),
        A: await state(pa.id),
        B: await state(pb.id),
      });
    }
    console.log('MESURE 11', JSON.stringify(log, null, 1));

    // Aucune transaction ni session affectée à la mauvaise organisation.
    for (const [tx, owner] of [
      [txA, pa.id],
      [foreignTx, null],
    ] as const) {
      const holders = await paymentModel
        .find({ providerTransactionId: tx })
        .select({ _id: 1 })
        .lean()
        .exec();
      expect(holders.map((h) => String(h._id))).toEqual(owner ? [owner] : []);
    }
    expect((await doc(pa.id))!.providerReference).toBe(pa.session!.id);
    expect((await doc(pb.id))!).toMatchObject({
      status: 'uncertain',
      providerReference: null,
      providerTransactionId: null,
    });
    // A récupérée ; une seule période ; B jamais attribuée.
    expect((await doc(pa.id))!.status).toBe('succeeded');
    expect(await periodsFor(pa.id)).toBe(1);
    expect(await periodsFor(pb.id)).toBe(0);
    // Aucune livraison ne cherche ni ne lit une tentative SANS référence
    // (aucune candidature temporelle) ; appels bornés aux candidats 1-21B
    // (au plus 3 paiements à session connue, 3 lectures chacun) ; réponse
    // accusé ou « renvoyer plus tard », jamais un accusé pour A par la
    // confirmation d'un autre paiement.
    for (const delivery of deliveries) {
      expect([200, 503]).toContain(delivery.http);
      expect(delivery.calls.lookups).toBe(0);
      expect(delivery.calls.sessionA).toBe(0);
      expect(delivery.calls.total).toBeLessThanOrEqual(
        SASPAY_WEBHOOK_MAX_CANDIDATES * 3,
      );
    }
  });

  it('10. état changé entre simulation et application : clôture refusée, aucune mutation', async () => {
    const o = await owner('stale');
    const p = await uncertain(o.token, 'rate-limited');
    const plan = await reconciliation.plan(p.id, null, closure);
    if (plan.decision !== 'ready') throw new Error('plan');
    await paymentModel.updateOne(
      { _id: p.id },
      { $set: { status: SubscriptionPaymentStatus.REVIEW } },
    );
    await expect(
      reconciliation.apply(
        p.id,
        null,
        operation(
          ReconciliationReason.PROVIDER_NO_SESSION,
          plan.planToken,
          PROOF,
        ),
        closure,
      ),
    ).resolves.toMatchObject({
      decision: 'blocked',
      reason: 'close-without-session-not-applicable',
    });
    expect((await doc(p.id))!.status).toBe('review');
  });
});
