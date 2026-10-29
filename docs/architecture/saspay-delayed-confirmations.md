# Retards de confirmation des paiements SasPay

Branche : `fix/saspay-delayed-confirmations`, créée depuis `origin/dev`
(`bb0914f`, identique à `HEAD` au départ, arbre propre, sans stash ni reset).
Rien n'est commité, poussé ni déployé. Aucun appel réel à SasPay, aucun
paiement, aucun ticket, aucun accès à la production.

## 1. Contexte

SasPay annonce que certains paiements réussis peuvent rester temporairement
« en attente ». Si le statut n'est toujours pas actualisé après 24 heures, il
faut ouvrir un ticket auprès de leur support avec la référence de transaction.

Ce message n'apporte **ni nouvel état d'API, ni délai d'expiration, ni
garantie de confirmation**. Le seuil de 24 h sert seulement à **informer** le
client et l'opérateur.

**Point de départ des 24 h** : la **création de la tentative Stock Master**
(`createdAt` du paiement), et **non un débit bancaire constaté**. Stock Master
ne connaît pas l'instant du débit, ni même s'il a eu lieu. Le débit, s'il
existe, est postérieur à cette création : le seuil peut donc être atteint
jusqu'à la durée de validité de la page (30 min demandées) avant que 24 h se
soient écoulées depuis le débit. Il ne change jamais l'état d'un paiement : rien ne
passe en `failed`, `review` ou `succeeded` sur un délai.

## 2. Règles existantes constatées (avant modification)

| Sujet | Règle (code) |
|---|---|
| États ouverts | `initiating`, `pending`, `uncertain` (`open: true`) ; un seul paiement ouvert par commerce (index unique) |
| `review` | traitement opérateur, déjà signalé à l'administration (`payment_review`) |
| Fermés | `succeeded` (période attribuée), `failed` (refus confirmé, ou page close sans transaction affirmée par SasPay : `checkout_closed`) |
| Délai | **aucun échec automatique sur délai** (`subscription-payments.service.ts`) |
| Transaction SasPay `PENDING` | paiement `pending`, `providerTransactionId` renseigné (rattaché par la vérification), page close ou non |
| Page hébergée | validité demandée : 30 min (`SASPAY_CHECKOUT_TTL_MS`) |
| Rapprochement périodique | toutes les 5 min (`PAYMENT_RECONCILIATION_SWEEP_SECONDS`), 10 paiements au plus, chacun non vérifié depuis 10 min. Paiements `pending` et `uncertain` : repris **sans limite de durée**. `failed / checkout_closed` : 72 h. **`initiating` n'est jamais repris** |
| Webhook | transaction déjà rattachée : toujours relue, **sans fenêtre de temps**. Transaction inconnue : seuls les candidats initiés depuis 24 h sont relus ; sinon accusé, et le rapprochement prend le relais |
| Attribution | transaction (`runInGrantTransaction`), écriture conditionnelle, index `autoGrantRenewalId`, push « paiement confirmé » enregistré dans la même transaction |
| Ancienne tentative confirmée tardivement | remplacée → `review / replaced_payment_collected` ; renouvellement déjà attribué → `review / renewal_already_granted` (aucune seconde période, signalé à l'opérateur) |
| Commerce suspendu | l'attribution n'écrit jamais `Organization` : la suspension reste prioritaire |
| Nouvelle tentative | bloquée tant qu'un paiement est ouvert ; « Changer de forfait » ne libère que si SasPay confirme qu'aucune transaction n'est engagée |

## 3. Défauts constatés et corrections

### 3.1 Message client trompeur (corrigé)

Une transaction SasPay restée `PENDING` après expiration de la page
s'affichait « Page de paiement expirée — nous attendons la confirmation de
clôture du prestataire ». Un client peut-être débité lisait donc un message
de clôture.

**Correction.** La vue du propriétaire expose
`confirmationPending: { since, delayed } | null`, calculé par le serveur
(`paymentAwaitingConfirmation`). Le champ est renseigné quand toutes ces
conditions sont réunies :

- paiement SasPay ouvert, `pending` ;
- transaction SasPay rattachée (le payeur a validé) ;
- page plus proposée ;
- ni encaissé, ni poursuite suspendue.

Il vaut `null` pour un paiement confirmé, clos ou à examiner. Une page encore
valide garde son parcours habituel : une transaction échouée y reste
rejouable, et son état n'est pas conservé.

Affichage (FR/EN) :

- **Toujours** : « Votre paiement est en cours de confirmation. Si vous avez
  déjà été débité, ne recommencez pas le paiement. » Puis : « SasPay peut
  mettre du temps à actualiser le statut d'un paiement. Stock Master le
  vérifie automatiquement ; vous pouvez aussi appuyer sur « Vérifier le
  paiement ». »
- **Après 24 h** depuis la création de la tentative (`delayed`, heure du
  serveur ; jamais depuis un débit, inconnu de Stock Master) : un bloc
  d'assistance.
  - Il explique que la vérification nécessite l'assistance.
  - Il affiche la référence existante (`SM…`), copiable.
  - Il propose les canaux existants : WhatsApp, e-mail d'assistance (sujet
    prérempli avec la référence), et la page Assistance hors session limitée.
  - Il ne promet ni activation ni remboursement : « L'abonnement n'est
    prolongé qu'une fois le paiement confirmé par SasPay ».
- Rien n'affirme que le client a été débité.

`delayed` est calculé à chaque réponse : une page laissée ouverte passe au
bloc d'assistance au prochain rechargement, à la prochaine vérification ou au
prochain signal temps réel.

### 3.2 Alerte administrateur après 24 h (ajoutée)

Nouveau type `payment_confirmation_delayed`, catégorie `payments` (capacité
`platform.read`, comme les autres paiements). Titre : « Paiement en attente de
confirmation depuis plus de 24 heures ».

- **Paiements concernés** (`paymentConfirmationDelayed`) :
  - SasPay, `open: true`, statut `initiating`, `pending` ou `uncertain` ;
  - ni encaissé, ni remboursé, sans période ;
  - exclus : `review` (déjà signalé), `succeeded`, `failed`, et une page
    encore valide sans transaction (le payeur n'a pas payé).
- **Date de départ : `createdAt` du paiement**, c'est-à-dire la création de
  la tentative Stock Master, jamais un débit bancaire constaté. Elle est écrite une fois à
  l'insertion (horodatage Mongoose, immuable), avant tout appel à SasPay, et
  n'est jamais modifiée par une vérification ou un rapprochement,
  contrairement à `updatedAt`. Un éventuel débit lui est postérieur, à un
  instant que Stock Master ne connaît pas : l'alerte peut donc précéder de la
  durée de validité de la page (30 min demandées) les 24 h écoulées depuis ce
  débit. La même date sert au message client.
- **Collecte sans curseur sur `updatedAt`.** À chaque passe (30 s), la
  collecte relit l'état des paiements SasPay ouverts dont
  `createdAt ≤ maintenant − 24 h`. Ceux dont la clé existe déjà sont écartés.
  Un paiement qui atteint 24 h sans aucune écriture est donc détecté (testé,
  `updatedAt` inchangé). Il y a au plus un paiement ouvert par commerce :
  la liste relue est bornée par le nombre de commerces (pages de 200, 10 par
  passe).
- **Unicité.** Clé `payment_confirmation_delayed:<paiement>`, upsert
  `$setOnInsert` sur index unique (mécanisme existant). Une seule alerte
  malgré les passes répétées, concurrentes, ou une nouvelle instance après
  redémarrage (testé).
- **Contenu** (liste blanche) :
  - commerce, montant, durée ;
  - référence Stock Master (`SM…`) ;
  - référence de transaction SasPay si elle est rattachée (non secrète, déjà
    sur le reçu du client) ;
  - date de départ.
  - Jamais l'URL de paiement ni l'identifiant de session.
  - La date de l'événement est l'instant du franchissement (`createdAt` +
    24 h).
- **Lien** : page existante `/admin/payments?organizationId=<id>`. Elle montre
  l'**état actuel** du paiement (badge de statut).
- **Après confirmation** : l'alerte est conservée telle quelle, et la
  notification habituelle `payment_confirmed` est produite une seule fois
  (testé).
- **Aucune transformation du paiement** pour produire l'alerte.

**Premier déploiement.** La source a son propre point d'activation
(`payments_confirmation_delayed_activation`, posé par la première passe de
cette version). Seuls les paiements dont le seuil est franchi **après** ce
point sont signalés. Un paiement déjà non résolu depuis plus de 24 h au
déploiement n'est pas signalé (testé). Il n'y a donc aucune notification
rétroactive en masse.

Pour les retrouver, l'opérateur filtre `/admin/payments` par statut « En
attente » et « Résultat à vérifier » (paiements anciens), puis applique la
démarche du § 5. Après une interruption de l'API, un paiement resté non résolu
est signalé à la reprise : la source relit l'état, sans limite de 7 jours.

### 3.3 Confirmations tardives : aucun défaut constaté

Vérifié dans le code puis testé, sans modification :

- Une confirmation SasPay authentique après 24 h est traitée sans fenêtre de
  temps par le webhook (transaction rattachée) et « Vérifier ». Le
  rapprochement périodique la retrouve aussi pour un paiement `pending` ou
  `uncertain`, mais **pas pour un paiement resté `initiating`** (§ 7, point 3).
- Les contrôles restent ceux du moteur unique : signature du webhook, statut
  relu chez SasPay, concordance référence / montant / devise, commerce du
  paiement.
- Webhook répété, rapprochement et vérification simultanés donnent une seule
  période et une seule notification de confirmation (testé).
- Placement des périodes : règles existantes (`computeRenewalStartsAt`), sans
  chevauchement.
- Commerce suspendu : la période est enregistrée et la suspension conservée
  (testé).
- Ancienne tentative confirmée après un autre paiement : la règle existante
  s'applique (`review`, encaissement conservé, aucune seconde période,
  notification `payment_review`, résolution par le CLI). Rien n'est ignoré
  silencieusement ni attribué deux fois. Cas non modifié, déjà couvert par
  `saspay-checkout` (E12, R3).

**Limites du rapprochement.** Pour un paiement `pending` ou `uncertain`, les
interrogations automatiques ne s'arrêtent pas trop tôt : elles continuent
toutes les 10 min au plus, **sans limite de durée** (§ 7, décision). Un
paiement `initiating` n'est **jamais** relu automatiquement : seuls
« Vérifier » et le CLI peuvent le faire évoluer. La récupération automatique
n'est donc **pas garantie pour tous les paiements ouverts**. Les tentatives
`checkout_closed` cessent d'être relues après 72 h. SasPay avait alors
affirmé l'absence de transaction : ce n'est pas le cas « payé mais en
attente ».

**Arrêt des interrogations ≠ fin des confirmations.** Un webhook tardif reste
accepté :

- toujours pour une transaction déjà rattachée ;
- pour une transaction inconnue, seulement si le paiement a été initié depuis
  moins de 24 h. Au-delà, l'accusé ne rattache rien. Un paiement `pending`
  ou `uncertain` peut alors être retrouvé par le rapprochement (sa
  transaction PENDING a normalement déjà été rattachée par une vérification
  antérieure) ; un paiement `initiating` ne l'est pas.

Jamais de validation sur un délai écoulé, une capture d'écran ou une
déclaration du client. Aucun bouton de validation forcée.

## 4. États et délais réellement utilisés

| Élément | Valeur | Source |
|---|---|---|
| Seuil d'information | 24 h depuis la création de la tentative (`createdAt`), pas depuis un débit | `PAYMENT_CONFIRMATION_DELAY_MS` (`payment-confirmation-delay.ts`) |
| Collecte de l'administration | 30 s | `NOTIFICATION_SWEEP_INTERVAL_MS` |
| Rapprochement des paiements | 5 min, 10 par passe, 10 min entre deux relectures ; `checkout_closed` 72 h | `payment-reconciliation-sweep.ts` |
| Candidats du webhook | 24 h, 3 au plus | `SASPAY_WEBHOOK_CANDIDATE_WINDOW_MS` |
| Page hébergée | 30 min demandées | `SASPAY_CHECKOUT_TTL_MS` |

## 5. Démarche opérateur (notification reçue)

1. Ouvrir la notification : la page des paiements du commerce montre l'état
   actuel. S'il est `succeeded`, rien à faire.
2. Vérifier le statut sur l'hôte d'exploitation (lecture, puis simulation) :

   ```sh
   pnpm --filter api subscription:reconcile-payment -- inspect --payment-id=<id>
   pnpm --filter api subscription:reconcile-payment -- reconcile --payment-id=<id>
   ```

3. Toujours non confirmé : ouvrir un ticket auprès de l'assistance SasPay avec
   la **référence de transaction** de la notification (à défaut, la référence
   Stock Master `SM…`, présente dans le libellé de la session), le montant et
   la date.
4. Quand SasPay actualise le statut : le webhook, le rapprochement ou
   « Vérifier » attribuent la période une seule fois. Aucune action manuelle
   d'attribution. Pour une réponse écrite de SasPay sans actualisation, suivre
   les procédures du CLI de rapprochement (1-14D.2G, 1-22D.3).

## 6. Déploiement

- **Index, migrations, variables** : aucun. La collecte utilise les index
  existants : `status_1_updatedAt_1` pour le préfixe de statut, sur au plus un
  paiement ouvert par commerce, et `eventKey_1_unique` pour les
  notifications. `migrate:predeploy` est inchangé.
- **Ordre** : API puis web, comme d'habitude.
  - Ancien web avec nouvelle API : le champ `confirmationPending` est ignoré.
    L'alerte s'affiche sans texte dédié : titre de type inconnu, à éviter, d'où
    l'ordre API puis web rapproché.
  - Nouveau web avec ancienne API : le champ est absent, et le comportement
    reste l'actuel.
- **Retour arrière** : retirer l'API suffit. Les alertes enregistrées restent
  et le point d'activation est conservé.

## 7. Décisions restantes

1. **Nouvelle tentative bloquée.** Un paiement dont la transaction reste
   `PENDING` chez SasPay bloque toute nouvelle tentative jusqu'à sa
   résolution : « Changer de forfait » renvoie « en cours ». C'est la règle
   existante, voulue contre le double débit, et elle n'a pas de fin
   automatique. Faut-il une issue opérateur documentée, par exemple une
   clôture CLI sur réponse écrite de SasPay comme `--close-without-session` ?
2. **Interrogations sans limite.** Un paiement `pending` ou `uncertain` est relu toutes les
   10 min sans limite de durée (3 appels SasPay par relecture). Proposition à
   valider, non implémentée : espacement borné adapté à `sweepOnce`, par
   exemple toutes les 10 min jusqu'à 24 h, puis toutes les heures jusqu'à
   7 jours, puis une fois par jour jusqu'à 30 jours, puis arrêt. Les webhooks
   tardifs, « Vérifier » et le CLI restent disponibles. Aucune limite SasPay
   n'est supposée.
3. **`initiating` bloqué.** Un paiement resté `initiating` (arrêt du processus
   entre l'insertion et la réponse de SasPay) n'est repris par aucun mécanisme
   automatique. Le rapprochement ne lit que `pending` et `uncertain`.
   L'alerte de 24 h le signale désormais. Une reprise automatique reste à
   décider.
4. **Webhook d'une transaction inconnue après 24 h.** L'accusé ne rattache
   rien (fenêtre des candidats 1-21B). Pour un paiement `pending` ou
   `uncertain`, le rapprochement peut le retrouver ; pas pour un paiement
   `initiating` (point 3). À élargir seulement si SasPay confirme des
   transactions jamais visibles sur la session.

## 8. Contrôles réalisés (29 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `payment-confirmation-delay.spec.ts` (nouveau : seuil, états, page valide, message client) + unitaires `src/subscriptions`, `src/platform-admin`, `predeploy-migrations` | 23 suites, 549 tests OK |
| `test/saspay-delayed-confirmation.e2e-spec.ts` (nouveau, faux SasPay, horloge contrôlée) | 5 / 5 |
| E2E voisins : `platform-admin-notifications`, `saspay-checkout`, `payment-unresolved-reconciliation`, `saspay-confirmation-only`, `realtime-subscription-payments`, `payment-reconciliation` | 6 suites OK |
| `subscription-payments.e2e-spec.ts` | liste des champs de la vue complétée (`confirmationPending`). Attentes obsolètes corrigées : le propriétaire **actif** d'un commerce suspendu reçoit `ORGANIZATION_SUSPENDED` (règle du commit `18ef2ff`), et non plus `ORGANIZATION_ACCESS_DENIED`. Refus 403 et absence d'effet conservés : 48 / 48 |
| API : `nest build`, `tsc -p tsconfig.build.json`, ESLint des fichiers touchés | OK |
| Web : `tsc`, ESLint, `test:i18n` (2 447 clés FR, 0 problème), `i18n:coverage`, `next build` | OK |

**Cas e2e :**

1. Avant 24 h : message sans assistance, aucune alerte. Après 24 h **sans
   aucune écriture du paiement** : une seule alerte (contenu, date,
   références, ni URL ni session), statut inchangé, assistance affichée.
   Passes répétées, concurrentes, nouvelle instance, +5 jours : toujours une
   seule alerte.
2. Premier déploiement : paiement ouvert depuis 3 jours avant la première
   passe, jamais signalé.
3. Confirmé, clos sans transaction, à examiner : ni alerte, ni message.
4. Confirmation 26 h après : deux webhooks, rapprochement et « Vérifier »
   simultanés, puis un webhook répété. Résultat : `succeeded`, 1 période,
   1 `payment_confirmed`, alerte conservée à l'identique.
5. Commerce suspendu : confirmation tardive par webhook, 1 période,
   suspension conservée.

**Recette navigateur** : recette isolée (`start --provider=saspay
--platform-admin`), Playwright déjà présent dans le cache npx, Chromium local.

- **Parcours** : paiement réel du parcours web, puis transaction SasPay
  simulée `PENDING` et page expirée.
- **FR, 390 px, sombre** :
  - « Paiement en cours de confirmation », texte exact, mention du délai
    SasPay ;
  - message après vérification ; historique « Paiement en cours de
    confirmation » ;
  - aucune assistance avant 24 h.
- **Après antidatage de `createdAt` (24 h 30 s)** :
  - bloc d'assistance, référence copiée dans le presse-papiers ;
  - liens `wa.me`, `mailto:` avec sujet, page Assistance ;
  - aucun défilement horizontal.
- **EN, 1280 px, clair** : textes anglais complets.
- **Collecte de la recette** : alerte `payment_confirmation_delayed`, avec
  la référence de transaction ; paiement toujours `pending`.
- **Erreurs** : 0 erreur de page ou de console.

**Non vérifié** : affichage de l'alerte dans l'interface `/admin` en navigateur
(enrôlement MFA non rejoué ; textes et types contrôlés par `tsc`, i18n et
`next build`), vrais téléphones, comportement réel de SasPay, plusieurs
instances d'API.

## 9. Fichiers

| Fichier | Nature |
|---|---|
| `api/src/subscriptions/payments/payment-confirmation-delay.ts` (+ `.spec.ts`) | nouveau : seuil et règles pures |
| `api/src/subscriptions/payments/subscription-payments.service.ts` | vue : `confirmationPending` |
| `api/src/platform-admin/platform-admin-notifications.ts` | type, clé, paramètres en liste blanche |
| `api/src/platform-admin/platform-admin-notification-sweep.service.ts` | source F : retards SasPay |
| `api/test/saspay-delayed-confirmation.e2e-spec.ts` | nouveau |
| `api/test/subscription-payments.e2e-spec.ts` | liste des champs de la vue |
| `web/src/components/subscription/payment-confirmation-assistance.tsx` | nouveau : assistance après 24 h |
| `web/src/components/subscription/subscription-payment-panel.tsx`, `web/src/lib/subscription-payments.ts` | message client |
| `web/src/components/admin/admin-notifications.tsx`, `web/src/lib/admin/admin-api.ts` | rendu de l'alerte, démarche opérateur |
| `web/src/i18n/resources/{fr,en}/{subscription,admin}.ts` | textes |
