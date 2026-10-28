import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { forbidMutations } from '../../legal/schemas/legal-acceptance.schema';
import { MARKETING_LOCALES } from '../marketing-consent-wording';

export const MARKETING_CONSENTS_COLLECTION = 'marketing_consents';
export const MARKETING_CONSENT_EVENTS_COLLECTION = 'marketing_consent_events';
export const MARKETING_CONSENT_WORDINGS_COLLECTION =
  'marketing_consent_wordings';

export enum MarketingConsentAction {
  GRANTED = 'granted',
  WITHDRAWN = 'withdrawn',
}

export enum MarketingConsentSource {
  /** Case facultative du formulaire d'inscription. */
  REGISTRATION = 'registration',
  /** Réglages personnels du compte connecté. */
  SETTINGS = 'settings',
}

/**
 * État COURANT de l'accord d'UN utilisateur pour un canal et une finalité.
 * `_id` = `<channel>.<purpose>/<userId>` : un seul état par utilisateur,
 * unicité par l'index `_id` natif. Absent = aucun accord (comptes
 * existants, invitations, champ absent : jamais d'accord implicite).
 *
 * `addressSha256` : empreinte de l'adresse du compte AU MOMENT de l'accord.
 * Un accord ne vaut que pour cette adresse : une autre adresse exige un
 * nouvel accord (voir `MarketingConsentService.emailEligibility`).
 */
@Schema({
  collection: MARKETING_CONSENTS_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class MarketingConsent {
  @Prop({ type: String, required: true }) _id: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true }) channel: string;
  @Prop({ type: String, required: true }) purpose: string;
  @Prop({ type: Boolean, required: true }) granted: boolean;
  @Prop({ type: String, default: null }) addressSha256: string | null;
  @Prop({ type: String, required: true }) wordingVersion: string;

  @Prop({
    type: String,
    enum: Object.values(MarketingConsentSource),
    required: true,
  })
  source: MarketingConsentSource;

  /** Date SERVEUR du dernier changement. */
  @Prop({ type: Date, required: true }) changedAt: Date;
  /** Dernière preuve (`marketing_consent_events`). */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  lastEventId: Types.ObjectId;
}

export type MarketingConsentDocument = HydratedDocument<MarketingConsent>;
export const MarketingConsentSchema =
  SchemaFactory.createForClass(MarketingConsent);

/**
 * Preuve minimale d'UN choix (accord ou retrait), IMMUABLE côté
 * application : utilisateur, canal, finalité, action, date serveur, source,
 * version et langue du libellé présenté, empreinte de l'adresse concernée.
 * Ni adresse IP, ni agent utilisateur, ni texte libre.
 */
@Schema({
  collection: MARKETING_CONSENT_EVENTS_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class MarketingConsentEvent {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true }) channel: string;
  @Prop({ type: String, required: true }) purpose: string;

  @Prop({
    type: String,
    enum: Object.values(MarketingConsentAction),
    required: true,
  })
  action: MarketingConsentAction;

  @Prop({ type: Date, required: true }) at: Date;

  @Prop({
    type: String,
    enum: Object.values(MarketingConsentSource),
    required: true,
  })
  source: MarketingConsentSource;

  @Prop({ type: String, required: true }) wordingVersion: string;
  @Prop({ type: String, enum: MARKETING_LOCALES, required: true })
  locale: string;
  /** `_id` du libellé archivé dans `marketing_consent_wordings`. */
  @Prop({ type: String, required: true }) wordingId: string;
  @Prop({ type: String, required: true }) addressSha256: string;
}

export type MarketingConsentEventDocument =
  HydratedDocument<MarketingConsentEvent>;
export const MarketingConsentEventSchema = SchemaFactory.createForClass(
  MarketingConsentEvent,
);
forbidMutations(
  MarketingConsentEventSchema,
  MARKETING_CONSENT_EVENTS_COLLECTION,
);

/** Libellé présenté, archivé à sa première utilisation, jamais réécrit. */
@Schema({
  collection: MARKETING_CONSENT_WORDINGS_COLLECTION,
  autoIndex: false,
  versionKey: false,
})
export class MarketingConsentWording {
  @Prop({ type: String, required: true }) _id: string;
  @Prop({ type: String, required: true }) version: string;
  @Prop({ type: String, required: true }) locale: string;
  @Prop({ type: String, required: true }) text: string;
  @Prop({ type: String, required: true }) sha256: string;
  @Prop({ type: String, required: true }) publishedAt: string;
  @Prop({ type: Date, required: true }) archivedAt: Date;
}

export type MarketingConsentWordingDocument =
  HydratedDocument<MarketingConsentWording>;
export const MarketingConsentWordingSchema = SchemaFactory.createForClass(
  MarketingConsentWording,
);
forbidMutations(
  MarketingConsentWordingSchema,
  MARKETING_CONSENT_WORDINGS_COLLECTION,
);
