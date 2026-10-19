import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Types, createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  PRODUCT_BATCH_GUARD_VALIDATOR,
  canonicalJson,
  describeProductBatchGuardProblem,
} from '../src/products/batches/product-batch-guard';
import { describeExpiryAlertIndexProblem } from '../src/products/expiry/expiry-alert-index';
import { nextExpiryAlertOn } from '../src/products/expiry/expiry-alerts';
import { planExpiryAlerts } from '../src/migrations/expiry-alerts';
import { PREDEPLOY_MIGRATIONS } from '../src/migrations/predeploy-migrations';

/**
 * Pré-déploiement des lots A à C sur base ÉPHÉMÈRE : l'orchestrateur
 * COMPILÉ (`dist/`, comme sur Railway) installe la garde des lots puis
 * prépare les alertes de péremption. Prérequis : `pnpm --filter api build`.
 */
const ORCHESTRATOR = join(
  __dirname,
  '..',
  'dist',
  'migrations',
  'predeploy-migrations.js',
);

describe('Pré-déploiement : lots et alertes de péremption (e2e)', () => {
  let replSet: MongoMemoryReplSet;
  let uri: string;
  let connection: Connection;

  const orgA = new Types.ObjectId();
  const orgB = new Types.ObjectId();
  const ids = {
    p1: new Types.ObjectId(), // daté, commerce A (délai 10 j)
    p2: new Types.ObjectId(), // daté, commerce B (délai par défaut 30 j)
    p3: new Types.ObjectId(), // daté, déjà planifié par l'API
    p4: new Types.ObjectId(), // sans date
    p5: new Types.ObjectId(), // suivi par lots
    p6: new Types.ObjectId(), // daté, passé aux lots en parallèle (test 5)
    b1: new Types.ObjectId(), // lot daté en stock
    b2: new Types.ObjectId(), // lot daté vide
    member: new Types.ObjectId(),
  };

  const col = (name: string) => connection.db!.collection(name);
  // Asynchrone : un `spawnSync` bloquerait la lecture des journaux du
  // mongod éphémère (lancé par ce processus), qui se figerait.
  const run = (target = uri) =>
    new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [ORCHESTRATOR], {
        env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: target },
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += String(chunk)));
      child.stderr.on('data', (chunk: Buffer) => (output += String(chunk)));
      child.on('close', (status) => resolve({ status, output }));
    });
  const productsValidator = async () =>
    (
      (await connection
        .db!.listCollections({ name: 'products' })
        .toArray()) as Array<{ options?: Record<string, unknown> }>
    )[0]?.options;
  const indexNames = async (name: string) =>
    (
      (await col(name)
        .indexes()
        .catch(() => [])) as Array<{ name?: string }>
    )
      .map((i) => i.name)
      .sort();
  const snapshot = async () => ({
    products: await col('products').find().sort({ _id: 1 }).toArray(),
    batches: await col('productbatches').find().sort({ _id: 1 }).toArray(),
    organizations: await col('organizations').find().sort({ _id: 1 }).toArray(),
    memberships: await col('organizationmemberships').find().toArray(),
    validator: await productsValidator(),
    indexes: {
      products: await indexNames('products'),
      productbatches: await indexNames('productbatches'),
      stock_losses: await indexNames('stock_losses'),
    },
  });
  const nextOn = async (name: string, id: Types.ObjectId) =>
    (await col(name).findOne({ _id: id }))?.expiryAlertNextOn as
      string | undefined;
  const without = (doc: Record<string, unknown>) => {
    const copy = { ...doc };
    delete copy.expiryAlertNextOn;
    return copy;
  };

  beforeAll(async () => {
    if (!existsSync(ORCHESTRATOR)) {
      throw new Error('dist absent : lancer `pnpm --filter api build` avant.');
    }
    replSet = await startEphemeralMongo();
    uri = validatedEphemeralUri(replSet);
    connection = await createConnection(uri).asPromise();
    await col('organizations').insertMany([
      { _id: orgA, name: 'A', expiryAlertLeadDays: 10 },
      { _id: orgB, name: 'B' },
    ]);
    const product = (
      _id: Types.ObjectId,
      organizationId: Types.ObjectId,
      extra: Record<string, unknown>,
    ) => ({
      _id,
      organizationId,
      name: `P-${_id.toHexString()}`,
      initialQuantity: 5,
      remainingQuantity: 5,
      purchasePrice: 100,
      sellingPrice: 150,
      deletedAt: null,
      ...extra,
    });
    await col('products').insertMany([
      product(ids.p1, orgA, { expiryDate: '2031-06-30' }),
      product(ids.p2, orgB, { expiryDate: '2031-06-30' }),
      product(ids.p3, orgA, {
        expiryDate: '2031-01-10',
        expiryAlertNextOn: '2030-12-01',
      }),
      product(ids.p4, orgA, {}),
      product(ids.p5, orgA, {
        expiryDate: '2031-02-02',
        stockTracking: 'batches',
        batchTracking: { totalQuantity: 5 },
      }),
    ]);
    await col('productbatches').insertMany([
      {
        _id: ids.b1,
        organizationId: orgA,
        productId: ids.p5,
        reference: 'L-1',
        expiryDate: '2031-03-01',
        remainingQuantity: 5,
      },
      {
        _id: ids.b2,
        organizationId: orgA,
        productId: ids.p5,
        reference: 'L-2',
        expiryDate: '2031-04-01',
        remainingQuantity: 0,
      },
    ]);
    await col('organizationmemberships').insertOne({
      _id: ids.member,
      organizationId: orgA,
      permissions: ['stock.manage_batches', 'stock.record_losses'],
    });
  }, 180_000);

  afterAll(async () => {
    if (connection) await connection.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('ordre : garde des lots puis alertes, après les migrations existantes', () => {
    expect(PREDEPLOY_MIGRATIONS.slice(-2)).toEqual([
      'install-product-batches.js',
      'install-expiry-alerts.js',
    ]);
  });

  it('1. premier passage : garde, index, planification ; rien d’autre', async () => {
    const before = await snapshot();
    const { status, output } = await run();
    expect(status).toBe(0);
    expect(output).toContain('install-product-batches.js');
    expect(output).toContain('install-expiry-alerts.js');
    expect(output).toContain('toutes les migrations sont appliquées');
    expect(output).not.toContain(uri);
    expect(output).not.toContain('127.0.0.1');

    expect(await describeProductBatchGuardProblem(connection)).toBeNull();
    expect(canonicalJson((await productsValidator())?.validator)).toBe(
      canonicalJson(PRODUCT_BATCH_GUARD_VALIDATOR),
    );
    expect(await describeExpiryAlertIndexProblem(connection)).toBeNull();

    expect(await nextOn('products', ids.p1)).toBe(
      nextExpiryAlertOn('2031-06-30', 10, null),
    );
    expect(await nextOn('products', ids.p2)).toBe(
      nextExpiryAlertOn('2031-06-30', 30, null),
    );
    expect(await nextOn('products', ids.p3)).toBe('2030-12-01');
    expect(await nextOn('products', ids.p4)).toBeUndefined();
    expect(await nextOn('products', ids.p5)).toBeUndefined();
    expect(await nextOn('productbatches', ids.b1)).toBe(
      nextExpiryAlertOn('2031-03-01', 10, null),
    );

    // Données conservées : seul `expiryAlertNextOn` a pu être ajouté.
    const after = await snapshot();
    expect(after.products.map(without)).toEqual(before.products.map(without));
    expect(after.batches.map(without)).toEqual(before.batches.map(without));
    expect(after.organizations).toEqual(before.organizations);
    expect(after.memberships).toEqual(before.memberships);
    // Aucune conversion, aucune activation, aucune notification.
    expect(
      await col('products').countDocuments({ stockTracking: 'batches' }),
    ).toBe(1);
    expect(await col('push_jobs').countDocuments()).toBe(0);
    expect(await col('notifications').countDocuments()).toBe(0);
    expect(process.env.PRODUCT_BATCHES_ENABLED).toBeUndefined();
    expect(process.env.EXPIRY_ALERTS_ENABLED).toBeUndefined();
  }, 240_000);

  it('2. second passage : aucun effet supplémentaire', async () => {
    const before = await snapshot();
    const { status, output } = await run();
    expect(status).toBe(0);
    expect(output).toContain('garde déjà présente');
    expect(output).toContain('0 cible(s) planifiée(s)');
    expect(await snapshot()).toEqual(before);
  }, 240_000);

  it('3. reprise après installation partielle : seuls les éléments manquants', async () => {
    const validator = await productsValidator();
    await col('stock_losses').dropIndex('organizationId_1_createdAt_-1');
    await col('productbatches').dropIndex('expiry_alert_due_org');
    await col('products').updateOne(
      { _id: ids.p1 },
      { $unset: { expiryAlertNextOn: 1 } },
    );
    expect(await describeProductBatchGuardProblem(connection)).not.toBeNull();
    expect(await describeExpiryAlertIndexProblem(connection)).not.toBeNull();

    const { status } = await run();
    expect(status).toBe(0);
    expect(await describeProductBatchGuardProblem(connection)).toBeNull();
    expect(await describeExpiryAlertIndexProblem(connection)).toBeNull();
    expect(await productsValidator()).toEqual(validator);
    expect(await nextOn('products', ids.p1)).toBe(
      nextExpiryAlertOn('2031-06-30', 10, null),
    );
    expect(await nextOn('products', ids.p3)).toBe('2030-12-01');
  }, 240_000);

  it('4. planification interrompue puis reprise', async () => {
    const targets = [
      ['products', ids.p1],
      ['products', ids.p2],
      ['productbatches', ids.b1],
      ['productbatches', ids.b2],
    ] as const;
    for (const [name, id] of targets) {
      await col(name).updateOne(
        { _id: id },
        { $unset: { expiryAlertNextOn: 1 } },
      );
    }
    let calls = 0;
    await expect(
      planExpiryAlerts(connection, {
        batchSize: 1,
        beforeWrite: () => {
          calls += 1;
          if (calls === 2) throw new Error('interruption simulée');
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('interruption simulée');
    const done = await Promise.all(
      targets.map(([name, id]) => nextOn(name, id)),
    );
    expect(done.filter(Boolean)).toHaveLength(1);

    await expect(planExpiryAlerts(connection)).resolves.toEqual({
      planned: 3,
      skipped: 0,
    });
    expect(await nextOn('productbatches', ids.b2)).toBe(
      nextExpiryAlertOn('2031-04-01', 10, null),
    );
  });

  it('5. modification concurrente : ni date ni planification écrasées', async () => {
    await col('products').insertOne({
      _id: ids.p6,
      organizationId: orgA,
      name: 'P6',
      initialQuantity: 4,
      remainingQuantity: 4,
      purchasePrice: 1,
      sellingPrice: 2,
      deletedAt: null,
      expiryDate: '2031-07-07',
    });
    for (const id of [ids.p1, ids.p2]) {
      await col('products').updateOne(
        { _id: id },
        { $unset: { expiryAlertNextOn: 1 } },
      );
    }
    await col('productbatches').updateOne(
      { _id: ids.b1 },
      { $unset: { expiryAlertNextOn: 1 } },
    );
    let interfered = false;
    const result = await planExpiryAlerts(connection, {
      beforeWrite: async (name) => {
        if (interfered || name !== 'products') {
          if (name === 'productbatches') {
            // API à jour : nouvelle date ET sa propre planification.
            await col('productbatches').updateOne(
              { _id: ids.b1, expiryAlertNextOn: { $exists: false } },
              {
                $set: {
                  expiryDate: '2031-12-31',
                  expiryAlertNextOn: '2031-12-21',
                },
              },
            );
          }
          return;
        }
        interfered = true;
        // API antérieure : date modifiée, sans planification.
        await col('products').updateOne(
          { _id: ids.p1 },
          { $set: { expiryDate: '2031-09-30' } },
        );
        // API à jour : planification écrite entre lecture et écriture.
        await col('products').updateOne(
          { _id: ids.p2 },
          { $set: { expiryAlertNextOn: '2031-01-01' } },
        );
        // Produit passé aux lots entre-temps.
        await col('products').updateOne(
          { _id: ids.p6 },
          {
            $set: {
              stockTracking: 'batches',
              batchTracking: { totalQuantity: 4 },
            },
          },
        );
      },
    });
    expect(result.skipped).toBe(0);
    // Relue à la passe suivante : planifiée sur la NOUVELLE date.
    expect(await nextOn('products', ids.p1)).toBe(
      nextExpiryAlertOn('2031-09-30', 10, null),
    );
    expect(await nextOn('products', ids.p2)).toBe('2031-01-01');
    expect(await nextOn('products', ids.p6)).toBeUndefined();
    expect(await nextOn('productbatches', ids.b1)).toBe('2031-12-21');
    expect(
      (await col('productbatches').findOne({ _id: ids.b1 }))?.expiryDate,
    ).toBe('2031-12-31');
  });

  it('6. échec : code non nul, étapes suivantes non lancées, rien d’écrasé', async () => {
    const failureUri = replSet.getUri('inventory_saas_e2e_predeploy_failure');
    const other = connection.useDb('inventory_saas_e2e_predeploy_failure');
    const foreign = { name: { $type: 'string' } };
    await other.db!.createCollection('products', { validator: foreign });

    const { status, output } = await run(failureUri);
    expect(status).not.toBe(0);
    expect(output).toContain('un autre validateur existe déjà');
    expect(output).toContain('échec de install-product-batches.js');
    expect(output).not.toContain('[pré-déploiement] install-expiry-alerts.js');
    expect(output).not.toContain('127.0.0.1');

    const options = (
      (await other
        .db!.listCollections({ name: 'products' })
        .toArray()) as Array<{
        options?: { validator?: unknown };
      }>
    )[0]?.options;
    expect(options?.validator).toEqual(foreign);
    expect(
      (
        (await other.db!.collection('products').indexes()) as Array<{
          name?: string;
        }>
      ).map((i) => i.name),
    ).not.toContain('expiry_alert_due');
  }, 240_000);
});
