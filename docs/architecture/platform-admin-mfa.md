# Administration de la plateforme avec double authentification

Branche : `feature/platform-admin-mfa` (depuis `origin/dev`).

> Section 1 : plan écrit avant l'implémentation. Les sections suivantes
> forment le rapport du lot.

## 1. Plan

### Constat

- Le web (Vercel) appelle l'API (Railway, autre origine) avec un JWT Bearer
  conservé côté navigateur ; le CORS de l'API est sans `credentials`.
- La connexion d'un commerce exige une organisation active : un
  administrateur de plateforme ne doit pas en dépendre.
- `AuthService.verifyCredentials` porte déjà les plafonds persistants par
  compte (MongoDB, partagés entre instances) et le défi Turnstile.
- `User.role = admin` est un rôle historique : il n'est pas une preuve.

### Choix

1. **Autorisation séparée.** Collection `platform_admin_grants` (une entrée
   par utilisateur, `active` ou `revoked`). Aucun champ de `User`, aucune
   permission délégable, aucune route HTTP ne l'écrit. Seule la commande
   opérateur `platform-admin` l'accorde ou la révoque (lecture seule par
   défaut, `--apply`, motif obligatoire, audit).
2. **Session administrative distincte**, opaque, stockée hachée
   (`platform_admin_sessions`), relue à chaque requête : autorisation active,
   compte vérifié, version de session du compte (`authVersion`), facteur
   courant, inactivité et expiration absolue.
3. **BFF de même origine.** Route serveur Next.js `/api/admin/*` : cookie
   `HttpOnly`, `Secure` en production, `SameSite=Strict`, contrôle d'origine
   et en-tête dédié contre le CSRF. L'API n'accepte les routes
   `/platform-admin/*` que du BFF (secret partagé distinct) ; le CORS de
   l'API est inchangé. Aucun jeton administratif côté navigateur.
4. **TOTP** avec `otpauth` (RFC 6238, 6 chiffres, 30 s, ±1 pas), secret
   chiffré en AES-256-GCM avec une clé dédiée versionnée, refus du rejeu par
   le dernier pas accepté (mise à jour conditionnelle atomique). QR code
   dessiné dans le navigateur (`qrcode-generator`, aucun service externe).
5. **Challenges** courts (5 min), liés à l'utilisateur, à la session et à
   leur usage, consommés atomiquement ; tentatives plafonnées par challenge,
   par compte et par IP (compteurs MongoDB existants).
6. **Codes de récupération** : 10 codes aléatoires de 80 bits, affichés une
   fois, conservés hachés, consommés atomiquement.
7. **Données en lecture seule** : vue d'ensemble, organisations, fiche,
   paiements, audit ; projections explicites, pages bornées.
8. **Audit** dans `platform_admin_audit`, en ajout seul.
9. **Désactivé par défaut** : sans `PLATFORM_ADMIN_ENABLED=true` et une
   configuration valide (clés, secret du BFF), les routes répondent 503 ;
   les commerces ne sont pas affectés.

### Hors périmètre

Suspension, suppression, quotas, prolongation, validation de paiement,
export global, connexion à la place d'un client.

## 2. Architecture et séparation des autorisations

```
Navigateur ──(cookie HttpOnly, même origine)──▶ Next.js /api/admin/* (BFF)
                                                   │ x-platform-admin-proxy (secret partagé)
                                                   │ x-platform-admin-session (jeton du cookie)
                                                   │ x-platform-admin-client-ip
                                                   ▼
                                     API NestJS /platform-admin/* (PlatformAdminGuard)
```

- **Code** : `api/src/platform-admin/` (configuration, chiffrement, TOTP,
  jetons, index, service, données, garde, contrôleur),
  `api/src/migrations/platform-admin-cli.ts`,
  `api/src/migrations/create-platform-admin-indexes.ts` ; web :
  `web/src/app/api/admin/[...path]/route.ts`, `web/src/lib/admin/`,
  `web/src/app/admin/`, `web/src/components/admin/`, espace i18n `admin`.
- **Autorisation plateforme** = un document `platform_admin_grants`
  (`active`/`revoked`, unique par utilisateur). Ce n'est ni un rôle de
  commerce, ni une permission délégable, ni un champ de `User`. `User.role`
  (historique `admin`) n'est jamais lu. Aucune route HTTP ne l'écrit :
  inscription, profil (`/auth/me/locale`), invitations et gestion des
  membres refusent tout champ inconnu (400, `forbidNonWhitelisted`) et
  n'accèdent pas à cette collection.
- **Routes `/platform-admin/*`** : `@Public()` pour les gardes des commerces
  (aucun JWT, aucune organisation, aucune permission délégable), protégées
  par `PlatformAdminGuard` avec refus par défaut (niveau `mfa` si oublié).
  Un JWT de commerce n'y ouvre rien ; l'accès plateforme n'ajoute rien aux
  routes métier (`effectivePermissions` inchangé, testé).
- **Niveaux** : `login` (BFF seul) ; `session` (statut, déconnexion) ;
  `pre-mfa` (enrôlement et challenge uniquement, aucune donnée de
  commerce) ; `mfa` (données et opérations de sécurité).
- **À chaque requête**, la garde relit : configuration et index, secret du
  BFF (comparaison à temps constant), session (empreinte SHA-256 du jeton,
  non révoquée, non expirée), compte (présent, adresse vérifiée,
  `authVersion` inchangée), autorisation active et, au niveau `mfa`, le
  facteur actif à la version validée par la session.
- **Connexion** : `AuthService.verifyCredentials` (mêmes plafonds persistants
  par compte que la connexion d'un commerce, défi Turnstile, adresse
  vérifiée) + plafond par IP propre à l'administration. Aucune organisation
  requise ; changer d'organisation dans un commerce n'a aucun effet sur la
  session administrative.

## 3. Double authentification

- **TOTP** : `otpauth` 9.5.2 (RFC 6238 ; SHA-1, 6 chiffres, 30 s, secret de
  160 bits), compatible avec Google/Microsoft Authenticator, 1Password,
  Aegis… **Tolérance : ±1 pas (±30 s)** autour de l'heure serveur. Le pas
  accepté est conservé (`lastUsedStep`) : un code n'est accepté que si son
  pas est strictement postérieur (mise à jour conditionnelle, valable entre
  instances).
- **QR code** dessiné dans le navigateur (`qrcode-generator` 2.0.4, SVG
  inline, aucun service externe) + clé de saisie manuelle.
- **Enrôlement** : après le mot de passe (session `pre-mfa` de 10 min) ;
  secret en attente lié à la session ; activation seulement après un
  premier code valide ; 10 codes de récupération affichés une seule fois.
- **Challenges** (`platform_admin_challenges`) : jeton de 256 bits stocké
  haché, 5 min, lié à l'utilisateur, à la session et à l'usage (`login`,
  `enroll`, `replace`, `step_up`), 5 essais, au plus 10 challenges de
  connexion par session.
- **Atomicité** : la validation finale est UNE transaction MongoDB
  (consommation du challenge, du pas TOTP ou du code de récupération,
  passage de la session au niveau `mfa` avec rotation du jeton, audit).
  Validations concurrentes : une seule réussit (testé avec le même code et
  avec des codes de récupération différents).
- **Limites** (`rate_limit_buckets`, MongoDB, partagés entre instances) :
  20 connexions par IP / 15 min ; 5 échecs de second facteur par compte /
  15 min ; 20 par IP (ou /64) / 15 min. Les succès ne comptent pas. Le mot
  de passe garde ses plafonds 1-18C.
- **Codes de récupération** : 10 × 80 bits (base32,
  `XXXX-XXXX-XXXX-XXXX`), conservés en SHA-256 lié à l'utilisateur,
  consommés atomiquement.
- **Chiffrement des secrets** : AES-256-GCM (`node:crypto`), IV aléatoire,
  données associées = identifiant de l'utilisateur, `keyId` versionné ; clé
  dédiée, refusée si elle reprend `JWT_SECRET`.
- Aucun secret, code, jeton, QR ni code de récupération dans les journaux,
  URL ou réponses (hors affichage unique prévu) ; testé sur les réponses,
  l'audit et les collections.

## 4. Sessions et récupération

| Session | Durée |
|---|---|
| Après mot de passe, avant second facteur | 10 min, non prolongée |
| Après second facteur | 30 min d'inactivité, 8 h au plus |
| Vérification renforcée (`step-up`) | 5 min, une seule opération |

- Jeton opaque de 256 bits stocké haché ; renouvelé au passage au niveau
  `mfa` et à chaque changement de facteur.
- Cookie `__Host-sm_admin` en HTTPS : `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/` (`sm_admin` sans `Secure` hors HTTPS, en
  local). Rien dans `localStorage`, IndexedDB ou le service worker.
- **CSRF** : en-tête `x-stockmaster-admin: 1` obligatoire (une page tierce
  ne peut l'ajouter sans pré-vérification CORS, jamais servie) ;
  `Sec-Fetch-Site` same-origin s'il est présent ; `Origin` égale à
  `PLATFORM_ADMIN_ALLOWED_ORIGIN` pour tout POST. CORS de l'API inchangé :
  le navigateur n'appelle jamais l'API d'administration directement.
- **Révocation côté serveur** : déconnexion ; révocation de l'accès (relu à
  chaque requête) ; réinitialisation du mot de passe (`authVersion`) ;
  remplacement du facteur et renouvellement des codes (autres sessions
  révoquées) ; réinitialisation opérateur.
- **Mot de passe réinitialisé** : sessions administratives caduques, et la
  connexion suivante exige toujours le second facteur (testé).
- **MFA désactivée impossible** : aucune route ne retire le facteur ; seule
  la procédure opérateur le supprime, ce qui révoque toutes les sessions et
  impose un nouvel enrôlement avant toute donnée.
- **Changer de facteur ou renouveler les codes** : `step-up` (mot de passe
  + code TOTP actuel ou code de récupération) → jeton à usage unique.
- La déconnexion d'un commerce (JWT local) ne ferme pas la session
  administrative : elles sont indépendantes ; se déconnecter de `/admin`.

### Procédure opérateur : tous les facteurs perdus

1. Vérifier l'identité hors ligne (procédure interne, référence notée).
2. `platform-admin reset-mfa --user-id=<id> --reason=<motif>
   --operator=<vous> --identity-check=<référence>` (lecture seule), puis
   la même commande avec `--apply`.
3. Effet : sessions administratives révoquées, facteur et codes supprimés,
   audit `mfa_reset`. Connexion par mot de passe, puis nouvel enrôlement
   obligatoire. Aucun contournement par e-mail ou réinitialisation du mot
   de passe.

## 5. Configuration

### API (Railway)

| Variable | Rôle |
|---|---|
| `PLATFORM_ADMIN_ENABLED` | `true` exactement pour ouvrir ; sinon fermé |
| `PLATFORM_ADMIN_MFA_KEYS` | `<id>:<32 octets base64>`, séparées par des virgules |
| `PLATFORM_ADMIN_MFA_ACTIVE_KEY` | identifiant de la clé des nouveaux secrets |
| `PLATFORM_ADMIN_PROXY_SECRET` | secret partagé avec le web, 32 à 256 caractères |

### Web (Vercel, variables serveur, jamais `NEXT_PUBLIC_*`)

| Variable | Rôle |
|---|---|
| `PLATFORM_ADMIN_ENABLED` | `true` pour activer la route `/api/admin` |
| `PLATFORM_ADMIN_PROXY_SECRET` | même valeur que l'API |
| `PLATFORM_ADMIN_ALLOWED_ORIGIN` | origine exacte du web (`https://…`) |
| `PLATFORM_ADMIN_API_URL` | URL de l'API vue du serveur (défaut `NEXT_PUBLIC_API_URL`) |

Valeur absente ou invalide → espace fermé (503), journalisé au démarrage
sans la valeur ; l'API démarre, les commerces fonctionnent. HTTPS exigé en
production, sauf pile entièrement locale (recette).

Génération locale, jamais automatique ni commitée :

```bash
node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Rotation de la clé de chiffrement

1. Générer `v2`. API : `PLATFORM_ADMIN_MFA_KEYS=v1:…,v2:…` et
   `PLATFORM_ADMIN_MFA_ACTIVE_KEY=v2`, redéployer.
2. `platform-admin rotate-key --operator=<vous>` (décompte), puis
   `--apply` (rechiffre avec `v2`, audité, relançable).
3. Contrôle : relancer sans `--apply` → `factorsToRotate: 0`.
4. Retirer `v1`, redéployer. Une clé retirée trop tôt rend les facteurs
   concernés illisibles (503 pour ces comptes ; procédure `reset-mfa`).

## 6. Commande opérateur

```bash
MONGODB_URI=… pnpm --filter api platform-admin -- status --user-id=<id>
MONGODB_URI=… pnpm --filter api platform-admin -- grant  --user-id=<id> --reason="…" --operator=<vous> [--apply]
MONGODB_URI=… pnpm --filter api platform-admin -- revoke --user-id=<id> --reason="…" --operator=<vous> [--apply]
# Image de production : node /app/api/dist/migrations/platform-admin-cli.js <commande> …
```

Lecture seule sans `--apply` ; utilisateur existant désigné par son ID ;
`grant` exige une adresse vérifiée ; motif de 10 à 300 caractères ;
écriture et audit dans la même transaction ; aucun compte créé, aucun mot
de passe généré, aucun accès donné au premier utilisateur. **Non exécutée
en production par ce lot.**

## 7. Migrations et ordre de déploiement

- `create-platform-admin-indexes.js`, ajoutée à `PREDEPLOY_MIGRATIONS`
  (avant les lots et alertes) : index des 6 collections `platform_admin_*`
  et `organizations.createdAt_-1`. Idempotente, échoue sans rien écraser
  si un index homonyme diffère ; `--check` en lecture seule. N'accorde
  aucun accès.
- Sans ces index, l'espace reste fermé (503), les commerces ne sont pas
  affectés.

Ordre : (1) déploiement avec l'espace fermé (`migrate:predeploy` en
Pre-deploy Command) ; (2) clés et secret posés dans Railway et Vercel,
redéploiement ; (3) attribution par la commande à un compte vérifié ;
(4) enrôlement par l'intéressé sur `/admin/login`.

## 8. Données affichées et indicateurs

- **Classes commerciales** (heure serveur, `[startsAt, endsAt)`) : `paid`
  (période en cours = abonnement issu d'un paiement), `manual` (attribué
  par commande, pas forcément payé), `trial`, `scheduled`, `expired`,
  `none`. Un abonnement valide ne dit rien de l'activité du commerce.
- **Inscriptions récentes** : organisations créées sur 7 et 30 jours.
- **Revenus de Stock Master** : somme des `amount` des paiements
  `succeeded`, non remboursés, confirmés sur 30 jours (XAF) ; jamais les
  ventes des commerces.
- **Fiche** : identité, inscription, nom et e-mail du propriétaire, membres
  actifs par rôle, fiches produit / capacité, stockage, périodes,
  fonctionnalités effectives, 10 derniers paiements. Consultation auditée.
- **Paiements** : montant, devise, durée, période accordée, statut,
  prestataire, références ; jamais l'URL de paiement, le téléphone ni le
  contenu des notifications.
- **Jamais exposés** : catalogues, ventes, marges, mots de passe, jetons,
  secrets, clés de stockage, URL signées.
- Pages de 20, page ≤ 500, recherche ≤ 60 caractères (échappée), filtres à
  valeurs fermées, `maxTimeMS` 5 s.

## 9. Audit

`platform_admin_audit`, ajout seul : connexions, échecs et refus du second
facteur (dont rejeu), récupération, enrôlement et changements de facteur,
codes, déconnexion, sessions rejetées, attribution et révocation,
réinitialisation, rotation, consultations sensibles. Champs : date, type
d'acteur, utilisateur ou opérateur, action, résultat, cible, code court,
empreinte HMAC de l'origine réseau. Aucune route ne le modifie ni ne le
supprime. **Il ne résiste pas** à un accès direct à la base. Aucune
rétention automatique : à décider.

## 10. Contrôles et limites

### Contrôles exécutés (23 octobre 2026)

| Contrôle | Résultat |
|---|---|
| `jest` API (unitaires, dont `src/platform-admin/platform-admin.spec.ts`) | 108 suites ; tout passe après ajout des traductions d'erreur |
| `test/platform-admin.e2e-spec.ts` (`recipe.js isolated api-e2e platform-admin`) | 31/31 |
| `pnpm --filter api build` | OK |
| ESLint des fichiers touchés (API, web) | 0 erreur (avertissements `no-unsafe-argument` du même type que les e2e existants) |
| `test:i18n`, `i18n:coverage --fail` | OK (espace `admin` FR/EN) |
| `test:admin-bff` (nouveau), `test:security-headers` | 8/8, OK |
| `pnpm --filter web build` | OK (`/admin/*` et `/api/admin/[...path]` dynamiques) |
| Recette isolée `start --platform-admin` + `platform-admin-flow` | 25 étapes OK par le vrai serveur web : refus avant attribution, attribution (lecture seule puis `--apply`), enrôlement, consultation, CSRF, déconnexion, code de récupération à usage unique, révocation |

Couverture e2e : propriétaire, administrateur, vendeur et rôle historique
`admin` refusés ; aucune auto-attribution par inscription, profil ou
invitation ; mot de passe seul insuffisant ; enrôlement non confirmé, code
incorrect, challenge expiré ou d'une autre session ; plafonds par
challenge, par compte et par IP ; rejeu refusé ; validations concurrentes
(un seul succès) ; récupération à usage unique ; déconnexion, révocation
(commande et écriture directe), inactivité et échéance absolue ;
réinitialisation du mot de passe sans contournement ; renouvellement des
codes et changement de facteur ; récupération d'urgence ; projections
bornées ; audit non modifiable ; absence de secrets dans les réponses,
l'audit et les collections ; `no-store`/`noindex` ; commerces inchangés ;
espace fermé sans configuration (503) sans effet sur les commerces.

### Non vérifié

- **Aucun navigateur réel** : Playwright n'est pas installé par le dépôt.
  Le parcours de recette passe par le serveur web de production (cookies,
  en-têtes, CSRF) mais sans moteur de rendu : affichage mobile/ordinateur,
  thèmes clair/sombre, QR code scanné par une vraie application, copie des
  codes et service worker en navigation réelle restent à vérifier à la
  main (`http://127.0.0.1:3200/admin/login` en recette).
- Rien n'a été exécuté contre Railway, Vercel ou la base de production ;
  aucun accès n'a été accordé ailleurs que dans les bases éphémères.

### Limites connues

- Adresse réseau : fournie par le BFF depuis `X-Real-IP` (posé par Vercel
  et par le nginx du dépôt) ; sans cet en-tête, l'IP vue par l'API est
  celle du serveur web, et le plafond par IP devient global au BFF (les
  plafonds par compte restent exacts).
- Pas de détection d'anomalies (nouvelle IP, horaires) ni de notification
  à l'administrateur lors d'une connexion : à prévoir.
- La journalisation d'audit hors transaction (échecs) est au mieux : une
  écriture refusée est signalée dans le journal serveur, sans bloquer.
- Pas de rétention ni d'export de l'audit ; pas d'actions sur les
  commerces (lot suivant).
- Clé de chiffrement et secret du BFF dans les variables d'environnement
  des plateformes : leur protection dépend de l'accès à Railway et Vercel.
- La recette relancée plus de 4 fois en 15 minutes atteint volontairement
  le plafond d'échecs du compte (voir `platform-admin-flow.js`).
