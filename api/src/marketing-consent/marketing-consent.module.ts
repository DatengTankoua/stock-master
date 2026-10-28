import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MarketingConsentController } from './marketing-consent.controller';
import { MarketingUnsubscribeController } from './marketing-unsubscribe.controller';
import {
  MARKETING_CLOCK,
  MarketingConsentService,
  type MarketingClock,
} from './marketing-consent.service';
import {
  MarketingConsent,
  MarketingConsentEvent,
  MarketingConsentEventSchema,
  MarketingConsentSchema,
  MarketingConsentWording,
  MarketingConsentWordingSchema,
} from './schemas/marketing-consent.schema';

const systemClock: MarketingClock = () => new Date();

/**
 * Accord individuel aux e-mails promotionnels. Module feuille (comme
 * `LegalModule`) : importé par `AuthModule` pour enregistrer l'accord dans
 * la transaction d'inscription. Horloge remplacée UNIQUEMENT par les tests.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MarketingConsent.name, schema: MarketingConsentSchema },
      { name: MarketingConsentEvent.name, schema: MarketingConsentEventSchema },
      {
        name: MarketingConsentWording.name,
        schema: MarketingConsentWordingSchema,
      },
    ]),
  ],
  controllers: [MarketingConsentController, MarketingUnsubscribeController],
  providers: [
    MarketingConsentService,
    { provide: MARKETING_CLOCK, useValue: systemClock },
  ],
  exports: [MarketingConsentService],
})
export class MarketingConsentModule {}
