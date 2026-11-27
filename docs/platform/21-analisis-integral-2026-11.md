# 21 · Análisis integral de la plataforma (2026-11-25)

> Análisis crítico de lo que hay, lo que falta y cómo se compara con el mercado, en lo visual y en lo
> procedimental. Es el paso previo para arrancar las pruebas automatizadas (§8).
>
> **Fuentes:** lectura del código en `main` (`c1a0b3ce`, 2026-11-25), los docs de `docs/platform`,
> `docs/discovery`, `docs/research` y `docs/sabre`, búsqueda web para el mercado, y una corrida local del
> stack (API en Docker + Postgres TimescaleDB + Redis + panel en `next dev`) con un superadmin, una agencia y
> una vendedora **de prueba**, sin credenciales de proveedor.
>
> **Convención:** las rutas `archivo:línea` son relativas a la raíz del repo. «Verificado» = lo leí o lo
> reproduje; «no verificado» = no se pudo comprobar y se dice por qué.

---

## Resumen ejecutivo

**Dónde está la plataforma.** Sales-Travel tiene un núcleo B2B **sólido y por encima de lo que se ve en
el mercado en gobierno y red**: jerarquía multinivel con ltree, bóveda BYOC cifrada con herencia, carteras
con cupo y retención en cascada, superadmin supervisado, kill-switches por proveedor, auditoría en
`domain_events`, MFA obligatorio para roles de administración y RLS forzada en 45 de 56 tablas. La venta
de vuelos (Sabre + LATAM NDC), hoteles (TBO + Despegar/HotelDO) y autos (AgentCars) funciona de punta a
punta en el código, con revalidación de precio e idempotencia. La UI es moderna, oscura por defecto,
mobile-first real (sin scroll horizontal a 375 px en las pantallas de venta).

**Qué impide vender «de verdad» como consolidador en CO/PE/BR**, en orden:

1. **No se cobra al cliente.** No hay pasarela (Stripe/Mercado Pago): el dinero entra solo por cartera
   (depósitos informados) o por el enlace de pago de LATAM.
2. **No se factura.** Cero integración DIAN / SUNAT / NF-e. Es obligatorio por ley en los tres países.
3. **Posventa incompleta.** No hay reembolso en ningún proveedor ni cambio voluntario con commit; la
   decisión D9 exige Temporal **antes del primer reembolso real** y Temporal no existe.
4. **Emisión de Sabre no certificada** y reservas por el rodeo H-07 (urgente, ver §6.6).
5. **Paquetes solo cotizan**: no hay reserva conjunta ni saga entre proveedores; el «Package Studio
   drag-and-drop» (principio n.º 4) no existe todavía.
6. **El diferenciador conversacional no existe** (WhatsApp = enlace `wa.me`), y Rextur Advance (CVC,
   Brasil) ya vende aéreo por WhatsApp con IA en piloto: el «primer consolidador conversacional» deja de
   ser exclusivo.

**Calidad técnica.** Hay ~900 archivos de test y tests de aislamiento entre tenants que corren como
`app_user` sin BYPASSRLS — bien. Pero: **cobertura real ~15 %** de la API (umbral global de 13 %), **cero
E2E de navegador**, **deploy a producción no condicionado a que pase CI**, sin staging, sin backups
programados, sin observabilidad (ni OTel ni Sentry), rate limiting en memoria y `script-src
'unsafe-inline'` en el CSP del panel. Las tablas `tenants`, `users` y `password_reset_tokens` no tienen
RLS y `app_user` tiene DML completo sobre ellas.

**Docs.** Los docs de estado (10, 12) quedaron atrás en Package Studio y migraciones (llegan a 0093, el
repo a 0098); el doc 19 lista como abiertos PR ya mergeados; hay tres series de decisiones «D» que se
pisan; y CLAUDE.md promete piezas que no están (sops/age, staging, `packages/ui`, i18n PT/EN, 15 ports
usados — se usan 4).

**Recomendación de arranque de pruebas (§8.5):** empezar por un arnés E2E Playwright contra el stack local
con **proveedores falsos** (fixtures ya existen para Sabre y TBO), cubriendo login+MFA, alta de nodo,
búsqueda→cotización→reserva de vuelo y hotel, y los flujos de cartera; en paralelo, cerrar los huecos de
integración en Despegar, AgentCars, LATAM y `crm`.

---

## 1. Inventario de lo que existe hoy

### 1.1 Mapa general

| Área                       | Tamaño                                                              | Tests                            | Veredicto                                                                    |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api` (NestJS)        | ~99 k LOC sin tests, 41 módulos                                     | 392 archivos (83 de integración) | Núcleo B2B funcional; faltan pagos, factura, reembolso, paquetes reservables |
| `apps/web-b2b` (Next 15)   | 315 `.tsx`, 147 route handlers BFF, 16 archivos `'use server'`      | 328 vitest, 0 E2E                | Funcional en casi todas las rutas; paquetes y CRM parciales                  |
| `packages/*`               | canonical 1,6 k, core (ports), domain 2,1 k, validation 0,4 k       | 0                                | Tipos y contratos; **sin lógica de dominio**                                 |
| `providers/*`              | sabre 29 k, tbo 15 k, latam 3,3 k, despegar 2,6 k, agent-cars 1,4 k | 84 / 60 / 2 / 0 / 0              | Ver §1.4                                                                     |
| `db/migrations`            | 91 archivos (0001–0098), 56 tablas, 138 funciones SQL               | vía integración                  | Modelo maduro; mucha lógica en SQL `SECURITY DEFINER`                        |
| `infrastructure/hostinger` | compose prod + cert, Caddy, provision                               | —                                | Un solo entorno productivo                                                   |
| `tools/*`                  | migrador, seeds, syncs de inventario                                | 29                               | Funcional                                                                    |

### 1.2 `apps/api` — módulo por módulo

Prefijo global `/api` (`apps/api/src/main.ts:25`). «T/I» = archivos de test / de integración.

| Módulo                                                    | Qué hace                                                                   | Evidencia                                                                             | Estado                                                          | T/I         |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| auth                                                      | Login, sesiones, MFA TOTP, step-up, reset, puestos                         | 24 rutas en `apps/api/src/auth/auth.controller.ts:75-367`                             | Punta a punta                                                   | 29/8        |
| me                                                        | Perfil y membresías                                                        | `me/me.controller.ts:43,67,86`                                                        | Punta a punta                                                   | 5/1         |
| tenants                                                   | Nodos, invitaciones, puestos, branding, soporte                            | 12 controllers, ~45 rutas (`tenants/admin.controller.ts:194-647`)                     | Punta a punta                                                   | 31/12       |
| network                                                   | `canAccessTenant`, resolución por host, `SuperadminGuard`                  | —                                                                                     | Infraestructura                                                 | 5/4         |
| search                                                    | Vuelos: fan-out, caché, circuit breaker, offer-price, seat-map, calendario | `search/search.controller.ts:139-298`                                                 | Punta a punta                                                   | 17/1        |
| orders                                                    | Ciclo de vida de vuelos y posventa                                         | 21 rutas `orders/orders.controller.ts:201-666` + 8 admin                              | Punta a punta **sin reembolso**                                 | 64/16       |
| hotels                                                    | TBO + Despegar: búsqueda, contenido, prebook, book, cancel, recovery       | 20 rutas `hotels/hotels.controller.ts:133-403`                                        | Punta a punta (sin modificar reserva)                           | 60/9        |
| cars                                                      | AgentCars: búsqueda, reserva, cancelación, reporte                         | `cars/cars.controller.ts:61-160`                                                      | Punta a punta; el neto llega del cliente (§5.2)                 | 6/0         |
| packages                                                  | Cotización multiproducto                                                   | `packages/packages.controller.ts:42-93`                                               | **Parcial**: solo cotiza                                        | 1/0         |
| quotations                                                | Cotizaciones, envío por email, datos del facturado                         | `quotations/quotations.controller.ts:46-124`                                          | Punta a punta                                                   | 3/1         |
| pricing                                                   | Cascada de markup                                                          | `pricing/pricing.controller.ts:43-97`                                                 | **Parcial**: sin comisión del vendedor                          | 3/1         |
| portfolios                                                | Carteras, crédito, depósitos, retenciones en red                           | `portfolios/portfolios.controller.ts:81-220`, `wallet-financing.controller.ts:67-162` | Punta a punta                                                   | 22/11       |
| provider-credentials                                      | Bóveda BYOC con herencia                                                   | `provider-credentials/provider-credentials.controller.ts:51,91,109`                   | Punta a punta                                                   | 6/1         |
| provider-enablement                                       | Habilitación global/por nodo, kill-switch, circuito                        | 10 rutas `provider-enablement.controller.ts:137-234`                                  | Punta a punta                                                   | 8/2         |
| provider-disclosure                                       | Qué proveedor ve cada nodo                                                 | `provider-disclosure.controller.ts:41,53`                                             | Punta a punta                                                   | 5/1         |
| provider-payloads                                         | Bóveda cifrada de payloads + purga                                         | cron `'17 3 * * *'` (`provider-payloads-purge.scheduler.ts:11`)                       | Punta a punta                                                   | 7/1         |
| governance                                                | Perfiles de gobierno y formas de pago por nodo                             | `governance/governance.controller.ts:127-217`                                         | Punta a punta                                                   | 2/0         |
| booking-permissions                                       | Permiso de tarifas no reembolsables por nodo                               | `booking-permissions.controller.ts:29,37`                                             | Punta a punta (un flag)                                         | 2/1         |
| reconciliation                                            | Conciliación diaria de reservas de hotel contra el proveedor               | `reconciliation/reconciliation.controller.ts:72,83`                                   | **Parcial**: solo hoteles, operativa, no financiera             | 4/1         |
| reports                                                   | Dashboard, operaciones, métricas, comisiones                               | `reports/reports.controller.ts:23-53`                                                 | **Parcial**: comisiones es stub (`reports.service.ts:138-146`)  | 3/1         |
| audit                                                     | `domain_events` y lecturas                                                 | `audit/audit.service.ts:235`                                                          | Punta a punta                                                   | 10/2        |
| platform-admins                                           | Superadmins plenos/supervisados, solicitudes de cambio                     | `platform-admins.controller.ts:90-186`                                                | Punta a punta                                                   | 2/1         |
| admin-console                                             | Consola del superadmin (estado, sistema, tenants)                          | `admin-console/*.controller.ts`                                                       | Punta a punta (lectura)                                         | 15/3        |
| announcements                                             | Avisos de plataforma                                                       | `announcements/*.controller.ts`                                                       | Punta a punta                                                   | 3/1         |
| customers                                                 | Clientes con PII cifrada                                                   | `customers/customers.controller.ts:36-108`                                            | Punta a punta                                                   | 1/0         |
| crm                                                       | Oportunidades, tareas, interacciones                                       | `crm/*.controller.ts`                                                                 | **Parcial**: CRUD sin UI para tareas/interacciones, **0 tests** | 0/0         |
| mail                                                      | SMTP + avisos de seguridad                                                 | `mail/mail.controller.ts:35`                                                          | Punta a punta                                                   | 10/1        |
| storage                                                   | Brand assets                                                               | `storage/local-disk-storage.adapter.ts:17,76`                                         | **Parcial**: disco local, sin S3/MinIO                          | 0/0         |
| airports                                                  | Autocompletado                                                             | `airports/airports.controller.ts:14`                                                  | Punta a punta (sin ranking)                                     | 0/0         |
| queue                                                     | BullMQ `post-sale-retry`, barrido 15 min, conciliación `'30 4 * * *'`      | `queue/post-sale-queue.service.ts:297,418,446`                                        | Punta a punta                                                   | 2/1         |
| throttler                                                 | Límites por IP y por vendedor                                              | `throttler/seller-rate-limit.guard.ts:43`                                             | Completo pero **en memoria**                                    | 2/0         |
| health                                                    | `/health` (BD + circuit breaker)                                           | `health/health.controller.ts:32`                                                      | Punta a punta (mínimo)                                          | 1/0         |
| providers-sabre / -latam / -tbo / -despegar / -agent-cars | Factories y adapters                                                       | §1.4                                                                                  | Ver proveedor                                                   | 11/3/9/13/4 |
| database, request-context, lifecycle, zod, branding       | Infraestructura                                                            | `database/database.service.ts:41-66`                                                  | Completo                                                        | —           |

Colas y cron (BullMQ): `post-sale-retry` (verify-creation, compensate, cancel, issue, verify-issue,
verify-hotel-booking, verify-cancellation, hcn-check, reconcile-provider-account),
`cars-pending` (`'7,37 * * * *'`, `cars/cars-pending-sweep.scheduler.ts:11`), `provider-payloads`
(purga diaria). El kill-switch se relee cada 10 s por réplica (`provider-enablement/kill-switch.store.ts:20`).

Deuda de marcadores: **0 TODO/FIXME reales** en `apps/api` (las coincidencias son la palabra «todo»).
Las operaciones no soportadas de Sabre lanzan `SabreOperationNotSupportedError`
(`providers-sabre/sabre-errors.ts:297`; lanzado en `sabre.factory.ts:442,664,668,783,806,818,830,842,860,878,887,891,895,899`),
documentadas como decisión, no como TODO.

### 1.3 `apps/web-b2b` — rutas

Patrón: `page.tsx` finos → `_components` → `lib/*-client.ts` → route handlers `src/app/api/**` (BFF) →
API Nest por `INTERNAL_API_URL` (`apps/web-b2b/src/lib/api.ts:4`), con identidad del cliente firmada por
`x-internal-proxy` (`lib/api.ts:13-19`).

| Área                | Rutas                                                                                                                                                  | Estado                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Acceso              | `/login` (MFA en dos pasos, `login/actions.ts:92-110`), `/verificar`, `/olvide-password`, `/restablecer`, `/invitacion`                                | Funcional (verificado en vivo)                    |
| Inicio              | `/` (panel «Hoy», KPIs, agencias asignadas)                                                                                                            | Funcional (verificado)                            |
| Vuelos              | `/cotizaciones`, `/cotizaciones/[id]` (checkout, asientos, offer-price), `/cotizaciones/guardadas`                                                     | Funcional (búsqueda verificada sin proveedores)   |
| Hoteles             | `/hoteles`, `/hoteles/[hotelKey]`, `/hoteles/checkout`                                                                                                 | Funcional (formulario verificado)                 |
| Autos               | `/autos`, `/autos/oficinas`, `/autos/reporte`                                                                                                          | Funcional (no ejecutado)                          |
| Paquetes            | `/paquetes`, `/paquetes/guardados`, `/paquetes/[id]`                                                                                                   | **Parcial**: cotiza; sin drag-and-drop ni reserva |
| Reservas            | `/reservas`, `/reservas/[id]` (cancelar, emitir, void, pagar, enlace de pago, reshop, servicios)                                                       | Funcional (lista vacía verificada)                |
| Clientes / CRM      | `/clientes`                                                                                                                                            | **Parcial**: sin tareas ni interacciones          |
| Reportes / carteras | `/reportes` (solo `sales-metrics`), `/carteras`                                                                                                        | Funcional acotado                                 |
| Mi agencia          | `/configuracion`, `/configuracion/perfil`, `/configuracion/seguridad`, `/admin/usuarios`, `/admin/proveedores`                                         | Funcional                                         |
| Red                 | `/red`, `/red/[tenantId]/carteras`                                                                                                                     | Funcional (alta de nodo verificada)               |
| Superadmin          | `/admin/plataforma/{estado,salud,resumen,actividad,sistema,anuncios,reservas,carteras,proveedores,gobierno,usuarios,superadmins}`, `/admin/tenants/**` | Funcional (estado y proveedores verificados)      |

Observaciones de código: UI estilo shadcn **hecha a mano** (Radix solo para dropdown/label/slot; no existe
`packages/ui`); **sin i18n** (todo en español, `lang="es"` en `app/layout.tsx:26`), aunque el alta de nodo
ofrece idioma Portugués/Inglés; componentes de 1.000–2.100 líneas (`app/(app)/red/page.tsx` 2.129,
`reservas/page.tsx` 1.629, `components/ui/date-range-picker.tsx` 1.487).

### 1.4 `providers/*`

| Proveedor           | Search                    | Price              | Book               | Emitir                                                                                         | Cambio                                          | Void / cancel                          | Reembolso                                                 | Tests                              | Fixtures                                       |
| ------------------- | ------------------------- | ------------------ | ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| **sabre**           | Sí (+returns, more fares) | Sí (+flight check) | Sí, con rodeo H-07 | Sí, apagado salvo `SABRE_OPERATIONS` (`apps/api/src/providers-sabre/sabre.factory.ts:214,783`) | Modificar pasajeros (gateado); sin exchange     | Cancel sí; void gateado, sin parciales | **No** (`'refund'` no se consume, `sabre.factory.ts:212`) | 84                                 | 13 JSON + `spec/manifest.json` + workflow CERT |
| **latam-ndc**       | AirShopping               | OfferPrice         | OrderCreate        | Pago = emisión (`payOrder`, `sendPaymentLink`)                                                 | Solo recotiza (`reshopWithTickets`), sin commit | Cancel + BNPL                          | **No**                                                    | **2**                              | 1 XML sintético                                |
| **tbo-hotels**      | Sí                        | Rates detail       | Prebook + book     | n/a                                                                                            | No                                              | Cancel                                 | Flag `refund_awaited`                                     | 60                                 | Muchos (envelope, pdf, postman)                |
| **despegar-hotels** | Sí                        | Prebook            | Book + recover     | n/a                                                                                            | Special requests                                | Cancel quote/preview/cancel            | No                                                        | **0** en el paquete (13 en la API) | **Ninguno**                                    |
| **agent-cars**      | Sí                        | Rate detail        | Confirm            | n/a                                                                                            | No                                              | Cancel + release                       | No                                                        | **0** en el paquete (10 en la API) | **Ninguno**                                    |

### 1.5 `packages/*`

- `core`: **15 ports** (`packages/core/src/ports/`), pero solo se usan 4: `LoggerPort`, `MetricsPort`,
  `CachePort`, `BlobStoragePort`. Los otros 11 (Clock, Crypto, EventBus, FeatureFlags, IdGenerator,
  JobQueue, Notification, SearchIndex, SecretsManager, Tracer, WorkflowEngine) no tienen consumidores.
  Los errores tipados (`packages/core/src/errors/index.ts:1-48`) **no se importan en ningún sitio**.
- `domain`: ports de proveedor (flight-search, order-create, hotel-book, …) y `governance/catalog.ts`.
  **Sin entidades ni lógica de negocio**; 0 tests. La lógica real vive en `apps/api` y en **138 funciones
  SQL** (`compute_price_waterfall`, `resolve_provider_account`, ~30 `wallet_hold_*`, `move_tenant_subtree`…).
- `canonical`: tipos (offer, hotel-offer, seat-map, money…). `validation`: `iso-3166`, `person-name`.

### 1.6 `db/migrations` — modelo de datos

- **Red:** `tenants` + `parent_tenant_id` + ltree `path` (`0011_tenant_hierarchy.sql:7-17`), tipos
  platform/consolidator/agency/subagency, reglas de jerarquía y mover subárbol (0050, 0051). «Vendedor» es
  rol, no nodo.
- **Identidad:** `users`, `memberships`, `sessions`, MFA, dispositivos de confianza, invitaciones (0026–0028,
  0055, 0056).
- **BYOC:** `provider_accounts.credentials_enc` AES-256-GCM (`0012_provider_accounts.sql:12,24`).
- **Pricing:** `markup_rules`, `compute_price_waterfall` (0016), `applicable_markup_rules` (0017),
  gobierno (0089).
- **Órdenes:** `orders` con snapshots JSONB (`0005_orders.sql`) — **sin tablas normalizadas de segmento ni
  pasajero**; tracking de vuelo/hotel, documentos, ancillaries, idempotencia.
- **Carteras:** `agency_portfolios`, `portfolio_transactions`, retenciones en cascada (0052, 0060).
- **Auditoría:** `domain_events` (0015), `search_logs` (0032).
- **RLS:** ENABLE + FORCE en **45/56** tablas, ~87 policies. Sin RLS: catálogos globales (correcto) y
  **`tenants`, `users`, `password_reset_tokens`** con `GRANT SELECT, INSERT, UPDATE, DELETE` a `app_user`
  (`db/migrations/0001_init.sql:93`, `0028`).
- **TimescaleDB y pgvector instalados pero sin uso** (0 hypertables, 0 columnas `vector`).
- Numeración: dos `0055_*` y huecos (0057–0059, 0071–0074, 0080). El runner ordena por nombre, así que
  funciona, pero confunde.

### 1.7 Infraestructura, CI/CD y tools

- **Entornos:** solo `prod` (`infrastructure/hostinger/docker-compose.prod.yml`) y `cert` (stack de
  certificación TBO). **No hay dev ni staging desplegados**, aunque CLAUDE.md los promete.
- **CI** (`.github/workflows/ci.yml`): format, build, lint, typecheck, y tests con Postgres 16 + Redis como
  services (migraciones reales, `app_user` sin BYPASSRLS). Sin E2E, sin coverage publicado, sin escaneo de
  seguridad; `pnpm install --no-frozen-lockfile` (`ci.yml:32,109`). Postgres de CI sin TimescaleDB ni
  pgvector (distinto de prod).
- **Deploy** (`.github/workflows/deploy.yml:3-6,99`): push a `main` → build de 8 imágenes → SSH → compose;
  **no espera a CI** (no hay `workflow_run` ni gate). Smoke `curl /api/health`. Rollback manual fijando
  `IMAGE_TAG` (`infrastructure/hostinger/README.md:195-201`).
- **Backups:** solo un `pg_dumpall` manual documentado (`infrastructure/hostinger/README.md:207-209`).
- **Secretos:** GitHub Secrets → `.env` renderizado y subido por rsync. **No hay sops/age.**
- **Tools:** `db-migrate`, `seed-superadmin`, `seed-tbo-cert-tenant`, syncs de aeropuertos e inventario
  hotelero (crons en GitHub Actions), arnés de certificación Sabre.

---

## 2. Comparación con la documentación

### 2.1 Documentado y no implementado

| Promesa                                                                                                                | Dónde                                               | Realidad                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ola 1 cerrada a nov-2026 (Stripe+MP, factura DIAN, WhatsApp IA, asistencias, PCI AOC, 5+ agencias con reservas reales) | `docs/discovery/07-roadmap-olas.md:333-343`         | No cerrada; el propio doc lo admite (`07:31-36`)                                                                                                                          |
| Package Studio drag-and-drop                                                                                           | CLAUDE.md principio 4                               | Hay builder por carriles sin DnD (`paquetes/_components/package-lanes.tsx`)                                                                                               |
| Comisión del vendedor en el waterfall                                                                                  | CLAUDE.md «Modelo consolidador»                     | No existe; reporte de comisiones `available: false` (`apps/api/src/reports/reports.service.ts:143,371`)                                                                   |
| Temporal antes del primer reembolso (D9)                                                                               | `docs/sabre/10-requisitos-maestro.md:1307-1321`     | Temporal no existe; reembolso tampoco                                                                                                                                     |
| i18n ES/PT/EN (`packages/i18n`)                                                                                        | CLAUDE.md estructura                                | No hay i18n; tenants pueden elegir PT/EN sin efecto                                                                                                                       |
| `packages/ui`, `packages/sdk`                                                                                          | CLAUDE.md estructura                                | No existen                                                                                                                                                                |
| 15 abstracciones de infra «detrás de interfaces»                                                                       | CLAUDE.md principio 7                               | Existen 15, se usan 4; BullMQ/ioredis se importan directo desde `apps/api` (`queue/redis-connection.ts`, `orders/post-sale.worker.ts`, `search/search-cache.adapter.ts`…) |
| Errores tipados en `packages/core/errors`                                                                              | CLAUDE.md convenciones                              | Definidos, 0 usos                                                                                                                                                         |
| Logging JSON con OpenTelemetry                                                                                         | CLAUDE.md convenciones                              | Logger de Nest en texto (`apps/api/src/main.ts:14`); sin OTel                                                                                                             |
| Coverage >70 % domain, >50 % global                                                                                    | CLAUDE.md tests                                     | ~15 % API; umbral 13 % (`apps/api/vitest.config.ts:60-64`); domain sin tests                                                                                              |
| E2E con Playwright                                                                                                     | CLAUDE.md tests                                     | No existe                                                                                                                                                                 |
| Secretos con sops+age                                                                                                  | CLAUDE.md seguridad                                 | No existe                                                                                                                                                                 |
| CSP estricto                                                                                                           | CLAUDE.md seguridad                                 | Panel con `script-src 'self' 'unsafe-inline'` (`apps/web-b2b/next.config.ts:19`)                                                                                          |
| Entornos dev/staging/prod                                                                                              | CLAUDE.md stack                                     | Solo prod + cert                                                                                                                                                          |
| Link público de la cotización (Ola 1)                                                                                  | `docs/platform/10-mapa-completo-plataforma.md:1701` | Doc 20 decidió no tenerlo                                                                                                                                                 |
| Hypertable de `domain_events`, pgvector                                                                                | CLAUDE.md, doc 05                                   | Tablas planas; extensión instalada sin uso                                                                                                                                |

### 2.2 Implementado y no (o mal) documentado en el mapa

Calendario de precios (0094), salud de búsqueda por proveedor (0095–0096), `quote_number` único (0097),
paquetes (0098), seat map Sabre, plazos y alertas de emisión (0081–0085), aviso de proveedor
(`provider-disclosure`, 0036), permisos de tarifas no reembolsables (0055), tarifas en otra moneda (0087),
puestos simultáneos y cierre por inactividad, consola «Estado» con pendientes del proyecto
(`apps/api/src/admin-console/project-pendings.ts`), barrido de autos en espera. Los docs 10 y 12 dicen
«0001–0093»: faltan cinco migraciones.

### 2.3 Contradicciones

1. **D9 mal resumida.** `docs/research/05-arquitectura-referencia.md:139` y CLAUDE.md dicen que BullMQ
   «sustituye» a Temporal; D9 (`docs/sabre/10-requisitos-maestro.md:1307-1321`) dice BullMQ **hasta la
   emisión** y Temporal antes del primer reembolso. El código lo recuerda (`apps/api/src/orders/order-create.saga.ts:16-18`).
2. **Tres series de decisiones «D»** con las mismas etiquetas: D1–D5 de junio (`12:459-463`, cerradas), D1–D7
   de la red de septiembre (`12:171-177`, D2/D3/D5 abiertas) y D0–D9 del expediente Sabre. D5 aparece
   cerrada en `12:463` y «a confirmar» en `12:525`.
3. **HotelDO:** `10:58` dice Despegar = HotelDO v3; `07-roadmap:28` y `03-integraciones:17` dicen «No HotelDo».
   La ACL de Despegar **es** la API de HotelDO, así que el gap «falta HotelDO» es falso.
4. **Número de ports:** 15 (CLAUDE.md), 8 obligatorios (`05 §4.1`), 14 (`05:145`).
5. **Package Studio:** docs 10 y 12 lo dan por «❌ sin pantalla»; doc 20 y el commit #71 muestran pantalla.
6. **Doc 19 §6.1** lista como abiertos los PR #53–#67, ya mergeados.
7. **CLAUDE.md** prohíbe importar Redis o colas desde `apps/`; el código lo hace en seis archivos
   (`apps/api/src/queue/redis-connection.ts`, `queue/post-sale-queue.service.ts`,
   `orders/post-sale.worker.ts`, `search/search-cache.adapter.ts`, `cars/cars-pending-sweep.scheduler.ts`,
   `provider-payloads/provider-payloads-purge.scheduler.ts`). `05:146-147` lo reconoce.

---

## 3. Mercado: qué tienen las plataformas comparables

Fuentes: `docs/research/06-competencia-latam.md`, `docs/research/03-integraciones-ecosistema.md` y búsqueda
web (≈20 consultas, nov-2026). Casi todo lo de proveedores globales es material comercial de la propia
empresa; lo de consolidadores LATAM, prensa del sector. Lo no confirmado va marcado «?».

### 3.1 Novedades que cambian las premisas de los docs

- **Rextur Advance (CVC, Brasil)** vende aéreo completo por WhatsApp (texto o voz, de búsqueda a emisión),
  en piloto con ~200 agencias, más un agente que vigila cambios posemisión
  ([Mercado & Eventos](https://www.mercadoeeventos.com.br/?p=727967),
  [PANROTAS 04/2026](https://www.panrotas.com.br/mercado/consolidadoras/2026/04/panrotas-next-rextur-advance-aposta-em-tecnologia-e-agilidade-para-impulsionar-vendas_228058.html)).
  Contradice la tesis de `06:101` («nadie en LATAM…»).
- **Los grandes ya tienen IA en la herramienta del agente:** Bedsonline relanzado con IA (mar-2026,
  [HBX](https://www.hbxgroup.com/news-room/press-release/hbx-group-unveils-new-bedsonline-powered-ai-designed-help-agents)),
  Amadeus Max en Selling Platform Connect ([Amadeus](https://amadeus.com/en/travel-sellers/products/amadeus-max-for-travel-sellers)),
  APIs agénticas y servidor MCP de Sabre ([Travel Weekly](https://www.travelweekly.com/Travel-News/Travel-Technology/Sabre-launches-agentic-AI-solutions)).
- **Despegar (Prosus desde 2025)** apunta a que B2B sea la mitad de su negocio
  ([iProfesional](https://www.iprofesional.com/negocios/465505-las-tres-apuestas-de-despegar-para-triplicar-su-tamano)):
  es a la vez proveedor (HotelDO) y competidor.

### 3.2 Matriz de capacidades

Gap: **C** crítica · **I** importante · **D** deseable.

| Capacidad                                                      | Sales-Travel                                                   | Juniper | TBO     | Bedsonline | GDS (SPC/Red 360/Travelport+) | Consolidadores LATAM | Gap                     |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------- | ------- | ---------- | ----------------------------- | -------------------- | ----------------------- |
| Aéreo multi-GDS                                                | Parcial: Sabre + LATAM NDC; emisión sin certificar             | Sí      | Sí      | No         | Un GDS c/u                    | Sí (inferido)        | **C**                   |
| NDC                                                            | Parcial: LATAM                                                 | Sí      | ?       | No         | Sí, con posventa              | Rextur, Flytour: Sí  | I                       |
| Hoteles (bedbank)                                              | Sí: HotelDO + TBO                                              | Sí      | Sí      | Sí         | Parcial                       | ?                    | I (estabilizar TBO)     |
| Autos                                                          | Sí (AgentCars)                                                 | ?       | ?       | Parcial    | Sí                            | ?                    | —                       |
| Traslados / actividades / asistencia                           | No                                                             | Sí      | Sí      | Sí         | Parcial                       | Sakura, Costamar: Sí | **C**                   |
| Paquetes dinámicos                                             | Parcial: cotiza, no reserva                                    | Sí      | ?       | Parcial    | No                            | ?                    | I                       |
| Mid/back office, contabilidad, BSP                             | Parcial: órdenes + conciliación operativa                      | Sí      | ?       | No         | ?                             | ?                    | **C**                   |
| Crédito / depósito / wallet                                    | Sí (cupo, retención en cascada); sin recarga real ni extractos | Sí      | Sí      | Sí         | n/a                           | ?                    | I                       |
| Factura electrónica local                                      | **No**                                                         | ?       | ?       | ?          | ?                             | ?                    | **C** (legal)           |
| Cobro al cliente (pasarela)                                    | **No** (solo enlace LATAM)                                     | Sí      | Sí      | Sí         | n/a                           | Sí                   | **C**                   |
| Posventa (cambio/void/reembolso)                               | Parcial: void, cancel, reshop LATAM; sin reembolso             | ?       | ?       | Parcial    | Sí                            | Rextur: Sí           | **C**                   |
| Colas / plazos de emisión                                      | Parcial: alertas de plazo; sin colas GDS                       | ?       | ?       | n/a        | Sí                            | Parcial              | I                       |
| Sitio B2C white-label                                          | No                                                             | Sí      | Sí      | ?          | ?                             | Aviatur: Sí          | I                       |
| Red de sub-agencias + BYOC con herencia                        | **Sí**                                                         | Parcial | Parcial | No         | BYOC sin red                  | ?                    | **Ventaja**             |
| Markup en cascada                                              | Parcial: sin comisión del vendedor                             | Parcial | ?       | ?          | ?                             | ?                    | I                       |
| Reporting / BI                                                 | Parcial                                                        | Sí      | ?       | ?          | ?                             | ?                    | I                       |
| API para agencias                                              | No                                                             | Sí      | Sí      | Sí         | Sí                            | Flytour: Sí          | I                       |
| WhatsApp / conversacional                                      | No (`wa.me`)                                                   | ?       | ?       | No         | Sabre: MCP                    | **Rextur: Sí**       | **C** (posicionamiento) |
| IA                                                             | No                                                             | Parcial | Parcial | Sí         | Sí                            | Rextur: Sí           | **C**                   |
| App móvil                                                      | No (web responsive, sin PWA)                                   | ?       | ?       | ?          | ?                             | Sakura: Sí           | D                       |
| Gobierno (MFA, superadmin supervisado, kill-switch, auditoría) | **Sí**                                                         | ?       | ?       | ?          | ?                             | ?                    | Ventaja (no verificada) |
| Idiomas ES/PT/EN                                               | Solo ES                                                        | Sí      | Sí      | Sí         | Sí                            | PT en Brasil         | **C para Brasil**       |

**Lectura.** Las fortalezas reales (red multinivel con BYOC y herencia, carteras con retención en cascada,
gobierno y auditoría, multiproveedor con kill-switch) no aparecen juntas en ninguna fuente pública de un
consolidador LATAM — **no verificado**, habría que confirmarlo con demos. Lo que falta para competir es
justo la base comercial que todos dan por hecha: cobrar, facturar, posventa, verticales y portugués.

---

## 4. Lo visual / UX (revisión en vivo)

**Cómo se probó.** Stack local: API (imagen Docker de `apps/api/Dockerfile`), Postgres
`timescaledb-ha:pg16-ts2.26` con las 91 migraciones, Redis 7 y el panel en `next dev` (config
`web-b2b-dev-node` en `.claude/launch.json`). Usuarios de prueba: un superadmin (seed) con MFA activado y
una vendedora en una agencia creada desde la UI. **Sin credenciales de proveedor**, así que no se pudo
recorrer selección → checkout → reserva con ofertas reales ni medir el tiempo a venta (ver §4.4).

### 4.1 Hallazgos por pantalla

| Pantalla                   | Hallazgo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Severidad                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Login                      | Limpio, en dos columnas, foco y etiquetas correctas. Copy de marketing («la plataforma más moderna y potente de LATAM», «inteligencia artificial») promete IA que no existe                                                                                                                                                                                                                                                                                                                                                                                             | Baja                       |
| Alta de MFA obligatoria    | Bloquea bien al superadmin antes de usar el panel; clave manual, 6 dígitos con envío automático, 10 códigos de recuperación con confirmación explícita. **Pero** la página de inicio dispara 4 llamadas que responden 403 `MFA_ENROLLMENT_REQUIRED` antes de mostrar el gate (log del panel)                                                                                                                                                                                                                                                                            | Baja                       |
| Estado (superadmin)        | Tarjetas «En orden» claras y pendientes del proyecto (H-07 visible como «Crítico»). **Falso verde:** «Proveedores: sin búsquedas en los últimos 7 días» aparece como «En orden» con **cero proveedores configurados**                                                                                                                                                                                                                                                                                                                                                   | Media                      |
| Mi Red → Nuevo nodo        | Diálogo bien explicado (Agencia/Sucursal/Consolidador). **Error de validación invisible:** «Puestos simultáneos» es obligatorio, queda fuera de la vista; al pulsar «Crear agencia» no pasa nada visible: el foco se queda en el botón y el `alert` está abajo del scroll. El selector de idioma ofrece Portugués/Inglés que la UI no soporta. Toast «Agencia Agencia Prueba QA creada…» (duplica la palabra)                                                                                                                                                           | **Alta** (bloquea un alta) |
| Inicio (vendedora)         | Insignia «CONSOLIDADOR ACTIVO» en el panel de una vendedora de agencia: confunde el rol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Baja                       |
| Vuelos `/cotizaciones`     | Formulario compacto, buen autocompletado por código IATA. El ranking del autocompletado mezcla aeropuertos irrelevantes (BOG → «Bogalusa», «Bogorodskoye») y escribe «Bogota» sin tilde. Pulsar Enter en destino antes de que carguen resultados envía el formulario. **Sin proveedores habilitados dice «Ningún vuelo disponible… prueba cambiando las fechas»**: culpa a la búsqueda en vez de decir que la agencia no tiene proveedores. La búsqueda no queda en la URL (confirmado: sigue `/cotizaciones`) → atrás y compartir pierden el estado (doc 19 lo señala) | Media                      |
| Hoteles `/hoteles`         | Funcional, pero **otro lenguaje visual** que vuelos: etiquetas arriba, `select` nativos, moneda «Cargando…» al entrar; texto de ayuda largo. Siete campos antes de buscar                                                                                                                                                                                                                                                                                                                                                                                               | Media                      |
| Paquetes `/paquetes`       | Tres toggles (vuelo/hotel/auto) y una búsqueda: buena idea. El título queda pegado a la barra superior y, a 375 px, **sin margen lateral** (la tarjeta toca los bordes), a diferencia del resto. Título de pestaña «Paquetes» en vez de «Sales-Travel · …»                                                                                                                                                                                                                                                                                                              | Media                      |
| Reservas                   | Estado vacío correcto; esqueletos de carga coherentes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                          |
| Tema claro                 | Botón primario naranja con texto blanco: **contraste 3,87:1** (falla AA para texto de 15 px)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Alta (a11y)**            |
| Menú lateral (ambos temas) | Encabezados de sección y slug a 9–10 px con contraste 4,23:1; versión 2,66:1. Falla AA y es ilegible en móvil                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Media                      |
| Barra superior a 375 px    | Nombre de agencia truncado («Agencia …») y el selector de tema (3 botones) ocupa el espacio. El tema no es una acción de venta                                                                                                                                                                                                                                                                                                                                                                                                                                          | Baja                       |
| Rendimiento percibido      | En `next dev` las primeras cargas tardan 5–15 s (compilación); **no es representativo de prod** y no se midió en build de producción                                                                                                                                                                                                                                                                                                                                                                                                                                    | No medido                  |

### 4.2 Mobile-first (375 px)

Verificado en `/cotizaciones`, `/hoteles`, `/paquetes` y `/reservas`: **sin scroll horizontal**
(`scrollWidth = 375`), objetivos táctiles ≥ 24 px (los únicos menores eran inputs ocultos de 1 px), menú
hamburguesa, formularios apilados. Hay patrones específicos (`components/layout/mobile-nav.tsx`,
`filters-sheet`, `MobileCheckoutBar`). Bien resuelto salvo el margen de paquetes y la barra superior.

### 4.3 Estilo «Linear/Stripe» y WCAG AA

- **Estilo:** cumple en general (oscuro sobrio, jerarquía clara, un acento). Rompe la consistencia la
  mezcla de dos sistemas de formulario (vuelos vs hoteles/paquetes) y la ausencia de una librería de
  componentes compartida (`packages/ui` no existe).
- **WCAG:** buena base en código (≈2.000 `aria-*`, 699 `focus-visible`, 264 `sr-only`, diálogos con
  `role`), pero **sin auditoría automática** (no hay `eslint-plugin-jsx-a11y` ni axe). Fallos medidos:
  contraste del botón primario en tema claro y de los textos de 9–10 px del menú; errores de formulario
  que no reciben foco (alta de nodo). Solo 100 `htmlFor` para cientos de campos: conviene revisar
  asociación etiqueta-campo con axe.

### 4.4 «Tiempo a venta < 2 minutos»

**No se pudo medir en vivo** (sin proveedores). Del código y del doc 19: la ida y vuelta hace un shop
nuevo sin caché al elegir la ida (3–8 s), la escalera de degradación de Sabre puede superar los 100 s de
Cloudflare (falta un plazo global de ~45 s), y la reserva revalida dos veces si el precio tiene más de 5
minutos. Con 3–4 pasajeros escritos a mano, el flujo de vuelo **probablemente supera los 2 minutos**; el
principio no tiene hoy ninguna medición que lo vigile. Es un candidato directo para un test E2E
cronometrado con proveedor falso (§8).

---

## 5. Lo procedimental / operativo

### 5.1 Ciclo de vida de la reserva

| Paso              | Vuelos LATAM NDC                                                                                                 | Vuelos Sabre                                     | Hoteles (TBO/Despegar)                                                                                   | Autos                 | Paquetes           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------- | ------------------ |
| Cotizar           | Sí                                                                                                               | Sí                                               | Sí                                                                                                       | Sí                    | **Sí (solo esto)** |
| Revalidar precio  | OfferPrice + revalidación en `createOrder` (`apps/api/src/orders/orders.service.ts:659,917-955`) → 409 si cambia | Ídem                                             | `decideAfterRevalidation` (`hotels/hotel-booking.saga.ts:112-134`): sube → rechaza; baja → sigue y avisa | **No en el servidor** | —                  |
| Reservar          | Sí, idempotente                                                                                                  | Sí (rodeo H-07)                                  | Sí, con saga propia y verificación a 120 s                                                               | Sí                    | **No**             |
| Emitir            | Pago = emisión                                                                                                   | Apagado salvo `SABRE_OPERATIONS`; sin certificar | n/a                                                                                                      | n/a                   | —                  |
| Cambiar           | Recotiza sin commit                                                                                              | No                                               | Solo special requests                                                                                    | No                    | —                  |
| Anular / cancelar | Sí                                                                                                               | Cancel sí, void gateado                          | Sí                                                                                                       | Sí                    | —                  |
| Reembolsar        | **No**                                                                                                           | **No**                                           | Flag `refund_awaited`                                                                                    | **No**                | —                  |

### 5.2 Cambios de precio

Bien resuelto en vuelos y hoteles: el precio que manda el cliente se descarta y se recalcula desde la BD;
409 explícito si cambian precio, moneda, familia o vigencia; ancillaries con `priceChanged`
(`orders/order-services.service.ts:279`). **Autos:** el neto (`realBase`, `realTax`, `total`) llega del
cliente y se manda al proveedor tal cual (`apps/api/src/cars/cars.service.ts:162-196`); el precio de venta
se calcula sobre ese neto. Si AgentCars no rechaza un total manipulado, la orden y la retención de cartera
pueden quedar mal. **No verificado** contra el sandbox; hay que confirmarlo y, en todo caso, recalcular el
neto en el servidor desde `rate-detail`.

### 5.3 Sagas y compensación

`apps/api/src/orders/order-create.saga.ts` es lógica pura (crear → verificar → compensar por ítem), con el
vuelo como ESSENTIAL y hotel/auto/asiento como ACCESSORY (`:93`), y corre sobre BullMQ
(`queue/post-sale-queue.service.ts:12-53`, `orders/post-sale.worker.ts:77-120`). **Límite:** compensa ítems
de **una orden de un proveedor**; no hay saga entre proveedores, por eso los paquetes no se pueden
reservar. Temporal sigue pendiente por D9.

### 5.4 Conciliación

Diaria (`'30 4 * * *'`), solo **hoteles** (TBO y Despegar listan por fecha), reglas R1–R8, solo lectura
(`apps/api/src/reconciliation/reconciliation.plan.ts:6-50`). **No es financiera**: no concilia BSP/ADM,
carteras contra libro, ni vuelos.

### 5.5 Facturación electrónica

Nada implementado; solo se capturan datos del facturado con el documento cifrado
(`apps/api/src/quotations/billing.ts:1-30`, migración 0091). `docs/research/04-regulacion-fiscal-latam.md`
pide DIAN vía proveedor tecnológico (§1.1), NFS-e nacional en Brasil (§2.1) y SUNAT vía OSE (§3.1).
Tampoco hay registro turístico (RNT/CADASTUR/DIRCETUR).

### 5.6 Pagos

Sin Stripe ni Mercado Pago (la única mención es un comentario en `0012_provider_accounts.sql:10`). Sí hay:
pago contra la aerolínea (`orders.controller.ts:622`, Credit Card/Cash/GOV), enlace de pago LATAM
(`:666`, SAQ-A), formas de pago filtradas por gobierno (`:644`), y **carteras** con depósito, retiro,
cupo, retención por reserva y aprobaciones (`portfolios/portfolios.controller.ts:156-220`). Falta: cobrar
al cliente final, recargar la cartera con dinero real, extractos y la invariante saldo = libro.

### 5.7 Jerarquía, BYOC y pricing waterfall

- **Jerarquía:** platform → consolidator → agency → subagency sobre ltree, con reglas (0050) y mover
  subárbol (0051). Vendedor = rol. Verificado en vivo: el alta de agencia bajo la plataforma funciona.
- **BYOC:** AES-256-GCM con **una sola clave maestra** por env (`apps/api/src/provider-credentials/credentials-cipher.ts:16-22`),
  sin KMS ni versión de clave para rotar; la PII de clientes deriva de la misma clave
  (`customers/pii-cipher.ts:7`). Resolución por `resolve_provider_account` (ancestro heredable más cercano,
  `0012_provider_accounts.sql:59-77`); `assertReleasable` impide romper herencia con reservas activas
  (`provider-credentials.service.ts:450-495`). Siguen credenciales de plataforma por env
  (`DESPEGAR_API_KEY`, `AGENT_CARS_ACCESS_TOKEN`, `LATAM_API_*`).
- **Waterfall:** N niveles por el path ltree, porcentajes compuestos y fijos sumados
  (`pricing/pricing.service.ts:105-130`, `0016`, `0017`), piso de proveedor y vista por tenant que oculta
  neto y margen de ancestros (`toTenantView`). **Falta** la comisión del vendedor (G-01) y ocultar el neto
  en todas las vistas (G-02, marcado crítico en doc 12).

### 5.8 Auditoría y kill-switches

- `domain_events`: un único writer (`audit/audit.service.ts:235`); `emit` es _best-effort_ y se traga el
  fallo (`:236-241`), así que una acción sensible puede quedar sin evento. Append-only solo por
  `REVOKE UPDATE, DELETE` (`0015_domain_events.sql:27`): sin trigger de inmutabilidad y sin revocar
  `TRUNCATE`.
- Kill-switch por proveedor (`all` / `sales`) desde el panel, guardado en BD y releído cada 10 s
  (`provider-enablement.controller.ts:151-175`) + `PROVIDERS_DISABLED` por env. Bien resuelto. No hay
  feature flags generales (Unleash) para apagar funcionalidades propias.

---

## 6. Calidad técnica

### 6.1 Seguridad

| Control                              | Estado                                                                                                                                                 | Evidencia                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Aislamiento entre tenants            | RLS forzada en 45/56 tablas; contexto por `set_config` en transacción; 272 usos de `withTenant`/`withRequestContext`; 11 accesos crudos a `this.db.db` | `apps/api/src/database/database.service.ts:41-66`                             |
| Tablas sin RLS con DML de `app_user` | **`tenants`, `users`, `password_reset_tokens`**                                                                                                        | `db/migrations/0001_init.sql:93`, `0028`                                      |
| Funciones `SECURITY DEFINER`         | 151: superficie grande que salta RLS; cada una necesita revisión                                                                                       | migraciones                                                                   |
| Tests cross-tenant                   | Sí, como `app_user` (`apps/api/src/network/tenant-isolation.integration.test.ts` y 10 más)                                                             | —                                                                             |
| MFA                                  | Obligatorio para roles de administración; el vendedor no (decisión del doc 16)                                                                         | `apps/api/src/auth/roles.ts:132-139`                                          |
| Headers API                          | `helmet()` por defecto, sin CORS                                                                                                                       | `apps/api/src/main.ts:23`                                                     |
| Headers panel                        | CSP con **`script-src 'unsafe-inline'`** en prod                                                                                                       | `apps/web-b2b/next.config.ts:19`                                              |
| Edge                                 | HSTS preload, X-Frame DENY en Caddy; el origen acepta tráfico que no viene de Cloudflare (los puertos de Docker saltan UFW)                            | `infrastructure/hostinger/Caddyfile:30-34`, `README.md` §10.5                 |
| Rate limiting                        | 300/min por IP global + por vendedor, **en memoria** (no escala a varias réplicas)                                                                     | `apps/api/src/app.module.ts:48-50`, `throttler/seller-rate-limit.guard.ts:43` |
| Secretos                             | Env desde GitHub Secrets; sin sops, KMS ni rotación                                                                                                    | §1.7                                                                          |
| Logs con PII                         | `providers/latam-ndc` usa `console.warn` y, con `LATAM_DEBUG_HTTP`, vuelca XML de petición/respuesta (pasajeros)                                       | `providers/latam-ndc/src/http/latam-http.client.ts:86-87,127-133`             |

### 6.2 Observabilidad

Sin OpenTelemetry, Prometheus ni Sentry. Logs de Nest en texto plano. Hay `/api/health` (BD + circuit
breaker), telemetría de búsqueda y la consola del superadmin (Estado, Salud). Caddy sin access log (doc
19). No hay forma de medir el principio «< 2 minutos» ni alertar por errores.

### 6.3 Tests

| Paquete                                   | Archivos de test     | Observación                                                                                                                   |
| ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                                | 392 (83 integración) | Coverage `enabled`, umbral global 13 % líneas (`vitest.config.ts:60-64`); suelos altos en `search` (84 %) y `hotels` (~100 %) |
| `apps/web-b2b`                            | 328                  | Render y lógica; sin coverage ni umbral                                                                                       |
| `providers/sabre` / `tbo-hotels`          | 84 / 60              | Buenos, con fixtures reales/inferidas                                                                                         |
| `providers/latam-ndc`                     | 2                    | Fixture sintética                                                                                                             |
| `providers/despegar-hotels`, `agent-cars` | 0                    | Sin fixtures                                                                                                                  |
| `packages/*`                              | 0                    | —                                                                                                                             |
| `apps/api/src/crm`, `storage`, `airports` | 0                    | —                                                                                                                             |
| E2E navegador                             | **0**                | Ni Playwright ni Cypress                                                                                                      |

### 6.4 Deuda técnica principal

1. Deploy sin gate de CI y `--no-frozen-lockfile` en CI y Docker.
2. Ports de `packages/core` sin uso; BullMQ/ioredis importados directo; dominio repartido entre Nest y SQL.
3. Componentes web de >1.000 líneas; dos sistemas de formulario; sin librería de UI compartida.
4. `orders` sin tablas normalizadas de segmentos/pasajeros (todo en JSONB): reporting y BI costarán.
5. Rate limiting y caches por réplica en memoria.
6. CI con Postgres sin TimescaleDB/pgvector, distinto de prod.

### 6.5 Infra y operación

Un solo VPS con prod y cert, sin staging, sin backups programados ni PITR, rollback manual. Para una
plataforma que retiene dinero de agencias en carteras, **la falta de backup automático fuera del VPS es el
riesgo operativo más alto**.

### 6.6 Pendiente urgente: Sabre H-07

Desde el 2026-11-05 las reservas de Sabre salen con `targetPcc` = PCC de emisión por el rodeo
`bookOnTicketingPcc` (`apps/api/src/providers-sabre/sabre.factory.ts:481-489,556-568`, carril propio en
`:1266-1300`), porque la oficina de reserva no tiene «Store Passenger Type In PNR». Falta: (1) que Sabre lo
active, (2) apagar `bookOnTicketingPcc` y repetir `sab-12`, (3) quitar `bookingLane`,
`sabreBookOnTicketingPcc`, `isolatedTargetPccSession` y el campo del panel. Además, del doc 12 de Sabre:
los PNR `STECKS` y `SXGFHO` de SAB-13 deben revisarse a mano en Sabre Red, y la emisión en CERT todavía no
lee el tiquete (`BOOKING_NOT_FULFILLED`). La consola «Estado» lo muestra como «Crítico» (verificado en vivo).

---

## 7. Plan priorizado

Ordenado por impacto en venta. Esfuerzo: **S** ≤ 1 semana · **M** 2–4 semanas · **L** > 1 mes.

| #   | Qué                                                                                                                                                         | Por qué                                                      | Esfuerzo             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------- |
| 1   | Cerrar H-07 y certificar emisión Sabre (SAB-13)                                                                                                             | Sin emisión certificada no hay venta aérea por GDS           | S (depende de Sabre) |
| 2   | Backups automáticos fuera del VPS + restauración probada; gate de CI antes del deploy; lockfile congelado                                                   | Riesgo de pérdida de dinero/datos y de desplegar código roto | S                    |
| 3   | Pasarela hosted checkout (Mercado Pago CO/PE/BR + Stripe) y recarga real de cartera                                                                         | No se puede cobrar al cliente final                          | L                    |
| 4   | Factura electrónica vía proveedor (Alegra/Siigo CO, Nubefact PE, Focus NFe BR)                                                                              | Obligatorio por ley                                          | L                    |
| 5   | Reembolsos y cambios con commit (LATAM, Sabre), con Temporal según D9                                                                                       | Posventa es lo primero que exige una agencia                 | L                    |
| 6   | Portugués (i18n) para Brasil                                                                                                                                | Mercado objetivo sin idioma                                  | M                    |
| 7   | Asistencia al viajero (Assist Card / Universal) y traslados/actividades                                                                                     | Verticales de la Ola 1; los consolidadores los tienen        | M                    |
| 8   | Comisión del vendedor y neto oculto (G-01, G-02)                                                                                                            | Promesa central del modelo consolidador                      | M                    |
| 9   | Reserva de paquete con saga multiproveedor                                                                                                                  | Convierte la cotización de #71 en venta                      | L                    |
| 10  | Plazo global de búsqueda Sabre (~45 s), búsqueda en la URL, mensaje «sin proveedores»                                                                       | Tiempo a venta y errores de UX medidos                       | S                    |
| 11  | Arreglos de UX/a11y de §4.1 (foco en errores, contraste, margen de paquetes, falso verde)                                                                   | Bajo costo, alto efecto percibido                            | S                    |
| 12  | Observabilidad: logs JSON, Sentry, OTel mínimo, access log de Caddy                                                                                         | Sin esto no se puede operar ni medir                         | M                    |
| 13  | RLS (o vistas acotadas) para `users`/`tenants`/`password_reset_tokens`; trigger append-only y `REVOKE TRUNCATE` en `domain_events`; CSP sin `unsafe-inline` | Endurecer aislamiento y auditoría                            | M                    |
| 14  | Recalcular en servidor el neto de autos                                                                                                                     | Integridad de precio y cartera                               | S                    |
| 15  | WhatsApp Business nativo + copiloto de cotización                                                                                                           | Diferenciador; Rextur ya compite ahí                         | L                    |
| 16  | Staging desplegado + rate limiting en Redis                                                                                                                 | Probar antes de prod; escalar a >1 réplica                   | M                    |
| 17  | Package Studio drag-and-drop                                                                                                                                | Principio 4 de producto                                      | M                    |
| 18  | Sitio B2C white-label y API pública para agencias                                                                                                           | Paridad con Juniper/TBO                                      | L                    |
| 19  | Actualizar docs 10/12/19, CLAUDE.md y unificar la numeración de decisiones                                                                                  | Evitar decisiones sobre premisas falsas                      | S                    |

---

## 8. Base para pruebas automatizadas

### 8.1 Entorno de prueba propuesto

Lo que se usó para este análisis sirve de base y se puede guionar:

1. Postgres `timescale/timescaledb-ha:pg16-ts2.26` + Redis 7 en Docker; extensiones de
   `infrastructure/hostinger/postgres-init/01-extensions.sql`; migraciones con `tools/db-migrate`.
2. API desde `apps/api/Dockerfile` (en Windows ARM `bcrypt` no tiene binario nativo: hay que correr la API
   en contenedor o en Linux).
3. Seeds: `tools/seed-superadmin` + un seed nuevo de red de prueba (plataforma → consolidador → agencia →
   subagencia, con vendedor y admin, carteras con cupo, reglas de markup). Hoy el vendedor se creó por SQL.
4. MFA en E2E: generar TOTP desde la clave mostrada en el alta (se hizo con un script de 10 líneas).
5. **Proveedores falsos:** el mayor bloqueo. Proponer un `FakeFlightProvider`/`FakeHotelProvider`/
   `FakeCarProvider` registrados en los registries (`apps/api/src/providers/flight-provider.registry.ts`,
   `hotel-provider.registry.ts`) y activados solo por env de test, alimentados con las fixtures existentes
   de Sabre y TBO. Sin esto, el E2E depende de sandboxes inestables (TBO devolvía 500 desde el 17-nov).

### 8.2 Inventario de funcionalidades verificables

> Bajado a 310 casos concretos, con nivel, prioridad y ola, en `docs/qa/01-plan-pruebas-funcionales.md`.

Nivel: **U** unit · **I** integración (Vitest + Postgres/Redis reales) · **E** E2E Playwright.
Sandbox: si necesita el sandbox del proveedor para la versión «real» del test.

| #   | Funcionalidad                                                              | Flujo                                    | Precondiciones                         | Datos de prueba      | Sandbox         | Nivel                                  |
| --- | -------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- | -------------------- | --------------- | -------------------------------------- |
| F1  | Login + MFA (alta, verificación, recuperación, dispositivo de confianza)   | /login → gate → TOTP → códigos           | Usuario admin sin MFA                  | Seed + TOTP generado | No              | E (+I existentes)                      |
| F2  | Bloqueo por intentos y cierre por inactividad                              | 5 fallos → lockout; inactividad → aviso  | Usuario                                | —                    | No              | I + E                                  |
| F3  | Alta de nodo y jerarquía (agencia, sucursal, consolidador, mover subárbol) | /red → Nuevo nodo                        | Superadmin                             | Nombres, puestos     | No              | E + I                                  |
| F4  | Invitación y alta de usuario                                               | Invitar → email → /invitacion            | SMTP de prueba (MailHog)               | Email                | No              | E                                      |
| F5  | Roles y permisos (vendedor no ve admin; admin exige MFA)                   | Navegar rutas por rol                    | Usuarios por rol                       | —                    | No              | E + I                                  |
| F6  | Aislamiento entre tenants (API y UI)                                       | Agencia A pide recurso de B → 403/404    | Dos agencias                           | —                    | No              | I (ampliar a `users`/`tenants`) + E    |
| F7  | BYOC: cargar credencial, herencia, `assertReleasable`                      | /admin/proveedores                       | Consolidador con cuenta heredable      | Credenciales falsas  | No              | I + E                                  |
| F8  | Kill-switch y habilitación por nodo                                        | Apagar proveedor → la búsqueda lo omite  | Proveedor falso                        | —                    | No              | I + E                                  |
| F9  | Pricing waterfall multinivel                                               | Reglas en 3 niveles → precio en búsqueda | Red de 3 niveles                       | Reglas % y fijas     | No              | U (`applyCascade`) + I (SQL) + E       |
| F10 | Búsqueda de vuelos (ida, ida y vuelta, multidestino)                       | /cotizaciones                            | Proveedor falso de vuelos              | Fixtures Sabre       | Sí para real    | E + I                                  |
| F11 | Cambio de precio al reservar vuelo (409)                                   | Oferta → precio cambia → aviso           | Proveedor falso configurable           | —                    | No              | I + E                                  |
| F12 | Reserva de vuelo idempotente + saga de verificación/compensación           | Checkout → reserva → verify              | Proveedor falso + Redis                | Pasajeros            | Sí para real    | I + E                                  |
| F13 | Emisión, void y cancelación de vuelo                                       | /reservas/[id]                           | Reserva creada                         | —                    | Sí (Sabre CERT) | I + E                                  |
| F14 | Búsqueda y reserva de hotel con revalidación                               | /hoteles → checkout                      | Proveedor falso de hotel               | Fixtures TBO         | Sí para real    | E + I                                  |
| F15 | Cancelación de hotel y HCN                                                 | /reservas/[id]                           | Reserva de hotel                       | —                    | Sí              | I                                      |
| F16 | Autos: búsqueda, reserva, cancelación, barrido de pendientes               | /autos                                   | Proveedor falso de autos               | —                    | Sí              | I + E                                  |
| F17 | Paquete: búsqueda combinada, cotización, PDF                               | /paquetes → /paquetes/[id]               | Tres proveedores falsos                | —                    | No              | E                                      |
| F18 | Cotizaciones: guardar, numerar sin duplicados, enviar por email            | /cotizaciones/guardadas                  | SMTP de prueba                         | —                    | No              | I (concurrencia de `quote_number`) + E |
| F19 | Carteras: depósito, cupo, retención en cascada, aprobación                 | /carteras, /red/[id]/carteras            | Red con cupos                          | Montos               | No              | I (existentes) + E                     |
| F20 | Gobierno: formas de pago por nodo/proveedor                                | /admin/plataforma/gobierno               | Perfiles                               | —                    | No              | I + E                                  |
| F21 | Superadmin supervisado y solicitudes de cambio                             | /admin/plataforma/superadmins            | Dos superadmins                        | —                    | No              | I + E                                  |
| F22 | Auditoría: cada acción sensible emite evento                               | Acción → /admin/plataforma/actividad     | —                                      | —                    | No              | I                                      |
| F23 | Conciliación diaria de hoteles                                             | Job → runs/items                         | Reservas + proveedor falso con listado | —                    | No              | I                                      |
| F24 | Clientes con PII cifrada y CRM                                             | /clientes                                | —                                      | Documentos           | No              | I (crm hoy sin tests) + E              |
| F25 | Mobile 375 px sin scroll horizontal en rutas de venta                      | Recorrer rutas                           | —                                      | —                    | No              | E (proyecto Playwright móvil)          |
| F26 | Accesibilidad (axe) en rutas principales                                   | axe por ruta, tema claro y oscuro        | —                                      | —                    | No              | E                                      |
| F27 | Tiempo a venta < 2 min                                                     | Cronometrar F10→F12 con proveedor falso  | —                                      | —                    | No              | E (presupuesto de tiempo)              |
| F28 | Headers de seguridad                                                       | curl / Playwright `response.headers()`   | —                                      | —                    | No              | I                                      |

### 8.3 Contrato de proveedores (sin navegador)

Antes del E2E conviene llevar Despegar, AgentCars y LATAM al nivel de Sabre/TBO: tests de mapeo con
fixtures grabadas (sanitizadas) del sandbox, tests de errores y de redacción de PII en logs.

### 8.4 Qué no conviene automatizar todavía

Emisión real en Sabre CERT y pagos LATAM: dependen de sandbox y dinero de prueba; mantenerlos en el arnés
manual existente (`sabre-cert-run.yml`) hasta cerrar H-07.

### 8.5 Por dónde empezar

1. **Semana 1:** guionar el entorno de §8.1 (compose de test + seed de red + helper TOTP) e instalar
   Playwright en `apps/web-b2b` con dos proyectos (desktop y 375 px). Primeros E2E: F1, F3, F5, F25, F26
   — no necesitan proveedores y ya encontraron fallos en esta revisión.
2. **Semana 2:** proveedores falsos activables por env y E2E de venta F10, F11, F12, F14, F17, F27.
3. **En paralelo:** tests de integración que faltan (`crm`, aislamiento de `users`/`tenants`, neto de autos
   F16, `quote_number` concurrente) y gate de CI antes del deploy, para que los E2E protejan producción.

---

## Hallazgos más graves (resumen corto)

1. **No se puede cobrar ni facturar**: sin pasarela de pago ni factura electrónica DIAN/SUNAT/NF-e.
2. **Posventa sin reembolsos** y Temporal (exigido por D9) inexistente.
3. **Sabre H-07 abierto** con rodeo en producción y emisión sin certificar.
4. **Operación frágil**: deploy a prod sin esperar a CI, sin staging, sin backups automáticos, sin
   observabilidad, con dinero de agencias en carteras.
5. **Cero E2E** y ~15 % de cobertura en la API; Despegar y AgentCars sin tests propios.
6. **Seguridad a endurecer**: `users`/`tenants`/`password_reset_tokens` sin RLS con DML de `app_user`,
   CSP con `unsafe-inline`, una sola clave maestra para BYOC y PII, rate limiting en memoria.
7. **Diferenciadores prometidos sin construir**: WhatsApp/IA (y un competidor ya ahí), Package Studio
   drag-and-drop, portugués para Brasil.
8. **UX:** error de validación invisible en el alta de nodo, botón primario sin contraste AA en tema claro,
   «Ningún vuelo disponible» cuando en realidad no hay proveedores, y estado «En orden» con cero
   proveedores.
