# Lot 1-22H.1 — Exposer `Retry-After` au navigateur

État : **corrigé et vérifié** (tests unitaires et e2e, vrai navigateur sur deux origines).
Rien n'est commité, poussé ni déployé. Aucune base réelle, aucun service réel, aucun paiement.

| Élément | Valeur |
|---|---|
| Branche | `fix/phase-1-22h1-cors-retry-after`, créée depuis `security/phase-1-22h-dependency-security`. Les modifications non commitées de 1-22H sont conservées telles quelles |
| Préservé | `stash@{0}` et fichiers personnels (`.env*`) : ni lus, ni modifiés |
| Déploiement | **API seule**, sans migration ni variable |

## 1. Cause

Le web (Vercel) et l'API (Railway) ont deux origines distinctes. Sur une réponse cross-origin,
le navigateur ne laisse lire au code que les en-têtes « simples » et ceux listés dans
`Access-Control-Expose-Headers`. La factory CORS centralisée (`buildHttpCorsOptions`,
`api/src/events/origin.helpers.ts`) n'en exposait **aucun**. `Retry-After` était donc envoyé
par l'API mais lu comme absent par le web. Effets en production, relevés en 1-22H § 7.1 :

- 429 `PAYMENT_RATE_LIMITED` : attente fixe de 60 s (repli) au lieu du délai du serveur ;
- 503 de capacité : aucun blocage des boutons, contrairement à 1-22D ;
- outbox des ventes : backoff seul (déjà signalé en 1-11C.3).

## 2. Correction

`api/src/events/origin.helpers.ts` :

- nouvelle constante `HTTP_CORS_EXPOSED_HEADERS = ['Retry-After']` ;
- `buildHttpCorsOptions` renvoie `exposedHeaders: HTTP_CORS_EXPOSED_HEADERS`.

Aucun en-tête n'était exposé auparavant ; il n'y avait donc rien à conserver. Le web ne lit
aucun autre en-tête de réponse de l'API (recherche dans `web/src`) : l'exposition reste minimale.

Inchangés : origines autorisées (égalité exacte), absence de `credentials`, méthodes, en-têtes
de requête, quotas, Retry-After calculés par l'API, logique de paiement, code du web.

**Portée** : la factory est utilisée par `main.ts` (production), les e2e et l'entrée de test de
la recette. `app.enableCors` enregistre le middleware `cors` avant les gardes, les pipes, les
filtres et les routes. Tous les `Retry-After` de l'API sont posés par `res.setHeader` sur cette
même réponse : garde d'écriture des paiements, budget d'appels SasPay (quota par organisation,
capacité), filtre global, invitations, authentification et exports mensuels. Les e2e le
vérifient sur les vrais 429 et 503 de création (§ 3).

## 3. Tests

Exécutés dans une copie isolée des fichiers suivis, sans `.env`.

| Contrôle | Résultat |
|---|---|
| `origin.helpers.spec.ts` : options exactes (`exposedHeaders` = `['Retry-After']`, méthodes et en-têtes de requête inchangés, pas de `credentials`) ; middleware `cors` réellement chargé par `@nestjs/platform-express`, sur une réponse simple : origine autorisée → `Allow-Origin` exact et `Expose-Headers: Retry-After` ; origine interdite, sous-domaine voisin ou sans `Origin` → **aucun** en-tête CORS | 41/41 |
| Contre-épreuve : la même suite **sans** la correction | 2 échecs (attendus), 39 réussis |
| `saspay-quota-isolation.e2e-spec.ts` : CORS monté avec la factory de `main.ts`, au même endroit. Cas 2 : vrai 429 de quota à la création → `Retry-After` ≥ 1, `Allow-Origin` exact, `Expose-Headers: Retry-After` ; même refus depuis une origine étrangère → aucun en-tête CORS. Cas 3 : vrai 503 de capacité → `Retry-After: 30` exposé | inclus ci-dessous |
| e2e `saspay-quota-isolation`, `app` (CORS 0B.4), `test-config-isolation` (1-22D.1), `saspay-checkout` | **4 suites, 145 tests** |
| Unitaires `src/events` et `src/common` | 15 suites, 309 tests |
| ESLint des fichiers modifiés ; `nest build` | 0 erreur (3 avertissements préexistants de la suite e2e) ; build OK |

## 4. Preuves navigateur

**Cadre** : recette existante (`api/test/recipe`), lancée depuis la copie isolée. Le web est servi
sur `http://127.0.0.1:3200` (build de production), l'API sur `http://127.0.0.1:4200` : **deux
origines distinctes**. L'API utilise sa vraie configuration CORS (factory compilée) et ses quotas
de production ; SasPay, l'anti-robot et MongoDB sont simulés ou éphémères. Chromium 1234 et
Playwright 1.57 sont des installations existantes. Le DNS externe est bloqué : seuls `127.0.0.1`
et `localhost` sont joignables, et la page SasPay est simulée par une route.

**Aucun `Access-Control-Expose-Headers` n'a été injecté** dans le navigateur ni par un relais
pour les cas réels. Ce que lit le code du web est relevé par une observation de
`XMLHttpRequest.getResponseHeader` (lecture seule ; axios utilise XHR dans le navigateur).

| Cas | Comment il est produit | Observé |
|---|---|---|
| **429 réel** `PAYMENT_RATE_LIMITED` | Garde d'écriture des paiements (10 requêtes par minute, blocage 60 s) déclenchée par 11 requêtes **invalides** de l'organisation (400, aucun effet). Clic dans le navigateur 45 s plus tard | Le web lit **`Retry-After: 15`** ; bouton désactivé tout de suite, encore désactivé à 13,5 s, réactivé à 16,5 s ; **aucune requête** pendant l'attente, même après un clic forcé |
| **503 réel** `PAYMENT_SERVICE_UNAVAILABLE` | Voie propriétaire du budget SasPay saturée par 7 autres organisations (appels réels : 18 + 18 + 18 + 18 + 7 + 1 = 80, puis un refus) | Le web lit **`Retry-After: 30`** ; désactivé à 28,5 s, réactivé à 31,5 s ; aucune requête pendant l'attente |
| Tentative conservée | — | 3 envois du navigateur avec le **même** `clientOperationId` et la même durée (`monthly`) |
| Nouvel essai (voie libérée) | Vraie API, SasPay simulé | **1** paiement créé, avec l'UUID conservé ; départ vers la page SasPay simulée |
| Appels externes | — | Aucun |

**Retry-After absent ou invalide** (comportement existant) : l'API réelle n'émet jamais ces
valeurs, les réponses ont donc été simulées sur une autre organisation. Elles reprennent les seuls
en-têtes CORS émis par l'API pour l'origine du web (relevés sur `/health`), avec l'horloge
Playwright.

| Cas | Observé |
|---|---|
| 429 sans `Retry-After` / avec `Retry-After: soon` | Repli de 60 s : désactivé à 59 s, réactivé à 61 s |
| 503 sans `Retry-After` / avec `Retry-After: soon` | Aucun blocage (message seul) |
| Tentative | Même UUID et même durée aux 4 envois ; 0 paiement créé |

Résultat : **6/6**.

## 5. Limites

- **429 de quota par organisation** (budget SasPay, 1 à 60 s) : non reproductible par HTTP avec
  les quotas de production. Une création n'est possible qu'après abandon du paiement ouvert, et
  l'abandon réserve 7 appels : l'organisation plafonne alors à 18 ou 19 appels sur 20. Ce
  chemin est couvert par l'e2e (cas 2) : vrai 429 de quota, `Retry-After` exposé. Dans le
  navigateur, le 429 réel vient de la garde d'écriture : même code, même traitement par le web,
  même mécanisme `res.setHeader`, même CORS.
- Outbox des ventes : elle profite de la même correction, puisqu'elle lit `retry-after` par
  axios, mais n'a pas été rejouée en navigateur. Ce lot porte sur les paiements, et l'e2e
  prouve l'exposition de l'en-tête quelle que soit la route.
- Chromium seul. Les réponses mises en cache par un CDN ou un proxy devant l'API ne sont pas
  concernées : ces 429 et 503 portent sur des `POST`.
- Pas de contre-épreuve navigateur sans le correctif. Le comportement avant correction est celui
  relevé en 1-22H § 7.1 ; la contre-épreuve est faite au niveau unitaire (§ 3).

## 6. Déploiement

API seule (Railway), sans migration ni variable. Le web n'a besoin d'aucun changement.
À déployer avec ou après 1-22H, dans le même ordre (API d'abord).

Contrôle après déploiement, sans action sur les paiements :

```bash
curl -s -D - -o /dev/null -H "Origin: https://<origine du web>" https://<api>/health \
  | grep -i '^access-control-'
# attendu : Access-Control-Allow-Origin: https://<origine du web>
#           Access-Control-Expose-Headers: Retry-After
curl -s -D - -o /dev/null -H "Origin: https://exemple.invalid" https://<api>/health \
  | grep -ci '^access-control-'
# attendu : 0
```

Retour arrière : celui de 1-22H (`rollback.yml`). Le web retrouve alors son repli antérieur,
sans perte de tentative.

## 7. Fichiers modifiés

- `api/src/events/origin.helpers.ts`
- `api/src/events/origin.helpers.spec.ts`
- `api/test/saspay-quota-isolation.e2e-spec.ts`
- `docs/architecture/phase-1-22h1-cors-retry-after.md` (ce rapport)
- `docs/architecture/phase-1-22h-dependency-security.md` (renvoi)

Ressources temporaires supprimées après vérification : copie isolée, relais Playwright, scripts
de vérification et résultats. La stack de recette a été arrêtée par `recipe.js stop`.
