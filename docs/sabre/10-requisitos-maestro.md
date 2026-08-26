---
titulo: "Sabre — Requisitos maestro de integración"
fecha: 2026-08-25
estado: reconciliado-contra-spec
Fuentes: ver 00-fuentes.md
---

# Sabre — Requisitos maestro de integración

> **Qué cambió respecto de la primera pasada.** Este documento se escribió cuando la única fuente era la
> colección Postman y **8 de los 10 análisis daban la forma de las respuestas por desconocida**. Ya no es así:
> tenemos **21 contratos OpenAPI oficiales y 81 páginas de documentación** de `developer.sabre.com`
> ([00-fuentes.md](./00-fuentes.md) §2). La mayoría de los `DESCONOCIDO` de este maestro se han cerrado como
> **VERIFICADO-SPEC** y están así en la matriz de §7.
>
> **Tres errores de procedencia erradicados:**
> 1. **Las 4 respuestas guardadas de la colección NO están vacías.** Pesan **16.479 bytes de cuerpo** cada una,
>    son las cuatro de `/v1/orders/view`, y están extraídas en `slices/responses/*.json`. Son el mismo documento
>    repetido (mismo `order.id`, mismo PNR `TOSGCZ`), así que prueban la **forma** de `/v1/orders/view` pero no el
>    efecto de cada modificación ([20 §1](./20-workflows-e2e.md), [08 §0](./08-seams-integracion-repo.md)).
> 2. El front-matter citaba `EXTERNAL_AGENCY.postman_collection.json`, que es la colección de **LATAM NDC**, no la
>    de Sabre. Corregido: toda fuente se cita desde `00-fuentes.md`.
> 3. El carril **SOAP/LLS stateful (243 de 1.077 requests)** estaba ignorado. Ahora tiene tratamiento explícito
>    en el alcance (§2.2 N1), en las decisiones (D2) y en los riesgos.

---

## 1. Resumen ejecutivo

Sabre nos da tres cosas que hoy no tenemos: **amplitud de contenido** (ATPCO + LCC + NDC de 34 aerolíneas en una
sola llamada, con NDC de LATAM en CO/PE/BR desde feb-2025), **ciclo de vida completo del billete** (emisión, void,
refund, EMD) y **el primitivo consolidador en el contrato**: `targetPcc` está documentado literalmente para
"agencias que separan booking, fulfillment y shopping en distintos PCC"
(VERIFICADO-SPEC `help-documentation-create-booking.txt:118`).

Lo que cuesta: (a) **certificación de 4-8 semanas por PCC** más *branch access* gestionado por Sabre agencia por
agencia, lo que rompe la promesa de onboarding "en horas" en la ruta BYOC; (b) un **conflicto PCI frontal** —
**49** requests de `createBooking` y **15** de `fulfillFlightTickets` mandan PAN en claro (**46** y **12** con CVV);
(c) **fee opaco sobre el endpoint de mayor volumen**: BFM está marcado `premium` en el propio catálogo de Sabre
([09 §1.1.1](./09-referencia-externa-y-gaps.md)); (d) **la post-venta NDC no existe todavía** — Flight Reshop es
`beta` y sólo ATPCO, con "NDC Reshop Shop Order under development"; y (e) **el contrato declara casi sólo HTTP 200**:
los fallos de negocio viajan dentro de `errors[]`, así que un adapter que mire `res.ok` dará por confirmadas
reservas que fallaron.

**Las credenciales EPR+PCC+password ya están disponibles fuera de Git**; el environment versionado sigue vacío por
diseño y falta inyectarlas para ejecutar CERT. **El bloqueante vigente es comercial:** sin fee por transacción,
sin confirmación escrita de operación multi-PCC de terceros y sin cobertura NDC medida en CO/PE/BR, comprometer
las fases 1-4 es apostar ~50 días-persona sobre un contrato que nadie ha visto (**D0**, **§2.3**).

---

## 2. Alcance

### 2.1 Lo que SÍ entra

| # | Capacidad | Endpoints Sabre | Justificación |
| --- | --- | --- | --- |
| **A1** | Autenticación **ATK stateless** + BYOC por tenant | `POST /v2/auth/token` | Único camino ejercitado (59 requests). El contrato declara `flow: application` + `x-base64-encode-client-credentials: true` en los 21 specs y **ninguno menciona `/v3`**. Cubre todo el alcance: las operaciones de Booking Management "*accept both sessionless (ATK) and session-based (ATH) tokens*". |
| **A2** | Búsqueda ATPCO + NDC **en una sola llamada** | `POST /v5/offers/shop` con `Version: "5"` | **Cambio de recomendación: v5, no v4.** v5 es la única con `POS.MultiSourceControl` (multi-PCC nativo = modelo consolidador), penalidades NDC estructuradas y **3 ejemplos de respuesta oficiales usables como fixtures hoy**. Coste de cambio desde el diseño v4: sólo el valor de `Version`. Ver [02 §Decisiones](./02-air-shop-bfm.md). |
| **A3** | Revalidación de precio NDC | `POST /v1/offers/price` | Obligatorio en NDC. `ttl` (segundos) y `offerExpirationDateTime` son **campos requeridos**: el vencimiento se lee, no se inventa. |
| **A4** | Reserva, recuperación, cancelación | `createBooking`, `getBooking`, `cancelBooking` | Núcleo del producto. |
| **A5** | Emisión, void, refund y consulta de reembolsabilidad | `fulfillFlightTickets`, `checkFlightTickets`, `voidFlightTickets`, `refundFlightTickets` | Sin emisión, Sabre es un buscador, no un consolidador. |
| **A6** | Emisión bajo PCC del consolidador | `targetPcc` en `createBooking` / `fulfill` / `cancel` / `void` / `getBooking` / `refund` | El modelo consolidador nativo, en contrato y no en promesa comercial. Condicionado a *branch access* (**P-10**). |
| **A7** | Modificación de reserva **sin tocar forma de pago** | `modifyBooking` | Email, teléfono, documentos, asientos, SSR, loyalty. Capacidad que hoy no tenemos con ningún proveedor. |
| **A8** | **Vinculación multi-producto sin PNR único** | `hotel.associatedFlightDetails`, `car.associatedFlightDetails`, `car.flightIndex` | **Nuevo en el alcance.** Entrega el gesto de Package Studio "hotel/auto con este vuelo" **con el vuelo en LATAM NDC directo**, sin SOAP, sin sesiones y sin migrar nada. Ver §6.3 y [07 §6.5](./07-hoteles-y-autos.md). |
| **A9** | Mapas de asiento (carril NDC/REST) | Get Seats — **versión por decidir** (P-06) | REST puro. **Bloqueado por una discrepancia real**: la colección usa `/v1/offers/getseats` (32 requests) y el contrato vigente publica `/v3/offers/getseats/by*`. Nacer en v1 es deuda garantizada. |

### 2.2 Lo que NO entra

| # | Capacidad excluida | Justificación (opinada) |
| --- | --- | --- |
| **N1** | **Carril SOAP/LLS stateful completo** (LCC con ancillaries, perfiles EPS, group bookings, disponibilidad legacy) | 243 requests, un transporte que el stack hoy no tiene (cliente XML + parser + `SabreSessionPool` con lease/keepalive/compensación). **Y no hace falta para vender:** `createBooking` ya orquesta `ContextChangeLLSRQ`, `OTA_AirBookLLSRQ`, `PassengerDetailsRQ` y `EnhancedEndTransactionRQ` **por dentro** (VERIFICADO-SPEC `help-documentation-create-booking.txt:34-61`). **Fuera de Ola 1, con hito propio y estimación propia.** Ver **D2**. |
| **N2** | **Hoteles de Sabre** | Despegar ya está en producción. Sabre suma un segundo inventario real (6 fuentes con una credencial) pero arrastra el conflicto PCI y **el `PageSize` por defecto de 200 devuelve tarifa cacheada para 160 de cada 200 propiedades**. **Candidato de fase 5 condicionado al spike de [07 §Decisiones](./07-hoteles-y-autos.md), no de fase 1.** |
| **N3** | **Autos de Sabre** | El argumento ya no es "el contrato es pobre" —el contrato de `get-vehicle-availability-v2` es rico—, es que **AgentCars ya cubre más superficie**: autocomplete, oficinas con horarios, ON HOLD/release, reporte diario. Sabre sólo añade entrega a domicilio con un `siteID` que **no hay forma documentada de descubrir**. Y `CarToModify` **no existe** en el contrato: los autos no son modificables, sólo cancelables. **Descartar.** |
| **N4** | **PNR único multi-producto** (vuelo + hotel + auto bajo un solo localizador) | **La justificación anterior era falsa y se retira.** Decía que el PNR único obliga a `flightDetails` (sell GDS clásico) y por tanto a migrar la vertical vuelo entera a Sabre. **No es cierto:** existe un flujo verificado (31 requests, familia *FOP Hybrid*) donde el PNR **nace de una oferta NDC** y el hotel se agrega después por `UpdatePassengerNameRecordRQ` — sin `flightDetails` en ninguna parte ([07 §6.3](./07-hoteles-y-autos.md)). El coste real es **enrutar el aire por el shop NDC de Sabre para itinerarios concretos**, que es una decisión de enrutamiento reversible con feature flag, no una migración de plataforma. **Sigue fuera de Ola 1** por N1 (exige SOAP) y por el punto 3 de [07 §6.4](./07-hoteles-y-autos.md) (un solo `payment.formsOfPayment[]` compartido obliga a consolidar el pricing waterfall por vertical en un cobro único, lo que cambia el modelo de comisiones). **Pero deja de estar descartado: es un spike de un día** (mecanismo B: ¿acepta `createBooking` `flightOffer` NDC + `hotel` en una sola llamada? El schema lo permite, la prosa oficial lo desmiente). Mientras tanto, A8 entrega el 80 % del valor. |
| **N5** | **Enhanced Air Ticket** `/v1.3.0/air/ticket` | Camino legacy: no soporta NDC, ni EMD, ni `targetPcc`. **Y la razón para excluirlo mejoró:** el camino REST **sí** tiene anti-billete-fantasma (`commitTicketToBookingWaitTime` + `isCommitted`) y **sí** tiene factura (`notificationEmail`, `printDocuments`, `generateSingleInvoice`). No perdemos nada. |
| **N6** | **Sabre Profiles, colas Sabre, ancillaries ATPCO/LCC por SOAP** | Exigen el carril SOAP (N1). **Y hay un segundo argumento, que es el que manda:** Sabre Profiles es un almacén de PII de viajero que se solapa con `apps/api/src/customers/`. Ver la regla de §6.5. |
| **N7** | **Modificación de forma de pago en reserva existente** | Exige el keyword `CCVIEW` en el EPR o reinyectar el PAN: `getBooking` devuelve la tarjeta enmascarada y el error "*Payment card must meet `^[0-9]{12,19}$`*" sugiere que cambiar de tarjeta exige el PAN completo. **Fuera mientras D1 sea "nunca PAN".** |
| **N8** | **Cambio voluntario / reemisión por Sabre** | **Nuevo.** Falta **un solo eslabón y es insalvable hoy**: `checkFlightTickets` dice si es cambiable, Flight Reshop da las opciones y `fulfillFlightTickets` emite contra `priceQuoteReissueRecordId`, **pero nada de lo que tenemos crea el PQR** ([06 §Preguntas](./06-ticketing-void-refund.md)). Y Flight Reshop es `beta` y **sólo ATPCO** — "NDC Reshop Shop Order is under development". Nuestro contenido diferencial es NDC. **Consecuencia de producto: hay que corregir `docs/platform/12-modelo-consolidador-y-plan.md` §4.1, que da la post-venta por cerrada.** |
| **N9** | **Sabre como fuente del documento fiscal** | Sabre no emite factura DIAN/SUNAT/NF-e y no va a hacerlo. Lo que sí entra en alcance es **RF-21**: extraer de Sabre los datos que alimentan a nuestro proveedor fiscal y fijar quién factura qué. Ver §6.6. |

### 2.3 Valor esperado — la cifra que no existe en ningún documento

Los diez análisis suman ~17.000 líneas y **ninguno cuantifica el beneficio de Sabre**. Eso es un defecto del
expediente, no un detalle. El plan compromete 48-59 días-persona ([11](./11-plan-implementacion.md)) contra los
compromisos abiertos de Ola 1 (pagos, fiscal, IA WhatsApp, Package Studio).

**Métrica única de decisión, medible en Fase 0 sin escribir una línea de ACL:**

> En una muestra de **20-30 búsquedas reales BOG/LIM/GRU contra CERT**, ¿en qué porcentaje Sabre aporta
> (a) una oferta que hoy no existe en LATAM NDC directo, o (b) el mismo vuelo a mejor precio neto?

**Umbral a preacordar con el founder antes de ejecutar la medición** (si se acuerda después, se acuerda para
justificar el resultado). Propuesta: **< 15 % de aporte incremental ⇒ no se abre la Fase 1**; el esfuerzo se
reinvierte en Ola 1. La medición cuesta medio día una vez existan credenciales y es la única compuerta que
convierte D0 en una decisión con dato.

---

## 3. Requisitos funcionales

> **CA** = criterio de aceptación verificable. `⛔BLOQ-CRED` = no verificable hasta tener credenciales de
> certificación. **La regla de proceso cambió:** ya no es cierto que "ningún mapper es escribible". Los campos
> obligatorios de shop, price, createBooking, getBooking, check/fulfill/void/refund y seatMaps están **verificados
> contra contrato**, y BFM v5 y Offer Price traen **8 ejemplos de respuesta completos** utilizables como fixtures.

### RF-01 — Autenticación ATK con caché distribuida y política de 401 por tipo

**Descripción.** OAuth2 `client_credentials` con `Authorization: Basic base64(base64("V1:{epr}:{pcc}:AA") + ":" + base64(password))`.
**VERIFICADO-SPEC**: `booking-management-v1.yml:20-27` declara `flow: application`, `tokenUrl .../v2/auth/token` y
`x-base64-encode-client-credentials: true`; los 21 contratos apuntan a v2 y **ninguno menciona v3**.
La **forma** del response es conocida — `{access_token, token_type:"bearer", expires_in}` con ejemplo oficial
`604800` (7 días), `help/get-hotel-avail-v5.0/v5.0-index.html:76-78` — pero el **valor real es del contrato
comercial**: se lee de la respuesta, nunca se hardcodea.

**CA.**
1. Test unitario: dado `{epr:'500001', pcc:'U9PK', password:'x'}`, el header producido es byte a byte el del
   algoritmo de [01 §2.1](./01-autenticacion-y-conectividad.md).
2. **La caché vive en el port de caché (Redis), clave `sabre:atk:{ownerTenantId}:{pcc}`, no en memoria de proceso.**
   Ya no es preferencia: el **TAM Pool existe** y su agotamiento se manifiesta como `401 invalid_client`
   (VERIFICADO-SPEC `help/booking-management-api-v1/v1-errors.txt:41-51`). N réplicas re-autenticando en cada
   deploy es exactamente la forma de agotarlo.
3. TTL efectivo = `expires_in` de la respuesta menos un margen del 10 %; si el campo falta, `config.tokenTtlSeconds`
   (default 3600) **y un warning estructurado**, nunca un silencio.
4. **Política de 401 por tipo, no genérica** (§4 RNF-03):
   `invalid_client` → backoff, máx. 2 reintentos, **nunca auto-deshabilitar la cuenta BYOC**;
   `Wrong clientID or clientSecret` → marcar la cuenta `invalid` y avisar al tenant;
   `ERR.2SG.SEC.INVALID_CREDENTIALS` → invalidar caché y reintentar **una** vez;
   `403 ERR.2SG.SEC.NOT_AUTHORIZED` → alerta de onboarding, **cero** reintentos y **no abre circuito**.
5. **El reintento tras 401 sólo aplica a operaciones idempotentes** (`getBooking`, `checkFlightTickets`, shop,
   price). Cero reintentos en `createBooking` / `fulfill` / `void` / `refund`: siete errores distintos comparten
   `type = UNAUTHORIZED_ACCESS` y sólo se distinguen por una `description` en inglés de texto libre; parsearla es
   frágil y un reintento en `fulfill` duplica una emisión.

### RF-02 — Credenciales BYOC por tenant con herencia consolidador→agencia

**Descripción.** `provider_accounts` con `provider_code='sabre'`; `credentials` (cifrado) lleva `{epr, password}`;
`config` (claro) la identidad operativa. Resolución con `resolve_provider_account()` **sin una línea de SQL nueva**.
Sabre **no** tiene fallback a credenciales de plataforma salvo habilitación explícita
(`PLATFORM_DEFAULT_FLIGHT_PROVIDERS`, default `latam-ndc`).

**CA.**
1. Test de integración (patrón `hasDb`): cuenta propia gana sobre heredada; se salta un ancestro con
   `is_inheritable=false`; un tenant con LATAM pero sin Sabre **no** resuelve Sabre.
2. La clave de caché de instancias es `byoc:{ownerTenantId}:{homePcc}:{updatedAt}` — el `homePcc` es obligatorio
   porque **el ATK está atado al par (EPR, PCC)**: va dentro del propio `secret`.
3. **No se persiste el `secret` derivado.** Se deriva en cada arranque desde `epr+password+pcc`; guardarlo se
   desincroniza en silencio al cambiar el PCC.
4. Test de aislamiento cross-tenant como `app_user` (NOBYPASSRLS).
5. `isMockMode()` es `true` si falta cualquiera de `epr`, `password`, `homePcc`.

### RF-03 — Búsqueda de vuelos ATPCO + NDC en una llamada

**Descripción.** `OTA_AirLowFareSearchRQ` sobre `/v5/offers/shop`. **`Version` debe coincidir con la URL**
(VERIFICADO-SPEC `bargain-finder-max-v5.yml:55`), contra la conclusión de la primera pasada de que era informativo.
**`DataSources` no es un switch de un bit:** BFM consulta ATPCO + NDC (+ LCC) **en la misma llamada**.

**CA.**
1. `criteria.pax` → PTC de Sabre: `ADT`, **`CNN`** (no `CHD`), `INF`/`INS`. Test de propiedad que falle si aparece
   `CHD`. `C06`..`C11` (niño con edad) se soportan porque disparan descuentos por edad que `CNN` no.
2. **`MultipleSourcePerItinerary.Value = true` es una CONSTANTE del builder cuando se comparan ATPCO y NDC.** El contrato dice
   literalmente "*By default, **the cheaper will stay***" (VERIFICADO-SPEC `bargain-finder-max-v5.yml:5473-5478`;
   idéntico en `v4:3196-3200`): sin ella, **Sabre decide qué alternativa cross-source sobrevive**. Las marcas y
   upsells requieren además `MultipleBrandedFares`/`MaxNumberOfUpsells`; testear ambas palancas por separado.
3. **`PriceRequestInformation.CurrencyCode = criteria.currency` SIEMPRE** (`v5.yml:7849`). Corrige la afirmación
   anterior de que BFM no tiene campo de moneda: existe en v3/v4/v5 y gana sobre `PointOfSaleOverride`.
   Además, el mapper valida `totalFare.currency` con warning, como ya hace el de LATAM.
4. `TravelPreferences.Baggage.RequestType` (enum `A|C|N`, `v5.yml:5885`) y `VoluntaryChanges` se envían **siempre**:
   sin ellos, equipaje y penalidades **no vienen en la respuesta**. Son nuestro diferencial, no un extra.
5. **`RequestType.Name` sale de `config`, nunca hardcodeado**, y todo resultado vacío se loguea con el
   `RequestType` usado. Pedir un tier no suscrito devuelve **"No Availability": cero resultados SIN error**
   (`v5.yml:5537-5544`), indistinguible de "no hay vuelos".
6. `POS.Source[].PseudoCityCode = config.homePcc`; `RequestorID.ID='1'`, `Type='1'`, `CompanyName.Code='TN'`
   (`v5.yml:57-59`).
7. `CompressResponse.Value = true` en producción (`v5.yml:5512`). `AirStreaming` **queda descartado**: el contrato
   dice que sólo funciona en XML sobre REST y nuestro cliente es JSON.

### RF-04 — Mapeo de la respuesta de shop al `Offer` canónico

**Descripción.** El mapper rehidrata el modelo normalizado por referencias
(`itineraryGroups → itineraries → legs → legDescs → schedules → scheduleDescs`) y produce `Offer[]` válido contra
`OfferSchema`. **26 secciones raíz**, verificadas (`bargain-finder-max-v5.yml:3810`).

**CA.**
1. **Regla de proceso corregida.** La regla dura anterior ("no escribir el mapper hasta tener 6 payloads del
   sandbox") **se retira**: los campos obligatorios están verificados y hay 3 ejemplos oficiales completos.
   **El mapper se escribe ya contra esos fixtures**, y no se da por terminado hasta tener el fixture de
   **vuelo nocturno con cambio de día**, que es el único caso que los ejemplos no cubren.
2. `Offer.expiresAt = fetchedAt + offer.timeToLive`. `timeToLive` es **campo obligatorio** en las tres versiones
   (`v5.yml:8226`): siempre viene. **Nunca un default inventado.**
3. `Offer.source` se puebla desde `offer.source` (`ATPCO|LCC|NDC`, `v5.yml:8237`) y `distributionModel`
   (`:8819`). Sin esto no hay dedupe contra LATAM directo (RF-06).
4. **Dos trampas con test obligatorio:**
   (a) `baseFare` **no es** `baseFareAmount` — ese viene en moneda de publicación; el bueno es
   `equivalentAmount`/`equivalentCurrency` (comprobado con la aritmética del ejemplo oficial: 58,0 + 73,8 = 131,8).
   (b) `legs[].ref` indexa `legDescs`, pero **la fecha del tramo sale de `legDescriptions` por posición**: usar el
   `ref` invierte ida y vuelta.
5. `taxDescs[]` (por tasa y estación) y `taxSummaryDescs[]` (agrupado por código) son **la misma información**:
   sumar los dos es contar doble.
6. Enum de cabina: `P` Premium First, `F` First, `J` Premium Business, `C` Business, `S` Premium Economy,
   `Y` Economy. **Corrige la primera pasada**: `premium_economy` no es `W` (no existe en el enum) sino `S`, y
   `business` es `C`, no `J`.
7. Éxito = HTTP 2xx **Y** `errors[]` vacío **Y** ningún `messages[].severity === 'Error'`. Fixture obligatorio de
   200-con-error.

### RF-05 — Fan-out multi-proveedor con degradación parcial visible

**Descripción.** `SearchService` deja de inyectar el factory concreto de LATAM y consulta un
`FlightProviderRegistry`. El contrato del endpoint crece a `{ offers, simulated, providers[] }` con
`{code, status, count, reason?}` por proveedor.

**CA.**
1. Sabre falla → siguen apareciendo las ofertas de LATAM **y** `providers[sabre].status === 'error'` con razón
   humanizada. Hoy el array `failed` de `fanOut` se descarta en silencio.
2. Ambos fallan → excepción tipada que el filtro traduce a **502**, no a 500 genérico.
3. `simulated` cambia de semántica a "hay al menos una tarifa falsa en esta lista"; la UI marca **oferta por
   oferta** cruzando `offers[].provider.name` contra `providers[]`.
4. `priceOffer` y `createOrder` enrutan por `offer.provider.name`. Test de regresión: una oferta
   `provider.name === 'sabre'` **nunca** invoca al adapter de LATAM (hoy `search.service.ts:114` y
   `orders.service.ts:138` la mandarían a LATAM — §6.4).
5. `assertSupportsLatamOps` (`orders.controller.ts:141`) desaparece; lo sustituyen capacidades declaradas (RF-19).

### RF-06 — Deduplicación entre Sabre y LATAM

**CA.**
1. Clave de producto = `(carrier + flightNumber + departureAt por segmento, en orden) ‖ cabin ‖
   baggage.checked.qty ‖ refundable ‖ changeable`. **La misma aeronave con y sin maleta son dos productos.**
2. `operatingFlightNumber` se añade a `SegmentSchema`: el dato **ya viene de Sabre** (`v5.yml:2908`) y lo estamos
   tirando; sin él los codeshares del mismo avión no colisionan.
3. Horas comparadas en UTC. Si el conjunto tiene más de una moneda, **no se deduplica nada**.
4. El dedupe corre **antes** de `withPricing`.
5. **Preferencia por defecto: LATAM NDC directo sobre LATAM vía Sabre** — sin fee de GDS, contrato propio, ya
   construido, y con post-venta que Sabre hoy **no** cubre para NDC (N8). Sabre queda como fuente de amplitud.

### RF-07 — Revalidación de precio (carril NDC)

**Descripción.** `POST /v1/offers/price`. ATPCO y LCC **no tienen paso de price**: van de shop directo a
`createBooking`. Queda abierto si `flightCheck` sirve como equivalente para esos dos carriles (P-13).

**CA.**
1. El adapter devuelve `offers[0].id`, `offerItems[].id`, `offerItems[].passengers[].id`, **y** `ttl`,
   `offerExpirationDateTime`, `paymentTimeLimitDateTime` y `purchaseTimeLimitDateTime` — los cuatro últimos son
   requeridos por contrato (`offer-price-ndc-v1.yml:383-421`).
2. `offerItemId` es **uno por tipo de pasajero**, no por pasajero. Test con ADT+CNN que verifique 2 ítems.
3. Id expirado → `OfferExpiredError` tipado. La remediación está en el propio catálogo de errores de Sabre:
   *"Use offers/price to reprice the offer"* (`create-booking-error-list.txt:207-211`).
4. El parser acepta `paymentTimeLimitText` además del campo fechado: el contrato admite que hay proveedores que
   devuelven fechas fuera de formato.

### RF-08 — Creación de reserva con política de error explícita

**Descripción.** `POST /v1/trip/orders/createBooking`. `flightOffer` (NDC) y `flightDetails` (ATPCO/LCC) son
hermanos opcionales; cero de los 176 requests llevan ambos.

**CA.**
1. **`errorHandlingPolicy` SÍ existe en `createBooking`** — VERIFICADO-SPEC `booking-management-v1.yml:698`,
   array de `CreateErrorPolicyEnum` (`:8918`) con 8 valores y default `HALT_ON_ERROR`.
   **Esto corrige una afirmación en negrita de la primera pasada** que decía lo contrario, y cambia el diseño del
   ACL: **el éxito parcial es un modo que el cliente elige por dominio de producto ANTES de llamar**, no una
   anomalía a detectar después. Nuestro default es `HALT_ON_ERROR`; los `DO_NOT_HALT_ON_*` se activan por caso de
   uso y quedan registrados en el `domain_event`.
2. NDC: `flightOffer.offerId` + `selectedOfferItems[]` (máx. **9**) + `travelers[].id` del price.
3. ATPCO: `flightDetails.flights[]` (máx. **16**) se reconstruye **desde el modelo canónico**, no desde un blob del
   proveedor. `flightNumber` es **integer** `1..9999` (`:5174`): los 20 requests que lo mandan entre comillas violan
   el contrato.
4. Todos los índices son **1-based** (`travelerIndex`, `flightIndices`, `primaryFormOfPayment`,
   `specialServiceIndex`). Conversión en **un único punto** del ACL con test de propiedad: un off-by-one no
   revienta, **asigna el asiento al pasajero equivocado o cobra a la tarjeta equivocada, en silencio**.
5. `documents[]` es array. `title` se valida contra el enum **cerrado de 18 valores** (`:9398`) — incluye
   `Congressman`; **se adopta el enum, no se abre a string libre** (corrige la conclusión anterior).
   `expiryDate` de tarjeta tiene patrón **`YYYY-MM`** (`:5324`); `retentionEndDate` es `format: date` = **`YYYY-MM-DD`**
   (`:781`), no ISO-8601 con hora como concluyó la primera pasada.
6. **Ningún body que salga de nuestro backend contiene `cardNumber` ni `cardSecurityCode`** (RNF-06).
7. `asynchronousUpdateWaitTime` **explícito** (no el default `0`): `min 0`, `max 10000`, `:714-722`. Con el default,
   *la respuesta puede llegar antes de que la reserva esté completa*. Toda creación se cierra con `getBooking` de
   verificación.
8. **`bookingSignature` NO viene en `createBooking`** (aparece 5 veces en el contrato, ninguna en `Booking` ni en
   `CreateBookingResponse`): toda modificación posterior exige encadenar un `getBooking`.
9. `agency.futureTicketingPolicy` (`:4743`, con `ticketingPcc` y `queueNumber`) se modela desde el día 1: es el
   gancho consolidador que faltaba.

### RF-09 — Recuperación de reserva, con dos modos tipados

**Descripción.** Dos métodos con **tipos de retorno distintos**, para que el compilador impida el error:
`retrieveForDisplay` (cacheable 30-60 s, sin firma) y `retrieveForModification` (nunca cacheado, único que
devuelve `bookingSignature`).

**CA.**
1. `retrieveForDisplay` no expone `bookingSignature` en su tipo. Verificable en compilación.
   **Razón de contrato, no de estilo:** *"To obtain a valid `bookingSignature` value, you must make a Get Booking
   call **without** the `returnOnly` parameter"*. Una lectura filtrada **no sirve** como paso previo de un modify.
2. `returnOnly` acepta **31 valores** (`ReturnOnlyEnum`, `:9049-9088`, `CARS` incluido) y además evita llamadas
   downline ("significant performance boost").
3. Los cinco identificadores se modelan como campos distintos y no se confunden: `confirmationId` (PNR,
   `^[A-Z0-9]{6,}$`), `bookingId` (`^[A-Z0-9]{6,14}$`), `bookingSignature` (concurrencia), `bookingKey`
   (price-check de hotel/auto, **nada que ver** con concurrencia), `itemId` (**string** `^[A-Z0-9]+$`, no número).
4. **Perfil fijo de `extraFeatures`, definido en un solo sitio y no modificable por el camino:**
   `returnEmptySeatObjects:false` (sin esto **los flujos NDC de asientos fallan siempre**), `returnFiscalId:true`
   (es la vía natural del CPF/CNPJ/RUC/NIT — RF-21), `returnWalletFormsOfPayment:true`, `returnFrequentRenter:true`,
   `forceHotelUpdate:false`. **Debe coincidir entre el `get` y el `modify` o falla la firma.**

### RF-10 — Cancelación

**CA.**
1. Default de **nuestra** API: `HALT_ON_ERROR` (que además es el default de Sabre y **hace rollback**).
   `ALLOW_PARTIAL_CANCEL` sólo con confirmación explícita del vendedor, y en ese modo un `UNABLE_TO_CANCEL` con
   `category: WARNING` se trata como **fallo parcial**, no como aviso.
2. Cancelación NDC: sin `checkFlightTickets` previo (de donde sale `cancelOffers[].offerItemId`) el test debe
   fallar. `offerItemId` y `flightTicketOperation` son **mutuamente excluyentes**.
3. `CancelBookingResponse` = `{timestamp, request, booking, tickets[], errors[], voidedTickets[],
   refundedTickets[], flightRefunds[]}` (`:440-487`). **El resultado se audita ahí, no en el código HTTP.**
4. El estado cancelado se lee de `isCancelable`/`isTicketed` y de `flightStatusName`/`hotelStatusName`
   (`StatusNameEnum` incluye `Cancelled`), **nunca** de la desaparición del array `flights`, que es consecuencia y
   no mecanismo.
5. Sabre ya reintenta internamente ("*verification of the booking up to three times with progressive delays
   (1, 2 and 3 seconds)*"). **Nuestro retry va por encima, no lo duplica.**

### RF-11 — Emisión de billetes

**Descripción.** `POST /v1/trip/orders/fulfillFlightTickets`, camino REST único: orquesta `AirTicketRQ` por dentro
y es **la única ruta con soporte NDC**. ATPCO emite contra Price Quotes; NDC emite la orden entera.
**No es posible la emisión parcial de una orden NDC** (VERIFICADO doblemente: limitación oficial + error
`OPERATION_NOT_SUPPORTED`).

**CA.**
1. **`acceptPriceChanges: false` y `priceQuoteExpirationMethod: 'Quit'` como default global.** Los defaults de
   Sabre son permisivos (`acceptPriceChanges` viene en `true`, `priceQuoteExpirationMethod` en `'Reprice'`): sin
   enviarlos explícitos, **Sabre emite aunque el precio haya subido y sólo avisa con un warning**. Un fallo rápido
   más una re-cotización siguen cabiendo en los 2 minutos; emitir a un precio que rompe el margen, no.
2. **Criterio de éxito real:** HTTP 200 no basta. Los 7 warnings oficiales de fulfill se clasifican por severidad:
   `PARTIAL_FULFILLMENT`, `FULFILLMENT_NOT_CONFIRMED` y `UNABLE_TO_RETRIEVE_TICKETS` escalan a **NEEDS_HUMAN**
   (hay dinero cobrado sin documento); `PRICE_CHANGE` escala salvo tolerancia; `DOWNLINE_SERVICE_WARNING` se
   registra sin parsear; `EMAIL_NOT_FOUND` y `FUNCTIONALITY_NOT_APPLICABLE` son informativos — el segundo **con
   auditoría**, porque significa que Sabre ignoró en silencio algo que mandamos.
3. `formsOfPayment[]` es catálogo y `primaryFormOfPayment` es **índice 1-based** dentro de él.
4. Emisión **siempre dentro de saga durable** (RNF-11), nunca dentro del request HTTP del vendedor.
   Presupuesto de espera **declarado por contrato**: hasta **15 s** de reintento de estado de vuelo ATPCO
   (5 intentos, 1+2+3+4+5, "*regardless of whether NN is included in `haltOnFlightStatusCodes`*") **+ hasta 10 s**
   de `asynchronousUpdateWaitTime` = **25 s de esperas declaradas**. Timeout HTTP mínimo **45 s**.
5. Clave de idempotencia **propia** antes de llamar. **VERIFICADO-SPEC que no existe ninguna en el contrato**
   (`CreateBookingRequest` `:694-802` no declara campo de deduplicación y la operación `:190-213` no declara header
   de idempotencia): es ausencia real, no falta de evidencia. Mitiga parcialmente que `BOOKING_FULFILLED`
   (`APPLICATION_ERROR`) actúa como barrera del lado servidor: un reintento sobre un PNR ya emitido **falla en vez
   de duplicar**.
6. `ticketingPcc` de `FulfillTicket` (`:7965`) se persiste: es la prueba de auditoría BSP de **quién emitió** y
   cierra el bucle de conciliación del modelo consolidador.
7. **Comisión y aerolínea validadora se envían en `fulfillFlightTickets`, no en `createBooking`:**
   `validatingAirlineCode` (`:7687`) y `commissionPercentage` (`:7724`) viven en `TicketingQualifiers`, **no** en
   `PricingQualifiers`. Esto **reubica una pieza del pricing waterfall** y obliga a corregir
   `docs/platform/12-modelo-consolidador-y-plan.md` antes de que alguien implemente contra el diseño viejo.

### RF-12 — Consulta de reembolsabilidad antes de prometer

**Descripción.** `POST /v1/trip/orders/checkFlightTickets`. Máximo **12 documentos** del mismo PNR.

**CA.**
1. La UI de post-venta **no ofrece "reembolsar"** sin un `checkFlightTickets` previo.
2. **El mapper ya es escribible.** `CheckTicketsResponse` (`:660`) = `{timestamp, request, tickets[CheckedTicket],
   errors, cancelOffers, flightRefunds}`; `CheckedTicket` (`:8496`) = `Ticket` (`:6533`) + `refundFee` +
   `ticketStatusCode`, con `isVoidable`, `isRefundable`, `isChangeable`, `isAutomatedRefundsEligible`,
   `refundPenalties[]`, `exchangePenalties[]`, `refundTaxes[]` y `refundTotals`. **Era "el mayor agujero del
   análisis" y está cerrado, con ejemplo oficial completo.**
3. `refundQualifiers` es el mismo objeto en check y en refund: cotizar y ejecutar con el mismo payload.

### RF-13 / RF-14 — Void y refund

**CA.**
1. **La ventana de void se LEE, no se calcula.** Sabre la evalúa y la expone en `isVoidable` y, para NDC, en
   `cancelOffers[].offerExpirationDate` + `offerExpirationTime` **en UTC** (`:6504`, `:8890`).
   **Esto invierte la recomendación anterior:** calcularla nosotros con la zona horaria del PCC emisor pasó de
   requisito a **riesgo** (R-11). Para ATPCO Sabre no publica ni la fórmula ni un `voidableUntil`, así que la UI
   muestra **semáforo, no contador** (P-11).
2. `voidFlightTickets` **sí acepta `confirmationId`** (`:488`) y es **excluyente** con `tickets` (error
   `INVALID_FLAGS_COMBINATION`). Los billetes de papel **sólo** se anulan con `confirmationId`.
3. `overrideCancelFee` y la comisión sobre penalidad están gateados por rol (RNF-08) y emiten `domain_event` con
   actor. Límites duros del contrato: comisión ≤ 9999,99 y ≤ 99,99 %.
4. **El nombre del campo importa:** la colección manda `commissionPercent`, que **el contrato no reconoce**; es
   `commissionPercentage`. Las firmas del port se corrigen en consecuencia.
5. `errorHandlingPolicy` de fulfill **no es el mismo enum** que el de void/refund: `FulfillErrorPolicyEnum`
   (`:8637`, **array**, default `ALLOW_PARTIAL_FULFILLMENT`) vs `CancelErrorPolicyEnum` (`:8942`, **escalar**,
   default `HALT_ON_ERROR`). La primera pasada los había mezclado en una sola tabla.

### RF-15 — Reconciliación de documentos (defensa anti billete fantasma)

**CA.**
1. Máquina de estados sobre `flightTickets[].ticketStatusCode`: `TE` (billete emitido), **`TO` (billete emitido en
   contenido NDC)**, `ME` (EMD emitido), `OV` (anulado), `TR`/`MR` (reembolsado).
   **`TO` es nuevo y es crítico:** el filtro de la primera pasada (sólo `TE`/`ME`) habría dado por **no emitida
   toda orden NDC**.
2. `TicketStatusEnum` tiene sólo tres valores (`:9195`): `Issued`, `Voided`, `Refunded/Exchanged`. **Reembolso y
   reemisión comparten estado**: no se distinguen desde `ticketStatusName`.
3. Test: un timeout simulado en emisión seguido de reconciliación detecta el billete emitido y **no** reintenta.
4. Toda divergencia entre estado esperado y real emite un `domain_event` de alerta, no un log.

### RF-16 — Asientos y ancillaries (carril NDC/REST)

**CA.**
1. Reglas de negocio replicadas del script oficial: sólo `occupationStatusCode` disponible; sólo ítems elegibles
   para ese pax en ese segmento; **prohibido asignar salida de emergencia a un pax cuyo `paxType` no sea `ADT`**.
2. El número de asiento se compone de `seatRows[].row` + `seats[].column`, y `seats[].offerItemRefIds[]` enlaza con
   `offerItems[].id` (`get-seats-agency-3.0.yml:210-320`).
3. **`changeOfGaugeSeats` (`:5250-5255`)**: en vuelos con cambio de aeronave hace falta un **segundo** array de
   asientos. Llenar sólo `seats[]` deja al pasajero sin asiento en la segunda mitad, **sin error que lo delate**.
4. **`areaPreferences` es exclusivo de ATPCO** (`SeatAreaPreferenceEnum`, `:8868-8881`, 7 valores combinables hasta
   3). **En NDC no se puede pedir "ventanilla"** sin renderizar el mapa — justo al revés de lo que conviene al
   canal conversacional. Consecuencia de producto en §6.3 y **D6**.
5. Ports nuevos y separados: `SeatMapPort` y `AncillaryPort`. No se cuelgan de `OrderManagePort`.
6. **Ancillaries NDC: alcance CONDICIONADO.** El contrato de `getAncillaries` v2.3 dice que muestra
   "*free-of-charge ancillaries*" y que sus dos campos principales (`baggageGrid`, `otherBaggageCharges`)
   "*se definirán en una versión futura*". Y `createBooking` declara que "*ancillary services are currently not
   supported for NDC bookings*". **No se compromete venta de ancillaries NDC en fase 1 antes de la captura P-12.**
7. `serviceFee` es el precio **tras el markup de Sabre** y `baseFee` el anterior: **ya hay un markup del proveedor
   antes del nuestro**. El pricing waterfall se aplica encima y hay que decidir sobre cuál (P-16).

### RF-17 — Modificación de reserva sin tocar forma de pago

**CA.**
1. Bloqueo optimista obligatorio: **105 de 105 requests** envían `bookingSignature` de un `getBooking`
   inmediatamente anterior. El error de firma obsoleta es `UNABLE_TO_MODIFY_BOOKING_WRONG_SIGNATURE`
   (`APPLICATION_ERROR`) y **es el disparador del retry read-modify-write**.
2. **`modifyBooking` NO devuelve firma nueva** (`ModifyBookingResponse` `:890-914` = `{timestamp, booking, errors[],
   request}`). Consecuencia dura: **cada cambio encadenado cuesta 2 llamadas**; `retrieveBooking:true` ahorra el
   get de verificación pero no el de firma del siguiente cambio. Impacto directo en coste por transacción y en el
   diseño de la UI (guardar en bloque, no campo a campo).
3. El `after` se deriva **siempre** de un `getBooking` fresco: no es un PATCH, es un diff de documento y un campo
   omitido **se borra en silencio**.
4. Lock distribuido por `confirmationId` alrededor del par get+modify, con 2 reintentos. En el modelo consolidador
   el mismo PNR lo tocan consolidador, agencia y vendedor.
5. **Superficie modificable real:** `BookingToModify` (`:1255-1325`) tiene **12 propiedades** frente a las 32 de
   `Booking`. **Coches, trenes, cruceros, `contactInfo` y `travelersGroup` NO son modificables, sólo cancelables.**
   No es una limitación temporal: es la superficie del contrato. En el Package Studio, cambiar un auto se modela
   como **cancelar + rebookear con saga de compensación**.
6. Port nuevo `OrderModifyPort` con `supportedModifications()` declarativo. No se añade `modifyOrder()` al
   `OrderManagePort`: forzar métodos vacíos en el adapter de LATAM viola segregación de interfaces.

### RF-18 — Operación bajo PCC del consolidador (`targetPcc`)

**Descripción.** `targetPcc` es **campo del body**, no header, y está en `createBooking`, `getBooking`,
`modifyBooking`, `cancelBooking`, `fulfillFlightTickets`, `voidFlightTickets`, `refundFlightTickets` y
`checkFlightTickets`. **`modifyBooking` SÍ lo acepta** (`:873-878`) — corrige la duda de la primera pasada, que
sólo miraba los 105 requests de la colección.

**CA.**
1. **`X-Sabre-Group` (carril ATK) o `X-Sabre-Current-City` (carril ATH) son OBLIGATORIOS cuando el body lleva
   `targetPcc`**, y **no son intercambiables**: error `HEADER_DATA_MISSING_TARGET_PCC`
   (`create-booking-error-list.txt:1166-1170`). El pareo es un **invariante del ACL** con test.
2. **`targetPcc` exige autoridad previa (branch access)**, con códigos verificados:
   `UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED`, `..._NOT_ALLOWED`, `..._FINISH_IGNORE`, `..._PLEASE_WAIT`
   (`create-booking-error-list.txt:634-666`; mismos códigos en get y modify).
3. **El contexto NO se revierte** — "*The API does not revert context after completing the booking*", literal en
   `createBooking`, `modifyBooking` y `cancelBooking`. **Consecuencia no negociable: toda el área de post-venta usa
   ATK sessionless**, nunca ATH reutilizado. Con sesión compartida, la siguiente llamada apuntaría al PCC ajeno:
   en multi-tenant eso es un incidente de aislamiento esperando a ocurrir (R-08).
4. **Modelo de cuenta:** intentar **una sola** `provider_account` con `config.ticketingPcc`, y que el wizard de
   onboarding BYOC ejecute una **llamada de humo obligatoria** contra ese `ticketingPcc`; si devuelve
   `UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED`, caer automáticamente a dos cuentas (`label='default'` /
   `label='ticketing'`, que el `UNIQUE(tenant_id, provider_code, label)` ya soporta). **La verificación es un paso
   del onboarding, no un descubrimiento en producción.**
5. Nunca llamamos a `ContextChangeLLSRQ`: es orquestación **interna** de Booking Management
   (`help-documentation-create-booking.txt:45-49`). `targetPcc` es la interfaz.

### RF-19 — Capacidades declarativas por proveedor

Cada factory declara `{retrieve, cancel, pay, services, reshop, modify, ticket}`. El controller consulta el mapa en
vez de comparar contra un código de proveedor.
**CA.** `orders.controller.ts:141` deja de existir. Test: una orden Sabre pasa por `retrieve` y `cancel`, y es
rechazada **con mensaje claro** en las capacidades que Sabre no tenga (`reshop`, hoy — N8).

### RF-20 — Atribución por tenant en el PNR y en `domain_events`

En el modelo de credenciales heredadas **Sabre ve un único actor**: el consolidador. La atribución es
responsabilidad exclusivamente nuestra.
**CA.** (1) Toda reserva estampa el `tenant_id` de la agencia vendedora en el PNR (remark / accounting line / DK)
**y** en `domain_events`. (2) `orders.provider_raw` se empieza a llenar — **sin PAN/CVV**. (3) Test de
reconciliación: dado un set de `domain_events`, se reconstruye "qué vendió cada agencia" sin consultar a Sabre.
(4) `ticketingPcc` de la respuesta de fulfill se persiste junto al evento (RF-11 CA-6).

### RF-21 — Documento fiscal de la venta (DIAN / SUNAT / NF-e) — **NUEVO**

**Por qué existe.** El documento anterior tenía 20 RF y **ninguno cubría la factura**: el tema no estaba ni dentro
ni fuera del alcance. `CLAUDE.md` lista `docs/research/04-regulacion-fiscal-latam.md` como fuente de verdad
obligatoria y `providers/alegra|focus-nfe|nubefact` en la estructura target. **Emitir un billete sin resolver quién
factura qué es un bloqueante de negocio en los tres mercados.**

**Descripción.** Sabre **no** emite el documento fiscal (N9). Lo que hace RF-21 es fijar el reparto y garantizar que
los datos necesarios salen de Sabre.

**Reparto — regla de producto propuesta [DECISIÓN, ver D7]:**

| Concepto | Quién factura | Documento |
| --- | --- | --- |
| **Billete aéreo** | La **aerolínea**, contra el BSP del PCC emisor | Billete electrónico + liquidación BSP. No lo facturamos nosotros. |
| **Fee de agencia / markup del waterfall** | La **agencia vendedora** (o el consolidador, según modelo de red) | FEV-DIAN (CO) / Factura SUNAT (PE) / NFS-e **municipal** (BR). Vía `providers/alegra` \| `nubefact` \| `focus-nfe`. |
| **Void / refund** | Quien facturó el fee | **Nota crédito electrónica** referenciando el documento original. |

**CA.**
1. `credentialSource` y `FulfillTicket.ticketingPcc` determinan qué cuenta y PCC ejecutaron la operación, **no
   demuestran por sí solos quién es el emisor fiscal o quién asume ADM**. Esa asignación se configura sólo después
   de confirmación contractual escrita y se prueba por cada modelo de red.
2. Los datos que alimentan al proveedor fiscal salen de campos **verificados**: `taxes` del billete,
   `FulfillTicket.ticketingPcc` (quién emitió), `Value = {amount, currencyCode}` del importe,
   y el identificador fiscal del pasajero vía `extraFeatures.returnFiscalId` de `getBooking` (RF-09 CA-4).
3. **Corrección de una inferencia presentada como hecho:** [05](./05-get-modify-cancel-booking.md) afirmaba que
   `price.taxBreakdowns[]` es "*suficiente para la facturación DIAN/SUNAT sin llamadas extra*". **No lo es.**
   Cubre los impuestos del billete; **no cubre los datos del emisor, ni la resolución/CUFE, ni el fee de agencia**,
   que es justamente lo que facturamos nosotros. Marcado `[INFERIDO]` y degradado en ese documento.
4. **Riesgo abierto que hay que declarar:** el enum `documentSubType` de `identityDocuments` **no tiene `CPF` ni
   `CNPJ`** (declara `RUC`-Ecuador, `CUIT/CUIL`-Argentina, `NIT`-Bolivia). **Brasil no tiene salida por
   `identityDocuments`.** Fallback garantizado: el ID fiscal vive en nuestra DB y **no se propaga al PNR**;
   facturamos desde nuestro sistema (**D7**).
5. Ningún flujo de venta se da por completo hasta que existe el documento fiscal o su fallo está en cola de
   reintento con alerta. Una emisión sin factura es un incumplimiento, no un bug menor.

### RF-22 — Vinculación multi-producto sin PNR único — **NUEVO**

**Descripción.** `hotel.associatedFlightDetails` (`:5074`) y `car.associatedFlightDetails` (`:7213`) transmiten al
hotelero y a la arrendadora `arrivalAirlineCode/FlightNumber/Time` y `departure*`. Entrega el gesto de Package
Studio "el hotel con este vuelo" **con el vuelo en LATAM NDC directo**.

**CA.**
1. Cuando un paquete contiene vuelo + hotel/auto y el hotel/auto va por Sabre, el ACL **rellena siempre**
   `associatedFlightDetails` desde los segmentos canónicos del vuelo, sea cual sea su proveedor.
2. Lo que **no** se obtiene y **no se promete al cliente**: localizador único ni cancelación atómica. La UI muestra
   un itinerario unificado y N localizadores.
3. Test: un paquete con vuelo LATAM + hotel Sabre produce un `createBooking` con `associatedFlightDetails` poblado.

---

## 4. Requisitos no funcionales

### RNF-01 — Latencia y presupuesto de espera
Timeout duro de **8 s** para la rama Sabre del fan-out de búsqueda; p95 del fan-out completo ≤ **6 s**.
Las operaciones con dinero llevan timeout HTTP **≥ 45 s** por el presupuesto **declarado en contrato**: hasta 15 s
de reintento ATPCO de estado de vuelo + hasta 10 s de `asynchronousUpdateWaitTime` (`:714-722`), más latencia real.
**Corrección de procedencia:** las cifras de "15,5 s en `createBooking`" y "37 s E2E" que la primera pasada trataba
como hechos son **[TERCERO — test run de Sabre de 2021, n=1, no reproducible]** y quedan degradadas a orden de
magnitud. El sustento de la saga durable ya no es esa medición sino el contrato.
**Verificable:** histograma OTel `provider.search.duration` con label `provider=sabre`, alerta sobre p95.

### RNF-02 — Caché de búsqueda
TTL 90 s. Clave con **el set de proveedores en claro**: `search:flights:{tenantId}:{codes.sort().join('+')}:{digest}`.
**No se cachea** si algún proveedor está en `failed` o `simulated` — un fallo transitorio congelado 90 s son 3
ventanas del circuit breaker ocultando a Sabre ya recuperado. **Se cachea el `Offer[]` canónico, nunca la respuesta
cruda**, con el TTL del proveedor por oferta (`timeToLive`), no con un TTL global fijo.

### RNF-03 — Clasificación de errores y circuit breaker
**Ahora es un requisito con tabla, no una intención.** Regla nº 1, no negociable: **`res.ok` no significa éxito**.
Los contratos declaran casi sólo `200` y los fallos de negocio viajan en `errors[]`
(`booking-management-v1.yml:461-465`: "*This array is not displayed in successful responses*").

| Clase | Casos (extracto de la tabla oficial 2SG) | Política |
| --- | --- | --- |
| **REINTENTABLE (backoff ≥ 500 ms, jitter, máx. 3)** | `429 temporarily_unavailable`, `429 Active token count is exceeded`, `429 ERR.2SG.GATEWAY.REQUEST_THROTTLED`, `401 invalid_client`, `ATH_TOKEN_FAILURE` ("*Please retry the transaction*") | Reintentar. **Sólo en operaciones idempotentes** (RF-01 CA-5). |
| **NO REINTENTABLE** | `400 Invalid format`, `401 Wrong clientID or clientSecret`, `401 Credentials are missing or syntax`, `403 ERR.2SG.SEC.NOT_AUTHORIZED`, `403 SERVICE_UNKNOWN`, `404 Response does not contain any data`, `405`, `406`, `413` | Fallo terminal con mensaje accionable. **`403` de entitlement NO cuenta como fallo del proveedor ni abre circuito**: es configuración de un tenant. **`404 "no data"` tampoco** — o el breaker abre en cada ruta sin vuelos. |
| **ABRIR CIRCUITO** | `503`, `504` de inmediato; `500 ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE` de inmediato; el resto de `500` tras ≤ 2 reintentos | Breaker por **`provider_account` resuelta**, no por `providerCode`. |
| **WARNING que escala a humano** | `PARTIAL_FULFILLMENT`, `FULFILLMENT_NOT_CONFIRMED`, `UNABLE_TO_RETRIEVE_TICKETS`, `UNABLE_TO_RETRIEVE_BOOKING`, `CLOSE_SESSION_WARNING` | No reintentar. Cola `NEEDS_HUMAN` + `domain_event`. |

El "≥ 500 ms" es la **única** cifra de espera que Sabre publica y la repite en todos los casos reintentables: es
suelo, no política. **Verificable:** test con reloj falso por transición + test de que un 403-entitlement y un
404-sin-datos no incrementan el contador.

### RNF-04 — Semáforo de concurrencia
El límite de Sabre es de **CONCURRENCIA, no de TPS**: *"Maximum number of **concurrent requests** for the API has
been exceeded… contact your Sabre account manager to determine or increase your **allocated concurrent request
limit**"*. Semáforo **por `provider_account` resuelta** (varios tenants pueden compartir credencial heredada y
agotarse el cupo entre sí), **en Redis desde el primer día multi-instancia**, con el valor en
`config.maxConcurrentRequests`. Hacerlo desde el día 1 y no "cuando aparezca el problema": el fan-out escala con el
número de vendedores buscando, así que **una campaña de ventas exitosa nos throttlearía a nosotros mismos**.
**Verificable:** test que lanza N+5 búsquedas concurrentes con cupo N y verifica que nunca hay más de N en vuelo.

### RNF-05 — Aislamiento multi-tenant
La caché de instancias del factory se indexa por `ownerTenantId`, **nunca** por `tenantId`, con `evictStale` al
rotar credenciales. Y **ATK sessionless siempre** en toda operación que use `targetPcc` (RF-18 CA-3).
**Verificable:** `apps/api/src/providers/adapter-cache-isolation.test.ts` + test de aislamiento cross-tenant en CI,
que `CLAUDE.md` ya exige.

### RNF-06 — PCI (el requisito con más peso)
**Ningún body construido por nuestro backend contiene `cardNumber` ni `cardSecurityCode`, en ningún endpoint de
Sabre.** Mantiene SAQ-A, que `CLAUDE.md` declara no negociable en fase 1.
**Verificable en tres capas:** (1) test de CI que serializa los bodies de `createBooking`, `fulfillFlightTickets` y
`modifyBooking` y **falla** si aparecen esas claves; (2) el tipo `SabreFormOfPayment` **no tiene** esos campos (el
error es de compilación); (3) regla de lint que prohíbe esas cadenas literales en `providers/sabre/`.

### RNF-07 — Redacción de secretos y PII en logs
Nunca se loguean `Authorization`, `secret`, `password`, `access_token`, `BinarySecurityToken`, el sobre SOAP
completo, ni el body completo de `createBooking`/`getBooking` (hacen **eco de la request entera**, con pasaportes y
fechas de nacimiento). **El `secret` es base64 reversible, no un hash**: loguearlo equivale a loguear el password de
la oficina en claro. **Verificable:** test de CI contra un transporte de logs mock. Revisar `latam-http.client.ts`
**antes** de copiar el patrón.

### RNF-08 — Auditoría
Emiten `domain_event` con actor, tenant y payload redactado: creación, emisión, void, refund, modificación, uso de
`overrideCancelFee`, uso de comisión manual, **activación de `is_inheritable`** en una cuenta Sabre, y **todo uso de
un `DO_NOT_HALT_ON_*`** (RF-08 CA-1).

### RNF-09 — Observabilidad
Una fila en `search_logs` **por proveedor**, todas con el mismo `search_group_id`. Spans OTel por llamada con
`provider`, `endpoint`, `status`, `duration_ms`, `credential_source` y **`requestType`** (sin él, un resultado vacío
de BFM por tier no suscrito es indiagnosticable — RF-03 CA-5). Nunca el body.

### RNF-10 — Cuota horaria del tenant
La cuota cuenta **búsquedas del vendedor**, no llamadas a proveedor:
`count_recent_searches` pasa a `COUNT(DISTINCT COALESCE(search_group_id, id))`. Sin esto, 600/h se convierte en 300
al sumar Sabre **y el mensaje de error miente sobre el número**, así que nadie lo diagnostica.

### RNF-11 — Durabilidad de las operaciones con dinero
`createBooking`, `fulfillFlightTickets`, `voidFlightTickets` y `refundFlightTickets` corren en saga durable con
clave de idempotencia propia, reconciliación por `getBooking` como actividad y compensación explícita.
**Nunca en un `try/catch` dentro del handler HTTP.** El sustento es de contrato (RNF-01), no una medición ajena.
**Verificable:** test que mata el worker a mitad de la emisión y verifica que al reanudar **reconcilia** en vez de
reemitir.

### RNF-12 — Vencimiento de ofertas
`Offer.expiresAt` refleja el TTL real del proveedor (`timeToLive`/`ttl`, **requeridos por contrato**). Id expirado →
`OfferExpiredError` + re-shop con **confirmación explícita del vendedor si el precio cambió**, y aviso en la UI al
**75 % del TTL**. Ataca el escenario más probable en venta por WhatsApp: el vendedor cotiza, el cliente responde 40
minutos después, la oferta murió.

### RNF-13 — Degradación parcial nunca silenciosa
Si Sabre no respondió, el vendedor **lo ve en pantalla**. Un vendedor que dice "no hay más vuelos" cuando Sabre no
respondió es peor que un error visible.

### RNF-14 — Cobertura y red de seguridad previa
`apps/api/src/search/` **no tiene un solo test hoy** y es el código que genera todos los ingresos. Los tests de
comportamiento actual se escriben **antes** del refactor. Se añade `vitest.config.ts` con `coverage.thresholds`
(>70 % en `domain/` y `providers/sabre/`, >50 % global): hoy los umbrales de `CLAUDE.md` no se aplican en ninguna
parte.

### RNF-15 — Specs versionados y tests de contrato — **NUEVO**
Los 19 `.yml` se **commitean** en `providers/sabre/spec/` con su `info.version` pineado, y CI falla si el schema
generado diverge. Razón: **Booking Management publica una versión cada 2-3 meses** (34 releases, 1.0 en abr-2020 →
1.33 en jul-2026) y **el propio corpus creció de 15 a 21 specs mientras se escribían estos documentos**. Sin pineo,
el contrato cambia bajo los pies y los tests de contrato dejan de ser reproducibles.

---

## 5. Requisitos de datos

### 5.1 Credenciales BYOC — `provider_code = 'sabre'`

`credentials` (**cifrado AES-256-GCM**, nunca sale por API):

```json
{ "epr": "500001", "password": "********", "clientId": null, "clientSecret": null }
```

`clientId`/`clientSecret` quedan reservados por si algún día aparece `/v3/auth/token` (hoy **los 21 contratos
apuntan sólo a v2**). **No se persiste el `secret` derivado.**

`config` (claro, auditable desde la UI):

```json
{
  "environment": "cert",
  "restEndpoint": null, "soapEndpoint": null,
  "homePcc": "U9PK", "ticketingPcc": "7KFA",
  "agencyIata": "76512345",
  "domain": "AA",
  "applicationId": null,
  "requestType": "50ITINS",
  "maxConcurrentRequests": null,
  "automatedRefundsEnabled": false,
  "printerHardcopyLniata": null, "printerCountryCode": "CO",
  "sabreGroup": null, "sabreCurrentCity": null,
  "tokenTtlSeconds": 3600,
  "mock": false
}
```

Cambios respecto de la versión anterior, cada uno con su razón:

- **`ticketingPccTimezone` ELIMINADO.** La ventana de void **se lee de Sabre** (`isVoidable`,
  `offerExpirationTime` en UTC), no se calcula. Mantener el campo invitaba a calcularla mal.
- **`applicationId` AÑADIDO.** `Application-ID` es parámetro opcional **recomendado** en hotel y vehículo
  ("*work with your account manager to generate one*"). No lo tenemos (P-20).
- **`requestType` AÑADIDO.** Es un **tier contratado**; pedir uno no suscrito devuelve cero resultados sin error.
  No puede estar hardcodeado.
- **`maxConcurrentRequests` AÑADIDO.** El cupo de concurrencia es contractual por cuenta (RNF-04).
- **`automatedRefundsEnabled` AÑADIDO.** El reembolso automatizado requiere activación **por PCC** en Sabre Central;
  con BYOC eso es una activación por agencia. La UI **oculta** el botón de reembolso cuando es `false`, en vez de
  dejar que el vendedor descubra el `UNAUTHORIZED` delante del cliente.

**`homePcc` va en `config`, no en `credentials`**, aunque forme parte del `clientId`: un PCC no es secreto (se
imprime en el billete), la migración `0012` ya lo documenta ahí, y la UI necesita mostrarlo.

**La bóveda debe modelar desde ya las DOS formas de credencial** (OAuth2 REST y `username/password/PCC` LLS),
aunque sólo se rellene la primera: cambiar el esquema de la bóveda después es caro y el carril SOAP no está
descartado para siempre (N1).

**Riesgo a cerrar en el mismo PR:** `red/page.tsx:607` hace `PROVIDERS[code] ?? LATAM_NDC`. Un code desconocido
presenta el formulario de LATAM y el operador guardaría `apiKey`/`apiSecret` bajo un `provider_code` que nadie lee:
la cuenta parecería configurada y el proveedor correría en modo mock silencioso. Debe ser un error explícito.

### 5.2 Estado efímero entre pasos de venta

| Dato | Nace en | Muere | Dónde vive |
| --- | --- | --- | --- |
| `access_token` (ATK) | `/v2/auth/token` | `expires_in` de la respuesta (ejemplo oficial 604800 s) | Port de caché (Redis), `sabre:atk:{ownerTenantId}:{pcc}` |
| `offer.timeToLive` (shop) | shop | **segundos, campo requerido** | `Offer.expiresAt` |
| `offer.ttl` + `offerExpirationDateTime` (price) | price | **requeridos; ~20 min en el ejemplo oficial** | `Offer.expiresAt` + `Offer.provider.raw` |
| `paymentTimeLimitDateTime` / `purchaseTimeLimitDateTime` | price | del proveedor | Saga de checkout (deadline duro) |
| `confirmationId` (PNR) | createBooking | permanente | `orders.provider_order_id` |
| `bookingSignature` | **sólo** `getBooking` sin `returnOnly` | al siguiente write | **Nunca cacheado.** Empaquetado con el perfil de `extraFeatures` en un `OrderVersionStamp` (viajan inseparables o falla la firma) |
| `cancelOffers[].offerItemId` + `offerExpirationTime` (UTC) | checkFlightTickets | corto, publicado por Sabre | Saga de cancelación |

**Decisión de modelado:** *no* crear tabla `provider_offers`. La caché de búsqueda ya guarda las Offers y
`expiresAt` las hace inmutables con TTL. Se revisa **sólo** si el sandbox demuestra que los ids expiran más rápido
que el flujo de venta.

### 5.3 Cambios de esquema en `db/`

Migración `00XX_multi_flight_provider.sql` ([08 §4.2](./08-seams-integracion-repo.md)):

1. `ALTER TABLE orders ALTER COLUMN provider DROP DEFAULT;` — con dos proveedores, un INSERT que olvide `provider`
   ya no puede asumir LATAM en silencio.
2. `ALTER TABLE search_logs ADD COLUMN search_group_id UUID;` + índice parcial + `count_recent_searches` por grupo.
3. `CREATE TABLE provider_catalog (...)` — tabla **global**, sin `tenant_id` ni RLS: es catálogo de plataforma.
   Reemplaza los tres mapas hardcodeados de `reports.service.ts:49`, `red/page.tsx:111` y `CarterasClient.tsx:517`.
4. **BLOQUEANTE DEL PACKAGE STUDIO — `ALTER TABLE package_items ALTER COLUMN provider_item_id TYPE TEXT;`**
   `db/migrations/0010_sprint1_core_suite.sql:99` lo declara `VARCHAR(200) NOT NULL`, y el `offerRef` compuesto de
   Sabre llega a **526 caracteres** en el peor caso (`offerId` de 49 + hasta 9 `offerItemId` de 52 —
   `booking-management-v1.yml:4962`, `offer-price-ndc-v1.yml:190`) y **227 en el caso típico**.
   **En el mismo PR** hay que subir el borde Zod: `apps/api/src/packages/packages.schemas.ts:21`,
   `.max(200)` → `.max(2000)`; si sólo se toca el SQL, el 400 sigue apareciendo antes de llegar a Postgres.
   **Se hace ahora, no en la Ola 2** (D8): hoy es un `ALTER` que en Postgres 16 no reescribe la tabla ni reindexa
   (no hay índice sobre esa columna) y la tabla está casi vacía sin front-end; después es una migración con datos de
   producción de "el corazón del producto", y el síntoma es *"el vuelo de Sabre no se puede agregar al paquete:
   String too long"*.
   **Regla que acompaña al cambio:** `provider_item_id` es la **clave** para volver a pedirle el ítem al proveedor;
   si el proveedor no da clave y hay que reconstruir el producto entero (ATPCO/LCC, hasta 16 vuelos), eso va en
   `raw_details JSONB` (`0010:100`), **no en la columna**.

**`provider_accounts` no se toca:** `provider_code` es `TEXT` sin CHECK ni FK, `config JSONB` está documentado para
PCC/IATA/endpoints, y `resolve_provider_account()` ya es genérica.

### 5.4 Cambios en el modelo canónico

Todos **aditivos**, para no romper la validación de borde:

```ts
// packages/canonical/src/offer.ts
source?: 'ATPCO' | 'LCC' | 'NDC';   // discriminador REQUERIDO por Sabre. Sin él no hay dedupe (RF-06)
// ProviderRefSchema
raw: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
// Ids CRUDOS del proveedor, opacos para el dominio. NUNCA leerlos desde packages/domain ni desde apps/.

// packages/canonical/src/segment.ts
operatingFlightNumber?: string;   // ya viene de Sabre (v5.yml:2908) y hoy lo tiramos. Dedupe de codeshares

// packages/domain/src/ports/order-create.port.ts — Passenger
providerPaxId?: string;           // id de pasajero EMITIDO por el price de Sabre
```

**Se descarta** empaquetar la referencia de Sabre como JSON dentro del string de `offerRef`: es exactamente el
anti-patrón que `CLAUDE.md` prohíbe (tipos de proveedor filtrándose al dominio). El sustituto correcto son campos
canónicos explícitos, que además dan sitio a `distributionModel` y `lastTicketDate`, que hoy también tiramos.

**Refactor del puerto `order-create.port.ts` — antes de escribir el ACL, no después.** El booleano `success`
miente en los dos sentidos ahora que el éxito parcial es un modo declarado del proveedor
(`errorHandlingPolicy` con 6 valores `DO_NOT_HALT_ON_*`). Pasa a `OrderCreateOutcome` + `OrderItemResult` +
`ProviderIssue`. Hacerlo después obliga a tocar también `latam-ndc`.

---

## 6. Contrato de integración con la plataforma

### 6.1 Entrada al fan-out de búsqueda
`SearchService` consulta `FlightProviderRegistry.forTenant(tenantId)`, que devuelve `ResolvedProvider[]` en **orden
estable** (alfabético por code — el orden es parte de la clave de caché). Un proveedor está habilitado si
`resolve_provider_account` devuelve fila `active`, **o** si su code está en `PLATFORM_DEFAULT_FLIGHT_PROVIDERS`.
Esa variable vale `latam-ndc`: **Sabre no tiene fallback a credenciales de plataforma** (D5).

> **Nota de UI a cerrar en el mismo PR:** la pantalla de red crea cuentas con `status: 'sandbox'` y
> `resolve_provider_account` exige `'active'`. Hoy una cuenta cargada desde la UI **no habilita nada** hasta que
> alguien la promueve, sin ningún mensaje que lo explique.

**Pendiente estructural:** el registry asume **una cuenta por (tenant, provider)**, pero `provider_accounts` soporta
varias vía `label` y el PCC **es la unidad de sesión y de cupo del lado de Sabre**. Si un consolidador opera varios
PCC a la vez, `ResolvedProvider.code` tiene que volverse `code+label`, y eso cambia circuit breaker, clave de caché
y `search_logs.provider_code` (P-09).

### 6.2 Pricing waterfall
El waterfall (override consolidador + markup agencia + comisión vendedor) opera sobre `Offer.total` **antes** de
cualquier fee de forma de pago. Es contable interno y **no es lo mismo** que la comisión BSP que la aerolínea
reconoce contra el PCC emisor: son dos circuitos de liquidación y mezclarlos rompe la conciliación BSP.

Dos correcciones que obligan a actualizar `docs/platform/12-modelo-consolidador-y-plan.md`:

1. **La comisión y la aerolínea validadora se envían en `fulfillFlightTickets`, no en `createBooking`**
   (RF-11 CA-7). Quien implemente contra el diseño viejo descubrirá que `commissionPercentage` se ignora.
2. **Sabre ya aplicó su propio markup antes que nosotros** en ancillaries: devuelve `serviceFee` (tras markup) y
   `baseFee` (antes). Hay que decidir sobre cuál aplicamos el nuestro (P-16).

**Consecuencia del modelo de credenciales:** si la agencia usa su propio PCC (modelo B), el neto **no pasa por el
consolidador** y no hay base para su override. El waterfall tiene que conocer el `credentialSource` de la oferta o
cobrará un override que nadie va a liquidar.

### 6.3 Cotizaciones y paquetes
Las ofertas Sabre entran a cotizaciones como cualquier otra. **Pero `Offer.expiresAt` deja de ser decorativo**: en
cotizaciones por WhatsApp la UI muestra el vencimiento y ofrece re-cotización con un clic (RNF-12).

**Package Studio — qué se promete y qué no:**

- **SÍ:** itinerario unificado en nuestra UI con `associatedFlightDetails` poblado (RF-22). El hotel sabe la hora de
  llegada, la arrendadora sabe el vuelo, el cliente ve un solo viaje.
- **NO (todavía):** "paquete en un solo PNR". No porque sea imposible —la premisa anterior era falsa (N4)— sino
  porque hoy exige el carril SOAP y consolidar el cobro por vertical en uno solo. **Es un spike, no un imposible.**
- **Cambio de auto/tren/crucero** dentro de un paquete se modela como **cancelar + rebookear con compensación**:
  `BookingToModify` no los declara (RF-17 CA-5).
- **Venta de asiento por el canal conversacional:** en NDC **no existe preferencia de área**, hay que devolver un
  `seatOfferId` de una celda concreta (RF-16 CA-4). El bot manda un enlace a un mapa mobile-first; el atajo
  "acepto 'ventanilla' y elijo yo" **sólo si se etiqueta explícitamente como elección nuestra en la conversación**,
  nunca en silencio (**D6**).

### 6.4 Órdenes y post-venta
`orders.provider` se llena desde `dto.offer.provider.name`; `orders.service` y `orders.controller` enrutan por
`registry.byCode`. **Tres bugs latentes que estallan el día 1 de Sabre y deben arreglarse en el mismo PR que habilita
Sabre en búsqueda** (verificados contra el repo @ `c39ac93`):

1. `apps/api/src/search/search.service.ts:114` (`priceOffer`) ignora `offer.provider.name` y va siempre a LATAM.
2. `apps/api/src/orders/orders.service.ts:138` (`createOrder`) ídem, y **`:162` hardcodea `provider: 'latam-ndc'`**
   en el INSERT.
3. `apps/api/src/orders/orders.controller.ts:141` (`assertSupportsLatamOps`) bloquearía **toda** operación de
   post-venta de una orden Sabre.

### 6.5 CRM y datos de viajero — **NUEVO**

**Regla:** el maestro del dato de pasajero es **nuestro** `apps/api/src/customers/` (PII cifrada, RLS, dedup,
migraciones `0018`/`0034`). **Sabre Profiles queda fuera** (N6) y en `createBooking` los `travelers[]` se envían
**inline desde nuestro CRM**, nunca por `profiles[].uniqueId`.

**Consecuencia explícita, para que sea una decisión y no un descuido:** perdemos el autofill corporativo de Sabre
(perfiles TVL con `domainId = PCC`), y a cambio evitamos **un segundo almacén de PII fuera de nuestro perímetro
RLS** — que en BYOC estaría además bajo el PCC del consolidador, es decir, PII de clientes de la agencia A visible
desde el dominio del consolidador. No compensa.

`apps/api/src/crm/` es **agnóstico de proveedor** y no requiere cambios: en sus 8 archivos la palabra `provider`
sólo aparece como la clave `providers:` del decorador `@Module`, y `crm_opportunities.order_id` referencia `orders`
por UUID, así que hereda el cambio de `orders.provider` sin código nuevo.

### 6.6 Facturación fiscal — **NUEVO**

RF-21 fija el reparto. El contrato con la plataforma es:

- El flujo de emisión **emite un `domain_event` de "venta liquidable"** con `{tenantId, credentialSource,
  ticketingPcc, importes por concepto, moneda, identificador fiscal del pasajero}`. Ese evento es la entrada única
  del módulo fiscal; el módulo fiscal **no llama a Sabre**.
- Void y refund emiten el evento espejo, que produce **nota crédito**.
- El proveedor fiscal se resuelve por país del emisor: `alegra` (CO), `nubefact` (PE), `focus-nfe` (BR, con la
  complicación de que la NFS-e es **municipal**: 5.570 sistemas posibles —
  ver `docs/research/04-regulacion-fiscal-latam.md` §2.1).
- **Ningún flujo se cierra sin documento fiscal o sin fallo encolado con alerta.**

---

## 7. Matriz de trazabilidad

| Req | Documento fuente | Evidencia | Estado |
| --- | --- | --- | --- |
| RF-01 | [01 §2, §5, §7](./01-autenticacion-y-conectividad.md) | 59 requests + `securityDefinitions` en los 21 specs + tabla 2SG | **VERIFICADO-SPEC** / valor real de `expires_in` DESCONOCIDO |
| RF-02 | [01 §8](./01-autenticacion-y-conectividad.md), [08 §4.1](./08-seams-integracion-repo.md) | `db/migrations/0012` leída | **VERIFICADO** (schema propio) |
| RF-03 | [02 §3-§6](./02-air-shop-bfm.md) | 88 bodies + `bargain-finder-max-v5.yml` | **VERIFICADO-SPEC** |
| RF-04 | [02 §7](./02-air-shop-bfm.md) | Mapa de campos + **3 ejemplos oficiales completos** | **VERIFICADO-SPEC** — deja de ser bloqueante |
| RF-05 | [08 §2](./08-seams-integracion-repo.md) | Código del repo con archivo:línea | **VERIFICADO** |
| RF-06 | [02 §9](./02-air-shop-bfm.md), [09 §7.2](./09-referencia-externa-y-gaps.md) | `Offer.source` requerido; `MultipleSourcePerItinerary` y su default | **VERIFICADO-SPEC** / clave de producto PROPUESTA |
| RF-07 | [03 §2-§3](./03-offers-price-asientos-ancillaries.md) | `offer-price-ndc-v1.yml` + 5 respuestas de ejemplo | **VERIFICADO-SPEC** |
| RF-08 | [04](./04-create-booking.md) | 176 requests + `booking-management-v1.yml` (270 defs) + ~180 errores | **VERIFICADO-SPEC** |
| RF-09 | [05 §3, §5](./05-get-modify-cancel-booking.md) | 204 getBooking + modelo `Booking` de 32 propiedades | **VERIFICADO-SPEC** |
| RF-10 | [05 §6](./05-get-modify-cancel-booking.md) | 43 requests + `CancelBookingResponse` `:440-487` | **VERIFICADO-SPEC** |
| RF-11 | [06 §1-§3](./06-ticketing-void-refund.md) | 19 fulfill + `FulfillTicketsResponse` `:1022` + 7 warnings oficiales | **VERIFICADO-SPEC** |
| RF-12 | [06 §4](./06-ticketing-void-refund.md) | `CheckTicketsResponse` `:660` + ejemplo oficial | **VERIFICADO-SPEC** — era el mayor agujero, cerrado |
| RF-13/14 | [06 §5-§6](./06-ticketing-void-refund.md) | `isVoidable`, `cancelOffers[].offerExpirationTime` (UTC) | **VERIFICADO-SPEC** / regla ATPCO DESCONOCIDA |
| RF-15 | [06 §9-§10](./06-ticketing-void-refund.md) | `TicketStatusEnum` `:9195` + código `TO` | **VERIFICADO-SPEC** |
| RF-16 | [03 §4-§5](./03-offers-price-asientos-ancillaries.md) | `get-seats-agency-3.0.yml`, `get-ancillaries-agency-2.3.yml` | **VERIFICADO-SPEC** / versión a usar DESCONOCIDA (P-06); utilidad real de ancillaries NDC DESCONOCIDA (P-12) |
| RF-17 | [05 §4-§5](./05-get-modify-cancel-booking.md) | 105/105 con firma + `BookingToModify` `:1255-1325` | **VERIFICADO-SPEC** |
| RF-18 | [01 §4.4-§4.5](./01-autenticacion-y-conectividad.md) | `targetPcc` en 8 operaciones + 4 errores de branch access | **VERIFICADO-SPEC** / autoridad concreta de nuestro EPR DESCONOCIDA (P-10) |
| RF-19 | [08 §1.3](./08-seams-integracion-repo.md) | `orders.controller.ts:141` | **VERIFICADO** |
| RF-20 | [01 §9](./01-autenticacion-y-conectividad.md), [06](./06-ticketing-void-refund.md) | `FulfillTicket.ticketingPcc` `:7965` | **VERIFICADO-SPEC** (el mecanismo) / política de atribución PROPUESTA |
| RF-21 | `docs/research/04-regulacion-fiscal-latam.md`, [05](./05-get-modify-cancel-booking.md), [06](./06-ticketing-void-refund.md) | `extraFeatures.returnFiscalId`; enum `documentSubType` **sin CPF/CNPJ** | **INFERIDO** — reparto es decisión (D7); la ausencia de CPF/CNPJ es VERIFICADO-SPEC |
| RF-22 | [07 §6.5](./07-hoteles-y-autos.md) | `AssociatedFlightDetails` `:3183`, `:5074`, `:7213` | **VERIFICADO-SPEC** |
| RNF-01 | [04 §5](./04-create-booking.md), [09 §4.2](./09-referencia-externa-y-gaps.md) | Retry ATPCO 1+2+3+4+5 s + `asynchronousUpdateWaitTime` `:714-722` | **VERIFICADO-SPEC** / cifras de 2021 degradadas a **[TERCERO]** |
| RNF-03 | [01 §5](./01-autenticacion-y-conectividad.md), [09 §2](./09-referencia-externa-y-gaps.md) | Tabla 2SG oficial + 746 filas de `category`/`type` | **VERIFICADO-SPEC** |
| RNF-04 | [09 §4.1](./09-referencia-externa-y-gaps.md) | `help/errors.txt:201,213` (concurrencia, no TPS) | **VERIFICADO-SPEC** (existe) / **cifra DESCONOCIDA** (contractual, P-02) |
| RNF-06 | [04 §6](./04-create-booking.md), [06 §2.3](./06-ticketing-void-refund.md) | **49**+15 requests con PAN, **46**+12 con CVV, **cero** con token | **VERIFICADO** (reconteo publicado en §8) |
| RNF-15 | [09 §1](./09-referencia-externa-y-gaps.md) | 34 releases de Booking Management; corpus 15 → 21 specs | **VERIFICADO-SPEC** |
| RNF-02/05/07/08/09/10/11/12/13/14 | [08](./08-seams-integracion-repo.md) | Código del repo | **VERIFICADO** |

---

## 8. Preguntas abiertas consolidadas

Deduplicadas de las ~120 de los once análisis. **Criterio de prioridad corregido: P0 = bloquea la decisión de
invertir**, no sólo "bloquea escribir código". Con el criterio anterior, las cuatro preguntas que deciden si el
producto es viable estaban en P2.

> **Numeración reconciliada.** `11-plan-implementacion.md` ya usa **P-05** para las credenciales y **P-01** para el
> fee por transacción. Las referencias de ambos documentos están alineadas en el cierre del 25 de agosto de 2026.

### P0 — Bloquean la decisión de invertir

| # | Pregunta | Cómo se resuelve | Qué decide |
| --- | --- | --- | --- |
| **P-01** | **¿Cuál es el fee por transacción, y se tarifa por búsqueda, por `RequestType` o por reserva?** BFM está marcado **`premium`** en el catálogo de Sabre | Account manager, por escrito | **Un fee por búsqueda mal negociado hace inviable el modelo entero**: la búsqueda es alto volumen y baja conversión. Es la entrada de la compuerta Go/No-Go |
| **P-02** | **¿Permite Sabre que un consolidador opere múltiples PCC de terceros bajo un mismo contrato técnico, y en qué condiciones se concede el *branch access*?** (quién lo solicita, plazo, coste por agencia, límite) | Account manager, por escrito | **Decide si nuestro BYOC es viable con Sabre tal como está diseñado.** Sin esto no hay red de agencias |
| **P-03** | **¿Acepta la aerolínea NDC una forma de pago sin PAN (CASH / ON_ACCOUNT / VIRTUAL_CARD) y la liquida por BSP?** | Account manager + una llamada a CERT | Determina si **D1** es implementable o hay que cambiar de estrategia de cobro. Ver la refutación de evidencia más abajo |
| **P-04** | **¿Qué cobertura NDC real hay en CO/PE/BR — Copa, Gol, Azul incluidas — y qué aporte incremental da Sabre sobre LATAM NDC directo?** | 20-30 búsquedas contra CERT (§2.3) + account manager | **Es la métrica de valor esperado.** Sin ella, las fases 1-4 son una apuesta de ~50 d-p |
| **P-05** | **¿Qué credencial nos entrega el cliente?** | **RESUELTA 2026-08-25:** EPR+PCC+password disponibles fuera de Git; falta inyección segura y smoke test | Desbloquea el arranque de CERT |
| **P-06** | ¿Qué entitlements tiene nuestro PCC de CERT (BFM y su tier, Offers Price, Booking Mgmt, Get Seats, Get Ancillaries, Manage Ancillary, Automated Refunds)? | Smoke test: un request por familia. `403 ERR.2SG.SEC.NOT_AUTHORIZED` lo revela al instante | El alcance real de §2.1 |
| **P-07** | ¿Decidimos **nunca** mandar PAN? (**D1**) | Decisión del founder | RF-08, RF-11, RF-17, todo el checkout |

> **Refutación de evidencia sobre P-03 — importa porque el crítico concluyó lo contrario.**
> Es cierto que existen 29 requests con `"type": "CASH"` y 6 de ellos son `fulfillFlightTickets`. Pero al abrir los
> bodies: los **ATPCO** (`Workflows / 26`, `Workflows / 27`, `Generic Examples / Printer profile`) mandan
> `primaryFormOfPayment: 1` apuntando a `CASH` — **emisión ATPCO sin PAN, VERIFICADA end-to-end**. Los dos **NDC**
> (`FulfillFlightTickets / Basic flow NDC / … / AA` y `Workflows / 14`) llevan `CASH` en el array pero seleccionan
> **`primaryFormOfPayment: 2`, que es el `PAYMENTCARD`**. Es decir: **no hay ni un solo ejemplo de emisión NDC
> pagada sin tarjeta.** Lo que sí está verificado por contrato es que la **forma** lo permite:
> `FulfillFormOfPaymentTypeEnum` (`booking-management-v1.yml:8659`) incluye `CASH`, `CHECK`, `INVOICE`,
> `ON_ACCOUNT`, `MISCELLANEOUS`, `VIRTUAL_CARD` e `INSTALLMENTS` (este último, "*parcelado*" de BSP Brasil, es una
> capacidad de venta real en nuestro mercado que hoy no está en el roadmap). **P-03 queda entonces partida en dos:
> la pregunta técnica está respondida (el API acepta el body); la pregunta comercial —¿la aerolínea liquida así?—
> sigue abierta y es la que bloquea.**

### P1 — Bloquean el diseño (se puede empezar, pero rehacer sale caro)

| # | Pregunta | Impacto |
| --- | --- | --- |
| **P-08** | ¿Cuál es el **valor real** de `expires_in` y hay límite de creación de tokens? La forma está verificada (`604800` en el ejemplo oficial) pero es un ejemplo | Dimensiona la caché. Se cierra con la primera llamada real |
| **P-09** | ¿El cupo de concurrencia se asigna por PCC o por contrato? ¿Y las sesiones que la propia API REST abre internamente (`ATH_TOKEN_FAILURE`) consumen del mismo cupo? | RNF-04. Si es por contrato, las agencias con credencial heredada se agotan el cupo entre sí. Y si un consolidador opera N PCC, `ResolvedProvider.code` debe volverse `code+label` (§6.1) |
| **P-10** | ¿Qué autorización de EPR hace falta para `targetPcc`, y cómo se sanea el contexto (el contrato dice que **no se revierte**)? | RF-18: una `provider_account` o dos, y si el saneo con ATK sessionless basta |
| **P-11** | ¿Cuál es la regla exacta de la ventana de void para **ATPCO**? Sabre la valida y la expone como `isVoidable` pero no publica fórmula ni `voidableUntil` | Sin esto la UI muestra semáforo, no contador |
| **P-12** | ¿Devuelve `getAncillaries` v2.3 algo vendible hoy, o está esperando a `baggageGrid`? El contrato dice que muestra "*free-of-charge ancillaries*" | Decide si hay venta de ancillaries NDC en fase 1 (RF-16 CA-6) |
| **P-13** | ¿Sirve `flightCheck` como equivalente del price para ATPCO y LCC? Ninguno de los 1.077 requests lo usa | Eliminaría la asimetría de que ATPCO/LCC van a `createBooking` sin revalidar |
| **P-14** | ¿`params.formOfPayment` es obligatorio en `/v1/offers/price`? | Si lo es, el BIN entra al flujo **antes** de reservar y roza SAQ-A (**D3**) |
| **P-15** | ¿Se puede reconciliar un `createBooking` cuyo HTTP se cortó? No hay idempotency key y `getBooking` exige `confirmationId`, justo el dato que falta | Diseño de la saga. ¿Sirve `notification.queuePlacement` para que el PNR huérfano caiga en una cola drenable? |
| **P-16** | ¿Sobre qué precio aplicamos el markup en ancillaries, `baseFee` o `serviceFee`? Sabre ya aplicó el suyo | Pricing waterfall (§6.2) |
| **P-17** | ¿Qué API de Sabre crea el **PQR** (Price Quote Reissue)? | Es el único eslabón que falta para el cambio voluntario (N8). Pregunta al account manager, no capturable |
| **P-18** | ¿Funcionan los tipos de infante en NDC? Conflicto entre dos fuentes oficiales: el error `TRAVELER_TYPE_NOT_SUPPORTED` dice que no, y la colección ejercita `INS` en NDC con AY | Reservas familiares por NDC |

### P2 — Bloquean el negocio pero no la decisión de invertir

| # | Pregunta | A quién |
| --- | --- | --- |
| **P-19** | ¿Plazo real de alta productiva? Las fuentes se contradicen: "7-21 días" vs "certificación 4-8 semanas" | Account manager |
| **P-20** | ¿Nos asignan un `Application-ID`? El contrato lo recomienda en hotel y vehículo y no lo tenemos | Account manager |
| **P-21** | ¿La agencia tiene IATA/ARC propio? | Decide el modelo de red por defecto (**D4**) |
| **P-22** | ¿Existe tokenización nativa (`FulfillFormOfPayment.referenceId`, la "*stored wallet form of payment*") y cómo entra una tarjeta en ese wallet? Si el alta exige que nosotros enviemos el PAN alguna vez, la vía no sirve para SAQ-A | Account manager |
| **P-23** | ¿Cómo se aprovisiona `VIRTUAL_CARD` — lo emite Sabre o hay que traer una VCC externa (Conferma/WEX)? | Account manager |
| **P-24** | ¿Qué cobertura NDC LATAM y qué contratos públicos tienen **Amadeus** y **Travelport**? **No verificado con el mismo rigor que Sabre** | Investigación propia — bloquea **D0** |

### P3 — Detalles que se cierran con la captura

`Domain` `AA` vs `DEFAULT` (ningún spec lo menciona); qué son `SBR-BMAPI` / el `ClientSecret` fijo original en el `UsernameToken`;
formato del teléfono de agencia de AF; `ResBookDesigCode` en v5; si `CabinPref.PreferLevel 'Preferred'` filtra o
sólo ordena; `ptrta` vs `hardcopy` (0 usos en 1.077 requests); techo real de `retentionEndDate`; `flightCoupons` vs
`allCoupons`; si las categorías compuestas (`CANCELLATION_ERROR/WARNING`) llegan literalmente así en el payload;
si `obFees[]` está sumado dentro de `totalPrice` o es aditivo; techo real de pasajeros de un grupo
(getAncillaries admite 99, price 9, createBooking 9).

---

## 9. Decisiones que necesita tomar el founder

### D0 — ¿Sabre, Amadeus Enterprise o Travelport como segundo source aéreo?

Este expediente asume Sabre desde la primera línea. **Eso es un sesgo, no una decisión.**
[09 §6](./09-referencia-externa-y-gaps.md) compara los tres y recomienda evaluar Amadeus, y esa recomendación
desapareció de la síntesis sin un solo argumento en contra. **Elegir GDS es una decisión de años, con coste de
integración de meses y coste de salida altísimo.**

- **(A) Comprometerse con Sabre ya.** *A favor:* cobertura NDC LATAM **verificada documentalmente** (LATAM feb-2025
  en CO/PE/BR, Avianca desde 2022, 34 aerolíneas), documentación excepcional (21 specs + 81 páginas + 746 filas de
  errores catalogadas = semanas de integración ahorradas), y `targetPcc` que es **exactamente** el primitivo del
  modelo consolidador, en contrato y no en promesa. *En contra:* precio opaco sobre el endpoint de más volumen
  (BFM `premium`), certificación 4-8 semanas + branch access por agencia, **post-venta NDC inexistente** (Flight
  Reshop beta y sólo ATPCO), y dos sistemas de credenciales.
- **(B) Evaluar Amadeus Enterprise por la vía comercial.** Amadeus Self-Service fue descontinuado el
  **17-jul-2026**, por lo que ya no existe el precio pay-as-you-go ni el onboarding instantáneo que sustentaban la
  recomendación anterior. *A favor:* mantiene a un segundo GDS en la comparación. *En contra:* precio, acceso,
  certificación, cobertura NDC LATAM y modelo consolidador están todos por verificar.
- **(C) No abrir segundo source todavía** y consolidar los compromisos abiertos de Ola 1 (pagos, fiscal, IA
  WhatsApp, Package Studio). *A favor:* es la opción con mejor coste de oportunidad si el aporte incremental de
  §2.3 resulta bajo. *En contra:* "contenido unificado en una sola plataforma" es lo que >80 % de las agencias
  piden; llegar tarde tiene coste comercial.

> **Recomendación actualizada:** ejecutar primero la compuerta de §2.3 contra Sabre CERT, porque las credenciales ya
> están disponibles, y abrir en paralelo solicitudes comerciales a Amadeus Enterprise y Travelport. No existe ya
> una alternativa Self-Service barata que permita resolver D0 sin contrato. Si el aporte incremental supera el
> umbral y el fee/branch access de Sabre es aceptable, Sabre pasa el Go/No-Go; si no, se comparan las propuestas
> Enterprise con el mismo rigor.
> **Advertencia de honestidad:** la comparación es hoy **asimétrica** — Sabre está investigado a fondo y los otros
> dos no. Antes de firmar cualquiera, hay que bajar los specs y las listas de errores de Amadeus con el mismo rigor.

### D1 — Cómo se paga una reserva Sabre sin salir de PCI SAQ-A

`createBooking` manda PAN en **49** requests y CVV en **46**; `fulfillFlightTickets` en **15** y **12**. En 1.077
requests **no hay un solo ejemplo de tokenización**. `CLAUDE.md` dice, textual: "*solo hosted checkout en fase 1
(PCI SAQ-A), nunca tocamos PAN/CVV*".

- **(A) Nunca mandar PAN.** Emitir con `CASH` / `ON_ACCOUNT` / `INVOICE`, cobrar por nuestro hosted checkout
  (Stripe / Mercado Pago) y liquidar contra BSP con fondos de la agencia vía wallet.
  *Consecuencia:* SAQ-A intacto, cero coste de cumplimiento. **Y ya no es una apuesta a ciegas en ATPCO:** la
  emisión ATPCO con `CASH` seleccionada está **verificada end-to-end** con requests reales de producción. Lo que
  sigue sin confirmar es **NDC** (P-03).
- **(B) Aceptar PCI SAQ-D.** Vault/HSM propio, segmentación de red, escaneo ASV trimestral, pentest y auditoría
  anual. *Consecuencia:* cobertura total de FOP, pero cambia una regla declarada no negociable, mete un coste anual
  recurrente de cinco cifras y un requisito de personal que hoy no existe.
- **(C) `VIRTUAL_CARD`.** El PAN que viaja no es el del cliente. *Consecuencia:* cubriría NDC manteniendo el alcance
  PCI bajo, pero depende por completo de P-23: si la VCC hay que traerla de un emisor externo, es un proveedor y un
  contrato nuevos.

> **Recomendación: (A) desde el día 1, (C) como habilitador de NDC en cuanto se responda P-23, (B) descartada.**
> `PAYMENTCARD` queda detrás de un feature flag de Unleash **apagado por defecto y por tenant**. Si NDC con tarjeta
> resulta imprescindible antes de tener VCC, **la alternativa correcta es no vender ese contenido, no bajar la
> postura PCI**.

### D2 — Alcance del carril SOAP en la primera integración

- **(A) `providers/sabre` v1 sólo REST + ATK stateless.** Entrega shopping ATPCO/NDC, price, createBooking,
  getBooking, cancel, fulfill, void, refund y modify. **No** entrega LCC con ancillaries, ni perfiles, ni group
  bookings, ni PNR único multi-producto. *Consecuencia:* ocho páginas oficiales confirman que **todo nuestro
  alcance corre stateless**, y `createBooking` ya orquesta la cadena LLS por dentro. **Es la decisión con más
  ahorro del expediente.**
- **(B) REST + cliente SOAP + parser XML + `SabreSessionPool`.** *Consecuencia:* 243 requests de superficie nueva,
  un transporte que el stack no tiene, y un pool con lease/keepalive/compensación Temporal **que en BYOC se
  multiplica por tenant**.

> **Recomendación: (A), sin ambigüedad.** (B) como hito separado, con su propia estimación, sólo si LCC, grupos o
> el PNR único entran al roadmap por una razón de negocio explícita. **Pero la bóveda de credenciales modela desde
> ya las dos formas** (§5.1): cambiar el esquema después es caro.

### D3 — Cuándo se captura el BIN de la tarjeta

Si `params.formOfPayment` es obligatorio en `/v1/offers/price` (P-14), **el precio final depende del medio de pago
antes de reservar**, lo que invierte el orden de nuestro checkout.

- **(A) Pedir los 6 primeros dígitos antes de revalidar.** Precio final correcto desde el principio; a cambio,
  fricción nueva y el BIN entra a nuestro sistema (fuera de logs, de la caché y de `domain_events`).
- **(B) Revalidar con un BIN representativo por tenant y re-revalidar al tokenizar la tarjeta real.** Preserva el
  flujo pero exige una pantalla de "el precio cambió" que va a aparecer de verdad.
- **(C) Mostrar "precio desde".** Honesto y simple, pero en CO y BR "precio desde" en una cotización enviada por
  WhatsApp tiene exposición legal si el total sube.

> **Recomendación: (B), con la pantalla de cambio de precio diseñada desde el día 1 como paso normal del flujo, no
> como caso de error.** No decidir en firme hasta responder P-14, que cuesta una llamada al sandbox.

### D4 — Modelo de red por defecto (quién es el emisor de récord)

- **(A) Herencia total.** La sub-agencia usa el PCC del consolidador. Onboarding en horas, funciona para agencias
  sin IATA. Sabre ve la cuenta heredada y la atribución de la sub-agencia es nuestra; **quién liquida ante BSP y
  absorbe ADM es una condición comercial por confirmar**, no una propiedad del schema (P-02/P-10).
- **(B) PCC propio obligatorio.** Aísla técnicamente la operación por agencia, pero no basta para inferir por API la
  asignación financiera. Puede excluir agencias sin acreditación y el onboarding añade certificación + branch
  access; confirmar condiciones y tiempos por escrito.
- **(C) Híbrido: la agencia reserva con su PCC y emite con `targetPcc` del consolidador.** Es lo que la API favorece
  nativamente y está documentado literalmente para ese caso. Depende de P-02 y P-10.

> **Recomendación técnica provisional: (A) como default, (C) como upgrade para agencias con PCC, condicionada a
> P-02/P-10.** Antes de activar `is_inheritable = true`, la UI presenta un paso aparte que identifica qué cuenta y
> PCC se usarán y exige aceptar las responsabilidades BSP/ADM que Sabre confirme por escrito. No es una casilla de
> configuración: puede implicar asunción de riesgo financiero.
> **Y el wizard se bifurca en dos rutas** (ruta heredada: horas; ruta BYOC: estado `pending_provider_certification`,
> semanas), porque prometer "alta en horas" en la ruta BYOC es literalmente incumplible.

### D5 — Cobertura de contenido en el primer incremento

- **(A) ATPCO + NDC en una sola llamada, con `MultipleSourcePerItinerary = true`.** *Consecuencia:* **ya no hay
  disyuntiva de coste** — la primera pasada creía que sumar fuentes costaba llamadas extra y no es así.
- **(B) Añadir LCC.** *Consecuencia:* los 8 ejemplos LCC exigen **declarar el carrier**, lo que lo hace inservible
  para una búsqueda abierta BOG→LIM, y no hay confirmación de cobertura de JetSMART/Sky/Gol.

> **Recomendación: (A) en Ola 1. (B) es un `Enable` de una línea el día que se confirme cobertura, y no antes.**

### D6 — Cómo se vende el asiento en el canal conversacional

En NDC **no existe `areaPreferences`**: hay que devolver un `seatOfferId` de una celda concreta.

- **(A)** El bot manda un enlace a una vista web del mapa mobile-first y recoge la selección.
- **(B)** El bot acepta "ventanilla" y **nosotros** filtramos la característica y elegimos, asumiendo la
  responsabilidad de la elección.
- **(C)** Vender sin asiento y ofrecerlo post-emisión, apoyándose en `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`.

> **Recomendación: (A) para el mapa completo y (B) como atajo explícito, etiquetado como tal en la conversación —
> nunca (B) en silencio.** (C) es el fallback cuando el carrier no soporta asiento pre-emisión.

### D7 — Identificador fiscal LATAM en el PNR

El enum `documentSubType` declara `RUC` (Ecuador), `CUIT/CUIL` (Argentina) y `NIT` (Bolivia). **No hay `CPF` ni
`CNPJ`.**

- **(A)** Investigar si `RUC`/`NIT` sirven para Perú y Colombia aunque el contrato los documente para otros países.
- **(B)** Llevar el ID fiscal por `remarks` o `accountingItems` en vez de `identityDocuments`.
- **(C)** Mantener el ID fiscal **sólo en nuestra DB** y facturar desde nuestro sistema, sin propagarlo al PNR.

> **Recomendación: (C) como fallback garantizado, con (A) en paralelo para Perú (donde `RUC` es el mismo concepto).
> Brasil no tiene salida por `identityDocuments`.** Y (C) es coherente con §6.5: el maestro del dato del viajero es
> nuestro, no de Sabre.

### D8 — Cuándo se arregla el `VARCHAR(200)` del Package Studio

- **(A) En el mismo PR que habilita Sabre**, sobre una tabla hoy casi vacía y sin front-end.
- **(B) Cuando se construya el lienzo drag-and-drop de la Ola 2**, migrando datos de producción del "corazón del
  producto".

> **Recomendación: (A).** Hoy el coste es un `ALTER` que en Postgres 16 no reescribe la tabla ni reindexa; después
> es una migración con datos, y el síntoma que la dispara es *"el vuelo de Sabre no se puede agregar al paquete"*.

### D9 — Motor de las sagas con dinero

- **(A) Traer Temporal ahora**, como prevé `CLAUDE.md`: timers durables de días, estado que sobrevive a deploys,
  compensación auditable.
- **(B) Extender el worker BullMQ que ya existe** (`apps/api/src/orders/post-sale.worker.ts`) con tipos
  `issue`/`void`/`refund`: entrega semanas antes, pero los deadlines de días se manejan con jobs frágiles.

> **Recomendación: (B) hasta la emisión, (A) antes de que exista el primer `refundFlightTickets` en producción.**
> El punto de no retorno es la emisión: mientras sólo reservamos y cancelamos, BullMQ alcanza.
> **Y la cola de emisión diferida es nuestra, no de Sabre:** `futurePricingLines` es nativo y sin infraestructura,
> pero es opaco (si falla no nos enteramos) y no sirve para LATAM NDC ni para el resto — tendríamos dos mecanismos
> de emisión diferida con semánticas distintas.

---

## 10. Riesgos consolidados

| # | Riesgo | Sev | Mitigación |
| --- | --- | --- | --- |
| **R-01** | **Compromiso comercial a ciegas.** El plan compromete 48-59 d-p sin fee conocido, sin confirmación de multi-PCC de terceros y sin cobertura NDC medida. Es la exposición más grande del expediente. | 🔴 Bloqueante | **D0** + compuerta Go/No-Go de §2.3 entre Fase 0 y Fase 1, con umbral numérico **preacordado** |
| **R-02** | **Credenciales disponibles pero aún no inyectadas/validadas en CERT.** | 🟠 Operativo | Cargarlas fuera de Git mediante `ProviderCredentialsService`; smoke test de auth sin registrar secretos |
| **R-03** | **Conflicto PCI.** Integrar `PAYMENTCARD` nos mueve a SAQ-D contra una regla no negociable. **Severidad rebajada de 🔴 a 🟠 en ATPCO** (emisión con `CASH` verificada end-to-end) pero **se mantiene 🔴 en NDC**, donde no hay ni un ejemplo sin tarjeta. | 🔴 (NDC) / 🟠 (ATPCO) | **D1** + RNF-06 en tres capas (tipo, test de CI, lint) + P-03 |
| **R-04** | **Fallo dentro de un HTTP 200.** Los contratos declaran casi sólo `200` y los fallos viajan en envelopes distintos (`errors[]`, `messages[]`, `ApplicationResults`): una reserva fallida puede registrarse como confirmada y cobrarse sin billete. | 🔴 Crítico | RNF-03. Clasificador por familia de API: 2xx **y** sin error semántico en su envelope. Fixture obligatorio de 200-con-error por variante |
| **R-05** | **Emisión "exitosa" sin documento.** Un 200 puede traer `PARTIAL_FULFILLMENT`, `FULFILLMENT_NOT_CONFIRMED` o `UNABLE_TO_RETRIEVE_TICKETS` — dinero cobrado sin billete. | 🔴 Crítico | RF-11 CA-2: los tres escalan a `NEEDS_HUMAN`, nunca se reintentan |
| **R-06** | **Doble emisión por reintento ciego.** No hay idempotency key (VERIFICADO-SPEC como ausencia real). Atenuado por `BOOKING_FULFILLED`, que actúa como barrera del lado servidor. | 🟠 Alto | RNF-11 + RF-15: clave propia antes de llamar, reconciliación como actividad de saga, **cero reintentos automáticos** en operaciones no idempotentes |
| **R-07** | **Reservar una oferta Sabre contra LATAM.** El día que la primera oferta Sabre aparezca en pantalla, `search.service.ts:114` y `orders.service.ts:138` la mandan a LATAM. | 🔴 Alto | Arreglar en el **mismo PR** que habilita Sabre en búsqueda (§6.4) |
| **R-08** | **Semántica ambigua del contexto `targetPcc`.** El contrato no revierte contexto, pero Booking Management se declara stateless y limpia AAA con ATH; la persistencia entre llamadas ATK no está demostrada. | 🟠 Alto hasta CERT | RF-18 CA-3 + RNF-05 + test A→B de aislamiento cross-tenant |
| **R-09** | **Sabre decide qué alternativa cross-source sobrevive.** Por defecto se queda con la más barata en el solapamiento ATPCO/NDC; marcas y upsells tienen controles distintos. | 🔴 Alto | `MultipleSourcePerItinerary = true` + `MultipleBrandedFares`/`MaxNumberOfUpsells`, con tests separados |
| **R-10** | **Degradación parcial silenciosa.** El vendedor ve la mitad del mercado creyendo que ve todo. Agravado por el "No Availability" de un `RequestType` no suscrito, que es indistinguible de "no hay vuelos". | 🔴 Alto | RNF-13 + RF-03 CA-5 + RNF-09 (`requestType` en el span) |
| **R-11** | **Ventana de void calculada por nosotros.** Era una recomendación de la primera pasada y **es un riesgo**: Sabre publica `isVoidable` y, en NDC, la hora exacta en UTC. Calcularla con la zona equivocada convierte un void gratis en un refund con penalidad **sin fallar ruidosamente**. | 🟠 Medio-alto | RF-13 CA-1: leer, nunca calcular. `ticketingPccTimezone` eliminado de `config` |
| **R-12** | **Fuga de credenciales entre agencias** por la caché de instancias del factory. Silenciosa: tarifas plausibles contra el contrato equivocado. | 🔴 Alto | RNF-05 + test de aislamiento del caché de adapters |
| **R-13** | **El `secret` es base64 reversible, no un hash.** Un log de debug filtra el password completo de la oficina. | 🔴 Alto | RNF-07, aplicado **antes** de la primera llamada real |
| **R-14** | **El fan-out agota el cupo de concurrencia** y devuelve 429 a todos los tenants que comparten credencial heredada. Una campaña de ventas exitosa nos throttlea a nosotros mismos. | 🟠 Medio-alto | RNF-04 (semáforo por `provider_account`, en Redis) + P-09 |
| **R-15** | **Post-venta NDC inexistente.** Flight Reshop es `beta` y sólo ATPCO. Nuestro contenido diferencial es NDC. Comprar Sabre esperando resolver cambios de LATAM por ahí es comprar una promesa. | 🟠 Medio-alto | N8 + corregir `12-modelo-consolidador-y-plan.md` §4.1, que da la post-venta por cerrada |
| **R-16** | **La cuota horaria se divide entre proveedores.** 600/h pasa a 300 y el mensaje de error **miente sobre el número**. | 🟠 Medio-alto | RNF-10 + migración `search_group_id` |
| **R-17** | **Ofertas vencidas en venta por WhatsApp.** El cliente responde 40 min después y la oferta murió. Choca con "tiempo a venta < 2 minutos". | 🟠 Medio-alto | RNF-12 + aviso al 75 % del TTL |
| **R-18** | **`403` de entitlement o `404` sin datos clasificados como caída**: el circuito abre y degrada las búsquedas de todos los tenants por la configuración de uno solo, o por una ruta sin vuelos. | 🟠 Medio-alto | RNF-03 (matriz explícita) |
| **R-19** | **Onboarding self-service incumplible** en la ruta BYOC: 4-8 semanas de certificación **más** branch access gestionado por Sabre agencia por agencia. | 🟠 Medio-alto | **D4** (default = herencia) + wizard bifurcado con estado `pending_provider_certification` |
| **R-20** | **Sin documento fiscal, la venta es un incumplimiento**, no un bug menor. El enum de Sabre no tiene CPF ni CNPJ. | 🟠 Medio-alto | RF-21 + **D7** (fallback: el ID fiscal vive en nuestra DB) |
| **R-21** | **Operaciones que devuelven error pero se aplican** (*"throws error but works and adds infant"*). Tratarlo como fallo y reintentar duplica el infante. | 🟠 Medio | RF-17 CA-3: verificación con `getBooking`, nunca reintento ciego |
| **R-22** | **Índices 1-based en todo el API.** Un off-by-one asigna el asiento al pasajero equivocado o cobra a la tarjeta equivocada, **en silencio**. | 🟠 Medio | RF-08 CA-4: conversión en un único punto con test de propiedad |
| **R-23** | **El refactor toca el camino crítico sin tests.** `apps/api/src/search/` tiene cero cobertura y genera todos los ingresos. | 🟠 Medio | RNF-14: tests de comportamiento actual **antes** del refactor |
| **R-24** | **`changeOfGaugeSeats` olvidado:** en vuelos con cambio de aeronave, llenar sólo `seats[]` deja al pasajero sin asiento en la segunda mitad **sin error que lo delate**. | 🟠 Medio | RF-16 CA-3 |
| **R-25** | **El contrato cambia bajo los pies.** Booking Management publica una versión cada 2-3 meses y el corpus creció de 15 a 21 specs mientras se escribían estos documentos. | 🟠 Medio | RNF-15: specs commiteados con `info.version` pineado y diff en CI |
| **R-26** | **Nacer en la versión equivocada.** La colección usa `getseats` v1 y `getAncillaries` v2; el catálogo publica v3 de ambos. Escribir el ACL sobre v1 es deuda garantizada el día 1. | 🟠 Medio | P-06: dos `curl`, uno a cada ruta, **antes** de escribir una línea |
| **R-27** | **Los ejemplos de la colección se contradicen** (`useCsl`/`useCSL`, `payment`/`payments`, `flightNumber` string vs entero, un ADT con `age: 3`, un request "v3.0.0" que apunta a /v5) y **38 de 49 nombres mienten sobre su versión**. | 🟡 Bajo-medio | Nunca portar un ejemplo literal. Todo body pasa por builder tipado + Zod contra el spec |
| **R-28** | **PCC de ejemplo y un secreto fijo en la fuente.** U9PK, G7RE, 7KFA, G7HE, N87F, GF1I aparecen en headers y bodies, y 23 requests traían `ClientId SBR-BMAPI` con un `ClientSecret` fijo. | 🟡 Bajo-medio | Todo PCC sale de `config` (regla de lint). La copia versionada sustituye el secreto por `{{soap_client_secret}}`; el auditor exige `safeToVersion: true` |
| **R-29** | **Distracción estratégica.** ~50 d-p en un segundo GDS mientras Ola 1 tiene abiertos pagos, fiscal, IA WhatsApp y Package Studio. **Subido de 🟡 a 🟠:** excluir hoteles y autos no reduce el coste de oportunidad, y **en los doce documentos no hay una sola cifra de valor esperado**. | 🟠 Medio-alto | §2.3 (métrica y umbral preacordado) + **D0** + la compuerta comercial de R-01. La mitigación no es "excluir verticales": es **medir el aporte antes de comprometer la Fase 1** |

---

## Preguntas abiertas

Consolidadas y priorizadas en **§8**, con el criterio corregido: **P0 = bloquea la decisión de invertir**.

Las siete P0 se agrupan en dos bloques que se resuelven por vías distintas y **en paralelo**:

- **Bloque comercial (correo al account manager):** **P-01** fee por transacción, **P-02** multi-PCC de
  terceros y branch access, **P-03** forma de pago sin PAN en NDC. **P-05 ya está resuelta** y pasa a inyección segura.
  Ninguna se resuelve leyendo más documentación.
- **Bloque de medición (media jornada en CERT, en cuanto haya credenciales):** **P-04** aporte incremental real
  sobre LATAM NDC directo, **P-06** entitlements de nuestro PCC. Son las que convierten **D0** en una decisión con
  dato en vez de una preferencia.

**P-07** (¿nunca PAN?) es la única P0 que no depende de nadie externo: es una decisión del founder y se puede tomar
hoy (**D1**).

## Riesgos

Consolidados en **§10**. Cambios de severidad respecto de la versión anterior, cada uno con su razón:

- **Sube a bloqueante:** **R-01** (compromiso comercial a ciegas) — es nuevo y es el riesgo dominante del
  expediente; **R-29** (distracción estratégica) sube de 🟡 a 🟠 porque no hay ninguna cifra de valor esperado y
  excluir verticales no mitiga el coste de oportunidad.
- **Baja:** **R-03** (PCI) baja a 🟠 **en ATPCO** — la emisión sin PAN está verificada end-to-end con requests
  reales — pero **se mantiene 🔴 en NDC**, donde no existe un solo ejemplo; **R-06** (doble emisión) baja a 🟠
  porque `BOOKING_FULFILLED` actúa como barrera de idempotencia del lado servidor.
- **Invertido:** **R-11** — calcular la ventana de void con la zona del PCC emisor era una *recomendación* de la
  primera pasada y es un *riesgo*: Sabre publica `isVoidable` y la hora exacta en UTC.
- **Retirados:** "escribir mappers sobre respuestas que nadie vio" (los contratos los cerraron; ver RF-04) y
  "el PNR único obliga a migrar la vertical vuelo" (la premisa era falsa — N4).
- **Nuevos:** **R-05** (emisión exitosa sin documento), **R-09** (Sabre elige la tarifa por nosotros), **R-15**
  (post-venta NDC inexistente), **R-20** (venta sin documento fiscal), **R-24** (`changeOfGaugeSeats`), **R-25**
  (el contrato cambia bajo los pies), **R-26** (nacer en la versión equivocada).

Los cuatro que hay que mirar cada semana: **R-01**, **R-02**, **R-04** y **R-08**.
