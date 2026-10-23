import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { StorageQuotaModule } from '../storage-quota/storage-quota.module';
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
 * authentification obligatoire, données en lecture seule.
 */
@Module({
  imports: [AuthModule, UsersModule, RateLimitModule, StorageQuotaModule],
  controllers: [PlatformAdminController],
  providers: [
    platformAdminConfigProvider,
    platformAdminClockProvider,
    PlatformAdminRuntime,
    PlatformAdminService,
    PlatformAdminDataService,
    PlatformAdminGuard,
  ],
})
export class PlatformAdminModule {}
