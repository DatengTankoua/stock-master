# Lot 1-21D — Activation SasPay en production (préparation)

État : **préparation terminée localement**. Tarifs définitifs, capacité
incluse (1 000 fiches produit), présentation, textes publics et juridiques,
pied de page et gardes du panneau de paiement sont implémentés et testés
(§ 8). Les documents juridiques 0.5 sont **archivés localement** à la date
prévue du **2026-10-13** (§ 8.10) ; leur publication réelle aura lieu au
déploiement.

Aucun commit, push, déploiement, changement de variable, paiement réel ni
activation. Aucun appel à l'API SasPay pour ce lot. Le document s'appuie
sur les rapports 1-21A, 1-21B et 1-21C (recette LIVE du 2026-10-12) et sur
le dépôt, branche `feature/phase-1-21b-saspay-checkout`.

**Choix commercial retenu :**
- frais **absorbés** par Stock Master (réglage marchand « Déduits »,
  `DEDUCTED`, constaté en LIVE le 2026-10-12, 1-21C § 7.1) ;
- le client paie **exactement** le prix affiché, en une fois ;
- **tarifs définitifs**, `pricingVersion` **2** :

  | Formule | Version 1 (en production) | Version 2 (1-21D) | Économie | Équivalent mensuel |
  |---|---|---|---|---|
  | Mensuel | 3 000 | **3 500** | — | — |
  | Trimestriel | 8 500 | **10 000** | 500 | ≈ 3 333 |
  | Semestriel | 16 000 | **18 500** | 2 500 | ≈ 3 083 |
  | Annuel | 30 000 | **35 000** | 7 000, soit **2 mois offerts** (12 mois au prix de 10) | ≈ 2 917 |

  La grille intermédiaire 3 500 / 9 000 / 16 500 / 30 500, jamais publiée,
  a été remplacée **dans la même version 2**, sans version 3.

## 1. Prérequis bloquants

Aucun ne peut être levé par une variable d'environnement. Tous sont à faire
**avant** l'activation (§ 4, étape 7).

| # | Prérequis | Pourquoi | État au 2026-10-12 |
|---|---|---|---|
| P1 | **Code** : revue puis commit des changements 1-21C et 1-21D (fichiers API, web, tests et archives non commités, § 8), puis fusion dans `main` (la branche a 5 commits d'avance sur `origin/main` : 1-20D, 1-20E, 1-20F, 1-20F suite, 1-21B) | Sans la correction de l'hôte `checkout.saspay.me`, **chaque** création devient incertaine (démontré en LIVE, 1-21C § 6 bis) | à faire |
| P2 | **Juridique** : versions **0.5** de `conditions-abonnement` et `confidentialite` (FR/EN) **archivées localement** au 2026-10-13 (§ 8.10), politique de remboursement intégrée (§ 8.11). Reste : **validation juridique**, non acquise (applicabilité de la rétractation, conformité du non-remboursement, régime fiscal, autres « À COMPLÉTER ») ; ajuster la date si le lancement est reporté | L'archivage local ne vaut pas validation juridique | **validation à obtenir** (§ 8.11) |
| P3 | **Clé de production dédiée** : nouvelle clé SasPay `LIVE`, portée `PAYIN`, créée pour Railway seulement | La clé de recette a séjourné dans `api/.env.local` sur un poste : la révoquer ensuite | à faire |
| P4 | **Webhooks de recette supprimés** (`92650337…` et abonnements orphelins `e14e9bb4…`, 1-21C § 8) | Éviter des livraisons LIVE vers un tunnel mort | à faire (titulaire) |
| P5 | **Réglage « Déduits »** pour les encaissements | Constaté effectif sur la transaction LIVE de recette (`fee_charge_mode: DEDUCTED`, débit = prix). C'est la **seule prévention** d'un supplément de frais (D1) | **fait** ; à surveiller |
| P6 | **Confirmations écrites de SasPay** : règle d'arrondi des frais (18 XAF observés pour 500 XAF), sens de `my-rates.fee_charge_mode` (affichait `ADD_ON` alors que le compte est « Déduits »), contrat et titulaire des fonds (1-21A, B6), option `ALLOW_CLIENT_OVERRIDE` (D1) | Marges, conformité, prévention des frais | à demander |
| P7 | **Railway** : « Pre-deploy Command » configurée (README) ; **domaine public de l'API confirmé** (§ 3) ; `PUBLIC_APP_URL` exact | Ordre des migrations ; URL de retour et URL du webhook | à vérifier dans le tableau de bord |
| P8 | **Lecture seule en production** : `db.subscription_payments.aggregate([{ $group: { _id: { provider: "$provider", status: "$status", open: "$open" }, n: { $sum: 1 } } }])` | Aucun paiement CamPay ou autre ouvert attendu (1-21A § 0) | à faire |
| P9 | **Vercel** : l'option « Include files outside the root directory in the Build Step » doit être active (c'est le défaut) | Le web importe au build `api/src/subscriptions/subscription-pricing.ts` et `api/src/products/product-capacity.ts` (§ 8) | à vérifier dans le tableau de bord |

## 2. Variables exactes (service API, Railway)

Rien n'est à ajouter côté Vercel : le web lit les capacités sur l'API.

| Variable | Phase A — déployé, inactif | Phase B — actif | Règles vérifiées au démarrage |
|---|---|---|---|
| `NODE_ENV` | `production` (inchangé) | `production` | `sandbox` refusé en production, même avec `none` |
| `PUBLIC_APP_URL` | origine **exacte** du web public, sans chemin | inchangé | URL de retour = `PUBLIC_APP_URL/app/organization/subscription?payment=<id>` (jamais le navigateur) |
| `SASPAY_ENVIRONMENT` | `live` | `live` | `sandbox` \| `live` ; incohérent avec le préfixe de la clé → refus |
| `SASPAY_SECRET_KEY` | clé `sk_live_…` **dédiée** (P3), portée `PAYIN` | inchangée | préfixe `sk_live_` + corps `[A-Za-z0-9_-]{16,256}` |
| `SASPAY_WEBHOOK_SECRET` | secret de signature du webhook de production (§ 3) | inchangé | 16 à 512 caractères ; différent de la clé et de `JWT_SECRET` ; vide → webhook 503 |
| `PAYMENT_PROVIDER_ACTIVE` | **`none`** | **`saspay`** | `none` \| `saspay` ; toute autre valeur, `campay` compris, est refusée |

- Toutes les valeurs secrètes sont saisies **uniquement** dans Railway. Un
  refus au démarrage ne cite jamais la valeur.
- **Phase A** (clé et secret présents, `none`) : les créations répondent
  503 ; les confirmations SasPay (`refresh`, webhook, CLI) fonctionnent
  déjà. C'est aussi l'état de désactivation (§ 5).
- **Aucune variable ne fixe un prix.** Le tarif de recette de 500 XAF n'a
  existé que dans un script hors dépôt (1-21C § 4).

### Contrôle des tarifs réellement déployés

La requête sur `pricingVersion` en base ne prouve que les paiements **déjà
créés**. Le tarif **déployé** se lit sur l'API en service :

```
GET https://<API>/organizations/current/subscription/payments/capabilities
Authorization: Bearer <jeton d'un propriétaire>
```

Réponse attendue, en lecture seule, sans création de paiement ni appel à
SasPay. `available`/`method` dépendent de la phase.

```json
{
  "available": false,
  "method": null,
  "pricing": {
    "version": 2,
    "currency": "XAF",
    "prices": [
      { "term": "monthly", "months": 1, "amount": 3500 },
      { "term": "quarterly", "months": 3, "amount": 10000 },
      { "term": "semiannual", "months": 6, "amount": 18500 },
      { "term": "annual", "months": 12, "amount": 35000 }
    ]
  }
}
```

À vérifier **aussi** sur le web déployé : la page publique (`/#tarifs`) et
les conditions d'abonnement affichent les mêmes montants, puisqu'elles sont
construites depuis le même module au build Vercel.

Après le premier paiement : `db.subscription_payments.countDocuments({ pricingVersion: { $nin: [1, 2] } })`
vaut **0**, et les nouveaux paiements portent la version 2.

## 3. Webhook de production

L'URL permanente **n'est pas encore confirmée** : le domaine réel de l'API
n'est pas dans le dépôt. Le README ne donne qu'un modèle ; `.env.prod.example`
et `nginx/nginx.conf` citent `api.stock-master.app`, mais pour la variante
Docker Compose ; 1-14D.2E1 le note comme inconnu.

**À faire avant de créer le webhook :**
1. Railway → service `api` → Settings → Networking : relever le domaine
   public ou personnalisé.
2. Il doit être identique à `NEXT_PUBLIC_API_URL` dans Vercel.
3. L'URL est alors `https://<ce domaine>/payments/webhooks/saspay`
   (chemin exact, sans préfixe ni barre finale).

**Tableau de bord SasPay**, nouveau point de réception :
- environnement **LIVE** ;
- événements : `transaction.success`, `transaction.failed`,
  `transaction.cancelled`. `transaction.created` est inutile : en recette,
  ses montants contredisaient `verify` ;
- secret de signature (affiché une fois) copié dans `SASPAY_WEBHOOK_SECRET`.

**Contrôles sans paiement**, une fois l'API déployée avec le secret :

| Requête | Attendu |
|---|---|
| `POST <URL>` avec `{}` non signé | **401** `PAYMENT_WEBHOOK_UNAUTHORIZED` (le secret est chargé) |
| même requête, secret absent | 503 `PAYMENT_WEBHOOK_DISABLED` |
| `GET <URL>` | 404 |

**Limitation de débit.** 60 requêtes par minute et par adresse ; derrière
Railway sans réglage de proxy validé (1-14D.2E1), toutes les livraisons
partagent ce compteur. Sans incidence au lancement. En cas de 429, SasPay
renvoie la notification, et « Vérifier » ainsi que le CLI restent
disponibles.

## 4. Ordre des opérations

**API inactive → web prêt → contrôles → activation.**

| Étape | Action | Effet visible | Contrôle |
|---|---|---|---|
| 0 | Prérequis P1 à P9 | — | § 1 |
| 1 | Domaine confirmé (P7), puis SasPay : webhook de production (§ 3) | aucun | point de réception `LIVE` actif, 3 événements |
| 2 | Railway : variables de **phase A** (`none`, `live`, clé dédiée, secret webhook, `PUBLIC_APP_URL`) | redémarrage de la version en service, qui ignore ces variables si elle les précède | démarrage sans erreur |
| 3 | Fusion dans `main` → **Railway** : build → Pre-deploy `node /app/api/dist/migrations/predeploy-migrations.js` → démarrage | aucun (`none`) | « toutes les migrations sont appliquées » ; l'API démarre (elle vérifie l'index `provider_1_providerTransactionId_1`) |
| 4 | **Vercel** déploie le web (même push) | nouveaux prix et accroches ; documents 0.5 ; dans l'espace Abonnement : **« Le paiement en ligne est momentanément indisponible »**, sans formulaire | voir ci-dessous |
| 5 | Contrôles sans paiement | — | capacités : `available: false` + `pricing` attendu (§ 2) ; page publique et conditions aux mêmes montants ; webhook non signé → 401 ; création → 503 |
| 6 | **Activation** : `PAYMENT_PROVIDER_ACTIVE=saspay` (redémarrage Railway) | « Payer en ligne » disponible | capacités `available: true`, `hosted-checkout`, même `pricing` |
| 7 | Premier paiement réel par le titulaire, sur son organisation, durée **mensuelle 3 500 XAF** (autorisation séparée) | — | voir ci-dessous |
| 8 | Surveillance des premiers jours | — | § 6 |

**Fenêtre entre les étapes 4 et 6.** Les textes publiés (page publique, FAQ,
guide, conditions 0.5) décrivent le paiement en ligne, alors que l'espace
Abonnement affiche « momentanément indisponible ». Il faut la garder courte,
et faire coïncider la **date effective** des documents 0.5 avec le jour
prévu de l'activation.

**Ancien onglet** (web antérieur à ce lot), API active : il ignore le
numéro et n'affiche pas le lien, mais « Vérifier » fonctionne (1-21B § 11).

**Ordre des migrations** (étape 3, `predeploy-migrations.js`, dans cet
ordre, idempotentes ; arrêt au premier échec, version en service
conservée) :

1. `create-sale-operations-index.js`
2. `create-subscription-period-indexes.js`
3. `create-subscription-payment-indexes.js` (index partiel unique
   `provider_1_providerTransactionId_1`, nouveau en 1-21B)
4. `create-subscription-payment-reconciliation-indexes.js`
5. `create-push-notification-indexes.js`
6. `create-support-request-indexes.js`
7. `create-legal-acceptance-indexes.js`
8. `create-invitation-account-token-index.js`
9. `create-rate-limit-indexes.js`
10. `create-sale-history-indexes.js` (1-20E, livré par cette fusion)
11. `create-product-page-indexes.js` (1-20F, livré par cette fusion)

Sans « Pre-deploy Command », les lancer depuis un poste **avant** la
fusion : `pnpm --filter api build`, puis
`MONGODB_URI=<uri-atlas> pnpm --filter api migrate:predeploy`.

**Contrôles du premier paiement réel (étape 7) :**

| Contrôle | Attendu |
|---|---|
| Panneau après création | « Montant total 3 500 FCFA » et « Continuer vers le paiement de 3 500 FCFA » |
| Page SasPay, avant validation | **3 500 XAF** exactement (sinon : ne pas valider) |
| Webhook `transaction.success` | 200 |
| Paiement | `succeeded`, `pricingVersion` 2, 1 période, transaction rattachée |
| SasPay `verify` | `DEDUCTED`, `debited_amount` = `requested_amount` = `3500.00` |
| CLI `inspect` ; nouvelle vérification | concordant ; aucune seconde période |

## 5. Désactivation des nouveaux paiements, confirmations conservées

**Action unique.** Railway, service API : `PAYMENT_PROVIDER_ACTIVE=none`.
Ne pas toucher à `SASPAY_ENVIRONMENT`, `SASPAY_SECRET_KEY` ni
`SASPAY_WEBHOOK_SECRET`. Le webhook SasPay reste actif.

Effets, prouvés par `saspay-confirmation-only.e2e-spec.ts`,
`payment-providers.wiring.spec.ts` et `payment-guards.spec.ts` :

| Fonction | Après `none` |
|---|---|
| Nouvelle création (API) | **503**, rien n'est écrit, aucun appel à SasPay |
| Capacités | `available: false` (avec `pricing`) |
| Web (ce lot) | message FR/EN « Le paiement en ligne est momentanément indisponible… » ; **ni** bouton « Renouveler », **ni** formulaire, **ni** champ numéro, **ni** « Nouvel essai » ; consultation, historique et **« Vérifier le paiement »** conservés |
| Web, API antérieure (404 aux capacités) | distinct : ancien formulaire Mobile Money (inchangé) |
| « Vérifier » / retour du payeur, webhook, CLI | **confirment** les paiements SasPay ouverts |
| Paiements déjà `succeeded` | inchangés |

**Résorption des paiements ouverts :**

1. Lister, en lecture seule :

   ```
   db.subscription_payments.find(
     { provider: "saspay", open: true },
     { status: 1, merchantReference: 1, providerReference: 1, initiatedAt: 1, incidentCode: 1 }
   )
   ```

2. `pending` : la page SasPay expire 30 minutes après l'initiation. Le
   payeur, le webhook ou « Vérifier » concluent : succès, ou `uncertain` +
   `checkout_unresolved`.
3. `uncertain` / `checkout_unresolved`, **après** confirmation par SasPay
   qu'aucun débit n'a eu lieu :

   ```
   # simulation (aucune écriture) : plan et jeton
   pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --close-unresolved
   # application explicite
   pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id> --close-unresolved \
     --apply --plan=<jeton> --operation-id=<uuid v4> --operator=<identifiant> \
     --reason=provider-checkout-closed [--ticket=<référence>]
   ```

   Le CLI s'exécute avec les variables du service de production, jamais
   avec `api/.env.local` de recette.
4. `review` : `inspect`, puis `reconcile` avec `--reference` et le motif
   adapté. Jamais d'attribution manuelle hors du CLI.

**Arrêt complet**, facultatif, quand la requête du point 1 ne renvoie plus
rien : retirer `SASPAY_SECRET_KEY` et `SASPAY_WEBHOOK_SECRET`, puis
supprimer le webhook dans SasPay.

**Jamais :** supprimer un paiement, changer son `provider`, relancer un
débit (`retry`), recréer une session pour un paiement ouvert, modifier un
montant enregistré.

**Retour arrière du code** : seulement après la résorption (1-21B § 11).

## 6. Surveillance après activation

| Signal | Où | Action |
|---|---|---|
| Paiements `review` / `uncertain` | requête du § 5 | `inspect` puis `reconcile` |
| Tarifs déployés | capacités (§ 2) après chaque déploiement | version 2 et grille attendue |
| `pricingVersion` hors {1, 2} | requête du § 2 | **0 attendu** ; sinon désactiver (§ 5) |
| Livraisons en échec | SasPay → historique des webhooks | secret, domaine, limitation |
| `fee_charge_mode` des transactions | `verify` lors des rapprochements | **`DEDUCTED` attendu** (D1) |
| Solde SasPay / paiements `succeeded` | rapprochement mensuel | net = prix − `client_fee` |

## 7. Décisions et risques avant l'activation

- **D1 — supplément de frais (correction).** Un passage en `review` après
  le débit **ne prévient pas** un supplément : le client aurait déjà payé.
  - **Prévention actuelle :** uniquement le réglage marchand « Déduits »
    (P5), validé en LIVE le 2026-10-12. Le payeur voit le montant exact sur
    la page SasPay avant de valider.
  - **Contrôles conservés :** la concordance exacte de l'adaptateur (prix
    demandé = prix enregistré ; débit = prix en `DEDUCTED`, = prix + frais
    confirmés en `ADD_ON`). Elle garantit qu'aucun montant incohérent
    n'attribue d'abonnement, pas l'absence de supplément.
  - **Dépendance assumée :** si le réglage repassait en `ADD_ON`, un client
    paierait prix + frais. Cela se détecterait au rapprochement (§ 6), après
    coup.
  - **Prévention possible (à confirmer, P6) :** si SasPay active
    `ALLOW_CLIENT_OVERRIDE` sur le compte, l'adaptateur pourrait envoyer
    `fee_charge_mode: "DEDUCTED"` à chaque session (petit lot de code). Sans
    cette option, la valeur est ignorée silencieusement (documentation
    SasPay).
- **D2 — journal de raison.** La cause du 503 transitoire de la première
  livraison de recette n'est pas connue. Option : journaliser, sans
  donnée, la raison d'échec de la vérification. Non bloquant.
- **D3 — durée de la page.** 30 minutes, suffisant en recette.
- **D4 — affichage pendant une désactivation.** **Fait** (§ 5, § 8.5).

## 8. Changements 1-21D

### 8.1 Tarifs : source unique

| Élément | État |
|---|---|
| `api/src/subscriptions/subscription-pricing.ts` | **seule table** : 3 500 / 10 000 / 18 500 / 35 000 ; `SUBSCRIPTION_PRICING_VERSION = 2` (corrigée, non publiée) ; historique en commentaire ; module **pur** (seul import : `subscription-terms`) |
| `web/src/lib/subscription-offers.ts` | **aucun montant** : importe le catalogue serveur au build ; calcule l'économie (`mois × mensuel − total`), les **mois offerts** (seulement si l'économie vaut un nombre exact de mensualités : 7 000 = 2 × 3 500), la **meilleure économie** (unique et positive) et l'équivalent mensuel (arrondi, présenté comme comparaison) |
| Capacités de l'API | exposent le catalogue courant (`pricing`) en lecture seule : contrôle des tarifs déployés (§ 2) |
| Capacité incluse | 1 000 fiches produit par organisation, corbeille comprise (§ 8.8) |
| `web/Dockerfile` | copie les modules serveur purs (tarifs, durées, capacité ; image non construite : moteur Docker local indisponible) |
| Paiements existants | **inchangés** : montant et version figés à la création, jamais réécrits ni comparés au tarif courant |

**Aucun prix ne vient d'une requête** : le DTO n'accepte que `term`,
`payerPhone` et `clientOperationId` (`forbidNonWhitelisted`), et
`getSubscriptionPrice` ne prend que la durée.

### 8.2 Présentation (FR/EN)

Cartes de la page publique et de l'espace Abonnement, mêmes accroches
(`web/src/lib/subscription-offer-pitch.ts`) :

| Durée | Accroche | Texte |
|---|---|---|
| 1 mois | « Commencez à votre rythme » / « Start at your own pace » | « Un mois pour gérer votre activité au quotidien. » |
| 3 mois | « Prenez trois mois d'avance » / « Get three months ahead » | « Économisez {{amount}} par rapport au paiement mensuel. » (calculé : 500) |
| 6 mois | « Six mois pour développer votre activité » / « Six months to grow your business » | idem (2 500) |
| 12 mois | « Un an de gestion, {{count}} mois offerts » / « …, {{count}} months free » (calculé : 2) | idem (7 000) ; badge **« Meilleure économie »** / « Best savings » (calculé) |

- **Total payé le plus visible**, suivi de « payés en une fois pour
  12 mois » / « paid once for 12 months ».
- L'équivalent mensuel est formulé « Soit environ 2 917 FCFA par mois, à
  titre de comparaison » : il ne laisse pas croire à un prélèvement
  mensuel.
- Aucun renouvellement automatique, aucune popularité, urgence ni
  promotion. La mention existante « Aucun prélèvement automatique » est
  conservée.
- Les traductions ne contiennent **aucun montant** (variables
  `{{amount}}`, `{{count}}`, `{{title}}`). Aucun pourcentage n'est affiché :
  la présentation fournie n'en comporte pas.
- Page d'accueil : la méta-description (« 3 500 FCFA pour 1 mois, ou
  35 000 FCFA payés en une fois pour 12 mois ») et la note d'essai
  (« par exemple 35 000 FCFA payés en une fois pour 12 mois, soit environ
  2 917 FCFA par mois ») remplacent « à partir de … par mois ».

### 8.3 Textes publics

Mentions obsolètes d'indisponibilité **retirées** et remplacées par le
parcours réel (choix de la durée, paiement en une fois par Mobile Money MTN
ou Orange sur la page SasPay, frais pris en charge par Stock Master,
« Vérifier le paiement ») :
- page publique `landing.pricing.text` ;
- FAQ « Comment fonctionne l'abonnement ? » (avec et sans essai) ;
- guide (FR/EN) ;
- cookies 0.6 : « inutilisé tant que le paiement en ligne est fermé »
  retiré (document non archivé : seul le numéro change).

### 8.4 Documents juridiques 0.5 (archivés localement au 2026-10-13, § 8.10)

| Document | Changements | Archive |
|---|---|---|
| `conditions-abonnement` 0.5 (FR/EN) | capacité incluse (§ 8.8) ; tableau « Total payé en une fois » / « Équivalent mensuel et économie » (2 mois offerts calculés) ; frais SasPay pris en charge, montant affiché sur la page de paiement avant validation ; prix applicable = celui du moment de la demande de paiement ; procédure de paiement et de confirmation serveur ; mention « paiement en ligne pas encore activé » **retirée** | **écrite** (2026-10-13) |
| `confidentialite` 0.5 (FR/EN) | SasPay (Payix LLC) destinataire : données transmises (nom, e-mail, montant, devise, durée, référence, pays, adresse de retour) ; numéro Mobile Money saisi chez SasPay, ni numéro ni code secret conservés par Stock Master ; identifiants de session et transaction et adresse de la page conservés ; transfert hors du Cameroun (Payix LLC, États-Unis et Bénin, d'après les mentions légales de SasPay, 1-21A) | **écrite** (2026-10-13) |

Rien n'est inventé sur SasPay : pas de garantie, de délai ni de durée de
conservation. Les points ouverts restent des commentaires non publiés
(« À COMPLÉTER »), dont **rétractation et remboursement, à fixer avec un
juriste avant tout paiement**.

**Préparation et publication.** La date affichée (« Version 0.5, mise à
jour le 13 octobre 2026 ») fait partie du texte archivé. Elle égale
`publishedAt` dans le manifeste, que l'API renvoie dans les preuves
d'acceptation. Archivage, contrôles et procédure en cas de report : § 8.10.
La capacité incluse (§ 8.8) a été ajoutée **avant** l'archivage.

### 8.5 Cohérence du prix et paiements désactivés (web)

- **Après création**, le panneau présente le montant **enregistré** renvoyé
  par l'API (« Montant total ») et le bouton « Continuer vers le paiement de
  3 500 FCFA », avant toute navigation vers SasPay. Aucune redirection
  automatique.
- **Prix changé** (`chargedAmountChange`) : si ce montant diffère du prix
  affiché dans l'onglet au moment de l'envoi, le panneau l'annonce (« Le
  tarif a changé … ce paiement est de 3 500 FCFA, et non 3 000 FCFA ») et
  **masque le lien** jusqu'au clic « Continuer avec 3 500 FCFA ». Le montant
  du paiement n'est jamais modifié. *Limite :* un onglet chargé avant ce lot
  exécute l'ancien code et n'a pas ce contrôle. Il n'a pas non plus le
  parcours SasPay (1-21B § 11), et l'API ne facture que le montant
  enregistré.
- **Paiements désactivés** (`paymentAvailability`) : distingués de l'API
  antérieure (§ 5).

### 8.6 Où changer les prix à l'avenir

1. `SUBSCRIPTION_PRICES_XAF` dans
   `api/src/subscriptions/subscription-pricing.ts` (seul fichier).
2. Incrémenter `SUBSCRIPTION_PRICING_VERSION` (sauf correction d'une
   version jamais publiée) et compléter l'historique.
3. Tests : `subscription-pricing.spec.ts` (montants, économies, mois
   offerts) et les e2e qui figent un tarif.
4. Juridique : nouvelle version de `conditions-abonnement`, puis archivage
   (la CI web bloque sinon).
5. Déployer API et web depuis le même commit ; contrôler les capacités
   (§ 2).

| Écran | Source | Moment |
|---|---|---|
| Montant facturé, capacités | module serveur, dans l'API | déploiement Railway |
| Page publique, sélecteur, accroches, conditions d'abonnement | module serveur, importé par le web | build Vercel |
| Paiement existant, historique | montant enregistré (API) | immédiat, jamais modifié |

### 8.7 Vérifications

| Contrôle | Résultat |
|---|---|
| Unitaires `src/subscriptions` : quatre prix, version 2, montant forgé ignoré, économies **500 / 2 500 / 7 000**, **2 mois offerts** (12 au prix de 10) et règle des mois exacts, meilleure économie, équivalent 2 917, aucun montant (actuel, v1 ni intermédiaire) dans le module web | **401 / 401** |
| `payment-guards.spec.ts` : `available:false` ≠ 404 (Mobile Money) ; **affichage 3 000 / API 3 500 → confirmation demandée** ; identique → aucune | **3 / 3** (inclus ci-dessus) |
| E2E `subscription-payments` (création 3 500, `amount` refusé, tarif figé au rejeu et à la confirmation), `saspay-checkout` (capacités + `pricing`), `saspay-confirmation-only` (désactivé + `pricing` ; **ancien paiement 3 000 v1 confirmé à son montant**, période attribuée) | **71 / 71** |
| E2E CamPay, rapprochement, CLI, accès (tarif mensuel inchangé depuis la dernière exécution : 3 500) | 76 / 76 et 32 / 32 (exécution précédente) |
| API : build, ESLint (0 erreur), Prettier | OK |
| Web : `tsc`, ESLint (0 erreur), `check-i18n` (0 problème), `i18n:coverage` (0 texte en dur) | OK |
| Web : **`next build` isolé** | **OK** ; archives 0.5 écrites ensuite au 2026-10-13, contrôle à 0 problème (§ 8.10) |
| **Cartes, navigateur** (recette locale, faux SasPay ; Playwright 1.62.1 / Chromium) : accueil FR 1280 et 390, EN 390 ; espace Abonnement FR 1280 et 390 ; paiement créé | **45 / 45** contrôles : montants, accroches, badge, « payés en une fois », équivalent, absence de mention d'indisponibilité, **aucun défilement horizontal**, montant API et bouton « Continuer vers le paiement de 3 500 FCFA », aucune confirmation si le prix est identique |
| Non vérifié en navigateur | l'état « indisponible » et l'avertissement de prix changé (pas de mode `none` dans la recette ; couverts par les tests purs et par le code) ; image Docker web |

**Capacité, pied de page et archivage (2026-10-12) :**

| Contrôle | Résultat |
|---|---|
| E2E `product-capacity` (nouveau, vraies transactions) : 1 000e acceptée, **1 001e refusée** (409, FR/EN, aucune photo comptée) ; **créations simultanées** à 998 → 2 acceptées, 4 refusées (preuve par mutation) ; isolation entre organisations ; corbeille et restauration au plafond sans changement de compteur ; ventes, lecture et modification conservées ; suppression définitive → place libérée, ventes conservées ; échec, doublon et requête invalide sans dérive ; organisation **au-delà** du plafond (1 005) : données conservées, créations refusées ; route réservée | **8 / 8** |
| `product-capacity.spec.ts` (valeur, règle, réexport web, aucun nombre copié) | **2 / 2** |
| Unitaires API complets | **1 781 / 1 781** |
| E2E existants touchés : stockage, rapprochement du stockage, pagination produits, permissions par champ, isolation, identité visuelle | **140 / 140** |
| E2E `legal-acceptance` (0.5 en vigueur, preuve 0.3 conservée) et `legal.spec` (0.3 et 0.4 figées, 0.5 du 2026-10-13) | **19 / 19** et **21 / 21** |
| API : ESLint (0 erreur), Prettier, build ; Web : `tsc`, ESLint (0 erreur), `check-i18n` (0), `i18n:coverage` (0) | OK |
| `next build` isolé + contrôle d'archive après archivage | **OK, 0 problème** |
| Navigateur (recette locale, Playwright) : compteur 999 → 1 000 après création par l'interface, message au plafond, **refus de la 1 001e** dans l'interface (FR), refus API EN, mobile FR/EN (« 1 000 / 1 000 produits », « 1,000 / 1,000 products »), pied de page FR/EN bureau et mobile sur l'accueil et les conditions, conditions FR (capacité, version 0.5 du 13 octobre 2026) | **25 / 27** |
| Les 2 écarts (corrigés ensuite) | débordement horizontal de 12 à 13 px des pages de documents en 390 px, causé par l'en-tête commun `PublicHeader` : la marque (lien en ligne, non rétrécissable) et la navigation dépassaient la largeur utile. **Corrigé à la cause** : lien `block min-w-0` (la marque, déjà `max-w-full`, se réduit), navigation `shrink-0`, marges resserrées sous 640 px ; aucun `overflow-x: hidden`. Revérifié : conditions, confidentialité, guide, contact et page 404, FR/EN en 390 et 360 px, puis bureau 1280 px : **50 / 50** (0 px de débordement, zones de clic ≥ 44 px, logo 140 px sur bureau) |

Recette arrêtée et nettoyée ; captures hors dépôt.

### 8.8 Capacité incluse : 1 000 fiches produit

**Décisions :**
- 1 000 fiches **conservées** par organisation, corbeille comprise ;
- même capacité pour les quatre durées ;
- tarifs inchangés.

**Modèle vérifié.**
- Le catalogue **n'a pas de variantes** : un document `products` = une
  fiche.
- La corbeille est `deletedAt` renseigné.
- Seule la suppression définitive retire le document.

Une fiche compte donc :
- quelle que soit sa quantité, rupture comprise ;
- y compris à la corbeille.

Ventes et historiques ne comptent pas.

**Source unique.** `api/src/products/product-capacity.ts`
(`PRODUCT_CAPACITY = 1000`, module pur).
- L'API l'applique et l'expose (`GET /products/capacity`).
- Le web le réexporte au build (`web/src/lib/product-capacity.ts`) pour les
  conditions d'abonnement.
- Les traductions ne contiennent que des variables (`{{used}}`,
  `{{limit}}`, `{{trashed}}`).
- Un test vérifie qu'aucun « 1 000 » n'est copié côté web.

**Chemins de création recensés.** Un seul : `POST /products`
(`ProductsService.create`). Il n'y a ni duplication, ni import, ni
création par la synchronisation hors ligne (qui ne transporte que des
ventes). La clé i18n `duplicate.*` concerne l'avertissement « nom déjà
existant », pas une duplication de fiche.

**Mécanisme (réutilise l'existant, sans nouveau système de quotas).** Le
quota de stockage (1-17B) tient un compteur d'octets, nécessaire parce que
les fichiers sont hors base. Ici, le décompte **exact** existe déjà : le
nombre de documents `products` de l'organisation. Il n'y a donc **ni
compteur persistant, ni migration, ni initialisation**, et aucune dérive
possible.

| Étape | Où | Rôle |
|---|---|---|
| Pré-contrôle | contrôleur, **avant** l'envoi de la photo | évite un envoi inutile (non décisif) |
| Décision | **dans la transaction** de création existante (`inTransaction`) | 1. écriture du document de l'organisation (`$inc productCreationSerial`, jeton technique) ; 2. décompte des fiches ; 3. refus `409 PRODUCT_CAPACITY_REACHED` si ≥ 1 000 ; 4. insertion et rattachement de la photo (inchangés) |

L'écriture du point 1 met en **conflit d'écriture** deux créations
simultanées de la même organisation. La seconde est rejouée par le pilote
(`withTransaction`) et recompte en voyant la première. Un simple « compter
puis insérer » laisserait passer plusieurs créations à 999.

- **Preuve par mutation :** sans cette écriture, six créations simultanées
  à 998 passent toutes (1 004 fiches) et le test échoue. Avec elle,
  exactement deux passent.
- **Échec, refus ou rejeu :** la transaction est annulée, la photo est
  libérée par le chemin existant (`discard`), et rien n'est compté en trop.

`productCreationSerial` est un champ facultatif du schéma `Organization` :
`select: false`, sans valeur par défaut, jamais lu ni exposé. Ce n'est pas
un compteur de fiches.

**À la limite :**
- seules les **nouvelles fiches** sont refusées ;
- ventes, lecture, modification, mise à la corbeille et restauration
  restent permises ;
- rien n'est supprimé automatiquement.

Une organisation **déjà au-delà** de 1 000 garde toutes ses données ; seules
les créations sont refusées tant qu'elle ne repasse pas sous le plafond, par
suppression définitive volontaire.

**Affichage (web).** Page d'un catalogue, sous l'en-tête, pour les seuls
membres ayant `products.manage` :
- « 999 / 1 000 produits » (total **serveur**, jamais une page) ;
- au plafond : « Capacité atteinte : 1 000 fiches produit conservées,
  corbeille comprise (40 dans la corbeille). Les nouvelles fiches sont
  refusées ; les ventes, consultations et modifications restent
  possibles. »

Aucune incitation à supprimer, aucun ajout aux cartes des offres.

Le refus serveur (FR/EN) ne contient pas de nombre, que le mécanisme de
traduction ne formaterait pas : « Capacité incluse atteinte : nombre maximal
de fiches produit conservées, corbeille comprise… ».

**Conditions d'abonnement 0.5**, section « Ce que comprend
l'abonnement » (FR/EN), plafond injecté :

> **Capacité incluse.** Chaque organisation peut conserver jusqu'à 1 000
> fiches produit, y compris celles placées dans la corbeille ; chaque
> produit du catalogue constitue une fiche. Les quantités en stock
> n'entrent pas dans ce décompte, pas plus que les ventes et leur
> historique. Cette capacité est la même pour toutes les durées. Lorsqu'elle
> est atteinte, seule la création de nouvelles fiches est refusée.

**Photos et fichiers.** Le quota de stockage existant (1-17B) est
inchangé ; aucun nouveau seuil n'est créé.

**Déploiement.** Rien à initialiser. L'ordre du § 4 s'applique (API, puis
web). Une API antérieure ignore la route `capacity` (le web masque alors le
compteur) ; un web antérieur n'affiche pas le compteur, mais le refus
serveur s'applique.

**Feuille de route interne** (non annoncée, non implémentée) :
- extensions de capacité vers 2 000, puis 5 000 fiches produit ;
- capacité de stockage des fichiers distincte du nombre de produits ;
- tarification à définir plus tard, selon les coûts et les usages.

### 8.9 Pied de page public

« © 2026 Stock Master » (FR/EN) dans le composant commun
`PublicFooter` : accueil et toutes les pages de documents (juridiques,
guide, contact). L'année et le nom viennent de `SITE`
(`copyrightYear`, `name`) ; la traduction ne garde que la forme
`© {{year}} {{name}}`.

### 8.10 Documents juridiques : archivage local du 2026-10-13

| Document | Version | Date | Fichiers ajoutés |
|---|---|---|---|
| `conditions-abonnement` | **0.5** courante | 2026-10-13 | `0.5.fr.txt`, `0.5.en.txt` |
| `confidentialite` | **0.5** courante | 2026-10-13 | `0.5.fr.txt`, `0.5.en.txt` |

- Les archives 0.3 et 0.4 sont **identiques octet pour octet**
  (empreintes comparées avant et après).
- Le texte archivé de la 0.5 contient la capacité incluse, les prix
  définitifs et SasPay, et ne contient plus « pas encore activé ».
- Contrôle `legal-archive.mjs check` après archivage : **0 problème**.
- L'archivage est **local** et ne publie rien : la publication a lieu au
  déploiement, l'API et le web servant le même manifeste (même commit).
- **Si le lancement est reporté :** la 0.5 n'étant pas publiée, changer la
  date dans `site-identity.ts` (`OCTOBER_13_2026`), supprimer les quatre
  fichiers `0.5.*.txt` et l'entrée `0.5` du manifeste (non publiés), puis
  réarchiver avec la nouvelle date. Une version publiée, elle, n'est
  jamais réécrite.

### 8.11 Rétractation et remboursement

**Décision commerciale du titulaire (2026-10-12) :**
- aucun remboursement pour changement d'avis, non-utilisation ou arrêt
  volontaire après paiement, y compris avant le début de la période ;
- une exception si une erreur imputable à Stock Master cause un préjudice
  au client, après vérification de l'incident ;
- un double débit confirmé pour un même achat n'est **pas** un geste
  commercial : le montant débité en double n'est pas dû ;
- les droits impératifs éventuellement applicables sont préservés.

**Texte des conditions 0.5, section « Arrêt, rétractation et
remboursement »** (FR ; l'EN est une traduction fidèle) :

> Comme rien n'est renouvelé automatiquement, il suffit de ne pas
> renouveler pour arrêter l'abonnement à la fin de la période en cours.
>
> Une période payée n'est pas remboursée en cas de changement d'avis, de
> non-utilisation du service ou d'arrêt volontaire, y compris lorsque le
> paiement a eu lieu avant le début de la période.
>
> - Par exception, lorsqu'une erreur imputable à Stock Master cause un
>   préjudice au client, celui-ci peut obtenir un remboursement, après
>   vérification de l'incident.
> - Un double débit confirmé pour un même achat n'est pas dû : le montant
>   débité en double est remboursé.
>
> Pour signaler un incident ou un double débit, écrivez à
> support@stock-master.app en indiquant le nom du commerce et la référence
> du paiement.
>
> Ces règles s'appliquent sans préjudice des droits que la loi applicable
> vous reconnaît de manière impérative, y compris un éventuel droit de
> rétractation.

**Ce qui n'est volontairement pas écrit**, car rien de tel n'existe ou n'a
été décidé : aucun délai de remboursement, aucune retenue de frais, aucun
montant forfaitaire, aucune procédure automatisée. Le seul canal est
l'adresse d'assistance existante. La rétractation n'est **pas** exclue.

**Réserve juridique, non levée.** La validation juridique **n'est pas
acquise**. Restent à faire trancher par un juriste, sans que l'archivage
local ne vaille validation :
- l'**applicabilité du droit de rétractation** (loi 2010/021, art. 20 ;
  décret 2011/1521/PM, art. 13 à 15 et 20 ; loi-cadre 2011/012, art. 7) à
  un abonnement en ligne payé par un commerçant, et l'éventuelle exception
  pour un service numérique fourni immédiatement ;
- la conformité de la règle de non-remboursement à ces textes ;
- les mentions obligatoires (prix TTC ou régime fiscal, identité de
  l'exploitant) ;
- le partage des responsabilités avec SasPay (Payix LLC) pour un
  remboursement.

Un commentaire non publié « À VALIDER par un juriste » le rappelle dans la
source. Les autres points « À COMPLÉTER » non publiés restent ouverts :
régime fiscal, justificatif et délai d'activation, conservation des
données d'un commerce qui ne renouvelle pas, délai de réponse aux
réclamations.

**Réarchivage local (0.5 non publiée).**
1. Entrée `0.5` des conditions retirée du manifeste, ainsi que ses deux
   fichiers.
2. Réécriture au **2026-10-13** :
   `isolated web-build --legal-archive=write --published-at=2026-10-13`.
3. Seules `conditions-abonnement/0.5.fr.txt` et `0.5.en.txt` changent.

Après réarchivage :
- les empreintes du manifeste égalent les fichiers ;
- la confidentialité 0.5 et toutes les versions 0.3 et 0.4 publiées sont
  inchangées (empreintes comparées) ;
- le contrôle d'archive ne signale aucun problème ;
- `legal.spec` (**21 / 21**) et `legal-acceptance` (**19 / 19**) passent.

## 9. Ce qui ne change pas

- Pas de nouvelle variable d'environnement, ni côté web ni côté API.
- **Une seule nouvelle route** : `GET /products/capacity`, en lecture
  seule et réservée à `products.manage` (§ 8.8). La route existante
  `GET …/payments/capabilities` gagne seulement un champ `pricing` en
  lecture (§ 2). Aucune autre route ajoutée ni modifiée.
- Le moteur commun d'abonnement reste indépendant du prestataire.
- CamPay reste non activable.
- Le premier paiement réel fera l'objet d'une autorisation distincte.
