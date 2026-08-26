---
titulo: 'Sabre — Contratos oficiales, modelo de errores y lagunas'
fecha: 2026-08-25
estado: revisado (3ª pasada — reconciliado contra los 21 contratos oficiales y las 81 páginas de documentación de developer.sabre.com)
Fuentes: ver 00-fuentes.md
---

# 09 — Contratos oficiales de Sabre, modelo de errores y lagunas que quedan

> **Este documento cambió de propósito.** La 1ª pasada lo escribió como "investigación web de lo que no sabíamos", apoyándose en espejos de terceros porque `developer.sabre.com` es una SPA que no se dejaba leer con `WebFetch`. Ahora **tenemos los contratos oficiales descargados directamente de Sabre**. El documento es el **mapa de referencia de esos contratos, el modelo de errores consolidado, y el inventario honesto de lo que sigue sin saberse**.
>
> Lo que sigue viniendo sólo de la vía web (proceso comercial, LATAM, costos, alternativas) se conserva y se refuerza; está en §5, §6 y §7.

---

## 0. Correcciones de procedencia y resolución de la crítica

### 0.1 Los tres errores de procedencia de la 1ª pasada — corregidos

**(a) «Las 4 respuestas guardadas están vacías» — ERA FALSO. Corregido.**

La 1ª pasada afirmaba, en su §1, que las 4 entradas `response` de la colección "existen como objetos `response` pero están vacías […] la colección tiene efectivamente CERO respuestas utilizables". **Es falso y esa frase queda eliminada.**

**VERIFICADO** — las 4 respuestas guardadas pesan 16.479 bytes de cuerpo JSON cada una y están extraídas en `evidence/responses/*.json`. Las cuatro son la misma llamada `/v1/orders/view` en distintos flujos de `ModifyBooking`. La única confusión legítima es que el atributo `code` de Postman viene `undefined` (no se guardó el status HTTP), pero **el `body` sí está**. Contenido real del payload:

```jsonc
{ "order": {
  "id": "4e54071d6c2d483c808f8a09f38f6bbc",
  "pnrLocator": "TOSGCZ",
  "orderOwner": "1S",
  "orderItems": [ { "id": "1", "externalId": "PoP98BD9F8A-6BD3-4A7D-953E-1-1",
      "externalOrderRefId": "beb6cb29-…", "creationDateTime": "2019-03-27T15:37:06",
      "ticketingTimeLimit": "2019-04-19T20:37:00",
      "fareDetails": [ { "fareIndicatorCode": …, "paxRefIds": […],
          "price": { "baseAmount": {"amount":"109.77","code":"USD"},
                     "totalTaxAmount": {"amount":"36.83","code":"USD"},
                     "taxBreakdowns": [ {"amount":{"amount":"5.60","code":"USD"},
                                         "countryCode":"US","taxCode":"AY",
                                         "description":"US September 11th Security Fee"} ] },
          "fareComponents": […] } ],
      "price": { "totalAmount": {"amount":"146.60","code":"USD"}, "totalTaxAmount": {} },
      "services": […], "offerItemId": …, "externalOfferItemId": … } ],
  "contactInfos": [ {"id":"CI-1","phones":[{"number":"6069871234"}],
                     "emailAddresses":[{"address":"test@sabre.com"}]} ],
  "products": […],
  "passengers": [ {"id":"Passenger1","typeCode":"ADT","contactInfoRefId":"CI-1",
                   "birthdate":"1977-03-01","givenName":"PAM","surname":"THOMPSON"} ],
  "journeys": [ {"id":"FGTID…","segmentRefIds":["Isgm52C50"]} ],
  "segments": [ {"id":"Isgm52C50",
                 "departure":{"locationCode":"DEN","stationName":"Denver Intl Apt, US",
                              "scheduledDateTime":"2019-04-20T20:36:00"},
                 "arrival":{"locationCode":"DFW","scheduledDateTime":"2019-04-20T23:28:00"},
                 "marketingCarrier":{"carrierCode":"UA","carrierName":"United Airlines",
                                     "flightNumber":338}} ],
  "priceClasses": [ {"id":"BasicEconomy","code":"1_basiceco","name":"Basic Economy"} ],
  "customerNumber": …, "paymentTimeLimit": "2019-04-19T20:37:00",
  "externalOrders": [ {"id":"beb6cb29-…","systemId":"UAD","externalOrderId":"1337155P2",
                       "bookingReferences":[{"id":"L4D79U","carrierCode":"F1"},
                                            {"id":"MFFPXC","carrierCode":"UAD"}]} ],
  "totalPrice": { "totalAmount": {"amount":"146.60","code":"USD"} } } }
```

Tres consecuencias que hay que propagar al resto del corpus:

1. **`Money` canónico de Sabre = `{ amount: string, code: string }`**. `amount` es **string decimal, no número** (`"146.60"`), y la moneda va en `code`, **no** en `currencyCode`. El mapper debe parsear a decimal con precisión, nunca a `float`.
2. **`scheduledDateTime` viene SIN offset ni `Z`** (`"2019-04-20T20:36:00"`). Es hora local del aeropuerto y hay que tratarla como _naive local time_; convertirla asumiendo UTC produce errores de hasta ±14 h.
3. **Hay objetos Money vacíos**: `orderItems[0].price.totalTaxAmount` es `{}`. Un schema Zod que exija `{amount, code}` en toda estructura Money **fallará contra un payload real de Sabre**. Los Money anidados deben ser opcionales/laxos en el borde y estrictarse después.

Este body debe recuperarse como **fixture** de test del ACL (`providers/sabre/src/fixtures/orders-view-200.json`, anonimizado) — es la única evidencia de respuesta real que salió de la colección.

**(b) Front-matter con fuente falsa — corregido.** La 1ª pasada citaba `EXTERNAL_AGENCY.postman_collection.json` como fuente. Ese archivo es la colección de **LATAM NDC** (160 requests, `sandbox.api.latam.com/ndc/v192/*`) y no tiene nada que ver con Sabre. La fuente Sabre es `sabre/Booking Management API v2026.04.postman_collection.json` (1.077 requests). El front-matter ahora remite a `00-fuentes.md`, como el resto del corpus.

**(c) El carril SOAP/LLS existe y la 1ª pasada lo ignoró.** **VERIFICADO** — 243 de los 1.077 requests van a `{{soap_endpoint}}`. Recuento propio por tipo de mensaje sobre `requests.jsonl` (primer elemento `*RQ` del body):

| Mensaje SOAP/LLS                            | Requests |
| ------------------------------------------- | -------- |
| `SessionCreateRQ`                           | **73**   |
| `SessionCloseRQ`                            | 61       |
| `OTA_AirAvailRQ`                            | 30       |
| `GetHotelAvailRQ` (ns `hotel/avail/v5_0_0`) | 26       |
| `HotelPriceCheckRQ`                         | 25       |
| **`GetAncillaryOffersRQ`**                  | **6**    |
| `PassengerDetailsRQ`                        | 4        |
| `OTA_AirBookRQ`                             | 4        |
| `EnhancedEndTransactionRQ`                  | 4        |
| `Sabre_OTA_ProfileCreateRQ`                 | 4        |
| `UpdatePassengerNameRecordRQ`               | 3        |
| `GetVehAvailRQ`                             | 2        |
| `VehPriceCheckRQ`                           | 1        |
| **Total**                                   | **243**  |

**Corrijo aquí a la 2ª pasada de este mismo documento**, que daba `SessionCreateRQ = 50` y un cubo de "29 sin `*RQ` detectable". Ninguna de las dos cifras se reproduce: **los 243 requests tienen un `*RQ` identificable**, y `SessionCreateRQ` son 73. La causa del error merece quedar registrada: **sólo esos 73 llevan el sobre SOAP completo inline** (son los que tienen que transportar el `<UsernameToken>`); los otros 170 usan una plantilla `{{header}}` y sólo llevan el cuerpo del mensaje. Un contador que buscara `<soap-env:Body>` veía 73 y dejaba 170 fuera.

Y aparece un tipo que nadie había contado: **`GetAncillaryOffersRQ` (6 requests SOAP)**, contraparte stateful de los 3 requests REST `/v2/offers/getAncillaries`. El flujo de ancillaries está en la colección **por los dos carriles a la vez**.

> **Hallazgo estructural: el carril SOAP no es un anexo legacy, es la maquinaria que hay debajo del REST.** Las listas oficiales de errores de Booking Management **nombran los servicios LLS que ejecuta por dentro**: `OTA_AirBookLLSRQ`, `OTA_CancelLLSRQ`, `ContextChangeLLSRQ`, `OTA_AirPriceLLSRQ`, `RefundTicketLLSRQ`, `VoidTicketLLSRQ`, `DesignatePrinterLLSRQ`, `SessionCloseRQ`, `GetReservationRQ`, `EnhancedHotelBookRQ`, `AirTicketRQ`, `StructureFareRulesRQ`, `GetAncillaryOffersRQ`, `ProfileToPNRRQ`, `TKT_ElectronicDocumentServicesRQ` (VERIFICADO-SPEC: `help/booking-management-api-v1/help-documentation-{create,cancel,get,refund,void}-booking*-error-list.txt`).
>
> **Confirmación independiente del propio catálogo de Sabre:** `help/get-vehicle-availability-v2/_productDetails.json` declara `properties.counterparts = [{"uri":"soap-api/car-shopping-get-vehicle-availability"}]`. Es decir, **Sabre publica explícitamente que un producto REST tiene un producto SOAP contraparte**, y lo hace en su propio catálogo.
>
> Consecuencia práctica: muchos errores de Booking Management son _pass-through_ de un servicio SOAP interno (`DOWNLINE_SERVICE_ERROR`, `DOWNLINE_SERVICE_FAILURE`, `*_PROBLEM`), y por eso llevan `%s` con texto del servicio subyacente. **No se pueden clasificar por código: hay que clasificarlos por `category`.**

### 0.2 Hallazgos de la crítica — resueltos y refutados

| #     | Hallazgo                                                                                                                                                                                      | Resolución                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 y 4 | Conteos falsos: `/v1/orders/view` = 8, familia Offers&Orders = "8+1", tabla incompleta                                                                                                        | **ACEPTADO Y CORREGIDO.** Recuento propio sobre `requests.jsonl`: `/v1/orders/view` = **4**, `/v1/orders/create` = **0**, `/v1/orders/change` = **1**. La tabla completa (28 filas, suma exacta **1.077**) está en §1.3 e incluye `getseats` (32), `/v3/offers/shop` (26), `fulfillFlightTickets` (19), `checkFlightTickets` (16), `/v1.3.0/air/ticket` (6) y los 26 requests que apuntan a variables `*_endpoint` no definidas                                                                                                                                                                                                                                                                                                                                     |
| 2     | La latencia n=1/2021 se propagó al doc 10 sin caveats                                                                                                                                         | **ACEPTADO.** El dato se degrada aquí a `[TERCERO — n=1, 2021, CERT, host api-crt.cert.havail.sabre.com, distinto del nuestro]` y **deja de ser el sustento** de la saga durable. El sustento pasa a ser el contrato: `asynchronousUpdateWaitTime` con `maximum: 10000` ms (VERIFICADO-SPEC: `booking-management-v1.yml:714-722`) y el warning `UNABLE_TO_RETRIEVE_TICKETS` (§3), que son evidencia de contrato, no medición ajena                                                                                                                                                                                                                                                                                                                                  |
| 3     | «Las 4 respuestas están vacías» es falso                                                                                                                                                      | **ACEPTADO.** Ver §0.1(a); la frase está eliminada y el payload documentado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5     | El bloque de 7 líneas `pm.environment.set` que traía la versión anterior de §2 mezcla líneas que no existen, y `fareDetails[].price.totalAmount` contradice la respuesta real                 | **ACEPTADO PARCIALMENTE.** Ese bloque queda eliminado (ya no hace falta: tenemos el payload real). **Confirmo el punto de fondo:** `fareDetails[].price` lleva `baseAmount` + `totalTaxAmount` + `taxBreakdowns[]`, **no** `totalAmount`. **Matizo un extremo:** `order.orderItems[].price.totalAmount` y `order.externalOrders[0].externalOrderId` **sí existen** — no en un script, sino en el cuerpo real de la respuesta guardada (§0.1). El crítico grepeó los scripts; el campo vive en el body                                                                                                                                                                                                                                                               |
| 6     | Cifras marcadas VERIFICADO no reproducibles (`CompressResponse`, `AirStreaming`/`MaxItinsPerChunk`, `REQUEST_THROTTLED`, `Offer.timeToLive`, propiedades de `Booking`, 444 KB del yml de BFM) | **REFUTADO CON EVIDENCIA NUEVA, salvo dos casos.** El crítico grepeó **la colección**, donde efectivamente no están; **están en los contratos oficiales**: `CompressResponse` → `bargain-finder-max-v5.yml:5470` y `:5512-5521`; `AirStreaming`/`MaxItinsPerChunk` → `:5462-5468` y `:5492-5511`; `Offer.timeToLive` + `source` → `:8226-8244`; propiedades de `Booking` → `booking-management-v1.yml` (270 definiciones); tamaño del yml de BFM v5 = **444.880 bytes**, exacto. `ERR.2SG.GATEWAY.REQUEST_THROTTLED` / "Active token count is exceeded" → `help/errors.txt:198-215`. **Los dos casos que el crítico gana:** el mock de 967 KB / 50 itinerarios y las latencias de 2021 siguen sin ser reproducibles y quedan marcados `[TERCERO — no reproducible]` |

### 0.3 Autocorrecciones de la 2ª pasada de este documento

Esta pasada verificó una por una las afirmaciones de la anterior. **Seis no resistieron el grep y se corrigen aquí en voz alta**, porque un documento que sólo corrige a otros y nunca a sí mismo no es fiable:

| Afirmación de la 2ª pasada                                                                                                                                    | Qué dice la evidencia                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «El spec v5 no documenta el comportamiento por defecto de `MultipleSourcePerItinerary`; la afirmación de la 1ª pasada queda como [TERCERO — no reproducible]» | **FALSO. La 1ª pasada tenía razón.** `bargain-finder-max-v5.yml:5473-5478`: _"This allows you to specify what to do if the same journey is returned from ATPCO and NDC channels. **By default, the cheaper will stay.** In the case of a tie, the previously described solution will be in place."_ Idéntico en `bargain-finder-max-v4.yml:3196-3200`. **Pasa a VERIFICADO-SPEC** y sale de Preguntas abiertas (§4.4, §7.2)      |
| Conteos de schemas: BFM v5 = 290, v4 = 278, v3 = 259, Get Hotel Avail v4 = 121 / v3 = 6                                                                       | **Inflados.** Recuento de claves de primer nivel bajo `components.schemas` / `definitions`: v5 = **130**, v4 = **121**, v3 = **90**, hotel avail v4 = **117**, v3 = **2**. Contraste independiente en v5: 131 `$ref` distintos. Tabla corregida en §1.1                                                                                                                                                                          |
| «`help/errors.txt`, `offer-price-ndc-v1/v1-errors.txt` y `flight-reshop-api-1.0/1.0-errors.txt` son **idénticas byte a byte**»                                | **Exagerado.** `md5sum`: `errors.txt` y `booking-management-api-v1/v1-errors.txt` sí son idénticas (`7234dfbc…`). Las otras dos **difieren**: Offer Price omite el bloque final de Booking Management; Flight Reshop además reescribe dos descripciones de 500 y borra la línea del `grant_type`. **El cuerpo de la tabla del gateway sí es el mismo en las tres** — que es lo que importa — pero la afirmación fuerte era falsa |
| «702 filas documentadas, 450 `type` distintos»                                                                                                                | **Cortos.** Parseo por bloques de las 9 listas: **746 filas** y **457 `type` distintos**. Detalle por método corregido en §2.3                                                                                                                                                                                                                                                                                                   |
| «Las 17 `category` que existen»                                                                                                                               | **Incompleto, y con un hallazgo importante detrás.** Los literales reales son **21**, e incluyen **tres categorías compuestas** — `CANCELLATION_ERROR/WARNING` (36 filas), `CHECK_ERROR/WARNING` (6) y `APPLICATION_ERROR/WARNING` (1) — que la 2ª pasada colapsó sobre sus categorías simples. Ver §2.3: no es un detalle de conteo, cambia el diseño del clasificador                                                          |
| «Cadencia de versiones, `_productDetails.json`, sección `release-notes`»                                                                                      | **Cifras correctas, cita mal.** No existe una clave `release-notes`. Las release notes están dentro de `navigation`, como URLs `…/release-notes/update/<version>-<fecha>.html`. Extraídas así, los números se confirman: Booking Management tiene **34 releases**, de `1.0 – 17-abr-2020` a `1.33 – 14-jul-2026`. Cita corregida en §1.1                                                                                         |

---

## 1. Inventario de los contratos oficiales

Todo lo de esta sección está **VERIFICADO-SPEC** con `grep`/`awk` sobre los `.yml` y sobre los `_productDetails.json`, no copiado de `00-fuentes.md`.

### 1.0 Nota de procedencia: el corpus creció de 15 a 21 mientras se escribía

`00-fuentes.md` documentó al principio **15** specs. El corpus congelado son hoy **21** (cifra canónica de `00-fuentes.md` §2): los 15 originales (descargados a las 14:45–14:48), **cuatro bajados a las 19:33** — `get-hotel-avail-v5.0.yml`, `get-ancillaries-airline-3.0.yml`, `get-hotel-details-v2.yml` y `stateless-ancillaries-api-1.0.yml` — y **dos más al reconciliar el sabor _agency_**: `get-ancillaries-agency-2.3.yml` y `manage-ancillary-1.1.yml`. Las páginas de documentación oficial convertidas a texto son **81** (`find specs/help -name '*.txt' | wc -l`); el recuento de 97 de una pasada anterior contaba los 110 archivos del árbol `help/` menos los 13 `_productDetails.json`, es decir metía también archivos que no son páginas.

**Esto cierra dos de las lagunas que este mismo documento declaraba abiertas** (Get Hotel Avail v5 y la familia de ancillaries) y obligó a actualizar `00-fuentes.md`, que ya publica 21/81 como cifras canónicas. Lo señalo explícitamente en vez de disimularlo: el corpus se movió mientras se escribía.

### 1.1 Los 21 specs

| Archivo                                 | `info.title`                                          | `info.version` | Formato       | Host / server declarado                                                                          | basePath             | Paths declarados                                                                                                                                           | Schemas |
| --------------------------------------- | ----------------------------------------------------- | -------------- | ------------- | ------------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `booking-management-v1.yml`             | Booking Management API                                | **1.33**       | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/v1/trip/orders`    | `/getBooking` `/createBooking` `/modifyBooking` `/cancelBooking` `/fulfillFlightTickets` `/checkFlightTickets` `/voidFlightTickets` `/refundFlightTickets` | **270** |
| `bargain-finder-max-v5.yml`             | Bargain Finder Max                                    | v5             | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com`                                                            | —                    | `/v5/offers/shop`                                                                                                                                          | 130     |
| `bargain-finder-max-v4.yml`             | Bargain Finder Max                                    | v4             | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com`                                                            | —                    | `/v4/offers/shop`                                                                                                                                          | 121     |
| `bargain-finder-max-v3.yml`             | Bargain Finder Max                                    | v3             | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/`                  | `/v3/offers/shop`                                                                                                                                          | 90      |
| `offer-price-ndc-v1.yml`                | Offer Price - NDC                                     | **1.5**        | OpenAPI 3.0.3 | `api.cert.platform.sabre.com` **y** `api.platform.sabre.com`                                     | `/v1/offers`         | `/price`                                                                                                                                                   | 75      |
| `flight-reshop-api-1.0.yml`             | Flight Reshop API                                     | **1.1**        | OpenAPI 3.0.3 | `https://{environment}.sabre.com`                                                                | `/v1/offers`         | `/flightReshop`                                                                                                                                            | 78      |
| `flightcheck-api-v1.yml`                | Sabre Flight Check API                                | 1.0            | OpenAPI 3.0.3 | `https://{environment}.sabre.com`                                                                | `/v1/offers`         | `/flightCheck`                                                                                                                                             | 71      |
| `get-seats-agency-3.0.yml`              | Get Seats Agency                                      | **3.1**        | OpenAPI 3.0.0 | `https://{environment}.sabre.com`                                                                | `/v3/offers`         | `/getseats/byNdcOrderId` `/getseats/byNdcOfferId` `/getseats/byReservationPayload`                                                                         | 68      |
| `get-seats-airline-3.0.yml`             | Get Seats Airline                                     | 3.0            | OpenAPI 3.0.0 | `https://{environment}.sabre.com`                                                                | `/v3/offers`         | `/getseats/byReservationPayload` `/getseats/byPnrLocator`                                                                                                  | 65      |
| **`get-ancillaries-agency-2.3.yml`**    | **Get Ancillaries** (sabor _agency_ — **el nuestro**) | **2.3**        | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com{basePath}` **y** `https://api.platform.sabre.com{basePath}` | `/v2/offers`         | `/getAncillaries`                                                                                                                                          | 50      |
| **`get-ancillaries-airline-3.0.yml`**   | **Get Ancillaries**                                   | **3.0**        | OpenAPI 3.0.3 | `https://{environment}.sabre.com`                                                                | `/v3/offers`         | `/getAncillaries/byReservationPayload` `/getAncillaries/byPnrLocator`                                                                                      | 65      |
| **`manage-ancillary-1.1.yml`**          | **Manage Ancillary**                                  | **1.1**        | OpenAPI 3.0.0 | `https://{environment}.sabre.com`                                                                | `/v1/ancillaries`    | `/add` `/remove` `/exchange`                                                                                                                               | 28      |
| **`stateless-ancillaries-api-1.0.yml`** | **Stateless Ancillaries API**                         | **1.0**        | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/v1/dc/ancillaries` | `/shop` `/add` `/remove`                                                                                                                                   | 94      |
| **`get-hotel-avail-v5.0.yml`**          | Get Hotel Avail                                       | **v5.0**       | OpenAPI 3.0.2 | `https://{environment}.sabre.com`                                                                | —                    | `/v5/get/hotelavail`                                                                                                                                       | **127** |
| `get-hotel-avail-v4.yml`                | Get Hotel Avail                                       | v4             | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com/`                                                           | —                    | `/v4.0.0/get/hotelavail`                                                                                                                                   | 117     |
| `get-hotel-avail-v3.yml`                | Get Hotel Avail                                       | v3             | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/`                  | `/v3.0.0/get/hotelavail`                                                                                                                                   | **2**   |
| **`get-hotel-details-v2.yml`**          | **Get Hotel Details**                                 | **v2**         | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/`                  | `/v2.0.0/get/hoteldetails`                                                                                                                                 | 2       |
| `hotel-price-check-v5.yml`              | Hotel Price Check                                     | v5             | OpenAPI 3.0.0 | `https://{environment}.sabre.com`                                                                | —                    | `/v5/hotel/pricecheck`                                                                                                                                     | 66      |
| `hotel-price-check-v4.yml`              | Hotel Price Check                                     | v4             | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com/`                                                           | —                    | `/v4.0.0/hotel/pricecheck`                                                                                                                                 | 62      |
| `get-vehicle-availability-v2.yml`       | Get Vehicle Availability                              | v2             | OpenAPI 3.0.0 | `https://api.cert.platform.sabre.com/`                                                           | —                    | `/v2.0.0/get/vehavail`                                                                                                                                     | 70      |
| `get-vehicle-availability-v1.yml`       | Get Vehicle Availability                              | v1             | Swagger 2.0   | `api.cert.platform.sabre.com`                                                                    | `/`                  | `/v1.0.0/get/vehavail`                                                                                                                                     | 167     |

Observaciones que corrigen o precisan `00-fuentes.md`:

- **La versión del slug ≠ la versión del contrato.** El slug `.../booking-management-api/v1` sirve la **1.33**; `.../flight-reshop-api/1.0` sirve la **1.1**; `.../get-seats-agency/3.0` sirve la **3.1**; `.../offer-price-ndc/v1` sirve la **1.5**. **Al pinnear versiones en el repo hay que guardar `info.version`, no el slug.**
- **`get-hotel-avail-v3.yml` y `get-hotel-details-v2.yml` tienen 2 definiciones cada uno**: son contratos prácticamente sin tipar (objetos libres). Como contrato de integración son **inútiles**. Para hoteles, el mínimo viable es **v5.0** (127 schemas), que además es lo que ejercita la colección.
- **Sólo `offer-price-ndc-v1.yml` declara servidor de producción** además del de CERT (`:12-17`). El resto sólo declara CERT o una plantilla `{environment}` (cuyo `enum` es `api.cert.platform` | `api.platform`). El `rest_endpoint` del entorno de la colección (`https://api.cert.platform.sabre.com`) coincide con el `host` declarado.
- **Cadencia de versiones** (VERIFICADO-SPEC, `help/<producto>/_productDetails.json`, URLs `…/release-notes/update/…` dentro de `navigation`):
  - **Booking Management: 34 releases**, de `1.0 – 17-abr-2020` a `1.33 – 14-jul-2026`; las tres últimas `1.31 – 20-ene-2026`, `1.32 – 24-mar-2026`, `1.33 – 14-jul-2026` → **una versión cada ~2-3 meses**.
  - Offer Price: `1.2 – 6-mar-2025`, `1.3 – 6-feb-2026`, `1.4 – 20-mar-2026`, `1.5 – 13-jul-2026`.
  - Flight Reshop: `1.0 – 31-ene-2026`, `1.1 – 16-jul-2026`. FlightCheck: `1.0 – 30-ene-2026`. **Ambos son productos de 2026.**
  - **BFM se mueve mucho más despacio**: v5 tiene 6 release notes desde jul-2023, la última `31-mar-2026`. Un contrato de búsqueda estable es una buena noticia para el mapper.
  - Get Hotel Avail: la nota `5.0 – 16-may-2024` vive, curiosamente, bajo el slug `rest-api/get-hotel-avail/v4.1`.

### 1.1.1 Los _flags_ comerciales del catálogo — evidencia de coste y de madurez

**VERIFICADO-SPEC**, `help/*/_productDetails.json` → `properties.flags` y `properties.tryOut`. Esto no está en ningún `.yml` y es material comercial de primer orden:

| Producto                                                                                                                                       | Flags                                     | `tryOut` (probar sin contrato) |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| **Bargain Finder Max v3/v4/v5**                                                                                                                | **`premium`**                             | **sí** (v4 y v5)               |
| **Flight Reshop 1.0**                                                                                                                          | **`premium`**, **`beta`**, `agenticReady` | no                             |
| FlightCheck v1                                                                                                                                 | `agenticReady`                            | **sí**                         |
| Get Hotel Avail v4                                                                                                                             | —                                         | **sí**                         |
| Booking Management, Offer Price, Get Seats, Get Ancillaries, Stateless Ancillaries, Hotel Price Check, Get Vehicle Avail, Get Hotel Avail v5.0 | —                                         | no                             |

Dos lecturas duras:

> **1. La búsqueda aérea es el producto `premium`.** BFM —el endpoint de mayor volumen y menor conversión de todo el sistema— es el único de la familia aérea marcado como premium. Es exactamente el punto donde un fee por llamada mal negociado hace inviable el modelo (§6, RS16). Que Sabre lo etiquete así en su propio catálogo **es la evidencia más concreta que tenemos de que la búsqueda se cobra aparte**.
>
> **2. Flight Reshop no sirve todavía para nuestro contenido.** Su flag `beta` trae descripción literal: _"This beta API is subject to change and **currently supports ATPCO content. NDC Reshop Shop Order is under development**."_ Nuestro contenido LATAM y Avianca es **NDC**. Traducción: **la reemisión y el cambio de vuelo vía Sabre no cubren hoy el contenido que más nos importa**, y el contrato que tenemos puede cambiar sin aviso. Esto degrada Flight Reshop de "contenido gratis para el roadmap" a "pieza no planificable todavía". Es riesgo nuevo (**RS18**).

### 1.2 Qué responses declara cada contrato — el hallazgo más importante del inventario

**VERIFICADO-SPEC** — recuento de códigos de respuesta declarados por operación en los 21 `.yml`:

| Spec                                     | Códigos declarados                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `booking-management-v1.yml`              | **200 × 8** (una por método). **Ningún 4xx ni 5xx**                     |
| `bargain-finder-max-v3/v4/v5`            | **200** y nada más                                                      |
| `flight-reshop-api-1.0.yml`              | **200** y nada más                                                      |
| `flightcheck-api-v1.yml`                 | **200** y nada más                                                      |
| `get-seats-agency-3.0.yml`               | **200 × 3**                                                             |
| `get-seats-airline-3.0.yml`              | **200 × 2**                                                             |
| `get-ancillaries-airline-3.0.yml`        | **200 × 2**                                                             |
| `stateless-ancillaries-api-1.0.yml`      | **200 × 3**                                                             |
| `get-ancillaries-agency-2.3.yml`         | **200** y nada más                                                      |
| `manage-ancillary-1.1.yml`               | **200 × 3**                                                             |
| `hotel-price-check-v5.yml`               | **200** y nada más                                                      |
| `get-hotel-avail-v5.0.yml`               | **200** y nada más                                                      |
| `hotel-price-check-v4.yml`               | 200, 400                                                                |
| `get-hotel-details-v2.yml`               | 200, 400                                                                |
| `get-hotel-avail-v4.yml` / `v3`          | 200, 400, 404                                                           |
| `get-vehicle-availability-v2.yml` / `v1` | 200, 400, 404                                                           |
| `offer-price-ndc-v1.yml`                 | 200, 400, 500 — **los tres con el mismo schema `OfferPriceResponseV1`** |

> **14 de 21 contratos declaran únicamente `200`** — el conteo anterior (12) quedó obsoleto al añadir
> `get-ancillaries-agency-2.3.yml` y `manage-ancillary-1.1.yml`, que también sólo declaran `200`. Esto **no**
> significa que Sabre no devuelva errores HTTP: significa que parte del modelo de error está fuera del contrato
> OpenAPI y parte viaja dentro del cuerpo de éxito. Cualquier codegen sin un clasificador de envelope por producto
> producirá un cliente **ciego a errores de negocio**. Ver §2.
>
> Corolario práctico para el ACL: **no generar el cliente HTTP desde el spec sin envolverlo a mano.** Se puede generar el _modelo de datos_ (tipos de request/response); no la política de errores.

### 1.3 Cobertura: qué llama la colección vs. qué contrato tenemos

**VERIFICADO** — recuento por URL sobre `requests.jsonl`. Las 28 filas suman exactamente **1.077**. **Esto sustituye la tabla errónea de la 1ª pasada.**

| URL de la colección                        | Requests | ¿Contrato oficial?                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{soap_endpoint}}` (SOAP/LLS)             | **243**  | No (WSDL, no lo tenemos)                                                                                                                                                                                                                                                                            |
| `/v1/trip/orders/getBooking`               | 192      | Sí — `booking-management-v1.yml`                                                                                                                                                                                                                                                                    |
| `/v1/trip/orders/createBooking`            | 169      | Sí                                                                                                                                                                                                                                                                                                  |
| `/v1/trip/orders/modifyBooking`            | 99       | Sí                                                                                                                                                                                                                                                                                                  |
| `/v2/auth/token`                           | 59       | **No** — sólo aparece como `tokenUrl` en `securityDefinitions`                                                                                                                                                                                                                                      |
| `/v1/offers/price`                         | 59       | Sí — `offer-price-ndc-v1.yml`                                                                                                                                                                                                                                                                       |
| `/v4/offers/shop`                          | 49       | Sí — `bargain-finder-max-v4.yml`                                                                                                                                                                                                                                                                    |
| `/v1/trip/orders/cancelBooking`            | 42       | Sí                                                                                                                                                                                                                                                                                                  |
| `/v1/offers/getseats`                      | 32       | **Desajuste de versión** — el spec declara `/v3/offers/getseats/by{NdcOrderId,NdcOfferId,ReservationPayload}`                                                                                                                                                                                       |
| `/v3/offers/shop`                          | 26       | Sí — `bargain-finder-max-v3.yml`                                                                                                                                                                                                                                                                    |
| `/v1/trip/orders/fulfillFlightTickets`     | 19       | Sí                                                                                                                                                                                                                                                                                                  |
| `/v1/trip/orders/checkFlightTickets`       | 16       | Sí                                                                                                                                                                                                                                                                                                  |
| `/v5/offers/shop`                          | 13       | Sí — `bargain-finder-max-v5.yml`                                                                                                                                                                                                                                                                    |
| `{{getBooking_endpoint}}`                  | 12       | Variable **no definida** en el entorno                                                                                                                                                                                                                                                              |
| `/v1/trip/orders/refundFlightTickets`      | 7        | Sí                                                                                                                                                                                                                                                                                                  |
| `{{createBooking_endpoint}}`               | 7        | Variable **no definida**                                                                                                                                                                                                                                                                            |
| `{{modifyBooking_endpoint}}`               | 6        | Variable **no definida**                                                                                                                                                                                                                                                                            |
| `/v1.3.0/air/ticket` (Enhanced Air Ticket) | 6        | **No**                                                                                                                                                                                                                                                                                              |
| `/v1/trip/orders/voidFlightTickets`        | 4        | Sí                                                                                                                                                                                                                                                                                                  |
| **`/v1/orders/view`**                      | **4**    | **No** (Offers & Orders NDC)                                                                                                                                                                                                                                                                        |
| `/v5/get/hotelavail`                       | 4        | **Sí, desde las 19:33** — `get-hotel-avail-v5.0.yml`                                                                                                                                                                                                                                                |
| `/v2/offers/getAncillaries`                | 3        | **Sí** — `get-ancillaries-agency-2.3.yml`, cuyo `servers[].basePath` es `/v2/offers` y cuyo path es `/getAncillaries` (`get-ancillaries-agency-2.3.yml:12-24`). El `get-ancillaries-airline-3.0.yml` es el sabor **airline** y **v3**: otro producto, no una versión posterior (`00-fuentes.md` §2) |
| `/v1/orders/change`                        | 1        | **No**                                                                                                                                                                                                                                                                                              |
| `/v1/offers/flightShop`                    | 1        | **No**                                                                                                                                                                                                                                                                                              |
| `/v5/hotel/pricecheck`                     | 1        | Sí — `hotel-price-check-v5.yml`                                                                                                                                                                                                                                                                     |
| `/v2.0.0/get/vehavail`                     | 1        | Sí — `get-vehicle-availability-v2.yml`                                                                                                                                                                                                                                                              |
| `/v1.0.0/veh/pricecheck`                   | 1        | **No**                                                                                                                                                                                                                                                                                              |
| `{{cancelBooking_endpoint}}`               | 1        | Variable **no definida**                                                                                                                                                                                                                                                                            |

Notas de lectura:

- **`/v1/orders/create` tiene CERO requests.** Sólo sobrevive como rama `case 'create'` en un script de colección. La familia "Offers & Orders NDC pura" son **5 requests** (4 `view` + 1 `change`), no 9. El "hallazgo estructural" de la 1ª pasada sobre las dos familias de reserva **sigue siendo correcto y sigue importando** —las dos formas de respuesta son incompatibles— pero el peso relativo es mucho menor: Booking Management es el 94 % del carril REST de reserva.
- **Criterio de conteo de esta tabla: por URL literal del request**, tal cual aparece en la colección, sin resolver variables. Es el criterio que hace que las 28 filas sumen exactamente 1.077.
- **26 requests apuntan a variables `*_endpoint` no definidas** (12 `getBooking` + 7 `createBooking` + 6 `modifyBooking` + 1 `cancelBooking`; ninguna de las cuatro variables existe en `BM API TEST CERT - EPR.postman_environment.json`). Esa es toda la discrepancia con **`05-get-modify-cancel-booking.md` §0**, que cuenta **por intención** —resolviendo esas variables a su endpoint— y da `getBooking` = 204 (192 + 12), `modifyBooking` = 105 (99 + 6) y `cancelBooking` = 43 (42 + 1). **Ambos conteos son correctos; miden cosas distintas.** No leerlos como una contradicción: usar el de este documento para cobertura de contratos y el del 05 para carga de trabajo por operación.
- **De los 21 contratos, la colección ejercita 9 por URL exacta** (Booking Management, BFM v3/v4/v5, Offer Price NDC, Get Ancillaries Agency 2.3, Get Hotel Avail v5.0, Hotel Price Check v5, Get Vehicle Availability v2), **1 con desajuste de versión** (Get Seats Agency 3.0 vs `/v1/offers/getseats`) y **deja 11 sin ejercitar**. De esos 11: cuatro son contenido de roadmap real — **Flight Reshop** (con la reserva de §1.1.1), **FlightCheck**, **Manage Ancillary 1.1** y **Get Hotel Details v2**; **Stateless Ancillaries 1.0** es un carril alternativo; cuatro son **versiones anteriores** de productos que sí se ejercitan (Get Hotel Avail v3 y v4, Hotel Price Check v4, Get Vehicle Availability v1); y dos son del **sabor _airline_**, que no nos aplica (Get Ancillaries Airline 3.0, Get Seats Airline 3.0). 9 + 1 + 11 = 21.

---

## 2. El modelo de error transversal de Sabre

Consolidado de las páginas oficiales de errores de todos los productos: `help/errors.txt`, `help/booking-management-api-v1/v1-errors.txt` y sus 9 listas por método, `help/offer-price-ndc-v1/v1-errors.txt`, `help/flight-reshop-api-1.0/1.0-errors.txt` (+ sus listas de error y warning), `help/get-hotel-avail-v4/v4-errors.txt`, `help/flightcheck-api-v1/errors-documentation-errors.html_*` y `help/stateless-ancillaries-api-1.0/1.0-errors.html`.

### 2.1 La arquitectura de dos capas — VERIFICADA-SPEC, no inferida

La 1ª pasada dedujo "cuatro familias de error" a partir de fixtures de terceros. **Sabre lo documenta oficialmente y son dos capas**, no cuatro familias (VERIFICADO-SPEC: `help/flightcheck-api-v1/errors-documentation-errors.html_Application_Layer`, que además nombra el patrón: _Remote Procedure Call_):

> **Transport Layer** — "Transport oriented errors are returned as HTTP statuses and can be accompanied by more details in the response to the JSON message."
> **Application Layer** — "Application oriented errors are **returned as HTTP status 200** and will always be accompanied by more details in the response to the JSON message."

**Capa de transporte** — objeto `Error`, campos oficiales:

| Campo       | Descripción oficial                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `status`    | Si la petición se procesó o no (`NotProcessed`)                                                                                        |
| `type`      | Tipo de error de aplicación o uno de la lista típica de Sabre (`Validation`, `Server Error`, `Service Unavailable`, `Gateway Timeout`) |
| `errorCode` | Código específico (`ERR.2SG.*`)                                                                                                        |
| `timeStamp` | Instante UTC — **`timeStamp`, con S mayúscula**                                                                                        |
| `message`   | Descripción humana                                                                                                                     |

**Capa de aplicación** — envoltorio `{ timestamp, errors[] }` (aquí **`timestamp` con s minúscula**; sí, conviven las dos grafías en la misma plataforma), y cada `Error`:

| Campo         | Descripción oficial                                                          |
| ------------- | ---------------------------------------------------------------------------- |
| `category`    | Agrupación de alto nivel: qué clase de problema (cliente o servidor) ocurrió |
| `type`        | Tipo específico de la aplicación                                             |
| `description` | Texto para que un desarrollador depure                                       |
| `fieldName`   | Nombre del parámetro implicado                                               |
| `fieldPath`   | Ruta del parámetro (`journeys[0].departureDate`)                             |
| `fieldValue`  | Valor origen del error                                                       |

Ejemplo oficial completo (VERIFICADO-SPEC, misma página):

```json
{
  "timestamp": "2026-07-03T07:29:11.347Z",
  "errors": [
    {
      "category": "BAD_REQUEST",
      "type": "INVALID_VALUE",
      "description": "Incorrect request data provided.",
      "fieldName": "Size must be between 1 and 25.",
      "fieldPath": "fare.programs[0].values",
      "fieldValue": "[AAA123], []"
    }
  ]
}
```

Coincide **exactamente** con el schema `Error` de Booking Management (`required: [category, type]`), y con `CreateBookingResponse.errors[]` ("This array is not displayed in successful responses"). Es decir: **la 1ª pasada acertó el fondo y ahora está confirmado oficialmente y generalizado a toda la plataforma, no sólo a Booking Management.**

**Además hay cuatro variantes que NO siguen ese molde** y hay que tratar aparte:

| Variante                           | Dónde                                   | Forma                                                                                                                                                              | Marca                                                                                                         |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| OAuth2 RFC 6749                    | `/v2/auth/token`                        | `{ error, error_description }`                                                                                                                                     | VERIFICADO (código de ejemplo oficial de Sabre)                                                               |
| `messages[]` con `severity`        | **BFM v3/v4/v5**                        | `MessageType`: `{ code, severity, type, shortCode, text, value, numberOfOccurences }`; `severity ∈ {Info, Warning, Error, Diagnostic, Header}`; `required: [code]` | VERIFICADO-SPEC: `bargain-finder-max-v5.yml:4303-4335`                                                        |
| `messages[]` con `type`            | **Offer Price NDC**                     | `Message`: `{ type ∈ {ERROR, WARNING, INFO}, message, code:int, service, system, additionalDescription }`; **requeridos `type`, `message`, `service`**             | VERIFICADO-SPEC: `offer-price-ndc-v1.yml:869-905`                                                             |
| Códigos **numéricos** de 4 dígitos | **Get Hotel Avail / Hotel Price Check** | `0322`, `5273`, `5276`… con `ErrorDetails` / `WarningDetails`                                                                                                      | VERIFICADO-SPEC: `help/get-hotel-avail-v4/v4-errors.txt` (**40 códigos**, enumerados y verificados uno a uno) |

> **Regla dura para el ACL de Sabre** (la más importante de todo el documento):
>
> ```
> éxito = HTTP 2xx
>   Y errors ausente/vacío                      (Booking Management, FlightCheck, Reshop, Get Seats, Get Ancillaries)
>   Y ningún messages[].severity == "Error"     (BFM v3/v4/v5)
>   Y ningún messages[].type == "ERROR"         (Offer Price NDC)
>   Y ningún ErrorDetails con código numérico   (hoteles)
> ```
>
> `axios`/`fetch` no lanzan en un 200. Sin esta regla, **una reserva fallida se registra como confirmada**. Es RS1 y sigue siendo el riesgo crítico.
>
> **Corolario del contrato de Offer Price:** `OfferPriceResponseV1` declara `anyOf: [required: [response], required: [messages]]` (`offer-price-ndc-v1.yml:106-115`) — es decir, **una respuesta válida puede traer `messages` y NO traer `response`**. Y los tres códigos (200/400/500) usan **el mismo schema**. Un parser que asuma `response.offers[]` presente revienta en el primer error de negocio.

### 2.2 Tabla del gateway de plataforma — insumo directo del circuit breaker

**VERIFICADO-SPEC.** El cuerpo de esta tabla es el mismo en `help/errors.txt`, `help/booking-management-api-v1/v1-errors.txt` (idéntica byte a byte, md5 `7234dfbc…`), `help/offer-price-ndc-v1/v1-errors.txt` y `help/flight-reshop-api-1.0/1.0-errors.txt` (estas dos con diferencias sólo cosméticas, ver §0.3) — confirmando que es el modelo **transversal** del gateway, común a todos los productos REST. La columna "Clasificación" es **[INFERIDO]**: es nuestra propuesta de diseño derivada de la resolución oficial de Sabre, no una afirmación de Sabre.

| HTTP    | Código / texto oficial                                                                                 | Significado                                                                | Resolución oficial de Sabre                                                                                                                   | Clasificación propuesta                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400     | `Bad Request` / "Invalid format for request"                                                           | Sintaxis o parámetros inválidos                                            | Verificar parámetros y `grant_type`                                                                                                           | **No reintentable** — bug nuestro. **No cuenta** para el breaker                                                     |
| 400     | `ERR.2SG.CLIENT.INVALID_REQUEST`                                                                       | Parámetros inválidos                                                       | Revisar documentación                                                                                                                         | **No reintentable**. No cuenta                                                                                       |
| 400     | `ERR.2SG.SCHEMA.INVALID`                                                                               | "The request couldn't be understood by the server due to malformed syntax" | Verificar formato y campos requeridos                                                                                                         | **No reintentable**. No cuenta                                                                                       |
| 401     | "Not authorized to make this request. Check access level…"                                             | El token no tiene nivel de acceso                                          | Verificar credenciales                                                                                                                        | **No reintentable**. Marcar `provider_account`                                                                       |
| 401     | `invalid_client`                                                                                       | **"TAM Pool exhausted"** o credenciales malas                              | Verificar credenciales **y detalles del TAM Pool**                                                                                            | **Ambiguo — ver aviso abajo**                                                                                        |
| 401     | "Credentials are missing or the syntax is not correct" / `ERR.2SG.SEC.MISSING_CREDENTIALS`             | Base64 mal construido / token ausente                                      | Verificar la construcción del base64                                                                                                          | **No reintentable**. No cuenta                                                                                       |
| 401     | "Wrong clientID or clientSecret" / `ERR.2SG.SEC.INVALID_CREDENTIALS`                                   | Credenciales incorrectas                                                   | Verificar password del client ID                                                                                                              | **No reintentable**. Deshabilitar la `provider_account` y alertar al tenant                                          |
| **403** | "Request is for a resource that is forbidden" / **`ERR.2SG.SEC.NOT_AUTHORIZED`**                       | **Credencial válida pero SIN entitlement para esta API**                   | "**Contact your Sabre account manager to verify access**"                                                                                     | **No reintentable, NO abre circuito.** Condición permanente de configuración: superficie en el panel BYOC del tenant |
| 403     | `ERR.2SG.CLIENT.SERVICE_UNKNOWN`                                                                       | URL o versión mal escrita                                                  | Verificar URL y segmentos de versión                                                                                                          | **No reintentable.** Bug nuestro, alerta a ingeniería. **No** es entitlement                                         |
| 404     | "Response does not contain any data"                                                                   | Sin datos **o** URL mal formada                                            | Usar menos filtros / verificar URL                                                                                                            | **No reintentable.** Trátalo como "sin resultados", nunca como caída                                                 |
| 405     | `Method Not Allowed`                                                                                   | Verbo HTTP incorrecto                                                      | Revisar documentación                                                                                                                         | **No reintentable.** Bug nuestro                                                                                     |
| 406     | `Not Acceptable`                                                                                       | `Accept` incompatible                                                      | —                                                                                                                                             | **No reintentable.** Bug nuestro                                                                                     |
| 413     | `ERR.2SG.CLIENT.INVALID_REQUEST` / "FULL head"                                                         | **URL demasiado larga**                                                    | "Reduce the number of request parameters in the URL. Separate parameters into multiple requests"                                              | **No reintentable** tal cual; **sí** reintentable tras trocear el request                                            |
| **429** | `temporarily_unavailable` / "too many requests"                                                        | **Límite interno excedido**                                                | "Wait at least 500 ms and resend"                                                                                                             | **Reintentable con backoff.** No abre circuito                                                                       |
| **429** | **"Active token count is exceeded"** / **`ERR.2SG.GATEWAY.REQUEST_THROTTLED`**                         | **Máximo de peticiones CONCURRENTES excedido**                             | "Contact your Sabre account manager to determine or increase your allocated **concurrent request limit** […] Wait at least 500 ms and resend" | **Reintentable con backoff + semáforo de concurrencia.** No abre circuito: es cuota, no caída                        |
| 500     | `Server Error` / `ERR.2SG.SEC.INTERNAL_PROCESSING_ERROR` / `ERR.2SG.GATEWAY.INTERNAL_PROCESSING_ERROR` | Condición inesperada en Sabre                                              | Esperar ≥500 ms y reenviar                                                                                                                    | **Reintentable acotado.** **Sí cuenta** para el breaker                                                              |
| **500** | **`ERR.2SG.GATEWAY.TIMEOUT`**                                                                          | Timeout en el gateway                                                      | Esperar ≥500 ms y reenviar                                                                                                                    | **Reintentable — pero ver aviso de idempotencia**                                                                    |
| 500     | `ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE`                                                            | El gateway no entiende la respuesta del proveedor upstream                 | "Contact the Sabre support desk" + reintentar                                                                                                 | **Reintentable 1 vez.** Sí cuenta. Si persiste, es rotura del proveedor, no de Sabre                                 |
| 500     | `ERR.2SG.GATEWAY.PROVIDER_CONNECTION_ERROR` / `ERR.2SG.PROVIDER_CONNECTION_ERROR`                      | Error de transporte hacia el proveedor upstream                            | Esperar ≥500 ms y reenviar                                                                                                                    | **Reintentable.** Sí cuenta                                                                                          |
| 503     | `Service Unavailable`                                                                                  | Servidor caído o en mantenimiento                                          | Esperar ≥500 ms y reenviar                                                                                                                    | **Reintentable.** **Sí cuenta — es el caso canónico de abrir circuito**                                              |
| 504     | `Gateway Timeout`                                                                                      | El servidor tardó demasiado                                                | Esperar ≥500 ms y reenviar                                                                                                                    | **Reintentable — con la misma reserva de idempotencia**                                                              |
| **200** | **`errors[]` no vacío**                                                                                | Fallo de negocio                                                           | —                                                                                                                                             | **No cuenta** para el breaker. **Sí** debe fallar la operación                                                       |
| **200** | **`messages[].severity == "Error"` (BFM) / `messages[].type == "ERROR"` (Offer Price)**                | Fallo de negocio                                                           | —                                                                                                                                             | **No cuenta.** Degradación parcial en el fan-out                                                                     |

Tres avisos que la tabla sola no transmite:

1. **`Wait at least 500 milliseconds`** es la única guía de backoff que Sabre publica, y la repite en **todas** las filas reintentables (13 ocurrencias en `help/errors.txt`). Es un **piso**, no una política: nuestro backoff debe ser exponencial con jitter arrancando en 500 ms, no un `sleep(500)` fijo — 20 clientes reintentando a los 500 ms exactos reproducen el 429 que causó el reintento.
2. **`ERR.2SG.GATEWAY.TIMEOUT` y `504` no son seguros de reintentar en operaciones de escritura.** Un timeout de gateway **no dice si la operación se ejecutó**. Reintentar un `createBooking` que expiró puede crear **dos PNR**. Regla: los 5xx sólo se reintentan automáticamente en operaciones de lectura (`getBooking`, `*shop`, `price`, `check*`); en `createBooking` / `fulfill` / `cancel` / `void` / `refund` el reintento tiene que pasar por la saga con clave de idempotencia y una reconciliación previa vía `getBooking`.
3. **`401 invalid_client` es ambiguo por diseño.** Sabre da dos causas para el mismo código: credenciales incorrectas (permanente) **o TAM Pool agotado** (transitorio, de capacidad). Nuestra clasificación no puede distinguirlas por el payload. Propuesta **[INFERIDO]**: tratar el primer `invalid_client` como transitorio (1 reintento tras re-auth), y sólo si vuelve a fallar marcar la credencial como rota. Deshabilitar una `provider_account` de un tenant por un TAM Pool saturado sería un falso positivo caro.

### 2.3 La capa de aplicación: el catálogo real de `category` / `type`

La 1ª pasada listaba esto como laguna ("la spec sólo da los ejemplos `BAD_REQUEST` / `REQUIRED_FIELD_MISSING`"). **Cerrada.** Parseo por bloques de las 9 listas oficiales de Booking Management: **746 filas** documentadas y **457 `type` distintos** (VERIFICADO-SPEC, `help/booking-management-api-v1/*-error-list*.txt` y `*-warning-list.txt`):

| Método                 | Filas documentadas                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Create Booking         | **257**                                                                               |
| Modify Booking         | **152**                                                                               |
| Cancel Booking         | 82                                                                                    |
| Fulfill Flight Tickets | 63 (+**7 warnings** en lista aparte)                                                  |
| Refund Flight Tickets  | 58 (incluye una sección final de _"errors stemming directly from downline services"_) |
| Get Booking            | 54                                                                                    |
| Check Flight Tickets   | 38                                                                                    |
| Void Flight Tickets    | 35                                                                                    |
| **Total**              | **746**                                                                               |

Y Flight Reshop añade **71 errores + 4 warnings** en sus propias listas.

**Los 21 literales de `category` que aparecen**, con su clasificación propuesta **[INFERIDO]**:

| `category`                       | Ocurrencias (BM) | Qué es                                                                                                                                                  | Clasificación                                                                                                              |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`                    | 335              | Datos del cliente mal formados o incoherentes                                                                                                           | **No reintentable.** Error de usuario o bug nuestro                                                                        |
| `APPLICATION_ERROR`              | 205              | Fallo en Sabre o en un servicio LLS downline                                                                                                            | **Reintentable acotado** (1-2 veces). Es el cubo de `TIMEOUT`, `DOWNLINE_SERVICE_*`, `FAULT_RESPONSE`, `ATH_TOKEN_FAILURE` |
| `WARNING`                        | 79               | Éxito parcial — ver §3                                                                                                                                  | **No falla la operación**, pero **sí** hay que persistirlo                                                                 |
| **`CANCELLATION_ERROR/WARNING`** | **36**           | **Categoría compuesta** — ver aviso abajo                                                                                                               | **Ambigua por documentación**                                                                                              |
| `RESOURCE_NOT_FOUND`             | 15               | Reserva/billete inexistente                                                                                                                             | **No reintentable.** 404 de negocio                                                                                        |
| `INVALID_DATA`                   | 15               | Incoherencia de negocio (p. ej. account code NDC sin `airlineCode`)                                                                                     | **No reintentable**                                                                                                        |
| `CANCELLATION_ERROR`             | 12               | Fallo específico de cancelación/void/refund                                                                                                             | **No reintentable automáticamente** — ver §3                                                                               |
| `UNAUTHORIZED`                   | 11               | Credencial sin permiso para un **sub-servicio** (no para la API entera)                                                                                 | **No reintentable.** Entitlement parcial → panel BYOC                                                                      |
| `REQUEST_NOT_ALLOWED`            | 9                | Operación no permitida en el estado actual de la reserva                                                                                                | **No reintentable**                                                                                                        |
| `INTERNAL_SERVER_ERROR`          | 6                | Excepción no controlada                                                                                                                                 | **Reintentable 1 vez.** Sí cuenta para el breaker                                                                          |
| **`CHECK_ERROR/WARNING`**        | **6**            | **Categoría compuesta**                                                                                                                                 | **Ambigua por documentación**                                                                                              |
| `CHECK_ERROR`                    | 5                | Fallo del chequeo de billetes                                                                                                                           | **No reintentable**                                                                                                        |
| `PROCESSING_WARNING`             | 5                | Warning de procesamiento en fulfill                                                                                                                     | **Intervención humana** — §3                                                                                               |
| `MISSING_DATA`                   | 1                | Falta un dato no bloqueante (p. ej. email para notificar)                                                                                               | Informativo                                                                                                                |
| `IGNORED_DETAILS`                | 1 (+4 en Reshop) | Un parámetro que enviamos fue **ignorado**                                                                                                              | **Señal de bug silencioso** — §3.4                                                                                         |
| `RESOURCE_RESTRICTED`            | 1                | Acceso a la reserva restringido por TJR                                                                                                                 | **No reintentable.** Configuración                                                                                         |
| `FORBIDDEN`                      | 1                | Customer code / PCC no permitido                                                                                                                        | **No reintentable.** Configuración                                                                                         |
| `EXTERNAL_SERVER_ERROR`          | 1                | Fallo del proveedor externo                                                                                                                             | Reintentable 1 vez                                                                                                         |
| **`APPLICATION_ERROR/WARNING`**  | **1**            | **Categoría compuesta**                                                                                                                                 | **Ambigua por documentación**                                                                                              |
| `DATA_INTEGRITY`                 | 1 (Reshop)       | Incoherencia de datos                                                                                                                                   | **No reintentable**                                                                                                        |
| **`APPLICATION_EROR`**           | **1**            | **Errata en la documentación oficial de Sabre** (falta la `R`), en `create-booking-error-list.txt:916`, tipo `UNABLE_TO_PRICE_FLIGHTS_COMPARISON_ISSUE` | **El matcher debe contemplar la errata.** Si Sabre la emite tal cual, un `switch` estricto la deja caer al `default`       |

> **Las tres categorías compuestas son un hallazgo nuevo y no son un detalle de formato.** `CANCELLATION_ERROR/WARNING` aparece 36 veces, siempre con tipos como `UNABLE_TO_CANCEL` sobre descripciones como _"Operation of ending transaction failed"_, _"Operation of cancel Sabre content failed"_, _"Response is empty"_.
>
> Significa que **el mismo `type` llega unas veces como error fatal y otras como warning**, y **la propia documentación de Sabre no dice cuándo es cuál**. Consecuencia directa para el ACL: **no se puede decidir la severidad a partir del `type`**; hay que leer el `category` que viene en el payload en cada respuesta, y prever que ese `category` sea uno de los tres compuestos si Sabre los emite literalmente. Y `UNABLE_TO_CANCEL` sobre "ending transaction failed" es precisamente uno de los casos de estado indeterminado de §3.1: si llega como warning y lo tratamos como éxito, damos por cancelada una reserva viva.
>
> **Diseño concreto para el ACL:** clasificar por `category` (21 literales, estables) y **no** por `type` (457 valores, con `%s` interpolado y errata incluida). El `type` va al log estructurado y al `domain_event`, nunca a un `switch`.
>
> **Y ojo con la asimetría:** `UNAUTHORIZED` en la capa de aplicación **no** es el `401` del gateway. Los `UNAUTHORIZED_ACCESS` de Get Booking son **entitlements de sub-servicios**: "The `fareOffers` could not be retrieved. The service `GetAncillaryOffersRQ` returned an authorization failure", "The `fareRules` could not be retrieved […] `StructureFareRulesRQ`", "Electronic document details […] `TKT_ElectronicDocumentServicesRQ` is available to **Sabre travel agency subscribers only**". Es decir: **`getBooking` puede devolver 200 con la reserva incompleta porque a nuestro PCC no le vendieron el sub-servicio de reglas tarifarias o de documentos electrónicos.** Esto es exactamente lo que rompe una post-venta en producción sin dar ningún error visible. Hay que detectarlo y mostrarlo.

### 2.4 Códigos numéricos de hoteles

**VERIFICADO-SPEC** — Get Hotel Avail / Hotel Price Check no usan `category`/`type` sino **40 códigos numéricos de 4 dígitos** (`help/get-hotel-avail-v4/v4-errors.txt`; lista completa verificada: `0001 0061 0102 0106 0161 0249 0263 0322 0364 0366 0392 0404 0408 0409 0414 0424 0448 0724 0767 0775 0788 0790 0822 0852 5024 5027 5029 5097 5099 5100 5259 5262 5266 5272 5273 5275 5276 5278 5300 5311`). Los que importan para el ACL y para BYOC:

| Código          | Significado                                                                                                                                                                                                                                               | Clasificación                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `0322`          | "No availability" — propiedad no disponible en esas fechas. _"Check the warning details to get more details on why property is not available"_                                                                                                            | **Sin resultados**, no error                                                    |
| `5311`          | Todas las propiedades/tarifas filtradas por **agency rules**                                                                                                                                                                                              | **Sin resultados** — pero indica configuración del tenant                       |
| `5262` / `5300` | Sin tarifas para la combinación pedida / tarifas negociadas no válidas para el PCC                                                                                                                                                                        | **Sin resultados** + señal de configuración                                     |
| **`5276`**      | **"Not authorized to switch to `<pcc>`"** — el PCC del POS no tiene **branch access relationship** con el PCC de sign-in. _"Add the correct branch access relationship as necessary, and then **wait for five (5) mins** for the changes to take effect"_ | **No reintentable de inmediato.** Es el muro del modelo consolidador — ver §5.3 |
| **`5275`**      | **"Aggregator disabled by PCC"** — la fuente de tarifas no está habilitada para el PCC. _"Ask your PCC admin to log in to the **HotelManager** application, enable the aggregator and load credentials […] wait for approximately **one (1) hour**"_      | **No reintentable.** Configuración por PCC                                      |
| `5099`          | PCC de sign-in no es alfanumérico de 4 caracteres y no hay PCC válido en POS                                                                                                                                                                              | **No reintentable.** Bug de configuración                                       |
| `0724`          | "Vendor response error" — múltiples escenarios; hay que leer `ErrorDetails`/`WarningDetails`                                                                                                                                                              | **Reintentable 1 vez**, luego soporte                                           |
| `0249`          | Rate key inválida — hay que regenerarla desde la respuesta de disponibilidad                                                                                                                                                                              | **No reintentable.** Rehacer el flujo shop→pricecheck                           |

> **Los códigos `5276` y `5275` cambian el diseño del onboarding hotelero**: la habilitación no es instantánea y tiene **latencia de propagación declarada** (5 min y ~1 h). Un wizard que valide credenciales "al guardar" dará falsos negativos. Hay que validar de forma diferida y reintentar.
>
> Y `5276` añade un matiz honesto que conviene no perder: _"In some cases, this error may be returned when it shouldn't. If this happens for more than five (5) mins, please contact webservices support."_ **Sabre admite que este error tiene falsos positivos.** Nuestra UI no debe decirle a la agencia "tu PCC no tiene permiso" en el primer intento.

---

## 3. Warnings: éxito con reservas, y cuáles exigen intervención humana

**Este es contenido nuevo: la 1ª pasada no tenía las listas de warnings.**

Sabre devuelve warnings en dos sitios: como filas con `category: WARNING` (o una de las tres compuestas `*/WARNING`) dentro de `errors[]`, y en listas de warnings dedicadas con sus propias categorías `MISSING_DATA` / `PROCESSING_WARNING` / `IGNORED_DETAILS` (Fulfill, 7; Reshop, 4).

### 3.1 Los que exigen intervención humana — sin excepción

**VERIFICADO-SPEC.** Cada uno de estos deja el sistema en un estado que **nuestro código no puede resolver solo**, porque la operación puede haberse ejecutado y no lo sabemos:

| Endpoint                     | `type`                                                      | Descripción oficial                                                                                                                                                                               | Por qué necesita a una persona                                                                                                         |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Fulfill**                  | `UNABLE_TO_RETRIEVE_TICKETS`                                | "The fulfillment process has not been completed in the requested time. **Verify booking details and/or audit trail reports (DQB) whether tickets were issued successfully** (confirmationId: %s)" | **Estado de emisión indeterminado.** Puede haber billete emitido y cobrado sin que lo sepamos. Reintentar = doble emisión              |
| **Fulfill**                  | `PARTIAL_FULFILLMENT`                                       | "At least one fulfillment operation was not processed correctly. Ticket issuance was unsuccessful due to a missing form of identification (FOID)"                                                 | **Emisión parcial**: parte del grupo con billete, parte sin                                                                            |
| **Fulfill**                  | `FULFILLMENT_NOT_CONFIRMED`                                 | "The fulfillment operation cannot be confirmed. No new tickets were found in the booking"                                                                                                         | Igual: indeterminado                                                                                                                   |
| **Fulfill**                  | `PRICE_CHANGE`                                              | "**The price change occurred. The new total price: %s**"                                                                                                                                          | El billete se emitió **a otro precio**. Decisión comercial: ¿se absorbe, se recobra, se anula?                                         |
| **Modify**                   | `UNABLE_TO_CONFIRM_MODIFICATION_STATUS`                     | "Modification request was sent successfully but **could not be confirmed**. Verify current booking status by the means of Get Booking method (confirmationId: %s)"                                | Modificación de estado desconocido                                                                                                     |
| **Create / Cancel / Modify** | `UNABLE_TO_RETRIEVE_BOOKING`                                | "**Booking was created successfully but could not be retrieved** (confirmationId)"                                                                                                                | **La reserva EXISTE en Sabre** pero no tenemos su contenido. Si el código la trata como fallo y reintenta, se crea una segunda reserva |
| **Cancel**                   | `NO_ITEMS_CANCELLED`                                        | "Nothing was cancelled — cancellation was interrupted due to errors"                                                                                                                              | Cancelación fallida y silenciosa                                                                                                       |
| **Cancel**                   | `UNABLE_TO_CANCEL` (36 filas, `CANCELLATION_ERROR/WARNING`) | "Operation of ending transaction failed" / "Operation of cancel Sabre content failed" / "Response is empty"                                                                                       | **Severidad ambigua por documentación** (§2.3). Puede llegar como warning sobre una cancelación que no ocurrió                         |
| **Void** / **Refund**        | `NO_TICKETS_VOIDED` / `NO_TICKETS_REFUNDED`                 | "No tickets voided" / "No tickets refunded"                                                                                                                                                       | El cliente cree que se le devolvió el dinero y no                                                                                      |
| **Refund**                   | `REFUND_RETRY_FAILED`                                       | "Temporary unable to process refund request for ticketNumber=%s"                                                                                                                                  | Reembolso pendiente                                                                                                                    |
| **Cancel**                   | `CONTEXT_CHANGE_PROBLEM`                                    | Fallo en `ContextChangeLLSRQ`                                                                                                                                                                     | **El contexto de PCC puede haber quedado cambiado** — ver §3.3                                                                         |
| **Create / Get / Modify**    | `UNABLE_TO_CHANGE_CONTEXT_FINISH_IGNORE`                    | "System could not revert context. **Manually finish or ignore the transaction, then revert context to the original pseudo city code**"                                                            | Sabre dice literalmente "manualmente"                                                                                                  |
| **Create / Get / Modify**    | `UNABLE_TO_CHANGE_CONTEXT_PLEASE_WAIT`                      | "System is still processing the transaction. **Please wait and manually revert context** to the original pseudo city code"                                                                        | Ídem                                                                                                                                   |

> **Requisito de producto que sale de aquí:** hace falta una **cola de excepciones operativas** —una bandeja donde caen las reservas en estado indeterminado, con el `confirmationId`, el warning literal y la acción sugerida—. No es opcional: son nueve tipos distintos de "puede que sí, puede que no" sobre dinero y billetes.
>
> **Con un detalle de implementación concreto:** encaja sobre `order_operations` (`db/migrations/0021_order_operations.sql`), pero esa tabla tiene hoy `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed'))`. **Añadir `needs_review` requiere una migración que altere el CHECK**, no basta con escribir el valor. Más una vista en el panel.
>
> **Y ninguno de estos puede reintentarse automáticamente.** La secuencia correcta es siempre: warning → `getBooking` de reconciliación → decidir. Nunca warning → reintento.

### 3.2 Warnings de degradación silenciosa — no bloquean, pero mienten

Los warnings de **Get Booking** son casi todos `RESOURCE_UNAVAILABLE`: "FareRules can not be populated because the ticket is voided, refunded or exchanged", "**Baggage Allowance cannot be returned for NDC flights**", "aircraftTypeCode, meals, durationInMinutes & distanceInMiles cannot be populated for flight", "Hotel chainName cannot be populated based on the chainCode", "Car location details for code: %s cannot be populated", "Unable to provide ticketStatusName"…

> **Peligro concreto:** un `getBooking` con estos warnings devuelve **200 con la reserva incompleta**. Si nuestro mapper canónico rellena con `null` y la UI muestra "sin equipaje incluido" cuando en realidad Sabre no pudo consultarlo, **le mentimos al vendedor sobre lo que compró el cliente**. Regla: distinguir _"Sabre dice que no hay"_ de _"Sabre no pudo saberlo"_, y en el segundo caso mostrar "información no disponible", no un valor vacío.
>
> Y hay uno específico de NDC: **"Baggage Allowance cannot be returned for NDC flights"** — el equipaje de vuelos NDC **no viene por `getBooking`**. Hay que sacarlo del `Offer` original (Offer Price sí lo trae, con `baggage[]` por pasajero y segmento) y persistirlo nosotros en el momento de la venta.

### 3.3 `targetPcc`: el mecanismo consolidador — y su trampa

**Esto cierra una de las preguntas abiertas más importantes de la 1ª pasada** ("¿Booking Management soporta `targetPCC` / cambio de contexto?"). **Sí.**

**VERIFICADO-SPEC** — `targetPcc` aparece en **8 schemas de request** de `booking-management-v1.yml` (líneas 257, 397, 495, 569, 642, 704, 873, 953) y en `flight-reshop-api-1.0.yml:4942`. Patrón `^[A-Z0-9]{3,4}$`, ejemplo `G7HE`. Descripciones oficiales:

- En `GetBookingRequest` (`:257-261`): _"The pseudo city code of the target destination in which the booking retrieval is requested."_
- En `CreateBookingRequest` (`:397-402`): _"Used to specify whether the API should change context to a desired pseudo city code. **Context is not reverted after the booking has been completed.**"_

> **Es exactamente el mecanismo que un consolidador necesita**: operar en nombre de la agencia cliente pasando su PCC en la request, sin cambiar de credencial. Confirma que el diseño BYOC de `12-modelo-consolidador-y-plan.md` es implementable con Sabre.
>
> **La frase exige cautela, pero no demuestra por sí sola persistencia entre llamadas ATK.** El contrato dice
> _"Context is not reverted after the booking has been completed"_; a la vez, las guías declaran Booking
> Management stateless y dicen que el AAA de ATH se limpia antes y después de cada operación. Por tanto, una fuga
> entre llamadas sessionless es **DESCONOCIDA**, no VERIFICADA. La defensa sigue siendo la misma: `targetPcc`
> explícito, caché por `provider_account` y prueba consecutiva A→B contra CERT.
>
> **Regla no negociable para el ACL de Sabre:** `targetPcc` es **obligatorio y explícito en cada request**, resuelto desde la `provider_account` del tenant. Nunca implícito, nunca heredado del estado de la sesión. Un test de aislamiento cross-tenant que dispare dos operaciones consecutivas con `targetPcc` distintos debe estar en CI.
>
> Y los cuatro `UNABLE_TO_CHANGE_CONTEXT_*` (§3.1) son los modos de fallo de este mecanismo: `UNAUTHORIZED` y `NOT_ALLOWED` ("User is unauthorized to change context for the desired PCC") son el **muro de branch access** del que también habla el código hotelero `5276`.

### 3.4 `IGNORED_DETAILS` — el warning que delata bugs nuestros

Reshop y Fulfill declaran la categoría `IGNORED_DETAILS`: _"The bookingId was ignored for the selected distribution model"_, _"The specified corporate ID program was ignored because its value does not match the required pattern: `[A-Za-z]{3}[0-9]{2}`"_, _"The cabin preference for the selected journey was not applied"_, _"The selected functionality cannot be applied to the NDC exchange content type"_.

> Sabre **acepta el request y devuelve 200**, pero **descartó parte de lo que pedimos**. Un corporate ID mal formado se ignora en silencio y el cliente pierde su tarifa negociada sin que nadie se entere. **`IGNORED_DETAILS` debe emitir `domain_event` y alertar a ingeniería**, aunque no falle la operación.

---

## 4. Límites operativos que declaran los contratos

### 4.1 Lo que los specs NO declaran — dicho explícitamente

**VERIFICADO-SPEC** — `grep -i "rate limit|ratelimit|throttl|requests per|Retry-After|X-RateLimit"` sobre los 21 `.yml`: **cero coincidencias**. `grep -i timeout`: sólo nombres de enum en `get-vehicle-availability-v1.yml` (`408 REQUEST_TIMEOUT`, `504 GATEWAY_TIMEOUT`).

Por tanto, y sin rodeos:

- **Ningún contrato declara rate limits, TPS, cuotas diarias ni mensuales.**
- **Ningún contrato declara timeouts de servidor ni SLA de latencia.**
- **Ningún contrato declara `Retry-After` ni cabeceras `X-RateLimit-*`.** La única guía de reintento es la frase "wait at least 500 milliseconds" de la página de errores.
- **Ningún contrato declara tamaño máximo de respuesta.**

Lo único que Sabre sí publica sobre límites es el 429 `REQUEST_THROTTLED`, y lo que publica es **concurrencia, no throughput**: _"Maximum number of **concurrent requests** for the API has been exceeded. Contact your Sabre account manager to determine or increase your **allocated concurrent request limit** for this API"_ (VERIFICADO-SPEC: `help/errors.txt:201`, `:213`).

> **El cupo es un número contractual por cuenta, y el ACL tiene que respetarlo con un semáforo, no con reintentos.** Hoy `apps/api/src/search/circuit-breaker.service.ts` abre circuito por **`providerCode`** (`FAILURE_THRESHOLD = 5` en `:4`, `OPEN_MS = 30_000` en `:6`, estado en memoria). Para Sabre eso es insuficiente en dos ejes:
>
> 1. **No hay control de concurrencia**, sólo de fallo. Un fan-out paralelo puede agotar el cupo y provocar 429 en cascada.
> 2. **La clave es el proveedor, no la credencial.** En BYOC, una agencia con PCC propio tiene **su propio cupo**; las sub-agencias que heredan el iPCC del consolidador **comparten uno solo**. El semáforo (y el breaker) deben ir atados a la **`provider_account` resuelta**, no a `providerCode`.
>
> El comentario del propio archivo (`:25-26`) ya anticipa la otra mitad del problema: _"Estado en memoria: hay un solo contenedor de API […] Si se escala horizontalmente, esto debe pasar a Redis para que el estado sea compartido"_. Con un cupo de concurrencia global de Sabre, **el semáforo tiene que estar en Redis desde el primer día multi-instancia**, o cada réplica creerá tener el cupo entero.

### 4.2 Los límites que SÍ están en el contrato

**VERIFICADO-SPEC**, `booking-management-v1.yml`:

| Límite                                       | Valor                                                                                                                                                                                                                             | Línea                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `asynchronousUpdateWaitTime` (createBooking) | `minimum: 0`, **`maximum: 10000` ms**, `default: 0`, ejemplo `3000`. "The maximum wait time in milliseconds applied to asynchronous updates related to booking creation. Mainly used for the redisplay operation of NDC bookings" | `:714-722`                     |
| `tickets[]` en refund y en check             | `minItems: 1`, **`maxItems: 12`**                                                                                                                                                                                                 | `:575-580`, `:648-653`         |
| `profiles[]` en createBooking                | `minItems: 1`, **`maxItems: 13`**                                                                                                                                                                                                 | `:723-731`                     |
| `fulfillments[]`                             | `minItems: 1`, **`maxItems: 99`**                                                                                                                                                                                                 | `:946-952`                     |
| `formsOfPayment[]` en fulfill                | `minItems: 1`, **`maxItems: 10`**                                                                                                                                                                                                 | `:971-979`                     |
| `travelers[]` en fulfill                     | `minItems: 1`, **`maxItems: 9`**                                                                                                                                                                                                  | `:979-985`                     |
| `targetPcc`                                  | `pattern: ^[A-Z0-9]{3,4}$`                                                                                                                                                                                                        | 8 sitios                       |
| `confirmationId`                             | `pattern: ^[A-Z0-9]{6,}$` (ej. `GLEBNY`)                                                                                                                                                                                          | schema `CreateBookingResponse` |
| `bookingId`                                  | `pattern: ^[A-Z0-9]{6,14}$` (ej. `1SXXX1A2B3C4D`)                                                                                                                                                                                 | schema `Booking`               |

El spec tiene **45 declaraciones `maxItems`** en total; las de arriba son las que condicionan flujos reales.

**VERIFICADO-SPEC**, `flight-reshop-api-1.0.yml:4956-4958`: `journeys[]` con `minItems: 1`, **`maxItems: 10`**.

> **`asynchronousUpdateWaitTime` es el dato de arquitectura más importante de esta sección**, y sustituye a la latencia de 2021 como sustento de la saga durable: **el propio contrato admite que `createBooking` sobre contenido NDC hace actualizaciones asíncronas y ofrece esperar hasta 10 segundos por ellas**, con `default: 0` (o sea, por defecto **la respuesta puede llegar antes de que la reserva esté completa**). Eso obliga a: (a) un valor explícito y no el default, (b) reconciliación posterior con `getBooking`, y (c) ejecución en saga durable, no en el request-response del usuario. Esto es evidencia de contrato, no una medición ajena.

### 4.3 Paginación

**Sólo el carril hotelero pagina** — y ahora, con `get-hotel-avail-v5.0.yml` en la mano, sabemos exactamente cómo. **Esto corrige la afirmación de la 2ª pasada de que "no está en ningún spec REST que tengamos".**

**VERIFICADO-SPEC**, `get-hotel-avail-v5.0.yml:1204-1239` (request, `SearchCriteriaAvail`) y `:2085-2100` (respuesta):

| Parámetro                      | Contrato                                                                                                                                                                                                                                 | Observación           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `OffSet`                       | `integer`, `minimum: 1`, `default: 1`                                                                                                                                                                                                    | Número de página      |
| `PageSize`                     | `integer`, `minimum: 1`, **`maximum: 200`**, **`default: 200`**                                                                                                                                                                          | Ver aviso abajo       |
| `SortBy`                       | `default: NegotiatedRateAvailability`; también `DistanceFrom`, `SabreRating`, `AverageNightlyRate`, `AverageNightlyRateBeforeTax`                                                                                                        |                       |
| `SortOrder`                    | `ASC` \| `DESC`. **Se ignora si `SortBy = NegotiatedRateAvailability`** — es decir, se ignora _por defecto_                                                                                                                              |                       |
| **`ShopKey`**                  | `string`, `maxLength: 240`. _"An encrypted key associated with a previously requested set of `SearchCriteria` […] **When used, only the `Offset` parameter is taken into consideration, and all other request parameters are ignored**"_ | **Es un cursor real** |
| `MaxSearchResults` (respuesta) | _"The total number of hotel properties that match […] If greater than `PageSize` in the request, the `ShopKey` from the response may be used to view all remaining properties"_. Ejemplo: **763**                                        |                       |

> **Aviso operativo de primer orden, textual del contrato:** _"`PageSize` — The number of hotel properties displayed per page. **If greater than `40`, retrieves live aggregator rates for all properties, live Sabre GDS rates for 40 properties, and cached rates for the remaining properties**."_
>
> Y el **default es 200**. Traducción: **con la configuración por defecto, 160 de cada 200 propiedades vienen con tarifa cacheada, no en vivo.** Eso es precio potencialmente desactualizado mostrado al cliente como si fuera firme. Es una decisión de producto, no un parámetro técnico:
>
> - **Recomendación [INFERIDO]:** `PageSize = 40` en el listado de resultados que se muestra con precio, y paginar con `ShopKey` + `OffSet` para el resto. Nunca `PageSize` alto en un flujo donde el precio se presenta como reservable.
> - Y **siempre** revalidar con Hotel Price Check antes de cobrar (el código `0249`, "rate key inválida", es el síntoma de haberlo hecho tarde).
>
> Además, `ShopKey` **ignora todos los demás parámetros del request**: si el usuario cambia un filtro, hay que **descartar el `ShopKey`** y rehacer la búsqueda. Un bug clásico aquí es paginar con `ShopKey` después de cambiar filtros y mostrar resultados del criterio anterior.

**VERIFICADO-SPEC** (`help/get-hotel-avail-v4/v4-errors.txt`) — límites duros del carril hotelero:

| Límite                            | Valor                                                                        | Código de error |
| --------------------------------- | ---------------------------------------------------------------------------- | --------------- |
| Máximo de hotel codes por request | **5.000**                                                                    | `5273`          |
| Check-in máximo en el futuro      | **330 días**                                                                 | `0414`          |
| Estancia máxima                   | **220 días**                                                                 | `0409`          |
| Huéspedes por habitación          | **9** (adultos + niños)                                                      | `5024`          |
| Múltiples habitaciones            | No todas las fuentes lo soportan                                             | `0106`          |
| Múltiples `CodeContext`           | No permitido — todos los códigos con el mismo contexto (`SABRE` por defecto) | `5259`          |

**Ningún endpoint aéreo pagina.** BFM no tiene cursor ni offset: el volumen se controla por **tier contratado**, vía `TPA_Extensions.IntelliSellTransaction.RequestType.Name` (VERIFICADO-SPEC: `bargain-finder-max-v5.yml:5531-5545`):

> `Name="50ITINS"` devuelve 50 itinerarios; `"100ITINS"` devuelve 100; `"200ITINS"` devuelve 200. _"If a Request Type other than the ones listed above is used, the response is «No Availability». **Using a Request Type name for a tier to which you are not subscribed also returns a «No Availability» response**"_.

> **Trampa operativa de primer orden:** pedir un tier al que no estamos suscritos **no devuelve un error de entitlement, devuelve "sin disponibilidad"**. Una búsqueda que en realidad falló por configuración se presenta al vendedor como "no hay vuelos". **Nuestro ACL debe fijar el `RequestType` desde la configuración de la `provider_account`, nunca hardcodeado**, y un resultado vacío de BFM debe loguearse con el `RequestType` usado para poder diagnosticarlo.

### 4.4 Mitigación de tamaño de respuesta — confirmada en el contrato oficial

**VERIFICADO-SPEC** (refuta el hallazgo 6 de la crítica en este punto), `bargain-finder-max-v5.yml`:

| Extensión                          | Definición                                                                                                                                                                                    | Línea                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `CompressResponse.Value`           | _"If `true`, returns the response payload in a **Base64 encoded GZIP** format. For instructions on how to decode and unzip the response, see the Response design document."_ `default: false` | `:5470`, `:5512-5521`      |
| `AirStreaming`                     | `required: [Method, MaxItinsPerChunk]`. `MaxItinsPerChunk: minimum 1`, ejemplo 10. `Method ∈ {Services, WholeResponse}`. _"**Functionality is available in XML over the REST Endpoints**"_    | `:5462-5468`, `:5492-5511` |
| `MultipleSourcePerItinerary.Value` | _"Combine solutions from different services/sources as additional fares."_ `required: [Value]`                                                                                                | `:5473`, `:5522-5529`      |

- **`CompressResponse` sí es usable en JSON** y es la mitigación práctica para el tamaño. **`AirStreaming` no**: es sólo XML sobre REST, así que **queda descartado** para nuestro cliente JSON.
- **`MultipleSourcePerItinerary` es la palanca del solapamiento ATPCO/NDC** (§7), y **su comportamiento por defecto SÍ está documentado** — corrigiendo a la 2ª pasada de este documento, que lo había degradado a "no reproducible". Texto literal en `bargain-finder-max-v5.yml:5473-5478` (idéntico en `v4:3196-3200`):

  > _"This allows you to specify what to do if the same journey is returned from ATPCO and NDC channels. **By default, the cheaper will stay.** In the case of a tie, the previously described solution will be in place. With this attribute, you can indicate show me everything, combine ATPCO and NDC fares as additional fares, regardless of whether they are the same price."_

  **VERIFICADO-SPEC. La 1ª pasada tenía razón y la 2ª se equivocó al degradarlo.** Ver la consecuencia de negocio en §7.2.

Tamaño real de respuesta: **DESCONOCIDO**. El dato de "967 KB para 50 itinerarios" viene de un mock de una versión legacy (`/v3.4.0/shop/flights`) y **no es reproducible desde el material entregado** — la crítica tiene razón. Se mantiene sólo como orden de magnitud `[TERCERO — no reproducible]`, y la recomendación de diseño no depende de él: **no cachear la respuesta cruda de Sabre**; cachear el `Offer[]` canónico ya mapeado, con TTL del proveedor.

### 4.5 TTL emitido por el proveedor — verificado en dos contratos

**VERIFICADO-SPEC**:

| API             | Campo                                                                             | Definición                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BFM v3/v4/v5    | `Offer.timeToLive`                                                                | `integer`, "Time to live in seconds", ejemplo **1255**. **`required: [offerId, timeToLive, source]`** — `bargain-finder-max-v5.yml:8226-8244`                       |
| BFM v5          | `CacheSource.timeToLive`                                                          | "The time to live **in the cache**", en segundos, ejemplo 1255 — `:2904-2909` (distinto del anterior: éste describe la caché de Sabre, no la vigencia de la oferta) |
| Offer Price NDC | `Offer.ttl`                                                                       | `integer`, segundos, ejemplo **1200**. **`required: [id, ttl, source, offerExpirationDateTime, offerItems, totalPrice]`** — `offer-price-ndc-v1.yml:383-404`        |
| Offer Price NDC | `offerExpirationDateTime`                                                         | ISO 8601, **requerido**. Ejemplo real: petición a las `02:40:24Z`, expiración a las `03:00:23Z` → **~20 min**                                                       |
| Offer Price NDC | `paymentTimeLimitDateTime` / `paymentTimeLimitText` / `purchaseTimeLimitDateTime` | Límites de pago y compra. El campo `…Text` existe _"in case external suppliers return data that does not match the required format"_                                |

> **`timeToLive` / `ttl` son requeridos por contrato: siempre vienen.** Nuestro `apps/api/src/search/memory-cache.adapter.ts` debe usar **el TTL del proveedor por oferta** en vez de un TTL global fijo, y la cotización que mostramos al cliente debe expirar con `offerExpirationDateTime`.
>
> **Y el campo `paymentTimeLimitText` es un aviso de robustez**: Sabre admite en su propio contrato que hay proveedores que devuelven fechas fuera de formato. Nuestro parser debe aceptar ambos y no romper.

---

## 5. Certificación y proceso comercial de Sabre

**Esta sección se conserva de la 1ª pasada** (es investigación web que los contratos no sustituyen) **y se refina con lo que los contratos ahora confirman.**

### 5.1 Qué necesita una agencia

**[TERCERO]** — AltexSoft, "Sabre API Integration", corroborado parcialmente por búsquedas sobre el Sabre Developer Partner Network.

| Etapa                   | Qué implica                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox / try-out**   | "Simply create an account in Sabre Dev Studio to obtain test credentials and access publicly available REST APIs in a sandbox or try-out environment." **Autoservicio, sin contrato** |
| **Solicitud comercial** | Formulario con **sitio web, número IATA/ARC y volúmenes anuales de reservas**                                                                                                         |
| **Contrato**            | Revisión por un representante de Sabre y firma vía DocuSign                                                                                                                           |
| **Credenciales**        | **PCC** o **iPCC**, **EPR**, **Client ID** y **Client Secret**                                                                                                                        |
| **Certificación**       | "Sabre specialists access your test environment to ensure that each API request and response sequence behaves correctly." Duración: **4 a 8 semanas**                                 |

Acreditaciones de industria previas, independientes de Sabre: **ARC** para emitir en EE.UU., **IATA/BSP** para emitir fuera de EE.UU.

Definiciones que importan para BYOC:

- **PCC (Pseudo City Code)** — "alphanumeric identifiers that define your organisation's permissions, geographical coverage, and assigned Sabre environment".
- **iPCC (Internet PCC)** — "The PCC grants access to Sabre Red 360 […] while the iPCC is typically issued to OTAs for **API-only use**".
- **EPR (Employee Profile Record)** — perfil individual ligado a un PCC que determina qué acciones puede hacer ese empleado.

**Lo que los contratos y el catálogo confirman ahora:**

- **El PCC es de 3-4 caracteres alfanuméricos** — `pattern: ^[A-Z0-9]{3,4}$` en los 9 sitios donde aparece `targetPcc` (VERIFICADO-SPEC). El código hotelero `5099` añade que el PCC de sign-in debe ser de **4** caracteres.
- **El "try-out" no es un rumor de blog: está en el catálogo.** `properties.tryOut: true` aparece en **BFM v4 y v5, FlightCheck v1 y Get Hotel Avail v4** (VERIFICADO-SPEC, `_productDetails.json`). Es decir, **se puede probar búsqueda aérea y hotelera sin contrato**, pero **Booking Management, Offer Price, Get Seats y Get Ancillaries tienen `tryOut: false`** — el carril de _reserva_ no se prueba en autoservicio. Eso encaja con lo que dice AltexSoft y acota el valor de la fase de exploración: **se puede validar el mapper de búsqueda antes de firmar; el de reserva no.**
- **La colección está estructurada alrededor de EPR + PCC**: el entorno se llama `BM API TEST CERT - EPR` y define `username = {{epr}}`, `pcc_tkt = {{your_target_pcc}}`, y el `SessionCreateRQ` SOAP manda `<UsernameToken><Username>{{username}}</Username><Password>{{password}}</Password><Organization>{{pcc}}</Organization><Domain>DEFAULT</Domain>` (VERIFICADO, `slices/09-soap-lls-stateful.txt`). Es decir: **el carril SOAP usa usuario+password+PCC, no OAuth**. Son dos sistemas de credenciales distintos para el mismo proveedor, y la bóveda BYOC tiene que guardar los dos.
- **Hay prerequisitos de configuración de cuenta más allá del entitlement de API — el TJR.** Y ahora tenemos **tres** opciones concretas, no una (VERIFICADO-SPEC):

  - _"As a prerequisite, the «**Store Passenger Type In PNR**» option in your Travel Journal Record (TJR) must be enabled"_ — `help/booking-management-api-v1/v1-index.txt:39`, repetido en `create-booking-error-list.txt:498`.
  - _"The car vendor does not support email information. Remove email details or activate the «**Car Traveler Email Address**» option in your Travel Journal Record (TJR)"_ — `create-booking-error-list.txt:1443`.
  - _"Ensure that your Pseudo City Code (PCC) has **Disruption Waivers** enabled in Travel Journal Record (TJR). Contact your account manager for details regarding the Disruption Waiver activation process"_ — `flight-reshop-api-1.0/help-documentation-disruption-waivers.txt:19`.
  - Y `RESOURCE_RESTRICTED` de Get Booking remite a _"verify […] Travel Journal Record settings with your account manager"_.

  **El TJR es una capa de configuración por cuenta que ni el spec ni el sandbox revelan, y cada función nueva puede exigir una opción nueva**: hay que pedir la lista completa explícitamente en la certificación, no descubrirla error a error en producción.

**Sobre plazos totales hay contradicción entre fuentes** [TERCERO]: una dice "7 a 21 días", AltexSoft dice que **sólo la certificación** dura 4-8 semanas. **No los promedio.** El rango realista es incierto, probablemente **2-3 meses** contando contrato + certificación **[INFERIDO]**.

### 5.2 Contraste con nuestro modelo BYOC

**Lo que encaja bien:**

| Nuestro diseño (`12-modelo-consolidador-y-plan.md`)                                                         | Realidad Sabre                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider_accounts.config` JSONB "PCC/pseudo-city, IATA, agencyId, endpoints"                               | Exacto: PCC, iPCC, EPR, TJR van ahí. `credentials_enc` guarda Client ID/Secret **y** usuario/password SOAP                                                         |
| §3.2: "el PCC determina las tarifas privadas disponibles… es _scoping de contenido_, no sólo autenticación" | **Confirmado y ampliado**: el PCC define permisos, cobertura geográfica, entorno asignado, **y qué fuentes de tarifa hotelera están habilitadas** (`5275`, `5300`) |
| Herencia consolidador → agencia                                                                             | **Confirmado por contrato**: `targetPcc` permite operar en el PCC de la agencia con la credencial del consolidador (§3.3)                                          |
| `status: 'sandbox' \| 'active' \| 'disabled'`                                                               | Encaja con el ciclo Dev Studio sandbox → certificación → producción                                                                                                |

**La fricción central — el onboarding self-service "en horas" no aplica a Sabre.**

`12-modelo-consolidador-y-plan.md` §3.6 promete _"nadie en LATAM permite que una agencia se dé de alta y venda en horas"_, con estados `invited → onboarding → active`. Con Sabre, para una agencia que traiga **credenciales propias**, entre contrato, IATA/ARC y certificación de 4-8 semanas, el alta real es de **semanas o meses**.

**Recomendación de producto [INFERIDO]:** bifurcar el wizard, porque los dos caminos tienen SLA incompatibles:

1. **Ruta heredada (horas)** — la agencia opera bajo el iPCC del consolidador vía `targetPcc`. Alta inmediata. **Debe ser el default.** Aquí sí se cumple la promesa.
2. **Ruta BYOC propia (semanas)** — la agencia trae su PCC. Requiere un estado intermedio nuevo, `pending_provider_certification`, con seguimiento visible. El modelo actual (`invited → onboarding → active`) no lo contempla.

### 5.3 El muro de "branch access" — el riesgo estructural del consolidador

**VERIFICADO-SPEC**, tres evidencias convergentes:

- Hotel `5276`: _"**Not authorized to switch to `<pcc>`** […] The PCC under the POS element should have **branch access relationship** with your sign-in PCC. Add the correct branch access relationship as necessary, and then **wait for five (5) mins** for the changes to take effect"_ (`get-hotel-avail-v4/v4-errors.txt:246-256`).
- Booking Management `UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED` / `_NOT_ALLOWED`: _"User is unauthorized to change context for the desired PCC"_.
- FlightCheck `FORBIDDEN_CUSTOMER_CODE` sobre `processingOptions.pseudoCityCode`, con `fieldValue: "ABC1"`.

> **Traducción de negocio:** `targetPcc` **no es libre**. Sabre exige una **relación de branch access declarada entre el PCC del consolidador y el PCC de cada agencia**, y esa relación se configura **del lado de Sabre**, no del nuestro. Es decir: **incorporar una agencia a la red no es sólo un alta en nuestra base de datos; requiere una gestión con Sabre por cada agencia.**
>
> Esto es la pregunta comercial más cara que queda abierta: **¿cómo se establece esa relación, quién la solicita, cuánto tarda y tiene coste por agencia?** De la respuesta depende si nuestro modelo consolidador escala con Sabre o si cada agencia necesita su propio contrato. Va a Decisiones.

### 5.4 Responsabilidad de emisión

El PCC usado determina quién emite y contra qué plan de liquidación (BSP en LATAM, ARC en EE.UU.), así que **la `provider_account` resuelta fija la responsabilidad de liquidación** — exactamente lo que anticipa el riesgo R2 de `12-modelo-consolidador-y-plan.md`. Registrarlo en `domain_events` en el momento de la emisión es correcto y necesario. Y con `targetPcc` la cosa se agudiza: **el `targetPcc` efectivo de cada emisión es un dato de auditoría de primer nivel**, porque es lo que dice bajo qué IATA se emitió el billete.

---

## 6. Alternativas del mismo rol — la decisión que nadie ha tomado

> **Esta sección se conserva y se refuerza deliberadamente.** La crítica señala que la síntesis la borró sin argumento y que es la decisión más cara del expediente. **Elegir GDS es una decisión de años, con coste de integración de meses y coste de salida altísimo. Merece quedar escrita.**

**[TERCERO]** — cifras de comparativas de integradores 2026. **Órdenes de magnitud, no cotizaciones.**

|                                              | **Sabre**                                                                                                                                                              | **Amadeus Enterprise**                                                  | **Travelport**                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Transparencia de precio                      | **Ninguna** — negociado por volumen y mercado                                                                                                                          | **Ninguna pública vigente** — oferta comercial                          | Media                                                     |
| Costo indicativo                             | Setup y fee por transacción **no públicos**. **Y el catálogo marca BFM como `premium`** (§1.1.1)                                                                       | **DESCONOCIDO** — requiere propuesta Enterprise                         | Fee y acceso por contrato; cifras públicas no verificadas |
| Onboarding                                   | **`tryOut` verificado** en BFM v4/v5, FlightCheck y Get Hotel Avail v4; **`tryOut: false` en todo el carril de reserva**. Producción requiere contrato y certificación | Comercial/Enterprise. **Self-Service fue descontinuado el 17-jul-2026** | Requiere contrato                                         |
| NDC LATAM                                    | **LATAM (feb-2025, incl. CO/PE/BR) + Avianca (2022)**; 34 aerolíneas NDC                                                                                               | Disponible, **cobertura no verificada aquí**                            | Disponible, **cobertura no verificada aquí**              |
| Calidad del contrato público                 | **Alta, ahora verificada**: 21 specs + 81 páginas + 746 filas de errores por método                                                                                    | No verificada aquí                                                      | No verificada aquí                                        |
| Modelo consolidador (operar PCC de terceros) | **`targetPcc` existe en contrato** (§3.3), condicionado a branch access                                                                                                | No verificado                                                           | No verificado                                             |
| Post-venta NDC (reemisión / cambio)          | **Flight Reshop es `beta` y sólo ATPCO**: _"NDC Reshop Shop Order is under development"_ (§1.1.1)                                                                      | No verificado                                                           | No verificado                                             |
| Encaje con nuestra Fase 4                    | Alto (cobertura LATAM verificada)                                                                                                                                      | Alto para **prototipar rápido**                                         | Medio                                                     |

**Argumentos a favor de Sabre, ahora con más peso que en la 1ª pasada:**

1. **La calidad documental es excepcional y verificable.** 746 filas de errores catalogadas por método, listas de warnings, ejemplos completos de request y respuesta en los propios specs (Offer Price trae **5 respuestas completas** en `offer-price-ndc-v1.yml:2058-4494`; BFM v5 trae 3 requests de ejemplo). Eso es **semanas de trabajo de integración ahorradas** y una reducción real del riesgo de estimación. Ningún otro proveedor que hayamos evaluado nos ha dado esto sin credenciales.
2. **La cobertura NDC LATAM está verificada documentalmente** para nuestros tres mercados (§7).
3. **`targetPcc` es exactamente el primitivo que necesita nuestro modelo consolidador** y está en el contrato, no en una promesa comercial.

**Argumentos en contra, igual de reales:**

1. **Coste opaco, y el endpoint caro es el de mayor volumen.** BFM está marcado `premium` en el propio catálogo de Sabre. En un producto donde la búsqueda es alto volumen y baja conversión, un fee por búsqueda mal negociado hace inviable el modelo entero.
2. **Certificación de 4-8 semanas y branch access por agencia** — fricción estructural contra la promesa de onboarding rápido (§5.2, §5.3).
3. **La post-venta NDC no está lista.** Flight Reshop es `beta`, sólo ATPCO, y Sabre dice que el Reshop NDC "está en desarrollo". Nuestro contenido diferencial (LATAM, Avianca) es NDC. **Comprar Sabre esperando resolver cambios y reemisiones de LATAM por ahí sería comprar una promesa.**
4. **Dos sistemas de credenciales** (OAuth REST + usuario/password SOAP) y **un carril SOAP stateful de 243 requests** que no desaparece: sesiones `SessionCreateRQ`/`SessionCloseRQ` con estado, que es justo lo que un backend sin estado no quiere gestionar.

**Lectura para el founder [ACTUALIZADA 2026-08-25]:** la ruta barata de Amadeus Self-Service ya no existe.
Amadeus sólo permanece como alternativa Enterprise y debe pasar por el mismo filtro comercial que Sabre y
Travelport. **Sabre conserva la cobertura LATAM verificada, la mejor documentación de las tres y el primitivo
consolidador en contrato**, pero no se elige por descarte: fee, branch access y aporte incremental siguen siendo
la compuerta.

**Aviso de honestidad, mantenido a propósito:** **no verifiqué la cobertura NDC LATAM de Amadeus ni de Travelport, ni sus contratos públicos.** Las celdas correspondientes dicen "no verificada aquí". Una comparación justa exige investigarlas **con el mismo rigor con el que se ha investigado Sabre** — es decir, bajando sus specs y sus listas de errores. Hasta entonces, esta tabla encuadra la decisión pero no la resuelve.

---

## 7. Solapamiento con la integración LATAM NDC directa

### 7.1 Contenido NDC LATAM disponible vía Sabre

**[WEB-OFICIAL]** — comunicado de Sabre del 26 de febrero de 2025:

- Sabre **lanzó las ofertas NDC de LATAM Airlines** el **26-feb-2025** (acuerdo anunciado en octubre de 2023).
- **Seis** transportadoras de pasajeros de LATAM, cubriendo **Chile, Brasil, Colombia, Ecuador, Paraguay y Perú** — **los tres mercados objetivo (CO/PE/BR) están cubiertos**.
- 16 países más activos en esa etapa del despliegue.
- "With the addition of LATAM, **34 airlines** have integrated NDC into Sabre's global travel marketplace."

**[WEB-OFICIAL]** — **Avianca** (Avianca Airlines, Avianca Costa Rica, Avianca Ecuador y TACA International): **primera aerolínea latinoamericana** en distribuir NDC vía Sabre, en dos olas desde el **1 de agosto de 2022**, la segunda desde el 15 de agosto, cubriendo más de 50 países.

**Copa, Gol y Azul vía Sabre NDC: DESCONOCIDO.** Las búsquedas no devolvieron confirmación en ningún sentido. **No lo afirmo.** Es material decisivo para BR (Gol, Azul) y CO/PA (Copa).

### 7.2 El solapamiento — cómo se detecta y cómo se resuelve

Ya tenemos `providers/latam-ndc/` en producción (9/9 endpoints NDC). Si integramos Sabre, **el contenido de LATAM Airlines llegará por dos caminos**.

| Dimensión                      | LATAM NDC directo (ya construido) | LATAM vía Sabre NDC                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato                       | Directo con LATAM                 | Vía Sabre (+ PCC/iPCC propio o del consolidador)                                                                                                                                                                                              |
| Identificación en la respuesta | Nativa                            | **`Offer.source == "NDC"`** + carrier LATAM — **VERIFICADO-SPEC**, `bargain-finder-max-v5.yml:8237-8240` (`pattern: '(ATPCO)\|(LCC)\|(NDC)'`, presente igual en v3 y v4) y `offer-price-ndc-v1.yml:403-404` → schema `Source` en `:1809-1813` |
| TTL de la oferta               | Propio                            | **`Offer.timeToLive` / `ttl`, requerido por contrato** (§4.5)                                                                                                                                                                                 |
| Costo por transacción          | Sin fee de GDS                    | Con fee de Sabre — **DESCONOCIDO**, y BFM es `premium` (§6)                                                                                                                                                                                   |
| Cobertura                      | Sólo LATAM                        | LATAM + 33 aerolíneas NDC + ATPCO + LCC                                                                                                                                                                                                       |
| Post-venta (cambio/reemisión)  | Nuestro propio flujo NDC          | **Flight Reshop no cubre NDC todavía** (§1.1.1)                                                                                                                                                                                               |
| Liquidación                    | Directa                           | Según el PCC/`targetPcc` usado (BSP/ARC)                                                                                                                                                                                                      |
| Ya construido                  | **Sí**                            | No                                                                                                                                                                                                                                            |

**Recomendación [INFERIDO — validar con el founder]:** cuando ambas fuentes devuelvan el mismo vuelo, **preferir LATAM NDC directo** (sin fee de GDS, contrato propio, ya construido, y **con post-venta que Sabre hoy no cubre para NDC**) y usar Sabre como **fuente de amplitud** (otras aerolíneas, ATPCO, LCC). Alineado con la decisión **D5 ya cerrada** en `12-modelo-consolidador-y-plan.md` ("amplitud multi-contenido primero").

**Las tres piezas para implementar el dedupe:**

1. **Marcar el origen** con `Offer.source` (`ATPCO`|`LCC`|`NDC`) + carrier. Está en los tres contratos de BFM y en Offer Price, y es **campo requerido**: siempre viene.
2. **Deduplicar en nuestro fan-out** por clave de itinerario (carrier + número de vuelo + fechas + cabina) aplicando la preferencia de fuente. `apps/api/src/search/provider-fanout.ts` es el lugar natural.
3. **Enviar `MultipleSourcePerItinerary.Value = true`** y deduplicar nosotros.

> **Y aquí está el argumento duro, ahora con el contrato en la mano** (corrigiendo la degradación de la 2ª pasada): el spec dice literalmente que **por defecto Sabre se queda con la más barata** cuando el mismo itinerario llega por ATPCO y por NDC (`bargain-finder-max-v5.yml:5476`, `v4:3198`).
>
> **Eso significa que, sin tocar nada, Sabre está tomando por nosotros una decisión comercial.** La tarifa más barata para el pasajero no es necesariamente la mejor para la agencia: la variante ATPCO y la NDC pueden tener **comisión, reglas de cambio y equipaje distintos**, y quedarnos siempre con la barata puede estar descartando en silencio la que nos deja margen o la que el cliente corporativo necesita por política de viaje.
>
> **Regla recomendada [INFERIDO]: enviar siempre `MultipleSourcePerItinerary = true` y decidir nosotros.** El coste es una respuesta más grande (mitigable con `CompressResponse`, §4.4); el beneficio es recuperar el control de la decisión de margen. En caso de empate de precio el spec remite a "the previously described solution", que **no está descrita en el fragmento accesible** — ese matiz sí sigue abierto, pero es de segundo orden si combinamos todo y decidimos nosotros.

### 7.3 Contexto de mercado

**[WEB-OFICIAL]** — ya citado en `12-modelo-consolidador-y-plan.md` §4.0 desde `sabre.com`: NDC "ya no es un diferenciador competitivo; es una expectativa de base", y **>80 % de las agencias quieren contenido unificado en una sola plataforma**. Sabre como segunda fuente aérea responde a eso y es la **Fase 4, punto 1** del plan.

---

## 8. Lagunas que solo cierra el sandbox

**Mucho más corta que antes: de 14 ítems en la 1ª pasada a 6.** Los contratos cerraron el resto, y los 4 specs que llegaron a las 19:33 cerraron dos más.

### Cerradas por los contratos (ya no hacen falta credenciales)

| Laguna                                                                                                         | Cómo quedó                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "¿Qué forma devuelven `/v3` y `/v4/offers/shop`?" — era el bloqueante nº 2 y el riesgo **RS7** de la 1ª pasada | **CERRADA. Las tres versiones devuelven `groupedItineraryResponse`**: `bargain-finder-max-v3.yml:1330`, `v4:1526`, `v5:3802-3804`. La forma `OTA_AirLowFareSearchRS` pertenece al endpoint legacy `/v3.4.0/shop/flights`, que **no es** `/vN/offers/shop`                                                                                                                            |
| "Respuesta completa de `/v1/offers/price`"                                                                     | **CERRADA.** `offer-price-ndc-v1.yml` trae el schema completo **y 5 respuestas de ejemplo íntegras** (`OneWayResponse` `:2080`, `RoundTripResponse` `:2399`, `MultipaxResponse` `:2912`, `FrequentFlyerResponse` `:3530`, `UnusedTicketResponse` `:4149`), con `totalPrice`, desglose de impuestos, `baggage[]`, `fareComponent`, `ttl`, `offerExpirationDateTime` y límites de pago |
| "Catálogo real de `Error.category` y `Error.type`"                                                             | **CERRADA.** 746 filas, 457 tipos, 21 literales de categoría (§2.3)                                                                                                                                                                                                                                                                                                                  |
| "¿Siguen vigentes los códigos `ERR.2SG.*`? El fixture era de 2015"                                             | **CERRADA.** La tabla oficial vigente está en `help/errors.txt`, replicada en tres productos más. Y es **más amplia** que la del espejo de terceros: añade `ERR.2SG.SCHEMA.INVALID`, `ERR.2SG.GATEWAY.TIMEOUT`, `ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE`, `ERR.2SG.GATEWAY.PROVIDER_CONNECTION_ERROR`, `ERR.2SG.SEC.INTERNAL_PROCESSING_ERROR`, 413 y 406                         |
| "¿Booking Management soporta `targetPCC`?"                                                                     | **CERRADA. Sí**, en 8 requests + Reshop, con la trampa de contexto no revertido (§3.3)                                                                                                                                                                                                                                                                                               |
| "Estructura de `statistics` en BFM"                                                                            | **CERRADA.** `StatisticsType` en `bargain-finder-max-v5.yml`: `branded`, `departed`, `itineraryCount`, `legMissed`, …                                                                                                                                                                                                                                                                |
| "¿Cómo pagina Get Hotel Avail v5?"                                                                             | **CERRADA por el spec de las 19:33.** `ShopKey` + `OffSet` + `PageSize` (máx. y default 200) + `MaxSearchResults` (§4.3)                                                                                                                                                                                                                                                             |
| "Comportamiento por defecto de `MultipleSourcePerItinerary`"                                                   | **CERRADA.** _"By default, the cheaper will stay"_ (§4.4, §7.2)                                                                                                                                                                                                                                                                                                                      |

### Las que siguen abiertas — cada una es una captura concreta contra CERT

**Bloqueantes para el ACL:**

1. **`expires_in` y `token_type` de `POST /v2/auth/token`.** **Ningún spec cubre el endpoint de token** — sólo aparece como `tokenUrl` en `securityDefinitions`. Sin `expires_in` no hay política de cache de token. _Captura: un POST al token, guardar el body completo y las cabeceras._
2. **Un `200` con `errors[]` poblado y un `200` con `messages[].severity == "Error"`.** Conocemos el schema; no conocemos **qué combinaciones llegan juntas**, si `errors` y `warnings` viajan en el mismo array, ni **si las categorías compuestas (`CANCELLATION_ERROR/WARNING`) llegan literalmente así en el payload o resueltas a una de las dos**. Es lo que más fácil se escapa (RS1) y ahora tiene una pregunta concreta detrás. _Captura: forzar un `createBooking` inválido y un `cancelBooking` sobre una reserva ya cancelada._
3. **Un payload real de `getBooking` de una reserva emitida**, para validar `fares` / `fareOffers` / `flights` / `flightTickets` contra el schema y descubrir los `RESOURCE_UNAVAILABLE` que dispara nuestro PCC concreto (§3.2).
4. **La forma exacta de `/v1/offers/getseats`.** La colección llama a `/v1/offers/getseats` (32 requests) y el contrato que tenemos es `/v3/offers/getseats/by*`. **No sabemos si son la misma API con distinta ruta o generaciones distintas.** _Captura: una llamada a cada par y diff de las claves raíz._ (El par equivalente de ancillaries **ya no es una laguna**: `get-ancillaries-agency-2.3.yml` cubre exactamente `/v2/offers/getAncillaries`, §1.3.)

**Bloqueantes para resiliencia y operación:**

5. **El valor del cupo de concurrencia** asignado a nuestra cuenta ("active token count") y **si un `429` real trae `Retry-After`**. El contrato no declara ninguna de las dos cosas (§4.1). El número **no se captura: se pregunta al account manager**; la cabecera sí (_captura: saturar deliberadamente CERT con requests concurrentes_).
6. **Qué entitlements tiene nuestro PCC de CERT.** Un `403 ERR.2SG.SEC.NOT_AUTHORIZED` por endpoint lo revela al instante — pero también hay que probar los **sub-servicios** (`StructureFareRulesRQ`, `GetAncillaryOffersRQ`, `TKT_ElectronicDocumentServicesRQ`), que fallan **dentro de un 200** (§2.3), y la lista completa de opciones del **TJR** (§5.1). _Captura: smoke test de un request por familia + un `getBooking` completo, inspeccionando `errors[]`._

---

## 9. Specs que faltan

Los contratos se bajan sin autenticación desde `https://developer.sabre.com/api/v1/products/<slug>/_attachments/spec.yml`. **El método funciona; el problema era conocer el `slug`.**

**Y ahora sabemos dónde está el índice de slugs**, lo que degrada mucho este apartado: **cada `_productDetails.json` publica los slugs hermanos** en `otherVersions[].link` y **todas las páginas del producto** en `navigation[].url` (VERIFICADO-SPEC). De ahí salen, sin login, slugs que no teníamos: `rest-api/get-hotel-avail/v4.1`, `rest-api/stateless-ancillaries-api/1.1`, `rest-api/get-seats-agency/2.0`, y la existencia del namespace **`soap-api/…`** (`get-vehicle-availability-v2` declara `counterparts: [{"uri":"soap-api/car-shopping-get-vehicle-availability"}]`).

**Lo que la 2ª pasada declaraba faltante y ya NO falta:** Get Hotel Avail v5.0 y la familia de ancillaries completa — el sabor _airline_ y Stateless a las 19:33, y después `get-ancillaries-agency-2.3.yml` y `manage-ancillary-1.1.yml`, que son los que nos aplican (§1.0).

| Endpoint sin contrato                                            | Requests en la colección                 | Por qué falta                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Impacto                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`/v2/auth/token`**                                             | 59                                       | **Ningún producto lo publica como spec.** Sólo existe como `tokenUrl` en los `securityDefinitions` de los demás                                                                                                                                                                                                                                                                                                                                                                       | **Alto.** Sin `expires_in` documentado no hay política de cache de token                                                                                                                |
| ~~**`/v2/offers/getAncillaries`**~~ — **CERRADO**                | 3 REST + 6 SOAP (`GetAncillaryOffersRQ`) | **Ya cubierto.** La acción propuesta (probar el slug `rest-api/get-ancillaries-agency/…`, por el patrón de `get-seats-agency` / `get-seats-airline`) **se ejecutó y funcionó**: `get-ancillaries-agency-2.3.yml` declara `basePath: /v2/offers` + path `/getAncillaries`. Confirma lo que decía la documentación del sabor _airline_: _"This API is intended for use by **Airline Carriers**. There is an equivalent spec aimed at use by Agencies **Get Ancillaries - Agency API**"_ | **Resuelto.** Fue uno de los dos últimos specs en entrar al corpus (§1.0)                                                                                                               |
| **`/v1/orders/view`, `/v1/orders/change`** (Offers & Orders NDC) | 5                                        | Familia distinta de Booking Management, sin slug conocido                                                                                                                                                                                                                                                                                                                                                                                                                             | **Bajo-medio.** Mitigado: **tenemos la respuesta real de `view`** (§0.1), la mejor evidencia disponible de esta familia                                                                 |
| **`/v1.3.0/air/ticket`** (Enhanced Air Ticket)                   | 6                                        | API legacy de ticketing, previa a `fulfillFlightTickets`                                                                                                                                                                                                                                                                                                                                                                                                                              | **Bajo.** `fulfillFlightTickets` (19 requests) es el camino moderno y sí tiene contrato                                                                                                 |
| **`/v1.0.0/veh/pricecheck`** (Vehicle Price Check)               | 1 REST + 1 SOAP                          | Tenemos Get Vehicle Availability v1/v2, no el price check                                                                                                                                                                                                                                                                                                                                                                                                                             | **Bajo.** Autos no está en el alcance inmediato                                                                                                                                         |
| **`/v1/offers/flightShop`**                                      | 1                                        | Endpoint de shopping distinto de BFM; body con `journeys[]`/`departureLocation`/`arrivalLocation`/`departureDate`, forma de la familia FlightCheck/Reshop. **No es `/v1/offers/flightCheck`**                                                                                                                                                                                                                                                                                         | **Bajo hoy, potencialmente alto.** Si es el sucesor de BFM habría que saberlo antes de escribir el mapper                                                                               |
| **WSDL del carril SOAP/LLS**                                     | 243                                      | No se intentó descargar. Ahora sabemos que existe el namespace de slugs `soap-api/…` en el catálogo                                                                                                                                                                                                                                                                                                                                                                                   | **Medio.** 243 requests sin contrato formal. Mitigado en parte por `slices/09-soap-lls-stateful.txt`. **Acción concreta: probar `soap-api/<producto>` con el mismo método de descarga** |

**Acción concreta y barata:** recorrer los `otherVersions` y `counterparts` de los `_productDetails.json` que ya tenemos, y probar los slugs derivados (`get-ancillaries-agency`, `soap-api/*`, `get-hotel-avail/v4.1`). Es media hora de trabajo, no requiere cuenta, y cierra la mayor parte de lo que queda. Y hay que decidir si los specs se versionan en el repo (`providers/sabre/spec/`) o se re-descargan por script: con una release de Booking Management cada 2-3 meses (§1.1), **un spec sin pinnear es un contrato que cambia bajo los pies**.

---

## Preguntas abiertas

Se han retirado las que los contratos ya respondieron (forma de respuesta de BFM v3/v4, respuesta de Offer Price, catálogo de `category`/`type`, vigencia de los `ERR.2SG.*`, soporte de `targetPCC`, `statistics`, paginación hotelera, **y el comportamiento por defecto de `MultipleSourcePerItinerary`**, que sí estaba en el spec).

1. **¿Cómo se establece la relación de _branch access_ entre el PCC del consolidador y el de cada agencia?** ¿Quién la solicita, cuánto tarda, tiene coste por agencia, y hay límite de agencias por contrato? **Es la pregunta que decide si nuestro modelo consolidador escala con Sabre** o si cada agencia necesita su propio contrato. (§5.3)
2. **¿Cuánto cuesta BFM?** Está marcado `premium` en el catálogo de Sabre y es nuestro endpoint de mayor volumen. La pregunta concreta: **¿el fee es por llamada de búsqueda o por reserva?** Y la que cambia el signo del negocio: **¿existe incentivo por segmento a favor de la agencia**, como en el modelo GDS clásico? (§1.1.1, §6)
3. **¿Cuándo estará Flight Reshop para contenido NDC?** Hoy es `beta` + sólo ATPCO. Sin eso, la post-venta de LATAM y Avianca vía Sabre no existe. (§1.1.1, RS18)
4. **¿Cuánto dura el token de `/v2/auth/token`?** Sin `expires_in` no hay política de cache. Ningún spec cubre el endpoint.
5. **¿Cuál es el cupo de peticiones concurrentes asignado a nuestra cuenta, y se asigna por credencial (PCC) o por contrato?** Determina si en BYOC cada agencia con PCC propio trae su propio cupo o comparten uno, y cambia el diseño del semáforo. (§4.1)
6. **¿Las categorías compuestas (`CANCELLATION_ERROR/WARNING`, `CHECK_ERROR/WARNING`, `APPLICATION_ERROR/WARNING`) llegan literalmente así en el payload, o resueltas a una de las dos?** De esto depende si el clasificador del ACL necesita un tercer estado "ambiguo → revisión humana". (§2.3)
7. **¿Cuál es el plazo real de alta productiva?** Las fuentes se contradicen: "7 a 21 días" vs "certificación de 4 a 8 semanas".
8. **¿Copa, Gol y Azul tienen contenido NDC vía Sabre?** Sin confirmar en ningún sentido. Crítico para Brasil y Colombia/Panamá.
9. **¿Qué cobertura NDC LATAM tienen Amadeus y Travelport, y cómo son sus contratos públicos?** No verificado. Necesario para que §6 sea una comparación honesta y no un sesgo de familiaridad.
10. **¿`/v1/offers/getseats` y `/v3/offers/getseats/by*` son la misma API?** 32 requests dependen de la respuesta. (La duda gemela sobre ancillaries está cerrada: `/v2/offers/getAncillaries` tiene contrato propio, `get-ancillaries-agency-2.3.yml`.)
11. **¿Qué es `/v1/offers/flightShop` y cuál es su relación con BFM?** Un solo request en la colección, pero con forma de API moderna.
12. **¿Cuál es la lista completa de opciones del TJR (_Travel Journal Record_) que hay que activar?** Ya conocemos tres ("Store Passenger Type In PNR", "Car Traveler Email Address", "Disruption Waivers") y cada función nueva parece traer la suya. Es una capa de configuración por cuenta que ni el spec ni el sandbox revelan y que rompe operaciones en producción. (§5.1)
13. **En empate de precio entre ATPCO y NDC, ¿qué es "the previously described solution"?** El spec lo referencia sin describirlo en el fragmento accesible. De segundo orden si combinamos todo y deduplicamos nosotros. (§7.2)

---

## Riesgos

| #        | Riesgo                                                                                                                                                                                                                                                                                         | Severidad                                                                      | Mitigación                                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RS1**  | **`200` con `errors[]` / `messages[].severity=="Error"` / `messages[].type=="ERROR"` tratado como éxito.** Reservas fallidas registradas como confirmadas, cobros sin billete. **Oficialmente confirmado**: "Application oriented errors are returned as HTTP status 200"                      | **Crítica**                                                                    | Regla de éxito por familia de envelope (§2.1), con fixtures de cada variante. **Y no generar la política de errores desde el spec**: 14 de 21 contratos declaran sólo `200` (§1.2)                                                                                                                      |
| **RS2**  | **Contexto PCC ambiguo entre llamadas.** El contrato dice que `targetPcc` no revierte contexto, pero las guías declaran el API stateless y limpian AAA antes/después con ATH. La persistencia real con ATK está sin demostrar                                                                  | **Alta, pendiente de CERT**                                                    | `targetPcc` explícito en cada request, resuelto desde la `provider_account`; test A→B en CI/CERT y registro del PCC efectivo en `domain_events`                                                                                                                                                         |
| **RS3**  | **Warnings de estado indeterminado tratados como éxito o reintentados.** `UNABLE_TO_RETRIEVE_TICKETS`, `UNABLE_TO_CONFIRM_MODIFICATION_STATUS`, `UNABLE_TO_RETRIEVE_BOOKING`, `NO_TICKETS_VOIDED`, `UNABLE_TO_CANCEL`… → doble emisión, doble reserva, o cliente sin reembolso                 | **Crítica**                                                                    | Cola de excepciones operativas con estado `needs_review` sobre `order_operations` — **requiere migración que altere el CHECK de `status`**; secuencia obligatoria warning → `getBooking` de reconciliación → decisión humana. **Nunca** reintento automático (§3.1)                                     |
| **RS4**  | **Reintento de 5xx en operaciones de escritura.** `ERR.2SG.GATEWAY.TIMEOUT` y `504` no dicen si la operación se ejecutó; reintentar `createBooking` crea dos PNR                                                                                                                               | **Crítica**                                                                    | Reintento automático **sólo en lecturas**. En escrituras: saga + clave de idempotencia + reconciliación previa vía `getBooking` (§2.2)                                                                                                                                                                  |
| **RS5**  | **El fan-out agota el cupo de concurrencia** y devuelve 429 a todos los tenants que comparten credencial heredada. El breaker actual es por `providerCode` y en memoria                                                                                                                        | **Alta**                                                                       | Semáforo de concurrencia **por `provider_account` resuelta**, en **Redis** (no en memoria) desde el primer día multi-instancia. Backoff exponencial con jitter desde 500 ms. Confirmar el cupo con Sabre antes de producción (§4.1)                                                                     |
| **RS6**  | **`403 ERR.2SG.SEC.NOT_AUTHORIZED` (entitlement) abre el circuit breaker** como si Sabre estuviera caído, degradando las búsquedas de todos los tenants por la configuración de uno                                                                                                            | **Alta**                                                                       | Clasificar el 403 de entitlement **fuera** del breaker; superficie de error de configuración en el panel BYOC. Distinguirlo de `ERR.2SG.CLIENT.SERVICE_UNKNOWN`, que también es 403 pero es bug nuestro (§2.2)                                                                                          |
| **RS7**  | **Entitlement parcial invisible.** `getBooking` devuelve 200 con la reserva **incompleta** porque el PCC no tiene `StructureFareRulesRQ` / `GetAncillaryOffersRQ` / `TKT_ElectronicDocumentServicesRQ`. El vendedor ve datos faltantes como si fueran datos vacíos                             | **Alta**                                                                       | Detectar `category: UNAUTHORIZED` y `RESOURCE_UNAVAILABLE` dentro del 200 y distinguir _"no hay"_ de _"no se pudo saber"_ en la UI. Smoke test de sub-servicios en la certificación (§2.3, §3.2)                                                                                                        |
| **RS8**  | **Tier de BFM no suscrito devuelve "No Availability" en vez de un error.** Una búsqueda rota por configuración se presenta como "no hay vuelos"                                                                                                                                                | **Alta**                                                                       | `RequestType` desde la configuración de la `provider_account`, nunca hardcodeado. Loguear el `RequestType` usado en toda respuesta vacía de BFM (§4.3)                                                                                                                                                  |
| **RS9**  | **`createBooking` devuelve antes de que la reserva esté completa.** `asynchronousUpdateWaitTime` tiene `default: 0` y sólo llega a 10 s; el contrato admite actualizaciones asíncronas en bookings NDC                                                                                         | **Alta**                                                                       | Valor explícito (no el default) + reconciliación posterior con `getBooking` + ejecución en saga durable (Temporal/BullMQ), no en el request del usuario (§4.2)                                                                                                                                          |
| **RS10** | **Sabre decide por nosotros en el solapamiento ATPCO/NDC.** _"By default, the cheaper will stay"_: puede descartar en silencio la variante que nos deja margen o la que cumple la política del corporativo. Y el mismo vuelo puede aparecer dos veces si además llega por LATAM directo        | **Alta** (subida desde Media-Alta: ya no es hipótesis, está en el contrato)    | Enviar **siempre** `MultipleSourcePerItinerary = true` y deduplicar nosotros en `provider-fanout.ts` por `Offer.source` + clave de itinerario. Mitigar el tamaño con `CompressResponse` (§4.4, §7.2)                                                                                                    |
| **RS11** | **La promesa de onboarding self-service "en horas" es incumplible** en la ruta BYOC con PCC propio (4-8 semanas de certificación + branch access por agencia)                                                                                                                                  | **Media-Alta** (producto)                                                      | Bifurcar el wizard: ruta heredada vía `targetPcc` (horas, default) vs ruta BYOC (semanas) con estado `pending_provider_certification`. Ajustar la promesa de marketing (§5.2)                                                                                                                           |
| **RS12** | **Parseo estricto que revienta contra payloads reales.** Money con `amount` string (`"146.60"`), objetos Money vacíos (`totalTaxAmount: {}`), fechas sin offset, `paymentTimeLimitText` fuera de formato por diseño, la errata `APPLICATION_EROR` y las tres categorías compuestas `*/WARNING` | **Media-Alta**                                                                 | Zod laxo en el borde y estricto después. Decimal, nunca float. Fechas de segmento como _naive local time_. El matcher de categorías debe contemplar la errata **y los literales compuestos** (§0.1, §2.3, §4.5)                                                                                         |
| **RS13** | **`IGNORED_DETAILS`: Sabre acepta el request y descarta parte en silencio** (corporate ID mal formado → el cliente pierde su tarifa negociada)                                                                                                                                                 | **Media**                                                                      | Emitir `domain_event` y alertar a ingeniería ante cualquier `IGNORED_DETAILS`, aunque la operación no falle (§3.4)                                                                                                                                                                                      |
| **RS14** | **Los contratos se mueven bajo nuestros pies.** Booking Management publica una versión cada 2-3 meses (34 releases desde abr-2020; 1.31 ene-2026, 1.32 mar-2026, 1.33 jul-2026). Y el propio corpus de specs creció de 15 a 21 mientras se escribía este documento (§1.0)                      | **Media**                                                                      | Pinnear `info.version` (no el slug) en el repo, con re-descarga por script y diff automático en CI. Decidir el mecanismo en `11-plan-implementacion.md`                                                                                                                                                 |
| **RS15** | **PII y respuesta cruda en logs.** `createBooking`/`getBooking` hacen eco de la request completa, con datos de pasajeros; la respuesta real de `/v1/orders/view` trae nombre, apellido, fecha de nacimiento, teléfono y email                                                                  | **Media**                                                                      | Extender a Sabre el gateo de logs que ya existe para LATAM (`LATAM_DEBUG_HTTP`); **nunca** loguear el body completo. Y el fixture `orders-view-200.json` debe anonimizarse antes de entrar al repo                                                                                                      |
| **RS16** | **Costo desconocido, y el endpoint caro es el de mayor volumen.** BFM está marcado `premium` en el catálogo de Sabre; un fee por búsqueda alto hace inviable Sabre como fuente de amplitud                                                                                                     | **Media-Alta** (subida: hay evidencia documental de que BFM es de pago aparte) | Negociar y modelar el costo **por búsqueda**, no sólo por reserva, antes de comprometer la Fase 4. Cachear agresivamente respetando `Offer.timeToLive` (§1.1.1, §4.5, §6)                                                                                                                               |
| **RS17** | **Dos sistemas de credenciales y un carril SOAP stateful.** OAuth para REST, usuario/password/PCC para SOAP; 243 requests con sesiones, de los cuales 73 `SessionCreateRQ` y 61 `SessionCloseRQ`                                                                                               | **Media**                                                                      | Decidir explícitamente si el alcance de la Fase 1 es **sólo REST**. Si el carril SOAP entra, necesita gestión de sesión propia con cierre garantizado (los 61 `SessionCloseRQ` de la colección no son decorativos)                                                                                      |
| **RS18** | **La post-venta NDC vía Sabre no existe todavía.** Flight Reshop es `beta` + `premium` y _"currently supports ATPCO content. NDC Reshop Shop Order is under development"_. Nuestro contenido diferencial (LATAM, Avianca) es NDC                                                               | **Alta** (riesgo nuevo)                                                        | **No planificar cambios/reemisiones NDC sobre Sabre.** Mantener el flujo NDC directo de LATAM como camino de post-venta. Pedir a Sabre fecha comprometida antes de incluir Reshop en ninguna ola. Y tratar su contrato como inestable: `beta` significa que puede cambiar sin release note (§1.1.1, §6) |
| **RS19** | **Tarifas hoteleras cacheadas presentadas como firmes.** `PageSize` **default 200**, y por encima de 40 Sabre devuelve _"cached rates for the remaining properties"_: con la configuración por defecto, 160 de cada 200 precios no son en vivo                                                 | **Alta** (riesgo nuevo)                                                        | `PageSize = 40` en cualquier listado donde el precio se presente como reservable; paginar con `ShopKey` + `OffSet`. Revalidar **siempre** con Hotel Price Check antes de cobrar. Y descartar el `ShopKey` en cuanto cambie un filtro, porque ignora todo lo demás (§4.3)                                |
