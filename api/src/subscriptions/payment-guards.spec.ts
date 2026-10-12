// 1-21D — Décisions PURES du panneau de paiement web (même procédé que la
// parité tarifaire : le code de production de l'API n'importe jamais le web).
import {
  CHECKOUT_EXPIRY_MARGIN_MS,
  abandonReleases,
  canRequestAbandon,
  chargedAmountChange,
  checkoutDeadline,
  checkoutPhase,
  minorToMajor,
  nextPhaseChangeAt,
  paymentAvailability,
  receiptAvailable,
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

describe('Panneau de paiement : échéance, situation, changement de forfait (1-21E)', () => {
  const RECEIVED = 1_000_000;
  const open = (expiresInMs: number) => ({
    status: 'pending',
    situation: 'checkout-open' as const,
    checkoutDeadline: checkoutDeadline(expiresInMs, RECEIVED),
  });

  it('échéance = réception + validité restante (jamais l’horloge du serveur) ; absente ou invalide → aucune', () => {
    expect(checkoutDeadline(600_000, RECEIVED)).toBe(RECEIVED + 600_000);
    for (const value of [null, undefined, -1, Number.NaN, Infinity]) {
      expect(checkoutDeadline(value, RECEIVED)).toBeNull();
    }
  });

  it('page ouverte : lien retiré à l’échéance moins la marge, sans attendre le serveur ; minuteur unique', () => {
    const view = open(600_000);
    const switchAt = RECEIVED + 600_000 - CHECKOUT_EXPIRY_MARGIN_MS;
    expect(nextPhaseChangeAt(view)).toBe(switchAt);
    expect(checkoutPhase(view, switchAt - 1)).toBe('open');
    expect(checkoutPhase(view, switchAt)).toBe('expired');
    // Validité restante déjà inférieure à la marge : expirée aussitôt.
    expect(checkoutPhase(open(10_000), RECEIVED)).toBe('expired');
  });

  it('situations serveur traduites ; API antérieure ou Mobile Money → aucune phase', () => {
    const at = (situation: string | null | undefined, status = 'pending') =>
      checkoutPhase({ status, situation: situation as never }, RECEIVED);
    expect(at('checkout-expired')).toBe('expired');
    expect(at('checkout-link-missing', 'uncertain')).toBe('link-missing');
    expect(at('attempt-unresolved', 'uncertain')).toBe('attempt-unresolved');
    expect(at('checkout-closed', 'failed')).toBe('closed');
    expect(at(null)).toBeNull();
    expect(at(undefined)).toBeNull();
    expect(
      nextPhaseChangeAt({ status: 'pending', situation: null }),
    ).toBeNull();
  });

  it('« Changer de forfait » / « Annuler cette tentative » : tant que non confirmé, ni clos, ni en vérification opérateur', () => {
    expect(canRequestAbandon(open(600_000), RECEIVED)).toBe(true);
    // Après expiration, retour arrière ou rechargement : toujours proposés.
    expect(canRequestAbandon(open(600_000), RECEIVED + 3_600_000)).toBe(true);
    for (const situation of [
      'checkout-expired',
      'checkout-link-missing',
      'attempt-unresolved',
    ] as const) {
      expect(
        canRequestAbandon({ status: 'uncertain', situation }, RECEIVED),
      ).toBe(true);
    }
    expect(
      canRequestAbandon(
        { status: 'failed', situation: 'checkout-closed' },
        RECEIVED,
      ),
    ).toBe(false);
    for (const status of ['succeeded', 'review']) {
      expect(
        canRequestAbandon({ status, situation: 'checkout-open' }, RECEIVED),
      ).toBe(false);
    }
    // Mobile Money (aucune page à fermer) : jamais proposés.
    expect(
      canRequestAbandon({ status: 'pending', situation: null }, RECEIVED),
    ).toBe(false);
  });

  it('seule l’issue `released` libère un nouveau paiement', () => {
    expect(abandonReleases('released')).toBe(true);
    for (const outcome of [
      'succeeded',
      'in-progress',
      'attempt-recorded',
      'awaiting-resolution',
      'not-found-at-provider',
      'cancel-unconfirmed',
    ] as const) {
      expect(abandonReleases(outcome)).toBe(false);
    }
  });
});

describe('Panneau de paiement : résolution, reçu (1-21E, suite)', () => {
  it('situations de résolution : traduites ; encaissement en résolution jamais « annulable »', () => {
    const at = (situation: string, status: string) =>
      checkoutPhase({ status, situation: situation as never }, 0);
    expect(at('closure-unconfirmed', 'uncertain')).toBe('closure-unconfirmed');
    expect(at('renewal-suspended', 'pending')).toBe('renewal-suspended');
    expect(at('collected-in-resolution', 'review')).toBe(
      'collected-in-resolution',
    );
    expect(
      canRequestAbandon(
        { status: 'uncertain', situation: 'closure-unconfirmed' },
        0,
      ),
    ).toBe(true);
    expect(
      canRequestAbandon(
        { status: 'review', situation: 'collected-in-resolution' },
        0,
      ),
    ).toBe(false);
  });

  it('reçu proposé seulement pour un encaissement confirmé (ou `succeeded` d’une API antérieure)', () => {
    expect(receiptAvailable({ status: 'succeeded' })).toBe(true);
    expect(receiptAvailable({ status: 'review', collected: true })).toBe(true);
    for (const status of ['pending', 'uncertain', 'review', 'failed']) {
      expect(receiptAvailable({ status, collected: false })).toBe(false);
    }
  });

  it('montant du reçu : centimes conservés, sans flottant', () => {
    expect(minorToMajor(350000)).toEqual({ major: 3500, cents: 0 });
    expect(minorToMajor(351750)).toEqual({ major: 3517, cents: 50 });
  });
});
