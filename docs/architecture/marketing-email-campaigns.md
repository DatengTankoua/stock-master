# Campagnes promotionnelles par e-mail

> Aucune campagne réelle, aucun e-mail réel : faux transport en test,
> fichier local en recette. Railway, Vercel, Resend et les données de
> production ne sont pas touchés.

## 0. Base

- Branche `feature/marketing-email-campaigns`, créée depuis `origin/dev`
  à jour (`eddb68c`, qui contient le lot « consentement marketing et
  archivage »). Arbre propre au départ : aucun reset ni stash.
- Documentation lue avant le code : `marketing-consent-message-archive.md`,
  `platform-admin-communications.md`.
- Textes juridiques : le propriétaire a confirmé que les CGU 0.4 et la
  confidentialité 0.7 n'ont **jamais été publiées**. Elles ont été
  complétées sous le même numéro et réarchivées (§ 6). Les archives
  publiées (CGU 0.3, confidentialité 0.3 à 0.6, etc.) sont intactes.

## 1. Comportement livré

### 1.1 Espace « Campagnes e-mail » (administration)

| Fonction | Détail |
|---|---|
| Liste | Paginée (10), filtre Actives / Archivées / Toutes avec compteurs |
| Brouillon | Sujet (≤ 150, une ligne), contenu en texte simple (≤ 10 000), ciblage « tous les commerces » ou sélection explicite (≤ 200, recherche par nom). Révision incrémentée à chaque enregistrement ; une révision périmée est refusée (409) |
| Aperçu | E-mail exact (sujet et version texte) dans la langue choisie, lien de désabonnement d'exemple |
| Estimation | Nombre de destinataires à l'instant ; affichée comme estimation, jamais comme autorisation |
| Lancement | Contenu, ciblage, estimation, rappel de la revérification, avertissements (interrupteur coupé, configuration incomplète), mot de passe et second facteur |
| Suivi | Audience, compteurs par état, livraisons paginées (état, motif, tentatives, date) ; aucune adresse ni identité affichée |
| Archivage | Confirmation explicite : masque la campagne, n'annule aucune livraison, ne supprime rien ; restauration |

Aucun : pièce jointe, HTML libre, import d'adresses, suivi d'ouverture ou de
clic, planification, automatisation, segmentation avancée, relance manuelle.

### 1.2 Séparation des messages de service

Collections (`platform_campaigns`, `platform_campaign_deliveries`), routes
(`/platform-admin/campaigns/*`), capacités, traitement de fond et clé
d'idempotence (`marketing-campaign/…`) propres. Les messages de service
(`organizations/:id/messages`, `platform-message/…`) sont inchangés.
Réutilisés : preuve renforcée, audit, classification des échecs du
prestataire, délais de reprise, verrou et fenêtre d'incertitude.

### 1.3 Capacités

| Capacité | Permet |
|---|---|
| `platform.read` (existante) | Consulter liste, détail, aperçu, estimation, résultats |
| `platform.campaigns.manage` | Créer, modifier un brouillon, archiver, restaurer |
| `platform.campaigns.send` | Lancer (avec preuve renforcée liée) |

Espace `platform.`, jamais délégable aux commerces, jamais attribuée
automatiquement (une autorisation commence en `platform.read`). Refus
audités (`denied`, `capability`).

### 1.4 Lancement : confirmation liée et idempotence

- Intention `campaign_launch` : campagne, **révision**, sujet, contenu et
  ciblage canoniques (commerces triés, sans doublon). La preuve renforcée
  (mot de passe + second facteur, usage unique, 5 min) est liée à
  l'empreinte de cette intention et à la campagne (`boundTargetId`
  généralisé : organisation ou campagne).
- Au lancement, dans UNE transaction : preuve consommée, brouillon relu et
  comparé à l'intention (sinon 409 `STATE_CHANGED`), commerces revérifiés,
  passage à `launched`, `launchOperationId` (index unique partiel), audit
  sans sujet ni contenu (empreinte courte seulement).
- Rejeu du même identifiant d'opération (réponse perdue) : résultat
  existant, `replayed: true`, aucune seconde campagne ni livraison. Autre
  identifiant sur une campagne lancée : 409.
- Après lancement : contenu et ciblage non modifiables (409
  `CAMPAIGN_NOT_EDITABLE`).
- **Réponse perdue pendant la constitution** (réseau, ou BFF qui abandonne
  après 15 s et répond 503) :
  - le lancement est déjà validé (transaction) ; la constitution continue
    côté API ou, si le processus s'arrête, l'audience est close partielle à
    l'expiration du bail ;
  - le dialogue traite l'erreur réseau, le 503 du BFF et un 504 comme une
    réponse perdue : il conserve le même identifiant d'opération pour le
    nouvel essai ;
  - le rejeu renvoie la campagne existante (`replayed: true`) **sans
    seconde constitution** ;
  - à la fermeture après une tentative, la fiche est rechargée : statut
    « Lancée », « Audience en cours de constitution… », puis compteurs ou
    « audience partielle » (bouton « Actualiser ») ;
  - aucun envoi n'est présenté comme effectué tant qu'aucune livraison
    n'est acceptée.

### 1.5 Audience

Correction apportée après revue :
- **Problème** : la première version construisait l'audience plus tard, dans
  le traitement de fond. Seuls l'accord et l'appartenance étaient bornés par
  des dates (`changedAt`, `createdAt`) ; l'adresse vérifiée et l'état du
  commerce étaient lus au moment de cette construction.
- **Conséquence** : un utilisateur dont le commerce était suspendu au
  lancement, puis réactivé avant cette construction, pouvait être ajouté ;
  de même pour une adresse confirmée seulement après le lancement. La
  garantie annoncée n'était pas tenue.

Trois étapes distinctes désormais :

1. **Constitution progressive, à partir du lancement.** La requête de
   lancement, juste après sa transaction, parcourt les accords par pages de 200 (curseur persistant,
   une insertion par page). Il n'y a ni transaction globale, ni chargement
   intégral en mémoire.
   - Pour chaque accord, l'éligibilité **courante est évaluée au moment où
     sa page est examinée** : accord donné pour l'adresse actuelle, adresse vérifiée,
     membre actif d'un commerce actif ciblé.
   - Les bornes de date (accord et appartenance antérieurs au lancement)
     restent un complément ; elles ne tiennent pas lieu d'instantané
     d'éligibilité.
   - Une livraison par utilisateur (index unique `{campaignId, userId}`) :
     un membre de plusieurs commerces n'est retenu qu'une fois.
2. **Gel.** Après la dernière page, l'audience est close (`ready`,
   `frozenAt`) et plus personne n'est évalué ni ajouté. Si la constitution
   est interrompue (plantage pendant la requête), le traitement de fond
   **ne la poursuit pas** : à l'expiration d'un bail de 10 min
   (`leaseUntil`), il la close telle quelle (`incomplete: true`, signalé
   dans le suivi). L'audience est alors partielle, mais jamais complétée
   plus tard.
3. **Revérification avant chaque envoi** (§ 1.6). Un membre de l'audience
   devenu inéligible depuis est ignoré ; elle ne peut qu'exclure, jamais
   ajouter.

Aucune adresse libre, aucun accord donné par l'administrateur.

### 1.6 Livraison

Traitement de fond dédié (`PlatformCampaignDeliveryService`), calqué sur
celui des messages de service :

- livraisons persistantes, réservation conditionnelle et verrou de 60 s,
  reprise d'un traitement interrompu ;
- jusqu'à 5 tentatives automatiques (1, 5, 15, 60 min) ;
- **juste avant chaque tentative** : `MarketingConsentService.emailEligibility`
  (accord actuel, adresse vérifiée, commerce actif), puis ciblage. Un
  destinataire devenu inéligible est **ignoré** (motif conservé) ; un
  retrait après la préparation bloque toute tentative suivante ;
- adresse, empreinte, langue et empreinte du secret **figées au premier
  envoi**, persistées avec `firstAttemptAt` AVANT l'appel ; jamais un envoi
  à une autre adresse (`address_changed`) ;
- clé d'idempotence `marketing-campaign/<campagne>/<livraison>/<empreinte
  d'adresse>` : une adresse différente ne réutilise jamais la clé d'une
  autre ;
- garanties du lot précédent conservées : erreur après l'appel → résultat
  incertain ; une erreur définitive ultérieure ne l'efface pas ; aucun appel
  après la fenêtre de 23 h ; aucune relance ne la réinitialise ;
- états affichés exacts : en attente, en cours, accepté par le prestataire
  (jamais « reçu »), ignoré, échec, résultat incertain. Un e-mail déjà
  transmis au prestataire n'est pas présenté comme rappelable.

**Débit** : au plus 2 appels par seconde pour les campagnes, sur les
10 requêtes par seconde partagées par l'équipe Resend. Le traitement des
campagnes est séparé de celui des messages de service, dont les envois ne
sont jamais mis en file derrière une campagne. Un 429 du prestataire est
repris (refus certain et passager).

**Interrupteur** `MARKETING_EMAILS_ENABLED` (valeur exacte `true`,
désactivé par défaut), relu à chaque passe et juste avant chaque appel :
arrêté, aucun appel au prestataire, livraisons en attente (une réservation
interrompue ne compte pas comme tentative). La constitution d'audience au
lancement, le désabonnement et les messages de service continuent.

### 1.7 Désabonnement sans connexion

- **Lien visible** dans chaque e-mail (texte et HTML) :
  `${PUBLIC_APP_URL}/auth/unsubscribe?token=…`. Page publique FR/EN, sans
  session, sans cache (`no-store`), non indexée, sans référent, sans
  ressource tierce. Le jeton est lu après montage puis retiré de l'URL ; le
  chargement ne retire rien : un bouton confirme.
- **En-têtes RFC 8058** : `List-Unsubscribe: <${PUBLIC_APP_URL}/api/unsubscribe?token=…>`
  et `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. La route web
  relaie le jeton à l'API dans le corps et répond 200 vide (404 si invalide,
  503 si l'API ne répond pas). Pas de page, pas de session, pas de cookie,
  pas d'exigence CSRF. Un GET sur cette adresse redirige vers la page de
  confirmation sans rien retirer.
- **API** `POST /marketing/unsubscribe` `{ token }` (publique, `no-store`,
  `noindex`) : réponse `{ status: 'unsubscribed' }` sans donnée personnelle,
  404 générique pour un jeton inconnu. Le service de consentement applique
  le retrait dans sa transaction et sa preuve habituelles, source
  **`unsubscribe_link`**. Rejeu idempotent (aucune nouvelle preuve).
- **Ancien lien** : le jeton porte l'empreinte de l'adresse ; il ne retire
  l'accord que s'il a été donné pour cette adresse. Un lien envoyé à une
  ancienne adresse n'agit pas sur l'accord donné pour la nouvelle.
- Aucun lien d'activation ou de réinscription. Le réglage dans
  l'application est conservé. Ni les e-mails de service ni l'abonnement
  payant ne sont touchés.

## 2. Choix techniques

### 2.1 Jeton stable sans jeton stocké

Contrainte : une reprise doit renvoyer exactement le même e-mail (même clé
d'idempotence chez le prestataire), donc le même lien, alors que seul le
haché du jeton est stocké.

Choix : le jeton est **dérivé**, pas tiré au hasard puis conservé :

```
jeton = base64url(HMAC-SHA256(MARKETING_UNSUBSCRIBE_SECRET,
                              "stockmaster:marketing-unsubscribe:v1|<livraison>|<empreinte d'adresse>"))
```

- 256 bits, non devinable sans le secret ;
- recalculé à l'identique à chaque reprise ; jamais écrit en base ni dans
  un journal ;
- `sha256(jeton)` enregistré dans `marketing_unsubscribe_tokens`
  (utilisateur, empreinte d'adresse, finalité, langue, campagne,
  livraison) **avant** l'appel au prestataire ;
- la validation compare ce haché : elle ne dépend pas du secret. Une
  rotation ne casse aucun lien déjà envoyé.

**Gestion du secret** : `MARKETING_UNSUBSCRIBE_SECRET`, au moins 32 octets
aléatoires (base64url), variable du service API uniquement. Absent ou
invalide : aucune campagne n'est envoyée. L'empreinte courte du secret est
figée avec la livraison ; une reprise après rotation n'est jamais envoyée
(`unsubscribe_key_changed`, l'incertitude éventuelle conservée). Changer le
secret seulement sans livraison en cours ou en reprise.

### 2.2 Autres choix

- Lancement idempotent par `launchOperationId` dans la campagne (index
  unique partiel) plutôt que dans `platform_admin_operations`, dont le
  format est lié à une organisation.
- L'outil d'index de l'administration accepte désormais les index partiels
  (comparaison et création).
- Expéditeur Resend : en-têtes facultatifs (`headers`), noms simples et
  valeurs sans retour à la ligne, sinon refus avant tout appel.
- Le jeton n'apparaît jamais dans l'URL de l'API. Il figure dans l'URL web
  du lien et de la route en un clic (imposé par RFC 8058) : les journaux
  d'accès de l'hébergeur web peuvent le contenir (§ 4).

## 3. Contrôles réellement exécutés

| Contrôle | Résultat |
|---|---|
| E2E `marketing-campaigns` (nouveau) | 17/17 (dont 4 tests ajoutés après revue) |
| Unitaires (jeton, gabarit, clé, interrupteur, configuration, en-têtes, intention) et modules liés | 201/201 |
| E2E de régression (6 suites) | 131/131 |
| Typage API et web, lint (fichiers modifiés) | 0 erreur |
| i18n (`check-i18n`, `i18n-coverage --fail`) | 0 problème |
| BFF (`test-admin-bff.mjs`, routes des campagnes) | 16/16 |
| Build web isolé + réarchivage juridique (`write`, `check`) | exit 0 |
| Recette navigateur (FR/EN, mobile et ordinateur) | 23/23, 10 captures |

Tests ajoutés après revue :
- commerce suspendu au lancement puis réactivé, et adresse confirmée après
  le lancement : jamais ajoutés, audience gelée inchangée ;
- constitution interrompue : rien n'est ajouté par la suite, audience close
  partielle à l'expiration du bail ;
- réponse perdue pendant la constitution : rejeu du même identifiant sans
  seconde constitution, campagne retrouvée (« Lancée », audience en
  constitution), aucune livraison ajoutée par le traitement de fond, puis
  audience partielle ; compteurs tous à zéro, aucun envoi présenté comme
  effectué ;
- lien déjà émis : désabonnement valide après rotation du secret, avec
  `MARKETING_EMAILS_ENABLED=false`, puis sans secret du tout. La validation
  passe par l'empreinte enregistrée.

Couverture e2e :
- **capacités** : lecture seule, gestion seule, envoi seul ;
- **preuve liée** : contenu modifié présenté avec la preuve, brouillon modifié
  après confirmation, ancienne révision ;
- **lancement rejoué**, autre identifiant d'opération, contenu figé ;
- **audience** : membre de deux commerces reçu une fois ; ciblage
  sélectionné ; exclusion de l'absence d'accord, de l'adresse non vérifiée,
  du commerce suspendu et de l'accord donné après le lancement ;
- **contenu de l'e-mail** : texte échappé, lien visible, en-têtes RFC 8058,
  clé liée à l'adresse, seul le haché du jeton stocké ;
- **reprises** :
  - retrait entre préparation et traitement : aucun appel ;
  - reprises identiques (même clé, même destinataire, même contenu) ;
  - incertitude conservée après un refus 422 ;
  - fenêtre expirée : aucun nouvel appel ;
  - changement d'adresse : aucun envoi à la nouvelle ;
- **interrupteur coupé** : aucun appel, désabonnement possible ;
- **archivage** sans effet sur les livraisons ; résultats sans adresse ;
- **désabonnement** :
  - GET sans effet, POST valide, rejeu sans nouvelle preuve ;
  - source `unsubscribe_link` ;
  - jetons invalides refusés ;
  - connexion intacte ;
  - plus d'envoi ensuite ;
  - ancien lien sans effet sur la nouvelle adresse.

### 3.1 Régression

Suites relancées parce qu'elles touchent des briques modifiées : la preuve
renforcée (cible généralisée), les index de l'administration, le service
de consentement (retrait par jeton), les textes juridiques réarchivés et
l'expéditeur (en-têtes). Résultat : 131/131.

- `marketing-consent` ;
- `platform-admin-communications` (messages de service inchangés) ;
- `platform-admin-actions` ;
- `platform-admin` ;
- `legal-acceptance` ;
- `email-verification`.

### 3.2 Recette navigateur

Pile isolée `recipe.js start --platform-admin --anti-bot=simulated` : base
locale, e-mails écrits dans `mail.jsonl`, secret de désabonnement fictif.
Les capacités ont été accordées au compte de recette par la commande
opérateur, sur la base locale seulement. La pile a été arrêtée ensuite.

Parcours :
- **réglages** (mobile FR) : accord donné par le propriétaire ;
- **ordinateur FR** : brouillon, aperçu (texte échappé visible tel quel),
  estimation, confirmation avec mot de passe et code, lancement, e-mail
  consigné avec les en-têtes RFC 8058, suivi « accepté par le
  prestataire », aucune adresse affichée ;
- **mobile EN** : GET de l'adresse en un clic (303, aucun retrait), page de
  désabonnement (jeton retiré de l'URL), confirmation, accord retiré
  constaté dans les réglages ;
- **seconde campagne** : nouvel accord, puis POST en un clic sur la route
  web (200 vide, `no-store`), accord retiré ;
- **mobile EN** : liste, archivage confirmé, campagne masquée de la liste
  principale.

Aucun défilement horizontal, aucune erreur de page. Captures :
`scratchpad/captures-campaigns/` (hors dépôt).

## 4. Limites

- **Simulé** : prestataire (faux transport en test, `mail.jsonl` en
  recette), secret et clés fictifs. Aucun appel réel à Resend : le format
  `headers` et le comportement de Gmail ou Yahoo face au POST en un clic
  n'ont pas été vérifiés en conditions réelles.
- Journaux d'accès de l'hébergeur web (Vercel) : l'URL du lien et de la
  route en un clic contient le jeton. Un jeton ne permet que le retrait de
  l'accord concerné ; il n'expose aucune donnée.
- `POST /marketing/unsubscribe` n'a pas de limitation de débit dédiée. Les
  jetons sont non devinables (256 bits) et un essai ne révèle rien.
- Estimation, et constitution de l'audience pendant la requête de
  lancement : parcours complet des accords, page par page. La durée de la
  requête croît avec le nombre d'accords (adapté à une petite plateforme).
  Au-delà du bail de 10 min, l'audience est close partielle.
- L'éligibilité évaluée pendant la constitution reflète l'état de chaque
  compte au moment où sa page est examinée (quelques secondes après le
  lancement). Ce n'est pas un instantané transactionnel de toute la base.
- Pas de relance manuelle : une livraison en échec ou incertaine reste
  ainsi.
- Une instance API (comme les messages de service) : débit et verrou
  pensés pour un seul traitement de fond.
- Durées de conservation (suivi des envois, jetons hachés) non fixées :
  rien n'est supprimé automatiquement.

## 5. Ce que vous devrez appliquer vous-même

1. **Ordre** : pré-déploiement (index) → API → web. Le web ne publie les
   routes de campagne et `/api/unsubscribe` qu'avec la nouvelle API.
2. **Pré-déploiement** (existant, idempotent) : `create-platform-admin-indexes.js`
   crée les index des campagnes, `create-marketing-consent-indexes.js` la
   collection des jetons. Aucune migration ne donne d'accord, n'attribue de
   capacité ni ne lance de campagne. Sans ces index, l'espace
   d'administration répond 503.
3. **Variables du service API** (Railway) :
   - `MARKETING_UNSUBSCRIBE_SECRET` : générer une valeur (`node -e
     "console.log(require('crypto').randomBytes(32).toString('base64url'))"`),
     la garder secrète ;
   - `MARKETING_EMAILS_ENABLED=true` seulement au moment d'envoyer ;
     `false` ou absente sinon ;
   - `PUBLIC_APP_URL` (existante) doit être l'origine publique du web.
4. **Web** (Vercel) : aucune variable nouvelle ; `NEXT_PUBLIC_API_URL`
   (existante) sert à la route `/api/unsubscribe`.
5. **Capacités** (commande opérateur, d'abord sans `--apply`) :
   ```
   node /app/api/dist/migrations/platform-admin-cli.js capability-add --user-id=<id> --capability=platform.campaigns.manage --reason="<motif>" --operator=<opérateur> --apply
   node /app/api/dist/migrations/platform-admin-cli.js capability-add --user-id=<id> --capability=platform.campaigns.send --reason="<motif>" --operator=<opérateur> --apply
   ```
6. **Resend** : domaine d'envoi vérifié (existant) ; volumes au-delà de
   10 req/s à demander au support Resend si nécessaire.
7. **Textes juridiques** : publier CGU 0.4 et confidentialité 0.7 à la date
   effective (provisoire : 28 octobre 2026 ; sinon changer la date et
   réarchiver AVANT publication) ; durées de conservation à décider.
8. **Retour arrière.** Dès le premier e-mail réel, les liens déjà
   envoyés doivent continuer à fonctionner sans connexion.
   - **Arrêter les campagnes** : passer `MARKETING_EMAILS_ENABLED=false` en
     **gardant la version déployée**. Aucun nouvel appel au prestataire ;
     le désabonnement, la page publique et la route en un clic restent en
     service. C'est la procédure de retour arrière par défaut.
   - **Secret** : ne pas le supprimer et ne pas le révoquer pour
     « désactiver ». Les liens déjà émis sont validés par l'empreinte
     enregistrée (`marketing_unsubscribe_tokens`), pas par le secret. Une
     rotation ou une absence de secret n'empêche donc pas le désabonnement
     (testé) ; elle bloque seulement les reprises d'envoi.
   - **Corriger une autre fonction** : de préférence par un correctif sur la
     version actuelle.
   - **Ne jamais déployer** une version qui supprime les routes de
     désabonnement, sauf à les maintenir explicitement avec leur traitement :
     - `POST /marketing/unsubscribe` et le retrait par jeton du service de
       consentement (API) ;
     - `/auth/unsubscribe` et `/api/unsubscribe` (web) ;
     - les collections `marketing_unsubscribe_tokens`,
       `marketing_consents` et `marketing_consent_events`.

     En pratique : aucun retour à un commit antérieur à ce lot.
   - **Ne jamais redéployer** un expéditeur de campagnes qui ignorerait les
     retraits.
   - Collections et index ajoutés restent en place.
