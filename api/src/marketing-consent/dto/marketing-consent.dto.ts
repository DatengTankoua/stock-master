import { IsBoolean, IsIn, IsString, Matches } from 'class-validator';
import {
  MARKETING_LOCALES,
  type MarketingLocale,
} from '../marketing-consent-wording';

/**
 * Choix explicite de l'utilisateur pour les e-mails promotionnels, avec le
 * libellé AFFICHÉ (version, langue). Aucun utilisateur, date, adresse ni
 * source n'est accepté (`forbidNonWhitelisted` global) : le serveur les
 * détermine. Un booléen strict : `"true"`, `1` ou `null` sont refusés (400).
 */
export class MarketingEmailConsentDto {
  @IsBoolean()
  granted: boolean;

  @IsString()
  @Matches(/^\d{1,3}$/)
  wordingVersion: string;

  @IsIn(MARKETING_LOCALES)
  locale: MarketingLocale;
}
