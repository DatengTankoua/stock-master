/**
 * Administration de la plateforme — configuration (lue au démarrage, jamais
 * journalisée en valeur).
 *
 * L'espace est FERMÉ par défaut. Il n'ouvre que si TOUT est valide :
 * - `PLATFORM_ADMIN_ENABLED=true` (valeur exacte) ;
 * - `PLATFORM_ADMIN_MFA_KEYS` : une ou plusieurs clés de chiffrement des
 *   secrets TOTP, `<id>:<32 octets en base64 ou base64url>`, séparées par
 *   des virgules (plusieurs clés = rotation en cours) ;
 * - `PLATFORM_ADMIN_MFA_ACTIVE_KEY` : identifiant de la clé qui chiffre les
 *   nouveaux secrets (doit figurer dans la liste) ;
 * - `PLATFORM_ADMIN_PROXY_SECRET` : secret partagé avec la route serveur
 *   Next.js (BFF), seule appelante autorisée des routes `/platform-admin`.
 *
 * Aucune de ces valeurs ne peut être `JWT_SECRET` ni une autre d'entre
 * elles. Configuration absente ou invalide : l'espace reste fermé (503),
 * l'API démarre et les commerces fonctionnent normalement. Aucune clé n'est
 * jamais générée automatiquement.
 */

export const PLATFORM_ADMIN_KEY_BYTES = 32;
export const PLATFORM_ADMIN_PROXY_SECRET_MIN_LENGTH = 32;
export const PLATFORM_ADMIN_PROXY_SECRET_MAX_LENGTH = 256;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const PROXY_SECRET_PATTERN = /^[\x21-\x7e]+$/;

export interface PlatformAdminKeyring {
  /** Clé de chiffrement des nouveaux secrets. */
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export type PlatformAdminConfig =
  | { enabled: false; state: 'disabled' | 'invalid'; problems: string[] }
  | {
      enabled: true;
      keyring: PlatformAdminKeyring;
      proxySecret: string;
    };

/** Problèmes de configuration (jamais la valeur, jamais sa longueur). */
export function parsePlatformAdminKeyring(env: NodeJS.ProcessEnv): {
  keyring: PlatformAdminKeyring | null;
  problems: string[];
} {
  const problems: string[] = [];
  const raw = (env.PLATFORM_ADMIN_MFA_KEYS ?? '').trim();
  const activeKeyId = (env.PLATFORM_ADMIN_MFA_ACTIVE_KEY ?? '').trim();
  if (raw === '') problems.push('PLATFORM_ADMIN_MFA_KEYS absente');
  if (activeKeyId === '')
    problems.push('PLATFORM_ADMIN_MFA_ACTIVE_KEY absente');
  const keys = new Map<string, Buffer>();
  const jwtSecret = env.JWT_SECRET ?? '';
  for (const entry of raw === '' ? [] : raw.split(',')) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (separator <= 0 || !KEY_ID_PATTERN.test(id)) {
      problems.push('PLATFORM_ADMIN_MFA_KEYS : identifiant de clé invalide');
      continue;
    }
    if (keys.has(id)) {
      problems.push(`PLATFORM_ADMIN_MFA_KEYS : clé ${id} en double`);
      continue;
    }
    const key = decodeKey(encoded);
    if (key.length !== PLATFORM_ADMIN_KEY_BYTES) {
      problems.push(
        `PLATFORM_ADMIN_MFA_KEYS : la clé ${id} doit faire ${PLATFORM_ADMIN_KEY_BYTES} octets`,
      );
      continue;
    }
    if (new Set(key).size < 8) {
      problems.push(`PLATFORM_ADMIN_MFA_KEYS : clé ${id} trop peu variée`);
      continue;
    }
    if (
      jwtSecret !== '' &&
      (encoded === jwtSecret || key.equals(Buffer.from(jwtSecret, 'utf8')))
    ) {
      problems.push(
        `PLATFORM_ADMIN_MFA_KEYS : la clé ${id} reprend JWT_SECRET`,
      );
      continue;
    }
    keys.set(id, key);
  }
  if (activeKeyId !== '' && raw !== '' && !keys.has(activeKeyId)) {
    problems.push('PLATFORM_ADMIN_MFA_ACTIVE_KEY absente de la liste des clés');
  }
  return {
    keyring: problems.length === 0 ? { activeKeyId, keys } : null,
    problems,
  };
}

/** base64 ou base64url ; toute autre forme → tampon vide (refusé). */
function decodeKey(encoded: string): Buffer {
  if (!BASE64_PATTERN.test(encoded)) return Buffer.alloc(0);
  const urlSafe = encoded.includes('-') || encoded.includes('_');
  if (urlSafe && /[+/]/.test(encoded)) return Buffer.alloc(0);
  return Buffer.from(encoded, urlSafe ? 'base64url' : 'base64');
}

export function resolvePlatformAdminConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformAdminConfig {
  const flag = (env.PLATFORM_ADMIN_ENABLED ?? '').trim();
  if (flag === '' || flag === 'false') {
    return { enabled: false, state: 'disabled', problems: [] };
  }
  const problems: string[] = [];
  if (flag !== 'true') {
    problems.push('PLATFORM_ADMIN_ENABLED doit valoir true ou false');
  }
  const { keyring, problems: keyProblems } = parsePlatformAdminKeyring(env);
  problems.push(...keyProblems);

  const proxySecret = env.PLATFORM_ADMIN_PROXY_SECRET ?? '';
  if (proxySecret === '') {
    problems.push('PLATFORM_ADMIN_PROXY_SECRET absente');
  } else if (
    proxySecret.length < PLATFORM_ADMIN_PROXY_SECRET_MIN_LENGTH ||
    proxySecret.length > PLATFORM_ADMIN_PROXY_SECRET_MAX_LENGTH ||
    !PROXY_SECRET_PATTERN.test(proxySecret)
  ) {
    problems.push(
      `PLATFORM_ADMIN_PROXY_SECRET : ${PLATFORM_ADMIN_PROXY_SECRET_MIN_LENGTH} à ${PLATFORM_ADMIN_PROXY_SECRET_MAX_LENGTH} caractères visibles, sans espace`,
    );
  } else {
    if (proxySecret === env.JWT_SECRET) {
      problems.push('PLATFORM_ADMIN_PROXY_SECRET reprend JWT_SECRET');
    }
    if (
      (env.PLATFORM_ADMIN_MFA_KEYS ?? '')
        .split(',')
        .some(
          (entry) => entry.slice(entry.indexOf(':') + 1).trim() === proxySecret,
        )
    ) {
      problems.push(
        'PLATFORM_ADMIN_PROXY_SECRET reprend une clé de chiffrement',
      );
    }
  }

  if (problems.length > 0 || !keyring) {
    return { enabled: false, state: 'invalid', problems };
  }
  return { enabled: true, keyring, proxySecret };
}

/** Résumé journalisable au démarrage (aucune valeur secrète). */
export function describePlatformAdminConfig(
  config: PlatformAdminConfig,
): string {
  if (config.enabled) {
    return `ouverte (clé active ${config.keyring.activeKeyId}, ${config.keyring.keys.size} clé(s) chargée(s))`;
  }
  if (config.state === 'disabled') return 'fermée (désactivée)';
  return `fermée (configuration invalide : ${config.problems.join(' ; ')})`;
}
