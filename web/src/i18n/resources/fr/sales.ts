// 1-16G — Ventes : saisie, correction, liste, ventes en attente (outbox).
const salesFr = {
  loading: "Chargement…",
  seller: "Vendeur :",
  buyer: "Acheteur :",
  syncNow: "Synchroniser maintenant",
  pendingOnDevice: "Ventes en attente sur cet appareil",
  pendingOnDeviceCount: "Ventes en attente sur cet appareil ({{count}})",
  actions: {
    cancel: "Annuler",
    back: "Retour",
    delete: "Supprimer",
    save: "Enregistrer",
    retry: "Réessayer",
  },
  nav: {
    pendingCount_one: "{{count}} vente en attente",
    pendingCount_many: "{{count}} ventes en attente",
    pendingCount_other: "{{count}} ventes en attente",
    pendingShort: "en attente",
    pendingBadge: "Ventes en attente :",
  },
  list: {
    allTitle: "Toutes les ventes",
    ownTitle: "Mes ventes",
    recordOnly:
      "Tu peux enregistrer des ventes depuis la fiche d'un produit. Tu n'as pas la permission de consulter la liste des ventes.",
    noPermission: "Tu n'as pas la permission de consulter les ventes.",
    empty: "Aucune vente enregistrée.",
    nameNotKept: "(nom non conservé)",
    productDeleted: "Produit supprimé",
    nameNotRecorded: "nom non enregistré lors de la vente",
    renamedTo: "Désormais : {{name}}",
    // 1-20E : historique paginé.
    page: {
      summary_one: "{{count}} vente · page {{page}}",
      summary_many: "{{count}} ventes · page {{page}}",
      summary_other: "{{count}} ventes · page {{page}}",
      complete_one: "{{count}} vente",
      complete_many: "{{count}} ventes",
      complete_other: "{{count}} ventes",
      first: "Plus récentes",
      previous: "Précédentes",
      next: "Plus anciennes",
      navLabel: "Pages de l'historique des ventes",
      newer: "De nouvelles ventes ont été enregistrées.",
      showNewer: "Voir les plus récentes",
    },
  },
  pendingPage: {
    back: "Ventes",
    title: "Ventes en attente",
    text: "Ventes enregistrées sur cet appareil et pas encore confirmées par le serveur. Aucune n'est supprimée sans ton accord.",
  },
  form: {
    title: "Vente",
    titleFix: "Corriger la vente",
    offline:
      "La vente sera enregistrée sur cet appareil et envoyée au retour de la connexion.",
    quantity: "Quantité",
    stock: "Stock : {{count}}",
    indicativeStock: "Stock indicatif : {{count}}",
    actualPrice: "Prix de vente réel (FCFA)",
    total: "Total : {{amount}}",
    buyerName: "Nom acheteur (optionnel)",
    buyerNamePlaceholder: "Prénom / Nom",
    buyerContact: "Contact acheteur (optionnel)",
    buyerContactPlaceholder: "Téléphone ou email",
    indicativeNote:
      "Des ventes de ce produit sont en attente d'envoi : le stock affiché est indicatif.",
    seePending: "Voir les ventes en attente",
    sending: "Envoi…",
    saving: "Enregistrement…",
    saveFix: "Enregistrer la correction",
    confirm: "Confirmer la vente",
    record: "Enregistrer une vente",
    recorded: "Vente enregistrée",
    conflictHint: "Voir « Ventes en attente » pour la corriger.",
    pending:
      "Vente enregistrée sur cet appareil, en attente de synchronisation",
    pendingHint: "Elle sera envoyée automatiquement au retour de la connexion.",
    errors: {
      quantity: "La quantité doit être un entier supérieur ou égal à 1.",
      aboveIndicative: "Quantité supérieure au stock indicatif ({{max}}).",
      aboveStock: "Quantité supérieure au stock disponible ({{max}}).",
      price: "Le prix doit être un nombre positif ou nul.",
      buyerLength: "Nom et contact : {{max}} caractères maximum.",
    },
    refusal: {
      capability: "Saisie de vente non autorisée sur cet appareil.",
      identity: "Session non vérifiée sur cet appareil : reconnecte-toi.",
      invalid: "Données de vente invalides.",
      limit:
        "Limite de 200 ventes en attente atteinte : synchronise-les avant d'en saisir d'autres.",
      unavailable: "Stockage local indisponible : vente non enregistrée.",
      "not-replaceable": "Cette vente ne peut plus être corrigée.",
    },
    batchTracked:
      "Vente par lots indisponible sur cet appareil : connectez-vous pour charger les lots de ce produit.",
  },
  edit: {
    title: "Modifier la vente",
    price: "Prix de vente (FCFA)",
    updated: "Vente mise à jour",
    deleted: "Vente supprimée",
    deleteTitle: "Supprimer cette vente ?",
    deleteText:
      "Le stock sera restauré automatiquement. Cette action est irréversible.",
    deleting: "Suppression…",
    soldFromBatch_one: "{{count}} vendue dans ce lot",
    soldFromBatch_many: "{{count}} vendues dans ce lot",
    soldFromBatch_other: "{{count}} vendues dans ce lot",
    batchesTitle: "Lots de cette vente",
    returnsTitle: "Lots à créditer ({{count}} unité(s) à rendre)",
    addTitle: "Lots des unités ajoutées",
    legacyTitle: "Unités dont le lot d'origine est inconnu",
    legacyText:
      "Cette vente est antérieure au suivi par lots : aucun lot ne lui est attribué. Indiquez dans quels lots replacer les unités rendues. Ce n'est pas une réception.",
    legacyNoRight:
      "Restituer ces unités nécessite le droit d'ajuster le stock.",
    destinationFor: "Unités replacées dans {{reference}}",
    historical: "Créer un « lot historique, date inconnue » pour ces unités",
    historicalQuantity: "Unités dans le lot historique",
    historicalConfirm:
      "Je confirme que le lot de ces unités est inconnu (aucune date ne leur sera attribuée).",
    reason: "Motif de la restitution",
    errors: {
      returns: "Les lots crédités doivent totaliser les unités rendues.",
      legacy:
        "Les unités replacées doivent totaliser les unités d'origine inconnue rendues.",
      reason: "Indiquez un motif d'au moins 3 caractères.",
      historicalConfirm: "Confirmez la création du lot historique.",
    },
    deleteBatchText:
      "Les unités seront rendues exactement à leurs lots d'origine : {{list}}. Cette action est irréversible.",
    deleteLegacyText:
      "Vente antérieure au suivi par lots : indiquez où replacer les {{count}} unité(s), avec un motif.",
  },
  logout: {
    title: "Ventes non synchronisées",
    description_one:
      "{{count}} vente enregistrée sur cet appareil n'a pas encore été confirmée par le serveur.",
    description_many:
      "{{count}} ventes enregistrées sur cet appareil n'ont pas encore été confirmées par le serveur.",
    description_other:
      "{{count}} ventes enregistrées sur cet appareil n'ont pas encore été confirmées par le serveur.",
    descriptionOrganizations_one:
      "{{count}} vente enregistrée sur cet appareil ({{organizations}} organisations) n'a pas encore été confirmée par le serveur.",
    descriptionOrganizations_many:
      "{{count}} ventes enregistrées sur cet appareil ({{organizations}} organisations) n'ont pas encore été confirmées par le serveur.",
    descriptionOrganizations_other:
      "{{count}} ventes enregistrées sur cet appareil ({{organizations}} organisations) n'ont pas encore été confirmées par le serveur.",
    syncing: "Synchronisation… (10 s max)",
    keep: "Se déconnecter et conserver sur cet appareil",
    delete: "Supprimer définitivement…",
    deleteWarning:
      "Ces ventes seront effacées de cet appareil et ne seront JAMAIS envoyées au serveur. Action irréversible.",
    deleteFailed:
      "Suppression impossible : rien n'a été effacé. Réessaie ou conserve les ventes.",
    deleteConfirm: "Supprimer définitivement et se déconnecter",
  },
  outbox: {
    loading: "Chargement des ventes locales…",
    unreadable:
      "Ventes locales illisibles pour cette session. Reconnecte-toi pour y accéder ; elles restent conservées sur cet appareil.",
    counts: {
      pending: "En attente",
      syncing: "Envoi",
      conflict: "À traiter",
    },
    status: {
      pending: "En attente",
      syncing: "Envoi en cours",
      synced: "Synchronisée",
      conflict: "À traiter",
      abandoned: "Abandonnée",
    },
    blocked: {
      suspended:
        "Envoi suspendu : ce commerce est suspendu par Stock Master. Les ventes restent sur cet appareil et repartiront après la réactivation.",
      subscription:
        "Envoi suspendu : l'abonnement de ce commerce n'est pas actif. Les ventes restent sur cet appareil et repartiront après le renouvellement.",
      accessDenied:
        "Envoi suspendu : le serveur a refusé l'accès (session, droits ou organisation). Reconnecte-toi ou contacte un administrateur ; les ventes restent sur cet appareil.",
      corruption:
        "Envoi suspendu : une incohérence a été détectée. Note les ventes concernées et contacte le support avant de retirer l'opération.",
    },
    resumeOnline:
      "L'envoi reprendra automatiquement au retour de la connexion, application ouverte.",
    empty: "Aucune vente en attente sur cet appareil.",
    listLabel: "Ventes non finalisées",
    actionFailed: "Action impossible.",
    recentlySynced: "Récemment synchronisées ({{count}})",
    syncedRetention: "Effacées automatiquement de cet appareil après 7 jours.",
    cancelledLater: "Annulée ensuite",
    confirmed: "Confirmée",
    attempts_one: "Tentatives : {{count}}.",
    attempts_many: "Tentatives : {{count}}.",
    attempts_other: "Tentatives : {{count}}.",
    confirm: {
      removeTitle: "Retirer cette vente de la file ?",
      abandonTitle: "Abandonner cette vente ?",
      mayBeRecorded:
        "Attention : le serveur a peut-être déjà enregistré cette vente. Vérifie la liste des ventes avant de l'abandonner.",
      neverSent: "Cette vente ne sera jamais envoyée au serveur.",
      staysVisible:
        "Elle ne sera plus proposée à l'envoi et restera visible sur cet appareil (aucune suppression silencieuse).",
    },
    actions: {
      edit: "Corriger",
      retry: "Réessayer",
      abandon: "Abandonner",
      remove: "Retirer",
      removeFromQueue: "Retirer de la file",
      regularize: "Régulariser",
      requestRegularization: "Demander une régularisation",
    },
    errors: {
      insufficientStock: "Stock insuffisant côté serveur.",
      productNotFound: "Produit introuvable ou supprimé.",
      batchTracked:
        "Produit suivi par lots : vente refusée par le serveur. Corrigez-la en choisissant les lots.",
      dateOutOfRange: "Date de vente hors de la période autorisée.",
      validationFailed: "Données de vente refusées par le serveur.",
      expired:
        "Vente en attente depuis plus de 14 jours : non envoyée automatiquement.",
      serverUnavailable: "Serveur indisponible après plusieurs tentatives.",
      alreadyApplied: "Déjà enregistrée par le serveur, puis annulée.",
      inconsistency:
        "Incohérence détectée : notez cette vente et contactez le support.",
      accessDenied: "Accès refusé par le serveur.",
      subscriptionInactive:
        "Abonnement du commerce inactif : vente conservée, envoi après renouvellement.",
      organizationSuspended:
        "Commerce suspendu : vente conservée, envoi après réactivation.",
      network: "Réseau indisponible, nouvel essai automatique.",
      server: "Envoi momentanément impossible, nouvel essai automatique.",
      auth: "Session expirée ou accès refusé.",
      refused: "Vente refusée par le serveur.",
      batchAllocationRequired:
        "Produit suivi par lots : choisissez les lots vendus (Corriger).",
      batchInsufficient:
        "Un lot choisi n'a plus assez d'unités : corrigez la répartition.",
      batchUnavailable:
        "Un lot choisi n'est plus disponible : corrigez la répartition.",
      batchExpired:
        "Un lot choisi a dépassé sa date de péremption : il ne peut pas être vendu.",
      batchExpiredAtSync:
        "Vente saisie avant la péremption du lot, reçue après : une régularisation par un responsable est nécessaire.",
      batchExpiryUnconfirmed:
        "Un lot sans date de péremption doit être confirmé : corrigez la vente.",
      batchMismatch:
        "Les lots ne correspondent pas à la quantité : corrigez la vente.",
      batchesDisabled: "La vente par lots n'est pas disponible pour le moment.",
    },
    regularize: {
      title: "Régulariser cette vente",
      text: "La vente a été saisie le {{date}}, avant la péremption du lot, mais reçue après. Régulariser l'enregistre avec son heure réelle, sans autoriser d'autre vente de ce lot.",
      reason: "Motif (obligatoire)",
      reasonPlaceholder: "Ex. vendu hors connexion avant minuit",
      confirm: "Régulariser",
      noRight:
        "Un responsable autorisé doit régulariser cette vente : transmettez-lui la demande. Elle reste en attente sur cet appareil.",
      reasonTooShort: "Indiquez un motif d'au moins 3 caractères.",
      requestTitle: "Demander une régularisation",
      requestText:
        "La vente, ses lots et l'heure déclarée par cet appareil ({{date}}, non vérifiée) seront transmis à un responsable. Rien n'est enregistré avant son approbation.",
      requestConfirm: "Transmettre la demande",
      requested: "Demande transmise à un responsable.",
      awaiting:
        "Demande transmise ({{date}}) : en attente de la décision d'un responsable. La vente n'est pas encore enregistrée.",
      rejected: "Régularisation rejetée : {{reason}}",
    },
  },
  batches: {
    title: "Lots remis au client",
    loading: "Chargement des lots…",
    noCache:
      "Lots indisponibles hors connexion pour ce produit : connectez-vous pour les charger.",
    hintOnline:
      "Proposition selon la péremption la plus proche. Ajustez-la aux unités réellement remises. Rien n'est réservé avant la confirmation.",
    hintOffline:
      "Hors connexion : disponibilité non vérifiée, rien n'est réservé. Le serveur confirmera à la synchronisation.",
    none: "Aucun lot vendable pour ce produit.",
    datedLabel: "Lots datés, péremption la plus proche d'abord",
    undatedLabel: "Lots sans date de péremption",
    undatedWarning:
      "Lots sans date de péremption connue : aucune garantie de validité.",
    undatedConfirm:
      "Je confirme vendre des unités dont la date de péremption est inconnue.",
    expiresToday: "Expire aujourd'hui",
    expiresTodayOffline:
      "Un lot expire aujourd'hui : si la vente n'est pas synchronisée avant minuit, elle devra être régularisée.",
    expiry: "Péremption : {{date}}",
    noExpiry: "Sans date",
    available_one: "{{count}} disponible",
    available_many: "{{count}} disponibles",
    available_other: "{{count}} disponibles",
    quantityFor: "Quantité du lot {{reference}}",
    expiredExcluded_one: "{{count}} lot dépassé n'est pas proposé.",
    expiredExcluded_many: "{{count}} lots dépassés ne sont pas proposés.",
    expiredExcluded_other: "{{count}} lots dépassés ne sont pas proposés.",
    allocated: "Réparti : {{allocated}} / {{total}}",
    errors: {
      sum: "La somme des lots doit être égale à la quantité vendue.",
      unknownUnconfirmed:
        "Confirmez la vente d'unités sans date de péremption.",
      aboveAvailable: "Un lot n'a pas assez d'unités disponibles.",
    },
    saleLots: "Lots : {{list}}",
    regularized: "Régularisée (lot dépassé à la réception) : {{reason}}",
    corrected_one: "{{count}} correction des lots",
    corrected_many: "{{count}} corrections des lots",
    corrected_other: "{{count}} corrections des lots",
    originUnknown:
      "Vente antérieure au suivi par lots : lot d'origine inconnu.",
  },
  regularizations: {
    title_one: "Régularisations à examiner ({{count}})",
    title_many: "Régularisations à examiner ({{count}})",
    title_other: "Régularisations à examiner ({{count}})",
    intro:
      "Ventes hors ligne saisies avant la péremption d'un lot mais reçues après. L'heure déclarée vient de l'appareil du vendeur et n'est pas vérifiée.",
    seller: "Vendeur :",
    declared: "Heure déclarée (appareil, non vérifiée) :",
    received: "Reçue par le serveur :",
    expired: "Lots dépassés à la réception :",
    decision: "Décision :",
    decisionBy: "{{name}}, {{date}} — {{reason}}",
    approve: "Approuver",
    reject: "Rejeter",
    approveTitle: "Approuver la régularisation",
    approveText:
      "La vente sera enregistrée au nom de {{seller}}, à l'heure déclarée ({{date}}), avec les mêmes lots. Vous en serez l'approbateur.",
    rejectTitle: "Rejeter la demande",
    rejectText:
      "Aucune vente ne sera enregistrée. La demande et votre motif restent consultables.",
    approved: "Vente régularisée.",
    rejectedDone: "Demande rejetée.",
    status: {
      pending: "En attente",
      approved: "Approuvée",
      rejected: "Rejetée",
    },
  },
} as const;

export default salesFr;
