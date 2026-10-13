import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { OrganizationInvitation } from './../src/organizations/schemas/invitation.schema';
import type { OrganizationInvitationDocument } from './../src/organizations/schemas/invitation.schema';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Section } from './../src/sections/schemas/section.schema';
import type { SectionDocument } from './../src/sections/schemas/section.schema';
import { SubscriptionsService } from './../src/subscriptions/subscriptions.service';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildOriginAllowlist,
  parseCORSOrigin,
  buildHttpCorsOptions,
} from './../src/events/origin.helpers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  acceptWithSession,
  requestAccountToken,
} from './e2e/invitation-acceptance-fixtures';
import { INVITATION_TERMS, OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E (1-22B) — contrôles d'autorisation internes à une organisation :
 * 1. suppression définitive réservée aux éléments déjà dans la corbeille ;
 * 2. invitation inutilisable quand son auteur a perdu l'autorité de
 *    l'accorder (parcours compte existant ET nouveau compte) ;
 * 3. connexion temps réel d'un membre révoqué fermée, y compris quand la
 *    révocation survient pendant la poignée de main.
 * Base MongoDB éphémère, expéditeur d'e-mails simulé, aucun service réel.
 */

const emailSender = createE2eEmailSender();
const TEST_JWT_SECRET = 'internal-authz-22b-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://internal-authz-22b.example.com';
const PASSWORD = 'internal-authz-22b-pw-!1x';

interface Member {
  userId: string;
  membershipId: string;
  token: string;
}

describe('Autorisations internes (e2e 1-22B)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let invitationModel: Model<OrganizationInvitationDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let subscriptions: SubscriptionsService;

  let orgAId = '';
  let ownerA = '';
  let seq = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (email: string, organizationId?: string) =>
    http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
  const unique = (label: string) => `${label}-${++seq}-22b@royalvibe.test`;

  async function createMember(
    permissions: string[],
    role: 'seller' | 'admin' = 'seller',
  ): Promise<Member & { email: string }> {
    const email = unique('member');
    const userId = new Types.ObjectId();
    const membershipId = new Types.ObjectId();
    await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      _id: userId,
      name: 'Membre 22B',
      email,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    await membershipModel.create({
      _id: membershipId,
      organizationId: new Types.ObjectId(orgAId),
      userId,
      role,
      status: 'active',
      permissions,
    });
    const res = await login(email, orgAId);
    expect(res.status).toBe(201);
    return {
      email,
      userId: userId.toHexString(),
      membershipId: membershipId.toHexString(),
      token: res.body.access_token as string,
    };
  }

  /** Compte existant, propriétaire de sa propre organisation (session app). */
  async function createOutsider(): Promise<{ email: string; token: string }> {
    const email = unique('outsider');
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: 'Externe 22B',
      email,
      password: PASSWORD,
      organizationName: `Boutique Externe ${seq}`,
    });
    expect(reg.status).toBe(202);
    const res = await login(email, reg.owner!.organization._id);
    expect(res.status).toBe(201);
    return { email, token: res.body.access_token as string };
  }

  async function createSection(name: string): Promise<string> {
    const res = await http().post('/sections').set(auth(ownerA)).send({ name });
    expect(res.status).toBe(201);
    return res.body._id as string;
  }

  async function createProduct(sectionId: string): Promise<string> {
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgAId),
      sectionId: new Types.ObjectId(sectionId),
      name: `Produit ${++seq}`,
      purchasePrice: 1000,
      salePrice: 1500,
      initialQuantity: 5,
      remainingQuantity: 5,
    });
    return product._id.toString();
  }

  async function invite(
    inviterToken: string,
    email: string,
    role: 'seller' | 'admin',
    permissions: string[],
  ): Promise<string> {
    const res = await http()
      .post('/organizations/invitations')
      .set(auth(inviterToken))
      .send({ email, role, permissions });
    expect(res.status).toBe(201);
    return (
      new URL(String(res.body.invitationUrl)).searchParams.get('token') ?? ''
    );
  }

  const patchMember = (membershipId: string, body: Record<string, unknown>) =>
    http()
      .patch(`/organizations/members/${membershipId}`)
      .set(auth(ownerA))
      .send(body);

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

  /** Vrai si le socket est fermé par le serveur dans le délai. */
  function closedWithin(socket: Socket, ms: number): Promise<boolean> {
    if (!socket.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      socket.once('disconnect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL = 'https://app.internal-authz-22b.test';
      // Relecture périodique de l'adhésion des sockets ouverts (1-22B) :
      // délai court pour la recette, défaut de production inchangé.
      process.env.SOCKET_MEMBERSHIP_RECHECK_SECONDS = '1';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
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

      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      invitationModel = moduleFixture.get(
        getModelToken(OrganizationInvitation.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      subscriptions = moduleFixture.get(SubscriptionsService);

      const reg = await postRegister(app, {
        ...OWNER_TERMS,
        name: 'Owner A',
        email: 'owner-a-22b@royalvibe.test',
        password: PASSWORD,
        organizationName: 'Org A 22B',
      });
      expect(reg.status).toBe(202);
      orgAId = reg.owner!.organization._id;
      const res = await login('owner-a-22b@royalvibe.test', orgAId);
      ownerA = res.body.access_token as string;
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Suppression définitive', () => {
    let trashSeller: Member;

    beforeAll(async () => {
      trashSeller = await createMember(['trash.manage']);
    });

    it('trash.manage seul : un produit ACTIF ne peut être ni mis à la corbeille ni supprimé définitivement', async () => {
      const section = await createSection('Section active 22B');
      const productId = await createProduct(section);

      const soft = await http()
        .delete(`/products/${productId}`)
        .set(auth(trashSeller.token));
      expect(soft.status).toBe(403);

      const purge = await http()
        .delete(`/products/${productId}/permanent`)
        .set(auth(trashSeller.token));
      expect(purge.status).toBe(404);
      expect(await productModel.findById(productId).exec()).not.toBeNull();
    });

    it('trash.manage seul : une section ACTIVE ne peut pas être supprimée définitivement', async () => {
      const section = await createSection('Section active bis 22B');
      const productId = await createProduct(section);

      const soft = await http()
        .delete(`/sections/${section}`)
        .set(auth(trashSeller.token));
      expect(soft.status).toBe(403);

      const purge = await http()
        .delete(`/sections/${section}/permanent`)
        .set(auth(trashSeller.token));
      expect(purge.status).toBe(404);
      expect(await sectionModel.findById(section).exec()).not.toBeNull();
      expect(await productModel.findById(productId).exec()).not.toBeNull();
    });

    it('le propriétaire lui-même passe aussi par la corbeille (aucune purge directe)', async () => {
      const section = await createSection('Section owner 22B');
      const productId = await createProduct(section);
      expect(
        (
          await http()
            .delete(`/products/${productId}/permanent`)
            .set(auth(ownerA))
        ).status,
      ).toBe(404);
      expect(
        (
          await http()
            .delete(`/sections/${section}/permanent`)
            .set(auth(ownerA))
        ).status,
      ).toBe(404);
    });

    it('parcours prévu inchangé : mis à la corbeille par un ayant droit, puis purgé avec trash.manage', async () => {
      const section = await createSection('Section corbeille 22B');
      const productId = await createProduct(section);
      expect(
        (await http().delete(`/products/${productId}`).set(auth(ownerA)))
          .status,
      ).toBe(200);
      const purge = await http()
        .delete(`/products/${productId}/permanent`)
        .set(auth(trashSeller.token));
      expect(purge.status).toBe(200);
      expect(await productModel.findById(productId).exec()).toBeNull();

      expect(
        (await http().delete(`/sections/${section}`).set(auth(ownerA))).status,
      ).toBe(200);
      expect(
        (
          await http()
            .delete(`/sections/${section}/permanent`)
            .set(auth(trashSeller.token))
        ).status,
      ).toBe(200);
      expect(await sectionModel.findById(section).exec()).toBeNull();
    });

    it('restauration concurrente : le produit restauré n’est jamais supprimé ni annoncé supprimé', async () => {
      const section = await createSection('Section course 22B');
      for (let round = 0; round < 5; round += 1) {
        const productId = await createProduct(section);
        await http().delete(`/products/${productId}`).set(auth(ownerA));
        const [restore, purge] = await Promise.all([
          http().patch(`/products/${productId}/restore`).set(auth(ownerA)),
          http()
            .delete(`/products/${productId}/permanent`)
            .set(auth(trashSeller.token)),
        ]);
        const remaining = await productModel.findById(productId).exec();
        if (remaining) {
          // Restauration gagnante : la purge n'a rien supprimé et le dit.
          expect(restore.status).toBe(200);
          expect(remaining.deletedAt).toBeNull();
          expect(purge.status).toBe(404);
        } else {
          // Purge gagnante : la restauration arrivée après échoue.
          expect(purge.status).toBe(200);
          expect(restore.status).toBe(404);
        }
      }
    });

    it('section purgée depuis la corbeille : ses produits ne sont pas supprimés (constat, voir la documentation)', async () => {
      const section = await createSection('Section produits 22B');
      const productId = await createProduct(section);
      await http().delete(`/sections/${section}`).set(auth(ownerA));
      const purge = await http()
        .delete(`/sections/${section}/permanent`)
        .set(auth(trashSeller.token));
      expect(purge.status).toBe(200);
      const product = await productModel.findById(productId).exec();
      expect(product).not.toBeNull();
      expect(product!.deletedAt ?? null).toBeNull();
    });
  });

  describe('2. Invitations après perte de droits de leur auteur', () => {
    async function inviter(
      permissions: string[] = ['members.invite', 'products.manage'],
    ) {
      return createMember(permissions);
    }

    async function membershipOf(email: string) {
      const user = await userModel.findOne({ email }).exec();
      if (!user) return null;
      return membershipModel
        .findOne({
          organizationId: new Types.ObjectId(orgAId),
          userId: user._id,
        })
        .exec();
    }

    it.each([
      ['suspendu', { status: 'suspended' }],
      ['révoqué', { status: 'revoked' }],
      ['privé de members.invite', { permissions: ['products.manage'] }],
    ])(
      'compte existant : auteur %s → acceptation refusée, aucune adhésion',
      async (_label, change) => {
        const author = await inviter();
        const invitee = await createOutsider();
        const token = await invite(author.token, invitee.email, 'seller', [
          'products.manage',
        ]);
        expect((await patchMember(author.membershipId, change)).status).toBe(
          200,
        );

        const res = await acceptWithSession(
          app.getHttpServer(),
          invitee.token,
          token,
        );
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
        expect(await membershipOf(invitee.email)).toBeNull();
      },
    );

    it('compte existant : auteur privé d’une permission accordée par l’invitation → refus', async () => {
      const author = await inviter();
      const invitee = await createOutsider();
      const token = await invite(author.token, invitee.email, 'seller', [
        'products.manage',
      ]);
      expect(
        (
          await patchMember(author.membershipId, {
            permissions: ['members.invite'],
          })
        ).status,
      ).toBe(200);
      const res = await acceptWithSession(
        app.getHttpServer(),
        invitee.token,
        token,
      );
      expect(res.status).toBe(400);
      expect(await membershipOf(invitee.email)).toBeNull();
    });

    it('nouveau compte : lien reçu avant la suspension de l’auteur → création refusée, aucun compte', async () => {
      const author = await inviter();
      const email = unique('new');
      const token = await invite(author.token, email, 'seller', [
        'products.manage',
      ]);
      const accountToken = await requestAccountToken(
        app.getHttpServer(),
        emailSender,
        token,
        email,
      );
      expect(
        (await patchMember(author.membershipId, { status: 'suspended' }))
          .status,
      ).toBe(200);

      const res = await http()
        .post('/auth/invitations/create-account')
        .send({
          ...INVITATION_TERMS,
          token: accountToken,
          name: 'Nouveau 22B',
          password: PASSWORD,
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITATION_INVALID_OR_EXPIRED');
      expect(await userModel.findOne({ email }).exec()).toBeNull();
    });

    it('nouveau compte : aucun lien de création envoyé après la révocation de l’auteur', async () => {
      const author = await inviter();
      const email = unique('new');
      const token = await invite(author.token, email, 'seller', []);
      expect(
        (await patchMember(author.membershipId, { status: 'revoked' })).status,
      ).toBe(200);
      const link = await http()
        .post('/auth/invitations/account-link')
        .send({ token });
      expect(link.status).toBe(400);
      expect(emailSender.sentTo(email)).toHaveLength(0);
    });

    it('simple changement de rôle conservant l’autorité : l’invitation reste valable', async () => {
      const author = await inviter();
      const invitee = await createOutsider();
      const token = await invite(author.token, invitee.email, 'seller', [
        'products.manage',
      ]);
      // Vendeur → admin : members.invite et products.manage restent acquis.
      expect(
        (await patchMember(author.membershipId, { role: 'admin' })).status,
      ).toBe(200);
      const res = await acceptWithSession(
        app.getHttpServer(),
        invitee.token,
        token,
      );
      expect(res.status).toBe(200);
      const membership = await membershipOf(invitee.email);
      expect(membership?.status).toBe('active');
      expect(membership?.permissions).toEqual(['products.manage']);
    });

    it('invitation du propriétaire : valable après transfert de propriété (ancien owner → admin)', async () => {
      const invitee = await createOutsider();
      const token = await invite(ownerA, invitee.email, 'admin', []);
      const heir = await createMember([]);
      const transfer = await http()
        .post(`/organizations/members/${heir.membershipId}/transfer-ownership`)
        .set(auth(ownerA));
      expect(transfer.status).toBe(200);
      try {
        const res = await acceptWithSession(
          app.getHttpServer(),
          invitee.token,
          token,
        );
        expect(res.status).toBe(200);
      } finally {
        // Propriété rendue pour la suite.
        const heirLogin = await login(heir.email, orgAId);
        const back = await http()
          .post(
            `/organizations/members/${(await membershipModel
              .findOne({
                organizationId: new Types.ObjectId(orgAId),
                role: 'admin',
                userId: (await userModel
                  .findOne({ email: 'owner-a-22b@royalvibe.test' })
                  .exec())!._id,
              })
              .exec())!._id.toString()}/transfer-ownership`,
          )
          .set(auth(heirLogin.body.access_token as string));
        expect(back.status).toBe(200);
        ownerA = (await login('owner-a-22b@royalvibe.test', orgAId)).body
          .access_token as string;
      }
    });

    it('concurrence acceptation / suspension : jamais d’adhésion créée APRÈS la suspension validée', async () => {
      for (let round = 0; round < 4; round += 1) {
        const author = await inviter();
        const invitee = await createOutsider();
        const token = await invite(author.token, invitee.email, 'seller', []);
        const [accept, suspend] = await Promise.all([
          acceptWithSession(app.getHttpServer(), invitee.token, token),
          patchMember(author.membershipId, { status: 'suspended' }),
        ]);
        expect(suspend.status).toBe(200);
        expect([200, 400]).toContain(accept.status);
        const joined = await membershipOf(invitee.email);
        const invitation = await invitationModel
          .findOne({ email: invitee.email })
          .exec();
        if (accept.status === 200) {
          // Acceptation sérialisée AVANT la suspension : invitation consommée.
          expect(joined?.status).toBe('active');
          expect(invitation).toBeNull();
        } else {
          // Suspension sérialisée avant : invitation close, aucune adhésion.
          expect(joined).toBeNull();
          expect(invitation?.status).not.toBe('pending');
        }
      }
    });
  });

  describe('3. Révocation d’une connexion temps réel', () => {
    it('aucun événement entrant n’est traité par la passerelle (réception seule)', async () => {
      const member = await createMember([]);
      const socket = await connectSocket(member.token);
      try {
        const before = await productModel.countDocuments().exec();
        socket.emit('product:create', { name: 'Intrus' });
        socket.emit('sale:create', { quantity: 1 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await productModel.countDocuments().exec()).toBe(before);
        expect(socket.connected).toBe(true);
      } finally {
        socket.disconnect();
      }
    });

    it('suspension d’un membre connecté : socket fermé, plus aucune diffusion', async () => {
      const member = await createMember([]);
      const socket = await connectSocket(member.token);
      const closed = closedWithin(socket, 3_000);
      expect(
        (await patchMember(member.membershipId, { status: 'suspended' }))
          .status,
      ).toBe(200);
      expect(await closed).toBe(true);
    });

    it('suspension PENDANT la poignée de main : le socket est fermé après son enregistrement', async () => {
      const member = await createMember([]);
      const original = subscriptions.getAccessDecision.bind(subscriptions);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = jest
        .spyOn(subscriptions, 'getAccessDecision')
        .mockImplementationOnce(async (organizationId: string) => {
          // Handshake bloqué APRÈS la lecture de l'adhésion (encore active).
          await gate;
          return original(organizationId);
        });

      const pending = connectSocket(member.token);
      await waitUntil(() => spy.mock.calls.length >= 1);
      // Révocation validée pendant que le handshake attend.
      expect(
        (await patchMember(member.membershipId, { status: 'suspended' }))
          .status,
      ).toBe(200);
      release();

      let socket: Socket | null = null;
      try {
        socket = await pending;
      } catch {
        // Refus à la poignée de main : également conforme.
        return;
      }
      const received: unknown[] = [];
      socket.on('product:updated', (payload) => received.push(payload));
      const closed = await closedWithin(socket, 3_000);
      if (!closed) {
        // Démonstration de l'impact avant correction : diffusion reçue.
        const section = await createSection(`Section socket ${++seq}`);
        const productId = await createProduct(section);
        await http()
          .patch(`/products/${productId}`)
          .set(auth(ownerA))
          .send({ name: `Renommé ${seq}` });
        await new Promise((resolve) => setTimeout(resolve, 300));
        socket.disconnect();
      }
      expect({ closed, received: received.length }).toEqual({
        closed: true,
        received: 0,
      });
    });

    it('révocation hors du processus (autre instance, écriture directe) : socket fermé à la relecture périodique', async () => {
      const member = await createMember([]);
      const socket = await connectSocket(member.token);
      const closed = closedWithin(socket, 4_000);
      // Aucun appel au registre de ce processus : simule une révocation
      // validée par une autre instance de l'API.
      await membershipModel
        .updateOne({ _id: member.membershipId }, { status: 'revoked' })
        .exec();
      expect(await closed).toBe(true);
    });

    it('changement de permissions hors du processus : socket fermé, reconnexion avec les droits courants', async () => {
      const member = await createMember(['products.view_financials']);
      const socket = await connectSocket(member.token);
      const closed = closedWithin(socket, 4_000);
      await membershipModel
        .updateOne({ _id: member.membershipId }, { permissions: [] })
        .exec();
      expect(await closed).toBe(true);
      const again = await connectSocket(member.token);
      try {
        expect(again.connected).toBe(true);
        expect(await closedWithin(again, 1_500)).toBe(false);
      } finally {
        again.disconnect();
      }
    });

    it('les diffusions produit restent limitées à la visibilité standard (aucun champ financier)', async () => {
      const member = await createMember(['products.view_financials']);
      const socket = await connectSocket(member.token);
      try {
        const section = await createSection(`Section diff ${++seq}`);
        const productId = await createProduct(section);
        const event = new Promise<Record<string, unknown>>((resolve) =>
          socket.once('product:updated', resolve),
        );
        await http()
          .patch(`/products/${productId}`)
          .set(auth(ownerA))
          .send({ name: `Visible ${seq}` });
        const payload = await event;
        for (const key of [
          'purchasePrice',
          'totalPurchaseCost',
          'actualProfit',
          'margin',
          'initialQuantity',
        ]) {
          expect(payload).not.toHaveProperty(key);
        }
      } finally {
        socket.disconnect();
      }
    });
  });
});
