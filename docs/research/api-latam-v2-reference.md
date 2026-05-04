# LATAM Airlines API v192 (NDC) — Referencia

Documento operativo de la colección Postman provista por LATAM. Basado en la
exportación `API_LATAM_V2.json` (ya en el repo).

**Base URL:** `https://sandbox.api.latam.com` (sandbox).
**Prod URL:** la entrega LATAM cuando aprueban certificación.
**Estándar:** IATA NDC schemas v2019.2 (XML). Excepción: el endpoint de
reporting `/api-b2b-reporting/v1/order/tickets` devuelve JSON.

---

## 1. Autenticación

### `POST /oauth/cc/token`

**Para qué:** obtener Bearer token. Es lo primero que hay que hacer en cada
sesión. El token se cachea — no llamarlo por cada request.

**Auth:** Basic auth con `{ApiKey}:{Secret}` + header `x-api-key: {ApiKey}`.

**Body** (form-urlencoded):

```
grant_type=client_credentials
```

**Response** (JSON):

```json
{
  "access_token": "...",
  "expires_in": 1800,
  "token_type": "Bearer"
}
```

**Cuándo refrescar:** cuando faltan menos de 60s para `expires_in`. Implementado
en `LatamTokenService` con cache en memoria + coalescing de fetches concurrentes.

---

## 2. Headers obligatorios (en todos los `/ndc/*`)

| Header                     | Valor                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `Authorization`            | `Bearer {access_token}`                                                                    |
| `X-latam-api-key`          | tu `ApiKey`                                                                                |
| `Content-Type`             | `application/xml`                                                                          |
| `X-latam-Track-Id`         | UUID v4 — agrupa requests del mismo flujo (búsqueda + price + create deberían compartirlo) |
| `x-latam-request-id`       | UUID v4 nuevo por cada request — para correlación en logs                                  |
| `X-latam-Application-Name` | nombre comercial de la agencia                                                             |
| `X-latam-client-name`      | mismo valor que el anterior                                                                |
| `X-latam-Country`          | `CO` / `CL` / `BR` / `PE` / `AR` ... — país del POS                                        |
| `X-latam-Lang`             | `EN` / `ES` / `PT`                                                                         |
| `x-latam-api-version`      | `V2`                                                                                       |

---

## 3. Flujo de venta (orden recomendado)

```
1. AirShopping        → buscar vuelos → recibís OfferIDs
2. OfferPrice         → confirmar precio firme de la oferta seleccionada
3. (opcional) Installments / SeatsAvailability / ServiceList
4. OrderCreate        → crear el PNR
5. OrderRetrieve      → recuperar la reserva
```

Si el cliente cambia de opinión:

```
- OrderReshop Refund    → cotizar reembolso
- OrderCancel Refund    → ejecutar el reembolso
- OrderReshop Exchange  → cotizar cambio de fecha/ruta
- OrderChange (booking) → aplicar el cambio
- OrderCancel VOID      → cancelar dentro de las primeras 24h sin penalidad
```

---

## 4. Endpoints — ficha por cada uno

### 4.1 `POST /ndc/v192/airshopping` — **AirShopping**

**Para qué:** buscar vuelos disponibles + sus precios indicativos.

**Variantes:**

- **One-Way (OW):** un solo `<OriginDestCriteria>` en el XML.
- **Round-Trip (RT):** dos `<OriginDestCriteria>` (outbound + inbound).
- **Multi-city:** múltiples `<OriginDestCriteria>` consecutivos.

**Body** (resumido):

```xml
<IATA_AirShoppingRQ>
  <Party>...agencia...</Party>
  <POS>...país...</POS>
  <Request>
    <FlightCriteria>
      <OriginDestCriteria>
        <DestArrivalCriteria>
          <IATA_LocationCode>MIA</IATA_LocationCode>
        </DestArrivalCriteria>
        <OriginDepCriteria>
          <Date>2026-08-15</Date>
          <IATA_LocationCode>SCL</IATA_LocationCode>
        </OriginDepCriteria>
      </OriginDestCriteria>
    </FlightCriteria>
    <Paxs>
      <Pax><PaxID>ADT_1</PaxID><PTC>ADT</PTC></Pax>
    </Paxs>
    <ShoppingCriteria>
      <ProgramCriteria>
        <ProgramOwner>
          <Carrier><AirlineDesigCode>LA</AirlineDesigCode></Carrier>
        </ProgramOwner>
      </ProgramCriteria>
    </ShoppingCriteria>
  </Request>
</IATA_AirShoppingRQ>
```

**Pax types (PTC):** `ADT` (adult), `CHD` (child 2-11), `INF` (infant 0-23 months, lap).

**Response (estructura):**

```
IATA_AirShoppingRS
  Response
    OffersGroup
      AirlineOffers[]
        Offer[]
          OfferID, TotalPrice, OfferItem[], TimeLimits.OfferExpiration
    DataLists
      FlightList: Flight[] con FlightKey + SegmentReferences
      FlightSegmentList: FlightSegment[] con SegmentKey, Dep, Arrival, MarketingCarrierInfo
```

**Lo que mapeo a canónico:** `Offer.id` (uuid nuestro), `Offer.provider.offerRef`
(el `OfferID` de LATAM), `Offer.total` (de `TotalPrice.SimpleCurrencyPrice`),
`Offer.itineraries[]` (resolviendo `FlightRefs` → `Flight` → `FlightSegment`),
`Offer.expiresAt` (de `TimeLimits.OfferExpiration.@DateTime`).

**Implementado en:** `providers/latam-ndc/src/airshopping/`.

---

### 4.2 `POST /ndc/v192/offerPrice` — **OfferPrice**

**Para qué:** lockear el precio de una oferta antes de bookear. AirShopping da
precio indicativo; OfferPrice da precio firme con TTL más corto.

**Cuándo:** después de que el vendedor seleccione una oferta de los resultados
de búsqueda. Antes de mostrar al cliente final.

**Body** (resumido):

```xml
<IATA_OfferPriceRQ>
  <Party>...</Party>
  <POS>...</POS>
  <Request>
    <DataLists>
      <PaxList><Pax><PaxID>ADT_1</PaxID><PTC>ADT</PTC></Pax></PaxList>
    </DataLists>
    <PricedOffer>
      <SelectedOffer>
        <OfferRefID>{{OfferID-de-AirShopping}}</OfferRefID>
        <OwnerCode>LA</OwnerCode>
        <SelectedOfferItem>
          <OfferItemRefID>{{OfferItemID}}</OfferItemRefID>
          <PaxRefID>ADT_1</PaxRefID>
        </SelectedOfferItem>
      </SelectedOffer>
    </PricedOffer>
  </Request>
</IATA_OfferPriceRQ>
```

**Lo que se mapea:** mismo `Offer` canónico, pero con `total` y `taxes`
recalculados, y `expiresAt` actualizado. El `provider.offerRef` queda con el
nuevo OfferID firme.

---

### 4.3 `POST /ndc/v192/installments/options` — **Installments**

**Para qué:** opciones de cuotas según método de pago (muy específico LATAM).

**Cuándo:** justo antes del checkout, después de OfferPrice.

**Body:** `<InstallmentOptionsRQ>` con `<Pan>` (BIN/PAN), `<OrderId>` opcional,
`<ExecutionFlow>PAYLATER</ExecutionFlow>`.

**Notar:** este endpoint usa una raíz NO-IATA (`<InstallmentOptionsRQ>` directo)
— no sigue el schema NDC.

---

### 4.4 `POST /ndc/v192/seats/availability` — **SeatsAvailability**

**Para qué:** mapa de butacas por vuelo.

**Cuándo:** opcional, si el vendedor quiere mostrar selección de asientos.

---

### 4.5 `POST /ndc/v192/services/list` — **ServiceList**

**Para qué:** ancillaries (equipaje extra, comidas, mascotas, prioridad).

**Cuándo:** opcional, durante checkout.

---

### 4.6 `POST /ndc/v192/order/create` — **OrderCreate**

**Para qué:** crear el PNR — momento donde la oferta se vuelve reserva.

**Body** (resumido):

```xml
<IATA_OrderCreateRQ>
  <Party>...agencia...</Party>
  <POS>...</POS>
  <Request>
    <CreateOrder>
      <SelectedOffer>
        <OfferRefID>{{OfferID-firmado-en-OfferPrice}}</OfferRefID>
        <OwnerCode>LA</OwnerCode>
        <SelectedOfferItem>
          <OfferItemRefID>{{...}}</OfferItemRefID>
          <PaxRefID>ADT_1</PaxRefID>
        </SelectedOfferItem>
      </SelectedOffer>
    </CreateOrder>
    <DataLists>
      <ContactInfoList>
        <ContactInfo>...email/telefono agencia...</ContactInfo>
        <ContactInfo>...email/telefono pax...</ContactInfo>
      </ContactInfoList>
      <PaxList>
        <Pax>
          <CitizenshipCountryCode>CO</CitizenshipCountryCode>
          <ContactInfoRefID>ADT_1_CNT</ContactInfoRefID>
          <IdentityDoc>
            <ExpiryDate>2025-09-23</ExpiryDate>
            <IdentityDocID>...</IdentityDocID>
            <IdentityDocTypeCode>P</IdentityDocTypeCode>
            <IssuingCountryCode>CO</IssuingCountryCode>
          </IdentityDoc>
          <Individual>
            <Birthdate>1992-09-23</Birthdate>
            <GenderCode>M</GenderCode>
            <GivenName>Oliver</GivenName>
            <Surname>Jackson</Surname>
          </Individual>
          <PaxID>ADT_1</PaxID>
          <PTC>ADT</PTC>
        </Pax>
      </PaxList>
    </DataLists>
  </Request>
</IATA_OrderCreateRQ>
```

**Datos requeridos del pax:** nombre completo, fecha de nacimiento, género,
nacionalidad, documento (tipo + número + país emisor + vencimiento), email,
teléfono.

**Response:** devuelve `OrderID` (PNR LATAM) — guardalo, es la clave para todos
los endpoints siguientes.

---

### 4.7 `POST /ndc/v192/order/retrieve` — **OrderRetrieve**

**Para qué:** traer el detalle completo de un PNR existente.

**Body:**

```xml
<IATA_OrderRetrieveRQ>
  <Party>...</Party><POS>...</POS>
  <Request>
    <OrderFilterCriteria>
      <Order>
        <OrderID>{{OrderID}}</OrderID>
        <OwnerCode>LA</OwnerCode>
      </Order>
    </OrderFilterCriteria>
  </Request>
</IATA_OrderRetrieveRQ>
```

---

### 4.8 `POST /ndc/v192/order/change/payment` — **OrderChange (payment)**

**Para qué:** procesar el pago de una orden creada (asociar tarjeta o cash y
emitir tickets). Es lo que termina convirtiendo el PNR en boletos emitidos.

**Body:** include `<PaymentFunctions>` con `<PaymentProcessingDetails>` —
soporta `<Cash/>` o `<PaymentCard>` con CardBrandCode, CardHolderName,
CardNumber, CVV, ExpirationDate.

> **Importante PCI:** mandar PAN/CVV directamente al endpoint nos saca del
> SAQ-A que tenemos comprometido en CLAUDE.md. Para producción hay que usar
> tokenización vía Stripe/MP y mandar el token, no el PAN crudo.

---

### 4.9 `POST /ndc/v192/order/change/booking` — **OrderChangeBooking**

**Para qué:** modificar datos de la reserva (contacto, datos del pax) post-emisión.

---

### 4.10 `POST /ndc/v192/order/passenger` — **OrderChange FFP**

**Para qué:** actualizar el FFP (programa de viajero frecuente) o info del pax
después de la emisión.

---

### 4.11 `POST /ndc/v192/order/reshop` — **OrderReshop** (Refund / Exchange)

**Para qué:** cotizar el costo/devolución de una modificación. Dos modos:

- **Refund:** body con `<UpdateOrder><CancelOrder>` apuntando al `OrderRefID`.
  Devuelve cuánto se devuelve y cuánto se penaliza.
- **Exchange:** body con `<UpdateOrder><ReshopOrder>` que incluye una
  `<FlightCriteria>` con la nueva fecha/ruta. Devuelve diferencia de tarifa +
  penalidad.

> Mismo path para ambos — el cuerpo XML define el modo.

---

### 4.12 `POST /ndc/v192/order/cancel` — **OrderCancel** (Refund / VOID)

**Para qué:** ejecutar la cancelación tras un reshop.

- **Refund:** incluye `<ExpectedRefundAmount><TotalAmount>...</TotalAmount></ExpectedRefundAmount>`
  con el monto que esperás recibir (validado contra el reshop previo).
- **VOID:** mismo endpoint sin `<ExpectedRefundAmount>` — solo `<Order>`.
  Para cancelar dentro de las primeras 24h sin penalidad (si la tarifa lo
  permite).

> Mismo path — el cuerpo define el modo.

---

### 4.13 `POST /ndc/v192/order/cancel/bnpl` — **Order Cancel BNPL**

**Para qué:** cancelar reservas con pago Buy-Now-Pay-Later (LATAM tiene un
producto donde el pasajero paga después).

---

### 4.14 `POST /ndc/v192/order/tax/info` — **Billing Information**

**Para qué:** obtener los datos fiscales (NIT/RFC/CUIT, factura electrónica)
asociados a una orden — para emitir la FE en CO/BR/AR/etc.

---

### 4.15 `POST /ndc/v192/order/list` — **Order List (NDC)**

**Para qué:** listar órdenes con filtros (rango de fechas, estado, etc.).
Formato XML.

---

### 4.16 `POST /api-b2b-reporting/v1/order/tickets` — **Order List JSON**

**Para qué:** alternativa REST/JSON para listar tickets — más cómoda para
dashboards. **Distinta base path** (`/api-b2b-reporting/v1` en vez de
`/ndc/v192`).

---

## 5. Códigos comunes

### Pax Type Codes (PTC)

| PTC   | Significado                     |
| ----- | ------------------------------- |
| `ADT` | Adulto (≥12 años)               |
| `CHD` | Niño (2-11 años)                |
| `INF` | Infante (0-23 meses, en regazo) |

### Identity Document Types

| Code | Doc                  |
| ---- | -------------------- |
| `P`  | Pasaporte            |
| `ID` | Cédula / DNI         |
| `DL` | Licencia de conducir |

### Card Brand Codes

| Code | Marca            |
| ---- | ---------------- |
| `VI` | Visa             |
| `CA` | MasterCard       |
| `AX` | American Express |
| `DC` | Diners           |

### Lang codes

`EN` / `ES` / `PT`.

---

## 6. Errores comunes y manejo

| Síntoma                      | Causa probable                                                    | Cómo se ve                                    |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| 401 en `/oauth/cc/token`     | apikey/secret incorrectos                                         | Body con `error: invalid_client`              |
| 200 con `<Errors>` en NDC RS | error de negocio (ruta inválida, fecha pasada, capacidad)         | Hay `<Error Code="...">` adentro del response |
| 403 en NDC                   | el agencyId/IATA no tiene permiso o no está habilitado en sandbox | Verificar credenciales con LATAM              |
| 415 unsupported media type   | falta `Content-Type: application/xml` o se mandó JSON             | Verificar header                              |
| 502/503                      | sandbox de LATAM caído (común)                                    | Reintentar con backoff                        |

> NDC suele devolver **200 OK con errores adentro del XML** en lugar de status
> codes HTTP de error. Hay que parsear `<Errors><Error>` dentro del response.

---

## 7. Glosario

- **NDC** — New Distribution Capability, estándar IATA para distribución
  directa de aerolíneas (alternativa a los GDS clásicos).
- **PNR** — Passenger Name Record (Order ID en NDC).
- **Offer** — propuesta comercial inmutable con TTL. Tiene un `OfferID`.
- **OfferItem** — componente de una Offer (típicamente un par origen-destino).
- **Reshop** — recálculo de precio para una modificación.
- **VOID** — cancelación dentro de la "free-cancellation window" (24h en
  general en LATAM).
- **PCI SAQ-A** — el nivel de cumplimiento PCI más liviano. Solo aplica si NUNCA
  procesamos/almacenamos PAN/CVV. Si pasáramos PAN al endpoint de payment de
  LATAM, perderíamos SAQ-A.

---

## 8. Implementación en este repo

| Capa                        | Archivo                                                  | Estado                     |
| --------------------------- | -------------------------------------------------------- | -------------------------- |
| Token + cache               | `providers/latam-ndc/src/auth/token.service.ts`          | ✅                         |
| HTTP client + headers       | `providers/latam-ndc/src/http/latam-http.client.ts`      | ✅                         |
| AirShopping request builder | `providers/latam-ndc/src/airshopping/request.builder.ts` | ✅                         |
| AirShopping response mapper | `providers/latam-ndc/src/airshopping/response.mapper.ts` | ✅ tolerante a variaciones |
| OfferPrice                  | —                                                        | 📅 Fase 2                  |
| OrderCreate                 | —                                                        | 📅 Fase 3                  |
| Cancel/Refund/Exchange      | —                                                        | 📅 Fase 4                  |
| Installments/Seats/Services | —                                                        | 📅 según necesidad         |

---

## 9. Variables de entorno consumidas por el adapter

| Var                     | Tipo   | Default                         |
| ----------------------- | ------ | ------------------------------- |
| `LATAM_API_URL`         | string | `https://sandbox.api.latam.com` |
| `LATAM_API_KEY`         | secret | —                               |
| `LATAM_API_SECRET`      | secret | —                               |
| `LATAM_AGENCY_ID`       | secret | —                               |
| `LATAM_AGENCY_IATA`     | secret | —                               |
| `LATAM_AGENCY_NAME`     | string | —                               |
| `LATAM_TRAVEL_AGENT_ID` | secret | — (opcional)                    |
| `LATAM_COUNTRY`         | string | — (`CO`/`CL`/`BR`/`PE`/`AR`)    |
| `LATAM_FORCE_MOCK`      | bool   | `false`                         |

Si falta cualquiera de las 5 críticas (`apiKey`, `apiSecret`, `agencyId`,
`agencyIata`, `country`), el adapter cae en modo MOCK y loguea cuáles faltan
al iniciar.
