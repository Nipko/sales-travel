---
titulo: TBO Hotels — Search y oferta canónica
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Search y oferta canónica

> **Alcance.** Este documento cubre el contrato completo del método `Search` de la Hotel API V2.1 de TBO Holidays: request y response campo por campo, con el tipo que declara la tabla del PDF frente al que aparece en los ejemplos. También cubre su traducción a la oferta de hotel del repo. Quedan fuera y se tratan en otros documentos:
>
> - autenticación, transporte y clasificación de `Status.Code`: [01](./01-autenticacion-conectividad-y-errores.md);
> - revalidación y reserva: [03](./03-prebook-y-book.md);
> - post-venta: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md);
> - contenido estático, `hotel_inventory` y resolución destino → códigos: [05](./05-contenido-estatico-e-inventario.md);
> - dónde vive el contrato neutral de hotel y el registry multi-proveedor: [06](./06-seams-integracion-repo.md).
>
> **Fuentes.** La procedencia y la convención de citas están en [00-fuentes.md](./00-fuentes.md). "(p. N)" es la página **física** del PDF. "(Postman: Search)" es el request `Search` de la colección. "(Cert)" es el documento de certificación. `ruta:línea` es código del repo a la fecha de este documento.
>
> **Niveles de evidencia.**
>
> - **VERIFICADO-PDF**: leído en la página renderizada.
> - **VERIFICADO-POSTMAN**: visto en la colección.
> - **VERIFICADO-CERT**: visto en el documento de certificación.
> - **VERIFICADO-CODIGO**: leído en el repo.
> - **INFERIDO**: deducción nuestra. Nunca se presenta como contrato.
>
> **Línea base de arquitectura que asume este documento.** La elección final se toma en [08](./08-requisitos-maestro.md):
>
> - código de proveedor `tbo-hotels`;
> - ACL en `providers/tbo-hotels`;
> - vertical de hoteles generalizada a multi-proveedor, con un contrato neutral de hotel fuera del ACL de Despegar y una referencia de proveedor en la oferta.
>
> Donde una conclusión depende de esta línea base, se indica qué cambia si se elige la alternativa: un módulo TBO paralelo.

---

## 0. Resumen

1. **`Search` solo busca por códigos de hotel TBO.** Recibe `HotelCodes` como un único string separado por comas y recomienda hasta 100 códigos. No acepta ciudad, coordenadas, idioma ni moneda, y el PDF no documenta ningún filtro por nombre (pp. 10–11, VERIFICADO-PDF; Postman envía un `Filters.HotelName` no documentado, §2.1). El destino se resuelve antes con nuestro inventario ([05](./05-contenido-estatico-e-inventario.md)).
2. **Cada elemento de `HotelResult[].Rooms[]` es una combinación que cubre todas las habitaciones pedidas.** Lleva un solo `BookingCode` y un solo `TotalFare`. `Name`, `RoomPromotion` y `Supplements` traen un elemento por habitación (pp. 13, 16–18, VERIFICADO-PDF). Encaja con `HotelRoompack` del repo, que ya es "Combinación bookable de habitaciones con un único precio" (`providers/despegar-hotels/src/types.ts:73`). El token de reserva, en cambio, va a nivel de pack y no de habitación.
3. **La moneda no se pide: la fija el perfil de la credencial** (`Currency`: "Configured currency in the API profile of the client", p. 13). Hoy `HotelsService` manda la moneda del tenant (`apps/api/src/hotels/hotels.service.ts:109`), y TBO la ignoraría. Hace falta una puerta de moneda como la de vuelos (§8).
4. **`GuestNationality` cambia la tarifa y TBO recomienda encarecidamente no fijarla en código, y declina toda responsabilidad si se hace** (p. 71). Que cambie la tarifa es INFERIDO del aviso de "operational/financial issues". El flujo actual no la captura en ningún sitio, y el CRM la guarda en alfa-3 (§5).
5. **`IsDetailedResponse: false` es la recomendación de TBO** (p. 71). Con `false`, Search no trae `DayRates` ni `CancelPolicies`: el desglose y las políticas detalladas solo se piden con `true` (p. 11) y ningún ejemplo de respuesta los trae (pp. 15–18; que esos ejemplos se generaran con `false` es INFERIDO, §6.2). Las políticas vinculantes son las de PreBook (p. 71).
6. **`RecommendedSellingRate` es un precio mínimo de venta** ("The B2C client cannot sell the room at a rate lower…", p. 13). El pricing waterfall de `apps/api/src/pricing` no conoce pisos (§9.5).
7. **Los suplementos `AtProperty` se pagan en el hotel, pueden venir en otra moneda y hay que mostrarlos antes de reservar** (pp. 14–15, 71). No se suman al total.
8. **`Status.Code` 201 (sin disponibilidad) no es un error.** Es una lista vacía, sin `HotelResult` (p. 18).
9. **Los tipos declarados no coinciden con los reales.** Hay importes que llegan como string, `Supplements` es un array de arrays, y el contenedor se llama `Room(s)` en la tabla pero `Rooms` en el JSON. Los ejemplos de request del PDF no son JSON válido (§2.2, §9.1).
10. **El contrato actual de oferta (`HotelOffer`/`HotelRoompack`) no puede representar varias cosas de TBO sin extenderse.** Faltan, entre otras: referencia de proveedor, suplementos en destino con moneda propia, precio mínimo de venta, ocupación por habitación, vencimiento de la oferta, políticas con fecha absoluta por habitación, traslados y promociones (§13).

---

## 1. Ficha del método

| Aspecto                         | Valor                                                                                                                                                                | Fuente          | Evidencia                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------- |
| Propósito                       | "This method is used to request **room availability**. Some filters and special features can be applied before sending an availability request."                     | p. 10           | VERIFICADO-PDF            |
| Endpoint                        | `POST {BaseURL}/Search`                                                                                                                                              | pp. 7, 10       | VERIFICADO-PDF            |
| Path en Postman                 | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/search` (**minúscula**)                                                                                            | Postman: Search | VERIFICADO-POSTMAN        |
| Auth y cabeceras                | Basic Auth, `Content-Type: application/json`. Detalle en [01](./01-autenticacion-conectividad-y-errores.md)                                                          | p. 7            | VERIFICADO-PDF            |
| Timeout recomendado             | "5-23 Seconds"                                                                                                                                                       | p. 8            | VERIFICADO-PDF            |
| Ventana Search → Book           | "from search to book, the timeout is 30 minutes"                                                                                                                     | p. 8            | VERIFICADO-PDF            |
| Obligatoriedad                  | La tabla tiene solo tres columnas (Parameter, Type, Description), **sin columna de obligatoriedad**. Todo lo que este documento marca como "obligatorio" es INFERIDO | pp. 10–11       | VERIFICADO-PDF            |
| Criterio de destino             | Solo `HotelCodes`. El "Hotel Search Workflow" se implementó en la v2.0 y se deprecó en la v2.1, sin que el documento lo describa                                     | pp. 6, 10–11    | VERIFICADO-PDF            |
| Moneda                          | No se envía. Llega en `HotelResult[].Currency`                                                                                                                       | pp. 10–13       | VERIFICADO-PDF            |
| Idioma                          | No se envía; Search no devuelve textos de contenido                                                                                                                  | pp. 10–11       | VERIFICADO-PDF (ausencia) |
| Datos del hotel en la respuesta | Solo `HotelCode`. Ni nombre, ni estrellas, ni dirección, ni imágenes                                                                                                 | pp. 13–15       | VERIFICADO-PDF (ausencia) |

Casing del path: se usa `/Search`, como en el PDF. Que Postman funcione con `/search` sugiere que el servidor no distingue mayúsculas (INFERIDO), pero nuestro cliente no depende de eso.

---

## 2. Request

### 2.1 Campo por campo

| Ruta JSON                 | Tipo declarado (PDF) | Tipo real (ejemplos PDF / Postman)                                                  | ¿Obligatorio?                                  | Regla literal                                                                                                                                                                 | Fuente                     | Evidencia                           |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| `CheckIn`                 | String               | string `"2021-07-16"` / `"2025-11-20"`                                              | Sí (INFERIDO)                                  | "Format: YYYY-MM-DD"                                                                                                                                                          | p. 10; Postman: Search     | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `CheckOut`                | String               | string                                                                              | Sí (INFERIDO)                                  | "Format YYYY-MM-DD"                                                                                                                                                           | p. 10                      | VERIFICADO-PDF                      |
| `HotelCodes`              | String               | CSV sin espacios: 1 código en el PDF y 13 en Postman                                | Sí (INFERIDO: es el único criterio de destino) | "List of TBOH codes of the requested hotels (comma separated list)". "Recommended Value; 100 hotel codes"                                                                     | p. 10; Postman: Search     | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `GuestNationality`        | String               | `"AE"` en todos los ejemplos                                                        | Sí (INFERIDO)                                  | "Lead guest nationality (in ISO 3166-1 alpha-2 letter country codes)". "(If Guest is resident of UAE and searching for UAE hotels then guest can send his nationality as AE)" | pp. 10–12; Postman: Search | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `PaxRooms`                | Array                | array de objetos, uno por habitación                                                | Sí (INFERIDO)                                  | "Contains an array of occupancy for each room"                                                                                                                                | p. 10                      | VERIFICADO-PDF                      |
| `PaxRooms[].Adults`       | Integer              | number                                                                              | Sí (INFERIDO)                                  | "Number of Adult guests (1-8) per room"                                                                                                                                       | p. 10                      | VERIFICADO-PDF                      |
| `PaxRooms[].Children`     | Integer              | number; Postman envía `0`                                                           | Condicional                                    | "Number of Child guests (1-4) per room"                                                                                                                                       | p. 11; Postman: Search     | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `PaxRooms[].ChildrenAges` | Integer (Array)      | array de number; Postman envía `[0]` con `Children: 0`                              | Condicional                                    | "List of children ages (0-18 years). The length of array is equal to the number of children in the room. E.g.: [2, 8] if request contains 2 children."                        | p. 11; Postman: Search     | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `ResponseTime`            | Integer              | number escrito como decimal: `23.0` en el PDF, `20.0` en Postman                    | No declarado                                   | "Expected response time (seconds)"                                                                                                                                            | pp. 11–12; Postman: Search | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `IsDetailedResponse`      | Boolean              | `false` en el PDF, `true` en Postman                                                | No (tiene default)                             | "To get additional details in the search response like the day-wise break-up and detailed cancel policies. Default Value; False"                                              | p. 11; Postman: Search     | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `Filters`                 | Object               | objeto, presente en todos los ejemplos                                              | No declarado                                   | "Refine the search response"                                                                                                                                                  | p. 11                      | VERIFICADO-PDF                      |
| `Filters.Refundable`      | Boolean              | `false` en el PDF, `true` en Postman                                                | No (tiene default)                             | "Set it True in case only Refundable rooms are required. Default Value; False"                                                                                                | pp. 11–12; Postman: Search | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `Filters.NoOfRooms`       | Integer              | `0` (una habitación) y `2` (dos habitaciones) en el PDF; `0` en Postman             | No declarado                                   | "Filter for the maximum number of rooms client wants to receive in the response."                                                                                             | pp. 11–12; Postman: Search | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `Filters.MealType`        | Enumeration          | **string** `“All”` (con comillas tipográficas) en el PDF; **entero** `0` en Postman | No declarado                                   | "Possible Values. All, WithMeal and RoomOnly,"                                                                                                                                | pp. 11–12; Postman: Search | VERIFICADO-PDF / VERIFICADO-POSTMAN |
| `Filters.OrderBy`         | —                    | `0`                                                                                 | —                                              | **No documentado**                                                                                                                                                            | Postman: Search            | VERIFICADO-POSTMAN                  |
| `Filters.StarRating`      | —                    | `0`                                                                                 | —                                              | **No figura en la tabla de Search.** Existe la enumeración `StarRating` (`All`, `OneStar` … `FiveStar`)                                                                       | Postman: Search; pp. 69–70 | VERIFICADO-POSTMAN / VERIFICADO-PDF |
| `Filters.HotelName`       | —                    | `null`                                                                              | —                                              | **No documentado**                                                                                                                                                            | Postman: Search            | VERIFICADO-POSTMAN                  |

No existe ningún parámetro de ciudad o destino, coordenadas, idioma, moneda, categoría (fuera del `StarRating` no documentado) ni referencia de cliente (pp. 10–11, VERIFICADO-PDF por ausencia).

### 2.2 Ejemplos del contrato

**Ejemplo del PDF, 6.1.2 (varias habitaciones), p. 12.** Transcrito completo, con los espacios compactados. **No es JSON válido**:

```json
{
 "CheckIn": "2021-07-16",
 "CheckOut": "2021-07-17",
 "HotelCodes": "1247101",
 "GuestNationality": "AE",
 "PaxRooms": [
   { "Adults": 3, "Children": 1, "ChildrenAges": [ 1 ] },
   { "Adults": 1, "Children": 1, "ChildrenAges": [ 1 ] }
 ],
 "ResponseTime": 23.0,
 "IsDetailedResponse": false,
 "Filters": {
   "Refundable": false,
   "NoOfRooms": 2,
   "MealType": “All”
 }
```

Defectos (p. 12, VERIFICADO-PDF):

- `“All”` va con comillas tipográficas (U+201C/U+201D).
- Falta la llave que cierra el objeto raíz.

El ejemplo 6.1.1 (una habitación, pp. 11–12) tiene los mismos dos defectos. Ninguno de los dos sirve como fixture sin corregirlo.

**Postman: Search**, cuerpo literal reformateado (VERIFICADO-POSTMAN):

```json
{
  "CheckIn": "2025-11-20",
  "CheckOut": "2025-11-24",
  "HotelCodes": "376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547",
  "GuestNationality": "AE",
  "PaxRooms": [{ "Adults": 1, "Children": 0, "ChildrenAges": [0] }],
  "ResponseTime": 20.0,
  "IsDetailedResponse": true,
  "Filters": {
    "Refundable": true,
    "NoOfRooms": 0,
    "MealType": 0,
    "OrderBy": 0,
    "StarRating": 0,
    "HotelName": null
  }
}
```

Este request tiene cinco rasgos que no hay que copiar:

- fechas ya pasadas respecto de hoy (2026-09-23);
- `ChildrenAges: [0]` con cero niños, lo que contradice la regla de longitud de p. 11;
- `MealType` como entero;
- tres filtros no documentados;
- `IsDetailedResponse: true`, en contra de la recomendación de p. 71.

### 2.3 Request que construye nuestro ACL (propuesta)

El siguiente request es INFERIDO: aplica las reglas S-01 a S-06 de este documento.

```json
{
  "CheckIn": "2026-11-20",
  "CheckOut": "2026-11-24",
  "HotelCodes": "1120548,1247101,1435427",
  "GuestNationality": "CO",
  "PaxRooms": [
    { "Adults": 2, "Children": 1, "ChildrenAges": [7] },
    { "Adults": 1, "Children": 0, "ChildrenAges": [] }
  ],
  "ResponseTime": 10,
  "IsDetailedResponse": false,
  "Filters": { "Refundable": false, "NoOfRooms": 0, "MealType": "All" }
}
```

- `ResponseTime: 10` es el valor por defecto de la opción recomendada de D-TBO-17 ([08](./08-requisitos-maestro.md) §7.4; §6.1).
- `ChildrenAges: []` en una habitación sin niños es la forma que cumple la regla de longitud de p. 11. TBO no la confirma: la estrategia queda configurable en el ACL (`emptyChildrenAges: 'empty-array' | 'omit' | 'zero'`) hasta que la valide la certificación → [Q-13](./10-preguntas-para-tbo.md#q-13).
- `ResponseTime` se serializa como número (`JSON.stringify(10)` produce `10`). La diferencia entre `10` y `10.0` no existe en JSON; el "Integer" de la tabla y el `23.0` de los ejemplos no generan conflicto para nosotros (INFERIDO).

**Reglas del ACL para construir el request:**

- **S-01.** `HotelCodes` se envía como un único string CSV: sin espacios, deduplicado, con códigos que no contienen comas, y con como mucho `maxHotelCodesPerRequest` códigos (100 por defecto; p. 10).
- **S-02.** No se envían `Filters.OrderBy`, `Filters.StarRating` ni `Filters.HotelName` mientras TBO no los documente (Postman: Search). Filtrar por estrellas o nombre es trabajo nuestro, sobre el contenido estático ([05](./05-contenido-estatico-e-inventario.md)).
- **S-03.** `Filters.MealType` se envía como string del enum (`"All"`, `"WithMeal"` o `"RoomOnly"`), nunca como ordinal (p. 11).
- **S-04.** `IsDetailedResponse: false` en todo listado (p. 71). Ver §6.2 para el detalle de un hotel.
- **S-05.** `GuestNationality` es siempre la del huésped líder, en ISO 3166-1 alfa-2 y mayúsculas. Nunca se toma un valor por defecto silencioso (§5).
- **S-06.** `PaxRooms` conserva el orden en que el vendedor cargó las habitaciones. `Children` es igual a la longitud de `ChildrenAges` (§3).

---

## 3. Ocupación: `PaxRooms`

### 3.1 Reglas del contrato frente a nuestro borde HTTP actual

| Regla                     | TBO                                                                                      | Borde actual (`apps/api/src/hotels/hotels.schemas.ts`) | Postura                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adultos por habitación    | 1–8 (p. 10)                                                                              | `adults` 1–8 (`:8`)                                    | Coinciden (VERIFICADO-PDF / VERIFICADO-CODIGO)                                                                                                                                                                                                                                                                                                         |
| Niños por habitación      | "(1-4)" (p. 11); el 0 es imprescindible para habitaciones solo de adultos (Cert, caso 1) | hasta 6 edades (`childrenAges … .max(6)`, `:9`)        | Si una habitación trae 5 o 6 niños, **TBO queda fuera de esa búsqueda con un motivo visible** ("TBO admite hasta 4 niños por habitación"). No se trunca ni se reparte la ocupación                                                                                                                                                                     |
| Edad de niño              | 0–18 (p. 11)                                                                             | 0–17 (`:9`)                                            | Nuestro borde es más estricto: para nosotros 18 años es adulto. No hay conflicto. Queda la duda de si TBO considera niño a un menor de 18 → [Q-14](./10-preguntas-para-tbo.md#q-14)                                                                                                                                                                    |
| Habitaciones por búsqueda | **No documentado** (pp. 10–12, por ausencia)                                             | 1–8 (`rooms … .max(8)`, `:28`)                         | La certificación llega a 2 habitaciones (Cert, casos 4–6). El tope es un parámetro del ACL, `maxRoomsPerSearch`, que por defecto vale 8 (el del borde). Si TBO devuelve `400` por exceso de habitaciones, se clasifica como error de validación nuestro ([01](./01-autenticacion-conectividad-y-errores.md)) → [Q-14](./10-preguntas-para-tbo.md#q-14) |
| `ChildrenAges` sin niños  | La regla de longitud exige `[]`; Postman envía `[0]`                                     | `childrenAges` con `.default([])` (`:9`)               | Estrategia configurable (§2.3) → [Q-13](./10-preguntas-para-tbo.md#q-13)                                                                                                                                                                                                                                                                               |
| Edad de infante           | No existe el concepto: un bebé es un niño de edad 0 (p. 11)                              | No hay infantes en hoteles                             | El canónico `PaxCount` (`packages/canonical/src/pax.ts:42-51`) separa infantes. Lo usa `HotelStaySchema.occupancy` (`packages/canonical/src/hotel.ts:135`), pero la vertical de hoteles actual (`HotelsService` y el ACL de Despegar) no usa ninguno de los dos (VERIFICADO-CODIGO). No hay nada que mapear                                            |

### 3.2 Traducción

`RoomDistribution { adults, childrenAges[] }` (`providers/despegar-hotels/src/types.ts:94-97`) se traduce a:

```
PaxRooms[j] = {
  Adults:       rooms[j].adults,
  Children:     rooms[j].childrenAges.length,
  ChildrenAges: rooms[j].childrenAges
}
```

### 3.3 El orden de las habitaciones es contrato

Los índices por habitación de la respuesta dependen del orden en que se enviaron las habitaciones en el request. Así lo dicen `Name` ("first element represents the first room", p. 13), `RoomPromotion` (p. 14) y `Supplements[][].Index` (p. 14). Por el mismo orden, el Book asocia `CustomerDetails[j]` con la habitación `j` ([03](./03-prebook-y-book.md)). El caso 6 de la certificación (Room 1: 1 adulto y 2 niños; Room 2: 2 adultos) es asimétrico, lo que permite comprobarlo (Cert; que ese sea su propósito es INFERIDO). Por eso:

- el ACL nunca reordena `PaxRooms`;
- la oferta guarda la ocupación de cada habitación (falta en el contrato actual, ver §13).

### 3.4 Pruebas de certificación

Los casos 1 a 6 de la certificación se convierten en tests del builder: la ocupación de entrada y el `PaxRooms` exacto de salida (Cert; detalle en [07](./07-certificacion.md)).

---

## 4. `HotelCodes`: tope de 100, los 50 de hoy, lotes y fan-out

### 4.1 Hechos

| Hecho                                                                                                                                                                                                                                                                                                                                                              | Fuente                                                                                                                                          | Evidencia         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| TBO recomienda 100 códigos por request. No dice si más de 100 se rechaza                                                                                                                                                                                                                                                                                           | p. 10                                                                                                                                           | VERIFICADO-PDF    |
| El límite de QPS existe (`429 LIMIT_EXCEEDED`), pero su valor no se publica                                                                                                                                                                                                                                                                                        | p. 9                                                                                                                                            | VERIFICADO-PDF    |
| Hoy `resolveCityHotelIds(cityId, limit = 50)` devuelve los primeros 50 `hotel_id` de la ciudad **ordenados por id**, filtrando `provider_code = 'despegar-hotels'`                                                                                                                                                                                                 | `apps/api/src/hotels/hotels.service.ts:131-141`                                                                                                 | VERIFICADO-CODIGO |
| El borde acepta hasta 100 `hotelIds` explícitos                                                                                                                                                                                                                                                                                                                    | `apps/api/src/hotels/hotels.schemas.ts:26`                                                                                                      | VERIFICADO-CODIGO |
| El contrato de Despegar documenta "hasta 100 (50 recomendado)"                                                                                                                                                                                                                                                                                                     | `providers/despegar-hotels/src/types.ts:103`                                                                                                    | VERIFICADO-CODIGO |
| `provider-fanout.ts` tiene un fan-out con degradación parcial (`fanOut`, que usa vuelos) y una deduplicación genérica (`dedupeCheapest`) cuyo comentario anticipa "hotel+roompack en hoteles". `dedupeCheapest` hoy solo se usa en tests: vuelos deduplica con `dedupeFlightOffers`, que no deduplica nada si hay más de una moneda y corre antes de `withPricing` | `apps/api/src/search/provider-fanout.ts:27-50`, `:52-59`; `apps/api/src/search/offer-dedupe.ts:63`; `apps/api/src/search/search.service.ts:305` | VERIFICADO-CODIGO |

### 4.2 Problemas del estado actual para TBO

1. **El tope de 50 es global y está atado a Despegar** (`PROVIDER_CODE`, `hotels.service.ts:24`, `:135`). Con TBO, el tope tiene que ser **por proveedor**, porque cada proveedor tiene su propio espacio de códigos en `hotel_inventory` ([05](./05-contenido-estatico-e-inventario.md), [06](./06-seams-integracion-repo.md)).
2. **Ordenar por id elige 50 hoteles arbitrarios.** Es determinista, pero en una ciudad con cientos de hoteles TBO deja fuera hoteles relevantes sin criterio comercial. Esto es INFERIDO: el tamaño real del catálogo por ciudad se mide al sincronizar ([05](./05-contenido-estatico-e-inventario.md)).
3. **Los `hotelIds` explícitos del borde no dicen de qué proveedor son.** En multi-proveedor, un id explícito tiene que llegar con su proveedor, o bien restringir la búsqueda a un proveedor ([06](./06-seams-integracion-repo.md)).

### 4.3 Diseño propuesto (INFERIDO)

**En el servicio (contrato neutral).**

- Por cada proveedor activo, `resolveCityHotelIds(providerCode, cityId, limit)` usa un límite que declara el propio proveedor: `maxHotelCodesPerSearch`.
- El orden deja de ser por id y pasa a ser por relevancia, según la columna que defina [05](./05-contenido-estatico-e-inventario.md) (por ejemplo estrellas, y el id solo como desempate).

**En el ACL TBO (`search()`).**

1. Recibe cualquier cantidad de códigos, los deduplica y los divide en lotes de como mucho `maxHotelCodesPerRequest` (100).
2. Lanza los lotes con una **concurrencia acotada** (`searchConcurrency`, 1 por defecto mientras no se conozca el QPS) y un **único deadline** para toda la búsqueda: `ResponseTime` + margen (§6.1).
3. Interpreta cada lote por su cuenta:
   - `200`: sus `HotelResult[]` se suman al resultado;
   - `201`: el lote queda vacío, y eso no es un fallo;
   - cualquier otro código: fallo de ese lote.
4. Resultado combinado:
   - si al menos un lote respondió y otros fallaron, el ACL devuelve lo obtenido y un aviso `partial` que llega al vendedor, igual que `failed[]` en el fan-out de vuelos. Nunca se devuelve un resultado incompleto en silencio (`provider-fanout.ts:22-25`). Hoy la respuesta de hoteles es solo `{ hotels }` y no tiene dónde llevar ese aviso (`apps/api/src/hotels/hotels.controller.ts:70-72`);
   - si fallaron todos los lotes, falla el proveedor.
5. Circuit breaker: un lote con `201` no cuenta como fallo. Un `400` no abre el circuito (es un error nuestro), pero sí dispara una alerta ([01](./01-autenticacion-conectividad-y-errores.md)). Hoy `CircuitBreakerService.execute` cuenta como fallo cualquier excepción (`apps/api/src/search/circuit-breaker.service.ts:90-91`), así que esto exige el predicado de fallo de [06](./06-seams-integracion-repo.md) (G12).
6. La cuota de búsquedas (`telemetry.assertWithinQuota`, `hotels.service.ts:88`) cuenta **una** búsqueda aunque haya N lotes. La telemetría registra `hotelCount` con el total de códigos.

La cobertura por búsqueda (cuántos códigos se piden a TBO) es una decisión de producto: ver **D02-3** en §12.

### 4.4 Tramos: "Ver más hoteles" (APLICADO, 2026-09-30)

**Por qué.** Con §4.3 aplicado (D-TBO-17 A), una búsqueda por destino le pedía a cada proveedor sólo los primeros `maxHotelsPerSearch` códigos de su catálogo: 100 en TBO, 50 en Despegar. Una ciudad como Cartagena o Medellín tiene cientos de hoteles en `hotel_inventory`, y el vendedor veía sólo los que salían de esos 100, sin nada que le dijera que había más. El founder lo reportó el 2026-09-30: "tampoco veo más páginas para seguir".

**Regla.** La búsqueda por destino se consulta por **tramos**: el primero es la búsqueda de siempre y cada tramo siguiente es otro `Search` con los códigos que siguen, a pedido del vendedor.

1. **Qué códigos y en qué orden.** Al buscar, el API lee de una vez los códigos de hasta **20 tramos** de cada proveedor (`maxHotelsPerSearch × 20`: 2.000 en TBO, 1.000 en Despegar) en el orden de su catálogo, y cuenta los activos del destino con `count(*) over ()` en la misma consulta, que Postgres calcula antes del `limit` (`HotelsService.resolveProviderCityHotelIds` / `resolveCityHotelIds`). El orden `relevance` pasa a ser: estrellas de mayor a menor (sin estrellas al final), después los que ya tienen foto en `hotel_content` y el `hotel_id` como desempate. Así el primer tramo es el mejor que se puede armar con lo que hay: la demanda por hotel no entra porque no hay dónde leerla sin cruzar tenants (las órdenes van con RLS y `search_logs` cuenta ciudades). Despegar sigue ordenando por `hotel_id` (09 PR-0.5).
2. **La búsqueda se guarda en el servidor** (`HotelSearchPagingStore`), por `(tenantId, sessionId)`, validada con Zod al entrar y al salir, durante **30 minutos** desde el primer tramo (algo más que la ventana de 27 min de las tarifas, RF-09); seguir cargando no lo estira. Guarda la búsqueda tal como la validó el borde, sin `hotelIds` y **con la moneda y el país de venta ya resueltos** (los que vinieron o los de la agencia en ese momento), y por proveedor sus códigos y por dónde va. Guarda PII (edades y nacionalidad): nada de esto va a un log. Para que la memoria no crezca con búsquedas que nadie retoma: los códigos de cada proveedor se guardan en un solo texto (~25 KB por búsqueda con 2.000 + 1.000 códigos), la instancia del `CachePort` tiene su propio techo de **1.000** búsquedas (`HotelSearchPagingMemoryCache`; llegado a él se desalojan las más viejas, que piden buscar de nuevo) y el adapter en memoria barre lo vencido al escribir, como mucho una vez por minuto (`MemoryCacheAdapter`, también para los contextos de búsqueda).
3. **El tramo siguiente** es `POST /hotels/availability/more` con `{ sessionId, page }` (`.strict()`): fechas, ocupación, moneda, país de venta y nacionalidad salen de lo guardado, así que un tramo nunca busca otra cosa que el primero aunque la agencia cambie su moneda por defecto a mitad de camino. Pasa por lo mismo que la búsqueda y en el mismo orden: moneda y markup (las reglas se vuelven a leer; si la moneda del primer tramo ya no se puede usar o el markup ya no la admite, 409 `SEARCH_PAGING_EXPIRED` con "Tu agencia cambió su moneda o su markup desde esta búsqueda…", en lugar de sumar precios de otra moneda a la misma lista), cuota de la agencia (cada tramo cuenta como una búsqueda: es otro `Search` que TBO cobra), proveedores activos, circuito, limitador del cupo de ventas de la cuenta y telemetría, con `page` y `hotelCount` en el criterio reducido. Es una operación de venta (`@SalesOperation`). Responde el mismo sobre que la búsqueda, con sólo los hoteles de ese tramo. A la búsqueda le tienen que quedar al menos **2 minutos** para empezar un tramo (`HOTEL_SEARCH_PAGING_MIN_LEFT_MS`): con menos, un `Search` más la espera del limitador terminaría con la búsqueda vencida después de gastar la consulta y la cuota, así que se responde vencida antes.
4. **Sin repetir.** Sólo se acepta el tramo que sigue. Un doble clic espera el MISMO `Search`, y el **último** tramo cargado, pedido otra vez durante **2 minutos** (`HOTEL_SEARCH_PAGE_REPLAY_MS`), devuelve la misma respuesta sin consultar a nadie ni gastar cuota: es la respuesta que se cortó en el camino (la red del teléfono de un vendedor en ruta). Vive en la memoria del proceso, con techo de 50. Pasado ese rato, o un tramo anterior, es 409 `SEARCH_PAGE_NOT_NEXT` con `details.nextPage` y `details.paging` (cuánto se consultó de verdad), para que la pantalla se ponga al día y ofrezca seguir: esos hoteles se ven buscando de nuevo. Uno salteado, lo mismo. Sin tramos por consultar, 409 `SEARCH_PAGING_EXHAUSTED`; vencida, perdida o de otro tenant, 409 `SEARCH_PAGING_EXPIRED` (la misma respuesta en los tres casos).
5. **Cursor por proveedor.** Cada proveedor avanza por su cuenta según su parte en la respuesta (`hotel-search-paging.ts`): respondió, con hoteles o sin ellos (`201`), entero o en parte → avanza; falló → no avanza y su tramo sale en el siguiente "Ver más" (si fallaron todos, 502 y el mismo tramo se puede reintentar); de respaldo que no hizo falta → se le pide después; respondió en otra moneda o dejó de estar activo para la agencia → no se le pregunta más en esta búsqueda y su parte lo dice. Las olas de respaldo (`callPolicy: 'fallback'`) se aplican en cada tramo igual que en la búsqueda.
6. **Reserva.** Cada tramo es un `Search` con su propio `searchId` y deja su contexto como cualquier búsqueda (RF-08): una tarifa de cualquier tramo se revalida y se reserva con el contexto de SU búsqueda, y vence a los 27 minutos de SU `Search`.
7. **La respuesta** lleva `paging` (sólo en búsquedas por destino): `{ sessionId?, page, consulted, total, hasMore, nextBatch? }`, sumando proveedores. `total` es el catálogo entero aunque pase el tope de 20 tramos: "2.000 de 3.400" dice la verdad, y sin `hasMore` la pantalla explica que no se puede seguir en esta búsqueda. Si la búsqueda no se puede guardar, los hoteles salen igual, sin `sessionId`.

**Pantalla (web-b2b).** Al final de la lista, un pie con cuánto del destino se consultó ("Consultamos 100 de 420 hoteles de Cartagena de Indias.") y un medidor con un segmento por tramo consultado y el siguiente marcado; "Ver más hoteles" trae el tramo siguiente y lo **suma** a la lista, y filtros y orden corren sobre todo lo cargado. Mientras llega, el segmento siguiente lleva el barrido de la espera de la búsqueda y tres mensajes se turnan, en chico (`hotel-results-pager.tsx`). La lista se pinta de a 20 ("Mostrar 20 más", sin volver a consultar) y crece hacia abajo: el foco va a la primera tarjeta nueva y la página no salta; "Ver más hoteles" aparece cuando ya se ve todo lo que llegó. Un tramo que llega se reparte según el orden elegido (con "Recomendados" va al final; con "Menor precio" puede quedar arriba de todo): nada de lo que ya se veía se vuelve a esconder, el foco va al primer hotel **nuevo** en el orden actual, los nuevos llevan la marca "Nuevo" hasta el tramo siguiente y el anuncio cuenta los que cumplen los filtros y, si no quedaron al final, dónde quedó el primero ("Llegaron 67 hoteles más; 12 cumplen tus filtros. Con el orden «Menor precio», el primero quedó en el puesto 1."). Un tramo sin disponibilidad, uno con un proveedor que falló, una respuesta perdida que ya no se puede repetir, el fin del destino y una búsqueda vencida ("Buscar de nuevo") se dicen en el mismo pie; a un lector de pantalla, por una sola vía (los errores, con `role="alert"` en el pie; lo demás, por una región viva). Si el primer tramo no trajo hoteles, el estado vacío no dice "no hay disponibilidad": dice cuántos se consultaron y ofrece los siguientes. Decisiones: **no hay carga automática** al llegar al final (cada tramo es un `Search` pagado y cuenta en la cuota; con un filtro que deja pocos hoteles a la vista, el final siempre está a la vista y encadenaría consultas), y **nada va a la URL** (la búsqueda no viaja por la URL y al recargar no hay resultados que retomar).

**Pendiente.** Con Despegar y TBO activos, el mismo hotel puede llegar en tramos distintos de cada uno: se agrupa sólo dentro de un tramo (§9.2 de [05](./05-contenido-estatico-e-inventario.md)), y "100 de 420" suma los catálogos de los dos. Hoy producción opera sólo con TBO.

---

## 5. `GuestNationality`

### 5.1 Qué dice el contrato

- El campo es la nacionalidad del **huésped líder**, en ISO 3166-1 alfa-2 (p. 10).
- Hay una excepción textual para residentes: "(If Guest is resident of UAE and searching for UAE hotels then guest can send his nationality as AE)" (p. 10). Mezcla residencia y nacionalidad, y no dice qué hacer fuera de EAU.
- Key Point 1: "We strongly recommend not to hardcode the guest nationality as this may lead to operational/financial issues. Please note TBO shall not be liable in such case." (p. 71, VERIFICADO-PDF).
- El Book **no** vuelve a enviar la nacionalidad por pasajero (pp. 32–34, VERIFICADO-PDF por ausencia). La tarifa queda atada a la nacionalidad buscada, y TBO no puede detectar el desajuste; lo detecta el hotel en el check-in (INFERIDO).

### 5.2 De dónde la sacamos hoy: de ningún sitio

| Fuente candidata en el repo                                                                      | Estado                                                                                                                        | Evidencia                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formulario de búsqueda de hoteles (web B2B)                                                      | Envía `checkinDate`, `checkoutDate`, `rooms`, `hotelIds`/`destinationId` y `refundableOnly`. **No hay campo de nacionalidad** | `apps/web-b2b/src/app/(app)/hoteles/actions.ts:169-172` (VERIFICADO-CODIGO)                                                                                                                                        |
| `countryCode` del borde                                                                          | Es el país del punto de venta de Despegar. Si no llega, se usa `tenants.country_code`                                         | `hotels.schemas.ts:29`; `hotels.service.ts:112`, `:201-214` (VERIFICADO-CODIGO)                                                                                                                                    |
| Cliente del CRM (`customers.nationality`) y sus acompañantes (`customer_passengers.nationality`) | `VARCHAR(3) NOT NULL` en las dos tablas. El DTO acepta texto libre de 2 a 60 caracteres y la UI propone `'COL'` (**alfa-3**)  | `db/migrations/0010_sprint1_core_suite.sql:19`; `db/migrations/0024_crm_travel_suite.sql:26`; `apps/api/src/customers/dto.ts:23`; `apps/web-b2b/src/app/(app)/clientes/ClientesClient.tsx:180` (VERIFICADO-CODIGO) |
| Huéspedes del Book de Despegar                                                                   | `travelers[].nationality` alfa-2, opcional. Llega recién en el Book, después de buscar                                        | `apps/api/src/hotels/hotels.schemas.ts:77` (VERIFICADO-CODIGO)                                                                                                                                                     |
| Canónico `Pax.nationality`                                                                       | `CountryCodeSchema`, alfa-2 en mayúsculas                                                                                     | `packages/canonical/src/pax.ts:31`; `packages/validation/src/index.ts:12-15` (VERIFICADO-CODIGO)                                                                                                                   |
| WhatsApp / IA                                                                                    | No hay flujo de hoteles                                                                                                       | —                                                                                                                                                                                                                  |

### 5.3 Postura

1. **Usar el país del tenant (`tenants.country_code`) como nacionalidad es fijarla en código**, solo que por tenant. Una agencia colombiana también vende a clientes venezolanos, argentinos o estadounidenses. No se hace.
2. **Lo mismo vale para una nacionalidad por credencial** (`config.guestNationality`). El dossier de la bóveda la proponía como clave de config segura; este documento recomienda **no** usarla como valor enviado. Como mucho, puede servir para **prellenar** el campo, que sigue visible y editable (**D02-1**).
3. **El contrato neutral de búsqueda lleva `guestNationality` (alfa-2).** Los proveedores que la necesitan lo declaran como capacidad (`requiresGuestNationality`). Si falta y TBO está activo:
   - TBO queda fuera de esa búsqueda con un motivo visible ("indicá la nacionalidad del pasajero principal para ver tarifas de TBO", con el voseo que usa el resto de mensajes al vendedor);
   - el resto de los proveedores sigue buscando.
4. **Conversión alfa-3 → alfa-2** cuando la nacionalidad se prellena desde un cliente del CRM. Se usa una tabla ISO 3166 estática en `packages/validation` (INFERIDO). Un valor que no convierte, por ser texto libre heredado del DTO, no se envía: se pide al vendedor.
5. **La nacionalidad forma parte del contexto de búsqueda que se guarda con el `BookingCode`** (§9.3). Si en el Book el pasajero principal tiene otra nacionalidad, se vuelve a buscar, sin intentar reservar con una tarifa de otra nacionalidad. Esta es una postura defensiva: el contrato no la exige → [Q-17](./10-preguntas-para-tbo.md#q-17) sobre el efecto del desajuste y sobre residencia frente a nacionalidad.
6. **WhatsApp e IA:** el agente pide la nacionalidad antes de buscar. El prefijo telefónico no se usa para deducirla.
7. **Logs:** la nacionalidad es un dato personal. Se registra en telemetría solo en forma agregada, nunca junto a nombres. No entra en el `criteria` de `search_logs` que arma `hotels.service.ts:97-102`: ese campo es "Criterio REDUCIDO. Nunca datos de pasajero ni del cliente final" (`apps/api/src/search/search-telemetry.service.ts:45`).

---

## 6. `ResponseTime`, timeouts e `IsDetailedResponse`

### 6.1 `ResponseTime` y timeout HTTP

- El contrato solo da dos datos: "Expected response time (seconds)" (p. 11) y el timeout recomendado de Search, "5-23 Seconds" (p. 8). No explica qué hace TBO con el valor: si corta la agregación de sus propios proveedores al llegar a ese tiempo, o si responde con lo que tiene (→ [Q-16](./10-preguntas-para-tbo.md#q-16)).
- **Postura (INFERIDO; unificada en [08](./08-requisitos-maestro.md) §9 C-01):**
  - `ResponseTime` es configurable en el ACL (`searchResponseTimeSec`), con un rango permitido de 5 a 20. El valor por defecto lo fija D-TBO-17; con la opción recomendada es 10.
  - El timeout HTTP del cliente es `ResponseTime + 3 s`, nunca más de 23 s, para no salir del "5-23 Seconds" de p. 8. Con el valor por defecto sale 13 s ([01](./01-autenticacion-conectividad-y-errores.md) §5.2-§5.3).
  - Con esto una búsqueda nunca bloquea más de 23 s, compatible con "tiempo a venta < 2 minutos" (`CLAUDE.md`). La certificación mide el mismo Search con 10 y con 20 s (D-TBO-17 A).
  - Search no mueve dinero. La política de reintentos y la clasificación de errores de red están en [01](./01-autenticacion-conectividad-y-errores.md).

### 6.2 `IsDetailedResponse`

- Con `true` se reciben "the day-wise break-up and detailed cancel policies" (p. 11). Key Point 2: "It is strongly recommended to pass IsDetailedResponse as 'False', as it will decrease the overall response size and time." (p. 71). Ningún ejemplo de respuesta de Search incluye `DayRates` ni `CancelPolicies` (pp. 15–18, VERIFICADO-PDF por ausencia). Que se generaran con `false` es INFERIDO: ningún ejemplo de respuesta muestra su request, y los ejemplos de request (con `false`) piden otro hotel, `1247101` frente a `1120548` (pp. 11–12, 15–16).
- Key Point 3: "Cancellation Policy and Norms received in the PreBook response will be considered as final for the booking itinerary." (p. 71). Aunque se pidan con `true`, las políticas de Search son **indicativas**.
- **Postura (INFERIDO; decisión D02-6):**
  - **En el listado**, siempre `false`. Solo se muestra `IsRefundable`.
  - **En el detalle de un hotel** (lo que hoy es `getHotelDetail`, `hotels.service.ts:143-161`), el ACL repite Search con **un único** código y `IsDetailedResponse: true`. Con un solo hotel, el argumento de tamaño de la recomendación de TBO pierde peso, y el vendedor ve las políticas y el desglose por noche antes del PreBook.
  - Ese segundo Search genera **otro** `BookingCode`: el UUID de sesión es distinto (pp. 15–17). El pack que se reserva es el del detalle, no el del listado.
  - Las políticas del detalle se muestran como "sujetas a confirmación" hasta el PreBook ([03](./03-prebook-y-book.md)).

---

## 7. `Filters`

| Filtro       | Documentado                                                                                       | Qué enviamos                                                                                        | De dónde sale                                                          | Postura                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Refundable` | Sí (p. 11)                                                                                        | `refundableOnly ?? false`                                                                           | `hotels.schemas.ts:32` → `hotels.service.ts:115`                       | Traducción directa. TBO solo filtra; `IsRefundable` de cada pack sigue siendo la verdad                                                                                                                                                                                                                                                                       |
| `NoOfRooms`  | Sí, con una semántica ambigua (p. 11)                                                             | `0`                                                                                                 | —                                                                      | "maximum number of rooms client wants to receive": no queda claro si limita el número de `Rooms[]` (opciones) o se refiere a habitaciones. El ejemplo de dos habitaciones envía 2 y el de una envía 0 (p. 12). Enviamos `0`, como Postman y el ejemplo de una habitación, interpretado como "sin límite" (INFERIDO) → [Q-18](./10-preguntas-para-tbo.md#q-18) |
| `MealType`   | Sí, como enum de strings (p. 11). En la sección 17 la enumeración se llama **`MealPlan`** (p. 69) | `"All"`. Si mañana el borde filtra por régimen: `RO` → `"RoomOnly"` y cualquier otro → `"WithMeal"` | El borde actual no tiene filtro de régimen (`hotels.schemas.ts:19-37`) | Siempre string (S-03). El `0` de Postman sugiere que TBO acepta el ordinal (INFERIDO), pero no dependemos de ello                                                                                                                                                                                                                                             |
| `OrderBy`    | **No**                                                                                            | Nada                                                                                                | —                                                                      | No se envía (S-02). Ordenamos nosotros por precio de venta                                                                                                                                                                                                                                                                                                    |
| `StarRating` | **No** en Search. Hay un enum en pp. 69–70                                                        | Nada                                                                                                | —                                                                      | No se envía. Filtramos nosotros con las estrellas del contenido estático ([05](./05-contenido-estatico-e-inventario.md))                                                                                                                                                                                                                                      |
| `HotelName`  | **No**                                                                                            | Nada                                                                                                | —                                                                      | No se envía. La búsqueda por nombre se resuelve con nuestro inventario, que da el `HotelCode`                                                                                                                                                                                                                                                                 |

---

## 8. Moneda

### 8.1 Qué dice el contrato

- El request no tiene campo de moneda (pp. 10–11).
- `HotelResult[].Currency` es la "Configured currency in the API profile of the client" (p. 13). Todos los importes de un `HotelResult` están en esa moneda (INFERIDO: el PDF no lo dice de forma explícita), **salvo** `Supplements[][].Price`, que trae su propia `Currency`. En el ejemplo, el suplemento viene en `"AED"` y el hotel en `"USD"` (p. 15).
- Consecuencia BYOC (INFERIDO): cada credencial TBO tiene su propia moneda. Una agencia con credencial propia y otra que hereda la del consolidador pueden recibir el mismo hotel en monedas distintas. Es el mismo patrón que LATAM NDC, cuya credencial brasileña cotiza en BRL (memoria del proyecto, 2026-08-27).

### 8.2 Convivencia con la moneda del tenant

| Hecho en el repo                                                                                                                                                                                                                     | Evidencia                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Hoteles envía al proveedor `input.currency ?? tenants.default_currency`, que TBO ignoraría                                                                                                                                           | `hotels.service.ts:109`, `:201-214` (VERIFICADO-CODIGO)                                                               |
| Si el tenant no tiene `default_currency`, hoteles cae a `'USD'` en silencio, y el mapper de Despegar también usa `'USD'` por defecto                                                                                                 | `hotels.service.ts:210`; `providers/despegar-hotels/src/availability/response.mapper.ts:94` (VERIFICADO-CODIGO)       |
| Vuelos tiene una **puerta de moneda**: descarta las ofertas en otra moneda en vez de convertirlas o marcarlas, porque "una tasa inventada convierte un precio real en uno que nadie puede cobrar", y explica el descarte al vendedor | `apps/api/src/search/search.service.ts:70-109`, `:280-287`; el motivo, en `:115-118` y `:328-353` (VERIFICADO-CODIGO) |
| Hoteles no tiene esa puerta                                                                                                                                                                                                          | `hotels.service.ts:73-121` (VERIFICADO-CODIGO)                                                                        |

**Postura (INFERIDO; decisión D02-2):**

1. **Regla S-08.** El ACL TBO **toma la moneda de cada `HotelResult[].Currency`**. Si falta, el `HotelResult` se descarta y se cuenta en una métrica. Nunca se cae a `'USD'`.
2. El criterio de moneda del contrato neutral pasa a ser "moneda de venta de esta búsqueda": por defecto la del tenant y elegible por el vendedor.
3. La vertical de hoteles adopta la misma puerta que vuelos, **en el servicio y no en el ACL**, porque es el único punto que ve juntas las ofertas de todos los proveedores. Si todos los packs de TBO vienen en otra moneda, TBO aparece en `providers[]` con un motivo accionable ("TBO cotiza en USD; esta búsqueda es en COP"), y no como "sin disponibilidad".
4. Los suplementos en otra moneda no pasan por la puerta: no forman parte del precio (§9.7).

### 8.3 `Money` en unidades menores y montos con más de 2 decimales

| Hecho                                                                                                                                                                                                                | Evidencia                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Money = { amountMinor: int ≥ 0, currency }`                                                                                                                                                                         | `packages/canonical/src/money.ts:7-10` (VERIFICADO-CODIGO)                                 |
| `Money.fromMajor` multiplica **siempre por 100** y `toMajor` divide por 100                                                                                                                                          | `money.ts:41-46`, `:48` (VERIFICADO-CODIGO)                                                |
| `fromMajor` lanza un `Error` plano ante un negativo o un no-finito                                                                                                                                                   | `money.ts:42-44` (VERIFICADO-CODIGO)                                                       |
| La web también asume 2 decimales: `formatMoney` divide por 100                                                                                                                                                       | `apps/web-b2b/src/app/(app)/hoteles/_components/hotel-format.ts:17` (VERIFICADO-CODIGO)    |
| TBO manda `BasePrice` con 7–8 decimales (`15.15762150`, `124.7564850`)                                                                                                                                               | pp. 24, 28 (VERIFICADO-PDF)                                                                |
| TBO manda importes como **string** (`ExtraGuestCharges`, `RecommendedSellingRate`)                                                                                                                                   | pp. 13, 15 (VERIFICADO-PDF)                                                                |
| Fuera de Search, TBO usa 3 decimales en USD (`85.822`) y monedas como `KWD` (`25.81`: 2 decimales, aunque su exponente ISO es 3) o `IDR` (`1244728.99`: exponente ISO 2, aunque en la práctica se usa sin decimales) | pp. 26–27, en `CreditCardBillingOptions` de PreBook, que no usamos por D1 (VERIFICADO-PDF) |

**Problemas.**

- Si el perfil de una credencial está en una moneda con exponente ISO 4217 distinto de 2, `fromMajor` produce importes erróneos por un factor de 10 o de 100, y nadie lo nota:
  - exponente 0: por ejemplo `CLP` en nuestro mercado, `JPY` o `KRW`;
  - exponente 3: `KWD`, `BHD`, `OMR`.
- Además, `Math.round(x * 100)` sobre un float binario redondea sin una política declarada.

**Postura (INFERIDO; decisión D02-5):**

1. **Parseo decimal exacto, sin aritmética en float.**
   - Todo importe TBO se acepta como `number` o como string numérico. Los números se pasan a su representación decimal más corta (`String(n)`, el formato de ida y vuelta de JS) y se convierten a unidades menores con aritmética de enteros sobre los dígitos.
   - Si un importe trae más decimales que el exponente de su moneda, se redondea _half-up_ y se incrementa la métrica `tbo.amount_precision_loss`. Esto es lo esperable en `BasePrice`, que es solo informativo.
2. **Se conserva el literal de `TotalFare` tal como llegó.** El Book lo reenvía ("Total fare for the booking", p. 33; [03](./03-prebook-y-book.md)), y el valor reenviado no puede ser nuestra reconstrucción desde unidades menores. El literal viaja en la parte opaca y de servidor del contexto de búsqueda (§9.3), no en el navegador.
3. **Guarda de exponente en el ACL.** Mientras `Money` asuma 2 decimales, si `HotelResult[].Currency` tiene exponente ISO distinto de 2, el ACL no convierte:

   - marca a TBO como no disponible para esa credencial, con un motivo visible y sin nombrar valores de la cuenta;
   - registra una alerta para el dueño de la credencial.

   Generalizar `Money` a exponentes ISO afecta a todas las verticales y queda fuera de TBO.

4. **Nada negativo.** Un importe negativo o no numérico invalida **ese pack**: se descarta y se registra en una métrica. No se tumba la respuesta entera ni se deja escapar un `Error` plano que acabaría en un 500 genérico (§10).

---

## 9. Response

### 9.1 Campo por campo: tipo declarado frente a tipo real

La tabla del PDF es **plana** (Parameter, Type, Description) y sin sangrías. Leída de forma literal, `TotalFare` colgaría de `DayRates` y `MealType` de `CancelPolicies`. Las rutas de abajo salen de los ejemplos: pp. 15–18 para Search, y pp. 24 y 28 para `DayRates` y `CancelPolicies` en PreBook (VERIFICADO-PDF).

| Ruta JSON                              | Tipo declarado                       | Tipo observado                                                                                         | Semántica (literal o resumen)                                                                                                                                               | Fuente            | Evidencia      |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| `Status.Code`                          | Integer                              | number (`200`, `201`)                                                                                  | "Internal code to denote response status." Es la verdad del resultado ([01](./01-autenticacion-conectividad-y-errores.md))                                                  | pp. 13, 15, 18    | VERIFICADO-PDF |
| `Status.Description`                   | String                               | string; con `201` no coincide literalmente con la tabla de estados                                     | "Descriptive message." No se usa en lógica                                                                                                                                  | pp. 9, 13, 18     | VERIFICADO-PDF |
| `HotelResult`                          | Array                                | array; **ausente** con `201`                                                                           | "Information regarding the hotels"                                                                                                                                          | pp. 13, 18        | VERIFICADO-PDF |
| `HotelResult[].HotelCode`              | String                               | string `"1120548"`                                                                                     | "TBOH hotel code"                                                                                                                                                           | pp. 13, 15        | VERIFICADO-PDF |
| `HotelResult[].Currency`               | String                               | `"USD"`                                                                                                | "Configured currency in the API profile of the client."                                                                                                                     | pp. 13, 15        | VERIFICADO-PDF |
| `HotelResult[].Rooms`                  | Array (fila rotulada **`Room(s);`**) | array; la clave JSON es **`Rooms`**                                                                    | "Contains a list of bookable rooms"                                                                                                                                         | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].Name`                        | Array of String                      | array; N elementos si se pidieron N habitaciones                                                       | "In case of multiple rooms first element represents the first room and so on."                                                                                              | pp. 13, 15–16     | VERIFICADO-PDF |
| `…Rooms[].BookingCode`                 | String                               | `"1120548!TB!2!TB!4ee85bb9-…"`                                                                         | "Unique Identifier for each bookable unit." Opaco                                                                                                                           | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].Inclusion`                   | String                               | `"Free WiFi"` (string, no lista)                                                                       | "Inclusion associated with rooms if any"                                                                                                                                    | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].DayRates`                    | List of Array                        | Ausente en Search con `false`. En PreBook es un array de arrays: `[[{"BasePrice":124.7564850}],[{…}]]` | "Displays price breakdown per each day of the hotel stay."                                                                                                                  | p. 13; pp. 24, 28 | VERIFICADO-PDF |
| `…DayRates[][].BasePrice`              | Decimal                              | number de 7–8 decimales                                                                                | "BasePrice of the room."                                                                                                                                                    | p. 13; pp. 24, 28 | VERIFICADO-PDF |
| `…Rooms[].TotalFare`                   | Decimal                              | number `152.88`                                                                                        | "Total fare of the bookable unit."                                                                                                                                          | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].TotalTax`                    | Decimal                              | number `28.12`                                                                                         | "Total tax of the bookable unit."                                                                                                                                           | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].ExtraGuestCharges`           | **Decimal**                          | **string** `"17.22"`                                                                                   | "Extra Guest charges of the bookable unit (if applicable)"                                                                                                                  | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].RecommendedSellingRate`      | String                               | string `"160.67"`: un importe serializado como texto                                                   | "The minimum selling rate for the requested booking. The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the response, if any." | pp. 13, 15        | VERIFICADO-PDF |
| `…Rooms[].RoomPromotion`               | **List of String Array**             | **array plano** de strings, uno por habitación                                                         | "In the case of multi-room, first element defines promotion for the first room, other respectively"                                                                         | pp. 14, 15, 17    | VERIFICADO-PDF |
| `…Rooms[].CancelPolicies`              | Array                                | Ausente en Search con `false`. En PreBook es un array de objetos                                       | "list of detailed cancel policies applicable on the bookable unit."                                                                                                         | p. 14; pp. 24, 28 | VERIFICADO-PDF |
| `…CancelPolicies[].Index`              | **String**                           | No aparece en ningún ejemplo                                                                           | "Denotes the room index for which cancellation policies is applicable. If missing, policies are applicable for entire booking"                                              | p. 14             | VERIFICADO-PDF |
| `…CancelPolicies[].FromDate`           | String                               | `"05-05-2022 00:00:00"`; `"15-10-2021 00:00:00"` prueba el orden día-mes                               | "Cancel policy start date"                                                                                                                                                  | p. 14; pp. 24, 50 | VERIFICADO-PDF |
| `…CancelPolicies[].ChargeType`         | String                               | `"Fixed"`, `"Percentage"`                                                                              | "e.g., fixed amount, percentage value etc." (lista abierta)                                                                                                                 | p. 14; pp. 24, 28 | VERIFICADO-PDF |
| `…CancelPolicies[].CancellationCharge` | Decimal                              | `0.0`, `100.0`                                                                                         | "Cancellation charges applicable on bookable unit."                                                                                                                         | p. 14; pp. 24, 28 | VERIFICADO-PDF |
| `…Rooms[].MealType`                    | Enumeration                          | `"Room_Only"`                                                                                          | La tabla lista solo "Breakfast_For_2, Breakfast_For_1, All_Inclusive_All_Meal". La enumeración completa, con 10 valores, está en p. 70                                      | pp. 14, 15, 70    | VERIFICADO-PDF |
| `…Rooms[].IsRefundable`                | Boolean                              | `false`                                                                                                | "Defines refundable and non-refundable room."                                                                                                                               | pp. 14, 15        | VERIFICADO-PDF |
| `…Rooms[].WithTransfers`               | Boolean                              | `false`                                                                                                | "Defines if transfers are included." (v1.3, p. 5)                                                                                                                           | pp. 14, 15        | VERIFICADO-PDF |
| `…Rooms[].Supplements`                 | **List of Object**                   | **array de arrays**: un array interno por habitación                                                   | "It contains list of supplements. Please ensure same are visible to end customer."                                                                                          | pp. 14, 15, 17    | VERIFICADO-PDF |
| `…Supplements[][].Index`               | **Integer**                          | `1`, `2` (base 1)                                                                                      | "Denotes the room index for which supplement is applicable."                                                                                                                | pp. 14, 17        | VERIFICADO-PDF |
| `…Supplements[][].Type`                | String                               | `"AtProperty"`                                                                                         | "Included: price included in total, AtProperty: charges need to be paid at the hotel."                                                                                      | pp. 14, 15        | VERIFICADO-PDF |
| `…Supplements[][].Description`         | String                               | `"mandatory_tax"` (código, sin catálogo)                                                               | "Supplement details"                                                                                                                                                        | pp. 14, 15        | VERIFICADO-PDF |
| `…Supplements[][].Price`               | Decimal                              | `20.00`                                                                                                | "Supplement charges"                                                                                                                                                        | p. 15             | VERIFICADO-PDF |
| `…Supplements[][].Currency`            | String                               | `"AED"` (distinta de la del hotel)                                                                     | "The applicable currency for the supplement charges."                                                                                                                       | p. 15             | VERIFICADO-PDF |
| `…Rooms[].RoomID`                      | **No figura en la tabla de Search**  | Solo en la nota de HotelDetails: `"RoomID": ["197354"]` (array de strings)                             | "Search API returns a RoomID. This RoomID corresponds to the RoomId in HotelDetails API. … if Room ID is 0, which means mapping isn't available."                           | p. 57             | VERIFICADO-PDF |

### 9.2 Ejemplos del contrato

**6.2.2, varias habitaciones (pp. 16–18).** JSON válido; se muestra el primer elemento de `Rooms`:

```json
{
  "Status": { "Code": 200, "Description": "Successful" },
  "HotelResult": [
    {
      "HotelCode": "1120548",
      "Currency": "USD",
      "Rooms": [
        {
          "Name": ["Luxury Room, 1 King Bed", "Luxury Room, 1 King Bed"],
          "BookingCode": "1120548!TB!2!TB!9a47646b-1bba-4746-91d5-969149db1185",
          "Inclusion": "Free WiFi",
          "TotalFare": 305.75,
          "TotalTax": 56.24,
          "ExtraGuestCharges": "17.22",
          "RecommendedSellingRate": "321.34",
          "RoomPromotion": ["Private sale", "Private sale"],
          "MealType": "Room_Only",
          "IsRefundable": false,
          "Supplements": [
            [
              {
                "Index": 1,
                "Type": "AtProperty",
                "Description": "mandatory_tax",
                "Price": 20.0,
                "Currency": "AED"
              }
            ],
            [
              {
                "Index": 2,
                "Type": "AtProperty",
                "Description": "mandatory_tax",
                "Price": 20.0,
                "Currency": "AED"
              }
            ]
          ],
          "WithTransfers": false
        }
      ]
    }
  ]
}
```

**6.2.3, sin disponibilidad (p. 18).** Literal:

```json
{
  "Status": {
    "Code": 201,
    "Description": "No Available rooms for given criteria"
  }
}
```

**Nota de HotelDetails sobre `RoomID` (p. 57).** Completo, con los espacios compactados:

```json
"Rooms": [ { "Name": ["Deluxe Room, 1 King Bed, Garden View, NonSmoking"], "RoomID": ["197354"], "TotalFare": 23157.62, "IsRefundable": false } ]
```

### 9.3 Semántica de `Rooms[]`: combinación indivisible

**Evidencia (VERIFICADO-PDF, pp. 13, 15–18):**

- con una habitación pedida, `Name` trae 1 elemento y `Supplements` 1 array interno;
- con dos, `Name` trae 2 elementos, `RoomPromotion` 2, `Supplements` 2 arrays con `Index` 1 y 2, y hay **un** `BookingCode` y **un** `TotalFare`;
- todos los `BookingCode` de una misma búsqueda comparten el UUID final.

**Consecuencias:**

1. **Un elemento de `Rooms[]` corresponde a un `HotelRoompack`.** El contrato actual ya modela el pack como combinación con precio único (`types.ts:73-82`), así que el encaje es natural.
2. **El token va en el pack, no en la habitación.** En Despegar, el token reservable es `HotelRoomItem.choiceId` y existe por habitación (`types.ts:54-55`). En TBO, `BookingCode` identifica la combinación entera. En el contrato neutral se guarda en la referencia de proveedor del pack: `provider.offerRef`, al estilo de `ProviderRefSchema.offerRef` (máximo 255 caracteres, `packages/canonical/src/offer.ts:68`). El `BookingCode` observado tiene unos 52 caracteres (p. 15). `choiceId` queda vacío para TBO.
3. **El precio no se puede partir por habitación.** Solo `DayRates` da un desglose, y únicamente con `IsDetailedResponse: true` o en PreBook. La UI no puede permitir combinar la habitación 1 de un pack con la habitación 2 de otro: se elige el pack completo.
4. **El `BookingCode` es opaco** (INFERIDO). Tiene el formato observado `<HotelCode>!TB!<n>!TB!<uuid>`, pero no se interpreta. Contiene `!`, así que si alguna vez viaja en una URL hay que codificarlo.
5. **Contexto de búsqueda en el servidor** (INFERIDO; detalle en [03](./03-prebook-y-book.md)). PreBook recibe solo `BookingCode` y `PaymentMode` (p. 19). Las respuestas de PreBook y Book no devuelven fechas, ocupación ni nacionalidad (pp. 20–21, 23, 40–41). El Book solo envía nombres por habitación con `Type` `Adult` o `Child`, sin edades ni nacionalidad (pp. 32–33). Por eso cada búsqueda guarda en servidor, con un TTL de 30 minutos (p. 8), un registro indexado por el tenant y por un `searchId` nuestro (un `searchId` de otro tenant no se resuelve) con:

   - `CheckIn` y `CheckOut`;
   - `PaxRooms`;
   - `GuestNationality`;
   - `searchSentAt`, el instante en que se envió el Search, que es la referencia del vencimiento (punto 6);
   - una huella de la credencial que buscó (id de cuenta y `updatedAt`, nunca el secreto);
   - por pack, el `BookingCode` y el literal de `TotalFare`.

   El `HotelCode` y el `BookingCode` que PreBook y Book reenvían se leen de este registro, nunca del navegador ([08](./08-requisitos-maestro.md) RF-08, §9 C-11).

   El pack lleva `provider.raw = { searchId }` y ninguna PII (`packages/canonical/src/offer.ts:83-84` exige que `raw` "nunca" lleve "secretos, PAN ni PII"). Si al hacer PreBook la credencial resuelta ya no es la misma (por rotación, o porque la agencia cargó su propia cuenta), se fuerza una nueva búsqueda en vez de enviar el `BookingCode` con otra cuenta.

6. **Vencimiento de la oferta.** `expiresAt = searchSentAt + 27 min`: los 30 minutos de p. 8 menos los 120 s del Book y 60 s de margen ([01](./01-autenticacion-conectividad-y-errores.md) §6.3; [08](./08-requisitos-maestro.md) RF-09). El contrato actual no tiene dónde guardarlo (§13). El código 315 es `BOOKINGCODE_EXPIRED`, "Session expired between search to book." (p. 9); que obligue a volver a buscar es INFERIDO.

### 9.4 Precio: `TotalFare`, `TotalTax`, `DayRates` y `ExtraGuestCharges`

| Campo                      | Qué es                                                                                                                                                                                                                                                                                                                                                                                               | Evidencia                                                | Postura                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TotalFare`                | Total de la combinación en la moneda del perfil. **Incluye `TotalTax`**, según la aritmética de los ejemplos de PreBook: 15.15762150 + 1.94 = 17.0976 ≈ 17.10 (p. 24); 2 × 124.7564850 + 56.24 = 305.75297 ≈ 305.75 (p. 28)                                                                                                                                                                          | Cálculo sobre pp. 24, 28: INFERIDO                       | Se toma como el `price.total` neto del pack, que es lo que se carga al `Limit` de la agencia (D1; [03](./03-prebook-y-book.md)). No se recalcula desde `DayRates`                                                                                                          |
| Neto o bruto               | El PDF no dice si `TotalFare` incluye un margen de agencia configurado en el perfil TBO. `BookingDetailsbasedondate` tiene `AgentMarkup` ("Agency's commission") y `BookingPrice` ("including agency Commision")                                                                                                                                                                                     | p. 63: VERIFICADO-PDF                                    | Riesgo de **doble margen** si un perfil BYOC tiene markup en TBO y además aplicamos el waterfall. Postura: las credenciales TBO se configuran con markup 0 en TBO → [Q-89](./10-preguntas-para-tbo.md#q-89)                                                                |
| `TotalTax`                 | Impuesto total de la combinación                                                                                                                                                                                                                                                                                                                                                                     | p. 13: VERIFICADO-PDF                                    | Va a `price.taxes`. `taxesDetail` queda en `[]`: TBO no desglosa                                                                                                                                                                                                           |
| `DayRates[j][n].BasePrice` | Precio base por habitación y por noche (INFERIDO: todos los ejemplos son de una noche, así que no se puede confirmar que el nivel externo sea la habitación y el interno la noche). Sin impuestos (INFERIDO por la aritmética)                                                                                                                                                                       | pp. 13, 24, 28                                           | Solo informativo, redondeado a la moneda. Nunca se suma para obtener el total. Si no llega, la UI muestra "promedio por noche" = `TotalFare` / noches, rotulado como promedio → [Q-21](./10-preguntas-para-tbo.md#q-21) sobre la estructura                                |
| `ExtraGuestCharges`        | "Extra Guest charges … (if applicable)". Llega como string. Aparece en todos los ejemplos de Search y de PreBook, de una y de dos habitaciones (pp. 15–17, 24, 28); ningún ejemplo de respuesta dice qué ocupación lo generó. Para el **mismo** `BookingCode` vale `"17.22"` en Search y `"6.45"` en PreBook, con el mismo `TotalFare` (pp. 17, 28). La aritmética de PreBook cierra **sin** sumarlo | pp. 13, 15–17, 24, 28: VERIFICADO-PDF; lo demás INFERIDO | **No se suma** al total ni al precio de venta. Se guarda como dato informativo, visible **solo para el vendedor** ("cargo por huésped adicional informado por TBO"), hasta que TBO aclare si está incluido o se paga en el hotel → [Q-22](./10-preguntas-para-tbo.md#q-22) |

### 9.5 `RecommendedSellingRate` y el pricing waterfall

**Contrato.** "The minimum selling rate for the requested booking. The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the response, if any." (p. 13; también en PreBook, p. 21, VERIFICADO-PDF). Es un string y puede no venir. En los ejemplos queda un 5,1 % por encima de `TotalFare`: 160.67 / 152.88 y 321.34 / 305.75 (INFERIDO por cálculo).

**Estado del waterfall** (VERIFICADO-CODIGO):

- `withPricing` aplica `applyCascade(pack.price.total.amountMinor, rules)` y `toTenantView` a cada pack (`apps/api/src/hotels/hotels.service.ts:47-64`).
- `applyCascade` compone reglas porcentuales y fijas sobre el acumulado (`apps/api/src/pricing/pricing.service.ts:69-90`).
- `toTenantView` reparte el margen entre el tenant y sus ancestros a partir del `breakdown` (`:37-54`).
- **No existe concepto de piso ni de canal** (B2B o B2C). La única app de venta es `apps/web-b2b`: el directorio `apps/` solo contiene `api` y `web-b2b`. `finalMinor` es "el precio de VENTA" (`providers/despegar-hotels/src/types.ts:58-63`).
- Si el tenant no tiene reglas, `withPricing` devuelve las ofertas sin `pricing` (`hotels.service.ts:49`) y el precio de venta es el neto (`types.ts:80`). El piso tiene que aplicarse también en ese caso.
- La web pinta y ordena por el neto `price.total`, no por `pricing.finalMinor`; su espejo de `HotelRoompack` no tiene `pricing` (`apps/web-b2b/src/app/(app)/hoteles/_components/hotel-result-card.tsx:12`, `:62`, `:118`; `actions.ts:57-63`). Ver [06](./06-seams-integracion-repo.md) G3.

**Postura (INFERIDO; decisión D02-4):**

1. El pack lleva `minimumSellingPrice?: Money`, parseado de `RecommendedSellingRate` en la moneda del `HotelResult`. Si llega vacío o ausente, no hay piso.
2. Después de la cascada: `finalMinor = max(finalMinor_cascada, minimumSellingPrice)`.
3. La diferencia se agrega al `breakdown` como un paso propio (`ruleType: 'provider_floor'`) **atribuido al tenant que vende**, es decir, el tenant de la vista. Así `toTenantView` la cuenta como margen propio y el consolidador no ve un margen que no configuró.

Ejemplo ilustrativo con el pack de p. 17:

| Paso              | Cálculo                          | Resultado |
| ----------------- | -------------------------------- | --------- |
| Neto              | 305.75 USD                       | 30575     |
| Consolidador +3 % | round(30575 × 300 / 10000) = 917 | 31492     |
| Agencia +1 %      | round(31492 × 100 / 10000) = 315 | 31807     |
| Piso de TBO       | 321.34 USD = 32134 > 31807       | 32134     |
| Aporte del piso   | 327, atribuido a la agencia      | —         |

Otras reglas del piso:

4. El piso se vuelve a aplicar con el `RecommendedSellingRate` de PreBook, que es el vigente al reservar ([03](./03-prebook-y-book.md)).
5. La UI no permite ningún precio manual ni descuento por debajo del piso, y el agente de WhatsApp tampoco.
6. **Package Studio.** Si el hotel se vende dentro de un paquete con precio único, el contrato no dice si el piso aplica al componente → [Q-23](./10-preguntas-para-tbo.md#q-23). Mientras no haya respuesta, el precio implícito del componente hotel no baja del piso. Hoy `PackagesService.addItem` recalcula cada ítem con `applyCascade(dto.baseFareMinor + dto.taxesMinor, rules)` sobre importes que envía el cliente, sin piso (`apps/api/src/packages/packages.service.ts:84-87`; `packages.schemas.ts:31-32`). Como `TotalFare` ya incluye `TotalTax` (§9.4), un ítem TBO cargado como `TotalFare` + `TotalTax` sumaría el impuesto dos veces.

### 9.6 `CancelPolicies`

**Contrato** (VERIFICADO-PDF): cada tramo trae `FromDate` (inicio), `ChargeType` y `CancellationCharge`, más un `Index` opcional (p. 14). En Search solo llegan con `IsDetailedResponse: true` (p. 11). Las de PreBook son finales (p. 71).

| Aspecto                     | Hecho                                                                                                                                                                | Postura (INFERIDO)                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formato de `FromDate`       | `DD-MM-YYYY HH:mm:ss`, sin zona horaria. El orden día-mes se deduce de `"15-10-2021 00:00:00"` (p. 50). Es un formato distinto del `YYYY-MM-DD` de `CheckIn` (p. 10) | Se parsea como fecha y hora local, sin offset. Se guarda el literal más el valor parseado. Se muestra como "hora del hotel (según TBO)". La zona horaria no está documentada → [Q-24](./10-preguntas-para-tbo.md#q-24). El único indicio es un texto de ejemplo: "the cancellation policy is based on the hotel's time" (p. 51) |
| Fin de tramo                | No hay `ToDate`                                                                                                                                                      | El tramo `i` vale hasta el `FromDate` del tramo `i+1`. El último, hasta el check-in o el no-show                                                                                                                                                                                                                                |
| `ChargeType`                | Valores vistos: `Fixed` y `Percentage`, con un "etc." (p. 14)                                                                                                        | Se comparan sin distinguir mayúsculas. Un valor desconocido se trata como penalidad del 100 % y se registra                                                                                                                                                                                                                     |
| `Percentage`                | No se dice sobre qué base                                                                                                                                            | Base: `TotalFare` del pack, o la parte de la habitación si hay `Index` → [Q-24](./10-preguntas-para-tbo.md#q-24)                                                                                                                                                                                                                |
| `Fixed`                     | No se dice la moneda                                                                                                                                                 | La del `HotelResult` → [Q-24](./10-preguntas-para-tbo.md#q-24)                                                                                                                                                                                                                                                                  |
| `Index`                     | String según la tabla; nunca aparece en un ejemplo. Base desconocida. Si falta, aplica a toda la reserva (p. 14)                                                     | Se aceptan string o número. Base 1, por analogía con `Supplements` → [Q-24](./10-preguntas-para-tbo.md#q-24)                                                                                                                                                                                                                    |
| Relación con `IsRefundable` | Hay un ejemplo con `IsRefundable: false` y dos tramos `Fixed 0.00` antes del 100 % (p. 50)                                                                           | Nunca se deriva uno del otro: se guardan los dos                                                                                                                                                                                                                                                                                |
| Cancelación gratuita        | —                                                                                                                                                                    | `freeCancellationUntil` = `FromDate` del primer tramo con cargo mayor que 0, siempre que el tramo anterior sea 0. El margen de seguridad frente a la zona horaria se define en [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)                                                                                      |

**Desde el 2026-09-29** (D-TBO-39): los dos datos se siguen guardando, pero para vender la contradicción se lee
como no reembolsable, sin prometer cancelación gratis, y una tarifa cuyo 100 % ya rige se trata igual
([03 §2.13](./03-prebook-y-book.md#213-tarifas-no-reembolsables-aplicado-2026-09-29)).

**Traducción al contrato actual** (`types.ts:13-29`, VERIFICADO-CODIGO):

- `refundable` ← `IsRefundable`;
- `status`:
  - `IsRefundable: false` → `'non_refundable'`;
  - `IsRefundable: true` con tramos → `'fully_refundable'` si el primer tramo tiene cargo 0, y `'partially_refundable'` si no;
  - `IsRefundable: true` **sin tramos** (el listado normal) → `'partially_refundable'`, marcado con un origen de política `none` (ver §13). Nunca se declara `'fully_refundable'` sin haber visto los tramos. La web rotula hoy ese estado como "Parcialmente reembolsable" sin mirar ningún origen (`apps/web-b2b/src/app/(app)/hoteles/_components/hotel-format.ts:29-37`): tiene que leer `policySource`.

`CancellationRule { type, penaltyPercentage?, penaltyNights?, fromHours?, toHours? }` expresa horas relativas al check-in. **No puede guardar** una fecha absoluta, un importe fijo ni un índice de habitación: faltan campos (§13).

El canónico `CancellationFeeSchema` (`packages/canonical/src/hotel.ts:101-105`) exige `validUntil` con offset. Con TBO no se puede rellenar sin inventar una zona horaria. Por eso el contrato neutral guarda la fecha y hora local sin offset (§13).

### 9.7 `Supplements`

**Contrato** (VERIFICADO-PDF):

- estructura de array de arrays, con un array interno por habitación y `Index` base 1 (pp. 15, 17);
- `Type` `Included` ("price included in total") o `AtProperty` ("charges need to be paid at the hotel") (p. 14);
- "Please ensure same are visible to end customer." (p. 14);
- Key Point 4: "Kindly display the mandatory supplements i.e, AtProperty before/at the booking step as the guest needs to pay the supplement charges directly at the hotel." (p. 71);
- la moneda puede ser distinta de la del hotel (p. 15);
- la certificación exige un caso con suplementos (Cert, caso 7).

**Contrato actual:** `HotelPrice.chargeAtDestination?: Money`, "A pagar en el hotel (no se cobra en la reserva)" (`types.ts:42-43`, VERIFICADO-CODIGO). Es **un solo** importe en la moneda del pack: no sirve para varios cargos, por habitación y en otra moneda.

**Postura (INFERIDO):**

1. `AtProperty` → `atPropertyCharges[] = { roomIndex, description, amount: Money (en la moneda del suplemento), descriptionRaw }`.
   - **Nunca** se suma a `price.total` ni al precio de venta, y nunca se convierte de moneda.
   - `chargeAtDestination` se deja vacío para TBO, para no mezclar monedas.
   - Si la moneda del suplemento tiene un exponente ISO distinto de 2, se guarda además el literal decimal (`amountText`) y la UI muestra el literal, nunca un `Money` mal escalado (§8.3).
2. `Included` → `includedSupplements[]`, solo informativo: ya está dentro de `TotalFare`.
3. Un `Type` desconocido se trata como `AtProperty`. Es el error menos dañino: avisar de un posible cargo.
4. Unidad de `Price` (por noche, por habitación o por estadía): **no documentada**. En un PreBook del mismo hotel, `RateConditions` dice "AED 20.00 per accommodation, per night" (p. 31), pero el ejemplo es de una noche y no permite distinguir. Se muestra tal cual con el rótulo "según TBO" → [Q-27](./10-preguntas-para-tbo.md#q-27).
5. `Description` es un código sin catálogo (`mandatory_tax`). Se guarda el literal y se traduce por i18n cuando se reconoce. Si no, se muestra el literal.
6. **Visibilidad (KP-4):**

   - la tarjeta del listado indica "cargos a pagar en el hotel";
   - el detalle y el paso previo a confirmar muestran importe y moneda;
   - en WhatsApp, el agente los enuncia antes de pedir confirmación.

   Es requisito de la certificación de portal ([07](./07-certificacion.md)).

7. **Acepta las dos formas.** El ACL acepta tanto array de arrays (lo observado) como array plano (lo que dice la tabla, "List of Object") y normaliza por `Index`.

### 9.8 `MealType` → `BoardType`: dos vocabularios

| Vocabulario                                                         | Dónde    | Valores                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filtro** (`Filters.MealType`; la enumeración se llama `MealPlan`) | Request  | `All`, `WithMeal`, `RoomOnly` (pp. 11, 69)                                                                                                                                                                                                                                        |
| **Tarifa** (`Rooms[].MealType`, enumeración `MealType`)             | Response | `All_Inclusive_All_Meal`, `Full_Board`, `Half_Board`, `Room_Only`, `BreakFast`, `Lunch`, `Dinner`, `BreakFast_Lunch`, `Breakfast_For_1`, `Breakfast_For_2` (p. 70). La tabla de Search solo lista tres (p. 14), y el ejemplo usa `Room_Only`, que no está entre esos tres (p. 15) |

Hay que fijarse en el casing: `BreakFast` y `BreakFast_Lunch` llevan F mayúscula; `Breakfast_For_1` y `Breakfast_For_2`, f minúscula. Además, `RoomOnly` (filtro) no es lo mismo que `Room_Only` (tarifa) (pp. 69–70).

El canónico `BoardType` tiene cinco valores: `RO`, `BB`, `HB`, `FB` y `AI` (`packages/canonical/src/hotel.ts:98-99`). El mapper de Despegar mapea por palabra y cae a `RO` (`providers/despegar-hotels/src/availability/response.mapper.ts:61-69`).

**Mapeo propuesto (INFERIDO).** La comparación ignora mayúsculas y guiones bajos, y el literal se conserva siempre:

| `MealType` TBO           | `BoardType` | Etiqueta que se conserva   | Nota                                                                                                      |
| ------------------------ | ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Room_Only`              | `RO`        | "Solo alojamiento"         | —                                                                                                         |
| `BreakFast`              | `BB`        | "Desayuno"                 | —                                                                                                         |
| `Breakfast_For_1`        | `BB`        | "Desayuno para 1 persona"  | Mapear a `BB` exagera el régimen si la habitación es doble: la etiqueta es obligatoria en la UI           |
| `Breakfast_For_2`        | `BB`        | "Desayuno para 2 personas" | —                                                                                                         |
| `Half_Board`             | `HB`        | "Media pensión"            | —                                                                                                         |
| `Full_Board`             | `FB`        | "Pensión completa"         | —                                                                                                         |
| `All_Inclusive_All_Meal` | `AI`        | "Todo incluido"            | —                                                                                                         |
| `BreakFast_Lunch`        | `HB`        | "Desayuno y almuerzo"      | Dos comidas. Queda la duda de si TBO lo considera media pensión → [Q-28](./10-preguntas-para-tbo.md#q-28) |
| `Lunch`                  | `RO`        | "Almuerzo incluido"        | Sin equivalente. Se elige quedarse corto antes que prometer desayuno                                      |
| `Dinner`                 | `RO`        | "Cena incluida"            | Ídem                                                                                                      |
| Cualquier otro o ausente | `RO`        | el literal                 | Se incrementa la métrica `tbo.unknown_meal_type`                                                          |

**Regla S-14.** `board` sirve para filtrar y agrupar. La etiqueta (`boardLabel`) y el literal (`mealTypeRaw`) son lo que se muestra al viajero. Hoy la web deriva la etiqueta solo de `board`, con su función `boardLabel` (`apps/web-b2b/src/app/(app)/hoteles/_components/hotel-format.ts:3-13`), así que `Breakfast_For_1` se vería como "Desayuno".

### 9.9 Otros atributos del pack

| Campo              | Postura (INFERIDO)                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IsRefundable`     | Va a `cancellation.refundable` (§9.6). Si falta, se toma `false`: es lo conservador                                                                                                                                                                                                                                                                                             |
| `WithTransfers`    | Nuevo booleano `includesTransfers`. Si es `true`, la tarjeta lo muestra ("incluye traslados"). Package Studio lo usa para no duplicar un traslado                                                                                                                                                                                                                               |
| `RoomPromotion[j]` | Promociones por habitación: `rooms[j].promotions = [RoomPromotion[j]]`. Se muestran como etiqueta. No alteran el precio: ya están en `TotalFare`                                                                                                                                                                                                                                |
| `Inclusion`        | `inclusionText` a nivel de pack. No se sabe qué separador se usa si hay varias inclusiones (p. 13) → [Q-28](./10-preguntas-para-tbo.md#q-28). No se parte                                                                                                                                                                                                                       |
| `RoomID[j]`        | `rooms[j].roomTypeId` si es distinto de `"0"` o `0` ("mapping isn't available", p. 57). Sirve para enlazar tamaño, descripción e imágenes de HotelDetails ([05](./05-contenido-estatico-e-inventario.md)). Se tolera su ausencia, porque no está en la tabla de Search. Se aceptan string o número y los dos casings (`RoomID` en Search y `RoomId` en HotelDetails, pp. 56–57) |
| `Name[j]`          | `rooms[j].name`. El texto libre incluye camas y vista ("Luxury Room, 1 King Bed"). Del nombre no se infieren camas por heurística: `bedOptions` sólo sale de `BeddingGroup`                                                                                                                                                                                                     |
| `BeddingGroup`     | **Sin documentar** (C-36): llega en cada búsqueda de producción. Se acepta con cualquier forma, sin invalidar el pack ni avisar como clave desconocida. Un texto va a `bedOptions`: uno si el pack tiene una habitación, o una lista alineada con `Name`. La métrica `tbo.search.bedding_group` cuenta su forma, nunca el valor → [Q-28](./10-preguntas-para-tbo.md#q-28)       |

### 9.10 Sin disponibilidad y demás `Status.Code`

- `201 NO_AVAILABILITY`: "No available rooms for given criteria." (p. 9). La respuesta **no trae `HotelResult`** (p. 18).
  - El ACL devuelve `[]`.
  - El proveedor figura como `empty` en `providers[]`, no como `error`.
  - El circuit breaker no lo cuenta como fallo.
  - Se distingue del `503` del servicio por catálogo no sincronizado (`hotels.service.ts:80-86`). Ese `503` significa "no sabemos qué hoteles hay"; el `201` significa "TBO no tiene disponibilidad".
- No se compara `Description`. En el ejemplo real es `"No Available rooms for given criteria"`, distinto de la tabla (pp. 9, 18).
- Con varios códigos, el PDF no dice si los hoteles sin disponibilidad se omiten de `HotelResult` o si todo pasa a `201` solo cuando no hay ninguno con disponibilidad → [Q-20](./10-preguntas-para-tbo.md#q-20). Postura: los hoteles ausentes se tratan como sin disponibilidad.
- Resto de códigos y relación entre `Status.Code` y el estado HTTP: ver [01](./01-autenticacion-conectividad-y-errores.md). En Search, lo esperable es `200`, `201`, `400`, `401`, `402`, `429` y `500` (INFERIDO).
- **Regla S-07.** El resultado se decide siempre por `Status.Code` del cuerpo, nunca por `res.ok`.

---

## 10. Validación Zod de la respuesta

`CLAUDE.md` exige Zod también sobre el payload del proveedor. La propuesta valida el sobre de forma estricta y cada pack por separado, para que un pack defectuoso no tire la búsqueda entera. Es un esquema INFERIDO de los ejemplos y de las contradicciones de §11. El archivo propuesto es `providers/tbo-hotels/src/search/response.schema.ts`:

```ts
import { z } from 'zod';

const Decimalish = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/),
]);
const OptionalDecimalish = z
  .union([Decimalish, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v === '' || v == null ? undefined : v));

const TboSupplement = z.object({
  Index: z.coerce.number().int().positive(),
  Type: z.string(), // 'Included', 'AtProperty' o desconocido (§9.7)
  Description: z.string().optional(),
  Price: Decimalish,
  Currency: z.string().trim().length(3),
});

const TboCancelPolicy = z.object({
  Index: z.union([z.string(), z.number()]).optional(),
  FromDate: z.string().regex(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/),
  ChargeType: z.string(),
  CancellationCharge: Decimalish,
});

export const TboRoomSchema = z.object({
  Name: z.array(z.string()).min(1),
  BookingCode: z.string().min(1).max(255),
  Inclusion: z.string().optional(),
  DayRates: z.array(z.array(z.object({ BasePrice: Decimalish }))).optional(),
  TotalFare: Decimalish,
  TotalTax: OptionalDecimalish,
  ExtraGuestCharges: OptionalDecimalish,
  RecommendedSellingRate: OptionalDecimalish,
  RoomPromotion: z.array(z.string()).optional(),
  CancelPolicies: z.array(TboCancelPolicy).optional(),
  MealType: z.string().optional(),
  IsRefundable: z.boolean().optional(), // ausente → false (§9.9)
  WithTransfers: z.boolean().optional(),
  // La tabla dice "List of Object"; los ejemplos, array de arrays (§9.7)
  Supplements: z.union([z.array(z.array(TboSupplement)), z.array(TboSupplement)]).optional(),
  RoomID: z.array(z.union([z.string(), z.number()])).optional(),
});

export const TboSearchEnvelopeSchema = z
  .object({
    Status: z.object({ Code: z.number().int(), Description: z.string().optional() }),
    HotelResult: z
      .array(
        z.object({
          HotelCode: z.union([z.string(), z.number()]).transform(String),
          Currency: z.string().trim().length(3).optional(), // ausente → HotelResult descartado (§8.2)
          Rooms: z.array(z.unknown()), // cada pack: TboRoomSchema.safeParse
        }),
      )
      .optional(),
  })
  .passthrough(); // conserva las claves desconocidas para registrar sus nombres (nunca sus valores)
```

**Reglas de validación:**

- **S-16.** Si el sobre no valida, es un error del proveedor ([01](./01-autenticacion-conectividad-y-errores.md)).
- Un pack que no valida se descarta y se cuenta en `tbo.search.pack_rejected{reason}`. Los mensajes llevan solo la ruta y el código de Zod, nunca valores: mismo criterio que `parseSabreConfig`.
- Los campos desconocidos se toleran sin romper, pero sus **nombres** se registran para detectar cambios del contrato. Como `z.object` descarta las claves sin exponerlas, el envelope usa `.passthrough()` y en cada pack se comparan las claves con las del esquema antes de parsear; solo se registran nombres, nunca valores ([08](./08-requisitos-maestro.md) RNF-12, §9 C-12).
- Los tipos raw no salen del paquete: son `z.infer` de estos esquemas y no se exportan. No se copia el patrón `Parameters<typeof mapX>[0]` del ACL de Despegar, que tipa la respuesta HTTP con un genérico sin validarla (`providers/despegar-hotels/src/index.ts:75`) ([06](./06-seams-integracion-repo.md)).

---

## 11. Contradicciones y huecos del contrato

| #    | Tema                                        | Contradicción o hueco                                                                                                                                    | Fuente                 | Postura de diseño (defensiva)                                                                                                                                                                                                                                                                    | ¿Requiere a TBO?                          |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| C-01 | Obligatoriedad                              | Ninguna tabla indica qué campos son obligatorios                                                                                                         | pp. 10–11              | Se envían siempre todos los campos documentados; solo se omiten los no documentados                                                                                                                                                                                                              | No                                        |
| C-02 | Ejemplos de request                         | Comillas tipográficas y falta la llave de cierre: no son JSON válido                                                                                     | pp. 11–12              | Los fixtures se escriben a mano, corregidos, y se marcan como "derivados del PDF"                                                                                                                                                                                                                | No                                        |
| C-03 | `Children` 0                                | Rango declarado "(1-4)", pero una habitación solo de adultos necesita 0 (Cert, caso 1; Postman)                                                          | p. 11; Postman: Search | Se envía `Children: 0`                                                                                                                                                                                                                                                                           | → [Q-13](./10-preguntas-para-tbo.md#q-13) |
| C-04 | `ChildrenAges` sin niños                    | La regla de longitud implica `[]`; Postman envía `[0]`                                                                                                   | p. 11; Postman: Search | Estrategia configurable, `[]` por defecto (§2.3)                                                                                                                                                                                                                                                 | → [Q-13](./10-preguntas-para-tbo.md#q-13) |
| C-05 | Edad 18                                     | "0-18 years": no se dice si 18 es niño ni si hay corte para infantes                                                                                     | p. 11                  | Nuestro borde corta en 17                                                                                                                                                                                                                                                                        | → [Q-14](./10-preguntas-para-tbo.md#q-14) |
| C-06 | Máximo de habitaciones, noches y antelación | No documentados                                                                                                                                          | pp. 10–12              | Parámetro `maxRoomsPerSearch`; un `400` se clasifica como error de validación                                                                                                                                                                                                                    | → [Q-14](./10-preguntas-para-tbo.md#q-14) |
| C-07 | `HotelCodes` > 100                          | "Recommended Value; 100": no se dice si más de 100 se rechaza ni cómo escala el tiempo de respuesta                                                      | p. 10                  | Lotes de ≤100 (§4.3)                                                                                                                                                                                                                                                                             | → [Q-15](./10-preguntas-para-tbo.md#q-15) |
| C-08 | QPS                                         | El límite de QPS no se publica                                                                                                                           | p. 9                   | Dos perillas ([08](./08-requisitos-maestro.md) §9 C-02): el limitador por cuenta de [01](./01-autenticacion-conectividad-y-errores.md) §7.2 (RNF-02) y `searchConcurrency`, 1 por defecto, para los lotes de una misma búsqueda (§4.3). Un `429` baja el ritmo de la cuenta y no abre el breaker | → [Q-10](./10-preguntas-para-tbo.md#q-10) |
| C-09 | `ResponseTime`                              | Declarado Integer, escrito `23.0`/`20.0`; semántica no explicada                                                                                         | pp. 8, 11; Postman     | Configurable de 5 a 20, 10 por defecto (D-TBO-17 A); timeout HTTP = `ResponseTime` + 3 s, nunca más de 23 s (§6.1)                                                                                                                                                                               | → [Q-16](./10-preguntas-para-tbo.md#q-16) |
| C-10 | `Filters.MealType`                          | Enum de strings en el PDF, entero en Postman; la enumeración se llama `MealPlan`                                                                         | pp. 11, 69; Postman    | Siempre string (S-03)                                                                                                                                                                                                                                                                            | → [Q-18](./10-preguntas-para-tbo.md#q-18) |
| C-11 | Filtros no documentados                     | `OrderBy`, `StarRating` y `HotelName` solo existen en Postman                                                                                            | Postman: Search        | No se envían (S-02)                                                                                                                                                                                                                                                                              | → [Q-18](./10-preguntas-para-tbo.md#q-18) |
| C-12 | `NoOfRooms`                                 | La semántica y el significado de 0 son ambiguos                                                                                                          | pp. 11–12              | Se envía `0`                                                                                                                                                                                                                                                                                     | → [Q-18](./10-preguntas-para-tbo.md#q-18) |
| C-13 | Residencia y nacionalidad                   | La nota de EAU mezcla los dos conceptos                                                                                                                  | p. 10                  | Se envía la nacionalidad del pasajero principal y nunca un valor por defecto (§5)                                                                                                                                                                                                                | → [Q-17](./10-preguntas-para-tbo.md#q-17) |
| C-14 | `Room(s);` frente a `Rooms`                 | La tabla y el JSON usan nombres distintos                                                                                                                | pp. 13, 15             | Se usa `Rooms`                                                                                                                                                                                                                                                                                   | No                                        |
| C-15 | Tabla plana                                 | La jerarquía literal contradice los ejemplos                                                                                                             | pp. 13–14              | Las rutas salen de los ejemplos (§9.1)                                                                                                                                                                                                                                                           | No                                        |
| C-16 | Importes como string                        | `ExtraGuestCharges` se declara Decimal y llega como string; `RecommendedSellingRate` se declara String                                                   | pp. 13, 15             | `Decimalish` en todos los importes (§10)                                                                                                                                                                                                                                                         | No                                        |
| C-17 | `Supplements`                               | Se declara "List of Object" y llega como array de arrays                                                                                                 | pp. 14–17              | Se aceptan las dos formas y se normaliza por `Index`                                                                                                                                                                                                                                             | No                                        |
| C-18 | `RoomPromotion`                             | Se declara "List of String Array" y llega como array plano                                                                                               | pp. 14–15              | Array de strings                                                                                                                                                                                                                                                                                 | No                                        |
| C-19 | Tipos de `Index`                            | String en `CancelPolicies` e Integer en `Supplements`; la base del de políticas es desconocida                                                           | p. 14                  | Se aceptan string o número; base 1                                                                                                                                                                                                                                                               | → [Q-24](./10-preguntas-para-tbo.md#q-24) |
| C-20 | `MealType` de la respuesta                  | La tabla lista 3 valores, el enum 10 y el ejemplo usa uno de fuera de la tabla; el casing es mixto                                                       | pp. 14–15, 70          | Mapeo tolerante con el literal conservado (§9.8)                                                                                                                                                                                                                                                 | → [Q-28](./10-preguntas-para-tbo.md#q-28) |
| C-21 | `DayRates`                                  | Estructura por habitación y por noche no confirmable con ejemplos de una noche                                                                           | pp. 13, 24, 28         | Solo informativo                                                                                                                                                                                                                                                                                 | → [Q-21](./10-preguntas-para-tbo.md#q-21) |
| C-22 | `FromDate`                                  | Formato no documentado, sin zona horaria                                                                                                                 | pp. 14, 24, 50         | Hora local literal más la parseada (§9.6)                                                                                                                                                                                                                                                        | → [Q-24](./10-preguntas-para-tbo.md#q-24) |
| C-23 | Base de `Percentage` y moneda de `Fixed`    | No declaradas                                                                                                                                            | p. 14                  | `TotalFare` y moneda del `HotelResult`                                                                                                                                                                                                                                                           | → [Q-24](./10-preguntas-para-tbo.md#q-24) |
| C-24 | `IsRefundable` y tramos                     | Pueden contradecirse                                                                                                                                     | p. 50                  | Se guardan los dos, sin derivar uno de otro                                                                                                                                                                                                                                                      | → [Q-26](./10-preguntas-para-tbo.md#q-26) |
| C-25 | Unidad y moneda de los suplementos          | `Price` sin unidad; moneda distinta de la del hotel                                                                                                      | pp. 14–15, 31          | Se muestran tal cual, nunca se suman ni se convierten                                                                                                                                                                                                                                            | → [Q-27](./10-preguntas-para-tbo.md#q-27) |
| C-26 | `ExtraGuestCharges`                         | No se sabe si está incluido; cambia entre Search y PreBook con el mismo `TotalFare`                                                                      | pp. 13, 17, 28         | Solo informativo y solo para el vendedor                                                                                                                                                                                                                                                         | → [Q-22](./10-preguntas-para-tbo.md#q-22) |
| C-27 | Neto o bruto                                | Hay `AgentMarkup` y `BookingPrice` en la conciliación                                                                                                    | pp. 13, 63             | Perfiles TBO con markup 0                                                                                                                                                                                                                                                                        | → [Q-89](./10-preguntas-para-tbo.md#q-89) |
| C-28 | Alcance de `RecommendedSellingRate`         | "B2C client": no se dice si incluye B2B2C ni paquetes                                                                                                    | p. 13                  | Piso sobre todo precio al viajero (D02-4)                                                                                                                                                                                                                                                        | → [Q-23](./10-preguntas-para-tbo.md#q-23) |
| C-29 | `RoomID`                                    | Está en la nota de p. 57 pero no en la tabla ni en los ejemplos de Search; tipo y casing distintos de HotelDetails                                       | pp. 13–18, 56–57       | Opcional y tolerante (§9.9)                                                                                                                                                                                                                                                                      | → [Q-65](./10-preguntas-para-tbo.md#q-65) |
| C-30 | `Inclusion`                                 | Un único string; separador desconocido                                                                                                                   | p. 13                  | No se parte                                                                                                                                                                                                                                                                                      | → [Q-28](./10-preguntas-para-tbo.md#q-28) |
| C-31 | `201` con varios hoteles                    | No se dice si los hoteles sin disponibilidad se omiten                                                                                                   | pp. 9, 18              | Ausente = sin disponibilidad                                                                                                                                                                                                                                                                     | → [Q-20](./10-preguntas-para-tbo.md#q-20) |
| C-32 | Moneda del perfil                           | No se dice qué monedas admite un perfil ni si puede haber varias por cuenta                                                                              | p. 13                  | Puerta de moneda y guarda de exponente (§8)                                                                                                                                                                                                                                                      | → [Q-88](./10-preguntas-para-tbo.md#q-88) |
| C-33 | Tarifa solo-paquete                         | Aparece solo como texto en `RateConditions` de PreBook ("should be sold only with an airline ticket as part of a package"); Search no trae ninguna señal | pp. 25, 30             | Se detecta tras PreBook ([03](./03-prebook-y-book.md)); el listado puede mostrar tarifas que después no se pueden vender como hotel suelto                                                                                                                                                       | → [Q-31](./10-preguntas-para-tbo.md#q-31) |
| C-34 | Políticas de Search y de PreBook            | No se dice si las de Search con `true` coinciden con las de PreBook                                                                                      | pp. 11, 71             | Se marcan como indicativas                                                                                                                                                                                                                                                                       | → [Q-25](./10-preguntas-para-tbo.md#q-25) |
| C-35 | Path                                        | `/Search` en el PDF, `/search` en Postman                                                                                                                | pp. 7, 10; Postman     | Se usa `/Search`                                                                                                                                                                                                                                                                                 | No                                        |
| C-36 | `BeddingGroup`                              | Llega en cada `HotelResult[].Rooms[]` de producción (2026-09-30) y no está en la tabla ni en los ejemplos; tipo desconocido                              | pp. 13–18; producción  | Clave conocida con cualquier forma; un texto va a `bedOptions` (§9.9)                                                                                                                                                                                                                            | → [Q-28](./10-preguntas-para-tbo.md#q-28) |

---

## 12. Decisiones para el founder

Cada decisión se presenta como opciones. La primera es la recomendada.

**Estado al 2026-09-25:** el founder firmó D-TBO-02 (B), D-TBO-03 (A), D-TBO-06 (A) y D-TBO-07 (A) y pidió aplicar
la opción recomendada en todas las demás hasta nuevo aviso; lo que manda es el
[Registro de decisiones](./08-requisitos-maestro.md#registro-de-decisiones) de 08.

**D02-1: De dónde sale la nacionalidad del pasajero principal (`GuestNationality`).** TBO la usa para tarifar (INFERIDO: el PDF no lo dice), pide no fijarla en código y se exime de responsabilidad si se hace (p. 71). Hoy no se captura en la búsqueda, y el CRM la guarda en alfa-3.

- **A (recomendada).** Campo obligatorio y visible en la búsqueda (web y WhatsApp), prellenado con el cliente seleccionado (convertido a alfa-2) o con la última búsqueda del vendedor. Si falta, TBO no participa en esa búsqueda y se explica por qué.
- B. Valor por defecto = país del tenant, visible y editable. Es más rápido, pero en la práctica es un valor fijo por tenant y traslada a la agencia el riesgo de tarifas mal aplicadas.
- C. Valor por defecto configurado en la credencial TBO (`config.guestNationality`). Mismo riesgo que B, y además invisible para el vendedor.

**D02-2: Qué pasa cuando TBO cotiza en una moneda distinta de la de venta.** La moneda la fija el perfil de la credencial TBO, no el request (p. 13).

- **A (recomendada).** Una puerta de moneda como la de vuelos: se descartan las ofertas en otra moneda y se muestra el motivo. El vendedor puede cambiar la moneda de la búsqueda (por ejemplo a USD) para verlas. No se convierte nada.
- B. Cada tenant tiene una lista de monedas aceptadas, por ejemplo su moneda más USD. Las ofertas de esas monedas se muestran juntas, sin ordenarlas entre sí por precio.
- C. Convertir con una tasa de cambio. Contradice la doctrina vigente en vuelos ("una tasa inventada convierte un precio real en uno que nadie puede cobrar", `apps/api/src/search/search.service.ts:70-109`). No recomendada.

**D02-3: Cuántos hoteles TBO se consultan por búsqueda de destino.** TBO recomienda hasta 100 códigos por llamada (p. 10). Hoy se consultan los 50 primeros por id (`hotels.service.ts:131-141`).

- **A (recomendada para la salida).** Hasta 100 códigos TBO por búsqueda, en una sola llamada, elegidos por relevancia y no por id. La latencia es la de una llamada y no depende del QPS, que no se conoce.
- B. Lotes de 100 en paralelo, hasta 300 códigos. Da más cobertura, pero depende del QPS no publicado (p. 9) y consume la cuota de TBO más rápido. El código de lotes queda listo detrás de un flag para activarlo cuando TBO informe el QPS.
- C. Mantener 50. Es lo más simple, pero deja fuera la mitad de lo que TBO recomienda consultar.

**D02-4: Cómo se aplica el precio mínimo de TBO (`RecommendedSellingRate`).** TBO prohíbe vender por debajo a un "B2C client" (p. 13). Hoy el pricing waterfall no conoce pisos.

- **A (recomendada).** El piso se aplica a todo precio final al viajero, en todos los canales. Si la cascada queda por debajo, el precio sube hasta el piso y la diferencia se atribuye al tenant que vende.
- B. El piso se aplica solo en los canales donde el viajero compra directamente (web B2C y WhatsApp al viajero). En el panel B2B se muestra como aviso.
- C. Solo se muestra como aviso. Es el riesgo contractual más alto: la certificación de portal puede rechazarlo.

**D02-5: Credenciales TBO cuyo perfil está en una moneda sin 2 decimales (por ejemplo CLP, JPY o KWD).** `Money` asume siempre 2 decimales (`packages/canonical/src/money.ts:41-48`), así que esos importes saldrían mal por un factor de 10 o de 100.

- **A (recomendada).** El ACL rechaza esas monedas con un motivo visible, y se pide a TBO un perfil en USD o en otra moneda con 2 decimales. Generalizar `Money` queda como tarea transversal aparte.
- B. Generalizar ahora `Money` al exponente ISO 4217. Es lo correcto a largo plazo, pero toca todas las verticales y retrasa TBO.

**D02-6: Cuándo se muestran al vendedor las políticas de cancelación de TBO.** TBO recomienda buscar sin detalle, y las políticas vinculantes son las de PreBook (p. 71).

- **A (recomendada).** El listado va sin detalle y solo dice "reembolsable" o "no reembolsable". Al abrir un hotel se repite la búsqueda solo para ese hotel con detalle, y se muestran políticas y precio por noche como "sujetos a confirmación". El PreBook confirma.
- B. Nunca se pide detalle, y las políticas solo se ven tras el PreBook. Es lo más fiel a la recomendación de TBO, pero el vendedor elige a ciegas entre tarifas reembolsables.
- C. Siempre con detalle. Contradice la recomendación de TBO (p. 71) y hace las respuestas más pesadas y lentas.

---

## 13. Mapeo campo TBO → oferta de hotel del repo

Base: el contrato actual `HotelOffer` y `HotelRoompack` de `providers/despegar-hotels/src/types.ts` (VERIFICADO-CODIGO). En la línea base, estos tipos se promueven a un **contrato neutral de hotel** fuera del ACL de Despegar ([06](./06-seams-integracion-repo.md)). La columna "Falta" lista lo que ese contrato necesita para representar TBO.

**Si se elige la alternativa** (un módulo TBO paralelo que no toca `HotelsService`), los mismos campos se añaden a un tipo propio del ACL TBO. La web tendría que duplicar el espejo de tipos (`apps/web-b2b/src/app/(app)/hoteles/actions.ts:5-83`), y la puerta de moneda y la deduplicación entre proveedores dejarían de ser posibles.

### 13.1 Tabla de mapeo

| Campo TBO                                 | Destino hoy (`types.ts`)                                                                           | Transformación                                                                                                               | Falta en el contrato (propuesta de nombre)                                                                                                                                  | Evidencia                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `Status.Code`                             | — (no es un dato de la oferta)                                                                     | `200`: mapear; `201`: `[]`; resto: error tipado ([01](./01-autenticacion-conectividad-y-errores.md))                         | Resultado por proveedor (`providers[]` con estado `empty`), como en vuelos                                                                                                  | VERIFICADO-PDF pp. 8–10, 18                 |
| `HotelResult[].HotelCode`                 | `HotelOffer.hotelId` (`:85`)                                                                       | `String(HotelCode)`                                                                                                          | `HotelOffer.provider.name = 'tbo-hotels'` (en `ProviderRefSchema` el código del proveedor va en `name`, `offer.ts:67`), para distinguir espacios de ids                     | VERIFICADO-PDF p. 13                        |
| (no viene en Search)                      | `HotelOffer.name`, `stars`, `type`, `location` (`:86-89`)                                          | Se enriquece desde `hotel_inventory` por `(provider_code, hotel_id)` ([05](./05-contenido-estatico-e-inventario.md))         | —                                                                                                                                                                           | VERIFICADO-PDF pp. 13–15 (ausencia)         |
| `HotelResult[].Currency`                  | `currency` de todo `Money` del pack                                                                | Directo, con la guarda de exponente (§8.3)                                                                                   | —                                                                                                                                                                           | VERIFICADO-PDF p. 13                        |
| `Rooms[]` (cada elemento)                 | `HotelRoompack` (`:74-82`)                                                                         | Un elemento = un pack (§9.3)                                                                                                 | —                                                                                                                                                                           | VERIFICADO-PDF pp. 13, 16–18                |
| `Rooms[].BookingCode`                     | `HotelRoompack.id` (`:75`)                                                                         | `id = BookingCode`                                                                                                           | **`HotelRoompack.provider = { name, offerRef: BookingCode, raw: { searchId } }`**. Hoy el token está por habitación (`HotelRoomItem.choiceId`, `:54-55`) y no hay proveedor | VERIFICADO-PDF p. 13                        |
| (derivado) `searchSentAt` + 27 min        | —                                                                                                  | `expiresAt` = 30 min de p. 8 menos 120 s del Book y 60 s de margen ([01](./01-autenticacion-conectividad-y-errores.md) §6.3) | **`HotelRoompack.expiresAt`** (ISO con offset)                                                                                                                              | VERIFICADO-PDF p. 8; el margen es Postura   |
| `Rooms[].Name[j]`                         | `rooms[j].name` (`:49`)                                                                            | Directo                                                                                                                      | —                                                                                                                                                                           | VERIFICADO-PDF p. 13                        |
| (índice `j`)                              | `rooms[j].reference` (`:50`)                                                                       | `j + 1`                                                                                                                      | —                                                                                                                                                                           | INFERIDO                                    |
| `Rooms[].RoomID[j]`                       | `rooms[j].roomTypeId` (`:51`)                                                                      | Solo si es distinto de `"0"` o `0`                                                                                           | —                                                                                                                                                                           | VERIFICADO-PDF p. 57                        |
| (request) `PaxRooms[j]`                   | —                                                                                                  | Copia de la ocupación buscada                                                                                                | **`rooms[j].occupancy: RoomDistribution`**: la necesita el Book para `CustomerDetails[j]` ([03](./03-prebook-y-book.md))                                                    | VERIFICADO-PDF pp. 10–11, 32                |
| (no viene)                                | `rooms[j].maxCapacity`, `bedOptions` (`:52-53`)                                                    | `undefined` / `[]`                                                                                                           | —                                                                                                                                                                           | VERIFICADO-PDF (ausencia)                   |
| (no aplica)                               | `rooms[j].choiceId` (`:55`)                                                                        | `undefined`                                                                                                                  | —                                                                                                                                                                           | —                                           |
| `Rooms[].MealType`                        | `HotelRoompack.board` (`:76`)                                                                      | Tabla de §9.8                                                                                                                | **`boardLabel`** y **`mealTypeRaw`**                                                                                                                                        | VERIFICADO-PDF pp. 14, 70                   |
| `Rooms[].TotalFare`                       | `price.total` (`:39`, "Neto del proveedor")                                                        | Decimal exacto → `Money` (§8.3)                                                                                              | El literal decimal va al contexto de búsqueda del servidor, no al tipo público                                                                                              | VERIFICADO-PDF p. 13                        |
| `Rooms[].TotalTax`                        | `price.taxes` (`:40`)                                                                              | Decimal → `Money`                                                                                                            | —                                                                                                                                                                           | VERIFICADO-PDF p. 13                        |
| (no viene)                                | `price.taxesDetail` (`:41`)                                                                        | `[]`                                                                                                                         | —                                                                                                                                                                           | VERIFICADO-PDF (ausencia)                   |
| `Rooms[].DayRates[j][n].BasePrice`        | —                                                                                                  | Decimal redondeado, solo informativo                                                                                         | **`price.nightly?: Money[][]`** (por habitación y noche; estructura INFERIDA)                                                                                               | VERIFICADO-PDF p. 13; pp. 24, 28            |
| `Rooms[].ExtraGuestCharges`               | —                                                                                                  | Decimal → `Money`; no se suma                                                                                                | **`price.extraGuestCharges?: Money`** (informativo, solo vendedor)                                                                                                          | VERIFICADO-PDF pp. 13, 15                   |
| `Rooms[].RecommendedSellingRate`          | —                                                                                                  | Decimal → `Money`; piso del waterfall (§9.5)                                                                                 | **`price.minimumSellingPrice?: Money`**                                                                                                                                     | VERIFICADO-PDF p. 13                        |
| (sin equivalente TBO)                     | `price.agencyCommission` (`:45`)                                                                   | `undefined`: TBO no expone comisión                                                                                          | —                                                                                                                                                                           | VERIFICADO-PDF pp. 12–15 (ausencia)         |
| `Supplements[j][]` con `Type: AtProperty` | `price.chargeAtDestination` (`:43`): **insuficiente** (un solo importe, en la moneda del pack)     | Uno por suplemento, en su moneda; nunca se suma                                                                              | **`atPropertyCharges[]: { roomIndex, description, descriptionRaw, amount: Money, amountText? }`**                                                                           | VERIFICADO-PDF pp. 14–15, 71                |
| `Supplements[j][]` con `Type: Included`   | —                                                                                                  | Informativo                                                                                                                  | **`includedSupplements[]`** (misma forma)                                                                                                                                   | VERIFICADO-PDF p. 14                        |
| `Rooms[].IsRefundable`                    | `cancellation.refundable` (`:24`) y `cancellation.status` (`:25`)                                  | §9.6                                                                                                                         | **`cancellation.policySource: 'none', 'search-indicative' o 'prebook-final'`**                                                                                              | VERIFICADO-PDF p. 14                        |
| `CancelPolicies[]`                        | `cancellation.rules[]` (`:28`): **insuficiente** (horas relativas, sin importe fijo ni habitación) | `type` ← `ChargeType`; `penaltyPercentage` ← `CancellationCharge` si es `Percentage`                                         | **En cada regla:** `fromLocalDateTime` (sin offset) + `fromDateRaw`, `penaltyAmount?: Money` (para `Fixed`), `roomIndex?` (de `Index`)                                      | VERIFICADO-PDF p. 14; pp. 24, 50            |
| (derivado de `CancelPolicies`)            | `cancellation.hoursBeforePenalty` (`:26`)                                                          | `undefined`: exigiría inventar la zona horaria y la hora de check-in                                                         | **`cancellation.freeCancellationUntilLocal?`**                                                                                                                              | INFERIDO                                    |
| `Rooms[].RoomPromotion[j]`                | —                                                                                                  | Directo                                                                                                                      | **`rooms[j].promotions: string[]`**                                                                                                                                         | VERIFICADO-PDF p. 14                        |
| `Rooms[].Inclusion`                       | —                                                                                                  | Directo, sin partir                                                                                                          | **`HotelRoompack.inclusionText?`**                                                                                                                                          | VERIFICADO-PDF p. 13                        |
| `Rooms[].WithTransfers`                   | —                                                                                                  | Directo                                                                                                                      | **`HotelRoompack.includesTransfers: boolean`**                                                                                                                              | VERIFICADO-PDF p. 14                        |
| (servicio) waterfall + piso               | `HotelRoompack.pricing` (`:81`, `HotelPricing` `:64-71`)                                           | `applyCascade` + `max(…, minimumSellingPrice)` (§9.5)                                                                        | `HotelPricing` sale del ACL hacia el contrato neutral o el API ([06](./06-seams-integracion-repo.md))                                                                       | VERIFICADO-CODIGO `hotels.service.ts:47-64` |

### 13.2 Resumen de lo que le falta al contrato actual para representar TBO

1. **Referencia de proveedor en la oferta y en el pack**, con el token reservable a nivel de pack: `provider = { name, offerRef, raw }`, al estilo de `ProviderRefSchema` (`packages/canonical/src/offer.ts:66-88`). Sin esto, `prebook` y `book` no saben a qué proveedor enrutar.
2. **Cargos a pagar en el hotel como lista, por habitación y en su propia moneda** (`atPropertyCharges[]`), además de los suplementos incluidos. `chargeAtDestination` no alcanza.
3. **Precio mínimo de venta** (`minimumSellingPrice`), consumido por el pricing waterfall como piso.
4. **Ocupación por habitación dentro del pack** (`rooms[j].occupancy`). La combinación multi-habitación ya existe como `HotelRoompack`, pero sin saber qué ocupación cubre cada habitación.
5. **Vencimiento de la oferta** (`expiresAt`).
6. **Políticas de cancelación con fecha absoluta local, importe fijo, índice de habitación y origen** (`fromLocalDateTime`, `penaltyAmount`, `roomIndex`, `policySource`).
7. **Régimen con etiqueta y literal** (`boardLabel`, `mealTypeRaw`). `BoardType` tiene solo 5 valores y TBO usa 10.
8. **Atributos de tarifa**: `includesTransfers`, `inclusionText`, `promotions` por habitación, `extraGuestCharges` (informativo) y `nightly` (desglose por noche opcional).
9. En el criterio de búsqueda neutral (no en la oferta): **`guestNationality`** (§5), y la moneda entendida como "moneda de venta de la búsqueda" (§8.2).
