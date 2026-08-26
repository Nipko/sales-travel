---
titulo: "Sabre — Revalidación de precio, asientos y ancillaries"
fecha: 2026-08-25
estado: reconciliado contra contratos oficiales; laguna de ancillaries cerrada
fuentes: "ver 00-fuentes.md"
---

# Sabre — Revalidación de precio, asientos y ancillaries

## 0. Advertencia de método (leer antes que nada)

### 0.1 Qué cambió respecto de la primera pasada

Esta versión se reconcilió contra los **contratos oficiales OpenAPI** de Sabre y contra
**81 páginas de documentación oficial** (ver `00-fuentes.md` §2). El grueso de lo que la
primera pasada marcó `[INFERIDO]` o `DESCONOCIDO` ahora está **VERIFICADO-SPEC**.

Los specs relevantes para este documento son seis:

| Spec | Qué fija |
| --- | --- |
| `offer-price-ndc-v1.yml` (OpenAPI 3.0.3, `info.version: 1.5`) | request **y respuesta completa** de `/v1/offers/price`, incluidos 5 ejemplos de respuesta reales |
| `get-seats-agency-3.0.yml` (OpenAPI 3.0.0, `info.version: "3.1"`) / `get-seats-airline-3.0.yml` (`info.version: "3.0"`) | mapas de asiento — **contrato v3, que NO es el v1 que usa la colección** (§4.1) |
| **`get-ancillaries-agency-2.3.yml`** (OpenAPI 3.0.0, `info.version: "2.3"`) — **NUEVO en esta pasada** | el contrato real de `/v2/offers/getAncillaries`. **Cierra la laguna** que las dos pasadas anteriores declararon irresoluble (§5.2) |
| **`manage-ancillary-1.1.yml`** (OpenAPI 3.0.0, `info.version: "1.1"`) — **NUEVO en esta pasada** | `/v1/ancillaries/{add,remove,exchange}` — el carril **REST** de asientos y ancillaries sobre PNR (§5.9) |
| `booking-management-v1.yml` (Swagger 2.0) | cómo se consumen asiento y ancillary en `createBooking` / `modifyBooking` |
| `bargain-finder-max-v5.yml` (OpenAPI 3.0) | el origen de la cadena de IDs (`offer.offerId`, `fare.offerItemId`, `timeToLive`, `source`) |

Más las **listas oficiales de errores** por endpoint, que sustituyen a las conjeturas de la
primera pasada sobre cómo falla cada llamada.

#### Cómo aparecieron los dos specs que "no existían"

`00-fuentes.md` §2 y las dos pasadas anteriores dan por hecho que el slug de `getAncillaries`
*"vive detrás del login del catálogo"*. **Era falso, y la prueba está en la propia
documentación oficial que ya teníamos descargada.** La página
`help/get-ancillaries-airline-3.0/3.0-index.html` contiene dos enlaces internos con los slugs
literales:

```html
línea 29:  ...aimed at use by Agencies <a href="../../get-ancillaries-agency/2.3/index.html">Get Ancillaries - Agency API</a>
línea 191: To book an ancillary, use the <a href="../../manage-ancillary/1.1/index.html">Manage Ancillary API</a>
```

Con esos slugs, las descargas por el patrón habitual
(`developer.sabre.com/api/v1/products/rest-api/<slug>/_attachments/spec.yml`) devuelven
**HTTP 200 sin autenticación**: 33.634 bytes y 56.785 bytes respectivamente. La búsqueda de la
pasada anterior falló porque buscó `getAncillaries` como slug; el producto se llama
`get-ancillaries-agency` y su versión de catálogo es **2.3**, aunque el `basePath` sea `/v2/offers`.

> ⚠️ **`00-fuentes.md` §2 quedó desactualizado por este hallazgo.** Su lista de "especs que
> faltan" ya no debe incluir `getAncillaries`. Sigue faltando **Get Hotel Avail v5**. Corregirlo
> ahí es responsabilidad del documento canónico, no de éste.

### 0.2 Tres errores de procedencia de la primera pasada, corregidos aquí

1. **"La colección no guarda respuestas de ejemplo salvo 4 … es decir, no tenemos nada."**
   Falso en su conclusión. Las 4 respuestas guardadas **existen y pesan 16.479 bytes cada
   una** (`slices/responses/*.json`, todas `/v1/orders/view`). No traen la respuesta de
   `offers/price`, pero **sí traen la prueba dura de que los IDs de price sobreviven a la
   orden**: `order.orderItems[0].offerItemId = "cg05grt8njtq6dou00-1-1"`, que encaja exacto
   con el patrón `^[a-zA-Z0-9]+(-[0-9]+){2}$` del `OfferItemId` de
   `offer-price-ndc-v1.yml:908-912`. Ver §3.5.
2. **Front-matter citando `EXTERNAL_AGENCY.postman_collection.json`.** Ese archivo es la
   colección de **LATAM NDC** (160 requests), no de Sabre. Corregido: fuentes en
   `00-fuentes.md`.
3. **El carril SOAP/LLS stateful quedó fuera del análisis.** Toca este documento en un
   punto concreto y verificado: el modo `payload` de `getseats` en la colección va
   **precedido de `SessionCreateRQ` + `OTA_AirAvailRQ`** solo para averiguar el número de
   vuelo (`slices/09-soap-lls-stateful.txt:544-614`), y la doc oficial dice que en ese
   carril el asiento **no se reserva por REST sino con `PassengerDetailsRQ` o el comando 4G**
   (VERIFICADO-SPEC: `help/get-seats-agency-3.0/3.0-index.txt`). Ver §4.6.

### 0.3 Los dos hallazgos de la crítica

| # | Hallazgo | Resolución |
| --- | --- | --- |
| 1 (baja) | *"WhatsApp aparece solo como ilustración de un riesgo; no hay análisis de qué necesita el canal conversacional de Sabre."* | **ACEPTADO.** Se añade **§4.8**, con lo que estos tres endpoints imponen y ofrecen al canal conversacional. No es relleno: el hallazgo central de esa sección (la preferencia de área **no existe en NDC**) corrige además un error de esta misma pasada, ver §4.5. La parte del hallazgo que pide un RF en el documento 10 corresponde a ese documento. |
| 2 (baja) | *"§3.2 dice 45 de 59 y §2.1 desglosa 46."* | **ACEPTADO y ya corregido**: son **46**. Ver la nota de §2.1 y la tabla de §3.2. |

### 0.4 Qué sigue siendo inferencia

La laguna de ancillaries **está cerrada** (§5.2). Lo que queda:

- **La respuesta real del CERT**: los ejemplos del spec son buenos pero son ejemplos. Los
  fixtures siguen siendo obligatorios antes de escribir mappers (§8).
- **Qué versión de cada producto tiene habilitada nuestro PCC**: `getseats` v1 vs v3 (§4.1) es
  el caso bloqueante.
- **La relación aritmética entre `obFees[]` y `totalPrice.totalAmount`** (§2.4). El contrato
  los declara hermanos y no dice si se suman.

---

## 1. Resumen ejecutivo

1. **`POST /v1/offers/price` es el paso de revalidación NDC de Sabre y su contrato completo
   está verificado** (§2). Request mínimo: un array `query[].offerItemId[]`. Respuesta:
   `response.offers[]` con `id`, `ttl`, `source`, `offerExpirationDateTime`, `offerItems[]`
   y `totalPrice`.
2. **El precio SÍ depende del BIN de la tarjeta, y ahora sabemos exactamente cómo.**
   `params.formOfPayment[]` **NO es obligatorio** (VERIFICADO-SPEC), pero la doc oficial
   dice que si no se envía, el servicio genera un **warning de posible subida de precio**.
   El fee aparece desglosado en `offers[].obFees[]`. Ver §2.4 y §2.5.
3. **El impacto PCI es peor de lo que creíamos, y no está en `offers/price`.** El BIN son 6-8
   dígitos y no es PAN. Pero el carril **ATPCO** de Sabre no usa `offers/price`: tarifica
   dentro de `createBooking`, y ese endpoint acepta **`cardNumber` completo (12-19 dígitos)
   y `cardSecurityCode`** (VERIFICADO-SPEC: `booking-management-v1.yml:5313-5317` y
   `:5318-5322`). Vender ATPCO por Sabre con tarjeta **rompe SAQ-A** salvo que usemos
   tokenización de Sabre o cobremos por PSP y liquidemos con otra forma de pago. Ver §2.4 y §2.6.
4. **El TTL de la oferta ya no es desconocido: son 1.200 segundos (20 min) en todos los
   ejemplos oficiales**, declarados en `offers[].ttl` (entero, segundos) y
   `offers[].offerExpirationDateTime` (ISO 8601), **ambos campos obligatorios**
   (VERIFICADO-SPEC: `offer-price-ndc-v1.yml:387-408`). Hay además tres relojes distintos
   más: `paymentTimeLimit*`, `purchaseTimeLimitDateTime` y `priceGuaranteeTimeLimit*`. Ver §3.3.
5. **`/v1/offers/getseats` (colección) y `/v3/offers/getseats/by*` (spec) son dos APIs
   distintas, no dos versiones de la misma.** v1 usa un discriminador `requestType` y
   devuelve `aLaCarteOffer`; v3 usa **rutas separadas** (tres en el spec de agencia, dos en el
   de aerolínea) y devuelve `offerItems[] + serviceDefinitions[] + priceDefinitions[] +
   seatMaps[]`. Hay que elegir una. Ver §4.1.
6. **El catálogo de códigos de asiento está resuelto**: son PADIS 9825/9865 y la doc oficial
   trae los valores con descripción. `1` = `RestrictedGeneral`, `1D` = `RestrictedRecline`,
   y los códigos que de verdad importan para menores son `1A`, `1C` e `IE`, **no** `ExitRowSeat`.
   La regla que codifica la colección es una heurística incompleta. Ver §4.4.
7. **La laguna de ancillaries está cerrada.** `/v2/offers/getAncillaries` tiene contrato
   oficial (`get-ancillaries-agency-2.3.yml`) y el slug se descubrió dentro de la propia
   documentación que ya teníamos (§0.1). Tres consecuencias inmediatas:
   **(a)** `requestType: "offerId"` **existe** — se pueden cotizar ancillaries NDC
   **antes** de crear la orden, lo que desbloquea el carrito del Package Studio;
   **(b)** el endpoint es, por descripción de Sabre, de **equipaje**, y sus dos campos
   principales (`baggageGrid`, `otherBaggageCharges`) **todavía no están definidos** en v2.3;
   **(c)** el contenedor de errores aquí es `errors[]`/`warnings[]` con un schema IATA, otro
   más. Ver §5.2.
8. **Existe un carril REST para asientos y ancillaries sobre PNR que no teníamos mapeado**:
   `Manage Ancillary 1.1` (`POST /v1/ancillaries/{add,remove,exchange}`). Acepta un
   `offerItemId` opaco, **no** el payload materializado de `createBooking`. Reduce el riesgo
   de `PRICE_MISMATCH` y debilita la afirmación de que ATPCO exige sesión SOAP. Ver §5.9.
9. **Sabre expone CUATRO vocabularios distintos para el mismo RFIC de EMD** (eran tres en la
   pasada anterior; el spec de ancillaries aporta el cuarto), y **tres nombres distintos para
   el campo de moneda**. Ver §5.5. Es el argumento más fuerte que tenemos para el ACL.
10. **En NDC no se puede vender asiento sin pintar el mapa.** La preferencia de área
    (`WINDOW`, `AISLE`…) existe **solo en el carril ATPCO** (`BookSeat.areaPreferences`), no en
    el NDC (`BookSeatOffer`). Corrige un error de la pasada anterior y choca de frente con
    *"WhatsApp es ciudadano de primera"*. Ver §4.5 y la sección nueva §4.8.
11. **`search.service.ts::priceOffer` sigue clavado a LATAM, sin circuit breaker, sin cuota y
    sin bandera `simulated`** (verificado hoy contra el repo, `:109-122`). Ver §7.

---

## 2. `POST /v1/offers/price` — revalidación de precio

### 2.1 Dónde aparece en la colección

59 requests apuntan a `{{rest_endpoint}}/v1/offers/price`. Agrupados por el contenido real
de `query[].offerItemId` (no por texto del body), hay **tres variantes**:

| Requests | Variable en `offerItemId[]` | Dónde |
| --- | --- | --- |
| **46** | `{{shop_offer_item_id}}` | flujos NDC estándar (WF-1, 11-15, 18, 23-25…) |
| 7 | `{{shop_offer_passenger_item_id}}` | `ModifyBooking / … / Form of Payment modifications (Hybrid)` |
| 6 | `{{shopPassengerOfferItemId}}` | `Workflows / 28-33 NDC - Assign seats at order creation` |

> **Corrección (hallazgo 2 de la crítica, ACEPTADO).** La primera pasada decía "45 de 59"
> en §3.2 y a la vez desglosaba 45+1 en §2.1. El número correcto es **46**. Verificado
> agrupando los 59 bodies por `JSON.stringify(body.query)`:
> `46 :: [{"offerItemId":["{{shop_offer_item_id}}"]}]`. El 13 de 59 del nivel *passenger*
> (7 + 6) sí era correcto.

Los **59** llevan exactamente el mismo `params`:
`{"formOfPayment":[{"binNumber":"545251","subCode":"FDA","cardType":"MC"}]}`. Cero variación.

### 2.2 Contrato de request — VERIFICADO-SPEC campo por campo

`offer-price-ndc-v1.yml:74-101` (`OfferPriceRequestV1`). **El único campo obligatorio del
request es `query`** (`:78-79`).

| Campo | Tipo | Obligatorio | Restricción del spec | Línea |
| --- | --- | --- | --- | --- |
| `payloadAttributes` | objeto | no | `timeStamp`, `trxID` (≤100 chars). `host` y `baseline` son `readOnly` (solo respuesta) | `:144-172` |
| `query` | array | **sí** | `minItems: 1` | `:84-90` |
| `query[].offerItemId` | array de string | **sí** | `minItems: 1`, patrón `^([a-zA-Z0-9]){1,30}(-[0-9]{1,10}){2}$` | `:182-190` |
| `query[].passengerId` | array de string | no | patrón `^([\w-]){1,200}$`, default `Passenger1` | `:191-200` |
| `query[].formOfPayment` | **string** | no | **es una REFERENCIA al `id` de un FOP**, no un objeto. Default `FOP1` | `:201-206` |
| `passengers` | array | no | `maxItems: 9` | `:91-96` |
| `passengers[].id` | string | **sí** (si hay `passengers`) | patrón `^(\S+)$` | `:214-218` |
| `passengers[].type` | string | no | PTC, patrón `^[A-Z]{1}[0-9A-Z]{2}$` | `:219-223` |
| `passengers[].personName` | objeto | no | `surname` obligatorio | `:224-226`, `:302-318` |
| `passengers[].frequentFlyer[]` | array | no | — | `:227-232` |
| `passengers[].unusedTicketNumber` | string | no | 13 o 14 dígitos — **reemisión con valor residual** | `:233-240` |
| `params` | objeto | no | **`additionalProperties: false`** (`:269`) — no se puede colar nada | `:97-99`, `:242-269` |
| `params.formOfPayment` | array | no | **`maxItems: 1`** (`:250`) | `:247-252` |
| `params.formOfPayment[].subCode` | string | **sí dentro del objeto** (`required` en `:274-275`) | `^([A-Z0-9]{3}\|CA\|CK)$` — `CA` efectivo, `CK` cheque | `:283-290` |
| `params.formOfPayment[].cardType` | string | no | 2 letras mayúsculas | `:291-295` |
| `params.formOfPayment[].binNumber` | string | no | **6 a 8 dígitos** (`^([0-9]{6,8})$` en `:300`) | `:296-300` |
| `params.formOfPayment[].id` | string | no | ≤64 chars, default `FOP1`. Es lo que referencia `query[].formOfPayment` | `:277-282` |
| `params.accountCode` | string | no | tarifa corporativa | `:253-257` |
| `params.customQualifiers` | objeto libre | no | **qualifiers específicos de aerolínea NDC** | `:258-264` |
| `params.allowBundles` | boolean | no | default `false` | `:265-268` |
| `diags` | array de enum | no | 14 valores, uso interno de debug | `:100-104`, `:319-340` |

> **Nota de precisión.** Estas líneas se re-verificaron una a una en esta pasada. La versión
> anterior del documento tenía **siete citas desplazadas entre 1 y 5 líneas** (`offerItemId`,
> `passengerId`, `query[].formOfPayment`, `params.formOfPayment[].subCode`, `cardType`,
> `binNumber` y `diags`), porque apuntaban al inicio del bloque `description:` en vez de al
> nombre de la propiedad. Los valores y los patrones eran correctos; solo las líneas estaban mal.

**Correcciones concretas a la primera pasada:**

- ❌ *"`params.formOfPayment` array ⇒ split payment / dos tarjetas `[INFERIDO]`"* →
  **REFUTADO por el spec.** `maxItems: 1` (`:250`). No hay split payment aquí. Lo que sí
  hay es un mecanismo de **referencia**: `params.formOfPayment[].id` ↔
  `query[].formOfPayment`, pensado para asociar el FOP a un subconjunto de offer items.
- ❌ *"binNumber: string, 6 dígitos"* → **son 6 a 8** (`:296`). Con la migración a BIN de 8
  dígitos de las marcas, esto importa: si capturamos solo 6 podemos perder precisión de fee.
- ❌ *"No aparece ningún otro campo dentro de `params` … no hay `currency`, ni `pointOfSale`,
  ni `travelers`"* → correcto para la colección, pero **el contrato sí tiene más**:
  `accountCode`, `customQualifiers`, `allowBundles`, y a nivel raíz `passengers[]` con
  frequent flyer y billete sin usar. La colección usa el 20% del contrato.
- ✅ *"el contexto de PCC/agencia viaja en el token"* → **confirmado**: no hay ningún campo
  de POS/PCC en todo el request, y el spec declara `security: oauth2_authentication`
  (`:67-68`).

### 2.3 Ejemplo oficial mínimo (VERIFICADO-SPEC: `offer-price-ndc-v1.yml:2059-2078`)

```json
{
  "query": [
    { "offerItemId": [ "dd07bbd7fb57c88nclq1qixyj3-1-1" ] }
  ]
}
```

**Sin `params`. Sin `formOfPayment`.** El propio Sabre publica como "most common use-case"
un request que no lleva forma de pago. Esto responde la pregunta #1 de la primera pasada.

### 2.4 El precio y el BIN — CONFIRMADO, con el matiz que faltaba

**Confirmado: el precio depende del BIN.** Pero no como "el total cambia y no sabés por qué":
el fee viene **desglosado y trazable**.

`offers[].obFees[]` (VERIFICADO-SPEC: `offer-price-ndc-v1.yml:455-460`, schema `ObFee` en
`:1363-1424`) contiene, por cada fee de forma de pago:

| Campo | Qué es | Nota |
| --- | --- | --- |
| `binNumber` | patrón `^[0-9\|\*]{6,8}$` — **admite comodín**, ej. `5452**` | Sabre te dice para qué rango de BIN aplica el fee |
| `cardCode` | 2 chars: `VI`, `MC`, `AX` | |
| `cardType` | 3 chars: `FCA` cualquier crédito, `FDA` cualquier débito, `FC1` crédito que empieza en 1… | **marcado `deprecated: true`** en el spec (`:1373`) |
| `serviceCode` | código del fee, ej. `OB` | |
| `subCode` | motivo del cargo, ej. `T05` | |
| `airline` | quién cobra el fee | |
| `paxRefs[]` / `offerItemRefs[]` | a qué pax y a qué items aplica | permite atribuir el fee |
| `isRefundable` | boolean | |
| `description` | texto de la aerolínea, ej. `"Credit Card Fee"` | mostrable al cliente |
| `surcharge` | `ObFeeAmount` (`:1880-1920`) | ver abajo |

Y `ObFeeAmount` trae `amount`, `baseAmount`, `maximumAmount` (*"si no se puede computar el
importe exacto"*), `percentageValue`, `cardCharge`, `taxes` y — clave —
**`noCharge: boolean`** *("If `true`, there is no charge associated with the selected form
of payment")*.

**Correcciones a la primera pasada:**

- ✅ *"`subCode: FDA` es casi con seguridad un subcódigo de OB fee de forma de pago"* →
  **CONFIRMADO-SPEC**, y con más precisión: `FDA` = *any debit card*
  (`offer-price-ndc-v1.yml:1370-1372`). Es decir, el BIN `545251` de la colección se está
  declarando como **tarjeta de débito Mastercard**, no crédito. Si copiamos ese `subCode`
  como default estamos cotizando fees de débito para tarjetas de crédito.
- ❌ *"Que Sabre pida esto en el paso de precio y no en el de pago confirma que el fee entra
  en el total revalidado"* → **matizado**. El spec **no dice** que `obFees` esté sumado
  dentro de `totalPrice.totalAmount`. `ObFee` es un array hermano de `totalPrice` dentro de
  `Offer`. Que el fee esté incluido o sea aditivo **es exactamente lo que hay que medir en
  el CERT** (§8, ítem 5). Es un `DESCONOCIDO` que la primera pasada dio por resuelto.
- ✅ *"Nunca loguear el BIN"* → se mantiene, y se refuerza: el BIN aparece **también en la
  respuesta** (`obFees[].binNumber`), así que el filtro de logging tiene que cubrir el
  request **y** el mapper de respuesta.

#### Qué pasa si NO mandamos forma de pago (VERIFICADO-SPEC, doc oficial)

`help/offer-price-ndc-v1/v1-index.txt`, sección *Processing flow*, paso 7:

> El servicio *"crea mensajes de advertencia basados en la respuesta de la aerolínea o en la
> configuración (p. ej., mensajes que informan de una posible subida de precio si no se
> proporcionó la forma de pago)"*.

Es decir: **el flujo sin FOP funciona, y Sabre te avisa por `messages[]` de que el precio
puede subir.** Eso convierte el problema de "blocker de diseño" en "warning gestionable":

1. Revalidamos **sin** FOP para mostrar precio al vendedor. Si viene el warning, la UI lo
   refleja como *"precio sujeto a la forma de pago"*.
2. Tras tokenizar en el PSP, revalidamos **con** el BIN real, **antes** de capturar.
3. Si `totalPrice` cambió, frenamos y reconfirmamos.

Esto encaja con nuestro principio de *tiempo a venta < 2 min* mucho mejor que pedir 6
dígitos de tarjeta antes de cotizar.

#### Impacto PCI — la parte que la primera pasada no vio

El BIN (6-8 dígitos) **no es PAN** y no rompe SAQ-A por sí solo. Stripe y Mercado Pago
exponen el BIN del método tokenizado, así que el paso 2 de arriba es viable
`[INFERIDO — verificar en la doc de cada PSP el campo exacto y el momento]`.

**El problema real está en el carril ATPCO**, y ahí sí hay una cita dura:
`booking-management-v1.yml:5304` (`BasicFormOfPayment`) declara, en `:5313-5317` y `:5318-5322`:

```yaml
cardNumber:        pattern: '^[0-9]{12,19}|([0-9]X{7,14}[0-9]{4})$'   # ej. '4537156488578956'
cardSecurityCode:  pattern: '^[0-9]{3,4}$'                            # ej. '123'
expiryDate:        pattern: '^(20)\d\d-(0[1-9]|1[012])$'              # ej. '2024-07'
```

El `pattern` de `cardNumber` admite dos formas: PAN completo de 12-19 dígitos **o** una forma
enmascarada `[0-9]X{7,14}[0-9]{4}`. Que exista la variante enmascarada demuestra que Sabre
contempla no recibir el PAN — pero **no dice cuándo se acepta**, y el ejemplo del propio spec
es un PAN completo. Es la pista más concreta que tenemos para la pregunta abierta #8.

y la doc oficial de createBooking dice que la tarificación ATPCO se hace **dentro** del
createBooking vía `flightDetails.flightPricing[].qualifiers.payment` apuntando a
`payment.formsOfPayment[]` (`help/booking-management-api-v1/help-documentation-create-booking.txt:127`
y el ejemplo *"Create an ATPCO booking (PNR)"* en
`help-documentation-create-booking-examples.txt:591`).

⇒ **Vender ATPCO por Sabre con tarjeta como forma de pago del billete implica que el PAN y
el CVV pasan por nuestro servidor.** Eso choca frontalmente con `CLAUDE.md` §Seguridad
("hosted checkout únicamente en fase 1, nunca PAN/CVV en servidor"). Es una **decisión de
alcance**, no un detalle: o vendemos solo NDC en fase 1, o cobramos por PSP y emitimos
contra la forma de pago de la agencia (efectivo/BSP), o asumimos SAQ-D. Ver §9 y §10.

### 2.5 Contrato de respuesta — VERIFICADO-SPEC campo por campo

`OfferPriceResponseV1` (`offer-price-ndc-v1.yml:106-143`). Estructura de raíz:

```
{
  payloadAttributes: { timeStamp, trxID, host, baseline, additionalProperties }
  id:       string   // ID único de la respuesta de pricing. Patrón ^[a-zA-Z0-9]*$
  version:  string   // OBLIGATORIO. Patrón ^v[0-9\.]*$   ej. "v1.0.0"
  messages: Message[]
  response: { offers: Offer[] }     // 'offers' es obligatorio dentro de response
  diagnostics: Diagnostic[]
}
```

Con una condición estructural notable (`:109-113`): `anyOf: [required: response, required: messages]`.
**Toda respuesta trae `response` o trae `messages`.** Nuestro parser puede confiar en eso.

#### ⚠️ Corrección importante: `errors` NO existe en `offers/price`

La primera pasada afirmó: *"los tests de WF-28 hacen
`pm.response.to.not.have.property("errors")` ⇒ los errores viajan en HTTP 200 con propiedad
`errors`"*. **Es falso, por dos motivos:**

1. `pm.response.to.not.have.property("errors")` en Postman se evalúa contra el **objeto
   Response de Postman**, no contra el JSON del body. El objeto Response nunca tiene una
   propiedad `errors`. **El test es un no-op**; no prueba nada sobre la forma de la respuesta.
2. El contrato oficial **no declara ningún campo `errors`** en `OfferPriceResponseV1`. El
   contenedor es **`messages[]`** (`:114-118`), con el schema `Message` (`:869-907`):

| Campo | Obligatorio | Valores | Nota |
| --- | --- | --- | --- |
| `type` | **sí** | `ERROR`, `WARNING`, `INFO` | patrón `^[A-Z]{0,7}$` |
| `message` | **sí** | texto | |
| `service` | **sí** | paso de proceso, ej. `OFFER_STORE_PUT` | |
| `code` | no | entero, default `0` | |
| `system` | no | sistema origen, ej. `OFFERSTORE` | |
| `additionalDescription` | no | ej. `"Invalid form of payment reference."` | |

⇒ **Nuestro ACL debe leer `messages[]`, filtrar por `type === 'ERROR'` y fallar fuerte; los
`WARNING` (incluido el de forma de pago ausente) se propagan a `OfferPriceResult.warnings`.**
Un adapter que busque `errors` no va a ver nunca un error de Sabre.

> Ojo, el nombre **sí** cambia por producto: `get-seats-agency-3.0.yml:191-202` **sí**
> declara `errors[]` y `warnings[]` en la raíz, con un schema distinto
> (`category`/`type`/`description`/`fieldName`/`fieldPath`/`fieldValue`). Dos productos de
> Sabre, dos contenedores de error incompatibles. Ver §4.3.

#### `response.offers[]` — el objeto `Offer` (`:383-476`)

**Obligatorios: `id`, `ttl`, `source`, `offerExpirationDateTime`, `offerItems`, `totalPrice`.**

| Campo | Tipo | Qué es |
| --- | --- | --- |
| `id` | string, patrón `^[a-zA-Z0-9]+(-[0-9]+)$` | el `price_offer_id` de la colección → `flightOffer.offerId` |
| `ttl` | **integer, segundos** | ej. `1200` |
| `source` | string, patrón `^(ATPCO)\|(LCC)\|(NDC)$` | **la "fuente" que la primera pasada propuso inventar ya existe y se llama `source`** |
| `offerExpirationDateTime` | ISO 8601 | cuándo caduca la oferta |
| `paymentTimeLimitDateTime` / `paymentTimeLimitText` | ISO 8601 / texto libre | límite para pagar. El campo `Text` existe *"por si el proveedor externo devuelve datos que no cumplen el formato"* |
| `purchaseTimeLimitDateTime` | ISO 8601 | límite para comprar |
| `priceGuaranteeTimeLimitDateTime` / `…Text` | ISO 8601 / texto | *"fecha y hora antes de la cual la oferta debe convertirse en orden"* |
| `commission` | objeto | **comisión de la agencia** — relevante para el pricing waterfall |
| `journeys[]` | array | asociación segmento↔leg |
| `offerItems[]` | array | ver abajo |
| `totalPrice` | `OfferTotalPrice` | ver abajo |
| `obFees[]` | array | fees por forma de pago (§2.4) |
| `promotions[]` | array | promos de la aerolínea |
| `voluntaryChangeInformation[]` | array | fees y límites de cambio voluntario |
| `penaltyRefs[]` | array de string | referencias a penalidades a nivel oferta |
| `penalties[]` | array | **`deprecated: true`** (`:436`) — no usar |
| `penalty` | `Price` | penalidad cuando se tarifica con billete sin usar |

#### `offers[].totalPrice` (`OfferTotalPrice`, `:478-506`)

Responde la pregunta #3 de la primera pasada ("¿dónde viene el precio total?").

| Campo | Tipo | Nota |
| --- | --- | --- |
| `totalAmount` | `SignedCurrencyType` | **obligatorio**. `{ amount: string, curCode: string, taxable?: bool }` |
| `baseAmount` | `SignedCurrencyType` | sin impuestos, tasas ni recargos |
| `equivAmount` | `SignedCurrencyType` | el base en la moneda solicitada |
| `totalTaxes` | `SignedCurrencyType` | |
| `taxBreakdown[]` | array | desglose por `taxCode` / `nation` / `description` |
| `wasTicketValueUsed` | boolean | `true` si la aerolínea aplicó el valor de un billete sin usar |

**Dos trampas de tipo, verificadas:**

1. **`amount` es un STRING, no un número.** `"402.53"`, patrón `^-?\d+(\.\d{1,3})?$`
   (`SignedCurrencyType`, `:1185-1208`). **Hasta 3 decimales**, no 2. Nuestro `Money`
   canónico usa minor units enteros: el mapper tiene que parsear con precisión decimal
   explícita, nunca con `parseFloat` sobre 3 decimales.
2. **`amount` puede ser NEGATIVO.** El spec lo dice literalmente: *"May be negative in ticket
   exchange scenarios"*. El ejemplo oficial `UnusedTicketResponse`
   (`offer-price-ndc-v1.yml:4448-4478`) devuelve `totalPrice.totalAmount = "-220.30"` — un
   **reembolso neto**. `MoneySchema` en `packages/canonical` tiene que admitir negativos o
   la reemisión revienta en el borde del ACL.

Además: **el nombre del campo de moneda cambia entre productos.** `offers/price` usa
`curCode` (`CurrencyType:1145-1168`); la respuesta real de `/v1/orders/view` que sí tenemos
usa `code` (`slices/responses/01-Add_phone_Orders_View.json`:
`{"totalAmount":{"amount":"146.60","code":"USD"}}`). Un mapper de `Money` compartido entre
los dos endpoints devuelve `undefined` en la moneda de uno de ellos.

#### `offers[].offerItems[]` — es un `oneOf` con discriminador (`:507-523`)

Esto la primera pasada no lo vio y es estructural:

```yaml
OfferItem:
  discriminator: { propertyName: type, mapping: { Air: AirOfferItem, Service: ServiceOfferItem } }
  oneOf: [ AirOfferItem, ServiceOfferItem ]
```

- **`AirOfferItem`** (`:524-555`) — obligatorios `type`, `id`, `passengers`. Trae
  `mandatoryInd` (*"si `true`, el item no puede quitarse de la oferta"*), `commission` y
  `price`.
- **`ServiceOfferItem`** (`:556-598`) — obligatorios `type`, `id`, `passengerRefs`,
  `segmentRefs`, `serviceDefinition`, `price`. **Es un ancillary dentro de la respuesta de
  price.**

⇒ **La respuesta de `offers/price` ya puede traer ancillaries** (`type: "Service"`) sin
llamar a `getAncillaries`. Nuestro mapper **no puede asumir que todo `offerItem` es un vuelo**:
tiene que ramificar por `type` o va a intentar leer `passengers[]` en un item de servicio que
solo tiene `passengerRefs[]`.

#### `offerItems[].passengers[]` — `PassengerOffer` (`:599-663`)

Obligatorios `id`, `ptc`, `requestedPtc`. El detalle valioso: **`ptc` y `requestedPtc` pueden
diferir** (*"puede ser distinto del usado durante la tarificación"*). Si pedimos `CNN` y la
aerolínea tarifica `ADT`, hay que mostrarlo al vendedor — es un cambio de precio silencioso.

Trae además `baggage[]` (con `type: CarryOnBag | CheckedBag`, `quantity`, `constrains[]` con
`max`/`unit` en KG y LBS, y `applicableBagText`), `price` con desglose de impuestos completo,
y `fareComponent[]`.

#### Rutas confirmadas por los scripts de la colección (siguen válidas)

Todo lo que la primera pasada extrajo de los scripts `test` **coincide con el spec**. Se
conserva porque prueba el uso real:

```js
// Workflows / 28-33 NDC - Assign seats at order creation / … / Offers (price)
const offers = pm.response.json().response.offers;
pm.environment.set('priceOfferId',     offers[0].id);
pm.environment.set('priceOfferItemId', offers[0].offerItems[0].id);
```

```js
// Workflows / 18 - NDC Multiple traveler types (Adult+Child) / 2. Offers Price /v1
pm.environment.set('price_offer_item_id_adt', jsonData.response.offers[0].offerItems[0].id);
pm.environment.set('price_offer_item_id_cnn', jsonData.response.offers[0].offerItems[1].id);
pm.environment.set('price_passenger_id1',     jsonData.response.offers[0].offerItems[0].passengers[0].id);
```

⇒ Confirmado que en multi-PTC hay **un `offerItem` por PTC**, y que dentro de cada uno
`passengers[]` lista los pax de ese tipo.

### 2.6 Quién NO llama a offers/price — corregido

Sigue siendo cierto que **los workflows ATPCO y LCC de la colección no pasan por
`/v1/offers/price`** (WF-19 y WF-20 van de shop directo a `GetAncillaryOffersRQ` y
`createBooking`). Pero la conclusión de la primera pasada — *"`offers/price` es específico de
NDC"* — es **demasiado fuerte** y el spec la matiza en dos puntos:

1. `Offer.source` en la **respuesta** de `offers/price` admite `ATPCO`, `LCC` y `NDC`
   (`offer-price-ndc-v1.yml:1809-1813`). Si el endpoint fuera estrictamente NDC, el enum
   sobraría.
2. El producto se llama *"Offer Price - NDC"* y la doc lo describe como *"el segundo paso
   después del shopping en el proceso de reserva NDC"*
   (`help/offer-price-ndc-v1/v1-index.txt`). No dice "solo NDC".

Lo que **sí está verificado** es dónde tarifica ATPCO: **dentro de `createBooking`**, vía
`flightDetails.flightPricing[].qualifiers` (§2.4). Y esa es la bifurcación real de nuestro ACL:

| | NDC | ATPCO / LCC |
| --- | --- | --- |
| Revalidación | `POST /v1/offers/price` | no existe paso separado |
| Dónde se fija el precio | en la offer, con TTL | en `createBooking.flightDetails.flightPricing` |
| Forma de pago para fee | `params.formOfPayment` (BIN, sin PAN) | `payment.formsOfPayment[]` (**PAN + CVV**) |
| Qué viaja al booking | `flightOffer.offerId` + `selectedOfferItems[]` | itinerario y precio **materializados** |

**El adapter de Sabre no es un proveedor homogéneo. Son dos proveedores con una fachada común.**

### 2.7 Errores de transporte (VERIFICADO-SPEC: `help/offer-price-ndc-v1/v1-errors.txt`)

La lista oficial de errores HTTP del producto. Relevante para el circuit breaker y la
política de reintentos:

| HTTP | Código Sabre | Qué hacer |
| --- | --- | --- |
| 400 | `ERR.2SG.CLIENT.INVALID_REQUEST` | error nuestro, **no reintentar** |
| 401 | `ERR.2SG.SEC.INVALID_CREDENTIALS`, `invalid_client` | credenciales; **`invalid_client` también sale cuando el TAM Pool está agotado** — dato operativo importante para BYOC |
| 403 | `ERR.2SG.SEC.NOT_AUTHORIZED` | el PCC no tiene el producto habilitado |
| 404 | *"Response does not contain any data"* | sin resultados, no es fallo |
| 429 | `ERR.2SG.GATEWAY.REQUEST_THROTTLED`, *"Active token count is exceeded"* | **límite de concurrencia por API**; esperar ≥500 ms y reintentar |
| 500 | `ERR.2SG.GATEWAY.TIMEOUT`, `…PROVIDER_CONNECTION_ERROR`, `…INVALID_PROVIDER_RESPONSE` | esperar ≥500 ms y reintentar |
| 503 / 504 | Service Unavailable / Gateway Timeout | idem |

Dos consecuencias de diseño:
- **El backoff mínimo que Sabre pide es 500 ms**, repetido en cada fila. Nuestro breaker debe
  respetarlo, no reintentar inmediato.
- **429 por "active token count"** significa que el límite es de **peticiones concurrentes**,
  no de peticiones por segundo. En BYOC, con un pool por PCC, el fan-out multi-agencia puede
  agotarlo. Hay que limitar concurrencia **por credencial**, no global.

---

## 3. La cadena de identificadores efímeros

### 3.1 El recorrido completo (VERIFICADO + VERIFICADO-SPEC)

```
  ┌─ BFM /v5/offers/shop ───────────────────────────────────────────────────────┐
  │ groupedItineraryResponse                                                    │
  │   .itineraryGroups[0].itineraries[0].pricingInformation[0]                   │
  │       .pricingSource ......... 'ATPCO'|'API'|'NDC'   [BFMv5:8818-8827]       │
  │       .offer.offerId ......................... shop_offer_id  [BFMv5:8233]   │
  │       .offer.timeToLive ...... segundos, OBLIGATORIO           [BFMv5:8242]  │
  │       .offer.source .......... 'ATPCO'|'LCC'|'NDC', OBLIGATORIO [BFMv5:8236] │
  │       .fare.offerItemId ...................... shop_offer_item_id [BFMv5:3622]│
  │       .fare.passengerInfoList[0].passengerInfo.offerItemId                   │
  │                             ......... shop_offer_passenger_item_id [BFMv5:8389]│
  └─────────────────────────────────────────────────────────────────────────────┘
                                    │ query[].offerItemId[]
                                    ▼
  ┌─ POST /v1/offers/price ─────────────────────────────────────────────────────┐
  │ response.offers[0].id ......................... priceOfferId   [OP:396]      │
  │ response.offers[0].ttl ........ segundos, OBLIGATORIO          [OP:399-402]  │
  │ response.offers[0].source ..... ATPCO|LCC|NDC, OBLIGATORIO     [OP:403-405]  │
  │ response.offers[0].offerExpirationDateTime, OBLIGATORIO        [OP:406-408]  │
  │ response.offers[0].offerItems[N].id ........... priceOfferItemId [OP:908-912]│
  │ response.offers[0].offerItems[N].passengers[M].id . passengerId  [OP:913-917]│
  └─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─ POST /v1/trip/orders/createBooking ────────────────────────────────────────┐
  │ flightOffer.offerId            = priceOfferId   (string, 2..49) [BM:4959-4964]│
  │ flightOffer.selectedOfferItems = [priceOfferItemId]  (1..9)     [BM:4966-4974]│
  │ travelers[].id                 = passengerId                                 │
  └─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─ GET /v1/orders/view (RESPUESTA REAL GUARDADA) ─────────────────────────────┐
  │ order.orderItems[0].offerItemId         = "cg05grt8njtq6dou00-1-1"          │
  │ order.orderItems[0].externalOfferItemId = "PoIP98BD9F8A-6BD3-4A7D-953E-1-1" │
  └─────────────────────────────────────────────────────────────────────────────┘
```

`[OP:n]` = `offer-price-ndc-v1.yml:n` · `[BM:n]` = `booking-management-v1.yml:n` ·
`[BFMv5:n]` = `bargain-finder-max-v5.yml:n`

**Novedad frente a la primera pasada:** el `offerId` está **limitado a 49 caracteres** en
`createBooking` (`booking-management-v1.yml:4960-4962`: `minLength: 2, maxLength: 49`), y
`selectedOfferItems` a **`maxItems: 9`**. Con 9 pax y un item por PTC, cabe justo.

### 3.2 Tres niveles de granularidad de `offerItemId`

Se conserva de la primera pasada, con los conteos corregidos (§2.1):

| Variable | Ruta en la respuesta del shop | Uso |
| --- | --- | --- |
| `shop_offer_item_id` | `pricingInformation[0].fare.offerItemId` | **46** de 59 requests de price |
| `shop_offer_passenger_item_id` / `shopPassengerOfferItemId` | `pricingInformation[0].fare.passengerInfoList[0].passengerInfo.offerItemId` | 13 de 59 — **todos** los flujos de FOP y **todos** los de asientos (WF-28→33) |

Que asientos y forma de pago usen el item **por pasajero** ya no es solo una inferencia: el
spec de BFM v5 llama al segundo *"NDC Offer Item Id"* a nivel de `passengerInfo`
(`bargain-finder-max-v5.yml:8389-8391`), y `ObFee.paxRefs[]` / `ObFee.offerItemRefs[]` en
offers/price existen precisamente para atribuir el fee **por pasajero y por item**
(`offer-price-ndc-v1.yml:1396-1404`). El nivel passenger es el que permite precios
diferenciados por pax. **Sigue siendo obligatorio guardar ambos ids del shop.**

### 3.3 Son efímeros — y ahora sabemos cuánto (PREGUNTA CERRADA)

**VERIFICADO-SPEC.** No hace falta capturar nada del CERT para saber el TTL: viene declarado
en la propia respuesta y es **obligatorio**.

| Reloj | Campo | Tipo | Valor en los ejemplos oficiales |
| --- | --- | --- | --- |
| Vida de la oferta | `offers[].ttl` | integer, **segundos** | `1200` (= 20 min) en los 3 ejemplos de `help/offer-price-ndc-v1/examples-offerprice-basic-query.txt:64,382,898` y en `offer-price-ndc-v1.yml:2105,2420` |
| Caducidad absoluta | `offers[].offerExpirationDateTime` | ISO 8601 | `2024-12-12T03:00:23Z`, exactamente `timeStamp + 1200s` |
| Límite de pago | `offers[].paymentTimeLimitDateTime` / `…Text` | ISO / texto | `"2024-12-12T23:59:00"` — **fin del día, no 20 min** |
| Límite de compra | `offers[].purchaseTimeLimitDateTime` | ISO | — |
| Garantía de precio | `offers[].priceGuaranteeTimeLimitDateTime` / `…Text` | ISO / texto | *"fecha antes de la cual la oferta debe convertirse en orden"* |

Y en el shop, **antes** de price: `bargain-finder-max-v5.yml:8226-8245` declara
`Offer.timeToLive` como **obligatorio**, con ejemplo `1255`. O sea que **la oferta de
búsqueda también trae su propio TTL** y podemos usarlo para decidir si hace falta re-shopear
antes de revalidar, sin llamar a Sabre.

**Consecuencias de diseño, ahora concretas:**

- El cache de búsqueda (`SEARCH_CACHE_TTL_SECONDS = 90` en
  `apps/api/src/search/search.service.ts:16`) es **mucho más corto que el TTL del proveedor**.
  Podemos subirlo, pero **acotado por `min(ttl del proveedor)`**, nunca por una constante fija.
- **Hay que persistir `expiresAt` desde `offerExpirationDateTime`, no calcularlo.** El campo
  `paymentTimeLimit*` viene además en **texto libre** cuando el proveedor externo no cumple
  el formato ISO — el schema lo dice explícitamente (`offer-price-ndc-v1.yml:412-417`). El
  parser tiene que tolerar `"2024-01-02T23:35"` sin zona horaria.
- **La oferta vencida tiene un error con nombre.** VERIFICADO-SPEC
  (`help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:689-694`):
  `UNABLE_TO_CREATE_ORDER_EXPIRED_OFFER` / `BAD_REQUEST` /
  *"Invalid or Expired Offer. Use offers/price to reprice the offer."*
  ⇒ **Sabre nos dice literalmente qué hacer**: volver a llamar a `offers/price` con el
  `offerItemId`, no re-shopear. Eso hace viable un `OfferExpiredError` con recuperación
  automática de un salto, no de dos.
- 20 minutos es **más de lo que temíamos** para el canal conversacional, pero sigue siendo
  menos que un ciclo de WhatsApp típico. El riesgo R-2 se mantiene, con mitigación conocida.

### 3.4 El mecanismo de reintento de la colección (se conserva)

El `pre-request` de folder de WF-28 tiene un reintento con `collection_tries` que **vuelve a
correr el shop corriendo la fecha un día** cuando no encuentra itinerario. Sigue siendo
evidencia de que la colección asume re-shop, no reuso.

### 3.5 Los IDs sobreviven a la orden (evidencia de las respuestas guardadas)

Esto es lo que la primera pasada se perdió al declarar vacías las 4 respuestas.

`slices/responses/01-Add_phone_Orders_View.json` (16.636 bytes,
`ModifyBooking / NDC modifications flows / Modify phone / Add phone / Orders View`):

```json
"orderItems": [{
  "id": "1",
  "offerItemId": "cg05grt8njtq6dou00-1-1",
  "externalOfferItemId": "PoIP98BD9F8A-6BD3-4A7D-953E-1-1",
  "price": { "totalAmount": { "amount": "146.60", "code": "USD" }, "totalTaxAmount": {} }
}],
"totalPrice": { "totalAmount": { "amount": "146.60", "code": "USD" } }
```

Tres hechos que solo se ven aquí:

1. **`offerItemId` persiste en la orden** y cumple el patrón `OfferItemId` del spec de
   offers/price. La cadena no se corta en `createBooking`: el id del paso de precio es
   trazable en la orden creada. **Sirve para conciliar.**
2. **`externalOfferItemId` es el id de la aerolínea**, distinto del de Sabre. Para
   soporte y disputas con la aerolínea, es el que hay que citar. Hoy no lo modelamos.
3. **`totalTaxAmount: {}`** — objeto vacío, no `null`, no ausente. Un mapper que haga
   `taxes.amount` sobre eso devuelve `undefined` y termina en un impuesto 0 silencioso.
   **Zod estricto en el borde del ACL, con `.strict()` y sin `.optional()` complaciente.**

Las otras tres respuestas (`02-Delete_phone`, `03-Update_phone`, `04-update_birthdate`) son
del mismo PNR con la misma forma; sirven como fixture de regresión de `orders/view`.

### 3.6 Qué implica para nuestro `Offer` canónico

Estado actual verificado hoy — `packages/canonical/src/offer.ts:27-30`:

```ts
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  offerRef: z.string().min(1).max(255),
});
```

Y el truco del pipe en LATAM, `providers/latam-ndc/src/airshopping/response.mapper.ts:198-199`:

```ts
const itemIds = offerItems.map((item) => (item.OfferItemID as string) ?? '').filter(Boolean);
const encodedRef = itemIds.length > 0 ? `${offerRef}|${itemIds.join(',')}` : offerRef;
```

desempaquetado en `providers/latam-ndc/src/offerprice/request.builder.ts:63-72`, con un
fallback que **inventa un id**:

```ts
if (pipeIdx === -1) {
  return { offerId: ref, offerItemIds: [`${ref}-ITEM1`] };   // <-- enmascara el error
}
```

Sabre necesita transportar como mínimo: `shopOfferId`, `shopOfferItemId`,
`shopPassengerOfferItemId`, `source` (`ATPCO|LCC|NDC`), y tras price `priceOfferId`,
`priceOfferItemIds[]`, `passengerIds[]`, más `expiresAt` real. En un string con pipes es
ilegible y frágil.

**Propuesta (refinada con nombres del spec):**

```ts
export const ProviderRefSchema = z.object({
  name: z.string().min(2).max(40),
  /** Identificador principal legible/loggeable. Sabre lo limita a 49 chars en createBooking. */
  offerRef: z.string().min(1).max(1024),
  /**
   * Fuente dentro del proveedor. NO es un nombre inventado: es el campo `source` que
   * declaran tanto BFM v5 (bargain-finder-max-v5.yml:8236) como Offer Price
   * (offer-price-ndc-v1.yml:1809) con el mismo enum.
   */
  source: z.enum(['ATPCO', 'LCC', 'NDC']).optional(),
  /**
   * Payload crudo del proveedor necesario para revalidar y reservar. OPACO para el
   * dominio: solo el ACL que lo escribió sabe leerlo. Nunca se expone al cliente final
   * ni se persiste más allá de `expiresAt`.
   */
  raw: z.record(z.unknown()).optional(),
});
```

Reglas innegociables si tomamos este camino:

- `raw` **nunca** cruza al cliente final: filtrarlo en el serializer de la API.
- `raw` **nunca** contiene el `formOfPayment` ni el BIN (§9, R-7).
- `raw` **nunca** se cachea más allá de `expiresAt`.
- Si una oferta llega a `createBooking` vencida ⇒ `OfferExpiredError` tipado en
  `packages/core/errors/` (hoy no existe) y **re-price automático**, que es lo que Sabre
  indica hacer (§3.3). Y eliminar el fallback `${ref}-ITEM1` de LATAM: inventar ids
  enmascara el bug en vez de fallar.

---

## 4. Mapas de asiento

### 4.1 La discrepancia v1 vs v3 — RESUELTA (y no es lo que parecía)

**No son dos versiones de la misma API. Son dos APIs con contratos incompatibles.**

| | **v1 — lo que usa la colección** | **v3 — el contrato oficial descargado** |
| --- | --- | --- |
| Ruta | **una sola**: `POST {{rest_endpoint}}/v1/offers/getseats` (32/32 requests) | **tres en el spec de agencia**: `/v3/offers/getseats/byNdcOrderId` (`:28`), `/byNdcOfferId` (`:49`), `/byReservationPayload` (`:70`). El `basePath` es `/v3/offers` (`:26`) |
| Cómo se elige el modo | campo `requestType`: `"payload"` (17), `"orderId"` (9), `"offerId"` (6) | **por ruta**. No hay `requestType` |
| Envoltorio | `{ requestType, request: {...}, pointOfSale, party }` | body **plano**, sin envoltorio |
| POS / PCC | `party.sender.travelAgency.{iataNumber, pseudoCityID, agencyID, agentUserID}` en el body | **ausente**. La doc: *"ya no es necesario proporcionar el PCC en el elemento travelAgency, esta información se lee de la sesión ATK/ATH"* |
| Respuesta | `response.aLaCarteOffer.aLaCarteOfferItems[]` + `response.seatMaps[]` + `response.dataLists.paxs[]` | `response.{offerId, segments[], passengers[], serviceDefinitions[], priceDefinitions[], offerItems[], displayOnlyItems[], seatMaps[]}` |
| Errores | (no declarado) | `errors[]` y `warnings[]` en la raíz, con `category`/`type`/`fieldPath` |
| Precio | `aLaCarteOfferItems[].unitPrice.totalAmount.amount` | `offerItems[].priceDefinitionRef` → `priceDefinitions[].totalPrice.amount` (**indirección**) |
| Elegibilidad | `aLaCarteOfferItems[].eligibility.paxRefIDs[]` + `.eligibility.flightAssociations.paxSegmentRefID[]` | `offerItems[].passengerRefs[]` + `offerItems[].segmentRefs[]` (planos) |
| Puente asiento↔oferta | `seats[].offerItemRefIDs[]` (**IDs** en mayúsculas) | `seats[].offerItemRefIds[]` (**Ids**) + `seats[].displayOnlyItemRefIds[]` |
| Fila | `seatRows[].row` como **string** (`"12"`) | `seatRows[].row` como **integer** (`5`) — `get-seats-agency-3.0.yml:983-986` |

Evidencia dura del ejemplo oficial v3 `byNdcOfferId`
(`help/get-seats-agency-3.0/get-seats-v3-get-seats-ndc-offer-id.txt:6-16`):

```json
{ "offerId": "ih5d79946bb5sp4lsmlj89kj27-1",
  "passengers": [ { "id": "Passenger1", "passengerType": "ADT",
                    "givenName": "Edmunt", "surname": "Kolodziej" } ] }
```

Nada de `requestType`, `request`, `pointOfSale` ni `party`.

**Ojo con una trampa documental:** la página oficial
`get-seats-v3-get-seats-payload-2pax-2seg.txt` **todavía muestra el formato v1** (con
`requestType: "payload"` y respuesta `aLaCarteOffer`), mientras que
`get-seats-v3-get-seats-payload.txt` muestra el formato v3
(`{returnSeatMapsOnlyForSegmentRefs, segments[], passengers[]}`). Es documentación
desactualizada de Sabre conviviendo con la nueva. **No copiar de la página 2pax-2seg.**

#### Decisión recomendada

**Implementar contra v3 (`get-seats-agency-3.0.yml`), no contra el v1 de la colección.**
Razones:

1. Es el contrato que Sabre publica hoy en el catálogo; el v1 no tiene spec descargable.
2. Elimina el `party.sender.travelAgency` hardcodeado — que en BYOC es justo lo que no
   queremos estar rellenando a mano.
3. Trae `displayOnlyItems[]`, que v1 no tiene: asientos que se **muestran pero no se venden**,
   con `displayOnlyReason` (`Unavailable | Unable To Book | Restricted | Unknown`). Sin eso
   pintamos como comprable algo que no lo es.
4. Trae `priceDefinitions[]` con desglose de impuestos por asiento, que v1 no expone.

**Riesgo de la decisión:** la colección (que es lo que Sabre entrega a los clientes) usa v1.
Puede que el PCC de CERT solo tenga v1 habilitado. **Verificar en el sandbox antes de
escribir el adapter** (§8, ítem 6).

#### Agency vs Airline: dos specs, dos catálogos de rutas

| | `get-seats-agency-3.0.yml` (`info.version: "3.1"`) | `get-seats-airline-3.0.yml` (`info.version: "3.0"`) |
| --- | --- | --- |
| `byNdcOfferId` | ✅ `:49` | ❌ |
| `byNdcOrderId` | ✅ `:28` | ❌ |
| `byReservationPayload` | ✅ `:70` | ✅ `:26` |
| `byPnrLocator` | ❌ | ✅ `:47` |

> **Corrección de esta pasada.** La versión anterior decía que v3 tiene *"cuatro rutas"* y que
> ambos specs son `info.version: 3.1`. Ninguna de las dos cosas es exacta: **las cuatro rutas
> son la unión de los dos productos**, ninguno las tiene todas, y el spec de aerolínea declara
> `version: "3.0"` (`get-seats-airline-3.0.yml:10`), no 3.1. Que agencia y aerolínea vayan por
> versiones distintas del mismo producto importa para BYOC: si un consolidador tiene agencias
> que además son hosted carriers, no comparten contrato.

**Nosotros somos agencia**, así que va `get-seats-agency`. Y ojo: la doc dice
*"GetSeats Stateless request type (por `pnrLocator`): **NOT SUPPORTED YET**"*
(`help/get-seats-agency-3.0/3.0-index.txt`) — coherente con que el spec de agencia no
declare esa ruta. **No podemos pedir mapa de asientos por PNR desde el carril de agencia.**

### 4.2 Cuándo se puede vender un asiento (VERIFICADO-SPEC — regla de negocio dura)

`help/get-seats-agency-3.0/3.0-index.txt`, sección *GetSeats with request type OfferID*:

> El mapa **puede** mostrarse con el `OfferID` **del shopping**, pero *"los asientos no son
> reservables porque los precios del mapa no están garantizados hasta que la oferta de la
> tarifa aérea ha sido tarificada. Por eso el mapa se muestra con un indicador de solo
> visualización (`sellable: false`). Si se intenta reservar un asiento en esta fase, se
> devuelve un error de 'oferta inválida o expirada'."*

⇒ **El orden es obligatorio: shop → price → getseats.** No se puede mostrar mapa vendible
directamente desde la búsqueda. Esto tiene impacto de producto: en el Package Studio, la
selección de asiento **no puede vivir en la tarjeta de resultados**, tiene que venir después
de revalidar.

> **Salvedad, ahora con más evidencia.** El campo `sellable` aparece en la documentación
> (`help/get-seats-agency-3.0/3.0-index.txt:70`) pero **no está declarado en
> `get-seats-agency-3.0.yml`** — se re-verificó en esta pasada con `grep -i sellable` sobre el
> .yml completo: **cero coincidencias**.
>
> Lo nuevo: **`sellable` sí existe, como booleano, en el spec de ancillaries**
> (VERIFICADO-SPEC: `get-ancillaries-agency-2.3.yml:211-214`, *"Whether the items in this offer
> are available for sale"*, con `example: false`). O sea que no es un invento de la
> documentación: es un campo real del ecosistema de Offer Store de Sabre que **el spec de
> asientos no declara**. Las dos lecturas posibles siguen abiertas: o la doc de asientos va
> por delante del .yml publicado, o el `sellable` de asientos vive solo en el carril v1.
> `[Verificar en el CERT — si no aparece en la respuesta de getseats v3, la señal de "solo
> visualización" hay que derivarla de `displayOnlyItems[]`.]`

También verificado: *"La aplicación del punto de venta o el PCC pueden no estar autorizados
para vender asientos de uno o más transportistas. En ese caso, la selección de asiento no
estará disponible."* ⇒ en BYOC, **la capacidad de vender asientos depende del PCC de cada
agencia**. Hay que degradar la UI por tenant, no asumir que siempre está.

### 4.3 Forma de la respuesta v3 (VERIFICADO-SPEC)

`SeatAvailabilityRs` (`get-seats-agency-3.0.yml:183-208`) — raíz:

```
{ response: SeatAvailabilityResponse, errors: Error[], warnings: Warning[], extensions: {} }
```

`SeatAvailabilityResponse` (`:210-263`) — **obligatorios: `segments`, `passengers`,
`offerItems`, `serviceDefinitions`, `seatMaps`**:

| Campo | Qué es |
| --- | --- |
| `offerId` | *"ID único de la oferta devuelta. Se usa para añadir los seat offers a la reserva."* |
| `offerExpirationDateTime` | *"La oferta sigue válida hasta esta hora y puede usarse para reservar asientos."* — **el mapa también caduca** |
| `segments[]` | itinerario, con `flightLegs[]` |
| `passengers[]` | `id`, `passengerType`, nombre, `loyaltyProgramAccounts[]`, `reservationPassengerId` |
| `serviceDefinitions[]` | producto: `serviceCode` (SSR/ancillary), `airlineCode`, `commercialName`, `groupCode` |
| `priceDefinitions[]` | `currencyCode`, `totalPrice` (`amount`, `amountWithoutTaxes`, `taxesTotal`, `taxes[]`, `isTaxExempt`), `referenceBasePrice` |
| `offerItems[]` | **lo vendible**: `id`, `serviceDefinitionRef`, `priceDefinitionRef`, `segmentRefs[]`, `passengerRefs[]`, `refundableReissuableIndicator`, `isInterlineable`, `sectorPortionIndicator`, `feeApplicationMethod`, `purchaseByDateTime`, `paymentType`, `annotations[]` |
| `displayOnlyItems[]` | **lo NO vendible**: mismos campos + `displayOnlyReason`, `displayOnlySource`, `displayOnlyReasonDetails[]` |
| `seatMaps[]` | el mapa físico: `segmentRef`, `flightLegRef`, `cabinCompartments[]` |

Dentro de `cabinCompartments[]` (`:851-882`): `firstRow`, `lastRow`, `columnIds[]`,
`cabinCode`, `cabinName`, `cabinLayout` y `seatRows[]`.

Y `cabinLayout` (`:884-940`) trae cosas que v1 no da y que sirven para **pintar el avión de
verdad**: `columns[].position` (`A` aisle / `C` central / `W` window), `rows{firstRow,lastRow}`,
`wingRowPosition[]`, `exitRowPosition[]`, `seatCount`, `authorizedSeatCount`,
`missingRowNumbers[]`, `missingSeats[]`, `facilities[]`, `deckCode`.

`SeatType` (`:1012-1042`): `column`, `occupationStatusCode`, `characteristics[]`,
`isOperative`, `offerItemRefIds[]`, `displayOnlyItemRefIds[]`.

**El modelo mental se mantiene** (era correcto en la primera pasada): un lado dice *"qué
puedo venderte y a qué precio"*, otro dice *"cómo está distribuido el avión"*, y se cruzan
por referencias de id. Lo que cambia en v3 es que **el precio está a dos saltos**
(`seat.offerItemRefIds` → `offerItems[].priceDefinitionRef` → `priceDefinitions[]`), no
embebido.

### 4.4 Códigos de asiento — PREGUNTA CERRADA con el catálogo oficial

La primera pasada dejó abierto *"¿qué significan los `characteristics[].code` `1` y `1D`?"* y
extrajo de los scripts una regla de "salida de emergencia prohibida para no-ADT".

**El spec dice que son IATA PADIS 9825 (características) y 9865 (ocupación)**
(`get-seats-agency-3.0.yml:1099-1115`), y la documentación oficial trae los valores con
descripción. Extraídos de los 5 ejemplos de respuesta oficiales
(`help/get-seats-agency-3.0/*.txt`), **todos los pares `code`/`description` observados**:

| Code | Descripción oficial | Relevancia |
| --- | --- | --- |
| `1` | `RestrictedGeneral` | **la respuesta a la pregunta abierta** |
| `1A` | `NotAllowedForInfants` | **regla dura: infantes** |
| `1B` | `NotAllowedForMedical` | |
| `1C` | `NotAllowedForUnaccompaniedMinors` | **regla dura: menores no acompañados** |
| `1D` | `RestrictedRecline` | **la otra pregunta abierta** — no reclina |
| `1W` | `WindowSeatWithoutWindow` | ventanilla sin ventana. Mostrarlo o hay reclamo |
| `9` | `CenterSeat` | |
| `A` | `AisleSeat` | |
| `AT` | `SeatAdjacentToTable` | |
| `B` | `SeatWithBassinetFacility` | cuna — **buscar activamente si viaja INF** |
| `BK` | `BlockedSeatForPreferredPassengerInAdjacentSeat` | |
| `CC` | `CenterSectionSeat(S)` | |
| `CH` | `ChargeableSeat` | **asiento de pago** |
| `DE` | `Deportee` | |
| `E` | `ExitRowSeat` / `ExitRow` | **dos descripciones para el mismo code** |
| `FC` | `FrontOfCabin` | |
| `H` | `SeatWithFacilitiesForHandicapped/IncapacitatedPassenger` | accesibilidad |
| `I` | `SeatSuitableForAdultWithInfant` | |
| `IE` | `SeatNotSuitableForChild` | **regla dura: menores** |
| `K` | `BulkheadSeat` | |
| `L` | `LegSpaceSeat` | espacio extra — argumento de venta |
| `LA` | `NoSeatLavatory` | |
| `LS` | `LeftSideOfAircraft` | |
| `O` | `PreferredSeat/PreferentialSeat` | |
| `OW` | `OverWingSeat(S)` | |
| `PC` | `PetInCabin` | |
| `RS` | `RightSideOf Aircraft` | **con el espacio raro incluido, tal cual lo devuelve Sabre** |
| `U` | `SeatSuitableForUnaccompaniedMinors` | |
| `V` | `SeatToBeLeftVacant/OfferedLast` | |
| `W` | `Window` | |

Y `occupationStatusCode` (PADIS 9865), enumerado **completo** en la descripción del campo
(`get-seats-agency-3.0.yml:1021-1023`): `B` boarding pass anticipado, `C` reservado en
check-in, `D` bloqueado por deadload, `E` asiento extra, **`F` libre**, `G` pre-asignación de
grupo, `H` cortesía, `I` no disponible interline, `M` motivos médicos, `N` no designado para
la RBD pedida, **`O` ocupado**, `P` protegido, `Q` **no hay asiento aquí**, `R` reservado
genérico, `S` protegido code-share, `T` pasajero en tránsito, `U` protegido upline,
`V` protegido downline, `X` no disponible para aerolíneas socias, `Y` selección anticipada,
`Z` bloqueado por otro motivo.

#### Corrección a las reglas de la primera pasada

Los scripts de la colección codifican:

```js
// pre-request de folder, Workflows / 28-33
seat.offerItemRefIDs.includes(offerItemRefID) &&
seat.occupationStatusCode === "F" &&
(paxType !== "ADT" ? !seat.characteristics.some(c => c.description === "ExitRowSeat") : true)
```

```js
// ModifyBooking
seat.characteristics.every(char => char.code != "1" && char.code != "1D") && seat.occupationStatusCode == "F"
```

**Eso es una heurística de demo, no la regla correcta.** Correcciones:

1. **Filtrar por `description === "ExitRowSeat"` es frágil**: el mismo code `E` aparece
   también como `"ExitRow"` en los ejemplos oficiales. **Hay que filtrar por `code`, nunca
   por `description`.**
2. **La restricción de menores no es "fila de emergencia"**, es un conjunto de códigos
   explícitos: `1A` (infantes), `1C` (menores no acompañados), `IE` (no apto para niños). Un
   asiento puede ser `1C` sin ser `E`, y entonces la heurística de la colección lo deja pasar.
3. **`Q` (`No seat here`) hay que tratarlo como hueco de layout, no como asiento ocupado**, o
   el mapa se dibuja mal.
4. **Excluir `1` y `1D` a ciegas es exagerado.** `1D` = no reclina: es información para el
   cliente, no motivo de exclusión. `1` = restringido general: ahí sí, excluir.

**Reglas que debe implementar nuestro selector (en el dominio, no en el ACL):**

| Regla | Base |
| --- | --- |
| Solo `occupationStatusCode === 'F'` | PADIS 9865 |
| El asiento debe tener un `offerItemRefIds` que apunte a un `offerItem` cuyo `passengerRefs` incluya al pax **y** cuyo `segmentRefs` incluya al segmento | `OfferItemDetails:278-328` |
| Un asiento con solo `displayOnlyItemRefIds` **no es comprable** | `DisplayOnlyItem:329-354` |
| Excluir `code === '1'` (RestrictedGeneral) | catálogo oficial |
| Para `INF`/pax con infante: excluir `1A`, preferir `B` (bassinet) e `I` | catálogo oficial |
| Para `CHD`: excluir `IE` | catálogo oficial |
| Para menor no acompañado (`UNN`/`UMNR`): excluir `1C`, preferir `U` | catálogo oficial |
| Para no-ADT: excluir `code === 'E'` (exit row) | **regulatorio**; se mantiene de la primera pasada, corregido a filtrar por code |
| `1D`, `1W`, `LA`, `V`: **mostrar, no excluir** | son advertencias al cliente |

### 4.5 Cómo se consume el asiento elegido (VERIFICADO + VERIFICADO-SPEC)

**(a) Al crear la orden NDC.** Colección
(`Workflows / 28-33 … / Seats - 2 Adults 1 Infant with Seats | 2 Segments | AY / CreateBooking`):

```json
"flightOffer": {
  "offerId": "{{priceOfferId}}",
  "selectedOfferItems": [ "{{priceOfferItemId}}" ],
  "seatOffers": [
    { "seatOfferId": "{{segment1Passenger1OfferItemId}}",
      "number": "{{segment1Passenger1Row}}{{segment1Passenger1Column}}", "travelerIndex": 1 }
  ]
}
```

VERIFICADO-SPEC contra `booking-management-v1.yml`:

| Campo | Spec | Restricción |
| --- | --- | --- |
| `flightOffer.offerId` | `:4959-4964` | string, **2..49 chars**, obligatorio |
| `flightOffer.selectedOfferItems` | `:4966-4974` | array de string, **1..9**, obligatorio |
| `flightOffer.seatOffers` | `:4975-4980` | array, `minItems: 1`. *"Applicable for NDC flights only"* |
| `seatOffers[].seatOfferId` | `:5280-5285` | *"The seat availability offer item ID"*, 2..49 chars |
| `seatOffers[].number` | `:5293-5297` | **patrón `^[0-9]+[A-Z]$`** — fila+columna concatenadas, ej. `"13A"` |
| `seatOffers[].travelerIndex` | `:5298-5304` | integer, **`minimum: 1`**, obligatorio |

⇒ La afirmación de la primera pasada (*"`number` es la concatenación fila+columna, no un
objeto; `travelerIndex` es 1-based"*) **queda confirmada por el patrón del spec**.

#### ⚠️ Corrección a la pasada anterior: la preferencia de área NO existe en NDC

La versión anterior de este documento afirmaba: *"`BookGenericSeat` (`:5288`) permite `number`
**o** `areaPreference` … se puede pedir 'ventanilla' sin elegir asiento concreto. Útil para el
bot de WhatsApp."* **Es falso en el punto que importa**, y la jerarquía del spec lo desmiente:

| Schema | Línea | Qué añade | Dónde se usa |
| --- | --- | --- | --- |
| `BookGenericSeat` | `:5286-5302` | **solo** `number` (`^[0-9]+[A-Z]$`) y `travelerIndex` (obligatorio, `min: 1`) | base de los otros dos; y directo en `changeOfGaugeSeats` (`:5250-5255`) |
| `BookSeat` | `:5257-5271` | `allOf: BookGenericSeat` **+ `areaPreferences`** — array, `minItems: 1`, **`maxItems: 3`** | `flightDetails.flights[].seats[]` (`:5243-5249`) ⇒ **carril ATPCO/LCC** |
| `BookSeatOffer` | `:5273-5284` | `allOf: BookGenericSeat` **+ `seatOfferId`** (2..49). *"Applicable for NDC flights only"* | `flightOffer.seatOffers[]` (`:4975-4980`) ⇒ **carril NDC** |

`areaPreferences` está **solo en `BookSeat`**, no en `BookGenericSeat` ni en `BookSeatOffer`.
Y `flightOffer.seatOffers[]` — la única vía de asiento en NDC — referencia `BookSeatOffer`.

⇒ **En NDC no se puede pedir "ventanilla" sin mapa. Solo en ATPCO/LCC.** Justo al revés de
donde nos conviene: fase 1 apunta a NDC (§2.6, R-1) y es NDC quien exige que el cliente
elija una celda concreta de un mapa. Consecuencia de producto en §4.8.

`SeatAreaPreferenceEnum` (VERIFICADO-SPEC: `booking-management-v1.yml:8868-8881`) tiene **7
valores**: `AISLE`, `BULKHEAD`, `FRONT`, `LEFT_SIDE`, `RIGHT_SIDE`, `TAIL`, `WINDOW`, y se
pueden combinar *"un máximo de tres valores no conflictivos, como `FRONT` y `LEFT_SIDE`"*.
Mutuamente excluyente con `number` (`:5297`).

**Detalle adicional no visto antes:** `changeOfGaugeSeats` (`:5250-5255`). En vuelos con
*change of gauge* o *funnel flight* (mismo número de vuelo, cambio de aeronave a mitad de
trayecto), `seats[]` asigna asiento **en la primera aeronave** y hace falta un segundo array
para la que sale. Un mapper que solo llene `seats[]` deja al pasajero sin asiento en la
segunda mitad del "segmento", sin ningún error que lo delate.

**(b) Sobre orden ya creada, NDC — `/v1/orders/change`.** Aquí `row` y `column` van
**separados**:

```json
"seatAdds": [
  { "offerItemId": "{{seat_offer1}}", "passengerRefs": "Passenger1",
    "row": "{{seat_row_passenger_1}}", "column": "{{seat_column_passenger_1}}" }
]
```

**(c) Sobre orden ya creada, vía `modifyBooking`** (patrón `before`/`after`):

```json
{ "bookingSignature": "{{bookingSignature}}", "confirmationId": "{{pnr}}",
  "before": {},
  "after": { "flights": [ { "seats": [
    { "number": "{{seat_row_passenger_1}}{{seat_column_passenger_1}}",
      "offerItemId": "{{seat_offer1}}" } ] } ] } }
```

Para borrar: el asiento va en `before` y `after.flights[0]` queda `{}`.

**(d) ATPCO pre-booking** — dentro de `flightDetails`, **sin `offerItemId`**:

```json
"flightDetails": { "flights": [ {
  "flightNumber": {{flight_number}}, "airlineCode": "{{airline_code}}",
  "seats": [ { "number": "{{seat_passenger}}", "travelerIndex": 1 } ] } ] }
```

**(e) Sobre PNR, vía `Manage Ancillary` — `POST /v1/ancillaries/add`** (§5.9). Aquí `row` es
**integer** y `column` string (VERIFICADO-SPEC: `manage-ancillary-1.1.yml:1328-1345`):

```json
{ "pnrLocator": "ABCDEF",
  "seats": [ { "offerItemId": "...", "passengerRef": "1", "row": 33, "column": "F" } ] }
```

⇒ **CUATRO serializaciones distintas del mismo dato, en cuatro productos de la misma empresa:**

| Carril | Fila+columna | Id de oferta |
| --- | --- | --- |
| `createBooking.flightOffer.seatOffers[]` (NDC) | `number: "13A"` concatenado, patrón `^[0-9]+[A-Z]$` | `seatOfferId` |
| `orders/change.seatAdds[]` (NDC) | `row` y `column` **separados, ambos string** | `offerItemId` |
| `createBooking.flightDetails…seats[]` (ATPCO) | `number` concatenado | **ninguno** |
| `ancillaries/add.seats[]` (PNR) | `row` **integer** + `column` string | `offerItemId` |

El ACL tiene que normalizar `{row: string, column: string}` internamente y serializar según el
destino — incluido el cast a integer, que revienta con filas alfanuméricas si alguna aerolínea
las usa.

#### Errores de asiento — taxonomía oficial (VERIFICADO-SPEC)

`help/booking-management-api-v1/help-documentation-modify-booking-error-list-0.txt:711-808`.
Sustituye a "DESCONOCIDO: cómo falla":

| Código | Categoría | Significado | Qué hacemos |
| --- | --- | --- | --- |
| `SEATS_OFFER_EXPIRED` | `APPLICATION_ERROR` | *"al menos un seat offer ha expirado"* | re-llamar `getseats`; **el mapa tiene su propio `offerExpirationDateTime`** |
| `SEATS_OFFER_INVALID` | `APPLICATION_ERROR` | offer inválida | re-llamar `getseats` |
| `SEATS_OFFER_UNAVAILABLE` | `APPLICATION_ERROR` | *"no disponible para el viajero seleccionado"* | violamos la regla de `passengerRefs` |
| `SEATS_OFFER_ID_MISSING` | `BAD_REQUEST` | falta el offer id en un vuelo NDC | bug nuestro |
| `SEATS_NUMBER_INVALID` | `BAD_REQUEST` | *"el asiento no pertenece al mapa"* | bug de mapeo fila/columna |
| `SEATS_ASSIGNMENT_INVALID` | `BAD_REQUEST` | asociación asiento↔viajero incorrecta | bug de `travelerIndex` |
| `SEATS_DUPLICATE_ASSOCIATION` | `APPLICATION_ERROR` | mismo asiento asignado dos veces | validar antes de enviar |
| `SEATS_NOT_AVAILABLE` | `APPLICATION_ERROR` | ya no está libre | carrera; re-pedir mapa |
| `SEAT_NOT_ALLOWED_FOR_BOOKING` | **`WARNING`** | *"la selección de asiento no se procesó correctamente"* | **la reserva se crea igual, sin asiento**. Hay que detectarlo y avisar |
| `SEATS_UPDATE_NOT_SUPPORTED` | `APPLICATION_ERROR` | *"la aerolínea %s no soporta modificación de asiento"* | ocultar la acción por carrier |
| `SEATS_UPDATE_WITHOUT_TICKETING` | `APPLICATION_ERROR` | *"la aerolínea %s no permite cambiar asiento antes de emitir"* | **orden de operaciones por carrier** |
| `INFANT_SPECIAL_SERVICE_MISSING` | **`WARNING`** | los infantes requieren SSR dedicado | |

Y el kill-switch: `errorHandlingPolicy` de `createBooking` admite
**`DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`** y `DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR`
(VERIFICADO-SPEC: `help/…/help-documentation-create-booking.txt:112-114`). El default es
`HALT_ON_ERROR`.

⇒ **Decisión de producto:** ¿preferimos reserva sin asiento o fallo total? Para un
consolidador, casi siempre lo primero — pero hay que **avisar al vendedor**, no tragárselo.

### 4.6 El carril payload y la sesión SOAP

En la colección, los 17 requests de `getseats` en modo `payload` viven en
`ModifyBooking / Flight modification flows / Seat modifications`, y esos folders **abren una
sesión SOAP antes**: `SessionCreateRQ 1.0.0` seguido de `OTA_AirAvailRQ 2.4.0`
(`slices/09-soap-lls-stateful.txt:544-614`). El propósito de la llamada SOAP es acotado y
está a la vista en el pre-request:

```js
pm.environment.set("airline_code", "QF");
pm.environment.set("from_airport_code", "ADL");
pm.environment.set("to_airport_code", "MEL");
```

⇒ **La sesión se abre solo para averiguar el número de vuelo**, que el modo `payload`
necesita porque describe el vuelo entero en vez de referenciar una oferta.

La doc oficial dice que en el carril payload (ATPCO/LCC) *"para reservar un asiento, usa la API
PassengerDetails o el comando 4G"* (`help/get-seats-agency-3.0/3.0-index.txt`). Y
`PassengerDetailsRQ` es SOAP stateful — hay 4 requests de ese tipo en la colección.

#### ⚠️ Matización de esta pasada: esa doc está incompleta

La conclusión anterior era *"vender asientos ATPCO/LCC por Sabre **exige** gestor de sesiones
SOAP"*. **Ya no se sostiene como afirmación absoluta.** El spec descubierto en esta pasada,
`manage-ancillary-1.1.yml`, declara `POST /v1/ancillaries/add` como *"Creates **pre-reserved
seats** and associated ancillaries and/or other ancillaries **in a PNR-based reservation**"*
(`:26-28`), y su `AddAncillariesRequest` acepta `seats[]` con `offerItemId` + `passengerRef` +
`row` + `column` (`:1237-1259`, `:1328-1345`). Es **REST y stateless**, autenticado por token
como el resto.

Las dos afirmaciones son compatibles si la página de `getseats` simplemente **no se actualizó**
cuando salió Manage Ancillary 1.1 — que es el mismo patrón de documentación desactualizada ya
detectado en `get-seats-v3-get-seats-payload-2pax-2seg.txt` (§4.1). Pero **no lo hemos
probado**: `[Verificar en el CERT si `/v1/ancillaries/add` asigna asiento ATPCO sin abrir
sesión SOAP — captura #13.]`

⇒ **Corrección de la postura:** la sesión SOAP sigue siendo obligatoria para lo que la colección
demuestra que la necesita (`GetAncillaryOffersRQ` LCC, §5.3; y averiguar el número de vuelo para
el modo `payload`), pero **la asignación de asiento sobre PNR probablemente ya no**. El riesgo
R-17 baja de alcance y su mitigación cambia: antes de construir un pool de sesiones, agotar el
carril REST. Ver §5.9.

### 4.7 Nomenclatura de variables de la colección (se conserva)

Tres generaciones conviviendo. Documentarlo evita que alguien intente unificarlas:

| Generación | Variables | Dónde | Forma |
| --- | --- | --- | --- |
| v1 (legacy) | `seat_passenger`, `seat_passenger_1`, `seat_passenger_2` | `Flight modification flows / Seat modifications` | fila+columna ya concatenadas |
| v2 | `seat_offer1`, `seat_row_passenger_1`, `seat_column_passenger_1` | `NDC modifications flows / Modify seats`, `FulfillFlightTickets` | fila y columna separadas |
| **v3 (la buena)** | `segment1Passenger1OfferItemId`, `…PassengerRefs`, `…Row`, `…Column` | `Workflows / 28-33` | indexado por **segmento × pasajero** |

La v3 es la única que modela correctamente que un asiento se elige por (segmento, pasajero) y
no por (pasajero) a secas. Es la que hay que copiar.

### 4.8 Qué imponen estos tres endpoints al canal conversacional

> **Sección nueva, en respuesta al hallazgo 1 de la crítica.** Hasta ahora WhatsApp aparecía en
> este documento solo como víctima de un riesgo (la oferta caduca mientras el vendedor
> conversa). Pero `CLAUDE.md` §5 lo declara *"ciudadano de primera"*, y estos tres endpoints le
> imponen restricciones duras que conviene tener escritas **antes** de diseñar el bot, no después.

**1. En NDC, el asiento no se puede vender conversacionalmente. Es el hallazgo grande.**
La preferencia de área (`WINDOW`, `AISLE`, `FRONT`…) — la única forma de elegir asiento sin
pintar un mapa — **existe solo en el carril ATPCO** (`BookSeat.areaPreferences`) y **no en NDC**
(`BookSeatOffer`), §4.5. En NDC hay que devolver un `seatOfferId` concreto de un `offerItem`
concreto, y para tenerlo hay que haber renderizado el mapa. Opciones reales, ninguna gratis:

- **(a)** El bot no vende asiento: manda un enlace a una vista web del mapa (mobile-first) y
  vuelve a la conversación con la selección hecha. Es lo que encaja con *"tiempo a venta < 2
  min"* y con el mapa de `cabinLayout` que v3 sí nos da (§4.3) para dibujarlo bien.
- **(b)** El bot implementa la preferencia **del lado nuestro**: el vendedor o el cliente dice
  "ventanilla", y **nosotros** filtramos el `seatMaps[]` por `characteristics[].code === 'W'`
  y elegimos el primer `occupationStatusCode === 'F'` vendible. Es viable con el catálogo PADIS
  de §4.4, pero **la elección es nuestra, no del proveedor**: si la aerolínea reasigna, la
  responsabilidad es nuestra.
- **(c)** Vender sin asiento y ofrecerlo post-emisión por `orders/change` o
  `/v1/ancillaries/add`. Es lo que hace la mayoría de OTAs, y lo que el `errorHandlingPolicy`
  `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR` (§4.5) facilita.

Recomendación: **(a) para el mapa, (b) como atajo explícito**, nunca (b) en silencio.

**2. El reloj del canal no es el reloj del proveedor.** `ttl = 1200 s` (§3.3) es el orden de
magnitud de una conversación de WhatsApp, no de un checkout web. El bot **tiene que** guardar el
criterio de búsqueda junto a la oferta y saber que el remedio de Sabre es **re-price, no
re-shop** (`"Use offers/price to reprice the offer"`), un salto y no dos. Y el mapa de asientos
tiene **su propio** `offerExpirationDateTime` (§4.3): puede caducar el mapa aunque la tarifa siga
viva, y eso produce `SEATS_OFFER_EXPIRED` en el `createBooking`, no antes.

**3. El bot no puede tocar el BIN, y no hace falta que lo toque.** Pedir 6-8 dígitos de tarjeta
por WhatsApp sería a la vez mala UX y un problema de cumplimiento (el mensaje queda en el
historial del dispositivo del cliente y en el nuestro). El flujo sin `formOfPayment` de §2.4 —
cotizar sin FOP, propagar el warning, revalidar con el BIN **desde el PSP** justo antes de
capturar — es exactamente el que el canal conversacional necesita. **Es un requisito del bot, no
una optimización.**

**4. `messages[]` tiene que ser renderizable como texto plano.** `Message` trae `type`,
`message`, `service`, `code` y `additionalDescription` (§2.5). El canal no tiene sitio para una
tabla de errores: el ACL debe producir **una frase** por warning, ya traducida, y el
`ProviderMessage` de §6.3 existe para eso. Un `warnings: string[]` con el texto crudo en inglés
de Sabre no sirve para un cliente colombiano.

**5. Requisito heredado del documento 05, que aquí se hace explícito.** Lo que el pasajero
necesita para hacer check-in **no es nuestro id de orden ni el PNR de Sabre**: es el localizador
de la aerolínea (`externalOrders[].bookingReferences[]`). Es el dato que el bot tiene que enviar
al cerrar la venta. Enlaza con `externalOfferItemId` de §3.5: el mundo "id de Sabre" y el mundo
"id de la aerolínea" conviven en toda la cadena, y el canal conversacional necesita **siempre el
segundo**. `[El requisito funcional correspondiente pertenece al documento 10, no a éste.]`

**6. Contacto por pasajero, no por reserva.** Varias aerolíneas NDC exigen datos de contacto a
nivel de pasajero (verificado en la colección, WF-12). Un bot que solo conoce el número de
WhatsApp de quien escribe **no tiene el dato para los acompañantes**, y eso bloquea el
`createBooking`, no el `offers/price`. Hay que pedirlo en la conversación, antes de reservar.

---

## 5. Ancillaries — cuatro caminos, no dos

### 5.1 Tabla de decisión (VERIFICADO + VERIFICADO-SPEC)

La pasada anterior contaba dos caminos y añadía uno como nota. Con el spec recuperado en esta
pasada (§0.1) **son cuatro**, y no compiten entre sí: cubren carriles distintos.

| | **A.** REST `/v2/offers/getAncillaries` | **B.** SOAP `GetAncillaryOffersRQ` | **C.** `offers/price` con `type: "Service"` | **D.** REST `/v1/ancillaries/*` |
| --- | --- | --- | --- | --- |
| **Producto** | Get Ancillaries - Agency **2.3** | Merch Ancillary Offer v03 | Offer Price NDC v1 | **Manage Ancillary 1.1** |
| **Spec** | ✅ `get-ancillaries-agency-2.3.yml` | ❌ (solo la colección) | ✅ `offer-price-ndc-v1.yml` | ✅ `manage-ancillary-1.1.yml` |
| **Aplica a** | NDC | ATPCO y LCC | NDC | **PNR** (ATPCO/LCC) |
| **Momento** | pre-booking (`offerId`) **y** post (`orderId`) | pre-booking (por itinerario) | durante la revalidación | **post-booking, sobre PNR** |
| **Qué hace** | cotiza | cotiza | cotiza (de paso) | **reserva / quita / cambia** |
| **Sesión** | stateless, token | ATPCO con token; **LCC stateful** | stateless | stateless |
| **Cómo se aplica lo cotizado** | `modifyBooking.after.travelers[].ancillaries[].offerId` — **un id** | `createBooking.travelers[].ancillaries[]` — **8-12 campos materializados** | `flightOffer.selectedOfferItems[]` | `offerItemId` + `passengerRef` — **un id** |
| **Requests en la colección** | 3 (idénticos) | 6 | 0 | **0 — no aparece** |

**Consecuencia de diseño.** Solo **B** obliga al cliente a transportar el precio, y es
precisamente el único de los cuatro sin contrato público. Los otros tres funcionan con
identificadores opacos, que es lo que queremos. Antes de dar por buena la arquitectura
"cotizo por SOAP y materializo en `createBooking`" (que es lo que enseña la colección), hay
que medir si **D** cubre el caso ATPCO — porque si lo cubre, **R-3 deja de aplicar al camino
principal**.

**Nota sobre C:** `offers/price` puede devolver ancillaries como `offerItems[]` con
`type: "Service"` (§2.5), activable para bundles con `params.allowBundles: true`
(`offer-price-ndc-v1.yml:265-268`). No sustituye a A —A es el catálogo, C es lo que ya venía
en la oferta— pero puede evitar una llamada en el flujo feliz.

### 5.2 Camino A — REST `/v2/offers/getAncillaries` (**LAGUNA CERRADA**)

> ✅ **Esta sección era la laguna declarada del documento en las dos pasadas anteriores.**
> Ahora hay contrato oficial: `get-ancillaries-agency-2.3.yml` (877 líneas, OpenAPI 3.0.0,
> `info.version: "2.3"`), obtenido como se explica en §0.1. El `basePath` es **`/v2/offers`**
> (`:12-22`) y la única ruta es **`POST /getAncillaries`** (`:24-25`), que casa exacto con la
> colección. La numeración `2.3` es la del catálogo; la `v2` de la URL es la del contrato.

#### Lo primero: qué es realmente este endpoint

`info.description` (`:9`) — y conviene leerlo dos veces:

> *"The Get Ancillaries API displays **free-of-charge ancillaries** in the IATA New
> Distribution Capability (NDC) standard format."*

Y en la respuesta, `Offer.otherServices` (`:215-219`):

> *"Lists the services that the system was not able to add to `baggageGrid` or
> `otherBaggageCharges`. **Both of these fields will be defined in a future version of this
> API.**"*

⇒ **v2.3 es un endpoint de equipaje, no un catálogo general de ancillaries, y sus dos campos
principales todavía no existen.** Lo único que devuelve hoy son "los servicios que el sistema
no pudo meter en las rejillas de equipaje". Eso explica por qué el script de la colección hace
búsqueda recursiva de `offerItemId`: el campo vive en un cajón de sastre
(`ancillaries.offer.otherServices[].offerItemId`), no en una colección de primer nivel.

**Esto es más importante que tener el spec.** La conclusión de la pasada anterior —*"cualquier
plan que dependa de vender ancillaries NDC en fase 1 está apoyado en aire"*— **sigue siendo
correcta, pero por otro motivo**: no porque no supiéramos la forma, sino porque **el producto
está incompleto por declaración propia de Sabre**.

#### Request — VERIFICADO-SPEC campo por campo

`oneOf: [ServiceListOfferRequest, ServiceListOrderRequest]` (`:34-36`) con **discriminador
`requestType`** (`:66-70`):

```yaml
discriminator:
  propertyName: requestType
  mapping:
    orderId: "#/components/schemas/ServiceListOrderRequest"
    offerId: "#/components/schemas/ServiceListOfferRequest"
```

⇒ **`requestType: "offerId"` EXISTE.** La pregunta abierta #4 de la pasada anterior queda
**CERRADA en afirmativo**. Se pueden cotizar ancillaries NDC **antes** de crear la orden.

| Modo | Schema | Obligatorios | Opcionales | Línea |
| --- | --- | --- | --- | --- |
| `offerId` | `OfferRequest` | **`offerId`**, **`passengers[]`** (`minItems: 1`) | `requestedSegmentRefs[]` | `:95-116` |
| `orderId` | `OrderRequest` | **`orderId`** | `requestedSegmentRefs[]`, `requestedPaxRefs[]`, `groupCode` (ATPCO, `^[0-9A-Z]{2}$`) | `:118-141` |

Dos asimetrías con consecuencias:

1. **El modo `offerId` exige `passengers[]`; el modo `orderId` no.** Lógico —la orden ya los
   conoce— pero significa que el ACL necesita el roster de pax en el carrito, antes de reservar.
2. **`groupCode` solo existe en el modo `orderId`.** Es el filtro por familia ATPCO
   (`BG` equipaje, `SA` asientos…). En el modo pre-booking **no se puede filtrar por grupo**:
   se pide todo y se filtra en casa.

Los 3 requests de la colección usan el modo más pobre de los dos:

```json
{ "request": { "orderId": "{{bookingId}}" }, "requestType": "orderId" }
```

Sin `requestedSegmentRefs`, sin `requestedPaxRefs`, sin `groupCode`. **La colección usa una
fracción del contrato**, igual que en `offers/price` (§2.2).

#### Respuesta — VERIFICADO-SPEC

Raíz `ServiceList` (`:143-161`). **Tres claves, ninguna obligatoria:**

```
{ ancillaries: ServiceListResponse,   // ← NO se llama 'response'
  errors:   Error[],
  warnings: Warning[] }
```

`ServiceListResponse` (`:163-198`) — **obligatorios: `segments`, `passengers`, `offer`,
`serviceDefinitions`**:

| Campo | Cardinalidad | Qué es |
| --- | --- | --- |
| `segments[]` | 1..**100** | itinerario, con `flightLegs[]`, `isChangeOfGauge`, `reservationStatus` (`HK`…) |
| `passengers[]` | 1..**99** | ⚠️ **99**, mientras `offers/price` limita a **9** y `createBooking.selectedOfferItems` a **9** |
| `offer` | 1 (objeto, **no array**) | `offerId` (obligatorio), `sellable` (bool), `otherServices[]` |
| `serviceDefinitions[]` | 0..n | el catálogo del producto |
| `priceDefinitions[]` | 0..n | el precio, **por referencia** |

**`offer` es un objeto único, no una lista.** Toda la respuesta cuelga de una sola oferta —
coherente con que Sabre la persista en el Offer Store (lo dice la doc de la variante airline:
*"The API persists the returned offers temporarily in OfferStore"*).

`OfferItem` (`:221-260`) — **obligatorios `serviceDefinitionRef` y `passengerRefs`; `offerItemId`
NO es obligatorio**:

| Campo | Nota |
| --- | --- |
| `offerItemId` | **opcional en el schema.** El que busca el script de la colección |
| `serviceDefinitionRef` → `serviceDefinitions[]` | **obligatorio** |
| `priceDefinitionRef` → `priceDefinitions[]` | opcional ⇒ **un item puede no tener precio** (es "free-of-charge") |
| `segmentRefs[]` / `passengerRefs[]` | `minItems: 1`; `passengerRefs` obligatorio |
| `paymentType` | `PaymentTypeEnum` — aquí **solo `Instant` \| `Deferred`** (`:873-877`) |
| `paymentRequired` | boolean, default `false` |
| `bundleComponents[]` | bundles: `name` + `bundledItems[]`, cada uno con su `serviceDefinitionRef` y `baggageOfferDetails` |

⚠️ **Que `offerItemId` y `priceDefinitionRef` sean opcionales es una trampa de mapper**: un
ancillary sin `offerItemId` **no se puede reservar** y un item sin `priceDefinitionRef` no tiene
precio. Zod debe distinguir "gratis" de "sin precio" y "no reservable" de "reservable"; hoy no
hay nada en el canónico que lo haga.

`ServiceDefinition` (`:592-658`) — obligatorios `id` y `serviceCode`. Trae `commercialName`
(ej. `"SECOND BAG UPTO50LB 23KG"`), `groupCode`, `subGroup`, `reasonForIssuance`,
`ancillaryBagDescriptionCode` (ej. `"GOLF"`), **`upToWeightLimitInKilograms` /
`…InPounds`** (integers), `maximumQuantity`, `bookingMethod`, `cabinUpgrade`,
`descriptionFreeText[]`, y — muy relevante — **`additionalInputRequirements`** (`:708-744`):

```yaml
pattern: '%FREETEXT%'
variables: [ { key: 'FREETEXT', value: '[A-Z0-9\-/ ]*', description: 'Pick Up Address' } ]
```

⇒ **Hay ancillaries que exigen texto libre del usuario para poder reservarse** (dirección de
recogida, contacto…), con su propia regex de validación y su etiqueta legible. Nuestro
`AncillaryOffer` no tiene dónde poner eso, y sin ello el `add` falla. Ver §6.5.

`BookingMethodEnum` (`:660-668`): `Special Service Request`, `Auxiliary Segment`,
**`Contact Airline`**, **`No Booking Required`**, `Per Service Record`, `Any Allowed`.
⇒ **Hay ancillaries que se muestran pero no se venden por API** (`Contact Airline`). Es el
equivalente funcional de `displayOnlyItems` en asientos, y hay que pintarlos distinto.

`PriceDefinition` (`:509-523`) → `serviceFee` (*"precio final tras markup/descuento"*) y
`baseFee` (*"precio antes de la modificación"*). Cada uno es un `ServiceFee` (`:525-536`) con
`unitPrice` (*"solo si quantity > 1"*) y `totalPrice`, y cada `PriceElement` (`:538-556`) trae
`saleAmount` (con impuestos), `amount` (sin), **`ancillaryRecordAmount`** (*"currency as filed
by airlines"* — o sea **una tercera moneda**) y `taxSummary`.

⇒ **Sabre ya aplica aquí un markup propio** (`serviceFee` vs `baseFee`). Nuestro pricing
waterfall se aplica **encima** de un precio que ya viene modificado. Hay que decidir sobre cuál
de los dos aplicamos el markup de la agencia. Es la misma pregunta que `obFees` (§2.4).

#### Errores — un contenedor MÁS

`Error` (`:339-377`) y `Warning` (`:379-394`), y **no se parecen a ninguno de los otros dos**:

| Producto | Contenedor | Campos |
| --- | --- | --- |
| `offers/price` | **`messages[]`** | `type`, `message`, `service`, `code`, `system`, `additionalDescription` |
| `getseats` v3 | `errors[]` / `warnings[]` | `category`, `type`, `description`, `fieldName`, `fieldPath`, `fieldValue` |
| **`getAncillaries` v2.3** | `errors[]` / `warnings[]` | **`code` (IATA 9321), `descriptionText`, `languageCode`, `ownerName`, `statusText`, `tagText[]`, `typeCode`, `url`** |

**Tres productos, tres contenedores de error incompatibles**, y el de ancillaries usa nombres
IATA puros (`descriptionText`, `ownerName`, `statusText: NotProcessed|Incomplete|Complete|Unknown`)
que no coinciden con ninguno de los otros dos. `tagText[]` es especialmente útil: *"lista los
elementos inválidos de la petición, como URIs relativas a la raíz del documento JSON"*, ej.
`request.order.orderId`. Es lo más parecido a un error de validación accionable que da Sabre.

#### Consumo (se conserva — sigue siendo correcto)

```json
"after": { "travelers": [ { "ancillaries": [ { "offerId": "{{ancillaryOfferItemId}}" } ] } ] }
```

**Un solo identificador.** Precio, subcode y tipo de EMD los resuelve Sabre del lado servidor.
Esto es NDC funcionando como debe — y es exactamente lo contrario del camino ATPCO (§5.6).

#### Lo que sigue sin saberse

El spec **no trae ni un solo ejemplo de respuesta** (a diferencia de `offers/price`, que trae
cinco). No sabemos: el TTL de la oferta de ancillaries (no hay campo de caducidad en
`ServiceList`, a diferencia de `getseats` v3, que sí tiene `offerExpirationDateTime`), ni qué
devuelve un carrier real en `otherServices[]`, ni si `baggageGrid` ya existe en el CERT aunque
no esté en el contrato. **Los fixtures siguen siendo obligatorios** (§8, captura #7).

### 5.3 Camino B — SOAP `GetAncillaryOffersRQ` (ATPCO/LCC) — el único sin contrato

Request ATPCO (`Workflows / 19 - ATPCO - Air search, Ancillaries, Book / GetAncillaryOffersRQ 3.1.0`),
dentro del sobre SOAP que arma el pre-request de colección (`{{header}}` … `{{footer}}`):

```xml
<gao:GetAncillaryOffersRQ version="3.1.0"
    xmlns:gao="http://services.sabre.com/merch/ancillary/offer/v03" …>
  <gao:RequestType>payload</gao:RequestType>
  <gao:RequestMode>booking</gao:RequestMode>
  <gao:QueryByItinerary>
    <gao:QueryPassengerItinerary>
      <gao:Passenger id="pax_1" type="ADT">
        <pax:PersonName><pax:First>John</pax:First><pax:Last>Smith</pax:Last></pax:PersonName>
      </gao:Passenger>
      <gao:PassengerItinerary>
        <gao:PassengerSegment segmentRef="seg_1">
          <itin:FareBreakAssociation FareInfoRef="fare_1"/>
        </gao:PassengerSegment>
      </gao:PassengerItinerary>
    </gao:QueryPassengerItinerary>
    <gao:Segment id="seg_1">
      <itin:FlightDetail id="flight_1">
        <flt:Airline>{{airline_code}}</flt:Airline>
        <flt:FlightNumber>{{flight_number}}</flt:FlightNumber>
        <flt:DepartureAirport>{{from_airport_code}}</flt:DepartureAirport>
        <flt:DepartureDate>{{start_date}}</flt:DepartureDate>
        <flt:DepartureTime>06:15:00</flt:DepartureTime>
        <flt:ArrivalAirport>{{to_airport_code}}</flt:ArrivalAirport>
        <flt:ClassOfService>Y</flt:ClassOfService>
      </itin:FlightDetail>
    </gao:Segment>
    <gao:FareInfo id="fare_1"><FareBasisCode>VLRV2NL</FareBasisCode></gao:FareInfo>
  </gao:QueryByItinerary>
</gao:GetAncillaryOffersRQ>
```

⚠️ **El `FareBasisCode` va hardcodeado en la colección** (`VLRV2NL`, `B0AWZNN1`). En un flujo
real tiene que salir del shop.

> **Nota nueva (spec de asientos):** el mismo problema existe en el carril payload de
> `getseats`, y ahí sí sabemos de dónde sale. `FareComponent` en
> `get-seats-agency-3.0.yml:650-680` declara `fareBasis` como **obligatorio dentro del
> objeto** (junto con `fareComponentId`), pero el array `fareComponents` **es opcional** en
> `SeatAvailabilityByPayloadRq` y la doc dice: *"incluye información no obligatoria (que puede
> influir en el precio de la oferta) como `fareComponents`, `ptc`, `currency` … siempre que
> se conozca"*. ⇒ El fare basis **mejora el precio pero no bloquea la llamada**. Es
> razonable esperar la misma semántica en `GetAncillaryOffersRQ`, pero **eso sí es inferencia
> por analogía**: verificar.

La variante LCC (`Workflows / 20`) añade `<ns9:ClientContext clientType="nSRW"/>`,
`<ns16:OperatingAirline>`, `<ns16:OperatingFlightNumber>`, `<ns16:BookingStatus>PN</…>`, y
**omite** `FareBreakAssociation`/`FareInfo`.

### 5.4 Estructura de la respuesta SOAP (VERIFICADO vía scripts)

Rutas confirmadas por el script `test` de colección (nombres tras strip de namespace):

```
GetAncillaryOffersRS
├── AncillaryDefinition[]           <- catálogo del producto
│   ├── @id, SubCode, Vendor, SpecialService, Group, GroupDescription, Airline
│   ├── CommercialName
│   ├── ElectronicMiscDocType (._)
│   └── ReasonForIssuance (._ y @code)
├── Ancillary[]                     <- solo en la rama LCC
│   ├── @ancillaryId
│   └── @ancillaryDefinitionRef     <- une Offers con AncillaryDefinition
└── Offers[]                        <- el precio
    ├── @offerId
    ├── @ancillaryRef               (ATPCO: vale "ancillary_<id>")
    ├── Segment[].@segmentId
    ├── AncillaryRules.RefundableReissuable   ("Y" = reembolsable)
    └── AncillaryFee
        ├── Base.TotalEquivalentAmount (._ y @currency)   <- rama ATPCO
        └── TotalBaseEquiv.Amount[0]   (._ y @currency)   <- rama LCC
```

**El mismo mensaje se parsea distinto según ATPCO o LCC**: el script bifurca con
`if (pm.environment.get('lcc_tests') !== true)` y los paths del precio son literalmente
distintos. Un mapper único que no contemple ambas ramas devuelve `undefined` en producción
para una de las dos fuentes. **Es una trampa real** (R-4).

### 5.5 Los CUATRO vocabularios de RFIC (VERIFICADO-SPEC — segunda corrección al alza)

La primera pasada dijo *"Sabre expone dos vocabularios"* y lo apoyó en el `switch` del script:

```js
case 'GROUND_TRANSPORT_NON_AIR_SERVICES': → "SURFACE_TRANSPORTATION_NON_AIR_SERVICES";
case 'IN_FLIGHT_SERVICES':                → "INFLIGHT_SERVICES";
```

**Son CUATRO** (la pasada anterior contó tres; el spec de ancillaries recuperado en §0.1
aporta el cuarto), **y los cuatro están en fuentes oficiales:**

| # | Producto | Fuente | El mismo código `B` | El mismo código `G` |
| --- | --- | --- | --- | --- |
| 1 | SOAP `GetAncillaryOffersRS` | script de la colección | `GROUND_TRANSPORT_NON_AIR_SERVICES` | `IN_FLIGHT_SERVICES` |
| 2 | **Booking Management** | `booking-management-v1.yml:8692-8707` | `SURFACE_TRANSPORTATION_NON_AIR_SERVICES` | `INFLIGHT_SERVICES` |
| 3 | **Offer Price NDC** y **Get Seats v3** | `offer-price-ndc-v1.yml:970-984`, `get-seats-agency-3.0.yml:1244-1257` | `Surface Transportation / Non Air Services` | `In-Flight Services` |
| 4 | **Get Ancillaries Agency 2.3** | `get-ancillaries-agency-2.3.yml:676-690` | **`Ground Transportation Non Air Services`** | `In-Flight Services` |

Léase la columna del medio: **cuatro cadenas distintas para el mismo código PADIS `B`.**
El vocabulario 4 vuelve a "Ground Transportation" (como el SOAP) pero en Title Case (como el 3),
y sin la barra. No es una variante de casing: es **otra palabra**. Un `toUpperCase()` con
`replace(/ /g,'_')` mapea el 3 al 2 correctamente y el 4 **no**.

El enum completo de Booking Management (`:8699-8707`): `AIR_TRANSPORTATION`,
`SURFACE_TRANSPORTATION_NON_AIR_SERVICES`, `BAGGAGE`, `FINANCIAL_IMPACT`, `AIRPORT_SERVICES`,
`MERCHANDISE`, `INFLIGHT_SERVICES`, `INDIVIDUAL_AIRLINE_USE`, `UNKNOWN`. Los cuatro
vocabularios representan el mismo codeset **PADIS 4183 – Special Condition**, y el spec de
ancillaries es el único que **documenta las letras** (`:677-679`): `A` Air Transportation,
`B` Ground Transportation Non Air Services, `C` Baggage, `D` Financial Impact,
`E` Airport Services, `F` Merchandise, `G` In-flight Services, `I` Individual Airline Use,
`U` Unknown.

⇒ **Ahí está la clave de traducción que faltaba.** El canónico guarda la **letra PADIS**
(`A`…`U`), no la cadena de ninguno de los cuatro, y cada borde del ACL traduce con su propia
tabla. Sin la letra, la traducción entre vocabularios es una tabla de 4×9 cadenas mantenida a
mano.

**Cuatro APIs de la misma empresa con cuatro serializaciones del mismo codeset IATA. Ese es el
argumento del Anti-Corruption Layer, escrito por Sabre.**

#### Y lo mismo pasa con el nombre del campo de moneda — TRES variantes

| Producto | Campo |
| --- | --- |
| `offers/price` | **`curCode`** (`offer-price-ndc-v1.yml:1197`) |
| `orders/view` (respuesta real guardada) | **`code`** (`slices/responses/01-Add_phone_Orders_View.json`) |
| `getAncillaries` v2.3 | **`currencyCode`** (`get-ancillaries-agency-2.3.yml:844-846`) |

Y el tipo del importe también varía: `offers/price` usa `type: string` con
`pattern: ^-?\d+(\.\d{1,3})?$`; `getAncillaries` usa `type: string, format: number` **sin
patrón** (`:839-843`). Un `Money` compartido entre los tres endpoints devuelve `undefined` en
la moneda de dos de ellos. Ver R-5.

#### `PaymentTypeEnum`: el mismo enum con distinta cardinalidad según el producto

- Get Seats v3 (`get-seats-agency-3.0.yml:1328-1334`): `Instant` | `Deferred` | **`Payment Not Required`**
- Get Ancillaries 2.3 (`:873-877`): `Instant` | `Deferred` — y el tercer estado se modela
  aparte, con el booleano **`OfferItem.paymentRequired`** (`:252-255`).

Dos modelados distintos del mismo hecho. Nuestro `paymentTiming` tiene que normalizar los dos
a un solo tri-estado, no copiar ninguno.

#### Tipo de EMD — PREGUNTA CERRADA

La primera pasada decía *"`EMD-A` (associated) vs `EMD-S` (standalone). `[INFERIDO los
valores exactos]`"*. Los valores exactos existen y **no son ni EMD-A ni EMD-S**:

| Producto | Spec | Valores |
| --- | --- | --- |
| Booking Management | `booking-management-v1.yml:8717-8727` | `STANDALONE`, `FLIGHT_COUPON_ASSOCIATED`, `STANDALONE_TICKET_ASSOCIATED`, `OTHER_THAN_EMD`, `ETICKET` |
| Get Seats v3 | `get-seats-agency-3.0.yml:1226-1235` | `Standalone`, `Flight Coupon Associated`, `Standalone Ticket Associated`, `Other Than Emd`, `Eticket` |

**Cinco valores, no dos.** `FLIGHT_COUPON_ASSOCIATED` es el EMD-A clásico; `STANDALONE` el
EMD-S; pero `STANDALONE_TICKET_ASSOCIATED`, `OTHER_THAN_EMD` y `ETICKET` no tienen
equivalente en la dicotomía que asumimos. Un enum canónico de dos valores pierde información
que hace falta para el reembolso.

Y otra vez: **el mismo enum, dos serializaciones** (SCREAMING_SNAKE vs Title Case).

#### Otros enums que ahora tenemos (Get Seats v3, aplican a cualquier ancillary)

- `RefundableReissuableIndicatorEnum` (`:1236-1243`): `Yes` | `No` | **`Reuse`** (re-emitible).
  Tres estados, no un booleano. Nuestro `AncillaryOffer.refundable: boolean` pierde `Reuse`.
- `SectorPortionEnum` (`:1259-1266`): `Sector` (un segmento) | `Portion` (varios) | `Journey`.
  **Determina cuántas veces se cobra el ancillary.**
- `FeeApplicationMethodEnum` (`:1267-1281`): `One Way`, `Round Trip`, `Item`, `Travel`,
  `Ticket`, `Per 1kg Over Free Baggage Allowance`, `Per 5kg Over Free Baggage Allowance`,
  `Percentage 0.5 Of Fare Per Kg`, `Percentage 1 Of Fare Per Kg`, `Percentage 1.5 Of Fare Per Kg`.
  ⇒ **Hay ancillaries cuyo precio es un porcentaje de la tarifa por kilo.** Un modelo de
  precio fijo por ancillary no los representa.
- `PaymentTypeEnum` (`:1328-1334`): `Instant` | `Deferred` | `Payment Not Required`.
  **Hay ancillaries que no se pagan en el momento.**
- `AncillarySourceEnum` (`booking-management-v1.yml:8709-8716`): `ATPCO` | `MERCHANDISING_MANAGER`.

### 5.6 Consumo ATPCO — createBooking materializado (VERIFICADO-SPEC)

Colección (`Workflows / 19 … / 3. CreateBooking - with ancillaries`):

```json
"ancillaries": [ {
  "reasonForIssuance": "{{ancillaryReasonForIssuance}}",
  "subcode": "{{ancillarySubCode}}",
  "airlineCode": "{{airline_code}}",
  "electronicMiscellaneousDocumentType": "{{ancillaryElectronicMiscDocType}}",
  "basePrice": "{{ancillaryBasePrice}}",
  "currencyCode": "{{ancillaryCurrencyCode}}",
  "groupCode": "{{ancillaryGroup}}",
  "flightIndices": [ 1 ]
} ]
```

VERIFICADO-SPEC contra `booking-management-v1.yml:7042-7100` (`BookAncillary`).
**Obligatorios: `subcode`, `airlineCode`, `electronicMiscellaneousDocumentType`, `basePrice`,
`currencyCode`, `groupCode`, `flightIndices`.** Detalles nuevos:

- `subcode` patrón `^[A-Z0-9]{3}$`, ej. `05Z`. El spec lo llama **`RFISC`** y enlaza el
  catálogo público de ATPCO.
- `basePrice` y `totalPrice` son **strings** con patrón `^[0-9]+(\.[0-9]{1,3})?$` —
  **hasta 3 decimales**, igual que en offers/price.
- `vendorCode` y `source` son **mutuamente excluyentes** (`:7085-7092`). El spec lo dice en
  ambos campos. La colección manda `vendorCode` en LCC; si además mandamos `source`, falla.
- `reasonForIssuance` es opcional en el schema, pero el error
  `UNABLE_TO_ADD_ANCILLARY_INVALID_SUBCODE` dice *"Verify reason for issuance sub-code.
  Selected sub-code doesn't match ancillary offer details"* ⇒ en la práctica se valida contra
  la oferta.

**Y la confirmación del riesgo:** existe un error dedicado
`UNABLE_TO_ADD_ANCILLARY_PRICE_MISMATCH` / `BAD_REQUEST` / *"Verify ancillary fee and/or
flight assignation. Ancillary price doesn't match Air Extras field in the reservation"*
(`help/…/help-documentation-create-booking-error-list.txt:543-547`).

⇒ **El riesgo de "el cliente transporta el precio" (R-5) no es teórico: Sabre tiene un código
de error específico para él.** Sube de MEDIO a ALTO.

Otros errores oficiales de ancillary:

| Código | Categoría | Significado |
| --- | --- | --- |
| `UNABLE_TO_ADD_ANCILLARY_PRICE_MISMATCH` | `BAD_REQUEST` | el precio que mandamos no coincide |
| `UNABLE_TO_ADD_ANCILLARY_INVALID_SUBCODE` | `BAD_REQUEST` | subcode que no casa con la oferta |
| `UNABLE_TO_ADD_ANCILLARY_INVALID_VENDOR_CODE` | `BAD_REQUEST` | vendor ausente o incorrecto |
| `UNABLE_TO_ADD_ANCILLARY_INFANT_NOT_ALLOWED` | `BAD_REQUEST` | *"los ancillaries no pueden asignarse a infantes"* |
| `UNABLE_TO_MODIFY_BOOKING_INVALID_ANCILLARY_ASSOCIATION` | `BAD_REQUEST` | *"solo pueden vincularse a viajeros incluidos en contenido aéreo"* |
| `ANCILLARY_NOT_FOUND` (en fulfill) | `INVALID_DATA` | el item no existe en la reserva |

LCC añade además `flightApplicabilityType: "Single"`, `specialServiceIndex`,
`commercialName`, `vendorCode`, y un bloque hermano
`specialServices: [{ code: "{{ancillarySpecialService}}" }]`.

### 5.7 Qué significa cada variable (y por qué existe el EMD)

| Variable | Origen | Para qué sirve |
| --- | --- | --- |
| `ancillaryId` | `AncillaryDefinition.@id` | id del servicio en la respuesta. Va a `fulfillFlightTickets.fulfillments[].ancillaryIds[]` |
| `ancillarySubCode` | `AncillaryDefinition.SubCode` | **RFISC ATPCO** (equipaje, comida, mascota, upgrade…) |
| `ancillaryGroup` | `AncillaryDefinition.Group` | familia del subcode. `SA` = asientos, verificado en `serviceDefinitions[].groupCode: "SA"` del ejemplo oficial de getseats |
| `ancillaryElectronicMiscDocType` | `AncillaryDefinition.ElectronicMiscDocType` | tipo de EMD — 5 valores, §5.5 |
| `ancillaryReasonForIssuance` | `AncillaryDefinition.ReasonForIssuance` | **RFIC** (PADIS 4183), obligatorio por IATA |
| `ancillaryVendor`, `ancillarySpecialService`, `ancillaryCommercialName` | idem | solo en el camino **LCC** |
| `ancillaryBasePrice`, `ancillaryCurrencyCode`, `ancillarySubtotal`, `ancillaryTaxes`, `ancillaryTotal` | `Offers[].AncillaryFee…` | el precio, que en ATPCO/LCC **lo transportamos nosotros** |

**Qué es el EMD.** Un *Electronic Miscellaneous Document* es el documento fiscal de un
servicio auxiliar: el equivalente al billete electrónico, pero para el equipaje extra o el
asiento premium. Se emite, se cobra, se puede void y se puede reembolsar **por separado** del
billete. Por eso `reasonForIssuance` es obligatorio: es lo que la aerolínea reporta en la
liquidación BSP.

### 5.8 Ciclo de vida completo del EMD (VERIFICADO)

1. **Cotizar**: `GetAncillaryOffersRQ` (ATPCO/LCC) o `/v2/offers/getAncillaries` (NDC) —
   o directamente `offers/price` con `offerItems[].type === "Service"` (§5.1).
2. **Reservar**: `createBooking` con `travelers[].ancillaries[]`, o `modifyBooking`
   `before`/`after` sobre reserva existente.
3. **Leer lo reservado**: `getBooking` → `travelers[].ancillaries[]` con `itemId`,
   `commercialName`, `numberOfItems`, `reasonForIssuanceCode`, `source`, `isRefundable`,
   `isCommissionable`, `flightApplicabilityType`, `statusCode`, `statusName`.
4. **Emitir**: `fulfillFlightTickets` con un fulfillment **separado**:
   ```json
   "fulfillments": [
     { "ticketingQualifiers": { "priceQuoteRecordIds": ["1"] }, "payment": { "primaryFormOfPayment": 1 } },
     { "ancillaryIds": [ "{{ancillaryId}}" ],                    "payment": { "primaryFormOfPayment": 1 } }
   ]
   ```
   ⇒ **El EMD se emite en un fulfillment distinto del billete.**
5. **Verificar**: `getBooking` → `flightTickets[]`. **`ticketStatusCode === "ME"` es un EMD;
   `"TE"` es un billete de vuelo** (VERIFICADO — script de WF-26).
6. **Reembolsar**: `refundFlightTickets` con `documentsType: "EMDs"` y la lista de números.
   Solo son reembolsables los que traen `AncillaryRules.RefundableReissuable === "Y"` en la
   respuesta SOAP — y con Get Seats v3 sabemos que el tercer estado posible es `Reuse` (§5.5).

### 5.9 Camino D — `Manage Ancillary 1.1` (producto NUEVO en este análisis)

**No aparece en ninguno de los 1.077 requests de la colección.** Se descubrió por el enlace de
la página oficial de ancillaries (§0.1), y es relevante porque cambia dos conclusiones previas.

`manage-ancillary-1.1.yml`, `basePath` **`/v1/ancillaries`** (`:15-16`), tres rutas:

| Ruta | Descripción del spec | Línea |
| --- | --- | --- |
| `POST /add` | *"Creates **pre-reserved seats** and associated ancillaries and/or other ancillaries in a **PNR-based reservation**"* | `:26-28` |
| `POST /remove` | quita asientos y/o ancillaries de la reserva | `:63` |
| `POST /exchange` | **intercambia asientos** ya pre-reservados | `:98` |

Contratos (VERIFICADO-SPEC):

| Schema | Obligatorio | Campos | Línea |
| --- | --- | --- | --- |
| `AddAncillariesRequest` | `pnrLocator` | `seats[]`, `ancillaries[]` (ambos `minItems: 1`, `uniqueItems: true`) | `:1237-1259` |
| `AddAncillary` | **`offerItemId`**, **`passengerRef`** | `numberOfItems` (default 1), `productText` (ej. `'A/0BV/STANDBY'`), `productTextDetails[]` | `:1299-1327` |
| `AddSeat` | *(ninguno)* | `offerItemId`, `passengerRef`, `row` **integer**, `column` string | `:1328-1345` |
| `ExchangeSeat` | *(ninguno)* | `seatId` + `offerItemId` + `passengerRef` + `row`/`column` | `:1346-1366` |
| `SeatId` / `AncillaryId` | — | **integer**, *"obtenido de la respuesta de la Retrieve Itinerary API"* | `:1367-1373` |

**Las tres cosas que esto cambia:**

1. **`AddAncillary` acepta un `offerItemId` opaco.** No pide subcode, ni precio, ni moneda, ni
   grupo, ni tipo de EMD — al contrario que `createBooking.travelers[].ancillaries[]`, que exige
   siete campos materializados (§5.6). ⇒ **Si el carril PNR se puede servir con `/v1/ancillaries/add`,
   el riesgo R-3 (`UNABLE_TO_ADD_ANCILLARY_PRICE_MISMATCH`) deja de aplicar al camino
   principal**, porque el precio ya no viaja por el cliente. Es la mejora de riesgo más grande
   de esta pasada.
2. **Asigna asientos sobre PNR por REST**, lo que matiza la afirmación de §4.6 de que hace falta
   `PassengerDetailsRQ` (SOAP stateful). Ver la corrección allí y R-17.
3. **Introduce un tipo de id que no teníamos: `SeatId`/`AncillaryId` son *integers*** y salen de
   la **Retrieve Itinerary API (SOAP)**, no de `getseats` ni de `getBooking`. Para `remove` y
   `exchange` hacen falta esos enteros, así que **el carril PNR sigue teniendo una dependencia
   SOAP**, solo que en la lectura y no en la escritura.

**Lo que NO sabemos y hay que verificar antes de apoyarse en esto:**

- Si el `offerItemId` que acepta `/add` es el de `getAncillaries` v2.3, el de `getseats` v3, o
  el del SOAP `GetAncillaryOffersRS`. El spec dice *"The offer item ID of the ancillary"* y no
  lo ata a ningún productor. `[Bloqueante — captura #13.]`
- Si nuestro PCC de agencia tiene el producto habilitado. La página que lo enlaza es la de
  **airline**; el producto no declara `targetAudience` accesible sin login.
- Si funciona para NDC o solo para PNR. La descripción dice *"PNR-based reservation"* de forma
  consistente en las tres rutas, así que **[INFERIDO: es carril PNR/ATPCO, no NDC]**. Para NDC
  ya tenemos `orders/change` y `modifyBooking`, que sí están en la colección.

---

## 6. Comparación con lo que ya tenemos (LATAM NDC)

### 6.1 Equivalencias

| Concepto | LATAM NDC (implementado) | Sabre |
| --- | --- | --- |
| Revalidar precio | `IATA_OfferPriceRQ` — `providers/latam-ndc/src/offerprice/request.builder.ts` | `POST /v1/offers/price` |
| Servicios auxiliares | `IATA_ServiceListRQ` — `providers/latam-ndc/src/servicelist/request.builder.ts` | cuatro caminos (§5.1): `/v2/offers/getAncillaries` (NDC), `GetAncillaryOffersRQ` (ATPCO/LCC), `offerItems[].type === "Service"` en price, y `/v1/ancillaries/*` (PNR) |
| Reservar un ancillary | dentro de `OrderCreate` | tres formas incompatibles: `modifyBooking` (id), `createBooking` (materializado), `/v1/ancillaries/add` (id) |
| Mapa de asientos | **no existe** | `/v3/offers/getseats/by*` (o `/v1/offers/getseats`) |
| Estructura "a la carta" | `ALaCarteOffer.ALaCarteOfferItem` (`servicelist/response.mapper.ts`) | v1: `response.aLaCarteOffer.aLaCarteOfferItems` — **mismo modelo IATA**. v3: **ya no**, se aplana a `offerItems[]` |

**Hallazgo de la primera pasada, matizado.** Era cierto que el `aLaCarteOffer` de `getseats`
v1 y el `ALaCarteOffer` de `IATA_ServiceListRS` de LATAM son la misma estructura IATA NDC en
distinto casing, y que un solo modelo canónico las cubría. **Pero Get Seats v3 abandona esa
forma** y la sustituye por referencias planas (`offerItems[] → serviceDefinitionRef /
priceDefinitionRef`). Si implementamos v3 (§4.1), el modelo canónico tiene que ser el
**denominador común**: item vendible + refs a pax/segmento + precio resuelto. No podemos
copiar la forma IATA cruda de LATAM.

### 6.2 Qué cubre `OfferPricePort` hoy

`packages/domain/src/ports/offer-price.port.ts`:

```ts
export interface OfferPriceResult { offer: Offer; priceChanged: boolean; warnings: string[]; }
export interface OfferPricePort {
  priceOffer(offer: Offer, criteria: FlightSearchCriteria, ctx: SearchContext): Promise<OfferPriceResult>;
}
```

| Necesidad Sabre | ¿Cubierto? |
| --- | --- |
| Revalidar por `offerItemId` | ✅ vía `offer.provider.offerRef` (con el hack del pipe) |
| Devolver precio nuevo y `priceChanged` | ✅ |
| **Pasar forma de pago (BIN/subCode/cardType)** | ❌ no hay dónde ponerlo |
| **Devolver los IDs nuevos (`priceOfferId`, `priceOfferItemId[]`, `passengerIds[]`)** | ⚠️ solo el offerId, embutido en el string |
| **Devolver `obFees[]` desglosados** | ❌ |
| **Devolver `ttl` / `offerExpirationDateTime` del proveedor** | ❌ — y ahora sabemos que **siempre vienen** |
| **Distinguir `source` (ATPCO/LCC/NDC)** | ❌ |
| **Propagar `messages[]` de tipo WARNING** (p. ej. "precio puede subir sin FOP") | ⚠️ hay `warnings: string[]`, pero sin código ni severidad |
| **Manejar totales NEGATIVOS (reemisión)** | ❌ `MoneySchema` hay que revisarlo |

### 6.3 Cambio propuesto a `OfferPricePort`

```ts
/** Datos de tarjeta NO sensibles necesarios para calcular fees por forma de pago. */
export interface FormOfPaymentHint {
  /** 6 a 8 primeros dígitos (Sabre: ^[0-9]{6,8}$). NUNCA loggear. NUNCA persistir. */
  binNumber: string;
  /** Marca: 'MC' | 'VI' | 'AX' | … (2 letras). */
  cardType?: string;
  /**
   * Subcódigo IATA del medio de pago. Sabre lo exige dentro del objeto FOP.
   * 'FDA' = cualquier débito, 'FCA' = cualquier crédito, 'CA' efectivo, 'CK' cheque.
   * OJO: la colección usa 'FDA' (débito) como default. NO copiarlo a ciegas.
   */
  subCode: string;
}

export interface OfferPriceRequest {
  offer: Offer;
  criteria: FlightSearchCriteria;
  /** Sabre acepta como máximo 1 (params.formOfPayment maxItems: 1). */
  formOfPayment?: FormOfPaymentHint;
}

/** Fee por forma de pago, desglosado como lo devuelve el proveedor. */
export interface FormOfPaymentFee {
  amount: Money;
  /** true si el proveedor confirma que NO hay cargo (Sabre: obFees[].surcharge.noCharge). */
  noCharge: boolean;
  /** Cuando el proveedor solo da un techo (Sabre: maximumAmount). */
  isMaximumEstimate: boolean;
  description?: string;
  /** A qué pax / items aplica, si el proveedor lo atribuye. */
  paxIds?: string[];
}

export interface OfferPriceResult {
  offer: Offer;               // con expiresAt tomado de offerExpirationDateTime del proveedor
  priceChanged: boolean;
  /** TTL declarado por el proveedor, en segundos. Sabre siempre lo manda. */
  ttlSeconds?: number;
  /** Límite para convertir la oferta en orden, si el proveedor lo declara. */
  priceGuaranteeUntil?: string;
  fees?: FormOfPaymentFee[];
  /** true si el proveedor avisó de que el precio puede variar según la tarjeta. */
  priceDependsOnFormOfPayment: boolean;
  /** Mensajes tipados, no strings sueltos: Sabre manda {type, code, service, message}. */
  warnings: ProviderMessage[];
}

export interface ProviderMessage {
  severity: 'INFO' | 'WARNING' | 'ERROR';
  code?: string;
  message: string;
  source?: string;
}

export interface OfferPricePort {
  priceOffer(request: OfferPriceRequest, ctx: SearchContext): Promise<OfferPriceResult>;
}
```

> Cambio incompatible con la firma actual.
> `providers/latam-ndc/src/latam-flight-search.adapter.ts` y
> `apps/api/src/search/search.service.ts` hay que tocarlos. Refactor acotado (2 llamadores).

### 6.4 Port nuevo: `SeatMapPort` (conservado y afinado con el spec v3)

```ts
// packages/domain/src/ports/seat-map.port.ts

/** Espeja las rutas reales de Get Seats v3 (agency): byNdcOfferId, byNdcOrderId, byReservationPayload. */
export type SeatMapQuery =
  | { kind: 'offer';  offer: Offer; passengers: SeatMapPaxQuery[] }
  | { kind: 'order';  orderId: string }
  | { kind: 'flight'; segments: SeatMapSegmentQuery[]; passengers: SeatMapPaxQuery[];
      currency?: string; fareComponents?: SeatMapFareComponent[]; checkinMode?: boolean };

export interface SeatMapSegmentQuery {
  segmentId: string;
  origin: string; destination: string;
  departureDate: string;              // YYYY-MM-DD
  carrierCode: string; flightNumber: string;
  bookingClass: string;
  cabin: CabinClass;
}

/** Opcional, pero mejora el precio: Sabre lo llama fareComponents. */
export interface SeatMapFareComponent {
  fareComponentId: string;
  fareBasis: string;
  segmentIds: string[];
  brandCode?: string;
  governingCarrier?: string;
}

export interface SeatMapPaxQuery {
  paxId: string; paxType: PaxType;
  accompaniedByInfant?: boolean;
  loyaltyAccounts?: { programCode: string; accountNumber: string }[];
}

/** Un asiento del mapa. `sellable` distingue OfferItem de DisplayOnlyItem. */
export interface SeatOption {
  row: string;                         // Sabre v3 lo manda como integer; normalizamos a string
  column: string;
  segmentId: string;
  /** Id que hay que devolver al reservar. Ausente si el asiento NO es vendible. */
  offerItemId?: string;
  /** false ⇒ se pinta pero no se puede comprar (v3: displayOnlyItems). */
  sellable: boolean;
  /** Motivo cuando sellable === false: 'UNAVAILABLE' | 'UNABLE_TO_BOOK' | 'RESTRICTED' | 'UNKNOWN'. */
  notSellableReason?: SeatNotSellableReason;
  eligiblePaxIds: string[];
  price?: Money;                       // undefined o 0 => asiento gratuito
  available: boolean;                  // occupationStatusCode === 'F'
  /** Hueco de layout (PADIS 9865 'Q' = No seat here). No es un asiento ocupado. */
  isGap: boolean;
  /** Normalizadas desde PADIS 9825. */
  characteristics: SeatCharacteristic[];
  /** Códigos PADIS crudos. Se conservan: el catálogo normalizado nunca es completo. */
  rawCharacteristicCodes: string[];
}

export interface SeatMapResult {
  /** El mapa completo también caduca (v3: response.offerExpirationDateTime). */
  expiresAt?: string;
  maps: {
    segmentId: string;
    cabins: {
      code: string; name?: string;
      /** Para dibujar el fuselaje: posiciones de ala, salidas, filas ausentes. */
      layout?: { columns: { id: string; position: string[] }[];
                 firstRow: number; lastRow: number;
                 exitRows?: { firstRow: number; lastRow: number }[];
                 wingRows?: { firstRow: number; lastRow: number }[];
                 missingRows?: number[]; missingSeats?: string[] };
      seats: SeatOption[];
    }[];
  }[];
  warnings: ProviderMessage[];
}

/** Selección del vendedor, lista para createBooking / orderChange. */
export interface SeatSelection {
  segmentId: string; paxId: string; row: string; column: string; offerItemId: string;
}

export interface SeatMapPort {
  getSeatMap(query: SeatMapQuery, ctx: SearchContext): Promise<SeatMapResult>;
}

export const SEAT_MAP_PORT = 'SEAT_MAP_PORT';
```

**Reglas de negocio en el dominio, no en el ACL** (aplican a cualquier proveedor): las siete
filas de la tabla de §4.4, más `sellable === true` y `available === true`.

### 6.5 Port nuevo: `AncillaryPort` (conservado y afinado con el spec)

```ts
// packages/domain/src/ports/ancillary.port.ts

/**
 * Espeja el discriminador real de Get Ancillaries 2.3 (get-ancillaries-agency-2.3.yml:66-70).
 * El modo 'offer' EXIGE passengers[] (:100); el modo 'order' no, pero es el único que
 * admite groupCode (:139-141).
 */
export type AncillaryQuery =
  | { kind: 'offer'; offer: Offer; passengers: { paxId: string; paxType: PaxType }[];
      segmentIds?: string[] }
  | { kind: 'order'; orderId: string;
      segmentIds?: string[]; paxIds?: string[]; groupCode?: string };

/**
 * Un servicio auxiliar cotizado. `providerPayload` existe porque hay proveedores
 * (Sabre ATPCO/LCC) que NO aceptan un id opaco al reservar: exigen que el cliente
 * devuelva subcode, precio, moneda, grupo y tipo de EMD. Es OPACO para el dominio.
 */
export interface AncillaryOffer {
  id: string;
  /**
   * Id único a devolver al reservar. OPCIONAL EN EL CONTRATO de Sabre
   * (get-ancillaries-agency-2.3.yml:228-230): un item SIN offerItemId NO es reservable.
   * El dominio debe tratar su ausencia como "solo informativo", no como bug del mapper.
   */
  offerItemId?: string;
  name: string;                        // CommercialName
  category: AncillaryCategory;         // 'BAGGAGE' | 'MEAL' | 'SEAT' | 'LOUNGE' | 'PET' | 'OTHER'
  /** RFISC/subcódigo ATPCO crudo. Es el vocabulario de la industria: se conserva. */
  subCode?: string;
  /**
   * undefined => el proveedor no dio precio (priceDefinitionRef ausente).
   * Money con importe 0 => gratuito. NO son lo mismo y no deben colapsarse.
   */
  price?: Money;
  /** Precio antes del markup del propio Sabre (2.3: baseFee vs serviceFee). Decide sobre
   *  cuál aplicamos el pricing waterfall de la agencia. Ver §10. */
  providerBasePrice?: Money;
  /**
   * Cómo se reserva. `CONTACT_AIRLINE` y `NO_BOOKING_REQUIRED` NO son vendibles por API
   * (2.3 BookingMethodEnum, :660-668). Es el equivalente de displayOnlyItems en asientos.
   */
  bookingMethod?: 'SSR' | 'AUXILIARY_SEGMENT' | 'CONTACT_AIRLINE' | 'NO_BOOKING_REQUIRED'
                | 'PER_SERVICE_RECORD' | 'ANY_ALLOWED';
  /**
   * Input adicional que el usuario debe teclear para poder reservar (dirección de recogida,
   * teléfono…). Sabre lo da como patrón + variables con regex y etiqueta legible
   * (2.3 AdditionalInputRequirements, :708-744). Sin esto, el add falla.
   */
  requiredInputs?: { key: string; label?: string; pattern: string }[];
  /** Tope de unidades que permite la aerolínea (2.3 maximumQuantity, :639-642). */
  maxQuantity?: number;
  /** Límite de peso declarado, cuando es equipaje (2.3 :625-632). Sabre da KG y LB por separado. */
  weightLimit?: { kilograms?: number; pounds?: number };
  /** Tres estados, no un booleano: Sabre v3 admite Yes | No | Reuse. */
  refundability: 'REFUNDABLE' | 'NON_REFUNDABLE' | 'REUSABLE' | 'UNKNOWN';
  /** Cuántas veces se cobra: por segmento, por tramo o por viaje. */
  applicability?: 'SECTOR' | 'PORTION' | 'JOURNEY';
  /** Método de cálculo: hay ancillaries que son % de la tarifa por kg. */
  feeMethod?: string;
  /** 'INSTANT' | 'DEFERRED' | 'NOT_REQUIRED'. */
  paymentTiming?: string;
  eligiblePaxIds: string[];
  segmentIds: string[];
  /** Caducidad del propio item (v3: purchaseByDateTime). */
  purchaseBy?: string;
  emd?: {
    /**
     * LETRA PADIS 4183 ('A'|'B'|'C'|'D'|'E'|'F'|'G'|'I'|'U'), NO la cadena de ningún
     * proveedor: Sabre publica CUATRO serializaciones distintas del mismo codeset (§5.5).
     * Las letras están documentadas en get-ancillaries-agency-2.3.yml:677-679.
     */
    reasonForIssuance: PadisSpecialCondition;
    /** 5 valores, no 2: STANDALONE | FLIGHT_COUPON_ASSOCIATED | STANDALONE_TICKET_ASSOCIATED | OTHER_THAN_EMD | ETICKET. */
    documentType: EmdDocumentType;
    groupCode?: string;
  };
  /** Payload crudo requerido para reservar en proveedores no-NDC. NO se expone al cliente. */
  providerPayload?: Record<string, unknown>;
}

export interface AncillaryListResult {
  ancillaries: AncillaryOffer[];
  /** Id de la oferta contenedora. En Sabre 2.3 la respuesta cuelga de UNA sola oferta
   *  (`ancillaries.offer.offerId`, :200-210), no de una lista. */
  offerId?: string;
  /** `ancillaries.offer.sellable` (:211-214). false => nada de esta oferta es vendible. */
  sellable?: boolean;
  warnings: ProviderMessage[];
}

export interface AncillaryPort {
  listAncillaries(query: AncillaryQuery, ctx: SearchContext): Promise<AncillaryListResult>;
}

export const ANCILLARY_PORT = 'ANCILLARY_PORT';
```

> **Nota de alcance, ahora que tenemos el contrato.** El `AncillaryPort` de arriba modela
> **cotización**, no reserva. La reserva tiene tres formas incompatibles según el carril
> (`modifyBooking` con un id, `createBooking` materializado, `/v1/ancillaries/add` con un id) y
> **no debe colapsarse en este port**: pertenece al port de órdenes. Diseñar un
> `bookAncillary()` genérico ahora, sin haber medido el carril D en el CERT (§5.9), es
> exactamente el tipo de abstracción prematura que luego hay que deshacer.

> **Deuda que hay que pagar de paso:** hoy `ServiceListRequest` / `ServiceItem` /
> `ServiceListResult` viven dentro de `packages/domain/src/ports/order-manage.port.ts`
> (líneas 34-55, verificado) y `OrderManagePort.listServices()` mezcla gestión de orden con
> catálogo de servicios. Al crear `AncillaryPort` conviene **mover esos tipos** y dejar
> `OrderManagePort` solo con retrieve/cancel/pay/reshop.
>
> Nótese además que `ServiceItem.price` es `{ amount: number; currency: string }` — un
> **`number`**. Con precios de 3 decimales y totales negativos (§2.5), eso hay que revisarlo.

---

## 7. Impacto en `apps/api/src/search/search.service.ts::priceOffer`

### 7.1 Estado actual (verificado hoy contra el repo)

`apps/api/src/search/search.service.ts:109-122`:

```ts
async priceOffer(
  offer: Offer,
  criteria: FlightSearchCriteria,
  tenantId: string,
): Promise<OfferPriceResult> {
  const adapter = await this.latam.forTenant(tenantId);
  const result = await adapter.priceOffer(offer, criteria, { tenantId });
  const [priced] = await this.withPricing([result.offer], tenantId, 'flights');
  return { ...result, offer: priced ?? result.offer };
}
```

**El hallazgo se mantiene íntegro.** Problemas, en orden de gravedad:

1. **Está clavado a LATAM.** `this.latam.forTenant(tenantId)` ignora `offer.provider.name`.
   Una oferta de Sabre se manda a LATAM; y en modo mock, `LatamNdcFlightSearchAdapter` cae a
   fixtures cuando faltan credenciales, o sea que **devuelve un precio inventado sin avisar**.
2. **No hay dónde pasar la forma de pago.** Con Sabre eso significa: o revalidamos sin FOP y
   nos comemos el warning de subida de precio (§2.4), o no podemos revalidar bien.
3. **No pasa por el circuit breaker.** `searchFlights()` sí usa `this.breaker.execute(...)`;
   `priceOffer()` no. Un proveedor caído hace esperar el timeout completo **justo en el paso
   más sensible**. Y ahora sabemos que Sabre devuelve **429 por concurrencia** (§2.7): sin
   breaker, un pico de revalidaciones agota el pool de tokens del PCC.
4. **No pasa por telemetría ni cuota.** `searchFlights()` llama a `assertWithinQuota` +
   `instrument`; `priceOffer()` no. Los proveedores cobran por revalidación igual que por
   búsqueda.
5. **No hay `simulated`.** `searchFlights()` devuelve `{ offers, simulated }` justamente para
   no pasarle precios falsos a un cliente. `priceOffer()` no. Un tenant sin credenciales
   revalida contra fixtures **en silencio, en el último paso antes de reservar**. Es la misma
   clase de bug que ya arreglamos en búsqueda.
6. **No propaga el TTL del proveedor.** Ahora que sabemos que Sabre siempre manda `ttl` y
   `offerExpirationDateTime` (§3.3), descartarlos es tirar la única información que permite
   decidir si hay que re-price antes de reservar.

Nota a favor de lo que ya está: `withPricing` **sí** se aplica en `priceOffer` (líneas
117-121, con un comentario que explica el porqué). Eso ya se arregló y no hay que tocarlo.

### 7.2 Cambio propuesto

**Paso 1 — registry de proveedores.** Hoy `fanOut()` recibe un array construido a mano dentro
de `searchFlights`. Hace falta un `ProviderRegistry` que, dado `tenantId` y `providerCode`,
devuelva el adapter:

```ts
// apps/api/src/providers/provider-registry.service.ts  (nuevo)
@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly latam: LatamNdcProviderFactory,
    private readonly sabre: SabreProviderFactory,   // futuro
  ) {}

  async flightAdapterFor(tenantId: string, providerCode: string): Promise<FlightProviderAdapter> {
    switch (providerCode) {
      case 'latam-ndc': return this.latam.forTenant(tenantId);
      case 'sabre':     return this.sabre.forTenant(tenantId);
      default: throw new UnknownProviderError(providerCode);   // clase tipada
    }
  }

  async enabledFlightAdapters(tenantId: string): Promise<{ code: string; adapter: FlightProviderAdapter }[]> { … }
}
```

**Paso 2 — `priceOffer` enruta por la oferta y hereda las defensas de `searchFlights`:**

```ts
async priceOffer(
  offer: Offer,
  criteria: FlightSearchCriteria,
  tenantId: string,
  formOfPayment?: FormOfPaymentHint,
): Promise<OfferPriceResult & { simulated: boolean }> {
  await this.telemetry.assertWithinQuota(tenantId);

  // La oferta declara de dónde vino. Revalidar contra OTRO proveedor no tiene sentido:
  // los offerItemId son opacos y efímeros por proveedor.
  const providerCode = offer.provider.name;
  const adapter = await this.registry.flightAdapterFor(tenantId, providerCode);

  const result = await this.telemetry.instrument(
    { tenantId, vertical: 'flights', providerCode, criteria: { /* ruta y fechas, NUNCA pax ni BIN */ } },
    () => this.breaker.execute(providerCode,
            () => adapter.priceOffer({ offer, criteria, formOfPayment }, { tenantId })),
    () => 1,
    () => adapter.isMock,
  );

  const [priced] = await this.withPricing([result.offer], tenantId, 'flights');
  return { ...result, offer: priced ?? result.offer, simulated: adapter.isMock };
}
```

**Paso 3 — el controller** (`apps/api/src/search/search.controller.ts:72`) acepta
`formOfPayment` opcional en el body, validado con Zod, y **no lo loggea ni lo mete en la clave
de cache**.

**Paso 4 — `Offer.provider.name` tiene que ser confiable.** Hoy es `z.string()` libre. Si un
cliente manda una oferta con `provider.name` arbitrario, el registry tira
`UnknownProviderError` — correcto. Pero conviene además **firmar la oferta** (HMAC de
`provider.raw` + `expiresAt` con clave del servidor) para que un cliente no pueda alterar el
`offerRef` y reservar algo distinto de lo cotizado. **Decisión pendiente** (§10).

**Paso 5 — el pricing waterfall y el fee de forma de pago.** Con `obFees` desglosados (§2.4)
ya es posible decidir sobre qué base aplicar el markup. Sigue siendo **decisión de negocio**
(§10), pero ya no es un impedimento técnico.

**Paso 6 — nada de esto sirve sin un adapter de Sabre.** Orden razonable:
(a) capturar respuestas del CERT → (b) fixtures → (c) `providers/sabre/` siguiendo la
estructura de `providers/latam-ndc/` → (d) registry → (e) refactor de `priceOffer`.

---

## 8. Checklist de captura en el sandbox CERT

La primera pasada listaba 12 capturas; los specs cerraron 5 y esta pasada cerró 2 más
(la estructura de `getAncillaries` y la existencia de `requestType: "offerId"`). Pero también
**abrió 2 nuevas** —el carril `Manage Ancillary` y el techo de pax— y **agravó la #7**, que ya
no pregunta "qué forma tiene" sino "**sirve para algo**". Endpoint
`https://api.cert.platform.sabre.com`; guardar cada respuesta cruda en
`providers/sabre/src/fixtures/`. Ordenadas por lo que bloquean, la #13 y la #7 son las que
más arquitectura mueven:

| # | Llamada | Qué resuelve |
| --- | --- | --- |
| 1 | `POST /v2/auth/token` | forma del token, `expires_in`, comportamiento del TAM Pool (el 401 `invalid_client` sale también con pool agotado — §2.7) |
| 2 | `POST /v1/offers/price` **sin** `formOfPayment` | **el warning de "posible subida de precio"**: código, `service`, texto exacto. Sabemos que existe (doc oficial); no sabemos cómo se identifica |
| 3 | `POST /v1/offers/price` **con** `formOfPayment`, y con **dos BIN distintos** | **¿`obFees` está sumado en `totalPrice.totalAmount` o es aditivo?** Es el único `DESCONOCIDO` grande que queda de §2 |
| 4 | `POST /v1/offers/price` con un `offerItemId` **vencido** | forma exacta del error `UNABLE_TO_CREATE_ORDER_EXPIRED_OFFER` en `messages[]` y confirmar que el re-price funciona sin re-shop |
| 5 | `POST /v3/offers/getseats/byNdcOfferId` **y** `POST /v1/offers/getseats` | **¿qué versión tiene habilitada nuestro PCC?** Bloqueante para §4.1. Y capturar el catálogo completo de `characteristics[].code` que devuelve el carrier real |
| 6 | `getseats` con el `offerId` **del shop** (sin price) | confirmar si existe `sellable: false` o si hay que derivarlo de `displayOnlyItems` (§4.2) |
| 7 | `POST /v2/offers/getAncillaries` (`orderId`) | ya **no** es una caja negra (§5.2), pero el spec **no trae ni un ejemplo de respuesta**. Hace falta el fixture, y sobre todo saber **si `baggageGrid` / `otherBaggageCharges` ya existen en el CERT** aunque el contrato 2.3 diga que se definirán "en una versión futura". De eso depende que el endpoint sirva para algo |
| 8 | `POST /v2/offers/getAncillaries` con `requestType: "offerId"` | el modo **existe** (VERIFICADO-SPEC `:66-70`); lo que falta medir es si devuelve **lo mismo** que el modo `orderId` o menos. Determina si el carrito del Package Studio puede ofrecer equipaje antes de reservar |
| 9 | `POST /v1/offers/price` con `params.allowBundles: true` sobre una oferta con servicios | **¿vienen ancillaries como `offerItems[].type === "Service"`?** Si sí, ahorra una llamada en el flujo feliz |
| 10 | SOAP `GetAncillaryOffersRQ` ATPCO **y** LCC | confirmar que `AncillaryFee.Base.TotalEquivalentAmount` difiere de `AncillaryFee.TotalBaseEquiv.Amount` (R-11) |
| 11 | `GetAncillaryOffersRQ` **sin** `FareBasisCode` | ¿falla o solo empeora el precio? (§5.3) |
| 12 | `createBooking` ATPCO con tarjeta | **medir exactamente qué campos de PAN/CVV son obligatorios**, y si el `pattern` enmascarado de `cardNumber` (§2.4) se acepta. Decide si SAQ-A sobrevive |
| **13** | **`POST /v1/ancillaries/add`** con un `offerItemId` de `getAncillaries` y otro de `getseats` | **¿está habilitado para nuestro PCC de agencia, y qué productor de ids acepta?** Si funciona, R-3 deja de aplicar al camino principal y R-17 se reduce (§5.9). Alta prioridad: cambia la arquitectura del carril PNR |
| **14** | `POST /v1/offers/price` sobre una oferta con **9 pax** | `getAncillaries` admite `passengers[] maxItems: 99` mientras `offers/price` admite 9 y `selectedOfferItems` 9 (§5.2). Confirmar dónde está el techo real de un grupo |

Cerradas por el spec, ya no hace falta capturarlas: el TTL de la oferta, la ruta del precio
total, si `formOfPayment` es obligatorio, el significado de `characteristics` `1` y `1D`, la
forma de los tres contenedores de errores, la existencia de `requestType: "offerId"`, y la
estructura completa de `getAncillaries`.

---

## Preguntas abiertas

**Cerradas en esta pasada** (además de las 6 que cerró la anterior: FOP obligatorio, TTL, ruta
del precio total, códigos `1`/`1D`, forma de los errores, y si `offers/price` desglosa el fee):

- ~~*¿Cuál es la estructura de `/v2/offers/getAncillaries`?*~~ → **contrato completo en §5.2.**
- ~~*¿Existe `requestType: "offerId"` en `getAncillaries`?*~~ → **sí**, discriminador declarado en
  `get-ancillaries-agency-2.3.yml:66-70`. Los ancillaries NDC **se pueden cotizar pre-booking**,
  así que el carrito del Package Studio **no** necesita crear la orden antes de ofrecer equipaje.

Quedan:

1. **¿`obFees` está sumado dentro de `totalPrice.totalAmount` o es aditivo?** El spec declara
   ambos como hermanos de `Offer` y no dice cómo se relacionan. De la respuesta depende si el
   markup se aplica antes o después del fee, y si el vendedor ve un total correcto.
   *(Captura #3.)*
2. **¿Qué versión de Get Seats tiene habilitada nuestro PCC: v1 o v3?** Son contratos
   incompatibles (§4.1) y la colección oficial usa v1 mientras el catálogo publica v3.
   Bloquea el diseño del `SeatMapPort`. *(Captura #5.)*
3. **¿`getAncillaries` v2.3 devuelve algo útil hoy, o está esperando a `baggageGrid`?** El
   contrato dice que sus dos campos principales *"se definirán en una versión futura"* y que el
   endpoint muestra *"free-of-charge ancillaries"*. Si en el CERT solo llega `otherServices[]`
   vacío o casi, **no hay venta de ancillaries NDC en fase 1** y hay que decirlo en el
   roadmap, no descubrirlo implementando. *(Captura #7.)* **Es la pregunta que sustituye a la
   antigua laguna, y es peor que ella: antes no sabíamos la forma; ahora sabemos que la forma
   está incompleta a propósito.**
4. **¿Está `Manage Ancillary 1.1` habilitado para nuestro PCC, y qué `offerItemId` acepta?**
   De esto depende si el carril PNR se puede servir con ids opacos (adiós a R-3) o hay que
   materializar el precio en `createBooking`. *(Captura #13, §5.9.)*
5. **¿`offers/price` con `allowBundles` devuelve ancillaries como `offerItems[].type ===
   "Service"`?** Si sí, es un atajo que evita un endpoint entero en fase 1. *(Captura #9.)*
6. **¿`FareBasisCode` es obligatorio en `GetAncillaryOffersRQ`?** En `getseats` payload el
   análogo (`fareComponents`) es opcional y solo mejora el precio; asumir lo mismo para el
   SOAP es inferencia por analogía. *(Captura #11.)*
6b. **¿Sobre qué precio aplicamos el markup de la agencia en ancillaries?** Sabre ya devuelve
   `baseFee` y `serviceFee` (*"el precio final tras el markup"*, `get-ancillaries-agency-2.3.yml:518-523`),
   es decir, **ya hay un markup del proveedor antes del nuestro**. Es la misma pregunta que
   `obFees` pero con respuesta posiblemente distinta. Decisión de negocio, no de sandbox.
7. **¿Podemos obtener el BIN del PSP sin tocar el PAN?** De la respuesta depende que el paso
   "revalidar con BIN real antes de capturar" (§2.4) sea viable dentro de SAQ-A. Hay que
   verificarlo en la doc de Stripe y de Mercado Pago.
8. **¿Existe tokenización de tarjeta en Sabre para el carril ATPCO?** Si `createBooking`
   admitiera un token en lugar de `cardNumber`, el problema PCI de §2.4 desaparece. El spec
   solo muestra PAN. Es una pregunta para el account manager de Sabre, no para el sandbox.
9. **¿Qué credenciales BYOC necesita Sabre por tenant?** Vimos `pcc`, `username`, `password`,
   `client_id`, `client_secret`, `iataNumber`, `pseudoCityID`, `agentUserID`, `agencyID`,
   `pcc_tkt` (PCC de emisión, distinto del de reserva). Con v3 de getseats **el PCC ya no va
   en el body** (se lee del token), lo que simplifica: hay que mapear esto a
   `provider_credentials` y decidir cuáles heredan del consolidador.
10. **¿Cuál es el límite de concurrencia por PCC?** El 429 es *"Active token count is
    exceeded"* (§2.7), o sea concurrencia, no rate. Sin el número no podemos dimensionar el
    pool ni el fan-out multi-agencia. Es una pregunta comercial para Sabre.
11. **¿Se puede usar `offers/price` para ATPCO/LCC?** El enum `source` de la respuesta admite
    los tres valores, pero ningún workflow lo hace y la tarificación ATPCO está en
    `createBooking`. Si se pudiera, unificaría el flujo.
12. **¿Firmamos las ofertas antes de devolverlas al cliente?** Si `provider.raw` viaja al
    front y vuelve, hay que impedir que se altere.

---

## Riesgos

1. **[ALTO] El carril ATPCO de Sabre rompe PCI SAQ-A.** `createBooking` acepta `cardNumber`
   (12-19 dígitos) y `cardSecurityCode` (VERIFICADO-SPEC: `booking-management-v1.yml:5314`,
   `:5319`), y la tarificación ATPCO ocurre ahí dentro. Nuestro principio de hosted checkout
   es explícito en `CLAUDE.md`. *Mitigación:* fase 1 solo NDC; o cobrar por PSP y emitir
   contra forma de pago no-tarjeta; o pedir a Sabre tokenización. **No es un detalle de
   implementación: define qué contenido podemos vender.**

2. **[ALTO] Precio revalidado ≠ precio cobrado.** El fee de forma de pago depende del BIN. Si
   revalidamos con un BIN distinto del real, mostramos un precio y cobramos otro. En Colombia
   y Brasil eso es exposición legal, no solo mala UX. *Mitigación:* revalidar con el BIN real
   tras la tokenización y **antes** de capturar; si el total cambió, frenar. Sabre facilita
   esto avisando por `messages[]` cuando falta la forma de pago (§2.4).

3. **[MEDIO-ALTO, BAJANDO] En ATPCO/LCC el cliente transporta el precio del ancillary — y Sabre
   tiene un error dedicado para cuando no coincide.** `UNABLE_TO_ADD_ANCILLARY_PRICE_MISMATCH`
   (VERIFICADO-SPEC). Si el precio cambió entre la cotización y el createBooking, la reserva
   falla; y si pasa después de emitir el EMD, corregirlo implica void o refund.
   *Novedad de esta pasada:* **existe un camino que evita el problema**. `/v1/ancillaries/add`
   acepta `offerItemId` + `passengerRef` y nada más (§5.9). *(Estaba en ALTO; baja a MEDIO-ALTO
   condicionado a la captura #13. Si el carril D funciona para nuestro PCC, baja a BAJO.)*

4. **[ALTO] Escribir mappers sobre respuestas que no vimos.** Se reduce otra vez: ya tenemos
   contrato de price, de seats v3, de ancillaries 2.3 y de manage-ancillary 1.1. Pero
   **`get-ancillaries-agency-2.3.yml` no trae ni un solo ejemplo de respuesta** (frente a los 5
   de `offers/price`), el SOAP `GetAncillaryOffersRQ` sigue sin spec, y las respuestas reales
   del CERT pueden diferir de los ejemplos. *Mitigación:* fixtures del CERT primero, código
   después; Zod estricto en el borde del ACL, que **falle** en vez de devolver `undefined`.

4b. **[ALTO — NUEVO] `getAncillaries` v2.3 puede no servir para vender.** Sabre declara en el
   propio contrato que muestra *"free-of-charge ancillaries"* y que sus dos campos principales,
   `baggageGrid` y `otherBaggageCharges`, **"se definirán en una versión futura de esta API"**
   (`get-ancillaries-agency-2.3.yml:9`, `:215-219`). Si eso es literal en el CERT, **no hay
   catálogo de ancillaries NDC de pago vía este endpoint en fase 1**, por mucho que ahora
   tengamos el contrato. *Mitigación:* medirlo antes de comprometer ancillaries NDC en el
   roadmap (captura #7); y tener listo el plan B, que es el camino C —`offers/price` con
   `offerItems[].type === "Service"`— (captura #9).

5. **[MEDIO-ALTO] Tipos de dinero incompatibles.** Cuatro trampas verificadas: `amount` es
   **string**, admite **3 decimales**, puede ser **negativo** en reemisión
   (`offer-price-ndc-v1.yml:4450`, `totalAmount: "-220.30"`), y el campo de moneda tiene **tres
   nombres distintos** según el producto: `curCode` en offers/price (`:1197`), `code` en
   orders/view (respuesta real guardada), **`currencyCode`** en getAncillaries 2.3 (`:844`).
   Encima, `getAncillaries` declara el importe como `type: string, format: number` **sin
   patrón** (`:839-843`), o sea sin garantía de decimales. Un `Money` mapeado con `parseFloat`
   y `Math.round(x*100)` pierde dinero en el tercer decimal y explota en negativos.
   *Mitigación:* parser decimal explícito, `MoneySchema` con signo, y un mapper de moneda **por
   endpoint**, no compartido.

5b. **[MEDIO — NUEVO] Ancillaries sin `offerItemId` o sin precio, tratados como bug.** En el
   contrato 2.3, `OfferItem.offerItemId` y `OfferItem.priceDefinitionRef` son **opcionales**
   (`:228-236`): hay items informativos, no reservables, y items sin precio que no son
   gratuitos. Un mapper que exija ambos descarta contenido válido; uno que ponga `price: 0` por
   defecto **muestra como gratis lo que no lo es**. *Mitigación:* `price?: Money` y
   `offerItemId?` explícitos en el canónico, con la semántica documentada (§6.5).

5c. **[MEDIO — NUEVO] Ancillaries que exigen input libre del usuario.**
   `additionalInputRequirements` (`:708-744`) trae un patrón (`%FREETEXT%`) y variables con su
   propia regex y etiqueta (*"Pick Up Address"*). Sin capturar ese dato el `add` falla, y no
   hay forma de saber de antemano qué ancillaries lo piden salvo leyendo cada
   `serviceDefinition`. Impacta especialmente al canal conversacional (§4.8), donde pedir un
   campo libre validado por regex es una interacción entera.

6. **[MEDIO] `offerItems[]` es un `oneOf` y el mapper puede asumir que todo es un vuelo.**
   `AirOfferItem` tiene `passengers[]`; `ServiceOfferItem` tiene `passengerRefs[]` y ni
   siquiera el mismo conjunto de obligatorios. Sin ramificar por `type`, un ancillary dentro
   de la respuesta de price produce `undefined` silenciosos.

7. **[MEDIO] Los IDs efímeros vencen. 20 minutos.** El vendedor cotiza por WhatsApp, el
   cliente responde 40 minutos después y la oferta ya no existe. Choca con nuestro
   posicionamiento conversacional. *Mitigación:* ahora sabemos que el remedio de Sabre es
   **re-price, no re-shop** (`"Use offers/price to reprice the offer"`), que es un salto y no
   dos; guardar el criterio de búsqueda junto a la oferta; avisar al vendedor cuando el
   precio cambió.

8. **[MEDIO] `priceOffer` sin circuit breaker, sin cuota y sin bandera `simulated`.** Un
   tenant sin credenciales revalida contra fixtures y el vendedor cierra la venta con un
   precio inventado. Agravado por el 429 de concurrencia de Sabre: sin breaker, un pico de
   revalidaciones agota el pool del PCC y tumba también la búsqueda.

9. **[MEDIO] El BIN es dato de tarjeta y ahora también viaja en la RESPUESTA.**
   `obFees[].binNumber` (con comodines, ej. `5452**`). Si entra en logs, en el cache de
   búsqueda, en `domain_events` o en telemetría, tenemos un problema de cumplimiento. El
   `formOfPayment` **nunca** debe entrar en la clave ni en el valor cacheado, ni en
   `provider.raw`.

10. **[MEDIO] Copiar `subCode: "FDA"` como default es cotizar débito para todo.** `FDA` =
    *any debit card* (VERIFICADO-SPEC). Toda la colección lo usa, y copiarlo sin pensar
    significa aplicar fees de débito a tarjetas de crédito. El `subCode` tiene que derivarse
    del método de pago real del PSP.

11. **[MEDIO] ATPCO y LCC parsean distinto el mismo mensaje SOAP.**
    `AncillaryFee.Base.TotalEquivalentAmount` vs `AncillaryFee.TotalBaseEquiv.Amount`. Un
    mapper que solo contemple una rama devuelve precio vacío para la otra — y el precio vacío
    se propaga al `createBooking`, que ahora sabemos que lo rechaza con
    `..._PRICE_MISMATCH` (mejor que aceptarlo, pero es un fallo en producción igual).

12. **[MEDIO] Reglas de asiento para menores mal implementadas.** La heurística de la
    colección (filtrar `description === "ExitRowSeat"`) es frágil y **incompleta**: los
    códigos que realmente restringen menores e infantes son `1A`, `1C` e `IE`, y el mismo
    code `E` aparece con dos descripciones distintas en la doc oficial. Sentar a un menor
    donde no corresponde es un problema regulatorio y de denegación de embarque.

13. **[MEDIO] Sin `displayOnlyItems`, pintamos como comprable lo que no lo es.** Es una
    diferencia de contrato entre v1 y v3, y afecta directamente a la conversión: el vendedor
    elige un asiento, falla al reservar, y pierde la venta.

14. **[MEDIO] `Offer.provider.offerRef` con `max(255)` y el truco del pipe.** Ya está al
    límite con LATAM. Con Sabre (5+ identificadores) se rompe. Y `parseOfferRef()` en
    `providers/latam-ndc/src/offerprice/request.builder.ts:63-67` **inventa** un id
    (`${ref}-ITEM1`) cuando no encuentra el separador: enmascara errores en vez de fallar.

15. **[MEDIO] Sabre expone CUATRO vocabularios para `reasonForIssuance`, DOS para el tipo de
    EMD y TRES para el nombre del campo de moneda**, todos oficiales (§5.5). El cuarto
    vocabulario de RFIC (`Ground Transportation Non Air Services`) **no se obtiene del tercero
    con una transformación mecánica**: es otra palabra, no otro casing. Y el tipo de EMD tiene
    **5 valores, no 2**. Un enum canónico mal dimensionado pierde información necesaria para el
    reembolso. *Mitigación (nueva):* guardar la **letra PADIS**, que el spec de ancillaries
    documenta (`:677-679`), y traducir en cada borde. *(Sube de BAJO-MEDIO a MEDIO: con cuatro
    vocabularios, la probabilidad de que un mapper falle en silencio deja de ser marginal.)*

16. **[BAJO] Modelos de precio de ancillary que no representamos.**
    `FeeApplicationMethodEnum` incluye *"Percentage 1 Of Fare Per Kg"* y *"Per 5kg Over Free
    Baggage Allowance"*; `PaymentTypeEnum` incluye `Deferred`. Un `AncillaryOffer` con un
    `Money` fijo no puede mostrar ninguno de los dos correctamente.

17. **[BAJO, REDUCIDO] LCC y el carril payload exigen sesión SOAP stateful.** WF-20 abre
    `SessionCreateRQ` y cierra `SessionCloseRQ`. *Reducción de esta pasada:* la parte del
    riesgo que decía *"y el asiento se reserva con `PassengerDetailsRQ`, no por REST"* **ya no
    se sostiene como absoluto**: `Manage Ancillary 1.1` asigna asientos sobre PNR por REST
    stateless (§5.9), y la página de `getseats` que afirmaba lo contrario es del mismo lote de
    documentación desactualizada que ya detectamos en §4.1. Queda como riesgo la **cotización**
    LCC (`GetAncillaryOffersRQ`, que sí abre sesión en la colección) y la lectura de
    `SeatId`/`AncillaryId`, que salen de la Retrieve Itinerary API, que es SOAP. *Mitigación:*
    agotar el carril REST antes de construir un pool de sesiones. Verificar con la captura #13.

18. **[BAJO] Restricciones por carrier que no conocemos hasta que fallan.**
    `SEATS_UPDATE_NOT_SUPPORTED` y `SEATS_UPDATE_WITHOUT_TICKETING` traen el código de
    aerolínea en el mensaje (`"la aerolínea %s no permite…"`). No hay forma de saberlo de
    antemano por API. Hay que construir una tabla de capacidades por carrier a partir de los
    fallos observados, y degradar la UI en consecuencia.

19. **[MEDIO — NUEVO] El asiento NDC no se puede vender conversacionalmente.** La preferencia
    de área (`WINDOW`, `AISLE`…) existe **solo en el carril ATPCO** (`BookSeat.areaPreferences`)
    y no en el NDC (`BookSeatOffer`), §4.5. Fase 1 apunta a NDC, y NDC exige devolver un
    `seatOfferId` de una celda concreta del mapa. Choca de frente con *"WhatsApp es ciudadano de
    primera"* (`CLAUDE.md` §5). *Mitigación:* enlace a vista web del mapa desde la conversación,
    o preferencia resuelta **por nosotros** filtrando `characteristics[].code`, asumiendo la
    responsabilidad de la elección. Nunca lo segundo en silencio. Ver §4.8.

20. **[MEDIO — NUEVO] La documentación oficial de Sabre contradice a sus propios contratos, y
    no de forma anecdótica.** Casos verificados en este documento: la página `2pax-2seg` de
    getseats v3 muestra el formato **v1** (§4.1); `sellable` está documentado en getseats pero
    **no en su .yml** (§4.2); la página de getseats manda usar `PassengerDetailsRQ` para
    reservar asiento cuando existe un endpoint REST que lo hace (§4.6); y el slug que dos
    pasadas dieron por inaccesible estaba **enlazado en la propia documentación descargada**
    (§0.1). *Mitigación de método:* **el .yml manda sobre la página de ayuda**, y ante una
    discrepancia se marca y se lleva al CERT — no se elige la fuente que conviene. Y antes de
    declarar que algo "no está disponible", agotar los enlaces internos de lo que ya tenemos.
