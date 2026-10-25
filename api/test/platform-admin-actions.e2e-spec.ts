import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
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
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
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
import { ensureSubscriptionPeriodIndexes } from '../src/subscriptions/subscription-period-indexes';
import { PLATFORM_ADMIN_CLOCK } from '../src/platform-admin/platform-admin-runtime';
import { currentTotpCode } from '../src/platform-admin/totp';
import {
  parseCliArguments,
  runPlatformAdminCli,
} from '../src/migrations/platform-admin-cli';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import {
  DAY_MS,
  SubscriptionSource,
} from '../src/subscriptions/subscription-terms';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from '../src/events/origin.helpers';

/**
 * E2E — actions de l'administration de la plateforme : capacités,
 * vérification renforcée liée, suspension / réactivation, prolongation
 * offerte, idempotence, concurrence, audit. Base éphémère, aucun service
 * externe ; appels faits comme le BFF.
 */

const emailSender = createE2eEmailSender();
const PASSWORD = 'platform-actions-e2e-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const E2E_CORS_ORIGIN = 'https://platform-actions.e2e.example.com';

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
  ownerEmail: string;
  ownerToken: string;
}

describe('Administration de la plateforme — actions (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let port = 0;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let subscriptions: SubscriptionsService;
  let seq = 0;
  let ipSeq = 0;

  const http = () => request(app.getHttpServer());
  const unique = (label: string) => `${label}-${++seq}@platform-actions.test`;
  const db = () => connection.db!;

  const admin = (
    method: 'get' | 'post',
    path: string,
    token?: string,
    ip = '203.0.113.200',
  ) => {
    let req = http()
      [method](`/platform-admin${path}`)
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', ip);
    if (token) req = req.set('x-platform-admin-session', token);
    return req;
  };

  const cli = async (argv: string[]) => {
    const args = parseCliArguments(argv);
    if (typeof args === 'string') throw new Error(args);
    return runPlatformAdminCli(connection, args, process.env, clock());
  };

  async function createUser(): Promise<{ userId: string; email: string }> {
    const email = unique('user');
    const userId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name: 'Compte e2e',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
    });
    return { userId: userId.toHexString(), email };
  }

  /** Administrateur accordé (lecture seule), enrôlé, session vérifiée. */
  async function enrolledAdmin(capabilities: string[] = []): Promise<Admin> {
    const { userId, email } = await createUser();
    const reason = '--reason=Recette des actions administratives';
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
    const login = await admin('post', '/auth/login', undefined, ip).send({
      email,
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const start = await admin(
      'post',
      '/mfa/enrollment/start',
      login.body.session.token,
      ip,
    );
    const secret = Secret.fromBase32(
      start.body.manualKey.replace(/ /g, ''),
    ).bytes;
    nextStep();
    const confirm = await admin(
      'post',
      '/mfa/enrollment/confirm',
      login.body.session.token,
      ip,
    ).send({
      challengeToken: start.body.challenge.token,
      code: currentTotpCode(secret, clock()),
    });
    expect(confirm.status).toBe(200);
    return { userId, email, secret, token: confirm.body.session.token };
  }

  /** Vérification renforcée liée à une action (contenu exact). */
  async function stepUp(a: Admin, intent: Record<string, unknown>) {
    nextStep();
    return admin('post', '/security/step-up', a.token).send({
      password: PASSWORD,
      code: currentTotpCode(a.secret, clock()),
      intent,
    });
  }

  async function confirmed(
    a: Admin,
    intent: Record<string, unknown>,
  ): Promise<string> {
    const res = await stepUp(a, intent);
    expect(res.status).toBe(200);
    return res.body.stepUpToken as string;
  }

  const suspendIntent = (
    organizationId: string,
    operationId = randomUUID(),
  ) => ({
    action: 'organization_suspend',
    organizationId,
    operationId,
    internalReason: 'Contrôle de conformité en cours (interne)',
    clientMessage:
      'Votre commerce est suspendu. Contactez le support Stock Master.',
  });

  const reactivateIntent = (
    organizationId: string,
    operationId = randomUUID(),
  ) => ({
    action: 'organization_reactivate',
    organizationId,
    operationId,
    reason: 'Conformité rétablie après vérification',
  });

  const extendIntent = (
    organizationId: string,
    days: number,
    expectedCoverageEndsAt: string | null,
    operationId = randomUUID(),
  ) => ({
    action: 'subscription_extend',
    organizationId,
    operationId,
    days,
    reason: 'Geste commercial après incident de service',
    expectedCoverageEndsAt,
  });

  const suspendBody = (
    intent: ReturnType<typeof suspendIntent>,
    stepUpToken: string,
  ) => ({
    operationId: intent.operationId,
    stepUpToken,
    internalReason: intent.internalReason,
    clientMessage: intent.clientMessage,
  });

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
    return { organizationId, ownerEmail, ownerToken: login.body.access_token };
  }

  const periodsOf = (organizationId: string) =>
    db()
      .collection('subscription_periods')
      .find({ organizationId: new Types.ObjectId(organizationId) })
      .sort({ startsAt: 1 })
      .toArray();

  /** Remplace les périodes d'une organisation (fixtures de calcul). */
  async function setPeriods(
    organizationId: string,
    ranges: Array<[number, number]>,
  ): Promise<void> {
    const oid = new Types.ObjectId(organizationId);
    await db()
      .collection('subscription_periods')
      .deleteMany({ organizationId: oid });
    const now = Date.now();
    let previous: Types.ObjectId | null = null;
    for (const [i, [from, to]] of ranges.entries()) {
      const _id = new Types.ObjectId();
      await db()
        .collection('subscription_periods')
        .insertOne({
          _id,
          organizationId: oid,
          sequence: i + 1,
          kind: 'subscription',
          term: 'monthly',
          startsAt: new Date(now + from * DAY_MS),
          endsAt: new Date(now + to * DAY_MS),
          source: 'manual',
          sourceReference: `fixture:${organizationId}:${i}`,
          grantedBy: 'e2e',
          previousPeriodId: previous,
          createdAt: new Date(),
        });
      previous = _id;
    }
  }

  async function coverageEnd(a: Admin, organizationId: string, days: number) {
    const preview = await admin(
      'get',
      `/organizations/${organizationId}/extension-preview?days=${days}`,
      a.token,
    );
    expect(preview.status).toBe(200);
    return preview.body;
  }

  function connectSocket(token: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('connect timeout')),
        5_000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
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
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL = 'https://app.platform-actions.e2e.test';
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
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(E2E_CORS_ORIGIN, 'development')),
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
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;

      connection = app.get<Connection>(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      subscriptions = moduleFixture.get(SubscriptionsService);
      await ensurePlatformAdminIndexes(connection);
      await ensureSubscriptionPeriodIndexes(connection);
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  // Limitation en mémoire des routes publiques (inscription) : remise à zéro
  // entre les tests, comme les autres suites.
  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('Autorisations', () => {
    it('commerce : un JWT de propriétaire n’ouvre aucune action', async () => {
      const s = await shop('owner-a');
      const res = await http()
        .post(`/platform-admin/organizations/${s.organizationId}/suspend`)
        .set('Authorization', `Bearer ${s.ownerToken}`)
        .send({});
      expect([401, 403]).toContain(res.status);
      const invite = await http()
        .post('/organizations/invitations')
        .set('Authorization', `Bearer ${s.ownerToken}`)
        .send({
          email: unique('invitee'),
          role: 'admin',
          permissions: ['platform.organizations.suspend'],
        });
      expect(invite.status).toBe(400);
    });

    it('administrateur en lecture seule : lecture oui, aucune action', async () => {
      const s = await shop('owner-b');
      const a = await enrolledAdmin();
      const status = await admin('get', '/auth/status', a.token);
      expect(status.body.capabilities).toEqual(['platform.read']);
      expect(
        (await admin('get', `/organizations/${s.organizationId}`, a.token))
          .status,
      ).toBe(200);
      const intent = suspendIntent(s.organizationId);
      const up = await stepUp(a, intent);
      expect(up.status).toBe(403);
      expect(up.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      const res = await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(suspendBody(intent, randomBytes(32).toString('base64url')));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      expect(
        (
          await admin(
            'get',
            `/organizations/${s.organizationId}/extension-preview?days=5`,
            a.token,
          )
        ).status,
      ).toBe(403);
    });

    it('capacité retirée : plus de lecture', async () => {
      const a = await enrolledAdmin();
      await cli([
        'capability-remove',
        `--user-id=${a.userId}`,
        '--capability=platform.read',
        '--reason=Test du retrait de la lecture',
        '--operator=e2e',
        '--apply',
      ]);
      const res = await admin('get', '/overview', a.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
    });

    it('MFA seule insuffisante ; preuve non liée, autre cible, autre contenu ou expirée : refus', async () => {
      const s = await shop('owner-c');
      const other = await shop('owner-c2');
      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const intent = suspendIntent(s.organizationId);
      const send = (token: string, body = suspendBody(intent, token)) =>
        admin(
          'post',
          `/organizations/${s.organizationId}/suspend`,
          a.token,
        ).send(body);

      // Aucune preuve.
      const none = await send(randomBytes(32).toString('base64url'));
      expect(none.status).toBe(403);
      expect(none.body.code).toBe('PLATFORM_ADMIN_STEP_UP_REQUIRED');
      // Preuve des opérations de sécurité (non liée).
      nextStep();
      const unbound = await admin('post', '/security/step-up', a.token).send({
        password: PASSWORD,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(unbound.status).toBe(200);
      expect((await send(unbound.body.stepUpToken)).status).toBe(403);
      // Preuve d'une autre organisation.
      const otherToken = await confirmed(
        a,
        suspendIntent(other.organizationId, intent.operationId),
      );
      expect((await send(otherToken)).status).toBe(403);
      // Contenu modifié après confirmation.
      const token = await confirmed(a, intent);
      const changed = await send(token, {
        ...suspendBody(intent, token),
        clientMessage: 'Message modifié après la confirmation',
      });
      expect(changed.status).toBe(403);
      // Preuve expirée (5 min).
      const late = await confirmed(a, intent);
      clockOffsetMs += 6 * 60_000;
      expect((await send(late)).status).toBe(403);
      const org = await db()
        .collection('organizations')
        .findOne({ _id: new Types.ObjectId(s.organizationId) });
      expect(org?.status).toBe('active');
    });
  });

  describe('Suspension et réactivation', () => {
    it('suspension : refus HTTP, socket fermée, autres commerces accessibles, données conservées', async () => {
      const s = await shop('owner-d');
      const otherShop = await shop('owner-d-other');
      // Le propriétaire de S est aussi vendeur d'un autre commerce.
      const owner = await userModel.findOne({ email: s.ownerEmail });
      await membershipModel.create({
        organizationId: new Types.ObjectId(otherShop.organizationId),
        userId: owner!._id,
        role: 'seller',
        status: 'active',
      });
      const seller = await createUser();
      await membershipModel.create({
        organizationId: new Types.ObjectId(s.organizationId),
        userId: new Types.ObjectId(seller.userId),
        role: 'seller',
        status: 'active',
      });
      const before = {
        memberships: await membershipModel
          .find({ organizationId: s.organizationId })
          .lean(),
        periods: await periodsOf(s.organizationId),
      };
      const socket = await connectSocket(s.ownerToken);
      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        socket.once('disconnect', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const intent = suspendIntent(s.organizationId);
      const res = await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(suspendBody(intent, await confirmed(a, intent)));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        replayed: false,
        result: { status: 'suspended' },
      });
      expect(await closed).toBe(true);
      await expect(connectSocket(s.ownerToken)).rejects.toBeTruthy();

      // Accès métier refusés (lecture, écriture, export), code distinct.
      for (const req of [
        http().get('/products').set('Authorization', `Bearer ${s.ownerToken}`),
        http()
          .post('/sections')
          .set('Authorization', `Bearer ${s.ownerToken}`)
          .send({ name: 'X' }),
        http()
          .get('/auth/context')
          .set('Authorization', `Bearer ${s.ownerToken}`),
        http()
          .post('/organizations/current/subscription/payments')
          .set('Authorization', `Bearer ${s.ownerToken}`)
          .send({}),
      ]) {
        const r = await req;
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('ORGANIZATION_SUSPENDED');
        expect(JSON.stringify(r.body)).not.toContain('conformité en cours');
      }

      // Connexion : choix explicite, commerce suspendu signalé.
      const login = await http()
        .post('/auth/login')
        .send({ email: s.ownerEmail, password: PASSWORD });
      expect(login.body.organizationSelectionRequired).toBe(true);
      expect(
        login.body.organizations.map(
          (o: { organizationId: string }) => o.organizationId,
        ),
      ).toEqual([otherShop.organizationId]);
      expect(login.body.suspendedOrganizations[0].organizationId).toBe(
        s.organizationId,
      );
      const limited = await http().post('/auth/login').send({
        email: s.ownerEmail,
        password: PASSWORD,
        organizationId: s.organizationId,
      });
      expect(limited.status).toBe(403);
      expect(limited.body.code).toBe('ORGANIZATION_SUSPENDED');
      expect(limited.body.suspension).toMatchObject({
        isOwner: true,
        message: intent.clientMessage,
      });
      expect(limited.body.access_token).toBeUndefined();
      const otherLogin = await http().post('/auth/login').send({
        email: s.ownerEmail,
        password: PASSWORD,
        organizationId: otherShop.organizationId,
      });
      expect(otherLogin.status).toBe(201);
      expect(
        (
          await http()
            .get('/auth/context')
            .set('Authorization', `Bearer ${otherLogin.body.access_token}`)
        ).status,
      ).toBe(200);
      // Vendeur du commerce suspendu : statut seulement, sans le message.
      const sellerLogin = await http()
        .post('/auth/login')
        .send({ email: seller.email, password: PASSWORD });
      expect(sellerLogin.status).toBe(403);
      expect(sellerLogin.body.suspension).toMatchObject({
        isOwner: false,
        message: null,
      });

      // Données, droits et périodes conservés.
      expect(
        await membershipModel.find({ organizationId: s.organizationId }).lean(),
      ).toEqual(before.memberships);
      expect(await periodsOf(s.organizationId)).toEqual(before.periods);

      // Fiche admin : motif interne et message séparés.
      const detail = await admin(
        'get',
        `/organizations/${s.organizationId}`,
        a.token,
      );
      expect(detail.body.suspension).toMatchObject({
        internalReason: intent.internalReason,
        clientMessage: intent.clientMessage,
        suspendedBy: a.email,
      });
      expect(detail.body.actions[0]).toMatchObject({
        action: 'organization_suspend',
        operationId: intent.operationId,
      });

      // Réactivation : capacité + preuve liée ; rien d'autre ne change.
      const r = reactivateIntent(s.organizationId);
      const reactivated = await admin(
        'post',
        `/organizations/${s.organizationId}/reactivate`,
        a.token,
      ).send({
        operationId: r.operationId,
        stepUpToken: await confirmed(a, r),
        reason: r.reason,
      });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body.result.status).toBe('active');
      expect(
        await membershipModel.find({ organizationId: s.organizationId }).lean(),
      ).toEqual(before.memberships);
      expect(await periodsOf(s.organizationId)).toEqual(before.periods);
      expect(
        (
          await http()
            .get('/auth/context')
            .set('Authorization', `Bearer ${s.ownerToken}`)
        ).status,
      ).toBe(200);
      socket.close();
    });

    it('membre désactivé avant la suspension : la réactivation ne le réactive pas', async () => {
      const s = await shop('owner-e');
      const seller = await createUser();
      await membershipModel.create({
        organizationId: new Types.ObjectId(s.organizationId),
        userId: new Types.ObjectId(seller.userId),
        role: 'seller',
        status: 'suspended',
      });
      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const sus = suspendIntent(s.organizationId);
      await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(suspendBody(sus, await confirmed(a, sus)));
      const r = reactivateIntent(s.organizationId);
      await admin(
        'post',
        `/organizations/${s.organizationId}/reactivate`,
        a.token,
      ).send({
        operationId: r.operationId,
        stepUpToken: await confirmed(a, r),
        reason: r.reason,
      });
      const membership = await membershipModel.findOne({
        userId: new Types.ObjectId(seller.userId),
        organizationId: new Types.ObjectId(s.organizationId),
      });
      expect(membership?.status).toBe('suspended');
    });

    it('idempotence : même identifiant et contenu → résultat existant ; contenu différent → 409', async () => {
      const s = await shop('owner-f');
      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const intent = suspendIntent(s.organizationId);
      const body = suspendBody(intent, await confirmed(a, intent));
      const first = await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(body);
      expect(first.status).toBe(200);
      // Rejeu (réponse réseau perdue) : sans nouvelle preuve, sans effet.
      const replay = await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        replayed: true,
        operationId: intent.operationId,
      });
      expect(replay.body.result).toEqual(first.body.result);
      const conflict = await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send({
        ...body,
        clientMessage: 'Un autre message pour le même identifiant',
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PLATFORM_ADMIN_OPERATION_CONFLICT');
      const audits = await db()
        .collection('platform_admin_audit')
        .find({
          action: 'organization_suspend',
          operationId: intent.operationId,
          outcome: 'success',
        })
        .toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        capability: 'platform.organizations.suspend',
        targetId: s.organizationId,
        before: { status: 'active' },
        after: { status: 'suspended' },
        detail: intent.internalReason,
      });
    });

    it('concurrence : même opération envoyée deux fois → un seul effet ; deux administrateurs → un succès, un 409', async () => {
      const s = await shop('owner-g');
      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const b = await enrolledAdmin(['platform.organizations.suspend']);
      const same = suspendIntent(s.organizationId);
      const body = suspendBody(same, await confirmed(a, same));
      const twice = await Promise.all([
        admin(
          'post',
          `/organizations/${s.organizationId}/suspend`,
          a.token,
        ).send(body),
        admin(
          'post',
          `/organizations/${s.organizationId}/suspend`,
          a.token,
        ).send(body),
      ]);
      expect(twice.map((r) => r.status)).toEqual([200, 200]);
      expect(twice.filter((r) => r.body.replayed === false)).toHaveLength(1);

      const s2 = await shop('owner-g2');
      const ia = suspendIntent(s2.organizationId);
      const ib = suspendIntent(s2.organizationId);
      const [ta, tb] = [await confirmed(a, ia), await confirmed(b, ib)];
      const race = await Promise.all([
        admin(
          'post',
          `/organizations/${s2.organizationId}/suspend`,
          a.token,
        ).send(suspendBody(ia, ta)),
        admin(
          'post',
          `/organizations/${s2.organizationId}/suspend`,
          b.token,
        ).send(suspendBody(ib, tb)),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(race.find((r) => r.status === 409)!.body.code).toBe(
        'PLATFORM_ADMIN_STATE_CHANGED',
      );
    });

    it('paiement confirmé pendant la suspension : période accordée, commerce toujours suspendu', async () => {
      const s = await shop('owner-h');
      const a = await enrolledAdmin(['platform.organizations.suspend']);
      const intent = suspendIntent(s.organizationId);
      await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(suspendBody(intent, await confirmed(a, intent)));
      await subscriptions.runInGrantTransaction((session) =>
        subscriptions.grantSubscriptionInSession(
          {
            organizationId: s.organizationId,
            term: 'monthly',
            source: SubscriptionSource.PAYMENT,
            sourceReference: `payment:e2e-${randomUUID()}`,
            grantedBy: 'payment:e2e',
          },
          session,
        ),
      );
      const org = await db()
        .collection('organizations')
        .findOne({ _id: new Types.ObjectId(s.organizationId) });
      expect(org?.status).toBe('suspended');
      expect(
        (await periodsOf(s.organizationId)).some((p) => p.source === 'payment'),
      ).toBe(true);
    });
  });

  describe('Prolongation offerte', () => {
    async function extend(
      a: Admin,
      organizationId: string,
      days: number,
      expected: string | null,
      operationId?: string,
    ) {
      const intent = extendIntent(organizationId, days, expected, operationId);
      return {
        intent,
        res: await admin(
          'post',
          `/organizations/${organizationId}/extend`,
          a.token,
        ).send({
          operationId: intent.operationId,
          stepUpToken: await confirmed(a, intent),
          days,
          reason: intent.reason,
          expectedCoverageEndsAt: expected,
        }),
      };
    }

    it('essai : à la suite de l’essai, aucune trace de paiement ni de revenu, idempotente', async () => {
      const s = await shop('owner-i');
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      const payments = await db()
        .collection('subscription_payments')
        .countDocuments({});
      const revenueBefore = (await admin('get', '/overview', a.token)).body
        .payments.collected30Days;
      const preview = await coverageEnd(a, s.organizationId, 10);
      expect(preview.plan).toMatchObject({
        ok: true,
        basis: 'extend-coverage',
        scheduledPeriods: 0,
      });
      const trialEnd = preview.plan.previousCoverageEndsAt as string;
      const { intent, res } = await extend(a, s.organizationId, 10, trialEnd);
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({
        source: 'offered',
        days: 10,
        startsAt: trialEnd,
      });
      expect(new Date(res.body.result.endsAt).getTime()).toBe(
        new Date(trialEnd).getTime() + 10 * DAY_MS,
      );
      const offered = (await periodsOf(s.organizationId)).filter(
        (p) => p.source === 'offered',
      );
      expect(offered).toHaveLength(1);
      expect(offered[0]).toMatchObject({
        term: null,
        offeredDays: 10,
        kind: 'subscription',
      });
      expect(
        await db().collection('subscription_payments').countDocuments({}),
      ).toBe(payments);
      expect(
        (await admin('get', '/overview', a.token)).body.payments
          .collected30Days,
      ).toEqual(revenueBefore);
      // Rejeu : aucune seconde période.
      const replay = await admin(
        'post',
        `/organizations/${s.organizationId}/extend`,
        a.token,
      ).send({
        operationId: intent.operationId,
        stepUpToken: randomBytes(32).toString('base64url'),
        days: 10,
        reason: intent.reason,
        expectedCoverageEndsAt: trialEnd,
      });
      expect(replay.body.replayed).toBe(true);
      expect(
        (await periodsOf(s.organizationId)).filter(
          (p) => p.source === 'offered',
        ),
      ).toHaveLength(1);
      // Commerce : prolongation identifiée, sans source détaillée.
      const view = await http()
        .get('/subscriptions/me')
        .set('Authorization', `Bearer ${s.ownerToken}`);
      if (view.status === 200 && Array.isArray(view.body.periods)) {
        expect(
          view.body.periods.some(
            (p: { offered?: boolean }) => p.offered === true,
          ),
        ).toBe(true);
      }
    });

    it('abonnement valide avec période future jointive : après celle-ci, programmée inchangée', async () => {
      const s = await shop('owner-j');
      await setPeriods(s.organizationId, [
        [-10, 5],
        [5, 35],
      ]);
      const before = await periodsOf(s.organizationId);
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      const preview = await coverageEnd(a, s.organizationId, 7);
      expect(preview.plan).toMatchObject({ ok: true, scheduledPeriods: 1 });
      const { res } = await extend(
        a,
        s.organizationId,
        7,
        preview.plan.previousCoverageEndsAt,
      );
      expect(res.status).toBe(200);
      expect(res.body.result.startsAt).toBe(before[1].endsAt.toISOString());
      const after = await periodsOf(s.organizationId);
      expect(after.slice(0, 2)).toEqual(before);
    });

    it('abonnement expiré : commence à l’heure serveur', async () => {
      const s = await shop('owner-k');
      await setPeriods(s.organizationId, [[-40, -10]]);
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      const preview = await coverageEnd(a, s.organizationId, 30);
      expect(preview.plan).toMatchObject({
        ok: true,
        basis: 'start-now',
        previousCoverageEndsAt: null,
      });
      const startedBefore = Date.now();
      const { res } = await extend(a, s.organizationId, 30, null);
      expect(res.status).toBe(200);
      expect(
        new Date(res.body.result.startsAt).getTime(),
      ).toBeGreaterThanOrEqual(startedBefore - 1000);
      expect(
        (
          await http()
            .get('/auth/context')
            .set('Authorization', `Bearer ${s.ownerToken}`)
        ).body.access.applicationAccess,
      ).toBe(true);
    });

    it('interruption ou période programmée sans couverture : refus, rien réécrit', async () => {
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      for (const ranges of [
        [
          [-5, 2],
          [4, 30],
        ],
        [
          [-40, -10],
          [3, 33],
        ],
      ] as Array<Array<[number, number]>>) {
        const s = await shop('owner-l');
        await setPeriods(s.organizationId, ranges);
        const before = await periodsOf(s.organizationId);
        const preview = await coverageEnd(a, s.organizationId, 5);
        expect(preview.plan.ok).toBe(false);
        const { res } = await extend(a, s.organizationId, 5, null);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PLATFORM_ADMIN_EXTENSION_REFUSED');
        expect(await periodsOf(s.organizationId)).toEqual(before);
      }
    });

    it('couverture modifiée depuis l’aperçu, concurrence entre administrateurs : pas de double prolongation', async () => {
      const s = await shop('owner-m');
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      const b = await enrolledAdmin(['platform.subscriptions.extend']);
      const expected = (await coverageEnd(a, s.organizationId, 3)).plan
        .previousCoverageEndsAt;
      const ia = extendIntent(s.organizationId, 3, expected);
      const ib = extendIntent(s.organizationId, 3, expected);
      const [ta, tb] = [await confirmed(a, ia), await confirmed(b, ib)];
      const race = await Promise.all(
        [
          [a, ia, ta],
          [b, ib, tb],
        ].map(([who, intent, token]) =>
          admin(
            'post',
            `/organizations/${s.organizationId}/extend`,
            (who as Admin).token,
          ).send({
            operationId: (intent as typeof ia).operationId,
            stepUpToken: token,
            days: 3,
            reason: (intent as typeof ia).reason,
            expectedCoverageEndsAt: expected,
          }),
        ),
      );
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(race.find((r) => r.status === 409)!.body.code).toBe(
        'PLATFORM_ADMIN_STATE_CHANGED',
      );
      expect(
        (await periodsOf(s.organizationId)).filter(
          (p) => p.source === 'offered',
        ),
      ).toHaveLength(1);
    });

    it('concurrence avec une confirmation de paiement : périodes jointives, jamais superposées', async () => {
      const s = await shop('owner-n');
      const a = await enrolledAdmin(['platform.subscriptions.extend']);
      const expected = (await coverageEnd(a, s.organizationId, 5)).plan
        .previousCoverageEndsAt;
      const intent = extendIntent(s.organizationId, 5, expected);
      const token = await confirmed(a, intent);
      const [extended] = await Promise.all([
        admin(
          'post',
          `/organizations/${s.organizationId}/extend`,
          a.token,
        ).send({
          operationId: intent.operationId,
          stepUpToken: token,
          days: 5,
          reason: intent.reason,
          expectedCoverageEndsAt: expected,
        }),
        subscriptions.runInGrantTransaction((session) =>
          subscriptions.grantSubscriptionInSession(
            {
              organizationId: s.organizationId,
              term: 'monthly',
              source: SubscriptionSource.PAYMENT,
              sourceReference: `payment:e2e-${randomUUID()}`,
              grantedBy: 'payment:e2e',
            },
            session,
          ),
        ),
      ]);
      // Paiement validé avant : la prolongation est refusée (couverture
      // changée) ; après : elle s'insère avant le paiement. Jamais les deux
      // sur la même plage.
      expect([200, 409]).toContain(extended.status);
      const periods = await periodsOf(s.organizationId);
      for (let i = 1; i < periods.length; i++) {
        expect(periods[i].startsAt.getTime()).toBe(
          periods[i - 1].endsAt.getTime(),
        );
      }
      expect(periods.filter((p) => p.source === 'payment')).toHaveLength(1);
    });

    it('prolongation d’un commerce suspendu : la suspension reste', async () => {
      const s = await shop('owner-o');
      const a = await enrolledAdmin([
        'platform.organizations.suspend',
        'platform.subscriptions.extend',
      ]);
      const sus = suspendIntent(s.organizationId);
      await admin(
        'post',
        `/organizations/${s.organizationId}/suspend`,
        a.token,
      ).send(suspendBody(sus, await confirmed(a, sus)));
      const expected = (await coverageEnd(a, s.organizationId, 2)).plan
        .previousCoverageEndsAt;
      const { res } = await extend(a, s.organizationId, 2, expected);
      expect(res.status).toBe(200);
      const org = await db()
        .collection('organizations')
        .findOne({ _id: new Types.ObjectId(s.organizationId) });
      expect(org?.status).toBe('suspended');
    });
  });

  it('audit : capacité, opération, avant/après ; aucun secret ni code', async () => {
    const rows = await db()
      .collection('platform_admin_audit')
      .find({
        action: {
          $in: [
            'organization_suspend',
            'organization_reactivate',
            'subscription_extend',
            'mfa_step_up',
            'capability_grant',
          ],
        },
      })
      .toArray();
    expect(
      rows.some((r) => r.action === 'capability_grant' && r.capability),
    ).toBe(true);
    expect(
      rows.some((r) => r.action === 'subscription_extend' && r.after?.days),
    ).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(PROXY_SECRET);
    expect(text).not.toMatch(/"stepUpToken"|"code":"\d{6}"|tokenHash/);
    const ops = JSON.stringify(
      await db().collection('platform_admin_operations').find({}).toArray(),
    );
    expect(ops).not.toMatch(/stepUpToken|tokenHash/);
  });
});
