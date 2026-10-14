import 'reflect-metadata';
import { monitorEventLoopDelay } from 'perf_hooks';
import { writeFileSync } from 'fs';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { UserDocument } from '../../src/users/schemas/user.schema';
import {
  MembershipStatus,
  OrganizationRole,
} from '../../src/organizations/permissions';
import { Organization } from '../../src/organizations/schemas/organization.schema';
import type { OrganizationDocument } from '../../src/organizations/schemas/organization.schema';
import { OrganizationMembership } from '../../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from '../../src/organizations/schemas/membership.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from '../e2e/ephemeral-mongodb';
import { activateTestSubscriptions } from '../e2e/subscription-fixtures';
import { EMAIL_SENDER } from '../../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from '../e2e/email-verification-fixtures';

/**
 * 1-22E — sonde locale de l'export mensuel (piste 7 de l'audit 1-22A).
 * MongoDB éphémère, données synthétiques, aucune campagne de charge.
 *
 *   NODE_OPTIONS=--max-old-space-size=512 PROBE_SIZES=5000,20000,50000 \
 *   PROBE_OUT=/chemin/resultats.json \
 *   npx jest --config test/jest-e2e.json \
 *     --testRegex 'load/monthly-export-probe.ts$' --runInBand
 *
 * Mesures par export : durée, réponse (statut, octets), retard maximal de
 * la boucle d'événements, pic de mémoire échantillonné, et latence d'une
 * requête légère d'un AUTRE commerce envoyée en continu pendant l'export.
 * Le client supertest partage le processus : la latence inclut donc tout
 * blocage de la boucle, ce que subirait un vrai client.
 */

const MONTH = '2025-06';
const PASSWORD = 'probe-22e-pw-!1x';
const SIZES = (process.env.PROBE_SIZES ?? '5000,20000,50000')
  .split(',')
  .map(Number);
/** Commerces volumineux exportés simultanément (borne globale = 3). */
const CONCURRENT = Number(process.env.PROBE_CONCURRENT ?? 3);
/** Ventes de chacun de ces commerces (défaut : le plus gros volume). */
const CONCURRENT_SIZE = Number(
  process.env.PROBE_CONCURRENT_SIZE ?? Math.max(...SIZES),
);

interface Sample {
  label: string;
  status: number[];
  bytes: number[];
  durationMs: number;
  loopDelayMaxMs: number;
  loopDelayP99Ms: number;
  rssPeakMb: number;
  heapPeakMb: number;
  quietRequests: number;
  quietMaxMs: number;
  quietP50Ms: number;
}

describe('1-22E — sonde export mensuel', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  const tokens = new Map<string, string>();
  const results: Sample[] = [];
  const http = () => request(app.getHttpServer());

  async function seedOrganization(
    slug: string,
    salesCount: number,
  ): Promise<void> {
    const id = new Types.ObjectId();
    const organizationModel = moduleFixture.get<Model<OrganizationDocument>>(
      getModelToken(Organization.name),
    );
    const membershipModel = moduleFixture.get<
      Model<OrganizationMembershipDocument>
    >(getModelToken(OrganizationMembership.name));
    const userModel = moduleFixture.get<Model<UserDocument>>(
      getModelToken('User'),
    );
    await organizationModel.create({ _id: id, slug, name: slug });
    await activateTestSubscriptions(moduleFixture, [String(id)]);
    const email = `${slug}@probe.test`;
    const owner = await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      name: `Owner ${slug}`.slice(0, 20),
      email,
      password: await bcrypt.hash(PASSWORD, 4),
    });
    await membershipModel.create({
      organizationId: id,
      userId: owner._id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
    });
    const db = organizationModel.db;
    const sellers = [owner._id];
    for (let i = 0; i < 5; i++) {
      const s = await userModel.create({
        emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
        name: `V${i} ${slug}`.slice(0, 20),
        email: `seller${i}-${slug}@probe.test`,
        password: 'x',
      });
      sellers.push(s._id);
    }
    const sectionId = new Types.ObjectId();
    const products = Array.from({ length: 200 }, (_, i) => ({
      _id: new Types.ObjectId(),
      organizationId: id,
      sectionId,
      name: `Produit ${i} — ${slug} avec un nom assez long`,
      imageKey: null,
      imageStorage: null,
      purchasePrice: 500 + i,
      salePrice: 1000 + i,
      initialQuantity: 1_000_000,
      remainingQuantity: 1_000_000,
      deletedAt: null,
      createdAt: new Date(2025, 0, 1),
      updatedAt: new Date(2025, 0, 1),
    }));
    await db.collection('products').insertMany(products);
    const start = new Date(2025, 5, 1).getTime();
    const span = new Date(2025, 6, 1).getTime() - start - 1;
    const batch = 10_000;
    for (let offset = 0; offset < salesCount; offset += batch) {
      const docs: Record<string, unknown>[] = [];
      for (let i = offset; i < Math.min(salesCount, offset + batch); i++) {
        const p = products[i % products.length];
        const at = new Date(start + Math.floor((span * i) / salesCount));
        docs.push({
          organizationId: id,
          productId: p._id,
          productName: p.name,
          quantity: 1 + (i % 4),
          salePrice: p.salePrice,
          sellerId: sellers[i % sellers.length],
          buyerName: `Client ${i}`,
          buyerContact: `+2376${String(i).padStart(8, '0')}`,
          occurredAt: at,
          createdAt: at,
          updatedAt: at,
        });
      }
      await db.collection('sales').insertMany(docs, { ordered: false });
    }
    const login = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(201);
    tokens.set(slug, login.body.access_token as string);
  }

  /** Exécute `run` en mesurant boucle, mémoire et requête légère. */
  async function measure(
    label: string,
    run: () => Promise<request.Response[]>,
  ): Promise<Sample> {
    global.gc?.();
    const loop = monitorEventLoopDelay({ resolution: 5 });
    let rssPeak = 0;
    let heapPeak = 0;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      rssPeak = Math.max(rssPeak, m.rss);
      heapPeak = Math.max(heapPeak, m.heapUsed);
    }, 5);
    let running = true;
    const quiet: number[] = [];
    const quietToken = tokens.get('quiet')!;
    const pinger = (async () => {
      while (running) {
        const t0 = performance.now();
        const r = await http()
          .get('/reports/monthly')
          .set('Authorization', `Bearer ${quietToken}`);
        expect(r.status).toBe(200);
        quiet.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    loop.enable();
    const t0 = performance.now();
    const responses = await run();
    const durationMs = performance.now() - t0;
    const m = process.memoryUsage();
    rssPeak = Math.max(rssPeak, m.rss);
    heapPeak = Math.max(heapPeak, m.heapUsed);
    running = false;
    await pinger;
    loop.disable();
    clearInterval(sampler);
    quiet.sort((a, b) => a - b);
    const sample: Sample = {
      label,
      status: responses.map((r) => r.status),
      bytes: responses.map((r) =>
        Buffer.isBuffer(r.body) ? r.body.length : JSON.stringify(r.body).length,
      ),
      durationMs: Math.round(durationMs),
      loopDelayMaxMs: Math.round(loop.max / 1e6),
      loopDelayP99Ms: Math.round(loop.percentile(99) / 1e6),
      rssPeakMb: Math.round(rssPeak / 2 ** 20),
      heapPeakMb: Math.round(heapPeak / 2 ** 20),
      quietRequests: quiet.length,
      quietMaxMs: Math.round(quiet[quiet.length - 1] ?? 0),
      quietP50Ms: Math.round(quiet[Math.floor(quiet.length / 2)] ?? 0),
    };
    results.push(sample);
    const statusCounts: Record<number, number> = {};
    for (const st of sample.status)
      statusCounts[st] = (statusCounts[st] ?? 0) + 1;
    console.log(
      JSON.stringify({ ...sample, status: statusCounts, bytes: undefined }),
    );
    return sample;
  }

  const download = (slug: string, format: 'xlsx' | 'pdf') =>
    http()
      .get(`/reports/monthly/${MONTH}/${format}`)
      .set('Authorization', `Bearer ${tokens.get(slug)!}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    process.env.MONGODB_URI = validatedEphemeralUri(replSet);
    process.env.JWT_SECRET = 'e2e-only-static-secret-not-production-use';
    process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'e2e-local';
    process.env.S3_SECRET_KEY = 'e2e-local';
    process.env.S3_BUCKET = 'e2e-local';
    process.env.S3_FORCE_PATH_STYLE = 'true';
    process.env.CORS_ORIGIN = 'https://e2e.example.com';
    const emailSender = createE2eEmailSender();
    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    autoConfirmVerificationEmails(app, emailSender);

    await seedOrganization('quiet', 50);
    for (const n of SIZES) await seedOrganization(`big-${n}`, n);
    for (let i = 1; i < CONCURRENT + 1; i++) {
      await seedOrganization(`conc-${i}`, CONCURRENT_SIZE);
    }
  }, 1_800_000);

  afterAll(async () => {
    if (process.env.PROBE_OUT) {
      writeFileSync(process.env.PROBE_OUT, JSON.stringify(results, null, 2));
    }
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('repère : requête légère seule', async () => {
    await measure('baseline (aucun export)', async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return [];
    });
  });

  // `PROBE_REPEAT=<n>` : n demandes simultanées d'un même compte sur le mois
  // trop volumineux (422 attendu) ; `PROBE_ONLY=repeat` saute le reste.
  const REPEAT = Number(process.env.PROBE_REPEAT ?? 0);
  const ONLY_REPEAT = process.env.PROBE_ONLY === 'repeat';

  (REPEAT > 0 ? it : it.skip)(
    'demandes répétées d’un mois trop volumineux',
    async () => {
      const largest = Math.max(...SIZES);
      await measure(
        `${REPEAT} demandes pdf simultanées de ${largest} ventes`,
        () =>
          Promise.all(
            Array.from({ length: REPEAT }, () =>
              download(`big-${largest}`, 'pdf'),
            ),
          ),
      );
    },
    1_800_000,
  );

  (ONLY_REPEAT ? it.skip : it)(
    'exports isolés par volume',
    async () => {
      for (const n of SIZES) {
        for (const format of ['xlsx', 'pdf'] as const) {
          await measure(`${format} ${n} ventes`, async () => [
            await download(`big-${n}`, format),
          ]);
        }
      }
    },
    1_800_000,
  );

  (ONLY_REPEAT ? it.skip : it)(
    'exports simultanés (commerces distincts) + un de trop',
    async () => {
      const largest = Math.max(...SIZES);
      await measure(
        `${CONCURRENT} xlsx simultanés de ${CONCURRENT_SIZE} ventes + 1 de ${largest}`,
        () =>
          Promise.all([
            ...Array.from({ length: CONCURRENT }, (_, i) =>
              download(`conc-${i + 1}`, 'xlsx'),
            ),
            download(`big-${largest}`, 'xlsx'),
          ]),
      );
    },
    1_800_000,
  );
});
