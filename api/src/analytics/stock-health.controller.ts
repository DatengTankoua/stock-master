import { Controller, Get, Header, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { productVisibility } from '../products/product-projection';
import { StockHealthService } from './stock-health.service';

/**
 * Lot C — rubriques « Expire bientôt », « Périmés » et pertes de l'Analyse
 * (`analytics.read`). Quantités : `products.view_stock_details` ; valeur
 * estimée des pertes : + `products.view_financials`. Disponible même si les
 * alertes sont désactivées (consultation, aucune notification).
 */
@Controller('analytics/stock-health')
@RequirePermissions('analytics.read')
export class StockHealthController {
  constructor(private readonly stockHealth: StockHealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @Query('month') month: string | undefined,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    return this.stockHealth.get(
      context.organizationId,
      productVisibility(context),
      month,
    );
  }
}
