---
titulo: 'TBO Hotels — Contenido estático e inventario'
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Contenido estático e inventario

> **Fuentes:** ver [00-fuentes.md](./00-fuentes.md). "(p. N)" es la página **física** del PDF. Desde la p. 64 el pie
> impreso marca N−5 (la p. 65 dice "60"), y el índice de pp. 2-4 tiene números corruptos: no sirve para ubicar
> nada (VERIFICADO-PDF, pp. 2-4, 64-71).
>
> **Etiquetas:** VERIFICADO-PDF, VERIFICADO-POSTMAN, VERIFICADO-CERT, VERIFICADO-CODIGO, INFERIDO. Una inferencia
> nunca se presenta como verificada. Lo marcado **PROPUESTA** es diseño, no código existente.
>
> **Qué cubre este documento:** los cinco métodos de contenido estático (`CountryList`, `CityList`,
> `hotelcodelist`, `TBOHotelCodeList`, `HotelDetails`), cómo se sincronizan a nuestra base, cómo se traduce un
> destino de la UI a hoteles TBO y cómo se evita mostrar dos veces el mismo hotel. **No cubre:** autenticación y
> errores ([01](./01-autenticacion-conectividad-y-errores.md)), Search y la oferta canónica
> ([02](./02-search-y-oferta-canonica.md)), `BookingDetailsBasedOnDate` y conciliación
> ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)).

---

## 0. Resumen

1. **Sin catálogo local no hay búsqueda TBO.** Search solo acepta `HotelCodes` (string CSV, "Recommended Value; 100
   hotel codes") y su respuesta no trae nombre, estrellas, dirección, coordenadas ni imágenes
   (VERIFICADO-PDF, p. 10, 13-15). Hacen falta dos catálogos propios: **destino → `HotelCodes`** (en
   `hotel_inventory`) y **`HotelCode` → contenido** (tabla nueva). Es la misma situación que ya resolvimos para
   Despegar, pero con otra forma de descarga.
2. **Cinco métodos, dos GET.** `CountryList` y `hotelcodelist` son GET; `CityList`, `TBOHotelCodeList` y
   `HotelDetails` son POST. `hotelcodelist` **solo existe en el PDF**: Postman no lo trae (VERIFICADO-PDF p. 51,
   54-55; VERIFICADO-POSTMAN).
3. **Las tablas del PDF no describen lo que viaja.** Contenedores declarados `Object` llegan como array, campos
   `Integer` llegan como string, campos `String` llegan como array u objeto, y `HotelRating` es enum en un método y
   número en otro (§3). El borde Zod del ACL acepta uniones y normaliza a un solo tipo canónico.
4. **Pipeline recomendado:** `CountryList` → `CityList` (solo países habilitados) → `TBOHotelCodeList` por ciudad
   → `hotel_inventory` con `provider_code = 'tbo-hotels'` mediante **upsert + barrido por ciudad**;
   `HotelDetails` por lotes (ES/PT/EN) → `hotel_content`; `hotelcodelist` semanal para detectar bajas (§6).
5. **Herramienta aparte, no extender la de Despegar.** `tools/sync-hotel-inventory` hace una sola llamada y un
   `DELETE` + `INSERT` atómico por proveedor. TBO son miles de llamadas con fallos parciales: un `DELETE` global
   dejaría el catálogo vacío si la corrida se corta (§5, §6.2).
6. **Migración nueva.** Código de ciudad como `TEXT` (TBO lo manda como string aunque la tabla diga Integer),
   baja lógica (`active`, `last_seen_at`), ciudades por proveedor con centroide, contenido por idioma, contenido
   por habitación, mapa de destinos y equivalencias de hotel (§7).
7. **Destino.** Hoy `destinationId` es el id geográfico de Despegar de punta a punta. En fase 1 se traduce a
   `CityCode` de TBO con una tabla de mapeo calculada fuera de línea (solapamiento de hoteles equivalentes +
   centroide, reforzado con país ISO2 y nombre normalizado). Un destino sin mapeo aceptado **no consulta TBO**. El
   autocomplete propio y GIATA quedan para después (§8).
8. **¿Catálogo global o por cuenta?** El contrato no lo dice. Postura: global, sincronizado con una cuenta TBO de
   plataforma separada de la de ventas; se verifica con una sonda comparativa durante la certificación
   → [Q-60](./10-preguntas-para-tbo.md#q-60) (§11).

---

## 1. Alcance y métodos

| § PDF | Método (literal)         | Path según PDF                       | Path según Postman            | HTTP | Páginas | Evidencia                                                      |
| ----- | ------------------------ | ------------------------------------ | ----------------------------- | ---- | ------- | -------------------------------------------------------------- |
| 11    | `CountryList`            | `BaseURL/CountryList`                | `/CountryList`                | GET  | 51-53   | VERIFICADO-PDF, VERIFICADO-POSTMAN (Postman: CountryList)      |
| 12    | `CityList`               | `BaseURL/CityList`                   | `/CityList`                   | POST | 53-54   | VERIFICADO-PDF, VERIFICADO-POSTMAN (Postman: CityList)         |
| 13    | `HotelCodeList` (título) | `BaseURL/hotelcodelist` (minúsculas) | **no existe**                 | GET  | 54-55   | VERIFICADO-PDF; ausencia VERIFICADO-POSTMAN                    |
| 16    | `TBOHotelCodeList`       | `BaseURL/TBOHotelCodeList`           | `/TBOHotelCodeList`           | POST | 65-69   | VERIFICADO-PDF, VERIFICADO-POSTMAN (Postman: TBOHotelCodeList) |
| 14    | `HotelDetails`           | `BaseURL/HotelDetails`               | `/Hoteldetails` (d minúscula) | POST | 56-62   | VERIFICADO-PDF, VERIFICADO-POSTMAN (Postman: Hotel Details)    |

- La tabla de endpoints del PDF (pp. 7-8) solo lista Search, PreBook, Book, BookingDetail y Cancel; **ningún
  método estático** (VERIFICADO-PDF).
- Change log: los estáticos entran en la v1.2 del 5-abr-2022 ("CountryList, citylist, hotelcode & hoteldetails"),
  `TBOHotelCodeList` en la v1.6 del 15-mar-2023, y el detalle por habitación de `HotelDetails` el 27-oct-2025
  sin subir la versión, que sigue en "2.1" (VERIFICADO-PDF, pp. 5-6).
- El documento de certificación no menciona los métodos estáticos. Sí pide declarar "what API methods are used"
  en el workflow que se entrega a TBO (VERIFICADO-CERT). El detalle está en [07](./07-certificacion.md).
- **PCI:** ninguno de estos métodos recibe ni devuelve datos de tarjeta (VERIFICADO-PDF, pp. 51-69). D1 no se ve
  afectada. Lo único cercano es texto informativo del hotel ("a credit card, debit card, or cash deposit may be
  required at check-in", dentro de `Description`, p. 60), que se muestra como política del hotel.

---

## 2. Contrato de los métodos

### 2.1 Convenciones comunes

| Tema                  | Contrato                                                                                                                                                                                                                                                           | Evidencia                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Autenticación         | Basic Auth con usuario y contraseña de TBO. Postman la declara a nivel colección, vacía, y ninguna request define headers (`"header": []`).                                                                                                                        | VERIFICADO-PDF p. 7; VERIFICADO-POSTMAN          |
| Base URL de test      | `http://api.tbotechnology.in/TBOHolidays_HotelAPI` (http, no https). La live es `{Live-URL}/HotelAPI`.                                                                                                                                                             | VERIFICADO-PDF p. 7; VERIFICADO-CERT             |
| Resultado             | En el cuerpo: `Status.Code` (Integer) y `Status.Description` (String). No se documenta el HTTP que lo acompaña.                                                                                                                                                    | VERIFICADO-PDF pp. 8-10                          |
| Método y Content-Type | La tabla de autenticación declara `Method POST` y `Content-Type application/json` para `BaseURL` en general, pero `CountryList` y `hotelcodelist` se declaran GET sin cuerpo, y Postman manda `CountryList` por GET. Se sigue el método declarado en cada sección. | VERIFICADO-PDF pp. 7, 51, 55; VERIFICADO-POSTMAN |
| Errores de ejemplo    | Ningún método estático trae ejemplo de error. Los ejemplos que traen `Status` son `200`; el de `hotelcodelist` no trae `Status` (p. 55).                                                                                                                           | VERIFICADO-PDF pp. 51-69                         |
| Timeouts              | La tabla de timeouts solo cubre Search, PreBook y Book. Nada para estáticos.                                                                                                                                                                                       | VERIFICADO-PDF p. 8                              |
| Límite de tasa        | `LIMIT_EXCEEDED` = 429, "Requests have exceeded allowed QPS". El QPS no se publica.                                                                                                                                                                                | VERIFICADO-PDF p. 9                              |
| Deltas                | Ningún método ofrece "modified since", ETag ni paginación. Toda sincronización es completa.                                                                                                                                                                        | VERIFICADO-PDF pp. 51-69 (ausencia)              |

El tratamiento de `Status.Code`, http frente a https y redacción de la cabecera `Authorization` está en
[01](./01-autenticacion-conectividad-y-errores.md). Aquí solo importa que **el sync lee siempre `Status.Code` del
cuerpo** y nunca compara `Status.Description`, que cambia entre métodos (`"Success"` en pp. 52, 54 y 67;
`"Successful"` en p. 59).

### 2.2 `CountryList` (GET, pp. 51-53)

- Description: "This API method is used to fetch the complete unique TBOH Country code list in response."
  Request: "No parameter required in Body" (VERIFICADO-PDF p. 51).
- Postman: `GET …/CountryList`, sin cuerpo (VERIFICADO-POSTMAN, Postman: CountryList).

| Ruta                 | Tipo (tabla) | Tipo observado | Descripción (literal)                     | Cita  |
| -------------------- | ------------ | -------------- | ----------------------------------------- | ----- |
| `Status.Code`        | Integer      | número `200`   | "Internal code to denote response status" | p. 52 |
| `Status.Description` | String       | `"Success"`    | "Descriptive message."                    | p. 52 |
| `CountryList`        | Object       | **array**      | —                                         | p. 52 |
| `CountryList[].Code` | String       | `"AL"`         | "ISO Country code (eg. AE)"               | p. 52 |
| `CountryList[].Name` | String       | `"Albania"`    | "Country name"                            | p. 52 |

Ejemplo del PDF, recortado. **JSON inválido en el original**: termina en `},` en la p. 53 y no cierra el array.

```json
{
  "Status": { "Code": 200, "Description": "Success" },
  "CountryList": [
    { "Code": "AL", "Name": "Albania" },
    { "Code": "AD", "Name": "Andorra" },
    { "Code": "AG", "Name": "Antigua" }
```

Notas:

- Los nombres del ejemplo están en inglés y alguno abreviado (`"Antigua"`, no "Antigua and Barbuda"); que toda la
  lista sea así es INFERIDO. No hay parámetro de idioma (VERIFICADO-PDF pp. 51-52). Nunca mostramos estos nombres:
  la UI usa sus propios nombres de país por ISO2.
- Uso en el pipeline: validar que cada país habilitado existe en TBO y obtener el `CountryCode` para `CityList`.
  Que sea un código ISO lo dice la tabla ("ISO Country code (eg. AE)"); que sea alpha-2 lo muestran los ejemplos;
  que coincida con el `GuestNationality` de Search (p. 10) es INFERIDO.

### 2.3 `CityList` (POST, pp. 53-54)

- Description: "This API method used to fetch the complete city code and name for the requested country."
  (VERIFICADO-PDF p. 53).

| Request       | Tipo (tabla) | Obligatorio                                | Descripción            | Cita  |
| ------------- | ------------ | ------------------------------------------ | ---------------------- | ----- |
| `CountryCode` | String       | No indicado; INFERIDO sí (único parámetro) | "Code of the country." | p. 53 |

Ejemplo PDF: `{"CountryCode":"AT"}` (p. 53). Postman: `{"CountryCode" :"MV"}` (VERIFICADO-POSTMAN, Postman: CityList).

| Response                             | Tipo (tabla)     | Tipo observado        | Descripción        | Cita      |
| ------------------------------------ | ---------------- | --------------------- | ------------------ | --------- |
| `Status.Code` / `Status.Description` | Integer / String | `200` / `"Success"`   | —                  | pp. 53-54 |
| `CityList`                           | Object           | **array**             | —                  | p. 54     |
| `CityList[].Code`                    | **Integer**      | **String** `"100758"` | "Code of the city" | p. 54     |
| `CityList[].Name`                    | String           | `"Abersee"`           | "Name of City"     | p. 54     |

Ejemplo del PDF, recortado. **JSON inválido en el original**: no cierra ni el array ni el objeto (p. 54).

```json
{
  "Status": { "Code": 200, "Description": "Success" },
  "CityList": [
    { "Code": "100758", "Name": "Abersee" },
    { "Code": "100117", "Name": "Abfaltersbach" }
```

Notas:

- Cada ciudad trae solo `Code` y `Name`: **ni coordenadas, ni región, ni IATA, ni zona horaria** (VERIFICADO-PDF
  p. 54). El ejemplo de Austria incluye aldeas (Abersee, Abfaltersbach), y "complete city code" apunta a que la
  lista es exhaustiva (INFERIDO). Consecuencia: el sync gasta una llamada de `TBOHotelCodeList` por aldea que
  quizá no tenga hoteles (§6.7).
- Que `CityList[].Code`, `TBOHotelCodeList.CityCode` (p. 65) y `HotelDetails[].CityId` (p. 59, 62) sean el mismo
  espacio de códigos es INFERIDO: los tres se describen como "Code of the city" o "Unique TBOH City code".

### 2.4 `hotelcodelist` (GET, pp. 54-55; solo en el PDF)

- Description: "This API method is used to fetch the complete hotel code list in response". URL qualifier
  `BaseURL/hotelcodelist`, en minúsculas. Request: "No parameter required in the body" (VERIFICADO-PDF pp. 54-55).
- **No hay request en Postman** para este método (VERIFICADO-POSTMAN: los 10 items son Search, PreBook,
  HotelBook, BookingDetail, BookingDetailsBasedOnDate, Cancel, CountryList, CityList, TBOHotelCodeList y Hotel
  Details).

| Response                                                | Tipo (tabla) | Tipo observado       | Descripción                   | Cita  |
| ------------------------------------------------------- | ------------ | -------------------- | ----------------------------- | ----- |
| `HotelCodes` (la tabla dice "Hotel Codes", con espacio) | Integer      | **array de enteros** | "Unique TBOH hotel code list" | p. 55 |

Ejemplo literal. **JSON inválido en el original**: usa líneas con `.` como relleno.

```json
{
  "HotelCodes": [
    1000000,
    1000001,
    1000002,
    .
    .
    5000008
  ]
}
```

Notas:

- **No trae objeto `Status`**, a diferencia del resto (VERIFICADO-PDF p. 55).
- Los códigos salen como **enteros**; en Search, `HotelDetails` y `TBOHotelCodeList` salen como string
  (VERIFICADO-PDF pp. 15, 59, 67). Normalizamos todo a string.
- Es una lista plana y global: no asocia hotel con ciudad ni país. **No sirve para buscar por destino**; sirve para
  detectar bajas del catálogo (§6.3, etapa E5). El tamaño real no se documenta: el rango del ejemplo puede ser
  ilustrativo (INFERIDO).

### 2.5 `TBOHotelCodeList` (POST, pp. 65-69)

- Description: "…fetch the complete detail of the Hotel like Hotel name, Hotel address, Hotel Description, Images
  etc associated with the city using CityCode." (VERIFICADO-PDF p. 65).

| Request              | Nombre en tabla      | Tipo (tabla) | Tipo en ejemplos                                  | Obligatorio                    | Descripción                                                    | Cita                             |
| -------------------- | -------------------- | ------------ | ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- | -------------------------------- |
| `CityCode`           | "City Code"          | Integer      | **String** `"130452"` (PDF), `"130543"` (Postman) | No indicado; INFERIDO sí       | "Unique TBOH City code."                                       | p. 65; Postman: TBOHotelCodeList |
| `IsDetailedResponse` | `IsDetailedResponse` | Boolean      | **String** `"true"` en PDF y Postman              | No indicado; INFERIDO opcional | "To get additional details related to Hotels in the response." | p. 65; Postman                   |

| Response                                                         | Tipo (tabla)            | Tipo / valor observado                                                                                       | Cita      |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| `Status.Code`                                                    | Integer                 | `200`                                                                                                        | p. 65, 67 |
| `Status.Description`                                             | **no está en la tabla** | `"Success"`                                                                                                  | p. 67     |
| `Hotels`                                                         | Object                  | **array**                                                                                                    | p. 66-67  |
| `Hotels[].HotelCode`                                             | Integer                 | **String** `"1010099"`                                                                                       | p. 66-67  |
| `Hotels[].HotelName`                                             | String                  | `"Holiday Inn Express New York - Manhattan West Side"`                                                       | p. 66-67  |
| `Hotels[].HotelRating`                                           | Enumeration             | **enum string** `"ThreeStar"`                                                                                | p. 66-67  |
| `Hotels[].Address`                                               | String                  | `"538 West 48th Street New York CityNew York 10036 "` (espacio final, sin separador)                         | p. 66-67  |
| `Hotels[].Attractions`                                           | String                  | **array de strings** (parece un HTML partido en las comas, INFERIDO; ver notas)                              | p. 66-68  |
| `Hotels[].CountryName`                                           | String                  | `"USA"`                                                                                                      | p. 66, 68 |
| `Hotels[].CountryCode`                                           | Integer                 | **String ISO** `"US"`                                                                                        | p. 66, 68 |
| `Hotels[].Description`                                           | String                  | HTML con secciones `HeadLine`, `Location`, `Rooms`, `Dining`, `CheckIn Instructions`, `Special Instructions` | p. 66, 68 |
| `Hotels[].FaxNumber`                                             | Integer                 | **String** `"1-212-582-0693"`                                                                                | p. 66, 68 |
| `Hotels[].HotelFacilities`                                       | String                  | **array de strings**                                                                                         | p. 66, 68 |
| `Hotels[].Map`                                                   | String                  | `"40.764167\|-73.994468"` (`lat\|lon`)                                                                       | p. 66, 69 |
| `Hotels[].PhoneNumber`                                           | String                  | `"1-212-582-0692"`                                                                                           | p. 66, 69 |
| `Hotels[].PinCode`                                               | Integer                 | **String** `"10036"`                                                                                         | p. 66, 69 |
| `Hotels[].CityId`                                                | Integer                 | **ausente en el ejemplo**                                                                                    | p. 66     |
| `Hotels[].HotelWebsiteURL` (tabla) / `HotelWebsiteUrl` (ejemplo) | String                  | URL                                                                                                          | p. 66, 69 |
| `Hotels[].CityName`                                              | String                  | `"New York"`                                                                                                 | p. 66, 69 |

Ejemplo del PDF, recortado. **JSON inválido en el original**: `Attractions` está elidido con líneas `/`, parte
del texto cae fuera del recuadro (p. 67) y el ejemplo termina en `},` sin cerrar `Hotels` ni la raíz (p. 69).

```json
{
  "Status": { "Code": 200, "Description": "Success" },
  "Hotels": [
    {
      "HotelCode": "1010099",
      "HotelName": "Holiday Inn Express New York - Manhattan West Side",
      "HotelRating": "ThreeStar",
      "Address": "538 West 48th Street New York CityNew York 10036 ",
      "Attractions": [
        "Distances are displayed to the nearest 0.1 mile and kilometer. <br /> <p> American Lyric Theater - 0.9 km / 0.5 mi <br /> …",
        " NY (NYS-Skyports Seaplane Base) - 4.9 km / 3 mi<br /> Teterboro",
        " NJ (TEB) - 18.7 km / 11.6 mi<br /> </p><p>The preferred airport for … is LaGuardia Airport (LGA). </p>"
      ],
      "CountryName": "USA",
      "CountryCode": "US",
      "Description": "<p>HeadLine : Near Gershwin Theater</p><p>Location : …</p>",
      "FaxNumber": "1-212-582-0693",
      "HotelFacilities": ["Visual alarms in hallways", "elevator", "Free breakfast", "Free WiFi"],
      "Map": "40.764167|-73.994468",
      "PhoneNumber": "1-212-582-0692",
      "PinCode": "10036",
      "HotelWebsiteUrl": "http://www.ihg.com/holidayinnexpress/hotels/us/en/new-york/nychk/hotel",
      "CityName": "New York"
    },
```

Notas:

- **Ni la tabla ni el ejemplo traen `Images`, `CheckInTime` ni `CheckOutTime`**, aunque la descripción del método
  dice "Images etc" (VERIFICADO-PDF pp. 65-69). Las imágenes y los horarios salen solo de `HotelDetails`.
- Como `CityId` no llega en el ejemplo, **la ciudad de cada hotel se toma del `CityCode` de la request**, no de la
  respuesta.
- Key point: "It is strongly recommended to pass IsDetailedResponse as 'False', as it will decrease the overall
  response size and time." (VERIFICADO-PDF p. 71). El bullet no dice a qué método aplica, y `IsDetailedResponse`
  existe también en Search (p. 11). **No se documenta qué campos llegan con `false`**. Si faltaran `Map`,
  `HotelRating` o `CountryCode`, el pipeline no podría llenar `hotel_inventory` ni calcular centroides. Postura:
  §6.3, etapa E3 → [Q-63](./10-preguntas-para-tbo.md#q-63).
- `Attractions` como array parece un único HTML cortado en cada coma ("Teterboro**,** NJ"): para mostrarlo se
  unen los elementos con `","` (INFERIDO, p. 67).

### 2.6 `HotelDetails` (POST, pp. 56-62)

Description: "…fetch the complete detail of the Hotel like Hotel name, Hotel address, Hotel Description, Images
etc." (VERIFICADO-PDF p. 56).

#### 2.6.1 Request

| Ruta (literal)             | En la tabla (p. 58)     | Tipo (tabla) | Tipo en ejemplos                                                                             | Descripción                                                                                                                                 | Cita                               |
| -------------------------- | ----------------------- | ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `Hotelcodes` (c minúscula) | "Hotel Code" (singular) | Integer      | número `1000000` (p. 58); string `"1261320"` (p. 56); **string CSV de 13 códigos** (Postman) | "Unique TBOH Hotel code."                                                                                                                   | pp. 56, 58; Postman: Hotel Details |
| `Language`                 | `Language`              | String       | `"EN"` (p. 58, Postman), `"en"` (p. 56)                                                      | "Code of preferred language to retrieve response. AR – Arabic, ES – Spanish, PT – Portuguese, FR – French, ZH- Chinese/Traditional Chinese" | pp. 56, 58                         |
| `IsRoomDetailRequired`     | **no está en la tabla** | —            | boolean `true`                                                                               | "Add "IsRoomDetailRequired": true in the HotelDetails API request."                                                                         | p. 56                              |

- **El casing que se envía es `Hotelcodes`**, no el `HotelCodes` de Search: PDF y Postman coinciden en esta forma
  (VERIFICADO-PDF pp. 56, 58; VERIFICADO-POSTMAN).
- Postman manda **13 códigos en un solo string separado por comas**, los mismos 13 de su request Search
  (VERIFICADO-POSTMAN). **El máximo por llamada no está documentado** (§10).
- **La lista de idiomas no incluye `EN`**, aunque todos los ejemplos lo usan. Para LATAM importan `ES` y `PT`, que
  sí están (VERIFICADO-PDF p. 58).

Request de Postman (literal):

```json
{
  "Hotelcodes": "376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547",
  "Language": "EN"
}
```

#### 2.6.2 Response (tabla pp. 58-59, leída sobre la imagen; la extracción de texto desalinea la columna Descripción)

| Ruta                                 | Tipo (tabla)     | Tipo / valor observado (pp. 59-62)                                                             | Descripción (literal)                                      |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Status.Code` / `Status.Description` | Integer / String | `200` / `"Successful"`                                                                         | —                                                          |
| `HotelDetails`                       | Object           | **array**                                                                                      | —                                                          |
| `HotelDetails[].HotelCode`           | Integer          | **String** `"1000000"`                                                                         | "Unique TBOH hotel codes"                                  |
| `HotelDetails[].HotelName`           | String           | `"Sofitel Legend Old Cataract Aswan"`                                                          | "Hotel name against TBOH hotel code"                       |
| `HotelDetails[].Description`         | String           | HTML con `<p>HeadLine : …</p><p>Location : …</p>…&nbsp;<br/><b>Disclaimer notification: …</b>` | "A short description about the requested hotel"            |
| `HotelDetails[].HotelFacilities`     | String           | **array de strings** (47 en el ejemplo)                                                        | "Display all available hotel facilities"                   |
| `HotelDetails[].Attractions`         | String           | **objeto** `{ "1) ": "<html>" }`                                                               | "It shows the nearby locations, and the attractions point" |
| `HotelDetails[].Images`              | String           | **array de URLs**                                                                              | "All Hotel images link"                                    |
| `HotelDetails[].Address`             | String           | dirección completa con ciudad, CP y país                                                       | "Address first line of the hotel booked"                   |
| `HotelDetails[].PinCode`             | Integer          | **String** `"81511"`                                                                           | "Pin code of hotel's city"                                 |
| `HotelDetails[].CityId`              | Integer          | **String** `"109642"`                                                                          | "Code of the city"                                         |
| `HotelDetails[].CountryName`         | String           | `"Egypt"`                                                                                      | "Name of the Country"                                      |
| `HotelDetails[].PhoneNumber`         | String           | `"+20972316000"`                                                                               | "Phone number of the Hotel booked"                         |
| `HotelDetails[].FaxNumber`           | Integer          | **String** `"+20972316011"`                                                                    | "Fax number of the hotel"                                  |
| `HotelDetails[].HotelRating`         | Enumeration      | **número** `5`                                                                                 | "Star Rating of the hotel booked"                          |
| `HotelDetails[].Map`                 | String           | `"24.08166\|32.88985"`                                                                         | "Contains latitude, longitude information"                 |
| `HotelDetails[].CityName`            | String           | `"Aswan"`                                                                                      | "Name of City"                                             |
| `HotelDetails[].CountryCode`         | Integer          | **String ISO** `"EG"`                                                                          | "Code of the country"                                      |
| `HotelDetails[].CheckInTime`         | String           | `"3:00 PM"`                                                                                    | "Check-In time of the stay."                               |
| `HotelDetails[].CheckOutTime`        | String           | `"12:00 PM"`                                                                                   | "Check-Out time of the stay."                              |

`HotelDetails` no trae `HotelWebsiteUrl`, que sí trae `TBOHotelCodeList` (VERIFICADO-PDF pp. 58-59, 66).

Ejemplo del PDF, recortado. **JSON inválido en el original**: coma tras la última URL de `Images` (p. 62).

```json
{
  "Status": { "Code": 200, "Description": "Successful" },
  "HotelDetails": [
    {
      "HotelCode": "1000000",
      "HotelName": "Sofitel Legend Old Cataract Aswan",
      "Description": "<p>HeadLine : Near Nubian Museum</p><p>Location : …</p><p>CheckIn Instructions : …</p>&nbsp;<br/><b>Disclaimer notification: …</b>",
      "HotelFacilities": ["Library", "Express check-in", "Free WiFi", "Wheelchair accessible – no"],
      "Attractions": {
        "1) ": "Distances are displayed to the nearest 0.1 mile and kilometer. <br /> <p>Nubian Museum - 0.4 km / 0.2 mi …</p>"
      },
      "Images": [
        "https://api.tbotechnology.in/imageresource.aspx?img=9eMP+0FIICgCIk6ZClzZH9Cs…",
        "https://api.tbotechnology.in/imageresource.aspx?img=9eMP+0FIICgCIk6ZClzZH9Cs…"
      ],
      "Address": "Abtal El Tahrir Street,Aswan 81511, Assuan, Aswan, 81511, Egypt",
      "PinCode": "81511",
      "CityId": "109642",
      "CountryName": "Egypt",
      "PhoneNumber": "+20972316000",
      "FaxNumber": "+20972316011",
      "Map": "24.08166|32.88985",
      "HotelRating": 5,
      "CityName": "Aswan",
      "CountryCode": "EG",
      "CheckInTime": "3:00 PM",
      "CheckOutTime": "12:00 PM"
    }
  ]
}
```

Notas de contenido (VERIFICADO-PDF salvo donde se indica):

- `Description` trae HTML, entidades (`&nbsp;`), avisos operativos y **apóstrofes perdidos** en origen ("hotel s",
  "doesn t", p. 60). `HotelFacilities` es texto libre que mezcla métricas ("Number of meeting rooms - 3") con
  **negaciones** ("Wheelchair accessible – no") (pp. 60-61).
- Las imágenes se sirven desde `api.tbotechnology.in/imageresource.aspx?img=<token>` (p. 62); las de habitación
  del ejemplo, desde `www.tboholidays.com/imageresource.aspx?img=…` (p. 57). El PDF no dice si el token caduca, si
  el host cambia en live ni si se pueden cachear o copiar → [Q-67](./10-preguntas-para-tbo.md#q-67).

#### 2.6.3 Detalle por habitación (cambio del 27-oct-2025)

La nota "IMPORTANT NOTE" (pp. 56-57) agrega `"IsRoomDetailRequired": true` y describe, por habitación:

| Campo (literal)   | Tipo observado      | Descripción (literal)                          |
| ----------------- | ------------------- | ---------------------------------------------- |
| `RoomName`        | String              | "e.g., "Deluxe Room, 1 King Bed, Garden View"" |
| `RoomId`          | **número** `197354` | "Unique identifier (e.g., 197354)"             |
| `RoomSize`        | String `"1830 ft"`  | "(e.g.,1830 ft)"                               |
| `RoomDescription` | String              | "Room features"                                |
| `imageURL`        | array de URLs       | "Array of URLs for room-specific images"       |

Y el enlace con Search: "Search API returns a RoomID. This RoomID corresponds to the RoomId in HotelDetails API.
… Please note if Room ID is 0, which means mapping isn't available." (VERIFICADO-PDF p. 57). En el ejemplo de
Search, `RoomID` es un **array de strings** (`["197354"]`); en `HotelDetails`, `RoomId` es un **número**.

**Hueco:** el PDF **no dice la clave ni la posición del contenedor** de habitaciones dentro de la respuesta, no
trae un ejemplo completo con `IsRoomDetailRequired: true` y la tabla de §14 no incluye ninguno de estos campos
(VERIFICADO-PDF pp. 56-59). Postura: el schema Zod del ACL deja pasar claves desconocidas en `HotelDetails[]`, la
función queda **apagada** hasta tener un fixture real capturado en test, y `RoomId` se normaliza a string; `0` o
`"0"` significa "sin mapeo", y en ese caso se usa `Rooms[].Name[i]` de Search sin imágenes de habitación
→ [Q-65](./10-preguntas-para-tbo.md#q-65). El uso de `RoomID` en la oferta está en [02](./02-search-y-oferta-canonica.md).

---

## 3. Rarezas de tipos y política de normalización

El contrato no cumple sus propias tablas. Regla: **el borde Zod del ACL acepta lo observado en ejemplos y
Postman, además de lo declarado, y entrega un solo tipo canónico**. Los schemas viven en
`providers/tbo-hotels/src/content/` (PROPUESTA), los usa tanto el sync como el API, y nunca exportan tipos TBO al
dominio.

| Campo(s)                                                                                  | Declarado   | Observado                                                     | Canónico                                                                                                                           | Cita                     |
| ----------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `CountryList`, `CityList`, `Hotels`, `HotelDetails`                                       | Object      | array                                                         | array; objeto único → array de 1 (defensivo, INFERIDO)                                                                             | pp. 52, 54, 58, 66       |
| `CityList[].Code`, `CityCode`, `CityId`                                                   | Integer     | string numérico                                               | `string` (trim); se rechaza vacío                                                                                                  | pp. 54, 62, 65           |
| `HotelCode` (métodos estáticos; en Search la tabla ya dice String, p. 13), `HotelCodes[]` | Integer     | string, salvo en `hotelcodelist`, donde es entero             | `string`                                                                                                                           | pp. 55, 58-59, 66-67     |
| `CountryCode` (hoteles)                                                                   | Integer     | ISO2 string                                                   | `CHAR(2)` en mayúsculas; si no casa `^[A-Z]{2}$`, se usa el país de la ciudad                                                      | pp. 59, 62, 66, 68       |
| `PinCode`, `FaxNumber`                                                                    | Integer     | string                                                        | `string \| null`                                                                                                                   | pp. 59, 62, 66, 68-69    |
| `HotelRating`                                                                             | Enumeration | `"ThreeStar"` (TBOHotelCodeList) y `5` (HotelDetails)         | número 1-5: `OneStar`→1 … `FiveStar`→5; número 1-5 tal cual; `All`, `0` o desconocido → `null`                                     | pp. 59, 62, 66-67, 69-70 |
| `Map`                                                                                     | String      | `"lat\|lon"`                                                  | `{lat, lng}` validado (lat ±90, lng ±180); malformado → `null`; `"0\|0"` → `null` (INFERIDO)                                       | pp. 62, 69               |
| `HotelFacilities`                                                                         | String      | array                                                         | `string[]`; si llega string, se parte por `,` (INFERIDO)                                                                           | pp. 60-61, 68            |
| `Images`                                                                                  | String      | array                                                         | `string[]` de URLs absolutas; se descarta lo que no sea URL                                                                        | pp. 61-62                |
| `Attractions`                                                                             | String      | array (TBOHotelCodeList) u objeto `{"1) ": …}` (HotelDetails) | un único HTML: array → unir con `","`; objeto → valores en orden de clave                                                          | pp. 61, 67               |
| `CheckInTime` / `CheckOutTime`                                                            | String      | `"3:00 PM"`                                                   | `HH:mm` 24 h; `"12:00 PM"` → `12:00`; no parseable → `null`                                                                        | p. 62                    |
| `Description`                                                                             | String      | HTML                                                          | HTML saneado (lista blanca `p`, `br`, `b`, `ul`, `li`) + secciones `<p>Etiqueta : texto</p>` separadas + texto plano para WhatsApp | pp. 58, 60, 66, 68       |
| `HotelWebsiteURL` / `HotelWebsiteUrl`                                                     | String      | casing distinto entre tabla y ejemplo                         | se aceptan ambas claves                                                                                                            | pp. 66, 69               |
| `RoomID` (Search) / `RoomId` (HotelDetails)                                               | —           | `["197354"]` / `197354`                                       | `string`; `"0"` → `null`                                                                                                           | p. 57                    |
| `IsDetailedResponse` (request)                                                            | Boolean     | se envía `"true"` string                                      | se envía como en PDF y Postman (string) hasta confirmar si acepta boolean                                                          | p. 65; Postman           |
| `Status`                                                                                  | Object      | ausente en `hotelcodelist`                                    | opcional solo en ese método                                                                                                        | p. 55                    |

Esqueleto ilustrativo (PROPUESTA; `z` de `zod`, dependencia directa del paquete como en
`providers/sabre/package.json:32`; `@sales-travel/validation` queda para `apps/api`, como
`apps/api/src/provider-credentials/dto.ts:1`; regla de [08](./08-requisitos-maestro.md) §7.8 y §9 C-13):

```ts
const code = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1));
const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.union([z.array(item), item]).transform((v) => (Array.isArray(v) ? v : [v]));
const starRating = z.union([z.number(), z.string()]).transform(toStars); // 1..5 | null

export const TboCityHotelSchema = z
  .object({
    HotelCode: code,
    HotelName: z.string().optional(),
    HotelRating: starRating.optional(),
    Map: z.string().optional(),
    CountryCode: z.string().optional(),
    Address: z.string().optional(),
    PinCode: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
```

Los fixtures de tests salen de **respuestas reales capturadas en test**, nunca de los ejemplos del PDF: los cinco
ejemplos de respuesta de los métodos estáticos son JSON inválido (§12, CE-13).

---

## 4. Contenido que necesita la UI y de dónde sale

Despegar devuelve nombre, estrellas, tipo y coordenadas **dentro de la disponibilidad** (`hotel_info`,
`providers/despegar-hotels/src/availability/response.mapper.ts:139-152`, VERIFICADO-CODIGO). TBO no: su Search
solo trae `HotelCode`, `Currency` y `Rooms` (VERIFICADO-PDF pp. 13-15). Todo lo que el vendedor ve de un hotel
TBO sale del catálogo local.

La tarjeta de resultados de hoy pinta `name` (con fallback "Hotel {id}"), `stars` y `location.lat/lng`
(`apps/web-b2b/src/app/(app)/hoteles/_components/hotel-result-card.tsx:27-44`, VERIFICADO-CODIGO). La web todavía
no tiene pantalla de detalle, prebook ni reserva de hotel (ver
[06](./06-seams-integracion-repo.md)).

Las columnas `provider_city_code` y las tablas `hotel_content` y `hotel_room_content` de esta tabla son PROPUESTA
(§7.3); no existen en el repo.

| Dato para la UI                                                          | Pantalla                  | Fuente TBO                                                           | Dónde lo guardamos                                   | Momento                                                                  |
| ------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Nombre                                                                   | listado, detalle, voucher | `HotelName` (TBOHotelCodeList, HotelDetails)                         | `hotel_inventory.name`                               | sync                                                                     |
| Estrellas                                                                | listado, filtros          | `HotelRating`                                                        | `hotel_inventory.stars`                              | sync                                                                     |
| Coordenadas                                                              | listado (mapa), dedupe    | `Map`                                                                | `hotel_inventory.latitude/longitude`                 | sync                                                                     |
| Dirección, CP                                                            | detalle, voucher          | `Address`, `PinCode`                                                 | `hotel_inventory.address/zipcode`                    | sync                                                                     |
| Ciudad y país                                                            | listado                   | `CityCode` de la request, `CityName`, `CountryCode`                  | `hotel_inventory.provider_city_code`, `country_code` | sync                                                                     |
| Imagen principal y galería                                               | listado (1), detalle (N)  | `Images` (solo HotelDetails)                                         | `hotel_content.images`                               | sync por lotes + bajo demanda (§6.3 E4)                                  |
| Check-in / check-out                                                     | detalle, voucher          | `CheckInTime`, `CheckOutTime` (solo HotelDetails)                    | `hotel_content.check_in_time/check_out_time`         | ídem                                                                     |
| Descripción por secciones                                                | detalle                   | `Description`                                                        | `hotel_content.description_html` + `sections`        | ídem                                                                     |
| Instrucciones de check-in (depósito, documento, cargo por persona extra) | detalle, confirmación     | sección "CheckIn Instructions" de `Description` (p. 60)              | `hotel_content.sections`                             | ídem                                                                     |
| Servicios                                                                | detalle, filtros futuros  | `HotelFacilities`                                                    | `hotel_content.facilities`                           | ídem                                                                     |
| Atracciones cercanas                                                     | detalle                   | `Attractions`                                                        | `hotel_content.attractions_html`                     | ídem                                                                     |
| Teléfono, web                                                            | detalle, voucher          | `PhoneNumber`, `HotelWebsiteUrl` (este último solo TBOHotelCodeList) | `hotel_content.phone/website_url`                    | ídem                                                                     |
| Nombre, tamaño e imágenes de la habitación                               | detalle de tarifa         | `RoomName`, `RoomSize`, `imageURL` vía `RoomID`                      | `hotel_room_content`                                 | cuando exista fixture real (§2.6.3)                                      |
| Suplementos `AtProperty`, régimen, reembolsable                          | tarifa                    | **no es estático**: Search y PreBook                                 | —                                                    | ver [02](./02-search-y-oferta-canonica.md), [03](./03-prebook-y-book.md) |

Reglas:

- **Sanear el HTML al ingerir y escapar al renderizar.** `Description` y `Attractions` son HTML de un tercero:
  riesgo XSS. Se guarda ya saneado con lista blanca. Para WhatsApp y B2C (principio 5 de `CLAUDE.md`) se deriva
  texto plano de las secciones.
- **Negaciones en servicios:** "… – no" no se muestra como servicio disponible, y no alimenta filtros hasta que
  exista un diccionario (INFERIDO, pp. 60-61).
- **El listado no espera a `HotelDetails`.** Con `hotel_inventory` (nombre, estrellas, dirección, coordenadas) la
  tarjeta se pinta; la imagen principal se agrega si ya está en `hotel_content`. Principio 1 de `CLAUDE.md`:
  ningún paso de búsqueda se bloquea por contenido.
- **Invariante de reserva:** en detalle, prebook y confirmación siempre se muestra el nombre y la dirección **del
  proveedor que vende la tarifa**, aunque la tarjeta agrupe hoteles equivalentes de dos proveedores (§9.3).
- **Imágenes y CSP:** la CSP del panel ya admite cualquier imagen `https:`
  (`apps/web-b2b/next.config.ts:22`, VERIFICADO-CODIGO). Una imagen `http://` quedaría bloqueada como contenido
  mixto (INFERIDO). Los ejemplos del PDF son `https://` (pp. 57, 62).
- Diferencia semántica que conviene no arrastrar: el `/hotels/detail` actual es **disponibilidad de un hotel** de
  Despegar (`apps/api/src/hotels/hotels.service.ts:143-161`), no contenido estático. En TBO, "detalle" son dos
  cosas: Search con un solo `HotelCode` (tarifas) y `HotelDetails` (contenido). El puerto neutral de hoteles tiene
  que separarlas ([06](./06-seams-integracion-repo.md)).

---

## 5. Cómo sincroniza hoy Despegar (`tools/sync-hotel-inventory`)

Todo VERIFICADO-CODIGO.

| Aspecto        | Hoy                                                                                                                                                                                                                    | Cita                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Disparo        | cron `30 3 * * *` (03:30 UTC) + `workflow_dispatch`                                                                                                                                                                    | `.github/workflows/sync-hotel-inventory.yml:4-7`                                                 |
| Límite del job | `timeout-minutes: 15`                                                                                                                                                                                                  | `.github/workflows/sync-hotel-inventory.yml:16`                                                  |
| Ejecución      | SSH al VPS, `source .env`; si falta `DESPEGAR_API_KEY` sale con 0                                                                                                                                                      | `.github/workflows/sync-hotel-inventory.yml:29-37`                                               |
| Contenedor     | `docker create` en la red `sales-travel_internal` con `PGUSER=postgres` y `POSTGRES_ADMIN_PASSWORD`; `docker network connect sales-travel_edge` para salir a Internet; `docker start -a` y propaga el código de salida | `.github/workflows/sync-hotel-inventory.yml:42-56`                                               |
| Imagen         | se construye en cada push a `main` desde la matriz de deploy                                                                                                                                                           | `.github/workflows/deploy.yml:44`                                                                |
| Empaquetado    | el Dockerfile copia solo `tools/sync-hotel-inventory`; la única dependencia es `pg`; no hay tests                                                                                                                      | `tools/sync-hotel-inventory/Dockerfile:14-19`; `tools/sync-hotel-inventory/package.json:15-17`   |
| Credencial     | **de plataforma** (env `DESPEGAR_API_KEY`), nunca la BYOC de un tenant                                                                                                                                                 | `tools/sync-hotel-inventory/src/index.ts:139`                                                    |
| Descarga       | **una sola** llamada `GET {base}/content-api/hotels-inventory` con `x-apikey`                                                                                                                                          | `tools/sync-hotel-inventory/src/index.ts:60-64`                                                  |
| Mapeo          | dedupe por id; `location.city.id` → `city_id`; `country_code` siempre `null`                                                                                                                                           | `tools/sync-hotel-inventory/src/index.ts:74-91`, `:116`                                          |
| Escritura      | `DELETE FROM hotel_inventory WHERE provider_code = $1` + `INSERT` en bloques de 500 filas × 12 columnas                                                                                                                | `tools/sync-hotel-inventory/src/index.ts:96-136`                                                 |
| Atomicidad     | todo en **una transacción** (`BEGIN`/`COMMIT`, `ROLLBACK` si falla)                                                                                                                                                    | `tools/sync-hotel-inventory/src/index.ts:153-167`                                                |
| Logs           | JSON por `console.warn`/`console.error` (skip, resultado y error), más dos líneas de progreso en texto plano; nunca la API key                                                                                         | `tools/sync-hotel-inventory/src/index.ts:142`, `:159-161`, `:172`; texto plano en `:149`, `:151` |
| Tabla          | global, sin RLS; `app_user` solo tiene `SELECT`                                                                                                                                                                        | `db/migrations/0022_hotel_inventory.sql:2`, `:29`                                                |
| Lectura        | `resolveCityHotelIds(cityId, 50)` con `provider_code = 'despegar-hotels'`, orden por `hotel_id`; lista vacía → 503 "catálogo no sincronizado"                                                                          | `apps/api/src/hotels/hotels.service.ts:131-141`, `:80-86`                                        |

Dos detalles que afectan a TBO:

- El `DELETE` filtra por `provider_code`, así que el job de Despegar **no toca filas `tbo-hotels`**
  (`tools/sync-hotel-inventory/src/index.ts:97`). Pero borra y reinserta todas las filas de Despegar cada día:
  **cualquier columna que agreguemos a `hotel_inventory` para enlazar hoteles entre proveedores se perdería a
  diario en las filas de Despegar**. Por eso las equivalencias y el mapa de destinos van en tablas aparte (§7.3).
- El texto de ayuda de la UI dice "El catálogo se sincroniza al configurar las credenciales del proveedor"
  (`apps/web-b2b/src/app/(app)/hoteles/page.tsx:122-124`). Es falso hoy (lo sincroniza un cron con la credencial de
  plataforma) y lo seguirá siendo con TBO. Ver [06](./06-seams-integracion-repo.md).

---

## 6. Pipeline de sincronización TBO

### 6.1 Por qué TBO no cabe en el molde actual

| Aspecto                    | Despegar                      | TBO                                                                | Consecuencia                          |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| Llamadas por corrida       | 1                             | 1 + Σ países (1 `CityList` + N ciudades) + lotes de `HotelDetails` | minutos u horas, no segundos          |
| Fallo parcial              | no existe: o baja todo o nada | normal (429, timeouts, ciudades con error)                         | escritura por ciudad, reanudable      |
| `DELETE` + `INSERT` global | seguro con una sola descarga  | una corrida cortada dejaría el catálogo vacío o a medias           | upsert + barrido acotado              |
| Transacción única          | cabe                          | cientos de miles de filas en horas: bloqueo largo                  | transacción por ciudad                |
| Auth                       | `x-apikey`                    | Basic Auth (p. 7)                                                  | cliente del ACL                       |
| Límite de tasa             | no tratado                    | 429 con QPS no publicado (p. 9)                                    | throttling propio                     |
| `timeout-minutes: 15`      | alcanza                       | no alcanza para una corrida completa                               | corrida con presupuesto y reanudación |

### 6.2 ¿Extender `tools/sync-hotel-inventory` o herramienta aparte?

| Opción                                  | Qué es                                                                                                             | A favor                                                                                                                                                                   | En contra                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Herramienta aparte (recomendada)** | `tools/sync-tbo-hotel-inventory/` + workflow `sync-tbo-hotel-inventory.yml` + entrada en la matriz de `deploy.yml` | Aísla el riesgo: el job de Despegar, que funciona, no cambia. Cadencia, skip y kill-switch propios. Reusa el cliente y los schemas Zod del ACL `@sales-travel/tbo-hotels` | Segunda imagen. El Dockerfile tiene que copiar `providers/tbo-hotels` y sus dependencias de `packages/` (hoy copia solo la carpeta del tool, `tools/sync-hotel-inventory/Dockerfile:16`; ningún tool depende todavía de un paquete del workspace, y el modelo a seguir es `apps/api/Dockerfile:20-31`, que copia `packages` y `providers` y compila las dependencias con `^...` antes del `deploy`). El ACL es CommonJS y el tool es ESM (`providers/despegar-hotels/tsconfig.json:4`, `tools/sync-hotel-inventory/package.json:5`): importar CJS desde ESM funciona en Node 20, pero hay que probarlo (INFERIDO) |
| B. Runner multi-proveedor               | `sync-hotel-inventory --provider despegar-hotels\|tbo-hotels`, con fuentes intercambiables                         | Una imagen, un workflow                                                                                                                                                   | Cambia el contrato de env y CLI de un job en producción. Las dos fuentes comparten casi nada: Despegar es "una descarga + reemplazo atómico" y TBO es "recorrido reanudable + barrido". El skip del workflow depende de `DESPEGAR_API_KEY` (`.github/workflows/sync-hotel-inventory.yml:34-37`)                                                                                                                                                                                                                                                                                                                   |
| C. Job BullMQ dentro del API            | tarea repetible en `apps/api`                                                                                      | Ya tiene el ACL y la bóveda                                                                                                                                               | El API escribiría en tablas globales, y `app_user` solo tiene `SELECT` (`db/migrations/0022_hotel_inventory.sql:29`). Una tarea de horas compite con el tráfico de venta. No es el patrón del repo para catálogos: `sync-airports` y `sync-hotel-inventory` son tools en contenedor disparados por Actions, y el BullMQ que existe (`apps/api/src/queue/post-sale-queue.service.ts:68`) queda para post-venta y las sagas con dinero (D9). **Descartada**                                                                                                                                                         |

**Recomendación: A.** Si el founder prefiere B, el diseño de etapas de §6.3 no cambia: solo se mueve a un módulo
`sources/tbo.ts` del runner existente, y la escritura de Despegar debe seguir siendo `DELETE` + `INSERT`.

### 6.3 Etapas

| Etapa | Llamada                                                                                                         | Entrada                                                                                                                                                                                                                                                                                               | Salida                                                                                                  | Frecuencia sugerida (INFERIDO)                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| E0    | —                                                                                                               | env: `TBO_SYNC_USERNAME`, `TBO_SYNC_PASSWORD`, `TBO_SYNC_BASE_URL`, `TBO_SYNC_COUNTRIES` (lista ISO2), presupuesto por corrida; todo validado con Zod al arrancar (las env vars son borde en `CLAUDE.md`; el sync actual solo comprueba presencia, `tools/sync-hotel-inventory/src/index.ts:139-147`) | lock + corrida                                                                                          | cada corrida                                                                     |
| E1    | `GET CountryList`                                                                                               | —                                                                                                                                                                                                                                                                                                     | valida que los países de `TBO_SYNC_COUNTRIES` existan en TBO                                            | semanal                                                                          |
| E2    | `POST CityList {"CountryCode": "<ISO2>"}`                                                                       | países habilitados                                                                                                                                                                                                                                                                                    | upsert en `hotel_provider_city` (`code`, `name`, `name_norm`, `country_code`)                           | semanal                                                                          |
| E3    | `POST TBOHotelCodeList {"CityCode": "<code>", "IsDetailedResponse": "true"}`                                    | ciudades ordenadas por prioridad (abajo)                                                                                                                                                                                                                                                              | upsert en `hotel_inventory` + barrido de la ciudad + centroide y `hotel_count` en `hotel_provider_city` | diaria para ciudades con demanda; semanal el resto; mensual si `hotel_count = 0` |
| E4    | `POST HotelDetails {"Hotelcodes": "c1,…,cN", "Language": "ES"\|"PT"\|"EN"}` (path con el casing del PDF, CE-04) | hoteles activos sin contenido o con contenido de más de X días, priorizando destinos con demanda                                                                                                                                                                                                      | `hotel_content` por idioma (+ `hotel_room_content` cuando se habilite §2.6.3)                           | continua, dentro del presupuesto                                                 |
| E5    | `GET hotelcodelist`                                                                                             | —                                                                                                                                                                                                                                                                                                     | hoteles `tbo-hotels` activos que no aparecen en la lista global → `active = false`                      | semanal; se desactiva si el método no responde                                   |
| E6    | — (SQL)                                                                                                         | centroides de ambos proveedores                                                                                                                                                                                                                                                                       | recalcula `hotel_destination_map` y `hotel_match` de los países tocados (§8, §9)                        | después de E3                                                                    |

Decisiones dentro de las etapas:

- **E3 con `IsDetailedResponse: "true"` hasta demostrar lo contrario.** El key point de p. 71 recomienda `False`,
  pero no dice a qué método aplica ni qué campos sobreviven. Sin `Map`, `HotelRating` y `CountryCode` no hay
  `hotel_inventory` útil, ni centroide, ni dedupe. En la certificación se prueba `"false"` y, si trae esos campos,
  se cambia a `"false"` por configuración → [Q-63](./10-preguntas-para-tbo.md#q-63).
- **El contenido de E3 no se guarda como contenido.** `TBOHotelCodeList` trae `Description`, `HotelFacilities` y
  `Attractions`, pero no tiene parámetro de idioma (p. 65): probablemente vienen en inglés (INFERIDO). Se guardan
  como `hotel_content` con `lang = 'en'` y `source = 'TBOHotelCodeList'` solo si todavía no hay contenido EN de
  `HotelDetails`. Así el detalle tiene texto desde el primer día, aunque sin imágenes.
- **Prioridad de ciudades en E3:** (1) las mapeadas a destinos con búsquedas recientes (`search_logs.criteria`
  guarda `destinationId`, `apps/api/src/hotels/hotels.service.ts:97-102`, `db/migrations/0032_search_logs.sql:27`);
  (2) las que nunca se sincronizaron; (3) las más antiguas por `synced_at`.
- **E4 bajo demanda sin escribir desde el API.** Si el vendedor abre un hotel sin contenido, el API puede llamar
  `HotelDetails` para ese único código con timeout corto y mostrarlo, con caché temporal vía el puerto de caché
  (`CachePort`, `packages/core/src/ports/cache.port.ts:1`; hoy solo lo implementa `MemoryCacheAdapter`, en memoria
  del proceso, `apps/api/src/search/memory-cache.adapter.ts:26`).
  **No lo escribe en `hotel_content`**: las tablas globales las escribe solo el sync (hoy `app_user` solo tiene
  `SELECT`, `db/migrations/0022_hotel_inventory.sql:29`). El sync ya prioriza esos hoteles porque siguen sin
  contenido. Si la llamada falla, el detalle se muestra sin imágenes.
- **`HotelDetails` y reintentos.** Son lecturas sin dinero: se permiten reintentos con backoff, a diferencia de
  Book y Cancel ([01](./01-autenticacion-conectividad-y-errores.md), [03](./03-prebook-y-book.md)).

### 6.4 Presupuesto, reanudación y exclusión mutua

- **Presupuesto por corrida** (`TBO_SYNC_MAX_CALLS`, `TBO_SYNC_MAX_MINUTES`): cada corrida avanza desde donde quedó
  la anterior y se detiene antes del límite. Así cada ejecución cabe en la receta SSH actual sin sesiones de
  horas, y una corrida completa del país se reparte en varias ejecuciones.
- **Checkpoint sin tabla nueva:** `hotel_provider_city.synced_at` y `last_status_code` dicen qué ciudades faltan.
  La reanudación es "ciudades con `synced_at` anterior al inicio del ciclo".
- **Exclusión mutua:** `pg_try_advisory_lock` con una clave fija del proveedor. Si otra corrida lo tiene, la nueva
  sale con 0 y lo registra en el log.
- **Corte por 429:** backoff exponencial con jitter. Tras N respuestas 429 consecutivas la corrida termina "ok
  parcial" y deja el resto para la próxima. Nunca se reintenta en bucle.

### 6.5 Escritura: upsert por ciudad y barrido acotado

Por cada ciudad con respuesta `Status.Code = 200`, en **una transacción corta por ciudad**:

1. `INSERT … ON CONFLICT (provider_code, hotel_id) DO UPDATE` de cada hotel, con
   `provider_city_code = <CityCode de la request>`, `active = true` y `last_seen_at = <inicio de la corrida>`. Si un
   hotel cambia de ciudad, el upsert lo mueve.
2. **Barrido:** `UPDATE hotel_inventory SET active = false WHERE provider_code = 'tbo-hotels' AND
provider_city_code = $city AND last_seen_at < $runStart`.
3. **Guarda de sanidad:** si la ciudad devuelve menos del `TBO_SYNC_SWEEP_MAX_DROP` (p. ej. 50 %) de los hoteles
   activos que tenía, **no se barre**, se registra una anomalía y se reintenta en la próxima corrida. Una
   respuesta vacía o con `Status.Code` distinto de 200 nunca barre.

Nunca se hace `DELETE` de filas TBO. Las bajas son lógicas, y `resolveCityHotelIds` (o su sucesor por proveedor)
filtra `active = true` ([06](./06-seams-integracion-repo.md)). Un hotel inactivo conserva su contenido para
reservas históricas y vouchers.

### 6.6 Ejecución, credencial y empaquetado

- **Credencial de plataforma dedicada al sync** (`TBO_SYNC_*`), separada del fallback de ventas del API
  (`TBO_USERNAME`/`TBO_PASSWORD`, si el founder decide que TBO cae a credenciales de plataforma,
  [08](./08-requisitos-maestro.md)). Se puede apagar el fallback de ventas sin romper el catálogo y, si TBO da una
  cuenta aparte, el QPS del sync no se come el de la venta. La cuenta TBO de plataforma es **precondición
  comercial**, aunque todas las agencias traigan su cuenta (BYOC): sin ella no hay catálogo.
- Skip idéntico al de Despegar: si faltan credenciales, `{"ok":true,"action":"skip"}` y salida 0
  (`tools/sync-hotel-inventory/src/index.ts:139-144` como modelo). Kill-switch adicional: `TBO_SYNC_ENABLED=false`.
- **Ventana horaria.** 03:30 UTC son las 22:30 en Bogotá y Lima y las 00:30 en São Paulo: todavía hay venta. Si
  la cuenta del sync comparte cuota con ventas, conviene correr cerca de las 08:00 UTC (03:00 en Bogotá) y repetir
  cada hora dentro de la ventana hasta agotar el presupuesto (INFERIDO, a validar con la telemetría de
  `search_logs`).
- Logs: una línea JSON por etapa con contadores (`cities`, `hotelsUpserted`, `hotelsDeactivated`, `status429`,
  `errorsByCode`). Nunca la cabecera `Authorization`, nunca cuerpos completos. No es un evento de dominio: no hay
  cambio de negocio, solo datos de referencia (INFERIDO; mismo criterio que el sync actual, que no escribe en
  `domain_events`). La falta de tenant no es el motivo: `domain_events.tenant_id` es nullable para eventos de
  plataforma (`db/migrations/0015_domain_events.sql:10`, VERIFICADO-CODIGO).
- Empaquetado: Dockerfile propio que copia `tools/sync-tbo-hotel-inventory`, `providers/tbo-hotels` y los
  paquetes de los que depende, y una fila nueva en la matriz de `.github/workflows/deploy.yml:44`. Variables
  `TBO_SYNC_*` en el `.env` del VPS vía `deploy.yml` (hoy `DESPEGAR_*` en `.github/workflows/deploy.yml:139-144`),
  y el workflow nuevo las pasa una a una con `-e` al `docker create`, porque el contenedor no hereda el `.env`
  (hoy `DESPEGAR_API_KEY` y `DESPEGAR_BASE_URL` en `.github/workflows/sync-hotel-inventory.yml:48-49`). El compose
  del API no las necesita: el sync no corre dentro del API.

### 6.7 Volumen: fórmula, no número

El PDF no da cantidades (§10). La carga de una corrida completa es:

```
llamadas = 1 (CountryList)
         + P (CityList, una por país habilitado)
         + Σ ciudades de esos países (TBOHotelCodeList)
         + ceil(H / b) × L (HotelDetails: H hoteles, lote b, L idiomas)
         + 1 (hotelcodelist)
```

Ejemplo **hipotético**, solo para dimensionar: 10 países con 3.000 ciudades en total, 40.000 hoteles, lote de 10
y 3 idiomas dan ≈ 3.000 + 12.000 = 15.000 llamadas. A 1 req/s son ≈ 4,2 horas: de ahí el presupuesto por corrida
y la prioridad por demanda. La primera corrida de E3 revela cuántas ciudades tienen `hotel_count = 0`, que pasan a
cadencia mensual.

---

## 7. Modelo de datos

### 7.1 Qué columnas de `hotel_inventory` llena TBO

Esquema actual en `db/migrations/0022_hotel_inventory.sql:6-21`; tipo Kysely en
`apps/api/src/database/database.types.ts:214-228` (VERIFICADO-CODIGO).

| Columna 0022            | Tipo             | Fuente TBO                                    | Transformación                      | ¿Sirve tal cual?                 |
| ----------------------- | ---------------- | --------------------------------------------- | ----------------------------------- | -------------------------------- |
| `provider_code`         | TEXT             | constante `'tbo-hotels'`                      | —                                   | sí                               |
| `hotel_id`              | TEXT             | `Hotels[].HotelCode`                          | a string (§3)                       | sí                               |
| `city_id`               | BIGINT           | `CityCode` de la request                      | —                                   | **no se usa para TBO** (ver 7.2) |
| `country_code`          | CHAR(2)          | `Hotels[].CountryCode` o el país de la ciudad | mayúsculas, validado                | sí (Despegar lo deja `null`)     |
| `name`                  | TEXT             | `HotelName`                                   | trim                                | sí                               |
| `stars`                 | NUMERIC(2,1)     | `HotelRating`                                 | enum o número → 1-5                 | sí                               |
| `property_type`         | TEXT             | —                                             | no lo provee → `null`               | sí                               |
| `latitude`, `longitude` | DOUBLE PRECISION | `Map`                                         | partir por `\|`, validar rango      | sí                               |
| `address`               | TEXT             | `Address`                                     | trim (trae espacios finales, p. 67) | sí                               |
| `zipcode`               | TEXT             | `PinCode`                                     | a string                            | sí                               |
| `merged_ids`            | JSONB            | —                                             | concepto de Despegar → `null`       | sí                               |
| `synced_at`             | TIMESTAMPTZ      | —                                             | hora del upsert                     | sí                               |

### 7.2 Lo que 0022 no resuelve

1. **Código de ciudad.** `city_id` es BIGINT y está en el espacio de Despegar
   (`providers/despegar-hotels/src/suggestions/response.mapper.ts:26-28`). El `CityCode` de TBO llega siempre como
   string (pp. 54, 62, 65), aunque la tabla diga Integer. Todos los ejemplos son numéricos, así que cabría en
   BIGINT, pero el contrato se contradice y mezclar dos espacios de ids en una columna invita a consultar uno con el
   otro. Postura: **columna nueva `provider_city_code TEXT`**; `city_id` queda solo para Despegar.
   _Alternativa sin esta columna:_ castear a BIGINT y rechazar códigos no numéricos con log. Ahorra un índice, pero
   cualquier código alfanumérico futuro rompe el sync.
2. **Baja lógica.** No hay `active` ni `last_seen_at`: el único modo de baja es el `DELETE` global.
3. **Contenido.** No hay dónde poner imágenes, descripción, servicios, horarios ni contenido por habitación, y no
   corresponde ponerlo en una tabla de resolución ciudad → ids.
4. **Destinos y equivalencias.** No hay tabla de ciudades por proveedor, ni mapa de destinos, ni `giata_id`. Por lo
   explicado en §5, las equivalencias no pueden vivir como columnas en `hotel_inventory`.
5. **Geo.** No hay índice por coordenadas. Tampoco hay PostGIS ni `earthdistance`: las extensiones instaladas son
   `timescaledb`, `vector`, `pgcrypto`, `uuid-ossp`, `citext`, `pg_trgm` y `unaccent`
   (`infrastructure/hostinger/postgres-init/01-extensions.sql:4-10`), más `ltree`, que crea una migración
   (`db/migrations/0011_tenant_hierarchy.sql:7`) (VERIFICADO-CODIGO). Las distancias se calculan con haversine, y la
   similitud de nombres puede usar `pg_trgm`. CI también crea `pg_trgm` y `unaccent` antes de migrar
   (`.github/workflows/ci.yml:114-122`), así que el índice GIN trigram de §7.3 pasa en CI.

### 7.3 Migración nueva (PROPUESTA, no aplicada)

Es la migración **M1** de [08](./08-requisitos-maestro.md) §9 C-10. Hoy `db/migrations/` llega a
`0040_portfolio_ledger_idempotency.sql` (VERIFICADO-CODIGO); el número tentativo lo asigna
[09](./09-plan-implementacion.md) §3.3, porque las migraciones M2 a M5 también lo necesitan.

```sql
-- 00NN_hotel_inventory_multi_provider.sql  (PROPUESTA)

ALTER TABLE hotel_inventory
  ADD COLUMN provider_city_code TEXT,
  ADD COLUMN active             BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN last_seen_at       TIMESTAMPTZ;

CREATE INDEX idx_hotel_inventory_provider_city
  ON hotel_inventory (provider_code, provider_city_code) WHERE active;

-- Ciudades de cada proveedor (TBO: CityList + centroide de sus hoteles). Checkpoint del sync.
CREATE TABLE hotel_provider_city (
  provider_code       TEXT             NOT NULL,
  provider_city_code  TEXT             NOT NULL,
  country_code        CHAR(2)          NOT NULL,
  name                TEXT             NOT NULL,
  name_norm           TEXT             NOT NULL,  -- minúsculas, sin acentos ni puntuación (lo calcula el sync)
  hotel_count         INTEGER,
  centroid_lat        DOUBLE PRECISION,           -- mediana de latitudes de hoteles activos
  centroid_lng        DOUBLE PRECISION,
  synced_at           TIMESTAMPTZ,
  last_status_code    INTEGER,
  PRIMARY KEY (provider_code, provider_city_code)
);
CREATE INDEX idx_hotel_provider_city_name ON hotel_provider_city USING GIN (name_norm gin_trgm_ops);

-- Destino de la UI (hoy: city_id de Despegar) → ciudades de otro proveedor.
CREATE TABLE hotel_destination_map (
  source_provider_code  TEXT         NOT NULL,   -- 'despegar-hotels'
  source_city_id        TEXT         NOT NULL,
  target_provider_code  TEXT         NOT NULL,   -- 'tbo-hotels'
  target_city_code      TEXT         NOT NULL,
  method                TEXT         NOT NULL CHECK (method IN ('overlap', 'centroid', 'manual')),
  score                 NUMERIC(4,3),
  status                TEXT         NOT NULL CHECK (status IN ('accepted', 'ambiguous', 'rejected')),
  computed_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (source_provider_code, source_city_id, target_provider_code, target_city_code)
);

-- Equivalencias de hotel entre proveedores (sobrevive al DELETE+INSERT diario de Despegar).
CREATE TABLE hotel_match (
  canonical_hotel_id  TEXT         NOT NULL,
  provider_code       TEXT         NOT NULL,
  hotel_id            TEXT         NOT NULL,
  method              TEXT         NOT NULL CHECK (method IN ('heuristic', 'manual', 'giata')),
  score               NUMERIC(4,3),
  status              TEXT         NOT NULL CHECK (status IN ('accepted', 'review', 'rejected')),
  computed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id)
);
CREATE INDEX idx_hotel_match_canonical ON hotel_match (canonical_hotel_id) WHERE status = 'accepted';

-- Contenido por hotel e idioma.
CREATE TABLE hotel_content (
  provider_code     TEXT         NOT NULL,
  hotel_id          TEXT         NOT NULL,
  lang              TEXT         NOT NULL CHECK (lang IN ('es', 'pt', 'en')),
  name              TEXT,
  description_html  TEXT,         -- ya saneado con lista blanca
  sections          JSONB,        -- [{ "label": "CheckIn Instructions", "text": "…" }]
  facilities        JSONB,        -- string[]; negaciones marcadas
  attractions_html  TEXT,
  images            JSONB,        -- string[] de URLs
  phone             TEXT,
  website_url       TEXT,
  check_in_time     TIME,
  check_out_time    TIME,
  source            TEXT         NOT NULL CHECK (source IN ('HotelDetails', 'TBOHotelCodeList')),
  content_hash      TEXT         NOT NULL,  -- evita reescribir si no cambió
  fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id, lang)
);

-- Contenido por habitación (IsRoomDetailRequired). Se llena cuando exista fixture real (§2.6.3).
CREATE TABLE hotel_room_content (
  provider_code  TEXT         NOT NULL,
  hotel_id       TEXT         NOT NULL,
  room_id        TEXT         NOT NULL CHECK (room_id <> '0'),
  lang           TEXT         NOT NULL CHECK (lang IN ('es', 'pt', 'en')),
  name           TEXT,
  size_text      TEXT,         -- "1830 ft": texto libre, no se parsea
  description    TEXT,
  images         JSONB,
  fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, hotel_id, room_id, lang)
);

GRANT SELECT ON hotel_provider_city, hotel_destination_map, hotel_match,
               hotel_content, hotel_room_content TO app_user;
```

Criterios:

- **Globales, sin RLS**, igual que `hotel_inventory` (`db/migrations/0022_hotel_inventory.sql:2`, `:23`, `:29`): no
  contienen datos de tenant. No violan la regla de `tenant_id` de `CLAUDE.md` porque no hay dato de tenant que
  filtrar. Si §11 resultara "catálogo por cuenta", esto cambia.
- `lang` usa los mismos valores que `LanguageCodeSchema` (`packages/validation/src/index.ts:16`); el ACL lo
  traduce al código en mayúsculas de TBO (`ES`, `PT`, `EN`).
- Compatibilidad: `active DEFAULT true` deja intactas las filas de Despegar, y su `DELETE` + `INSERT` sigue
  funcionando. El tipo Kysely `HotelInventoryTable` (`apps/api/src/database/database.types.ts:214-228`) y las
  tablas nuevas se agregan a la interfaz de DB (`:487`).
- `name_norm` se calcula en el sync (TypeScript) y no en un índice de expresión: `unaccent` no es `IMMUTABLE` y no
  sirve para índices funcionales (INFERIDO, comportamiento estándar de Postgres).

---

## 8. Resolución de destino

### 8.1 Situación actual (VERIFICADO-CODIGO)

- El combobox guarda `String(s.id)` de la sugerencia en el input oculto `destinationId`
  (`apps/web-b2b/src/app/(app)/hoteles/_components/destination-combobox.tsx:60-67`, `:94`). La action solo acepta
  dígitos (`apps/web-b2b/src/app/(app)/hoteles/actions.ts:141-142`), y el API lo valida como entero positivo
  (`apps/api/src/hotels/hotels.schemas.ts:27`).
- Ese `id` es el `target.id` de las sugerencias de Despegar, "= location.city.id del inventario"
  (`providers/despegar-hotels/src/suggestions/response.mapper.ts:26-28`), y es la misma clave que
  `hotel_inventory.city_id` de Despegar.
- Las sugerencias las sirve **el adapter de Despegar del tenant** (`apps/api/src/hotels/hotels.service.ts:68-71`).
- Datos disponibles por lado:

| Lado     | Id                  | País                                                                             | Nombre                                                                                                                  | Coordenadas                                                     |
| -------- | ------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Despegar | `city_id` (BIGINT)  | **no**: `country_code` es `null` (`tools/sync-hotel-inventory/src/index.ts:116`) | solo en la sugerencia (`GeoSuggestion.city`, `.country`, `providers/despegar-hotels/src/types.ts:4-11`), no se persiste | sí, por hotel (`tools/sync-hotel-inventory/src/index.ts:86-87`) |
| TBO      | `CityCode` (string) | sí, el ISO2 con que se pidió `CityList`                                          | sí, un solo nombre, sin parámetro de idioma y en idioma no documentado (`CityList[].Name`, pp. 53-54)                   | **no** en `CityList`; sí por hotel (`Map`, p. 69)               |

### 8.2 Opciones

| Opción                                              | Cómo resuelve "destino de la UI → `CityCode` de TBO"                                                                                                                                                                | A favor                                                                               | En contra                                                                                                                                            | Fase      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A. Radio geográfico                                 | Centroide de los hoteles Despegar del `city_id` y hoteles TBO a ≤ R km, ordenados por distancia                                                                                                                     | Sin tabla de mapeo; funciona desde el primer sync                                     | Mezcla ciudades vecinas y pierde barrios alejados del centroide en metrópolis; el resultado no es auditable                                          | respaldo  |
| **B. Tabla de mapeo ciudad → ciudad (recomendada)** | `hotel_destination_map` calculado fuera de línea: país ISO2 + nombre normalizado + centroide para las ciudades TBO, y solapamiento de hoteles equivalentes + distancia de centroides para el puente Despegar ↔ TBO | Determinista, auditable, revisable a mano; usa datos que ya bajamos                   | Depende del id de Despegar mientras la UI use su autocomplete; ciudades chicas sin solapamiento necesitan el criterio de centroide o revisión manual | 1         |
| C. Destino canónico propio + autocomplete propio    | Tabla de destinos nuestra (sembrada con `hotel_provider_city`), búsqueda con `pg_trgm` + `unaccent` (ya instalados) y mapeo a cada proveedor                                                                        | Desacopla la búsqueda de Despegar; permite tenants solo-TBO; nombres en ES/PT propios | Más trabajo: curar nombres y sinónimos (Río de Janeiro, Rio de Janeiro), y cambiar la UI                                                             | 2         |
| D. GIATA u otro servicio de mapeo                   | Ids de hotel de terceros; el destino se deriva de hoteles mapeados                                                                                                                                                  | Resuelve destino y dedupe con calidad industrial                                      | Licencia estimada en USD 5-25k/año (`docs/research/03-integraciones-ecosistema.md:139-143`); los docs la piden desde 3+ bedbanks                     | posterior |

**Recomendación: B en fase 1, A como diagnóstico interno (no para vender), C cuando haya tenants solo-TBO o se
quiera sacar la dependencia de Despegar, D con el tercer bedbank.**

_Dónde cambia si se elige un módulo TBO paralelo en lugar de generalizar la vertical_ ([08](./08-requisitos-maestro.md)):
un buscador TBO propio no tendría el `destinationId` de Despegar y necesitaría la opción C desde el día 1.

### 8.3 Algoritmo de fase 1 (etapa E6, PROPUESTA)

Para cada `city_id` de Despegar con hoteles activos:

1. **Centroide Despegar:** mediana de lat/lng de sus hoteles (la mediana resiste coordenadas erróneas).
2. **Candidatas TBO:** ciudades de `hotel_provider_city` con centroide a ≤ R km (R configurable; 25 km de
   partida, INFERIDO).
3. **Señal fuerte, solapamiento:** cantidad de hoteles del `city_id` que tienen equivalente aceptado en
   `hotel_match` (§9) dentro de cada candidata. Se acepta la candidata si reúne al menos `k` equivalencias (p. ej. 3) o el 20 % de los hoteles del lado más chico, y supera a la segunda por un margen.
4. **Señal débil, centroide:** si no hay solapamiento (ciudades con pocos hoteles), se acepta la candidata más
   cercana solo si está a menos de r km (p. ej. 5) y la segunda está a más del doble.
5. **País y nombre:** cuando el nombre Despegar se conozca (por la opción C, o por una lista curada), el país ISO2
   debe coincidir y `similarity(name_norm)` de `pg_trgm` suma al score. Dos ciudades TBO homónimas del mismo país
   nunca se resuelven solo por nombre.
6. El resultado se guarda con `status`: `accepted` se usa en venta; `ambiguous` queda para revisión manual y **no
   se usa**. Una fila `manual` nunca la pisa el recálculo.

Un `city_id` puede mapear a más de un `CityCode` solo por decisión manual (por ejemplo, zona hotelera con código
propio). Los umbrales son iniciales y hay que calibrarlos con datos reales de CO, PE, BR y los destinos que se
habiliten (INFERIDO).

### 8.4 Si no hay mapeo

- **Fail-closed:** si el destino no tiene mapeo `accepted`, la búsqueda **no consulta TBO** y sigue con Despegar.
  En telemetría, el proveedor queda como "omitido: sin mapeo de destino", no como error, para no disparar el
  circuit breaker ni ensuciar la tasa de error ([02](./02-search-y-oferta-canonica.md)).
- Una consulta de operación lista los destinos buscados sin mapeo TBO, ordenados por demanda (`search_logs`), para
  priorizar revisiones manuales.
- Si **ningún** proveedor resuelve el destino, se mantiene el 503 actual de "catálogo no sincronizado"
  (`apps/api/src/hotels/hotels.service.ts:80-86`).
- Dependencia a vigilar: sin clave Despegar de plataforma ni BYOC Despegar, no hay autocomplete y por lo tanto no
  hay búsqueda TBO por destino. Es la razón de fondo de la opción C.

---

## 9. Deduplicación Despegar ↔ TBO

### 9.1 Heurística de fase 1 (etapa E6, PROPUESTA)

Dos hoteles de proveedores distintos son el mismo si se cumple **todo** lo siguiente:

- distancia haversine ≤ 150 m entre coordenadas (umbral inicial, INFERIDO);
- `similarity(name_norm_a, name_norm_b)` ≥ 0,5 con `pg_trgm`. `name_norm` elimina acentos, puntuación y
  palabras genéricas ("hotel", "the", "by"), pero conserva las marcas;
- si ambos tienen estrellas, diferencia ≤ 1;
- ningún otro candidato cumple lo mismo. Si hay dos, la equivalencia va a `review`.

La equivalencia aceptada comparte un `canonical_hotel_id` en `hotel_match`. Un hotel sin equivalencia usa como
clave `<provider_code>:<hotel_id>`. `merged_ids` de Despegar son fusiones internas de Despegar y no sirven entre
proveedores (`db/migrations/0022_hotel_inventory.sql:18`). El canónico ya prevé `giataId` "recomendable para
deduplicación cross-provider" (`packages/canonical/src/hotel.ts:38-45`), y cuando exista reemplaza a la heurística.

### 9.2 Uso en la búsqueda

- La agregación agrupa por `canonical_hotel_id`: **una tarjeta** con las tarifas de ambos proveedores, cada una
  etiquetada con su proveedor para enrutar prebook y book; el "desde" es el mínimo precio de venta.
- `dedupeCheapest(items, keyOf, priceOf)` (`apps/api/src/search/provider-fanout.ts:52-71`, sin uso hoy) se queda
  solo con el ítem más barato por clave. Para hoteles conviene **fusionar las tarifas**, no descartar: el
  vendedor pierde opciones de régimen o cancelación si solo ve la más barata. El detalle está en
  [02](./02-search-y-oferta-canonica.md).
- Mostrar o no el proveedor en la tarjeta es una decisión de producto: el flag `tenants.show_provider_in_results`
  (`db/migrations/0036_provider_disclosure.sql:1-24`) hoy solo aplica a vuelos. **Decidido el 2026-09-25:** al firmar
  D-TBO-06 (A) el founder pidió "me tiene que mostrar de dónde es". Cada tarifa de la tarjeta lleva su proveedor y la
  web lo pinta con esa misma política, sin reglas nuevas para hoteles: por defecto oculto, ocultar gana en la cadena y
  el consolidador lo activa en el panel de proveedores. En una tarjeta agrupada, cada tarifa conserva su pastilla
  ([08](./08-requisitos-maestro.md) RF-40).

### 9.3 Riesgos y postura

- **Una fusión falsa es peor que un duplicado.** Si se agrupan dos hoteles distintos, el vendedor puede reservar
  una tarifa creyendo que es del otro hotel. Postura: umbrales conservadores; ante la duda, `review`; y la
  invariante de §4: **en detalle, prebook y confirmación se muestra siempre el nombre, la dirección y las imágenes
  del proveedor que vende esa tarifa**.
- Edificios con dos hoteles de la misma cadena (a menos de 150 m, nombres parecidos): el criterio de "ningún otro
  candidato" los manda a revisión.
- Un duplicado sin fusionar solo cuesta ruido visual. Es aceptable hasta GIATA.

---

## 10. Límites no documentados y postura defensiva

| Límite                               | Qué dice el contrato                                                                       | Postura                                                                                                                                                                                                                                                                                                                                                                                                             | Configuración                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Códigos por llamada a `HotelDetails` | Nada. La tabla habla de un código (p. 58); la respuesta es array (p. 59); Postman manda 13 | Lote por defecto 10, nunca más de 13 hasta confirmar. Si el lote da 400, 500 o timeout, se parte en dos y se reintenta hasta llegar a 1; un código que falla solo se marca y se sigue                                                                                                                                                                                                                               | `TBO_SYNC_DETAILS_BATCH`       |
| Paginación de `TBOHotelCodeList`     | Nada (pp. 65-69)                                                                           | Se asume respuesta completa. Guarda de sanidad antes de barrer (§6.5)                                                                                                                                                                                                                                                                                                                                               | `TBO_SYNC_SWEEP_MAX_DROP`      |
| Tamaño de `hotelcodelist`            | Nada (p. 55)                                                                               | Timeout amplio, tope de bytes, frecuencia semanal. Si falla, E5 no desactiva nada                                                                                                                                                                                                                                                                                                                                   | `TBO_SYNC_CODELIST_TIMEOUT_MS` |
| QPS                                  | 429 sin valor numérico (p. 9)                                                              | Límite propio conservador (1 req/s de partida), una sola conexión concurrente, backoff con jitter, corte tras N 429 seguidos                                                                                                                                                                                                                                                                                        | `TBO_SYNC_RPS`                 |
| Timeouts de estáticos                | Nada (p. 8)                                                                                | Iniciales: 30 s `CountryList`/`CityList`, 60 s `TBOHotelCodeList`, 45 s `HotelDetails`, 180 s `hotelcodelist` (INFERIDO; medir en test). Son valores de configuración del sync: el de `HotelDetails` queda por debajo del techo de 60 s de `TBO_OPERATIONS`, porque la configuración solo puede acortar ([01](./01-autenticacion-conectividad-y-errores.md) §5.2; [08](./08-requisitos-maestro.md) RNF-01, §9 C-14) | por método                     |
| Deltas                               | No existen (pp. 51-69)                                                                     | Refresco completo; `content_hash` para no reescribir contenido igual                                                                                                                                                                                                                                                                                                                                                | —                              |
| Idiomas                              | AR, ES, PT, FR, ZH listados; `EN` solo en ejemplos (pp. 56, 58)                            | Pedir `ES`, `PT` y `EN` en mayúsculas. Si un idioma falla, se guarda EN y se muestra EN de fallback                                                                                                                                                                                                                                                                                                                 | `TBO_SYNC_LANGS`               |
| Imágenes                             | Sin licencia, caducidad ni host live documentados (pp. 57, 62)                             | Hotlink: se guarda la URL y no se copia. Se refresca con el contenido; si una imagen falla, placeholder                                                                                                                                                                                                                                                                                                             | —                              |
| Estabilidad de códigos               | Nada                                                                                       | `hotel_id` y `provider_city_code` se tratan como estables; un hotel que cambia de ciudad se mueve por upsert                                                                                                                                                                                                                                                                                                        | —                              |

---

## 11. ¿El catálogo depende de la cuenta (BYOC) o es global?

**Qué dice el contrato:** nada explícito (VERIFICADO-PDF, pp. 51-69).

**Señales hacia "global"** (INFERIDO): los códigos se describen como "Unique TBOH hotel code" y "Unique TBOH City
code" (pp. 55, 58, 65-66), y `hotelcodelist` promete "the complete hotel code list" sin parámetros (p. 54).

**Señales hacia "depende de la cuenta"** (INFERIDO): la cuenta tiene un perfil propio que al menos fija la moneda
("Configured currency in the API profile of the client", p. 13), y un perfil así podría restringir mercados o
proveedores de contenido.

**Postura adoptada:**

- Códigos y contenido **globales**. Se sincronizan **una vez por proveedor** con la cuenta de plataforma (§6.6) en
  tablas cross-tenant, igual que `hotel_inventory` para Despegar (`tools/sync-hotel-inventory/src/index.ts:139`).
- La **disponibilidad sí es por cuenta**: Search se llama con la credencial que resuelva
  `resolve_provider_account` para el tenant, propia o heredada ([02](./02-search-y-oferta-canonica.md)). Si una
  cuenta BYOC no tiene acceso a ciertos hoteles, lo esperable es que no aparezcan en `HotelResult`. Qué pasa si
  Search rechaza el lote entero por un código no permitido lo trata [02](./02-search-y-oferta-canonica.md).
- **Verificación en certificación (sonda de catálogo):** con dos cuentas de test distintas (la de plataforma y
  la de una agencia piloto, si existe), comparar el conteo y un hash de `hotelcodelist` y de `TBOHotelCodeList`
  para tres ciudades. Script de solo lectura, fuera del código de producción. Resultado a [07](./07-certificacion.md).
- → [Q-60](./10-preguntas-para-tbo.md#q-60).

**Si resultara "por cuenta"**, cambia bastante: (a) sync por cada nodo con cuenta BYOC, lo que obliga al tool a
descifrar credenciales de la bóveda con `PROVIDER_CREDENTIALS_KEY`, un secreto nuevo en otro contenedor; (b) una
tabla de alcance por cuenta (`provider_account_id`, `hotel_id`) con RLS por dueño; (c) la resolución de destino
intersecta el catálogo global con el alcance de la cuenta del tenant. Es la razón para preguntar antes de
construir.

---

## 12. Contradicciones y huecos del contrato

| ID    | Hueco o contradicción                                                                                                                                                                                                                                            | Cita                      | Postura de diseño                                                                                                                                                                                                                                                                                 | ¿Solo TBO lo resuelve?                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CE-01 | Contenedores `Object` que llegan como array; `Integer` que llegan como string; `String` que llegan como array u objeto                                                                                                                                           | pp. 52-69                 | Zod con uniones y normalización (§3)                                                                                                                                                                                                                                                              | no                                                                                                                                                                                                            |
| CE-02 | `HotelRating` es enum `"ThreeStar"` en `TBOHotelCodeList` y número `5` en `HotelDetails`; la tabla dice Enumeration en ambos                                                                                                                                     | pp. 59, 62, 66-67         | Aceptar ambos y mapear a 1-5                                                                                                                                                                                                                                                                      | → [Q-68](./10-preguntas-para-tbo.md#q-68)                                                                                                                                                                     |
| CE-03 | `Hotelcodes` (HotelDetails) frente a `HotelCodes` (Search); la tabla dice "Hotel Code" en singular, Integer, y los ejemplos mandan número, string o CSV                                                                                                          | pp. 10, 56, 58; Postman   | Enviar `Hotelcodes` como string CSV, igual que Postman                                                                                                                                                                                                                                            | no                                                                                                                                                                                                            |
| CE-04 | Paths con casing distinto: `HotelDetails` (PDF) y `Hoteldetails` (Postman); `hotelcodelist` en minúsculas                                                                                                                                                        | pp. 54-56; Postman        | Una sola constante `TBO_OPERATIONS` con el casing del PDF en todos los paths (`HotelDetails`, `hotelcodelist`); la sonda PR-04 prueba las dos grafías y la que funcione queda en la constante ([01](./01-autenticacion-conectividad-y-errores.md) §3.2; [08](./08-requisitos-maestro.md) §9 C-03) | → [Q-05](./10-preguntas-para-tbo.md#q-05)                                                                                                                                                                     |
| CE-05 | `hotelcodelist` no está en Postman y su ejemplo no trae `Status`                                                                                                                                                                                                 | pp. 54-55; Postman        | E5 opcional; si responde 404 o error, se desactiva sin afectar E1-E4                                                                                                                                                                                                                              | → [Q-61](./10-preguntas-para-tbo.md#q-61)                                                                                                                                                                     |
| CE-06 | `IsRoomDetailRequired` y los campos de habitación no están en la tabla; se desconoce la clave del contenedor                                                                                                                                                     | pp. 56-59                 | `passthrough`, función apagada hasta tener fixture real                                                                                                                                                                                                                                           | → [Q-65](./10-preguntas-para-tbo.md#q-65)                                                                                                                                                                     |
| CE-07 | `RoomID` array de strings en Search, `RoomId` número en HotelDetails; `0` = sin mapeo; Search no lo lista en su tabla                                                                                                                                            | pp. 13-15, 57             | Normalizar a string; `"0"` → `null`                                                                                                                                                                                                                                                               | → [Q-65](./10-preguntas-para-tbo.md#q-65)                                                                                                                                                                     |
| CE-08 | El key point "pass IsDetailedResponse as 'False'" no dice a qué método aplica; no se sabe qué trae `TBOHotelCodeList` con `false`                                                                                                                                | pp. 11, 65, 71            | E3 con `"true"` hasta probar `"false"`                                                                                                                                                                                                                                                            | → [Q-63](./10-preguntas-para-tbo.md#q-63)                                                                                                                                                                     |
| CE-09 | `TBOHotelCodeList` dice devolver "Images etc" pero no trae `Images`, `CheckInTime` ni `CheckOutTime`; la tabla trae `CityId` y el ejemplo no; `HotelWebsiteURL` en tabla y `HotelWebsiteUrl` en ejemplo                                                          | pp. 65-69                 | Ciudad desde la request; ambas claves de web; imágenes y horarios solo de HotelDetails                                                                                                                                                                                                            | no                                                                                                                                                                                                            |
| CE-10 | `Attractions` es array (HTML partido) en un método y objeto `{"1) ": …}` en el otro                                                                                                                                                                              | pp. 61, 67                | Unir a un solo HTML                                                                                                                                                                                                                                                                               | no                                                                                                                                                                                                            |
| CE-11 | La lista de idiomas no incluye `EN`; los ejemplos usan `"EN"` y `"en"`                                                                                                                                                                                           | pp. 56, 58                | Mayúsculas; EN de fallback                                                                                                                                                                                                                                                                        | → [Q-66](./10-preguntas-para-tbo.md#q-66)                                                                                                                                                                     |
| CE-12 | `Address` se describe como "first line" pero trae la dirección completa; `PinCode` "of hotel's city" es el CP del hotel; en `HotelDetails` hay descripciones que repiten literalmente las de BookingDetail ("… of the hotel booked"; que sean copia es INFERIDO) | pp. 45, 59, 62, 66-67     | Guardar tal cual, sin parsear la dirección                                                                                                                                                                                                                                                        | no                                                                                                                                                                                                            |
| CE-13 | Ejemplos con JSON inválido: `CountryList` y `CityList` truncados, `hotelcodelist` con `.` de relleno, coma final en `Images`, `TBOHotelCodeList` elidido y sin cerrar                                                                                            | pp. 53, 54, 55, 62, 67-69 | Fixtures solo de respuestas reales capturadas                                                                                                                                                                                                                                                     | no                                                                                                                                                                                                            |
| CE-14 | `Status.Description` varía: `"Success"` o `"Successful"`                                                                                                                                                                                                         | pp. 52, 54, 59, 67        | Decidir solo por `Status.Code`                                                                                                                                                                                                                                                                    | no                                                                                                                                                                                                            |
| CE-15 | Sin límites documentados: QPS, lote de HotelDetails, paginación, tamaño, timeouts                                                                                                                                                                                | pp. 8-9, 54-69            | §10                                                                                                                                                                                                                                                                                               | → [Q-09](./10-preguntas-para-tbo.md#q-09), [Q-10](./10-preguntas-para-tbo.md#q-10), [Q-61](./10-preguntas-para-tbo.md#q-61), [Q-62](./10-preguntas-para-tbo.md#q-62), [Q-64](./10-preguntas-para-tbo.md#q-64) |
| CE-16 | Codificación rota en origen (apóstrofes perdidos, caracteres de reemplazo)                                                                                                                                                                                       | pp. 60-61                 | UTF-8 tolerante; nunca falla el sync por texto                                                                                                                                                                                                                                                    | no                                                                                                                                                                                                            |
| CE-17 | Hosts de imagen distintos (`api.tbotechnology.in`, `www.tboholidays.com`); sin política de uso ni caducidad                                                                                                                                                      | pp. 57, 62                | No fijar host; hotlink; placeholder                                                                                                                                                                                                                                                               | → [Q-67](./10-preguntas-para-tbo.md#q-67)                                                                                                                                                                     |
| CE-18 | `CityList` sin coordenadas, región ni IATA, e incluye aldeas                                                                                                                                                                                                     | p. 54                     | Centroide desde hoteles; cadencia menor para ciudades sin hoteles                                                                                                                                                                                                                                 | no                                                                                                                                                                                                            |
| CE-19 | No se sabe si el catálogo depende de la cuenta                                                                                                                                                                                                                   | pp. 13, 54-55, 65         | §11                                                                                                                                                                                                                                                                                               | → [Q-60](./10-preguntas-para-tbo.md#q-60)                                                                                                                                                                     |
| CE-20 | Base URL de test en `http://` pese a "should be secured with HTTPS"; Basic Auth por http viaja en claro                                                                                                                                                          | p. 7; Postman; Cert       | Ver [01](./01-autenticacion-conectividad-y-errores.md). El sync nunca manda credenciales live por http                                                                                                                                                                                            | → [Q-03](./10-preguntas-para-tbo.md#q-03)                                                                                                                                                                     |

---

## 13. Preguntas para TBO

Las consolida [10](./10-preguntas-para-tbo.md). Cada una se entiende sin este documento.

1. `HotelDetails` (pp. 56, 58; Postman "Hotel Details" manda 13 códigos): ¿cuál es el máximo de códigos por
   llamada en `Hotelcodes`? ¿Acepta array además de string CSV? ¿Qué devuelve si uno de los códigos no existe:
   error para todo el lote u omisión de ese hotel?
2. `TBOHotelCodeList` (pp. 65, 71): ¿qué campos devuelve con `IsDetailedResponse` en `false`? En particular,
   ¿vienen `Map`, `HotelRating` y `CountryCode`? El key point de p. 71 que recomienda `'False'`, ¿aplica a Search,
   a `TBOHotelCodeList` o a ambos? ¿Acepta `CityCode` numérico e `IsDetailedResponse` como boolean JSON, o solo
   strings como en los ejemplos?
3. `TBOHotelCodeList` (pp. 65-69): ¿pagina o trunca la respuesta en ciudades grandes? ¿Hay máximo de hoteles por
   ciudad? ¿Por qué el ejemplo no trae `CityId` si la tabla lo declara?
4. `hotelcodelist` (pp. 54-55): ¿sigue vigente? No está en la colección Postman. ¿El path distingue mayúsculas?
   ¿Cuántos códigos devuelve hoy, aproximadamente? ¿Es el mismo universo que la unión de `TBOHotelCodeList` de
   todas las ciudades?
5. Límite de tasa (p. 9, `LIMIT_EXCEEDED` 429): ¿cuál es el QPS permitido para los métodos estáticos? ¿Comparten
   cuota con Search, PreBook y Book? ¿La cuota es por cuenta, por IP o global? ¿Hay una ventana horaria
   recomendada para descargas masivas?
6. Frecuencia (pp. 51-69): ¿cada cuánto recomiendan refrescar el catálogo? ¿Existe algún mecanismo de deltas
   ("modificados desde")? ¿Cómo comunican altas, bajas y fusiones de hoteles?
7. BYOC (pp. 13, 54-55, 65): ¿los códigos de ciudad y de hotel y el contenido de `HotelDetails` son idénticos para
   todas las cuentas, o dependen de la cuenta, el mercado o el contrato? Si una sub-agencia tiene su propia cuenta
   TBO, ¿puede buscar con los `HotelCodes` descargados con la cuenta del consolidador?
8. `IsRoomDetailRequired` (pp. 56-57, cambio del 27-oct-2025): ¿con qué clave y en qué posición de la respuesta
   llegan las habitaciones? ¿Pueden enviar un ejemplo completo? ¿Search devuelve siempre `RoomID` aunque su tabla
   (pp. 13-15) no lo liste? ¿`RoomSize` usa siempre pies cuadrados?
9. Idioma (pp. 56, 58, 65): ¿`EN` es un valor soportado aunque no esté en la lista? ¿El código distingue
   mayúsculas (`"EN"` frente a `"en"`)? ¿Qué devuelve si no hay traducción al idioma pedido? ¿En qué idioma llega
   el contenido de `TBOHotelCodeList`, que no tiene parámetro de idioma?
10. Imágenes (pp. 57, 62): ¿podemos mostrar, cachear o copiar a nuestro almacenamiento las imágenes de
    `imageresource.aspx?img=`? ¿El token caduca? ¿Cambia el host en producción? ¿Se sirven siempre por https?
11. `HotelRating` (pp. 59, 62, 66-67): ¿por qué `HotelDetails` lo devuelve como número (`5`) y `TBOHotelCodeList`
    como enum (`"ThreeStar"`)? ¿Puede traer medias estrellas u otros valores?
12. Timeouts (p. 8): ¿qué timeout recomiendan para `CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails`
    y `hotelcodelist`?
13. Errores (pp. 8-10): ¿qué `Status.Code` y qué código HTTP devuelven los métodos estáticos ante un `CountryCode`
    o `CityCode` inexistente, o una cuenta sin permiso?
14. Códigos de ciudad (pp. 54, 62, 65): ¿`CityList[].Code`, `TBOHotelCodeList.CityCode` y `HotelDetails[].CityId`
    son el mismo código? ¿Son estables en el tiempo? ¿Un hotel puede cambiar de ciudad?
15. Mapeo (no aparece en pp. 51-69): ¿TBO entrega GIATA ID u otro código de mapeo de hoteles que podamos usar para
    deduplicar con otros proveedores?
16. Certificación (Cert): ¿hay que declarar en el workflow que se entrega los métodos estáticos y la sincronización
    del catálogo? ¿La verificación del portal revisa la presentación del contenido (imágenes, horarios de
    check-in, instrucciones)?

---

## 14. Decisiones para el founder

Cada decisión trae opciones concretas y una recomendación. Las consolida [08](./08-requisitos-maestro.md).

**Estado al 2026-09-25:** el founder firmó D-TBO-02 (B), D-TBO-03 (A), D-TBO-06 (A) y D-TBO-07 (A) y pidió aplicar
la opción recomendada en todas las demás hasta nuevo aviso; lo que manda es el
[Registro de decisiones](./08-requisitos-maestro.md#registro-de-decisiones) de 08.

1. **Países de destino a sincronizar en la primera ola.** Cada país cuesta una llamada por ciudad, aldeas
   incluidas (p. 54). (a) Solo destinos domésticos CO, PE y BR; (b) esos más los destinos más vendidos desde LATAM
   (por ejemplo US, MX, DO, AR, CL, ES), según la lista comercial; (c) todo el catálogo, no recomendado sin conocer
   el QPS. **Recomendación: (b) con lista cerrada**, ampliable por configuración (`TBO_SYNC_COUNTRIES`).
2. **Herramienta de sync.** (a) Herramienta aparte `tools/sync-tbo-hotel-inventory`; (b) convertir el sync de
   Despegar en runner multi-proveedor. **Recomendación: (a)**: no toca un job que funciona y cada proveedor tiene su
   propia cadencia (§6.2).
3. **Contenido rico (imágenes, descripción, horarios).** (a) Descarga por lotes para todos los hoteles activos de
   los países habilitados; (b) solo hoteles de destinos con demanda más la carga bajo demanda al abrir el detalle,
   sin persistir desde el API. **Recomendación: (b) al inicio**, pasando a (a) cuando se conozca el QPS.
4. **Imágenes.** (a) Hotlink a las URLs de TBO; (b) copia a MinIO/S3. Depende de la licencia (§13, pregunta sobre imágenes).
   **Recomendación: (a) en fase 1**; (b) solo si TBO lo permite y los tokens caducan.
5. **Resolución de destino en fase 1.** (a) Mapa calculado contra el id de Despegar (opción B de §8), que deja la
   búsqueda TBO dependiendo del autocomplete de Despegar; (b) autocomplete y destinos propios desde ya (opción C),
   con más trabajo de UI y curaduría. **Recomendación: (a)**, salvo que se quieran tenants solo-TBO desde el
   lanzamiento o se elija un módulo TBO paralelo, que exigen (b).
6. **Hoteles repetidos entre Despegar y TBO.** (a) Agrupar desde el día 1 con la heurística conservadora (§9);
   (b) mostrar duplicados etiquetados por proveedor hasta tener GIATA. Además: ¿se muestra el proveedor en la
   tarjeta de hotel? Hoy el flag de 0036 solo aplica a vuelos. **Recomendación: (a) con revisión manual de los
   casos dudosos**, y proveedor visible según la política de divulgación de 0036, que es lo que el founder fijó el
   2026-09-25 ([08](./08-requisitos-maestro.md) RF-40 y §9 C-29; esta línea decía antes "visible para el rol del
   vendedor").
7. **Cuenta TBO de plataforma para el catálogo.** Aunque todas las agencias traigan su cuenta, el sync necesita una
   cuenta propia de test y otra de producción. (a) Una cuenta dedicada al sync; (b) la misma cuenta que se hereda
   para ventas. **Recomendación: (a)**, para que el sync no consuma la cuota de venta. Es una gestión comercial con
   TBO.
8. **Idiomas de contenido a guardar.** (a) ES, PT y EN, con triple almacenamiento y triple llamada; (b) ES y PT,
   con EN solo como fallback bajo demanda. **Recomendación: (a) para hoteles con demanda y (b) para el resto.**
9. **Horario del cron.** 03:30 UTC cae en horario de venta en Bogotá y Lima. (a) Mantenerlo; (b) moverlo a
   ~08:00 UTC con corridas horarias dentro de la ventana. **Recomendación: (b)** si la cuenta del sync comparte
   cuota con ventas.
