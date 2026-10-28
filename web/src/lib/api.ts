import axios from "axios";
import { getToken, clearAuth } from "./auth";
import type { SaleSyncOutcome } from "./offline-sales-policy";
import { parseRetryAfterMs } from "./offline-sales-policy";
import type {
  DelegablePermission,
  OrganizationRole,
} from "./organization-permissions";
import { permissionCatalogFor } from "./organization-permissions";
import type { LegalAcceptancePayload } from "./legal/acceptance";
import type { MarketingConsentPayload } from "./marketing-consent";
import { clientT, currentLocale } from "@/i18n/client-t";
import { isProductSearch, matchesProductSearch } from "./product-search";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiUser {
  _id: string;
  name: string;
  email: string;
  role: "admin" | "seller";
  createdAt: string;
}

export interface ApiSection {
  _id: string;
  name: string;
  description: string;
  parentId?: string | null;
  createdAt: string;
  // Renseigné quand la section est dans la corbeille (`GET /sections/:id`).
  deletedAt?: string | null;
}

// 1-12H — projection serveur selon les permissions effectives : un champ
// optionnel ABSENT signifie « non autorisé », jamais 0.
// - standard : nom, prix de vente cible, stock restant, statut ;
// - `products.view_stock_details` : initialQuantity, unitsSold ;
// - `products.view_financials` : purchasePrice, totalPurchaseCost,
//   actualRevenue, actualProfit, margin (agrégats serveur sur toutes les
//   ventes du produit, indépendants des ventes consultables).
export interface ApiProduct {
  _id: string;
  sectionId: string;
  name: string;
  // R2 privé : lien signé à durée limitée (ou ancienne URL), `null` sans photo.
  imageUrl: string | null;
  salePrice: number;
  remainingQuantity: number;
  // Standard (tout membre). `null` : aucune date / règle par défaut ;
  // `undefined` : API antérieure (champs ni affichés ni modifiables).
  /** Date civile `AAAA-MM-JJ`, sans heure ni fuseau. */
  expiryDate?: string | null;
  /** Seuil de stock faible personnalisé (`0` explicite). */
  lowStockThreshold?: number | null;
  /**
   * Mode de suivi du stock (standard). `batches` : stock réparti en lots,
   * ventes et ajustements refusés par l'API tant que les ventes par lots ne
   * sont pas disponibles. `undefined` : API antérieure (sans lots).
   */
  stockTracking?: "none" | "batches";
  /**
   * Lot B — identité des lots vendables (produit suivi, fonctionnalité
   * activée) : de quoi choisir les lots d'une vente, y compris hors ligne.
   * Aucune quantité. Absent : vente par lots indisponible.
   */
  batchSale?: ApiProductBatchSale;
  /** Lot C — pertes nettes (unités, détail du stock), jamais des ventes. */
  lostQuantity?: number;
  /** Lot C — valeur estimée des pertes au prix d'achat de chaque mouvement. */
  lossValueAtCost?: number;
  createdAt: string;
  updatedAt: string;
  status: "in_stock" | "low_stock" | "out_of_stock";
  initialQuantity?: number;
  unitsSold?: number;
  purchasePrice?: number;
  totalPurchaseCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  /** Bénéfice réel / CA réel × 100 ; `null` sans CA. */
  margin?: number | null;
}

export interface ApiProductDetail extends ApiProduct {
  sales: ApiSale[];
  auditLogs: ApiAuditLog[];
}

/** Enveloppe `{ product, status, ...métriques }` des réponses produit. */
type ApiProductEnvelope = {
  product: Omit<ApiProduct, "status">;
  status: ApiProduct["status"];
} & Partial<
  Pick<
    ApiProduct,
    | "unitsSold"
    | "totalPurchaseCost"
    | "actualRevenue"
    | "actualProfit"
    | "margin"
  >
>;

function flattenProduct({ product, ...metrics }: ApiProductEnvelope) {
  return { ...product, ...metrics } as ApiProduct;
}

/** Lot B — lot vendable (identité seule, ordre FEFO serveur). */
export interface ApiSaleBatchSummary {
  _id: string;
  reference: string;
  expiryDate: string | null;
  manufacturerLot: string | null;
}

export interface ApiProductBatchSale {
  /** Jour du commerce à la lecture : borne basse de l'horloge locale. */
  businessDate: string;
  timeZone: string;
  batches: ApiSaleBatchSummary[];
}

/** Lot B — unités d'un lot sur une vente (instantané figé). */
export interface ApiSaleBatchAllocation {
  batchId: string;
  reference: string;
  expiryDate: string | null;
  manufacturerLot: string | null;
  quantity: number;
}

export interface ApiSaleBatchHistoryEntry {
  at: string;
  quantityBefore: number;
  quantityAfter: number;
  returned: ApiSaleBatchAllocation[];
  added: ApiSaleBatchAllocation[];
  restitutions: {
    batchId: string;
    reference: string;
    quantity: number;
    historical: boolean;
  }[];
  reason: string | null;
}

export interface ApiSale {
  _id: string;
  // `null` une fois le produit supprimé définitivement (référence non peuplée).
  productId: string | { _id: string; name: string } | null;
  /** Nom enregistré par le serveur au moment de la vente. */
  productName?: string;
  /** 1-15D : dernier nom connu, figé à la purge ou reconstruit (audit). */
  lastKnownProductName?: string;
  lastKnownSource?: "purge" | "audit";
  quantity: number;
  salePrice: number;
  sellerId: { _id: string; name: string; email: string };
  buyerName?: string;
  buyerContact?: string;
  createdAt: string;
  /** Lot B — affectation courante ; absente : sans lots ou antérieure. */
  batchAllocations?: ApiSaleBatchAllocation[];
  originalBatchAllocations?: ApiSaleBatchAllocation[];
  batchHistory?: ApiSaleBatchHistoryEntry[];
  expiredBatchRegularization?: {
    reason: string;
    at: string;
    businessDate: string;
    references: string[];
  };
}

export interface ApiAuditLog {
  _id: string;
  productId: string;
  action: string;
  actorId: { _id: string; name: string; email: string };
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AnalyticsOverview {
  // 1-16E : champs financiers ABSENTS sans `products.view_financials`.
  totalInvested?: number;
  totalRevenue: number;
  // 1-15D : `null` si le coût d'achat de produits supprimés est inconnu.
  // 1-16D : avec `month`, gain estimé du seul mois (classement par produit).
  netProfit?: number | null;
  avgMargin?: number | null;
  unitsSold: number;
  totalTransactions: number;
  productsCount: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface ProductRanking {
  productId: string;
  // 1-15D : produit supprimé définitivement → nom conservé (ou `null` si
  // aucun n'a pu l'être), stock `null`, bénéfice `null` si coût inconnu.
  productName: string | null;
  productDeleted: boolean;
  remainingQuantity: number | null;
  totalUnitsSold: number;
  totalRevenue: number;
  // 1-16E : absent sans droit financier.
  netProfit?: number | null;
  transactionCount: number;
}

export interface SellerRanking {
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  totalUnitsSold: number;
  totalRevenue: number;
  transactionCount: number;
}

// 1-16E — aide à la décision de la page Analyse (`/analytics/insights`).
export type SalesRateEstimate =
  | {
      estimable: true;
      observedDays: number;
      distinctSaleDays: number;
      unitsSold: number;
      dailyAverage: number;
      daysLeft: number | null;
    }
  | {
      estimable: false;
      reason: "insufficient_history" | "invalid_quantities";
      observedDays: number;
      distinctSaleDays: number;
      unitsSold: number;
    };

export interface InsightStockItem {
  productId: string;
  name: string;
  sectionId: string;
  remainingQuantity: number;
  /** Seuil personnalisé ; `null` : règle par défaut (absent : API antérieure). */
  lowStockThreshold?: number | null;
  estimate: SalesRateEstimate;
}

export interface InsightPriceItem {
  productId: string;
  name: string;
  sectionId: string;
  revenue: number;
  unitsSold: number;
  purchasePrice: number;
  gain: number;
}

export type InsightPriorityKind = "out" | "soon" | "price" | "low" | "stale";

// 1-16E : première page d'une liste ; `count` = total réel (priorité
// unique), la suite se lit par `fetchInsightList`.
export interface InsightList<T> {
  count: number;
  offset: number;
  limit: number;
  items: T[];
}

export type InsightListKind =
  "out" | "soon" | "price" | "low" | "stale" | "recent";

export interface InsightTotals {
  revenue: number;
  salesCount: number;
  unitsSold: number;
  // Absent sans droit financier ; `null` : coût inconnu (jamais 0).
  gain?: number | null;
}

export interface AnalyticsInsights {
  generatedAt: string;
  timeZone: string;
  rights: { financials: boolean };
  thresholds: {
    observationWindowDays: number;
    minObservationDays: number;
    minDistinctSaleDays: number;
    soonStockoutDays: number;
    listPageSize: number;
  };
  period: {
    month: string;
    start: string;
    end: string;
    inProgress: boolean;
    isCurrentMonth: boolean;
  };
  summary: InsightTotals;
  comparison:
    | {
        available: true;
        partial: boolean;
        month: string | null;
        start: string;
        end: string;
        totals: InsightTotals;
        revenueChange: number | null;
        salesCountChange: number | null;
        // Mois terminés seulement : durées réelles et rythme par jour.
        days?: number;
        previousDays?: number;
        revenuePerDayChange?: number | null;
        salesCountPerDayChange?: number | null;
      }
    | {
        available: false;
        reason: "before_creation" | "unequal_length" | null;
        start: string;
        end: string;
      };
  trend: Array<{ date: string; revenue: number; salesCount: number }>;
  topProducts: Array<{
    productId: string;
    name: string | null;
    productDeleted: boolean;
    revenue: number;
    unitsSold: number;
    remainingQuantity: number | null;
  }>;
  priorities: Array<
    | {
        kind: Exclude<InsightPriorityKind, "price">;
        count: number;
        items: InsightStockItem[];
      }
    | { kind: "price"; count: number; items: InsightPriceItem[] }
  >;
  stock: {
    window: { start: string; end: string; days: number };
    out: InsightList<InsightStockItem>;
    soon: InsightList<InsightStockItem>;
    low: InsightList<InsightStockItem>;
    stale: InsightList<InsightStockItem>;
    recent: InsightList<InsightStockItem>;
  };
  priceChecks?: InsightList<InsightPriceItem>;
}

export interface MonthlyTrend {
  period: string;
  totalRevenue: number;
  totalUnitsSold: number;
  transactionCount: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
});

// 1-11C.2 : un `Authorization` fourni explicitement (token capturé par le
// moteur de synchronisation) n'est JAMAIS remplacé par le token courant.
apiClient.interceptors.request.use((config) => {
  const token = getToken();
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // 1-16G : langue des messages d'erreur renvoyés par l'API (codes et
  // statuts inchangés). En-tête « simple » au sens CORS : aucune requête
  // préalable ajoutée. Jamais une préférence enregistrée côté serveur.
  config.headers["Accept-Language"] = currentLocale();
  return config;
});

// 1-11C.3 : notifié AVANT une déconnexion forcée (401 sur le token courant)
// — le moteur de synchronisation s'arrête, l'outbox est conservée, aucune
// modale bloquante.
let forcedLogoutListener: (() => void) | null = null;

export function setForcedLogoutListener(listener: (() => void) | null): void {
  forcedLogoutListener = listener;
}

// 1-14C.2 : notifié quand un appel fait avec le JWT applicatif COURANT est
// refusé commercialement (403 `SUBSCRIPTION_INACTIVE` ou
// `SUBSCRIPTION_ACCESS_LIMITED`). Le shell bascule alors sur l'écran de
// blocage : AUCUNE déconnexion, aucune suppression locale.
let subscriptionBlockedListener: (() => void) | null = null;

export function setSubscriptionBlockedListener(
  listener: (() => void) | null,
): void {
  subscriptionBlockedListener = listener;
}

export const SUBSCRIPTION_INACTIVE = "SUBSCRIPTION_INACTIVE";
export const SUBSCRIPTION_ACCESS_LIMITED = "SUBSCRIPTION_ACCESS_LIMITED";
export const SUBSCRIPTION_STATUS_UNAVAILABLE =
  "SUBSCRIPTION_STATUS_UNAVAILABLE";

/**
 * Suspension administrative du commerce (administration de la plateforme) :
 * refus DISTINCT, réservé aux membres actifs. Le message destiné au commerce
 * n'est fourni qu'au propriétaire. Jamais une erreur de saisie : les ventes
 * en attente restent sur l'appareil et repartent après réactivation.
 */
export const ORGANIZATION_SUSPENDED = "ORGANIZATION_SUSPENDED";

export interface OrganizationSuspendedView {
  organizationId: string;
  organizationName: string;
  suspendedAt: string | null;
  isOwner: boolean;
  message: string | null;
}

export function readOrganizationSuspended(
  err: unknown,
): OrganizationSuspendedView | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 403) return null;
  const data = err.response.data as
    | { code?: unknown; suspension?: Partial<OrganizationSuspendedView> }
    | undefined;
  if (data?.code !== ORGANIZATION_SUSPENDED) return null;
  const s = data.suspension ?? {};
  return {
    organizationId:
      typeof s.organizationId === "string" ? s.organizationId : "",
    organizationName:
      typeof s.organizationName === "string" ? s.organizationName : "",
    suspendedAt: typeof s.suspendedAt === "string" ? s.suspendedAt : null,
    isOwner: s.isOwner === true,
    message: typeof s.message === "string" ? s.message : null,
  };
}

let organizationSuspendedListener: (() => void) | null = null;

export function setOrganizationSuspendedListener(
  listener: (() => void) | null,
): void {
  organizationSuspendedListener = listener;
}

/** Refus COMMERCIAL (abonnement inactif ou session limitée). */
export function isCommercialRefusalCode(code: unknown): boolean {
  return code === SUBSCRIPTION_INACTIVE || code === SUBSCRIPTION_ACCESS_LIMITED;
}

function bearerOf(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : null;
}

apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !error.config?.url?.startsWith("/auth/") &&
      // 1-11C.2 : un 401 obtenu avec un token qui n'est PLUS le token courant
      // (switch/login entre-temps) ne doit jamais déconnecter la session
      // actuelle.
      bearerOf(error.config?.headers?.Authorization) === getToken()
    ) {
      forcedLogoutListener?.();
      clearAuth();
      if (typeof window !== "undefined") {
        window.location.replace("/auth/login");
      }
    }
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      isCommercialRefusalCode(
        (error.response.data as { code?: unknown } | undefined)?.code,
      ) &&
      !error.config?.url?.startsWith("/auth/") &&
      // Jamais pour un ancien token ou un jeton limité explicite.
      bearerOf(error.config?.headers?.Authorization) === getToken()
    ) {
      subscriptionBlockedListener?.();
    }
    // Suspension du commerce courant : le shell relit le contexte et
    // affiche l'écran de suspension (aucune déconnexion, rien d'effacé).
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      (error.response.data as { code?: unknown } | undefined)?.code ===
        ORGANIZATION_SUSPENDED &&
      !error.config?.url?.startsWith("/auth/") &&
      bearerOf(error.config?.headers?.Authorization) === getToken()
    ) {
      organizationSuspendedListener?.();
    }
    return Promise.reject(error);
  },
);

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface SelectableOrganization {
  organizationId: string;
  name: string;
}

export type LoginResponse =
  | { access_token: string; user: ApiUser }
  | {
      organizationSelectionRequired: true;
      organizations: SelectableOrganization[];
      /** Commerces suspendus (membership active) : espace limité seulement. */
      suspendedOrganizations?: SelectableOrganization[];
    };

export async function authLogin(payload: {
  email: string;
  password: string;
  organizationId?: string;
  /** 1-18C : défi de récupération (plafond par compte atteint). */
  challengeToken?: string;
}): Promise<LoginResponse> {
  const { data } = await apiClient.post("/auth/login", payload);
  return data;
}

// 1-6A : inscription propriétaire — aucun token renvoyé (le compte doit
// ensuite confirmer son adresse, 1-13A, puis se connecter via /auth/login).

export async function authRegister(payload: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  /** 1-16C.2 : documents affichés et acceptés (le serveur fait foi). */
  legalAcceptance: LegalAcceptancePayload;
  /** Case facultative des e-mails promotionnels, distincte des conditions. */
  marketingEmailConsent: MarketingConsentPayload;
  /** 1-18C : jeton Turnstile (usage unique, vérifié par l'API). */
  turnstileToken: string;
}): Promise<void> {
  // 1-18E : réponse neutre (202) identique, que l'adresse ait déjà un compte
  // ou non ; son contenu n'est pas lu (aucun identifiant n'est renvoyé).
  await apiClient.post("/auth/register", payload);
}

// 1-18B — Invitations. Le lien remis au créateur ne prouve ni l'identité
// de son détenteur ni le contrôle de l'adresse invitée :
// - compte existant : session de CE compte (jeton applicatif ou limité,
//   passé explicitement) et accord explicite ;
// - nouveau compte : lien de création envoyé à l'adresse invitée.
export interface InvitationPreview {
  organization: { name: string };
  role: "admin" | "seller";
}

export interface InvitationAcceptance {
  organization: { _id: string; name: string; slug: string };
  membership: { role: string; status: string };
}

export interface InvitationAccountResult {
  user: { email: string };
  organization: { name: string };
}

const bearer = (sessionToken: string) => ({
  headers: { Authorization: `Bearer ${sessionToken}` },
});

/** Aperçu (organisation, rôle) pour la session ; aucune écriture. */
export async function inspectInvitation(
  token: string,
  sessionToken: string,
): Promise<InvitationPreview> {
  const { data } = await apiClient.post(
    "/auth/invitations/inspect",
    { token },
    bearer(sessionToken),
  );
  return data;
}

/** Rattachement du compte de la session, après accord explicite. */
export async function acceptInvitation(
  token: string,
  sessionToken: string,
): Promise<InvitationAcceptance> {
  const { data } = await apiClient.post(
    "/auth/invitations/accept",
    { token, consent: true },
    bearer(sessionToken),
  );
  return data;
}

/**
 * Compte existant SANS organisation active (aucune session possible) :
 * preuve par les identifiants, même vérification et même limitation que la
 * connexion. Aucun jeton n'est renvoyé ; la connexion se fait ensuite.
 */
export async function inspectInvitationWithCredentials(
  token: string,
  email: string,
  password: string,
  challengeToken?: string,
): Promise<InvitationPreview> {
  const { data } = await apiClient.post(
    "/auth/invitations/credentials/inspect",
    { token, email, password, ...(challengeToken ? { challengeToken } : {}) },
  );
  return data;
}

export async function acceptInvitationWithCredentials(
  token: string,
  email: string,
  password: string,
  challengeToken?: string,
): Promise<InvitationAcceptance> {
  const { data } = await apiClient.post(
    "/auth/invitations/credentials/accept",
    {
      token,
      email,
      password,
      consent: true,
      ...(challengeToken ? { challengeToken } : {}),
    },
  );
  return data;
}

/** Demande du lien de création : réponse neutre (202) dans tous les cas. */
export async function requestInvitationAccountLink(
  token: string,
): Promise<void> {
  await apiClient.post("/auth/invitations/account-link", { token });
}

/** Création du compte depuis le lien reçu par e-mail (aucun JWT renvoyé). */
export async function createInvitationAccount(payload: {
  token: string;
  name: string;
  password: string;
  legalAcceptance: LegalAcceptancePayload;
}): Promise<InvitationAccountResult> {
  const { data } = await apiClient.post(
    "/auth/invitations/create-account",
    payload,
  );
  return data;
}

// 1-13A : (ré)envoi du lien de vérification — réponse neutre (202) quelle
// que soit l'adresse ; 429 (limitation) ou 503 (envoi indisponible) sinon.
// 1-18D : jeton Turnstile (action `email-verification`), à usage unique.
export async function requestEmailVerification(
  email: string,
  turnstileToken: string,
): Promise<void> {
  await apiClient.post("/auth/email-verification/request", {
    email,
    turnstileToken,
  });
}

// 1-13A : confirmation explicite (POST) — aucun JWT renvoyé, aucune session
// ouverte ou modifiée.
export async function confirmEmailVerification(token: string): Promise<void> {
  await apiClient.post("/auth/email-verification/confirm", { token });
}

// 1-13B : demande de réinitialisation — réponse neutre (202) pour toute
// adresse ; 429 (limitation) ou 503 (envoi indisponible) sinon.
// 1-18D : jeton Turnstile (action `password-reset`), à usage unique.
export async function requestPasswordReset(
  email: string,
  turnstileToken: string,
): Promise<void> {
  await apiClient.post("/auth/password-reset/request", {
    email,
    turnstileToken,
  });
}

// 1-13B : nouveau mot de passe (jamais trimé) — aucun JWT renvoyé, aucune
// session ouverte ou modifiée ; les anciennes sessions sont révoquées.
export async function confirmPasswordReset(
  token: string,
  password: string,
): Promise<void> {
  await apiClient.post("/auth/password-reset/confirm", { token, password });
}

// 1-16G : langue du compte (e-mails et notifications push). Aucune autre
// donnée modifiée ; refus sans effet (réessayé à la session suivante).
export async function updateAccountLocale(
  locale: "fr" | "en",
  token: string,
): Promise<void> {
  await apiClient.put(
    "/auth/me/locale",
    { locale },
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

export async function fetchMe(token?: string): Promise<ApiUser> {
  const { data } = await apiClient.get<ApiUser>(
    "/auth/me",
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  );
  return data;
}

// 1-9B : organisations actives de l'utilisateur courant (userId depuis le
// JWT côté serveur). 1-12A : ne sert plus qu'à détecter « aucune
// organisation active » dans le shell (plus de sélecteur de switch).
export async function fetchActiveOrganizations(
  token?: string,
): Promise<SelectableOrganization[]> {
  const { data } = await apiClient.get<SelectableOrganization[]>(
    "/auth/organizations",
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  );
  return data;
}

export async function switchOrganization(
  organizationId: string,
): Promise<{ access_token: string }> {
  const { data } = await apiClient.post<{ access_token: string }>(
    "/auth/switch-organization",
    { organizationId },
  );
  return data;
}

// Vue `GET /organizations/current` (1-8A) consommée par le shell /app.
export interface ApiOrganizationCurrent {
  _id: string;
  name: string;
  slug: string;
  brandColor: string;
  currency: string;
  status: string;
  logoUrl: string | null;
}

export async function fetchCurrentOrganization(): Promise<ApiOrganizationCurrent> {
  const { data } = await apiClient.get<ApiOrganizationCurrent>(
    "/organizations/current",
  );
  return data;
}

// PATCH /organizations/current/branding (1-8A, multipart) — `branding.manage`.
export async function updateOrganizationBranding(payload: {
  name?: string;
  brandColor?: string;
  logo?: File;
}): Promise<ApiOrganizationCurrent & { storageCleanup?: StorageCleanup }> {
  const form = new FormData();
  if (payload.name !== undefined) form.append("name", payload.name);
  if (payload.brandColor !== undefined)
    form.append("brandColor", payload.brandColor);
  if (payload.logo) form.append("logo", payload.logo);
  const { data } = await apiClient.patch<
    ApiOrganizationCurrent & { storageCleanup?: StorageCleanup }
  >("/organizations/current/branding", form);
  return data;
}

// DELETE /organizations/current/logo (1-8A) — `branding.manage`.
export async function removeOrganizationLogo(): Promise<
  ApiOrganizationCurrent & { storageCleanup?: StorageCleanup }
> {
  const { data } = await apiClient.delete<
    ApiOrganizationCurrent & { storageCleanup?: StorageCleanup }
  >("/organizations/current/logo");
  return data;
}

// ─── Contexte d'autorisation (1-9C) ──────────────────────────────────────────
// GET /auth/context — source unique et fiable de role/permissions/userId de
// la membership courante ; jamais `ApiUser.role` (legacy) ni un décodage JWT
// côté client pour décider des droits.
export type ApiSubscriptionState = "active" | "expired" | "none" | "scheduled";

// 1-14C.1 — état d'accès commercial calculé par le serveur. Un 200 sur
// `/auth/context` ne signifie PAS que le commerce est accessible :
// seul `applicationAccess` l'indique ; la saisie de ventes dépend de
// `canRecordSales` (faux dès que l'accès est bloqué).
export interface ApiAccessView {
  subscriptionState: ApiSubscriptionState;
  applicationAccess: boolean;
  coverageEndsAt: string | null;
  checkedAt: string;
  canRenew: boolean;
  tokenScope?: "app" | "subscription_limited";
  canRecordSales?: boolean;
}

export interface ApiAuthContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  permissions: DelegablePermission[];
  effectivePermissions: DelegablePermission[];
  // Fonctionnalités activées par le SERVEUR (autorité : l'API). Absent (API
  // antérieure) : aucune fonctionnalité optionnelle affichée.
  features?: { productBatches?: boolean; expiryAlerts?: boolean };
  // Absent (API antérieure) → traité comme bloqué (fail-closed).
  access?: ApiAccessView;
}

/** Suivi par lots annoncé par l'API (désactivé par défaut). */
export function productBatchesEnabled(
  context: Pick<ApiAuthContext, "features"> | null | undefined,
): boolean {
  return context?.features?.productBatches === true;
}

/** En-tête explicite : jamais remplacé par l'intercepteur (jeton limité). */
const explicitBearer = (token?: string) =>
  token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;

export async function fetchAuthContext(
  token?: string,
): Promise<ApiAuthContext> {
  const { data } = await apiClient.get<ApiAuthContext>(
    "/auth/context",
    explicitBearer(token),
  );
  return data;
}

/** Accès applicatif ouvert selon le contexte serveur (fail-closed). */
export function hasApplicationAccess(context: ApiAuthContext | null): boolean {
  return (
    context?.access?.applicationAccess === true &&
    context.access.tokenScope !== "subscription_limited"
  );
}

/** Saisie de ventes autorisée selon le contexte serveur (fail-closed). */
export function canRecordSalesFromContext(
  context: ApiAuthContext | null,
): boolean {
  return (
    hasApplicationAccess(context) && context?.access?.canRecordSales === true
  );
}

// ─── Abonnement (1-14B/1-14C) ────────────────────────────────────────────────

export interface ApiSubscriptionPeriod {
  kind: "trial" | "subscription";
  term: "monthly" | "quarterly" | "semiannual" | "annual" | null;
  /** Prolongation offerte par Stock Master (aucun paiement). */
  offered?: boolean;
  startsAt: string;
  endsAt: string;
}

export interface ApiSubscription {
  state: ApiSubscriptionState;
  currentPeriod: ApiSubscriptionPeriod | null;
  coverageEndsAt: string | null;
  nextPeriodStartsAt: string | null;
  /** Historique des PÉRIODES (pas des paiements), plus récente d'abord. */
  periods: ApiSubscriptionPeriod[];
}

// GET /organizations/current/subscription — propriétaire réel uniquement.
export async function fetchSubscription(
  token?: string,
): Promise<ApiSubscription> {
  const { data } = await apiClient.get<ApiSubscription>(
    "/organizations/current/subscription",
    explicitBearer(token),
  );
  return data;
}

// POST /auth/subscription-access/complete — jeton LIMITÉ uniquement, corps
// vide : délivre un JWT applicatif si l'abonnement est actif.
export async function completeSubscriptionAccess(
  restrictedToken: string,
): Promise<{ access_token: string }> {
  const { data } = await apiClient.post<{ access_token: string }>(
    "/auth/subscription-access/complete",
    undefined,
    explicitBearer(restrictedToken),
  );
  return data;
}

/** Corps d'un 403 `SUBSCRIPTION_INACTIVE` (login/switch), sinon `null`. */
export function readSubscriptionInactive(
  error: unknown,
): { restrictedToken: string | null; access: ApiAccessView | null } | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 403) {
    return null;
  }
  const body = error.response.data as
    { code?: unknown; restrictedToken?: unknown; access?: unknown } | undefined;
  if (body?.code !== SUBSCRIPTION_INACTIVE) return null;
  return {
    restrictedToken:
      typeof body.restrictedToken === "string" ? body.restrictedToken : null,
    access:
      typeof body.access === "object" && body.access !== null
        ? (body.access as ApiAccessView)
        : null,
  };
}

// ─── Membres (1-7C) ──────────────────────────────────────────────────────────

export interface ApiMember {
  membershipId: string;
  user: { _id: string; name: string; email: string };
  role: OrganizationRole;
  permissions: DelegablePermission[];
  status: "active" | "suspended" | "revoked";
  joinedAt: string;
}

// GET /organizations/members — `members.manage`.
export async function fetchMembers(): Promise<ApiMember[]> {
  const { data } = await apiClient.get<ApiMember[]>("/organizations/members");
  return data;
}

// PATCH /organizations/members/:id — `members.manage`. Jamais `owner` en
// `role` (rejeté par le backend) ; au moins un champ requis.
export async function updateMember(
  membershipId: string,
  payload: {
    role?: "admin" | "seller";
    permissions?: DelegablePermission[];
    status?: "active" | "suspended" | "revoked";
  },
  // Catalogue des permissions AFFICHÉES par le formulaire (voir
  // `permissionCatalogFor`) ; défaut prudent : sans le suivi par lots.
  permissionsCatalog: number = permissionCatalogFor(undefined),
): Promise<ApiMember> {
  const { data } = await apiClient.patch<ApiMember>(
    `/organizations/members/${membershipId}`,
    payload,
    // 1-19A : catalogue de permissions connu de ce formulaire. Paramètre de
    // requête (jamais un champ du corps ni un en-tête) : une API antérieure
    // l'ignore, et une permission inconnue de ce web n'est jamais retirée.
    { params: { permissionsCatalog } },
  );
  return data;
}

// POST /organizations/members/:id/transfer-ownership — `@OwnerOnly` : le
// rôle `owner` STRICT (jamais via `permissions`) est seul autorisé.
export async function transferOwnership(
  membershipId: string,
): Promise<{ previousOwner: ApiMember; newOwner: ApiMember }> {
  const { data } = await apiClient.post<{
    previousOwner: ApiMember;
    newOwner: ApiMember;
  }>(`/organizations/members/${membershipId}/transfer-ownership`);
  return data;
}

// ─── Invitations (1-6B.1) ────────────────────────────────────────────────────

export interface ApiInvitation {
  _id: string;
  email: string;
  role: OrganizationRole;
  permissions: DelegablePermission[];
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
}

// GET /organizations/invitations — `members.invite`.
export async function fetchInvitations(): Promise<ApiInvitation[]> {
  const { data } = await apiClient.get<ApiInvitation[]>(
    "/organizations/invitations",
  );
  return data;
}

// POST /organizations/invitations — `members.invite`. 1-12G : aucun email
// envoyé ; `invitationUrl` (construit par l'API depuis PUBLIC_APP_URL) porte
// le jeton brut, renvoyé UNE SEULE fois : jamais persisté ni journalisé côté
// appelant (aucun stockage local/session, aucun log), jamais relisible via
// la liste.
export interface CreatedInvitation {
  invitation: ApiInvitation;
  invitationUrl: string;
}

export async function createInvitation(payload: {
  email: string;
  role: "admin" | "seller";
  permissions?: DelegablePermission[];
}): Promise<CreatedInvitation> {
  const { data } = await apiClient.post<CreatedInvitation>(
    "/organizations/invitations",
    payload,
  );
  return data;
}

// POST /organizations/invitations/:id/revoke — `members.invite`.
export async function revokeInvitation(id: string): Promise<ApiInvitation> {
  const { data } = await apiClient.post<ApiInvitation>(
    `/organizations/invitations/${id}/revoke`,
  );
  return data;
}

// ─── Sections ────────────────────────────────────────────────────────────────

export async function fetchSections(parentId?: string): Promise<ApiSection[]> {
  const params = parentId ? { parentId } : {};
  const { data } = await apiClient.get<ApiSection[]>("/sections", { params });
  return data;
}

export async function fetchSection(id: string): Promise<ApiSection> {
  const { data } = await apiClient.get<ApiSection>(`/sections/${id}`);
  return data;
}

export async function createSection(payload: {
  name: string;
  description?: string;
  parentId?: string;
}): Promise<ApiSection> {
  const { data } = await apiClient.post<ApiSection>("/sections", payload);
  return data;
}

export async function updateSection(
  id: string,
  payload: { name?: string; description?: string },
): Promise<ApiSection> {
  const { data } = await apiClient.patch<ApiSection>(
    `/sections/${id}`,
    payload,
  );
  return data;
}

export async function deleteSection(id: string): Promise<void> {
  await apiClient.delete(`/sections/${id}`);
}

// ─── Products ────────────────────────────────────────────────────────────────

export async function fetchProducts(sectionId?: string): Promise<ApiProduct[]> {
  const { data } = await apiClient.get<ApiProductEnvelope[]>("/products", {
    params: sectionId ? { sectionId } : {},
  });
  return data.map(flattenProduct);
}

/**
 * 1-20D — Relecture ciblée : mêmes produits que `fetchProducts` (même
 * rayon, même projection selon les permissions), restreints à `ids`. Une API
 * antérieure ignore `ids` et renvoie la liste complète : seuls les produits
 * demandés sont alors retenus (résultat correct, coût d'une liste complète).
 */
export async function fetchProductsByIds(
  ids: readonly string[],
  sectionId?: string,
): Promise<ApiProduct[]> {
  const { data } = await apiClient.get<ApiProductEnvelope[]>("/products", {
    params: { ids: ids.join(","), ...(sectionId ? { sectionId } : {}) },
  });
  const wanted = new Set(ids);
  return data.map(flattenProduct).filter((p) => wanted.has(p._id));
}

/** 1-20F — Produits par page de la liste d'un rayon (maximum serveur : 100). */
export const PRODUCTS_PAGE_SIZE = 24;

/**
 * 1-20F — Une page de la liste (`GET /products?limit=…`) : `total` porte sur
 * tout le périmètre de la vue (rayon et recherche), `scopeTotal` sur tout le
 * rayon sans la recherche, jamais sur la page. `legacy` : API antérieure, qui
 * ignore `limit` et renvoie le tableau COMPLET du rayon → recherche appliquée
 * ici avec la même règle, résultat complet présenté comme tel (aucune page
 * suivante, totaux exacts).
 */
export interface ProductsPage {
  items: ApiProduct[];
  total: number;
  scopeTotal: number;
  nextCursor: string | null;
  legacy: boolean;
}

export async function fetchProductsPage(options: {
  sectionId?: string;
  cursor?: string | null;
  query?: string;
  limit?: number;
}): Promise<ProductsPage> {
  const query = options.query ?? "";
  const { data } = await apiClient.get<
    | ApiProductEnvelope[]
    | {
        items: ApiProductEnvelope[];
        total: number;
        scopeTotal: number;
        nextCursor: string | null;
      }
  >("/products", {
    params: {
      limit: options.limit ?? PRODUCTS_PAGE_SIZE,
      ...(options.sectionId ? { sectionId: options.sectionId } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(isProductSearch(query) ? { q: query } : {}),
    },
  });
  if (Array.isArray(data)) {
    const all = data.map(flattenProduct);
    const items = all.filter((p) => matchesProductSearch(p.name, query));
    return {
      items,
      total: items.length,
      scopeTotal: all.length,
      nextCursor: null,
      legacy: true,
    };
  }
  return {
    items: data.items.map(flattenProduct),
    total: data.total,
    scopeTotal: data.scopeTotal,
    nextCursor: data.nextCursor,
    legacy: false,
  };
}

export async function fetchProduct(id: string): Promise<ApiProductDetail> {
  const { data } = await apiClient.get<
    ApiProductEnvelope & { sales: ApiSale[]; auditLogs: ApiAuditLog[] }
  >(`/products/${id}`);
  const { sales, auditLogs, ...envelope } = data;
  return { ...flattenProduct(envelope), sales, auditLogs };
}

/** Diffusion `product:updated` : enveloppe standard (1-12H). */
export function flattenProductEvent(data: ApiProductEnvelope): ApiProduct {
  return flattenProduct(data);
}

/**
 * 1-21D — capacité incluse : fiches conservées (corbeille comprise) et
 * plafond, décomptés par le SERVEUR (jamais la longueur d'une page).
 * Réservée à la gestion des produits (`products.manage`).
 */
export interface ProductCapacity {
  used: number;
  trashed: number;
  limit: number;
}

export async function fetchProductCapacity(): Promise<ProductCapacity> {
  const { data } = await apiClient.get<ProductCapacity>("/products/capacity");
  return data;
}

export interface CreateProductPayload {
  sectionId: string;
  name: string;
  purchasePrice: number;
  salePrice: number;
  initialQuantity: number;
  image: File;
  // Facultatifs : envoyés seulement s'ils sont renseignés (droits propres
  // `products.manage_expiry` / `stock.manage_thresholds`, contrôlés par l'API).
  expiryDate?: string;
  lowStockThreshold?: number;
}

export async function createProduct(
  payload: CreateProductPayload,
): Promise<ApiProduct> {
  const form = new FormData();
  form.append("sectionId", payload.sectionId);
  form.append("name", payload.name);
  form.append("purchasePrice", String(payload.purchasePrice));
  form.append("salePrice", String(payload.salePrice));
  form.append("initialQuantity", String(payload.initialQuantity));
  if (payload.expiryDate !== undefined) {
    form.append("expiryDate", payload.expiryDate);
  }
  if (payload.lowStockThreshold !== undefined) {
    form.append("lowStockThreshold", String(payload.lowStockThreshold));
  }
  form.append("image", payload.image);
  // Réponse : produit projeté plat, sans métriques (statut non calculé ici).
  const { data } = await apiClient.post<Omit<ApiProduct, "status">>(
    "/products",
    form,
  );
  return { ...data, status: "in_stock" };
}

export interface UpdateProductPayload {
  name?: string;
  purchasePrice?: number;
  salePrice?: number;
  additionalStock?: number;
  sectionId?: string;
  // `null` : date retirée / retour à la règle par défaut. Envoyés seulement
  // en cas de changement (droits propres contrôlés par l'API).
  expiryDate?: string | null;
  lowStockThreshold?: number | null;
  // 1-17B : ajout ou remplacement de la photo (`products.manage`, contrôlé
  // côté API) ; envoi multipart, jamais hors connexion.
  image?: File;
}

export async function updateProduct(
  id: string,
  payload: UpdateProductPayload,
): Promise<ApiProduct & { storageCleanup?: StorageCleanup }> {
  const { image, ...fields } = payload;
  let body: UpdateProductPayload | FormData = fields;
  if (image) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      // Multipart : chaîne vide = effacement (jamais le texte « null »).
      if (value === null) form.append(key, "");
      else if (value !== undefined) form.append(key, String(value));
    }
    form.append("image", image);
    body = form;
  }
  const { data } = await apiClient.patch<
    ApiProductEnvelope & { storageCleanup?: StorageCleanup }
  >(`/products/${id}`, body);
  const { storageCleanup, ...envelope } = data;
  const product = flattenProduct(envelope);
  return storageCleanup ? { ...product, storageCleanup } : product;
}

// ─── Lots de produits (lot A) ────────────────────────────────────────────────

export type ApiBatchExpiryState = "unknown" | "valid" | "expired";

export interface ApiProductBatch {
  _id: string;
  /** Référence interne lisible attribuée par le serveur (`L-001`). */
  reference: string;
  manufacturerLot: string | null;
  /** Dates civiles `AAAA-MM-JJ` ; `null` : inconnue. */
  receivedOn: string | null;
  expiryDate: string | null;
  /** Calculé par le serveur selon le jour du commerce (jamais l'appareil). */
  expiryState: ApiBatchExpiryState;
  status: "available" | "quarantined" | "withdrawn";
  origin: "opening" | "reception";
  createdAt?: string;
  /** Absent sans `products.view_stock_details`. */
  remainingQuantity?: number;
  /** Lot B — vendable aujourd'hui (jour du commerce). */
  sellable?: boolean;
  /** Lot C — dernier changement de statut (motif, date serveur). */
  statusChange?: { from: string; to: string; reason: string; at: string };
}

export interface ApiProductBatches {
  productId: string;
  productName: string;
  stockTracking: "none" | "batches";
  businessDate: string;
  timeZone: string;
  nextExpiryDate: string | null;
  hasUnknownExpiry: boolean;
  legacyExpiryDate: string | null;
  batches: ApiProductBatch[];
  totalQuantity?: number;
  /** Lot B — unités vendables / dépassées (stock détaillé). */
  sellableQuantity?: number;
  expiredQuantity?: number;
  /** Lot C — mis à l'écart (toute date), retirés, pertes nettes. */
  quarantinedQuantity?: number;
  withdrawnQuantity?: number;
  lostQuantity?: number;
}

export interface ApiBatchOperationResult extends ApiProductBatches {
  batchId?: string;
  replayed: boolean;
  changed: boolean;
}

export interface BatchIdentityPayload {
  quantity: number;
  manufacturerLot?: string | null;
  expiryDate?: string | null;
  receivedOn?: string | null;
}

// GET /products/:id/batches — tout membre ; quantités selon les droits.
export async function fetchProductBatches(
  productId: string,
): Promise<ApiProductBatches> {
  const { data } = await apiClient.get<ApiProductBatches>(
    `/products/${productId}/batches`,
  );
  return data;
}

// POST /products/:id/batch-tracking — reprise du stock existant
// (`stock.manage_batches`). `clientOperationId` : stable pour une même
// validation (une relance ne répartit jamais deux fois).
export async function enableBatchTracking(
  productId: string,
  payload: {
    clientOperationId: string;
    expectedRemainingQuantity: number;
    batches: BatchIdentityPayload[];
  },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/batch-tracking`,
    payload,
  );
  return data;
}

// POST /products/:id/batches — réception dans un NOUVEAU lot.
export async function receiveNewBatch(
  productId: string,
  payload: BatchIdentityPayload & { clientOperationId: string },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/batches`,
    payload,
  );
  return data;
}

// POST /products/:id/batches/:batchId/receptions — quantité seule.
export async function receiveIntoBatch(
  productId: string,
  batchId: string,
  payload: { quantity: number; clientOperationId: string },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/batches/${batchId}/receptions`,
    payload,
  );
  return data;
}

// PATCH /products/:id/batches/:batchId — identité seule (jamais de quantité).
export async function updateProductBatch(
  productId: string,
  batchId: string,
  payload: {
    manufacturerLot?: string | null;
    expiryDate?: string | null;
    receivedOn?: string | null;
  },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.patch<ApiBatchOperationResult>(
    `/products/${productId}/batches/${batchId}`,
    payload,
  );
  return data;
}

// ─── Lot B : vente par lots ──────────────────────────────────────────────────

export interface ApiSaleBatchOption extends ApiSaleBatchSummary {
  receivedOn: string | null;
  expiresToday: boolean;
  /** Seulement avec `products.view_stock_details`. */
  remainingQuantity?: number;
}

export interface ApiSaleBatchOptions {
  productId: string;
  businessDate: string;
  timeZone: string;
  quantity: number;
  dated: ApiSaleBatchOption[];
  undated: ApiSaleBatchOption[];
  excludedExpiredBatches: number;
  suggestion: BatchQuantityEntry[];
  uncovered: number;
}

export interface BatchQuantityEntry {
  batchId: string;
  quantity: number;
}

// GET /products/:id/batches/sale-options — droits de vente ; suggestion FEFO
// plafonnée à `quantity`, jamais une réservation.
export async function fetchSaleBatchOptions(
  productId: string,
  quantity: number,
): Promise<ApiSaleBatchOptions> {
  const { data } = await apiClient.get<ApiSaleBatchOptions>(
    `/products/${productId}/batches/sale-options`,
    { params: { quantity } },
  );
  return data;
}

/** Restitution d'unités d'origine inconnue (vente antérieure aux lots). */
export interface LegacyRestitutionPayload {
  restitutions?: BatchQuantityEntry[];
  historicalRestitution?: { quantity: number; confirmed: true };
  restitutionReason?: string;
}

// ─── Lot B : régularisation par un responsable ────────────────────────────────

export interface ApiSaleRegularization {
  _id: string;
  clientOperationId: string;
  sellerId: { _id: string; name: string; email: string } | string;
  productId: string;
  productName: string;
  quantity: number;
  salePrice: number;
  buyerName: string | null;
  buyerContact: string | null;
  /** Heure DÉCLARÉE par l'appareil du vendeur (non vérifiée). */
  declaredOccurredAt: string;
  /** Réception de la demande par le serveur. */
  createdAt: string;
  batchAllocations: {
    batchId: string;
    reference: string;
    expiryDate: string | null;
    quantity: number;
  }[];
  expiredReferences: string[];
  status: "pending" | "approved" | "rejected";
  decidedBy: { _id: string; name: string; email: string } | string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  saleId: string | null;
}

// POST /sales/regularizations — l'opération en attente TELLE QUELLE.
export async function requestSaleRegularization(
  payload: IdempotentSalePayload & { clientOperationId: string },
): Promise<ApiSaleRegularization> {
  const { data } = await apiClient.post<ApiSaleRegularization>(
    "/sales/regularizations",
    payload,
  );
  return data;
}

export async function fetchSaleRegularizations(params: {
  clientOperationIds?: string[];
  status?: ApiSaleRegularization["status"];
}): Promise<ApiSaleRegularization[]> {
  const { data } = await apiClient.get<ApiSaleRegularization[]>(
    "/sales/regularizations",
    {
      params: {
        ...(params.clientOperationIds?.length
          ? { clientOperationIds: params.clientOperationIds.join(",") }
          : {}),
        ...(params.status ? { status: params.status } : {}),
      },
    },
  );
  return data;
}

export async function decideSaleRegularization(
  id: string,
  decision: "approve" | "reject",
  reason: string,
): Promise<ApiSaleRegularization> {
  const { data } = await apiClient.post<ApiSaleRegularization>(
    `/sales/regularizations/${id}/${decision}`,
    { reason },
  );
  return data;
}

// ─── Lot C : mise à l'écart, pertes, péremption ──────────────────────────────

export type ApiLossReason = "expired" | "damaged" | "other";

export interface ApiStockLoss {
  _id: string;
  batchId: string;
  batchReference: string;
  kind: "loss" | "correction";
  quantity: number;
  reason: ApiLossReason | null;
  comment: string | null;
  actorId: { _id: string; name: string } | string;
  correctsLossId: string | null;
  correctedQuantity: number;
  statusBefore: string;
  statusAfter: string;
  createdAt: string;
  /** Seulement avec `products.view_financials`. */
  unitCostAtMovement?: number;
  valueAtCost?: number;
}

export async function changeBatchStatus(
  productId: string,
  batchId: string,
  action: "quarantine" | "release",
  reason: string,
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/batches/${batchId}/${action}`,
    { reason },
  );
  return data;
}

export async function recordBatchLoss(
  productId: string,
  batchId: string,
  payload: {
    clientOperationId: string;
    quantity: number;
    reason: ApiLossReason;
    comment?: string;
  },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/batches/${batchId}/losses`,
    payload,
  );
  return data;
}

export async function correctBatchLoss(
  productId: string,
  lossId: string,
  payload: { clientOperationId: string; quantity: number; comment: string },
): Promise<ApiBatchOperationResult> {
  const { data } = await apiClient.post<ApiBatchOperationResult>(
    `/products/${productId}/losses/${lossId}/corrections`,
    payload,
  );
  return data;
}

export async function fetchProductLosses(
  productId: string,
): Promise<ApiStockLoss[]> {
  const { data } = await apiClient.get<ApiStockLoss[]>(
    `/products/${productId}/losses`,
  );
  return data;
}

export interface ApiExpirySettings {
  enabled: boolean;
  leadDays: number;
}

export async function fetchExpirySettings(): Promise<ApiExpirySettings> {
  const { data } = await apiClient.get<ApiExpirySettings>(
    "/expiry-alerts/settings",
  );
  return data;
}

export async function updateExpirySettings(
  leadDays: number,
): Promise<ApiExpirySettings> {
  const { data } = await apiClient.patch<ApiExpirySettings>(
    "/expiry-alerts/settings",
    { leadDays },
  );
  return data;
}

export interface ApiStockHealthItem {
  kind: "batch" | "product";
  productId: string;
  productName: string;
  batchId?: string;
  reference?: string;
  expiryDate: string;
  status?: string;
  quantity?: number;
}

export interface ApiStockHealth {
  businessDate: string;
  timeZone: string;
  leadDays: number;
  alertsEnabled: boolean;
  soon: ApiStockHealthItem[];
  soonTotal: number;
  expired: ApiStockHealthItem[];
  expiredTotal: number;
  losses: { month: string; lostQuantity?: number; lossValueAtCost?: number };
}

export async function fetchStockHealth(
  month?: string,
): Promise<ApiStockHealth> {
  const { data } = await apiClient.get<ApiStockHealth>(
    "/analytics/stock-health",
    { params: month ? { month } : {} },
  );
  return data;
}

// ─── Stockage (1-17B) ────────────────────────────────────────────────────────

/** Occupation de l'organisation courante (jamais de clé ni d'URL). */
export interface ApiStorageUsage {
  limitBytes: number;
  usedBytes: number;
  storedObjects: number;
  reservedBytes: number;
  pendingUploads: number;
  availableBytes: number;
  enforced: boolean;
}

// GET /organizations/current/storage — `products.manage`, `branding.manage`
// ou `trash.manage` (contrôlé côté API).
export async function fetchStorageUsage(): Promise<ApiStorageUsage> {
  const { data } = await apiClient.get<ApiStorageUsage>(
    "/organizations/current/storage",
  );
  return data;
}

export async function deleteProduct(id: string): Promise<void> {
  await apiClient.delete(`/products/${id}`);
}

// ─── Trash ───────────────────────────────────────────────────────────────────

export interface ApiTrashedSection extends ApiSection {
  deletedAt: string;
}
export interface ApiTrashedProduct {
  _id: string;
  sectionId: string;
  name: string;
  imageUrl: string | null;
  salePrice: number;
  remainingQuantity: number;
  // 1-12H : présents seulement avec la permission correspondante.
  purchasePrice?: number;
  initialQuantity?: number;
  deletedAt: string;
  createdAt: string;
}

export async function fetchTrash(): Promise<{
  sections: ApiTrashedSection[];
  products: ApiTrashedProduct[];
}> {
  const { data } = await apiClient.get("/trash");
  return data;
}

export async function restoreSection(id: string): Promise<ApiSection> {
  const { data } = await apiClient.patch<ApiSection>(`/sections/${id}/restore`);
  return data;
}

export async function permanentDeleteSection(id: string): Promise<void> {
  await apiClient.delete(`/sections/${id}/permanent`);
}

export async function restoreProduct(id: string): Promise<void> {
  await apiClient.patch(`/products/${id}/restore`);
}

/**
 * Sort du fichier (photo, logo) après l'écriture : `failed` = fichier non
 * effacé du stockage (jamais présenté comme supprimé).
 */
export type StorageCleanup = "deleted" | "not_needed" | "retained" | "failed";

export async function permanentDeleteProduct(
  id: string,
): Promise<StorageCleanup | undefined> {
  const { data } = await apiClient.delete<{ storageCleanup?: StorageCleanup }>(
    `/products/${id}/permanent`,
  );
  return data?.storageCleanup;
}

// ─── Sales ───────────────────────────────────────────────────────────────────

export async function fetchSales(productId?: string): Promise<ApiSale[]> {
  const { data } = await apiClient.get<ApiSale[]>("/sales", {
    params: productId ? { productId } : {},
  });
  return data;
}

/** 1-20E — Taille d'une page de l'historique des ventes. */
export const SALES_PAGE_SIZE = 20;

/**
 * 1-20E — Une page de l'historique (`GET /sales/history`) : `total` porte
 * sur tout le périmètre autorisé (toute l'organisation ou ses propres
 * ventes), jamais sur la page. `legacy` : API antérieure sans ce contrat
 * (404) → historique COMPLET de l'ancien contrat, présenté comme tel (aucune
 * pagination, total exact = nombre de ventes reçues).
 */
export interface SalesPage {
  items: ApiSale[];
  total: number;
  nextCursor: string | null;
  legacy: boolean;
}

export async function fetchSalesPage(
  cursor: string | null,
): Promise<SalesPage> {
  try {
    const { data } = await apiClient.get<Omit<SalesPage, "legacy">>(
      "/sales/history",
      { params: { limit: SALES_PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
    );
    return { ...data, legacy: false };
  } catch (error) {
    if (
      cursor === null &&
      axios.isAxiosError(error) &&
      error.response?.status === 404
    ) {
      const all = await fetchSales();
      return { items: all, total: all.length, nextCursor: null, legacy: true };
    }
    throw error;
  }
}

// 1-11C.3 : plus aucun `POST /sales` direct — toute vente passe par
// l'outbox (`enqueueOfflineSale`) puis `createSaleIdempotent`.

// 1-11C.2 — envoi d'une vente de l'outbox hors ligne. `capturedToken` est
// utilisé tel quel (jamais relu au milieu de la requête) ; `clientOperationId`
// rend l'appel idempotent côté serveur (1-11C.1).
export interface IdempotentSalePayload {
  productId: string;
  quantity: number;
  salePrice: number;
  buyerName?: string;
  buyerContact?: string;
  occurredAt: string;
  // Lot B : lots remis au client, confirmés tels quels.
  batchAllocations?: BatchQuantityEntry[];
  unknownExpiryConfirmed?: boolean;
  expiredBatchRegularization?: { reason: string };
}

const IDEMPOTENT_SALE_TIMEOUT_MS = 30_000;

export async function createSaleIdempotent(
  payload: IdempotentSalePayload,
  clientOperationId: string,
  capturedToken: string,
  signal: AbortSignal,
): Promise<ApiSale> {
  const { data } = await apiClient.post<ApiSale>(
    "/sales",
    { ...payload, clientOperationId },
    {
      headers: { Authorization: `Bearer ${capturedToken}` },
      signal,
      timeout: IDEMPOTENT_SALE_TIMEOUT_MS,
    },
  );
  return data;
}

// Traduit une erreur Axios en issue neutre (aucun message brut conservé).
export function toSaleSyncOutcome(
  error: unknown,
  now: number = Date.now(),
): SaleSyncOutcome {
  if (axios.isCancel(error)) return { kind: "aborted" };
  if (!axios.isAxiosError(error)) return { kind: "network" };
  if (error.code === "ERR_CANCELED") return { kind: "aborted" };
  if (!error.response) return { kind: "network" };
  const body = error.response.data as { code?: unknown } | undefined;
  const header = error.response.headers?.["retry-after"] as unknown;
  const retryAfterMs = parseRetryAfterMs(
    typeof header === "string" ? header : undefined,
    now,
  );
  return {
    kind: "http",
    status: error.response.status,
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export async function updateSale(
  id: string,
  payload: {
    quantity?: number;
    salePrice?: number;
    // Lot B : lots concernés par une variation de quantité.
    batchReturns?: BatchQuantityEntry[];
    batchAllocations?: BatchQuantityEntry[];
    unknownExpiryConfirmed?: boolean;
  } & LegacyRestitutionPayload,
): Promise<ApiSale> {
  const { data } = await apiClient.patch<ApiSale>(`/sales/${id}`, payload);
  return data;
}

// Lot B : corps facultatif (restitution d'une vente antérieure aux lots).
export async function deleteSale(
  id: string,
  restitution?: LegacyRestitutionPayload,
): Promise<void> {
  await apiClient.delete(
    `/sales/${id}`,
    restitution ? { data: restitution } : undefined,
  );
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export async function fetchOverview(
  month?: string,
): Promise<AnalyticsOverview> {
  const { data } = await apiClient.get<AnalyticsOverview>(
    "/analytics/overview",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchProductsRanking(
  month?: string,
): Promise<ProductRanking[]> {
  const { data } = await apiClient.get<ProductRanking[]>(
    "/analytics/products/ranking",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchSellersRanking(
  month?: string,
): Promise<SellerRanking[]> {
  const { data } = await apiClient.get<SellerRanking[]>(
    "/analytics/sellers/ranking",
    {
      params: month ? { month } : {},
    },
  );
  return data;
}

export async function fetchInsightList(
  kind: InsightListKind,
  offset: number,
  month?: string,
): Promise<InsightList<InsightStockItem | InsightPriceItem>> {
  const { data } = await apiClient.get<
    InsightList<InsightStockItem | InsightPriceItem>
  >("/analytics/insights/list", {
    params: { kind, offset, ...(month ? { month } : {}) },
  });
  return data;
}

export async function fetchInsights(
  month?: string,
): Promise<AnalyticsInsights> {
  const { data } = await apiClient.get<AnalyticsInsights>(
    "/analytics/insights",
    { params: month ? { month } : {} },
  );
  return data;
}

export async function fetchMonthlyTrend(): Promise<MonthlyTrend[]> {
  const { data } = await apiClient.get<MonthlyTrend[]>("/analytics/monthly");
  return data;
}

// ─── Error helper ────────────────────────────────────────────────────────────

// 1-11B : distingue une véritable panne réseau (aucune réponse reçue) d'une
// réponse HTTP (401/403/404/5xx…) — seule la première autorise un repli
// hors ligne vers le catalogue en cache (jamais sur une réponse serveur).
export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}

// 1-16G : messages génériques dans la langue de l'interface ; un message
// 4xx de l'API est déjà dans la langue demandée (`Accept-Language`). Les
// mêmes protections s'appliquent : jamais le détail d'un 403/404/5xx.
export function getApiErrorMessage(error: unknown): string {
  const t = clientT();
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return t("errors.network");
    }
    const status = error.response.status;
    const body = error.response.data as
      { message?: string | string[] } | undefined;

    const code = (body as { code?: unknown } | undefined)?.code;
    if (code === SUBSCRIPTION_INACTIVE) return t("errors.subscriptionInactive");
    if (code === SUBSCRIPTION_STATUS_UNAVAILABLE)
      return t("errors.statusUnavailable");
    // 1-17B : envoi de fichier interrompu (503 stable), réessayable.
    if (code === "STORAGE_UPLOAD_INTERRUPTED")
      return t("errors.uploadInterrupted");
    if (status === 403) return t("errors.forbidden");
    if (status === 404) return t("errors.notFound");
    if (status >= 500) return t("errors.server");
    if (body?.message) {
      return Array.isArray(body.message)
        ? body.message.join(", ")
        : body.message;
    }
    return t("errors.status", { status });
  }
  return t("errors.unexpected");
}

// Code d'erreur stable (ex. REGISTRATION_DISABLED, ACCOUNT_DETAILS_REQUIRED) —
// jamais de détail technique, seulement le champ `code` déjà public de l'API.
export function getApiErrorCode(error: unknown): string | undefined {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { code?: string } | undefined;
    return body?.code;
  }
  return undefined;
}

// Legacy re-exports so existing object components don't break immediately
export type ApiObject = ApiProduct;
export const fetchObjects = () => fetchProducts();
export const fetchObject = fetchProduct;
