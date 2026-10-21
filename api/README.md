# Stock Master — API (NestJS)

API REST + WebSocket de l'application **Stock Master**.

## Stack

- NestJS 11 · TypeScript · Mongoose (MongoDB 7, replica set requis par les
  transactions)
- `@nestjs/jwt` + Passport (authentification JWT Bearer)
- `@nestjs/websockets` + Socket.IO (temps réel, un salon par commerce)
- `@aws-sdk/client-s3` (stockage S3 compatible privé, URL signées)
- `class-validator` / `class-transformer` (validation des DTO)
- `bcryptjs` (hachage des mots de passe)

## Démarrer

Le parcours complet est dans le [README racine](../README.md#démarrage-local) :
fichiers d'environnement, MongoDB `rs0`, MinIO, migrations et premier
compte. Depuis la racine :

```bash
pnpm --filter api start:dev   # http://localhost:4000, santé : GET /health
```

- **Variables.** La source de référence est [`.env.example`](.env.example),
  avec les variables obligatoires, facultatives et leurs bornes. Elles sont
  lues au démarrage.
- **Migrations.** Les scripts `migrate:*` ne lisent que l'environnement du
  shell, jamais `.env`.

## Organisation du code

- **Un dossier par domaine dans `src/`.** Par exemple `auth`,
  `organizations`, `products` (lots compris), `sales`, `subscriptions`,
  `push`, `notifications`, `support`, `legal`, `trash`, `storage-quota`.
- **Routes.** Elles sont décrites par les `*.controller.ts` et par le rapport
  du lot concerné dans
  [`docs/architecture/`](../docs/architecture/).
- **Requêtes protégées** par défaut :
  - une route publique est marquée `@Public()` ;
  - l'organisation vient du contexte authentifié ;
  - les droits sont recalculés à chaque requête (`effectivePermissions`).
- **Temps réel.** Salons par organisation et relecture de l'adhésion :
  [phase-1-5a-socket-organization-rooms.md](../docs/architecture/phase-1-5a-socket-organization-rooms.md).
- **Migrations et outils opérateur.** Ils vivent dans `src/migrations/`. La
  liste du pré-déploiement est `PREDEPLOY_MIGRATIONS`
  (`predeploy-migrations.ts`).

## Tests

Depuis la racine du dépôt.

| Quoi | Commande |
|---|---|
| Unitaires (tous) | `pnpm --filter api test` |
| Unitaires ciblés (motif de fichier) | `pnpm --filter api test -- predeploy-migrations` |
| Unitaires isolés des `.env` réels | `node api/test/recipe/recipe.js isolated api-unit [motifs]` |
| E2E ciblé (recommandé) | `node api/test/recipe/recipe.js isolated api-e2e rate-limit-index` |
| E2E, suite complète | `node api/test/recipe/recipe.js isolated api-e2e` (long : plusieurs dizaines de minutes) |
| E2E sans la garde d'isolement | `pnpm --filter api test:e2e -- <motif>` |
| Fuseau imposé (bornes mensuelles) | ajouter `--tz=Africa/Douala` à `isolated api-unit` ou `isolated api-e2e` |
| Couverture | `pnpm --filter api test:cov` |

- **Unitaires** : fichiers `src/**/*.spec.ts`, à côté du code.
- **E2E** : fichiers `test/*.e2e-spec.ts`.
  - Ils démarrent une instance MongoDB éphémère (`mongodb-memory-server`,
    127.0.0.1, port aléatoire) et refusent toute URI pointant vers le port
    27017 de développement ou vers un hôte distant
    ([phase-0b2-isolated-e2e.md](../docs/testing/phase-0b2-isolated-e2e.md)).
  - Docker n'est pas nécessaire, mais le premier lancement télécharge le
    binaire MongoDB.
  - Ils ne tournent **pas** en CI : seuls `pnpm lint`, `pnpm test` et
    `pnpm build` y tournent.
- **Recette manuelle** (comptes fictifs, lots, alertes, paiements simulés) :
  [test/recipe/README.md](test/recipe/README.md).
- **Fichiers temporaires.** Les e2e et la recette laissent parfois des
  dossiers `mongo-mem-*` dans le répertoire temporaire. Ils sont sans
  utilité une fois **aucune** recette ni suite e2e en cours :

  ```bash
  rm -rf "${TMPDIR:-/tmp}"/mongo-mem-*            # Bash / WSL
  ```

  ```powershell
  Remove-Item "$env:TEMP\mongo-mem-*" -Recurse -Force   # PowerShell
  ```

## Commandes

```bash
pnpm start:dev      # dev avec rechargement automatique
pnpm start:debug    # dev avec débogueur Node.js attachable
pnpm build          # compile TypeScript → dist/
pnpm start:prod     # démarre le build de production
pnpm lint           # ESLint avec correction automatique
```

## Build production (Docker)

Le contexte de build est la **racine du dépôt** : le Dockerfile copie le
lockfile et `api/`.

```bash
docker build -f api/Dockerfile -t stock-master-api .
```

L'image ne contient pas pnpm. Les migrations s'y lancent avec `node`, par
exemple :
`node /app/api/dist/migrations/predeploy-migrations.js`. Voir
[Migrations](../README.md#migrations-à-exécuter-avant-lactivation-dune-version).
