---
titulo: "Sabre — Hoteles y Autos"
fecha: 2026-08-25
estado: revisado contra contratos oficiales
Fuentes: ver 00-fuentes.md
---

# Sabre — Hoteles y Autos

> **Alcance:** verticales **hotel** y **vehículo** de Sabre, el flujo de **modificación de hoteles** (`modifyBooking`), y el caso **multi-producto en un solo PNR**. Vuelos (NDC/ATPCO/LCC), tickets, fulfill y perfiles están en los otros documentos de `docs/sabre/`.

## 0. Cómo leer este documento

Se usa la convención de marcado de `00-fuentes.md` (§4): **VERIFICADO** (colección), **VERIFICADO-SPEC** (contrato OpenAPI o página oficial), **[INFERIDO]**, **DESCONOCIDO**.

### 0.1 Tres correcciones de procedencia respecto de la primera pasada

1. **Las 4 respuestas guardadas de la colección NO están vacías.** Pesan 16.479 bytes cada una y están extraídas en `slices/responses/*.json`. **Pero no sirven para esta vertical:** las 4 son `POST /v1/orders/view` de un **Order NDC de aire** (`order.pnrLocator: "TOSGCZ"`, 1 `orderItem`, `fareDetails`, `journeys`, `segments`). Un grep sobre ellas devuelve **0 apariciones** de `hotel`, y las 10 de `car` son `carrierCode` / `carrierName` / `marketingCarrier`. **VERIFICADO.** Conclusión: la colección sigue sin aportar ni una respuesta de hotel ni de auto — pero eso ya **no** es un bloqueante, porque los contratos oficiales sí las especifican (§2.1.6, §4.1.1).
2. **La fuente Sabre es** `sabre/Booking Management API v2026.04.postman_collection.json` (1.077 requests). `EXTERNAL_AGENCY.postman_collection.json` es la colección de **LATAM NDC** y no tiene relación. Ver `00-fuentes.md` §1.
3. **El carril SOAP/LLS stateful es central en esta vertical, no marginal.** De los 243 requests SOAP de la colección, **54 son de hotel/auto**: `GetHotelAvailRQ` 26, `HotelPriceCheckRQ` 25, `GetVehAvailRQ` 2, `VehPriceCheckRQ` 1. Se documenta en §1.2 y §6.3.

### 0.2 Volumen real de material

**VERIFICADO** (conteo sobre `requests.jsonl`):

| Métrica | Valor |
| --- | --- |
| Requests con `hotel` en la ruta | **148** |
| Requests con `vehicle` / `veh` / `car` en la ruta | **14** — 9 en `Create Booking / Vehicle`, 4 en `Workflows / 10`, 1 en `Cancel Booking` |
| Endpoints REST propios de hotel | 2 (`/v5/get/hotelavail`, `/v5/hotel/pricecheck`) |
| Endpoints REST propios de auto | 2 (`/v2.0.0/get/vehavail`, `/v1.0.0/veh/pricecheck`) |
| Variantes de bloque `car` en `createBooking` | 5 |

> **Corrección explícita.** La primera pasada dijo «13 requests de auto» aquí, y el documento `10` dijo «3 requests funcionales». Ambas cifras eran incompatibles y ninguna declaraba su criterio. La cifra correcta por nombre de carpeta es **14**; los endpoints REST distintos son **2**. La conclusión de §5.4 (descartar autos de Sabre) se sostiene igual, pero por coste de oportunidad, no por escasez de contrato — el contrato de autos resultó ser rico (§4).

---

## 1. Entornos, autenticación y transporte

**VERIFICADO** (`sabre/BM API TEST CERT - EPR.postman_environment.json`, 425 variables, sólo 6 con valor):

| Variable | Valor |
| --- | --- |
| `rest_endpoint` | `https://api.cert.platform.sabre.com` |
| `soap_endpoint` | `https://webservices.cert.platform.sabre.com` |
| `lls_endpoint` | `https://webservices.cert.platform.sabre.com` |
| `username` | `{{epr}}` |
| `pcc_tkt` | `{{your_target_pcc}}` |
| `ptrta` | `{{atpco_printer_address}}` |

El `rest_endpoint` coincide con el `servers.url` de los contratos de esta vertical: **VERIFICADO-SPEC** `get-hotel-avail-v4.yml:8`, `get-vehicle-availability-v2.yml:14`.

### 1.1 Autenticación REST

**VERIFICADO** — `Workflows / 9 - Hotel Shop, Book, Cancel / 0. REST Authorize ATK` y `Workflows / 10 - Vehicle Shop, Book, Cancel / REST Authorize ATK`:

```
POST {{rest_endpoint}}/v2/auth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {{secret}}
Conversation-ID: {{conv_id}}

grant_type=client_credentials
```

Es el mismo patrón que ya tenemos en `providers/latam-ndc/src/auth/token.service.ts` (OAuth `client_credentials` + cache de token en memoria). Reutilizable cambiando base URL y el armado del `Basic`.

> **CORRECCIÓN — el algoritmo del `secret` NO es [INFERIDO].** La primera pasada afirmó que «la colección no lo genera en ningún script». **Es falso.** El script pre-request **a nivel de colección** (`event[listen=prerequest]`, rama `case 'token'`) lo deriva literalmente:
>
> ```js
> const clientidRaw    = `V1:${username}:${pcc}:AA`;
> const clientidBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(clientidRaw));
> const passwordBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(passwordRaw));
> const secretRaw      = `${clientidBase64}:${passwordBase64}`;
> pm.environment.set('secret', CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(secretRaw)));
> ```
>
> **VERIFICADO.** El tercer segmento del `clientId` es el **PCC** y el cuarto es el literal `AA` (Domain) — no «group:domain», como decía la primera pasada. La fuente canónica de este punto es `01-autenticacion-y-conectividad.md` §2.1; **remitirse allí**. Consecuencia para la bóveda BYOC: **derivamos el secret a partir de (EPR, PCC, password) de cada agencia; no hay que pedirle al cliente un secret precomputado.**
>
> Los contratos confirman además el flujo OAuth2 con credenciales en Basic base64: **VERIFICADO-SPEC** `get-vehicle-availability-v2.yml:44-49` (`x-base64-encode-client-credentials: true`, `tokenUrl: .../v2/auth/token`).

**Token stateless (ATK) vs stateful (ATH).** La documentación oficial de Hotel Price Check lo dice sin ambigüedad: el `Authorization: Bearer <BinarySecurityToken>` puede venir de `TokenCreateRS` (ATK, sin sesión) **o** de `SessionCreateRS` (ATH, con sesión). **VERIFICADO-SPEC** (`help/hotel-price-check-v5/v5-index.txt`, sección «Start with an authentication token»). Es decir: **shop y pricecheck de hotel funcionan perfectamente sin sesión.**

### 1.2 Los dos transportes conviven — y ahora sabemos cuál escoger

| Flujo | Shop (avail) | PriceCheck | Book / Cancel / Modify |
| --- | --- | --- | --- |
| `Workflows / 9 - Hotel Shop, Book, Cancel` | **REST JSON** `POST /v5/get/hotelavail` | **REST JSON** `POST /v5/hotel/pricecheck` | REST JSON `/v1/trip/orders/*` |
| `Create Booking / CSL Hotel / Hotel Preparation` | **SOAP XML** | **SOAP XML** | REST JSON `/v1/trip/orders/createBooking` |
| `ModifyBooking / Hotel modification flows` (6 familias) | **SOAP XML** | **SOAP XML** | REST JSON `/v1/trip/orders/modifyBooking` |
| `ModifyBooking / … / FoP (Hybrid)` (§6.3) | **SOAP XML** | **SOAP XML** | SOAP `UpdatePassengerNameRecordRQ` + REST `modifyBooking` |
| `Workflows / 10 - Vehicle` | **REST JSON** `POST /v2.0.0/get/vehavail` | **REST JSON** `POST /v1.0.0/veh/pricecheck` | REST JSON `createBooking` |
| `Create Booking / Vehicle / Vehicle preparation` | **SOAP XML** | **SOAP XML** | REST JSON |

**VERIFICADO-SPEC.** La documentación oficial zanja la duda: *«Get Hotel Avail supports two API designs: SOAP/XML and REST/JSON. […] you will find the SOAP edition of the API has the same features and capabilities»* (`help/get-hotel-avail-v4/help-documentation-content-services-for-lodging-get-hotel-avail.txt`). **No se pierde funcionalidad usando sólo REST en shop/pricecheck.**

#### Versiones: hay tres conviviendo en el carril SOAP

**CORRECCIÓN a la primera pasada.** El documento advertía que «no existe ningún endpoint `/v3.0.0` de hotel en la colección». Eso es cierto **sólo para las URLs REST**. En el carril SOAP la versión va en el `xmlns` y en `@version`, y hay **tres versiones activas** (**VERIFICADO**, conteo sobre `requests.jsonl`):

| Mensaje | v3.0.0 | v4.0.0 | v5.0.0 | Total |
| --- | --- | --- | --- | --- |
| `GetHotelAvailRQ` | 1 | 3 | 22 | **26** |
| `HotelPriceCheckRQ` | 4 | — | 21 | **25** |
| `GetVehAvailRQ` | — | — | 2 (v2.0.0) | **2** |
| `VehPriceCheckRQ` | — | — | 1 (v1.0.0) | **1** |

Namespaces vistos: `http://services.sabre.com/hotel/avail/v{3,4,5}_0_0` y `http://services.sabre.com/hotel/pricecheck/v{3,5}_0_0`. Los 3 `GetHotelAvailRQ v4.0.0` son precisamente los de la familia **Hybrid** (§6.3).

| Carril | URL / namespace | ¿Tenemos el contrato? |
| --- | --- | --- |
| REST v5 (el que usa `Workflows / 9`) | `POST /v5/get/hotelavail` | ❌ **no** — laguna conocida |
| REST v4 | `POST /v4.0.0/get/hotelavail` — **VERIFICADO-SPEC** `get-hotel-avail-v4.yml:12` | ✅ |
| REST v3 | `POST /v3.0.0/get/hotelavail` — **VERIFICADO-SPEC** `get-hotel-avail-v3.yml:15` | ✅ |
| SOAP v5 / v4 / v3 | mismo payload lógico | por equivalencia declarada arriba |

> **Laguna declarada:** todo lo marcado VERIFICADO-SPEC en §2 sale de **v4**. La colección usa **v5**. La diferencia v4→v5 es **DESCONOCIDA** y es el primer diff que hay que pedir o capturar. Los campos citados aquí son estructurales (nombres OTA), así que el riesgo de que hayan desaparecido es bajo, pero **v5 puede haber añadido campos que este documento no lista**.

#### Sesiones stateful — dónde hacen falta de verdad

Los requests SOAP usan `{{header}}` / `{{footer}}`: el sobre `SOAP-ENV:Envelope` con `MessageHeader` + `Security/UsernameToken`. Visible completo en `Authentication / SessionCreateRQ (Stateful ATH) create session` y en cada `SessionCreateRQ` de la familia Hybrid (**VERIFICADO**):

```xml
<Security xmlns="http://schemas.xmlsoap.org/ws/2002/12/secext">
  <UsernameToken>
    <Username>{{username}}</Username><Password>{{password}}</Password>
    <Organization>{{pcc}}</Organization><Domain>DEFAULT</Domain>
  </UsernameToken>
</Security>
…
<SessionCreateRQ returnContextID="true">
  <POS><Source PseudoCityCode="{{pcc}}"/></POS>
</SessionCreateRQ>
```

**Matiz importante que la primera pasada no tenía.** La documentación oficial de `createBooking` dice: *«This API is designed to operate in a **stateless** way, and accepts both sessionless (ATK) and session-based (ATH) tokens. When a call is made to this API via a session-based token, the session (AAA) is cleared before and after execution»* (**VERIFICADO-SPEC**, `help/help-documentation-create-booking.txt`). Es decir:

- `createBooking`, `getBooking`, `modifyBooking` y `cancelBooking` son **stateless**. No necesitan sesión.
- La sesión aparece en la colección porque esos flujos usan **también** `UpdatePassengerNameRecordRQ` u otros LLS que sí son stateful (§6.3).

> **Recomendación técnica (mantenida y ahora mejor fundada):** usar **REST** para shop / pricecheck / book / modify / cancel. El carril SOAP stateful sólo es imprescindible para el mecanismo de PNR híbrido de §6.3, que es opcional.

---

## 2. Hoteles

### 2.1 `POST /v5/get/hotelavail` — disponibilidad

**VERIFICADO.** URL única en la colección: `POST {{rest_endpoint}}/v5/get/hotelavail`. Headers: `Content-Type: application/json`, `Accept: application/json`, `Conversation-ID: {{conv_id}}`.

> ⚠️ El request llamado `1. Get Hotel Avail /v3.0.0 Latitude Longitude Krakow` tiene URL `/v5/get/hotelavail`. El nombre está heredado de una copia. **No hay dos versiones REST que implementar.**

**VERIFICADO-SPEC** — el spec añade un header opcional `Application-ID` («work with your account manager to generate an application ID») que la colección no usa: `get-hotel-avail-v4.yml:17-21`.

#### 2.1.1 Búsqueda por punto de referencia (código IATA)

`Workflows / 9 / 1. Get Hotel Avail /v5 Sabre GDS Rate` (**VERIFICADO**, recortado):

```json
{
  "GetHotelAvailRQ": {
    "SearchCriteria": {
      "OffSet": 1, "SortBy": "SabreRating", "SortOrder": "ASC",
      "PageSize": 20, "TierLabels": false,
      "GeoSearch": { "GeoRef": {
        "Radius": 200, "UOM": "MI",
        "RefPoint": { "Value": "HAM", "ValueContext": "CODE", "RefPointType": "6" } } },
      "RateInfoRef": {
        "ConvertedRateInfoOnly": false, "CurrencyCode": "USD", "BestOnly": "2",
        "PrepaidQualifier": "IncludePrepaid",
        "StayDateTimeRange": { "StartDate": "{{start_date}}", "EndDate": "{{end_date}}" },
        "Rooms": { "Room": [ { "Index": 1, "Adults": 2, "Children": 0 } ] },
        "RateSource": "100" },
      "HotelPref": { "SabreRating": { "Min": "3", "Max": "5" } },
      "ImageRef": { "Type": "MEDIUM", "LanguageCode": "EN" }
    }
  }
}
```

#### 2.1.2 Búsqueda por lat/long y por código de hotel

Lat/long (**VERIFICADO**, `… / 1. Get Hotel Avail /v5 Latitude Longitude Warsaw`):

```json
"GeoSearch": {
  "GeoRef": { "Radius": 200, "UOM": "MI",
              "GeoCode": { "Latitude": 52.2317, "Longitude": 21.0061 } },
  "GeoAttributes": { "Attributes": [ { "Name": "LOCALAREA", "Value": "WARSAW AREA" } ] }
}
```

Por código (**VERIFICADO**, SOAP, `Create Booking / CSL Hotel / Hotel Preparation / GetHotelAvailRQ Aggregator`):

```xml
<HotelRefs><HotelRef HotelCode="100035516" CodeContext="GLOBAL"/></HotelRefs>
```

Códigos reales útiles como datos de prueba en CERT: `100035516`, `100095894`, `100068656`, `100162744`.

**VERIFICADO-SPEC** — el spec formaliza la exclusión mutua con un `oneOf`: `SearchByGeoSearch` **o** `SearchByHotelRefs` (`get-hotel-avail-v4.yml:151-154`). Y dentro de `GeoRef` hay **tres** modos mutuamente excluyentes, no dos: `GeoCode` (lat/long), `RefPoint` (código o nombre) y **`AddressRef`** (calle/ciudad/país) — `get-hotel-avail-v4.yml:215`, `:239`, `:289`. **`AddressRef` no aparece en ningún ejemplo de la colección: es capacidad nueva descubierta en el contrato.**

#### 2.1.3 `SearchCriteria` — ahora contra el contrato

| Campo | Colección | Contrato (v4) |
| --- | --- | --- |
| `OffSet` | `1`, `2` | `minimum: 1`. Nº de páginas = `MaxSearchResults / PageSize`. **VERIFICADO-SPEC** `:102` |
| `PageSize` | `20`, `200` | **`maximum: 200`**, default 200. **VERIFICADO-SPEC** `:125` |
| `SortBy` | `SabreRating`, `DistanceFrom` | **enum cerrado: `TotalRate` \| `DistanceFrom` \| `SabreRating`**, default `TotalRate`. **VERIFICADO-SPEC** `:108` |
| `SortOrder` | `ASC`, `DESC` | Default derivado: `TotalRate`→ASC, `DistanceFrom`→ASC, `SabreRating`→DESC. **VERIFICADO-SPEC** `:116` |
| `TierLabels` | `true`, `false` | **Resuelto:** si `true`, devuelve `TierLabel` para propiedades preferenciadas (etiquetas de agencia o proveedor). Default `true`. **VERIFICADO-SPEC** `:131`, `:1149` |
| `RateDetailsInd` | `true` | **Resuelto — y no era lo que decía la primera pasada:** controla *«whether only properties with rates should be returned»*, no el desglose de tarifa. Default `true`. **VERIFICADO-SPEC** `:144` |
| `ShopKey` | no usado | Clave cifrada para paginar; con ella sólo se considera `OffSet` y **el resto del request se ignora**. Es el mecanismo correcto de paginación. **VERIFICADO-SPEC** `:137` |
| `RefPointType` | `"6"` | **enum: `5`, `6`, `7`, `11`, `16`, `18`, `37`**. **VERIFICADO-SPEC** `:262` |
| `ValueContext` | `CODE` | enum `NAME` \| `CODE` — se puede buscar por **nombre** de referencia. **VERIFICADO-SPEC** `:255` |
| `BestOnly` | `"1"`, `"2"`, `"3"` | **Resuelto:** `1` = tarifa más baja de todas las fuentes; `2` = la más baja de **cada** fuente; `3` = la mejor de cada fuente **más la negociada/contractual más baja**. **VERIFICADO-SPEC** `:408` |
| `PrepaidQualifier` | `IncludePrepaid` | enum `IncludePrepaid` \| `PrepaidOnly` \| `ExcludePrepaid`. **Todas las tarifas con `RateSource 112` se tratan como prepaid.** **VERIFICADO-SPEC** `:419` |
| `RefundableOnly` | `false` | default `false`. **VERIFICADO-SPEC** `:429` |
| `ConvertedRateInfoOnly` | `false` | Controla si las tarifas vuelven bajo `RateInfo`, `ConvertedRateInfo` o ambos, según haya o no `CurrencyCode`. **VERIFICADO-SPEC** `:435` |
| `TravellerCountry` | no usado | Envía el país del viajero al proveedor para obtener tarifas país-específicas. **Relevante para LATAM.** **VERIFICADO-SPEC** `:449` |
| `RateRange` | sólo en el SOAP de Hybrid (`Min="0.10" Max="1000.0"`) | Requiere `CurrencyCode`; si falta, error `5097`. **VERIFICADO-SPEC** `:456` |
| `CorpDiscount` | no usado en avail | Código de descuento corporativo del viajero, 1-20 alfanum. **VERIFICADO-SPEC** `:468` |
| `LoyaltyIds` / `FrequentFlyerNumber` | no usados | Tarifas de socio de programa de fidelidad. **VERIFICADO-SPEC** `:462`, `:465` |
| `RatePlanCandidates` | `RatePlanCode="AMX"` | Hasta **11** candidatos: máx. 3 con `RatePlanType`, máx. 8 con `RatePlanCode`. `ExactMatchOnly` y `OtherAvailableRatePlans` como modificadores. **VERIFICADO-SPEC** `:561`, `:580` |
| `RateSource` | `"100"`, `"113"` | Ver §2.2 |
| `HotelPref` | `SabreRating{Min,Max}` | Además: `BrandCodes`, `ChainCodes`, `AmenityCodes`, `SecurityFeatureCodes`, `PropertyTypeCodes`, `PropertyQualityCodes`. **VERIFICADO-SPEC** `:678`-`:880`. El SOAP de Hybrid usa `<BrandCodes><BrandCode>10002</BrandCode>` (**VERIFICADO**) |
| `ImageRef` | `{Type, LanguageCode}` | **VERIFICADO-SPEC** `:881` |

#### 2.1.4 Ocupación y multi-habitación — resuelto, con una restricción cara

**VERIFICADO** (SOAP, `GetHotelAvailRQ with 2 ADT 1 CNN`):

```xml
<Rooms><Room Index="1" Adults="2" Children="1"><ChildAges>3</ChildAges></Room></Rooms>
```

**VERIFICADO-SPEC** `get-hotel-avail-v4.yml:532-560`:

- `Room` es array con `minItems: 1`. **El multi-habitación existe** — la primera pasada lo marcó [INFERIDO] porque la colección no lo ejemplifica.
- ⚠️ *«Room Index must be in order if multiple rooms are specified. **All rooms must have the exact same Adult and Child guest count.**»* Confirmado por dos errores oficiales: `0767` («Room Indexes for a multi-room shopping are not sequential») y **`5029`** («Pax configuration should be same across the rooms requested»).
- `ChildAges` es **string con edades separadas por comas** (`"11,12"`), no un array. Edad máxima 18 (error `0852`).
- *«Rates from the GDS do not support infants, so a GDS availability call for 1 adult and 1 child will be treated as a 1 adult shop.»*
- ⚠️ Y en la reserva: *«Multiple room bookings are currently **not supported by GDS hotels**»* — **VERIFICADO-SPEC** `booking-management-v1.yml:5046-5051`.

> **Consecuencia directa sobre el canónico.** Nuestro `RoomDistribution[]` de Despegar admite habitaciones con ocupaciones distintas (2 adultos + 1 adulto y 1 niño). **Sabre no.** Una búsqueda familiar mixta que Despegar resuelve en una llamada, con Sabre son N llamadas o no se puede. Degrada el «tiempo a venta < 2 min» en el caso familiar y hay que decidirlo antes de meterlo al fan-out. **Nuevo riesgo R5.**

#### 2.1.5 Capacidades del contrato que la colección no ejemplifica

Y que sí necesitamos: `AddressRef`, `ShopKey` (paginación correcta), `TravellerCountry`, `ChainCodes` / `AmenityCodes` / `PropertyTypeCodes` como filtros, `LoyaltyIds`.

#### 2.1.6 Forma de la respuesta — **ya no es DESCONOCIDA**

Esto era el bloqueante nº 1 de la primera pasada. **El contrato la especifica entera.** La evidencia de la colección (script de test SOAP) sólo daba la ruta al `RateKey`:

```js
result.Envelope.Body[0].GetHotelAvailRS[0].HotelAvailInfos[0].HotelAvailInfo[0]
      .HotelRateInfo[0].RateInfos[0].RateInfo[0].$.RateKey
```

Y coincide exactamente con el contrato. **VERIFICADO-SPEC** `get-hotel-avail-v4.yml:65-76` y siguientes:

```
GetHotelAvailRS
├── ApplicationResults          (:907)   estado + errores/warnings
└── HotelAvailInfos             (:1003)
    ├── OffSet, MaxSearchResults, ShopKey, SearchLatitude, SearchLongitude
    └── HotelAvailInfo[]        (:1036)
        ├── HotelInfo           (:1050)  ← estático de la propiedad
        ├── HotelRateInfo       (:1422)  ← tarifas
        └── HotelImageInfo      (:2572)  ← media
```

**`HotelInfo`** — **VERIFICADO-SPEC** `:1050`: `HotelCode` (siempre el **Global ID**), `CodeContext` (`SABRE` \| `GLOBAL`), **`SabreHotelCode`** (el ID Sabre si la propiedad está mapeada), `HotelName`, `ChainCode`, `ChainName`, `BrandCode`, `BrandName`, `Distance` + `Direction` + `UOM`, `Logo` (URI), **`SabreRating`** (string, ej. `"3.5"`), `Ordinal`, `TierLabels`, `LocationInfo` (`Address`, `CityName`, `StateProv`, `CountryName`, `Neighborhoods`, `Contact`), `Amenities`, `SecurityFeatures`, `PropertyTypeInfo`, `PropertyQualityInfo`.

> ⚠️ `SabreRating` sigue siendo un **rating propietario de Sabre**, no estrellas oficiales. El error oficial `0822` acota el filtro a 0..5. **Riesgo R12 vigente: no mapearlo directo a `Hotel.starRating`.**
>
> ⚠️ **No hay GIATA.** `HotelCode` es el «Global ID» de Sabre y `SabreHotelCode` el legacy. La deduplicación cross-provider contra Despegar sigue sin resolverse. **Riesgo R4 intacto.**

**`RateInfos.RateInfo[]`** (tarifa cabecera del hotel) — **VERIFICADO-SPEC** `:1439`:
`StartDate`, `EndDate`, **`AmountBeforeTax`**, **`AmountAfterTax`**, `MinSellingRate` (recomendado del proveedor cuando se trabaja con net rates), **`AverageNightlyRate`**, `AverageNightlyRateBeforeTax`, `CurrencyCode`, `TaxInclusive`, `AdditionalFeesInclusive`, `LocalFeesInclusive`, `IncidentalsInclusive`, **`RateSource`**, **`RateKey`** (obligatorio), **`Commission`**.
Hermano: `RateInfos.ConvertedRateInfo`, misma forma, en la moneda pedida.

**`Commission`** — **VERIFICADO-SPEC** `:1525`: `Percent`, `Amount`, `CurrencyCode`, `Type` (`FlatRate` \| `Amount` \| `Percentage` \| `Variable` \| `None`), `CommissionDescription.Text`.

> 🟢 **Esto responde la pregunta 33 de la primera pasada y desbloquea el pricing waterfall.** Sabre **sí** expone la comisión de agencia en la respuesta de avail. Es la base numérica sobre la que el consolidador aplica su override y la agencia su markup (`apps/api/src/pricing/`). Era una de las tres condiciones de gate; queda cumplida documentalmente.

**`HotelRateInfo.Rooms.Room[]`** (`response.Room`, `:1568`) → por habitación: `BedTypeOptions.BedTypes.BedType[]` (`Code` OTA BED + `Description` + `Count`), `RoomDescription{Name, Text[]}`, `AdditionalDetails`, `RoomAmenities`, **`Occupancy{Min,Max}`**, `RatePlans.RatePlan[]`.

**`RatePlan[]`** — **VERIFICADO-SPEC** `:1792`: `RatePlanName`, `RatePlanCode`, `RatePlanType` (OTA RPT, enum `"1"`..`"33"`), **`PrepaidIndicator`** (obligatorio; *«all rates from RateSource 100 are treated as post paid and from rateSource 112 are treated as pre-paid»*), `AvailableQuantity`, `LimitedAvailability`, `RateSource`, `RateKey`, **`ClientId`** (el ID negociado/contractual), **`ProductCode`** (*Inventory Block Code*, sólo GDS), `LoyaltyMemberRate` / `LoyaltyId` / `LoyaltyPoints` / `LoyaltyProgramName` (placeholders), `RatePlanDescription`, `RatePlanInclusions`, **`MealsIncluded`**; y bajo `Room.RateInfo` (`:1980`) los `Rates`/`Rate[]`, `Taxes`/`Tax[]`/`TaxGroups`, `Fees`/`Fee[]`/`FeeGroups`, `RoomExtras`, **`CancelPenalties`**, **`Guarantee`**.

**`MealsIncluded`** — **VERIFICADO-SPEC** `:1944`: `BreakFast`, `Lunch`, `Dinner` (booleanos), `MealPlanIndicator`, **`MealPlanCode`** (OTA MPT), `MealPlanDescription`, `GuestCount`.

> 🟢 **Esto resuelve el board type.** No hay un campo `RO/BB/HB/FB/AI` literal, pero los tres booleanos + `MealPlanCode` permiten **derivarlo determinísticamente**: ninguno → `RO`, sólo desayuno → `BB`, desayuno + cena → `HB`, los tres → `FB`, y `AI` por `MealPlanCode`/descripción. Es un mapper de ~20 líneas. La primera pasada lo llamó «gap serio»; **queda degradado a tarea de mapeo**.

**`CancelPenalties.CancelPenalty[]`** — **VERIFICADO-SPEC** `:2342`: `Refundable` (obligatorio), `Deadline`, `AmountPercent`, `PenaltyDescription.Text`.
**`Deadline`** (`:2461`): `AbsoluteDeadline`, o `OffsetTimeUnit` + `OffsetUnitMultiplier` + **`OffsetDropTime`** (enum `BeforeArrival` \| `AfterBooking` \| `AfterConfirmation` \| `AfterArrival` \| `AfterDeparture`).
**`AmountPercent`** (`:2488`): `Amount`, `Percent`, `CurrencyCode`, `NmbrOfNights`, `BasisType`, `ApplyAs`, `TaxInclusive`, `FeesInclusive`.

> 🟢 **Esto resuelve la política de cancelación estructurada**, el otro «gap crítico» de la primera pasada. Mapea directamente a `RatePlan.cancellation.{refundable, freeCancellationUntil, fees[]}` del canónico. **Bloqueante levantado.**

**`Guarantee`** — **VERIFICADO-SPEC** `:2379`: `GuaranteeType` (ej. `GUAR`), `GuaranteesAccepted.GuaranteeAccepted[]` con **`GuaranteeTypeCode`** (OTA PMT) + `GuaranteeTypeDescription` + `PaymentCards`, `DepositPolicies.DepositPolicy[]` (`Deadline` + `AmountPercent`), `GuaranteeDescription.Text[]`.
**`PaymentCards`** (`:2417`): **`CVVRequired`** (booleano) + `PaymentCard[]{CardCode, value}`.

> 🟢 **`CVVRequired` es una pieza nueva directamente relevante al conflicto PCI (§2.5):** el contrato dice, por tarifa, si la propiedad exige CVV. Existen tarifas que **no** lo exigen.

**`HotelImageInfo.ImageItem[]`** (`:2578`) → `Image[]` con URL, `Category`, `Description` y dimensiones.

**Errores y warnings** — **VERIFICADO-SPEC** (`help/get-hotel-avail-v4/v4-errors.txt`). Formato REST:

```json
"Warning": [ { "type": "Validation", "timeStamp": "2021-05-04T15:57:19.231-05:00",
  "SystemSpecificResults": [ { "Message": [
    { "code": "WARN.0788", "value": "Invalid format for search by distance" },
    { "code": "WarningDetails", "value": "Cannot sort by distance when searching using hotel codes directly" } ] } ] } ]
```

Un mismo código puede volver como `ERR.*` o `WARN.*` según el endpoint y los parámetros. Códigos a tratar en `sabre-hotels-errors.ts`:

| Código | Significado | Acción del ACL |
| --- | --- | --- |
| `0161` | Search Criteria Invalid | Error de validación nuestro |
| `0822` | Rating inválido (Min>Max, Min<0, Max>5) | Validar con Zod antes de salir |
| `0788` | `SortBy=DistanceFrom` con `HotelRefs` | Corregir el builder |
| `0404` | Combinación check-in/check-out inválida | Validación previa |
| `0767` | Índices de habitación no secuenciales | Validación previa |
| **`5029`** | **Config de pax distinta entre habitaciones** | **Rechazar en el borde: Sabre no soporta ocupación mixta** |
| `0852` | `ChildAges` faltante o >18 | Validación previa |
| `0408` | Última página ya mostrada | Fin de paginación, no error |
| `0790` / `0424` / `0775` / `0263` | Nada encontrado / hotel inexistente / sin tarifas | **Resultado vacío, no fallo** — degradación parcial del fan-out |
| `0001` / `0366` / `0448` | Timeout / excepción interna / system error | **Reintento + circuit breaker** |
| `0102` | Sin imágenes | Ignorable |
| `5097` | Falta `CurrencyCode` con `RateRange` | Validación previa |
| `0249` | RateKey inválido en pricecheck | Re-shop |
| `0724` | Error del proveedor | Degradación parcial + log |
| **`5276`** | **«Not authorized to switch to \<pcc\>»** | **Ver §2.3.1 — es el error clave del BYOC** |
| `5099` | PCC de sign-in no es de 4 caracteres | Config de credencial |
| `5027` | Excede el nº máximo de propiedades pedidas | Trocear el `HotelRefs` |

### 2.2 `RateSource` — el hallazgo comercial, ahora con catálogo

**VERIFICADO** — dos requests hermanos idénticos salvo un campo:

| Request | `RateSource` | Etiqueta |
| --- | --- | --- |
| `Workflows / 9 / 1. Get Hotel Avail /v5 Sabre GDS Rate` | `"100"` | "Sabre GDS Rate" |
| `Workflows / 9 / 1. Get Hotel Avail /v5 Booking.com rate` | `"113"` | "Booking.com rate" |

`GetHotelAvailRQ Aggregator` (SOAP) también usa `113` (**VERIFICADO**).

**Lo que el contrato añade, y es mucho:**

1. **`RateSource` acepta una LISTA separada por comas.** El ejemplo del spec es literalmente `100,112,110,113`, y la descripción dice *«Specifies the sources to be checked for rates. **When blank, all allowed rate sources are used** to fetch the rates.»* — **VERIFICADO-SPEC** `get-hotel-avail-v4.yml:473-478`.
   > 🟢 **Esto responde la pregunta 27.** El fan-out GDS + agregador es **una sola llamada**, no dos. Y omitir el campo consulta todas las fuentes autorizadas. **Corrige la lectura de la primera pasada** («es un fan-out de dos llamadas»).
2. **Existen al menos cuatro códigos**: `100`, `110`, `112`, `113`. El `112` es la fuente **prepaid** (`PrepaidQualifier` la trata como tal; `PrepaidIndicator` de `RatePlan` también). **VERIFICADO-SPEC** `:419`, `:1849`.
3. **El catálogo nominal está en `booking-management-v1.yml:9306` (`HotelSourceEnum`)**, aplicado a `hotels[].sourceTypeName` en la respuesta de `getBooking`: **`Legacy`, `Sabre GDS`, `Expedia Associate Network`, `HotelBeds.com`, `Booking.com`, `CMNet`, `Unknown`**. El campo hermano `sourceTypeCode` es el numérico (ejemplo `100`). **VERIFICADO-SPEC** `:3030-3040`.

> **Lectura de negocio, reforzada:** con **una sola credencial Sabre** se accede a **seis inventarios** — GDS clásico (contratos de cadena, negociados de la agencia, corporativos por `RatePlanCode`/`ClientId`), Expedia Affiliate Network, HotelBeds, Booking.com, CMNet y legacy. `HotelBeds.com` es especialmente notable: **ya figura como proveedor en nuestro roadmap** (`docs/research/03-integraciones-ecosistema.md`) y Sabre lo revende. Habría que comparar condiciones antes de integrarlo por duplicado.
>
> **Correspondencia código↔nombre:** confirmada sólo para `100` (ejemplo del spec en `sourceTypeCode` junto a `Sabre GDS`) y `113`↔Booking.com (por el nombre del request de la colección más el campo `pinCode`, que el spec describe como *«Identifier of the hotel reservation as provided by **Booking.com**»*). El mapeo de `110` y `112` sigue **DESCONOCIDO**.

### 2.3 `POST /v5/hotel/pricecheck` — verificación de tarifa

**VERIFICADO** — `Workflows / 9 / 2. Hotel Price Check /v5`:

```json
{ "HotelPriceCheckRQ": {
    "POS": { "Source": { "PseudoCityCode": "{{pcc}}" } },
    "RateInfoRef": { "RateKey": "{{rate_key}}" } } }
```

**VERIFICADO-SPEC** `hotel-price-check-v5.yml:19` — **este contrato sí es el de la versión que usa la colección** (`/v5/hotel/pricecheck`). No hay laguna de versión aquí.

Lo que el contrato añade al request (`:106-161`):

- `RateInfoRef.StayDateTimeRange` y `RateInfoRef.Rooms` son **opcionales en el pricecheck**: se puede **re-precificar el mismo `RateKey` con otras fechas u otra ocupación** sin repetir el avail. Aplican las mismas restricciones de multi-room (`:150`).
- **`CorporateNumber`** a nivel de `HotelPriceCheckRQ`: *«The corporate number of the agency for whom the shopping request in CSL is made. Useful for corporate-level functionalities, such as **preferencing and credentials**»* (`:100-104`).

#### 2.3.1 `POS.Source.PseudoCityCode` — el punto exacto del BYOC

La primera pasada marcó esto [INFERIDO] y era la pregunta 28. **Resuelto.** **VERIFICADO-SPEC** `hotel-price-check-v5.yml:79-98`:

> *«Contains Point of Sale information to support shopping in an **authorized (AAA Access) branch location (PCC)** while remaining signed-into the home branch or IPCC. […] Although the shopping happens in the branch location PCC given in the request, **the underlying Session or Token used to authenticate or call this API remains unchanged**.»*

Y el error oficial **`5276`** cierra el círculo: *«Not authorized to switch to \<pcc\> — The PCC under the POS element should have **branch access relationship** with your sign-in PCC. Add the correct branch access relationship as necessary, and then wait for five (5) mins for the changes to take effect»* (**VERIFICADO-SPEC**, `help/get-hotel-avail-v4/v4-errors.txt`).

> 🟢 **Esto responde la pregunta 29 y define la arquitectura del BYOC de Sabre.** El modelo es **una credencial del consolidador + N PCCs de agencia con branch access**, no N juegos de credenciales. Encaja casi exactamente con `apps/api/src/provider-credentials/provider-credentials.service.ts` y con la jerarquía `consolidador → agencia → sub-agencia` de `docs/platform/12-modelo-consolidador-y-plan.md`:
>
> - El **consolidador** posee el EPR y el PCC de sign-in.
> - Cada **agencia hija** aporta su PCC, y el consolidador (o Sabre) establece la relación de branch access.
> - Nuestra bóveda guarda **PCC por nodo**, no credenciales completas por nodo. Mucho más barato de operar y de revocar.
> - La propagación tarda **5 minutos**: modelarlo como estado «pendiente de activación» en el onboarding de agencia, no como alta inmediata.
> - `5099` obliga a validar en el formulario de alta que el PCC sea alfanumérico de 4 caracteres.
>
> **Pendiente:** si el mismo `POS` existe en el body REST de `get/hotelavail` v5. En v4 el spec lo declara (`get-hotel-avail-v4.yml:77`) pero los ejemplos REST de la colección no lo mandan. El error `5276` está listado para «las CSL shopping APIs» en plural, lo que sugiere que sí. **Confirmar en CERT.**

#### 2.3.2 Respuesta del pricecheck

Evidencia de la colección (**VERIFICADO**, script de test):

```js
pm.environment.set("booking_key", jsonData.HotelPriceCheckRS.PriceCheckInfo.BookingKey);
const rawGuaranteeType = jsonData.HotelPriceCheckRS.PriceCheckInfo
  .HotelRateInfo.Rooms.Room[0].RatePlans.RatePlan[0].RateInfo.Guarantee.GuaranteeType;
const guaranteeMap = { GUAR: "GUARANTEE", DEP: "DEPOSIT" };
pm.environment.set("guarantee_type", guaranteeMap[rawGuaranteeType] || rawGuaranteeType);
```

Equivalente SOAP (**VERIFICADO**): `Envelope.Body[0].HotelPriceCheckRS[0].PriceCheckInfo[0].$.BookingKey`.

El contrato confirma las rutas y añade lo que faltaba. **`PriceCheckInfo`** — **VERIFICADO-SPEC** `hotel-price-check-v5.yml:262-310`, campos **obligatorios**: `BookingKey`, **`PriceChange`** (booleano), **`PriceDifference`**, `CurrencyCode`, `HotelInfo`, `HotelRateInfo`. Opcionales: `ConvertedPriceChange`, `ConvertedPriceDifference`, `ConvertedCurrencyCode`.

> 🟢 **`PriceChange` + `PriceDifference` es exactamente el contrato de UX del prebook** que ya implementamos con Despegar («la tarifa subió X, ¿continúas?»). Se mapea 1:1 y no hay que inventar nada.

**`HotelRateInfo.RateUnavailability.RateSource[]`** (`:505-535`) — cuando una fuente **no** devolvió tarifa, explica por qué: `{Source, Reason, DisplayMessage}` (ej. `"110"` / *«Results filtered due to rate range search criteria»*). Es **degradación parcial explicada por proveedor**; encaja directo con `apps/api/src/search/provider-fanout.ts`.

**Hechos operativos** (**VERIFICADO-SPEC**, `help/hotel-price-check-v5/v5-index.txt`):

1. *«Hotel Price Check is a **mandatory step** you need to take before you can proceed with booking a product.»*
2. ⚠️ **CORRECCIÓN:** *«the rateKey returned in shopping responses **does not expire**, so it can be used in the Hotel Price Check request at any time. **The rate may have expired**, which will be reflected in the Hotel Price Check response.»* La primera pasada llamó al `RateKey` «token efímero de tarifa». **No lo es.** Se puede persistir indefinidamente (en una cotización del Package Studio, por ejemplo) y revalidar cuando haga falta. **Es una ventaja de producto real frente al `choiceId` de Despegar.**
3. El `RateKey` se descifra del lado de Sabre para reconstruir el request original de avail. No hay que guardar el contexto.
4. Existe también un **`Get Hotel Details`** que devuelve `RateKey`: endpoint que **no está en la colección** y del que no tenemos spec.

**El mapeo `GUAR`/`DEP` → `GUARANTEE`/`DEPOSIT` sigue siendo obligación del cliente.** El spec no lo automatiza: `Guarantee.GuaranteeType` devuelve el código corto (ejemplo `GUAR`, `get-hotel-avail-v4.yml:2384`) y `hotel.paymentPolicy` en `createBooking` exige el largo (enum `DEPOSIT` \| `GUARANTEE` \| `LATE`, `booking-management-v1.yml:8909`). **Hay que replicar el `guaranteeMap` en el ACL.** El código corto de `LATE` sigue **DESCONOCIDO**; la vía correcta para determinarlo es `GuaranteesAccepted.GuaranteeAccepted[].GuaranteeTypeCode` (OTA PMT), que sí es un catálogo público.

### 2.4 `POST /v1/trip/orders/createBooking` — reserva de hotel

**VERIFICADO** — headers en todos los `createBooking` de hotel y auto:

```
accept: application/json
Content-Type: application/json
X-Sabre-Group: G7RE
X-Sabre-Current-City: G7RE
x-request-id: dnjas82bd102bd912requestid
ConversationId: dnjas82bd102bd912conversationid
```

En los flujos de ModifyBooking el valor es `U9PK` (**VERIFICADO**). Los tests verifican que `x-request-id` y `ConversationId` vuelven idénticos en la respuesta (**VERIFICADO**): correlación de trazas OpenTelemetry gratis.

> ⚠️ **CORRECCIÓN a la primera pasada.** El documento afirmaba que `X-Sabre-Group` / `X-Sabre-Current-City` «son el vehículo natural del BYOC por PCC». **El contrato no menciona esos headers en ninguna parte** (grep sobre `booking-management-v1.yml`: 0 apariciones). El mecanismo **documentado** es distinto y hay que preferirlo:
>
> - **`targetPcc`** en el body, presente en `createBooking`, `modifyBooking`, `cancelBooking`, `getBooking` y `fulfillTickets` (8 apariciones: `booking-management-v1.yml:257, 397, 495, 569, 642, 704, 873, 953`). Patrón `^[A-Z0-9]{3,4}$`. ⚠️ *«The API **does not revert context** after completing the booking»* — hay que asumir que la sesión queda apuntando al PCC destino. **Nuevo riesgo R6.**
> - **`POS.Source.PseudoCityCode`** en shop y pricecheck (§2.3.1).
>
> Los headers son **VERIFICADO** en la colección pero **no contractuales**. Implementar contra `targetPcc`; mandar los headers, si acaso, como refuerzo.

#### Bloque `hotel`

**VERIFICADO** — `Workflows / 9 / 3. createBooking` (recortado):

```json
{
  "agency": { "address": { "…": "…" }, "agencyCustomerNumber": "1234567", "ticketingPolicy": "TODAY" },
  "travelers": [
    { "givenName": "John", "surname": "Kowalski", "passengerCode": "ADT" },
    { "givenName": "Mary", "surname": "Kowalski", "passengerCode": "ADT" } ],
  "contactInfo": { "emails": ["travel@sabre.com"], "phones": ["+123456"] },
  "hotel": {
    "bookingKey": "{{booking_key}}",
    "corporateDiscountCode": 6878700,
    "rooms": [ { "isSmoking": false, "bedTypeCode": 3, "physicalDisabilityCode": 3,
                 "travelerIndices": [1, 2] } ],
    "specialInstruction": "Need a wi-fi in the room.",
    "paymentPolicy": "{{guarantee_type}}",
    "formOfPayment": 1
  },
  "payment": { "formsOfPayment": [ "…" ] }
}
```

**Contrastado con `HotelToBook`** (**VERIFICADO-SPEC** `booking-management-v1.yml:5020-5108`):

| Campo | Estado tras el contraste |
| --- | --- |
| `bookingKey` | **Obligatorio** (`required: [bookingKey]`), 1..240 chars. *«createBooking will automatically decode the booking key, obtain the hotel property ID, rate details, and **determine the source (GDS or Aggregator)**»* (help oficial). **No hay que decirle a Sabre de qué fuente vino.** |
| **`useCsl`** | ✅ **AMBIGÜEDAD RESUELTA.** El contrato sólo conoce **`useCsl`** (`:5026`), booleano, **default `true`**. `useCSL` (la grafía de `createBooking - Air with CSL hotel`) es **un error del ejemplo de Postman**. Además: *«Legacy content has been blocked in Sabre due to the migration to CSL content only»* — **el campo es hoy inútil: siempre CSL.** |
| `corporateDiscountCode` | `integer`, `minimum: 1`. *«Applies to **GDS hotels only**»*. |
| `rooms` | array 1..99, pero *«**Multiple room bookings are currently not supported by GDS hotels**»* (`:5050`). |
| `rooms[].isSmoking` | booleano, default `false`. |
| **`rooms[].bedTypeCode`** | ✅ **Catálogo identificado:** *«Pass OTA Code Table (**BED**) for EAN aggregator hotel bookings»* (`:5085`). Es la tabla pública OTA `BED`, la misma que devuelve `BedType.Code` en el avail. |
| **`rooms[].physicalDisabilityCode`** | ✅ **Catálogo identificado:** OTA Code Table **`PHY`** (`:5090`). |
| **`rooms[].roomExtras[].roomExtraType`** | ✅ **Valores soportados enumerados:** **`26` = Crib, `91` = Roll-away Bed, `196` = Extra Person** (`:5120`). La tabla completa es OTA `RMA`. |
| `rooms[].roomExtras[].quantity` / `.amount` | 1..99 / patrón decimal. |
| `rooms[].travelerIndices` | 1-based sobre `travelers`. *«It is assumed that the **first traveler will be considered the lead guest**»*. |
| `specialInstruction` | **Singular confirmado en `createBooking`** (`:5054`) y **plural (`specialInstructions`) confirmado en `modifyBooking`** (`:2824`) y en `car` (`:7234`). ✅ **No es un typo del análisis: la API es inconsistente por diseño.** |
| `paymentPolicy` | enum `DEPOSIT` \| `GUARANTEE` \| `LATE` (`:8909`). ⚠️ Reglas: *«`DEPOSIT` sólo con tarjeta, agencia o corporate; `GUARANTEE` sólo con tarjeta, agencia, IATA, company o corporate; con `LATE` **no indicar `formOfPayment`**»*. |
| `formOfPayment` | entero 1..**11**, índice 1-based. *«Forms of payment applicable to hotel booking are `PAYMENTCARD`, `AGENCY_NAME`, `AGENCY_IATA`, `CORPORATE`, `COMPANY_NAME`, `VIRTUAL_CARD`»*. |
| **`associatedFlightDetails`** | 🆕 **Campo ausente de todos los ejemplos de la colección** (`:5074`, definición `:3183`): `arrivalAirlineCode`, `arrivalFlightNumber`, `arrivalTime`, `departureAirlineCode`, `departureFlightNumber`, `departureTime`. Envía al hotel la info de llegada/salida del vuelo. **Es el gesto de Package Studio «este hotel va con este vuelo» sin necesidad de PNR único.** Ver §6.5. |
| `rooms[].productCode` | No existe en `RoomToBook`; sí en `RoomToModify` (`:5143`). Confirmado. |

**`errorHandlingPolicy`** en `createBooking` — **VERIFICADO-SPEC** `:698-703`, `CreateErrorPolicyEnum` (`:8918`), array de:
`HALT_ON_ERROR` (default) · `DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR` (sólo ATPCO) · **`DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR`** · **`DO_NOT_HALT_ON_CAR_BOOKING_ERROR`** · `DO_NOT_HALT_ON_ANCILLARY_BOOKING_ERROR` · `DO_NOT_HALT_ON_SEAT_BOOKING_ERROR` · `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR`.

> 🟢 **Esto responde la pregunta 26 (transaccionalidad).** `createBooking` con vuelo + hotel + auto es **`HALT_ON_ERROR` por defecto**: si falla el hotel, se detiene y no se completa. Y se puede **optar explícitamente** por éxito parcial por vertical. Es decir: el PNR multi-producto **sí elimina** una clase entera de sagas de compensación, y además deja elegir la política. Es un argumento de producto fuerte, y hay que trasladarlo a `04-*` §5.2 junto a los `haltOn…` de la familia Hybrid (§6.3).

**Otros campos de `CreateBookingRequest` relevantes** (**VERIFICADO-SPEC** `:694-800`): `asynchronousUpdateWaitTime` (0..10.000 ms, para el redisplay de NDC), `remarks[]`, `notification` (email o queue placement, no ambos), `retentionEndDate` + `retentionLabel` (mantener el PNR vivo tras el último ítem — útil para paquetes con hueco), `profiles[]` (1..13).

**Respuesta** (`CreateBookingResponse`, **VERIFICADO-SPEC** `:804-830`): `timestamp`, **`confirmationId`** (*«The Sabre system considers it a PNR locator»*, patrón `^[A-Z0-9]{6,}$`), **`booking`** (la estructura completa de `getBooking`, §2.8), `errors[]`, `request` (eco del request).

> 🟢 **Pregunta 4 de la primera pasada resuelta.** El PNR viene en `confirmationId`; el número de confirmación del hotel en `booking.hotels[].confirmationId`; los errores en `errors[]`, cada uno con `{category, description, type, fieldPath, fieldName, fieldValue}` (**VERIFICADO-SPEC**, `help/help-documentation-create-booking.txt`, sección «Error structure»).

#### Variante con perfil

`createBooking - CSL hotel with profile` (**VERIFICADO**) añade `profiles: [{ uniqueId, profileTypeCode: "TVL", domainId: "{{pcc}}" }]` y **omite `travelers` y `contactInfo`**. El contrato lo confirma: *«When a traveler profile is loaded, traveler fields in the booking request may be partially or fully pre-populated»* (`:722`). Interesante para que `apps/api/src/crm/` sincronice clientes recurrentes como perfiles TVL. Fuera de alcance de fase 1.

### 2.5 Formas de pago (`payment.formsOfPayment[]`)

**VERIFICADO** — tipos vistos en los ejemplos de hotel/auto:

| `type` | Campos propios |
| --- | --- |
| `PAYMENTCARD` | `cardTypeCode` (`VI`), `cardNumber`, `cardSecurityCode`, `expiryDate` (`YYYY-MM`), `cardHolder{givenName,surname,email,phone,address{…}}`, opcional `authentications[]` (§2.6), opcional `manualApproval{…}` |
| `VIRTUAL_CARD` | `virtualCard{customerAccountCode, agencyEmail, hotelFax, hotelName, roomType, roomDescription, rateAmount{amount,currencyCode}, virtualCardCharges[]}` |
| `AGENCY_NAME` | `agencyAddress{name,street,city,stateProvince,postalCode,countryCode}` |
| `AGENCY_IATA` | `agencyIataNumber` |
| `CORPORATE` | `corporateId` |
| `COMPANY_NAME` | `companyAddress{…}` |
| `CASH` / `CHECK` | sin campos |
| `MISCELLANEOUS` | `miscellaneousCreditCode`, `extendedPayment`, `boardingTaxAmount` |
| `INSTALLMENTS` | `numberOfInstallments`, `airlinePlanCode`, `installmentAmount`, `netBalance` |

**Restricciones contractuales** (**VERIFICADO-SPEC**):

- Hotel acepta: `PAYMENTCARD`, `AGENCY_NAME`, `AGENCY_IATA`, `CORPORATE`, `COMPANY_NAME`, `VIRTUAL_CARD` (`booking-management-v1.yml:5070`).
- **Auto acepta sólo dos**: `PAYMENTCARD` y **`VOUCHER`** (`:7229`) — `VOUCHER` no aparece en ningún ejemplo de la colección.
- Índice máximo **11** en ambos.

#### 🚨 El conflicto PCI — actualizado, y con dos salidas nuevas

`CLAUDE.md` fija **hosted checkout únicamente en fase 1 (PCI SAQ-A), nunca PAN/CVV en servidor**. `createBooking` con `PAYMENTCARD` exige `cardNumber` + `cardSecurityCode` en el body. **El conflicto sigue siendo real.** Pero el contrato aporta dos hechos que la primera pasada no tenía:

1. **`paymentPolicy: "LATE"` es contractual y explícito**: *«When using `LATE` payment **do not indicate `formOfPayment`** as this method (supported by some hotel suppliers) allows customers to **make a booking without any form of payment**»* (`:5058-5062`). No es un workaround: es una política de pago de primera clase. Cubre el caso «pago en destino».
2. **`GuaranteesAccepted` + `PaymentCards.CVVRequired` en la respuesta de avail** (**VERIFICADO-SPEC** `get-hotel-avail-v4.yml:2394-2443`) permiten **saber, por tarifa y antes de mostrarla, qué garantías acepta la propiedad y si exige CVV**. Es decir: se puede **filtrar el inventario en el fan-out** para mostrar sólo tarifas reservables con `AGENCY_IATA` / `CORPORATE` / `LATE`, y nunca tocar un PAN.

> **Esto convierte un bloqueante binario en una decisión de alcance.** Ver §5.4 y «Decisiones». Las salidas son:
> - **(a)** Filtrar por `GuaranteeTypeCode` y vender sólo tarifas garantizables con IATA / corporate / LATE → SAQ-A intacto, inventario recortado (cuánto: **DESCONOCIDO**, medible en el spike).
> - **(b)** `VIRTUAL_CARD` con un emisor externo tipo Conferma/WEX → PAN virtual de un solo uso; sigue viajando en el body pero **no es el PAN del cliente**. Reduce el alcance PCI drásticamente. La colección no muestra de dónde sale el número virtual — **[INFERIDO]** es un emisor externo.
> - **(c)** Asumir SAQ-D. No recomendado.

`INSTALLMENTS` (cuotas) con `numberOfInstallments`, `airlinePlanCode` e `installmentAmount` es **exactamente el patrón brasileño/colombiano de venta en cuotas**. Aparece en el ejemplo de vuelo + hotel, no en el de hotel solo.

### 2.6 Strong Customer Authentication (SCA / 3DS)

**VERIFICADO** — `Create Booking / CSL Hotel / createBooking - CSL hotel with profile + Strong Customer Authentication`. Array `authentications[]` **dentro** de la forma de pago `PAYMENTCARD`:

```json
{ "type": "PAYMENTCARD", "cardTypeCode": "VI",
  "cardNumber": "{{creditCardNumber}}", "cardSecurityCode": "{{cardSecurityCode}}",
  "expiryDate": "{{creditCardExpiryDate}}",
  "authentications": [ {
    "secureTransactionId": "ABCDEFGHI123456789012!.1234567890123",
    "issuesCode": "AO", "channelCode": "SC", "resultCode": "OK",
    "electronicCommerceIndicator": "AB", "cardNumberCollectionCode": "K",
    "exemptionTypeCode": "EC", "mandateTypeCode": "NS",
    "originalPaymentReference": "{{creditCardNumber}}", "merchantName": "TEST CREDIT CARD",
    "secureAuthenticationValue": "ABC123455533533444455555678",
    "updatedDateTime": "2019-08-19T09:35:10", "amount": "1234.56", "currencyCode": "USD",
    "version": "120", "verificationResultCode": "PASS",
    "tokenAuthenticationValue": "ABC3434334343556677487312567" } ],
  "cardHolder": { } }
```

**VERIFICADO-SPEC** (help oficial de `createBooking`): *«Starting in **v1.9** of the Booking Management API, the Create Booking method supports **Payment Service Directive 2 (PSD2) compliant Strong Customer Authentication (SCA)** for payment cards. When using payment cards for hotel bookings, specify SCA information under `payment.formsOfPayment.authentications`»*.

Lectura correcta, confirmada: **Sabre no hace el 3DS; recibe el resultado de un 3DS hecho fuera** (por nosotros o por un PSP). `secureAuthenticationValue` es el CAVV, `electronicCommerceIndicator` el ECI, `version: "120"` la versión del protocolo. Es pass-through de evidencia hacia el proveedor del hotel.

Catálogos de `issuesCode`, `channelCode`, `exemptionTypeCode`, `mandateTypeCode`, `cardNumberCollectionCode`, `verificationResultCode`: **DESCONOCIDOS** (el spec los declara string libre).

**Implicación práctica sin cambios:** este campo permite que un hosted checkout (Stripe / Mercado Pago haciendo el 3DS) alimente a Sabre, **pero sigue exigiendo el PAN en el mismo objeto**. No resuelve §2.5 por sí solo.

### 2.7 `cancelBooking`

**VERIFICADO** — `Workflows / 9 / 4. cancelBooking`:

```json
{ "confirmationId": "{{pnr}}", "retrieveBooking": true,
  "cancelAll": true, "errorHandlingPolicy": "ALLOW_PARTIAL_CANCEL" }
```

Cancelación selectiva por ítem (**VERIFICADO**, `Cancel Booking /v1 Cancel by Item Id - Hotels`):

```json
{ "confirmationId": "{{pnr}}", "retrieveBooking": true, "cancelAll": false,
  "errorHandlingPolicy": "HALT_ON_ERROR",
  "hotels": [ { "itemId": 42 }, { "itemId": 43 }, { "itemId": 44 } ] }
```

Y `Cancel by Item Id - Flights, Hotels, Cars` (**VERIFICADO**) cancela `cars[]`, `flights[]` y `hotels[]` del mismo PNR en una llamada.

**VERIFICADO-SPEC** `booking-management-v1.yml:8942`: **`CancelErrorPolicyEnum` tiene exactamente dos valores** — `HALT_ON_ERROR` (default) y `ALLOW_PARTIAL_CANCEL`. **Pregunta 18 cerrada: no hay más.**
`cancelAll: true` → *«segments of all kinds will be cancelled […] Flights, Hotels, Cars, Trains, Cruises and all other segments included in the response **are ignored**»* (`:356`).

⚠️ **Discrepancia de tipo detectada:** la colección manda `"itemId": 42` (número); el contrato declara `itemId` como **string** con patrón `^[A-Z0-9]+$` (`HotelReference`, `:2850`; `CarReference`, `:3251`). **Emitir string en el ACL.**

### 2.8 `getBooking` — recuperación

**VERIFICADO** — body mínimo: `{ "confirmationId": "{{pnr}}" }`. Filtro por vertical: `{ "confirmationId": "…", "returnOnly": ["FLIGHTS", "HOTELS"] }`.

Campos que la colección demuestra leer (**VERIFICADO**, scripts de test):

```js
jsonData.bookingSignature                        // concurrencia optimista
jsonData.hotels[0].itemId
jsonData.hotels[0].room.productCode
jsonData.payments.formsOfPayment[0].cardNumber   // nótese "payments" (plural)
```

⚠️ **Asimetría confirmada:** request `payment` (singular) vs respuesta y `after` de modify `payments` (plural). **VERIFICADO** en la colección; el contrato usa `payment` en `CreateBookingRequest` (`:758`) y la respuesta hereda de `Booking`.

#### 2.8.1 La respuesta completa — **ya no es DESCONOCIDA**

**VERIFICADO-SPEC** `booking-management-v1.yml:1053` (`Booking`). Nivel raíz: `bookingId` (PNR locator **o `orderId` NDC**, según el tipo de contenido), `startDate`, `endDate`, **`isCancelable`**, **`isTicketed`**, `agencyCustomerNumber` (número DK), `creationDetails`, `contactInfo`, `travelers[]`, `travelersGroup`, **`flights[]`**, `journeys[]`, y — por las definiciones `Hotel` (`:2769`) y `Car` (`:3244`) — **`hotels[]`** y **`cars[]`**, cada uno = `Reference{itemId}` + `Item{…}`.

**`hotels[]`** (`HotelReference` + `HotelItem`, `:2850` / `:2863`) — obligatorios: `hotelName`, `address`, `checkInDate`, `checkInTime`, `checkOutDate`, `checkOutTime`, `isRefundable`. Además:

| Campo | Qué es |
| --- | --- |
| `itemId` | string `^[A-Z0-9]+$` — el id del ítem dentro del PNR |
| **`confirmationId`** | **el localizador del proveedor del hotel** |
| `hotelName`, `address`, `contactInfo` | estático de la propiedad |
| `checkInDate/Time`, `checkOutDate/Time` | en **hora local del hotel** |
| `corporateDiscountCode`, `leadTravelerIndex`, `numberOfGuests`, `specialInstructions` | eco de la reserva |
| **`room`** | ver abajo |
| **`isRefundable`** + **`refundPenalties[]`** | condiciones y coste de cancelación (`HotelDateRangeRefundPenalty`, `:8544`) |
| `refundPenaltyPolicyCode` | código de penalidad para contenido GDS legacy |
| **`hotelStatusCode`** / `hotelStatusName` | estado de la reserva en el proveedor (1-2 letras + descripción) |
| `chainCode`, `chainName`, `propertyId`, `sabrePropertyId` | identificación |
| **`guaranteeTypeCode`** / `guaranteeTypeName` | **OTA Payment Type Code** — el catálogo que faltaba para `GuaranteeType` |
| `guaranteePaymentNote`, `paymentPolicy`, `payment` | pago |
| **`associatedFlightDetails`** | el vínculo con el vuelo |
| **`sourceTypeCode`** / **`sourceTypeName`** | `100` / `HotelSourceEnum` (§2.2) |
| **`pinCode`** | identificador de reserva **de Booking.com** — sólo se puebla en ese origen |
| `forceUpdate` | si se aplicó force update |

**`hotels[].room`** (`Room`, `:3065`) — obligatorios `roomType` y `quantity`. Además: `description`, **`roomTypeCode`** (id único de tipo de habitación por proveedor), **`productCode`** (*Inventory Block Code*, **sólo GDS**), **`roomRate`** (`Value{amount, currency}` **por noche**), `roomExtras[]`, `travelerIndices[]`.

> 🟢 **Bloqueante nº 1 de la primera pasada levantado.** *«Sin la forma completa de la respuesta de `getBooking` no se puede construir un `after` correcto»* — ahora está especificada campo por campo. **Ya se puede escribir el `response.mapper.ts` y el constructor del `after`.**

---

## 3. Modificación de hoteles (`modifyBooking`)

Capacidad que **hoy no tenemos con Despegar**: `providers/despegar-hotels/src/index.ts` expone `prebook`, `book`, `getReservation`, `cancelReservation`, `recoverBooking` — ninguna operación de modificación. `providers/agent-cars/src/index.ts`, igual: `confirm`, `cancel`, `release`, sin modify. (**VERIFICADO** en el repo.)

### 3.1 El patrón común

**VERIFICADO** (`tree.txt`):

```
[SessionCreateRQ (Stateful ATH)]   ← sólo en 8 de las 12 variantes de FoP
GetHotelAvailRQ    (SOAP)  → rateKey
HotelPriceCheckRQ  (SOAP)  → bookingKey
createBooking      (REST)  → PNR
getBooking         (REST)  → bookingSignature + hotels[0].itemId [+ room.productCode]
modifyBooking      (REST)  → aplica el cambio
getBooking         (REST)  → verifica (algunas variantes: ":printDiff")
[SessionCloseRQ]
```

Envelope (**VERIFICADO**):

```json
{ "bookingSignature": "{{bookingSignature}}", "confirmationId": "{{pnr}}",
  "before": { }, "after": { }, "retrieveBooking": true,
  "receivedFrom": "Booking Management API testing" }
```

#### 3.1.1 CORRECCIÓN: no es «declarativo», es un **diff de dos estados**

La primera pasada escribió: *«El `after` es declarativo, no un delta»*. **El contrato lo precisa y cambia el modelo mental** — **VERIFICADO-SPEC** `booking-management-v1.yml:830-870`:

- `before` **y** `after` son **ambos obligatorios** (`required: [confirmationId, bookingSignature, after, before]`), ambos del tipo `BookingToModify`.
- *«**Based on the difference between the `before` and `after` properties**, appropriate add, update, or delete operations are performed on the booking.»*

Es decir: **Sabre computa el diff**. `"before": {}` no significa «Sabre resuelve el estado previo por sí mismo» — significa «el estado previo es vacío», por lo que **todo lo que aparezca en `after` se interpreta como alta o actualización, y nada se borra**. Para **borrar** algo (p. ej. eliminar una forma de pago, como hace `Delete FOP` de §6.3) **hay que poblar `before` con el estado real**. Eso explica limpiamente por qué las variantes que borran o sustituyen usan `{{getBookingResponseBody}}` y las que sólo añaden usan `{}`.

> **Consecuencia de implementación:** la regla operativa correcta no es «derivar siempre el `after` de un `getBooking` fresco», sino: **`before` = respuesta literal del `getBooking` inmediatamente anterior; `after` = esa misma estructura con las mutaciones aplicadas**. Un `before` vacío sólo es seguro para altas puras. **Esto reduce el riesgo R7, no lo elimina.**

#### 3.1.2 `bookingSignature` y el enmascarado del PAN

`bookingSignature` es un token de concurrencia optimista (patrón `If-Match`/ETag). **VERIFICADO-SPEC** `:840`: *«The unique identifier of a booking, obtained by the means of the Get Booking method. **Used to verify the state of the booking prior to a modification operation.**»*

Y la primera pasada infirió que `getBooking` devuelve el `cardNumber` enmascarado. **Confirmado y explicado** — **VERIFICADO-SPEC** `:877-888`:

> `unmaskPaymentCardNumbers`: *«If `true`, unmasks payment card information during the `bookingSignature` verification step. To use unmasked data, the **Employee Profile Record (EPR) needs to include the CCVIEW keyword**.»*

Por eso el script de la colección re-inyecta el PAN desde la variable de entorno: sin `unmaskPaymentCardNumbers: true` **y** sin el keyword `CCVIEW` en el EPR, el `before` llevaría el número enmascarado y la verificación de firma fallaría.

> 🚨 **Esto agrava el punto PCI, y ahora sabemos exactamente por qué.** Modificar una reserva con tarjeta almacenada exige **o bien** re-inyectar el PAN completo desde nuestro lado, **o bien** activar `CCVIEW` en el EPR — que es literalmente un permiso para *ver números de tarjeta completos*. Ninguna de las dos es compatible con SAQ-A. **Nuevo riesgo R2.**
>
> Nota adicional: `extraFeatures` debe mandarse **igual** en el `getBooking` previo y en el `modifyBooking`, o la verificación de firma falla (`:886`).

También aparece **`targetPcc`** en `modifyBooking` (`:873`) — misma semántica de branch access que §2.3.1.

### 3.2 Las 6 familias

| # | Familia | Sub-variantes | Campos que cambian en `after.hotels[0]` | Sesión stateful | Re-shop |
| --- | --- | --- | --- | --- | --- |
| 1 | **modify common fields** | 1 | `checkInDate`, `checkOutDate`, `corporateDiscountCode`, `leadTravelerIndex`, `paymentPolicy`, `room.travelerIndices`, `specialInstructions`, `numberOfGuests` + `after.travelers[]` completo | No | No |
| 2 | **modify checkin/checkout dates** | 1 | `checkInDate` / `checkOutDate` | No | **Sí, si las fechas salen del rango original** |
| 3 | **modify number of guests** | 1 | `numberOfGuests`, `room.travelerIndices`, **+ `bookingKey` nuevo** | No | **Sí** |
| 4 | **modify lead guest** | 1 | `leadTravelerIndex: 1 → 2` | No | No |
| 5 | **modify hotel room productCode** | 1 | `room.productCode`, `bookingKey`, fechas; `before` poblado | No | **Sí** |
| 6 | **Modify Form of Payment** | **12** | `paymentPolicy`, `formOfPaymentIndex`, `after.payments.formsOfPayment[]` | **Sí en 8/12** | No |

**VERIFICADO-SPEC** — `HotelDetailsToModify` (`:2783`) confirma exactamente qué se puede modificar y qué es obligatorio: **`room`, `numberOfGuests`, `leadTravelerIndex` y `paymentPolicy` son `required`** en todo `after.hotels[]`. Y precisa cuándo hace falta un `bookingKey` nuevo:

> *«`bookingKey`: A **mandatory value to provide in case of changes to the room type, number of guests, and check-in or check-out dates outside of the original date range**.»* (`:2791-2796`)

Eso valida y afina la columna «Re-shop»: la familia 2 **también** necesita re-shop si las fechas nuevas caen fuera del rango original. La colección no lo ejemplifica porque mueve las fechas dentro del rango. **Corrección respecto de la primera pasada, que marcaba «No» sin matices.**

Campos modificables: `bookingKey`, `checkInDate`, `checkOutDate`, `corporateDiscountCode`, `leadTravelerIndex`, `room` (`RoomToModify`: `productCode` + `travelerIndices`), `specialInstructions`, `numberOfGuests`, **`associatedFlightDetails`**, `paymentPolicy`, `formOfPaymentIndex`.

### 3.3 Las 12 sub-variantes de forma de pago

**VERIFICADO** (`tree.txt` líneas 133–231):

| # | Sub-variante | Sesión | `before` | Notas |
| --- | --- | --- | --- | --- |
| 1 | modify FoP LATE to CC | No | `{}` | `paymentPolicy: LATE → DEPOSIT`, `formOfPaymentIndex: 1` |
| 2 | modify FoP change CC | No | `{}` | Cambia sólo la tarjeta |
| 3 | modify FoP — PAYMENTCARD, CHECK, CASH, MISCELLANEOUS, INSTALLMENTS | **Sí** | `{{getBookingResponseBody}}` | 5 formas de pago a la vez |
| 4 | modify FoP including 'before' section — CC | No | `{{request}}` | "modify one card to another" |
| 5 | modify — add FoP Company Name | **Sí** | `{{getBookingResponseBody}}` | `formOfPaymentIndex: 2` |
| 6 | modify FoP Agency IATA | **Sí** | — | |
| 7 | modify FoP Virtual Card | **Sí** | — | |
| 8 | modify FoP LATE to DEPOSIT (CC) | **Sí** | — | Incluye `GetBooking :printDiff` |
| 9 | modify FoP LATE to DEPOSIT (TRAVEL_AGENCY_NAME_ADDRESS) | **Sí** | — | Segundo `HotelPriceCheckRQ` antes del modify |
| 10 | modify FoP LATE to DEPOSIT (TRAVEL_AGENCY_IATA) | **Sí** | — | Idem |
| 11 | modify FoP change CC with populated before section | **Sí** | poblado | |
| 12 | Add credit card when another CC stored in the booking | **Sí** | — | Añadir sin reemplazar |

Ejemplo real, sub-variante 1 (**VERIFICADO**, recortado):

```json
{ "bookingSignature": "{{bookingSignature}}", "confirmationId": "{{pnr}}",
  "before": {},
  "after": {
    "creationDetails": { "agencyIataNumber": "12344321" },
    "hotels": [ { "itemId": "{{itemId}}",
                  "checkInDate": "{{start_date}}", "checkOutDate": "{{end_date}}",
                  "leadTravelerIndex": 1, "paymentPolicy": "DEPOSIT",
                  "formOfPaymentIndex": 1,
                  "room": { "travelerIndices": [1] }, "numberOfGuests": 1 } ],
    "payments": { "formsOfPayment": [ { "type": "PAYMENTCARD", "cardTypeCode": "VI",
                    "cardNumber": "{{creditCardNumber}}",
                    "cardSecurityCode": "{{cardSecurityCode}}",
                    "expiryDate": "{{creditCardExpiryDate}}", "cardHolder": { } } ] },
    "travelers": [ ] },
  "retrieveBooking": true, "receivedFrom": "Booking Management API testing" }
```

`formOfPaymentIndex` (1-based) enlaza el ítem hotel con la forma de pago concreta; es el mismo mecanismo que `formOfPayment` en `createBooking` con otro nombre (**confirmado en el contrato**: `:2843` vs `:5064`).

`creationDetails.agencyIataNumber` aparece en las 6 familias sin excepción. **[INFERIDO]** obligatorio en `modifyBooking` — el contrato declara `creationDetails` como opcional en `Booking`, así que la obligatoriedad podría ser sólo de la práctica de los ejemplos. **Verificar en CERT.**

### 3.4 Qué significa para nosotros — balance actualizado

**Positivo:** cubre los 5 motivos reales por los que un vendedor toca una reserva de hotel tras emitirla (fechas, huéspedes, titular, categoría de habitación, forma de pago). Hoy, con Despegar, la única salida es cancelar y re-reservar, con riesgo de perder la tarifa y de que el cliente pague la diferencia.

**Negativo — reevaluado a la baja en dos puntos y al alza en uno:**

1. **Sesiones stateful: menos grave de lo que parecía.** Las 4 familias que no las usan (fechas, huéspedes, titular, `productCode`) más las 4 variantes de FoP sin sesión cubren el grueso del caso de uso. Y `modifyBooking` en sí **es stateless por contrato** (§1.2). La sesión aparece por los LLS que la acompañan. **Un v1 sin sesiones es viable y útil.**
2. **El bloqueante «no conocemos `getBooking`» ha desaparecido** (§2.8.1). Se puede construir un `after` correcto.
3. ⚠️ **El punto PAN empeoró.** Ahora sabemos que el `before` poblado requiere PAN sin enmascarar, y que la alternativa oficial es el keyword **`CCVIEW`** en el EPR (§3.1.2). **Es el bloqueante que queda.**

---

## 4. Autos (vehículos)

**14 requests** en la colección (§0.2) — la vertical peor cubierta por la colección. **Pero el contrato es rico**, y eso cambia el diagnóstico aunque no la recomendación.

### 4.1 `POST /v2.0.0/get/vehavail`

**VERIFICADO** — `Workflows / 10 / Get Vehicle Avail`:

```json
{ "GetVehAvailRQ": { "SearchCriteria": {
  "PickUpDate": "{{start_date}}", "PickUpTime": "10:30",
  "ReturnDate": "{{end_date}}", "ReturnTime": "16:30",
  "SortBy": "Price", "SortOrder": "ASC",
  "RentalLocRef": { "PickUpLocation": { "LocationCode": "MIA" },
                    "ReturnLocation": { "LocationCode": "MCO" } },
  "ImageRef": { "Image": { "Type": "ORIGINAL" } },
  "LocPolicyRef": { "Include": true },
  "RatePrefs": { "ConvertedRateInfoOnly": false, "SupplierCurrencyOnly": true },
  "CarExtrasPrefs": { "CarExtrasPref": [ { "Type": "NAV" } ] },
  "VendorPrefs": { "VendorPref": [ { "Code": "ET" } ] } } } }
```

La variante SOAP usa `<AirportRef>` en lugar de `RentalLocRef` y añade `<VehPrefs><VehPref><VehType>ECAR</VehType>` (**VERIFICADO**).

**VERIFICADO-SPEC** `get-vehicle-availability-v2.yml:16` — el path del contrato coincide exactamente con el de la colección. **No hay laguna de versión en autos.**

| Campo | Colección | Contrato (v2) |
| --- | --- | --- |
| `PickUpTime` / `ReturnTime` | `"10:30"` | Patrón de reloj de 24 h con minutos — **`HH:MM`**, obligatorio. **VERIFICADO-SPEC** `:130`, `:748`. (AgentCars usa `"1000"` militar: hay conversión.) |
| **Modo de ubicación** | `RentalLocRef` / `AirportRef` | **Tres modos mutuamente excluyentes**: `RentalLocRef` (hasta 5 `PickUpLocation`, con `ExtendedLocationCode` de 2-4 chars además del IATA), `AirportRef` (*«This will NOT get car rental locations around the Geo Point of the airport»* — sólo oficinas con servicio de aeropuerto) y **`GeoRef`**. **VERIFICADO-SPEC** `:326`, `:361`, `:383` |
| **Búsqueda por lat/long** | ❌ sin ejemplos | ✅ **EXISTE.** `GeoRef` → `GeoLocRef` con `GeoCode{Latitude, Longitude}`, o `RefPoint` (`RefPointType` **6=Airport, 11=Hotel**), o `AddressRef`. Más `Direction` (N/S/E/W/NE/…). **VERIFICADO-SPEC** `:383`, `:425`, `:435`, `:475`, `:493` |
| `SortBy` | `Price` | enum `Preferred` \| `Distance` \| `Price` \| `Vendor` \| `CarType`, con defaults según el modo de ubicación. **VERIFICADO-SPEC** `:141` |
| `VendorPrefs.VendorPref[].Code` | `ET`, `ZE`, `ZI` | Código de arrendadora, 2 letras. |
| `VehPrefs.VehPref.VehType` | `ECAR` | **SIPP/ACRISS**, igual que AgentCars. Ejemplos oficiales: `ECAR`, `CCAR`, `ICAR`, `SCAR`, `FCAR`, `IFAR`. **VERIFICADO-SPEC** `help/get-vehicle-availability-v2/v2-index.txt` |
| `CarExtrasPrefs.CarExtrasPref[].Type` | `NAV` | Patrón de 3 alfanuméricos. **Catálogo parcialmente resuelto:** *«e.g. **NAV** - Navigation Equipment or **CDW** - Collision Damage Waiver Insurance»*. **VERIFICADO-SPEC** `:631` |
| `LocPolicyRef.Include` | `true` | **Resuelto:** trae `VehLocPolicyInfo` con horarios y dirección de la oficina. Ver §4.1.1. **VERIFICADO-SPEC** `:171`, `:869` |
| `RatePrefs` | `ConvertedRateInfoOnly`, `SupplierCurrencyOnly` | Además: **`Commission`** (booleano — *«If true, the suppliers return the commission information»*), `CurrencyCode`, `CustLoyalty[]`, **`GuaranteePrepaid.Type`** (enum `G`/`P`/`R` y sus 15 combinaciones: garantizadas, prepagadas, retail), `RateAssured`, `RateCategory`, **`RateRule[]{RateCode, VendorCode}`** (tarifas negociadas por arrendadora — **el equivalente BYOC en autos**), **`RatePlan`** (`D` diaria \| `W` semanal \| `E` fin de semana \| `M` mensual \| `B` bundled). **VERIFICADO-SPEC** `:177-272` |
| `ImageRef` | `{Type: ORIGINAL}` | enum `ORIGINAL` \| `THUMBNAIL` \| `SMALL` \| `MEDIUM` \| `LARGE`. **VERIFICADO-SPEC** `:687` |

> ⚠️ **CORRECCIÓN a la primera pasada.** El documento afirmaba: *«Búsqueda por lat/long para autos: no existe en la colección […] Esto es un **retroceso** frente a AgentCars»*. La primera mitad es cierta (la colección no la ejemplifica); **la segunda es falsa**: el contrato la soporta explícitamente. **No hay retroceso.**

#### 4.1.1 Forma de la respuesta — **ya no es DESCONOCIDA**

Evidencia de la colección (**VERIFICADO**, scripts):

```js
jsonData.GetVehAvailRS.VehAvailInfos.VehAvailInfo[2].VehRentalRate[0].RateKey
// SOAP: result.Envelope.Body[0].GetVehAvailRS[0].VehAvailInfos[0]
//        .VehAvailInfo[0].VehRentalRate[0].$.RateKey
// comentado en el original: … .ConvertedVehRentalRate[0].$.RateKey
```

El contrato confirma esa ruta exacta y especifica todo lo demás. **VERIFICADO-SPEC** `get-vehicle-availability-v2.yml:536`, `:742`:

```
GetVehAvailRS
├── ApplicationResults           (:1135)  incl. ProblemInformation / ErrorType
├── VehLocPolicyInfos            (:52)    ← si LocPolicyRef.Include
└── VehAvailInfos                (:742)   PickUpDate/Time, ReturnDate/Time,
    │                                     RentalDays, RentalHours
    └── VehAvailInfo[]           (:764)
        ├── VehRentalRate[]          (:783)
        ├── ConvertedVehRentalRate[] (misma forma, otra moneda)
        ├── PickUpLocation           (:947)  Lat/Long, Distance, Direction, UOM
        ├── ReturnLocation           (:717)
        └── Vendor                   (:1125) Code, Name, Logo
```

**`VehRentalRate`** (`:783`): `AvailabilityStatus`, `Category`, `GuaranteeInd`, `Ordinal`, `PrepayDeposit`, `RateAssured`, **`RateCode`**, **`RateKey`**, `RatePlanChangeIndicator`, `RatePlanRequested`, `RatePlanReturned`, `SellGuaranteeReq`, `SupplierCurrency`, **`CarExtraCharges`**, **`Commission`**, **`GuaranteePrepaid`**, **`Vehicle`**, **`VehicleCharges`**.

**`Vehicle`** (`:1060`): **`VehMakeAndModel`**, **`VehNumOfDoors`**, **`VehType`** (SIPP), **`Images`** (`Image[]{Url, Type, Width, Height}`), `SeatBeltsAndBagsInfo{ BagsInfo.Bags[]{Quantity, Size: Small|Large}, SeatBelts.Quantity }`.

> `SeatBelts.Quantity` es *«number of SeatBelts (**The Legal Passenger capacity**)»* — la capacidad legal de pasajeros, exactamente el dato que AgentCars expone como `passengers`.

**`VehicleCharges.VehicleCharge[]`** (`:1093`): `Amount`, `CurrencyCode`, **`ChargeType`** con enum cerrado — `DropOffCharge`, `ExtraDay`, `ExtraHour`, `BaseRateTotal`, `SubtotalExcludingMandatoryCharges`, `DailyChargesTotal`, `HourlyChargesTotal`, `MandatoryCharges`, `MandatoryChargesTotal`, **`ApproximateTotalPrice`**, `CarExtraTotalCharge` — más **`MileageAllowance`** + `ExtraMileageCharge` + `UOM`.

> 🟢 Esto da desglose de precio y **kilometraje incluido** de forma estructurada. `ApproximateTotalPrice` es el total a mostrar.

**`GuaranteePrepaid`** (`:272`): `Amount`, `AmountPercentage`, `CurrencyCode`, `Ind`, y **`CancellationRefundAmount[]{Amount, DaysPrior}`** (hasta 4 tramos). **Política de cancelación escalonada, estructurada.**

**`Commission`** (`:1050`) — presente también en autos, condicionada a `RatePrefs.Commission: true`.

**`VehLocPolicyInfo`** (`:869`): `CounterLocation`, `LocationCode` / `ExtendedLocationCode`, `LocationName`, `LocationOwner`, `LocationType`, `PolicyRef`, **`LocationInfo{Latitude, Longitude, Address}`**, **`OperationSchedule.OperationTimes.OperationTime[]`** (hasta 7: `Start`, `End`, `DayOfTheWeek`), `VendorDetails{Code, Name}`, `DeliveryCollectionInfo` (enum `Delivery` \| `Collection` \| `Delivery and Collection` \| `Not Available`, marcado **«FUTURE USE ONLY»**).

> ⚠️ **CORRECCIÓN a la comparativa.** La primera pasada marcó «Listado de oficinas + horarios: ❌» para Sabre. **Es falso**: `LocPolicyRef.Include: true` devuelve dirección, coordenadas y **horario por día de la semana** de cada oficina. Lo que **no** existe es un endpoint independiente tipo `findOffices` de AgentCars: viene embebido en el avail.

### 4.2 `POST /v1.0.0/veh/pricecheck`

**VERIFICADO** — el body más corto de la colección entera:

```json
{ "VehPriceCheckRQ": { "VehRateInfoRef": { "RateKey": "{{car_rate_key}}" } } }
```

Respuesta (**VERIFICADO** por script): `jsonData.VehPriceCheckRS.PriceCheckInfo.BookingKey`. SOAP: `VehPriceCheckRS[0].PriceCheckInfo[0].$.BookingKey`.

Simetría perfecta con hotel: `…PriceCheckRS.PriceCheckInfo.BookingKey` en ambas verticales. **Un solo mapper de pricecheck sirve para las dos.**

> **DESCONOCIDO:** no tenemos spec de Vehicle Price Check (no está entre los 15 descargados). Es la única laguna de contrato de la vertical auto.

⚠️ **Diferencia respecto a hotel:** el pricecheck de auto **no devuelve `GuaranteeType`** (ningún script lo lee). `createBooking` sí exige `car.paymentPolicy`, y todos los ejemplos lo hardcodean a `"DEPOSIT"`. ✅ **Parcialmente resuelto:** `CarPaymentPolicyEnum` tiene exactamente **dos** valores, `DEPOSIT` y `GUARANTEE` (**VERIFICADO-SPEC** `booking-management-v1.yml:9298`) — pregunta 12 cerrada. Cómo se determina cuál aplica sigue **DESCONOCIDO**; lo más probable es derivarlo de `VehRentalRate.GuaranteeInd` / `SellGuaranteeReq` / `PrepayDeposit` del avail. **[INFERIDO]**

### 4.3 `createBooking` con `car`

**VERIFICADO** — `Workflows / 10 / createBooking` y `Create Booking / Vehicle / createBooking - simple vehicle`:

```json
"car": { "bookingKey": "{{carBookingKey}}", "travelerIndex": 1,
         "paymentPolicy": "DEPOSIT", "formOfPayment": 1,
         "quantity": 1, "specialInstructions": "Wants a blue car." }
```

**Contrastado con `CarToBook`** (**VERIFICADO-SPEC** `booking-management-v1.yml:7175-7245`):

| Campo | Nota |
| --- | --- |
| `bookingKey` | *«returned in the **Vehicle Price Check** API response and is a mandatory value»* (help oficial). |
| `travelerIndex` | **Singular** 1-based (el hotel usa `travelerIndices`, array). Confirmado. |
| **`emailIndex`** | 🆕 **Ausente de todos los ejemplos.** Índice del email del viajero que se comparte con la arrendadora; si el viajero no tiene, apunta a `contactInfo.emails`. |
| `paymentPolicy` | enum `DEPOSIT` \| `GUARANTEE`. |
| `formOfPayment` | 1..11. **Sólo `PAYMENTCARD` y `VOUCHER` aplican a autos.** |
| `quantity` | default `1`. |
| `specialInstructions` | **Plural** confirmado. |
| `flightIndex` | ✅ **Resuelto:** *«Index of the flight **in the reservation**. Corresponding flight details (**airline code and flight number**) are provided to the car vendor»* (`:7238`). Es 1-based sobre los vuelos **de la reserva**, no del payload. |
| **`associatedFlightDetails`** | 🆕 `AssociatedArrivalFlight` — alternativa a `flightIndex` cuando el vuelo **no** está en el PNR. **Permite el gesto de Package Studio sin PNR único.** Ver §6.5. |
| `collectionAddress` / `deliveryAddress` | `Address` |
| `collectionSite` / `deliverySite` | `CarRentalSite{id, name, phone}` |

#### Las 4 variantes de recogida/entrega

**VERIFICADO** — `createBooking - vehicle with {Collection Address | Delivery Address | Delivery Site | Collection Site}`.

Semántica: el contrato no la explica en prosa, pero los comentarios `#source` del spec la revelan — ambos mapean a `…/Vehicle/VehicleVendorAvail/VehicleResCore/CollectionDeliveryInfo/{DeliveryInfo|CollectionInfo}/@siteID|@siteName` (**VERIFICADO-SPEC** `:7246-7262`). Es el par OTA estándar *delivery* (la arrendadora lleva el auto) / *collection* (lo recoge). La inferencia de la primera pasada queda **confirmada por estructura**, no por prosa.

⚠️ **`Site.id` — origen resuelto a medias.** El `#source` dice que en `getBooking` el `id` viene de `CollectionDeliveryInfo/…/@siteID`, o sea que **es un dato que devuelve el proveedor**, no un catálogo que consultemos. En el avail, `VehLocPolicyInfo.DeliveryCollectionInfo` existe pero está marcado **«FUTURE USE ONLY»**. **Conclusión: hoy no hay forma documentada de descubrir los `siteID` válidos antes de reservar.** Sigue siendo un hueco operativo real.

⚠️ **Anomalía verificada en «Collection Site»:** el objeto `payment` está **anidado dentro de `car`**. El contrato lo zanja: **`CarToBook` no tiene ninguna propiedad `payment`** (`:7175-7245`); `payment` es propiedad de nivel raíz de `CreateBookingRequest` (`:758`). ✅ **Es un error del ejemplo de Postman. No copiarlo.** Pregunta 20 cerrada.

Entrega/recogida a domicilio **no existe en AgentCars** — es capacidad nueva, pero con el `siteID` no descubrible.

### 4.4 Cancelación

Idéntica a hotel. `cars[]` con `itemId` (string, §2.7) en `cancelBooking` (**VERIFICADO** en `Cancel by Item Id - Flights, Hotels, Cars`).

Respuesta de `getBooking` para autos: `cars[]` = `CarReference{itemId}` + **`CarItem`** (`:3264`), con obligatorios `vendorName`, `pickUpAddress`, `pickUpDate`. **VERIFICADO-SPEC**.

### 4.5 Modificación de autos

**No existe.** `ModifyBooking (various workflows)` tiene «Hotel modification flows» y «Flight modification flows», ninguna familia de vehículo. El contrato lo confirma: no hay ninguna definición `CarToModify` en `booking-management-v1.yml` (grep: 0 apariciones), frente a `HotelToModify` (`:2776`). **VERIFICADO-SPEC. Pregunta 35 cerrada: Sabre no soporta modificación de autos.**

---

## 5. Comparativa honesta con lo que ya tenemos

### 5.1 Hoteles: Sabre vs `providers/despegar-hotels/`

| Dimensión | Despegar (en producción) | Sabre (a integrar) |
| --- | --- | --- |
| Transporte | REST JSON puro | REST JSON suficiente; SOAP opcional |
| Autenticación | funcionando | OAuth `client_credentials`, mismo patrón que LATAM NDC |
| Contenido | 1 bedbank agregador, fuerte en LATAM | **≥6 fuentes en una sola llamada**: GDS, Expedia Affiliate, HotelBeds, Booking.com, CMNet, legacy |
| Tarifas negociadas de la agencia | ❌ | ✅ PCC propio + `RatePlanCandidates` / `ClientId` |
| Tarifas corporativas | ❌ | ✅ `CorpDiscount` / `corporateDiscountCode` |
| Tarifas por país del viajero | ❌ | ✅ `TravellerCountry` |
| Búsqueda por lat/long | ✅ | ✅ |
| Búsqueda por dirección | ✅ | ✅ `AddressRef` |
| Búsqueda por código de hotel | ✅ | ✅ `HotelRefs` |
| **Multi-habitación** | ✅ `RoomDistribution[]` con **ocupaciones distintas** | ⚠️ soportado, pero **todas las habitaciones deben tener la misma configuración de pax** (error `5029`), y **no soportado en absoluto para hoteles GDS** |
| Board type | ✅ mapeado a canónico | ✅ **derivable** de `MealsIncluded` + `MealPlanCode` (OTA MPT) |
| Política de cancelación estructurada | ✅ `HotelCancellation` | ✅ `CancelPenalties` con `Deadline` / `AmountPercent` / `Refundable` |
| **Comisión de agencia expuesta** | ✅ `HotelPrice.agencyCommission` | ✅ **`Commission{Percent, Amount, Type}`** |
| Imágenes / contenido | ✅ | ✅ `HotelImageInfo` + amenities + property type + security features |
| Verificación de precio | ✅ `prebook` | ✅ `pricecheck` con `PriceChange` / `PriceDifference` |
| **Persistencia del token de tarifa** | `choiceId` efímero | ✅ **`RateKey` no expira** — la cotización sobrevive |
| Pago | hosted / modalidades | ⚠️ **PAN + CVV en el body** (salvo `LATE` / IATA / corporate) |
| SCA / 3DS | vía PSP | pass-through `authentications[]` (PSD2, desde v1.9) |
| **Modificación post-venta** | ❌ **no existe** | ✅ 6 familias, 12 variantes de FoP |
| Cancelación | ✅ | ✅ + selectiva por `itemId` + `ALLOW_PARTIAL_CANCEL` |
| **Deduplicación (GIATA)** | ✅ | ❌ **sólo `HotelCode` global de Sabre** |
| **PNR compartido con vuelo** | ❌ | ✅ (§6) |
| Certificación previa | pasada | Sabre exige certificación formal |

### 5.2 Autos: Sabre vs `providers/agent-cars/`

Corregida contra el contrato — **casi todas las «❌ desconocido» de la primera pasada eran falsas**:

| Dimensión | AgentCars (integrado) | Sabre |
| --- | --- | --- |
| Cobertura de la colección | 12 endpoints en `docs/cars/agentcars-api-reference.md` | **14 requests, 2 endpoints REST** |
| Cobertura del contrato | — | **completa** (`get-vehicle-availability-v2.yml`) |
| Autocomplete de ubicaciones | ✅ `/suggest` | ❌ **no existe** |
| Oficinas + horarios | ✅ `findOffices` con `schedule` | ✅ **embebido**: `VehLocPolicyInfo.OperationSchedule` (hasta 7 días) + lat/long + dirección |
| Tipos de tarifa | ✅ `/rates` | ✅ **en el request**: `RatePlan` D/W/E/M/B + `RateCategory` + `RateRule` |
| Búsqueda por lat/long | ✅ | ✅ `GeoRef.GeoLocRef.GeoCode` |
| Datos del vehículo | ✅ `CarOffer` | ✅ `VehMakeAndModel`, `VehNumOfDoors`, `VehType` (SIPP), bolsas (cantidad + tamaño), **capacidad legal de pasajeros** |
| Imágenes de auto y logo de arrendadora | ✅ | ✅ `Vehicle.Images[]` (5 tamaños) + `Vendor.Logo` |
| PPD / POD | ✅ `paymentType` | ✅ `GuaranteePrepaid.Type` (G/P/R y combinaciones) |
| Desglose de precio | ✅ | ✅ `VehicleCharge[]` con 11 `ChargeType` + `MileageAllowance` |
| Política de cancelación | ✅ | ✅ `CancellationRefundAmount[]{Amount, DaysPrior}` |
| Comisión | ✅ | ✅ `Commission` (pedir con `RatePrefs.Commission`) |
| **Reserva ON HOLD + `release`** | ✅ | ❌ |
| **Reporte diario consolidado** | ✅ `getDailyReport` | ❌ |
| Entrega/recogida a domicilio | ❌ | ✅ 4 variantes (pero `siteID` no descubrible) |
| **Modificación** | ❌ | ❌ **confirmado por contrato** |
| **PNR compartido con vuelo** | ❌ | ✅ |

### 5.3 Qué aporta Sabre — el resumen sin adornos

**Aporta cuatro cosas de verdad:**

1. **Contenido multi-fuente + tarifas negociadas propias de cada agencia.** Con BYOC por PCC vía `POS.Source.PseudoCityCode` / `targetPcc` y branch access, cada agencia de la red ve **sus** contratos. **No se puede replicar con Despegar.** Es el argumento estratégico fuerte del modelo consolidador.
2. **Modificación post-venta de hoteles.** Hoy no la tenemos con ningún proveedor.
3. **Multi-producto en un solo PNR**, con **tres mecanismos** y política de error configurable (§6).
4. **`RateKey` que no expira** — una cotización del Package Studio puede revalidarse días después sin re-shop.

**Cuesta:**

- **Un ACL nuevo.** REST puro basta para shop / pricecheck / book / modify / cancel; SOAP + `fast-xml-parser` **sólo** si se quiere el PNR híbrido (§6.3).
- **Conflicto PCI.** §2.5 y §3.1.2. Sigue siendo el bloqueante nº 1, y en modificación es peor (`CCVIEW`).
- **Deduplicación cross-provider.** Sin GIATA, ≥3 fuentes de hotel producen duplicados en resultados. **Riesgo R4 intacto.**
- **Multi-habitación degradado.** Ocupaciones mixtas no soportadas; multi-room imposible en GDS.
- **Certificación formal de Sabre.** No documentada. Es un proceso, no un sprint.
- **Duplicación funcional.** Hoteles y autos ya están en producción.

**Lo que ya NO cuesta** (y la primera pasada creía que sí): la forma de las respuestas de `hotelavail`, `pricecheck`, `createBooking`, `getBooking` y `vehavail` está **especificada campo por campo**. El `response.mapper.ts` es escribible hoy. **El spike deja de ser un requisito para estimar y pasa a ser una validación.**

### 5.4 Recomendación

**Autos de Sabre: NO entran en fase 1. Recomiendo descartarlos también de fase 2.**

Argumento **corregido**: no es que el contrato de autos sea pobre — resultó ser completo, y en desglose de precio y política de cancelación es incluso mejor que lo que hoy mapeamos. Es que **AgentCars ya está integrado y cubre lo mismo, más ON HOLD/`release`, `suggest` y reporte diario**, que Sabre no tiene. Lo que Sabre añade es entrega/recogida a domicilio (nicho, con `siteID` no descubrible) y el PNR compartido. **Construir una ACL entera + certificación por eso es una mala inversión de sprint.** Si algún día se necesita el auto dentro del PNR de vuelo, se reevalúa como parte de la decisión de §6.

**Hoteles de Sabre: NO entran en fase 1. Candidato fuerte de fase 2, con un gate más corto que antes.**

A favor de dejarlo fuera de fase 1:

- El principio nº 1 de `CLAUDE.md` es **tiempo a venta < 2 minutos**. Añadir un tercer proveedor de hotel no acelera ninguna venta que hoy no se cierre con Despegar, y **empeora** el caso familiar (ocupación mixta).
- El conflicto PCI contradice una regla explícita del proyecto. Resolverlo es un proyecto en sí.
- La duplicación en resultados sin GIATA daña directamente el «tiempo a venta».

A favor de fase 2:

- El contenido GDS + negociado por PCC es **el diferenciador del modelo consolidador** (`docs/platform/12-modelo-consolidador-y-plan.md`), y ahora **sabemos exactamente cómo se implementa** (§2.3.1): una credencial + N PCCs con branch access, 5 minutos de propagación. Barato de operar.
- La comisión viene en la respuesta → el pricing waterfall tiene base numérica.
- La modificación post-venta cierra un hueco real.
- El `RateKey` persistente encaja con el Package Studio.

**Gate de entrada a fase 2 — actualizado (de 3 condiciones a 2 y media):**

1. ~~Respuestas reales capturadas de CERT~~ → **cumplida documentalmente** por los contratos. Queda una **validación** (no un descubrimiento): confirmar el diff v4→v5 de `get/hotelavail` y capturar un `HotelPriceCheckRS` real.
2. **Decisión tomada sobre el pago** (§2.5 y «Decisiones»). Sigue abierta y es la que manda.
3. **Coste y calendario de la certificación de Sabre.** Sigue abierta.

**Lo que conviene hacer ya, y es barato:** un **spike de 1 día contra CERT** para (a) pedir el spec de Get Hotel Avail v5 al account manager, (b) capturar un `GetHotelAvailRS` y un `HotelPriceCheckRS` reales y guardarlos como fixtures en `docs/sabre/fixtures/`, y (c) **medir qué porcentaje del inventario es reservable sin PAN** filtrando por `GuaranteesAccepted.GuaranteeTypeCode`. Ese último número es el que decide si Sabre entra o no.

---

## 6. Multi-producto en un solo PNR — la oportunidad para el Package Studio

> **Sección reescrita.** La primera pasada concluyó que *«el PNR único no es un extra de la vertical hotel: arrastra la vertical vuelo entera»* y que exigía migrar el aire a Sabre GDS. **Esa conclusión era incorrecta y era la decisión de producto más cara del expediente.** Hay **tres** mecanismos, no uno, y al menos uno de ellos es compatible con contenido NDC.

### 6.1 Mecanismo A — `createBooking` único con `flightDetails` (sell GDS clásico)

**VERIFICADO** — `Create Booking / CSL Hotel / createBooking - Air with CSL hotel`. Un único `POST /v1/trip/orders/createBooking` que crea vuelo + hotel:

```json
{
  "agency": { "…": "…" },
  "hotel": { "useCSL": true, "bookingKey": "{{bookingKey}}",
             "paymentPolicy": "DEPOSIT", "formOfPayment": 3 },
  "travelers": [ { "givenName": "John", "surname": "Kowalski", "birthDate": "1970-01-23",
                   "passengerCode": "ADT" } ],
  "flightDetails": {
    "flights": [
      { "flightNumber": "{{flight_number}}", "airlineCode": "EY",
        "fromAirportCode": "MEL", "toAirportCode": "AUH",
        "departureDate": "{{start_date}}", "departureTime": "16:15",
        "bookingClass": "Y", "isMarriageGroup": false, "flightStatusCode": "NN" } ],
    "flightPricing": [ { "qualifiers": { "payment": {
        "primaryFormOfPayment": 1, "secondaryFormOfPayment": 3,
        "amountOnSecondFormOfPayment": "100.00" } } } ] },
  "payment": { "billingAddress": { }, "formsOfPayment": [ ] }
}
```

`flightDetails.flights[]` con `airlineCode` + `bookingClass` + `flightStatusCode: "NN"` es un **sell de segmento GDS clásico (ATPCO/LCC)**, no NDC. **VERIFICADO-SPEC** (help oficial de `createBooking`): *«the method can also create a **Sabre PNR** that includes **traditional air (ATPCO) or low-cost carrier (LCC)** content, book hotel content, **book a combination of flight and hotel content**, or book car content»*.

El `car` sigue la misma lógica: `createBooking - vehicle with Delivery Site` incluye `car.flightIndex: 1` (**VERIFICADO**), que apunta a un vuelo **de la reserva**. Y `cancelBooking` cierra el círculo: `Cancel by Item Id - Flights, Hotels, Cars` cancela ítems de las tres verticales del mismo `confirmationId` en una llamada (**VERIFICADO**).

### 6.2 Mecanismo B — `createBooking` único con `flightOffer` NDC + `hotel` + `car`

**VERIFICADO-SPEC** `booking-management-v1.yml:694-750`: `CreateBookingRequest` declara **`flightOffer` (NDC), `flightDetails` (tradicional), `hotel` y `car` como propiedades hermanas opcionales**, sin `oneOf` ni exclusión declarada entre `flightOffer` y `hotel`/`car`.

⚠️ **Pero el texto oficial sugiere una restricción que el schema no expresa.** La frase citada arriba asocia la combinación vuelo + hotel al PNR **tradicional**, y describe NDC como creación de un **Sabre Order**, no de un PNR. Y la colección **nunca** ejemplifica `flightOffer` + `hotel` en el mismo `createBooking`: cuando quiere las dos cosas con NDC, usa el mecanismo C.

> **Estado: [INFERIDO — con evidencia en contra].** El schema lo permite; la práctica de la colección y la prosa oficial sugieren que no funciona. **Es la primera pregunta a resolver en el spike**, porque si funcionara sería el camino más barato con diferencia: PNR único, sin SOAP, sin sesiones.

### 6.3 Mecanismo C — agregar el segmento de hotel por `UpdatePassengerNameRecordRQ` (SOAP)

**Éste es el mecanismo que la primera pasada no vio, y el que corrige la conclusión.**

La familia `ModifyBooking (various workflows) / Flight modification flows / Form of Payment modifications (Hybrid)` tiene **31 requests** en 3 subcarpetas (`Add FOP` 11, `Update FOP` 10, `Delete FOP` 10). `UpdatePassengerNameRecordRQ` aparece **3 veces en la colección y 0 veces en la primera pasada de los 12 documentos**.

**Secuencia completa, VERIFICADO** (`Add FOP`; idéntica en las otras dos salvo el `modifyBooking` final):

```
 1. REST Authorize                 POST /v2/auth/token
 2. SessionCreateRQ                SOAP  (stateful ATH, Organization={{pcc}}, Domain=DEFAULT)
 3. Offer shop                     POST /v4/offers/shop
                                         TPA_Extensions.DataSources = { NDC: "Enable",
                                                                        ATPCO: "Disable",
                                                                        LCC: "Disable" }
 4. Offers Price                   POST /v1/offers/price
 5. CreateBooking NDC              POST /v1/trip/orders/createBooking
                                         body = { flightOffer: { offerId, selectedOfferItems } }
                                         SIN flightDetails
 6. GetHotelAvailRQ - find hotel    SOAP  GetHotelAvailRQ v4.0.0 → rate_key
 7. HotelPriceCheckRQ - price hotel SOAP  HotelPriceCheckRQ v3.0.0 → bookingKey
 8. UpdatePassengerNameRecordRQ 1.1.0 - add CSL hotel segment   SOAP  ← EL MECANISMO
 9. GetBooking                     POST /v1/trip/orders/getBooking → bookingSignature
10. ModifyBooking                  POST /v1/trip/orders/modifyBooking
11. SessionCloseRQ 1.0.0           SOAP
```

Body del paso 8 (**VERIFICADO**, recortado):

```xml
<UpdatePassengerNameRecordRQ
    xmlns="http://services.sabre.com/sp/updatereservation/v1_1" version="1.1.0"
    haltOnAirPriceError="false" haltOnHotelBookError="true">
  <Itinerary id="{{pnr}}"/>
  <HotelBook bookGDSviaCSL="true">
    <BookingInfo><BookingKey>{{bookingKey}}</BookingKey></BookingInfo>
    <Rooms>
      <Room RoomIndex="1">
        <Guests>
          <Guest FirstName="JOHN" LastName="SMITH" Email="test.user@sabre.com"
                 Type="10" Index="1" LeadGuest="true">
            <Contact Phone="2025550137"/>
          </Guest>
        </Guests>
      </Room>
    </Rooms>
    <PaymentInformation Type="DEPOSIT">
      <FormOfPayment><PaymentCard>
        <PaymentType>CC</PaymentType><CardCode>VI</CardCode>
        <CardNumber>{{creditCardNumber}}</CardNumber>
        <ExpiryMonth>10</ExpiryMonth><ExpiryYear>2034</ExpiryYear>
        <FullCardHolderName>…</FullCardHolderName>
        <CSC>{{cardSecurityCode}}</CSC>
        <Address>…</Address><Phone><PhoneNumber>8174425919</PhoneNumber></Phone>
      </PaymentCard></FormOfPayment>
    </PaymentInformation>
  </HotelBook>
  <PostProcessing>
    <EndTransaction><Source ReceivedFrom="SP TEST"/></EndTransaction>
    <RedisplayReservation waitInterval='100'/>
  </PostProcessing>
</UpdatePassengerNameRecordRQ>
```

**Lo que esto demuestra, punto por punto:**

1. El PNR nació de una **oferta NDC** (`flightOffer.offerId`), **sin `flightDetails` en ninguna parte**.
2. El hotel CSL se **agrega al PNR existente** por SOAP, referenciado por `<Itinerary id="{{pnr}}"/>`.
3. `bookGDSviaCSL="true"` es el equivalente SOAP de `hotel.useCsl`.
4. **`haltOnAirPriceError` / `haltOnHotelBookError` son la política de éxito parcial de este carril** — el análogo de `CreateErrorPolicyEnum` de `createBooking` (§2.4). En el ejemplo: no detenerse por error de precio de aire, **sí** detenerse por error de reserva de hotel. **Añadir a la tabla de éxito parcial de `04-*` §5.2, que hoy sólo documenta los `haltOn…` de `createBooking`.**
5. `PostProcessing.EndTransaction` es lo que confirma el PNR (equivalente al `EnhancedEndTransactionRQ` de los LLS, presente 4 veces en la colección).
6. `Guest.Type="10"` es un código OTA de tipo de huésped; `LeadGuest="true"` marca el titular.
7. El PAN y el CSC viajan **en el XML**. Mismo problema PCI de §2.5, en otro transporte.

**Corrección de la conclusión de la primera pasada.** El PNR único **NO exige `flightDetails`** y **NO exige migrar la vertical aire a Sabre GDS/ATPCO**. Lo que exige es:

- que el vuelo esté en un **PNR/Order de Sabre**, lo cual **sí sigue excluyendo LATAM-NDC-directo** (`providers/latam-ndc/`), porque ese PNR vive en LATAM y no en Sabre;
- **pero** el aire puede ser **NDC comprado a través de Sabre** (`/v4/offers/shop` con `DataSources: {NDC: "Enable", ATPCO: "Disable", LCC: "Disable"}`), que es un producto distinto y mucho más barato de adoptar que migrar a sell GDS.

**El coste real, entonces, es otro y es menor:** no es «migrar la vertical vuelo a GDS», es **«enrutar el aire por el shop de Sabre para los itinerarios donde queramos PNR único»**. LATAM es carrier NDC y es alcanzable por esa vía. La decisión pasa de ser una **migración de plataforma** a ser **una decisión de enrutamiento por itinerario**, reversible y pilotable con un feature flag de Unleash.

### 6.4 Los costes que sí siguen siendo reales

1. **Carril SOAP stateful obligatorio para el mecanismo C.** `SessionCreateRQ` → … → `SessionCloseRQ`, con afinidad de sesión y cierre garantizado ante fallo (o se filtran sesiones del lado de Sabre). Es trabajo de Temporal con compensación, no de un adapter simple. **Nota:** el mecanismo B, si funciona, lo evita por completo.
2. **Doble token.** El flujo mezcla token REST (paso 1) y sesión SOAP (paso 2) en la misma transacción.
3. **Un solo `payment.formsOfPayment[]` compartido** entre verticales, referenciado por índice (`hotel.formOfPayment: 3`, `flightPricing.qualifiers.payment.primaryFormOfPayment: 1`). Nuestro pricing waterfall por vertical (`apps/api/src/pricing/`) tendría que **consolidarse en un cobro único** — eso cambia el modelo de comisiones, no sólo el código. **Este punto sigue vigente sin cambios.**
4. **`bookingSignature` es por PNR, no por ítem.** Dos vendedores modificando el hotel y el vuelo del mismo paquete a la vez chocan. **Riesgo R11 sin cambios.**
5. **PAN en el XML** (§6.3, punto 7).

### 6.5 Y una cuarta vía, sin PNR único: `associatedFlightDetails`

**VERIFICADO-SPEC** `booking-management-v1.yml:3183` (`AssociatedFlightDetails`), `:5074` (hotel) y `:7213` (car).

Tanto `hotel` como `car` aceptan `associatedFlightDetails` con `arrivalAirlineCode`, `arrivalFlightNumber`, `arrivalTime`, `departureAirlineCode`, `departureFlightNumber`, `departureTime`. Es información que se **transmite al proveedor del hotel o a la arrendadora** para que sepan cuándo llega el cliente.

> 🟢 **Esto entrega el grueso del valor de producto del PNR único a una fracción del coste.** El gesto de Package Studio «arrastra el auto debajo del vuelo de llegada» se puede implementar **con el vuelo en LATAM NDC directo y el hotel en Sabre**: el hotel sabe la hora de llegada, la arrendadora sabe el vuelo, el cliente ve un solo itinerario en nuestra UI. Lo que **no** se obtiene es el localizador único ni la cancelación atómica.
>
> **Recomendación: implementar `associatedFlightDetails` primero.** Tratar el PNR único como una decisión de plataforma posterior, informada por el spike del mecanismo B.

### 6.6 Por qué importa

El commit `c39ac93 feat(packages): cotizacion multi-producto, base del Package Studio` y `apps/api/src/packages/packages.schemas.ts` ya definen `PACKAGE_VERTICALS = ['flights','hotels','cars','assistance']`. **Hoy un paquete es una agregación de N reservas independientes**, cada una con su proveedor, su localizador y su ciclo de vida. Si el vuelo se cae, el hotel queda huérfano y hay que compensarlo manualmente vía saga.

Con Sabre, vuelo + hotel + auto pueden ser **un solo PNR**: un localizador, una cancelación, un voucher, un ciclo de vida.

- **Un solo código para el cliente** en WhatsApp en vez de tres.
- **Atomicidad real y configurable**: `HALT_ON_ERROR` por defecto, con opt-in por vertical (`DO_NOT_HALT_ON_HOTEL_BOOKING_ERROR`, `DO_NOT_HALT_ON_CAR_BOOKING_ERROR`) — **VERIFICADO-SPEC** `:8918`. Elimina una clase de sagas de compensación.
- **Cancelación cruzada** con `ALLOW_PARTIAL_CANCEL` sustituyendo lógica escrita a mano.
- **Cross-sell natural**: `car.flightIndex` / `associatedFlightDetails`.

---

## 7. Mapeo al modelo canónico y gaps

### 7.1 `packages/canonical/src/hotel.ts` ← Sabre

| Campo canónico | Origen en Sabre | Estado |
| --- | --- | --- |
| `Hotel.code` | `HotelInfo.HotelCode` (Global ID) + `HotelInfo.SabreHotelCode` | ✅ **VERIFICADO-SPEC** `:1053`, `:1075` |
| `Hotel.giataId` | — | ❌ **no existe.** Sin GIATA no hay deduplicación cross-provider. Con ≥3 fuentes de hotel el mismo hotel aparece N veces. **Bloqueante de UX. Riesgo R4.** |
| `Hotel.name` | `HotelInfo.HotelName` | ✅ **VERIFICADO-SPEC** `:1085` |
| `Hotel.category` | `HotelInfo.PropertyTypeInfo.PropertyType` | ✅ existe; tabla OTA de tipos de propiedad → mapeo pendiente |
| `Hotel.starRating` | `HotelInfo.SabreRating` (string, ej. `"3.5"`) | ⚠️ **Es un rating propietario de Sabre, no estrellas oficiales.** Llevarlo a campo propio. **Riesgo R12 vigente.** |
| `Hotel.chainCode` | `HotelInfo.ChainCode` / `ChainName` / `BrandCode` / `BrandName` | ✅ **VERIFICADO-SPEC** `:1091`-`:1109` |
| `Hotel.address` | `HotelInfo.LocationInfo.Address` + `CityName` / `StateProv` / `CountryName` / `Neighborhoods` | ✅ **VERIFICADO-SPEC** `:1180`-`:1303` |
| `Hotel.location` (lat/lng) | `HotelAvailInfos.SearchLatitude/Longitude` es el **punto de búsqueda**, no el hotel | ⚠️ **el lat/long por propiedad no aparece en `HotelInfo` de v4.** Sí hay `Distance` + `Direction` + `UOM` respecto al punto de búsqueda. **DESCONOCIDO** si v5 lo añade. |
| `Hotel.amenities` | `HotelInfo.Amenities.Amenity[]` (+ `SecurityFeatures`) | ✅ **VERIFICADO-SPEC** `:1320` |
| `Hotel.images` | `HotelImageInfo.ImageItem[].Image[]` con `Category` y `Description` | ✅ **VERIFICADO-SPEC** `:2572` |
| `Hotel.logo` | `HotelInfo.Logo` (URI) | ✅ campo nuevo, no existe en el canónico |
| `Room.code` | `Room.roomTypeCode` (getBooking) / `RatePlan.ProductCode` | ✅ **VERIFICADO-SPEC** `:3095`, `:1885` |
| `Room.roomType` / `description` | `RoomDescription.Name` / `.Text[]`; en getBooking `room.roomType` + `room.description` | ✅ **VERIFICADO-SPEC** `:1680`, `:3072` |
| `Room.capacity` | `Occupancy{Min, Max}` | ✅ **VERIFICADO-SPEC** `:1773` |
| `Room.beds` | `BedTypeOptions.BedTypes.BedType[]{Code (OTA BED), Description, Count}` | ✅ **Catálogo identificado: tabla OTA `BED`.** El mapeo a `BedTypeSchema` (`single`\|`double`\|`queen`\|`king`\|`sofa`\|`bunk`) es una tabla estática, ya no un bloqueante. |
| `Room.sizeSqm` | — | ❌ no existe |
| `Room.smoking` | `rooms[].isSmoking` (request); en respuesta vía `RoomAmenities` | ⚠️ parcial |
| `RatePlan.code` | `RatePlan.RatePlanCode` / `RatePlanType` (OTA RPT) / `ClientId` | ✅ **VERIFICADO-SPEC** `:1805`, `:1811`, `:1881` |
| `RatePlan.boardType` | **derivar** de `MealsIncluded{BreakFast, Lunch, Dinner, MealPlanCode}` | ✅ **derivable.** Ya no es gap crítico. |
| `RatePlan.ratePerNight` | `RateInfo.AverageNightlyRate` / `AverageNightlyRateBeforeTax`; en getBooking `room.roomRate` | ✅ **VERIFICADO-SPEC** `:1479`, `:3099` |
| `RatePlan.totalRate` / `taxes` | `RateInfo.AmountBeforeTax` / `AmountAfterTax` + `Taxes.Tax[]` + `TaxGroups` + `Fees.Fee[]` + `FeeGroups` | ✅ **VERIFICADO-SPEC** `:1459`, `:2102`, `:2203` |
| `RatePlan.cancellation` | `CancelPenalties.CancelPenalty[]{Refundable, Deadline, AmountPercent, PenaltyDescription}` | ✅ **VERIFICADO-SPEC** `:2342`. **Gap crítico cerrado.** |
| `RatePlan.paymentDueAtProperty` | `PrepaidIndicator` (booleano por `RatePlan`) + `paymentPolicy: LATE` | ✅ **VERIFICADO-SPEC** `:1849` |
| `HotelStay.checkIn/checkOut/nights` | `StayDateTimeRange` / `RateInfo.StartDate`-`EndDate` | ✅ |
| `HotelStay.occupancy` | `Rooms.Room[]{Adults, Children, ChildAges}` | ⚠️ mapea a `PaxCountSchema`, **pero sólo ocupación homogénea** (§2.1.4) |

**Campos de Sabre sin hueco en el canónico** (ampliar el modelo o guardarlos en `providerMetadata`):

| Campo Sabre | Por qué importa |
| --- | --- |
| `RateKey` | Token de tarifa. Concepto igual al `choiceId` de Despegar, **pero no expira** — se puede persistir en una cotización. |
| `BookingKey` | Token bookable post-pricecheck. Análogo al resultado del `prebook` de Despegar. |
| `Guarantee.GuaranteeType` → `paymentPolicy` (`GUARANTEE` \| `DEPOSIT` \| `LATE`) | Concepto GDS que Despegar no tiene. Ampliar `RatePlanSchema`. |
| `GuaranteesAccepted[].GuaranteeTypeCode` + `PaymentCards.CVVRequired` | **Determina si la tarifa se puede vender sin tocar un PAN.** Imprescindible para el filtro PCI de §2.5(a). |
| `RateSource` / `sourceTypeCode` + `HotelSourceEnum` | De qué inventario salió la tarifa → qué condiciones aplican. Candidato a `Offer.providerMetadata`. |
| `Commission{Percent, Amount, Type}` | **Base del pricing waterfall del consolidador.** |
| `MinSellingRate` | Precio recomendado del proveedor cuando se trabaja con net rates — techo natural del markup. |
| `corporateDiscountCode`, `RatePlanCandidates`, `ClientId` | Tarifas negociadas: el corazón del BYOC. |
| `itemId` | Id del ítem dentro del PNR. Necesario para cancelación selectiva y modify. |
| `bookingSignature` | Concurrencia optimista. |
| `roomExtras[]` (`26` Crib, `91` Roll-away, `196` Extra Person) | Ancillaries de hotel. |
| `associatedFlightDetails` | Vínculo hotel↔vuelo sin PNR único (§6.5). |
| `pinCode` | Localizador de Booking.com — hay que mostrarlo al cliente en ese origen. |
| `hotelStatusCode` / `hotelStatusName` | Estado real de la reserva en el proveedor. |
| `ShopKey` | Paginación correcta. |

### 7.2 Autos ← Sabre

**No hay modelo canónico de auto.** `packages/canonical/src/` contiene `hotel.ts`, `itinerary.ts`, `money.ts`, `offer.ts`, `pax.ts`, `segment.ts` — **ningún `car.ts`** (**VERIFICADO** en el repo). Los autos viven en tipos propios de `providers/agent-cars/src/types.ts` (`CarOffer`, `CarSelection`, …).

1. Si Sabre autos entrara (**no lo recomiendo**, §5.4), habría que **crear el canónico de auto primero**. El contrato de Sabre daría una base excelente (`VehRentalRate` + `Vehicle` + `VehicleCharge` es más completo que `CarOffer`), pero es trabajo no presupuestado.
2. Independientemente de Sabre, **hay deuda de arquitectura**: `apps/api/src/cars/cars.controller.ts` devuelve tipos de `@sales-travel/agent-cars` directamente al HTTP. Viola el anti-patrón declarado en `CLAUDE.md` («tipos de proveedor filtrándose al dominio»). **Ítem propio de backlog, sin relación con Sabre.**

### 7.3 Gaps de plataforma

| Gap | Detalle | Estado |
| --- | --- | --- |
| **Sin transporte SOAP** | Ningún adapter habla XML. Cliente SOAP + parser (`fast-xml-parser`) en `packages/core/ports/`, no en el dominio. | **Sólo necesario para el mecanismo C de §6.3.** Degradado de bloqueante a opcional. |
| **Sin sesiones stateful** | `SessionCreateRQ` / `SessionCloseRQ` con afinidad y cierre garantizado. | **Sólo para §6.3 y 8 variantes de FoP.** Un v1 sin ellas es viable (§3.4). |
| **Sin concurrencia optimista** | `bookingSignature` no tiene equivalente en nuestro modelo de orden. | Abierto |
| **Sin `itemId` por vertical** | Nuestro modelo asume 1 reserva = 1 proveedor = 1 vertical. | Abierto |
| **Sin operación de modificación** | Ni el puerto ni el dominio contemplan modificar una reserva confirmada. Es un `HotelModifyPort` nuevo. | Abierto |
| **PCI** | §2.5 y §3.1.2. | **El bloqueante mayor** |
| **Deduplicación cross-provider** | Sin GIATA, ≥3 fuentes de hotel producen duplicados. | Abierto (M1.6) |
| **Ocupación mixta** | Sabre exige la misma config de pax en todas las habitaciones; GDS no soporta multi-room. | 🆕 **Nuevo, descubierto en el contrato** |
| **`targetPcc` no revierte contexto** | *«The API does not revert context after completing the booking»* — hay que gestionarlo por conexión. | 🆕 **Nuevo** |

---

## Preguntas abiertas

> Se han eliminado las ~20 preguntas que los contratos respondieron: forma de las cinco respuestas, catálogos `bedTypeCode` / `physicalDisabilityCode` / `roomExtraType`, semántica de `BestOnly` / `TierLabels` / `RateDetailsInd`, `RefPointType`, valores de `errorHandlingPolicy`, `CarExtrasPref`, `paymentPolicy` de auto, `useCsl` vs `useCSL`, `payment` anidado en `car`, `flightIndex`, `RateSource` como lista, `POS.PseudoCityCode`, PCC por agencia, comisión expuesta, multi-habitación, modificación de vehículos y formato de errores.

**Bloqueantes de decisión:**

1. **¿Se puede reservar hotel sin PAN?** Filtrando por `GuaranteesAccepted[].GuaranteeTypeCode` para vender sólo tarifas garantizables con `AGENCY_IATA` / `AGENCY_NAME` / `CORPORATE` / `LATE`: **¿qué porcentaje del inventario queda?** Medible en un spike contra CERT. **Es la pregunta que decide si Sabre entra.**
2. **¿De dónde sale el número de `VIRTUAL_CARD`?** ¿Lo emite Sabre o hay que traerlo de un emisor externo (Conferma/WEX)? Es la salida (b) de §2.5.
3. **¿Qué exige la certificación de Sabre?** Alcance, duración, coste. No está en ninguna fuente disponible.
4. **¿Funciona el mecanismo B de §6.2** — `createBooking` único con `flightOffer` NDC + `hotel`/`car`? El schema lo permite; la prosa oficial y la colección sugieren que no. **Si funciona, el PNR único no necesita SOAP y cambia por completo la ecuación de coste.**

**Lagunas de contrato:**

5. **Diff `get/hotelavail` v4 → v5.** Todo lo VERIFICADO-SPEC de §2 sale de v4; la colección usa v5. Pedir el spec al account manager (el slug vive detrás del login del catálogo).
6. **Spec de Vehicle Price Check.** No está entre los 15 descargados. Única laguna de la vertical auto.
7. **Spec de `Get Hotel Details`.** Mencionado en el help de pricecheck como fuente alternativa de `RateKey`; no está en la colección ni tenemos contrato.

**Catálogos que siguen faltando:**

8. **Correspondencia numérica completa `RateSource` ↔ `HotelSourceEnum`.** Confirmados `100`↔Sabre GDS y `113`↔Booking.com. Faltan `110` y `112`.
9. **Código corto de `LATE` en `Guarantee.GuaranteeType`.** El `guaranteeMap` de la colección sólo cubre `GUAR` y `DEP`. La vía correcta es la tabla OTA PMT vía `GuaranteeTypeCode`.
10. Catálogos SCA: `issuesCode`, `channelCode`, `exemptionTypeCode`, `mandateTypeCode`, `cardNumberCollectionCode`, `verificationResultCode`, `electronicCommerceIndicator`. El spec los declara string libre.
11. Tabla OTA `RPT` completa para `RatePlanType` (el enum va de `"1"` a `"33"` sin descripciones).

**Ambigüedades operativas:**

12. **¿Existe `POS.Source.PseudoCityCode` en el body REST de `get/hotelavail` v5?** En v4 el spec lo declara pero los ejemplos REST de la colección no lo mandan. El error `5276` sugiere que sí. Determina si el BYOC aplica también al shop o sólo al pricecheck.
13. **Lat/long por propiedad en la respuesta de avail.** `HotelInfo` de v4 no lo trae (sólo `Distance`/`Direction`). ¿Lo añade v5? Sin él no se puede pintar el mapa de resultados.
14. **¿Es `creationDetails.agencyIataNumber` obligatorio en `modifyBooking`?** Aparece en las 6 familias, pero el contrato declara `creationDetails` opcional.
15. Contenido de la variable `{{request}}` usada como `before` en «modify FoP including 'before' section - CC».
16. **`deliverySite.id` / `collectionSite.id`** — el `#source` del spec indica que vienen del proveedor en `getBooking`, y `DeliveryCollectionInfo` del avail está marcado «FUTURE USE ONLY». **¿Hay alguna forma documentada de descubrirlos antes de reservar?**
17. **¿Hay mapeo GIATA o equivalente** para deduplicar hoteles Sabre contra Despegar? Sin él, el fan-out multi-fuente es inviable en la UI.
18. **¿Cuánto tarda realmente la propagación del branch access?** El error `5276` dice 5 minutos. Determina el UX del alta de agencia.

---

## Riesgos

| # | Riesgo | Impacto | Prob. | Mitigación |
| --- | --- | --- | --- | --- |
| R1 | **Conflicto PCI.** `createBooking` y `modifyBooking` exigen `cardNumber` + `cardSecurityCode` en el body, y el `UpdatePassengerNameRecordRQ` de §6.3 en el XML, contra la regla explícita de `CLAUDE.md` (hosted checkout, SAQ-A). | **Crítico** — puede invalidar la integración | **Alta** (verificado en el 100 % de los ejemplos con tarjeta) | Medir en CERT qué porcentaje del inventario es reservable con `AGENCY_IATA` / `CORPORATE` / `LATE`, filtrando por `GuaranteesAccepted`. Si es aceptable, vender sólo eso. Si no, evaluar `VIRTUAL_CARD` con emisor externo. Último recurso: descartar la vertical. |
| R2 | 🆕 **`CCVIEW` en modificación.** El `before` poblado exige PAN sin enmascarar, y la alternativa oficial es activar el keyword `CCVIEW` en el EPR — un permiso para ver números de tarjeta completos. | **Crítico** | Alta | **No implementar en v1 ninguna modificación que toque la forma de pago.** Las otras 5 familias (fechas, huéspedes, titular, `productCode`, campos comunes) no lo requieren. |
| R3 | **Sesiones SOAP stateful** para el mecanismo C de §6.3 y 8 de 12 variantes de FoP. Rompen el fan-out sin estado y exigen cierre garantizado o se filtran sesiones. | Medio *(rebajado)* | Media | Alcance recortado: v1 sólo REST. `modifyBooking` / `createBooking` son stateless por contrato (§1.2). Si se adopta §6.3, hacerlo en Temporal con compensación. |
| R4 | **Duplicación de hoteles en resultados.** Sin GIATA, el mismo hotel aparece desde Despegar y desde ≥5 fuentes de Sabre en la misma llamada. | Alto — daña «tiempo a venta < 2 min» | Alta | Resolver el mapeo GIATA **antes** de habilitar Sabre en el fan-out. Ya en roadmap como M1.6. Mitigación intermedia: `BestOnly: "1"` (una tarifa por propiedad, la más baja de todas las fuentes). |
| R5 | 🆕 **Ocupación mixta no soportada.** Sabre exige la misma configuración de pax en todas las habitaciones (error `5029`), y GDS no soporta multi-room en absoluto. | Alto para el caso familiar | **Certeza** (contrato + error oficial) | Detectarlo en el borde y **no llamar a Sabre** cuando la petición tenga ocupación mixta: degradar a Despegar. Nunca fallar la búsqueda entera. |
| R6 | 🆕 **`targetPcc` no revierte el contexto** tras la operación. Una reserva de la agencia A puede dejar la conexión apuntando al PCC de A para la siguiente petición. | Alto — **fuga cross-tenant** | Media | Mandar `targetPcc` **explícitamente en cada request**, nunca confiar en el contexto heredado. Test de aislamiento cross-tenant obligatorio en CI (ya exigido por `CLAUDE.md`). |
| R7 | **`before`/`after` mal construidos → corrupción de reserva.** Sabre computa el diff entre ambos; un campo omitido en `before` puede interpretarse como alta, y uno omitido en `after` como borrado. | Alto | Media *(rebajada: ya conocemos la forma completa)* | `before` = respuesta literal del `getBooking` inmediatamente anterior; `after` = esa estructura mutada. Nunca construir ninguna de las dos a mano. Tests de integración con `GetBooking :printDiff`. |
| R8 | **Certificación de Sabre no cuantificada.** Alcance, duración y coste desconocidos. | Medio | Media | Preguntar al account manager antes de comprometer fecha. |
| R9 | **Duplicación funcional sin ganancia neta en autos.** AgentCars ya cubre lo mismo, más ON HOLD/`release`, `suggest` y reporte diario. | Medio (coste de oportunidad) | Alta | **Descartar autos de Sabre** (§5.4). |
| R10 | **Ejemplos de la colección con errores.** `useCSL` (el contrato sólo conoce `useCsl`), `payment` anidado en `car` (no existe en `CarToBook`), `"age": 3` en un `ADT`, `itemId` numérico (el contrato lo declara string). | Medio *(rebajado: los 4 están identificados)* | Media | **Construir el `request.builder.ts` contra el contrato, no contra los ejemplos.** Los 4 errores conocidos están documentados aquí. |
| R11 | **`bookingSignature` por PNR, no por ítem.** Dos vendedores tocando el mismo paquete chocan. | Medio | Media (crece con el uso del Package Studio) | Lock pesimista a nivel de reserva en nuestra capa, por encima del optimista de Sabre. |
| R12 | **`SabreRating` ≠ estrellas oficiales.** Mapearlo a `Hotel.starRating` produciría rankings inconsistentes entre proveedores en la misma pantalla. | Medio | Media | Llevarlo a un campo propio. El contrato lo describe como «The Sabre Property Rating», no como clasificación oficial. |
| R13 | 🆕 **Laguna de versión v4 vs v5.** Todo lo verificado del avail sale del contrato v4; la colección usa v5. | Medio | Media | Pedir el spec de v5. Mientras tanto, no dar por cerrado ningún campo del avail sin validarlo contra una respuesta real. |
| R14 | **Distracción estratégica.** Sabre es grande y tentador; hoteles y autos ya están en producción y la fase 1 tiene compromisos abiertos. | Medio | Media | Este documento es el gate: **no entra a fase 1.** Reevaluar sólo con las condiciones de §5.4 cumplidas. |
