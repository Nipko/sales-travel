---
titulo: "Seams de integración en el repo para un segundo proveedor de vuelos (Sabre)"
fecha: 2026-08-25
estado: revisado (3ª pasada — citas de spec y de colección re-verificadas una por una)
Fuentes: ver 00-fuentes.md
---

# Seams de integración: qué hay que tocar para que entre un segundo proveedor de vuelos

Este documento **no analiza Sabre**. Analiza **nuestro repo** para responder una sola pregunta:
_¿qué exactamente hay que cambiar para que `providers/sabre/` conviva con `providers/latam-ndc/`
en la vertical de vuelos?_

Todo lo afirmado sobre el repo está **verificado leyendo el archivo** y va con `ruta:línea`
(rutas relativas a la raíz del repo, `C:/Users/USER/Desktop/Projects/sales-travel/`).
Lo que se dice de Sabre va marcado según la convención de `00-fuentes.md` §4:
**VERIFICADO** (body/script real de la colección), **VERIFICADO-SPEC** (contrato OpenAPI oficial,
con archivo + línea del `.yml`), **[INFERIDO]** o **DESCONOCIDO**.

**Resumen ejecutivo en una frase:** el fan-out y el circuit breaker ya están construidos para N
proveedores, pero **todo lo que los rodea asume exactamente uno**: el factory devuelve un tipo
concreto, la telemetría escribe una fila por búsqueda (no por proveedor), la clave de caché no
incluye el set de proveedores, `simulated` es un booleano global, la cuota horaria se rompe al
duplicar filas, y `orders` tiene `'latam-ndc'` como default de columna. El trabajo real de la
integración Sabre está **en estos seams, no en el ACL**.

### Qué cambió en la 2ª pasada

| Cambio | Dónde |
| --- | --- |
| Se corrigió el front-matter: la primera pasada citaba `EXTERNAL_AGENCY.postman_collection.json`, que es la colección de **LATAM NDC**, no la de Sabre | front-matter |
| Se añadieron los tres módulos que la primera pasada omitió: `apps/api/src/packages/`, `apps/api/src/quotations/`, `apps/api/src/crm/` | §1.3, §1.4, §1.7 |
| Se encontró y verificó el `VARCHAR(200)` que rompe el transporte de ids crudos de Sabre, y se calculó el presupuesto real de caracteres contra el contrato | §1.4 (ítem 45), §4.2, §5.4 |
| El largo y la vida de los ids de Sabre pasaron de DESCONOCIDO a **VERIFICADO-SPEC** (`maxLength: 49`, `maxItems: 9`, `pattern` de 52 chars, `ttl: 1200`) | §5.2, §5.4 |
| Sección nueva sobre el **carril SOAP/LLS stateful** (243 de 1.077 requests) y por qué la documentación oficial nos permite **no** construir un pool de sesiones | §8 |
| Sección nueva sobre el encaje con `docs/discovery/07-roadmap-olas.md`, que **ningún** documento de la primera pasada leyó | §9 |
| Se corrigió la derivación de `SABRE_CLIENT_SECRET`: **el PCC va dentro del secreto**, no al lado | §6.1, §6.2 |
| **Todo el inventario de acoplamiento a LATAM (ítems 1-44) se mantiene intacto**: la crítica lo verificó como exacto | §1.1-§1.6 |

### Qué cambió en la 3ª pasada

Esta pasada no añadió secciones: **re-verificó una por una** todas las citas de la 2ª y corrigió
las que no resistieron. Resultado: 6 correcciones, ninguna que invalide una conclusión.

| Cambio | Dónde |
| --- | --- |
| **`Conversation-ID`: la afirmación "aparece en todos los requests" era FALSA.** Va en 334 de 1.077 (31%); conviven tres literales distintos. Corregido con el conteo exacto | §3.6, §6.2, §8.2, Preguntas cerradas |
| Refutación explícita de la premisa de que el carril SOAP **obliga** a un pool de sesiones: cierto para ese carril, falso para nuestro alcance | §8.3 |
| Se anotó que las 8 páginas del argumento stateless **no comparten redacción literal** (sí contenido normativo); antes se citaban como una sola frase | §8.3 |
| Citas corregidas por desfase de línea: `offer-price-ndc-v1.yml:213-215` → `:214-216`; `:200` → `:198-200` | §5.2 |
| Se añadió `Passenger.id pattern: ^(\S+)$` (`:218`) como evidencia adicional en la contradicción de `travelers[].id` | §5.2 |
| **Re-verificado y CONFIRMADO** (sin cambios): los 15 ports, los 3 `providers/`, las citas de `07-roadmap-olas.md`, los ítems 45-49, el `VARCHAR(200)`, los largos del spec (49 / 9 / 52 / 16), el `ttl: 1200`, las 4 respuestas de **16.479 bytes** de cuerpo y su id más largo de **57 caracteres** | todo el doc |

---

## 0. Mapa rápido: qué ya sirve y qué no

| Pieza | Archivo | ¿Multi-proveedor hoy? | Veredicto |
| --- | --- | --- | --- |
| Fan-out paralelo con degradación parcial | `apps/api/src/search/provider-fanout.ts:27` | Sí (genérico `ProviderRun[]`) | **Sirve tal cual** |
| Dedupe de ofertas equivalentes | `apps/api/src/search/provider-fanout.ts:59` | Sí, pero **nunca se llama** | Código muerto que se activa con Sabre |
| Circuit breaker por código | `apps/api/src/search/circuit-breaker.service.ts:31` | Sí (`Map<providerCode, Circuit>`) | **Sirve tal cual** |
| Kill-switch `PROVIDERS_DISABLED` | `apps/api/src/search/circuit-breaker.service.ts:33-41` | Sí (lista CSV por code) | **Sirve tal cual** |
| BYOC con herencia consolidador→agencia | `db/migrations/0012_provider_accounts.sql:59` | Sí (`provider_code` es TEXT libre) | **Sirve tal cual** |
| Cifrado de credenciales | `apps/api/src/provider-credentials/credentials-cipher.ts` | Sí (agnóstico) | **Sirve tal cual** |
| Telemetría `search_logs` | `db/migrations/0032_search_logs.sql:18` | Columna sí; **el uso no** | Hay que cambiar el uso + la cuota |
| Caché de búsqueda | `apps/api/src/search/memory-cache.adapter.ts` | Adaptador sí; **la clave no** | Hay que cambiar la clave |
| `SearchService` | `apps/api/src/search/search.service.ts:13` | **No** | Reescritura del método |
| Factory por tenant | `apps/api/src/providers-latam/latam-ndc.factory.ts:22` | **No** (devuelve clase concreta) | Nuevo registry |
| Filtro de excepciones | `apps/api/src/providers-latam/latam-ndc-exception.filter.ts:17` | **No** (`@Catch(LatamApiError)`) | Filtro espejo para Sabre |
| `orders.provider` | `db/migrations/0005_orders.sql:9` | Columna sí; **default `'latam-ndc'`** | Quitar el default |
| Operaciones post-venta | `apps/api/src/orders/orders.controller.ts:141` | **No** (`assertSupportsLatamOps`) | Capability map por proveedor |
| UI de credenciales | `apps/web-b2b/src/app/(app)/red/page.tsx:111` | Sí (mapa `PROVIDERS`) | Agregar una entrada |
| UI de resultados | `apps/web-b2b/src/app/(app)/cotizaciones/actions.ts:65` | **No** (`simulated?: boolean`) | Por-proveedor |
| Cotizaciones simples | `apps/api/src/quotations/dto.ts:14` | Sí (`selectedOffer` es JSONB opaco) | **Sirve tal cual** — ver §1.7 |
| CRM (oportunidades / tareas) | `apps/api/src/crm/crm.schemas.ts` | Sí (no toca proveedor) | **Sirve tal cual** — ver §1.7 |
| **Package Studio** | `db/migrations/0010_sprint1_core_suite.sql:99` | **No** (`provider_item_id VARCHAR(200)`) | **Bloquea el transporte de ids Sabre** — ver §1.7 y §5.4 |

---

## 1. Inventario de acoplamiento a LATAM

Este es **el trabajo real**. Ordenado por criticidad.

### 1.1 Núcleo de búsqueda — bloqueante

| # | Archivo:línea | Qué está acoplado | Por qué duele con Sabre |
| --- | --- | --- | --- |
| 1 | `apps/api/src/search/search.service.ts:13` | `const FLIGHTS_PROVIDER = 'latam-ndc'` | Constante única de vertical. Es el ancla de todo el resto. |
| 2 | `apps/api/src/search/search.service.ts:5,27` | `import { LatamNdcProviderFactory }` + `private readonly latam: LatamNdcProviderFactory` | DI a una clase **concreta**, no a un port ni a un registry. |
| 3 | `apps/api/src/search/search.service.ts:70` | `const adapter = await this.latam.forTenant(tenantId)` | Un solo adapter resuelto antes del fan-out. |
| 4 | `apps/api/src/search/search.service.ts:75-83` | Arreglo literal de **una** entrada pasado a `fanOut` | El comentario en `:72-74` ya lo admite: _"hoy hay un solo proveedor"_. |
| 5 | `apps/api/src/search/search.service.ts:81` | `this.breaker.execute(FLIGHTS_PROVIDER, …)` | Correcto por diseño (el breaker es por code), pero el code viene de la constante. |
| 6 | `apps/api/src/search/search.service.ts:43,94,98` | `simulated: boolean` global, derivado de `adapter.isMock` | **Con dos proveedores es semánticamente falso.** Ver §2.4. |
| 7 | `apps/api/src/search/search.service.ts:19-22` | `flightsCacheKey(tenantId, criteria)` — hashea **sólo** el criterio | Dos búsquedas idénticas con distinto set de proveedores efectivo colisionan. Ver §2.3. |
| 8 | `apps/api/src/search/search.service.ts:55-68` | `telemetry.instrument({ providerCode: FLIGHTS_PROVIDER })` envuelve **todo el fan-out** | Una sola fila en `search_logs` para N proveedores → se pierde la latencia por proveedor, que es exactamente para lo que se creó la tabla (`db/migrations/0032_search_logs.sql:4-7`). |
| 9 | `apps/api/src/search/search.service.ts:114` | `priceOffer` llama a `this.latam.forTenant(tenantId)` **ignorando `offer.provider.name`** | Una oferta de Sabre se re-cotizaría contra LATAM. **Es un bug latente el día 1 de Sabre.** |
| 10 | `apps/api/src/search/search.module.ts:2,11` | `imports: [LatamNdcProviderModule, …]` | Registro DI del único proveedor. |
| 11 | `apps/api/src/search/search.controller.ts:14,21` | `@UseFilters(LatamNdcExceptionFilter)` | Sólo traduce `LatamApiError`. |
| 12 | `apps/api/src/search/search.controller.ts:34` | Firma de respuesta `Promise<{ offers: Offer[]; simulated: boolean }>` | Contrato público del endpoint; cambia con §2.4. |

### 1.2 Factory y errores del proveedor

| # | Archivo:línea | Qué está acoplado |
| --- | --- | --- |
| 13 | `apps/api/src/providers-latam/latam-ndc.factory.ts:5` | `const PROVIDER_CODE = 'latam-ndc'` |
| 14 | `apps/api/src/providers-latam/latam-ndc.factory.ts:22` | `forTenant(): Promise<LatamNdcFlightSearchAdapter>` — **devuelve la clase concreta**, no `FlightSearchPort & OfferPricePort` |
| 15 | `apps/api/src/providers-latam/latam-ndc.factory.ts:54-72` | `toConfig()` mapea llaves específicas (`agencyIata`, `travelAgentId`, `accountCode`) |
| 16 | `apps/api/src/providers-latam/latam-ndc.factory.ts:74-86` | `envConfig()` lee 9 vars `LATAM_*` |
| 17 | `apps/api/src/providers-latam/latam-ndc.factory.ts:30-34` | Fallback silencioso a env cuando el tenant no resuelve cuenta. **Con dos proveedores este fallback se vuelve peligroso** — ver §2.2 y Riesgos. |
| 18 | `apps/api/src/providers-latam/latam-ndc-exception.filter.ts:17` | `@Catch(LatamApiError)` |
| 19 | `apps/api/src/providers-latam/latam-ndc-errors.ts:20-55` | `humanizeLatamError()` — 6 mensajes con la marca "LATAM" incrustada (`:25,:28,:43,:48,:52,:54`) |
| 20 | `apps/api/src/providers-latam/latam-ndc.module.ts:11-12` | Provee/exporta sólo `LatamNdcProviderFactory` |

### 1.3 Órdenes y post-venta

| # | Archivo:línea | Qué está acoplado | Impacto |
| --- | --- | --- | --- |
| 21 | `apps/api/src/orders/orders.service.ts:23,86` | Inyecta `LatamNdcProviderFactory` | — |
| 22 | `apps/api/src/orders/orders.service.ts:138` | `createOrder` → `this.latam.forTenant()` **sin mirar `dto.offer.provider.name`** | Reservar una oferta Sabre la mandaría a LATAM. Bug idéntico al #9. |
| 23 | `apps/api/src/orders/orders.service.ts:162` | `provider: 'latam-ndc'` **hardcodeado en el INSERT** | Toda orden de vuelo quedaría etiquetada LATAM. |
| 24 | `apps/api/src/orders/orders.service.ts:210,319,332,446` | `retrieveFromProvider`, `listServices`, `reshopOrder`, `payOrder` → `this.latam.forTenant()` | — |
| 25 | `apps/api/src/orders/orders.service.ts:229-231` | Enrutamiento por proveedor **con un ternario** (`agent-cars` vs. todo lo demás → LATAM) | Con 3 proveedores el ternario deja de escalar. |
| 26 | `apps/api/src/orders/orders.controller.ts:141-147` | `assertSupportsLatamOps()`: `if (row.provider !== 'latam-ndc') throw` | **Bloquearía retrieve/pay/services/reshop de toda orden Sabre**, aunque Sabre soporte el equivalente. Llamado en `:134, :187, :202, :216`. |
| 27 | `apps/api/src/orders/orders.controller.ts:29` | `@UseFilters(LatamNdcExceptionFilter, AgentCarsExceptionFilter)` | Ya demuestra el patrón de N filtros; falta el de Sabre. |
| 28 | `apps/api/src/orders/orders.module.ts:3,9` | `imports: [LatamNdcProviderModule, AgentCarsProviderModule]` | — |
| 29 | `apps/api/src/reports/reports.service.ts:49` | `verticalMap = { 'latam-ndc': 'Vuelos', … }` y fallback `?? 'Vuelos'` en `:62` | Las ventas Sabre caerían en "Vuelos" **por el fallback**, no por el mapa. Funciona por accidente. |
| **45** | `apps/api/src/packages/packages.service.ts:103-104` | `provider_name: dto.providerName`, `provider_item_id: dto.providerItemId` — el ítem del paquete guarda el par (proveedor, id crudo) **pasado por el cliente** | Es el segundo lugar del repo, además de `Offer.provider`, donde viaja un id crudo de proveedor. Y el que tiene el límite más estrecho: ver ítem 47. |
| **46** | `apps/api/src/packages/packages.controller.ts:98-99` (`serializeItem`) | Devuelve `providerName` / `providerItemId` al cliente sin interpretarlos | Correcto por diseño (opaco), pero significa que el id crudo hace **otro** round-trip por el navegador, igual que en `Offer.provider.offerRef` (§4.3). |

### 1.4 Base de datos

| # | Archivo:línea | Qué está acoplado |
| --- | --- | --- |
| 30 | `db/migrations/0005_orders.sql:9` | `provider TEXT NOT NULL DEFAULT 'latam-ndc'` — **default de columna** |
| 31 | `db/migrations/0005_orders.sql:10` | Comentario `-- PNR / OrderID from LATAM` |
| 32 | `db/migrations/0010_sprint1_core_suite.sql:98` | `package_items.provider_name VARCHAR(50)` con comentario `'latam-ndc', 'hotelbeds', …` |
| 33 | `apps/api/src/validation-dtos.test.ts:105` | Fixture con `providerCode: 'latam-ndc'` |
| **47** | `db/migrations/0010_sprint1_core_suite.sql:99` | `package_items.provider_item_id VARCHAR(200) NOT NULL` — **el límite más estrecho del repo para un id de proveedor**, 55 caracteres por debajo de los 255 de `ProviderRefSchema.offerRef`. **Bloqueante**: ver §5.4 |
| **48** | `apps/api/src/packages/packages.schemas.ts:21` | `providerItemId: z.string().min(1).max(200)` — el mismo techo, replicado en el borde Zod. Rechaza con 400 antes de llegar a Postgres, que al menos evita el `22001` crudo |
| **49** | `db/migrations/0004_quotations.sql:14` | `quotations.selected_offer JSONB NOT NULL` — **sin límite de tamaño ni forma**. Es el contraejemplo: así debería verse `package_items` |

### 1.5 Front-end (web-b2b)

| # | Archivo:línea | Qué está acoplado |
| --- | --- | --- |
| 34 | `apps/web-b2b/src/app/(app)/cotizaciones/actions.ts:57-66` | `SearchResult { simulated?: boolean }` — booleano global |
| 35 | `apps/web-b2b/src/app/(app)/cotizaciones/actions.ts:164,179` | Consume `{ offers, simulated }` del endpoint |
| 36 | `apps/web-b2b/src/app/(app)/cotizaciones/page.tsx:633-646` | Banner "Tarifas simuladas" **para toda la lista** |
| 37 | `apps/web-b2b/src/app/(app)/red/page.tsx:85-98` | `const LATAM_NDC: ProviderForm` (8 campos de credencial + 1 de config) |
| 38 | `apps/web-b2b/src/app/(app)/red/page.tsx:111-114` | `const PROVIDERS = { 'latam-ndc': …, 'agent-cars': … }` |
| 39 | `apps/web-b2b/src/app/(app)/red/page.tsx:600` | `useState('latam-ndc')` como default del selector |
| 40 | `apps/web-b2b/src/app/(app)/red/page.tsx:607` | `PROVIDERS[providerCode] ?? LATAM_NDC` — **fallback a LATAM** para códigos desconocidos |
| 41 | `apps/web-b2b/src/app/(app)/carteras/CarterasClient.tsx:517` | `o.provider === 'latam-ndc' ? 'Vuelos (LATAM NDC)' : o.provider` — Sabre se mostraría como `sabre` crudo |
| 42 | `apps/web-b2b/src/app/(app)/reservas/page.tsx:87-89` | `isCarOrder()` — la única discriminación es coches vs. "todo lo demás" |
| 43 | `apps/web-b2b/src/app/(app)/reservas/page.tsx:908,912` | Botones de pago/emisión gateados por `!isCar` → se ofrecerían para órdenes Sabre y morirían en el 400 del #26 |
| 44 | `apps/web-b2b/src/lib/provider-errors.ts:25-30` | Regex `^latam(?:\s+\w+)*\s+error\b…` y mensaje con "credenciales de LATAM" |

### 1.6 Defectos preexistentes que **hay que arreglar en el mismo trabajo**

Encontrados leyendo el código; no dependen de Sabre pero se agravan con él.

**A. Un apagón total de proveedor devuelve 500 genérico, no 502 humanizado.**
`search.service.ts:88-90` lanza `new Error(failed.map(...).join('; '))` — un `Error` pelado.
`LatamNdcExceptionFilter` sólo captura `LatamApiError` (`latam-ndc-exception.filter.ts:17`), así que
no dispara; cae en `AllExceptionsFilter`, que para no-`HttpException` responde
`"Ocurrió un error inesperado…"` (`all-exceptions.filter.ts:66-70`). El motivo real queda sólo en el log.
Con dos proveedores esto empeora: el vendedor no puede distinguir "Sabre caído" de "no hay vuelos".

**B. El campo `failed[]` del fan-out se descarta.**
`provider-fanout.ts:13` lo documenta como _"La UI puede decir qué falta"_, pero
`search.service.ts:75` desestructura sólo `{ items, failed }` y usa `failed` únicamente para el
throw de `:88`. Nunca llega al cliente. Con un proveedor era invisible; con dos es
**degradación parcial silenciosa** — exactamente lo que el comentario de `:24-25` dice que no debe pasar.

**C. `dedupeCheapest` es código muerto.** `provider-fanout.ts:59` no tiene un solo llamador
(verificado por grep en `apps/`, `packages/`, `providers/`). Se activa recién con el segundo proveedor.

**D. `invalidatePattern` es código muerto.** `memory-cache.adapter.ts:52` no tiene llamadores.
Consecuencia: tras `POST /provider-accounts` (`provider-credentials.controller.ts:44`) el caché de
búsqueda sigue sirviendo el resultado viejo hasta 90 s. Con Sabre: una agencia carga sus
credenciales Sabre y **sigue viendo sólo LATAM** durante minuto y medio, sin explicación.

**E. `SearchService` inyecta la clase concreta `MemoryCacheAdapter`, no `CachePort`.**
`search.service.ts:9,31`. Viola el principio 7 de `CLAUDE.md` ("nunca importar infra directamente
desde dominio/app; siempre vía port"). Barato de arreglar ahora, caro cuando haya que pasar a Redis.

**F. La cuota horaria se romperá al duplicar filas.** Ver §2.5 — es la consecuencia más sutil
y la más costosa si se descubre en producción.

### 1.7 Los tres módulos que la primera pasada omitió: `packages/`, `quotations/`, `crm/`

Hallazgo de la crítica, **aceptado**. El inventario de arriba se declaraba exhaustivo y saltaba
tres módulos de `apps/api/src/` que tocan ofertas de proveedor. Analizados en esta pasada:

#### `apps/api/src/quotations/` — **agnóstico, no hay nada que hacer**

`quotations.service.ts:51` persiste `selected_offer: JSON.stringify(dto.selectedOffer)` y
`dto.ts:14` lo valida como `jsonObject = z.record(z.unknown())` (`dto.ts:4`, con el comentario
_"se persiste verbatim: passthrough para NO perder claves anidadas"_). La columna es
`JSONB NOT NULL` sin CHECK (`db/migrations/0004_quotations.sql:14`). Una oferta Sabre — con
`provider.name = 'sabre'` y un `raw` nuevo (§5.3) — entra sin una línea de migración.

**Consecuencia sí relevante:** una cotización guarda el snapshot de la oferta, y `expires_at` es
un campo **que fija el vendedor** (`dto.ts:19`, obligatorio), no el proveedor. Con LATAM eso ya era
un desalineamiento; con Sabre es medible: la oferta priced vive **1.200 segundos**
(VERIFICADO-SPEC: `offer-price-ndc-v1.yml:2105`, `"ttl": 1200`, con `offerExpirationDateTime`
20 minutos después del timestamp). Una cotización con `expiresAt` a 7 días contiene ids que
murieron a los 20 minutos. Ver §5.4 y Riesgos.

#### `apps/api/src/crm/` — **agnóstico, no hay nada que hacer**

Verificado por grep: en los 8 archivos de `crm/` la palabra `provider` sólo aparece como la clave
`providers:` del decorador `@Module` (`crm.module.ts:14`). Las oportunidades referencian el
resultado, no el origen: `package_quotation_id` y `order_id`
(`db/migrations/0024_crm_travel_suite.sql:69-70`), ambos UUID con FK. El único campo libre es
`crm_interactions.payload` (`crm.schemas.ts:72`, `z.record(z.unknown())`). Sabre no lo toca.

> Nota de alcance: `crm_opportunities.order_id` apunta a `orders`, y `orders.provider` sí cambia
> (ítem 30). Pero la relación es por UUID, así que el CRM hereda el cambio sin código nuevo.

#### `apps/api/src/packages/` — **aquí sí hay un bloqueante**

Este es el hallazgo real. El Package Studio es lo que `CLAUDE.md` llama _"el corazón del
producto"_, y su modelo de datos es el **más estrecho** del repo para un id de proveedor:

```sql
-- db/migrations/0010_sprint1_core_suite.sql:94-99
CREATE TABLE IF NOT EXISTS package_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    package_id UUID NOT NULL REFERENCES package_quotations(id) ON DELETE CASCADE,
    vertical VARCHAR(20) NOT NULL,
    provider_name VARCHAR(50) NOT NULL,            -- 'latam-ndc', 'hotelbeds', 'assistcard'
    provider_item_id VARCHAR(200) NOT NULL,        -- ← el bloqueante
```

Replicado en el borde Zod: `packages.schemas.ts:21`, `providerItemId: z.string().min(1).max(200)`.

Tres observaciones que ningún documento de la serie había cruzado:

1. **200 < 255.** `ProviderRefSchema.offerRef` admite 255 (`packages/canonical/src/offer.ts:29`),
   pero cualquier oferta que entre a un paquete tiene que caber en 200. El sistema tiene
   **dos techos distintos para el mismo dato**, y el más bajo no está documentado en ningún lado.
2. **Con los números del contrato de Sabre, 200 no alcanza.** El cálculo completo está en §5.4:
   el peor caso admitido por el spec son **526 caracteres**, y hasta el caso *típico* de una
   familia de 9 ítems con los largos de los propios ejemplos de Sabre da **227**. Rompe.
3. **Hoy no lo detecta nadie porque el Package Studio no tiene front-end.** Verificado por grep:
   no hay una sola referencia a `providerItemId` ni a `/packages` en `apps/web-b2b/src/`. Los
   endpoints existen (`packages.controller.ts`) y nadie los llama. Es decir: el bloqueante está
   **latente**, y se activa exactamente cuando se construya el lienzo drag-and-drop — que es el
   entregable central de la Ola 2 según §9. Arreglarlo ahora cuesta un `ALTER TABLE`; arreglarlo
   después cuesta migrar datos de producción.

Corrección concreta en §4.2 (migración) y §5.4 (presupuesto de caracteres).

---

## 2. Refactor propuesto: registry de proveedores por vertical y tenant

### 2.1 Interfaces

Ubicación propuesta: `apps/api/src/providers/` (nuevo directorio, hermano de `providers-latam/`).

```ts
// apps/api/src/providers/provider.types.ts
import type { FlightSearchPort, OfferPricePort, OrderCreatePort, OrderManagePort } from '@sales-travel/domain';

/** Un adapter de vuelos = los cuatro ports + la señal de modo mock. */
export interface FlightProviderAdapter
  extends FlightSearchPort, OfferPricePort, OrderCreatePort, OrderManagePort {
  readonly isMock: boolean;
}

/** Qué sabe hacer un proveedor: gatea la UI de post-venta sin `if (provider === ...)`. */
export interface ProviderCapabilities {
  readonly retrieve: boolean;
  readonly cancel: boolean;
  readonly pay: boolean;        // pago/emisión diferida (BNPL LATAM); Sabre usa fulfill
  readonly services: boolean;   // ancillaries
  readonly reshop: boolean;
}

/** Contrato que hoy cumplen de facto los tres factories, sin declararlo. */
export interface TenantProviderFactory<TAdapter> {
  readonly code: string;                       // 'latam-ndc' | 'sabre'
  readonly vertical: 'flights' | 'hotels' | 'cars';
  readonly capabilities: ProviderCapabilities;
  /** Lanza NotFoundException si el tenant no resuelve credenciales y no hay fallback. */
  forTenant(tenantId: string): Promise<TAdapter>;
}

export interface ResolvedProvider<TAdapter> {
  readonly code: string;
  readonly adapter: TAdapter;
  readonly simulated: boolean;                       // = adapter.isMock
  readonly credentialSource: 'own' | 'inherited' | 'env';
  readonly capabilities: ProviderCapabilities;
}
```

```ts
// apps/api/src/providers/flight-provider.registry.ts
@Injectable()
export class FlightProviderRegistry {
  constructor(
    private readonly creds: ProviderCredentialsService,
    private readonly latam: LatamNdcProviderFactory,
    private readonly sabre: SabreProviderFactory,
  ) {}

  /**
   * Proveedores habilitados para el tenant, en orden ESTABLE (alfabético por code).
   * El orden estable importa: es parte de la clave de caché y del orden de `providers[]`
   * en la respuesta, y un orden inestable produciría cache misses y UI que salta.
   */
  async forTenant(tenantId: string): Promise<ResolvedProvider<FlightProviderAdapter>[]>;

  /** Uno concreto, para offer-price y para todo el flujo de órdenes. Lanza si no está habilitado. */
  async byCode(tenantId: string, code: string): Promise<ResolvedProvider<FlightProviderAdapter>>;

  /** Sólo los codes, sin construir adapters. Para la clave de caché. */
  async codesForTenant(tenantId: string): Promise<string[]>;
}
```

### 2.2 Cómo decide el registry qué proveedores están habilitados

**Este es el punto de diseño más importante y el que hay que decidir explícitamente.**

Hoy `LatamNdcProviderFactory.forTenant()` (`latam-ndc.factory.ts:30-34`) atrapa el
`NotFoundException` de `resolve()` y **cae a credenciales de entorno**. Con un solo proveedor ese
fallback es benigno ("la plataforma presta sus credenciales"). Con dos deja de serlo: un tenant sin
credenciales Sabre **igual saldría a Sabre** con la cuenta global — cobrando consultas a la
plataforma y, peor, mostrando tarifas de un PCC que no es el suyo.

Regla propuesta:

```
proveedor habilitado para el tenant  ⇔
    resolve_provider_account(tenant, code) devuelve fila 'active'      → source 'own' | 'inherited'
  OR (code ∈ PLATFORM_DEFAULT_FLIGHT_PROVIDERS  AND  hay env config)   → source 'env'
```

Con `PLATFORM_DEFAULT_FLIGHT_PROVIDERS` como variable de entorno (CSV), por defecto `latam-ndc`
— es decir, **Sabre NO tiene fallback a env salvo que se lo habilite explícitamente**. Esto
preserva el comportamiento legacy documentado en `latam-ndc.factory.ts:8-12` sin extenderlo.

Nótese que `resolve_provider_account` (`db/migrations/0012_provider_accounts.sql:59-77`) exige
`status = 'active'`, y la UI crea cuentas con `status: 'sandbox'` por defecto
(`provider-credentials.service.ts:97,112` y `red/page.tsx:604`). O sea: **una cuenta cargada desde
la UI no habilita nada hasta que alguien la pasa a `active`**. Vale documentarlo en la UI.

### 2.3 Clave de caché

Estado actual — `search.service.ts:19-22`:

```ts
function flightsCacheKey(tenantId: string, c: FlightSearchCriteria): string {
  const digest = createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 24);
  return `search:flights:${tenantId}:${digest}`;
}
```

Propuesto:

```ts
function flightsCacheKey(tenantId: string, c: FlightSearchCriteria, codes: string[]): string {
  const digest = createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 24);
  // Los codes van EN CLARO (no en el hash) para que invalidatePattern pueda barrer por proveedor:
  //   cache.invalidatePattern(`search:flights:${tenantId}:*`)
  return `search:flights:${tenantId}:${[...codes].sort().join('+')}:${digest}`;
}
```

Reglas de escritura de caché, actualizadas (hoy: `search.service.ts:103-105`, sólo mira `simulated`):

| Condición | ¿Cachear? | Motivo |
| --- | --- | --- |
| Todos OK, ninguno simulado | Sí, 90 s | Igual que hoy |
| Algún proveedor `simulated` | **No** | Motivo actual (`search.service.ts:101-102`), sigue valiendo |
| Algún proveedor en `failed` | **No** (hoy sí se cachea) | Un resultado parcial cacheado 90 s congela la degradación aunque el proveedor ya se haya recuperado |
| Circuito abierto para un code | No aplica: ese code no entra en `codes`, así que la clave ya es distinta | El breaker cambia el set efectivo; incluirlo en la clave evita servir el resultado "sin Sabre" cuando Sabre volvió |

Y conectar el código muerto **D**: llamar
`cache.invalidatePattern('search:*:' + tenantId + ':*')` desde
`provider-credentials.controller.ts:44` (upsert) — requiere exportar `MemoryCacheAdapter` a ese
módulo o, mejor, mover el caché a su propio módulo detrás de `CachePort` (arregla también **E**).

### 2.4 `simulated`: de booleano global a por-proveedor

Contrato actual del endpoint — `search.controller.ts:34`:
`Promise<{ offers: Offer[]; simulated: boolean }>`.

Propuesto:

```ts
export interface ProviderOutcome {
  code: string;                                     // 'latam-ndc' | 'sabre'
  status: 'ok' | 'empty' | 'error' | 'simulated';
  count: number;
  /** Ya humanizado por el filtro del proveedor. Sólo si status === 'error'. */
  reason?: string;
}

export interface FlightSearchResponse {
  offers: Offer[];
  /**
   * COMPAT + SEGURIDAD: true si hay AL MENOS UNA oferta simulada en la lista.
   * Se mantiene el nombre para no romper el cliente (actions.ts:179), pero cambia
   * la semántica de "toda la lista es falsa" a "hay tarifas falsas acá adentro" —
   * que es la lectura segura: un vendedor no debe cotizar NINGUNA de las simuladas.
   */
  simulated: boolean;
  providers: ProviderOutcome[];
}
```

**No hace falta tocar `Offer` para esto.** `Offer.provider.name`
(`packages/canonical/src/offer.ts:27-31`) ya identifica el origen de cada oferta, así que la UI
puede unir `offers[].provider.name` contra `providers[]` y marcar **fila por fila** cuáles son
simuladas, en vez de un banner sobre toda la lista. Cambio en el front:
`cotizaciones/actions.ts:57-66` (tipo) y `cotizaciones/page.tsx:633-646` (banner → badge por oferta).

### 2.5 Telemetría y cuota — el cambio con más riesgo escondido

La instrumentación hoy envuelve **todo el fan-out** (`search.service.ts:55-99`), produciendo
**una fila** en `search_logs`. Hay que moverla **dentro de cada rama** para tener una fila por
proveedor y recuperar el propósito declarado de la tabla
(`db/migrations/0032_search_logs.sql:4-7`: latencia por proveedor, tasa de error por proveedor).

Pero eso rompe la cuota. `assertWithinQuota` (`search-telemetry.service.ts:43-69`) llama a
`count_recent_searches`, que es literalmente `SELECT COUNT(*) FROM search_logs …`
(`db/migrations/0032_search_logs.sql:70-80`). **Con dos proveedores, cada búsqueda escribe 2 filas,
así que una cuota de 600/h se convierte en 300 búsquedas/h sin que nadie lo cambie.** Con tres, 200.

Corrección propuesta (migración nueva, ver §4.2): agregar `search_logs.search_group_id UUID` y
contar grupos distintos:

```sql
CREATE OR REPLACE FUNCTION count_recent_searches(p_tenant_id UUID, p_minutes INTEGER)
RETURNS integer LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  -- COUNT(DISTINCT ...) sobre el grupo: una búsqueda del vendedor = 1, aunque haya
  -- salido a N proveedores. COALESCE cubre las filas viejas, anteriores a la columna.
  SELECT COUNT(DISTINCT COALESCE(search_group_id, id))::int
  FROM search_logs
  WHERE tenant_id = p_tenant_id
    AND outcome <> 'error'
    AND occurred_at > now() - make_interval(mins => p_minutes);
$$;
```

`SearchRecord` (`search-telemetry.service.ts:13-23`) suma `searchGroupId: string`, y
`SearchService` genera un `randomUUID()` por búsqueda y lo pasa a las N ramas.

### 2.6 Dedupe: qué hace equivalentes a dos ofertas de vuelo

`dedupeCheapest` (`provider-fanout.ts:59-71`) delega la clave al llamador, correctamente.
Para vuelos, la clave **no puede ser sólo el itinerario**: LATAM y Sabre pueden vender el mismo
vuelo con familias tarifarias y equipaje distintos, y colapsarlas por precio escondería la opción
que el cliente quería.

Clave propuesta:

```
carrier+flightNumber+departureAt de cada segmento, en orden
  ‖ fareFamily.cabin
  ‖ baggage.checked.qty
  ‖ policies.refundable ‖ policies.changeable
```

Y comparar por el **neto** (`offer.total.amountMinor`), no por `pricing.finalMinor`: hoy la cascada
de markup es por vertical y por tenant (`pricing.service.ts:102` recibe `(tenantId, vertical)`),
nunca por proveedor, así que ambos reciben el mismo markup y el orden por neto = orden por final.
**Si algún día hay reglas de markup por proveedor, este supuesto cae** — dejarlo comentado en el código.

Ubicación: dentro de `SearchService.searchFlights`, **antes** de `withPricing`
(`search.service.ts:93`), para no calcular markup sobre ofertas que se van a descartar.

### 2.7 Diff conceptual, archivo por archivo

| Archivo | Cambio | Tamaño |
| --- | --- | --- |
| `apps/api/src/providers/provider.types.ts` | **Nuevo.** Interfaces de §2.1 | ~60 líneas |
| `apps/api/src/providers/flight-provider.registry.ts` | **Nuevo.** Resolución + orden estable + `byCode` | ~120 líneas |
| `apps/api/src/providers/providers.module.ts` | **Nuevo.** Importa `LatamNdcProviderModule` + `SabreProviderModule`, exporta el registry | ~15 líneas |
| `apps/api/src/providers-latam/latam-ndc.factory.ts` | Declarar `implements TenantProviderFactory<FlightProviderAdapter>`; exponer `code`, `vertical`, `capabilities`; devolver el tipo del port en `:22`; devolver `credentialSource` | Quirúrgico |
| `apps/api/src/providers-sabre/sabre.factory.ts` | **Nuevo.** Espejo exacto del anterior (incluido el caché por `ownerTenantId:updatedAt` de `:29` y el `evictStale` de `:46-52`) | ~110 líneas |
| `apps/api/src/providers-sabre/sabre-errors.ts` | **Nuevo.** Espejo de `latam-ndc-errors.ts` | ~50 líneas |
| `apps/api/src/providers-sabre/sabre-exception.filter.ts` | **Nuevo.** `@Catch(SabreApiError)` → 502 | ~30 líneas |
| `apps/api/src/providers-sabre/sabre.module.ts` | **Nuevo.** Espejo de `latam-ndc.module.ts` | ~15 líneas |
| `apps/api/src/search/search.service.ts` | **Reescritura del cuerpo de `searchFlights`** (L40-107): registry → fan-out N ramas → instrument por rama → dedupe → pricing → caché con codes. Y `priceOffer` (L109-122) enruta por `offer.provider.name` vía `registry.byCode` | El grueso |
| `apps/api/src/search/search.controller.ts` | Nuevo tipo de respuesta (L34); `@UseFilters(LatamNdcExceptionFilter, SabreExceptionFilter)` (L21) | 4 líneas |
| `apps/api/src/search/search.module.ts` | `imports: [ProvidersModule, PricingModule]` | 2 líneas |
| `apps/api/src/search/search-telemetry.service.ts` | `SearchRecord` + `searchGroupId` (L13-23); insertar la columna (L76-86) | 3 líneas |
| `apps/api/src/search/provider-fanout.ts` | Sin cambios de firma. Opcional: que `FanoutResult` exponga también los `succeeded` con su count para armar `ProviderOutcome[]` | Opcional |
| `apps/api/src/orders/orders.service.ts` | Reemplazar `this.latam` por `registry.byCode(tenantId, order.provider)`; `provider:` del INSERT (L162) sale de `dto.offer.provider.name` | Medio |
| `apps/api/src/orders/orders.controller.ts` | `assertSupportsLatamOps` (L141-147) → `assertSupports(row, 'pay' \| 'services' \| …)` consultando `capabilities` | ~20 líneas |
| `apps/api/src/reports/reports.service.ts` | Agregar `'sabre': 'Vuelos'` al mapa (L49) | 1 línea |
| `apps/web-b2b/src/app/(app)/red/page.tsx` | Nuevo `const SABRE: ProviderForm` + entrada en `PROVIDERS` (L111) | ~20 líneas |
| `apps/web-b2b/src/app/(app)/cotizaciones/actions.ts` | Tipo `SearchResult` con `providers[]` (L57-66) | ~10 líneas |
| `apps/web-b2b/src/app/(app)/cotizaciones/page.tsx` | Banner global → badge por oferta + aviso de degradación parcial (L633) | Medio |
| `apps/web-b2b/src/app/(app)/carteras/CarterasClient.tsx` | Mapa de etiquetas en vez del ternario (L517) | 3 líneas |
| `apps/web-b2b/src/lib/provider-errors.ts` | Generalizar el regex de prefijo (L30) | 2 líneas |
| `apps/api/src/packages/packages.schemas.ts` | `providerItemId` de `.max(200)` a `.max(2000)` (L21). **Bloqueante del Package Studio con Sabre** — ver §1.7 y §5.4 | 1 línea |
| `db/migrations/00XX_multi_flight_provider.sql` | Ver §4.2 (incluye el `ALTER TABLE package_items … TYPE TEXT`) | ~55 líneas |
| `apps/api/src/quotations/`, `apps/api/src/crm/` | **Sin cambios.** Verificado en §1.7: `selected_offer` es JSONB opaco y el CRM no toca proveedor | — |

---

## 3. Cómo se registra `providers/sabre/` en el monorepo

El patrón está fijado por `providers/latam-ndc/` y `providers/agent-cars/`; se copia literal.

### 3.1 `pnpm-workspace.yaml` — **sin cambios**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'providers/*'   # ← ya cubre providers/sabre
  - 'tools/*'
```
(`pnpm-workspace.yaml:1-5`, verificado.)

### 3.2 `providers/sabre/package.json`

Copia exacta de `providers/latam-ndc/package.json` con el nombre cambiado. Nótese el detalle
importante: **`types` apunta a `./src/index.ts` y `main` a `./dist/index.js`** — así el typecheck
resuelve por fuente y el runtime por build.

```json
{
  "name": "@sales-travel/sabre",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "clean": "rm -rf dist .turbo *.tsbuildinfo"
  },
  "dependencies": {
    "@sales-travel/canonical": "workspace:*",
    "@sales-travel/domain": "workspace:*"
  },
  "devDependencies": { "typescript": "^5.7.2" }
}
```

Diferencia con LATAM: **no lleva `fast-xml-parser`** (LATAM sí, `providers/latam-ndc/package.json:26`).
Sabre, en el alcance que nos interesa, es JSON puro
(`POST {{rest_endpoint}}/v5/offers/shop`, body `application/json` — Workflows/1, request 1).

**Esto ya no es `[INFERIDO]`.** La documentación oficial lo confirma para cada endpoint del alcance:
_"This API is designed to operate in a stateless way, and accepts both sessionless (ATK) and
session-based (ATH) tokens"_ — VERIFICADO-SPEC en
`specs/help/booking-management-api-v1/help-documentation-create-booking.txt:28`,
`…-get-booking.txt:14`, `…-cancel-booking.txt:11`, `…-modify-booking-0.txt:28`,
`…-fulfill-flight-tickets.txt:16`, `…-void-flight-tickets.txt:11`, `…-refund-flight-tickets.txt:11`
y `specs/help/flight-reshop-api-1.0/help-documentation-sabre-flight-reshop.txt:23`.

Es decir: **shop, price, createBooking, getBooking, cancelBooking, fulfill/void/refund y reshop
funcionan con token stateless (ATK), sin sesión SOAP**. El carril SOAP/LLS existe y pesa 243 de
1.077 requests de la colección, pero no es obligatorio para nuestro alcance. Análisis completo
en **§8**.

### 3.3 `providers/sabre/tsconfig.json`

Copia de `providers/agent-cars/tsconfig.json` — **esa versión, no la de latam-ndc**, porque
incluye el `exclude` de tests que latam-ndc no tiene:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Ojo con el override: `tsconfig.base.json:5-6` declara `module: NodeNext` /
`moduleResolution: NodeNext`, y los tres providers lo pisan a `CommonJS`/`Node`. Por eso los
imports internos de `providers/latam-ndc/src/` van **sin extensión** (`from './config'`,
`latam-flight-search.adapter.ts:24`) mientras que `apps/api/src/` los usa **con `.js`**
(`search.service.ts:5`). Sabre debe seguir la convención de `providers/`, sin extensión.

### 3.4 `turbo.json` — **sin cambios**

`turbo.json` no enumera paquetes; las tareas (`build`, `typecheck`, `lint`, `test`) aplican a todo
workspace que tenga ese script. `build` ya tiene `dependsOn: ["^build"]` y
`outputs: ["dist/**"]` (`turbo.json:9-12`). Si Sabre necesitara variables de entorno **en tests**,
habría que declararlas en `tasks.test.env` (`turbo.json:28-36`) — turbo **filtra el entorno**, como
avisa `ci.yml:110-113`.

### 3.5 `apps/api/package.json`

Una línea, en orden alfabético junto a las otras:

```json
"@sales-travel/sabre": "workspace:*",
```

Después `pnpm install` para materializar el symlink. El paso de CI
`pnpm --filter "@sales-travel/api^..." build` (`ci.yml:92`) ya lo compila sin tocarse, porque toma
las dependencias transitivas de la API.

### 3.6 Estructura interna, calcada de `providers/latam-ndc/src/`

```
providers/sabre/src/
├── index.ts                        # export * from './config'; './sabre-flight.adapter'; export { SabreApiError }
├── config.ts                       # interface SabreConfig + isMockMode(cfg)
├── errors.ts                       # class SabreApiError (status, body, path)
├── fixtures.ts                     # buildMockOffers() para modo mock/CI
├── auth/basic-secret.ts            # DERIVA el Basic: base64(base64("V1:epr:pcc:AA") + ":" + base64(pwd))
│                                   #   VERIFICADO en el script de raíz de la colección. Ver §6.1
├── auth/token.service.ts           # POST /v2/auth/token, grant_type=client_credentials,
│                                   #   Authorization: Basic <derivado>  → token ATK stateless (§8.3)
│                                   #   cache en memoria, igual que LATAM
├── http/sabre-http.client.ts       # JSON + header Conversation-ID (ver §6.2: NO va en todos los requests)
├── shop/request.builder.ts         # OTA_AirLowFareSearchRQ → POST /v5/offers/shop
├── shop/response.mapper.ts         # ramifica por Offer.source: ATPCO | LCC | NDC
│                                   #   (VERIFICADO-SPEC: bargain-finder-max-v5.yml:8238-8240)
│                                   #   y mapea timeToLive → OfferSchema.expiresAt (§4.3)
├── price/request.builder.ts        # { query:[{ offerItemId:[…] }], params:{ formOfPayment:[…] } } → /v1/offers/price
├── price/response.mapper.ts
├── booking/create.request.builder.ts   # { flightOffer:{offerId, selectedOfferItems[]}, travelers[], contactInfo }
├── booking/create.response.mapper.ts   #   → POST /v1/trip/orders/createBooking
├── booking/get.request.builder.ts      # { confirmationId } → /v1/trip/orders/getBooking
└── booking/cancel.request.builder.ts   # { confirmationId, retrieveBooking, cancelAll } → /v1/trip/orders/cancelBooking
```

Los cuatro bodies citados son **VERIFICADOS**, del slice
`WF-01-1_Air_NDC_Shop_Price_Check_Book_Cancel.txt`.

**Corrección respecto a la primera pasada.** El documento decía que _"los mappers de respuesta no
se pueden escribir todavía: la colección no trae respuestas guardadas para ninguno de ellos"_. La
primera parte ya no es cierta y la segunda era imprecisa:

- La colección **sí trae 4 respuestas guardadas con cuerpo**, de 16.479 bytes cada una, todas de
  `/v1/orders/view` en el folder `ModifyBooking` (`00-fuentes.md` §1). No están vacías. Son la
  única evidencia dura de forma de respuesta que salió de la colección, y de ellas se lee la
  estructura real de una orden: `order.id` (32 hex), `order.pnrLocator` (6 chars, p. ej. `TOSGCZ`),
  `order.orderOwner` (`"1S"`), `orderItems[].id` / `.externalId` / `.externalOrderRefId` (UUID).
  El id más largo observado mide **57 caracteres**, consistente con los techos del spec (§5.2).

  > **Nota de procedencia (3ª pasada).** Los cuatro archivos de `slices/responses/` pesan en disco
  > 16.636 / 16.639 / 16.639 / 16.659 bytes, **no** 16.479. La diferencia es la línea de comentario
  > `//` que el extractor antepone con la ruta del request. Descontada, **los cuatro cuerpos miden
  > exactamente 16.479 bytes** y los cuatro parsean como JSON válido. Se anota para que nadie
  > vuelva a leer esa discrepancia como un error del conteo canónico: el número de `00-fuentes.md`
  > es el del cuerpo, y es correcto.
- Y sobre todo: **ahora tenemos los contratos oficiales**. `bargain-finder-max-v5.yml` trae 3
  ejemplos completos de respuesta de shop y `offer-price-ndc-v1.yml` varios de price. Los mappers
  **se pueden escribir**; lo que falta validar contra el sandbox está acotado a las Preguntas
  abiertas.

---

## 4. Modelo de datos: qué falta en `db/`

### 4.1 Lo que ya sirve sin tocar

**`provider_accounts` sirve tal cual para Sabre.** Verificado en
`db/migrations/0012_provider_accounts.sql`:

- `provider_code TEXT` sin CHECK ni FK (`:10`) → acepta `'sabre'` sin migración.
- `config JSONB` (`:13`) está **documentado explícitamente para esto**:
  `-- no-secreto: PCC/pseudo-city, IATA, endpoints, country...` y el `COMMENT` de `:26` dice
  _"PCC/pseudo-city define tarifas privadas visibles"_. **El PCC va en `config`, no en una columna
  nueva**; el `{{pcc}}` de `POS.Source[].PseudoCityCode` (Workflows/1 req.1) es exactamente eso.
- `credentials_enc BYTEA` cifrado AES-256-GCM (`:12`) → guarda el `{{secret}}` del Basic auth.
- `UNIQUE (tenant_id, provider_code, label)` (`:18`) → una agencia puede tener **varias cuentas
  Sabre con distinto `label`**, útil si un consolidador maneja múltiples PCC.
- `resolve_provider_account` (`:59-77`) es genérica en `provider_code`: la herencia
  consolidador→agencia funciona para Sabre sin una línea de SQL nueva.

**`search_logs.provider_code TEXT`** (`0032:18`) y su índice `(provider_code, occurred_at DESC)`
(`0032:31`) ya están pensados para N proveedores.

**`orders.provider TEXT`** existe (`0005:9`) y `order_operations` (`0021`) es agnóstica.

### 4.2 Lo que hace falta — migración `00XX_multi_flight_provider.sql`

```sql
-- 1) Quitar el default: con dos proveedores de vuelo, un INSERT que olvide `provider`
--    ya no puede asumir LATAM en silencio. Debe fallar ruidoso (CLAUDE.md, principio 9).
ALTER TABLE orders ALTER COLUMN provider DROP DEFAULT;
COMMENT ON COLUMN orders.provider IS
  'Código del proveedor que originó la reserva: latam-ndc | sabre | agent-cars | despegar-hotels.';

-- 2) Agrupar las filas de telemetría de UNA búsqueda que salió a N proveedores.
--    Sin esto la cuota horaria del tenant se divide por el número de proveedores. Ver §2.5.
ALTER TABLE search_logs ADD COLUMN IF NOT EXISTS search_group_id UUID;
CREATE INDEX IF NOT EXISTS idx_search_logs_group ON search_logs(search_group_id)
  WHERE search_group_id IS NOT NULL;
COMMENT ON COLUMN search_logs.search_group_id IS
  'Agrupa las N filas (una por proveedor) de una misma búsqueda del vendedor. La cuota cuenta grupos, no filas.';

-- 3) Recontar por grupo (cuerpo completo en §2.5).
CREATE OR REPLACE FUNCTION count_recent_searches(...) ...;

-- 4) Catálogo de proveedores: reemplaza los mapas hardcodeados de reports.service.ts:49,
--    red/page.tsx:111 y CarterasClient.tsx:517 por una fuente de verdad única.
--    Tabla GLOBAL (sin tenant_id, sin RLS): es catálogo de plataforma, no dato de agencia.
CREATE TABLE provider_catalog (
  code            TEXT PRIMARY KEY,
  vertical        TEXT NOT NULL CHECK (vertical IN ('flights','hotels','cars','assistance')),
  display_name    TEXT NOT NULL,           -- 'LATAM NDC', 'Sabre'
  capabilities    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {retrieve,cancel,pay,services,reshop}
  env_fallback    BOOLEAN NOT NULL DEFAULT false,      -- ¿puede caer a credenciales de plataforma? Ver §2.2
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','beta','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON provider_catalog TO app_user;

-- 5) EL BLOQUEANTE DEL PACKAGE STUDIO (§1.7, §5.4).
--    provider_item_id VARCHAR(200) no admite un offerRef de Sabre: el contrato permite
--    offerId de 49 (booking-management-v1.yml:4962) + hasta 9 offerItemId de 52
--    (offer-price-ndc-v1.yml:190) = 526 caracteres en el peor caso, y 227 en el caso
--    típico con los largos de los propios ejemplos de Sabre. TEXT en Postgres no cuesta
--    nada frente a VARCHAR(n): mismo almacenamiento, sin la comprobación de longitud.
ALTER TABLE package_items ALTER COLUMN provider_item_id TYPE TEXT;
ALTER TABLE package_items ALTER COLUMN provider_name    TYPE TEXT;
COMMENT ON COLUMN package_items.provider_item_id IS
  'Id CRUDO del proveedor para reconstruir el ítem. Opaco: sólo lo interpreta el ACL que lo escribió.
   Era VARCHAR(200) y no alcanzaba para el offerRef compuesto de Sabre (offerId + hasta 9 offerItemId).';
```

**Y en el mismo PR, el borde Zod** (si sólo se toca el SQL, el 400 sigue apareciendo antes de
llegar a Postgres): `apps/api/src/packages/packages.schemas.ts:21`,
`providerItemId: z.string().min(1).max(200)` → `.max(2000)`.

El 2.000 no es arbitrario: 526 es el techo del `offerRef` compuesto de Sabre NDC, pero para
contenido **ATPCO/LCC** no hay `offerRef` reservable y hay que reconstruir el vuelo
(`FlightDetails.flights` admite hasta **16** vuelos — VERIFICADO-SPEC:
`booking-management-v1.yml:4983-4990`), lo que serializado no cabe en ningún string razonable.
Para ese caso la respuesta correcta **no es agrandar la columna** sino usar `raw_details JSONB`
(`0010:100`), que ya existe y no tiene límite. Regla a escribir en el código:

> `provider_item_id` es la **clave** para volver a pedirle el ítem al proveedor. Si el proveedor
> no da una clave y hay que reconstruir el producto entero, eso va en `raw_details`, no acá.

**Migración segura:** ampliar un `VARCHAR(n)` a `TEXT` en Postgres 16 no reescribe la tabla y no
requiere lock exclusivo prolongado (sólo `ACCESS EXCLUSIVE` instantáneo sobre el catálogo). No hay
índice sobre `provider_item_id` (verificado en `0010`), así que no hay reindexado. Es reversible
sólo si ningún valor supera 200 — anotarlo en el encabezado de la migración.

### 4.3 Preguntas de modelado que hay que decidir

**¿Hace falta persistir las offers con sus ids crudos efímeros?**

Argumento de que **sí**: en el flujo Sabre, `createBooking` necesita `flightOffer.offerId` +
`selectedOfferItems[]` **de la respuesta de price**, y `travelers[].id` = `{{price_passenger_id}}`,
otro id que **produce el price, no nosotros** (Workflows/1, req.3 — verificado). Hoy esos ids
viajan de vuelta al cliente dentro de la Offer y **el cliente los devuelve** en
`POST /orders` (`orders/dto.ts:9-11`, que valida sólo el sobre: `offer: z.record(z.unknown())`).
O sea: **el identificador que autoriza una reserva hace un round-trip por el navegador.**

Argumento de que **no** (y recomendación): ya se persiste `orders.selected_offer JSONB`
(`0005:17`, escrito en `orders.service.ts:166`), que conserva la Offer completa **después** de
reservar. El problema es sólo la ventana **entre búsqueda y reserva**. Recomendación mínima:
**no crear tabla de offers**; en cambio, el caché de búsqueda (§2.3) ya guarda las Offers 90 s, y
`OfferSchema.expiresAt` (`packages/canonical/src/offer.ts:107`) las hace inmutables con TTL.

**Resuelto en la 2ª pasada — ya no depende del sandbox.** La primera pasada dejaba la tabla
`provider_offers` como opción condicional a que "los ids de Sabre expiren más rápido que el flujo
de venta". El contrato responde: la oferta priced trae **`"ttl": 1200`** segundos y un
`offerExpirationDateTime` 20 minutos posterior al timestamp (VERIFICADO-SPEC:
`offer-price-ndc-v1.yml:2105-2107`), y la oferta de shop trae `timeToLive` en segundos
(`bargain-finder-max-v5.yml:8242-8246`, ejemplo 1255 ≈ 21 min). Con 20 minutos de ventana y un
caché de 90 s, **no hace falta la tabla**: queda descartada. Lo que sí hay que hacer es
**propagar ese TTL al canónico** — mapear `ttl`/`offerExpirationDateTime` a
`OfferSchema.expiresAt` en el mapper de Sabre, para que la UI pueda avisar antes de que la oferta
muera en vez de fallar en el `createBooking`.

**¿Tabla de órdenes por proveedor?** No. `orders` + `orders.provider` + `provider_raw JSONB`
(`0005:27`, hoy siempre `null` — ver `orders.service.ts:174` y `:123`) alcanzan. Lo que sí conviene
es **empezar a llenar `provider_raw`**, que existe desde el día 1 y nunca se escribió: con dos
proveedores, poder ver la respuesta cruda de la reserva es la diferencia entre diagnosticar en
minutos o a ciegas. Cuidado: **no puede llevar PAN/CVV** (`CLAUDE.md`, seguridad).

---

## 5. El `Offer` canónico: ¿puede transportar los ids crudos de Sabre?

### 5.1 Qué hay hoy

`packages/canonical/src/offer.ts:27-31`:

```ts
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  offerRef: z.string().min(1).max(255),
});
```

**Un solo string de hasta 255 caracteres.** LATAM ya se topó con el límite y lo resolvió
**empaquetando ids en el string**: `providers/latam-ndc/src/airshopping/response.mapper.ts:197-205`
codifica `OfferID|ItemID1,ItemID2` en `offerRef`, y
`providers/latam-ndc/src/offerprice/request.builder.ts:62-71` lo vuelve a partir con un
`parseOfferRef()`. El comentario del mapper lo dice sin rodeos:
`// Encode OfferItemIDs into offerRef so OfferPrice can reference them correctly`.

### 5.2 Qué necesita Sabre — **ahora con el contrato en la mano**

De la colección (VERIFICADO, Workflows/1):

| Paso | Request | Ids que consume |
| --- | --- | --- |
| Price | `POST /v1/offers/price` | `query[].offerItemId[]` (del shop) |
| Book | `POST /v1/trip/orders/createBooking` | `flightOffer.offerId`, `flightOffer.selectedOfferItems[]`, **`travelers[].id`** |

La primera pasada marcó los largos como DESCONOCIDO. **El contrato oficial los fija:**

| Dato | Restricción | Fuente |
| --- | --- | --- |
| `flightOffer.offerId` | `minLength: 2`, **`maxLength: 49`**; ejemplo `dx369rfr7jt8dnd2i0-1` (20 chars) | VERIFICADO-SPEC: `booking-management-v1.yml:4959-4964` |
| `flightOffer.selectedOfferItems[]` | `minItems: 1`, **`maxItems: 9`**; ejemplo `dx369rfr7jt8dnd2i0-1-1` (22 chars) | VERIFICADO-SPEC: `booking-management-v1.yml:4966-4974` |
| `offerItemId` (formato) | `pattern: ^([a-zA-Z0-9]){1,30}(-[0-9]{1,10}){2}$` → **máximo 52 caracteres** | VERIFICADO-SPEC: `offer-price-ndc-v1.yml:190` |
| `query[].passengerId[]` | `default: Passenger1` (`:198`), `pattern: ^([\w-]){1,200}$` (`:200`) | VERIFICADO-SPEC: `offer-price-ndc-v1.yml:198-200` |
| `Offer.source` | `pattern: (ATPCO)\|(LCC)\|(NDC)` — el ACL **tiene** que ramificar por esto | VERIFICADO-SPEC: `bargain-finder-max-v5.yml:8238-8240` |
| Vida de la oferta priced | `"ttl": 1200` segundos = **20 minutos**, con `offerExpirationDateTime` explícito | VERIFICADO-SPEC: `offer-price-ndc-v1.yml:2105-2107` |
| Vida de la oferta de shop | `Offer.timeToLive` entero en segundos, ejemplo `1255` | VERIFICADO-SPEC: `bargain-finder-max-v5.yml:8242-8246` |

**Sobre `travelers[].id` — el spec se contradice consigo mismo, y hay que decirlo:**

- `booking-management-v1.yml:6156-6159` describe `BookTraveler.id` como
  _"Price traveler's id as returned from Offer Price"_, con ejemplo `dx369rfr7jt8dnd2i0-1-1-1`
  (cuatro niveles: derivado del `offerId`, **no** elegible por nosotros).
- Pero el ejemplo de respuesta real de Offer Price devuelve
  `offerItems[].passengers[].id: "Passenger1"` (`offer-price-ndc-v1.yml:2119-2124`), que es
  **exactamente el id que el llamador mandó en el request** (`Passenger.id` está documentado como
  _"The `passengerId` referenced in the `Query` object"_, `offer-price-ndc-v1.yml:214-216`, con
  `pattern: ^(\S+)$` en `:218` — un patrón **mucho más permisivo** que el de `offerItemId`, lo que
  refuerza la lectura de que el id lo elige el llamador).

O sea: la descripción del contrato de booking dice que el id lo emite el price, y el ejemplo del
contrato de price muestra que lo emite el llamador. **No se puede decidir sin sandbox.**

Conclusión práctica, que no cambia respecto a la primera pasada pero ahora está fundada:
`Passenger.providerPaxId` (§5.3) se agrega **opcional**. Si el sandbox confirma que basta con
nuestro `paxId`, queda sin usar y no cuesta nada; si confirma la descripción de `BookTraveler`,
está el campo donde ponerlo. En nuestro dominio hoy `Passenger.paxId`
(`packages/domain/src/ports/order-create.port.ts:5`) lo **provee el llamador**, y para LATAM
funciona (`ordercreate/request.builder.ts:16` construye `<PaxRefID>` desde `p.paxId`).

### 5.3 Cambio mínimo propuesto

**Opción A — copiar el truco de LATAM (encoding en el string).** Cero cambios en `canonical`.
Coste: un `parseSabreRef()` frágil, ningún lugar donde poner los paxIds y — esto ya **no** es una
sospecha sino una cuenta cerrada contra el contrato (§5.4) — **desborda los 255 caracteres de
`offerRef` en el peor caso admitido por el spec, y los 200 de `package_items` en el caso típico**.
**Descartada, no sólo "no recomendada".**

**Opción B (recomendada) — un campo opaco y tipado, aditivo:**

```ts
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  offerRef: z.string().min(1).max(255),

  /**
   * Identificadores CRUDOS del proveedor, opacos para el dominio. Existe porque un ACL
   * NDC/OTA necesita reenviar ids que él no genera (offerItemId, y en Sabre el paxId que
   * emite la respuesta de price) y que no caben — ni conceptualmente ni por longitud — en
   * el string único `offerRef`. LATAM los empaqueta hoy como "OfferID|Item1,Item2"
   * (airshopping/response.mapper.ts:197); esto sustituye ese truco sin romperlo.
   *
   * NUNCA leer estas llaves desde packages/domain ni desde apps/: sólo el ACL que las
   * escribió las interpreta. Sin secretos, sin PII: viaja al navegador dentro de la Offer.
   */
  raw: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});
```

Y en `order-create.port.ts`, hacer que `Passenger.paxId` pueda venir del proveedor:

```ts
export interface Passenger {
  paxId: string;                    // id del cliente (LATAM: lo genera el llamador)
  /** Id de pasajero EMITIDO por el proveedor en el paso de price. Sabre: travelers[].id. */
  providerPaxId?: string;
  …
}
```

**Por qué es aditivo y seguro:**
- `raw` es `.optional()` → toda Offer LATAM existente sigue validando contra `OfferSchema`.
- Importa porque `OfferSchema` se usa como **validación de borde real** en
  `apps/api/src/search/search.schemas.ts:12-14` (`OfferPriceBodySchema`): un campo requerido nuevo
  rechazaría al instante toda oferta que un cliente tenga en pantalla.
- `orders/dto.ts:10` valida la offer como `z.record(z.unknown())` (passthrough), así que el flujo
  de reserva la deja pasar sin cambios.
- El front tipa `provider: { name: string; offerRef: string }`
  (`cotizaciones/actions.ts:39`) estructuralmente: campos extra no rompen TypeScript.

**Lo que NO hay que hacer:** agregar `simulated` a `Offer`. Es estado de infraestructura, no del
producto vendido; el join por `provider.name` contra `providers[]` de §2.4 lo resuelve sin
contaminar el modelo canónico.

### 5.4 El presupuesto de caracteres: la cuenta que nadie había hecho

Este es el hallazgo de la crítica llevado hasta el número. Hay **tres techos distintos** para el
mismo dato, y ninguno está documentado junto a los otros:

| Techo | Valor | Dónde |
| --- | --- | --- |
| `ProviderRefSchema.offerRef` | 255 | `packages/canonical/src/offer.ts:29` (`z.string().min(1).max(255)`) |
| `package_items.provider_item_id` | **200** | `db/migrations/0010_sprint1_core_suite.sql:99` (`VARCHAR(200) NOT NULL`) |
| `packages.schemas.ts` (borde Zod) | **200** | `apps/api/src/packages/packages.schemas.ts:21` |

Y el tamaño que Sabre puede producir, con la codificación estilo LATAM
(`offerId|item1,item2,…` — `providers/latam-ndc/src/airshopping/response.mapper.ts:197-205`):

```
largo(offerRef) = largo(offerId) + 1 + Σ largo(offerItemId_i) + (n − 1)
```

| Escenario | offerId | n ítems | largo ítem | Total | ¿255? | ¿200? |
| --- | --- | --- | --- | --- | --- | --- |
| Típico, 1 pax, ida y vuelta | 20 | 2 | 22 | **65** | OK | OK |
| Típico, familia de 4 con extras | 20 | 6 | 22 | **153** | OK | OK |
| Típico, tope del contrato (`maxItems: 9`) | 20 | 9 | 22 | **227** | OK | **ROMPE** |
| Peor caso admitido por el spec | 49 | 9 | 52 | **526** | **ROMPE** | **ROMPE** |

Los números de entrada son todos VERIFICADO-SPEC (§5.2): `maxLength: 49`
(`booking-management-v1.yml:4962`), `maxItems: 9` (`:4969`), y el `pattern` de `offerItemId` que
admite `30 + (1+10) + (1+10) = 52` caracteres (`offer-price-ndc-v1.yml:190`). Los largos "típicos"
son los de los ejemplos del propio contrato (`dx369rfr7jt8dnd2i0-1` = 20,
`dx369rfr7jt8dnd2i0-1-1` = 22).

**Tres conclusiones:**

1. **`offerRef` (255) sobrevive el caso típico y muere en el peor caso.** Por eso la Opción B
   (`ProviderRefSchema.raw`, §5.3) no es una elegancia: es la única forma de no depender de que
   Sabre nunca emita un id del largo que su propio contrato permite. `raw` es un `z.record` sin
   límite de longitud — cada `offerItemId` va en su propia entrada del array, no concatenado.
2. **`package_items` (200) muere ya en el caso típico** — con una familia de 9 ítems, que es
   justo lo que un consolidador arma. Por eso el `ALTER TABLE … TYPE TEXT` de §4.2 va en el
   mismo PR, y no "cuando haga falta".
3. **Para contenido ATPCO/LCC no hay `offerRef` reservable en absoluto.** `Offer.source` distingue
   los tres mundos (`bargain-finder-max-v5.yml:8238-8240`) y sólo el NDC entrega un `offerId`
   reservable. Para ATPCO/LCC hay que reconstruir el vuelo con `flightDetails` (hasta **16**
   vuelos, `booking-management-v1.yml:4983-4990`), que no cabe en ningún string. **Decisión
   propuesta:** el ACL escribe un `offerRef` sintético opaco (`sabre:atpco:<uuid>`) y guarda el
   `flightDetails` completo en `ProviderRef.raw` / `package_items.raw_details`; nunca se serializa
   un itinerario dentro del `offerRef`.

---

## 6. Configuración y secretos

### 6.1 Variables nuevas

Espejo de las `LATAM_*` (`infrastructure/hostinger/docker-compose.prod.yml:103-111` y
`.github/workflows/deploy.yml:130-137`):

| Variable | Tipo | Default propuesto | Notas |
| --- | --- | --- | --- |
| `SABRE_REST_URL` | var | `https://api.cert.platform.sabre.com` | **VERIFICADO** (ya no `[INFERIDO]`): es el valor literal de `rest_endpoint` en `sabre/BM API TEST CERT - EPR.postman_environment.json` |
| `SABRE_SOAP_URL` | var | `https://webservices.cert.platform.sabre.com` | **VERIFICADO**: `soap_endpoint` y `lls_endpoint` en el mismo environment tienen **el mismo valor**. Sólo hace falta si se activa el carril del §8 |
| `SABRE_EPR` | var | — | Usuario/EPR. **VERIFICADO**: el environment define `username = {{epr}}` |
| `SABRE_PASSWORD` | **secret** | — | Ver la corrección de abajo: el secreto Basic se **deriva**, no se guarda |
| `SABRE_PCC` | var | — | Pseudo-city / `POS.Source[].PseudoCityCode`. **Entra en la derivación del secreto** |
| `SABRE_FORCE_MOCK` | var | `false` | Espejo de `LATAM_FORCE_MOCK` |
| `PLATFORM_DEFAULT_FLIGHT_PROVIDERS` | var | `latam-ndc` | **Nueva y transversal.** CSV de codes con fallback a env. Ver §2.2 |
| `PROVIDERS_DISABLED` | var | `''` | **Ya existe** (`circuit-breaker.service.ts:35`), no está declarada en compose ni deploy. Habría que declararla |

**Corrección respecto a la primera pasada.** El documento decía que `SABRE_CLIENT_SECRET` es
_"un credential compuesto ya codificado, no user/pass sueltos"_. Eso es cierto a medias y la mitad
que falta importa: **el `{{secret}}` no es un dato que Sabre entregue, es algo que el cliente
calcula**. El script `prerequest` a nivel de colección lo construye así (VERIFICADO — colección
Sabre, evento `prerequest` de la raíz, rama `case 'token'` para `/v2/`):

```
clientId  = base64( "V1:" + username + ":" + pcc + ":AA" )
secret    = base64( clientId + ":" + base64(password) )
→ Authorization: Basic {{secret}}
```

(Para `/v3/auth/token` o superior el mismo script usa `base64(client_id + ":" + client_secret)`,
sin PCC.)

**Consecuencia de diseño, que la primera pasada no podía ver:** con `/v2/auth/token`, el
**PCC está dentro del secreto**. No son dos campos independientes. Si una agencia cambia de PCC,
el secreto guardado deja de servir aunque la contraseña siga siendo la misma. Por lo tanto:

- **NO** guardar el `secret` ya derivado en `credentials_enc`. Guardar `epr` + `password` (cifrados)
  y `pcc` (en `config`), y **derivar el Basic en cada arranque del adapter**. Es una línea de
  código y elimina toda una clase de bug silencioso ("cambié el PCC en la UI y sigue cotizando
  con el viejo").
- Esto además hace que el `evictStale` del factory (`latam-ndc.factory.ts:46-52`, clave por
  `updatedAt`) funcione para Sabre sin caso especial: cambiar el PCC toca `updatedAt` de la fila
  y el adapter se reconstruye con el secreto nuevo.

Puntos de edición: `infrastructure/hostinger/docker-compose.prod.yml` (bloque `environment` del
servicio api, tras `:111`) y `.github/workflows/deploy.yml` (heredoc del `.env`, tras `:137`).
No hay `.env.example` en el repo (verificado).

### 6.2 Convivencia con BYOC

La jerarquía de resolución **ya está construida** y no cambia:

```
1. provider_accounts del tenant, status='active'          → credentialSource: 'own'
2. provider_accounts del ancestro heredable más cercano    → credentialSource: 'inherited'
      (resolve_provider_account, 0012:59-77 — ORDER BY nlevel(path) DESC)
3. env SABRE_*                                             → credentialSource: 'env'
      SÓLO si 'sabre' ∈ PLATFORM_DEFAULT_FLIGHT_PROVIDERS  (§2.2)
4. mock                                                    → simulated: true
      (isMockMode(cfg), espejo de config.ts:20-23)
```

Reparto propuesto entre `credentials` (cifrado) y `config` (claro):

| Campo | Dónde | Por qué |
| --- | --- | --- |
| `epr` | `credentials` | Es el usuario del GDS. No es "público": identifica al agente ante Sabre. `credentials_enc`, AES-256-GCM (`0012:12`) |
| `password` | `credentials` | Secreto |
| `pcc` | `config` | No es secreto pero **sí determina precio** — `0012:26` lo dice: _"PCC define tarifas privadas visibles"_. Va en claro para poder auditarlo desde la UI. **Ojo: entra en la derivación del Basic (§6.1), así que cambiarlo invalida la sesión** |
| `restUrl` | `config` | Endpoint, permite apuntar una agencia a cert y otra a prod |
| ~~`clientSecret`~~ | — | **Eliminado respecto a la primera pasada.** Es un valor derivado de los tres anteriores; guardarlo duplicaría la verdad y se desincronizaría al cambiar el PCC. Ver §6.1 |
| `conversationIdPrefix` | `config` | Ver la corrección de abajo. Conviene que sea trazable por agencia `[INFERIDO]` |

**Corrección de la 3ª pasada — `Conversation-ID` no es lo que decían las pasadas anteriores.**
El documento afirmaba que el header _"aparece en todos los requests de la colección"_. **Es falso**,
y el conteo exacto importa porque decide si el cliente HTTP lo pone siempre o no:

| Hecho | Valor | Cómo se verificó |
| --- | --- | --- |
| Requests con header `Conversation-ID` | **334 de 1.077** (31%), de los cuales **333 son REST** | Tally sobre `requests.jsonl`, header en formato `"Clave: valor"` |
| Valores literales del header | `{{conv_id}}` (243) y el placeholder crudo `conversation-id-value` (91) | idem |
| Requests REST **sin** el header | **475 de 808** | idem |
| Valor en runtime de `{{conv_id}}` | `2021.01.DevStudio` | VERIFICADO: `pm.environment.set('conv_id', "2021.01.DevStudio")`, línea 25 del `prerequest` de la **raíz** de la colección |
| `<ConversationId>` del sobre SOAP | `2021.01.DevStudio` cuando se arma con `{{header}}`; pero **73 requests lo llevan hardcodeado**: `2019.09.DevStudio` (46) y `STX_2019_Postman` (27) | Tally de `<ConversationId>` sobre los bodies |
| `conv_id` en el environment | `""` — **vacío**; lo puebla el script, no el archivo | `sabre/BM API TEST CERT - EPR.postman_environment.json` |

Es decir: la afirmación _"constante para toda la colección"_ también era falsa. El valor de runtime
sí es único (`2021.01.DevStudio`), pero conviven **tres literales distintos** en la colección porque
73 requests SOAP escriben el sobre a mano en vez de usar `{{header}}`. Son restos viejos, no una
convención. **Consecuencia práctica:** el header es de trazabilidad, no de protocolo — ningún
contrato oficial lo declara obligatorio. `sabre-http.client.ts` puede emitirlo siempre (es lo
recomendable para poder correlacionar con el soporte de Sabre) sin que nada dependa de su valor.

Y en `red/page.tsx`, la entrada nueva del mapa `PROVIDERS` (`:111`):

```ts
const SABRE: ProviderForm = {
  label: 'Sabre',
  credentials: [
    { key: 'epr', label: 'EPR / Usuario', secret: true },
    { key: 'password', label: 'Contraseña', secret: true },
  ],
  config: [
    { key: 'pcc', label: 'PCC / Pseudo-city' },
    { key: 'restUrl', label: 'REST endpoint (opcional)' },
  ],
};
```

**Riesgo de seguridad a cerrar en el mismo PR:** `red/page.tsx:607` hace
`PROVIDERS[providerCode] ?? LATAM_NDC`. Si alguien tipea un code desconocido, la UI le presenta
**el formulario de LATAM** y el operador guardaría `apiKey`/`apiSecret` de LATAM bajo un
`provider_code` que nadie lee. Debe ser un error explícito, no un fallback.

---

## 7. Tests que hay que escribir

### 7.1 Punto de partida: qué cobertura hay hoy

29 archivos `*.test.ts` en el repo. Los tres factories BYOC están cubiertos
(`latam-ndc.factory.test.ts`, `agent-cars.factory.test.ts`, `despegar-hotels.factory.test.ts`),
igual que los humanizadores de error de los tres proveedores.

**El directorio `apps/api/src/search/` no tiene un solo test.** Verificado: ni
`search.service.ts`, ni `provider-fanout.ts`, ni `circuit-breaker.service.ts`, ni
`memory-cache.adapter.ts`, ni `search-telemetry.service.ts`. Es decir: **el código que hay que
refactorizar es el único sin red de seguridad.** Escribir estos tests **antes** del refactor, contra
el comportamiento actual, no es opcional.

Convenciones observadas: Vitest (`describe/it/expect`), sin `vi.mock` de módulos — se inyectan
stubs por constructor (`latam-ndc.factory.test.ts:30-32`). Los tests de integración se **saltan
solos** sin Postgres con `const d = hasDb ? describe : describe.skip`
(`provider-credentials.integration.test.ts:16-17`).

### 7.2 Unitarios — deuda previa (escribir primero, sin Sabre)

| Archivo nuevo | Qué prueba |
| --- | --- |
| `apps/api/src/search/provider-fanout.test.ts` | `fanOut`: 2 OK; 1 OK + 1 falla → `items` del bueno y `failed[0].code` correcto; los 2 fallan → `items` vacío y 2 en `failed`; que el **paralelismo sea real** (dos promesas lentas, tiempo total ≈ el máximo, no la suma) |
| `apps/api/src/search/dedupe.test.ts` | `dedupeCheapest`: colapsa mismo itinerario quedándose con el neto menor; **NO** colapsa mismo vuelo con familia tarifaria o equipaje distinto (§2.6); estabilidad del orden |
| `apps/api/src/search/circuit-breaker.test.ts` | Abre a los 5 fallos; falla instantáneo estando abierto; pasa a half-open tras 30 s (reloj falso); un fallo en half-open reabre; un éxito cierra y resetea; `PROVIDERS_DISABLED=sabre` **no afecta a `latam-ndc`** |
| `apps/api/src/search/memory-cache.test.ts` | TTL vence; `invalidatePattern` con `*`; eviction a los 5.000; `escapeRe` con una clave que lleve `.` o `+` (relevante: la clave nueva usa `+` como separador de codes, §2.3) |

### 7.3 Unitarios — del refactor multi-proveedor

| Archivo | Qué prueba |
| --- | --- |
| `apps/api/src/providers/flight-provider.registry.test.ts` | Con stubs de `ProviderCredentialsService` (patrón de `latam-ndc.factory.test.ts:30`): tenant con las dos cuentas → 2 proveedores en **orden estable**; sólo LATAM → 1; ninguna y `PLATFORM_DEFAULT_FLIGHT_PROVIDERS=latam-ndc` → sólo LATAM por env, **Sabre ausente**; `byCode('sabre')` con Sabre no habilitado → lanza; `credentialSource` es `'inherited'` cuando `resolved.inherited === true` |
| `apps/api/src/providers-sabre/sabre.factory.test.ts` | Copia literal de los 5 casos de `latam-ndc.factory.test.ts:34-74`: reutiliza instancia con credenciales iguales (cache de token OAuth), reconstruye al rotar `updatedAt`, fallback env, BYOC ≠ env, propaga errores no-NotFound |
| `apps/api/src/providers-sabre/sabre-errors.test.ts` | Espejo de `latam-ndc-errors.test.ts`: status 0 → conectar; 5xx → problema interno; 401/403 → credenciales; detalle corto desconocido se muestra |
| `apps/api/src/search/search.service.test.ts` | **El más importante.** LATAM OK + Sabre OK → ofertas de ambos y `providers.length === 2`; **Sabre falla → siguen las ofertas de LATAM + `providers[sabre].status === 'error'`** (degradación parcial, hoy invisible por el defecto **B**); ambos fallan → lanza; **sólo Sabre en mock → `simulated: true` y el resultado NO se cachea**; la clave de caché cambia al cambiar el set de codes; `priceOffer` de una oferta con `provider.name === 'sabre'` invoca al adapter de **Sabre** (regresión del defecto #9) |
| `apps/api/src/search/search-telemetry.test.ts` | `instrument` escribe **una fila por proveedor** con el **mismo `search_group_id`**; `outcome: 'simulated'` cuando `simulatedOf` da true; un fallo de la propia telemetría no tumba la búsqueda (`search-telemetry.service.ts:88-90`) |

### 7.4 Integración con Postgres (patrón `hasDb`)

| Archivo | Qué prueba |
| --- | --- |
| `apps/api/src/search/search-quota.integration.test.ts` | **La regresión de §2.5.** Sembrar N búsquedas × 2 proveedores → `count_recent_searches` devuelve **N, no 2N**; filas viejas sin `search_group_id` siguen contando 1 cada una (rama `COALESCE`) |
| `apps/api/src/providers-sabre/sabre-byoc.integration.test.ts` | Extiende `provider-credentials.integration.test.ts` con `provider_code='sabre'`: cuenta propia gana sobre heredada; se salta un ancestro con `is_inheritable=false`; un tenant con LATAM pero **sin** Sabre no resuelve Sabre |
| `apps/api/src/packages/packages-provider-id.integration.test.ts` | **La regresión de §5.4.** `addItem` con un `providerItemId` de **526 caracteres** (peor caso del contrato: `offerId` de 49 + 9 `offerItemId` de 52) persiste y se relee **idéntico**. Sin el `ALTER TABLE … TYPE TEXT` de §4.2 este test falla con `22001`; con el `.max(200)` de `packages.schemas.ts:21` falla con 400 antes de llegar a la DB. Es el test que impide que el bloqueante vuelva |
| `apps/api/src/providers-sabre/sabre-basic-secret.test.ts` | Unitario, sin DB. La derivación de §6.1 contra un vector conocido: `base64(base64("V1:"+epr+":"+pcc+":AA") + ":" + base64(pwd))`. Y la regresión que importa: **cambiar sólo el PCC produce un secreto distinto** — es lo que garantiza que no se guarde el derivado |

### 7.5 Aislamiento cross-tenant — exigido por `CLAUDE.md`

> _"Tests de aislamiento cross-tenant obligatorios en CI."_

Hay base previa (`network/tenant-isolation.integration.test.ts`,
`network/memberships-rls.integration.test.ts`). Falta lo específico de multi-proveedor. Todos
deben conectarse como **`app_user` (NOBYPASSRLS)**, no como owner — el test BYOC actual usa el
usuario privilegiado y lo admite en su cabecera (`provider-credentials.integration.test.ts:11-14`),
así que ese hueco sigue abierto.

| Archivo | Qué prueba |
| --- | --- |
| `apps/api/src/provider-credentials/byoc-isolation.integration.test.ts` | Como `app_user` con `app.current_tenant_id = A`: un `SELECT` directo sobre `provider_accounts` **no ve** la cuenta Sabre del tenant B **ni la del propio consolidador** (policy de `0012:47-49`, igualdad estricta de tenant). Y que `resolve_provider_account(A,'sabre')` **sí** devuelve la del consolidador — la única ruta autorizada hacia arriba |
| `apps/api/src/search/search-cache-isolation.test.ts` | Unitario, sin DB: el tenant A no lee jamás la entrada del tenant B con criterio idéntico; **y con el mismo tenant, dos sets de proveedores distintos no colisionan** (regresión directa del cambio de clave, §2.3) |
| `apps/api/src/search/search-logs-isolation.integration.test.ts` | Como `app_user` del tenant A: no lee filas de `search_logs` del tenant B; **sí** lee las de su subárbol (`can_read_membership`, `0032:44-46`). Sembrar filas de ambos proveedores para que el test también cubra el fan-out |
| `apps/api/src/providers/adapter-cache-isolation.test.ts` | El caché de instancias del factory (`latam-ndc.factory.ts:18`, clave `byoc:owner:updatedAt`) **no devuelve el adapter del tenant A al tenant B**; y `evictStale` (`:46-52`) descarta la entrada vieja al rotar credenciales. Es el punto donde una fuga de credenciales entre agencias sería silenciosa y total |

### 7.6 Umbrales de cobertura

`CLAUDE.md` pide `>70%` en `domain/` y `>50%` global. `apps/api/package.json:11` corre
`vitest run` **sin `--coverage`** y no hay `vitest.config.*` en el repo (verificado), así que los
umbrales **hoy no se aplican en ninguna parte**. Con `providers/sabre/` entrando, conviene agregar
un `vitest.config.ts` con `coverage.thresholds` antes de que la deuda crezca.

---

## 8. El carril SOAP/LLS stateful: dónde viviría el pool de sesiones (y por qué proponemos no construirlo)

La primera pasada ignoró este carril por completo. Es el 22,6% de la colección: **243 de 1.077
requests** van a `{{soap_endpoint}}` / `{{lls_endpoint}}` con `Content-Type: text/xml`
(conteo en `00-fuentes.md` §1).

### 8.1 Volumen y forma

| Operación SOAP/LLS | Requests |
| --- | --- |
| `SessionCloseRQ` | 61 |
| `SessionCreateRQ` | 50 |
| `OTA_AirAvailRQ` | 30 |
| `GetHotelAvailRQ` | 26 |
| `HotelPriceCheckRQ` | 25 |
| `OTA_AirBookRQ` | 4 |
| `PassengerDetailsRQ` | 4 |
| `EnhancedEndTransactionRQ` | 4 |
| `Sabre_OTA_ProfileCreateRQ` | 4 |
| `UpdatePassengerNameRecordRQ` | 3 |
| `GetVehAvailRQ` | 2 |
| `VehPriceCheckRQ` | 1 |
| Resto (variantes menos frecuentes) | 29 |

Dos cosas saltan del conteo. Primera: **hay más cierres que aperturas** (61 vs 50) — Sabre cierra
sesión incluso en flujos donde no la abrió en el mismo folder, lo que dice cuánto le importa el
cierre. Segunda: **el grueso son sesiones y disponibilidad legacy** (`OTA_AirAvailRQ`,
`GetHotelAvailRQ`), no reservas.

### 8.2 Mecánica, VERIFICADA contra los scripts de la colección

Esto sale del script `prerequest`/`test` de la **raíz** de la colección Sabre, no de un request
suelto — es decir, aplica a los 243:

1. `SessionCreateRQ` va con credenciales en claro en el header SOAP:
   `<UsernameToken><Username>{{epr}}</Username><Password>…</Password>` **`<Organization>{{pcc}}</Organization>`**
   `<Domain>DEFAULT</Domain>` (slice `09-soap-lls-stateful.txt:16-33`).
2. La respuesta trae `Envelope.Header.Security.BinarySecurityToken`, que el script guarda en
   `token` (`case 'SessionCreateRQ'` del `test` de raíz).
3. **Todo** request posterior lleva ese token inyectado:
   `<BinarySecurityToken EncodingType="Base64Binary" valueType="String">${token}</BinarySecurityToken>`,
   con `<Action>` = el nombre del RQ y `ConversationId` = `2021.01.DevStudio`. Eso es lo que las
   variables `{{header}}` / `{{footer}}` — **vacías en el environment**, verificado — construyen en
   runtime; el `prerequest` de la raíz arma tres variantes (`header`, `header_appid`, `header_diag`)
   en sus líneas 57-61. Ojo: 73 requests SOAP **no** usan `{{header}}` y llevan el sobre escrito a
   mano con `ConversationId` viejo — ver la corrección de §6.2.
4. El token **puede rotar en caliente**: `ContextChangeLLSRQ` devuelve un `SecurityToken` con
   atributo `Updated`; si vale `'true'`, el script reemplaza el token guardado.
5. El prefijo `ATH:` se quita del token porque, dice el comentario del script,
   _"it's not accepted by Sabre's 2SG gateways"_.
6. `SessionCloseRQ` cierra (slice `09-soap-lls-stateful.txt:267-271`).

**Traducción a requisitos de implementación:** cliente XML (parseo y serialización), estado
compartido con exclusión mutua, rotación de token, cierre garantizado y barrido de huérfanas.
Nada de eso existe en `providers/latam-ndc/`, que es stateless: token OAuth cacheado en memoria y
listo. Es, efectivamente, una desviación arquitectónica seria.

### 8.3 La razón para **no** construirlo ahora

> **Refutación explícita.** La premisa con la que se encargó esta revisión decía que el carril
> SOAP _"exige cliente XML y pool de sesiones con cierre garantizado"_, y la calificaba de
> desviación arquitectónica obligatoria respecto a `providers/latam-ndc`. **La primera mitad es
> cierta y la segunda no.** Es cierto que *ese carril*, si se usa, exige XML, pool y cierre (§8.2 y
> §8.4 lo detallan). Lo que no es cierto es que haya que usarlo: **ningún endpoint de nuestro
> alcance lo requiere.** La evidencia va abajo y son ocho páginas oficiales distintas. Se deja
> anotado en vez de corregido en silencio, porque la conclusión invierte una decisión de
> arquitectura cara.

Es el hallazgo más valioso de los contratos oficiales para este documento. La documentación de
cada endpoint del alcance dice, literalmente:

> _"This API is designed to operate in a stateless way, and accepts both sessionless (ATK) and
> session-based (ATH) tokens. When a call is made to this API via a session-based token, the
> session (AAA) is cleared before and after execution."_

VERIFICADO-SPEC en ocho páginas oficiales distintas —
`specs/help/booking-management-api-v1/help-documentation-create-booking.txt:28`,
`…-get-booking.txt:14`, `…-cancel-booking.txt:11`, `…-modify-booking-0.txt:28`,
`…-fulfill-flight-tickets.txt:16`, `…-void-flight-tickets.txt:11`,
`…-refund-flight-tickets.txt:11`, y
`specs/help/flight-reshop-api-1.0/help-documentation-sabre-flight-reshop.txt:23`.
`specs/help/get-seats-agency-3.0/3.0-index.txt:22` agrega: _"The GetSeats API supports ATK and ATH
session tokens"_.

Precisión de la 3ª pasada, tras releer las ocho líneas una por una: **la redacción varía** entre
páginas — unas abren con _"This API is designed to operate in a stateless way, and accepts…"_
(create, get, modify, reshop) y otras con _"While this API is designed to operate in a stateless
way, it accepts…"_ (cancel, void, refund) o _"While Booking Management is a stateless API…"_
(fulfill). **El contenido normativo es idéntico en las ocho**: stateless por diseño, ATK y ATH
ambos aceptados. Se anota porque el documento las citaba como si fueran la misma frase literal.

Y la guía de Booking Management (`specs/help/booking-management-api-v1/v1-index.txt:359-363`)
presenta los dos caminos como equivalentes: **Create Access Token API → ATK (stateless)** o
**Create Session → ATH (stateful)**, ambos devolviendo un `BinarySecurityToken`.

**Conclusión: todo nuestro alcance (shop, price, createBooking, getBooking, cancelBooking,
fulfill/void/refund, reshop, seats) corre con ATK y sin una sola sesión SOAP.** El carril SOAP es
el mundo legacy LLS — disponibilidad `OTA_AirAvailRQ`, PNR nativo, perfiles — que la colección
mantiene por compatibilidad.

Peor aún para la idea del pool: la frase _"the session (AAA) is cleared before and after
execution"_ significa que **mezclar un token ATH con las APIs REST destruye el estado de la
sesión**. Un pool compartido entre el carril REST y el SOAP se corrompería solo. Si algún día se
construye, tienen que ser dos pools con tokens distintos y sin cruce.

> **Recomendación:** `providers/sabre/` v1 = **sólo ATK stateless**. El §8.4 queda documentado para
> el día que haga falta (colas de agencia, PNR nativo, o disponibilidad legacy), no para ahora.

### 8.4 Si hubiera que construirlo: dónde vive y qué se rompe

**Dónde vive.** No en `providers/sabre/`. Los tres paquetes de `providers/` son librerías puras sin
DI ni ciclo de vida — `providers/latam-ndc/package.json` no depende de `@nestjs/*` — y un pool
necesita un hook de apagado para garantizar el `SessionCloseRQ`. Reparto propuesto:

| Pieza | Dónde | Por qué |
| --- | --- | --- |
| `SabreSessionPort` (interfaz `acquire(key) → Lease`, `release(lease)`) | `providers/sabre/src/session/` | El adapter la consume; no la implementa |
| Construcción/parseo del sobre SOAP | `providers/sabre/src/soap/` | Es traducción de protocolo: pertenece al ACL |
| La implementación con estado + `OnApplicationShutdown` | `apps/api/src/providers-sabre/session-pool.service.ts` | Sólo la app Nest tiene ciclo de vida y hooks de apagado |

**Relación con `packages/core/src/ports/`.** Hay **15** ports declarados — los 15 que
`CLAUDE.md` promete: `blob-storage`, `cache`, `clock`, `crypto`, `event-bus`, `feature-flags`,
`id-generator`, `job-queue`, `logger`, `metrics`, `notification`, `search-index`,
`secrets-manager`, `tracer`, `workflow-engine`. **Ninguno sirve:**

- `CachePort` (`cache.port.ts:1-6`: `get`/`set`/`delete`/`invalidatePattern`) es lo más cercano y
  **es la trampa obvia**. No sirve: un caché entrega el mismo valor a N lectores concurrentes, y
  una sesión Sabre **no se puede compartir** — dos requests simultáneos mutando el mismo AAA se
  pisan. Falta el concepto de *lease* exclusivo y de devolución.
- `JobQueuePort` sí sirve, pero para otra cosa: el barrido periódico de sesiones huérfanas.
- `ClockPort` sirve para que el TTL sea testeable sin `setTimeout` reales.

Por el principio 7 de `CLAUDE.md` ("nunca importar infra directamente desde dominio; siempre vía
port"), correspondería un **16º port**, `session-pool.port.ts`, genérico:
`acquire(key: string): Promise<Lease>` / `release(lease: Lease): Promise<void>` /
`Lease { token: string; expiresAt: number }`.

Aviso realista sobre ese patrón: de los 15 ports existentes **sólo 2 tienen implementación** —
`CachePort` → `MemoryCacheAdapter` (`apps/api/src/search/memory-cache.adapter.ts:2`) y
`BlobStoragePort` → `LocalDiskStorageAdapter` (`apps/api/src/storage/local-disk-storage.adapter.ts:2`).
Verificado por grep de `@sales-travel/core` en `apps/` y `providers/`: **exactamente dos
importadores en todo el repo**. Los otros 13 son interfaces sin adaptador. Agregar el 16º sin
implementarlo no aporta nada; se declara **junto con** el adapter o no se declara.

**Qué pasa con el aislamiento multi-tenant.** Es el punto crítico y no es teórico.

La sesión **está atada a un PCC**: `Organization = {{pcc}}` en el `UsernameToken` (VERIFICADO,
§8.2), y la documentación oficial lo confirma desde el otro lado —
`specs/help/get-seats-agency-3.0/3.0-index.txt:102`: _"it is no longer required to provide PCC in
travelAgency element as this information is read from ATK/ATH session"_. El PCC **es** la sesión.

Reglas que se derivan:

1. **La clave del pool es el `provider_account.id`, nunca el `tenant_id`.** Con el modelo
   consolidador, N agencias heredan las credenciales de un ancestro
   (`resolve_provider_account`, `db/migrations/0012_provider_accounts.sql:59-77`) y por lo tanto
   **comparten PCC**. Si la clave fuera el tenant, cada agencia abriría su propia sesión sobre el
   mismo PCC y se agotarían los slots concurrentes que Sabre concede. Y a la inversa: si dos
   cuentas distintas colisionaran en la misma clave, la agencia B cotizaría con el PCC de la A —
   **el Riesgo 1 de este documento, pero peor**, porque acá el estado vive del lado de Sabre y
   sobrevive al reinicio de nuestro proceso.
2. **RLS no protege nada acá.** El pool es memoria del proceso, fuera de Postgres. Las policies de
   `0012:47-49` no lo alcanzan. La única defensa es el test de §7.5
   (`adapter-cache-isolation.test.ts`), extendido al pool.
3. **Branch shopping no necesita sesión nueva** — dato útil para el consolidador.
   `specs/help/hotel-price-check-v5/v5-index.txt:77`: _"Although the shopping step takes place in
   the branch location PCC provided in the request, the underlying session or token used to
   authenticate or call this API remains unchanged"_, y aclara que esto **cambió** respecto al
   comportamiento legacy, donde la sesión misma recibía acceso a la sucursal. Traducción: un
   consolidador puede cotizar en el PCC de una agencia hija pasándolo **en el request**, con una
   sola sesión del PCC padre. Encaja con la herencia de `provider_accounts` sin multiplicar sesiones.
4. **Cierre garantizado en tres capas**, porque una sesión sin cerrar consume un slot del PCC —
   y ese slot es de *todas* las agencias que heredan esa cuenta:
   `finally` por operación → `OnApplicationShutdown` con `Promise.allSettled` de todos los leases
   → barrido por TTL (`JobQueuePort`). El error oficial cuando no hay slots es explícito:
   _"Unable to create ATH session token. Please retry the transaction."_
   (`specs/help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:43`,
   `…-modify-booking-error-list-0.txt:29`,
   `specs/help/flight-reshop-api-1.0/help-documentation-sabre-flight-reshop-error-list.txt:27`).
5. **Escalado horizontal lo rompe igual que al breaker** (Riesgo 5): con dos réplicas, cada una
   con su pool, se duplican las sesiones sobre el mismo PCC sin que ninguna lo sepa. Un pool de
   sesiones **exige** estado compartido antes de la segunda réplica; el circuit breaker y el caché
   sólo se degradan.

---

## 9. Encaje con el roadmap de olas

`docs/discovery/07-roadmap-olas.md` (v1.0, fechado **2026-04-24**) es el plan vigente y **ningún
documento de la primera pasada lo leyó**. Leído hoy, 2026-08-25, estaríamos en el **Mes 3-4** de la
Ola 1 (inicio Mayo 2026, lanzamiento Noviembre 2026).

### 9.1 Dónde cae este trabajo en el plan

En el papel, integrar Sabre es una tarea del **Mes 2, sprint S2.1/S2.2**:

> `07-roadmap-olas.md:73` — _"Adapter Travelport y Sabre (search) ⚠️"_, criterio de aceptación:
> _"Search desde 3 GDS en paralelo con scatter-gather"_.

El "scatter-gather" del roadmap es exactamente el fan-out de `provider-fanout.ts:27`, que ya
existe y ya es genérico. Lo que el roadmap **no previó** es que el resto del sistema se construiría
mono-proveedor: el plan asumía multi-GDS desde el día 1, y por eso no reservó tiempo para el
refactor de §2. **Ese refactor es el costo oculto de este roadmap.**

### 9.2 Dónde el roadmap está desactualizado respecto al repo real

Verificado listando `providers/`, `apps/`, `packages/` y `db/migrations/`:

| El roadmap dice | El repo tiene | Lectura |
| --- | --- | --- |
| Mes 1: _"Adapter Amadeus self-service (search vuelos) end-to-end ⚠️"_ (`07-roadmap-olas.md:58`) | **No hay Amadeus.** `providers/` = `agent-cars`, `despegar-hotels`, `latam-ndc` | El primer proveedor de vuelos terminó siendo LATAM NDC directo; Self-Service fue descontinuado el 17-07-2026 |
| Ola 4, **Año 2**: _"NDC directo con LATAM, Avianca, Aeroméxico"_ (`07-roadmap-olas.md:258,261`) | **Ya está hecho** — `providers/latam-ndc/`, en producción | El orden se invirtió: lo de Año 2 se hizo primero y lo del Mes 1 nunca se hizo |
| Mes 2: _"Redis cache con TTL por categoría + stampede protection"_ | `MemoryCacheAdapter` en proceso, documentado como interino (`memory-cache.adapter.ts:19-23`) | Deuda consciente, no olvido |
| Mes 2: _"Typesense para catálogo destinos"_ | No existe | Pendiente |
| Mes 2: _"Temporal self-hosted + primera saga"_ | No existe `apps/temporal-worker/`; `apps/` = `api`, `web-b2b` | Pendiente. Relevante: la reserva multi-proveedor con compensación es justo lo que Sabre + LATAM van a necesitar |
| Mes 2: _"Adapter HotelDo"_ | `providers/despegar-hotels/` | Proveedor distinto al planificado |
| Mes 3: _"Constructor drag-and-drop … itinerario armado en pantalla"_ | Sólo la **API** (`apps/api/src/packages/`); **cero** referencias en `apps/web-b2b/src/` (verificado por grep) | El roadmap lo daba por cerrado hace ~2 meses. Es donde estalla el `VARCHAR(200)` del §1.7 |
| Mes 3: _"Servicio de Quote persistida con expiración"_ | Hecho (`apps/api/src/quotations/`, `db/migrations/0004_quotations.sql`) | Al día |
| Mes 3: _"Roles (superadmin, admin tenant, vendedor)"_ | Hecho, y ampliado (`0013_consolidator_roles.sql`, `0025_role_escalation_guard.sql`) | Adelantado |
| Ola 2, Mes 7: _"Adapter CarTrawler"_ (autos) | `providers/agent-cars/` ya existe | Adelantado una ola, con otro proveedor |
| — (no figura en ningún mes) | **CRM completo**: `0024`, `0031`, `0034` + `apps/api/src/crm/` (8 archivos) | Trabajo real que el plan no contempla en absoluto |
| — (no figura en ningún mes) | **Modelo consolidador / BYOC**: `0011_tenant_hierarchy`, `0012_provider_accounts`, `0013_consolidator_roles`, `0016_pricing_waterfall` | El roadmap es **anterior** a esa decisión; la fuente vigente es `docs/platform/12-modelo-consolidador-y-plan.md`, que `CLAUDE.md` declara canónica |

También faltan, contra la estructura target de `CLAUDE.md`: `apps/ai-sidecar`, `apps/temporal-worker`,
`apps/web-b2c`, `apps/web-admin`, `apps/mobile`, y los packages `ui`, `i18n`, `sdk`.
De los ~20 directorios de `providers/` que enumera `CLAUDE.md`, existen **3**.

**Diagnóstico honesto:** el roadmap v1.0 describe un producto multi-GDS construido sobre
proveedores agregadores; el repo construyó un producto **consolidador con BYOC** sobre un proveedor
NDC directo. No es que el equipo se haya atrasado — **cambió la tesis del producto** (`CLAUDE.md`
lo dice sin ambigüedad: el modelo consolidador es el _"target central"_) y el roadmap no se
reescribió. El riesgo RR1 del propio roadmap (_"Homologación GDS más lenta de lo esperado"_,
`07-roadmap-olas.md:341`) se materializó, pero la mitigación real no fue la planificada (Amadeus Self-Service,
ahora descontinuado) sino otra (NDC directo).

### 9.3 Consecuencias concretas para el trabajo de Sabre

1. **Sabre es el primer GDS de verdad del repo**, no el tercero. El criterio de aceptación del
   roadmap (_"3 GDS en paralelo"_) se cumple parcialmente con 2 (LATAM NDC + Sabre), y sólo
   después del refactor de §2.
2. **El `ALTER TABLE package_items` (§4.2) tiene que ir antes del lienzo drag-and-drop**, que el
   roadmap ubica en Ola 2. Hacerlo ahora es una migración sobre una tabla probablemente vacía;
   hacerlo después es migrar datos de producción de "el corazón del producto".
3. **Temporal sigue sin existir y ahora importa más.** Una reserva que toca dos proveedores con
   compensación es el caso de uso que el roadmap puso en el Mes 2 (_"saga de reserva
   multi-proveedor con compensación"_, `07-roadmap-olas.md:96`) y que hoy no tiene dónde vivir. Con un solo proveedor
   se podía posponer; con dos, un fallo a mitad de camino deja estado inconsistente entre PCCs
   distintos.
4. **Redis pasa de "deuda cómoda" a bloqueante de escala.** §8.4 punto 5 y Riesgo 5: con Sabre
   entran un circuito más, un caché con más entradas y —si algún día se activa el §8— un pool de
   sesiones. Los tres exigen estado compartido antes de la segunda réplica.

**Recomendación de secuencia**, que respeta las dependencias reales y no las del papel:

```
§7.2 (tests de la deuda previa, sin Sabre)
  → §2 (registry multi-proveedor + telemetría por proveedor)
  → §4.2 (migración: default de orders, search_group_id, provider_catalog, ALTER package_items)
  → providers/sabre + apps/api/src/providers-sabre  (sólo ATK, §8.3)
  → §2.6 (dedupe) con datos reales de los dos proveedores
```

---

## Preguntas abiertas

Las de forma de respuesta de Sabre están en los otros documentos de esta serie; acá van
**sólo las que bloquean decisiones de arquitectura de nuestro repo**.

### Cerradas en esta pasada por el contrato oficial (se dejan anotadas, no se repiten)

| Pregunta de la 1ª pasada | Respuesta | Fuente |
| --- | --- | --- |
| ¿Largo real de `offerId` / `offerItemId`? | `offerId` ≤ **49**; `offerItemId` ≤ **52** por su `pattern`; hasta **9** ítems por oferta. Peor caso del `offerRef` compuesto: **526 chars** | VERIFICADO-SPEC: `booking-management-v1.yml:4962`, `:4969`; `offer-price-ndc-v1.yml:190`. Cuenta en §5.4 |
| ¿Cuánto duran los ids de oferta? | Oferta priced: **`ttl: 1200` s (20 min)** + `offerExpirationDateTime`. Oferta de shop: `timeToLive` en segundos (ejemplo 1255) | VERIFICADO-SPEC: `offer-price-ndc-v1.yml:2105-2107`; `bargain-finder-max-v5.yml:8242-8246`. **El caché de 90 s alcanza; la tabla `provider_offers` de §4.3 queda descartada** |
| ¿`Conversation-ID` estable por sesión, búsqueda o request? | **No necesita ser único por request.** El script de raíz fija `conv_id = 2021.01.DevStudio` (línea 25 del `prerequest`). Pero **corregido en la 3ª pasada**: el header sólo va en **334 de 1.077** requests, y conviven tres literales distintos. Es trazabilidad, no protocolo | VERIFICADO: tally sobre `requests.jsonl` + `prerequest` de la raíz. Detalle en §6.2 |
| ¿Hace falta un pool de sesiones SOAP? | **No para nuestro alcance.** Todos los endpoints que usamos aceptan token stateless ATK | VERIFICADO-SPEC: 8 páginas oficiales citadas en §8.3 |

### Siguen abiertas

1. **¿`travelers[].id` de `createBooking` acepta un id propio, o debe ser el que emite el price?**
   **El contrato oficial se contradice** (§5.2): `booking-management-v1.yml:6159` lo describe como
   _"Price traveler's id as returned from Offer Price"_ con un ejemplo derivado del `offerId`, pero
   el ejemplo de respuesta de price devuelve el `Passenger1` que mandó el llamador
   (`offer-price-ndc-v1.yml:2119-2124`). **Sólo se resuelve con una llamada real al sandbox CERT.**
   Mitigación mientras tanto: `Passenger.providerPaxId` opcional (§5.3), que sirve en los dos casos.
2. **¿Un consolidador va a operar varios PCC a la vez?** `provider_accounts` lo soporta vía `label`
   (`0012:18`), pero el registry de §2.1 asume **una cuenta por (tenant, provider)**: `forTenant`
   devuelve un adapter por code. Si la respuesta es sí, `ResolvedProvider.code` tiene que volverse
   `code+label` y eso cambia el circuit breaker, la clave de caché y `search_logs.provider_code`.
   **Decisión de producto, no técnica.** Ahora pesa más: §8.4 muestra que el PCC **es** la unidad de
   sesión y de slots del lado de Sabre, no un simple parámetro.
3. **¿Qué pasa cuando LATAM y Sabre venden el mismo vuelo LATAM?** Ahora hay un discriminador
   verificado: `Offer.source` con `pattern: (ATPCO)|(LCC)|(NDC)`
   (`bargain-finder-max-v5.yml:8238-8240`). ¿Se colapsan (§2.6) o se muestran las dos con su fuente?
   Afecta al margen: una puede ser tarifa neta de consolidador y la otra pública.
4. **¿El contenido ATPCO/LCC de Sabre entra al Package Studio, o sólo el NDC?** Para ATPCO/LCC no
   hay `offerRef` reservable y hay que reconstruir el vuelo con hasta 16 `flights`
   (`booking-management-v1.yml:4983-4990`). §5.4 propone un `offerRef` sintético + `raw_details`,
   pero **hay que decidir si el Package Studio acepta ítems que no se pueden re-cotizar por id**.
5. **¿La cuota horaria (`tenants.search_quota_per_hour`, `0032:64-65`) cuenta búsquedas o llamadas
   a proveedor?** §2.5 propone búsquedas (grupos). Si el modelo de negocio factura por llamada al
   proveedor, la respuesta es la contraria y la migración cambia. **Decisión de monetización** —
   y `MEMORY.md` ya marca "monetización sin spec" como bandera amarilla.
6. **¿Sabre entra con fallback a credenciales de plataforma o sólo BYOC?**
   `PLATFORM_DEFAULT_FLIGHT_PROVIDERS` (§6.1) hace la decisión explícita y reversible, pero alguien
   tiene que tomarla: fallback = onboarding instantáneo pero la plataforma paga las consultas;
   sólo BYOC = cada agencia trae su PCC y no hay sorpresa de costos.
7. **¿Cuántas sesiones ATH concurrentes admite un PCC?** Sólo importa si algún día se activa el
   §8.4, pero es el número que dimensiona el pool. El error existe y está documentado
   (_"Unable to create ATH session token"_), el límite no. **DESCONOCIDO: sólo el sandbox o el
   contrato comercial con Sabre lo dan.**
8. **¿Se actualiza `07-roadmap-olas.md` o se lo declara documento histórico?** §9.2 muestra que
   describe un producto distinto al que se está construyendo. Mientras siga marcado como plan
   vigente, cualquiera que lo lea va a planificar sobre premisas falsas.

---

## Riesgos

Ordenados por daño × probabilidad.

1. **Fuga de credenciales entre agencias por el caché de instancias del factory.** `Map` en memoria
   con clave `byoc:${ownerTenantId}:${updatedAt}` (`latam-ndc.factory.ts:18,29`). Un error al copiar
   ese patrón para Sabre — por ejemplo cachear por `tenantId` en vez de `ownerTenantId`, o omitir
   `evictStale` (`:46-52`) — hace que **la agencia B busque con el PCC de la agencia A**. Sería
   silencioso: tarifas plausibles, ventas contra el contrato equivocado. Mitigación: el test de §7.5
   `adapter-cache-isolation.test.ts`, **no negociable**.

2. **La cuota horaria se divide por el número de proveedores** (§2.5). Sin la columna
   `search_group_id`, un tenant con cuota 600 pasa a 300 búsquedas efectivas y empieza a recibir
   403 con el mensaje _"Se alcanzó el límite de 600 búsquedas por hora"_
   (`search-telemetry.service.ts:60-62`) — un mensaje que **miente sobre el número real**, así que
   nadie va a diagnosticarlo rápido. Alta probabilidad si el refactor de telemetría se hace sin la
   migración.

3. **Reservar una oferta de Sabre contra LATAM.** `orders.service.ts:138` y `search.service.ts:114`
   ignoran `offer.provider.name` y van siempre a `this.latam.forTenant()`. El día que la primera
   oferta Sabre aparezca en pantalla, este código la manda a LATAM. Fallará, pero el error será
   incomprensible ("LATAM rechazó la operación"). **Debe arreglarse en el mismo PR que habilita
   Sabre en búsqueda**, no después.

4. **Degradación parcial silenciosa.** Defecto **B** de §1.6: hoy `failed[]` no llega al cliente.
   Con un proveedor era invisible. Con dos, un vendedor puede estar viendo **la mitad del mercado**
   creyendo que ve todo, y cotizarle a su cliente un precio que no es el mejor disponible. El
   comentario de `provider-fanout.ts:24-25` lo anticipa palabra por palabra: _"Devolver resultados
   incompletos EN SILENCIO sería peor que fallar"_. Cerrarlo con `providers[]` en la respuesta (§2.4).

5. **Estado en memoria + escalado horizontal.** El circuit breaker
   (`circuit-breaker.service.ts:25-27`), el caché de búsqueda (`memory-cache.adapter.ts:19-23`) y el
   caché de adapters del factory son **todos por proceso**, y los tres archivos lo documentan
   explícitamente. Con un proveedor el impacto era una tasa de acierto partida. Con dos, además, el
   breaker se vuelve inconsistente entre réplicas: la instancia 1 tiene Sabre abierto y la 2 lo sigue
   golpeando. **El día que se agregue una réplica, esto pasa a ser el problema principal.**

6. **Ofertas duplicadas en pantalla.** `dedupeCheapest` existe pero nunca se llamó (defecto **C**),
   así que **no está probado con datos reales**. Si el primer despliegue de Sabre sale sin dedupe
   activo, el vendedor ve la misma opción dos veces y no sabe cuál elegir — exactamente el escenario
   que describe `provider-fanout.ts:54-57`. Si sale con un dedupe demasiado agresivo, se esconden
   opciones legítimas con distinto equipaje. Ambos extremos son malos; el test de §7.2 es el que
   define el punto medio.

7. **Credenciales guardadas bajo el formulario equivocado.** `red/page.tsx:607` cae a `LATAM_NDC`
   para cualquier `providerCode` desconocido (§6.2). Un operador podría cargar credenciales Sabre
   en campos llamados `apiKey`/`apiSecret`/`agencyIata`, que el factory de Sabre jamás va a leer:
   la cuenta parecería configurada y el proveedor correría en **modo mock silencioso** — es decir,
   precios inventados con aspecto real, el riesgo que `search.service.ts:35-39` ya identifica como
   el peor del sistema.

8. **Cuentas cargadas en `sandbox` que nunca habilitan nada.** La UI crea con `status: 'sandbox'`
   (`red/page.tsx:604`), pero `resolve_provider_account` exige `status='active'`
   (`0012:70`). Una agencia carga sus credenciales Sabre, ve la cuenta listada, y sigue **sin**
   Sabre en los resultados, sin ningún mensaje que lo explique. Ya pasa hoy con LATAM; con dos
   proveedores el síntoma ("me falta la mitad de los vuelos") es más confuso.

9. **El refactor toca el camino crítico sin tests previos.** `apps/api/src/search/` tiene **cero**
   cobertura (§7.1) y es el código que genera todos los ingresos. Refactorizarlo primero y testear
   después convierte cualquier regresión en un incidente de producción detectado por un vendedor.
   Mitigación: §7.2 antes que §2.

10. **Divergencia de mensajes de error.** `humanizeLatamError` (backend,
    `latam-ndc-errors.ts:20`) y `humanizeProviderError` (frontend,
    `provider-errors.ts:7`) ya son dos copias parcialmente solapadas — el comentario de
    `provider-errors.ts:4-5` cuenta que **ya hubo** dos copias divergentes antes. Agregar un tercer
    y cuarto humanizador para Sabre (backend + frontend) reabre el problema al doble de escala.

11. **El `VARCHAR(200)` del Package Studio, descubierto tarde.** `package_items.provider_item_id`
    (`0010:99`) no admite el `offerRef` compuesto de Sabre en el caso *típico* de 9 ítems (§5.4:
    227 caracteres). Hoy no lo detecta nadie porque el Package Studio no tiene front-end
    (verificado por grep en `apps/web-b2b/src/`). Cuando la Ola 2 construya el lienzo
    drag-and-drop (§9), el síntoma va a ser: **el vuelo de Sabre no se puede agregar al paquete y
    el error dice "String too long"** — sobre "el corazón del producto", según `CLAUDE.md`, y con
    datos ya en producción. Coste ahora: un `ALTER TABLE` sobre una tabla casi vacía. Coste
    después: migración con datos. **Alta probabilidad, daño alto, mitigación trivial hoy.**

12. **Cotizaciones que guardan ids ya muertos.** `quotations.expires_at` lo fija el vendedor
    (`quotations/dto.ts:19`) y el snapshot de la oferta va entero a `selected_offer`
    (`0004:14`). Pero la oferta priced de Sabre vive **1.200 segundos** (VERIFICADO-SPEC:
    `offer-price-ndc-v1.yml:2105`). Una cotización a 7 días contiene, a los 21 minutos, ids que ya
    no existen. Hoy pasa igual con LATAM, pero con Sabre tenemos el número exacto y ya no hay
    excusa: el flujo de "aceptar cotización → reservar" tiene que **re-cotizar**, no reusar el
    snapshot. Si no, el vendedor le promete al cliente un precio que la reserva va a rechazar.

13. **Sesiones SOAP huérfanas, si algún día se activa el §8.** Una sesión ATH no cerrada consume
    un slot del PCC, y con el modelo consolidador ese PCC es compartido por **todas** las agencias
    que heredan la cuenta (`resolve_provider_account`, `0012:59-77`). Una fuga en un tenant deja
    sin GDS a los demás, con un error que no menciona sesiones desde el punto de vista del
    vendedor. Es la razón principal para **no** construir el pool mientras ATK alcance (§8.3).

14. **Planificar sobre un roadmap que describe otro producto.** `07-roadmap-olas.md` sigue marcado
    como plan vigente y pone el NDC directo de LATAM en el Año 2 cuando ya está en producción, y
    Amadeus en el Mes 1 cuando no existe (§9.2). El riesgo no es técnico: es que alguien estime
    el trabajo de Sabre como "una tarea del Mes 2 que ya estaba prevista" sin ver el refactor de
    §2, que el roadmap nunca contempló porque asumía multi-GDS desde el día 1.
