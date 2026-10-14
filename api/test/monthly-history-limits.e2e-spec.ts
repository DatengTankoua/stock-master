import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  AuditAction,
  AuditLogDocument,
} from './../src/audit/schemas/audit-log.schema';
import { monthBounds } from './../src/analytics/month-range';
import {
  MembershipStatus,
  OrganizationRole,
} from './../src/organizations/permissions';
import { Organization } from './../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { MonthlyHistoryService } from './../src/reports/monthly-history.service';
import {
  REPORT_GENERATION_LIMITS_TOKEN,
  ReportGenerationLimiter,
} from './../src/reports/report-generation-limiter';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from './e2e/subscription-fixtures';
import { barrier } from './e2e/barriers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-16D — protection de la génération des historiques. Paramètres de
 * test réduits par le jeton `REPORT_GENERATION_LIMITS_TOKEN` (production :
 * `REPORT_GENERATION_LIMITS`). Courses ORDONNÉES par barrière posée sur
 * `MonthlyHistoryService.build`, sans attente à durée fixe.
 */

const TEST_JWT_SECRET = 'e2e-only-static-secret-not-production-use';
const PASSWORD = 'lim-16d-pw-!1x';
const ORG_A = 'e16d0000000000000000000a';
const ORG_B = 'e16d0000000000000000000b';
// 1-22E : volumes au plafond et au-delà.
const ORG_C = 'e22e0000000000000000000c';
const ORG_D = 'e22e0000000000000000000d';
const ORG_E = 'e22e0000000000000000000e';
const MONTH = '2025-06';
const LIMITS = {
  windowMs: 60 * 60_000,
  // 1-22E : demandes (comptage compris) ; jamais atteint par les comptes
  // des tests 1-16D (au plus 5 demandes chacun).
  maxRequestsPerWindow: 8,
  maxCountingGlobal: 2,
  maxCountingPerOrganization: 1,
  maxPerWindow: 4,
  maxActiveGlobal: 2,
  maxActivePerOrganization: 1,
  busyRetryAfterSeconds: 9,
  // 1-22E : plafonds réduits ; un PDF au plafond coûte 3 × 4 = 12, deux ne
  // tiennent pas ensemble dans le budget de 16.
  maxRows: { xlsx: 6, pdf: 3 },
  rowCost: { xlsx: 1, pdf: 4 },
  maxActiveCost: 16,
};

describe('E2E 1-16D — limitation de la génération des historiques', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let limiter: ReportGenerationLimiter;
  let history: MonthlyHistoryService;
  let ownerA = '';
  let adminA = '';
  let ownerB = '';
  let ownerC = '';
  let ownerD = '';
  let adminC = '';
  let ownerE = '';
  let ownerEId: Types.ObjectId;
  let ownerCId: Types.ObjectId;
  let ownerDId: Types.ObjectId;
  let saleModel: Model<SaleDocument>;
  let auditModel: Model<AuditLogDocument>;

  /** Ventes du mois testé, vendues par un compte existant du commerce. */
  const seedSales = (org: string, seller: Types.ObjectId, count: number) => {
    const { start } = monthBounds(MONTH);
    return saleModel.insertMany(
      Array.from({ length: count }, (_, i) => ({
        organizationId: new Types.ObjectId(org),
        productId: new Types.ObjectId(),
        productName: `Article ${i}`,
        quantity: 1 + i,
        salePrice: 250,
        sellerId: seller,
        occurredAt: new Date(start.getTime() + (i + 1) * 3_600_000),
      })),
    );
  };

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (token: string, format = 'xlsx') =>
    http().get(`/reports/monthly/${MONTH}/${format}`).set(auth(token));

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
      process.env.CORS_ORIGIN = 'https://e2e.example.com';

      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .overrideProvider(REPORT_GENERATION_LIMITS_TOKEN)
        .useValue(LIMITS)
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
      limiter = moduleFixture.get(ReportGenerationLimiter);
      history = moduleFixture.get(MonthlyHistoryService);

      const userModel = moduleFixture.get<Model<UserDocument>>(
        getModelToken('User'),
      );
      const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
        getModelToken(Organization.name),
      );
      const membershipModel = moduleFixture.get<
        Model<OrganizationMembershipDocument>
      >(getModelToken(OrganizationMembership.name));
      saleModel = moduleFixture.get(getModelToken('Sale'));
      auditModel = moduleFixture.get(getModelToken('AuditLog'));
      for (const [id, slug] of [
        [ORG_A, 'limite-a-16d'],
        [ORG_B, 'limite-b-16d'],
        [ORG_C, 'volume-c-22e'],
        [ORG_D, 'volume-d-22e'],
        [ORG_E, 'course-e-22e'],
      ]) {
        await organizationModel.create({ _id: id, slug, name: slug });
      }
      await activateTestSubscriptions(moduleFixture, [
        ORG_A,
        ORG_B,
        ORG_C,
        ORG_D,
        ORG_E,
      ]);
      const hash = await bcrypt.hash(PASSWORD, 10);
      const member = async (
        email: string,
        org: string,
        role: OrganizationRole,
      ) => {
        const user = await userModel.create({
          emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
          name: email.split('@')[0],
          email,
          password: hash,
        });
        await membershipModel.create({
          organizationId: new Types.ObjectId(org),
          userId: user._id,
          role,
          status: MembershipStatus.ACTIVE,
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password: PASSWORD });
        expect(login.status).toBe(201);
        return {
          token: login.body.access_token as string,
          userId: user._id,
        };
      };
      ownerA = (
        await member('owner-a-lim@e2e.test', ORG_A, OrganizationRole.OWNER)
      ).token;
      adminA = (
        await member('admin-a-lim@e2e.test', ORG_A, OrganizationRole.ADMIN)
      ).token;
      ownerB = (
        await member('owner-b-lim@e2e.test', ORG_B, OrganizationRole.OWNER)
      ).token;
      const c = await member(
        'owner-c-vol@e2e.test',
        ORG_C,
        OrganizationRole.OWNER,
      );
      const d = await member(
        'owner-d-vol@e2e.test',
        ORG_D,
        OrganizationRole.OWNER,
      );
      [ownerC, ownerCId, ownerD, ownerDId] = [
        c.token,
        c.userId,
        d.token,
        d.userId,
      ];
      adminC = (
        await member('admin-c-vol@e2e.test', ORG_C, OrganizationRole.ADMIN)
      ).token;
      const e = await member(
        'owner-e-race@e2e.test',
        ORG_E,
        OrganizationRole.OWNER,
      );
      [ownerE, ownerEId] = [e.token, e.userId];
      await seedSales(ORG_E, ownerEId, 1);
      // Chacun exactement au plafond du PDF (3 lignes).
      await seedSales(ORG_C, ownerCId, 3);
      await seedSales(ORG_D, ownerDId, 3);
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('simultanéité : 503 temporaire et compréhensible, place rendue après succès', async () => {
    const gate = barrier();
    const entered = barrier();
    const original = history.build.bind(history);
    jest.spyOn(history, 'build').mockImplementationOnce(async (...args) => {
      entered.release();
      await gate.wait();
      return original(...args);
    });
    const first = get(ownerA).then((r) => r);
    try {
      await entered.wait();
      expect(limiter.active).toBe(1);

      // Même commerce (borne par commerce = 1) : refus temporaire.
      const busy = await get(adminA, 'pdf');
      expect(busy.status).toBe(503);
      expect(busy.body.code).toBe('REPORT_GENERATION_BUSY');
      expect(busy.headers['retry-after']).toBe('9');
      expect(busy.body.message).toContain('Réessayez dans quelques secondes');
      // Autre commerce : servi (borne globale = 2).
      expect((await get(ownerB)).status).toBe(200);
    } finally {
      // Toujours rouverte, même après un échec : jamais de requête bloquée.
      gate.release();
    }
    expect((await first).status).toBe(200);
    expect(limiter.active).toBe(0);
    // Place rendue : Excel puis PDF normalement.
    expect((await get(adminA, 'xlsx')).status).toBe(200);
    expect((await get(adminA, 'pdf')).status).toBe(200);
  });

  it('place rendue après une erreur de génération', async () => {
    jest
      .spyOn(history, 'build')
      .mockRejectedValueOnce(new Error('panne simulée'));
    expect((await get(ownerB)).status).toBe(500);
    expect(limiter.active).toBe(0);
    expect((await get(ownerB, 'pdf')).status).toBe(200);
  });

  it('quota par compte : 429 avec Retry-After, sans effet sur les autres comptes ni les autres routes', async () => {
    // ownerA : 1 admission au test précédent ; 3 de plus atteignent 4.
    for (let i = 0; i < 3; i++) {
      expect((await get(ownerA, i % 2 ? 'pdf' : 'xlsx')).status).toBe(200);
    }
    const limited = await get(ownerA, 'pdf');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('REPORT_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.message).toContain('Trop de téléchargements');
    expect(limiter.active).toBe(0);

    // Autres comptes et autres routes : inchangés.
    expect((await get(adminA)).status).toBe(200);
    expect(
      (await http().get('/reports/monthly').set(auth(ownerA))).status,
    ).toBe(200);
    expect(
      (
        await http()
          .get('/analytics/overview')
          .query({ month: MONTH })
          .set(auth(ownerA))
      ).status,
    ).toBe(200);
    // Contrôles d'accès et de saisie AVANT le quota : 400, jamais 429.
    expect(
      (await http().get('/reports/monthly/2025-13/pdf').set(auth(ownerA)))
        .status,
    ).toBe(400);
    // La connexion (compteurs du ThrottlerModule) reste disponible.
    expect(
      (
        await http()
          .post('/auth/login')
          .send({ email: 'owner-a-lim@e2e.test', password: PASSWORD })
      ).status,
    ).toBe(201);
  });

  it('1-22E : capacité globale en coût — deux PDF au plafond ne sont pas rendus ensemble', async () => {
    const gate = barrier();
    const entered = barrier();
    const original = history.build.bind(history);
    jest.spyOn(history, 'build').mockImplementationOnce(async (...args) => {
      entered.release();
      await gate.wait();
      return original(...args);
    });
    const first = get(ownerC, 'pdf').then((r) => r);
    try {
      await entered.wait();
      expect(limiter.activeCostTotal).toBe(12);
      // Autre commerce, simultanéité globale (2) non atteinte : refusé par
      // le COÛT cumulé (12 + 12 > 16), sans rien générer.
      const busy = await get(ownerD, 'pdf');
      expect(busy.status).toBe(503);
      expect(busy.body.code).toBe('REPORT_GENERATION_BUSY');
      expect(busy.headers['retry-after']).toBe('9');
      // Un export léger d'un autre commerce passe (coût 1).
      expect((await get(ownerB)).status).toBe(200);
    } finally {
      gate.release();
    }
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.headers['content-type']).toBe('application/pdf');
    expect(limiter.active).toBe(0);
    expect(limiter.activeCostTotal).toBe(0);
    expect((await get(ownerD, 'pdf')).status).toBe(200);
  });

  it('1-22E : volume au-delà du plafond — 422 explicite, aucun fichier, rien chargé', async () => {
    const months = await http().get('/reports/monthly').set(auth(ownerC));
    expect(months.body.maxRows).toEqual({ xlsx: 6, pdf: 3 });

    // Une annulation du mois porte le total à 4 lignes : PDF refusé.
    await auditModel.collection.insertOne({
      organizationId: new Types.ObjectId(ORG_C),
      productId: new Types.ObjectId(),
      action: AuditAction.SALE_CANCELLED,
      actorId: ownerCId,
      details: { quantity: 1, salePrice: 250 },
      createdAt: new Date(monthBounds(MONTH).start.getTime() + 60_000),
    });
    const build = jest.spyOn(history, 'build');
    const pdf = await get(ownerC, 'pdf');
    expect(pdf.status).toBe(422);
    expect(pdf.headers['content-type']).toMatch(/^application\/json/);
    expect(pdf.headers['content-disposition']).toBeUndefined();
    expect(pdf.body).toMatchObject({
      code: 'REPORT_TOO_LARGE',
      format: 'pdf',
      rows: 4,
      maxRows: 3,
      alternative: 'xlsx',
    });
    expect(pdf.body.message).toContain('Aucun fichier');
    expect(pdf.body.message).toContain('version Excel');
    const en = await http()
      .get(`/reports/monthly/${MONTH}/pdf`)
      .query({ lang: 'en' })
      .set(auth(ownerC));
    expect(en.status).toBe(422);
    expect(en.body.message).toContain('No file was created');
    // Refusé au comptage : aucune lecture des ventes, aucune place prise.
    expect(build).not.toHaveBeenCalled();
    expect(limiter.active).toBe(0);

    // L'action proposée existe : l'Excel du même mois est complet.
    const xlsx = await get(ownerC, 'xlsx');
    expect(xlsx.status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);

    // 3 ventes de plus : 7 lignes > 6, l'Excel est refusé à son tour.
    await seedSales(ORG_C, ownerCId, 3);
    const tooBig = await get(ownerC, 'xlsx');
    expect(tooBig.status).toBe(422);
    expect(tooBig.body).toMatchObject({
      code: 'REPORT_TOO_LARGE',
      format: 'xlsx',
      rows: 7,
      maxRows: 6,
      alternative: 'support',
    });
    // Aide proposée sans promettre d'export : aucun outil ne le produit.
    expect(tooBig.body.message).toContain("contacter l'assistance");
    expect(build).toHaveBeenCalledTimes(1);

    // Isolation des données et des plafonds individuels : le volume de C
    // ne compte pas pour D (la capacité globale, elle, reste partagée).
    expect((await get(ownerD, 'pdf')).status).toBe(200);
  });

  it('1-22E : ventes ajoutées entre comptage et lecture — lecture plafonnée, 422, place rendue', async () => {
    // Comptage sous-estimé (course simulée) ; la lecture réelle voit 7
    // lignes et s'arrête à 6 + 1 : aucun fichier partiel.
    jest.spyOn(history, 'countRows').mockResolvedValueOnce(1);
    const raced = await get(ownerC, 'xlsx');
    expect(raced.status).toBe(422);
    expect(raced.body.code).toBe('REPORT_TOO_LARGE');
    expect(raced.headers['content-disposition']).toBeUndefined();
    expect(limiter.active).toBe(0);
    expect(limiter.activeCostTotal).toBe(0);
  });
  it('1-22E : demandes répétées d’un mois trop volumineux — admission avant comptage', async () => {
    const count = jest.spyOn(history, 'countRows');
    const build = jest.spyOn(history, 'build');
    // Compte neuf (adminC) : 8 demandes admises, toutes 422 (7 lignes > 6).
    for (let i = 0; i < 8; i++) {
      expect((await get(adminC, 'xlsx')).status).toBe(422);
    }
    expect(count).toHaveBeenCalledTimes(8);
    // 9e : 429 AVANT tout comptage, avec délai ; distinct du quota de
    // génération (aucune génération n'a eu lieu).
    const limited = await get(adminC, 'xlsx');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('REPORT_REQUESTS_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(count).toHaveBeenCalledTimes(8);
    expect(build).not.toHaveBeenCalled();
    expect(limiter.counting).toBe(0);

    // Comptages simultanés d'un même commerce bornés (1) : 503, place
    // rendue ensuite.
    const gate = barrier();
    const entered = barrier();
    const original = history.countRows.bind(history);
    count.mockImplementationOnce(async (...args) => {
      entered.release();
      await gate.wait();
      return original(...args);
    });
    const first = get(ownerC, 'xlsx').then((r) => r);
    try {
      await entered.wait();
      expect(limiter.counting).toBe(1);
      const busy = await get(ownerC, 'pdf');
      expect(busy.status).toBe(503);
      expect(busy.body.code).toBe('REPORT_GENERATION_BUSY');
      // Autre commerce : son comptage passe (borne globale = 2).
      expect((await get(ownerD, 'xlsx')).status).toBe(200);
    } finally {
      gate.release();
    }
    expect((await first).status).toBe(422);
    expect(limiter.counting).toBe(0);
  });

  it('1-22E : volume accru après comptage, sous le plafond — coût ajusté aux lignes chargées', async () => {
    // Comptage : 1 vente. Puis, avant la lecture : 2 ventes et 1
    // annulation de plus → 4 lignes chargées (≤ 6).
    const count = jest.spyOn(history, 'countRows');
    const originalCount = history.countRows.bind(history);
    count.mockImplementationOnce(async (...args) => {
      const counted = await originalCount(...args);
      await seedSales(ORG_E, ownerEId, 2);
      await auditModel.collection.insertOne({
        organizationId: new Types.ObjectId(ORG_E),
        productId: new Types.ObjectId(),
        action: AuditAction.SALE_CANCELLED,
        actorId: ownerEId,
        details: { quantity: 1, salePrice: 250 },
        createdAt: new Date(monthBounds(MONTH).start.getTime() + 60_000),
      });
      return counted;
    });
    const originalBuild = history.build.bind(history);
    let reservedForRender = -1;
    jest.spyOn(history, 'build').mockImplementationOnce(async (...args) => {
      const built = await originalBuild(...args);
      reservedForRender = limiter.activeCostTotal;
      return built;
    });
    const res = await get(ownerE, 'xlsx');
    expect(res.status).toBe(200);
    expect(await count.mock.results[0].value).toBe(1);
    // Réservé pendant le rendu : 4 lignes (ventes + annulation), pas 1.
    expect(reservedForRender).toBe(4);
    expect(limiter.activeCostTotal).toBe(0);
  });

  it('1-22E : ajustement impossible faute de budget — 503, aucun fichier, ressources libérées', async () => {
    // Un PDF au plafond (coût 12) occupe le budget (16).
    const gate = barrier();
    const entered = barrier();
    const originalBuild = history.build.bind(history);
    jest.spyOn(history, 'build').mockImplementationOnce(async (...args) => {
      entered.release();
      await gate.wait();
      return originalBuild(...args);
    });
    const held = get(ownerD, 'pdf').then((r) => r);
    try {
      await entered.wait();
      expect(limiter.activeCostTotal).toBe(12);
      // E compte 4 lignes (coût 4 : 16 ≤ 16, admis) ; 2 ventes arrivent
      // avant la lecture → 6 lignes (≤ 6) : 12 + 6 > 16, refus.
      const originalCount = history.countRows.bind(history);
      jest
        .spyOn(history, 'countRows')
        .mockImplementationOnce(async (...args) => {
          const counted = await originalCount(...args);
          await seedSales(ORG_E, ownerEId, 2);
          return counted;
        });
      const refused = await get(ownerE, 'xlsx');
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('REPORT_GENERATION_BUSY');
      expect(refused.headers['retry-after']).toBe('9');
      expect(refused.headers['content-disposition']).toBeUndefined();
      // Place et coût d'E rendus ; seul D reste réservé.
      expect(limiter.active).toBe(1);
      expect(limiter.activeCostTotal).toBe(12);
    } finally {
      gate.release();
    }
    expect((await held).status).toBe(200);
    expect(limiter.active).toBe(0);
    expect(limiter.activeCostTotal).toBe(0);
    // Budget libre : le même export passe entier.
    expect((await get(ownerE, 'xlsx')).status).toBe(200);
  });
});
