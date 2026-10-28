import { createHash, createHmac } from 'crypto';

/**
 * Jeton de désabonnement d'un e-mail promotionnel.
 *
 * Contrainte : une reprise doit renvoyer EXACTEMENT le même e-mail (même
 * clé d'idempotence chez le prestataire), donc le même lien, alors que seul
 * le HACHÉ du jeton est stocké. Choix : le jeton est DÉRIVÉ, jamais tiré au
 * hasard puis gardé :
 *
 *   jeton = base64url(HMAC-SHA256(secret, livraison | empreinte d'adresse))
 *
 * - 256 bits, non devinable sans le secret serveur ;
 * - lié à UNE livraison (destinataire × campagne) et à l'adresse concernée ;
 * - recalculé à l'identique à chaque reprise : aucun jeton en clair en base ;
 * - seul `sha256(jeton)` est enregistré (`marketing_unsubscribe_tokens`) et
 *   sert à la validation, qui ne dépend donc PAS du secret : une rotation
 *   ne casse aucun lien déjà envoyé.
 *
 * Secret : `MARKETING_UNSUBSCRIBE_SECRET` (au moins 32 octets, base64url ou
 * base64). Une rotation ne doit avoir lieu qu'en l'absence de reprise
 * possible (livraisons en cours) : l'empreinte du secret est figée avec la
 * livraison, et une reprise sous un autre secret n'est jamais envoyée.
 */
export const UNSUBSCRIBE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface UnsubscribeKey {
  secret: Buffer;
  /** Empreinte courte du secret (jamais le secret). */
  keyId: string;
}

export function parseUnsubscribeSecret(
  raw: string | undefined,
): UnsubscribeKey | null {
  const value = (raw ?? '').trim();
  if (!/^[A-Za-z0-9_+/=-]+$/.test(value)) return null;
  const secret = Buffer.from(
    value.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  if (secret.length < 32) return null;
  return {
    secret,
    keyId: createHash('sha256').update(secret).digest('hex').slice(0, 16),
  };
}

export function deriveUnsubscribeToken(
  key: UnsubscribeKey,
  deliveryId: string,
  addressSha256: string,
): string {
  return createHmac('sha256', key.secret)
    .update(
      `stockmaster:marketing-unsubscribe:v1|${deliveryId}|${addressSha256}`,
    )
    .digest('base64url');
}

export function unsubscribeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Page publique (lien visible) et adresse du POST en un clic (RFC 8058). */
export function unsubscribeLinks(
  appOrigin: string,
  token: string,
): { page: string; oneClick: string } {
  const query = `token=${encodeURIComponent(token)}`;
  return {
    page: `${appOrigin}/auth/unsubscribe?${query}`,
    oneClick: `${appOrigin}/api/unsubscribe?${query}`,
  };
}
