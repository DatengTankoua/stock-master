// 1-16G — Abonnement : offres, état, renouvellement, paiement, blocage.
const subscriptionFr = {
  offers: {
    term: {
      monthly: "1 mois",
      quarterly: "3 mois",
      semiannual: "6 mois",
      annual: "12 mois",
    },
    // 1-21D : accroches sans montant ; économies et mois offerts calculés
    // depuis le catalogue serveur (`lib/subscription-offers.ts`).
    pitch: {
      monthly: {
        title: "Commencez à votre rythme",
        text: "Un mois pour gérer votre activité au quotidien.",
      },
      quarterly: { title: "Prenez trois mois d'avance" },
      semiannual: { title: "Six mois pour développer votre activité" },
      annual: { title: "Un an de gestion" },
      withFreeMonths_one: "{{title}}, {{count}} mois offert",
      withFreeMonths_many: "{{title}}, {{count}} mois offerts",
      withFreeMonths_other: "{{title}}, {{count}} mois offerts",
      saving: "Économisez {{amount}} par rapport au paiement mensuel.",
    },
    best: "Meilleure économie",
    paidOnce: "payés en une fois pour {{term}}",
    monthlyEquivalent:
      "Soit environ {{amount}} par mois, à titre de comparaison.",
    included: {
      catalog: "Catalogue, stock et ventes",
      converter: "Convertisseur EUR ↔ FCFA",
      analytics: "Analyses et corbeille",
      members: "Membres et permissions",
    },
    ctaLabel: "{{label}} — formule {{term}}",
    selectorLabel: "Durée du renouvellement",
    conditions: {
      features:
        "Mêmes fonctionnalités pour toutes les durées, selon les droits de chaque membre.",
      perShop: "Abonnement par commerce, sans supplément par vendeur.",
      noAutoPay:
        "Aucun prélèvement automatique : chaque renouvellement est volontaire.",
    },
  },
  overview: {
    dateAt: "{{date}} à {{time}}",
    state: {
      trial: "Essai gratuit en cours",
      active: "Abonnement actif",
      expired: "Abonnement expiré",
      scheduled: "Période à venir",
      none: "Aucun abonnement",
    },
    trial: "Essai gratuit",
    subscriptionTerm: "Abonnement {{term}}",
    lessThanDay: "moins d'un jour",
    days_one: "{{count}} jour",
    days_many: "{{count}} jours",
    days_other: "{{count}} jours",
    status: "État",
    currentPeriod: "Période en cours",
    fromTo: "du {{from}} au {{to}}",
    accessEnded: "Accès terminé le",
    accessUntil: "Accès couvert jusqu'au",
    remaining: "Temps restant : {{remaining}}",
    nextPeriod: "Prochaine période",
    startingOn: "à partir du {{date}}",
    historyTitle: "Historique des périodes",
    historyEmpty: "Aucune période.",
    historyNote:
      "Historique des périodes d'accès, sans montant : les paiements et leurs reçus figurent dans l'historique des paiements.",
  },
  manager: {
    checkUnavailable: "Vérification momentanément indisponible.",
    infoUnavailable: "Informations d'abonnement indisponibles.",
    loading: "Chargement de l'abonnement…",
    verify: "Vérifier mon abonnement",
    renewal: "Renouvellement",
    paymentUnavailable:
      "Paiement momentanément indisponible. Utilisez « Vérifier mon abonnement ».",
  },
  page: {
    title: "Abonnement",
    loading: "Chargement…",
    ownerOnly:
      "La gestion de l'abonnement est réservée au propriétaire du commerce.",
    verified: "Abonnement vérifié.",
  },
  block: {
    title: {
      expired: "L'abonnement de ce commerce a expiré",
      none: "Ce commerce n'a pas d'abonnement actif",
      scheduled: "L'abonnement de ce commerce n'a pas encore commencé",
      active: "L'abonnement de ce commerce est actif",
      inactive: "L'abonnement de ce commerce n'est pas actif",
    },
    text: {
      offline:
        "Vous êtes hors connexion. La vérification reprendra au retour de la connexion.",
      activeLimited:
        "Utilisez « Vérifier mon abonnement » pour retrouver l'accès.",
      owner: "Renouvelez l'abonnement pour retrouver l'accès à votre commerce.",
      member: "Contactez le propriétaire pour renouveler.",
    },
    verifyAccess: "Vérifier l'accès",
    logout: "Se déconnecter",
  },
  verify: {
    stillInactive: "L'abonnement n'est toujours pas actif.",
    stale: "La session a changé : rechargez la page.",
    offline: "Vérification impossible hors connexion.",
  },
  access: {
    yourShop: "Votre commerce",
    retry: "Réessayer",
  },
  localSales: {
    unreadable:
      "Ventes locales illisibles pour cette session : elles restent conservées sur cet appareil.",
    title_one: "Ventes en attente sur cet appareil ({{count}})",
    title_many: "Ventes en attente sur cet appareil ({{count}})",
    title_other: "Ventes en attente sur cet appareil ({{count}})",
    text: "Elles sont conservées et seront envoyées après le renouvellement.",
  },
  payment: {
    status: {
      initiating: {
        label: "Demande en cours",
        lower: "demande en cours",
        detail:
          "La demande de paiement est en cours de transmission à l'opérateur.",
      },
      pending: {
        label: "En attente de paiement",
        lower: "en attente de paiement",
        detail:
          "Validez le paiement sur le téléphone du payeur, puis appuyez sur « Vérifier le paiement ».",
      },
      uncertain: {
        label: "Résultat à vérifier",
        lower: "résultat à vérifier",
        detail:
          "La transmission n'a pas pu être confirmée. Vérifiez ce paiement : aucune nouvelle demande ne sera envoyée.",
      },
      review: {
        label: "Vérification nécessaire",
        lower: "vérification nécessaire",
        detail:
          "Ce paiement doit être vérifié par notre équipe. Aucune nouvelle demande n'est possible en attendant.",
      },
      failed: {
        label: "Échec confirmé",
        lower: "échec confirmé",
        detail: "L'opérateur a confirmé que ce paiement n'a pas abouti.",
      },
      succeeded: {
        label: "Paiement confirmé",
        lower: "paiement confirmé",
        detail: "Le paiement est confirmé et l'abonnement a été prolongé.",
      },
    },
    errors: {
      "no-response":
        "Réponse non reçue. Rien n'est perdu : vérifiez votre connexion puis réessayez.",
      unexpected:
        "Réponse non reçue. Rien n'est perdu : vérifiez votre connexion puis réessayez.",
      unauthorized: "Votre session a expiré. Reconnectez-vous.",
      unauthorizedRestricted:
        "Votre session a expiré. Reconnectez-vous : votre paiement sera retrouvé.",
      forbidden: "Accès refusé pour ce commerce.",
      "already-pending": "Un paiement est déjà en cours pour ce commerce.",
      "operation-conflict":
        "Cette demande a déjà été envoyée avec d'autres informations. Saisissez exactement le même numéro.",
      "invalid-phone":
        "Numéro Mobile Money camerounais invalide (ex. 6XX XX XX XX).",
      "invalid-request": "Demande invalide. Vérifiez les informations saisies.",
      "not-found": "Paiement introuvable pour ce commerce.",
      "rate-limited": "Trop de demandes. Patientez avant de réessayer.",
      "service-unavailable":
        "Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.",
      "status-unavailable":
        "Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.",
      "confirmation-pending":
        "Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.",
      "change-unavailable":
        "Ce paiement ne peut pas être remplacé : attendez son résultat, puis vérifiez-le.",
      "receipt-unavailable": "Aucun reçu : ce paiement n'a pas été encaissé.",
    },
    messages: {
      checkoutReady:
        "Lien de paiement prêt. Continuez vers la page de paiement : l'abonnement sera actif une fois le paiement confirmé par notre serveur.",
      offlineCreate:
        "Hors connexion : la création d'un paiement nécessite Internet.",
      termRequired: "Choisissez une durée.",
      phoneRequired: "Saisissez le numéro Mobile Money du payeur.",
      replayed: "Demande retrouvée : aucun nouveau paiement n'a été demandé.",
      sent: "Demande envoyée. L'abonnement sera actif une fois le paiement confirmé.",
      confirmed: "Paiement confirmé. Rétablissement de l'accès…",
      checkoutClosed:
        "SasPay confirme que la page de paiement est fermée, sans aucune transaction. Vous pouvez choisir un forfait.",
      expiredAwaitingClosure:
        "Le lien a expiré. Nous attendons la confirmation de clôture du prestataire avant de permettre une nouvelle tentative.",
      closureUnconfirmed:
        "La page de paiement est fermée, mais SasPay n'a pas confirmé l'absence de transaction : la tentative reste en résolution.",
      renewalSuspended:
        "Une tentative précédente de ce renouvellement a été payée : la poursuite de ce paiement est suspendue en attendant sa résolution.",
      collectedInResolution:
        "Paiement reçu : sa prise en compte nécessite une vérification par notre équipe. Il n'est ni perdu ni refusé.",
      offlineVerify: "Hors connexion : la vérification nécessite Internet.",
      statusChecked: "Statut vérifié : {{status}}.",
      statusNow: "Ce paiement est désormais : {{status}}.",
    },
    loading: "Chargement des paiements…",
    offline:
      "Hors connexion : la création et la vérification d'un paiement nécessitent Internet.",
    term: "Durée",
    totalAmount: "Montant total",
    payer: "Payeur",
    reference: "Référence",
    requestedOn: "Demandé le",
    confirmedOn: "Confirmé le",
    checkout: {
      formTitle: "Payer en ligne",
      help: "Le paiement se fait sur la page sécurisée de SasPay (Mobile Money MTN ou Orange). Aucun numéro ni code secret n'est demandé ici.",
      continueAmount: "Continuer vers le paiement de {{amount}}",
      notice:
        "Revenez ensuite dans Stock Master : l'abonnement n'est activé qu'après confirmation par notre serveur, jamais par le simple retour de la page.",
      pendingDetail:
        "Terminez le paiement sur la page SasPay, puis revenez ici et appuyez sur « Vérifier le paiement ».",
      lockedIntent:
        "Une demande précédente n'a pas reçu de réponse. Validez de nouveau pour la retrouver : aucun second paiement ne sera demandé. Durée : <b>{{term}}</b>.",
      validUntil: "Lien de paiement valable jusqu'à {{time}}.",
    },
    // 1-21E : situations précises d'un paiement par page SasPay.
    situation: {
      expired: {
        label: "Page de paiement expirée",
        detail:
          "Le lien a expiré. Nous attendons la confirmation de clôture du prestataire avant de permettre une nouvelle tentative.",
      },
      closureUnconfirmed: {
        label: "Clôture à confirmer par SasPay",
        detail:
          "La page de paiement est fermée, mais SasPay n'a pas affirmé qu'aucune transaction n'y a été engagée. Aucun nouveau paiement n'est possible avant cette confirmation ; vous pouvez consulter les formules en attendant.",
      },
      renewalSuspended: {
        label: "Paiement suspendu",
        detail:
          "Une tentative précédente de ce renouvellement a été payée. Pour éviter un second débit, ce paiement n'est plus proposé en attendant la résolution par notre équipe.",
      },
      refunded: {
        label: "Paiement remboursé",
        detail:
          "Ce paiement a été remboursé par notre équipe. Il n'a prolongé aucune période d'abonnement.",
      },
      collectedInResolution: {
        label: "Paiement reçu, en résolution",
        detail:
          "SasPay a confirmé ce paiement, mais il concerne une tentative remplacée ou un renouvellement déjà réglé. Il est enregistré et sera traité par notre équipe (prise en compte ou remboursement, avec votre accord). L'abonnement n'est pas encore prolongé par ce paiement.",
      },
      linkMissing: {
        label: "Lien de paiement non récupéré",
        detail:
          "La page de paiement a peut-être été créée chez SasPay, mais son lien n'a pas été reçu. « Vérifier le paiement » la retrouve sans en créer une nouvelle.",
      },
      attemptUnresolved: {
        label: "Tentative à confirmer par SasPay",
        detail:
          "La page de paiement est fermée après une tentative qui n'a pas abouti. SasPay ne garantit pas qu'une tentative échouée ne puisse plus être validée : aucun nouveau paiement n'est possible avant sa confirmation. Si vous n'avez pas été débité, contactez le support avec la référence ci-dessous.",
      },
      closed: {
        label: "Page de paiement fermée sans paiement",
        lower: "fermée sans paiement",
        detail:
          "SasPay confirme que cette page est fermée et qu'aucune transaction n'y a été engagée. Vous pouvez choisir un forfait.",
      },
    },
    // 1-21E : « Changer de forfait » / « Annuler cette tentative ».
    abandon: {
      change: "Changer de forfait",
      cancel: "Annuler cette tentative",
      changeTitle: "Changer de forfait ?",
      cancelTitle: "Annuler cette tentative ?",
      explain:
        "Stock Master vérifie d'abord ce paiement auprès de SasPay. Si aucun paiement n'a été engagé, la page de paiement actuelle est fermée chez SasPay. Si le paiement a déjà abouti, il est confirmé et rien n'est annulé.",
      confirmChange: "Fermer la page SasPay et changer de forfait",
      confirmCancel: "Fermer la page SasPay et annuler",
      keep: "Garder ce paiement",
      working: "Vérification auprès de SasPay…",
      outcome: {
        releasedChange:
          "SasPay confirme la fermeture de la page précédente, sans aucune transaction. Choisissez votre forfait.",
        releasedCancel:
          "Tentative annulée : SasPay confirme la fermeture de la page de paiement, sans aucune transaction.",
        "in-progress":
          "Un paiement est en cours de validation chez SasPay : il ne peut pas être annulé. Attendez son résultat, puis appuyez sur « Vérifier le paiement ».",
        "attempt-recorded":
          "Une tentative de paiement a déjà été enregistrée sur cette page. SasPay ne garantit pas qu'une tentative échouée ne puisse plus être validée : la page n'a pas été fermée. Vous pouvez encore payer sur la même page ; sinon, le changement de forfait sera possible après résolution de cette tentative.",
        "awaiting-resolution":
          "Ce paiement ne peut pas être annulé de façon sûre : sa résolution est nécessaire (support). Aucun nouveau paiement n'est possible en attendant.",
        "not-found-at-provider":
          "SasPay n'a pas encore retrouvé cette page de paiement. Elle n'est pas annulée : réessayez « Vérifier le paiement » dans un instant.",
        "provider-incomplete":
          "La réponse de SasPay ne confirme pas l'absence de transaction sur cette page : elle n'a pas été fermée. Réessayez dans un instant ; vous pouvez consulter les formules en attendant.",
        "cancel-unconfirmed":
          "SasPay n'a pas confirmé la fermeture de la page : la tentative reste ouverte. Réessayez dans un instant.",
      },
      previewTitle: "Choisir un autre forfait",
      previewBlocked:
        "Vous pouvez comparer les forfaits, mais un nouveau paiement ne pourra être validé qu'après la résolution du paiement en cours.",
      close: "Fermer",
    },
    // 1-21D : montant enregistré par le serveur ≠ prix affiché dans l'onglet.
    priceChanged: {
      text: "Le tarif a changé depuis l'ouverture de cette page : ce paiement est de {{charged}}, et non {{displayed}}. Vérifiez ce montant avant de continuer.",
      confirm: "Continuer avec {{amount}}",
    },
    // 1-21D : capacités `available: false` (paiements désactivés).
    disabled:
      "Le paiement en ligne est momentanément indisponible. Vous pouvez toujours consulter et vérifier un paiement en cours.",
    pinNotice:
      "Le code secret Mobile Money se saisit uniquement sur le téléphone du payeur. Stock Master ne le demande jamais.",
    checking: "Vérification…",
    verify: "Vérifier le paiement",
    openShop: "Accéder à mon commerce",
    newAttempt: "Nouvel essai",
    // 1-21E : reçu de paiement (jamais une facture).
    receipt: {
      open: "Reçu",
      title: "Reçu de paiement",
      notInvoice:
        "Ce reçu atteste un paiement encaissé. Ce n'est pas une facture.",
      number: "N° de reçu",
      paidAt: "Payé le",
      organization: "Commerce",
      plan: "Formule",
      amountPaid: "Montant payé",
      method: "Moyen de paiement",
      transaction: "Référence de la transaction",
      period: "Période d'abonnement",
      periodRange: "du {{from}} au {{to}}",
      inResolution:
        "Paiement reçu, prise en compte en cours de vérification : aucune période attribuée à ce jour.",
      refunded:
        "Paiement remboursé le {{date}} : aucune période attribuée par ce paiement.",
      print: "Imprimer",
      close: "Fermer",
    },
    chooseOffer: "Choisir un forfait",
    renew: "Renouveler",
    formTitle: "Payer par Mobile Money",
    lockedIntent:
      "Une demande précédente n'a pas reçu de réponse. Saisissez de nouveau <b>le même numéro</b> pour la retrouver : aucun second paiement ne sera demandé. Durée : <b>{{term}}</b>.",
    phoneLabel: "Numéro Mobile Money du payeur",
    phoneHelp:
      "MTN Mobile Money ou Orange Money (Cameroun). Le payeur validera sur son téléphone ; aucun code secret n'est demandé ici.",
    summary:
      "Montant total : <b>{{amount}}</b> pour <b>{{term}}</b>. L'abonnement sera prolongé une fois le paiement confirmé.",
    summaryEmpty: "Sélectionnez une durée pour voir le montant total.",
    sending: "Envoi…",
    payAmount: "Payer {{amount}}",
    pay: "Payer",
    cancel: "Annuler",
    historyTitle: "Historique des paiements",
    historyUnavailable: "Historique des paiements indisponible.",
    historyMore: "Impossible de charger plus de paiements.",
    historyEmpty: "Aucun paiement.",
    loadingMore: "Chargement…",
    showMore: "Afficher plus",
  },
} as const;

export default subscriptionFr;
