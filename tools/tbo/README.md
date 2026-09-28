# tools/tbo

Arnés de certificación de TBO Hotels ([`docs/tbo/07-certificacion.md`](../../docs/tbo/07-certificacion.md) §6).
No forma parte del runtime: habla con el **entorno de test** de TBO para validar la cuenta, contestar con evidencia
las preguntas que el PDF deja abiertas y producir el zip de los 8 casos que pide la certificación.

| Comando            | Qué hace                                                                                                | ¿Red? | ¿Reserva? | PR     |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----- | --------- | ------ |
| `check`            | Un Search del caso 1: `Status.Code`, la moneda del perfil de test, la latencia y cuántas opciones.      | Sí    | No        | PR-1.6 |
| `probe`            | Las sondas de contrato sin reserva (PR-01 a PR-08 de 07 §6.8).                                          | Sí    | No        | PR-1.6 |
| `probe --bookings` | Además PR-09, PR-10 y PR-11, que reservan y **siempre** cancelan.                                       | Sí    | Sí (test) | PR-7.1 |
| `run`              | Los 8 casos: Search > PreBook > Book > BookingDetail > Cancel. Graba cada cadena y sus intentos.        | Sí    | Sí (test) | PR-7.1 |
| `verify <runId>`   | Las guardas G-1 a G-13 sobre una corrida y `selfcheck.md`.                                              | No    | No        | PR-7.1 |
| `zip <runId>`      | Las guardas otra vez, `README.txt`, `manifest.json` y el zip para TBO. No hay zip si una guarda aborta. | No    | No        | PR-7.1 |
| `all`              | `check` → `run` → `verify` → `zip` en una sola corrida.                                                 | Sí    | Sí (test) | PR-7.1 |
| `cancel <runId>`   | Cancela lo que una corrida dejó activo (`TBO_CANCEL_AFTER=false` o un Cancel que no se confirmó).       | Sí    | No        | PR-7.1 |

A diferencia de `tools/sabre/cert-probe.mjs`, **los requests no los arma el script**: los arma el ACL de
producción (`providers/tbo-hotels/dist`), y el arnés sólo le inyecta un `fetch` que graba los bytes y un logger
que no imprime (07 §6.1; RC-02). Lo que TBO ve es lo que mandaría la aplicación.

## Antes de correrlo

1. Compila el ACL. El arnés importa `providers/tbo-hotels/dist/index.js` y, si no está, se detiene con este mismo
   comando:

   ```bash
   pnpm --filter @sales-travel/tbo-hotels build
   # en un clon limpio, con sus dependencias: pnpm turbo run build --filter=@sales-travel/tbo-hotels
   ```

2. Crea `.env.tbo` con las credenciales de **test** (las pide [Q-92](../../docs/tbo/10-preguntas-para-tbo.md#q-92)):

   ```bash
   cp .env.tbo.example .env.tbo
   ```

   `.env.tbo` y `.tbo-cert/` están en `.gitignore`. Las variables exportadas en la sesión mandan sobre el archivo.
   Si la contraseña empieza o termina con espacio, ponla entre comillas: dentro de comillas el valor se toma tal
   cual (TBO no la recorta, docs/tbo/01 §1.2).

3. Trabaja desde un commit limpio: `run.json` guarda el SHA de git y `verify` avisa si el árbol tenía cambios sin
   commitear, porque entonces el SHA no identifica el build que TBO certifica (RC-01).

| Variable                                | Para qué                                                                                                   | Comandos                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `TBO_USERNAME`, `TBO_PASSWORD`          | Obligatorias. `verify` y `zip` también las piden: G-1 las busca en cada archivo de la corrida.             | todos                            |
| `TBO_BASE_URL`                          | Por defecto el endpoint de test. Otro host sólo con `--allow-non-test-host` (G-12).                        | todos los que usan red           |
| `TBO_HOTEL_CODES`                       | Por defecto los 13 de la colección Postman. Con 101 o más, PR-08 los usa; `run` los parte en lotes de 100. | `check`, `probe`, `run`          |
| `TBO_CITY_CODE`                         | Sin `TBO_HOTEL_CODES`, `run` toma los hoteles de esa ciudad (`TBOHotelCodeList`); PR-08 también.           | `probe`, `run`                   |
| `TBO_CHECKIN_OFFSET_DAYS`, `TBO_NIGHTS` | CheckIn = hoy (UTC) + offset; 45 y 2 por defecto.                                                          | todos los que usan red           |
| `TBO_CERT_EMAIL`                        | `EmailId` del Book: un **buzón de rol** propio, nunca personal ni el de la colección.                      | `run`, `all`, `probe --bookings` |
| `TBO_CERT_PHONE`                        | `PhoneNumber` del Book: ficticio, sólo dígitos con prefijo de país y sin `+` (p. ej. `573000000000`).      | `run`, `all`, `probe --bookings` |
| `TBO_CANCEL_AFTER`                      | `true` (por defecto) cancela cada reserva al final de su cadena; `false` las deja activas.                 | `run`, `all`                     |
| `TBO_COMPANY_SLUG`                      | `<Empresa>` del nombre del zip: letras, dígitos y guiones (DC-4).                                          | `zip`, `all`                     |

`all` valida TODO lo que va a necesitar (también `TBO_COMPANY_SLUG`) **antes** de reservar nada.

## Paso a paso: de las credenciales al zip

El orden importa: las sondas corren antes de la primera corrida de casos (RC-04), porque lo que contestan puede
cambiar una línea del ACL (por ejemplo, la forma de `ChildrenAges` sin niños, PR-01) y el zip tiene que salir
con el ACL definitivo.

1. **`check`** — valida las credenciales y muestra la moneda del perfil (Q-82). Sin reservar.

   ```bash
   node tools/tbo/cert-cases.mjs check
   ```

2. **`probe`** — PR-01 a PR-08, sin reservar. Transcribe cada lectura de `probes/summary.md` a
   [`docs/tbo/10`](../../docs/tbo/10-preguntas-para-tbo.md). Si alguna obliga a cambiar el ACL, cámbialo,
   recompila y vuelve a `check` antes de seguir.

3. **`probe --bookings`** — PR-09 (Q-43), PR-10 (Q-33) y PR-11 (Q-35). Reserva hasta 4 veces en test y cancela
   todo al terminar; si una cancelación no se confirma, la lectura lo dice con el `ConfirmationNumber`.

4. **`all`** — `check`, los 8 casos, las guardas y el zip, en una corrida:

   ```bash
   node tools/tbo/cert-cases.mjs all
   ```

   Si prefieres por partes: `run`, luego `verify <runId>` y `zip <runId>`, con el `<runId>` que imprime `run`
   (la carpeta de `.tbo-cert/`).

5. **Revisa `selfcheck.md`** en la carpeta de la corrida: las 13 guardas, los checkpoints que se ven en el JSON
   (07 §3), los casos con su `ConfirmationNumber` y los intentos descartados. La sección **Hallazgos** lista lo
   que el ACL no pudo leer: es justo lo que certificar debe descubrir (07 §6.4) y hay que mirarlo antes de enviar.

6. **Si algún caso falló** (inventario de test, corte del entorno), repite sólo ese caso en la misma corrida y
   vuelve a empaquetar:

   ```bash
   node tools/tbo/cert-cases.mjs run --cases 7 --resume 2026-10-15T14-03-22Z
   node tools/tbo/cert-cases.mjs zip 2026-10-15T14-03-22Z
   ```

   `--resume` no pisa nada: la carpeta anterior del caso pasa a `attempts/superseded/`. Todos los casos del zip
   tienen que salir del mismo build (G-9).

7. **Envío** (lo hace el founder): el zip de la carpeta de la corrida, junto con el workflow del Anexo A de 07,
   a `apisupport@tbo.com`. Las credenciales del portal van por otro canal (Anexo B).

8. **Versionado** (PR-7.3; D-TBO-33): sólo el zip ENVIADO y, al final, la tabla de sign-off se copian a
   `docs/tbo/evidence/cert/<YYYY-MM-DD>/`. `.tbo-cert/` nunca se commitea.

## Qué se reserva en el entorno de test

Cada caso de 1 a 7 hace **una** reserva real en la cuenta de test (consume el crédito `Limit` de la cuenta
hasta que se cancela). El caso 8 no reserva: lee la del caso 4.

| Caso | Carpeta                          | Ocupación (07 §4.2)                      | `GuestNationality` | Qué se reserva                                                              |
| ---- | -------------------------------- | ---------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| 1    | `Case01_1Room_1A`                | 1 hab.: 1 adulto                         | CO                 | La tarifa reembolsable más barata; si no hay, la más barata                 |
| 2    | `Case02_1Room_1A1C`              | 1 hab.: 1 adulto, 1 niño (7)             | PE                 | Ídem                                                                        |
| 3    | `Case03_1Room_2A2C`              | 1 hab.: 2 adultos, 2 niños (4, 10)       | BR                 | Ídem                                                                        |
| 4    | `Case04_2Rooms_1A_1A`            | 2 hab.: 1 adulto + 1 adulto              | MX                 | Ídem                                                                        |
| 5    | `Case05_2Rooms_1A1C_1A`          | 2 hab.: 1 adulto y 1 niño (8) + 1 adulto | CL                 | Ídem                                                                        |
| 6    | `Case06_2Rooms_1A2C_2A`          | 2 hab.: 1 adulto y 2 niños (3, 11) + 2   | AR                 | Ídem                                                                        |
| 7    | `Case07_Supplements_<ocupación>` | La del caso 4; si no hay suplementos, 1  | EC                 | La primera tarifa con suplemento `AtProperty`; si ninguna, con `Included`   |
| 8    | `Case08_BookingDetail_OfCase04`  | —                                        | —                  | Nada: BookingDetail de la reserva del 4 por `ConfirmationNumber` y por ref. |

- Los huéspedes son de la lista sintética del arnés (`lib/cases.mjs`; guarda G-4): el caso 6 sale exactamente
  como la plantilla de 07 §4.8. `EmailId` y `PhoneNumber` son los de `.env.tbo`. Nada de eso se redacta en el
  zip: TBO necesita los RQ completos (07 §6.6).
- `BookingReferenceId` y `ClientReferenceId` los genera el ACL con la regla de producción (`STT…`, RF-19).
- Pedir el caso 4 o el 8 corre los dos: el 8 lee la reserva del 4 antes de que se cancele.

**Cómo se cancela al final.** Con `TBO_CANCEL_AFTER=true` (por defecto) cada cadena termina como cancela la
aplicación: BookingDetail previo, `Cancel` y BookingDetail posterior (archivos `_BeforeCancel` y `_AfterCancel`
del zip). El Cancel nunca se repite. Al final, `run` lista las reservas que **siguen activas** —las de un Cancel
que no se confirmó— con su `ConfirmationNumber` y su `BookingReferenceId`. Con `TBO_CANCEL_AFTER=false` (si TBO
pide dejarlas activas para revisarlas, Q-73) no se cancela nada y se listan todas; cuando haga falta:

```bash
node tools/tbo/cert-cases.mjs cancel 2026-10-15T14-03-22Z
```

`cancel` graba cada cancelación en `cancellations/CaseNN/` (fuera del zip; una segunda invocación sigue la
numeración, no escribe encima), actualiza `cases.json` y no vuelve a tocar lo que ya quedó cancelado. Si un caso
se repite con `--resume` mientras su reserva anterior sigue activa (o era un Book incierto), esa reserva pasa a
`superseded` en `cases.json`: `cancel` la sigue encontrando. La lista de reservas activas sale también cuando la
corrida se corta a mitad (cuenta rechazada, guarda).

**Las sondas con reserva** (`probe --bookings`) cancelan siempre, pida lo que pida `TBO_CANCEL_AFTER`: PR-09 y
PR-10 reservan una vez cada una (PR-10 sólo si TBO acepta el `TotalFare` distinto) y PR-11 dos (la segunda sólo
si la primera confirmó).

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
node tools/tbo/cert-cases.mjs probe                       # PR-01 a PR-08
node tools/tbo/cert-cases.mjs probe --only PR-01,PR-03    # algunas
node tools/tbo/cert-cases.mjs probe --skip-hotelcodelist  # PR-04 sin descargar la lista completa
node tools/tbo/cert-cases.mjs probe --bookings            # PR-01 a PR-11 (reserva y cancela)
node tools/tbo/cert-cases.mjs probe --bookings --only PR-11
```

Antes de las sondas corre un Search del caso 1 como **control**: si no da `200` o `201`, no corre ninguna (cada
una contestaría "401" o "sin red") y sale con 1. PR-09 a PR-11 sólo corren con `--bookings`; pedirlas con
`--only` sin `--bookings` es un error de uso.

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
| PR-09 | [Q-43](../../docs/tbo/10-preguntas-para-tbo.md#q-43) | Un Book con `José Muñoz` (el ACL translitera a ASCII, D-TBO-23 A; la sonda devuelve las tildes), BookingDetail para ver qué guardó TBO y Cancel.   |
| PR-10 | [Q-33](../../docs/tbo/10-preguntas-para-tbo.md#q-33) | Un Book con `TotalFare` 0.01 por encima del PreBook (reescrito sobre el literal, sin coma flotante) y Cancel si TBO lo aceptó.                     |
| PR-11 | [Q-35](../../docs/tbo/10-preguntas-para-tbo.md#q-35) | Dos Book con el mismo `BookingReferenceId` y `BookingCode` distintos, BookingDetail por esa referencia y Cancel de todo lo que exista.             |

Notas:

- **Reescrituras.** Cuando la pregunta es sobre algo que el ACL no manda (el ordinal de `MealType`, 101 códigos, el
  casing de Postman, las tildes, un `TotalFare` distinto), la sonda cambia **sólo ese campo o ese path** del RQ que
  armó el ACL. La mutación queda declarada en `calls.jsonl` (`mutation`, `aclUrl`) y el RQ original se guarda al
  lado como `*_RQ.acl.json`. Las guardas D1 del grabador valen también después de reescribir.
- **PR-04 y `BookingDetailsbasedondate`.** El body es el de docs/tbo/04 §5 (`FromDate`/`ToDate`, últimos 7 días) y
  sale por el cliente HTTP del ACL, con su autenticación y su lectura del envelope.
- **PR-04 y `hotelcodelist`.** Descarga todos los códigos de TBO dos veces (180 s de timeout por intento y hasta
  3 intentos cada una, los de `TBO_OPERATIONS`). Con `--skip-hotelcodelist` esa pareja no se prueba y PR-08
  necesita `TBO_HOTEL_CODES` o `TBO_CITY_CODE`.
- **PR-06** usa un usuario inventado, no una variación del real: los intentos fallidos no pueden bloquear la cuenta.
- **Cerrar una pregunta.** `probes/summary.md` trae, por sonda, la tabla de variantes y una **lectura**. Lo que se
  versiona es la respuesta transcrita a [`docs/tbo/10-preguntas-para-tbo.md`](../../docs/tbo/10-preguntas-para-tbo.md)
  (fecha, corrida y lo observado), nunca la captura cruda (07 §6.9). Con `201` en todas las variantes la lectura lo
  advierte: TBO pudo no llegar a validar la forma. Las sondas nunca entran al zip.

## run

```bash
node tools/tbo/cert-cases.mjs run                 # casos 1 a 8
node tools/tbo/cert-cases.mjs run --cases 1,2     # sólo esos (el 4 y el 8 van juntos)
node tools/tbo/cert-cases.mjs run --cases 7 --resume <runId>
```

Cada caso de 1 a 7 es una cadena de la aplicación: **Search** (listado, `IsDetailedResponse: false`) → **PreBook**
de la tarifa elegida → **Book** con el `BookingCode` y el literal de `TotalFare` del PreBook, `BookingType:
"Voucher"` y `PaymentMode: "Limit"` → **BookingDetail** por `ConfirmationNumber` → (con `TBO_CANCEL_AFTER=true`)
**BookingDetail**, **Cancel** y **BookingDetail** posterior. El caso 4 intercala las dos lecturas del caso 8 antes
de su Cancel.

Intentos (07 §4.1 y §6.5). Cada intento se graba en `attempts/CaseNN_…/try-XX/` con su motivo en
`attempts/index.jsonl`; el que completa la cadena pasa a `CaseNN_…/`. Los intentos no entran al zip (se entregan
si TBO pide "all the JSON logs").

| Qué pasó                                                      | Qué hace `run`                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search `201`, o ninguna tarifa sirve (caso 7 sin suplemento)  | El siguiente lote de `HotelCodes`, la siguiente ocupación (caso 7) y, al final, el check-in +7 días                                                                                                                                                                                                 |
| PreBook o Book `201`, `207` o `315`                           | Check-in +7 días. Hasta 3 corrimientos y 12 Search por caso                                                                                                                                                                                                                                         |
| Red, `429` o `5xx` en Search o PreBook                        | El mismo Search otra vez (los reintentos propios del cliente del ACL ya corrieron)                                                                                                                                                                                                                  |
| PreBook con condiciones "sólo con billete aéreo"              | No reserva (la aplicación tampoco, RF-17) y no vuelve a elegir esa tarifa                                                                                                                                                                                                                           |
| Book incierto (corte, timeout, `405`, `500`, sin localizador) | **Nunca** repite el Book: espera 120 s y lee BookingDetail por `BookingReferenceId` (captura `Recovery`). Si existe, la cancela (con `TBO_CANCEL_AFTER=true`); si no aparece, imprime su referencia para verificarla con TBO. En los dos casos el caso se detiene y se repite a mano con `--resume` |
| `400` del request, o un `200` que el ACL no lee               | Detiene el caso: es un hallazgo y sale en `selfcheck.md`                                                                                                                                                                                                                                            |
| `401`, `402` o `300` (la cuenta)                              | Corta la corrida entera: nada más va a funcionar con esa cuenta                                                                                                                                                                                                                                     |

## verify y zip

```bash
node tools/tbo/cert-cases.mjs verify <runId>
node tools/tbo/cert-cases.mjs zip <runId>
```

No usan la red. Pasan las guardas de 07 §6.7 (funciones puras en `lib/guards.mjs`) sobre los bytes de la corrida;
si una que aborta falla, `zip` no escribe nada. Después de escribir el zip lo vuelve a leer: verifica cada CRC y
pasa G-1 sobre lo descomprimido; si algo falla, borra el zip.

| Guarda | Qué comprueba                                                                                                          | Si falla |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| G-1    | Ningún archivo de la corrida lleva el usuario, la contraseña ni el token Basic; ningún archivo del zip `Authorization` | Aborta   |
| G-2    | Ningún RQ con `PaymentInfo` ni claves de tarjeta, en cualquier nivel y casing                                          | Aborta   |
| G-3    | `PaymentMode: "Limit"` en todo PreBook, Book y BookingDetail; ningún otro valor en ningún RQ                           | Aborta   |
| G-4    | Todo `FirstName` y `LastName` del Book es de la lista sintética                                                        | Aborta   |
| G-5    | `IsDetailedResponse: false` en todo Search del zip                                                                     | Aborta   |
| G-6    | `GuestNationality` con al menos 3 valores entre los casos 1-7, y la de 07 §4.2 en cada caso                            | Aborta   |
| G-7    | `PaxRooms` es el de 07 §4.2 y coincide con `CustomerDetails` del Book en habitaciones, orden, adultos y niños          | Aborta   |
| G-8    | `Book.TotalFare` igual al `TotalFare` de la respuesta de PreBook                                                       | Aborta   |
| G-9    | Los 8 casos con la cadena completa, Book `200` con `ConfirmationNumber`, sin llamadas reescritas y del mismo build     | Aborta   |
| G-10   | Menos de 30 min de Search a Book                                                                                       | Advierte |
| G-11   | El caso 7 tiene al menos un suplemento; se anota si hay `AtProperty`                                                   | Aborta   |
| G-12   | La corrida es contra el endpoint de test, salvo `--allow-non-test-host` en esa misma invocación de `verify`/`zip`      | Aborta   |
| G-13   | Cada RS parsea como JSON (uno que no, se entrega igual: es un hallazgo)                                                | Advierte |

En G-1, `Authorization` cuenta en cualquier forma dentro de los RQ, del `README.txt` y del manifiesto; en un RS sólo
con forma de cabecera (`Authorization: Basic …`), porque las condiciones de un hotel pueden decir "credit card
authorization". El token mismo lo encuentra la búsqueda de la credencial.

El zip se llama `<TBO_COMPANY_SLUG>_TBO_HotelAPI_JSON_Certification_<YYYYMMDD>.zip` (07 §5) y lleva:

- `README.txt` (inglés): la tabla de casos con `HotelCode`, `BookingCode`, `ConfirmationNumber`,
  `BookingReferenceId` y el estado final, los suplementos del caso 7 y cada llamada con su hora UTC, HTTP,
  `Status.Code` y latencia;
- `manifest.json`: SHA-256 y tamaño de cada archivo, el SHA de git y el endpoint;
- `CaseNN_…/NN_<Operación>[_etiqueta]_RQ.json` y `_RS.json` de cada caso: los bytes que salieron y los que
  llegaron. No lleva `calls.jsonl` (tiene la cabecera `Authorization` redactada), ni intentos, ni sondas.

## Qué produce

```text
.tbo-cert/2026-10-15T14-03-22Z/
├── run.json              parámetros, git SHA (y si había cambios sin commitear), versión y fecha del dist del ACL
├── invocations.jsonl     (run --resume, cancel) una línea por invocación posterior
├── check/                (check, all) NN_<Operación>_…_RQ.json / _RS.json, calls.jsonl, acl-events.jsonl, check.json
├── probes/               (probe) 00-control/, PR-01/ … PR-11/, summary.json y summary.md
├── hotelcodes/           (run con TBO_CITY_CODE) el TBOHotelCodeList de la ciudad
├── Case01_1Room_1A/ …    (run) la cadena completa de cada caso, calls.jsonl, acl-events.jsonl y case.json
├── attempts/             (run) try-XX/ de cada intento descartado, index.jsonl y superseded/ (--resume)
├── cancellations/        (cancel) las cancelaciones posteriores
├── cases.json            (run) el estado de cada caso: localizador, referencia y cancelación
├── selfcheck.md/.json    (verify, zip) guardas, checkpoints, casos e intentos
├── README.txt, manifest.json y <Empresa>_TBO_HotelAPI_JSON_Certification_<YYYYMMDD>.zip   (zip)
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
  (G-1): si algo aparece, sale con 1 y pide borrar la carpeta. `zip` no se arma si G-1 falla.
- **D1 sobre lo que sale**: ninguna clave de tarjeta, `PaymentMode` sólo `"Limit"` y, en PreBook, Book y
  BookingDetail, presente (G-2, G-3), también después de una reescritura. Un request que no cumple no sale, no se
  escribe y corta la corrida. Nunca hay PAN.
- **Host**: sólo el de `TBO_BASE_URL`. Una reescritura no puede mandar el `Authorization` a otro servidor.
- **G-12**: contra un host que no es el de test, el arnés se niega salvo con `--allow-non-test-host`: reservar
  contra live consumiría el `Limit` real.

## Códigos de salida

`0` bien · `1` el comando no llegó a su resultado (check o control que no pasa, un caso sin cadena completa, una
guarda que aborta, una cuenta que TBO rechaza, una cancelación sin confirmar) · `2` error de uso o de
configuración (faltan credenciales o el contacto de rol, host que no es de test, ACL sin compilar, corrida que no
existe).

## Tests

Contra un TBO falso con forma de `fetch` y con estado (`test/fake-tbo.mjs`: cada Search emite `BookingCode`
nuevos, Book crea reservas que BookingDetail encuentra y Cancel cancela), sin red ni credenciales, y con el ACL
real compilado. Turbo los corre con el resto (`test` depende del build del ACL):

```bash
pnpm turbo run test --filter=@sales-travel/tbo-cert
# o, con el ACL ya compilado:
pnpm --filter @sales-travel/tbo-cert test
```
