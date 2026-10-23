import { randomBytes } from 'crypto';
import {
  describePlatformAdminConfig,
  parsePlatformAdminKeyring,
  resolvePlatformAdminConfig,
} from './platform-admin-config';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  TotpSecretCipherError,
} from './totp-secret-cipher';
import {
  currentTotpCode,
  generateTotpSecret,
  totpProvisioning,
  TOTP_PERIOD_SECONDS,
  verifyTotpCode,
} from './totp';
import {
  constantTimeEquals,
  generateRecoveryCodes,
  hashOpaqueToken,
  hashRecoveryCode,
  newOpaqueToken,
  normalizeRecoveryCode,
  OPAQUE_TOKEN_PATTERN,
} from './platform-admin-tokens';
import {
  describeIndexProblem,
  PLATFORM_ADMIN_INDEXES,
} from './platform-admin-indexes';
import { auditDocument } from './platform-admin-store';
import { parseCliArguments } from '../migrations/platform-admin-cli';

const key = () => randomBytes(32).toString('base64');
const PROXY = randomBytes(32).toString('base64url');

function validEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    JWT_SECRET: randomBytes(48).toString('base64url'),
    PLATFORM_ADMIN_ENABLED: 'true',
    PLATFORM_ADMIN_MFA_KEYS: `v1:${key()}`,
    PLATFORM_ADMIN_MFA_ACTIVE_KEY: 'v1',
    PLATFORM_ADMIN_PROXY_SECRET: PROXY,
    ...extra,
  };
}

describe('Administration de la plateforme — configuration', () => {
  it('fermée par défaut, sans erreur', () => {
    expect(resolvePlatformAdminConfig({})).toEqual({
      enabled: false,
      state: 'disabled',
      problems: [],
    });
    expect(
      resolvePlatformAdminConfig({ PLATFORM_ADMIN_ENABLED: 'false' }).enabled,
    ).toBe(false);
  });

  it('ouverte seulement avec une configuration complète', () => {
    const config = resolvePlatformAdminConfig(validEnv());
    expect(config.enabled).toBe(true);
    expect(describePlatformAdminConfig(config)).not.toContain(PROXY);
  });

  it.each([
    ['drapeau inconnu', { PLATFORM_ADMIN_ENABLED: 'yes' }],
    ['clés absentes', { PLATFORM_ADMIN_MFA_KEYS: '' }],
    ['clé active absente de la liste', { PLATFORM_ADMIN_MFA_ACTIVE_KEY: 'v9' }],
    [
      'clé trop courte',
      { PLATFORM_ADMIN_MFA_KEYS: `v1:${randomBytes(16).toString('base64')}` },
    ],
    ['clé non base64', { PLATFORM_ADMIN_MFA_KEYS: 'v1:pas une clé !' }],
    [
      'clé uniforme',
      {
        PLATFORM_ADMIN_MFA_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
      },
    ],
    [
      'identifiant en double',
      { PLATFORM_ADMIN_MFA_KEYS: `v1:${key()},v1:${key()}` },
    ],
    ['secret du BFF absent', { PLATFORM_ADMIN_PROXY_SECRET: '' }],
    ['secret du BFF trop court', { PLATFORM_ADMIN_PROXY_SECRET: 'court' }],
  ])('invalide (%s) : fermée, l’API démarre', (_label, extra) => {
    const config = resolvePlatformAdminConfig(validEnv(extra));
    expect(config.enabled).toBe(false);
    expect(config.enabled === false && config.state).toBe('invalid');
  });

  it('refuse la réutilisation de JWT_SECRET (clé ou secret du BFF)', () => {
    const jwt = randomBytes(32).toString('base64');
    expect(
      resolvePlatformAdminConfig(
        validEnv({ JWT_SECRET: jwt, PLATFORM_ADMIN_MFA_KEYS: `v1:${jwt}` }),
      ).enabled,
    ).toBe(false);
    expect(
      resolvePlatformAdminConfig(
        validEnv({ JWT_SECRET: PROXY, PLATFORM_ADMIN_PROXY_SECRET: PROXY }),
      ).enabled,
    ).toBe(false);
    const shared = key();
    expect(
      resolvePlatformAdminConfig(
        validEnv({
          PLATFORM_ADMIN_MFA_KEYS: `v1:${shared}`,
          PLATFORM_ADMIN_PROXY_SECRET: shared,
        }),
      ).enabled,
    ).toBe(false);
  });

  it('les messages ne contiennent jamais une valeur', () => {
    const secret = randomBytes(16).toString('base64');
    const config = resolvePlatformAdminConfig(
      validEnv({ PLATFORM_ADMIN_MFA_KEYS: `v1:${secret}` }),
    );
    expect(describePlatformAdminConfig(config)).not.toContain(secret);
  });

  it('plusieurs clés (rotation) : base64 et base64url acceptées', () => {
    const { keyring } = parsePlatformAdminKeyring({
      PLATFORM_ADMIN_MFA_KEYS: `v1:${key()}, v2:${randomBytes(32).toString('base64url')}`,
      PLATFORM_ADMIN_MFA_ACTIVE_KEY: 'v2',
    });
    expect(keyring?.keys.size).toBe(2);
    expect(keyring?.activeKeyId).toBe('v2');
  });
});

describe('Administration de la plateforme — chiffrement des secrets TOTP', () => {
  const env = validEnv({
    PLATFORM_ADMIN_MFA_KEYS: `v1:${key()},v2:${key()}`,
    PLATFORM_ADMIN_MFA_ACTIVE_KEY: 'v2',
  });
  const keyring = parsePlatformAdminKeyring(env).keyring!;
  const userId = '0123456789abcdef01234567';

  it('chiffre avec la clé active et relit', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, userId, keyring);
    expect(encrypted.keyId).toBe('v2');
    expect(encrypted.data).not.toContain(
      Buffer.from(secret).toString('base64'),
    );
    expect(decryptTotpSecret(encrypted, userId, keyring)).toEqual(
      Buffer.from(secret),
    );
  });

  it('refuse un autre utilisateur, une altération ou une clé absente', () => {
    const encrypted = encryptTotpSecret(generateTotpSecret(), userId, keyring);
    expect(() =>
      decryptTotpSecret(encrypted, 'ffffffffffffffffffffffff', keyring),
    ).toThrow(TotpSecretCipherError);
    const tampered = {
      ...encrypted,
      data: Buffer.from(encrypted.data, 'base64')
        .map((b, i) => (i === 0 ? b ^ 1 : b))
        .toString('base64'),
    };
    expect(() => decryptTotpSecret(tampered, userId, keyring)).toThrow(
      TotpSecretCipherError,
    );
    const otherKeyring = parsePlatformAdminKeyring(validEnv()).keyring!;
    expect(() => decryptTotpSecret(encrypted, userId, otherKeyring)).toThrow(
      /non chargée/,
    );
  });
});

describe('Administration de la plateforme — TOTP', () => {
  const secret = generateTotpSecret();
  const now = new Date('2026-10-23T10:00:15Z');
  const step = Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);

  it('accepte le pas courant et renvoie son numéro', () => {
    expect(verifyTotpCode(secret, currentTotpCode(secret, now), now)).toBe(
      step,
    );
  });

  it('tolérance de ±1 pas, pas au-delà', () => {
    const at = (offsetSteps: number) =>
      new Date(now.getTime() + offsetSteps * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotpCode(secret, currentTotpCode(secret, at(-1)), now)).toBe(
      step - 1,
    );
    expect(verifyTotpCode(secret, currentTotpCode(secret, at(1)), now)).toBe(
      step + 1,
    );
    expect(
      verifyTotpCode(secret, currentTotpCode(secret, at(-2)), now),
    ).toBeNull();
    expect(
      verifyTotpCode(secret, currentTotpCode(secret, at(2)), now),
    ).toBeNull();
  });

  it('refuse un format invalide', () => {
    expect(verifyTotpCode(secret, '12345', now)).toBeNull();
    expect(verifyTotpCode(secret, 'abcdef', now)).toBeNull();
  });

  it('provisionnement compatible (otpauth://totp, SHA1, 6 chiffres, 30 s)', () => {
    const { uri, manualKey } = totpProvisioning(secret, 'admin@example.test');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(manualKey.replace(/ /g, '')).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('Administration de la plateforme — jetons et codes de récupération', () => {
  it('jetons opaques de 256 bits, stockés hachés', () => {
    const token = newOpaqueToken();
    expect(token).toMatch(OPAQUE_TOKEN_PATTERN);
    expect(hashOpaqueToken(token)).not.toContain(token);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
  });

  it('10 codes distincts de 80 bits, normalisés à la saisie', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes)
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const typed = ` ${codes[0].toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeRecoveryCode(typed)).toBe(codes[0].replace(/-/g, ''));
    expect(normalizeRecoveryCode('ABCD-EFGH')).toBeNull();
  });

  it('empreinte liée à l’utilisateur', () => {
    const code = normalizeRecoveryCode(generateRecoveryCodes(1)[0])!;
    expect(hashRecoveryCode('a'.repeat(24), code)).not.toBe(
      hashRecoveryCode('b'.repeat(24), code),
    );
  });

  it('comparaison à temps constant', () => {
    expect(constantTimeEquals(PROXY, PROXY)).toBe(true);
    expect(constantTimeEquals(PROXY, `${PROXY}x`)).toBe(false);
    expect(constantTimeEquals(PROXY, '')).toBe(false);
  });
});

describe('Administration de la plateforme — audit et index', () => {
  it('audit : détail tronqué, aucun champ libre', () => {
    const doc = auditDocument(
      {
        actorType: 'operator',
        actorLabel: 'x'.repeat(200),
        action: 'access_grant',
        outcome: 'success',
        detail: 'y'.repeat(1000),
      },
      new Date(0),
    );
    expect(doc.actorLabel).toHaveLength(100);
    expect(doc.detail).toHaveLength(300);
    expect(Object.keys(doc).sort()).toEqual(
      [
        'action',
        'actorLabel',
        'actorType',
        'actorUserId',
        'at',
        'clientKeyHash',
        'detail',
        'outcome',
        'sessionId',
        'targetId',
        'targetType',
      ].sort(),
    );
  });

  it('index : absent, différent ou conforme', () => {
    const spec = PLATFORM_ADMIN_INDEXES[0];
    expect(describeIndexProblem(spec, [])).toBe('absent');
    expect(
      describeIndexProblem(spec, [{ name: spec.name, key: spec.key }]),
    ).toBe('différent');
    expect(
      describeIndexProblem(spec, [
        { name: spec.name, key: spec.key, unique: true },
      ]),
    ).toBeNull();
  });

  it('chaque accès et chaque facteur sont uniques par utilisateur', () => {
    const unique = PLATFORM_ADMIN_INDEXES.filter((i) => i.unique).map(
      (i) => `${i.collection}:${Object.keys(i.key).join(',')}`,
    );
    expect(unique).toEqual(
      expect.arrayContaining([
        'platform_admin_grants:userId',
        'platform_admin_mfa_factors:userId',
        'platform_admin_sessions:tokenHash',
        'platform_admin_challenges:tokenHash',
        'platform_admin_recovery_codes:userId,codeHash',
      ]),
    );
  });
});

describe('Administration de la plateforme — commande opérateur', () => {
  const id = '0123456789abcdef01234567';
  const base = [
    `--user-id=${id}`,
    '--reason=Recrutement du support',
    '--operator=ops',
  ];

  it('lecture seule par défaut, --apply explicite', () => {
    expect(parseCliArguments(['grant', ...base])).toMatchObject({
      command: 'grant',
      apply: false,
      userId: id,
    });
    expect(parseCliArguments(['grant', ...base, '--apply'])).toMatchObject({
      apply: true,
    });
  });

  it.each([
    [['grant', `--user-id=${id}`, '--operator=ops'], 'motif absent'],
    [
      [
        'grant',
        '--user-id=admin@example.test',
        '--reason=Recrutement',
        '--operator=ops',
      ],
      'e-mail au lieu de l’ID',
    ],
    [
      ['grant', ...base.slice(0, 1), '--reason=court', '--operator=ops'],
      'motif trop court',
    ],
    [['grant', ...base, '--apply', '--apply'], 'option dupliquée'],
    [['grant', ...base, '--role=admin'], 'option inconnue'],
    [['status', `--user-id=${id}`, '--apply'], 'status en écriture'],
    [['reset-mfa', ...base], 'vérification d’identité absente'],
    [['promote', ...base], 'commande inconnue'],
    [['rotate-key', '--operator=ops', `--user-id=${id}`], 'option inattendue'],
  ])('refuse %j (%s)', (argv) => {
    expect(typeof parseCliArguments(argv)).toBe('string');
  });

  it('l’erreur ne recopie jamais une valeur reçue', () => {
    const message = parseCliArguments(['grant', '--password=hunter2']);
    expect(message).not.toContain('hunter2');
  });
});
