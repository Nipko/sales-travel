---
titulo: 'Sabre — POST /v1/trip/orders/createBooking (contrato completo)'
fecha: 2026-08-25
estado: reconciliado contra contrato oficial
---

Fuentes: ver `00-fuentes.md`.

# Sabre `createBooking` — contrato completo

## 0. Cómo leer este documento

Se usa el marcado canónico de `00-fuentes.md` §4: **VERIFICADO** (body/header/script real de la
colección), **VERIFICADO-SPEC** (contrato OpenAPI oficial; se cita `archivo.yml:línea`),
**[INFERIDO]**, **DESCONOCIDO**. En las tablas se abrevia **[V]**, **[VS]**, **[I]**, **[?]**.

### 0.1 Tres correcciones de procedencia respecto a la primera pasada

1. **La primera pasada afirmaba que las 4 respuestas guardadas de la colección "están vacías"
   (`bodyLen = 0`). Es FALSO y queda retirado.** Cada una pesa **16.479 bytes** y están extraídas
   en `evidence/responses/*.json`. El error venía de leer `requests.jsonl`, que guarda por respuesta
   sólo `{name, len}` sin `body`; nunca se comprobó contra el `.json` original. Regla de método:
   **no derivar afirmaciones de ausencia desde un extracto**. Esas 4 respuestas se usan en §6.5.
2. **El front-matter citaba `EXTERNAL_AGENCY.postman_collection.json`. Es FALSO**: ese archivo es
   la colección de **LATAM NDC** (160 requests, `sandbox.api.latam.com/ndc/v192/*`). La fuente
   Sabre es `sabre/Booking Management API v2026.04.postman_collection.json` (1.077 requests).
   Corregido: toda procedencia vive ahora en `00-fuentes.md`.
3. **La primera pasada ignoró el carril SOAP/LLS stateful** (243 de 1.077 requests). Se añade
   §9. El título "contrato completo" sólo era cierto para el carril REST.

### 0.2 Qué cambió al reconciliar contra el contrato oficial

Ahora existe `specs/booking-management-v1.yml` (Swagger 2.0, Booking Management **v1.33**, 270
definiciones) más 81 páginas oficiales, incluida la **lista de errores de createBooking**. Casi
todo lo que estaba `[INFERIDO]` o `DESCONOCIDO` en §3 se resuelve. Los cinco cambios de mayor
impacto:

| #   | La primera pasada decía                                                           | El contrato dice                                                                                                                                                                                                                          | Dónde  |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | «`errorHandlingPolicy` **no existe** en createBooking; es de `cancelBooking`»     | **Sí existe**, es un **array** de 8 valores diseñado exactamente para el éxito parcial                                                                                                                                                    | §5     |
| 2   | «`AGENCY_IATA` es la FOP recomendada para el canal aéreo»                         | `AGENCY_IATA`/`AGENCY_NAME`/`CORPORATE`/`COMPANY_NAME`/`VIRTUAL_CARD` son **de hotel**. Para aéreo sin PAN la respuesta es **`CASH`**                                                                                                     | §7     |
| 3   | «`title` es texto libre; `"Congressman"` rompe nuestro enum»                      | `TitleEnum` es un **enum cerrado de 18 valores** que **incluye** `Congressman`                                                                                                                                                            | §3.4   |
| 4   | «no sabemos si `createBooking` devuelve `bookingSignature`»                       | **No lo devuelve.** Sólo `getBooking`. Hay que encadenar                                                                                                                                                                                  | §6.3   |
| 5   | «`flightPricing[].qualifiers.validatingAirlineCode` fija la aerolínea validadora» | **Confirmado, con matiz:** `PricingQualifiers` hereda `TicketingQualifiers` por `allOf`, así que `validatingAirlineCode` y `commissionPercentage` **sí valen dentro de `qualifiers`** — pero **no** sueltos al nivel de `flightPricing[]` | §3.3.2 |

---

## 1. El endpoint

| Aspecto                                  | Valor                                                                                      | Marca                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Método + ruta                            | `POST {{rest_endpoint}}/v1/trip/orders/createBooking`                                      | [V] + [VS] `booking-management-v1.yml:15` (`basePath: /v1/trip/orders`) y `:190`                   |
| `operationId`                            | `createBooking`                                                                            | [VS] `booking-management-v1.yml:192`                                                               |
| Descripción oficial                      | «Creates an air booking (NDC/ATPCO/LCC).»                                                  | [VS] `booking-management-v1.yml:193`                                                               |
| Host CERT                                | `https://api.cert.platform.sabre.com`                                                      | [V] + [VS] `booking-management-v1.yml:12`                                                          |
| Versión del contrato                     | Booking Management **v1.33**                                                               | [VS] `booking-management-v1.yml:8`                                                                 |
| Nº de requests que lo usan               | **176** (169 URL literal + 7 vía `{{createBooking_endpoint}}`)                             | [V]                                                                                                |
| Auth                                     | OAuth2 `client_credentials`, Bearer de `POST /v2/auth/token`, credenciales en Basic base64 | [V] + [VS] `booking-management-v1.yml:20-27` (`x-base64-encode-client-credentials: true` en `:27`) |
| Header `Authorization`                   | **required: true**, `Bearer TOKEN`                                                         | [VS] `booking-management-v1.yml:203-207`                                                           |
| Body                                     | **required: true**, `$ref CreateBookingRequest`                                            | [VS] `booking-management-v1.yml:196-202`                                                           |
| Content-Type / Accept                    | `application/json` (declarado global en el spec)                                           | [V] 176/176 + [VS] `booking-management-v1.yml:16-19`                                               |
| Query params                             | **Ninguno**. Todo va en el body                                                            | [V] + [VS] (el spec no declara ningún parámetro `in: query`)                                       |
| Respuestas declaradas                    | **Sólo `200`** con `CreateBookingResponse`                                                 | [VS] `booking-management-v1.yml:209-213`                                                           |
| `Conversation-ID` (request)              | 33/176                                                                                     | [V]                                                                                                |
| `x-request-id` (request)                 | 10/176                                                                                     | [V]                                                                                                |
| `X-Sabre-Group` / `X-Sabre-Current-City` | 28/176 (`G7RE`, `U9PK`) — actuar sobre otro PCC del grupo                                  | [V]                                                                                                |

Headers de respuesta verificados: `x-request-id` y `ConversationId`.
[V] — `Create Booking / Flights - NDC/ATPCO/LCC / CreateBooking - retention segment (OTH) only`:

```js
pm.test('response must include x-request-id and ConversationId', function () {
  pm.response.to.have.header('x-request-id');
  pm.response.to.have.header('ConversationId');
});
```

> **[VS] El spec declara únicamente el código `200`.** No hay `400`/`401`/`5xx` declarados. Junto
> con `CreateBookingResponse.errors[]` (§6.2) esto significa que **el API devuelve 200 y mete los
> errores en el cuerpo**, al menos en su contrato publicado. Clasificar fallos por status HTTP
> sería un error de diseño del ACL. **[?]** Queda por confirmar si en la práctica hay 4xx para
> errores de transporte/validación de esquema.

### 1.1 Naturaleza del servicio — stateless con sesión opcional [VS]

> «This API is designed to operate in a **stateless** way, and accepts both **sessionless (ATK)**
> and **session-based (ATH)** tokens. When a call is made to this API via a session-based token,
> the **session (AAA) is cleared before and after execution**.»
> — `specs/help/booking-management-api-v1/help-documentation-create-booking.txt`

Consecuencia de diseño: `createBooking` REST **no requiere** `SessionCreateRQ`. Pero limpia la
AAA, así que **no se puede intercalar** en medio de una secuencia LLS stateful sin destruirla.
Ver §9.

### 1.2 Lo que `createBooking` orquesta por dentro [VS]

La documentación oficial lista las APIs internas que `createBooking` encadena:
`ContextChangeLLSRQ`, `EPS_EXT_ProfileToPNRRQ`, `EPS_EXT_ProfileReadRQ`, `GetReservationRQ`,
Order Management, `UpdateReservationRQ`, **`PassengerDetailsRQ`**, `SabreCommandLLSRQ`,
**`OTA_AirBookLLSRQ`**, `OTA_AirPriceLLSRQ`, `EnhancedHotelBookRQ`, `EnhancedVehBookRQ`,
**`EnhancedEndTransactionRQ`**.

Esto es **la prueba directa** de que el REST `createBooking` es un envoltorio del mismo carril LLS
que se documenta en §9. No son dos productos: son dos niveles de abstracción sobre lo mismo.

### 1.3 Lógica de reintento de estado de vuelo (ATPCO) [VS]

> «If the flight status is `NN`, Create Booking waits **1000ms** before checking the flight status
> once again. This retry check is performed up to **five (5) times with a progressive delay
> (increased by an additional 1000ms each time)** before processing stops. LCC bookings are
> excluded from this logic. Flight status retry logic is executed **regardless** of whether the
> `NN` status is included in `flightDetails.haltOnFlightStatusCodes`.»
> — `help-documentation-create-booking.txt`

**Peor caso interno: 1+2+3+4+5 = 15 segundos** sólo en la espera de estado, antes de sumar
`asynchronousUpdateWaitTime` y la latencia de los servicios internos. Esto redimensiona el riesgo
de timeout de §5.5 y es incompatible con un timeout HTTP de 10 s.

### 1.4 Cadena previa obligatoria (de dónde salen los IDs)

Para la variante NDC, `createBooking` es el **tercer** paso. Los identificadores salen de la
respuesta de `POST /v1/offers/price` [V] — extraídos de los scripts `test` de Postman:

```js
// Workflows / 18 - NDC Multiple traveler types (Adult+Child) / 2. Offers Price /v1
pm.environment.set('price_offer_item_id_adt', jsonData.response.offers[0].offerItems[0].id);
pm.environment.set('price_offer_item_id_cnn', jsonData.response.offers[0].offerItems[1].id);
pm.environment.set(
  'price_passenger_id1',
  jsonData.response.offers[0].offerItems[0].passengers[0].id,
);
```

| Campo de createBooking                 | Origen exacto                                                            | Marca                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `flightOffer.offerId`                  | `/v1/offers/price` → `response.offers[0].id`                             | [V] + [VS] `booking-management-v1.yml:4959` («returned in a shopping response») |
| `flightOffer.selectedOfferItems[]`     | `response.offers[0].offerItems[n].id`                                    | [V] + [VS] `:4966`                                                              |
| `travelers[].id`                       | `response.offers[0].offerItems[n].passengers[m].id`                      | [V] + [VS] `:6156` («Price traveler's id as returned from Offer Price»)         |
| `flightOffer.seatOffers[].seatOfferId` | `/v1/offers/getseats` → `aLaCarteOffer.aLaCarteOfferItems[].offerItemID` | [V] + [VS] `:5280`                                                              |
| `flightOffer.seatOffers[].number`      | `seatMaps[0].cabinCompartments[0].seatRows[].row` + `.seats[].column`    | [V]                                                                             |

> **Dato crítico de diseño:** hay un `offerId` **por oferta** y un `offerItemId` **por tipo de
> pasajero**. En un ADT+CNN se mandan **dos** `selectedOfferItems`.
> [V] — `Workflows / 18 - NDC Multiple traveler types (Adult+Child) / 3. CreateBooking NDC`.

> **[VS] La oferta caduca.** Error oficial `UNABLE_TO_CREATE_ORDER_EXPIRED_OFFER` /
> `BAD_REQUEST`: «Invalid or Expired Offer. Use offers/price to reprice the offer.»
> — `help-documentation-create-booking-error-list.txt:1176`. El ACL tiene que tratar este error
> como **recuperable con re-pricing automático**, no como fallo terminal.

---

## 2. Taxonomía de variantes

La regla estructural más importante:

> **`flightOffer` y `flightDetails` son mutuamente excluyentes. Cero requests llevan los dos.** [V]

⚠️ **Corrección:** el spec **no declara** esa exclusión mutua (`CreateBookingRequest` no tiene
`oneOf`/`not`, `booking-management-v1.yml:736-741`), y **tampoco declara ningún campo como
`required`** en la raíz. La exclusividad es una regla de negocio no expresada en el esquema. La
documentación oficial la enuncia en prosa: «you can choose the following **mandatory** request
parameters: `flightOffer` … `flightDetails` …» — `help-documentation-create-booking.txt`.
Es decir: **la validación de forma no la hace Swagger, la hace el backend**. Nuestro Zod tiene que
implementar el `xor` a mano.

### 2.1 Tabla de variantes

| Variante                           | Bloques del body                                                                                                  | Cuándo se usa                                                                                                                                                                                                                                                                                                                                        | Evidencia [V]                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **NDC**                            | `flightOffer{offerId, selectedOfferItems[]}` + `travelers[]` (con `id`) + `contactInfo`                           | Vuelo comprado como _oferta NDC_. El itinerario ya está dentro de la oferta: **no se re-declaran segmentos**.                                                                                                                                                                                                                                        | `createBooking - Air NDC Payload`; `Workflows / 1 … / 3. createBooking`     |
| **NDC + asientos**                 | idem + `flightOffer.seatOffers[]`                                                                                 | Asignar asiento **al crear la orden**.                                                                                                                                                                                                                                                                                                               | `Workflows / 28-33 NDC - Assign seats at order creation`                    |
| **ATPCO**                          | `flightDetails{flights[], flightPricing[]}` + `travelers[]` (sin `id`) + `agency{}` + `payment{}`                 | Vuelo GDS clásico. **Hay que re-declarar cada segmento.**                                                                                                                                                                                                                                                                                            | `Workflows / 3 - Air Shop, Book, Cancel / 2. createBooking - ATPCO payload` |
| **LCC**                            | ATPCO + `flightDetails.flights[].source: "LCC"`                                                                   | Low-cost integrada por Sabre (FR, U2…).                                                                                                                                                                                                                                                                                                              | `createBooking - Air LCC`; `Workflows / 20`                                 |
| **Híbrido LCC+ATPCO**              | `flights[]` con `source` distinto por segmento + `flightPricing[]` por `flightIndices` + **dos** `formsOfPayment` | Ida LCC, vuelta ATPCO, en la misma reserva.                                                                                                                                                                                                                                                                                                          | `Workflows / 22 - LCC + ATPCO - Check, Refund Booking / CreateBooking`      |
| **Pasiva**                         | `flights[]` con `flightStatusCode: "YK"` + `confirmationId` **por vuelo**, sin `flightPricing`                    | Registrar un segmento reservado fuera de Sabre. **[VS]** `booking-management-v1.yml:5221` lo confirma: «Populate this value if you made a booking directly with the airline and wish to build a Sabre passive booking.» El spec añade `arrivalDate`/`arrivalTime` **específicos para pasivas** (`:5227`, `:5233`), que la colección **no ejercita**. | `createBooking - Passive Air segment`                                       |
| **Con perfil (ProfileName)**       | `profiles[{profileName, profileTypeCode:"TVL", domainId}]`                                                        | Traer datos del viajero desde Sabre Profiles por **nombre**.                                                                                                                                                                                                                                                                                         | `createBooking - Air NDC with ProfileName`                                  |
| **Con perfil (ProfileId)**         | `profiles[{uniqueId, profileTypeCode:"TVL", domainId}]`                                                           | Igual por **ID único**.                                                                                                                                                                                                                                                                                                                              | `createBooking - Air NDC with ProfileId`; `Workflows / 2` y `/ 4`           |
| **Retention segment (OTH)**        | `retentionEndDate` + `retentionLabel`, con o sin vuelo                                                            | Mantener el PNR vivo sin segmento activo. Puede ir **solo**.                                                                                                                                                                                                                                                                                         | `CreateBooking - retention segment (OTH) only`                              |
| **Hotel CSL**                      | `hotel{bookingKey, rooms[], paymentPolicy, formOfPayment}` + `payment.formsOfPayment[]`                           | Reserva de hotel vía Content Services for Lodging.                                                                                                                                                                                                                                                                                                   | `Create Booking / CSL Hotel / …`; `Workflows / 9`                           |
| **Coche**                          | `car{bookingKey, travelerIndex, …}`                                                                               | Reserva de vehículo.                                                                                                                                                                                                                                                                                                                                 | `Create Booking / Vehicle / createBooking - simple vehicle`                 |
| **Multi-producto (aéreo + hotel)** | `flightDetails` **+** `hotel` en la misma llamada                                                                 | Un PNR con vuelo y hotel. **Es la variante donde el éxito parcial duele.**                                                                                                                                                                                                                                                                           | `Create Booking / CSL Hotel / createBooking - Air with CSL hotel`           |
| **Ancillaries**                    | `travelers[].ancillaries[]` (+ opcional `specialServices[]`)                                                      | Equipaje / servicios de pago en la creación. **[VS] NO soportado en NDC** (ver §3.4.4).                                                                                                                                                                                                                                                              | `createBooking - Ancillaries baggage`; `Workflows / 19` y `/ 20`            |
| **Branded fares**                  | `flightPricing[].qualifiers.brandedFares[]` + `specificFares[]`                                                   | Forzar marca tarifaria y fare basis por tramo.                                                                                                                                                                                                                                                                                                       | `createBooking - Branded fares`                                             |
| **Cambio de PCC**                  | `targetPcc` en la raíz                                                                                            | Emitir bajo otro PCC del grupo (**central para consolidador**).                                                                                                                                                                                                                                                                                      | `createBooking - Air with Changed PCC`                                      |

### 2.2 Matriz de combinación observada — **corregida**

⚠️ La primera pasada publicaba `car = 6` en §2.2 y `car = 5` en §3.1, y **omitía la fila del
request sin ningún bloque de producto**. Los totales no cuadraban. Cifras corregidas (parseo
tolerante de **175 de 176** bodies):

| Combinación de bloques          | Nº requests |
| ------------------------------- | ----------- |
| `flightDetails` sola            | 77          |
| `flightOffer` sola              | 60          |
| `hotel` sola                    | 20          |
| `car` sola                      | **5**       |
| `flightOffer` + `profiles`      | 3           |
| `flightDetails` + `profiles`    | 3           |
| `flightOffer` + retención OTH   | 2           |
| `flightDetails` + retención OTH | 1           |
| retención OTH sola              | 1           |
| `hotel` + `profiles`            | 1           |
| `flightDetails` + `hotel`       | 1           |
| **(ningún bloque de producto)** | **1**       |
| **Total**                       | **175**     |

El único body que **no parsea** es `Create Booking / Vehicle / createBooking - vehicle with
Collection Site` (comentarios `//` inline no-JSON). Se nombra para que quien audite sepa cuál
falta.

`car` nunca aparece combinado con vuelo ni hotel en esta colección [V]. El spec **no lo prohíbe**:
`CreateBookingRequest` acepta `flightOffer`/`flightDetails`, `hotel` y `car` como propiedades
independientes (`booking-management-v1.yml:736-747`), y `errorHandlingPolicy` tiene un valor
dedicado `DO_NOT_HALT_ON_CAR_BOOKING_ERROR` que sólo tiene sentido en una llamada mixta. **[I]**
Se puede; simplemente no está ejercitado.

---

## 3. Estructura del body — contrato real

⚠️ **Cambio de método respecto a la primera pasada.** Antes, la obligatoriedad se deducía de
«aparece en el 100 % de los requests de esa variante». Ahora se lee del contrato. La columna
"visto en N" se conserva porque distingue **lo que el contrato permite** de **lo que Sabre
realmente ejercita**, que no es lo mismo y ambos importan.

### 3.1 Raíz — `CreateBookingRequest` [VS] `booking-management-v1.yml:694`

> **`CreateBookingRequest` no declara NINGÚN campo `required`.** No hay bloque `required:` en la
> definición (`:694-802`). Toda la obligatoriedad es de negocio y se manifiesta como **error en
> tiempo de ejecución**, no como rechazo de esquema. Esto obliga a validar en nuestro borde.

| Campo                            | Tipo / contrato                                | Línea spec | Visto en        | Obligatorio                   | Notas                                                                                                                                              |
| -------------------------------- | ---------------------------------------------- | ---------- | --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errorHandlingPolicy`            | `array<CreateErrorPolicyEnum>`                 | `:698`     | **0**           | No (default `HALT_ON_ERROR`)  | **NUEVO — ver §5.** La colección **nunca** lo usa                                                                                                  |
| `targetPcc`                      | string, `^[A-Z0-9]{3,4}$`                      | `:704`     | 2               | No                            | «The API **does not revert context** after completing the booking» [VS] `:708`. Central para consolidador — y peligroso: deja el contexto cambiado |
| `receivedFrom`                   | string, default `"Create Booking"`             | `:709`     | 1               | No                            | Auditoría PNR. Valor visto: `"Wakanow"`                                                                                                            |
| `asynchronousUpdateWaitTime`     | integer int32, **min 0, max 10000, default 0** | `:714`     | 28              | No                            | Ver §3.1.1                                                                                                                                         |
| `profiles`                       | array, **minItems 1, maxItems 13**             | `:723`     | 7               | No                            | Ver §3.11                                                                                                                                          |
| `agency`                         | `Agency`                                       | `:733`     | 121             | De facto en ATPCO/hotel       | Ver §3.6                                                                                                                                           |
| `flightOffer`                    | `FlightOffer`                                  | `:736`     | 65              | Sí en NDC (por prosa oficial) | Ver §3.2                                                                                                                                           |
| `flightDetails`                  | `FlightDetails`                                | `:739`     | 82              | Sí en ATPCO/LCC/pasiva        | Ver §3.3                                                                                                                                           |
| `hotel`                          | `HotelToBook`                                  | `:742`     | 22              | Sólo variante hotel           | Ver §3.8                                                                                                                                           |
| `car`                            | `CarToBook`                                    | `:745`     | 5               | Sólo variante coche           | Ver §3.8                                                                                                                                           |
| `travelers`                      | array de `BookTraveler`                        | `:748`     | 170/176         | De facto                      | Ver §3.4                                                                                                                                           |
| `contactInfo`                    | `BookContactInformation`                       | `:754`     | 167/176         | De facto                      | Ver §3.5                                                                                                                                           |
| `payment`                        | `Payment`                                      | `:759`     | 94              | Depende de FOP                | Ver §3.7                                                                                                                                           |
| `remarks`                        | array de `BookRemark`                          | `:762`     | 3               | No                            | Ver §3.9                                                                                                                                           |
| **`notification`**               | `Notification`                                 | `:770`     | **0**           | No                            | **NUEVO.** Email o cola tras crear. Ver §3.12                                                                                                      |
| `otherServices`                  | array de `OtherServiceInformation`             | `:775`     | 3 (9 elementos) | No                            | OSI. **[VS]** «Not supported for hotel chains and/or car rental vendors» `:777`                                                                    |
| `retentionEndDate`               | string **`format: date`**                      | `:781`     | 4               | Sólo variante OTH             | ⚠️ Ver §3.10 — **corrección**                                                                                                                      |
| `retentionLabel`                 | string, `^[a-zA-Z0-9 ,.*?\-\/]{0,215}$`        | `:787`     | 4               | Sólo variante OTH             | Máx. 215 caracteres                                                                                                                                |
| **`travelersEmployers`**         | array de `TravelersEmployer`                   | `:792`     | **0**           | No                            | **NUEVO.** `idType`, `employerId`, `employerName`, `phones`, `emails`, dirección. Se enlaza con `travelers[].employerIndex`                        |
| **`sendLoyaltiesToAllAirlines`** | boolean                                        | `:798`     | **0**           | No                            | **NUEVO.** Manda todos los FF a todos los carriers del itinerario                                                                                  |

**Campos que la colección envía y el contrato NO declara** — se están **ignorando en silencio**:

| Campo enviado                                                                                                                        | Dónde                                                              | Veredicto                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments` (plural) en la raíz                                                                                                       | 1 request (`ModifyBooking / … (LCC) / Delete FOP / CreateBooking`) | No existe. Copy-paste de la respuesta (donde sí es `payments`, §6.2). Resuelve la duda: **request `payment`, respuesta `payments`, sin excepción** |
| `confirmationId` en la raíz                                                                                                          | 1 request                                                          | No existe en `CreateBookingRequest`. Sólo existe **por vuelo** (pasivas, `:5221`)                                                                  |
| `travelers[].type`                                                                                                                   | 4 requests                                                         | No existe en `BookTraveler`. **Sí existe en `Traveler` (respuesta), `:1740`.** Ver §3.4                                                            |
| `travelers[].customerNumber`                                                                                                         | 2 requests                                                         | No existe. El DK number vive en `agency.agencyCustomerNumber` (`:4750`)                                                                            |
| `hotel.useCSL` (mayúscula)                                                                                                           | 1 request                                                          | El contrato dice **`useCsl`** (`:5026`), default `true`                                                                                            |
| `flightPricing[].commissionPercentage` / `.validatingAirlineCode` / `.baggageAllowance` / `.passengersPricing` fuera de `qualifiers` | varios                                                             | `PricingDetails` sólo tiene `priceComparisons` y `qualifiers` (`:5759-5773`)                                                                       |
| `qualifiers.validatingAirline` (sin `Code`)                                                                                          | 1 request                                                          | No existe en ninguna versión; el nombre correcto es `validatingAirlineCode`. Ver §3.3.2                                                            |
| `ancillaries[].reasonForIssuanceCode` + `reasonForIssuanceName`                                                                      | 1 request                                                          | Sólo existe `reasonForIssuance` (enum, `:7058`)                                                                                                    |

#### 3.1.1 `asynchronousUpdateWaitTime` — ahora con límites del contrato

**[VS]** `booking-management-v1.yml:714-722`: `integer int32`, **mínimo 0, máximo 10000, default
0**, «The maximum wait time in milliseconds applied to asynchronous updates related to booking
creation. **Mainly used for the redisplay operation of NDC bookings**.»

Esto **corrige** la lectura de la primera pasada. No es «cuánto tarda Sabre en crear la orden»:
es cuánto espera Sabre a que la **redisplay** de la orden NDC se sincronice antes de responder.
La orden puede estar creada aunque el `booking` devuelto venga incompleto. Los 28 usos de la
colección (27 NDC, valores 1000/3000/5000) siguen siendo [V], y el **techo real es 10000 ms**
— responde la pregunta abierta 16 de la primera pasada.

**Consecuencia operativa (se mantiene y se agrava):** presupuesto de latencia de `createBooking` =
hasta **15 s** de retry de estado (§1.3) **+** hasta **10 s** de `asynchronousUpdateWaitTime`
**+** latencia de red y de los ~13 servicios internos. **El timeout HTTP del cliente no puede
bajar de 45 s**, y cortar antes produce PNRs huérfanos. Ver §5.5 y §Riesgos.

### 3.2 `flightOffer` (variante NDC) — [VS] `booking-management-v1.yml:4952`

```jsonc
"flightOffer": {
  "offerId": "{{price_offer_id}}",
  "selectedOfferItems": [ "{{price_offer_item_id_adt}}", "{{price_offer_item_id_cnn}}" ],
  "seatOffers": [
    { "seatOfferId": "{{segment1Passenger1OfferItemId}}", "number": "12A", "travelerIndex": 1 }
  ]
}
```

| Campo                        | Tipo / contrato                        | Línea   | Obligatorio                 | Notas                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------- | ------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offerId`                    | string, **minLength 2, maxLength 49**  | `:4959` | **Sí — `required`** `:4956` | De `/v1/offers/price`                                                                                                                                                                        |
| `selectedOfferItems`         | `string[]`, **minItems 1, maxItems 9** | `:4966` | **Sí — `required`** `:4957` | **Máximo 9**: techo duro de offer items por orden NDC                                                                                                                                        |
| `seatOffers[]`               | array de `BookSeatOffer`, minItems 1   | `:4975` | No                          | Sólo NDC                                                                                                                                                                                     |
| `seatOffers[].seatOfferId`   | string, minLength 2, maxLength 49      | `:5280` | No en el esquema            | Pero el error `SEATS_OFFER_ID_MISSING` / `BAD_REQUEST` («At least one of the selected seats of the NDC flights does not have the required offer ID») lo hace **obligatorio de facto en NDC** |
| `seatOffers[].number`        | string, **`^[0-9]+[A-Z]$`**            | `:5293` | No                          | `"12A"`. **No admite** columna con letra doble                                                                                                                                               |
| `seatOffers[].travelerIndex` | integer, min 1                         | `:5298` | **Sí — `required`** `:5291` | 1-based                                                                                                                                                                                      |

> **`selectedOfferItems` maxItems 9** [VS] es un dato de producto, no de implementación: **una
> orden NDC de Sabre no admite más de 9 offer items**. Grupos grandes obligan a partir la reserva.

> `travelerIndex` es **1-based** en todos los bloques (`seatOffers`, `seats`, `otherServices`,
> `car.travelerIndex`, `hotel.rooms[].travelerIndices`, `ancillaries`, `formOfPaymentIndices`,
> `infantTravelerIndex`, `employerIndex`, `flightIndices`). [V] + [VS] (`minimum: 1` en todos).
> Fuente clásica de bugs off-by-one contra un array JS 0-based.

Errores oficiales de asientos: `SEATS_OFFER_UNAVAILABLE`, `SEATS_OFFER_INVALID`,
`SEATS_OFFER_ID_MISSING`, `SEATS_ASSIGNMENT_INVALID`, `DUPLICATE_SEAT_ASSIGNMENT`,
`SEATS_DUPLICATE_ASSOCIATION`. Todos son **recuperables reintentando sin el asiento** si se
combina con `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR` (§5).

### 3.3 `flightDetails` (ATPCO / LCC / pasiva) — [VS] `booking-management-v1.yml:4983`

`FlightDetails` no declara `required`. Sus cuatro propiedades:

| Campo                            | Contrato                                               | Línea   |
| -------------------------------- | ------------------------------------------------------ | ------- |
| `flights[]`                      | array de `FlightToBook`, **minItems 1, maxItems 16**   | `:4987` |
| `flightPricing[]`                | array de `PricingDetails`, **minItems 1, maxItems 10** | `:4995` |
| `haltOnFlightStatusCodes[]`      | array de `HaltOnFlightStatusCodeEnum`                  | `:5004` |
| `retryBookingUnconfirmedFlights` | boolean                                                | `:5011` |

> **`flights` maxItems 16** [VS] `:4990` — techo duro de 16 segmentos por PNR.
> **`flightPricing` maxItems 10** [VS] `:4998` — «If you wish to assign different mark-ups or
> commissions per specific passenger type, you can send separate pricing instructions per type.»
> Esto es exactamente el gancho del **pricing waterfall** del modelo consolidador.

#### 3.3.1 `flightDetails.flights[]` — `FlightToBook` [VS] `:5161`

**Ocho campos `required`** [VS] `:5164-5172`: `flightNumber`, `airlineCode`, `departureDate`,
`departureTime`, `fromAirportCode`, `toAirportCode`, `bookingClass`, `flightStatusCode`.

| Campo                               | Tipo / pattern                                | Línea           | Req.         | Corrección respecto a la 1ª pasada                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------- | --------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flightNumber`                      | **`integer` int32, min 1, max 9999**          | `:5174`         | Sí           | ⚠️ **Resuelto:** el contrato dice **entero, no string**. La colección lo manda entre comillas en **20 requests** (`"{{oFlightNumber}}"` ×16, `"{{firstFlightNumber}}"`, `"{{oReturnFlightNumber}}"`, `"{{oFirstFlightNumber}}"` ×2) y sin comillas en el resto. **Nuestro ACL debe emitir SIEMPRE número.** Que Sabre coerza el string es [?] |
| `airlineCode`                       | string `^[A-Z0-9]{2}$`                        | `:5181`         | Sí           | Admite dígito (p. ej. `4M`, `2Z`) — relevante en LATAM                                                                                                                                                                                                                                                                                        |
| `fromAirportCode` / `toAirportCode` | string `^[A-Z]{3}$`                           | `:5187`/`:5192` | Sí           | IATA, sólo letras                                                                                                                                                                                                                                                                                                                             |
| `departureDate`                     | `format: date` (`YYYY-MM-DD`)                 | `:5197`         | Sí           | «in the airport's time zone»                                                                                                                                                                                                                                                                                                                  |
| `departureTime`                     | `^([0-1][0-9]\|2[0-3]):[0-5][0-9]$`           | `:5202`         | Sí           | `HH:MM`, sin segundos                                                                                                                                                                                                                                                                                                                         |
| `bookingClass`                      | **`^[A-Za-z ]+$`**                            | `:5207`         | Sí           | ⚠️ **No es `string(1)`**: el pattern admite varias letras y espacios                                                                                                                                                                                                                                                                          |
| `flightStatusCode`                  | **`^[A-Za-z ]+$`**, default `NN`              | `:5216`         | Sí           | ⚠️ Tampoco es un enum cerrado en el request                                                                                                                                                                                                                                                                                                   |
| `isMarriageGroup`                   | boolean                                       | `:5212`         | No           | Segmentos casados                                                                                                                                                                                                                                                                                                                             |
| `confirmationId`                    | string `^[A-Z0-9]{5,}$`                       | `:5221`         | Sólo pasivas | **5+** caracteres, no 6                                                                                                                                                                                                                                                                                                                       |
| **`arrivalDate`**                   | `format: date`                                | `:5227`         | No           | **NUEVO** — «Used for the purpose of creating passive bookings». La colección no lo usa                                                                                                                                                                                                                                                       |
| **`arrivalTime`**                   | `^([0-1][0-9]\|2[0-3]):[0-5][0-9]$`           | `:5233`         | No           | **NUEVO** — idem                                                                                                                                                                                                                                                                                                                              |
| `source`                            | `FlightToBookSourceEnum`, **default `ATPCO`** | `:5238`         | No           | `ATPCO` \| `LCC`                                                                                                                                                                                                                                                                                                                              |
| `seats[]`                           | array de `BookSeat`                           | `:5243`         | No           | Ver abajo                                                                                                                                                                                                                                                                                                                                     |
| `changeOfGaugeSeats[]`              | array de `BookGenericSeat`                    | `:5250`         | No           | Asientos del **primer** avión en un change-of-gauge                                                                                                                                                                                                                                                                                           |

**`BookSeat`** [VS] `:5257` = `BookGenericSeat` (`number`, `travelerIndex` required) **más**
`areaPreferences[]` (`SeatAreaPreferenceEnum`, minItems 1, **maxItems 3**), **NUEVO** y no
ejercitado por la colección: permite pedir zona (`FRONT`, `LEFT_SIDE`…) en vez de asiento
concreto. **[VS] `areaPreferences` no puede combinarse con `number`** (`:5268`), y el error
`INVALID_COMBINATION` añade: «`seats.areaPreferences` cannot be combined with
`changeOfGaugeSeats.number` in the case of a change of gauge flight».

#### 3.3.2 `flightPricing[]` — `PricingDetails` [VS] `:5759`

⚠️ **Corrección estructural.** `PricingDetails` tiene **exactamente dos** propiedades:
`priceComparisons[]` (`:5763`, minItems 1 **maxItems 2**) y `qualifiers` (`:5771`). **Todo lo
demás va dentro de `qualifiers`.** Los cuatro campos que la colección pone al nivel de
`flightPricing[]` (`commissionPercentage`, `validatingAirlineCode`, `baggageAllowance`,
`passengersPricing`) **no existen ahí**.

**Corrección sobre comisión y aerolínea validadora (rectifica la pasada anterior de este mismo
documento).** `PricingQualifiers` (`:5802-6027`) es un **`allOf`**: `$ref TicketingQualifiers`
(`:5806`) **más** 37 propiedades propias (`:5809-6027`). Es decir: **`commissionPercentage`
(`:7687`) y `validatingAirlineCode` (`:7724`) SÍ son alcanzables desde `createBooking`**, por
herencia, en `flightPricing[].qualifiers`. La afirmación anterior —«no están en
`PricingQualifiers`, viven en `TicketingQualifiers` de fulfill»— era falsa: `TicketingQualifiers`
(`:7678`) es el bloque **compartido** por los dos pasos, no exclusivo de `fulfillFlightTickets`.

La colección lo confirma [V]: `flightPricing[].qualifiers.validatingAirlineCode: "EY"` aparece en
varios `createBooking`, y `flightPricing[].qualifiers.commissionPercentage: "10.00"` en uno.
Lo que **sí** se ignora en silencio son los mismos campos puestos **fuera** de `qualifiers`, al
nivel de `flightPricing[]` (ej. `"commissionPercentage": "0"` + `"validatingAirlineCode": "KL"` en
`createBooking - Air with pricing Complex`): ahí `PricingDetails` no los declara.

> **Consecuencia para el modelo consolidador:** el pricing waterfall (override consolidador +
> markup agencia + comisión vendedor) **puede fijarse ya en `createBooking`**, dentro de
> `flightPricing[].qualifiers`, y **también** en `fulfillFlightTickets`. Los dos pasos comparten
> el mismo bloque `TicketingQualifiers`. **[?]** Queda por confirmar en CERT cuál gana si se
> mandan valores distintos en los dos, y si Sabre honra la comisión declarada al reservar o sólo
> la del momento de emitir. Se propaga a `docs/platform/12-modelo-consolidador-y-plan.md`.

Los **37 qualifiers propios** de `PricingQualifiers` (`:5809`+, sin contar los heredados de
`TicketingQualifiers`) son: `accountCode`,
`adjustedSellingLevel`, `flightIndices`, `baggageAllowance`, `rebookLowestFares`, `brandedFares`,
`breakFareFlightIndices`, `cabinCode`, `commissionContractNames`, `corporateFare`,
`currencyPricing`, `exchangePenalties`, `excludeBasicEconomyFares`, `exemptTaxes`,
`useExcursionFare`, `forceConnectionFlightIndices`, `forceStopoverFlightIndices`,
`hemisphereCode`, `journeyCode`, `considerMultiTicket`, `useNetFare`, `netRemit`,
`priceWithTaxes`, `overrideTaxes`, `passengerStatus`, `passengerStatusCountryCode`, `payment`,
`usePrivateFare`, `usePublicFare`, `retailerRule`, `useRoundTheWorldFare`, `sideTripFlightIndices`,
`specificFares`, `spanishLargeFamilyDiscountLevel`, `spanishIslandResidentDiscountCode`,
`passengersPricing`, `settlementMethod`.

Heredados de `TicketingQualifiers` y por tanto **también válidos aquí**: `commissionAmount`,
`commissionPercentage`, `endorsements`, `excludeFareFocusFares`, `travelerIndices`, `tourCode`,
`tourCodeOverrides`, `validatingAirlineCode`.

De ellos, los relevantes para nosotros y no documentados antes: **`usePrivateFare`/`usePublicFare`**
(tarifas negociadas del consolidador), **`accountCode`** y **`corporateFare`** (tarifas
corporativas), **`useNetFare`/`netRemit`** (net remit BSP), **`currencyPricing`**,
**`adjustedSellingLevel`** (markup), **`rebookLowestFares`**, **`retailerRule`** (NDC Retailer).

**`qualifiers.payment` es `PaymentMethod`** [VS] `:5730`, **no** un objeto de tarjeta:

| Campo                         | Contrato                                   | Línea   |
| ----------------------------- | ------------------------------------------ | ------- |
| `primaryFormOfPayment`        | integer, **min 1, max 11**, **`required`** | `:5738` |
| `secondaryFormOfPayment`      | integer, min 1, max 11                     | `:5745` |
| `amountOnSecondFormOfPayment` | string `^[0-9]+(\.[0-9]{1,3})?$`           | `:5752` |

> Confirma la lectura de la primera pasada: **es un índice 1-based dentro de
> `payment.formsOfPayment[]`**, no un objeto. Lo mismo `hotel.formOfPayment` (`:5064`, min 1
> **max 11**). ⚠️ **El máximo es 11 pero `payment.formsOfPayment` tiene `maxItems: 10`**
> (`:5711`) — inconsistencia del propio contrato, sin consecuencia práctica.
> El error oficial `WRONG_FORM_OF_PAYMENT_INDEX` / `BAD_REQUEST` («Specified index is out of form
> of payment list bounds») es la prueba de que este off-by-one **se castiga**.

`priceComparisons[]` — `PriceComparison` [VS] `:5775`, **required `desiredAmount` +
`comparisonType`**; `amount` y `percent` son **mutuamente excluyentes** (`:5791` y `:5796`). La primera
pasada sólo vio `amount`; **`percent` (`^[0-9]{1,2}(\.[0-9]{1,2})?$`) también existe** y es el
control de tolerancia de precio que necesitamos contra el cache de búsqueda.

`flightPricing: [{}]` (objeto vacío) sigue significando «cotiza con defaults»; su ausencia total
significa «reserva sin cotizar». [V] los dos requests existen (`createBooking - Air no pricing`).

### 3.4 `travelers[]` — `BookTraveler` [VS] `booking-management-v1.yml:6152`

⚠️ **Corrección de conteo (hallazgo del crítico, aceptado).** La primera pasada decía «**318**
objetos traveler» y marcaba `givenName`/`surname`/`passengerCode` como «Sí (318/318)». El total
real es **321**, y **3 travelers no llevan ninguno de los tres**: sólo `id`. Son exactamente:

- `Create Booking / … / createBooking - Air NDC with ProfileName` → `{"id":"{{price_passenger_id}}"}`
- `Create Booking / … / createBooking - Air NDC with ProfileId` → idem
- `Workflows / 2 - Profiles … / 3. createBooking - ProfileId` → idem

Verificado de forma independiente en esta pasada. El contrato lo respalda: **`BookTraveler` no
declara ningún `required`** (`:6152-6266`), y la documentación oficial lo explica:

> «Instead of passing traveler information, the API can populate the data from Sabre profiles
> (including travel documents and/or loyalty programs) by using `profiles` array.»
> — `help-documentation-create-booking.txt`

Y el ejemplo oficial de "Create an NDC booking and use profile information" manda literalmente
`"travelers": [{ "id": "{{price_passenger_id}}" }]`.

> **Obligatoriedad real:** `givenName` + `surname` + `passengerCode` son obligatorios **salvo
> cuando el traveler se resuelve por `profiles[]`, donde basta `id`.** Es un dato de diseño de
> primer orden: el perfil de Sabre **sustituye por completo** el bloque de datos del pasajero.
> Y si el perfil no los trae, el error es `PROFILE_DATA_INSUFFICIENT` / `APPLICATION_ERROR`:
> «Profile contains insufficient data to create a booking. Mandatory values:
> **Name/Surname/PassengerType** are missing.»

| Campo                            | Tipo / pattern                                      | Línea   | Visto   | Obligatorio       | Notas                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------- | ------- | ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | string                                              | `:6156` | 129     | Sí en NDC         | «Price traveler's id as returned from Offer Price»                                                                                                                                                                                              |
| `title`                          | **`TitleEnum` — enum CERRADO**                      | `:6160` | 1       | No                | ⚠️ **Ver 3.4.0**                                                                                                                                                                                                                                |
| `givenName`                      | string `^[^\s]+(\s[^\s]+)*$`                        | `:6163` | 318/321 | Sí (salvo perfil) | Sin espacios al inicio/fin ni dobles                                                                                                                                                                                                            |
| `surname`                        | string **`^[^\d\s]+( [^\d\s]+)*$`**                 | `:6168` | 318/321 | Sí (salvo perfil) | ⚠️ **El apellido NO puede contener dígitos.** El nombre sí                                                                                                                                                                                      |
| `birthDate`                      | `format: date`                                      | `:6173` | 271     | Condicional       | «If you make a booking that includes **infant** travelers, you **must** provide their date of birth (INFT SSR)»                                                                                                                                 |
| `gender`                         | `GenderEnum`                                        | `:6179` | 5       | No                | «**Applies to NDC content only**»                                                                                                                                                                                                               |
| `age`                            | integer, **min 1 max 120**                          | `:6182` | 17      | Condicional       | «Applies **only to hotel bookings**. It is **mandatory** to pass the age of the child travelers/guests when booking a hotel room»                                                                                                               |
| `passengerCode`                  | string **`^[A-Z][A-Z0-9]{2}$`**                     | `:6190` | 318/321 | Sí (salvo perfil) | ⚠️ **No es un enum.** Es un patrón de 3 caracteres. Ver 3.4.0                                                                                                                                                                                   |
| `nameReferenceCode`              | string `^[a-zA-Z0-9 ,.*\-]{0,29}$`, ej. `"C05"`     | `:6197` | 14      | No                | ⚠️ **Corrección:** NO es el sufijo `-1.1`. Es «the so-called **MAN number** or statement information, used for accounting or identification». Máx. 29 car. El `{{$randomPhoneNumber}}` de los ejemplos **puede violar el pattern** (paréntesis) |
| `identityDocuments[]`            | array de `BookIdentityDocument`                     | `:6203` | 90      | No en esquema     | Ver 3.4.2                                                                                                                                                                                                                                       |
| `loyaltyPrograms[]`              | array de `LoyaltyProgram`                           | `:6208` | 47      | No                | Ver 3.4.3                                                                                                                                                                                                                                       |
| **`useNotificationContactType`** | boolean                                             | `:6213` | 0       | No                | **NUEVO.** «Required by some airlines (e.g., **Hawaiian**). Applicable to NDC only». Error asociado: `NOTIFICATION_CONTACT_TYPE_REQUIRED`                                                                                                       |
| `emails[]`                       | `string[]` `format: email`                          | `:6218` | 43      | No                |                                                                                                                                                                                                                                                 |
| `phones[]`                       | array de `Phone`                                    | `:6226` | 53      | No                | Ver 3.5                                                                                                                                                                                                                                         |
| `specialServices[]`              | array de `BookSpecialService` (**`code` required**) | `:6231` | 4       | No                | Códigos vistos: `FBAG`, `SPEQ`                                                                                                                                                                                                                  |
| `ancillaries[]`                  | array de `BookAncillary`                            | `:6237` | 9       | No                | Ver 3.4.4                                                                                                                                                                                                                                       |
| **`formOfPaymentIndices[]`**     | `integer[]`, min 1                                  | `:6242` | 0       | No                | **NUEVO.** FOP **por pasajero** — permite cobrar cada pax a una tarjeta distinta                                                                                                                                                                |
| **`infantTravelerIndex`**        | integer, min 1                                      | `:6251` | 0       | No                | **NUEVO.** Empareja infante↔adulto explícitamente. Sin él, Sabre empareja **secuencialmente** (1º infante con 1º adulto…). **Sólo se pone en el objeto del ADULTO**                                                                            |
| **`employerIndex`**              | integer, min 1                                      | `:6260` | 0       | No                | **NUEVO.** Índice en `travelersEmployers[]`. Errores: `INVALID_EMPLOYER_INDEX`, `INVALID_PASSENGER_CODE` («Employer cannot be associated to a traveler with this passengerCode»)                                                                |

#### 3.4.0 `title` y `passengerCode` — dos correcciones importantes

**`title` NO es texto libre.** `TitleEnum` [VS] `booking-management-v1.yml:9398` es un **enum
cerrado de 18 valores**:

`Mr`, `Mrs`, `Ms`, `Dr`, `Miss`, `Mstr`, `Mlle`, `Sir`, `Father`, `Sister`, `Brother`,
`Reverend`, `Lt`, `Capt`, **`Congressman`**, `Duke`, `Duchess`, `Prof`.

> Esto **resuelve la pregunta abierta 7 de la primera pasada**. `"Congressman"` no era un valor
> raro de texto libre: es un miembro legítimo del enum. Nuestro dominio (`'Mr'|'Mrs'|'Miss'|'Dr'`)
> sigue siendo insuficiente, pero la solución **no es abrirlo a `string`**: es adoptar el enum de
> 18 valores. Riesgo revisado a la baja, corrección igualmente obligatoria.

**`passengerCode` NO es un enum.** [VS] `:6192` es `^[A-Z][A-Z0-9]{2}$` — cualquier código de 3
caracteres que empiece por letra. La descripción oficial documenta los de infante: **`INF`**
(sin asiento, con adulto), **`INY`** (sin asiento, con _youth_), **`INS`** (con asiento asignado).
`CNN` (child) y `SRC` (senior) aparecen en la colección [V] y encajan en el patrón.

> ⚠️ **Conflicto abierto entre fuentes oficiales.** La lista de errores dice:
> `TRAVELER_TYPE_NOT_SUPPORTED` / `BAD_REQUEST`: «Infant traveler type (**INY, INS, INF**, ITS,
> ITF, INE, JNF) **currently not supported for NDC booking**.»
> Pero la colección ejercita **`INS` en NDC con AY (Finnair)** en dos requests
> (`Workflows / 28-33 / Seats - 1 Adult 1 Infant with seat | 1 Segment | AY` y `… 2 Adults 1
Infant with Seats | 2 Segments | AY`), y `BookTraveler` documenta los tres códigos sin reserva.
> **No se puede resolver sin sandbox.** Va a Preguntas abiertas. Hasta entonces, tratar el infante
> en NDC como **capacidad no garantizada por carrier**.

Otro error relevante: `TRAVELER_TYPE_MISMATCH` / `BAD_REQUEST` — «Traveler type in the request
does not match the one from priced offer». Es decir: **el `passengerCode` de `createBooking` debe
coincidir exactamente con el de `/offers/price`.** Si nuestro Package Studio deja cambiar un CNN
a ADT entre cotizar y reservar, falla.

#### 3.4.1 `travelers[].type` — no es un campo de request

⚠️ **Corrección.** La primera pasada lo listó como «enum paralelo a `passengerCode`, relación
desconocida» y lo dejó en la pregunta abierta 12. **Resuelto: `type` no existe en `BookTraveler`.**
Existe en **`Traveler`** (la respuesta) [VS] `:1740` como `TravelerTypeEnum` (`:9023`), con 12
valores: `ADULT`, `AGENT`, `AIRLINE`, `CHILD`, `EDUCATION`, `GOVERNMENT`, `GROUP`, `INFANT`,
`MILITARY`, `SENIOR`, `SPECIAL`, `YOUTH`.

Los 4 requests que lo envían son copy-paste de una respuesta. Confirmado por el **ejemplo oficial
de respuesta de createBooking**, que devuelve `"type": "ADULT"` junto a `"passengerCode": "ADT"`
(`help-documentation-create-booking-examples.txt:~985`). **`passengerCode` es el código de tarifa;
`type` es la clasificación normalizada que Sabre devuelve.**

#### 3.4.2 `identityDocuments[]` — `BookIdentityDocument` [VS] `:5553`

**Único `required`: `documentType`** (`:5556-5557`). Todo lo demás es condicional por carrier.

`DocumentTypeEnum` [VS] `:8979` tiene **17 valores**, no los 9 que la colección ejercita:
`PASSPORT`, `VISA`, `SECURE_FLIGHT_PASSENGER_DATA`, **`RESIDENCE_ADDRESS`**,
**`DESTINATION_ADDRESS`**, `KNOWN_TRAVELER_NUMBER`, `REDRESS_NUMBER`, **`ALIEN_RESIDENT`**,
**`PERMANENT_RESIDENT`**, `FACILITATION_DOCUMENT`, `NATIONAL_ID_CARD`, **`NEXUS_CARD`**,
**`MILITARY`**, **`NATURALIZATION_CERTIFICATE`**, `REFUGEE_REENTRY_PERMIT`,
**`BORDER_CROSSING_CARD`**, `FISCAL_ID`.

| Campo                                  | Contrato                                                 | Línea           | Nota                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentNumber`                       | string **`^[a-zA-Z0-9]+$`**                              | `:5559`         | **Sin guiones ni espacios.** Muchos DNI/CE LATAM los llevan → normalizar en el ACL                                                            |
| `documentType`                         | `DocumentTypeEnum`                                       | `:5564`         | **required**                                                                                                                                  |
| `documentSubType`                      | **`DocumentSubTypeEnum`: `RUC` \| `CUIT/CUIL` \| `NIT`** | `:5567`         | ⚠️ **Enum cerrado**, sólo con `FISCAL_ID`. [VS] `:9320`: RUC (Ecuador), CUIT/CUIL (Argentina), NIT (Bolivia). **Ver 3.4.2.1 — impacto LATAM** |
| **`visaType`**                         | `VisaTypeEnum`                                           | `:5570`         | **NUEVO.** Sólo con `documentType: VISA`                                                                                                      |
| **`passportType`**                     | `PassportTypeEnum`                                       | `:5574`         | **NUEVO.** Sólo con `PASSPORT`                                                                                                                |
| `expiryDate` / `issueDate`             | `format: date`                                           | `:5578`/`:5609` |                                                                                                                                               |
| `issuingCountryCode`                   | **`^[A-Z]{2,3}$`**                                       | `:5583`         | «**Not applicable to the `VISA` document type**»                                                                                              |
| `residenceCountryCode`                 | string, ISO-2 o ISO-3                                    | `:5589`         | ⚠️ «**For NDC bookings, only two-letter codes are allowed**»                                                                                  |
| `placeOfIssue`                         | `^[A-Z]{2,3}$`                                           | `:5594`         | Sólo `VISA`                                                                                                                                   |
| `placeOfBirth`                         | string, **maxLength 35**                                 | `:5599`         | Ej. `"LYON FR"`                                                                                                                               |
| `hostCountryCode`                      | `^[A-Z]{2,3}$`                                           | `:5604`         | Sólo `VISA`                                                                                                                                   |
| `givenName` / `middleName` / `surname` | string                                                   | `:5615`-`:5623` | ⚠️ `middleName`: «**NDC not supported**»                                                                                                      |
| `birthDate`                            | `format: date`                                           | `:5627`         |                                                                                                                                               |
| `gender`                               | `GenderEnum`                                             | `:5632`         | Ver abajo                                                                                                                                     |
| `isPrimaryDocumentHolder`              | boolean                                                  | `:5635`         | «primary passport holder of a document issued for **multiple travelers**»                                                                     |
| **`isLapChildDocument`**               | boolean                                                  | `:5639`         | **NUEVO.** Sólo combinable con `VISA`, `KNOWN_TRAVELER_NUMBER`, `REDRESS_NUMBER`, `RESIDENCE_ADDRESS`, `DESTINATION_ADDRESS`                  |
| **`residenceOrDestinationAddress`**    | `Address`                                                | `:5643`         | **NUEVO.** Para `RESIDENCE_ADDRESS` / `DESTINATION_ADDRESS` (requisito APIS de EE. UU.)                                                       |
| `flightIndices[]`                      | `integer[]`, min 1                                       | `:5646`         | 1-based. Restringe el documento a tramos concretos                                                                                            |
| `citizenshipCountryCode`               | `^[A-Z]{2,3}$`                                           | `:5655`         | Requisito BA                                                                                                                                  |

⚠️ **Se retira el riesgo [BAJO] 13 de la primera pasada.** Decía que `residenceCountryCode: "POL"`
(ISO-3) junto a `"PL"` (ISO-2) era una inconsistencia de los ejemplos. **El contrato admite las
dos**: `^[A-Z]{2,3}$`. La regla real, más fina, es: **ISO-3 vale en ATPCO; en NDC sólo ISO-2**
(`:5592`). El ACL debe normalizar a ISO-2 **cuando la variante es NDC**, no siempre.

`GenderEnum` [VS] `:9001` tiene **6 valores**, no 3: `FEMALE`, `MALE`, **`INFANT_FEMALE`**,
**`INFANT_MALE`**, **`UNDISCLOSED`**, `UNDEFINED`. Los dos de infante son los que exige Secure
Flight para lap children.

Errores oficiales del bloque: `MANDATORY_DATA_MISSING` («The airline requires information about
the country where the VISA document is valid» / «…about the issue date of the VISA document»),
`INVALID_IDENTITY_DOCUMENT` («Carrier does not support this identity document type»), y
«Citizenship country code is required under identity document for this carrier» (el de BA, §4).

##### 3.4.2.1 Impacto LATAM del `documentSubType` — **hallazgo nuevo y grave**

`DocumentSubTypeEnum` sólo admite **`RUC` (Ecuador), `CUIT/CUIL` (Argentina), `NIT` (Bolivia)**.

> **Nuestros tres mercados iniciales son Colombia, Perú y Brasil, y el enum no cubre ninguno con
> certeza.** No hay `CPF` ni `CNPJ` (Brasil). El `NIT` del enum está documentado como **boliviano**,
> no colombiano — usarlo para un NIT de Colombia es una apuesta. `RUC` está documentado como
> **ecuatoriano**; Perú también usa RUC, así que **podría** servir, pero el contrato no lo dice.
> Y `returnFiscalId` es un `extraFeature` que hay que **activar explícitamente**
> (`CommonExtraFeatures.returnFiscalId`, `:7434`, default `false`) sólo para **leerlo** en
> `getBooking`.
>
> La primera pasada marcaba `documentSubType` como «crítico para PE/CO» dando por hecho que
> bastaba. **No basta.** Esto bloquea la facturación electrónica DIAN (CO), SUNAT (PE) y NF-e (BR)
> por la vía del `identityDocuments`. Va a Preguntas abiertas y a Riesgos.

#### 3.4.3 `loyaltyPrograms[]` — `LoyaltyProgram` [VS] `booking-management-v1.yml:4470`

**Único `required`: `programNumber`** (`:4474`).

| Campo           | Contrato               | Línea   | Corrección                                                                                                                                                                                              |
| --------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supplierCode`  | string `^[A-Z0-9]{2}$` | `:4476` |                                                                                                                                                                                                         |
| `programType`   | `ProgramTypeEnum`      | `:4482` | **4 valores** (`:8968`): `FREQUENT_FLYER` (default), **`FREQUENT_RENTER`**, `LOYALTY_ID`, `CORPORATE_LOYALTY_ID`. ⚠️ `FREQUENT_RENTER` exige activar el `extraFeature` `returnFrequentRenter` (`:7425`) |
| `programNumber` | string                 | `:4486` | **required**                                                                                                                                                                                            |
| `tierLevel`     | **`integer` int32**    | `:4491` | ⚠️ **Resuelto:** es **entero**. Los ejemplos con `"1"` / `"17"` (string) violan el contrato. **Responde la pregunta abierta 10**                                                                        |
| `receiverCode`  | string `^[A-Z0-9]{2}$` | `:4497` | «Not sourced for NDC»                                                                                                                                                                                   |

Se pueden mandar **varios programas por pasajero** [V] (WF-15 manda AA + OM a cada uno), y el
ejemplo oficial de respuesta muestra el patrón real: **un mismo `programNumber` de `LO` repetido
con `receiverCode` distinto** (`LO`, `TK`, `SQ`) — es decir, **un objeto por carrier receptor**.
Ese patrón es exactamente lo que automatiza el nuevo `sendLoyaltiesToAllAirlines` (§3.1).

Límite oficial: `MAXIMUM_NUMBER_OF_LOYALTIES_EXCEEDED` / `BAD_REQUEST` — «A maximum of **five**
frequent renter loyalty programs is allowed **per car booking**».
Y `UNABLE_TO_ADD_SPECIAL_SERVICE_CODE_NOT_ALLOWED` — «Special services related to loyalty programs
are not allowed. Use the `loyaltyPrograms` parameter instead» (no mandar FF como SSR).

#### 3.4.4 `ancillaries[]` — `BookAncillary` [VS] `booking-management-v1.yml:7042`

> **[VS] Restricción de producto que la primera pasada no tenía:**
> «**Ancillary services are currently not supported for NDC bookings.**»
> — `help-documentation-create-booking.txt`
>
> Los 9 usos de la colección son todos ATPCO o LCC. **Un paquete NDC + equipaje de pago no se
> puede armar en una sola llamada.** Impacto directo en el Package Studio (M2).

**Siete campos `required`** [VS] `:7045-7052`: `subcode`, `airlineCode`,
`electronicMiscellaneousDocumentType`, `basePrice`, `currencyCode`, `groupCode`, `flightIndices`.

| Campo                                                         | Contrato                                                                          | Línea                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `subcode`                                                     | string **`^[A-Z0-9]{3}$`** (RFISC)                                                | `:7063`                                                                            |
| `airlineCode`                                                 | `^[A-Z0-9]{2}$` — «airline that **owns** the service»                             | `:7073`                                                                            |
| `vendorCode`                                                  | `^[A-Z0-9]{2}$` — «airline **providing**». **Mutuamente excluyente con `source`** | `:7079`                                                                            |
| `source`                                                      | `AncillarySourceEnum`. **Mutuamente excluyente con `vendorCode`**                 | `:7085`                                                                            |
| `electronicMiscellaneousDocumentType`                         | `ElectronicMiscellaneousDocumentTypeEnum`                                         | `:7088`                                                                            |
| `basePrice`                                                   | string `^[0-9]+(\.[0-9]{1,3})?$`                                                  | `:7097`                                                                            |
| **`totalPrice`**                                              | string, «total price **after taxation**»                                          | `:7092`                                                                            |
| `currencyCode`                                                | `^[A-Z]{3}$`                                                                      | `:7102`                                                                            |
| **`taxes[]`**                                                 | array de `Tax`, minItems 1 **maxItems 99**                                        | `:7107`                                                                            |
| **`numberOfItems`**                                           | integer, min 1, default 1                                                         | `:7116`                                                                            |
| **`firstTravelDate` / `lastTravelDate` / `purchaseDateTime`** | fechas ATPCO de validez                                                           | `:7123`/`:7130`/`:7137`                                                            |
| `specialServiceIndex`                                         | integer, min 1                                                                    | `:7143`                                                                            | **Required when booking ancillaries from low-cost carriers, such as `U2` or `FR`** |
| `groupCode`                                                   | `^[A-Z]{2}$`                                                                      | `:7151`                                                                            |
| `flightApplicabilityType`                                     | `Single` \| `Multiple` \| `Unknown`                                               | `:7158` — «required when `electronicMiscellaneousDocumentType` = `OTHER_THAN_EMD`» |
| `flightIndices[]`                                             | `integer[]`, minItems 1                                                           | `:7164`                                                                            |
| `commercialName`                                              | string                                                                            | `:7054`                                                                            |
| `reasonForIssuance`                                           | `ReasonForIssuanceEnum` (`:8692`)                                                 | `:7058`                                                                            |

⚠️ **Resuelto:** `reasonForIssuanceCode` + `reasonForIssuanceName` **no existen**. Sólo
`reasonForIssuance`. El único request que usa el par (`createBooking - Ancillaries baggage with
SSR`) manda campos que se descartan.

**El precio del ancillary lo sigue mandando el cliente** (`basePrice` + `currencyCode`
**required**), y ahora sabemos que además puede mandar `totalPrice` y hasta 99 `taxes[]`
desglosados. Sigue siendo un vector de discrepancia contra nuestro cache; el contrato no dice qué
pasa si difiere. Error asociado: `SPECIAL_SERVICE_INDEX_OUT_BOUNDS`.

### 3.5 Contacto — tres niveles, y el contrato aclara el orden

La primera pasada documentó bien los tres niveles a partir de los comentarios del propio request
`createBooking - contact information variants` [V]. El contrato **añade una regla de orden que no
estaba**:

> «Contains traveler's or agency contact information for the booking. Valid only with the phones
> and emails. **When adding phone numbers, please add agency contact number as a first item
> followed by the main contact number for the traveler.**»
> — [VS] `booking-management-v1.yml:754-758`

| Nivel    | Campo                                                     | Forma                                             | Semántica en el PNR                          |
| -------- | --------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Agencia  | `agency.contactInfo.phones[]` + `includePhoneLabel: true` | `string[]`, pattern `^[0-9+-]+$` [VS] `:1656`     | Teléfono de agencia, sufijo **`-A`**         |
| Pasajero | `travelers[].emails[]` / `travelers[].phones[]`           | `Phone` **objeto** `{number, label}` [VS] `:7006` | Asociado al pasajero **`-1.1`**              |
| Genérico | `contactInfo.emails[]` / `contactInfo.phones[]`           | **`string[]` planos** [VS] `:1582`                | Contacto de agencia genérico, sin asociación |

Confirmado por el contrato: la asimetría **es real**. `BookContactInformation.phones` es
`array<string>` con pattern `^[0-9+-]+$` (`:1591`); `travelers[].phones` es `array<Phone>` con
`number` **required** y `label` `^[A-Z]{1}$` (`:7006-7022`). `label`: `H` home, `B` business,
`C` cell, `M` mobile [VS] `:7017` — la primera pasada acertó los cuatro.

**Campos de `BookContactInformation` que la colección nunca usa** [VS]: **`faxes[]`** (`:1600`)
y **`emergencyPhones[]`** (`:1609`).

`AgencyContacts` [VS] `:1644`: `emails[]`, `phones[]`, `includePhoneLabel` (boolean,
**default `false`**). Nada más — no hay dirección de agencia aquí, esa vive en `agency.address`.

**Formato de teléfono — corrección parcial.** La primera pasada dejó abierto el formato
`"11234+15551239999789"` del requisito AF. El pattern del contrato `^[0-9+-]+$` **lo admite**
(sólo dígitos, `+` y `-`), así que no es inválido. Pero la guía oficial de errores es explícita:
`PHONE_COUNTRY_CODE_REQUIRED` / `BAD_REQUEST` — «Ensure that phone numbers follow the required
format: **`+(country code)-(phone number)`**». Es decir: **el formato canónico es `+57-3001234567`**,
y el ejemplo de AF es un artefacto legacy. **Nuestro ACL debe emitir `+CC-numero`.**
Errores relacionados: `TRAVELER_PHONE_MISSING`, `AGENCY_PHONE_MISSING`.

### 3.6 `agency` — `Agency` [VS] `booking-management-v1.yml:4733`

`Agency` = `GenericAgency` (`address`: `GenericAddress`; `contactInfo`: `AgencyContacts`) **más**:

| Campo                       | Contrato                                               | Línea   |
| --------------------------- | ------------------------------------------------------ | ------- |
| `ticketingPolicy`           | `TicketingPolicyEnum`                                  | `:4740` |
| **`futureTicketingPolicy`** | `FutureTicketingPolicy`                                | `:4743` |
| `ticketingTimeLimitPolicy`  | `TicketingTimeLimitPolicy`                             | `:4746` |
| `agencyCustomerNumber`      | string **`^[0-9A-Z]{6}([1-9A-Z*]{1}\|[0-9A-Z]{4})?$`** | `:4750` |

⚠️ **`TicketingPolicyEnum` tiene 4 valores** [VS] `:8742`, no 2: `TODAY`, **`ALREADY_TICKETED`**,
**`FUTURE_TICKETING`**, `TICKETING_TIME_LIMIT`.

⚠️ **`agencyCustomerNumber` (DK number): 6, 7 o 10 caracteres**, alfanumérico mayúscula, con
sufijo opcional. El valor `"1234567"` de los ejemplos son 7. Se confirma el hallazgo de la primera
pasada de que **no se puede borrar** (`delete DKNumber/agencyCustomerNumber - not supported` [V]).

**`FutureTicketingPolicy`** [VS] `:4767` es **nuevo** y directamente relevante para el consolidador:
`ticketingPcc` (`^[A-Z0-9]{3,4}$`), `queueNumber`, `ticketingDate`, `ticketingTime`, `comment`.

> **Esto es el gancho de arquitectura del modelo consolidador que faltaba:** permite **reservar
> en el PCC de la sub-agencia y programar la emisión en el PCC de ticketing del consolidador,
> encolada**. Combinado con `targetPcc` (§3.1) y `notification.queuePlacement` (§3.12), da un
> flujo BYOC completo: la agencia reserva, el consolidador emite. Se propaga a
> `docs/platform/12-modelo-consolidador-y-plan.md`.

`TicketingTimeLimitPolicy` [VS] `:4890`: `airlineCode`, `ticketingDate` (`format: date`),
`ticketingTime` (`HH:MM`). «Used by travel agencies to request the **first airline in the air
booking** to issue the tickets.»

Errores oficiales del bloque, todos `BAD_REQUEST`: `AGENCY_ADDRESS_MISSING` («Agency address is
needed to complete **traditional** booking»), `AGENCY_PHONE_MISSING`, `AGENCY_EMAIL_ISSUE` («The
airline requires agency email information to proceed»), **`DUPLICATED_AGENCY_ADDRESS`** («Agency
address can be submitted **either** in request payload **or** in a profile»).

> **Regla dura derivada:** en ATPCO, `agency.address` es **obligatorio**; y si además se usa
> `profiles[]` con un perfil que trae dirección, **hay que omitirla del payload** o el request
> falla. Nuestro ACL necesita saber si el perfil aporta dirección antes de construir el body.

### 3.7 `payment` — `Payment` [VS] `booking-management-v1.yml:5700`

Dos propiedades: `billingAddress` (`GenericAddress`, «**Only one billing address is allowed per
booking**», `:5704`) y `formsOfPayment[]` (array de `FormOfPayment`, **minItems 1, maxItems 10**,
`:5708`).

#### 3.7.1 Catálogo real de `formsOfPayment[].type`

`FormOfPaymentTypeEnum` [VS] `booking-management-v1.yml:8792` tiene **14 valores**, no 10. Y —
esto es lo decisivo — **la propia descripción del enum dice para qué sirve cada uno**:

| `type`                          | Ámbito según el contrato                                                         | Campos propios                                                                                                                                            | Visto en createBooking |
| ------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `PAYMENTCARD`                   | Universal                                                                        | `cardTypeCode`, `cardNumber`, `cardSecurityCode`, `expiryDate`, `cardHolder`, `manualApproval`, `authentications[]`, `corporateId`, `isAgencyPaymentCard` | 36                     |
| **`CASH`**                      | **Universal — sin campos**                                                       | ninguno                                                                                                                                                   | **8**                  |
| `CHECK`                         | Universal                                                                        | ninguno                                                                                                                                                   | 2                      |
| `MISCELLANEOUS`                 | «must be activated on the agency level; requires a specific payment credit code» | `miscellaneousCreditCode` (2–18), `extendedPayment`                                                                                                       | 1                      |
| `INSTALLMENTS`                  | «**BSP Brazil customers only** — parcelado»                                      | `numberOfInstallments` (1–96), `airlinePlanCode`, `installmentAmount`, `netBalance`                                                                       | 1                      |
| `VIRTUAL_CARD`                  | **«used for hotel bookings»**                                                    | `virtualCard{}`                                                                                                                                           | 3                      |
| `AGENCY_NAME`                   | **«used for hotel bookings»**                                                    | `agencyAddress{}`                                                                                                                                         | 3                      |
| `AGENCY_IATA`                   | **«used for hotel bookings»**                                                    | `agencyIataNumber` (1–12)                                                                                                                                 | 3                      |
| `CORPORATE`                     | **«used for hotel bookings»**                                                    | `corporateId`                                                                                                                                             | 4                      |
| `COMPANY_NAME`                  | **«used for hotel bookings»**                                                    | `companyAddress{}`                                                                                                                                        | 3                      |
| **`VOUCHER`**                   | **«used for vehicle booking»**                                                   | `voucher{billingNumber, type}`                                                                                                                            | 0                      |
| **`DOCKET`**                    | Universal (wallet)                                                               | `docketPrefix` (`^D$\|^AGT\*V$`), `docketNumber` (`^[0-9]{6}$`), `docketIssuingAgentInitials`, `docketDescription`                                        | 0                      |
| **`GOVERNMENT_TRAVEL_REQUEST`** | Universal (wallet)                                                               | `governmentTravelRequestDescription`                                                                                                                      | 0                      |
| **`INVOICE`**                   | Universal (wallet)                                                               | `invoiceDescription`, `addInvoiceDescriptionPrefix`                                                                                                       | 0                      |

⚠️ **Corrección directa a la recomendación de la primera pasada (hallazgo 7 del crítico,
aceptado y ampliado).** La primera pasada recomendaba **`AGENCY_IATA`** como forma de pago de
arranque para el canal aéreo B2B. **Es incorrecta por dos vías independientes:**

1. **Evidencia de la colección:** `AGENCY_IATA` aparece en 6 requests, **todos** bajo
   `Create Booking / CSL Hotel/*` o `ModifyBooking / Hotel modification flows/*`. Cero en un
   createBooking aéreo puro y cero en `fulfillFlightTickets`. Igual `VIRTUAL_CARD`.
2. **Evidencia del contrato, que es concluyente:** el propio enum dice «`VIRTUAL_CARD`,
   `AGENCY_NAME`, `AGENCY_IATA`, `CORPORATE`, `COMPANY_NAME` are used for **hotel** bookings»
   (`:8795-8798`), y `HotelToBook.formOfPayment` repite la lista de FOP aplicables a hotel
   (`:5070-5071`). Además **`FulfillFormOfPaymentTypeEnum`** (`:8659`), que es lo que acepta la
   **emisión de billete**, **no incluye `AGENCY_IATA`**.

**La forma de pago sin PAN del carril aéreo es `CASH`.** Ver §7.

**Campos nuevos de `GenericFormOfPayment`** [VS] `:5398` que la primera pasada no tenía:
`useType` / `useTypes[]` (`FormOfPaymentUseTypeEnum`, 15 valores: `All`, `Ancillary`, `Airline`,
`Car`, `Hotel`, `Low-Cost Carrier`, `Interface Record`…), `tripType` / `tripTypes[]`
(`Corporate/Business`, `Leisure`, `Emergency`, `Family`, `Group`…), `isAgencyPaymentCard`.

> **`useTypes[]` es relevante para el multi-producto:** permite decir «esta FOP es para el hotel,
> aquella para el vuelo» sin depender sólo de los índices. Los `useType`/`tripType` singulares
> están marcados como **deprecados** en el propio contrato (`:5472`, `:5477`).
> Errores: `INVALID_COMBINATION` — «The `useType: Interface Record` is only allowed for payment
> type `PAYMENTCARD`» y «…cannot be combined with other useTypes».

#### 3.7.2 Formatos de tarjeta — **`expiryDate` resuelto**

`BasicFormOfPayment` [VS] `:5305`:

| Campo              | Pattern                                      | Línea   |
| ------------------ | -------------------------------------------- | ------- |
| `cardTypeCode`     | `^[A-Z]{2}$`                                 | `:5309` |
| `cardNumber`       | **`^[0-9]{12,19}\|([0-9]X{7,14}[0-9]{4})$`** | `:5314` |
| `cardSecurityCode` | `^[0-9]{3,4}$`                               | `:5319` |
| `expiryDate`       | **`^(20)\d\d-(0[1-9]\|1[012])$`**            | `:5324` |
| `extendedPayment`  | integer 1–96 (meses)                         | `:5329` |

⚠️ **`expiryDate` es `YYYY-MM`** (ej. `2024-07`). No `MMYY`, no `MM/YY`. **Responde la pregunta
abierta de la primera pasada.** Error asociado: `UNABLE_TO_ADD_FORM_OF_PAYMENT_EXPIRY_DATE`.

⚠️ **`cardNumber` admite una forma ENMASCARADA**: la segunda alternativa del pattern,
`[0-9]X{7,14}[0-9]{4}`, es «primer dígito + X's + últimos 4». Es decir: **Sabre acepta que le
devuelvas el PAN enmascarado tal cual lo entregó**. Esto matiza —sin anularlo— el riesgo 2 de la
primera pasada: el ciclo modify **no obliga necesariamente** a reinyectar el PAN completo; el
script de la colección que lo hace (`jsonData.payments.formsOfPayment[0].cardNumber =
pm.environment.get('creditCardNumber')`) es **una opción, no un requisito del contrato**.
La vía documentada para trabajar con datos desenmascarados es `unmaskPaymentCardNumbers` en
`modifyBooking` (`:878`), que además **exige el keyword `CCVIEW` en el EPR**. **[?]** Falta
confirmar en sandbox si un `modifyBooking` con el PAN enmascarado tal cual pasa la verificación
de `bookingSignature`.

Errores de tarjeta: `UNABLE_TO_ADD_FORM_OF_PAYMENT_INVALID_CARD_NUMBER`,
`…_INVALID_CARD_NUMBER_LENGTH`, `…_CHECK_CODE`, `…_EXTENDED_PAYMENT` («Extended payment is not
allowed. Check your agency settings»).

#### 3.7.3 `authentications[]` — SCA / PSD2 [VS] `StrongCustomerAuthentication:6407`

**17 campos**, minItems 1 **maxItems 10** (`:5411`), «For use with `PAYMENTCARD`»:
`secureAuthenticationValue`, `secureTransactionId`, **`issueCode`**, `resultCode`,
`cardNumberCollectionCode`, **`channelCode`**, `electronicCommerceIndicator`, `exemptionTypeCode`,
`updatedDateTime`, `mandateTypeCode`, `merchantName`, `originalPaymentReference`, `amount`,
`currencyCode`, `tokenAuthenticationValue`, `verificationResultCode`, `version`.

⚠️ El ejemplo oficial escribe **`issuesCode`**; el contrato dice **`issueCode`** (`:6420`). El
ejemplo está mal.

**`channelCode`** [VS] `:6438`, `^[A-Z0-9]{2}$`: `MO` Mail Order, `TO` Telephone Order, `EC`
ECOM, `FA` Face to Face. Es el campo que la guía de fulfill declara **obligatorio para emitir NDC
con tarjeta** (§7).

⚠️ **`originalPaymentReference` NO es un token de tarjeta.** [VS] `:6473`: «The identifier of the
**authorization (Authorization Trace ID/Authorization Trans ID)** request when performed by the
booking agent… returned from the initial authorization response». La primera pasada la señalaba
como «puerta de entrada más plausible a un flujo sin PAN» y observaba que en el ejemplo valía el
mismo `{{creditCardNumber}}`. **El contrato zanja la duda: es un identificador de autorización,
no una referencia tokenizada. El ejemplo está mal, y la hipótesis de tokenización por esta vía
queda descartada.**

#### 3.7.4 La única referencia tokenizada real del producto — **hallazgo nuevo**

`FulfillFormOfPayment.referenceId` [VS] `booking-management-v1.yml:7521`:

> «The ID of the **stored wallet form of payment** referenced by `itemId` obtained from the Get
> Booking response.» — string, `^[A-Z0-9]+$`

Y `CommonExtraFeatures.returnWalletFormsOfPayment` [VS] `:7429`: «If `true`, returns the following
additional forms of payment — `DOCKET`, `GOVERNMENT_TRAVEL_REQUEST`, `INVOICE` and `ON_ACCOUNT`.»

> **Existe un "wallet" de formas de pago del lado de Sabre, direccionable por `itemId`, y
> `fulfillFlightTickets` puede emitir contra él sin volver a enviar datos de tarjeta.** Es la
> única mecánica de referencia-en-lugar-de-dato que aparece en todo el contrato. La primera pasada
> afirmaba «no hay, en toda la colección, **ni un solo ejemplo** de una referencia a una tarjeta
> previamente almacenada en Sabre» — cierto para la **colección**, **falso para el contrato**.
> ⚠️ **Pero `referenceId` está en `FulfillFormOfPayment`, NO en el `FormOfPayment` de
> `createBooking`.** No sirve para crear la reserva; sirve para emitir. Y **[?]** no sabemos cómo
> entra una tarjeta en ese wallet (probablemente por PNR previo o por perfil), lo cual podría
> devolvernos al scope PCI por la puerta de atrás. Va a Preguntas abiertas.

### 3.8 `hotel` y `car`

**`HotelToBook`** [VS] `:5020` — **`bookingKey` required** (`:5024`; propiedad en `:5032`, minLength 1 **maxLength 240**,
«returned in the Hotel Price Check API response»).

| Campo                         | Contrato                                                                                                                  | Línea   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `useCsl`                      | boolean, **default `true`**                                                                                               | `:5026` |
| `corporateDiscountCode`       | **integer** int32, min 1                                                                                                  | `:5039` |
| `rooms[]`                     | array de `RoomToBook`, minItems 1 **maxItems 99**. «Multiple room bookings are **currently not supported by GDS hotels**» | `:5046` |
| `specialInstruction`          | string (**singular**)                                                                                                     | `:5054` |
| `paymentPolicy`               | `HotelPaymentPolicyEnum`                                                                                                  | `:5058` |
| `formOfPayment`               | integer 1–11                                                                                                              | `:5064` |
| **`associatedFlightDetails`** | `AssociatedFlightDetails`                                                                                                 | `:5072` |

⚠️ **`useCsl` es la grafía correcta** (`useCSL` se ignora), y su **default ya es `true`** — no hay
que mandarlo. Además: «**Legacy content has been blocked in Sabre due to the migration to CSL
content only**» (`help-documentation-create-booking.txt`). **`useCsl: false` está muerto.**

**`paymentPolicy`** [VS] `:5060-5063` — la descripción es crítica para §7:

> «`DEPOSIT` can only be used with **credit card, agency, or corporate**. `GUARANTEE` can only be
> used with **credit card, agency, IATA, company, or corporate**. When using **`LATE`** payment
> **do not indicate `formOfPayment`** as this method (supported by some hotel suppliers) allows
> customers to **make a booking without any form of payment**.»

> **`paymentPolicy: LATE` es una reserva de hotel PAN-free confirmada por contrato.** Es la
> pieza que faltaba para el carril hotelero de la opción A de §7.

`RoomToBook` [VS] `:5076`: `isSmoking` (default `false`), `bedTypeCode` (integer, OTA Code Table
BED), `physicalDisabilityCode` (integer, OTA PHY), `roomExtras[]`, `travelerIndices[]` («**the
first traveler will be considered the lead guest**»).
`RoomExtra` [VS] `:5114`: **`roomExtraType` required** — `26` Crib, `91` Roll-away Bed,
`196` Extra Person; `quantity` (default 1); `amount`.

**`CarToBook`** [VS] `:7175` — **`bookingKey` required**. Campos: `travelerIndex`,
**`emailIndex`** (nuevo: qué email del traveler se comparte con el proveedor), `collectionAddress`,
**`collectionSite`** (`CarRentalSite`), `deliveryAddress`, `deliverySite`,
`associatedFlightDetails` (`AssociatedArrivalFlight`).

⚠️ Se confirma la asimetría: hotel usa **`specialInstruction`** (singular), coche
**`specialInstructions`** (plural). No es un typo de los ejemplos: es el contrato.

Errores de hotel destacados: `UNABLE_TO_BOOK_HOTEL_NO_DATA_FOR_BOOKING_KEY` /
`…_CANNOT_DECRYPT_BOOKING_KEY` / `…_MATCHING_RATE_NOT_FOUND` (los tres piden **regenerar el
booking key con HotelPriceCheck** → el key **caduca**),
`UNABLE_TO_BOOK_HOTEL_FORM_OF_PAYMENT_NOT_SUPPORTED`, `…_INVALID_FORM_OF_PAYMENT`,
`…_LATE_PAYMENT_NOT_SUPPORTED`, `…_WRONG_PAYMENT_POLICY`, `…_PAYMENT_CARD_NOT_ACCEPTED`.

### 3.9 `remarks` y `otherServices` (OSI)

⚠️ **`RemarkTypeEnum` tiene 14 valores** [VS] `:9094`, no 2: `GENERAL`, `HISTORICAL`,
`CLIENT_ADDRESS`, `ALPHA_CODED`, `DELIVERY_ADDRESS`, `ITINERARY`, `INVOICE`, `HIDDEN`,
`CORPORATE`, `FORM_OF_PAYMENT`, `PRINT_ON_TICKET`, `FILLER_STRIP`, `INTERFACE`, `QUEUE_PLACE`.

**Cuatro NO están soportados** [VS] `:6044-6046`: «`PRINT_ON_TICKET`, `FILLER_STRIP`, `INTERFACE`,
and `FORM_OF_PAYMENT` remark types are **currently not supported**. The `FORM_OF_PAYMENT` remark
type is **automatically added** to a booking upon populating the `formsOfPayment` array.»

**`BookRemark` = `Remark` + `queuePlacement`** (`Queue`, para el tipo `QUEUE_PLACE`, `:6051`).
`Queue` [VS] `:4552`: `queueNumber` (0–999), `queueName`, `pcc`, **`prefatoryInstructionCode`
(required, 0–254)**, `futureQueuePlacementDate`.

> **`remarks[{type:"QUEUE_PLACE"}]` + `futureQueuePlacementDate` permite programar el PNR a una
> cola en una fecha futura.** Otro gancho del flujo consolidador (revisión antes de emitir).

`otherServices[]` es **OSI** [V] (`Workflows / 23 - NDC - OSI remarks`). `OtherServiceInformation`
[VS] `:1517` = `CommonOtherServiceInformation` + `chainCode` (hotel) + `vendorCode` (coche) —
pero el propio `CreateBookingRequest` avisa: «**Not supported for hotel chains and/or car rental
vendors**» (`:777`). Los dos campos son de lectura en `getBooking`, no de escritura aquí.

### 3.10 Retention segment (OTH) — **corrección de formato**

⚠️ **`retentionEndDate` es `format: date`**, es decir **`YYYY-MM-DD`** [VS] `:781-785`, con
ejemplo `'2024-01-30'`. **NO es ISO-8601 con hora.**

La primera pasada concluyó lo contrario a partir del pre-request script
`pm.environment.set("OTH_date", new Date(Date.now() + 300*24*60*60*1000).toISOString())`, que
produce `2027-06-21T...Z`. **El script de Postman envía un valor que el contrato no declara.**
Puede que Sabre trunque; puede que falle. **Nuestro ACL debe emitir `YYYY-MM-DD`.**
Esto **responde la pregunta abierta 13** de la primera pasada, en el sentido contrario al que se
había inferido.

`retentionLabel`: `^[a-zA-Z0-9 ,.*?\-\/]{0,215}$` [VS] `:787`. **Sin acentos ni ñ.**

Errores oficiales: `RETENTION_DATE_MISSING`, `INVALID_RETENTION_DATE` («cannot be in the past»),
**`INVALID_RETENTION_DATE_RANGE`** («The retention date exceeds the acceptable date range. Select
the date no later than %s») → **hay un techo, es dinámico, y el API lo dice en el mensaje.** Los
300 días del script son una convención del ejemplo, no el límite.

Sigue siendo cierto y valioso: puede ir **sin ningún producto** (crea un PNR que sólo retiene el
localizador). Encaja con el flujo «cotización reservada sin emitir» del Package Studio.

### 3.11 `profiles` — `BookProfile` [VS] `booking-management-v1.yml:6075`

**Required: `profileTypeCode` + `domainId`** (`:6080-6082`). Array **minItems 1, maxItems 13**
(`:723`).

| Campo             | Contrato                                                                 | Línea   |
| ----------------- | ------------------------------------------------------------------------ | ------- |
| `profileName`     | string. **No combinable con `uniqueId`**                                 | `:6084` |
| `profileTypeCode` | string **maxLength 3**                                                   | `:6089` |
| `uniqueId`        | string. **No combinable con `profileName`**                              | `:6095` |
| `domainId`        | string — «typically the user PCC, but can be a customer-specific domain» | `:6100` |
| **`filterId`**    | string — «predefined subset of profile data»                             | `:6104` |

`profileTypeCode` es **maxLength 3 libre**, no un enum: la primera pasada sólo vio `TVL`, y
`CRP`/`AGY` son [I] pero el patrón los admite. La descripción confirma el propósito: «Based on
`profileTypeCode`, profile data may provide **traveler, agency, or corporate** details».

> Un perfil se carga «into the active session (**AAA**)». Combinado con §1.1 (createBooking limpia
> la AAA antes y después), significa que **el perfil se carga y se descarta dentro de la misma
> llamada**. No hay estado persistente entre llamadas por esta vía.

### 3.12 `notification` — bloque nuevo [VS] `booking-management-v1.yml:4533` (`Notification`)

«Contains actions to be performed after the booking creation. **Currently, you can choose either
`queuePlacement` or email notification. It is not possible to combine both.** Additionally, for
booking creation purposes, **only `DEFAULT` e-mail notification is supported**» (`:770-774`).

- `email`: `NotificationEmailEnum` (`:8954`) — **6 valores**: `DEFAULT`, `INVOICE`, `ETICKET`,
  **`ETICKET_PDF`**, `ITINERARY`, **`ITINERARY_PDF`**. En creación **sólo `DEFAULT` está soportado**.
  Error si se usa otro: `EMAIL_METHOD_NOT_SUPPORTED` / `BAD_REQUEST`.
- `queuePlacement[]`: array de `NotificationQueue`, minItems 1 **maxItems 3**.
  Errores: `INVALID_RECURRENT_QUEUE_IDENTIFIER_NUMBER` («select a queue number between **0 and
  511**»), `INVALID_QUEUE_TEXT_LENGTH_EXCEEDED`.

> **Cero uso en la colección.** Es el mecanismo nativo de Sabre para «avisar al consolidador de
> que hay un PNR pendiente de emitir». Alternativa a construirlo nosotros con webhooks.

---

## 4. Requisitos por aerolínea — la tabla que evita fallos en producción

Estos requisitos están **codificados como workflows separados** en la colección (señal fuerte: no
se crea un workflow entero para un campo opcional) y ahora, además, **varios tienen un error
oficial dedicado** en `help-documentation-create-booking-error-list.txt`, que es la confirmación
definitiva.

| Aerolínea                     | Campo obligatorio                                                                                                          | Dónde va             | Evidencia                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BA** (British Airways)      | `identityDocuments[].citizenshipCountryCode` **+** `travelers[].title`                                                     | traveler / documento | [V] `Workflows / 24` + **[VS] error oficial** `INVALID_IDENTITY_DOCUMENT` / `APPLICATION_ERROR`: «**Citizenship country code is required under identity document for this carrier**»          |
| **AF** (Air France)           | `agency.contactInfo.phones[]` con `includePhoneLabel: true`                                                                | agencia              | [V] `Workflows / 25` + [VS] errores `AGENCY_PHONE_MISSING` y `AGENCY_EMAIL_ISSUE`                                                                                                             |
| **AA** (American)             | `loyaltyPrograms[].programType: "CORPORATE_LOYALTY_ID"` para tarifas corporativas                                          | traveler             | [V] `createBooking - Air NDC - Corporate Loyalty Id` + [VS] `ProgramTypeEnum:8968`                                                                                                            |
| **Hawaiian (HA)**             | **`travelers[].useNotificationContactType: true`**                                                                         | traveler             | **[VS] NUEVO** `booking-management-v1.yml:6213`: «Required by some airlines (e.g., Hawaiian)» + error `NOTIFICATION_CONTACT_TYPE_REQUIRED`                                                    |
| **Mercados con ID fiscal**    | `identityDocuments[]` con `documentType: "FISCAL_ID"` + `documentSubType`                                                  | traveler             | [V] `createBooking - Air NDC - fiscal Id` + [VS] `DocumentSubTypeEnum:9320`. ⚠️ **Sólo `RUC`/`CUIT-CUIL`/`NIT`** — ver §3.4.2.1                                                               |
| **QR, LO, AY** (asientos NDC) | `flightOffer.seatOffers[].seatOfferId`                                                                                     | flightOffer          | [V] `Workflows / 28-33` + [VS] error `SEATS_OFFER_ID_MISSING`                                                                                                                                 |
| **AA, QF, UA, QR, SQ**        | Baterías de `identityDocuments` (PASSPORT + VISA + KTN + REDRESS + SFPD) y `loyaltyPrograms` duplicados por `receiverCode` | traveler             | [V] `Workflows / 15 - NDC All supported airlines`                                                                                                                                             |
| **AY** (Finnair)              | `passengerCode: "INS"` para infante **con** asiento                                                                        | traveler             | [V] `Workflows / 28-33 / Seats - 1 Adult 1 Infant with seat \| 1 Segment \| AY`. ⚠️ **En conflicto con el error oficial `TRAVELER_TYPE_NOT_SUPPORTED`** — ver §3.4.0                          |
| **Cualquiera con VISA**       | `hostCountryCode` **+** `issueDate` del visado                                                                             | documento            | **[VS] NUEVO** errores `MANDATORY_DATA_MISSING`: «The airline requires information about **the country where the VISA document is valid**» / «…about **the issue date** of the VISA document» |

### 4.1 Detalle BA — el ejemplo completo

```jsonc
{
  "flightOffer": {
    "offerId": "{{price_offer_id}}",
    "selectedOfferItems": ["{{price_offer_item_id}}"],
  },
  "travelers": [
    {
      "id": "{{price_passenger_id1}}",
      "title": "Congressman", // ← requisito BA — VÁLIDO: TitleEnum lo incluye
      "givenName": "Jack",
      "surname": "Smith",
      "birthDate": "1972-03-23",
      "passengerCode": "ADT",
      "identityDocuments": [
        {
          "documentNumber": "…",
          "documentType": "PASSPORT",
          "expiryDate": "{{identityDocumentExpiryDate}}",
          "issuingCountryCode": "GB",
          "residenceCountryCode": "PL",
          "citizenshipCountryCode": "US", // ← requisito BA
          "givenName": "Jack",
          "surname": "Smith",
          "birthDate": "1972-03-23",
          "gender": "MALE",
        },
      ],
    },
  ],
  "agency": { "contactInfo": { "emails": ["agency@sabre.com"] } },
  "contactInfo": { "emails": ["travel@sabre.com"], "phones": ["123456"] },
}
```

**Los tres códigos de país son independientes y pueden diferir**: `issuingCountryCode: GB`,
`residenceCountryCode: PL`, `citizenshipCountryCode: US`. [V] confirmado por las aserciones:

```js
pm.expect(jsonData.booking.travelers[0].identityDocuments[0].issuingCountryCode).is.eql('GB');
pm.expect(jsonData.booking.travelers[0].identityDocuments[0].residenceCountryCode).is.eql('PL');
pm.expect(jsonData.booking.travelers[0].identityDocuments[0].citizenshipCountryCode).is.eql('US');
```

Y [VS] los tres son propiedades distintas de `BookIdentityDocument` (`:5583`, `:5589`, `:5655`).
Nuestro dominio hoy sólo modela dos de los tres (§8). ⚠️ El `title` **ya no es un problema de
enum abierto**: basta con adoptar `TitleEnum` (18 valores) tal cual.

### 4.2 Detalle AF

```jsonc
"agency": {
  "contactInfo": {
    "emails": ["agency@sabre.com"],
    "phones": ["11234+15551239999789", "11234+15551238888222"],
    "includePhoneLabel": true
  }
}
```

⚠️ **Corrección parcial.** El formato `"11234+15551239999789"` **no viola el contrato** (pattern
`^[0-9+-]+$`), pero **tampoco es el formato canónico**. La guía oficial de errores fija
`+(country code)-(phone number)` (`PHONE_COUNTRY_CODE_REQUIRED`). Interpretación: el ejemplo es
legacy y el ACL debe emitir **`+33-155512399`**. Sigue **[?]** si AF acepta las dos formas.

---

## 5. Manejo de errores y éxito parcial — **corrección mayor**

### 5.1 `errorHandlingPolicy` SÍ existe en `createBooking`

⚠️ **La primera pasada afirmaba lo contrario, en negrita, y construyó §5 entera sobre esa premisa
falsa.** El texto retirado era: «Tampoco existe `errorHandlingPolicy` en `createBooking`: ese campo
es de `cancelBooking`». **Falso.**

**[VS] `CreateBookingRequest.errorHandlingPolicy`** — `booking-management-v1.yml:698-702`, es un
**array** de `CreateErrorPolicyEnum` (`:8918`), **default `HALT_ON_ERROR`**, con **8 valores**:

| Valor                                           | Efecto                                                         |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `HALT_ON_ERROR`                                 | **Default.** Para ante cualquier error de un servicio downline |
| `DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR`           | Sigue si falla el pricing (**sólo ATPCO**)                     |
| `DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR`            | Sigue si falla el hotel                                        |
| `DO_NOT_HALT_ON_CAR_BOOKING_ERROR`              | Sigue si falla el coche                                        |
| `DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR`        | Sigue si falla un ancillary                                    |
| `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`             | Sigue si falla un asiento                                      |
| `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR` | **Para** si no se cumple el MCT (**sólo ATPCO**)               |
| `DO_NOT_HALT_ON_IDENTITY_DOCUMENT_WARNING`      | Sigue ante warning de documento (**sólo NDC**)                 |

> **Esto cambia el diseño del ACL.** El éxito parcial en `createBooking` no es un accidente que
> hay que detectar a posteriori: es un **modo de operación que el cliente elige, por dominio de
> producto, antes de llamar**. Es un array: se pueden combinar varias tolerancias.

**Recomendación de configuración por variante** (decisión de producto, ver `decisionsNeeded`):

- **Vuelo suelto (venta directa):** dejar `HALT_ON_ERROR`. Un vuelo a medias no es vendible.
- **Vuelo + asiento:** `["DO_NOT_HALT_ON_SEAT_BOOKING_ERROR"]`. Perder el 12A no debe tumbar la
  venta; el asiento se reintenta después con `modifyBooking`.
- **Paquete multi-producto (Package Studio):** `["DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR",
"DO_NOT_HALT_ON_CAR_BOOKING_ERROR", "DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR",
"DO_NOT_HALT_ON_SEAT_BOOKING_ERROR"]` **+** `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR`,
  y compensación Temporal por ítem.
- **Nunca** `DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR` sin revisión: deja el PNR sin price quote y el
  billete puede acabar emitiéndose a otra tarifa.

**`haltOnError` sigue sin existir en el REST.** Se buscó de nuevo: aparece 4 veces, siempre como
atributo del SOAP `PassengerDetailsRQ haltOnError="true" ignoreOnError="true"` [V]. La primera
pasada acertó en esto. No confundir con `errorHandlingPolicy`.

### 5.2 `haltOnFlightStatusCodes` — default confirmado

**[VS]** `booking-management-v1.yml:5004-5010`:

> «Lists optional flight status codes considered unacceptable… **If no status codes are provided,
> the system will automatically stop processing when encountering `NO`, `UC`, `US`, `UN`, `UU`,
> `LL`, or `HL`.**»

> **Responde la pregunta abierta 11 de la primera pasada.** La lista de 7 códigos del request de
> Wakanow **es exactamente el default**. Mandarla es redundante. `["NN"]` (en
> `createBooking - Air with custom haltOnStatus`) **sustituye** el default, no lo amplía: aborta
> con _need_ pero **acepta** `UC`/`UN`. Contraintuitivo y peligroso.

`HaltOnFlightStatusCodeEnum` [VS] `:8777` — **8 valores**: `NO`, `NN`, `UC`, `US`, `UN`, `UU`,
`LL`, `HL`. ⚠️ **`YK` (pasiva confirmada) NO está en el enum**, aunque sí es un valor válido de
`flightStatusCode` en el request. No se puede abortar por `YK`.

`retryBookingUnconfirmedFlights` [VS] `:5011-5018`: «the system will **cancel** them and **rebook
them in the lowest available fare**… **may result in a price increase**».

> ⚠️ **Bandera roja de negocio.** `retryBookingUnconfirmedFlights: true` puede **cambiar el precio
> de la reserva sin avisar**. Nunca activarlo sin combinarlo con
> `flightPricing[].priceComparisons[]` (§3.3.2), que es el único freno de precio del endpoint.
> El request de la colección que lo usa (`Ancillary Modifications / Add ancillaries /
CreateBooking`) **no lleva `priceComparisons`** [V].

#### 5.2.1 El control de éxito parcial del carril SOAP — `haltOnAirPriceError` / `haltOnHotelBookError`

Los tres controles anteriores (`errorHandlingPolicy`, `haltOnFlightStatusCodes`,
`retryBookingUnconfirmedFlights`) son del carril **REST**. El carril **SOAP/LLS** tiene el suyo
propio, y hay que documentarlo aquí porque decide exactamente lo mismo: **si una reserva queda a
medias**. Son dos **atributos del elemento raíz** de `UpdatePassengerNameRecordRQ` 1.1.0 — el
mensaje con el que se añade un segmento de hotel CSL a un PNR ya existente (§9, y
`07-hoteles-y-autos.md` §6.3).

| Atributo               | Dónde                                       | Semántica                                                                                                                                                                     | Marca                                            | Valor por defecto          |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `haltOnAirPriceError`  | atributo de `<UpdatePassengerNameRecordRQ>` | Si `"true"`, aborta toda la transacción cuando falla la **cotización del aire** del PNR. Si `"false"`, continúa y deja el aire sin re-cotizar                                 | **[V]** el atributo; **[I]** la semántica exacta | **DESCONOCIDO** — ver nota |
| `haltOnHotelBookError` | idem                                        | Si `"true"`, aborta toda la transacción cuando falla la **reserva del hotel**. Si `"false"`, el `EndTransaction` se ejecuta igual y el PNR queda **sin el segmento de hotel** | **[V]** el atributo; **[I]** la semántica exacta | **DESCONOCIDO** — ver nota |

**[V]** Los tres únicos usos de la colección son
`ModifyBooking (various workflows) / Flight modification flows / Form of Payment modifications
(Hybrid) / {Add,Update,Delete} FOP / UpdatePassengerNameRecordRQ 1.1.0 - add CSL hotel segment`:

```xml
<!-- Add FOP -->
<UpdatePassengerNameRecordRQ version="1.1.0"
    haltOnAirPriceError="false" haltOnHotelBookError="true">
<!-- Update FOP y Delete FOP -->
<UpdatePassengerNameRecordRQ version="1.1.0" targetCity="G7HE"
    haltOnAirPriceError="false" haltOnHotelBookError="false">
```

> **DESCONOCIDO — el valor por defecto no está en ninguna fuente disponible.** No hay contrato
> OpenAPI del carril SOAP/LLS (`00-fuentes.md`, pregunta abierta 2) y las 81 páginas oficiales no
> mencionan estos atributos: `grep haltOnAirPriceError` sobre los 21 `.yml` y sobre `specs/help/`
> devuelve **0 resultados**. Los tres requests los declaran **siempre de forma explícita**, así que
> ni siquiera se puede inferir el default por omisión. **Regla para el ACL: emitirlos siempre
> explícitos, nunca confiar en el default.** Se resuelve con el XSD o con una llamada a CERT.

> **Son el análogo SOAP de `CreateErrorPolicyEnum`** (§5.1), con dos diferencias que importan:
> son **booleanos independientes**, no un array de políticas, y su polaridad es **inversa**
> (`haltOn*="true"` = abortar; `DO_NOT_HALT_ON_*` = continuar). En el ejemplo real de `Add FOP` los
> valores son **asimétricos** —`haltOnAirPriceError="false"` + `haltOnHotelBookError="true"`—:
> «tolera un fallo de precio del aire, pero **no** dejes el PNR sin el hotel». Es la política
> contraria a la del multi-producto REST del §5.1, donde el hotel es el producto tolerable.
> Elegirla al revés por descuido es exactamente cómo se produce una reserva a medias.

**Mapeo al dominio:** `OrderCreateRequest.partialFailureTolerance` (§8.4) cubre el carril REST.
Para el carril SOAP el ACL debe traducir `'PRICING' ∈ tolerance → haltOnAirPriceError="false"` y
`'HOTEL' ∈ tolerance → haltOnHotelBookError="false"`, y al revés. La conversión vive en
`providers/sabre/`, nunca en `packages/domain/`.

### 5.3 El éxito parcial es un modo declarado, no una anomalía

Cuatro evidencias, ahora con el contrato:

1. **[VS] `errorHandlingPolicy` con 6 valores `DO_NOT_HALT_ON_*`** — el API está diseñado para
   completar parcialmente.
2. **[VS] `CreateBookingResponse.errors[]` convive con `booking`** (`:819-825`): la respuesta
   puede traer la reserva **y** la lista de errores a la vez.
3. **[V] `cancelBooking` tiene `errorHandlingPolicy: ALLOW_PARTIAL_CANCEL | HALT_ON_ERROR`**
   (`CancelErrorPolicyEnum`, `:8942`) y cancela por `itemId` individual.
4. **[V] + [VS] `retryBookingUnconfirmedFlights`** existe porque un `createBooking` puede dejar
   vuelos no confirmados.

Y el multi-producto `createBooking - Air with CSL hotel` crea vuelo + hotel + 9 formas de pago en
una sola llamada contra dos backends distintos (GDS aéreo + CSL): **no puede ser atómico**.

### 5.4 Cómo debe reflejarse en nuestro dominio

`packages/domain/src/ports/order-create.port.ts` define hoy:

```ts
export interface OrderCreateResult {
  success: boolean;
  orderId?: string;
  pnr?: string;
  warnings: string[];
  error?: string;
}
```

**Eso no puede representar «PNR creado, vuelo confirmado, hotel falló»** — y ahora sabemos que ese
estado es un modo **explícitamente soportado** por el proveedor, no un caso raro.

```ts
export type OrderCreateOutcome = 'CONFIRMED' | 'PARTIAL' | 'PENDING' | 'FAILED';

export interface ProviderIssue {
  severity: 'ERROR' | 'WARNING';
  category: string; // Sabre: Error.category  — 'BAD_REQUEST' | 'APPLICATION_ERROR' | …
  type: string; // Sabre: Error.type      — 'REQUIRED_FIELD_MISSING' | …
  message?: string; // Sabre: Error.description
  fieldPath?: string; // Sabre: Error.fieldPath
  fieldName?: string;
  fieldValue?: string;
}

export interface OrderItemResult {
  kind: 'flight' | 'hotel' | 'car' | 'ancillary' | 'seat';
  providerItemId?: string; // Sabre: flights[].itemId / hotels[].itemId
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'FAILED';
  statusCode?: string; // 'NN' | 'UC' | 'HL' | 'HK' | 'YK'
  message?: string;
}

export interface OrderCreateResult {
  outcome: OrderCreateOutcome;
  orderId?: string; // Sabre NDC: booking.bookingId cuando es orderId
  pnr?: string; // Sabre: confirmationId (raíz)
  /** Firma de concurrencia. Sabre NO la devuelve en create: exige getBooking. Ver §6.3 */
  revision?: string;
  items: OrderItemResult[];
  issues: ProviderIssue[]; // ← mapea 1:1 con CreateBookingResponse.errors[]
  compensation?: { cancellableItemIds: string[] };
}
```

`ProviderIssue` es nuevo respecto a la propuesta de la primera pasada: ahora **sabemos la forma
exacta del error** (§6.4) y no hay razón para aplanarla a `string[]`.

En Temporal: la actividad de compensación debe llamar a `cancelBooking` con `cancelAll: false` +
los `itemId` de los ítems fallidos o sobrantes, **nunca** `cancelAll: true` ciego.

### 5.5 Regla operativa de timeout e idempotencia

**Presupuesto de latencia real** (§1.3 + §3.1.1): hasta **15 s** de retry de estado de vuelo

- hasta **10 s** de `asynchronousUpdateWaitTime` + latencia de ~13 servicios internos.
  **Timeout HTTP mínimo razonable: 45 s.** Un timeout de 10 s garantiza PNRs huérfanos.

⚠️ **`createBooking` no expone ninguna idempotency key.** Confirmado contra el contrato:
`CreateBookingRequest` (`:694-802`) **no tiene ningún campo de deduplicación**, y no hay ningún
header de idempotencia declarado en la operación (`:190-213`). El único campo con sabor a
correlación es `receivedFrom`, que es texto libre de auditoría.

**Regla:** si el HTTP de `createBooking` falla o da timeout, **jamás** reintentar a ciegas.

Y aquí hay un agujero real: **`getBooking` se direcciona por `confirmationId`** (`GetBookingRequest`,
`:240`), que es precisamente el dato que **no tenemos** cuando la llamada se cortó. Sembrar un
`remarks: [{type:"GENERAL", text:"ST-IDK-<uuid>"}]` antes de llamar deja la huella en el PNR, pero
**el contrato de Booking Management no ofrece ninguna búsqueda por remark**. La reconciliación
exige, o bien una API de búsqueda de PNR fuera de este producto, o bien
`notification.queuePlacement` (§3.12) para que el PNR huérfano caiga en una cola que un proceso
nuestro drene. **Ninguna de las dos está verificada.** Va a Preguntas abiertas y sigue siendo un
riesgo MAYOR. La mitigación mínima viable es **timeout largo (45 s) + reintento prohibido +
alarma humana**, implementado como actividad Temporal, no como `try/catch`.

---

## 6. `CreateBookingResponse` — el contrato completo

La primera pasada tituló esta sección «Lo que sabemos de la RESPUESTA (poco, y honesto)» porque
sólo tenía aserciones `pm.test`. **Ahora tenemos el contrato, un ejemplo oficial de respuesta y
4 respuestas reales guardadas.** Esta sección se reescribe entera.

### 6.1 El sobre — [VS] `booking-management-v1.yml:804`

**Sin `required`.** Cinco propiedades, y **sólo cinco**:

| Campo            | Tipo                        | Línea  | Notas                                                                                                 |
| ---------------- | --------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `timestamp`      | string `format: date-time`  | `:808` | UTC, `YYYY-MM-DDTHH:MM:SSZ`                                                                           |
| `confirmationId` | string **`^[A-Z0-9]{6,}$`** | `:814` | «The booking ID generated by the Create Booking API. **The Sabre system considers it a PNR locator**» |
| `booking`        | `Booking`                   | `:819` | El objeto normalizado. Ver §6.2                                                                       |
| `errors`         | `array<Error>`              | `:822` | «**This array is not displayed in successful responses**»                                             |
| `request`        | `CreateBookingRequest`      | `:827` | **Eco del request completo**                                                                          |

> ⚠️ **`request` es un eco íntegro del payload enviado, incluida `payment.formsOfPayment[]`.**
> Si el request llevó PAN y CVV, **vuelven en la respuesta**. Consecuencia directa: **el body de
> respuesta de `createBooking` es tan sensible como el de request** y no puede loguearse ni
> cachearse sin redacción. Esto no estaba en la primera pasada y es un riesgo operativo real.

> ⚠️ La estructura confirma la observación de la primera pasada: **`confirmationId` está en la
> raíz y los travelers cuelgan de `booking.`**. La forma es `{timestamp, confirmationId, booking,
errors, request}`. Nada más.

Verificado en el ejemplo oficial de respuesta
(`help-documentation-create-booking-examples.txt`, «Sample response with ancillaries stored under
all travelers except for infants»):

```jsonc
{
  "timestamp": "2025-10-29T10:17:18",
  "confirmationId": "PYMUEZ",
  "booking": {
    "bookingId": "PYMUEZ",
    "startDate": "2025-12-21", "endDate": "2026-01-01",
    "isCancelable": true, "isTicketed": false,
    "agencyCustomerNumber": "1234567",
    "creationDetails": { "creationUserSine": "AWV", "creationDate": "2025-10-29",
                         "creationTime": "05:17", "userWorkPcc": "U9PK",
                         "userHomePcc": "U9PK", "primeHostId": "1S" },
    "contactInfo": { "emails": ["TRAVEL2@SABRE.COM","TRAVEL@SABRE.COM"], "phones": ["123456"] },
    "travelers": [ { "givenName": "JOHN", "surname": "KOWALSKI",
                     "type": "ADULT", "passengerCode": "ADT", "nameAssociationId": "1",
                     "identityDocuments": [ { …, "itemId": "b5e4d96e…" } ],
                     "loyaltyPrograms": [ … ] } ]
  }
}
```

Observaciones de ese ejemplo, todas nuevas:

- **Todo viene en MAYÚSCULAS.** `"JOHN"`, `"KOWALSKI"`, `"TRAVEL@SABRE.COM"`. El PNR de Sabre
  normaliza a uppercase. **Comparar case-sensitive contra lo que enviamos siempre fallará.**
- **`nameAssociationId`** (`"1"`, `"2"`, `"3"`) es el número de nombre real del PNR, y **no** es
  el `nameReferenceCode` que mandamos (que es el MAN number). Son dos cosas distintas.
- **Cada `identityDocuments[]` recibe un `itemId`** de 128 caracteres hex. Es la clave para
  modificar o borrar ese documento después.
- **`timestamp` sin `Z`** en el ejemplo (`"2025-10-29T10:17:18"`), pese a que el contrato dice
  `YYYY-MM-DDTHH:MM:SSZ`. Parsear con tolerancia.

### 6.2 `booking` — `Booking` [VS] `booking-management-v1.yml:1053`

Es el **mismo objeto que devuelve `getBooking`** (`GetBookingResponse` = `Booking` + 4 campos,
`:296-321`). Sus 32 propiedades:

| Grupo           | Campos                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identidad**   | `bookingId` (`^[A-Z0-9]{6,14}$` — «For `SABRE`, this is the **PNR Locator or NDC `orderId`**, depending on content type»), `agencyCustomerNumber`, `creationDetails` |
| **Estado**      | `startDate`, `endDate`, `isCancelable`, `isTicketed`                                                                                                                 |
| **Personas**    | `travelers[]` (`Traveler`), `travelersGroup`, `travelersEmployers[]`, `profiles[]`, `contactInfo`                                                                    |
| **Productos**   | `flights[]`, `hotels[]`, `cars[]`, **`trains[]`**, **`cruises[]`**, `journeys[]`, `allSegments[]`                                                                    |
| **Dinero**      | `fares[]`, `fareRules[]`, `fareOffers[]`, `payments` (`TotalPayments`), `accountingItems[]`                                                                          |
| **Documentos**  | `flightTickets[]`, `nonElectronicTickets[]`                                                                                                                          |
| **Anotaciones** | `remarks[]`, `otherServices[]`, `specialServices[]`                                                                                                                  |
| **Ticketing**   | `futureTicketingPolicy`                                                                                                                                              |
| **Retención**   | `retentionEndDate`, `retentionLabel`                                                                                                                                 |

Puntos que importan al mapper:

- **`payments` es PLURAL en la respuesta** [VS] `:1200` (`TotalPayments`: `flightTotals`,
  `flightCurrentTotals`, `hotelTotals`, `carTotals`, `trainTotals`, `ancillaryTotals`,
  `formsOfPayment[]`). El request usa `payment` singular. **La asimetría es del contrato, no un
  error de los ejemplos.** Queda confirmada la sospecha de la primera pasada.
- **Todo producto se identifica por `itemId`**: `Flight` = `FlightReference` + `FlightItem`, y
  `FlightReference.itemId` es **`required`**, `^[A-Z0-9]+$` (`:1868-1879`). Igual `HotelReference`,
  `CarReference`, `TrainReference`, `CruiseReference`. **`itemId` es la unidad de cancelación y de
  compensación.**
- **`trains[]` y `cruises[]` existen.** Un PNR de Sabre puede contener tren y crucero. Fuera de
  alcance hoy, pero el mapper no debe explotar si aparecen.
- **Las claves de producto pueden desaparecer.** [V] Tras un reembolso, `flights` y `journeys`
  **no están en el objeto** (`pm.expect(jsonData).to.not.have.property('flights')`) mientras
  `allSegments` sobrevive. El mapper **no puede asumir que existan**.
- `Traveler` (respuesta) [VS] `:1708` tiene campos que `BookTraveler` no: **`type`**
  (`TravelerTypeEnum`), **`nameAssociationId`**, **`isGrouped`**, **`address`**, **`remarks[]`**.

### 6.3 `bookingSignature` — **NO viene en `createBooking`**

⚠️ **Resuelto, y en el sentido malo.** `bookingSignature` aparece **exactamente 5 veces** en todo
el contrato: en `GetBookingResponse` (`:309`), y en `ModifyBookingRequest` (`:836` como
`required`, `:840` como propiedad, y dos veces en descripciones, `:881`, `:888`).
**No está en `Booking` ni en `CreateBookingResponse`.**

Además, el propio contrato explica por qué: «The unique ID of **the Get Booking response**. It is
used to verify the state of the booking during the modification operation. **Available only if
obtaining the booking state does not result in any errors**» (`:312-313`).

> **Consecuencia dura:** para poder modificar una reserva recién creada **hay que encadenar un
> `getBooking` inmediatamente después de cada `createBooking`**. Eso es lo que hace la colección
> en **todos** los flujos de modificación: `CreateBookingNDC` → `GetBooking - retrieve
bookingSignature` → `ModifyBooking` [V] (verificado en las 4 familias de
> `NDC modifications flows` y en las de `Flight modification flows`).
>
> Impacto en el principio #1 de `CLAUDE.md` (tiempo a venta < 2 min): **una llamada extra
> obligatoria** en cualquier flujo que toque la reserva después de crearla. Mitigación: hacer el
> `getBooking` **de forma asíncrona** tras responder al usuario, y guardar el `bookingSignature`
> en nuestra DB con TTL corto — sabiendo que **caduca en cuanto la reserva cambia por cualquier
> vía**, incluido un cambio del lado de la aerolínea.

### 6.4 La forma del error — `Error` [VS] `booking-management-v1.yml:4271`

**Required: `category` + `type`.** Seis campos:

| Campo         | Ejemplo del contrato         | Línea   |
| ------------- | ---------------------------- | ------- |
| `category`    | `'BAD_REQUEST'`              | `:4278` |
| `type`        | `'REQUIRED_FIELD_MISSING'`   | `:4282` |
| `description` | `'may not be null'`          | `:4286` |
| `fieldPath`   | `'someObject.someFieldName'` | `:4290` |
| `fieldName`   | `'someName'`                 | `:4294` |
| `fieldValue`  | `'field value'`              | `:4298` |

**`Warning`** [VS] `:4305` tiene la **misma forma** (`category`, `type` required + `description`,
`fieldPath`, `fieldName`, `fieldValue`).

**Categorías observadas en la lista oficial de errores de createBooking:**
`BAD_REQUEST`, `APPLICATION_ERROR`, `EXTERNAL_SERVER_ERROR`, `WARNING`.

**Clasificación para el circuit breaker** (esto es lo que la primera pasada no podía escribir):

| `category`              | Tratamiento                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`           | **Terminal.** Bug nuestro o dato del cliente. No reintentar. Mapear a error de validación de dominio                                                                                                                                      |
| `APPLICATION_ERROR`     | **Depende del `type`.** `TIMEOUT`, `DOWNLINE_SERVICE_FAILURE`, `ATH_TOKEN_FAILURE` («Please retry the transaction»), `FAULT_RESPONSE` → **reintentable con backoff**. `PROFILE_DATA_INSUFFICIENT`, `INVALID_IDENTITY_DOCUMENT` → terminal |
| `EXTERNAL_SERVER_ERROR` | **Reintentable.** «The request was unsuccessful due to the timeout within the **external airline vendor** infrastructure. Please retry»                                                                                                   |
| `WARNING`               | No corta la reserva. Registrar en `issues[]` con `severity: 'WARNING'`                                                                                                                                                                    |

**Errores de infraestructura que exigen kill-switch por proveedor** (principio #9 de `CLAUDE.md`):
`TIMEOUT` («No response from service provider»), `DOWNLINE_SERVICE_FAILURE`,
`DOWNLINE_SERVICE_ERROR` («The (service ActionCode) service returned an error: (code: [%s]
message: [%s])»), `ATH_TOKEN_FAILURE`, `FAULT_RESPONSE`.

> **`DOWNLINE_SERVICE_ERROR` incluye el ActionCode del servicio interno que falló** — es decir,
> podemos saber si reventó `OTA_AirBookLLSRQ`, `EnhancedHotelBookRQ` o el Order Management.
> Ese dato debe llegar a `ProviderIssue.message` sin recortar: es lo único que permite atribuir
> el fallo a un dominio de producto.

**Sobre el código HTTP:** el spec sólo declara `200` (§1). La lista oficial de errores clasifica
por `category`, no por status. **Nuestro ACL debe decidir por `errors[].category`, nunca por el
status HTTP.** **[?]** Sigue sin confirmarse si hay 4xx para errores de esquema.

### 6.5 Las 4 respuestas guardadas — **la evidencia que la primera pasada descartó por error**

Las 4 respuestas de la colección **no están vacías**: pesan **16.479 bytes cada una**. Son todas
`POST /v1/orders/view`, ejecutadas **inmediatamente después de un `CreateBooking NDC`** dentro de
`ModifyBooking / NDC modifications flows / Modify phone|update birthdate / …`. Es decir: **son la
orden NDC que ese `createBooking` acababa de crear**, vista por Order Management.

⚠️ **Importante para no volver a confundir fuentes:** `/v1/orders/view` es **Order Management**,
no Booking Management. Su modelo es `{ order: { … } }`, **crudo NDC**, mientras que
`createBooking.booking` es el modelo **normalizado** de Sabre. Son dos vistas del mismo PNR. La
primera es lo que Sabre recibe de la aerolínea; la segunda es lo que Sabre nos promete.

Forma real observada (`evidence/responses/01-Add_phone_Orders_View.json`):

```jsonc
{ "order": {
  "id": "4e54071d6c2d483c808f8a09f38f6bbc",     // orderId NDC (32 hex)
  "pnrLocator": "TOSGCZ",                        // PNR Sabre
  "orderOwner": "1S",
  "orderItems": [{
    "id": "1",
    "externalId": "PoP98BD9F8A-6BD3-4A7D-953E-1-1",
    "externalOrderRefId": "beb6cb29-77ae-4233-90a7-f307f7d099a6",
    "creationDateTime": "2019-03-27T15:37:06",
    "ticketingTimeLimit": "2019-04-19T20:37:00",
    "fareDetails": [{
      "fareIndicatorCode": "0",
      "paxRefIds": ["Passenger1"],
      "price": {
        "baseAmount":     { "amount": "109.77", "code": "USD" },
        "totalTaxAmount": { "amount": "36.83",  "code": "USD" },
        "taxBreakdowns": [{ "amount": {"amount":"2.37","code":"USD"},
                            "countryCode":"US", "taxCode":"US",
                            "description":"US Transportation Tax" }]
      },
      "fareComponents": [{ "fareBasisCode":"GAA7TCBN", "fareBasisCityPair":"DENDFWUA",
                           "cabinTypeCode":"Y", "type":"X", "price": { … } }]
    }],
    "price": { "totalAmount": { "amount": "146.60", "code": "USD" } },
    "services": [{ "id":"1", "passengerRefId":"Passenger1", "segmentRefId":"Isgm52C70" }],
    "offerItemId": "cg05grt8njtq6dou00-1-1",
    "externalOfferItemId": "PoIP98BD9F8A-6BD3-4A7D-953E-1-1"
  }],
  "contactInfos": [{ "id":"CI-1", "phones":[{"number":"6069871234"}],
                     "emailAddresses":[{"address":"test@sabre.com"}] }],
  "products": [{ "id":"4e413d3d", "airSegment": { "marketingCarrier": {"airlineCode":"UA"},
                  "departureDateTime":"2019-04-20T20:36:00", "departureAirport":"DEN",
                  "arrivalAirport":"DFW", "actionCode":"HK" } }],
  "passengers": [{ "id":"Passenger1", "typeCode":"ADT", "contactInfoRefId":"CI-1",
                   "birthdate":"1977-03-01", "givenName":"PAM", "surname":"THOMPSON" }],
  "journeys": [{ "id":"FGTIDRX…", "segmentRefIds":["Isgm52C50"] }],
  "segments": [{ "id":"Isgm52C50",
                 "departure": {"locationCode":"DEN","stationName":"Denver Intl Apt, US",
                               "scheduledDateTime":"2019-04-20T20:36:00","terminalName":"E"},
                 "arrival":   {"locationCode":"DFW","scheduledDateTime":"2019-04-20T23:28:00"},
                 "marketingCarrier": {"carrierCode":"UA","carrierName":"United Airlines",
                                      "flightNumber": 338} }],
  "priceClasses": [{ "id":"BasicEconomy", "code":"1_basiceco", "name":"Basic Economy" }],
  "customerNumber": { "number":"123456" },
  "paymentTimeLimit": "2019-04-19T20:37:00",
  "externalOrders": [{ "id":"beb6cb29-…", "systemId":"UAD", "externalOrderId":"1337155P2",
                       "bookingReferences":[{ "id":"L4D79U", "carrierCode":"F1" }] }],
  "totalPrice": { "totalAmount": { "amount":"146.60", "code":"USD" } }
} }
```

Lo que esta evidencia dura nos enseña, y que ninguna otra fuente daba:

1. **`Money` es `{amount: string, code: string}`** — importe **como string**, y la clave de moneda
   es **`code`, no `currencyCode`**. Nuestro `Money` canónico debe aceptar string y no perder
   precisión pasando por `number`.
2. **Hay TRES localizadores distintos por reserva NDC**: `order.id` (orderId de 32 hex),
   `order.pnrLocator` (PNR Sabre, 6 car.) y `order.externalOrders[].bookingReferences[].id`
   (**el PNR de la aerolínea**, aquí `L4D79U` con `carrierCode: F1`). **El cliente ve el de la
   aerolínea; nosotros operamos con los otros dos.** Guardar los tres o el soporte al pasajero es
   imposible.
3. **Dos time limits distintos y ambos presentes**: `orderItems[].ticketingTimeLimit` (por ítem) y
   `order.paymentTimeLimit` (global). Aquí coinciden, pero son campos distintos. Es la base del
   flujo «reservar ahora, emitir después» de §7.
4. **Impuestos desglosados por `taxCode` + `countryCode` + `description`**, tanto a nivel de
   `fareDetails.price` como de cada `fareComponents[].price`. Materia prima directa para la
   facturación fiscal LATAM.
5. **`actionCode: "HK"`** en el segmento — el estado confirmado. Complementa la lista de
   `haltOnFlightStatusCodes` (§5.2), que sólo enumera los **inaceptables**.
6. **`passengers[].birthdate` en minúscula** en Order Management, frente a `birthDate` en Booking
   Management. Dos modelos, dos convenciones. El ACL tiene que absorberlo.
7. `fareComponents[].fareBasisCityPair: "DENDFWUA"` — par de ciudades + carrier concatenados.

**Acción concreta:** guardar esas 4 respuestas como primer fixture del ACL en
`providers/sabre/src/fixtures/` (extraídas del `.json` original de la colección, **no** del
`requests.jsonl`).

---

## 7. EL CONFLICTO PCI — veredicto con el contrato en la mano

### 7.1 Lo que viaja en claro dentro del body

| Dato                        | Campo                                                    | Requests | Marca      |
| --------------------------- | -------------------------------------------------------- | -------- | ---------- |
| **PAN completo**            | `payment.formsOfPayment[].cardNumber`                    | **48**   | [V]        |
| **CVV / CVC**               | `payment.formsOfPayment[].cardSecurityCode`              | **45**   | [V]        |
| Caducidad                   | `expiryDate` (`YYYY-MM`)                                 | 48       | [V] + [VS] |
| Titular + dirección         | `cardHolder{givenName,surname,email,phone,address{}}`    | 42       | [V]        |
| Nº de pasaporte / visado    | `identityDocuments[].documentNumber`                     | 131      | [V]        |
| KTN / Redress               | `documentType: KNOWN_TRAVELER_NUMBER` / `REDRESS_NUMBER` | —        | [V]        |
| Fecha y lugar de nacimiento | `birthDate`, `placeOfBirth`                              | 271 / 12 | [V]        |
| Género                      | `gender`                                                 | 121      | [V]        |
| ID fiscal                   | `documentType: FISCAL_ID`                                | 1        | [V]        |
| Nº de fidelización          | `loyaltyPrograms[].programNumber`                        | 64       | [V]        |

Y, nuevo respecto a la primera pasada: **todo eso vuelve en la respuesta**, porque
`CreateBookingResponse.request` es un eco íntegro del payload (§6.1).

### 7.2 El conflicto, enunciado sin rodeos

`CLAUDE.md`: _«Hosted checkout únicamente en fase 1 (PCI SAQ-A). **Nunca PAN/CVV en servidor**.»_

Si usamos `type: "PAYMENTCARD"`, el PAN atraviesa nuestro backend. **Transmitir ya mete en scope
PCI**; no hay atajo por «no lo logueamos» ni por «lo aislamos en un microservicio» (eso acota el
scope, no lo elimina). Eso es SAQ-D: auditoría anual, escaneo trimestral, segmentación de red.

### 7.3 La pregunta correcta: ¿qué acepta cada paso del ciclo sin PAN?

El ciclo de venta aérea tiene **dos** pasos con forma de pago, y **son enums distintos**:

| Paso                                | Enum aplicable                                                                                                                                                            | Valores sin PAN                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`createBooking`** (reservar)      | `FormOfPaymentTypeEnum` [VS] `:8792` — 14 valores                                                                                                                         | `CASH`, `CHECK`, `MISCELLANEOUS`, `INSTALLMENTS`, `DOCKET`, `GOVERNMENT_TRAVEL_REQUEST`, `INVOICE` — **y también omitir `payment` por completo** |
| **`fulfillFlightTickets`** (emitir) | `FulfillFormOfPaymentTypeEnum` [VS] `:8659` — **8 valores**: `PAYMENTCARD`, `CASH`, `CHECK`, `MISCELLANEOUS`, `INSTALLMENTS`, `VIRTUAL_CARD`, `INVOICE`, **`ON_ACCOUNT`** | `CASH`, `CHECK`, `INVOICE`, `ON_ACCOUNT`, `MISCELLANEOUS`                                                                                        |

Tres conclusiones que sólo se ven mirando los dos enums a la vez:

1. **`AGENCY_IATA`, `AGENCY_NAME`, `CORPORATE`, `COMPANY_NAME` NO existen en fulfillment.** Aunque
   se pudieran usar al reservar, **no se puede emitir el billete con ellas**. La recomendación de
   la primera pasada (opción B) era inservible para el carril aéreo por partida doble.
2. **`CASH` y `CHECK` existen en los dos pasos**, sin campos propios, sin datos de tarjeta.
3. **`ON_ACCOUNT` e `INVOICE` sólo existen en fulfillment** y son exactamente el modelo
   «facturar a la agencia» — es decir, el modelo consolidador. `ON_ACCOUNT` admite además
   `customPaymentCode` (ej. `CA/NOREF`) para el código de cuenta de la agencia.

### 7.4 La evidencia dura de que funciona sin PAN

**a) `createBooking` aéreo real, en producción, con `CASH` y cero datos de tarjeta.** [V]
`Create Booking / Flights - NDC/ATPCO/LCC / createBooking - Air with pricing Complex` — es un
payload real de **Wakanow** (consolidador nigeriano), 6 segmentos KL, `targetPcc: "7KFA"`:

```jsonc
"payment": { "formsOfPayment": [ { "type": "CASH" } ] }
```

Nada más. Sin `cardNumber`, sin `cardSecurityCode`, sin `cardHolder`. **Es exactamente nuestro
caso de uso: un consolidador reservando bajo el PCC de otra agencia y pagando sin tarjeta.**

**b) `fulfillFlightTickets` ATPCO real con `CASH` y cero tarjeta.** [V] Tres requests:

```jsonc
// Workflows / 26 - ATPCO - Refund ancillaries with list of tickets / fulfillFlightTickets
{
  "confirmationId": "{{pnr}}",
  "fulfillments": [{ "payment": { "primaryFormOfPayment": 1 } }],
  "formsOfPayment": [{ "type": "CASH" }],
}
```

También `Workflows / 27` y `FulfillFlightTickets / Generic Examples / fulfillFlightTickets Two FOPs`.
**El ciclo ATPCO completo — reservar y emitir — está demostrado PAN-free en la propia colección.**

**c) Hotel PAN-free por contrato.** `hotel.paymentPolicy: "LATE"` [VS] `:5060-5063`: «When using
`LATE` payment **do not indicate `formOfPayment`** as this method allows customers to **make a
booking without any form of payment**.»

**d) 82 de 176 `createBooking` no llevan bloque `payment` en absoluto.** [V] Reservar sin FOP es
el caso mayoritario, no la excepción.

### 7.5 Dónde NO hay evidencia — y la refutación parcial al crítico

El crítico señaló que «hay evidencia en la colección de emisión NDC con FOP sin tarjeta».
**Lo he verificado y es sólo parcialmente cierto; lo refuto con el dato exacto.**

Los dos únicos `fulfillFlightTickets` de contenido **NDC** de la colección son:

- `FulfillFlightTickets / Basic flow NDC / NDC fulfillment - flight order items / AA` → lleva
  `PAYMENTCARD` con `cardNumber`.
- `Workflows / 14 - NDC Cancel order and void corresponding flight tickets / 4. fulfillFlightTickets`
  → su array `formsOfPayment` **sí contiene un `{"type":"CASH"}`**… pero:

```jsonc
"fulfillments": [ { "payment": { "primaryFormOfPayment": 2 } } ],
"formsOfPayment": [
  { "type": "CASH" },                                    // índice 1 — NO seleccionado
  { "cardTypeCode":"AX", "cardNumber":"{{ndcCreditCardNumber}}",
    "expiryDate":"{{ndcCreditCardExpiryDate}}", "type":"PAYMENTCARD",
    "authentications":[{ "channelCode":"MO" }] }         // índice 2 — SELECCIONADO
]
```

**`primaryFormOfPayment: 2` apunta a la tarjeta.** El `CASH` está declarado pero **no se usa**.
Por tanto: **no existe en la colección ni un solo ejemplo de emisión NDC efectivamente pagada sin
PAN.** Lo que sí existe es la prueba de que el array **admite** `CASH` en un contexto NDC.

Y la guía oficial de fulfillment refuerza la cautela:

> «When fulfilling an order for **NDC** distribution model it is **mandatory to pass form of
> payment information**. When using a credit card form of payment it is required that the secured
> payment transaction channel code is specified… Mail Order (MO) or Telephone Order (TO)… or
> eCommerce (EC).» — `help-documentation-fulfill-flight-tickets.txt`

Obligatorio pasar **una** forma de pago; el texto **no dice que tenga que ser tarjeta**, y
`FulfillFormOfPaymentTypeEnum` incluye `CASH`/`CHECK`/`INVOICE`/`ON_ACCOUNT`. **Contrato: sí.
Evidencia empírica: no.**

### 7.6 VEREDICTO

> ## ¿Se puede operar en fase 1 sin tocar PAN? **SÍ para ATPCO/LCC y hotel. NO CONFIRMADO para NDC.**

**La forma de pago exacta es:**

| Carril                | Reservar (`createBooking`)                                                                                                           | Emitir (`fulfillFlightTickets`)                                                           | Estado                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Aéreo ATPCO / LCC** | `payment.formsOfPayment: [{ "type": "CASH" }]` **+** `agency.ticketingPolicy: "TICKETING_TIME_LIMIT"` con `ticketingTimeLimitPolicy` | `formsOfPayment: [{ "type": "CASH" }]` + `fulfillments[].payment.primaryFormOfPayment: 1` | ✅ **VERIFICADO end-to-end** en la colección                                                                              |
| **Hotel**             | `hotel.paymentPolicy: "LATE"` **sin** `hotel.formOfPayment`                                                                          | n/a                                                                                       | ✅ **VERIFICADO-SPEC** (`:5060-5063`)                                                                                     |
| **Aéreo NDC**         | `payment.formsOfPayment: [{ "type": "CASH" }]`                                                                                       | `formsOfPayment: [{ "type": "CASH" }]`                                                    | ⚠️ **Permitido por el contrato, sin ejemplo que lo ejercite.** Hay que probarlo en CERT antes de comprometer el canal NDC |

**Semántica de `CASH` frente a Sabre:** «esta venta se liquida fuera del canal Sabre». **El cobro
real al cliente lo hacemos nosotros por hosted checkout (Stripe / Mercado Pago), y la liquidación
con la aerolínea va por BSP contra el crédito de la agencia.** Eso es literalmente cómo opera un
consolidador, y es lo que hace Wakanow en el request `Air with pricing Complex`.

**Esto mantiene SAQ-A**, porque el PAN nunca toca nuestro servidor: lo teclea el cliente final en
el checkout hosted del PSP.

**Reglas de implementación derivadas:**

1. **`PAYMENTCARD` va detrás de un feature flag apagado por defecto** (Unleash), por tenant. Sólo
   se enciende si el founder decide asumir SAQ-D con un tenant concreto.
2. El default del ACL es **`CASH`** en aéreo y **`LATE`** en hotel.
3. **Ninguna estructura del dominio (`packages/domain/`) debe tener un campo capaz de contener un
   PAN.** El tipo `card` de `FormOfPayment` vive únicamente dentro de `providers/sabre/`, detrás
   del flag, y `packages/validation` debe rechazar en el borde cualquier body con `cardNumber`
   cuando el flag está apagado.
4. **Redactar `CreateBookingResponse.request` antes de persistir o loguear** (§6.1).
5. Tarea de sandbox **bloqueante** antes de vender NDC por Sabre: emitir una orden NDC real en
   CERT con `formsOfPayment: [{type:"CASH"}]` y verificar que el billete sale.

### 7.7 Opciones descartadas y por qué

| Opción                                                           | Veredicto                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`AGENCY_IATA` / `AGENCY_NAME` / `COMPANY_NAME` / `CORPORATE`** | ❌ **Descartada.** El contrato las declara «used for **hotel** bookings» (`:8795`) y **no existen en `FulfillFormOfPaymentTypeEnum`**: no se puede emitir un billete con ellas. Las 6 apariciones en la colección son todas de hotel     |
| **`VIRTUAL_CARD`**                                               | ⚠️ Existe en los dos enums (en fulfill como `virtualCardCode`), pero **todas sus apariciones en la colección son de hotel**, y exige un `customerAccountCode` que **[?]** requiere contrato VCC previo con Sabre. Descartada para fase 1 |
| **Tokenización vía `originalPaymentReference`**                  | ❌ **Descartada.** El contrato dice que es un **Authorization Trace ID**, no un token de tarjeta (`:6473`). §3.7.3                                                                                                                       |
| **Wallet `referenceId` de fulfillment**                          | ⚠️ **La única referencia tokenizada real del contrato** (§3.7.4), pero sólo en fulfill y **[?]** sin saber cómo entra la tarjeta al wallet. No apta para fase 1, pero **es la vía a explorar en fase 2** si se quiere aceptar tarjeta    |
| **Aceptar SAQ-D**                                                | Fuera del alcance declarado de la fase 1. Requiere decisión explícita del founder                                                                                                                                                        |

### 7.8 PII de documentos — no es sólo la tarjeta

`identityDocuments[].documentNumber` (131 apariciones) contiene números de pasaporte y visado.
Además:

- **Sabre no valida la coherencia entre traveler y documento.** Los propios ejemplos oficiales
  tienen `birthDate` distinto en el traveler (`1970-01-23`) y en su pasaporte (`1980-12-02`) [V].
  Confirmado por el contrato: son propiedades independientes (`:6173` vs `:5627`), sin regla
  cruzada. **La validación tiene que ser nuestra, en Zod, en el borde**, o emitimos billetes que
  el control de embarque rechaza.
- `documentNumber` sólo admite `^[a-zA-Z0-9]+$` (`:5559`): **sin guiones ni espacios**. Muchos
  documentos LATAM los llevan. Normalizar antes de enviar.
- Retención: un `documentNumber` en nuestra DB entra en el régimen de datos personales sensibles
  (Ley 1581 CO / LGPD BR / Ley 29733 PE). Hay que definir TTL y cifrado a nivel de columna.
  **[?]** No está definido hoy.

---

## 8. Mapeo a nuestro dominio

### 8.1 Estado actual (re-verificado en esta pasada)

`packages/domain/src/ports/order-create.port.ts` define hoy `Passenger`, `BookingContactInfo`,
`PaymentInfo`, `OrderCreateRequest` y `OrderCreateResult`. Confirmado íntegro. Y
`providers/latam-ndc/src/ordercreate/request.builder.ts` construye XML `IATA_OrderCreateRQ`.
Sabre es **JSON, no XML NDC crudo**: el ACL es distinto, pero el **puerto** debería servir para
los dos. Hoy no sirve.

### 8.2 Campos que YA existen y mapean directo

| Nuestro campo                                      | Campo Sabre                                         | Nota                                                                           |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `offer.provider.offerRef` (`offerId\|item1,item2`) | `flightOffer.offerId` + `selectedOfferItems[]`      | El formato que ya usa `parseOfferRef()` encaja tal cual. **Máx. 9 items** [VS] |
| `Passenger.paxId`                                  | `travelers[].id`                                    |                                                                                |
| `Passenger.givenName` / `surname`                  | `travelers[].givenName` / `surname`                 | ⚠️ `surname` **no admite dígitos** [VS] `:6170`                                |
| `Passenger.birthdate`                              | `travelers[].birthDate`                             | ⚠️ minúscula vs `birthDate`                                                    |
| `Passenger.paxType` (`ADT\|CHD\|INF`)              | `travelers[].passengerCode`                         | ⚠️ **Sabre usa `CNN`, no `CHD`**                                               |
| `Passenger.identityDoc.*`                          | `identityDocuments[].*`                             |                                                                                |
| `Passenger.citizenshipCountryCode`                 | `identityDocuments[].citizenshipCountryCode`        | ⚠️ En nosotros vive en el **pasajero**, en Sabre en el **documento**           |
| `Passenger.loyaltyProgramAccount.*`                | `loyaltyPrograms[].programNumber` / `.supplierCode` |                                                                                |
| `BookingContactInfo.email` / `phone`               | `contactInfo.emails[0]` / `phones[0]`               | ⚠️ Nosotros **uno**, Sabre **array**                                           |
| `PaymentInfo.card.*`                               | `formsOfPayment[].*`                                | **Ver §7 antes de usarlo**                                                     |
| `PaymentInfo.payer.taxId`                          | `identityDocuments[]` con `FISCAL_ID`               | ⚠️ `documentSubType` sólo admite RUC/CUIT-CUIL/NIT (§3.4.2.1)                  |

### 8.3 Campos que FALTAN — lista actualizada contra el contrato

| Falta                                                                                                          | Por qué importa                                                                                                                        | Prioridad |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `paxType` con `CNN`, `INS`, `INY`, `SRC`                                                                       | `CHD` **no existe en Sabre**. `passengerCode` es `^[A-Z][A-Z0-9]{2}$`, no un enum: modelar como string validado, no como unión cerrada | **Alta**  |
| `title` con el **`TitleEnum` de 18 valores**                                                                   | Hoy `'Mr'\|'Mrs'\|'Miss'\|'Dr'`. **Corrección revisada: adoptar el enum tal cual, NO abrir a `string`**                                | **Alta**  |
| `documents[]` como **array**                                                                                   | AA/QF/UA/QR/SQ exigen PASSPORT + VISA + KTN + REDRESS + SFPD a la vez                                                                  | **Alta**  |
| `documentType` con los **17 valores** de `DocumentTypeEnum`                                                    | Hoy sólo `'P'\|'DNI'\|'CC'\|'CE'`                                                                                                      | **Alta**  |
| `residenceCountryCode`, `hostCountryCode`, `placeOfIssue`, `placeOfBirth`                                      | Sabre distingue emisor / residencia / ciudadanía / host(visa)                                                                          | **Alta**  |
| `documentSubType` con enum cerrado + **plan B para CO/PE/BR**                                                  | Bloquea facturación DIAN/SUNAT/NF-e. Ver §3.4.2.1                                                                                      | **Alta**  |
| Formas de pago **no-tarjeta** con `CASH` como default                                                          | Es lo que nos mantiene en SAQ-A (§7)                                                                                                   | **Alta**  |
| `targetPcc` + `futureTicketingPolicy.ticketingPcc`                                                             | **Central para el consolidador**: reservar en un PCC, emitir en otro                                                                   | **Alta**  |
| `ticketingPolicy` (4 valores) + `ticketingTimeLimitPolicy`                                                     | Habilita el flujo «reservar hoy, cobrar y emitir después»                                                                              | **Alta**  |
| `errorHandlingPolicy[]`                                                                                        | Sin él no hay éxito parcial controlado (§5.1)                                                                                          | **Alta**  |
| Resultado con **éxito parcial** + `issues[]` tipados                                                           | §5.4                                                                                                                                   | **Alta**  |
| `revision` / `bookingSignature` **obtenido por getBooking**                                                    | Sin él no se puede modificar (§6.3)                                                                                                    | **Alta**  |
| Comisión y aerolínea validadora (`flightPricing[].qualifiers.commissionPercentage` / `.validatingAirlineCode`) | `PricingQualifiers` hereda `TicketingQualifiers`: valen al **reservar** y al **emitir** (§3.3.2). Pieza del pricing waterfall          | **Alta**  |
| Contacto **por pasajero** (`emails[]`, `phones[{number,label}]`)                                               | Requisito de varias NDC                                                                                                                | **Media** |
| Contacto **de agencia** separado (`agency.contactInfo`)                                                        | Requisito AF                                                                                                                           | **Media** |
| `agencyCustomerNumber` (DK, 6/7/10 car.)                                                                       | Identidad de la agencia en el PNR                                                                                                      | **Media** |
| Selección de asientos (`seatOffers[]` / `seats[]` / `areaPreferences[]`)                                       |                                                                                                                                        | **Media** |
| Ancillaries                                                                                                    | ⚠️ **No disponibles en NDC** (§3.4.4)                                                                                                  | **Media** |
| Retención OTH (`YYYY-MM-DD`)                                                                                   | «Cotización reservada» del Package Studio                                                                                              | **Media** |
| `notification.queuePlacement` / `remarks[QUEUE_PLACE]`                                                         | Flujo de revisión del consolidador y posible vía de reconciliación (§5.5)                                                              | **Media** |
| `priceComparisons[]` (`amount` **o** `percent`)                                                                | Único freno de precio del endpoint                                                                                                     | **Media** |
| `formOfPaymentIndices` por pasajero, `infantTravelerIndex`, `employerIndex`                                    | Casos B2B y familias                                                                                                                   | **Baja**  |
| Remarks / OSI                                                                                                  |                                                                                                                                        | **Baja**  |

### 8.4 Shape propuesto (actualizado)

```ts
// packages/domain/src/ports/order-create.port.ts  (propuesta)

/** No es enum cerrado en Sabre: patrón ^[A-Z][A-Z0-9]{2}$ */
export type PaxTypeCode = string; // 'ADT' | 'CNN' | 'INF' | 'INS' | 'INY' | 'SRC' | …

export type TravelerTitle =
  | 'Mr'
  | 'Mrs'
  | 'Ms'
  | 'Dr'
  | 'Miss'
  | 'Mstr'
  | 'Mlle'
  | 'Sir'
  | 'Father'
  | 'Sister'
  | 'Brother'
  | 'Reverend'
  | 'Lt'
  | 'Capt'
  | 'Congressman'
  | 'Duke'
  | 'Duchess'
  | 'Prof'; // = TitleEnum, booking-management-v1.yml:9398

export type IdentityDocType =
  | 'PASSPORT'
  | 'VISA'
  | 'SECURE_FLIGHT_PASSENGER_DATA'
  | 'RESIDENCE_ADDRESS'
  | 'DESTINATION_ADDRESS'
  | 'KNOWN_TRAVELER_NUMBER'
  | 'REDRESS_NUMBER'
  | 'ALIEN_RESIDENT'
  | 'PERMANENT_RESIDENT'
  | 'FACILITATION_DOCUMENT'
  | 'NATIONAL_ID_CARD'
  | 'NEXUS_CARD'
  | 'MILITARY'
  | 'NATURALIZATION_CERTIFICATE'
  | 'REFUGEE_REENTRY_PERMIT'
  | 'BORDER_CROSSING_CARD'
  | 'FISCAL_ID';

export interface IdentityDocument {
  type: IdentityDocType;
  subType?: 'RUC' | 'CUIT/CUIL' | 'NIT'; // enum CERRADO en Sabre
  /** ^[a-zA-Z0-9]+$ — sin guiones ni espacios. Normalizar en el ACL. */
  number?: string;
  issuingCountryCode?: string; // ISO-2 o ISO-3
  residenceCountryCode?: string; // NDC: SÓLO ISO-2
  citizenshipCountryCode?: string;
  hostCountryCode?: string; // sólo VISA
  placeOfIssue?: string; // sólo VISA
  placeOfBirth?: string; // máx 35
  issueDate?: string;
  expiryDate?: string;
  givenName?: string;
  middleName?: string;
  surname?: string; // middleName: no soportado en NDC
  birthDate?: string;
  gender?: 'MALE' | 'FEMALE' | 'INFANT_MALE' | 'INFANT_FEMALE' | 'UNDISCLOSED' | 'UNDEFINED';
  isPrimary?: boolean;
  isLapChild?: boolean;
  segmentIndices?: number[]; // 0-based hacia adentro
}

export interface Passenger {
  paxId: string;
  paxType: PaxTypeCode;
  title?: TravelerTitle;
  givenName: string;
  /** Sabre rechaza dígitos en el apellido. */
  surname: string;
  birthdate?: string; // obligatorio si infante
  age?: number; // obligatorio si menor + hotel
  gender?: 'M' | 'F' | 'U';
  documents: IdentityDocument[];
  contact?: {
    emails?: string[];
    phones?: Array<{ number: string; label?: 'M' | 'B' | 'C' | 'H' }>;
  };
  loyalty?: Array<{
    accountNumber: string;
    supplierCode?: string;
    receiverCode?: string;
    programType?: 'FREQUENT_FLYER' | 'FREQUENT_RENTER' | 'LOYALTY_ID' | 'CORPORATE_LOYALTY_ID';
    tierLevel?: number; // ENTERO — Sabre lo declara int32
  }>;
  /** Empareja este infante con un adulto concreto. 0-based hacia adentro. */
  linkedInfantPaxIndex?: number;
  requiresNotificationContactType?: boolean; // requisito HA
}

export type FormOfPaymentKind =
  | 'NONE' // ← default: no mandar bloque payment
  | 'CASH' // ← default cuando hay que declarar algo (§7)
  | 'CHECK'
  | 'INVOICE'
  | 'ON_ACCOUNT'
  | 'MISCELLANEOUS'
  | 'INSTALLMENTS'
  | 'PAYMENT_CARD'; // ← SÓLO detrás de feature flag SAQ-D

export interface FormOfPayment {
  kind: FormOfPaymentKind;
  /** SÓLO existe si el tenant está habilitado para SAQ-D. Nunca cruza a packages/domain. */
  card?: never; // el tipo card vive en providers/sabre/
  installments?: { count: number; planCode?: string; amount?: string; netBalance?: string };
  accountCode?: string; // ON_ACCOUNT / customPaymentCode
  invoiceDescription?: string;
}

export interface AgencyIdentity {
  address?: PostalAddress; // OBLIGATORIA en ATPCO; omitir si viene del perfil
  customerNumber?: string; // DK: 6, 7 o 10 caracteres
  contact?: { phones?: string[]; includePhoneLabel?: boolean; emails?: string[] };
  ticketing?: {
    policy: 'TODAY' | 'ALREADY_TICKETED' | 'FUTURE_TICKETING' | 'TICKETING_TIME_LIMIT';
    timeLimit?: { airlineCode: string; date: string; time: string };
    /** Consolidador: emitir en otro PCC, encolado. */
    future?: { pcc?: string; queueNumber?: string; date?: string; time?: string; comment?: string };
  };
}

export interface OrderCreateRequest {
  offer: Offer;
  criteria: FlightSearchCriteria;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
  agency?: AgencyIdentity;
  /** BYOC consolidador: reservar bajo el PCC de la sub-agencia. Sabre NO revierte el contexto. */
  targetPointOfSale?: string;
  formsOfPayment?: FormOfPayment[];
  /** Tolerancias de fallo por dominio de producto. Mapea a errorHandlingPolicy[]. */
  partialFailureTolerance?: Array<
    'PRICING' | 'HOTEL' | 'CAR' | 'ANCILLARY' | 'SEAT' | 'IDENTITY_DOC_WARNING'
  >;
  haltOnInvalidConnectingTime?: boolean;
  seatSelections?: Array<{
    paxIndex: number;
    segmentIndex: number;
    seatNumber?: string;
    areaPreferences?: string[];
    providerSeatOfferId?: string;
  }>;
  ancillaries?: Array<{
    paxIndex: number;
    providerRef: string;
    price?: Money;
    segmentIndices?: number[];
  }>;
  remarks?: Array<{
    kind: 'GENERAL' | 'HISTORICAL' | 'OSI' | 'QUEUE_PLACE';
    text: string;
    paxIndex?: number;
    airlineCode?: string;
  }>;
  retention?: { until: string; label?: string }; // until = YYYY-MM-DD
  priceGuard?: { expected: Money; tolerance: { amount?: string; percent?: string } };
  abortOnSegmentStatus?: Array<'NO' | 'NN' | 'UC' | 'US' | 'UN' | 'UU' | 'LL' | 'HL'>;
  /** Idempotencia NUESTRA. Sabre no la ofrece (§5.5). */
  idempotencyKey: string;
}
```

Notas de diseño:

- **Índices**: hacia adentro **todo 0-based**; la conversión a 1-based es responsabilidad
  **exclusiva** de `providers/sabre/`. Ningún índice 1-based cruza a `packages/domain/`.
- **`targetPointOfSale`** es el gancho del modelo consolidador. `apps/api/src/providers-latam/
latam-ndc.factory.ts` ya resuelve credenciales por herencia; el equivalente Sabre resolvería
  también el **PCC** del nodo. ⚠️ Con la advertencia del contrato: **`targetPcc` no revierte el
  contexto** (`:708`), así que el pool de conexiones tiene que asumir contexto sucio o forzar
  reset entre llamadas de tenants distintos. **Es un riesgo de aislamiento multi-tenant.**
- **`FormOfPaymentKind.NONE` / `CASH` son los defaults**, no `PAYMENT_CARD`.
- **`tierLevel` es number**, no string.

---

## 9. El camino stateful: construir el PNR por LLS

> **Sección nueva.** La primera pasada tituló el documento «contrato completo» describiendo sólo
> el carril REST, e ignoró **243 de los 1.077 requests** de la colección. Ese carril existe, es
> mayoritario en volumen de mensajes SOAP, y **es imprescindible para los flujos de grupo**.

### 9.1 Inventario del carril SOAP/LLS [V]

Recuento sobre los 1.077 requests (`POST {{soap_endpoint}}` / `{{lls_endpoint}}` = **243**):

| Mensaje                                                 | Nº  | Para qué                                                            |
| ------------------------------------------------------- | --- | ------------------------------------------------------------------- |
| `SessionCloseRQ`                                        | 61  | Cerrar la sesión ATH                                                |
| `SessionCreateRQ`                                       | 50  | Abrir sesión ATH (`UsernameToken` + `Organization` = PCC)           |
| `OTA_AirAvailRQ` (v2.4.0)                               | 30  | Disponibilidad — de aquí sale el `FlightNumber` real                |
| `GetHotelAvailRQ` (v5.0.0)                              | 26  | Disponibilidad hotel → `RateKey`                                    |
| `HotelPriceCheckRQ` (v5.0.0)                            | 25  | `RateKey` → `BookingKey`                                            |
| `PassengerDetailsRQ` (3.4.0)                            | 4   | Nombres, tipo de pasajero, contacto, **grupos**                     |
| `OTA_AirBookRQ` (v2.2.0)                                | 4   | _Sell_: vender el segmento en la AAA                                |
| `EnhancedEndTransactionRQ` (1.0.0)                      | 4   | _End transaction_: materializa el PNR y **devuelve el localizador** |
| `Sabre_OTA_ProfileCreateRQ` / `EPS_EXT_ProfileCreateRQ` | 4   | Crear perfil de prueba                                              |
| `UpdatePassengerNameRecordRQ` (1.1.0)                   | 3   | Añadir un segmento de hotel CSL a un PNR existente                  |
| `GetVehAvailRQ` (v2.0.0)                                | 2   | Disponibilidad coche                                                |
| `VehPriceCheckRQ`                                       | 1   | → `BookingKey` de coche                                             |

### 9.2 La secuencia canónica de construcción de PNR

```
SessionCreateRQ            (ATH: Username + Password + Organization=PCC + Domain=DEFAULT)
   └─ OTA_AirAvailRQ       → FlightNumber, Origin/Destination reales
   └─ PassengerDetailsRQ   → nombres, PassengerType, ContactNumbers, GroupInfo
   └─ OTA_AirBookRQ        → sell del FlightSegment (Status="GK"/"NN", NumberInParty=N)
   └─ EnhancedEndTransactionRQ → <ItineraryRef ID="..."> = el PNR
   └─ [REST] getBooking → bookingSignature
   └─ [REST] modifyBooking
   └─ [REST] getBooking
SessionCloseRQ
```

[V] — verificado idéntico en las **cuatro** familias de
`ModifyBooking / Group booking modification flows`: `Add (ADT + INF)`, `Update (Name ADT + INF)`,
`Update (Type ADT + INF)`, `Delete (ADT + INF)`, 8 requests cada una.

> **Corolario que corrige a `05-get-modify-cancel-booking.md`:** el flujo de **grupo** NO es `modifyBooking`
> REST puro. Requiere **cuatro mensajes SOAP en sesión ATH** antes de poder llamar a
> `getBooking`/`modifyBooking`. El bloque `travelersGroup` del `ModifyBooking` es sólo el último
> tramo.

### 9.3 Los cuatro mensajes, con su payload real

**`SessionCreateRQ`** — la sesión ATH. El PCC va en `<Organization>`:

```xml
<SOAP-ENV:Header>
  <MessageHeader …><From><PartyId>Agency</PartyId></From>
    <To><PartyId>Sabre_API</PartyId></To>
    <ConversationId>2019.09.DevStudio</ConversationId>
    <Action>SessionCreateRQ</Action></MessageHeader>
  <Security …><UsernameToken>
      <Username>{{username}}</Username><Password>{{password}}</Password>
      <Organization>{{pcc}}</Organization><Domain>DEFAULT</Domain>
  </UsernameToken></Security>
</SOAP-ENV:Header>
<SOAP-ENV:Body>
  <SessionCreateRQ returnContextID="true"><POS><Source PseudoCityCode="{{pcc}}"/></POS></SessionCreateRQ>
</SOAP-ENV:Body>
```

> ⚠️ **Modelo de credenciales COMPLETAMENTE distinto al REST.** El REST usa OAuth2
> `client_credentials` (§1). El LLS usa **usuario + contraseña + PCC + dominio** en cada
> `SessionCreateRQ`, y devuelve un **token de sesión con estado** que hay que propagar en el
> `{{header}}` de todos los mensajes siguientes y cerrar con `SessionCloseRQ`.
> **Para BYOC esto significa dos bóvedas de credenciales por nodo de tenant, no una.**

**`OTA_AirAvailRQ` 2.4.0** — de aquí sale el número de vuelo real:

```xml
<OTA_AirAvailRQ Version="2.4.0" xmlns="http://webservices.sabre.com/sabreXML/2011/10" ReturnHostCommand="true">
  <OptionalQualifiers><FlightQualifiers><VendorPrefs>
      <Airline Code='{{airline_code}}'/></VendorPrefs></FlightQualifiers></OptionalQualifiers>
  <OriginDestinationInformation>
    <FlightSegment DepartureDateTime="{{start_date}}">
      <DestinationLocation LocationCode="{{to_airport_code}}"/>
      <OriginLocation LocationCode="{{from_airport_code}}"/>
    </FlightSegment>
  </OriginDestinationInformation>
</OTA_AirAvailRQ>
```

El script extrae
`OTA_AirAvailRS.OriginDestinationOptions[0].OriginDestinationOption[0].FlightSegment[0].$.FlightNumber`.

**`PassengerDetailsRQ` 3.4.0** — nombres y, crucialmente, **grupos**:

```xml
<PassengerDetailsRQ haltOnError="true" ignoreOnError="true" version="3.4.0"
                    xmlns="http://services.sabre.com/sp/pd/v3_4">
  <TravelItineraryAddInfoRQ>
    <AgencyInfo><Ticketing TicketType="7TAW"/></AgencyInfo>
    <CustomerInfo>
      <ContactNumbers><ContactNumber NameNumber="1.1" Phone="817-555-1212" PhoneUseType="H"/></ContactNumbers>
      <PersonName><GroupInfo Name="GROUP A" NumSeatsRemaining="3"/></PersonName>
      <PersonName NameNumber="2.1" PassengerType="ADT"><GivenName>JOE</GivenName><Surname>DOE</Surname></PersonName>
      <PersonName NameNumber="3.1" PassengerType="ADT"><GivenName>JANE</GivenName><Surname>DOE</Surname></PersonName>
      <PersonName NameNumber="4.1" PassengerType="INF" Infant="true"><GivenName>JILL</GivenName><Surname>DOE</Surname></PersonName>
    </CustomerInfo>
  </TravelItineraryAddInfoRQ>
</PassengerDetailsRQ>
```

Aquí sí aparecen los conceptos que el REST oculta: `NameNumber` **`1.1`, `2.1`, `3.1`** (el sufijo
real del PNR, que en la respuesta REST se llama `nameAssociationId`, §6.1), `PhoneUseType`,
`Infant="true"`, y **`<GroupInfo Name="GROUP A" NumSeatsRemaining="3"/>`**, que **no tiene
equivalente en `CreateBookingRequest`**. También `TicketType="7TAW"` (ticketing time limit en
formato host).

**`OTA_AirBookRQ` 2.2.0** — el _sell_:

```xml
<OTA_AirBookRQ Version="2.2.0" xmlns="http://webservices.sabre.com/sabreXML/2011/10">
  <OriginDestinationInformation>
    <FlightSegment DepartureDateTime="{{start_date}}T11:50" ArrivalDateTime="{{start_date}}T12:10"
                   FlightNumber="{{flight_number}}" NumberInParty="3" ResBookDesigCode="Y" Status="GK">
      <DestinationLocation LocationCode="{{to_airport_code}}"/>
      <MarketingAirline Code="{{airline_code}}" FlightNumber="{{flight_number}}"/>
      <OperatingAirline Code="{{airline_code}}"/>
      <OriginLocation LocationCode="{{from_airport_code}}"/>
    </FlightSegment>
  </OriginDestinationInformation>
</OTA_AirBookRQ>
```

Aporta lo que `FlightToBook` no tiene: **`NumberInParty`** (asientos en bloque, base del grupo),
`ArrivalDateTime` obligatorio, `OperatingAirline` separado del `MarketingAirline`, y
`Status="GK"` (grupo confirmado).

**`EnhancedEndTransactionRQ` 1.0.0** — materializa el PNR y devuelve el localizador:

```xml
<EnhancedEndTransactionRQ version="1.0.0" xmlns="http://services.sabre.com/sp/eet/v1">
  <EndTransaction Ind="true"/>
  <Source ReceivedFrom="SWS TEST"/>
</EnhancedEndTransactionRQ>
```

```js
const pnr = result.Envelope.Body[0].EnhancedEndTransactionRS[0].ItineraryRef[0].$.ID;
pm.environment.set('pnr', pnr);
```

**`UpdatePassengerNameRecordRQ` 1.1.0** (3 requests) — añade un **segmento de hotel CSL a un PNR
existente**, dentro de los flujos `Form of Payment modifications (Hybrid)`. Es la vía LLS para el
multi-producto cuando `createBooking` ya no puede usarse porque el PNR existe.

### 9.4 En qué se diferencia del `createBooking` REST

|                           | REST `createBooking`                                                                             | Carril LLS                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Transporte                | JSON sobre HTTP                                                                                  | SOAP/XML                                                                                                                 |
| Auth                      | OAuth2 `client_credentials` (Bearer ATK)                                                         | `SessionCreateRQ` con **usuario+password+PCC** → token ATH con estado                                                    |
| Estado                    | **Stateless.** Limpia la AAA antes y después (§1.1)                                              | **Stateful.** Todo ocurre dentro de una AAA viva; hay que cerrarla                                                       |
| Nº de llamadas            | **1**                                                                                            | **≥6** (create, avail, details, book, EET, close)                                                                        |
| Atomicidad                | El API orquesta y aplica `errorHandlingPolicy`                                                   | **El cliente es el orquestador.** Si algo falla a mitad, la AAA queda sucia y **hay que hacer `SessionCloseRQ` sí o sí** |
| Modelo de datos           | Canónico Sabre (`BookTraveler`, `FlightToBook`…)                                                 | Crudo del host (`NameNumber`, `GroupInfo`, `TicketType="7TAW"`)                                                          |
| Capacidades exclusivas    | `errorHandlingPolicy`, NDC (`flightOffer`), CSL hotel por `bookingKey`, perfiles, `notification` | **Grupos** (`GroupInfo`/`NumberInParty`), `OperatingAirline` explícito, control fino del _sell_                          |
| Cobertura de la colección | 176 requests                                                                                     | 243 requests                                                                                                             |

> **Y no son alternativas independientes:** la documentación oficial dice que `createBooking` > **orquesta internamente** `PassengerDetailsRQ`, `OTA_AirBookLLSRQ` y `EnhancedEndTransactionRQ`
> (§1.2). El REST es el mismo carril con una capa de abstracción y `errorHandlingPolicy` encima.

### 9.5 Qué implica para nosotros

1. **Fase 1: NO integrar el carril LLS.** Todo lo que necesitamos (NDC, ATPCO, LCC, hotel CSL,
   coche) está en el REST. El coste de un cliente SOAP con gestión de sesión, pool y limpieza de
   AAA no se justifica todavía.
2. **Excepción conocida: los grupos.** `GroupInfo` / `NumberInParty` **no tienen equivalente en
   `CreateBookingRequest`**. Si el producto quiere vender grupos por Sabre, hay que abrir el
   carril LLS. **Es una decisión de scope, no un detalle técnico.**
3. **BYOC necesita dos formas de credencial por nodo**: `client_id`/`client_secret` (REST) y
   `username`/`password`/`PCC` (LLS). La bóveda de credenciales de
   `docs/platform/12-modelo-consolidador-y-plan.md` debe modelar las dos desde el principio,
   aunque sólo se rellene la primera.
4. **Si algún día se abre el carril:** la sesión ATH es un recurso con estado y con fugas. Exige
   `SessionCloseRQ` garantizado (patrón `finally`, o mejor una actividad Temporal con
   compensación), y **no puede compartirse entre tenants**.
5. **Reproducir en sandbox los flujos de Seat / SSR / Group modifications exige un
   `OTA_AirAvailRQ` previo** para obtener un número de vuelo real. Sin eso, esos requests fallan.

---

## 10. Preguntas que el contrato YA respondió (cerradas)

Se dejan listadas para que nadie las vuelva a abrir:

| Pregunta de la 1ª pasada                          | Respuesta                                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forma completa de la respuesta de `createBooking` | `{timestamp, confirmationId, booking, errors, request}` — §6.1                                                                                              |
| ¿Devuelve `bookingSignature`?                     | **No.** Sólo `getBooking` — §6.3                                                                                                                            |
| ¿Cómo se ve un error?                             | `{category, type, description, fieldPath, fieldName, fieldValue}`, con lista oficial de ~180 tipos — §6.4                                                   |
| Formato de `expiryDate` de tarjeta                | **`YYYY-MM`** — §3.7.2                                                                                                                                      |
| ¿`flightNumber` acepta string y número?           | El contrato dice **`integer` 1–9999** — §3.3.1                                                                                                              |
| ¿`tierLevel` string o entero?                     | **Entero** (`int32`) — §3.4.3                                                                                                                               |
| Default de `haltOnFlightStatusCodes`              | `NO, UC, US, UN, UU, LL, HL` — §5.2                                                                                                                         |
| Relación `travelers[].type` ↔ `passengerCode`    | `type` es **sólo de respuesta**; `passengerCode` es el código de tarifa — §3.4.1                                                                            |
| ¿`retentionEndDate` es ISO-8601 o fecha simple?   | **`YYYY-MM-DD`** — §3.10                                                                                                                                    |
| Catálogo de `title` que acepta BA                 | `TitleEnum`, **18 valores cerrados**, incluye `Congressman` — §3.4.0                                                                                        |
| `useCsl` vs `useCSL`                              | **`useCsl`**, default `true` — §3.8                                                                                                                         |
| `payment` vs `payments`                           | **Request `payment`, respuesta `payments`.** Es del contrato — §6.2                                                                                         |
| `validatingAirline` vs `validatingAirlineCode`    | **`validatingAirlineCode`**, dentro de `flightPricing[].qualifiers` (heredado de `TicketingQualifiers` por `allOf`). `validatingAirline` no existe — §3.3.2 |
| `reasonForIssuance` vs `Code`+`Name`              | Sólo **`reasonForIssuance`** — §3.4.4                                                                                                                       |
| ¿Máximo de `asynchronousUpdateWaitTime`?          | **10000 ms** — §3.1.1                                                                                                                                       |
| ¿Se puede pagar sin PAN?                          | **Sí en ATPCO/LCC y hotel, con `CASH` / `LATE`** — §7.6                                                                                                     |
| ¿Existe idempotency key?                          | **No.** Confirmado contra el contrato — §5.5                                                                                                                |

---

## Preguntas abiertas

1. **¿Se puede emitir un billete NDC pagando con `CASH`?** El contrato lo permite
   (`FulfillFormOfPaymentTypeEnum` incluye `CASH`) pero **ningún ejemplo lo ejercita**: el único
   fulfill NDC con `CASH` en el array selecciona la tarjeta (`primaryFormOfPayment: 2`). **Es la
   pregunta bloqueante del canal NDC por Sabre** — §7.5. Se resuelve con **una** llamada a CERT.
2. **¿Los tipos de infante funcionan en NDC?** Conflicto entre fuentes oficiales: el error
   `TRAVELER_TYPE_NOT_SUPPORTED` dice que `INF`/`INY`/`INS` «currently not supported for NDC
   booking», pero la colección ejercita `INS` en NDC con AY y `BookTraveler` los documenta sin
   reserva. §3.4.0.
3. **¿Cómo se reconcilia un `createBooking` cuyo HTTP se cortó?** No hay idempotency key, y
   `getBooking` sólo direcciona por `confirmationId`, que es justo lo que falta. ¿Sirve
   `notification.queuePlacement` para que el PNR huérfano caiga en una cola drenable? ¿Existe
   alguna API de búsqueda de PNR por remark fuera de Booking Management? §5.5.
4. **¿Cómo entra una tarjeta en el "wallet" de Sabre al que apunta
   `FulfillFormOfPayment.referenceId`?** Es la única referencia tokenizada del contrato. Si el
   alta del wallet exige que nosotros enviemos el PAN alguna vez, la vía no sirve. §3.7.4.
5. **¿Qué `documentSubType` hay que usar para CO, PE y BR?** El enum sólo declara `RUC`
   (Ecuador), `CUIT/CUIL` (Argentina) y `NIT` (Bolivia). No hay `CPF`/`CNPJ`. **Bloquea la
   facturación electrónica por esta vía.** ¿Hay otro campo (remarks fiscales, `accountingItems`)?
   §3.4.2.1.
6. **¿Un `modifyBooking` acepta el `cardNumber` enmascarado tal cual lo devuelve `getBooking`?**
   El pattern de `cardNumber` admite la forma enmascarada (`[0-9]X{7,14}[0-9]{4}`), lo que
   sugiere que sí; el script de la colección reinyecta el PAN real. Si acepta el enmascarado,
   **el ciclo de modificación deja de tocar PAN**. §3.7.2.
7. **¿`createBooking` devuelve 4xx alguna vez, o siempre 200 con `errors[]`?** El spec sólo
   declara `200` y todos los tests asertan `status(200)`. Sin esto no se puede afinar el circuit
   breaker. §6.4.
8. **¿Se puede combinar `flightOffer` (NDC) con `hotel` en una sola llamada?** El esquema no lo
   prohíbe (no hay `oneOf`) y `errorHandlingPolicy` tiene `DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR`,
   pero **cero ejemplos**. Si no se puede, un paquete NDC+hotel exige **dos PNRs** — impacto
   directo en el Package Studio (M2).
9. **¿Qué formato de teléfono acepta AF realmente?** El contrato admite `^[0-9+-]+$`, la guía de
   errores exige `+(CC)-(número)`, y el ejemplo de AF usa `11234+15551239999789`. §4.2.
10. **¿Valida Sabre el `basePrice` de los ancillaries contra el precio vivo?** El campo es
    `required` y lo fija el cliente. Si difiere del real: ¿rechaza, corrige, o acepta y falla al
    emitir el EMD? §3.4.4.
11. **¿Cuál es el techo real de `retentionEndDate`?** El error `INVALID_RETENTION_DATE_RANGE`
    devuelve el máximo en el mensaje (`%s`), pero no está documentado estáticamente. §3.10.
12. **¿`targetPcc` deja el contexto sucio entre llamadas concurrentes de tenants distintos?**
    El contrato avisa de que no revierte el contexto. Con un pool de conexiones compartido esto es
    un **riesgo de aislamiento multi-tenant**, contra el principio #6 de `CLAUDE.md`. §8.4.
13. **¿Se abre el carril LLS para vender grupos?** `GroupInfo` / `NumberInParty` no tienen
    equivalente REST. Es una decisión de scope de producto. §9.5.
14. **¿Cuánto tarda realmente `createBooking` en el peor caso?** El presupuesto teórico es de 25 s
    de esperas declaradas + latencia. Hay que medirlo en CERT para fijar el timeout y comprobar si
    el principio #1 (`< 2 minutos` a la venta) resiste.

---

## Riesgos

1. **[MAYOR — arquitectura, MITIGADO] PAN/CVV en el body.** `PAYMENTCARD` exige PAN y a menudo
   CVV (48 y 45 requests), lo que nos sacaría de SAQ-A. **Mitigación verificada:** operar con
   `CASH` en aéreo y `hotel.paymentPolicy: LATE`, cobrando por hosted checkout propio; poner
   `PAYMENTCARD` detrás de un feature flag apagado. **El riesgo baja de MAYOR-abierto a
   MAYOR-mitigado para ATPCO/LCC y hotel; sigue abierto para NDC** hasta la prueba de §7.5.
   Requiere decisión explícita del founder antes de escribir el ACL.

2. **[MAYOR — fuga de datos] `CreateBookingResponse.request` devuelve el payload íntegro.**
   Si el request llevó PAN, vuelve en la respuesta. **El cuerpo de respuesta es tan sensible como
   el de request.** Hay que redactarlo antes de loguear, cachear o persistir. Riesgo **nuevo**,
   no detectado en la primera pasada. §6.1.

3. **[MAYOR — consistencia] No hay idempotency key y la reconciliación no tiene camino claro.**
   `getBooking` sólo direcciona por `confirmationId`, que es lo que falta tras un timeout. Un
   corte de red durante los hasta 25 s de esperas declaradas deja un PNR que creemos fallido;
   reintentar duplicaría reserva y cargo. **Sin solución verificada.** §5.5, Pregunta abierta 3.

4. **[MAYOR — dominio] `OrderCreateResult` no puede representar éxito parcial.** Y ahora sabemos
   que el éxito parcial es un **modo declarado** del proveedor (`errorHandlingPolicy` con 6
   valores `DO_NOT_HALT_ON_*`), no una anomalía. Refactorizar el puerto (§5.4) **antes** de
   integrar multi-producto.

5. **[MAYOR — regulatorio, NUEVO] `documentSubType` no cubre Colombia, Perú ni Brasil.** El enum
   cerrado (`RUC`/`CUIT-CUIL`/`NIT`) está documentado para Ecuador, Argentina y Bolivia.
   Sin un identificador fiscal válido en el PNR, la facturación DIAN/SUNAT/NF-e no puede
   derivarse de la reserva. **Afecta a los tres mercados iniciales.** §3.4.2.1.

6. **[ALTO — aislamiento multi-tenant, NUEVO] `targetPcc` no revierte el contexto.** [VS] `:708`.
   Con conexiones reutilizadas entre tenants, una reserva puede acabar en el PCC de otra agencia.
   Contra el principio #6 de `CLAUDE.md`. Mitigación: contexto explícito en cada llamada y/o
   aislamiento de pool por tenant, con test de aislamiento cross-tenant en CI.

7. **[ALTO] `identityDoc` como objeto único bloquea las NDC principales.** AA, QF, UA, QR y SQ
   exigen PASSPORT + VISA + KTN + REDRESS + SFPD simultáneamente. Con el modelo actual sólo cabe
   uno: se falla el 100 % de las reservas internacionales a EE. UU.

8. **[ALTO] `paxType: 'CHD'` no existe en Sabre — es `CNN`.** Y falta `INS`/`INY`. Sin traducción
   en el ACL, todas las reservas con niños fallan. Agravado por `TRAVELER_TYPE_MISMATCH`: el
   `passengerCode` debe coincidir **exactamente** con el de `/offers/price`.

9. **[ALTO] Índices 1-based por todas partes.** `travelerIndex`, `flightIndices`,
   `travelerIndices`, `specialServiceIndex`, `primaryFormOfPayment`, `hotel.formOfPayment`,
   `car.travelerIndex`, `formOfPaymentIndices`, `infantTravelerIndex`, `employerIndex`. Un
   off-by-one **no revienta**: asigna el asiento al pasajero equivocado o cobra a la tarjeta
   equivocada, en silencio. El contrato lo castiga con `WRONG_FORM_OF_PAYMENT_INDEX`,
   `SPECIAL_SERVICE_INDEX_OUT_BOUNDS`, `INVALID_EMPLOYER_INDEX`, `SEATS_ASSIGNMENT_INVALID`.
   Aislar la conversión en un único punto del ACL y cubrirla con tests de propiedad.

10. **[ALTO, NUEVO] `retryBookingUnconfirmedFlights` puede subir el precio sin avisar.** [VS]
    `:5011`: cancela y **rebookea a la tarifa más baja disponible**, «may result in a price
    increase». Nunca activarlo sin `priceComparisons[]`. El request de la colección que lo usa
    no lo lleva. §5.2.

11. **[ALTO, NUEVO] Presupuesto de latencia de hasta 25 s de esperas declaradas.** 15 s de retry
    de estado ATPCO (5 intentos con delay progresivo) + hasta 10 s de
    `asynchronousUpdateWaitTime`, más la latencia de ~13 servicios internos. **Timeout HTTP
    mínimo 45 s.** Tensión directa con el principio #1 (`< 2 minutos` a la venta). §1.3, §3.1.1.

12. **[ALTO, NUEVO] Ancillaries no disponibles en NDC.** [VS] «Ancillary services are currently
    not supported for NDC bookings». Un paquete NDC + equipaje de pago no se arma en una llamada.
    Impacto en el Package Studio (M2). §3.4.4.

13. **[MEDIO] `createBooking` no devuelve `bookingSignature`.** Obliga a un `getBooking` extra
    antes de cualquier modificación, y la firma **caduca en cuanto la reserva cambia por
    cualquier vía**. Mitigación: `getBooking` asíncrono tras responder al usuario. §6.3.

14. **[MEDIO] Los ejemplos oficiales contradicen al propio contrato.** `flightNumber` como string
    en 20 requests, `tierLevel` como string, `retentionEndDate` como ISO-8601 completo,
    `issuesCode` vs `issueCode`, `useCSL`, `payments` en el request, `reasonForIssuanceCode`.
    **Escribir el ACL contra los ejemplos garantiza campos ignorados en silencio.** Regla: el
    `.yml` manda sobre el `.json` de la colección.

15. **[MEDIO] Sabre no valida coherencia entre traveler y documento.** Los propios ejemplos
    oficiales tienen `birthDate` distinto en el traveler y en su pasaporte. La validación cruzada
    es nuestra, en Zod, en el borde. §7.8.

16. **[MEDIO] `basePrice` de ancillaries lo fija el cliente.** Nuestro cache de búsqueda
    (`apps/api/src/search/memory-cache.adapter.ts`) puede servir un precio viejo; el contrato no
    dice qué hace Sabre si difiere. Puede acabar en un EMD impagable o en discrepancia BSP.

17. **[MEDIO] Aparente imposibilidad de combinar NDC + hotel en un PNR.** Cero ejemplos. Si se
    confirma, el Package Studio con vuelo NDC + hotel necesita dos reservas y una saga de
    compensación cruzada.

18. **[MEDIO] La comisión y la aerolínea validadora se declaran en DOS pasos y no sabemos cuál
    gana.** `TicketingQualifiers` es un bloque compartido: `createBooking` lo alcanza por `allOf`
    dentro de `flightPricing[].qualifiers`, y `fulfillFlightTickets` lo usa directo. El pricing
    waterfall del consolidador puede fijarse en cualquiera de los dos, pero **[?]** el contrato no
    dice qué ocurre si difieren. Lo que sí se **ignora en silencio** es ponerlos **fuera** de
    `qualifiers`, al nivel de `flightPricing[]` — que es lo que hace un request de la colección.
    §3.3.2.

19. **[BAJO] `agencyCustomerNumber` (DK number) no se puede borrar** una vez puesto. Formato:
    6, 7 o 10 caracteres alfanuméricos mayúscula. Validar antes de enviar.

20. **[BAJO] Normalización a mayúsculas en la respuesta.** El PNR devuelve nombres y emails en
    uppercase. Comparar case-sensitive contra lo enviado siempre fallará. §6.1.

21. **[RETIRADO] «Códigos de país inconsistentes ISO-2 / ISO-3».** El riesgo [BAJO] 13 de la
    primera pasada queda **anulado**: el contrato admite `^[A-Z]{2,3}$` explícitamente. La regla
    real es más fina — **en NDC, `residenceCountryCode` sólo admite ISO-2** — y ya está recogida
    en §3.4.2.

22. **[RETIRADO] «El ciclo modify obliga a reinyectar el PAN».** El riesgo MAYOR 2 de la primera
    pasada queda **rebajado a Pregunta abierta 6**: el pattern de `cardNumber` admite la forma
    enmascarada, así que reinyectar el PAN real es **una opción del ejemplo, no un requisito del
    contrato**. Falta confirmarlo en sandbox.
