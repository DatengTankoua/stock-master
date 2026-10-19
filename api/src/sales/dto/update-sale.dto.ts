import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BatchQuantityEntryDto,
  LegacyRestitutionFields,
  SALE_BATCH_ENTRIES_MAX,
} from '../../products/batches/dto/product-batch.dto';

/**
 * Correction d'une vente. Lot B (produit suivi par lots) : toute variation
 * de quantité précise les lots concernés :
 * - `batchReturns` : unités rendues aux lots D'ORIGINE de la vente ;
 * - `batchAllocations` : unités supplémentaires affectées (lots vendables) ;
 * - `restitutions` / `historicalRestitution` + `restitutionReason` : unités
 *   d'une vente antérieure à l'activation, lot d'origine inconnu.
 * Nouvelle quantité = quantité − retours − restitutions + ajouts. Un
 * échange de lot (retour + ajout, quantité inchangée) est permis.
 */
export class UpdateSaleDto extends LegacyRestitutionFields {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SALE_BATCH_ENTRIES_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchQuantityEntryDto)
  batchReturns?: BatchQuantityEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SALE_BATCH_ENTRIES_MAX)
  @ValidateNested({ each: true })
  @Type(() => BatchQuantityEntryDto)
  batchAllocations?: BatchQuantityEntryDto[];

  @IsOptional()
  @IsBoolean()
  unknownExpiryConfirmed?: boolean;
}
