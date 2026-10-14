# syntax=docker/dockerfile:1
#
# Image API — build reproductible (phase 1-12E).
# Contexte de build : racine du dépôt (voir docker-compose.prod.yml).
#
# Image de base figée (tag + digest de l'index multi-arch) :
#   node:22.23.3-alpine3.23 — Node 22.23.3, Alpine 3.23, musl (1-22H : correctifs
#   de sécurité Node 22.22.0 à 22.23.2 ; aucune 22.23.x publiée sur Alpine 3.22)
#   index    sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a
#   amd64    sha256:489418a947387da1c5b4c0c5749c963da56ecaac0ced1da74c67db60e42f2b3a
# pnpm : version exacte du champ `packageManager` (pnpm@11.18.0) via corepack.
# Sharp : seuls les binaires linux/x64/musl sont installés (--os/--cpu/--libc),
# sans modifier pnpm-workspace.yaml (qui reste multiplateforme).

FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY api/package.json api/
RUN corepack enable pnpm && corepack install

# ─── Build : dépendances complètes (lockfile figé) + compilation Nest ───────
FROM pnpm AS build
# Le binaire MongoDB de mongodb-memory-server (tests uniquement) n'est pas
# téléchargé dans l'image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --filter api --os linux --cpu x64 --libc musl
COPY api/ api/
RUN pnpm --filter api build

# ─── Dépendances de production uniquement (même lockfile) ───────────────────
FROM pnpm AS prod-deps
# --ignore-scripts : le `prepare` racine (husky, devDependency) n'a pas sa
# place en production. Aucune dépendance de prod n'a de script d'installation
# nécessaire (sharp 0.35.5 n'en déclare pas ; binaires natifs via @img/*).
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter api --os linux --cpu x64 --libc musl

# ─── Runtime : minimal, sans pnpm ni sources, utilisateur non privilégié ────
FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
# Layout pnpm conservé : api/node_modules pointe (liens symboliques) vers le
# store virtuel /app/node_modules/.pnpm. Fichiers en lecture seule pour `node`.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/api/node_modules ./api/node_modules
COPY --from=build /repo/api/dist ./api/dist
COPY api/package.json ./api/package.json
WORKDIR /app/api
USER node
EXPOSE 4000
# Route publique existante GET /health (aucun accès MongoDB, aucun secret).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main"]
