import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { AllowInactiveSubscription } from '../subscriptions/subscription-access';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import {
  PushEndpointDto,
  ReconcilePushSubscriptionDto,
  RegisterPushSubscriptionDto,
  UpdatePushPreferencesDto,
} from './dto/push-subscription.dto';
import {
  PushMemberContext,
  PushSubscriptionsService,
} from './push-subscriptions.service';

/** Empreinte du jeton porteur : identifie la session (jamais stocké brut). */
const sessionKey = (req: Request): string =>
  createHash('sha256')
    .update(req.headers.authorization ?? '')
    .digest('hex');

const toContext = (
  context: ResolvedOrganizationContext,
): PushMemberContext => ({
  userId: context.userId,
  organizationId: context.organizationId,
  role: context.role,
  permissions: context.permissions,
});

/**
 * 1-16A — Notifications push de l'appareil courant.
 *
 * Gardes globaux inchangés : JWT, e-mail vérifié, version de session,
 * membership active et organisation active (`OrganizationGuard`), JWT
 * applicatif et abonnement actif (`SubscriptionAccessGuard`). Utilisateur,
 * organisation, rôle et permissions : contexte SERVEUR uniquement.
 *
 * Seules exceptions commerciales : `POST …/subscription/remove` et
 * `…/subscription/release` (`identity`) — le retrait ou le détachement de
 * l'appareil reste possible à la déconnexion d'une session limitée ou d'une
 * organisation dont l'abonnement a expiré ; ils ne font que couper des
 * envois, jamais en ouvrir.
 *
 * Aucune réponse ne contient d'endpoint ni de clé.
 */
@Controller('notifications/push')
@UseInterceptors(NoStoreInterceptor)
export class PushController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Get('config')
  config(@CurrentOrganization() context: ResolvedOrganizationContext) {
    return this.subscriptions.config(toContext(context));
  }

  @Post('subscription')
  @HttpCode(200)
  register(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: RegisterPushSubscriptionDto,
  ) {
    return this.subscriptions.register(toContext(context), dto);
  }

  @Post('subscription/status')
  @HttpCode(200)
  status(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: PushEndpointDto,
  ) {
    return this.subscriptions.status(toContext(context), dto.endpoint);
  }

  @Patch('subscription')
  updatePreferences(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: UpdatePushPreferencesDto,
  ) {
    return this.subscriptions.updatePreferences(
      toContext(context),
      dto.endpoint,
      dto.preferences,
    );
  }

  @Post('subscription/remove')
  @HttpCode(204)
  @AllowInactiveSubscription('identity')
  async remove(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: PushEndpointDto,
  ): Promise<void> {
    await this.subscriptions.remove(context.userId, dto.endpoint);
  }

  /**
   * Déconnexion : plus aucun envoi vers ce navigateur, préférences
   * conservées. Même exception commerciale que le retrait.
   */
  @Post('subscription/release')
  @HttpCode(204)
  @AllowInactiveSubscription('identity')
  async release(
    @Req() req: Request,
    @Body() dto: PushEndpointDto,
  ): Promise<void> {
    await this.subscriptions.release(dto.endpoint, sessionKey(req));
  }

  /** Réconciliation d'un abonnement existant (voir le service). */
  @Post('subscription/reconcile')
  @HttpCode(200)
  reconcile(
    @Req() req: Request,
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Body() dto: ReconcilePushSubscriptionDto,
  ) {
    return this.subscriptions.reconcile(
      toContext(context),
      dto,
      sessionKey(req),
    );
  }
}
