import { MonotonicClock, systemMonotonicClock } from '../../subscription-clock';
import {
  CheckoutCancellationResult,
  PAYMENT_CURRENCY,
  PaymentCollectionRequest,
  PaymentInitiationResult,
  PaymentProvider,
  PaymentProviderInconsistencyError,
  PaymentProviderUncertainError,
  PaymentProviderUnavailableError,
  PaymentStatusLookup,
  ProviderPaymentState,
  ProviderPaymentStatus,
} from '../payment-provider';
import { SASPAY_PROVIDER_NAME, SasPayEnvironment } from './saspay-config';
import {
  SasPayHttpResponse,
  SasPayTransport,
  SasPayTransportError,
  fetchSasPayTransport,
} from './saspay-transport';

/**
 * 1-21B — Adaptateur SasPay : CHECKOUT HÉBERGÉ (rapport 1-21A, § 4).
 *
 * Contrat utilisé, et lui seul (documentation officielle et OpenAPI,
 * consultées le 2026-10-11) :
 * - `POST /checkout-sessions/` `{ amount ("3000.00"), currency, country,
 *   description, customer_email, customer_name, return_url, metadata,
 *   expires_at }` → `{ id, checkout_url, metadata, status, … }`. Pas
 *   d'`Idempotency-Key` sur cette route (documenté) : une réponse perdue
 *   laisse la tentative INCERTAINE, jamais une seconde session ;
 * - `GET /checkout-sessions/{id}/` → `{ id, amount, currency, status,
 *   metadata, transaction, checkout_url }` ;
 * - `GET /checkout-sessions/{id}/status/` → `{ id, status, transaction_id,
 *   transaction_status }` (revérifie le gateway, documenté) ;
 * - `GET /payments/{id}/verify/` → `{ id, status, requested_amount,
 *   fee_charge_mode, client_fee, debited_amount, net_amount, currency,
 *   flow_direction, transaction_type }`
 *   (revérifie le gateway si `PENDING`, documenté) ;
 * - `GET /checkout-sessions/?page=&page_size=` (pagination par numéro,
 *   `next`) : recherche BORNÉE par `metadata.merchantReference` après une
 *   réponse perdue ;
 * - 1-21E — `POST /checkout-sessions/{id}/cancel/` (corps vide) : `PENDING`
 *   → `CANCELLED` ; `409 not_pending` pour une session payée, expirée ou
 *   déjà annulée (documentation consultée le 2026-10-12). Rien n'y est dit
 *   d'une transaction en cours : la fermeture n'est demandée que pour une
 *   session SANS transaction, et seul le statut relu ensuite fait foi.
 *
 * Enveloppe : `{ success, data, code }` documentée, mais certains exemples
 * l'omettent (et `/countries/` répond enveloppé contrairement à sa page) :
 * les deux formes sont acceptées (1-21A, B3).
 *
 * Preuves EXIGÉES avant un succès : session = celle ENREGISTRÉE ; notre
 * référence dans SA `metadata` ; transaction désignée PAR LA SESSION (route
 * de statut et détail concordants), puis relue (`verify`) avec le même
 * identifiant, `INBOUND`/`PAIEMENT` ; montant DEMANDÉ égal au prix et
 * montant DÉBITÉ concordant selon le mode de frais confirmé (1-21C,
 * `sasPayDebitMatchesPrice`) ; devise identique. La `metadata` seule ne
 * prouve rien sur une transaction.
 *
 * Hypothèses À VÉRIFIER en bac à sable (1-21A, B4) : une session peut-elle
 * porter plusieurs transactions ; un succès peut-il suivre `EXPIRED` ou
 * `CANCELLED`. Une transaction `FAILED` peut être rejouée (`/retry/`, même
 * identifiant, documenté) : `FAILED` n'est donc pas définitif. En attendant :
 * session close ou transaction échouée sans succès → `unresolved` (jamais
 * `failed`), avec `checkoutClosed` pour une session close. 1-21E : close
 * SANS aucune transaction (aucun débit possible, « une session ne débite
 * rien tant qu'elle n'est pas payée », documenté) → le moteur la clôt.
 */

/** Origine OFFICIELLE de l'API ; jamais fournie par une requête. */
export const SASPAY_API_ORIGIN = 'https://api.saspay.me';
export const SASPAY_API_BASE_PATH = '/api/v1';
/**
 * Hôtes de checkout : `pay.saspay.me` (documenté) et `checkout.saspay.me`
 * (réponse LIVE réelle observée en recette 1-21C, le 2026-10-12).
 */
export const SASPAY_CHECKOUT_ORIGINS: readonly string[] = Object.freeze([
  'https://pay.saspay.me',
  'https://checkout.saspay.me',
]);

export const SASPAY_COUNTRY = 'CM';
/** Validité demandée pour une page de paiement. */
export const SASPAY_CHECKOUT_TTL_MS = 30 * 60 * 1000;
/** Budget d'un appel `initiate`. */
export const SASPAY_INITIATE_BUDGET_MS = 10_000;
/** Budget TOTAL d'une consultation (trois routes). */
export const SASPAY_STATUS_BUDGET_MS = 15_000;
/** Recherche après réponse perdue : pages de 100, au plus 5, 20 s. */
export const SASPAY_LOOKUP_PAGE_SIZE = 100;
export const SASPAY_LOOKUP_MAX_PAGES = 5;
export const SASPAY_LOOKUP_BUDGET_MS = 20_000;
/**
 * Limite LOCALE d'appels sortants par processus (documenté : 300 / min par
 * compte, toutes origines confondues) : marge laissée aux autres usages.
 */
export const SASPAY_MAX_CALLS_PER_MINUTE = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Montant décimal exact en chaîne, centimes nuls : `"3000"`, `"3000.00"`. */
const INTEGRAL_DECIMAL = /^(0|[1-9]\d{0,11})(?:\.0{1,2})?$/;
/** Montant décimal en chaîne, au plus deux décimales : `"517.50"`. */
const CENTS_DECIMAL = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/;
const SESSION_STATES = new Set(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']);
const TRANSACTION_STATES = new Set([
  'PENDING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
]);

export interface SasPayProviderConfig {
  environment: SasPayEnvironment;
  secretKey: string;
  /** Tests et recette uniquement. */
  transport?: SasPayTransport;
  monotonic?: MonotonicClock;
  /** Horloge murale (ms), pour `expires_at`. */
  now?: () => number;
}

/** Erreur INTERNE de consultation : message générique, aucune donnée. */
export class SasPayStatusUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Statut SasPay indisponible.');
    this.name = 'SasPayStatusUnavailableError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Contenu utile : `data` de l'enveloppe documentée, sinon le corps brut. */
export function unwrapSasPayBody(body: unknown): unknown {
  if (isRecord(body) && typeof body.success === 'boolean') {
    return body.success ? body.data : undefined;
  }
  return body;
}

/** `"3000.00"` → 3000 ; tout autre littéral (centimes, signe, nombre) → null. */
export function parseSasPayAmount(value: unknown): number | null {
  if (typeof value !== 'string' || !INTEGRAL_DECIMAL.test(value)) return null;
  const amount = Number(value.split('.')[0]);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * `"517.50"` → 51750 centimes (entier exact, aucun calcul flottant) ; signe,
 * exposant, plus de deux décimales ou nombre JSON → null.
 */
export function parseSasPayCents(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = CENTS_DECIMAL.exec(value);
  if (!match) return null;
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * 1-21C — Débit de la transaction (`verify`) concordant avec le prix, selon
 * le mode de frais CONFIRMÉ par SasPay (documentation « Comprendre les
 * montants » et exemple `verify`, consultés le 2026-10-12) :
 *
 * | Mode | Débit du payeur | Net marchand |
 * |---|---|---|
 * | `ADD_ON` | `debited_amount` = `requested_amount` + `client_fee` | `net_amount` = `requested_amount` |
 * | `DEDUCTED` | `debited_amount` = `requested_amount` | `net_amount` ≤ `requested_amount` |
 *
 * - `requested_amount` doit égaler le prix enregistré (XAF entiers).
 * - Les frais ne sont jamais calculés ici (aucun taux) : seule l'égalité
 *   exacte, en centimes, entre les champs renvoyés est contrôlée. Les
 *   arrondis appliqués par SasPay ne sont pas documentés ; un frais à
 *   centimes (`"17.50"`) est accepté tel quel.
 * - `ADD_ON` sans `client_fee` lisible, `net_amount` illisible ou mode
 *   inconnu → non concordant (vérification opérateur).
 * - Mode absent (réponses antérieures) : débit exactement égal au prix.
 */
export function sasPayDebitMatchesPrice(
  transaction: Record<string, unknown>,
  priceXaf: number,
): boolean {
  if (!Number.isSafeInteger(priceXaf) || priceXaf <= 0) return false;
  const price = priceXaf * 100;
  const requested = parseSasPayCents(transaction.requested_amount);
  const debited = parseSasPayCents(transaction.debited_amount);
  if (requested !== price || debited === null) return false;
  const net =
    transaction.net_amount === undefined
      ? undefined
      : parseSasPayCents(transaction.net_amount);
  if (net === null) return false;
  const mode = transaction.fee_charge_mode;
  if (mode === 'ADD_ON') {
    const fee = parseSasPayCents(transaction.client_fee);
    return (
      fee !== null &&
      debited === requested + fee &&
      (net === undefined || net === requested)
    );
  }
  if (mode === 'DEDUCTED' || mode === undefined || mode === null) {
    return debited === requested && (net === undefined || net <= requested);
  }
  return false;
}

/** Page de paiement : HTTPS, origine de checkout documentée, sans identifiants. */
export function validCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!SASPAY_CHECKOUT_ORIGINS.includes(url.origin)) return null;
  return url.href;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const uuidOrNull = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

function metadataReference(metadata: unknown): string | null {
  return isRecord(metadata) && typeof metadata.merchantReference === 'string'
    ? metadata.merchantReference
    : null;
}

/**
 * Fenêtre glissante d'appels sortants (par processus) ; au-delà, aucun
 * appel n'est émis (refus local, jamais un dépassement chez SasPay).
 */
class OutboundBudget {
  private readonly calls: number[] = [];
  constructor(
    private readonly max: number,
    private readonly monotonic: MonotonicClock,
  ) {}
  take(): boolean {
    const now = this.monotonic();
    while (this.calls.length > 0 && now - this.calls[0] >= 60_000) {
      this.calls.shift();
    }
    if (this.calls.length >= this.max) return false;
    this.calls.push(now);
    return true;
  }
}

/** 1-21E — Date ISO 8601 lisible (`expires_at`), sinon `null`. */
export function parseSasPayDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface SessionFacts {
  id: string;
  amount: number | null;
  currency: string | null;
  status: string;
  merchantReference: string | null;
  transaction: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  /** 1-21E : `transaction` PRÉSENT et nul (absence affirmée). */
  transactionExplicitlyNull: boolean;
}

export class SasPayPaymentProvider implements PaymentProvider {
  readonly name = SASPAY_PROVIDER_NAME;
  readonly available = true;
  /** Recherche BORNÉE par `metadata` (liste des sessions, documentée). */
  readonly supportsMerchantReferenceLookup = true;
  /** Aucune idempotence documentée pour la création d'une session. */
  readonly idempotentInitiation = false;
  readonly requiresPayerPhone = false;
  readonly checkoutTtlMs = SASPAY_CHECKOUT_TTL_MS;

  private readonly transport: SasPayTransport;
  private readonly monotonic: MonotonicClock;
  private readonly now: () => number;
  private readonly budget: OutboundBudget;

  constructor(private readonly config: SasPayProviderConfig) {
    this.transport = config.transport ?? fetchSasPayTransport;
    this.monotonic = config.monotonic ?? systemMonotonicClock;
    this.now = config.now ?? Date.now;
    this.budget = new OutboundBudget(
      SASPAY_MAX_CALLS_PER_MINUTE,
      this.monotonic,
    );
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    deadline: number,
    body?: unknown,
  ): Promise<SasPayHttpResponse> {
    const remaining = deadline - this.monotonic();
    if (remaining <= 0) throw new SasPayTransportError('not-sent');
    if (!this.budget.take()) throw new SasPayTransportError('not-sent');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await this.transport({
        method,
        url: `${SASPAY_API_ORIGIN}${SASPAY_API_BASE_PATH}${path}`,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Création ──────────────────────────────────────────────────────────────

  async initiate(
    request: PaymentCollectionRequest,
  ): Promise<PaymentInitiationResult> {
    const deadline = this.monotonic() + SASPAY_INITIATE_BUDGET_MS;
    const customer = request.customer;
    if (
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0 ||
      request.currency !== PAYMENT_CURRENCY ||
      typeof request.merchantReference !== 'string' ||
      request.merchantReference.length === 0 ||
      !customer ||
      customer.email.length === 0 ||
      customer.name.trim().length === 0
    ) {
      // Requête invalide : rien n'est envoyé.
      throw new PaymentProviderUnavailableError();
    }
    // 1-21E : fin de validité DEMANDÉE, retenue si SasPay n'en renvoie pas.
    const requestedExpiry = new Date(this.now() + SASPAY_CHECKOUT_TTL_MS);
    let response: SasPayHttpResponse;
    try {
      response = await this.call('POST', '/checkout-sessions/', deadline, {
        amount: `${request.amount}.00`,
        currency: request.currency,
        country: SASPAY_COUNTRY,
        description: request.description.slice(0, 200),
        customer_email: customer.email,
        customer_name: customer.name.trim().slice(0, 100),
        ...(request.returnUrl ? { return_url: request.returnUrl } : {}),
        metadata: { merchantReference: request.merchantReference },
        expires_at: requestedExpiry.toISOString(),
      });
    } catch (error) {
      if (
        error instanceof SasPayTransportError &&
        error.failure === 'not-sent'
      ) {
        throw new PaymentProviderUnavailableError();
      }
      throw new PaymentProviderUncertainError();
    }
    const { status } = response;
    // Refus avant création, documentés (validation, authentification,
    // portée, route, limite de débit) : rien n'a été créé.
    if (status === 400 || status === 422) return { outcome: 'rejected' };
    if (status === 401 || status === 403 || status === 404 || status === 429) {
      throw new PaymentProviderUnavailableError();
    }
    // 409, 5xx, codes inattendus : la session a PU être créée.
    if (status !== 200 && status !== 201) {
      throw new PaymentProviderUncertainError();
    }
    const session = unwrapSasPayBody(parseJson(response.bodyText));
    const id = isRecord(session) ? uuidOrNull(session.id) : null;
    const checkoutUrl = isRecord(session)
      ? validCheckoutUrl(session.checkout_url)
      : null;
    const echoed = isRecord(session)
      ? metadataReference(session.metadata)
      : null;
    // Session créée mais inexploitable (identifiant, page non autorisée,
    // référence étrangère) : incertaine, jamais une seconde session.
    if (
      !id ||
      !checkoutUrl ||
      (echoed !== null && echoed !== request.merchantReference)
    ) {
      throw new PaymentProviderUncertainError();
    }
    return {
      outcome: 'accepted',
      providerReference: id,
      redirectUrl: checkoutUrl,
      checkoutExpiresAt:
        (isRecord(session) ? parseSasPayDate(session.expires_at) : null) ??
        requestedExpiry,
    };
  }

  // ─── Consultation ──────────────────────────────────────────────────────────

  async fetchStatus(
    lookup: PaymentStatusLookup,
  ): Promise<ProviderPaymentStatus | null> {
    if (lookup.by === 'merchant') {
      const id = await this.findSessionByMerchantReference(
        lookup.merchantReference,
      );
      return id === null ? null : this.statusOfSession(id);
    }
    const id = uuidOrNull(lookup.providerReference);
    if (!id) throw new SasPayStatusUnavailableError('invalid-reference');
    return this.statusOfSession(id);
  }

  private async getJson(
    path: string,
    deadline: number,
  ): Promise<{ status: number; data: unknown }> {
    let response: SasPayHttpResponse;
    try {
      response = await this.call('GET', path, deadline);
    } catch {
      throw new SasPayStatusUnavailableError('transport');
    }
    return {
      status: response.status,
      data: unwrapSasPayBody(parseJson(response.bodyText)),
    };
  }

  private async statusOfSession(
    sessionId: string,
  ): Promise<ProviderPaymentStatus | null> {
    const deadline = this.monotonic() + SASPAY_STATUS_BUDGET_MS;

    // 1. Session ENREGISTRÉE : référence, montant, devise, transaction.
    const detail = await this.getJson(
      `/checkout-sessions/${sessionId}/`,
      deadline,
    );
    if (detail.status === 404) return null;
    if (detail.status !== 200 || !isRecord(detail.data)) {
      throw new SasPayStatusUnavailableError('session');
    }
    const session = this.sessionFacts(detail.data);
    if (!session || session.id !== sessionId) {
      throw new SasPayStatusUnavailableError('session-shape');
    }

    // 2. Statut revérifié côté gateway (route dédiée, documentée).
    const live = await this.getJson(
      `/checkout-sessions/${sessionId}/status/`,
      deadline,
    );
    if (live.status !== 200 || !isRecord(live.data)) {
      throw new SasPayStatusUnavailableError('session-status');
    }
    const liveId = uuidOrNull(live.data.id);
    const liveStatus = str(live.data.status);
    if (
      liveId !== sessionId ||
      !liveStatus ||
      !SESSION_STATES.has(liveStatus)
    ) {
      throw new SasPayStatusUnavailableError('session-status-shape');
    }
    const liveTransaction = uuidOrNull(live.data.transaction_id);
    // Transaction désignée différemment par les deux routes : jamais
    // départagé (vérification opérateur).
    if (
      liveTransaction !== null &&
      session.transaction !== null &&
      liveTransaction !== session.transaction
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    const transactionId = liveTransaction ?? session.transaction;
    // 1-21E : absence de transaction AFFIRMÉE par les deux routes (champ
    // présent et nul) ; un champ manquant n'est jamais une preuve.
    const liveExplicitlyNull =
      Object.prototype.hasOwnProperty.call(live.data, 'transaction_id') &&
      live.data.transaction_id === null &&
      (live.data.transaction_status === undefined ||
        live.data.transaction_status === null);
    const transactionAbsenceConfirmed =
      transactionId === null &&
      session.transactionExplicitlyNull &&
      liveExplicitlyNull;

    const base = {
      providerReference: sessionId,
      merchantReference: session.merchantReference,
      providerTransactionId: transactionId,
      checkoutUrl: liveStatus === 'PENDING' ? session.checkoutUrl : null,
      checkoutExpiresAt: session.expiresAt,
      checkoutClosed: liveStatus === 'EXPIRED' || liveStatus === 'CANCELLED',
    };

    if (transactionId === null) {
      // Session payée sans transaction désignée : incohérent.
      if (liveStatus === 'PAID') {
        throw new PaymentProviderInconsistencyError('inconsistent-attachment');
      }
      return {
        ...base,
        state: liveStatus === 'PENDING' ? 'pending' : 'unresolved',
        amount: session.amount,
        currency: session.currency,
        transactionState: null,
        transactionAbsenceConfirmed,
      };
    }

    // 3. Transaction RELUE par l'identifiant que la session désigne.
    const verified = await this.getJson(
      `/payments/${transactionId}/verify/`,
      deadline,
    );
    if (verified.status === 404) {
      // Désignée par la session mais introuvable : temporaire / opérateur.
      throw new SasPayStatusUnavailableError('transaction-not-found');
    }
    if (verified.status !== 200 || !isRecord(verified.data)) {
      throw new SasPayStatusUnavailableError('transaction');
    }
    const tx = verified.data;
    const txStatus = str(tx.status);
    if (
      uuidOrNull(tx.id) !== transactionId ||
      !txStatus ||
      !TRANSACTION_STATES.has(txStatus)
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    if (
      (tx.flow_direction !== undefined && tx.flow_direction !== 'INBOUND') ||
      (tx.transaction_type !== undefined && tx.transaction_type !== 'PAIEMENT')
    ) {
      throw new PaymentProviderInconsistencyError('inconsistent-attachment');
    }
    // Prix demandé = montant de la session ; débit concordant selon le mode
    // de frais confirmé par SasPay (`ADD_ON` ou `DEDUCTED`), sinon `null`
    // (montant non concordant → vérification).
    const amount =
      session.amount !== null && sasPayDebitMatchesPrice(tx, session.amount)
        ? session.amount
        : null;
    const currency =
      str(tx.currency) === session.currency ? session.currency : null;

    let state: ProviderPaymentState;
    if (txStatus === 'SUCCESS') state = 'succeeded';
    else if (txStatus === 'PENDING') state = 'pending';
    // Échec ou annulation : nouvelle tentative possible sur une page encore
    // ouverte ; sinon à vérifier (succès tardif non exclu par le contrat).
    else state = liveStatus === 'PENDING' ? 'pending' : 'unresolved';
    const transactionState =
      txStatus === 'SUCCESS'
        ? 'succeeded'
        : txStatus === 'PENDING'
          ? 'pending'
          : 'failed';
    const debited = parseSasPayCents(tx.debited_amount);
    return {
      ...base,
      state,
      amount,
      currency,
      transactionState,
      transactionAbsenceConfirmed: false,
      paidAmountMinor: state === 'succeeded' ? debited : null,
    };
  }

  private sessionFacts(data: Record<string, unknown>): SessionFacts | null {
    const id = uuidOrNull(data.id);
    const status = str(data.status);
    if (!id || !status || !SESSION_STATES.has(status)) return null;
    const transaction =
      data.transaction === null || data.transaction === undefined
        ? null
        : uuidOrNull(data.transaction);
    if (data.transaction != null && transaction === null) return null;
    return {
      id,
      amount: parseSasPayAmount(data.amount),
      currency: str(data.currency),
      status,
      merchantReference: metadataReference(data.metadata),
      transaction,
      checkoutUrl: validCheckoutUrl(data.checkout_url),
      expiresAt: parseSasPayDate(data.expires_at),
      transactionExplicitlyNull:
        Object.prototype.hasOwnProperty.call(data, 'transaction') &&
        data.transaction === null,
    };
  }

  // ─── Fermeture (1-21E) ─────────────────────────────────────────────────────

  async cancelCheckout(
    providerReference: string,
  ): Promise<CheckoutCancellationResult> {
    const id = uuidOrNull(providerReference);
    // Référence illisible : rien n'est envoyé.
    if (!id) throw new PaymentProviderUnavailableError();
    const deadline = this.monotonic() + SASPAY_INITIATE_BUDGET_MS;
    let response: SasPayHttpResponse;
    try {
      response = await this.call(
        'POST',
        `/checkout-sessions/${id}/cancel/`,
        deadline,
        {},
      );
    } catch (error) {
      if (
        error instanceof SasPayTransportError &&
        error.failure === 'not-sent'
      ) {
        throw new PaymentProviderUnavailableError();
      }
      throw new PaymentProviderUncertainError();
    }
    if (response.status === 200) return 'cancelled';
    // Documenté : session payée, expirée ou déjà annulée.
    if (response.status === 409) return 'not-open';
    // Refus avant traitement (authentification, portée, limite) : rien fait.
    if ([401, 403, 429].includes(response.status)) {
      throw new PaymentProviderUnavailableError();
    }
    // 404 (session enregistrée introuvable), 5xx, codes inattendus : issue
    // inconnue ; la relecture du statut tranchera.
    throw new PaymentProviderUncertainError();
  }

  /**
   * Recherche BORNÉE d'une session portant notre référence (réponse perdue).
   * `null` : aucune trouvée DANS les pages lues — jamais une preuve
   * d'absence. Plusieurs : jamais départagées (incohérence).
   */
  private async findSessionByMerchantReference(
    merchantReference: string,
  ): Promise<string | null> {
    const deadline = this.monotonic() + SASPAY_LOOKUP_BUDGET_MS;
    const matches = new Set<string>();
    for (let page = 1; page <= SASPAY_LOOKUP_MAX_PAGES; page += 1) {
      const listed = await this.getJson(
        `/checkout-sessions/?page=${page}&page_size=${SASPAY_LOOKUP_PAGE_SIZE}`,
        deadline,
      );
      if (listed.status !== 200 || !isRecord(listed.data)) {
        throw new SasPayStatusUnavailableError('lookup');
      }
      const results = listed.data.results;
      if (!Array.isArray(results)) {
        throw new SasPayStatusUnavailableError('lookup-shape');
      }
      for (const item of results) {
        if (!isRecord(item)) continue;
        if (metadataReference(item.metadata) !== merchantReference) continue;
        const id = uuidOrNull(item.id);
        if (id) matches.add(id);
      }
      if (matches.size > 1) {
        throw new PaymentProviderInconsistencyError('ambiguous-lookup');
      }
      if (listed.data.next === null || listed.data.next === undefined) break;
    }
    return matches.size === 1 ? [...matches][0] : null;
  }
}
