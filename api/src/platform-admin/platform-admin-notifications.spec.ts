import { Types } from 'mongoose';
import { PLATFORM_CAPABILITIES } from './platform-admin-capabilities';
import {
  CAMPAIGN_COMPLETION_GRACE_MS,
  CATEGORY_CAPABILITY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  TYPE_CATEGORY,
  campaignAudienceIsPartial,
  campaignIsCompleted,
  notificationKeys,
  organizationNameParam,
  paymentIsConfirmed,
  paymentNeedsIntervention,
  toNotificationView,
  visibleCategories,
  type CampaignDeliveryCounts,
  type CampaignState,
  type PlatformAdminNotificationDoc,
} from './platform-admin-notifications';
import {
  PLATFORM_ADMIN_NOTIFICATION_INDEXES,
  PLATFORM_ADMIN_NOTIFICATION_SOURCE_INDEXES,
} from './platform-admin-notification-indexes';
import { PLATFORM_ADMIN_INDEXES } from './platform-admin-indexes';

const zero: CampaignDeliveryCounts = {
  pending: 0,
  sending: 0,
  accepted: 0,
  skipped: 0,
  failed: 0,
  uncertain: 0,
};

const NOW = new Date('2026-10-29T12:00:00Z');
const frozen = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const campaign = (
  audience: Partial<CampaignState['audience']>,
  status: CampaignState['status'] = 'launched',
): CampaignState => ({
  status,
  audience: { status: 'ready', total: 3, ...audience },
});

describe('Notifications de l’administration — droits', () => {
  it('chaque type a une catégorie, chaque catégorie une capacité de CONSULTATION', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_CATEGORIES).toContain(TYPE_CATEGORY[type]);
    }
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(PLATFORM_CAPABILITIES).toContain(CATEGORY_CAPABILITY[category]);
      // Jamais une capacité d'action (envoyer, suspendre, lancer…).
      expect(CATEGORY_CAPABILITY[category]).toBe('platform.read');
    }
  });

  it('les catégories visibles suivent les capacités relues', () => {
    expect(visibleCategories(undefined)).toEqual([]);
    expect(visibleCategories(new Set())).toEqual([]);
    expect(
      visibleCategories(new Set(['platform.campaigns.send'] as const)),
    ).toEqual([]);
    expect(visibleCategories(new Set(['platform.read'] as const))).toEqual([
      ...NOTIFICATION_CATEGORIES,
    ]);
  });
});

describe('Notifications de l’administration — paiements', () => {
  it('confirmé : succeeded avec période et date de confirmation seulement', () => {
    const periodId = new Types.ObjectId();
    expect(
      paymentIsConfirmed({ status: 'succeeded', periodId, confirmedAt: NOW }),
    ).toBe(true);
    expect(
      paymentIsConfirmed({
        status: 'succeeded',
        periodId: null,
        confirmedAt: NOW,
      }),
    ).toBe(false);
    expect(paymentIsConfirmed({ status: 'succeeded', periodId })).toBe(false);
    for (const status of ['pending', 'uncertain', 'review', 'failed']) {
      expect(paymentIsConfirmed({ status, periodId, confirmedAt: NOW })).toBe(
        false,
      );
    }
  });

  it('intervention : review non remboursé uniquement (jamais attente ni refus)', () => {
    expect(
      paymentNeedsIntervention({ status: 'review', refundedAt: null }),
    ).toBe(true);
    expect(
      paymentNeedsIntervention({ status: 'review', refundedAt: NOW }),
    ).toBe(false);
    for (const status of [
      'initiating',
      'pending',
      'uncertain',
      'failed',
      'succeeded',
    ]) {
      expect(paymentNeedsIntervention({ status, refundedAt: null })).toBe(
        false,
      );
    }
  });

  it('clés stables : un incident donné une seule fois par paiement', () => {
    expect(notificationKeys.paymentConfirmed('p1')).toBe(
      'payment_confirmed:p1',
    );
    expect(notificationKeys.paymentReview('p1', 'provider_mismatch')).toBe(
      notificationKeys.paymentReview('p1', 'provider_mismatch'),
    );
    expect(notificationKeys.paymentReview('p1', 'provider_mismatch')).not.toBe(
      notificationKeys.paymentReview('p1', 'renewal_already_granted'),
    );
    expect(notificationKeys.paymentReview('p1', null)).toBe(
      'payment_review:p1:none',
    );
  });
});

describe('Notifications de l’administration — campagnes', () => {
  const grace = CAMPAIGN_COMPLETION_GRACE_MS;

  it('rien pendant la constitution de l’audience', () => {
    const preparing = campaign({ status: 'preparing', frozenAt: null });
    expect(campaignIsCompleted(preparing, zero, NOW)).toBe(false);
    expect(campaignAudienceIsPartial(preparing)).toBe(false);
  });

  it('rien tant qu’une livraison reste à traiter (interrupteur coupé compris)', () => {
    const ready = campaign({ frozenAt: frozen(grace + 1) });
    expect(campaignIsCompleted(ready, { ...zero, pending: 1 }, NOW)).toBe(
      false,
    );
    expect(campaignIsCompleted(ready, { ...zero, sending: 1 }, NOW)).toBe(
      false,
    );
  });

  it('rien pendant le délai de grâce qui suit le gel', () => {
    const ready = campaign({ frozenAt: frozen(grace - 1) });
    expect(campaignIsCompleted(ready, { ...zero, accepted: 3 }, NOW)).toBe(
      false,
    );
  });

  it('fin : audience gelée et toutes les livraisons dans un état final', () => {
    const ready = campaign({ frozenAt: frozen(grace) });
    expect(
      campaignIsCompleted(
        ready,
        { ...zero, accepted: 1, skipped: 1, failed: 0, uncertain: 1 },
        NOW,
      ),
    ).toBe(true);
    // Audience vide : traitement terminé aussitôt le délai passé.
    expect(
      campaignIsCompleted(
        campaign({ total: 0, frozenAt: frozen(grace) }),
        zero,
        NOW,
      ),
    ).toBe(true);
    expect(
      campaignIsCompleted(
        campaign({ frozenAt: frozen(grace) }, 'draft'),
        zero,
        NOW,
      ),
    ).toBe(false);
  });

  it('audience partielle : close ET incomplète seulement', () => {
    expect(campaignAudienceIsPartial(campaign({ incomplete: true }))).toBe(
      true,
    );
    expect(campaignAudienceIsPartial(campaign({ incomplete: false }))).toBe(
      false,
    );
    expect(
      campaignAudienceIsPartial(
        campaign({ status: 'preparing', incomplete: true }),
      ),
    ).toBe(false);
  });

  it('déduplication par campagne et par événement', () => {
    expect(notificationKeys.campaignCompleted('c1')).not.toBe(
      notificationKeys.campaignAudiencePartial('c1'),
    );
    expect(notificationKeys.campaignCompleted('c1')).not.toBe(
      notificationKeys.campaignCompleted('c2'),
    );
  });
});

describe('Notifications de l’administration — réponse', () => {
  const doc = (
    params: Record<string, unknown>,
  ): PlatformAdminNotificationDoc => ({
    _id: new Types.ObjectId(),
    eventKey: 'support_request:x',
    type: 'support_request',
    category: 'support',
    occurredAt: NOW,
    createdAt: NOW,
    target: { kind: 'organization', id: 'o', organizationId: 'o' },
    params,
  });

  it('seuls les paramètres de la liste blanche sortent (jamais de contenu)', () => {
    const view = toNotificationView(
      doc({
        organizationName: 'Boutique',
        reference: 'AS-12345678',
        supportCategory: 'technical',
        subject: 'sujet secret',
        message: 'corps de la demande',
        userEmail: 'client@example.test',
        token: 'abc',
      }),
      null,
      true,
    );
    expect(view.params).toEqual({
      organizationName: 'Boutique',
      reference: 'AS-12345678',
      supportCategory: 'technical',
    });
    const serialized = JSON.stringify(view);
    for (const secret of ['sujet secret', 'corps', 'client@', 'abc"']) {
      expect(serialized).not.toContain(secret);
    }
    expect(view).not.toHaveProperty('eventKey');
  });

  it('cible disparue : signalée, résumé minimal conservé', () => {
    const view = toNotificationView(doc({ organizationName: 'X' }), NOW, false);
    expect(view.target.available).toBe(false);
    expect(view.read).toBe(true);
    expect(view.params.organizationName).toBe('X');
  });

  it('nom du commerce borné', () => {
    expect(organizationNameParam('a'.repeat(500))).toHaveLength(120);
    expect(organizationNameParam(undefined)).toBeNull();
  });
});

describe('Notifications de l’administration — index', () => {
  it('unicité de l’événement et de l’état de lecture', () => {
    const unique = PLATFORM_ADMIN_NOTIFICATION_INDEXES.filter((i) => i.unique);
    expect(unique.map((i) => Object.keys(i.key))).toEqual([
      ['eventKey'],
      ['userId', 'notificationId'],
    ]);
  });

  it('aucun TTL (conservation à définir), séparés des index de l’espace', () => {
    for (const spec of [
      ...PLATFORM_ADMIN_NOTIFICATION_INDEXES,
      ...PLATFORM_ADMIN_NOTIFICATION_SOURCE_INDEXES,
    ]) {
      expect(spec.expireAfterSeconds).toBeUndefined();
      // Un index manquant ne ferme jamais tout l'espace d'administration.
      expect(
        PLATFORM_ADMIN_INDEXES.some(
          (i) => i.collection === spec.collection && i.name === spec.name,
        ),
      ).toBe(false);
    }
  });
});
