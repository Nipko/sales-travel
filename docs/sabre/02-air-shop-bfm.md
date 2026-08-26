---
titulo: Sabre — búsqueda de vuelos (Bargain Finder Max / Offers Shop)
fecha: 2026-08-25
estado: reconciliado contra los contratos oficiales v3/v4/v5
Fuentes: ver 00-fuentes.md
---

# 02 — Sabre: búsqueda de vuelos (Bargain Finder Max / Offers Shop)

**Alcance:** los 89 requests de shopping aéreo de la colección (26 × `/v3/offers/shop`, 49 × `/v4/offers/shop`, 13 × `/v5/offers/shop`, 1 × `/v1/offers/flightShop`) **reconciliados contra los tres contratos OpenAPI oficiales** de Bargain Finder Max.

> ### Qué cambió en esta pasada
>
> La primera versión de este documento se escribió **sin los contratos**. Tuvo que marcar como DESCONOCIDA toda la forma de la respuesta y llegó a tres conclusiones que el contrato oficial **desmiente**. Esta versión las corrige y las señala explícitamente:
>
> 1. ~~«La moneda no se puede pedir»~~ → **FALSO.** Existe `TravelerInfoSummary.PriceRequestInformation.CurrencyCode` en las tres versiones (§6.2).
> 2. ~~«La forma de la respuesta es en su mayoría desconocida»~~ → **RESUELTO.** El spec de v5 trae el schema completo y **tres ejemplos de respuesta enteros**. El mapa de campos de §7 ya no tiene inferencias en los campos obligatorios.
> 3. ~~«`DataSources` es un switch de un solo bit; sumar Sabre cuesta N llamadas»~~ → **FALSO.** BFM consulta ATPCO + NDC + LCC en **una sola llamada**, y encima **ya deduplica por el más barato del lado de Sabre** (§4). Es una llamada, no tres — y el problema no es el coste, es que Sabre nos esconde producto por defecto.
>
> Marcado según la convención de `00-fuentes.md`. **VERIFICADO-SPEC** cita archivo + línea del `.yml`; **VERIFICADO** cita la ruta del request en la colección.

---

## 1. TL;DR y decisiones que hay que tomar

1. **Adoptar `POST /v5/offers/shop` con `Version: "5"`.** La primera pasada recomendó v4 por frecuencia de uso en la colección. **Con el contrato en la mano, la recomendación cambia a v5** (§3.4): v5 es la única versión con `POS.MultiSourceControl`, con penalidades NDC estructuradas (`penaltiesInfo` con `changeable`/`refundable` por tipo), y la única con ejemplos oficiales de respuesta que podemos usar como fixtures hoy mismo. El argumento de frecuencia de la colección era débil: **38 de los 49 requests cuyo nombre declara una versión apuntan a otra distinta** (§2).
2. **Sabre es UNA llamada por búsqueda, no tres.** `MultipleSourcePerItinerary` documenta que el mismo viaje "returned from ATPCO and NDC channels" se combina en una respuesta. La decisión de producto que la primera pasada planteó como A/B/C/D (§4.3) **queda resuelta**: pedir las tres fuentes en una llamada.
3. **Sabre poda alternativas cross-source por precio, por defecto.** "By default, the cheaper will stay"
   (**VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:5476`). Hay que mandar
   `MultipleSourcePerItinerary.Value = true` cuando comparamos ATPCO y NDC. Esto no sustituye los controles de
   marca/upsell: `MultipleBrandedFares`, `MaxNumberOfUpsells` y `UpsellLimit` se configuran y prueban aparte.
4. **La moneda sí se pide.** `PriceRequestInformation.CurrencyCode` (**VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:7849`). Nuestro `criteria.currency` **sí tiene destino**. El riesgo #2 de la primera pasada baja de Alto a Medio (§6.2).
5. **La oferta trae TTL propio: `offer.timeToLive`, en segundos, campo obligatorio** en las tres versiones (**VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:8226`). `Offer.expiresAt` ya no hay que inventarlo.
6. **El equipaje y las penalidades NO vienen por defecto: hay que pedirlos.** `TravelPreferences.Baggage.RequestType = "C"` y `PassengerTypeQuantity[].TPA_Extensions.VoluntaryChanges` (§7.4). Si no se piden, `Offer.baggage` y `Offer.policies` quedan vacíos.
7. **Tres campos obligatorios de `SegmentSchema` no vienen listos para usar**: `departureAt`, `arrivalAt` y `durationMinutes` hay que **reconstruirlos** cruzando cuatro arrays (§7.3). Es trabajo de mapper real, no un campo que se copia. La crítica tiene razón en que esto es **bloqueante**, no "incompleto".

---

## 2. Inventario: qué endpoints de shop existen

| Endpoint                     | Requests | Workflows que lo usan (**corregido**)                                             | Veredicto                                              |
| ---------------------------- | -------: | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v3/offers/shop`       |       26 | WF 6, 20, 21, 22, 26, 27, **28-33**; `Create Booking / Flights Preparation`        | Legado. **Sin `MultipleSourcePerItinerary`** → descartar. |
| `POST /v4/offers/shop`       |       49 | WF 3, 4, 5, 7, 8, 14, **15**, 16, 17, 18, 19, 25; casi todo `ModifyBooking`        | Válido. Superado por v5.                               |
| `POST /v5/offers/shop`       |       13 | WF 1, 2, 11, 12, 13, **15**, 23, 24, **28-33**; `FulfillFlightTickets / Basic flow NDC` | **Adoptar este.**                                  |
| `POST /v1/offers/flightShop` |        1 | WF 8, paso `1a Flight Shop - refundable AA`                                        | API distinta, no OTA. Sin spec disponible. Ver §3.6.   |

> **Corrección (hallazgo 2 de la crítica — ACEPTADO).** La primera pasada asignó el Workflow 15 sólo a v4. Es falso: **WF 15 usa las dos versiones dentro del mismo workflow** — `AA airline` y `QF airline` van a `/v4`, mientras `UA`, `QR` y `SQ` van a `/v5` (**VERIFICADO** — parseo de las URL de los 5 shop de `Workflows / 15 - NDC All supported airlines`). Lo mismo pasa con **WF 28-33, que usa v3 y v5**, y que la primera pasada listó sólo en v3.
>
> **El nombre del request no es fiable como indicador de versión.** De los 49 requests de shop cuyo nombre declara una versión, **38 apuntan a una versión distinta en la URL** (**VERIFICADO**). Los 5 de WF 15 se llaman los cinco `Bargain Finder Max /v3` y ninguno va a v3. **Sólo la URL manda.** Esto invalida cualquier conteo de la primera pasada que se apoyara en nombres de request.

Todos usan el mismo host: `rest_endpoint = https://api.cert.platform.sabre.com` (**VERIFICADO** — entorno de la colección; una de las únicas 6 variables con valor real). El spec lo confirma como único server (**VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:11`).

### 2.1 Headers y autenticación (VERIFICADO)

Los 89 requests de shop **no declaran auth propia**: heredan `Bearer {{token}}` del bloque `auth` raíz de la colección. El token sale de:

```
POST {{rest_endpoint}}/v2/auth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {{secret}}

grant_type=client_credentials
```

El `secret` se construye en el pre-request script raíz como `base64( base64("V1:{username}:{pcc}:AA") + ":" + base64(password) )` (**VERIFICADO** — pre-request script raíz). **El PCC entra en el `client_id` del OAuth**, no es sólo un campo del body; forma parte de la identidad de la credencial. Eso condiciona el diseño BYOC (§6.3).

| Header            | Frecuencia | Valor                                        |
| ----------------- | ---------: | -------------------------------------------- |
| `Content-Type`    |      89/89 | `application/json`                           |
| `Conversation-ID` |      72/89 | `{{conv_id}}` = `"2021.01.DevStudio"` o literal `conversation-id-value` |
| `Authorization`   |       0/89 | heredado: `Bearer {{token}}`                 |

`Conversation-ID` es opcional pero **debemos mandarlo siempre**: es el correlador de soporte de Sabre. Propuesta: `SearchContext.requestId`.

### 2.2 Errores y throttling (VERIFICADO-SPEC — `specs/help/errors.txt`)

La lista oficial de errores REST aplica a BFM. Lo que nos condiciona el diseño del adapter:

| Código | Señal | Qué hace nuestro adapter |
| --- | --- | --- |
| `429 / ERR.2SG.GATEWAY.REQUEST_THROTTLED` | "Maximum number of concurrent requests for the API has been exceeded" | **Backoff mínimo 500 ms** (lo dice el doc), y **límite de concurrencia por PCC** en el fan-out. No es reintento libre. |
| `429 / Throttled — Active token count is exceeded` | Demasiados tokens vivos | Refuerza que el `TokenService` **debe** cachear y reutilizar el token, no pedir uno por búsqueda. |
| `401 / invalid_client` + "TAM Pool is exhausted" | Pool de credenciales agotado | Distinguirlo de credencial mala: es transitorio, va al circuit breaker, no a "credenciales inválidas". |
| `404 / Response does not contain any data` | Sin resultados | **No es un error de proveedor.** Mapear a lista vacía, no a `failed`, o el fan-out marcará Sabre como caído en cada búsqueda sin vuelos. |
| `500 / ERR.2SG.GATEWAY.TIMEOUT`, `503`, `504` | Transitorios | Circuit breaker + backoff 500 ms. |

---

## 3. `/v3` vs `/v4` vs `/v5`: resuelto con el contrato

La primera pasada comparó los 88 bodies y concluyó que ciertos campos "sólo existen desde v4". **Eso era una observación sobre la colección, no sobre el API, y el contrato lo desmiente.**

### 3.1 El request es el MISMO en v3 y v4 (VERIFICADO-SPEC)

> "Bargain Finder Max request has **no schema changes** from the previous version."
> — `specs/help/bargain-finder-max-v4/help-documentation-v3-v4.txt`, guía oficial de migración v3→v4.

Corrección concreta a la tabla de la primera pasada:

| Campo | Decía la 1ª pasada | Realidad del contrato |
| --- | --- | --- |
| `TravelPreferences.CabinPref[]` | "la cabina sólo se puede pedir desde v4" | **Existe en v3** (**VERIFICADO-SPEC**: `bargain-finder-max-v3.yml:32`, `CabinPrefType`). |
| `VendorPref[].PreferLevel` | "sólo aparece a partir de v4" | Existe en v3. Era ausencia en la colección, no en el schema. |
| `…BrandedFareIndicators.SingleBrandedFare` | "sólo desde v4" | **Existe en v3** (**VERIFICADO-SPEC**: `bargain-finder-max-v3.yml:3689`). |

Lo que la primera pasada midió es **qué ejercita la colección**, y eso sigue siendo útil como señal de "qué está probado". Pero no puede presentarse como capacidad del API.

### 3.2 Lo que v4 y v5 SÍ añaden de verdad: está en la RESPUESTA

Diff de nombres de schema de respuesta entre los tres contratos (**VERIFICADO-SPEC** — 93 schemas en v3, 122 en v4, 137 en v5):

| Salto | Qué aparece de nuevo en la respuesta |
| --- | --- |
| **v3 → v4** | `AmenitiesType`, `AmenitiesSegmentType` (amenidades de cabina), `UPA*` / `RichContentType` / `Photo` / `Video` (contenido enriquecido Route Happy), **`PriceClassDescriptionType` / `PriceClassDescriptionsType`** (marcas de tarifa NDC → nuestro `Offer.fareFamily`), `Taxes` / `Tax` / `TaxReissueType`, `TicketType`, `DiversitySwapperType`, `BookingDetails`, `PricingLegType`, `SoldOutSchedule`. Además la guía documenta el rediseño de `shelfDescs` (atributos de producto: exchanges, refunds, baggage, seat selection). |
| **v4 → v5** | **`ApplicablePenaltiesType` / `ApplicablePenaltyType` / `MinPenalty`** (penalidades NDC referenciables), `DiscountType` (descuento NDC), `MatchedNegotiatedFareCodeType` (traza de qué tarifa negociada casó), `SeatType` / `SeatCharacteristic` / `UPASeatCharacteristicDescType`, `UTABaggageType`. |

En el **request**, v5 añade cuatro cosas que v4 no tiene (**VERIFICADO-SPEC** — diff de los 160 vs 157 schemas de request):

- **`POS.MultiSourceControl.MaximumNumberOfPCCs`** — número máximo de PCC a procesar en Global Shopping. Para un **consolidador esto es material**: es el mecanismo nativo de Sabre para buscar con varios PCC en una llamada, que es literalmente nuestro modelo BYOC. `bargain-finder-max-v5.yml:5037`.
- `TravelPreferences.TPA_Extensions.OfferControlRules.Exclude`
- `…NDCIndicators.CarrierSpecificQualifiers.PromotionCode`
- `TravelerInfoSummary.AirTravelerAvail.PassengerTypeQuantity.PersonName`

v4 tiene uno que v5 quitó: `IntelliSellTransaction.TravelerPersona`. No lo usamos.

### 3.3 `timeToLive`: existe en las tres, idéntico (VERIFICADO-SPEC)

La pregunta abierta #6 de la primera pasada ("¿cuánto vive una oferta de Sabre?") **está respondida por el contrato, y en las tres versiones por igual**:

```yaml
# bargain-finder-max-v5.yml:8226   (idéntico en v4:6048 y v3:2163)
Offer:
  required: [offerId, timeToLive, source]
  properties:
    offerId:    { type: string,  example: 'do3385fr4jsvzb1i30-1' }
    source:     { type: string,  pattern: '(ATPCO)|(LCC)|(NDC)' }
    timeToLive: { type: integer, description: 'Time to live in seconds.', example: 1255 }
```

Y v3 lo describe con más detalle: *"how long the offer will be valid in the Offer Store. The time to live for NDC offers is different than for ATPCO"* (**VERIFICADO-SPEC**: `bargain-finder-max-v3.yml:2175`).

**Por lo tanto `Offer.expiresAt` = `fetchedAt + offer.timeToLive` segundos.** No hay que inventar un default.

Ojo, hay un segundo `timeToLive` que **no es éste**: `Cached.timeToLive` (`bargain-finder-max-v5.yml:2904`) es el TTL del itinerario **en la caché de Sabre**, junto a `Cached.hoursSinceCreation`. Si `pricingInformation[].cached` existe, el precio **no es en vivo**. Eso es una señal de calidad que debemos propagar, no confundir con la vigencia de la oferta.

### 3.4 Recomendación firme de versión

> ### **Adoptar `/v5/offers/shop` con `Version: "5"`.**
>
> **Por qué cambia respecto de la primera pasada:** el argumento de "49 de 88 ejemplos usan v4" se cae al comprobar que los nombres de request de la colección son basura (38/49 mal etiquetados, §2) y que **el request de v3 y v4 es el mismo contrato**. La frecuencia en la colección medía inercia de los workflows viejos, no idoneidad.
>
> **Razones a favor de v5, todas VERIFICADO-SPEC:**
>
> | # | Razón | Cita |
> | - | --- | --- |
> | 1 | Único con `POS.MultiSourceControl` → multi-PCC nativo, que es el modelo consolidador | `v5.yml:5037` |
> | 2 | Único con penalidades NDC estructuradas (`ApplicablePenaltiesType`, `MinPenalty`) → `Offer.policies` sin heurística de texto | `v5.yml:2480` |
> | 3 | Único con **tres ejemplos de respuesta completos publicados** → fixtures del mapper hoy, sin esperar al sandbox | `v5.yml:120`, `:667`, `:1456` |
> | 4 | Tiene `MultipleSourcePerItinerary` (v3 **no lo tiene**), que es obligatorio para nosotros (§4) | `v5.yml:5522` |
> | 5 | Los ejemplos oficiales del propio Sabre usan `Version: "5"` con `/v5` | `v5.yml:71` |
>
> **Coste del cambio v4→v5: cero en el request.** El body que ya diseñamos para v4 es válido en v5 salvo el valor de `Version`. Todo el delta está en leer campos nuevos de la respuesta, que es aditivo.
>
> **Descartar v3 explícitamente:** no tiene `MultipleSourcePerItinerary`, así que en v3 **no hay forma de desactivar el dedupe-por-más-barato de Sabre**. Con v3 estaríamos ciegos a la mitad del catálogo por diseño (§4.2).

### 3.5 El campo `Version`: el spec dice que debe coincidir; la colección no lo respeta

> "The version of the service **has to match** the version in the path (`/v5`)."
> — **VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:55`.

Pero la colección manda otra cosa (**VERIFICADO** — parseo de los 88 bodies):

| Versión de la URL | Valor de `OTA_AirLowFareSearchRQ.Version` |
| --- | --- |
| `/v3` | `"1"` (26/26) |
| `/v4` | `"4"` (49/49) |
| `/v5` | `"4"` (11/13) y `"1"` (2/13) |

O sea: **ninguno de los 13 requests a `/v5` manda `Version: "5"`**, y presumiblemente funcionan porque están en workflows que se ejecutan de punta a punta. Lectura: Sabre **tolera** el desajuste hoy, pero el contrato dice que no debería.

> **Regla para el builder:** mandar `Version: "5"` con `/v5`, como hacen los ejemplos oficiales. No copiar el patrón de la colección. Si algún día Sabre endurece la validación, los que copiaron la colección se rompen.

Nota menor de ruido en el propio spec: el schema raíz da `example: 'V4'` para `Version` (`v5.yml:2753`), con V mayúscula, mientras los tres ejemplos usan `"5"`. Confiar en los ejemplos.

### 3.6 `/v1/offers/flightShop` — sin contrato disponible

Un solo ejemplo, en `Workflows / 8 / 1a Flight Shop - refundable AA`:

```json
{
  "journeys": [
    { "departureLocation": { "airportCode": "JFK" }, "arrivalLocation": { "airportCode": "MIA" }, "departureDate": "2026-09-01" },
    { "departureLocation": { "airportCode": "MIA" }, "arrivalLocation": { "airportCode": "JFK" }, "departureDate": "2026-09-08" }
  ],
  "travelers": [{ "passengerTypeCode": "ADT" }],
  "airlines": { "marketingAirlinesFilter": { "airlineCodes": ["AA"] } },
  "fare": { "brandedFareFilters": [{ "brandCodes": ["MAINFL"] }] },
  "retailing": {
    "filterByOfferAttributes": { "isRefundAllowed": true },
    "returnOfferAttributes": ["Flexibility", "Baggage"]
  },
  "sources": { "distributionModels": ["ATPCO"] },
  "processingOptions": { "limitNumberOfOffers": 5 }
}
```

El schema sigue siendo mucho más agradable que el OTA. **Pero `00-fuentes.md` confirma que no conseguimos su spec** (está detrás del login del catálogo), así que seguimos con 1 sola muestra y cero conocimiento de su respuesta.

> **Decisión (sin cambios respecto de la 1ª pasada): BFM `/v5` para la Ola 1.** El argumento se refuerza: ahora BFM v5 tiene contrato **y** ejemplos de respuesta, mientras `flightShop` sigue teniendo una muestra suelta. La spike sobre `flightShop` baja de prioridad — ya no compensa una asimetría de información que se cerró del otro lado.

---

## 4. `DataSources` y `MultipleSourcePerItinerary`: la pregunta de coste, resuelta

### 4.1 El contrato permite las tres fuentes a la vez (VERIFICADO-SPEC)

```yaml
# bargain-finder-max-v5.yml:6237
OTA_AirLowFareSearchRQ.TravelPreferences.TPA_Extensions.DataSources:
  type: object
  properties:
    ATPCO: { type: string, enum: [Enable, Disable] }
    LCC:   { type: string, enum: [Enable, Disable] }
    NDC:   { type: string, enum: [Enable, Disable] }
```

**Son tres propiedades independientes.** No hay `oneOf`, `anyOf`, `maxProperties` ni ninguna restricción que impida habilitar varias. La observación de la primera pasada —"en los 88 requests nunca hay dos fuentes en `Enable` a la vez"— **es cierta sobre la colección y sigue en pie como dato**, pero era un artefacto de cómo están escritos los workflows de certificación (cada uno prueba un carril), **no un límite del API**.

Confirmación adicional: los **tres ejemplos oficiales de request de Sabre no mandan `DataSources` en absoluto** (`v5.yml:100`, `:642`, `:1410`). El objeto es opcional; sin él, el servicio usa la configuración de la cuenta.

### 4.2 `MultipleSourcePerItinerary` — el hallazgo más caro del documento

```yaml
# bargain-finder-max-v5.yml:5473 (descripción) y :5522 (schema)
MultipleSourcePerItinerary:
  description: >-
    This allows you to specify what to do if the same journey is returned from
    ATPCO and NDC channels. By default, the cheaper will stay. In the case of a
    tie, the previously described solution will be in place. With this attribute,
    you can indicate show me everything, combine ATPCO and NDC fares as additional
    fares, regardless of whether they are the same price.
  properties:
    Value: { type: boolean, description: 'Combine solutions from different services/sources as additional fares.' }
```

Tres cosas que esto zanja:

1. **BFM consulta ATPCO y NDC en la misma llamada.** La frase "the same journey is returned from ATPCO and NDC channels" sólo tiene sentido si ambas fuentes se procesan en una transacción. **Sumar Sabre al fan-out cuesta 1 llamada, no 3.** Las opciones A/B/C/D de la primera pasada §4.3 quedan sin objeto.
2. **El default de Sabre es quedarse con la alternativa cross-source más barata.** "By default, the cheaper will
   stay." La alternativa ATPCO o NDC descartada no llega a nuestro fan-out. No se debe extrapolar esta palanca a
   branded fares: una tarifa con equipaje/upsell depende además de los indicadores NDC de marca.
3. **`PreferNDCSourceOnTie` sí tenía sentido.** La primera pasada lo despachó como "copia-pega, no señal". Era señal: es el desempate documentado para cuando ATPCO y NDC devuelven el mismo viaje al mismo precio (**VERIFICADO-SPEC**: `v5.yml:7423`, "Select content from NDC Content Source in case of identical offers"). Aunque sí es cierto que el ejemplo LCC-only de `Workflows / 5` lo lleva sin poder hacer nada — ahí sí es copia-pega.

> ### Configuración obligatoria del builder
>
> ```jsonc
> "TravelPreferences": {
>   "TPA_Extensions": {
>     "DataSources": { "NDC": "Enable", "ATPCO": "Enable", "LCC": "Disable" },
>     "PreferNDCSourceOnTie": { "Value": true }
>   }
> },
> "TPA_Extensions": {
>   "IntelliSellTransaction": {
>     "RequestType": { "Name": "50ITINS" },
>     "MultipleSourcePerItinerary": { "Value": true }   // ← NO OMITIR
>   }
> }
> ```
>
> Omitir `MultipleSourcePerItinerary` no es "usar el default": es **pedirle a Sabre que nos oculte producto**. Debe ir en el builder como constante, no como opción de configuración.

`LCC: "Disable"` en Ola 1 se mantiene, y ahora por una razón más limpia que "no encaja": los 8 requests LCC de la colección **todos** llevan `VendorPref` con carrier concreto (`U2`, `FR`, `{{lcc_airline_code}}`) — **VERIFICADO**. No hay evidencia de búsqueda LCC abierta, y las low cost relevantes en LATAM (JetSMART, Sky, Gol) están sin confirmar en el agregador de Sabre. Es un `Enable` de una línea el día que se confirme cobertura.

### 4.3 Qué implica cada fuente para el ciclo de reserva

Esto **no cambia** respecto de la primera pasada y sigue verificado en la colección:

| Fuente | Qué contenido es | Cómo se reserva (VERIFICADO en la colección) |
| --- | --- | --- |
| **ATPCO** | Tarifa publicada tradicional del GDS. | `shop` → **directo a** `createBooking` con `flightDetails.flights[]` (flightNumber, airlineCode, from/to, date, time, bookingClass). **Sin `offers/price`.** Evidencia: `Workflows / 3 … / 2. createBooking - ATPCO payload` |
| **NDC** | Oferta del carrier. Branded fares, ancillaries, contenido exclusivo. | `shop` → `offers/price` (`{"query":[{"offerItemId":["{{shop_offer_item_id}}"]}]}`) → `createBooking` con `flightOffer.{offerId,selectedOfferItems}`. Evidencia: `Workflows / 1 … / 2. Offers Price /v1` y `/ 3. createBooking` |
| **LCC** | Low cost agregados por Sabre. | `shop` → `createBooking` con `flightDetails.flights[]` **más `"source": "LCC"`**. Evidencia: `Workflows / 5 … / 2. createBooking - LCC` |

**Y ahora sabemos de qué fuente viene cada oferta sin adivinar**, por dos caminos redundantes (**VERIFICADO-SPEC**):

- `pricingInformation[].offer.source` → `ATPCO` | `LCC` | `NDC` (`v5.yml:8237`)
- `pricingInformation[].distributionModel` → enum `ATPCO` | `API` | `NDC` (`v5.yml:8819`)

Esto era la pregunta abierta #1 de la primera pasada ("¿la respuesta marca de qué fuente viene cada itinerario?"). **Sí, dos veces.**

### 4.4 La consecuencia que sigue viva: `ProviderRef.offerRef`

- Para **NDC**, `offerRef` es `(offerId, offerItemId)` y **es perecedero**: `price.offers[0].id` ≠ `shop…offer.offerId` — **VERIFICADO** en el test script de `Workflows / 28-33 … / Offers (price)`. Ahora además sabemos cuánto vive: `offer.timeToLive` segundos (§3.3).
- Para **ATPCO/LCC**, `offer.offerId` **también existe** (el ejemplo de v3 lo muestra con `source: "ATPCO"`, `v3.yml:1467`), pero el `createBooking` de ATPCO **no lo consume**: reconstruye el vuelo. O sea que el `Offer` canónico tiene que llevar igualmente el detalle del segmento.

Nuestro `ProviderRefSchema` es `{ name, offerRef: string }` (`packages/canonical/src/offer.ts:27`). Sigue sin dar. **Decisión pendiente, sin cambios** — ver riesgo #6.

---

## 5. Estructura del body `OTA_AirLowFareSearchRQ`

Raíz única: todo el body es `{ "OTA_AirLowFareSearchRQ": { … } }`.

### 5.1 Obligatoriedad REAL (VERIFICADO-SPEC — `bargain-finder-max-v5.yml:2661`)

La primera pasada midió "en cuántos de los 88 bodies aparece" y advirtió honestamente que eso **no es** la obligatoriedad del API. Ahora la tenemos:

```yaml
OTA_AirLowFareSearchRQ:
  required: [OriginDestinationInformation, POS, TravelerInfoSummary, Version]
```

Y dentro de cada tramo: `required: [DestinationLocation, OriginLocation]`, con `minItems: 1, maxItems: 10`.

**Todo lo demás es opcional**, incluidos `TravelPreferences`, `DataSources`, `NumTrips` y `RPH` — que la colección manda casi siempre y los ejemplos oficiales de Sabre **no mandan nunca**.

### 5.2 Campos, uno por uno

† "Colección" = en cuántos de los 88 bodies aparece. "Spec" = qué dice el contrato.

| Campo | Colección† | Spec | Notas |
| --- | :---: | :---: | --- |
| `Version` | 88/88 | **obligatorio** | Debe coincidir con la URL (§3.5). Mandar `"5"`. |
| `POS.Source[].PseudoCityCode` | 88/88 | opcional dentro de POS | `{{pcc}}`, `{{pcc_tkt}}`, `{{pccEmd}}`, `7KFA`, `U9PK`, `G7HE`, `N87F`, `G7RE`, `GF1I`. **El PCC de la agencia.** BYOC (§6.3). |
| `POS.Source[].RequestorID` | 88/88 | **`required: [ID, Type]`** (`v5.yml:5046`) | |
| `…RequestorID.Type` | 88/88 | obligatorio | Siempre `"1"`. Spec: *"A Sabre internal configuration type, which equals 1"* (`v5.yml:59`). **Ya no es [INFERIDO]: es constante documentada.** |
| `…RequestorID.ID` | 88/88 | obligatorio | Siempre `"1"`. Spec: *"A unique ID assigned by the creating system (e.g. 1 = Sabre)"* (`v5.yml:58`). **`"1"` es correcto, no un placeholder de certificación.** Cierra la pregunta abierta #9. |
| `…RequestorID.CompanyName.Code` | 88/88 | opcional | `"TN"`. Spec: *"TN for Travel Agency, AS for Airline Solutions"* (`v5.yml:57`). **Ya no es [INFERIDO].** |
| `POS.MultiSourceControl.MaximumNumberOfPCCs` | 0/88 | **sólo v5** | Multi-PCC en una llamada. Relevante para consolidador (§3.2). |
| `OriginDestinationInformation[]` | 88/88 | **obligatorio, 1..10** | Un elemento por tramo. |
| `…[].OriginLocation.LocationCode` | 88/88 | **obligatorio** | Acepta códigos de **ciudad** (`LON`, `NYC`, `WAS`, `PAR`), no sólo de aeropuerto. |
| `…[].DestinationLocation.LocationCode` | 88/88 | **obligatorio** | idem |
| `…[].DepartureDateTime` | 88/88 | opcional | `YYYY-MM-DDTHH:MM:SS`. **La colección siempre manda `T00:00:00`; los ejemplos oficiales mandan horas reales (`T20:00:00`, `T13:00:00`).** El spec dice *"The time and date of the traveler's departure"* — **la hora sí es significativa**. La primera pasada dedujo lo contrario de la colección. |
| `…[].ArrivalDateTime` | 0/88 | opcional | Alternativa a `DepartureDateTime`. *"Should not be used together"*. |
| `…[].DepartureWindow` / `ArrivalWindow` | 0/88 | opcional | Formato `HHMMHHMM` (p. ej. `05000730`). **Capacidad que no estábamos usando** y que encaja con "salir por la mañana". |
| `…[].ConnectionLocations` | 0/88 | opcional | Forzar/excluir ciudades de conexión. |
| `…[].RPH` | 87/88 | **opcional** | La colección es inconsistente (unos empiezan en `"0"`, otros en `"1"`); los ejemplos oficiales **no lo mandan**. Ver §5.3. |
| `TravelPreferences.MaxStopsQuantity` | 59/88 | opcional | `0` (58 casos), `3` (1 caso). |
| `TravelPreferences.CabinPref[]` | 52/88 | opcional, **`maxItems: 3`** | Ver §6.2 para el enum completo. |
| `TravelPreferences.VendorPref[].Code` | 79/88 | opcional | Ver §5.4 — **corregido**. |
| `TravelPreferences.Baggage.{RequestType,Description,…}` | 0/88 | opcional | **`RequestType` enum `A`\|`C`\|`N`** (`v5.yml:5885`). `A`=allowance, `C`=allowance+cargos, `N`=nada. **Sin esto no hay equipaje** (§7.4). |
| `…TPA_Extensions.NumTrips.Number` | 87/88 | opcional, **default 9, min 1** (`v5.yml:7393`) | Cuántos itinerarios devolver. |
| `…TPA_Extensions.DataSources.{NDC,ATPCO,LCC}` | 88/88 | opcional, enum `Enable`\|`Disable` | §4. |
| `…TPA_Extensions.PreferNDCSourceOnTie.Value` | 29/88 | opcional, bool | Desempate a favor de NDC. §4.2. |
| `…TPA_Extensions.FlexibleFares.FareParameters[]` | 1/88 | opcional | Grupos de tarifa alternativos. `Cabin.Type`, `ExcludeRestricted.Ind`, `ClassOfService[]`, `CorporateID[]` (hasta 25). |
| `TravelerInfoSummary` | 88/88 | **obligatorio** | |
| `…PassengerTypeQuantity[].Code` | 88/88 | obligatorio | §5.5 — **corregido y ampliado**. |
| `…PassengerTypeQuantity[].Quantity` | 88/88 | obligatorio | `1`, `2`, `3`. |
| `…PassengerTypeQuantity[].TPA_Extensions.VoluntaryChanges` | 1/88 | opcional | **Es el interruptor de `penaltiesInfo` en la respuesta** (§7.4). |
| `TravelerInfoSummary.PriceRequestInformation.CurrencyCode` | **0/88** | **opcional — EXISTE** | **§6.2. El hallazgo que corrige la 1ª pasada.** |
| `…PriceRequestInformation.AccountCode[]` / `NegotiatedFareCode[]` | 0/88 | opcional | **Tarifas negociadas.** Es el mecanismo de contratos propios de una agencia — BYOC de tarifa, no sólo de credencial. |
| `…BrandedFareIndicators.SingleBrandedFare` | 34/88 | opcional, **default `true`** (`v3.yml:3712`) | Una marca por itinerario. |
| `TPA_Extensions.IntelliSellTransaction.RequestType.Name` | 88/88 | opcional | `50ITINS`\|`100ITINS`\|`200ITINS`. §8. |
| `TPA_Extensions.IntelliSellTransaction.MultipleSourcePerItinerary.Value` | **0/88** | opcional, **v4+** | **§4.2. Obligatorio para nosotros.** |
| `TPA_Extensions.IntelliSellTransaction.AirStreaming` | 0/88 | opcional | Respuesta en chunks. §8.3. |
| `TPA_Extensions.IntelliSellTransaction.CompressResponse.Value` | 0/88 | opcional, default `false` | Respuesta GZIP en base64. §8.3. |
| `AvailableFlightsOnly` | 0/88 | opcional, **default `true`** | `false` devuelve tarifas sin mirar disponibilidad de clase. **No tocar**: mostraríamos vuelos no vendibles. |

### 5.3 `RPH` no correlaciona la respuesta — hay un campo dedicado

El riesgo #11 de la primera pasada temía que un `RPH` mal basado desordenara ida y vuelta. **El contrato lo desactiva:** la correlación tramo-pedido ↔ itinerario-devuelto se hace con un campo propio de la respuesta:

```yaml
# bargain-finder-max-v5.yml:4199
itineraries[].originDestinationInformationRef:
  type: integer
  description: Reference number to `OriginDestinationInformation` from request to
    match one-way itineraries into full journey.
```

`RPH` es opcional y los ejemplos oficiales no lo mandan. **Riesgo #11 degradado a nota.** Mandarlo base-1 por higiene y correlacionar por `originDestinationInformationRef`.

### 5.4 `VendorPref[].Code` — corrección de un valor inventado

> **Corrección (hallazgo 1 de la crítica — ACEPTADO).** La primera pasada listó `QR` entre los valores observados, en una tabla marcada "VERIFICADO". **`QR` no aparece ni una vez como código de vendor en ningún body de la colección** (`grep -c '"QR"' requests.jsonl` → **0**). Sólo existe como nombre de carpeta (`Workflows / 15 … / QR airline`), donde el body usa una variable Postman sin resolver. Era un valor inventado presentado como verificado, justo en la tabla que un implementador copiaría al builder. Queda eliminado.

Valores reales (**VERIFICADO** — parseo de los 79 bodies con `VendorPref`):

| Tipo | Valores |
| --- | --- |
| **Códigos IATA literales (11)** | `AA`, `AF`, `AS`, `BA`, `EY`, `FR`, `LO`, `QF`, `SQ`, `U2`, `UA` |
| **Variables Postman sin resolver (7)** | `{{airline}}`, `{{airlineCode}}`, `{{airlineEmd}}`, `{{airline_code}}`, `{{atpco_airline_code}}`, `{{lcc_airline_code}}`, `{{lcc_second_airline_code}}` |

El dato relevante que la primera pasada no vio: **7 de los 18 valores son variables**, o sea que la colección **no fija el carrier** en buena parte de los ejemplos NDC. La conclusión de §4.2 sobre LCC (los 8 requests LCC llevan carrier concreto o variable de carrier) se mantiene.

### 5.5 Los códigos de pasajero: `INF` sí existe

Nuestro `PaxTypeSchema` (`packages/canonical/src/pax.ts:3`) es `['ADT','CHD','INF']`.

| Nuestro | Sabre | Evidencia |
| --- | --- | --- |
| `ADT` | `ADT` | **VERIFICADO** — 88/88 bodies, y los 3 ejemplos oficiales. |
| `CHD` | **`CNN`** o **`C06`…`C11`** | **VERIFICADO** — `Workflows / 18` usa `CNN`. **VERIFICADO-SPEC** — el ejemplo 2 oficial usa `C06` y lo explica: *"The three-character ATPCO passenger type code. The code `C06` in our example refers to a six-year-old child"* (`v5.yml:607`). O sea: `CNN` es "niño genérico" y `C##` es "niño de ## años" — **con `C##` Sabre puede aplicar descuentos por edad que `CNN` no dispara**. Si tenemos `dateOfBirth`, conviene mandar `C##`. |
| `INF` | **`INF`** | **VERIFICADO-SPEC** — el ejemplo 3 oficial, *"Round-Trip for a Family with an Infant"*, manda `{"Code":"INF","Quantity":1}` (`v5.yml:1439`). **Cierra la pregunta abierta #8**: la primera pasada lo marcó `[INFERIDO]` porque la colección no lo usa nunca. El contrato lo usa. |
| — | `INS` | Infante **con asiento**. **VERIFICADO** — `Workflows / 28-33 / Seats - 1 Adult 1 Infant with seat`. No lo modelamos hoy: nuestro `PaxCountSchema` sólo tiene `infants` con la regla "1 lap infant per adult". |

---

## 6. MAPEO DE ENTRADA: `FlightSearchCriteria` → body de BFM

Contrato de origen (`packages/domain/src/ports/flight-search.port.ts:9`):

```ts
{ origin, destination, departureDate, returnDate?, paxCount: {adults,children,infants}, cabin?, currency }
```

### 6.1 Lo que mapea limpio

| Nuestro campo | Destino en BFM | Transformación |
| --- | --- | --- |
| `origin` | `OriginDestinationInformation[0].OriginLocation.LocationCode` | Directo (`IataAirportCodeSchema` ya valida 3 mayúsculas). |
| `destination` | `OriginDestinationInformation[0].DestinationLocation.LocationCode` | Directo. |
| `departureDate` | `OriginDestinationInformation[0].DepartureDateTime` | `` `${departureDate}T00:00:00` ``. Nuestro schema es `z.string().date()`. |
| `returnDate` (si existe) | `OriginDestinationInformation[1]` con origin/destination invertidos | `` `${returnDate}T00:00:00` ``. Si no hay `returnDate`, el array tiene 1 elemento. |
| `paxCount.adults` | `{Code:"ADT", Quantity: adults}` | Directo (siempre ≥ 1 por schema). |
| `paxCount.children` | `{Code:"CNN", Quantity: children}` — omitir si es 0 | `CHD → CNN`. Mejorable a `C##` si hay edad (§5.5). |
| `paxCount.infants` | `{Code:"INF", Quantity: infants}` — omitir si es 0 | **VERIFICADO-SPEC** (`v5.yml:1439`). Ya no es un riesgo. |
| `cabin` | `TravelPreferences.CabinPref[0].{Cabin, PreferLevel}` | Ver §6.2. Omitir el bloque entero si `cabin` es `undefined`. |
| `currency` | `TravelerInfoSummary.PriceRequestInformation.CurrencyCode` | **Directo.** Ver §6.2. |

**Los 7 campos del contrato mapean.** La primera pasada dejaba 2 sin destino; ya no.

### 6.2 Lo que la primera pasada resolvió mal

#### `currency` → **sí tiene destino** (corrección mayor)

> **Lo que decía la 1ª pasada:** *"La moneda no se puede pedir. El body de BFM no tiene ningún campo de moneda — verificado por exclusión sobre los 88 bodies. Nuestro `criteria.currency` no tiene destino."*
>
> **Es falso.** La deducción por exclusión sobre la colección era metodológicamente frágil y falló: el campo existe, la colección simplemente no lo usa nunca (0/88). El contrato lo tiene en **las tres versiones**:

```yaml
# bargain-finder-max-v5.yml:7849  (v4.yml:5650, v3.yml:4979)
OTA_AirLowFareSearchRQ.TravelerInfoSummary.PriceRequestInformation:
  properties:
    CurrencyCode:
      type: string
      pattern: '[a-zA-Z]{3}'
      description: Currency preferred for reviewing monetary values, in ISO 4217. NDC Applicable.
      example: 'USD'
```

Y hay un segundo mecanismo relacionado, con jerarquía documentada:

```yaml
# bargain-finder-max-v5.yml:8127
PointOfSaleOverride:
  description: Will return the fares available for specified point of sale and priced in
    this point of sale currency. Currency is overridden by PriceRequestInformation@CurrencyCode.
```

**Lectura:** el PCC/punto de venta fija una moneda por defecto, `PointOfSaleOverride` la cambia por mercado, y `PriceRequestInformation.CurrencyCode` **gana sobre ambos**. La intuición de la primera pasada ("la moneda la determina el PCC") era **correcta como default** y **equivocada como límite**.

> **Qué cambia en la decisión de producto.** La primera pasada planteó A (un PCC por mercado) / B (convertir nosotros) / C (mostrar la moneda de Sabre). Con el contrato:
>
> **Mandar siempre `PriceRequestInformation.CurrencyCode = criteria.currency`.** Es una línea en el builder y el `SearchController` deja de prometer una moneda que el proveedor ignora.
>
> **Pero no cerrar el tema:** pedir COP no garantiza tarifa colombiana. `CurrencyCode` cambia **en qué moneda se expresa** el precio; el **catálogo de tarifas y las reglas de venta** los sigue fijando el punto de venta (por eso existe `PointOfSaleOverride`). O sea que la opción A (un PCC por mercado) **sigue siendo lo correcto operativamente** para vender tarifa local, sólo que ya no es la única defensa contra el descuadre de moneda.
>
> **Y hay que seguir validando en el mapper:** la respuesta trae la moneda que Sabre efectivamente usó (`totalFare.currency`). Si no coincide con la pedida, warning explícito, igual que hace `providers/latam-ndc/src/airshopping/response.mapper.ts`. No confiar en que el request se respetó.

**Riesgo #2 baja de Alto a Medio.**

#### `cabin` → el enum está documentado, y `premium_economy` no era `W`

> **Lo que decía la 1ª pasada:** `economy→Y` VERIFICADO, `premium_economy→W` [INFERIDO], `business→C o J` [INFERIDO], `first→F` [INFERIDO].

El spec da la lista cerrada (**VERIFICADO-SPEC**: `v3.yml:37`, `v4.yml:4198`, `v5.yml:6422`; enum literal en `v5.yml:5653`):

> *"Cabin is either Premium First (P), First (F), Premium Business (J), Business (C), Premium Economy (S) or Economy (Y)."*
>
> `enum: [PremiumFirst, First, PremiumBusiness, Business, PremiumEconomy, Economy, Y, S, C, J, F, P]`

| `CabinClass` nuestro | `CabinPref[].Cabin` | Estado |
| --- | --- | --- |
| `economy` | **`Y`** | **VERIFICADO-SPEC** |
| `premium_economy` | **`S`** | **VERIFICADO-SPEC** — ~~`W`~~ **era incorrecto**. `W` no está en el enum. |
| `business` | **`C`** | **VERIFICADO-SPEC** — `J` existe pero es **Premium Business**, una cabina distinta. |
| `first` | **`F`** | **VERIFICADO-SPEC** — `P` es Premium First. |

Sabre distingue **seis** cabinas donde nuestro `CabinClassSchema` tiene cuatro. `P` y `J` no tienen destino canónico: al mapear la **respuesta**, `cabinCode: "P"` debe colapsar a `first` y `"J"` a `business`, o Zod tira.

Nota: `providers/latam-ndc/src/airshopping/request.builder.ts` tiene un `CABIN_MAP` con `{premium_economy:'W', business:'J', first:'J'}`. **No copiarlo para Sabre**: `W` no existe en el enum de Sabre y `J` significa otra cosa. Cada ACL su vocabulario — que es justo el motivo por el que existe el ACL.

`PreferLevel` tiene default `"Preferred"` y enum `[Preferred, Unacceptable]` (`v5.yml:5668`). `"Preferred"` **prefiere pero no fuerza**: si queremos que business signifique business, hay que verificar en sandbox si devuelve economy igualmente.

### 6.3 Campos obligatorios de Sabre que HOY NO TENEMOS

| Campo Sabre | Estado en nuestro sistema | Qué hay que construir |
| --- | --- | --- |
| `POS.Source[].PseudoCityCode` | **No existe.** Ni en `FlightSearchCriteria`, ni en `SearchContext` (`{tenantId, requestId?}`). | Campo en `provider_accounts` para `sabre`, resuelto por `ProviderCredentialsService.resolve(tenantId,'sabre')` con herencia consolidador→agencia. |
| OAuth `client_id` = `V1:{username}:{pcc}:AA` | **No existe.** `LatamNdcConfig` tiene `apiKey/apiSecret`. | `SabreConfig { username, password, pcc, requestorId?, companyCode?, currencyCode? }` + `TokenService` con cache, como `providers/latam-ndc/src/auth/token.service.ts`. **El 429 "Active token count is exceeded" (§2.2) hace que la caché sea obligatoria, no una optimización.** |
| `RequestorID.{Type,ID}`, `CompanyName.Code` | **No existen.** | Constantes en el builder: `Type:"1"`, `ID:"1"`, `Code:"TN"`. **Ya no hay duda** (§5.2). |
| `DataSources` + `MultipleSourcePerItinerary` | **No existen** como concepto de dominio. | Constantes del builder (§4.2), no parámetros que el vendedor toque. |
| `AccountCode` / `NegotiatedFareCode` | **No existen.** | **Ola 2.** Es donde vive el contrato negociado propio de cada agencia — el BYOC de tarifa. Modelarlo en `provider_accounts` desde ya aunque no se use. |
| `VendorPref`, `MaxStopsQuantity`, `DepartureWindow` | **No existen** en `FlightSearchCriteria`. | Nice-to-have. Bloqueante sólo si activamos LCC. |

**Lectura para el plan (sin cambios, y reforzada):** el 100% de los gaps de entrada son **de configuración BYOC, no de criterio de búsqueda**. No hay que tocar `FlightSearchPort` ni la UI. Con la corrección de `currency` (§6.2), **ya no queda ninguna excepción**: la primera pasada decía "`currency` sí es un criterio y sí se rompe" — ya no se rompe.

---

## 7. MAPA DE CAMPOS: respuesta de BFM → `Offer` canónico

> **Esta sección se reescribió por completo.** La primera pasada sólo tenía ~12 rutas sacadas de scripts de Postman y marcó el resto DESCONOCIDO. Todo lo de aquí es **VERIFICADO-SPEC** contra `bargain-finder-max-v5.yml`: el schema (`:3799` en adelante) y los tres ejemplos de respuesta completos (`:120`, `:667`, `:1456`).

### 7.1 Arquitectura de la respuesta: diccionarios + referencias

La respuesta **no está anidada**: es un conjunto de arrays-diccionario en la raíz, y los itinerarios los referencian por `id`. Las 26 secciones de `groupedItineraryResponse` (**VERIFICADO-SPEC**: `v5.yml:3810`):

```
version · messages · statistics · scheduleDescs · scheduleMessages · legDescs
taxDescs · taxSummaryDescs · obFeeDescs · fareComponentDescs · validatingCarrierDescs
baggageAllowanceDescs · baggageChargeDescs · brandFeatureDescs · priceClassDescriptions
flightAmenities · passengerDescs · originalItineraryDesc · utaDescs
upaDescs · upaCategoryDescs · upaPhotoDescs · upaVideoDescs · upaTourDescs
upaSeatCharacteristicDescs · itineraryGroups
```

La cadena de referencias, que es **lo que la primera pasada declaró DESCONOCIDO y sin lo cual no hay mapper**:

```
itineraryGroups[g]
├── groupDescription.legDescriptions[i]      → { departureDate, departureLocation, arrivalLocation }
└── itineraries[n]
    ├── id, pricingSource, originDestinationInformationRef
    ├── legs[i].ref  ─────────────────────►  legDescs[].id
    │   └── legs[i].departureDate (opcional, redundante con legDescriptions[i])
    └── pricingInformation[p]
        ├── offer { offerId, source, timeToLive }
        ├── distributionModel, brand, pricingSubsource, cached, pseudoCityCode
        ├── penaltiesInfo.penalties[]
        └── fare
            ├── totalFare { … }
            ├── validatingCarrierCode, lastTicketDate, lastTicketTime
            ├── offerItemId
            ├── validatingCarriers[].ref ──►  validatingCarrierDescs[].id
            └── passengerInfoList[].passengerInfo
                ├── passengerType, passengerNumber, nonRefundable
                ├── passengerTotalFare { … }
                ├── taxes[].ref ───────────►  taxDescs[].id
                ├── taxSummaries[].ref ────►  taxSummaryDescs[].id
                ├── obFees[].ref ──────────►  obFeeDescs[].id
                ├── fareComponents[].ref ──►  fareComponentDescs[].id
                │   └── .segments[].segment { bookingCode, cabinCode, mealCode, seatsAvailable }
                └── baggageInformation[].allowance.ref ─► baggageAllowanceDescs[].id

legDescs[].schedules[j] { ref, departureDateAdjustment } ─► scheduleDescs[].id
```

**Dos trampas que hay que documentar en el mapper:**

1. **`itineraries[].legs[i].ref` apunta a `legDescs[]`, pero la FECHA del tramo `i` sale de `groupDescription.legDescriptions[i]` — por POSICIÓN, no por ref.** Son dos arrays distintos con índices distintos. En el ejemplo 1, `legs: [{ref:2},{ref:1}]` mientras `legDescriptions[0]` es el tramo de ida: el `ref` está invertido respecto de la posición y **usar el `ref` para indexar las fechas invierte ida y vuelta**.
2. **Los scripts de Postman de la colección acceden a `scheduleDescs[0]` y `[1]` por índice ciego** y asumen que son ida y vuelta. Funciona con 1 itinerario; **con 50 itinerarios es incorrecto**. No copiar ese patrón.

### 7.2 Mapa de campos completo

#### `Offer` (`packages/canonical/src/offer.ts`)

Sea `pi = itineraries[n].pricingInformation[p]`.

| Campo canónico | Ruta en la respuesta de BFM | Estado |
| --- | --- | --- |
| `Offer.total` | `pi.fare.totalFare.totalPrice` + `.currency` | **VERIFICADO-SPEC** `v5.yml:9694`. `required: [totalPrice, totalTaxAmount, currency]`. Ejemplo: `131.8 USD`. |
| `Offer.baseFare` | **`pi.fare.totalFare.equivalentAmount` + `.equivalentCurrency`** | **VERIFICADO-SPEC** — ver la trampa de moneda abajo. |
| `Offer.taxes` | `pi.fare.totalFare.totalTaxAmount` + `.currency` | **VERIFICADO-SPEC** `v5.yml:9765`. |
| `Offer.fees` | `pi.fare.totalFare.{bookingFeeAmount, creditCardFeeAmount, serviceFeeAmount, serviceFeeTax, airExtrasAmount}` + los `obFeeDescs[]` referenciados | **VERIFICADO-SPEC** `v5.yml:9714`, `:9727`, `:9749`. *"Returned only if non-zero value"*. |
| `Offer.fareBreakdown[].paxType` | `pi.fare.passengerInfoList[].passengerInfo.passengerType` | **VERIFICADO-SPEC**. Mapear `CNN`/`C##`→`CHD`, `INS`→`INF`. |
| `Offer.fareBreakdown[].paxCount` | `…passengerInfo.passengerNumber` | **VERIFICADO-SPEC** `v5.yml:8328`. |
| `Offer.fareBreakdown[].basePerPax` | `…passengerInfo.passengerTotalFare.equivalentAmount` + `.equivalentCurrency` | **VERIFICADO-SPEC** `v5.yml:8487`. |
| `Offer.fareBreakdown[].taxesPerPax` | `…passengerTotalFare.totalTaxAmount` + `.currency` | **VERIFICADO-SPEC**. |
| `Offer.fareFamily.name` | `pi.brand` (Brand ID), enriquecido con `priceClassDescriptions[].descriptions[].text` | **VERIFICADO-SPEC** `v5.yml:8802` y `:8776`. |
| `Offer.fareFamily.cabin` | `…fareComponents[].segments[].segment.cabinCode` | **VERIFICADO-SPEC**. |
| `Offer.baggage.checked.qty` | `…passengerInfo.baggageInformation[].allowance.ref` → `baggageAllowanceDescs[].pieceCount` | **VERIFICADO-SPEC** `v5.yml:2541`. **Sólo si se pidió** (§7.4). |
| `Offer.baggage.checked.weightKg` | `baggageAllowanceDescs[].weight` + `.unit` (`lbs`\|`kg`) | **VERIFICADO-SPEC**. **Convertir si es `lbs`.** |
| `Offer.baggage.carryOn` | `TravelPreferences.Baggage.CarryOnInfo = true` en el request; luego `utaDescs` / `baggageChargeDescs` | **VERIFICADO-SPEC** `v5.yml:5865`. Requiere pedirlo aparte. |
| `Offer.policies.refundable` | `pi.penaltiesInfo.penalties[]` con `type:"Refund"` → `.refundable` **o** `…passengerInfo.nonRefundable` (negado) | **VERIFICADO-SPEC** `v5.yml:2013` y `:475`. Dos fuentes; ver §7.4. |
| `Offer.policies.changeable` | `pi.penaltiesInfo.penalties[]` con `type:"Exchange"` → `.changeable` | **VERIFICADO-SPEC** `v5.yml:1999`. |
| `Offer.provider.offerRef` | `pi.offer.offerId` (+ `pi.fare.offerItemId` para NDC) | **VERIFICADO-SPEC** `v5.yml:8226`. |
| `Offer.expiresAt` | **`fetchedAt + pi.offer.timeToLive` segundos** | **VERIFICADO-SPEC** `v5.yml:8243`. |
| `Offer.products` | `['flight']` | constante |
| — (sin destino canónico) | `pi.offer.source`, `pi.distributionModel` | **Necesarios para el ciclo de reserva** (§4.3). Hoy no caben en `OfferSchema`. |
| — | `pi.cached.{timeToLive, hoursSinceCreation}` | Señal de que el precio no es en vivo. Sin destino. |
| — | `pi.pseudoCityCode` | Qué PCC produjo la tarifa (multi-PCC). Sin destino. |
| — | `pi.fare.lastTicketDate` + `.lastTicketTime` | **Deadline de emisión.** No es el TTL de la oferta: es hasta cuándo se puede emitir el billete una vez reservado. Sin destino canónico y **hace falta** para el CRM de seguimiento. |

> #### La trampa de moneda de `totalFare` — leerla antes de escribir el mapper
>
> `totalFare` mezcla **tres monedas distintas en el mismo objeto** (ejemplo 1 oficial, `v5.yml:570`):
>
> ```json
> { "totalPrice": 131.8, "totalTaxAmount": 73.8, "currency": "USD",
>   "baseFareAmount": 235.0, "baseFareCurrency": "PLN",
>   "equivalentAmount": 58.0, "equivalentCurrency": "USD",
>   "constructionAmount": 53.72, "constructionCurrency": "NUC" }
> ```
>
> - `baseFareAmount` está en **la moneda de publicación de la tarifa** (`PLN`), no en la de venta.
> - `equivalentAmount` es **esa misma base convertida a la moneda de venta** (`USD`).
> - `constructionAmount` está en **NUC**, la unidad de construcción de IATA. **No es dinero vendible.**
> - Comprobación: `equivalentAmount (58.0) + totalTaxAmount (73.8) = totalPrice (131.8)` ✅ mientras que `baseFareAmount (235.0) + 73.8 ≠ 131.8`.
>
> **Por eso `Offer.baseFare` = `equivalentAmount`/`equivalentCurrency`, NO `baseFareAmount`/`baseFareCurrency`.** Un mapper que coja el campo con el nombre más obvio produce un `Offer` donde `baseFare + taxes ≠ total` y con `Money.add` lanzando por currency mismatch (`packages/canonical/src/money.ts:18`). Es el error más fácil de cometer en todo el documento.
>
> La conversión aplicada viene explícita en `passengerInfo.currencyConversion { from, to, exchangeRateUsed }` y `passengerTotalFare.exchangeRateOne`.

#### Impuestos desglosados

| Qué | Ruta | Nota |
| --- | --- | --- |
| Desglose fino | `passengerInfo.taxes[].ref` → `taxDescs[]` | Un elemento **por tasa y por estación**: `{ id, code, amount, currency, description, publishedAmount, publishedCurrency, station, country }`. Ejemplo: `YQF` cobrada dos veces, en `WAW` y en `SPU`. |
| Resumen agrupado | `passengerInfo.taxSummaries[].ref` → `taxSummaryDescs[]` | Mismo shape, **agrupado por código**. El ejemplo agrupa los dos `YQF` en un `YQ` de `32.6 USD`. |

**Para mostrarle el desglose al vendedor usar `taxSummaryDescs`.** `taxDescs` es para auditoría. **Sumar los dos es contar doble.**

#### `Segment` (`packages/canonical/src/segment.ts`)

Sea `sd = scheduleDescs[]` resuelto vía `legDescs[].schedules[j].ref`.

| Campo canónico | Ruta | Estado |
| --- | --- | --- |
| `Segment.carrier` | `sd.carrier.marketing` | **VERIFICADO-SPEC** `v5.yml:2908`, `required: [marketing, marketingFlightNumber]`. |
| `Segment.flightNumber` | `sd.carrier.marketingFlightNumber` | **VERIFICADO-SPEC**. **Es `integer`, no string** (ej. `576`). Nuestro schema exige `z.string().regex(/^\d{1,4}[A-Z]?$/)` → **convertir**. |
| `Segment.operatingCarrier` | `sd.carrier.operating` | **VERIFICADO-SPEC**. |
| *(sin destino)* | `sd.carrier.operatingFlightNumber` | **VERIFICADO-SPEC** — existe en la respuesta (ej. `576`). **Nuestro `SegmentSchema` no tiene dónde ponerlo.** Ver §9.4.1: sin él, dos codeshares del mismo avión no colisionan en el dedupe. |
| `Segment.origin` | `sd.departure.airport` | **VERIFICADO-SPEC** `v5.yml:3060`, `required: [airport, time]`. |
| `Segment.destination` | `sd.arrival.airport` | **VERIFICADO-SPEC** `v5.yml:2503`. |
| `Segment.departureAt` | **calculado** — ver §7.3 | **VERIFICADO-SPEC** pero requiere reconstrucción. |
| `Segment.arrivalAt` | **calculado** — ver §7.3 | idem |
| `Segment.durationMinutes` | `sd.elapsedTime` | **VERIFICADO-SPEC**. Enteros en minutos (`115`, `120`, `214`). |
| `Segment.cabin` | `passengerInfo.fareComponents[].segments[].segment.cabinCode` | **VERIFICADO-SPEC**. **Vive en el árbol de PRECIO, no en el de horario** — la misma cabina puede diferir entre `pricingInformation` del mismo itinerario. Mapear `Y→economy`, `S→premium_economy`, `C`/`J→business`, `F`/`P→first`. |
| `Segment.bookingClass` | `…segments[].segment.bookingCode` | **VERIFICADO-SPEC** (ej. `"O"`, `"L"`). ⚠️ **No es `scheduleDescs[].ResBookDesigCode`**, que es lo que leen los scripts de la colección. Ver la nota de abajo. |
| `Segment.aircraft` | `sd.carrier.equipment.code` | **VERIFICADO-SPEC** (ej. `"E75"`). |
| *(sin destino)* | `…segment.seatsAvailable` | Asientos en esa clase (ej. `9`). Señal de urgencia útil para la UI. |
| *(sin destino)* | `sd.stopCount`, `sd.totalMilesFlown`, `sd.frequency`, `sd.eTicketable`, `sd.dotRating`, `sd.carrier.alliances`, `sd.departure.terminal` | Todos presentes, ninguno con hueco canónico. |

> **Corrección a §7.1 de la 1ª pasada.** La primera pasada mapeó `Segment.bookingClass` ← `scheduleDescs[].ResBookDesigCode`, citando los scripts de Postman. **`ResBookDesigCode` no aparece en el schema ni en ninguno de los tres ejemplos oficiales de v5.** Es un campo del vocabulario OTA/SOAP que los scripts de la colección leen, probablemente porque esos requests son de otra época. La clase de reserva en la respuesta GIR de v5 es `fareComponents[].segments[].segment.bookingCode`. **Verificar en sandbox si `ResBookDesigCode` sigue viniendo**; mientras tanto, mapear desde `bookingCode` y no desde el script.
>
> Nota adicional: nuestro `bookingClass` exige **exactamente 1 letra mayúscula** (`packages/canonical/src/segment.ts:37`). `bookingCode` cumple en los ejemplos (`"O"`, `"L"`), pero no está garantizado por el spec.

#### `Itinerary` (`packages/canonical/src/itinerary.ts`)

| Campo canónico | Ruta | Estado |
| --- | --- | --- |
| `Itinerary.segments[]` | `legDescs[].schedules[]` resueltos a `scheduleDescs[]`, **en orden del array** | **VERIFICADO-SPEC**. |
| `Itinerary.totalDurationMinutes` | `legDescs[].elapsedTime` | **VERIFICADO-SPEC** `v5.yml:4277`: *"The elapsed time at the LegDesc level… allows customers to display travel time for NDC and ATPCO Offers."* |
| `Itinerary.stops` | `(schedules.length − 1) + Σ scheduleDescs[].stopCount` | **VERIFICADO-SPEC** — conexiones **más** escalas técnicas dentro de un mismo número de vuelo. La primera pasada sólo contaba `stopCount`, que se queda corto. |

**Un `Itinerary` nuestro = un `leg` de Sabre.** Round-trip = 2 legs = 2 itineraries. Encaja limpio con `ItinerarySchema`.

### 7.3 Reconstruir `departureAt` / `arrivalAt` — el trabajo que nadie estimó

> **Hallazgo 3 de la crítica — ACEPTADO Y AMPLIADO.** `cabin`, `durationMinutes`, `departureAt` y `arrivalAt` son **obligatorios** en `SegmentSchema`, con `durationMinutes` además `.positive()` y las dos fechas `.datetime({ offset: true })`. Sólo `aircraft` y `operatingCarrier` son opcionales. **Un campo que falte no da un `Offer` incompleto: da un `Offer` que no existe**, porque Zod tira. Es bloqueante, no "por capturar".

**La crítica acierta en el fondo y hay que matizar la evidencia que cita.** La crítica dice que "la única respuesta real de la colección devuelve `scheduledDateTime: "2019-04-20T20:36:00"` SIN offset". Eso es **cierto** (**VERIFICADO** — `slices/responses/01-Add_phone_Orders_View.json`, que junto a las otras tres pesa 16.479 bytes y **no está vacía**, en contra de lo que afirmaba la primera pasada), pero esa respuesta es de **`/v1/orders/view` (Booking Management), no de BFM**. Para BFM el problema es **distinto y peor**:

```json
// scheduleDescs[0], ejemplo oficial 1 — v5.yml:180
"departure": { "airport": "SPU", "city": "SPU", "country": "HR", "time": "17:10:00+02:00" },
"arrival":   { "airport": "WAW", "city": "WAW", "country": "PL", "time": "19:05:00+02:00" }
```

**Hay offset, pero no hay fecha.** `scheduleDescs` es un diccionario de horarios reutilizable entre itinerarios; la fecha depende de qué tramo lo use. El algoritmo, con todas sus piezas **VERIFICADO-SPEC**:

```
Para el segmento j del tramo i del itinerario n:

  baseDate = itineraryGroups[g].groupDescription.legDescriptions[i].departureDate   // "2026-09-11"   v5.yml:4250
             (o itineraries[n].legs[i].departureDate si viene)                      //                v5.yml:4264
  leg      = legDescs.find(l => l.id === itineraries[n].legs[i].ref)                //                v5.yml:4272
  sched    = scheduleDescs.find(s => s.id === leg.schedules[j].ref)                 //                v5.yml:8978

  depDate  = baseDate + leg.schedules[j].departureDateAdjustment días  (default 0)  //                v5.yml:9102
  departureAt = `${depDate}T${sched.departure.time}`                                // ya trae offset

  arrDate  = depDate + (sched.arrival.dateAdjustment ?? 0) días                     //                v5.yml:2524
  arrivalAt   = `${arrDate}T${sched.arrival.time}`

  durationMinutes = sched.elapsedTime
```

Los dos campos de ajuste, textuales del spec:

- `ScheduleType.departureDateAdjustment` — *"the difference in days between leg departure and departure date of this segment leg", default 0* (`v5.yml:9102`). Es lo que hace que la segunda escala de un tramo que sale a las 23:50 caiga al día siguiente.
- `Arrival.dateAdjustment` — *"The difference, in days, between the flight arrival and departure dates"* (`v5.yml:2524`). Los vuelos nocturnos y los que cruzan la línea de cambio de fecha.

**Ignorar cualquiera de los dos produce fechas silenciosamente incorrectas** — no una excepción, sino un vuelo con el día mal. Es el peor tipo de bug: pasa los tests contra un fixture de vuelo diurno y falla en producción con el vuelo nocturno BOG→MAD.

**Y `arrival.time` puede no traer offset.** El ejemplo lo trae (`"19:05:00+02:00"`) pero el schema documenta `example: '01:05:00'` sin offset (`v5.yml:2540`), mientras `Departure.time` documenta `example: '12:40:00+04:00'` (`v5.yml:3093`). Si llega sin offset, hay que resolver la zona horaria del aeropuerto de llegada para cumplir `.datetime({ offset: true })`.

> **Estimación que falta en `11-plan-implementacion.md`:** tabla IATA → zona horaria (o dependencia tipo `airport-timezone`) + esta aritmética de fechas + sus tests de vuelo nocturno y cruce de meridiano. **No es "mapear un campo".** Los tres ejemplos oficiales son todos vuelos diurnos cortos con `dateAdjustment` ausente, así que **los fixtures que tenemos no ejercitan este código**.

### 7.4 Equipaje y penalidades: hay que pedirlos

La pregunta abierta #5 de la primera pasada (*"¿BFM devuelve equipaje y penalidades sin pedirlo?"*) se responde comparando los tres ejemplos oficiales:

| Ejemplo | El request pide… | La respuesta trae… |
| --- | --- | --- |
| **1** — adulto, RT | nada de equipaje ni penalidades | `baggageAllowanceDescs: [{id:1, pieceCount:0}]` (mínimo), **sin `baggageChargeDescs`**, **sin `penaltiesInfo`**. Sólo el booleano `passengerInfo.nonRefundable: true`. |
| **2** — niño + equipaje | `TravelPreferences.Baggage: { RequestType: "C", Description: true }` | `baggageAllowanceDescs` **+ `baggageChargeDescs`** con `equivalentAmount: 120 EUR`, `firstPiece: 1`, `"UP TO 50 POUNDS/23 KILOGRAMS"`. |
| **3** — familia con infante | `PassengerTypeQuantity[].TPA_Extensions.VoluntaryChanges: { Match:"All", Penalty:[{Type:"Refund"}] }` | **`penaltiesInfo.penalties[]`** con `{type:"Exchange"\|"Refund", applicability:"Before"\|"After", changeable\|refundable, amount, currency}`. |

**Conclusión: son dos interruptores, y hay que activar los dos en toda búsqueda.**

```jsonc
"TravelPreferences": {
  "Baggage": { "RequestType": "C", "Description": true, "CarryOnInfo": true }
},
"TravelerInfoSummary": {
  "AirTravelerAvail": [{
    "PassengerTypeQuantity": [{
      "Code": "ADT", "Quantity": 1,
      "TPA_Extensions": { "VoluntaryChanges": { "Match": "All", "Penalty": [{ "Type": "Refund" }, { "Type": "Exchange" }] } }
    }]
  }]
}
```

Sin ellos, `Offer.baggage` y `Offer.policies` quedan `undefined` (son opcionales, así que no rompen Zod) y **perdemos exactamente el diferencial contra el comparador de precio pelado** — que es la razón por la que existe el producto. `RequestType: "C"` en vez de `"A"` porque queremos también el **cargo** por maleta, no sólo la franquicia: es lo que permite comparar Basic + maleta contra la tarifa que ya la incluye.

**Ojo con el coste:** `Description: true` y `CarryOnInfo: true` engordan la respuesta. Medir en sandbox contra el presupuesto de latencia (§8.3).

Nota sobre refundabilidad: hay **dos fuentes que pueden discrepar**. `passengerInfo.nonRefundable` (booleano simple, viene siempre) y `penaltiesInfo.penalties[].refundable` (por aplicabilidad Before/After, sólo si se pide). **Preferir `penaltiesInfo`**; usar `nonRefundable` como fallback. "Reembolsable antes de la salida pero no después" es un caso real que el booleano no expresa.

### 7.5 `messages` y `statistics`: detección de degradación

```yaml
# bargain-finder-max-v5.yml:3806 — required: [version, messages]
messages[]:    { severity, type, code, shortCode, text, value, numberOfOccurences }   # v5.yml:4303
statistics:    { itineraryCount, branded, departed, legMissed, numberOfPccsProcessed, oneWay, soldOut }  # v5.yml:9388
```

`messages` es **obligatorio** en la respuesta. En el ejemplo 1 los cuatro son `severity: "Info"` con el transaction ID y los rule IDs de Sabre. **Un `severity` distinto de `Info` es una degradación parcial que hay que propagar**, no ignorar — enlaza directamente con el problema de degradación silenciosa de §8.2.

`statistics.legMissed` y `.soldOut` son señales explícitas de "te devolví menos de lo que había". `statistics.numberOfPccsProcessed` cierra el bucle con `POS.MultiSourceControl` (§3.2). `statistics.itineraryCount` ya lo usaba la colección para reintentar (**VERIFICADO** — `ModifyBooking / … / Add FOP / Bargain Finder Max with repeat`: `if (itineraryCount <= 0) { reintentar }`).

### 7.6 Qué queda sin verificar

| Qué | Por qué |
| --- | --- |
| Cobertura y contenido en rutas **LATAM** (BOG→LIM, GRU→SCL) | Los tres ejemplos oficiales son Europa (`WAW`/`SPU`) y EE. UU. (`ORD`/`TUS`). Ninguna evidencia de qué devuelve Sabre en nuestro mercado. |
| Si `ResBookDesigCode` sigue viniendo en v5 | Los scripts de la colección lo leen; el spec de v5 no lo menciona (§7.2). |
| Valores reales de `pi.brand` para carriers LATAM | El campo está verificado; su vocabulario no. |
| Si `CabinPref.PreferLevel: "Preferred"` filtra de verdad o sólo ordena | El default no fuerza (§6.2). |
| Latencia real y tamaño de payload con `Baggage` + `VoluntaryChanges` activos | §8.3. |

**Plan de captura reducido.** La primera pasada pedía 6 llamadas al sandbox como bloqueante del mapper. Con los 3 ejemplos oficiales como fixtures iniciales, **bajan a 3 y dejan de ser bloqueantes**:

| # | Llamada | Qué resuelve |
| - | --- | --- |
| 1 | `/v5`, `BOG→LIM`, RT, 2 ADT + 1 CNN, todas las fuentes, `MultipleSourcePerItinerary:true`, `Baggage.RequestType:"C"`, `VoluntaryChanges` | Contenido LATAM, `brand`, mezcla real ATPCO/NDC, `ResBookDesigCode` |
| 2 | Igual con `CurrencyCode: "COP"` | Si la moneda pedida se respeta (§6.2) |
| 3 | Un vuelo nocturno con cambio de día (p. ej. `BOG→MAD`) | **Ejercitar `departureDateAdjustment` y `arrival.dateAdjustment`** — el código que los fixtures oficiales no tocan (§7.3) |

Guardar los payloads en `providers/sabre/fixtures/` con PII redactada, junto a los 3 ejemplos oficiales, como fixtures del mapper y del modo mock — igual que `providers/latam-ndc/src/fixtures.ts`.

---

## 8. Paginación, volumen y latencia

### 8.1 Los dos diales

| Dial | Valores | Qué controla |
| --- | --- | --- |
| `IntelliSellTransaction.RequestType.Name` | `50ITINS`, `100ITINS`, `200ITINS` | Techo de itinerarios de la **transacción**. |
| `TravelPreferences.TPA_Extensions.NumTrips.Number` | default **9**, mínimo 1 | Cuántos itinerarios **devolver**. |

**El spec advierte de dos formas de romperlo** (**VERIFICADO-SPEC**: `v5.yml:5537`):

> *"If a Request Type other than the ones listed above is used, the response is **'No Availability'**. Using a Request Type name for **a tier to which you are not subscribed** also returns a 'No Availability' response."*

Dos consecuencias operativas:

1. **`RequestType` es un tier contratado, no un parámetro libre.** Si la agencia no tiene `200ITINS` contratado y lo pedimos, Sabre no devuelve un error: devuelve **cero resultados**. Eso se ve exactamente igual que "no hay vuelos". **Hay que hacerlo configurable por `provider_account` y validarlo al dar de alta la credencial**, o pasaremos días depurando "búsquedas vacías" que son un problema de contrato.
2. Confirma que `RequestType` es una **decisión económica** (pregunta abierta #13 de la primera pasada), no técnica.

**No hay paginación por cursor ni offset** — ningún `page`, `offset` ni `nextToken` en los 88 bodies ni en el schema. El único control de volumen es pedir menos, y "ver más" cuesta repetir la búsqueda entera.

Combinaciones observadas en la colección (**VERIFICADO**): `200ITINS`+`NumTrips:2` (36), `200ITINS`+`10` (22), `100ITINS`+`10` (12), `50ITINS`+`2` (11), y colas menores. Los tres ejemplos **oficiales** usan `50ITINS` sin `NumTrips`.

### 8.2 Impacto en el fan-out (sigue vigente, sin cambios)

`apps/api/src/search/search.service.ts:16` define `SEARCH_CACHE_TTL_SECONDS = 90` y cachea por `sha256(JSON.stringify(criteria))` + tenant. `apps/api/src/search/circuit-breaker.service.ts:6` define `OPEN_MS = 30_000`.

Tres problemas que aparecen **al sumar un segundo proveedor** — ninguno culpa de Sabre, todos activados por él:

1. **La caché no sabe qué proveedores respondieron.** Si Sabre está en circuito abierto cuando se llena la caché, durante 90 s **todas** las búsquedas de ese tenant devuelven un resultado sin Sabre, aunque Sabre se recuperara a los 30 s. **El TTL de caché es 3× la ventana del breaker.** Propuesta: guardar `succeeded[]` en la entrada y no servirla si falta un proveedor que ahora está sano; o TTL reducido para resultados parciales.
2. **`failed` se descarta.** `fanOut` devuelve `{items, succeeded, failed}` pero `searchFlights` sólo usa `failed` para decidir si lanzar cuando `items.length === 0`. Con dos proveedores, **el vendedor ve menos vuelos y nadie le dice por qué** — justo lo que el comentario de `provider-fanout.ts` dice que no hay que hacer. El contrato de `/search/flights` tiene que crecer a `{ offers, simulated, degraded?: {provider, reason}[] }`.
3. **`simulated: adapter.isMock` es un booleano global.** Con dos proveedores uno puede estar en mock y el otro real. Tiene que pasar a ser por proveedor.

**Añadido tras leer el spec:** el punto 2 se amplía. La degradación no viene sólo de que el proveedor falle: **BFM puede responder 200 y aun así estar degradado**, y lo dice en `messages[].severity` y en `statistics.{legMissed,soldOut}` (§7.5). Y el `404 "Response does not contain any data"` (§2.2) **no debe contar como fallo del proveedor** o el breaker abrirá en cada ruta sin vuelos.

### 8.3 Recomendación de volumen

Principio no negociable #1: tiempo a venta < 2 minutos.

> **Propuesta:** `RequestType = "50ITINS"` (lo que usan los tres ejemplos oficiales) con `NumTrips.Number = 20`, `SingleBrandedFare: true`, `Baggage.RequestType: "C"` y `VoluntaryChanges`. `200ITINS` sólo para un "ver más opciones" explícito, **y sólo si el tier está contratado** (§8.1).

**Dos salidas de emergencia que el contrato nos da y la primera pasada no conocía:**

| Herramienta | Qué hace | Cuándo usarla |
| --- | --- | --- |
| `IntelliSellTransaction.CompressResponse.Value: true` | Respuesta en **GZIP base64** (`v5.yml:5512`) | Si el payload con equipaje + penalidades pesa. Coste: un `gunzip` en el ACL. Barato. |
| `IntelliSellTransaction.AirStreaming.{Method, MaxItinsPerChunk}` | Respuesta **en chunks** (`v5.yml:5492`), `Method: "Services"` \| `"WholeResponse"` | **Es el camino a la búsqueda progresiva** que §8.3 de la primera pasada proponía inventar ("responder con lo de LATAM y hacer streaming de lo de Sabre"). Sabre ya lo soporta de forma nativa. Requiere trabajo del lado cliente y una guía dedicada de Sabre. |

**A medir en sandbox:** latencia p50/p95 de `50ITINS` vs `200ITINS` en `BOG→LIM`, con y sin `Baggage`+`VoluntaryChanges`. Si `200ITINS` está bajo 3 s, no limitamos. Si pasa de 8 s, la conversación es `AirStreaming`, no búsqueda asíncrona propia.

---

## 9. Deduplicación entre Sabre y LATAM

> **Esta sección se mantiene y se refuerza.** El contrato no la desmiente: **la confirma desde el lado de Sabre**, que aplica exactamente el dedupe que aquí se describe como bug.

### 9.1 El estado actual

`dedupeCheapest` existe en `apps/api/src/search/provider-fanout.ts:59` y **no se usa en `searchFlights`**. Su firma:

```ts
dedupeCheapest<T>(items: T[], keyOf: (item:T)=>string, priceOf: (item:T)=>number): T[]
```

Se queda con **un** elemento por clave: el de menor `priceOf`.

### 9.2 Por qué "el mismo vuelo, el más barato" está mal — y por qué ahora hay dos capas del problema

Sabre ATPCO y LATAM NDC van a devolver el **mismo avión** (LA2400 BOG→LIM) con **productos distintos**:

| Proveedor | Producto | Precio | Maleta | Cambios |
| --- | --- | ---: | --- | --- |
| LATAM NDC | Basic / Light | 180 $ | No | No |
| Sabre ATPCO | Tarifa publicada Y | 260 $ | 23 kg | Con cargo |

`dedupeCheapest` con clave de itinerario se queda con la de 180 $ y **borra la de 260 $**. El vendedor pierde el producto que probablemente quiere vender (más margen, cliente con maleta) y ni se entera de que existió. Eso viola el principio de no ocultar información en silencio.

**Lo nuevo: el mismo error ocurre dentro de Sabre, antes de que veamos nada.**

> *"This allows you to specify what to do if the same journey is returned from ATPCO and NDC channels. **By default, the cheaper will stay.**"*
> — **VERIFICADO-SPEC**: `bargain-finder-max-v5.yml:5476`

Sabre poda por defecto una de las alternativas del mismo viaje entre ATPCO y NDC. Una variante de marca o
equipaje sólo queda cubierta si también se solicitan los branded fares/upsells correspondientes.

> **Hay dos capas y hay que arreglar las dos:**
>
> | Capa | Arreglo |
> | --- | --- |
> | **Dentro de Sabre** (ATPCO vs NDC) | `MultipleSourcePerItinerary.Value = true` en **todo** request. Constante del builder, no configuración (§4.2). |
> | **Entre Sabre y LATAM** | Clave de producto de §9.3, no clave de itinerario. |
>
> Arreglar sólo la segunda deja el problema intacto: estaríamos deduplicando cuidadosamente un catálogo que Sabre ya podó.

### 9.3 Clave de dedupe propuesta

Dos claves, dos usos.

**Clave física** — "¿es el mismo avión?" (para agrupar en la UI):

```
fisica(offer) = offer.itineraries
  .map(it => it.segments
    .map(s => `${s.operatingCarrier ?? s.carrier}${normFlt(s.flightNumber)}` +
              `:${s.origin}-${s.destination}` +
              `:${toUtcMinute(s.departureAt)}`)
    .join('>'))
  .join('||')
```

**Clave de producto** — "¿es la misma oferta?" (para `dedupeCheapest`):

```
producto(offer) = fisica(offer)
  + `|${cabinOf(offer)}`
  + `|bag${offer.baggage?.checked.qty ?? 'x'}`
  + `|ref${offer.policies?.refundable ?? 'x'}`
  + `|chg${offer.policies?.changeable ?? 'x'}`
```

`dedupeCheapest(items, producto, o => o.pricing?.finalMinor ?? o.total.amountMinor)`, y luego agrupar visualmente por `fisica`.

> **Refuerzo del contrato:** la clave de producto sólo funciona si `baggage` y `policies` están **poblados**, y §7.4 demuestra que **no vienen a menos que se pidan**. Si el builder olvida `Baggage.RequestType` o `VoluntaryChanges`, los dos campos son `undefined`, la clave de producto **colapsa a la clave física**, y volvemos a borrar la tarifa buena. **§7.4 y §9.3 son el mismo requisito visto desde dos lados.**

### 9.4 Los cinco detalles que hacen que esto falle si no se cuidan

1. **Codeshare.** LATAM vende LA2400 (operado LA); Sabre puede devolver el mismo avión como AV6789 marketing / LA operating. Por eso la clave usa `operatingCarrier ?? carrier`. **Nuestro `SegmentSchema` tiene `operatingCarrier?` pero no `operatingFlightNumber`.** Sin el número operado, dos codeshares del mismo avión no colisionan.
   **Ahora sabemos que el dato existe y lo estamos tirando:** `scheduleDescs[].carrier.operatingFlightNumber` está en el schema y en los tres ejemplos oficiales (**VERIFICADO-SPEC**: `v5.yml:2908`). **Gap concreto y ya sin excusa: añadir `operatingFlightNumber?: string` a `packages/canonical/src/segment.ts`.**
2. **Normalizar el número de vuelo.** `"0245"` y `"245"` son el mismo vuelo; nuestro regex `^\d{1,4}[A-Z]?$` acepta ambos. Y Sabre lo manda como **integer** (`576`), así que el ACL ya hace una conversión — que es el sitio natural para normalizar. `normFlt` quita ceros a la izquierda y mayusculiza el sufijo.
3. **Comparar horas en UTC.** `Segment.departureAt` es ISO con offset y dos proveedores pueden expresar la misma salida con offsets distintos (`-05:00` vs `Z`). `toUtcMinute = s => new Date(s).toISOString().slice(0,16)`. **Depende por completo de que §7.3 esté bien resuelto:** si la fecha reconstruida está mal por un `dateAdjustment` ignorado, la clave física falla y nada deduplica.
4. **Comparar precios en la misma moneda.** `dedupeCheapest` compara `amountMinor` crudo. Si Sabre devuelve USD y LATAM COP, "el más barato" es basura (400.000 COP < 260 USD en número). Mínimo viable: **si en el conjunto hay más de una moneda, no deduplicar** y dejar ambas visibles con su moneda. Peor un duplicado que un precio equivocado.
   **Mitigado, no resuelto, por §6.2:** ahora podemos pedir la misma moneda a los dos proveedores, lo que hace el caso raro. Pero pedirla no es garantía de obtenerla, así que **la guarda se queda**.
5. **Dedupe después del waterfall, no antes.** `withPricing` aplica el markup del tenant por igual hoy, así que el orden relativo no cambia. Pero con reglas por proveedor (comisión distinta con Sabre que con LATAM), "el más barato para nosotros" deja de ser "el más barato para el cliente". Deduplicar por `pricing.finalMinor` cuando existe, y por `total.amountMinor` sólo como fallback.

### 9.5 Dónde va el código

Por el punto 5, **después** de `withPricing`:

```
fanOut → (si items.length===0 && failed) throw → withPricing → dedupe → return {offers, degraded, simulatedByProvider}
```

---

## Preguntas abiertas

> Resueltas por el contrato y **retiradas** de esta lista: si `DataSources` admite multi-fuente (§4.1, sí) · la forma de `groupedItineraryResponse` y cómo `itineraries` referencia `scheduleDescs` (§7.1) · dónde está el precio y en qué monedas (§7.2) · si vienen las fechas de salida y llegada (§7.3, reconstruidas) · si BFM devuelve equipaje y penalidades sin pedirlo (§7.4, no) · cuánto vive una oferta (§3.3, `offer.timeToLive`) · qué valores acepta `CabinPref.Cabin` (§6.2) · si `INF` es un PTC válido (§5.5, sí) · si `RequestorID.ID = "1"` es correcto (§5.2, sí) · si se puede pedir la moneda (§6.2, sí).

1. **¿Qué contenido tiene Sabre en rutas LATAM?** Los tres ejemplos oficiales son Europa y EE. UU. Sin una llamada a `BOG→LIM` no sabemos si Sabre nos aporta algo sobre LATAM NDC, que es lo único que justifica el fan-out.
2. **¿`PriceRequestInformation.CurrencyCode` se respeta de verdad, o el PCC manda igualmente?** El contrato dice que gana sobre `PointOfSaleOverride`, pero eso es la moneda de expresión, no el catálogo de tarifas. Decide si necesitamos un PCC por mercado o basta uno (§6.2).
3. **¿Qué tier de `RequestType` tiene contratado cada agencia?** Pedir un tier no contratado devuelve **cero resultados sin error** (§8.1). Hay que poder consultarlo o validarlo al alta de la credencial, o depuraremos "no hay vuelos" que son un problema de contrato.
4. **¿`ResBookDesigCode` sigue viniendo en la respuesta de v5?** Los scripts de la colección lo leen; el schema de v5 no lo menciona (§7.2). Afecta a `Segment.bookingClass`.
5. **¿`CabinPref.PreferLevel: "Preferred"` filtra o sólo ordena?** El default no fuerza. Si una búsqueda de business devuelve economy, el filtro de cabina es cosmético (§6.2).
6. **¿Cuál es la latencia y el tamaño de payload con `Baggage` + `VoluntaryChanges` activos?** Son obligatorios para nuestro diferencial (§7.4) y engordan la respuesta. Decide si hace falta `CompressResponse` o `AirStreaming` (§8.3).
7. **¿`POS.MultiSourceControl` (multi-PCC en una llamada) está disponible para nosotros?** Es el mecanismo nativo de Sabre para el modelo consolidador (§3.2). Si funciona, cambia el diseño de `provider_accounts`.
8. **¿Sabre nos tarifa por llamada, por `RequestType`, o por reserva?** Si `200ITINS` cuesta 4× `50ITINS`, el dial de volumen es una decisión económica.
9. **¿Cuál es nuestro límite de concurrencia y de tokens activos?** El `429` lo menciona pero el número lo fija el account manager (§2.2). Dimensiona el fan-out.
10. **¿`/v1/offers/flightShop` está GA y cubre NDC/LCC?** Sigue con 1 sola muestra y sin spec público. Baja de prioridad ahora que BFM v5 tiene contrato y ejemplos.

---

## Riesgos

| # | Riesgo | Impacto | Mitigación |
| - | --- | --- | --- |
| 1 | **Sabre puede ocultar una alternativa cross-source por defecto.** `MultipleSourcePerItinerary` ausente ⇒ "the cheaper will stay". Branded fares y upsells son una palanca separada. | **Alto** | `MultipleSourcePerItinerary=true` + indicadores de marca/upsell, con tests separados (§4.2). |
| 2 | **Fechas mal reconstruidas.** Ignorar `departureDateAdjustment` o `arrival.dateAdjustment` da vuelos con el día equivocado, sin excepción que lo delate. **Los 3 fixtures oficiales son vuelos diurnos y no ejercitan este código.** | **Alto** | §7.3 + fixture obligatorio de vuelo nocturno con cambio de día antes de dar el mapper por hecho. |
| 3 | **`baseFare` mapeado desde `baseFareAmount`.** Está en otra moneda que `total`. Rompe `baseFare + taxes = total` y hace tirar `Money.add`. Es el error más fácil del documento. | **Alto** | `equivalentAmount`/`equivalentCurrency` (§7.2). Test de invariante `base + taxes == total` sobre los 3 fixtures oficiales. |
| 4 | **Degradación parcial silenciosa.** `failed` se descarta y `simulated` es global. Además BFM puede responder 200 degradado (`messages[].severity`, `statistics.legMissed/soldOut`). | **Alto** | Cambiar el contrato de `/search/flights` **en el mismo PR** que suma Sabre (§8.2). Propagar `messages` no-Info. |
| 5 | **Dedupe agresivo que oculta el mejor producto**, agravado porque la clave de producto **depende** de que se pidan equipaje y penalidades. Si el builder los olvida, la clave colapsa a la física. | **Alto** | §9.3 + §7.4 como un solo requisito. Regla "si hay más de una moneda, no deduplicar". |
| 6 | **`ProviderRef.offerRef` es `string` y necesitamos `(offerId, offerItemId, source)` más el detalle del vuelo para ATPCO.** Serializar JSON ahí es el anti-patrón de "tipos de proveedor filtrándose al dominio" que prohíbe `CLAUDE.md`. | **Medio** | Decidir antes de codificar: o `offerRef` pasa a `z.union([z.string(), z.record(z.unknown())])`, o se añade un campo canónico. **Discutir.** |
| 7 | **Ids NDC perecederos.** `shop.offer.offerId` ≠ `price.offers[0].id` (VERIFICADO). Reservar con el de shop falla con "offer not found". | **Medio** ↓ (era Alto) | Modelar el ciclo shop→price→book. **`Offer.expiresAt` ya no es un default inventado: sale de `offer.timeToLive`** (§3.3). |
| 8 | **`RequestType` no contratado devuelve cero resultados sin error.** Indistinguible de "no hay vuelos". | **Medio** | Configurable por `provider_account` + validación al alta de credencial (§8.1). |
| 9 | **El PCC entra en el `client_id` del OAuth.** Un tenant con dos PCC necesita dos tokens y dos cachés. Y el `429 "Active token count is exceeded"` castiga no cachear. | **Medio** | `SabreProviderFactory` con clave `byoc:{owner}:{pcc}:{updatedAt}` desde el día 1 (§6.3). |
| 10 | **`404 "Response does not contain any data"` tratado como fallo.** Abriría el circuit breaker en cada ruta sin vuelos. | **Medio** | Mapear `404` a lista vacía, no a `failed` (§2.2, §8.2). |
| 11 | **Caché de 90 s × breaker de 30 s.** Un fallo transitorio de Sabre se congela 3 ventanas del breaker. | **Medio** | Guardar `succeeded[]` en la entrada de caché; TTL reducido para parciales. |
| 12 | **La moneda pedida puede no ser la devuelta.** `CurrencyCode` reduce el riesgo pero no lo elimina, y el tenant vende en su moneda. | **Medio** ↓ (era Alto) | Mandar `CurrencyCode` siempre (§6.2) **y** validar `totalFare.currency` en el mapper con warning, como el mapper de LATAM. Nunca convertir nosotros el precio de venta. |
| 13 | **`operatingFlightNumber` existe en Sabre y no en nuestro `SegmentSchema`.** Los codeshares no colisionan en el dedupe. | **Bajo** | Añadir el campo (§9.4.1). Es una línea. |
| 14 | **`Version` desalineado con la URL.** El spec dice que debe coincidir; la colección no lo respeta en 13/13 requests a `/v5`. Si Sabre endurece la validación, quien copió la colección se rompe. | **Bajo** ↓ | Mandar `"5"` con `/v5` (§3.5). |
| 15 | **Los nombres de request de la colección mienten sobre la versión** (38/49 mal). Cualquier análisis futuro que se apoye en ellos hereda el error. | **Bajo** | Documentado en §2. Usar sólo la URL. |
| 16 | **LCC exige `VendorPref`** en los 8 ejemplos, así que el carril LCC no encaja en una búsqueda abierta "LIM→BOG". | **Bajo** | `LCC: "Disable"` en Ola 1 (§4.2). Reversible en una línea. |

**Riesgo retirado.** El #1 de la primera pasada (*"escribir el mapper sobre inferencias; el 70% de los campos de respuesta son desconocidos"*) **queda cerrado**: los campos ya no son desconocidos y hay 3 fixtures oficiales. La regla dura de "no escribir `response.mapper.ts` hasta tener payloads del sandbox" se sustituye por: **escribirlo contra los 3 ejemplos oficiales, y no darlo por terminado sin el fixture de vuelo nocturno** (riesgo #2).

**Riesgo retirado.** El #7 de la primera pasada (*"3 llamadas por búsqueda si `DataSources` no admite multi-Enable"*) **no existe**: es 1 llamada (§4.2).

---

## Anexo — comandos para reproducir este análisis

```bash
S=C:/Users/USER/AppData/Local/Temp/claude/C--Users-USER-Desktop-Projects-sales-travel/ec9e4bb1-c724-4cf9-9312-5823cf61fd08/scratchpad/sabre

# --- Contratos oficiales (fuente de §3, §4, §5, §6, §7) ---
sed -n '120,592p'   $S/specs/bargain-finder-max-v5.yml   # ejemplo de respuesta 1 (ATPCO, RT, 1 ADT)
sed -n '667,1356p'  $S/specs/bargain-finder-max-v5.yml   # ejemplo 2 (niño + equipaje)
sed -n '1456,2308p' $S/specs/bargain-finder-max-v5.yml   # ejemplo 3 (familia + infante + penalidades)
sed -n '5473,5545p' $S/specs/bargain-finder-max-v5.yml   # MultipleSourcePerItinerary  <- §4.2
sed -n '6237,6262p' $S/specs/bargain-finder-max-v5.yml   # DataSources
sed -n '7849,7853p' $S/specs/bargain-finder-max-v5.yml   # PriceRequestInformation.CurrencyCode  <- §6.2
sed -n '8226,8245p' $S/specs/bargain-finder-max-v5.yml   # Offer { offerId, source, timeToLive }  <- §3.3
sed -n '9097,9112p' $S/specs/bargain-finder-max-v5.yml   # ScheduleType.departureDateAdjustment   <- §7.3
sed -n '2524,2528p' $S/specs/bargain-finder-max-v5.yml   # Arrival.dateAdjustment                 <- §7.3
cat $S/specs/help/bargain-finder-max-v4/help-documentation-v3-v4.txt   # "request has no schema changes"
cat $S/specs/help/errors.txt                                           # 429/404/500 -> §2.2

# diff de schemas de request entre versiones (§3.2)
grep -o "^    OTA_AirLowFareSearchRQ[A-Za-z._]*:" $S/specs/bargain-finder-max-v5.yml | sort -u > /tmp/v5.txt
grep -o "^    OTA_AirLowFareSearchRQ[A-Za-z._]*:" $S/specs/bargain-finder-max-v4.yml | sort -u > /tmp/v4.txt
comm -23 /tmp/v5.txt /tmp/v4.txt      # => MultiSourceControl, OfferControlRules, PromotionCode, PersonName

# --- Colección (fuente de §2, §5.4, §5.5) ---
node $S/extract.cjs list "Shop (BFM)"
node $S/extract.cjs dump "Workflows / 1 - Air NDC"

# refutación de 'QR' en VendorPref (§5.4)
grep -c '"QR"' $S/requests.jsonl        # => 0

# versión real por URL vs nombre del request (§2)
node -e 'const fs=require("fs");
 const R=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);
 const s=R.filter(r=>/offers\/shop/.test(r.url||""));
 let n=0,t=0; for(const r of s){const nm=r.path.match(/\/(v[345])\b/gi),u=(r.url||"").match(/\/(v[345])\//);
 if(!nm||!u)continue; t++; if(nm.pop().slice(1).toLowerCase()!==u[1])n++;}
 console.log(t,"con versión en el nombre;",n,"mal etiquetados");' $S/requests.jsonl
 # => 49 con versión en el nombre; 38 mal etiquetados

# las 4 respuestas guardadas SÍ tienen cuerpo (16.479 bytes c/u) — §7.3
ls -la $S/slices/responses/
grep -o '"[a-zA-Z]*ateTime": *"[^"]*"' $S/slices/responses/01-Add_phone_Orders_View.json | sort -u
```
