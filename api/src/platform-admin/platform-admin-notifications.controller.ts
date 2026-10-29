import {
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
import type { PlatformAdminRequestContext } from './platform-admin.service';
import { PlatformAdminNotificationsService } from './platform-admin-notifications.service';
import { AdminNotificationsQuery } from './dto/platform-admin.dto';

/**
 * Routes `/platform-admin/notifications/*` : notifications INTERNES des
 * administrateurs (jamais celles des commerces). Même garde (BFF, session
 * administrative, MFA). Aucune capacité unique exigée ici : chaque
 * catégorie est filtrée par sa capacité de consultation, relue à chaque
 * requête (liste, compteur et écritures). Destinataire = utilisateur de la
 * session, jamais un identifiant fourni par le navigateur.
 */
@Public()
@UseGuards(PlatformAdminGuard)
@UseInterceptors(PlatformAdminNoStoreInterceptor)
@Controller('platform-admin/notifications')
export class PlatformAdminNotificationsController {
  constructor(
    private readonly notifications: PlatformAdminNotificationsService,
  ) {}

  @PlatformAdminAccess('mfa')
  @Get()
  list(
    @AdminContext() context: PlatformAdminRequestContext,
    @Query() query: AdminNotificationsQuery,
  ) {
    return this.notifications.list(
      context,
      query.status ?? 'all',
      query.page ?? 1,
    );
  }

  @PlatformAdminAccess('mfa')
  @Get('unread-count')
  unreadCount(@AdminContext() context: PlatformAdminRequestContext) {
    return this.notifications.unreadCount(context);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post('read-all')
  markAllRead(@AdminContext() context: PlatformAdminRequestContext) {
    return this.notifications.markAllRead(context);
  }

  @HttpCode(200)
  @PlatformAdminAccess('mfa')
  @Post(':id/read')
  markRead(
    @AdminContext() context: PlatformAdminRequestContext,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(context, id);
  }
}
