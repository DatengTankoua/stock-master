import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { normalizeAccountEmail } from '../common/rate-limit/anti-abuse-config';
import {
  MembershipStatus,
  OrganizationStatus,
} from '../organizations/permissions';
import type { MarketingEmailConsentDto } from './dto/marketing-consent.dto';
import {
  MARKETING_CHANNEL,
  MARKETING_EMAIL_CURRENT_WORDING,
  MARKETING_PURPOSE,
  type ResolvedMarketingWording,
  resolveMarketingWording,
  sha256Hex,
} from './marketing-consent-wording';
import {
  MarketingConsent,
  MarketingConsentAction,
  type MarketingConsentDocument,
  MarketingConsentEvent,
  type MarketingConsentEventDocument,
  MarketingConsentSource,
  MarketingConsentWording,
  type MarketingConsentWordingDocument,
} from './schemas/marketing-consent.schema';

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

export const MARKETING_CLOCK = Symbol('MARKETING_CLOCK');
export type MarketingClock = () => Date;

export const MARKETING_CONSENT_WORDING_OUTDATED =
  'MARKETING_CONSENT_WORDING_OUTDATED';
export const MARKETING_CONSENT_WORDING_UNKNOWN =
  'MARKETING_CONSENT_WORDING_UNKNOWN';
export const MARKETING_CONSENT_UNAVAILABLE = 'MARKETING_CONSENT_UNAVAILABLE';

/** Raisons d'inéligibilité à une future campagne par e-mail. */
export type MarketingIneligibility =
  | 'account_missing'
  | 'no_consent'
  | 'address_changed'
  | 'email_unverified'
  | 'no_active_membership';

export interface MarketingEmailEligibility {
  eligible: boolean;
  reasons: MarketingIneligibility[];
}

/** Ce que voit l'utilisateur dans ses réglages. */
export interface MarketingConsentView {
  /** Accord ACTUEL et valable pour l'adresse actuelle du compte. */
  granted: boolean;
  /** Accord donné pour une autre adresse : sans effet, à redonner. */
  grantedForPreviousAddress: boolean;
  changedAt: Date | null;
  emailVerified: boolean;
  /** Libellé à présenter pour un nouvel accord. */
  wordingVersion: string;
}

export function marketingConsentKey(userId: string): string {
  return `${MARKETING_CHANNEL}.${MARKETING_PURPOSE}/${userId}`;
}

export function addressFingerprint(email: string): string {
  return sha256Hex(normalizeAccountEmail(email));
}

function unavailable() {
  return new ServiceUnavailableException({
    code: MARKETING_CONSENT_UNAVAILABLE,
    message: 'Ce choix ne peut pas être enregistré pour le moment.',
  });
}

/**
 * Accord INDIVIDUEL aux e-mails promotionnels de Stock Master.
 *
 * - Appartient au compte : seule la session de l'utilisateur (inscription,
 *   puis réglages) le modifie ; aucune route d'organisation ni
 *   d'administration de la plateforme ne l'écrit.
 * - Absent = refus : aucun accord n'est déduit d'un compte existant, d'une
 *   invitation, d'un champ absent, des conditions acceptées, de
 *   l'autorisation push ou des préférences de notifications.
 * - Chaque changement effectif ajoute une preuve immuable et met à jour
 *   l'état courant dans UNE transaction ; un choix identique à l'état
 *   courant (rejeu, double clic) n'écrit rien.
 * - Retrait immédiat : l'éligibilité relit l'état courant à chaque appel.
 *
 * Ne déclenche aucun envoi : il n'existe ni campagne, ni expéditeur
 * marketing dans ce lot.
 */
@Injectable()
export class MarketingConsentService {
  constructor(
    @InjectModel(MarketingConsent.name)
    private readonly consentModel: Model<MarketingConsentDocument>,
    @InjectModel(MarketingConsentEvent.name)
    private readonly eventModel: Model<MarketingConsentEventDocument>,
    @InjectModel(MarketingConsentWording.name)
    private readonly wordingModel: Model<MarketingConsentWordingDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(MARKETING_CLOCK) private readonly clock: MarketingClock,
  ) {}

  /**
   * Contrôle AVANT toute écriture. Un accord exige le libellé en vigueur
   * (sinon 409 : la page affichait un ancien texte) ; un retrait accepte
   * toute version publiée, pour rester toujours possible.
   */
  resolveChoice(input: MarketingEmailConsentDto): ResolvedMarketingWording {
    if (
      input.granted &&
      input.wordingVersion !== MARKETING_EMAIL_CURRENT_WORDING
    ) {
      throw new ConflictException({
        code: MARKETING_CONSENT_WORDING_OUTDATED,
        message: 'Le texte proposé a changé : recharge la page.',
        current: MARKETING_EMAIL_CURRENT_WORDING,
      });
    }
    let wording: ResolvedMarketingWording | null;
    try {
      wording = resolveMarketingWording(input.wordingVersion, input.locale);
    } catch {
      throw unavailable();
    }
    if (!wording) {
      throw new BadRequestException({
        code: MARKETING_CONSENT_WORDING_UNKNOWN,
        message: 'Texte inconnu.',
      });
    }
    return wording;
  }

  /**
   * Inscription : enregistre l'accord dans la transaction de création du
   * compte. Case non cochée ou absente : rien n'est écrit (absence = refus).
   */
  async recordRegistration(
    session: MongooseSession,
    input: {
      userId: string;
      email: string;
      choice: MarketingEmailConsentDto | undefined;
      wording: ResolvedMarketingWording | null;
    },
  ): Promise<void> {
    if (!input.choice?.granted || !input.wording) return;
    await this.apply(session, {
      userId: input.userId,
      email: input.email,
      granted: true,
      wording: input.wording,
      source: MarketingConsentSource.REGISTRATION,
      previous: null,
    });
  }

  /** État affiché dans les réglages du compte connecté. */
  async view(userId: string): Promise<MarketingConsentView> {
    const user = await this.user(userId);
    if (!user) throw new NotFoundException();
    const state = await this.consentModel
      .findById(marketingConsentKey(userId))
      .lean()
      .exec();
    const sameAddress =
      !!state && state.addressSha256 === addressFingerprint(user.email);
    return {
      granted: !!state?.granted && sameAddress,
      grantedForPreviousAddress: !!state?.granted && !sameAddress,
      changedAt: state?.changedAt ?? null,
      emailVerified: !!user.emailVerifiedAt,
      wordingVersion: MARKETING_EMAIL_CURRENT_WORDING,
    };
  }

  /**
   * Choix depuis les réglages (session de l'utilisateur, aucun mot de passe
   * ni MFA). Idempotent : un état déjà conforme n'ajoute aucune preuve. Les
   * rejeux concurrents entrent en conflit d'écriture : la transaction
   * rejouée relit l'état et n'écrit plus rien.
   */
  async update(
    userId: string,
    input: MarketingEmailConsentDto,
  ): Promise<MarketingConsentView> {
    const wording = this.resolveChoice(input);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await this.user(userId, session);
        if (!user) throw new NotFoundException();
        const previous = await this.consentModel
          .findById(marketingConsentKey(userId))
          .session(session)
          .lean()
          .exec();
        await this.apply(session, {
          userId,
          email: user.email,
          granted: input.granted,
          wording,
          source: MarketingConsentSource.SETTINGS,
          previous,
        });
      });
    } finally {
      await session.endSession();
    }
    return this.view(userId);
  }

  /**
   * Lecture CENTRALE de l'éligibilité à une future campagne par e-mail, à
   * appeler juste avant CHAQUE envoi : accord actuel pour l'adresse
   * actuelle, adresse vérifiée, compte encore rattaché à un commerce actif
   * (règle de connexion existante). Aucun cache.
   */
  async emailEligibility(userId: string): Promise<MarketingEmailEligibility> {
    const user = await this.user(userId);
    if (!user) return { eligible: false, reasons: ['account_missing'] };
    const reasons: MarketingIneligibility[] = [];
    const state = await this.consentModel
      .findById(marketingConsentKey(userId))
      .lean()
      .exec();
    if (!state?.granted) reasons.push('no_consent');
    else if (state.addressSha256 !== addressFingerprint(user.email)) {
      reasons.push('address_changed');
    }
    if (!user.emailVerifiedAt) reasons.push('email_unverified');
    if (!(await this.hasActiveMembership(user._id))) {
      reasons.push('no_active_membership');
    }
    return { eligible: reasons.length === 0, reasons };
  }

  private async apply(
    session: MongooseSession,
    input: {
      userId: string;
      email: string;
      granted: boolean;
      wording: ResolvedMarketingWording;
      source: MarketingConsentSource;
      previous: MarketingConsent | null;
    },
  ): Promise<void> {
    const address = addressFingerprint(input.email);
    const { previous } = input;
    const unchanged = input.granted
      ? !!previous?.granted &&
        previous.addressSha256 === address &&
        previous.wordingVersion === input.wording.version
      : !previous?.granted;
    if (unchanged) return;

    const now = this.clock();
    const wordingId = await this.archiveWording(session, input.wording, now);
    const [event] = await this.eventModel.create(
      [
        {
          userId: new Types.ObjectId(input.userId),
          channel: MARKETING_CHANNEL,
          purpose: MARKETING_PURPOSE,
          action: input.granted
            ? MarketingConsentAction.GRANTED
            : MarketingConsentAction.WITHDRAWN,
          at: now,
          source: input.source,
          wordingVersion: input.wording.version,
          locale: input.wording.locale,
          wordingId,
          addressSha256: address,
        },
      ],
      { session },
    );
    await this.consentModel.collection.updateOne(
      { _id: marketingConsentKey(input.userId) as never },
      {
        $set: {
          userId: new Types.ObjectId(input.userId),
          channel: MARKETING_CHANNEL,
          purpose: MARKETING_PURPOSE,
          granted: input.granted,
          addressSha256: address,
          wordingVersion: input.wording.version,
          source: input.source,
          changedAt: now,
          lastEventId: event._id,
        },
      },
      { upsert: true, session },
    );
  }

  /** Archive le libellé présenté (`$setOnInsert`, jamais réécrit). */
  private async archiveWording(
    session: MongooseSession,
    wording: ResolvedMarketingWording,
    now: Date,
  ): Promise<string> {
    const collection = this.wordingModel.collection;
    await collection.updateOne(
      { _id: wording.id as never },
      {
        $setOnInsert: {
          version: wording.version,
          locale: wording.locale,
          text: wording.text,
          sha256: wording.sha256,
          publishedAt: wording.publishedAt,
          archivedAt: now,
        },
      },
      { upsert: true, session },
    );
    const stored = await collection.findOne(
      { _id: wording.id as never },
      { session },
    );
    if (
      !stored ||
      stored.sha256 !== wording.sha256 ||
      typeof stored.text !== 'string' ||
      sha256Hex(stored.text) !== wording.sha256
    ) {
      throw unavailable();
    }
    return wording.id;
  }

  private async user(userId: string, session?: MongooseSession) {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.connection
      .collection<{
        _id: Types.ObjectId;
        email: string;
        emailVerifiedAt?: Date | null;
      }>('users')
      .findOne(
        { _id: new Types.ObjectId(userId) },
        { projection: { email: 1, emailVerifiedAt: 1 }, session },
      );
  }

  private async hasActiveMembership(userId: Types.ObjectId): Promise<boolean> {
    const memberships = await this.connection
      .collection('organizationmemberships')
      .find(
        { userId, status: MembershipStatus.ACTIVE },
        { projection: { organizationId: 1 } },
      )
      .toArray();
    if (memberships.length === 0) return false;
    const active = await this.connection
      .collection('organizations')
      .countDocuments({
        _id: {
          $in: memberships.map((m) => m.organizationId as Types.ObjectId),
        },
        status: OrganizationStatus.ACTIVE,
      });
    return active > 0;
  }
}
