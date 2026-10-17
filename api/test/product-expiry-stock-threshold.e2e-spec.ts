import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import sharp from 'sharp';
import { App } from 'supertest/types';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument, UserRole } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import {
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Section } from './../src/sections/schemas/section.schema';
import type { SectionDocument } from './../src/sections/schemas/section.schema';
import { S3Service } from './../src/s3/s3.service';
import { PushRuntime } from './../src/push/push-runtime';
import { PushDispatcherService } from './../src/push/push-dispatcher.service';
import { ensurePushIndexes } from './../src/push/push-indexes';
import {
  PushJob,
  PushJobDocument,
} from './../src/push/schemas/push-job.schema';
import { PushCategory } from './../src/push/schemas/push-category';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { createInvitedAccount } from './e2e/invitation-acceptance-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';
import {
  inventoryProductFields,
  stripProductFieldPermissions,
} from './../src/migrations/product-field-permissions';

/**
 * E2E — date de péremption facultative et seuil de stock faible
 * personnalisé : validation, permissions propres (création, modification,
 * effacement), invitations et membres (catalogue 3), alertes de stock
 * (entrée sous le seuil, aucune répétition, réarmement, changement de
 * seuil, rupture inchangée), Analyse, temps réel et isolation.
 *
 * MongoMemoryReplSet (vraies transactions), AppModule réelle, stockage des
 * photos simulé (espion `S3Service`, aucun réseau), centre de notifications
 * actif sans push, passes du dispatcher explicites.
 */

const TEST_JWT_SECRET = 'expiry-threshold-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://expiry-threshold-e2e.example.com';
const PASSWORD = 'expiry-threshold-pw-!1x';

describe('E2E — date de péremption et seuil de stock faible', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let jobModel: Model<PushJobDocument>;
  let runtime: PushRuntime;
  let dispatcher: PushDispatcherService;
  let png = Buffer.alloc(0);
  let uploadSpy: jest.SpyInstance;
  let seq = 0;
  const emailSender = createE2eEmailSender();
  const sockets: Socket[] = [];

  const server = () => app.getHttpServer();
  const http = () => request(server());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const clearThrottle = () =>
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();

  async function login(email: string): Promise<string> {
    clearThrottle();
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  async function registerOwner(label: string) {
    clearThrottle();
    seq += 1;
    const email = `${label}-${seq}-expiry@et.test`;
    const reg = await postRegister(app, {
      ...OWNER_TERMS,
      name: `Owner ${seq}`,
      email,
      password: PASSWORD,
      organizationName: `Org ${label} ${seq}`.slice(0, 20),
    });
    expect(reg.status).toBe(202);
    const orgId = reg.owner!.organization._id;
    const token = await login(email);
    const section = await sectionModel.create({
      organizationId: new Types.ObjectId(orgId),
      name: `Rayon ${seq}`,
      description: '',
    });
    return { email, orgId, token, sectionId: section._id.toHexString() };
  }

  async function seedMember(
    orgId: string,
    permissions: DelegablePermission[] = [],
    role:
      | OrganizationRole.ADMIN
      | OrganizationRole.SELLER = OrganizationRole.SELLER,
  ) {
    seq += 1;
    const email = `member-${seq}-expiry@et.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `Membre ${seq}`,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      role: UserRole.SELLER,
    });
    const membership = await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: MembershipStatus.ACTIVE,
      permissions,
    });
    return {
      email,
      membershipId: membership._id.toHexString(),
      token: await login(email),
    };
  }

  async function seedProduct(
    orgId: string,
    sectionId: string,
    initial: number,
    extra: Record<string, unknown> = {},
  ) {
    seq += 1;
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: new Types.ObjectId(sectionId),
      name: `Produit ${seq}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: initial,
      remainingQuantity: initial,
      ...extra,
    });
    return product._id.toHexString();
  }

  const createProduct = (
    token: string,
    sectionId: string,
    fields: Record<string, string> = {},
  ) => {
    seq += 1;
    let req = http()
      .post('/products')
      .set(auth(token))
      .field('sectionId', sectionId)
      .field('name', `Créé ${seq}`)
      .field('purchasePrice', '5')
      .field('salePrice', '10')
      .field('initialQuantity', '20');
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    return req.attach('image', png, {
      filename: 'p.png',
      contentType: 'image/png',
    });
  };
  const patchJson = (token: string, id: string, body: object) =>
    http().patch(`/products/${id}`).set(auth(token)).send(body);
  const raw = (id: string) => productModel.findById(id).lean().exec();
  const getProduct = (token: string, id: string) =>
    http().get(`/products/${id}`).set(auth(token));
  const sell = (token: string, productId: string, quantity: number) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice: 400 });
  const lows = (productId: string) =>
    jobModel
      .find({
        category: PushCategory.STOCK_LOW,
        productId: new Types.ObjectId(productId),
      })
      .sort({ _id: 1 })
      .lean()
      .exec();
  const depleted = (productId: string) =>
    jobModel
      .find({
        category: PushCategory.STOCK_DEPLETED,
        productId: new Types.ObjectId(productId),
      })
      .lean()
      .exec();
  const status = async (token: string, id: string) =>
    ((await getProduct(token, id)).body as { status: string }).status;

  beforeAll(async () => {
    png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#3a7' },
    })
      .png()
      .toBuffer();
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
      process.env.PUBLIC_APP_URL = 'https://app.expiry-threshold-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
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
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      await ensurePushIndexes(connection);

      const s3 = moduleFixture.get(S3Service);
      uploadSpy = jest
        .spyOn(s3, 'uploadValidatedImage')
        .mockImplementation((_body, _prefix, _image, options) =>
          Promise.resolve({ key: options?.key as string, storage: s3.storage }),
        );
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    clearThrottle();
    runtime.deactivate();
    runtime.activateCenter();
  });

  afterEach(() => {
    for (const s of sockets) s.disconnect();
    sockets.length = 0;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Création et validation', () => {
    it('sans les champs : fonctionnement inchangé, champs absents en base, `null` exposés', async () => {
      const o = await registerOwner('create');
      const res = await createProduct(o.token, o.sectionId);
      expect(res.status).toBe(201);
      expect(res.body.expiryDate).toBeNull();
      expect(res.body.lowStockThreshold).toBeNull();
      const doc = await raw(res.body._id as string);
      expect(doc).not.toHaveProperty('expiryDate');
      expect(doc).not.toHaveProperty('lowStockThreshold');

      // Formulaire multipart vide : non renseigné, jamais 0.
      const empty = await createProduct(o.token, o.sectionId, {
        expiryDate: '',
        lowStockThreshold: '',
      });
      expect(empty.status).toBe(201);
      expect(empty.body.lowStockThreshold).toBeNull();
      expect(await raw(empty.body._id as string)).not.toHaveProperty(
        'lowStockThreshold',
      );
    });

    it('date passée acceptée telle quelle ; seuil 0 explicite conservé', async () => {
      const o = await registerOwner('create-values');
      const res = await createProduct(o.token, o.sectionId, {
        expiryDate: '2020-01-15',
        lowStockThreshold: '0',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        expiryDate: '2020-01-15',
        lowStockThreshold: 0,
      });
      const doc = await raw(res.body._id as string);
      expect(doc?.expiryDate).toBe('2020-01-15');
      expect(doc?.lowStockThreshold).toBe(0);
    });

    it('valeurs invalides : 400, aucun produit créé', async () => {
      const o = await registerOwner('create-invalid');
      for (const fields of [
        { lowStockThreshold: '-1' },
        { lowStockThreshold: 'beaucoup' },
        { expiryDate: '2026-02-30' },
        { expiryDate: '2026-10-17T00:00:00Z' },
      ]) {
        const res = await createProduct(o.token, o.sectionId, fields);
        expect(res.status).toBe(400);
      }
      expect(
        await productModel.countDocuments({
          organizationId: new Types.ObjectId(o.orgId),
        }),
      ).toBe(0);
    });

    it('droits de création : products.manage ne suffit pas pour ces champs (403, aucune photo envoyée)', async () => {
      const o = await registerOwner('create-rights');
      const manager = await seedMember(o.orgId, ['products.manage']);
      const upload = uploadSpy;
      upload.mockClear();
      for (const fields of [
        { expiryDate: '2027-01-01' },
        { lowStockThreshold: '3' },
      ]) {
        expect(
          (await createProduct(manager.token, o.sectionId, fields)).status,
        ).toBe(403);
      }
      expect(upload).not.toHaveBeenCalled();
      // Sans ces champs : création permise comme avant.
      expect((await createProduct(manager.token, o.sectionId)).status).toBe(
        201,
      );

      const full = await seedMember(o.orgId, [
        'products.manage',
        'products.manage_expiry',
        'stock.manage_thresholds',
      ]);
      const ok = await createProduct(full.token, o.sectionId, {
        expiryDate: '2027-01-01',
        lowStockThreshold: '3',
      });
      expect(ok.status).toBe(201);
      // Droit propre sans products.manage : la création reste refusée.
      const expiryOnly = await seedMember(o.orgId, ['products.manage_expiry']);
      expect(
        (
          await createProduct(expiryOnly.token, o.sectionId, {
            expiryDate: '2027-01-01',
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('2. Modification, effacement et champs protégés', () => {
    it('renseigner, modifier, effacer (JSON null et multipart vide) ; date stable, journal existant', async () => {
      const o = await registerOwner('update');
      const id = await seedProduct(o.orgId, o.sectionId, 10);

      expect(
        (await patchJson(o.token, id, { expiryDate: '2026-03-31' })).body
          .product.expiryDate,
      ).toBe('2026-03-31');
      expect(
        (await patchJson(o.token, id, { expiryDate: '2026-04-30' })).status,
      ).toBe(200);
      expect((await raw(id))?.expiryDate).toBe('2026-04-30');

      const cleared = await patchJson(o.token, id, { expiryDate: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.product.expiryDate).toBeNull();
      expect(await raw(id)).not.toHaveProperty('expiryDate');

      // Multipart (formulaire avec photo) : chaîne vide = effacement.
      await patchJson(o.token, id, {
        expiryDate: '2026-05-01',
        lowStockThreshold: 4,
      }).expect(200);
      const multipart = await http()
        .patch(`/products/${id}`)
        .set(auth(o.token))
        .field('expiryDate', '')
        .field('lowStockThreshold', '');
      expect(multipart.status).toBe(200);
      const doc = await raw(id);
      expect(doc).not.toHaveProperty('expiryDate');
      expect(doc).not.toHaveProperty('lowStockThreshold');

      // Journal d'audit existant : nouvelles actions, valeurs avant/après.
      const detail = await getProduct(o.token, id);
      const actions = (
        detail.body.auditLogs as Array<{
          action: string;
          details: Record<string, unknown>;
        }>
      ).filter((l) =>
        ['expiry_changed', 'threshold_changed'].includes(l.action),
      );
      expect(actions.map((l) => l.action).sort()).toEqual(
        [
          'expiry_changed',
          'expiry_changed',
          'expiry_changed',
          'expiry_changed',
          'expiry_changed',
          'threshold_changed',
          'threshold_changed',
        ].sort(),
      );
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'expiry_changed',
            details: { expiryDate: { from: '2026-04-30', to: null } },
          }),
          expect.objectContaining({
            action: 'threshold_changed',
            details: { lowStockThreshold: { from: 4, to: null } },
          }),
        ]),
      );
    });

    it('membre sans les nouveaux droits : autres champs modifiables, valeurs protégées intactes ; tentative refusée en entier', async () => {
      const o = await registerOwner('protected');
      const id = await seedProduct(o.orgId, o.sectionId, 10, {
        expiryDate: '2027-06-30',
        lowStockThreshold: 2,
      });
      const manager = await seedMember(o.orgId, [
        'products.manage',
        'stock.adjust',
      ]);

      const ok = await patchJson(manager.token, id, {
        name: 'Renommé',
        salePrice: 450,
        additionalStock: 5,
      });
      expect(ok.status).toBe(200);
      let doc = await raw(id);
      expect(doc).toMatchObject({
        name: 'Renommé',
        salePrice: 450,
        remainingQuantity: 15,
        expiryDate: '2027-06-30',
        lowStockThreshold: 2,
      });

      for (const body of [
        { expiryDate: null },
        { expiryDate: '2028-01-01' },
        { lowStockThreshold: null },
        { lowStockThreshold: 0 },
        { name: 'Encore', expiryDate: '2028-01-01' },
      ]) {
        expect((await patchJson(manager.token, id, body)).status).toBe(403);
      }
      doc = await raw(id);
      expect(doc).toMatchObject({
        name: 'Renommé',
        expiryDate: '2027-06-30',
        lowStockThreshold: 2,
      });

      // Droits propres sans stock.adjust : jamais le prix ni le stock.
      const fieldsOnly = await seedMember(o.orgId, [
        'products.manage',
        'products.manage_expiry',
        'stock.manage_thresholds',
      ]);
      for (const body of [
        { lowStockThreshold: 5, additionalStock: 1 },
        { expiryDate: '2028-01-01', salePrice: 1 },
      ]) {
        expect((await patchJson(fieldsOnly.token, id, body)).status).toBe(403);
      }
      expect(
        (
          await patchJson(fieldsOnly.token, id, {
            expiryDate: '2028-01-01',
            lowStockThreshold: 5,
          })
        ).status,
      ).toBe(200);
      doc = await raw(id);
      expect(doc).toMatchObject({
        salePrice: 450,
        remainingQuantity: 15,
        expiryDate: '2028-01-01',
        lowStockThreshold: 5,
      });
    });

    it('lecture : un vendeur sans droit voit la date et le seuil (projection standard), y compris en temps réel', async () => {
      const o = await registerOwner('read');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      const seller = await seedMember(o.orgId);
      const socket = io(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { origin: E2E_CORS_ORIGIN },
        auth: { token: seller.token },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      // Rattachement à la room de l'organisation après la connexion.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const received = new Promise<{
        product: {
          expiryDate: string | null;
          lowStockThreshold: number | null;
        };
        status: string;
      }>((resolve) => socket.once('product:updated', resolve));
      await patchJson(o.token, id, {
        expiryDate: '2026-12-01',
        lowStockThreshold: 11,
      }).expect(200);
      const event = await received;
      expect(event.product).toMatchObject({
        expiryDate: '2026-12-01',
        lowStockThreshold: 11,
      });
      expect(event.status).toBe('low_stock'); // 10 < 11

      const listed = await http()
        .get('/products')
        .query({ sectionId: o.sectionId })
        .set(auth(seller.token));
      expect(listed.body[0].product).toMatchObject({
        expiryDate: '2026-12-01',
        lowStockThreshold: 11,
      });
      expect(listed.body[0].status).toBe('low_stock');
    });

    it('isolation : un autre commerce ne lit ni ne modifie ces champs (404)', async () => {
      const a = await registerOwner('iso-a');
      const b = await registerOwner('iso-b');
      const id = await seedProduct(a.orgId, a.sectionId, 10, {
        expiryDate: '2027-01-01',
        lowStockThreshold: 3,
      });
      for (const body of [
        { expiryDate: null },
        { lowStockThreshold: 50 },
        { expiryDate: '2030-01-01' },
      ]) {
        expect((await patchJson(b.token, id, body)).status).toBe(404);
      }
      expect((await getProduct(b.token, id)).status).toBe(404);
      expect(await raw(id)).toMatchObject({
        expiryDate: '2027-01-01',
        lowStockThreshold: 3,
      });
      expect(await lows(id)).toHaveLength(0);
    });
  });

  describe('3. Statut et alertes de stock faible', () => {
    it('seuil personnalisé : au-dessus, au seuil, en dessous ; une alerte à l’entrée ; changement de seuil sans doublon ; réapprovisionnement puis nouvelle alerte ; rupture inchangée', async () => {
      const o = await registerOwner('alerts');
      const trusted = await seedMember(o.orgId, [
        'products.view_stock_details',
      ]);
      const seller = await seedMember(o.orgId);
      const id = await seedProduct(o.orgId, o.sectionId, 100);

      await patchJson(o.token, id, { lowStockThreshold: 10 }).expect(200);
      expect(await lows(id)).toHaveLength(0);
      expect((await sell(o.token, id, 89)).status).toBe(201); // 11
      expect(await status(o.token, id)).toBe('in_stock');
      expect((await sell(o.token, id, 1)).status).toBe(201); // 10 = seuil
      expect(await status(o.token, id)).toBe('in_stock');
      expect(await lows(id)).toHaveLength(0);
      expect((await sell(o.token, id, 1)).status).toBe(201); // 9 < 10
      expect(await status(o.token, id)).toBe('low_stock');
      expect(await lows(id)).toHaveLength(1);
      expect((await sell(o.token, id, 1)).status).toBe(201); // 8
      expect(await lows(id)).toHaveLength(1);

      // Destinataires et préférences existants : `products.view_stock_details`.
      await dispatcher.runOnce();
      const opened = async (token: string) =>
        (
          (await http().get('/notifications?limit=50').set(auth(token)))
            .body as { items: Array<{ id: string; category: PushCategory }> }
        ).items.filter((n) => n.category === PushCategory.STOCK_LOW);
      const ownerItems = await opened(o.token);
      expect(ownerItems).toHaveLength(1);
      expect(await opened(trusted.token)).toHaveLength(1);
      expect(await opened(seller.token)).toEqual([]);
      const details = await http()
        .post(`/notifications/${ownerItems[0].id}/open`)
        .set(auth(o.token));
      expect(details.body.details).toMatchObject({
        kind: 'stock',
        remainingQuantity: 8,
        lowStockThreshold: 10,
      });

      // Reste sous le seuil (10 → 12) : aucune nouvelle alerte.
      await patchJson(o.token, id, { lowStockThreshold: 12 }).expect(200);
      // Sortie (12 → 5) puis ré-entrée par le seuil (5 → 9) : une alerte.
      await patchJson(o.token, id, { lowStockThreshold: 5 }).expect(200);
      expect(await status(o.token, id)).toBe('in_stock');
      await patchJson(o.token, id, { lowStockThreshold: 9 }).expect(200);
      expect(await lows(id)).toHaveLength(2);
      // Même valeur renvoyée : aucune écriture, aucune alerte.
      await patchJson(o.token, id, { lowStockThreshold: 9 }).expect(200);
      expect(await lows(id)).toHaveLength(2);

      // Réapprovisionnement au-dessus du seuil : l'alerte en attente devient
      // caduque ; nouvelle baisse sous le seuil : nouvelle alerte.
      await patchJson(o.token, id, { additionalStock: 20 }).expect(200); // 28
      await dispatcher.runOnce();
      const pending = await lows(id);
      expect(pending[1].outcome).toBe('restocked');
      expect((await sell(o.token, id, 20)).status).toBe(201); // 8 < 9
      expect(await lows(id)).toHaveLength(3);

      // Retour à la règle par défaut : 8 ≤ 20 % de 120 → toujours faible,
      // aucune alerte (déjà dans l'état faible).
      const back = await patchJson(o.token, id, { lowStockThreshold: null });
      expect(back.body.product.lowStockThreshold).toBeNull();
      expect(back.body.status).toBe('low_stock');
      expect(await lows(id)).toHaveLength(3);

      // Rupture : traitement existant, jamais une alerte de stock faible.
      expect((await sell(o.token, id, 8)).status).toBe(201);
      expect(await status(o.token, id)).toBe('out_of_stock');
      expect(await depleted(id)).toHaveLength(1);
      expect(await lows(id)).toHaveLength(3);
    });

    it('seuil 0 : jamais « faible », seule la rupture ; règle par défaut inchangée sans seuil', async () => {
      const o = await registerOwner('zero');
      const zero = await seedProduct(o.orgId, o.sectionId, 10, {
        lowStockThreshold: 0,
      });
      expect((await sell(o.token, zero, 9)).status).toBe(201); // 1
      expect(await status(o.token, zero)).toBe('in_stock');
      expect(await lows(zero)).toHaveLength(0);
      expect((await sell(o.token, zero, 1)).status).toBe(201);
      expect(await depleted(zero)).toHaveLength(1);

      const legacy = await seedProduct(o.orgId, o.sectionId, 100);
      expect((await sell(o.token, legacy, 79)).status).toBe(201); // 21
      expect(await lows(legacy)).toHaveLength(0);
      expect((await sell(o.token, legacy, 1)).status).toBe(201); // 20
      expect(await lows(legacy)).toHaveLength(1);
      expect(await status(o.token, legacy)).toBe('low_stock');
    });

    it('changements de seuil SIMULTANÉS faisant entrer sous le seuil : exactement une alerte', async () => {
      const o = await registerOwner('race');
      const id = await seedProduct(o.orgId, o.sectionId, 100, {
        remainingQuantity: 40,
        lowStockThreshold: 5,
      });
      const results = await Promise.all(
        [50, 50, 60].map((value) =>
          patchJson(o.token, id, { lowStockThreshold: value }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(await lows(id)).toHaveLength(1);
    });

    it('Analyse « À surveiller » : seuil personnalisé pris en compte, distingué de la règle par défaut', async () => {
      const o = await registerOwner('analytics');
      const custom = await seedProduct(o.orgId, o.sectionId, 100, {
        remainingQuantity: 30,
        lowStockThreshold: 40,
      });
      const zero = await seedProduct(o.orgId, o.sectionId, 100, {
        remainingQuantity: 5,
        lowStockThreshold: 0,
      });
      const fallback = await seedProduct(o.orgId, o.sectionId, 100, {
        remainingQuantity: 10,
      });
      const body = (await http().get('/analytics/insights').set(auth(o.token)))
        .body as {
        stock: {
          low: {
            items: Array<{
              productId: string;
              lowStockThreshold: number | null;
            }>;
          };
        };
      };
      const ids = body.stock.low.items.map((i) => i.productId);
      expect(ids).toEqual(expect.arrayContaining([custom, fallback]));
      expect(ids).not.toContain(zero);
      expect(
        body.stock.low.items.find((i) => i.productId === custom)
          ?.lowStockThreshold,
      ).toBe(40);
      expect(
        body.stock.low.items.find((i) => i.productId === fallback)
          ?.lowStockThreshold,
      ).toBeNull();
      const overview = await http()
        .get('/analytics/overview')
        .set(auth(o.token));
      expect(overview.body.lowStockCount).toBe(2);
    });
  });

  describe('4. Invitations et gestion des membres', () => {
    const invite = (
      token: string,
      email: string,
      permissions: DelegablePermission[],
      role: 'admin' | 'seller' = 'seller',
    ) =>
      http()
        .post('/organizations/invitations')
        .set(auth(token))
        .send({ email, role, permissions });
    const tokenOf = (res: request.Response) =>
      new URL(String(res.body.invitationUrl)).searchParams.get('token') ?? '';

    async function accept(res: request.Response, email: string) {
      const created = await createInvitedAccount(
        server(),
        emailSender,
        tokenOf(res),
        email,
        { name: 'Invité', password: PASSWORD },
      );
      expect([200, 201]).toContain(created.status);
      return login(email);
    }

    it('invitation portant les nouveaux droits : persistés à l’acceptation, effectifs côté API', async () => {
      const o = await registerOwner('invite-new');
      const email = `invitee-new-${++seq}@et.test`;
      const res = await invite(o.token, email, [
        'products.manage',
        'products.manage_expiry',
      ]);
      expect(res.status).toBe(201);
      expect(res.body.invitation.permissions).toEqual([
        'products.manage',
        'products.manage_expiry',
      ]);
      const token = await accept(res, email);
      const membership = await membershipModel
        .findOne({ organizationId: new Types.ObjectId(o.orgId) })
        .sort({ _id: -1 })
        .lean();
      expect(membership?.permissions).toEqual([
        'products.manage',
        'products.manage_expiry',
      ]);
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      expect(
        (await patchJson(token, id, { expiryDate: '2027-02-01' })).status,
      ).toBe(200);
      expect(
        (await patchJson(token, id, { lowStockThreshold: 1 })).status,
      ).toBe(403);
    });

    it('invitation sans ces droits (forme antérieure) : acceptée sans attribution implicite', async () => {
      const o = await registerOwner('invite-old');
      const email = `invitee-old-${++seq}@et.test`;
      const res = await invite(o.token, email, ['products.manage']);
      expect(res.status).toBe(201);
      const token = await accept(res, email);
      const context = await http().get('/auth/context').set(auth(token));
      expect(context.body.effectivePermissions).toContain('products.manage');
      expect(context.body.effectivePermissions).not.toContain(
        'products.manage_expiry',
      );
      expect(context.body.effectivePermissions).not.toContain(
        'stock.manage_thresholds',
      );
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      expect(
        (await patchJson(token, id, { expiryDate: '2027-02-01' })).status,
      ).toBe(403);
    });

    it('administrateur invité : droits complets ; délégation bornée aux droits de l’auteur', async () => {
      const o = await registerOwner('invite-admin');
      const adminEmail = `invitee-admin-${++seq}@et.test`;
      const res = await invite(o.token, adminEmail, [], 'admin');
      expect(res.status).toBe(201);
      const adminToken = await accept(res, adminEmail);
      const context = await http().get('/auth/context').set(auth(adminToken));
      expect(context.body.effectivePermissions).toEqual(
        expect.arrayContaining([
          'products.manage_expiry',
          'stock.manage_thresholds',
        ]),
      );

      // Vendeur pouvant inviter, sans les nouveaux droits : ne peut pas les
      // accorder (anti-escalade existante).
      const inviter = await seedMember(o.orgId, [
        'members.invite',
        'products.manage',
      ]);
      expect(
        (
          await invite(inviter.token, `x-${++seq}@et.test`, [
            'products.manage',
            'stock.manage_thresholds',
          ])
        ).status,
      ).toBe(403);
      expect(
        (await invite(inviter.token, `y-${++seq}@et.test`, ['products.manage']))
          .status,
      ).toBe(201);
    });

    it('modification d’un membre : catalogue 3 accorde et retire ; un ancien formulaire (catalogue 2) ne retire rien', async () => {
      const o = await registerOwner('members');
      const member = await seedMember(o.orgId, ['products.manage']);
      const patchMember = (
        permissions: DelegablePermission[],
        catalog?: number,
      ) =>
        http()
          .patch(`/organizations/members/${member.membershipId}`)
          .query(catalog ? { permissionsCatalog: String(catalog) } : {})
          .set(auth(o.token))
          .send({ permissions });
      const stored = async () =>
        (await membershipModel.findById(member.membershipId).lean())
          ?.permissions;

      expect(
        (await patchMember(['products.manage', 'stock.manage_thresholds'], 3))
          .status,
      ).toBe(200);
      expect(await stored()).toEqual([
        'products.manage',
        'stock.manage_thresholds',
      ]);
      // Ancien web (catalogue 2) : ne connaît pas la permission, la conserve.
      expect(
        (await patchMember(['products.manage', 'audit.read'], 2)).status,
      ).toBe(200);
      expect(await stored()).toEqual(
        expect.arrayContaining([
          'products.manage',
          'audit.read',
          'stock.manage_thresholds',
        ]),
      );
      // Web actuel : retrait explicite.
      expect((await patchMember(['products.manage'], 3)).status).toBe(200);
      expect(await stored()).toEqual(['products.manage']);
      // Valeur inconnue refusée (validation existante).
      expect(
        (
          await patchMember(
            [
              'products.manage',
              'products.manage_everything' as DelegablePermission,
            ],
            3,
          )
        ).status,
      ).toBe(400);
    });
  });

  describe('5. Retour arrière : inventaire et retrait des permissions', () => {
    it('inventaire en lecture seule, retrait idempotent, champs produit conservés', async () => {
      const o = await registerOwner('rollback');
      await seedMember(o.orgId, ['products.manage_expiry']);
      await seedMember(o.orgId, ['products.manage', 'stock.manage_thresholds']);
      await seedProduct(o.orgId, o.sectionId, 5, {
        expiryDate: '2027-01-01',
        lowStockThreshold: 2,
      });
      const before = await inventoryProductFields(connection);
      expect(
        before.memberships['products.manage_expiry'],
      ).toBeGreaterThanOrEqual(1);
      expect(
        before.memberships['stock.manage_thresholds'],
      ).toBeGreaterThanOrEqual(1);
      expect(before.products.withExpiryDate).toBeGreaterThanOrEqual(1);
      // L'inventaire n'écrit rien.
      expect(await inventoryProductFields(connection)).toEqual(before);

      const removed = await stripProductFieldPermissions(connection);
      expect(removed.memberships).toBeGreaterThanOrEqual(2);
      const after = await inventoryProductFields(connection);
      expect(after.memberships).toEqual({
        'products.manage_expiry': 0,
        'stock.manage_thresholds': 0,
      });
      expect(after.invitations).toEqual({
        'products.manage_expiry': 0,
        'stock.manage_thresholds': 0,
      });
      expect(after.products).toEqual(before.products);
      expect(await stripProductFieldPermissions(connection)).toEqual({
        memberships: 0,
        invitations: 0,
      });
      // Les autres permissions restent en place.
      expect(
        await membershipModel.countDocuments({
          organizationId: new Types.ObjectId(o.orgId),
          permissions: 'products.manage',
        }),
      ).toBe(1);
    });
  });
});
