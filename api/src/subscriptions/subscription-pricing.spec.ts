import {
  SUBSCRIPTION_PRICES_XAF,
  SUBSCRIPTION_PRICING_CURRENCY,
  SUBSCRIPTION_PRICING_VERSION,
  SubscriptionPricingError,
  getSubscriptionPrice,
  listSubscriptionPrices,
} from './subscription-pricing';
import { SubscriptionTerm, TERM_MONTHS } from './subscription-terms';
// Parité UNIQUEMENT (test) : le code de production n'importe jamais le web.
// Import du module réel (aucune extraction par regex) : il exécute aussi sa
// propre vérification de cohérence.
import { readFileSync } from 'fs';
import { join } from 'path';
import * as webOffers from '../../../web/src/lib/subscription-offers';

describe('Catalogue tarifaire serveur (1-14D.2A, tarifs 1-21D)', () => {
  it('quatre durées, montants totaux attendus, XAF, version explicite', () => {
    expect(SUBSCRIPTION_PRICING_VERSION).toBe(2);
    expect(SUBSCRIPTION_PRICING_CURRENCY).toBe('XAF');
    expect(
      listSubscriptionPrices().map((p) => [p.term, p.amount, p.months]),
    ).toEqual([
      ['monthly', 3500, 1],
      ['quarterly', 10000, 3],
      ['semiannual', 18500, 6],
      ['annual', 35000, 12],
    ]);
  });

  it('prix d’une durée : montant, devise, version et mois cohérents avec TERM_MONTHS', () => {
    for (const term of Object.values(SubscriptionTerm)) {
      const price = getSubscriptionPrice(term);
      expect(price).toEqual({
        term,
        months: TERM_MONTHS[term],
        amount: SUBSCRIPTION_PRICES_XAF[term],
        currency: 'XAF',
        pricingVersion: SUBSCRIPTION_PRICING_VERSION,
      });
      expect(Number.isSafeInteger(price.amount)).toBe(true);
      expect(price.amount).toBeGreaterThan(0);
    }
  });

  it.each([
    'weekly',
    'MONTHLY',
    ' monthly',
    '',
    null,
    undefined,
    1,
    3000,
    { term: 'monthly' },
    ['monthly'],
    'toString',
    '__proto__',
  ])('durée inconnue %p → refusée', (term) => {
    expect(() => getSubscriptionPrice(term)).toThrow(SubscriptionPricingError);
  });

  it('aucun montant libre : la seule entrée est la durée', () => {
    expect(getSubscriptionPrice.length).toBe(1);
    // Un argument supplémentaire (montant forgé) est sans effet.
    const forged = (getSubscriptionPrice as (...args: unknown[]) => unknown)(
      'monthly',
      1,
    );
    expect(forged).toMatchObject({ amount: 3500 });
  });

  it('valeurs immuables : catalogue, prix renvoyés et liste', () => {
    expect(Object.isFrozen(SUBSCRIPTION_PRICES_XAF)).toBe(true);
    expect(() => {
      (SUBSCRIPTION_PRICES_XAF as Record<string, number>).monthly = 1;
    }).toThrow(TypeError);
    const price = getSubscriptionPrice('annual');
    expect(Object.isFrozen(price)).toBe(true);
    expect(() => {
      (price as { amount: number }).amount = 1;
    }).toThrow(TypeError);
    const list = listSubscriptionPrices();
    expect(Object.isFrozen(list)).toBe(true);
    expect(getSubscriptionPrice('annual').amount).toBe(35000);
  });

  describe('parité avec le catalogue d’affichage web', () => {
    it('mêmes durées, même ordre, mêmes mois et mêmes montants totaux', () => {
      expect(
        webOffers.SUBSCRIPTION_OFFERS.map((o) => ({
          term: o.term,
          months: o.months,
          amount: o.totalXaf,
        })),
      ).toEqual(
        listSubscriptionPrices().map((p) => ({
          term: p.term,
          months: p.months,
          amount: p.amount,
        })),
      );
    });

    it('prix mensuel de référence identique au tarif mensuel serveur', () => {
      expect(webOffers.MONTHLY_PRICE_XAF).toBe(
        getSubscriptionPrice('monthly').amount,
      );
    });

    it('1-21D : économies 500 / 2 500 / 7 000, deux mois offerts calculés (12 mois au prix de 10), meilleure économie', () => {
      const monthly = getSubscriptionPrice('monthly').amount;
      expect(
        webOffers.SUBSCRIPTION_OFFERS.map((o) => [
          o.term,
          o.totalXaf,
          o.savingXaf,
          o.freeMonths,
        ]),
      ).toEqual([
        ['monthly', 3500, 0, 0],
        ['quarterly', 10000, 500, 0],
        ['semiannual', 18500, 2500, 0],
        ['annual', 35000, 7000, 2],
      ]);
      // Annuel : 12 mois d'accès pour le prix de 10 mensualités.
      expect(10 * monthly).toBe(getSubscriptionPrice('annual').amount);
      expect(webOffers.BEST_SAVING_TERM).toBe('annual');
      // Équivalent mensuel affiché « environ 2 917 FCFA » (jamais prélevé).
      expect(
        webOffers.monthlyEquivalentXaf(webOffers.SUBSCRIPTION_OFFERS[3]),
      ).toBe(2917);
    });

    it("1-21D : mois offerts seulement si l'économie vaut un nombre EXACT de mensualités", () => {
      expect(webOffers.freeMonthsFor(7000, 3500)).toBe(2);
      expect(webOffers.freeMonthsFor(3500, 3500)).toBe(1);
      expect(webOffers.freeMonthsFor(6999, 3500)).toBe(0);
      expect(webOffers.freeMonthsFor(500, 3500)).toBe(0);
      expect(webOffers.freeMonthsFor(0, 3500)).toBe(0);
      expect(webOffers.freeMonthsFor(-3500, 3500)).toBe(0);
      expect(webOffers.freeMonthsFor(7000, 0)).toBe(0);
    });

    it('1-21D : source unique — le module web importe le catalogue serveur et ne contient aucun montant', () => {
      const source = readFileSync(
        join(__dirname, '../../../web/src/lib/subscription-offers.ts'),
        'utf8',
      );
      expect(source).toContain(
        'from "../../../api/src/subscriptions/subscription-pricing"',
      );
      for (const price of listSubscriptionPrices()) {
        expect(source).not.toMatch(
          new RegExp(
            `\\b${price.amount}\\b|\\b${price.amount.toLocaleString('en').replace(',', '[_,  ]')}\\b`,
          ),
        );
      }
      // Aucun ancien montant (version 1) ni de la grille intermédiaire.
      expect(source).not.toMatch(
        /\b(3000|8500|16000|30000|9000|16500|30500)\b/,
      );
    });
  });
});
