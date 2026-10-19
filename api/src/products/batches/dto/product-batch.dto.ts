import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsCivilDate } from '../../product-fields';

/**
 * Quantités des lots : unités ENTIÈRES strictement positives, comme les
 * ventes (`CreateSaleDto.quantity`) et la saisie du stock dans l'interface.
 */
export const BATCH_QUANTITY_MAX = 1_000_000_000;
export const BATCH_MANUFACTURER_LOT_MAX = 64;
/** Reprise : au plus 50 lots en une seule répartition. */
export const OPENING_BATCHES_MAX = 50;

/** Texte imprimable sur une ligne (aucun caractère de contrôle). */
const PRINTABLE_LINE = /^[^\p{Cc}]+$/u;

const trimmedOrNull = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class BatchQuantityFields {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;
}

/** Identité facultative d'un lot (création). `null` / vide : inconnue. */
export class BatchIdentityFields extends BatchQuantityFields {
  @Transform(trimmedOrNull)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BATCH_MANUFACTURER_LOT_MAX)
  @Matches(PRINTABLE_LINE)
  manufacturerLot?: string | null;

  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  expiryDate?: string | null;

  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  receivedOn?: string | null;
}

/**
 * Reprise du stock existant. `expectedRemainingQuantity` : stock affiché à
 * l'utilisateur au moment de la répartition (refus 409 s'il a changé).
 * Somme des lots = ce stock, exactement. Une répartition inconnue se
 * déclare par UN lot sans date (« lot historique, date inconnue »).
 */
export class EnableBatchTrackingDto {
  @IsUUID('4')
  clientOperationId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(BATCH_QUANTITY_MAX)
  expectedRemainingQuantity: number;

  @IsArray()
  @ArrayMaxSize(OPENING_BATCHES_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchIdentityFields)
  batches: BatchIdentityFields[];
}

/** Réception d'unités neuves dans un NOUVEAU lot. */
export class ReceiveNewBatchDto extends BatchIdentityFields {
  @IsUUID('4')
  clientOperationId: string;
}

/**
 * Réception dans un lot EXISTANT explicitement désigné : quantité seule.
 * Toute autre propriété (date, numéro fabricant) est refusée (400) : une
 * réception ne remplace jamais l'identité du lot.
 */
export class ReceiveExistingBatchDto extends BatchQuantityFields {
  @IsUUID('4')
  clientOperationId: string;
}

// ─── Lot B : affectations des ventes ───────────────────────────────────────

/** Au plus 20 lots par vente ou par correction. */
export const SALE_BATCH_ENTRIES_MAX = 20;
export const SALE_BATCH_REASON_MAX = 200;

/** `GET /products/:id/batches/sale-options?quantity=N`. */
export class SaleBatchOptionsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;
}

/** Unités d'un lot désigné (vente, retour, restitution). */
export class BatchQuantityEntryDto {
  @IsMongoId()
  batchId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;
}

/** Motif court d'une régularisation ou d'une restitution historique. */
export class BatchReasonDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(SALE_BATCH_REASON_MAX)
  @Matches(PRINTABLE_LINE)
  reason: string;
}

/** Restitution vers un « lot historique, date inconnue » créé exprès. */
export class HistoricalRestitutionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;

  /** Confirmation explicite : jamais créé par défaut. */
  @Equals(true)
  confirmed: true;
}

/**
 * Restitution d'unités d'une vente antérieure à l'activation (lot
 * d'origine inconnu) : destinations explicites ET motif. Commune à la
 * correction et à l'annulation.
 */
export class LegacyRestitutionFields {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SALE_BATCH_ENTRIES_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchQuantityEntryDto)
  restitutions?: BatchQuantityEntryDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => HistoricalRestitutionDto)
  historicalRestitution?: HistoricalRestitutionDto;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(SALE_BATCH_REASON_MAX)
  @Matches(PRINTABLE_LINE)
  restitutionReason?: string;
}

/** Corps facultatif de `DELETE /sales/:id` (annulation). */
export class CancelSaleDto extends LegacyRestitutionFields {}

/**
 * Modification de l'identité d'un lot. Absent : inchangé ; `null` / vide :
 * effacé. Jamais de quantité : une modification n'est pas une réception.
 */
export class UpdateBatchDto {
  @Transform(trimmedOrNull)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BATCH_MANUFACTURER_LOT_MAX)
  @Matches(PRINTABLE_LINE)
  manufacturerLot?: string | null;

  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  expiryDate?: string | null;

  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  receivedOn?: string | null;
}

// ─── Lot C : mise à l'écart, pertes ─────────────────────────────────────────

/** Mise à l'écart / remise à disposition : motif obligatoire. */
export class BatchStatusChangeDto extends BatchReasonDto {}

export const LOSS_REASONS = ['expired', 'damaged', 'other'] as const;

/** Perte : quantité ≥ 1, motif structuré ; commentaire exigé pour « autre ». */
export class RecordLossDto {
  @IsUUID('4')
  clientOperationId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;

  @IsIn(LOSS_REASONS)
  reason: (typeof LOSS_REASONS)[number];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(SALE_BATCH_REASON_MAX)
  @Matches(/^[^\p{Cc}]*$/u)
  comment?: string;
}

/** Correction d'une perte (contre-mouvement) : commentaire obligatoire. */
export class CorrectLossDto {
  @IsUUID('4')
  clientOperationId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BATCH_QUANTITY_MAX)
  quantity: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(SALE_BATCH_REASON_MAX)
  @Matches(PRINTABLE_LINE)
  comment: string;
}
