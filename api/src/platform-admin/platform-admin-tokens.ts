import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Jetons opaques (session administrative, challenges) et codes de
 * récupération. Seule l'empreinte SHA-256 est stockée : une fuite de la
 * base ne donne ni session ni code utilisable.
 */

/** 32 octets aléatoires, base64url (43 caractères). */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashOpaqueToken(token: string): string {
  return createHash('sha256')
    .update(`stockmaster:platform-admin-token\u0000${token}`)
    .digest('hex');
}

// ─── Codes de récupération ─────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
/** 10 octets = 80 bits d'entropie par code. */
const RECOVERY_CODE_BYTES = 10;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Code affiché : 16 caractères base32 en 4 groupes (`ABCD-EFGH-…`). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const raw = base32(randomBytes(RECOVERY_CODE_BYTES));
    codes.add(raw.match(/.{4}/g)!.join('-'));
  }
  return [...codes];
}

/** Saisie normalisée (casse, espaces et tirets ignorés) ; `null` si invalide. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(compact) ? compact : null;
}

export function hashRecoveryCode(userId: string, normalized: string): string {
  return createHash('sha256')
    .update(
      `stockmaster:platform-admin-recovery\u0000${userId}\u0000${normalized}`,
    )
    .digest('hex');
}

/** Comparaison à temps constant de deux chaînes (secret du BFF). */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
