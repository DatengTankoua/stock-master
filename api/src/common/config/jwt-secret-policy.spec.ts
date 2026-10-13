import { randomBytes } from 'crypto';
import {
  JWT_SECRET_MIN_BYTES,
  JwtSecretPolicyError,
  KNOWN_EXAMPLE_JWT_SECRETS,
  jwtSecretRejection,
  validateEnvironment,
} from './jwt-secret-policy';

describe('Politique JWT_SECRET (1-22C)', () => {
  const strong = () => randomBytes(48).toString('base64url');

  it('secret aléatoire de 48 octets (base64url) ou 32 octets (hex) : accepté', () => {
    expect(jwtSecretRejection(strong())).toBeNull();
    expect(jwtSecretRejection(randomBytes(32).toString('hex'))).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['vide', ''],
    ['non textuel', 42],
    ['espaces autour', ` ${randomBytes(48).toString('base64url')} `],
    [
      '31 octets',
      randomBytes(48)
        .toString('base64url')
        .slice(0, JWT_SECRET_MIN_BYTES - 1),
    ],
    ['peu varié', 'ab'.repeat(32)],
    ['modèle « change-me »', `change-me-${randomBytes(32).toString('hex')}`],
    ['modèle « CHANGE_MOI »', `CHANGE_MOI_${randomBytes(32).toString('hex')}`],
    ['modèle « replace me »', `replace me ${randomBytes(32).toString('hex')}`],
    ['modèle entre chevrons', `<${randomBytes(32).toString('hex')}>`],
  ])('%s : refusé', (_label, secret) => {
    expect(jwtSecretRejection(secret)).not.toBeNull();
  });

  it('toutes les valeurs d’exemple publiées dans le dépôt sont refusées', () => {
    for (const example of KNOWN_EXAMPLE_JWT_SECRETS) {
      expect(jwtSecretRejection(example)).not.toBeNull();
    }
  });

  it('longueur mesurée en octets UTF-8 (pas en caractères)', () => {
    // 16 caractères accentués distincts × 2 octets = 32 octets : accepté.
    const accented = 'àâäéèêëîïôöùûüçñ';
    expect(Buffer.byteLength(accented, 'utf8')).toBe(32);
    expect(jwtSecretRejection(accented)).toBeNull();
  });

  describe('validateEnvironment (ConfigModule.forRoot)', () => {
    it('production + secret refusé : JwtSecretPolicyError, sans la valeur', () => {
      const secret = 'change-me-in-production-use-a-long-random-string';
      let error: unknown;
      try {
        validateEnvironment({ NODE_ENV: 'production', JWT_SECRET: secret });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(JwtSecretPolicyError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('32 octets');
    });

    it('production + secret fort : configuration renvoyée inchangée', () => {
      const config = { NODE_ENV: 'production', JWT_SECRET: strong(), X: '1' };
      expect(validateEnvironment(config)).toBe(config);
    });

    it.each([undefined, 'development', 'test'])(
      'NODE_ENV=%s : aucun refus (développement et tests)',
      (nodeEnv) => {
        expect(() =>
          validateEnvironment({ NODE_ENV: nodeEnv, JWT_SECRET: 'short' }),
        ).not.toThrow();
      },
    );
  });
});
