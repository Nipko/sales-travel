---
titulo: 'Sabre — Emisión y post-venta de billetes (fulfill / check / void / refund)'
fecha: 2026-08-25
estado: revisado contra contrato oficial
fuentes: 'ver 00-fuentes.md'
---

# 06 — Emisión y post-venta de billetes en Sabre

## 0. Qué cambió en esta pasada y cómo leer el documento

La primera pasada de este documento se escribió **sólo con la colección Postman**. Ahora tenemos el **contrato oficial** (`booking-management-v1.yml`, Swagger 2.0, v1.33) y las **páginas oficiales** de los cuatro endpoints, incluidas sus **listas completas de errores y de warnings**. Eso convierte en `VERIFICADO-SPEC` la mayor parte de lo que antes era `[INFERIDO]` o `desconocido`.

Convención de marcado: **ver `00-fuentes.md` §4**. Resumen operativo: `VERIFICADO` = sale de la colección; `VERIFICADO-SPEC` = sale del contrato o de la documentación oficial, y **manda sobre la colección**; `[INFERIDO]` = deducción; `DESCONOCIDO` = ninguna fuente lo cubre.

### 0.1 Tres errores de procedencia de la primera pasada, corregidos aquí

1. **«Las 4 respuestas guardadas de la colección están vacías (0 bytes)» — FALSO.** Pesan **16.479 bytes cada una** y están en `slices/responses/*.json`. Son cuatro capturas de `/v1/orders/view` del mismo pedido NDC (`4e54071d6c2d483c808f8a09f38f6bbc`, PNR `TOSGCZ`). No cubren ticketing, pero **sí aportan una evidencia dura y directamente relevante** a este documento (§5.3): `order.paymentTimeLimit` y `order.orderItems[].ticketingTimeLimit` valen `"2019-04-19T20:37:00"` — **ISO local, sin offset ni zona horaria**. Ese es exactamente el problema de husos horarios que este documento denuncia, y ahora está VERIFICADO con un cuerpo real, no inferido.
2. **El front-matter citaba `EXTERNAL_AGENCY.postman_collection.json` — FALSO.** Ese archivo es la colección de **LATAM NDC** (160 requests). La fuente Sabre es `sabre/Booking Management API v2026.04.postman_collection.json` (1.077 requests). Corregido: el front-matter remite a `00-fuentes.md`.
3. **El carril SOAP/LLS quedó fuera del análisis.** Para *este* documento el impacto es acotado y hay que decirlo con precisión: entre los 243 requests SOAP/LLS de la colección **no hay ningún `AirTicketRQ`, `VoidTicketLLSRQ` ni `TKT_RefundRQ`**; el carril stateful de la colección es sesión + disponibilidad + book + PNR. Pero la documentación oficial revela que **esos LLS son exactamente lo que los cuatro endpoints REST orquestan por debajo** (§1.5), y uno de ellos, `EnhancedEndTransactionRQ`, sí aparece en la colección (4 requests) — es el commit que void y refund ejecutan tras cada documento procesado.

---

## 1. Los dos caminos de emisión

### 1.1 Camino A — `fulfillFlightTickets` (REST, moderno)

```
POST {{rest_endpoint}}/v1/trip/orders/fulfillFlightTickets
Content-Type: application/json
Authorization: Bearer <token>
```

**VERIFICADO** — 19 requests en la colección. `rest_endpoint = https://api.cert.platform.sabre.com`.
**VERIFICADO-SPEC** — `booking-management-v1.yml:140` (`operationId: fulfillTickets`), `basePath: /v1/trip/orders` (`booking-management-v1.yml:15`), seguridad OAuth2 client-credentials contra `https://api.cert.platform.sabre.com/v2/auth/token` (`booking-management-v1.yml:19-27`).

Descripción oficial: *«Processes the fulfillment of flight tickets (for ATPCO and NDC content) and Electronic Miscellaneous Documents (EMDs)»* (`booking-management-v1.yml:142`).

### 1.2 Camino B — Enhanced Air Ticket `/v1.3.0/air/ticket` (legacy)

```
POST {{rest_endpoint}}/v1.3.0/air/ticket
Content-Type: application/json
Diagnostics: CLIENT
```

**VERIFICADO** — 6 requests. Body = traducción JSON literal del mensaje SOAP `AirTicketRQ` (PascalCase, `FOP_Qualifiers`, `CC_Info`, `LNIATA`). Ejemplo real recortado (`Workflows / 6 - Air Shop, Book, Fulfill, Cancel + Void / 3. Enhanced Air Ticket`):

```json
{
  "AirTicketRQ": {
    "DesignatePrinter": { "Printers": {
      "Hardcopy": { "LNIATA": "{{hardcopy}}" },
      "Ticket": { "CountryCode": "{{country_code}}" } } },
    "Itinerary": { "ID": "{{pnr}}" },
    "Ticketing": [ {
      "FOP_Qualifiers": { "BasicFOP": { "CC_Info": { "PaymentCard": {
        "Code": "AX", "ExpireDate": "{{creditCardExpiryDate}}", "Number": {{creditCardNumberAX}} } } } },
      "PricingQualifiers": { "PriceQuote": [ { "Record": [ { "Number": 1 } ] } ] } } ],
    "PostProcessing": { "EndTransaction": { "Source": { "ReceivedFrom": "API TEST" } } }
  }
}
```

Dos capacidades del camino legacy (**VERIFICADO**, `Workflows / 5 - Air LCC Shop, Book, Cancel / 3. Fulfill (EnhancedAirTicket)`):

```json
"PostProcessing": {
  "EndTransaction": { "Source": { "ReceivedFrom": "API TEST" }, "InvoiceOption": { "Ind": true } },
  "GhostTicketCheck": { "waitInterval": 1000, "numAttempts": 3 }
}
```

**Respuesta (VERIFICADO por script de test)** — `Workflows / 21 - LCC - Check, Refund Booking / Fulfill (EnhancedAirTicket)`:

```js
pm.expect('Complete').to.eql(responseJson.AirTicketRS.ApplicationResults.status);
```

### 1.3 Quién usa qué, workflow por workflow (VERIFICADO)

| Workflow                                       | Contenido        | `fulfillFlightTickets` | `/v1.3.0/air/ticket` |
| ---------------------------------------------- | ---------------- | :--------------------: | :------------------: |
| WF-05 — Air LCC Shop, Book, Cancel             | LCC              |     Sí (alternativa)   |   Sí (alternativa)   |
| WF-06 — Shop, Book, Fulfill, Cancel + Void     | ATPCO            |     Sí (alternativa)   |   Sí (alternativa)   |
| WF-07 — Shop, Book, Fulfill, Void, Display     | ATPCO            |     Sí (alternativa)   |   Sí (alternativa)   |
| WF-08 — Shop, Book, Fulfill, Refund, Display   | ATPCO            |     Sí (alternativa)   |   Sí (alternativa)   |
| WF-14 — NDC Cancel order + void tickets        | **NDC**          |          Sí            |          No          |
| WF-16 — ATPCO check refundable/exchangeable    | ATPCO            |          Sí            |          No          |
| WF-17 — ATPCO check + override comisión        | ATPCO            |          Sí            |          No          |
| WF-21 — LCC Check, Refund Booking              | LCC              |          No            |          Sí          |
| WF-22 — LCC + ATPCO Check, Refund Booking      | LCC + ATPCO      |          No            |          Sí          |
| WF-26 — ATPCO refund ancillaries (lista tkts)  | ATPCO + EMD      |          Sí            |          No          |
| WF-27 — ATPCO refund ancillaries (por PNR)     | ATPCO + EMD      |          Sí            |          No          |
| `FulfillFlightTickets / Basic flow NDC / *`    | **NDC**          |          Sí            |          No          |
| `FulfillFlightTickets / Basic flow ATPCO / *`  | ATPCO            |          Sí            |          No          |

Lecturas de la tabla:

1. **NDC nunca usa Enhanced Air Ticket.** Los 6 requests a `/v1.3.0/air/ticket` están en carpetas LCC o ATPCO (VERIFICADO).
2. **En WF-05/06/07/08 los dos requests llevan el mismo número de paso ("3.")** — son alternativas mutuamente excluyentes que Sabre dejó para que el integrador elija (VERIFICADO).
3. Los flujos con EMD/ancillaries (WF-26, WF-27) sólo existen en forma REST (VERIFICADO).
4. La primera pasada marcó como `[INFERIDO]` que WF-21/22 usaran legacy por antigüedad de la colección. **Se mantiene [INFERIDO]**: el contrato no dice nada sobre LCC en `fulfillFlightTickets`, pero la documentación oficial de `checkFlightTickets` y `refundFlightTickets` sí trata LCC como caso de primera clase (`flightRefunds[]`, warnings `TICKETS_NOT_FULFILLED` y `LCC_SEGMENTS_PARTIALLY_FULFILLED_WARNING`), así que el carril LCC no está abandonado.

### 1.4 Cuál deberíamos usar y por qué — **decisión reconfirmada, tabla corregida**

**Recomendación: `POST /v1/trip/orders/fulfillFlightTickets` como camino único.** La decisión no cambia; **dos filas de la comparativa de la primera pasada eran falsas** y quedan corregidas:

| Criterio                                       | `fulfillFlightTickets`                                                                 | `/v1.3.0/air/ticket`                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| Cobertura ATPCO                                | Sí (`priceQuoteRecordIds`)                                                               | Sí (`PricingQualifiers.PriceQuote`)         |
| Cobertura NDC                                  | **Sí, y es la única**                                                                    | No aparece nunca                            |
| Reemisión (PQR)                                | **Sí (`priceQuoteReissueRecordId`)** — VERIFICADO-SPEC `:7539` (FulfillQualifiers)       | DESCONOCIDO                                 |
| EMD / ancillaries                               | **Sí (`ancillaryIds`)** — VERIFICADO-SPEC `:7439`                                        | No visible                                  |
| Split FOP (dos formas de pago)                 | **Sí** (`secondaryFormOfPayment` + `amountOnSecondFormOfPayment`) — VERIFICADO-SPEC `:5730` | Sí (un bloque `Ticketing[]` por PQ)      |
| Cambio de PCC de emisión                       | Sí (`targetPcc`)                                                                          | DESCONOCIDO                                 |
| Perfil de impresora guardado                   | Sí (`designatePrinters[].profileNumber`)                                                  | No visible                                  |
| **Anti *ghost ticket* nativo**                 | **~~No~~ → SÍ: `commitTicketToBookingWaitTime` (0–10.000 ms)** — VERIFICADO-SPEC `:912` (FulfillTicketsRequest) | Sí (`GhostTicketCheck`)       |
| **Factura al emitir**                          | **~~No visible~~ → SÍ: `notificationEmail: "INVOICE"`, `ticketingQualifiers.printDocuments`, `generateSingleInvoice`** — VERIFICADO-SPEC `:912`, `:8627` | Sí (`InvoiceOption.Ind`) |
| Forma del payload                              | JSON idiomático, misma familia que `/trip/orders/*`                                       | SOAP transliterado                          |

**Corrección explícita frente a la primera pasada.** Se afirmaba que *«al renunciar a `GhostTicketCheck` perdemos la única salvaguarda nativa contra el billete fantasma»* y que la factura *«no tiene equivalente visible»*. **Las dos afirmaciones son falsas contra el contrato:**

- `commitTicketToBookingWaitTime` está descrito literalmente como *«the maximum wait time in milliseconds applied to asynchronous updates during the **ghost ticket validation process**, which is performed to check if the newly issued tickets have been committed to the face of the PNR»* (VERIFICADO-SPEC, `booking-management-v1.yml:912` bloque `FulfillTicketsRequest`, y `help/booking-management-api-v1/help-documentation-fulfill-flight-tickets.txt`). Es **el mismo mecanismo**, con un parámetro en lugar de dos. Su default es `0`. Y el resultado del chequeo viaja en la respuesta: `tickets[].isCommitted` (VERIFICADO-SPEC `:7965`).
- La factura tiene **tres** palancas REST: `notificationEmail` (`DEFAULT | INVOICE | ETICKET | ETICKET_PDF | ITINERARY | ITINERARY_PDF`, VERIFICADO-SPEC `:8954`), `ticketingQualifiers.printDocuments` (`Invoice | Electronic Ticketing Receipt | All`, VERIFICADO-SPEC `:8627`) y `generateSingleInvoice` (boolean).

Esto **refuerza** la decisión: el camino REST ya no tiene ningún hueco funcional frente al legacy en lo que nos importa, y además es el único que cubre NDC, EMD y reemisión por PQR.

### 1.5 Qué orquesta cada endpoint por debajo (VERIFICADO-SPEC)

Dato nuevo y operativamente importante: los cuatro endpoints REST **no son servicios nativos**, son orquestadores de LLS/SOAP. La documentación oficial lo publica:

| Endpoint | Orquesta |
| --- | --- |
| `fulfillFlightTickets` | `ContextChangeLLSRQ`, `GetReservationRQ`, **`AirTicketRQ`**, Order Management |
| `voidFlightTickets` | `ContextChangeLLSRQ`, `DesignatePrinterLLSRQ`, `GetReservationRQ`, `TKT_ElectronicDocumentServicesRQ`, **`VoidTicketLLSRQ`**, `QueuePlaceLLSRQ`, **`EnhancedEndTransactionRQ`** |
| `refundFlightTickets` | idem + **`TKT_RefundRQ`** + Agency Ancillaries Service API |
| `checkFlightTickets` | idem + `TKT_RefundRQ`, `StructureFareRulesRQ`, `VoidTicketLLSRQ`, `SabreCommandLLSRQ`, `legDetection`, `ProcessEligibilityRules`, **`/v1/offers/reshop/cancelOrder`**, `FullCancelQueryRQ` |

Tres consecuencias de diseño:

1. **Las latencias son de orquestación, no de un endpoint.** `checkFlightTickets` invoca hasta 10 servicios y puede llamar a la aerolínea (`INTERNAL_SERVER_TIMEOUT: "Request to the supplier airline %s has timed out"`). Nuestro timeout HTTP tiene que ser generoso y el circuit breaker, tolerante.
2. **Los errores que veremos son en buena parte errores ajenos re-empaquetados.** La documentación lo dice: *«errores y warnings devueltos por APIs downstream siempre se devuelven como WARNING»*. Ver §2.8.
3. **`voidFlightTickets` y `refundFlightTickets` hacen `EnhancedEndTransactionRQ` tras cada documento.** Es decir: **el commit es por documento, no por lote.** Eso resuelve la pregunta de la primera pasada sobre `HALT_ON_ERROR` — ver §5.1.

---

## 2. `fulfillFlightTickets` campo por campo (contrato oficial)

### 2.1 Nivel raíz — `FulfillTicketsRequest`

**VERIFICADO-SPEC: `booking-management-v1.yml:912`.** `required: [confirmationId, fulfillments]`. Nada más es obligatorio a nivel de esquema (aunque la doc oficial advierte que varios campos son *de facto* obligatorios según el carril).

| Campo | Tipo / restricción del contrato | Obligatorio | Qué es |
| --- | --- | :---: | --- |
| `confirmationId` | string, `^[A-Z0-9]{6,}$` | **sí** | PNR Locator (SABRE) u Order ID. |
| `fulfillments[]` | array `FulfillmentDetails`, **1–99** | **sí** | Una entrada por documento/paquete a emitir. §2.2. |
| `errorHandlingPolicy[]` | **array** de `FulfillErrorPolicyEnum` | no | **Ojo: es array, y su enum NO es el de void/refund.** §2.3. |
| `bookingSource` | `BookingSourceEnum`, default `SABRE` | no | Origen de la reserva. |
| `retainAccounting` | boolean, default `false` | no | Si `false`, **borra las líneas contables previas** antes de emitir. |
| `agency` | `GenericAgency` (`:4756`) | no (sí *de facto* en NDC) | Dirección y contacto de la agencia. Algunas aerolíneas NDC lo exigen. |
| `targetPcc` | string, `^[A-Z0-9]{3,4}$` | no | PCC contra el que se emite. **El contexto NO se revierte tras la operación.** §7. |
| `receivedFrom` | string, default `'Fulfill Flight Tickets'` | no | Quién autoriza el cambio en el PNR. Queda en el histórico del PNR. |
| `designatePrinters[]` | array `PrinterAddress` (`:4591`) | no | §2.5. |
| `formsOfPayment[]` | array `FulfillFormOfPayment`, **1–10** | no (sí *de facto* en NDC) | Catálogo de FOP. §2.4. |
| `travelers[]` | array `TravelerName` (`:8061`), **1–9** | no | Para asociar nombre con `travelerIndices`. |
| `generateSingleInvoice` | boolean, default `false` | no | Commit único tras emitir varios billetes. |
| `commitTicketToBookingWaitTime` | int32, **0–10000**, default `0` | no | **Ghost ticket validation.** §9. |
| `acceptNegotiatedFare` | boolean, **default `true`** | no | Usa tarifa negociada si no puede usar la almacenada. |
| `acceptPriceChanges` | boolean, **default `true`** | no | **Emite aunque el precio suba durante el proceso.** Ver Riesgos. |
| `backDatePriceQuoteMethod` | `PriceQuoteHandlingMethodEnum` (`Reprice`\|`Override`\|`Quit`), default `Reprice` | no | Qué hacer con PQ con precio retrodatado. |
| `priceQuoteExpirationMethod` | idem, default `Reprice` | no | Qué hacer con PQ caducado. |
| `notificationEmail` | `NotificationEmailEnum` (`:8954`) | no | `DEFAULT`\|`INVOICE`\|`ETICKET`\|`ETICKET_PDF`\|`ITINERARY`\|`ITINERARY_PDF`. |

**Hallazgo de política de producto (VERIFICADO-SPEC).** `acceptPriceChanges` **viene en `true` por defecto**: si no lo mandamos explícitamente, Sabre emitirá aunque el precio haya subido entre el tarifado y la emisión, y sólo nos avisará con el **warning** `PRICE_CHANGE` (§2.7). Eso viola directamente nuestro contrato de precio con el cliente. **Regla: el adapter debe enviar `acceptPriceChanges: false` salvo que el caso de uso lo autorice**, y el error `PRICE_MISMATCH` (*«No new tickets have been issued due to the price change (new total price: %s)»*) es el que queremos ver, no un warning silencioso.

Lo mismo con `priceQuoteExpirationMethod` / `backDatePriceQuoteMethod`: el default `Reprice` **re-tarifa por su cuenta**. Para venta con precio comprometido queremos `Quit`.

**Corrección frente a la primera pasada:** el campo se llama **`retainAccounting`** y su semántica está invertida respecto a lo intuitivo (`false` = borra las líneas contables). La primera pasada no lo detectó porque la colección no lo envía nunca (viaja siempre en el eco `request` de la respuesta con valor `false`).

### 2.2 `fulfillments[]` — `FulfillmentDetails`

**VERIFICADO-SPEC: `booking-management-v1.yml:7439`.** Sin campos obligatorios propios.

| Campo | Tipo | Qué es |
| --- | --- | --- |
| `ancillaryIds[]` | array string `^[A-Z0-9]+$`, 1–99 | **EMD**: ancillaries por `itemId` obtenido de `getBooking`. |
| `ticketingQualifiers` | `FulfillQualifiers` (`:7539`) | §2.6. |
| `serviceFee` | `MiscellaneousServiceFee` (`:7888`) | MISF — **sólo clientes de Canadá.** |
| `payer` | `Payer` (`:9559`) | Nombre, apellido, fecha de nacimiento, email, documento del pagador. **Sólo NDC.** |
| `payment` | `PaymentMethod` (`:5730`) | Índices al catálogo `formsOfPayment`. §2.4. |

Las tres variantes observadas en la colección siguen siendo válidas y ahora se explican por el contrato:

**(a) ATPCO contra Price Quotes** (`FulfillFlightTickets / Basic flow ATPCO / ATPCO fulfillment - PQ / 3. fulfillFlightTickets`):

```json
"fulfillments": [ { "ticketingQualifiers": { "priceQuoteRecordIds": ["1"] }, "payment": { "primaryFormOfPayment": 1 } } ]
```

**(b) Billete + EMD en la misma llamada, dos entradas** (`… / ATPCO fulfillment - Tickets + EMD / 3.`):

```json
"fulfillments": [
  { "ticketingQualifiers": { "priceQuoteRecordIds": ["1"] }, "payment": { "primaryFormOfPayment": 1 } },
  { "ancillaryIds": ["{{ancillaryId}}"], "payment": { "primaryFormOfPayment": 1 } }
]
```

**(c) NDC / asientos pagos ATPCO, sin calificadores** (`Workflows / 14 … / 4.`):

```json
"fulfillments": [ { "payment": { "primaryFormOfPayment": 2 } } ]
```

La primera pasada marcó `[INFERIDO]` que (c) significa *«emite todo lo emitible de este PNR»*. **Confirmado como VERIFICADO-SPEC para NDC**: la doc oficial dice *«Fulfills an entire NDC order (all order items) in a single call»* y lista como limitación *«Partial fulfillment of NDC bookings for selected order items (only fulfillment of the entire order is allowed)»*. Para ATPCO sigue **[INFERIDO]**: el contrato no describe el default cuando se omiten los calificadores.

**Dato nuevo (VERIFICADO-SPEC, ejemplo oficial de PQR):** una entrada de `fulfillments[]` puede ir **sin `payment`**. El ejemplo de reemisión oficial es literalmente `{"ticketingQualifiers": {"priceQuoteReissueRecordId": "4"}}`, sin bloque de pago.

### 2.3 `errorHandlingPolicy` de fulfill ≠ el de void/refund — **corrección importante**

La primera pasada mezcló las dos políticas en una sola tabla. **Son enums distintos con valores distintos:**

| Endpoint | Enum | Valores | Default |
| --- | --- | --- | --- |
| `fulfillFlightTickets` | `FulfillErrorPolicyEnum` (`:8637`), y es un **array** | `ALLOW_PARTIAL_FULFILLMENT`, `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR` | `ALLOW_PARTIAL_FULFILLMENT` |
| `voidFlightTickets`, `refundFlightTickets`, `cancelBooking` | `CancelErrorPolicyEnum` (`:8942`), escalar | `HALT_ON_ERROR`, `ALLOW_PARTIAL_CANCEL` | `HALT_ON_ERROR` |

VERIFICADO-SPEC. Los valores `HALT_ON_ERROR` / `ALLOW_PARTIAL_CANCEL` **no son válidos en fulfill**, y `ALLOW_PARTIAL_FULFILLMENT` no lo es en void/refund. El ACL tiene que mapear dos enums, no uno.

Semántica oficial:
- `ALLOW_PARTIAL_FULFILLMENT` (default): *continúa el proceso ante cualquier error de un servicio downstream durante la emisión*. Es decir: **por defecto Sabre te devolverá 200 con emisión parcial**, no un error. De ahí que los warnings sean críticos (§2.7).
- `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR`: para si el tiempo mínimo de conexión no se cumple.

### 2.4 `formsOfPayment[]` y `payment` — el catálogo y sus índices

**Catálogo — `FulfillFormOfPayment` (VERIFICADO-SPEC `:7473`, hereda de `BasicFormOfPayment` `:5305`).** `type` es el único campo obligatorio.

`FulfillFormOfPaymentTypeEnum` (VERIFICADO-SPEC `:8659`) — **ocho valores**:

| `type` | Campos asociados | Toca PAN |
| --- | --- | :---: |
| `PAYMENTCARD` | `cardTypeCode`, `cardNumber`, `cardSecurityCode`, `expiryDate`, `extendedPayment`, `cardHolder` (NDC), `manualApprovalCode`, `authentications[]` | **SÍ** |
| `VIRTUAL_CARD` | `virtualCardCode` (ej. `"SABREVIRTUAL"`) | no (código de cuenta) |
| `CASH` | `customPaymentCode` (ej. `"CA/NOREF"`) | no |
| `CHECK` | — | no |
| `INVOICE` | `invoiceDescription`, `addInvoiceDescriptionPrefix` (prefijo `INV/`) | no |
| `ON_ACCOUNT` | `customPaymentCode` | no |
| `MISCELLANEOUS` | `miscellaneousCreditCode`, `extendedPayment`. **Requiere activación por agencia.** | no |
| `INSTALLMENTS` | `numberOfInstallments` (1–96), `airlinePlanCode`, `installmentAmount`. **Sólo BSP Brasil — el "parcelado".** | (con tarjeta) |

Además, transversal a todos: **`referenceId`** — *«The ID of the stored wallet form of payment referenced by `itemId` obtained from the Get Booking response»* (VERIFICADO-SPEC `:7473`). Es decir, **Sabre tiene una wallet de FOP almacenada en el booking a la que se apunta por id.**

**Selección — `PaymentMethod` (VERIFICADO-SPEC `:5730`).** `required: [primaryFormOfPayment]`.

| Campo | Tipo | Nota |
| --- | --- | --- |
| `primaryFormOfPayment` | int32, 1–11, **1-based** | Índice en `formsOfPayment[]`. |
| `secondaryFormOfPayment` | int32, 1–11 | **Split FOP: existe.** |
| `amountOnSecondFormOfPayment` | string decimal | Importe de tarifa base a cargar a la segunda FOP. |

**Cierra la pregunta 13 de la primera pasada: sí hay FOP secundaria.** Restricción oficial: *«Multiple forms of payment may be defined only if your location uses BSP reporting and/or the point of sale country does not prohibit providing more than one credit card»*. Y en NDC está **prohibida**: error `MULTIPLE_PAYMENT_TYPES_NOT_SUPPORTED` — *«Multiple forms of payment are currently not supported in the fulfillment process of the NDC Order»*.

**Incoherencia del propio contrato, anotada:** `formsOfPayment` tiene `maxItems: 10` pero los índices admiten hasta `11`. Irrelevante en la práctica; el error `PAYMENT_INDEX_OUT_OF_BOUNDS` valida contra la longitud real del array.

**El caso raro del ejemplo `"type": "CHECK"` con datos de tarjeta** (`FulfillFlightTickets / Generic Examples / fulfillFlightTickets with brandedFares`): el contrato confirma que **es un ejemplo mal mantenido de Sabre**. `BasicFormOfPayment` permite físicamente esos campos con cualquier `type` (la validación es por descripción, *«Use with PAYMENTCARD»*, no por esquema), pero el error oficial `MANDATORY_DATA_MISSING` — *«Validation failed: formOfPayment %s requires: %s»* — demuestra que hay validación cruzada por tipo en tiempo de ejecución. **No copiar ese ejemplo.**

**Autenticación fuerte — `FulfillStrongCustomerAuthentication` (VERIFICADO-SPEC `:7527`).** `channelCode`: `MO` (Mail Order), `TO` (Telephone Order), `EC` (eCommerce). La nota oficial embebida en el spec es explícita: en NDC con tarjeta **es obligatorio** el channel code; `MO`/`TO` si el punto de venta no soporta 3DSv2, `EC` **más datos adicionales 3DSv2** si sí lo soporta. La colección sólo usa `MO`.

### 2.5 `designatePrinters[]` — `PrinterAddress`

**VERIFICADO-SPEC `:4591`.** Cuatro formas, **mutuamente excluyentes dentro del mismo objeto**:

| Campo | Tipo | Contenido |
| --- | --- | --- |
| `profileNumber` | int32 | Perfil de impresora guardado. |
| `hardcopy` | `HardcopyPrinter` (`:4612`) | `address` (LNIATA, `^[A-Z0-9]{6}$`), `spacing` (`1`\|`2`). |
| `invoiceItinerary` | string `^[A-Z0-9]{6}$` | Impresora de factura e itinerario. |
| `ticket` | `TicketPrinter` (`:4627`) | `address` (LNIATA) **y/o** `countryCode` (`^[A-Z1][A-Z1]$`). |

Reglas oficiales (de las listas de errores):
- `MULTIPLE_PRINTER_TYPES` — *«The printer address object can contain only one printer type»*: un tipo por objeto del array.
- `INVALID_COMBINATION_PRINTER_PROFILE_AND_MANUAL_DESIGNATION` / `DUPLICATE_PRINTER_DESIGNATION` — o perfil, o designación manual; nunca ambos, nunca dos perfiles.
- `PRINTER_NOT_ASSIGNED` (APPLICATION_ERROR) — *«No new tickets have been issued due to a lack of ticket printer assignation»*.

**Se confirma [INFERIDO] de la primera pasada:** `hardcopy.address` **es el LNIATA** — el contrato lo dice literalmente (*«The hardcopy printer LNIATA to be designated»*), y el patrón `^[A-Z0-9]{6}$` cuadra con los valores de la colección (`E52405`, `498BF1`, `EDE375`, `B18BG1`). Pasa de [INFERIDO] a **VERIFICADO-SPEC**.

**Se confirma también** que `designatePrinters` no aplica a NDC: los tres ejemplos NDC de la colección lo omiten, y los ejemplos oficiales de NDC tampoco lo llevan. Sigue **[INFERIDO]** que la razón sea que en NDC el documento lo emite la aerolínea — el contrato no lo explica.

Nota sobre `ticket`: el contrato permite `address` **y** `countryCode`. La colección sólo usa `countryCode`. `countryCode` es el **país del stock de billetes**, no el país de la agencia.

### 2.6 `ticketingQualifiers` — `FulfillQualifiers`

**VERIFICADO-SPEC `:7539`** = `TicketingQualifiers` (`:7678`) **+** extensión propia de fulfill. Es, con diferencia, la parte más rica del contrato y donde la primera pasada sólo vio 3 campos de 30.

**Base — `TicketingQualifiers` (`:7678`):**

| Campo | Patrón | Qué es |
| --- | --- | --- |
| `commissionAmount` | `^[0-9]+(\.[0-9]{1,3})?$` | Importe de comisión. **No combinable con `commissionPercentage`.** |
| `commissionPercentage` | `^[0-9]{1,2}(\.[0-9]{1,2})?$` | Porcentaje. Máximo dos dígitos enteros. |
| `endorsements` | `Endorsements` | Sustituye el texto de endoso almacenado en el tarifado. |
| `excludeFareFocusFares` | boolean | Excluye tarifas con compra anticipada. Excluyente con `priceQuoteRecordIds`. |
| `travelerIndices[]` | int32 | Asociación de nombre. Excluyente con `priceQuoteRecordIds` y `associatedPriceQuoteRecords`. |
| `tourCode` | `^[A-Z0-9]{1,15}$` | Tour code de emisión. |
| `tourCodeOverrides` | enum | `REPLACE_WITH_BT`, `REPLACE_WITH_IT`, `SUPPRESS_IT`, `SUPPRESS_IT_AND_FARE`. **Suprime el importe de la tarifa del cupón del pasajero.** |
| `validatingAirlineCode` | `^[A-Z0-9]{2}$` | Aerolínea validadora deseada. |

**Extensión de fulfill (`:7539`):**

| Campo | Qué es |
| --- | --- |
| `priceQuoteRecordIds[]` | 1–99. PQ (`recordTypeCode = PQ`) por `recordId` de `getBooking`. **Excluyente con `travelerIndices`, `excludeFareFocusFares` y `priceQuoteReissueRecordId`.** |
| **`priceQuoteReissueRecordId`** | **PQR (`recordTypeCode = PQR`) — es el mecanismo de emisión de una REEMISIÓN.** §11. |
| `associatedPriceQuoteRecords[]` | PQ asociados a viajeros concretos. Excluyente con los dos anteriores y con `travelerIndices`. |
| `brandedFares[]` | 1–99. Un `brandCode` por vuelo. |
| `specificFares[]` | 1–16. `fareBasisCode` con validación completa de auto-pricing. |
| `exemptTaxes[]` | 1–5 códigos de tasa a excluir **en la emisión de EMD**. |
| `priceWithTaxes` | boolean, default `true`. EMD con o sin tasas. |
| `baggageAllowance[]` | Peso o piezas + vuelos asociados. |
| `validityDates[]` | Periodos de validez del billete. |
| `penalties[]` | 1–2 `TicketPenalty` (`Changeable` / `Refundable` / `Either or`). |
| `sideTripFlights[]` | Secuencia de *side trip* tras un stopover. |
| `returnFareFlexibilityDetails` | boolean, default `false`. Devuelve etiquetas de flexibilidad tarifaria. |
| `isNetFareCommission` | boolean. Comisión sobre tarifa Net. **Debe combinarse con `commissionPercentage`.** |
| `netRemit` | `FulfillNetRemit` (`:8021`): `netRemitCode`, `commercialAgreementReferenceCode`, `cashAmount`, `creditAmount`, `discountAmount`, `sellingFareAmount`, `tourCode`. Comisión adicional pagada por la validadora vía BSP. |
| `futurePricingLines[]` | Líneas FP con instrucciones de emisión futura. **Es la palanca nativa de emisión diferida.** |
| `printDocuments` | `Invoice` \| `Electronic Ticketing Receipt` \| `All`. |
| `spanishLargeFamilyDiscountLevel` | 1–2. Familia numerosa española. |
| `discountApprovalCode` | `^[A-Z0-9]{8}$`. Clientes de Corea. |

**Tres cosas que cambian nuestro plan:**

1. **`netRemit` es el mecanismo de "tarifa neta + remit" que un consolidador usa todo el tiempo en LATAM.** No estaba en el análisis anterior y es material directo para el waterfall de precios del doc 12 §3.3. Merece su propia decisión de producto.
2. **`futurePricingLines` (líneas FP) es la emisión diferida nativa de Sabre.** Antes de construir nuestra propia cola de *robotic ticketing* (gap P0 de `docs/platform/12-modelo-consolidador-y-plan.md` §4.1) hay que evaluar si delegarla en Sabre. Ver `Decisiones`.
3. **`tourCodeOverrides` suprime el importe del cupón del pasajero.** Es la palanca estándar para que el pasajero de un paquete no vea el precio del billete. Directamente relevante para el Package Studio.

### 2.7 Respuesta de `fulfillFlightTickets` — **el hueco más grande de la primera pasada, cerrado**

**VERIFICADO-SPEC: `booking-management-v1.yml:1022` (`FulfillTicketsResponse`).**

```
timestamp   string date-time  UTC, 'YYYY-MM-DDTHH:MM:SSZ'
tickets[]   FulfillTicket     los documentos emitidos
request     FulfillTicketsRequest   eco literal del request, con los defaults ya aplicados
errors[]    Error             "This array is not displayed in successful responses"
warnings[]  Warning           minItems: 1 — "May appear in successful responses"
```

**`FulfillTicket` (VERIFICADO-SPEC `:7965`).** `required: [number, date, payment]`.

| Campo | Tipo | Nota |
| --- | --- | --- |
| `number` | `^[0-9A-Z/-]+$` | Número del documento. |
| `date` | date `YYYY-MM-DD` | Fecha de emisión. **Sin hora, sin zona.** |
| `travelerGivenName` / `travelerSurname` | string | Nombre del pasajero. |
| `payment` | `TotalValues` (`:4073`) | `subtotal`, `taxes`, `fees`, `total`, `currencyCode`, `netRemit`. |
| `ticketStatusName` | `TicketStatusEnum` (`:9195`) | `Issued` \| `Voided` \| `Refunded/Exchanged`. |
| `ticketStatusCode` | `^[A-Z]{1,2}$` | `TE`, `ME`, `TO`… §10. |
| `isCommitted` | boolean | **`true` = el número está grabado en el PNR. Sólo ATPCO.** Es el resultado del ghost-ticket check. |
| **`ticketingPcc`** | `^[A-Z0-9]{3,4}$` | **PCC que emitió el documento. No aplica a NDC.** |

Ejemplo real oficial (`help-documentation-fulfill-flight-tickets-examples.txt`):

```json
{ "timestamp": "2024-04-15T07:51:07",
  "tickets": [
    { "isCommitted": true, "number": "0016802004096", "date": "2024-04-15",
      "travelerGivenName": "JACK", "travelerSurname": "DRAKE",
      "payment": { "total": "2964.53", "currencyCode": "USD" },
      "ticketStatusName": "Issued", "ticketStatusCode": "TE", "ticketingPcc": "E9E7" } ],
  "request": { … } }
```

**REFUTACIÓN de un "VERIFICADO" de la primera pasada.** El documento afirmaba: *«`bookingSignature` existe en la respuesta (VERIFICADO)»*, basándose en el script `pm.environment.set('bookingSignature', jsonData.bookingSignature)` presente en 12 de los 19 requests de fulfill. **Es falso, y la evidencia es doble:**

1. **`FulfillTicketsResponse` no tiene `bookingSignature`** (VERIFICADO-SPEC `:1022`, las cinco propiedades son las de arriba). `bookingSignature` sólo existe en `GetBookingResponse` (`:296`, campo en `:309`) y como campo **obligatorio de entrada** en `ModifyBookingRequest` (`:836-840`). Es el ETag de `getBooking → modifyBooking`, nada más.
2. **El script es un copiar-pegar genérico.** El cuerpo completo del script (verificado en `requests.jsonl`, `FulfillFlightTickets / Basic flow ATPCO / ATPCO fulfillment - PQ / 3. fulfillFlightTickets`) incluye también `if (jsonData.hotels != undefined) { pm.environment.set('hotelId', jsonData.hotels[0].itemId) }`. Es el mismo script pegado en toda la colección; sobre una respuesta de fulfill ambas ramas guardan `undefined` en silencio.

**Lección de método que hay que aplicar a todo el resto de documentos:** *un `pm.environment.set` no es evidencia de que el campo exista.* Sólo lo es un `pm.expect` sobre el campo, o el contrato.

**Corolario práctico:** `bookingSignature` **no lo devuelve la emisión**, así que para una modificación posterior hay que hacer `getBooking` de todas formas. El consejo de la primera pasada — *«diseñar el adapter asumiendo que hay que releer»* — sigue siendo correcto, pero por otra razón: no porque falten los números de billete (**sí vienen**, en `tickets[]`), sino porque falta el token de versión y porque el estado de compromiso al PNR (`isCommitted`) puede ser `false`.

### 2.8 Los WARNINGS de fulfill — un fulfill puede "salir bien" y estar mal

**Esta es la sección más importante del documento para operaciones.** El endpoint devuelve **200 con `warnings[]` no vacío** en escenarios donde el negocio está roto. Y el default `ALLOW_PARTIAL_FULFILLMENT` hace que sea el caso normal, no el excepcional.

Estructura del warning (VERIFICADO-SPEC `:4305`, `required: [category, type]`): `category`, `type`, `description`, `fieldPath`, `fieldName`, `fieldValue`.

**Lista oficial completa — los siete warnings de `fulfillFlightTickets`** (VERIFICADO-SPEC, `help/booking-management-api-v1/help-documentation-fulfill-flight-tickets-warning-list.txt`), con nuestra clasificación de severidad:

| `type` | `category` | Descripción oficial | Nuestra acción |
| --- | --- | --- | --- |
| **`UNABLE_TO_RETRIEVE_TICKETS`** | `PROCESSING_WARNING` | *«The fulfillment process has not been completed in the requested time. Verify booking details and/or audit trail reports (DQB) whether tickets were issued successfully (confirmationId: %s).»* | 🔴 **NEEDS_HUMAN inmediato.** Es literalmente el billete fantasma devuelto como warning en un 200. **Nunca reintentar.** Reconciliar (§9.2) y, si sigue ambiguo, escalar. |
| **`FULFILLMENT_NOT_CONFIRMED`** | `PROCESSING_WARNING` | *«The fulfillment operation cannot be confirmed. No new tickets were found in the booking.»* | 🔴 **NEEDS_HUMAN.** Estado indeterminado: ni éxito ni fallo. Reconciliar antes de tocar nada. |
| **`PARTIAL_FULFILLMENT`** | `PROCESSING_WARNING` | *«At least one fulfillment operation was not processed correctly. Ticket issuance was unsuccessful due to a missing form of identification (FOID).»* | 🔴 **NEEDS_HUMAN.** El cliente pagó y tiene emisión parcial. Hay dinero cobrado sin documento. Y con `ALLOW_PARTIAL_FULFILLMENT` por default, **este es el camino normal del fallo**. |
| **`PRICE_CHANGE`** | `PROCESSING_WARNING` | *«The price change occurred. The new total price: %s.»* | 🟠 **Escalar salvo tolerancia configurada.** Se emitió a un precio distinto del cotizado. Nuestro margen puede haber desaparecido. Evitable enviando `acceptPriceChanges: false` (§2.1). |
| `DOWNLINE_SERVICE_WARNING` | `PROCESSING_WARNING` | *«The AirTicketRQ returned a warning message: (%s).»* | 🟡 **Registrar y clasificar.** Es un mensaje de terminal Sabre re-empaquetado; ejemplo oficial real: `EndTransactionLLSRQ: *PAC TO VERIFY CORRECT NBR OF ACCTG LINES - THEN ET TO CONTINUE`. Contenido libre → **no parsear, guardar en `domain_events` y alertar por umbral de frecuencia.** |
| `EMAIL_NOT_FOUND` | `MISSING_DATA` | *«The email notification has not been sent due to a missing email in the booking.»* | 🟢 **Informativo.** La emisión está bien; el cliente no recibió el correo. Nuestro canal (WhatsApp/email propio) no depende de esto. |
| `FUNCTIONALITY_NOT_APPLICABLE` | `IGNORED_DETAILS` | *«The selected functionality cannot be applied within the ATPCO fulfillment workflow.»* | 🟢/🟠 **Informativo, pero auditar.** Sabre **ignoró en silencio** algo que mandamos. Si lo ignorado fue `commissionAmount` o `netRemit`, el impacto es económico. Loguear siempre con el request. |

**Regla no negociable que se deriva:** el adapter **no puede tratar `HTTP 200` como éxito**. El criterio de éxito de `issueTickets` es:

```
200 AND warnings no contiene ninguno de {UNABLE_TO_RETRIEVE_TICKETS, FULFILLMENT_NOT_CONFIRMED, PARTIAL_FULFILLMENT}
    AND tickets[] tiene tantos documentos como esperábamos
    AND (para ATPCO) todos con isCommitted === true
```

Cualquier otra combinación es `PARTIAL` o `NEEDS_HUMAN`, nunca `OK`.

**Nota sobre `UNABLE_TO_RETRIEVE_TICKETS`:** el mismo `type` aparece **también en la lista de errores** con categoría `APPLICATION_ERROR` y texto *«Tickets might have been issued successfully but application could not retrieve them»*. Es decir, el mismo evento llega como error o como warning según el momento. **El mapper debe tratar el `type`, no la categoría.**

### 2.9 Errores de fulfill que importan al diseño (selección de los 60 oficiales)

| `type` | `category` | Por qué importa |
| --- | --- | --- |
| **`BOOKING_FULFILLED`** | `APPLICATION_ERROR` | *«The fulfillment operation cannot be processed. The booking is already fulfilled.»* **Es una barrera de idempotencia natural del lado del servidor.** Un reintento sobre un PNR ya emitido no duplica: falla con este error. Cambia sustancialmente el riesgo de doble emisión (§9). |
| `HYBRID_CONTENT_NOT_SUPPORTED` | `BAD_REQUEST` | No se puede emitir un PNR con ATPCO **y** NDC. Nuestro motor no debe crear reservas híbridas. |
| `OPERATION_NOT_SUPPORTED` | `BAD_REQUEST` | *«The multiple fulfillment operations are currently not supported for NDC bookings. Only a single fulfillment for the whole order is acceptable.»* Cierra la pregunta 5 de la primera pasada. |
| `SECURE_FLIGHT_PASSENGER_DATA_MISSING` | `APPLICATION_ERROR` | Falta SFPD. Validación obligatoria **antes** de emitir en rutas US. |
| `AIR_TICKET_VALIDATING_AIRLINE_MISSING` | `APPLICATION_ERROR` | Sin validadora no hay emisión. Chequear en `createBooking`. |
| `PRICE_MISMATCH` | `APPLICATION_ERROR` | *«Update retained price (%s) in the booking and repeat fulfillment operation.»* El camino correcto cuando `acceptPriceChanges: false`. |
| `PAYMENT_CARD_DECLINED` / `_CVV_INVALID` / `_CVV_MISSING` / `_EXPIRATION_DATE_INVALID` / `PAYMENT_CARD_ISSUE` / `FAILED_PAYMENT` / `PENDING_PAYMENT` | `APPLICATION_ERROR` | Todos empiezan por *«No new tickets have been issued…»* → **son seguros de reintentar** tras corregir la FOP. Excepto `PAYMENT_CARD_ISSUE`, que dice *«At least one fulfillment operation was not processed correctly»* → **puede haber emisión parcial**. |
| `INTERNAL_SERVER_TIMEOUT` | `APPLICATION_ERROR` | **Dos variantes con consejos opuestos:** *«No new tickets have been issued. Call to internal service timed out»* (seguro reintentar) y *«The downline ticketing service exceeded its processing time… Please retry»* (Sabre recomienda reintentar, pero sin garantía). **Nuestra política: reconciliar antes de reintentar, siempre.** |
| `CARDHOLDER_DATA_MISSING` / `PAYER_DATA_MISSING` | `BAD_REQUEST` | NDC: algunas aerolíneas exigen `cardHolder` y/o `payer`. Hay que poder rellenarlos. |
| `MISSING_PRICE_QUOTE_AIR_EXTRAS_DETAILS` | `APPLICATION_ERROR` | *«Reprice the booking and retry.»* Relevante para EMD. |
| `ANCILLARY_NOT_FOUND` | `INVALID_DATA` | El `ancillaryId` caducó o cambió. Releer `getBooking` antes de emitir EMD. |

---

## 3. ATPCO vs NDC: dos modelos de emisión distintos

### 3.1 ATPCO — se emite contra un Price Quote almacenado (PQ)

Secuencia **VERIFICADA** en `FulfillFlightTickets / Basic flow ATPCO / ATPCO fulfillment - PQ`:

| # | Request | Aporta |
| - | --- | --- |
| 0 | `POST /v2/auth/token` (`grant_type=client_credentials`, `Authorization: Basic …`) | token |
| 1 | `POST /v3/offers/shop` (Bargain Finder Max) | vuelos |
| 2 | `POST /v1/trip/orders/createBooking` (payload ATPCO) | PNR **y la creación del PQ** |
| 3 | `POST /v1/trip/orders/fulfillFlightTickets` con `priceQuoteRecordIds: ["1"]` | emisión |
| 4 | `POST /v1/trip/orders/getBooking` | verificación |
| 5 | `POST /v1/trip/orders/cancelBooking` con `flightTicketOperation: "VOID"` | cancelación + void |

**Dónde nace el PQ.** `flightDetails.flightPricing[]` en `createBooking` dispara el tarifado y deja el PQ almacenado (**VERIFICADO**, `Workflows / 6 … / 2. createBooking - ATPCO payload`). Un objeto vacío `{}` basta; cada entrada produce un PQ, y por eso `priceQuoteRecordIds` es un array (1–99 según contrato).

**De dónde sale el `recordId`.** VERIFICADO-SPEC (`:7539`): *«Price Quote (PQ) records for fares with `recordTypeCode` equal to `PQ`, referenced by `recordId` and obtained from the Get Booking response»*. Es decir: **no hay que adivinar `"1"`, `"2"`; se leen de `getBooking`** filtrando por `recordTypeCode`. La colección usa literales porque son escenarios de prueba.

**Política de emisión.** `agency.ticketingPolicy` en `createBooking` (**VERIFICADO**): `"TODAY"` (83 usos) y `"TICKETING_TIME_LIMIT"` (1 uso, con `ticketingTimeLimitPolicy: { airlineCode, ticketingDate, ticketingTime }`). El contrato aporta la estructura de lectura equivalente, **`FutureTicketingPolicy` (VERIFICADO-SPEC `:4767`)**: `ticketingPcc`, `queueNumber`, `ticketingDate`, `ticketingTime` (`HH:MM`), `comment`. Nótese: **el PCC del ticketing time limit viaja en el propio objeto** — es el ancla que necesitamos para resolver la zona horaria (§5.3).

**Comisión al crear el PQ** (**VERIFICADO**): `flightPricing[].qualifiers.commissionPercentage`. Contra `ticketingQualifiers.commissionAmount` / `commissionPercentage` en la emisión. **Cuál gana si se envían ambos sigue DESCONOCIDO** — el contrato no lo dice.

### 3.2 NDC — se emite la orden completa, no items sueltos

Secuencia **VERIFICADA** en `FulfillFlightTickets / Basic flow NDC / …` y `Workflows / 14`:

| # | Request | Aporta |
| - | --- | --- |
| 0 | `POST /v2/auth/token` | token |
| 1 | `POST /v5/offers/shop` | ofertas NDC |
| 2 | `POST /v1/offers/price` | precio en firme (aquí viven los `offerItemId`) |
| 3 | `POST /v1/trip/orders/createBooking` | orden + PNR |
| 3b | `POST /v1/orders/change` con `seatAdds[].offerItemId` | (opcional) asientos |
| 4 | `POST /v1/trip/orders/fulfillFlightTickets` | emisión — sólo `confirmationId` + `payment` |
| 5 | `POST /v1/trip/orders/getBooking` | verificación |
| 6 | `POST /v1/trip/orders/checkFlightTickets` | devuelve `cancelOffers[].offerItemId` |
| 7 | `POST /v1/trip/orders/cancelBooking` con ese `offerItemId` | cancelación de la orden NDC |

**El hallazgo contraintuitivo de la primera pasada — que `fulfillFlightTickets` no acepta `orderItemId` ni `offerItemId` — queda ELEVADO a VERIFICADO-SPEC**, con dos citas independientes:

- Limitación oficial: *«Partial fulfillment of NDC bookings for selected order items (only fulfillment of the entire order is allowed)»* (`help-documentation-fulfill-flight-tickets.txt`).
- Error oficial `OPERATION_NOT_SUPPORTED` (`BAD_REQUEST`): *«The multiple fulfillment operations are currently not supported for NDC bookings. Only a single fulfillment for the whole order is acceptable.»*

**La pregunta 5 de la primera pasada («¿se puede emitir parcialmente una orden NDC?») queda cerrada: NO.**

Además, el contrato explica lo que la colección no decía: *«In the case of NDC bookings, the application automatically obtains information about the total price of the order and uses this information during fulfillment»*. Por eso el body NDC es tan escueto: **el importe no se manda, Sabre lo resuelve.**

Diferencias operativas NDC vs ATPCO en la emisión:

| Aspecto | ATPCO | NDC |
| --- | --- | --- |
| Unidad de emisión | PQ / PQR almacenado | La orden entera vía `confirmationId` |
| Paso previo de precio en firme | No (el PQ nace en `createBooking`) | Sí (`POST /v1/offers/price`) |
| `designatePrinters` | Presente | Ausente |
| `formsOfPayment` | Opcional en esquema | **Obligatorio** (VERIFICADO-SPEC, doc oficial) |
| `authentications.channelCode` | No aplica | **Obligatorio con tarjeta** (`MO`/`TO`/`EC`) |
| Split FOP | Permitido (con BSP) | **Prohibido** (`MULTIPLE_PAYMENT_TYPES_NOT_SUPPORTED`) |
| `cardHolder` / `payer` | No aplica | Requerido por algunas aerolíneas |
| `ticketingPcc` en la respuesta | Sí | **No aplica** |
| `isCommitted` en la respuesta | Sí | **No aplica** |
| Void | `voidFlightTickets` o `cancelBooking` | **`voidFlightTickets` NO soporta NDC** → `cancelBooking` con `offerItemId` |
| Refund | `refundFlightTickets` | **`refundFlightTickets` NO soporta NDC** → `cancelBooking` |

Las dos últimas filas son nuevas y VERIFICADO-SPEC: `NDC_NOT_SUPPORTED` (`REQUEST_NOT_ALLOWED`) en ambas listas de errores, y en la doc de refund: *«The refund of NDC documents is supported in CancelBooking»*.

### 3.3 LCC

Los flujos LCC usan el mismo modelo de PQ que ATPCO. Lo nuevo del contrato: **`checkFlightTickets` trata LCC como caso propio** y devuelve `flightRefunds[]` — un array separado de `tickets[]`, con `airlineCode`, `confirmationId` del proveedor LCC y `refundTotals` (VERIFICADO-SPEC `:4148`). Ejemplo oficial:

```json
{ "request": { "confirmationId": "{{pnr}}" },
  "flightRefunds": [ { "airlineCode": "U2", "confirmationId": "K9HZPCB",
                       "refundTotals": { "total": "719.00", "currencyCode": "PLN" } } ] }
```

*«Low-cost airline reservations are ticketless and only support a refundability check.»* Si hay varias reservas LCC en el mismo PNR, `flightRefunds[]` trae varios objetos. Y **mezclar ATPCO con LCC en el mismo PNR devuelve `SCENARIO_NOT_SUPPORTED`**.

---

## 4. `checkFlightTickets` — el endpoint que salva al vendedor

```
POST {{rest_endpoint}}/v1/trip/orders/checkFlightTickets
```

**16 requests VERIFICADO. Contrato: `booking-management-v1.yml:114` (`operationId: checkTickets`), request `:638`, response `:660`.**

Descripción oficial: *«Checks tickets with ticket numbers listed in the request for **void, refund and exchange conditions**. EMDs are currently not supported.»* Es el "¿puedo?" antes del "hazlo", y es **de lectura pura**: *«The reservation was not updated, and the ticket remains untouched.»*

### 4.1 Request — `CheckTicketsRequest` (VERIFICADO-SPEC `:638`)

Sólo tres propiedades. **Ningún campo obligatorio en el esquema**, pero hay que mandar `tickets` **o** `confirmationId`:

| Campo | Restricción | Nota |
| --- | --- | --- |
| `tickets[]` | `RefundFlightTicket` (`:4135`), **minItems 1, maxItems 12** | `{ number, refundQualifiers }`. |
| `confirmationId` | `^[A-Z0-9]{6,}$` | PNR Locator **u Order ID de Sabre**. |
| `targetPcc` | `^[A-Z0-9]{3,4}$` | **Sí lo acepta.** Cierra parte de la pregunta 9. |

**Regla dura, VERIFICADO-SPEC** (error `INVALID_FLAGS_COMBINATION`, `BAD_REQUEST`): *«Properties confirmationId and tickets cannot be combined. Use tickets property to indicate specific tickets… or confirmationId to process all tickets present in the reservation.»* **Son mutuamente excluyentes.** La primera pasada las presentó como "tres formas de invocarlo" sin decir que (a) y (b) se excluyen.

Otros límites oficiales: máximo 12 documentos; **todos del mismo PNR** (`SINGLE_RESERVATION_TICKETS_SUPPORTED`); EMD aceptados pero con respuesta limitada (`UNABLE_TO_CHECK_TICKET` como warning: *«The document is an EMD and currently not supported»*); NDC-EMD ignorados (`TICKET_NOT_SUPPORTED`, warning).

### 4.2 `refundQualifiers` — **9 campos, no 3**

**VERIFICADO-SPEC: `RefundQualifiers`, `booking-management-v1.yml:4169`.** Idéntico en `checkFlightTickets` y en `refundFlightTickets` (ambos usan `RefundFlightTicket`), lo cual confirma el patrón *«simulo con el mismo objeto con el que ejecuto»* que ya proponía la primera pasada.

| Campo | Patrón | Qué hace |
| --- | --- | --- |
| `overrideCancelFee` | `^[0-9]+(\.[0-9]{2})?$` | *«Amount of cancel penalty in the currency of the original ticket… **This will override any penalty calculated by the system**.»* |
| `overrideTaxes[]` | `OverrideTax` (`:4251`) | `taxCode` (2 chars), `taxAmount`, y `airportTaxBreakdowns[]` para desglosar la tasa XF por aeropuerto. |
| `commissionAmount` | `^[0-9]+(\.[0-9]{2})?$` | Sobrescribe la comisión del billete original. **Máximo 9999.99.** No combinable con `commissionPercentage`. |
| **`commissionPercentage`** | `^[0-9]{1,3}(\.[0-9]{1,2})?$` | Porcentaje. **Máximo 99.99.** |
| `commissionOnPenalty` | `^[0-9]+(\.[0-9]{1,3})?$` | Comisión cobrada **sobre la penalidad**. |
| `waiverCode` | `^[A-Z0-9]{1,20}$` | *«Typically a waiver code will be supplied by the airline for the agent to use to **override a cancel fee**.»* |
| `tourCode` | `^[A-Z0-9]{1,15}$` | Sobrescribe el tour code del billete original. |
| `splitRefundAmounts[]` | `SplitRefundAmount` (`:4226`) | **El reembolso de un billete emitido con dos FOP.** El orden debe coincidir con el de emisión. Se aceptan ceros. |
| `journeyTypeCode` | `B` \| `F` \| `M` | **Sólo BSP Francia y Canadá**, obligatorio en doméstico. |

**Corrección de contrato, importante para el ACL:** la colección envía **`commissionPercent`** (3 requests, verificado en `requests.jsonl`). **El contrato dice `commissionPercentage`** (`:4169`). Los dos ejemplos de la colección que usan `commissionPercent` están, por tanto, **mandando un campo que Sabre no reconoce** — y como Swagger no rechaza propiedades desconocidas por defecto, muy probablemente lo ignora en silencio y aplica la comisión original del billete. **La primera pasada documentó el nombre equivocado en su tabla §4.2 y en las firmas del port. Corregido aquí y en §8.** Es exactamente el tipo de bug que la propia colección introduce en el código de quien la copia.

`waiverCode` y `commissionOnPenalty` no aparecen en ninguna parte de la colección y son **material nuevo de negocio**: el `waiverCode` es el mecanismo por el que una aerolínea autoriza a una agencia a saltarse una penalidad (típico en cancelaciones por causa mayor, cambios de horario, muerte de familiar). Un consolidador lo necesita.

### 4.3 Respuesta — `CheckTicketsResponse` (**el mayor agujero de la primera pasada, cerrado**)

**VERIFICADO-SPEC: `booking-management-v1.yml:660`.**

```
timestamp      string date-time
request        CheckTicketsRequest   eco
tickets[]      CheckedTicket         un elemento por billete, EN EL ORDEN DEL REQUEST
errors[]       Error
cancelOffers[] CancelOffer           opciones de cancelación para órdenes NDC
flightRefunds[] FlightRefund         reembolsos de reservas LCC
```

**`CheckedTicket` (`:8496`) = `Ticket` (`:6533`) + `refundFee` + `ticketStatusCode`.**

**`Ticket` — la estructura que la primera pasada dio por desconocida:**

| Campo | Tipo | Notas del contrato |
| --- | --- | --- |
| `number` | `^[0-9A-Z/-]+$` | |
| **`isVoidable`** | boolean | *«the electronic document meets the requirements for the void procedure»*. **No soportado en NDC.** Para ATPCO se basa en el estado de cupón **y en la validación del periodo de void contra `VoidTicketLLS`.** ← §5.3 |
| **`isRefundable`** | boolean | *«fully or partially refundable»*. **Si el `source` de la penalidad es `Category 16`, la reembolsabilidad NO está garantizada.** No soportado en NDC. |
| **`isAutomatedRefundsEligible`** | boolean | Si cumple los requisitos de reembolso automatizado. |
| **`isChangeable`** | boolean | *«the fare can be exchanged with or without additional cost»*. Misma advertencia de `Category 16`. |
| `refundPenalties[]` | `PenaltyItem` (`:4642`) | Estimación. **Asume la penalidad más alta posible.** |
| `exchangePenalties[]` | `PenaltyItem` | Estimación. **Asume que cambian todos los componentes tarifarios.** |
| `refundTaxes[]` | `Tax` | Sólo en Automated Refunds. |
| `refundTotals` | `TotalValues` (`:4073`) | `subtotal`, `taxes`, `fees`, `total`, `currencyCode`, `netRemit`. |
| `refundFee` | `RefundFee` (`:8515`) | `amount`, `currencyCode`, `taxes[]` — **la tasa de cancelación con su IVA/GST desglosado.** |
| `ticketStatusCode` | `^[A-Z]{1,2}$` | §10. |

**`PenaltyItem` (`:4642`), `required: [applicability, penalty]`:**

| Campo | Valores |
| --- | --- |
| `applicability` | `BEFORE_DEPARTURE` \| `AFTER_DEPARTURE` (`:9086`) |
| `penalty` | `Value` = `{ amount, currencyCode }` |
| `conditionsApply` | boolean — *«additional restrictions apply»* |
| `hasNoShowCost` | boolean |
| `noShowPenalty` | `NonShowPenalty` (`:4675`) = `{ penalty, source }` |
| `source` | `PenaltySourceEnum` (`:8898`): `Category 33` \| `Category 31` \| `Category 16` \| `Unknown` |

**Respuesta real oficial** (`help-documentation-check-flight-tickets-examples.txt`, caso 1, billete CX 1607958830515), recortada:

```json
{ "timestamp": "2023-07-05T13:57:53",
  "request": { "tickets": [ { "number": "1607958830515" } ] },
  "tickets": [ {
    "number": "1607958830515",
    "isVoidable": true, "isRefundable": true, "isAutomatedRefundsEligible": true,
    "refundPenalties": [
      { "applicability": "BEFORE_DEPARTURE", "conditionsApply": false,
        "penalty": { "amount": "222.0", "currencyCode": "USD" },
        "hasNoShowCost": true,
        "noShowPenalty": { "penalty": { "amount": "518.0", "currencyCode": "USD" }, "source": "Category 33" },
        "source": "Category 33" },
      { "applicability": "AFTER_DEPARTURE", "…": "…" } ],
    "refundTaxes": [ { "taxCode": "YR", "amount": "41.20" }, { "taxCode": "SG", "amount": "32.10" } ],
    "refundTotals": { "subtotal": "681.00", "taxes": "121.00", "total": "802.00", "currencyCode": "USD" },
    "isChangeable": true,
    "exchangePenalties": [
      { "applicability": "BEFORE_DEPARTURE", "conditionsApply": false,
        "penalty": { "amount": "74.0", "currencyCode": "USD" },
        "hasNoShowCost": true,
        "noShowPenalty": { "penalty": { "amount": "370.0", "currencyCode": "USD" }, "source": "Category 31" },
        "source": "Category 31" } ] } ] }
```

**Tres advertencias que la UI de post-venta tiene que respetar** (todas VERIFICADO-SPEC, salen literalmente del contrato):

1. **Las penalidades son estimaciones pesimistas.** *«Estimates assume the highest possible refund penalty is applied»* / *«assume that all fare components are changed»*. **Lo que se le muestra al vendedor es un techo, no el importe final.** Etiquetarlo como "hasta" y nunca como cifra cerrada.
2. **`source: "Category 16"` invalida el booleano.** *«If the penalty source parameter indicates Category 16, refundability is not guaranteed»* (y lo mismo para cambiabilidad). El mapper tiene que degradar `isRefundable: true` + `source: "Category 16"` a un tercer estado, **no a `true`**. En nuestro port es el `'UNKNOWN'` de `TicketRules` (§8) — y ahora sabemos exactamente cuándo emitirlo.
3. **`isVoidable` e `isRefundable` no existen en NDC.** El contrato dice *«Not supported for NDC»* en ambos. En NDC la información equivalente vive en `cancelOffers[]`.

**`CancelOffer` (VERIFICADO-SPEC `:6504`)** — la parte NDC:

| Campo | Nota |
| --- | --- |
| `offerType` | `CancelOfferTypeEnum` (`:8890`): **`VOID`** \| **`REFUND`** |
| `offerItemId` | *«This ID must be applied when cancelling an order to receive a refund or void»* — va a `cancelBooking.offerItemId` (`:418`). Origen: `/v1/offers/reshop/cancelOrder`. |
| `offerExpirationDate` | date |
| `offerExpirationTime` | `^[0-9]{2}:[0-9]{2}$`, **en UTC** |
| `refundTotals` | `TotalValues` |

**Éste es el dato que resuelve la ventana de void en NDC, y es explícito y sin ambigüedad de huso:** ejemplo oficial —

```json
{ "request": { "confirmationId": "1SXXXCITUW8P4" },
  "cancelOffers": [ { "offerType": "VOID", "offerItemId": "cb7778589bcbb4hpnkmkhp4ya1",
                      "offerExpirationDate": "2021-03-22", "offerExpirationTime": "11:53" } ] }
```

con el comentario oficial: *«In this example we are still in the void period, and the only option to use is offerType: "VOID"»*. Cuando la ventana pasa, `offerType` cambia a `REFUND`. **En NDC no calculamos la ventana: la leemos, con hora UTC.**

**Se confirma el hallazgo de la primera pasada** de que `cancelOffers[].offerItemId` es el insumo obligatorio del `cancelBooking` NDC (era VERIFICADO por script; ahora es VERIFICADO-SPEC por contrato). Y se confirma que **en NDC `checkFlightTickets` no es opcional.**

### 4.4 Errores de check que importan

| `type` | `category` | Significado |
| --- | --- | --- |
| `ORDER_NOT_FULFILLED` / `BOOKING_NOT_FULFILLED` | `CHECK_ERROR` | No hay nada que chequear: aún no se emitió. |
| `ORDER_VOIDED` / `ORDER_REFUNDED` | `CHECK_ERROR` | Ya anulada / reembolsada. **Es un estado terminal, no un fallo.** |
| `SCENARIO_NOT_SUPPORTED` | `CHECK_ERROR` | PNR con NDC **y** ATPCO. También: PNR con ATPCO **y** LCC. |
| `TICKETS_NOT_FULFILLED` | `WARNING` | *«There are no ATPCO tickets to be checked. Only LCC segments were processed.»* |
| `UNABLE_TO_CHECK_TICKET` (`ACTL`) | `CANCELLATION_ERROR/WARNING` | *«Coupons[%s] of the document are currently **under airport control**. Ticket refund eligibility cannot be verified.»* **Escalar a humano: el aeropuerto tiene el cupón.** |
| `INTERNAL_SERVER_TIMEOUT` | `APPLICATION_ERROR` | *«Request to the supplier airline %s has timed out.»* Es la aerolínea, no Sabre. Reintentable. |

También hay que anotar: si se piden 12 documentos y sólo un PNR de un híbrido con Order ID, Sabre exige el **PNR locator**, no el Order ID (`SCENARIO_NOT_SUPPORTED`). **Regla del adapter: para post-venta, guardar y usar siempre el PNR locator, no el Order ID.**

---

## 5. `voidFlightTickets` — anulación

```
POST {{rest_endpoint}}/v1/trip/orders/voidFlightTickets
```

**4 requests VERIFICADO. Contrato: `:64` (`operationId: voidTickets`), request `:488`, response `:535`.** Descripción oficial: *«Voids tickets with ticket numbers listed in the request, optionally including nonelectronic tickets (paper).»*

### 5.1 Request — `VoidTicketsRequest` (VERIFICADO-SPEC `:488`)

| Campo | Restricción | Nota |
| --- | --- | --- |
| `tickets[]` | array de **strings planos**, patrón `^[0-9A-Z]{13}(/[0-9]{2})?$`, **hasta 12** | Números de billete **o EMD**. |
| `confirmationId` | `^[A-Z0-9]{6,}$` | **SÍ EXISTE.** Excluyente con `tickets`. |
| `errorHandlingPolicy` | `CancelErrorPolicyEnum`, default `HALT_ON_ERROR` | §5.2. |
| `targetPcc` | `^[A-Z0-9]{3,4}$` | |
| `receivedFrom` | string, default `'LW CANCEL API'` | |
| `designatePrinters[]` | `PrinterAddress` | |
| `notification` | `Notification` | `email` **o** `queuePlacement`, nunca ambos. |
| `voidNonElectronicTickets` | boolean, default `false` | **Billetes de papel (tipo `TK`).** |

**La pregunta 6 de la primera pasada queda cerrada: `voidFlightTickets` SÍ acepta `confirmationId`.** La primera pasada infirió correctamente que "o el endpoint no lo acepta, o la colección no lo ejemplifica" — era lo segundo. Y hay un matiz que la colección no podía dar: **los billetes de papel SÓLO se pueden anular con `confirmationId`** (*«Paper tickets can only be voided if the request contains a confirmationId»*).

**Se confirma la asimetría de tipos** que la primera pasada detectó: `tickets` es **array de strings** en void, y **array de objetos `{number, refundQualifiers}`** en check y refund. VERIFICADO-SPEC: `:488` vs `:4135`. No era un error de transcripción, es el contrato. El ACL debe tener dos serializadores.

**Dato operativo nuevo (VERIFICADO-SPEC):** antes de anular, Sabre clasifica los documentos en **cuatro cubos** y los procesa en ese orden: (1) billetes sueltos, (2) EMD sueltos (tipo S), (3) billetes con EMD asociado (tipo A) + sus EMD, (4) billetes de papel. **Tras cada void ejecuta `EnhancedEndTransactionRQ`.** Y una nota de configuración que hay que pasar al equipo de operaciones Sabre: *«This feature requires AUTO-END and AUTO-ER settings to be inactive.»*

### 5.2 `errorHandlingPolicy` — la pregunta 7, cerrada… y con una contradicción del propio Sabre

**VERIFICADO-SPEC (`:8942` + doc oficial de void y de refund):**

| Política | Comportamiento oficial |
| --- | --- |
| `HALT_ON_ERROR` (**default**) | *«Execution is stopped in case an error is encountered, **a rollback is executed** if some products were successfully executed to ensure the original state of the reservation is preserved.»* |
| `ALLOW_PARTIAL_CANCEL` | *«Execution continues even when some products failed to cancel.»* |

**Pero la misma página, en su última línea, dice lo contrario:** *«Since void transaction is **irreversible**, a failure with one of the documents might return an error, but **previously processed documents are voided**.»*

**Las dos frases no pueden ser ambas ciertas.** Y la segunda es la que coincide con la arquitectura descrita (commit `EnhancedEndTransactionRQ` **tras cada documento**, §1.5): si cada void se commitea individualmente, no hay rollback posible.

**Nuestra lectura, y la regla de diseño que se deriva:** el "rollback" de `HALT_ON_ERROR` se refiere a los cambios *no ticketing* de la reserva, no a los documentos anulados. **Hay que asumir estado mixto en cualquier caso.** Concretamente:

- `order_operations` registra **por documento**, no por operación (esto ya estaba bien en la primera pasada).
- Tras cualquier error de void, **reconciliar con `getBooking` antes de decidir nada**. Nunca deducir el estado de los demás documentos a partir del error del que falló.
- Preferir `ALLOW_PARTIAL_CANCEL` por defecto en post-venta unitaria: **al menos entonces los fallos vienen como warnings identificables por documento**, en lugar de como un error de lote que oculta qué se procesó.

**Dependencia oficial entre política y categoría (VERIFICADO-SPEC, y es la clave del mapper):**

> *«The error type `UNABLE_TO_VOID_TICKET` can be returned with the category `CANCELLATION_ERROR`, as well as with a `WARNING`. The category depends on the ErrorHandlingPolicy sent in the request. For `HALT_ON_ERROR`, `CANCELLATION_ERROR` displays, and for `ALLOW_PARTIAL_CANCEL`, `WARNING` displays.»*

Es decir: **el mismo fallo cambia de canal según la política que mandamos**. Un mapper que sólo mire `errors[]` perderá todos los fallos cuando usemos `ALLOW_PARTIAL_CANCEL`. Idéntico en refund con `UNABLE_TO_REFUND_TICKET`. **Regla: mapear por `type`, siempre; leer `errors[]` y `warnings[]` juntos, siempre.**

Y una advertencia oficial explícita contra el falso negativo: *«errors returned by downstream APIs may suggest that the entire void process has failed. However, this is not quite true.»*

### 5.3 La ventana de void — **la pregunta con más impacto operativo, ahora respondida a medias**

La primera pasada escribió: *«No hay absolutamente ninguna evidencia sobre la ventana de void en la colección»* y luego infirió *«medianoche en la zona horaria del PCC emisor»*. **Lo primero era cierto. Lo segundo sigue sin estar confirmado — el contrato NO publica la regla.** Pero el contrato cambia radicalmente cómo debemos tratarla.

**Lo que SÍ está VERIFICADO-SPEC ahora:**

1. **Sabre valida el periodo de void del lado servidor, en tres endpoints.** *«The analysis includes the **void period**, coupon status, and whether all documents belong to the same reservation»* (doc de void); *«the application verifies void requirements for ATPCO tickets… This analysis includes checking the **void period**»* (doc de check).
2. **El resultado se expone como un booleano legible por API: `tickets[].isVoidable`.** Y el contrato dice de dónde sale: *«based on the Coupon Status… **and validation of the void period based from the `VoidTicketLLS` response**»* (`:6533`).
3. **El fallo tiene un error con nombre propio:** `UNABLE_TO_VOID_TICKET` / *«The ticket is **outside of the void period**. Please follow refund procedures.»*
4. **En NDC la ventana viene con fecha y hora explícitas y en UTC:** `cancelOffers[].offerExpirationDate` + `offerExpirationTime` (*«in UTC»*), y el `offerType` conmuta de `VOID` a `REFUND` (§4.3).

**Lo que sigue DESCONOCIDO:** la **regla de cálculo** para ATPCO. Ni el contrato ni las 81 páginas oficiales publican "hasta medianoche del PCC emisor" ni ninguna otra fórmula, ni exponen un campo `voidableUntil` para ATPCO. Sólo el booleano.

**Corrección de enfoque frente a la primera pasada — y es la corrección más importante de esta sección.** La primera pasada proponía **calcular** la ventana nosotros, guardando `ticketingPccTimezone` en `provider_accounts.config`. **Eso es ahora la peor opción disponible**, porque:

- Sabre **ya la calcula**, con la regla real de la aerolínea y del BSP, y nos la da en `isVoidable`. Duplicarla con una heurística de "medianoche del PCC" garantiza divergencia.
- Una heurística que diga `voidable = true` cuando Sabre dice `false` produce **una promesa incumplida al cliente**. Una que diga `false` cuando Sabre dice `true` produce **una penalidad regalada**. Los dos errores cuestan dinero.

**Regla de diseño revisada:**

1. **Fuente de verdad = `checkFlightTickets`.** `isVoidable` (ATPCO) y `cancelOffers[].offerType === "VOID"` (NDC). **Nunca calcular la voidabilidad nosotros.**
2. **NDC: el contador es exacto.** `offerExpirationDate` + `offerExpirationTime` en UTC → cuenta atrás real en la UI. Sin ambigüedad de huso.
3. **ATPCO: no hay contador, hay un semáforo.** La UI muestra "Anulable ahora" / "Ya no anulable — sólo reembolso", con la marca de tiempo de la última consulta y un botón de refrescar. **Prohibido mostrar un contador ATPCO inventado.**
4. **Toda automatización de void tiene deadline duro y re-chequeo.** Un reintento con backoff que cruce la ventana **no falla: cambia de operación** (deja de ser void gratis y pasa a ser reembolso con penalidad). El worker debe **re-llamar a `checkFlightTickets` antes de cada intento** y abortar escalando a humano si `isVoidable` pasó a `false`.
5. **`ticketingPccTimezone` sigue en `provider_accounts.config`, pero degradada de "cálculo" a "presentación".** Sirve para mostrar horas en la zona correcta al operador y para el corte contable, no para decidir voidabilidad.

**La evidencia de que el problema de husos es real, y ahora es VERIFICADA, no inferida:** los cuatro cuerpos guardados de `/v1/orders/view` (`slices/responses/*.json`) traen `order.paymentTimeLimit = "2019-04-19T20:37:00"` y `order.orderItems[0].ticketingTimeLimit = "2019-04-19T20:37:00"` — **ISO local sin offset**. Y `FutureTicketingPolicy` (`:4767`) parte la fecha límite en `ticketingDate` + `ticketingTime` (`HH:MM`), **también sin zona**, aunque sí trae el `ticketingPcc` al lado. Es decir: **Sabre expresa todos sus plazos de ticketing en hora local del PCC, sin decirlo.** Ese es el dato duro que justifica guardar la zona del PCC — para el TTL de emisión, que sí calculamos nosotros, no para la ventana de void, que no.

### 5.4 Void por PNR vía `cancelBooking`

Camino alternativo, **VERIFICADO** en WF-06, WF-16, WF-17 y `Basic flow ATPCO`:

```json
{ "confirmationId": "{{pnr}}", "retrieveBooking": true, "cancelAll": true,
  "flightTicketOperation": "VOID", "errorHandlingPolicy": "ALLOW_PARTIAL_CANCEL" }
```

`flightTicketOperation` acepta `"VOID"` (9 usos) y `"REFUND"` (2 usos). **Cancelar la reserva y anular/reembolsar los documentos en una sola llamada del lado de Sabre** reduce la ventana de inconsistencia frente a orquestar dos llamadas desde nuestro worker. Se mantiene la recomendación de la primera pasada.

El contrato añade tres cosas a `CancelBookingRequest` que no estaban documentadas (VERIFICADO-SPEC `:380-478`):

- **`offerItemId`** — *«Contains Id for a void or refund offer available based on `checkFlightTicketsResponse`… **Applicable only for NDC orders**»*. Es el puente NDC.
- **`refundDocumentsType`** (`DocumentsTypeEnum`) y **`voidNonElectronicTickets`** — mismos calificadores que en los endpoints dedicados.
- **La respuesta `CancelBookingResponse` trae `voidedTickets[]`, `refundedTickets[]`, `tickets[]` (`Ticket`) y `flightRefunds[]`** — es decir, **la misma información de resultado que los endpoints dedicados**. No perdemos observabilidad usando este camino.

---

## 6. `refundFlightTickets` — reembolso

```
POST {{rest_endpoint}}/v1/trip/orders/refundFlightTickets
```

**7 requests VERIFICADO. Contrato: `:89` (`operationId: refundTickets`), request `:562`, response `:606`.**

### 6.1 Request — `RefundTicketsRequest` (VERIFICADO-SPEC `:562`)

| Campo | Restricción | Nota |
| --- | --- | --- |
| `tickets[]` | `RefundFlightTicket` (`:4135`), **minItems 1, maxItems 12** | `{ number, refundQualifiers }`. |
| `confirmationId` | `^[A-Z0-9]{6,}$` | Excluyente con `tickets`. *«The application will apply the tickets from the entire reservation.»* |
| `documentsType` | `DocumentsTypeEnum` (`:9422`) | **`Tickets` (default) \| `EMDs` \| `Tickets and EMDs`.** |
| `errorHandlingPolicy` | `CancelErrorPolicyEnum`, default `HALT_ON_ERROR` | |
| `targetPcc` | `^[A-Z0-9]{3,4}$` | **Sí lo acepta.** |
| `receivedFrom` | default `'LW CANCEL API'` | |
| `designatePrinters[]` | `PrinterAddress` | |
| `notification` | `Notification` | |

**La pregunta 8 de la primera pasada queda cerrada.** El [INFERIDO] era correcto: **`"Tickets"` existe, y además es el default.** Los tres valores exactos, con esas mayúsculas y ese espacio, son `Tickets`, `EMDs`, `Tickets and EMDs`. El error `INVALID_DOCUMENT_TYPE` (*«documentsType does not match the type of the submitted document»*) confirma que hay validación cruzada contra los documentos enviados.

**Prerrequisito comercial que no estaba en el análisis y es bloqueante (VERIFICADO-SPEC):**

> *«This feature requires that the issuing carrier participates in **Automated Refunds** and that the feature is supported in your market. Additionally, the feature Automated Refunds **has to be ordered for your agency through Sabre Central**.»*

Con error propio: `AUTOMATED_REFUNDS_INACTIVE` (`UNAUTHORIZED`) — *«The Automated Refunds feature is inactive for your PCC. For activation, please place an order in Sabre Central.»*

**Esto es una dependencia de aprovisionamiento por PCC, y con BYOC significa por agencia de la red.** Un consolidador con 40 agencias tiene 40 activaciones que gestionar. Va a `Decisiones`.

### 6.2 Ejemplos verificados de la colección

**Sólo EMD, por lista** (`Workflows / 26 - ATPCO - Refund ancillaries with list of tickets / Refund with ancillary`):

```json
{ "errorHandlingPolicy": "ALLOW_PARTIAL_CANCEL", "documentsType": "EMDs",
  "tickets": [ { "number": "{{ancillaryTicketNumberToRefund1}}" } ],
  "designatePrinters": [ { "hardcopy": { "address": "498BF1" } }, { "ticket": { "countryCode": "AT" } } ] }
```

**Billetes + EMD, por PNR** (`Workflows / 27 … / Refund`) — **la forma que queremos como default**:

```json
{ "errorHandlingPolicy": "ALLOW_PARTIAL_CANCEL", "documentsType": "Tickets and EMDs",
  "confirmationId": "{{pnr}}",
  "designatePrinters": [ { "hardcopy": { "address": "498BF1" } }, { "ticket": { "countryCode": "AT" } } ] }
```

> **Ejemplo mal mantenido, confirmado.** `Flight Tickets (Check/Void/Refund) / Refund Flight Tickets confirmationId EMD only` tiene un body idéntico al de `Refund Flight Tickets with refundQualifiers` — lleva `tickets[]` y **ningún** `confirmationId`, pese al nombre. Verificado sobre `requests.jsonl`. Además usa el campo inexistente `commissionPercent` (§4.2). No usarlo como referencia.

### 6.3 Respuesta — `RefundTicketsResponse` (VERIFICADO-SPEC `:606`)

```
timestamp        string date-time
request          RefundTicketsRequest   eco
tickets[]        Ticket                 elegibilidad e importes, EN EL ORDEN DEL REQUEST
errors[]         Error
refundedTickets[] string                los números efectivamente reembolsados
```

Ejemplo real oficial:

```json
{ "request": { "targetPcc": "7KFA", "tickets": [ { "number": "0143357868284" }, { "number": "0143357868285" } ] },
  "tickets": [
    { "number": "0143357868284", "isVoidable": true, "isRefundable": true,
      "refundTotals": { "subtotal": "778.00", "taxes": "71.90", "total": "849.90", "currencyCode": "GBP" } },
    { "number": "0143357868285", "…": "…" } ],
  "refundedTickets": [ "0143357868284", "0143357868285" ] }
```

**`refundedTickets[]` es la lista de éxitos.** Junto con `tickets[]` (que trae los importes) da el `DocumentOutcome[]` que nuestro port necesita, sin adivinar: **lo que está en `tickets[]` pero no en `refundedTickets[]` falló**, y el motivo está en `errors[]`/`warnings[]` con `type: UNABLE_TO_REFUND_TICKET`. Lo mismo en void con `voidedTickets[]` (`:535`).

**Refutación parcial de un "VERIFICADO" de la primera pasada.** Se afirmaba, citando el script de WF-26:

```js
pm.test("Exactly one error is present", function () { pm.expect(response.errors.length).to.equal(8); });
```

que *«`errors[]` existe en la respuesta (VERIFICADO)»* y *«este test espera que el reembolso falle con 8 errores — es un caso negativo deliberado»*. **`errors[]` sí existe** (VERIFICADO-SPEC `:606`), pero la interpretación del test es equivocada: el **nombre** del test dice "exactly one error" y la **aserción** compara con `8`. Es el mismo patrón de test descuidado que la propia primera pasada detectó en WF-14 ("TV" vs `OV`). **No es un caso negativo deliberado: es un test roto.** No hay que inferir nada de él, salvo que `errors` es un array. Y el contrato ya lo dice mejor: *«This array is not displayed in successful responses»* — es decir, **en una respuesta exitosa `errors` no viene, ni siquiera vacío**. El mapper debe usar `response.errors ?? []`.

### 6.4 Errores de refund que importan

| `type` | `category` | Significado |
| --- | --- | --- |
| `AUTOMATED_REFUNDS_INACTIVE` | `UNAUTHORIZED` | Feature no contratada para el PCC. §6.1. |
| `QUALIFIERS_NOT_ALLOWED` | `BAD_REQUEST` | *«No qualifiers are available for Infini (1F) customers.»* |
| `INVALID_REFUND_QUALIFIER_FOR_AN_EMD` | `BAD_REQUEST` | *«property %s cannot be combined with an EMD document number»*. **Los `refundQualifiers` no aplican a EMD.** |
| `INVALID_COMMISSION_AMOUNT` / `_PERCENTAGE` | `BAD_REQUEST` | Máximos duros: **9999.99** y **99.99**. |
| `EMD_STATUS_INVALID` | `BAD_REQUEST` | EMD ya reembolsado o anulado. |
| `LCC_SEGMENTS_PARTIALLY_FULFILLED_WARNING` | `WARNING` | *«Only fulfilled segments were processed.»* Estado mixto en LCC. |
| `REFUND_RETRY_FAILED` / `SYSTEM_PROVIDER_MISSING` | `WARNING` / `APPLICATION_ERROR` | Transitorios, reintentables. |
| `NDC_NOT_SUPPORTED` | `REQUEST_NOT_ALLOWED` | Reembolso NDC → `cancelBooking`. |

---

## 7. Comisiones, PCC de emisión e impresoras — encaje con el modelo consolidador

### 7.1 Los tres identificadores de "quién emite"

| Variable de entorno | Valor en CERT | Aparece en | Qué representa |
| --- | --- | --- | --- |
| `pcc` | `""` | `SessionCreateRQ`, `SessionCloseRQ`, `voidFlightTickets - Change PCC` | PCC de trabajo / sesión. |
| `pcc_tkt` | `"{{your_target_pcc}}"` | `fulfillFlightTickets` (2×), `cancelBooking` (1×) como `targetPcc` | **PCC dedicado de emisión.** |
| `ptrta` | `"{{atpco_printer_address}}"` | **Ninguna. Cero apariciones (VERIFICADO).** | Dirección de impresora ATPCO. |

`pcc_tkt` y `ptrta` son **2 de las únicas 6 variables del entorno con valor** (de 425; las otras 4 son `username`, `lls_endpoint`, `soap_endpoint`, `rest_endpoint`). Que Sabre haya dejado precargados justo el PCC de ticketing y la dirección de impresora ATPCO indica que **son los dos parámetros que todo integrador tiene que configurar por cliente**. Los valores son placeholders auto-descriptivos, no credenciales.

**Sobre `ptrta` vs `hardcopy` (pregunta 10 de la primera pasada):** el contrato no conoce ninguno de los dos nombres — son variables de Postman, no campos del API. Lo que el contrato sí aclara es que `PrinterAddress` tiene **cuatro** slots distintos (`profileNumber`, `hardcopy`, `invoiceItinerary`, `ticket`) y que `hardcopy.address` y `ticket.address` son **LNIATA de 6 caracteres, ambos**. **[INFERIDO, con más base que antes]** `ptrta` ("printer address, ATPCO") probablemente corresponde a `ticket.address`, que la colección **nunca** rellena (usa sólo `ticket.countryCode`). Eso explicaría por qué `ptrta` está precargada y sin usar: es el slot que la colección deja vacío. Confirmar en sandbox.

**Cuidado con `targetPcc` (VERIFICADO-SPEC, `:380` y `:912`):** el contrato dice *«Context is not reverted after
the booking has been completed»*, pero las guías declaran Booking Management stateless y limpian AAA con ATH.
La persistencia entre llamadas ATK queda **DESCONOCIDA** hasta CERT. **Regla defensiva:** enviar `targetPcc`
explícito en toda operación y nunca depender de contexto heredado.

### 7.2 Los headers de PCC

**VERIFICADO** — dos headers acompañan a muchos requests: `X-Sabre-Group` y `X-Sabre-Current-City`, con valores `U9PK` (138 usos cada uno) y `G7RE` (76 usos cada uno).

**Ninguno de los dos aparece en el contrato OpenAPI**, que sólo declara el header `Authorization` (VERIFICADO-SPEC, los cuatro bloques `parameters` de `:64`, `:89`, `:114`, `:140`). Es decir: **son headers no contractuales**, probablemente resueltos en el gateway y dependientes del EPR del token.

Detalle observado y no explicado: en `Workflows / 26 … / Refund with ancillary` el script pre-request **borra los headers** antes de reembolsar:

```js
pm.request.headers.remove("X-Sabre-Current-City");
pm.request.headers.remove("X-Sabre-Group");
```

**Nuestra lectura, [INFERIDO] pero coherente con el contrato:** `targetPcc` en el body ejecuta un `ContextChangeLLSRQ` interno (VERIFICADO-SPEC, está en la lista de orquestación de los cuatro endpoints); los headers fijan el contexto en el gateway. **Mandar ambos con valores distintos es pedirse un conflicto**, y por eso el ejemplo de Sabre borra los headers cuando el body manda. **Regla del adapter: usar `targetPcc` en el body, no enviar nunca esos headers.** Confirmar con Sabre.

### 7.3 Los puntos donde se fija la comisión — tabla corregida

| Momento | Endpoint | Campo | Restricción del contrato |
| --- | --- | --- | --- |
| Al tarifar (crear el PQ) | `createBooking` | `flightPricing[].qualifiers.commissionPercentage` | — |
| Al emitir | `fulfillFlightTickets` | `ticketingQualifiers.commissionAmount` **o** `.commissionPercentage` | Mutuamente excluyentes. `%` ≤ 2 dígitos enteros. |
| Al emitir (comisión extra vía BSP) | `fulfillFlightTickets` | `ticketingQualifiers.netRemit.*` | Comisión adicional pagada por la validadora. |
| Al simular reembolso | `checkFlightTickets` | `refundQualifiers.commissionAmount` \| `.commissionPercentage` \| `.commissionOnPenalty` | ≤ 9999.99 / ≤ 99.99. |
| Al reembolsar | `refundFlightTickets` | idem | idem. **No aplicable a EMD.** |

**Corrección:** la primera pasada escribió *«nótese la inconsistencia de nombres de Sabre: `commissionPercentage` (booking) vs `commissionPercent` (refund)»*. **No hay tal inconsistencia: el contrato usa `commissionPercentage` en los cuatro sitios.** `commissionPercent` es un error de la colección (§4.2). El ACL normaliza a un concepto canónico, pero por buenas prácticas, no por incoherencia del proveedor.

### 7.4 Encaje con el modelo consolidador (`docs/platform/12-modelo-consolidador-y-plan.md`)

El doc 12 §3.2 define `provider_accounts.config JSONB` (*"PCC/pseudo-city, IATA, agencyId, endpoints…"*) y remata: *"La marca de **quién emite** queda registrada por la cuenta usada"*. Los campos concretos para Sabre, actualizados:

```jsonc
// provider_accounts.config para provider_code = 'sabre'
{
  "pcc": "U9PK",                          // PCC de trabajo / sesión
  "ticketingPcc": "G7RE",                 // -> targetPcc en fulfill / void / refund / check / cancelBooking
  "ticketingPccTimezone": "America/Bogota",// PRESENTACION y TTL de emision; NO para calcular voidabilidad (§5.3)
  "printerHardcopyAddress": "498BF1",     // -> designatePrinters[].hardcopy.address (LNIATA, 6 chars)
  "printerTicketAddress": null,           // -> designatePrinters[].ticket.address (LNIATA) — el slot que la coleccion nunca usa
  "printerCountryCode": "CO",             // -> designatePrinters[].ticket.countryCode (pais del STOCK de billetes)
  "printerProfileNumber": null,           // excluyente con los tres anteriores
  "defaultCommissionPercentage": "0.00",  // ojo: 'Percentage', no 'Percent'
  "automatedRefundsEnabled": false,       // NUEVO: activacion por PCC en Sabre Central (§6.1)
  "netRemitAgreementCode": null,          // NUEVO: contrato de tarifa neta, si lo hay (§2.6)
  "bspCountry": "CO"                      // NUEVO: gobierna split FOP, INSTALLMENTS (BR), journeyTypeCode (FR/CA)
}
```

La resolución jerárquica del doc 12 §3.2 (nodo propio → ancestro heredable → error) aplica tal cual: **una sub-agencia sin contrato BSP propio emite bajo el `ticketingPcc` del consolidador; una agencia IATA con PCC propio emite bajo el suyo.** El `targetPcc` del body es la materialización técnica de esa decisión de negocio, y `tickets[].ticketingPcc` de la respuesta de fulfill es **la prueba de auditoría de que se emitió donde debía** (VERIFICADO-SPEC `:7965`) — un campo que la primera pasada no conocía y que cierra el bucle de conciliación BSP.

**Cuatro consecuencias que hay que añadir al doc 12:**

1. **La comisión de emisión y el waterfall de precios son cosas distintas.** El `commissionAmount`/`commissionPercentage` de fulfill es la comisión **BSP** que la aerolínea reconoce a la agencia acreditada, liquidada en el BSP contra el PCC emisor. El waterfall del doc 12 §3.3 es **nuestro** margen sobre el precio de venta. Circuitos distintos; confundirlos rompe la conciliación BSP (gap P0 §4.4). En `provider_accounts.config` va la BSP; en `markup_rules`, el waterfall.
2. **`overrideCancelFee`, `waiverCode` y `commissionOnPenalty` son decisiones de permisos.** Un valor mal puesto es dinero regalado. Detrás de rol (`consolidator_admin`/`agency_admin`, **nunca** `vendedor`) y con registro en `domain_events` con actor. `waiverCode` además tiene implicación contractual con la aerolínea: usarlo sin autorización es incumplimiento.
3. **`automatedRefundsEnabled` es un prerrequisito de aprovisionamiento por nodo.** Sin él, `refundFlightTickets` devuelve `UNAUTHORIZED` para esa agencia. La UI tiene que saberlo *antes* de ofrecer el botón.
4. **`bspCountry` gobierna capacidades, no sólo fiscalidad.** Split FOP sólo con BSP; `INSTALLMENTS` sólo Brasil; `journeyTypeCode` obligatorio en Francia y Canadá; `spanishLargeFamilyDiscountLevel` en España. Con cobertura CO+PE+BR, el "parcelado" brasileño (`numberOfInstallments`, `airlinePlanCode`) es **una capacidad de venta real que hoy no está en el roadmap.**

---

## 8. Qué NO existe hoy en nuestro dominio, y la propuesta

### 8.1 Diagnóstico (re-verificado en el repo, sin cambios)

**4 ports en `C:\Users\USER\Desktop\Projects\sales-travel\packages\domain\src\ports\`:**

| Port | Cubre |
| --- | --- |
| `flight-search.port.ts` → `FlightSearchPort` | búsqueda |
| `offer-price.port.ts` → `OfferPricePort` | precio en firme |
| `order-create.port.ts` → `OrderCreatePort` | creación de orden |
| `order-manage.port.ts` → `OrderManagePort` | `retrieveOrder`, `cancelOrder`, `cancelBnplOrder`, `payOrder`, `listServices`, `reshopWithTickets` |

**No existe ningún port de ticketing, void ni refund.** Lo más cercano es `OrderManagePort.payOrder()` y `OrderRetrieveResult.ticketNumbers?: string[]` — un `string[]` suelto, sin tipo de documento, sin estado, sin importe, sin PCC emisor. Insuficiente en cuanto entren EMD y reembolsos parciales.

En la capa de aplicación (`C:\Users\USER\Desktop\Projects\sales-travel\apps\api\src\orders\`) hay infraestructura reutilizable: la tabla `order_operations` (migración 0021), `post-sale.worker.ts` (BullMQ, 5 intentos con backoff exponencial, degradación elegante sin Redis), y en `C:\Users\USER\Desktop\Projects\sales-travel\apps\api\src\database\database.types.ts:432`:

```ts
export type OrderOperationType = 'cancel' | 'pay' | 'reshop' | 'retrieve';
```

**Faltan `issue`, `void` y `refund`**, y falta que el worker sepa que el void tiene deadline y **que hay que re-verificar `isVoidable` antes de cada intento** (§5.3).

### 8.2 Propuesta: `packages/domain/src/ports/ticketing.port.ts`

Siguiendo el estilo de `order-manage.port.ts` (interfaces planas, `ctx: SearchContext`, token DI como constante string, comentarios sólo del "por qué"). **Las firmas de la primera pasada se mantienen; los cambios son los que el contrato obliga y están marcados.**

```ts
import type { SearchContext } from './flight-search.port';

/** Política del proveedor ante un fallo parcial dentro de un lote de documentos. */
export type DocumentBatchPolicy = 'HALT_ON_ERROR' | 'ALLOW_PARTIAL';

export type TicketDocumentType = 'TICKET' | 'EMD';

/**
 * Estado de una capacidad post-venta. UNKNOWN NO es "no sabemos": es la respuesta
 * explícita del proveedor de que el dato no es fiable (p. ej. penalidad con
 * source = Category 16, o contenido NDC donde isVoidable/isRefundable no existen).
 */
export type Eligibility = 'YES' | 'NO' | 'UNKNOWN';

/**
 * Datos del PCC/impresora contra los que se emite. Resueltos por el
 * ProviderCredentialResolver (nodo propio -> ancestro heredable), NO por el caller:
 * definen la responsabilidad BSP de la emisión.
 */
export interface TicketingIssuerContext {
  ticketingPcc?: string;
  printerHardcopyAddress?: string;
  printerTicketAddress?: string;
  printerCountryCode?: string;
  printerProfileNumber?: number;
}

/** Comisión/penalidad negociada para esta operación concreta. Requiere rol elevado. */
export interface CommercialOverrides {
  /** Sabre: commissionPercentage. Máx 99.99. Excluyente con commissionAmount. */
  commissionPercentage?: string;
  /** Máx 9999.99. */
  commissionAmount?: string;
  /** Comisión cobrada sobre la penalidad de cancelación. */
  commissionOnPenalty?: string;
  overrideCancelFee?: string;
  /** Autorización de la aerolínea para saltarse la penalidad. Implicación contractual. */
  waiverCode?: string;
}

export interface Money { amount: number; currency: string }

export interface TicketDocument {
  number: string;
  type: TicketDocumentType;
  statusCode?: string;
  statusName?: string;
  paxName?: string;
  issueDate?: string;
  amount?: Money;
  /** PCC que emitió el documento. Prueba de auditoría BSP de "quién emitió". */
  issuingPcc?: string;
  /** false = emitido pero AÚN NO grabado en el PNR. Ver ghost ticket. */
  committed?: boolean;
}

/** Warning del proveedor, normalizado. La severidad la decide el ACL, no el caller. */
export interface ProviderWarning {
  code: string;
  message: string;
  severity: 'INFO' | 'REVIEW' | 'NEEDS_HUMAN';
}

// ---------- emitir ----------

export interface IssueTicketsRequest {
  orderId: string;
  /** ATPCO: Price Quotes almacenados a emitir. Vacío/omitido = todo lo emitible (NDC). */
  priceQuoteRecordIds?: string[];
  /** ATPCO: Price Quote Reissue. Es el camino de emisión de una REEMISIÓN. */
  priceQuoteReissueRecordId?: string;
  /** EMD: ancillaries a emitir como documento aparte. */
  ancillaryItemIds?: string[];
  payment: PaymentInstruction;
  commission?: Pick<CommercialOverrides, 'commissionPercentage' | 'commissionAmount'>;
  issuer?: TicketingIssuerContext;
  /**
   * Si el precio subió entre el tarifado y la emisión. Default false: preferimos
   * fallar y re-cotizar antes que emitir a un precio que rompe nuestro margen.
   */
  acceptPriceChanges?: boolean;
  /**
   * Obligatoria: emitir es irreversible pasada la ventana de void. El adapter la usa
   * para no re-emitir tras un timeout (ver reconcileDocuments).
   */
  idempotencyKey: string;
}

export type IssueOutcome = 'ISSUED' | 'PARTIAL' | 'FAILED' | 'NEEDS_HUMAN';

export interface IssueTicketsResult {
  /**
   * NO es un booleano. Un 200 con warnings de fulfillment puede ser NEEDS_HUMAN:
   * hay dinero cobrado y estado de documento indeterminado.
   */
  outcome: IssueOutcome;
  documents: TicketDocument[];
  warnings: ProviderWarning[];
  error?: string;
}

// ---------- consultar reglas ----------

export interface CheckTicketsRequest {
  /** Excluyente con ticketNumbers: el proveedor rechaza la combinación. */
  orderId?: string;
  ticketNumbers?: string[];
  /** Simulación "what-if": misma forma que en refundTickets, para cotizar antes de ejecutar. */
  overrides?: CommercialOverrides;
}

export interface PenaltyEstimate {
  when: 'BEFORE_DEPARTURE' | 'AFTER_DEPARTURE';
  amount: Money;
  /** true = hay restricciones adicionales no cuantificadas. */
  conditionsApply: boolean;
  noShowAmount?: Money;
  /** Origen de la regla. 'Category 16' degrada la elegibilidad a UNKNOWN. */
  source?: string;
}

export interface TicketRules {
  ticketNumber: string;
  type: TicketDocumentType;
  refundable: Eligibility;
  exchangeable: Eligibility;
  voidable: Eligibility;
  /**
   * Instante límite para anular, en UTC. Sólo disponible cuando el proveedor lo
   * publica (NDC). En ATPCO es undefined y la UI muestra semáforo, NO contador:
   * la voidabilidad se re-consulta, nunca se calcula.
   */
  voidableUntil?: string;
  cancelFee?: Money;
  refundPenalties: PenaltyEstimate[];
  exchangePenalties: PenaltyEstimate[];
  /** Estimación pesimista del proveedor: es un techo, no una cifra cerrada. */
  estimatedRefund?: Money;
  /** NDC: oferta de cancelación que hay que pasar a cancelOrder. */
  cancelOfferItemId?: string;
  cancelOfferType?: 'VOID' | 'REFUND';
}

export interface CheckTicketsResult {
  rules: TicketRules[];
  /** Reservas LCC del mismo PNR: son ticketless y sólo admiten consulta de reembolso. */
  carrierRefunds: Array<{ airlineCode: string; carrierConfirmationId: string; amount: Money }>;
  warnings: ProviderWarning[];
  error?: string;
}

// ---------- anular ----------

export interface VoidTicketsRequest {
  orderId?: string;
  ticketNumbers?: string[];
  includePaperTickets?: boolean;
  policy?: DocumentBatchPolicy;
  issuer?: TicketingIssuerContext;
  idempotencyKey: string;
}

export interface DocumentOutcome {
  ticketNumber: string;
  succeeded: boolean;
  amount?: Money;
  error?: string;
}

export interface VoidTicketsResult {
  outcomes: DocumentOutcome[];
  warnings: ProviderWarning[];
  error?: string;
}

// ---------- reembolsar ----------

export interface RefundTicketsRequest {
  orderId?: string;
  /** Omitido = reembolsar todo lo reembolsable de la orden. Excluyente con orderId. */
  ticketNumbers?: string[];
  documentsScope?: 'TICKETS' | 'EMDS' | 'TICKETS_AND_EMDS';
  /** No aplicables a EMD: el proveedor los rechaza. */
  overrides?: CommercialOverrides;
  policy?: DocumentBatchPolicy;
  issuer?: TicketingIssuerContext;
  idempotencyKey: string;
}

export interface RefundTicketsResult {
  outcomes: DocumentOutcome[];
  totalRefunded?: Money;
  totalPenalty?: Money;
  warnings: ProviderWarning[];
  error?: string;
}

export interface TicketingPort {
  issueTickets(request: IssueTicketsRequest, ctx: SearchContext): Promise<IssueTicketsResult>;
  checkTickets(request: CheckTicketsRequest, ctx: SearchContext): Promise<CheckTicketsResult>;
  voidTickets(request: VoidTicketsRequest, ctx: SearchContext): Promise<VoidTicketsResult>;
  refundTickets(request: RefundTicketsRequest, ctx: SearchContext): Promise<RefundTicketsResult>;
  /**
   * Relee el estado real de los documentos del proveedor. Es la salvaguarda contra el
   * "ghost ticket": tras un timeout en issueTickets NUNCA se reintenta, se reconcilia.
   */
  reconcileDocuments(orderId: string, ctx: SearchContext): Promise<TicketDocument[]>;
}

export const TICKETING_PORT = 'TICKETING_PORT';
```

**Decisiones de diseño mantenidas de la primera pasada:**

- `reconcileDocuments` es parte del port, no del adapter. Es la defensa contra el billete fantasma y todo proveedor de ticketing la necesita.
- `DocumentOutcome[]` en vez de un booleano: los lotes parciales producen resultados mixtos por documento.
- `issuer?: TicketingIssuerContext` separado del request de negocio: lo rellena el resolver BYOC, no el caso de uso.
- `idempotencyKey` obligatoria en las tres operaciones mutantes.
- `CommercialOverrides` como tipo propio compartido entre check y refund: permite "simulo con el mismo objeto con el que ejecuto" y permite un solo guard de rol.
- Sin tipos de Sabre en ninguna firma.

**Cambios que impone el contrato:**

1. **`success: boolean` → `outcome: IssueOutcome`.** Un 200 con `PARTIAL_FULFILLMENT` no es éxito ni fracaso (§2.8). Colapsarlo a un booleano hace imposible distinguir "hay que llamar a un humano" de "reintenta".
2. **`refundable: boolean | 'UNKNOWN'` → `Eligibility`.** Y ahora sabemos exactamente cuándo vale `UNKNOWN`: `Category 16`, o contenido NDC.
3. **`commissionPercent` → `commissionPercentage`**, más `commissionOnPenalty` y `waiverCode`.
4. **`voidableUntil` sale de `IssueTicketsResult`.** La emisión **no** devuelve la ventana (VERIFICADO-SPEC `:1022`). Sólo `checkTickets` puede darla, y sólo en NDC.
5. **`warnings: string[]` → `ProviderWarning[]` con severidad.** Un `string[]` obliga a cada caller a re-clasificar; la severidad la decide el ACL, que es quien conoce la tabla de §2.8.
6. **`priceQuoteReissueRecordId` y `acceptPriceChanges` nuevos** en `IssueTicketsRequest`.
7. **`carrierRefunds` nuevo** en `CheckTicketsResult`: el `flightRefunds[]` de LCC vive en otro plano que `tickets[]`.

**Cambios que arrastra:**

- `OrderOperationType` en `apps/api/src/database/database.types.ts:432` pasa a `'cancel' | 'pay' | 'reshop' | 'retrieve' | 'issue' | 'void' | 'refund'` (migración de enum).
- `order_operations` necesita registro **por documento**, no sólo por operación.
- `OrderRetrieveResult.ticketNumbers?: string[]` en `order-manage.port.ts` queda obsoleto: sustituir por `documents?: TicketDocument[]`.
- Un `providers/sabre/` nuevo con la misma estructura que `providers/latam-ndc/`: `config.ts` con `isMockMode()`, `auth/token.service.ts` para `POST /v2/auth/token` (Basic + `client_credentials`), `http/sabre-http.client.ts`, y `<area>/request.builder.ts` + `response.mapper.ts` por endpoint.
- **Novedad respecto a la primera pasada:** los fixtures **ya se pueden escribir**. Tenemos respuestas oficiales completas de fulfill (ATPCO, ATPCO+EMD, PQR, NDC), check (5 casos) y refund (3 casos). Ver Riesgo 9, ahora rebajado.

---

## 9. Implicaciones de SAGA: emitir es el punto de no retorno

### 9.1 El problema

`fulfillFlightTickets` es la única operación del flujo de venta que **cruza una frontera irreversible**: pasada la ventana de void, deshacerla cuesta dinero real (penalidad) y tiempo real (liquidación BSP).

| Operación | Compensación | Coste de compensar |
| --- | --- | --- |
| `search` | ninguna (idempotente) | 0 |
| `offerPrice` | ninguna | 0 |
| `createBooking` | `cancelBooking` | 0 (antes del TTL) |
| `fulfillFlightTickets` **dentro de la ventana** | `voidFlightTickets` | ~0 |
| `fulfillFlightTickets` **fuera de la ventana** | `refundFlightTickets` | **penalidad + días + requiere Automated Refunds activo** |

El principio 9 de `CLAUDE.md` ("Fail loud, recover gracefully… sagas Temporal con compensación") aplica con un matiz que hay que escribir: **la compensación de la emisión no es gratuita ni instantánea, su coste cambia con el reloj, y en algunos PCC ni siquiera está disponible** (§6.1).

### 9.2 Peor caso concreto: el billete fantasma — **reevaluado a la baja**

Escenario: llamamos a `fulfillFlightTickets`, Sabre emite, la respuesta se pierde. Nuestro cliente HTTP ve un error.

La primera pasada calificó esto como riesgo alto por falta de idempotencia. **El contrato reduce el riesgo sustancialmente, con tres mecanismos que no conocíamos:**

1. **`BOOKING_FULFILLED` (`APPLICATION_ERROR`)** — *«The fulfillment operation cannot be processed. The booking is already fulfilled.»* Un reintento sobre un PNR ya emitido **falla en lugar de duplicar**. Es una barrera de idempotencia del lado servidor, anclada al `confirmationId`. **No es una garantía formal** (no cubre la ventana de carrera de milisegundos, ni el caso de emitir un segundo PQ del mismo PNR), pero convierte el escenario catastrófico en improbable.
2. **`commitTicketToBookingWaitTime`** (0–10.000 ms) — activa el ghost-ticket check **dentro** de la llamada, y el resultado viaja en `tickets[].isCommitted`.
3. **Los warnings nombran el estado ambiguo explícitamente**: `UNABLE_TO_RETRIEVE_TICKETS` (*«Verify booking details and/or audit trail reports (DQB)»*) y `FULFILLMENT_NOT_CONFIRMED`. Ya no hay que adivinar que estamos en un estado indeterminado: Sabre lo dice.

**Procedimiento revisado:**

```
issueTickets(orderId, idempotencyKey)
  con commitTicketToBookingWaitTime = 3000
  con acceptPriceChanges = false
  con priceQuoteExpirationMethod = 'Quit'

  200 sin warnings críticos y todos isCommitted=true  -> ISSUED
  200 con PARTIAL_FULFILLMENT | FULFILLMENT_NOT_CONFIRMED
      | UNABLE_TO_RETRIEVE_TICKETS                    -> reconcileDocuments -> ver abajo
  200 con algún isCommitted=false                     -> reconcileDocuments
  error BOOKING_FULFILLED                             -> ya estaba emitido: reconcileDocuments y cerrar en éxito
  error PAYMENT_* / PRICE_MISMATCH / PRINTER_* / *_MISSING
                                                      -> "no new tickets have been issued": FAILED, seguro corregir y reintentar
  error PAYMENT_CARD_ISSUE                            -> "at least one operation was not processed": reconcileDocuments
  timeout / 5xx / INTERNAL_SERVER_TIMEOUT             -> NO reintentar; backoff corto; reconcileDocuments

reconcileDocuments(orderId)
  getBooking { confirmationId, returnOnly: ["TICKETS"] }
      hay flightTickets con ticketStatusCode TE/ME/TO  => ISSUED, cerrar la saga en éxito
      no hay documentos                                 => FAILED, un (1) reintento controlado
      documentos parciales                              => PARTIAL -> NEEDS_HUMAN
      getBooking también falla                          => NEEDS_HUMAN, alertar, NO tocar nada
```

Los parámetros de Sabre en su propio ejemplo legacy (`waitInterval: 1000`, `numAttempts: 3`) siguen siendo el punto de partida razonable para el backoff; `commitTicketToBookingWaitTime: 3000` es el ejemplo que el propio contrato usa (`booking-management-v1.yml:912`).

### 9.3 Diseño de la saga en Temporal

`WorkflowEnginePort` está en `C:\Users\USER\Desktop\Projects\sales-travel\packages\core\src\ports\workflow-engine.port.ts` y hoy expone `start`, `signal`, `query`. No hay worker de Temporal en uso (el reintento de post-venta corre en BullMQ, `apps/api/src/orders/post-sale.worker.ts`). La saga de emisión es el caso que justifica traer Temporal, porque necesita tres cosas que BullMQ no da bien:

1. **Timers durables de días** — el TTL de emisión (`ticketingTimeLimit`) puede estar a 72 h.
2. **Estado de la saga sobrevivible a un deploy** — una emisión a medio reconciliar no puede perderse en un reinicio.
3. **Compensación explícita y auditable** — cada paso compensatorio queda en el historial.

Boceto revisado:

```
IssueTicketsSaga(orderId, tenantId)
 1. checkTickets(orderId)               // reglas + reembolsabilidad. Idempotente, reintentable libremente.
 2. authorizePayment(...)               // hosted checkout / VCC. NO reintentable a ciegas.
 3. issueTickets(orderId, idempotencyKey)
      - retryPolicy: maximumAttempts = 1     <-- clave: la actividad NO se reintenta sola
      - onFailure/onWarning -> reconcileDocuments(orderId)   (§9.2)
 4. persistir documentos + emitir domain event `ticketing.issued` POR DOCUMENTO
 5. Ventana de void:
      NDC  -> timer durable hasta cancelOffers[].offerExpirationDate/Time (UTC, exacto)
      ATPCO-> NO hay timer: re-llamar checkTickets antes de cada intento de void
      - cancelRequested con voidable=YES -> voidTickets  (compensación barata)
      - cancelRequested con voidable=NO  -> refundTickets (compensación cara: requiere aprobación
                                            Y automatedRefundsEnabled en el PCC)
```

Reglas no negociables:

- **`issueTickets` con `maximumAttempts = 1`.** Es la inversión del default de Temporal y es deliberada: el reintento automático de una operación irreversible es el bug más caro que podemos escribir. Se reintenta sólo tras reconciliar.
- **Nunca cruzar la ventana reintentando.** En NDC hay deadline exacto; en ATPCO hay que **re-consultar `isVoidable` antes de cada intento** y abortar escalando a humano si cambió. Ver §5.3.
- **`domain_events` (principio 8 de `CLAUDE.md`) recibe un evento por documento**: `ticketing.issued`, `ticketing.voided`, `ticketing.refunded`, cada uno con número de documento, `issuingPcc`, importe, actor, `idempotencyKey` **y los warnings del proveedor**. Es el insumo directo de la conciliación BSP (gap P0 del doc 12 §4.4).
- **La `idempotencyKey` se genera y se persiste ANTES de la primera llamada**, no dentro del adapter.

> **Salvedad, actualizada.** El contrato **no declara ninguna cabecera ni campo de idempotencia** en `fulfillFlightTickets` (VERIFICADO-SPEC: el único header declarado es `Authorization`). Nuestra `idempotencyKey` sigue siendo **nuestra** clave de deduplicación en la saga y en `order_operations`, no una promesa del proveedor. Lo que sí tenemos ahora es la barrera `BOOKING_FULFILLED` del lado servidor (§9.2), que no es lo mismo pero cubre el caso principal.

---

## 10. Códigos de estado de documento

**Enum oficial `TicketStatusEnum` (VERIFICADO-SPEC `:9195`)** — sólo tres valores para `ticketStatusName`:

```
Issued | Voided | Refunded/Exchanged
```

**Nótese que `Refunded` y `Exchanged` comparten estado.** Desde `ticketStatusName` **no se puede distinguir un reembolso de una reemisión**; hay que mirar `ticketStatusCode` o los cupones.

**`ticketStatusCode`** — patrón `^[A-Z]{1,2}$`, sin enum en el contrato. Valores observados:

| Código | Significado | Fuente |
| --- | --- | --- |
| `TE` | Billete de vuelo emitido (ATPCO, electrónico) | VERIFICADO (WF-26/27) + VERIFICADO-SPEC (ejemplo oficial de fulfill) |
| `ME` | EMD emitido | VERIFICADO (WF-26/27) + VERIFICADO-SPEC (ejemplo oficial de fulfill: EMD `1251934576908` con `ticketStatusCode: "ME"`) |
| **`TO`** | **Billete emitido en contenido NDC** | **VERIFICADO-SPEC (nuevo).** Ejemplo oficial de fulfill NDC y ejemplo de `getBooking` NDC. La primera pasada no lo conocía. |
| `TR` | Billete reembolsado (`flightCoupons[0].couponStatus === "Refunded"`) | VERIFICADO (WF-26/27) |
| `MR` | EMD reembolsado (`allCoupons[0].couponStatus === "Refunded"`) | VERIFICADO (WF-26/27) |
| `OV` | Documento anulado | VERIFICADO (WF-14) |

**Consecuencia de `TO`:** un filtro de reconciliación que sólo busque `TE`/`ME` **dará por no emitida toda orden NDC**. La primera pasada escribió exactamente ese filtro en §9.2. Corregido: `TE | ME | TO`.

Cupones (**VERIFICADO**, WF-26/27 + ejemplos oficiales):

| Campo | Valores observados |
| --- | --- |
| `flightTickets[].flightCoupons[].couponStatus` | `"Not Flown"`, `"Refunded"` |
| `flightTickets[].flightCoupons[].couponStatusCode` | `"I"` (= Not Flown) |
| `flightTickets[].allCoupons[].couponStatus` | `"Refunded"` |
| `flightTickets[].flightCoupons[].itemId` | referencia al vuelo (VERIFICADO-SPEC, ejemplo oficial de `getBooking`) |

Estado de cupón `ACTL` — **no aparece en la colección pero sí en los errores oficiales**: *«Coupon Status ACTL - Coupons[%s] of the document are currently **under airport control**»*. Es un estado terminal para automatización: **el documento está en manos del aeropuerto y ni void ni refund ni check pueden verificarlo.** Escalar a humano.

> Curiosidad del test de WF-14 que conviene no copiar: el nombre del test dice *"All flight tickets should have **TV** status code"* pero la aserción compara contra `'OV'`. El valor que vale es el de la aserción.

**Sobre `flightCoupons` vs `allCoupons`:** la primera pasada infirió que `flightCoupons` sería el subconjunto de segmentos de vuelo y `allCoupons` el total incluyendo EMD. **Sigue [INFERIDO]** — el contrato no aclara la diferencia y los ejemplos oficiales sólo muestran `flightCoupons`. Es coherente con el uso de WF-26/27 (`flightCoupons` para los `TR`, `allCoupons` para los `MR`), pero no está confirmado.

Campos de `getBooking` confirmados y útiles para el mapper (VERIFICADO por scripts + VERIFICADO-SPEC por ejemplos oficiales): `confirmationId`, `bookingSignature`, `flightTickets[].number`, `.date`, `.travelerIndex`, `.ticketStatusCode`, `.ticketStatusName`, `.payment` (`TotalValues`), `.flightCoupons[]`, `.allCoupons[]`, `travelers[]`, `travelers[].ancillaries[].itemId`, `flights[]`, `journeys[]`, `allSegments[]`, `remarks[]`, `specialServices[]`, `accountingItems[]`, y el filtro de proyección `returnOnly: ["TICKETS" | "FLIGHTS" | "HOTELS"]`.

---

## 11. Reemisión y cambio de itinerario — el hueco real, delimitado

**Esta sección responde al hallazgo 1 de la crítica, que era correcto.** La primera pasada escribió en su Riesgo 8: *«Ese material está en la carpeta `ModifyBooking` de la colección (232 KB de slice) y necesita su propio análisis.»* **Es falso, y hay que decirlo sin rodeos:**

- **Cero de los 1.077 bodies de la colección contienen la cadena `exchange`** en cualquier capitalización (verificado sobre `requests.jsonl`).
- Los 8 hits de `exchangeable` en `tree.txt` son **nombres de los workflows 16 y 17**, que **consultan** si el billete es cambiable vía `checkFlightTickets` pero **nunca ejecutan el cambio**.
- La carpeta `ModifyBooking` (690 requests, analizada en el doc 05) **no contiene ningún flujo de reemisión**.

Remitir al lector a `ModifyBooking` para el exchange era mandarlo a un sitio vacío, y presentaba como "documentado pendiente de analizar" un **hueco duro de la superficie de API que tenemos**. Corregido.

### 11.1 Lo que los specs nuevos sí aportan

La primera pasada no conocía dos productos que ahora sí tenemos:

**`flight-reshop-api-1.0.yml` — Sabre Flight Reshop 1.1.** Un único endpoint: `POST /v1/offers/flightReshop` (VERIFICADO-SPEC `flight-reshop-api-1.0.yml:25`). Descripción: *«allows you to search for exchange options based on the provided `bookingId` (PNR locator) or list of tickets»*.

Capacidades oficiales sobre contenido ATPCO:
- Identifica las tarifas del billete a cambiar y devuelve **hasta 50 opciones de itinerario** conformes con la política de cambio de la aerolínea (**Categoría 31, Voluntary Changes**).
- Da **el coste del cambio por opción y por pasajero**.
- Da **el importe residual de cualquier EMD-A asociado** al billete presentado.
- **«Doesn't modify the PNR or process the ticket exchange.»**

Extras relevantes en su documentación (20 páginas): flexibilidad de fechas, aeropuertos alternativos, *disruption waivers*, `useOriginalPricing`, `priceGuarantee` (cómo trata Cat 31 durante el reshop), `overrideCheckedTicketCoupons`, marcas tarifarias.

**`flightcheck-api-v1.yml` — Sabre Flight Check 1.0.** `POST /v1/offers/flightCheck` (VERIFICADO-SPEC `flightcheck-api-v1.yml:23`): *«revalidates the price of an offer, checks availability, and provides upsell capabilities across content sources once the offer has been selected for purchase»*. **No es post-venta**: es revalidación pre-compra, el equivalente multi-fuente de `/v1/offers/price`. **Fuera del alcance de este documento** — pertenece al análisis de shopping/pricing.

### 11.2 El circuito completo de reemisión, y qué nos falta

Juntando las tres piezas, el circuito de un cambio voluntario en Sabre queda así:

| # | Paso | Producto | ¿Lo tenemos documentado? |
| - | --- | --- | :---: |
| 1 | ¿Es cambiable? ¿Cuánto cuesta aproximadamente? | `checkFlightTickets` → `isChangeable`, `exchangePenalties[]` | **Sí** (§4.3) |
| 2 | ¿Qué itinerarios alternativos hay y a qué precio? | `POST /v1/offers/flightReshop` | **Sí** (spec completo, 336 KB) |
| 3 | **Crear el PQR (Price Quote Reissue) en el PNR** | **???** | **NO** |
| 4 | Emitir contra el PQR | `fulfillFlightTickets` con `ticketingQualifiers.priceQuoteReissueRecordId` | **Sí** (§2.6, con ejemplo oficial) |

**El paso 3 es el único hueco, y es un hueco de un solo eslabón, no de todo el proceso.** Sabemos que el PQR existe, sabemos que se lee de `getBooking` por `recordId` con `recordTypeCode = "PQR"` (VERIFICADO-SPEC `:7539`), y sabemos que `fulfillFlightTickets` lo emite. **Lo que no sabemos es qué API lo crea.** Candidatos, sin confirmar: `Exchange Shopping` u `Order Management` (ambos aparecen en la orquestación interna de Flight Reshop, VERIFICADO-SPEC), o un LLS de tipo `AirExchange`. **Ninguno está en la colección ni en los 15 specs descargados.**

Un dato adicional que acota el hueco: `modifyBooking` **no** sirve — su lista de errores incluye *«The selected operation is not supported. **PQR modification is not allowed**»*.

**Esto es una pregunta para el account manager de Sabre, no un problema de análisis:** *"¿Qué producto de vuestro catálogo crea el PQR, y está en nuestro entitlement?"* Va a `Preguntas abiertas` y a `Decisiones`.

### 11.3 Alcance recomendado

**Reemisión FUERA del alcance de la primera integración de ticketing.** Razones:

1. Falta un eslabón del circuito y depende de una respuesta de Sabre.
2. Flight Reshop es un producto **aparte** con su propio entitlement, su propio contrato de 336 KB y 20 páginas de guías. Merece su propio documento de análisis.
3. Emisión + void + refund ya cubre el 100 % de la venta y el 80 % de la post-venta por volumen.

**Pero hay que decirlo explícitamente en el doc 12**, porque `docs/platform/12-modelo-consolidador-y-plan.md` §4.1 tiene la post-venta completa como **P0**, e incluye el cambio voluntario. **Con esta integración, ese P0 queda cubierto sólo parcialmente.** No dar la post-venta por cerrada.

---

## Preguntas abiertas

Sólo las que el contrato **no** respondió. Se han eliminado nueve de las quince originales.

1. **¿Qué API de Sabre crea el PQR (Price Quote Reissue)?** Es el único eslabón que falta para poder ejecutar un cambio voluntario de punta a punta (§11.2). ¿`Exchange Shopping`? ¿`Order Management`? ¿Un LLS? ¿Está en nuestro entitlement o es un producto contratable aparte? **Pregunta directa al account manager, no capturable del sandbox.**
2. **¿Cuál es la regla exacta del "void period" para ATPCO?** El contrato confirma que Sabre la valida y la expone como `isVoidable`, pero **no publica la fórmula** ni un `voidableUntil` para ATPCO (§5.3). ¿Existe algún campo o endpoint que la devuelva como marca de tiempo? ¿Depende del PCC emisor, del BSP, o de la aerolínea validadora? Sin esto no hay contador ATPCO en la UI, sólo semáforo.
3. **`HALT_ON_ERROR`: ¿rollback o no?** La documentación oficial de void se contradice a sí misma en la misma página (§5.2): dice *«a rollback is executed»* y luego *«previously processed documents are voided»*. **Capturar del sandbox con un lote de 2 billetes donde el segundo sea inválido**, y verificar el estado del primero con `getBooking`.
4. **`X-Sabre-Group` / `X-Sabre-Current-City` vs `targetPcc`: ¿cuál manda?** Los headers no están en el contrato (§7.2). ¿Son legacy? ¿Se pueden omitir siempre? ¿Por qué el ejemplo de Sabre los borra antes de reembolsar?
5. **Comisión: si se envía `commissionPercentage` en `createBooking` y `commissionAmount` en `fulfillFlightTickets`, ¿cuál gana?** El contrato dice que son excluyentes **dentro** de `TicketingQualifiers`, pero no dice nada sobre el conflicto entre el tarifado y la emisión.
6. **Asientos pagos ATPCO: ¿por qué se emiten sin `ancillaryIds`?** El flujo "Paid seats" de la colección emite con `fulfillments[]` sin calificadores. ¿Cuándo un servicio pago necesita `ancillaryIds` explícito y cuándo entra en el PQ? El contrato no distingue.
7. **ATPCO sin calificadores: ¿cuál es el comportamiento por defecto?** Para NDC está documentado ("toda la orden"). Para ATPCO, un `fulfillments: [{payment: {...}}]` sin `priceQuoteRecordIds` no está descrito en ninguna parte. ¿Emite todos los PQ? ¿El primero? ¿Falla?
8. **`ptrta` → ¿`ticket.address`?** Es el único slot de impresora que la colección nunca rellena (§7.1). ¿Hay algún flujo ATPCO que lo requiera, o `countryCode` basta siempre?
9. **`flightCoupons` vs `allCoupons`: ¿cuál es la diferencia exacta?** Sigue [INFERIDO] (§10). Los ejemplos oficiales sólo muestran `flightCoupons`.
10. **`futurePricingLines` (líneas FP): ¿cubre nuestro caso de emisión diferida?** Si Sabre puede sostener la cola de emisión pendiente nativamente, ¿por qué construir la nuestra? ¿Qué garantías de ejecución da? ¿Qué pasa si falla a las 3 de la mañana? Ver `Decisiones`.
11. **`referenceId` de `FulfillFormOfPayment`: ¿qué es exactamente la "stored wallet form of payment"?** Es la única pista de tokenización nativa que hay en todo el contrato (§2.4), y es directamente relevante al riesgo PCI. ¿Se puede guardar una tarjeta en el booking y luego emitir apuntando sólo al `itemId`? ¿Quién la guarda y con qué llamada?
12. **`VIRTUAL_CARD` + `virtualCardCode`: ¿cómo se aprovisiona?** ¿Sabre emite la VCC (el ejemplo del contrato es `"SABREVIRTUAL"`), o hay que traer una de un proveedor externo? Determina cuál de las dos rutas PCI de §4 es viable.
13. **`INSTALLMENTS` ("parcelado" BSP Brasil): ¿qué aerolíneas y qué `airlinePlanCode`?** Es una capacidad de venta real en nuestro mercado objetivo y hoy no está en el roadmap.

---

## Decisiones que necesita el founder

Alternativas concretas, con recomendación. No requieren esperar al sandbox.

**D1 — Cómo se paga la emisión (PCI). Es lo primero que hay que decidir; bloquea el adapter.**
El contrato confirma que **`fulfillFlightTickets` acepta ocho tipos de FOP y seis de ellos no tocan PAN** (§2.4). Las opciones:
- **(a) Sólo FOP sin tarjeta: `CASH`, `CHECK`, `INVOICE`, `ON_ACCOUNT`.** El billete se liquida contra el BSP con fondos de la agencia; el cliente nos paga a nosotros por hosted checkout (Stripe/Mercado Pago). Encaja con la wallet de agencia del doc 12 §4.3, nos deja en **SAQ-A**, y es como opera un consolidador clásico. Limitación real: **NDC exige FOP y algunas aerolíneas exigen tarjeta**, así que no cubre el 100 % del contenido NDC.
- **(b) `VIRTUAL_CARD`.** Una VCC de un solo uso; el PAN no es del cliente y puede que ni pase por nosotros (`virtualCardCode` sugiere que Sabre resuelve la tarjeta). Cubre NDC. Depende de la pregunta 12.
- **(c) `PAYMENTCARD` con PAN en claro.** Nos saca de SAQ-A y nos mete en **SAQ-D**: escaneos ASV, pentest, segmentación de red, auditoría anual. Coste alto y recurrente.
**Recomendación: (a) como camino principal desde el día 1, (b) como habilitador de NDC en cuanto se resuelva la pregunta 12, (c) descartada.** Si NDC con tarjeta resulta imprescindible antes de tener VCC, la alternativa es **no vender ese contenido NDC** hasta tenerla, no bajar la postura PCI.

**D2 — Quién sostiene la cola de emisión diferida.**
- **(a) Nuestra cola** (Temporal + `ticketingTimeLimit`), como está en el plan. Control total, observabilidad propia, funciona igual para todos los proveedores.
- **(b) `futurePricingLines` de Sabre.** Nativo, cero infraestructura, pero opaco: si falla no nos enteramos, y no sirve para LATAM NDC ni para el resto de proveedores.
**Recomendación: (a).** El multi-proveedor mata la opción (b): tendríamos dos mecanismos de emisión diferida con semánticas distintas. Vale la pena investigar (b) sólo como red de seguridad secundaria.

**D3 — Alcance de la primera integración de ticketing Sabre.**
- **(a) Emitir + void + refund** (lo que este documento cubre por completo), dejando la reemisión para una segunda fase.
- **(b) Incluir reemisión**, lo que obliga a resolver antes la pregunta 1 con Sabre y a analizar Flight Reshop (336 KB de spec + 20 páginas).
**Recomendación: (a), y abrir la conversación con Sabre sobre el PQR en paralelo.** Pero **hay que actualizar `docs/platform/12-modelo-consolidador-y-plan.md` §4.1** para que no diga que la post-venta queda cerrada: queda cerrada salvo el cambio voluntario.

**D4 — Automated Refunds y el aprovisionamiento por agencia.**
El reembolso requiere activación **por PCC** en Sabre Central (§6.1). Con BYOC, eso es una activación por cada agencia de la red.
- **(a) Exigirla en el onboarding** de toda agencia que traiga su PCC, y bloquear la funcionalidad de reembolso hasta confirmarla.
- **(b) Ofrecer reembolso sólo bajo el PCC del consolidador** para las agencias que no la tengan (el reembolso lo ejecuta el consolidador en su nombre).
**Recomendación: (a) con (b) como fallback.** En ambos casos, `provider_accounts.config.automatedRefundsEnabled` es obligatorio y la UI debe ocultar el botón de reembolso cuando sea `false`, en lugar de dejar que el vendedor descubra el `UNAUTHORIZED` delante del cliente.

**D5 — Política por defecto de precio en la emisión.**
Los defaults de Sabre son permisivos: `acceptPriceChanges: true`, `priceQuoteExpirationMethod: 'Reprice'` (§2.1).
- **(a) Estricta:** `acceptPriceChanges: false`, `priceQuoteExpirationMethod: 'Quit'`. Si el precio cambió, la emisión falla y re-cotizamos. Protege el margen; añade fricción.
- **(b) Tolerante con umbral:** aceptar subidas hasta un % configurable por tenant.
**Recomendación: (a) como default global, (b) como override por tenant en una fase posterior.** El principio 1 de `CLAUDE.md` ("tiempo a venta < 2 min") no justifica emitir a un precio que rompe el margen: un fallo rápido y una re-cotización siguen estando dentro de los 2 minutos.

---

## Riesgos

1. **PCI — sigue siendo el mayor riesgo, pero ahora con salida.** `fulfillFlightTickets` acepta `cardNumber` y `cardSecurityCode` en claro (VERIFICADO-SPEC `:5305`), y `CLAUDE.md` es explícito: *"Solo hosted checkout en fase 1 (PCI SAQ-A), nunca tocamos PAN/CVV"*. **Lo que cambia respecto a la primera pasada: ya no es un callejón sin salida.** El contrato confirma seis tipos de FOP sin PAN (`CASH`, `CHECK`, `INVOICE`, `ON_ACCOUNT`, `MISCELLANEOUS`, `VIRTUAL_CARD`) y una pista de tokenización (`referenceId` → stored wallet). Ver D1. **Sigue siendo bloqueante hasta que se decida D1**, pero es una decisión, no una incógnita.
2. **Un `HTTP 200` de fulfill no significa que la emisión saliera bien.** Con `ALLOW_PARTIAL_FULFILLMENT` por default, `PARTIAL_FULFILLMENT`, `FULFILLMENT_NOT_CONFIRMED` y `UNABLE_TO_RETRIEVE_TICKETS` llegan como **warnings en una respuesta exitosa** (§2.8). Un adapter escrito con la suposición ingenua ("200 = OK") reportará ventas completadas con billetes que no existen. **Es el bug más probable y más caro de esta integración.**
3. **El mismo fallo cambia de canal (`errors` vs `warnings`) según la política que mandamos** (§5.2). Un mapper que sólo lea `errors[]` perderá todos los fallos de void/refund cuando usemos `ALLOW_PARTIAL_CANCEL`. Y `errors` **no viene ni vacío** en respuestas exitosas: `response.errors ?? []`, siempre.
4. **La ventana de void: el riesgo cambió de forma.** Ya no es "no sabemos la regla" (Sabre la aplica y la expone). Ahora es **"la tentación de calcularla nosotros"**: la primera pasada proponía derivarla de la zona horaria del PCC. Una heurística que discrepe de `isVoidable` produce o promesas incumplidas o penalidades regaladas, y **falla en silencio**, apareciendo en la conciliación un mes después. La regla es: consultar, nunca calcular (§5.3).
5. **Los importes de `checkFlightTickets` son estimaciones pesimistas, no cotizaciones.** *«Estimates assume the highest possible refund penalty is applied»* (VERIFICADO-SPEC `:6533`). Mostrarlos como cifra cerrada al cliente es prometer algo que el reembolso real puede no cumplir. Y `source: "Category 16"` invalida el booleano de elegibilidad.
6. **`overrideCancelFee`, `waiverCode` y `commissionOnPenalty` son dinero regalado si se exponen mal.** Son por documento, con límites altos (9999.99 / 99.99 %). `waiverCode` además compromete contractualmente a la agencia frente a la aerolínea. Sin guard de rol y sin auditoría en `domain_events`, nadie se entera hasta el cierre.
7. **Confundir comisión BSP con markup de la red.** Circuitos distintos (§7.4). Mezclarlas rompe la conciliación BSP, que es un gap P0 y una de las razones de existir de un consolidador. Y ahora hay un tercer circuito que no estaba en el análisis: **`netRemit`**, la comisión adicional que paga la validadora vía BSP.
8. **La colección tiene ejemplos mal mantenidos, y el contrato lo confirma.** Casos verificados: `Refund Flight Tickets confirmationId EMD only` no lleva `confirmationId`; `fulfillFlightTickets with brandedFares` usa `"type": "CHECK"` con datos de tarjeta; tres requests mandan **`commissionPercent`**, un campo que no existe en el contrato (§4.2); un test de WF-14 dice "TV" y compara contra "OV"; un test de WF-26 se llama "exactly one error" y compara contra 8. **Regla: el contrato manda sobre la colección, siempre. Y un `pm.environment.set` no es evidencia de que un campo exista** — así es como la primera pasada acabó afirmando que `fulfillFlightTickets` devuelve `bookingSignature` (§2.7).
9. **~~Deuda de fixtures~~ — riesgo rebajado.** La primera pasada decía: *«para Sabre no conocemos la forma de las respuestas… los fixtures se escriben después de capturar respuestas reales»*. **Ya no aplica a fulfill, check ni refund**: tenemos el contrato y respuestas oficiales completas de los tres. Los fixtures se pueden escribir **hoy**, contra el contrato. Lo que sigue sin cubrir son los **casos de error y warning**, que es justo donde está el riesgo 2 — y esos sí hay que provocarlos en el sandbox CERT.
10. **La semántica de persistencia de `targetPcc` es ambigua** entre spec y guía stateless. Enviar `targetPcc`
explícito en toda operación y ejecutar un test A→B contra CERT. El aislamiento cross-tenant sigue siendo obligatorio.
11. **La post-venta no queda cerrada con este documento.** Cubre emisión, void y refund. **El cambio voluntario (reemisión) no está**, y no por falta de análisis sino porque falta un eslabón del circuito que Sabre no publica (§11.2). `docs/platform/12-modelo-consolidador-y-plan.md` §4.1 lo tiene como P0. Hay que actualizarlo.
12. **Dependencias de aprovisionamiento invisibles desde el código.** Automated Refunds por PCC (§6.1), `AUTO-END`/`AUTO-ER` inactivos para que el void funcione (§5.1), `MISCELLANEOUS` activado por agencia, keyword `NETFQD` del EPR para ver `netRemit`, keyword `CCVIEW` para desenmascarar tarjetas. **Nada de esto se detecta en desarrollo: se detecta en producción, con un cliente delante.** Cada una necesita su casilla en el onboarding de agencia.
