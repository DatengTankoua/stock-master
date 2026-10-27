import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
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
import {
  EMAIL_SENDER,
  EmailDeliveryError,
} from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { ensurePlatformAdminIndexes } from '../src/platform-admin/platform-admin-indexes';
import { ensureSubscriptionPeriodIndexes } from '../src/subscriptions/subscription-period-indexes';
import { PLATFORM_ADMIN_CLOCK } from '../src/platform-admin/platform-admin-runtime';
import { currentTotpCode } from '../src/platform-admin/totp';
import {
  parseCliArguments,
  runPlatformAdminCli,
} from '../src/migrations/platform-admin-cli';
import { PlatformMessageDeliveryService } from '../src/platform-admin/platform-message-delivery.service';
import {
  MESSAGE_MAX_ATTEMPTS,
  MESSAGE_ORGANIZATION_LIMIT,
  MESSAGE_UNCERTAIN_RETRY_WINDOW_MS,
} from '../src/platform-admin/platform-message-policy';
import { PushRuntime } from '../src/push/push-runtime';

/**
 * E2E — messages de service de l'administration de la plateforme :
 * capacités par canal, preuve liée au contenu exact, destinataires
 * revérifiés, idempotence et concurrence, livraisons (centre, push, e-mail
 * simulé), échecs, incertitude, relance, préférences, commerce suspendu,
 * absence de contenu dans l'audit et les journaux. Base éphémère, aucun
 * envoi réel (expéditeur simulé, push non activé).
 */

const emailSender = createE2eEmailSender();
const PASSWORD = 'platform-messages-e2e-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const SUPPORT = 'support@stock-master.app';

let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
const nextStep = () => {
  clockOffsetMs += 30_000;
};

interface Admin {
  userId: string;
  email: string;
  secret: Uint8Array;
  token: string;
}

interface Shop {
  organizationId: string;
  ownerId: string;
  ownerEmail: string;
  ownerToken: string;
}

const NOTIFY = 'platform.communications.notify';
const EMAIL = 'platform.communications.email';

describe('Administration de la plateforme — messages de service (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let worker: PlatformMessageDeliveryService;
  let seq = 0;
  let ipSeq = 0;

  const http = () => request(app.getHttpServer());
  const unique = (label: string) => `${label}-${++seq}@platform-messages.test`;
  const db = () => connection.db!;

  const admin = (method: 'get' | 'post', path: string, token?: string) => {
    let req = http()
      [method](`/platform-admin${path}`)
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', '203.0.113.210');
    if (token) req = req.set('x-platform-admin-session', token);
    return req;
  };

  const cli = async (argv: string[]) => {
    const args = parseCliArguments(argv);
    if (typeof args === 'string') throw new Error(args);
    return runPlatformAdminCli(connection, args, process.env, clock());
  };

  async function createUser(
    verified = true,
  ): Promise<{ userId: string; email: string }> {
    const email = unique('user');
    const userId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name: 'Membre e2e',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      ...(verified ? { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } : {}),
    });
    return { userId: userId.toHexString(), email };
  }

  async function enrolledAdmin(capabilities: string[] = []): Promise<Admin> {
    const { userId, email } = await createUser();
    const reason = '--reason=Recette des messages de service';
    await cli([
      'grant',
      `--user-id=${userId}`,
      reason,
      '--operator=e2e',
      '--apply',
    ]);
    for (const capability of capabilities) {
      await cli([
        'capability-add',
        `--user-id=${userId}`,
        `--capability=${capability}`,
        reason,
        '--operator=e2e',
        '--apply',
      ]);
    }
    const ip = `198.51.100.${++ipSeq}`;
    const login = await http()
      .post('/platform-admin/auth/login')
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', ip)
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.session.token as string;
    const start = await admin('post', '/mfa/enrollment/start', token);
    const secret = Secret.fromBase32(
      start.body.manualKey.replace(/ /g, ''),
    ).bytes;
    nextStep();
    const confirm = await admin('post', '/mfa/enrollment/confirm', token).send({
      challengeToken: start.body.challenge.token,
      code: currentTotpCode(secret, clock()),
    });
    expect(confirm.status).toBe(200);
    return { userId, email, secret, token: confirm.body.session.token };
  }

  async function stepUp(a: Admin, intent: Record<string, unknown>) {
    nextStep();
    return admin('post', '/security/step-up', a.token).send({
      password: PASSWORD,
      code: currentTotpCode(a.secret, clock()),
      intent,
    });
  }

  async function confirmed(a: Admin, intent: Record<string, unknown>) {
    const res = await stepUp(a, intent);
    expect(res.status).toBe(200);
    return res.body.stepUpToken as string;
  }

  async function shop(label: string): Promise<Shop> {
    const ownerEmail = unique(label);
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Propriétaire',
      email: ownerEmail,
      password: PASSWORD,
      organizationName: `Boutique ${seq}`,
    });
    expect(reg.status).toBe(202);
    const organizationId = reg.owner!.organization._id;
    const login = await http()
      .post('/auth/login')
      .send({ email: ownerEmail, password: PASSWORD, organizationId });
    expect(login.status).toBe(201);
    const owner = await userModel.findOne({ email: ownerEmail }).lean();
    return {
      organizationId,
      ownerId: String(owner!._id),
      ownerEmail,
      ownerToken: login.body.access_token,
    };
  }

  /** Membre actif ajouté directement (vendeur). */
  async function member(s: Shop, verified = true) {
    const user = await createUser(verified);
    await db()
      .collection('organizationmemberships')
      .insertOne({
        organizationId: new Types.ObjectId(s.organizationId),
        userId: new Types.ObjectId(user.userId),
        role: 'seller',
        permissions: [],
        status: 'active',
        invitedById: null,
        joinedAt: new Date(),
      });
    return user;
  }

  const messageIntent = (
    organizationId: string,
    recipientUserIds: string[],
    channels: string[] = ['in_app'],
    overrides: Record<string, unknown> = {},
  ) => ({
    action: 'organization_message',
    organizationId,
    operationId: randomUUID(),
    channels,
    recipientUserIds,
    title: 'Maintenance planifiée',
    body: 'Bonjour,\nune maintenance aura lieu ce soir entre 22 h et 23 h.',
    ...overrides,
  });

  const sendBody = (
    intent: ReturnType<typeof messageIntent>,
    stepUpToken: string,
  ) => ({
    operationId: intent.operationId,
    stepUpToken,
    channels: intent.channels,
    recipientUserIds: intent.recipientUserIds,
    title: intent.title,
    body: intent.body,
  });

  async function send(
    a: Admin,
    intent: ReturnType<typeof messageIntent>,
    token?: string,
  ) {
    const stepUpToken = token ?? (await confirmed(a, intent));
    return admin(
      'post',
      `/organizations/${intent.organizationId}/messages`,
      a.token,
    ).send(sendBody(intent, stepUpToken));
  }

  const deliveriesOf = (messageId: string) =>
    db()
      .collection('platform_message_deliveries')
      .find({ messageId: new Types.ObjectId(messageId) })
      .toArray();

  /** E-mails de messages de service (hors vérification d’adresse). */
  const messageMails = (address: string) =>
    emailSender
      .sentTo(address)
      .filter((m) => m.idempotencyKey.startsWith('platform-message/'));

  async function drain(passes = 3) {
    for (let i = 0; i < passes; i += 1) await worker.runOnce();
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
      process.env.PUBLIC_APP_URL = 'https://app.platform-messages.e2e.test';
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
      worker = app.get(PlatformMessageDeliveryService);
      // Centre et outbox actifs (sans push ni boucle de fond) : les
      // livraisons sont traitées par `runOnce()`, à la demande du test.
      app.get(PushRuntime).activateCenter();
      await ensurePlatformAdminIndexes(connection);
      await ensureSubscriptionPeriodIndexes(connection);
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

  describe('Capacités', () => {
    it('lecture seule : historique lisible, aucune préparation ni envoi', async () => {
      const s = await shop('ro');
      const a = await enrolledAdmin();
      expect(
        (
          await admin(
            'get',
            `/organizations/${s.organizationId}/messages`,
            a.token,
          )
        ).status,
      ).toBe(200);
      const recipients = await admin(
        'get',
        `/organizations/${s.organizationId}/message-recipients`,
        a.token,
      );
      expect(recipients.status).toBe(403);
      expect(recipients.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      const intent = messageIntent(s.organizationId, [s.ownerId]);
      const up = await stepUp(a, intent);
      expect(up.status).toBe(403);
      expect(up.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      const res = await send(a, intent, randomBytes(32).toString('base64url'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      expect(
        await db()
          .collection('platform_admin_audit')
          .countDocuments({
            action: 'organization_message',
            outcome: 'denied',
            detail: 'capability',
            actorUserId: new Types.ObjectId(a.userId),
          }),
      ).toBe(1);
    });

    it('chaque capacité n’autorise que son canal ; « les deux » exige les deux', async () => {
      const s = await shop('caps');
      const notify = await enrolledAdmin([NOTIFY]);
      const email = await enrolledAdmin([EMAIL]);
      const r = await admin(
        'get',
        `/organizations/${s.organizationId}/message-recipients`,
        notify.token,
      );
      expect(r.status).toBe(200);
      expect(r.body.channels).toEqual(['in_app']);
      expect(
        (await stepUp(notify, messageIntent(s.organizationId, [s.ownerId])))
          .status,
      ).toBe(200);
      for (const channels of [['email'], ['in_app', 'email']]) {
        const up = await stepUp(
          notify,
          messageIntent(s.organizationId, [s.ownerId], channels),
        );
        expect(up.status).toBe(403);
      }
      expect(
        (
          await stepUp(
            email,
            messageIntent(s.organizationId, [s.ownerId], ['email']),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await stepUp(
            email,
            messageIntent(s.organizationId, [s.ownerId], ['in_app']),
          )
        ).status,
      ).toBe(403);
      const both = await enrolledAdmin([NOTIFY, EMAIL]);
      const intent = messageIntent(
        s.organizationId,
        [s.ownerId],
        ['in_app', 'email'],
      );
      expect((await send(both, intent)).status).toBe(200);
      // Une preuve d'un administrateur à un canal ne sert pas l'autre.
      const token = await confirmed(
        notify,
        messageIntent(s.organizationId, [s.ownerId]),
      );
      const forged = await send(
        notify,
        messageIntent(s.organizationId, [s.ownerId], ['email']),
        token,
      );
      expect(forged.status).toBe(403);
      expect(forged.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
    });
  });

  describe('Destinataires et preuve', () => {
    it('interorganisations, inconnus et comptes inactifs refusés sans rien écrire', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s1 = await shop('iso-a');
      const s2 = await shop('iso-b');
      const unverified = await member(s1, false);
      for (const recipients of [
        [s2.ownerId],
        [s1.ownerId, s2.ownerId],
        [new Types.ObjectId().toHexString()],
        [unverified.userId],
      ]) {
        const res = await send(a, messageIntent(s1.organizationId, recipients));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED');
      }
      expect(
        await db()
          .collection('platform_messages')
          .countDocuments({
            organizationId: new Types.ObjectId(s1.organizationId),
          }),
      ).toBe(0);
      // Liste : non vérifié signalé non joignable, autre commerce absent.
      const list = await admin(
        'get',
        `/organizations/${s1.organizationId}/message-recipients`,
        a.token,
      );
      const ids = list.body.members.map((m: { userId: string }) => m.userId);
      expect(ids).toContain(unverified.userId);
      expect(ids).not.toContain(s2.ownerId);
      expect(
        list.body.members.find(
          (m: { userId: string }) => m.userId === unverified.userId,
        ).eligible,
      ).toBe(false);
      // Preuve d'une organisation présentée pour une autre.
      const intent = messageIntent(s1.organizationId, [s1.ownerId]);
      const token = await confirmed(a, intent);
      const moved = await admin(
        'post',
        `/organizations/${s2.organizationId}/messages`,
        a.token,
      ).send(sendBody({ ...intent, recipientUserIds: [s2.ownerId] }, token));
      expect(moved.status).toBe(403);
      expect(moved.body.code).toBe('PLATFORM_ADMIN_STEP_UP_REQUIRED');
    });

    it('preuve expirée, réutilisée ou liée à un autre contenu : refus', async () => {
      const a = await enrolledAdmin([NOTIFY]);
      const s = await shop('proof');
      // Contenu modifié après confirmation.
      const intent = messageIntent(s.organizationId, [s.ownerId]);
      const token = await confirmed(a, intent);
      for (const change of [
        { title: 'Titre modifié' },
        { body: 'Texte modifié' },
        { channels: ['in_app', 'email'] },
      ]) {
        const res = await admin(
          'post',
          `/organizations/${s.organizationId}/messages`,
          a.token,
        ).send(sendBody({ ...intent, ...change }, token));
        expect([403]).toContain(res.status);
      }
      // Réutilisée : un autre identifiant d'opération avec la même preuve.
      expect((await send(a, intent, token)).status).toBe(200);
      const again = await send(
        a,
        { ...intent, operationId: randomUUID() },
        token,
      );
      expect(again.status).toBe(403);
      expect(again.body.code).toBe('PLATFORM_ADMIN_STEP_UP_REQUIRED');
      // Expirée (5 min).
      const late = messageIntent(s.organizationId, [s.ownerId]);
      const lateToken = await confirmed(a, late);
      clockOffsetMs += 6 * 60_000;
      const expired = await send(a, late, lateToken);
      expect(expired.status).toBe(403);
      expect(expired.body.code).toBe('PLATFORM_ADMIN_STEP_UP_REQUIRED');
    });

    it('sélection multiple dédupliquée ; trop de destinataires refusé', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('dedup');
      const m = await member(s);
      const intent = messageIntent(
        s.organizationId,
        [s.ownerId, m.userId, s.ownerId],
        ['email', 'in_app'],
      );
      const res = await send(a, intent);
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ recipients: 2, deliveries: 4 });
      const stored = await db()
        .collection('platform_messages')
        .findOne({ operationId: intent.operationId });
      expect(stored!.recipientUserIds).toHaveLength(2);
      const many = Array.from({ length: 51 }, () =>
        new Types.ObjectId().toHexString(),
      );
      const up = await stepUp(a, messageIntent(s.organizationId, many));
      expect(up.status).toBe(400);
      expect(up.body.code).toBe('PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT');
    });
  });

  describe('Idempotence et concurrence', () => {
    it('rejeu : même résultat sans nouvel envoi ; autre contenu : conflit', async () => {
      const a = await enrolledAdmin([NOTIFY]);
      const s = await shop('replay');
      const intent = messageIntent(s.organizationId, [s.ownerId]);
      const token = await confirmed(a, intent);
      const first = await send(a, intent, token);
      expect(first.status).toBe(200);
      expect(first.body.replayed).toBe(false);
      // Réponse perdue : même identifiant, même contenu, preuve consommée.
      const replay = await send(a, intent, token);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        replayed: true,
        result: first.body.result,
      });
      const conflict = await admin(
        'post',
        `/organizations/${s.organizationId}/messages`,
        a.token,
      ).send(sendBody({ ...intent, title: 'Autre titre' }, token));
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PLATFORM_ADMIN_OPERATION_CONFLICT');
      expect(
        await db()
          .collection('platform_messages')
          .countDocuments({ operationId: intent.operationId }),
      ).toBe(1);
    });

    it('double clic et requêtes simultanées : un seul message', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('double');
      const intent = messageIntent(
        s.organizationId,
        [s.ownerId],
        ['in_app', 'email'],
      );
      const token = await confirmed(a, intent);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => send(a, intent, token)),
      );
      for (const r of results) expect(r.status).toBe(200);
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
      expect(
        await db()
          .collection('platform_messages')
          .countDocuments({ operationId: intent.operationId }),
      ).toBe(1);
      const messageId = results[0].body.result.messageId as string;
      expect(await deliveriesOf(messageId)).toHaveLength(2);
      // Traitements concurrents : chaque livraison n'est faite qu'une fois.
      await Promise.all([worker.runOnce(), worker.runOnce()]);
      await drain();
      expect(messageMails(s.ownerEmail)).toHaveLength(1);
      expect(
        await db()
          .collection('notifications')
          .countDocuments({ platformMessageId: new Types.ObjectId(messageId) }),
      ).toBe(1);
    });

    it('limite par organisation : refus explicite au-delà', async () => {
      const a = await enrolledAdmin([NOTIFY]);
      const s = await shop('rate');
      // Messages déjà envoyés dans la fenêtre (insérés directement).
      await db()
        .collection('platform_messages')
        .insertMany(
          Array.from({ length: MESSAGE_ORGANIZATION_LIMIT.max }, () => ({
            operationId: randomUUID(),
            organizationId: new Types.ObjectId(s.organizationId),
            actorUserId: new Types.ObjectId(),
            title: 'x',
            body: 'x',
            channels: ['in_app'],
            recipientUserIds: [],
            createdAt: clock(),
          })),
        );
      const res = await send(a, messageIntent(s.organizationId, [s.ownerId]));
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('PLATFORM_ADMIN_MESSAGE_RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('Livraisons', () => {
    it('notification interne et e-mail : contenu échappé, adresse du compte, aucun secret', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('deliver');
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const log = jest.spyOn(Logger.prototype, 'log');
      const intent = messageIntent(
        s.organizationId,
        [s.ownerId],
        ['in_app', 'email'],
        {
          title: 'Alerte <script>x</script>',
          body: 'Texte <b>gras</b> & lien https://evil.example',
        },
      );
      const res = await send(a, intent);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/stepUp|token|password/i);
      await drain();
      const messageId = res.body.result.messageId as string;
      const rows = await deliveriesOf(messageId);
      expect(rows.map((r) => [r.channel, r.status]).sort()).toEqual([
        ['email', 'accepted'],
        ['in_app', 'created'],
      ]);
      const [mail] = messageMails(s.ownerEmail);
      expect(mail.replyTo).toBe(SUPPORT);
      expect(mail.idempotencyKey).toBe(
        `platform-message/${messageId}/${s.ownerId}`,
      );
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('&lt;b&gt;gras&lt;/b&gt;');
      // Push : un travail pour le seul destinataire.
      const job = await db()
        .collection('push_jobs')
        .findOne({ eventKey: `platform-message:${messageId}:${s.ownerId}` });
      expect(job).toMatchObject({ category: 'platform-message' });
      expect(String(job!.recipientUserId)).toBe(s.ownerId);
      // Centre du destinataire : titre, puis détail en texte brut.
      const list = await http()
        .get('/notifications')
        .set('Authorization', `Bearer ${s.ownerToken}`);
      const item = list.body.items.find(
        (n: { category: string }) => n.category === 'platform-message',
      );
      expect(item.body).toBe(intent.title);
      expect(item.link).toBe(`/app/notifications/${item.id}`);
      const open = await http()
        .post(`/notifications/${item.id}/open`)
        .set('Authorization', `Bearer ${s.ownerToken}`);
      expect(open.body.details).toMatchObject({
        kind: 'platform-message',
        title: intent.title,
        body: intent.body,
      });
      // Historique administratif.
      const history = await admin(
        'get',
        `/organizations/${s.organizationId}/messages`,
        a.token,
      );
      expect(history.body.items[0]).toMatchObject({
        title: intent.title,
        channels: ['in_app', 'email'],
      });
      // Ni contenu ni adresse dans l'audit et les journaux.
      const audit = await db()
        .collection('platform_admin_audit')
        .find({ operationId: intent.operationId })
        .toArray();
      expect(audit.length).toBeGreaterThan(0);
      const lines = [
        JSON.stringify(audit),
        ...warn.mock.calls.flat().map(String),
        ...log.mock.calls.flat().map(String),
      ].join('\n');
      for (const secret of [intent.title, 'gras', s.ownerEmail, PASSWORD]) {
        expect(lines).not.toContain(secret);
      }
      warn.mockRestore();
      log.mockRestore();
    });

    it('échec d’un canal : relance de ce seul canal, l’autre n’est jamais renvoyé', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const notifyOnly = await enrolledAdmin([NOTIFY]);
      const s = await shop('fail');
      emailSender.failure = new EmailDeliveryError('rejected', 422);
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['in_app', 'email']),
      );
      await drain();
      const messageId = res.body.result.messageId as string;
      let rows = await deliveriesOf(messageId);
      const emailRow = rows.find((r) => r.channel === 'email')!;
      const inAppRow = rows.find((r) => r.channel === 'in_app')!;
      expect(emailRow).toMatchObject({
        status: 'failed',
        reason: 'rejected_422',
      });
      expect(inAppRow.status).toBe('created');
      emailSender.failure = null;
      const retryIntent = (channel: string, ids: string[]) => ({
        action: 'organization_message_retry',
        organizationId: s.organizationId,
        operationId: randomUUID(),
        messageId,
        channel,
        deliveryIds: ids,
      });
      const retryBody = (
        intent: ReturnType<typeof retryIntent>,
        stepUpToken: string,
      ) => ({
        operationId: intent.operationId,
        stepUpToken,
        messageId,
        channel: intent.channel,
        deliveryIds: intent.deliveryIds,
      });
      // Capacité du canal relancé exigée.
      expect(
        (await stepUp(notifyOnly, retryIntent('email', [String(emailRow._id)])))
          .status,
      ).toBe(403);
      // Canal déjà réussi : jamais relancé.
      const done = retryIntent('in_app', [String(inAppRow._id)]);
      const refused = await admin(
        'post',
        `/organizations/${s.organizationId}/message-retry`,
        a.token,
      ).send(retryBody(done, await confirmed(a, done)));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PLATFORM_ADMIN_MESSAGE_NOT_RETRYABLE');
      const intent = retryIntent('email', [String(emailRow._id)]);
      const retried = await admin(
        'post',
        `/organizations/${s.organizationId}/message-retry`,
        a.token,
      ).send(retryBody(intent, await confirmed(a, intent)));
      expect(retried.status).toBe(200);
      await drain();
      rows = await deliveriesOf(messageId);
      expect(rows.find((r) => r.channel === 'email')!.status).toBe('accepted');
      expect(messageMails(s.ownerEmail)).toHaveLength(1);
      expect(
        await db()
          .collection('notifications')
          .countDocuments({ platformMessageId: new Types.ObjectId(messageId) }),
      ).toBe(1);
      // Relance d'un message d'une autre organisation : introuvable.
      const other = await shop('fail-other');
      const foreign = {
        ...retryIntent('email', [String(emailRow._id)]),
        organizationId: other.organizationId,
      };
      const foreignRes = await admin(
        'post',
        `/organizations/${other.organizationId}/message-retry`,
        a.token,
      ).send(retryBody(foreign, await confirmed(a, foreign)));
      expect(foreignRes.status).toBe(404);
    });

    it('résultat incertain : même clé, reprises bornées, puis « incertain » ; relance refusée hors fenêtre', async () => {
      const a = await enrolledAdmin([EMAIL]);
      const s = await shop('uncertain');
      emailSender.reset();
      emailSender.failure = new EmailDeliveryError('timeout');
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['email']),
      );
      const messageId = res.body.result.messageId as string;
      for (let i = 0; i < MESSAGE_MAX_ATTEMPTS; i += 1) {
        await worker.runOnce();
        clockOffsetMs += 2 * 60 * 60_000;
      }
      const [row] = await deliveriesOf(messageId);
      expect(row.status).toBe('uncertain');
      expect(row.uncertainAt).not.toBeNull();
      expect(emailSender.attempts).toBeGreaterThan(1);
      expect(emailSender.attempts).toBeLessThanOrEqual(MESSAGE_MAX_ATTEMPTS);
      clockOffsetMs += MESSAGE_UNCERTAIN_RETRY_WINDOW_MS;
      emailSender.failure = null;
      // Session administrative expirée par le saut d'horloge : nouvelle.
      const b = await enrolledAdmin([EMAIL]);
      const intent = {
        action: 'organization_message_retry',
        organizationId: s.organizationId,
        operationId: randomUUID(),
        messageId,
        channel: 'email',
        deliveryIds: [String(row._id)],
      };
      const late = await admin(
        'post',
        `/organizations/${s.organizationId}/message-retry`,
        b.token,
      ).send({
        operationId: intent.operationId,
        stepUpToken: await confirmed(b, intent),
        messageId,
        channel: 'email',
        deliveryIds: intent.deliveryIds,
      });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe(
        'PLATFORM_ADMIN_MESSAGE_RETRY_WINDOW_EXPIRED',
      );
      expect(emailSender.sent).toHaveLength(0);
    });

    it('préférence du centre désactivée : notification ignorée, e-mail envoyé', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('pref');
      const pref = await http()
        .put('/notifications/preferences')
        .set('Authorization', `Bearer ${s.ownerToken}`)
        .send({ platformMessage: false });
      expect(pref.status).toBe(200);
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['in_app', 'email']),
      );
      await drain();
      const rows = await deliveriesOf(res.body.result.messageId as string);
      expect(rows.find((r) => r.channel === 'in_app')).toMatchObject({
        status: 'skipped',
        reason: 'preference_off',
      });
      expect(rows.find((r) => r.channel === 'email')!.status).toBe('accepted');
    });

    it('membre retiré avant livraison : ignoré avec motif', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('removed');
      const m = await member(s);
      const res = await send(
        a,
        messageIntent(s.organizationId, [m.userId], ['in_app', 'email']),
      );
      expect(res.status).toBe(200);
      await db()
        .collection('organizationmemberships')
        .updateOne(
          {
            organizationId: new Types.ObjectId(s.organizationId),
            userId: new Types.ObjectId(m.userId),
          },
          { $set: { status: 'revoked' } },
        );
      await drain();
      const rows = await deliveriesOf(res.body.result.messageId as string);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'skipped',
          reason: 'membership_inactive',
        });
      }
      expect(messageMails(m.email)).toHaveLength(0);
    });

    it('commerce suspendu : e-mail envoyé, commerce et compte jamais réactivés', async () => {
      const a = await enrolledAdmin([NOTIFY, EMAIL]);
      const s = await shop('suspended');
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(s.organizationId) },
          { $set: { status: 'suspended' } },
        );
      const list = await admin(
        'get',
        `/organizations/${s.organizationId}/message-recipients`,
        a.token,
      );
      expect(list.body.organization.status).toBe('suspended');
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['email']),
      );
      expect(res.status).toBe(200);
      await drain();
      expect(messageMails(s.ownerEmail)).toHaveLength(1);
      const org = await db()
        .collection('organizations')
        .findOne({ _id: new Types.ObjectId(s.organizationId) });
      expect(org!.status).toBe('suspended');
    });

    it('expéditeur non configuré : échec certain, jamais « accepté »', async () => {
      const a = await enrolledAdmin([EMAIL]);
      const s = await shop('noconf');
      emailSender.reset();
      emailSender.configured = false;
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['email']),
      );
      await drain();
      const [row] = await deliveriesOf(res.body.result.messageId as string);
      expect(row).toMatchObject({
        status: 'failed',
        reason: 'email_not_configured',
      });
      expect(emailSender.attempts).toBe(0);
    });
  });

  describe('Reprises d’e-mails et fenêtre de déduplication', () => {
    const deliveries = () => db().collection('platform_message_deliveries');

    /** Message e-mail validé, livraison encore non traitée. */
    async function pendingEmail(label: string) {
      const a = await enrolledAdmin([EMAIL]);
      const s = await shop(label);
      const res = await send(
        a,
        messageIntent(s.organizationId, [s.ownerId], ['email']),
      );
      expect(res.status).toBe(200);
      const [row] = await deliveriesOf(res.body.result.messageId as string);
      emailSender.reset();
      return { s, messageId: res.body.result.messageId as string, row };
    }

    it('début de fenêtre persisté avant l’appel, jamais réinitialisé (reprise, redémarrage, relance)', async () => {
      const { s, messageId, row } = await pendingEmail('window');
      // À chaque appel, le début de fenêtre est DÉJÀ en base.
      const seen: Array<Date | null> = [];
      const spy = jest
        .spyOn(emailSender, 'send')
        .mockImplementation(async () => {
          const current = await deliveries().findOne({ _id: row._id });
          seen.push((current!.firstAttemptAt as Date | null) ?? null);
          throw new EmailDeliveryError('timeout');
        });
      try {
        await worker.runOnce();
        const first = (await deliveries().findOne({ _id: row._id }))!
          .firstAttemptAt as Date;
        expect(first).toBeInstanceOf(Date);
        expect(seen).toEqual([first]);

        // Reprise automatique.
        clockOffsetMs += 2 * 60_000;
        await worker.runOnce();
        // Redémarrage : livraison restée « sending », verrou expiré.
        await deliveries().updateOne(
          { _id: row._id },
          {
            $set: { status: 'sending', lockedUntil: new Date(0) },
          },
        );
        await worker.runOnce();
        // Relance manuelle (incertitude dans la fenêtre).
        await deliveries().updateOne(
          { _id: row._id },
          { $set: { status: 'uncertain', lockedUntil: null } },
        );
        const b = await enrolledAdmin([EMAIL]);
        const intent = {
          action: 'organization_message_retry',
          organizationId: s.organizationId,
          operationId: randomUUID(),
          messageId,
          channel: 'email',
          deliveryIds: [String(row._id)],
        };
        const retried = await admin(
          'post',
          `/organizations/${s.organizationId}/message-retry`,
          b.token,
        ).send({
          operationId: intent.operationId,
          stepUpToken: await confirmed(b, intent),
          messageId,
          channel: 'email',
          deliveryIds: intent.deliveryIds,
        });
        expect(retried.status).toBe(200);
        await worker.runOnce();

        const after = (await deliveries().findOne({ _id: row._id }))!;
        expect(seen.length).toBe(4);
        for (const date of seen) expect(date).toEqual(first);
        expect(after.firstAttemptAt).toEqual(first);
        expect(after.uncertainAt).not.toBeNull();
        // Même clé d'idempotence à chaque appel.
        const keys = new Set(
          spy.mock.calls.map(([email]) => email.idempotencyKey),
        );
        expect([...keys]).toEqual([
          `platform-message/${messageId}/${s.ownerId}`,
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('fenêtre dépassée : plus aucun appel, y compris pour une livraison restée « sending » après un arrêt', async () => {
      const stale = await pendingEmail('stale');
      const pending = await pendingEmail('stale-pending');
      const old = new Date(
        clock().getTime() - MESSAGE_UNCERTAIN_RETRY_WINDOW_MS - 60_000,
      );
      // Arrêt du processus pendant l'appel, il y a plus de 23 h.
      await deliveries().updateOne(
        { _id: stale.row._id },
        {
          $set: {
            status: 'sending',
            lockedUntil: new Date(0),
            attempts: 1,
            firstAttemptAt: old,
          },
        },
      );
      // Incertitude connue, reprise échue après la fin de la fenêtre.
      await deliveries().updateOne(
        { _id: pending.row._id },
        {
          $set: {
            status: 'pending',
            nextAttemptAt: new Date(0),
            attempts: 1,
            firstAttemptAt: old,
            uncertainAt: old,
          },
        },
      );
      const spy = jest.spyOn(emailSender, 'send');
      try {
        await drain();
        // Aucun appel pour ces deux livraisons (d'autres peuvent être dues).
        const keys = spy.mock.calls.map(([email]) => email.idempotencyKey);
        for (const { messageId } of [stale, pending]) {
          expect(keys.filter((k) => k.includes(`/${messageId}/`))).toHaveLength(
            0,
          );
        }
      } finally {
        spy.mockRestore();
      }
      for (const id of [stale.row._id, pending.row._id]) {
        expect(await deliveries().findOne({ _id: id })).toMatchObject({
          status: 'uncertain',
          reason: 'retry_window_expired',
        });
      }
    });

    it('erreur définitive après une tentative incertaine : reste « incertain »', async () => {
      const { row } = await pendingEmail('then-422');
      emailSender.failure = new EmailDeliveryError('timeout');
      await worker.runOnce();
      const uncertain = (await deliveries().findOne({ _id: row._id }))!;
      expect(uncertain).toMatchObject({ status: 'pending' });
      expect(uncertain.uncertainAt).not.toBeNull();
      emailSender.failure = new EmailDeliveryError('rejected', 422);
      clockOffsetMs += 2 * 60_000;
      await worker.runOnce();
      const after = (await deliveries().findOne({ _id: row._id }))!;
      expect(after).toMatchObject({
        status: 'uncertain',
        reason: 'rejected_422',
      });
      expect(after.uncertainAt).toEqual(uncertain.uncertainAt);
      expect(after.firstAttemptAt).toEqual(uncertain.firstAttemptAt);
    });

    it('erreur interne après l’appel : acceptation possible retenue, renvoi avec la même clé', async () => {
      const { messageId, s, row } = await pendingEmail('post-call');
      // L'écriture du succès échoue une fois, après l'appel au prestataire.
      const finish = jest
        .spyOn(
          worker as unknown as { finish: (...args: unknown[]) => unknown },
          'finish',
        )
        .mockImplementationOnce(() => {
          throw new Error('écriture perdue');
        });
      try {
        await worker.runOnce();
        const kept = (await deliveries().findOne({ _id: row._id }))!;
        expect(kept.status).toBe('pending');
        expect(kept.uncertainAt).not.toBeNull();
        clockOffsetMs += 2 * 60_000;
        await worker.runOnce();
      } finally {
        finish.mockRestore();
      }
      const done = (await deliveries().findOne({ _id: row._id }))!;
      expect(done.status).toBe('accepted');
      expect(messageMails(s.ownerEmail).map((m) => m.idempotencyKey)).toEqual([
        `platform-message/${messageId}/${s.ownerId}`,
        `platform-message/${messageId}/${s.ownerId}`,
      ]);
    });
  });
});
