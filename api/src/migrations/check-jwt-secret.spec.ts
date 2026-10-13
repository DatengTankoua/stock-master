import { randomBytes } from 'crypto';
import { checkJwtSecret } from './check-jwt-secret';
import {
  KNOWN_EXAMPLE_JWT_SECRETS,
  jwtSecretRejection,
  validateEnvironment,
} from '../common/config/jwt-secret-policy';

describe('check-jwt-secret (1-22C)', () => {
  const samples: (string | undefined)[] = [
    undefined,
    '',
    ' padded-secret-with-many-different-chars-0123456789 ',
    'Zk4r9Qm2Lp7Vx',
    'ab'.repeat(32),
    `change-me-${randomBytes(32).toString('hex')}`,
    `<${randomBytes(32).toString('hex')}>`,
    ...KNOWN_EXAMPLE_JWT_SECRETS,
    randomBytes(48).toString('base64url'),
    randomBytes(32).toString('hex'),
  ];

  it.each(samples.map((s) => [s]))(
    'même verdict que le démarrage de production (%p)',
    (secret) => {
      const check = checkJwtSecret({ JWT_SECRET: secret });
      let startupRefused = false;
      try {
        validateEnvironment({ NODE_ENV: 'production', JWT_SECRET: secret });
      } catch {
        startupRefused = true;
      }
      expect(check.ok).toBe(!startupRefused);
      expect(check.ok).toBe(jwtSecretRejection(secret) === null);
      if (secret) expect(check.message).not.toContain(secret.trim());
    },
  );

  it('règle appliquée quel que soit NODE_ENV', () => {
    expect(
      checkJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'short' }).ok,
    ).toBe(false);
  });
});
