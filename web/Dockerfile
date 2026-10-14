# syntax=docker/dockerfile:1
#
# Image web (Next.js standalone) — build reproductible (phase 1-12E).
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

FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
RUN corepack enable pnpm && corepack install
RUN pnpm install --frozen-lockfile --filter web --os linux --cpu x64 --libc musl
COPY web/ web/
# 1-21D : catalogue tarifaire SERVEUR, source unique des prix affichés
# (importé par web/src/lib/subscription-offers.ts). Modules purs, sans
# dépendance ni secret.
COPY api/src/subscriptions/subscription-pricing.ts api/src/subscriptions/subscription-terms.ts api/src/subscriptions/
# 1-21D : plafond de fiches produit (capacité incluse), module pur.
COPY api/src/products/product-capacity.ts api/src/products/

# Variables PUBLIQUES uniquement (inlinées par `next build`). Aucun secret
# n'est transmis comme ARG. L'inscription publique reste fermée par défaut.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REGISTRATION_ENABLED=false
ARG S3_HOSTNAME
# DOCKER_BUILD=true active `output: "standalone"` (next.config.ts) dans ce
# stage uniquement ; les builds Vercel ne le définissent pas.
ENV DOCKER_BUILD=true \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_REGISTRATION_ENABLED=$NEXT_PUBLIC_REGISTRATION_ENABLED \
    S3_HOSTNAME=$S3_HOSTNAME
RUN pnpm --filter web build

# ─── Runtime : serveur standalone, sans pnpm ni sources ─────────────────────
FROM node:22.23.3-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# outputFileTracingRoot = racine du dépôt : le serveur est émis dans
# .next/standalone/web/server.js (structure observée après build).
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public
WORKDIR /app/web
USER node
EXPOSE 3000
# Contrôle local du port (aucune route ajoutée, aucun package).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('net').connect(+(process.env.PORT||3000),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
CMD ["node", "server.js"]
