---
titulo: 'TBO Hotels — Requisitos maestro de integración'
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Requisitos maestro de integración

> **Cómo leer este documento.** Consolida los documentos [01](./01-autenticacion-conectividad-y-errores.md) a
> [07](./07-certificacion.md) en requisitos verificables, riesgos y decisiones. No repite su contenido: cada requisito
> enlaza la sección que lo desarrolla. Las fuentes, sus hashes y la convención de citas están en
> [00-fuentes.md](./00-fuentes.md) §9: "(p. N)" es la página **física** del PDF V2.1; "(Postman: `<request>`)" es la
> colección; "(Cert, <sección>)" es el documento de certificación; `ruta:línea` es el repo en el commit `8972c6a`.
> Etiquetas: **VERIFICADO-PDF**, **VERIFICADO-POSTMAN**, **VERIFICADO-CERT**, **VERIFICADO-CODIGO** e **INFERIDO**.
> Los párrafos marcados **Postura** son decisiones de diseño nuestras, no afirmaciones sobre el contrato.
>
> **Cuando los documentos del set se contradicen, manda este.** Las contradicciones entre 01-07, la regla que se
> adopta y el documento que se corrigió están en §9. Cada pregunta a TBO enlaza su ID (`Q-NN`) de
> [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md). El orden de construcción y el esfuerzo están en
> [09-plan-implementacion.md](./09-plan-implementacion.md).
>
> **Decisiones cerradas que este documento no reabre** (`docs/sabre/10-requisitos-maestro.md` §9, VERIFICADO-CODIGO):
> **D1** — nunca manejamos PAN ni CVV; para TBO significa solo `PaymentMode: "Limit"`. **D9** — BullMQ para las
> sagas con dinero hasta la emisión; hoteles no emite, así que BullMQ aplica.
>
> **Revisión del 2026-09-25.** El founder firmó D-TBO-02 (B), D-TBO-03 (A), D-TBO-06 (A) y D-TBO-07 (A), y pidió que
> el resto se implemente con la opción recomendada. Quedan registradas al inicio de §7
> ([Registro de decisiones](#registro-de-decisiones)). Con D-TBO-06 dejó un requisito nuevo, "me tiene que mostrar de
> dónde es", que es RF-40. Las citas `ruta:línea` que agrega esta revisión siguen siendo del commit `8972c6a`.

---

## 1. Resumen ejecutivo

**Qué es TBO para nosotros.** TBO Holidays es un bedbank B2B con una API JSON de hoteles (V2.1, 71 páginas,
11 métodos; [00](./00-fuentes.md) §6). Sería el **segundo proveedor de hoteles** de la plataforma: hoy el único es
Despegar, y la vertical está cableada a él (`apps/api/src/hotels/hotels.service.ts:21`, `:24`, `:29`,
VERIFICADO-CODIGO).

**Qué aporta.**

1. **Una forma de pago sin tarjeta, escrita en el contrato.** `PaymentMode` admite `Limit`, `SavedCard` y `NewCard`,
   con `Limit` por defecto (p. 19, 33). `Limit` es el único modo cuyo ejemplo de Book no lleva datos de tarjeta
   (p. 35-36; los de `NewCard` y `SavedCard`, p. 34-35, 38-40), así que es el único compatible con D1
   (VERIFICADO-PDF en los ejemplos; el PDF no dice qué campos exige cada modo, N2). Que `Limit` consuma el
   crédito o saldo de la agencia titular de la cuenta TBO, y que `300 INSUFFICIENT_BALANCE` sea su error, es
   INFERIDO: el PDF no define
   `Limit` ([03](./03-prebook-y-book.md) §7.1). A diferencia de Sabre, aquí D1 no pelea contra el contrato: lo
   cumple con una constante.
2. **Una reserva recuperable y conciliable.** El `BookingReferenceId` lo genera el cliente (p. 33; v1.4, p. 5) y
   permite recuperar un Book incierto con `BookingDetail` (p. 42). `BookingDetailsbasedondate` concilia por fecha
   (p. 62-64). El HCN se obtiene por API con un SLA por ventana de check-in (p. 42-43). VERIFICADO-PDF.
3. **Contenido estático descargable**: países, ciudades, hoteles por ciudad y ficha de hotel con imágenes, horarios
   y, desde el 27-oct-2025, detalle por habitación (p. 6, 51-69, VERIFICADO-PDF).
4. **Encaje con el modelo consolidador.** Una credencial Basic por cuenta (p. 7) cabe en la bóveda BYOC con
   herencia que ya existe (`db/migrations/0012_provider_accounts.sql:66-76`, VERIFICADO-CODIGO). Lo que no se sabe
   es si la certificación cubre las cuentas de las agencias (→ [Q-77](./10-preguntas-para-tbo.md#q-77); [07](./07-certificacion.md) §2.8).

**Qué no aporta, o aporta con condiciones.**

- `Search` solo busca por `HotelCodes` (p. 10) y no devuelve nombre, estrellas, dirección ni imágenes (p. 13-15):
  **sin catálogo local no hay búsqueda TBO** ([05](./05-contenido-estatico-e-inventario.md) §0).
- La moneda la fija el perfil de cada cuenta, no el request (p. 13).
- **El valor comercial no está medido.** Ningún documento del set cuantifica cobertura ni precio frente a
  Despegar (§2.3). Con D-TBO-02 (B) se mide como información y no condiciona la construcción.

**Qué cuesta.**

| Frente        | Costo                                                                                                                                                                                                                                                                                                                                                                      | Fuente                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Comercial     | Una cuenta TBO con crédito o saldo para `Limit`: la exposición financiera la asume el titular (INFERIDO). Una **cuenta de plataforma para el catálogo**, aunque todas las agencias traigan la suya. QPS y costo por búsqueda sin publicar                                                                                                                                  | p. 9, 33; [05](./05-contenido-estatico-e-inventario.md) §6.6; [06](./06-seams-integracion-repo.md) §9 H10 |
| Técnico       | 35 de los 67 touchpoints del repo son obligatorios (14 de ellos solo con la línea base y TP-29 con la opción recomendada de D-TBO-16). La vertical de hoteles es mono-proveedor por construcción, y la web de hoteles **solo busca**: no hay detalle, PreBook, huéspedes, Book, reservas ni cancelación de hotel. Herramienta de sync nueva y cuatro migraciones (§9 C-10) | [06](./06-seams-integracion-repo.md) §1, §6; [07](./07-certificacion.md) §1                               |
| Certificación | Cinco fases; mínimo contractual de unos 10 días de pruebas de TBO (JSON ≥ 3 días, portal ≥ 1 semana); estimación realista de 3 a 6 semanas desde el envío del zip, **sin contar la construcción del portal**, que es la ruta crítica                                                                                                                                       | Cert, JSON Verification; Cert, Website/Portal Verification; [07](./07-certificacion.md) §2.9 (INFERIDO)   |
| Esfuerzo      | En días-persona: [09](./09-plan-implementacion.md)                                                                                                                                                                                                                                                                                                                         | —                                                                                                         |

**Riesgos principales** (detalle y mitigación en §6).

1. **Doble reserva con dinero de la agencia.** El contrato obliga a recuperar un Book fallido con `BookingDetail`
   (p. 42), pero no documenta qué devuelve cuando la reserva no existe ni si el Book es idempotente por
   `BookingReferenceId` (p. 33, 42-44). R-01.
2. **El modelo consolidador puede quedar fuera.** No se sabe si la certificación vale para la aplicación o para una
   cuenta concreta (Cert, Sign Off / API Live Credentials). R-03.
3. **El contrato es de baja calidad.** 14 ejemplos de respuesta: 12 con `Code` 200, uno sin disponibilidad (`201`) y
   uno sin `Status`; ninguno de los demás códigos. Diez ejemplos no son JSON válido, y los tipos declarados no
   coinciden con los observados ([00](./00-fuentes.md) §6, §8). R-08.
4. **El portal que TBO va a probar no existe** y es la ruta crítica de la certificación
   ([07](./07-certificacion.md) §8). R-04.
5. **TBO no está en el roadmap.** El roadmap prevé HotelDo + Hotelbeds en la Ola 1 (`docs/discovery/07-roadmap-olas.md:14`,
   `:94`) y la investigación recomienda sumar RateHawk (`docs/research/03-integraciones-ecosistema.md:339`), sin
   TBO. VERIFICADO-CODIGO. R-26.

**Las seis decisiones del arranque ya no bloquean.** El 2026-09-25 el founder cerró D-TBO-02 con la opción (B): no
hay compuerta de valor y se construye todo. Cerró con la opción (A) D-TBO-03 (cuenta del consolidador heredada, sin
fallback de plataforma), D-TBO-06 (generalizar la vertical, con el proveedor visible en cada tarifa según la
divulgación existente, RF-40) y D-TBO-07 (órdenes antes del Book). D-TBO-01 (orden frente a Hotelbeds y RateHawk) y
D-TBO-05 (cuándo se abre la certificación) no están firmadas y se implementan con su opción recomendada (A), igual
que el resto. Detalle en §7.

---

## 2. Alcance

### 2.1 Lo que entra

| #       | Capacidad                                                    | Métodos TBO                                                                                                                       | Justificación                                                                                              |
| ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **E1**  | Búsqueda de disponibilidad por destino                       | `Search` por `HotelCodes` (p. 10-18)                                                                                              | Es la única búsqueda del contrato. El destino se resuelve antes con nuestro catálogo (E8)                  |
| **E2**  | Revalidación de precio, disponibilidad y condiciones finales | `PreBook` con `PaymentMode: "Limit"` (p. 19-32)                                                                                   | "Cancellation Policy and Norms received in the PreBook response will be considered as final" (p. 71, KP-3) |
| **E3**  | Reserva con voucher                                          | `Book` con `Limit` y `BookingType: "Voucher"` (p. 32-41)                                                                          | `Voucher` es el único `BookingType` (p. 33, 70)                                                            |
| **E4**  | Lectura y recuperación de reservas                           | `BookingDetail` por `ConfirmationNumber` y por `BookingReferenceId` (p. 42-51)                                                    | La recuperación tras un Book fallido es obligatoria (p. 42)                                                |
| **E5**  | Cancelación                                                  | `Cancel` por `ConfirmationNumber` (p. 41-42)                                                                                      | Núcleo de la post-venta                                                                                    |
| **E6**  | Conciliación diaria                                          | `BookingDetailsbasedondate`, ventanas de hasta 60 días (p. 62-64)                                                                 | Red de seguridad para Books inciertos y cancelaciones hechas fuera                                         |
| **E7**  | Seguimiento del Hotel Confirmation Number                    | `BookingDetail` con la tabla de SLA P0-P5 (p. 42-43)                                                                              | TBO anima ("are encouraged") a obtenerlo por API "instead of relying on emails" (p. 42)                    |
| **E8**  | Catálogo propio de hoteles TBO                               | `CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails` (p. 51-69); `hotelcodelist` opcional para detectar bajas (p. 54-55) | Sin catálogo no hay búsqueda ni ficha de hotel                                                             |
| **E9**  | Vertical de hoteles multi-proveedor                          | —                                                                                                                                 | D-TBO-06 (A), cerrada; sin ella TBO no tiene dónde enchufarse ([06](./06-seams-integracion-repo.md) §1)    |
| **E10** | Credenciales por nodo con herencia                           | —                                                                                                                                 | Con el alcance de D-TBO-03 (A), cerrada: cuenta del consolidador heredada, sin fallback de plataforma      |
| **E11** | Certificación completa hasta credenciales live               | —                                                                                                                                 | Condición para operar en producción (Cert, Sign Off / API Live Credentials)                                |

VERIFICADO-PDF para los métodos y páginas; la columna "Justificación" es Postura.

### 2.2 Lo que no entra

| #       | Capacidad excluida                                                         | Motivo                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N1**  | `PaymentMode: "NewCard"`                                                   | Exige `CardNumber` y `CvvNumber` en el Book (p. 33-35, 38). D1                                                                                                                                               |
| **N2**  | `PaymentMode: "SavedCard"`                                                 | El ejemplo 8.1.4 envía `PaymentInfo.CvvNumber` (p. 39-40); el PDF no dice qué campos exige cada modo. El CVV es dato sensible aunque la tarjeta esté guardada en TBO. D1                                     |
| **N3**  | `CreditCardBillingOptions` (PreBook) y `CreditCardOptions` (BookingDetail) | Solo aplican al pago con tarjeta (p. 23, 48). No se modelan ni se persisten                                                                                                                                  |
| **N4**  | "Hotel Search Workflow"                                                    | Se implementó en la v2.0 y se deprecó en la v2.1 sin describirse en ninguna página (p. 6). Solo se usa `Search` por `HotelCodes` ([00](./00-fuentes.md) §10 F-01). → [Q-02](./10-preguntas-para-tbo.md#q-02) |
| **N5**  | Filtros `OrderBy`, `StarRating` y `HotelName` de Search                    | Existen solo en Postman (Postman: Search), no en la tabla de p. 10-11. Filtrar por estrellas o nombre es trabajo nuestro sobre el catálogo ([02](./02-search-y-oferta-canonica.md) §7)                       |
| **N6**  | Cancelación por habitación y modificación de reservas                      | El contrato no las tiene: `Cancel` recibe solo `ConfirmationNumber` (p. 41). Cambiar la ocupación es cancelar y volver a reservar ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-19)        |
| **N7**  | Reserva en espera u "on request"                                           | `BookingType` solo admite `Voucher` (p. 33, 70)                                                                                                                                                              |
| **N8**  | Venta como hotel suelto de tarifas "solo con billete aéreo"                | Hasta que exista una reserva de paquete que vincule vuelo y hotel (D-TBO-22)                                                                                                                                 |
| **N9**  | Adoptar como órdenes las reservas hechas fuera de la plataforma            | Falta el precio de venta y el contexto de búsqueda (D-TBO-27)                                                                                                                                                |
| **N10** | Contenido por habitación (`IsRoomDetailRequired`) en producción            | El PDF no dice en qué clave llega (p. 56-59). Se construye **apagado** hasta tener un fixture real ([05](./05-contenido-estatico-e-inventario.md) §2.6.3)                                                    |
| **N11** | GIATA u otro mapeo licenciado                                              | Se decide con el tercer bedbank (D-TBO-01, D-TBO-13)                                                                                                                                                         |
| **N12** | Declarar B2C, WhatsApp o móvil en la primera certificación                 | D-TBO-36. Las reglas de TBO (suplementos, piso de precio) aplican igual a esos canales cuando existan                                                                                                        |
| **N13** | Perfiles TBO en monedas sin 2 decimales (`CLP`, `JPY`, `KWD`)              | `Money` asume 2 decimales (`packages/canonical/src/money.ts:41-46`, VERIFICADO-CODIGO). D-TBO-15                                                                                                             |
| **N14** | Conversión de moneda con tasa de cambio                                    | Doctrina de vuelos (`apps/api/src/search/search.service.ts:70-109`, VERIFICADO-CODIGO). D-TBO-15                                                                                                             |
| **N15** | Reembolso automático al cliente final                                      | La API no devuelve cargo ni reembolso (p. 42). D-TBO-26                                                                                                                                                      |

### 2.3 Valor esperado: la cifra que no existe en el set

Los documentos 01-07 describen cómo integrar TBO y **ninguno dice cuánto aporta**: ni cuántos hoteles TBO hay en
los destinos que vendemos que no estén en Despegar, ni si su neto es mejor. Es el mismo defecto que tenía el
expediente de Sabre (`docs/sabre/10-requisitos-maestro.md` §2.3, VERIFICADO-CODIGO). La postura original era medir
antes de construir la reserva. **El founder la descartó el 2026-09-25 con D-TBO-02 (B):** se construye todo y el
valor se mide en producción. Las dos cifras se siguen produciendo, como información y sin decisión atada
(PR-3.7 de [09](./09-plan-implementacion.md) §9 y §10):

- **Cobertura incremental**: en los destinos habilitados, porcentaje de hoteles TBO activos **sin** equivalente en
  Despegar. Se mide con el catálogo sincronizado y `hotel_match` ([05](./05-contenido-estatico-e-inventario.md)
  §9), sin credenciales live.
- **Precio**: en una muestra de 20 a 30 estancias reales en CO, PE, BR y los destinos emisivos habilitados,
  porcentaje en que el neto TBO mejora al neto Despegar del hotel equivalente. Las tarifas del entorno de test no
  son representativas (INFERIDO), y las credenciales live llegan recién con el sign-off (Cert, Sign Off / API Live
  Credentials): la muestra sale de la cuenta comercial del consolidador en el portal B2B de TBO, si existe
  (INFERIDO).

**Sin umbral.** Con (B) ninguna cifra abre ni cierra fases: el 15 % que proponía esta sección desaparece. La
consecuencia que el founder aceptó es la de la ficha: si el aporte resulta bajo, el costo de F4-F6 ya está gastado.
Reordenar los bedbanks por esas cifras sería una decisión nueva suya sobre D-TBO-01, no un efecto automático de la
medición. Las cifras sirven para elegir qué destinos sincronizar primero (D-TBO-12), para la conversación comercial
con TBO y como línea base de la medición en producción, que repite la de precio con tarifas live.

---

## 3. Requisitos funcionales

> Cada requisito tiene un **Enunciado** verificable, su **Fuente** (páginas del contrato y sección del documento
> que lo desarrolla), **Criterios de aceptación** (CA) y **Depende de**. Un requisito que cambia según una decisión
> abierta está escrito con la opción recomendada y lo dice.

### A. Conectividad y contrato transversal

#### RF-01 — Cuenta TBO validada antes de tocar la red

**Enunciado.** La cuenta `tbo-hotels` se valida con un esquema Zod al guardarla y al construir el adapter:
`username` y `password` cifrados; `environment` (`test` | `live`) obligatorio; `baseUrl` obligatorio y **sin valor
por defecto** en `live`; `http:` aceptado solo con `environment: 'test'` y host exacto `api.tbotechnology.in`.

**Fuente.** "The API uses the Basic Auth protocol", "All APIs should be secured with HTTPS protocol", Test BaseURL
`http://…`, Live BaseURL `{Live-URL}/HotelAPI` (p. 7, VERIFICADO-PDF); [01](./01-autenticacion-conectividad-y-errores.md)
§1.2, §2.2, §2.3; [06](./06-seams-integracion-repo.md) §9 H1-H2.

**CA.**

1. `environment: 'live'` sin `baseUrl` → cuenta incompleta (`ProviderAccountIncompleteError`) con los nombres de
   los campos, nunca sus valores.
2. `http:` con `environment: 'live'`, o con otro host, se rechaza al guardar y al construir el adapter.
3. `username` vacío o con `:` se rechaza. La contraseña no se recorta con `trim()`, tampoco en el panel.
4. Los errores de configuración llevan solo `ruta:código`, como `parseSabreConfig`
   (`providers/sabre/src/config.ts:122-131`, VERIFICADO-CODIGO según [01](./01-autenticacion-conectividad-y-errores.md) §1.2).
5. `JSON.stringify` del adapter y de la configuración no contiene la contraseña (test).

**Depende de.** D-TBO-30, D-TBO-03. → [Q-03](./10-preguntas-para-tbo.md#q-03), [Q-04](./10-preguntas-para-tbo.md#q-04) (HTTPS en test, URL live).

#### RF-02 — Cliente HTTP con operaciones, timeouts y reintentos declarados

**Enunciado.** Toda llamada a TBO sale por `TboHttpClient` y por una sola tabla `TBO_OPERATIONS` con path (casing del
PDF), verbo, timeout, marca de dinero e intentos máximos. La cabecera `Authorization: Basic …` se calcula una vez y
vive en un campo privado. `fetch`, logger, métricas, reloj y limitador se inyectan. `AbortSignal.timeout` cubre
también la lectura del cuerpo. `redirect: 'manual'`. `/Book` y `/Cancel` tienen **un solo intento** aunque alguien
edite la tabla.

**Fuente.** Paths y verbos (p. 7-8, 10, 19, 32, 41-42, 51, 53, 54-55, 56, 62, 65); timeouts (p. 8); VERIFICADO-PDF.
[01](./01-autenticacion-conectividad-y-errores.md) §3, §5, §10.

**CA.**

1. Por la puerta pública, con `fetch` espiado: un timeout en `/Book` o `/Cancel` produce **exactamente una**
   llamada, aunque el fallo sea `RETRY_BACKOFF`.
2. Un cuerpo que llega despacio se corta por timeout; no basta con que lleguen las cabeceras.
3. Un 3xx sin JSON se clasifica `CLIENT_BUG` y no se sigue.
4. `CountryList` y `hotelcodelist` salen por `GET` sin cuerpo; el resto por `POST` con `Content-Type: application/json`.
5. Ningún literal de path fuera de `TBO_OPERATIONS` (test de búsqueda en el código del paquete).
6. La sonda PR-04 de certificación fija el casing que funciona ([07](./07-certificacion.md) §6.8; §9 C-03).

**Depende de.** RF-01, RNF-01, RNF-02.

#### RF-03 — El resultado lo decide `Status.Code` del cuerpo

**Enunciado.** La clasificación sigue [01](./01-autenticacion-conectividad-y-errores.md) §8.3-§8.4: `200` es éxito
sujeto al Zod del mapper; `201` en Search es lista vacía; el resto de los 12 códigos del contrato (incluido el `201`
fuera de Search) se traduce a `failure.kind`;
un código desconocido es `UNKNOWN_CODE`; un 2xx vacío, no JSON o sin `Status` es `MALFORMED_RESPONSE` (salvo
`hotelcodelist`); un HTTP no-2xx con envelope válido se clasifica por el cuerpo. **Ninguna rama compara
`Status.Description`.**

**Fuente.** Tabla de códigos (p. 8-10); `Status` (p. 13, 42); ejemplo `201` (p. 18); `hotelcodelist` sin `Status`
(p. 55). VERIFICADO-PDF.

**CA.**

1. Un fixture por cada fila de [01](./01-autenticacion-conectividad-y-errores.md) §8.3 y §8.4, incluidos HTTP 200
   con `Code` 405 y HTTP 500 con envelope.
2. Un Book `200` sin `ConfirmationNumber` es incierto, no éxito.
3. `hotelcodelist` sin `Status` valida por su propio esquema.

**Depende de.** RF-02. → [Q-07](./10-preguntas-para-tbo.md#q-07), [Q-08](./10-preguntas-para-tbo.md#q-08) (relación HTTP / `Status.Code`; códigos posibles por método).

#### RF-04 — Errores tipados compatibles con la política de cancelación

**Enunciado.** Se adopta el modelo de [01](./01-autenticacion-conectividad-y-errores.md) §9 (§9 C-04): una clase
`TboApiError` con `status` (HTTP; `0` sin respuesta) **separado** de `tboCode` (`Status.Code`), `path`, `requestId`,
`timedOut` y `failure` (`kind` cerrado de 14 valores, `retry`, `circuit`, `notifyAccountOwner`, `operatorAlert`); más
`TboConfigError`, `TboCredentialsMissingError`, `TboRequestBuildError`, `TboOfferExpiredError` y
`TboResponseMappingError`. En `/Cancel`, un fallo de esquema o un `Status.Code` desconocido se lanza como
`TboCancelMappingError`, y todo otro desenlace que no sea `200` ni `479`, como `TboCancelOutcomeUnknownError` (§9
C-04); una llamada que el limitador de la cuenta no
despachó es `TboDispatchRejectedError`, con `sentToProvider: false`. El `message` no
lleva cuerpo ni `Description`. El humanizador es un `Record<TboFailureKind, …>` completo, con variantes según la
credencial sea propia, heredada o de plataforma, y el error al front lleva un campo máquina `reason`.

**Fuente.** [01](./01-autenticacion-conectividad-y-errores.md) §9; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
§4.3; `apps/api/src/orders/cancel-retry-policy.ts:41-50`, `:77`, `:85` (VERIFICADO-CODIGO al 2026-09-27: un `status`
4xx o `failure.retry === 'NO_RETRY'` se clasifican deterministas, salvo que antes decida `sentToProvider: false` o un
nombre `…Cancel(Mapping|OutcomeUnknown)Error`).

**CA.**

1. `TboApiError` con `status: 200` y `tboCode: 479` no cae en la regla "HTTP 4xx determinista" (`:85`).
2. Timeout, red, `401`, `402`, `400` o cualquier otro código de la tabla de TBO que no sea `200` ni `479` en
   `/Cancel` → `TboCancelOutcomeUnknownError` → `UNVERIFIED`; fallo de esquema o `Status.Code` desconocido en la
   respuesta de `/Cancel` → `TboCancelMappingError` → `UNVERIFIED` (los dos por el nombre,
   `CANCEL_OUTCOME_UNKNOWN_ERROR`, `:48`).
3. Agregar un `kind` sin mensaje rompe la compilación del humanizador.
4. Ningún mensaje al vendedor cita texto del proveedor.
5. El rechazo local del breaker, del kill-switch o del limitador de la cuenta, en la lectura previa o en el write, se
   clasifica como previo al envío y reintentable (`sentToProvider: false`), no como `UNVERIFIED` ni como determinista
   ([01](./01-autenticacion-conectividad-y-errores.md) §9.3, última fila).

**Depende de.** RF-03.

### B. Búsqueda

#### RF-05 — Request de Search según el contrato

**Enunciado.** El builder aplica las reglas S-01 a S-06 de [02](./02-search-y-oferta-canonica.md) §2.3:
`HotelCodes` como un único string CSV sin espacios, deduplicado y de hasta 100 códigos; `PaxRooms` en el orden en
que el vendedor cargó las habitaciones, con `Children` igual a la longitud de `ChildrenAges`; `Filters.MealType`
como string del enum; `IsDetailedResponse: false` en todo listado; nunca `OrderBy`, `StarRating` ni `HotelName`.

**Fuente.** p. 10-12, 69, 71 (VERIFICADO-PDF); Postman: Search (VERIFICADO-POSTMAN);
[02](./02-search-y-oferta-canonica.md) §2-§3, §7.

**CA.**

1. Una habitación sin niños usa la estrategia configurable (`[]` por defecto) que fije la sonda PR-01
   ([07](./07-certificacion.md) §6.8).
2. Una habitación con 5 o 6 niños, o con una edad fuera de rango, deja a TBO fuera de esa búsqueda con un motivo
   visible. No se trunca la ocupación.
3. Los casos 1 a 6 de certificación son tests del builder con el `PaxRooms` exacto de
   [07](./07-certificacion.md) §4.2.
4. La guarda G-5 del arnés falla si algún Search sale con `IsDetailedResponse: true` en un listado.

**Depende de.** RF-06, D-TBO-17, D-TBO-19. → [Q-13](./10-preguntas-para-tbo.md#q-13), [Q-14](./10-preguntas-para-tbo.md#q-14) (`ChildrenAges` sin niños; máximo de habitaciones).

#### RF-06 — Nacionalidad del pasajero principal

**Enunciado.** El criterio neutral de búsqueda lleva `guestNationality` (ISO 3166-1 alfa-2, mayúsculas). Si falta,
TBO no participa en esa búsqueda y se explica por qué; el resto de los proveedores sigue. **Nunca hay valor por
defecto silencioso**, ni del tenant ni de la credencial. El campo se prellena desde el cliente del CRM (alfa-3 →
alfa-2 con una tabla ISO en `packages/validation`) o desde la última búsqueda, y siempre es visible. La nacionalidad
queda en el contexto de búsqueda (RF-08): si en el Book el pasajero principal tiene otra, se vuelve a buscar.

**Fuente.** `GuestNationality` (p. 10) y KP-1: "We strongly recommend not to hardcode the guest nationality … TBO
shall not be liable in such case" (p. 71), VERIFICADO-PDF. [02](./02-search-y-oferta-canonica.md) §5;
[07](./07-certificacion.md) CK-01, U-03.

**CA.**

1. Búsqueda sin nacionalidad con TBO activo → `providers[tbo-hotels]` con estado `skipped` y motivo; Despegar
   responde igual.
2. `'COL'` del CRM → `'CO'`; un texto libre que no convierte no se envía y se pide al vendedor.
3. La especificación de credenciales de TBO no tiene la clave `guestNationality` (test).
4. La nacionalidad no entra en `search_logs.criteria`.
5. Guarda G-6 del arnés: al menos 3 valores distintos entre los casos 1 a 7.

**Depende de.** D-TBO-14. → [Q-17](./10-preguntas-para-tbo.md#q-17) (nacionalidad frente a residencia).

#### RF-07 — La oferta TBO en el contrato neutral

**Enunciado.** Cada elemento de `HotelResult[].Rooms[]` es **un** roompack neutral, que cubre todas las
habitaciones pedidas con un solo `BookingCode` y un solo `TotalFare`. El `BookingCode` va en `provider.offerRef`.
La moneda sale de `HotelResult[].Currency`, sin valor por defecto. Los importes se aceptan como número o string y
se convierten con aritmética decimal exacta. Un pack inválido se descarta y se cuenta; un `HotelResult` sin moneda,
también. `201` es lista vacía.

**Fuente.** p. 13-18 (VERIFICADO-PDF); [02](./02-search-y-oferta-canonica.md) §8.3, §9, §10, §13.

**CA.**

1. Los ejemplos 6.2.1 y 6.2.2 (p. 15-18), normalizados, producen packs válidos; dos habitaciones son un pack con
   dos `rooms`.
2. `HotelResult` sin `Currency` → descartado y medido. Nunca `'USD'` por defecto.
3. `"17.22"` y `17.22` producen el mismo `Money`; un importe negativo invalida solo ese pack.
4. Una moneda con exponente ISO 4217 distinto de 2 deja a TBO no disponible para esa cuenta, con motivo (D-TBO-15).
5. El literal de `TotalFare` se conserva en el contexto del servidor, no en el pack público.
6. Los tipos crudos de TBO no se exportan del paquete (guard de superficie).

**Depende de.** RF-35.

#### RF-08 — Contexto de búsqueda en el servidor

**Enunciado.** Cada Search guarda en el servidor, indexado por `(tenantId, searchId)` y con vencimiento igual al de
la oferta: `CheckIn`, `CheckOut`, `PaxRooms`, `GuestNationality`, `searchSentAt`, la huella de la cuenta que buscó
(id y `updatedAt`, nunca el secreto) y, por pack, el `BookingCode` y el literal de `TotalFare`. El pack viaja como
`provider = { name: 'tbo-hotels', offerRef: BookingCode, raw: { searchId } }`. PreBook y Book solo aceptan un
`BookingCode` que pertenezca a un contexto vigente del mismo tenant.

**Fuente.** PreBook recibe solo `BookingCode` y `PaymentMode` (p. 19); el Book no lleva fechas, edades ni
nacionalidad (p. 32-34); VERIFICADO-PDF. [02](./02-search-y-oferta-canonica.md) §9.3; [03](./03-prebook-y-book.md)
§3.1; §9 C-11.

**CA.**

1. Un `searchId` de otro tenant no resuelve.
2. Un `BookingCode` fuera del contexto → 400 sin llamar a TBO.
3. Si la cuenta resuelta al reservar no es la que buscó (rotación o cambio de heredada a propia), se pide volver a
   buscar.
4. El navegador no aporta ninguna ocupación ni importe que llegue a TBO.
5. `provider.raw` no lleva PII (`packages/canonical/src/offer.ts:83-84`, VERIFICADO-CODIGO según
   [02](./02-search-y-oferta-canonica.md) §9.3).

**Depende de.** RF-07, RNF-06.

#### RF-09 — Ventana de 30 minutos de Search a Book

**Enunciado.** `expiresAt = searchSentAt + 27 min` (30 min − 120 s de Book − 60 s de margen). Pasado `expiresAt`
no se llama a PreBook ni se encola el Book: el adapter lanza `TboOfferExpiredError` sin tocar TBO. Un acierto de
caché conserva el `searchSentAt` original. La UI muestra el tiempo restante y avisa a los 20 minutos. Un `315`
invalida el contexto.

**Fuente.** "from search to book, the timeout is 30 minutes" (p. 8); `315 BOOKINGCODE_EXPIRED` (p. 9);
VERIFICADO-PDF. [01](./01-autenticacion-conectividad-y-errores.md) §6; §9 C-17.

**CA.**

1. Con reloj falso: PreBook en el minuto 27:01 → `TboOfferExpiredError` y cero llamadas a `fetch`.
2. Un `315` muestra "La cotización venció…" e invalida el contexto.
3. El link de pago del checkout vence antes de `expiresAt` (RF-23).

**Depende de.** D-TBO-21. → [Q-29](./10-preguntas-para-tbo.md#q-29) (inicio del reloj; si PreBook lo renueva).

#### RF-10 — Suplementos visibles y nunca sumados

**Enunciado.** Los suplementos `AtProperty` se modelan como lista por habitación y en su propia moneda
(`atPropertyCharges[]`); los `Included` son informativos. Un `Type` desconocido se trata como `AtProperty`. Nunca se
suman al total ni se convierten de moneda. Se ven en la tarjeta (indicador), el detalle, el paso previo a confirmar,
el mensaje de WhatsApp antes de confirmar y el voucher. El servidor rechaza el Book si el snapshot aceptado tiene
`AtProperty` y la petición no trae `atPropertyAcknowledged: true`.

**Fuente.** `Supplements` y "Please ensure same are visible to end customer" (p. 14-15, 23, 48); KP-4 (p. 71);
VERIFICADO-PDF. Caso 7 (Cert, Integration on Test Account), VERIFICADO-CERT. [02](./02-search-y-oferta-canonica.md)
§9.7; [03](./03-prebook-y-book.md) §2.6.

**CA.**

1. Fixture de p. 17: dos cargos `AED 20.00` con `Index` 1 y 2; el total del pack no cambia.
2. Book sin `atPropertyAcknowledged` con `AtProperty` → 400 sin llamar a TBO.
3. Se aceptan array de arrays y array plano.
4. Guarda G-11 del arnés en el caso 7.

**Depende de.** RF-15, RF-39. → [Q-27](./10-preguntas-para-tbo.md#q-27) (unidad de `Price`).

#### RF-11 — Atributos de la tarifa sin datos inventados

**Enunciado.** Políticas de cancelación con `FromDate` local sin offset más el literal, tramo, importe fijo,
índice de habitación y origen (`none`, `search-indicative`, `prebook-final`); `IsRefundable` y tramos se guardan sin
derivar uno del otro. `MealType` → `BoardType` con etiqueta y literal (10 valores, tolerante a casing). Promociones
por habitación, traslados, `Inclusion` sin partir. `ExtraGuestCharges` solo informativo, visible solo para el
vendedor y nunca sumado. `RoomID` distinto de 0 como `roomTypeId`.

**Fuente.** p. 13-15, 24, 28, 50, 57, 69-70 (VERIFICADO-PDF); [02](./02-search-y-oferta-canonica.md) §9.4, §9.6,
§9.8, §9.9.

**CA.**

1. `IsRefundable: true` sin tramos → `partially_refundable` con origen `none`; nunca `fully_refundable` sin haber
   visto los tramos.
2. `Breakfast_For_1` → `BB` con la etiqueta "Desayuno para 1 persona".
3. `MealType` desconocido → `RO` y métrica `tbo.unknown_meal_type`.
4. `ExtraGuestCharges` no aparece en ningún total ni en la vista del viajero.

**Depende de.** RF-35, D-TBO-19. → [Q-24](./10-preguntas-para-tbo.md#q-24), [Q-22](./10-preguntas-para-tbo.md#q-22) (zona horaria de `FromDate`; `ExtraGuestCharges`).

#### RF-12 — Piso de precio `RecommendedSellingRate`

**Enunciado.** `RecommendedSellingRate` se parsea como `minimumSellingPrice` en la moneda del pack. Después de la
cascada, `finalMinor = max(finalMinor_cascada, minimumSellingPrice)`. La diferencia entra al `breakdown` como paso
propio (`ruleType: 'provider_floor'`) atribuido al tenant que vende. Aplica también cuando el tenant no tiene
reglas. Se vuelve a aplicar con el valor de PreBook. Ningún precio manual ni descuento baja del piso, tampoco el
componente hotel de un paquete. El alcance por canal es el de D-TBO-16 (recomendada: todo canal).

**Fuente.** "The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the
response, if any" (p. 13; también p. 21), VERIFICADO-PDF. [02](./02-search-y-oferta-canonica.md) §9.5.

**CA.**

1. Ejemplo de [02](./02-search-y-oferta-canonica.md) §9.5: neto 305.75, +3 % y +1 % → 318.07, piso 321.34 →
   precio 321.34 y aporte de 3.27 atribuido a la agencia.
2. Tenant sin reglas: el precio de venta es el piso si el piso supera al neto.
3. La vista del consolidador (`toTenantView`) no cuenta el paso `provider_floor` como margen suyo.
4. CK-09 visible en el portal.

**Depende de.** D-TBO-16, RF-35. → [Q-23](./10-preguntas-para-tbo.md#q-23) (alcance B2B2C y paquetes).

#### RF-13 — Puerta de moneda en la vertical de hoteles

**Enunciado.** El servicio de hoteles, y no el ACL, descarta los packs en una moneda distinta de la moneda de venta
de la búsqueda y lo informa por proveedor. El vendedor puede cambiar la moneda de la búsqueda. No hay conversión. Los
suplementos quedan fuera de la puerta. Desaparece el `'USD'` silencioso.

**Fuente.** `Currency`: "Configured currency in the API profile of the client" (p. 13), VERIFICADO-PDF.
Hoy hoteles envía la moneda del tenant, que TBO no recibe (`apps/api/src/hotels/hotels.service.ts:109`), y vuelos ya
tiene la puerta (`apps/api/src/search/search.service.ts:70-109`), VERIFICADO-CODIGO. [02](./02-search-y-oferta-canonica.md) §8.

**CA.**

1. Todos los packs TBO en USD y búsqueda en COP → TBO aparece con el motivo "TBO cotiza en USD", no como "sin
   disponibilidad".
2. Al cambiar la búsqueda a USD, los packs aparecen.

**Depende de.** D-TBO-15. → [Q-88](./10-preguntas-para-tbo.md#q-88) (monedas por perfil).

#### RF-14 — Códigos por búsqueda y resultado por proveedor

**Enunciado.** La resolución destino → hoteles es por proveedor (`resolveCityHotelIds(providerCode, destino,
límite)`), filtra `active = true`, ordena por relevancia y usa el límite que declara el proveedor. La respuesta pasa
a `{ hotels, providers[] }` con estado por proveedor (`ok`, `empty`, `error`, `skipped`) y motivo, más el booleano
`showProviderInResults` fuera de la carga (RF-40). Una búsqueda del vendedor cuenta una vez en la cuota aunque haya
varios lotes o proveedores.

**Fuente.** "Recommended Value; 100 hotel codes" (p. 10), VERIFICADO-PDF. Hoy son los 50 primeros hoteles de
Despegar ordenados por id (`apps/api/src/hotels/hotels.service.ts:131-141`), VERIFICADO-CODIGO.
[02](./02-search-y-oferta-canonica.md) §4; [06](./06-seams-integracion-repo.md) §5.6.

**CA.**

1. TBO y Despegar consultan `hotel_inventory` con su propio `provider_code`.
2. `201` → estado `empty`; un error de TBO → estado `error` con motivo humanizado, y los resultados de Despegar se
   muestran igual.
3. Si se usan lotes (D-TBO-17 opción B), un lote fallido marca el resultado como parcial y visible.

**Depende de.** D-TBO-17, RF-33.

### C. PreBook y Book

#### RF-15 — PreBook y primera comparación de precio

**Enunciado.** PreBook envía `{ "BookingCode", "PaymentMode": "Limit" }` validado con Zod `.strict()`. La respuesta
exige exactamente un `HotelResult` con el `HotelCode` del contexto y un elemento en `Rooms`; `CreditCardBillingOptions`
se descarta. Se compara contra el contexto de búsqueda (C1: `TotalFare`, `Currency`, `IsRefundable`, `MealType`,
conjunto de `AtProperty`) con resultado `UNCHANGED`, `DECREASED`, `INCREASED` o `CONDITIONS_CHANGED`; se aplica el
waterfall `hotels` sobre el neto nuevo; se guarda en el servidor el snapshot aceptable, y un cambio emite
`HotelOfferRepriced`.

**Fuente.** p. 19-32, 71 (VERIFICADO-PDF); Postman: PreBook (VERIFICADO-POSTMAN); [03](./03-prebook-y-book.md) §2.

**CA.**

1. El cuerpo serializado tiene la forma exacta del request `PreBook` de Postman.
2. Si la respuesta trae otro `BookingCode`, se usa el de PreBook y se emite una alerta.
3. Comparación decimal exacta, sin tolerancia; todo resultado distinto de `UNCHANGED` se muestra antes de seguir.
4. `201`/`207` invalidan la oferta; `315` invalida el contexto; un `429`, un `500` o una conexión rechazada admiten
   un reintento solo si el total no pasa de 23 s; un timeout no se reintenta (§9 C-24).

**Depende de.** RF-08, RF-12, D-TBO-20. → [Q-30](./10-preguntas-para-tbo.md#q-30) (si el `BookingCode` de PreBook puede cambiar).

#### RF-16 — `RateConditions` como texto plano con señales críticas

**Enunciado.** Cada ítem de `RateConditions` se convierte a texto plano con el algoritmo de
[03](./03-prebook-y-book.md) §2.4: decodificación de entidades **una sola vez**, etiquetas eliminadas, URLs como
texto, clasificación por prefijo y señales críticas como códigos cerrados (tarifa solo paquete, sin cambio de nombre,
restricción de mercado). Se persisten el original y el saneado. El HTML del proveedor nunca se renderiza.

**Fuente.** p. 23, 25-26, 30-32, 51, 71 (VERIFICADO-PDF); [03](./03-prebook-y-book.md) §2.4.

**CA.**

1. `&amp;lt;script&amp;gt;` termina como el texto `&lt;script&gt;`, nunca como etiqueta activa.
2. Ningún componente web usa `dangerouslySetInnerHTML` con este contenido (test de búsqueda).
3. Las señales críticas se muestran arriba en el paso previo a confirmar y el bot las enuncia.

**Depende de.** RF-39. → [Q-32](./10-preguntas-para-tbo.md#q-32) (formato y encoding de `RateConditions`).

#### RF-17 — Tarifas "solo con billete aéreo"

**Enunciado.** El ACL detecta sobre el texto saneado la restricción "should be sold only with an airline ticket as
part of a package" con un patrón conservador y la marca en la oferta (`PACKAGE_WITH_FLIGHT_ONLY`). Con la opción
recomendada de D-TBO-22, el servidor rechaza el Book de un hotel suelto con esa marca (`TboPackageOnlyRateError`).
Cada detección, y cada texto con "package" que no la disparó, se cuentan en métricas.

**Fuente.** p. 25, 30 (VERIFICADO-PDF: solo como texto, sin campo estructurado); [03](./03-prebook-y-book.md) §2.11.

**CA.** El fixture de p. 25/30 produce la marca; el Book suelto se rechaza con mensaje de negocio.

**Depende de.** D-TBO-22. → [Q-31](./10-preguntas-para-tbo.md#q-31) (indicador estructurado; consecuencia contractual).

#### RF-18 — Huéspedes y contacto del Book

**Enunciado.** Antes de insertar el intent: un `CustomerDetails` por habitación, en el orden de `PaxRooms`; en cada
habitación, tantos `Adult` y `Child` como diga el contexto, con un adulto primero; **todos los huéspedes con
nombre**; `Title` en `Mr`, `Mrs` o `Ms`, elegido explícitamente; nombres normalizados según D-TBO-23, de 2 a 40
caracteres, sin dígitos y sin duplicados exactos en la misma reserva. `EmailId` y `PhoneNumber` según D-TBO-23; el
teléfono va solo con dígitos y prefijo de país, sin `+`. Los nombres originales quedan en `orders.passengers`.

**Fuente.** p. 32-36, 39 (VERIFICADO-PDF); `"Title": "Dr"` (Postman: HotelBook, VERIFICADO-POSTMAN);
[03](./03-prebook-y-book.md) §3.2, §3.5.

**CA.**

1. Casos 5 y 6: el orden de habitaciones se conserva de Search a Book (guarda G-7 del arnés, [07](./07-certificacion.md) §6.7).
2. `Dr` se rechaza hasta que TBO lo confirme.
3. Con la opción recomendada, `José Muñoz` sale como `Jose Munoz` y el original queda para el voucher.
4. Dos huéspedes idénticos en la misma reserva → 400 con un mensaje que pide distinguirlos.

**Depende de.** D-TBO-23. → [Q-41](./10-preguntas-para-tbo.md#q-41), [Q-42](./10-preguntas-para-tbo.md#q-42), [Q-43](./10-preguntas-para-tbo.md#q-43) (títulos, caracteres, largo, nombres de niños).

#### RF-19 — Referencias de la reserva

**Enunciado.** `BookingReferenceId` se genera en el servidor con un generador criptográfico: `ST` + un carácter de
entorno + 17 caracteres Crockford base32, 20 en total. Se guarda en `orders.provider_booking_ref`, con índice único
`(provider, provider_booking_ref)` **entre todos los tenants**, en la misma transacción que el intent `pending`. Hay
uno por request de Book y nunca se reutiliza. `ClientReferenceId` lleva el mismo valor. **No se deriva del
`Idempotency-Key`**, que solo es único por tenant.

**Fuente.** `ClientReferenceId`, `BookingReferenceId` (p. 33); v1.4 (p. 5); "Unique booking reference ID" (p. 43);
`ClientReferenceNumber` (p. 64); VERIFICADO-PDF. `create_request_key` es `q:`/`c:` + UUID por tenant
(`apps/api/src/orders/orders.service.ts:166-178`), VERIFICADO-CODIGO. [03](./03-prebook-y-book.md) §3.3, §8.4;
§9 C-08, C-09.

**CA.**

1. Dos sub-agencias que heredan la misma cuenta TBO no pueden generar la misma referencia (test del índice).
2. Un nuevo intento del vendedor, si D-TBO-24 lo permite, crea otra referencia.
3. Si el proceso muere después del insert y antes de la respuesta del Book, el barrido encuentra la referencia.

**Depende de.** RF-20. → [Q-34](./10-preguntas-para-tbo.md#q-34), [Q-35](./10-preguntas-para-tbo.md#q-35) (formato, largo, unicidad, idempotencia del Book).

#### RF-20 — Orden con intent antes del Book

**Enunciado.** `POST /hotels/book` recibe `Idempotency-Key`, la referencia del snapshot aceptado, `acceptedTotal`,
`atPropertyAcknowledged`, huéspedes por habitación y contacto. Valida huéspedes (RF-18) y ventana (RF-09); inserta la
orden `pending` con `create_request_key`, `provider_booking_ref`, `provider_account_id`, el marcador de conciliación
pendiente y `search_criteria.vertical = 'hotels'`, a través de una API pública de intent en `OrdersService`; repite
PreBook (C2) y recalcula el precio de venta contra `acceptedTotal` (409 si sube o cambian las condiciones); emite
`OrderCreateRequested`; llama al Book (120 s, un intento, **nunca** como job de `post-sale-retry`); clasifica el
resultado en confirmado, fallido o incierto ([03](./03-prebook-y-book.md) §3.9); consolida con CAS
(`status = 'pending' AND provider_raw IS NULL`) y lista blanca en `provider_raw`; y cierra con `BookingDetail` por
`ConfirmationNumber`.

**Fuente.** p. 8, 33, 40-42 (VERIFICADO-PDF). Hoy `recordExternalOrder` persiste **después** del proveedor
(`apps/api/src/orders/orders.service.ts:274-280`) y el intent de vuelos es privado (`insertCreateIntent`, `:694`),
VERIFICADO-CODIGO. [03](./03-prebook-y-book.md) §3.9, §8.3; [06](./06-seams-integracion-repo.md) §5.5.

**CA.**

1. El mismo `Idempotency-Key` → 409 `duplicateRequest`, sin segunda llamada a TBO.
2. Fallo definitivo (`207`, `315`, `300`, `402`, `400`, `401`, `201`) → `failed`, clave liberada, evento
   `OrderCreated` con desenlace `FAILED` (§9 C-19).
3. Desenlace incierto → `pending`, `OrderCreateFailed` con `uncertain: true` y recuperación (RF-21).
4. Rechazo del breaker después del insert → cierre como fallo previo al envío y clave liberada.
5. `tbo-hotels` está en `NO_ES_VUELOS` (`apps/api/src/orders/order-provider-dispatch.guard.test.ts:50`, hoy solo
   `agent-cars` y `despegar-hotels`, VERIFICADO-CODIGO).
6. `Book.TotalFare` es el `TotalFare` del PreBook de C2 (guarda G-8 del arnés, [07](./07-certificacion.md) §6.7; CK-11).

**Depende de.** D-TBO-07, D-TBO-20, D-TBO-21, RF-38.

#### RF-21 — Recuperación obligatoria tras un Book incierto

**Enunciado.** Ante timeout, error de red o HTTP, `405`, `500`, `429`, cuerpo ilegible o `200` sin
`ConfirmationNumber`, se encola `verify-hotel-booking` con retardo de 120 s **contados desde el fallo observado**
(`tf`). Llama a `BookingDetail` con `{ "BookingReferenceId", "PaymentMode": "Limit" }` a `tf + 120 s`, `+5 min`,
`+15 min` y `+60 min`. Los errores de transporte se reintentan dentro del paso. Si encuentra la reserva, consolida
con CAS y emite `OrderCreationVerified` (`recoveredBy: 'booking-reference'`). Si no la encuentra tras el calendario,
el desenlace es el de D-TBO-24. **Nunca** se reenvía el Book automáticamente. Un barrido durable recoge los intents
`pending` de más de 120 s sin job vivo.

**Fuente.** "In case of timeout/failure/http/network related error in book response then it is mandatory to call
the BookingDetail method by using BookingReferenceId after 120 seconds of book response" (p. 42), VERIFICADO-PDF.
[03](./03-prebook-y-book.md) §4; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7; §9 C-06.

**CA.**

1. Con reloj falso, la primera lectura sale a `tf + 120 s`, no antes.
2. Si el proceso muere entre el insert y la respuesta del Book, el barrido ejecuta el paso que corresponda.
3. Sin Redis, `OrderEscalated` queda con `queued: false` y el barrido lo recoge.
4. Cero llamadas a `/Book` después de `tf`, en cualquier rama (espía).
5. La sonda PR-05 captura la forma real de "no existe" y el esquema se ajusta.

**Depende de.** RF-38, D-TBO-24. → [Q-37](./10-preguntas-para-tbo.md#q-37), [Q-38](./10-preguntas-para-tbo.md#q-38), [Q-36](./10-preguntas-para-tbo.md#q-36) (respuesta de "no existe"; desde cuándo se cuentan los 120 s;
`405`).

#### RF-22 — Book híbrido para el navegador

**Enunciado.** El handler espera hasta 25 s (configurable): si la saga termina, responde `201` con la orden; si no,
`202` con `{ orderId, status: 'pending' }`, y la web consulta `GET /orders/:id`. La ruta proxy de la web reenvía
`Idempotency-Key` y el cuerpo de error completo (valores nuevos de un 409, `retryForbidden`,
`reconciliationRequired`). El contenedor `api` tiene un periodo de gracia de parada de al menos 130 s y apagado
ordenado.

**Fuente.** Book 120 s (p. 8), VERIFICADO-PDF. Corte de Cloudflare a los 100 s: INFERIDO
([03](./03-prebook-y-book.md) §4.5). La web ya trata el 524 como "puede haberse creado"
(`apps/web-b2b/src/lib/read-json.ts:35-36`) y `infrastructure/hostinger/docker-compose.prod.yml` no declara
`stop_grace_period` (búsqueda sin resultados), VERIFICADO-CODIGO.

**CA.**

1. Un Book simulado de 60 s devuelve `202` y luego el estado confirmado, sin 524.
2. Un doble clic produce un solo intent.
3. Un despliegue durante un Book termina dentro del periodo de gracia o pasa por RF-21.

**Depende de.** D-TBO-09.

#### RF-23 — Cobro y crédito `Limit`

**Enunciado.** Con la opción recomendada de D-TBO-21: antes del Book se toma una retención en la cartera o el
crédito de la agencia que vende, reutilizando el mecanismo de retención existente, que opera sobre una orden ya
persistida (`holdBooking`, `apps/api/src/portfolios/portfolios.service.ts:339`, VERIFICADO-CODIGO); se libera ante un
fallo definitivo o una cancelación y se mantiene mientras el desenlace sea incierto. En los canales donde paga el
viajero, la autorización del checkout alojado termina antes del Book y el link vence antes de `expiresAt`. Si la
cuenta TBO es heredada, un límite interno por sub-agencia se controla antes del Book. Un `300` avisa al titular de
la cuenta sin mostrar su saldo a la sub-agencia.

**Fuente.** `300 INSUFFICIENT_BALANCE` (p. 9) y `Limit` (p. 33), VERIFICADO-PDF; que `Limit` consuma el crédito del
titular es INFERIDO ([03](./03-prebook-y-book.md) §7.4). `tenants.credit_limit`
(`db/migrations/0007_tenant_business_rules.sql:5`), VERIFICADO-CODIGO.

**CA.**

1. Sub-agencia sin crédito interno suficiente → Book rechazado antes de llamar a TBO.
2. Fallo definitivo → retención liberada; incierto → retención mantenida hasta resolver.
3. TTL del link de pago < `expiresAt − ahora`.

**Depende de.** D-TBO-21, D-TBO-03. → [Q-90](./10-preguntas-para-tbo.md#q-90) (si todas las cuentas, incluidas las BYOC, operan con `Limit`).

### D. Post-venta

#### RF-24 — Lecturas con `BookingDetail`

**Enunciado.** Cada request lleva exactamente uno de `ConfirmationNumber` o `BookingReferenceId`, más
`PaymentMode: "Limit"`. El esquema de respuesta es tolerante ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
§3.7): `BookingStatus` como string abierto normalizado por una función pura (`Vouchered` equivale a `Confirmed`; un
valor desconocido escala sin cambiar el estado), `VoucherStatus` booleano o string, `HotelConfirmationNumber`
opcional (`""` = sin HCN), `Rooms` en sus dos formas posibles. `CustomerNames` nunca se loguea ni se copia a
`provider_raw` ni a eventos. Un `200` sin `BookingDetail` es error de mapeo.

**Fuente.** p. 42-51, 64, 70-71 (VERIFICADO-PDF); [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3, §6.3.

**CA.**

1. El ejemplo de p. 49-51, con las comillas tipográficas normalizadas, parsea; el `BookingDate` malformado no rompe.
2. `CancelledAndRefundAwaited` se reconoce como cancelada antes de llegar a `OrderView.status`
   ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §12).
3. Un logger espía no recibe ningún `FirstName`.

**Depende de.** RF-26. → [Q-48](./10-preguntas-para-tbo.md#q-48), [Q-46](./10-preguntas-para-tbo.md#q-46) (lista completa de `BookingStatus`; forma multi-habitación).

#### RF-25 — Cancelación

**Enunciado.** Secuencia de [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.4: claim durable
existente; lectura previa (ya cancelada → éxito idempotente; en curso → no se envía); `POST /Cancel` solo con
`ConfirmationNumber`, 60 s, sin reintento; lectura posterior. Un `200` significa **cancelación aceptada** y el estado
final lo fija la lectura. Un `479` vuelve como `{ success: false }` sin lanzar, y la lectura posterior decide (§9
C-05). Si esa lectura falla, se agenda `verify-cancellation`, de solo lectura, y **nunca** se reenvía el Cancel.
Todo otro desenlace de `/Cancel` (timeout, 5xx, `429`, `401`, `402`, `400`, códigos de otras operaciones o cuerpo
ilegible) → `UNVERIFIED` con `verify-cancellation` (§9 C-04). Si el limitador de la cuenta no despacha la lectura
previa o el Cancel, no salió nada y la cancelación se reintenta. La petición espera hasta 45 s; después responde
"Cancelación en curso" y la cancelación sigue con su claim. Antes de confirmar se
muestra la penalidad estimada con el snapshot de PreBook. `refundAmount` queda vacío para TBO. La UI no ofrece
cancelar una habitación suelta ni cancelar desde el día de check-in.

**Fuente.** p. 9, 41-42, 70-71 (VERIFICADO-PDF); política de cancelación del repo
(`apps/api/src/orders/cancel-retry-policy.ts:84-136`, VERIFICADO-CODIGO).

**CA.**

1. `479` con lectura `Confirmed` → la orden vuelve a su estado previo y se emite `OrderCancellationAttempted` con
   `success: false`.
2. `200` con lectura `CancellationInProgress` → según D-TBO-25.
3. Timeout en `/Cancel` → `UNVERIFIED` y cero segundos Cancel (espía).
4. Fallo de la lectura previa → fallo previo al envío y reintentable (con el `jobId` corregido, RF-38).
5. CK-15 visible en el zip y en el portal.

**Depende de.** D-TBO-25, D-TBO-26, RF-26, RF-38. → [Q-49](./10-preguntas-para-tbo.md#q-49), [Q-50](./10-preguntas-para-tbo.md#q-50) (semántica de `200` y `479`; idempotencia).

#### RF-26 — Estado de la orden y subestado del proveedor

**Enunciado.** `orders.status` conserva su vocabulario (`pending`, `confirmed`, `cancelled`, `failed`; `ticketed`
nunca en hoteles). Una tabla satélite con `tenant_id` y RLS forzada guarda el `BookingStatus` crudo, el momento y la
fuente de la última lectura, el subestado (`create-pending`, `create-uncertain`, `create-not-found-yet`,
`cancel-requested`, `cancel-unverified`, `unverified-read`, `unknown`), `InvoiceNumber` y los campos del HCN. El
mapeo es el de [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.3. La API expone subestado, estado del
proveedor y HCN, sin PII.

**Fuente.** p. 45, 64, 70-71 (VERIFICADO-PDF); [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6, §11.

**CA.** La tabla de §6.3 de [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) es un test de una función
pura; un `BookingStatus` desconocido escala sin cambiar el estado; ningún evento lleva PII.

**Depende de.** D-TBO-25.

#### RF-27 — Seguimiento del HCN

**Enunciado.** `hcnPlan(bookedAt, checkInInstant)` es una función pura ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
§8.3) con intervalos `[a, b)` y cuatro lecturas (la inicial y tres reintentos); una reserva con check-in a más de
30 días entra en ventana a `check-in − 720 h`. La fila de Postgres es la fuente de verdad y el job `hcn-check` la
despierta. "Todavía sin HCN" no lanza. Agotados el SLA y los reintentos se emite `HotelConfirmationNumberMissing` y se
crea la tarea de operaciones de D-TBO-27. El seguimiento se detiene si la reserva se cancela, si pasa el check-in o
si llega el HCN. Un HCN de relleno (`NA`, `Pending`, `0`…) es "todavía sin HCN" (PV-05). Si el HCN llega con la tarea
abierta, por cualquier lectura, la tarea se cierra sola con su motivo; si la orden pasa a `cancelled`, también, en la
transacción de ese cambio. Solo se sigue el HCN de los proveedores que declaran la capacidad `hcn`.

**Fuente.** Tabla P0-P5, "Retry every 1 hour", "Maximum 3 retries", "raise an operations ticket" (p. 42-43),
VERIFICADO-PDF.

**CA.** Los ejemplos E1-E4 de [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.4 son tests; la tarea
de operaciones no copia PII; un relleno no corta el seguimiento; el HCN que llega cierra la tarea abierta en la misma
transacción; la orden que pasa a `cancelled` (cancelación, `verify-cancellation` o conciliación) corta el plan y cierra
la tarea abierta en la misma transacción, con motivo `order-cancelled`; una orden de un proveedor sin la capacidad
`hcn` no abre plan.

**Depende de.** D-TBO-27, D-TBO-29, RF-38. → [Q-54](./10-preguntas-para-tbo.md#q-54), [Q-55](./10-preguntas-para-tbo.md#q-55) (límites de tramo; número de reintentos; canal del
ticket).

#### RF-28 — Conciliación diaria por cuenta

**Enunciado.** Una corrida diaria por `provider_accounts.id`, no por tenant: tramo A `[D−2, D]` y tramo B para las
reservas activas, en ventanas de hasta 60 días, con `FromDate`/`ToDate`. Toda fila devuelta tiene que tener
`BookingDate` dentro de la ventana o la corrida se descarta. Cruce por `ConfirmationNo` y después por
`ClientReferenceNumber`; confirmación con `BookingDetail` antes de cambiar cualquier estado; discrepancias R1-R8 de
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9.4. Solo lectura. `TripName` se descarta. Ningún
resultado sale del subárbol del tenant dueño de la cuenta.

**Fuente.** p. 6, 62-64 (VERIFICADO-PDF); [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5, §9.

**CA.** Una fila fuera de ventana invalida la corrida; R4 nunca reenvía un Cancel; test de aislamiento de
[06](./06-seams-integracion-repo.md) §7.5 (última fila).

**Depende de.** RF-29, D-TBO-24, D-TBO-27, D-TBO-29. → [Q-57](./10-preguntas-para-tbo.md#q-57), [Q-56](./10-preguntas-para-tbo.md#q-56), [Q-05](./10-preguntas-para-tbo.md#q-05) (qué fecha filtra; zona horaria; grafía de
campos y path).

#### RF-29 — La post-venta usa la cuenta que creó la reserva

**Enunciado.** El intent guarda `orders.provider_account_id` (columna genérica) y el origen de la credencial.
`BookingDetail`, `Cancel` y la conciliación usan siempre esa cuenta. No se puede borrar ni desactivar una cuenta con
reservas activas. Toda operación por id pasa antes por la fila de `orders` leída con RLS del tenant.

**Fuente.** Hoy los factories resuelven la cuenta vigente del tenant en cada llamada
(`db/migrations/0012_provider_accounts.sql:66-76`, VERIFICADO-CODIGO). [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
§11 (PV-15); [06](./06-seams-integracion-repo.md) §5.5 punto 6.

**CA.**

1. Una agencia que pasa de cuenta heredada a propia sigue cancelando sus reservas viejas con la cuenta anterior.
2. Borrar una cuenta con reservas activas se rechaza con mensaje.
3. La agencia B no lee ni cancela una orden de la agencia A aunque compartan la cuenta TBO heredada.

**Depende de.** D-TBO-28. → [Q-59](./10-preguntas-para-tbo.md#q-59) (si los métodos de post-venta operan solo sobre reservas de la misma cuenta).

### E. Contenido estático

#### RF-30 — Sincronización del catálogo TBO

**Enunciado.** Herramienta `tools/sync-tbo-hotel-inventory` con las etapas E0-E6 de
[05](./05-contenido-estatico-e-inventario.md) §6.3: variables de entorno validadas con Zod; lock consultivo;
presupuesto por corrida y reanudación por `hotel_provider_city.synced_at`; upsert y barrido por ciudad en
transacciones cortas, con guarda de caída máxima; **nunca `DELETE`**; corte ordenado ante `429`; salida `skip` sin
credenciales y kill-switch `TBO_SYNC_ENABLED`; logs JSON con contadores. Usa el cliente de contenido del ACL, que no
expone métodos de venta.

**Fuente.** p. 51-69, 71 (VERIFICADO-PDF); [05](./05-contenido-estatico-e-inventario.md) §5-§6.

**CA.**

1. Una corrida cortada deja intacto el catálogo anterior.
2. Una ciudad que pierde más hoteles que el umbral no se barre y registra la anomalía.
3. Si `hotelcodelist` falla, E5 se desactiva sin afectar E1-E4.
4. Ninguna línea de log contiene `Authorization`.

**Depende de.** D-TBO-04, D-TBO-11, D-TBO-12, RF-31. → [Q-10](./10-preguntas-para-tbo.md#q-10), [Q-69](./10-preguntas-para-tbo.md#q-69), [Q-63](./10-preguntas-para-tbo.md#q-63) (QPS de estáticos; deltas; qué devuelve
`TBOHotelCodeList` con `IsDetailedResponse` en `false`).

#### RF-31 — Modelo de datos del catálogo multi-proveedor

**Enunciado.** Migración M1 (§9 C-10): `hotel_inventory` gana `provider_city_code TEXT`, `active` y `last_seen_at`;
tablas nuevas `hotel_provider_city`, `hotel_destination_map`, `hotel_match`, `hotel_content` y `hotel_room_content`,
globales, sin RLS y con `GRANT SELECT` a `app_user`.

**Fuente.** [05](./05-contenido-estatico-e-inventario.md) §7; esquema actual en
`db/migrations/0022_hotel_inventory.sql:6-21` (VERIFICADO-CODIGO según [05](./05-contenido-estatico-e-inventario.md) §7.1).

**CA.** El job de Despegar sigue haciendo su `DELETE` + `INSERT` sin tocar filas `tbo-hotels`; la migración pasa en
CI con `pg_trgm` y `unaccent`.

**Depende de.** D-TBO-11.

#### RF-32 — Normalización y saneo del contenido

**Enunciado.** El borde Zod acepta lo observado además de lo declarado y entrega un solo tipo canónico
([05](./05-contenido-estatico-e-inventario.md) §3). El HTML de `Description` y `Attractions` se sanea con lista
blanca al ingerir; se deriva texto plano para WhatsApp; los servicios negados ("… – no") no se muestran como
disponibles; las imágenes se guardan como URL `https`; los horarios pasan a `HH:mm`. El enlace por `RoomID` queda
apagado hasta tener un fixture real.

**Fuente.** p. 52-69 (VERIFICADO-PDF); [05](./05-contenido-estatico-e-inventario.md) §3-§4.

**CA.** `"ThreeStar"` y `5` → 3 y 5; `Map` `"0|0"` → sin coordenadas; una etiqueta `script` se elimina al ingerir.

**Depende de.** RF-31. → [Q-68](./10-preguntas-para-tbo.md#q-68), [Q-66](./10-preguntas-para-tbo.md#q-66), [Q-67](./10-preguntas-para-tbo.md#q-67) (`HotelRating`; idiomas; imágenes).

#### RF-33 — Resolución de destino a `CityCode` de TBO

**Enunciado.** Con la opción recomendada de D-TBO-10: `hotel_destination_map` se calcula fuera de línea (etapa E6)
por solapamiento de hoteles equivalentes y distancia de centroides; solo se usan filas `accepted`; una fila `manual`
nunca se pisa. Un destino sin mapeo aceptado **no consulta TBO** y el proveedor figura como omitido por "sin mapeo de
destino", sin contar como error.

**Fuente.** [05](./05-contenido-estatico-e-inventario.md) §8. El destino de hoy es el id geográfico de Despegar
(`apps/api/src/hotels/hotels.schemas.ts:27`, VERIFICADO-CODIGO según [05](./05-contenido-estatico-e-inventario.md) §8.1).

**CA.** Una fila `ambiguous` no se usa; la omisión no suma al breaker; un destino solo de Despegar no cambia.

**Depende de.** D-TBO-10, RF-34.

#### RF-34 — Deduplicación entre proveedores

**Enunciado.** Con la opción recomendada de D-TBO-13: heurística conservadora (≤ 150 m, similitud trigram ≥ 0,5,
estrellas ± 1, candidato único) que escribe en `hotel_match`; la tarjeta agrupa por `canonical_hotel_id` y **fusiona
tarifas** en lugar de descartar las más caras; cada tarifa lleva su proveedor y, con la divulgación encendida, su
propia pastilla (RF-40 CA 5). En detalle, PreBook y confirmación se muestran siempre el nombre, la dirección y las
imágenes **del proveedor que vende la tarifa**.

**Fuente.** [05](./05-contenido-estatico-e-inventario.md) §9.

**CA.** Dos candidatos → `review`; una tarjeta agrupada muestra las dos tarifas; el PreBook de una tarifa TBO muestra
los datos de TBO.

**Depende de.** D-TBO-13.

### F. Integración en la plataforma

#### RF-35 — Contrato neutral de hotel y puertos

**Enunciado.** `packages/canonical/src/hotel-offer.ts` define con Zod el contrato neutral, con todo lo que
[02](./02-search-y-oferta-canonica.md) §13.2 lista como faltante: referencia de proveedor a nivel de pack, cargos en
destino por habitación y en su moneda, precio mínimo de venta, ocupación por habitación, vencimiento, políticas con
fecha local, régimen con etiqueta y literal, traslados, inclusiones, promociones, cargos por huésped extra y
desglose por noche. El criterio de búsqueda suma `guestNationality` y la moneda de venta. Los puertos van a
`packages/domain/src/ports/hotel-*.port.ts`. Despegar se mapea al mismo contrato.

**Fuente.** [02](./02-search-y-oferta-canonica.md) §13; [06](./06-seams-integracion-repo.md) §5.3.

**CA.** Una oferta de Despegar valida contra el esquema nuevo (regresión); ningún ACL importa a otro; el espejo de
tipos de la web se actualiza (TP-57).

**Depende de.** D-TBO-06.

#### RF-36 — Registry de hoteles, factory TBO y enrutado

**Enunciado.** `HotelProviderRegistry`, `HOTEL_PROVIDER_FACTORIES` y `TboHotelsProviderFactory implements
TenantProviderFactory` (`vertical: 'hotels'`, capacidades `retrieve`, `cancel`, `retrieveByClientReference` y
`reconcileByDate`, política de llamada según D-TBO-18). La puerta de credenciales queda **fuera** de cualquier `try`
que atrape `NotFoundException`. Enrutado: búsqueda por fan-out; PreBook por el proveedor de la oferta, validado con
`byCode`; Book, detalle y cancelación por `orders.provider`. `HotelsService` y `HotelsController` pasan a tipos
neutrales, con los dos filtros de excepción. Todas las llamadas a TBO pasan por el breaker.

**Fuente.** `HotelsService` inyecta el factory concreto de Despegar (`apps/api/src/hotels/hotels.service.ts:21`,
`:29`), VERIFICADO-CODIGO. [06](./06-seams-integracion-repo.md) §5.2, §5.4, §5.6.

**CA.**

1. Una cuenta incompleta deja a TBO ausente con motivo, nunca en fallback de plataforma.
2. Una oferta `tbo-hotels` nunca llega al adapter de Despegar.
3. Test de aislamiento del caché de adapters por dueño de la cuenta.
4. El factory de Despegar implementa el contrato sin cambiar su comportamiento.

**Depende de.** D-TBO-06, D-TBO-03, D-TBO-18, RF-35.

#### RF-37 — Credenciales en la bóveda y en el panel

**Enunciado.** Entrada `tbo-hotels` en la especificación de credenciales (`username` y `password` solo cifrados;
`environment` y `baseUrl` en `config`) y formulario en el panel de red (contraseña sin `trim`, aviso ante `http`). La
cuenta tiene que quedar `active`: una `sandbox` no resuelve. El paso de test a live **sustituye** la cuenta, no
agrega otra. Se corrige el texto de ayuda que dice que el catálogo se sincroniza al cargar credenciales.

**Fuente.** p. 7 (VERIFICADO-PDF). `resolve_provider_account` exige `status = 'active'` y devuelve una sola fila
(`db/migrations/0012_provider_accounts.sql:70`, `:75-76`), VERIFICADO-CODIGO. [06](./06-seams-integracion-repo.md)
TP-22, TP-53, TP-54, G21; [01](./01-autenticacion-conectividad-y-errores.md) §1.2.

**CA.** `password` en `config` se rechaza sin eco del valor; el formulario aparece en la lista de proveedores.

**Depende de.** D-TBO-03, D-TBO-30.

#### RF-38 — Cola de post-venta con retardo y jobs nuevos

**Enunciado.** `add()` acepta `delay`. Jobs nuevos: `verify-hotel-booking`, `verify-cancellation`, `hcn-check`,
`reconcile-provider-account` y `post-sale-sweeper`. Todo `jobId` tiene **exactamente tres segmentos**
(`nombre:<orderId>:<paso>`). El worker enruta cada nombre y la lógica de decisión vive en funciones puras fuera del
worker (D9). El doble de pruebas se actualiza. Se corrige el `jobId` de dos segmentos que hoy usa la cancelación.

**Fuente.** Sin `delay` (`apps/api/src/queue/post-sale-queue.service.ts:110`) y con `jobId` `cancel:<orderId>` de dos
segmentos (`:80`), VERIFICADO-CODIGO. BullMQ 5.78.0 rechaza un `jobId` con `:` salvo con tres segmentos, el `false`
resultante se ignora y el reintento nunca se encola ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)
§10, VERIFICADO-CODIGO en ese documento).

**CA.** Un job con `delay` corre después del retardo; un test contra BullMQ real (no solo el doble) acepta los
`jobId`; un nombre desconocido sigue lanzando.

**Depende de.** D-TBO-29.

#### RF-39 — Portal de venta de hotel

**Enunciado.** `apps/web-b2b` cubre los puntos U-01 a U-20 de [07](./07-certificacion.md) §8: nacionalidad,
habitaciones con los topes de la plataforma y cada proveedor fuera, con motivo, de la búsqueda que excede los suyos
(U-04, desviación aceptada), precio de venta y no neto, suplementos `AtProperty`, PreBook con
aviso de cambio, políticas con "hora local del hotel", `RateConditions` saneadas, huéspedes por habitación,
confirmación con un solo envío y espera de hasta 120 s, estado "verificando", confirmación y voucher, reservas de
hotel, cancelación con penalidad estimada, vencimiento a los 30 minutos, errores `300` y `402` con mensaje de
negocio, y guía en inglés.

**Fuente.** [07](./07-certificacion.md) §8; [06](./06-seams-integracion-repo.md) TP-57 a TP-62. Hoy solo el login
(U-01) cumple; la web de hoteles hace dos llamadas a la API, sugerencias y disponibilidad
(`apps/web-b2b/src/app/(app)/hoteles/actions.ts:101`, `:174`, VERIFICADO-CODIGO según [07](./07-certificacion.md) §1).

**CA.** Cada punto U-xx es un test E2E de Playwright contra el entorno de certificación. U-04 y U-05 se prueban en la
forma que el founder aceptó el 2026-09-27 ([desviaciones aceptadas](#desviaciones-aceptadas-del-checklist-de-ui)).

**Depende de.** RF-06 a RF-27, D-TBO-35, D-TBO-37.

#### RF-40 — Cada tarifa de hotel dice de qué proveedor es, según la divulgación vigente

**Enunciado.** Requisito del founder al firmar D-TBO-06 (A) el 2026-09-25: "me tiene que mostrar de dónde es". Cada
roompack de la búsqueda combinada lleva su proveedor en `provider.name` (el código del registry: `despegar-hotels`,
`tbo-hotels`), esté el ajuste encendido o apagado, y la web pinta la pastilla del proveedor junto a **cada tarifa**
solo cuando la divulgación efectiva del tenant es `true`. La regla es la de vuelos, sin variantes para hoteles: la
misma columna `tenants.show_provider_in_results`, el mismo plegado de la cadena consolidador → agencia → sub-agencia
(sin nadie que opine, oculto; con opiniones, visible solo si todas dicen "Mostrar": un "Ocultar" en cualquier nodo de
la cadena gana), el mismo endpoint y el mismo control del panel. No hay migración ni ajuste nuevo, y por eso un
tenant que ya eligió "Mostrar" para vuelos ve también el proveedor de sus tarifas de hotel, Despegar incluido, desde
que la web de hoteles lo pinta ([09](./09-plan-implementacion.md) §16).
`POST /hotels/availability` devuelve `showProviderInResults` al lado de `{ hotels, providers[] }` (RF-14), resuelto con
`ProviderDisclosureService.effective(tenantId)` en cada petición y fuera de cualquier caché, como el sobre de vuelos.
El ajuste es de presentación: nunca quita ni anonimiza `provider` de la respuesta, porque el PreBook se enruta por él
(RF-36).

**Fuente.** Firma del founder (§7, [Registro de decisiones](#registro-de-decisiones)). La política vigente, toda
VERIFICADO-CODIGO:

- Por defecto oculto y "ocultar gana": `apps/api/src/provider-disclosure/provider-disclosure.policy.ts:41`, `:51-64`;
  la cadena de ancestros la lee `provider_disclosure_chain` (`db/migrations/0036_provider_disclosure.sql:41-56`).
- Un fallo al resolverla cae a oculto sin tumbar la búsqueda:
  `apps/api/src/provider-disclosure/provider-disclosure.service.ts:54-63`.
- Sobre de vuelos con el booleano aparte y resuelto fuera del caché de 90 s:
  `apps/api/src/search/search.controller.ts:84-92`.
- Web: respuesta incompleta → oculto (`apps/web-b2b/src/lib/provider-disclosure.ts:41-53`); pastilla con
  `providerTagFor` (`:70-79`); nombre y color de cada proveedor en `apps/web-b2b/src/lib/provider-display.ts:24-57`;
  así la pinta vuelos: `apps/web-b2b/src/app/(app)/cotizaciones/_components/flight-row.tsx:339-345`.
- **Dónde lo activa el consolidador:** menú "Proveedores (GDS)" (`apps/web-b2b/src/lib/nav.ts:46`) → tarjeta "Origen
  de las tarifas en los resultados" (`apps/web-b2b/src/app/(app)/admin/proveedores/page.tsx:433-439`). No es un
  interruptor de dos estados sino un control de tres posiciones, Heredar / Mostrar / Ocultar (`:719-723`, `:766-791`),
  sobre el nodo elegido en el selector de la red; guarda con `PATCH /api/tenant/provider-disclosure` (`:273-299`). El
  API lo permite a `AGENCY_ADMIN_ROLES` sobre su nodo y su red
  (`apps/api/src/provider-disclosure/provider-disclosure.controller.ts:32`, `:77-82`) y lo audita como
  `tenant.provider_disclosure.updated` (`:63-72`). Con "Mostrar" en el consolidador, toda su red ve el proveedor
  salvo la rama de un nodo que haya elegido "Ocultar".

Hoy hoteles no devuelve el booleano (`apps/api/src/hotels/hotels.controller.ts:66-73`), la tarjeta de hotel no pinta
proveedor y el texto del panel habla solo de vuelos (`apps/web-b2b/src/app/(app)/admin/proveedores/page.tsx:761`,
`:812-813`); VERIFICADO-CODIGO. [06](./06-seams-integracion-repo.md) TP-56, TP-59, TP-66;
[05](./05-contenido-estatico-e-inventario.md) §9.2.

**CA.**

1. `POST /hotels/availability` devuelve `showProviderInResults` fuera de `hotels[]`. Test espejo de
   `apps/api/src/provider-disclosure/search-envelope-disclosure.test.ts`: con el ajuste en `false`, cada roompack
   sigue trayendo `provider.name` y `providers[]` sale intacto; con `true`, la respuesta es la misma salvo el booleano.
2. Plegado sin reglas nuevas: cadena sin opiniones → `false`; consolidador "Mostrar" y nadie más opina → `true` en
   su agencia y sus sub-agencias; consolidador "Mostrar" y agencia "Ocultar" → `false` en la rama de la agencia;
   consolidador "Ocultar" y agencia "Mostrar" → `false` con `lockedByAncestor`. Si la resolución falla, la búsqueda
   responde igual con `false`.
3. Un cambio del ajuste se ve en la búsqueda de hoteles siguiente aunque los resultados salgan del caché.
4. Web con el ajuste en `true`: cada tarifa de la tarjeta y de la lista de tarifas del detalle de hotel lleva la
   pastilla de `providerTagFor(pack.provider.name, true)`, con el nombre legible de `provider-display.ts` ("Despegar
   Hotels"; la ficha `tbo-hotels` la agrega TP-56); el código crudo solo aparece para un proveedor sin ficha, como en
   vuelos. El precio "desde" de la tarjeta lleva, pegada al precio, la pastilla del proveedor de esa tarifa, la más
   barata, como la fila de vuelos con su oferta más barata.
5. Tarjeta agrupada (D-TBO-13 A): un hotel con una tarifa de Despegar y otra de TBO muestra dos pastillas distintas,
   una por tarifa; ninguna pastilla junto al nombre del hotel lo atribuye entero a un solo proveedor.
6. Web con el ajuste en `false`, o con una respuesta sin el booleano: ninguna pastilla ni nombre de proveedor en la
   tarjeta ni en la lista de tarifas. El booleano se lee con `=== true`, como
   `apps/web-b2b/src/app/(app)/cotizaciones/actions.ts:252`.
7. El panel no gana un control nuevo: el texto de la tarjeta de `admin/proveedores/page.tsx` dice que el ajuste
   aplica a vuelos y hoteles (hoy `:761` y `:812-813` nombran solo vuelos), y el cambio se audita como hoy.
8. Lo que el ajuste no gobierna, igual que en vuelos: el aviso de tarifa simulada, que se muestra siempre
   (`apps/web-b2b/src/lib/provider-disclosure.ts:61-69`), y el aviso de proveedor degradado, que en vuelos pinta el
   código del proveedor aunque el ajuste esté en oculto (`apps/web-b2b/src/app/(app)/cotizaciones/page.tsx:459-462`).
   Hoteles copia ese comportamiento para los motivos de RF-13, RF-14 y RF-33. Que esos avisos respeten el ajuste
   sería un cambio de la política común de las dos verticales, no de hoteles (punto abierto del
   [Registro de decisiones](#registro-de-decisiones)).

**Depende de.** D-TBO-06 (A), D-TBO-13 (A), RF-14, RF-34, RF-35, RF-36.

---

## 4. Requisitos no funcionales

### RNF-01 — Timeouts por operación

TBO recomienda timeouts solo para tres métodos (p. 8, VERIFICADO-PDF). El resto son valores propuestos
(INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09)). Viven en `TBO_OPERATIONS` y la configuración de una cuenta o del sync **solo puede
acortarlos**, salvo `ResponseTime`, que es un parámetro explícito de Search.

| Operación                 | Contrato (p. 8) | Timeout HTTP                                                                   | Intentos máximos                                                                                                                          | Quién espera                                   |
| ------------------------- | --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Search                    | 5-23 s          | `ResponseTime` + 3 s, techo 23 s (con la opción recomendada de D-TBO-17, 13 s) | 2, nunca después de un timeout                                                                                                            | Vendedor                                       |
| PreBook                   | 23 s            | 23 s                                                                           | 2 solo si el primer fallo fue rápido (`429`, `500`, conexión rechazada) y el total no pasa de 23 s; nunca después de un timeout (§9 C-24) | Vendedor                                       |
| Book                      | 120 s           | 120 s                                                                          | **1, siempre**                                                                                                                            | Saga, no el request del navegador              |
| BookingDetail             | —               | 30 s                                                                           | 3 en jobs, 2 interactivo                                                                                                                  | Job o vendedor                                 |
| Cancel                    | —               | 60 s                                                                           | **1, siempre**                                                                                                                            | Saga                                           |
| BookingDetailsbasedondate | —               | 60 s                                                                           | 3                                                                                                                                         | Job de conciliación                            |
| CountryList, CityList     | —               | 30 s                                                                           | 5                                                                                                                                         | Sync                                           |
| TBOHotelCodeList          | —               | 60 s                                                                           | 5                                                                                                                                         | Sync                                           |
| HotelDetails              | —               | 60 s de techo; el sync configura 45 s                                          | 5                                                                                                                                         | Sync, o detalle bajo demanda con timeout corto |
| hotelcodelist             | —               | 180 s                                                                          | 3                                                                                                                                         | Sync                                           |

Fuentes: [01](./01-autenticacion-conectividad-y-errores.md) §5.2 y §10.4; [05](./05-contenido-estatico-e-inventario.md)
§10; §9 C-01 y C-14. **Verificable:** histograma `tbo.http.duration{op}` y tests de timeout por la puerta pública
(RF-02).

### RNF-02 — Cuota de QPS y concurrencia por cuenta

El límite existe (`429 LIMIT_EXCEEDED`, p. 9) y su valor no se publica (VERIFICADO-PDF → [Q-10](./10-preguntas-para-tbo.md#q-10)).

1. Limitador **por cuenta resuelta**, con la clave `accountRef` (digest truncado de `ownerTenantId` + `username`,
   [01](./01-autenticacion-conectividad-y-errores.md) §11.1): las sub-agencias que heredan la cuenta del
   consolidador comparten cupo (INFERIDO).
2. Valores por defecto según D-TBO-17 (recomendada: 5 QPS y 4 concurrentes por cuenta), configurables.
3. **Cupos separados:** ventas (Search, PreBook), dinero (Book, Cancel y el `BookingDetail` de recuperación) y
   fondo (HCN, verificaciones y conciliación). El dinero nunca espera detrás de la búsqueda.
4. El sync usa otra cuenta (D-TBO-04) con su propio ritmo (1 req/s de partida, una conexión,
   [05](./05-contenido-estatico-e-inventario.md) §10).
5. Ante un `429`, el ritmo de esa cuenta baja a la mitad durante 60 s (INFERIDO). Book y Cancel no se reintentan.
6. Estado en memoria mientras haya un solo contenedor de API; en Redis, **a través de un port**, cuando se escale.
   El `CachePort` actual no tiene operaciones atómicas (`packages/core/src/ports/cache.port.ts:1-6`,
   VERIFICADO-CODIGO según [01](./01-autenticacion-conectividad-y-errores.md) §7.2).

**Verificable:** N+5 búsquedas concurrentes con cupo N nunca tienen más de N en vuelo; un Book no espera detrás de
búsquedas saturadas.

### RNF-03 — Circuit breaker según el efecto del error y por cuenta

Hoy el breaker cuenta **cualquier** excepción como fallo y lleva un circuito por código de proveedor para todos los
tenants (`apps/api/src/search/circuit-breaker.service.ts:31`, `:90-97`, VERIFICADO-CODIGO). Con la opción
recomendada de D-TBO-32:

1. `failure.circuit` decide: `COUNT` suma al circuito global `tbo-hotels` (`TRANSPORT`, `UPSTREAM`,
   `MALFORMED_RESPONSE`); `IGNORE` no suma (`201`, `207`, `315`, `300`, `400`, `429`); `OPEN_ACCOUNT` abre solo el
   circuito de la cuenta (`401` durante 5 min, `402` durante 15 min), avisa al titular y emite un evento.
2. La clave del circuito de cuenta es `tbo-hotels@{accountRef}`, no el id del tenant (§9 C-16): al rotar la
   credencial se abre un circuito nuevo.
3. `GET /health` es público y hoy publica todas las claves del breaker (`apps/api/src/health/health.controller.ts:21`,
   `:50`, VERIFICADO-CODIGO): el snapshot público agrega o excluye los circuitos de cuenta (§9 C-15).
4. Todas las llamadas a TBO pasan por el breaker; las puertas locales (vencimiento, credenciales, construcción del
   request) no.
5. En `environment: 'test'` el breaker funciona igual pero las alertas de guardia se silencian: el entorno de
   certificación tiene cortes sin aviso (Cert, nota final, VERIFICADO-CERT).

**Verificable:** cinco `401` de una agencia no abren el circuito global; cinco `207` tampoco; `/health` no lista
ids de tenant.

### RNF-04 — PCI: solo `Limit`, en cinco capas

D1 exige que ningún body construido por nosotros lleve datos de tarjeta. Para TBO:

1. **Tipo**: el tipo de salida de PreBook, Book y BookingDetail declara `PaymentMode: 'Limit'` y `PaymentInfo?: never`;
   la entrada pública del builder no tiene campos de pago.
2. **Zod de salida** `.strict()` justo antes de `fetch`.
3. **Guarda del cliente**: `TboRequestBuildError` ante un `PaymentMode` distinto de `Limit` o cualquier clave que,
   normalizada, empiece por `card`, contenga `cvv` o sea `paymentinfo` ([01](./01-autenticacion-conectividad-y-errores.md) §10.5).
4. **Lint D1 extendido**: la regla actual solo reconoce claves camelCase (`eslint.config.mjs:57`, VERIFICADO-CODIGO)
   y no detectaría `CardNumber` ni `CvvNumber` (p. 33-34). Se agregan las claves PascalCase de TBO y, solo para
   `providers/tbo-hotels/**/*.request.builder.ts`, un bloque con el literal `NewCard|SavedCard` que **repite** los
   selectores D1, porque en la configuración plana el bloque posterior reemplaza al anterior
   ([03](./03-prebook-y-book.md) §7.3).
5. **Guards en la suite del paquete**: barrido de bytes de salida por la puerta pública y test que ejecuta ESLint de
   verdad sobre una sonda, con las tres propiedades del guard de Sabre.

Además: los ejemplos de Book con tarjeta del PDF (p. 34-40) nunca entran como fixture; `CreditCardBillingOptions` y
`CreditCardOptions` no se declaran en los esquemas de respuesta; las guardas G-2 y G-3 del arnés abortan el zip.
Fuentes: [03](./03-prebook-y-book.md) §7; [06](./06-seams-integracion-repo.md) §4.3, §7.4.

### RNF-05 — Logging por lista blanca y payloads fuera del log

1. Se loguea solo la lista blanca de [01](./01-autenticacion-conectividad-y-errores.md) §11.1. Nunca cabeceras,
   cuerpos, `username`, `password`, nombres, email ni teléfono.
2. `Status.Description` solo en operaciones sin datos personales (Search, PreBook, estáticos), recortado a 120
   caracteres.
3. Los RQ/RS completos van a la bóveda de payloads de D-TBO-31, no al log. TBO los exige para `UNEXPECTED_ERROR`
   ("Please send complete logs (JSON request and response)", p. 9, VERIFICADO-PDF).
4. La exportación desde la bóveda usa una redacción propia con las claves de TBO; no se importa la de Sabre, que deja
   pasar `AddressLine1`, `PostalCode` y `CardExpirationMonth` ([01](./01-autenticacion-conectividad-y-errores.md) §11.3).
5. `TripName` se descarta: su ejemplo parece llevar el apellido del huésped (p. 64; INFERIDO).
6. No se copia de Despegar el log de 250 caracteres del cuerpo ni el `console.warn` de depuración
   ([06](./06-seams-integracion-repo.md) §8 G6).

**Verificable:** tests con logger espía para cada operación con PII.

### RNF-06 — Aislamiento multi-tenant

1. Caché de adapters por dueño de la cuenta (`byoc:{ownerTenantId}:{updatedAt}`), con evicción al rotar.
2. Contexto de búsqueda por `(tenantId, searchId)` (RF-08).
3. Toda lectura o cancelación por id pasa antes por `orders` con RLS del tenant: con la cuenta heredada, TBO
   devolvería reservas de agencias hermanas ([06](./06-seams-integracion-repo.md) §5.5 punto 6, INFERIDO).
4. `BookingReferenceId` único entre todos los tenants (RF-19).
5. Los resultados de conciliación nunca salen del subárbol del dueño de la cuenta (RF-28). Los barridos y la
   conciliación recorren los tenants con `withTenant` o usan un rol de mantenimiento explícito.
6. Tests de aislamiento como `app_user` sin `BYPASSRLS` ([06](./06-seams-integracion-repo.md) §7.5), con una
   aserción que corre sin base de datos para que un salto silencioso no cuente como verde.

### RNF-07 — Observabilidad

Métricas por `MetricsPort` (sin implementación hoy, [01](./01-autenticacion-conectividad-y-errores.md) §10.6):
`tbo.http.requests{op, kind, tbo_code}`, `tbo.http.duration{op}`, `tbo.search.pack_rejected{reason}`,
`tbo.amount_precision_loss`, `tbo.unknown_meal_type` y `tbo.envelope.casing_variant`. Una fila de `search_logs` por
proveedor con `breakdownOf`. Spans con `provider`, `op`, `status`, `tboCode` y `credentialSource`, nunca el cuerpo.
La nacionalidad no entra en `search_logs.criteria` (RF-06).

### RNF-08 — Auditoría y eventos de dominio

Se reutiliza `ORDER_EVENTS` (`apps/api/src/orders/order-events.ts:15-30`, VERIFICADO-CODIGO) con
`vertical: 'hotels'` en el payload. Eventos nuevos: `HotelOfferRepriced`, `ProviderAccountIssueDetected`,
`OrderProviderStatusChanged`, `HotelConfirmationNumberReceived`, `HotelConfirmationNumberMissing`,
`OrderReconciliationDiscrepancy` y `ProviderBookingUnmatched`. Motivos nuevos de `OrderEscalated`:
`create-not-found`, `cancellation-stuck` y `provider-status-unknown`. Payloads con vocabulario cerrado, sin PII y sin
texto del proveedor. `AuditService.emit` es best-effort, así que ningún job usa eventos como fuente de verdad: la
fuente son las filas de Postgres ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.5).

### RNF-09 — Cuota horaria del tenant

Una búsqueda del vendedor cuenta **una** vez en la cuota, aunque TBO reciba varios lotes y aunque consulten varios
proveedores ([02](./02-search-y-oferta-canonica.md) §4.3 punto 6). Es la misma lección que Sabre
(`docs/sabre/10-requisitos-maestro.md` RNF-10).

### RNF-10 — Durabilidad de las sagas sobre BullMQ (D9)

1. Postgres es la fuente de verdad; la cola solo despierta. Un barrido cada 15 minutos re-encola lo vencido.
2. La lógica de decisión (clasificación del Book, plan del HCN, mapeo de estados, discrepancias) vive en funciones
   puras fuera del `Worker`: es la condición de D9 para que migrar a Temporal sea barato.
3. El Book **nunca** corre como job de `post-sale-retry`, que fija `attempts: 5`
   (`apps/api/src/queue/post-sale-queue.service.ts:110-119`, VERIFICADO-CODIGO).
4. Apagado ordenado del contenedor `api` (RF-22).
5. Los jobs diferidos de hasta 5 días del HCN P5 son el caso que D9 llama frágil; se mitiga con la fila de Postgres,
   el barrido y el AOF de Redis ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.5).

### RNF-11 — Kill-switch en dos niveles, cableado en producción

`PROVIDERS_DISABLED` no llega hoy al contenedor de producción ([01](./01-autenticacion-conectividad-y-errores.md)
§12.1, VERIFICADO-CODIGO por búsqueda en `infrastructure/` y `.github/`). Con la opción recomendada de D-TBO-32: nivel
"ventas" (Search, PreBook, Book) y nivel "todo" (además BookingDetail, Cancel y conciliación), evaluados por código de
proveedor y cableados en `docker-compose.prod.yml` y `deploy.yml`, o movidos a `provider_catalog.status` o Unleash.
Con el circuito abierto, los jobs de lectura se reprograman en vez de fallar.

### RNF-12 — Zod en todos los bordes

Configuración de la cuenta, variables de entorno del sync, bodies de salida (`.strict()`) y respuestas (tolerantes
donde el contrato se contradice, estrictas donde hay dinero). Los nombres de campos desconocidos se registran, lo que
exige `.passthrough()` en el envelope o comparar claves antes de parsear (§9 C-12). Ningún `Error` plano escapa al
filtro: hoy `Money.fromMajor` lanza uno con importes negativos (`packages/canonical/src/money.ts:41-44`,
VERIFICADO-CODIGO).

### RNF-13 — Degradación parcial nunca silenciosa

Si TBO falló, fue omitido (sin nacionalidad, sin mapeo de destino, moneda distinta, cuenta bloqueada) o respondió en
parte, el vendedor lo ve en pantalla con el motivo (`providers[]`, RF-14). Un vendedor que dice "no hay más hoteles"
cuando TBO no respondió es peor que un error visible.

### RNF-14 — Tests y red de seguridad

1. Tests y fixtures dentro de `providers/tbo-hotels`, con scripts `lint` y `test` para que CI los ejecute
   ([03](./03-prebook-y-book.md) §7.2).
2. Las defensas se prueban por la puerta pública del cliente HTTP y con mutación: cada guard demuestra que distingue
   sus dos ramas ([06](./06-seams-integracion-repo.md) §7.3-§7.4).
3. **Antes de refactorizar la vertical**, tests de caracterización de `HotelsService`, `HotelsController`, sus
   esquemas y su filtro, que hoy no existen ([06](./06-seams-integracion-repo.md) §8 G19).
4. Los ejemplos del PDF con JSON inválido se normalizan y se marca su origen; las respuestas reales de certificación
   los reemplazan como fuente de los tests de mapper.

### RNF-15 — El contrato se fija por hash, no por versión

La versión 2.1 cubre cambios de 2023 y de 2025 (p. 6): el número no identifica el contenido
([00](./00-fuentes.md) §10 F-02). Toda cita apunta al PDF con SHA-256 `bb406ac31c5def12`; un PDF nuevo exige hash
nuevo, diff y revisión de citas. → [Q-01](./10-preguntas-para-tbo.md#q-01) (canal de avisos de cambios).

### RNF-16 — Contenido de terceros seguro

`Description` y `Attractions` son HTML de un tercero: se sanean con lista blanca al ingerir
([05](./05-contenido-estatico-e-inventario.md) §4). `RateConditions` se decodifica una sola vez y se muestra como
texto (RF-16). Las imágenes se sirven solo por `https`, que la CSP del panel ya admite
([05](./05-contenido-estatico-e-inventario.md) §4).

---

## 5. Requisitos de certificación

El proceso, los 8 casos, el arnés y los anexos listos para enviar están en [07](./07-certificacion.md). Aquí se
fijan como requisitos.

| ID        | Requisito                                                                                                                                                                 | Fuente                                                                                                                                     | CA                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **RC-01** | Recorrer las cinco fases (integración en test, JSON Verification, Portal Verification, sign-off, Production Process Form) cerrando cada una antes de pasar a la siguiente | Cert, todas las secciones (VERIFICADO-CERT); [07](./07-certificacion.md) §2                                                                | Tabla de sign-off archivada con el SHA de git de la versión probada                                                                    |
| **RC-02** | Los RQ del zip son los bytes que manda la aplicación: el arnés `tools/tbo/cert-cases.mjs` usa el adapter público del ACL con un `fetch` grabador y no arma JSON propio    | "samples of JSON’s from your application (i.e., RQ and RS files)" (Cert, Integration on Test Account); [07](./07-certificacion.md) §6.1    | Los 8 casos repetidos a mano por el portal difieren de los del arnés solo en valores dinámicos                                         |
| **RC-03** | Las guardas G-1 a G-13 pasan antes de escribir el zip                                                                                                                     | [07](./07-certificacion.md) §6.7                                                                                                           | `verify` y `zip` abortan ante credenciales, claves de tarjeta, `PaymentMode` distinto de `Limit` o nombres fuera de la lista sintética |
| **RC-04** | Las sondas PR-01 a PR-11 corren antes de la primera corrida de casos y nunca entran al zip                                                                                | [07](./07-certificacion.md) §6.8                                                                                                           | Cada sonda que responde una pregunta la marca como cerrada en [10](./10-preguntas-para-tbo.md)                                         |
| **RC-05** | Cada checkpoint reconstruido (CK-01 a CK-18) está cubierto por un requisito de este documento                                                                             | [07](./07-certificacion.md) §3 (INFERIDO: TBO no publica su lista)                                                                         | Tabla de abajo                                                                                                                         |
| **RC-06** | El portal cumple el checklist U-01 a U-20; U-04 y U-05, en la forma que el founder aceptó el 2026-09-27 (§7)                                                              | [07](./07-certificacion.md) §8                                                                                                             | RF-39                                                                                                                                  |
| **RC-07** | El portal de pruebas no expone ninguna credencial real de ningún proveedor                                                                                                | [07](./07-certificacion.md) §7; D-TBO-35                                                                                                   | Con la opción recomendada, el entorno de certificación no tiene variables de otros proveedores                                         |
| **RC-08** | `.env.tbo` y `.tbo-cert/` están en `.gitignore` **antes** de crear el primero                                                                                             | `.gitignore:32` ignora solo `.env` y `:105` solo `.env.sabre`; `git check-ignore .env.tbo` no devuelve nada (VERIFICADO-CODIGO)            | `git check-ignore .env.tbo .tbo-cert/x` devuelve las dos rutas                                                                         |
| **RC-09** | El workflow enviado a TBO (Anexo A de [07](./07-certificacion.md)) refleja las decisiones tomadas                                                                         | [07](./07-certificacion.md) Anexo A; §9 C-07, C-20                                                                                         | El paso 7 y la línea de `402` del Anexo A coinciden con D-TBO-24 y D-TBO-32                                                            |
| **RC-10** | El pase a live sustituye la cuenta de test por la live; nunca conviven dos cuentas `active` del mismo tenant                                                              | `resolve_provider_account` ordena por nivel y devuelve una sola fila (`db/migrations/0012_provider_accounts.sql:75-76`, VERIFICADO-CODIGO) | Runbook de pase a live con verificación posterior                                                                                      |
| **RC-11** | Los datos del "Production Process Form" (por ejemplo, IP fija de salida del VPS) se preparan antes del sign-off                                                           | Cert, Sign Off / API Live Credentials; campos no conocidos (→ [Q-80](./10-preguntas-para-tbo.md#q-80))                                     | Lista de datos lista antes de la fase 4                                                                                                |

**Checkpoints → requisitos.**

| CK    | Qué revisaría TBO (INFERIDO)                                  | Requisito     |
| ----- | ------------------------------------------------------------- | ------------- |
| CK-01 | `GuestNationality` no fija                                    | RF-06         |
| CK-02 | `IsDetailedResponse: false`                                   | RF-05         |
| CK-03 | `PaxRooms` exactos                                            | RF-05, RF-39  |
| CK-04 | `HotelCodes` CSV, ≤ 100                                       | RF-05, RF-14  |
| CK-05 | Orden de métodos y 30 minutos                                 | RF-09, RF-20  |
| CK-06 | PreBook con `Limit`                                           | RF-15, RNF-04 |
| CK-07 | Políticas y normas de PreBook como finales                    | RF-11, RF-16  |
| CK-08 | Suplementos visibles; `AtProperty` antes de reservar          | RF-10         |
| CK-09 | Precio de venta ≥ `RecommendedSellingRate`                    | RF-12         |
| CK-10 | Un `CustomerDetails` por habitación, todos nombrados          | RF-18         |
| CK-11 | `TotalFare` de PreBook, `Voucher`, `Limit`, sin `PaymentInfo` | RF-20, RNF-04 |
| CK-12 | `BookingReferenceId` único                                    | RF-19         |
| CK-13 | `BookingDetail` después del Book                              | RF-20, RF-24  |
| CK-14 | Recuperación a los 120 s sin re-Book                          | RF-21         |
| CK-15 | Cancel y estado final                                         | RF-25         |
| CK-16 | Decisión por `Status.Code`                                    | RF-03         |
| CK-17 | Basic, verbos y timeouts                                      | RF-02, RNF-01 |
| CK-18 | Cambio de precio reconfirmado                                 | RF-15, RF-20  |

---

## 6. Riesgos

Probabilidad e impacto son estimaciones nuestras (INFERIDO). La mitigación remite al requisito o decisión que la
implementa.

| #        | Riesgo                                                                                                                                                                                                                                                                                                                                                  | Probabilidad                    | Impacto                          | Mitigación                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **R-01** | **Doble reserva y doble consumo del crédito `Limit`** tras un Book incierto: no está documentado qué devuelve `BookingDetail` si la reserva no existe, ni si el Book es idempotente por `BookingReferenceId` (p. 33, 42-44)                                                                                                                             | Media                           | Alto                             | RF-19, RF-21, D-TBO-24; sondas PR-05 y PR-11; → [Q-35](./10-preguntas-para-tbo.md#q-35), [Q-37](./10-preguntas-para-tbo.md#q-37)      |
| **R-02** | **Reserva con dinero sin fila propia** si el Book se persiste después o no se persiste: un timeout deja la reserva en TBO sin rastro en la plataforma                                                                                                                                                                                                   | Alta con D-TBO-07 (B) o (C)     | Crítico                          | D-TBO-07 (A); RF-20                                                                                                                   |
| **R-03** | **La certificación no cubre las cuentas propias de las agencias** y la red BYOC no puede operar TBO                                                                                                                                                                                                                                                     | Media                           | Alto para el modelo consolidador | D-TBO-03 (A): BYOC de agencias apagado hasta la respuesta; → [Q-77](./10-preguntas-para-tbo.md#q-77)                                  |
| **R-04** | **El portal no está listo** cuando TBO agenda la verificación de portal                                                                                                                                                                                                                                                                                 | Media                           | Alto                             | D-TBO-05; RF-39 en la ruta crítica de [09](./09-plan-implementacion.md)                                                               |
| **R-05** | **Un tester de TBO reserva con credenciales reales** de otro proveedor si el portal vive en producción: hoy un tenant sin cuenta propia cae a las credenciales de plataforma de Despegar (`apps/api/src/providers-despegar/despegar-hotels.factory.ts:27-35`) y de LATAM (`apps/api/src/providers-latam/latam-ndc.factory.ts:79-84`), VERIFICADO-CODIGO | Alta si el portal es producción | Crítico                          | D-TBO-35 (A); RC-07                                                                                                                   |
| **R-06** | **Credenciales de test en claro** por `http://` (p. 7)                                                                                                                                                                                                                                                                                                  | Cierta                          | Bajo (son de test)               | RF-01; sonda PR-03; contraseña de un solo uso                                                                                         |
| **R-07** | **Una credencial BYOC mala o bloqueada apaga TBO para toda la red**: cinco `401` de una agencia abren el circuito único durante 30 s                                                                                                                                                                                                                    | Alta sin cambio                 | Alto                             | RNF-03, D-TBO-32                                                                                                                      |
| **R-08** | **Respuestas reales que rompen el Zod**: ejemplos inválidos y tipos contradictorios ([00](./00-fuentes.md) §8)                                                                                                                                                                                                                                          | Alta                            | Medio                            | Esquemas tolerantes; el arnés graba antes de parsear; fixtures reales                                                                 |
| **R-09** | **Tarifa mal aplicada por nacionalidad fija**; TBO declina toda responsabilidad (p. 71)                                                                                                                                                                                                                                                                 | Media                           | Alto                             | RF-06, D-TBO-14                                                                                                                       |
| **R-10** | **Venta por debajo de `RecommendedSellingRate`**: riesgo contractual y de certificación                                                                                                                                                                                                                                                                 | Media                           | Alto                             | RF-12, D-TBO-16                                                                                                                       |
| **R-11** | **Doble margen** si el perfil TBO trae un markup de agencia (`AgentMarkup`, `BookingPrice`, p. 63) y además aplicamos el waterfall                                                                                                                                                                                                                      | Baja-media                      | Medio                            | Perfiles TBO con markup 0; discrepancia R6 de la conciliación; → [Q-89](./10-preguntas-para-tbo.md#q-89)                              |
| **R-12** | **Importes mal escalados** por un factor de 10 o 100 en monedas sin 2 decimales                                                                                                                                                                                                                                                                         | Baja                            | Alto                             | RF-07 (guarda de exponente), D-TBO-15                                                                                                 |
| **R-13** | **Suplementos `AtProperty` no mostrados**: reclamo del huésped en el hotel y rechazo en certificación                                                                                                                                                                                                                                                   | Media                           | Alto                             | RF-10                                                                                                                                 |
| **R-14** | **La agencia ve "Cancelada" mientras el hotel no liberó la reserva**                                                                                                                                                                                                                                                                                    | Media                           | Alto                             | RF-25, D-TBO-25                                                                                                                       |
| **R-15** | **Disputas por penalidades**: `Cancel` no devuelve cargo ni reembolso (p. 42)                                                                                                                                                                                                                                                                           | Alta                            | Medio                            | Snapshot de PreBook, que el contrato declara final (p. 71); D-TBO-26                                                                  |
| **R-16** | **QPS desconocido**: `429` en campañas; el sync compite con la venta                                                                                                                                                                                                                                                                                    | Media                           | Medio                            | RNF-02, D-TBO-04, D-TBO-12                                                                                                            |
| **R-17** | **Costo por búsqueda o límite de look-to-book** no documentado                                                                                                                                                                                                                                                                                          | Desconocida                     | Alto                             | D-TBO-18 (opt-in hasta confirmarlo); → [Q-87](./10-preguntas-para-tbo.md#q-87)                                                        |
| **R-18** | **El catálogo depende de la cuenta** y un sync global no sirve para cuentas BYOC                                                                                                                                                                                                                                                                        | Baja-media                      | Alto (rediseño del sync)         | D-TBO-11; sonda comparativa en certificación                                                                                          |
| **R-19** | **La búsqueda TBO depende del autocomplete de Despegar** mientras el destino sea su id geográfico                                                                                                                                                                                                                                                       | Cierta en la fase 1             | Medio                            | D-TBO-10; catálogo local sin Despegar ([05](./05-contenido-estatico-e-inventario.md) §8.5); destinos propios después                  |
| **R-20** | **Fusión falsa de hoteles**: el vendedor reserva una tarifa creyendo que es de otro hotel                                                                                                                                                                                                                                                               | Baja                            | Alto                             | RF-34 (umbral conservador, revisión manual, datos del proveedor que vende)                                                            |
| **R-21** | **Refactor sin red** del único proveedor de hoteles en producción                                                                                                                                                                                                                                                                                       | Media                           | Alto                             | RNF-14 punto 3                                                                                                                        |
| **R-22** | **Cortes del proxy (524)** en un Book síncrono                                                                                                                                                                                                                                                                                                          | Alta si es síncrono             | Medio                            | RF-22, D-TBO-09                                                                                                                       |
| **R-23** | **Un despliegue corta Books en vuelo** (sin periodo de gracia hoy)                                                                                                                                                                                                                                                                                      | Media                           | Medio                            | RF-22; RF-21 como red                                                                                                                 |
| **R-24** | **El contrato cambia sin cambiar de versión** (2.1 dos veces, p. 6)                                                                                                                                                                                                                                                                                     | Media                           | Medio                            | RNF-15; → [Q-01](./10-preguntas-para-tbo.md#q-01)                                                                                     |
| **R-25** | **Entorno de certificación inestable y plazos aproximados** (Cert, nota final)                                                                                                                                                                                                                                                                          | Alta                            | Medio en calendario              | Corridas por caso, `calls.jsonl` con tiempos; no comprometer fecha de producción atada a TBO ([07](./07-certificacion.md) R-01, R-02) |
| **R-26** | **Distracción estratégica**: TBO no está en el roadmap y no hay cifra de valor                                                                                                                                                                                                                                                                          | Media                           | Alto                             | Aceptado con D-TBO-02 (B): medición informativa (§2.3); la Fase 0 de [09](./09-plan-implementacion.md) sirve a cualquier bedbank      |
| **R-27** | **PII en payloads**: nombres en Book y BookingDetail; TBO pide logs completos                                                                                                                                                                                                                                                                           | Media                           | Alto                             | RNF-05, D-TBO-31                                                                                                                      |
| **R-28** | **`.env.tbo` commiteado por error**                                                                                                                                                                                                                                                                                                                     | Media                           | Alto                             | RC-08                                                                                                                                 |
| **R-29** | **Deriva de cuenta**: tras pasar de cuenta heredada a propia, la agencia no puede leer ni cancelar reservas viejas                                                                                                                                                                                                                                      | Media                           | Alto                             | RF-29, D-TBO-28                                                                                                                       |
| **R-30** | **Timers de días sobre BullMQ** (HCN P5 hasta 5 días)                                                                                                                                                                                                                                                                                                   | Media                           | Medio                            | RNF-10                                                                                                                                |
| **R-31** | **Nombres con tildes corruptos** en el sistema del hotel                                                                                                                                                                                                                                                                                                | Media                           | Bajo-medio                       | D-TBO-23; sonda PR-09                                                                                                                 |
| **R-32** | **Tarifa "solo paquete" vendida como hotel suelto**                                                                                                                                                                                                                                                                                                     | Baja-media                      | Alto contractual                 | RF-17, D-TBO-22                                                                                                                       |

Los tres que hay que mirar cada semana: **R-01**, **R-03** y **R-04**. **R-26** salió de la lista el 2026-09-25:
el founder lo aceptó con D-TBO-02 (B).

---

## 7. Decisiones del founder

Cada decisión trae opciones descritas por lo que se ve al usarlas, la recomendada primero, sus consecuencias y qué
bloquea. Consolidan y deduplican las que dejaron abiertas los documentos 00 a 07 (la línea "Consolida" dice de
dónde vienen). Donde un documento del set adoptó una postura distinta de la recomendada aquí, §9 lo registra. Las
fichas de las decisiones firmadas conservan todas sus opciones como registro y marcan la elegida.

### Registro de decisiones

| Decisión | Estado                  | Opción elegida                                                                                                                                                                                                             | Qué fija                                                                                                                                                                                                                                                        |
| -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-TBO-02 | **CERRADA, 2026-09-25** | **(B)** Sin compuerta de valor: se construye todo y el valor se mide en producción                                                                                                                                         | No hay umbral ni decisión de seguir o parar; F4-F6 no esperan ninguna cifra. La medición de §2.3 se hace igual, como información (PR-3.7 de [09](./09-plan-implementacion.md)). D-TBO-01 (A) deja de estar condicionada                                         |
| D-TBO-03 | **CERRADA, 2026-09-25** | **(A)** La cuenta TBO del consolidador vive en la bóveda de su nodo y se hereda a su red; sin fallback a variables de entorno de plataforma; las cuentas propias de agencias quedan deshabilitadas hasta que responda Q-77 | RF-23, RF-36 CA 1, RF-37; D-TBO-38. `tbo-hotels` no entra en `PLATFORM_DEFAULT_HOTEL_PROVIDERS` y no hay variables de venta `TBO_*` en el despliegue (las `TBO_SYNC_*` del catálogo son de D-TBO-04)                                                            |
| D-TBO-06 | **CERRADA, 2026-09-25** | **(A)** Generalizar la vertical: contrato neutral Zod en `packages/canonical`, puertos en `packages/domain` y `HotelProviderRegistry` espejo del de vuelos                                                                 | RF-35, RF-36, F3. **Con un requisito explícito del founder: "me tiene que mostrar de dónde es"** → RF-40: cada tarifa de la búsqueda combinada lleva su proveedor y la web lo pinta con la política de divulgación que ya existe para vuelos, sin reglas nuevas |
| D-TBO-07 | **CERRADA, 2026-09-25** | **(A)** Intent `pending` con `BookingReferenceId` antes del Book, por una API pública de intent en `OrdersService`                                                                                                         | RF-19 a RF-29, F4                                                                                                                                                                                                                                               |

**Las otras 34 decisiones no están firmadas y se implementan con su opción recomendada (A) hasta que el founder diga
otra cosa.** Son D-TBO-01, D-TBO-04, D-TBO-05 y D-TBO-08 a D-TBO-38; así lo pidió el founder el mismo 2026-09-25. Todas
tienen la recomendada en (A). Cambiar una después de que empezó el PR que la aplica cuesta el retrabajo que dice su
línea "Bloquea"; las fechas hasta las que se puede cambiar sin retrabajo están en [09](./09-plan-implementacion.md)
§18.

**Punto abierto que deja RF-40** (no es una decisión D-TBO, porque afecta igual a vuelos): el aviso de proveedor
degradado nombra al proveedor aunque la divulgación esté en oculto, en vuelos hoy y en hoteles por copia (RF-40
CA 8). Si el founder quiere que ese aviso también respete el ajuste, se cambia en la política común de las dos
verticales.

#### Desviaciones aceptadas del checklist de UI

No son decisiones D-TBO: son dos puntos del checklist de [07](./07-certificacion.md) §8 que la web cumple de otra
forma. Salieron del cierre de la Fase 6 ([09](./09-plan-implementacion.md) §13) y el founder los aceptó el 2026-09-27
("acepto U-04 y U-05"). La razón es la que dejaron ese cierre y los comentarios de PR-6.1 en
`apps/web-b2b/src/app/(app)/hoteles/_components/rooms-picker.tsx` y `apps/api/src/hotels/hotels.schemas.ts`. RF-39 y
RC-06 los dan por cumplidos así.

| Punto | Qué pide 07 §8                                                                                    | Qué hace la web                                                                                                                                                                                                                                                      | Razón                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-04  | Habitaciones dentro de los límites de TBO: hasta 4 niños por habitación, edades de 0 a 18 (CK-03) | Topes de la plataforma: 8 habitaciones, 8 adultos y 6 niños por habitación, edades de 0 a 17. Con 5 o 6 niños en una habitación, TBO queda fuera de esa búsqueda con el motivo visible ("Admite hasta 4 niños por habitación.") y los demás proveedores buscan igual | Achicar los topes al proveedor más estrecho le quitaría a todos lo que solo uno no admite; RF-05 CA 2 ya pide dejar a TBO fuera con motivo en vez de truncar la ocupación. Ninguno de los 8 casos de certificación cae fuera. Queda afuera un niño de 18 años → [Q-14](./10-preguntas-para-tbo.md#q-14) |
| U-05  | Imagen del hotel en los resultados, entre otros datos del contenido estático                      | La imagen está en el detalle del hotel (`/hoteles/[hotelKey]`), no en la tarjeta de resultados                                                                                                                                                                       | La oferta neutral de disponibilidad no trae imagen: llevarla a la tarjeta exige sumar una miniatura del catálogo a `POST /hotels/availability`. U-05 no tiene CK asociado                                                                                                                               |

Si TBO objeta alguna en la verificación de portal, el cambio es el que describe [07](./07-certificacion.md) §8.

### 7.0 Índice

| Decisión | Pregunta                                                        | Recomendada                                                        | Bloquea                      | Estado                                                 |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------ |
| D-TBO-01 | ¿En qué orden entra TBO frente a Hotelbeds y RateHawk?          | TBO segundo, generalizando la vertical                             | Todo el plan                 | Abierta; se aplica (A)                                 |
| D-TBO-02 | ¿Se mide el valor de TBO antes de construir la reserva?         | Sí, compuerta tras el catálogo (no elegida)                        | Nada (bloqueaba F4-F6)       | **CERRADA 2026-09-25: (B)**, sin compuerta             |
| D-TBO-03 | ¿Con qué cuenta TBO reserva cada agencia?                       | Cuenta del consolidador, heredable; sin fallback de plataforma     | RF-23, RF-36, RF-37          | **CERRADA 2026-09-25: (A)**                            |
| D-TBO-04 | ¿Qué cuenta usa el sync del catálogo?                           | Una cuenta dedicada                                                | RF-30                        | Abierta; se aplica (A)                                 |
| D-TBO-05 | ¿Cuándo se abre la certificación?                               | En cuanto el ACL y el arnés pasen los 8 casos                      | Calendario de F6             | Abierta; se aplica (A)                                 |
| D-TBO-06 | ¿Se generaliza la vertical o se hace un módulo aparte?          | Generalizar con registry espejo                                    | RF-35, RF-36, RF-40          | **CERRADA 2026-09-25: (A)**, con el requisito de RF-40 |
| D-TBO-07 | ¿Las reservas de hotel son órdenes antes del Book?              | Sí                                                                 | RF-19 a RF-29                | **CERRADA 2026-09-25: (A)**                            |
| D-TBO-08 | ¿Despegar pasa al flujo de órdenes ahora?                       | Después, como tarea aparte                                         | Nada de TBO                  | Abierta; se aplica (A)                                 |
| D-TBO-09 | ¿El Book espera en la petición del navegador?                   | Híbrido 201/202                                                    | RF-22                        | Abierta; se aplica (A)                                 |
| D-TBO-10 | ¿Cómo se traduce el destino a ciudades TBO?                     | Tabla de mapeo calculada                                           | RF-33                        | Abierta; se aplica (A)                                 |
| D-TBO-11 | ¿El catálogo es uno o uno por cuenta?                           | Uno global, verificado con una sonda                               | RF-30, RF-31                 | Abierta; se aplica (A)                                 |
| D-TBO-12 | ¿Qué y cómo se sincroniza?                                      | Herramienta aparte, lista cerrada de países, contenido por demanda | RF-30, RF-32                 | Abierta; se aplica (A)                                 |
| D-TBO-13 | ¿Qué pasa con un hotel que está en los dos proveedores?         | Una tarjeta, heurística conservadora                               | RF-34, RF-40                 | Abierta; se aplica (A)                                 |
| D-TBO-14 | ¿De dónde sale la nacionalidad del pasajero?                    | Campo obligatorio y visible                                        | RF-06                        | Abierta; se aplica (A)                                 |
| D-TBO-15 | ¿Qué pasa si TBO cotiza en otra moneda?                         | Puerta de moneda, sin conversión                                   | RF-07, RF-13                 | Abierta; se aplica (A)                                 |
| D-TBO-16 | ¿Dónde aplica el precio mínimo de TBO?                          | En todo canal                                                      | RF-12                        | Abierta; se aplica (A)                                 |
| D-TBO-17 | ¿Cuántos hoteles, cuánta espera y a qué ritmo?                  | 100 códigos, 10 s, 5 QPS                                           | RF-05, RF-14, RNF-01, RNF-02 | Abierta; se aplica (A)                                 |
| D-TBO-18 | ¿En qué búsquedas se consulta TBO?                              | Opt-in hasta conocer el costo por búsqueda                         | RF-36                        | Abierta; se aplica (A)                                 |
| D-TBO-19 | ¿Cuándo ve el vendedor las políticas de cancelación?            | Al abrir un hotel, "sujetas a confirmación"                        | RF-05, RF-11                 | Abierta; se aplica (A)                                 |
| D-TBO-20 | ¿Qué pasa si el precio cambia antes de reservar?                | Revalidar siempre; si baja, avisar                                 | RF-15, RF-20                 | Abierta; se aplica (A)                                 |
| D-TBO-21 | ¿Cómo se cobra y se controla el crédito `Limit`?                | Retención antes del Book y límite por sub-agencia                  | RF-23                        | Abierta; se aplica (A)                                 |
| D-TBO-22 | ¿Se venden sueltas las tarifas "solo con aéreo"?                | No                                                                 | RF-17                        | Abierta; se aplica (A)                                 |
| D-TBO-23 | ¿Qué datos de huéspedes y contacto van a TBO?                   | Contacto de la agencia y nombres en ASCII                          | RF-18                        | Abierta; se aplica (A)                                 |
| D-TBO-24 | ¿Qué pasa con un Book incierto que no aparece?                  | Bloqueado hasta evidencia fuerte                                   | RF-21, RF-28                 | Abierta; se aplica (A)                                 |
| D-TBO-25 | ¿Cómo se ve una cancelación en curso o sin verificar?           | "Cancelación en curso" con cierre automático seguro                | RF-25, RF-26                 | Abierta; se aplica (A)                                 |
| D-TBO-26 | ¿Cómo se reembolsa al cliente al cancelar?                      | Estimación y aprobación manual                                     | RF-25                        | Abierta; se aplica (A)                                 |
| D-TBO-27 | ¿Quién abre el ticket del HCN y qué pasa con reservas externas? | Cola interna y solo reporte                                        | RF-27, RF-28                 | Abierta; se aplica (A)                                 |
| D-TBO-28 | ¿Con qué cuenta se opera la post-venta?                         | La que creó la reserva                                             | RF-29                        | Abierta; se aplica (A)                                 |
| D-TBO-29 | ¿Dónde corren los jobs periódicos?                              | Planificador de BullMQ en la API                                   | RF-27, RF-28, RF-38          | Abierta; se aplica (A)                                 |
| D-TBO-30 | ¿Cómo se protege el transporte de la credencial?                | `http` solo en test; `baseUrl` live obligatorio                    | RF-01, RF-37                 | Abierta; se aplica (A)                                 |
| D-TBO-31 | ¿Dónde se guardan los RQ/RS completos?                          | Bóveda cifrada; zip de certificación sin redactar                  | RNF-05, RC-03                | Abierta; se aplica (A)                                 |
| D-TBO-32 | ¿Qué pasa cuando falla la cuenta de una agencia?                | Circuito por cuenta y kill-switch en dos niveles                   | RNF-03, RNF-11               | Abierta; se aplica (A)                                 |
| D-TBO-33 | ¿Qué se versiona en Git?                                        | Originales saneados, derivados y set certificado                   | RNF-15                       | Abierta; se aplica (A)                                 |
| D-TBO-34 | ¿Qué gaps preexistentes se arreglan con TBO?                    | Solo los que TBO necesita                                          | Alcance de F3                | Abierta; se aplica (A)                                 |
| D-TBO-35 | ¿Dónde vive el portal que prueba TBO?                           | Stack de certificación separado                                    | RC-07                        | Abierta; se aplica (A)                                 |
| D-TBO-36 | ¿Qué plataformas se declaran a TBO?                             | Solo el portal B2B                                                 | RC-01                        | Abierta; se aplica (A)                                 |
| D-TBO-37 | ¿En qué idioma recorre TBO el portal?                           | Guía en inglés                                                     | RF-39                        | Abierta; se aplica (A)                                 |
| D-TBO-38 | ¿Qué entidad, cuenta y contacto figuran en la certificación?    | La entidad titular de la cuenta que se hereda                      | D-TBO-05                     | Abierta; se aplica (A)                                 |

### 7.1 Estrategia y comercial

#### D-TBO-01 — ¿En qué orden entra TBO frente a Hotelbeds y RateHawk?

**Estado: abierta; se implementa con (A) hasta que el founder diga otra cosa.** Desde el 2026-09-25 ya no depende de
D-TBO-02, que se cerró con (B).

El roadmap prevé hoteles "HotelDo + Hotelbeds" en la Ola 1, con el adapter de Hotelbeds en el mes 3
(`docs/discovery/07-roadmap-olas.md:14`, `:94`), y la investigación recomienda Hotelbeds + HotelDo + RateHawk
(`docs/research/03-integraciones-ecosistema.md:339`, `:410`). TBO no aparece en ninguno. Hoy el único proveedor de
hoteles en producción es Despegar. VERIFICADO-CODIGO.

- **(A) Recomendada. TBO es el segundo proveedor de hoteles y con él se generaliza la vertical; Hotelbeds y RateHawk
  vienen después sobre la misma base.** El vendedor ve hoteles de Despegar y TBO en la misma búsqueda. Consecuencias:
  el primer bedbank en llegar a certificación es el que ya tiene contrato documentado y proceso de certificación en
  el repo; registry, contrato neutral, catálogo multi-proveedor y saga de reserva quedan listos para el tercero; con
  el tercero se decide GIATA, que la investigación da por "Imprescindible cuando integras 3+ bedbanks"
  (`docs/research/03-integraciones-ecosistema.md:141`). Hay que actualizar el roadmap y
  `docs/platform/12-modelo-consolidador-y-plan.md` §4.2. Estaba condicionada a una compuerta de valor que ya no
  existe (D-TBO-02 B): no hay cifra que la revierta sola. Si la medición informativa o la de producción muestran poco
  aporte, pasar a (B) es una decisión nueva del founder, y la generalización se conserva igual.
- **(B) Hotelbeds primero, como dice el roadmap; TBO después.** El vendedor ve Hotelbeds antes que TBO.
  Consecuencias: la generalización se paga con Hotelbeds, que tiene sandbox público
  (`docs/research/03-integraciones-ecosistema.md:84`); entran antes a la conversación comercial sus mínimos de
  producción ("USD 5-15k/mes en TTV", `:87`, dato de investigación no verificado externamente); los documentos de TBO
  esperan.
- **(C) TBO y Hotelbeds en paralelo.** Consecuencias: más cobertura antes, pero exige dos equipos y el equipo técnico
  está por contratar ([07](./07-certificacion.md) DC-4).
- **(D) RateHawk primero** ("Sin setup, mínimos bajos. **Muy recomendado**", `docs/research/03-integraciones-ecosistema.md:131`).
  Consecuencias: no hay documentación en el repo; se empieza por la solicitud comercial.

**Bloquea:** todo el plan de [09](./09-plan-implementacion.md). **Consolida:** pedido explícito del encargo de este
documento; R-26.

#### D-TBO-02 — ¿Se mide el valor de TBO antes de construir la reserva?

**Estado: CERRADA el 2026-09-25 con la opción (B), sin compuerta.** El founder eligió construir todo; la medición de
§2.3 se conserva como información y no bloquea ningún PR ni fase ([09](./09-plan-implementacion.md) §10). La
recomendada (A) queda abajo como registro.

Ningún documento del set cuantifica lo que TBO aporta (§2.3).

- **(A) Recomendada, no elegida. Compuerta entre el catálogo (F2) y la reserva (F4), con umbral acordado antes de
  medir.** El founder recibe dos cifras (cobertura incremental y mejora de precio, §2.3) y decide seguir o parar.
  Consecuencias: antes de la compuerta solo se invierte en el ACL, el arnés y el catálogo, que además son los
  instrumentos de la medición; el zip de certificación puede enviarse igual (D-TBO-05), porque sus respuestas sirven
  también a (B) de D-TBO-01. La muestra de precios necesita acceso comercial al portal B2B de TBO (INFERIDO).
- **(B) Elegida el 2026-09-25. Sin compuerta: se construye todo y el valor se mide en producción.** Consecuencias:
  si el aporte es bajo, el costo de F4-F6 ya está gastado.
- **(C) Medir recién con credenciales live.** Consecuencias: las credenciales live llegan con el sign-off (Cert, Sign
  Off / API Live Credentials), es decir, con todo construido: equivale a (B).

**Bloqueaba:** F4, F5 y F6; con (B) no bloquea nada. **Consolida:** §2.3; R-26.

#### D-TBO-03 — ¿Con qué cuenta TBO reserva cada agencia?

**Estado: CERRADA el 2026-09-25 con la opción (A).** Cuenta del consolidador heredada a su red, sin fallback a
variables de entorno de plataforma.

`Limit` carga la reserva al crédito de la cuenta titular de la credencial (INFERIDO, [03](./03-prebook-y-book.md)
§7.4). No se sabe si la certificación cubre cuentas de agencias (→ [Q-77](./10-preguntas-para-tbo.md#q-77)). Despegar y LATAM caen a
credenciales de plataforma cuando el tenant no tiene cuenta (`despegar-hotels.factory.ts:27-35`,
`latam-ndc.factory.ts:79-84`); el registry de vuelos solo presta credenciales de plataforma a `latam-ndc`
(`apps/api/src/providers/flight-provider.registry.ts:25`). VERIFICADO-CODIGO.

- **(A) Recomendada y elegida el 2026-09-25. La cuenta TBO certificada del consolidador vive en la bóveda de su nodo y
  se hereda a su red; no hay fallback a variables de entorno; las agencias con cuenta TBO propia quedan deshabilitadas
  hasta que TBO confirme que la certificación las cubre.** Una agencia sin herencia ve "TBO no habilitado" con el
  motivo; las sub-agencias del consolidador venden con su cuenta. Consecuencias: la plataforma no presta crédito; el
  crédito del consolidador financia a su red y hace falta el control interno de D-TBO-21. Es el patrón de Sabre, BYOC
  puro.
- **(B) Fallback a una cuenta de plataforma por variables de entorno, como Despegar y LATAM.** Cualquier tenant ve TBO
  sin configurar nada. Consecuencias: las reservas de todas las agencias consumen el crédito de la cuenta de la
  plataforma; exige listar `tbo-hotels` en `PLATFORM_DEFAULT_HOTEL_PROVIDERS` y cablear `TBO_*` en `deploy.yml` y en
  el compose de la API ([06](./06-seams-integracion-repo.md) §5.2, TP-50, TP-51).
- **(C) BYOC abierto desde el día 1.** Cada agencia carga su propia cuenta TBO. Consecuencias: cada una arriesga su
  crédito, pero TBO podría no reconocer esas cuentas en una integración certificada con otra (R-03).

**Bloquea:** RF-23, RF-36, RF-37; D-TBO-38. **Consolida:** [06](./06-seams-integracion-repo.md) §10 (BYOC puro o
fallback); [07](./07-certificacion.md) §2.8 (BYOC deshabilitado hasta la respuesta).

#### D-TBO-04 — ¿Qué cuenta usa el sync del catálogo?

Aunque todas las agencias traigan su cuenta, el catálogo necesita una propia ([05](./05-contenido-estatico-e-inventario.md)
§6.6). El QPS no se publica (p. 9).

- **(A) Recomendada. Una cuenta de plataforma dedicada al sync, de test y de live, pedida a TBO.** El vendedor no ve
  diferencia; el sync nunca le quita cuota a la venta y se puede apagar el uno sin el otro. Consecuencias: gestión
  comercial con TBO; variables `TBO_SYNC_*` en el VPS.
- **(B) La misma cuenta de ventas del consolidador.** Consecuencias: una corrida de catálogo puede provocar `429` en
  búsquedas reales; obliga a correr el sync en horas sin venta (D-TBO-12).

**Bloquea:** RF-30. **Consolida:** [05](./05-contenido-estatico-e-inventario.md) §14 punto 7.

#### D-TBO-05 — ¿Cuándo se abre la certificación?

La web de hoteles solo busca: el portal que TBO prueba no existe ([07](./07-certificacion.md) §1).

- **(A) Recomendada. Formulario, workflow y zip en cuanto el ACL y el arnés pasen los 8 casos; la UI se construye en
  paralelo y se le informa a TBO la fecha estimada del portal.** Consecuencias: las respuestas de TBO a los huecos del
  contrato llegan antes de construir la UI y la condicionan; la verificación de portal queda para después.
- **(B) Esperar al portal completo para encadenar todas las fases.** Consecuencias: las preguntas se responden tarde
  y lo construido puede tener que rehacerse.

**Bloquea:** el calendario de F6. **Consolida:** [07](./07-certificacion.md) DC-5.

### 7.2 Arquitectura

#### D-TBO-06 — ¿Se generaliza la vertical de hoteles o se hace un módulo TBO aparte?

**Estado: CERRADA el 2026-09-25 con la opción (A).** Al firmarla, el founder agregó un requisito: **"me tiene que
mostrar de dónde es"**. Queda como RF-40: cada tarifa de la búsqueda combinada lleva su proveedor y la web lo pinta
con la política de divulgación que ya existe para vuelos (por defecto oculto; ocultar gana en la cadena; el
consolidador lo activa en el panel de proveedores). No se crea otra regla.

La vertical es mono-proveedor por construcción: `HotelsService` inyecta el factory concreto de Despegar y tipa su
contrato con tipos del ACL de Despegar (`apps/api/src/hotels/hotels.service.ts:2-15`, `:21`, `:24`, `:29`, VERIFICADO-CODIGO;
[06](./06-seams-integracion-repo.md) §5.1).

- **(A) Recomendada y elegida el 2026-09-25. Generalizar: contrato neutral Zod en
  `packages/canonical/src/hotel-offer.ts`, puertos en `packages/domain`, `HotelProviderRegistry` espejo del de vuelos
  y Despegar implementando el contrato.** El vendedor ve una sola búsqueda con Despegar y TBO juntos, con puerta de
  moneda, hoteles agrupados y, si la divulgación está encendida, el proveedor de cada tarifa (RF-40). Consecuencias:
  toca el ACL de Despegar y también `HotelsService`, `HotelsController`, sus esquemas y su filtro, que hoy no tienen
  tests, así que los tests de caracterización van antes (RNF-14). El espejo no toca `src/search/**`; un registry
  genérico queda como deuda registrada.
- **(B) Generalizar con un `ProviderRegistry<TAdapter>` genérico del que vuelos pase a ser una instancia.** Lo visible
  es igual a (A). Consecuencias: más limpio, pero mueve código de vuelos con umbral de cobertura propio
  ([06](./06-seams-integracion-repo.md) §5.4).
- **(C) Módulo TBO paralelo** (`apps/api/src/hotels-tbo/`, rutas `/hotels/tbo/*`). El vendedor busca en dos pantallas
  y no compara precios entre proveedores. Consecuencias: contrato, pricing, telemetría y pantallas duplicados; el
  intent antes del Book se construye igual; el destino exige autocomplete propio desde el día 1 (D-TBO-10 B); el
  tercer bedbank obliga a generalizar de todos modos ([06](./06-seams-integracion-repo.md) §5.7).

Si se elige que el contrato viva en `apps/api` en lugar de `packages/canonical`, los ACL no pueden importarlo y cada
uno necesita un wrapper que duplique el mapeo ([06](./06-seams-integracion-repo.md) §5.3): no se recomienda.

**Bloquea:** RF-35, RF-36, RF-40, F3. **Consolida:** [06](./06-seams-integracion-repo.md) §10 (generalizar o
módulo; forma del registry; dónde vive el contrato).

#### D-TBO-07 — ¿Las reservas de hotel se guardan como órdenes antes del Book?

**Estado: CERRADA el 2026-09-25 con la opción (A).** Intent `pending` con `BookingReferenceId` antes del Book.

TBO obliga a recuperar un Book fallido con `BookingDetail` por `BookingReferenceId` (p. 42). Hoy Despegar no persiste
nada (`apps/api/src/hotels/hotels.service.ts:175-178`) y Autos persiste después de confirmar
(`apps/api/src/orders/orders.service.ts:274-280`). VERIFICADO-CODIGO.

- **(A) Recomendada y elegida el 2026-09-25. Sí: intent `pending` con `BookingReferenceId` antes del Book, por una API
  pública de intent en `OrdersService`.** La reserva aparece en Reservas como "Verificando" aunque TBO no conteste, y
  nunca se pierde. Consecuencias: TP-32 a TP-39 y TP-65 de [06](./06-seams-integracion-repo.md) §6.
- **(B) Patrón Autos: se guarda después de confirmar.** Un Book con timeout no deja fila: la agencia no ve la reserva
  y el crédito en TBO queda consumido sin rastro. Incumple p. 42.
- **(C) No persistir, como Despegar hoy.** Lo mismo que (B), y además no hay post-venta.

**Bloquea:** RF-19 a RF-29, F4. **Consolida:** [06](./06-seams-integracion-repo.md) §10; [03](./03-prebook-y-book.md) §8.5.

#### D-TBO-08 — ¿Despegar pasa al mismo flujo de órdenes ahora o después?

Las reservas de Despegar no se persisten ([06](./06-seams-integracion-repo.md) §8 G1) y la web no tiene pantalla de
reserva de hotel ([07](./07-certificacion.md) §1).

- **(A) Recomendada. Después, como tarea aparte, cuando existan los tests de la vertical.** Para el vendedor no cambia
  nada con Despegar, porque hoy no puede reservar hoteles desde la web. Consecuencias: durante un tiempo la API tiene
  dos comportamientos de reserva de hotel, y Reservas muestra solo las de TBO.
- **(B) En el mismo trabajo.** Las reservas de Despegar hechas por API aparecen en Reservas. Consecuencias: más
  alcance y más riesgo sobre el único proveedor de hoteles en producción.

**Bloquea:** nada de TBO. **Consolida:** [06](./06-seams-integracion-repo.md) §10.

#### D-TBO-09 — ¿El Book espera la respuesta de TBO dentro de la petición del navegador?

El Book puede tardar 120 s (p. 8), más hasta 23 s del PreBook de revalidación. Cloudflare corta a los 100 s por
defecto (INFERIDO).

- **(A) Recomendada. Híbrido: `201` si termina en menos de 25 s; si no, `202` y la web consulta la orden.** El vendedor
  ve "Confirmando…" y después el resultado. Consecuencias: cambios en la ruta proxy de la web y apagado ordenado del
  contenedor (RF-22).
- **(B) Síncrono.** Parte de las reservas lentas termina en un error 524 y pasa a la recuperación de RF-21.

**Bloquea:** RF-22. **Consolida:** [03](./03-prebook-y-book.md) D-03-A; [06](./06-seams-integracion-repo.md) §10.

### 7.3 Catálogo y destino

#### D-TBO-10 — ¿Cómo se traduce el destino que elige el vendedor a ciudades TBO?

Hoy el destino es el id geográfico de Despegar de punta a punta, y TBO solo busca por `HotelCodes` (p. 10;
[05](./05-contenido-estatico-e-inventario.md) §8.1).

- **(A) Recomendada. Tabla de mapeo calculada fuera de línea, `city_id` de Despegar → `CityCode` de TBO, por
  solapamiento de hoteles y distancia de centroides, con revisión manual de los casos dudosos.** El vendedor usa el
  mismo autocomplete; TBO aparece solo en destinos mapeados y, si no, se ve "TBO: sin mapeo de destino".
  Consecuencias: la búsqueda TBO depende del autocomplete y de las credenciales de Despegar (R-19). Un tenant sin
  autocomplete de la plataforma recibe sugerencias del catálogo local de TBO, que la búsqueda resuelve sin el mapa
  ([05](./05-contenido-estatico-e-inventario.md) §8.5, aplicado el 2026-09-27).
- **(B) Destinos y autocomplete propios desde ya** (`pg_trgm` + `unaccent`). El vendedor ve un autocomplete nuevo con
  nombres en ES y PT. Consecuencias: permite tenants solo-TBO; más trabajo de UI y de curaduría de nombres. Es
  obligatoria si se elige D-TBO-06 (C).
- **(C) Radio geográfico sin tabla.** TBO devuelve hoteles de ciudades vecinas y el resultado no es auditable.
  Consecuencias: sirve como diagnóstico interno, no para vender.

**Bloquea:** RF-33. **Consolida:** [05](./05-contenido-estatico-e-inventario.md) §14 punto 5; [06](./06-seams-integracion-repo.md)
§10 (destino multi-proveedor).

#### D-TBO-11 — ¿El catálogo TBO es uno para todos o uno por cuenta?

El contrato no lo dice (p. 51-69). Los códigos se describen como "Unique TBOH" (p. 55, 58, 65-66) y el perfil de
cuenta fija al menos la moneda (p. 13). INFERIDO en los dos sentidos ([05](./05-contenido-estatico-e-inventario.md) §11).

- **(A) Recomendada. Uno global, sincronizado con la cuenta de plataforma; la disponibilidad sí es por cuenta; una
  sonda comparativa en certificación lo verifica.** Todas las agencias ven los mismos hoteles; si una cuenta BYOC no
  tiene acceso a alguno, simplemente no vuelve en la búsqueda. Consecuencias: si la sonda muestra diferencias, se
  agrega una tabla de alcance por cuenta sin rehacer el sync.
- **(B) Uno por cuenta.** Consecuencias: el sync corre por cada nodo con cuenta propia, tiene que descifrar
  credenciales de la bóveda (un secreto nuevo en otro contenedor) y multiplica las llamadas.

**Bloquea:** RF-30, RF-31. → [Q-60](./10-preguntas-para-tbo.md#q-60). **Consolida:** encargo de este documento (sync global o por credencial);
[06](./06-seams-integracion-repo.md) §9 H8.

#### D-TBO-12 — ¿Qué se sincroniza y cómo?

`CityList` devuelve "the complete city code and name for the requested country" y su ejemplo incluye aldeas
(p. 53-54, VERIFICADO-PDF; que la lista sea exhaustiva es INFERIDO), y cada ciudad cuesta una llamada de
`TBOHotelCodeList`. El sync actual corre a las 03:30 UTC (`.github/workflows/sync-hotel-inventory.yml:4-6`,
VERIFICADO-CODIGO), que son las 22:30 en Bogotá y Lima.

- **(A) Recomendada. Herramienta aparte `tools/sync-tbo-hotel-inventory`; países CO, PE y BR más los destinos
  emisivos de la lista comercial (por ejemplo US, MX, DO, AR, CL, ES) en una lista cerrada ampliable; contenido
  rico e idiomas ES, PT y EN solo para destinos con demanda, y ES y PT para el resto con EN bajo demanda; imágenes por
  enlace directo a TBO; corridas horarias con presupuesto alrededor de las 08:00 UTC.** El vendedor ve hoteles TBO
  con fotos en los destinos que más vende; en los demás, sin fotos hasta que haya demanda. Consecuencias: el job de
  Despegar no se toca; segunda imagen y segundo workflow.
- **(B) Igual que (A), pero solo destinos domésticos CO, PE y BR.** TBO no aparece en destinos emisivos como Miami o
  Cancún.
- **(C) Todo el catálogo y todo el contenido.** Consecuencias: volumen desconocido
  ([05](./05-contenido-estatico-e-inventario.md) §6.7) contra un QPS desconocido; no antes de que TBO publique el
  límite.

Convertir el sync de Despegar en un runner multi-proveedor no se recomienda en ninguna opción: cambia el contrato de
un job que funciona y las dos fuentes no se parecen ([05](./05-contenido-estatico-e-inventario.md) §6.2). Copiar las
imágenes a MinIO/S3 queda para cuando TBO diga si lo permite y si los tokens caducan (→ [Q-67](./10-preguntas-para-tbo.md#q-67)).

**Bloquea:** RF-30, RF-32. **Consolida:** [05](./05-contenido-estatico-e-inventario.md) §14 puntos 1, 2, 3, 4, 8 y 9;
[06](./06-seams-integracion-repo.md) §10 (sync TBO).

#### D-TBO-13 — ¿Qué pasa con un hotel que está en Despegar y en TBO? ¿Se ve el proveedor?

El flag de divulgación del proveedor de la migración 0036 solo aplica hoy a vuelos
([05](./05-contenido-estatico-e-inventario.md) §9.2).

- **(A) Recomendada. Una tarjeta por hotel con las tarifas de los dos proveedores, agrupadas con una heurística
  conservadora y revisión manual de los casos dudosos; el proveedor se muestra al vendedor según el flag de
  divulgación, extendido a hoteles.** Cada tarifa de la tarjeta conserva su propia pastilla (RF-40, que concreta el
  requisito del founder en D-TBO-06). Consecuencias: una fusión falsa es peor que un duplicado, así que ante la duda
  no se agrupa; detalle, PreBook y confirmación muestran siempre los datos del proveedor que vende.
- **(B) Duplicados etiquetados por proveedor hasta tener GIATA.** El vendedor ve el mismo hotel dos veces.
- **(C) Licenciar GIATA ahora** ("licencia anual USD 5-25k según volumen", `docs/research/03-integraciones-ecosistema.md:142`,
  dato de investigación no verificado externamente).

**Bloquea:** RF-34, RF-40 (tarjeta agrupada). **Consolida:** [05](./05-contenido-estatico-e-inventario.md) §14 punto 6.

### 7.4 Venta

#### D-TBO-14 — ¿De dónde sale la nacionalidad del pasajero principal?

TBO pide no fijarla en código y declina responsabilidad si se hace (p. 71). Hoy la búsqueda no la pide y el CRM la
guarda en alfa-3 ([02](./02-search-y-oferta-canonica.md) §5.2).

- **(A) Recomendada. Campo obligatorio y visible en cada búsqueda (web y WhatsApp), prellenado con el cliente elegido
  o con la última búsqueda; sin él, TBO no participa y se explica por qué.** Consecuencias: un paso más para el
  vendedor, que el prellenado reduce.
- **(B) Valor por defecto igual al país del tenant, visible y editable.** Más rápido. Consecuencias: en la práctica es
  un valor fijo por agencia, y el riesgo de tarifas mal aplicadas queda en la agencia.
- **(C) Valor por defecto en la configuración de la cuenta TBO.** Invisible para el vendedor. Es exactamente lo que el
  Key Point 1 desaconseja.

**Bloquea:** RF-06, CK-01. **Consolida:** [02](./02-search-y-oferta-canonica.md) D02-1; [07](./07-certificacion.md) DC-6.

#### D-TBO-15 — ¿Qué pasa cuando TBO cotiza en una moneda distinta de la de venta?

La moneda la fija el perfil de la cuenta (p. 13), y con BYOC cada agencia puede tener otra. `Money` asume siempre 2
decimales (`packages/canonical/src/money.ts:41-46`, VERIFICADO-CODIGO).

- **(A) Recomendada. Puerta de moneda como en vuelos: las ofertas en otra moneda no se muestran, el motivo sí, y el
  vendedor puede cambiar la moneda de la búsqueda; los perfiles en monedas sin 2 decimales se rechazan con motivo y se
  pide a TBO un perfil en USD u otra moneda con 2 decimales.** Consecuencias: generalizar `Money` queda como tarea
  transversal aparte.
- **(B) Lista de monedas aceptadas por tenant (por ejemplo, su moneda y USD), mostradas juntas y sin ordenarlas entre
  sí por precio.** Consecuencias: el vendedor compara a ojo.
- **(C) Conversión con tasa de cambio.** Contradice la doctrina de vuelos ("una tasa inventada convierte un precio real
  en uno que nadie puede cobrar", `apps/api/src/search/search.service.ts:70-109`). No se recomienda.
- **(D) (A) más generalizar `Money` al exponente ISO 4217 ya.** Consecuencias: correcto a largo plazo, pero toca todas
  las verticales y retrasa TBO.

**Bloquea:** RF-07, RF-13. **Consolida:** [02](./02-search-y-oferta-canonica.md) D02-2 y D02-5; [06](./06-seams-integracion-repo.md)
§10 (moneda).

#### D-TBO-16 — ¿Dónde aplica el precio mínimo de TBO (`RecommendedSellingRate`)?

"The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate" (p. 13, 21). El waterfall no
conoce pisos ni canales ([02](./02-search-y-oferta-canonica.md) §9.5).

- **(A) Recomendada. En todo precio final al viajero, en todos los canales; si la cascada queda por debajo, el precio
  sube al piso y la diferencia es margen del tenant que vende.** Consecuencias: el touchpoint del waterfall pasa a
  obligatorio desde el día 1 ([06](./06-seams-integracion-repo.md) TP-29).
- **(B) Solo en los canales donde el viajero compra directo (web B2C y WhatsApp al viajero); en el panel B2B es un
  aviso.** Consecuencias: si TBO entiende que B2B2C también es "B2C client", la agencia vende por debajo.
- **(C) Solo un aviso.** El mayor riesgo contractual; la verificación de portal puede rechazarlo.

**Bloquea:** RF-12, CK-09. → [Q-23](./10-preguntas-para-tbo.md#q-23) (alcance B2B2C y paquetes). **Consolida:** [02](./02-search-y-oferta-canonica.md)
D02-4; [07](./07-certificacion.md) H-09.

#### D-TBO-17 — ¿Cuántos hoteles TBO se consultan, cuánto se espera y a qué ritmo?

TBO recomienda hasta 100 códigos por llamada (p. 10), un timeout de Search de 5 a 23 s (p. 8) y no publica el QPS
(p. 9). Hoy se consultan 50 hoteles ordenados por id (`apps/api/src/hotels/hotels.service.ts:131-141`).

- **(A) Recomendada. Hasta 100 códigos por búsqueda en una sola llamada, elegidos por relevancia; `ResponseTime` de
  10 s (timeout de 13 s); 5 QPS y 4 llamadas concurrentes por cuenta.** La búsqueda espera a TBO 13 s como máximo.
  Consecuencias: la certificación mide el mismo Search con 10 y con 20 s; si con 10 s se pierden opciones de forma
  material, se sube.
- **(B) Completitud: lotes paralelos de 100 hasta 300 códigos y `ResponseTime` de 20 s (timeout de 23 s).** Más
  hoteles, búsquedas de hasta 23 s. Consecuencias: depende del QPS que TBO no publicó.
- **(C) Como hoy: 50 códigos por id.** La mitad de lo que TBO recomienda, elegida sin criterio comercial.

**Bloquea:** RF-05, RF-14, RNF-01, RNF-02. **Consolida:** [02](./02-search-y-oferta-canonica.md) D02-3;
[01](./01-autenticacion-conectividad-y-errores.md) §14 puntos 7 y 8; §9 C-01.

#### D-TBO-18 — ¿En qué búsquedas se consulta TBO?

TBO no documenta costo por búsqueda ni límite de búsquedas por reserva ([06](./06-seams-integracion-repo.md) §9 H10).
Sabre quedó en `always` con un comentario que pide `opt-in`, y [06](./06-seams-integracion-repo.md) pide no repetir
esa divergencia.

- **(A) Recomendada. Opt-in por tenant hasta que TBO confirme que no hay costo por búsqueda ni límite de
  look-to-book; después, en toda búsqueda.** Solo los tenants habilitados ven TBO las primeras semanas.
- **(B) En toda búsqueda desde el día 1.** Consecuencias: si hay costo por búsqueda, se descubre en la factura.
- **(C) Solo como respaldo, cuando Despegar no devuelve resultados.** Consecuencias: TBO nunca compite en precio.

**Bloquea:** RF-36. → [Q-87](./10-preguntas-para-tbo.md#q-87). **Consolida:** [06](./06-seams-integracion-repo.md) §10 (`callPolicy`).

#### D-TBO-19 — ¿Cuándo ve el vendedor las políticas de cancelación?

Sin detalle, Search no trae políticas; TBO recomienda buscar sin detalle y declara finales las de PreBook (p. 11, 71).

- **(A) Recomendada. El listado dice solo "reembolsable" o "no reembolsable"; al abrir un hotel se repite el Search
  solo para ese hotel con detalle y se muestran políticas y precio por noche "sujetos a confirmación"; el PreBook
  confirma.**
- **(B) Solo después del PreBook.** Más fiel a la recomendación de TBO, pero el vendedor elige a ciegas entre tarifas
  reembolsables.
- **(C) Siempre con detalle.** Contradice el Key Point 2 y hace las respuestas más pesadas y lentas.

**Bloquea:** RF-05, RF-11. **Consolida:** [02](./02-search-y-oferta-canonica.md) D02-6.

#### D-TBO-20 — ¿Qué pasa si el precio cambia entre la búsqueda y la reserva?

PreBook no trae indicador de cambio de precio (p. 20-23) y el PDF no dice qué hace el Book si el `TotalFare` no
coincide (p. 33).

- **(A) Recomendada. PreBook de revalidación siempre, justo antes del Book; si sube o cambian las condiciones, el
  vendedor reconfirma; si baja, se acepta y se avisa.** Suma hasta 23 s a la reserva.
- **(B) Como (A), pero también se reconfirma si baja.** Un paso más para el vendedor sin riesgo para nadie.
- **(C) Como (A), pero si baja se acepta sin avisar.**
- **(D) Sin revalidación si el PreBook que vio el vendedor tiene menos de N minutos.** Más rápido; el Book puede salir
  con un precio viejo, con efecto no documentado.

**Bloquea:** RF-15, RF-20. **Consolida:** [03](./03-prebook-y-book.md) D-03-B y D-03-C.

#### D-TBO-21 — ¿Cómo se cobra y cómo se controla el crédito `Limit`?

`Limit` consume el crédito de la cuenta titular (INFERIDO). TBO ve una sola cuenta aunque la hereden muchas
sub-agencias ([03](./03-prebook-y-book.md) §7.4). El cobro tiene que caber en los 30 minutos de Search a Book (p. 8).

- **(A) Recomendada. Antes del Book se retiene el precio de venta en la cartera o el crédito de la agencia que vende;
  si el viajero paga, el checkout alojado se autoriza antes del Book con un link que vence antes del minuto 27; las
  sub-agencias que heredan la cuenta tienen un límite interno que se controla antes de cada Book.** La agencia sin
  saldo ni crédito interno no puede reservar TBO, y el viajero que paga tarde tiene que volver a cotizar.
  Consecuencias: reutiliza la retención de cartera que ya existe (RF-23).
- **(B) Book primero, cobro después.** Más rápido. Consecuencias: el titular de la cuenta TBO financia las reservas
  que la agencia o el viajero no paguen.
- **(C) Solo cartera prepaga: la agencia necesita saldo a favor, sin crédito.** Menos riesgo y menos ventas.

**Bloquea:** RF-23, RF-20. D9 no se reabre: la saga que toma y libera la retención corre sobre BullMQ. **Consolida:** [03](./03-prebook-y-book.md)
D-03-G; [01](./01-autenticacion-conectividad-y-errores.md) §14 punto 9.

#### D-TBO-22 — ¿Se venden como hotel suelto las tarifas "solo con billete aéreo"?

La restricción existe solo como texto en `RateConditions` (p. 25, 30) y el repo no tiene reservas de paquete que
vinculen vuelo y hotel.

- **(A) Recomendada. No: la tarifa se muestra con el aviso "solo con vuelo" y el Book suelto se bloquea hasta que
  exista la reserva de paquete.**
- **(B) Sí, con advertencia al vendedor.** Consecuencias: riesgo contractual con TBO.
- **(C) Se ocultan desde que se detectan.** Consecuencias: como se detectan en el PreBook, la tarifa desaparece
  después de que el vendedor la eligió.

**Bloquea:** RF-17. → [Q-31](./10-preguntas-para-tbo.md#q-31). **Consolida:** [03](./03-prebook-y-book.md) D-03-D.

#### D-TBO-23 — ¿Qué datos de huéspedes y de contacto viajan a TBO?

`EmailId` y `PhoneNumber` se describen como datos "of the guest" (p. 33). El PDF no documenta caracteres admitidos y
muestra problemas de encoding (p. 51).

- **(A) Recomendada. Email y teléfono operativos de la agencia, configurables por tenant (marca blanca); nombres
  transliterados a ASCII (`José Muñoz` → `Jose Munoz`), con el original en el voucher.** El cliente final no queda
  expuesto a TBO. La sonda PR-09 dice si se puede pasar a UTF-8.
- **(B) Contacto del huésped y nombres en UTF-8.** El hotel puede contactar al huésped. Consecuencias: se pierde la
  relación con el cliente y hay riesgo de caracteres rotos.
- **(C) Contacto de la agencia y nombres en UTF-8.** Solo si PR-09 muestra que TBO y el hotel los reciben bien.

**Bloquea:** RF-18. → [Q-41](./10-preguntas-para-tbo.md#q-41), [Q-43](./10-preguntas-para-tbo.md#q-43), [Q-44](./10-preguntas-para-tbo.md#q-44). **Consolida:** [03](./03-prebook-y-book.md) D-03-E y D-03-H.

### 7.5 Post-venta

#### D-TBO-24 — ¿Qué pasa con un Book incierto que la verificación no encuentra?

El contrato no documenta la respuesta de "no existe" ni si reenviar el Book es seguro (p. 33, 42-44). Los documentos
del set adoptaron posturas distintas (§9 C-07).

- **(A) Recomendada. La reserva queda "Verificando" y bloqueada hasta tener evidencia fuerte: una conciliación por
  fecha con respuesta válida que cubra el día de creación tampoco la encuentra; recién entonces pasa a fallida, se
  libera la clave y se anula la retención o la autorización de cobro. Operaciones puede forzar esa conciliación con
  un botón.** El vendedor no puede volver a reservar esa misma venta hasta el cierre: minutos con el botón, hasta un
  día sin él.
- **(B) Tras el calendario de verificación (unos 60 minutos) la reserva pasa a fallida y el vendedor puede volver a
  reservar, con un aviso explícito; la conciliación diaria detecta un duplicado que aparezca tarde.** Consecuencias:
  vende antes, con riesgo de doble reserva y doble consumo del crédito.
- **(C) Fallida tras unos 10 minutos.** Cumple mejor la venta en menos de 2 minutos y arriesga más duplicados.
- **(D) Siempre una persona decide.**

**Bloquea:** RF-21, RF-28; el paso 7 del Anexo A de [07](./07-certificacion.md). **Consolida:**
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-C; [03](./03-prebook-y-book.md) D-03-F.

#### D-TBO-25 — ¿Cómo se ve una cancelación que TBO aceptó pero no terminó, y quién cierra una que no se pudo verificar?

Un `200` en Cancel dice "Booking is Cancelled" (p. 9), pero el enum tiene estados de cancelación en curso (p. 70-71).
Hoy una cancelación con desenlace desconocido queda bloqueada para siempre (`apps/api/src/orders/orders.service.ts:1809-1816`,
VERIFICADO-CODIGO según [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-B).

- **(A) Recomendada. La agencia ve "Cancelación en curso" (orden `pending` con subestado) hasta que TBO muestra
  `Cancelled`; un job de solo lectura cierra también las cancelaciones sin verificar, pero solo en la dirección
  segura; si TBO muestra la reserva vigente, pasa a revisión humana con la evidencia.**
- **(B) Un estado nuevo `cancelling`, visible en filtros y reportes, con el mismo job.** Consecuencias: toca la web,
  los reportes y el tipo compartido.
- **(C) "Cancelada" apenas TBO responde `200`; las no verificadas siguen yendo a una persona, como hoy.** Consecuencias:
  la agencia puede ver "Cancelada" mientras el hotel no liberó la reserva.

**Bloquea:** RF-25, RF-26; la liberación de la retención de cartera. **Consolida:**
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-A y PV-B.

#### D-TBO-26 — ¿Cómo se reembolsa al cliente final cuando se cancela?

`Cancel` no devuelve cargo ni reembolso (p. 42); las políticas de PreBook son finales (p. 71).

- **(A) Recomendada. Penalidad estimada con el snapshot de PreBook, visible antes de confirmar; el reembolso al
  cliente por checkout alojado se aprueba a mano en el back-office hasta cuadrar con la facturación de TBO.**
- **(B) Reembolso automático por el monto estimado cuando TBO muestra `Cancelled`.** Consecuencias: las diferencias
  con TBO las absorbe la plataforma o la agencia.
- **(C) La plataforma no reembolsa; la agencia lo gestiona por fuera.**

**Aclaración que se pide sin reabrir D9:** el disparador "Temporal antes del primer refund real", ¿incluye los
reembolsos al cliente por el PSP, o solo `refundFlightTickets`? **Bloquea:** RF-25. **Consolida:**
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-D.

#### D-TBO-27 — ¿Quién abre el ticket del HCN y qué se hace con las reservas hechas fuera de la plataforma?

TBO exige abrir un "operations ticket" cuando el HCN no llega, sin decir por dónde (p. 43). La conciliación verá
reservas hechas con la misma cuenta desde el portal de TBO (INFERIDO, p. 63).

- **(A) Recomendada. Cola interna de operaciones (evento y tarea en el panel, sin PII) y escalamiento a TBO por el
  canal comercial del consolidador; las reservas externas solo aparecen en un reporte del dueño de la cuenta.**
- **(B) Automático: email a TBO y reservas externas adoptadas como órdenes.** Consecuencias: TBO no documenta la
  dirección de operaciones; datos del huésped por email; a las órdenes adoptadas les falta el precio de venta.
- **(C) Delegado: se avisa a la agencia y las reservas externas se ignoran.**

**Bloquea:** RF-27, RF-28. **Consolida:** [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-F y PV-G.

#### D-TBO-28 — ¿Con qué cuenta se opera la post-venta de una reserva?

Hoy los factories resuelven en cada llamada la cuenta vigente del tenant.

- **(A) Recomendada. Siempre la cuenta con la que se creó la reserva (`orders.provider_account_id`); no se puede borrar
  ni desactivar una cuenta con reservas activas.**
- **(B) La cuenta vigente del tenant en cada operación.** Consecuencias: si la agencia pasa de cuenta heredada a
  propia, puede quedarse sin poder leer ni cancelar sus reservas viejas (R-29).

**Bloquea:** RF-29, RF-28. **Consolida:** [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §11 (regla de
arquitectura a confirmar).

#### D-TBO-29 — ¿Dónde corren los jobs periódicos de post-venta?

- **(A) Recomendada. Planificadores de BullMQ (`upsertJobScheduler`, disponible en la versión instalada) dentro de la
  API.** Reutilizan la bóveda, la RLS y el worker; Redis de producción corre con AOF. Pasa a (C) si la carga compite
  con la API.
- **(B) Cron de GitHub Actions contra un endpoint interno.** Consecuencias: ese endpoint máquina a máquina no existe, y
  el patrón actual del sync entra por SSH como `postgres`, saltando la RLS.
- **(C) Un contenedor worker dedicado.**

**Bloquea:** RF-27, RF-28, RF-38. **Consolida:** [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-E.

### 7.6 Transversal

#### D-TBO-30 — ¿Cómo se protege el transporte de la credencial?

El test es `http://` aunque el PDF pide HTTPS, y la URL live no se publica (p. 7).

- **(A) Recomendada. `http` solo con `environment: 'test'` y el host exacto de test; `environment` obligatorio;
  `baseUrl` obligatorio y sin valor por defecto en live; redirects manuales; sonda de HTTPS en test antes de
  certificar.** Una credencial live nunca puede terminar en el host de test.
- **(B) No integrar hasta que TBO confirme HTTPS en test.** Consecuencias: el calendario depende de la respuesta.
- **(C) `baseUrl` por defecto al host de test, como Despegar.** Consecuencias: una cuenta live sin `baseUrl` enviaría
  la contraseña live en claro al host de test. No se recomienda.

**Bloquea:** RF-01, RF-37. **Consolida:** [01](./01-autenticacion-conectividad-y-errores.md) §14 puntos 1 y 2;
[06](./06-seams-integracion-repo.md) §10 (`baseUrl` obligatorio).

#### D-TBO-31 — ¿Dónde se guardan los RQ/RS completos que TBO pide?

TBO exige logs completos para `UNEXPECTED_ERROR` (p. 9) y RQ/RS de los 8 casos para certificar (Cert, Integration on
Test Account). Eso choca con no loguear PII.

- **(A) Recomendada. Almacén separado y cifrado, con retención corta, acceso auditado y búsqueda por `requestId`; en
  live se exporta redactado salvo que TBO pida el dato real; el zip de certificación va sin redactar porque sus
  nombres son sintéticos por construcción y solo se tacha `Authorization`.**
- **(B) Solo payloads redactados.** Consecuencias: TBO puede rechazar los logs de soporte, y con el zip redactado no
  puede revisar que todos los huéspedes estén nombrados (CK-10).
- **(C) No guardar nada y capturar a mano durante la certificación.**

**Bloquea:** RNF-05, RC-03. **Consolida:** [01](./01-autenticacion-conectividad-y-errores.md) §14 punto 3;
[07](./07-certificacion.md) §6.6.

#### D-TBO-32 — ¿Qué pasa cuando falla la cuenta de una agencia, y cómo se apaga TBO?

Hoy un circuito único por código cuenta cualquier excepción como fallo, y el kill-switch no llega a producción
(RNF-03, RNF-11).

- **(A) Recomendada. El efecto depende del tipo de error; un `401` o un `402` abren solo el circuito de esa cuenta
  (5 y 15 minutos), avisan al titular y emiten un evento, sin cambiar el estado de la cuenta; kill-switch en dos
  niveles ("ventas" y "todo") cableado en producción.** Una agencia con la contraseña mal cargada no apaga TBO para
  el resto, y apagar las ventas no impide cancelar ni conciliar.
- **(B) Dejar el breaker y el kill-switch como están.** Cinco `401` de una agencia apagan TBO para todas durante 30 s;
  el kill-switch también frena cancelaciones y conciliación.
- **(C) (A) más desactivar automáticamente la cuenta ante `401` o `402`.** Consecuencias: hay que reactivarla a mano,
  aunque el problema haya sido momentáneo.

**Bloquea:** RNF-03, RNF-11; afecta también a Sabre. **Consolida:** [01](./01-autenticacion-conectividad-y-errores.md)
§14 puntos 4, 5 y 6; [06](./06-seams-integracion-repo.md) §10 (circuito por cuenta).

#### D-TBO-33 — ¿Qué se versiona en Git?

Los tres originales de `docs/tbo/` están sin versionar; la colección Postman trae el `EmailId` de una persona de TBO;
los derivados de extracción viven solo en el scratchpad ([00](./00-fuentes.md) §1, §3, §10 F-07).
`EXTERNAL_AGENCY.postman_collection.json` es la colección de LATAM NDC, no de TBO, y los dos expedientes tuvieron que
advertirlo ([00](./00-fuentes.md) §8; `docs/sabre/00-fuentes.md` §1).

- **(A) Recomendada. PDF y docx tal cual, colección Postman saneada (sin el `EmailId` de la persona de TBO; el
  `PhoneNumber` es de relleno, [00](./00-fuentes.md) §3)
  con el hash original anotado en 00; texto por página y `cert.txt` en `docs/tbo/evidence/` con un script de
  regeneración; el zip enviado y la tabla de sign-off en `docs/tbo/evidence/cert/<fecha>/`; la colección de LATAM
  movida a una carpeta de LATAM y saneada.** Sujeto a que TBO no imponga confidencialidad (→ [Q-94](./10-preguntas-para-tbo.md#q-94)).
- **(B) Originales y set de certificación fuera de Git; solo los documentos de análisis.** Consecuencias: las citas
  siguen valiendo (apuntan a página física), pero los fixtures reales quedan fuera del repo.
- **(C) Todo tal cual, incluida la colección con el email de una persona de TBO.**

**Bloquea:** RNF-15; la procedencia de los fixtures. **Consolida:** [00](./00-fuentes.md) (tres decisiones);
[07](./07-certificacion.md) DC-7.

#### D-TBO-34 — ¿Qué gaps preexistentes de la vertical se arreglan dentro del trabajo de TBO?

[06](./06-seams-integracion-repo.md) §8 lista 21 defectos de la vertical que existen hoy con Despegar.

- **(A) Recomendada. Solo los que TBO necesita: G1 (reservas persistidas), G2 (eventos), G7 (pertenencia antes de
  llamar al proveedor), G8 (breaker en todas las llamadas), G19 (tests previos) y las pantallas de reserva de G3; el
  resto, como tareas aparte.**
- **(B) Todos en el mismo trabajo.** Consecuencias: menos deuda y más alcance.
- **(C) Ninguno más allá de lo estrictamente necesario para compilar.** Consecuencias: TBO hereda defectos como la
  lectura de reservas sin verificar pertenencia (G7).

**Bloquea:** el alcance de F3. **Consolida:** [06](./06-seams-integracion-repo.md) §10 (gaps preexistentes).

### 7.7 Certificación

#### D-TBO-35 — ¿Dónde vive el portal de pruebas que usa TBO?

Hay un solo entorno desplegado, y un tenant sin cuenta propia usa credenciales de plataforma de Despegar y de LATAM
(R-05; [07](./07-certificacion.md) §7.1).

- **(A) Recomendada. Un stack de certificación separado (compose, base, Redis y subdominios propios) sin ninguna
  credencial real de ningún proveedor.** Aislamiento por construcción. Consecuencias: trabajo de infraestructura y un
  entorno más que mantener; de paso existe el `staging` que `CLAUDE.md` prevé.
- **(B) Un tenant aislado dentro de producción, con allowlist de proveedores por tenant aplicada en el servidor.**
  Consecuencias: más barato, pero la seguridad depende de tocar el fallback de Despegar, AgentCars y LATAM, y un solo
  olvido expone credenciales reales a terceros.

**Bloquea:** RC-07, F6. **Consolida:** [07](./07-certificacion.md) DC-1.

#### D-TBO-36 — ¿Qué plataformas se declaran en el formulario de TBO?

- **(A) Recomendada. Solo el portal web B2B en esta ronda.**
- **(B) B2B, B2C y WhatsApp o móvil desde el inicio.** Consecuencias: TBO verificaría el piso de precio en B2C, y
  `apps/web-b2c` no existe.

**Bloquea:** RC-01. → [Q-78](./10-preguntas-para-tbo.md#q-78) (si sumar canales obliga a recertificar). **Consolida:** [07](./07-certificacion.md) DC-2.

#### D-TBO-37 — ¿En qué idioma recorre TBO el portal?

La web B2B está solo en español y no hay paquete de i18n ([07](./07-certificacion.md) §7.1).

- **(A) Recomendada. Guía de recorrido en inglés con glosario sobre la UI en español (Anexo B de
  [07](./07-certificacion.md)).**
- **(B) Construir un locale EN antes de la verificación de portal.** Solo si TBO lo exige.

**Bloquea:** RF-39 (U-20). **Consolida:** [07](./07-certificacion.md) DC-3.

#### D-TBO-38 — ¿Qué entidad, cuenta y contacto técnico figuran en la certificación?

El formulario pide razón social, dirección, ciudad y país, y un contacto técnico con email y teléfono. El equipo
técnico está por contratar ([07](./07-certificacion.md) §2.2).

- **(A) Recomendada. La entidad titular de la cuenta TBO que se hereda en la red (coherente con D-TBO-03 A), con un
  contacto técnico nominal interino y un buzón de rol en copia hasta contratar al responsable.**
- **(B) Esperar a contratar al responsable técnico para darse de alta.** Consecuencias: retrasa D-TBO-05.
- **(C) Certificar con una entidad distinta de la titular de la cuenta que se hereda.** Consecuencias: separa quién
  certifica de quién financia el crédito `Limit`; TBO podría no reconocer la cuenta en la integración certificada.

**Bloquea:** D-TBO-05, el nombre del zip. **Consolida:** [07](./07-certificacion.md) DC-4.

### 7.8 Decisiones técnicas que resuelve este documento sin elevarlas

Son reversibles y no cambian nada visible. Se registran para que no se reabran en cada revisión.

| Tema                           | Regla                                                                                                                                                                                                                            | Motivo                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Campo `types` del paquete      | `./dist/index.d.ts`, como Sabre                                                                                                                                                                                                  | Evita compilar contra la fuente y ejecutar un `dist` viejo; CI ya construye antes del lint ([06](./06-seams-integracion-repo.md) §4.1) |
| Import de Zod                  | `zod` como dependencia directa dentro de `providers/tbo-hotels` (como `providers/sabre/package.json:32`); `@sales-travel/validation` dentro de `apps/api` (como `apps/api/src/provider-credentials/dto.ts:1`). VERIFICADO-CODIGO | §9 C-13                                                                                                                                |
| Modelo de errores              | El de [01](./01-autenticacion-conectividad-y-errores.md) §9                                                                                                                                                                      | §9 C-04                                                                                                                                |
| Nombre del job de recuperación | `verify-hotel-booking`; `verify-creation` queda para vuelos                                                                                                                                                                      | §9 C-06                                                                                                                                |
| Registry                       | Espejo del de vuelos; el genérico queda como deuda registrada                                                                                                                                                                    | D-TBO-06 (A)                                                                                                                           |

---

## 8. Trazabilidad

**Fases.** Propuesta de este documento; [09](./09-plan-implementacion.md) fija el orden definitivo, el esfuerzo y
las dependencias.

| Fase   | Contenido                                                                                                                                                                                                                                             | Sale cuando                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **F0** | Preparación: D-TBO-02, 03, 06 y 07 cerradas el 2026-09-25 y el resto aplicado con la opción (A) (§7, Registro de decisiones); cuenta de test; `.gitignore` (RC-08); preguntas enviadas a TBO; tests de caracterización de la vertical actual (RNF-14) | Decisiones escritas y tests de caracterización en verde                  |
| **F1** | ACL `providers/tbo-hotels` con todas las operaciones (cliente, errores, builders, mappers, barreras PCI, fixtures) y arnés de certificación (`check`, `probe`, `run`, `zip`)                                                                          | Los 8 casos pasan contra test; con D-TBO-05 (A), se envía el zip         |
| **F2** | Catálogo: migración M1, herramienta de sync, mapeo de destinos y deduplicación; medición informativa de cobertura y precio (§2.3; con D-TBO-02 B no bloquea nada)                                                                                     | Destinos habilitados con hoteles TBO                                     |
| **F3** | Vertical multi-proveedor y búsqueda: contrato neutral, registry, factory TBO, panel de credenciales, nacionalidad, moneda, piso, suplementos y políticas; UI de búsqueda con el proveedor de cada tarifa según la divulgación (RF-40)                 | Búsqueda combinada Despegar + TBO en producción para tenants habilitados |
| **F4** | Reserva: migración M2, intent, PreBook, saga del Book, recuperación, cola con retardo, cobro y crédito; UI de PreBook, huéspedes y confirmación                                                                                                       | Reserva TBO de punta a punta en el entorno de certificación              |
| **F5** | Post-venta: lecturas, cancelación, estados, HCN y conciliación (migración M3); UI de reservas y cancelación                                                                                                                                           | Cancelación y conciliación verificadas                                   |
| **F6** | Certificación y salida: stack de certificación, verificación de portal, sign-off, credenciales live, migración M4 y kill-switch cableado                                                                                                              | Credenciales live cargadas por sustitución (RC-10)                       |

**Requisitos funcionales.**

| Req   | Documento y sección                                                                                                                  | Fase                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| RF-01 | [01](./01-autenticacion-conectividad-y-errores.md) §1.2, §2.2, §2.3                                                                  | F1 (esquema), F3 (panel)                |
| RF-02 | [01](./01-autenticacion-conectividad-y-errores.md) §3, §5, §10                                                                       | F1                                      |
| RF-03 | [01](./01-autenticacion-conectividad-y-errores.md) §8                                                                                | F1                                      |
| RF-04 | [01](./01-autenticacion-conectividad-y-errores.md) §9; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3              | F1 (errores), F3 (humanizador y filtro) |
| RF-05 | [02](./02-search-y-oferta-canonica.md) §2-§3, §7                                                                                     | F1                                      |
| RF-06 | [02](./02-search-y-oferta-canonica.md) §5                                                                                            | F3                                      |
| RF-07 | [02](./02-search-y-oferta-canonica.md) §8.3, §9, §10, §13                                                                            | F1 (mapper), F3 (contrato)              |
| RF-08 | [02](./02-search-y-oferta-canonica.md) §9.3; [03](./03-prebook-y-book.md) §3.1                                                       | F3                                      |
| RF-09 | [01](./01-autenticacion-conectividad-y-errores.md) §6                                                                                | F3                                      |
| RF-10 | [02](./02-search-y-oferta-canonica.md) §9.7; [03](./03-prebook-y-book.md) §2.6                                                       | F1 (mapper), F3-F4 (UI y servidor)      |
| RF-11 | [02](./02-search-y-oferta-canonica.md) §9.4, §9.6, §9.8, §9.9                                                                        | F1 (mapper), F3                         |
| RF-12 | [02](./02-search-y-oferta-canonica.md) §9.5                                                                                          | F3                                      |
| RF-13 | [02](./02-search-y-oferta-canonica.md) §8                                                                                            | F3                                      |
| RF-14 | [02](./02-search-y-oferta-canonica.md) §4; [06](./06-seams-integracion-repo.md) §5.6                                                 | F3                                      |
| RF-15 | [03](./03-prebook-y-book.md) §2                                                                                                      | F1 (builder y mapper), F4               |
| RF-16 | [03](./03-prebook-y-book.md) §2.4                                                                                                    | F1 (saneo), F4 (UI)                     |
| RF-17 | [03](./03-prebook-y-book.md) §2.11                                                                                                   | F1 (detección), F4 (bloqueo)            |
| RF-18 | [03](./03-prebook-y-book.md) §3.2, §3.5                                                                                              | F1 (builder), F4                        |
| RF-19 | [03](./03-prebook-y-book.md) §3.3, §8.4                                                                                              | F4                                      |
| RF-20 | [03](./03-prebook-y-book.md) §3.9, §8.3; [06](./06-seams-integracion-repo.md) §5.5                                                   | F4                                      |
| RF-21 | [03](./03-prebook-y-book.md) §4; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7                                      | F4                                      |
| RF-22 | [03](./03-prebook-y-book.md) §4.5                                                                                                    | F4                                      |
| RF-23 | [03](./03-prebook-y-book.md) §7.4                                                                                                    | F4                                      |
| RF-24 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3                                                                       | F1 (mapper), F5                         |
| RF-25 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4                                                                       | F5                                      |
| RF-26 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6, §11                                                                  | F5 (la tabla satélite nace en M2, F4)   |
| RF-27 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8                                                                       | F5                                      |
| RF-28 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5, §9                                                                   | F5                                      |
| RF-29 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §11                                                                      | F4 (columna en M2), F5                  |
| RF-30 | [05](./05-contenido-estatico-e-inventario.md) §5-§6                                                                                  | F2                                      |
| RF-31 | [05](./05-contenido-estatico-e-inventario.md) §7                                                                                     | F2                                      |
| RF-32 | [05](./05-contenido-estatico-e-inventario.md) §3-§4                                                                                  | F2                                      |
| RF-33 | [05](./05-contenido-estatico-e-inventario.md) §8                                                                                     | F2                                      |
| RF-34 | [05](./05-contenido-estatico-e-inventario.md) §9                                                                                     | F2                                      |
| RF-35 | [02](./02-search-y-oferta-canonica.md) §13; [06](./06-seams-integracion-repo.md) §5.3                                                | F3                                      |
| RF-36 | [06](./06-seams-integracion-repo.md) §5.2, §5.4, §5.6                                                                                | F3                                      |
| RF-37 | [06](./06-seams-integracion-repo.md) TP-22, TP-53; [01](./01-autenticacion-conectividad-y-errores.md) §1.2                           | F3                                      |
| RF-38 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §10; [06](./06-seams-integracion-repo.md) TP-38, TP-39                   | F4                                      |
| RF-39 | [07](./07-certificacion.md) §8; [06](./06-seams-integracion-repo.md) TP-57 a TP-62                                                   | F3-F5 (construcción), F6 (verificación) |
| RF-40 | [05](./05-contenido-estatico-e-inventario.md) §9.2; [06](./06-seams-integracion-repo.md) TP-56, TP-59, TP-66; firma de D-TBO-06 (§7) | F3                                      |

**Requisitos no funcionales y de certificación.**

| Req                    | Documento y sección                                                                                                                                                     | Fase                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| RNF-01, RNF-02         | [01](./01-autenticacion-conectividad-y-errores.md) §5, §7; [05](./05-contenido-estatico-e-inventario.md) §10                                                            | F1                                            |
| RNF-03, RNF-11         | [01](./01-autenticacion-conectividad-y-errores.md) §12                                                                                                                  | F3 (breaker), F6 (cableado del kill-switch)   |
| RNF-04                 | [03](./03-prebook-y-book.md) §7; [01](./01-autenticacion-conectividad-y-errores.md) §10.5                                                                               | F1                                            |
| RNF-05                 | [01](./01-autenticacion-conectividad-y-errores.md) §11                                                                                                                  | F1 (logs), F4 (bóveda)                        |
| RNF-06                 | [06](./06-seams-integracion-repo.md) §7.5                                                                                                                               | F3-F5                                         |
| RNF-07, RNF-08, RNF-13 | [01](./01-autenticacion-conectividad-y-errores.md) §11.1; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.5; [02](./02-search-y-oferta-canonica.md) §4.3 | F3-F5                                         |
| RNF-09                 | [02](./02-search-y-oferta-canonica.md) §4.3                                                                                                                             | F3                                            |
| RNF-10                 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.5, §10                                                                                                   | F4-F5                                         |
| RNF-12, RNF-14, RNF-16 | [06](./06-seams-integracion-repo.md) §4.3, §7; [05](./05-contenido-estatico-e-inventario.md) §4                                                                         | F0-F5                                         |
| RNF-15                 | [00](./00-fuentes.md) §1, §10                                                                                                                                           | F0                                            |
| RC-01 a RC-11          | [07](./07-certificacion.md)                                                                                                                                             | F0 (RC-08), F1 (RC-02 a RC-05), F6 (el resto) |

**Cobertura del contrato.** Cada elemento del contrato de TBO que obliga a algo tiene documento, requisito, fase de
este documento y PR de [09](./09-plan-implementacion.md) §4. Cifras de referencia en [00](./00-fuentes.md) §6.

_Los 11 métodos (§6-§16 del PDF)._

| Método                      | pp.   | Documento                                                                                                   | Requisito                        | Fase       | PR                     |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------- | ---------------------- |
| `Search`                    | 10-18 | [02](./02-search-y-oferta-canonica.md)                                                                      | RF-05, RF-07, RF-14              | F1, F3     | PR-1.4, PR-1.5, PR-2.6 |
| `PreBook`                   | 18-32 | [03](./03-prebook-y-book.md) §2                                                                             | RF-15, RF-16, RF-17              | F1, F4     | PR-4.1, PR-4.5         |
| `Book`                      | 32-41 | [03](./03-prebook-y-book.md) §3                                                                             | RF-18, RF-19, RF-20, RF-22       | F1, F4     | PR-4.2, PR-4.6         |
| `BookingDetail`             | 42-51 | [03](./03-prebook-y-book.md) §4; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3             | RF-21, RF-24                     | F1, F4, F5 | PR-4.2, PR-4.7, PR-5.2 |
| `Cancel`                    | 41-42 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4                                              | RF-25                            | F1, F5     | PR-5.1, PR-5.3         |
| `BookingDetailsbasedondate` | 62-64 | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5, §9                                          | RF-28                            | F1, F5     | PR-5.1, PR-5.5         |
| `CountryList`               | 51-53 | [05](./05-contenido-estatico-e-inventario.md) §2.2                                                          | RF-30 (E1)                       | F1, F2     | PR-3.1, PR-3.2         |
| `CityList`                  | 53-54 | [05](./05-contenido-estatico-e-inventario.md) §2.3                                                          | RF-30 (E2)                       | F1, F2     | PR-3.1, PR-3.2         |
| `hotelcodelist`             | 54-55 | [05](./05-contenido-estatico-e-inventario.md) §2.4; [01](./01-autenticacion-conectividad-y-errores.md) §8.1 | RF-30 (E5), RF-03 (sin `Status`) | F1, F2     | PR-1.2, PR-3.1, PR-3.2 |
| `TBOHotelCodeList`          | 65-69 | [05](./05-contenido-estatico-e-inventario.md) §2.5                                                          | RF-30 (E3), RF-31                | F1, F2     | PR-3.1, PR-3.2         |
| `HotelDetails`              | 56-62 | [05](./05-contenido-estatico-e-inventario.md) §2.6                                                          | RF-30 (E4), RF-32                | F1, F2     | PR-3.1, PR-3.3, PR-3.6 |

_Los 12 códigos `Status.Code` (pp. 8-10)._ La política por código está en [01](./01-autenticacion-conectividad-y-errores.md) §8.3; RF-03 los clasifica todos en PR-1.2 (F1).

| Código                       | Qué implica además de la clasificación                             | Requisito            | Fase   | PR                     |
| ---------------------------- | ------------------------------------------------------------------ | -------------------- | ------ | ---------------------- |
| `200` `SUCCESS`              | Zod del mapper; un Book `200` sin `ConfirmationNumber` es incierto | RF-03, RF-20         | F1, F4 | PR-1.2, PR-4.2         |
| `201` `NO_AVAILABILITY`      | Lista vacía en Search; fallo definitivo en Book                    | RF-14, RF-20         | F3, F4 | PR-1.4, PR-2.6, PR-4.6 |
| `207` `RATE_UNAVAILABLE`     | Invalida la oferta; fallo definitivo en Book                       | RF-15, RF-20         | F4     | PR-4.5, PR-4.6         |
| `405` `BOOKING_FAIL`         | Book incierto: recuperación a +120 s                               | RF-21                | F4     | PR-4.6, PR-4.7         |
| `479` `CANCEL_FAIL`          | `{ success: false }` y lectura posterior                           | RF-25                | F5     | PR-5.1, PR-5.3         |
| `401` `UNAUTHORIZED`         | Circuito de la cuenta y aviso al titular                           | RF-04, RNF-03        | F1, F3 | PR-1.2, PR-0.6, PR-2.1 |
| `400` `INVALID_REQUEST`      | `CLIENT_BUG` con alerta al operador                                | RF-03                | F1     | PR-1.2                 |
| `500` `UNEXPECTED_ERROR`     | Incierto en Book y Cancel; RQ/RS a soporte desde la bóveda         | RF-21, RF-25, RNF-05 | F1, F4 | PR-1.2, PR-4.9         |
| `429` `LIMIT_EXCEEDED`       | Limitador por cuenta; nunca reintento en dinero                    | RNF-02               | F1     | PR-1.2                 |
| `315` `BOOKINGCODE_EXPIRED`  | Invalida el contexto; vencimiento local previo                     | RF-09                | F3, F4 | PR-1.4, PR-4.1, PR-4.5 |
| `300` `INSUFFICIENT_BALANCE` | Aviso al titular, sin mostrar saldo a la sub-agencia               | RF-23                | F4     | PR-4.8                 |
| `402` `AGENT_BLOCKED`        | Circuito de la cuenta; sin tocar `provider_accounts.status`        | RNF-03 (D-TBO-32)    | F3     | PR-0.6, PR-2.1         |

_Las 7 enumeraciones (pp. 69-71)._

| Enumeración                                          | Uso nuestro                                                                                     | Requisito    | Fase   | PR                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------ | ------ | ------------------------------ |
| `PaxType` (`Adult`, `Child`)                         | `CustomerNames[].Type` según la ocupación de `PaxRooms`                                         | RF-18        | F1, F4 | PR-4.2                         |
| `MealPlan` (`All`, `WithMeal`, `RoomOnly`)           | `Filters.MealType` como string                                                                  | RF-05        | F1     | PR-1.4                         |
| `StarRating` (6)                                     | No se envía en Search (N5); normaliza `HotelRating` y `BookingDetail.HotelDetails.Rating` a 1-5 | RF-32, RF-24 | F2, F5 | PR-3.1, PR-4.2                 |
| `PaymentMode` (`Limit`, `SavedCard`, `NewCard`)      | Solo `Limit` (D1); N1 y N2                                                                      | RNF-04       | F1     | PR-1.2, PR-1.3, PR-4.1, PR-4.2 |
| `Booking Type` (`Voucher`)                           | Constante en el Book; N7                                                                        | RF-20        | F4     | PR-4.2                         |
| `MealType` (10)                                      | `BoardType` con etiqueta y literal                                                              | RF-11        | F1, F3 | PR-1.4                         |
| `Booking Status` (6, más `Vouchered` fuera del enum) | Función pura de normalización y máquina de estados                                              | RF-24, RF-26 | F5     | PR-4.2, PR-5.2                 |

_Los 4 Key Points (p. 71), el protocolo de 120 s, el SLA del HCN y los 8 casos de certificación._

| Elemento                                                              | Fuente                            | Requisito                               | Fase       | PR                                       |
| --------------------------------------------------------------------- | --------------------------------- | --------------------------------------- | ---------- | ---------------------------------------- |
| KP-1: no fijar `GuestNationality`                                     | p. 71                             | RF-06 (CK-01)                           | F3         | PR-2.4, PR-6.1                           |
| KP-2: `IsDetailedResponse` en `False`                                 | p. 71                             | RF-05 (CK-02), D-TBO-19                 | F1         | PR-1.4, PR-1.5                           |
| KP-3: políticas y normas de PreBook finales                           | p. 71                             | RF-11, RF-15, RF-16 (CK-07)             | F1, F4     | PR-4.1, PR-4.5, PR-6.3                   |
| KP-4: `AtProperty` visible antes o en el paso de reserva              | p. 71                             | RF-10 (CK-08)                           | F1, F3, F4 | PR-1.4, PR-4.6, PR-6.1, PR-6.3, PR-6.4   |
| Ventana de 30 minutos de Search a Book                                | p. 8                              | RF-09 (CK-05)                           | F3         | PR-1.4, PR-4.1, PR-4.5, PR-6.1           |
| Recuperación con `BookingDetail` por `BookingReferenceId` a los 120 s | p. 42                             | RF-19, RF-21, RF-38, RNF-10 (CK-14)     | F4         | PR-0.7, PR-4.2, PR-4.7; cierre en PR-5.5 |
| SLA del HCN (P0-P5, 3 reintentos, ticket)                             | pp. 42-43                         | RF-27                                   | F5         | PR-5.4                                   |
| Casos 1 a 6 (ocupaciones)                                             | Cert, Integration on Test Account | RF-05 (CA-3), RF-18, RC-02              | F1, F6     | PR-1.4, PR-7.1                           |
| Caso 7 (suplementos)                                                  | Cert, Integration on Test Account | RF-10, RC-03 (guarda G-11)              | F1, F6     | PR-7.1                                   |
| Caso 8 (`BookingDetail` tras reservar)                                | Cert, Integration on Test Account | RF-20 (lectura de cierre), RF-24, RC-02 | F1, F6     | PR-4.2, PR-7.1                           |

---

## 9. Reconciliación entre documentos del set

Los documentos 01-07 se escribieron en paralelo y en algunos puntos adoptaron reglas distintas. Esta tabla fija la
regla que manda y el documento que había que corregir.

**Estado al 2026-09-23:** las correcciones de la columna "Corregir en" están **aplicadas** en los documentos de origen,
que ya enuncian la regla adoptada y remiten a esta tabla. C-25 a C-28 se detectaron en la revisión final del set y
también están aplicadas. C-29 se detectó el 2026-09-25, al registrar la firma de D-TBO-06, y está aplicada. Donde la
regla depende de una decisión todavía abierta (C-07, C-18, C-20), el texto corregido describe la opción recomendada y
dice qué cambia con la otra.

| #        | Contradicción                                                                                                                                                                                                                                                                                                                                                                                                                                | Regla adoptada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Corregir en                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **C-01** | `ResponseTime` por defecto: 10 s con timeout de 13 s y techo de 23 s ([01](./01-autenticacion-conectividad-y-errores.md) §5.3); 20 s con techo de 26 s ([02](./02-search-y-oferta-canonica.md) §6.1); 23 en el ejemplo del caso 1 ([07](./07-certificacion.md) §4.3)                                                                                                                                                                         | Rango 5-20 s; timeout = `ResponseTime` + 3 s, nunca más de 23 s (dentro de "5-23 Seconds", p. 8). El valor por defecto lo fija D-TBO-17 (recomendado: 10 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 02 §6.1; el ejemplo de 07 §4.3 debe mostrar el valor del builder                            |
| **C-02** | Concurrencia: 5 QPS y 4 concurrentes por cuenta ([01](./01-autenticacion-conectividad-y-errores.md) §7.2) frente a "concurrencia 1 por credencial" ([02](./02-search-y-oferta-canonica.md) C-08)                                                                                                                                                                                                                                             | Son dos perillas: el limitador por cuenta (RNF-02) y los lotes en paralelo dentro de una búsqueda (`searchConcurrency`, 1 por defecto; con D-TBO-17 A hay un solo lote)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 02 C-08                                                                                     |
| **C-03** | Casing de paths: el del PDF en todas las operaciones ([01](./01-autenticacion-conectividad-y-errores.md) §3.1; Anexo A de [07](./07-certificacion.md)) frente al de Postman para `BookingDetailsBasedOnDate` ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §2, §5.2) y `Hoteldetails` ([05](./05-contenido-estatico-e-inventario.md) CE-04, §6.3 E4)                                                                          | Una sola constante `TBO_OPERATIONS` con el casing del PDF; la sonda PR-04 prueba las dos grafías de cada path en certificación y la que funcione queda en la constante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 04 §2 y §5.2; 05 CE-04 y §6.3; 07 §6.8 (PR-04 hoy prueba solo `/search` frente a `/Search`) |
| **C-04** | Modelo de errores: una clase `TboApiError` con `kind` ([01](./01-autenticacion-conectividad-y-errores.md) §9; [03](./03-prebook-y-book.md) §6) frente a `TboApiError` + `TboStatusError` + `TboResponseValidationError` + `TboPaymentModeNotSupportedError` ([06](./06-seams-integracion-repo.md) §4.2, §4.3) y `TboCancelRejectedError` para `401`/`402`/`400` en Cancel ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3) | El de 01 (RF-04), enmendado abajo. Un `PaymentMode` no permitido es `TboRequestBuildError`; un esquema de respuesta que falla es `TboResponseMappingError`, y en `/Cancel`, `TboCancelMappingError`. En `/Cancel` solo `200` y `479` son desenlaces conocidos: lo demás que pasó por el cable (`401`, `402`, `400`, `201`, `405`…, `500`, `429`, timeout, red) es `TboCancelOutcomeUnknownError` → `UNVERIFIED`; lo que el limitador no despachó es `TboDispatchRejectedError` (`sentToProvider: false`), previo al write y reintentable. Un nombre terminado en `ValidationError` sería determinista en `/Cancel` y cerraría como fallida una cancelación que pudo aplicarse | 04 §4.3; 06 §4.2, §4.3 reglas 2, 3 y 9, §5.2 (`@Catch`); 01 §9.3                            |
| **C-05** | `479` en Cancel: `TboApiError` `NO_RETRY` → `FAILED` y lectura aparte ([01](./01-autenticacion-conectividad-y-errores.md) §9.3); `{ success: false }` sin lanzar y lectura posterior ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3); `UNVERIFIED` y relectura ([06](./06-seams-integracion-repo.md) §5.5 punto 5)                                                                                                        | El de 04 (RF-25): sin lanzar; la lectura posterior decide; si la lectura falla, `verify-cancellation` de solo lectura, nunca un segundo Cancel. Las otras dos reglas de 06 §5.5 punto 5 (`status` solo HTTP; nombre del error de mapeo) siguen vigentes                                                                                                                                                                                                                                                                                                                                                                                                                       | 01 §9.3 (fila `479`); 06 §5.5 punto 5                                                       |
| **C-06** | Job de recuperación: `verify-hotel-booking` con calendario 120 s, 5, 15 y 60 min ([03](./03-prebook-y-book.md) §4.2, §4.6; [06](./06-seams-integracion-repo.md) TP-38) frente a extender `verify-creation` con 120 s, 10 y 60 min ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7.3, §10)                                                                                                                                    | `verify-hotel-booking` con el calendario de 03 (RF-21). `verify-creation` sigue siendo de vuelos: exige `provider_order_id` y resuelve por el registry de vuelos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 04 §3.2, §6.3, §7.2, §7.3, §10, §12                                                         |
| **C-07** | Qué pasa si la verificación no encuentra la reserva: `failed` y el vendedor puede volver a reservar ([03](./03-prebook-y-book.md) §4.2 punto 7, D-03-F); `pending` hasta la conciliación ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7.3, PV-C); "marked failed and sent to manual review" (Anexo A de [07](./07-certificacion.md), paso 7)                                                                                | Lo decide D-TBO-24 (recomendada: bloqueada hasta evidencia fuerte, como PV-C)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 03 §4.2 y §12; Anexo A de 07                                                                |
| **C-08** | Origen del `BookingReferenceId`: generador propio, independiente del `Idempotency-Key` ([03](./03-prebook-y-book.md) §3.3) frente a "`create_request_key` … viaja a TBO como `BookingReferenceId`" ([06](./06-seams-integracion-repo.md) §5.5 punto 2)                                                                                                                                                                                       | El de 03 (RF-19). `create_request_key` sigue siendo la clave de idempotencia por tenant que viene del cliente (`apps/api/src/orders/orders.service.ts:166-178`, VERIFICADO-CODIGO) y no es única entre tenants                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 06 §5.5 punto 2                                                                             |
| **C-09** | Dónde vive el `BookingReferenceId`: columna `orders.provider_booking_ref` con índice único entre tenants ([03](./03-prebook-y-book.md) §8.4) frente a columna de la tabla satélite de hotel, sin columnas de hotel en `orders` salvo `provider_account_id` ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §11)                                                                                                                 | `orders.provider_booking_ref`, que es genérica como `provider_account_id`; la tabla satélite guarda solo el seguimiento propio de hotel (estado del proveedor, HCN, factura)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 04 §11                                                                                      |
| **C-10** | Numeración de migraciones: 03 §8.4, 05 §7.3 y 06 TP-43 reclaman la `0041` (la última existente es `0040_portfolio_ledger_idempotency.sql`, VERIFICADO-CODIGO)                                                                                                                                                                                                                                                                                | Este documento las nombra sin número y [09](./09-plan-implementacion.md) §3.3 les asigna número tentativo: **M1** catálogo multi-proveedor (RF-31); **M2** órdenes (`provider_booking_ref`, `provider_account_id`, tabla satélite de seguimiento); **M3** conciliación (tablas de corridas e ítems); **M4** fila `tbo-hotels` en `provider_catalog`; **M5** bóveda cifrada de payloads (D-TBO-31, RNF-05; la sumó [09](./09-plan-implementacion.md) §20 P-05)                                                                                                                                                                                                                 | 03, 04, 05 y 06 citan M1-M4                                                                 |
| **C-11** | Clave del contexto de búsqueda: `searchId` en `provider.raw` y sin `searchedAt` ([02](./02-search-y-oferta-canonica.md) §9.3); body de PreBook `{ providerCode, offerRef }` y `searchedAt` ([03](./03-prebook-y-book.md) §5.1, §2.10); `searchSentAt` ([01](./01-autenticacion-conectividad-y-errores.md) §6.3); `provider.raw` con `HotelCode` ([06](./06-seams-integracion-repo.md) §5.3)                                                  | RF-08: clave `(tenantId, searchId)`; el pack viaja con `{ name, offerRef: BookingCode, raw: { searchId } }`; el campo se llama `searchSentAt`; el `HotelCode` se lee del contexto, no del navegador                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 02 §9.3; 03 §2.10 y §5.1; 06 §5.3                                                           |
| **C-12** | "Los campos desconocidos se toleran … pero sus nombres se registran" ([02](./02-search-y-oferta-canonica.md) §10) con esquemas `z.object`, que descartan claves sin exponerlas                                                                                                                                                                                                                                                               | `.passthrough()` en el envelope o comparación de claves antes de parsear; solo nombres, nunca valores (RNF-12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 02 §10                                                                                      |
| **C-13** | Import de Zod en el ACL: `@sales-travel/validation` ([05](./05-contenido-estatico-e-inventario.md) §3) frente a `zod` directo ([02](./02-search-y-oferta-canonica.md) §10; [06](./06-seams-integracion-repo.md) §4.1)                                                                                                                                                                                                                        | `zod` directo dentro del paquete; `@sales-travel/validation` en `apps/api` (§7.8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 05 §3                                                                                       |
| **C-14** | Timeout de `HotelDetails`: 60 s ([01](./01-autenticacion-conectividad-y-errores.md) §5.2) frente a 45 s ([05](./05-contenido-estatico-e-inventario.md) §10)                                                                                                                                                                                                                                                                                  | 60 s de techo en `TBO_OPERATIONS`; el sync configura 45 s, porque la configuración solo puede acortar (RNF-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | — (compatibles con esta regla)                                                              |
| **C-15** | `GET /health`: "NADA" ([06](./06-seams-integracion-repo.md) TP-28) frente a "publicaría ids de tenant" ([01](./01-autenticacion-conectividad-y-errores.md) §12.3)                                                                                                                                                                                                                                                                            | El snapshot público agrega o excluye los circuitos de cuenta (RNF-03)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 06 TP-28 pasa a OBLIGATORIO                                                                 |
| **C-16** | Clave del circuito de cuenta `tbo-hotels@{ownerTenantId}` ([01](./01-autenticacion-conectividad-y-errores.md) §12.3) frente a la del limitador, `ownerTenantId` + digest de `username` (§7.2)                                                                                                                                                                                                                                                | Las dos usan `accountRef` ([01](./01-autenticacion-conectividad-y-errores.md) §11.1): no expone ids de tenant y, al rotar la credencial, se abre un circuito nuevo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 01 §12.3                                                                                    |
| **C-17** | Vencimiento: `searchSentAt + 27 min`, sin PreBook ni Book después ([01](./01-autenticacion-conectividad-y-errores.md) §6.3) frente a `searchedAt + 30 min` y ningún Book con menos de 3 min ([03](./03-prebook-y-book.md) §2.10)                                                                                                                                                                                                             | El de 01 (RF-09): un solo vencimiento visible para el vendedor, que ya incluye el margen del Book                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 03 §2.10                                                                                    |
| **C-18** | Alcance del piso: "Piso de venta B2C" ([03](./03-prebook-y-book.md) §2.2) y "NADA (B2B) / OBLIGATORIO antes de B2C" ([06](./06-seams-integracion-repo.md) TP-29) frente a "todo canal" ([02](./02-search-y-oferta-canonica.md) D02-4 A)                                                                                                                                                                                                      | Lo decide D-TBO-16; con la recomendada, TP-29 es obligatorio desde el día 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 03 §2.2; 06 TP-29                                                                           |
| **C-19** | Evento del Book con fallo definitivo: `OrderCreateFailed` con `uncertain: false` ([03](./03-prebook-y-book.md) §6) frente a `OrderCreated` con desenlace `FAILED` ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.3)                                                                                                                                                                                                         | El vocabulario de vuelos: `OrderCreated` significa "El proveedor contestó" y `OrderCreateFailed`, "El proveedor LANZÓ: puede haber reserva del otro lado" (`apps/api/src/orders/order-events.ts:18-21`, VERIFICADO-CODIGO). Un rechazo definitivo es `OrderCreated` con `FAILED`                                                                                                                                                                                                                                                                                                                                                                                              | 03 §6                                                                                       |
| **C-20** | "402: agency blocked; the account is disabled" (Anexo A de [07](./07-certificacion.md)) frente a no cambiar el estado de la cuenta ([01](./01-autenticacion-conectividad-y-errores.md) §14 punto 6; [03](./03-prebook-y-book.md) §6)                                                                                                                                                                                                         | Lo decide D-TBO-32; con la recomendada, el Anexo A dice que se suspenden las llamadas de esa cuenta y se avisa a su titular                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Anexo A de 07                                                                               |
| **C-21** | `PaymentMode: 'Limit'` literal solo en PreBook y Book ([06](./06-seams-integracion-repo.md) §4.3 regla 2) frente a también en BookingDetail ([01](./01-autenticacion-conectividad-y-errores.md) §10.5; [03](./03-prebook-y-book.md) §3.6; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.1)                                                                                                                                  | Literal `'Limit'` en los tres builders: BookingDetail también lo recibe (p. 44)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 06 §4.3                                                                                     |
| **C-22** | La fila H-19 de [01](./01-autenticacion-conectividad-y-errores.md) remite a §1.2 para la IP fija del VPS, pero §1.2 no habla de IPs                                                                                                                                                                                                                                                                                                          | La postura queda en RC-11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 01 §13 H-19                                                                                 |
| **C-23** | Job de catálogo como tarea dentro de la API: descartado ([05](./05-contenido-estatico-e-inventario.md) §6.2 C)                                                                                                                                                                                                                                                                                                                               | Se mantiene descartado; los jobs periódicos de post-venta sí corren en la API (D-TBO-29), porque leen datos de tenant con RLS y no escriben tablas globales                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                           |
| **C-24** | Reintento de PreBook: cero en el cliente ([01](./01-autenticacion-conectividad-y-errores.md) §5.2, §10.4) frente a uno dentro del presupuesto de 23 s, también tras un timeout ([03](./03-prebook-y-book.md) §2.12); el arnés reintenta Search y PreBook tras un timeout ([07](./07-certificacion.md) §6.5)                                                                                                                                  | Hasta un reintento solo si el primer fallo fue rápido (`429`, `500`, conexión rechazada) y el total no pasa de 23 s; nunca después de un timeout (RNF-01)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 01 §5.2, §10.2 y §10.4; 03 §2.12 (fila de timeout); 07 §6.5                                 |
| **C-25** | `IsDetailedResponse`: `true` en el Search de un solo hotel al abrir su detalle ([02](./02-search-y-oferta-canonica.md) §6.2, D-TBO-19 A) frente a CK-02 "`false` en todo Search" y la guarda G-5 del arnés ([07](./07-certificacion.md) §3, §6.7); el Anexo A de 07 no declaraba el Search de detalle                                                                                                                                        | D-TBO-19 (A): `false` en todo listado, que son todos los Search del zip; `true` solo en el Search de un hotel. El workflow lo declara a TBO → [Q-19](./10-preguntas-para-tbo.md#q-19). Con D-TBO-19 (B) desaparece el Search de detalle                                                                                                                                                                                                                                                                                                                                                                                                                                       | 07 CK-02, G-5 y Anexo A §2                                                                  |
| **C-26** | `ClientReferenceId` del arnés: `STCERT` + corrida + caso ([07](./07-certificacion.md) §4.1, §4.8) frente al mismo valor que `BookingReferenceId` (RF-19; [03](./03-prebook-y-book.md) §3.3). Un RQ armado por el arnés contradice RC-02                                                                                                                                                                                                      | El de RF-19: el ACL genera los dos con la regla de producción; la corrida y el caso se trazan en `README.txt` y `run.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 07 §4.1 y §4.8                                                                              |
| **C-27** | Book con código de precondición (`400`, `401`, `402`, `300`, `315`, `207`, `201`): `FAILED` provisional y `BookingDetail` después de todo Book no exitoso ([01](./01-autenticacion-conectividad-y-errores.md) §8.5) frente a `FAILED` definitivo, clave liberada y sin `BookingDetail` obligatorio ([03](./03-prebook-y-book.md) §3.9; RF-20 CA-2)                                                                                           | El de 03 y RF-20: definitivo; la conciliación diaria (RF-28) cubre el caso improbable de una reserva creada igual. `405` y los desenlaces sin respuesta cierta siguen inciertos (RF-21) → [Q-36](./10-preguntas-para-tbo.md#q-36)                                                                                                                                                                                                                                                                                                                                                                                                                                             | 01 §8.5                                                                                     |
| **C-28** | Nombres de los builders de salida: `search/request.builder.ts`, `prebook/request.builder.ts`, `detail/request.builder.ts` ([06](./06-seams-integracion-repo.md) §4.2) frente a `booking/booking-detail.request.builder.ts` ([03](./03-prebook-y-book.md) §7.2) y a los de [09](./09-plan-implementacion.md) PR-1.4, PR-4.1, PR-4.2 y PR-5.1                                                                                                  | Los de 09: `search/search.request.builder.ts`, `prebook/prebook.request.builder.ts`, `booking/book.request.builder.ts`, `detail/booking-detail.request.builder.ts`, `cancel/cancel.request.builder.ts`; todos caen bajo el glob de la regla D1 (`eslint.config.mjs:51`)                                                                                                                                                                                                                                                                                                                                                                                                       | 03 §7.2; 06 §4.2                                                                            |
| **C-29** | Quién ve el proveedor de una tarifa de hotel: "proveedor visible para el rol del vendedor" ([05](./05-contenido-estatico-e-inventario.md) §14 punto 6) frente a "según el flag de divulgación, extendido a hoteles" (D-TBO-13 A)                                                                                                                                                                                                             | La política de divulgación que ya existe para vuelos, sin variantes (RF-40): por defecto oculto, ocultar gana en la cadena y el consolidador lo activa en el panel de proveedores. Lo fijó el founder al firmar D-TBO-06 (A) el 2026-09-25 ("me tiene que mostrar de dónde es")                                                                                                                                                                                                                                                                                                                                                                                               | 05 §9.2 y §14 punto 6                                                                       |

**Enmiendas a C-04 en `/Cancel`.** La fila de C-04 ya las incorpora (VERIFICADO-CODIGO en la rama `feat/tbo-hotels` al
2026-09-27):

- **HARD-1 (2026-09-26, `45d574f`).** `401`, `402` y `400` en Cancel ya no son deterministas. El contrato de Cancel
  sólo define `200` y `479`, así que ningún otro desenlace de `/Cancel` (incluidos `401`, `402`, `400` y códigos de
  otras operaciones como `201`, `207`, `300`, `315` o `405`) prueba que TBO no haya cancelado: el ACL lo lanza como
  `TboCancelOutcomeUnknownError` (un `TboApiError` con el mismo `kind`, que el breaker sigue leyendo) y la política lo
  deja `UNVERIFIED` con `verify-cancellation`, nunca `FAILED` sin una lectura. Un `Status.Code` desconocido sale como
  `TboCancelMappingError`, también `UNVERIFIED`.
- **Arreglo del limitador (`34ef9f4`).** Cuando el limitador de la cuenta no despacha la lectura previa o el
  `/Cancel`, el ACL lanza `TboDispatchRejectedError` con `sentToProvider: false`, la misma marca que el rechazo del
  breaker. Antes, su sufijo `RejectedError` lo volvía determinista: la cancelación cerraba `FAILED` sin reintento y la
  reserva quedaba viva en TBO sin camino de la API para cancelarla. Ahora es `pre-write-transient`: `FAILED`
  reintentable y encolado, sin conciliar ni escalar. En la misma entrega, la lectura previa sale por el cupo de
  ventas cuando la pide una persona.

La tabla por desenlace está en [01](./01-autenticacion-conectividad-y-errores.md) §9.3, la regla de implementación en
[06](./06-seams-integracion-repo.md) §4.3 regla 9 y el detalle de post-venta en
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3 y §14.

---

## 10. Huecos del contrato que condicionan este documento

Cada documento del set tiene su propia tabla de huecos. Aquí van solo los que condicionan requisitos o decisiones,
con la postura defensiva adoptada. Todos son VERIFICADO-PDF, VERIFICADO-POSTMAN o VERIFICADO-CERT en cuanto a la
ausencia o la contradicción; la postura es nuestra.

| #    | Hueco o contradicción                                                                                                                                                            | Fuente                                     | Postura                                                                                                                                                                                                                                    | Detalle                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| G-01 | "Secured with HTTPS" frente a un Test BaseURL `http://`; host live no publicado y con otro path                                                                                  | p. 7; Cert, TBO Hotel API Details; Postman | RF-01, D-TBO-30. → [Q-03](./10-preguntas-para-tbo.md#q-03), [Q-04](./10-preguntas-para-tbo.md#q-04)                                                                                                                                        | [01](./01-autenticacion-conectividad-y-errores.md) §2          |
| G-02 | Casing de paths distinto entre PDF y Postman                                                                                                                                     | p. 7, 10, 56, 62; Postman                  | Constante única y sonda PR-04 (§9 C-03). → [Q-05](./10-preguntas-para-tbo.md#q-05)                                                                                                                                                         | [01](./01-autenticacion-conectividad-y-errores.md) §3          |
| G-03 | No se dice si el HTTP de transporte refleja `Status.Code` ni qué códigos devuelve cada método; no hay ejemplos de error                                                          | p. 8-10, 18                                | RF-03: decide el cuerpo; cualquier código en cualquier operación. → [Q-07](./10-preguntas-para-tbo.md#q-07), [Q-08](./10-preguntas-para-tbo.md#q-08)                                                                                       | [01](./01-autenticacion-conectividad-y-errores.md) §8          |
| G-04 | Valor del QPS no publicado; sin costo por búsqueda documentado                                                                                                                   | p. 9                                       | RNF-02, D-TBO-17, D-TBO-18. → [Q-10](./10-preguntas-para-tbo.md#q-10), [Q-87](./10-preguntas-para-tbo.md#q-87)                                                                                                                             | [01](./01-autenticacion-conectividad-y-errores.md) §7          |
| G-05 | Sin timeout para ocho de los once métodos                                                                                                                                        | p. 8                                       | RNF-01. → [Q-09](./10-preguntas-para-tbo.md#q-09)                                                                                                                                                                                          | [01](./01-autenticacion-conectividad-y-errores.md) §5          |
| G-06 | Ventana de 30 minutos: inicio, renovación por PreBook y si el Book debe empezar o terminar dentro                                                                                | p. 8-9                                     | RF-09. → [Q-29](./10-preguntas-para-tbo.md#q-29)                                                                                                                                                                                           | [01](./01-autenticacion-conectividad-y-errores.md) §6          |
| G-07 | Idempotencia del Book por `BookingReferenceId`; respuesta de `BookingDetail` para una reserva inexistente; desde cuándo corren los 120 s; si `405` garantiza que no hubo reserva | p. 9, 33, 42-44                            | RF-19, RF-21, D-TBO-24; sondas PR-05 y PR-11. → [Q-35](./10-preguntas-para-tbo.md#q-35), [Q-37](./10-preguntas-para-tbo.md#q-37), [Q-38](./10-preguntas-para-tbo.md#q-38), [Q-36](./10-preguntas-para-tbo.md#q-36)                         | [03](./03-prebook-y-book.md) §4, §9                            |
| G-08 | Cancel `200` frente a estados de cancelación en curso; semántica de `479`; idempotencia; sin cargo ni reembolso                                                                  | p. 9, 41-42, 70-71                         | RF-25, D-TBO-25, D-TBO-26. → [Q-49](./10-preguntas-para-tbo.md#q-49), [Q-50](./10-preguntas-para-tbo.md#q-50), [Q-52](./10-preguntas-para-tbo.md#q-52)                                                                                     | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4 |
| G-09 | Enum `Booking Status` incompleto (`Vouchered` fuera del enum)                                                                                                                    | p. 64, 70-71                               | Enum abierto, desconocido escala (RF-24). → [Q-48](./10-preguntas-para-tbo.md#q-48)                                                                                                                                                        | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6 |
| G-10 | `Children` "(1-4)" y `ChildrenAges` con cero niños (`[0]` en Postman)                                                                                                            | p. 11; Postman: Search                     | `[]` configurable y sonda PR-01 (RF-05). → [Q-13](./10-preguntas-para-tbo.md#q-13)                                                                                                                                                         | [02](./02-search-y-oferta-canonica.md) §3                      |
| G-11 | `Title` (`Dr` en Postman), "Lead guest" frente a todos nombrados, juego de caracteres de los nombres                                                                             | p. 32-34, 39; Postman: HotelBook           | RF-18, D-TBO-23; sonda PR-09. → [Q-41](./10-preguntas-para-tbo.md#q-41), [Q-42](./10-preguntas-para-tbo.md#q-42), [Q-43](./10-preguntas-para-tbo.md#q-43)                                                                                  | [03](./03-prebook-y-book.md) §3.2                              |
| G-12 | Moneda fija por perfil; monedas admitidas                                                                                                                                        | p. 13                                      | RF-13, D-TBO-15. → [Q-88](./10-preguntas-para-tbo.md#q-88)                                                                                                                                                                                 | [02](./02-search-y-oferta-canonica.md) §8                      |
| G-13 | `RecommendedSellingRate` para el "B2C client": ¿alcanza a B2B2C y a paquetes?                                                                                                    | p. 13, 21                                  | RF-12, D-TBO-16. → [Q-23](./10-preguntas-para-tbo.md#q-23)                                                                                                                                                                                 | [02](./02-search-y-oferta-canonica.md) §9.5                    |
| G-14 | Unidad de `Supplements[].Price`; tabla "List of Object" frente a array de arrays                                                                                                 | p. 14-17, 31                               | RF-10: se muestra tal cual y se aceptan las dos formas. → [Q-27](./10-preguntas-para-tbo.md#q-27)                                                                                                                                          | [02](./02-search-y-oferta-canonica.md) §9.7                    |
| G-15 | `CancelPolicies`: zona horaria de `FromDate`, base de `Percentage`, moneda de `Fixed`, relación con `IsRefundable`                                                               | p. 14, 24, 50-51                           | RF-11. → [Q-24](./10-preguntas-para-tbo.md#q-24), [Q-26](./10-preguntas-para-tbo.md#q-26)                                                                                                                                                  | [02](./02-search-y-oferta-canonica.md) §9.6                    |
| G-16 | Tarifas "solo con billete aéreo" sin campo estructurado                                                                                                                          | p. 25, 30                                  | RF-17, D-TBO-22. → [Q-31](./10-preguntas-para-tbo.md#q-31)                                                                                                                                                                                 | [03](./03-prebook-y-book.md) §2.11                             |
| G-17 | Catálogo global o por cuenta                                                                                                                                                     | p. 13, 51-69                               | D-TBO-11 y sonda comparativa. → [Q-60](./10-preguntas-para-tbo.md#q-60)                                                                                                                                                                    | [05](./05-contenido-estatico-e-inventario.md) §11              |
| G-18 | Clave del contenedor de habitaciones con `IsRoomDetailRequired`; `RoomID` fuera de la tabla de Search                                                                            | p. 13-18, 56-59                            | Función apagada hasta tener fixture (N10). → [Q-65](./10-preguntas-para-tbo.md#q-65)                                                                                                                                                       | [05](./05-contenido-estatico-e-inventario.md) §2.6.3           |
| G-19 | El Key Point 2 no dice a qué método aplica; qué trae `TBOHotelCodeList` con `false`                                                                                              | p. 11, 65, 71                              | Search de listado siempre `false` y `true` solo en el Search de un hotel (D-TBO-19 A, §9 C-25); `TBOHotelCodeList` con `"true"` hasta probar `"false"`. → [Q-63](./10-preguntas-para-tbo.md#q-63), [Q-19](./10-preguntas-para-tbo.md#q-19) | [05](./05-contenido-estatico-e-inventario.md) §6.3             |
| G-20 | `BookingDetailsbasedondate`: qué fecha filtra, zona horaria, grafía de campos, más de 60 días, paginación                                                                        | p. 6, 62-64                                | RF-28: `FromDate`/`ToDate`, ventanas ≤ 60 días y validación de `BookingDate`. → [Q-56](./10-preguntas-para-tbo.md#q-56), [Q-57](./10-preguntas-para-tbo.md#q-57)                                                                           | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5 |
| G-21 | SLA del HCN: límites de tramo, número de reintentos, canal del ticket                                                                                                            | p. 42-43                                   | RF-27: intervalos `[a, b)`, cuatro lecturas, cola interna. → [Q-54](./10-preguntas-para-tbo.md#q-54), [Q-55](./10-preguntas-para-tbo.md#q-55)                                                                                              | [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8 |
| G-22 | Email de soporte: `apisupport@tboholidays.com` frente a `apisupport@tbo.com`                                                                                                     | p. 9; Cert, Integration on Test Account    | Certificación a `apisupport@tbo.com`; incidentes `500` a las dos ([00](./00-fuentes.md) §7). → [Q-11](./10-preguntas-para-tbo.md#q-11)                                                                                                     | [00](./00-fuentes.md) §7                                       |
| G-23 | "Hotel Search Workflow" deprecado sin descripción                                                                                                                                | p. 6                                       | N4. → [Q-02](./10-preguntas-para-tbo.md#q-02)                                                                                                                                                                                              | [00](./00-fuentes.md) §2.3                                     |
| G-24 | Alcance de la certificación (aplicación o cuenta)                                                                                                                                | Cert, Sign Off / API Live Credentials      | D-TBO-03 (A): BYOC de agencias apagado hasta la respuesta. → [Q-77](./10-preguntas-para-tbo.md#q-77)                                                                                                                                       | [07](./07-certificacion.md) §2.8                               |

---

## 11. Preguntas a TBO que bloquean decisiones

[10](./10-preguntas-para-tbo.md) consolida y numera todas las preguntas del set. Estas son las que cambian una
decisión de §7 según la respuesta, en orden de prioridad:

1. **Alcance de la certificación.** ¿Certifica la aplicación, de modo que cualquier cuenta TBO de una agencia de la
   red puede operar por ella, o una cuenta concreta? Decide D-TBO-03 y D-TBO-38. → [Q-77](./10-preguntas-para-tbo.md#q-77)
2. **Recuperación del Book.** ¿Qué devuelve `BookingDetail` cuando no existe reserva para un `BookingReferenceId`?
   ¿Un segundo Book con el mismo `BookingReferenceId` devuelve la reserva existente, se rechaza o duplica? ¿`405`
   garantiza que no se creó nada? Decide D-TBO-24. → [Q-37](./10-preguntas-para-tbo.md#q-37), [Q-35](./10-preguntas-para-tbo.md#q-35), [Q-36](./10-preguntas-para-tbo.md#q-36)
3. **Costo y cuota.** ¿Hay costo por búsqueda o límite de look-to-book? ¿Cuál es el QPS por cuenta y por método, y
   comparten cuota los estáticos? Decide D-TBO-17, D-TBO-18 y D-TBO-04. → [Q-87](./10-preguntas-para-tbo.md#q-87), [Q-10](./10-preguntas-para-tbo.md#q-10)
4. **Transporte.** ¿El host de test acepta HTTPS? ¿Cuál es la URL live? Decide D-TBO-30. → [Q-03](./10-preguntas-para-tbo.md#q-03), [Q-04](./10-preguntas-para-tbo.md#q-04)
5. **Moneda del perfil.** ¿Qué monedas admite un perfil y puede una cuenta tener varias? Decide D-TBO-15.
   → [Q-88](./10-preguntas-para-tbo.md#q-88)
6. **Catálogo.** ¿Códigos y contenido son iguales para todas las cuentas? Decide D-TBO-11. → [Q-60](./10-preguntas-para-tbo.md#q-60)
7. **Precio mínimo.** ¿`RecommendedSellingRate` aplica cuando una agencia B2B vende al viajero, y al componente hotel
   de un paquete? Decide D-TBO-16. → [Q-23](./10-preguntas-para-tbo.md#q-23)
8. **Cancelación.** ¿Un `200` garantiza `Cancelled` o puede quedar en un estado intermedio? ¿`479` es definitivo?
   Decide D-TBO-25. → [Q-49](./10-preguntas-para-tbo.md#q-49), [Q-50](./10-preguntas-para-tbo.md#q-50)
9. **Confidencialidad.** ¿Hay NDA sobre el PDF, la colección y el documento de certificación que impida versionarlos
   en un repositorio privado? Decide D-TBO-33. → [Q-94](./10-preguntas-para-tbo.md#q-94)
10. **Canales.** ¿Agregar B2C, WhatsApp o móvil después de certificar B2B obliga a recertificar? Decide D-TBO-36.
    → [Q-78](./10-preguntas-para-tbo.md#q-78)

Las sondas PR-01 a PR-11 del arnés ([07](./07-certificacion.md) §6.8) pueden cerrar con evidencia varias preguntas
de detalle (forma de `ChildrenAges`, TLS en test, casing, respuesta de "no existe", idempotencia del Book, juego de
caracteres) antes de que TBO conteste.

---

## Referencias cruzadas

- [00-fuentes.md](./00-fuentes.md): procedencia, hashes, convención de citas y cifras canónicas.
- [01-autenticacion-conectividad-y-errores.md](./01-autenticacion-conectividad-y-errores.md): RF-01 a RF-04,
  RNF-01 a RNF-03, RNF-05, RNF-11.
- [02-search-y-oferta-canonica.md](./02-search-y-oferta-canonica.md): RF-05 a RF-14, RF-35.
- [03-prebook-y-book.md](./03-prebook-y-book.md): RF-15 a RF-23, RNF-04.
- [04-post-venta-detalle-cancelacion-y-conciliacion.md](./04-post-venta-detalle-cancelacion-y-conciliacion.md):
  RF-24 a RF-29, RF-38, RNF-08, RNF-10.
- [05-contenido-estatico-e-inventario.md](./05-contenido-estatico-e-inventario.md): RF-30 a RF-34, RF-40, RNF-16.
- [06-seams-integracion-repo.md](./06-seams-integracion-repo.md): RF-35 a RF-37, RF-40, RNF-06, RNF-14.
- [07-certificacion.md](./07-certificacion.md): §5, RF-39.
- [09-plan-implementacion.md](./09-plan-implementacion.md): orden, esfuerzo, numeración de migraciones y medición
  informativa de valor (§10).
- [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md): preguntas consolidadas y numeradas.
