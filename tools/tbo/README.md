# tools/tbo

Arnés de certificación de TBO Hotels ([`docs/tbo/07-certificacion.md`](../../docs/tbo/07-certificacion.md) §6).
No forma parte del runtime: habla con el **entorno de test** de TBO para validar la cuenta y contestar con
evidencia las preguntas que el PDF deja abiertas.

| Comando                                           | Qué hace                                                                                           | ¿Reserva? | PR     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------- | ------ |
| `check`                                           | Un Search del caso 1: `Status.Code`, la moneda del perfil de test, la latencia y cuántas opciones. | No        | PR-1.6 |
| `probe`                                           | Las sondas de contrato sin reserva (PR-01 a PR-08 de 07 §6.8).                                     | No        | PR-1.6 |
| `run`, `verify`, `zip`, `all`, `probe --bookings` | Los 8 casos, las guardas del zip y las sondas que reservan.                                        | Sí (test) | PR-7.1 |

A diferencia de `tools/sabre/cert-probe.mjs`, **los requests no los arma el script**: los arma el ACL de
producción (`providers/tbo-hotels/dist`), y el arnés sólo le inyecta un `fetch` que graba los bytes y un logger
que no imprime (07 §6.1). Lo que TBO ve es lo que mandaría la aplicación.

## Antes de correrlo

1. Compila el ACL. El arnés importa `providers/tbo-hotels/dist/index.js` y, si no está, se detiene con este mismo
   comando:

   ```bash
   pnpm --filter @sales-travel/tbo-hotels build
   # en un clon limpio, con sus dependencias: pnpm turbo run build --filter=@sales-travel/tbo-hotels
   ```

2. Credenciales de **test** (las pide [Q-92](../../docs/tbo/10-preguntas-para-tbo.md#q-92)):

   ```bash
   cp .env.tbo.example .env.tbo
   # rellena TBO_USERNAME y TBO_PASSWORD
   ```

   `.env.tbo` y `.tbo-cert/` están en `.gitignore`. Las variables exportadas en la sesión mandan sobre el archivo.
   Si la contraseña empieza o termina con espacio, ponla entre comillas: dentro de comillas el valor se toma tal
   cual (TBO no la recorta, docs/tbo/01 §1.2).

| Variable                                | Uso en `check` y `probe`                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `TBO_USERNAME`, `TBO_PASSWORD`          | Obligatorias.                                                                       |
| `TBO_BASE_URL`                          | Por defecto el endpoint de test. Otro host sólo con `--allow-non-test-host` (G-12). |
| `TBO_HOTEL_CODES`                       | Por defecto los 13 de la colección Postman. Con 101 o más, PR-08 los usa.           |
| `TBO_CITY_CODE`                         | Opcional: PR-08 toma de esa ciudad los 101 códigos (`TBOHotelCodeList`).            |
| `TBO_CHECKIN_OFFSET_DAYS`, `TBO_NIGHTS` | CheckIn = hoy (UTC) + offset; 45 y 2 por defecto.                                   |

`TBO_CERT_EMAIL`, `TBO_CERT_PHONE`, `TBO_COMPANY_SLUG` y `TBO_CANCEL_AFTER` son de los casos con reserva (PR-7.1).

## check

```bash
node tools/tbo/cert-cases.mjs check
```

Salida de ejemplo (valores ilustrativos):

```text
TBO check · http://api.tbotechnology.in/TBOHolidays_HotelAPI · CheckIn 2026-11-10 · 2 noches · 13 HotelCodes · caso 1 (1 adulto, CO)
  HTTP 200 · Status.Code 200 (Successful) · 1840 ms
  Moneda del perfil (HotelResult[].Currency): USD
  Opciones: 57 en 9 hoteles
  Lectura del ACL: ok · 57 packs válidos
```

- Sale con **0** si TBO respondió `200` o `201` (las credenciales valen; con `201` no hay disponibilidad y la
  moneda no se ve: cambia `TBO_CHECKIN_OFFSET_DAYS` o `TBO_HOTEL_CODES`), y con **1** en cualquier otro caso.
- La moneda contesta [Q-82](../../docs/tbo/10-preguntas-para-tbo.md#q-82). Si el ACL no puede leer un `200`, o lo
  lee pero descarta opciones u hoteles (el motivo sale con su nombre, p. ej. `PACK_SCHEMA×3`), el arnés imprime
  **HALLAZGO**: el RS quedó en disco y hay que revisarlo contra el esquema del ACL antes de certificar.

## probe

```bash
node tools/tbo/cert-cases.mjs probe                       # todas
node tools/tbo/cert-cases.mjs probe --only PR-01,PR-03    # algunas
node tools/tbo/cert-cases.mjs probe --skip-hotelcodelist  # PR-04 sin descargar la lista completa
```

Antes de las sondas corre un Search del caso 1 como **control**: si no da `200` o `201`, no corre ninguna (cada
una contestaría "401" o "sin red") y sale con 1.

| Sonda | Pregunta                                             | Qué manda                                                                                                                                          |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01 | [Q-13](../../docs/tbo/10-preguntas-para-tbo.md#q-13) | El Search del caso 1 tres veces, con `ChildrenAges` `[]`, `[0]` y omitido (opción `emptyChildrenAges` del ACL).                                    |
| PR-02 | [Q-18](../../docs/tbo/10-preguntas-para-tbo.md#q-18) | `Filters.MealType` `"All"` (el ACL) y `0` (reescrito).                                                                                             |
| PR-03 | [Q-03](../../docs/tbo/10-preguntas-para-tbo.md#q-03) | El mismo Search por `http://` y por `https://`.                                                                                                    |
| PR-04 | [Q-05](../../docs/tbo/10-preguntas-para-tbo.md#q-05) | Las dos grafías de `Search`, `HotelDetails`, `BookingDetailsbasedondate` y `hotelcodelist` (la del PDF, que es la del ACL, y la de Postman).       |
| PR-05 | [Q-37](../../docs/tbo/10-preguntas-para-tbo.md#q-37) | BookingDetail con un `BookingReferenceId` recién generado, que no existe.                                                                          |
| PR-06 | [Q-07](../../docs/tbo/10-preguntas-para-tbo.md#q-07) | El Search del caso 1 con un usuario y una contraseña inventados.                                                                                   |
| PR-07 | [Q-08](../../docs/tbo/10-preguntas-para-tbo.md#q-08) | PreBook (`PaymentMode: "Limit"`) con un `BookingCode` inventado.                                                                                   |
| PR-08 | [Q-15](../../docs/tbo/10-preguntas-para-tbo.md#q-15) | Un Search con 100 códigos (control) y el mismo con 101 (reescrito). Los 101 salen de `TBO_HOTEL_CODES`, de `TBO_CITY_CODE` o de la lista de PR-04. |

Notas:

- **Reescrituras.** Cuando la pregunta es sobre algo que el ACL no manda (el ordinal de `MealType`, 101 códigos, el
  casing de Postman), la sonda cambia **sólo ese campo o ese path** del RQ que armó el ACL. La mutación queda
  declarada en `calls.jsonl` (`mutation`, `aclUrl`) y el RQ original se guarda al lado como `*_RQ.acl.json`.
- **PR-04 y `BookingDetailsbasedondate`.** El ACL todavía no publica un builder de ese método (llega con la
  conciliación): el body es el de docs/tbo/04 §5 (`FromDate`/`ToDate`, últimos 7 días) y sale por el cliente HTTP
  del ACL, con su autenticación y su lectura del envelope.
- **PR-04 y `hotelcodelist`.** Descarga todos los códigos de TBO dos veces (180 s de timeout por intento y hasta
  3 intentos cada una, los de `TBO_OPERATIONS`). Con
  `--skip-hotelcodelist` esa pareja no se prueba y PR-08 necesita `TBO_HOTEL_CODES` o `TBO_CITY_CODE`.
- **PR-06** usa un usuario inventado, no una variación del real: los intentos fallidos no pueden bloquear la cuenta.
- **Cerrar una pregunta.** `probes/summary.md` trae, por sonda, la tabla de variantes y una **lectura**. Lo que se
  versiona es la respuesta transcrita a [`docs/tbo/10-preguntas-para-tbo.md`](../../docs/tbo/10-preguntas-para-tbo.md)
  (fecha, corrida y lo observado), nunca la captura cruda (07 §6.9). Con `201` en todas las variantes la lectura lo
  advierte: TBO pudo no llegar a validar la forma.

## Qué produce

```text
.tbo-cert/2026-10-15T14-03-22Z/
├── run.json              parámetros, git SHA, versión y fecha del dist del ACL, baseUrl, Node. Sin credenciales
├── check/                (check) NN_<Operación>_<etiqueta>_RQ.json / _RS.json, calls.jsonl, acl-events.jsonl, check.json
└── probes/               (probe) 00-control/, PR-01/ … PR-08/ con los mismos archivos, summary.json y summary.md
```

- `_RQ.json` son los bytes que salieron y `_RS.json` los que llegaron, sin re-serializar (07 §5). Un RS que no es
  JSON se guarda como `_RS.txt`.
- `calls.jsonl`: una línea por llamada — método, URL, HTTP, `Status.Code`, `Description`, latencia, hora de
  inicio, cabeceras con `Authorization: Basic «REDACTADO»`, y el código del error si no hubo respuesta.
- `acl-events.jsonl`: lo que el ACL loguea (ya filtrado por su lista blanca), para diagnosticar una lectura rara.

## Secretos y guardas

- El usuario, la contraseña y el token Basic **nunca** se imprimen ni se guardan. Todo lo que va a disco o a la
  consola pasa por una redacción que los busca en claro, escapados en JSON y en base64; si un RS los repite, esa
  captura se guarda tapada y `calls.jsonl` lo marca en `redactedSecrets`. Al terminar se barre la corrida entera
  (G-1): si algo aparece, sale con 1 y pide borrar la carpeta.
- **D1 sobre lo que sale**: ninguna clave de tarjeta, `PaymentMode` sólo `"Limit"` y, en PreBook, Book y
  BookingDetail, presente (G-2, G-3), también después de una reescritura. Un request que no cumple no sale, no se
  escribe y corta la corrida.
- **Host**: sólo el de `TBO_BASE_URL`. Una reescritura no puede mandar el `Authorization` a otro servidor.
- **G-12**: contra un host que no es el de test, el arnés se niega salvo con `--allow-non-test-host`.

## Códigos de salida

`0` bien · `1` el check o el control no pasó, o saltó una guarda del arnés · `2` error de uso o de configuración
(faltan credenciales, host que no es de test, ACL sin compilar).

## Tests

Contra un TBO falso con forma de `fetch` (`test/fake-tbo.mjs`), sin red ni credenciales, y con el ACL real
compilado:

```bash
pnpm --filter @sales-travel/tbo-hotels build
node --test tools/tbo/test/*.test.mjs
```

Todavía no hay `package.json` en `tools/tbo`, así que turbo no los corre: lo suma PR-7.1 junto con las guardas del
zip (docs/tbo/09 PR-7.1).
