import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { Test as TestType } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * 1-22D.1 — La base validée par la garde e2e est EXACTEMENT celle que
 * l'application transmet au connecteur, quels que soient le répertoire de
 * lancement, l'environnement hérité et un `.env` présent.
 *
 * Aucune base réelle : `.env` FACTICE dans un répertoire temporaire (les
 * vrais `.env` ne sont jamais lus) ; `mongoose.createConnection` intercepté :
 * toute URI non locale est refusée par l'interception elle-même, sans
 * réseau. Seul le MongoDB éphémère local (127.0.0.1) est joint.
 */

const FORBIDDEN_ENV_FILE_URI =
  'mongodb://dev-from-env-file.invalid:27017/heyama';
const FORBIDDEN_INHERITED_URI =
  'mongodb://inherited-shell.invalid:27017/heyama';
const FAKE_ENV_FILE = [
  `MONGODB_URI=${FORBIDDEN_ENV_FILE_URI}`,
  'JWT_SECRET=fake-env-file-secret-1-22d1-not-used',
  'E2E_FAKE_ENV_FILE_MARKER=loaded',
  '',
].join('\n');

const SAVED_ENV = { ...process.env };
const SAVED_CWD = process.cwd();

type AppModuleType = new (...args: never[]) => unknown;

interface Loaded {
  AppModule: AppModuleType;
  /** `@nestjs/testing` du MÊME registre que cet `AppModule`. */
  Test: typeof TestType;
  /** URI reçues par `mongoose.createConnection`, dans l'ordre. */
  connections: string[];
}

/**
 * Importe un `AppModule` NEUF depuis `cwd` (son `ConfigModule` est évalué à
 * l'import), avec `createConnection` intercepté dans le même registre.
 */
async function loadAppModule(cwd: string): Promise<Loaded> {
  const connections: string[] = [];
  let AppModule!: AppModuleType;
  let Test!: typeof TestType;
  process.chdir(cwd);
  try {
    await jest.isolateModulesAsync(async () => {
      // Instance utilisée par `@nestjs/mongoose` (chemin pnpm qui lui est propre).
      const mongoosePath = require.resolve('mongoose', {
        paths: [dirname(require.resolve('@nestjs/mongoose'))],
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mongoose = require(mongoosePath) as typeof import('mongoose');
      const original = mongoose.createConnection.bind(mongoose);
      jest.spyOn(mongoose, 'createConnection').mockImplementation(((
        uri: string,
        options?: object,
      ) => {
        connections.push(uri);
        // Interception : seule une adresse locale est jamais contactée.
        if (new URL(uri).hostname !== '127.0.0.1') {
          throw new Error('Connexion interceptée (hôte non local).');
        }
        return original(uri, options);
      }) as never);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ AppModule } = require('./../src/app.module') as {
        AppModule: AppModuleType;
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ Test } = require('@nestjs/testing') as { Test: typeof TestType });
      await Promise.resolve();
    });
  } finally {
    process.chdir(SAVED_CWD);
  }
  return { AppModule, Test, connections };
}

/** Compile l'application ; échec borné (aucune attente de reconnexion). */
async function compile(
  { AppModule, Test }: Pick<Loaded, 'AppModule' | 'Test'>,
  waitMs = 5_000,
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('compile timeout')), waitMs);
  });
  const compiling = Test.createTestingModule({
    imports: [AppModule as never],
  }).compile();
  compiling.catch(() => undefined);
  try {
    return await Promise.race([compiling, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Isolation de la configuration des tests (e2e 1-22D.1)', () => {
  let fakeDir: string;

  beforeAll(() => {
    fakeDir = mkdtempSync(join(tmpdir(), 'config-isolation-22d1-'));
    writeFileSync(join(fakeDir, '.env'), FAKE_ENV_FILE);
  });

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, SAVED_ENV);
    delete process.env.MONGODB_URI;
    process.env.JWT_SECRET = 'config-isolation-22d1-e2e-only-secret';
    process.env.CORS_ORIGIN = 'https://config-isolation-22d1.example.com';
  });

  afterAll(async () => {
    process.chdir(SAVED_CWD);
    rmSync(fakeDir, { recursive: true, force: true });
    await stopEphemeralMongoSafe();
  }, 60_000);

  it('1. `.env` factice avec une URI interdite : aucune connexion, `.env` jamais chargé', async () => {
    const loaded = await loadAppModule(fakeDir);
    const { connections } = loaded;
    const error = await compile(loaded).catch((e: Error) => e);
    console.log(
      'MESURE 1',
      JSON.stringify({
        connections,
        error: (error as Error).message,
        marker: process.env.E2E_FAKE_ENV_FILE_MARKER ?? null,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(connections).toEqual([]);
    expect(process.env.E2E_FAKE_ENV_FILE_MARKER).toBeUndefined();
  });

  it('2. URI interdite héritée de l’environnement : aucune connexion', async () => {
    process.env.MONGODB_URI = FORBIDDEN_INHERITED_URI;
    const loaded = await loadAppModule(fakeDir);
    const { connections } = loaded;
    const error = await compile(loaded).catch((e: Error) => e);
    console.log(
      'MESURE 2',
      JSON.stringify({ connections, error: (error as Error).message }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(connections).toEqual([]);
  });

  it('3. URI temporaire installée APRÈS l’import (comme les suites) : c’est elle que reçoit le connecteur', async () => {
    process.env.MONGODB_URI = FORBIDDEN_INHERITED_URI;
    const loaded = await loadAppModule(fakeDir);
    const { connections } = loaded;
    const allowed = validatedEphemeralUri(await startEphemeralMongo());
    process.env.MONGODB_URI = allowed;
    let moduleRef: Awaited<ReturnType<typeof compile>> | undefined;
    try {
      moduleRef = await compile(loaded, 60_000);
    } finally {
      console.log('MESURE 3', JSON.stringify({ connections, allowed }));
    }
    expect(connections).toEqual([allowed]);
    const connection = moduleRef.get<Connection>(getConnectionToken());
    expect(`${connection.host}:${connection.port}`).toBe(new URL(allowed).host);
    await moduleRef.close();
  }, 120_000);

  it('4. deux applications successives sur deux bases distinctes : la seconde n’hérite pas de la première', async () => {
    const loaded = await loadAppModule(fakeDir);
    const { connections } = loaded;
    await stopEphemeralMongoSafe();
    const first = validatedEphemeralUri(await startEphemeralMongo());
    process.env.MONGODB_URI = first;
    const app1 = await compile(loaded, 60_000);
    const port1 = app1.get<Connection>(getConnectionToken()).port;
    await app1.close();
    await stopEphemeralMongoSafe();

    const second = validatedEphemeralUri(await startEphemeralMongo());
    expect(new URL(second).port).not.toBe(new URL(first).port);
    process.env.MONGODB_URI = second;
    const app2 = await compile(loaded, 60_000);
    const port2 = app2.get<Connection>(getConnectionToken()).port;
    await app2.close();
    console.log('MESURE 4', JSON.stringify({ connections, port1, port2 }));
    expect(connections).toEqual([first, second]);
    expect(String(port2)).toBe(new URL(second).port);
  }, 180_000);

  it('5. production : un secret d’exemple reste refusé au chargement', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'change-me-in-production-use-a-long-random-string';
    const loaded = await loadAppModule(fakeDir);
    const { connections } = loaded;
    await expect(compile(loaded)).rejects.toThrow(/JWT_SECRET refusé/);
    expect(connections).toEqual([]);
  });
});
