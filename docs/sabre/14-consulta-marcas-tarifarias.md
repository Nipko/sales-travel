# Consulta abierta: varias tarifas por itinerario en BFM v5

**Estado:** las marcas EXISTEN y el terminal de agente las ve; falta el permiso de API. Ver §0.
**Fecha:** 2026-08-27.
**Para qué sirve este documento:** es autocontenido. Se puede pasar tal cual a soporte de Sabre
(§A, en inglés) o a un agente de investigación (§B) sin explicar nada más.

---

## §-1 — RESUELTO por otra vía: la escalera de exclusión

**No hizo falta que Sabre habilitara nada.** El producto de upsell sigue sin estar, pero el
filtro `BrandFilters` **sí lo tenemos**, y con él se recorre la escalera de marcas a mano.

Verificado contra CERT el 2026-08-27, mismo request que ya funcionaba:

| Petición                             | Marca de American              | Precio     | Reembolsable |
| ------------------------------------ | ------------------------------ | ---------- | ------------ |
| `SingleBrandedFare`                  | `MAIN` — MAIN CABIN            | 388,84 USD | No           |
| `SingleBrandedFare` + excluir `MAIN` | `MAINFL` — MAIN CABIN FLEXIBLE | 447,44 USD | **Sí**       |

Delta, que no se excluyó, siguió devolviendo la suya: **el filtro es por código y no toca a los
demás carriers.**

Y la respuesta trae el `brand.code`, así que **no hay que conocer los códigos de antemano**: cada
ronda aprende de la anterior. Funciona igual para JetSMART, Avianca o quien sea.

**Implementado** como `shopOptions.brandLadderRounds` (por defecto **0**). Cada ronda es una
llamada de shop y Sabre cobra por consulta: es el único parámetro del paquete cuyo coste es
lineal y en dinero, así que lo sube la agencia que decida que la comparación vale lo que cuesta.
Con 2 rondas el vendedor ve hasta 3 marcas por vuelo. La escalera para sola en cuanto una ronda
no aporta marcas nuevas, y si una ronda falla se queda con lo que ya tenía.

> Lo que sigue (§0 en adelante) es el diagnóstico que llevó hasta acá y el ticket para Sabre, que
> **sigue teniendo sentido**: con el upsell habilitado esto se haría en UNA llamada en vez de N.

---

## §0 — La prueba que lo cierra: el host SÍ ve las cinco marcas

Ejecutado el 2026-08-27 en **Sabre Agency Workspace CERT, PCC `7VYK`**, sobre el MISMO mercado y
la misma aerolínea que la API devuelve con una sola tarifa:

```
FQBOGCLO09SEP-JA
```

El despliegue devuelve **230 tarifas agrupadas en CINCO familias**:

```
JA-JAV/TS - BASIC
JA-JAV/I0 - TRAVELER
JA-JAV/I1 - LIGHT
JA-JAV/I2 - SMART
JA-JAV/I3 - FULL FLEX
```

**Esto separa las dos hipótesis que quedaban, y gana una sola:**

| Hipótesis                                     | Veredicto                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| El contenido de la ruta no tiene marcas       | **FALSA.** Hay cinco, publicadas por el carrier en este mismo mercado. |
| El PCC no las puede ver                       | **FALSA.** El terminal de agente las lista.                            |
| Falta el permiso de **API** para pedir varias | **La que queda.** Es lo único que explica el `MIP/PROCESS`.            |

> **Salvedad, para no concluir de más:** la prueba se hizo en el PCC `7VYK`, que es el SEGUNDO
> PCC de la cuenta. Si la plataforma busca con otro, lo demostrado es que el producto existe en
> la cuenta y que ese PCC lo ve — no que el PCC de la búsqueda esté igual de configurado. Los
> entitlements son POR PCC.

Y encaja con lo que ya devolvía la API: `brandsOnAnyMarket: true` en el 100% de los itinerarios
—Sabre nos estaba diciendo «este viaje TIENE marcas»— junto a una sola tarifa por vuelo.

---

## Resumen en una línea

Pedimos varias tarifas del mismo vuelo por las **dos vías documentadas** y el motor de compra
rechaza las dos con un fallo de negocio dentro de un HTTP 200. La vía de **una** marca por vuelo
funciona perfectamente en el mismo PCC y la misma llamada.

## Lo que SÍ funciona hoy

`SingleBrandedFare: true` — devuelve una marca por itinerario, con su nombre.

```
offers: 50   conMarca: 50   marcas: ["BASIC", "FULL FLEX", "LIGHT", "FLEX", ...]
```

Sabre además declara `brandsOnAnyMarket: true` en **todos** los itinerarios, o sea que el
contenido de esa ruta tiene marcas. No es un problema de contenido.

## Lo que NO funciona

| Intento                                                               | Respuesta de Sabre                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MultipleBrandedFares: true` + `UpsellLimit`                          | `{"type":"MIP","code":"PROCESS"}`                                                                                                            |
| `SingleBrandedFare` + `MultipleBrandedFares` juntas (ejemplo oficial) | `{"type":"MIP","code":"PROCESS"}`                                                                                                            |
| `FlexibleFares.FareParameters[]` (MFPI)                               | `{"type":"OPAQUE_VALUE_REDACTED","code":"PROCESS"}`, `{"type":"ERR","code":"ERR"}`, `{"severity":"warning","type":"FLEXFARES","code":"MSG"}` |

Todas con **HTTP 200** y `severity: "error"` dentro del sobre.

---

## §A — Para soporte de Sabre (copiar y pegar)

> **Subject:** BFM v5 — `MIP/PROCESS` when requesting Multiple Branded Fares / Multiple Fares Per
> Itinerary. Single Branded Fare works on the same PCC.
>
> **Account:** PCC `7VYK` (CERT). Line address `8D71A2`.
> **Context:** BFM was activated on this PCC per our meeting with Sabre, and it works — the
> question below is about a _different_ capability, not about BFM itself.
>
> **Endpoint:** `POST /v5/offers/shop` (REST). Environment: CERT.
> **Conversation IDs** (rejections): `sales-travel-5e9e3c76-9b3a-48ba-85dd-6b94e093c9ab`,
> `sales-travel-a57a776c-83ab-44ab-8cca-86283c5bc3a2`.
>
> **What works.** With `TravelerInfoSummary.PriceRequestInformation.TPA_Extensions.BrandedFareIndicators
= { "SingleBrandedFare": true }` we get 50 itineraries, each with a brand
> (`BASIC`, `FULL FLEX`, `LIGHT`, `FLEX`). Every itinerary also returns
> `pricingInformation.brandsOnAnyMarket: true`.
>
> **What fails.** All three of the following return HTTP 200 with an application-level error and
> no itineraries:
>
> 1. `BrandedFareIndicators = { "MultipleBrandedFares": true, "UpsellLimit": 3 }`
>    → `{"source":"application","severity":"error","type":"MIP","code":"PROCESS"}`
> 2. `BrandedFareIndicators = { "SingleBrandedFare": true, "MultipleBrandedFares": true, "UpsellLimit": 3 }`
>    — i.e. exactly the combination shown in your own doc page _"Request Example for Single and
>    Multiple Branded Fares"_ — → same `MIP/PROCESS`.
> 3. `TravelPreferences.TPA_Extensions.FlexibleFares.FareParameters = [ {}, { "Baggage": { "FreePieceRequired": true } } ]`
>    → `{"type":"OPAQUE_VALUE_REDACTED","code":"PROCESS"}`, `{"type":"ERR","code":"ERR"}`,
>    `{"severity":"warning","type":"FLEXFARES","code":"MSG"}`
>
> The rest of the request is identical in all cases and is the one that succeeds with
> `SingleBrandedFare`: `Version: "5"`, `IntelliSellTransaction.RequestType.Name: "50ITINS"`,
> `NumTrips.Number: 50`, `DataSources: { NDC: Enable, ATPCO: Enable, LCC: Disable }`,
> `MultipleSourcePerItinerary.Value: true`, `Baggage.RequestType: "C"`.
>
> **The brands exist and the host can see them.** On the same market and carrier, in Sabre
> Agency Workspace CERT (PCC `7VYK`), `FQBOGCLO09SEP-JA` returns 230 fares grouped in **five
> branded families**: `JA-JAV/TS - BASIC`, `JA-JAV/I0 - TRAVELER`, `JA-JAV/I1 - LIGHT`,
> `JA-JAV/I2 - SMART`, `JA-JAV/I3 - FULL FLEX`. The API returns exactly one of them per
> itinerary, and rejects any request for more.
>
> **Questions:**
>
> 1. **BFM is active on this PCC and basic branded fares work.** Is **Multiple Branded Fares**
>    (returning several brands per itinerary in one response) part of that same entitlement, or a
>    separate line item? If separate: what is the cost and the activation path? We are currently
>    emulating it with N sequential calls using `BrandFilters` exclusion, which multiplies our
>    per-query cost.
> 2. The content clearly carries five brands and the host displays them (see above), so this is
>    not a content gap.
> 3. Is **Multiple Fares Per Itinerary (MFPI)** enabled for this PCC? Your docs list MFPI as
>    incompatible with Alternate Cities, Award Shopping, Area Shopping and Low Cost Carriers — we
>    request none of those. Is it also incompatible with `DataSources.NDC = Enable` or with
>    `MultipleSourcePerItinerary`?
> 4. Does `MIP/PROCESS` specifically indicate a missing entitlement, or can it also indicate an
>    invalid parameter combination? We could not find this code in the published error catalog.

---

## §B — Para un agente de investigación

**Objetivo:** que el vendedor vea, para un mismo vuelo, varias tarifas comparables
(«sin maleta $X / con maleta $Y», o Light/Plus/Top), en lugar de una sola.

**Lo que ya está descartado — no repetir:**

1. **No es la ubicación del bloque.** `BrandedFareIndicators` va en
   `TravelerInfoSummary.PriceRequestInformation.TPA_Extensions`. Ponerlo bajo
   `TravelPreferences.TPA_Extensions.FlexibleFares` —que también lo acepta por esquema— provoca
   el mismo fallo de negocio. Verificado contra los 34 requests de la colección oficial que piden
   marcas: los 34 usan esa ubicación.
2. **No es que falte pedirlo.** Se pide, y con `SingleBrandedFare` responde bien.
3. **No es falta de contenido.** `brandsOnAnyMarket: true` en el 100% de los itinerarios, y el
   terminal de agente lista CINCO familias en ese mercado (§0). El contenido está.
   **Esto es lo más importante del documento: no hay nada que buscar del lado del contenido.**
4. **No es que el mapper no lo lea.** La marca llega y se muestra; sale de
   `fareComponentDescs[].brand` (`BrandType`), no del `pricingInformation.brand` plano, que en
   estas respuestas viene vacío.
5. **No es la combinación de banderas.** Se probó `SingleBrandedFare + MultipleBrandedFares`
   juntas, tal como el ejemplo oficial, y también se rechaza.
6. **`MIP` no es un código de error**: es el nombre del motor de compra de Sabre
   (`pricingSource`/`pricingSubsource`, ejemplo `'MIP'`, `bargain-finder-max-v5.yml:8848`).
   `MIP/PROCESS` = «el motor no pudo procesar esto».

**Lo que falta averiguar, en orden de valor:**

1. Si el PCC tiene habilitado **por API** el producto Multiple Branded Fares. Ya sabemos que el
   contenido existe y que el host lo ve (§0), así que la pregunta es sólo de permiso de API.
   **No se puede consultar desde el Developer Hub**: ni el perfil ni «Applications» listan entitlements —«Applications»
   son credenciales de prueba del _Try it Out_, sin relación con la cuenta de producción—. El
   propio catálogo de errores remite al account manager para `USG_AUTHORIZATION_FAILED`.
2. Si MFPI es incompatible con `DataSources.NDC = Enable` o con `MultipleSourcePerItinerary`. La
   doc lista cuatro incompatibilidades (Alternate Cities, Award, Area Shopping, LCC) y ninguna
   aplica, pero la lista puede no ser exhaustiva. **Es la hipótesis técnica más viva.**
3. Si existe un catálogo de errores donde `MIP/PROCESS` esté documentado con causas.

**Cómo probar sin tocar producción:** en Postman, sobre un request de shop que ya funcione,
añadir un bloque por vez y mirar `groupedItineraryResponse.messages[]`. Un rechazo llega como
HTTP **200** con `severity: "error"`, no como 4xx.

---

## Cómo está el código mientras tanto

- **Por defecto se pide `upsell`**, y si el motor lo rechaza el adapter **degrada solo**:
  `upsell → single → off`, un escalón por vuelta, conservando lo que sí funciona. El techo
  aprendido se recuerda por instancia, así que se paga una llamada de más por proceso y no por
  búsqueda.
- **MFPI está apagado** por defecto y se enciende por cuenta con
  `config.shopOptions.multipleFares: 'with-baggage'`.
- El día que Sabre habilite cualquiera de los dos productos, **no hay que tocar código**: basta
  con que el motor deje de rechazarlo. La escalera sube sola en el siguiente proceso.

> **Cicatriz.** Encender estas funciones por defecto tumbó el buscador dos veces (`502`), porque
> un rechazo de una mejora opcional se llevaba por delante al proveedor entero y `latam-ndc`
> estaba fuera por moneda. Por eso la degradación es un bucle y no un reintento, y por eso lo no
> demostrado se enciende por cuenta y no para toda la red.
