import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentOrganization } from '../../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import {
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../../organizations/permissions';
import {
  Organization,
  OrganizationDocument,
} from '../../organizations/schemas/organization.schema';
import { Product, ProductDocument } from '../schemas/product.schema';
import {
  ProductBatch,
  ProductBatchDocument,
} from '../batches/schemas/product-batch.schema';
import {
  EXPIRY_ALERT_LEAD_DAYS_MAX,
  nextExpiryAlertOn,
  normalizeLeadDays,
} from './expiry-alerts';
import { expiryAlertsEnabledFor } from './expiry-alerts-config';

export class ExpiryAlertSettingsDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(EXPIRY_ALERT_LEAD_DAYS_MAX)
  leadDays: number;
}

/**
 * Lot C — délai d'anticipation des alertes de péremption du commerce.
 * Lecture : tout membre. Modification : `products.manage_expiry_alerts`,
 * alertes activées (`EXPIRY_ALERTS_ENABLED`), sinon 403. Organisation : celle
 * du contexte, jamais la requête.
 *
 * Un nouveau délai REPLANIFIE seulement les cibles dont l'étape « bientôt »
 * n'a pas encore été annoncée (aucun réarmement) : allongé, des cibles
 * entrent dans la période et sont annoncées au prochain balayage ; réduit,
 * rien n'est retiré de ce qui a déjà été annoncé.
 */
@Controller('expiry-alerts/settings')
export class ExpiryAlertsController {
  constructor(
    @InjectModel(Organization.name)
    private organizationModel: Model<OrganizationDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(ProductBatch.name)
    private batchModel: Model<ProductBatchDocument>,
  ) {}

  @Get()
  async get(@CurrentOrganization() context: ResolvedOrganizationContext) {
    const org = await this.organizationModel
      .findById(context.organizationId)
      .select({ expiryAlertLeadDays: 1 })
      .lean<{ expiryAlertLeadDays?: number }>()
      .exec();
    return {
      enabled: expiryAlertsEnabledFor(context.organizationId),
      leadDays: normalizeLeadDays(org?.expiryAlertLeadDays),
    };
  }

  @Patch()
  async update(
    @Body() dto: ExpiryAlertSettingsDto,
    @CurrentOrganization() context: ResolvedOrganizationContext,
  ) {
    if (!expiryAlertsEnabledFor(context.organizationId)) {
      throw new ForbiddenException({
        code: 'EXPIRY_ALERTS_DISABLED',
        message: 'Les alertes de péremption ne sont pas disponibles.',
      });
    }
    if (!hasPermission(context, 'products.manage_expiry_alerts')) {
      throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
    }
    const orgOid = new Types.ObjectId(context.organizationId);
    await this.organizationModel
      .updateOne(
        { _id: orgOid },
        { $set: { expiryAlertLeadDays: dto.leadDays } },
      )
      .exec();
    await this.replan(orgOid, dto.leadDays);
    return { enabled: true, leadDays: dto.leadDays };
  }

  /** Cibles datées pas encore annoncées « bientôt » : nouvelle date de contrôle. */
  private async replan(orgOid: Types.ObjectId, leadDays: number) {
    for (const model of [
      this.productModel as unknown as Model<PlanTarget>,
      this.batchModel as unknown as Model<PlanTarget>,
    ]) {
      const cursor = model
        .find({
          organizationId: orgOid,
          expiryAlertNextOn: { $type: 'string' },
        })
        .select({ expiryDate: 1, expiryAlerts: 1, expiryAlertNextOn: 1 })
        .lean<PlanTarget>()
        .cursor();
      for await (const row of cursor) {
        const next = nextExpiryAlertOn(
          row.expiryDate,
          leadDays,
          row.expiryAlerts,
        );
        if (next === row.expiryAlertNextOn) continue;
        await model
          .updateOne(
            {
              _id: row._id,
              expiryDate: row.expiryDate,
              expiryAlertNextOn: row.expiryAlertNextOn,
            },
            { $set: { expiryAlertNextOn: next } },
          )
          .exec();
      }
    }
  }
}

interface PlanTarget {
  _id: Types.ObjectId;
  expiryDate?: string | null;
  expiryAlerts?: { soonFor?: string | null; expiredFor?: string | null };
  expiryAlertNextOn?: string | null;
}
