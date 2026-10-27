import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { Secret } from 'otpauth';
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
import {
  OWNER_TERMS,
  simulatedTurnstileToken,
} from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { ensurePlatformAdminIndexes } from '../src/platform-admin/platform-admin-indexes';
import { ensureSubscriptionPeriodIndexes } from '../src/subscriptions/subscription-period-indexes';
import {
  PLATFORM_ADMIN_CLOCK,
  PLATFORM_ADMIN_CONFIG,
} from '../src/platform-admin/platform-admin-runtime';
import { currentTotpCode } from '../src/platform-admin/totp';
import {
  parseCliArguments,
  runPlatformAdminCli,
} from '../src/migrations/platform-admin-cli';

/**
 * E2E — administration de la plateforme : autorisation séparée, session
 * administrative, double authentification obligatoire, données en lecture
 * seule. Base MongoDB éphémère, e-mails simulés, aucun service externe ;
 * appels faits comme le BFF (secret partagé, jeton de session en en-tête).
 */

const emailSender = createE2eEmailSender();
const PASSWORD = 'platform-admin-e2e-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const MFA_KEY = randomBytes(32).toString('base64');
const E2E_CORS_ORIGIN = 'https://platform-admin.e2e.example.com';

let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
/** Avance d'un pas TOTP (un code neuf, jamais un rejeu involontaire). */
const nextStep = () => {
  clockOffsetMs += 30_000;
};

interface Admin {
  userId: string;
  email: string;
  secret: Uint8Array;
  token: string;
  recoveryCodes: string[];
}

describe('Administration de la plateforme (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let seq = 0;
  let ownerToken = '';
  let organizationId = '';
  const issuedSecrets: string[] = [];

  const http = () => request(app.getHttpServer());
  const unique = (label: string) => `${label}-${++seq}@platform-admin.test`;
  const ip = (n: number) => `203.0.113.${n}`;

  /** Requête telle que la ferait le BFF. */
  const admin = (
    method: 'get' | 'post',
    path: string,
    options: { token?: string; ip?: string; proxy?: string | null } = {},
  ) => {
    let req = http()[method](`/platform-admin${path}`);
    if (options.proxy !== null) {
      req = req.set('x-platform-admin-proxy', options.proxy ?? PROXY_SECRET);
    }
    if (options.token) req = req.set('x-platform-admin-session', options.token);
    return req.set('x-platform-admin-client-ip', options.ip ?? ip(1));
  };

  const cli = async (argv: string[]) => {
    const args = parseCliArguments(argv);
    if (typeof args === 'string') throw new Error(args);
    return runPlatformAdminCli(connection, args, process.env, clock());
  };
  const grant = (userId: string) =>
    cli([
      'grant',
      `--user-id=${userId}`,
      '--reason=Recette administration',
      '--operator=e2e',
      '--apply',
    ]);

  async function createUser(
    options: { verified?: boolean; role?: 'admin' | 'seller' } = {},
  ): Promise<{ userId: string; email: string }> {
    const email = unique('user');
    const userId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name: 'Compte e2e',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      ...(options.role ? { role: options.role } : {}),
      ...(options.verified === false
        ? {}
        : { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT }),
    });
    return { userId: userId.toHexString(), email };
  }

  const loginAdmin = (email: string, password = PASSWORD, clientIp = ip(1)) =>
    admin('post', '/auth/login', { ip: clientIp }).send({ email, password });

  const secretFrom = (manualKey: string): Uint8Array => {
    issuedSecrets.push(manualKey.replace(/ /g, ''));
    return Secret.fromBase32(manualKey.replace(/ /g, '')).bytes;
  };

  /** Compte accordé, enrôlé, session vérifiée. */
  async function enrolledAdmin(clientIp = ip(1)): Promise<Admin> {
    const { userId, email } = await createUser();
    await grant(userId);
    const login = await loginAdmin(email, PASSWORD, clientIp);
    expect(login.status).toBe(200);
    expect(login.body.stage).toBe('enroll');
    const start = await admin('post', '/mfa/enrollment/start', {
      token: login.body.session.token,
      ip: clientIp,
    });
    expect(start.status).toBe(200);
    const secret = secretFrom(start.body.manualKey);
    nextStep();
    const confirm = await admin('post', '/mfa/enrollment/confirm', {
      token: login.body.session.token,
      ip: clientIp,
    }).send({
      challengeToken: start.body.challenge.token,
      code: currentTotpCode(secret, clock()),
    });
    expect(confirm.status).toBe(200);
    return {
      userId,
      email,
      secret,
      token: confirm.body.session.token,
      recoveryCodes: confirm.body.recoveryCodes,
    };
  }

  /** Connexion complète (mot de passe + TOTP neuf). */
  async function signIn(a: Admin, clientIp = ip(1)): Promise<string> {
    const login = await loginAdmin(a.email, PASSWORD, clientIp);
    expect(login.status).toBe(200);
    expect(login.body.stage).toBe('verify');
    nextStep();
    const verify = await admin('post', '/mfa/verify', {
      token: login.body.session.token,
      ip: clientIp,
    }).send({
      challengeToken: login.body.challenge.token,
      code: currentTotpCode(a.secret, clock()),
    });
    expect(verify.status).toBe(200);
    return verify.body.session.token as string;
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
      process.env.PUBLIC_APP_URL = 'https://app.platform-admin.e2e.test';
      process.env.PLATFORM_ADMIN_ENABLED = 'true';
      process.env.PLATFORM_ADMIN_MFA_KEYS = `e2e1:${MFA_KEY}`;
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
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      // Même étape que `migrate:predeploy` (index seuls, aucun accès).
      await ensurePlatformAdminIndexes(connection);
      await ensureSubscriptionPeriodIndexes(connection);

      const ownerEmail = unique('owner');
      const reg = await postRegister(app, {
        ...OWNER_TERMS,
        name: 'Propriétaire',
        email: ownerEmail,
        password: PASSWORD,
        organizationName: 'Boutique Admin',
      });
      expect(reg.status).toBe(202);
      organizationId = reg.owner!.organization._id;
      const res = await http()
        .post('/auth/login')
        .send({ email: ownerEmail, password: PASSWORD, organizationId });
      expect(res.status).toBe(201);
      ownerToken = res.body.access_token as string;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('Autorisation plateforme séparée', () => {
    it('sans le secret du BFF : route masquée, identique à une URL inconnue', async () => {
      const strip = (r: request.Response) => ({
        status: r.status,
        body: { ...r.body, path: undefined, timestamp: undefined },
        cacheControl: r.headers['cache-control'],
        robots: r.headers['x-robots-tag'],
      });
      const unknown = await http().get('/route-inconnue-xyz');
      const base = strip(unknown);
      for (const proxy of [null, randomBytes(32).toString('base64url')]) {
        const res = await admin('post', '/auth/login', { proxy }).send({
          email: 'x@example.test',
          password: 'x',
        });
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Cannot POST /platform-admin/auth/login');
        expect(strip(res)).toEqual({
          ...base,
          body: {
            ...base.body,
            message: 'Cannot POST /platform-admin/auth/login',
          },
        });
        expect(JSON.stringify(res.body)).not.toMatch(
          /PLATFORM_ADMIN|secret|BFF/,
        );
      }
    });

    it('un JWT de commerce (propriétaire) n’ouvre aucune route plateforme', async () => {
      const res = await admin('get', '/overview').set(
        'Authorization',
        `Bearer ${ownerToken}`,
      );
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PLATFORM_ADMIN_SESSION_EXPIRED');
    });

    it('propriétaire, administrateur et vendeur de commerce, rôle historique admin : refusés', async () => {
      const ownerEmail = (await userModel.findOne({ name: 'Propriétaire' }))!
        .email;
      const shopAdmin = await createUser();
      const seller = await createUser();
      const legacy = await createUser({ role: 'admin' });
      for (const [account, role] of [
        [shopAdmin, 'admin'],
        [seller, 'seller'],
      ] as const) {
        await membershipModel.create({
          organizationId: new Types.ObjectId(organizationId),
          userId: new Types.ObjectId(account.userId),
          role,
          status: 'active',
        });
      }
      for (const email of [
        ownerEmail,
        shopAdmin.email,
        seller.email,
        legacy.email,
      ]) {
        const res = await loginAdmin(email, PASSWORD, ip(2));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PLATFORM_ADMIN_ACCESS_DENIED');
        expect(res.body.session).toBeUndefined();
      }
    });

    it('inscription, profil et invitation ne permettent pas de s’attribuer l’accès', async () => {
      const email = unique('selfgrant');
      const reg = await http()
        .post('/auth/register')
        .send({
          ...OWNER_TERMS,
          name: 'Intrus',
          email,
          password: PASSWORD,
          organizationName: 'Boutique Intrus',
          platformAdmin: true,
        });
      expect(reg.status).toBe(400);

      const locale = await http()
        .put('/auth/me/locale')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ locale: 'fr', platformAdmin: true, role: 'platform_admin' });
      expect(locale.status).toBe(400);

      const invite = await http()
        .post('/organizations/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          email: unique('invitee'),
          role: 'admin',
          permissions: ['platform.admin'],
        });
      expect(invite.status).toBe(400);

      const grants = await connection
        .db!.collection('platform_admin_grants')
        .countDocuments({});
      const users = await userModel.find({}).select('_id').lean();
      const granted = await connection
        .db!.collection('platform_admin_grants')
        .find({ userId: { $in: users.map((u) => u._id) } })
        .toArray();
      expect(granted).toHaveLength(grants);
      expect(grants).toBe(0);
    });

    it('commande opérateur : lecture seule par défaut, audit à l’application, adresse vérifiée exigée', async () => {
      const { userId } = await createUser();
      const dry = await cli([
        'grant',
        `--user-id=${userId}`,
        '--reason=Essai sans écriture',
        '--operator=e2e',
      ]);
      expect(dry.result).toBe('dry-run:grant');
      expect(
        await connection
          .db!.collection('platform_admin_grants')
          .countDocuments({}),
      ).toBe(0);

      const applied = await grant(userId);
      expect(applied.result).toBe('granted');
      const audit = await connection
        .db!.collection('platform_admin_audit')
        .findOne({ action: 'access_grant', targetId: userId });
      expect(audit).toMatchObject({
        actorType: 'operator',
        actorLabel: 'e2e',
        outcome: 'success',
      });
      expect((await grant(userId)).result).toBe('already-active');

      const unverified = await createUser({ verified: false });
      await expect(grant(unverified.userId)).rejects.toThrow(/non vérifiée/);
      await expect(
        cli([
          'grant',
          `--user-id=${new Types.ObjectId().toHexString()}`,
          '--reason=Compte inexistant',
          '--operator=e2e',
          '--apply',
        ]),
      ).rejects.toThrow(/introuvable/);
    });
  });

  describe('Double authentification obligatoire', () => {
    it('mot de passe seul : aucune donnée, enrôlement seulement', async () => {
      const { userId, email } = await createUser();
      await grant(userId);
      const login = await loginAdmin(email, PASSWORD, ip(3));
      expect(login.status).toBe(200);
      expect(login.body.stage).toBe('enroll');
      const token = login.body.session.token as string;
      for (const path of [
        '/overview',
        '/organizations',
        '/payments',
        '/audit',
      ]) {
        const res = await admin('get', path, { token, ip: ip(3) });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('PLATFORM_ADMIN_MFA_REQUIRED');
      }
      // Pas de challenge de connexion sans facteur ; aucun accès aux
      // opérations de sécurité réservées à une session vérifiée.
      expect(
        (await admin('post', '/mfa/challenge', { token, ip: ip(3) })).status,
      ).toBe(403);
      expect(
        (
          await admin('post', '/security/step-up', { token, ip: ip(3) }).send({
            password: PASSWORD,
          })
        ).status,
      ).toBe(401);
    });

    it('enrôlement non confirmé, code incorrect : toujours aucun accès', async () => {
      const { userId, email } = await createUser();
      await grant(userId);
      const login = await loginAdmin(email, PASSWORD, ip(4));
      const token = login.body.session.token as string;
      const start = await admin('post', '/mfa/enrollment/start', {
        token,
        ip: ip(4),
      });
      expect(start.status).toBe(200);
      expect(start.body.uri).toMatch(/^otpauth:\/\/totp\//);
      secretFrom(start.body.manualKey);
      const wrong = await admin('post', '/mfa/enrollment/confirm', {
        token,
        ip: ip(4),
      }).send({
        challengeToken: start.body.challenge.token,
        code: '000000',
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('PLATFORM_ADMIN_CODE_INVALID');
      expect(
        (await admin('get', '/overview', { token, ip: ip(4) })).status,
      ).toBe(401);
      const factor = await connection
        .db!.collection('platform_admin_mfa_factors')
        .findOne({ userId: new Types.ObjectId(userId) });
      expect(factor?.active).toBeNull();
    });

    it('enrôlement complet : codes de récupération une fois, session renouvelée, données accessibles', async () => {
      const a = await enrolledAdmin(ip(5));
      expect(a.recoveryCodes).toHaveLength(10);
      const status = await admin('get', '/auth/status', {
        token: a.token,
        ip: ip(5),
      });
      expect(status.status).toBe(200);
      expect(status.body.stage).toBe('ready');
      expect(status.body.recoveryCodesRemaining).toBe(10);
      expect(JSON.stringify(status.body)).not.toContain(a.recoveryCodes[0]);
      const overview = await admin('get', '/overview', {
        token: a.token,
        ip: ip(5),
      });
      expect(overview.status).toBe(200);
      expect(overview.headers['cache-control']).toContain('no-store');
      expect(overview.headers['x-robots-tag']).toContain('noindex');
      expect(overview.body.organizations.total).toBeGreaterThanOrEqual(1);
      expect(overview.body.subscriptions.trial).toBeGreaterThanOrEqual(1);
      // Codes conservés hachés uniquement.
      const stored = await connection
        .db!.collection('platform_admin_recovery_codes')
        .find({ userId: new Types.ObjectId(a.userId) })
        .toArray();
      expect(stored).toHaveLength(10);
      const raw = JSON.stringify(stored);
      for (const code of a.recoveryCodes) {
        expect(raw).not.toContain(code);
        expect(raw).not.toContain(code.replace(/-/g, ''));
      }
    });

    it('connexion suivante : challenge, code incorrect refusé, rejeu refusé', async () => {
      const a = await enrolledAdmin(ip(6));
      const reused = currentTotpCode(a.secret, clock());
      const login = await loginAdmin(a.email, PASSWORD, ip(6));
      expect(login.body.stage).toBe('verify');
      const token = login.body.session.token as string;
      const challengeToken = login.body.challenge.token as string;
      const wrong = await admin('post', '/mfa/verify', {
        token,
        ip: ip(6),
      }).send({
        challengeToken,
        code: reused === '123456' ? '654321' : '123456',
      });
      expect(wrong.status).toBe(401);
      // Code déjà accepté à l'enrôlement (même pas TOTP) : rejeu refusé.
      const replay = await admin('post', '/mfa/verify', {
        token,
        ip: ip(6),
      }).send({
        challengeToken,
        code: reused,
      });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('PLATFORM_ADMIN_CODE_INVALID');
      const replayAudit = await connection
        .db!.collection('platform_admin_audit')
        .findOne({
          actorUserId: new Types.ObjectId(a.userId),
          detail: 'replay',
        });
      expect(replayAudit).not.toBeNull();
      nextStep();
      const ok = await admin('post', '/mfa/verify', { token, ip: ip(6) }).send({
        challengeToken,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(ok.status).toBe(200);
      // Le jeton d'avant le second facteur ne vaut plus rien.
      expect(
        (await admin('get', '/overview', { token, ip: ip(6) })).status,
      ).toBe(401);
      expect(
        (
          await admin('get', '/overview', {
            token: ok.body.session.token,
            ip: ip(6),
          })
        ).status,
      ).toBe(200);
    });

    it('validations concurrentes du même code : un seul succès', async () => {
      const a = await enrolledAdmin(ip(7));
      const login = await loginAdmin(a.email, PASSWORD, ip(7));
      nextStep();
      const code = currentTotpCode(a.secret, clock());
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          admin('post', '/mfa/verify', {
            token: login.body.session.token,
            ip: ip(7),
          }).send({
            challengeToken: login.body.challenge.token,
            code,
          }),
        ),
      );
      expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
      expect(attempts.every((r) => [200, 401, 409].includes(r.status))).toBe(
        true,
      );
    });

    it('codes de récupération concurrents (différents) sur un challenge : un seul succès', async () => {
      const a = await enrolledAdmin(ip(8));
      const login = await loginAdmin(a.email, PASSWORD, ip(8));
      const attempts = await Promise.all(
        a.recoveryCodes.slice(0, 3).map((recoveryCode) =>
          admin('post', '/mfa/verify', {
            token: login.body.session.token,
            ip: ip(8),
          }).send({
            challengeToken: login.body.challenge.token,
            recoveryCode,
          }),
        ),
      );
      expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('code de récupération : usage unique', async () => {
      const a = await enrolledAdmin(ip(9));
      const [code] = a.recoveryCodes;
      const first = await loginAdmin(a.email, PASSWORD, ip(9));
      const used = await admin('post', '/mfa/verify', {
        token: first.body.session.token,
        ip: ip(9),
      }).send({
        challengeToken: first.body.challenge.token,
        recoveryCode: code.toLowerCase(),
      });
      expect(used.status).toBe(200);
      expect(used.body.recoveryCodesRemaining).toBe(9);
      const second = await loginAdmin(a.email, PASSWORD, ip(9));
      const again = await admin('post', '/mfa/verify', {
        token: second.body.session.token,
        ip: ip(9),
      }).send({
        challengeToken: second.body.challenge.token,
        recoveryCode: code,
      });
      expect(again.status).toBe(401);
    });

    it('challenge expiré ou d’une autre session : refusé', async () => {
      const a = await enrolledAdmin(ip(10));
      const one = await loginAdmin(a.email, PASSWORD, ip(10));
      const two = await loginAdmin(a.email, PASSWORD, ip(10));
      nextStep();
      const crossed = await admin('post', '/mfa/verify', {
        token: two.body.session.token,
        ip: ip(10),
      }).send({
        challengeToken: one.body.challenge.token,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(crossed.status).toBe(409);
      expect(crossed.body.code).toBe('PLATFORM_ADMIN_CHALLENGE_INVALID');
      clockOffsetMs += 6 * 60_000;
      const expired = await admin('post', '/mfa/verify', {
        token: two.body.session.token,
        ip: ip(10),
      }).send({
        challengeToken: two.body.challenge.token,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(expired.status).toBe(409);
      // Nouveau challenge pour la même session (avant ses 10 minutes).
      const renewed = await admin('post', '/mfa/challenge', {
        token: two.body.session.token,
        ip: ip(10),
      });
      expect(renewed.status).toBe(200);
      const ok = await admin('post', '/mfa/verify', {
        token: two.body.session.token,
        ip: ip(10),
      }).send({
        challengeToken: renewed.body.challenge.token,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(ok.status).toBe(200);
      // Session sans second facteur au-delà de 10 minutes : expirée.
      clockOffsetMs += 11 * 60_000;
      expect(
        (
          await admin('get', '/auth/status', {
            token: one.body.session.token,
            ip: ip(10),
          })
        ).status,
      ).toBe(401);
    });

    it('limites : 5 essais par challenge, puis plafond par compte (persistant)', async () => {
      const a = await enrolledAdmin(ip(11));
      const login = await loginAdmin(a.email, PASSWORD, ip(11));
      const send = (code: string) =>
        admin('post', '/mfa/verify', {
          token: login.body.session.token,
          ip: ip(11),
        }).send({
          challengeToken: login.body.challenge.token,
          code,
        });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await send('000001')).status);
      // 5 échecs autorisés par compte : le 6e essai est plafonné.
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses[5]).toBe(429);
      nextStep();
      const blocked = await send(currentTotpCode(a.secret, clock()));
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('PLATFORM_ADMIN_RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBeDefined();
      const bucket = await connection
        .db!.collection('rate_limit_buckets')
        .findOne({ scope: 'platform-admin-mfa-account' });
      expect(bucket).not.toBeNull();
      expect(JSON.stringify(bucket)).not.toContain(a.userId);
    });

    it('défi anti-robot (Turnstile) exigé après trop d’échecs sur le compte, à usage unique', async () => {
      const { userId, email } = await createUser();
      await grant(userId);
      const send = (password: string, challengeToken?: string) =>
        admin('post', '/auth/login', { ip: ip(13) }).send({
          email,
          password,
          ...(challengeToken ? { challengeToken } : {}),
        });
      for (let i = 0; i < 10; i++) {
        expect((await send('mauvais-mot-de-passe')).status).toBe(401);
      }
      const blocked = await send(PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('AUTH_CHALLENGE_REQUIRED');
      // Jeton d'une autre action (inscription) : refusé, compte toujours bloqué.
      const wrongAction = await send(
        PASSWORD,
        simulatedTurnstileToken('register'),
      );
      expect(wrongAction.status).not.toBe(200);
      expect((await send(PASSWORD)).body.code).toBe('AUTH_CHALLENGE_REQUIRED');
      const passed = await send(PASSWORD, simulatedTurnstileToken('login'));
      expect(passed.status).toBe(200);
      expect(passed.body.stage).toBe('enroll');
      // Défi réussi + bon mot de passe : fenêtre du compte refermée (1-18C).
      expect((await send(PASSWORD)).status).toBe(200);
    });

    it('plafond de connexions par origine réseau', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        statuses.push(
          (await loginAdmin(unique('nobody'), 'wrong-password', ip(12))).status,
        );
      }
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses[20]).toBe(429);
    });
  });

  describe('Sessions, révocation et récupération', () => {
    it('déconnexion : session révoquée côté serveur', async () => {
      const a = await enrolledAdmin(ip(20));
      const out = await admin('post', '/auth/logout', {
        token: a.token,
        ip: ip(20),
      });
      expect(out.status).toBe(200);
      expect(out.body.sessionCleared).toBe(true);
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(20) }))
          .status,
      ).toBe(401);
    });

    it('révocation de l’accès : effet immédiat sur une session valide', async () => {
      const a = await enrolledAdmin(ip(21));
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(21) }))
          .status,
      ).toBe(200);
      const revoked = await cli([
        'revoke',
        `--user-id=${a.userId}`,
        '--reason=Départ de l’équipe',
        '--operator=e2e',
        '--apply',
      ]);
      expect(revoked.result).toBe('revoked');
      const res = await admin('get', '/overview', {
        token: a.token,
        ip: ip(21),
      });
      expect(res.status).toBe(401);
      const login = await loginAdmin(a.email, PASSWORD, ip(21));
      expect(login.status).toBe(403);
    });

    it('révocation sans passer par la commande : la garde relit l’accès à chaque requête', async () => {
      const a = await enrolledAdmin(ip(22));
      await connection
        .db!.collection('platform_admin_grants')
        .updateOne(
          { userId: new Types.ObjectId(a.userId) },
          { $set: { status: 'revoked' } },
        );
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(22) }))
          .status,
      ).toBe(401);
    });

    it('inactivité de 30 min et échéance absolue de 8 h', async () => {
      const a = await enrolledAdmin(ip(23));
      clockOffsetMs += 31 * 60_000;
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(23) }))
          .status,
      ).toBe(401);
      const token = await signIn(a, ip(23));
      for (let i = 0; i < 17; i++) {
        clockOffsetMs += 29 * 60_000;
        if (i < 16) {
          expect(
            (await admin('get', '/auth/status', { token, ip: ip(23) })).status,
          ).toBe(200);
        }
      }
      // 17 × 29 min > 8 h : expirée malgré l'activité.
      expect(
        (await admin('get', '/auth/status', { token, ip: ip(23) })).status,
      ).toBe(401);
    });

    it('réinitialisation du mot de passe : sessions révoquées, MFA toujours exigée', async () => {
      const a = await enrolledAdmin(ip(24));
      const req = await http()
        .post('/auth/password-reset/request')
        .send({
          email: a.email,
          turnstileToken: simulatedTurnstileToken('password-reset'),
        });
      expect(req.status).toBe(202);
      const start = Date.now();
      let mail;
      while (
        !(mail = emailSender
          .sentTo(a.email)
          .find((m) => m.text.includes('/auth/reset-password?token=')))
      ) {
        if (Date.now() - start > 5_000) throw new Error('reset mail missing');
        await new Promise((r) => setTimeout(r, 20));
      }
      const resetToken = decodeURIComponent(
        /\/auth\/reset-password\?token=([^\s"&]+)/.exec(mail.text)![1],
      );
      const NEW_PASSWORD = 'platform-admin-new-pw-!2y';
      const confirm = await http()
        .post('/auth/password-reset/confirm')
        .send({ token: resetToken, password: NEW_PASSWORD });
      expect(confirm.status).toBe(200);
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(24) }))
          .status,
      ).toBe(401);
      const login = await loginAdmin(a.email, NEW_PASSWORD, ip(24));
      expect(login.status).toBe(200);
      expect(login.body.stage).toBe('verify');
      const res = await admin('get', '/overview', {
        token: login.body.session.token,
        ip: ip(24),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PLATFORM_ADMIN_MFA_REQUIRED');
    });

    it('nouveaux codes : mot de passe + second facteur récents exigés, autres sessions révoquées', async () => {
      const a = await enrolledAdmin(ip(25));
      const other = await signIn(a, ip(25));
      const noStepUp = await admin('post', '/security/recovery-codes', {
        token: a.token,
        ip: ip(25),
      }).send({
        stepUpToken: randomBytes(32).toString('base64url'),
      });
      expect(noStepUp.status).toBe(403);
      nextStep();
      const badPassword = await admin('post', '/security/step-up', {
        token: a.token,
        ip: ip(25),
      }).send({
        password: 'not-the-password',
        code: currentTotpCode(a.secret, clock()),
      });
      expect(badPassword.status).toBe(401);
      nextStep();
      const stepUp = await admin('post', '/security/step-up', {
        token: a.token,
        ip: ip(25),
      }).send({
        password: PASSWORD,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(stepUp.status).toBe(200);
      const regen = await admin('post', '/security/recovery-codes', {
        token: a.token,
        ip: ip(25),
      }).send({
        stepUpToken: stepUp.body.stepUpToken,
      });
      expect(regen.status).toBe(200);
      expect(regen.body.recoveryCodes).toHaveLength(10);
      // Jeton de vérification renforcée à usage unique.
      const reuse = await admin('post', '/security/recovery-codes', {
        token: a.token,
        ip: ip(25),
      }).send({
        stepUpToken: stepUp.body.stepUpToken,
      });
      expect(reuse.status).toBe(403);
      expect(
        (await admin('get', '/overview', { token: other, ip: ip(25) })).status,
      ).toBe(401);
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(25) }))
          .status,
      ).toBe(200);
      // Anciens codes invalides.
      const login = await loginAdmin(a.email, PASSWORD, ip(25));
      const old = await admin('post', '/mfa/verify', {
        token: login.body.session.token,
        ip: ip(25),
      }).send({
        challengeToken: login.body.challenge.token,
        recoveryCode: a.recoveryCodes[0],
      });
      expect(old.status).toBe(401);
    });

    it('changement de facteur : ancien secret inutilisable, autres sessions révoquées', async () => {
      const a = await enrolledAdmin(ip(26));
      const other = await signIn(a, ip(26));
      nextStep();
      const stepUp = await admin('post', '/security/step-up', {
        token: a.token,
        ip: ip(26),
      }).send({
        password: PASSWORD,
        recoveryCode: a.recoveryCodes[1],
      });
      expect(stepUp.status).toBe(200);
      const start = await admin('post', '/security/factor/start', {
        token: a.token,
        ip: ip(26),
      }).send({
        stepUpToken: stepUp.body.stepUpToken,
      });
      expect(start.status).toBe(200);
      const newSecret = secretFrom(start.body.manualKey);
      nextStep();
      const confirm = await admin('post', '/security/factor/confirm', {
        token: a.token,
        ip: ip(26),
      }).send({
        challengeToken: start.body.challenge.token,
        code: currentTotpCode(newSecret, clock()),
      });
      expect(confirm.status).toBe(200);
      const token = confirm.body.session.token as string;
      expect(
        (await admin('get', '/overview', { token, ip: ip(26) })).status,
      ).toBe(200);
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(26) }))
          .status,
      ).toBe(401);
      expect(
        (await admin('get', '/overview', { token: other, ip: ip(26) })).status,
      ).toBe(401);
      const login = await loginAdmin(a.email, PASSWORD, ip(26));
      nextStep();
      const oldFactor = await admin('post', '/mfa/verify', {
        token: login.body.session.token,
        ip: ip(26),
      }).send({
        challengeToken: login.body.challenge.token,
        code: currentTotpCode(a.secret, clock()),
      });
      expect(oldFactor.status).toBe(401);
    });

    it('récupération d’urgence (commande opérateur) : sessions révoquées, nouvel enrôlement obligatoire', async () => {
      const a = await enrolledAdmin(ip(27));
      const dry = await cli([
        'reset-mfa',
        `--user-id=${a.userId}`,
        '--reason=Téléphone et codes perdus',
        '--operator=e2e',
        '--identity-check=ticket-42',
      ]);
      expect(dry.result).toBe('dry-run:reset-mfa');
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(27) }))
          .status,
      ).toBe(200);
      const reset = await cli([
        'reset-mfa',
        `--user-id=${a.userId}`,
        '--reason=Téléphone et codes perdus',
        '--operator=e2e',
        '--identity-check=ticket-42',
        '--apply',
      ]);
      expect(reset.result).toBe('mfa-reset');
      expect(
        (await admin('get', '/overview', { token: a.token, ip: ip(27) }))
          .status,
      ).toBe(401);
      const login = await loginAdmin(a.email, PASSWORD, ip(27));
      expect(login.body.stage).toBe('enroll');
      expect(
        await connection
          .db!.collection('platform_admin_recovery_codes')
          .countDocuments({ userId: new Types.ObjectId(a.userId) }),
      ).toBe(0);
    });
  });

  describe('Données en lecture seule et confidentialité', () => {
    let a: Admin;
    beforeAll(async () => {
      a = await enrolledAdmin(ip(30));
    });
    const get = (path: string) =>
      admin('get', path, { token: a.token, ip: ip(30) });

    it('organisations : liste paginée, recherche et filtres bornés', async () => {
      const list = await get(
        '/organizations?q=Boutique%20Admin&subscription=trial',
      );
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        id: organizationId,
        subscription: 'trial',
        activeMembers: expect.any(Number),
      });
      expect((await get('/organizations?q=' + 'x'.repeat(61))).status).toBe(
        400,
      );
      expect((await get('/organizations?page=501')).status).toBe(400);
      expect((await get('/organizations?subscription=everything')).status).toBe(
        400,
      );
      expect((await get('/organizations?q=.*')).body.items).toHaveLength(0);
    });

    it('fiche organisation : propriétaire, membres, quotas, abonnement, fonctionnalités ; consultation auditée', async () => {
      const res = await get(`/organizations/${organizationId}`);
      expect(res.status).toBe(200);
      expect(res.body.owner.email).toContain('@platform-admin.test');
      expect(res.body.members.owner).toBe(1);
      expect(res.body.quotas.products.limit).toBeGreaterThan(0);
      expect(res.body.subscription.class).toBe('trial');
      expect(res.body.features).toEqual({
        productBatches: false,
        expiryAlerts: false,
      });
      const audit = await connection
        .db!.collection('platform_admin_audit')
        .findOne({ action: 'organization_view', targetId: organizationId });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(res.body.owner.email);
      expect(
        (await get(`/organizations/${new Types.ObjectId().toHexString()}`))
          .status,
      ).toBe(404);
      expect((await get('/organizations/not-an-id')).status).toBe(404);
    });

    it('paiements et audit : pages explicites', async () => {
      const payments = await get('/payments');
      expect(payments.status).toBe(200);
      expect(payments.body).toMatchObject({ page: 1, pageSize: 20 });
      const audit = await get('/audit?action=login_password');
      expect(audit.status).toBe(200);
      expect(audit.body.items.length).toBeGreaterThan(0);
      expect(
        audit.body.items.every(
          (i: { action: string }) => i.action === 'login_password',
        ),
      ).toBe(true);
      expect((await get('/audit?action=drop_collection')).status).toBe(400);
    });

    it('aucune route ne modifie ni ne supprime l’audit', async () => {
      for (const method of ['delete', 'put', 'patch'] as const) {
        const res = await http()
          [method]('/platform-admin/audit')
          .set('x-platform-admin-proxy', PROXY_SECRET)
          .set('x-platform-admin-session', a.token);
        expect(res.status).toBe(404);
      }
    });

    it('aucun secret dans les réponses ni dans les journaux', async () => {
      const bodies = await Promise.all(
        [
          '/overview',
          '/organizations',
          `/organizations/${organizationId}`,
          '/payments',
          '/audit?page=1',
          '/auth/status',
        ].map(async (path) => JSON.stringify((await get(path)).body)),
      );
      const audit = JSON.stringify(
        await connection
          .db!.collection('platform_admin_audit')
          .find({})
          .toArray(),
      );
      const sessions = JSON.stringify(
        await connection
          .db!.collection('platform_admin_sessions')
          .find({})
          .toArray(),
      );
      const factors = JSON.stringify(
        await connection
          .db!.collection('platform_admin_mfa_factors')
          .find({})
          .toArray(),
      );
      for (const text of [...bodies, audit]) {
        for (const forbidden of [
          '"password"',
          'tokenHash',
          'codeHash',
          '"secret"',
          'keyId',
          'logoKey',
          'providerCheckoutUrl',
          'payerPhone',
          MFA_KEY,
          PROXY_SECRET,
        ]) {
          expect(text).not.toContain(forbidden);
        }
      }
      for (const secret of issuedSecrets) {
        expect(audit).not.toContain(secret);
        expect(factors).not.toContain(secret);
        expect(bodies.join('')).not.toContain(secret);
      }
      for (const code of a.recoveryCodes)
        expect(audit + bodies.join('')).not.toContain(code);
      expect(sessions).not.toContain(a.token);
      expect(audit).not.toContain(a.token);
      // Erreurs vues par le BFF : privées, jamais en cache.
      const refused = await admin('get', '/overview', { ip: ip(30) });
      expect(refused.status).toBe(401);
      expect(refused.headers['cache-control']).toContain('no-store');
    });
  });

  describe('Commerces inchangés', () => {
    it('l’accès plateforme n’accorde rien sur les routes métier', async () => {
      const a = await enrolledAdmin(ip(40));
      await membershipModel.create({
        organizationId: new Types.ObjectId(organizationId),
        userId: new Types.ObjectId(a.userId),
        role: 'seller',
        status: 'active',
      });
      const login = await http()
        .post('/auth/login')
        .send({ email: a.email, password: PASSWORD, organizationId });
      expect(login.status).toBe(201);
      const members = await http()
        .get('/organizations/members')
        .set('Authorization', `Bearer ${login.body.access_token}`);
      expect(members.status).toBe(403);
      const context = await http()
        .get('/auth/context')
        .set('Authorization', `Bearer ${login.body.access_token}`);
      expect(context.body.role).toBe('seller');
      expect(JSON.stringify(context.body)).not.toMatch(/platform/i);
      // Le JWT du commerce ne remplace jamais la session administrative.
      expect(
        (
          await admin('get', '/overview').set(
            'Authorization',
            `Bearer ${login.body.access_token}`,
          )
        ).status,
      ).toBe(401);
    });

    it('propriétaire : connexion et contexte habituels', async () => {
      const context = await http()
        .get('/auth/context')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(context.status).toBe(200);
      expect(context.body.role).toBe('owner');
    });

    it('espace fermé (configuration absente) : routes masquées (404), commerces fonctionnels', async () => {
      const closed = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PLATFORM_ADMIN_CONFIG)
        .useValue({ enabled: false, state: 'disabled', problems: [] })
        .compile();
      const closedApp = closed.createNestApplication();
      closedApp.useGlobalFilters(new HttpExceptionFilter());
      await closedApp.init();
      try {
        const res = await request(closedApp.getHttpServer())
          .get('/platform-admin/overview')
          .set('x-platform-admin-proxy', PROXY_SECRET);
        expect(res.status).toBe(404);
        expect(res.body.code).toBeUndefined();
        const context = await request(closedApp.getHttpServer())
          .get('/auth/context')
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(context.status).toBe(200);
      } finally {
        await closedApp.close();
      }
    });
  });
});
