import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { OrganizationCurrency, OrganizationStatus } from '../permissions';
import { ORGANIZATION_NAME_MAX_LENGTH } from '../../common/validation/name-rules';

export type OrganizationDocument = HydratedDocument<Organization>;

@Schema({ timestamps: true })
export class Organization {
  /**
   * Nom affiché (identité de l'organisation). Non vide après trim, 20
   * caractères max (1-12D ; 60 en 1-12C, ex-100). Aucune migration : un nom historique plus
   * long reste lisible, et les sauvegardes de branding ne revalident que les
   * chemins MODIFIÉS (`validateModifiedOnly`), jamais ce nom s'il est
   * inchangé.
   */
  @Prop({
    required: true,
    trim: true,
    minLength: 1,
    maxlength: ORGANIZATION_NAME_MAX_LENGTH,
  })
  name: string;

  /**
   * Identifiant stable de l'organisation. Format recommandé : lettres
   * minuscules, chiffres et tirets (`/^[0-9a-z-]+$/`). Index unique global
   * déclaré UNIQUEMENT ici, par `unique: true` (mongoose crée l'index) —
   * il ne faut pas le déclarer une seconde fois via `schema.index`.
   */
  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    minlength: 1,
    maxlength: 80,
    match: /^[0-9a-z-]+$/,
    unique: true,
  })
  slug: string;

  /** Clé de stockage du logo (aucune URL stockée ici) ; null = logo par défaut. */
  @Prop({ type: String, default: null })
  logoKey: string | null;

  /**
   * Identité du stockage qui a reçu `logoKey` (`S3Service.storage`).
   * `null` sur un logo antérieur : stockage inconnu, jamais lu ni supprimé
   * dans le stockage courant.
   */
  @Prop({ type: String, default: null })
  logoStorage: string | null;

  /**
   * Couleur d'accent `#RRGGBB` ; une seule couleur (décision D7).
   * Défaut `#FF6A00` (1-8A, palette Stock Master) — l'ancien défaut
   * RoyalVibe `#b8960c` n'est PAS migré (aucune organisation en production).
   */
  @Prop({ type: String, default: '#FF6A00', match: /^#[0-9a-fA-F]{6}$/ })
  brandColor: string;

  /** Devise de l'organisation ; défaut `XAF` (jamais `XOF`). */
  @Prop({
    type: String,
    enum: OrganizationCurrency,
    default: OrganizationCurrency.XAF,
  })
  currency: OrganizationCurrency;

  /** `active | suspended` ; org suspendue refusée par le contexte (1-3A). */
  @Prop({
    type: String,
    enum: OrganizationStatus,
    default: OrganizationStatus.ACTIVE,
  })
  status: OrganizationStatus;

  /**
   * 1-21D — jeton TECHNIQUE de sérialisation des créations de fiches
   * produit : incrémenté dans la transaction de création, avant le
   * décompte, pour que deux créations simultanées entrent en conflit
   * d'écriture (l'une est rejouée et recompte). Ce n'est PAS un compteur de
   * fiches (le décompte reste celui des documents `products`) : aucune
   * initialisation ni migration. Absent par défaut, jamais lu ni exposé.
   */
  @Prop({ type: Number, required: false, select: false })
  productCreationSerial?: number;

  /**
   * Lot C — délai d'anticipation des alertes de péremption, en jours
   * (entier 0 à 365 ; 0 : alerte le jour de l'échéance, jamais une
   * désactivation). Absent : 30 jours.
   */
  @Prop({ type: Number, required: false, min: 0, max: 365 })
  expiryAlertLeadDays?: number;
}

export const OrganizationSchema = SchemaFactory.createForClass(Organization);
