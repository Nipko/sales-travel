# Varias tarifas por vuelo y elección de marca por trayecto

**Estado:** investigación cerrada · diseño **acordado e implementado** (§6). Falta verificar la reserva en CERT (H-07).
**Fecha:** 2026-10-19.
**Antecedente:** [`14-consulta-marcas-tarifarias.md`](14-consulta-marcas-tarifarias.md) (el
`MIP/PROCESS` del upsell y la escalera de marcas). Este documento no lo repite: parte de ahí.

---

## 0. Resumen en cinco líneas

1. **Por qué hoy se ve una sola tarifa:** pedimos `SingleBrandedFare` (una marca por itinerario,
   la más barata) y la escalera de marcas, que trae las demás, está en **0 rondas** por defecto
   (`SABRE_BRAND_LADDER_DEFAULT = 0`, `providers/sabre/src/shop/request.builder.ts:215`). El upsell
   de una sola llamada (`MultipleBrandedFares`) lo rechazó Sabre con `MIP/PROCESS` (doc 14).
2. **El producto de Sabre que lo resuelve en una llamada es Multiple Branded Fares (MBF)** y lo
   **activa Sabre** por PCC (§2.4). No es código.
3. **Con MBF y `ParityMode: Leg`**, Sabre devuelve varias `pricingInformation` por itinerario, cada
   una una combinación cotizada de marcas por trayecto (§2.2). El mapper ya convierte cada
   `pricingInformation` en una `Offer`: **el canónico no necesita cambiar de forma** (§4).
4. **La elección «ida + tarifa, vuelta + tarifa»** tiene flujo oficial en Sabre: **Anchored
   Search** (§2.5), que está en el contrato REST v5 (`OriginDestinationInformation.Fixed`).
   Elegida la ida y su marca, una segunda búsqueda con la ida fija (y su marca como
   `BrandFilters` del trayecto) devuelve las vueltas combinables con **precio exacto de ida y
   vuelta**, sin necesitar MBF. Flight Check ya revalida fijando la tarifa **por trayecto** (§3.1).
5. **La reserva hoy NO garantiza la marca:** va con `flightPricing: [{}]` («cotiza con
   defaults»). La colección oficial tiene el ejemplo exacto para fijarla por vuelo:
   `qualifiers.brandedFares[{brandCode, flightIndices}]` + `specificFares[{fareBasisCode,
flightIndices}]` (§3.2).

---

## 1. Lo que hace el código hoy

| Pieza                    | Qué hace                                                                                                                                                                                                                          | Dónde                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Request BFM              | `BrandedFareIndicators` en `TravelerInfoSummary.PriceRequestInformation.TPA_Extensions`; modo `single` por defecto, `upsell` por cuenta, degradación `upsell → single → off`                                                      | `shop/request.builder.ts:125-144`, adapter `:270-340`             |
| Escalera de marcas       | Una llamada extra por carrier y ronda, `VendorPref=Only` + `BrandFilters` (exclusión **a nivel de request**, o sea en todos los trayectos a la vez). 0 rondas por defecto                                                         | `sabre-flight-search.adapter.ts:414-520`                          |
| Mapper                   | **Una `pricingInformation` = una `Offer`**. Marca por componente desde `fareComponentDescs[].brand`; `fareComponents[]` canónico con `segmentRefs`, fare basis y clase por componente                                             | `shop/response.mapper.ts:603`, `:1348`                            |
| Flight Check             | Revalida con `fareBasisCode.preferences[]` **por journey** sacadas de `offer.fareComponents`                                                                                                                                      | `flight-check/request.builder.ts:172`, `:240-300`                 |
| Reserva ATPCO            | `flightDetails.flights[]` + `flightPricing: [{}]`                                                                                                                                                                                 | `sabre-order-create.adapter.ts:1017-1060`, `:1269`                |
| UI de búsqueda (web-b2b) | Agrupa ofertas por **itinerario completo** (todos los vuelos de ida y vuelta juntos) y muestra las tarifas del grupo en `FareFamilyMatrix`. En ida y vuelta, cada tarifa es una combinación cerrada: no hay elección por trayecto | `cotizaciones/page.tsx:122`, `_components/fare-family-matrix.tsx` |
| LATAM NDC                | Una `Offer` por oferta de AirShopping (una por price class); `fareFamily` plano, sin `fareComponents`                                                                                                                             | `providers/latam-ndc/src/airshopping/response.mapper.ts:158`      |

Consecuencia: con `single` y 0 rondas, cada vuelo trae **una** oferta, y en ida y vuelta la marca
de cada trayecto la decide Sabre (la más barata). Es exactamente lo que describe el founder.

---

## 2. Cómo pide y devuelve marcas BFM v5

### 2.1 Request — `BrandedFareIndicators`

Ubicación válida: `TravelerInfoSummary.PriceRequestInformation.TPA_Extensions.BrandedFareIndicators`
(`bargain-finder-max-v5.yml:7932-7985`). Campos:

| Campo                    | Qué hace (contrato)                                                                                                                                                                              | Línea `v5.yml`   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `SingleBrandedFare`      | _"Return single brand option per itin."_                                                                                                                                                         | 7978             |
| `MultipleBrandedFares`   | _"Return multiple brand options per itin. NDC Applicable."_                                                                                                                                      | 7950             |
| `UpsellLimit`            | Tope de soluciones de upsell por itinerario                                                                                                                                                      | 7982             |
| `ParityMode`             | `Leg` \| `Itin`: lógica de paridad de marca. Con `Itin` sin `ItinParityFallbackMode`, Sabre aplica la marca única más baja y devuelve **una** opción                                             | 7954             |
| `ItinParityFallbackMode` | `LegParity` \| `LowestSingle`: qué hacer cuando no se puede cumplir paridad de itinerario                                                                                                        | 7942             |
| `ParityModeForLowest`    | `Leg` \| `Itin` \| `None`: paridad forzada sobre la solución más barata. _"designed to work with MultipleBrandedFares feature only"_                                                             | 7963             |
| `ItinParityBrandlessLeg` | Permite trayectos sin marca dentro de una solución con paridad de itinerario                                                                                                                     | 7938             |
| `ReturnBrandAncillaries` | Devuelve los atributos de la marca (ATPCO **Table 166**): _"will be returned with single and multiple branded fares request"_                                                                    | 7972             |
| `BrandFilters`           | `Brand[{Code, PreferLevel: Preferred\|Unacceptable}]` + `NonBrandedFares`. **También existe por trayecto** en `OriginDestinationInformation.TPA_Extensions.BrandFilters` (_"for main fare leg"_) | 7986, 4458, 4691 |

Para NDC hay un juego paralelo en `TravelPreferences.TPA_Extensions.NDCIndicators`
(`MultipleBrandedFares.Value`, `MaxNumberOfUpsells.Value`, `ParityMode.Mode`, `ShowOneWays` —
_"display the one-ways (do not combine those into round trips)"_ para carriers con Brand Based
Shopping) (`v5.yml:7280-7400`). Hoy NDC está apagado por la cuenta (SAB-18), así que no aplica
todavía.

### 2.2 Paridad: ¿las marcas se combinan por trayecto o vienen en paquete?

**Las dos cosas, según `ParityMode`:**

- **`Itin` (paridad de itinerario):** la misma marca en todos los trayectos. Cada solución es un
  «paquete» (LIGHT/LIGHT, FLEX/FLEX). Es lo que obtiene hoy, de hecho, la escalera, porque su
  exclusión es a nivel de request.
- **`Leg` (paridad de trayecto):** cada trayecto lleva su marca y Sabre devuelve combinaciones
  mixtas cotizadas (LIGHT/FLEX…), cada una como una `pricingInformation` distinta del mismo
  itinerario, hasta `UpsellLimit`.

La respuesta siempre es por **itinerario** (ida+vuelta juntos): BFM no devuelve precios de un
trayecto suelto en un viaje redondo. La elección por trayecto es una presentación sobre
combinaciones cotizadas, no un dato que venga partido.

### 2.3 Response — dónde viene cada cosa

| Dato                                  | Dónde                                                                                                                                                                                                        | Línea `v5.yml`        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Varias tarifas del mismo itinerario   | `itineraries[].pricingInformation[]` (array)                                                                                                                                                                 | 4202                  |
| Marca por componente (= por trayecto) | `fareComponentDescs[].brand` (`BrandType`: `code`, `brandName`, `programCode`, `programDescription`, `programId`)                                                                                            | 2857-2890, 3304       |
| Importe de tarifa por componente      | `fareComponentDescs[].fareAmount` + `fareCurrency` (sin impuestos)                                                                                                                                           | 3286+ (`fareAmount`)  |
| Qué incluye la marca                  | `fareComponents[].brandFeatures[{ref}]` → `brandFeatureDescs[]` (`BrandFeatureType`: `application` F/N/C/D = gratis/no ofrecido/con cargo/mostrado no ofrecido, `commercialName`, `serviceGroup`, `subCode`) | 2795-2856, 3237, 3821 |
| «Este viaje tiene marcas»             | `pricingInformation.brandsOnAnyMarket`                                                                                                                                                                       | 8806                  |
| Equipaje por segmento                 | `passengerInfo.baggageInformation[].segments[]` (ya lo lee el mapper)                                                                                                                                        | —                     |

`brandFeatureDescs` es la fuente correcta para el resumen «qué incluye» por trayecto (maleta de
mano, facturada, cambios, reembolso, asiento), en vez de inferirlo del equipaje del pasajero.

### 2.4 Activación (entitlement)

- `MultipleBrandedFares` devolvió `MIP/PROCESS` en el PCC `7VYK` (doc 14 §0). El host de ese PCC
  **sí ve** cinco familias de JetSMART, así que no es contenido.
- La documentación de socios de Sabre indica que **MBF lo activa Sabre**, que el **EPR de web
  services necesita la keyword `SUBAAA`** y que los PCC de reserva deben estar **bridged** al iPCC
  de web services ([wiki de integración de Deem sobre Sabre BFM](https://deemadmin.atlassian.net/wiki/x/BwBup),
  resultado de búsqueda; página no accesible sin cuenta). Esto da dos preguntas concretas para el
  ticket de doc 14 §A: ¿tiene el EPR la keyword `SUBAAA`? ¿está MBF activo en el PCC de búsqueda
  (no sólo en `7VYK`)?
- **Verificado en el PCC de reserva de la cuenta CERT (2026-10-19, sonda de sólo búsqueda,
  autorizada por el founder, BOG-MIA ida y vuelta a 30+7 días):**

  | Variante de `BrandedFareIndicators`                                   | Resultado                                                                       |
  | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | `SingleBrandedFare`                                                   | 44 itinerarios, **1** `pricingInformation` cada uno (LA LIGHT/LIGHT 425,53 USD) |
  | `SingleBrandedFare` + `ReturnBrandAncillaries`                        | Igual, y **103 `brandFeatureDescs`, 14 por componente**: funciona sin MBF       |
  | `MultipleBrandedFares` + `UpsellLimit`                                | Rechazo de negocio (`BUSINESS`)                                                 |
  | `Single` + `Multiple` (ejemplo oficial)                               | Rechazo de negocio                                                              |
  | `Single` + `Multiple` + `ParityMode: Leg` + `ParityModeForLowest`     | Rechazo de negocio                                                              |
  | `Single` + `Multiple` + `ParityMode: Itin` + `ItinParityFallbackMode` | Rechazo de negocio                                                              |

  **MBF tampoco está en el PCC de reserva.** No es el PCC: es la cuenta.

- **Anchored Search y `BrandFilters` por trayecto, misma sonda:**

  | Petición                                    | Resultado                                                                          |
  | ------------------------------------------- | ---------------------------------------------------------------------------------- |
  | Base (`single`)                             | 50 ofertas: SL/SL 39, MAINREF/MAINREF 5, MAINFL/MAINFL 4, BASIC/FULL 1, ECOSAVER 1 |
  | Ida LA4402 fija (`Fixed`)                   | **16 vueltas** combinables (SL/SL 13, SL/KM 3)                                     |
  | Ida fija + `Preferred SL` en la ida         | Igual (SL ya era la más barata)                                                    |
  | Ida fija + `Unacceptable SL` en la ida      | Ida **KM STANDARD** + vuelta SL LIGHT, 443,03 USD (contra 425,53)                  |
  | Sin anclar + `Unacceptable SL` en la vuelta | 37 ofertas SL/**KM**: la vuelta sube, la ida queda en LIGHT                        |

  Conclusión: el filtro por trayecto mueve la marca de **un** trayecto y deja el otro en la más
  barata, con precio exacto de ida y vuelta. Es todo lo que hace falta para elegir tarifa por
  trayecto sin MBF.

### 2.5 Ayuda oficial con sesión iniciada (developer.sabre.com, BFM SOAP 7.2.0 Help)

La ayuda XML de BFM (con sesión) tiene la semántica que el YAML REST no explica. Lo relevante:

- **Branded Fares Shopping:** _"Each flight option includes fares for every brand as the lowest
  applicable fare for the brand"_. Es el producto que buscamos; el request de ejemplo es
  `SingleBrandedFare="true" MultipleBrandedFares="true"` juntos.
- **`ParityMode`:** con `Itin` y sin `ItinParityFallbackMode` se aplica _"the default fallback mode
  in the 'BFM rule' level"_ — o sea, **el comportamiento por defecto depende de la configuración
  del PCC en Sabre**, no sólo del request. Fallbacks: `LowestSingle` (sin upsell) o `Leg`
  (_"upsells generated using leg parity mode"_).
- **`UpsellLimit`:** de 1 a **11**. El ejemplo oficial con paridad por trayecto es
  `MultipleBrandedFares="true" SingleBrandedFare="true" ParityMode="Leg" UpsellLimit="2"`.
- **`ParityModeForLowest`:** sólo con MBF; fuerza paridad sobre la solución más barata.
- **`ItinParityBrandlessLeg`:** permite trayectos sin marca dentro de soluciones de upsell.
- **`ReturnBrandAncillaries`:** _"will be returned with single and multiple branded fares
  requests"_ → **no exige MBF**; se puede pedir ya con `SingleBrandedFare`.
- **`ReturnCheapestUnbrandedFare`:** devuelve además la tarifa sin marca más barata («catch all»).
- **Multiple Fares per Itinerary (MFPI):** hasta 10 grupos; incompatible con Alternate Cities,
  Award, Area Shopping y **Low Cost Carriers** (página _Error Messages_). Es otra vía, no la de
  marcas.

#### Anchored Search — el flujo oficial de «primero la ida, después la vuelta»

La ayuda lo describe así: _"enables an itinerary option to be selected, in order to receive (in a
second search) only itinerary recommendations that are combined with the previously selected
segments"_. Dos pasos:

1. BFM normal (ida y vuelta) → lista de opciones.
2. BFM de nuevo con el trayecto elegido **fijo**: `OriginDestinationInformation[n].Fixed = true` y
   sus vuelos en `OriginDestinationInformation[n].TPA_Extensions.Flight[]` (salida/llegada, número,
   origen/destino, `Airline.Marketing/Operating`). La respuesta trae sólo vueltas combinables con
   esa ida, **cada una con el precio de ida y vuelta cotizado**.

**Está en el contrato REST v5:** `Fixed` en `bargain-finder-max-v5.yml:2716` (_"Applicable to the
Anchored Search functionality. Used in context shopping."_) y `TPA_Extensions.Flight[]` en
`:4532`. Errores documentados: _"No such flight"_, _"Fixed part of the journey must be
continuous"_ (se pueden fijar trayectos desde el principio o desde el final, en bloque continuo).
Antes de la segunda búsqueda Sabre confirma horarios y disponibilidad de lo fijado y que haya
tarifa válida.

**Combinado con `BrandFilters` por trayecto** (`OriginDestinationInformation.TPA_Extensions
.BrandFilters`, `:4458`, `Preferred` con el código de la marca elegida en la ida), la segunda
búsqueda devuelve las vueltas **cotizadas con la marca de ida que eligió el vendedor**. No exige
MBF: usa `SingleBrandedFare`, que ya funciona en el PCC.

---

## 3. Revalidación y reserva de la marca elegida

### 3.1 Flight Check — ya fija la tarifa por trayecto

`fare.fareBasisCode` admite `RequestedFareBasisCodePerJourney`: `preferences[{values,
journeyIndices}]` (`flightcheck-api-v1.yml:404-470`). El builder ya lo emite por journey desde
`offer.fareComponents` (`flight-check/request.builder.ts:240-300`), y manda la `bookingClassCode`
de cada segmento. Por tanto una oferta **compuesta** (ida con fare basis/clase de la marca A,
vuelta con los de la marca B) se revalida sin cambiar el builder: Flight Check devuelve el precio
real de esa combinación, `price-changed` si difiere, y la marca por componente (`FareBrand`,
`:1299-1316`).

Flight Check además _"provides upsell capabilities"_ (`:5`): las alternativas `Same cabin` que ya
mapea el adapter (H-04 en doc 12 mostró `same-cabin-alternative`).

### 3.2 createBooking — fijar marca y fare basis por vuelo

Hoy: `flightPricing: [{}]`. Eso cotiza «con defaults»: Sabre elige la tarifa más baja válida para
las clases reservadas, que **puede no ser la marca elegida** (dos marcas pueden compartir RBD).

Contrato (`booking-management-v1.yml:4911-4930`, `:5838`): `PricingQualifiers.brandedFares[]` →
`BrandedFare{brandCode, flightIndices[]}` (índices desde 1; no pueden repetirse). Ejemplo oficial
de la colección, _"createBooking - Branded fares"_ (`sabre/Booking Management API
v2026.04.postman_collection.json`):

```json
"flightPricing": [{
  "qualifiers": {
    "brandedFares":  [{ "brandCode": "MAIN",     "flightIndices": [1] },
                      { "brandCode": "MAINFL",   "flightIndices": [2] }],
    "specificFares": [{ "fareBasisCode": "NUAHZNM3", "flightIndices": [1] },
                      { "fareBasisCode": "QVAHURG3", "flightIndices": [2] }]
  }
}]
```

Es exactamente el caso del founder: **una sola cotización con marca distinta por vuelo**. La
misma colección tiene _"Air with multi pricing (per flight)"_ (un `flightPricing` por vuelo), que
genera varias cotizaciones y no hace falta aquí.

**Propuesta:** en el carril ATPCO, construir `brandedFares` y `specificFares` desde
`offer.fareComponents` de la oferta **revalidada por Flight Check** (segmentRefs → índices de
vuelo + 1). Si un componente no trae marca, ese vuelo va sin `brandedFares` (tarifa sin marca);
si ninguno trae, se mantiene `[{}]`. Verificable en CERT con el arnés en cuanto se resuelva H-07
(doc 12).

---

## 4. Canónico — qué cambia y qué no

**No cambia la forma de `Offer`.** Una `Offer` sigue siendo una combinación **cotizada** y
reservable. Varias tarifas de un mismo vuelo = varias `Offer` con el mismo itinerario. Es lo que ya
producen Sabre (una por `pricingInformation`) y LATAM NDC (una por price class), así que el
agrupamiento sirve a los dos.

Lo que ya existe y basta para la elección por trayecto: `fareComponents[].brand` +
`segmentRefs` (marca por trayecto en Sabre). Para LATAM, sin `fareComponents`, se usa
`fareFamily` como marca de todos los trayectos (LATAM vende la misma marca ida y vuelta).

Añadidos opcionales propuestos (no rompen nada, todos `optional()`):

1. `FareComponent.includes?` — atributos de marca normalizados desde `brandFeatureDescs`
   (`{kind: 'carry-on'|'checked-bag'|'change'|'refund'|'seat'|'other', status:
'included'|'charge'|'not-offered', label}`), para el resumen por trayecto. Depende de
   `ReturnBrandAncillaries` (D3).
2. `Offer.provider.raw.pricedCombination` no hace falta: una oferta compuesta en la UI se marca
   `priceStatus: 'to-confirm'` en el cliente, no en el canónico, y Flight Check la reemplaza.

---

## 5. Producto — la elección por trayecto

Flujo en `/cotizaciones` (ida y vuelta):

1. **Lista de vuelos de ida**, agrupados por el vuelo de ida (no por el itinerario completo).
   Cada uno muestra «desde $X» = la combinación más barata que lo contiene (búsqueda normal).
2. Al abrir un vuelo de ida, **sus tarifas** (las marcas de ida presentes en las ofertas que ya
   llegaron: `single` + escalera, o MBF cuando exista), cada una con lo que incluye y su precio
   «desde».
3. Elegida ida + tarifa → **Anchored Search** (§2.5): una búsqueda con la ida fija y su marca
   como `BrandFilters` `Preferred` en ese trayecto. Devuelve las **vueltas combinables con su
   precio total exacto**. Cada vuelta muestra sus tarifas (la más barata siempre; más con la
   escalera acotada al trayecto de vuelta, o con MBF).
4. Resumen: ida (vuelo, tarifa, qué incluye) + vuelta (ídem) + total → «Guardar cotización».
5. Flight Check revalida la combinación final (ya fija fare basis por trayecto, §3.1) y la
   reserva fija marca y fare basis por vuelo (§3.2).

Si Anchored Search falla o está desactivado, la vuelta se elige entre las combinaciones que ya
trajo la primera búsqueda (degradación sin llamada extra).

Solo ida: igual, sin el paso 3.

Solo ida: igual, sin el paso 3. Móvil primero: pasos apilados con la selección fijada arriba
(chips «Ida · LA4211 · LIGHT ✓»), un solo CTA abajo.

---

## 6. Decisiones (acordadas con el founder el 2026-10-19)

- **D1 — sí, escalera en 2 rondas** por defecto para toda la red (`SABRE_BRAND_LADDER_DEFAULT = 2`;
  una cuenta la baja con `config.brandLadderRounds`). Las aerolíneas van en paralelo y con tope de 6
  por búsqueda. En la búsqueda inicial la escalera mueve la marca de la **ida**; en la de vueltas,
  la de la **vuelta**.
- **D2 — Anchored Search**, con degradación a las combinaciones de la primera búsqueda.
- **D3 — pendiente**: la sonda confirmó que `ReturnBrandAncillaries` funciona; mapear
  `brandFeatureDescs` al canónico queda como siguiente paso.
- **D4 — sí**, sonda corrida (§2.4).
- **D5 — sí**, la reserva fija marca y fare basis por vuelo; se verifica en CERT cuando se levante
  H-07.

## 6.1 Lo implementado

| Pieza       | Qué                                                                                                                                           | Dónde                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Request BFM | `fixedOutbound` (Anchored Search) y `legBrandFilters` por trayecto, como alcance interno de la llamada (no configurable por cuenta)           | `providers/sabre/src/shop/request.builder.ts` (`SabreShopRequestScope`, `anchorAndFilterLegs`) |
| Escalera    | Por trayecto (`marcaDeTramo`, `claveDeTramo`), aerolíneas en paralelo, tope `SABRE_BRAND_LADDER_MAX_CARRIERS`                                 | `providers/sabre/src/sabre-flight-search.adapter.ts`                                           |
| Vueltas     | `SabreFlightSearchAdapter.searchReturns` → puerto opcional `FlightReturnSearchPort` → `POST /search/flights/returns`                          | adapter, `packages/domain`, `apps/api/src/search`                                              |
| Reserva     | `flightPricing[0].qualifiers.brandedFares` + `specificFares` por vuelo desde `offer.fareComponents`                                           | `sabre-order-create.adapter.ts` (`atpcoPricingFor`), `booking/create.request.builder.ts`       |
| UI          | Paso 1: vuelos de ida con sus tarifas («Elegir esta ida»). Paso 2: ida fija arriba, vueltas con sus tarifas y el total («Guardar cotización») | `apps/web-b2b/.../cotizaciones/_components/round-trip-flow.tsx`, `leg-selection.ts`            |

## 6.2 Decisiones que se le plantearon al founder

| #   | Decisión                                                                                                                                                                                                                     | Recomendación                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **De dónde salen las tarifas extra** mientras Sabre no active MBF                                                                                                                                                            | Reabrir el ticket de doc 14 §A añadiendo `SUBAAA` y el PCC de búsqueda. Mientras tanto, **encender la escalera en 2 rondas** para la cuenta (hasta 3 marcas por vuelo) sabiendo que cada ronda es una consulta más que Sabre cobra, por carrier. El día que MBF esté, `upsell` + `ParityMode: Leg` lo hace en una llamada sin tocar código de UI |
| D2  | **Cómo se elige la vuelta**: Anchored Search (1 consulta más por cada ida elegida, precios exactos y combinaciones mixtas reales) o sólo entre combinaciones de la primera búsqueda (0 consultas extra, pocas combinaciones) | **Anchored Search**, con degradación a la segunda opción si falla. Es el flujo que documenta Sabre para esto (§2.5)                                                                                                                                                                                                                              |
| D3  | **Pedir `ReturnBrandAncillaries`** para el «qué incluye» por trayecto                                                                                                                                                        | Sí: la ayuda dice que funciona también con `SingleBrandedFare`. Como mejora degradable aparte (si Sabre la rechaza, se apaga sólo esa), mismo patrón que MFPI                                                                                                                                                                                    |
| D4  | **Autorizar la sonda de búsqueda en CERT** dentro del contenedor `api` del VPS (sólo `shop`)                                                                                                                                 | Sí: dice en 6 llamadas si el PCC actual ya tiene MBF y si `ParityMode: Leg` da combinaciones mixtas. Sin reservas ni dinero                                                                                                                                                                                                                      |
| D5  | **Reserva con `brandedFares`/`specificFares`** sin poder verificarlo en CERT hasta H-07                                                                                                                                      | Implementarlo con tests de contrato contra el ejemplo de la colección, y verificar en CERT al levantarse H-07                                                                                                                                                                                                                                    |

## 7. Fuentes

- `docs/sabre/evidence/specs/bargain-finder-max-v5.yml` — líneas citadas en cada tabla.
- `docs/sabre/evidence/specs/flightcheck-api-v1.yml:5`, `:404-470`, `:1299-1316`.
- `docs/sabre/evidence/specs/booking-management-v1.yml:4911-4930`, `:5838`.
- `sabre/Booking Management API v2026.04.postman_collection.json` — _"createBooking - Branded
  fares"_ y _"createBooking - Air with multi pricing (per flight)"_.
- `docs/sabre/14-consulta-marcas-tarifarias.md` — rechazo `MIP/PROCESS`, escalera, prueba en host.
- `docs/sabre/12-hallazgos-sandbox.md` — P-04 (marcas en 86-100 % de ofertas), H-04, H-07.
- developer.sabre.com con sesión, _Bargain Finder Max XML Help_ 7.2.0 (servida por
  `/api/v1/products/soap-api/bargain-finder-max/7.2.0/help-documentation/<página>.html`): páginas
  `branded-fares-shopping`, `paritymode`, `itinparityfallbackmode`, `paritymodeforlowest`,
  `itinparitybrandlessleg`, `upselllimit`, `returnbrandancillaries`,
  `returncheapestunbrandedfare`, `request-example-single-and-multiple-branded-fares`, _Features >
  Anchored Search_ (overview, functional details, ejemplos _Outbound Flight Selected_ y _Outbound
  Inbound Flights Selected_, error messages) y _Features > Multiple Fares per Itinerary_.
- [Branded Fares Shopping — developer.sabre.com](https://developer.sabre.com/branded-fares-shopping)
  (_"each flight option includes fares for every brand as the lowest applicable fare for the brand"_;
  hoy devuelve 404 al abrirla directa).
- [BrandedFareIndicators — developer.sabre.com](https://developer.sabre.com/brandedfareindicators-0).
- [Wiki de integración Deem — Sabre MBF](https://deemadmin.atlassian.net/wiki/x/BwBup) (activación
  por Sabre, keyword `SUBAAA`, PCC bridged; vía resultado de búsqueda).
