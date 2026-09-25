---
titulo: 'TBO Hotels — Seams de integración en el repo'
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Seams de integración en el repo

Este documento no describe el contrato de TBO; describe **nuestro repo**. Responde una sola pregunta:
_¿qué hay que crear y qué hay que tocar, archivo por archivo, para que `providers/tbo-hotels/` conviva con
`providers/despegar-hotels/` en la vertical de hoteles sin romper las reglas de la plataforma?_

El contrato de TBO está en los documentos hermanos y aquí solo se cita cuando condiciona un seam:
autenticación y errores en [01](./01-autenticacion-conectividad-y-errores.md), Search y oferta en
[02](./02-search-y-oferta-canonica.md), PreBook y Book en [03](./03-prebook-y-book.md), post-venta en
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md), contenido estático en
[05](./05-contenido-estatico-e-inventario.md), certificación en [07](./07-certificacion.md). Las fuentes y su
procedencia están en [00-fuentes.md](./00-fuentes.md).

## 0. Cómo leer este documento

**Evidencia.**

| Marca                  | Significa                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VERIFICADO-CODIGO**  | Leído en el archivo citado como `ruta:línea` (rutas relativas a la raíz del repo, estado del árbol en el commit `8972c6a`, del 2026-08-28, leído el 2026-09-23). |
| **VERIFICADO-PDF**     | Leído en la página física N del PDF de TBO V2.1, citada "(p. N)".                                                                                                |
| **VERIFICADO-POSTMAN** | Leído en la colección `HotelAPI_Client.postman_collection 7.json`, citada "(Postman: `<request>`)".                                                              |
| **VERIFICADO-CERT**    | Leído en el documento de certificación de TBO, citado "(Cert)".                                                                                                  |
| **INFERIDO**           | Deducción nuestra. No está escrita en ninguna fuente.                                                                                                            |
| **PROPUESTA**          | Diseño sugerido para TBO. No está implementado.                                                                                                                  |

Toda cita `ruta:línea` de este documento es VERIFICADO-CODIGO salvo que la fila o el párrafo digan otra cosa.
Donde una conclusión mezcla código e inferencia, se marca INFERIDO.

**Línea base de arquitectura que este documento asume** (las alternativas y su decisión están en
[08-requisitos-maestro.md](./08-requisitos-maestro.md); cada sección dice qué cambia si se elige la alternativa):

1. Código de proveedor `tbo-hotels`. Paquete ACL `providers/tbo-hotels` (`@sales-travel/tbo-hotels`) con la forma de
   `providers/despegar-hotels` y las salvaguardas de `providers/sabre`. Wiring en `apps/api/src/providers-tbo/`.
2. La vertical de hoteles se **generaliza a multi-proveedor** al estilo de vuelos (`HotelProviderRegistry` +
   `TenantProviderFactory` + token DI + contrato neutral fuera del ACL de Despegar, con referencia de proveedor en la
   oferta). No se construye un módulo TBO paralelo.
3. Credenciales BYOC con herencia consolidador → agencia (`resolve_provider_account`) y puerta de credenciales al
   estilo LATAM/Sabre.
4. Las reservas de hotel se persisten como **órdenes con intent idempotente ANTES del Book**, porque TBO obliga a
   recuperar con `BookingDetail` por `BookingReferenceId` a los 120 s si el Book falla (p. 42).
5. Contenido estático sincronizado a `hotel_inventory` con `provider_code = 'tbo-hotels'`.
6. Decisiones cerradas que no se reabren: **D1** (nunca PAN/CVV → para TBO solo `PaymentMode: "Limit"`) y **D9**
   (BullMQ para las sagas con dinero; hoteles no emite, así que BullMQ aplica), ambas en
   `docs/sabre/10-requisitos-maestro.md` §9.

---

## 1. Resumen ejecutivo

- **El patrón de hoteles de hoy es mono-proveedor por construcción.** `HotelsService` inyecta la clase concreta
  `DespegarHotelsProviderFactory` (`apps/api/src/hotels/hotels.service.ts:21`, `:29`), fija
  `const PROVIDER_CODE = 'despegar-hotels'` (`:24`) y tipa todo su contrato con tipos exportados por el ACL de
  Despegar (`:2-15`; controlador `apps/api/src/hotels/hotels.controller.ts:12-22`). El filtro de errores solo atrapa
  `DespegarApiError` (`hotels.controller.ts:48`). Un segundo proveedor no tiene dónde enchufarse.
- **Vuelos ya resolvió el mismo problema** y el molde es reutilizable casi tal cual: `TenantProviderFactory<TAdapter>`
  es genérico y `ProviderVertical` ya incluye `'hotels'` (`apps/api/src/providers/provider.types.ts:150`, `:178-192`);
  el registry, el fan-out, el breaker y la telemetría son genéricos por código de proveedor.
- **La plantilla del ACL no es Despegar a secas.** Es la _forma_ de Despegar (misma vertical, mismo flujo), el cliente
  HTTP de AgentCars (timeout configurable) y las salvaguardas de Sabre (config con Zod, `fetch` y logger inyectables,
  redacción, cero reintentos en paths con dinero, tests y fixtures dentro del paquete).
- **El trabajo grande no está en el ACL, está en los seams:** contrato neutral de hotel, registry, enrutado de
  prebook/book/cancel por proveedor de la oferta, reserva como orden con intent, job de verificación con retardo de
  120 s (la cola de hoy no admite `delay`: `apps/api/src/queue/post-sale-queue.service.ts:110`), destino
  multi-proveedor (el `destinationId` de hoy es un id geográfico de Despegar) y un sync de contenido estático propio.
- **Dos trampas concretas que un copy-paste de Despegar dispararía:** (a) la regla de lint D1 no reconoce los
  nombres de campo de tarjeta de TBO porque están en PascalCase (`CardNumber`, `CvvNumber`) y la regex es
  camelCase sin flag `i` (`eslint.config.mjs:57`, `:63`, `:69`); (b) si `TboApiError.status` transporta el
  `Status.Code` del cuerpo de TBO (p. ej. `479`), la política de reintentos de cancelación lo leerá como un HTTP 4xx y
  cerrará la cancelación como fallo determinista sin conciliar (`apps/api/src/orders/cancel-retry-policy.ts:73-74`).
- **TBO destapa gaps preexistentes de la vertical** que no son de TBO: las reservas de hotel no se persisten ni emiten
  eventos, la UI solo busca y muestra el neto, `provider_catalog` tiene las capacidades de Despegar en `false`, y el
  factory de Despegar construye el adapter con `apiKey: ''`. Se listan aparte en §8 para no mezclarlos con el alcance
  TBO.

---

## 2. Mapa rápido: qué sirve tal cual y qué no

| Pieza                                    | Archivo                                                                                 | ¿Multi-proveedor hoy?                                                     | Veredicto para TBO                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Workspace / build / Docker / CI          | `pnpm-workspace.yaml:4`, `apps/api/Dockerfile:21`, `:29`, `.github/workflows/ci.yml:97` | Sí (glob `providers/*`, build por grafo `^...`)                           | **Sirve tal cual**                                                                                                |
| Bóveda BYOC y herencia                   | `db/migrations/0012_provider_accounts.sql:59-77`                                        | Sí (`provider_code` TEXT libre)                                           | **Sirve tal cual**                                                                                                |
| Contrato de factory                      | `apps/api/src/providers/provider.types.ts:178-192`                                      | Sí (genérico en el adapter; `vertical` admite `'hotels'`)                 | **Sirve tal cual**                                                                                                |
| Registry de proveedores                  | `apps/api/src/providers/flight-provider.registry.ts:71-247`                             | Sí, pero tipado a `FlightProviderAdapter`                                 | **Espejo para hoteles** (§5.4)                                                                                    |
| Fan-out con degradación parcial          | `apps/api/src/search/provider-fanout.ts:27-50`                                          | Sí (genérico)                                                             | **Sirve tal cual**                                                                                                |
| Dedupe                                   | `apps/api/src/search/provider-fanout.ts:59-71`                                          | Sí, sin llamadores                                                        | Sirve cuando exista identidad común de hotel (decisión)                                                           |
| Circuit breaker + kill-switch            | `apps/api/src/search/circuit-breaker.service.ts:31-41`, `:63-100`                       | Sí (por código)                                                           | **Sirve**, con la salvedad BYOC de §8 G12                                                                         |
| Telemetría y cuota                       | `apps/api/src/search/search-telemetry.service.ts:7`, `:145-159`                         | Sí (`breakdownOf` por proveedor)                                          | **Sirve tal cual**                                                                                                |
| Waterfall de markup                      | `apps/api/src/hotels/hotels.service.ts:47-64`                                           | Por vertical, no por proveedor                                            | **Sirve**, pero falta el piso `RecommendedSellingRate` (p. 13, 21); con D-TBO-16 (A) aplica en todo canal (TP-29) |
| Catálogo ciudad → hoteles                | `db/migrations/0022_hotel_inventory.sql:6-26`                                           | Esquema sí (PK `(provider_code, hotel_id)`); la consulta no               | **Esquema sirve**; consulta y sync, no                                                                            |
| `HotelsService` / `HotelsController`     | `apps/api/src/hotels/hotels.service.ts:21-35`, `hotels.controller.ts:46-48`             | **No**                                                                    | Reescritura del enrutado (§5.6)                                                                                   |
| Schemas de borde                         | `apps/api/src/hotels/hotels.schemas.ts:54-168`                                          | **No** (forma Despegar)                                                   | Reescritura de la parte de reserva                                                                                |
| Reserva como orden                       | `apps/api/src/orders/orders.service.ts:278`, `:694-879`                                 | Intent solo para vuelos (privado); `recordExternalOrder` sin idempotencia | Hace falta API pública de intent (§5.5)                                                                           |
| Cola de post-venta                       | `apps/api/src/queue/post-sale-queue.service.ts:11-17`, `:110-125`                       | Genérica, pero **sin `delay`**                                            | Extender                                                                                                          |
| Sync de contenido                        | `tools/sync-hotel-inventory/src/index.ts:13-17`, `:60-94`                               | **No** (100 % Despegar)                                                   | Tool nuevo o generalizar                                                                                          |
| Panel BYOC (web)                         | `apps/web-b2b/src/lib/provider-forms.ts:308-312`                                        | Sí (mapa `PROVIDERS`)                                                     | Agregar una entrada                                                                                               |
| Lint D1 (anti-PAN en builders de salida) | `eslint.config.mjs:50-75`                                                               | Por nombre de archivo, regex camelCase                                    | **No cubre TBO** hasta extender la regex                                                                          |

---

## 3. El patrón actual de hoteles y cómo evolucionó

### 3.1 Anatomía del patrón Despegar (tres capas)

| Capa         | Archivos                                                                                                                                         | Qué hace                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACL          | `providers/despegar-hotels/src/**` (17 `.ts`)                                                                                                    | Config como interfaz sin Zod (`src/config.ts:5-17`), cliente sobre `fetch` global con timeout fijo de 15 s (`src/http/despegar-http.client.ts:80`), builders y mappers por operación, clase `DespegarHotelsAdapter` con 9 métodos que no implementa ningún puerto (`src/index.ts:54`). |
| Factory BYOC | `apps/api/src/providers-despegar/despegar-hotels.factory.ts`, `despegar-hotels.module.ts`                                                        | Resuelve la cuenta del tenant (`:28`), cae a variables de entorno si no hay cuenta (`:31-35`), cachea por `byoc:{owner}:{updatedAt}` o `env` (`:30`, `:37-53`). Devuelve la clase concreta.                                                                                            |
| Vertical     | `apps/api/src/hotels/{hotels.module,hotels.service,hotels.controller,hotels.schemas,despegar-hotels-errors,despegar-hotels-exception.filter}.ts` | 9 rutas bajo `/hotels` (`hotels.controller.ts:57-145`); búsqueda con cuota, breaker, telemetría y waterfall (`hotels.service.ts:73-121`); reserva como pass-through (`:165-196`); error → 502 humanizado (`despegar-hotels-exception.filter.ts:17-29`).                                |
| Tests        | `apps/api/src/providers-despegar/*.test.ts`, `apps/api/src/hotels/despegar-hotels-errors.test.ts`                                                | Viven en `apps/api`, no en el paquete; `fetch` global con `vi.stubGlobal` (`despegar-hotels.adapter.test.ts:12`, `:35`). El paquete no tiene script `test` (`providers/despegar-hotels/package.json:17-22`).                                                                           |

Los tipos públicos del ACL (`HotelOffer`, `HotelRoompack`, `PrebookQuery`, `BookRequest`…) son **de facto el contrato
de la vertical**: el servicio y el controlador los importan del paquete del proveedor (`hotels.service.ts:2-15`,
`hotels.controller.ts:12-22`), y `HotelOffer` no lleva qué proveedor la emitió (`providers/despegar-hotels/src/types.ts:84-91`).
Es el acoplamiento raíz: un ACL de TBO no puede depender de otro ACL, y dos contratos homónimos en `apps/api` no
conviven.

### 3.2 Cómo evolucionó el patrón después de Despegar

| Dimensión                      | `despegar-hotels`                                       | `agent-cars`                                                                                   | `latam-ndc`                                                                  | `sabre` (el más reciente)                                                                                                                 |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `types` del paquete            | `./src/index.ts` (`package.json:6`)                     | `./src/index.ts`                                                                               | `./src/index.ts`                                                             | `./dist/index.d.ts` (`providers/sabre/package.json:7`, `:10`), con el motivo en `.github/workflows/ci.yml:37-41`                          |
| Config                         | Interfaz, sin validar (`src/config.ts:5-17`)            | Interfaz + `timeoutMs?` (`providers/agent-cars/src/config.ts:1-10`)                            | Interfaz sin Zod (`providers/latam-ndc/src/config.ts:12-22`)                 | `SabreConfigSchema` Zod + `parseSabreConfig` que solo reporta `path:code`, nunca valores (`providers/sabre/src/config.ts:92`, `:122-131`) |
| "¿Puede operar?"               | `isConfigured` sin consumidores (`src/config.ts:26-28`) | `isConfigured` (`config.ts:19-21`)                                                             | `missingLatamCredentials` (`config.ts:30-52`)                                | `missingSabreCredentials` / `hasUsableSabreCredentials` (`config.ts:140-160`)                                                             |
| Timeout                        | 15 s fijo (`despegar-http.client.ts:80`)                | `cfg.timeoutMs ?? 15_000` con `AbortSignal.timeout` (`agent-cars-http.client.ts:21`, `:68-71`) | `AbortController`                                                            | Configurable                                                                                                                              |
| Reintentos                     | Ninguno                                                 | Ninguno                                                                                        | Ninguno                                                                      | Solo si `idempotent: true` y el path no es de dinero (`providers/sabre/src/http/sabre-http.client.ts:35`, `:181`)                         |
| `fetch` / logger inyectables   | No (global)                                             | No                                                                                             | No                                                                           | Sí, `SabreHttpDeps.fetch/logger` (`sabre-http.client.ts:123-125`)                                                                         |
| Redacción                      | Implícita (no loguea cabeceras)                         | Implícita                                                                                      | No                                                                           | Módulo `redaction.ts` con su batería de tests                                                                                             |
| Tests y fixtures               | En `apps/api`, JSON inline                              | En `apps/api`                                                                                  | En `apps/api`                                                                | **En el paquete** (`package.json:25`), fixtures en `src/__fixtures__/`, `tsconfig.build.json` que excluye tests (`:6`)                    |
| Implementa puertos del dominio | No                                                      | No                                                                                             | Sí (4)                                                                       | Sí                                                                                                                                        |
| Factory                        | Solo `forTenant`, fallback a env                        | Solo `forTenant`, fallback a env                                                               | `TenantProviderFactory`, env + puerta (`latam-ndc.factory.ts:44`, `:74-103`) | `TenantProviderFactory`, **BYOC puro** + puerta (`sabre.factory.ts:379`, `:426-445`)                                                      |

Lo que cambió, en una línea por salto (INFERIDO a partir del código):

- Despegar → AgentCars: timeout configurable y credencial fuera de la URL. Mismo esqueleto.
- AgentCars → LATAM/Sabre: "sin credenciales usables el proveedor queda AUSENTE, nunca fixtures"
  (`providers/latam-ndc/src/config.ts:5-11`), factory con contrato, registry multi-proveedor.
- LATAM → Sabre: config con Zod, dependencias inyectables, redacción, política explícita de no-reintento para dinero,
  tests dentro del paquete y guards que se prueban **por la puerta pública del cliente HTTP**.

Despegar y AgentCars **no** se actualizaron al patrón registry: siguen con factory y servicio dedicados.

### 3.3 La plantilla para TBO y por qué

**Forma de `despegar-hotels` + cliente de `agent-cars` + salvaguardas de `sabre`.**

- **Forma de Despegar** porque es la misma vertical, el mismo flujo de venta (búsqueda → prevalidación → reserva →
  detalle → cancelación), el mismo consumidor (`HotelsService`) y el mismo catálogo (`hotel_inventory`). Copiar la
  forma de Sabre traería una maquinaria de sobres NDC/ATPCO que TBO no tiene.
- **Cliente de AgentCars** porque TBO recomienda un timeout distinto por operación: Search 5-23 s, PreBook 23 s,
  Book 120 s (VERIFICADO-PDF p. 8). El timeout fijo de 15 s de Despegar abortaría todo Book legítimo de más de 15 s y
  dejaría una reserva huérfana (el mismo defecto ya existe en Despegar, §8 G18).
- **Salvaguardas de Sabre** porque TBO mueve dinero con la cuenta de la agencia (`PaymentMode: "Limit"`, p. 33),
  informa errores dentro del cuerpo (`Status.Code`, p. 8-10) y trae PII en Book y BookingDetail. Las que se copian son
  las baratas: Zod en config y en respuestas, `fetch` y logger inyectables, redacción, cero reintentos en Book y
  Cancel, tests y fixtures en el paquete, `tsconfig.build.json`, y guards probados por la puerta pública.

Qué **no** se copia:

| De dónde | Qué no se copia                                                                                              | Por qué                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Despegar | Timeout fijo de 15 s (`despegar-http.client.ts:80`)                                                          | Book de TBO puede tardar hasta 120 s (p. 8).                                                                                                                                                                         |
| Despegar | `console.warn` tras `DESPEGAR_DEBUG_HTTP` (`despegar-http.client.ts:30-32`)                                  | `CLAUDE.md` prohíbe `console.log` en producción; Sabre usa `LoggerPort` (`sabre-http.client.ts:125`).                                                                                                                |
| Despegar | `isConfigured` sin uso y factory que construye con credencial vacía (`despegar-hotels.factory.ts:62`, `:78`) | La postura de la plataforma es "ausente con motivo" (`apps/api/src/providers/provider.types.ts:14-21`).                                                                                                              |
| Despegar | Moneda por defecto `'USD'` cuando falta (`availability/response.mapper.ts:94`)                               | TBO fija la moneda por perfil de cuenta (p. 13); asumirla oculta un error de configuración.                                                                                                                          |
| Despegar | Log de 250 caracteres del cuerpo del proveedor (`despegar-hotels-exception.filter.ts:22`)                    | Book y BookingDetail de TBO devuelven nombres, email y teléfono (p. 32-33, 45-48). LATAM loguea solo `status path` (`latam-ndc-exception.filter.ts:22`).                                                             |
| Sabre    | Clasificador de sobres de Sabre, `spec/manifest.json` por hash, benches                                      | TBO tiene un solo formato de error (`Status`) y no publica OpenAPI; el costo no se justifica.                                                                                                                        |
| Sabre    | `"version": "0.0.0-experimental"` (`providers/sabre/package.json:3`, `:5`)                                   | Marca de Sabre por su compuerta comercial Go/No-Go. TBO no tiene compuerta de valor ([08](./08-requisitos-maestro.md) D-TBO-02 B): lo que lo separa de producción es la certificación ([07](./07-certificacion.md)). |

---

## 4. `providers/tbo-hotels/` — estructura propuesta

### 4.1 `package.json` y `tsconfig`

PROPUESTA, sobre `providers/despegar-hotels/package.json` y `providers/sabre/package.json`:

```json
{
  "name": "@sales-travel/tbo-hotels",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist", "src", "!src/**/*.test.ts", "!src/__fixtures__"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "clean": "rm -rf dist .turbo *.tsbuildinfo",
    "test": "vitest run"
  },
  "dependencies": {
    "@sales-travel/canonical": "workspace:*",
    "@sales-travel/core": "workspace:*",
    "@sales-travel/domain": "workspace:*",
    "zod": "^3.24.1"
  },
  "devDependencies": { "typescript": "^5.7.2", "vitest": "^2.1.8" }
}
```

- `types` apunta a `dist` como en Sabre. El motivo está escrito en `.github/workflows/ci.yml:37-41`: con `types` en
  `src`, el consumidor compila contra la fuente y ejecuta el compilado, divergencia que el repo ya pagó con un `dist/`
  rancio. El costo es que el lint con tipos necesita `build` antes, y CI ya lo hace (`ci.yml:42-46`).
  **Si se elige `types: ./src` como Despegar**, desaparece ese orden pero reaparece el riesgo del `dist` rancio en los
  tests de `apps/api`, que resuelven el paquete por `dist` (`ci.yml:95-97`).
- `zod` como dependencia directa, igual que Sabre (`providers/sabre/package.json:32`). Los schemas de respuesta del
  proveedor son privados del ACL; no van a `packages/validation`.
- `@sales-travel/core` para `LoggerPort` (`packages/core/src/ports/logger.port.ts:3-9`); `@sales-travel/domain` para
  implementar los puertos de hotel (§5.3).
- Con el script `test`, el paquete entra solo en `pnpm test` de CI (`turbo run test`, `ci.yml:127-135`).
- `tsconfig.json`: copia de `providers/despegar-hotels/tsconfig.json` (CommonJS/Node, `rootDir ./src`) **sin**
  excluir los tests, para que se typecheckeen; `tsconfig.build.json`: copia de `providers/sabre/tsconfig.build.json`
  (excluye `src/**/*.test.ts`).

### 4.2 Árbol de archivos y responsabilidad

PROPUESTA. Una carpeta por operación de TBO, igual que Despegar (`availability/`, `booking/`, `detail/`…). Los
builders se llaman `request.builder.ts` o `*.request.builder.ts` para caer bajo la regla D1 de ESLint
(`eslint.config.mjs:51`), con la extensión de §4.3 regla 1.

```
providers/tbo-hotels/
├── package.json, tsconfig.json, tsconfig.build.json
└── src/
    ├── index.ts                          superficie pública EXPLÍCITA (sin export *): adapter, cliente de contenido,
    │                                     config, errores. Guard de superficie como providers/sabre/src/index.surface.test.ts
    ├── config.ts                         TboHotelsConfigSchema (Zod) + parseTboConfig (error solo path:code)
    │                                     TBO_BASE_URLS = { test } (no hay constante live: p. 7)
    │                                     TBO_TIMEOUTS_MS por operación (p. 8) + override por config
    │                                     TBO_REQUIRED_CREDENTIAL_FIELDS / missingTboCredentials / hasUsableTboCredentials
    ├── errors.ts                         modelo de [01] §9 (08 §9 C-04): TboApiError (status HTTP + tboCode + failure.kind),
    │                                     TboConfigError, TboCredentialsMissingError, TboRequestBuildError,
    │                                     TboOfferExpiredError, TboResponseMappingError, TboCancelMappingError
    ├── redaction.ts                      nunca Authorization; cuerpos de Book/BookingDetail fuera de logs
    ├── http/
    │   ├── tbo-http.client.ts            fetch inyectable, Authorization: Basic, Content-Type: application/json (p. 7),
    │   │                                 AbortSignal.timeout por operación, CERO reintentos en /Book y /Cancel,
    │   │                                 2xx no-JSON → error tipado, logger inyectable
    │   └── status-envelope.ts            lee Status.Code: 200 → ok; 201 en Search → vacío (no es fallo); resto → TboApiError con kind
    ├── internal/
    │   ├── coerce.ts                     num/str/bool (base providers/agent-cars/src/internal/coerce.ts), decimales en string
    │   └── tbo-date.ts                   YYYY-MM-DD; dd-MM-yyyy HH:mm:ss de CancelPolicies.FromDate (INFERIDO, p. 24, 28, 50);
    │                                     DD-MMM-YYYY de BookingDetailsbasedondate (p. 63-64)
    ├── schemas/                          Zod de RESPUESTA por operación (tolerante: passthrough, montos number|string)
    │   ├── search.response.schema.ts, prebook.response.schema.ts, book.response.schema.ts,
    │   ├── booking-detail.response.schema.ts, cancel.response.schema.ts,
    │   └── booking-by-date.response.schema.ts, static.response.schema.ts
    ├── search/
    │   ├── search.request.builder.ts     PaxRooms, HotelCodes en lotes ≤100 (p. 10), GuestNationality (p. 10; KP-1 p. 71),
    │   │                                 IsDetailedResponse:false (KP-2 p. 71), Filters
    │   ├── response.mapper.ts            HotelResult[].Rooms[] → roompacks neutrales con provider.offerRef = BookingCode
    │   └── meal-type.ts                  MealType → BoardType, tolerante a casing y a valores desconocidos (p. 69-70)
    ├── prebook/
    │   ├── prebook.request.builder.ts    { BookingCode, PaymentMode: 'Limit' } (p. 19)
    │   └── response.mapper.ts            precio vigente, CancelPolicies y RateConditions finales (KP-3 p. 71), Supplements
    ├── booking/
    │   ├── book.request.builder.ts       CustomerDetails por habitación, ClientReferenceId, BookingReferenceId,
    │   │                                 TotalFare, PaymentMode: 'Limit' literal, SIN PaymentInfo (p. 33)
    │   └── book.response.mapper.ts
    ├── detail/                           BookingDetail
    │   ├── booking-detail.request.builder.ts  ConfirmationNumber | BookingReferenceId + PaymentMode: 'Limit' (p. 43-44)
    │   └── response.mapper.ts            BookingStatus → estado neutral; HCN (p. 45-49)
    ├── cancel/
    │   ├── cancel.request.builder.ts     { ConfirmationNumber } (p. 41)
    │   └── response.mapper.ts            sin montos: la respuesta no los trae (p. 41-42)
    ├── cancellation/
    │   └── policy.mapper.ts              CancelPolicies → ventanas neutrales (Fixed/Percentage; desconocido → no reembolsable)
    ├── reports/
    │   ├── booking-by-date.request.builder.ts   ventanas ≤60 días (p. 62)
    │   └── booking-by-date.response.mapper.ts
    ├── static/                           contenido estático, lo consume el sync (no la venta)
    │   ├── country-list.response.mapper.ts                       GET CountryList (p. 51)
    │   ├── city-list.request.builder.ts, city-list.response.mapper.ts             POST CityList (p. 53-54)
    │   ├── hotel-code-list.request.builder.ts, hotel-code-list.response.mapper.ts  POST TBOHotelCodeList (p. 65-69)
    │   └── hotel-details.request.builder.ts, hotel-details.response.mapper.ts      POST HotelDetails (p. 56-62)
    ├── tbo-hotels.adapter.ts             clase TboHotelsAdapter: implementa los puertos de hotel (§5.3)
    ├── tbo-static-content.client.ts      superficie separada para el sync: solo métodos de contenido, sin venta
    ├── __fixtures__/
    │   ├── pdf/                          ejemplos del PDF normalizados, un archivo por página (§7.2)
    │   └── postman/                      bodies de request de la colección
    └── *.test.ts                         colocalizados (§7)
```

Notas de diseño:

- **`status-envelope.ts` separado del cliente**: TBO devuelve el desenlace en `Status.Code` dentro del cuerpo
  (p. 8-10) y el PDF no dice qué código HTTP lo acompaña. El envelope es la única pieza que decide "éxito / vacío /
  error", y se prueba sola. `201 NO_AVAILABILITY` (ejemplo en p. 18) devuelve una lista vacía: no es un fallo del
  proveedor y no debe contar en el circuit breaker (§5.6). → [Q-07](./10-preguntas-para-tbo.md#q-07): qué código HTTP acompaña a cada
  `Status.Code` distinto de 200.
- **`status` y `tboCode` separados dentro de `TboApiError`** (una sola clase con `failure.kind`,
  [01](./01-autenticacion-conectividad-y-errores.md) §9.2): `status` es siempre el código HTTP de transporte (0 para red o
  timeout, como en Despegar y AgentCars); el `Status.Code` de TBO va en un campo propio (`tboCode`). Si se mezclan, la
  política de cancelación trata `479 CANCEL_FAIL` como un HTTP 4xx determinista (`cancel-retry-policy.ts:73-74`) y la
  cancelación se cierra como fallida sin releer la reserva. Ver §5.5.
- **`tbo-static-content.client.ts` separado del adapter de venta**: el sync corre con credencial de plataforma y en un
  proceso aparte; exponerle solo los métodos de contenido evita que el tool pueda reservar.
- **El paquete no lee `process.env`**: todas las variables las lee el factory (`apps/api`) o el tool de sync, como en
  Sabre (`providers/sabre/src/config.ts`) y a diferencia del `DESPEGAR_DEBUG_HTTP` de Despegar
  (`despegar-http.client.ts:30-32`).

### 4.3 Reglas de implementación que salen del repo

1. **D1 en el lint: hay que extender la regex.** La regla anti-tarjeta aplica a `**/request.builder.ts`,
   `**/*.request.builder.ts` y `**/*.serializer.ts` (`eslint.config.mjs:51`), pero su lista de claves es camelCase y la
   regex no lleva flag `i`: `cardNumber|cardSecurityCode|…|cvv|cvc|securityCode|…` (`eslint.config.mjs:57`, `:63`,
   `:69`). Los campos de TBO son `PaymentInfo`, `CvvNumber`, `CardNumber`, `CardExpirationMonth`, `CardExpirationYear`,
   `CardHolderFirstName`, `CardHolderLastName` (en los ejemplos `CardHolderlastName`), `CardHolderAddress`,
   `BillingAmount`, `BillingCurrency` (VERIFICADO-PDF p. 33-35). **Ninguno casa.** Acción OBLIGATORIA: añadir un bloque
   de claves de TBO (o flag `i` y las raíces `PaymentInfo`, `CvvNumber`, `CardHolder\w*`) y fijarlo con un test que
   ejecute ESLint de verdad, como `providers/sabre/src/pan-lint-rule.guard.test.ts`.
2. **D1 en el tipo, que es más fuerte que el lint.** El input de los builders de PreBook, Book y BookingDetail no tiene
   ningún campo de `PaymentInfo`; `PaymentMode` es el literal `'Limit'` en los tres (BookingDetail también lo recibe,
   p. 44; [08](./08-requisitos-maestro.md) §9 C-21), no el enum de tres valores de TBO (`Limit`, `SavedCard`,
   `NewCard`, p. 70). Un body de salida con otro modo o con claves de tarjeta lanza `TboRequestBuildError` antes del
   cable ([01](./01-autenticacion-conectividad-y-errores.md) §10.5).
3. **Zod en la respuesta, tolerante.** Montos que llegan como string (`ExtraGuestCharges`, `RecommendedSellingRate`,
   p. 15-17), `HotelRating` como texto o número (p. 62, 67), `Supplements` como array de arrays (p. 15-18): el schema
   acepta ambas formas y el mapper normaliza. Un fallo de schema es `TboResponseMappingError` (salvo en la
   respuesta de `/Cancel`, que necesita otro nombre: §5.5 punto 5), nunca un `Error` plano
   que escape al filtro (defecto de Despegar: `Money.fromMajor` lanza `Error` con montos negativos,
   `packages/canonical/src/money.ts:41-46`).
4. **Sin moneda por defecto.** La moneda sale de `HotelResult[].Currency` (p. 13); si falta, error de validación.
5. **Montos con `Money.fromMajor`**, sabiendo que redondea a 2 decimales fijos (`money.ts:45`). Los `BasePrice` de
   `DayRates` traen hasta 8 decimales (p. 24) y `BillingAmount` 3 (p. 34): el total se toma de `TotalFare`, nunca de la
   suma redondeada de noches.
6. **Timeouts por operación** (p. 8): Search dentro de 5-23 s y coherente con `ResponseTime` (p. 11); PreBook 23 s;
   Book 120 s. BookingDetail, Cancel y los métodos estáticos no tienen timeout documentado (p. 8): valor configurable,
   por defecto conservador (INFERIDO). → [Q-09](./10-preguntas-para-tbo.md#q-09): timeout recomendado para BookingDetail y Cancel.
7. **Reintentos**: cero en `/Book` y `/Cancel`, igual que `SABRE_NON_IDEMPOTENT_PATHS`
   (`sabre-http.client.ts:35`). En lecturas (Search, BookingDetail, estáticos) solo ante `429 LIMIT_EXCEEDED` o
   transporte, con backoff; el QPS permitido no está publicado (p. 9). → [Q-10](./10-preguntas-para-tbo.md#q-10): QPS por cuenta y por método.
8. **Nunca** `Authorization` en logs, URL ni mensajes de error. El header Basic es reversible (base64), el mismo
   argumento que `providers/sabre/src/redaction.ts:4-7`.

### 4.4 Mapeo de operaciones

| Contrato neutral (§5.3)              | Despegar hoy (`providers/despegar-hotels/src/index.ts`) | TBO (p. 7-8, 41-69)                                       | Capacidad           |
| ------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------- | ------------------- |
| `searchAvailability`                 | `searchAvailability` (`:73-84`)                         | `POST /Search` por `HotelCodes`                           | obligatoria         |
| `prebook`                            | `prebook` con `choiceId` (`:101-108`)                   | `POST /PreBook` con `BookingCode`                         | obligatoria         |
| `book`                               | `book` (`:119-127`)                                     | `POST /Book`                                              | obligatoria         |
| `getBooking`                         | `getReservation(id)` (`:129-135`)                       | `POST /BookingDetail` por `ConfirmationNumber`            | obligatoria         |
| `getBookingByClientReference`        | — (no existe)                                           | `POST /BookingDetail` por `BookingReferenceId` (p. 42-44) | opcional (TBO)      |
| `cancel`                             | `cancelReservation` (`:137-144`)                        | `POST /Cancel` por `ConfirmationNumber`                   | obligatoria         |
| `listBookingsByDate`                 | —                                                       | `POST /BookingDetailsbasedondate` (≤60 días, p. 62)       | opcional (TBO)      |
| `suggest`                            | `suggest` (`:63-71`)                                    | — (TBO no tiene autocompletado; hay `CityList`, p. 53)    | opcional (Despegar) |
| `getHotelDetail` (tarifas por hotel) | `getHotelDetail` (`:86-97`)                             | — (`HotelDetails` es contenido estático, p. 56)           | opcional (Despegar) |
| `getPaymentOptions`                  | `getPaymentOptions` (`:110-117`)                        | —                                                         | opcional (Despegar) |
| `recoverBooking`                     | `recoverBooking` (`:146-154`)                           | —                                                         | opcional (Despegar) |

---

## 5. `apps/api`: wiring de TBO y generalización de la vertical

### 5.1 Acoplamientos exactos a Despegar

| #   | Archivo:línea                                                             | Qué está acoplado                                                                     | Por qué bloquea a TBO                                                                                                                               |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `apps/api/src/hotels/hotels.service.ts:2-15`                              | 12 tipos importados de `@sales-travel/despegar-hotels`                                | La firma del servicio es la de Despegar; viola "tipos de proveedor filtrándose al dominio" de `CLAUDE.md`.                                          |
| A2  | `hotels.service.ts:21`, `:29`                                             | Inyecta la clase concreta `DespegarHotelsProviderFactory`                             | No hay token ni contrato donde registrar un segundo factory.                                                                                        |
| A3  | `hotels.service.ts:24`, `:96`, `:105`, `:135`                             | `PROVIDER_CODE = 'despegar-hotels'` en telemetría, breaker e inventario               | Toda búsqueda se atribuye a Despegar; el inventario de TBO nunca se consultaría.                                                                    |
| A4  | `hotels.service.ts:131-141`                                               | `resolveCityHotelIds(cityId)` sin parámetro de proveedor                              | Idem.                                                                                                                                               |
| A5  | `hotels.service.ts:68-71`                                                 | `suggest` = autocompletado de Despegar                                                | TBO no tiene equivalente; el id que devuelve es el geo id de Despegar (`providers/despegar-hotels/src/suggestions/response.mapper.ts:26-28`).       |
| A6  | `hotels.service.ts:165-196`                                               | Reserva como pass-through sin proveedor                                               | `prebook`/`book`/`cancel` no saben a qué adapter enrutar.                                                                                           |
| A7  | `apps/api/src/hotels/hotels.controller.ts:12-22`                          | 9 tipos del ACL de Despegar en las firmas HTTP                                        | Idem A1.                                                                                                                                            |
| A8  | `hotels.controller.ts:48`                                                 | `@UseFilters(DespegarHotelsExceptionFilter)` de clase                                 | Un error de TBO saldría como 500 por el filtro global (`apps/api/src/all-exceptions.filter.ts:19`, `:29`; registrado en `apps/api/src/main.ts:19`). |
| A9  | `hotels.controller.ts:95-102`, `:132-145`                                 | Rutas `payments` y `reservations/:id/recovery`                                        | Pasos exclusivos de Despegar.                                                                                                                       |
| A10 | `hotels.controller.ts:113-130`                                            | `reservations/:id` sin validar ni proveedor                                           | No enruta, y no verifica pertenencia al tenant (§8 G7).                                                                                             |
| A11 | `apps/api/src/hotels/hotels.schemas.ts:54-58`                             | `PrebookSchema` con `choiceId`, `lang` minúscula, `include` de Despegar               | TBO usa `BookingCode` (p. 19).                                                                                                                      |
| A12 | `hotels.schemas.ts:94-103`, `:128-144`                                    | `BookSchema` con `payment.units[].planId/secureToken`, `testCase: 'pricejump'`        | TBO paga con crédito de la agencia (`Limit`, p. 33); no hay token de pago.                                                                          |
| A13 | `hotels.schemas.ts:146-168`                                               | 11 motivos de cancelación y `RecoveryBodySchema`                                      | TBO cancela solo con `ConfirmationNumber` (p. 41).                                                                                                  |
| A14 | `hotels.schemas.ts:4`, `:7-10`, `:27`                                     | `lang` `EN\|ES\|PT`; `childrenAges` 0-17, máx 6; `destinationId` numérico de Despegar | TBO admite edades 0-18 y 1-4 niños por habitación (p. 10-11); el destino es otro espacio de ids.                                                    |
| A15 | `apps/api/src/hotels/hotels.module.ts:2`, `:9`                            | Importa `DespegarHotelsProviderModule`                                                | Registro DI del único proveedor.                                                                                                                    |
| A16 | `apps/api/src/providers-despegar/despegar-hotels.factory.ts:17-18`, `:23` | No implementa `TenantProviderFactory`                                                 | No encaja en un registry sin adaptarlo.                                                                                                             |

### 5.2 `apps/api/src/providers-tbo/`

PROPUESTA. Carpeta `providers-tbo/`, que cumple el prefijo `providers-` que el guard de órdenes descubre
(`apps/api/src/orders/order-provider-dispatch.guard.test.ts:61-66`).

| Archivo                          | Responsabilidad                                                                                                                                                                                                                                                                                                                                                           | Molde                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tbo-hotels.factory.ts`          | `TboHotelsProviderFactory implements TenantProviderFactory<HotelProviderAdapter>`: `code`, `vertical: 'hotels'`, `capabilities`, `defaultCallPolicy`, `forTenant`, `resolveForTenant`, `humanizeError`. Declara `const PROVIDER_CODE = 'tbo-hotels'`.                                                                                                                     | `apps/api/src/providers-sabre/sabre.factory.ts:378-470`, `providers-latam/latam-ndc.factory.ts:43-118` |
| `tbo-hotels.module.ts`           | `imports: [ProviderCredentialsModule]`, provee y exporta el factory.                                                                                                                                                                                                                                                                                                      | `apps/api/src/providers-despegar/despegar-hotels.module.ts:9-14`                                       |
| `tbo-hotels-errors.ts` (+ test)  | `humanizeTboError(err, ctx)`: `Record<TboFailureKind, …>` completo, con variantes según la credencial sea propia, heredada o de plataforma ([01](./01-autenticacion-conectividad-y-errores.md) §9.4), sin eco del texto del proveedor; ruta de panel "Mi Red → Credenciales → TBO Hoteles".                                                                               | `apps/api/src/hotels/despegar-hotels-errors.ts:22-60`, `providers-sabre/sabre-errors.ts`               |
| `tbo-hotels-exception.filter.ts` | `@Catch(TboApiError, TboConfigError, TboCredentialsMissingError, TboRequestBuildError, TboOfferExpiredError, TboResponseMappingError, …)` (las clases de [01](./01-autenticacion-conectividad-y-errores.md) §9.1) → estado HTTP según `kind` (409, 503 o 502, [01](./01-autenticacion-conectividad-y-errores.md) §9.4) con mensaje humanizado; log solo de `toLogMeta()`. | `apps/api/src/providers-latam/latam-ndc-exception.filter.ts:17-22`                                     |
| `tbo-hotels.factory.test.ts`     | Caché por credenciales, rotación, puerta de credenciales, aislamiento entre owners.                                                                                                                                                                                                                                                                                       | `despegar-hotels.factory.test.ts`, `apps/api/src/providers/adapter-cache-isolation.test.ts`            |

Esqueleto del `resolveForTenant` (PROPUESTA, línea base BYOC puro):

```ts
async resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
  // Sin try/catch: la NotFoundException de la bóveda (sin cuenta, o cuenta en status 'sandbox')
  // se propaga y el registry la traduce a "no habilitado". Igual que sabre.factory.ts:426-431.
  const resolved = await this.creds.resolve(tenantId, PROVIDER_CODE);
  const cfg = this.toConfig(resolved.credentials, resolved.config); // parseTboConfig: Zod, errores sin valores

  const missing = missingTboCredentials(cfg); // ['username','password'] y, si se decide, 'baseUrl'
  if (missing.length > 0) {
    this.logger.warn(`cuenta de TBO incompleta para ${resolved.ownerTenantId}: faltan [${missing.join(', ')}]`);
    throw new ProviderAccountIncompleteError(PROVIDER_CODE, missing);
  }
  const key = `byoc:${resolved.ownerTenantId}:${resolved.updatedAt.getTime()}`;
  // … caché + evictStale como despegar-hotels.factory.ts:37-53
}
```

- **Puerta de credenciales fuera de cualquier `try` que atrape `NotFoundException`.** `ProviderAccountIncompleteError`
  extiende `NotFoundException` (`provider.types.ts:349`): dentro del `try` de Despegar (`despegar-hotels.factory.ts:27-35`)
  una cuenta incompleta se convertiría en fallback de plataforma en silencio. LATAM la pone después del `try`
  (`latam-ndc.factory.ts:74-103`).
- **Si se elige fallback a credenciales de plataforma** (como Despegar/LATAM) en lugar de BYOC puro: el factory añade
  `envConfig()` con `TBO_USERNAME`/`TBO_PASSWORD`/`TBO_BASE_URL`, `credentialSource: 'env'`, y el registry de hoteles
  tiene que listar `tbo-hotels` en su equivalente de `PLATFORM_DEFAULT_FLIGHT_PROVIDERS`
  (`flight-provider.registry.ts:96-98`, `:214-222`) o la cuenta de plataforma nunca se usará. Arrastra además
  TP-50 y TP-51 de §6 para el contenedor del API.
- **Clave de caché sin componente de sesión**: Basic Auth no tiene token (p. 7), así que la caché solo reutiliza el
  cliente. No hace falta el `homePcc` que Sabre mete en la clave (`sabre.factory.ts:451`).
- **Test y live no conviven como dos cuentas `active` del mismo tenant**: `resolve_provider_account` hace `LIMIT 1` sin
  desempate por `label` (`db/migrations/0012_provider_accounts.sql:75-76`). Se cambia de entorno sustituyendo la
  cuenta, no añadiendo otra (INFERIDO).

### 5.3 Dónde vive el contrato neutral

Hoy hay dos candidatos y ninguno sirve tal como está:

| Opción                                                                                   | Qué es                                                                                                                                                                                                                                                                                                                                          | Veredicto                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/canonical/src/hotel.ts` (existente, sin uso)                                   | `HotelSchema` exige `name`, `category`, `starRating`, `address`, `location` (`:43-56`); `RoomSchema` exige `roomType` y `beds.min(1)` (`:79-92`); `CancellationPolicySchema` modela "hasta" con fecha con zona horaria (`:101-112`); `HotelStaySchema` usa `PaxCountSchema`, que no tiene edades de niños. Cero consumidores fuera del paquete. | **No como contrato de oferta.** La respuesta de Search de TBO no trae nombre, dirección ni estrellas (p. 13-15); sus políticas son "desde" `FromDate` sin zona horaria (p. 14, 24); TBO necesita las edades de los niños (p. 11). Se conserva para Package Studio y `Offer.accommodations` (`packages/canonical/src/offer.ts:173`). |
| Tipos del ACL de Despegar (`providers/despegar-hotels/src/types.ts`, `booking/types.ts`) | Contrato de facto de la vertical                                                                                                                                                                                                                                                                                                                | **No.** Viven en un ACL; semántica Despegar (`choiceId`, `planId`, `secureToken`, `recovery`).                                                                                                                                                                                                                                      |
| **Nuevo `packages/canonical/src/hotel-offer.ts`** (línea base)                           | Schemas Zod neutrales: `HotelSearchCriteria`, `HotelOffer`, `HotelRoompack`, `HotelPrice`, `HotelCancellationWindow`, `HotelFee` (suplementos `included` / `payAtProperty`), `HotelPricing`, con `provider: ProviderRef` reutilizando `ProviderRefSchema` (`offer.ts:66-88`).                                                                   | **Recomendado.** Mismo lugar y misma técnica (Zod + tipo inferido) que la oferta de vuelos.                                                                                                                                                                                                                                         |

Los **puertos** van a `packages/domain/src/ports/hotel-*.port.ts`, al nivel de `FlightSearchPort`
(`packages/domain/src/ports/flight-search.port.ts:20-36`), y reciben el mismo `SearchContext { tenantId, requestId? }`.

- `provider.offerRef` = `BookingCode` de TBO (ej. `1160804!TB!10!TB!6110a41c-558c-405c-a0d3-6bdd3e131146`, 53
  caracteres, Postman: `PreBook`), dentro del máximo de 255 (`offer.ts:68`). El `BookingCode` es opaco: no se parsea
  (INFERIDO; forma observada en p. 15-17).
- `provider.raw` lleva solo `{ searchId }`, la clave del contexto de búsqueda que el servidor guarda por
  `(tenantId, searchId)`, y **nunca** secretos, PAN ni PII, porque viaja al navegador (`offer.ts:83-85`). El
  `HotelCode`, el `BookingCode` que se reenvía, la ocupación que exige el Book (el Book no lleva edades, p. 32-34) y el
  literal de `TotalFare` se leen de ese contexto, no del navegador ([02](./02-search-y-oferta-canonica.md) §9.3;
  [08](./08-requisitos-maestro.md) RF-08, §9 C-11).
- `packages/canonical/src/index.ts:1-6` y `packages/domain/src/ports/index.ts` ya son barrels que re-exportan todo. Añadir
  el archivo nuevo al barrel sigue la convención existente, aunque `CLAUDE.md` desaconseja barrels masivos.
- **Si se elige dejar los tipos en `apps/api/src/hotels/hotel-provider.types.ts`** (alternativa más barata): los ACL no
  pueden importarlos (un paquete de `providers/` no depende de `apps/`), así que cada ACL devolvería tipos propios y el
  wrapper del factory los convertiría. Duplica el mapeo y deja la validación Zod de la oferta fuera del canónico.

### 5.4 `HotelProviderRegistry`

PROPUESTA, espejo de `FlightProviderRegistry` (`apps/api/src/providers/flight-provider.registry.ts:71-247`).

**Interfaz del adapter.** Obligatoria para todo proveedor de hoteles, opcional por presencia de método:

```ts
// apps/api/src/providers/hotel-provider.types.ts   [PROPUESTA]
export interface HotelProviderAdapter
  extends HotelSearchPort,
    HotelPrebookPort,
    HotelBookPort,
    HotelBookingReadPort,
    HotelCancelPort {}

// Opcionales, detectadas por PRESENCIA del método, como supportsAuditedCreate (provider.types.ts:104-114)
export interface HotelBookingByClientReferencePort {
  getBookingByClientReference(ref: string, ctx: SearchContext): Promise<HotelBookingView>;
} // TBO
export interface HotelBookingsByDatePort {
  listBookingsByDate(range: DateRange, ctx: SearchContext): Promise<HotelBookingSummary[]>;
} // TBO
export interface HotelSuggestPort {
  suggest(q: string, ctx: SearchContext): Promise<DestinationSuggestion[]>;
} // Despegar
export interface HotelRatesDetailPort {
  getHotelRates(q: HotelRatesQuery, ctx: SearchContext): Promise<HotelOffer>;
} // Despegar
export interface HotelPaymentOptionsPort {
  /* … */
} // Despegar
export interface HotelPriceJumpRecoveryPort {
  /* … */
} // Despegar

export interface HotelProviderCapabilities {
  readonly retrieve: boolean;
  readonly cancel: boolean;
  readonly retrieveByClientReference: boolean; // decide si el saga puede verificar un Book sin ConfirmationNumber
  readonly reconcileByDate: boolean;
}
export const HOTEL_PROVIDER_FACTORIES = 'HOTEL_PROVIDER_FACTORIES';
```

- `ProviderCapabilities` de vuelos (`provider.types.ts:121-129`) no sirve: `pay`, `services` y `reshop` no significan
  nada en hoteles. Para las órdenes (§5.5) se proyecta `HotelProviderCapabilities` → `ProviderCapabilities` con
  `pay/services/reshop: false`.
- El `vertical` del factory ya admite `'hotels'` (`provider.types.ts:150`); `TenantAdapter`, `ResolvedProvider`,
  `UnavailableProvider`, `ProviderAccountIncompleteError`, `ProviderNotAvailableError` y `ProviderCallError` se
  reutilizan sin cambios (`provider.types.ts:152-238`, `:315-372`).

**Registry y módulo.**

| Pieza                             | Comportamiento                                                                                                                                                                          | Molde                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `HotelProvidersModule`            | `useFactory: (despegar, tbo) => [despegar, tbo]`, `inject: [DespegarHotelsProviderFactory, TboHotelsProviderFactory]`, flags por env mientras no haya Unleash.                          | `apps/api/src/providers/providers.module.ts:55-71` |
| `forTenant(tenantId)`             | `{ active, skipped, unavailable }` en orden alfabético; `opt-in` consulta el flag antes de tocar la bóveda.                                                                             | `flight-provider.registry.ts:109-133`              |
| `byCode(tenantId, code)`          | Para prebook, book, cancel y post-venta; no consulta el flag; desconocido → `ProviderNotAvailableError` (400).                                                                          | `flight-provider.registry.ts:141-148`              |
| Fallback de plataforma            | `PLATFORM_DEFAULT_HOTEL_PROVIDERS` con default `'despegar-hotels'`: conserva el comportamiento actual de Despegar (cae a env, `despegar-hotels.factory.ts:31-35`) sin extenderlo a TBO. | `flight-provider.registry.ts:20-25`, `:214-222`    |
| `capabilitiesOf`, `humanizeError` | Delegan en el factory.                                                                                                                                                                  | `flight-provider.registry.ts:167-176`              |

**Enrutado.**

| Operación                            | Cómo se elige el proveedor                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Búsqueda                             | Fan-out sobre `registry.forTenant(tenantId).active`; por proveedor, sus `hotel_id` de `hotel_inventory` con **su** `provider_code`.                      |
| PreBook                              | `offer.provider.name` del body, validado con `registry.byCode` (mismo criterio que `priceOffer` en vuelos, `apps/api/src/search/search.service.ts:467`). |
| Book                                 | `orders.provider` del intent creado en el PreBook o en el Book (§5.5), nunca un campo libre del cliente.                                                 |
| Detalle / cancelación / verificación | `orders.provider` de la fila, leída con RLS del tenant.                                                                                                  |

**Espejo o registry genérico.** Espejo (copiar ~250 líneas cambiando tipo, token y variables) no toca `src/search/**`,
que tiene umbral de cobertura propio (`apps/api/vitest.config.ts:62-67`). Un `ProviderRegistry<TAdapter>` genérico del
que vuelos sea una instancia es más limpio pero mueve código de vuelos con suites grandes. Línea base: espejo primero,
genérico como deuda registrada.

### 5.5 Reserva como orden: intent antes del Book

La línea base exige persistir la reserva **antes** de llamar a Book. Nada de esto existe para hoteles, y las piezas de
vuelos no se pueden llamar desde fuera:

| Pieza de vuelos                                                      | Dónde                                                                           | Problema para hoteles                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intent `pending` con `create_request_key` y `order_number` bajo lock | `apps/api/src/orders/orders.service.ts:694-799` (`insertCreateIntent`, privado) | Privado y atado a `CreateOrderDto` de vuelos (`apps/api/src/orders/orders.service.ts:193-199`; su borde Zod es `CreateOrderSchema`, `apps/api/src/orders/dto.ts:13-28`). |
| Consolidación CAS del intent                                         | `orders.service.ts:820-852` (`settleCreateIntent`, privado)                     | Idem.                                                                                                                                                                    |
| Persistencia de verticales externas                                  | `orders.service.ts:206-217`, `:278` (`recordExternalOrder`)                     | Inserta **después** de reservar y con `create_request_key` nulo: un timeout del Book no deja fila (patrón Autos, `apps/api/src/cars/cars.service.ts:163-174`).           |
| Verificación diferida                                                | `orders.service.ts:1577-1583` (`verifyCreationById`)                            | Retorna si no hay `provider_order_id` y resuelve por el registry de **vuelos**: un Book de TBO con timeout no tiene `ConfirmationNumber`.                                |
| Job de verificación                                                  | `apps/api/src/queue/post-sale-queue.service.ts:11-17`, `:110-125`               | `extra` solo admite `jobId`: no hay `delay`, y TBO exige esperar 120 s (p. 42).                                                                                          |
| Enrutado del worker                                                  | `apps/api/src/orders/post-sale.worker.ts:32-50`                                 | Nombre de job desconocido → lanza (`:48-49`).                                                                                                                            |

PROPUESTA de seam (el diseño del saga está en [03](./03-prebook-y-book.md) y [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)):

1. `OrdersService` expone una API pública de intent para verticales externas (`openExternalCreateIntent`,
   `settleExternalCreateIntent`, `failExternalCreateIntent`) que reutiliza el mismo lock de `order_number`, el índice
   único de `create_request_key` (`db/migrations/0038_order_create_idempotency.sql:11-13`) y el marcador de conciliación.
2. El `BookingReferenceId` (p. 33) lo genera el ACL con un generador criptográfico propio
   ([03](./03-prebook-y-book.md) §3.3) y el servidor lo guarda en `orders.provider_booking_ref`, con índice único
   **entre tenants**, en la misma transacción que el intent. **No** es el `create_request_key`: esa clave de
   idempotencia sale del `Idempotency-Key` del cliente y solo es única por tenant
   (`apps/api/src/orders/orders.service.ts:166-178`), y dos sub-agencias que heredan la misma cuenta TBO podrían
   repetirla ([08](./08-requisitos-maestro.md) RF-19, §9 C-08). Formato y longitud no están documentados (p. 33).
   → [Q-34](./10-preguntas-para-tbo.md#q-34), [Q-35](./10-preguntas-para-tbo.md#q-35): formato, longitud máxima, caracteres permitidos y alcance de unicidad
   de `BookingReferenceId` y `ClientReferenceId`; y si TBO rechaza un Book con un `BookingReferenceId` repetido.
3. Book que lanza o vence el timeout → intent queda `pending` + job `verify-hotel-booking` con `delay` de 120 s → lectura
   por `getBookingByClientReference` (capacidad de TBO) → consolidar o escalar. → [Q-37](./10-preguntas-para-tbo.md#q-37): qué `Status.Code`
   devuelve `BookingDetail` cuando el `BookingReferenceId` no corresponde a ninguna reserva.
   La decisión "consolidar / escalar / compensar" va en funciones puras sin I/O, al estilo de
   `apps/api/src/orders/order-create.saga.ts` (`planVerification`, `decideAfterVerify`, `decideAfterCreateThrew`), y el
   worker solo enruta (`post-sale.worker.ts:15-26`). Es la restricción de diseño con la que se cerró D9
   (`docs/sabre/10-requisitos-maestro.md` §9): la lógica que decide no puede vivir dentro del `Worker` de BullMQ.
4. Vocabulario de eventos: se reutiliza `ORDER_EVENTS` (`apps/api/src/orders/order-events.ts:15-30`), que no es de
   vuelos; el payload lleva `vertical: 'hotels'` y resúmenes sin PII. Es mejor que un literal suelto como
   `CarReservationCreated` (`cars.service.ts:230`), que queda fuera del vocabulario cerrado.
5. Cancelación desde Reservas: `runCancel` pasa de `if (provider === 'agent-cars') … else flightAdapter`
   (`orders.service.ts:1214-1217`) a resolver primero el registry de hoteles por capacidad. El error del ACL tiene que
   respetar el contrato implícito de `classifyCancelThrownFailure` (`cancel-retry-policy.ts:84-136`):
   - `status` solo HTTP. Con el `Status.Code` de TBO en `status`, `479` cae en `status >= 400 && < 500`
     (`cancel-retry-policy.ts:73-74`) y la cancelación se cierra `FAILED` sin conciliar.
   - `479 CANCEL_FAIL` **no se lanza**: el adapter devuelve `{ success: false }` y la lectura posterior de
     `BookingDetail` decide; si la reserva ya figura cancelada, es un éxito idempotente, y si la lectura falla, se
     agenda `verify-cancellation` de solo lectura, nunca un segundo Cancel ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
     §4.3-§4.4; [08](./08-requisitos-maestro.md) RF-25, §9 C-05). La lectura importa porque existen estados
     intermedios de cancelación (`CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel`, p. 70-71).
     → [Q-50](./10-preguntas-para-tbo.md#q-50): si `479` es definitivo o puede significar "en curso".
   - El **nombre** de la clase también clasifica: `DETERMINISTIC_ERROR` (`cancel-retry-policy.ts:38-39`) casa
     cualquier nombre que termine en `ValidationError`, `ConfigError`, `NotSupportedError`, `MappingError`… y lo
     cierra `FAILED` sin conciliar. Un `TboResponseMappingError` genérico (§4.3 regla 3), lanzado al validar la
     respuesta de `/Cancel`, cerraría como fallida una cancelación que TBO sí pudo aplicar. Un fallo de schema en
     la respuesta de Cancel tiene que llamarse `TboCancelMappingError`, que casa `CANCEL_RESPONSE_MAPPING_ERROR`
     (`cancel-retry-policy.ts:37`) → `UNVERIFIED` + releer `BookingDetail`.
6. Pertenencia: toda lectura o cancelación por id pasa por la fila de `orders` leída con RLS del tenant, **antes** de
   llamar a TBO. Con herencia BYOC, las sub-agencias comparten la cuenta TBO del consolidador, y `BookingDetail` por
   `ConfirmationNumber` devolvería reservas de agencias hermanas (INFERIDO: TBO acota por cuenta, no por nuestra
   jerarquía).

**Si se elige no persistir** (patrón Despegar) o persistir después (patrón Autos): desaparecen los puntos 1-3 y los
touchpoints TP-32 a TP-39 y TP-65 de §6, pero un timeout del Book deja una reserva con dinero sin fila, sin evento y sin
forma de cumplir la recuperación obligatoria de p. 42.

### 5.6 Qué cambia en la vertical

| Archivo                                    | Cambio (PROPUESTA)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/hotels/hotels.service.ts`    | Inyecta `HotelProviderRegistry` en lugar del factory (`:21`, `:29`); elimina `PROVIDER_CODE` (`:24`). Búsqueda: cuota → `registry.forTenant` → por proveedor `resolveCityHotelIds(providerCode, destino)` → `breaker.execute(code, …)` → `ProviderCallError` humanizado → `fanOut` → puerta de moneda → enriquecimiento con `hotel_inventory` (TBO no trae nombre ni estrellas, p. 13-15) → waterfall. Respuesta `{ hotels, providers: ProviderOutcome[] }` sin romper `hotels` (patrón `search.service.ts:40-56`). Telemetría con `breakdownOf` (`search-telemetry.service.ts:159`), no `uniformSlices` (`:193-194`, "sólo es fiel con UN proveedor"). Reserva vía el saga de §5.5.                                                                                                                                                    |
| `apps/api/src/hotels/hotels.controller.ts` | Tipos neutrales en las firmas (`:12-22`); `@UseFilters(DespegarHotelsExceptionFilter, TboHotelsExceptionFilter)` (precedente de varios filtros: `apps/api/src/search/search.controller.ts:58`); rutas `payments` y `recovery` gateadas por capacidad (400 si el proveedor de la orden no la tiene); `reservations/:id` pasa a ser el id de **nuestra** orden, validado como UUID; `availability` añade `showProviderInResults` fuera de la carga, como `search.controller.ts:84-92` (TP-66).                                                                                                                                                                                                                                                                                                                                            |
| `apps/api/src/hotels/hotels.schemas.ts`    | `z` desde `@sales-travel/validation` en vez de `'zod'` (`:1`); `RoomDistributionSchema` acotado por proveedor o en el ACL (`:7-10`); prebook/book con `offer.provider` y datos de huéspedes neutrales; extensiones de Despegar en una unión discriminada por `provider.name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/api/src/hotels/hotels.module.ts`     | Importa `HotelProvidersModule`, `OrdersModule` y `AuditModule` (precedente: `apps/api/src/cars/cars.module.ts:10`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Circuit breaker                            | Envuelve **todas** las llamadas de TBO (hoy solo la búsqueda, `hotels.service.ts:105`), para que `PROVIDERS_DISABLED=tbo-hotels` apague también la reserva. Los errores de negocio o de credenciales no deben contar como fallos del proveedor: el breaker cuenta cualquier excepción (`circuit-breaker.service.ts:90-91`) y el circuito es uno por código para todos los tenants (`:31`). Ver §8 G12. En Cancel, el rechazo del breaker (`ServiceUnavailableException`, sin `path` y con `status` 503, `circuit-breaker.service.ts:64-77`) cae en el caso por defecto de `classifyCancelThrownFailure` → `UNVERIFIED` con conciliación y escalado (`cancel-retry-policy.ts:130-135`; `orders.service.ts:1238`, `:1273-1278`) aunque la llamada nunca salió: el runner tiene que tratar ese rechazo como pre-write antes de clasificar. |

### 5.7 Alternativa B: módulo TBO paralelo

Qué es: `apps/api/src/hotels-tbo/` con controlador propio (p. ej. `/hotels/tbo/*`), servicio propio que inyecta
`TboHotelsProviderFactory` concreto, schemas propios; `HotelsService` de Despegar queda intacto.

| Costo                                  | Detalle                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratos duplicados                   | Dos `HotelOffer` distintos en `apps/api` y dos espejos en `apps/web-b2b` (hoy ya hay uno a mano, `apps/web-b2b/src/app/(app)/hoteles/actions.ts:5-83`). |
| Sin búsqueda combinada                 | El vendedor busca en dos pantallas; no hay fan-out, dedupe ni comparación de precio entre proveedores.                                                  |
| Telemetría, cuota y pricing duplicados | Se copian `withPricing`, `tenantDefaults`, `resolveCityHotelIds` y la instrumentación (`hotels.service.ts:47-64`, `:88-119`, `:131-141`, `:201-214`).   |
| El trabajo de órdenes se hace igual    | El intent antes del Book (§5.5) es obligatorio para TBO por p. 42 con cualquier alternativa.                                                            |
| Deuda para el tercer proveedor         | El tercer bedbank obliga a generalizar de todos modos, con dos vertical ya divergidas.                                                                  |
| Lo que ahorra                          | No toca Despegar ni su UI; menos riesgo de regresión en producción; entrega TBO antes si la prioridad es certificar.                                    |

---

## 6. Tabla maestra de touchpoints

Método: `grep -rn 'despegar-hotels'` y `grep -rn 'agent-cars'` sobre `apps/ packages/ providers/ tools/ db/ .github/
infrastructure/ eslint.config.mjs` (excluidos `node_modules`, `dist`, `.turbo`, `.next`, `coverage`), más búsqueda de
listas de proveedores sin esos literales (`DESPEGAR_`, `AGENT_CARS_`, `PROVIDERS_DISABLED`, `verticalMap`,
`PROVIDER_METADATA`, `provider_catalog`, `hotel_inventory`). No existe `docker-compose*` en la raíz; el único compose es
`infrastructure/hostinger/docker-compose.prod.yml`. Todas las filas son VERIFICADO-CODIGO salvo marca.

**Acción:** **OBLIGATORIO** = sin esto TBO no funciona o viola una regla cerrada; **RECOMENDADO** = TBO funciona pero
no es de primera clase o hereda un defecto; **NADA** = genérico, no se toca. "(línea base)" = obligatorio solo con la
arquitectura de §0.

| #     | Archivo:línea                                                                                                                                                                  | Qué hay hoy                                                                                                         | Acción                         | Qué hacer para TBO                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TP-01 | `pnpm-workspace.yaml:4`                                                                                                                                                        | Glob `providers/*`                                                                                                  | NADA                           | El paquete nuevo entra solo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| TP-02 | `apps/api/package.json:19`, `:22`, `:25`                                                                                                                                       | `agent-cars`, `despegar-hotels`, `sabre` como `workspace:*`                                                         | OBLIGATORIO                    | Añadir `"@sales-travel/tbo-hotels": "workspace:*"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| TP-03 | `pnpm-lock.yaml`                                                                                                                                                               | Lock del workspace                                                                                                  | OBLIGATORIO                    | Regenerar con `pnpm install`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TP-04 | `turbo.json:7-10`, `:18-35`                                                                                                                                                    | `build`/`typecheck`/`test` dependen de `^build`                                                                     | NADA                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-05 | `apps/api/Dockerfile:21`, `:29`                                                                                                                                                | Copia `providers/` entera; build por grafo `^...`                                                                   | NADA                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-06 | `.github/workflows/ci.yml:42-49`, `:96-97`, `:134-135`                                                                                                                         | Build antes de lint; build `^...` antes de tests; `pnpm test` por turbo                                             | NADA                           | El script `test` del paquete corre solo en CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TP-07 | `eslint.config.mjs:51`, `:57`, `:63`, `:69`                                                                                                                                    | Regla D1 por nombre de archivo; claves camelCase sin flag `i`                                                       | OBLIGATORIO                    | Extender a las claves PascalCase de TBO (§4.3 regla 1) y fijarlo con un test que ejecute ESLint.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TP-08 | `providers/tbo-hotels/**`                                                                                                                                                      | No existe                                                                                                           | OBLIGATORIO                    | Paquete ACL de §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TP-09 | `packages/canonical/src/hotel-offer.ts` (nuevo) + `packages/canonical/src/index.ts:1-6`                                                                                        | Contrato de oferta de hotel dentro del ACL de Despegar                                                              | OBLIGATORIO (línea base)       | Contrato neutral Zod con `provider: ProviderRef` (§5.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TP-10 | `packages/domain/src/ports/hotel-*.port.ts` (nuevo) + `packages/domain/src/ports/index.ts`                                                                                     | Solo puertos de vuelos                                                                                              | OBLIGATORIO (línea base)       | Puertos de hotel (§5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TP-11 | `packages/canonical/src/hotel.ts:43-139`                                                                                                                                       | Canónico de hotel sin consumidores                                                                                  | NADA                           | No se usa como contrato de oferta (§5.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TP-12 | `providers/despegar-hotels/src/types.ts:84-91`, `src/index.ts:54`                                                                                                              | Contrato propio; adapter sin puerto                                                                                 | OBLIGATORIO (línea base)       | Mapear al contrato neutral (en el ACL o en un wrapper en el factory, como `SabreFlightProviderAdapter`, `sabre.factory.ts:209`).                                                                                                                                                                                                                                                                                                                                                                                                |
| TP-13 | `apps/api/src/providers-tbo/*` (nuevo)                                                                                                                                         | No existe                                                                                                           | OBLIGATORIO                    | Factory, módulo, humanizador, filtro y tests (§5.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TP-14 | `apps/api/src/providers/provider.types.ts:150`, `:152-238`, `:315-372`                                                                                                         | Tipos genéricos; `ProviderVertical` ya incluye `'hotels'`                                                           | NADA                           | Se reutilizan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TP-15 | `apps/api/src/providers/hotel-provider.types.ts`, `hotel-provider.registry.ts`, `hotel-providers.module.ts` (nuevos)                                                           | Solo existe el registry de vuelos                                                                                   | OBLIGATORIO (línea base)       | Registry espejo (§5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TP-16 | `apps/api/src/providers-despegar/despegar-hotels.factory.ts:17-44`                                                                                                             | No implementa `TenantProviderFactory`                                                                               | OBLIGATORIO (línea base)       | Implementarlo; `humanizeError` delega en `humanizeDespegarError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-17 | `apps/api/src/hotels/hotels.module.ts:2`, `:9`                                                                                                                                 | Importa el módulo de Despegar                                                                                       | OBLIGATORIO                    | Importar `HotelProvidersModule` (o el de TBO en la alternativa B).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TP-18 | `apps/api/src/hotels/hotels.service.ts:2-15`, `:21`, `:24`, `:29`, `:96`, `:105`, `:135`, `:165-196`                                                                           | Servicio cableado a Despegar                                                                                        | OBLIGATORIO                    | §5.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TP-19 | `apps/api/src/hotels/hotels.controller.ts:12-22`, `:48`, `:95-145`                                                                                                             | Tipos y filtro de Despegar                                                                                          | OBLIGATORIO                    | §5.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TP-20 | `apps/api/src/hotels/hotels.schemas.ts:1`, `:4`, `:7-10`, `:27`, `:54-168`                                                                                                     | Schemas con forma Despegar                                                                                          | OBLIGATORIO                    | §5.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TP-21 | `apps/api/src/hotels/despegar-hotels-exception.filter.ts:17`, `:22`                                                                                                            | Loguea 250 caracteres del cuerpo del proveedor                                                                      | RECOMENDADO                    | Gap preexistente (§8 G6). El filtro de TBO nace sin eso.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TP-22 | `apps/api/src/provider-credentials/provider-specs.ts:184-187`, `:195-201`                                                                                                      | `DESPEGAR_HOTELS` solo con `safeConfigKeys`                                                                         | OBLIGATORIO                    | Entrada `'tbo-hotels'` con `fields` `username`/`password` `encrypted-only` y `safeConfigKeys` = claves no secretas que lee el factory (`baseUrl`, …).                                                                                                                                                                                                                                                                                                                                                                           |
| TP-23 | `apps/api/src/provider-credentials/dto.test.ts:116-123`                                                                                                                        | Tabla de regresión sin hoteles                                                                                      | RECOMENDADO                    | Casos TBO: acepta completa, rechaza sin `password`, rechaza `password` en `config`, no hace eco del valor.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TP-24 | `provider-credentials.service.ts`, `provider-credentials.controller.ts`, `credentials-cipher.ts`, `dto.ts`                                                                     | Genéricos por `provider_code`                                                                                       | NADA                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-25 | `apps/api/src/search/circuit-breaker.service.ts:31`, `:33-41`, `:63-100`                                                                                                       | Breaker por código; kill-switch `PROVIDERS_DISABLED`                                                                | RECOMENDADO                    | Sin cambio funciona. Recomendado: predicado de "cuenta como fallo" o circuito por cuenta (§8 G12).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TP-26 | `apps/api/src/search/search-telemetry.service.ts:7`, `:145-159`; `db/migrations/0032_search_logs.sql:17-18`                                                                    | Vertical `hotels` y `provider_code` libres                                                                          | NADA                           | Pasar `breakdownOf`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TP-27 | `apps/api/src/search/provider-fanout.ts:27-50`, `:59-71`                                                                                                                       | `fanOut` y `dedupeCheapest` genéricos                                                                               | NADA                           | Reutilizar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TP-28 | `apps/api/src/health/health.controller.ts:50`                                                                                                                                  | `breaker.snapshot()` público, con todas las claves del breaker                                                      | OBLIGATORIO                    | Con circuitos por cuenta, el snapshot público los agrega o los excluye para no publicar qué cuentas tienen la credencial rechazada ([01](./01-autenticacion-conectividad-y-errores.md) §12.3; [08](./08-requisitos-maestro.md) RNF-03, §9 C-15).                                                                                                                                                                                                                                                                                |
| TP-29 | `apps/api/src/hotels/hotels.service.ts:47-64`; `db/migrations/0016_pricing_waterfall.sql:40`                                                                                   | Waterfall por vertical `hotels`                                                                                     | OBLIGATORIO (con D-TBO-16 A)   | Piso `RecommendedSellingRate` en todo precio al viajero, en todos los canales (VERIFICADO-PDF p. 13, 21; [08](./08-requisitos-maestro.md) RF-12, §9 C-18). Con D-TBO-16 (B) sería obligatorio solo antes de B2C. Ver [02](./02-search-y-oferta-canonica.md) §9.5.                                                                                                                                                                                                                                                               |
| TP-30 | `apps/api/src/app.module.ts:30`, `:63`                                                                                                                                         | Registra `HotelsModule`                                                                                             | NADA                           | Solo cambia si TBO tiene módulo raíz propio (alternativa B).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| TP-31 | `apps/api/src/orders/order-provider-dispatch.guard.test.ts:50`, `:61-72`                                                                                                       | `NO_ES_VUELOS = new Set(['agent-cars', 'despegar-hotels'])`; descubre `PROVIDER_CODE` en `providers-*/*.factory.ts` | OBLIGATORIO                    | Añadir `'tbo-hotels'`. Sin eso el guard trata a TBO como vuelos y prohíbe el literal en `orders/*.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TP-32 | `apps/api/src/orders/orders.service.ts:694-879`, `:278`                                                                                                                        | Intent privado de vuelos; `recordExternalOrder` sin clave                                                           | OBLIGATORIO (línea base)       | API pública de intent (§5.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TP-33 | `apps/api/src/orders/orders.service.ts:243-250`, `:1214-1217`, `:1577-1583`                                                                                                    | Inyecta `AgentCarsProviderFactory`; rama `agent-cars` en `runCancel`; verificación solo por registry de vuelos      | OBLIGATORIO (línea base)       | Resolver hoteles por su registry; verificación por referencia de cliente.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TP-34 | `apps/api/src/orders/orders.controller.ts:38-53`, `:71`, `:237-240`                                                                                                            | Capacidades fijas de AgentCars; tres filtros de proveedor                                                           | OBLIGATORIO (línea base)       | Capacidades de hotel vía registry; añadir el filtro de TBO.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TP-35 | `apps/api/src/orders/orders.module.ts`                                                                                                                                         | Importa `ProvidersModule` y `AgentCarsProviderModule`                                                               | OBLIGATORIO (línea base)       | Importar `HotelProvidersModule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TP-36 | `apps/api/src/orders/order-events.ts:15-30`                                                                                                                                    | Vocabulario cerrado, agnóstico de vertical                                                                          | RECOMENDADO                    | Reutilizar; resúmenes de hotel sin PII.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TP-37 | `apps/api/src/orders/cancel-retry-policy.ts:36-39`, `:63-75`, `:84-136`                                                                                                        | Clasifica por forma del error                                                                                       | NADA                           | Los errores de TBO respetan el contrato (§5.5 punto 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| TP-38 | `apps/api/src/queue/post-sale-queue.service.ts:11-17`, `:110-125`                                                                                                              | Tres jobs; sin `delay`                                                                                              | OBLIGATORIO (línea base)       | `delay` en `extra` y jobs `verify-hotel-booking` y de seguimiento de HCN (p. 42-43). El port `JobQueuePort` ya declara `delayMs` (`packages/core/src/ports/job-queue.port.ts:1-10`) pero no tiene implementación: el servicio importa `bullmq` directo (`post-sale-queue.service.ts:2`).                                                                                                                                                                                                                                        |
| TP-39 | `apps/api/src/orders/post-sale.worker.ts:32-50`                                                                                                                                | `switch` por nombre de job                                                                                          | OBLIGATORIO (línea base)       | Enrutar los jobs nuevos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TP-40 | `apps/api/src/orders/dto.ts:13-28`                                                                                                                                             | `CreateOrderSchema` de vuelos                                                                                       | NADA                           | Hoteles entra por su propio endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TP-41 | `apps/api/src/mail/templates.ts:115`, `:125-128`                                                                                                                               | Confirmación con ruta `origen → destino`                                                                            | RECOMENDADO                    | Variante de hotel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TP-42 | `apps/api/src/reports/reports.service.ts:48-53`, `:62`                                                                                                                         | `verticalMap` sin `despegar-hotels` ni `tbo-hotels`; fallback `'Vuelos'`                                            | RECOMENDADO                    | Derivar la vertical de `search_criteria.vertical` o del catálogo; mínimo, añadir `'tbo-hotels': 'Hoteles'`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TP-43 | `db/migrations/0035_multi_flight_provider.sql:83-102`, `:114-121`                                                                                                              | `provider_catalog`; nadie lo lee                                                                                    | RECOMENDADO                    | Migración M4 ([08](./08-requisitos-maestro.md) §9 C-10; número tentativo en [09](./09-plan-implementacion.md) §3.3) con la fila `tbo-hotels`, `vertical 'hotels'`, capacidades reales. Hoy no cambia comportamiento.                                                                                                                                                                                                                                                                                                            |
| TP-44 | `db/migrations/0022_hotel_inventory.sql:6-26`; `apps/api/src/database/database.types.ts:214-228`                                                                               | Tabla ya multi-proveedor                                                                                            | NADA                           | Filas `provider_code = 'tbo-hotels'` por el sync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-45 | Migración nueva de destinos (p. ej. `hotel_city_map`)                                                                                                                          | No existe mapeo de ciudades entre proveedores                                                                       | Según decisión                 | Ver §9 H6 y [05](./05-contenido-estatico-e-inventario.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TP-46 | `db/migrations/0012_provider_accounts.sql:59-77`; `0010_sprint1_core_suite.sql:98`                                                                                             | Bóveda genérica; `provider_name VARCHAR(50)`                                                                        | NADA                           | `tbo-hotels` tiene 10 caracteres.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-47 | `tools/sync-hotel-inventory/src/index.ts:13-17`, `:60-94`, `:97`, `:138-143`                                                                                                   | Sync 100 % Despegar con su propio `fetch`                                                                           | OBLIGATORIO                    | Tool nuevo (o fuentes por proveedor) que use `tbo-static-content.client.ts` del ACL; `DELETE … WHERE provider_code = 'tbo-hotels'`. Hoy el tool no depende de ningún paquete del workspace (`tools/sync-hotel-inventory/package.json:15-17`), es ESM (`:5`) frente a un ACL CommonJS, y su `Dockerfile` solo copia `tools/sync-hotel-inventory` (`tools/sync-hotel-inventory/Dockerfile:14-19`): consumir el ACL exige copiar `packages/` y `providers/` y construir por grafo `^...`, como `apps/api/Dockerfile:20-21`, `:29`. |
| TP-48 | `.github/workflows/sync-hotel-inventory.yml:14-56`                                                                                                                             | Cron 03:30 UTC contra Despegar; `timeout-minutes: 15` (`:16`)                                                       | OBLIGATORIO                    | Job TBO con sus credenciales; revisar el timeout (el recorrido país → ciudad → hoteles son muchas llamadas, INFERIDO).                                                                                                                                                                                                                                                                                                                                                                                                          |
| TP-49 | `.github/workflows/deploy.yml:38-44`                                                                                                                                           | Matriz de imágenes con `sync-hotel-inventory`                                                                       | OBLIGATORIO si hay tool nuevo  | Añadir la imagen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-50 | `.github/workflows/deploy.yml:119-158` (`DESPEGAR_*` en `:139-144`)                                                                                                            | Render del `.env` del VPS                                                                                           | OBLIGATORIO (sync)             | `TBO_*` de la cuenta de plataforma para el sync; para el API solo si se decide fallback de plataforma.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TP-51 | `infrastructure/hostinger/docker-compose.prod.yml:91-138` (`DESPEGAR_*` en `:112-118`)                                                                                         | Solo llegan al contenedor `api` las variables listadas; no hay `env_file`                                           | Según decisión                 | `TBO_*` solo si hay fallback de plataforma en el API. Recomendado cablear `PROVIDERS_DISABLED` (§8 G13).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TP-52 | `infrastructure/hostinger/Caddyfile`                                                                                                                                           | Proxy sin timeouts explícitos                                                                                       | NADA                           | Ver §9 H4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TP-53 | `apps/web-b2b/src/lib/provider-forms.ts:308-312`, `:79-88`                                                                                                                     | `PROVIDERS` = `latam-ndc`, `agent-cars`, `sabre`; `fallsBackToPlatformCredentials`                                  | OBLIGATORIO                    | Formulario `'tbo-hotels'`: usuario, contraseña secreta, `baseUrl`; `fallsBackToPlatformCredentials` según decisión.                                                                                                                                                                                                                                                                                                                                                                                                             |
| TP-54 | `apps/web-b2b/src/lib/provider-forms.test.ts:42`                                                                                                                               | Fija la lista exacta de `PROVIDERS`                                                                                 | OBLIGATORIO (con TP-53)        | Actualizar el array.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| TP-55 | `apps/web-b2b/src/app/(app)/red/page.tsx:758`, `:917`, `:1059`; `apps/web-b2b/src/app/(app)/admin/proveedores/page.tsx:190`, `:443`                                            | Iteran `PROVIDERS` / `providerFormFor`                                                                              | NADA                           | El formulario aparece solo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TP-56 | `apps/web-b2b/src/lib/provider-display.ts:24-57`, `:69-79`                                                                                                                     | `PROVIDER_METADATA` con fallback                                                                                    | RECOMENDADO                    | Ficha `'tbo-hotels'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TP-57 | `apps/web-b2b/src/app/(app)/hoteles/actions.ts:5-83`, `:57-72`, `:101`, `:174`                                                                                                 | Espejo manual del contrato Despegar, sin `pricing` ni proveedor                                                     | OBLIGATORIO                    | Espejo del contrato neutral (`provider`, `pricing`, suplementos, `providers[]`).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TP-58 | `apps/web-b2b/src/app/(app)/hoteles/_components/destination-combobox.tsx:8-12`, `:94`                                                                                          | Destino = geo id de Despegar                                                                                        | Según decisión                 | Ver §9 H6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TP-59 | `apps/web-b2b/src/app/(app)/hoteles/page.tsx:39`, `:96-107`, `:122-124`, `:160`                                                                                                | Copy "vía Despegar/HotelDo"; IDs de hotel crudos; `key={offer.hotelId}`                                             | RECOMENDADO                    | Copy neutral; `key` `provider:hotelId`; IDs calificados por proveedor.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TP-60 | `apps/web-b2b/src/app/(app)/hoteles/_components/hotel-result-card.tsx:12`, `:62`, `:101-118`                                                                                   | Pinta el neto y la comisión                                                                                         | RECOMENDADO                    | Precio de venta (`pricing.finalMinor`); gap preexistente (§8 G3).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-61 | Pantallas de reserva de hotel (no existen)                                                                                                                                     | Solo búsqueda                                                                                                       | OBLIGATORIO para vender por UI | Detalle, PreBook con suplementos `AtProperty` visibles antes de reservar (KP-4, p. 71), Book, estado. Ver [07](./07-certificacion.md).                                                                                                                                                                                                                                                                                                                                                                                          |
| TP-62 | `apps/web-b2b/src/app/(app)/reservas/page.tsx:99-101`                                                                                                                          | `isCarOrder`; todo lo demás se pinta como vuelo                                                                     | OBLIGATORIO (línea base)       | `isHotelOrder` por `searchCriteria.vertical === 'hotels'`, no por código.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TP-63 | `apps/web-b2b/src/app/(app)/carteras/CarterasClient.tsx:521`                                                                                                                   | Muestra el código crudo salvo `latam-ndc`                                                                           | RECOMENDADO                    | `providerMetaFor(o.provider).name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| TP-64 | `apps/api/src/cars/**`                                                                                                                                                         | Vertical autos                                                                                                      | NADA                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TP-65 | `apps/api/src/orders/order-create.saga.ts:9-38`, `:215`, `:284`, `:346`                                                                                                        | Decisiones puras del saga de vuelos (sin I/O), exigidas por D9                                                      | OBLIGATORIO (línea base)       | Decisiones del saga de hotel (verificar a los 120 s, consolidar, escalar) como funciones puras hermanas; el worker solo enruta (§5.5 punto 3).                                                                                                                                                                                                                                                                                                                                                                                  |
| TP-66 | `apps/api/src/search/search.controller.ts:84-92`; `apps/api/src/provider-disclosure/provider-disclosure.service.ts:54-63`; `apps/web-b2b/src/lib/provider-disclosure.ts:72-74` | Vuelos devuelve `showProviderInResults` (divulgación por cadena de tenants, 0036) aparte de la carga; hoteles no    | OBLIGATORIO (línea base)       | Con `provider` en la oferta y `providers[]` en la respuesta (§5.6), el endpoint de hoteles devuelve también `showProviderInResults` y la UI (TP-59) solo pinta el proveedor si es `true`. Sin eso, la sub-agencia ve de quién compra el consolidador. Es el requisito del founder al firmar D-TBO-06 (A), "me tiene que mostrar de dónde es": [08](./08-requisitos-maestro.md) RF-40.                                                                                                                                           |
| TP-67 | `apps/api/src/search/sin-ofertas-fabricadas.guard.test.ts:346`                                                                                                                 | Guard de alcanzabilidad de fixtures con raíz solo en `search.controller.ts`                                         | RECOMENDADO                    | Segunda raíz en `hotels.controller.ts`, para que `providers/tbo-hotels/src/__fixtures__` (§7.2) nunca sea alcanzable desde el endpoint.                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 7. Estrategia de tests

### 7.1 Dónde viven

| Qué                                                          | Dónde                                                                                     | Por qué                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builders, mappers, envelope, cliente HTTP, config, redacción | `providers/tbo-hotels/src/*.test.ts` (colocalizados)                                      | Como Sabre. Corren en `pnpm --filter @sales-travel/tbo-hotels test` y en CI por turbo (`ci.yml:134-135`). La cobertura de `apps/api` no mide el ACL (`apps/api/vitest.config.ts:27`). |
| Factory, humanizador, filtro                                 | `apps/api/src/providers-tbo/*.test.ts`                                                    | Dependen de Nest y de la bóveda.                                                                                                                                                      |
| Registry y servicio de hoteles                               | `apps/api/src/providers/hotel-provider.registry.test.ts`, `apps/api/src/hotels/*.test.ts` | Hoy no existen tests de `HotelsService` ni de `HotelsController` (§8 G19).                                                                                                            |
| Saga de reserva y post-venta                                 | `apps/api/src/orders/*.test.ts` o `apps/api/src/hotels/hotel-booking*.test.ts`            | Junto a los tests de saga existentes.                                                                                                                                                 |
| Aislamiento con Postgres                                     | `*.integration.test.ts` con `app_user`                                                    | Patrón de `apps/api/src/network/tenant-isolation.integration.test.ts:5-18`.                                                                                                           |

### 7.2 Fixtures desde los ejemplos del PDF

- Un archivo por ejemplo, con la página en el nombre: `__fixtures__/pdf/search-single-room.p15.json`,
  `search-no-availability.p18.json`, `prebook-single-room.p23.json`, `book-limit-multiroom.p35.json`,
  `booking-detail.p49.json`, `cancel.p42.json`, `booking-by-date.p64.json`, `city-list.p54.json`,
  `tbo-hotel-code-list.p67.json`, `hotel-details-request.p58.json`, `hotel-details.p59.json`.
- **Ejemplos del PDF que no son JSON válido se normalizan y se declara la corrección en el test**: comillas
  tipográficas (`“All”`, `”Adult”`, `“Voucher”`, p. 12, 34-35, 51), 8.1.4 sin coma y con llave mal cerrada (p. 40),
  `BookingDate` malformado `"2021-07-1317T00:00:00"` (p. 49). Un fixture que conserva un defecto a propósito (p. ej. el
  `BookingDate` malformado) sirve de test de robustez del mapper.
- **Ejemplos de Book con `NewCard` o `SavedCard` (p. 34-40) no se copian al repo**: traen números con forma de PAN
  (`5555555555554444`, p. 38) y `CvvNumber`. D1 los deja fuera del producto; tampoco entran como fixture.
- Bodies de Postman como fixtures de **request** esperada, anotando sus discrepancias con el PDF: `Title: "Dr"` fuera
  de `Mr|Mrs|Ms` (Postman: `HotelBook`; p. 32), `Children: 0` con `ChildrenAges: [0]` (Postman: `Search`; p. 11),
  comentario `//` dentro del JSON (Postman: `BookingDetail`). Ejemplo recortado de lo que el builder de Book produce
  (VERIFICADO-POSTMAN, `HotelBook`, con email y teléfono sustituidos):

```json
{
  "BookingCode": "1345320!TB!3!TB!af78e57f-a8f7-4316-afaa-705e86b507d3",
  "CustomerDetails": [
    {
      "CustomerNames": [
        { "Title": "Mr", "FirstName": "TestGuest", "LastName": "One", "Type": "Adult" }
      ]
    }
  ],
  "ClientReferenceId": "<request key>",
  "BookingReferenceId": "<request key>",
  "TotalFare": 164.65,
  "EmailId": "<email>",
  "PhoneNumber": "<teléfono>",
  "BookingType": "Voucher",
  "PaymentMode": "Limit"
}
```

- Sin disponibilidad es un 200 de transporte con `Status` 201 en el cuerpo y sin `HotelResult` (VERIFICADO-PDF p. 18):
  `{"Status":{"Code":201,"Description":"No Available rooms for given criteria"}}`. Fixture obligatorio: el adapter
  devuelve `[]` y no lanza.
- Cuando haya acceso al entorno de test, las respuestas reales anonimizadas reemplazan a las del PDF como fuente de
  los tests de mapper, igual que `providers/sabre/src/__fixtures__/*.json` (`providers/sabre/src/shop/response.mapper.test.ts:3-5`).

### 7.3 Por la puerta pública del cliente HTTP

Regla de la casa tras las rondas de Sabre: la defensa se prueba por fuera o no se prueba. El guard anti-PAN de Sabre
"entra por la puerta pública (`SabreHttpClient.postJson`, `fetch` espiado) y lee `init.body`"
(`providers/sabre/src/pan-egress.guard.test.ts:40-45`; `docs/sabre/11-plan-implementacion.md` §8.1).

Para TBO, con `fetch` inyectado en el cliente real:

| Test                              | Qué fija                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticación                     | `Authorization: Basic …` en cabecera, nunca en URL; `Content-Type: application/json` en toda llamada (p. 7).                                                                                  |
| Bytes del cable de Book y PreBook | `init.body` no contiene `PaymentInfo` ni ninguna clave de tarjeta; `PaymentMode` es `"Limit"`.                                                                                                |
| Envelope                          | HTTP 200 con `Status.Code` 405 → error tipado con `tboCode: 405` y `status: 200`; 201 → `[]`; 2xx no-JSON → error tipado (espejo de `providers/sabre/src/client.2xx-non-json.guard.test.ts`). |
| Sin reintentos en dinero          | Timeout en `/Book` y en `/Cancel` → exactamente una llamada a `fetch`.                                                                                                                        |
| Timeout por operación             | Book no aborta a los 23 s; Search sí aborta en su techo.                                                                                                                                      |
| Redacción                         | El logger inyectado nunca recibe `Authorization`, ni nombres, email o teléfono de Book/BookingDetail.                                                                                         |

### 7.4 Mutación de defensas

Cada guard lleva la prueba de que distingue las dos ramas; si no, es un guard vacío.

- **Barrido de `PaymentInfo`**: se inyecta una clave de tarjeta (y un valor con forma de PAN) en cada hoja del input
  del builder de Book y de PreBook; la partición `rechazado` / `llega al cable` queda congelada, como la sonda de
  `providers/sabre/src/pan-egress.guard.test.ts:58-63`, `:848`.
- **Lint D1 con las dos mitades**: dispara sobre un `book.request.builder.ts` que escribe `CardNumber` o `CvvNumber`, y no
  dispara sobre un `*.response.mapper.ts` (modelo: `providers/sabre/src/pan-lint-rule.guard.test.ts`).
- **Puerta de credenciales**: borrar la llamada a `missingTboCredentials` tiene que poner rojo el test del factory.
- **Pertenencia antes de llamar a TBO**: un test que quita la lectura de la orden por RLS tiene que fallar.
- **Guard de superficie**: `index.ts` no exporta tipos raw del proveedor (modelo: `providers/sabre/src/index.surface.test.ts`).

### 7.5 Aislamiento cross-tenant

Obligatorio por `CLAUDE.md` ("tests de aislamiento cross-tenant obligatorios en CI").

| Caso                                                                                                                                                         | Molde                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Caché del factory: dos owners con credenciales distintas no comparten instancia; rotar credenciales purga la vieja                                           | `apps/api/src/providers/adapter-cache-isolation.test.ts:11-18`, `:59-62` (contra el factory real). |
| Herencia: la sub-agencia usa la cuenta del consolidador; la cuenta propia gana; la no heredable se salta                                                     | `apps/api/src/provider-credentials/provider-credentials.integration.test.ts`.                      |
| Órdenes de hotel bajo RLS como `app_user`: la agencia B no lee ni cancela la orden de la agencia A **aunque compartan la cuenta TBO heredada**               | `apps/api/src/network/tenant-isolation.integration.test.ts:95-160`.                                |
| Conciliación por fechas: el resultado de `BookingDetailsbasedondate` (toda la cuenta) nunca llega a una agencia sin pasar por el mapeo a sus propias órdenes | Test nuevo.                                                                                        |

Estos tests se saltan sin `PGHOST` y `APP_USER_PASSWORD`; CI los provee (`.github/workflows/ci.yml:69-78`) y turbo los
deja pasar (`turbo.json:25-34`). Un test de integración que se salta en silencio no cuenta: cada suite lleva una
aserción que corre sin base de datos, como la sonda de `apps/api/src/providers-sabre/sabre-byoc-search.integration.test.ts:883-886`.

### 7.6 Registry, servicio y saga

- Proveedor de hoteles anónimo para tests (espejo de `apps/api/src/providers/__fixtures__/stub-provider.factory.ts:29-34`):
  fan-out con degradación parcial, enrutado por `provider.name`, puerta de moneda, ausencia explicada.
- Saga: intent antes de Book; Book que lanza → `pending` + job con `delay` 120 s; verificación por referencia de cliente;
  clave repetida → 409 sin segunda llamada a TBO; `479` en Cancel → `{ success: false }` sin lanzar y relectura que
  decide; respuesta de Cancel que no pasa el schema → `UNVERIFIED`, nunca `FAILED` (§5.5 punto 5).

---

## 8. Gaps preexistentes de la vertical que TBO destapa

Estos defectos **no son de TBO**: existen hoy con Despegar. Se listan aparte para decidir si se corrigen en el mismo
trabajo o después. La columna "¿TBO lo necesita resuelto?" dice si la integración TBO puede ignorarlo.

| #   | Gap                                                                                                                    | Evidencia                                                                                                                             | Impacto con TBO                                                                                                                              | ¿TBO lo necesita resuelto?                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| G1  | Las reservas de hotel no se persisten                                                                                  | `hotels.service.ts:175-178`; `hotels.module.ts:9` no importa `OrdersModule`                                                           | Sin fila no hay recuperación a los 120 s (p. 42) ni post-venta                                                                               | **Sí** (línea base)                                                                                                  |
| G2  | Sin `domain_events` ni audit en reserva y cancelación                                                                  | `hotels.service.ts:165-196`; contraste `cars.service.ts:229`                                                                          | Viola el principio 8 de `CLAUDE.md` para operaciones con dinero                                                                              | **Sí**                                                                                                               |
| G3  | La UI solo busca y pinta el neto                                                                                       | `apps/web-b2b/src/app/(app)/hoteles/actions.ts:101`, `:174`; espejo sin `pricing` `:57-63`; `hotel-result-card.tsx:12`, `:62`, `:118` | La sub-agencia ve el neto del proveedor; no hay pantalla donde mostrar suplementos `AtProperty` (KP-4, p. 71)                                | Precio de venta: recomendado. Pantallas de reserva: sí para vender por UI y certificar ([07](./07-certificacion.md)) |
| G4  | `provider_catalog` con capacidades de Despegar en `false` aunque cancela y consulta; nadie lo lee; Sabre no tiene fila | `db/migrations/0035_multi_flight_provider.sql:119-120`; grep sin lectores                                                             | La fila de TBO sería declarativa                                                                                                             | No                                                                                                                   |
| G5  | Fallback a env con credencial vacía; `isConfigured` muerto                                                             | `despegar-hotels.factory.ts:62`, `:78`; `providers/despegar-hotels/src/config.ts:26-28`                                               | Ninguno si TBO nace con puerta                                                                                                               | No                                                                                                                   |
| G6  | El filtro loguea 250 caracteres del cuerpo; el mensaje del error lleva 300                                             | `despegar-hotels-exception.filter.ts:22`; `providers/despegar-hotels/src/http/despegar-http.client.ts:9`                              | PII de huéspedes en logs                                                                                                                     | No (el filtro de TBO nace sin eso)                                                                                   |
| G7  | `reservations/:id` sin validar ni verificar pertenencia                                                                | `hotels.controller.ts:113-130`                                                                                                        | Con cuenta heredada, una agencia podría leer o cancelar reservas de otra (INFERIDO)                                                          | **Sí**                                                                                                               |
| G8  | Breaker solo en búsqueda; detalle y sugerencias sin cuota                                                              | `hotels.service.ts:105`; `:68-71`, `:143-161`                                                                                         | `PROVIDERS_DISABLED` no apagaría la reserva                                                                                                  | **Sí** para TBO                                                                                                      |
| G9  | `hotels.schemas.ts` importa `zod` directo                                                                              | `hotels.schemas.ts:1` vs `apps/api/src/provider-credentials/dto.ts:1`                                                                 | Convención                                                                                                                                   | No                                                                                                                   |
| G10 | `tenantDefaults` solo hace `trim()` de la moneda                                                                       | `hotels.service.ts:210`; contraste `search.controller.ts:50-54`                                                                       | TBO ignora la moneda del request (p. 13)                                                                                                     | No                                                                                                                   |
| G11 | `ActiveTenantService` inyectado sin uso                                                                                | `hotels.service.ts:32`                                                                                                                | Ninguno                                                                                                                                      | No                                                                                                                   |
| G12 | Circuito único por código para todos los tenants; cuenta cualquier excepción como fallo                                | `circuit-breaker.service.ts:31`, `:90-91`                                                                                             | Con BYOC, cinco `401 UNAUTHORIZED` de una agencia abren el circuito de TBO para todas durante 30 s (`:6`) (INFERIDO). Afecta también a Sabre | Recomendado                                                                                                          |
| G13 | `PROVIDERS_DISABLED` y `FLIGHT_PROVIDERS_OPT_IN` no llegan al contenedor                                               | `docker-compose.prod.yml:91-138` sin esas variables ni `env_file`; `deploy.yml:129` escribe la segunda en `.env`                      | El kill-switch de TBO no existe en producción                                                                                                | Recomendado                                                                                                          |
| G14 | `despegar-hotels` no tiene formulario BYOC aunque su error manda al usuario a esa pantalla                             | `apps/web-b2b/src/lib/provider-forms.ts:308-312`; `apps/api/src/hotels/despegar-hotels-errors.ts:41`                                  | Ninguno para TBO                                                                                                                             | No                                                                                                                   |
| G15 | `verticalMap` de reportes desactualizado                                                                               | `reports.service.ts:48-53`, `:62`                                                                                                     | Ventas de hotel reportadas como "Vuelos"                                                                                                     | Recomendado                                                                                                          |
| G16 | La regla D1 no cubre el builder de Book de Despegar por su nombre                                                      | `providers/despegar-hotels/src/booking/book.builder.ts` vs `eslint.config.mjs:51`                                                     | Ninguno para TBO si se nombra `book.request.builder.ts`                                                                                      | No                                                                                                                   |
| G17 | Comentario de CI desactualizado: dice que Sabre "TODAVÍA no es dependencia de `apps/api`"                              | `.github/workflows/ci.yml:99-100` vs `apps/api/package.json:25`                                                                       | Ninguno                                                                                                                                      | No                                                                                                                   |
| G18 | Timeout de 15 s contra un `book` que puede esperar hasta 45 s                                                          | `despegar-http.client.ts:80` vs `providers/despegar-hotels/src/booking/types.ts:153-154`                                              | Mismo riesgo de reserva huérfana que TBO evita con timeouts por operación                                                                    | No                                                                                                                   |
| G19 | Sin tests de `HotelsService`, `HotelsController`, `hotels.schemas.ts` ni del filtro                                    | Listado de `apps/api/src/hotels/`                                                                                                     | La generalización no tiene red de seguridad                                                                                                  | **Sí** (se escriben antes de refactorizar)                                                                           |
| G20 | `Money.fromMajor` asume 2 decimales                                                                                    | `packages/canonical/src/money.ts:41-48`                                                                                               | Solo si TBO opera en monedas de 0 o 3 decimales                                                                                              | No                                                                                                                   |
| G21 | El texto de ayuda de la UI dice que el catálogo se sincroniza al configurar credenciales                               | `apps/web-b2b/src/app/(app)/hoteles/page.tsx:122-124` vs cron `.github/workflows/sync-hotel-inventory.yml:4-6`                        | Expectativa falsa con TBO                                                                                                                    | Recomendado                                                                                                          |

---

## 9. Contradicciones y huecos que condicionan los seams

| #   | Hueco                                                                                                                                                                                                                                                                                                                                                               | Postura de diseño (defensiva)                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | El PDF dice "All APIs should be secured with HTTPS protocol", pero el Test BaseURL es `http://api.tbotechnology.in/TBOHolidays_HotelAPI` (VERIFICADO-PDF p. 7; VERIFICADO-CERT; VERIFICADO-POSTMAN en las 10 requests). Basic Auth por HTTP viaja en claro.                                                                                                         | `TboHotelsConfigSchema` rechaza `http:` salvo para el host de test exacto; el panel lo advierte. `isAbsoluteHttpUrl` del panel acepta `http:` (`apps/web-b2b/src/lib/provider-forms.ts:362-369`), así que la barrera es el Zod del ACL. → [Q-03](./10-preguntas-para-tbo.md#q-03): ¿el host de test acepta `https://`?                                  |
| H2  | Live BaseURL es `{Live-URL}/HotelAPI` (p. 7): el host no se publica y el path difiere del de test.                                                                                                                                                                                                                                                                  | Sin constante live. `TBO_BASE_URLS` solo tiene `test`. Decidir si `baseUrl` es obligatorio en la cuenta (hoy `FieldOrigin` no permite "obligatorio solo en config", `apps/api/src/provider-credentials/provider-specs.ts:17-24`). → [Q-04](./10-preguntas-para-tbo.md#q-04): URL live exacta.                                                           |
| H3  | `Status.Code` va en el cuerpo; el PDF no dice qué código HTTP lo acompaña (p. 8-10).                                                                                                                                                                                                                                                                                | El envelope decide por `Status.Code`; el HTTP solo por transporte. No-2xx sin cuerpo → error de transporte. → [Q-07](./10-preguntas-para-tbo.md#q-07).                                                                                                                                                                                                  |
| H4  | Book tiene timeout recomendado de 120 s (p. 8). La llamada del navegador pasa por el proxy público antes de la server action de `web-b2b`, que llama al API por red interna (`apps/web-b2b/src/lib/api.ts:3`; `docker-compose.prod.yml:153`). Si el dominio está detrás del proxy de Cloudflare, su límite de respuesta es de 100 s (INFERIDO; no está en el repo). | El Book no bloquea la petición del navegador hasta el final: el endpoint crea el intent, dispara el Book y responde con la orden en `pending`; la UI consulta el estado. Encaja con §5.5.                                                                                                                                                               |
| H5  | La moneda la fija el perfil de la cuenta TBO, no el request (p. 13, 20). `HotelsService` envía `currency` (`hotels.service.ts:109`), que TBO no tiene dónde recibir.                                                                                                                                                                                                | Puerta de moneda en el fan-out, como vuelos (`search.service.ts:284-287`): una oferta en moneda distinta de la moneda de venta de la búsqueda se descarta con motivo y nunca se convierte (D-TBO-15 A; [08](./08-requisitos-maestro.md) RF-13). → [Q-88](./10-preguntas-para-tbo.md#q-88): ¿una cuenta puede tener varias monedas o elegir COP/PEN/BRL? |
| H6  | TBO no busca por ciudad: Search es solo por `HotelCodes` (p. 10; el "Hotel Search Workflow" figura como depreciado en el changelog, p. 6). El destino de hoy es el geo id de Despegar (`destination-combobox.tsx:94`; `providers/despegar-hotels/src/suggestions/response.mapper.ts:26-28`) y no hay mapeo de ciudades entre proveedores.                           | Sin mapeo, TBO solo se consulta cuando el destino se resuelve a `CityCode` de TBO. Opciones en [05](./05-contenido-estatico-e-inventario.md); ver también [Q-02](./10-preguntas-para-tbo.md#q-02).                                                                                                                                                      |
| H7  | La respuesta de Search no trae nombre, dirección ni estrellas (p. 13-15).                                                                                                                                                                                                                                                                                           | Enriquecer en `HotelsService` con `hotel_inventory` por `(provider_code, hotel_id)`; el ACL no toca la base de datos.                                                                                                                                                                                                                                   |
| H8  | No se dice si el contenido estático es el mismo para todas las cuentas (p. 51-69).                                                                                                                                                                                                                                                                                  | El sync usa la cuenta de plataforma, como Despegar (`tools/sync-hotel-inventory/src/index.ts:138-143`). → [Q-60](./10-preguntas-para-tbo.md#q-60): ¿una cuenta BYOC puede ver hoteles o ciudades que la cuenta de plataforma no ve?                                                                                                                     |
| H9  | QPS no publicado (p. 9).                                                                                                                                                                                                                                                                                                                                            | El sync limita concurrencia y aplica backoff ante `429`; la búsqueda respeta el límite de lote de 100 `HotelCodes` (p. 10). → [Q-10](./10-preguntas-para-tbo.md#q-10): QPS por cuenta y por método, en particular para `CityList` y `TBOHotelCodeList`.                                                                                                 |
| H10 | TBO no documenta costo por búsqueda ni ratio búsqueda/reserva.                                                                                                                                                                                                                                                                                                      | `defaultCallPolicy: 'always'` solo si no hay costo por búsqueda; si lo hay, `opt-in` o `fallback`. Sabre documenta el mismo dilema y hoy queda en `always` aunque su comentario pide `opt-in` hasta conocer el fee (`apps/api/src/providers-sabre/sabre.factory.ts:383-395`): no repetir esa divergencia. → [Q-87](./10-preguntas-para-tbo.md#q-87).    |

---

## 10. Decisiones que este documento asume o deja abiertas

Cada una se presenta con opciones en [08-requisitos-maestro.md](./08-requisitos-maestro.md). Aquí solo se dice qué
touchpoints mueve cada opción. Cinco filas quedaron cerradas por el founder el 2026-09-25 con la línea base (D-TBO-03,
D-TBO-06 y D-TBO-07; [Registro de decisiones](./08-requisitos-maestro.md#registro-de-decisiones)) y lo dicen; el
resto se construye con la línea base mientras el founder no diga otra cosa.

| Decisión                                                    | Línea base                                                                                         | Qué cambia con la alternativa                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generalizar la vertical o módulo TBO paralelo               | Generalizar (D-TBO-06 A, cerrada)                                                                  | Alternativa B: desaparecen TP-09, TP-10, TP-12, TP-15, TP-16; aparece un controlador y una UI paralelos (§5.7).                                                                         |
| Registry espejo o `ProviderRegistry<T>` genérico            | Espejo (D-TBO-06 A, cerrada)                                                                       | Genérico: toca `apps/api/src/providers/flight-provider.registry.ts` y `src/search/**`.                                                                                                  |
| Dónde vive el contrato neutral                              | `packages/canonical/src/hotel-offer.ts` (D-TBO-06 A, cerrada)                                      | En `apps/api`: el mapeo se duplica en wrappers (§5.3).                                                                                                                                  |
| BYOC puro o fallback de plataforma para TBO                 | BYOC puro (D-TBO-03 A, cerrada)                                                                    | Fallback: `envConfig()`, `PLATFORM_DEFAULT_HOTEL_PROVIDERS`, TP-50 y TP-51 para el API, `fallsBackToPlatformCredentials: true`.                                                         |
| Reserva como orden con intent antes del Book                | Sí (D-TBO-07 A, cerrada)                                                                           | No persistir o persistir después: se quitan TP-32 a TP-39 y TP-65, y no se puede cumplir p. 42.                                                                                         |
| Book síncrono o asíncrono para el navegador                 | Asíncrono (orden `pending` + consulta)                                                             | Síncrono: riesgo H4.                                                                                                                                                                    |
| Destino multi-proveedor                                     | Tabla de mapeo calculada (D-TBO-10 A, se aplica; [05](./05-contenido-estatico-e-inventario.md) §8) | Define TP-45 y TP-58.                                                                                                                                                                   |
| Sync TBO: tool hermano o `sync-hotel-inventory` con fuentes | Tool hermano (D-TBO-12 A, se aplica)                                                               | Tool hermano suma TP-49; generalizar cambia el contrato de env del job de Despegar.                                                                                                     |
| Circuito por código o por cuenta                            | Por cuenta (D-TBO-32 A, se aplica; §8 G12)                                                         | Por cuenta: cambia `circuit-breaker.service.ts` y afecta a vuelos (PR-0.6 de [09](./09-plan-implementacion.md)). Por código, como hoy: una cuenta BYOC mala apaga TBO para toda la red. |
| `types` del paquete a `dist` o a `src`                      | `dist` (Sabre)                                                                                     | `src`: riesgo de `dist` rancio en tests de `apps/api`.                                                                                                                                  |
| Cuándo corregir los gaps de §8 que TBO no necesita          | Aparte                                                                                             | En el mismo trabajo: más alcance, menos deuda.                                                                                                                                          |

## Preguntas abiertas para TBO que salen de este documento

Todas se consolidan en [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md).

1. ¿El host de test acepta `https://`? (p. 7) → [Q-03](./10-preguntas-para-tbo.md#q-03)
2. URL live exacta y si su path es `HotelAPI` (p. 7) → [Q-04](./10-preguntas-para-tbo.md#q-04)
3. Código HTTP que acompaña a cada `Status.Code` distinto de 200 (p. 8-10) → [Q-07](./10-preguntas-para-tbo.md#q-07)
4. QPS por cuenta y por método, incluidos los estáticos (p. 9) → [Q-10](./10-preguntas-para-tbo.md#q-10)
5. Formato, longitud, caracteres y unicidad de `BookingReferenceId` y `ClientReferenceId`; comportamiento ante un
   `BookingReferenceId` repetido (p. 33) → [Q-34](./10-preguntas-para-tbo.md#q-34), [Q-35](./10-preguntas-para-tbo.md#q-35)
6. `Status.Code` de `BookingDetail` cuando el `BookingReferenceId` no existe (p. 42-44) → [Q-37](./10-preguntas-para-tbo.md#q-37)
7. ¿`479 CANCEL_FAIL` es definitivo o puede significar "en curso"? (p. 9, 70-71) → [Q-50](./10-preguntas-para-tbo.md#q-50)
8. Timeout recomendado para `BookingDetail` y `Cancel` (p. 8) → [Q-09](./10-preguntas-para-tbo.md#q-09)
9. ¿Una cuenta puede operar en varias monedas o elegir la moneda del perfil? (p. 13) → [Q-88](./10-preguntas-para-tbo.md#q-88)
10. ¿El contenido estático depende de la cuenta? (p. 51-69) → [Q-60](./10-preguntas-para-tbo.md#q-60)
11. ¿Hay costo por búsqueda o ratio búsqueda/reserva? (no documentado) → [Q-87](./10-preguntas-para-tbo.md#q-87)

## Riesgos

1. **Copiar Despegar al pie de la letra** trae el timeout de 15 s, el log del cuerpo con PII y el fallback con
   credencial vacía; ninguno lo detecta un test existente.
2. **El lint D1 da verde sobre un builder de TBO que escriba `CardNumber`** hasta que se extienda la regex (TP-07).
3. **Un `TboApiError` con el `Status.Code` en `status`** convierte cancelaciones ambiguas en fallos definitivos sin
   conciliar (`cancel-retry-policy.ts:73-74`).
4. **Con cuenta TBO heredada, la pertenencia de una reserva solo la garantiza nuestra base de datos**: cualquier ruta
   que llame a `BookingDetail` o `Cancel` con un id del cliente sin pasar por `orders` es una fuga entre agencias
   hermanas.
5. **La generalización sin tests previos de `HotelsService`** (G19) refactoriza el único proveedor de hoteles en
   producción a ciegas.
