import 'reflect-metadata';
import { createECDH, randomBytes } from 'crypto';
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
import { businessDate } from './../src/products/batches/business-date';
import { ensureSaleOperationIndex } from './../src/sales/sale-operation-index';
import { PushRuntime } from './../src/push/push-runtime';
import { PushDispatcherService } from './../src/push/push-dispatcher.service';
import { ensurePushIndexes } from './../src/push/push-indexes';
import type {
  PushSendOptions,
  PushSendResult,
  PushTarget,
  PushTransport,
} from './../src/push/push-transport';
import type { PushMessagePayload } from './../src/push/push-messages';
import { PushJob } from './../src/push/schemas/push-job.schema';
import { PushCategory } from './../src/push/schemas/push-category';
import type { PushJobDocument } from './../src/push/schemas/push-job.schema';
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
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E — lots de produits, lot B (ventes, corrections, annulations, hors
 * ligne) : ventes réparties, FEFO, lots dépassés / sans date / épuisés /
 * étrangers, concurrence et rejeux, corrections et annulations exactes,
 * ventes antérieures à l'activation, permissions et visibilité, règle
 * temporelle des ventes synchronisées après péremption, anciens clients,
 * corbeille et purge. Invariant vérifié après chaque scénario : somme des
 * lots = stock de la fiche = total suivi ; `initialQuantity` inchangée.
 *
 * MongoMemoryReplSet (vraies transactions), AppModule réelle.
 */

/** Faux transport push (aucun réseau) : enregistre les envois. */
class FakePushTransport implements PushTransport {
  readonly sent: { endpoint: string; payload: PushMessagePayload }[] = [];
  to(endpoint: string) {
    return this.sent.filter((s) => s.endpoint === endpoint);
  }
  send(
    target: PushTarget,
    payload: string,
    _options: PushSendOptions,
  ): Promise<PushSendResult> {
    void _options;
    this.sent.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as PushMessagePayload,
    });
    return Promise.resolve({ statusCode: 201 });
  }
}

function p256() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

const TEST_JWT_SECRET = 'product-batches-sales-e2e-only-secret';
const PASSWORD = 'product-batches-sales-pw-!1x';
const DAY_MS = 24 * 60 * 60 * 1000;

let uuidSeq = 0;
function uuid(): string {
  uuidSeq += 1;
  const hex = uuidSeq.toString(16).padStart(12, '0');
  return `0c0c0c0c-0c0c-4c0c-8c0c-${hex}`;
}

/** Jour civil du commerce décalé de `days` (fuseau du processus). */
function day(days: number): string {
  return businessDate(new Date(Date.now() + days * DAY_MS));
}

describe('E2E — lots de produits (lot B : ventes)', () => {
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
  let jobModel: Model<PushJobDocument>;
  let seq = 0;
  const emailSender = createE2eEmailSender();

  const http = () => request(app.getHttpServer());
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
    const email = `${label}-${seq}-bsales@pb.test`;
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
    const email = `member-${seq}-bsales@pb.test`;
    const user = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `Membre ${seq}`,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
      role: UserRole.SELLER,
    });
    await membershipModel.create({
      organizationId: new Types.ObjectId(orgId),
      userId: user._id,
      role,
      status: MembershipStatus.ACTIVE,
      permissions,
    });
    return { token: await login(email) };
  }

  async function seedProduct(orgId: string, sectionId: string, qty: number) {
    seq += 1;
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: new Types.ObjectId(sectionId),
      name: `Produit ${seq}`,
      imageUrl: 'https://e2e.local/img.png',
      purchasePrice: 100,
      salePrice: 400,
      initialQuantity: qty,
      remainingQuantity: qty,
    });
    return product._id.toHexString();
  }

  const raw = (id: string) => productModel.findById(id).lean().exec();
  const enable = (token: string, id: string, body: Record<string, unknown>) =>
    http()
      .post(`/products/${id}/batch-tracking`)
      .set(auth(token))
      .send({ clientOperationId: uuid(), ...body });
  const sell = (
    token: string,
    productId: string,
    quantity: number,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice: 400, ...extra });
  const options = (token: string, id: string, quantity: number) =>
    http()
      .get(`/products/${id}/batches/sale-options`)
      .query({ quantity })
      .set(auth(token));
  const patchSale = (token: string, id: string, body: object) =>
    http().patch(`/sales/${id}`).set(auth(token)).send(body);
  const cancelSale = (token: string, id: string, body?: object) => {
    const req = http().delete(`/sales/${id}`).set(auth(token));
    return body ? req.send(body) : req;
  };
  const batchesOf = (id: string) =>
    batchModel
      .find({ productId: new Types.ObjectId(id) })
      .sort({ reference: 1 })
      .lean()
      .exec();
  const byRef = async (id: string) =>
    Object.fromEntries((await batchesOf(id)).map((b) => [b.reference, b]));
  const salesOf = (id: string) =>
    saleModel.countDocuments({ productId: new Types.ObjectId(id) });

  /** Somme des lots = stock = total suivi ; jamais négatif ; initial fixe. */
  async function expectConsistent(id: string, initial?: number) {
    const product = await raw(id);
    const batches = await batchesOf(id);
    expect(batches.every((b) => b.remainingQuantity >= 0)).toBe(true);
    const sum = batches.reduce((s, b) => s + b.remainingQuantity, 0);
    expect(sum).toBe(product?.remainingQuantity);
    expect(product?.batchTracking?.totalQuantity).toBe(
      product?.remainingQuantity,
    );
    if (initial !== undefined) {
      expect(product?.initialQuantity).toBe(initial);
    }
  }

  /**
   * Produit de 30 unités réparti : L-001 (5, +10 j), L-002 (10, +3 j),
   * L-003 (8, sans date), L-004 (7, dépassé hier).
   */
  async function trackedProduct(o: {
    orgId: string;
    sectionId: string;
    token: string;
  }) {
    const id = await seedProduct(o.orgId, o.sectionId, 30);
    const res = await enable(o.token, id, {
      expectedRemainingQuantity: 30,
      batches: [
        { quantity: 5, expiryDate: day(10) },
        { quantity: 10, expiryDate: day(3) },
        { quantity: 8 },
        { quantity: 7, expiryDate: day(-1) },
      ],
    });
    expect(res.status).toBe(201);
    const refs = await byRef(id);
    return {
      id,
      a: refs['L-001']._id.toHexString(),
      b: refs['L-002']._id.toHexString(),
      undated: refs['L-003']._id.toHexString(),
      expired: refs['L-004']._id.toHexString(),
    };
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
      process.env.CORS_ORIGIN = 'https://product-batches-sales.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.product-batches-sales.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
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
      jobModel = moduleFixture.get(getModelToken(PushJob.name));
      await ensureSaleOperationIndex(connection);
      await ensurePushIndexes(connection);
      await ensureProductBatchGuard(connection);
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

  describe('1. Vente par lots', () => {
    it('options FEFO : datés valides d’abord, sans date à part, dépassés exclus ; suggestion plafonnée', async () => {
      const o = await registerOwner('fefo');
      const p = await trackedProduct(o);
      const res = await options(o.token, p.id, 12);
      expect(res.status).toBe(200);
      expect(
        res.body.dated.map((b: { reference: string }) => b.reference),
      ).toEqual(['L-002', 'L-001']);
      expect(
        res.body.undated.map((b: { reference: string }) => b.reference),
      ).toEqual(['L-003']);
      expect(res.body.excludedExpiredBatches).toBe(1);
      expect(res.body.suggestion).toEqual([
        { batchId: p.b, quantity: 10 },
        { batchId: p.a, quantity: 2 },
      ]);
      expect(res.body.uncovered).toBe(0);
      expect(res.body.dated[0].remainingQuantity).toBe(10);
      // Au-delà des lots datés : jamais compensé par un lot sans date.
      const big = await options(o.token, p.id, 20);
      expect(big.body.uncovered).toBe(5);
    });

    it('vente répartie sur deux lots : instantané figé sur la vente, lots et fiche décrémentés, initial inchangé', async () => {
      const o = await registerOwner('split');
      const p = await trackedProduct(o);
      const res = await sell(o.token, p.id, 12, {
        batchAllocations: [
          { batchId: p.b, quantity: 10 },
          { batchId: p.a, quantity: 2 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.batchAllocations).toEqual([
        expect.objectContaining({
          batchId: p.b,
          reference: 'L-002',
          expiryDate: day(3),
          quantity: 10,
        }),
        expect.objectContaining({
          batchId: p.a,
          reference: 'L-001',
          quantity: 2,
        }),
      ]);
      expect(res.body.originalBatchAllocations).toHaveLength(2);
      const refs = await byRef(p.id);
      expect(refs['L-002'].remainingQuantity).toBe(0);
      expect(refs['L-001'].remainingQuantity).toBe(3);
      expect((await raw(p.id))?.remainingQuantity).toBe(18);
      await expectConsistent(p.id, 30);
      const [sold] = await auditModel
        .find({ productId: new Types.ObjectId(p.id), action: AuditAction.SOLD })
        .lean();
      expect(sold.details.batches).toEqual([
        expect.objectContaining({ reference: 'L-002', quantity: 10 }),
        expect.objectContaining({ reference: 'L-001', quantity: 2 }),
      ]);
      // L'affectation n'est jamais recalculée depuis les lots courants.
      await batchModel.updateOne(
        { _id: new Types.ObjectId(p.a) },
        { $set: { manufacturerLot: 'CHANGÉ' } },
      );
      const saved = await saleModel.findById(res.body._id).lean();
      expect(saved?.batchAllocations?.[1].manufacturerLot).toBeNull();
    });

    it('refus sans écriture : somme fausse, doublon, dépassé, sans date non confirmé, épuisé, sans affectation', async () => {
      const o = await registerOwner('refusals');
      const p = await trackedProduct(o);
      const cases: [Record<string, unknown>, number, number, string][] = [
        [
          { batchAllocations: [{ batchId: p.a, quantity: 1 }] },
          2,
          400,
          'BATCH_ALLOCATION_MISMATCH',
        ],
        [
          {
            batchAllocations: [
              { batchId: p.a, quantity: 1 },
              { batchId: p.a, quantity: 1 },
            ],
          },
          2,
          400,
          'BATCH_ALLOCATION_MISMATCH',
        ],
        [
          { batchAllocations: [{ batchId: p.expired, quantity: 1 }] },
          1,
          409,
          'BATCH_EXPIRED',
        ],
        [
          { batchAllocations: [{ batchId: p.undated, quantity: 1 }] },
          1,
          409,
          'BATCH_EXPIRY_UNCONFIRMED',
        ],
        [
          { batchAllocations: [{ batchId: p.a, quantity: 6 }] },
          6,
          409,
          'BATCH_INSUFFICIENT',
        ],
        [{}, 1, 409, 'SALE_BATCH_ALLOCATION_REQUIRED'],
        // Transaction annulée : le premier lot n'est jamais décrémenté seul.
        [
          {
            batchAllocations: [
              { batchId: p.b, quantity: 3 },
              { batchId: p.a, quantity: 6 },
            ],
          },
          9,
          409,
          'BATCH_INSUFFICIENT',
        ],
      ];
      for (const [extra, qty, status, code] of cases) {
        const res = await sell(o.token, p.id, qty, {
          clientOperationId: uuid(),
          ...extra,
        });
        expect([res.status, res.body.code]).toEqual([status, code]);
      }
      expect(await salesOf(p.id)).toBe(0);
      const refs = await byRef(p.id);
      expect(refs['L-001'].remainingQuantity).toBe(5);
      expect(refs['L-002'].remainingQuantity).toBe(10);
      expect((await raw(p.id))?.remainingQuantity).toBe(30);
      await expectConsistent(p.id, 30);
      // Lot sans date confirmé explicitement : accepté.
      const ok = await sell(o.token, p.id, 2, {
        batchAllocations: [{ batchId: p.undated, quantity: 2 }],
        unknownExpiryConfirmed: true,
      });
      expect(ok.status).toBe(201);
      await expectConsistent(p.id, 30);
    });

    it('lot d’un autre produit ou d’un autre commerce : indisponible (409), rien écrit', async () => {
      const o = await registerOwner('foreign');
      const p = await trackedProduct(o);
      const q = await trackedProduct(o);
      const other = await registerOwner('foreign-b');
      const r = await trackedProduct(other);
      for (const batchId of [q.a, r.a]) {
        const res = await sell(o.token, p.id, 1, {
          batchAllocations: [{ batchId, quantity: 1 }],
        });
        expect([res.status, res.body.code]).toEqual([409, 'BATCH_UNAVAILABLE']);
      }
      // Produit d'un autre commerce : 404, options comprises.
      expect((await options(other.token, p.id, 1)).status).toBe(404);
      const cross = await sell(other.token, p.id, 1, {
        batchAllocations: [{ batchId: p.a, quantity: 1 }],
      });
      expect(cross.status).toBe(404);
      for (const id of [p.id, q.id, r.id]) await expectConsistent(id, 30);
    });

    it('produit ordinaire : une affectation est refusée, la vente sans lots inchangée', async () => {
      const o = await registerOwner('ordinary');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      const refused = await sell(o.token, id, 1, {
        batchAllocations: [
          { batchId: new Types.ObjectId().toHexString(), quantity: 1 },
        ],
      });
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'BATCH_TRACKING_NOT_ENABLED',
      ]);
      expect((await sell(o.token, id, 2)).status).toBe(201);
      const doc = await raw(id);
      expect(doc?.remainingQuantity).toBe(8);
      expect(doc?.stockTracking).toBeUndefined();
    });
  });

  describe('2. Concurrence et idempotence', () => {
    it('ventes concurrentes sur un lot de 5 : exactement 5 acceptées, aucune quantité négative', async () => {
      const o = await registerOwner('race');
      const p = await trackedProduct(o);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          sell(o.token, p.id, 1, {
            clientOperationId: uuid(),
            batchAllocations: [{ batchId: p.a, quantity: 1 }],
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(5);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect([r.status, r.body.code]).toEqual([409, 'BATCH_INSUFFICIENT']);
      }
      expect((await byRef(p.id))['L-001'].remainingQuantity).toBe(0);
      expect(await salesOf(p.id)).toBe(5);
      await expectConsistent(p.id, 30);
    });

    it('rejeux (séquentiels et concurrents) d’une même vente : un seul décrément', async () => {
      const o = await registerOwner('replay');
      const p = await trackedProduct(o);
      const key = uuid();
      const body = {
        clientOperationId: key,
        occurredAt: new Date().toISOString(),
        batchAllocations: [{ batchId: p.b, quantity: 3 }],
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => sell(o.token, p.id, 3, body)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body._id)).size).toBe(1);
      const again = await sell(o.token, p.id, 3, body);
      expect(again.body._id).toBe(results[0].body._id);
      // Même clé, autre affectation : conflit d'idempotence, jamais appliqué.
      const reused = await sell(o.token, p.id, 3, {
        ...body,
        batchAllocations: [{ batchId: p.a, quantity: 3 }],
      });
      expect([reused.status, reused.body.code]).toEqual([
        409,
        'IDEMPOTENCY_KEY_REUSED',
      ]);
      expect((await byRef(p.id))['L-002'].remainingQuantity).toBe(7);
      expect(await salesOf(p.id)).toBe(1);
      await expectConsistent(p.id, 30);
    });
  });

  describe('3. Corrections et annulations', () => {
    it('prix seul, diminution précisée, augmentation affectée, échange de lot : historique avant / après', async () => {
      const o = await registerOwner('fix');
      const p = await trackedProduct(o);
      const sale = await sell(o.token, p.id, 6, {
        batchAllocations: [
          { batchId: p.b, quantity: 4 },
          { batchId: p.a, quantity: 2 },
        ],
      });
      const saleId = sale.body._id as string;
      // Prix seul : aucun stock.
      expect(
        (await patchSale(o.token, saleId, { salePrice: 450 })).status,
      ).toBe(200);
      expect((await raw(p.id))?.remainingQuantity).toBe(24);
      // Ancien client : quantité seule refusée.
      const blind = await patchSale(o.token, saleId, { quantity: 4 });
      expect([blind.status, blind.body.code]).toEqual([
        409,
        'SALE_BATCH_CORRECTION_REQUIRED',
      ]);
      // Retour vers un lot qui n'est pas d'origine : refusé.
      const wrong = await patchSale(o.token, saleId, {
        quantity: 4,
        batchReturns: [{ batchId: p.undated, quantity: 2 }],
      });
      expect(wrong.status).toBe(400);
      // Diminution : L-001 crédité de 2.
      const down = await patchSale(o.token, saleId, {
        quantity: 4,
        batchReturns: [{ batchId: p.a, quantity: 2 }],
      });
      expect(down.status).toBe(200);
      expect(down.body.batchAllocations).toEqual([
        expect.objectContaining({ reference: 'L-002', quantity: 4 }),
      ]);
      expect((await byRef(p.id))['L-001'].remainingQuantity).toBe(5);
      // Augmentation : affectation supplémentaire valide exigée.
      const up = await patchSale(o.token, saleId, {
        quantity: 7,
        batchAllocations: [{ batchId: p.a, quantity: 3 }],
      });
      expect(up.status).toBe(200);
      const upExpired = await patchSale(o.token, saleId, {
        quantity: 8,
        batchAllocations: [{ batchId: p.expired, quantity: 1 }],
      });
      expect([upExpired.status, upExpired.body.code]).toEqual([
        409,
        'BATCH_EXPIRED',
      ]);
      // Échange (quantité inchangée) : 1 de L-002 → L-003 (sans date).
      const swap = await patchSale(o.token, saleId, {
        batchReturns: [{ batchId: p.b, quantity: 1 }],
        batchAllocations: [{ batchId: p.undated, quantity: 1 }],
        unknownExpiryConfirmed: true,
      });
      expect(swap.status).toBe(200);
      const saved = await saleModel.findById(saleId).lean();
      expect(saved?.quantity).toBe(7);
      expect(
        saved?.batchAllocations?.map((a) => [a.reference, a.quantity]),
      ).toEqual([
        ['L-002', 3],
        ['L-001', 3],
        ['L-003', 1],
      ]);
      // Affectation d'origine conservée ; 3 corrections tracées.
      expect(
        saved?.originalBatchAllocations?.map((a) => [a.reference, a.quantity]),
      ).toEqual([
        ['L-002', 4],
        ['L-001', 2],
      ]);
      expect(saved?.batchHistory).toHaveLength(3);
      expect(saved?.batchHistory?.[0]).toMatchObject({
        quantityBefore: 6,
        quantityAfter: 4,
      });
      const refs = await byRef(p.id);
      expect(refs['L-002'].remainingQuantity).toBe(7);
      expect(refs['L-001'].remainingQuantity).toBe(2);
      expect(refs['L-003'].remainingQuantity).toBe(7);
      await expectConsistent(p.id, 30);
    });

    it('annulation : restitution exacte aux lots d’origine, même dépassés depuis (stock physique, non vendable)', async () => {
      const o = await registerOwner('cancel');
      const p = await trackedProduct(o);
      const sale = await sell(o.token, p.id, 7, {
        batchAllocations: [
          { batchId: p.b, quantity: 5 },
          { batchId: p.a, quantity: 2 },
        ],
      });
      // L-002 dépasse sa date après la vente.
      await batchModel.updateOne(
        { _id: new Types.ObjectId(p.b) },
        { $set: { expiryDate: day(-2) } },
      );
      const res = await cancelSale(o.token, sale.body._id);
      expect(res.status).toBe(204);
      const refs = await byRef(p.id);
      expect(refs['L-002'].remainingQuantity).toBe(10);
      expect(refs['L-001'].remainingQuantity).toBe(5);
      await expectConsistent(p.id, 30);
      const list = await http()
        .get(`/products/${p.id}/batches`)
        .set(auth(o.token));
      const l2 = list.body.batches.find(
        (b: { reference: string }) => b.reference === 'L-002',
      );
      expect(l2).toMatchObject({ remainingQuantity: 10, sellable: false });
      expect(list.body.expiredQuantity).toBe(17);
      expect(list.body.sellableQuantity).toBe(13);
      const opts = await options(o.token, p.id, 1);
      expect(
        opts.body.dated.map((b: { reference: string }) => b.reference),
      ).toEqual(['L-001']);
      const [cancelled] = await auditModel
        .find({
          productId: new Types.ObjectId(p.id),
          action: AuditAction.SALE_CANCELLED,
        })
        .lean();
      const cancelledBatches = cancelled.details.batches as {
        returned: unknown[];
      };
      expect(cancelledBatches.returned).toEqual([
        expect.objectContaining({ reference: 'L-002', quantity: 5 }),
        expect.objectContaining({ reference: 'L-001', quantity: 2 }),
      ]);
    });
  });

  describe('4. Ventes antérieures à l’activation', () => {
    it('aucun lot inventé ; restitution explicite avec motif et droits ; lot historique confirmé', async () => {
      const o = await registerOwner('legacy');
      const id = await seedProduct(o.orgId, o.sectionId, 40);
      const legacy = await sell(o.token, id, 12);
      expect(legacy.status).toBe(201);
      const saleId = legacy.body._id as string;
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 28,
            batches: [{ quantity: 20, expiryDate: day(30) }, { quantity: 8 }],
          })
        ).status,
      ).toBe(201);
      const p1 = (await byRef(id))['L-001']._id.toHexString();
      expect((await saleModel.findById(saleId).lean())?.batchAllocations).toBe(
        undefined,
      );
      // Prix seul : permis, sans stock.
      expect(
        (await patchSale(o.token, saleId, { salePrice: 420 })).status,
      ).toBe(200);
      // Quantité seule : restitution exigée.
      const blind = await patchSale(o.token, saleId, { quantity: 10 });
      expect([blind.status, blind.body.code]).toEqual([
        409,
        'SALE_BATCH_RESTITUTION_REQUIRED',
      ]);
      // Sans motif : refusé.
      const noReason = await patchSale(o.token, saleId, {
        quantity: 10,
        restitutions: [{ batchId: p1, quantity: 2 }],
      });
      expect(noReason.status).toBe(400);
      // Droits : vendeur avec toutes les ventes mais sans `stock.adjust`.
      const clerk = await seedMember(o.orgId, [
        'sales.record',
        'sales.view_all',
      ]);
      const denied = await patchSale(clerk.token, saleId, {
        quantity: 10,
        restitutions: [{ batchId: p1, quantity: 2 }],
        restitutionReason: 'erreur de saisie',
      });
      expect(denied.status).toBe(403);
      const fixed = await patchSale(o.token, saleId, {
        quantity: 10,
        restitutions: [{ batchId: p1, quantity: 2 }],
        restitutionReason: 'erreur de saisie',
      });
      expect(fixed.status).toBe(200);
      const saved = await saleModel.findById(saleId).lean();
      // L'origine reste inconnue : aucune affectation attribuée.
      expect(saved?.batchAllocations ?? []).toEqual([]);
      expect(saved?.batchHistory?.[0]).toMatchObject({
        reason: 'erreur de saisie',
        restitutions: [
          expect.objectContaining({
            reference: 'L-001',
            quantity: 2,
            historical: false,
          }),
        ],
      });
      expect((await byRef(id))['L-001'].remainingQuantity).toBe(22);
      // Restitution, jamais une réception : initial inchangé.
      await expectConsistent(id, 40);

      // Annulation : destination exigée ; lot historique confirmé.
      const blindCancel = await cancelSale(o.token, saleId);
      expect([blindCancel.status, blindCancel.body.code]).toEqual([
        409,
        'SALE_BATCH_RESTITUTION_REQUIRED',
      ]);
      const stockOnly = await seedMember(o.orgId, [
        'sales.record',
        'sales.view_all',
        'stock.adjust',
      ]);
      const historicalBody = {
        historicalRestitution: { quantity: 10, confirmed: true },
        restitutionReason: 'vente annulée, lot inconnu',
      };
      // Créer un lot exige aussi `products.manage`.
      expect(
        (await cancelSale(stockOnly.token, saleId, historicalBody)).status,
      ).toBe(403);
      const unconfirmed = await cancelSale(o.token, saleId, {
        historicalRestitution: { quantity: 10 },
        restitutionReason: 'x lot inconnu',
      });
      expect(unconfirmed.status).toBe(400);
      const cancelled = await cancelSale(o.token, saleId, historicalBody);
      expect(cancelled.status).toBe(204);
      const refs = await byRef(id);
      expect(refs['L-003']).toMatchObject({
        origin: 'restitution',
        remainingQuantity: 10,
        expiryDate: null,
        receivedOn: null,
      });
      expect((await raw(id))?.remainingQuantity).toBe(40);
      await expectConsistent(id, 40);
      const [audit] = await auditModel
        .find({
          productId: new Types.ObjectId(id),
          action: AuditAction.SALE_CANCELLED,
        })
        .lean();
      expect(audit.details.batches).toMatchObject({
        originUnknown: true,
        reason: 'vente annulée, lot inconnu',
        restitutions: [{ reference: 'L-003', quantity: 10, historical: true }],
      });
    });
  });

  describe('5. Permissions et visibilité', () => {
    it('vendeur par défaut : vend par lots sans droits de gestion ; aucune quantité par lot exposée', async () => {
      const o = await registerOwner('seller');
      const p = await trackedProduct(o);
      const seller = await seedMember(o.orgId);
      const opts = await options(seller.token, p.id, 3);
      expect(opts.status).toBe(200);
      for (const b of [...opts.body.dated, ...opts.body.undated]) {
        expect(b).not.toHaveProperty('remainingQuantity');
      }
      expect(opts.body.suggestion).toEqual([{ batchId: p.b, quantity: 3 }]);
      const sale = await sell(seller.token, p.id, 3, {
        batchAllocations: opts.body.suggestion,
      });
      expect(sale.status).toBe(201);
      // Ses propres ventes : affectation visible.
      const mine = await http().get('/sales/history').set(auth(seller.token));
      expect(mine.body.items[0].batchAllocations[0]).toMatchObject({
        reference: 'L-002',
        quantity: 3,
      });
      // Liste des produits : identité des lots vendables, sans quantités.
      const products = await http().get('/products').set(auth(seller.token));
      const listed = (
        Array.isArray(products.body) ? products.body : products.body.items
      ).find((x: { product: { _id: string } }) => x.product._id === p.id);
      expect(
        listed.batchSale.batches.map((b: { reference: string }) => b.reference),
      ).toEqual(['L-002', 'L-001', 'L-003']);
      for (const b of listed.batchSale.batches) {
        expect(Object.keys(b).sort()).toEqual([
          '_id',
          'expiryDate',
          'manufacturerLot',
          'reference',
        ]);
      }
      const batches = await http()
        .get(`/products/${p.id}/batches`)
        .set(auth(seller.token));
      expect(batches.body).not.toHaveProperty('totalQuantity');
      expect(batches.body).not.toHaveProperty('sellableQuantity');
      for (const b of batches.body.batches) {
        expect(b).not.toHaveProperty('remainingQuantity');
      }
      // Régularisation : réservée à `stock.adjust`.
      const reg = await sell(seller.token, p.id, 1, {
        batchAllocations: [{ batchId: p.a, quantity: 1 }],
        expiredBatchRegularization: { reason: 'vente hors ligne' },
      });
      expect(reg.status).toBe(403);
      await expectConsistent(p.id, 30);
    });

    it('fonctionnalité désactivée : options refusées (403), ventes par lots refusées (409, sans bloquer l’outbox)', async () => {
      const o = await registerOwner('flag-off');
      const p = await trackedProduct(o);
      process.env.PRODUCT_BATCHES_ENABLED = 'false';
      try {
        expect((await options(o.token, p.id, 1)).status).toBe(403);
        const res = await sell(o.token, p.id, 1, {
          batchAllocations: [{ batchId: p.a, quantity: 1 }],
        });
        // 409 et non 403 : un 403 bloquerait toute l'outbox hors ligne.
        expect([res.status, res.body.code]).toEqual([
          409,
          'PRODUCT_BATCHES_DISABLED',
        ]);
      } finally {
        process.env.PRODUCT_BATCHES_ENABLED = 'true';
      }
      await expectConsistent(p.id, 30);
    });
  });

  describe('6. Hors ligne : péremption entre la saisie et la synchronisation', () => {
    it('vente déclarée avant péremption, reçue après : conflit, régularisation autorisée et tracée', async () => {
      const o = await registerOwner('offline');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 10,
            batches: [{ quantity: 10, expiryDate: day(-1) }],
          })
        ).status,
      ).toBe(201);
      const batchId = (await byRef(id))['L-001']._id.toHexString();
      const yesterday = new Date(Date.now() - DAY_MS).toISOString();
      const offlineSale = {
        clientOperationId: uuid(),
        occurredAt: yesterday,
        batchAllocations: [{ batchId, quantity: 2 }],
      };
      const conflict = await sell(o.token, id, 2, offlineSale);
      expect([conflict.status, conflict.body.code]).toEqual([
        409,
        'BATCH_EXPIRED_AT_SYNC',
      ]);
      // Rejeu de la même opération : toujours en conflit, jamais appliquée.
      expect((await sell(o.token, id, 2, offlineSale)).body.code).toBe(
        'BATCH_EXPIRED_AT_SYNC',
      );
      // Vente déclarée aujourd'hui sur ce lot : refus définitif.
      const today = await sell(o.token, id, 1, {
        clientOperationId: uuid(),
        occurredAt: new Date().toISOString(),
        batchAllocations: [{ batchId, quantity: 1 }],
      });
      expect([today.status, today.body.code]).toEqual([409, 'BATCH_EXPIRED']);
      // La régularisation ne permet pas de vendre aujourd'hui.
      const todayRegularized = await sell(o.token, id, 1, {
        clientOperationId: uuid(),
        occurredAt: new Date().toISOString(),
        batchAllocations: [{ batchId, quantity: 1 }],
        expiredBatchRegularization: { reason: 'tentative' },
      });
      expect(todayRegularized.body.code).toBe('BATCH_EXPIRED');
      expect(await salesOf(id)).toBe(0);
      // Résolution : nouvelle opération régularisée (même heure déclarée).
      const regularized = await sell(o.token, id, 2, {
        ...offlineSale,
        clientOperationId: uuid(),
        expiredBatchRegularization: { reason: 'vendu hier hors ligne' },
      });
      expect(regularized.status).toBe(201);
      expect(regularized.body.expiredBatchRegularization).toMatchObject({
        reason: 'vendu hier hors ligne',
        references: ['L-001'],
        businessDate: day(0),
      });
      expect(await salesOf(id)).toBe(1);
      await expectConsistent(id, 10);
    });
  });

  describe('7. Corbeille et purge', () => {
    it('produit à la corbeille : vente refusée, annulation restituée ; produit purgé : aucune restitution', async () => {
      const o = await registerOwner('trash');
      const p = await trackedProduct(o);
      const sale = await sell(o.token, p.id, 2, {
        batchAllocations: [{ batchId: p.a, quantity: 2 }],
      });
      const second = await sell(o.token, p.id, 1, {
        batchAllocations: [{ batchId: p.a, quantity: 1 }],
      });
      expect(
        (await http().delete(`/products/${p.id}`).set(auth(o.token))).status,
      ).toBe(200);
      const refused = await sell(o.token, p.id, 1, {
        batchAllocations: [{ batchId: p.b, quantity: 1 }],
      });
      expect(refused.status).toBe(404);
      expect((await cancelSale(o.token, sale.body._id)).status).toBe(204);
      expect((await byRef(p.id))['L-001'].remainingQuantity).toBe(4);
      await expectConsistent(p.id, 30);
      expect(
        (await http().delete(`/products/${p.id}/permanent`).set(auth(o.token)))
          .status,
      ).toBe(200);
      const fix = await patchSale(o.token, second.body._id, {
        quantity: 2,
        batchAllocations: [{ batchId: p.b, quantity: 1 }],
      });
      expect([fix.status, fix.body.code]).toEqual([409, 'SALE_PRODUCT_PURGED']);
      // Prix seul : permis ; annulation : vente retirée sans restitution.
      expect(
        (await patchSale(o.token, second.body._id, { salePrice: 1 })).status,
      ).toBe(200);
      expect((await cancelSale(o.token, second.body._id)).status).toBe(204);
      expect((await byRef(p.id))['L-001'].remainingQuantity).toBe(4);
    });
  });
  describe('8. Régularisation par un responsable', () => {
    /** Lot L-001 de 10 unités dépassé depuis hier ; vente déclarée hier. */
    async function expiredAtSync(label: string) {
      const o = await registerOwner(label);
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 10,
            batches: [{ quantity: 10, expiryDate: day(-1) }],
          })
        ).status,
      ).toBe(201);
      const batchId = (await byRef(id))['L-001']._id.toHexString();
      const seller = await seedMember(o.orgId);
      const operation = (quantity = 2) => ({
        productId: id,
        quantity,
        salePrice: 400,
        clientOperationId: uuid(),
        occurredAt: new Date(Date.now() - DAY_MS).toISOString(),
        batchAllocations: [{ batchId, quantity }],
      });
      return { o, id, batchId, seller, operation };
    }
    const requestReg = (token: string, body: object) =>
      http().post('/sales/regularizations').set(auth(token)).send(body);
    const decide = (
      token: string,
      requestId: string,
      decision: 'approve' | 'reject',
      reason = 'vendu hier soir hors ligne',
    ) =>
      http()
        .post(`/sales/regularizations/${requestId}/${decision}`)
        .set(auth(token))
        .send({ reason });

    it('vendeur sans stock.adjust : demande, approbation unique (concurrence, rejeu), traçabilité', async () => {
      const { o, id, seller, operation } = await expiredAtSync('reg-ok');
      const op = operation();
      // Synchronisation de l'outbox : refus confirmé.
      const refused = await sell(seller.token, id, 2, op);
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'BATCH_EXPIRED_AT_SYNC',
      ]);
      // Le vendeur ne peut pas régulariser lui-même.
      const self = await sell(seller.token, id, 2, {
        ...op,
        expiredBatchRegularization: { reason: 'moi-même' },
      });
      expect(self.status).toBe(403);
      // Demande explicite (même opération).
      const req = await requestReg(seller.token, op);
      expect(req.status).toBe(201);
      expect(req.body).toMatchObject({
        status: 'pending',
        clientOperationId: op.clientOperationId,
        quantity: 2,
        expiredReferences: ['L-001'],
        declaredOccurredAt: op.occurredAt,
      });
      const requestId = req.body._id as string;
      // Répétée : même demande ; autre contenu sous la même clé : refus.
      expect((await requestReg(seller.token, op)).body._id).toBe(requestId);
      const reused = await requestReg(seller.token, { ...op, salePrice: 1 });
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // Non autorisés : le vendeur, un membre stock.adjust sans view_all.
      expect((await decide(seller.token, requestId, 'approve')).status).toBe(
        403,
      );
      const stocker = await seedMember(o.orgId, [
        'sales.record',
        'stock.adjust',
      ]);
      expect((await decide(stocker.token, requestId, 'approve')).status).toBe(
        403,
      );
      // Autre commerce : indistinguable d'une demande absente.
      const other = await registerOwner('reg-other');
      expect((await decide(other.token, requestId, 'approve')).status).toBe(
        404,
      );
      // Le vendeur ne voit que ses demandes ; le responsable, le commerce.
      const mine = await http()
        .get('/sales/regularizations')
        .query({ clientOperationIds: op.clientOperationId })
        .set(auth(seller.token));
      expect(mine.body.map((r: { _id: string }) => r._id)).toEqual([requestId]);
      expect(
        (await http().get('/sales/regularizations').set(auth(stocker.token)))
          .body,
      ).toEqual([]);
      const pending = await http()
        .get('/sales/regularizations')
        .query({ status: 'pending' })
        .set(auth(o.token));
      expect(pending.body.map((r: { _id: string }) => r._id)).toContain(
        requestId,
      );
      // Approbations concurrentes + rejeu concurrent de l'outbox.
      const results = await Promise.all([
        decide(o.token, requestId, 'approve'),
        decide(o.token, requestId, 'approve'),
        decide(o.token, requestId, 'approve'),
        sell(seller.token, id, 2, op),
      ]);
      for (const r of results.slice(0, 3)) {
        expect(r.status).toBe(201);
        expect(r.body.status).toBe('approved');
      }
      expect(await salesOf(id)).toBe(1);
      const approved = results[0].body as { saleId: string; decidedBy: string };
      // L'outbox retrouve la vente (même clé), jamais une seconde.
      const replay = await sell(seller.token, id, 2, op);
      expect(replay.status).toBe(201);
      expect(replay.body._id).toBe(approved.saleId);
      expect(await salesOf(id)).toBe(1);
      expect((await byRef(id))['L-001'].remainingQuantity).toBe(8);
      await expectConsistent(id, 10);
      // Traçabilité : vendeur d'origine, approbateur, heures distinctes.
      const sale = await saleModel.findById(approved.saleId).lean();
      const sellerUser = await userModel
        .findOne({ email: { $regex: /^member-/ } })
        .sort({ _id: -1 })
        .lean();
      void sellerUser;
      expect(String(sale?.sellerId)).toBe(String(replay.body.sellerId._id));
      expect(String(sale?.expiredBatchRegularization?.actorId)).not.toBe(
        String(sale?.sellerId),
      );
      expect(String(sale?.expiredBatchRegularization?.requestedBy)).toBe(
        String(sale?.sellerId),
      );
      expect(sale?.expiredBatchRegularization).toMatchObject({
        reason: 'vendu hier soir hors ligne',
        references: ['L-001'],
        businessDate: day(0),
      });
      expect(sale?.occurredAt?.toISOString()).toBe(op.occurredAt);
      expect(
        sale?.expiredBatchRegularization?.declaredOccurredAt?.toISOString(),
      ).toBe(op.occurredAt);
      expect(
        sale!.expiredBatchRegularization!.receivedAt!.getTime(),
      ).toBeGreaterThan(new Date(op.occurredAt).getTime());
      const [approvedAudit] = await auditModel
        .find({
          productId: new Types.ObjectId(id),
          action: AuditAction.SALE_REGULARIZATION_APPROVED,
        })
        .lean();
      expect(String(approvedAudit.actorId)).toBe(
        String(sale?.expiredBatchRegularization?.actorId),
      );
      expect(String(approvedAudit.details.sellerId)).toBe(
        String(sale?.sellerId),
      );
      const sold = await auditModel
        .find({ productId: new Types.ObjectId(id), action: AuditAction.SOLD })
        .lean();
      expect(sold).toHaveLength(1);
      expect(String(sold[0].actorId)).toBe(String(sale?.sellerId));
      expect(
        await auditModel.countDocuments({
          productId: new Types.ObjectId(id),
          action: AuditAction.SALE_REGULARIZATION_REQUESTED,
        }),
      ).toBe(1);
      // Plus rien à demander pour cette opération.
      const after = await requestReg(seller.token, op);
      expect(after.body.code).toBe('SALE_REGULARIZATION_ALREADY_APPLIED');
    });

    it('rejet motivé : demande conservée, aucune vente, décision définitive', async () => {
      const { o, id, seller, operation } = await expiredAtSync('reg-reject');
      const op = operation(3);
      const req = await requestReg(seller.token, op);
      expect(req.status).toBe(201);
      const rejected = await decide(
        o.token,
        req.body._id,
        'reject',
        'aucune trace de cette vente',
      );
      expect(rejected.status).toBe(201);
      expect(rejected.body).toMatchObject({
        status: 'rejected',
        decisionReason: 'aucune trace de cette vente',
      });
      expect((await decide(o.token, req.body._id, 'approve')).body.code).toBe(
        'SALE_REGULARIZATION_DECIDED',
      );
      const mine = await http()
        .get('/sales/regularizations')
        .set(auth(seller.token));
      expect(mine.body[0]).toMatchObject({
        status: 'rejected',
        decisionReason: 'aucune trace de cette vente',
      });
      expect(await salesOf(id)).toBe(0);
      expect((await byRef(id))['L-001'].remainingQuantity).toBe(10);
      expect(
        await auditModel.countDocuments({
          productId: new Types.ObjectId(id),
          action: AuditAction.SALE_REGULARIZATION_REJECTED,
        }),
      ).toBe(1);
    });

    it('revalidation à l’approbation : stock insuffisant → refus, demande toujours en attente ; vente non éligible refusée', async () => {
      const { o, id, batchId, seller, operation } =
        await expiredAtSync('reg-revalidate');
      const op = operation(4);
      const req = await requestReg(seller.token, op);
      expect(req.status).toBe(201);
      // Stock réduit entre-temps (8 unités sorties du lot dépassé).
      await batchModel.updateOne(
        { _id: new Types.ObjectId(batchId) },
        { $inc: { remainingQuantity: -8 } },
      );
      await productModel.updateOne(
        { _id: new Types.ObjectId(id) },
        { $inc: { remainingQuantity: -8, 'batchTracking.totalQuantity': -8 } },
      );
      const refused = await decide(o.token, req.body._id, 'approve');
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'BATCH_INSUFFICIENT',
      ]);
      const still = await http()
        .get('/sales/regularizations')
        .query({ clientOperationIds: op.clientOperationId })
        .set(auth(o.token));
      expect(still.body[0].status).toBe('pending');
      expect(await salesOf(id)).toBe(0);
      await expectConsistent(id, 10);
      // Vente valide aujourd'hui : aucune régularisation à demander.
      const fresh = await trackedProduct(o);
      const notNeeded = await requestReg(seller.token, {
        productId: fresh.id,
        quantity: 1,
        salePrice: 400,
        clientOperationId: uuid(),
        occurredAt: new Date().toISOString(),
        batchAllocations: [{ batchId: fresh.a, quantity: 1 }],
      });
      expect(notNeeded.body.code).toBe('SALE_REGULARIZATION_NOT_NEEDED');
    });
  });

  describe('9. Notifications de stock (faux transport, aucun envoi externe)', () => {
    let runtime: PushRuntime;
    let dispatcher: PushDispatcherService;
    const transport = new FakePushTransport();

    beforeAll(() => {
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      const vapid = p256();
      runtime.activate(
        {
          enabled: true,
          publicKey: vapid.getPublicKey().toString('base64url'),
          privateKey: vapid.getPrivateKey().toString('base64url'),
          subject: 'mailto:e2e@example.com',
        },
        transport,
      );
    });
    afterAll(() => runtime.deactivate());

    async function device(token: string, preferences: Record<string, boolean>) {
      seq += 1;
      const browser = p256();
      const subscription = {
        endpoint: `https://fcm.googleapis.com/fcm/send/batches-${seq}`,
        keys: {
          p256dh: browser.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      };
      const res = await http()
        .post('/notifications/push/subscription')
        .set(auth(token))
        .send({
          subscription,
          preferences: {
            saleCreated: false,
            monthlyReport: false,
            ...preferences,
          },
        });
      expect(res.status).toBe(200);
      return subscription.endpoint;
    }
    const jobs = (productId: string, category: PushCategory) =>
      jobModel.countDocuments({
        productId: new Types.ObjectId(productId),
        category,
      });

    it('entrée sous le seuil une fois, pas de répétition, rupture prioritaire, rejeu sans doublon, destinataires et préférences', async () => {
      const o = await registerOwner('notify');
      const id = await seedProduct(o.orgId, o.sectionId, 10);
      await productModel.updateOne(
        { _id: new Types.ObjectId(id) },
        { $set: { lowStockThreshold: 5 } },
      );
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 10,
            batches: [{ quantity: 10, expiryDate: day(20) }],
          })
        ).status,
      ).toBe(201);
      const batchId = (await byRef(id))['L-001']._id.toHexString();
      const viewer = await seedMember(o.orgId, ['products.view_stock_details']);
      const seller = await seedMember(o.orgId);
      const ownerDevice = await device(o.token, {});
      const quietDevice = await device(viewer.token, { stockLow: false });
      const sellerDevice = await device(seller.token, {});
      const sellBatch = (quantity: number, key = uuid()) =>
        sell(o.token, id, quantity, {
          clientOperationId: key,
          batchAllocations: [{ batchId, quantity }],
        });

      expect((await sellBatch(4)).status).toBe(201); // 10 → 6 : au-dessus
      expect(await jobs(id, PushCategory.STOCK_LOW)).toBe(0);
      const key = uuid();
      expect((await sellBatch(2, key)).status).toBe(201); // 6 → 4 : entrée
      expect(await jobs(id, PushCategory.STOCK_LOW)).toBe(1);
      expect((await sellBatch(2, key)).status).toBe(201); // rejeu
      expect(await jobs(id, PushCategory.STOCK_LOW)).toBe(1);
      await dispatcher.runOnce();
      expect(transport.to(ownerDevice).map((s) => s.payload.category)).toEqual([
        'stock-low',
      ]);
      expect(transport.to(quietDevice)).toEqual([]); // préférence coupée
      expect(transport.to(sellerDevice)).toEqual([]); // sans détail du stock
      expect((await sellBatch(1)).status).toBe(201); // 4 → 3 : reste faible
      expect(await jobs(id, PushCategory.STOCK_LOW)).toBe(1);
      expect((await sellBatch(3)).status).toBe(201); // 3 → 0 : rupture
      expect(await jobs(id, PushCategory.STOCK_LOW)).toBe(1);
      expect(await jobs(id, PushCategory.STOCK_DEPLETED)).toBe(1);
      await dispatcher.runOnce();
      expect(transport.to(ownerDevice).map((s) => s.payload.category)).toEqual([
        'stock-low',
        'stock-depleted',
      ]);
      expect(transport.to(quietDevice).map((s) => s.payload.category)).toEqual([
        'stock-depleted',
      ]);
      expect(transport.to(sellerDevice)).toEqual([]);
      await expectConsistent(id, 10);
    });
  });
});
