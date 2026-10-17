import {
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  IsCivilDate,
  nullableDateInput,
  nullableNumberInput,
} from '../product-fields';

export class UpdateProductDto {
  @IsOptional()
  @IsMongoId()
  sectionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchasePrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  additionalStock?: number;

  /**
   * Absent : inchangé. `null` (JSON) ou chaîne vide (multipart) : date
   * retirée. `products.manage` ET `products.manage_expiry` requis.
   */
  @Transform(({ value }) => nullableDateInput(value, null))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  expiryDate?: string | null;

  /**
   * Absent : inchangé. `null` / chaîne vide : retour à la règle par défaut.
   * `0` est une valeur explicite. `products.manage` ET
   * `stock.manage_thresholds` requis.
   */
  @Transform(({ value }) => nullableNumberInput(value, null))
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  lowStockThreshold?: number | null;
}
