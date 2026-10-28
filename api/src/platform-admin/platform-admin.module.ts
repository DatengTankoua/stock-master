import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { StorageQuotaModule } from '../storage-quota/storage-quota.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { MarketingConsentModule } from '../marketing-consent/marketing-consent.module';
import { PlatformCampaignsService } from './platform-campaigns.service';
import { PlatformCampaignsController } from './platform-campaigns.controller';
import {
  CAMPAIGN_SLEEP,
  PlatformCampaignDeliveryService,
  type CampaignSleep,
} from './platform-campaign-delivery.service';

const realSleep: CampaignSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
import { PlatformAdminCommunicationsService } from './platform-admin-communications.service';
import { PlatformMessageDeliveryService } from './platform-message-delivery.service';
import { PlatformAdminActionsService } from './platform-admin-actions.service';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminDataService } from './platform-admin-data.service';
import {
  PlatformAdminRuntime,
  platformAdminClockProvider,
  platformAdminConfigProvider,
} from './platform-admin-runtime';

/**
 * Administration de la plateforme : autorisation distincte des
 * permissions des commerces, session administrative et double
 * authentification obligatoire, données en lecture seule ; actions et
 * messages de service (capacités dédiées, preuve renforcée liée).
 */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    RateLimitModule,
    StorageQuotaModule,
    SubscriptionsModule,
    OrganizationsModule,
    // Messages de service : centre de notifications, push, expéditeur.
    NotificationsModule,
    PushModule,
    EmailVerificationModule,
    // Campagnes : éligibilité et désabonnement (accord marketing).
    MarketingConsentModule,
  ],
  controllers: [PlatformAdminController, PlatformCampaignsController],
  providers: [
    platformAdminConfigProvider,
    platformAdminClockProvider,
    PlatformAdminRuntime,
    PlatformAdminService,
    PlatformAdminDataService,
    PlatformAdminActionsService,
    PlatformAdminGuard,
    PlatformAdminCommunicationsService,
    PlatformMessageDeliveryService,
    PlatformCampaignsService,
    PlatformCampaignDeliveryService,
    { provide: CAMPAIGN_SLEEP, useValue: realSleep },
  ],
  exports: [PlatformMessageDeliveryService, PlatformCampaignDeliveryService],
})
export class PlatformAdminModule {}
