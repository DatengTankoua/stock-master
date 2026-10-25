import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { PlatformAdminKeyring } from './platform-admin-config';

/**
 * Chiffrement des secrets TOTP au repos : AES-256-GCM (chiffrement
 * authentifié de `node:crypto`), IV aléatoire de 12 octets, étiquette de
 * 16 octets. Les données associées lient le chiffré à son utilisateur : un
 * secret recopié sur un autre compte ne se déchiffre pas.
 *
 * `keyId` identifie la clé (rotation : les anciens chiffrés restent lisibles
 * tant que leur clé est chargée ; `platform-admin rotate-key` les rechiffre
 * avec la clé active). Clé dédiée, distincte de `JWT_SECRET`.
 */
export interface EncryptedTotpSecret {
  /** Version du format. */
  v: 1;
  keyId: string;
  iv: string;
  tag: string;
  data: string;
}

export class TotpSecretCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretCipherError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function associatedData(userId: string): Buffer {
  return Buffer.from(`stockmaster:platform-admin-totp:v1\u0000${userId}`);
}

export function encryptTotpSecret(
  secret: Uint8Array,
  userId: string,
  keyring: PlatformAdminKeyring,
): EncryptedTotpSecret {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new TotpSecretCipherError('clé active indisponible');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(userId));
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    v: 1,
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptTotpSecret(
  encrypted: EncryptedTotpSecret,
  userId: string,
  keyring: PlatformAdminKeyring,
): Buffer {
  if (encrypted?.v !== 1) throw new TotpSecretCipherError('format inconnu');
  const key = keyring.keys.get(encrypted.keyId);
  if (!key) {
    throw new TotpSecretCipherError(`clé ${encrypted.keyId} non chargée`);
  }
  const iv = Buffer.from(encrypted.iv, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TotpSecretCipherError('chiffré malformé');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'base64')),
      decipher.final(),
    ]);
  } catch {
    // Jamais le détail de l'erreur (aucune donnée du chiffré).
    throw new TotpSecretCipherError('authentification du chiffré refusée');
  }
}
