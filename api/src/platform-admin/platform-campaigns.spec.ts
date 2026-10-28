import { randomBytes } from 'crypto';
import {
  UNSUBSCRIBE_TOKEN_PATTERN,
  deriveUnsubscribeToken,
  parseUnsubscribeSecret,
  unsubscribeLinks,
  unsubscribeTokenHash,
} from '../marketing-consent/marketing-unsubscribe';
import { areValidHeaders } from '../email-verification/resend-email-sender';
import { buildCampaignEmail } from './platform-campaign-email';
import {
  campaignEmailIdempotencyKey,
  campaignSendConfig,
  isMarketingEmailsEnabled,
} from './platform-campaign-policy';
import {
  actionContentHash,
  normalizeIntent,
} from './platform-admin-action-intent';

const secret = () => randomBytes(32).toString('base64url');

describe('Campagnes — jeton de désabonnement', () => {
  it('secret : 32 octets au moins, sinon refus', () => {
    expect(parseUnsubscribeSecret(undefined)).toBeNull();
    expect(parseUnsubscribeSecret('court')).toBeNull();
    expect(
      parseUnsubscribeSecret(randomBytes(16).toString('base64')),
    ).toBeNull();
    expect(parseUnsubscribeSecret(secret())?.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('dérivé, stable pour une reprise, propre à la livraison et à l’adresse', () => {
    const key = parseUnsubscribeSecret(secret())!;
    const a = deriveUnsubscribeToken(key, 'd1', 'addr1');
    expect(a).toMatch(UNSUBSCRIBE_TOKEN_PATTERN);
    expect(deriveUnsubscribeToken(key, 'd1', 'addr1')).toBe(a);
    expect(deriveUnsubscribeToken(key, 'd2', 'addr1')).not.toBe(a);
    expect(deriveUnsubscribeToken(key, 'd1', 'addr2')).not.toBe(a);
    const other = parseUnsubscribeSecret(secret())!;
    expect(deriveUnsubscribeToken(other, 'd1', 'addr1')).not.toBe(a);
    expect(unsubscribeTokenHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(unsubscribeTokenHash(a)).not.toContain(a);
  });

  it('liens : page de confirmation et POST en un clic, sans identifiant ni adresse', () => {
    const links = unsubscribeLinks('https://app.test', 'TOKEN');
    expect(links).toEqual({
      page: 'https://app.test/auth/unsubscribe?token=TOKEN',
      oneClick: 'https://app.test/api/unsubscribe?token=TOKEN',
    });
  });
});

describe('Campagnes — e-mail et envoi', () => {
  const input = {
    subject: 'Promo\r\n<b>x</b>',
    body: 'Bonjour <script>alert(1)</script>\nà bientôt',
    locale: 'fr' as const,
    unsubscribeUrl: 'https://app.test/auth/unsubscribe?token=a&b',
  };

  it('fonction pure : mêmes entrées, même e-mail', () => {
    expect(buildCampaignEmail(input)).toEqual(buildCampaignEmail(input));
  });

  it('texte simple échappé, sujet sur une ligne, lien visible', () => {
    const email = buildCampaignEmail(input);
    expect(email.subject).toBe('Promo <b>x</b>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain(
      'href="https://app.test/auth/unsubscribe?token=a&amp;b"',
    );
    expect(email.text).toContain(input.unsubscribeUrl);
    expect(buildCampaignEmail({ ...input, locale: 'en' }).text).toContain(
      'To unsubscribe:',
    );
  });

  it('clé d’idempotence liée à la campagne, à la livraison et à l’adresse', () => {
    const k = campaignEmailIdempotencyKey('c', 'd', 'a'.repeat(64));
    expect(k).toBe(`marketing-campaign/c/d/${'a'.repeat(32)}`);
    expect(campaignEmailIdempotencyKey('c', 'd', 'b'.repeat(64))).not.toBe(k);
    expect(k.length).toBeLessThanOrEqual(256);
  });

  it('interrupteur : désactivé sauf valeur exacte « true »', () => {
    expect(isMarketingEmailsEnabled({})).toBe(false);
    expect(isMarketingEmailsEnabled({ MARKETING_EMAILS_ENABLED: '1' })).toBe(
      false,
    );
    expect(isMarketingEmailsEnabled({ MARKETING_EMAILS_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('configuration : origine publique et secret exigés', () => {
    expect(campaignSendConfig({})).toBeNull();
    expect(
      campaignSendConfig({ PUBLIC_APP_URL: 'https://app.test' }),
    ).toBeNull();
    expect(
      campaignSendConfig({
        PUBLIC_APP_URL: 'https://app.test',
        MARKETING_UNSUBSCRIBE_SECRET: secret(),
      })?.appOrigin,
    ).toBe('https://app.test');
  });

  it('en-têtes : noms simples, aucune valeur multiligne', () => {
    expect(areValidHeaders(undefined)).toBe(true);
    expect(
      areValidHeaders({
        'List-Unsubscribe': '<https://app.test/api/unsubscribe?token=x>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }),
    ).toBe(true);
    expect(areValidHeaders({ 'X-Test': 'a\r\nBcc: x@y.z' })).toBe(false);
    expect(areValidHeaders({ 'Bad Name': 'x' })).toBe(false);
  });
});

describe('Campagnes — intention de lancement', () => {
  const raw = {
    action: 'campaign_launch',
    campaignId: 'a'.repeat(24),
    operationId: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    subject: '  Offre ',
    body: 'Texte\r\nsuite',
    targeting: {
      mode: 'selected',
      organizationIds: ['c'.repeat(24), 'b'.repeat(24), 'b'.repeat(24)],
    },
  };

  it('forme canonique : commerces triés et dédupliqués, texte normalisé', () => {
    expect(normalizeIntent(raw)).toEqual({
      ...raw,
      subject: 'Offre',
      body: 'Texte\nsuite',
      targeting: {
        mode: 'selected',
        organizationIds: ['b'.repeat(24), 'c'.repeat(24)],
      },
    });
  });

  it('toute modification change l’empreinte liée', () => {
    const base = actionContentHash(normalizeIntent(raw));
    for (const change of [
      { revision: 3 },
      { subject: 'Autre' },
      { body: 'Autre' },
      { targeting: { mode: 'all' } },
    ]) {
      expect(
        actionContentHash(normalizeIntent({ ...raw, ...change })),
      ).not.toBe(base);
    }
  });

  it('refus : ciblage inconnu, champs en trop, sujet multiligne', () => {
    for (const bad of [
      { targeting: { mode: 'emails', addresses: ['x@y.z'] } },
      { targeting: { mode: 'all', extra: 1 } },
      { subject: 'a\nb' },
      { revision: 0 },
    ]) {
      expect(() => normalizeIntent({ ...raw, ...bad })).toThrow();
    }
  });
});
