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
  PlatformAdminGuard,
  PlatformAdminNoStoreInterceptor,
} from './platform-admin.guard';
import {
  PlatformAdminService,
  type PlatformAdminRequestContext,
} from './platform-admin.service';
import { PlatformAdminDataService } from './platform-admin-data.service';
import {
  AdminAuditQuery,
  AdminCodeDto,
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
    return this.service.stepUp(context, dto);
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
  @Get('overview')
  overview() {
    return this.data.overview();
  }

  @PlatformAdminAccess('mfa')
  @Get('organizations')
  organizations(@Query() query: AdminOrganizationsQuery) {
    return this.data.organizations(query);
  }

  @PlatformAdminAccess('mfa')
  @Get('organizations/:id')
  async organization(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    const detail = await this.data.organization(id);
    await this.service.recordConsultation(context, 'organization_view', id);
    return detail;
  }

  @PlatformAdminAccess('mfa')
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
  @Get('audit')
  async audit(
    @AdminContext() context: PlatformAdminRequestContext,
    @Query() query: AdminAuditQuery,
  ) {
    const page = await this.data.audit(query);
    await this.service.recordConsultation(context, 'audit_view');
    return page;
  }
}
