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
import {
  PlatformAdminService,
  type PlatformAdminRequestContext,
} from './platform-admin.service';
import { PlatformAdminDataService } from './platform-admin-data.service';
import { PlatformAdminActionsService } from './platform-admin-actions.service';
import {
  normalizeIntent,
  normalizeOrganizationAction,
  type MessageIntent,
  type MessageRetryIntent,
} from './platform-admin-action-intent';
import { PlatformAdminCommunicationsService } from './platform-admin-communications.service';
import {
  AdminAuditQuery,
  AdminCodeDto,
  AdminExtendDto,
  AdminExtensionPreviewQuery,
  AdminMessageArchiveDto,
  AdminMessageDto,
  AdminMessageRetryDto,
  AdminMessagesQuery,
  AdminReactivateDto,
  AdminSuspendDto,
  AdminLoginDto,
  AdminOrganizationsQuery,
  AdminPaymentsQuery,
  AdminStepUpDto,
  AdminStepUpTokenDto,
  AdminVerifyDto,
} from './dto/platform-admin.dto';

/**
 * Routes `/platform-admin/*`. `@Public()` vaut UNIQUEMENT pour les gardes
 * des commerces (aucun JWT Bearer, aucune organisation) : chaque route
 * passe par `PlatformAdminGuard` (BFF, session administrative, niveau).
 *
 * Champ `session` des réponses : jeton de session NEUF, retiré par le BFF
 * et posé en cookie HttpOnly (jamais transmis au navigateur en clair).
 */
@Public()
@UseGuards(PlatformAdminGuard)
@UseInterceptors(PlatformAdminNoStoreInterceptor)
@Controller('platform-admin')
export class PlatformAdminController {
  constructor(
    private readonly service: PlatformAdminService,
    private readonly data: PlatformAdminDataService,
    private readonly actions: PlatformAdminActionsService,
    private readonly communications: PlatformAdminCommunicationsService,
  ) {}

  // ─── Connexion et second facteur ──────────────────────────────────────

  @HttpCode(200)
  @PlatformAdminAccess('login')
  @Post('auth/login')
  login(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminLoginDto,
  ) {
    return this.service.login(dto, context);
  }

  @PlatformAdminAccess('session')
  @Get('auth/status')
  status(@AdminContext() context: PlatformAdminRequestContext) {
    return this.service.status(context);
  }

  @HttpCode(200)
  @PlatformAdminAccess('session')
  @Post('auth/logout')
  async logout(@AdminContext() context: PlatformAdminRequestContext) {
    await this.service.logout(context);
    return { sessionCleared: true };
  }

  @HttpCode(200)
  @PlatformAdminAccess('pre-mfa')
  @Post('mfa/challenge')
  async challenge(@AdminContext() context: PlatformAdminRequestContext) {
    return { challenge: await this.service.newLoginChallenge(context) };
  }

  @HttpCode(200)
  @PlatformAdminAccess('pre-mfa')
  @Post('mfa/verify')
  verify(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminVerifyDto,
  ) {
    return this.service.verifyLogin(context, dto);
  }

  @HttpCode(200)
  @PlatformAdminAccess('pre-mfa')
  @Post('mfa/enrollment/start')
  startEnrollment(@AdminContext() context: PlatformAdminRequestContext) {
    return this.service.startEnrollment(context);
  }

  @HttpCode(200)
  @PlatformAdminAccess('pre-mfa')
  @Post('mfa/enrollment/confirm')
  confirmEnrollment(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminCodeDto,
  ) {
    return this.service.confirmEnrollment(context, dto);
  }

  // ─── Sécurité du compte administrateur ────────────────────────────────

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('security/step-up')
  stepUp(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminStepUpDto,
  ) {
    // `intent` : preuve liée à une action (normalisée, 400 si invalide).
    const { intent, ...factor } = dto;
    return this.service.stepUp(
      context,
      factor,
      intent ? normalizeIntent(intent) : null,
    );
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('security/recovery-codes')
  regenerateRecoveryCodes(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminStepUpTokenDto,
  ) {
    return this.service.regenerateRecoveryCodes(context, dto);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('security/factor/start')
  startFactorReplacement(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminStepUpTokenDto,
  ) {
    return this.service.startFactorReplacement(context, dto);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('security/factor/confirm')
  confirmFactorReplacement(
    @AdminContext() context: PlatformAdminRequestContext,
    @Body() dto: AdminCodeDto,
  ) {
    return this.service.confirmFactorReplacement(context, dto);
  }

  // ─── Données en lecture seule ─────────────────────────────────────────

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('overview')
  overview() {
    return this.data.overview();
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('organizations')
  organizations(@Query() query: AdminOrganizationsQuery) {
    return this.data.organizations(query);
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('organizations/:id')
  async organization(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    const detail = await this.data.organization(id);
    await this.service.recordConsultation(context, 'organization_view', id);
    return { ...detail, actions: await this.actions.history(id) };
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('payments')
  async payments(
    @AdminContext() context: PlatformAdminRequestContext,
    @Query() query: AdminPaymentsQuery,
  ) {
    const page = await this.data.payments(query);
    await this.service.recordConsultation(
      context,
      'payments_view',
      query.organizationId ?? null,
    );
    return page;
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('audit')
  async audit(
    @AdminContext() context: PlatformAdminRequestContext,
    @Query() query: AdminAuditQuery,
  ) {
    const page = await this.data.audit(query);
    await this.service.recordConsultation(context, 'audit_view');
    return page;
  }

  // ─── Actions (capacité dédiée, preuve renforcée liée, idempotence) ─────

  @PlatformAdminAccess('mfa')
  @Get('organizations/:id/extension-preview')
  extensionPreview(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Query() query: AdminExtensionPreviewQuery,
  ) {
    return this.actions.extensionPreview(context, id, query.days);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/suspend')
  suspend(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminSuspendDto,
  ) {
    return this.actions.execute(
      context,
      normalizeOrganizationAction({
        action: 'organization_suspend',
        organizationId: id,
        operationId: dto.operationId,
        internalReason: dto.internalReason,
        clientMessage: dto.clientMessage,
      }),
      dto.stepUpToken,
    );
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/reactivate')
  reactivate(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminReactivateDto,
  ) {
    return this.actions.execute(
      context,
      normalizeOrganizationAction({
        action: 'organization_reactivate',
        organizationId: id,
        operationId: dto.operationId,
        reason: dto.reason,
      }),
      dto.stepUpToken,
    );
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/extend')
  extend(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminExtendDto,
  ) {
    return this.actions.execute(
      context,
      normalizeOrganizationAction({
        action: 'subscription_extend',
        organizationId: id,
        operationId: dto.operationId,
        days: dto.days,
        reason: dto.reason,
        expectedCoverageEndsAt: dto.expectedCoverageEndsAt,
      }),
      dto.stepUpToken,
    );
  }

  // ─── Messages de service (capacité par canal, preuve liée) ─────────────

  @PlatformAdminAccess('mfa')
  @Get('organizations/:id/message-recipients')
  messageRecipients(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    return this.communications.recipients(context, id);
  }

  @PlatformAdminAccess('mfa')
  @PlatformAdminCapability('platform.read')
  @Get('organizations/:id/messages')
  messages(@Param('id') id: string, @Query() query: AdminMessagesQuery) {
    return this.communications.history(
      id,
      query.page ?? 1,
      query.archived ?? 'active',
    );
  }

  // Archivage réversible : capacité dédiée vérifiée (et refus audité) par
  // le service ; confirmation simple côté interface, sans preuve renforcée.
  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/message-archive')
  archiveMessages(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminMessageArchiveDto,
  ) {
    return this.communications.setArchived(context, id, dto.messageIds, true);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/message-restore')
  restoreMessages(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminMessageArchiveDto,
  ) {
    return this.communications.setArchived(context, id, dto.messageIds, false);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/messages')
  sendMessage(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminMessageDto,
  ) {
    return this.communications.send(
      context,
      normalizeIntent({
        action: 'organization_message',
        organizationId: id,
        operationId: dto.operationId,
        channels: dto.channels,
        recipientUserIds: dto.recipientUserIds,
        title: dto.title,
        body: dto.body,
      }) as MessageIntent,
      dto.stepUpToken,
    );
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('organizations/:id/message-retry')
  retryMessage(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
    @Body() dto: AdminMessageRetryDto,
  ) {
    return this.communications.retry(
      context,
      normalizeIntent({
        action: 'organization_message_retry',
        organizationId: id,
        operationId: dto.operationId,
        messageId: dto.messageId,
        channel: dto.channel,
        deliveryIds: dto.deliveryIds,
      }) as MessageRetryIntent,
      dto.stepUpToken,
    );
  }
}
