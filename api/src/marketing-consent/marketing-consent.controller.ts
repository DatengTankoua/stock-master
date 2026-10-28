import {
  Body,
  Controller,
  Get,
  HttpCode,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SkipOrganizationContext } from '../auth/decorators/skip-organization-context.decorator';
import type { AuthenticatedPrincipal } from '../auth/strategies/jwt.strategy';
import { AllowInactiveSubscription } from '../subscriptions/subscription-access';
import { NoStoreInterceptor } from '../subscriptions/payments/subscription-payments.controller';
import { MarketingEmailConsentDto } from './dto/marketing-consent.dto';
import { MarketingConsentService } from './marketing-consent.service';

/**
 * Accord aux e-mails promotionnels du compte CONNECTÉ (réglages
 * personnels). Identité seule : l'utilisateur vient du JWT (`sub`), jamais
 * du corps (tout champ en plus est refusé, 400). Aucune organisation, aucun
 * droit, aucun mot de passe ni MFA : comme la langue du compte, une session
 * limitée peut aussi retirer son accord.
 */
@Controller('auth/me/marketing-consent')
@UseInterceptors(NoStoreInterceptor)
@AllowInactiveSubscription('identity')
@SkipOrganizationContext()
export class MarketingConsentController {
  constructor(private readonly consent: MarketingConsentService) {}

  @Get()
  view(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.consent.view(user._id.toString());
  }

  @HttpCode(200)
  @Put()
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: MarketingEmailConsentDto,
  ) {
    return this.consent.update(user._id.toString(), dto);
  }
}
