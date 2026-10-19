import { randomBytes } from 'crypto';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(() => ({ status: 0 })),
}));

import { spawnSync } from 'child_process';
import { PREDEPLOY_MIGRATIONS, main } from './predeploy-migrations';

describe('predeploy-migrations — contrôle JWT_SECRET préalable (1-22C)', () => {
  const spawn = spawnSync as unknown as jest.Mock;
  const uri = 'mongodb://127.0.0.1:1/never-contacted';
  let errors: jest.SpyInstance;

  beforeEach(() => {
    spawn.mockClear();
    errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['absent', undefined],
    ['exemple', 'CHANGE_MOI_secret_jwt_64_caracteres_minimum'],
    ['court', 'Zk4r9Qm2Lp7Vx'],
  ])(
    'production + secret %s : code 1, aucune migration lancée, valeur jamais affichée',
    (_label, secret) => {
      expect(
        main({ NODE_ENV: 'production', JWT_SECRET: secret, MONGODB_URI: uri }),
      ).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
      const printed = errors.mock.calls.flat().join('\n');
      expect(printed).toContain('aucune migration exécutée');
      if (secret) expect(printed).not.toContain(secret);
    },
  );

  it('production + secret conforme : toutes les migrations, dans l’ordre existant', () => {
    expect(
      main({
        NODE_ENV: 'production',
        JWT_SECRET: randomBytes(48).toString('base64url'),
        MONGODB_URI: uri,
      }),
    ).toBe(0);
    expect(
      spawn.mock.calls.map(([, args]) =>
        String((args as string[])[0])
          .split(/[\\/]/)
          .pop(),
      ),
    ).toEqual([...PREDEPLOY_MIGRATIONS]);
  });

  it('lots et alertes de péremption : en dernier, garde des lots d’abord', () => {
    expect(PREDEPLOY_MIGRATIONS.slice(-2)).toEqual([
      'install-product-batches.js',
      'install-expiry-alerts.js',
    ]);
  });

  it('échec d’une étape : code 1, étapes suivantes non lancées', () => {
    spawn.mockImplementation((_node: string, [file]: string[]) => ({
      status: file.endsWith('install-product-batches.js') ? 1 : 0,
    }));
    expect(main({ MONGODB_URI: uri })).toBe(1);
    const launched = spawn.mock.calls.map(([, args]) =>
      String((args as string[])[0])
        .split(/[\\/]/)
        .pop(),
    );
    expect(launched.at(-1)).toBe('install-product-batches.js');
    expect(launched).not.toContain('install-expiry-alerts.js');
    expect(errors.mock.calls.flat().join('\n')).toContain(
      'échec de install-product-batches.js',
    );
    spawn.mockImplementation(() => ({ status: 0 }));
  });

  it('hors production (migrations locales, tests) : aucun contrôle du secret', () => {
    expect(main({ JWT_SECRET: 'short', MONGODB_URI: uri })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(PREDEPLOY_MIGRATIONS.length);
  });
});
