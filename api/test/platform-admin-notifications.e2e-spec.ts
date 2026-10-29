import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { Secret } from 'otpauth';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { ensurePlatformAdminIndexes } from '../src/platform-admin/platform-admin-indexes';
import { ensurePlatformAdminNotificationIndexes } from '../src/platform-admin/platform-admin-notification-indexes';
import { ensureSubscriptionPeriodIndexes } from '../src/subscriptions/subscription-period-indexes';
import { currentTotpCode } from '../src/platform-admin/totp';
import {
  parseCliArguments,
  runPlatformAdminCli,
} from '../src/migrations/platform-admin-cli';
import { PlatformAdminNotificationSweep } from '../src/platform-admin/platform-admin-notification-sweep.service';
import { CAMPAIGN_COMPLETION_GRACE_MS } from '../src/platform-admin/platform-admin-notifications';
import { PLATFORM_ADMIN_CLOCK } from '../src/platform-admin/platform-admin-runtime';
import {
  NOTIFICATION_MAX_CATCH_UP_MS,
  NOTIFICATION_SWEEP_OVERLAP_MS,
} from '../src/platform-admin/platform-admin-notification-sweep.service';

/**
 * E2E — notifications internes de l'administration : séparation avec les
 * commerces et MFA, filtrage par capacités (liste ET compteur), état de
 * lecture propre à chaque administrateur, déduplication des événements,
 * transaction annulée, règles des campagnes, borne de « tout marquer comme
 * lu », pagination, cible disparue, absence de données sensibles, migration
 * relançable sans notification rétroactive. Base éphémère, aucun envoi.
 */

const emailSender = createE2eEmailSender();
const PASSWORD = 'platform-notifications-e2e-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');

/** Horloge de l'administration (collecte comprise) ; décalage nul par défaut. */
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
const DAY_MS = 24 * 3_600_000;

interface Admin {
  userId: string;
  email: string;
  token: string;
}

interface Item {
  id: string;
  type: string;
  read: boolean;
  target: { kind: string; id: string; available: boolean };
  params: Record<string, unknown>;
}

describe('Administration de la plateforme — notifications internes (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let sweep: PlatformAdminNotificationSweep;
  let seq = 0;
  let ipSeq = 0;
  /** Commerce inscrit AVANT la première passe (jamais signalé). */
  let preexisting: string;

  const http = () => request(app.getHttpServer());
  const unique = (label: string) =>
    `${label}-${++seq}@platform-notifications.test`;
  const db = () => connection.db!;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const admin = (method: 'get' | 'post', path: string, token?: string) => {
    let req = http()
      [method](`/platform-admin${path}`)
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', '203.0.113.211');
    if (token) req = req.set('x-platform-admin-session', token);
    return req;
  };

  const cli = async (argv: string[]) => {
    const args = parseCliArguments(argv);
    if (typeof args === 'string') throw new Error(args);
    return runPlatformAdminCli(connection, args, process.env, new Date());
  };

  const reason = '--reason=Recette des notifications';

  async function createUser(): Promise<{ userId: string; email: string }> {
    const email = unique('user');
    const userId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name: 'Admin e2e',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
    });
    return { userId: userId.toHexString(), email };
  }

  async function passwordSession(email: string): Promise<string> {
    const login = await http()
      .post('/platform-admin/auth/login')
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', `198.51.100.${++ipSeq}`)
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return login.body.session.token as string;
  }

  async function enrolledAdmin(): Promise<Admin> {
    const { userId, email } = await createUser();
    await cli([
      'grant',
      `--user-id=${userId}`,
      reason,
      '--operator=e2e',
      '--apply',
    ]);
    const token = await passwordSession(email);
    const start = await admin('post', '/mfa/enrollment/start', token);
    const secret = Secret.fromBase32(
      start.body.manualKey.replace(/ /g, ''),
    ).bytes;
    const confirm = await admin('post', '/mfa/enrollment/confirm', token).send({
      challengeToken: start.body.challenge.token,
      code: currentTotpCode(secret, new Date()),
    });
    expect(confirm.status).toBe(200);
    // Les événements suivants sont strictement postérieurs à l'attribution.
    await pause(5);
    return { userId, email, token: confirm.body.session.token };
  }

  const capability = (
    a: Admin,
    command: 'capability-add' | 'capability-remove',
    value: string,
  ) =>
    cli([
      command,
      `--user-id=${a.userId}`,
      `--capability=${value}`,
      reason,
      '--operator=e2e',
      '--apply',
    ]);

  async function register(label: string) {
    const ownerEmail = unique(label);
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Propriétaire',
      email: ownerEmail,
      password: PASSWORD,
      organizationName: `B ${label} ${seq}`.slice(0, 20),
    });
    if (reg.status !== 202) throw new Error(JSON.stringify(reg.body));
    return {
      organizationId: reg.owner!.organization._id,
      ownerEmail,
    };
  }

  const count = async (a: Admin) => {
    const res = await admin('get', '/notifications/unread-count', a.token);
    expect(res.status).toBe(200);
    return res.body.unread as number;
  };

  const list = async (a: Admin, query = '') => {
    const res = await admin('get', `/notifications${query}`, a.token);
    expect(res.status).toBe(200);
    return res.body as {
      total: number;
      unread: number;
      page: number;
      pageSize: number;
      items: Item[];
    };
  };

  const notificationsOf = (eventKey: RegExp) =>
    db()
      .collection('platform_admin_notifications')
      .countDocuments({ eventKey: { $regex: eventKey } });

  async function insertOrganization(name: string): Promise<string> {
    const _id = new Types.ObjectId();
    const now = new Date();
    await db()
      .collection('organizations')
      .insertOne({
        _id,
        name,
        slug: `e2e-${_id.toHexString()}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    return _id.toHexString();
  }

  function payment(organizationId: string, overrides: Record<string, unknown>) {
    const now = new Date();
    return {
      _id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(organizationId),
      requestedBy: new Types.ObjectId(),
      clientOperationId: randomUUID(),
      requestFingerprint: 'f',
      term: 'quarterly',
      amount: 15_000,
      currency: 'XAF',
      pricingVersion: 1,
      provider: 'saspay',
      merchantReference: `SM${randomBytes(6).toString('hex')}`,
      providerReference: null,
      providerCheckoutUrl: 'https://pay.example.test/secret-checkout-token',
      status: 'pending',
      open: true,
      periodId: null,
      incidentCode: null,
      confirmedAt: null,
      refundedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = randomBytes(48).toString('base64url');
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL =
        'https://app.platform-notifications.e2e.test';
      process.env.PLATFORM_ADMIN_ENABLED = 'true';
      process.env.PLATFORM_ADMIN_MFA_KEYS = `e2e1:${randomBytes(32).toString('base64')}`;
      process.env.PLATFORM_ADMIN_MFA_ACTIVE_KEY = 'e2e1';
      process.env.PLATFORM_ADMIN_PROXY_SECRET = PROXY_SECRET;

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PLATFORM_ADMIN_CLOCK)
        .useValue(clock)
        .compile();
      app = moduleFixture.createNestApplication();
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
      connection = app.get<Connection>(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      sweep = app.get(PlatformAdminNotificationSweep);
      await ensurePlatformAdminIndexes(connection);
      await ensureSubscriptionPeriodIndexes(connection);
      // Historique AVANT la migration et la première passe.
      preexisting = (await register('historique')).organizationId;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    emailSender.reset();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('migration relançable, sans notification rétroactive ni capacité', async () => {
    const first = await ensurePlatformAdminNotificationIndexes(connection);
    expect(first.created.length).toBeGreaterThan(0);
    const second = await ensurePlatformAdminNotificationIndexes(connection);
    expect(second.created).toEqual([]);
    expect(
      await db().collection('platform_admin_notifications').countDocuments(),
    ).toBe(0);
    expect(
      await db().collection('platform_admin_grants').countDocuments(),
    ).toBe(0);
    // Première passe : point d'activation ; l'historique n'est pas signalé.
    expect((await sweep.runOnce()).created).toBe(0);
    expect(await notificationsOf(new RegExp(preexisting))).toBe(0);
    await pause(5);
  });

  describe('Accès', () => {
    it('BFF, session complète MFA et accès actif exigés', async () => {
      const a = await enrolledAdmin();
      // Sans le secret du BFF : route inexistante.
      const hidden = await http()
        .get('/platform-admin/notifications')
        .set('x-platform-admin-session', a.token);
      expect(hidden.status).toBe(404);
      // JWT de commerce : n'ouvre rien.
      const shop = await register('jwt');
      const login = await http().post('/auth/login').send({
        email: shop.ownerEmail,
        password: PASSWORD,
        organizationId: shop.organizationId,
      });
      expect(login.status).toBe(201);
      const tenant = await admin('get', '/notifications/unread-count').set(
        'authorization',
        `Bearer ${login.body.access_token}`,
      );
      expect(tenant.status).toBe(401);
      expect(tenant.body.code).toBe('PLATFORM_ADMIN_SESSION_EXPIRED');
      // Session avant second facteur.
      const pre = await passwordSession(a.email);
      const preRes = await admin('get', '/notifications', pre);
      expect(preRes.status).toBe(401);
      expect(preRes.body.code).toBe('PLATFORM_ADMIN_MFA_REQUIRED');
      expect((await admin('post', '/notifications/read-all', pre)).status).toBe(
        401,
      );
      // Session expirée / inconnue.
      expect(
        (await admin('get', '/notifications', 'A'.repeat(43))).status,
      ).toBe(401);
      // Réponses jamais mises en cache.
      const ok = await admin('get', '/notifications', a.token);
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store, private');
      // Accès révoqué : fermé immédiatement, même session.
      await cli([
        'revoke',
        `--user-id=${a.userId}`,
        reason,
        '--operator=e2e',
        '--apply',
      ]);
      expect(
        (await admin('get', '/notifications/unread-count', a.token)).status,
      ).toBe(401);
    });
  });

  describe('Événements', () => {
    it('nouvelle organisation : une seule notification, lien vers sa fiche', async () => {
      const a = await enrolledAdmin();
      const { organizationId } = await register('neuve');
      await sweep.runOnce();
      await sweep.runOnce();
      expect(
        await notificationsOf(
          new RegExp(`^organization_created:${organizationId}$`),
        ),
      ).toBe(1);
      const page = await list(a);
      const item = page.items.find((i) => i.target.id === organizationId)!;
      expect(item.type).toBe('organization_created');
      expect(item.target).toMatchObject({
        kind: 'organization',
        available: true,
      });
      expect(String(item.params.organizationName)).toContain('B neuve');
    });

    it('transaction d’inscription annulée : rien', async () => {
      const id = new Types.ObjectId();
      const session = await connection.startSession();
      await expect(
        session.withTransaction(async () => {
          const now = new Date();
          await db()
            .collection('organizations')
            .insertOne(
              { _id: id, name: 'Annulée', createdAt: now, updatedAt: now },
              { session },
            );
          throw new Error('inscription annulée');
        }),
      ).rejects.toThrow('inscription annulée');
      await session.endSession();
      await sweep.runOnce();
      expect(await notificationsOf(new RegExp(id.toHexString()))).toBe(0);
    });

    it('paiements : confirmé et à examiner seulement, sans doublon au rejeu', async () => {
      const a = await enrolledAdmin();
      const org = await insertOrganization('Commerce payeur');
      const now = new Date();
      const confirmed = payment(org, {
        status: 'succeeded',
        open: false,
        periodId: new Types.ObjectId(),
        confirmedAt: now,
      });
      const review = payment(org, {
        status: 'review',
        incidentCode: 'provider_mismatch',
      });
      const ignored = [
        payment(org, { status: 'pending' }),
        payment(org, {
          status: 'uncertain',
          incidentCode: 'initiation_uncertain',
        }),
        payment(org, { status: 'failed', open: false }),
        payment(org, { status: 'review', refundedAt: now }),
      ];
      await db()
        .collection('subscription_payments')
        .insertMany([confirmed, review, ...ignored]);
      // Prolongation offerte : une période, jamais un paiement.
      await db()
        .collection('subscription_periods')
        .insertOne({
          organizationId: new Types.ObjectId(org),
          kind: 'subscription',
          source: 'offered',
          startsAt: now,
          endsAt: new Date(now.getTime() + 86_400_000),
          createdAt: now,
        });
      await sweep.runOnce();
      // Rejeux : webhook relivré, rapprochement qui retouche le paiement.
      await db()
        .collection('subscription_payments')
        .updateMany(
          { _id: { $in: [confirmed._id, review._id] } },
          { $set: { updatedAt: new Date(), lastCheckedAt: new Date() } },
        );
      await sweep.runOnce();
      await sweep.runOnce();
      expect(
        await notificationsOf(new RegExp(confirmed._id.toHexString())),
      ).toBe(1);
      expect(await notificationsOf(new RegExp(review._id.toHexString()))).toBe(
        1,
      );
      for (const p of ignored) {
        expect(await notificationsOf(new RegExp(p._id.toHexString()))).toBe(0);
      }
      const items = (await list(a)).items.filter(
        (i) => i.target.kind === 'payment',
      );
      expect(items.map((i) => i.type).sort()).toEqual([
        'payment_confirmed',
        'payment_review',
      ]);
      const paid = items.find((i) => i.type === 'payment_confirmed')!;
      expect(paid.params).toEqual({
        organizationName: 'Commerce payeur',
        amount: 15_000,
        currency: 'XAF',
        term: 'quarterly',
        months: 3,
      });
      const toReview = items.find((i) => i.type === 'payment_review')!;
      expect(toReview.params.incidentCode).toBe('provider_mismatch');
      expect(JSON.stringify(items)).not.toContain('secret-checkout-token');
    });

    it('assistance : référence et catégorie seulement, jamais le contenu', async () => {
      const a = await enrolledAdmin();
      const org = await insertOrganization('Commerce assisté');
      const requestId = randomUUID();
      await db()
        .collection('support_requests')
        .insertOne({
          _id: requestId as never,
          reference: 'AS-1A2B3C4D',
          userId: new Types.ObjectId(),
          organizationId: new Types.ObjectId(org),
          membershipId: new Types.ObjectId(),
          category: 'technical',
          fingerprint: 'empreinte-du-contenu',
          page: '/app/products',
          appVersion: '1.0.0',
          context: {
            userName: 'Client Secret',
            userEmail: 'client.prive@example.test',
            organizationName: 'Commerce assisté',
            organizationSlug: null,
            role: 'owner',
            permissions: [],
          },
          status: 'sent',
          createdAt: new Date(),
        });
      await sweep.runOnce();
      await sweep.runOnce();
      expect(await notificationsOf(new RegExp(requestId))).toBe(1);
      const page = await list(a);
      const item = page.items.find((i) => i.type === 'support_request')!;
      expect(item.params).toEqual({
        organizationName: 'Commerce assisté',
        reference: 'AS-1A2B3C4D',
        supportCategory: 'technical',
      });
      expect(item.target).toMatchObject({ kind: 'organization', id: org });
      const body = JSON.stringify(page);
      for (const hidden of [
        'client.prive@',
        'Client Secret',
        'empreinte',
        '/app/products',
        requestId,
      ]) {
        expect(body).not.toContain(hidden);
      }
    });

    it('campagnes : audience partielle, fin seulement quand tout est traité', async () => {
      const a = await enrolledAdmin();
      const now = new Date();
      const old = new Date(
        now.getTime() - CAMPAIGN_COMPLETION_GRACE_MS - 1_000,
      );
      const base = {
        status: 'launched',
        subject: 'Sujet promotionnel confidentiel',
        body: 'Corps promotionnel confidentiel',
        targeting: { mode: 'all' },
        revision: 1,
        createdBy: new Types.ObjectId(),
        createdAt: now,
        updatedBy: new Types.ObjectId(),
        updatedAt: now,
        launchedAt: now,
        launchedBy: new Types.ObjectId(),
        archivedAt: null,
        archivedBy: null,
      };
      const preparing = {
        ...base,
        _id: new Types.ObjectId(),
        launchOperationId: randomUUID(),
        audience: { status: 'preparing', cursor: null, total: 0 },
      };
      const partial = {
        ...base,
        _id: new Types.ObjectId(),
        launchOperationId: randomUUID(),
        audience: {
          status: 'ready',
          cursor: null,
          total: 4,
          frozenAt: old,
          incomplete: true,
        },
      };
      await db()
        .collection('platform_campaigns')
        .insertMany([preparing, partial]);
      const delivery = (status: string) => ({
        _id: new Types.ObjectId(),
        campaignId: partial._id,
        userId: new Types.ObjectId(),
        status,
        attempts: 0,
        nextAttemptAt: now,
        lockedUntil: null,
        createdAt: now,
        updatedAt: now,
      });
      const deliveries = [
        delivery('accepted'),
        delivery('skipped'),
        delivery('uncertain'),
        // Interrupteur d'envoi coupé : cette livraison reste à traiter.
        delivery('pending'),
      ];
      await db()
        .collection('platform_campaign_deliveries')
        .insertMany(deliveries);
      await sweep.runOnce();
      await sweep.runOnce();
      const partialId = partial._id.toHexString();
      expect(
        await notificationsOf(new RegExp(preparing._id.toHexString())),
      ).toBe(0);
      expect(
        await notificationsOf(
          new RegExp(`^campaign_audience_partial:${partialId}$`),
        ),
      ).toBe(1);
      expect(
        await notificationsOf(new RegExp(`^campaign_completed:${partialId}$`)),
      ).toBe(0);
      // Dernière livraison traitée (échec certain) : fin, une seule fois.
      await db()
        .collection('platform_campaign_deliveries')
        .updateOne({ _id: deliveries[3]._id }, { $set: { status: 'failed' } });
      await sweep.runOnce();
      await sweep.runOnce();
      expect(
        await notificationsOf(new RegExp(`^campaign_completed:${partialId}$`)),
      ).toBe(1);
      const items = (await list(a)).items.filter(
        (i) => i.target.kind === 'campaign',
      );
      const done = items.find((i) => i.type === 'campaign_completed')!;
      expect(done.params).toEqual({
        audienceTotal: 4,
        results: { accepted: 1, skipped: 1, failed: 1, uncertain: 1 },
      });
      expect(JSON.stringify(items)).not.toContain('confidentiel');
    });
  });

  describe('Destinataires et lecture', () => {
    it('état de lecture propre à chaque administrateur', async () => {
      const a = await enrolledAdmin();
      const b = await enrolledAdmin();
      await insertOrganization('Lecture 1');
      await insertOrganization('Lecture 2');
      await sweep.runOnce();
      expect(await count(a)).toBe(2);
      expect(await count(b)).toBe(2);
      const [first] = (await list(a)).items;
      // Un identifiant de destinataire fourni par le navigateur est ignoré.
      const read = await admin(
        'post',
        `/notifications/${first.id}/read`,
        a.token,
      ).send({ userId: b.userId });
      expect(read.status).toBe(200);
      const again = await admin(
        'post',
        `/notifications/${first.id}/read`,
        a.token,
      );
      expect(again.status).toBe(200);
      expect(again.body.readAt).toBe(read.body.readAt);
      expect(await count(a)).toBe(1);
      expect(await count(b)).toBe(2);
      expect((await list(b)).items.every((i) => !i.read)).toBe(true);
      const unreadA = await list(a, '?status=unread');
      expect(unreadA.total).toBe(1);
      expect(unreadA.items.map((i) => i.id)).not.toContain(first.id);
      expect(
        await db()
          .collection('platform_admin_notification_reads')
          .countDocuments({ userId: new Types.ObjectId(b.userId) }),
      ).toBe(0);
    });

    it('droits relus à chaque requête : liste, compteur et écritures filtrés', async () => {
      const a = await enrolledAdmin();
      await insertOrganization('Droits');
      await sweep.runOnce();
      const [item] = (await list(a)).items;
      await capability(a, 'capability-remove', 'platform.read');
      expect(await count(a)).toBe(0);
      expect((await list(a)).items).toEqual([]);
      expect(
        (await admin('post', `/notifications/${item.id}/read`, a.token)).status,
      ).toBe(404);
      // Une capacité d'action ne suffit pas à consulter.
      await capability(a, 'capability-add', 'platform.campaigns.send');
      expect(await count(a)).toBe(0);
      await capability(a, 'capability-add', 'platform.read');
      expect(await count(a)).toBe(1);
    });

    it('administrateur nouvellement autorisé : commence à son attribution', async () => {
      await insertOrganization('Avant attribution');
      await sweep.runOnce();
      const late = await enrolledAdmin();
      expect(await count(late)).toBe(0);
      expect((await list(late)).total).toBe(0);
      const before = (
        await db()
          .collection('platform_admin_notifications')
          .find()
          .sort({ createdAt: -1 })
          .limit(1)
          .toArray()
      )[0];
      expect(
        (
          await admin(
            'post',
            `/notifications/${before._id.toHexString()}/read`,
            late.token,
          )
        ).status,
      ).toBe(404);
      await insertOrganization('Après attribution');
      await sweep.runOnce();
      expect(await count(late)).toBe(1);
    });

    it('« tout marquer comme lu » : borne serveur, idempotent', async () => {
      const a = await enrolledAdmin();
      const b = await enrolledAdmin();
      await insertOrganization('Tout lu 1');
      await insertOrganization('Tout lu 2');
      await sweep.runOnce();
      const beforeAction = new Date();
      const res = await admin('post', '/notifications/read-all', a.token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ marked: 2, remaining: false });
      const replay = await admin('post', '/notifications/read-all', a.token);
      expect(replay.body).toEqual({ marked: 0, remaining: false });
      expect(await count(a)).toBe(0);
      expect(await count(b)).toBe(2);
      // Enregistrée APRÈS l'action, même datée d'avant : reste non lue.
      const late = new Types.ObjectId();
      await db()
        .collection('platform_admin_notifications')
        .insertOne({
          _id: late,
          eventKey: `organization_created:${late.toHexString()}`,
          type: 'organization_created',
          category: 'organizations',
          occurredAt: beforeAction,
          createdAt: beforeAction,
          target: {
            kind: 'organization',
            id: late.toHexString(),
            organizationId: late.toHexString(),
          },
          params: { organizationName: 'Arrivée tardive' },
        });
      expect(await count(a)).toBe(1);
      const unread = await list(a, '?status=unread');
      expect(unread.items.map((i) => i.id)).toEqual([late.toHexString()]);
    });

    it('pagination bornée et cible disparue', async () => {
      const a = await enrolledAdmin();
      const ids: string[] = [];
      for (let i = 0; i < 23; i += 1)
        ids.push(await insertOrganization(`Page ${i}`));
      await sweep.runOnce();
      const first = await list(a, '?page=1');
      expect(first.pageSize).toBe(20);
      expect(first.total).toBe(23);
      expect(first.items).toHaveLength(20);
      const second = await list(a, '?page=2');
      expect(second.items).toHaveLength(3);
      expect(
        new Set([...first.items, ...second.items].map((i) => i.id)).size,
      ).toBe(23);
      expect(
        (await admin('get', '/notifications?page=501', a.token)).status,
      ).toBe(400);
      expect(
        (await admin('get', '/notifications?status=everything', a.token))
          .status,
      ).toBe(400);
      // Cible supprimée : résumé conservé, signalée indisponible.
      await db()
        .collection('organizations')
        .deleteOne({ _id: new Types.ObjectId(ids[22]) });
      const gone = (await list(a)).items.find((i) => i.target.id === ids[22])!;
      expect(gone.target.available).toBe(false);
      expect(gone.params.organizationName).toBe('Page 22');
      expect(
        (await admin('post', `/notifications/${gone.id}/read`, a.token)).status,
      ).toBe(200);
      expect(
        (await admin('post', '/notifications/not-an-id/read', a.token)).status,
      ).toBe(404);
    });
  });
  describe('Campagnes différées (horloge contrôlée)', () => {
    afterAll(() => {
      clockOffsetMs = 0;
    });

    /** Campagne lancée MAINTENANT (horloge), audience gelée, livraisons en attente. */
    async function launchPending(pending: number) {
      const now = clock();
      const _id = new Types.ObjectId();
      await db()
        .collection('platform_campaigns')
        .insertOne({
          _id,
          status: 'launched',
          subject: 'Sujet',
          body: 'Corps',
          targeting: { mode: 'all' },
          revision: 1,
          createdBy: new Types.ObjectId(),
          createdAt: now,
          updatedBy: new Types.ObjectId(),
          updatedAt: now,
          launchedAt: now,
          launchedBy: new Types.ObjectId(),
          launchOperationId: randomUUID(),
          archivedAt: null,
          archivedBy: null,
          audience: {
            status: 'ready',
            cursor: null,
            total: pending,
            frozenAt: now,
            incomplete: false,
          },
        });
      if (pending === 0) return _id;
      await db()
        .collection('platform_campaign_deliveries')
        .insertMany(
          Array.from({ length: pending }, () => ({
            _id: new Types.ObjectId(),
            campaignId: _id,
            userId: new Types.ObjectId(),
            // Interrupteur d'envoi coupé : rien n'est traité.
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lockedUntil: null,
            createdAt: now,
            updatedAt: now,
          })),
        );
      return _id;
    }

    const completions = (id: Types.ObjectId) =>
      notificationsOf(new RegExp(`^campaign_completed:${id.toHexString()}$`));

    const finish = (id: Types.ObjectId) =>
      db()
        .collection('platform_campaign_deliveries')
        .updateMany(
          { campaignId: id },
          { $set: { status: 'accepted', completedAt: clock() } },
        );

    it('livraisons terminées le lendemain, au-delà du recouvrement : une seule fin', async () => {
      const id = await launchPending(2);
      await sweep.runOnce();
      // Passes successives bien au-delà du recouvrement de 10 min.
      for (const step of [
        NOTIFICATION_SWEEP_OVERLAP_MS + 60_000,
        3_600_000,
        6 * 3_600_000,
      ]) {
        clockOffsetMs += step;
        await sweep.runOnce();
        expect(await completions(id)).toBe(0);
      }
      // Lendemain : fin des livraisons.
      clockOffsetMs += DAY_MS;
      await sweep.runOnce();
      expect(await completions(id)).toBe(0);
      await finish(id);
      await sweep.runOnce();
      await sweep.runOnce();
      clockOffsetMs += 60_000;
      await sweep.runOnce();
      expect(await completions(id)).toBe(1);
      const done = await db()
        .collection('platform_admin_notifications')
        .findOne({ eventKey: `campaign_completed:${id.toHexString()}` });
      expect(done!.params.results).toEqual({
        accepted: 2,
        skipped: 0,
        failed: 0,
        uncertain: 0,
      });
    });

    it('en attente plus de 7 jours, collecteur actif : la limite de rattrapage ne l’exclut pas', async () => {
      const id = await launchPending(1);
      await sweep.runOnce();
      // Une passe par jour pendant 8 jours (collecteur fonctionnant).
      for (let day = 0; day < 8; day += 1) {
        clockOffsetMs += DAY_MS;
        await sweep.runOnce();
        expect(await completions(id)).toBe(0);
      }
      expect(clockOffsetMs).toBeGreaterThan(NOTIFICATION_MAX_CATCH_UP_MS);
      await finish(id);
      await sweep.runOnce();
      await sweep.runOnce();
      expect(await completions(id)).toBe(1);
    });

    it('livraison écrite directement en base après la fin : aucune seconde notification', async () => {
      // Hors chemin applicatif (la constitution n'ajoute plus rien après la
      // clôture : marketing-campaigns.e2e-spec.ts) : la fin déjà signalée
      // n'est ni recalculée ni dupliquée.
      const id = await launchPending(0);
      clockOffsetMs += CAMPAIGN_COMPLETION_GRACE_MS + 60_000;
      await sweep.runOnce();
      expect(await completions(id)).toBe(1);
      await db().collection('platform_campaign_deliveries').insertOne({
        _id: new Types.ObjectId(),
        campaignId: id,
        userId: new Types.ObjectId(),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: clock(),
        lockedUntil: null,
        createdAt: clock(),
        updatedAt: clock(),
      });
      expect(
        await db()
          .collection('platform_campaign_deliveries')
          .countDocuments({ campaignId: id, status: 'pending' }),
      ).toBe(1);
      // La fin déjà signalée n'est ni recalculée ni dupliquée.
      await sweep.runOnce();
      expect(await completions(id)).toBe(1);
    });
  });
});
