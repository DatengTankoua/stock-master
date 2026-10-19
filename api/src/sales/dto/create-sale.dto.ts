import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BatchQuantityEntryDto,
  BatchReasonDto,
  SALE_BATCH_ENTRIES_MAX,
} from '../../products/batches/dto/product-batch.dto';

/**
 * 1-11C.1 — ISO 8601 en UTC STRICT (`Z` obligatoire, aucun décalage),
 * millisecondes optionnelles. La plage métier (14 j passés / 5 min futures)
 * est validée par le service (`SALE_DATE_OUT_OF_RANGE`).
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class CreateSaleDto {
  @IsMongoId()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerContact?: string;

  /**
   * 1-11C.1 — clé d'idempotence générée UNE fois par le client et stable sur
   * tous les rejeux. Absente : comportement historique (aucune dédup).
   */
  @IsOptional()
  @IsUUID('4')
  clientOperationId?: string;

  /** 1-11C.1 — heure réelle de la vente ; absente → heure serveur. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ISO_8601_UTC)
  occurredAt?: string;

  /**
   * Lot B — lots réellement remis au client (produit suivi par lots :
   * obligatoire ; somme = `quantity`). Jamais substitués par le serveur.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALE_BATCH_ENTRIES_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchQuantityEntryDto)
  batchAllocations?: BatchQuantityEntryDto[];

  /** Lot B — lots sans date choisis après avertissement explicite. */
  @IsOptional()
  @IsBoolean()
  unknownExpiryConfirmed?: boolean;

  /**
   * Lot B — régularisation d'une vente hors ligne saisie avant la
   * péremption d'un lot et reçue après (`BATCH_EXPIRED_AT_SYNC`). Exige
   * `stock.adjust` ; jamais une autorisation de vendre un lot dépassé.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => BatchReasonDto)
  expiredBatchRegularization?: BatchReasonDto;
}
