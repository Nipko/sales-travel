---
titulo: TBO Hotels — procedencia de las fuentes
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — procedencia de las fuentes

Todos los documentos de `docs/tbo/` citan sus fuentes por referencia a este archivo. Las rutas, los hashes y los conteos se escriben **solo aquí**. Si otro documento da una cifra distinta de las de §6, el error está en ese otro documento.

## 1. Inventario de `docs/tbo/`

| Archivo                                                   | Bytes     | SHA-256 (primeros 16) | Qué es                                                                     | Evidencia             |
| --------------------------------------------------------- | --------- | --------------------- | -------------------------------------------------------------------------- | --------------------- |
| `TBOH_Hotel_API_Specifications(V2.1).pdf`                 | 2.107.436 | `bb406ac31c5def12`    | Especificación oficial "HOTEL API SPECIFICATION (Version 2.1)", 71 páginas | VERIFICADO-PDF (p. 1) |
| `HotelAPI_Client.postman_collection 7.json`               | 8.230     | `d5ec68fccf57d808`    | Colección `HotelAPI Client`, Postman schema v2.1.0, 10 requests            | VERIFICADO-POSTMAN    |
| `TBO_Holidays_Hotels_JSON_API_Certification_Process.docx` | 60.398    | `2aba55cc082a7e54`    | "Hotels API Certification Process (JSON)"                                  | VERIFICADO-CERT       |

- Los hashes se reproducen con `sha256sum docs/tbo/*`, o con `certutil -hashfile <archivo> SHA256` en Windows. Al 2026-09-23 los tres archivos están **sin versionar** (`?? docs/tbo/` en `git status`).
- El nombre de la colección lleva un espacio y el sufijo ` 7`, así que hay que entrecomillarlo en los scripts. Que el sufijo venga de una copia de descarga es INFERIDO.
- Metadatos del PDF: generado con Microsoft Word 2016 y exportado con `www.ilovepdf.com` el 2026-02-06. Metadatos del docx (`docProps/core.xml`): creado el 2021-12-15 y modificado por última vez el 2025-05-29. El docx trae 3 imágenes embebidas pequeñas (de 222 a 301 px de ancho) que son logos e iconos decorativos sin contenido. VERIFICADO-PDF / VERIFICADO-CERT.

## 2. El PDF de especificación

### 2.1 Tres numeraciones que no coinciden

| Numeración                               | Regla                                                                                                                                                              | Ejemplos                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Página física** (la única que citamos) | Del 1 al 71. Equivale a `img/pNN.png` y al marcador `===== PDF PAGE N =====`                                                                                       | —                                                                                                                                                                   |
| Pie impreso "`N \| Page`"                | Coincide con la física en las pp. 1–63. **Desde la p. 64 imprime la física menos 5**                                                                               | La p. 64 dice "59" y la p. 71 dice "66"                                                                                                                             |
| Índice (pp. 2–4)                         | Inservible: el desfase no es constante (−1 en §1, −2 en §2–§7, −3 en §8–§10, −5 en §11–§13, −6 en §14, vuelve a −2 en §15 y es −10 en §18) y hay números corruptos | Search "8" (física 10), HotelDetails "50" (56), hotelbookingdetailsbasedondate "60" (62), TBOHotelCodeList "505" (65), Enumeration "559" (69), Key points "61" (71) |

VERIFICADO-PDF (pp. 2–4 y 63–71). El índice tiene más defectos: repite "\_booking by limit" en 8.1.2 y 8.1.3 (p. 2) y pone un "14.2.1 sample response" dentro de §15 (p. 3). Lo de 8.1.3 viene del propio título del cuerpo (p. 36), y ese ejemplo manda `"PaymentMode": "NewCard"` con `PaymentInfo` (p. 38), no `Limit`. **Regla: se cita siempre "(p. N)" con N = página física. Nunca el pie ni el índice.**

### 2.2 Mapa de secciones (páginas físicas; la página de frontera figura en las dos secciones cuando la comparten)

| §   | Sección          | pp.   | §   | Sección                       | pp.   |
| --- | ---------------- | ----- | --- | ----------------------------- | ----- |
| 1   | Change Logs      | 5–6   | 10  | BookingDetail                 | 42–51 |
| 2   | Authentication   | 7     | 11  | CountryList                   | 51–53 |
| 3   | API Endpoint     | 7–8   | 12  | CityList                      | 53–54 |
| 4   | Timeout Settings | 8     | 13  | HotelCodeList                 | 54–55 |
| 5   | Response Status  | 8–10  | 14  | HotelDetails                  | 56–62 |
| 6   | Search           | 10–18 | 15  | HotelBookingDetailBasedOnDate | 62–64 |
| 7   | PreBook          | 18–32 | 16  | TBOHotelCodeList              | 65–69 |
| 8   | Book             | 32–41 | 17  | Enumeration                   | 69–71 |
| 9   | Cancel           | 41–42 | 18  | Key Points                    | 71    |

Las pp. 22 (dentro de §7) y 47 (dentro de §10) están en blanco: solo traen el pie. VERIFICADO-PDF (pp. 22 y 47).

### 2.3 Change log (pp. 5–6), transcripción de la vista

| Fecha          | Changed By    | API                                                 | Descripción                                                                                                                                          | Versión |
| -------------- | ------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 15th July 2021 | -             | –                                                   | Specifications of Hotel API (JSON-Based)                                                                                                             | 1.0     |
| 2nd Sep 2021   | Shubham Gupta | Search, Prebook & Bookingdetail                     | Add identifier to bifurcate policies at room level                                                                                                   | 1.1     |
| 5th Apr 2022   | Divya Tyagi   | CountryList, citylist, hotelcode & hoteldetails     | These methods are used to download hotel Static details through API                                                                                  | 1.2     |
| 6th May 2022   | Divya Tyagi   | Search,Prebook                                      | Added response parameter (WithTransfers) in search & prebook response                                                                                | 1.3     |
| 28th Jun 2022  | Divya Tyagi   | Book,Bookingdetails                                 | Added request parameter "BookingReferenceId" in Booking request which can be further used in Booking details method to retrieve the booking details. | 1.4     |
| 17th Feb 2023  | Divya Tyagi   | PreBook                                             | Added response parameter "Amenities" in Prebook Response                                                                                             | 1.5     |
| 15th Mar 2023  | Divya Tyagi   | TBOHotelCodeList, Search,Pre-book                   | This method is used to download hotelcodes associated with a City. Added response parameter "ExtraGuestCharges" in Search and Pre-book Response.     | 1.6     |
| 16th Aug 2023  | Divya Tyagi   | API Workflow                                        | Implemented Hotel Search Workflow.                                                                                                                   | 2.0     |
| 27th Dec 2023  | Divya Tyagi   | (a) Bookingdetails based on Date · (b) API Workflow | (a) This method is used to retrieve the booking details made by the agency in the specified date. · (b) **Depreciated Hotel Search Workflow**        | 2.1     |
| 27th Oct 2025  | Naveen Yadav  | Hotel Detail method                                 | To get the room wise details.                                                                                                                        | 2.1     |

VERIFICADO-PDF (pp. 5–6; debajo de la última fila hay una fila vacía).

- **Corrección:** "Depreciated Hotel Search Workflow" pertenece a la fila del **27-dic-2023**, como segundo apartado con API "API Workflow". La fila del 27-oct-2025 dice solo "Hotel Detail method / To get the room wise details." La extracción `pdftotext -layout` coloca la frase junto a la fila de 2025, pero la vista de la p. 6 no deja dudas: donde el texto y la vista difieren, manda la vista. VERIFICADO-PDF (p. 6).
- El cambio de 2025 **no subió la versión**: hay dos filas "2.1". Que ese cambio corresponda a `IsRoomDetailRequired` y `RoomID` (pp. 56–57) es INFERIDO; ver [05](./05-contenido-estatico-e-inventario.md).
- "Depreciated" es una errata de "Deprecated". El "Hotel Search Workflow" **no se describe en ninguna parte del PDF**: "Workflow" solo aparece en el change log. VERIFICADO-PDF, por ausencia.

## 3. Colección Postman

Configuración de la colección (VERIFICADO-POSTMAN):

- `auth` de tipo `basic` a nivel de colección, con `username` y `password` en `""`.
- `BookingDetailsBasedOnDate` y `Cancel` repiten su propio bloque `basic`, también vacío.
- Los scripts `prerequest` y `test` están vacíos y no hay `variable`.
- Las 10 requests tienen `"header": []` y `"response": []`. Las 9 `POST` llevan un body `raw` con `language: json`; `CountryList` (`GET`) no tiene body.

| #   | Request (nombre exacto)     | Método | URL exacta                                                                      |
| --- | --------------------------- | ------ | ------------------------------------------------------------------------------- |
| 1   | `Search`                    | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/search`                       |
| 2   | `PreBook`                   | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/PreBook`                      |
| 3   | `HotelBook`                 | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/Book`                         |
| 4   | `BookingDetail`             | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/BookingDetail`                |
| 5   | `BookingDetailsBasedOnDate` | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/BookingDetailsBasedOnDate`    |
| 6   | `Cancel`                    | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/Cancel`                       |
| 7   | `CountryList`               | GET    | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList`                  |
| 8   | `CityList`                  | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList`                     |
| 9   | `TBOHotelCodeList`          | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList`             |
| 10  | `Hotel Details`             | POST   | `http://api.tbotechnology.in/TBOHolidays_HotelAPI/Hoteldetails`                 |
| —   | _(no existe en Postman)_    | GET    | `BaseURL/hotelcodelist`: método `HotelCodeList`, **solo en el PDF** (pp. 54–55) |

- Tres paths difieren en mayúsculas y minúsculas del PDF: `search` frente a `BaseURL/Search` (p. 10), `Hoteldetails` frente a `BaseURL/HotelDetails` (p. 56) y `BookingDetailsBasedOnDate` frente a `BaseURL/BookingDetailsbasedondate` (p. 62). La postura de diseño está en [01](./01-autenticacion-conectividad-y-errores.md).
- Los bodies son ejemplos sueltos y **no forman un flujo encadenado**: `PreBook` usa el hotel `1160804` y `HotelBook` el `1345320`; el `ConfirmationNumber` de `BookingDetail` (`KOI5G4`) no es el de `Cancel` (`ANPWCS`). El único enlace es el `BookingReferenceId` **comentado** de `BookingDetail`, igual al de `HotelBook`. Las fechas de `Search` (`2025-11-20` → `2025-11-24`) ya pasaron. El body de `BookingDetail` trae un comentario `//`, que no es JSON válido. VERIFICADO-POSTMAN. Que reenviar esas fechas tal cual falle es INFERIDO: no hay respuesta guardada que lo muestre.
- `HotelBook` trae el `EmailId` de una persona con dominio `tbo.com` (el `PhoneNumber` `919999999999` es de relleno) y un `Title` `"Dr"` que el contrato no contempla (p. 32, ver [03](./03-prebook-y-book.md)). Los mismos `EmailId` y `PhoneNumber` aparecen en los ejemplos 8.1.2 y 8.1.3 del PDF (pp. 36 y 38). **Nunca se copian estos valores a fixtures.**

## 4. Documento de certificación

Secciones del docx, en orden:

1. "Client's Details": formulario de empresa, contacto técnico, plataforma, "Test Application URL" y "Application Credentials".
2. "TBO Hotel API Details": endpoint de integración `http://api.tbotechnology.in/TBOHolidays_HotelAPI`, el mismo Test BaseURL de la p. 7.
3. "Integration on Test Account": documento de workflow y los 8 casos. El caso 8 pide llamar al "HotelBookingDetail method" tras reservar; ese nombre no existe en el PDF. Que se refiera a `BookingDetail` (§10) y no a `HotelBookingDetailBasedOnDate` (§15) es INFERIDO del flujo que el docx escribe a continuación: "Search > Prebook > Book> BookingDetails>Cancel(If Required)". → [Q-75](./10-preguntas-para-tbo.md#q-75).
4. "Certification Process (JSON Verification)": dura como mínimo 3 días.
5. "Certification Process (Website/Portal Verification)": dura como mínimo "1 weeks".
6. "Sign Off / API Live Credentials!" (con el "!" en el título): las credenciales live se entregan mediante un "Production Process Form" de Microsoft Forms, enlazado en el docx.

VERIFICADO-CERT. Se cita como "(Cert, <sección>)" y no por número de línea de `cert.txt`, porque ese derivado no está versionado (§5). El detalle está en [07](./07-certificacion.md).

## 5. Cómo se extrajo

| Derivado (en el scratchpad de la sesión)        | Cómo se generó                                                                                                                                                                                                                                                                        | Uso                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `spec-paged.txt` (109.595 bytes)                | `pdftotext -layout` (Xpdf 4.00) página por página, con marcadores `===== PDF PAGE N =====`. Coincide con la salida de pdftotext en las 71 páginas, salvo la codificación de caracteres no ASCII. Termina con un marcador `PAGE 72` vacío que es un artefacto: el PDF tiene 71 páginas | grep y copia literal de JSON (con la salvedad de abajo)              |
| `img/p01.png` … `img/p71.png` (7.531.054 bytes) | PyMuPDF 1.27.1 a 110 dpi (935×1210 px). Se usó porque `Read` no puede rasterizar el PDF: en la máquina falta `pdftoppm`                                                                                                                                                               | Lectura visual de tablas, que es la fuente de verdad frente al texto |
| `cert.txt`                                      | Texto de `word/document.xml` del docx                                                                                                                                                                                                                                                 | Lectura del proceso de certificación                                 |

`pdftotext -layout` desordena las celdas de tabla que ocupan varias líneas; los casos comprobados son el change log de la p. 5 (pone "Search, Prebook & Bookingdetail" en la fila 1.0 y mezcla las filas 1.5 y 1.6) y el de la p. 6. Por eso, todo dato tomado de una tabla se confirma contra la PNG antes de marcarse VERIFICADO-PDF.

`pdftotext` además convierte las comillas tipográficas (“ ”) del PDF en `"` ASCII. Parsear JSON copiado de `spec-paged.txt` **oculta** los ejemplos rotos por comillas tipográficas (pp. 12, 34–35 y 50–51) e **inventa** un error en la p. 30, donde “Tourism Dirham” va dentro de un string y en el PDF es válido. La validez de un ejemplo se decide contra la PNG.

## 6. Cifras canónicas

| Cifra                                          | Valor                                                                                                                                                                                                                                                                                                        | Fuente                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Páginas del PDF / secciones                    | **71** / **18**                                                                                                                                                                                                                                                                                              | VERIFICADO-PDF (§2.2)                          |
| Métodos documentados                           | **11** (§6–§16)                                                                                                                                                                                                                                                                                              | VERIFICADO-PDF                                 |
| … en la tabla de endpoints                     | **5**: `Search`, `PreBook`, `HotelBook` → `/Book`, `BookingDetail`, `Cancel`                                                                                                                                                                                                                                 | VERIFICADO-PDF (pp. 7–8)                       |
| … en Postman / solo en el PDF                  | **10** / **1** (`hotelcodelist`)                                                                                                                                                                                                                                                                             | VERIFICADO-POSTMAN; VERIFICADO-PDF (pp. 54–55) |
| Verbos HTTP                                    | 9 `POST` y **2 `GET`** (`CountryList`, p. 51; `hotelcodelist`, p. 55), aunque la ficha de autenticación dice `POST` para todo (p. 7)                                                                                                                                                                         | VERIFICADO-PDF                                 |
| Códigos `Status.Code` en el body               | **12**: `200` (p. 8); `201`, `207`, `405`, `479`, `401`, `400`, `500`, `429`, `315`, `300` (p. 9); `402` (p. 10)                                                                                                                                                                                             | VERIFICADO-PDF (pp. 8–10)                      |
| Ejemplos de respuesta                          | **14**: 12 con `Code` 200, 1 con 201 (p. 18) y 1 sin objeto `Status` (`hotelcodelist`, p. 55). **Ninguno de error**                                                                                                                                                                                          | VERIFICADO-PDF                                 |
| Timeouts recomendados                          | **3** (Search 5–23 s, PreBook 23 s, Book 120 s), más 30 min de Search a Book                                                                                                                                                                                                                                 | VERIFICADO-PDF (p. 8)                          |
| Enumeraciones (§17)                            | **7 tipos, 31 valores**: `PaxType` 2, `MealPlan` 3, `StarRating` 6, `PaymentMode` 3, `Booking Type` 1, `MealType` 10, `Booking Status` 6                                                                                                                                                                     | VERIFICADO-PDF (pp. 69–71)                     |
| Key Points                                     | **4**, citados en el set como KP-1 a KP-4 en el orden de la p. 71: **KP-1** no fijar `GuestNationality` en código; **KP-2** `IsDetailedResponse` en `False`; **KP-3** políticas de cancelación y normas de PreBook como finales; **KP-4** mostrar los suplementos `AtProperty` antes o en el paso de reserva | VERIFICADO-PDF (p. 71)                         |
| Casos de certificación                         | **8**: 6 de ocupación, 1 con suplementos y 1 del "HotelBookingDetail method" tras reservar (que sea `BookingDetail` es INFERIDO, §4)                                                                                                                                                                         | VERIFICADO-CERT                                |
| Filas del change log                           | **10**, de la 1.0 a la 2.1, con la 2.1 dos veces                                                                                                                                                                                                                                                             | VERIFICADO-PDF (pp. 5–6)                       |
| Respuestas guardadas / credenciales en Postman | **0** / **0**                                                                                                                                                                                                                                                                                                | VERIFICADO-POSTMAN                             |

## 7. Contactos de soporte

| Dirección                    | Dónde aparece                                    | Para qué                                                     |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `apisupport@tboholidays.com` | PDF p. 9, en las Remarks de `UNEXPECTED_ERROR`   | Enviar los logs JSON completos (RQ y RS) de un 500           |
| `apisupport@tbo.com`         | Cert, "Integration on Test Account" y nota final | Enviar el zip de casos de certificación y cualquier consulta |

Las fuentes se contradicen, y la fecha no sirve para elegir: el contenido del PDF llega hasta octubre de 2025 y el docx se modificó por última vez en mayo de 2025. **Postura:**

- Todo lo de certificación va a `apisupport@tbo.com`, porque así lo manda el documento que rige ese proceso.
- Los incidentes `UNEXPECTED_ERROR` van a las dos direcciones hasta que TBO confirme cuál es la vigente.
- La dirección vive en la configuración del runbook, nunca en el código.

Que `tbo.com` sea el dominio vigente solo se apoya en el `EmailId` de `HotelBook` y de los ejemplos 8.1.2 y 8.1.3 del PDF (pp. 36 y 38): es INFERIDO y débil, porque los ejemplos 8.1.1 y 8.1.4 del mismo PDF usan `apisupport@tboholidays.com` como `EmailId` (pp. 35 y 40). → [Q-11](./10-preguntas-para-tbo.md#q-11).

## 8. Advertencias

1. **No hay respuestas de error reales.** El PDF no trae ningún ejemplo con un código distinto de 200 o 201 (§6), y la colección no tiene respuestas guardadas. Tampoco hay evidencia de si el HTTP de transporte coincide con `Status.Code`. Los esquemas Zod de error y el clasificador de [01](./01-autenticacion-conectividad-y-errores.md) son defensivos por diseño. → [Q-07](./10-preguntas-para-tbo.md#q-07).
2. **La colección no trae credenciales.** El `basic` está vacío en la colección y en los dos overrides. La captura de la p. 7 muestra el usuario `TBOAPI` con la contraseña enmascarada: es ilustrativa, no una credencial. Las credenciales de test se piden a TBO y viven en la bóveda ([06](./06-seams-integracion-repo.md)), nunca en Git.
3. **`EXTERNAL_AGENCY.postman_collection.json` (raíz del repo) NO es de TBO.** Datos del archivo:

   - 3.990.466 bytes, SHA-256 `7c344508fe24cee7`, sin versionar.
   - `info.name` = `EXTERNAL AGENCY`, con 160 requests a `sandbox.api.latam.com` (`/ndc/v192`, `/oauth/cc`): es la colección de **LATAM NDC**.
   - No contiene `tboholidays` ni `tbotechnology`. Las 81 apariciones de "tbo" (sin distinguir mayúsculas; en minúsculas estrictas hay 0) son subcadenas de `outbound` y `postbook(ing)`.

   VERIFICADO-POSTMAN. [`docs/sabre/00-fuentes.md`](../sabre/00-fuentes.md) §1 ya lo advierte.

4. **Hay ejemplos del PDF que no son JSON válido.** Casos:

   - Search 6.1.1 y 6.1.2, p. 12: comillas tipográficas en `MealType` y a cada uno le falta la `}` final (ver [02](./02-search-y-oferta-canonica.md)).
   - Book 8.1.1, pp. 34–35: comillas tipográficas como delimitadores en `Type`, `BookingType` y `PaymentMode` (ver [03](./03-prebook-y-book.md)).
   - Book 8.1.4, p. 40: falta la coma tras `"BookingType": "Voucher"` (ver [03](./03-prebook-y-book.md)).
   - BookingDetail 10.2.1, pp. 50–51: comillas tipográficas en `Type`.
   - `CountryList` y `CityList`, pp. 52–54: vienen truncados.
   - `hotelcodelist`, p. 55: la lista se abrevia con puntos (ver [05](./05-contenido-estatico-e-inventario.md)).
   - HotelDetails 14.2.1, p. 62: coma sobrante tras la última URL de imagen (ver [05](./05-contenido-estatico-e-inventario.md)).
   - TBOHotelCodeList 16.2.1, pp. 67–69: el string de `Attractions` se rompe en la p. 67 (líneas sueltas con `/` y fragmentos fuera de comillas) y el ejemplo acaba en `},` sin cerrar en la p. 69 (ver [05](./05-contenido-estatico-e-inventario.md)).

   VERIFICADO-PDF (PNG de cada página; ver §5 sobre las comillas). Los demás ejemplos parsean.

   Ningún ejemplo del PDF entra en los fixtures sin corregirse y sin una marca de su origen.

## 9. Convención de citas y etiquetas

| Etiqueta               | Significa                                                                                                                   | Formato de cita                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **VERIFICADO-PDF**     | Se vio en la PNG de la página (o, para texto corrido, en `spec-paged.txt`). "Por ausencia" significa que se buscó y no está | "(p. N)", N = página física                         |
| **VERIFICADO-POSTMAN** | Sale de un body, URL o auth de la colección                                                                                 | "(Postman: `<request>`)" con el nombre exacto de §3 |
| **VERIFICADO-CERT**    | Sale del docx de certificación                                                                                              | "(Cert, <sección>)"                                 |
| **VERIFICADO-CODIGO**  | Sale del código del repo                                                                                                    | "`ruta/archivo.ts:línea`"                           |
| **INFERIDO**           | Deducción nuestra. Nunca se presenta como contrato                                                                          | Explicar de qué evidencia se deduce                 |

## 10. Contradicciones y huecos de procedencia

| ID   | Hueco                                                                                                                     | Postura de diseño                                                                                                                                  | TBO                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| F-01 | El "Hotel Search Workflow" (v2.0) se deprecó en la v2.1 sin documentarse (p. 6)                                           | Solo se implementa `Search` por `HotelCodes` (p. 10). No se depende de ningún flujo alternativo                                                    | → [Q-02](./10-preguntas-para-tbo.md#q-02)                              |
| F-02 | La versión "2.1" cubre cambios de 2023 y de 2025 (p. 6): el número no identifica el contenido                             | Se fija la fuente por SHA-256 (§1), no por versión. Un PDF nuevo exige nuevo hash, diff y revisión de las citas                                    | → [Q-01](./10-preguntas-para-tbo.md#q-01) (canal de avisos de cambios) |
| F-03 | Soporte: `apisupport@tboholidays.com` frente a `apisupport@tbo.com` (§7)                                                  | Postura de §7                                                                                                                                      | → [Q-11](./10-preguntas-para-tbo.md#q-11)                              |
| F-04 | El PDF y la colección no traen respuestas de error ni respuestas guardadas (§8.1)                                         | Zod permisivo en los campos de error, clasificación por `Status.Code` del body y RQ/RS crudos guardados para soporte                               | → [Q-07](./10-preguntas-para-tbo.md#q-07) (muestras reales)            |
| F-05 | `hotelcodelist` no tiene ejemplo ejecutable, su respuesta de ejemplo no trae `Status` y no aparece en Postman (pp. 54–55) | Es opcional en la sincronización de catálogo; la ruta principal es `CityList` + `TBOHotelCodeList` ([05](./05-contenido-estatico-e-inventario.md)) | → [Q-61](./10-preguntas-para-tbo.md#q-61)                              |
| F-06 | La certificación habla de un "Staging environment" sin URL (Cert, Portal Verification)                                    | Se asume el mismo endpoint de integración (INFERIDO) y se confirma antes de abrir el portal ([07](./07-certificacion.md))                          | → [Q-76](./10-preguntas-para-tbo.md#q-76)                              |
| F-07 | Los derivados de §5 viven en el scratchpad de la sesión y no están versionados                                            | Toda cita apunta al original (página física o nombre de request), nunca a una línea del derivado                                                   | Decisión del founder                                                   |
