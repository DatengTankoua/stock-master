# Lot 1-21C — Recette SasPay LIVE contrôlée

État : **lot clos**. Un paiement LIVE de 500 XAF a été confirmé, rapproché
et retiré. Une période a été attribuée, sans double attribution. Pile et
ressources temporaires arrêtées. **Reste au titulaire :** supprimer les
webhooks de recette dans le tableau de bord SasPay (§ 8).

Branche `feature/phase-1-21b-saspay-checkout` (`1ce9778`), modifications
non commitées (§ 3 bis), `stash@{0}` conservé. Aucun commit, push, déploiement ni activation
publique. Aucun secret dans ce rapport, les journaux ou Git.

## 1. Cadre autorisé

| Élément | Valeur |
|---|---|
| Environnement SasPay | **LIVE** (aucune clé sandbox disponible, confirmé par le support SasPay) |
| Budget maximal | **1 000 XAF, frais compris** |
| Tarif de recette | **500 XAF**, durée mensuelle seulement, dans le processus isolé et sur la base de recette uniquement |
| Paiement et retrait | réalisés par le titulaire du compte lui-même |
| Hors périmètre | activation publique, déploiement, modification des tarifs de production |

## 2. Chronologie

| Date (UTC) | Opération | Résultat |
|---|---|---|
| 2026-10-11 | Recette sandbox (1-21C initial) | arrêtée : clé `sk_live_` trouvée, aucun appel |
| 2026-10-11 | `GET /pricing/my-rates/`, `/networks/`, `/merchant-webhooks/`, `/checkout-sessions/` | **401** `Clé API invalide.` (clé bien formée, en-tête `Bearer` conforme ; `/countries/` public : 200) |
| 2026-10-12 14:03 | Clé remplacée par le titulaire ; **une** vérification `GET /pricing/my-rates/` | **200**, enveloppe `{ success, data, code }` |
| 2026-10-12 14:21 | Pile isolée démarrée (§ 4) | API prête, configuration LIVE acceptée |
| 2026-10-12 14:26 | Tunnel `cloudflared` vers le relais | seul `POST /payments/webhooks/saspay` joignable (§ 4) |
| 2026-10-12 | Réglage `DEDUCTED` introuvable dans le tableau de bord (titulaire) | décision : rester en `ADD_ON`, adapter l'adaptateur (§ 3 bis) |
| 2026-10-12 14:58 | Contrôle du tunnel et de la pile | actifs ; aucune livraison SasPay reçue (3 requêtes, toutes émises par la recette) |
| 2026-10-12 15:14 | Lecture `/merchant-webhooks/` et `/merchant-webhook-subscriptions/` | 1 point de réception `LIVE`, actif, URL exacte du tunnel (§ 5) |
| 2026-10-12 15:14:36 | API redémarrée (secret + adaptateur § 3 bis) | webhook actif ; POST non signé → **401** (local et public) |
| 2026-10-12 15:14:53 | **Création unique** (`POST …/payments`, mensuel) | session SasPay créée ; tentative **`uncertain`** : hôte de page non autorisé (§ 6 bis) |
| 2026-10-12 15:16 | Lecture `GET /checkout-sessions/` | **1** session, `PENDING`, `500.00` XAF, `CM`, `metadata` = notre référence, retour accepté |
| 2026-10-12 15:17 | Titulaire : mode « Déduits » choisi pour les encaissements ; relecture `my-rates` | `my-rates` affiche **toujours `ADD_ON`** (MTN, Orange) : `DEDUCTED` non confirmé par l'API |
| 2026-10-12 15:17:49 | API redémarrée (hôte corrigé) ; `refresh` | session existante **adoptée** après vérification : `pending`, aucune période |
| 2026-10-12 15:18 | Rejeu de la création (même `clientOperationId`) | `replayed: true`, même paiement ; toujours **1** session chez SasPay |
| 2026-10-12 15:18 | Lien transmis au titulaire | expiration 15:44:53 UTC |
| 2026-10-12 15:32–15:33 | Paiement réalisé par le titulaire (Orange Money) ; webhooks réels | `created` 503 puis 200 (renvoi), `success` 200 ; paiement `succeeded` |
| 2026-10-12 15:33–15:34 | Vérifications répétées et concurrentes, rejeu ; relecture SasPay | 1 période ; session `PAID`, transaction `SUCCESS` `DEDUCTED` |
| 2026-10-12 15:34 | Arrêt de la pile, du tunnel et de la surveillance | fait **avant** la consigne « ne pas clôturer avant le rapprochement » ; données conservées |
| 2026-10-12 15:36 | Titulaire : solde SasPay crédité de **482 XAF** ; pile redémarrée sur la base conservée (sans tunnel) | état intact : `succeeded`, 1 période |
| 2026-10-12 15:36–15:37 | Revérification : 1 `refresh` + 3 concurrents ; relecture des trois routes SasPay | toujours 1 période ; `SUCCESS`, montants identiques (§ 7.1) |
| 2026-10-12 | Titulaire : **retrait reçu**, frais de **1,5 %** prélevés | montant exact du retrait non communiqué, non consigné (§ 7.2) |
| 2026-10-12 15:47 | Relecture des webhooks SasPay ; arrêt définitif de la pile ; suppression des ressources temporaires sensibles | clôture (§ 8) |

Une seule session de paiement a été créée et payée. **Coût total : 500 XAF débités** (18 XAF de frais, 482 XAF au solde marchand).

## 3. Frais et minimums (lus, `GET /pricing/my-rates/`)

Cameroun, `XAF`, tarif standard (`is_custom: false`) :

| Réseau | Encaissement | Retrait |
|---|---|---|
| `mtn_cm` (MTN MoMo) | 3,5 %, fixe 0, palier 0 – 100 000 000, **`ADD_ON`** | 1,5 %, `ADD_ON` |
| `orange_cm` (Orange Money) | 3,5 %, fixe 0, palier 0 – 100 000 000, **`ADD_ON`** | 1,5 %, `ADD_ON` |

- Aucun OTP préalable (`otp_required: false`) ; aucun plancher de frais
  (`floor_amount` nul ou négatif) ni plafond.
- **Minimum :** le palier camerounais commence à 0. D'autres pays affichent
  200 ; le site public annonce 200 FCFA. 500 XAF respecte les deux.
- **Coût estimé pour 500 XAF :**

  | Mode | Débit du payeur | Net marchand | Retrait (1,5 % en sus) |
  |---|---|---|---|
  | `ADD_ON` (réglage actuel) | **517,50 XAF** | 500 XAF | ≈ 7,40 XAF pour retirer ≈ 492 XAF |
  | `DEDUCTED` | **500 XAF** | 482,50 XAF | ≈ 7,10 XAF pour retirer ≈ 475 XAF |

  Débit maximal : 517,50 XAF, sous le budget de 1 000 XAF. Les frais propres
  à l'opérateur Mobile Money lors du retrait, un éventuel minimum de retrait
  et le délai de mise à disposition **ne sont pas publiés** : la
  récupération des fonds n'est pas garantie.

**Écart documentation/API.** La documentation de `my-rates` montre des
montants en chaînes (`"0.00"`, `"2.500"`) ; la réponse réelle renvoie des
**nombres JSON** (`0`, `3.5`, `100000000`) et `floor_amount: -0.01` sur
`mtn_cm`. Cette route sert seulement à lire les frais, jamais à
l'adaptateur.

### Écart initial pour l'attribution : mode de frais `ADD_ON` (résolu au § 3 bis)

Le compte est réglé en `ADD_ON` : les frais s'ajoutent au débit du payeur.
L'adaptateur 1-21B impose la règle D8 (frais absorbés) : `requested_amount`
**et** `debited_amount` doivent égaler le prix, au franc près, sans
centimes (`parseSasPayAmount`). En `ADD_ON`, `debited_amount` vaudrait
`"517.50"` : montant non concordant → **`review`**, aucune attribution.

Le `fee_charge_mode` de la requête est ignoré sans l'option de compte
`ALLOW_CLIENT_OVERRIDE`, et l'adaptateur ne l'envoie pas. Le contrôle ne
sera **pas** assoupli.

Deux suites possibles (décision du titulaire) :

1. Régler le compte en **`DEDUCTED`** (frais absorbés) dans le tableau de
   bord, si SasPay le permet : le parcours complet, jusqu'à l'attribution,
   devient vérifiable.
2. Garder `ADD_ON` : la recette prouve la création, le webhook, le
   rattachement et le **refus d'attribution** sur débit différent, mais pas
   l'attribution elle-même.

## 3 bis. Adaptation aux frais `ADD_ON`

### Contrat vérifié (documentation, consultée le 2026-10-12)

- **`GET /payments/{id}/verify/`** (exemple OpenAPI, sans schéma formel) :
  `requested_amount "2500.00"`, `fee_charge_mode "ADD_ON"`,
  `client_fee "37.50"`, `gateway_fee "20.00"`, `platform_fee "17.50"`,
  `debited_amount "2537.50"`, `net_amount "2500.00"`. Les montants sont des
  chaînes décimales à deux décimales.
- **Page Webhooks, « Comprendre les montants »** (champs `amount`, `fee`,
  `charged`, `net_amount`) :

  | Mode | Le payeur débourse | Le marchand reçoit |
  |---|---|---|
  | `ADD_ON` | `charged` = `amount` + `fee` | `net_amount` = `amount` |
  | `DEDUCTED` | `charged` = `amount` | `net_amount` = `amount` − `fee` |

  Transposé à `verify` (mêmes rôles sous d'autres noms, cohérent avec
  l'exemple) : en `ADD_ON`, `debited_amount` = `requested_amount` +
  `client_fee`.
- **Page Transactions.** La facture PDF ne garde que `requested_amount`,
  `client_fee` et `debited_amount` : ce sont les trois montants destinés au
  payeur.
- **Non documentés** (aucun n'est utilisé) :
  - la règle d'**arrondi** des frais ;
  - la valeur de `client_fee` en `DEDUCTED` (frais total ou 0) ;
  - la relation `gateway_fee` + `platform_fee` = `client_fee`, vraie dans
    l'exemple mais non énoncée.

### Règle appliquée (`sasPayDebitMatchesPrice`, dans l'adaptateur seul)

Les montants sont convertis en **centimes entiers** par `parseSasPayCents` :
chaîne décimale, deux décimales au plus, sans signe ni exposant ; un nombre
JSON est refusé. Aucun calcul flottant, aucun taux de frais codé.

| Mode confirmé par `verify` | Concordant si |
|---|---|
| tous | `requested_amount` = prix enregistré (XAF entiers) |
| `ADD_ON` | `client_fee` lisible, `debited_amount` = `requested_amount` + `client_fee` **exactement**, `net_amount` (s'il est présent) = `requested_amount` |
| `DEDUCTED` | `debited_amount` = `requested_amount`, `net_amount` (s'il est présent) ≤ `requested_amount` |
| absent | `debited_amount` = `requested_amount` (règle 1-21B) |
| autre valeur, `""`, champ illisible | non concordant → `review` |

Contrôles inchangés :
- session enregistrée et sa `metadata` ;
- transaction désignée par la session, puis relue ;
- `INBOUND` / `PAIEMENT` ;
- devise ;
- statut `SUCCESS` relu ;
- index unique de transaction ;
- attribution transactionnelle unique.

Le moteur commun reçoit toujours le seul prix vérifié (ou `null`) : il reste
indépendant du prestataire. Le webhook n'est jamais une preuve. Il n'existe
aucun contrôle « débit ≥ prix ».

**Limite.** La concordance prouve que le débit égale le prix **plus les
frais déclarés par SasPay**. Le montant des frais n'est pas comparé à un
barème : il faudrait coder un taux, ou dépendre de `my-rates`, dont le
format réel diffère de sa documentation.

### Interface (FR/EN) — retirée ensuite (§ 6 bis)

Première version, retirée quand les frais ont été absorbés. En page hébergée :
- le formulaire précise que les frais SasPay s'ajoutent au prix et que le
  total est affiché sur la page SasPay avant validation ;
- le bouton devient « Payer 500 FCFA + frais » / « Pay … + fees » ;
- le montant du paiement est libellé « Prix (hors frais de paiement) » ;
- la même mention accompagne « Continuer vers le paiement ».

Ce texte suppose `ADD_ON`, seul mode disponible sur le compte. Il faudra le
revoir si `DEDUCTED` devient disponible.

### Fichiers modifiés

- `api/src/subscriptions/payments/saspay/saspay-payment-provider.ts` :
  ajout de `parseSasPayCents` et `sasPayDebitMatchesPrice`, qui remplacent
  le contrôle « débit = prix ».
- `api/src/subscriptions/payments/saspay/saspay.spec.ts` : 5 tests :
  - centimes et arrondis d'écriture ;
  - `ADD_ON` valide ;
  - `DEDUCTED` valide et mode absent ;
  - mauvais prix ;
  - frais ou débit incohérents.
- `api/test/e2e/fake-saspay.ts` : mode de frais et `client_fee` pilotables
  (défaut inchangé : `DEDUCTED`).
- `api/test/saspay-checkout.e2e-spec.ts`, test 7b (`ADD_ON` avec frais à
  centimes) :
  - succès → une période ;
  - confirmations répétées (`refresh`, webhook, moteur) → toujours une
    période ;
  - débit incohérent → `review`, aucune période.
- Web : mention des frais ajoutée, puis retirée (§ 6 bis). Aucun fichier web modifié au final.

### Vérifications

| Contrôle | Résultat |
|---|---|
| Unitaires `src/subscriptions/payments` | **246 / 246** |
| E2E `saspay-checkout` (dont 7b) + `saspay-confirmation-only` | **23 / 23** |
| API : build de production, ESLint des fichiers touchés | OK (0 erreur ; 12 avertissements antérieurs dans `saspay-checkout.e2e-spec.ts`, lignes 219 à 381, hors code ajouté) |
| Web : `tsc`, ESLint, `check-i18n` (0 problème), `i18n:coverage` (0 texte en dur) | OK |
| `dist` recompilé (utilisé par la pile de recette) | OK |

`tsc --noEmit` sur le `tsconfig.json` complet signale des erreurs de typage
**préexistantes**, dans des fichiers de test non modifiés. Le build de
production n'est pas concerné.

**Incident Git (corrigé).**
- Pendant la vérification ESLint, un `git stash` a été lancé par erreur.
- Il a été annulé aussitôt par `git stash pop` du stash ainsi créé. Les
  7 fichiers modifiés sont restaurés.
- `stash@{0}` (lint-staged, `564a998`) est intact et à sa place. Le rapport,
  non suivi par Git, n'a pas été touché.
- Les tests ont été relancés après la restauration.

## 4. Pile de recette isolée

Scripts et données **hors dépôt** (répertoire temporaire de session) :

- **MongoDB** éphémère `MongoMemoryReplSet`, 127.0.0.1:27931, base
  `stockmaster_recipe` (garde `assertRecipeUri`), données persistées
  jusqu'à la clôture. Migrations explicites, puis comptes fictifs de la
  recette 1-14D.2H. Propriétaire et organisation renommés « Recette
  StockMaster 1-21C » / « Recette 1-21C » (identifiables chez SasPay).
- **API** compilée (`dist`, recompilé avec le § 3 bis), 127.0.0.1:4210,
  `NODE_ENV=production`. **Câblage de production**
  (`payment-providers.wiring`) : vrai adaptateur et vrai transport, avec
  `PAYMENT_PROVIDER_ACTIVE=saspay`, `SASPAY_ENVIRONMENT=live`, et une clé et
  un secret de webhook lus dans `api/.env.local`, transmis par
  l'environnement. Garde anti-`.env` de la recette active.
- **Seuls remplacements**, dans ce processus :
  - e-mails écrits dans un fichier local ;
  - tarif de recette injecté au chargement du module
    `subscription-pricing` : mensuel = 500 XAF, autres durées refusées,
    `pricingVersion = 9121` (marque recette).

  Aucun paramètre HTTP ne fixe le prix (seule la durée est reçue). Le code
  et le tarif de production sont inchangés.
- **Relais webhook** 127.0.0.1:4211 :
  - transmet **uniquement** `POST /payments/webhooks/saspay` (sans
    requête), 64 Kio au plus, octets inchangés, en-têtes `X-Webhook-*` ;
  - tout le reste reçoit 404 ;
  - preuve locale par livraison : présence et longueur de la signature
    (jamais sa valeur), empreinte du corps, champs utiles sans numéro ni
    e-mail.
- **Tunnel** `cloudflared` 2026.10.0, binaire officiel GitHub, SHA-256
  vérifié, hors dépôt. Tunnel rapide (`trycloudflare.com`) vers le relais
  seul.

**Contrôles effectués, sans appel SasPay :**

| Contrôle | Résultat |
|---|---|
| Démarrage avec clé LIVE + `live` | accepté |
| `GET …/payments/capabilities` (propriétaire) | `hosted-checkout` |
| Public `GET /`, `/auth/me`, `POST /auth/login`, `/organizations/…/capabilities`, `GET /payments/webhooks/saspay` | **404** |
| Public `POST /payments/webhooks/saspay` (secret absent) | 503 `PAYMENT_WEBHOOK_DISABLED` |
| Base de recette | aucun paiement ; une période d'essai |
| Journaux | aucune occurrence de clé |

## 5. Configuration demandée au titulaire

Tableau de bord SasPay → Webhooks, nouveau point de réception :

- URL : `https://later-cuts-run-goes.trycloudflare.com/payments/webhooks/saspay`
  (tunnel temporaire, valable tant que la recette tourne) ;
- événements : `transaction.success`, `transaction.failed`,
  `transaction.cancelled` ;
- secret de signature copié dans `api/.env.local`
  (`SASPAY_WEBHOOK_SECRET=`), jamais dans la conversation.

Le secret est présent dans `api/.env.local` (valeur jamais lue dans la
conversation). Après la confirmation du titulaire, l'API de recette est
redémarrée pour charger ce secret et le nouvel adaptateur ; une seule
session est créée ensuite.

## 6. Risques connus avant la création

- **URL de retour.** Elle vaut `http://127.0.0.1:3200/app/organization/subscription?payment=<id>`
  (origine de recette, aucun web exposé). Si SasPay la refuse (400/422), la
  tentative passe en `failed` **sans session** ; la recette s'arrête et
  aucune seconde création n'est faite sans accord.
- **Réponse perdue ou ambiguë.** La tentative reste `uncertain`. Elle est
  recherchée par `metadata` (liste des sessions, 5 pages au plus), jamais
  recréée. La `clientOperationId` est figée sur disque avant l'appel ; un
  rejeu renvoie la même tentative.

## 6 bis. Écart démontré : hôte de la page de paiement

| | Valeur |
|---|---|
| Documenté (1-21A/B) | `https://pay.saspay.me/checkout/…` |
| Réponse LIVE réelle | `https://checkout.saspay.me/<slug>` |

L'adaptateur n'acceptait que l'hôte documenté. La création a donc été
classée **incertaine**, comme prévu : session créée, page refusée. Aucune
seconde session n'a été créée.

**Correction :** `checkout.saspay.me` est ajouté à `SASPAY_CHECKOUT_ORIGINS`
(HTTPS seulement, origine exacte, sans identifiants). `pay.saspay.me` reste
admis, puisqu'il est documenté.

**Non-régression :** `saspay.spec.ts` rejoue la réponse réelle anonymisée
(enveloppe et champs observés ; identifiants, slug, e-mail et nom
remplacés). Elle vérifie que la page est acceptée, et que
`checkout.saspay.me.evil.example` et `http://` sont refusés.

**Reprise sans seconde création :**
1. API redémarrée avec `dist` recompilé.
2. `refresh` du paiement incertain : recherche par `metadata` (une seule
   correspondance), puis vérification complète (session, référence,
   montant, devise).
3. Session adoptée, page réaffichée.

**Autres constats de la réponse réelle :**
- enveloppe `{ success, data, code }` sur la création et la liste ;
- `metadata` présente dans la liste des sessions, liste paginée avec
  `count` et `next` ;
- `fee_charge_mode: ""` sur la session : mode non fixé à la création ;
- URL de retour `http://127.0.0.1…` acceptée ;
- `expires_at` respecté (+30 min) ;
- la description contient la référence `SM…`.

**Mode de frais.** Le titulaire a choisi « Déduits » pour les encaissements
après la création. `my-rates` affiche toujours `ADD_ON`. La session a été
créée avant ce réglage, sans mode fixé : le débit réel (500 ou 517,50 XAF)
est à lire sur la page SasPay avant validation. L'adaptateur vérifie
exactement les deux cas (§ 3 bis).

**Affichage web.** La mention « + frais » / « hors frais de paiement »
(§ 3 bis) est **retirée** à la demande du titulaire, puisque les frais sont
désormais absorbés. Les fichiers web sont revenus à leur état de
`1ce9778`.

**Vérifications après correction :**

| Contrôle | Résultat |
|---|---|
| Unitaires `src/subscriptions/payments` | **247 / 247** |
| E2E `saspay-checkout` + `saspay-confirmation-only` | **23 / 23** |
| ESLint `src/subscriptions/payments/saspay` | 0 erreur |

## 7. Résultats

| Contrôle | Résultat |
|---|---|
| Création : montant serveur, XAF, CM, référence `SM…` en `metadata` | **observé** (500.00 XAF) |
| Une seule session malgré la réponse inexploitable, et après rejeu | **observé** (1 session) |
| Vérification serveur avant paiement (équivalent du retour navigateur) | **observé** : `pending`, 0 période |
| Livraison `transaction.created` (1re) | **observé** : signée, acceptée (aucun 401), puis **503** `PAYMENT_WEBHOOK_RETRY_LATER` ; cause transitoire non identifiée (transaction créée 0,8 s plus tôt) |
| Renvoi automatique SasPay (+32 s) | **observé** : **200** (calendrier documenté « immédiat, 30 s… » confirmé) |
| Livraison `transaction.success` | **observé** : signée, **200**, traitée |
| Confirmation serveur (session, `status`, `verify`) | **observé** : `succeeded` à 15:33:15 UTC, transaction rattachée |
| Attribution | **observé** : **une** période `payment`, mensuelle, à l'organisation de recette, enchaînée après l'essai (19 oct. → 19 nov.) |
| Absence de double attribution | **observé** : 1 `refresh`, 4 `refresh` concurrents et un rejeu de la création (`replayed: true`) laissent **1** période |
| Une seule session chez SasPay | **observé** : `count 1`, `PAID` |

### Montants réels (`verify`, transaction `SUCCESS`)

| Champ | Valeur |
|---|---|
| `requested_amount` | `500.00` |
| `fee_charge_mode` | **`DEDUCTED`** |
| `client_fee` | `18.00` (`gateway_fee 10.00` + `platform_fee 8.00`) |
| `debited_amount` | **`500.00`** |
| `net_amount` | `482.00` |
| `currency` | `XAF` |
| réseau | `orange_cm` |

L'adaptateur a validé ce cas avec la règle `DEDUCTED`. Débit égal au prix
(500 = 500), net inférieur au prix. Aucun contrôle n'a été assoupli.

### Coût

| Poste | Montant |
|---|---|
| Débité au payeur | **500 XAF** |
| Frais SasPay retenus | 18 XAF |
| Net au solde marchand | 482 XAF |
| Retrait (réalisé par le titulaire) | 1,5 % annoncé (≈ 7 XAF), frais opérateur inconnus |

**Total engagé : 500 XAF**, dans le budget de 1 000 XAF. La perte nette est
de 18 XAF de frais, plus les frais du retrait éventuel. Une seule opération
payante a eu lieu.

### Écarts entre documentation, hypothèses et réalité

| # | Sujet | Documentation / hypothèse | Observé | Suite |
|---|---|---|---|---|
| 1 | Hôte de la page | `pay.saspay.me` | `checkout.saspay.me` | **corrigé** (§ 6 bis) + test de non-régression |
| 2 | Frais | 3,5 % → 17,50 XAF supposé | **18,00 XAF** | arrondi ou barème non documenté ; sans incidence, car l'adaptateur ne calcule aucun frais |
| 3 | `my-rates` et mode du compte | `fee_charge_mode` = mode appliqué | `my-rates` affiche `ADD_ON` alors que la transaction est `DEDUCTED` (réglage « Déduits ») | `my-rates` ne reflète pas le réglage du compte ; seul `verify` fait foi |
| 4 | `my-rates`, types | chaînes décimales | nombres JSON | lecture humaine seulement |
| 5 | Webhook `transaction.created` | `fee` = frais facturés | `fee 0.00`, `fee_charge_mode ADD_ON`, contredit par `verify` | confirme la règle : la notification **n'est pas une preuve** |
| 6 | Webhook, champs | sans `metadata` | `metadata` présente ; en-tête d'événement égal au corps | non utilisé |
| 7 | `verify`, champs | liste documentée | en plus : `amounts{…}`, `checkout_session`, `metadata`, `country_code`, `network_code`, `operation_msisdn` (donnée personnelle) | non utilisés ; masqués dans les preuves |
| 8 | Session | `fee_charge_mode` reflète le mode | `""` sur la session, même payée | mode lu uniquement sur la transaction |
| 9 | Retour navigateur | — | URL `http://127.0.0.1…` acceptée par SasPay | aucune preuve tirée du retour |
| 10 | Webhooks | — | User-Agent `python-requests`, signature hexadécimale de 64 caractères, horodatage en secondes | conforme à l'implémentation |

### Non exercé en LIVE (couvert seulement par les simulations 1-21B)

- tentative échouée puis réussie sur la même session ;
- expiration de la session et succès tardif ;
- renvoi **manuel** d'un webhook depuis le tableau de bord ;
- réponse perdue au sens strict. La réponse **inexploitable** (hôte refusé)
  a, elle, été exercée réellement : recherche par `metadata` et adoption,
  sans seconde session.
- organisation à l'abonnement expiré (session limitée `/access`).

### 7.1 Revérification et rapprochement (15:36–15:37 UTC)

**Webhooks réels** (relais, 3 livraisons SasPay, User-Agent
`python-requests/2.31.0`) :

| Reçu (UTC) | Événement | Réponse | Signature | Écart d'horodatage |
|---|---|---|---|---|
| 15:32:34 | `transaction.created` | 503 (reprise) | présente, hexadécimale, 64 caractères, **acceptée** | 1 s |
| 15:33:06 | `transaction.created` (renvoi) | 200 | acceptée | 1 s |
| 15:33:13 | `transaction.success` | 200 | acceptée | 1 s |

Une signature est **acceptée** quand l'API ne répond pas 401
(`PAYMENT_WEBHOOK_UNAUTHORIZED`). Le contrôle HMAC sur les octets reçus et
la fenêtre de ±300 s passent avant tout traitement : même la réponse 503
vient d'une notification authentifiée. La valeur de la signature n'est
jamais conservée.

**Relecture SasPay** (session, `status`, `verify`, même transaction
`e67e76ad…`) :

| Champ | Valeur |
|---|---|
| Session | `PAID`, `paid_at` 15:33:13 UTC, `metadata.merchantReference` = `SM6ACCF96DD2FFBE2803BBC36F` |
| Route `status` | `transaction_id` identique, `transaction_status: SUCCESS` |
| `verify` | `SUCCESS`, `INBOUND`, `PAIEMENT`, `orange_cm`, `checkout_session` = notre session |
| Montants | `requested_amount 500.00`, `debited_amount 500.00`, `client_fee 18.00` (`gateway_fee 10.00` + `platform_fee 8.00`), `net_amount 482.00`, `XAF` |
| Mode de frais | **`DEDUCTED`** (même valeur dans `amounts.fee_charge_mode`) |

**Rapprochement :**

| Source | Payeur débité | Net marchand |
|---|---|---|
| SasPay `verify` | 500,00 XAF | 482,00 XAF |
| Webhook `transaction.success` | 500,00 (`charged`) | 482,00 |
| Titulaire (relevé, solde SasPay) | 500 XAF | **482 XAF** |
| Stock Master (paiement local) | montant 500 XAF, `succeeded` | — |

Les quatre sources concordent.

**Attribution après revérification :**
- paiement `succeeded`, `confirmedAt` inchangé (15:33:15) ;
- transaction rattachée `e67e76ad…` ;
- **1** période `payment` (19 oct. → 19 nov.) pour l'organisation de
  recette ;
- aucune nouvelle période après 4 vérifications supplémentaires, dont 3
  concurrentes.

**Écart supplémentaire :** `verify` renvoie `updated_at` 15:32:33, la date
de création de la transaction, alors que son statut est passé à `SUCCESS`
ensuite. Ce champ ne date donc pas le succès ; il n'est pas utilisé.

### 7.2 Retrait (déclaration du titulaire)

Le titulaire a réalisé lui-même le retrait du solde marchand et confirme :
- la **réception** des fonds ;
- un prélèvement de frais de **1,5 %**, conforme au tarif de retrait lu
  dans `my-rates` (§ 3).

Le montant exact retiré et reçu n'a pas été communiqué. Il n'est **pas**
consigné ici, ni recalculé. Le retrait n'a été ni initié ni observé par la
recette (aucun appel `payouts`).

**Bilan de coût :**
- débit du payeur : 500 XAF ;
- frais d'encaissement : 18 XAF ;
- frais de retrait : 1,5 % du montant retiré, déclaré par le titulaire ;
- frais éventuels de l'opérateur à la réception : non communiqués.

Le budget de 1 000 XAF est respecté.

## 8. Clôture

| Élément | État |
|---|---|
| Pile de recette (API, relais, MongoDB) | **arrêtée** définitivement (15:47 UTC) ; aucun processus ni port de recette (4210, 4211, 4219, 27931) restant |
| Tunnel `cloudflared` | arrêté depuis 15:34 UTC ; l'URL publique répond 530 |
| Binaire `cloudflared` | **supprimé** (il n'avait jamais été installé dans le système) |
| Lien de paiement en clair | **supprimé** (session payée, lien inutilisable) |
| Webhooks SasPay | **restent configurés** : voir le tableau ci-dessous |
| Clé LIVE et secret webhook | toujours dans `api/.env.local` (ignoré par Git) ; jamais affichés ni journalisés. Clé et secret de **recette** : à ne pas réutiliser en production (1-21D) |

**Webhooks temporaires à supprimer par le titulaire** (relus le 2026-10-12 à
15:47 UTC ; la suppression n'est possible que depuis le tableau de bord) :

| Point de réception | Environnement | URL | État | Abonnements |
|---|---|---|---|---|
| `92650337-e4e0-420e-b45c-a9be82591b08` | LIVE | `https://later-cuts-run-goes.trycloudflare.com/payments/webhooks/saspay` (tunnel fermé) | **actif** : les livraisons futures échoueront | `transaction.created`, `.success`, `.failed`, `.cancelled` |
| `e14e9bb4…` (absent de la liste des points) | — | — | abonnements **orphelins** | les quatre mêmes événements |

Aucun webhook de production n'existe encore.

**Preuves conservées, hors dépôt** (répertoire temporaire de la session
Claude Code, `scratchpad/live121c/`) :
- `evidence/webhooks.jsonl` : livraisons reçues ; ni signature ni numéro ;
- `evidence/probe-1..3.txt` : relectures SasPay, données personnelles
  masquées ;
- `evidence/final-report*.json` : état de la base de recette à chaque
  étape ;
- `evidence/operation.json` : `clientOperationId` et identifiant du
  paiement local ;
- `evidence/drive.jsonl` : journal des appels de la recette, liens masqués ;
- `mongo-data/` : base de recette (comptes fictifs).

Un contrôle automatique n'a trouvé dans ces fichiers ni clé, ni secret, ni
numéro, ni lien de paiement. Ce répertoire est **temporaire** : les
références nécessaires au rapprochement figurent ci-dessous, dans ce
rapport.

**Références conservées pour le rapprochement :**

| Référence | Valeur |
|---|---|
| Référence marchand | `SM6ACCF96DD2FFBE2803BBC36F` |
| Session SasPay | `841bd7f7-1f74-4c35-91dc-c582e16ed7f2` |
| Transaction SasPay | `e67e76ad-e5c9-4030-a7ae-0e4fa10dd4ea` |
| Référence de transaction | `5e80f501fc314b48a46d1ec4c189a324` |
| Payée le | 2026-10-12 15:33:13 UTC |

**Incident de confidentialité (corrigé).** Une lecture de `verify` a
renvoyé le champ non documenté `operation_msisdn`. Le script de preuve ne le
masquait pas encore : le numéro du payeur est apparu dans un fichier de
preuve local et dans la sortie de la commande. Il a été supprimé du
fichier, et le masquage corrigé. Il ne figure ni dans ce rapport ni dans
Git.

## 9. Décision proposée

1. **Code.** Garder les corrections démontrées par la recette :
   - hôte `checkout.saspay.me` ;
   - concordance `ADD_ON` et `DEDUCTED` exacte, en centimes.

   Après revue, les commiter dans un lot séparé. Elles ne sont **pas**
   commitées.
2. **Frais.** Garder le réglage « Déduits » (frais absorbés : le client paie
   exactement le prix affiché). Constaté : environ 3,6 % (18 XAF sur
   500 XAF). L'arrondi et le barème sont à faire confirmer par SasPay avant
   de fixer les marges.
3. **Avant toute activation publique** (décision distincte) :
   - supprimer le webhook de recette et créer le webhook de production, sur
     l'API de production, avec un secret distinct ;
   - faire confirmer par écrit à SasPay : la règle d'arrondi des frais, le
     sens de `my-rates.fee_charge_mode`, les frais et le minimum de retrait
     (à constater lors du retrait du titulaire), le contrat et le titulaire
     des fonds (1-21A, B6) ;
   - expliquer, si possible, le 503 de la première livraison : ajouter un
     journal de raison, sans données, sur l'échec de vérification du
     webhook. Un renvoi l'a absorbé, mais la cause n'est pas connue ;
   - publier les mentions de confidentialité (1-21B, § 12).
4. **Non requis avant activation :** une nouvelle opération payante. Les
   parcours non exercés relèvent des simulations ; une recette à 500 XAF
   d'une organisation expirée resterait possible si elle est souhaitée.
