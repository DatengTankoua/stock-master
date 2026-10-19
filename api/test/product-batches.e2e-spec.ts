import 'reflect-metadata';
import { Connection, Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
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
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import { AuditAction, AuditLog } from './../src/audit/schemas/audit-log.schema';
import type { AuditLogDocument } from './../src/audit/schemas/audit-log.schema';
import { ProductBatch } from './../src/products/batches/schemas/product-batch.schema';
import type { ProductBatchDocument } from './../src/products/batches/schemas/product-batch.schema';
import { ensureProductBatchGuard } from './../src/products/batches/product-batch-guard';
import { removeProductBatchValidator } from './../src/products/batches/product-batch-guard';
import {
  inventoryProductBatches,
  stripBatchPermission,
} from './../src/migrations/product-batches';
import { ensureSaleOperationIndex } from './../src/sales/sale-operation-index';
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

/**
 * E2E — lots de produits, lot A (structure, réceptions, reprise du stock) :
 * fonctionnalité désactivée par défaut, garde MongoDB, reprise exacte et
 * idempotente, réceptions (nouvelles, existantes, répétées, concurrentes),
 * modification d'identité, protection des ventes et ajustements, absence
 * de régression sur les produits ordinaires, permissions, invitations,
 * isolation et outils de retour arrière.
 *
 * MongoMemoryReplSet (vraies transactions), AppModule réelle.
 */

const TEST_JWT_SECRET = 'product-batches-e2e-only-secret';
const PASSWORD = 'product-batches-pw-!1x';

let uuidSeq = 0;
/** UUID v4 déterministe et unique pour la suite. */
function uuid(): string {
  uuidSeq += 1;
  const hex = uuidSeq.toString(16).padStart(12, '0');
  return `0b0b0b0b-0b0b-4b0b-8b0b-${hex}`;
}

describe('E2E — lots de produits (lot A)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<SectionDocument>;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;
  let batchModel: Model<ProductBatchDocument>;
  let seq = 0;
  const emailSender = createE2eEmailSender();

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
    const email = `${label}-${seq}-batches@pb.test`;
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
    const email = `member-${seq}-batches@pb.test`;
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

  const raw = (id: string) => productModel.findById(id).lean().exec();
  const sell = (token: string, productId: string, quantity: number) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice: 400 });
  const enable = (token: string, id: string, body: Record<string, unknown>) =>
    http()
      .post(`/products/${id}/batch-tracking`)
      .set(auth(token))
      .send({ clientOperationId: uuid(), ...body });
  const receiveNew = (
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) =>
    http()
      .post(`/products/${id}/batches`)
      .set(auth(token))
      .send({ clientOperationId: uuid(), ...body });
  const receiveExisting = (
    token: string,
    id: string,
    batchId: string,
    body: Record<string, unknown>,
  ) =>
    http()
      .post(`/products/${id}/batches/${batchId}/receptions`)
      .set(auth(token))
      .send({ clientOperationId: uuid(), ...body });
  const list = (token: string, id: string) =>
    http().get(`/products/${id}/batches`).set(auth(token));
  const batchesOf = (id: string) =>
    batchModel
      .find({ productId: new Types.ObjectId(id) })
      .sort({ reference: 1 })
      .lean()
      .exec();
  const sumOf = async (id: string) =>
    (await batchesOf(id)).reduce((s, b) => s + b.remainingQuantity, 0);
  const audits = (id: string, action: AuditAction) =>
    auditModel
      .find({ productId: new Types.ObjectId(id), action })
      .lean()
      .exec();

  /** Produit de 40 unités dont 12 vendues par l'API (28 restantes). */
  async function productWithHistory(
    o: { orgId: string; sectionId: string; token: string },
    extra = {},
  ) {
    const id = await seedProduct(o.orgId, o.sectionId, 40, extra);
    const sale = await sell(o.token, id, 12);
    expect(sale.status).toBe(201);
    return { id, saleId: sale.body._id as string };
  }

  /** Invariants : somme des lots = stock = total suivi ; jamais négatif. */
  async function expectConsistent(id: string) {
    const product = await raw(id);
    const batches = await batchesOf(id);
    expect(batches.every((b) => b.remainingQuantity >= 0)).toBe(true);
    expect(await sumOf(id)).toBe(product?.remainingQuantity);
    expect(product?.batchTracking?.totalQuantity).toBe(
      product?.remainingQuantity,
    );
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
      process.env.CORS_ORIGIN = 'https://product-batches-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.product-batches-e2e.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      delete process.env.PRODUCT_BATCHES_ENABLED;
      // Portée explicite : activation générale (`all`) quand le drapeau
      // est mis à `true` dans les scénarios.
      process.env.PRODUCT_BATCHES_ORGANIZATIONS = 'all';

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

      connection = moduleFixture.get(getConnectionToken());
      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      sectionModel = moduleFixture.get(getModelToken(Section.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
      auditModel = moduleFixture.get(getModelToken(AuditLog.name));
      batchModel = moduleFixture.get(getModelToken(ProductBatch.name));
      await ensureSaleOperationIndex(connection);
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => clearThrottle());

  afterAll(async () => {
    delete process.env.PRODUCT_BATCHES_ENABLED;
    delete process.env.PRODUCT_BATCHES_ORGANIZATIONS;
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Désactivée par défaut, garde obligatoire', () => {
    it('sans drapeau : routes refusées (403 PRODUCT_BATCHES_DISABLED), contexte sans la fonctionnalité, rien écrit', async () => {
      const o = await registerOwner('disabled');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      const context = await http().get('/auth/context').set(auth(o.token));
      expect(context.body.features).toEqual({
        productBatches: false,
        expiryAlerts: false,
      });
      for (const res of [
        await list(o.token, id),
        await enable(o.token, id, {
          expectedRemainingQuantity: 10,
          batches: [{ quantity: 10 }],
        }),
        await receiveNew(o.token, id, { quantity: 1 }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PRODUCT_BATCHES_DISABLED');
      }
      expect((await raw(id))?.stockTracking).toBeUndefined();
      expect(await batchModel.countDocuments({})).toBe(0);
    });

    it('drapeau activé sans validateur ni index : activation refusée (503), rien écrit', async () => {
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
      const o = await registerOwner('no-guard');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      const context = await http().get('/auth/context').set(auth(o.token));
      expect(context.body.features).toEqual({
        productBatches: true,
        expiryAlerts: false,
      });
      const res = await enable(o.token, id, {
        expectedRemainingQuantity: 10,
        batches: [{ quantity: 10 }],
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PRODUCT_BATCH_GUARD_MISSING');
      expect((await raw(id))?.stockTracking).toBeUndefined();
      expect(await ensureProductBatchGuard(connection)).toBe('installed');
      expect(await ensureProductBatchGuard(connection)).toBe('already-present');
    });
  });

  describe('2. Reprise du stock existant', () => {
    beforeAll(() => {
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
    });

    it('28 unités → 8 + 20 : total inchangé, aucune vente ni entrée, initialQuantity inchangé, date historique conservée', async () => {
      const o = await registerOwner('opening');
      const { id } = await productWithHistory(o, { expiryDate: '2026-12-31' });
      const salesBefore = await saleModel.countDocuments({
        productId: new Types.ObjectId(id),
      });
      const body = {
        clientOperationId: uuid(),
        expectedRemainingQuantity: 28,
        batches: [
          { quantity: 8, expiryDate: '2026-11-30', manufacturerLot: 'FAB-A' },
          { quantity: 20, expiryDate: '2026-11-30' },
        ],
      };
      const res = await http()
        .post(`/products/${id}/batch-tracking`)
        .set(auth(o.token))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body.stockTracking).toBe('batches');
      // Même date : deux lots distincts, jamais fusionnés.
      expect(
        res.body.batches.map((b: { reference: string }) => b.reference),
      ).toEqual(['L-001', 'L-002']);
      expect(res.body.totalQuantity).toBe(28);
      expect(res.body.legacyExpiryDate).toBe('2026-12-31');
      const doc = await raw(id);
      expect(doc?.remainingQuantity).toBe(28);
      expect(doc?.initialQuantity).toBe(40);
      expect(doc).not.toHaveProperty('expiryDate');
      expect(doc?.batchTracking?.legacyExpiryDate).toBe('2026-12-31');
      await expectConsistent(id);
      expect(
        await saleModel.countDocuments({ productId: new Types.ObjectId(id) }),
      ).toBe(salesBefore);
      expect(await audits(id, AuditAction.STOCK_CHANGED)).toHaveLength(0);
      const [opening] = await audits(id, AuditAction.BATCH_TRACKING_ENABLED);
      expect(opening.details).toMatchObject({
        totalQuantity: 28,
        legacyExpiryDate: '2026-12-31',
      });

      // Fiche : plus de date unique, mode exposé à tous.
      const product = await http().get(`/products/${id}`).set(auth(o.token));
      expect(product.body.product.stockTracking).toBe('batches');
      expect(product.body.product.expiryDate).toBeNull();
      expect(product.body.product.initialQuantity).toBe(40);

      // Rejeu (relance réseau) : même résultat, rien de plus.
      const again = await http()
        .post(`/products/${id}/batch-tracking`)
        .set(auth(o.token))
        .send(body);
      expect(again.status).toBe(201);
      expect(again.body.replayed).toBe(true);
      expect(await batchesOf(id)).toHaveLength(2);
      // Même clé, autre répartition : refus.
      const reused = await http()
        .post(`/products/${id}/batch-tracking`)
        .set(auth(o.token))
        .send({ ...body, batches: [{ quantity: 28 }] });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // Nouvelle clé : déjà activé.
      const twice = await enable(o.token, id, {
        expectedRemainingQuantity: 28,
        batches: [{ quantity: 28 }],
      });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('BATCH_TRACKING_ALREADY_ENABLED');
    });

    it('répartition inconnue : un seul « lot historique, date inconnue »', async () => {
      const o = await registerOwner('opening-unknown');
      const { id } = await productWithHistory(o);
      const res = await enable(o.token, id, {
        expectedRemainingQuantity: 28,
        batches: [{ quantity: 28 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.batches).toEqual([
        expect.objectContaining({
          reference: 'L-001',
          expiryDate: null,
          receivedOn: null,
          expiryState: 'unknown',
          origin: 'opening',
          remainingQuantity: 28,
        }),
      ]);
      expect(res.body.hasUnknownExpiry).toBe(true);
      await expectConsistent(id);
    });

    it('somme incorrecte (400) ou stock modifié entre-temps (409) : refus propre, rien écrit', async () => {
      const o = await registerOwner('opening-refused');
      const { id } = await productWithHistory(o);
      const wrong = await enable(o.token, id, {
        expectedRemainingQuantity: 28,
        batches: [{ quantity: 8 }, { quantity: 19 }],
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('BATCH_ALLOCATION_MISMATCH');
      // Une vente a lieu après l'affichage de la répartition.
      expect((await sell(o.token, id, 1)).status).toBe(201);
      const stale = await enable(o.token, id, {
        expectedRemainingQuantity: 28,
        batches: [{ quantity: 8 }, { quantity: 20 }],
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('BATCH_STOCK_CHANGED');
      const doc = await raw(id);
      expect(doc?.stockTracking).toBeUndefined();
      expect(doc?.remainingQuantity).toBe(27);
      expect(await batchesOf(id)).toHaveLength(0);
      expect(await audits(id, AuditAction.BATCH_TRACKING_ENABLED)).toHaveLength(
        0,
      );
    });

    it('quantités et dates invalides : 400', async () => {
      const o = await registerOwner('opening-invalid');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      for (const batches of [
        [{ quantity: 0 }, { quantity: 10 }],
        [{ quantity: -1 }, { quantity: 11 }],
        [{ quantity: 2.5 }, { quantity: 7.5 }],
        [{ quantity: 'dix' }],
        [{ quantity: 10, expiryDate: '2026-02-30' }],
        [{ quantity: 10, expiryDate: '2026-10-17T00:00:00Z' }],
        [{ quantity: 10, receivedOn: '2999-01-01' }],
      ]) {
        const res = await enable(o.token, id, {
          expectedRemainingQuantity: 10,
          batches,
        });
        expect(res.status).toBe(400);
      }
      expect((await raw(id))?.stockTracking).toBeUndefined();
    });
  });

  describe('3. Réceptions et identité', () => {
    let owner: { orgId: string; sectionId: string; token: string };
    let id: string;
    let firstBatch: string;

    beforeAll(async () => {
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
      owner = await registerOwner('reception');
      id = (await productWithHistory(owner)).id;
      const res = await enable(owner.token, id, {
        expectedRemainingQuantity: 28,
        batches: [
          { quantity: 8, expiryDate: '2026-11-30' },
          { quantity: 20, expiryDate: '2027-01-31' },
        ],
      });
      expect(res.status).toBe(201);
      firstBatch = res.body.batches[0]._id as string;
    });

    it('nouveau lot : entrée de stock (initial et restant), référence suivante, journal', async () => {
      const res = await receiveNew(owner.token, id, {
        quantity: 5,
        expiryDate: '2027-03-31',
        manufacturerLot: '  FAB-77  ',
      });
      expect(res.status).toBe(201);
      const created = res.body.batches.find(
        (b: { _id: string }) => b._id === res.body.batchId,
      );
      expect(created).toMatchObject({
        reference: 'L-003',
        manufacturerLot: 'FAB-77',
        expiryDate: '2027-03-31',
        receivedOn: res.body.businessDate,
        origin: 'reception',
        remainingQuantity: 5,
      });
      const doc = await raw(id);
      expect(doc?.remainingQuantity).toBe(33);
      expect(doc?.initialQuantity).toBe(45);
      await expectConsistent(id);
      expect(
        (await audits(id, AuditAction.BATCH_RECEIVED)).some(
          (a) => a.details.reference === 'L-003' && a.details.added === 5,
        ),
      ).toBe(true);
    });

    it('lot existant désigné : quantité seule, date et numéro jamais remplacés', async () => {
      const before = await batchModel.findById(firstBatch).lean();
      const res = await receiveExisting(owner.token, id, firstBatch, {
        quantity: 3,
      });
      expect(res.status).toBe(201);
      const after = await batchModel.findById(firstBatch).lean();
      expect(after?.remainingQuantity).toBe(
        (before?.remainingQuantity ?? 0) + 3,
      );
      expect(after?.expiryDate).toBe(before?.expiryDate);
      expect(after?.manufacturerLot).toBe(before?.manufacturerLot);
      // Tentative de remplacer l'identité par une réception : refusée.
      for (const extra of [
        { expiryDate: '2030-01-01' },
        { manufacturerLot: 'X' },
        { receivedOn: '2026-01-01' },
      ]) {
        const refused = await receiveExisting(owner.token, id, firstBatch, {
          quantity: 1,
          ...extra,
        });
        expect(refused.status).toBe(400);
      }
      for (const quantity of [0, -2, 1.5, null]) {
        const refused = await receiveExisting(owner.token, id, firstBatch, {
          quantity,
        });
        expect(refused.status).toBe(400);
      }
      expect((await batchModel.findById(firstBatch).lean())?.expiryDate).toBe(
        before?.expiryDate,
      );
      await expectConsistent(id);
    });

    it('même réception répétée (relance réseau) : appliquée une seule fois', async () => {
      const before = (await raw(id))?.remainingQuantity ?? 0;
      const body = { clientOperationId: uuid(), quantity: 4 };
      const url = `/products/${id}/batches/${firstBatch}/receptions`;
      const first = await http().post(url).set(auth(owner.token)).send(body);
      const second = await http().post(url).set(auth(owner.token)).send(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.replayed).toBe(true);
      expect((await raw(id))?.remainingQuantity).toBe(before + 4);
      // Même clé, autre quantité : refus.
      const reused = await http()
        .post(url)
        .set(auth(owner.token))
        .send({ ...body, quantity: 5 });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // Même clé rejouée par un autre membre : refus sans donnée.
      const other = await seedMember(owner.orgId, ['stock.adjust']);
      const foreign = await http().post(url).set(auth(other.token)).send(body);
      expect(foreign.status).toBe(409);
      expect(foreign.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      await expectConsistent(id);
    });

    it('réceptions concurrentes (clés distinctes) et rejeux concurrents (même clé) : aucune perte ni doublon', async () => {
      const before = (await raw(id))?.remainingQuantity ?? 0;
      const distinct = await Promise.all(
        Array.from({ length: 6 }, () =>
          receiveExisting(owner.token, id, firstBatch, { quantity: 1 }),
        ),
      );
      expect(distinct.every((r) => r.status === 201)).toBe(true);
      const newBatches = await Promise.all(
        Array.from({ length: 3 }, () =>
          receiveNew(owner.token, id, { quantity: 2 }),
        ),
      );
      expect(newBatches.every((r) => r.status === 201)).toBe(true);
      const body = { clientOperationId: uuid(), quantity: 10 };
      const same = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post(`/products/${id}/batches/${firstBatch}/receptions`)
            .set(auth(owner.token))
            .send(body),
        ),
      );
      expect(same.every((r) => r.status === 201)).toBe(true);
      expect(same.filter((r) => r.body.replayed === false)).toHaveLength(1);
      expect((await raw(id))?.remainingQuantity).toBe(before + 6 + 6 + 10);
      // Références uniques et consécutives malgré la concurrence.
      const references = (await batchesOf(id)).map((b) => b.reference);
      expect(new Set(references).size).toBe(references.length);
      await expectConsistent(id);
    });

    it('modification d’identité : historique, aucune quantité ni réception', async () => {
      const before = await batchModel.findById(firstBatch).lean();
      const receptions = (await audits(id, AuditAction.BATCH_RECEIVED)).length;
      const res = await http()
        .patch(`/products/${id}/batches/${firstBatch}`)
        .set(auth(owner.token))
        .send({ expiryDate: '2026-12-15', manufacturerLot: 'FAB-B' });
      expect(res.status).toBe(200);
      const after = await batchModel.findById(firstBatch).lean();
      expect(after?.expiryDate).toBe('2026-12-15');
      expect(after?.manufacturerLot).toBe('FAB-B');
      expect(after?.remainingQuantity).toBe(before?.remainingQuantity);
      expect((await audits(id, AuditAction.BATCH_RECEIVED)).length).toBe(
        receptions,
      );
      const [change] = await audits(id, AuditAction.BATCH_UPDATED);
      expect(change.details).toMatchObject({
        changes: {
          expiryDate: { from: before?.expiryDate, to: '2026-12-15' },
          manufacturerLot: { from: null, to: 'FAB-B' },
        },
      });
      // Même valeur renvoyée : aucune écriture ni journal.
      await http()
        .patch(`/products/${id}/batches/${firstBatch}`)
        .set(auth(owner.token))
        .send({ expiryDate: '2026-12-15' });
      expect(await audits(id, AuditAction.BATCH_UPDATED)).toHaveLength(1);
      // Champ de quantité refusé.
      expect(
        (
          await http()
            .patch(`/products/${id}/batches/${firstBatch}`)
            .set(auth(owner.token))
            .send({ remainingQuantity: 999 })
        ).status,
      ).toBe(400);
      // Historique conservé : toutes les entrées précédentes restent.
      expect(await audits(id, AuditAction.BATCH_TRACKING_ENABLED)).toHaveLength(
        1,
      );
      await expectConsistent(id);
    });
  });

  describe('4. Protection des opérations incompatibles', () => {
    beforeAll(() => {
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
    });

    it('ventes sans lots (en ligne et outbox), corrections et annulations sans lots précisés, ajout de stock et date de fiche : 409, rien écrit', async () => {
      const o = await registerOwner('protect');
      const { id, saleId } = await productWithHistory(o);
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 28,
            batches: [{ quantity: 28 }],
          })
        ).status,
      ).toBe(201);
      const salesBefore = await saleModel.countDocuments({
        productId: new Types.ObjectId(id),
      });
      const refused = [
        await sell(o.token, id, 1),
        // Outbox hors ligne (y compris une version antérieure du web).
        await http().post('/sales').set(auth(o.token)).send({
          productId: id,
          quantity: 1,
          salePrice: 400,
          clientOperationId: uuid(),
        }),
        await http()
          .patch(`/sales/${saleId}`)
          .set(auth(o.token))
          .send({ quantity: 10 }),
        await http().delete(`/sales/${saleId}`).set(auth(o.token)),
        await http()
          .patch(`/products/${id}`)
          .set(auth(o.token))
          .send({ additionalStock: 5 }),
        await http()
          .patch(`/products/${id}`)
          .set(auth(o.token))
          .send({ expiryDate: '2027-01-01' }),
      ];
      // Lot B : refus précis et compréhensibles (client antérieur sans
      // affectation, vente antérieure à l'activation sans restitution
      // explicite) ; réassort et date de fiche restent refusés.
      expect(refused.map((res) => [res.status, res.body.code])).toEqual([
        [409, 'SALE_BATCH_ALLOCATION_REQUIRED'],
        [409, 'SALE_BATCH_ALLOCATION_REQUIRED'],
        [409, 'SALE_BATCH_RESTITUTION_REQUIRED'],
        [409, 'SALE_BATCH_RESTITUTION_REQUIRED'],
        [409, 'PRODUCT_BATCH_TRACKED'],
        [409, 'PRODUCT_BATCH_TRACKED'],
      ]);
      expect(
        await saleModel.countDocuments({ productId: new Types.ObjectId(id) }),
      ).toBe(salesBefore);
      expect(await saleModel.findById(saleId).lean()).toMatchObject({
        quantity: 12,
      });
      const doc = await raw(id);
      expect(doc?.remainingQuantity).toBe(28);
      expect(doc?.initialQuantity).toBe(40);
      await expectConsistent(id);

      // Compatibles : prix d'une vente, nom de la fiche.
      expect(
        (
          await http()
            .patch(`/sales/${saleId}`)
            .set(auth(o.token))
            .send({ salePrice: 450 })
        ).status,
      ).toBe(200);
      expect(
        (
          await http()
            .patch(`/products/${id}`)
            .set(auth(o.token))
            .send({ name: `Renommé ${seq}` })
        ).status,
      ).toBe(200);
      await expectConsistent(id);
    });

    it('garde MongoDB : une écriture qui ignore les lots (ancienne API) est refusée par la base', async () => {
      const o = await registerOwner('db-guard');
      const tracked = await seedProduct(o.orgId, o.sectionId, 10);
      expect(
        (
          await enable(o.token, tracked, {
            expectedRemainingQuantity: 10,
            batches: [{ quantity: 10 }],
          })
        ).status,
      ).toBe(201);
      const products = connection.collection('products');
      const oid = new Types.ObjectId(tracked);
      // Ancienne vente (`decrementStock` antérieur) et ancien réassort.
      await expect(
        products.updateOne(
          { _id: oid, remainingQuantity: { $gte: 1 } },
          { $inc: { remainingQuantity: -1 } },
        ),
      ).rejects.toMatchObject({ code: 121 });
      await expect(
        products.updateOne(
          { _id: oid },
          { $inc: { remainingQuantity: 5, initialQuantity: 5 } },
        ),
      ).rejects.toMatchObject({ code: 121 });
      // Ancien `adjustStock` (lecture puis `save()`).
      const doc = await productModel.findById(tracked).exec();
      doc!.remainingQuantity = 12;
      await expect(doc!.save()).rejects.toMatchObject({ code: 121 });
      // Écritures compatibles d'une ancienne API (nom, corbeille) : permises.
      await products.updateOne({ _id: oid }, { $set: { name: 'Ancien' } });
      expect((await raw(tracked))?.remainingQuantity).toBe(10);
      await expectConsistent(tracked);
    });

    it('produits ordinaires inchangés (garde installée) : vente, correction, annulation, réassort, date', async () => {
      const o = await registerOwner('ordinary');
      const { id, saleId } = await productWithHistory(o);
      expect((await sell(o.token, id, 2)).status).toBe(201);
      expect(
        (
          await http()
            .patch(`/sales/${saleId}`)
            .set(auth(o.token))
            .send({ quantity: 10 })
        ).status,
      ).toBe(200);
      expect(
        (await http().delete(`/sales/${saleId}`).set(auth(o.token))).status,
      ).toBe(204);
      const restock = await http()
        .patch(`/products/${id}`)
        .set(auth(o.token))
        .send({ additionalStock: 5, expiryDate: '2027-05-01' });
      expect(restock.status).toBe(200);
      expect(restock.body.product).toMatchObject({
        stockTracking: 'none',
        expiryDate: '2027-05-01',
      });
      const doc = await raw(id);
      // 40 − 12 − 2 (+12 annulée) + 5.
      expect(doc?.remainingQuantity).toBe(43);
      expect(doc?.initialQuantity).toBe(45);
      expect(doc?.stockTracking).toBeUndefined();
      expect(doc?.batchTracking).toBeUndefined();
    });
  });

  describe('5. Permissions, quantités visibles et isolation', () => {
    beforeAll(() => {
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
    });

    it('matrice des droits : chaque opération exige ses permissions, refus sans écriture', async () => {
      const o = await registerOwner('rights');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      const opening = {
        expectedRemainingQuantity: 10,
        batches: [{ quantity: 10, expiryDate: '2027-01-01' }],
      };
      const seller = await seedMember(o.orgId);
      const adjuster = await seedMember(o.orgId, ['stock.adjust']);
      const manager = await seedMember(o.orgId, [
        'products.manage',
        'stock.adjust',
      ]);
      const batchesOnly = await seedMember(o.orgId, ['stock.manage_batches']);
      expect((await enable(seller.token, id, opening)).status).toBe(403);
      expect((await enable(adjuster.token, id, opening)).status).toBe(403);
      // Dates sans `products.manage_expiry` : refus.
      expect((await enable(batchesOnly.token, id, opening)).status).toBe(403);
      expect((await raw(id))?.stockTracking).toBeUndefined();
      const ok = await enable(batchesOnly.token, id, {
        expectedRemainingQuantity: 10,
        batches: [{ quantity: 10 }],
      });
      expect(ok.status).toBe(201);
      const batchId = ok.body.batches[0]._id as string;

      // Réception dans un lot existant : `stock.adjust` suffit.
      expect(
        (await receiveExisting(seller.token, id, batchId, { quantity: 1 }))
          .status,
      ).toBe(403);
      expect(
        (await receiveExisting(adjuster.token, id, batchId, { quantity: 1 }))
          .status,
      ).toBe(201);
      // Nouveau lot : identité (`products.manage`) + entrée (`stock.adjust`).
      expect(
        (await receiveNew(adjuster.token, id, { quantity: 1 })).status,
      ).toBe(403);
      expect(
        (await receiveNew(manager.token, id, { quantity: 1 })).status,
      ).toBe(201);
      expect(
        (
          await receiveNew(manager.token, id, {
            quantity: 1,
            expiryDate: '2027-02-01',
          })
        ).status,
      ).toBe(403);
      // Identité : `products.manage` ; date : + `products.manage_expiry`.
      const patch = (token: string, body: object) =>
        http()
          .patch(`/products/${id}/batches/${batchId}`)
          .set(auth(token))
          .send(body);
      expect(
        (await patch(adjuster.token, { manufacturerLot: 'X' })).status,
      ).toBe(403);
      expect(
        (await patch(manager.token, { manufacturerLot: 'X' })).status,
      ).toBe(200);
      expect((await patch(manager.token, { expiryDate: null })).status).toBe(
        403,
      );
      // Activation déjà faite : `stock.manage_batches` n'ouvre pas les réceptions.
      expect(
        (await receiveExisting(batchesOnly.token, id, batchId, { quantity: 1 }))
          .status,
      ).toBe(403);
      await expectConsistent(id);
    });

    it('quantités des lots seulement avec products.view_stock_details', async () => {
      const o = await registerOwner('visibility');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      await enable(o.token, id, {
        expectedRemainingQuantity: 10,
        batches: [{ quantity: 4 }, { quantity: 6, expiryDate: '2027-01-01' }],
      });
      const seller = await seedMember(o.orgId);
      const viewer = await seedMember(o.orgId, ['products.view_stock_details']);
      const hidden = await list(seller.token, id);
      expect(hidden.status).toBe(200);
      expect(hidden.body).not.toHaveProperty('totalQuantity');
      for (const batch of hidden.body.batches as object[]) {
        expect(batch).not.toHaveProperty('remainingQuantity');
      }
      expect(hidden.body.nextExpiryDate).toBe('2027-01-01');
      // Journal (si `audit.read`) : répartition masquée sans le droit.
      const auditor = await seedMember(o.orgId, ['audit.read']);
      const detail = await http()
        .get(`/products/${id}`)
        .set(auth(auditor.token));
      const opening = (
        detail.body.auditLogs as Array<{ action: string; details: object }>
      ).find((l) => l.action === 'batch_tracking_enabled');
      expect(opening?.details).not.toHaveProperty('allocations');
      expect(opening?.details).not.toHaveProperty('totalQuantity');
      const shown = await list(viewer.token, id);
      expect(shown.body.totalQuantity).toBe(10);
      expect(
        (shown.body.batches as Array<{ remainingQuantity: number }>).map(
          (b) => b.remainingQuantity,
        ),
      ).toEqual([6, 4]);
    });

    it('isolation : produit ou lot d’un autre commerce indistinguable d’un absent (404)', async () => {
      const a = await registerOwner('iso-a');
      const b = await registerOwner('iso-b');
      const idA = await seedProduct(a.orgId, a.sectionId, 5);
      const res = await enable(a.token, idA, {
        expectedRemainingQuantity: 5,
        batches: [{ quantity: 5 }],
      });
      const batchA = res.body.batches[0]._id as string;
      expect((await list(b.token, idA)).status).toBe(404);
      expect(
        (
          await enable(b.token, idA, {
            expectedRemainingQuantity: 5,
            batches: [{ quantity: 5 }],
          })
        ).status,
      ).toBe(404);
      expect((await receiveNew(b.token, idA, { quantity: 1 })).status).toBe(
        404,
      );
      expect(
        (await receiveExisting(b.token, idA, batchA, { quantity: 1 })).status,
      ).toBe(404);
      // Lot de A désigné sur un produit de B : 404.
      const idB = await seedProduct(b.orgId, b.sectionId, 3);
      await enable(b.token, idB, {
        expectedRemainingQuantity: 3,
        batches: [{ quantity: 3 }],
      });
      expect(
        (await receiveExisting(b.token, idB, batchA, { quantity: 1 })).status,
      ).toBe(404);
      expect(
        (
          await http()
            .patch(`/products/${idB}/batches/${batchA}`)
            .set(auth(b.token))
            .send({ manufacturerLot: 'X' })
        ).status,
      ).toBe(404);
      expect((await raw(idA))?.remainingQuantity).toBe(5);
      await expectConsistent(idA);
      await expectConsistent(idB);
    });

    it('invitations et membres : délégation explicite, catalogue 3 conserve, catalogue 4 retire, admin par défaut', async () => {
      const o = await registerOwner('invite');
      const email = `invitee-${++seq}@pb.test`;
      const invite = await http()
        .post('/organizations/invitations')
        .set(auth(o.token))
        .send({
          email,
          role: 'seller',
          permissions: ['stock.manage_batches'],
        });
      expect(invite.status).toBe(201);
      const created = await createInvitedAccount(
        server(),
        emailSender,
        new URL(String(invite.body.invitationUrl)).searchParams.get('token') ??
          '',
        email,
        { name: 'Invité', password: PASSWORD },
      );
      expect([200, 201]).toContain(created.status);
      const invitedToken = await login(email);
      const context = await http().get('/auth/context').set(auth(invitedToken));
      expect(context.body.effectivePermissions).toContain(
        'stock.manage_batches',
      );
      expect(context.body.effectivePermissions).not.toContain('stock.adjust');

      // Vendeur à droits partiels : jamais par défaut.
      const plain = await seedMember(o.orgId, ['products.manage']);
      const plainContext = await http()
        .get('/auth/context')
        .set(auth(plain.token));
      expect(plainContext.body.effectivePermissions).not.toContain(
        'stock.manage_batches',
      );
      // Administrateur : par son rôle.
      const admin = await seedMember(o.orgId, [], OrganizationRole.ADMIN);
      const adminContext = await http()
        .get('/auth/context')
        .set(auth(admin.token));
      expect(adminContext.body.effectivePermissions).toContain(
        'stock.manage_batches',
      );
      // Anti-escalade : un délégué `members.invite` sans le droit ne l'accorde pas.
      const inviter = await seedMember(o.orgId, ['members.invite']);
      expect(
        (
          await http()
            .post('/organizations/invitations')
            .set(auth(inviter.token))
            .send({
              email: `x-${++seq}@pb.test`,
              role: 'seller',
              permissions: ['stock.manage_batches'],
            })
        ).status,
      ).toBe(403);

      const member = await seedMember(o.orgId, [
        'products.manage',
        'stock.manage_batches',
      ]);
      const patchMember = (
        permissions: DelegablePermission[],
        catalog: number,
      ) =>
        http()
          .patch(`/organizations/members/${member.membershipId}`)
          .query({ permissionsCatalog: String(catalog) })
          .set(auth(o.token))
          .send({ permissions });
      const stored = async () =>
        (await membershipModel.findById(member.membershipId).lean())
          ?.permissions;
      // Formulaire sans la fonctionnalité (catalogue 3) : conservée.
      expect((await patchMember(['products.manage'], 3)).status).toBe(200);
      expect(await stored()).toEqual(
        expect.arrayContaining(['products.manage', 'stock.manage_batches']),
      );
      // Formulaire avec la fonctionnalité (catalogue 4) : retrait explicite.
      expect((await patchMember(['products.manage'], 4)).status).toBe(200);
      expect(await stored()).toEqual(['products.manage']);
    });
  });

  describe('6. Retour arrière', () => {
    it('inventaire en lecture seule ; validateur jamais retiré sous un stock réparti ; retrait de la permission', async () => {
      const before = await inventoryProductBatches(connection);
      expect(before.trackedProducts).toBeGreaterThan(0);
      expect(before.guard).toBe('installée');
      expect(await inventoryProductBatches(connection)).toEqual(before);
      await expect(removeProductBatchValidator(connection)).rejects.toThrow(
        /suivi\(s\) par lots/,
      );
      const o = await registerOwner('rollback');
      await seedMember(o.orgId, ['stock.manage_batches']);
      const removed = await stripBatchPermission(connection);
      expect(removed.memberships).toBeGreaterThanOrEqual(1);
      expect(
        (await inventoryProductBatches(connection)).permission.memberships,
      ).toBe(0);
    });
  });
});
