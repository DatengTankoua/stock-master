import { Module } from '@nestjs/common';
import {
  PurgedStockAdjustment,
  PurgedStockAdjustmentSchema,
} from './schemas/purged-stock-adjustment.schema';

import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Sale, SaleSchema } from '../sales/schemas/sale.schema';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { S3Module } from '../s3/s3.module';
import { StorageQuotaModule } from '../storage-quota/storage-quota.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { PushModule } from '../push/push.module';
import { Section, SectionSchema } from '../sections/schemas/section.schema';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  ProductBatch,
  ProductBatchSchema,
} from './batches/schemas/product-batch.schema';
import {
  ProductBatchOperation,
  ProductBatchOperationSchema,
} from './batches/schemas/product-batch-operation.schema';
import { ProductBatchesService } from './batches/product-batches.service';
import {
  StockLoss,
  StockLossSchema,
} from './batches/schemas/stock-loss.schema';
import { ProductBatchesController } from './batches/product-batches.controller';
import { ExpiryAlertsController } from './expiry/expiry-alerts.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: Section.name, schema: SectionSchema },
      // 1-21D : sérialisation des créations (capacité incluse).
      { name: Organization.name, schema: OrganizationSchema },
      // 1-15D : écart figé à la purge (vue d'ensemble).
      {
        name: PurgedStockAdjustment.name,
        schema: PurgedStockAdjustmentSchema,
      },
      // Lots (lot A) : lots et traces idempotentes de leurs opérations.
      { name: ProductBatch.name, schema: ProductBatchSchema },
      {
        name: ProductBatchOperation.name,
        schema: ProductBatchOperationSchema,
      },
      // Lot C : mouvements de perte et leurs corrections.
      { name: StockLoss.name, schema: StockLossSchema },
    ]),
    S3Module,
    StorageQuotaModule,
    EventsModule,
    AuditModule,
    // 1-19A : activité des membres annoncée au propriétaire.
    PushModule,
  ],
  providers: [ProductsService, ProductBatchesService],
  controllers: [
    ProductsController,
    ProductBatchesController,
    ExpiryAlertsController,
  ],
  exports: [ProductsService, ProductBatchesService],
})
export class ProductsModule {}
