// 1-16G — Gabarit des documents, titres des documents, acceptation.
// Le CONTENU des documents est dans `i18n/documents/<page>/<langue>.tsx`.
const legalFr = {
  document: {
    skipToContent: "Aller au contenu",
    version: "Version {{version}}, mise à jour le {{date}}.",
    toc: "Sommaire",
    question:
      "Une question sur ce texte ? <contact>Contacter Stock Master</contact>",
  },
  documents: {
    "mentions-legales": {
      title: "Mentions légales",
      short: "Mentions légales",
      inSentence: "mentions légales",
    },
    "conditions-utilisation": {
      title: "Conditions d'utilisation",
      short: "Conditions d'utilisation",
      inSentence: "conditions d'utilisation",
    },
    "conditions-abonnement": {
      title: "Conditions d'abonnement",
      short: "Conditions d'abonnement",
      inSentence: "conditions d'abonnement",
    },
    confidentialite: {
      title: "Politique de confidentialité",
      short: "Confidentialité",
      inSentence: "politique de confidentialité",
    },
    cookies: {
      title: "Cookies et stockage sur l'appareil",
      short: "Cookies et stockage",
      inSentence: "cookies et stockage sur l'appareil",
    },
    "traitement-donnees": {
      title: "Accord de traitement des données",
      short: "Traitement des données",
      inSentence: "accord de traitement des données",
    },
  },
  acceptance: {
    prefix: "J'ai lu et j'accepte",
    article: "les",
    and: " et ",
    comma: ", ",
    newTab: "(nouvel onglet)",
    versions_one: "(version {{versions}})",
    versions_many: "(versions {{versions}})",
    versions_other: "(versions {{versions}})",
    notice:
      "Pour savoir quelles données sont traitées et pourquoi, consulte la <doc></doc> (version {{version}}). Elle t'informe : la lire ne vaut pas accord.",
    errors: {
      required:
        "Coche la case pour accepter les conditions avant de continuer.",
      outdated:
        "Les conditions ont été mises à jour. Recharge la page pour lire la nouvelle version, puis recommence.",
      mismatch:
        "Les conditions affichées ne correspondent pas aux textes en vigueur. Recharge la page, puis recommence.",
      archive:
        "L'enregistrement de ton acceptation est momentanément indisponible. Réessaie dans quelques instants.",
    },
  },
  marketing: {
    label:
      "Je souhaite recevoir par e-mail les offres et promotions de Stock Master. Je peux me désinscrire à tout moment.",
    optional:
      "Facultatif. Ton compte fonctionne de la même façon, que tu coches cette case ou non.",
    errors: {
      outdated:
        "Ce texte a été mis à jour. Recharge la page pour voir la nouvelle version.",
      unavailable:
        "Ton choix n'a pas pu être enregistré. Réessaie dans un instant.",
    },
    settings: {
      title: "Offres et promotions par e-mail",
      text: "Choisis si tu veux recevoir nos offres par e-mail. Les e-mails utiles à ton compte continuent d'arriver, quel que soit ton choix.",
      grantedSince: "Activé depuis le {{date}}.",
      notGranted: "Tu ne reçois pas nos offres par e-mail.",
      previousAddress:
        "Ton adresse e-mail a changé. Coche la case si tu veux recevoir nos offres à ta nouvelle adresse.",
      unverified: "Confirme ton adresse e-mail pour recevoir nos offres.",
      granted: "C'est noté, tu recevras nos offres.",
      withdrawn: "C'est noté, tu ne recevras plus nos offres.",
      unavailable: "Ce réglage n'est pas disponible pour le moment.",
      loading: "Chargement…",
    },
  },
  unsubscribe: {
    metaTitle: "Se désabonner",
    loading: "Chargement…",
    title: "Se désabonner des offres Stock Master",
    text: "Vous ne recevrez plus nos offres et promotions par e-mail.",
    confirm: "Me désabonner",
    submitting: "Un instant…",
    service:
      "Les e-mails liés à votre compte continueront d'arriver normalement.",
    doneTitle: "C'est noté",
    doneText:
      "Vous ne recevrez plus nos offres à cette adresse. Vous pouvez changer d'avis à tout moment depuis votre compte.",
    invalidTitle: "Ce lien ne fonctionne plus",
    invalidText:
      "Vous pouvez gérer vos préférences depuis votre compte, dans Organisation puis Notifications.",
    network: "La connexion a échoué. Merci de réessayer.",
  },
  prompt: {
    title: "Ton accord est demandé",
    description:
      "Avant de continuer à utiliser Stock Master, lis les textes ci-dessous. Ton accord n'est enregistré que si tu coches la case et valides.",
    outdated:
      "De nouvelles versions des conditions sont en vigueur. Recharge la page pour les afficher avant de donner ton accord.",
    notice:
      "Information : <doc></doc> (version {{version}}). La lire ne vaut pas accord.",
    offline: "Connexion Internet nécessaire pour enregistrer ton accord.",
    recorded: "Ton accord est enregistré.",
    later: "Plus tard",
    saving: "Enregistrement…",
    accept: "J'accepte",
    reload: "Recharger",
  },
  authLinks: {
    label: "Aide et informations",
    guide: "Guide",
    contact: "Contact",
    terms: "Conditions d'utilisation",
    subscriptionTerms: "Conditions d'abonnement",
    privacy: "Confidentialité",
  },
} as const;

export default legalFr;
