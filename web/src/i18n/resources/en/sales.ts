import type salesFr from "../fr/sales";
import type { Translation } from "../types";

const salesEn: Translation<typeof salesFr> = {
  loading: "Loading…",
  seller: "Seller:",
  buyer: "Buyer:",
  syncNow: "Sync now",
  pendingOnDevice: "Pending sales on this device",
  pendingOnDeviceCount: "Pending sales on this device ({{count}})",
  actions: {
    cancel: "Cancel",
    back: "Back",
    delete: "Delete",
    save: "Save",
    retry: "Try again",
  },
  nav: {
    pendingCount_one: "{{count}} pending sale",
    pendingCount_other: "{{count}} pending sales",
    pendingShort: "pending",
    pendingBadge: "Pending sales:",
  },
  list: {
    allTitle: "All sales",
    ownTitle: "My sales",
    recordOnly:
      "You can record sales from a product page. You do not have permission to view the list of sales.",
    noPermission: "You do not have permission to view sales.",
    empty: "No sales recorded.",
    nameNotKept: "(name not kept)",
    productDeleted: "Product deleted",
    nameNotRecorded: "name not recorded at the time of sale",
    renamedTo: "Now: {{name}}",
    // 1-20E: paginated history.
    page: {
      summary_one: "{{count}} sale · page {{page}}",
      summary_other: "{{count}} sales · page {{page}}",
      complete_one: "{{count}} sale",
      complete_other: "{{count}} sales",
      first: "Most recent",
      previous: "Newer",
      next: "Older",
      navLabel: "Sales history pages",
      newer: "New sales have been recorded.",
      showNewer: "Show most recent",
    },
  },
  pendingPage: {
    back: "Sales",
    title: "Pending sales",
    text: "Sales recorded on this device and not yet confirmed by the server. None is deleted without your agreement.",
  },
  form: {
    title: "Sale",
    titleFix: "Correct the sale",
    offline:
      "The sale will be saved on this device and sent when the connection comes back.",
    quantity: "Quantity",
    stock: "Stock: {{count}}",
    indicativeStock: "Indicative stock: {{count}}",
    actualPrice: "Actual sale price (FCFA)",
    total: "Total: {{amount}}",
    buyerName: "Buyer name (optional)",
    buyerNamePlaceholder: "First name / Last name",
    buyerContact: "Buyer contact (optional)",
    buyerContactPlaceholder: "Phone or email",
    indicativeNote:
      "Sales of this product are waiting to be sent: the stock shown is indicative.",
    seePending: "See pending sales",
    sending: "Sending…",
    saving: "Saving…",
    saveFix: "Save the correction",
    confirm: "Confirm the sale",
    record: "Record a sale",
    recorded: "Sale recorded",
    conflictHint: "See “Pending sales” to correct it.",
    pending: "Sale saved on this device, waiting to be synchronised",
    pendingHint:
      "It will be sent automatically when the connection comes back.",
    errors: {
      quantity: "The quantity must be a whole number of 1 or more.",
      aboveIndicative: "Quantity above the indicative stock ({{max}}).",
      aboveStock: "Quantity above the available stock ({{max}}).",
      price: "The price must be a positive number or zero.",
      buyerLength: "Name and contact: {{max}} characters maximum.",
    },
    refusal: {
      capability: "Recording sales is not allowed on this device.",
      identity: "Session not verified on this device: log in again.",
      invalid: "Invalid sale details.",
      limit:
        "Limit of 200 pending sales reached: synchronise them before entering more.",
      unavailable: "Local storage unavailable: sale not saved.",
      "not-replaceable": "This sale can no longer be corrected.",
    },
    batchTracked:
      "Batch sales unavailable on this device: go online to load this product's batches.",
  },
  edit: {
    title: "Edit the sale",
    price: "Sale price (FCFA)",
    updated: "Sale updated",
    deleted: "Sale deleted",
    deleteTitle: "Delete this sale?",
    deleteText:
      "The stock will be restored automatically. This action cannot be undone.",
    deleting: "Deleting…",
    soldFromBatch_one: "{{count}} sold from this batch",
    soldFromBatch_other: "{{count}} sold from this batch",
    batchesTitle: "Batches of this sale",
    returnsTitle: "Batches to credit ({{count}} unit(s) to give back)",
    addTitle: "Batches for the added units",
    legacyTitle: "Units whose original batch is unknown",
    legacyText:
      "This sale predates batch tracking: no batch is assigned to it. Say which batches the returned units go back to. This is not a receipt.",
    legacyNoRight: "Returning these units requires the right to adjust stock.",
    destinationFor: "Units put back into {{reference}}",
    historical: "Create a “historical batch, date unknown” for these units",
    historicalQuantity: "Units in the historical batch",
    historicalConfirm:
      "I confirm the batch of these units is unknown (no date will be assigned).",
    reason: "Reason for the return",
    errors: {
      returns: "The credited batches must add up to the units given back.",
      legacy:
        "The units put back must add up to the returned units of unknown batch.",
      reason: "Give a reason of at least 3 characters.",
      historicalConfirm: "Confirm creating the historical batch.",
    },
    deleteBatchText:
      "The units will go back exactly to their original batches: {{list}}. This cannot be undone.",
    deleteLegacyText:
      "Sale made before batch tracking: say where to put the {{count}} unit(s) back, with a reason.",
  },
  logout: {
    title: "Sales not synchronised",
    description_one:
      "{{count}} sale saved on this device has not yet been confirmed by the server.",
    description_other:
      "{{count}} sales saved on this device have not yet been confirmed by the server.",
    descriptionOrganizations_one:
      "{{count}} sale saved on this device ({{organizations}} organisations) has not yet been confirmed by the server.",
    descriptionOrganizations_other:
      "{{count}} sales saved on this device ({{organizations}} organisations) have not yet been confirmed by the server.",
    syncing: "Synchronising… (10 s max)",
    keep: "Log out and keep them on this device",
    delete: "Delete permanently…",
    deleteWarning:
      "These sales will be erased from this device and will NEVER be sent to the server. This cannot be undone.",
    deleteFailed:
      "Deletion failed: nothing was erased. Try again or keep the sales.",
    deleteConfirm: "Delete permanently and log out",
  },
  outbox: {
    loading: "Loading local sales…",
    unreadable:
      "Local sales cannot be read for this session. Log in again to access them; they are still kept on this device.",
    counts: {
      pending: "Pending",
      syncing: "Sending",
      conflict: "To resolve",
    },
    status: {
      pending: "Pending",
      syncing: "Sending",
      synced: "Synchronised",
      conflict: "To resolve",
      abandoned: "Abandoned",
    },
    blocked: {
      suspended:
        "Sending paused: this shop is suspended by Stock Master. Sales stay on this device and will be sent after reactivation.",
      subscription:
        "Sending paused: this shop's subscription is not active. The sales stay on this device and will be sent after the renewal.",
      accessDenied:
        "Sending paused: the server refused access (session, rights or organisation). Log in again or contact an administrator; the sales stay on this device.",
      corruption:
        "Sending paused: an inconsistency was detected. Note the sales concerned and contact support before removing the operation.",
    },
    resumeOnline:
      "Sending will resume automatically when the connection comes back, with the app open.",
    empty: "No pending sales on this device.",
    listLabel: "Unfinished sales",
    actionFailed: "Action not possible.",
    recentlySynced: "Recently synchronised ({{count}})",
    syncedRetention: "Erased automatically from this device after 7 days.",
    cancelledLater: "Cancelled afterwards",
    confirmed: "Confirmed",
    attempts_one: "Attempts: {{count}}.",
    attempts_other: "Attempts: {{count}}.",
    confirm: {
      removeTitle: "Remove this sale from the queue?",
      abandonTitle: "Abandon this sale?",
      mayBeRecorded:
        "Warning: the server may already have recorded this sale. Check the list of sales before abandoning it.",
      neverSent: "This sale will never be sent to the server.",
      staysVisible:
        "It will no longer be offered for sending and will stay visible on this device (no silent deletion).",
    },
    actions: {
      edit: "Correct",
      retry: "Try again",
      abandon: "Abandon",
      remove: "Remove",
      removeFromQueue: "Remove from the queue",
      regularize: "Regularise",
      requestRegularization: "Request a regularisation",
    },
    errors: {
      insufficientStock: "Not enough stock on the server.",
      productNotFound: "Product not found or deleted.",
      batchTracked:
        "Product tracked by batches: sale refused by the server. Correct it by choosing the batches.",
      dateOutOfRange: "Sale date outside the allowed period.",
      validationFailed: "Sale details refused by the server.",
      expired: "Sale pending for more than 14 days: not sent automatically.",
      serverUnavailable: "Server unavailable after several attempts.",
      alreadyApplied: "Already recorded by the server, then cancelled.",
      inconsistency:
        "Inconsistency detected: note this sale and contact support.",
      accessDenied: "Access refused by the server.",
      subscriptionInactive:
        "Shop subscription inactive: sale kept, will be sent after renewal.",
      organizationSuspended:
        "Shop suspended: sale kept, will be sent after reactivation.",
      network: "Network unavailable, automatic retry.",
      server: "Sending temporarily impossible, automatic retry.",
      auth: "Session expired or access refused.",
      refused: "Sale refused by the server.",
      batchAllocationRequired:
        "Product tracked by batches: choose the batches sold (Correct).",
      batchInsufficient:
        "A chosen batch no longer has enough units: correct the split.",
      batchUnavailable:
        "A chosen batch is no longer available: correct the split.",
      batchExpired:
        "A chosen batch is past its expiry date: it cannot be sold.",
      batchExpiredAtSync:
        "Sale entered before the batch expired, received after: a manager must regularise it.",
      batchExpiryUnconfirmed:
        "A batch without an expiry date must be confirmed: correct the sale.",
      batchMismatch: "The batches do not match the quantity: correct the sale.",
      batchesDisabled: "Batch sales are not available at the moment.",
    },
    regularize: {
      title: "Regularise this sale",
      text: "The sale was entered on {{date}}, before the batch expired, but received after. Regularising records it with its real time, without allowing any other sale of this batch.",
      reason: "Reason (required)",
      reasonPlaceholder: "E.g. sold offline before midnight",
      confirm: "Regularise",
      noRight:
        "An authorised manager must regularise this sale: send them the request. It stays pending on this device.",
      reasonTooShort: "Give a reason of at least 3 characters.",
      requestTitle: "Request a regularisation",
      requestText:
        "The sale, its batches and the time declared by this device ({{date}}, not verified) will be sent to a manager. Nothing is recorded before their approval.",
      requestConfirm: "Send the request",
      requested: "Request sent to a manager.",
      awaiting:
        "Request sent ({{date}}): waiting for a manager's decision. The sale is not recorded yet.",
      rejected: "Regularisation rejected: {{reason}}",
    },
  },
  batches: {
    title: "Batches given to the customer",
    loading: "Loading batches…",
    noCache:
      "Batches unavailable offline for this product: go online to load them.",
    hintOnline:
      "Suggested by nearest expiry. Adjust it to the units actually handed over. Nothing is reserved before confirmation.",
    hintOffline:
      "Offline: availability not checked, nothing is reserved. The server will confirm when syncing.",
    none: "No sellable batch for this product.",
    datedLabel: "Dated batches, nearest expiry first",
    undatedLabel: "Batches without an expiry date",
    undatedWarning:
      "Batches with no known expiry date: no guarantee of validity.",
    undatedConfirm: "I confirm selling units whose expiry date is unknown.",
    expiresToday: "Expires today",
    expiresTodayOffline:
      "A batch expires today: if the sale is not synced before midnight, it will need to be regularised.",
    expiry: "Expiry: {{date}}",
    noExpiry: "No date",
    available_one: "{{count}} available",
    available_other: "{{count}} available",
    quantityFor: "Quantity from batch {{reference}}",
    expiredExcluded_one: "{{count}} expired batch is not offered.",
    expiredExcluded_other: "{{count}} expired batches are not offered.",
    allocated: "Split: {{allocated}} / {{total}}",
    errors: {
      sum: "The batches must add up to the quantity sold.",
      unknownUnconfirmed: "Confirm selling units without an expiry date.",
      aboveAvailable: "A batch does not have enough units available.",
    },
    saleLots: "Batches: {{list}}",
    regularized: "Regularised (batch expired on receipt): {{reason}}",
    corrected_one: "{{count}} batch correction",
    corrected_other: "{{count}} batch corrections",
    originUnknown: "Sale made before batch tracking: original batch unknown.",
  },
  regularizations: {
    title_one: "Regularisations to review ({{count}})",
    title_other: "Regularisations to review ({{count}})",
    intro:
      "Offline sales entered before a batch expired but received after. The declared time comes from the seller's device and is not verified.",
    seller: "Seller:",
    declared: "Declared time (device, not verified):",
    received: "Received by the server:",
    expired: "Batches expired on receipt:",
    decision: "Decision:",
    decisionBy: "{{name}}, {{date}} — {{reason}}",
    approve: "Approve",
    reject: "Reject",
    approveTitle: "Approve the regularisation",
    approveText:
      "The sale will be recorded in the name of {{seller}}, at the declared time ({{date}}), with the same batches. You will be its approver.",
    rejectTitle: "Reject the request",
    rejectText:
      "No sale will be recorded. The request and your reason remain viewable.",
    approved: "Sale regularised.",
    rejectedDone: "Request rejected.",
    status: {
      pending: "Pending",
      approved: "Approved",
      rejected: "Rejected",
    },
  },
};

export default salesEn;
