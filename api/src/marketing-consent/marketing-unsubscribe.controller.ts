import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { MarketingConsentService } from './marketing-consent.service';

export class MarketingUnsubscribeDto {
  @IsString()
  @MaxLength(64)
  token: string;
}

/**
 * Désabonnement des e-mails promotionnels SANS connexion : possible même
 * quand le compte ne peut plus se connecter. POST uniquement (un GET, comme
 * celui d'un analyseur de liens, ne retire jamais rien) ; jeton dans le
 * CORPS (jamais dans l'URL de l'API, donc jamais dans ses journaux).
 *
 * Appelé par la page publique (bouton de confirmation) et par la route web
 * du POST en un clic (RFC 8058), qui relaie le jeton sans cookie ni session.
 * Aucune protection CSRF propre aux routes authentifiées : seul le jeton
 * fait foi. Réponse sans donnée personnelle, jamais mise en cache.
 */
@Public()
@Controller('marketing')
export class MarketingUnsubscribeController {
  constructor(private readonly consent: MarketingConsentService) {}

  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Post('unsubscribe')
  unsubscribe(@Body() dto: MarketingUnsubscribeDto) {
    return this.consent.withdrawByUnsubscribeToken(dto.token);
  }
}
