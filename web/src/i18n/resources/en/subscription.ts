import type subscriptionFr from "../fr/subscription";
import type { Translation } from "../types";

const subscriptionEn: Translation<typeof subscriptionFr> = {
  offers: {
    term: {
      monthly: "1 month",
      quarterly: "3 months",
      semiannual: "6 months",
      annual: "12 months",
    },
    pitch: {
      monthly: {
        title: "Start at your own pace",
        text: "One month to run your business day to day.",
      },
      quarterly: { title: "Get three months ahead" },
      semiannual: { title: "Six months to grow your business" },
      annual: { title: "A full year of management" },
      withFreeMonths_one: "{{title}}, {{count}} month free",
      withFreeMonths_other: "{{title}}, {{count}} months free",
      saving: "Save {{amount}} compared with paying monthly.",
    },
    best: "Best savings",
    paidOnce: "paid once for {{term}}",
    monthlyEquivalent: "About {{amount}} per month, for comparison only.",
    included: {
      catalog: "Catalogue, stock and sales",
      converter: "EUR ↔ FCFA converter",
      analytics: "Analytics and trash",
      members: "Members and permissions",
    },
    ctaLabel: "{{label}} — {{term}} plan",
    selectorLabel: "Renewal length",
    conditions: {
      features:
        "Same features for every length, according to each member's rights.",
      perShop: "One subscription per shop, no extra charge per seller.",
      noAutoPay: "No automatic payment: every renewal is voluntary.",
    },
  },
  overview: {
    dateAt: "{{date}} at {{time}}",
    state: {
      trial: "Free trial in progress",
      active: "Subscription active",
      expired: "Subscription expired",
      scheduled: "Upcoming period",
      none: "No subscription",
    },
    trial: "Free trial",
    offered: "Extension offered by Stock Master",
    subscriptionTerm: "{{term}} subscription",
    lessThanDay: "less than a day",
    days_one: "{{count}} day",
    days_other: "{{count}} days",
    status: "Status",
    currentPeriod: "Current period",
    fromTo: "from {{from}} to {{to}}",
    accessEnded: "Access ended on",
    accessUntil: "Access covered until",
    remaining: "Time left: {{remaining}}",
    nextPeriod: "Next period",
    startingOn: "starting {{date}}",
    historyTitle: "Period history",
    historyEmpty: "No periods.",
    historyNote:
      "History of access periods, without amounts: payments and their receipts are listed in the payment history.",
  },
  manager: {
    checkUnavailable: "Check temporarily unavailable.",
    infoUnavailable: "Subscription information unavailable.",
    loading: "Loading subscription…",
    verify: "Check my subscription",
    renewal: "Renewal",
    paymentUnavailable:
      "Payment temporarily unavailable. Use “Check my subscription”.",
  },
  page: {
    title: "Subscription",
    loading: "Loading…",
    ownerOnly: "Only the shop owner can manage the subscription.",
    verified: "Subscription checked.",
  },
  block: {
    title: {
      expired: "This shop's subscription has expired",
      none: "This shop has no active subscription",
      scheduled: "This shop's subscription has not started yet",
      active: "This shop's subscription is active",
      inactive: "This shop's subscription is not active",
    },
    text: {
      offline:
        "You are offline. The check will resume when the connection comes back.",
      activeLimited: "Use “Check my subscription” to get access back.",
      owner: "Renew the subscription to get access to your shop back.",
      member: "Contact the owner to renew.",
    },
    verifyAccess: "Check access",
    logout: "Log out",
  },
  verify: {
    stillInactive: "The subscription is still not active.",
    stale: "The session has changed: reload the page.",
    offline: "Checking is not possible offline.",
  },
  access: {
    yourShop: "Your shop",
    retry: "Try again",
  },
  localSales: {
    unreadable:
      "Local sales cannot be read for this session: they are still kept on this device.",
    title_one: "Pending sale on this device ({{count}})",
    title_other: "Pending sales on this device ({{count}})",
    text: "They are kept and will be sent after the renewal.",
  },
  payment: {
    status: {
      initiating: {
        label: "Request in progress",
        lower: "request in progress",
        detail: "The payment request is being sent to the operator.",
      },
      pending: {
        label: "Waiting for payment",
        lower: "waiting for payment",
        detail:
          "Approve the payment on the payer's phone, then tap “Check payment”.",
      },
      uncertain: {
        label: "Result to check",
        lower: "result to check",
        detail:
          "Sending could not be confirmed. Check this payment: no new request will be sent.",
      },
      review: {
        label: "Review needed",
        lower: "review needed",
        detail:
          "This payment must be reviewed by our team. No new request is possible in the meantime.",
      },
      failed: {
        label: "Failure confirmed",
        lower: "failure confirmed",
        detail: "The operator confirmed that this payment did not go through.",
      },
      succeeded: {
        label: "Payment confirmed",
        lower: "payment confirmed",
        detail:
          "The payment is confirmed and the subscription has been extended.",
      },
    },
    errors: {
      "no-response":
        "No response received. Nothing is lost: check your connection, then try again.",
      unexpected:
        "No response received. Nothing is lost: check your connection, then try again.",
      unauthorized: "Your session has expired. Log in again.",
      unauthorizedRestricted:
        "Your session has expired. Log in again: your payment will be found.",
      forbidden: "Access denied for this shop.",
      "already-pending": "A payment is already in progress for this shop.",
      "operation-conflict":
        "This request was already sent with different details. Enter exactly the same number.",
      "invalid-phone":
        "Invalid Cameroonian Mobile Money number (e.g. 6XX XX XX XX).",
      "invalid-request": "Invalid request. Check the details you entered.",
      "not-found": "Payment not found for this shop.",
      "rate-limited":
        "Too many requests for this shop. Nothing is lost: wait a moment, then try again without creating a new payment.",
      "service-unavailable":
        "Online payment is unavailable at the moment. Try again later.",
      "status-unavailable":
        "This payment cannot be checked at the moment. It is kept: try again later.",
      "confirmation-pending":
        "Payment being confirmed. Check again in a moment.",
      "change-unavailable":
        "This payment cannot be replaced: wait for its result, then check it.",
      "receipt-unavailable": "No receipt: this payment was not collected.",
    },
    messages: {
      checkoutReady:
        "Payment link ready. Continue to the payment page: the subscription becomes active once our server confirms the payment.",
      offlineCreate: "Offline: creating a payment needs the Internet.",
      termRequired: "Choose a length.",
      phoneRequired: "Enter the payer's Mobile Money number.",
      replayed: "Request found: no new payment was requested.",
      sent: "Request sent. The subscription will be active once the payment is confirmed.",
      confirmed: "Payment confirmed. Restoring access…",
      checkoutClosed:
        "SasPay confirms the payment page is closed, with no transaction. You can choose a plan.",
      expiredAwaitingClosure:
        "The link has expired. We are waiting for the provider to confirm the closure before allowing a new attempt.",
      closureUnconfirmed:
        "The payment page is closed, but SasPay did not confirm that no transaction exists: the attempt remains under resolution.",
      renewalSuspended:
        "An earlier attempt of this renewal was paid: this payment is suspended pending resolution.",
      collectedInResolution:
        "Payment received: it needs to be checked by our team before it is applied. It is neither lost nor refused.",
      offlineVerify: "Offline: checking needs the Internet.",
      statusChecked: "Status checked: {{status}}.",
      statusNow: "This payment is now: {{status}}.",
    },
    loading: "Loading payments…",
    offline: "Offline: creating and checking a payment need the Internet.",
    term: "Length",
    totalAmount: "Total amount",
    payer: "Payer",
    reference: "Reference",
    requestedOn: "Requested on",
    confirmedOn: "Confirmed on",
    checkout: {
      formTitle: "Pay online",
      help: "Payment happens on SasPay's secure page (MTN or Orange Mobile Money). No number or secret code is requested here.",
      continueAmount: "Continue to pay {{amount}}",
      notice:
        "Then come back to Stock Master: the subscription is activated only after our server confirms the payment, never just by returning from the page.",
      pendingDetail:
        "Finish the payment on the SasPay page, then come back here and press “Check payment”.",
      lockedIntent:
        "An earlier request got no answer. Submit again to find it: no second payment will be requested. Length: <b>{{term}}</b>.",
      validUntil: "Payment link valid until {{time}}.",
    },
    situation: {
      expired: {
        label: "Payment page expired",
        detail:
          "The link has expired. We are waiting for the provider to confirm the closure before allowing a new attempt.",
      },
      closureUnconfirmed: {
        label: "Closure to be confirmed by SasPay",
        detail:
          "The payment page is closed, but SasPay did not state that no transaction was started on it. No new payment is possible until it confirms; you can browse the plans meanwhile.",
      },
      renewalSuspended: {
        label: "Payment suspended",
        detail:
          "An earlier attempt of this renewal was paid. To avoid a second charge, this payment is no longer offered until our team resolves it.",
      },
      refunded: {
        label: "Payment refunded",
        detail:
          "This payment was refunded by our team. It did not extend any subscription period.",
      },
      collectedInResolution: {
        label: "Payment received, under resolution",
        detail:
          "SasPay confirmed this payment, but it belongs to a replaced attempt or an already settled renewal. It is recorded and will be handled by our team (applied or refunded, with your agreement). The subscription has not been extended by this payment yet.",
      },
      linkMissing: {
        label: "Payment link not retrieved",
        detail:
          "The payment page may have been created at SasPay, but its link was not received. “Check payment” retrieves it without creating a new one.",
      },
      attemptUnresolved: {
        label: "Attempt to be confirmed by SasPay",
        detail:
          "The payment page closed after an attempt that did not go through. SasPay does not guarantee that a failed attempt can no longer be validated: no new payment is possible until it is confirmed. If you were not charged, contact support with the reference below.",
      },
      closed: {
        label: "Payment page closed without payment",
        lower: "closed without payment",
        detail:
          "SasPay confirms this page is closed and no transaction was started on it. You can choose a plan.",
      },
    },
    abandon: {
      change: "Change plan",
      cancel: "Cancel this attempt",
      changeTitle: "Change plan?",
      cancelTitle: "Cancel this attempt?",
      explain:
        "Stock Master first checks this payment with SasPay. If no payment was started, the current payment page is closed at SasPay. If the payment already went through, it is confirmed and nothing is cancelled.",
      confirmChange: "Close the SasPay page and change plan",
      confirmCancel: "Close the SasPay page and cancel",
      keep: "Keep this payment",
      working: "Checking with SasPay…",
      outcome: {
        releasedChange:
          "SasPay confirms the previous page is closed, with no transaction. Choose your plan.",
        releasedCancel:
          "Attempt cancelled: SasPay confirms the payment page is closed, with no transaction.",
        "in-progress":
          "A payment is being validated at SasPay: it cannot be cancelled. Wait for its result, then press “Check payment”.",
        "attempt-recorded":
          "A payment attempt was already recorded on this page. SasPay does not guarantee that a failed attempt can no longer be validated: the page was not closed. You can still pay on the same page; otherwise, changing plan will be possible once this attempt is resolved.",
        "awaiting-resolution":
          "This payment cannot be cancelled safely: it needs to be resolved (support). No new payment is possible in the meantime.",
        "not-found-at-provider":
          "SasPay has not found this payment page yet. It is not cancelled: try “Check payment” again in a moment.",
        "provider-incomplete":
          "SasPay's answer does not confirm that no transaction exists on this page: it was not closed. Try again in a moment; you can browse the plans meanwhile.",
        "cancel-unconfirmed":
          "SasPay did not confirm the page was closed: the attempt remains open. Try again in a moment.",
      },
      previewTitle: "Choose another plan",
      previewBlocked:
        "You can compare plans, but a new payment can only be validated once the current payment is resolved.",
      close: "Close",
    },
    priceChanged: {
      text: "The price has changed since this page was opened: this payment is {{charged}}, not {{displayed}}. Check this amount before continuing.",
      confirm: "Continue with {{amount}}",
    },
    disabled:
      "Online payment is temporarily unavailable. You can still view and check a payment in progress.",
    pinNotice:
      "The Mobile Money PIN is entered only on the payer's phone. Stock Master never asks for it.",
    checking: "Checking…",
    verify: "Check payment",
    openShop: "Go to my shop",
    newAttempt: "Try again",
    receipt: {
      open: "Receipt",
      title: "Payment receipt",
      notInvoice:
        "This receipt confirms a collected payment. It is not an invoice.",
      number: "Receipt no.",
      paidAt: "Paid on",
      organization: "Shop",
      plan: "Plan",
      amountPaid: "Amount paid",
      method: "Payment method",
      transaction: "Transaction reference",
      period: "Subscription period",
      periodRange: "from {{from}} to {{to}}",
      inResolution:
        "Payment received, being checked before it is applied: no period granted yet.",
      refunded:
        "Payment refunded on {{date}}: no period granted by this payment.",
      print: "Print",
      close: "Close",
    },
    chooseOffer: "Choose a plan",
    renew: "Renew",
    formTitle: "Pay with Mobile Money",
    lockedIntent:
      "A previous request did not get a response. Enter <b>the same number</b> again to find it: no second payment will be requested. Length: <b>{{term}}</b>.",
    phoneLabel: "Payer's Mobile Money number",
    phoneHelp:
      "MTN Mobile Money or Orange Money (Cameroon). The payer will approve on their phone; no PIN is asked for here.",
    summary:
      "Total amount: <b>{{amount}}</b> for <b>{{term}}</b>. The subscription will be extended once the payment is confirmed.",
    summaryEmpty: "Select a length to see the total amount.",
    sending: "Sending…",
    payAmount: "Pay {{amount}}",
    pay: "Pay",
    cancel: "Cancel",
    historyTitle: "Payment history",
    historyUnavailable: "Payment history unavailable.",
    historyMore: "More payments could not be loaded.",
    historyEmpty: "No payments.",
    loadingMore: "Loading…",
    showMore: "Show more",
  },
};

export default subscriptionEn;
