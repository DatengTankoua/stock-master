import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesHistoryQueryDto } from './dto/sales-history-query.dto';
import { SALES_HISTORY_DEFAULT_LIMIT } from './sale-history';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { User } from '../users/schemas/user.schema';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  DelegablePermission,
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';
import {
  BatchReasonDto,
  CancelSaleDto,
  LegacyRestitutionFields,
} from '../products/batches/dto/product-batch.dto';
import { SaleRegularizationQueryDto } from './dto/sale-regularization.dto';

/**
 * Lot B — responsable d'une régularisation : ajuste le stock ET voit les
 * ventes de tout le commerce (la vente est créée au nom d'un collègue).
 */
const REGULARIZATION_MANAGER: DelegablePermission[] = [
  'stock.adjust',
  'sales.view_all',
];

/**
 * Lot B — droits ADDITIONNELS (en plus de `sales.record`) :
 * - restitution d'unités d'origine inconnue (vente antérieure à
 *   l'activation) vers des lots choisis : `stock.adjust` ;
 * - destination « lot historique, date inconnue » créée pour l'occasion :
 *   `stock.adjust` + `products.manage` (identité d'un lot) ;
 * - régularisation d'une vente hors ligne d'un lot dépassé à la réception :
 *   `stock.adjust`.
 * Vendre, rendre aux lots d'origine ou ajouter des unités ne demandent que
 * les droits de vente actuels.
 */
function restitutionPermissions(
  dto: LegacyRestitutionFields,
): DelegablePermission[] {
  const needed: DelegablePermission[] = [];
  if (dto.restitutions?.length || dto.historicalRestitution) {
    needed.push('stock.adjust');
  }
  if (dto.historicalRestitution) needed.push('products.manage');
  return needed;
}

function requireAll(
  context: ResolvedOrganizationContext,
  permissions: DelegablePermission[],
): void {
  if (!permissions.every((p) => hasPermission(context, p))) {
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }
}
import {
  AllowInactiveSubscription,
  CurrentSubscriptionAccess,
} from '../subscriptions/subscription-access';
import type { SubscriptionAccessDecision } from '../subscriptions/subscription-access';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  /**
   * 1-19A : modification et annulation RÉUSSIES annoncées au propriétaire
   * (best effort, après le service). La création a sa propre notification
   * (`sale-created`) : jamais annoncée en double ici.
   */
  private activity(
    context: ResolvedOrganizationContext,
    action: MemberActivityAction,
    saleId: string,
    productName: string | null | undefined,
    uniqueKey?: string,
  ): Promise<void> {
    return this.pushOutbox.memberActivity(context, {
      entity: MemberActivityEntity.SALE,
      action,
      targetId: saleId,
      targetName: productName ?? null,
      uniqueKey,
    });
  }

  // 1-14C.1 : exception `sale-replay` — JWT applicatif, membership et
  // `sales.record` toujours exigés. Abonnement inactif : seule la
  // confirmation d'une opération DÉJÀ appliquée est possible (aucune
  // écriture) ; toute nouvelle vente → 403 `SUBSCRIPTION_INACTIVE`.
  @Post()
  @AllowInactiveSubscription('sale-replay')
  @RequirePermissions('sales.record')
  create(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @CurrentSubscriptionAccess() access: SubscriptionAccessDecision | undefined,
  ) {
    if (dto.expiredBatchRegularization) {
      requireAll(organizationContext, ['stock.adjust']);
    }
    return this.salesService.create(
      organizationContext.organizationId,
      dto,
      user._id.toString(),
      // Fail-closed : sans décision du guard, aucune nouvelle écriture.
      { newWritesAllowed: access?.active === true },
    );
  }

  // 1-7B — pas de métadonnée unique possible (OU entre deux permissions
  // au scope différent) : la décision de scope est prise ici, pas par
  // `PermissionGuard`.
  @Get()
  findAll(
    @Query('productId') productId: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
      );
    }
    if (hasPermission(organizationContext, 'sales.view_own')) {
      return this.salesService.findAll(
        organizationContext.organizationId,
        productId,
        organizationContext.userId,
      );
    }
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }

  /**
   * 1-20E — Historique PAGINÉ (contrat explicite, à côté de `GET /sales`
   * conservé tel quel pour les anciens clients). Mêmes permissions et même
   * périmètre que `findAll` : `view_all` → toute l'organisation, `view_own`
   * → ventes du demandeur seulement (pages ET total), 403 sinon.
   * Réponse : `{ items, total, nextCursor }` (`nextCursor` null en fin).
   */
  @Get('history')
  findHistory(
    @Query() query: SalesHistoryQueryDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const options = {
      limit: query.limit ?? SALES_HISTORY_DEFAULT_LIMIT,
      cursor: query.cursor,
      productId: query.productId,
    };
    if (hasPermission(organizationContext, 'sales.view_all')) {
      return this.salesService.findHistoryPage(
        organizationContext.organizationId,
        options,
      );
    }
    if (hasPermission(organizationContext, 'sales.view_own')) {
      return this.salesService.findHistoryPage(
        organizationContext.organizationId,
        options,
        organizationContext.userId,
      );
    }
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }

  /**
   * Lot B — demande de régularisation d'une vente hors ligne refusée
   * `BATCH_EXPIRED_AT_SYNC`, par son vendeur (droits de vente). Corps =
   * l'opération en attente telle quelle (même `clientOperationId`).
   */
  @Post('regularizations')
  @RequirePermissions('sales.record')
  requestRegularization(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.salesService.requestRegularization(
      organizationContext.organizationId,
      dto,
      user._id.toString(),
    );
  }

  /** Responsable : tout le commerce ; sinon : ses propres demandes. */
  @Get('regularizations')
  @RequirePermissions('sales.record')
  listRegularizations(
    @Query() query: SaleRegularizationQueryDto,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const manager = REGULARIZATION_MANAGER.every((p) =>
      hasPermission(organizationContext, p),
    );
    return this.salesService.listRegularizations(
      organizationContext.organizationId,
      {
        ...(manager ? {} : { scopeSellerId: organizationContext.userId }),
        clientOperationIds: query.clientOperationIds,
        status: query.status,
      },
    );
  }

  @Post('regularizations/:id/approve')
  approveRegularization(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: BatchReasonDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    requireAll(organizationContext, REGULARIZATION_MANAGER);
    return this.salesService.approveRegularization(
      organizationContext.organizationId,
      id,
      user._id.toString(),
      dto.reason,
    );
  }

  @Post('regularizations/:id/reject')
  rejectRegularization(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: BatchReasonDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    requireAll(organizationContext, REGULARIZATION_MANAGER);
    return this.salesService.rejectRegularization(
      organizationContext.organizationId,
      id,
      user._id.toString(),
      dto.reason,
    );
  }

  @Patch(':id')
  @RequirePermissions('sales.record')
  async update(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSaleDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    requireAll(organizationContext, restitutionPermissions(dto));
    const actorId = user._id.toString();
    // sans `sales.view_all` : uniquement ses propres ventes (404 sinon,
    // indistinguable d'une vente absente — jamais de fuite d'existence).
    const updated = hasPermission(organizationContext, 'sales.view_all')
      ? await this.salesService.update(
          organizationContext.organizationId,
          id,
          dto,
          actorId,
        )
      : await this.salesService.update(
          organizationContext.organizationId,
          id,
          dto,
          actorId,
          organizationContext.userId,
        );
    await this.activity(
      organizationContext,
      MemberActivityAction.UPDATED,
      id,
      updated.productName ?? updated.lastKnownProductName,
    );
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales.record')
  async remove(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    // Lot B : corps facultatif (restitution d'une vente antérieure aux
    // lots) ; un client antérieur n'envoie rien.
    @Body() cancel: CancelSaleDto = {},
  ): Promise<void> {
    requireAll(organizationContext, restitutionPermissions(cancel ?? {}));
    const actorId = user._id.toString();
    const removed = hasPermission(organizationContext, 'sales.view_all')
      ? await this.salesService.remove(
          organizationContext.organizationId,
          id,
          actorId,
          undefined,
          cancel ?? {},
        )
      : await this.salesService.remove(
          organizationContext.organizationId,
          id,
          actorId,
          organizationContext.userId,
          cancel ?? {},
        );
    // Une vente n'est annulée qu'une fois : clé stable.
    await this.activity(
      organizationContext,
      MemberActivityAction.CANCELLED,
      id,
      removed.productName,
      id,
    );
  }
}
