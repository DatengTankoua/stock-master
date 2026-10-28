import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { SUBSCRIPTION_CLOCK } from '../src/subscriptions/subscription-clock';
import {
  MARKETING_CLOCK,
  MarketingConsentService,
  addressFingerprint,
} from '../src/marketing-consent/marketing-consent.service';
import { MARKETING_EMAIL_WORDINGS } from '../src/marketing-consent/marketing-consent-wording';
import { ensureMarketingConsentIndexes } from '../src/marketing-consent/marketing-consent-indexes';
import { ensureLegalAcceptanceIndexes } from '../src/legal/legal-acceptance-indexes';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  OWNER_TERMS,
  legalAcceptanceFor,
} from './e2e/legal-acceptance-fixtures';
import { createInvitedAccount } from './e2e/invitation-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import { LegalAcceptanceContext } from '../src/legal/legal-documents';

/**
 * E2E — accord individuel aux e-mails promotionnels : inscription avec ou
 * sans accord, valeurs refusées, comptes existants et invitations sans
 * accord implicite, réglages personnels (accord, retrait, rejeu,
 * concurrence), preuve versionnée, changement d'adresse, indépendance des
 * conditions et des préférences de notification. Aucun envoi marketing
 * n'existe : seule l'éligibilité est lue. Base éphémère.
 */

const PASSWORD = 'marketing-consent-e2e-pw-!1x';
const sender = createE2eEmailSender();
const CONSENT = '/auth/me/marketing-consent';
const FR_TEXT = MARKETING_EMAIL_WORDINGS['1'].texts.fr.text;

describe('Accord aux e-mails promotionnels (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let consent: MarketingConsentService;
  let now = new Date('2031-03-04T05:06:07.000Z');
  let subscriptionOffsetMs = 0;
  let seq = 0;

  const http = () => request(app.getHttpServer());
  const db = () => connection.db!;
  const address = (label: string) => `${label}-${++seq}@marketing.e2e.test`;
  const grant = (granted: boolean, extra: object = {}) => ({
    granted,
    wordingVersion: '1',
    locale: 'fr',
    ...extra,
  });
  const states = () => db().collection('marketing_consents');
  const events = () => db().collection('marketing_consent_events');
  const eventsOf = (userId: string) =>
    events()
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ at: 1, _id: 1 })
      .toArray();

  async function register(label: string, extra: object = {}) {
    const email = address(label);
    const res = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Marketing',
      email,
      password: PASSWORD,
      organizationName: 'Boutique Marketing',
      ...extra,
    });
    return { res, email };
  }

  async function owner(label: string, extra: object = {}) {
    const { res, email } = await register(label, extra);
    expect(res.status).toBe(202);
    const userId = res.owner!.user._id;
    const organizationId = res.owner!.organization._id;
    const login = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
    expect(login.status).toBe(201);
    return {
      userId,
      email,
      organizationId,
      token: login.body.access_token as string,
    };
  }

  const put = (token: string, body: object) =>
    http().put(CONSENT).set('Authorization', `Bearer ${token}`).send(body);
  const view = (token: string) =>
    http().get(CONSENT).set('Authorization', `Bearer ${token}`);

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
      process.env.PUBLIC_APP_URL = 'https://app.marketing.e2e.test';
      process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(sender)
        .overrideProvider(MARKETING_CLOCK)
        .useValue(() => now)
        .overrideProvider(SUBSCRIPTION_CLOCK)
        .useValue(() => new Date(Date.now() + subscriptionOffsetMs))
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
      consent = app.get(MarketingConsentService);
      await ensureLegalAcceptanceIndexes(connection);
      await ensureMarketingConsentIndexes(connection);
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
    now = new Date(now.getTime() + 60_000);
  });

  afterAll(async () => {
    delete process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED;
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('Inscription', () => {
    it('sans champ ou case décochée : compte créé, aucun accord ni preuve', async () => {
      for (const extra of [{}, { marketingEmailConsent: grant(false) }]) {
        const o = await owner('none', extra);
        expect(
          await states().countDocuments({
            userId: new Types.ObjectId(o.userId),
          }),
        ).toBe(0);
        expect(await eventsOf(o.userId)).toEqual([]);
        const v = await view(o.token);
        expect(v.status).toBe(200);
        expect(v.body).toMatchObject({
          granted: false,
          grantedForPreviousAddress: false,
          changedAt: null,
          wordingVersion: '1',
        });
        expect(await consent.emailEligibility(o.userId)).toEqual({
          eligible: false,
          reasons: ['no_consent'],
        });
      }
    });

    it('case cochée : accord et preuve minimale versionnée, libellé archivé', async () => {
      const o = await owner('yes', {
        marketingEmailConsent: grant(true, { locale: 'en' }),
      });
      const [event] = await eventsOf(o.userId);
      const { _id, ...proof } = event;
      expect(_id).toBeInstanceOf(Types.ObjectId);
      // Uniquement ces champs : ni adresse IP, ni agent utilisateur.
      expect(proof).toEqual({
        userId: new Types.ObjectId(o.userId),
        channel: 'email',
        purpose: 'promotions',
        action: 'granted',
        at: now,
        source: 'registration',
        wordingVersion: '1',
        locale: 'en',
        wordingId: 'email.promotions@1/en',
        addressSha256: addressFingerprint(o.email),
      });
      const wording = await db()
        .collection('marketing_consent_wordings')
        .findOne({ _id: 'email.promotions@1/en' as never });
      expect(wording).toMatchObject({
        version: '1',
        locale: 'en',
        text: MARKETING_EMAIL_WORDINGS['1'].texts.en.text,
        sha256: MARKETING_EMAIL_WORDINGS['1'].texts.en.sha256,
      });
      expect((await view(o.token)).body).toMatchObject({
        granted: true,
        emailVerified: true,
      });
      expect(await consent.emailEligibility(o.userId)).toEqual({
        eligible: true,
        reasons: [],
      });
    });

    it('valeur invalide ou libellé périmé : refus avant toute écriture', async () => {
      const usersBefore = await userModel.countDocuments();
      for (const [value, status] of [
        [{ granted: 'true', wordingVersion: '1', locale: 'fr' }, 400],
        [{ granted: 1, wordingVersion: '1', locale: 'fr' }, 400],
        [{ granted: null, wordingVersion: '1', locale: 'fr' }, 400],
        [{ granted: true, wordingVersion: 'v1', locale: 'fr' }, 400],
        [{ granted: true, wordingVersion: '1', locale: 'de' }, 400],
        [grant(true, { userId: new Types.ObjectId().toHexString() }), 400],
        [grant(true, { at: '2020-01-01' }), 400],
        ['oui', 400],
        [grant(true, { wordingVersion: '0' }), 409],
      ] as const) {
        const { res } = await register('bad', { marketingEmailConsent: value });
        expect(res.status).toBe(status);
        if (status === 409) {
          expect(res.body.code).toBe('MARKETING_CONSENT_WORDING_OUTDATED');
        }
      }
      expect(await userModel.countDocuments()).toBe(usersBefore);
    });

    it('adresse déjà inscrite : réponse neutre, aucun accord pour le compte existant', async () => {
      const o = await owner('exists');
      const { res } = await register('ignored', {
        email: o.email,
        marketingEmailConsent: grant(true),
      });
      expect(res.status).toBe(202);
      expect(await eventsOf(o.userId)).toEqual([]);
    });

    it('invitation : aucun accord ; le champ n’est pas accepté à la création du compte', async () => {
      const o = await owner('inviter');
      const invited = address('invited');
      const issued = await http()
        .post('/organizations/invitations')
        .set('Authorization', `Bearer ${o.token}`)
        .send({ email: invited, role: 'seller' });
      expect(issued.status).toBe(201);
      const invitationToken = new URL(
        issued.body.invitationUrl as string,
      ).searchParams.get('token')!;
      const withField = await http()
        .post('/auth/invitations/create-account')
        .send({
          legalAcceptance: legalAcceptanceFor(
            LegalAcceptanceContext.INVITATION_ACCOUNT,
          ),
          token: 'x'.repeat(43),
          name: 'Invité',
          password: PASSWORD,
          marketingEmailConsent: grant(true),
        });
      expect(withField.status).toBe(400);
      const created = await createInvitedAccount(
        app.getHttpServer(),
        sender,
        invitationToken,
        invited,
        { name: 'Invité', password: PASSWORD },
      );
      expect(created.status).toBe(200);
      const user = await userModel.findOne({ email: invited }).lean();
      expect(await eventsOf(String(user!._id))).toEqual([]);
      expect(
        (await consent.emailEligibility(String(user!._id))).reasons,
      ).toEqual(['no_consent']);
    });
  });

  describe('Comptes existants et réglages personnels', () => {
    it('compte antérieur (aucun champ) : aucun accord implicite', async () => {
      const user = await userModel.create({
        name: 'Ancien',
        email: address('legacy'),
        password: await bcrypt.hash(PASSWORD, 10),
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      });
      expect(await consent.emailEligibility(String(user._id))).toEqual({
        eligible: false,
        reasons: ['no_consent', 'no_active_membership'],
      });
    });

    it('accord, rejeu, retrait immédiat et rejeu : une preuve par changement', async () => {
      const o = await owner('settings');
      const first = await put(o.token, grant(true));
      expect(first.status).toBe(200);
      expect(first.body.granted).toBe(true);
      expect((await consent.emailEligibility(o.userId)).eligible).toBe(true);
      expect((await put(o.token, grant(true))).status).toBe(200);
      expect(await eventsOf(o.userId)).toHaveLength(1);

      const withdrawn = await put(o.token, grant(false));
      expect(withdrawn.body).toMatchObject({ granted: false });
      // Retrait effectif immédiatement, sans cache.
      expect(await consent.emailEligibility(o.userId)).toEqual({
        eligible: false,
        reasons: ['no_consent'],
      });
      await put(o.token, grant(false));
      const proofs = await eventsOf(o.userId);
      expect(proofs.map((e) => [e.action, e.source])).toEqual([
        ['granted', 'settings'],
        ['withdrawn', 'settings'],
      ]);
      const state = await states().findOne({
        userId: new Types.ObjectId(o.userId),
      });
      expect(state).toMatchObject({
        granted: false,
        lastEventId: proofs[1]._id,
        source: 'settings',
      });
    });

    it('requêtes concurrentes identiques : une seule preuve', async () => {
      const o = await owner('race');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => put(o.token, grant(true))),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(await eventsOf(o.userId)).toHaveLength(1);
    });

    it('strictement personnel : aucun autre utilisateur ne peut être désigné', async () => {
      const o = await owner('self');
      const other = await owner('other');
      for (const field of [
        { userId: other.userId },
        { email: other.email },
        { organizationId: o.organizationId },
        { source: 'registration' },
      ]) {
        expect((await put(o.token, grant(true, field))).status).toBe(400);
      }
      expect((await http().put(CONSENT).send(grant(true))).status).toBe(401);
      expect((await http().get(CONSENT)).status).toBe(401);
      // Ni l'organisation ni l'administration n'exposent de route d'écriture.
      for (const path of [
        `/organizations/members/${other.userId}/marketing-consent`,
        `/platform-admin/users/${other.userId}/marketing-consent`,
      ]) {
        const res = await http()
          .put(path)
          .set('Authorization', `Bearer ${o.token}`)
          .send(grant(true));
        expect(res.status).toBe(404);
      }
      expect(await eventsOf(other.userId)).toEqual([]);
      expect(await eventsOf(o.userId)).toEqual([]);
    });

    it('accord avec un libellé périmé refusé ; retrait toujours possible', async () => {
      const o = await owner('outdated', { marketingEmailConsent: grant(true) });
      const stale = await put(o.token, grant(true, { wordingVersion: '7' }));
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('MARKETING_CONSENT_WORDING_OUTDATED');
      const unknown = await put(o.token, grant(false, { wordingVersion: '7' }));
      expect(unknown.status).toBe(400);
      expect(
        (await put(o.token, grant(false, { locale: 'en' }))).body.granted,
      ).toBe(false);
    });

    it('changement d’adresse : l’ancien accord ne vaut pas pour la nouvelle adresse', async () => {
      const o = await owner('move', { marketingEmailConsent: grant(true) });
      const moved = address('moved');
      // Aucun parcours de changement d'adresse n'existe : changement simulé
      // en base, adresse reconfirmée.
      await userModel.updateOne(
        { _id: o.userId },
        { $set: { email: moved, emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } },
      );
      expect(await consent.emailEligibility(o.userId)).toEqual({
        eligible: false,
        reasons: ['address_changed'],
      });
      expect((await view(o.token)).body).toMatchObject({
        granted: false,
        grantedForPreviousAddress: true,
      });
      // Nouvel accord explicite pour la nouvelle adresse.
      expect((await put(o.token, grant(true))).body.granted).toBe(true);
      const proofs = await eventsOf(o.userId);
      expect(proofs.map((e) => e.addressSha256)).toEqual([
        addressFingerprint(o.email),
        addressFingerprint(moved),
      ]);
      expect((await consent.emailEligibility(o.userId)).eligible).toBe(true);
    });

    it('éligibilité : adresse non vérifiée et commerce suspendu exclus', async () => {
      const o = await owner('elig', { marketingEmailConsent: grant(true) });
      await userModel.updateOne(
        { _id: o.userId },
        { $unset: { emailVerifiedAt: 1 } },
      );
      expect((await consent.emailEligibility(o.userId)).reasons).toEqual([
        'email_unverified',
      ]);
      await userModel.updateOne(
        { _id: o.userId },
        { $set: { emailVerifiedAt: E2E_EMAIL_VERIFIED_AT } },
      );
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(o.organizationId) },
          { $set: { status: 'suspended' } },
        );
      expect((await consent.emailEligibility(o.userId)).reasons).toEqual([
        'no_active_membership',
      ]);
    });
  });

  describe('Indépendance', () => {
    it('réacceptation des conditions sans effet sur l’accord marketing', async () => {
      const without = await owner('terms-no');
      const withConsent = await owner('terms-yes', {
        marketingEmailConsent: grant(true),
      });
      for (const o of [without, withConsent]) {
        // Preuves d'acceptation retirées (accès direct, comme un compte
        // antérieur) : les conditions redeviennent en attente.
        await db()
          .collection('legal_acceptances')
          .deleteMany({ userId: new Types.ObjectId(o.userId) });
        const status = await http()
          .get('/legal/acceptance')
          .set('Authorization', `Bearer ${o.token}`);
        expect(status.body.pending.length).toBeGreaterThan(0);
        const before = await eventsOf(o.userId);
        const confirm = await http()
          .post('/legal/acceptance')
          .set('Authorization', `Bearer ${o.token}`)
          .send({
            accepted: true,
            locale: status.body.locale,
            documents: status.body.pending,
            notices: status.body.notices,
          });
        expect(confirm.status).toBe(200);
        expect(confirm.body.status).toBe('recorded');
        expect(await eventsOf(o.userId)).toEqual(before);
      }
      expect((await consent.emailEligibility(without.userId)).eligible).toBe(
        false,
      );
      expect(
        (await consent.emailEligibility(withConsent.userId)).eligible,
      ).toBe(true);
    });

    it('préférences de notifications sans effet ; refus sans effet sur l’accès', async () => {
      const o = await owner('prefs');
      const prefs = await http()
        .put('/notifications/preferences')
        .set('Authorization', `Bearer ${o.token}`)
        .send({ platformMessage: true });
      expect(prefs.status).toBe(200);
      expect(await eventsOf(o.userId)).toEqual([]);
      expect((await consent.emailEligibility(o.userId)).reasons).toEqual([
        'no_consent',
      ]);
      // Accord puis retrait : préférences inchangées, application accessible.
      await put(o.token, grant(true));
      await put(o.token, grant(false));
      const after = await http()
        .get('/notifications/preferences')
        .set('Authorization', `Bearer ${o.token}`);
      expect(after.status).toBe(200);
      expect(after.body.categories.platformMessage).toBe(true);
      const me = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${o.token}`);
      expect(me.status).toBe(200);
    });

    it('preuves immuables côté application', async () => {
      const o = await owner('immutable', {
        marketingEmailConsent: grant(true),
      });
      const model = app.get(getModelToken('MarketingConsentEvent'));
      await expect(
        model.updateOne(
          { userId: new Types.ObjectId(o.userId) },
          { $set: { action: 'withdrawn' } },
        ),
      ).rejects.toThrow(/immuable/);
      await expect(
        model.deleteMany({ userId: new Types.ObjectId(o.userId) }),
      ).rejects.toThrow(/immuable/);
      expect(await eventsOf(o.userId)).toHaveLength(1);
      expect(FR_TEXT).toContain('Je peux me désinscrire à tout moment.');
    });
  });

  describe('Accès aux réglages hors des pages métier', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const preferences = (token: string) =>
      http()
        .get('/notifications/preferences')
        .set('Authorization', `Bearer ${token}`);
    const both = async (token: string) => {
      expect((await view(token)).status).toBe(200);
      const res = await put(token, grant(true));
      expect(res.status).toBe(200);
      expect(res.body.granted).toBe(true);
      expect((await put(token, grant(false))).body.granted).toBe(false);
    };

    afterEach(() => {
      subscriptionOffsetMs = 0;
    });

    it('vendeur sans droit particulier : réglage accessible', async () => {
      const o = await owner('seller-shop');
      const email = address('seller');
      const user = await userModel.create({
        name: 'Vendeur',
        email,
        password: await bcrypt.hash(PASSWORD, 10),
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      });
      await db()
        .collection('organizationmemberships')
        .insertOne({
          organizationId: new Types.ObjectId(o.organizationId),
          userId: user._id,
          role: 'seller',
          permissions: [],
          status: 'active',
          invitedById: null,
          joinedAt: new Date(),
        });
      const login = await http()
        .post('/auth/login')
        .send({ email, password: PASSWORD, organizationId: o.organizationId });
      expect(login.status).toBe(201);
      await both(login.body.access_token as string);
      expect(await eventsOf(String(user._id))).toHaveLength(2);
    });

    it('abonnement expiré (session applicative puis session limitée) : réglage accessible', async () => {
      const o = await owner('expired');
      subscriptionOffsetMs = 60 * DAY_MS;
      // Jeton applicatif émis avant l'expiration : pages métier refusées…
      expect((await preferences(o.token)).status).toBe(403);
      // …réglage personnel accessible.
      await both(o.token);
      // Nouvelle connexion : session LIMITÉE seulement.
      const login = await http().post('/auth/login').send({
        email: o.email,
        password: PASSWORD,
        organizationId: o.organizationId,
      });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('SUBSCRIPTION_INACTIVE');
      const limited = login.body.restrictedToken as string;
      expect((await preferences(limited)).status).toBe(403);
      await both(limited);
      expect(await eventsOf(o.userId)).toHaveLength(4);
    });

    it('commerce suspendu pendant la session : réglage accessible', async () => {
      const o = await owner('suspended');
      await db()
        .collection('organizations')
        .updateOne(
          { _id: new Types.ObjectId(o.organizationId) },
          { $set: { status: 'suspended' } },
        );
      expect((await preferences(o.token)).status).toBe(403);
      await both(o.token);
      expect(await eventsOf(o.userId)).toHaveLength(2);
    });
  });
});
