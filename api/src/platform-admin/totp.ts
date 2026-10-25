import { Secret, TOTP } from 'otpauth';

/**
 * TOTP (RFC 6238) via la bibliothèque `otpauth` — aucun algorithme
 * réimplémenté ici. Paramètres compatibles avec les applications
 * d'authentification courantes : SHA-1, 6 chiffres, pas de 30 s, secret de
 * 160 bits.
 *
 * Tolérance horaire : `TOTP_WINDOW = 1`, soit le pas précédent, le pas
 * courant et le suivant (±30 s autour de l'heure serveur). Le pas accepté
 * est renvoyé pour que l'appelant refuse tout pas déjà utilisé (rejeu).
 */
export const TOTP_ISSUER = 'Stock Master Admin';
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_CODE_PATTERN = /^\d{6}$/;

export function generateTotpSecret(): Uint8Array {
  return new Secret({ size: TOTP_SECRET_BYTES }).bytes;
}

function totpFor(secret: Uint8Array, label = 'admin'): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
  });
}

/** URI `otpauth://` (QR code) et clé de saisie manuelle (base32 groupée). */
export function totpProvisioning(
  secret: Uint8Array,
  accountLabel: string,
): { uri: string; manualKey: string } {
  const totp = totpFor(secret, accountLabel);
  const base32 = totp.secret.base32;
  return {
    uri: totp.toString(),
    manualKey: base32.replace(/(.{4})(?=.)/g, '$1 '),
  };
}

/** Pas accepté (entier), ou `null` si le code est invalide. */
export function verifyTotpCode(
  secret: Uint8Array,
  code: string,
  now: Date,
): number | null {
  if (!TOTP_CODE_PATTERN.test(code)) return null;
  const totp = totpFor(secret);
  const timestamp = now.getTime();
  const delta = totp.validate({ token: code, timestamp, window: TOTP_WINDOW });
  if (delta === null) return null;
  return totp.counter({ timestamp }) + delta;
}

/** Code courant (tests et recette uniquement). */
export function currentTotpCode(secret: Uint8Array, now: Date): string {
  return totpFor(secret).generate({ timestamp: now.getTime() });
}
