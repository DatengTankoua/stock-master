import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MARKETING_EMAIL_CURRENT_WORDING,
  MARKETING_EMAIL_WORDINGS,
  resolveMarketingWording,
  sha256Hex,
} from './marketing-consent-wording';
import { describeMarketingConsentIndexProblem } from './marketing-consent-indexes';
import {
  addressFingerprint,
  marketingConsentKey,
} from './marketing-consent.service';

const WEB = join(__dirname, '..', '..', '..', 'web', 'src');

describe('Libellés versionnés de l’accord marketing', () => {
  it('version 1 figée : texte exact et empreinte', () => {
    expect(MARKETING_EMAIL_WORDINGS['1'].texts.fr.text).toBe(
      'Je souhaite recevoir par e-mail les offres et promotions de Stock Master. Je peux me désinscrire à tout moment.',
    );
    for (const version of Object.values(MARKETING_EMAIL_WORDINGS)) {
      for (const { text, sha256 } of Object.values(version.texts)) {
        expect(sha256Hex(text)).toBe(sha256);
      }
    }
  });

  it('le web affiche exactement le libellé en vigueur, avec la même version', () => {
    const current = MARKETING_EMAIL_WORDINGS[MARKETING_EMAIL_CURRENT_WORDING];
    for (const locale of ['fr', 'en'] as const) {
      const resource = readFileSync(
        join(WEB, 'i18n', 'resources', locale, 'legal.ts'),
        'utf8',
      );
      expect(resource).toContain(JSON.stringify(current.texts[locale].text));
    }
    const lib = readFileSync(join(WEB, 'lib', 'marketing-consent.ts'), 'utf8');
    expect(lib).toContain(
      `MARKETING_EMAIL_WORDING_VERSION = "${MARKETING_EMAIL_CURRENT_WORDING}"`,
    );
  });

  it('résolution : version et langue connues seulement', () => {
    expect(resolveMarketingWording('1', 'en')).toMatchObject({
      id: 'email.promotions@1/en',
      version: '1',
      locale: 'en',
    });
    expect(resolveMarketingWording('2', 'fr')).toBeNull();
    expect(resolveMarketingWording('constructor', 'fr')).toBeNull();
  });

  it('clé d’état par utilisateur et empreinte d’adresse normalisée', () => {
    expect(marketingConsentKey('a'.repeat(24))).toBe(
      `email.promotions/${'a'.repeat(24)}`,
    );
    expect(addressFingerprint('  Boss@Shop.TEST ')).toBe(
      sha256Hex('boss@shop.test'),
    );
  });

  it('index : seul l’index exact est accepté', () => {
    const ok = { name: 'userId_1_at_-1', key: { userId: 1, at: -1 } };
    expect(describeMarketingConsentIndexProblem([ok])).toBeNull();
    expect(describeMarketingConsentIndexProblem([])).toBe(
      'index userId absent',
    );
    expect(
      describeMarketingConsentIndexProblem([{ ...ok, key: { userId: 1 } }]),
    ).toBe('clé inattendue');
    expect(
      describeMarketingConsentIndexProblem([{ ...ok, expireAfterSeconds: 60 }]),
    ).toBe('options inattendues');
  });
});
