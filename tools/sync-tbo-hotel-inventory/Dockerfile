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
# A diferencia de tools/sync-hotel-inventory, esta herramienta depende del ACL
# (@sales-travel/tbo-hotels) y, a traves de el, de paquetes de packages/. Se copian enteros y las
# dependencias se construyen por el GRAFO (`^...`), no por una lista escrita a mano: es la leccion
# de apps/api/Dockerfile, donde una lista enumerada se quedo rancia con la primera dependencia nueva.
COPY packages packages
COPY providers providers
COPY tools/sync-tbo-hotel-inventory tools/sync-tbo-hotel-inventory
RUN pnpm install --filter @sales-travel/sync-tbo-hotel-inventory... --no-frozen-lockfile
RUN pnpm --filter "@sales-travel/sync-tbo-hotel-inventory^..." run build
RUN pnpm --filter @sales-travel/sync-tbo-hotel-inventory run build
RUN pnpm --filter @sales-travel/sync-tbo-hotel-inventory deploy --prod /out/sync-tbo-hotel-inventory

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs
COPY --from=builder --chown=app:nodejs /out/sync-tbo-hotel-inventory .
USER app
CMD ["node", "dist/index.js"]
