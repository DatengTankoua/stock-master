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
import {
  firstAlertInventory,
  installExpiryAlerts,
} from './../src/migrations/expiry-alerts';
import {
  LOT_C_PERMISSIONS,
  inventoryProductBatches,
  stripBatchPermission,
} from './../src/migrations/product-batches';
import { PUSH_CLOCK, PushRuntime } from './../src/push/push-runtime';
import {
  EXPIRY_ALERT_SCAN_MAX_PAGES,
  EXPIRY_ALERT_SCAN_PAGE,
  PushDispatcherService,
} from './../src/push/push-dispatcher.service';
import { NOTIFICATIONS_COLLECTION } from './../src/notifications/schemas/notification.schema';
import { ensurePushIndexes } from './../src/push/push-indexes';
import type {
  PushSendOptions,
  PushSendResult,
  PushTarget,
  PushTransport,
} from './../src/push/push-transport';
import type { PushMessagePayload } from './../src/push/push-messages';
import { PushJob } from './../src/push/schemas/push-job.schema';
import type { PushJobDocument } from './../src/push/schemas/push-job.schema';
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
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

/**
 * E2E — lots de produits, lot C : alertes de péremption (planificateur,
 * déduplication, revalidation, préférences), mise à l'écart, pertes et
 * contre-mouvements, calculs (ventes, CA, marge sur ventes inchangés),
 * permissions et isolation, notification de régularisation.
 *
 * Horloge des notifications contrôlée (`PUSH_CLOCK`), FAUX transport push
 * (aucun réseau, paire VAPID générée) : un succès ici n'est PAS un push réel.
 */

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

const p256 = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
};

const TEST_JWT_SECRET = 'product-batches-lot-c-e2e-only-secret';
const PASSWORD = 'product-batches-lot-c-pw-!1x';
const DAY_MS = 24 * 60 * 60 * 1000;

let uuidSeq = 0;
function uuid(): string {
  uuidSeq += 1;
  return `0d0d0d0d-0d0d-4d0d-8d0d-${uuidSeq.toString(16).padStart(12, '0')}`;
}

let now = new Date();
/** Jour civil du commerce décalé de `days` par rapport à l'horloge contrôlée. */
const day = (days: number) =>
  businessDate(new Date(now.getTime() + days * DAY_MS));

describe('E2E — lots de produits (lot C : péremption, mise à l’écart, pertes)', () => {
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
  let runtime: PushRuntime;
  let dispatcher: PushDispatcherService;
  const transport = new FakePushTransport();
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
    const email = `${label}-${seq}-lotc@pb.test`;
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
    const email = `member-${seq}-lotc@pb.test`;
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
      token: await login(email),
      membershipId: membership._id.toHexString(),
    };
  }

  /**
   * Produit sans lots daté PAR L'API (`PATCH`) : la planification des
   * alertes suit le chemin réel de modification de la fiche.
   */
  async function createProduct(
    o: { orgId: string; token: string; sectionId: string },
    qty: number,
    expiryDate?: string,
  ) {
    const id = await seedProduct(o.orgId, o.sectionId, qty);
    if (expiryDate) {
      const res = await http()
        .patch(`/products/${id}`)
        .set(auth(o.token))
        .send({ expiryDate });
      expect(res.status).toBe(200);
    }
    return id;
  }

  async function seedProduct(orgId: string, sectionId: string, qty: number) {
    seq += 1;
    const product = await productModel.create({
      organizationId: new Types.ObjectId(orgId),
      sectionId: new Types.ObjectId(sectionId),
      name: `Produit C ${seq}`,
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
    batchId: string,
    quantity: number,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({
        productId,
        quantity,
        salePrice: 400,
        clientOperationId: uuid(),
        batchAllocations: [{ batchId, quantity }],
        ...extra,
      });
  const lose = (
    token: string,
    productId: string,
    batchId: string,
    body: Record<string, unknown>,
  ) =>
    http()
      .post(`/products/${productId}/batches/${batchId}/losses`)
      .set(auth(token))
      .send({ clientOperationId: uuid(), reason: 'damaged', ...body });
  const status = (
    token: string,
    productId: string,
    batchId: string,
    action: 'quarantine' | 'release',
    reason = 'contrôle qualité',
  ) =>
    http()
      .post(`/products/${productId}/batches/${batchId}/${action}`)
      .set(auth(token))
      .send({ reason });
  const batchesOf = (id: string) =>
    batchModel
      .find({ productId: new Types.ObjectId(id) })
      .sort({ reference: 1 })
      .lean()
      .exec();
  const byRef = async (id: string) =>
    Object.fromEntries((await batchesOf(id)).map((b) => [b.reference, b]));
  const list = (token: string, id: string) =>
    http().get(`/products/${id}/batches`).set(auth(token));

  async function expectConsistent(id: string, initial: number) {
    const product = await raw(id);
    const batches = await batchesOf(id);
    expect(batches.every((b) => b.remainingQuantity >= 0)).toBe(true);
    expect(batches.reduce((s, b) => s + b.remainingQuantity, 0)).toBe(
      product?.remainingQuantity,
    );
    expect(product?.batchTracking?.totalQuantity).toBe(
      product?.remainingQuantity,
    );
    expect(product?.initialQuantity).toBe(initial);
  }

  /** Produit suivi : lots `quantities` (dates relatives, `null` : sans date). */
  async function tracked(
    o: { orgId: string; sectionId: string; token: string },
    lots: { quantity: number; in?: number | null }[],
  ) {
    const total = lots.reduce((s, l) => s + l.quantity, 0);
    const id = await seedProduct(o.orgId, o.sectionId, total);
    const res = await enable(o.token, id, {
      expectedRemainingQuantity: total,
      batches: lots.map((l) => ({
        quantity: l.quantity,
        ...(l.in === null || l.in === undefined
          ? {}
          : { expiryDate: day(l.in) }),
      })),
    });
    expect(res.status).toBe(201);
    const refs = await byRef(id);
    return {
      id,
      total,
      lot: (n: number) => refs[`L-00${n}`]._id.toHexString(),
    };
  }

  const jobs = (filter: Record<string, unknown>) =>
    jobModel.find(filter).sort({ createdAt: 1, _id: 1 }).lean().exec();

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
      process.env.CORS_ORIGIN = 'https://product-batches-lotc.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.product-batches-lotc.test';
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PRODUCT_BATCHES_ENABLED = 'true';
      process.env.EXPIRY_ALERTS_ENABLED = 'true';
      process.env.PRODUCT_BATCHES_ORGANIZATIONS = 'all';
      process.env.EXPIRY_ALERTS_ORGANIZATIONS = 'all';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(PUSH_CLOCK)
        .useValue(() => new Date(now.getTime()))
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
      runtime = moduleFixture.get(PushRuntime);
      dispatcher = moduleFixture.get(PushDispatcherService);
      await ensureSaleOperationIndex(connection);
      await ensureProductBatchGuard(connection);
      await ensurePushIndexes(connection);
      await installExpiryAlerts(connection);
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
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  beforeEach(() => {
    clearThrottle();
    now = new Date();
  });

  afterAll(async () => {
    runtime?.deactivate();
    delete process.env.PRODUCT_BATCHES_ENABLED;
    delete process.env.EXPIRY_ALERTS_ENABLED;
    delete process.env.PRODUCT_BATCHES_ORGANIZATIONS;
    delete process.env.EXPIRY_ALERTS_ORGANIZATIONS;
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Pertes : calculs, idempotence, fermeture, contre-mouvement', () => {
    it('perte partielle : ventes, CA et marge sur ventes inchangés ; pertes à part, valorisées au moment du mouvement', async () => {
      const o = await registerOwner('loss');
      const p = await tracked(o, [
        { quantity: 12, in: 40 },
        { quantity: 8, in: 5 },
      ]);
      expect((await sell(o.token, p.id, p.lot(1), 5)).status).toBe(201);
      const before = await http().get(`/products/${p.id}`).set(auth(o.token));
      const overviewBefore = await http()
        .get('/analytics/overview')
        .set(auth(o.token));
      const key = uuid();
      const loss = await lose(o.token, p.id, p.lot(2), {
        clientOperationId: key,
        quantity: 3,
      });
      expect(loss.status).toBe(201);
      expect(loss.body.lossId).toBeDefined();
      // Rejeu : aucune seconde perte ; même clé, autre contenu : refus.
      const replay = await lose(o.token, p.id, p.lot(2), {
        clientOperationId: key,
        quantity: 3,
      });
      expect(replay.body.replayed).toBe(true);
      expect(
        (
          await lose(o.token, p.id, p.lot(2), {
            clientOperationId: key,
            quantity: 2,
          })
        ).body.code,
      ).toBe('IDEMPOTENCY_KEY_REUSED');
      // Prix d'achat modifié ensuite : la valeur de la perte ne bouge pas.
      await productModel.updateOne(
        { _id: new Types.ObjectId(p.id) },
        { $set: { purchasePrice: 250 } },
      );
      const after = await http().get(`/products/${p.id}`).set(auth(o.token));
      expect(after.body.unitsSold).toBe(5);
      expect(after.body.lostQuantity).toBe(3);
      expect(after.body.lossValueAtCost).toBe(300);
      expect(after.body.actualRevenue).toBe(before.body.actualRevenue);
      // Marge sur ventes : CA − coût des seules unités vendues.
      expect(after.body.actualProfit).toBe(2000 - 250 * 5);
      const overviewAfter = await http()
        .get('/analytics/overview')
        .set(auth(o.token));
      expect(overviewAfter.body.totalRevenue).toBe(
        overviewBefore.body.totalRevenue,
      );
      expect(overviewAfter.body.unitsSold).toBe(overviewBefore.body.unitsSold);
      expect(
        await saleModel.countDocuments({ productId: new Types.ObjectId(p.id) }),
      ).toBe(1);
      const health = await http()
        .get('/analytics/stock-health')
        .set(auth(o.token));
      expect(health.body.losses).toMatchObject({
        lostQuantity: 3,
        lossValueAtCost: 300,
      });
      const refs = await byRef(p.id);
      expect(refs['L-002']).toMatchObject({
        remainingQuantity: 5,
        status: 'available',
      });
      expect((await raw(p.id))?.lossTracking).toEqual({
        netQuantity: 3,
        netValueAtCost: 300,
      });
      await expectConsistent(p.id, 20);
      // Refus sans écriture : au-delà du stock, « autre » sans commentaire.
      expect(
        (await lose(o.token, p.id, p.lot(2), { quantity: 6 })).body.code,
      ).toBe('BATCH_INSUFFICIENT');
      expect(
        (
          await lose(o.token, p.id, p.lot(2), {
            quantity: 1,
            reason: 'other',
          })
        ).body.code,
      ).toBe('LOSS_COMMENT_REQUIRED');
      await expectConsistent(p.id, 20);
    });

    it('perte totale : lot fermé (withdrawn) ; correction liée, plafonnée, sans remise en vente ; remise à disposition explicite', async () => {
      const o = await registerOwner('loss-total');
      const p = await tracked(o, [
        { quantity: 4, in: 30 },
        { quantity: 6, in: 60 },
      ]);
      const loss = await lose(o.token, p.id, p.lot(1), {
        quantity: 4,
        reason: 'expired',
      });
      expect(loss.status).toBe(201);
      expect((await byRef(p.id))['L-001']).toMatchObject({
        remainingQuantity: 0,
        status: 'withdrawn',
      });
      const correct = (quantity: number) =>
        http()
          .post(`/products/${p.id}/losses/${loss.body.lossId}/corrections`)
          .set(auth(o.token))
          .send({
            clientOperationId: uuid(),
            quantity,
            comment: 'erreur de saisie',
          });
      // Deux corrections concurrentes de 3 : une seule passe (max 4).
      const [a, b] = await Promise.all([correct(3), correct(3)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect((await correct(2)).body.code).toBe('LOSS_CORRECTION_EXCEEDS');
      expect((await correct(1)).status).toBe(201);
      expect((await correct(1)).body.code).toBe('LOSS_CORRECTION_EXCEEDS');
      const l1 = (await byRef(p.id))['L-001'];
      // Unités rendues, lot toujours fermé : non vendable.
      expect(l1).toMatchObject({ remainingQuantity: 4, status: 'withdrawn' });
      const options = await http()
        .get(`/products/${p.id}/batches/sale-options`)
        .query({ quantity: 1 })
        .set(auth(o.token));
      expect(
        options.body.dated.map((x: { reference: string }) => x.reference),
      ).toEqual(['L-002']);
      expect((await raw(p.id))?.lossTracking?.netQuantity).toBe(0);
      const history = await http()
        .get(`/products/${p.id}/losses`)
        .set(auth(o.token));
      expect(history.body).toHaveLength(3);
      expect(
        history.body.filter((m: { kind: string }) => m.kind === 'correction'),
      ).toHaveLength(2);
      await expectConsistent(p.id, 10);
      // Remise à disposition explicite.
      expect(
        (await status(o.token, p.id, p.lot(1), 'release', 'erreur')).status,
      ).toBe(201);
      expect((await sell(o.token, p.id, p.lot(1), 1)).status).toBe(201);
      await expectConsistent(p.id, 10);
    });

    it('une perte peut franchir le seuil de stock faible (stock physique) sans être une vente', async () => {
      const o = await registerOwner('loss-threshold');
      const p = await tracked(o, [{ quantity: 10, in: 30 }]);
      await productModel.updateOne(
        { _id: new Types.ObjectId(p.id) },
        { $set: { lowStockThreshold: 5 } },
      );
      const loss = await lose(o.token, p.id, p.lot(1), { quantity: 6 });
      expect(loss.status).toBe(201);
      const low = await jobs({
        productId: new Types.ObjectId(p.id),
        category: PushCategory.STOCK_LOW,
      });
      expect(low.map((j) => j.eventKey)).toEqual([
        `stock-low:${p.id}:loss:${loss.body.lossId}`,
      ]);
      expect(
        await saleModel.countDocuments({ productId: new Types.ObjectId(p.id) }),
      ).toBe(0);
      const product = await http().get(`/products/${p.id}`).set(auth(o.token));
      expect(product.body.unitsSold).toBe(0);
      expect(product.body.status).toBe('low_stock');
    });

    it('vente et perte concurrentes sur les 2 dernières unités : une seule passe, jamais négatif', async () => {
      const o = await registerOwner('race');
      const p = await tracked(o, [{ quantity: 2, in: 30 }]);
      const [sale, loss] = await Promise.all([
        sell(o.token, p.id, p.lot(1), 2),
        lose(o.token, p.id, p.lot(1), { quantity: 2 }),
      ]);
      expect([sale.status, loss.status].sort()).toEqual([201, 409]);
      expect((await byRef(p.id))['L-001'].remainingQuantity).toBe(0);
      await expectConsistent(p.id, 2);
    });
  });

  describe('2. Mise à l’écart et restitutions', () => {
    it('lot entier mis à l’écart : stock physique inchangé, plus vendable ni réceptionnable ; restitution sans remise en vente', async () => {
      const o = await registerOwner('quarantine');
      const p = await tracked(o, [
        { quantity: 5, in: 20 },
        { quantity: 5, in: -1 },
        { quantity: 4, in: 40 },
      ]);
      const sale = await sell(o.token, p.id, p.lot(1), 2);
      expect((await status(o.token, p.id, p.lot(1), 'quarantine')).status).toBe(
        201,
      );
      // Lot dépassé ET mis à l'écart : compté une seule fois.
      expect((await status(o.token, p.id, p.lot(2), 'quarantine')).status).toBe(
        201,
      );
      expect(
        (await status(o.token, p.id, p.lot(2), 'quarantine')).body.code,
      ).toBe('BATCH_STATUS_UNCHANGED');
      const view = await list(o.token, p.id);
      expect(view.body).toMatchObject({
        totalQuantity: 12,
        sellableQuantity: 4,
        quarantinedQuantity: 8,
        expiredQuantity: 0,
      });
      expect((await raw(p.id))?.remainingQuantity).toBe(12);
      expect((await sell(o.token, p.id, p.lot(1), 1)).body.code).toBe(
        'BATCH_UNAVAILABLE',
      );
      const receive = await http()
        .post(`/products/${p.id}/batches/${p.lot(1)}/receptions`)
        .set(auth(o.token))
        .send({ clientOperationId: uuid(), quantity: 1 });
      expect([receive.status, receive.body.code]).toEqual([
        409,
        'BATCH_UNAVAILABLE',
      ]);
      // Annulation : unités rendues au lot d'origine, toujours à l'écart.
      expect(
        (await http().delete(`/sales/${sale.body._id}`).set(auth(o.token)))
          .status,
      ).toBe(204);
      expect((await byRef(p.id))['L-001']).toMatchObject({
        remainingQuantity: 5,
        status: 'quarantined',
      });
      const [cancelled] = await auditModel
        .find({
          productId: new Types.ObjectId(p.id),
          action: AuditAction.SALE_CANCELLED,
        })
        .lean();
      expect(
        (cancelled.details.batches as { nonSellable: unknown[] }).nonSellable,
      ).toEqual([
        { reference: 'L-001', status: 'quarantined', expired: false },
      ]);
      // Remise à disposition d'un lot dépassé : la date interdit toujours.
      expect(
        (await status(o.token, p.id, p.lot(2), 'release', 'vérifié')).status,
      ).toBe(201);
      expect((await sell(o.token, p.id, p.lot(2), 1)).body.code).toBe(
        'BATCH_EXPIRED',
      );
      const changed = await auditModel
        .find({
          productId: new Types.ObjectId(p.id),
          action: AuditAction.BATCH_STATUS_CHANGED,
        })
        .lean();
      expect(changed).toHaveLength(3);
      expect(changed[0].details).toMatchObject({
        status: { from: 'available', to: 'quarantined' },
        reason: 'contrôle qualité',
      });
      await expectConsistent(p.id, 14);
    });

    it('annulation d’une vente vers un lot retiré : restitution tracée, lot toujours fermé', async () => {
      const o = await registerOwner('withdrawn');
      const p = await tracked(o, [{ quantity: 5, in: 30 }, { quantity: 2 }]);
      const sale = await sell(o.token, p.id, p.lot(1), 2);
      expect(
        (await lose(o.token, p.id, p.lot(1), { quantity: 3 })).status,
      ).toBe(201);
      expect((await byRef(p.id))['L-001'].status).toBe('withdrawn');
      expect(
        (await http().delete(`/sales/${sale.body._id}`).set(auth(o.token)))
          .status,
      ).toBe(204);
      expect((await byRef(p.id))['L-001']).toMatchObject({
        remainingQuantity: 2,
        status: 'withdrawn',
      });
      expect((await list(o.token, p.id)).body).toMatchObject({
        withdrawnQuantity: 2,
        sellableQuantity: 2,
      });
      await expectConsistent(p.id, 7);
    });
  });

  describe('3. Permissions et isolation', () => {
    it('droits distincts ; la date ne donne pas le retrait ; quantités masquées ; autre commerce', async () => {
      const o = await registerOwner('rights-c');
      const p = await tracked(o, [{ quantity: 6, in: 30 }]);
      const dates = await seedMember(o.orgId, [
        'products.manage',
        'products.manage_expiry',
        'stock.adjust',
      ]);
      expect(
        (await lose(dates.token, p.id, p.lot(1), { quantity: 1 })).status,
      ).toBe(403);
      expect(
        (await status(dates.token, p.id, p.lot(1), 'quarantine')).status,
      ).toBe(403);
      const loser = await seedMember(o.orgId, ['stock.record_losses']);
      expect(
        (await lose(loser.token, p.id, p.lot(1), { quantity: 1 })).status,
      ).toBe(201);
      expect(
        (await status(loser.token, p.id, p.lot(1), 'quarantine')).status,
      ).toBe(403);
      // Historique des pertes : détail du stock exigé.
      expect(
        (await http().get(`/products/${p.id}/losses`).set(auth(loser.token)))
          .status,
      ).toBe(403);
      const quarantiner = await seedMember(o.orgId, [
        'stock.quarantine_batches',
      ]);
      expect(
        (await status(quarantiner.token, p.id, p.lot(1), 'quarantine')).status,
      ).toBe(201);
      const seller = await seedMember(o.orgId);
      const view = await list(seller.token, p.id);
      expect(view.body).not.toHaveProperty('quarantinedQuantity');
      expect(view.body.batches[0]).not.toHaveProperty('remainingQuantity');
      const other = await registerOwner('rights-c-other');
      expect(
        (await lose(other.token, p.id, p.lot(1), { quantity: 1 })).status,
      ).toBe(404);
      expect(
        (await status(other.token, p.id, p.lot(1), 'release')).status,
      ).toBe(404);
      await expectConsistent(p.id, 6);
    });

    it('membres : catalogue 5 (alertes seules) conserve les droits de lots, 7 les retire', async () => {
      const o = await registerOwner('catalog-c');
      const member = await seedMember(o.orgId, [
        'products.manage',
        'stock.record_losses',
        'products.manage_expiry_alerts',
      ]);
      const patch = (permissions: DelegablePermission[], catalog: number) =>
        http()
          .patch(`/organizations/members/${member.membershipId}`)
          .query({ permissionsCatalog: String(catalog) })
          .set(auth(o.token))
          .send({ permissions });
      const stored = async () =>
        (await membershipModel.findById(member.membershipId).lean())
          ?.permissions;
      expect((await patch(['products.manage'], 5)).status).toBe(200);
      expect(await stored()).toEqual(
        expect.arrayContaining(['products.manage', 'stock.record_losses']),
      );
      expect(await stored()).not.toContain('products.manage_expiry_alerts');
      expect((await patch(['products.manage'], 7)).status).toBe(200);
      expect(await stored()).toEqual(['products.manage']);
    });
  });

  describe('4. Alertes de péremption', () => {
    let o: { orgId: string; sectionId: string; token: string };
    let ownerDevice: string;

    async function device(token: string, preferences: Record<string, boolean>) {
      seq += 1;
      const browser = p256();
      const subscription = {
        endpoint: `https://fcm.googleapis.com/fcm/send/lotc-${seq}`,
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
            stockLow: false,
            stockDepleted: false,
            ...preferences,
          },
        });
      expect(res.status).toBe(200);
      return subscription.endpoint;
    }
    const expiryJobs = (filter: Record<string, unknown> = {}) =>
      jobs({
        organizationId: new Types.ObjectId(o.orgId),
        category: {
          $in: [PushCategory.EXPIRY_SOON, PushCategory.EXPIRY_EXPIRED],
        },
        ...filter,
      });

    beforeAll(async () => {
      o = await registerOwner('expiry');
      ownerDevice = await device(o.token, {});
    });

    it('produit sans lots : « bientôt » une fois, puis « périmé » au lendemain de l’échéance ; sans date / sans stock : rien', async () => {
      const id = await createProduct(o, 5, day(2));
      await createProduct(o, 5); // sans date
      const empty = await createProduct(o, 1, day(1));
      await productModel.updateOne(
        { _id: new Types.ObjectId(empty) },
        { $set: { remainingQuantity: 0 } },
      );
      // Balayage global (cibles des autres tests comprises) : on compte
      // celles de ce produit ; le second balayage n'ajoute rien.
      await dispatcher.scanExpiryAlerts();
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      expect(
        await expiryJobs({ productId: new Types.ObjectId(empty) }),
      ).toHaveLength(0);
      const [soon, ...others] = await expiryJobs({
        productId: new Types.ObjectId(id),
      });
      expect(others).toHaveLength(0);
      expect(soon).toMatchObject({
        category: PushCategory.EXPIRY_SOON,
        expiryDate: day(2),
        batchId: null,
      });
      await dispatcher.runOnce();
      expect(
        transport.to(ownerDevice).map((s) => s.payload.category),
      ).toContain('expiry-soon');
      // Le jour E reste valide ; E+1 : périmé.
      now = new Date(now.getTime() + 2 * DAY_MS);
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      now = new Date(now.getTime() + DAY_MS);
      expect(await dispatcher.scanExpiryAlerts()).toBe(1);
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      expect(
        (await expiryJobs({ productId: new Types.ObjectId(id) })).map(
          (j) => j.category,
        ),
      ).toEqual([PushCategory.EXPIRY_SOON, PushCategory.EXPIRY_EXPIRED]);
    });

    it('planificateur arrêté : une cible dépassée entre-temps ne reçoit que « périmé » ; scans concurrents sans doublon', async () => {
      const id = await createProduct(o, 3, day(10));
      now = new Date(now.getTime() + 40 * DAY_MS);
      const [a, b] = await Promise.all([
        dispatcher.scanExpiryAlerts(),
        dispatcher.scanExpiryAlerts(),
      ]);
      expect(a + b).toBeGreaterThanOrEqual(1);
      expect(
        (await expiryJobs({ productId: new Types.ObjectId(id) })).map(
          (j) => j.category,
        ),
      ).toEqual([PushCategory.EXPIRY_EXPIRED]);
    });

    it('lots : un lot mis à l’écart reste concerné ; lot vide puis réapprovisionné ; produit à la corbeille ignoré', async () => {
      const p = await tracked(o, [
        { quantity: 3, in: 1 },
        { quantity: 3, in: 1 },
        { quantity: 2, in: null },
        { quantity: 1, in: 3 },
      ]);
      await status(o.token, p.id, p.lot(2), 'quarantine');
      // L-004 vidé par une vente avant le balayage.
      expect((await sell(o.token, p.id, p.lot(4), 1)).status).toBe(201);
      await dispatcher.scanExpiryAlerts();
      const batchJobs = await expiryJobs({
        productId: new Types.ObjectId(p.id),
      });
      expect(batchJobs.map((j) => String(j.batchId)).sort()).toEqual(
        [p.lot(1), p.lot(2)].sort(),
      );
      // Réapprovisionnement de L-004 : annoncé au balayage suivant.
      expect(
        (
          await http()
            .post(`/products/${p.id}/batches/${p.lot(4)}/receptions`)
            .set(auth(o.token))
            .send({ clientOperationId: uuid(), quantity: 2 })
        ).status,
      ).toBe(201);
      expect(await dispatcher.scanExpiryAlerts()).toBe(1);
      // Corbeille : rien.
      const q = await tracked(o, [{ quantity: 2, in: 1 }]);
      expect(
        (await http().delete(`/products/${q.id}`).set(auth(o.token))).status,
      ).toBe(200);
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      expect(
        await expiryJobs({ productId: new Types.ObjectId(q.id) }),
      ).toHaveLength(0);
      // Détail du centre : état indiqué, quantité (droit de stock).
      await dispatcher.runOnce();
      const center = await http().get('/notifications').set(auth(o.token));
      const items = (center.body.items ?? center.body) as {
        id: string;
        category: string;
      }[];
      const expiryItem = items.find((n) => n.category === 'expiry-soon');
      expect(expiryItem).toBeDefined();
    });

    it('changement de date : nouvelle échéance réarmée, retour à la date annoncée sans répétition', async () => {
      const p = await tracked(o, [{ quantity: 4, in: 2 }]);
      await dispatcher.scanExpiryAlerts();
      const patch = (expiryDate: string) =>
        http()
          .patch(`/products/${p.id}/batches/${p.lot(1)}`)
          .set(auth(o.token))
          .send({ expiryDate });
      expect((await patch(day(4))).status).toBe(200);
      expect(await dispatcher.scanExpiryAlerts()).toBe(1);
      expect((await patch(day(2))).status).toBe(200);
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      // Modification sans changement de date : rien.
      await http()
        .patch(`/products/${p.id}/batches/${p.lot(1)}`)
        .set(auth(o.token))
        .send({ manufacturerLot: 'X-1' });
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      expect(
        await expiryJobs({ productId: new Types.ObjectId(p.id) }),
      ).toHaveLength(2);
    });

    it('passage au suivi par lots : la date de la fiche cesse d’alerter, aucun double envoi', async () => {
      const id = await createProduct(o, 6, day(3));
      expect(await dispatcher.scanExpiryAlerts()).toBe(1);
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 6,
            batches: [{ quantity: 6, expiryDate: day(3) }],
          })
        ).status,
      ).toBe(201);
      expect((await raw(id))?.expiryAlertNextOn ?? null).toBeNull();
      // Le lot a sa propre étape (cible distincte) ; la fiche, plus rien.
      expect(await dispatcher.scanExpiryAlerts()).toBe(1);
      now = new Date(now.getTime() + 4 * DAY_MS);
      await dispatcher.scanExpiryAlerts();
      const productJobs = await expiryJobs({
        productId: new Types.ObjectId(id),
        batchId: null,
      });
      expect(productJobs.map((j) => j.category)).toEqual([
        PushCategory.EXPIRY_SOON,
      ]);
    });

    it('revalidation avant envoi : stock vendu entre le balayage et l’envoi → annulée', async () => {
      const p = await tracked(o, [{ quantity: 2, in: 1 }]);
      await dispatcher.scanExpiryAlerts();
      expect((await sell(o.token, p.id, p.lot(1), 2)).status).toBe(201);
      await dispatcher.runOnce();
      const [job] = await expiryJobs({ productId: new Types.ObjectId(p.id) });
      expect(job).toMatchObject({ status: 'cancelled', outcome: 'no-stock' });
      expect(
        transport.sent.filter((x) => x.payload.tag.includes(p.lot(1))),
      ).toHaveLength(0);
    });

    it('délai : réglage autorisé (0 à 365), allongé → nouvelles cibles annoncées, sans réarmement', async () => {
      const id = await createProduct(o, 2, day(45));
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      const seller = await seedMember(o.orgId);
      const setLead = (token: string, leadDays: unknown) =>
        http()
          .patch('/expiry-alerts/settings')
          .set(auth(token))
          .send({ leadDays });
      expect((await setLead(seller.token, 60)).status).toBe(403);
      expect((await setLead(o.token, 366)).status).toBe(400);
      expect((await setLead(o.token, 60)).status).toBe(200);
      expect(await dispatcher.scanExpiryAlerts()).toBeGreaterThanOrEqual(1);
      expect(
        (await expiryJobs({ productId: new Types.ObjectId(id) })).map(
          (j) => j.category,
        ),
      ).toEqual([PushCategory.EXPIRY_SOON]);
      expect((await setLead(o.token, 10)).status).toBe(200);
      expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      expect((await setLead(o.token, 30)).status).toBe(200);
    });

    it('préférences et destinataires : « bientôt » coupé, vendeur sans détail du stock exclu', async () => {
      const viewer = await seedMember(o.orgId, ['products.view_stock_details']);
      const quiet = await device(viewer.token, { expirySoon: false });
      const seller = await seedMember(o.orgId);
      const sellerDevice = await device(seller.token, {});
      const p = await tracked(o, [{ quantity: 2, in: 1 }]);
      await dispatcher.scanExpiryAlerts();
      await dispatcher.runOnce();
      now = new Date(now.getTime() + 2 * DAY_MS);
      await dispatcher.scanExpiryAlerts();
      await dispatcher.runOnce();
      const tags = (endpoint: string) =>
        transport
          .to(endpoint)
          .filter((s) => s.payload.tag.includes(p.lot(1)))
          .map((s) => s.payload.category);
      expect(tags(ownerDevice)).toEqual(['expiry-soon', 'expiry-expired']);
      expect(tags(quiet)).toEqual(['expiry-expired']);
      expect(tags(sellerDevice)).toEqual([]);
      // Contenu générique : ni nom, ni lot, ni quantité.
      const [msg] = transport
        .to(ownerDevice)
        .filter((s) => s.payload.tag.includes(p.lot(1)));
      expect(msg.payload.body).not.toMatch(/\d/);
    });

    it('désactivées : aucun balayage, réglage refusé', async () => {
      process.env.EXPIRY_ALERTS_ENABLED = 'false';
      try {
        const id = await createProduct(o, 2, day(1));
        await dispatcher.runOnce();
        expect(
          await expiryJobs({ productId: new Types.ObjectId(id) }),
        ).toHaveLength(0);
        expect(
          (
            await http()
              .patch('/expiry-alerts/settings')
              .set(auth(o.token))
              .send({ leadDays: 10 })
          ).status,
        ).toBe(403);
      } finally {
        process.env.EXPIRY_ALERTS_ENABLED = 'true';
      }
    });

    it('Analyse : « Expire bientôt » et « Périmés », quantités selon les droits', async () => {
      const health = await http()
        .get('/analytics/stock-health')
        .set(auth(o.token));
      expect(health.status).toBe(200);
      expect(
        health.body.soon.length + health.body.expired.length,
      ).toBeGreaterThan(0);
      expect(health.body.soon[0]).toHaveProperty('quantity');
      const analyst = await seedMember(o.orgId, ['analytics.read']);
      const limited = await http()
        .get('/analytics/stock-health')
        .set(auth(analyst.token));
      expect(
        limited.body.soon[0] ?? limited.body.expired[0],
      ).not.toHaveProperty('quantity');
      expect(limited.body.losses).not.toHaveProperty('lostQuantity');
      const seller = await seedMember(o.orgId);
      expect(
        (await http().get('/analytics/stock-health').set(auth(seller.token)))
          .status,
      ).toBe(403);
    });
  });

  describe('5. Notification de régularisation (lot B)', () => {
    it('une notification par demande aux responsables ; annulée si décidée avant l’envoi', async () => {
      const o = await registerOwner('reg-notify');
      const id = await seedProduct(o.orgId, o.sectionId, 4);
      expect(
        (
          await enable(o.token, id, {
            expectedRemainingQuantity: 4,
            batches: [{ quantity: 4, expiryDate: day(-1) }],
          })
        ).status,
      ).toBe(201);
      const batchId = (await byRef(id))['L-001']._id.toHexString();
      const seller = await seedMember(o.orgId);
      const op = () => ({
        productId: id,
        quantity: 1,
        salePrice: 400,
        clientOperationId: uuid(),
        occurredAt: new Date(Date.now() - DAY_MS).toISOString(),
        batchAllocations: [{ batchId, quantity: 1 }],
      });
      const first = op();
      const req = await http()
        .post('/sales/regularizations')
        .set(auth(seller.token))
        .send(first);
      expect(req.status).toBe(201);
      await http()
        .post('/sales/regularizations')
        .set(auth(seller.token))
        .send(first);
      const regJobs = await jobs({
        category: PushCategory.REGULARIZATION_REQUESTED,
        organizationId: new Types.ObjectId(o.orgId),
      });
      expect(regJobs).toHaveLength(1);
      expect(String(regJobs[0].regularizationId)).toBe(req.body._id);
      await dispatcher.runOnce();
      const ownerCenter = await http().get('/notifications').set(auth(o.token));
      const ownerItems = (ownerCenter.body.items ?? ownerCenter.body) as {
        category: string;
        link?: string;
      }[];
      expect(
        ownerItems.filter((n) => n.category === 'regularization-requested'),
      ).toHaveLength(1);
      const sellerCenter = await http()
        .get('/notifications')
        .set(auth(seller.token));
      const sellerItems = (sellerCenter.body.items ?? sellerCenter.body) as {
        category: string;
      }[];
      expect(
        sellerItems.filter((n) => n.category === 'regularization-requested'),
      ).toHaveLength(0);
      // Décidée avant l'annonce : annulée.
      const second = await http()
        .post('/sales/regularizations')
        .set(auth(seller.token))
        .send(op());
      await http()
        .post(`/sales/regularizations/${second.body._id}/reject`)
        .set(auth(o.token))
        .send({ reason: 'doublon' });
      await dispatcher.runOnce();
      const [job2] = await jobs({
        regularizationId: new Types.ObjectId(String(second.body._id)),
      });
      expect(job2).toMatchObject({ status: 'cancelled', outcome: 'decided' });
      // Autre commerce : rien.
      const other = await registerOwner('reg-notify-other');
      const otherCenter = await http()
        .get('/notifications')
        .set(auth(other.token));
      const otherItems = (otherCenter.body.items ?? otherCenter.body) as {
        category: string;
      }[];
      expect(
        otherItems.filter((n) => n.category === 'regularization-requested'),
      ).toHaveLength(0);
    });
  });
  describe('6. Livraison : centre sans push, index, pilote, permissions', () => {
    afterEach(() => {
      process.env.EXPIRY_ALERTS_ORGANIZATIONS = 'all';
      process.env.PRODUCT_BATCHES_ORGANIZATIONS = 'all';
    });

    it('sans clés VAPID ni abonnement : la notification interne est créée, aucun push', async () => {
      const o = await registerOwner('center-only');
      const p = await tracked(o, [{ quantity: 2, in: 1 }]);
      const vapid = p256();
      runtime.deactivate();
      runtime.activateCenter();
      try {
        expect(runtime.pushActive).toBe(false);
        const sentBefore = transport.sent.length;
        await dispatcher.scanExpiryAlerts();
        await dispatcher.runOnce();
        const center = await http().get('/notifications').set(auth(o.token));
        const items = (center.body.items ?? center.body) as {
          category: string;
          link: string;
        }[];
        expect(
          items.filter(
            (n) => n.category === 'expiry-soon' && n.link.includes(p.id),
          ),
        ).toHaveLength(1);
        expect(transport.sent.length).toBe(sentBefore);
        const [job] = await jobs({ productId: new Types.ObjectId(p.id) });
        expect(job).toMatchObject({
          status: 'dispatched',
          outcome: 'push-disabled',
        });
      } finally {
        runtime.activate(
          {
            enabled: true,
            publicKey: vapid.getPublicKey().toString('base64url'),
            privateKey: vapid.getPrivateKey().toString('base64url'),
            subject: 'mailto:e2e@example.com',
          },
          transport,
        );
      }
    });

    it('index manquant : aucun balayage (ni parcours de secours) tant que la migration n’est pas faite', async () => {
      const o = await registerOwner('no-index');
      const p = await tracked(o, [{ quantity: 2, in: 1 }]);
      // Chacun des deux index (tous les commerces ; par commerce) est requis.
      for (const index of ['expiry_alert_due', 'expiry_alert_due_org']) {
        await connection.collection('productbatches').dropIndex(index);
        try {
          expect(await dispatcher.scanExpiryAlerts()).toBe(0);
          expect(
            await jobs({ productId: new Types.ObjectId(p.id) }),
          ).toHaveLength(0);
        } finally {
          await installExpiryAlerts(connection);
        }
      }
      expect(await dispatcher.scanExpiryAlerts()).toBeGreaterThanOrEqual(1);
      expect(await jobs({ productId: new Types.ObjectId(p.id) })).toHaveLength(
        1,
      );
    });

    it('commerces pilotes : seuls les commerces listés ; les autres inchangés (routes, contexte, balayage)', async () => {
      const pilot = await registerOwner('pilot');
      const other = await registerOwner('not-pilot');
      const pp = await tracked(pilot, [{ quantity: 2, in: 1 }]);
      const op = await tracked(other, [{ quantity: 2, in: 1 }]);
      process.env.EXPIRY_ALERTS_ORGANIZATIONS = pilot.orgId;
      process.env.PRODUCT_BATCHES_ORGANIZATIONS = pilot.orgId;
      const pilotContext = await http()
        .get('/auth/context')
        .set(auth(pilot.token));
      const otherContext = await http()
        .get('/auth/context')
        .set(auth(other.token));
      expect(pilotContext.body.features).toEqual({
        productBatches: true,
        expiryAlerts: true,
      });
      expect(otherContext.body.features).toEqual({
        productBatches: false,
        expiryAlerts: false,
      });
      // Routes des lots et ventes par lots : refusées hors pilote.
      expect((await list(other.token, op.id)).status).toBe(403);
      expect((await sell(other.token, op.id, op.lot(1), 1)).body.code).toBe(
        'PRODUCT_BATCHES_DISABLED',
      );
      expect((await sell(pilot.token, pp.id, pp.lot(1), 1)).status).toBe(201);
      expect(
        (
          await http()
            .patch('/expiry-alerts/settings')
            .set(auth(other.token))
            .send({ leadDays: 10 })
        ).status,
      ).toBe(403);
      // Balayage : le commerce non pilote n'est pas lu.
      await dispatcher.scanExpiryAlerts();
      const expiryJobs = (productId: string) =>
        jobs({
          productId: new Types.ObjectId(productId),
          category: { $in: ['expiry-soon', 'expiry-expired'] },
        });
      expect(await expiryJobs(pp.id)).toHaveLength(1);
      expect(await expiryJobs(op.id)).toHaveLength(0);
      // Drapeau activé, liste absente, vide ou invalide : aucun commerce ;
      // `all` (valeur explicite) : tous.
      const features = async () =>
        (await http().get('/auth/context').set(auth(other.token))).body
          .features as { productBatches: boolean; expiryAlerts: boolean };
      for (const value of [
        undefined,
        '',
        ' ',
        'invalide',
        `all,${pilot.orgId}`,
      ]) {
        if (value === undefined) {
          delete process.env.EXPIRY_ALERTS_ORGANIZATIONS;
          delete process.env.PRODUCT_BATCHES_ORGANIZATIONS;
        } else {
          process.env.EXPIRY_ALERTS_ORGANIZATIONS = value;
          process.env.PRODUCT_BATCHES_ORGANIZATIONS = value;
        }
        expect(await features()).toEqual({
          productBatches: false,
          expiryAlerts: false,
        });
        expect((await list(other.token, op.id)).status).toBe(403);
        expect(await dispatcher.scanExpiryAlerts()).toBe(0);
      }
      process.env.EXPIRY_ALERTS_ORGANIZATIONS = 'ALL';
      process.env.PRODUCT_BATCHES_ORGANIZATIONS = 'all';
      expect(await features()).toEqual({
        productBatches: true,
        expiryAlerts: true,
      });
      await dispatcher.scanExpiryAlerts();
      expect(await expiryJobs(op.id)).toHaveLength(1);
    });

    it('balayage pilote : des milliers de cibles échues hors pilote ne consomment pas la limite', async () => {
      const pilot = await registerOwner('scan-pilot');
      const other = await registerOwner('scan-crowd');
      const pp = await tracked(pilot, [{ quantity: 2, in: 1 }]);
      // Au-delà de la limite d'un balayage (pages × taille), toutes échues
      // AVANT la cible pilote dans l'ordre du balayage.
      const crowd = EXPIRY_ALERT_SCAN_PAGE * EXPIRY_ALERT_SCAN_MAX_PAGES + 200;
      const otherOid = new Types.ObjectId(other.orgId);
      await connection.collection('productbatches').insertMany(
        Array.from({ length: crowd }, (_, i) => ({
          organizationId: otherOid,
          productId: new Types.ObjectId(),
          reference: `CROWD-${i}`,
          expiryDate: '2000-01-31',
          expiryAlertNextOn: '2000-01-01',
          remainingQuantity: 1,
        })),
      );
      process.env.EXPIRY_ALERTS_ORGANIZATIONS = pilot.orgId;
      try {
        const scanned = async () => {
          const status = await connection.db!.admin().serverStatus();
          const executor = status.metrics.queryExecutor as {
            scanned: number;
            scannedObjects: number;
          };
          return executor.scanned + executor.scannedObjects;
        };
        const before = await scanned();
        expect(await dispatcher.scanExpiryAlerts()).toBe(1);
        // Clés et documents lus : quelques-uns, pas les milliers hors pilote.
        expect((await scanned()) - before).toBeLessThan(200);
        expect(
          await jobs({
            productId: new Types.ObjectId(pp.id),
            category: 'expiry-soon',
          }),
        ).toHaveLength(1);
        // Hors pilote : aucun événement d'alerte (aucune étape), aucune
        // marque posée, aucune notification, même après traitement.
        await dispatcher.runOnce();
        expect(
          await jobs({
            organizationId: otherOid,
            category: { $in: ['expiry-soon', 'expiry-expired'] },
          }),
        ).toHaveLength(0);
        expect(
          await connection.collection('productbatches').countDocuments({
            organizationId: otherOid,
            reference: /^CROWD-/,
            expiryAlertNextOn: '2000-01-01',
            expiryAlerts: { $exists: false },
          }),
        ).toBe(crowd);
        expect(
          await connection
            .collection(NOTIFICATIONS_COLLECTION)
            .countDocuments({ organizationId: otherOid }),
        ).toBe(0);
        // Pilote : notification interne créée pour son propriétaire.
        expect(
          await connection.collection(NOTIFICATIONS_COLLECTION).countDocuments({
            organizationId: new Types.ObjectId(pilot.orgId),
            category: 'expiry-soon',
          }),
        ).toBe(1);
      } finally {
        await connection
          .collection('productbatches')
          .deleteMany({ organizationId: otherOid, reference: /^CROWD-/ });
      }
    });

    it('retrait ciblé du lot C : stock.manage_batches conservé (retour vers le lot B)', async () => {
      const o = await registerOwner('strip-c');
      const member = await seedMember(o.orgId, [
        'stock.manage_batches',
        'stock.record_losses',
        'stock.quarantine_batches',
      ]);
      await stripBatchPermission(connection, LOT_C_PERMISSIONS);
      expect(
        (await membershipModel.findById(member.membershipId).lean())
          ?.permissions,
      ).toEqual(['stock.manage_batches']);
      // Inventaire : pertes comptées (condition d'un retour vers le lot B).
      const p = await tracked(o, [{ quantity: 3, in: 40 }]);
      const before = (await inventoryProductBatches(connection)).losses;
      expect(
        (await lose(o.token, p.id, p.lot(1), { quantity: 1 })).status,
      ).toBe(201);
      expect((await inventoryProductBatches(connection)).losses).toBe(
        before + 1,
      );
    });

    it('inventaire des premières alertes (lecture seule) : par commerce pilote, sans identifiant', async () => {
      const o = await registerOwner('inventory');
      await tracked(o, [
        { quantity: 1, in: 2 },
        { quantity: 1, in: -3 },
        { quantity: 1, in: 90 },
      ]);
      const inventory = await firstAlertInventory(connection, [o.orgId], now);
      expect(inventory.pilots).toEqual([{ pilot: 1, soon: 1, expired: 1 }]);
      expect(JSON.stringify(inventory)).not.toContain(o.orgId);
    });
  });
});
