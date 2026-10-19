import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { SaleRegularizationStatus } from '../schemas/sale-regularization-request.schema';

/** `GET /sales/regularizations?clientOperationIds=a,b&status=pending`. */
export class SaleRegularizationQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  clientOperationIds?: string[];

  @IsOptional()
  @IsEnum(SaleRegularizationStatus)
  status?: SaleRegularizationStatus;
}
