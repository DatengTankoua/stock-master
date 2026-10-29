import {
  PAYMENT_CONFIRMATION_DELAY_MS,
  confirmationDelayExceeded,
  confirmationDelayStart,
  paymentAwaitingConfirmation,
  paymentConfirmationDelayed,
  paymentCreationUnresolved,
  paymentUnresolvedAtSasPay,
} from './payment-confirmation-delay';

/** Retards de confirmation SasPay : règles pures, sans base ni réseau. */
describe('payment-confirmation-delay', () => {
  const created = new Date('2026-10-20T08:00:00.000Z');
  const before = new Date(
    created.getTime() + PAYMENT_CONFIRMATION_DELAY_MS - 1,
  );
  const at = new Date(created.getTime() + PAYMENT_CONFIRMATION_DELAY_MS);
  const engaged = {
    provider: 'saspay',
    status: 'pending',
    open: true,
    createdAt: created,
    collectedAt: null,
    refundedAt: null,
    periodId: null,
    providerTransactionId: '6f1c2c1e-1d1a-4a43-9a50-3b6a3c2f0d11',
    providerCheckoutExpiresAt: new Date(created.getTime() + 30 * 60_000),
  };

  it('seuil de 24 h exactement, mesuré depuis createdAt (jamais updatedAt)', () => {
    expect(PAYMENT_CONFIRMATION_DELAY_MS).toBe(86_400_000);
    expect(confirmationDelayStart(engaged)).toBe(created);
    expect(confirmationDelayExceeded(engaged, before)).toBe(false);
    expect(confirmationDelayExceeded(engaged, at)).toBe(true);
    const touched = { ...engaged, updatedAt: before };
    expect(confirmationDelayExceeded(touched, at)).toBe(true);
    expect(confirmationDelayStart({ ...engaged, createdAt: undefined })).toBe(
      null,
    );
    expect(
      confirmationDelayExceeded({ ...engaged, createdAt: 'hier' }, at),
    ).toBe(false);
  });

  it('alerte : SasPay ouvert non résolu (initiating, pending, uncertain) seulement', () => {
    for (const status of ['initiating', 'pending', 'uncertain']) {
      expect(paymentConfirmationDelayed({ ...engaged, status }, at)).toBe(true);
    }
    expect(paymentConfirmationDelayed(engaged, before)).toBe(false);
    // Confirmé, refusé, à examiner (déjà signalé), clos.
    for (const status of ['succeeded', 'failed', 'review']) {
      expect(paymentConfirmationDelayed({ ...engaged, status }, at)).toBe(
        false,
      );
    }
    expect(paymentConfirmationDelayed({ ...engaged, open: false }, at)).toBe(
      false,
    );
    expect(
      paymentConfirmationDelayed({ ...engaged, provider: 'campay' }, at),
    ).toBe(false);
    expect(
      paymentConfirmationDelayed({ ...engaged, collectedAt: at }, at),
    ).toBe(false);
    expect(paymentConfirmationDelayed({ ...engaged, refundedAt: at }, at)).toBe(
      false,
    );
    expect(paymentConfirmationDelayed({ ...engaged, periodId: 'p' }, at)).toBe(
      false,
    );
  });

  it('page encore valide sans transaction : le payeur n’a pas payé, aucune alerte', () => {
    const waiting = {
      ...engaged,
      providerTransactionId: null,
      providerCheckoutExpiresAt: new Date(at.getTime() + 60_000),
    };
    expect(paymentUnresolvedAtSasPay(waiting, at)).toBe(false);
    // Même page expirée : à vérifier (débit non exclu sans affirmation).
    const expired = { ...waiting, providerCheckoutExpiresAt: before };
    expect(paymentConfirmationDelayed(expired, at)).toBe(true);
    // Transaction engagée sur page valide : non résolu.
    expect(
      paymentUnresolvedAtSasPay(
        {
          ...engaged,
          providerCheckoutExpiresAt: waiting.providerCheckoutExpiresAt,
        },
        at,
      ),
    ).toBe(true);
  });

  it('message client : transaction engagée, page close, issue inconnue', () => {
    expect(paymentAwaitingConfirmation(engaged, false)).toBe(true);
    // Page encore proposée : parcours habituel (transaction rejouable).
    expect(paymentAwaitingConfirmation(engaged, true)).toBe(false);
    expect(
      paymentAwaitingConfirmation(
        { ...engaged, providerTransactionId: null },
        false,
      ),
    ).toBe(false);
    for (const status of ['uncertain', 'review', 'succeeded', 'failed']) {
      expect(paymentAwaitingConfirmation({ ...engaged, status }, false)).toBe(
        false,
      );
    }
    expect(
      paymentAwaitingConfirmation({ ...engaged, renewalConflictAt: at }, false),
    ).toBe(false);
    expect(
      paymentAwaitingConfirmation({ ...engaged, collectedAt: at }, false),
    ).toBe(false);
    expect(
      paymentAwaitingConfirmation({ ...engaged, provider: 'campay' }, false),
    ).toBe(false);
  });

  it('création non confirmée : session inconnue, initiating ou initiation_uncertain', () => {
    const creation = {
      ...engaged,
      status: 'initiating',
      providerReference: null,
      providerTransactionId: null,
      incidentCode: null,
    };
    expect(paymentCreationUnresolved(creation)).toBe(true);
    expect(
      paymentCreationUnresolved({
        ...creation,
        status: 'uncertain',
        incidentCode: 'initiation_uncertain',
      }),
    ).toBe(true);
    // Session connue, autre incident, autre état, clos, encaissé, CamPay.
    expect(
      paymentCreationUnresolved({ ...creation, providerReference: 'sess' }),
    ).toBe(false);
    expect(
      paymentCreationUnresolved({
        ...creation,
        status: 'uncertain',
        incidentCode: 'checkout_unresolved',
      }),
    ).toBe(false);
    for (const status of ['pending', 'review', 'succeeded', 'failed']) {
      expect(paymentCreationUnresolved({ ...creation, status })).toBe(false);
    }
    expect(paymentCreationUnresolved({ ...creation, open: false })).toBe(false);
    expect(paymentCreationUnresolved({ ...creation, collectedAt: at })).toBe(
      false,
    );
    expect(paymentCreationUnresolved({ ...creation, provider: 'campay' })).toBe(
      false,
    );
  });
});
