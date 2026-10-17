import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Date de péremption : date CIVILE `AAAA-MM-JJ`, stockée telle quelle (chaîne),
 * sans heure ni fuseau. Elle ne se décale donc jamais d'un jour selon le
 * fuseau du serveur, du navigateur ou du téléphone. Une date passée est
 * acceptée (produit déjà périmé à enregistrer) ; aucune vente n'est bloquée.
 * Elle porte sur la fiche produit entière : aucune gestion de lots.
 */
export const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const EXPIRY_YEAR_MIN = 2000;
export const EXPIRY_YEAR_MAX = 2100;

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < EXPIRY_YEAR_MIN || year > EXPIRY_YEAR_MAX) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  // Jour existant (29 février des années bissextiles compris), calculé en
  // UTC pour ne dépendre d'aucun fuseau.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

export function IsCivilDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCivilDate',
      validator: {
        validate: (value: unknown) => isCivilDate(value),
        defaultMessage: () =>
          `$property must be a calendar date YYYY-MM-DD between ${EXPIRY_YEAR_MIN} and ${EXPIRY_YEAR_MAX}`,
      },
    },
    options,
  );
}

/**
 * Valeur reçue d'un formulaire multipart ou JSON. Chaîne vide : champ effacé
 * (`clear`, `null` en modification) ; nombre écrit en texte (multipart) :
 * converti ; toute autre valeur est laissée telle quelle pour être REFUSÉE
 * par la validation (jamais convertie en 0, contrairement à `Number('')`).
 */
export function nullableNumberInput(
  value: unknown,
  clear: null | undefined,
): unknown {
  if (value === '' || value === null) return clear;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
  }
  return value;
}

export function nullableDateInput(
  value: unknown,
  clear: null | undefined,
): unknown {
  return value === '' || value === null ? clear : value;
}
