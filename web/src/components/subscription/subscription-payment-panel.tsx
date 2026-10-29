"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLinkIcon,
  PrinterIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SUBSCRIPTION_OFFERS,
  knownTerm,
  type SubscriptionTerm,
} from "@/lib/subscription-offers";
import {
  BLOCKING_PAYMENT_STATUSES,
  PAYMENT_HISTORY_PAGE_SIZE,
  abandonSubscriptionPayment,
  classifyPaymentError,
  createSubscriptionPayment,
  fetchPaymentCapabilities,
  fetchPaymentReceipt,
  fetchSubscriptionPayment,
  isDefinitiveCreationRefusal,
  listSubscriptionPayments,
  newClientOperationId,
  refreshSubscriptionPayment,
  safeCheckoutUrl,
  type ApiPaymentReceipt,
  type ApiSubscriptionPayment,
  type PaymentErrorKind,
  type SubscriptionPaymentStatus,
} from "@/lib/subscription-payments";
import {
  clearPaymentIntent,
  readPaymentIntent,
  writePaymentIntent,
  type PaymentIdentity,
  type PaymentIntent,
} from "@/lib/payment-intent";
import { createResponseOrder } from "@/lib/refresh-coordinator";
import {
  abandonReleases,
  canRequestAbandon,
  chargedAmountChange,
  checkoutPhase,
  minorToMajor,
  nextPhaseChangeAt,
  paymentAvailability,
  receiptAvailable,
  type CheckoutPhase,
  type PaymentAbandonOutcome,
  type PaymentAvailability,
} from "@/lib/payment-guards";
import { useLiveRefresh, useSocketSignals } from "@/hooks/use-live-refresh";
import { OfferConditions, OfferSelector } from "./subscription-offers";
import { PaymentConfirmationAssistance } from "./payment-confirmation-assistance";
import { rich } from "@/i18n/rich";

// 1-14D.2C — Paiement Mobile Money de l'abonnement par le PROPRIÉTAIRE réel.
//
// Garanties côté navigateur (le serveur reste l'autorité) :
// - UNE intention = UN `clientOperationId` (UUID v4), écrit dans le
//   marqueur AVANT l'envoi et rejoué tel quel après une réponse perdue ;
//   jamais régénéré automatiquement, jamais de relance automatique du POST ;
// - aucune nouvelle collecte tant qu'un paiement est `initiating`,
//   `pending`, `uncertain` ou `review` ; nouvel essai après `failed`
//   uniquement sur action explicite ET relecture serveur récente ;
// - aucun polling, aucune vérification au focus : « Vérifier le paiement »
//   est la seule consultation du prestataire ;
// - aucun délai local ne transforme un paiement en échec ;
// - `succeeded` → reprise via `onAccessRestore` (échange `complete`
//   existant), jamais un raccourci d'authentification.
//
// 1-15F — temps réel (session applicative seulement : le socket du shell ;
// jamais en session limitée ni sur l'écran de blocage, sans socket) :
// - `payments:changed` (payload vide, propriétaire réel seul) → relecture
//   SILENCIEUSE regroupée de l'historique et du paiement affiché, par les
//   seules lectures LOCALES (`GET …/payments`, `GET …/payments/:id`) ;
//   jamais `…/refresh`, donc jamais le prestataire ; rattrapage à la
//   reconnexion ;
// - une relecture ne crée, ne confirme ni ne relance aucun paiement, ne
//   touche ni au marqueur de reprise, ni à l'UUID, ni au verrou
//   d'initiation, et n'appelle jamais `onAccessRestore` ;
// - réponse ignorée si une réponse plus récente a été appliquée, si une
//   action de l'utilisateur a appliqué une réponse pendant la relecture
//   (relecture redemandée), ou pour un paiement qui n'est plus celui affiché ;
// - `succeeded` est définitif : une réponse ancienne ne réaffiche jamais
//   `pending` après `succeeded` (le serveur ne régresse jamais un succès).
//
// 1-21B — page de paiement hébergée (SasPay) quand le serveur l'indique
// (`capabilities`) :
// - aucun numéro demandé ; le serveur crée la page et la conserve ;
//   « Continuer vers le paiement » rouvre CETTE page (jamais une nouvelle,
//   même après un retour, un rechargement ou une reconnexion) ;
// - retour dans Stock Master (`?payment=<id>` du paiement ouvert affiché) :
//   UNE vérification serveur (`…/refresh`), comme le bouton ; le paramètre
//   est retiré de l'adresse. Ni le paramètre, ni la redirection, ni la
//   fermeture de la page ne prouvent un paiement : seul le statut renvoyé
//   par le serveur fait foi.
//
// 1-21E — reprise, expiration et changement de forfait (page hébergée) :
// - la situation vient du SERVEUR (`situation`) : page ouverte, expirée,
//   lien non récupéré, tentative à confirmer, page close sans paiement ;
//   jamais « résultat à vérifier » pour une simple page non payée ;
// - échéance du lien = réception + validité restante donnée par le serveur
//   (indépendante de l'horloge de l'appareil, jamais repoussée par un
//   rechargement) ; un minuteur UNIQUE retire le lien à l'échéance (moins
//   une marge), puis UNE vérification serveur établit le résultat ;
// - « Changer de forfait » et « Annuler cette tentative » demandent au
//   serveur de vérifier puis, seulement si c'est sûr, de FERMER la page chez
//   SasPay ; l'issue affichée est celle établie par le serveur (jamais une
//   annulation locale, jamais une seconde session).

const PAYMENT_SIGNALS = ["payments:changed"] as const;

/** 1-21E : message après vérification, selon la situation OBSERVÉE. */
const SITUATION_MESSAGES: Partial<
  Record<NonNullable<ApiSubscriptionPayment["situation"]>, MessageKey>
> = {
  "checkout-closed": "payment.messages.checkoutClosed",
  "checkout-expired": "payment.messages.expiredAwaitingClosure",
  "closure-unconfirmed": "payment.messages.closureUnconfirmed",
  "renewal-suspended": "payment.messages.renewalSuspended",
  "collected-in-resolution": "payment.messages.collectedInResolution",
};
const NO_SIGNALS: readonly string[] = [];

/** Horodatage d'une intention, lu au moment de l'envoi (jamais au rendu). */
function intentTimestamp(): number {
  return Date.now();
}

/** Vue la plus avancée : un succès connu n'est jamais remplacé. */
function newerView(
  known: ApiSubscriptionPayment,
  fresh: ApiSubscriptionPayment,
): ApiSubscriptionPayment {
  return known.status === "succeeded" && fresh.status !== "succeeded"
    ? known
    : fresh;
}

/** Fusion de la première page relue dans l'historique affiché (`_id` décroissant). */
function mergeHistory(
  items: ApiSubscriptionPayment[],
  fresh: ApiSubscriptionPayment[],
): ApiSubscriptionPayment[] {
  const byId = new Map(items.map((p) => [p.paymentId, p]));
  for (const payment of fresh) {
    const known = byId.get(payment.paymentId);
    byId.set(payment.paymentId, known ? newerView(known, payment) : payment);
  }
  return [...byId.values()].sort((a, b) =>
    a.paymentId < b.paymentId ? 1 : a.paymentId > b.paymentId ? -1 : 0,
  );
}

// 1-16G : libellés dans `subscription` (`payment.status.*`) ; les messages
// gardés en état sont des CLÉS, traduites à l'affichage (un changement de
// langue les suit sans rien relancer).
type MessageKey =
  | `payment.errors.${PaymentErrorKind["kind"] | "unauthorizedRestricted"}`
  | `payment.messages.${
      | "offlineCreate"
      | "termRequired"
      | "phoneRequired"
      | "replayed"
      | "sent"
      | "checkoutReady"
      | "confirmed"
      | "checkoutClosed"
      | "expiredAwaitingClosure"
      | "closureUnconfirmed"
      | "renewalSuspended"
      | "collectedInResolution"
      | "confirmationPending"
      | "offlineVerify"}`;

/** 1-21E : issue ÉTABLIE par le serveur pour un changement de forfait. */
type AbandonMessageKey = `payment.abandon.outcome.${
  | Exclude<PaymentAbandonOutcome, "released" | "succeeded">
  | "releasedChange"
  | "releasedCancel"}`;

type Message =
  | { tone: "info" | "error" | "success"; key: MessageKey | AbandonMessageKey }
  | {
      tone: "info";
      key: "payment.messages.statusChecked" | "payment.messages.statusNow";
      status: SubscriptionPaymentStatus;
    };

/** Message utile, sans faux succès ni détail technique. */
function messageFor(error: PaymentErrorKind, restricted: boolean): MessageKey {
  switch (error.kind) {
    case "unexpected":
      return "payment.errors.no-response";
    case "unauthorized":
      return restricted
        ? "payment.errors.unauthorizedRestricted"
        : "payment.errors.unauthorized";
    default:
      return `payment.errors.${error.kind}`;
  }
}

export function SubscriptionPaymentPanel({
  identity,
  token,
  onAccessRestore,
}: {
  /** Identité VÉRIFIÉE par le serveur (contexte), portée du marqueur. */
  identity: PaymentIdentity;
  /** Jeton limité explicite ; absent = JWT applicatif courant. */
  token?: string;
  /** Reprise commerciale existante (contexte + échange `complete`). */
  onAccessRestore: () => void;
}) {
  const { t } = useT("subscription");
  const format = useFormat();
  const formatDate = (iso: string | null): string | null => {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? null
      : format.dateWith(date, { dateStyle: "medium", timeStyle: "short" });
  };
  const termText = (value: string | null | undefined) => {
    const term = knownTerm(value);
    return term ? t(`offers.term.${term}`) : "—";
  };
  const restricted = token !== undefined;
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<ApiSubscriptionPayment | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [history, setHistory] = useState<ApiSubscriptionPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<
    "historyUnavailable" | "historyMore" | null
  >(null);
  const [busy, setBusy] = useState<
    "create" | "refresh" | "read" | "history" | "abandon" | "receipt" | null
  >(null);
  // 1-21E : reçu affiché (lecture locale), imprimable.
  const [receipt, setReceipt] = useState<ApiPaymentReceipt | null>(null);
  // 1-21E : instant de rendu des phases (mis à jour par un minuteur unique
  // à l'échéance du lien, jamais par un intervalle).
  const [now, setNow] = useState(() => Date.now());
  // 1-21E : confirmation explicite avant de demander la fermeture.
  const [confirmAbandon, setConfirmAbandon] = useState<
    "change" | "cancel" | null
  >(null);
  // 1-21E : choix des formules consultable pendant qu'un paiement bloque.
  const [browsing, setBrowsing] = useState(false);
  const [previewTerm, setPreviewTerm] = useState<SubscriptionTerm | null>(null);
  // 1-21E : une seule vérification automatique par paiement expiré.
  const autoVerified = useRef(new Set<string>());
  const [message, setMessage] = useState<Message | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [term, setTerm] = useState<SubscriptionTerm | null>(null);
  const [phone, setPhone] = useState("");
  const [online, setOnline] = useState(true);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  // 1-21B : moyen proposé par le serveur ; API antérieure → Mobile Money.
  // 1-21D : `available: false` → paiements désactivés (aucune création).
  const [availability, setAvailability] =
    useState<PaymentAvailability>("unknown");
  const hosted = availability === "hosted-checkout";
  const paymentsDisabled = availability === "unavailable";
  // 1-21D : montant enregistré ≠ prix affiché dans cet onglet → confirmation
  // explicite avant de proposer la page de paiement.
  const [priceChange, setPriceChange] = useState<{
    paymentId: string;
    displayedXaf: number;
    chargedXaf: number;
  } | null>(null);
  // 1-21B : paiement désigné par l'adresse de retour (une vérification).
  const returnedPayment = useRef<string | null>(null);
  // Verrou SYNCHRONE contre le double clic (l'état React est asynchrone).
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // 1-15F : début de la dernière relecture appliquée (rattrapage), ordre
  // des relectures, génération des réponses appliquées par une action ou le
  // chargement initial, paiement affiché et pages d'historique chargées.
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const reloadOrder = useRef(createResponseOrder());
  const actionEpoch = useRef(0);
  const currentRef = useRef<ApiSubscriptionPayment | null>(null);
  const extraPages = useRef(0);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" || navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Réactivation après `Retry-After` : un minuteur LOCAL, aucun appel réseau.
  useEffect(() => {
    if (retryAt === null) return;
    const delay = Math.max(0, retryAt - Date.now());
    const timer = window.setTimeout(() => setRetryAt(null), delay);
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const applyError = useCallback(
    (error: PaymentErrorKind) => {
      if (error.kind === "rate-limited") {
        setRetryAt(Date.now() + (error.retryAfterMs ?? 60_000));
      } else if (
        (error.kind === "service-unavailable" ||
          error.kind === "status-unavailable") &&
        error.retryAfterMs !== undefined
      ) {
        // 1-22D : capacité du prestataire saturée, délai fourni.
        setRetryAt(Date.now() + error.retryAfterMs);
      }
      setMessage({ tone: "error", key: messageFor(error, restricted) });
    },
    [restricted],
  );

  const upsertHistory = useCallback((payment: ApiSubscriptionPayment) => {
    setHistory((items) => {
      const index = items.findIndex((p) => p.paymentId === payment.paymentId);
      if (index === -1) return [payment, ...items];
      const copy = [...items];
      copy[index] = payment;
      return copy;
    });
  }, []);

  /** Le paiement affiché devient la référence de reprise de l'identité. */
  const track = useCallback(
    (payment: ApiSubscriptionPayment, clientOperationId: string | null) => {
      actionEpoch.current += 1;
      setCurrent(payment);
      upsertHistory(payment);
      if (payment.status === "succeeded") {
        clearPaymentIntent(identity);
        setIntent(null);
        return;
      }
      const next: PaymentIntent = {
        ...identity,
        clientOperationId,
        term: payment.term,
        paymentId: payment.paymentId,
        savedAt: Date.now(),
      };
      writePaymentIntent(next);
      setIntent(next);
    },
    [identity, upsertHistory],
  );

  // Chargement : marqueur local (non fiable) + lectures serveur LOCALES
  // (historique, paiement connu). Aucun appel au prestataire.
  useEffect(() => {
    let cancelled = false;
    const stored = readPaymentIntent(identity);
    setIntent(stored);
    setLoading(true);
    const requestedAt = Date.now();
    const returnedParam =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("payment");
    void fetchPaymentCapabilities(token)
      .then((capabilities) => {
        if (!cancelled) setAvailability(paymentAvailability(capabilities));
      })
      .catch(() => undefined);
    void (async () => {
      let page: { items: ApiSubscriptionPayment[]; nextCursor: string | null } =
        { items: [], nextCursor: null };
      try {
        page = await listSubscriptionPayments(
          { limit: PAYMENT_HISTORY_PAGE_SIZE },
          token,
        );
      } catch (error) {
        if (cancelled) return;
        // Historique indisponible : la reprise continue avec le marqueur
        // (paiement connu relu, ou intention sans réponse proposée au rejeu).
        setHistoryError("historyUnavailable");
        applyError(classifyPaymentError(error));
      }
      if (cancelled) return;
      setHistory(page.items);
      setNextCursor(page.nextCursor);
      let found: ApiSubscriptionPayment | null = null;
      if (stored?.paymentId) {
        try {
          found = await fetchSubscriptionPayment(stored.paymentId, token);
        } catch (error) {
          if (cancelled) return;
          if (classifyPaymentError(error).kind === "not-found") {
            clearPaymentIntent(identity);
            setIntent(null);
          }
        }
      }
      // Paiement ouvert retrouvé côté serveur (réauthentification, autre
      // appareil, marqueur effacé) : le plus récent, unique par commerce.
      if (!found) {
        const open = page.items.find((p) =>
          BLOCKING_PAYMENT_STATUSES.has(p.status),
        );
        if (open) found = open;
      }
      if (cancelled) return;
      actionEpoch.current += 1;
      setLoadedAt(requestedAt);
      // 1-21B : retour de la page de paiement pour le paiement OUVERT affiché.
      if (
        returnedParam &&
        found &&
        found.paymentId === returnedParam &&
        BLOCKING_PAYMENT_STATUSES.has(found.status)
      ) {
        returnedPayment.current = found.paymentId;
      }
      if (returnedParam && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("payment");
        window.history.replaceState(window.history.state, "", url.toString());
      }
      if (found) {
        setCurrent(found);
        if (found.status === "succeeded") {
          clearPaymentIntent(identity);
          setIntent(null);
        } else if (stored?.paymentId !== found.paymentId) {
          // Paiement ouvert retrouvé (éventuellement celui d'une réponse
          // perdue) : il devient la référence de reprise ; l'UUID local n'est
          // plus nécessaire (un seul paiement ouvert par commerce).
          const next: PaymentIntent = {
            ...identity,
            clientOperationId: null,
            term: found.term,
            paymentId: found.paymentId,
            savedAt: Date.now(),
          };
          writePaymentIntent(next);
          setIntent(next);
        }
      } else if (stored && stored.paymentId === null) {
        // Réponse perdue : MÊME UUID, MÊME durée ; nouvelle saisie du numéro.
        setTerm(stored.term);
        setFormOpen(true);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // `identity` et `token` définissent le contexte ; le panneau est
    // remonté (clé) à chaque changement d'identité.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.userId, identity.organizationId, token]);

  // 1-15F — relecture silencieuse sur `payments:changed` (lectures locales
  // seulement). Aucune écriture du marqueur, aucun verrou, aucun message.
  const live = !restricted;
  const reloadRef = useRef<() => void>(() => undefined);
  const reloadFromServer = useCallback(async () => {
    const requestedAt = Date.now();
    const ticket = reloadOrder.current.begin();
    const epoch = actionEpoch.current;
    const selected = currentRef.current?.paymentId ?? null;
    let page: { items: ApiSubscriptionPayment[]; nextCursor: string | null };
    let fresh: ApiSubscriptionPayment | null = null;
    try {
      [page, fresh] = await Promise.all([
        listSubscriptionPayments({ limit: PAYMENT_HISTORY_PAGE_SIZE }, token),
        selected
          ? fetchSubscriptionPayment(selected, token)
          : Promise.resolve(null),
      ]);
    } catch {
      return; // affichage conservé ; rattrapage au prochain signal
    }
    if (!mounted.current) return;
    // Une action (ou le chargement initial) a appliqué une réponse pendant
    // la relecture : celle-ci est peut-être plus ancienne → relue ensuite.
    if (actionEpoch.current !== epoch) {
      reloadRef.current();
      return;
    }
    if (!reloadOrder.current.accept(ticket)) return;
    setLoadedAt(requestedAt);
    setHistory((items) => mergeHistory(items, page.items));
    if (extraPages.current === 0) setNextCursor(page.nextCursor);
    setHistoryError(null);
    const open =
      page.items.find((p) => BLOCKING_PAYMENT_STATUSES.has(p.status)) ?? null;
    setCurrent((previous) => {
      let next = previous;
      // Paiement relu par son identifiant : appliqué seulement s'il est
      // toujours celui affiché.
      if (fresh && previous && previous.paymentId === fresh.paymentId) {
        next = newerView(previous, fresh);
      } else if (previous && previous.paymentId !== selected) {
        return previous;
      }
      // Paiement ouvert créé ailleurs (autre onglet, autre appareil) :
      // affiché, ce qui bloque toute nouvelle collecte ici.
      if (
        open &&
        open.paymentId !== next?.paymentId &&
        (next === null || !BLOCKING_PAYMENT_STATUSES.has(next.status))
      ) {
        return open;
      }
      return next;
    });
  }, [token]);
  const requestReload = useLiveRefresh(
    reloadFromServer,
    live ? loadedAt : undefined,
  );
  useEffect(() => {
    reloadRef.current = requestReload;
  }, [requestReload]);
  useSocketSignals(live ? PAYMENT_SIGNALS : NO_SIGNALS, requestReload);

  const lostIntent = intent !== null && intent.paymentId === null;
  const lockedTerm = lostIntent ? intent.term : null;
  const blocking =
    current !== null && BLOCKING_PAYMENT_STATUSES.has(current.status);
  const rateLimited = retryAt !== null;
  const selectedTerm = lockedTerm ?? term;
  const offer = SUBSCRIPTION_OFFERS.find((o) => o.term === selectedTerm);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || blocking || rateLimited || paymentsDisabled) {
      return;
    }
    if (!online) {
      setMessage({ tone: "error", key: "payment.messages.offlineCreate" });
      return;
    }
    if (!selectedTerm) {
      setMessage({ tone: "error", key: "payment.messages.termRequired" });
      return;
    }
    if (!hosted && phone.trim().length === 0) {
      setMessage({ tone: "error", key: "payment.messages.phoneRequired" });
      return;
    }
    inFlight.current = true;
    setBusy("create");
    setMessage(null);
    // Intention écrite AVANT l'envoi : une réponse perdue rejouera le MÊME
    // UUID et la MÊME durée.
    const replaying = lostIntent && intent !== null;
    const active: PaymentIntent =
      replaying && intent
        ? intent
        : {
            ...identity,
            clientOperationId: newClientOperationId(),
            term: selectedTerm,
            paymentId: null,
            savedAt: intentTimestamp(),
          };
    writePaymentIntent(active);
    setIntent(active);
    // Prix présenté dans CET onglet au moment de l'envoi.
    const displayedXaf = offer?.totalXaf ?? null;
    try {
      const created = await createSubscriptionPayment(
        {
          term: active.term,
          ...(hosted ? {} : { payerPhone: phone }),
          clientOperationId: active.clientOperationId as string,
        },
        token,
      );
      if (!mounted.current) return;
      setPhone("");
      setFormOpen(false);
      const change = chargedAmountChange(displayedXaf, created.amount);
      setPriceChange(
        change ? { paymentId: created.paymentId, ...change } : null,
      );
      track(created, active.clientOperationId);
      setMessage({
        tone: "info",
        key: created.replayed
          ? "payment.messages.replayed"
          : safeCheckoutUrl(created.checkoutUrl)
            ? "payment.messages.checkoutReady"
            : "payment.messages.sent",
      });
      // 1-21E : session créée au DERNIER moment, sur le clic « Continuer
      // vers le paiement » : le payeur y est conduit aussitôt (même onglet).
      // Prix changé : confirmation d'abord ; lien absent : « Vérifier ».
      const destination = safeCheckoutUrl(created.checkoutUrl);
      if (hosted && destination && !change) {
        window.location.assign(destination);
      }
    } catch (error) {
      if (!mounted.current) return;
      const kind = classifyPaymentError(error);
      if (kind.kind === "already-pending") {
        // Autre onglet/appareil : CET UUID n'a rien créé. On affiche le
        // paiement ouvert indiqué par le serveur, sans nouvelle collecte.
        clearPaymentIntent(identity);
        setIntent(null);
        setPhone("");
        setFormOpen(false);
        if (kind.paymentId) {
          try {
            const existing = await fetchSubscriptionPayment(
              kind.paymentId,
              token,
            );
            if (mounted.current) track(existing, null);
          } catch (readError) {
            if (mounted.current) applyError(classifyPaymentError(readError));
          }
        }
      } else if (isDefinitiveCreationRefusal(kind) && !replaying) {
        // Refus DÉFINITIF d'une intention NOUVELLE : rien n'a été créé avec
        // cet UUID ; il est abandonné (la durée reste modifiable).
        clearPaymentIntent(identity);
        setIntent(null);
      }
      // Sinon (issue inconnue, conflit, indisponibilité, limitation, ou
      // intention rejouée) : l'intention reste verrouillée (UUID + durée).
      applyError(kind);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const verify = async () => {
    if (!current || inFlight.current || rateLimited) return;
    if (!online) {
      setMessage({ tone: "error", key: "payment.messages.offlineVerify" });
      return;
    }
    inFlight.current = true;
    setBusy("refresh");
    setMessage(null);
    try {
      const updated = await refreshSubscriptionPayment(
        current.paymentId,
        token,
      );
      if (!mounted.current) return;
      track(updated, intent?.clientOperationId ?? null);
      if (updated.status === "succeeded") {
        setMessage({ tone: "success", key: "payment.messages.confirmed" });
        onAccessRestore();
      } else if (updated.confirmationPending) {
        setMessage({
          tone: "info",
          key: "payment.messages.confirmationPending",
        });
      } else if (updated.situation && SITUATION_MESSAGES[updated.situation]) {
        // 1-21E : message fidèle au statut RÉELLEMENT observé.
        setMessage({
          tone: "info",
          key: SITUATION_MESSAGES[updated.situation]!,
        });
      } else {
        setMessage({
          tone: "info",
          key: "payment.messages.statusChecked",
          status: updated.status,
        });
      }
    } catch (error) {
      if (!mounted.current) return;
      const kind = classifyPaymentError(error);
      if (kind.kind === "not-found") {
        actionEpoch.current += 1;
        clearPaymentIntent(identity);
        setIntent(null);
        setCurrent(null);
      }
      applyError(kind);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  // 1-21B : retour de la page de paiement → UNE vérification serveur.
  const verifyRef = useRef(verify);
  useEffect(() => {
    verifyRef.current = verify;
  });
  useEffect(() => {
    if (loading || !current) return;
    if (returnedPayment.current !== current.paymentId) return;
    returnedPayment.current = null;
    void verifyRef.current();
  }, [loading, current]);

  // 1-21E : lien retiré à l'échéance (minuteur UNIQUE, aucun intervalle).
  useEffect(() => {
    const at = current ? nextPhaseChangeAt(current) : null;
    if (at === null) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, at - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [current]);

  // 1-21E : page expirée → UNE vérification serveur par paiement (résultat
  // de la tentative établi avant toute nouvelle création ; jamais de boucle).
  useEffect(() => {
    if (loading || !current || !online || busy !== null) return;
    if (current.status !== "pending" && current.status !== "uncertain") return;
    if (checkoutPhase(current, now) !== "expired") return;
    if (autoVerified.current.has(current.paymentId)) return;
    autoVerified.current.add(current.paymentId);
    void verifyRef.current();
  }, [loading, current, now, online, busy]);

  /**
   * 1-21E — « Changer de forfait » / « Annuler cette tentative » : le serveur
   * vérifie chez SasPay et ne ferme la page que si c'est sûr ; l'issue
   * affichée est la sienne. Aucune nouvelle session, aucune relance.
   */
  const requestAbandon = async (mode: "change" | "cancel") => {
    if (!current || inFlight.current || rateLimited) return;
    if (!online) {
      setMessage({ tone: "error", key: "payment.messages.offlineVerify" });
      return;
    }
    inFlight.current = true;
    setBusy("abandon");
    setMessage(null);
    try {
      const { outcome, payment } = await abandonSubscriptionPayment(
        current.paymentId,
        token,
      );
      if (!mounted.current) return;
      setConfirmAbandon(null);
      if (outcome === "succeeded" || payment.status === "succeeded") {
        // Paiement abouti : jamais présenté comme annulé.
        track(payment, null);
        setMessage({ tone: "success", key: "payment.messages.confirmed" });
        onAccessRestore();
        return;
      }
      if (abandonReleases(outcome)) {
        // Fermeture ÉTABLIE (page relue close, aucune transaction) : le
        // paiement reste dans l'historique ; un nouveau choix est libre.
        actionEpoch.current += 1;
        upsertHistory(payment);
        clearPaymentIntent(identity);
        setIntent(null);
        setCurrent(null);
        setPriceChange(null);
        setBrowsing(false);
        setPhone("");
        setTerm(null);
        setFormOpen(mode === "change");
        setMessage(
          mode === "change"
            ? { tone: "info", key: "payment.abandon.outcome.releasedChange" }
            : {
                tone: "success",
                key: "payment.abandon.outcome.releasedCancel",
              },
        );
        return;
      }
      // Rien n'est fermé ni libéré : explication de l'état établi.
      track(payment, intent?.clientOperationId ?? null);
      setMessage({ tone: "info", key: `payment.abandon.outcome.${outcome}` });
      if (mode === "change") {
        setPreviewTerm(null);
        setBrowsing(true);
      }
    } catch (error) {
      if (!mounted.current) return;
      setConfirmAbandon(null);
      const kind = classifyPaymentError(error);
      if (kind.kind === "not-found") {
        actionEpoch.current += 1;
        clearPaymentIntent(identity);
        setIntent(null);
        setCurrent(null);
      }
      applyError(kind);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  /** Nouvel essai après `failed` : action explicite + relecture serveur. */
  const startNewAttempt = async () => {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    setBusy("read");
    setMessage(null);
    try {
      const fresh = await fetchSubscriptionPayment(current.paymentId, token);
      if (!mounted.current) return;
      actionEpoch.current += 1;
      upsertHistory(fresh);
      if (fresh.status !== "failed") {
        track(fresh, intent?.clientOperationId ?? null);
        setMessage({
          tone: "info",
          key: "payment.messages.statusNow",
          status: fresh.status,
        });
        return;
      }
      clearPaymentIntent(identity);
      setIntent(null);
      setCurrent(null);
      setTerm(null);
      setPhone("");
      setFormOpen(true);
    } catch (error) {
      if (mounted.current) applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const loadMore = async () => {
    if (!nextCursor || inFlight.current) return;
    inFlight.current = true;
    setBusy("history");
    try {
      const page = await listSubscriptionPayments(
        { limit: PAYMENT_HISTORY_PAGE_SIZE, before: nextCursor },
        token,
      );
      if (!mounted.current) return;
      setHistory((items) => [
        ...items,
        ...page.items.filter(
          (p) => !items.some((i) => i.paymentId === p.paymentId),
        ),
      ]);
      setNextCursor(page.nextCursor);
      extraPages.current += 1;
      setHistoryError(null);
    } catch (error) {
      if (!mounted.current) return;
      setHistoryError("historyMore");
      applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("payment.loading")}
      </p>
    );
  }

  const pendingPriceChange =
    priceChange !== null && current?.paymentId === priceChange.paymentId
      ? priceChange
      : null;
  // 1-21E : phase à cet instant (`null` : API antérieure ou Mobile Money).
  const phase: CheckoutPhase | null = current
    ? checkoutPhase(current, now)
    : null;
  // Page de paiement proposée seulement si elle est encore valide, et après
  // confirmation d'un prix changé.
  const checkoutUrl =
    current && !pendingPriceChange && (phase === null || phase === "open")
      ? safeCheckoutUrl(current.checkoutUrl)
      : null;
  const situationCopy: Partial<Record<CheckoutPhase, string>> = {
    expired: "payment.situation.expired",
    "link-missing": "payment.situation.linkMissing",
    "attempt-unresolved": "payment.situation.attemptUnresolved",
    "closure-unconfirmed": "payment.situation.closureUnconfirmed",
    closed: "payment.situation.closed",
    "renewal-suspended": "payment.situation.renewalSuspended",
    "collected-in-resolution": "payment.situation.collectedInResolution",
    refunded: "payment.situation.refunded",
  };
  const situationKey = phase ? situationCopy[phase] : undefined;
  // Transaction SasPay engagée, issue pas encore connue (établi par le
  // serveur) : jamais « page expirée » pour un paiement peut-être débité.
  const confirming = current?.confirmationPending ?? null;
  const copy = current
    ? confirming
      ? {
          label: t("payment.confirmation.label"),
          detail: t("payment.confirmation.detail"),
        }
      : situationKey
        ? {
            label: t(
              `${situationKey}.label` as "payment.situation.closed.label",
            ),
            detail: t(
              `${situationKey}.detail` as "payment.situation.closed.detail",
            ),
          }
        : {
            label: t(`payment.status.${current.status}.label`),
            detail:
              current.status === "pending" && checkoutUrl
                ? t("payment.checkout.pendingDetail")
                : t(`payment.status.${current.status}.detail`),
          }
    : null;
  const historyLabel = (payment: ApiSubscriptionPayment) => {
    if (payment.confirmationPending) return t("payment.confirmation.label");
    const phaseOf = checkoutPhase(payment, now);
    const key = phaseOf ? situationCopy[phaseOf] : undefined;
    // Lien expiré : l'historique garde le libellé du statut.
    return key && phaseOf !== "expired"
      ? t(`${key}.label` as "payment.situation.closed.label")
      : t(`payment.status.${payment.status}.label`);
  };
  /** 1-21E : montant du reçu (centimes conservés, jamais recalculé). */
  const receiptAmount = (minor: number) => {
    const { major, cents } = minorToMajor(minor);
    return cents === 0
      ? format.fcfa(major)
      : `${format.number(minor / 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} FCFA`;
  };
  const openReceipt = async (paymentId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("receipt");
    setMessage(null);
    try {
      const data = await fetchPaymentReceipt(paymentId, token);
      if (mounted.current) setReceipt(data);
    } catch (error) {
      if (mounted.current) applyError(classifyPaymentError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const abandonable =
    current !== null && canRequestAbandon(current, now) && busy !== "create";
  const messageText = (m: Message) =>
    "status" in m
      ? t(m.key, { status: t(`payment.status.${m.status}.lower`) })
      : t(m.key);

  return (
    <div className="space-y-6" data-testid="subscription-payment-panel">
      {!online && (
        <p
          role="status"
          className="rounded-lg bg-muted p-3 text-sm"
          data-testid="payment-offline"
        >
          {t("payment.offline")}
        </p>
      )}

      {/* 1-21E : encaissement reçu en résolution → visible avant tout
          nouveau choix (évite un second paiement par méconnaissance). */}
      {history.some((p) => p.situation === "collected-in-resolution") && (
        <p
          role="status"
          className="rounded-lg border border-(--brand-orange) p-3 text-sm"
          data-testid="payment-collected-in-resolution"
        >
          {t("payment.messages.collectedInResolution")}
        </p>
      )}

      {current && copy && (
        <section
          aria-labelledby="current-payment-title"
          className="space-y-3 rounded-xl border p-4"
          data-testid="current-payment"
          data-status={current.status}
        >
          <div role="status" aria-live="polite" className="space-y-1">
            <h3 id="current-payment-title" className="font-semibold">
              {copy.label}
            </h3>
            <p className="text-sm text-muted-foreground">{copy.detail}</p>
            {confirming && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="payment-confirmation-provider-delay"
              >
                {t("payment.confirmation.providerDelay")}
              </p>
            )}
          </div>
          {confirming?.delayed && (
            <PaymentConfirmationAssistance
              reference={current.reference}
              restricted={restricted}
            />
          )}
          {!confirming && current.creationUnresolved?.delayed && (
            <PaymentConfirmationAssistance
              reference={current.reference}
              restricted={restricted}
              variant="creation"
            />
          )}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("payment.term")}</dt>
              <dd data-testid="payment-term">{termText(current.term)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("payment.totalAmount")}
              </dt>
              <dd className="font-semibold" data-testid="payment-amount">
                {format.fcfa(current.amount)}
              </dd>
            </div>
            {current.payerPhoneMasked && (
              <div>
                <dt className="text-muted-foreground">{t("payment.payer")}</dt>
                <dd data-testid="payment-phone">{current.payerPhoneMasked}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">
                {t("payment.reference")}
              </dt>
              <dd className="break-all font-mono text-xs leading-5">
                {current.reference}
              </dd>
            </div>
            {formatDate(current.createdAt) && (
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.requestedOn")}
                </dt>
                <dd>{formatDate(current.createdAt)}</dd>
              </div>
            )}
            {formatDate(current.confirmedAt) && (
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.confirmedOn")}
                </dt>
                <dd>{formatDate(current.confirmedAt)}</dd>
              </div>
            )}
          </dl>
          {phase === "open" &&
            formatDate(current.checkoutExpiresAt ?? null) && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="payment-valid-until"
              >
                {t("payment.checkout.validUntil", {
                  time: formatDate(current.checkoutExpiresAt ?? null) ?? "",
                })}
              </p>
            )}
          {current.status === "pending" && !checkoutUrl && phase === null && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <SmartphoneIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t("payment.pinNotice")}
            </p>
          )}
          {pendingPriceChange && (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-(--brand-orange) p-3 text-sm"
              data-testid="payment-price-changed"
            >
              <p>
                {t("payment.priceChanged.text", {
                  charged: format.fcfa(pendingPriceChange.chargedXaf),
                  displayed: format.fcfa(pendingPriceChange.displayedXaf),
                })}
              </p>
              <Button
                type="button"
                className="h-11 px-5"
                data-testid="payment-price-confirm"
                onClick={() => setPriceChange(null)}
              >
                {t("payment.priceChanged.confirm", {
                  amount: format.fcfa(pendingPriceChange.chargedXaf),
                })}
              </Button>
            </div>
          )}
          {checkoutUrl && (
            <p className="text-xs text-muted-foreground">
              {t("payment.checkout.notice")}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {checkoutUrl && (
              <a
                href={checkoutUrl}
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                data-testid="payment-continue"
                className={`${buttonVariants()} h-11 px-5`}
              >
                <ExternalLinkIcon className="h-4 w-4" aria-hidden />
                {t("payment.checkout.continueAmount", {
                  amount: format.fcfa(current.amount),
                })}
              </a>
            )}
            {current.status !== "succeeded" && current.status !== "failed" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null || rateLimited || !online}
                onClick={() => void verify()}
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${busy === "refresh" ? "animate-spin" : ""}`}
                  aria-hidden
                />
                {busy === "refresh"
                  ? t("payment.checking")
                  : t("payment.verify")}
              </Button>
            )}
            {current.status === "succeeded" && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null}
                onClick={onAccessRestore}
              >
                {restricted ? t("payment.openShop") : t("manager.verify")}
              </Button>
            )}
            {current.status === "failed" && !paymentsDisabled && (
              <Button
                type="button"
                className="h-11 px-5"
                disabled={busy !== null || !online}
                onClick={() => void startNewAttempt()}
              >
                {busy === "read"
                  ? t("payment.checking")
                  : phase === "closed"
                    ? t("payment.chooseOffer")
                    : t("payment.newAttempt")}
              </Button>
            )}
          </div>
          {abandonable && confirmAbandon === null && (
            <div
              className="flex flex-col gap-2 sm:flex-row"
              data-testid="payment-abandon-actions"
            >
              {!paymentsDisabled && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 px-5"
                  disabled={busy !== null || rateLimited || !online}
                  data-testid="payment-change-plan"
                  onClick={() => {
                    setMessage(null);
                    setConfirmAbandon("change");
                  }}
                >
                  {t("payment.abandon.change")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="h-11 px-5"
                disabled={busy !== null || rateLimited || !online}
                data-testid="payment-cancel-attempt"
                onClick={() => {
                  setMessage(null);
                  setConfirmAbandon("cancel");
                }}
              >
                {t("payment.abandon.cancel")}
              </Button>
            </div>
          )}
          {abandonable && confirmAbandon !== null && (
            <div
              role="group"
              aria-labelledby="payment-abandon-title"
              className="space-y-3 rounded-lg border p-3 text-sm"
              data-testid="payment-abandon-confirm"
              data-mode={confirmAbandon}
            >
              <p id="payment-abandon-title" className="font-semibold">
                {confirmAbandon === "change"
                  ? t("payment.abandon.changeTitle")
                  : t("payment.abandon.cancelTitle")}
              </p>
              <p className="text-muted-foreground">
                {t("payment.abandon.explain")}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  className="h-11 px-5"
                  disabled={busy !== null || rateLimited || !online}
                  data-testid="payment-abandon-submit"
                  onClick={() => void requestAbandon(confirmAbandon)}
                >
                  {busy === "abandon"
                    ? t("payment.abandon.working")
                    : confirmAbandon === "change"
                      ? t("payment.abandon.confirmChange")
                      : t("payment.abandon.confirmCancel")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 px-5"
                  disabled={busy === "abandon"}
                  data-testid="payment-abandon-keep"
                  onClick={() => setConfirmAbandon(null)}
                >
                  {t("payment.abandon.keep")}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {message && !(formOpen && !blocking) && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          data-testid="payment-message"
          className={`text-sm ${message.tone === "error" ? "text-destructive" : ""}`}
        >
          {messageText(message)}
        </p>
      )}

      {/* 1-21E : formules consultables pendant qu'un paiement bloque ; la
          validation reste impossible (raison affichée), rien n'est envoyé. */}
      {browsing && blocking && !paymentsDisabled && (
        <section
          aria-labelledby="payment-preview-title"
          className="space-y-4 rounded-xl border p-4"
          data-testid="payment-change-preview"
        >
          <h3 id="payment-preview-title" className="font-semibold">
            {t("payment.abandon.previewTitle")}
          </h3>
          <OfferSelector selected={previewTerm} onSelect={setPreviewTerm} />
          <p
            role="note"
            className="rounded-lg bg-muted p-3 text-sm"
            data-testid="payment-preview-blocked"
          >
            {t("payment.abandon.previewBlocked")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" className="h-11 px-5" disabled>
              {(() => {
                const chosen = SUBSCRIPTION_OFFERS.find(
                  (o) => o.term === previewTerm,
                );
                return chosen
                  ? t("payment.payAmount", {
                      amount: format.fcfa(chosen.totalXaf),
                    })
                  : t("payment.pay");
              })()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-4"
              onClick={() => setBrowsing(false)}
            >
              {t("payment.abandon.close")}
            </Button>
          </div>
        </section>
      )}

      {paymentsDisabled && (
        <p
          role="status"
          className="rounded-lg bg-muted p-3 text-sm"
          data-testid="payment-disabled"
        >
          {t("payment.disabled")}
        </p>
      )}

      {!paymentsDisabled &&
        !blocking &&
        current?.status !== "failed" &&
        !formOpen && (
          <Button
            type="button"
            className="h-11 px-5"
            aria-expanded={formOpen}
            aria-controls="subscription-payment-form"
            onClick={() => {
              setFormOpen(true);
              setMessage(null);
            }}
          >
            {t("payment.renew")}
          </Button>
        )}

      {!paymentsDisabled && !blocking && formOpen && (
        <form
          id="subscription-payment-form"
          aria-labelledby="subscription-payment-form-title"
          className="space-y-4 rounded-xl border p-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <h3 id="subscription-payment-form-title" className="font-semibold">
            {hosted ? t("payment.checkout.formTitle") : t("payment.formTitle")}
          </h3>
          {lockedTerm ? (
            <p
              className="rounded-lg bg-muted p-3 text-sm"
              data-testid="payment-locked-intent"
            >
              {rich(
                t(
                  hosted
                    ? "payment.checkout.lockedIntent"
                    : "payment.lockedIntent",
                  { term: termText(lockedTerm) },
                ),
                { b: (chunk) => <strong>{chunk}</strong> },
              )}
            </p>
          ) : (
            <>
              <OfferSelector selected={term} onSelect={setTerm} />
              <OfferConditions />
            </>
          )}
          {hosted ? (
            <p className="text-xs text-muted-foreground">
              {t("payment.checkout.help")}
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="payer-phone">{t("payment.phoneLabel")}</Label>
              <Input
                id="payer-phone"
                name="payerPhone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="6XX XX XX XX"
                maxLength={32}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                aria-describedby="payer-phone-help"
                className="h-11"
              />
              <p
                id="payer-phone-help"
                className="text-xs text-muted-foreground"
              >
                {t("payment.phoneHelp")}
              </p>
            </div>
          )}
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg bg-muted p-3 text-sm"
            data-testid="payment-summary"
          >
            {offer ? (
              <p>
                {rich(
                  t("payment.summary", {
                    amount: format.fcfa(offer.totalXaf),
                    term: t(`offers.term.${offer.term}`),
                  }),
                  { b: (chunk) => <strong>{chunk}</strong> },
                )}
              </p>
            ) : (
              <p>{t("payment.summaryEmpty")}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              className="h-11 px-5"
              disabled={busy !== null || rateLimited || !online || !offer}
              data-testid="payment-submit"
            >
              {busy === "create"
                ? t("payment.sending")
                : offer
                  ? t(
                      hosted
                        ? "payment.checkout.continueAmount"
                        : "payment.payAmount",
                      { amount: format.fcfa(offer.totalXaf) },
                    )
                  : t("payment.pay")}
            </Button>
            {!lockedTerm && (
              <Button
                type="button"
                variant="ghost"
                className="h-11 px-4"
                disabled={busy === "create"}
                onClick={() => {
                  setFormOpen(false);
                  setPhone("");
                  setMessage(null);
                }}
              >
                {t("payment.cancel")}
              </Button>
            )}
          </div>
        </form>
      )}

      {/* 1-21B : un seul emplacement du message — sous le formulaire quand
          il est ouvert, plus haut sinon (auparavant affiché deux fois). */}
      {message && !blocking && formOpen && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          data-testid="payment-message"
          className={`text-sm ${message.tone === "error" ? "text-destructive" : ""}`}
        >
          {messageText(message)}
        </p>
      )}

      <section
        aria-labelledby="payment-history-title"
        className="space-y-3"
        data-testid="payment-history"
      >
        <h3 id="payment-history-title" className="font-semibold">
          {t("payment.historyTitle")}
        </h3>
        {historyError && (
          <p role="alert" className="text-sm text-destructive">
            {t(`payment.${historyError}`)}
          </p>
        )}
        {history.length === 0 && !historyError ? (
          <p className="text-sm text-muted-foreground">
            {t("payment.historyEmpty")}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {history.map((payment) => (
              <li
                key={payment.paymentId}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                data-testid="payment-history-item"
                data-status={payment.status}
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    {termText(payment.term)} · {format.fcfa(payment.amount)}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {payment.reference}
                  </span>
                </span>
                <span className="flex flex-col gap-1 text-xs sm:items-end sm:text-right">
                  <span className="block font-medium">
                    {historyLabel(payment)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(payment.confirmedAt ?? payment.createdAt)}
                  </span>
                  {receiptAvailable(payment) && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 px-3 text-xs"
                      disabled={busy !== null}
                      data-testid="payment-receipt-open"
                      onClick={() => void openReceipt(payment.paymentId)}
                    >
                      <ReceiptTextIcon className="h-4 w-4" aria-hidden />
                      {t("payment.receipt.open")}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {receipt && (
          <article
            aria-labelledby="payment-receipt-title"
            className="space-y-4 rounded-xl border bg-background p-4 text-sm"
            data-testid="payment-receipt"
            data-print-receipt="active"
          >
            <header className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {receipt.issuer.name}
              </p>
              <h4
                id="payment-receipt-title"
                className="text-base font-semibold"
              >
                {t("payment.receipt.title")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t("payment.receipt.notInvoice")}
              </p>
            </header>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.number")}
                </dt>
                <dd className="break-all font-mono text-xs leading-5">
                  {receipt.receiptNumber}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.paidAt")}
                </dt>
                <dd>{formatDate(receipt.paidAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.organization")}
                </dt>
                <dd className="break-words">{receipt.organization.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.plan")}
                </dt>
                <dd>{termText(receipt.term)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.amountPaid")}
                </dt>
                <dd
                  className="font-semibold"
                  data-testid="payment-receipt-amount"
                >
                  {receiptAmount(receipt.amountPaidMinor)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("payment.receipt.method")}
                </dt>
                <dd>
                  {receipt.provider === "saspay" ? "SasPay" : receipt.provider}
                </dd>
              </div>
              {receipt.providerTransactionId && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    {t("payment.receipt.transaction")}
                  </dt>
                  <dd className="break-all font-mono text-xs leading-5">
                    {receipt.providerTransactionId}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">
                  {t("payment.receipt.period")}
                </dt>
                <dd data-testid="payment-receipt-period">
                  {receipt.application === "refunded"
                    ? t("payment.receipt.refunded", {
                        date: formatDate(receipt.refundedAt ?? null) ?? "",
                      })
                    : receipt.period
                      ? t("payment.receipt.periodRange", {
                          from: formatDate(receipt.period.startsAt) ?? "",
                          to: formatDate(receipt.period.endsAt) ?? "",
                        })
                      : t("payment.receipt.inResolution")}
                </dd>
              </div>
            </dl>
            <div className="flex flex-col gap-2 sm:flex-row print:hidden">
              <Button
                type="button"
                className="h-11 px-5"
                data-testid="payment-receipt-print"
                onClick={() => window.print()}
              >
                <PrinterIcon className="h-4 w-4" aria-hidden />
                {t("payment.receipt.print")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 px-4"
                onClick={() => setReceipt(null)}
              >
                {t("payment.receipt.close")}
              </Button>
            </div>
          </article>
        )}
        {nextCursor && (
          <Button
            type="button"
            variant="outline"
            className="h-11 px-5"
            disabled={busy !== null}
            onClick={() => void loadMore()}
          >
            {busy === "history"
              ? t("payment.loadingMore")
              : t("payment.showMore")}
          </Button>
        )}
      </section>
    </div>
  );
}
