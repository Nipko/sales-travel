ARG NODE_VERSION=20.18-alpine
ARG PNPM_VERSION=9.15.0

FROM node:${NODE_VERSION} AS base
# pnpm por COREPACK, actualizado antes de usarlo: mismo motivo que apps/api/Dockerfile (la imagen
# base trae claves de firma de npm caducadas y un npm que pnpm no puede verificar).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

FROM base AS builder
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
# Depende del ACL (@sales-travel/tbo-hotels) para validar la cuenta con las mismas reglas que el
# api, y a través de él de paquetes de packages/: se copian enteros y se construyen por el GRAFO
# (`^...`), como tools/sync-tbo-hotel-inventory.
COPY packages packages
COPY providers providers
COPY tools/seed-tbo-cert-tenant tools/seed-tbo-cert-tenant
RUN pnpm install --filter @sales-travel/seed-tbo-cert-tenant... --no-frozen-lockfile
RUN pnpm --filter "@sales-travel/seed-tbo-cert-tenant^..." run build
RUN pnpm --filter @sales-travel/seed-tbo-cert-tenant run build
RUN pnpm --filter @sales-travel/seed-tbo-cert-tenant deploy --prod /out/seed-tbo-cert-tenant

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=builder --chown=app:nodejs /out/seed-tbo-cert-tenant .
USER app
CMD ["node", "dist/index.js"]
