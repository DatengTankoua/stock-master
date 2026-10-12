// 1-21D — Décisions PURES du panneau de paiement web (même procédé que la
// parité tarifaire : le code de production de l'API n'importe jamais le web).
import {
  chargedAmountChange,
  paymentAvailability,
} from '../../../web/src/lib/payment-guards';
import { getSubscriptionPrice } from './subscription-pricing';

describe('Panneau de paiement : capacités et prix confirmé (1-21D)', () => {
  it('paiements désactivés (`available: false`) distingués d’une API antérieure (404 → Mobile Money)', () => {
    expect(paymentAvailability({ available: false, method: null })).toBe(
      'unavailable',
    );
    // Le client web traduit le 404 d'une API antérieure en Mobile Money.
    expect(
      paymentAvailability({ available: true, method: 'mobile-money' }),
    ).toBe('mobile-money');
    expect(
      paymentAvailability({ available: true, method: 'hosted-checkout' }),
    ).toBe('hosted-checkout');
    // Capacités illisibles (réseau) : comportement antérieur, serveur arbitre.
    expect(paymentAvailability(null)).toBe('unknown');
  });

  it('ancien affichage mensuel 3 000, API actuelle 3 500 → changement signalé, montant enregistré conservé', () => {
    const charged = getSubscriptionPrice('monthly').amount;
    expect(charged).toBe(3500);
    expect(chargedAmountChange(3000, charged)).toEqual({
      displayedXaf: 3000,
      chargedXaf: 3500,
    });
  });

  it('montant identique ou aucun prix affiché → aucune confirmation demandée', () => {
    expect(chargedAmountChange(3500, 3500)).toBeNull();
    expect(chargedAmountChange(null, 3500)).toBeNull();
    expect(chargedAmountChange(undefined, 3500)).toBeNull();
    expect(chargedAmountChange(Number.NaN, 3500)).toBeNull();
  });
});
