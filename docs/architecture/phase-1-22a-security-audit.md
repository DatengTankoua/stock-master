# Lot 1-22A — Audit de sécurité (skill Cloudflare)

État : **audit terminé, aucune correction**. Le code applicatif est inchangé.
Ce document est la seule écriture du lot dans le dépôt. Les preuves et les
rapports détaillés restent hors du dépôt (§ 6).

## 1. Références

| Élément | Valeur |
|---|---|
| Code audité | `905f6949` (`feature/phase-1-21b-saspay-checkout`), arbre propre, aucune modification locale incluse |
| Branche du lot | `security/phase-1-22a-security-audit`, créée depuis `905f6949` |
| Écart avec `origin/main` | `4bb369e` contient `905f694` (merges #39, #40) ; les 8 commits d'écart sont des merges et les deux arbres sont identiques |
| Skill | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, lu depuis un clone local ; aucune installation distante |
| Workflow | Complet, 6 phases, profil `standard` |
| Agents | 4 reconnaissances, 14 chasseurs, 3 critiques de couverture, 16 vérifications indépendantes |
| Validateurs | `validate-coverage-ledger` : PASS (19 unités) ; `validate-findings` : PASS (9 enregistrements) |

Le stash existant et le fichier local non suivi `.env.prod` n'ont pas été
touchés. `.env.prod` n'a pas été lu.

## 2. Périmètre couvert

API (`api/src`), web (`web/src`, `web/public`), CI (`.github/workflows`),
Dockerfiles, `docker-compose*.yml`, `nginx/`, fichiers `.env*.example`,
scripts et CLI d'exploitation. Les 19 unités de couverture portent sur :

- **Authentification et sessions :** JWT, session limitée, révocation, récupération de compte, invitations, Turnstile, throttles, proxy de confiance.
- **Isolation des organisations :** routes métier, permissions, champs financiers, exports, corbeille.
- **Temps réel :** Socket.IO, notifications push, service worker.
- **Paiements SasPay :** création, webhook, concordance, renouvellements, reçus, rapprochement automatique, CLI opérateur avec remboursements enregistrés, registre des périodes d'abonnement.
- **Fichiers :** téléversements, Sharp, stockage privé, URL signées, quotas.
- **Ventes et hors ligne :** ventes, stock, idempotence, outbox hors ligne, cache PWA.
- **Entrées non fiables :** injections, XSS, redirections, SSRF, e-mails, PDF et XLSX.
- **Configuration :** secrets, CI/CD, configuration de production, journaux, erreurs.

## 3. Résultats

**Aucune vulnérabilité confirmée au sens du skill.** Une confirmation exige
une reproduction locale isolée (§ 5). Aucune fuite entre organisations n'a
été trouvée dans le code.

Sept pistes sont fondées sur le code et ont été vérifiées deux fois de façon
indépendante. Elles restent à valider. Le niveau entre parenthèses est une
estimation de priorité, pas une sévérité.

| Ordre | Piste | Niveau estimé | Dépend de |
|---|---|---|---|
| 1 | Sans proxy de confiance configuré, les limites anti-abus de l'authentification sont communes à tous les clients derrière l'ingress Railway. Un seul client pourrait bloquer la connexion et la récupération de compte de tous. | moyen | Variables Railway |
| 2 | En production, `JWT_SECRET` n'est contrôlé ni en longueur ni contre les valeurs d'exemple publiées. | moyen ; élevé si le secret est faible | Valeur déployée |
| 3 | Le quota d'appels SasPay est unique pour tout le processus et n'est pas réparti par organisation. Un propriétaire pourrait l'épuiser et bloquer temporairement les paiements des autres. | moyen | Réplicas, limiteur amont |
| 4 | Une invitation en attente reste acceptable après suspension ou rétrogradation de son auteur. | faible | — |
| 5 | La permission `trash.manage` permet de supprimer définitivement un produit ou une section **non** mis à la corbeille. | faible | — |
| 6 | Une connexion temps réel ouverte pendant la révocation d'un membre peut survivre jusqu'à l'expiration du JWT. | faible | — |
| 7 | L'export mensuel n'est pas borné et il est généré de façon synchrone. Il peut ralentir l'API pour tous pendant le rendu. | faible | CPU, réplicas |

Deux pistes CI ont été **rejetées** par les vérificateurs : `rollback.yml`,
avec une référence libre, et la garde de `deploy.yml`. Elles n'ouvrent aucune
autorité au-delà de l'accès en écriture au dépôt. Leurs défauts sont classés
en durcissement.

**Bonnes pratiques à améliorer**, sans faille démontrée :
- **Front :** absence de CSP alors que le JWT est stocké dans `localStorage` ; absence de HSTS.
- **Sessions :** pas de déconnexion côté serveur.
- **CI :** pas de bloc `permissions:` ; outils `npx` non épinglés ; rollback sans environnement protégé ; repli de `rollback.yml` différent de son commentaire.
- **Compose :** compose de développement exposé sur `0.0.0.0` ; images de production non épinglées.
- **API :** erreurs 500 sur des identifiants de requête invalides ; garde-fous dépendant de la valeur exacte de `NODE_ENV`.

## 4. Vérifications externes nécessaires

Ces points ne sont pas visibles dans le dépôt. À contrôler par le
propriétaire, sans trafic d'essai sur la production :

| Service | Donnée exacte à contrôler |
|---|---|
| Railway (API) | Présence et valeur de `TRUST_PROXY_HOPS` ou `TRUST_PROXY_ADDRESSES`. `req.ip` d'une requête personnelle : IP publique ou adresse de l'ingress ? `NODE_ENV=production`. Nombre de réplicas. Builder utilisé : Dockerfile ou Railpack. Commit réellement déployé. |
| Railway (API) | `JWT_SECRET` : au moins 32 octets aléatoires et différent des valeurs de `.env.prod.example` et `api/.env.example`. La valeur ne doit pas être divulguée. |
| GitHub | Protection de `main` et contournements autorisés. Liste des comptes ayant l'accès en écriture. `RAILWAY_TOKEN` et `VERCEL_TOKEN` : secrets de dépôt ou d'environnement protégé ? Permissions par défaut de `GITHUB_TOKEN`. |
| Vercel | En-têtes de sécurité appliqués : CSP, HSTS, frame-ancestors. Protection des déploiements de forks. Variables `NEXT_PUBLIC_*`. |
| MongoDB Atlas | Liste d'accès IP, rôles de l'utilisateur applicatif, TLS imposé. Index requis présents. Invitations en attente émises par des membres désormais suspendus. |
| Stockage objet | Fournisseur réellement utilisé : R2 (`api/.env.example`) ou Supabase (mentionné dans le README). Bucket privé, CORS, portée de la clé d'accès. |
| SasPay | URL de webhook enregistrée et secret distinct. Réponses écrites aux questions ouvertes de 1-21E § 2. |
| Cloudflare | Noms d'hôte du widget Turnstile. Éventuel WAF ou limiteur devant l'API. |

## 5. Validations réalisées et bloquées

- **Réalisées :**
  - lecture statique complète ;
  - pour chaque piste, une vérification de phase 3 qui cherche à la réfuter, puis une vérification de phase 5 de l'enregistrement final ;
  - deux critiques de couverture, dont un critique final distinct, sans lacune restante ;
  - les deux validateurs du skill, exécutés dans un conteneur Node local, sans réseau et en lecture seule.
- **Bloquées :**
  - Aucune exécution du code cible : tests unitaires et e2e, reproductions et recette navigateur. Le skill exige un sandbox imposé par l'OS : sans réseau, environnement vide, cible en lecture seule, limites de ressources. Ce sandbox est impossible ici, car les `node_modules` pnpm sont des jonctions Windows à chemins absolus, inutilisables dans un conteneur Linux, et l'installation de dépendances est interdite.
  - La promotion sûre des artefacts (no-follow) est indisponible sous Windows.
- **Non couvert :**
  - la configuration hébergée (§ 4) ;
  - les vulnérabilités connues des dépendances, faute de base CVE hors ligne ;
  - les tests de charge.

Un seul passage du skill ne prouve pas l'absence d'autres défauts.

## 6. Artefacts hors dépôt

Les artefacts se trouvent dans `~/security-audit-skill/stock-master/run-1/` :
`REPORT.md`, `NEEDS-VALIDATION.md` (traces et plans de reproduction),
`FINDINGS-DETAIL.md`, `findings.json`, `coverage-ledger.json`,
`architecture.md` et `run-metadata.json`. Ils ne doivent pas être copiés dans
le dépôt.

## 7. Proposition pour le lot 1-22B

Ordre de traitement proposé. Chaque correction s'accompagne d'abord d'un test
e2e de régression, qui sert aussi de reproduction locale.

1. **Configuration de production, en échec fermé :**
   - refuser au démarrage un `JWT_SECRET` court ou égal à un exemple ;
   - vérifier puis documenter `TRUST_PROXY_*` pour Railway (§ 4) ;
   - envisager une clé distincte pour les HMAC dérivés de `JWT_SECRET`.
2. **Quota SasPay :**
   - part par organisation ou priorité aux confirmations (webhook, rapprochement) ;
   - un seul compteur par organisation pour créer, vérifier et abandonner ;
   - aucune relecture SasPay pour un paiement en échec définitif.
3. **Permissions internes :**
   - exiger `deletedAt != null` pour les purges ;
   - révoquer les invitations en attente d'un membre suspendu ou rétrogradé, ou revérifier l'invitant à l'acceptation ;
   - revérifier l'adhésion après l'enregistrement du socket.
4. **Export mensuel :** plafond de lignes ou d'octets, ou rendu hors de la boucle d'événements.
5. **Durcissements prioritaires :**
   - CSP et HSTS ;
   - `permissions:` et environnement protégé pour les workflows de déploiement ;
   - épinglage des CLI ;
   - correction du repli de `rollback.yml` ;
   - validation des identifiants de requête.

Chaque piste du § 3 sera close soit par un test qui la reproduit puis passe
après correction, soit par un constat documenté qui l'infirme.
