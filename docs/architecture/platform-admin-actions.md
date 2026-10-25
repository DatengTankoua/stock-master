# Administration de la plateforme — actions sur les commerces

Branche : `feature/platform-admin-actions`, **dépendante** de
`feature/platform-admin-mfa` (commit `b0a42cd`, premier lot), qui n'est pas
encore fusionnée dans `origin/dev`. À fusionner après elle (ou à rebaser sur
`origin/dev` une fois le premier lot fusionné). Arbre de travail propre au
départ : aucun reset, aucun stash.

Lot : suspension et réactivation d'un commerce, prolongation commerciale
offerte. Prérequis : [platform-admin-mfa.md](platform-admin-mfa.md).

## 1. Points ouverts du premier lot

| Point | Constat | Suite |
|---|---|---|
| Adresse réseau relayée par le BFF | **Défaut confirmé** en recette : le BFF relayait `X-Real-IP`, sinon le premier `X-Forwarded-For`, sans savoir si l'hébergeur les écrase. Serveur web joint directement : 22 essais de connexion avec une adresse forgée différente, aucun 429 (contre 429 au 21ᵉ essai depuis une seule adresse). | Corrigé : l'en-tête n'est lu que s'il est déclaré de confiance (`PLATFORM_ADMIN_CLIENT_IP_HEADER` = `x-real-ip` ou `x-vercel-forwarded-for`, valeurs que Vercel et le nginx du dépôt écrasent) ; `x-forwarded-for` n'est plus jamais lu. Sans déclaration, aucune adresse relayée et l'API n'applique **que** les plafonds par compte (l'adresse du BFF, commune à tous, aurait permis à un tiers de bloquer toutes les connexions). Tests : `test-admin-bff.mjs`. |
| Déconnexion générale | **Défaut confirmé** (lecture du code) : la déconnexion d'un commerce laissait le cookie d'administration de l'appareil valable (30 min d'inactivité, 8 h au plus). | Corrigé : la déconnexion d'un commerce ferme aussi la session d'administration. Cas d'échec traités au § 1.1. |
| Données d'administration en cache | Vérifié sur la recette : pages `/admin/*`, charges RSC et réponses du BFF en `no-store, private`, `noindex` ; données lues côté client uniquement, jamais en IndexedDB ; service worker exclu. | Aucun défaut confirmé. Non vérifié sans navigateur réel : la restauration d'une page depuis le cache avant/arrière après déconnexion (non modifié). |

**Page Sécurité (défaut du premier lot, corrigé le 24 octobre 2026).** Le
BFF retirait tout champ `session` des réponses pour en extraire le jeton :
il retirait aussi les échéances de `auth/status`, et la page Sécurité
plantait au rendu (« This page couldn't load »). Désormais seul le jeton est
retiré. Reproduit en recette (Chrome) ; test de non-régression dans
`test-admin-bff.mjs`.

**Défi Cloudflare Turnstile sur `/admin/login` (oubli du premier lot,
corrigé le 25 octobre 2026).** L'API appliquait déjà à la connexion
d'administration la règle 1-18C de la connexion des commerces (même
`verifyCredentials`, mêmes compteurs par compte) : après 10 échecs sur un
compte (`AUTH_ACCOUNT_FAILURE_LIMIT`), chaque essai exige un défi Turnstile
neuf (action `login`). La page ne savait pas l'afficher. Désormais :

- sur `AUTH_CHALLENGE_REQUIRED`, la page affiche le widget Turnstile
  (`TurnstileWidget`, action `login`) et n'autorise l'envoi qu'avec un jeton ;
  jeton à usage unique, widget réinitialisé à chaque envoi ;
- refus du défi (`TURNSTILE_FAILED`, `TURNSTILE_REQUIRED`) et indisponibilité
  (`TURNSTILE_UNAVAILABLE`) ont leurs messages FR/EN ;
- défi réussi + bon mot de passe : la fenêtre du compte est refermée (règle
  1-18C inchangée) ; puis second facteur, comme toujours ;
- CSP inchangée (`challenges.cloudflare.com` déjà autorisé pour toutes les
  pages).

Configuration : la même que la connexion des commerces
(`TURNSTILE_SECRET_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES` côté API,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` côté web ; le nom d'hôte de `/admin` est
celui du site). Sans Turnstile configuré, aucun défi n'est proposé : après
10 échecs, attendre la fin de la fenêtre (15 min). En recette :
`start --platform-admin --anti-bot=simulated`.

Le défi n'est **pas** exigé à chaque connexion (même règle que les
commerces) : la connexion d'administration garde en plus le plafond par
adresse (§ 10) et le second facteur obligatoire.

Contrôle : `platform-admin.e2e-spec.ts` (10 échecs → `AUTH_CHALLENGE_REQUIRED`
avec le bon mot de passe ; jeton d'une autre action refusé ; jeton `login`
neuf → connexion ; fenêtre refermée ensuite), 32/32.

**Messages d'erreur sans information exploitable (26 octobre 2026).**

- **API** : sans le secret du BFF, ou espace fermé, toute route
  `/platform-admin/*` répond exactement comme une URL inconnue (404
  `Cannot <MÉTHODE> <url>`, mêmes en-têtes) ; seul le BFF apprend ensuite si
  l'espace est ouvert.
- **BFF** : le corps d'erreur de l'API n'est jamais relayé (ni message, ni
  détail de validation, ni chemin). Le navigateur reçoit le statut, un
  **code public** et une **référence opaque aléatoire** (`publicError`,
  `bff-policy.ts`) :
  - connexion : mot de passe faux, compte inconnu, compte sans accès
    plateforme et adresse non confirmée → un seul refus
    `PLATFORM_ADMIN_LOGIN_FAILED` (« Identifiants incorrects ou accès non
    autorisé ») ;
  - API injoignable, erreur 5xx, secret ou route refusés, espace fermé,
    code inconnu → `PLATFORM_ADMIN_UNAVAILABLE` ;
  - validation → `PLATFORM_ADMIN_INVALID_REQUEST`, sans détail ;
  - conservés : expiration de session, second facteur, défi anti-robot,
    plafonds (identiques pour un compte connu ou inconnu), et, en session
    vérifiée, les codes utiles aux actions.
- **Diagnostic** : le BFF écrit dans le journal serveur
  `[admin-bff] ref=<référence> <méthode> <route> → <statut public> <code public> (API <statut> <code>)`,
  sans secret, jeton ni saisie. L'écran n'affiche que la référence, à
  rechercher dans les journaux Vercel.
- Les textes FR/EN ne citent plus ni variable de configuration, ni
  composant, ni l'existence d'un compte.
- Contrôles : `test-admin-bff.mjs` (14/14) ; e2e : route masquée identique à
  une URL inconnue, espace fermé → 404 (49/49).

### 1.1 Déconnexion d'administration en échec

Chemins : déconnexion d'un commerce (`logout()`) et bouton de la console,
tous deux par `endAdminSessionQuietly()` (3 s au plus, jamais bloquant).

| Situation | Avant | Maintenant |
|---|---|---|
| API injoignable ou en erreur, serveur web joint | 502 sans effacer le cookie : session utilisable sur l'appareil | Le BFF **efface toujours le cookie** sur `auth/logout` (réponse de l'API, erreur ou API injoignable). Le jeton n'est plus sur l'appareil ; la session serveur expire à son délai d'inactivité (30 min au plus). |
| Requête qui ne quitte pas l'appareil (hors ligne, délai dépassé) | Erreur ignorée : cookie et session conservés | Marqueur `stockmaster.admin.logout-pending` (valeur `1`, aucun secret) dans `localStorage`. Déconnexion rejouée au retour du réseau (`online`), au prochain chargement d'une page, et **avant** toute ouverture de la console `/admin`. Marqueur retiré dès qu'une réponse du serveur web arrive. |
| Réponse perdue (requête traitée, réponse non reçue) | — | Session déjà révoquée côté serveur ; le marqueur provoque une seconde déconnexion, sans effet. |

Limites restantes :

- Pendant la coupure, le cookie reste sur l'appareil et la session serveur
  reste ouverte jusqu'à la relance ou à l'expiration (30 min d'inactivité,
  8 h au plus). La console ne peut pas être rouverte entre-temps sur cet
  appareil sans que la déconnexion soit d'abord rejouée.
- `localStorage` indisponible (navigation privée stricte, stockage
  bloqué) : pas de marqueur, donc pas de relance ; seule l'expiration
  ferme la session.
- Un cookie copié avant la déconnexion reste utilisable jusqu'à la
  révocation serveur ou l'expiration (comme toute session).

Contrôles ciblés (recette, Chrome via Playwright) : requête interrompue
avant l'envoi → marqueur posé, cookie présent, une session serveur ouverte ;
au retour sur `/admin` → déconnexion rejouée, marqueur retiré, cookie
effacé, session révoquée. API arrêtée → 502 et cookie effacé. Émulation
« hors ligne » de Chrome : la requête est partie, seule la réponse a été
perdue (session révoquée, marqueur posé puis relance sans effet).
`test-admin-bff.mjs` : effacement systématique sur `auth/logout`.

## 2. Capacités

Espace de noms `platform.`, distinct des permissions délégables des
commerces (`DELEGABLE_PERMISSIONS`) : aucune invitation, aucun rôle de
commerce, aucune route ne peut les accorder (une invitation qui en contient
est refusée, 400).

| Capacité | Permet |
|---|---|
| `platform.read` | Vue d'ensemble, organisations, fiche, paiements, audit |
| `platform.organizations.suspend` | Suspendre et réactiver un commerce |
| `platform.subscriptions.extend` | Accorder une prolongation offerte |

- Autorisation existante sans champ `capabilities` : **lecture seule**. Toute
  autorisation accordée (ou réaccordée) commence en lecture seule.
- Seule la commande opérateur modifie les capacités :
  `platform-admin capability-add|capability-remove --user-id=<id>
  --capability=<capacité> --reason=<motif> --operator=<vous> [--apply]`
  (lecture seule sans `--apply`, autorisation active exigée, écriture
  conditionnée à l'état lu, audit `capability_grant`/`capability_revoke`
  avec avant/après, même transaction).
- À chaque requête : compte actif et vérifié, autorisation active,
  capacités relues, session administrative valide avec MFA.

## 3. Vérification renforcée liée à l'action

Chaque action exige une preuve **récente, à usage unique, liée à l'action,
à l'organisation et au contenu confirmé** :

1. L'interface envoie `POST security/step-up` avec mot de passe, code TOTP
   (ou code de récupération) et `intent` : action, organisation, identifiant
   d'opération et paramètres exacts.
2. L'API exige la capacité, vérifie les facteurs (rejeu TOTP refusé) et crée
   une preuve de 5 minutes portant `boundAction`, `boundTargetId` et
   l'empreinte SHA-256 du contenu canonique (espaces de bord retirés, date
   ISO, clés triées).
3. L'action recalcule l'empreinte depuis sa requête : autre action, autre
   organisation, contenu modifié, preuve expirée ou déjà consommée → 403
   `PLATFORM_ADMIN_STEP_UP_REQUIRED`. Une preuve non liée (opérations de
   sécurité du compte) n'est jamais acceptée, et inversement.

## 4. Suspension et réactivation

**État** : `Organization.status = suspended` (champ existant) et
`Organization.suspension` = date, administrateur, motif interne, message au
commerce, identifiant d'opération. Distinct de l'expiration de l'abonnement
(périodes), du statut des membres (memberships) et d'une suppression (aucune).
Motif interne et message sont deux champs séparés ; seul le message est
renvoyé, au propriétaire uniquement.

**Effets** (vérifiés en e2e) :

- Toute route métier (lecture, écriture, exports, images signées, paiements)
  passe par `resolveActiveContext` : un membre actif reçoit 403
  `ORGANIZATION_SUSPENDED` ; un tiers garde le refus uniforme
  `ORGANIZATION_ACCESS_DENIED`. **Changement délibéré** de la règle 1-3A
  pour les seuls membres actifs (ils connaissent déjà l'organisation) ;
  6 assertions e2e existantes mises à jour en conséquence.
- Temps réel : sockets de l'organisation fermées immédiatement dans le
  processus qui applique la suspension ; ailleurs, relecture périodique de
  l'adhésion (`SOCKET_MEMBERSHIP_RECHECK_SECONDS`, 60 s par défaut) ;
  reconnexion refusée au handshake.
- Connexion : propriétaire → refus `ORGANIZATION_SUSPENDED` avec le message
  et aucun jeton ; l'interface affiche l'espace limité (statut, message,
  assistance `/contact`). Vendeur ou administrateur → même statut sans le
  message. Plusieurs commerces → choix explicite, les commerces suspendus
  listés à part ; les autres restent accessibles.
- Conservés : données, ventes, membres et droits, périodes d'abonnement.
- URL d'images déjà signées : valables jusqu'à leur échéance (900 s par
  défaut, `S3_SIGNED_URL_TTL_SECONDS`) ; aucune nouvelle n'est émise.

**Paiements** : la création d'un paiement exige le contexte du commerce
(refusée). Le webhook SasPay et le rapprochement ne lisent pas le statut du
commerce : un paiement déjà engagé est encore enregistré et accorde sa
période, **sans réactiver** le commerce (testé avec l'appel de service de la
confirmation). Le signal temps réel « abonnement modifié » est ignoré pour un
commerce inactif (comportement existant).

**Hors ligne** :

- Refus `ORGANIZATION_SUSPENDED` à l'envoi : la vente reste `pending` (même
  identifiant, même contenu), la partition **de ce commerce et de cet
  utilisateur** est bloquée avec la raison `suspended` ; jamais un conflit,
  jamais un abandon. Les autres commerces continuent.
- Levée : même signal explicite que l'abonnement (contexte relu, saisie
  autorisée), donc après réactivation, sans reconnexion.
- La capacité de saisie hors ligne est retirée et les pages métier sont
  fermées à la lecture du refus.
- **Limite** : un appareil déjà hors ligne peut encore afficher les données
  qu'il a en mémoire (catalogue hors ligne) et ne reçoit la suspension qu'à
  sa prochaine connexion. Rien n'est effacé à distance.

**Réactivation** : capacité `platform.organizations.suspend`, motif, preuve
liée. Retire uniquement la suspension (`status = active`,
`suspension = null`) ; ne prolonge pas l'abonnement, ne réactive pas un
membre désactivé (testé).

## 5. Prolongation offerte

1 à 90 jours de 24 h, motif obligatoire, capacité
`platform.subscriptions.extend`. Calcul (`planOfferedExtension`, heure
serveur) :

| Situation | Début |
|---|---|
| Une période couvre maintenant | Fin de la couverture **continue** (après les périodes futures jointives, conservées telles quelles) |
| Aucune période en cours ni programmée (essai ou abonnement expiré) | Maintenant |
| Période programmée sans couverture en cours | **Refus** (début ambigu) |
| Interruption entre la couverture et une période future | **Refus** (jamais de réécriture) |

L'aperçu (`GET organizations/:id/extension-preview?days=N`) présente l'état,
les dates résultantes et les périodes programmées conservées. La fin de
couverture affichée fait partie du contenu confirmé : si elle a changé à
l'application (autre administrateur, paiement confirmé), refus 409
`PLATFORM_ADMIN_STATE_CHANGED`, sans double prolongation.

**Trace** : une période `kind: subscription`, `source: offered`,
`term: null`, `offeredDays`, référence `offered:<identifiant d'opération>`,
au rang suivant de la chaîne. Aucun paiement, reçu, revenu ni événement
prestataire ; paiements existants, suspension, quotas et forfait inchangés.
Le commerce voit « Prolongation offerte par Stock Master » (champ `offered`
de son historique, aucune autre donnée interne). Classe `offered` dans la
vue d'ensemble, jamais comptée dans les revenus. Aucune annulation ni
suppression de période dans ce lot.

**Concurrence** : `SubscriptionsService.runInGrantTransaction` (existant).
Deux attributions simultanées (prolongations, paiement confirmé) entrent en
collision sur l'index unique `{ organizationId, sequence }` ; la transaction
perdante est rejouée et relit la couverture. Testé : deux administrateurs →
un succès, un 409 ; prolongation contre confirmation de paiement → périodes
jointives, jamais superposées. L'espace d'administration reste fermé si ces
index manquent.

## 6. Idempotence, transactions, audit

- Chaque action porte un identifiant d'opération (UUID v4, généré par
  l'interface, un par contenu).
- Même identifiant et même contenu → résultat existant (`replayed: true`),
  **avant** toute exigence de preuve : une réponse réseau perdue se rejoue
  sans nouvelle confirmation et sans second effet. Contenu différent → 409
  `PLATFORM_ADMIN_OPERATION_CONFLICT`. Requêtes identiques simultanées : un
  seul effet, l'autre reçoit le résultat.
- Une transaction MongoDB lie : mutation (organisation ou période),
  consommation de la preuve, opération (`platform_admin_operations`) et
  audit (acteur, capacité, organisation, motif, avant/après, date serveur,
  identifiant d'opération ; aucun secret ni code).
- Refus audités hors transaction (`denied` : capacité, preuve, état changé).
- Effets hors base après validation, au mieux : fermeture des sockets,
  signal « abonnement modifié ». Leur échec n'annule pas l'action.
- Notifications : pas de nouveau type de notification dans ce lot. Le
  circuit existant impose une catégorie push, ses préférences et ses textes,
  et un commerce suspendu ne peut plus lire les notifications de ce
  commerce. Le propriétaire voit le message sur l'écran de suspension et la
  prolongation dans son historique d'abonnement.

## 7. Interface

Fiche organisation : suspension en cours (motif interne en cadre pointillé,
message au commerce en cadre coloré), boutons selon les capacités de la
session (affichage seulement ; l'API décide), historique des 20 dernières
actions. Fenêtre `layout="form"` (en-tête et pied fixes, corps défilant) :
état courant, conséquences, formulaire, récapitulatif, preuve, résultat ;
gestion de l'opération concurrente (409), de la preuve expirée et de la
réponse perdue (« Réessayer (même opération) »). Textes FR/EN (espaces
`admin`, `organization`, `sales`, `subscription`).

## 8. Migrations et retour arrière

- `create-platform-admin-indexes.js` (déjà dans `PREDEPLOY_MIGRATIONS`)
  crée en plus `platform_admin_operations.organizationId_1_createdAt_-1`.
  Idempotente. Tant qu'il manque, l'espace reste fermé (503).
- Aucune migration de données. Aucune capacité accordée automatiquement :
  les autorisations existantes restent en lecture seule.
- Schémas : `Organization.suspension` (facultatif), période
  `source: offered` + `offeredDays` (facultatif). Les documents existants ne
  changent pas.
- **Retour arrière** : redéployer la version précédente (`b0a42cd`,
  premier lot). **Vérifié** en exécutant le code de cette version (arbre de
  travail temporaire, base éphémère) sur des documents écrits sous la forme
  exacte du lot 2 :

  | Contrôle (code de `b0a42cd`) | Résultat |
  |---|---|
  | Commerce couvert par une période offerte (essai terminé) : contexte, produits, connexion | Accès ouvert (`applicationAccess: true`) |
  | Page abonnement du commerce (`GET organizations/current/subscription`) | 200, période lisible (`term: null`) |
  | Paiement confirmé puis attribution manuelle après une période offerte | Rangs 3 et 4, à la suite de la période offerte, sans chevauchement |
  | Administration du premier lot : vue d'ensemble et fiche | Lisibles ; période offerte classée `manual` |
  | Commerce suspendu par le lot 2 | Refus uniforme `ORGANIZATION_ACCESS_DENIED`, motif interne absent ; après remise à `active` par l'opérateur, l'écriture de l'organisation (image de marque) fonctionne malgré le champ `suspension` résiduel |

  Recherche dans le code de `b0a42cd` : aucune mise à jour, sauvegarde ni
  validation d'une période existante. La règle plus stricte de l'ancien
  schéma (`term` requis, sources sans `offered`) ne s'applique donc qu'aux
  nouvelles écritures, qui n'en portent jamais.

  Effets visibles après retour arrière :

  - le commerce voit une période offerte comme « Abonnement — » (durée
    vide) au lieu de « Prolongation offerte » ;
  - l'administration la classe « Manuel » ;
  - plus aucune action ni réactivation depuis l'interface : un commerce
    suspendu reste refusé, à réactiver **avant** le retour arrière (ou par
    écriture opérateur `status: active`, `suspension: null`) ;
  - l'ancien code ignore `platform_admin_operations`, `capabilities`,
    `offeredDays` et `Organization.suspension`.

## 9. Décisions de production (23 octobre 2026)

- Un seul administrateur (l'exploitant) ; une seule instance API sur
  Railway.
- Capacités : le compte de l'exploitant reçoit les trois capacités par la
  commande opérateur ; tout futur administrateur reste en lecture seule
  tant qu'aucune capacité ne lui est accordée.
- Pas de validation à deux. Chaque action garde mot de passe + second
  facteur, motif obligatoire et audit.
- Refus explicite « commerce suspendu » validé pour les membres actifs ;
  motif interne confidentiel ; refus neutre pour les tiers.
- Temps réel : avec une instance, la fermeture immédiate suffit ; le
  contrôle périodique de 60 s est conservé pour un passage à plusieurs
  instances.
- E-mail au propriétaire : lot séparé.
- Configuration de production faite par l'exploitant (§ 10). Aucune
  modification de production dans ce lot.

## 10. En-tête de l'adresse client sur Vercel

Variable **serveur** du projet web (Vercel → Settings → Environment
Variables), avec les autres variables `PLATFORM_ADMIN_*` :

```
PLATFORM_ADMIN_CLIENT_IP_HEADER=x-real-ip
```

- Valeurs acceptées : `x-real-ip` ou `x-vercel-forwarded-for`. Toute autre
  valeur ferme l'espace (503). `x-forwarded-for` est refusé : une valeur
  envoyée par le client peut y subsister derrière d'autres proxys.
- Lue à l'exécution (pas au build) : redéployer pour l'appliquer.
- À ne déclarer en Production **qu'après** les deux vérifications
  ci-dessous sur un déploiement de test. Sans déclaration, l'espace
  fonctionne avec les seuls plafonds par compte.

Un refus 429 ne prouve pas à lui seul quelle adresse le BFF a reçue (il
peut venir d'un autre plafond, d'une adresse commune à plusieurs clients,
ou d'un état antérieur de la fenêtre). Les deux vérifications sont donc
séparées : d'abord l'adresse effectivement reçue, puis le plafond par
adresse.

### 10.1 Environnement de test

- Déploiement Vercel **Preview** (ou projet de test) relié à une API de
  **test** (environnement Railway distinct, base distincte), jamais à
  l'API ni à la base de production.
- Variables de test propres à cet environnement : `JWT_SECRET`, clés
  `PLATFORM_ADMIN_MFA_KEYS`, `PLATFORM_ADMIN_PROXY_SECRET`, générées
  localement (§ 5 de `platform-admin-mfa.md`) ; aucune valeur de
  production. `PLATFORM_ADMIN_ALLOWED_ORIGIN` = origine exacte du
  déploiement de test ; `PLATFORM_ADMIN_CLIENT_IP_HEADER=x-real-ip` sur cet
  environnement seulement.
- Index créés par `migrate:predeploy` sur la base de test.
- Protection des déploiements Vercel : si elle est active, passer par le
  navigateur connecté au compte Vercel, ou par le jeton de contournement,
  fourni dans une variable de session et jamais écrit dans un fichier,
  l'historique du shell ou un ticket.
- Aucune route de diagnostic n'est ajoutée : la vérification lit l'audit
  existant, qui ne contient que l'**empreinte HMAC** de l'adresse reçue
  (`clientKeyHash`), jamais l'adresse en clair ni un secret.

### 10.2 Adresse effectivement reçue par le BFF

Chaque connexion d'administration refusée écrit une entrée d'audit
`login_password` (résultat `failure`, détail `credentials`) portant
`clientKeyHash` = `platform-admin-client:` + HMAC-SHA256(`JWT_SECRET`,
`rate-limit\0platform-admin-client\0<adresse>`), où `<adresse>` est
l'adresse relayée par le BFF (IPv4 telle quelle, IPv6 réduite à son /64),
ou `unattributed` si aucune adresse n'a été relayée.

1. Noter son adresse publique (IPv4) depuis le poste de test.
2. Envoyer **trois** connexions refusées vers le déploiement de test, avec
   des adresses e-mail inexistantes **différentes** (aucun plafond par
   compte n'est approché) : sans en-tête forgé, puis avec deux valeurs
   `X-Real-IP` forgées.

   ```bash
   T=https://<deploiement-de-test>
   for forged in none 198.51.100.7 203.0.113.9; do
     extra=(); [ "$forged" != none ] && extra=(-H "x-real-ip: $forged")
     curl -s -o /dev/null -w "%{http_code}\n" \
       -H "x-stockmaster-admin: 1" -H "origin: $T" \
       -H "content-type: application/json" "${extra[@]}" \
       -d "{\"email\":\"ip-check-$RANDOM@example.invalid\",\"password\":\"x\"}" \
       "$T/api/admin/auth/login"
   done
   ```

   Attendu : `401` trois fois.
3. Lire les trois dernières entrées dans la base **de test** (projection
   limitée, aucune autre donnée) :

   ```js
   db.platform_admin_audit
     .find({ action: "login_password", detail: "credentials" },
           { _id: 0, at: 1, clientKeyHash: 1 })
     .sort({ at: -1 }).limit(3)
   ```

4. Calculer l'empreinte attendue de son adresse, sur le poste, avec le
   `JWT_SECRET` **de test** lu sans écho, sans l'écrire nulle part :

   ```bash
   read -rs JWT_SECRET_TEST && export JWT_SECRET_TEST
   node -e '
     const ip = process.argv[1];
     const h = require("crypto").createHmac("sha256", process.env.JWT_SECRET_TEST)
       .update(`rate-limit\0platform-admin-client\0${ip}`).digest("hex");
     console.log(`platform-admin-client:${h}`);' "<votre IPv4 publique>"
   unset JWT_SECRET_TEST
   ```

Conclusion :

| Constat | Signification | Suite |
|---|---|---|
| Les trois empreintes sont identiques **et** égales à l'empreinte calculée | Le BFF reçoit votre adresse réelle ; les valeurs forgées sont remplacées | Vérification 10.3 |
| Les trois empreintes diffèrent | L'en-tête forgé atteint le BFF | **Ne pas** déclarer l'en-tête en production |
| Identiques mais différentes de l'empreinte calculée | Adresse commune (proxy, IPv6 réelle, autre adresse sortante) | Ne pas déclarer ; refaire depuis un autre réseau (téléphone en 4G) : l'empreinte doit changer avec le réseau |
| `platform-admin-client:` suivi de l'empreinte de `unattributed` | Aucun en-tête relayé (variable absente ou mal écrite) | Corriger la configuration du test |

Si l'accès sortant est en IPv6, calculer l'empreinte avec le préfixe /64
au format de l'API (`2001:db8:1:2::/64`, groupes sans zéros de tête).

### 10.3 Plafond par adresse, séparé du plafond par compte

Plafond par adresse : 20 tentatives de connexion d'administration par
fenêtre fixe de 15 minutes (les succès ne comptent pas). Plafond par
compte : par adresse e-mail normalisée (10 échecs par défaut), qui ne
s'applique donc pas si chaque essai utilise une adresse **différente**.

1. Attendre la fin de toute fenêtre ouverte par 10.2 (15 minutes), ou
   faire 10.3 depuis un autre réseau.
2. Depuis **un** réseau, sans en-tête forgé, 21 connexions refusées, chacune
   avec une adresse e-mail inexistante distincte :

   ```bash
   T=https://<deploiement-de-test>
   for i in $(seq 1 21); do
     curl -s -o /dev/null -w "%{http_code} " \
       -H "x-stockmaster-admin: 1" -H "origin: $T" \
       -H "content-type: application/json" \
       -d "{\"email\":\"ip-cap-$i-$RANDOM@example.invalid\",\"password\":\"x\"}" \
       "$T/api/admin/auth/login"
   done; echo
   ```

   Attendu : vingt `401`, puis `429` au 21ᵉ essai, avec le code
   `PLATFORM_ADMIN_RATE_LIMITED` et un en-tête `Retry-After`. Comme chaque
   adresse e-mail n'est utilisée qu'une fois, ce refus vient du seul
   plafond par adresse.
3. Audit de test : une entrée `login_password` en résultat `denied`, détail
   `rate_limited`, avec la même empreinte qu'en 10.2.
4. Immédiatement après, **depuis un autre réseau**, une connexion refusée
   doit répondre `401` et non `429` : le plafond est bien par adresse, pas
   commun à tous les clients du BFF.
5. Ne pas tenter de vraie connexion d'administration depuis l'adresse
   bloquée avant la fin de la fenêtre (15 minutes).

Une fois 10.2 et 10.3 conformes : déclarer
`PLATFORM_ADMIN_CLIENT_IP_HEADER=x-real-ip` en Production, puis
redéployer. Supprimer ensuite les comptes, clés et secrets propres au
déploiement de test s'ils ne servent plus.

## 11. Contrôles et limites

### Contrôles exécutés (23 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `jest` API (unitaires, dont calcul de prolongation, contenu confirmé, capacités, commande) | 108 suites, 1999 tests OK |
| `test/platform-admin-actions.e2e-spec.ts` (nouveau) + `platform-admin.e2e-spec.ts` | 17 + 31 OK, deux exécutions consécutives |
| Suites e2e touchées par le refus distinct (`app`, `auth-context`, `auth-organizations`, `organization-branding`, `organization-support`, `subscription-access`) + `internal-authorization`, `invitations`, `membership-management`, `multitenant-isolation`, `product-field-permissions`, `socket` | toutes OK après mise à jour de 6 assertions |
| Builds API et web, ESLint (0 erreur), `test:i18n`, `i18n:coverage` | OK |
| `test:admin-bff`, `test:organization-suspension` (nouveau), `test:security-headers`, `test:push-reconnect` | OK |
| Recette isolée : `platform-admin-flow` (lot 1) et `platform-admin-actions-flow` (nouveau, 23 étapes par le serveur web) | OK |
| Finalisation : déconnexion en échec (§ 1.1), recette + Chrome | Requête interrompue, réponse perdue, API arrêtée : OK |
| Finalisation : retour arrière (§ 8), code de `b0a42cd` sur données du lot 2 | 5 contrôles OK |
| Contrôle visuel en recette (Chrome sans interface, Playwright local) : enrôlement, vue d'ensemble, fiche, fenêtres de suspension / prolongation / réactivation, audit, écran du commerce suspendu ; mobile 390 px et ordinateur 1280 px, FR et EN, clair et sombre | 17 captures relues, aucune erreur de page |

Non vérifié : vrais téléphones (iOS Safari, Android Chrome), clavier
virtuel réel, lecteur d'écran ; écran de suspension dans le shell `/app`
pendant une session ouverte (testé par l'API et par lecture du code, pas en
capture) ; comportement derrière Vercel et Railway.

Limites :

- Fermeture immédiate des sockets dans le processus de l'API (une seule
  instance en production) ; contrôle périodique de 60 s conservé pour
  plusieurs instances.
- Images déjà signées valables jusqu'à leur échéance ; données déjà
  affichées hors ligne non effacées.
- Pas de notification au propriétaire (voir § 6) ; e-mail : lot séparé.
- Déconnexion hors ligne : session ouverte jusqu'à la relance ou
  l'expiration (§ 1.1).
- Audit non inviolable face à un accès direct à la base.
