import { createHmac } from 'crypto';
import {
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
} from '../payment-provider';
import { PaymentConfigError, resolvePaymentConfig } from './saspay-config';
import {
  SasPayPaymentProvider,
  parseSasPayAmount,
  parseSasPayCents,
  sasPayDebitMatchesPrice,
  unwrapSasPayBody,
  validCheckoutUrl,
} from './saspay-payment-provider';
import {
  SasPayHttpRequest,
  SasPayTransport,
  SasPayTransportError,
} from './saspay-transport';
import { verifySasPayWebhookSignature } from './saspay-webhook-signature';

const LIVE = 'sk_live_fake-unit-live-0001';
const TEST = 'sk_test_fake-unit-test-0001';

describe('Configuration SasPay (1-21B)', () => {
  it('défaut : aucune nouvelle tentative, SasPay non configuré', () => {
    expect(resolvePaymentConfig({})).toEqual({ active: 'none', saspay: null });
  });

  it('CamPay ou valeur inconnue jamais activable par variable', () => {
    for (const value of ['campay', 'simulated', 'SASPAY']) {
      expect(() =>
        resolvePaymentConfig({ PAYMENT_PROVIDER_ACTIVE: value }),
      ).toThrow(PaymentConfigError);
    }
  });

  it('préfixe de clé cohérent avec l’environnement ; messages sans valeur', () => {
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
      }).saspay?.environment,
    ).toBe('live');
    for (const [environment, key] of [
      ['live', TEST],
      ['sandbox', LIVE],
      ['live', 'sk_live_court'],
      ['prod', LIVE],
    ]) {
      let error: unknown;
      try {
        resolvePaymentConfig({
          SASPAY_ENVIRONMENT: environment,
          SASPAY_SECRET_KEY: key,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(String((error as Error).message)).not.toContain(key);
    }
  });

  it('actif sans clé, bac à sable actif en production, secret webhook sans clé ou réutilisé → refus', () => {
    expect(() =>
      resolvePaymentConfig({ PAYMENT_PROVIDER_ACTIVE: 'saspay' }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({
        PAYMENT_PROVIDER_ACTIVE: 'saspay',
        SASPAY_ENVIRONMENT: 'sandbox',
        SASPAY_SECRET_KEY: TEST,
        NODE_ENV: 'production',
      }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({ SASPAY_WEBHOOK_SECRET: 'x'.repeat(32) }),
    ).toThrow(PaymentConfigError);
    expect(() =>
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
        SASPAY_WEBHOOK_SECRET: LIVE,
      }),
    ).toThrow(PaymentConfigError);
  });

  it('production : bac à sable refusé même avec `none` (aucune confirmation possible) ; LIVE avec `none` admis pour confirmer', () => {
    for (const active of [undefined, 'none', 'saspay']) {
      let error: unknown;
      try {
        resolvePaymentConfig({
          PAYMENT_PROVIDER_ACTIVE: active,
          SASPAY_ENVIRONMENT: 'sandbox',
          SASPAY_SECRET_KEY: TEST,
          SASPAY_WEBHOOK_SECRET: 'whsec-for-unit-tests-0001',
          NODE_ENV: 'production',
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(String((error as Error).message)).not.toContain(TEST);
    }
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'live',
        SASPAY_SECRET_KEY: LIVE,
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ active: 'none', saspay: { environment: 'live' } });
    // Hors production : bac à sable admis (vérification préalable).
    expect(
      resolvePaymentConfig({
        SASPAY_ENVIRONMENT: 'sandbox',
        SASPAY_SECRET_KEY: TEST,
      }),
    ).toMatchObject({ active: 'none', saspay: { environment: 'sandbox' } });
  });
});

describe('Signature du webhook SasPay (1-21B, contrat officiel)', () => {
  const secret = 'whsec-for-unit-tests-0001';
  const body = Buffer.from('{"event":"transaction.success","data":{"id":"x"}}');
  const sign = (ts: string, raw = body) =>
    createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it('valide sur le corps BRUT ; altéré, mauvais secret, en-têtes mal formés → invalide', () => {
    expect(
      verifySasPayWebhookSignature({
        rawBody: body,
        signature: sign(ts),
        timestamp: ts,
        secret,
        nowMs: now,
      }),
    ).toBe('valid');
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(body.toString()), null, 1),
    );
    for (const input of [
      { rawBody: reserialized, signature: sign(ts) },
      { rawBody: body, signature: sign(ts).toUpperCase() },
      { rawBody: body, signature: sign(ts).slice(1) },
      { rawBody: body, signature: undefined },
    ]) {
      expect(
        verifySasPayWebhookSignature({
          ...input,
          timestamp: ts,
          secret,
          nowMs: now,
        }),
      ).toBe('invalid');
    }
    expect(
      verifySasPayWebhookSignature({
        rawBody: body,
        signature: sign(ts),
        timestamp: ts,
        secret: 'other-secret-0000000000',
        nowMs: now,
      }),
    ).toBe('invalid');
  });

  it('tolérance de 300 s, des deux côtés', () => {
    for (const [offset, expected] of [
      [300, 'valid'],
      [-300, 'valid'],
      [301, 'stale'],
      [-301, 'stale'],
    ] as const) {
      const t = String(now / 1000 - offset);
      expect(
        verifySasPayWebhookSignature({
          rawBody: body,
          signature: sign(t),
          timestamp: t,
          secret,
          nowMs: now,
        }),
      ).toBe(expected);
    }
  });
});

describe('Adaptateur SasPay — formats (1-21B)', () => {
  it('montants : décimal exact sans centimes seulement', () => {
    expect(parseSasPayAmount('3000.00')).toBe(3000);
    expect(parseSasPayAmount('3000')).toBe(3000);
    for (const bad of ['3000.50', '-3000', '3e3', '03000', 3000, null, '']) {
      expect(parseSasPayAmount(bad)).toBeNull();
    }
  });

  it('centimes : décimal exact, deux décimales au plus, sans flottant', () => {
    expect(parseSasPayCents('517.50')).toBe(51750);
    expect(parseSasPayCents('17.5')).toBe(1750);
    expect(parseSasPayCents('500')).toBe(50000);
    expect(parseSasPayCents('0.01')).toBe(1);
    expect(parseSasPayCents('0.1')! + parseSasPayCents('0.2')!).toBe(
      parseSasPayCents('0.30'),
    );
    for (const bad of [
      '17.505',
      '-1.00',
      '1e3',
      '05.00',
      '.50',
      '',
      17.5,
      null,
    ]) {
      expect(parseSasPayCents(bad)).toBeNull();
    }
  });

  it('page de paiement : HTTPS et hôte documenté seulement', () => {
    expect(validCheckoutUrl('https://pay.saspay.me/checkout/abc==')).toBe(
      'https://pay.saspay.me/checkout/abc==',
    );
    for (const bad of [
      'http://pay.saspay.me/checkout/x',
      'https://pay.saspay.me.evil.example/x',
      'https://user:pw@pay.saspay.me/x',
      'https://evil.example/checkout/x',
      'javascript:alert(1)',
      '',
    ]) {
      expect(validCheckoutUrl(bad)).toBeNull();
    }
  });

  it('enveloppe documentée ou corps brut ; échec enveloppé → indéfini', () => {
    expect(
      unwrapSasPayBody({ success: true, data: { id: 1 }, code: 200 }),
    ).toEqual({ id: 1 });
    expect(unwrapSasPayBody({ id: 1 })).toEqual({ id: 1 });
    expect(unwrapSasPayBody({ success: false, error: {} })).toBeUndefined();
  });
});

describe('Adaptateur SasPay — débit selon le mode de frais (1-21C)', () => {
  // Champs de `verify` (exemple documenté : ADD_ON, 2500 + 37.50 = 2537.50).
  const addOn = {
    requested_amount: '500.00',
    fee_charge_mode: 'ADD_ON',
    client_fee: '17.50',
    debited_amount: '517.50',
    net_amount: '500.00',
  };
  const deducted = {
    requested_amount: '500.00',
    fee_charge_mode: 'DEDUCTED',
    client_fee: '17.50',
    debited_amount: '500.00',
    net_amount: '482.50',
  };

  it('ADD_ON valide : débit = prix + frais confirmés (centimes exacts), net = prix', () => {
    expect(sasPayDebitMatchesPrice(addOn, 500)).toBe(true);
    expect(
      sasPayDebitMatchesPrice({ ...addOn, net_amount: undefined }, 500),
    ).toBe(true);
    // Exemple de la documentation, autre frais : aucun taux supposé.
    expect(
      sasPayDebitMatchesPrice(
        {
          ...addOn,
          requested_amount: '2500.00',
          client_fee: '37.50',
          debited_amount: '2537.50',
          net_amount: '2500.00',
        },
        2500,
      ),
    ).toBe(true);
    // Écriture décimale abrégée du même montant.
    expect(
      sasPayDebitMatchesPrice(
        { ...addOn, client_fee: '17.5', debited_amount: '517.5' },
        500,
      ),
    ).toBe(true);
  });

  it('DEDUCTED valide : débit = prix, net ≤ prix ; mode absent : débit = prix', () => {
    expect(sasPayDebitMatchesPrice(deducted, 500)).toBe(true);
    expect(
      sasPayDebitMatchesPrice(
        {
          requested_amount: '500.00',
          debited_amount: '500.00',
          net_amount: '500.00',
        },
        500,
      ),
    ).toBe(true);
    expect(
      sasPayDebitMatchesPrice(
        { requested_amount: '500.00', debited_amount: '517.50' },
        500,
      ),
    ).toBe(false);
  });

  it('mauvais prix demandé → non concordant, quel que soit le mode', () => {
    for (const tx of [addOn, deducted]) {
      expect(sasPayDebitMatchesPrice(tx, 3000)).toBe(false);
      expect(
        sasPayDebitMatchesPrice({ ...tx, requested_amount: '499.99' }, 500),
      ).toBe(false);
      expect(
        sasPayDebitMatchesPrice({ ...tx, requested_amount: 500 }, 500),
      ).toBe(false);
    }
  });

  it('frais ou débit incohérents → non concordant (jamais « débit ≥ prix »)', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...addOn, debited_amount: '518.00' },
      { ...addOn, debited_amount: '600.00' },
      { ...addOn, client_fee: undefined },
      { ...addOn, client_fee: 17.5 },
      { ...addOn, client_fee: '-17.50' },
      { ...addOn, client_fee: '17.505', debited_amount: '517.505' },
      { ...addOn, net_amount: '482.50' },
      { ...addOn, net_amount: 'n/a' },
      { ...deducted, debited_amount: '517.50' },
      { ...deducted, net_amount: '517.50' },
      { ...addOn, fee_charge_mode: '' },
      { ...addOn, fee_charge_mode: 'SPLIT' },
    ];
    for (const tx of bad) expect(sasPayDebitMatchesPrice(tx, 500)).toBe(false);
  });
});

describe('Adaptateur SasPay — création (1-21B)', () => {
  const request = {
    merchantReference: 'SM0123456789ABCDEF01234567',
    amount: 3000,
    currency: 'XAF' as const,
    payerPhone: null,
    description: 'Abonnement',
    customer: { email: 'gerant@example.com', name: 'Gérant' },
    returnUrl:
      'https://app.example.com/app/organization/subscription?payment=x',
  };
  const providerWith = (transport: SasPayTransport) =>
    new SasPayPaymentProvider({
      environment: 'sandbox',
      secretKey: TEST,
      transport,
    });
  const reply = (status: number, data?: unknown) => () =>
    Promise.resolve({
      status,
      bodyText: JSON.stringify(
        data === undefined ? {} : { success: true, data, code: status },
      ),
    });

  it('réponse LIVE réelle (1-21C, anonymisée) : page sur checkout.saspay.me acceptée', async () => {
    // Forme observée le 2026-10-12 (enveloppe, champs) ; identifiants,
    // slug, e-mail et nom remplacés.
    const provider = providerWith(
      reply(201, {
        id: '0f0e0d0c-0b0a-4908-8706-050403020101',
        merchant: '0f0e0d0c-0b0a-4908-8706-050403020102',
        slug: 'anonymise',
        checkout_url: 'https://checkout.saspay.me/anonymise',
        amount: '3000.00',
        currency: 'XAF',
        country: 'CM',
        description: `Abonnement Stock Master (1 mois) ${request.merchantReference}`,
        customer_email: 'gerant@example.com',
        customer_name: 'Gérant',
        customer_phone: '',
        return_url: request.returnUrl,
        metadata: { merchantReference: request.merchantReference },
        fee_charge_mode: '',
        status: 'PENDING',
        transaction: null,
        payment_link: null,
        paid_at: null,
        created_by_member: null,
        expires_at: '2026-10-12T15:44:53.168000Z',
        created_at: '2026-10-12T15:14:53.352230Z',
        updated_at: '2026-10-12T15:14:53.352230Z',
      }),
    );
    await expect(provider.initiate(request)).resolves.toEqual({
      outcome: 'accepted',
      providerReference: '0f0e0d0c-0b0a-4908-8706-050403020101',
      redirectUrl: 'https://checkout.saspay.me/anonymise',
    });
    expect(
      validCheckoutUrl('https://checkout.saspay.me.evil.example/x'),
    ).toBeNull();
    expect(validCheckoutUrl('http://checkout.saspay.me/x')).toBeNull();
  });

  it('corps envoyé : montant décimal, XAF, CM, métadonnée, retour serveur ; clé seulement en en-tête', async () => {
    let sent: SasPayHttpRequest | undefined;
    const provider = providerWith(async (req) => {
      sent = req;
      return reply(201, {
        id: '0f0e0d0c-0b0a-4908-8706-050403020100',
        checkout_url: 'https://pay.saspay.me/checkout/abc',
        metadata: { merchantReference: request.merchantReference },
      })();
    });
    await expect(provider.initiate(request)).resolves.toEqual({
      outcome: 'accepted',
      providerReference: '0f0e0d0c-0b0a-4908-8706-050403020100',
      redirectUrl: 'https://pay.saspay.me/checkout/abc',
    });
    expect(sent!.url).toBe('https://api.saspay.me/api/v1/checkout-sessions/');
    expect(sent!.headers.Authorization).toBe(`Bearer ${TEST}`);
    const body = JSON.parse(sent!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: '3000.00',
      currency: 'XAF',
      country: 'CM',
      customer_email: 'gerant@example.com',
      return_url: request.returnUrl,
      metadata: { merchantReference: request.merchantReference },
    });
    expect(JSON.stringify(body)).not.toContain(TEST);
  });

  it('classement des réponses : 400/422 refus, 401/403/404/429 et non transmis indisponible, 409/5xx/perdu incertain', async () => {
    for (const status of [400, 422]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).resolves.toEqual({ outcome: 'rejected' });
    }
    for (const status of [401, 403, 404, 429]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    }
    await expect(
      providerWith(() =>
        Promise.reject(new SasPayTransportError('not-sent')),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    for (const status of [409, 500, 502]) {
      await expect(
        providerWith(reply(status)).initiate(request),
      ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
    }
    await expect(
      providerWith(() =>
        Promise.reject(new SasPayTransportError('unknown')),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
    // 201 inexploitable (page hors hôte autorisé) : session peut-être créée.
    await expect(
      providerWith(
        reply(201, {
          id: '0f0e0d0c-0b0a-4908-8706-050403020100',
          checkout_url: 'https://evil.example/x',
        }),
      ).initiate(request),
    ).rejects.toBeInstanceOf(PaymentProviderUncertainError);
  });

  it('sans payeur : rien n’est envoyé', async () => {
    const transport = jest.fn();
    await expect(
      providerWith(transport).initiate({ ...request, customer: undefined }),
    ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    expect(transport).not.toHaveBeenCalled();
  });
});
