# Administration de la plateforme — messages de service

Branche : `feature/platform-admin-communications`, créée depuis `origin/dev`
(`683c22c`), qui contient déjà les deux lots administratifs
([platform-admin-mfa.md](platform-admin-mfa.md),
[platform-admin-actions.md](platform-admin-actions.md)) : aucune dépendance
de branche. Arbre de travail propre au départ ; aucun reset ni stash.
Aucun commit, push, déploiement, envoi réel ni modification de production.

Lot : envoi, depuis la fiche administrative d'une organisation, d'un
message de service (assistance, maintenance) à un, plusieurs ou tous les
membres actifs de CETTE organisation, par notification interne, e-mail ou
les deux. Hors périmètre : campagne marketing, programmation, envoi à
plusieurs organisations, pièce jointe, HTML libre.

## 1. Fonctionnement

1. **Préparation** (`GET organizations/:id/message-recipients`) : membres
   actifs (nom, e-mail du compte, rôle), « joignable » si le compte est
   vérifié, canaux ouverts par les capacités de la session, limites et
   compteurs. « Tous les membres » = la liste lue à ce moment, figée dans
   le contenu confirmé : un membre ajouté ensuite n'est pas destinataire.
2. **Formulaire** : un / plusieurs / tous ; canaux ; titre (1 à 150
   caractères, une ligne) ; message (1 à 5 000 caractères). Texte brut :
   fins de ligne unifiées, espaces de bord retirés, caractères de contrôle
   refusés ; rien n'est interprété (React et l'e-mail échappent tout).
3. **Récapitulatif** : aperçu du message, destinataires, canaux, rappels
   (préférences, « accepté » ≠ reçu, membre devenu inéligible ignoré),
   identifiant d'opération.
4. **Confirmation** : mot de passe + second facteur (`security/step-up`
   existant), preuve de 5 min, à usage unique, liée à l'empreinte du
   contenu canonique : organisation, identifiant d'opération, destinataires
   (triés, dédupliqués), canaux, titre, texte. Toute modification change
   l'empreinte → 403 `PLATFORM_ADMIN_STEP_UP_REQUIRED`.
5. **Envoi** (`POST organizations/:id/messages`), puis livraison en fond.
6. **Historique** (`GET organizations/:id/messages?page=N`, 10 par page) :
   auteur, date, titre, contenu, destinataires, canaux, statut par
   destinataire et canal ; relance (`POST organizations/:id/message-retry`).

Une organisation **suspendue** reste joignable par e-mail ; la fenêtre
l'indique et précise que ses membres ne peuvent pas ouvrir le centre de
notifications tant qu'elle l'est (la notification est créée et sera
visible après réactivation ; aucun push n'est envoyé : le dispatcher écarte
les organisations inactives). L'envoi ne modifie jamais `organizations`,
`organizationmemberships` ni `users` (testé).

## 2. Capacités et sécurité

| Capacité | Permet |
|---|---|
| `platform.communications.notify` | Préparer, envoyer et relancer par **notification interne** |
| `platform.communications.email` | Préparer, envoyer et relancer par **e-mail** |

- Ajoutées au catalogue `platform-admin-capabilities.ts`, donc gérées par
  les commandes existantes `capability-add` / `capability-remove`. Aucun
  administrateur ne les reçoit automatiquement (défaut inchangé :
  `platform.read`). Aucune permission délégable des commerces n'est
  ajoutée ; l'espace `platform.` reste refusé dans les invitations.
- « Les deux » exige les deux (`intentCapabilities`), à la preuve ET à
  l'exécution ; une relance exige la capacité du canal relancé.
  L'historique demande `platform.read` ; la préparation, au moins une
  capacité de communication.
- Contrôles API indépendants de l'interface (garde, capacités relues à
  chaque requête, preuve liée) ; BFF : 4 routes ajoutées à la liste
  blanche, CSRF, cookie de session, `no-store`, `noindex` inchangés ; codes
  d'erreur publics ajoutés (§ 6). Corps maximal du BFF porté de 16 à
  64 Kio (un message de 5 000 caractères UTF-8 dépasse 16 Kio).
- Destinataires vérifiés **dans la transaction d'envoi** : membres actifs
  de cette organisation, comptes présents et vérifiés. Un identifiant d'un
  autre commerce, inconnu ou inactif refuse tout l'envoi (409
  `PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED`, la liste est rechargée) :
  jamais de sélection tronquée. Revérification **avant chaque livraison** :
  un membre retiré, un compte supprimé ou non vérifié → `skipped` avec
  motif (`membership_inactive`, `account_missing`, `account_inactive`).
- Adresse e-mail résolue côté serveur depuis le compte (jamais envoyée par
  le navigateur) ; réponse vers `support@stock-master.app`
  (`SUPPORT_RECIPIENT`, déjà centralisée) ; expéditeur `EMAIL_FROM`
  existant.
- Aucun accès ajouté aux catalogues, ventes ou secrets des commerces.

## 3. Notifications et e-mails

**Notification interne** — nouvelle catégorie `platform-message`
(« Message de Stock Master » / « Message from Stock Master ») :

- centre de notifications existant ; visible de tout membre destinataire
  (`canAccessCategory` → vrai ; le centre filtre déjà par utilisateur) ;
- préférence du **centre** `platformMessage` (active par défaut, documents
  existants complétés à la lecture) : désactivée → livraison `skipped`,
  motif `preference_off`, visible dans l'historique (jamais contournée en
  silence) ;
- push : travail de l'outbox existante (`platform-message:<message>:<membre>`,
  un seul destinataire nommé ; un travail sans destinataire n'est jamais
  diffusé). Le dispatcher applique les préférences **push par appareil**
  (`platformMessage`), la version de session, l'appartenance. Pas
  d'appareil : la notification interne existe quand même. Le push n'est
  émis que si la notification du centre a été créée (c'est son signal) ;
- texte de l'écran verrouillé générique (« Vous avez reçu un message de
  Stock Master. »), jamais le titre ni le texte ; un clic ouvre
  `/app/notifications/<id>` (aucun lien fourni par l'administrateur) ;
- liste du centre : le titre du message ; détail : titre, texte brut
  (échappé), date, lien vers la page Assistance. Le contenu est relu dans
  `platform_messages` (seulement pour un destinataire de ce commerce),
  jamais recopié dans la notification ;
- conservation : 30 jours après lecture, comme les autres catégories
  longues.

**E-mail** — `EMAIL_SENDER` existant (Resend en production) :

- version texte et HTML (`platform-message-email.ts`, fonction pure) ; HTML
  entièrement échappé, texte conservé tel quel ; habillage FR/EN selon la
  langue du **destinataire** (`User.locale`), contenu jamais traduit ;
- clé d'idempotence `platform-message/<message>/<membre>`, constante pour
  toutes les tentatives ; destinataire, langue et nom du commerce **figés
  au premier envoi** (un renvoi doit être identique pour être dédupliqué).

## 4. Fiabilité

**Une transaction** (MongoDB) : consommation de la preuve, compteurs et
limites, revérification des destinataires, message figé
(`platform_messages`), livraisons (`platform_message_deliveries`, une par
destinataire et canal, unique `{messageId, userId, channel}`), opération
idempotente (`platform_admin_operations`), audit. Aucun appel externe dans
la transaction.

**Idempotence** : même identifiant + même contenu → résultat existant
(`replayed: true`) sans nouvelle preuve ni envoi ; contenu différent → 409
`PLATFORM_ADMIN_OPERATION_CONFLICT`. Double clic / requêtes simultanées :
un seul message (index uniques ; la requête perdante relit l'opération).

**Traitement de fond** (`PlatformMessageDeliveryService`), démarré par le
démarrage HTTP seulement (comme le dispatcher des notifications), toutes
les 5 s et aussitôt après un envoi :

- réservation conditionnelle (`pending` échue ou `sending` dont le verrou
  de 60 s a expiré) : une livraison n'est traitée que par une passe à la
  fois ; passes sérialisées dans le processus ;
- notification interne : upsert `{eventKey, userId}`, puis travail push
  (upsert `eventKey`) : une reprise ne double rien ;
- e-mail : 5 tentatives au plus (reprises à 1, 5, 15, 60 min) ;
  - refus certain définitif (configuration absente, 4xx) → `failed` ;
  - 429 → reprise ;
  - délai, réseau, 5xx, 409 d'idempotence → **résultat inconnu** : reprise
    avec la même clé tant que la fenêtre de 23 h du prestataire n'est pas
    dépassée, puis `uncertain`.

**Fenêtre d'incertitude (limite assumée).** Si le prestataire accepte
l'e-mail mais que sa réponse est perdue (ou si le processus s'arrête
pendant l'appel), Stock Master ne peut pas savoir s'il est parti.

- **Début de fenêtre** : `firstAttemptAt`, écrit en base (sous la
  réservation) **avant** le premier appel possible au prestataire, puis
  jamais modifié : ni une reprise automatique, ni un redémarrage, ni une
  relance manuelle ne le réinitialisent.
- **Reprises avec une clé stable** : chaque renvoi porte la même clé
  d'idempotence et un contenu identique (destinataire, langue, nom du
  commerce figés), pour que le prestataire puisse le dédupliquer (Resend
  conserve la clé 24 h).
- **Arrêt des renvois** : 23 h après le début de fenêtre, une livraison
  dont l'acceptation passée est incertaine ne provoque plus aucun appel
  externe — reprise échue, relance manuelle en attente ou livraison restée
  `sending` après l'arrêt du processus. Elle se termine en « Résultat
  incertain ».
- **Incertitude conservée** : une erreur définitive ultérieure (4xx,
  destinataire devenu inéligible, message introuvable) ou une erreur
  interne survenue après l'appel (écriture du succès perdue, par exemple)
  ne fait jamais oublier une tentative au résultat incertain : le statut
  final est « Résultat incertain », jamais « Échec » ni « Ignoré ».

Les tentatives étant bornées (5 automatiques, 3 relances manuelles, fenêtre
de 23 h), **la livraison n'est pas garantie** ; et l'unicité dépend de la
déduplication du prestataire pendant la fenêtre : jamais « exactement une
fois ».

**Relance** : manuelle, par canal, des seules livraisons `failed` ou
`uncertain` désignées (jamais un canal ou un destinataire déjà servi, jamais
un nouveau message) ; capacité du canal + preuve liée (message, canal,
livraisons exactes) ; 3 relances par livraison au plus ; une incertitude de
plus de 23 h est refusée (409 `PLATFORM_ADMIN_MESSAGE_RETRY_WINDOW_EXPIRED`).

**Statuts affichés** : En attente / En cours, Notification créée, Accepté
par le prestataire (ni reçu ni lu), Ignoré (motif), Échec (motif),
Résultat incertain.

**Mono-instance.** La réservation conditionnelle protège aussi plusieurs
processus, mais ce lot (comme le dispatcher existant) est conçu et testé
pour une seule instance API (Railway).

## 5. Limites (serveur)

| Limite | Valeur | Dépassement |
|---|---|---|
| Destinataires par message | 50 | 400 `PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT` |
| Messages par organisation | 10 / 24 h glissantes | 429 `PLATFORM_ADMIN_MESSAGE_RATE_LIMITED` + `Retry-After` |
| Messages par administrateur | 30 / heure glissante | idem |
| Titre / texte | 150 / 5 000 caractères | 400 |
| Relances par livraison | 3 | 409 `PLATFORM_ADMIN_MESSAGE_NOT_RETRYABLE` |

Limites appliquées dans la transaction après écriture d'un compteur
(`platform_message_counters`, `org:<id>` et `actor:<id>`) : deux envois
simultanés entrent en conflit et le second relit le premier. Valeurs dans
`platform-message-policy.ts` et `platform-admin-action-intent.ts`.

## 6. Audit, journaux, données

- Audit `organization_message` / `organization_message_retry` (succès et
  refus : capacité, preuve, destinataires, limites, relance impossible) :
  acteur, capacité (`null` si deux), organisation, opération, canaux,
  nombre de destinataires, identifiant du message. **Jamais** le titre, le
  texte ni une adresse e-mail. L'opération ne porte aucun motif libre.
- Journaux : identifiant de livraison et motif court seulement (testé :
  ni titre, ni texte, ni adresse, ni mot de passe dans les journaux de la
  suite e2e).
- Le contenu ne vit que dans `platform_messages` (aucune rétention
  automatique, comme l'audit : à décider par l'exploitant).
- Nouveaux codes publics relayés par le BFF :
  `PLATFORM_ADMIN_MESSAGE_RECIPIENT_LIMIT`, `…_RATE_LIMITED`,
  `…_RECIPIENTS_CHANGED`, `…_NOT_RETRYABLE`, `…_RETRY_WINDOW_EXPIRED`.

## 7. Contrôles réalisés (27 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `jest` API (dont `platform-admin-communications.spec.ts` : forme canonique, empreinte, bornes, capacités, échappement, classement des échecs, relances) | 109 suites, 2 023 tests OK |
| `test/platform-admin-communications.e2e-spec.ts` (nouveau, recette isolée) | 19/19 (dont 4 sur les reprises d'e-mails, § 7.2) |
| E2E touchées : `platform-admin`, `platform-admin-actions`, `notification-center`, `member-activity-notifications`, `web-push-notifications` (3 assertions de catégories mises à jour) | toutes OK |
| `pnpm --filter api build`, typage, ESLint des fichiers touchés | OK (0 erreur ; avertissements `no-unsafe-argument` préexistants) |
| Web : typage, ESLint des fichiers touchés, `test:i18n`, `i18n:coverage`, `test:admin-bff` (15/15, dont routes et codes), `next build` | OK |
| Navigateur (recette isolée, Chromium headless local) : § 7.1 | voir ci-dessous |

Couverture e2e : lecture seule refusée (préparation, preuve, envoi) ;
chaque capacité n'ouvre que son canal, « les deux » exige les deux, une
preuve d'un canal ne sert pas l'autre ; destinataire d'un autre commerce,
inconnu ou non vérifié refusé sans rien écrire ; preuve déplacée vers une
autre organisation refusée ; preuve expirée, réutilisée ou liée à un autre
titre / texte / canal refusée ; sélection dédupliquée ; 51 destinataires
refusés ; rejeu identique (même résultat) et contenu différent (409) ;
4 requêtes simultanées → 1 message, 1 e-mail, 1 notification ; limite par
organisation (429 + `Retry-After`) ; livraison : e-mail (adresse du compte,
Reply-To, clé, HTML échappé), notification, travail push, liste et détail
du centre, historique ; échec d'un canal → relance de ce seul canal,
l'autre jamais renvoyé, capacité du canal exigée, relance d'un canal réussi
refusée, relance interorganisations introuvable ; incertitude (délai) →
reprises bornées avec la même clé puis « incertain », relance refusée hors
fenêtre ; préférence du centre désactivée → ignorée, e-mail envoyé ; membre
retiré avant livraison → ignoré ; commerce suspendu → e-mail envoyé, statut
inchangé ; expéditeur non configuré → échec certain sans appel ; aucun
secret ni contenu dans les réponses, l'audit et les journaux.

### 7.1 Navigateur

Recette isolée (`start --platform-admin`, base en mémoire, e-mails dans
`mail.jsonl`, push simulé), Chromium headless local piloté par un
Playwright déjà installé ; 16 captures relues (non versionnées), aucune
erreur de page :

- administration, ordinateur 1280 px FR et mobile 390 px EN : fiche,
  formulaire (« Tous les membres actifs », deux canaux, titre et texte
  contenant `<b>`, `<script>`, une URL), récapitulatif avec aperçu,
  confirmation par mot de passe + TOTP, résultat, historique (« Notification
  créée », « Accepté par le prestataire ») ; fiche en mobile FR et
  ordinateur EN ;
- commerce (propriétaire), mobile FR et ordinateur EN : centre de
  notifications puis détail ; balises affichées en texte, jamais
  interprétées ;
- fenêtre mobile : en-tête et pied fixes, corps défilant ;
- `mail.jsonl` : un e-mail par message, adresse du compte, Reply-To
  assistance, clé `platform-message/…`.

Correction faite après relecture : la carte « Actions » annonçait « lecture
seule » à un administrateur doté des seules capacités de communication ;
elle indique désormais qu'aucune suspension ni prolongation n'est accordée.

### 7.2 Sécurité des reprises d'e-mails (finalisation, 27 octobre 2026)

| Garantie | Où | État |
|---|---|---|
| Début de fenêtre persisté avant l'appel, jamais réinitialisé | `deliverEmail` (`firstAttemptAt` écrit sous la réservation avant `sender.send`, `existant ?? maintenant`) ; `recordRetry` ne touche ni `firstAttemptAt` ni `uncertainAt` | déjà en place |
| Aucun appel après expiration, y compris `sending` après arrêt | `processOne` (reprise d'un `sending` déjà commencé → incertain) puis contrôle de fenêtre avant tout appel ; `reschedule` n'en programme aucune au-delà | déjà en place |
| Erreur définitive après incertitude → reste incertaine | `final()` dans `deliverEmail`, `reschedule` | déjà en place |
| Erreur interne APRÈS l'appel → incertaine | `processOne` : drapeau posé juste avant l'appel, l'erreur interne est alors reprise comme incertaine (même clé, même fenêtre) | **corrigé** (auparavant : reprise sans incertitude, fin possible en « Échec » alors que l'e-mail avait pu partir) |
| Message introuvable après incertitude | `processOne` | **corrigé** (« Échec » → « Résultat incertain ») |

Tests ajoutés (e2e) : date présente en base à chaque appel et identique
après reprise, redémarrage simulé et relance manuelle, clé unique ; fenêtre
dépassée → aucun appel pour une livraison `sending` abandonnée et pour une
reprise incertaine échue ; délai puis 422 → « incertain », dates
conservées ; écriture du succès perdue après l'appel → incertitude
retenue, renvoi avec la même clé puis « accepté ».

### Non vérifié

Vrais téléphones et lecteurs d'écran ; Resend réel (clé d'idempotence et
déduplication réelles) ; push réel sur appareil ; comportement derrière
Vercel et Railway.

## 8. Configuration, déploiement, retour arrière

**Configuration** : aucune nouvelle variable. Réutilisées : `EMAIL_FROM`,
`RESEND_API_KEY` (API), variables `PLATFORM_ADMIN_*` existantes, Web Push
existant. Sans Resend configuré, les e-mails passent en `failed`
(`email_not_configured`) sans appel.

**Migrations** : `create-platform-admin-indexes.js` (déjà dans
`PREDEPLOY_MIGRATIONS`) crée en plus, de façon idempotente :
`platform_messages.{operationId_1_unique, organizationId_1_createdAt_-1,
actorUserId_1_createdAt_-1}` et
`platform_message_deliveries.{messageId_1_userId_1_channel_1_unique,
status_1_nextAttemptAt_1, status_1_lockedUntil_1}`. Aucune donnée écrite,
aucune capacité attribuée, aucun message envoyé. Tant que ces index
manquent, l'espace d'administration reste fermé (503), comme avant.
Schémas : champs facultatifs ajoutés (`platformMessage` dans les
préférences, `platformMessageId` dans les notifications,
`recipientUserId`/`platformMessageId`/`notificationId` dans les travaux
push) ; documents existants inchangés.

**Ordre** : déploiement API (pré-déploiement `migrate:predeploy`), puis web
(Vercel), puis attribution des capacités (§ 9).

**Retour arrière** : redéployer la version précédente (API et web).
Effets : les collections `platform_messages*` sont ignorées ; les
livraisons encore `pending` ne partent plus ; les notifications
`platform-message` déjà créées ne sont plus listées (catégorie inconnue de
l'ancien code, filtrée par `accessibleCategories`) ; les travaux push de
cette catégorie sont clos par l'ancien dispatcher sans aucun destinataire
(catégorie refusée par `canAccessCategory`) ; la clé `platformMessage`
des préférences est conservée et ignorée ; les capacités ajoutées restent
dans l'autorisation et sont ignorées (`effectiveCapabilities` écarte les
valeurs inconnues). Rien à nettoyer pour revenir en arrière ; avant un
retour arrière, attendre la fin des livraisons en attente si possible.
*Non exécuté sur l'ancien code dans ce lot* (raisonnement sur le code de
`683c22c`).

## 9. Attribuer les deux capacités à votre compte

Image de production (Railway, shell du service API, dossier `/app/api`),
lecture seule d'abord, puis `--apply` :

```bash
node dist/migrations/platform-admin-cli.js status --user-id=<VOTRE_ID>

node dist/migrations/platform-admin-cli.js capability-add --user-id=<VOTRE_ID> \
  --capability=platform.communications.notify \
  "--reason=Messages de service aux commerces (notification)" --operator=<vous>
node dist/migrations/platform-admin-cli.js capability-add --user-id=<VOTRE_ID> \
  --capability=platform.communications.notify \
  "--reason=Messages de service aux commerces (notification)" --operator=<vous> --apply

node dist/migrations/platform-admin-cli.js capability-add --user-id=<VOTRE_ID> \
  --capability=platform.communications.email \
  "--reason=Messages de service aux commerces (e-mail)" --operator=<vous>
node dist/migrations/platform-admin-cli.js capability-add --user-id=<VOTRE_ID> \
  --capability=platform.communications.email \
  "--reason=Messages de service aux commerces (e-mail)" --operator=<vous> --apply

node dist/migrations/platform-admin-cli.js status --user-id=<VOTRE_ID>
```

Depuis un poste avec le dépôt : `MONGODB_URI=… pnpm --filter api
platform-admin -- capability-add …` (mêmes options). Les capacités sont
relues à chaque requête : reconnecter l'administration n'est pas
nécessaire, recharger la fiche suffit. Retrait :
`capability-remove` avec les mêmes options.
