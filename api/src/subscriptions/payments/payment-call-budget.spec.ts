import { PAYMENT_CALL_LIMITS, PaymentCallBudget } from './payment-call-budget';

/** 1-22D — Budget d'appels : voies, quota par organisation, horloge contrôlée. */
describe('PaymentCallBudget (1-22D)', () => {
  let now: number;
  let budget: PaymentCallBudget;
  const L = PAYMENT_CALL_LIMITS;

  beforeEach(() => {
    now = 1_000_000;
    budget = new PaymentCallBudget(() => now);
  });

  it('quota par organisation : refus 429 calculé sur ses seuls appels, sans effet', () => {
    const first = budget.reserve('A', L.perOrganization);
    expect(first.admitted).toBe(true);
    now += 10_000;
    const refused = budget.reserve('A', 1);
    expect(refused).toEqual({
      admitted: false,
      reason: 'organization',
      retryAfterSeconds: 50,
    });
    // Une autre organisation n'est pas touchée.
    expect(budget.reserve('B', 3).admitted).toBe(true);
  });

  it('réservation consommée par les appels, reste rendu à la fin', async () => {
    const decision = budget.reserve('A', 8);
    if (!decision.admitted) throw new Error('refus');
    await budget.run(decision.permit, () => {
      expect(budget.take()).toBe(true);
      expect(budget.take()).toBe(true);
      return Promise.resolve();
    });
    decision.permit.release();
    // 2 appels imputés : 18 encore disponibles pour A.
    expect(budget.reserve('A', L.perOrganization - 2).admitted).toBe(true);
    expect(budget.reserve('A', 1).admitted).toBe(false);
  });

  it('voie propriétaire pleine : refus de capacité à délai fixe ; confirmations servies', () => {
    for (let i = 0; i < L.ownerLane / L.perOrganization; i += 1) {
      expect(budget.reserve(`org-${i}`, L.perOrganization).admitted).toBe(true);
    }
    expect(budget.reserve('B', 1)).toEqual({
      admitted: false,
      reason: 'capacity',
      retryAfterSeconds: L.capacityRetryAfterSeconds,
    });
    expect(budget.confirmationHeadroom()).toBe(L.global - L.ownerLane);
    expect(budget.take()).toBe(true);
  });

  it('confirmations plafonnées : part propriétaire préservée ; plafond global jamais dépassé', () => {
    for (let i = 0; i < L.confirmationLane; i += 1) {
      expect(budget.take()).toBe(true);
    }
    expect(budget.take()).toBe(false);
    expect(budget.reserve('A', L.perOrganization).admitted).toBe(true);
    expect(budget.reserve('B', 1).admitted).toBe(false);
    expect(budget.confirmationHeadroom()).toBe(0);
    now += L.windowMs;
    expect(budget.take()).toBe(true);
  });

  it('429 du prestataire : pause de toutes les voies, puis reprise', () => {
    budget.providerThrottled();
    expect(budget.take()).toBe(false);
    expect(budget.reserve('A', 1)).toMatchObject({ reason: 'capacity' });
    now += L.providerCooldownMs;
    expect(budget.take()).toBe(true);
    expect(budget.reserve('A', 1).admitted).toBe(true);
  });
});
