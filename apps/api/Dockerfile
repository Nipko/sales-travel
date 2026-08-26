ARG NODE_VERSION=20.18-alpine
ARG PNPM_VERSION=9.15.0

FROM node:${NODE_VERSION} AS base
# pnpm se instala por COREPACK, no por `npm install -g`. El motivo no es estetico: la imagen
# base flotante trajo un npm mas nuevo y pnpm empezo a rechazar arrancar con
# ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE — no puede verificar que el pnpm que corre es el que
# declara `packageManager` en package.json. Corepack es la via soportada y establece esa identidad.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

FROM base AS builder
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages packages
COPY providers providers
COPY apps/api apps/api
RUN pnpm install --filter @sales-travel/api... --no-frozen-lockfile
# Las dependencias se construyen por el GRAFO (`^...`), no por una lista escrita a mano.
# La lista anterior enumeraba los siete paquetes uno a uno y se quedo rancia en cuanto
# `apps/api` gano una dependencia nueva (`@sales-travel/sabre`): el `pnpm install` de arriba si
# la instalaba, pero nadie la construia, asi que el build de la api fallaba al no encontrar su
# `dist`. Es el mismo criterio que ya usa `.github/workflows/ci.yml`.
RUN pnpm --filter "@sales-travel/api^..." run build
RUN pnpm --filter @sales-travel/api run build
RUN pnpm --filter @sales-travel/api deploy --prod /out/api

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=builder --chown=app:nodejs /out/api .
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
