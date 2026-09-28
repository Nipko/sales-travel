# Fixtures de `@sales-travel/tbo-hotels`

Procedencia de cada fixture y de cada corrección que se le hizo. La convención de citas es la de
[`docs/tbo/00-fuentes.md`](../../../../docs/tbo/00-fuentes.md): "(p. N)" es la página **física** del
PDF, nunca el pie impreso ni el índice.

## Fuentes, fijadas por hash (RNF-15)

La versión "2.1" del PDF cubre cambios de 2023 y de 2025 sin subir de número (p. 6), así que la
fuente se identifica por su SHA-256 y no por la versión. Un PDF nuevo exige hash nuevo, diff y
revisión de estos fixtures (→ Q-01, canal de avisos de cambios).

| Fuente                                                             | SHA-256                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/tbo/TBOH_Hotel_API_Specifications(V2.1).pdf` (71 páginas)    | `bb406ac31c5def12863b040d306f10a32e83f4ddaa3620ebe1f20693c277511a` |
| `docs/tbo/HotelAPI_Client.postman_collection 7.json` (10 requests) | `d5ec68fccf57d80859a259dbcd188bc9fd07122498208190675979ed1eb398d4` |

Reproducir: `sha256sum docs/tbo/*` (o `certutil -hashfile <archivo> SHA256` en Windows).

## Regla

- Todo lo que está en `pdf/` es **derivado del PDF** (C-02): transcrito a mano y comparado contra la
  página renderizada, no copiado de `pdftotext`. `pdftotext` convierte las comillas tipográficas en
  `"` ASCII y así esconde justo los ejemplos rotos ([00](../../../../docs/tbo/00-fuentes.md) §5).
- Un JSON inválido del PDF se corrige y la corrección se escribe aquí. Nunca se "arregla" un dato: si
  el contrato manda un importe como string, el fixture lo manda como string.
- Nada con forma de tarjeta entra: los ejemplos de Book con `NewCard` o `SavedCard` (p. 34-40) no se
  copian (D1).
- **Verificación diferida.** Las respuestas reales anonimizadas de la sonda (PR-1.6) y de la
  certificación (PR-7.1) reemplazan a los fixtures del PDF como fuente de los tests de mapper, igual
  que `providers/sabre/src/__fixtures__/`.

## `pdf/` — Search (docs/tbo/02)

| Archivo                              | Ejemplo del PDF                                    | Páginas | ¿JSON válido en el PDF? | Normalización                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-single-room.p15.json`        | 6.2.1 Sample Response (Single Room) \_Successful   | 15-16   | Sí                      | Sólo forma: sangría uniforme de 2 espacios, arrays cortos en una línea (`Name`, `RoomPromotion`) y fuera el pie de página que corta el ejemplo entre p. 15 y 16. Claves, orden, valores y tipos, literales: `TotalFare` número, `ExtraGuestCharges` y `RecommendedSellingRate` string, `Supplements` array de arrays. El PDF escribe `"Price": 20.00`; Prettier, que formatea el repo, lo reescribe `20.0`. Es el mismo número JSON y ningún test depende del literal. |
| `search-multi-room.p16.json`         | 6.2.2 Sample Response (Multiple Room) \_Successful | 16-18   | Sí                      | Ídem. En p. 17 el segundo pack escribe `"ExtraGuestCharges":"17.22"` sin espacio tras los dos puntos; se normaliza el espacio, el valor sigue siendo el string `"17.22"`.                                                                                                                                                                                                                                                                                              |
| `search-no-availability.p18.json`    | 6.2.3 Sample Response \_No Availability            | 18      | Sí                      | Ninguna salvo la sangría. `Status.Code` 201 sin `HotelResult`, y un `Description` ("No Available rooms for given criteria") que no coincide con el texto de la tabla de estados (p. 9): por eso ninguna regla compara `Description`.                                                                                                                                                                                                                                   |
| `search-request-multi-room.p12.json` | 6.1.2 Sample Request (Multiple Room)               | 12      | **No**                  | Dos correcciones, vistas en la PNG de p. 12: (1) `"MealType": “All”` va con comillas tipográficas U+201C/U+201D y se reemplazan por `"`; (2) al ejemplo le falta la `}` que cierra el objeto raíz y se agrega. `ResponseTime` se deja escrito `23.0` como en el PDF (en JSON es el número 23). El ejemplo 6.1.1 (una habitación, p. 11-12) tiene los mismos dos defectos y no se copia: no agrega forma nueva.                                                         |

Lo que ningún fixture de Search trae, porque el PDF no lo muestra (p. 15-18, por ausencia):
`DayRates` y `CancelPolicies` (sólo con `IsDetailedResponse: true`, p. 11), `RoomID` (sólo en la
nota de p. 57), suplementos `Included` y `HotelResult` sin `Currency`. Esos casos se construyen en
los tests a partir de estos fixtures, con los valores de PreBook y BookingDetail de p. 24, 28 y 50
cuando existen, y cada uno cita su página.

## `pdf/` — contenido estático (docs/tbo/05; PR-3.1)

[05](../../../../docs/tbo/05-contenido-estatico-e-inventario.md) CE-13 pedía fixtures sólo de
respuestas reales, porque cinco de los seis ejemplos del PDF son JSON inválido. El plan (09 PR-3.1)
los pide igual desde el PDF, con las correcciones de [00](../../../../docs/tbo/00-fuentes.md) §8.4
declaradas: son la única evidencia hasta la sonda de PR-1.6 y se reemplazan como las de Search.

| Archivo                          | Ejemplo del PDF                             | Páginas | ¿JSON válido en el PDF? | Normalización (detalle abajo)                                                                                      |
| -------------------------------- | ------------------------------------------- | ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `country-list.p52.json`          | 11.2.1 Sample Response (`CountryList`)      | 52-53   | **No**                  | Truncado: se cierran el array y la raíz tras el quinto país.                                                       |
| `city-list.p54.json`             | 12.2.1 Sample Response (`CityList`)         | 54      | **No**                  | Truncado: se cierran el array y la raíz tras la cuarta ciudad.                                                     |
| `hotelcodelist.p55.json`         | 13.2.1 Sample Response (`hotelcodelist`)    | 55      | **No**                  | Se quitan las dos líneas `.` de relleno. Sin `Status`, como en el PDF.                                             |
| `hotel-details-request.p58.json` | 14.1.1 Sample Request (`HotelDetails`)      | 58      | Sí                      | Ninguna salvo la sangría. `Hotelcodes` queda NÚMERO, como en el PDF.                                               |
| `hotel-details.p59.json`         | 14.2.1 Sample Response (`HotelDetails`)     | 59-62   | **No**                  | Coma sobrante tras la última URL de `Images`; strings largos reunidos desde el recuadro partido.                   |
| `tbo-hotel-code-list.p67.json`   | 16.2.1 Sample Response (`TBOHotelCodeList`) | 67-69   | **No**                  | `Attractions` reconstruido (el más delicado, INFERIDO); se cierran `Hotels` y la raíz tras el `},` final de p. 69. |

Reglas comunes a los seis, comparadas contra la PNG de cada página (00 §5):

- **Saltos de línea del recuadro.** El PDF parte los strings largos en el borde del recuadro, a veces
  en medio de una palabra (`"A stay a` / `t Sofitel"`, `"Ob` / `elisk"`, `"Egyp` / `t"`) y a veces
  tras un guion (`"5-` / `minute"`, `"check-` / `in"`, `"new-` / `york"` en la web de p. 69). Se unen
  sin agregar nada; entre dos palabras enteras (`"connected,` / `and"`, `"mobile payments` /
  `Safety"`) va un espacio. Los dobles espacios que el texto extraído conserva (`"Island.  This"`,
  `"arrival.  Due"`) se dejan.
- **Caracteres no ASCII desde la PNG**, no desde `pdftotext`, que los cambia por `�`: `café`
  (p. 60-61), `property’s` con U+2019 (p. 60) y `Wheelchair accessible – no` con U+2013 (p. 61).
- **Datos intactos**: los apóstrofes perdidos en origen (`hotel s`, `doesn t`, `Kitchener s`), el
  espacio final de la dirección de p. 67 y el `CityNew` pegado se copian tal cual; los tipos también
  (`HotelRating` `"ThreeStar"` frente a `5`, `CityId` string, `HotelCodes` enteros).

Detalle por archivo:

- `country-list.p52.json`: el ejemplo trae cinco países y termina en `},` al principio de p. 53, sin
  `]` ni `}`. Se cierra ahí.
- `city-list.p54.json`: cuatro ciudades y el recuadro acaba sin `]` ni `}`. Se cierran.
- `hotelcodelist.p55.json`: `[1000000, 1000001, 1000002, ., ., 5000008]` pasa a los cuatro códigos
  visibles. El rango real no se conoce (Q-61).
- `hotel-details-request.p58.json`: se copia tal cual para dejar escrita la discrepancia (CE-03): el
  PDF manda `Hotelcodes` como número y el builder, como string CSV igual que Postman y p. 56.
  `hotel-details.request.builder.test.ts` fija que difieren sólo en ese tipo.
- `hotel-details.p59.json`: además de la coma tras la segunda URL de `Images` (p. 62), cada URL se
  reúne de sus tres renglones (`…img=9eMP+0FIICgCIk6ZC` / `lzZH9Cs+…K6we` / `UG+E=`). Los 47
  servicios, en el orden del PDF. La nota de habitaciones de p. 56-57 (`IsRoomDetailRequired`) NO se
  copia: no dice dónde va el contenedor (Q-65) y el detalle por habitación sigue apagado.
- `tbo-hotel-code-list.p67.json`: el primer trozo de `Attractions` se corta en p. 67 con ocho líneas
  `/` sueltas, y fuera del recuadro quedan ocho renglones con la forma `1.1 km   0.7 mi` a los que
  les falta justamente la `/`. Se reconstruye (INFERIDO) poniendo cada `/` en su renglón y los ocho
  renglones a continuación de `Lunt-Fontanne Theatre -`, con lo que el primer trozo termina en
  `… 16.8 mi<br /> New York`. La prueba de que es la lectura correcta es el propio ejemplo: unidos con
  `","`, los tres trozos dan `New York, NY (NYS-Skyports Seaplane Base)` y `Teterboro, NJ (TEB)`, que
  es lo que 05 §3 infiere (un HTML cortado en cada coma). El texto `<p>` / `American Lyric Theater`,
  partido entre renglones, se une con un espacio, como lo cita 05 §2.5.

## `pdf/` — PreBook (docs/tbo/03; PR-4.1)

| Archivo                                | Ejemplo del PDF                                          | Páginas | ¿JSON válido en el PDF? | Para qué                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------- | ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `prebook-request-limit.p19.json`       | 7.1.2 Sample Request (Multiple Room) \_Booking By Limit  | 19      | Sí                      | El builder lo reproduce con su `BookingCode`. Los ejemplos 7.1.1 y 7.1.3 (`NewCard`, `SavedCard`) no se copian: D1.               |
| `prebook-newcard-single-room.p23.json` | 7.2.1 Sample Response (Single Room) \_By New Credit Card | 23-27   | Sí                      | SÓLO para probar que `CreditCardBillingOptions` se descarta (03 §2.8). No trae datos de tarjeta: PreBook no los lleva (p. 19-20). |
| `prebook-limit-multi-room.p28.json`    | 7.2.2 Sample Response (Multiple Room) \_By Limit         | 27-32   | Sí                      | El caso principal: dos habitaciones, suplementos `AtProperty` en AED, `RecommendedSellingRate` y las 13 `RateConditions` enteras. |

- **Qué se tomó de dónde.** Estructura y valores de PyMuPDF sobre el PDF, comparados contra la PNG de
  cada página: a diferencia de `pdftotext`, conserva `°` (`60°C/140°F`, p. 31-32) y las comillas
  tipográficas U+201C/U+201D de `“Tourism Dirham”` (p. 30), que están DENTRO de un string y no rompen el
  JSON. El título de 7.2.2 está en p. 27 y su JSON empieza en p. 28 (de ahí el nombre del archivo).
- **Saltos de línea del recuadro**, con la regla del contenido estático: en medio de una palabra
  (`otherwis` / `e`, `Gov` / `ernment-`, `&lt;/l` / `i&gt;`, `&` / `lt;li&gt;`) se une sin nada; tras un
  guion (`Extra-` / `person`, `check-` / `in`, `AED 7-` / `20`, `commonly-` / `touched`) también; entre
  dos palabras enteras, un espacio (`charged` / `by`, `may` / `not`, `are` / `provided`). El espacio con
  que empiezan algunos renglones del ítem largo de p. 31 (` eservations`, ` formation`) es la sangría del
  recuadro, no texto. `stays -` / ` 24 hours` y `Terms of Use -` / `http://…` llevan un espacio a cada
  lado del guion.
- **Espacios que el PDF sí trae y se conservan:** el final de `"CheckIn Time-Begin: 3:00 PM "`, el
  inicial de `" CheckIn Time-End: 3:00 AM"`, `" Special Instructions : … arrival. "` (la comilla de
  cierre cae en el renglón siguiente) y los espacios entre etiquetas escapadas (`&lt;/li&gt;   &lt;li&gt;`).
  Donde la PNG muestra varios espacios entre etiquetas y no se pueden contar con precisión (7.2.2,
  "Optional Fees"), van dos: el saneo los colapsa y ningún test depende de cuántos son.
- **Comprobación:** el generador verifica que cada ítem de `RateConditions`, sin espacios, aparece
  igual en el texto del PDF sin espacios (quitadas la cabecera y el pie de página que cortan los ítems
  que cruzan de p. 30 a 31 y de 31 a 32).
- **Números:** como en Search, el JSON conserva el tipo y el valor, no el literal: `17.10` queda `17.1`,
  `15.15762150` queda `15.1576215` y `20.00` queda `20.0`. `ExtraGuestCharges` y
  `RecommendedSellingRate` siguen siendo strings.
- **Lo que el PDF no muestra y los tests construyen** a partir de 7.2.2, citando la página: otro
  `BookingCode` en la respuesta (Q-30), `Supplements` plano, una moneda de otro exponente, dos
  `HotelResult`, una norma que no es texto y el `&amp;lt;script&amp;gt;` de RF-16 CA-1. Las señales
  "No Name change allowed" y "NOT VALID FOR Germany Market" salen del `RateConditions` de
  BookingDetail (p. 51), que es de otro método y no se copia como fixture de PreBook.

## `pdf/` — Book y BookingDetail (docs/tbo/03 y 04; PR-4.2)

| Archivo                                  | Ejemplo del PDF                                               | Páginas | ¿JSON válido en el PDF? | Para qué                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `book-request-limit-multi-room.p35.json` | 8.1.2 Sample Request (Multiple Room) \_Booking By Limit       | 35-36   | Sí                      | El builder lo reproduce con nuestras referencias y `PaymentMode` explícito (CK-10, CK-11). `EmailId` y `PhoneNumber` **sustituidos** por sintéticos.       |
| `book-response.p41.json`                 | 8.2.1 Sample Response                                         | 41      | Sí                      | La respuesta del Book. El título está en p. 40 y el JSON en p. 41. Su `ClientReferenceId` no es el de ningún request del PDF: contra el nuestro, incierto. |
| `booking-detail-request.p44.json`        | 10.1.1 y 10.1.2 Sample Request (por localizador y referencia) | 44      | Sí                      | Los dos requests en un objeto (`byConfirmationNumber`, `byBookingReferenceId`). El builder reproduce el primero y la forma del segundo.                    |
| `booking-detail.p49.json`                | 10.2.1 Sample Response                                        | 49-51   | **No**                  | La lectura de BookingDetail (RF-24 CA-1), con el `BookingDate` imposible conservado como test de robustez.                                                 |

- **Datos personales sustituidos en 8.1.2.** El PDF manda `<email-de-ejemplo-del-PDF>`, el buzón de una
  persona de TBO, y `919999999999`. Van `reservas@agencia.example` (dominio reservado, RFC 2606) y
  `573001234567`, que es la forma que el builder emite: dígitos con prefijo de país, sin `+`, y el
  contacto de la agencia (D-TBO-23 A). Nada más cambia: el `ClientReferenceId`
  (`1626135861wq4415-5686105`) y el `BookingReferenceId` (`AVw12118`) del PDF quedan como están,
  aunque nuestro builder nunca los emitiría (no son referencias nuestras), porque el test compara la
  FORMA y reemplaza esos dos valores.
- **Los otros ejemplos de Book no se copian.** 8.1.1 (p. 34-35) usa `NewCard` con datos de tarjeta y
  comillas tipográficas; 8.1.3 (p. 36-38) se titula "by limit" pero usa `NewCard` con un número con
  forma de PAN (`5555555555554444`); 8.1.4 (p. 39-40) usa `SavedCard` con `CvvNumber` y le falta una
  coma. Los tres quedan fuera por D1 (03 §3.7).
- **Correcciones de 10.2.1** (comparadas contra la PNG de p. 49-51):
  - `"Type": “Adult”` y `"Type": “Child”` (p. 50-51) llevan comillas tipográficas U+201C/U+201D; se
    reemplazan por `"`. Es la corrección que 04 §3.4 declara y lo único que hacía inválido el JSON.
  - `"BookingDate": "2021-07-1317T00:00:00"` se conserva tal cual: es el caso de robustez de RF-24
    CA-1 (PV-03).
  - `RateConditions` se reúne de los renglones del recuadro con la regla del contenido estático: entre
    dos palabras enteras un espacio (`otherwise` / `specified`, `Germany` / `MarketDubai`), tras un
    guion nada (`s3-eu-` / `west-1`). Los tres caracteres de reemplazo `�` (U+FFFD) que muestra la
    PNG se conservan donde están (`hotel�s time`, `providers � including`, `ancillaries � guests`):
    `pdftotext` y PyMuPDF los pierden como saltos de línea, y son justo el encoding roto que motiva
    D-TBO-23 A. La pegadura de `yearNOT VALID` y `MarketDubai` es del PDF y se deja.
  - Los datos de los huéspedes (`Shubham Gupta`, `Kunal Agrawal`) son los del ejemplo publicado y se
    dejan: el test de RF-24 CA-3 verifica que no salen de la lectura ni llegan a un log.
- **Números:** como en Search y PreBook, Prettier reescribe el literal y conserva el valor:
  `107.14000000000000` queda `107.14`, `0.00` queda `0.0` y `100.00` queda `100.0`. Da igual para el
  test: `JSON.parse` pierde el literal de todas formas, y el mapper toma el texto decimal del número
  (`tboDecimalText`).
- **Lo que el PDF no muestra y los tests construyen** a partir de 10.2.1: `HotelConfirmationNumber`
  (con valor, vacío y `null`, PV-05), `VoucherStatus` `false` y `"Confirm"` (PV-02), los estados de
  cancelación del enum (p. 70-71) y `Vouchered` (p. 64), `Rooms` en sus dos formas (PV-07),
  `CustomerDetails` y `CreditCardOptions` a nivel de reserva (PV-06) y los desenlaces de "no existe",
  que el PDF no documenta (PV-01, Q-37) y fija la sonda PR-05.

## `pdf/` — Cancel y BookingDetailsbasedondate (docs/tbo/04; PR-5.1)

| Archivo                            | Ejemplo del PDF                                          | Páginas | ¿JSON válido en el PDF? | Para qué                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------- | ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-request.p41.json`          | 9.1.1 Sample Request (`Cancel`)                          | 41      | Sí                      | El builder lo reproduce byte a byte: sólo `ConfirmationNumber`, sin `PaymentMode`. En una línea, como en el PDF.                                  |
| `cancel-response.p42.json`         | 9.2.1 Sample Response (`Cancel`)                         | 42      | Sí                      | El `200` "Cancelled", que el adapter lee como cancelación **aceptada** (PV-16). Sólo trae `Status` y `ConfirmationNumber`: ni cargo ni estado.    |
| `booking-by-date-request.p63.json` | 15.1.1 Sample Request (By Date)                          | 63      | Sí                      | Deja escrita la discrepancia PV-25: el ejemplo usa `fromdate`/`todate` y el builder, `FromDate`/`ToDate` de la tabla (p. 62) y de Postman.        |
| `booking-by-date.p64.json`         | 15.2.1 Sample Response (`HotelBookingDetailBasedOnDate`) | 64      | Sí                      | La lectura de la conciliación: dos reservas `Vouchered` (fuera del enum, PV-28), `BookingDetail` como array (PV-27) y los `TripName` a descartar. |

- **Qué se tomó de dónde.** Valores comparados contra la PNG de cada página y contra el texto de
  PyMuPDF. El título 15.1.1 está en p. 62 y su JSON en p. 63; el título 15.2.1 y su JSON, en p. 64
  (el pie impreso dice "59": la convención es la página física).
- **Localizadores.** `GOF05R` lleva la letra O después de la G y un cero antes del 5: en la fuente
  del PDF el cero va con punto y la O no. `7L4F4E` es tal cual.
- **Sin normalización** salvo la sangría: `AgentMarkup` y `BookingPrice` siguen siendo strings,
  `Index` sigue siendo número y las fechas quedan `DD-MMM-YYYY`. `TripName` se conserva a propósito:
  el test comprueba que no sale del mapper (RF-28).
- **Lo que el PDF no muestra y los tests construyen** a partir de estos fixtures: los estados de
  cancelación del enum (p. 70-71) en la lectura de BookingDetail de p. 49, el `479 CANCEL_FAIL`
  (p. 9, sin ejemplo), un `200` de Cancel que nombra otra reserva, filas fuera de la ventana, sin
  `BookingStatus` o con `BookingDetail` como objeto único.

## `postman/` — requests esperados

| Archivo                | Request de la colección | Qué es                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search.request.json`  | `Search`                | El `body` es el raw literal, reformateado (`ResponseTime` sigue escrito `20.0`). Postman no guarda respuestas. El archivo lleva además `url` y la lista `discrepancies`, una entrada por campo en que la colección contradice al PDF o a nuestras reglas, con la regla que aplica. |
| `prebook.request.json` | `PreBook`               | Mismo formato. `discrepancies` vacía: path `/PreBook` con el casing del PDF y `PaymentMode: "Limit"`. `prebook.request.builder.test.ts` fija que el builder serializa exactamente este `body` (RF-15 CA-1).                                                                        |

Las discrepancias de `search.request.json`, en resumen (02 §2.2): path `/search` en minúscula (C-35);
fechas ya pasadas; `GuestNationality` fija `"AE"` (KP-1); `ChildrenAges: [0]` con `Children: 0`
(C-04, Q-13); `ResponseTime` decimal (C-09); `IsDetailedResponse: true` en un listado (KP-2);
`Filters.MealType` entero (C-10); `OrderBy`, `StarRating` y `HotelName` no documentados (C-11); y
`Refundable: true`, que no es un defecto sino otro valor. `search.request.builder.test.ts` recorre la
lista: el builder difiere de Postman exactamente en esos campos y coincide en todos los demás.

## `envelope/` — clasificación por `Status.Code` (PR-1.2)

Una fila de [01](../../../../docs/tbo/01-autenticacion-conectividad-y-errores.md) §8.3-§8.4 por
archivo. Son **sintéticos**: el PDF no trae ningún ejemplo de error (00 §8.1). Cada uno declara su
fila en `row` y su origen en `source`; los cuerpos llevan sólo el envelope, porque es lo único que
se clasifica.
