import {
  CallHandler,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { isIP } from 'net';
import type { Observable } from 'rxjs';
import { clientKeyFor } from '../common/auth-rate-limiting';
import {
  PlatformAdminService,
  type AccessLevel,
  type PlatformAdminRequestContext,
} from './platform-admin.service';

/**
 * En-têtes posés UNIQUEMENT par la route serveur Next.js (BFF) :
 * - secret partagé du BFF (aucun navigateur ne l'a) ;
 * - jeton de session, lu dans le cookie HttpOnly de même origine ;
 * - adresse du client vue par le BFF (approuvée seulement avec le secret).
 */
export const ADMIN_PROXY_HEADER = 'x-platform-admin-proxy';
export const ADMIN_SESSION_HEADER = 'x-platform-admin-session';
export const ADMIN_CLIENT_IP_HEADER = 'x-platform-admin-client-ip';

const ACCESS_LEVEL_KEY = 'platformAdminAccessLevel';

/**
 * Niveau exigé : `login` (BFF seul), `session` (toute session valable),
 * `pre-mfa` (mot de passe vérifié, second facteur pas encore validé :
 * enrôlement et challenge seulement), `mfa` (session complète).
 */
export const PlatformAdminAccess = (level: AccessLevel) =>
  SetMetadata(ACCESS_LEVEL_KEY, level);

type AdminRequest = Request & { platformAdmin?: PlatformAdminRequestContext };

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Garde des routes `/platform-admin`. Ces routes sont `@Public()` pour les
 * gardes de commerce (aucun JWT, aucune organisation, aucune permission
 * délégable) : un JWT de commerce n'y ouvre RIEN, et l'accès plateforme
 * n'ouvre rien sur les routes métier. Niveau absent → `mfa` (refus par
 * défaut de toute route oubliée).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: PlatformAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level =
      this.reflector.getAllAndOverride<AccessLevel>(ACCESS_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'mfa';
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const proxySecret = header(request, ADMIN_PROXY_HEADER);
    const forwarded = header(request, ADMIN_CLIENT_IP_HEADER)?.trim();
    request.platformAdmin = await this.service.authenticate(level, {
      proxySecret,
      sessionToken: header(request, ADMIN_SESSION_HEADER),
      // L'adresse transmise n'est retenue que si elle est une IP valide ; le
      // secret du BFF est vérifié par `authenticate` avant tout usage.
      clientKey: clientKeyFor(
        forwarded && isIP(forwarded) ? forwarded : request.ip,
      ),
    });
    return true;
  }
}

export const AdminContext = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): PlatformAdminRequestContext => {
    const request = ctx.switchToHttp().getRequest<AdminRequest>();
    return request.platformAdmin!;
  },
);

/** Réponses privées, jamais mises en cache, jamais indexées. */
@Injectable()
export class PlatformAdminNoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return next.handle();
  }
}
