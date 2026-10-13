import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { resetAuthRateLimits } from './e2e/rate-limit-fixtures';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { LOGIN_SHORT_LIMIT } from './../src/common/auth-rate-limiting';
import {
  ExpressSettings,
  applyTrustProxy,
  resolveTrustProxySetting,
} from './../src/common/trust-proxy';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { createE2eEmailSender } from './e2e/email-verification-fixtures';
import { simulatedTurnstileToken } from './e2e/legal-acceptance-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * E2E 1-22C — configuration d'authentification de production.
 *
 * 1. `JWT_SECRET` : un `AppModule` chargé en production refuse un secret
 *    absent, court, d'exemple ou de modèle, sans afficher la valeur.
 * 2. Proxy simulé : les requêtes supertest partent toutes de 127.0.0.1 (la
 *    « connexion » = le proxy d'entrée) ; l'en-tête `X-Forwarded-For` reproduit
 *    ce qu'un proxy d'entrée transmet. Réglage appliqué par le MÊME code que
 *    `main.ts`. `req.ip` est observé par un middleware de FIXTURE.
 *    La preuve sur la topologie Railway réelle reste à mesurer (voir la doc).
 */

const LOGIN_BODY = { email: 'nobody-22c@proxy.test', password: 'wrong-pw-1' };
const CLIENT_A = '203.0.113.10';
const CLIENT_B = '203.0.113.20';

describe('Configuration d’authentification de production (e2e 1-22C)', () => {
  describe('1. JWT_SECRET au chargement de AppModule (NODE_ENV=production)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    /** Charge un AppModule NEUF (la configuration est lue à son import). */
    async function compileProductionAppModule(
      secret: string | undefined,
    ): Promise<unknown> {
      process.env.NODE_ENV = 'production';
      if (secret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = secret;
      let failure: unknown = null;
      await jest.isolateModulesAsync(async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('./../src/app.module') as {
          AppModule: unknown;
        };
        await Test.createTestingModule({
          imports: [fresh.AppModule as never],
        })
          .compile()
          .then((module) => module.close())
          .catch((error: unknown) => {
            failure = error;
          });
      });
      return failure;
    }

    it.each([
      ['absent', undefined],
      ['trop court', 'Zk4r9Qm2Lp7Vx'],
      [
        'exemple .env.prod.example',
        'CHANGE_MOI_secret_jwt_64_caracteres_minimum',
      ],
      [
        'exemple api/.env.example',
        'change-me-in-production-use-a-long-random-string',
      ],
      ['modèle', 'replace-me-with-48-random-bytes-from-a-csprng-0123456789'],
      ['peu varié', 'abababababababababababababababababababab'],
    ])(
      '%s → démarrage refusé, valeur jamais affichée',
      async (_label, secret) => {
        const failure = await compileProductionAppModule(secret);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).name).toBe('JwtSecretPolicyError');
        if (secret) expect((failure as Error).message).not.toContain(secret);
      },
    );

    it('secret aléatoire de 48 octets : la politique ne bloque pas le chargement', async () => {
      const failure = await compileProductionAppModule(
        randomBytes(48).toString('base64url'),
      );
      // Le module peut échouer plus loin pour une autre raison de production
      // (index, connexion) : seule la politique du secret est vérifiée ici.
      expect((failure as Error | null)?.name).not.toBe('JwtSecretPolicyError');
    });
  });

  describe('2. Proxy simulé et limites anti-abus', () => {
    let moduleFixture: TestingModule;
    let app: INestApplication<App>;
    const observed: string[] = [];

    const express = () =>
      app.getHttpAdapter().getInstance() as ExpressSettings & {
        get(name: string): unknown;
      };

    async function configure(env: NodeJS.ProcessEnv) {
      express().set('trust proxy', false);
      applyTrustProxy(express(), resolveTrustProxySetting(env));
      await resetAuthRateLimits(moduleFixture);
      observed.length = 0;
    }

    const login = (
      xff: string | null,
      body: Record<string, unknown> = LOGIN_BODY,
    ) => {
      const req = request(app.getHttpServer()).post('/auth/login');
      if (xff !== null) req.set('X-Forwarded-For', xff);
      return req.send(body);
    };

    async function statuses(
      count: number,
      xff: (i: number) => string | null,
      body: Record<string, unknown> = LOGIN_BODY,
    ): Promise<number[]> {
      const out: number[] = [];
      for (let i = 0; i < count; i++)
        out.push((await login(xff(i), body)).status);
      return out;
    }

    beforeAll(async () => {
      const replSet = await startEphemeralMongo();
      try {
        process.env.MONGODB_URI = validatedEphemeralUri(replSet);
        process.env.JWT_SECRET = 'auth-production-config-22c-e2e-only-secret';
        process.env.CORS_ORIGIN = 'https://auth-config-22c.example.com';
        process.env.PUBLIC_APP_URL = 'https://app.auth-config-22c.test';
        process.env.TURNSTILE_SIMULATED = 'true';
        moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(EMAIL_SENDER)
          .useValue(createE2eEmailSender())
          .compile();
        app = moduleFixture.createNestApplication();
        app.use((req: Request, res: Response, next: NextFunction) => {
          res.on('finish', () => observed.push(req.ip ?? ''));
          next();
        });
        app.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
          }),
        );
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
      } catch (error) {
        await stopEphemeralMongoSafe();
        throw error;
      }
    }, 180_000);

    afterAll(async () => {
      delete process.env.TURNSTILE_SIMULATED;
      if (app) await app.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
    }, 60_000);

    describe('sans réglage (défaut) derrière un proxy d’entrée', () => {
      beforeEach(() => configure({}));

      it('deux clients distincts derrière le proxy PARTAGENT le compteur (limite connue, avertie au démarrage)', async () => {
        const a = await statuses(LOGIN_SHORT_LIMIT, () => CLIENT_A);
        expect(a.every((s) => s === 401)).toBe(true);
        const b = await login(CLIENT_B, {
          ...LOGIN_BODY,
          email: 'other-22c@proxy.test',
        });
        expect(b.status).toBe(429);
        expect(new Set(observed).size).toBe(1);
      });
    });

    describe('TRUST_PROXY_HOPS=1 — proxy unique qui AJOUTE l’adresse du client', () => {
      beforeEach(() => configure({ TRUST_PROXY_HOPS: '1' }));

      it('deux clients distincts : compteurs distincts (A limité, B autorisé)', async () => {
        const a = await statuses(LOGIN_SHORT_LIMIT + 1, () => CLIENT_A);
        expect(a[LOGIN_SHORT_LIMIT]).toBe(429);
        const b = await login(CLIENT_B, {
          ...LOGIN_BODY,
          email: 'other-22c@proxy.test',
        });
        expect(b.status).toBe(401);
        expect(observed.at(-1)).toBe(CLIENT_B);
      });

      it('en-tête forgé par le client (le proxy ajoute la vraie adresse) : compteur de A jamais contourné', async () => {
        const forged = await statuses(
          LOGIN_SHORT_LIMIT + 2,
          (i) => `198.51.100.${i + 1}, ${CLIENT_A}`,
        );
        expect(forged.slice(0, LOGIN_SHORT_LIMIT).every((s) => s === 401)).toBe(
          true,
        );
        expect(forged.slice(LOGIN_SHORT_LIMIT)).toEqual([429, 429]);
        expect(new Set(observed)).toEqual(new Set([CLIENT_A]));
      });

      it('LIMITE du mode par sauts : un chemin qui CONTOURNE le proxy impose son adresse déclarée', async () => {
        // Connexion directe (aucun proxy) avec un en-tête choisi : avec
        // HOPS=1, la connexion elle-même est prise pour le proxy.
        await login('192.0.2.99');
        expect(observed).toEqual(['192.0.2.99']);
      });
    });

    describe('TRUST_PROXY_ADDRESSES — seul le proxy identifié est approuvé', () => {
      it('pair non approuvé : adresse déclarée ignorée, aucun contournement du compteur', async () => {
        await configure({ TRUST_PROXY_ADDRESSES: '192.0.2.1' });
        const s = await statuses(
          LOGIN_SHORT_LIMIT + 1,
          (i) => `203.0.113.${i + 1}`,
        );
        expect(s[LOGIN_SHORT_LIMIT]).toBe(429);
        for (const ip of observed) {
          expect(ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
        }
      });
    });

    describe('protections indépendantes de l’adresse', () => {
      beforeEach(() => configure({ TRUST_PROXY_HOPS: '1' }));

      it('plafond par compte : des clients distincts n’échappent pas au plafond du même compte', async () => {
        const target = { ...LOGIN_BODY, email: 'victim-22c@proxy.test' };
        const s = await statuses(
          LOGIN_SHORT_LIMIT + 2,
          (i) => `203.0.113.${100 + i}`,
          target,
        );
        // Chaque requête vient d'un « client » différent (aucune limite IP
        // atteinte) : seul le plafond PAR COMPTE peut refuser.
        expect(s.slice(-2)).toEqual([429, 429]);
        expect(new Set(observed).size).toBe(LOGIN_SHORT_LIMIT + 2);
      });

      it('Turnstile : un jeton absent ou invalide reste refusé derrière le proxy approuvé', async () => {
        for (const token of [undefined, 'cf-invalid']) {
          const res = await request(app.getHttpServer())
            .post('/auth/password-reset/request')
            .set('X-Forwarded-For', `203.0.113.${token ? 51 : 50}`)
            .send({
              email: 'reset-22c@proxy.test',
              ...(token ? { turnstileToken: token } : {}),
            });
          expect([400, 403]).toContain(res.status);
          expect(res.status).not.toBe(202);
        }
        const ok = await request(app.getHttpServer())
          .post('/auth/password-reset/request')
          .set('X-Forwarded-For', '203.0.113.52')
          .send({
            email: 'reset-22c@proxy.test',
            turnstileToken: simulatedTurnstileToken('password-reset'),
          });
        expect(ok.status).toBe(202);
      });
    });
  });
});
