# Administration de la plateforme — notifications internes

Branche : `feature/platform-admin-notifications`, créée depuis `origin/dev`
(`40eddde`). Cette base contient déjà l'administration (MFA, actions),
les messages de service, l'archivage et les campagnes : aucune dépendance de
branche. L'arbre de travail était propre au départ, sans reset ni stash.
Aucun commit, push ou déploiement, aucun envoi externe, aucun accès à la
production.

**Lot.** Une cloche avec compteur dans la navigation de `/admin`, et une page
`/admin/notifications`. Elles informent les administrateurs des événements
importants de la plateforme.

**Distinct de :**

- le centre de notifications des commerces (`notifications`, destinataires =
  membres) ;
- les messages de service ;
- les campagnes.

Collections, destinataires et routes sont propres à ce lot. Pas de push,
d'e-mail ni de WhatsApp, et aucune nouvelle intégration externe.

## 1. Événements couverts

| Type | Déclencheur (état persistant) | Résumé affiché | Cible |
|---|---|---|---|
| `organization_created` | Document `organizations` créé (la transaction d'inscription l'a validé). | Nom du commerce, date | Fiche `/admin/organizations/<id>` |
| `payment_confirmed` | `subscription_payments` en `succeeded`, avec `periodId` et `confirmedAt` (écrits dans la transaction d'attribution). | Commerce, montant, devise, durée accordée (forfait) | `/admin/payments?organizationId=<id>` |
| `payment_review` | `subscription_payments` en `review`, sans `refundedAt`. | Commerce, montant, motif (code d'incident traduit), « intervention de l'opérateur requise » | Idem |
| `support_request` | Document `support_requests` enregistré par le formulaire. | Commerce, référence `AS-…`, catégorie ; « traitement dans la messagerie d'assistance » | Fiche du commerce |
| `campaign_audience_partial` | Campagne lancée, audience `ready` **et** `incomplete`. | Nombre de destinataires retenus, « à vérifier » | `/admin/campaigns/<id>` |
| `campaign_completed` | Audience gelée depuis 5 min **et** aucune livraison `pending` ni `sending`. | Acceptés par le prestataire (« pas une preuve de réception »), ignorés, échecs, incertains | Idem |

**Choix et limites par événement :**

- **Paiement nécessitant une intervention.** Seul `review` est retenu : le
  schéma le définit comme « traitement opérateur », sans issue automatique.
  Sont exclus :
  - `pending` : on attend le payeur ;
  - `uncertain` : le rapprochement périodique le reprend ;
  - `failed` : refus du payeur, ou page close sans débit ;
  - un remboursement déjà consigné.

  Aucune règle de paiement nouvelle. Une notification par paiement **et par
  code d'incident** : un même incident n'est signalé qu'une fois.

  Un `succeeded` marqué `late_failure_after_success` n'est pas signalé :
  aucun état fiable ne dit s'il reste à traiter (décision à prendre, § 8).
- **Prolongation offerte.** Elle crée une période, jamais un document
  `subscription_payments`. Elle n'est donc jamais présentée comme un
  paiement (testé).
- **Assistance.** L'administration n'a aucune consultation des demandes. Le
  registre `support_requests` ne garde ni sujet ni message (empreinte
  seulement) et se purge après 30 jours. La notification donne donc une
  information minimale (référence, catégorie, commerce) et précise que le
  traitement reste dans la messagerie d'assistance. Elle renvoie à la fiche
  du commerce (droits existants). Aucun module d'assistance n'est ajouté.

  Rien n'est annoncé pour WhatsApp : les liens `wa.me` ne font remonter
  aucune conversation dans Stock Master.
- **Campagnes.**
  - « Accepté par le prestataire » n'est jamais présenté comme « reçu ».
  - Rien n'est signalé pendant la constitution de l'audience.
  - Un interrupteur d'envoi coupé (`MARKETING_EMAILS_ENABLED=false`) laisse
    les livraisons `pending` : la campagne n'est jamais déclarée terminée.
  - **Délai de grâce de 5 min après le gel.** Il ne protège pas contre une
    insertion tardive : un délai ne prouve aucun ordre.
  - **La protection réelle est dans la constitution de l'audience** (rapport
    des campagnes, § 1.5.1). Chaque page est validée dans une transaction
    courte qui commence par une écriture conditionnelle sur le document
    campagne, celui qu'écrivent les clôtures. Une page en conflit avec une
    clôture est abandonnée entière : livraisons et curseur.
    - Après la clôture de l'audience, aucune livraison ne peut donc plus
      être ajoutée (testé, y compris pour une page suspendue qui reprend
      après la notification de fin).
    - Le délai de grâce n'est plus qu'une marge : il n'est conservé ni
      comme garantie, ni comme condition de sûreté.
  - **Compteurs de fin.** Ils sont définitifs une fois la fin constatée, et
    ce sous **deux conditions** :
    - aucune ancienne version de l'API n'est encore en service (procédure :
      rapport des campagnes, § 5.0) ;
    - les campagnes antérieures au correctif ont été vérifiées (procédure
      en lecture seule, même endroit).
    Une campagne dont des livraisons ont été insérées tardivement par
    l'ancienne version peut avoir plus de livraisons que son `total`.
  - En dehors de ce cas, les campagnes n'ont pas de relance manuelle :
    une fois finaux, les états ne bougent plus.

Titres et résumés sont composés **par le web**, à partir du type et de
paramètres contrôlés (liste blanche, `toNotificationView`), en FR et EN.
Le texte est rendu par React et échappé : aucun HTML libre.

## 2. Destinataires, droits et lecture

**Accès.** Toutes les routes passent par `PlatformAdminGuard` au niveau
`mfa` :

- secret du BFF requis ;
- session administrative complète (second facteur validé) ;
- compte, version de session, facteur et **accès actif** relus à chaque
  requête.

Sont refusés : un JWT de commerce, une session pre-MFA, une session expirée
ou un accès révoqué (testé).

**Capacités.** Correspondance explicite catégorie → capacité de
**consultation** (`CATEGORY_CAPABILITY`) :

| Catégorie | Capacité | Page cible déjà ouverte par |
|---|---|---|
| `organizations` | `platform.read` | fiche (`platform.read`) |
| `payments` | `platform.read` | paiements (`platform.read`) |
| `support` | `platform.read` | fiche (`platform.read`) |
| `campaigns` | `platform.read` | campagnes et résultats (`platform.read`) |

- Aucune capacité d'action n'est exigée (envoyer, suspendre, lancer) :
  une capacité d'action seule ne montre rien (testé).
- Le même filtre s'applique à la liste, au compteur et aux écritures. Il
  est relu à chaque requête : retirer `platform.read` vide aussitôt liste
  et compteur, et une lecture répond 404 (testé).
- Une notification n'accorde aucun droit : ses liens mènent à des pages
  qui appliquent leurs propres contrôles.

**Destinataire.** Toujours l'utilisateur de la session. Aucun identifiant
fourni par le navigateur n'est lu : un `userId` envoyé dans le corps est
ignoré (testé).

**Administrateur nouvellement autorisé.** Ses notifications commencent à
`grantedAt`, la date d'attribution de l'accès actif. L'historique antérieur
n'est ni affiché ni compté : il n'est pas présenté comme non lu.

- Après une révocation, une nouvelle attribution repart de sa propre date.
- Une capacité retirée puis rendue fait réapparaître les notifications
  depuis `grantedAt`, avec leur état de lecture.

**État de lecture.** Une ligne `platform_admin_notification_reads` par
administrateur et notification (unique `{userId, notificationId}`). Lire ou
tout marquer pour l'un ne change rien pour les autres (testé). Les écritures
sont idempotentes : un second « lu » renvoie la même date.

**« Tout marquer comme lu ».** La borne est fixée par le serveur : les
identifiants des notifications non lues **visibles au moment de la
lecture** sont relevés une fois, puis marqués.

- Une notification enregistrée ensuite reste non lue, même si sa date est
  antérieure (testé).
- Au plus 5 000 par demande ; au-delà, `remaining: true`.

## 3. Modèle

| Collection | Contenu | Index |
|---|---|---|
| `platform_admin_notifications` | `eventKey`, `type`, `category`, `occurredAt`, `createdAt`, `target {kind, id, organizationId}`, `params` (liste blanche) | `eventKey_1_unique` ; `category_1_createdAt_-1__id_-1` |
| `platform_admin_notification_reads` | `userId`, `notificationId`, `category` et `notificationCreatedAt` recopiés, `readAt` | `userId_1_notificationId_1_unique` ; `userId_1_category_1_notificationCreatedAt_-1` |
| `platform_admin_notification_cursors` | point d'activation et curseur de chaque source | `_id` |

**Paramètres stockés** : nom du commerce (≤ 120 caractères, déjà affiché
dans l'administration), montant, devise, forfait, code d'incident,
référence d'assistance, catégorie, compteurs.

**Jamais stockés** : sujet ou message d'une demande, contenu d'une campagne
ou d'un message, adresse e-mail, nom d'un client, URL de paiement, jeton,
secret.

**Compteur.** Le nombre de notifications visibles moins le nombre de
lectures, avec le même filtre (catégorie et date recopiées), donc sans
jointure. La liste « Non lues » est une agrégation `$lookup` sur l'index
unique des lectures.

**Cible disparue.** Le résumé minimal est conservé. L'existence de la cible
est vérifiée à la lecture : si elle a disparu, `available: false` et
l'interface affiche « Élément indisponible », sans lien ni erreur (testé).

## 4. Fiabilité

**Collecte durable** (`PlatformAdminNotificationSweep`). Elle tourne toutes
les 30 s, dans le processus HTTP uniquement, comme les autres traitements de
fond. Elle ne réagit à aucun signal en mémoire : chaque passe relit **l'état
persistant** des collections métier.

- **Transaction annulée.** Rien n'est visible, donc rien n'est produit
  (testé avec une transaction réelle annulée).
- **Action réussie puis processus arrêté.** La passe suivante la retrouve.
  Aucun couplage n'est ajouté au code métier : inscription, paiements,
  assistance et campagnes sont inchangés. Deux mécanismes, selon la source :
  - **Sources datées** (organisations, paiements confirmés, paiements à
    examiner, assistance) : chaque source a un curseur persistant, relu
    avec un recouvrement de 10 min. Un document horodaté avant la fin de sa
    transaction n'est jamais manqué (MongoDB borne une transaction à 60 s).
  - **Campagnes : sans curseur, recouvrement ni limite de 7 jours.**
    - À chaque passe, la collecte relit toutes les campagnes
      `{ status: 'launched', launchedAt: { $gte: activation } }` (index
      `status_1_launchedAt_1`).
    - Elle écarte seulement celles dont la clé
      `campaign_completed:<campagne>` existe déjà.
    - Une campagne lancée après l'activation reste donc dans le périmètre
      jusqu'à sa notification de fin, quelle que soit sa durée.
    - Testé à horloge contrôlée :
      - livraisons laissées en attente, passes et horloge avancées bien
        au-delà des 10 min, livraisons terminées le lendemain : une seule
        notification de fin ;
      - campagne en attente 8 jours avec une passe par jour, puis terminée :
        une seule notification de fin.
    - Coût : la liste relue grandit avec les campagnes lancées non encore
      conclues ; une campagne conclue n'est plus évaluée.
- **Doublons.** Les rejeux de webhook, le rapprochement, un redémarrage ou
  deux passes concurrentes passent par un upsert `$setOnInsert` sur
  `eventKey` unique : une seule notification, jamais modifiée (testé).
- **Clés de déduplication** :
  - `organization_created:<org>` ;
  - `payment_confirmed:<paiement>` ;
  - `payment_review:<paiement>:<incident>` ;
  - `support_request:<demande>` ;
  - `campaign_audience_partial:<campagne>` ;
  - `campaign_completed:<campagne>`.
- **Pas de rétroactivité.** Le point d'activation est posé par la
  **première passe** (et non par la migration). Rien d'antérieur n'est
  examiné, ni les campagnes lancées avant (testé).

  Après une interruption, une version retirée puis remise par exemple, le
  rattrapage des **sources datées** est borné à 7 jours. Cette borne ne
  s'applique pas aux campagnes (voir plus haut).
- **Délai typique** : jusqu'à 30 s pour la collecte, plus jusqu'à 60 s pour
  le compteur du navigateur.
- **Instances.** L'upsert et le curseur (`$max`) tolèrent plusieurs
  processus, mais la configuration testée est une seule instance API,
  comme les autres traitements de fond.

## 5. API et BFF

| Route | Effet |
|---|---|
| `GET /platform-admin/notifications?status=all\|unread&page=N` | 20 par page, page ≤ 500 ; `total`, `unread`, éléments |
| `GET /platform-admin/notifications/unread-count` | `{ unread }` |
| `POST /platform-admin/notifications/:id/read` | Idempotent ; 404 si invisible pour cet administrateur |
| `POST /platform-admin/notifications/read-all` | `{ marked, remaining }`, borne serveur (§ 2) |

- Réponses `no-store, private` et `noindex` (intercepteur existant).
- Le BFF ajoute ces 4 routes à sa liste blanche, avec leurs méthodes
  exactes ; la clé de requête `status` existait déjà. CSRF, cookie HttpOnly
  et codes publics sont inchangés.
- Le service worker ignore déjà `/admin` et `/api/admin` : aucune réponse
  administrative n'est mise en cache (contrôlé par `test:admin-bff`).

## 6. Interface

- **Cloche** dans l'en-tête commun de `AdminShell` (mobile et ordinateur),
  affichée seulement avec une session complète :
  - compteur borné à « 99+ », libellé accessible (« Notifications : 3 non
    lues ») ;
  - fenêtre `Dialog` (layout `form`), adaptée au mobile : zone visible,
    corps défilant, Échap, focus rendu à la cloche ;
  - 5 notifications récentes, « Tout marquer comme lu », « Voir toutes les
    notifications ».
- **Page `/admin/notifications`** :
  - filtres Toutes / Non lues (`aria-pressed`) ;
  - pagination, « Marquer comme lu », « Tout marquer comme lu » ;
  - états chargement, vide, erreur avec « Réessayer ».
- **Distinction lu / non lu** : pastille, graisse, bordure, et mention
  « lue » / « non lue » pour les lecteurs d'écran.
- Ouvrir une notification la marque comme lue puis mène à sa cible. Ouvrir
  la cloche ne marque rien.
- **Actualisation** : interrogation simple toutes les 60 s, **seulement
  onglet visible**, plus une lecture au retour sur l'onglet et après chaque
  lecture. Il n'existe aucun mécanisme temps réel administratif, et ce lot
  n'en ajoute pas (pas de WebSocket).
  - Elle s'arrête au démontage, à la déconnexion, et dès qu'une réponse
    signale une session caduque (retour à la connexion).
- FR / EN, clair / sombre (jetons existants).

## 7. Migration, déploiement, compatibilité

- **Migration** `create-platform-admin-notification-indexes`
  (`migrate:platform-admin-notification-indexes`), ajoutée à
  `migrate:predeploy` après les index de l'administration.
  - Idempotente : sans effet si l'index exact existe ; échec sans rien
    écraser s'il diffère.
  - Ne crée aucune notification et n'attribue aucune capacité (testé).
  - Elle crée aussi trois index de **performance** sur les sources :
    `subscription_payments.status_1_confirmedAt_1`,
    `subscription_payments.status_1_updatedAt_1` et
    `platform_campaigns.status_1_launchedAt_1`.
- **Index manquant** :
  - Index requis absents : seules les routes de notifications répondent 503
    (« indisponible ») et la collecte est suspendue. La vérification est
    refaite au plus une fois par minute. Ces index sont vérifiés **à part**
    de ceux de l'espace : le reste de l'administration fonctionne, et les
    commerces ne sont jamais affectés.
  - Index de performance absents : la collecte fonctionne mais lit
    davantage de documents.
- **Ordre de déploiement** : migrations, puis API, puis web.
  - Ancien web avec nouvelle API : aucune différence visible (aucune route
    existante n'est modifiée ; seul `grantedAt` est ajouté au contexte
    interne).
  - Nouveau web avec ancienne API : le BFF relaie, l'API répond 404. La
    cloche reste sans compteur et la page affiche une erreur avec
    « Réessayer ». Rien d'autre n'est affecté.
- **Retour arrière** : retirer l'API suffit (la collecte s'arrête). Les
  collections peuvent rester. À la remise en service, le rattrapage est
  borné à 7 jours.
- **Conservation.** Aucune suppression automatique dans ce lot (pas de TTL).
  La durée de conservation des notifications et des lectures **reste à
  définir** par l'exploitant (§ 8).

## 8. Décisions à prendre

- Durée de conservation des notifications et des lectures. Une purge
  devra supprimer les lectures avec leur notification pour garder le
  compteur exact.
- Faut-il signaler les paiements `succeeded` marqués
  `late_failure_after_success` ? Aucun état ne dit aujourd'hui s'ils
  restent à traiter.
- Une consultation des demandes d'assistance dans l'administration. Elle
  n'existe pas, et ce lot n'en crée pas.

## 9. Contrôles réalisés (29 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `jest` API : `platform-admin-notifications.spec.ts` (nouveau : droits, règles des paiements et des campagnes, clés, liste blanche, index), avec `predeploy-migrations.spec.ts` et `platform-admin.spec.ts` | 3 suites, 84 tests OK |
| `test/platform-admin-notifications.e2e-spec.ts` (nouveau, base éphémère) | 15 / 15 (dont 3 campagnes à horloge contrôlée, ajoutés lors de la vérification de la collecte différée) |
| E2E voisins, relancés car du code partagé est touché (helpers d'index, contexte de session, module) : `platform-admin`, `platform-admin-actions`, `platform-admin-communications`, `marketing-campaigns`, plus le nouveau | 5 suites, 102 tests OK |
| API : `nest build`, `tsc -p tsconfig.build.json`, ESLint des fichiers touchés | OK. Restent 2 avertissements `no-unsafe-argument` préexistants dans `platform-admin.service.ts`. Les erreurs de `tsc` sur les `*.spec.ts` existaient déjà (rien dans ce lot) |
| Web : `tsc`, ESLint des fichiers touchés, `test:i18n` (2 428 clés FR), `i18n:coverage`, `test:admin-bff` (17 / 17, dont les routes des notifications), `next build` (route `/admin/notifications`) | OK |

**Couverture e2e :**

- **Accès** : secret du BFF exigé (404 sinon) ; JWT de commerce, session
  pre-MFA, jeton inconnu et accès révoqué refusés ; `no-store`.
- **Organisation** : notification unique malgré deux passes ; une
  transaction réellement annulée ne produit rien.
- **Paiements** :
  - `succeeded` et `review` signalés ;
  - `pending`, `uncertain`, `failed` et `review` remboursé ignorés ;
  - prolongation offerte ignorée ;
  - rejeux (paiement retouché, passes répétées) sans doublon ;
  - URL de paiement absente de la réponse.
- **Assistance** : référence et catégorie seulement. Aucune trace de
  l'adresse, du nom du client, de l'empreinte, de la page ni de
  l'identifiant de la demande.
- **Campagnes** :
  - rien pendant la constitution ;
  - audience partielle signalée une fois ;
  - pas de fin tant qu'une livraison reste `pending` (interrupteur coupé) ;
  - fin unique avec résumé exact ;
  - contenu de la campagne absent ;
  - horloge contrôlée : fin le lendemain, au-delà du recouvrement, et après
    8 jours d'attente → une seule notification ;
  - livraison insérée **directement en base** après la clôture : aucune
    seconde notification. Le chemin applicatif, lui, n'en insère plus
    aucune (campagnes, § 1.5.1).
- **Lecture** :
  - deux administrateurs indépendants ;
  - `userId` envoyé par le navigateur ignoré ;
  - lecture idempotente ;
  - filtre « Non lues ».
- **Droits** : capacité retirée → liste et compteur vides, 404 ; capacité
  d'action seule → rien ; capacité rendue → retour.
- **Nouvel administrateur** : rien d'antérieur à son attribution, 404 sur
  une notification antérieure, la suivante compte.
- **« Tout marquer comme lu »** :
  - idempotent ;
  - sans effet pour l'autre administrateur ;
  - une notification enregistrée après, même datée d'avant, reste non
    lue.
- **Pagination et entrées** : 20 par page ; page 501 et filtre inconnu
  refusés (400).
- **Cible disparue** : `available: false`, résumé conservé, lecture
  possible.
- **Migration** : relancée sans rien créer, aucune notification ni
  capacité ; l'historique antérieur à la première passe n'est jamais
  signalé.

### 9.1 Navigateur

Recette isolée (`start --platform-admin`, base en mémoire), Chromium
headless local piloté par un Playwright déjà présent (rien installé).
Comptes fictifs `admin.actif@recette.local` (A) et
`vendeur.actif@recette.local` (B), attribués puis enrôlés par les commandes
réelles. Événements fictifs insérés en base : 2 organisations, dont une
supprimée ensuite, un paiement confirmé, un paiement à examiner, une demande
d'assistance, une campagne partielle puis terminée.

- **Collecte** : 7 notifications pour chacun. Les événements d'un premier
  passage, antérieurs à l'activation, n'apparaissent pas.
- **Ordinateur 1280 px, EN, clair (A)** :
  - compteur « 7 », libellé « Notifications: 7 unread » ;
  - au clavier : focus sur la cloche, Entrée ouvre, Échap ferme et rend le
    focus ;
  - 5 récentes et « See all notifications » ;
  - ouvrir une notification la marque comme lue et mène à la campagne
    (compteur 6, B inchangé) ;
  - page complète : « Item unavailable » sans lien, distinction lu / non
    lu ;
  - filtre « Unread » (`aria-pressed`), « Mark as read », « Mark all as
    read » ;
  - état vide, badge retiré ; B toujours à 7.
- **Mobile 390 px, FR, sombre (B)** :
  - liste intacte ;
  - « Élément indisponible » ;
  - aucun défilement horizontal ;
  - fenêtre de la cloche entièrement dans l'écran ;
  - « Voir toutes les notifications ».
- **Nouvelle organisation, page ouverte** : le compteur de B passe de 7 à
  8 sans rechargement, en 60 s. A, après son « tout lu », la reçoit non lue
  (1).
- **Déconnexion** : aucune requête vers les notifications pendant les 65 s
  suivantes.
- **Erreurs** : aucune erreur de page. Une seule erreur de console, un 401
  de `auth/status` émis par la page de connexion après la déconnexion :
  comportement préexistant, reproduit sur `/admin/login` sans session.

Outillage de recette mis à jour : `launcher.js` (nouvelle migration) et
`boot-api.js` (collecte démarrée toutes les 5 s, comme les autres
traitements de fond qu'il réplique).

### Non vérifié

- Vrais téléphones et lecteurs d'écran.
- Comportement derrière Vercel et Railway.
- Plusieurs instances d'API.
- Volumes réels : le compteur fait deux `countDocuments` indexés ; la
  liste « Non lues » passe par un `$lookup` borné à 20 éléments par page.
