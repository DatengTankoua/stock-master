// 1-16G — Textes partagés : langue, thème, shell /app, actions, erreurs
// génériques, hors connexion.
const commonFr = {
  meta: {
    appDescription: "Application de gestion des stocks et des ventes",
    shareImageAlt:
      "Logo Stock Master et capture de l'écran Analyse de l'application (boutique fictive)",
  },
  language: {
    title: "Langue",
    trigger: "Langue : {{language}}",
  },
  theme: {
    title: "Thème d'affichage",
    trigger: "Thème d'affichage : {{theme}}",
    light: "Clair",
    dark: "Sombre",
    system: "Automatique",
  },
  backToHome: "Retour à l'accueil",
  notFound: {
    code: "Erreur 404",
    title: "Cette page est introuvable",
    text: "Le lien est peut-être incomplet ou la page a été déplacée.",
  },
  offline: {
    title: "Vous êtes hors connexion",
    // 1-22C.1 : écran de secours de toute page non disponible hors ligne.
    text: "Cette page nécessite une connexion Internet. Réessayez une fois connecté, ou consultez les pages enregistrées sur cet appareil.",
    availableTitle: "Disponible hors connexion",
    links: {
      home: "Accueil",
      pricing: "Tarifs",
      guide: "Guide d'utilisation",
      contact: "Contact",
      terms: "Conditions d'utilisation",
      catalog:
        "Catalogue et ventes hors ligne (compte déjà connecté sur cet appareil)",
    },
  },
  // 1-22C.1 : page publique servie depuis la copie enregistrée.
  offlineCopy: {
    savedAt: "Version enregistrée sur cet appareil le {{date}}.",
    text: "Les tarifs et conditions affichés peuvent avoir changé depuis. L'inscription, la connexion et le paiement nécessitent une connexion Internet.",
    refresh: "Actualiser",
  },
  // Contact WhatsApp : fin commune (pages publiques et Assistance).
  whatsapp: {
    subjectLine: "Sujet : {{subject}}",
    charCount: "{{length}} / {{count}} caractères",
    previewLabel: "Texte prérempli dans WhatsApp (modifiable avant l'envoi)",
    notice:
      "WhatsApp s'ouvrira. Envoyez votre message pour démarrer la conversation.",
    continue: "Continuer sur WhatsApp",
    newWindow: "(ouvre WhatsApp ou un nouvel onglet)",
    afterOpen:
      "Stock Master n'envoie rien à votre place : envoyez le message depuis WhatsApp. Si WhatsApp ne s'est pas ouvert, votre texte est toujours ici ; réessayez ou écrivez-nous par e-mail.",
    offline:
      "Pas de connexion : WhatsApp comme l'e-mail nécessitent Internet. Votre texte reste sur cet écran ; rien ne sera envoyé automatiquement.",
  },
  actions: {
    retry: "Réessayer",
    cancel: "Annuler",
    close: "Fermer",
    save: "Enregistrer",
    delete: "Supprimer",
    back: "Retour",
  },
  fields: {
    maxLength_one: "{{count}} caractère maximum.",
    maxLength_many: "{{count}} caractères maximum.",
    maxLength_other: "{{count}} caractères maximum.",
  },
  errors: {
    network: "Impossible de joindre le serveur. Vérifiez votre connexion.",
    subscriptionInactive: "L'abonnement de ce commerce n'est pas actif.",
    statusUnavailable: "Vérification momentanément indisponible. Réessayez.",
    forbidden: "Accès refusé.",
    notFound: "Ressource introuvable.",
    server: "Erreur serveur. Réessayez dans quelques instants.",
    status: "Erreur {{status}}.",
    unexpected: "Une erreur inattendue s'est produite.",
    uploadInterrupted: "L'envoi du fichier a été interrompu. Réessayez.",
  },
  converter: {
    title: "Convertisseur EUR ↔ Franc CFA",
    euro: "Euro (€)",
    cfa: "Franc CFA (FCFA)",
    rate: "Taux fixe officiel : 1 EUR = {{rate}} FCFA",
    parity: "(Parité fixe FCFA zone UEMOA / Banque de France)",
  },
  shell: {
    nav: {
      home: "Accueil",
      catalog: "Catalogue",
      sales: "Ventes",
      analytics: "Analyse",
      trash: "Corbeille",
      organization: "Organisation",
      help: "Aide",
    },
    myShop: "Mon commerce",
    myAccount: "Mon compte",
    loading: "Chargement…",
    offline: "Hors connexion",
    offlineUnavailable: "Indisponible hors connexion",
    otherPagesOffline: "Autres pages : indisponible hors connexion",
    offlineMessage:
      "Vous êtes hors connexion. Vous pouvez consulter les données enregistrées sur cet appareil et saisir des ventes qui seront envoyées au retour de la connexion.",
    organizationUnavailable: "Organisation actuelle indisponible.",
    converter: "Convertisseur EUR ↔ CFA",
    more: "Plus",
    quit: "Quitter",
    accessRefused:
      "Ton accès à cette organisation n'est plus actif. Contacte un administrateur ou déconnecte-toi.",
    noOrganization:
      "Aucune organisation active. Contacte un administrateur ou déconnecte-toi.",
    logout: {
      button: "Se déconnecter",
      unverified:
        "Ventes locales non vérifiées : elles restent conservées sur cet appareil.",
      synced: "Ventes synchronisées.",
      stillPending:
        "Certaines ventes restent en attente (autre organisation, conflit ou réseau).",
    },
  },
} as const;

export default commonFr;
