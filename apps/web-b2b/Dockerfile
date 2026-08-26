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
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages packages
COPY providers providers
COPY apps/web-b2b apps/web-b2b
RUN pnpm install --filter @sales-travel/web-b2b... --no-frozen-lockfile
RUN pnpm --filter @sales-travel/web-b2b build

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=builder --chown=app:nodejs /repo/apps/web-b2b/.next/standalone ./
COPY --from=builder --chown=app:nodejs /repo/apps/web-b2b/.next/static ./apps/web-b2b/.next/static
USER app
EXPOSE 3001
CMD ["node", "apps/web-b2b/server.js"]
