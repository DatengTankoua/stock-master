import {
  ProductBatch,
  ProductBatchSchema,
} from '../products/batches/schemas/product-batch.schema';
import {
  StockLoss,
  StockLossSchema,
} from '../products/batches/schemas/stock-loss.schema';
import { StockHealthService } from './stock-health.service';
import { StockHealthController } from './stock-health.controller';
import { Module } from '@nestjs/common';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentSchema,
} from '../products/schemas/purged-stock-adjustment.schema';

import { MongooseModule } from '@nestjs/mongoose';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sale.name, schema: SaleSchema },
      { name: Product.name, schema: ProductSchema },
      {
        name: PurgedStockAdjustment.name,
        schema: PurgedStockAdjustmentSchema,
      },
      // 1-16E : date de création du commerce (début d'observation).
      { name: Organization.name, schema: OrganizationSchema },
      // Lot C : péremption des lots et pertes.
      { name: ProductBatch.name, schema: ProductBatchSchema },
      { name: StockLoss.name, schema: StockLossSchema },
    ]),
  ],
  providers: [AnalyticsService, StockHealthService],
  controllers: [AnalyticsController, StockHealthController],
  // 1-16A.1 : bilan mensuel calculé avec les MÊMES règles et bornes.
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
