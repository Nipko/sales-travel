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

## `postman/` — requests esperados

| Archivo               | Request de la colección | Qué es                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search.request.json` | `Search`                | El `body` es el raw literal, reformateado (`ResponseTime` sigue escrito `20.0`). Postman no guarda respuestas. El archivo lleva además `url` y la lista `discrepancies`, una entrada por campo en que la colección contradice al PDF o a nuestras reglas, con la regla que aplica. |

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
