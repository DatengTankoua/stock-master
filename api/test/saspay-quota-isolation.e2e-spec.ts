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
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './../src/events/origin.helpers';
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
import type { PaymentCallPermit } from './../src/subscriptions/payments/payment-call-budget';
import { SasPayPaymentProvider } from './../src/subscriptions/payments/saspay/saspay-payment-provider';
import type { SasPayTransport } from './../src/subscriptions/payments/saspay/saspay-transport';
import {
  SASPAY_WEBHOOK_CONFIG,
  SASPAY_WEBHOOK_REPEAT_WINDOW_MS,
} from './../src/subscriptions/payments/saspay/saspay-webhook.service';
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
 * 1-22D — Quota SasPay entre organisations (piste 3 de 1-22A), contre un
 * FAUX SasPay (transport de l'adaptateur réel), base éphémère et horloges
 * contrôlées : monotone (budget d'appels) et murale (webhooks).
 */

const TEST_JWT_SECRET = 'saspay-quota-22d-e2e-only-secret-value';
const WEBHOOK_SECRET = 'saspay-webhook-secret-22d-e2e-only';
const PASSWORD = 'pay-22d-pw-!1x';
/** 1-22H.1 : origine du web (autorisée) et origine étrangère. */
const WEB_ORIGIN = 'https://saspay-22d.example.com';
const FOREIGN_ORIGIN = 'https://attacker.example.com';
const LIMITS = PAYMENT_CALL_LIMITS;

const fake = new FakeSasPay();
let monotonicOffset = 0;
let wallOffset = 0;
/** Réponse RETENUE (lue avant un changement) jusqu'à `release`. */
let hold: {
  match: (url: string) => boolean;
  reached: () => void;
  gate: Promise<void>;
} | null = null;
const transport: SasPayTransport = async (req) => {
  const res = await fake.transport(req);
  const held = hold;
  if (held && held.match(req.url)) {
    hold = null;
    held.reached();
    await held.gate;
  }
  return res;
};
const provider = new SasPayPaymentProvider({
  environment: 'sandbox',
  secretKey: FAKE_SASPAY_KEY,
  transport,
  monotonic: () => performance.now() + monotonicOffset,
});
const budget = provider.callAdmission!.budget;

describe('Quota SasPay entre organisations (e2e 1-22D)', () => {
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
  /** Réservations d'organisations FICTIVES (activité des autres). */
  const fills: PaymentCallPermit[] = [];

  async function owner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-22d@pay.test`;
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

  /** Requête propriétaire ; `throttle: false` isole le quota d'appels. */
  const post = (
    token: string,
    path: string,
    body?: object,
    options: { throttle?: boolean } = {},
  ) => {
    if (options.throttle === false) clearThrottle();
    return request(server())
      .post(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  };
  const create = (token: string, clientOperationId: string = randomUUID()) =>
    post(
      token,
      '',
      { term: 'monthly', clientOperationId },
      { throttle: false },
    );
  const refresh = (token: string, id: string) =>
    post(token, `/${id}/refresh`, undefined, { throttle: false });
  const abandon = (token: string, id: string) =>
    post(token, `/${id}/abandon`, undefined, { throttle: false });

  const doc = (id: string) => paymentModel.findById(id).lean().exec();
  const rowsOf = (orgId: string) =>
    paymentModel.countDocuments({ organizationId: orgId }).exec();
  const periodsFor = (id: string) =>
    periodModel
      .countDocuments({
        source: SubscriptionSource.PAYMENT,
        sourceReference: `payment:${id}`,
      })
      .exec();

  function notify(transactionId: string, name = 'transaction.success') {
    clearThrottle();
    const raw = JSON.stringify({
      event: name,
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
      .set('X-Webhook-Event', name)
      .send(raw);
  }

  async function pending(token: string) {
    const res = await create(token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    const id = res.body.paymentId as string;
    return { id, session: (await doc(id))!.providerReference! };
  }

  /** Seul `id` est candidat au rapprochement (autres cas déjà vérifiés). */
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
  const sweepNow = () =>
    payments.sweepOnce({
      limit: 10,
      staleMs: 600_000,
      lateWindowMs: 3_600_000,
    });
  /** Quota de l'organisation entièrement consommé (fenêtre neuve). */
  function exhaustOrganization(orgId: string) {
    monotonicOffset += LIMITS.windowMs + 1_000;
    const decision = budget.reserve(orgId, LIMITS.perOrganization);
    if (!decision.admitted) throw new Error('quota déjà entamé');
    fills.push(decision.permit);
  }
  /** Retient la réponse du premier appel dont l'URL contient `fragment`. */
  function holdOn(fragment: string) {
    let release!: () => void;
    let reached!: () => void;
    const atHold = new Promise<void>((r) => (reached = r));
    hold = {
      match: (url) => url.includes(fragment),
      reached: () => reached(),
      gate: new Promise<void>((r) => (release = r)),
    };
    return { atHold, release: () => release() };
  }

  /** Occupe `calls` appels de la voie propriétaire (autres organisations). */
  function fillOwnerLane(calls: number) {
    for (let i = 0; calls > 0; i += 1) {
      const n = Math.min(calls, LIMITS.perOrganization);
      const decision = budget.reserve(`other-org-${i}-${randomUUID()}`, n);
      if (!decision.admitted) throw new Error('remplissage refusé');
      fills.push(decision.permit);
      calls -= n;
    }
  }
  /** Consomme `calls` appels hors action propriétaire (confirmations). */
  function fillConfirmationLane(calls: number) {
    for (let i = 0; i < calls; i += 1) {
      if (!budget.take()) throw new Error('remplissage refusé');
    }
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.CORS_ORIGIN = WEB_ORIGIN;
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
        .useValue('https://app.saspay-22d.example')
        .compile();
      app = moduleFixture.createNestApplication(API_APPLICATION_OPTIONS);
      // 1-22H.1 : MÊME factory CORS que main.ts, au même endroit (avant les
      // pipes, filtres et routes) : les 429/503 servis ici portent les
      // en-têtes CORS réels de la production.
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(WEB_ORIGIN, 'production')),
        ),
      );
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
      paymentModel = moduleFixture.get(getModelToken(SubscriptionPayment.name));
      periodModel = moduleFixture.get(getModelToken(SubscriptionPeriod.name));
      payments = moduleFixture.get(SubscriptionPaymentsService);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    // Fenêtres vides à chaque cas (horloges avancées, rien n'est attendu).
    monotonicOffset += LIMITS.windowMs + 1_000;
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    fills.splice(0).forEach((p) => p.release());
    fake.rateLimited = false;
    fake.statusOutage = false;
    fake.nextCreate = 'normal';
    hold = null;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('0. reproduction 1-22A : deux propriétaires en boucle ; B paie, C est confirmé', async () => {
    const attackers = [await owner('a1'), await owner('a2')];
    const b = await owner('b');
    const c = await owner('c');
    const cPayment = await pending(c.token);
    monotonicOffset += LIMITS.windowMs + 1_000;
    const start = fake.calls.length;
    const codes: Record<string, number> = {};
    const count = (key: string) => (codes[key] = (codes[key] ?? 0) + 1);
    const limited: string[] = [];
    for (const a of attackers) {
      // Limites des routes respectées (10 / min par route) : même scénario
      // que la reproduction de 1-22A, sans remise à zéro.
      clearThrottle();
      let last: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const created = await post(a.token, '', {
          term: 'monthly',
          clientOperationId: randomUUID(),
        });
        count(`create ${created.status}`);
        if (created.status === 429)
          limited.push(created.headers['retry-after']);
        if (created.status !== 201) continue;
        last = created.body.paymentId as string;
        const abandoned = await post(a.token, `/${last}/abandon`);
        count(`abandon ${abandoned.status}`);
        if (abandoned.status === 429) {
          limited.push(abandoned.headers['retry-after']);
        }
      }
      for (let i = 0; i < 10 && last; i += 1) {
        const refreshed = await post(a.token, `/${last}/refresh`);
        count(`refresh ${refreshed.status}`);
      }
    }
    const attackerCalls = fake.calls.length - start;

    const bStart = fake.calls.length;
    const bCreate = await create(b.token);
    const bCreateCalls = fake.calls.length - bStart;
    const bRefresh = await refresh(b.token, bCreate.body.paymentId as string);

    fake.attempt(cPayment.session, 'SUCCESS');
    await onlyCandidate(cPayment.id);
    const sweep = await sweepNow();
    const cStored = await doc(cPayment.id);
    console.log(
      'MESURE',
      JSON.stringify({
        attackerCalls,
        attackerResponses: codes,
        bCreate: { status: bCreate.status, sasPayCalls: bCreateCalls },
        bRefresh: bRefresh.status,
        cSweep: { ...sweep, status: cStored?.status },
      }),
    );

    // Chaque attaquant plafonné à SON quota ; refus 429 avec délai.
    expect(attackerCalls).toBeLessThanOrEqual(2 * LIMITS.perOrganization);
    expect(limited.length).toBeGreaterThan(0);
    for (const retry of limited) {
      expect(Number(retry)).toBeGreaterThanOrEqual(1);
      expect(Number(retry)).toBeLessThanOrEqual(60);
    }
    // Aucun paiement fermé à cause d'un quota.
    expect(
      await paymentModel
        .countDocuments({
          incidentCode: SubscriptionPaymentIncident.PROVIDER_UNAVAILABLE,
        })
        .exec(),
    ).toBe(0);
    expect(bCreate.status).toBe(201);
    expect(bCreate.body.status).toBe('pending');
    expect(bCreateCalls).toBe(1);
    expect(bRefresh.status).toBe(200);
    expect(sweep).toEqual({ examined: 1, failed: 0 });
    expect(cStored!.status).toBe(SubscriptionPaymentStatus.SUCCEEDED);
    expect(await periodsFor(cPayment.id)).toBe(1);
  });

  it('1. alternance création / vérification / abandon : un seul compteur par organisation, puis reprise', async () => {
    const a = await owner('alt');
    monotonicOffset += LIMITS.windowMs + 1_000;
    const start = fake.calls.length;
    const statuses: number[] = [];
    let current = await pending(a.token);
    statuses.push(201);
    let refusal: request.Response | null = null;
    // Limites des routes neutralisées : seul le quota d'appels joue.
    for (let i = 0; i < 20 && !refusal; i += 1) {
      const step = i % 3;
      const res =
        step === 0
          ? await refresh(a.token, current.id)
          : step === 1
            ? await abandon(a.token, current.id)
            : await create(a.token);
      statuses.push(res.status);
      if (res.status === 429) refusal = res;
      else if (step === 2 && res.status === 201) {
        current = { id: res.body.paymentId as string, session: '' };
      }
    }
    expect(refusal).not.toBeNull();
    expect(refusal!.body).toMatchObject({
      statusCode: 429,
      code: 'PAYMENT_RATE_LIMITED',
    });
    expect(Number(refusal!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(fake.calls.length - start).toBeLessThanOrEqual(
      LIMITS.perOrganization,
    );
    // Aucune route ne contourne le compteur commun.
    const calls = fake.calls.length;
    for (const res of [
      await refresh(a.token, current.id),
      await abandon(a.token, current.id),
      await create(a.token),
    ]) {
      expect([409, 429]).toContain(res.status);
    }
    expect(fake.calls.length).toBe(calls);
    // Reprise après la fenêtre.
    monotonicOffset += LIMITS.windowMs;
    expect((await refresh(a.token, current.id)).status).toBe(200);
  });

  it('2. création refusée par le quota : aucune ligne ; même intention rejouée ensuite → un seul paiement', async () => {
    const a = await owner('intent');
    await pending(a.token).then((p) => abandon(a.token, p.id));
    exhaustOrganization(a.orgId);
    const rows = await rowsOf(a.orgId);
    const sessions = fake.sessions.size;
    const intent = randomUUID();
    const refused = await create(a.token, intent).set('Origin', WEB_ORIGIN);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('PAYMENT_RATE_LIMITED');
    // 1-22H.1 : délai lisible par le web (origine distincte de l'API).
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(refused.headers['access-control-expose-headers']).toBe(
      'Retry-After',
    );
    // Origine étrangère : même refus, aucun en-tête CORS (rien de lisible).
    exhaustOrganization(a.orgId);
    const foreign = await create(a.token, intent).set('Origin', FOREIGN_ORIGIN);
    expect(foreign.status).toBe(429);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.headers['access-control-expose-headers']).toBeUndefined();
    expect(await rowsOf(a.orgId)).toBe(rows);
    expect(fake.sessions.size).toBe(sessions);

    monotonicOffset += LIMITS.windowMs + 1_000;
    const accepted = await create(a.token, intent);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ status: 'pending', replayed: false });
    const replay = await create(a.token, intent);
    expect(replay.body).toMatchObject({
      paymentId: accepted.body.paymentId,
      replayed: true,
    });
    expect(await rowsOf(a.orgId)).toBe(rows + 1);
    expect(fake.sessions.size).toBe(sessions + 1);
  });

  it('3. voie propriétaire saturée par d’autres : B reçoit 503 + délai fixe, rien ne change ; sa confirmation reste servie', async () => {
    const b = await owner('lane');
    const newcomer = await owner('lane-new');
    const open = await pending(b.token);
    monotonicOffset += LIMITS.windowMs + 1_000;
    fillOwnerLane(LIMITS.ownerLane);
    const rows = await rowsOf(newcomer.orgId);
    const calls = fake.calls.length;

    const created = await create(newcomer.token).set('Origin', WEB_ORIGIN);
    expect(created.status).toBe(503);
    expect(created.body.code).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    expect(created.headers['retry-after']).toBe(
      String(LIMITS.capacityRetryAfterSeconds),
    );
    // 1-22H.1 : délai de capacité lisible par le web.
    expect(created.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(created.headers['access-control-expose-headers']).toBe(
      'Retry-After',
    );
    // Aucune information sur l'activité des autres organisations.
    expect(Object.keys(created.body).sort()).toEqual([
      'code',
      'error',
      'message',
      'path',
      'statusCode',
      'timestamp',
    ]);
    const checked = await refresh(b.token, open.id);
    expect(checked.status).toBe(503);
    expect(checked.body.code).toBe('PAYMENT_STATUS_UNAVAILABLE');
    expect(checked.headers['retry-after']).toBe(
      String(LIMITS.capacityRetryAfterSeconds),
    );
    const changed = await abandon(b.token, open.id);
    expect(changed.status).toBe(503);
    expect(fake.calls.length).toBe(calls);
    expect(await rowsOf(newcomer.orgId)).toBe(rows);
    expect((await doc(open.id))!.status).toBe('pending');

    // Le payeur paie : la notification est vérifiée sur la voie réservée.
    const tx = fake.attempt(open.session, 'SUCCESS');
    const res = await notify(tx);
    expect(res.status).toBe(200);
    expect((await doc(open.id))!.status).toBe('succeeded');
    expect(await periodsFor(open.id)).toBe(1);

    // Reprise : les autres ont fini.
    fills.splice(0).forEach((p) => p.release());
    expect((await create(newcomer.token)).status).toBe(201);
  });

  it('4. épuisement global : propriétaires gardent leur part, puis rapprochement suspendu sans perte et repris', async () => {
    const b = await owner('global');
    const p = await pending(b.token);
    // Confirmations au maximum de leur voie : les propriétaires gardent 20.
    fillConfirmationLane(LIMITS.confirmationLane);
    expect((await refresh(b.token, p.id)).status).toBe(200);
    // Plafond global atteint.
    fillOwnerLane(LIMITS.global - LIMITS.confirmationLane - 3);
    expect(budget.take()).toBe(false);

    const tx = fake.attempt(p.session, 'SUCCESS');
    await onlyCandidate(p.id);
    const calls = fake.calls.length;
    const sweep = await sweepNow();
    // Rien réservé, rien lu : le paiement reste candidat.
    expect(sweep).toEqual({ examined: 0, failed: 0 });
    expect((await doc(p.id))!.lastCheckedAt).toBeNull();
    const notified = await notify(tx);
    expect(notified.status).toBe(503);
    expect(notified.headers['retry-after']).toBeDefined();
    expect(fake.calls.length).toBe(calls);
    expect((await doc(p.id))!.status).toBe('pending');

    // Fenêtre écoulée : reprise du rapprochement.
    monotonicOffset += LIMITS.windowMs + 1_000;
    expect(await sweepNow()).toEqual({ examined: 1, failed: 0 });
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('5. doublons : vérifications simultanées regroupées, réservations rendues ; webhooks identiques bornés', async () => {
    const b = await owner('dup');
    const p = await pending(b.token);
    const tx = fake.attempt(p.session, 'PENDING');
    monotonicOffset += LIMITS.windowMs + 1_000;
    let calls = fake.calls.length;
    // La première vérification est retenue pendant l'arrivée des autres.
    const held = holdOn(`/checkout-sessions/${p.session}/`);
    const first = refresh(b.token, p.id).then((r) => r);
    await held.atHold;
    const others = Array.from({ length: 4 }, () =>
      refresh(b.token, p.id).then((r) => r),
    );
    await new Promise((r) => setTimeout(r, 200));
    held.release();
    const concurrent = await Promise.all([first, ...others]);
    expect(concurrent.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // Une seule lecture (détail, statut, transaction).
    expect(fake.calls.length - calls).toBe(3);
    // Les parts non utilisées sont rendues : le reste du quota est libre.
    const rest = budget.reserve(b.orgId, LIMITS.perOrganization - 3);
    expect(rest.admitted).toBe(true);
    if (rest.admitted) rest.permit.release();

    // Rafale de notifications identiques et authentiques.
    calls = fake.calls.length;
    const created = 'transaction.created';
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => notify(tx, created)),
    );
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(fake.calls.length - calls).toBe(3);
    calls = fake.calls.length;
    for (let i = 0; i < 10; i += 1) {
      expect((await notify(tx, created)).status).toBe(200);
    }
    expect(fake.calls.length).toBe(calls);
    // Autre événement : traité aussitôt.
    fake.settle(tx, 'SUCCESS');
    expect((await notify(tx, 'transaction.success')).status).toBe(200);
    expect((await doc(p.id))!.status).toBe('succeeded');
    // Après la fenêtre, une répétition est de nouveau vérifiée (aucun appel :
    // état local terminal).
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    calls = fake.calls.length;
    expect((await notify(tx)).status).toBe(200);
    expect(fake.calls.length).toBe(calls);
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('6. changement survenu pendant une vérification en cours : la notification le prend en compte', async () => {
    const b = await owner('race');
    const p = await pending(b.token);
    const tx = fake.attempt(p.session, 'PENDING');
    expect((await refresh(b.token, p.id)).body.status).toBe('pending');
    expect((await doc(p.id))!.providerTransactionId).toBe(tx);

    // La vérification du propriétaire lit `PENDING`, puis attend.
    const held = holdOn(`/payments/${tx}/verify/`);
    const slow = refresh(b.token, p.id).then((r) => r);
    await held.atHold;
    // Paiement abouti chez SasPay ; la notification arrive pendant ce temps.
    fake.settle(tx, 'SUCCESS');
    const notified = notify(tx).then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    held.release();
    expect((await slow).body.status).toBe('pending');
    expect((await notified).status).toBe(200);
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('7. refus 429 de SasPay : statut indisponible, pause courte sans création ni échec, puis reprise', async () => {
    const b = await owner('provider429');
    const p = await pending(b.token);
    fake.rateLimited = true;
    const checked = await refresh(b.token, p.id);
    expect(checked.status).toBe(503);
    expect(checked.body.code).toBe('PAYMENT_STATUS_UNAVAILABLE');
    expect((await doc(p.id))!.status).toBe('pending');
    fake.rateLimited = false;

    // Pause : refus LOCAL, aucun appel, aucune ligne.
    const calls = fake.calls.length;
    const rows = await rowsOf(b.orgId);
    const again = await refresh(b.token, p.id);
    expect(again.status).toBe(503);
    expect(again.headers['retry-after']).toBe(
      String(LIMITS.capacityRetryAfterSeconds),
    );
    expect(fake.calls.length).toBe(calls);
    expect(await rowsOf(b.orgId)).toBe(rows);
    await onlyCandidate(p.id);
    expect((await sweepNow()).examined).toBe(0);
    expect((await doc(p.id))!.lastCheckedAt).toBeNull();

    monotonicOffset += LIMITS.providerCooldownMs + 1;
    expect((await refresh(b.token, p.id)).status).toBe(200);
  });

  // ─── 1-22D.2 — `429` à la création : résultat incertain ────────────────────

  /** Création reçue `429` (après envoi) : tentative incertaine ouverte. */
  async function rateLimitedCreate(
    token: string,
    behavior: 'rate-limited' | 'rate-limited-after-create',
    clientOperationId: string = randomUUID(),
  ) {
    fake.nextCreate = behavior;
    const posts = creations();
    const res = await create(token, clientOperationId);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'uncertain',
      situation: 'checkout-link-missing',
      checkoutUrl: null,
      replayed: false,
    });
    expect(creations()).toBe(posts + 1);
    const id = res.body.paymentId as string;
    const row = (await doc(id))!;
    expect(row).toMatchObject({
      status: 'uncertain',
      open: true,
      incidentCode: SubscriptionPaymentIncident.INITIATION_UNCERTAIN,
      providerReference: null,
      clientOperationId,
    });
    return { id, reference: row.merchantReference, clientOperationId };
  }
  /** Créations de session envoyées (hors fermetures). */
  const creations = () =>
    fake.calls.filter(
      (c) => c.method === 'POST' && c.path === '/checkout-sessions/',
    ).length;
  /** Sessions SasPay portant la référence marchand de la tentative. */
  const sessionsFor = (reference: string) =>
    [...fake.sessions.values()].filter(
      (s) => s.metadata.merchantReference === reference,
    ).length;
  /** Pause locale après le `429` écoulée. */
  const afterCooldown = () => {
    monotonicOffset += LIMITS.providerCooldownMs + 1;
  };

  it('7bis. refus du budget LOCAL avant envoi : aucun appel, aucune tentative', async () => {
    const b = await owner('local-refusal');
    exhaustOrganization(b.orgId);
    const calls = fake.calls.length;
    const res = await create(b.token);
    expect(res.status).toBe(429);
    expect(fake.calls.length).toBe(calls);
    expect(await rowsOf(b.orgId)).toBe(0);
    // Capacité (pause après un 429) : même absence d'effet.
    fills.splice(0).forEach((p) => p.release());
    budget.providerThrottled();
    const paused = await create(b.token);
    expect(paused.status).toBe(503);
    expect(fake.calls.length).toBe(calls);
    expect(await rowsOf(b.orgId)).toBe(0);
  });

  it('7ter. 429 SasPay sans session retrouvée : incertaine et ouverte ; rejeu, abandon et nouvelle création ne contournent rien', async () => {
    const b = await owner('429-none');
    const sessions = fake.sessions.size;
    const p = await rateLimitedCreate(b.token, 'rate-limited');
    expect(fake.sessions.size).toBe(sessions);

    // Pause conservée : vérification refusée localement, sans appel.
    const calls = fake.calls.length;
    const paused = await refresh(b.token, p.id);
    expect(paused.status).toBe(503);
    expect(paused.headers['retry-after']).toBe(
      String(LIMITS.capacityRetryAfterSeconds),
    );
    expect(fake.calls.length).toBe(calls);

    afterCooldown();
    // Recherche bornée sans résultat : jamais une preuve d'absence.
    const looked = fake.calls.length;
    const checked = await refresh(b.token, p.id);
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ status: 'uncertain' });
    expect(fake.calls.length).toBeGreaterThan(looked);

    // Rejeu de la même opération : même tentative, aucune création.
    const posts = creations();
    const replay = await create(b.token, p.clientOperationId);
    expect(replay.body).toMatchObject({ paymentId: p.id, replayed: true });
    // Nouvelle opération : refusée tant que la tentative est ouverte.
    const other = await create(b.token);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
    // Changement de forfait : rien n'est fermé sans session retrouvée.
    const abandoned = await abandon(b.token, p.id);
    expect(abandoned.body.outcome).toBe('not-found-at-provider');
    // Rapprochement : même règle.
    await onlyCandidate(p.id);
    await sweepNow();
    expect(creations()).toBe(posts);
    expect(sessionsFor(p.reference)).toBe(0);
    expect((await doc(p.id))!).toMatchObject({
      status: 'uncertain',
      open: true,
    });
    expect(await rowsOf(b.orgId)).toBe(1);
  });

  it('7quater. session créée malgré le 429 : retrouvée par sa référence, rattachée, payée une fois', async () => {
    const b = await owner('429-created');
    const p = await rateLimitedCreate(b.token, 'rate-limited-after-create');
    const session = fake.sessionByReference(p.reference)!;
    expect(session).toBeDefined();

    afterCooldown();
    const found = await refresh(b.token, p.id);
    expect(found.body).toMatchObject({
      status: 'pending',
      situation: 'checkout-open',
    });
    expect(found.body.checkoutUrl).toContain(session.slug);
    expect((await doc(p.id))!.providerReference).toBe(session.id);

    fake.attempt(session.id, 'SUCCESS');
    expect((await refresh(b.token, p.id)).body.status).toBe('succeeded');
    expect(sessionsFor(p.reference)).toBe(1);
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('7quinquies. session visible seulement plus tard : d’abord introuvable, puis rattachée ; abandon seulement sur preuve', async () => {
    const b = await owner('429-late');
    const p = await rateLimitedCreate(b.token, 'rate-limited-after-create');
    const session = fake.sessionByReference(p.reference)!;
    fake.unlisted.add(session.id);
    afterCooldown();
    expect((await refresh(b.token, p.id)).body.status).toBe('uncertain');
    expect((await abandon(b.token, p.id)).body.outcome).toBe(
      'not-found-at-provider',
    );
    expect((await doc(p.id))!.open).toBe(true);

    fake.unlisted.delete(session.id);
    monotonicOffset += LIMITS.windowMs + 1_000;
    expect((await refresh(b.token, p.id)).body.status).toBe('pending');
    // Page retrouvée, ouverte et sans transaction : fermeture prouvée.
    const closed = await abandon(b.token, p.id);
    expect(closed.body.outcome).toBe('released');
    expect(session.status).toBe('CANCELLED');
  });

  it('7sexies. succès notifié pendant le rapprochement d’une tentative incertaine : une seule période', async () => {
    const b = await owner('429-webhook');
    const p = await rateLimitedCreate(b.token, 'rate-limited-after-create');
    const session = fake.sessionByReference(p.reference)!;
    const tx = fake.attempt(session.id, 'SUCCESS');
    afterCooldown();

    // Le rapprochement lit le succès, puis attend : la notification arrive.
    const held = holdOn(`/payments/${tx}/verify/`);
    await onlyCandidate(p.id);
    const sweeping = sweepNow();
    await held.atHold;
    const during = await notify(tx);
    expect([200, 503]).toContain(during.status);
    held.release();
    expect(await sweeping).toEqual({ examined: 1, failed: 0 });
    expect((await doc(p.id))!.status).toBe('succeeded');

    // Renvoi ultérieur de la notification : aucune seconde période.
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    expect((await notify(tx)).status).toBe(200);
    expect((await refresh(b.token, p.id)).body.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
    expect(sessionsFor(p.reference)).toBe(1);
  });

  it('8. timeout et réponse ambiguë : jamais un échec ; recherche bornée réservée', async () => {
    const b = await owner('ambiguous');
    fake.nextCreate = 'lost-after-create';
    const lost = await create(b.token);
    expect(lost.status).toBe(201);
    expect(lost.body.status).toBe('uncertain');
    const id = lost.body.paymentId as string;
    // Recherche par référence marchand (au plus 5 pages) + statut : 8 réservés.
    const found = await refresh(b.token, id);
    expect(found.body.status).toBe('pending');
    fake.statusOutage = true;
    const outage = await refresh(b.token, id);
    expect(outage.status).toBe(503);
    expect(outage.headers['retry-after']).toBeUndefined();
    expect((await doc(id))!.status).toBe('pending');
  });

  it('9. succès tardif sur une tentative close, quota de l’organisation épuisé : attribué une fois par la confirmation', async () => {
    const b = await owner('late');
    const p = await pending(b.token);
    const closed = await abandon(b.token, p.id);
    expect(closed.body.outcome).toBe('released');
    exhaustOrganization(b.orgId);
    expect((await refresh(b.token, p.id)).status).toBe(429);

    const tx = fake.lateTransaction(p.session, 'SUCCESS');
    expect((await notify(tx)).status).toBe(200);
    expect((await doc(p.id))!.status).toBe('succeeded');
    expect(await periodsFor(p.id)).toBe(1);
    wallOffset += SASPAY_WEBHOOK_REPEAT_WINDOW_MS + 1_000;
    expect((await notify(tx)).status).toBe(200);
    await onlyCandidate(p.id);
    await sweepNow();
    expect(await periodsFor(p.id)).toBe(1);
  });

  it('10. paiement remboursé (en résolution) : aucune admission, aucun appel, jamais attribué', async () => {
    const b = await owner('refunded');
    const p = await pending(b.token);
    const tx = fake.attempt(p.session, 'SUCCESS');
    await paymentModel.updateOne(
      { _id: p.id },
      {
        $set: {
          status: SubscriptionPaymentStatus.REVIEW,
          open: false,
          incidentCode: SubscriptionPaymentIncident.REFUNDED_OUTSIDE,
          providerTransactionId: tx,
          collectedAt: new Date(),
          refundedAt: new Date(),
        },
      },
    );
    exhaustOrganization(b.orgId);
    const calls = fake.calls.length;
    const res = await refresh(b.token, p.id);
    expect(res.status).toBe(200);
    expect(res.body.situation).toBe('refunded');
    expect((await notify(tx)).status).toBe(200);
    expect(fake.calls.length).toBe(calls);
    expect(await periodsFor(p.id)).toBe(0);
  });
});
