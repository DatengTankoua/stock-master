import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { Product } from './../src/products/schemas/product.schema';
import { ProductsService } from './../src/products/products.service';
import { validateProductImage } from './../src/products/product-image-validation';
import {
  StorageQuotaService,
  type StagedObject,
} from './../src/storage-quota/storage-quota.service';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import {
  PRODUCT_CAPACITY,
  PRODUCT_CAPACITY_REACHED,
} from './../src/products/product-capacity';
import { S3Service, type StoredObjectRef } from './../src/s3/s3.service';
import {
  StoredObject,
  type StoredObjectDocument,
} from './../src/storage-quota/schemas/stored-object.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';
import { postRegister } from './e2e/registration-fixtures';

const emailSender = createE2eEmailSender();

/**
 * E2E 1-21D — capacité incluse : 1 000 fiches produit conservées par
 * organisation, corbeille comprise.
 *
 * Replica set éphémère (vraies transactions, vrais conflits d'écriture) ;
 * stockage SIMULÉ en mémoire (espionnage de `S3Service`, aucun réseau).
 * Les fiches de remplissage sont insérées directement (rapide) ; les fiches
 * testées passent par la VRAIE route `POST /products` (photo comprise).
 */

const TEST_JWT_SECRET = 'product-capacity-e2e-only-secret';
const PASSWORD = 'capacity-21d-pw-!1x';

describe('E2E 1-21D — capacité incluse (fiches produit)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let s3: S3Service;
  let productModel: Model<ProductDocument>;
  let objectModel: Model<StoredObjectDocument>;
  let saleModel: Model<SaleDocument>;
  let png = Buffer.alloc(0);
  const bucket = new Map<string, number>();

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let seq = 0;
  const createProduct = (token: string, section: string, name?: string) =>
    http()
      .post('/products')
      .set(auth(token))
      .field('sectionId', section)
      .field('name', name ?? `Fiche HTTP ${++seq}`)
      .field('purchasePrice', '5')
      .field('salePrice', '10')
      .field('initialQuantity', '3')
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' });
  const capacity = async (token: string) =>
    (await http().get('/products/capacity').set(auth(token))).body as {
      used: number;
      trashed: number;
      limit: number;
    };
  const conserved = (orgId: string) =>
    productModel.countDocuments({ organizationId: new Types.ObjectId(orgId) });

  /** Fiches insérées directement (sans photo), noms uniques. */
  async function seed(
    orgId: string,
    sectionId: string,
    count: number,
    extra: Partial<Record<string, unknown>> = {},
  ): Promise<void> {
    const docs = Array.from({ length: count }, () => ({
      organizationId: new Types.ObjectId(orgId),
      sectionId: new Types.ObjectId(sectionId),
      name: `Remplissage ${++seq}`,
      purchasePrice: 1,
      salePrice: 2,
      initialQuantity: 1,
      remainingQuantity: 0, // rupture de stock : compte quand même
      ...extra,
    }));
    for (let i = 0; i < docs.length; i += 500) {
      await productModel.insertMany(docs.slice(i, i + 500));
    }
  }

  async function login(email: string) {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    return res.body.access_token as string;
  }

  /** Organisation neuve : propriétaire connecté et un rayon. */
  async function organization(label: string) {
    const email = `owner-${label}-21d@stockmaster.test`;
    const res = await postRegister(app, {
      ...OWNER_TERMS,
      name: `Capacité ${label}`,
      email,
      password: PASSWORD,
      organizationName: `Capacité ${label}`,
    });
    expect(res.status).toBe(202);
    const orgId = res.owner!.organization._id;
    const token = await login(email);
    const section = await http()
      .post('/sections')
      .set(auth(token))
      .send({ name: `Rayon ${label}`, description: '' });
    expect(section.status).toBe(201);
    return { orgId, token, sectionId: section.body._id as string };
  }

  beforeAll(async () => {
    png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#a70' },
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
      process.env.CORS_ORIGIN = 'https://capacity-e2e.example.com';
      process.env.PUBLIC_APP_URL = 'https://app.capacity-e2e.test';
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

      s3 = moduleFixture.get(S3Service);
      productModel = moduleFixture.get(getModelToken(Product.name));
      objectModel = moduleFixture.get(getModelToken(StoredObject.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));
      jest
        .spyOn(s3, 'uploadValidatedImage')
        .mockImplementation((body, _prefix, _image, options) => {
          const key = options?.key as string;
          bucket.set(key, body.length);
          return Promise.resolve({ key, storage: s3.storage });
        });
      jest
        .spyOn(s3, 'deleteStoredObject')
        .mockImplementation(async (ref: StoredObjectRef | null) => {
          await Promise.resolve();
          if (!ref) return 'not_needed';
          bucket.delete(ref.key);
          return 'deleted';
        });
      jest
        .spyOn(s3, 'headStoredObject')
        .mockImplementation(async (ref: StoredObjectRef) => {
          await Promise.resolve();
          const bytes = bucket.get(ref.key);
          return bytes === undefined
            ? { state: 'absent' }
            : { state: 'present', bytes };
        });
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. 1 000e fiche acceptée, 1 001e refusée (409, message, aucune photo conservée) ; capacité lue par le serveur', async () => {
    const o = await organization('limite');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY - 1);
    expect(await capacity(o.token)).toEqual({
      used: PRODUCT_CAPACITY - 1,
      trashed: 0,
      limit: PRODUCT_CAPACITY,
    });

    const thousandth = await createProduct(o.token, o.sectionId);
    expect(thousandth.status).toBe(201);
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);

    const objectsBefore = await objectModel.countDocuments({
      organizationId: new Types.ObjectId(o.orgId),
    });
    const refused = await createProduct(o.token, o.sectionId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe(PRODUCT_CAPACITY_REACHED);
    expect(refused.body.message).toContain('corbeille comprise');
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);
    // Refus avant l'envoi : aucune photo comptabilisée en plus.
    expect(
      await objectModel.countDocuments({
        organizationId: new Types.ObjectId(o.orgId),
      }),
    ).toBe(objectsBefore);

    const en = await createProduct(o.token, o.sectionId).set(
      'Accept-Language',
      'en',
    );
    expect(en.status).toBe(409);
    expect(en.body.message).toContain('trash included');
  });

  it('2. créations SIMULTANÉES à 998 (transaction de création) : exactement 2 acceptées, jamais au-delà de 1 000', async () => {
    const o = await organization('concurrence');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY - 2);
    const service = moduleFixture.get(ProductsService);
    const quota = moduleFixture.get(StorageQuotaService);
    // Photos comptabilisées par le VRAI service de stockage, au préalable :
    // les six créations entrent ensuite ensemble dans la transaction.
    const validated = await validateProductImage({
      buffer: png,
      size: png.length,
      mimetype: 'image/png',
    });
    const images: StagedObject[] = [];
    for (let i = 0; i < 6; i += 1) {
      images.push(
        await quota.store({
          organizationId: o.orgId,
          kind: 'product_image',
          body: png,
          image: validated,
        }),
      );
    }
    // Fenêtre de course DÉTERMINISTE : 300 ms entre le décompte fait dans
    // la transaction et l'insertion. Sans la sérialisation, les six
    // créations verraient 998 et passeraient (vérifié par mutation).
    const serviceModel = (
      service as unknown as { productModel: Model<ProductDocument> }
    ).productModel;
    const original = serviceModel.countDocuments.bind(serviceModel);
    const spy = jest.spyOn(serviceModel, 'countDocuments').mockImplementation(((
      filter: object,
      options?: { session?: unknown },
    ) => {
      const query = original(filter, options);
      if (!options?.session) return query;
      const exec = query.exec.bind(query);
      (query as { exec: () => Promise<number> }).exec = async () => {
        const value = await exec();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return value;
      };
      return query;
    }) as never);
    try {
      const actor = new Types.ObjectId().toHexString();
      const results = await Promise.allSettled(
        images.map((image, i) =>
          service.create(
            o.orgId,
            {
              sectionId: o.sectionId,
              name: `Concurrente ${i}`,
              purchasePrice: 5,
              salePrice: 10,
              initialQuantity: 3,
            },
            image,
            actor,
          ),
        ),
      );
      const accepted = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r): r is PromiseRejectedResult =>
          r.status === 'rejected' &&
          (r.reason as { response?: { code?: string } }).response?.code ===
            PRODUCT_CAPACITY_REACHED,
      );
      expect(accepted).toHaveLength(2);
      expect(refused).toHaveLength(4);
      expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);
      // Photos des créations refusées : libérées, comme le fait la route.
      await Promise.all(
        images
          .filter((_, i) => results[i].status === 'rejected')
          .map((image) => quota.discard(image)),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('3. isolation : une organisation pleine ne limite pas une autre', async () => {
    const full = await organization('pleine');
    const other = await organization('voisine');
    await seed(full.orgId, full.sectionId, PRODUCT_CAPACITY);
    expect((await createProduct(full.token, full.sectionId)).status).toBe(409);
    expect((await createProduct(other.token, other.sectionId)).status).toBe(
      201,
    );
    expect((await capacity(other.token)).used).toBe(1);
  });

  it('4. au plafond : corbeille et restauration permises sans changer le compteur ; ventes, lecture et modification conservées', async () => {
    const o = await organization('corbeille');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY - 1);
    const created = await createProduct(o.token, o.sectionId, 'Vendable');
    expect(created.status).toBe(201);
    const id = created.body._id as string;

    const trashed = await http().delete(`/products/${id}`).set(auth(o.token));
    expect(trashed.status).toBe(200);
    expect(await capacity(o.token)).toMatchObject({
      used: PRODUCT_CAPACITY,
      trashed: 1,
    });
    // Corbeille comprise : toujours au plafond.
    expect((await createProduct(o.token, o.sectionId)).status).toBe(409);

    const restored = await http()
      .patch(`/products/${id}/restore`)
      .set(auth(o.token));
    expect(restored.status).toBe(200);
    expect(await capacity(o.token)).toMatchObject({
      used: PRODUCT_CAPACITY,
      trashed: 0,
    });

    const read = await http().get(`/products/${id}`).set(auth(o.token));
    expect(read.status).toBe(200);
    const edited = await http()
      .patch(`/products/${id}`)
      .set(auth(o.token))
      .field('salePrice', '12');
    expect(edited.status).toBe(200);
    const sale = await http()
      .post('/sales')
      .set(auth(o.token))
      .send({ productId: id, quantity: 1, salePrice: 10 });
    expect([200, 201]).toContain(sale.status);
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);
  });

  it('5. suppression définitive : une place libérée, l’historique des ventes conservé', async () => {
    const o = await organization('purge');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY - 1);
    const created = await createProduct(o.token, o.sectionId, 'À purger');
    expect(created.status).toBe(201);
    const id = created.body._id as string;
    const sale = await http()
      .post('/sales')
      .set(auth(o.token))
      .send({ productId: id, quantity: 1, salePrice: 10 });
    expect([200, 201]).toContain(sale.status);
    expect((await createProduct(o.token, o.sectionId)).status).toBe(409);

    expect(
      (await http().delete(`/products/${id}`).set(auth(o.token))).status,
    ).toBe(200);
    const purged = await http()
      .delete(`/products/${id}/permanent`)
      .set(auth(o.token));
    expect(purged.status).toBe(200);
    expect((await capacity(o.token)).used).toBe(PRODUCT_CAPACITY - 1);
    // Les ventes ne comptent pas et restent conservées.
    expect(
      await saleModel.countDocuments({
        organizationId: new Types.ObjectId(o.orgId),
      }),
    ).toBe(1);
    expect((await createProduct(o.token, o.sectionId)).status).toBe(201);
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);
  });

  it('6. échec ou rejeu sans dérive : refus métier, nom en double et requête invalide ne consomment aucune place', async () => {
    const o = await organization('derive');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY - 2);
    const first = await createProduct(o.token, o.sectionId, 'Doublon');
    expect(first.status).toBe(201);
    // Même nom : refus métier APRÈS le contrôle de capacité.
    const duplicate = await createProduct(o.token, o.sectionId, 'Doublon');
    expect(duplicate.status).not.toBe(201);
    // Requête invalide (prix manquant).
    const invalid = await http()
      .post('/products')
      .set(auth(o.token))
      .field('sectionId', o.sectionId)
      .field('name', 'Incomplet')
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' });
    expect(invalid.status).toBe(400);
    expect((await capacity(o.token)).used).toBe(PRODUCT_CAPACITY - 1);
    // La dernière place reste disponible, une seule fois.
    expect((await createProduct(o.token, o.sectionId)).status).toBe(201);
    expect((await createProduct(o.token, o.sectionId)).status).toBe(409);
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY);
  });

  it('7. organisation déjà AU-DELÀ du plafond : données conservées, créations seules refusées jusqu’au retour sous 1 000', async () => {
    const o = await organization('depassement');
    await seed(o.orgId, o.sectionId, PRODUCT_CAPACITY + 5);
    expect((await capacity(o.token)).used).toBe(PRODUCT_CAPACITY + 5);
    expect((await createProduct(o.token, o.sectionId)).status).toBe(409);
    // Rien n'est supprimé automatiquement ; lecture et liste fonctionnent.
    expect(await conserved(o.orgId)).toBe(PRODUCT_CAPACITY + 5);
    const page = await http()
      .get('/products')
      .query({ sectionId: o.sectionId, limit: 10 })
      .set(auth(o.token));
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(PRODUCT_CAPACITY + 5);
  });

  it('8. lecture de la capacité réservée à la gestion des produits', async () => {
    const res = await http().get('/products/capacity');
    expect(res.status).toBe(401);
  });
});
