# Lot 1-22G — Durcissement des workflows CI/CD

État : **les trois workflows sont durcis.** Ce lot corrige deux défauts de fonctionnement
découverts pendant l'inventaire :
- le retour arrière web n'en faisait aucun (`vercel rollback` sans argument) ;
- le repli de `rollback.yml` redéployait la version en cours.

Les retours arrière automatiques sont **retirés** de `deploy.yml`. Les protections hébergées
(protection de `main`, attente de la CI, environnement protégé) sont **à configurer et non
vérifiées** (§ 4) : ce lot ne les compte pas parmi ses garanties. Aucun code applicatif n'a
changé. Rien n'est commité, poussé ni déployé, aucun workflow distant n'a été lancé, aucun
secret n'a été lu et aucun paramètre hébergé n'a été modifié.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `235ed68` (1-22F), au-dessus de `f28c9c8` (1-22E). Ces deux commits **hérités** sont poussés sur leurs branches mais **non fusionnés dans `main`** (`675e1b3`). Ils ne touchent pas `.github/` |
| Branche | `security/phase-1-22g-ci-cd-hardening`, depuis un arbre propre ; sans stash, reset ni nettoyage |
| Dépôt | `DatengTankoua/stock-master`, **public** (API GitHub sans authentification : 200). Les pull requests de forks sont donc possibles |
| Sources consultées | GitHub Docs (événements `deployment_status` et `workflow_dispatch`, environnements) ; `action.yml` d'`actions/checkout` au commit épinglé ; Vercel (`vercel rollback`, Deployment Checks, HSTS) ; Railway (CLI, Pre-deploy Command, GitHub Autodeploys) ; code publié de `vercel@61.1.0` et `vercel@64.0.2`, lu sans être exécuté |

Le stash (`stash@{0}`) est conservé.

## 2. Inventaire (avant)

| Workflow | Déclencheur | Permissions | Secrets | Code exécuté | Actions et CLI |
|---|---|---|---|---|---|
| `ci.yml` | push et PR vers `main`, `dev` | défaut du dépôt (non observable) | aucun | code de la PR (lint, tests, build) | `checkout@v4`, `pnpm/action-setup@v4`, `setup-node@v4` (étiquettes mobiles) |
| `deploy.yml` | `deployment_status` (Railway, Vercel) | défaut | `API_HEALTH_URL`, `WEB_HEALTH_URL`, `RAILWAY_TOKEN`, `VERCEL_*` | `git checkout HEAD~1` puis `railway up` | `checkout@v4`, `npx @railway/cli@latest`, `npx vercel` (non épinglé) |
| `rollback.yml` | `workflow_dispatch` (accès en écriture requis) | défaut | `RAILWAY_TOKEN`, `VERCEL_*` | commit choisi ou repli, puis `railway up` | idem |

Les **déploiements** eux-mêmes sont faits par les intégrations Git de Railway (branche de
déclenchement) et de Vercel, **hors GitHub Actions**.

**Pistes rejetées par 1-22A** (`rollback.yml` avec une référence libre, garde de `deploy.yml`).
Elles **ne sont pas requalifiées** en failles : aucune preuve nouvelle d'une autorité obtenue
au-delà de l'accès en écriture. Elles sont traitées en durcissement (§ 3).

## 3. Constats et corrections

| # | Constat | Correction | Preuve locale | Réglage manuel restant |
|---|---|---|---|---|
| 1 | Pas de bloc `permissions:` : `GITHUB_TOKEN` reçoit les droits par défaut du dépôt | `ci.yml` et `rollback.yml` : `contents: read` ; `deploy.yml` : `permissions: {}` (aucun checkout ni appel GitHub). Aucun job ne demande d'écriture | Contrôle statique : permissions déclarées, aucune `write` | Optionnel : Settings → Actions → *Workflow permissions* : lecture seule par défaut |
| 2 | Actions à étiquettes mobiles (`@v4`) | Épinglées au commit **actuellement visé par `@v4`**, donc comportement inchangé : checkout `11d5960…` (v4.4.0), setup-node `49933ea…` (v4.4.0), pnpm/action-setup `b906aff…` (v4.3.0). Les trois commits sont **vérifiés** par GitHub. `persist-credentials: false` partout | `git ls-remote`, API GitHub `verification.verified: true` | Mises à jour par revue (aucun Dependabot ajouté) |
| 3 | CLI non épinglés (`@railway/cli@latest`, `vercel`) | `@railway/cli@5.63.1` et `vercel@61.1.0`, publiés depuis plus de deux semaines. Commandes vérifiées : `railway up --service --detach` (doc CLI) ; `vercel rollback <déploiement> --yes --timeout` (doc et code publié) | Registre npm (dates) ; code de `vercel@61.1.0` : `rollbackCommand` accepte `--yes` et `--timeout` ; jeton lu dans `VERCEL_TOKEN` | — |
| 4 | Secrets interpolés dans le shell (`${{ secrets.… }}` dans `run:`, `--token ${{ … }}`) | Toute valeur passe par `env:`. Le jeton Vercel n'est plus en argument (lu dans `VERCEL_TOKEN`) | Contrôle : aucune `${{` dans un `run:`, aucun `--token` | — |
| 5 | **`vercel rollback` sans argument n'effectue aucun retour arrière** : dans 61.1.0 comme dans 64.0.2, l'argument absent devient `status` (affichage de l'état, code 0). Les retours arrière web de `deploy.yml` et de `rollback.yml` n'avaient donc aucun effet | `rollback.yml` exige un **déploiement nommé** (`web_deployment` : `dpl_…` ou URL https), validé. `deploy.yml` n'en lance plus | Lecture du code publié : `actionOrDeployId = args[1] \|\| "status"` ; tests du script de validation | Retrouver l'identifiant du déploiement à restaurer (tableau de bord Vercel ou `vercel list`). Sur le plan Hobby, seul le déploiement de production précédent est accepté (doc Vercel) |
| 6 | **Repli de `rollback.yml` contraire à sa documentation** : avec `target_sha` vide, `ref: ''` reprend le commit de l'événement, c'est-à-dire **le dernier commit de la branche lancée**. Le commentaire annonçait `HEAD~1` et la description « previous deploy » | Plus aucun repli. `target_sha` est **obligatoire** pour l'API : SHA complet, présent dans l'historique de `origin/main`. Le workflow ne choisit **aucune** cible | `action.yml` d'`actions/checkout` (« defaults to the reference or SHA for that event ») ; GitHub Docs (`workflow_dispatch` : `GITHUB_SHA` = dernier commit de la branche) ; tests | L'opérateur relève le commit de la version saine (historique des déploiements Railway) |
| 7 | **Retour arrière automatique de l'API** (`deploy.yml`) vers `HEAD~1` : ce commit n'est pas forcément la version précédemment déployée, et la restauration contournait la procédure des paiements SasPay (1-21B § 11, 1-21E § 10.1 : clôturer les paiements ouverts, résoudre les conflits, préférer une correction en avant) | **Retiré**, de même que le retour arrière web inopérant. `deploy.yml` contrôle la santé, rend le run rouge et écrit la procédure dans le résumé. L'API ne peut être restaurée que par `rollback.yml`, après la case `payments_checked` | Contrôle : ni `HEAD~1` ni `vercel rollback` sans cible ; tests de déclenchement | **Changement opérationnel à valider** : la détection reste, la restauration devient manuelle |
| 8 | Jobs de retour arrière avec secrets, sans environnement | `rollback-web` et `rollback-api` déclarent `environment: production-operations`. Un job `validate` **sans secret** vérifie les cibles avant eux. Ce nom est distinct de ceux qu'utilisent habituellement Vercel et Railway (non observés), et `deploy.yml` ignore les déploiements de cet environnement | Contrôle : secrets de déploiement seulement sous un environnement ; validation sans secret | **Indispensable**, sinon le nom seul ne protège rien (§ 4) |
| 9 | Chemins de PR | `ci.yml` (PR, forks compris) : aucun secret, jeton en lecture seule, pas de `pull_request_target`. `deploy.yml` : plus de secret de déploiement et plus aucun code du dépôt exécuté ; seuls les deux secrets d'URL de santé y restent | Contrôle : un workflow déclenché par PR ne référence aucun secret | Vercel : protection des déploiements de forks (Git Fork Protection) à confirmer ; cf. audit 1-22A § 4 |
| 10 | Garde de `deploy.yml` | Déploiement `success` de `main`, hors `production-operations`. La comparaison est insensible à la casse, comme GitHub | 8 cas de déclenchement évalués (§ 5) | Les noms d'environnement émis par Railway et Vercel n'ont pas été observés |

**Protections opérationnelles conservées.**
- Les migrations et les contrôles de pré-déploiement ne sont ni contournés ni modifiés. La
  « Pre-deploy Command » Railway reste dans les réglages du service (1-21D).
- `railway up` crée un déploiement du même service. La documentation Railway place l'étape de
  pré-déploiement « entre la construction et le déploiement », **sans préciser** si elle
  s'applique aux déploiements par CLI : à vérifier (§ 4).
- Aucune plateforme, action ni dépendance nouvelle n'est ajoutée.

## 4. Protections hébergées : à configurer, non vérifiées

**Aucune protection de cette section n'est active à ce jour, à notre connaissance.** Aucune
n'a été observée ni configurée. Elles ne figurent pas parmi les garanties de ce lot (§ 6), qui
se limitent au contenu des workflows.

Trois étapes distinctes, qu'aucune ne remplace :

| Étape | Ce qu'elle empêche | Où | État |
|---|---|---|---|
| **A. Avant la fusion** dans `main` | Du code qui n'a pas passé `ci.yml` arrive sur `main` | GitHub : protection de branche ou ruleset sur `main` | à configurer, non vérifié |
| **B. Avant la mise en production** d'un commit de `main` | Railway ou Vercel publient un commit dont `ci.yml` a échoué (poussée directe, contournement de A) | Railway : *Wait for CI* ; Vercel : *Deployment Checks* | à configurer, non vérifié |
| **C. Après le déploiement** | Un déploiement cassé passe inaperçu | `deploy.yml` (contrôle de santé, **sans retour arrière automatique**), puis décision humaine et `rollback.yml` | dans le dépôt ; exécution réelle non observée |

### A. Protection de `main` (GitHub)

Les règles disponibles (GitHub Docs, rulesets) : exiger une pull request avant la fusion,
exiger le succès de checks (`api` et `web` de `ci.yml`) et lister des utilisateurs autorisés à
contourner.

- **Propriétaire seul.** GitHub ne laisse pas l'auteur approuver sa propre pull request.
  Exiger une approbation (≥ 1) bloquerait donc toute fusion faute de second relecteur. À
  défaut de second relecteur, régler les **approbations requises à 0** (la PR et les checks
  restent obligatoires), ou inscrire le propriétaire dans les **contournements**, en sachant
  qu'il neutralise alors la règle pour lui-même.
- Une correction urgente reste possible par PR, dès que les checks passent.

### B. Attente de la CI avant la mise en production

**Railway — Wait for CI** (doc Railway, *GitHub Autodeploys*) :
- le déploiement reste `WAITING` jusqu'à la fin de **toutes** les suites GitHub Actions du
  commit. Un échec le saute ; « skipped » ou « neutral » ne bloque pas ; au-delà de 2 h, il
  est sauté ;
- condition documentée : un workflow déclenché sur `push`. `ci.yml` la remplit ;
- **point à observer après activation** : « toutes les suites » inclut a priori les runs de
  `deploy.yml` déclenchés par le déploiement **Vercel** du même commit. Un contrôle de santé
  web en échec pourrait alors faire sauter le déploiement de l'API. Ce comportement n'est pas
  établi.

**Vercel — Deployment Checks** (doc Vercel, *Deployment Checks* ; changelog « Block Vercel
deployment promotions with GitHub Actions ») :
- **Offre** : la page de documentation ne cite aucune restriction d'offre ; le changelog
  indique « available for all projects connected to GitHub repositories ». La disponibilité
  sur le compte et le projet réels **n'est pas vérifiée**.
- **Intégration** : aucune intégration supplémentaire n'est nécessaire pour des jobs GitHub
  Actions déclenchés par `push`. Vercel lit directement les statuts et les check runs du
  commit, et l'on choisit les checks voulus. L'action `vercel/repository-dispatch/actions/status`
  n'est **requise** qu'avec un déclencheur `repository_dispatch`, ce que `ci.yml` n'utilise pas.
- **Prérequis documentés** :
  1. le projet est relié au dépôt par *Vercel for GitHub* (à vérifier : le dossier local
     `web/.vercel/project.json` ne le prouve pas) ;
  2. l'*automatic aliasing* de production est activé.
- **Procédure** : Project Settings → *Build and Deployment* → *Deployment Checks* → *Add
  Checks* → fournisseur **GitHub** → choisir `api` et `web`. Ces noms de jobs sont conservés
  par ce lot : la documentation identifie les checks par nom de job, et un renommage
  imposerait de les reconfigurer.
- **Effet** : le déploiement de production est créé, mais il n'est attribué aux domaines de
  production qu'une fois les checks réussis.
- **Contournement** : *Force Promote* depuis la page du déploiement.

Ce n'est donc **pas un simple interrupteur**. Il faut que les prérequis soient remplis, puis
vérifier sur un vrai déploiement que la promotion attend bien `api` et `web`.

### C. Contrôle de santé et retour arrière (GitHub)

1. Settings → Environments → créer **`production-operations`** :
   - *Deployment branches and tags* : **`main` uniquement**. Un `workflow_dispatch` lancé sur
     une autre branche, avec un workflow modifié, n'obtient pas les secrets. C'est la règle
     essentielle, et elle ne demande aucun relecteur.
   - *Required reviewers* : **facultatif**.
     - Propriétaire seul : s'y inscrire **sans** *Prevent self-review*. Cette option l'empêche
       d'approuver ses propres runs et rendrait le retour arrière **inaccessible**. La
       documentation GitHub décrit l'option sans dire explicitement que l'auteur approuve son
       run quand elle est désactivée : c'est à vérifier lors d'un essai.
     - Avec plusieurs relecteurs, l'option peut être activée.
   - *Allow administrators to bypass configured protection rules* : à garder comme **voie de
     secours** si les relecteurs requis risquent d'être indisponibles (la documentation ne
     précise pas la valeur par défaut).
2. Déplacer `RAILWAY_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID` et `VERCEL_PROJECT_ID` vers les
   **secrets de cet environnement**, puis les **supprimer des secrets du dépôt**. Un secret de
   dépôt reste accessible à tout job, avec ou sans environnement. Tant que ce n'est pas fait,
   `environment:` ne protège rien, et GitHub crée l'environnement sans règle au premier run.
3. **Le retour arrière doit rester accessible sans GitHub.** Si GitHub ou l'environnement
   bloque, les tableaux de bord permettent de restaurer directement : *Instant Rollback* chez
   Vercel, redéploiement d'un déploiement antérieur chez Railway. La procédure des paiements
   SasPay (1-21B § 11, 1-21E § 10.1) s'applique de la même façon.
4. Optionnel : *Workflow permissions* en lecture seule par défaut.

**Autres vérifications hébergées.**
- Railway : la branche de déclenchement est `main` ; la Pre-deploy Command s'applique aussi à
  un déploiement `railway up` ; nom d'environnement émis vers GitHub.
- Vercel : protection des déploiements de forks ; nom d'environnement émis vers GitHub.

**Retours arrière automatiques.** Ce lot propose de **ne pas** les rétablir, même une fois ces
protections en place :
- celui du web n'avait aucun effet ;
- celui de l'API visait un commit arbitraire et contournait la procédure des paiements.

Les étapes A et B réduisent le besoin de retour arrière ; elles ne le rendent pas sûr pour les
données.

## 5. Validation locale

| Contrôle | Résultat |
|---|---|
| YAML strict (`yaml` 2.9.0 déjà installé, clés uniques) et contrôle statique ciblé : permissions, épinglage, `${{ }}` hors shell, CLI exacts, secrets sous environnement, PR sans secret, cibles implicites | **112/112** sur les nouveaux workflows |
| Contre-épreuve : même contrôle sur les workflows d'origine (`HEAD`) | Tous les défauts du § 3 détectés |
| Déclenchement de `deploy.yml`, sur 8 événements factices | Exécuté pour Vercel « Production » et pour un environnement Railway sur `main`. Ignoré pour : échec, en cours, autre branche, ref en SHA, `production-operations` (deux casses) |
| Sélection des jobs de `rollback.yml` (`web`, `api`, `both`) et dépendance à `validate` | conforme |
| `.github/scripts/rollback-target.sh`, sur 18 entrées factices et l'historique réel | **18/18**. Refuse : cible absente (web ou API), URL avec chemin ou `http`, SHA court ou en majuscules, commit inexistant, commit hors de `main` (`235ed68`), API sans `payments_checked`. Tentatives `;` et `$( )` : **aucune exécutée** |

Non fait : actionlint et shellcheck ne sont pas installés sur ce poste, et rien n'a été ajouté.
Aucun workflow distant n'a été exécuté. Les tests applicatifs n'ont pas été relancés : aucun
code applicatif n'a changé.

## 6. Garanties actives et protections en attente

**Garanties apportées par le dépôt** (dès la fusion de ce lot ; vérifiées localement) :

| Point | Preuve |
|---|---|
| Permissions minimales déclarées ; actions épinglées à des commits vérifiés ; CLI à version exacte | Contrôle statique (§ 5) |
| Aucune interpolation d'entrée ou de secret dans le shell | Contrôle statique |
| Aucun secret dans les chemins de pull request (`ci.yml`) | Contrôle statique |
| Aucun retour arrière automatique ; retour arrière manuel seulement vers une cible nommée et validée | Contrôle statique et 18 tests du script de validation |

**Protections hébergées : à configurer, non vérifiées.** Elles ne comptent pas parmi les
garanties ci-dessus.

| Point | État | Dépend de |
|---|---|---|
| A. Protection de `main` avant fusion | à configurer, non vérifié | GitHub (ruleset ; propriétaire seul : approbations à 0 ou contournement) |
| B. Attente de la CI avant mise en production | à configurer, non vérifié | Railway *Wait for CI* ; Vercel *Deployment Checks* (prérequis et disponibilité à confirmer) |
| Secrets de retour arrière réservés à `production-operations` | à configurer, non vérifié | GitHub : environnement, branche `main`, secrets déplacés |
| Exécution réelle de `vercel rollback <cible>` et de `railway up` | non vérifié (aucun appel) | Vercel (offre, droits du jeton), Railway (jeton de projet, Pre-deploy sur CLI) |
| Noms d'environnement réels pour la garde de `deploy.yml` | non observé | Railway, Vercel |

## 7. Limites

- **Un retour arrière technique n'est pas sûr pour les données.** La case `payments_checked`
  rappelle la procédure SasPay ; elle ne la vérifie pas. Les index ajoutés par les migrations
  restent en place après un retour arrière (documenté compatible en 1-21B et 1-21E).
- `npx` exécute des paquets tiers avec un jeton dans l'environnement. L'épinglage fixe la
  version, mais `@railway/cli` télécharge son binaire à l'installation (risque résiduel de la
  chaîne d'approvisionnement).
- Un contrôle de santé en échec n'alerte plus que par le run rouge et sa notification GitHub.
- `deploy.yml` s'exécute dans la version du workflow portée par le commit déployé : la garde
  ne change pas l'autorité requise pour créer un déploiement.

## 8. Fichiers

| Fichier | Changement |
|---|---|
| `.github/workflows/ci.yml` | `permissions`, actions épinglées, `persist-credentials: false` |
| `.github/workflows/deploy.yml` | Contrôle de santé seul ; aucun secret de déploiement ; garde élargie ; procédure dans le résumé |
| `.github/workflows/rollback.yml` | Cibles explicites validées, job de validation sans secret, environnement, CLI épinglés |
| `.github/scripts/rollback-target.sh` | Validation testable des cibles |
| `README.md` | Section CI/CD alignée (plus de « rollback automatique ») |
