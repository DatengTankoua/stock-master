import {
  IsMongoId,
  IsNotEmpty,
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

export class CreateProductDto {
  @IsMongoId()
  sectionId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchasePrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initialQuantity: number;

  /** Facultatif ; `products.manage_expiry` requis (contrôleur). */
  @Transform(({ value }) => nullableDateInput(value, undefined))
  @IsOptional()
  @IsString()
  @IsCivilDate()
  expiryDate?: string;

  /**
   * Facultatif ; vide = règle par défaut, `0` = valeur explicite. Mêmes
   * règles de précision que le stock (`initialQuantity`, `additionalStock`).
   * `stock.manage_thresholds` requis (contrôleur).
   */
  @Transform(({ value }) => nullableNumberInput(value, undefined))
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  lowStockThreshold?: number;
}
