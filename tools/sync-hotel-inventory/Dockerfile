ARG NODE_VERSION=20.18-alpine
ARG PNPM_VERSION=9.15.0

FROM node:${NODE_VERSION} AS base
# pnpm se instala por COREPACK, no por `npm install -g`. El motivo no es estetico: la imagen
# base flotante trajo un npm mas nuevo y pnpm empezo a rechazar arrancar con
# ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE — no puede verificar que el pnpm que corre es el que
# declara `packageManager` en package.json. Corepack es la via soportada y establece esa identidad.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

FROM base AS builder
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY tools/sync-hotel-inventory tools/sync-hotel-inventory
RUN pnpm install --filter @sales-travel/sync-hotel-inventory... --no-frozen-lockfile
RUN pnpm --filter @sales-travel/sync-hotel-inventory build
RUN pnpm --filter @sales-travel/sync-hotel-inventory deploy --prod /out/sync-hotel-inventory

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=builder --chown=app:nodejs /out/sync-hotel-inventory .
USER app
CMD ["node", "dist/index.js"]
