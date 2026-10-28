import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import {
  AdminContext,
  PlatformAdminAccess,
  PlatformAdminCapability,
  PlatformAdminGuard,
  PlatformAdminNoStoreInterceptor,
} from './platform-admin.guard';
import type { PlatformAdminRequestContext } from './platform-admin.service';
import {
  normalizeIntent,
  type CampaignLaunchIntent,
} from './platform-admin-action-intent';
import { PlatformCampaignsService } from './platform-campaigns.service';
import {
  AdminCampaignDraftDto,
  AdminCampaignLaunchDto,
  AdminCampaignPreviewQuery,
  AdminCampaignsQuery,
  AdminCampaignUpdateDto,
  AdminMessagesQuery,
} from './dto/platform-admin.dto';

/**
 * Routes `/platform-admin/campaigns/*` : campagnes promotionnelles, à part
 * des messages de service (`organizations/:id/messages`). Même garde (BFF,
 * session administrative, MFA). Consultation : `platform.read`. Écritures :
 * capacités dédiées, vérifiées (et refus audités) par le service.
 */
@Public()
@UseGuards(PlatformAdminGuard)
@UseInterceptors(PlatformAdminNoStoreInterceptor)
@Controller('platform-admin/campaigns')
export class PlatformCampaignsController {
  constructor(private readonly campaigns: PlatformCampaignsService) {}

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get()
  list(@Query() query: AdminCampaignsQuery) {
    return this.campaigns.list(query.archived ?? 'active', query.page ?? 1);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post()
  create(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminCampaignDraftDto,
  ) {
    return this.campaigns.create(context, dto);
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.campaigns.detail(id);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post(':id')
  update(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminCampaignUpdateDto,
  ) {
    const { revision, ...draft } = dto;
    return this.campaigns.update(context, id, revision, draft);
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get(':id/preview')
  preview(@Param('id') id: string, @Query() query: AdminCampaignPreviewQuery) {
    return this.campaigns.preview(id, query.locale ?? 'fr');
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get(':id/estimate')
  estimate(@Param('id') id: string) {
    return this.campaigns.estimate(id);
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get(':id/results')
  results(@Param('id') id: string, @Query() query: AdminMessagesQuery) {
    return this.campaigns.results(id, query.page ?? 1);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post(':id/launch')
  launch(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminCampaignLaunchDto,
  ) {
    return this.campaigns.launch(
      context,
      normalizeIntent({
        action: 'campaign_launch',
        campaignId: id,
        operationId: dto.operationId,
        revision: dto.revision,
        subject: dto.subject,
        body: dto.body,
        targeting: dto.targeting,
      }) as CampaignLaunchIntent,
      dto.stepUpToken,
    );
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post(':id/archive')
  archive(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    return this.campaigns.setArchived(context, id, true);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post(':id/restore')
  restore(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    return this.campaigns.setArchived(context, id, false);
  }
}
