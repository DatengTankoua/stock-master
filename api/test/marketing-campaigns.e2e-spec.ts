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
import {
  EMAIL_SENDER,
  EmailDeliveryError,
  type OutgoingEmail,
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
import { ensureMarketingConsentIndexes } from '../src/marketing-consent/marketing-consent-indexes';
import { PLATFORM_ADMIN_CLOCK } from '../src/platform-admin/platform-admin-runtime';
import { currentTotpCode } from '../src/platform-admin/totp';
import {
  parseCliArguments,
  runPlatformAdminCli,
} from '../src/migrations/platform-admin-cli';
import {
  CAMPAIGN_SLEEP,
  PlatformCampaignDeliveryService,
} from '../src/platform-admin/platform-campaign-delivery.service';
import { PlatformMessageDeliveryService } from '../src/platform-admin/platform-message-delivery.service';
import { MESSAGE_UNCERTAIN_RETRY_WINDOW_MS } from '../src/platform-admin/platform-message-policy';
import {
  MARKETING_CLOCK,
  addressFingerprint,
} from '../src/marketing-consent/marketing-consent.service';
import { unsubscribeTokenHash } from '../src/marketing-consent/marketing-unsubscribe';
import { PushRuntime } from '../src/push/push-runtime';
import { CAMPAIGN_AUDIENCE_PAGE } from '../src/platform-admin/platform-campaign-policy';
import { ensurePlatformAdminNotificationIndexes } from '../src/platform-admin/platform-admin-notification-indexes';
import { PlatformAdminNotificationSweep } from '../src/platform-admin/platform-admin-notification-sweep.service';
import { CAMPAIGN_COMPLETION_GRACE_MS } from '../src/platform-admin/platform-admin-notifications';

/**
 * E2E — campagnes promotionnelles par e-mail et désabonnement sans
 * connexion : capacités, preuve liée au contenu et au ciblage, lancement
 * rejoué, audience dédupliquée et figée, éligibilité relue avant chaque
 * tentative, reprises identiques, fenêtre d'incertitude, interrupteur,
 * jeton de désabonnement, archivage, messages de service inchangés. Faux
 * transport : aucun e-mail réel.
 */

const sender = createE2eEmailSender();
const PASSWORD = 'marketing-campaigns-e2e-pw-!1x';
const PROXY_SECRET = randomBytes(32).toString('base64url');
const APP = 'https://app.campaigns.e2e.test';
const MANAGE = 'platform.campaigns.manage';
const SEND = 'platform.campaigns.send';

let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
const nextStep = () => {
  clockOffsetMs += 30_000;
};

interface Admin {
  userId: string;
  token: string;
  secret: Uint8Array;
}

interface Member {
  userId: string;
  email: string;
  organizationId: string;
}

describe('Campagnes promotionnelles par e-mail (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let worker: PlatformCampaignDeliveryService;
  let seq = 0;
  let ipSeq = 0;
  const calls: OutgoingEmail[] = [];

  const http = () => request(app.getHttpServer());
  const db = () => connection.db!;
  const unique = (label: string) => `${label}-${++seq}@campaigns.e2e.test`;

  const admin = (method: 'get' | 'post', path: string, token: string) =>
    http()
      [method](`/platform-admin${path}`)
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', '203.0.113.220')
      .set('x-platform-admin-session', token);

  const cli = async (argv: string[]) => {
    const args = parseCliArguments(argv);
    if (typeof args === 'string') throw new Error(args);
    return runPlatformAdminCli(connection, args, process.env, clock());
  };

  async function enrolledAdmin(capabilities: string[] = []): Promise<Admin> {
    const email = unique('admin');
    const userId = new Types.ObjectId();
    await userModel.create({
      _id: userId,
      name: 'Admin',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
    });
    const reason = '--reason=Recette des campagnes promotionnelles';
    await cli([
      'grant',
      `--user-id=${userId.toHexString()}`,
      reason,
      '--operator=e2e',
      '--apply',
    ]);
    for (const capability of capabilities) {
      await cli([
        'capability-add',
        `--user-id=${userId.toHexString()}`,
        `--capability=${capability}`,
        reason,
        '--operator=e2e',
        '--apply',
      ]);
    }
    const login = await http()
      .post('/platform-admin/auth/login')
      .set('x-platform-admin-proxy', PROXY_SECRET)
      .set('x-platform-admin-client-ip', `198.51.100.${++ipSeq}`)
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
    return {
      userId: userId.toHexString(),
      secret,
      token: confirm.body.session.token,
    };
  }

  /** Propriétaire inscrit, avec ou sans accord marketing. */
  async function owner(label: string, consent = true): Promise<Member> {
    const email = unique(label);
    const res = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Proprio',
      email,
      password: PASSWORD,
      organizationName: `Boutique ${seq}`,
      ...(consent
        ? {
            marketingEmailConsent: {
              granted: true,
              wordingVersion: '1',
              locale: 'fr',
            },
          }
        : {}),
    });
    expect(res.status).toBe(202);
    return {
      userId: res.owner!.user._id,
      email,
      organizationId: res.owner!.organization._id,
    };
  }

  async function addMembership(userId: string, organizationId: string) {
    await db()
      .collection('organizationmemberships')
      .insertOne({
        organizationId: new Types.ObjectId(organizationId),
        userId: new Types.ObjectId(userId),
        role: 'seller',
        permissions: [],
        status: 'active',
        invitedById: null,
        joinedAt: new Date(),
        createdAt: new Date(0),
      });
  }

  const draft = (targeting: object = { mode: 'all' }) => ({
    subject: 'Offre <spéciale> & "promo"',
    body: 'Bonjour,\n-20 % ce mois-ci.\n<script>alert(1)</script>',
    targeting,
  });

  async function createCampaign(a: Admin, targeting?: object) {
    const res = await admin('post', '/campaigns', a.token).send(
      draft(targeting),
    );
    expect(res.status).toBe(200);
    return res.body as {
      id: string;
      revision: number;
      subject: string;
      body: string;
      targeting: object;
    };
  }

  const launchIntent = (c: {
    id: string;
    revision: number;
    subject: string;
    body: string;
    targeting: object;
  }) => ({
    action: 'campaign_launch',
    campaignId: c.id,
    operationId: randomUUID(),
    revision: c.revision,
    subject: c.subject,
    body: c.body,
    targeting: c.targeting,
  });

  async function stepUp(a: Admin, intent: Record<string, unknown>) {
    nextStep();
    return admin('post', '/security/step-up', a.token).send({
      password: PASSWORD,
      code: currentTotpCode(a.secret, clock()),
      intent,
    });
  }

  async function launch(
    a: Admin,
    intent: ReturnType<typeof launchIntent>,
    token?: string,
  ) {
    let stepUpToken = token;
    if (!stepUpToken) {
      const up = await stepUp(a, intent);
      expect(up.status).toBe(200);
      stepUpToken = up.body.stepUpToken as string;
    }
    return admin(
      'post',
      `/campaigns/${intent.campaignId}/launch`,
      a.token,
    ).send({
      operationId: intent.operationId,
      stepUpToken,
      revision: intent.revision,
      subject: intent.subject,
      body: intent.body,
      targeting: intent.targeting,
    });
  }

  async function launched(a: Admin, targeting?: object) {
    const c = await createCampaign(a, targeting);
    const res = await launch(a, launchIntent(c));
    expect(res.status).toBe(200);
    return c.id;
  }

  const deliveriesOf = (campaignId: string) =>
    db()
      .collection('platform_campaign_deliveries')
      .find({ campaignId: new Types.ObjectId(campaignId) })
      .sort({ _id: 1 })
      .toArray();

  const callsFor = (campaignId: string) =>
    calls.filter((e) =>
      e.idempotencyKey.startsWith(`marketing-campaign/${campaignId}/`),
    );

  async function drain(passes = 4) {
    for (let i = 0; i < passes; i += 1) await worker.runOnce();
  }

  const tokenFrom = (email: OutgoingEmail) =>
    decodeURIComponent(
      /unsubscribe\?token=([A-Za-z0-9_%-]+)/.exec(email.text)![1],
    );

  const consentState = (userId: string) =>
    db()
      .collection('marketing_consents')
      .findOne({
        userId: new Types.ObjectId(userId),
      });

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
      process.env.PUBLIC_APP_URL = APP;
      process.env.PLATFORM_ADMIN_ENABLED = 'true';
      process.env.PLATFORM_ADMIN_MFA_KEYS = `e2e1:${randomBytes(32).toString('base64')}`;
      process.env.PLATFORM_ADMIN_MFA_ACTIVE_KEY = 'e2e1';
      process.env.PLATFORM_ADMIN_PROXY_SECRET = PROXY_SECRET;
      process.env.MARKETING_UNSUBSCRIBE_SECRET =
        randomBytes(32).toString('base64url');

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(sender)
        .overrideProvider(PLATFORM_ADMIN_CLOCK)
        .useValue(clock)
        // Même horloge que l'administration (en production : l'horloge
        // système pour les deux).
        .overrideProvider(MARKETING_CLOCK)
        .useValue(clock)
        .overrideProvider(CAMPAIGN_SLEEP)
        .useValue(() => Promise.resolve())
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
      autoConfirmVerificationEmails(app, sender);
      connection = app.get<Connection>(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      worker = app.get(PlatformCampaignDeliveryService);
      app.get(PushRuntime).activateCenter();
      await ensurePlatformAdminIndexes(connection);
      await ensureSubscriptionPeriodIndexes(connection);
      await ensureMarketingConsentIndexes(connection);
      // Toutes les tentatives (réussies ou non) sont consignées.
      const original = sender.send.bind(sender);
      jest.spyOn(sender, 'send').mockImplementation((email) => {
        calls.push(email);
        return original(email);
      });
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(async () => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    sender.reset();
    calls.length = 0;
    process.env.MARKETING_EMAILS_ENABLED = 'true';
    // Campagnes des tests précédents : terminées, hors des passes suivantes.
    await db()
      .collection('platform_campaign_deliveries')
      .updateMany(
        { status: { $in: ['pending', 'sending'] } },
        {
          $set: { status: 'failed', reason: 'e2e_cleanup', lockedUntil: null },
        },
      );
    await db()
      .collection('platform_campaigns')
      .updateMany(
        { 'audience.status': 'preparing' },
        { $set: { 'audience.status': 'ready' } },
      );
  });

  afterAll(async () => {
    delete process.env.MARKETING_EMAILS_ENABLED;
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('Capacités et confirmation renforcée', () => {
    it('lecture seule, gestion seule, envoi seul : chacun limité à son droit', async () => {
      const reader = await enrolledAdmin();
      const manager = await enrolledAdmin([MANAGE]);
      const senderOnly = await enrolledAdmin([SEND]);
      expect((await admin('get', '/campaigns', reader.token)).status).toBe(200);
      for (const a of [reader, senderOnly]) {
        const res = await admin('post', '/campaigns', a.token).send(draft());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PLATFORM_ADMIN_CAPABILITY_REQUIRED');
      }
      const c = await createCampaign(manager);
      // Gestion sans droit d'envoi : ni preuve, ni lancement.
      const up = await stepUp(manager, launchIntent(c));
      expect(up.status).toBe(403);
      const res = await launch(
        manager,
        launchIntent(c),
        randomBytes(32).toString('base64url'),
      );
      expect(res.status).toBe(403);
      expect(
        await db()
          .collection('platform_campaign_deliveries')
          .countDocuments({
            campaignId: new Types.ObjectId(c.id),
          }),
      ).toBe(0);
      expect(
        await db()
          .collection('platform_admin_audit')
          .countDocuments({
            action: { $in: ['campaign_create', 'campaign_launch'] },
            outcome: 'denied',
            detail: 'capability',
          }),
      ).toBeGreaterThanOrEqual(3);
    });

    it('preuve liée : contenu ou ciblage modifiés après confirmation → refus', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const c = await createCampaign(a);
      const intent = launchIntent(c);
      const up = await stepUp(a, intent);
      expect(up.status).toBe(200);
      const token = up.body.stepUpToken as string;
      // Autre contenu présenté avec la preuve : refus (preuve non liée).
      const altered = await launch(
        a,
        { ...intent, subject: 'Autre sujet' },
        token,
      );
      expect(altered.status).toBe(403);
      expect(altered.body.code).toBe('PLATFORM_ADMIN_STEP_UP_REQUIRED');
      // Brouillon modifié après la confirmation : refus, rien de lancé.
      const edited = await admin('post', `/campaigns/${c.id}`, a.token).send({
        ...draft({ mode: 'all' }),
        subject: 'Sujet modifié',
        revision: c.revision,
      });
      expect(edited.status).toBe(200);
      const stale = await launch(a, intent, token);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('PLATFORM_ADMIN_STATE_CHANGED');
      const doc = await db()
        .collection('platform_campaigns')
        .findOne({ _id: new Types.ObjectId(c.id) });
      expect(doc!.status).toBe('draft');
      // Ancienne révision refusée à la modification.
      const old = await admin('post', `/campaigns/${c.id}`, a.token).send({
        ...draft(),
        revision: c.revision,
      });
      expect(old.status).toBe(409);
    });

    it('lancement rejoué : même résultat, aucune double campagne ni livraison ; contenu figé', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('replay');
      const c = await createCampaign(a);
      const intent = launchIntent(c);
      const first = await launch(a, intent);
      expect(first.status).toBe(200);
      expect(first.body.replayed).toBe(false);
      const again = await launch(
        a,
        intent,
        randomBytes(32).toString('base64url'),
      );
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      // Autre opération sur une campagne lancée : refus.
      const other = await launch(a, { ...intent, operationId: randomUUID() });
      expect(other.status).toBe(409);
      // Contenu figé après lancement.
      const edit = await admin('post', `/campaigns/${c.id}`, a.token).send({
        ...draft(),
        revision: c.revision,
      });
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe('PLATFORM_ADMIN_CAMPAIGN_NOT_EDITABLE');
      await drain();
      const rows = (await deliveriesOf(c.id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(rows).toHaveLength(1);
      expect(callsFor(c.id).filter((e) => e.to === m.email)).toHaveLength(1);
      const audit = await db()
        .collection('platform_admin_audit')
        .find({ action: 'campaign_launch', outcome: 'success', targetId: c.id })
        .toArray();
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toMatch(/Offre|Bonjour/);
    });
  });

  describe('Audience', () => {
    it('dédupliquée, ciblée et limitée aux comptes éligibles au lancement', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const multi = await owner('multi');
      const other = await owner('other');
      await addMembership(multi.userId, other.organizationId);
      const noConsent = await owner('noconsent', false);
      const unverified = await owner('unverified');
      await userModel.updateOne(
        { _id: unverified.userId },
        { $unset: { emailVerifiedAt: 1 } },
      );
      const suspended = await owner('suspended');
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(suspended.organizationId) },
          { $set: { status: 'suspended' } },
        );
      const est = await admin(
        'get',
        `/campaigns/${(await createCampaign(a)).id}/estimate`,
        a.token,
      );
      expect(est.status).toBe(200);
      expect(typeof est.body.estimated).toBe('number');

      const all = await launched(a);
      const selected = await launched(a, {
        mode: 'selected',
        organizationIds: [other.organizationId],
      });
      // Accord donné APRÈS le lancement : jamais ajouté.
      const late = await owner('late');
      await drain(8);
      const recipients = async (id: string) =>
        (await deliveriesOf(id)).map((d) => String(d.userId));
      const inAll = await recipients(all);
      expect(inAll.filter((u) => u === multi.userId)).toHaveLength(1);
      expect(inAll).toEqual(
        expect.arrayContaining([multi.userId, other.userId]),
      );
      for (const excluded of [noConsent, unverified, suspended, late]) {
        expect(inAll).not.toContain(excluded.userId);
      }
      expect((await recipients(selected)).sort()).toEqual(
        [multi.userId, other.userId].sort(),
      );
      expect(callsFor(all).filter((e) => e.to === multi.email)).toHaveLength(1);
      for (const excluded of [noConsent, unverified, suspended, late]) {
        expect(
          [...callsFor(all), ...callsFor(selected)].some(
            (e) => e.to === excluded.email,
          ),
        ).toBe(false);
      }
    });
  });

  describe('Audience : constitution au lancement, gel, revérification', () => {
    it('commerce suspendu ou adresse non confirmée AU LANCEMENT : jamais ajoutés après', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const suspended = await owner('freeze-suspended');
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(suspended.organizationId) },
          { $set: { status: 'suspended' } },
        );
      const unverified = await owner('freeze-unverified');
      await userModel.updateOne(
        { _id: unverified.userId },
        { $unset: { emailVerifiedAt: 1 } },
      );
      const eligible = await owner('freeze-eligible');
      const id = await launched(a);
      // Audience constituée et GELÉE par la requête de lancement.
      const frozen = await db()
        .collection('platform_campaigns')
        .findOne({ _id: new Types.ObjectId(id) });
      expect(frozen!.audience.status).toBe('ready');
      expect(frozen!.audience.frozenAt).toBeInstanceOf(Date);
      expect(frozen!.audience.incomplete).toBe(false);
      // Réactivation et confirmation APRÈS le lancement.
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(suspended.organizationId) },
          { $set: { status: 'active' } },
        );
      await userModel.updateOne(
        { _id: unverified.userId },
        { $set: { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } },
      );
      await drain();
      const recipients = (await deliveriesOf(id)).map((d) => String(d.userId));
      expect(recipients).toContain(eligible.userId);
      expect(recipients).not.toContain(suspended.userId);
      expect(recipients).not.toContain(unverified.userId);
      expect(
        callsFor(id).some(
          (e) => e.to === suspended.email || e.to === unverified.email,
        ),
      ).toBe(false);
      const after = await db()
        .collection('platform_campaigns')
        .findOne({ _id: new Types.ObjectId(id) });
      expect(after!.audience.total).toBe(frozen!.audience.total);
    });

    it('réponse perdue pendant la constitution : rejeu sans seconde constitution, suivi, audience partielle', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const reader = await enrolledAdmin();
      const m = await owner('lost-response');
      const c = await createCampaign(a);
      const intent = launchIntent(c);
      // La requête de lancement s'interrompt pendant la constitution
      // (BFF sans réponse, processus arrêté) : aucune livraison créée.
      const spy = jest
        .spyOn(worker, 'constituteAudience')
        .mockRejectedValueOnce(new Error('requête interrompue'));
      const first = await launch(a, intent);
      expect(first.status).toBe(200);
      // Rejeu du MÊME identifiant (réponse perdue côté interface).
      const replayed = await launch(
        a,
        intent,
        randomBytes(32).toString('base64url'),
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body.replayed).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      // L'interface retrouve la campagne existante et son état.
      const detail = await admin('get', `/campaigns/${c.id}`, reader.token);
      expect(detail.body).toMatchObject({
        status: 'launched',
        audience: { status: 'preparing', total: 0 },
      });
      expect(detail.body.results.accepted).toBe(0);
      // Aucune évaluation tardive : le destinataire éligible n'est pas
      // ajouté par le traitement de fond.
      await drain();
      expect(await deliveriesOf(c.id)).toHaveLength(0);
      expect(callsFor(c.id)).toHaveLength(0);
      // Bail expiré : audience close, partielle, signalée comme telle.
      clockOffsetMs += 11 * 60_000;
      await drain();
      const closed = await admin('get', `/campaigns/${c.id}`, reader.token);
      expect(closed.body.audience).toMatchObject({
        status: 'ready',
        incomplete: true,
        total: 0,
      });
      // Aucun envoi présenté comme effectué.
      expect(closed.body.results).toEqual({
        pending: 0,
        sending: 0,
        accepted: 0,
        skipped: 0,
        failed: 0,
        uncertain: 0,
      });
      expect(callsFor(c.id).some((e) => e.to === m.email)).toBe(false);
      // Un nouveau rejeu ne reconstitue toujours rien.
      const late = await launch(
        a,
        intent,
        randomBytes(32).toString('base64url'),
      );
      expect(late.body.replayed).toBe(true);
      expect(await deliveriesOf(c.id)).toHaveLength(0);
    });

    it('constitution interrompue : close à l’expiration du bail, sans évaluation tardive', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const late = await owner('interrupted');
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(late.organizationId) },
          { $set: { status: 'suspended' } },
        );
      const spy = jest
        .spyOn(worker, 'constituteAudience')
        .mockRejectedValueOnce(new Error('arrêt simulé'));
      const id = await launched(a);
      spy.mockRestore();
      expect(
        (await db()
          .collection('platform_campaigns')
          .findOne({ _id: new Types.ObjectId(id) }))!.audience.status,
      ).toBe('preparing');
      // Devenu éligible après le lancement : ne doit jamais être ajouté.
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(late.organizationId) },
          { $set: { status: 'active' } },
        );
      await drain();
      expect(await deliveriesOf(id)).toHaveLength(0);
      clockOffsetMs += 11 * 60_000;
      await drain();
      const closed = await db()
        .collection('platform_campaigns')
        .findOne({ _id: new Types.ObjectId(id) });
      expect(closed!.audience).toMatchObject({
        status: 'ready',
        incomplete: true,
        total: 0,
      });
      expect(await deliveriesOf(id)).toHaveLength(0);
      expect(callsFor(id)).toHaveLength(0);
    });
  });

  describe('Audience : course entre constitution et clôture', () => {
    type Commit = (...args: unknown[]) => Promise<boolean>;
    const commitHost = () => worker as unknown as { commitPage: Commit };

    /** Lancement réel, constitution différée (appelée ensuite par le test). */
    async function launchedIdle(a: Admin, targeting?: object) {
      const spy = jest
        .spyOn(worker, 'constituteAudience')
        .mockResolvedValueOnce(undefined);
      const id = await launched(a, targeting);
      spy.mockRestore();
      return new Types.ObjectId(id);
    }

    /**
     * Point de synchronisation juste avant la transaction de page : les
     * appels d'index ≥ `holdFrom` attendent `release()`.
     */
    function gateCommits(holdFrom = 0) {
      const host = commitHost();
      const original = host.commitPage.bind(worker) as Commit;
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      let calls = 0;
      const results: boolean[] = [];
      const spy = jest
        .spyOn(host, 'commitPage')
        .mockImplementation(async (...args: unknown[]) => {
          const index = calls++;
          if (index >= holdFrom) await gate;
          const ok = await original(...args);
          results.push(ok);
          return ok;
        });
      const handle = {
        results,
        reached: async (n: number) => {
          for (let i = 0; i < 1000 && calls < n; i += 1) {
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(calls).toBeGreaterThanOrEqual(n);
        },
        release: () => open(),
        restore: () => spy.mockRestore(),
      };
      gates.push(handle);
      return handle;
    }

    const campaignDoc = (id: Types.ObjectId) =>
      db().collection('platform_campaigns').findOne({ _id: id });

    const countDeliveries = (id: Types.ObjectId) =>
      db()
        .collection('platform_campaign_deliveries')
        .countDocuments({ campaignId: id });

    /** Comptes éligibles fictifs, membres de `organizationId`. */
    async function bulkEligible(organizationId: string, n: number) {
      const at = new Date(0);
      const users = Array.from({ length: n }, (_, i) => {
        const _id = new Types.ObjectId();
        return { _id, email: `bulk-${i}-${_id.toHexString()}@campaigns.test` };
      });
      await db()
        .collection('users')
        .insertMany(
          users.map((u) => ({
            _id: u._id,
            name: 'Membre',
            email: u.email,
            password: 'x',
            emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          })),
        );
      await db()
        .collection('marketing_consents')
        .insertMany(
          users.map((u) => ({
            _id: `email.marketing/${u._id.toHexString()}` as never,
            userId: u._id,
            channel: 'email',
            purpose: 'marketing',
            granted: true,
            addressSha256: addressFingerprint(u.email),
            wordingVersion: '1',
            changedAt: at,
          })),
        );
      await db()
        .collection('organizationmemberships')
        .insertMany(
          users.map((u) => ({
            organizationId: new Types.ObjectId(organizationId),
            userId: u._id,
            role: 'seller',
            permissions: [],
            status: 'active',
            invitedById: null,
            joinedAt: at,
            createdAt: at,
          })),
        );
      // Retrait des fixtures (les tests suivants ciblent tous les commerces).
      return async () => {
        const ids = users.map((u) => u._id);
        await db()
          .collection('marketing_consents')
          .deleteMany({ userId: { $in: ids } });
        await db()
          .collection('organizationmemberships')
          .deleteMany({ userId: { $in: ids } });
      };
    }

    // Seulement les espions de ce bloc (l'expéditeur espionné en
    // `beforeAll` doit le rester).
    const gates: Array<{ restore: () => void }> = [];
    afterEach(() => {
      for (const g of gates.splice(0)) g.restore();
    });

    it('constitution suspendue avant l’écriture, puis clôture : aucune insertion tardive ; rejeux sans effet', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('race-close');
      const id = await launchedIdle(a, {
        mode: 'selected',
        organizationIds: [m.organizationId],
      });
      const gate = gateCommits(0);
      const run = worker.constituteAudience(id);
      await gate.reached(1);
      // Bail expiré pendant que la page attend : clôture du traitement de fond.
      clockOffsetMs += 11 * 60_000;
      expect(await worker.closeExpiredConstitutions()).toBe(1);
      gate.release();
      await run;
      expect(gate.results).toEqual([false]);
      expect(await countDeliveries(id)).toBe(0);
      expect((await campaignDoc(id))!.audience).toMatchObject({
        status: 'ready',
        incomplete: true,
        total: 0,
        cursor: null,
      });
      gate.restore();
      // Rejeux : constitution et clôture ne rouvrent ni n'ajoutent rien.
      await worker.constituteAudience(id);
      expect(await worker.closeExpiredConstitutions()).toBe(0);
      expect(await countDeliveries(id)).toBe(0);
      expect((await campaignDoc(id))!.audience.status).toBe('ready');
      await drain();
      expect(callsFor(id.toHexString())).toHaveLength(0);
    });

    it('page validée avant la clôture : conservée et comptée ; page suivante abandonnée', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('race-page', false);
      // Plus d'une page d'accords : la première est validée, la seconde
      // attend au point de synchronisation.
      const cleanup = await bulkEligible(
        m.organizationId,
        CAMPAIGN_AUDIENCE_PAGE + 10,
      );
      const id = await launchedIdle(a, {
        mode: 'selected',
        organizationIds: [m.organizationId],
      });
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const gate = gateCommits(1);
      const run = worker.constituteAudience(id);
      await gate.reached(2);
      const afterFirst = await campaignDoc(id);
      const kept = await countDeliveries(id);
      expect(kept).toBeGreaterThan(0);
      expect(afterFirst!.audience.status).toBe('preparing');
      expect(afterFirst!.audience.total).toBe(kept);
      clockOffsetMs += 11 * 60_000;
      expect(await worker.closeExpiredConstitutions()).toBe(1);
      gate.release();
      await run;
      expect(gate.results).toEqual([true, false]);
      const closed = await campaignDoc(id);
      expect(closed!.audience).toMatchObject({
        status: 'ready',
        incomplete: true,
        total: kept,
        cursor: afterFirst!.audience.cursor,
      });
      expect(await countDeliveries(id)).toBe(kept);
      // Rejeu : aucun doublon, aucune réouverture.
      await worker.constituteAudience(id);
      expect(await worker.closeExpiredConstitutions()).toBe(0);
      const rows = await db()
        .collection('platform_campaign_deliveries')
        .find({ campaignId: id })
        .toArray();
      expect(rows).toHaveLength(kept);
      expect(new Set(rows.map((r) => String(r.userId))).size).toBe(kept);
      // Prise en compte par le suivi de la campagne.
      const reader = await enrolledAdmin();
      const detail = await admin(
        'get',
        `/campaigns/${id.toHexString()}`,
        reader.token,
      );
      expect(detail.body.results.pending).toBe(kept);
      expect(detail.body.audience.total).toBe(kept);
      await cleanup();
    });

    it('clôture et page simultanées : jamais l’une sans l’autre (total = livraisons)', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('race-concurrent');
      const close = worker as unknown as {
        closeAudience: (
          id: Types.ObjectId,
          incomplete: boolean,
        ) => Promise<void>;
      };
      for (let round = 0; round < 4; round += 1) {
        const id = await launchedIdle(a, {
          mode: 'selected',
          organizationIds: [m.organizationId],
        });
        await Promise.all([
          worker.constituteAudience(id),
          close.closeAudience(id, true),
        ]);
        const doc = await campaignDoc(id);
        expect(doc!.audience.status).toBe('ready');
        expect(await countDeliveries(id)).toBe(doc!.audience.total);
        // Page gagnante : audience complète (1) ; clôture gagnante : vide.
        expect(doc!.audience.total).toBe(doc!.audience.incomplete ? 0 : 1);
      }
    });

    it('notification de fin : une constitution encore en cours ne peut plus rien ajouter', async () => {
      await ensurePlatformAdminNotificationIndexes(connection);
      const sweep = app.get(PlatformAdminNotificationSweep);
      await sweep.runOnce(); // point d'activation avant le lancement
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('race-notify');
      const id = await launchedIdle(a, {
        mode: 'selected',
        organizationIds: [m.organizationId],
      });
      const gate = gateCommits(0);
      const run = worker.constituteAudience(id);
      await gate.reached(1);
      clockOffsetMs += 11 * 60_000;
      await worker.closeExpiredConstitutions();
      clockOffsetMs += CAMPAIGN_COMPLETION_GRACE_MS + 60_000;
      await sweep.runOnce();
      const key = `campaign_completed:${id.toHexString()}`;
      const notifications = () =>
        db()
          .collection('platform_admin_notifications')
          .find({ eventKey: key })
          .toArray();
      expect(await notifications()).toHaveLength(1);
      // Le travail suspendu reprend APRÈS la notification de fin.
      gate.release();
      await run;
      expect(gate.results).toEqual([false]);
      expect(await countDeliveries(id)).toBe(0);
      await sweep.runOnce();
      const [done] = await notifications();
      expect(done.params.results).toEqual({
        accepted: 0,
        skipped: 0,
        failed: 0,
        uncertain: 0,
      });
      expect(await notifications()).toHaveLength(1);
    });
  });

  describe('Livraison', () => {
    it('e-mail : contenu échappé, lien visible, en-têtes RFC 8058, clé liée à l’adresse ; jeton haché seulement', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('content');
      const id = await launched(a);
      await drain();
      const [mail] = callsFor(id).filter((e) => e.to === m.email);
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('accepted');
      expect(mail.subject).toBe('Offre <spéciale> & "promo"');
      expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(mail.html).not.toContain('<script>');
      expect(mail.text).toContain(`${APP}/auth/unsubscribe?token=`);
      const token = tokenFrom(mail);
      expect(mail.headers).toEqual({
        'List-Unsubscribe': `<${APP}/api/unsubscribe?token=${token}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
      expect(mail.idempotencyKey).toBe(
        `marketing-campaign/${id}/${String(row._id)}/${addressFingerprint(m.email).slice(0, 32)}`,
      );
      const stored = await db()
        .collection('marketing_unsubscribe_tokens')
        .findOne({ _id: unsubscribeTokenHash(token) as never });
      expect(stored).toMatchObject({
        addressSha256: addressFingerprint(m.email),
      });
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('retrait entre préparation et traitement : aucun appel', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('withdraw');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id = await launched(a);
      await drain();
      expect(
        (await deliveriesOf(id)).some((d) => String(d.userId) === m.userId),
      ).toBe(true);
      await db()
        .collection('marketing_consents')
        .updateOne(
          { userId: new Types.ObjectId(m.userId) },
          { $set: { granted: false } },
        );
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      await drain();
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('skipped');
      expect(row.reason).toBe('no_consent');
      expect(callsFor(id).some((e) => e.to === m.email)).toBe(false);
    });

    it('reprises : même clé, même destinataire, même contenu ; incertitude conservée après un refus', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('retry');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id = await launched(a);
      await drain();
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      const mine = () => callsFor(id).filter((e) => e.to === m.email);
      sender.failure = new EmailDeliveryError('timeout');
      await drain(1);
      clockOffsetMs += 2 * 60_000;
      await drain(1);
      sender.failure = null;
      clockOffsetMs += 10 * 60_000;
      await drain(1);
      const attempts = mine();
      expect(attempts.length).toBe(3);
      for (const e of attempts) expect(e).toEqual(attempts[0]);
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('accepted');
      expect(row.uncertainAt).toBeInstanceOf(Date);

      // Autre livraison : délai dépassé puis refus définitif → reste incertaine.
      const m2 = await owner('retry-refused');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id2 = await launched(a);
      await drain();
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      sender.failure = new EmailDeliveryError('timeout');
      await drain(1);
      sender.failure = new EmailDeliveryError('rejected', 422);
      clockOffsetMs += 2 * 60_000;
      await drain(1);
      const [row2] = (await deliveriesOf(id2)).filter(
        (d) => String(d.userId) === m2.userId,
      );
      expect(row2.status).toBe('uncertain');
      expect(row2.reason).toBe('rejected_422');
    });

    it('fenêtre expirée : aucun nouvel appel, résultat incertain conservé', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('window');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id = await launched(a);
      await drain();
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      sender.failure = new EmailDeliveryError('timeout');
      await drain(1);
      sender.failure = null;
      const before = callsFor(id).length;
      clockOffsetMs += MESSAGE_UNCERTAIN_RETRY_WINDOW_MS + 60_000;
      await drain(1);
      expect(callsFor(id).length).toBe(before);
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('uncertain');
      expect(row.reason).toBe('retry_window_expired');
      // Le traitement des messages de service reste disponible.
      expect(app.get(PlatformMessageDeliveryService)).toBeDefined();
    });

    it('changement d’adresse : jamais d’envoi à la nouvelle adresse sous l’ancienne livraison', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('move');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id = await launched(a);
      await drain();
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      sender.failure = new EmailDeliveryError('timeout');
      await drain(1);
      sender.failure = null;
      // Nouvelle adresse, confirmée, avec un NOUVEL accord explicite.
      const moved = unique('moved');
      await userModel.updateOne({ _id: m.userId }, { $set: { email: moved } });
      await db()
        .collection('marketing_consents')
        .updateOne(
          { userId: new Types.ObjectId(m.userId) },
          { $set: { addressSha256: addressFingerprint(moved), granted: true } },
        );
      clockOffsetMs += 2 * 60_000;
      await drain(1);
      expect(callsFor(id).some((e) => e.to === moved)).toBe(false);
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('uncertain');
      expect(row.reason).toBe('address_changed');
      expect(row.snapshot.to).toBe(m.email);
    });

    it('interrupteur désactivé : aucun appel, désabonnement toujours possible', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('switch');
      // Premier envoi pour obtenir un jeton réel.
      const first = await launched(a);
      await drain();
      const token = tokenFrom(callsFor(first).find((e) => e.to === m.email)!);
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      calls.length = 0;
      const id = await launched(a);
      await drain();
      expect(callsFor(id)).toHaveLength(0);
      expect(
        (await deliveriesOf(id)).every((d) => d.status === 'pending'),
      ).toBe(true);
      const res = await http().post('/marketing/unsubscribe').send({ token });
      expect(res.status).toBe(200);
      expect((await consentState(m.userId))!.granted).toBe(false);
    });

    it('archivage : livraisons poursuivies, liste filtrée, rien supprimé', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const reader = await enrolledAdmin();
      const m = await owner('archive');
      process.env.MARKETING_EMAILS_ENABLED = 'false';
      const id = await launched(a);
      await drain();
      expect(
        (await admin('post', `/campaigns/${id}/archive`, reader.token)).status,
      ).toBe(403);
      const res = await admin('post', `/campaigns/${id}/archive`, a.token);
      expect(res.body).toEqual({ archived: true, changed: true });
      expect(
        (await admin('post', `/campaigns/${id}/archive`, a.token)).body.changed,
      ).toBe(false);
      process.env.MARKETING_EMAILS_ENABLED = 'true';
      await drain();
      const [row] = (await deliveriesOf(id)).filter(
        (d) => String(d.userId) === m.userId,
      );
      expect(row.status).toBe('accepted');
      const active = await admin('get', '/campaigns', a.token);
      expect(active.body.items.some((c: { id: string }) => c.id === id)).toBe(
        false,
      );
      const archived = await admin(
        'get',
        '/campaigns?archived=archived',
        a.token,
      );
      expect(archived.body.items.some((c: { id: string }) => c.id === id)).toBe(
        true,
      );
      const results = await admin(
        'get',
        `/campaigns/${id}/results`,
        reader.token,
      );
      expect(results.status).toBe(200);
      expect(JSON.stringify(results.body)).not.toContain(m.email);
      expect(
        (await admin('post', `/campaigns/${id}/restore`, a.token)).body.changed,
      ).toBe(true);
    });
  });

  describe('Désabonnement sans connexion', () => {
    it('lien déjà émis : valide après rotation du secret et envois coupés (empreinte enregistrée)', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('rotation');
      const id = await launched(a);
      await drain();
      const token = tokenFrom(callsFor(id).find((e) => e.to === m.email)!);
      const previous = process.env.MARKETING_UNSUBSCRIBE_SECRET;
      try {
        // Retour à une configuration « envois coupés », secret changé.
        process.env.MARKETING_EMAILS_ENABLED = 'false';
        process.env.MARKETING_UNSUBSCRIBE_SECRET =
          randomBytes(32).toString('base64url');
        // Seul le haché enregistré permet la validation.
        expect(
          await db()
            .collection('marketing_unsubscribe_tokens')
            .countDocuments({ _id: unsubscribeTokenHash(token) as never }),
        ).toBe(1);
        const res = await http().post('/marketing/unsubscribe').send({ token });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'unsubscribed' });
        expect((await consentState(m.userId))!.granted).toBe(false);
        const [event] = await db()
          .collection('marketing_consent_events')
          .find({ userId: new Types.ObjectId(m.userId), action: 'withdrawn' })
          .toArray();
        expect(event.source).toBe('unsubscribe_link');
        // Aussi sans aucun secret configuré.
        delete process.env.MARKETING_UNSUBSCRIBE_SECRET;
        const again = await http()
          .post('/marketing/unsubscribe')
          .send({ token });
        expect(again.status).toBe(200);
      } finally {
        process.env.MARKETING_UNSUBSCRIBE_SECRET = previous;
      }
    });
    it('GET sans effet ; POST valide : retrait, preuve, rejeu idempotent ; jeton invalide refusé', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('unsub');
      const id = await launched(a);
      await drain();
      const token = tokenFrom(callsFor(id).find((e) => e.to === m.email)!);
      expect(
        (await http().get(`/marketing/unsubscribe?token=${token}`)).status,
      ).toBe(404);
      expect((await consentState(m.userId))!.granted).toBe(true);
      for (const bad of ['x'.repeat(43), 'court', '']) {
        const res = await http()
          .post('/marketing/unsubscribe')
          .send({ token: bad });
        expect([400, 404]).toContain(res.status);
      }
      const res = await http().post('/marketing/unsubscribe').send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'unsubscribed' });
      expect(res.headers['cache-control']).toBe('no-store');
      const replay = await http()
        .post('/marketing/unsubscribe')
        .send({ token });
      expect(replay.body).toEqual({ status: 'unsubscribed' });
      const events = await db()
        .collection('marketing_consent_events')
        .find({ userId: new Types.ObjectId(m.userId), action: 'withdrawn' })
        .toArray();
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('unsubscribe_link');
      expect(events[0].addressSha256).toBe(addressFingerprint(m.email));
      // Ne touche ni à la connexion ni aux autres données du compte.
      const login = await http().post('/auth/login').send({
        email: m.email,
        password: PASSWORD,
        organizationId: m.organizationId,
      });
      expect(login.status).toBe(201);
      // Retrait effectif : plus aucun envoi pour une nouvelle campagne.
      calls.length = 0;
      const next = await launched(a);
      await drain();
      expect(callsFor(next).some((e) => e.to === m.email)).toBe(false);
    });

    it('ancien lien : n’agit pas sur l’accord donné pour une nouvelle adresse', async () => {
      const a = await enrolledAdmin([MANAGE, SEND]);
      const m = await owner('oldlink');
      const id = await launched(a);
      await drain();
      const token = tokenFrom(callsFor(id).find((e) => e.to === m.email)!);
      const moved = unique('oldlink-new');
      await userModel.updateOne({ _id: m.userId }, { $set: { email: moved } });
      await db()
        .collection('marketing_consents')
        .updateOne(
          { userId: new Types.ObjectId(m.userId) },
          { $set: { addressSha256: addressFingerprint(moved) } },
        );
      const res = await http().post('/marketing/unsubscribe').send({ token });
      expect(res.status).toBe(200);
      expect((await consentState(m.userId))!.granted).toBe(true);
    });
  });
});
