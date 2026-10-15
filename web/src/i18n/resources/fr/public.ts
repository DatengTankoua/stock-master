// 1-16G — Pages publiques : accueil, en-têtes, pied de page.
const publicFr = {
  skipToContent: "Aller au contenu",
  nav: {
    features: "Fonctionnalités",
    offline: "Sans réseau",
    pricing: "Tarifs",
    faq: "Questions",
  },
  header: {
    homeTop: "Stock Master, haut de page",
    backHome: "Stock Master, retour à l'accueil",
    sections: "Sections de la page",
    sectionsMenu: "Sections de la page (menu)",
    openMenu: "Ouvrir le menu",
    closeMenu: "Fermer le menu",
    help: "Aide",
    guide: "Guide",
    contact: "Contact",
  },
  footer: {
    tagline: "Stock, ventes et équipe pour les commerces, depuis le téléphone.",
    help: "Aide et compte",
    legal: "Informations légales",
    languages: "Langue de la page",
    login: "Connexion",
    register: "Inscription",
    copyright: "© {{year}} {{name}}",
    pages: {
      guide: "Guide d'utilisation",
      contact: "Contact",
    },
  },
  cta: {
    loading: "Chargement…",
    openApp: "Ouvrir l'application",
    login: "Se connecter",
    register: "Créer un compte",
  },
  preview: {
    analyticsAlt:
      "Capture de l'écran Analyse de Stock Master pour la boutique fictive Boutique Démo, mois en cours : montant des ventes 137 500 FCFA (+13,8 % par rapport à la même période du mois précédent), 58 ventes pour 84 unités, gain estimé 28 050 FCFA, puis le graphique des ventes par jour.",
    salesAlt:
      "Capture de l'écran Ventes de Stock Master pour la boutique fictive Boutique Démo : dernières ventes enregistrées, avec produit, vendeur, date, quantité et montant en FCFA.",
    caption:
      "Captures réelles de l'application, interface en français · Boutique Démo, produits et ventes fictifs.",
  },
  // Bandeau affiché (en anglais) sur un appareil réglé en anglais.
  languageHint: {
    text: "Cette page existe aussi en anglais.",
    link: "Voir la version anglaise",
    dismiss: "Fermer",
  },
  landing: {
    meta: {
      title:
        "Logiciel de gestion de stock et de ventes au Cameroun | Stock Master",
      description:
        "Gérez le stock de votre boutique et suivez vos ventes depuis votre téléphone : produits, équipe et droits, analyses, historique Excel/PDF. Pour les commerces et PME au Cameroun.",
      price: "{{monthly}} pour 1 mois",
      trial: "Essai gratuit de {{days}} jours, puis {{price}}.",
      subscription: "Abonnement : {{price}}.",
      ogDescription:
        "Gestion de stock et suivi des ventes depuis le téléphone, pour les commerces et PME au Cameroun.",
      ogTrial: "Essai gratuit de {{days}} jours.",
    },
    hero: {
      eyebrow:
        "Gestion de stock et suivi des ventes pour les commerces au Cameroun",
      title:
        "Gérez le stock et les ventes de votre boutique depuis votre téléphone",
      text: "Une vente de deux savons ? Le stock baisse et vos collègues connectés voient la mise à jour. Stock Master rassemble le catalogue, les ventes et les repères utiles pour tenir votre boutique.",
      trialNote:
        "{{days}} jours d'essai gratuit, aucun paiement requis. Ensuite, <price>{{price}} pour {{term}}</price>, avec la formule mensuelle.",
      registrationClosed:
        "Les inscriptions sont momentanément fermées. Les commerces déjà inscrits peuvent se connecter.",
      alreadyRegistered: "Déjà inscrit ? <login>Se connecter</login>",
    },
    cta: {
      startTrial: "Commencer mon essai gratuit",
      login: "Se connecter",
      seePricing: "Voir les tarifs",
    },
    audience: {
      title: "Pour les boutiques, commerces et PME au Cameroun",
      text: "Stock Master s'adresse aux commerçants qui vendent des produits en stock et veulent savoir à tout moment ce qui reste et ce qui a été vendu, que vous teniez seul votre boutique ou que vous travailliez avec plusieurs vendeurs.",
      owner: {
        title: "Le propriétaire qui veut suivre ses ventes",
        text: "Depuis votre téléphone, voyez les ventes, le stock restant et les produits à réapprovisionner, même quand vous n'êtes pas au comptoir.",
      },
      team: {
        title: "La boutique avec plusieurs vendeurs",
        text: "Chaque vendeur a son propre accès. Vous décidez de ce qu'il peut voir et faire, et chaque vente garde le nom de celui qui l'a enregistrée.",
      },
      business: {
        title: "La PME qui veut un stock en ordre",
        text: "Catalogues et sous-catalogues, fiches produit avec photo, prix d'achat et de vente en FCFA, ajustements de stock et historique des modifications. Jusqu'à {{capacity}} fiches produit conservées par commerce, corbeille comprise.",
      },
      local: {
        title: "Pensé pour le quotidien au Cameroun",
        text: "Prix en FCFA, abonnement payé par Mobile Money (MTN ou Orange), interface en français ou en anglais, et ventes possibles pendant une coupure de réseau, dans les limites décrites plus bas.",
      },
    },
    benefits: {
      title: "Tout pour gérer votre boutique au quotidien",
      stock: {
        title: "Gérer vos produits et votre stock",
        text: "Rangez le riz, l'huile et les savons par catalogue, avec photo, prix d'achat et prix de vente. Chaque vente met à jour le stock ; les produits presque épuisés ou en rupture sont signalés selon vos droits.",
      },
      sales: {
        title: "Suivre vos ventes",
        text: "Choisissez le produit, la quantité et le prix réel. La vente garde sa date et le nom du vendeur. Les collègues connectés retrouvent les mises à jour sans recharger la page, et l'historique des ventes reste consultable selon vos droits.",
      },
      team: {
        title: "Donner à chacun les bons droits",
        text: "Invitez vos vendeurs avec un lien. Par défaut, un vendeur enregistre des ventes et voit les siennes ; vous ajoutez les autres droits un par un : gérer le catalogue, ajuster le stock, voir toutes les ventes, les coûts ou les analyses, inviter des membres. Un administrateur a tous les droits, et un accès peut être suspendu. Le prix ne change pas avec le nombre de vendeurs.",
      },
      analytics: {
        title: "Comprendre votre activité",
        text: "L'Analyse montre les produits à surveiller, les meilleures ventes et le gain estimé selon vos droits. Par exemple, repérez l'huile à réapprovisionner au rythme des ventes enregistrées : c'est une aide à la décision, pas une commande automatique ni un bénéfice garanti.",
      },
      history: {
        title: "Garder l'historique du mois",
        text: "Propriétaire et administrateur : choisissez un mois dans Analyse et téléchargez l'Excel ou le PDF. Retrouvez le bilan, les ventes, les produits, les vendeurs et les corrections, hors ventes encore en attente sur un appareil.",
      },
      notifications: {
        title: "Retrouver les alertes et l'aide",
        text: "La cloche rassemble les notifications correspondant à vos droits. Besoin d'aide sur une vente ? Le propriétaire, l'administrateur ou un vendeur autorisé peut écrire depuis Organisation → Assistance.",
      },
      alsoIncluded:
        "À votre façon : français ou anglais, mode clair ou sombre, logo et couleurs du commerce. Aussi inclus : corbeille et convertisseur euro ↔ franc CFA.",
    },
    offline: {
      title: "Le réseau coupe ? Vous continuez à vendre.",
      steps: {
        open: {
          title: "Ouvrez l'application avec du réseau",
          text: "Sur le même appareil, compte et commerce, chargez le catalogue avec une session autorisée à vendre. Le catalogue et cette autorisation sont conservés au plus 72 heures ; la session doit rester valide.",
        },
        sell: {
          title: "Vendez même sans connexion",
          text: "Une vente de savon reste sur cet appareil, marquée « en attente ». Le stock hors ligne est indicatif : il ne voit pas les ventes des collègues.",
        },
        sync: {
          title: "Le réseau revient, les ventes partent",
          text: "Avec l'application ouverte et une session valide, l'envoi reprend automatiquement. Le serveur revérifie le stock et les droits ; en cas de refus, consultez Ventes en attente.",
        },
      },
      note: "Sans réseau : catalogue déjà chargé et saisie de nouvelles ventes seulement. Produits, analyses, exports et gestion d'équipe demandent une connexion. La file est limitée à 200 ventes non finalisées par compte et commerce sur cet appareil ; après 14 jours, une vente n'est plus envoyée automatiquement. Gardez le même appareil pour la reprise.",
    },
    pricing: {
      title: "Un abonnement, la durée de votre choix",
      text: "Un tarif pour tout le commerce. Le montant indiqué est payé en une fois et couvre toute la durée choisie. Le propriétaire paie depuis l'espace Abonnement, par Mobile Money (MTN ou Orange) sur la page sécurisée de SasPay ; les frais de paiement sont pris en charge par Stock Master.",
      trial: "{{days}} jours d'essai gratuit, sans paiement Mobile Money",
      closed:
        "Les inscriptions sont momentanément fermées. <login>Se connecter</login>",
    },
    faq: {
      title: "Questions fréquentes",
      startOpen: {
        question: "Comment je commence ?",
        answer:
          "Créez votre compte avec le nom de votre commerce, puis confirmez votre adresse e-mail grâce au lien reçu. Connectez-vous, ajoutez vos rayons et vos produits : vous pouvez enregistrer vos premières ventes. L'essai gratuit de {{days}} jours commence à la création du commerce.",
      },
      startClosed: {
        question: "Comment je commence ?",
        answer:
          "Les inscriptions en ligne sont momentanément fermées. Si votre commerce a déjà un compte, connectez-vous. Un vendeur rejoint le commerce avec le lien d'invitation que lui transmet le propriétaire.",
      },
      sellers: {
        question: "Mes vendeurs peuvent-ils utiliser l'application ?",
        answer:
          "Oui. Depuis l'espace Organisation, créez une invitation : vous obtenez un lien à transmettre au vendeur, par SMS ou messagerie par exemple. Il crée son accès avec ce lien. Chaque membre peut enregistrer des ventes ; vous ajoutez les autres droits un par un.",
      },
      remote: {
        question: "Puis-je suivre les ventes de ma boutique à distance ?",
        answer:
          "Oui. Connectez-vous depuis votre téléphone : les ventes enregistrées par vos vendeurs apparaissent dès qu'elles sont envoyées, avec le stock mis à jour. Avec le droit correspondant, vous pouvez aussi recevoir une notification à chaque nouvelle vente d'un autre membre.",
      },
      install: {
        question: "Faut-il installer une application sur le téléphone ?",
        answer:
          "Non. Stock Master s'ouvre dans le navigateur d'un téléphone, d'une tablette ou d'un ordinateur, sans passer par un magasin d'applications. Vous avez la possibilité de télécharger l'application depuis le navigateur pour un accès plus rapide. Une fois téléchargée, vous pouvez l'ouvrir directement depuis votre écran d'accueil.",
      },
      network: {
        question: "Et si la connexion est mauvaise ?",
        answer:
          "Si vous avez ouvert l'application avec du réseau dans les 72 dernières heures, vous pouvez continuer à enregistrer des ventes sans connexion. Elles restent sur l'appareil jusqu'à 14 jours et partent dès que le réseau revient. Ajouter des produits, consulter les analyses ou gérer l'équipe demande une connexion.",
      },
      subscription: {
        question: "Comment fonctionne l'abonnement ?",
        answer:
          "Le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Il paie en ligne, en une fois, par Mobile Money (MTN ou Orange) sur la page sécurisée de SasPay ; les frais de paiement sont pris en charge par Stock Master. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
        answerTrial:
          "Après les {{days}} jours d'essai, le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Il paie en ligne, en une fois, par Mobile Money (MTN ou Orange) sur la page sécurisée de SasPay ; les frais de paiement sont pris en charge par Stock Master. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
      },
      privacy: {
        question: "Les autres commerces voient-ils mes données ?",
        answer:
          "Non. Chaque commerce a son propre espace. Seuls les membres que vous invitez y accèdent, avec les droits que vous leur donnez.",
      },
    },
    final: {
      titleOpen: "Essayez Stock Master dans votre boutique",
      titleClosed: "Retrouvez votre boutique dans Stock Master",
      textOpen:
        "Créez votre compte, ajoutez quelques produits et enregistrez vos premières ventes. Vous avez {{days}} jours gratuits pour vous faire un avis.",
      textClosed:
        "Connectez-vous pour retrouver votre catalogue, vos ventes et vos analyses.",
    },
  },
} as const;

export default publicFr;
