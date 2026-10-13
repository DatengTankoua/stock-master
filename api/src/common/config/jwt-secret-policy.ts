/**
 * 1-22C — Politique du secret applicatif `JWT_SECRET`, vérifiée UNE fois
 * au chargement de la configuration (`ConfigModule.forRoot({ validate })`) :
 * API HTTP, poignée de main Socket.IO et CLI chargent tous `AppModule`, donc
 * aucun ne démarre en production avec un secret refusé.
 *
 * Le même secret signe et vérifie les sessions (JWT HS256 de 7 jours et
 * sessions limitées), clé les compteurs anti-abus persistants et dérive la
 * clé des empreintes de paiement (`derivePaymentFingerprintKey`).
 *
 * En production (`NODE_ENV=production`) sont refusés : secret absent ou vide,
 * entouré d'espaces, de moins de 32 octets, trop peu varié, égal à une valeur
 * d'exemple du dépôt ou portant un marqueur de modèle (« change-me »…).
 * Ces contrôles écartent les erreurs de configuration courantes ; ils ne
 * PROUVENT PAS l'entropie : seul un secret tiré d'un générateur
 * cryptographique (au moins 32 octets aléatoires) convient.
 *
 * Les messages d'erreur ne contiennent jamais la valeur ni sa longueur.
 */

/** Longueur minimale (octets UTF-8). */
export const JWT_SECRET_MIN_BYTES = 32;

/** Nombre minimal de caractères distincts (écarte « aaaa… », « 1212… »). */
export const JWT_SECRET_MIN_DISTINCT_CHARS = 10;

/** Valeurs d'exemple publiées dans le dépôt (anciennes et actuelles). */
export const KNOWN_EXAMPLE_JWT_SECRETS: readonly string[] = Object.freeze([
  'CHANGE_MOI_secret_jwt_64_caracteres_minimum',
  'change-me-in-production-use-a-long-random-string',
  '<chaine-aleatoire-256-bits>',
  'dev-only-insecure-jwt-secret-change-me-before-any-deployment',
]);

/** Marqueurs de modèle : un vrai secret aléatoire ne les contient pas. */
const PLACEHOLDER_MARKERS: readonly RegExp[] = [
  /change[\s_-]?me/i,
  /change[\s_-]?moi/i,
  /replace[\s_-]?me/i,
  /placeholder/i,
  /your[\s_-]?secret/i,
  /^<.*>$/,
];

export class JwtSecretPolicyError extends Error {
  constructor(reason: string) {
    super(
      `JWT_SECRET refusé en production : ${reason}. Générer au moins 32 octets ` +
        'aléatoires (voir docs/architecture/phase-1-22c-auth-production-config.md).',
    );
    this.name = 'JwtSecretPolicyError';
  }
}

/** Raison du refus, ou `null` si le secret est accepté (hors production). */
export function jwtSecretRejection(secret: unknown): string | null {
  if (typeof secret !== 'string' || secret.length === 0) {
    return 'valeur absente ou vide';
  }
  if (secret !== secret.trim()) {
    return 'espaces en début ou en fin de valeur';
  }
  if (Buffer.byteLength(secret, 'utf8') < JWT_SECRET_MIN_BYTES) {
    return `moins de ${JWT_SECRET_MIN_BYTES} octets`;
  }
  if (new Set(secret).size < JWT_SECRET_MIN_DISTINCT_CHARS) {
    return 'valeur trop peu variée';
  }
  if (KNOWN_EXAMPLE_JWT_SECRETS.includes(secret)) {
    return "valeur d'exemple publiée dans le dépôt";
  }
  if (PLACEHOLDER_MARKERS.some((marker) => marker.test(secret))) {
    return 'valeur de modèle (placeholder)';
  }
  return null;
}

/**
 * Validation de l'environnement chargé par `ConfigModule` : lève
 * `JwtSecretPolicyError` en production si le secret est refusé ; renvoie
 * la configuration inchangée sinon.
 */
export function validateEnvironment<T extends Record<string, unknown>>(
  config: T,
): T {
  if (config.NODE_ENV === 'production') {
    const reason = jwtSecretRejection(config.JWT_SECRET);
    if (reason !== null) throw new JwtSecretPolicyError(reason);
  }
  return config;
}
