import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import {
  DelegablePermission,
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../../organizations/permissions';
import { User } from '../../users/schemas/user.schema';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe';
import { productVisibility } from '../product-projection';
import { PushOutboxService } from '../../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../../notifications/member-activity';
import {
  BatchStatusChangeDto,
  CorrectLossDto,
  RecordLossDto,
  SaleBatchOptionsQueryDto,
  EnableBatchTrackingDto,
  ReceiveExistingBatchDto,
  ReceiveNewBatchDto,
  UpdateBatchDto,
} from './dto/product-batch.dto';
import {
  ProductBatchesService,
  type BatchOperationResult,
} from './product-batches.service';
import { productBatchesEnabledFor } from './product-batches-config';
import { PRODUCT_BATCH_ERROR_CODES } from './product-batch-errors';

/**
 * Matrice des droits des lots (refus 403 uniforme, rien n'est écrit) :
 *
 * | Opération | Droits |
 * |---|---|
 * | Consulter les lots (identité, dates) | tout membre |
 * | … et leurs quantités | + `products.view_stock_details` |
 * | Activer le suivi et répartir le stock existant | `stock.manage_batches` |
 * | Recevoir dans un NOUVEAU lot (crée son identité) | `products.manage` + `stock.adjust` |
 * | Recevoir dans un lot existant | `stock.adjust` |
 * | Modifier l'identité d'un lot | `products.manage` |
 * | Renseigner ou modifier une date de péremption (toute opération ci-dessus) | + `products.manage_expiry` |
 * | Options de vente (lot B : choix des lots d'une vente) | `sales.record` ; quantités par lot + `products.view_stock_details` |
 * | Mettre un lot à l'écart / le remettre à disposition (lot C) | `stock.quarantine_batches` |
 * | Enregistrer une perte / la corriger (lot C) | `stock.record_losses` |
 * | Historique des pertes (lot C) | `products.view_stock_details` ; valeurs + `products.view_financials` |
 *
 * Fonctionnalité désactivée (`PRODUCT_BATCHES_ENABLED` ≠ `true`) : 403
 * `PRODUCT_BATCHES_DISABLED` sur toutes ces routes. Organisation : celle du
 * contexte (garde), jamais la requête ; un produit ou un lot d'un autre
 * commerce est indistinguable d'un absent (404).
 */
@Controller('products/:id')
export class ProductBatchesController {
  constructor(
    private readonly batches: ProductBatchesService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  private assertEnabled(organizationId: string): void {
    if (!productBatchesEnabledFor(organizationId)) {
      throw new ForbiddenException({
        code: PRODUCT_BATCH_ERROR_CODES.PRODUCT_BATCHES_DISABLED,
        message: "Le suivi par lots n'est pas disponible.",
      });
    }
  }

  private require(
    context: ResolvedOrganizationContext,
    permissions: DelegablePermission[],
  ): void {
    if (!permissions.every((p) => hasPermission(context, p))) {
      throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
    }
  }

  /** Activité annoncée au propriétaire (best effort, une fois par écriture). */
  private async announce(
    context: ResolvedOrganizationContext,
    productId: string,
    result: BatchOperationResult,
    uniqueKey?: string,
  ): Promise<void> {
    if (!result.changed) return;
    await this.pushOutbox.memberActivity(context, {
      entity: MemberActivityEntity.PRODUCT,
      action: MemberActivityAction.UPDATED,
      targetId: productId,
      targetName: result.productName,
      uniqueKey,
    });
  }

  @Get('batches')
  list(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    return this.batches.list(
      context.organizationId,
      id,
      productVisibility(context),
    );
  }

  /**
   * Lot B — options de vente : lots vendables (FEFO), lots sans date à
   * part, suggestion plafonnée à la quantité demandée. Droits de vente
   * seulement ; aucune quantité par lot sans `products.view_stock_details`.
   */
  @Get('batches/sale-options')
  saleOptions(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query() query: SaleBatchOptionsQueryDto,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['sales.record']);
    return this.batches.saleOptions(
      context.organizationId,
      id,
      query.quantity,
      productVisibility(context),
    );
  }

  @Post('batch-tracking')
  async enable(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: EnableBatchTrackingDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, [
      'stock.manage_batches',
      ...(dto.batches.some((b) => b.expiryDate != null)
        ? (['products.manage_expiry'] as const)
        : []),
    ]);
    const result = await this.batches.enableTracking(
      context.organizationId,
      id,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result, `batch:${dto.clientOperationId}`);
    return result;
  }

  @Post('batches')
  async receiveNew(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: ReceiveNewBatchDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, [
      'products.manage',
      'stock.adjust',
      ...(dto.expiryDate != null ? (['products.manage_expiry'] as const) : []),
    ]);
    const result = await this.batches.receiveNew(
      context.organizationId,
      id,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result, `batch:${dto.clientOperationId}`);
    return result;
  }

  @Post('batches/:batchId/receptions')
  async receiveExisting(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('batchId', ParseObjectIdPipe) batchId: string,
    @Body() dto: ReceiveExistingBatchDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['stock.adjust']);
    const result = await this.batches.receiveExisting(
      context.organizationId,
      id,
      batchId,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result, `batch:${dto.clientOperationId}`);
    return result;
  }

  // ─── Lot C : mise à l'écart, pertes (en ligne uniquement) ─────────────

  @Post('batches/:batchId/quarantine')
  async quarantine(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('batchId', ParseObjectIdPipe) batchId: string,
    @Body() dto: BatchStatusChangeDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['stock.quarantine_batches']);
    const result = await this.batches.changeStatus(
      context.organizationId,
      id,
      batchId,
      'quarantine',
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, { ...result, changed: true });
    return result;
  }

  @Post('batches/:batchId/release')
  async release(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('batchId', ParseObjectIdPipe) batchId: string,
    @Body() dto: BatchStatusChangeDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['stock.quarantine_batches']);
    const result = await this.batches.changeStatus(
      context.organizationId,
      id,
      batchId,
      'release',
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, { ...result, changed: true });
    return result;
  }

  @Post('batches/:batchId/losses')
  async recordLoss(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('batchId', ParseObjectIdPipe) batchId: string,
    @Body() dto: RecordLossDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['stock.record_losses']);
    const result = await this.batches.recordLoss(
      context.organizationId,
      id,
      batchId,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result, `loss:${dto.clientOperationId}`);
    return result;
  }

  @Post('losses/:lossId/corrections')
  async correctLoss(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('lossId', ParseObjectIdPipe) lossId: string,
    @Body() dto: CorrectLossDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['stock.record_losses']);
    const result = await this.batches.correctLoss(
      context.organizationId,
      id,
      lossId,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result, `loss:${dto.clientOperationId}`);
    return result;
  }

  @Get('losses')
  listLosses(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, ['products.view_stock_details']);
    return this.batches.listLosses(
      context.organizationId,
      id,
      productVisibility(context),
    );
  }

  @Patch('batches/:batchId')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('batchId', ParseObjectIdPipe) batchId: string,
    @Body() dto: UpdateBatchDto,
    @CurrentUser() user: User,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    this.assertEnabled(context.organizationId);
    this.require(context, [
      'products.manage',
      ...(dto.expiryDate !== undefined
        ? (['products.manage_expiry'] as const)
        : []),
    ]);
    const result = await this.batches.updateBatch(
      context.organizationId,
      id,
      batchId,
      dto,
      user._id.toString(),
      productVisibility(context),
    );
    await this.announce(context, id, result);
    return result;
  }
}
