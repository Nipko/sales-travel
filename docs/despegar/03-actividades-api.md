# Despegar / HotelDO — referencia de la API v3 de actividades

> Resumen técnico de https://api-docs.despegar.com (Activities v3), leído el 2026-11-23: la guía
> `docs/activities.md` (2026-09-22), la certificación `docs/activities-1.md` (2026-09-08),
> `docs/security-scheme.md`, `docs/general-information.md` y las referencias `get_discovery`,
> `get_modalities`, `get_availability`, `get_shopping`, `getsuggestionsactivities-1`,
> `createprebook-1`, `getpaymentoptions-1`, `createbooking-1`, `getreservation-1`,
> `getreservationstatus`, `getcancelallowance`, `createcancelquote` y `cancelreservation`.
> Es la base de `providers/despegar-activities`. Lo marcado **(sin verificar)** es ambiguo o
> contradictorio en la documentación y hay que confirmarlo en sandbox.
>
> **Estado al 2026-11-23: nada de esto se probó contra la API real.** La clave de sandbox responde
> `403 "doesn't have access to this method"` en `/activities-api/*` (hoteles da 200). Despegar tiene
> el pedido de habilitación. Todo lo implementado se probó con fixtures armados a partir de los
> esquemas y ejemplos de la documentación. Ver [§ Revalidar cuando habiliten el acceso](#revalidar-cuando-habiliten-el-acceso).

## Conexión

| Entorno    | Base URL de búsqueda                              | Base URL de reserva y post-venta   |
| ---------- | ------------------------------------------------- | ---------------------------------- |
| Sandbox    | `https://api-dev.despegar.com/v3/activities-api`  | `https://api-dev.despegar.com/v3`  |
| UAT        | `https://apis-uat.despegar.com/v3/activities-api` | `https://apis-uat.despegar.com/v3` |
| Producción | `https://api.despegar.com/v3/activities-api`      | `https://api.despegar.com/v3`      |

- Autenticación: header `x-apikey`. `security-scheme.md` dice que la clave es «la única credencial» para HotelDO, Decolar, post-venta y actividades: **es la misma cuenta BYOC de hoteles** (`provider_code = 'despegar-hotels'`).
- **UAT y `Authorization` (sin verificar).** Nos llegó que UAT pide un header `Authorization` en vez de `x-apikey`. Ninguna página leída lo dice; sólo los ejemplos de 400 `BAD_REQUEST` de prebook y book dicen «Authorization header is missing». El cliente manda sólo `x-apikey`; si UAT lo exige, se agrega en `DespegarHttpClient` para todos los productos.
- Las rutas de búsqueda cuelgan de `/activities-api`; prebook, payments, book y post-venta son **las mismas rutas compartidas** que usa hoteles (`/prebook`, `/payments`, `/book`, `/reservations…`). Cada página de reserva dice que vale para vuelos, hoteles y actividades: el producto lo decide el `choice_id` o el `product_id`.
- Errores de búsqueda: `{ code, message }`. Varios errores se concatenan con `//` en `message`. Post-venta suma `errors[] { field, message }`.
- No hay clave de idempotencia; un book repetido responde `DUPLICATED_RESERVATION`.

### Decisión: paquete propio que reusa el cliente HTTP de hoteles

`providers/despegar-activities` es un paquete aparte que **importa `DespegarHttpClient` y `DespegarApiError` de `@sales-travel/despegar-hotels`**:

- Misma clave, mismo host y misma base `/v3`: un segundo cliente duplicaría la auth, el timeout, el gancho `onExchange` de la bóveda de payloads y la regla de no poner el cuerpo en `message`. Un único `DespegarApiError` deja que el filtro de errores y el breaker traten igual a los dos productos.
- Paquete propio y no una carpeta dentro de hoteles: los DTOs de actividades (distribución por edades, tramos de cancelación con fecha, `ticket_validity`) no tienen nada que ver con los de hoteles, y el ACL de hoteles ya es grande. Cada uno expone sólo tipos canónicos (`packages/canonical/src/activity.ts`).
- Las rutas compartidas tienen la misma forma para los dos productos, así que se reusan sus builders y mappers de hoteles: `GET /payments`, el cuerpo de `POST /book` (`buildBookBody`), su respuesta y `GET /book/{id}` (`mapBookResult`), y los tres pasos de la cancelación. Lo propio de actividades se mapea en el paquete nuevo: el prebook (`include` = `EXCHANGE_POLICIES` + `HINTS`, políticas por clave de producto), el armado del book (todos los participantes, titular en la referencia 0, cuenta corriente) y `/reservations` filtrado a `TICKET|TOUR` con `use_date`, `passengers`, la política del ticket y el voucher.

## Reglas de búsqueda

- Dos categorías: **Ticket** (entradas a parques de Orlando) y **Tour** (todo lo demás).
- No se buscan fechas pasadas: 400 `INVALID_FIELD` «It's a past date».
- **Una llamada a `/availability` por fecha.** Para ver varias fechas, se repite.
- Parques de Orlando (`DY_ORL` Disney, `UN_ORL` Universal, `SW_ORL` SeaWorld, `BG_ORL` Busch Gardens): `/shopping` da en una sola llamada todas las modalidades × días, con `choice_id` por día, en una ventana de 7 días contando el inicial. Sin `to` toma `from + 6`. Si `to` supera los 7 días, la guía dice que devuelve sólo los 7 primeros; la referencia no lo dice **(sin verificar)**.
- Distribución: `adultos-edad-edad…`. El primer número es la cantidad de adultos; cada número siguiente es la edad de un menor. Ej. `2-5-9`. No hay marca de bebé: un bebé va como edad (`1`).
- Categorías de edad según la certificación: adultos 10+, niños 3–9, bebés 0–23 meses; los menores son 0–17. Se superponen y dejan un hueco a los 2 años **(sin verificar)**. Mandan los rangos que devuelve el proveedor por modalidad (`adult_age_range`, `child_age_range`, `infant_age_range`) y por precio (`adult_max_age`, `child_max_age`, `infant_max_age`); la UI pide **edades** y nunca categorías.

## Flujo de venta

`discovery` → `modalities` → `availability` (una por fecha; da `choice_id`) → `POST /prebook` → `GET /payments` → `POST /book` → `GET /book/{id}`

Orlando: `shopping` (da `choice_id` por día y modalidad) → `POST /prebook` → …

### Sugerencias — `GET /v3/suggestions/activities`

Query: `hint` (texto), `locale` (`pt_BR`, `es_AR`…). Respuesta `items[] { id (POI_…), display, highlight (con `<em>`), target { id, gid, type: POI, parents { continent, country, administrative_division, city } } }`.

Devuelve **POIs**, no el código IATA que pide `/discovery`. El ACL lo expone pero la búsqueda de la web usa un selector de ciudad con código IATA. Cómo pasar de un POI a un `destination` **(sin verificar)**.

### Discovery — `GET /activities-api/discovery`

Query (todos obligatorios): `site` (país, `br`), `destination` (IATA de la ciudad, `SAO`), `language` (`pt`, sin enum).

Respuesta: array de objetos `{ items[] { tracking_id, type: TOUR|TICKET, name } }`. La guía lo llama `available_tickets`; manda el esquema de la referencia. Errores 400/401/403/404/500 sin cuerpo documentado.

### Modalities — `GET /activities-api/modalities`

Query: `id` (el `tracking_id` de discovery; la descripción está vacía en la referencia), `site` (2 letras), `language` (`ES|PT|EN` **en mayúsculas**), `from` y `to` opcionales y **juntos**.

Respuesta:

- `ticket_id`, `tracking_id`, `id`, `type`, `name`, `description`, `duration { type, value (number) }`
- `modalities[] { id (ej. `ORL_1P1D_EPIC`, es el `modality` de availability), modality_type, name, available_dates[] { date, hours[] { id, hour (number) } }, prices[] { currency, unit_price } (precio de referencia), max_capacity, adult_age_range|child_age_range|infant_age_range { min_age, max_age }, additionals[] { id, title, description, price[] { currency, unit_price }, inclusions[], exclusions[] } }`
- `images[] { url, key, width, height }`, `inclusions[]`, `exclusions[]`

Errores: 400 `INVALID_FIELD`, 503 `ACTIVITY_PROVIDER_ERROR`.

- `hours[].hour` es un número sin ejemplo: ¿`930`? ¿`9`? **(sin verificar)**. El mapper acepta número (`930` → `09:30`, `9` → `09:00`) y texto `HH:mm`.
- La certificación pide mostrar `use_policy`, que no está en el esquema **(sin verificar)**.

### Availability — `GET /activities-api/availability`

Query: `id`, `modality`, `date` (`YYYY-MM-DD`), `site`, `language` (`es|pt|en` **en minúsculas**), opcionales `distribution` (default `1`), `additionals` (id de `modalities[].additionals[].id`) y `schedule`.

- **`schedule` está declarado `number` con ejemplo `"09:30"`** y la descripción copiada de `distribution` **(sin verificar)**. Se manda como texto `HH:mm`, que es lo que muestra el ejemplo; si Despegar responde 400, probar `930`.

Respuesta:

- `choice_id` — token para el prebook.
- `name`, `modality_choice_name`, `type`, `language`, `site` (en mayúsculas), `destination` (IATA)
- `from`, `to` — inicio y fin ISO 8601 (`date-time`).
- `distribution { adults, adults_ages[], children_ages[], infants_ages[], adult_max_age, child_max_age, infant_max_age }`
- `additions_chosen[] { title, description, prices (objeto por moneda; USD siempre) }` — tipado objeto y descrito como array **(sin verificar)**.
- `price_details[] { total, net, tax, gross, currency, currency_to_usd_change_rate, usd_to_currency_change_rate, price_disaggregation { agency_commission { gross, net, tax } } }` — una entrada en USD y otra en la moneda local del `site`. `gross = net + tax = total`.
- `cancellation_policy { title, cancellable, ranges[] { from, to (falta en el último), penalty { USD, BRL… }, percentage, label }, conditions[] }` — `0.0` = gratis, `100.0` = sin reembolso. `from`/`to` son `date` aquí y `date-time` en shopping: el mapper acepta los dos.
- `highlights[]`
- `ticket_validity { use_date, use_expiration_date }` — no siempre viene (las entradas de fecha abierta no tienen `use_date`).

Errores: 400 `INVALID_FIELD` (site inválido, fecha pasada, «to date must be after from date», este último copiado de otro endpoint), **503 `ACTIVITY_PROVIDER_ERROR` también cuando no hay disponibilidad** para la fecha o la distribución, o el id/modalidad no existen. La plataforma traduce ese 503 a «no hay disponibilidad para esa fecha o esos participantes», no a «el proveedor está caído» **(sin verificar: puede ser también una caída real)**.

### Shopping (Orlando) — `GET /activities-api/shopping`

Query: `id` (sólo `BG_ORL|DY_ORL|SW_ORL|UN_ORL`; otro valor → 400), `site` (`AR`, mayúsculas en el ejemplo), `language` (`es`), `from` (obligatorio), `to` (opcional, `>= from`), `distribution` (**obligatorio** aquí), `modalities` (ids separados por coma; los inválidos se ignoran sin error).

Respuesta: array de parques `{ tracking_id, name, description (HTML), logo, images[], modalities[] { modality_type ("Modality"), id, name, description, duration { type: "DAY", value: "1" (texto) }, inclusions[], exclusions[], availabilities[] { choice_id, date, price_details[], additionals[], distribution, cancellation_policy, ticket_validity } } }`.

Errores: 400 `INVALID_FIELD` / `MISSING_REQUIRED_PARAMETER` / `ACTIVITY_PROVIDER_ERROR` (aquí 400, en availability 503), 401 `UNAUTHORIZED`, 500 `INTERNAL_ERROR`, 503 `ACTIVITY_PROVIDER_ERROR`.

### Prebook — `POST /prebook` (compartido)

Cuerpo: `choice_id` (obligatorio), `lang` (`es|pt|en`, idioma de `extended_info`), `include[]` (`EXCHANGE_POLICIES`, `IMPORTANT_DATA`, `HINTS`; «al menos una»). Para actividades la certificación pide validar **`EXCHANGE_POLICIES` y `HINTS`**: el ACL manda las dos.

Respuesta: `prebook_id`, `expiration`, `status`, `flow`, `total`, `currency`, `commission { amount, min_amount, max_amount }`, `extended_info { exchange_policies { <clave de producto> { product_type, product_title, range[], conditions[] { title, question_and_answer[] { question, answer } }, disclaimers[] { title, description }, summary { operations_summaries[] { title, description, permit }, disclaimers[] { description } } } }, hints[] { modality, payment_option, hint { form { travelers {…}, payment {…} } } } }`.

- La tabla de claves de `exchange_policies` nombra `K0` para actividades, `F0` vuelos y `H0` hoteles, pero el esquema sólo documenta `F0` **(sin verificar)**. El mapper lee cualquier clave.
- Hay que mostrarle al cliente las políticas de cambio (`exchange_policies`) y los `disclaimers`.

Errores: 400 `INVALID_EXTENDED_INFO_REQUEST`, `INVALID_ITINERARY_ID_OR_COUNTRY`, `MESSAGE_NOT_READABLE`, `MISSING_REQUEST_BODY_REQUIRED_FIELD`; **410 `PRODUCT_GONE`** (el `choice_id` venció: volver a consultar disponibilidad).

### Payments — `GET /payments` (compartido)

Query: `prebook_id` (o `reservation_id` para un DEFERRED), opcionales `input_points`, `include_hints`.

Respuesta: `modalities[] { modality (PAYINADVANCE), price_information { total { base, taxes, fees, discount, total… }, currency }, payment_options[] { option_type (ONE_CARD|CURRENT_ACCOUNT|DEFERRED), group_plans[] { plans[] { id (plan_id), type, price { currency, total }, installments, card_brand, deferred_conditions } } } }`. `CURRENT_ACCOUNT` no trae `group_plans`.

- Para actividades: «Current Account, TC, Points». **La plataforma implementa sólo `CURRENT_ACCOUNT`** (cuenta corriente): no toca tarjetas (PCI SAQ-A) y la certificación exige un certificado PCI para emitir el token de tarjeta.

Errores 400: `ALREADY_BOOKED`, `INVALID_FIELD` (prebook vencido), `INVALID_PREBOOK_ID`, `MISSING_REQUIRED_PARAMETER`.

### Book — `POST /book` (compartido)

Cuerpo (variante cuenta corriente):

```json
{
  "prebook_id": "…",
  "external_booking_reference": "ST-…",
  "modality": "PAYINADVANCE",
  "contact_data": {
    "email": "…",
    "phones": [{ "type": "MOBILE", "country_code": "55", "area_code": "11", "number": "…" }]
  },
  "travelers": [
    {
      "traveler_reference_id": "0",
      "first_name": "…",
      "last_name": "…",
      "birth_date": "1999-01-31",
      "nationality": "BR",
      "identification": { "type": "PASSPORT", "number": "…" }
    }
  ],
  "payment": {
    "option_type": "CURRENT_ACCOUNT",
    "payment_units": [{ "type": "CURRENT_ACCOUNT" }],
    "invoices": []
  }
}
```

- **Actividades: todos los viajeros.** «El pasajero principal y el titular son el de la referencia 0». `traveler_reference_id` aparece en los ejemplos y no en el esquema **(sin verificar)**.
- `identification` «obligatoria para FLIGHT, TICKET»: la plataforma la pide para los tickets y la manda si la hay para los tours.
- `invoices` está como obligatorio en la variante de cuenta corriente con el mismo esquema que ONE_CARD (CPF/fiscal). Se manda vacío; si Despegar lo exige, los datos fiscales de la agencia van en la cuenta BYOC como en hoteles **(sin verificar)**.
- Nombres con caracteres ISO-8859-1 (á, ñ, ç): la certificación pide probarlos. Se mandan tal cual.

Respuesta 200: `reservation_id` (en las variantes del esquema aparece `reservationId`), `status` `SUCCESS|PROCESSING|ERROR`, `sub_status`, `message`, `products[] { type, platform_id (o `plataform_id`), pnr (número o texto) }`. El mapper acepta las dos grafías. `ERROR` llega con HTTP 200: `PRICE_JUMP`, `DUPLICATED_RESERVATION`, `INSUFFICIENT_FUNDS`, `PROVIDER_ERROR`…

Errores 400: `PAYMENT_ERROR` (estado de la cuenta corriente), `NOT_ENOUGH_BALANCE` (saldo menor al total), `PAYMENT_OPTION_NOT_FOUND`, `INVALID_PREBOOK_ID`.

### Estado — `GET /book/{reservationId}` (compartido)

Por `reservation_id` o por `external_booking_reference`: `{ reservation_id, status, products[] { type, platform_id, pnr } }`. La post-venta está disponible **60 segundos después** de confirmar.

## Post-venta

### Reservas — `GET /reservations`

Query: `reservation_id`, `product_type` (`HOTEL|FLIGHT|TICKET|TOUR`), `product_id`, `external_transaction_id`, `from_purchase_date`, `to_purchase_date`, `limit`, `page`.

`items[].product`: `product_id`, `product_type`, `transaction_id`, `status` (`IN_PROCESS|ISSUED|CANCELLED`), `pnr`, `reservation_id`, `sale_price { currency, price }`, `passengers[] { type ADULT|CHILD|INFANT, first_name, last_name, birth_date, … }`, y para TICKET: `use_date`, `use_expiration_date`, `use_type` (`FIXED`), `ticket_type` (`DISNEY`), `duration` (días), `highlights[]`, `all_travelers_required`, `cancellation_policy { cancellable, conditions[], descriptions[], ranges[] }`. Además `download_voucher_url` (relativa; no siempre viene) **(sin verificar: salió de un resumen de la página truncada)**.

### Cancelación (tres pasos, en orden; de todos los participantes)

«Una cancelación aplica a todos los participantes; no se permiten cancelaciones individuales.»

1. `GET /reservations/{product_id}/cancels/allowance` → `product_allowance { allowance: ALLOWED|DISALLOWED|UNKNOWN, disallowed_reason, refund_policy, policy, expiration_date_time }`. No devuelve importes.
2. `POST /reservations/cancels/quote` `{ transaction_id, quote_type: "BY_POLICIES" }` → `quote.product_quote { quote_id, resolution (MANUAL|AUTOMATIC), guaranteed, price_box { refunds[] { refund_method_price_box { currency, payment_amount, applied_penalty, refund_amount } } } }`.
3. `POST /reservations/{product_id}/cancels` `{ reason }` → `{ flow_id (CAN-… = cancelada), product_id, product_type }`. **Irreversible.** El enum de `reason` no tiene un motivo propio de actividades: se usa `OTHER` por defecto.

Los tipos de `product_id`/`transaction_id` cambian entre pasos (entero, texto, número): el ACL los trata como texto.

### Voucher

- **Obligatorio entregar el voucher de HotelDO** al cliente final (el propio de la agencia puede ir además).
- No hay endpoint de voucher documentado. `/reservations` trae `download_voucher_url` relativa **(sin verificar)**: el ACL la resuelve contra el host de la cuenta y la expone; la web la ofrece como «Voucher de HotelDO».
- La certificación pide que el voucher o la confirmación muestren: fecha de compra y de la actividad, número de confirmación de HotelDO, PNR, detalle y condiciones, nombres y cantidad de pasajeros, fechas de uso/validez, políticas de cancelación con fechas, cargos en destino, avisos importantes.

## Contenido

No hay un content-api de actividades. Descripción, duración, imágenes, inclusiones y exclusiones vienen en `/modalities` (y en `/shopping` para Orlando). La plataforma usa ese contenido en vivo, sin catálogo propio.

## Errores y cómo se traducen

| HTTP | `code`                       | Qué le dice la plataforma al vendedor                             | Estado de la API |
| ---- | ---------------------------- | ----------------------------------------------------------------- | ---------------- |
| 400  | `INVALID_FIELD`              | Algún dato de la búsqueda no es válido (fecha pasada, país…)      | 400              |
| 400  | `MISSING_REQUIRED_PARAMETER` | Falta un dato de la búsqueda                                      | 400              |
| 400  | `ACTIVITY_PROVIDER_ERROR`    | (shopping) El operador no respondió; probar otra fecha            | 502              |
| 401  | `UNAUTHORIZED`               | La clave de Despegar de la agencia no es válida                   | 502              |
| 403  | —                            | La clave no tiene habilitadas las actividades: pedirlo a Despegar | 502              |
| 410  | `PRODUCT_GONE`               | La tarifa venció: volver a consultar la disponibilidad            | 409              |
| 400  | `NOT_ENOUGH_BALANCE`         | La cuenta corriente con Despegar no tiene saldo                   | 402              |
| 400  | `PAYMENT_ERROR`              | La cuenta corriente con Despegar no permite pagar                 | 402              |
| 400  | `ALREADY_BOOKED`             | Esta tarifa ya se reservó                                         | 409              |
| 503  | `ACTIVITY_PROVIDER_ERROR`    | No hay disponibilidad para esa fecha o esos participantes         | 404              |
| 5xx  | `INTERNAL_ERROR` / red       | Despegar no responde; probar en unos minutos                      | 502              |

El detalle técnico (estado, ruta, `code`) va al log; el cuerpo nunca, porque el book y `/reservations` traen nombres, correos y documentos. El intercambio completo queda en la bóveda de payloads cifrada (`provider_payloads`) para la evidencia de certificación.

## Certificación (checklist de HotelDO para actividades)

Evidencia: PDF con capturas numeradas por ítem más los logs (RQ/RS) de cada reserva y cancelación. Todo en sandbox. Los links al sitio no valen.

**Reservas obligatorias** (sandbox, una por cada combinación):

| Ticket   | Composición                                 | Distribución                                                             |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `UN_ORL` | 2 adultos de 11 y 26 años                   | `2` (adult_ages 11, 26) **(sin verificar: cómo mandar un adulto de 11)** |
| `UN_ORL` | Familia: 2 adultos + niños de 5 y 9         | `2-5-9`                                                                  |
| `UN_ORL` | Con bebé: 2 adultos + niño de 7 + bebé de 1 | `2-7-1`                                                                  |
| `DY_ORL` | las mismas tres                             | idem                                                                     |

**Flujo** (lo que tiene que verse):

- [ ] Búsqueda (`/discovery`; la certificación la llama `/Ticket`): se muestran y guardan todos los tipos.
- [ ] Modalidades (por `id`; la certificación dice `ticket_id`): descripción, duración, `use_policy`, adicionales, imágenes.
- [ ] Disponibilidad por fecha: `from`, `to`, distribución, `cancellation_policy` y condiciones; se guarda el `choice_id`.
- [ ] Prebook con `EXCHANGE_POLICIES` y `HINTS`; mostrar las políticas al cliente; mapear errores.
- [ ] Payments: declarar los medios implementados (**cuenta corriente**); logs de reserva y cancelación por cada uno.
- [ ] Book: errores de pago mapeados; voucher/confirmación con todo lo del § Voucher.
- [ ] Post-venta a los 60 s: estado, voucher de HotelDO, cancelación (manual y automática), de todos los participantes.
- [ ] Ticket: nombre, descripción, condiciones de uso, restricciones de edad, duración y validez, ubicación, cantidad de pasajeros.
- [ ] Pasajeros: verificación de edad de menores, nombres con caracteres especiales (ISO-8859-1).
- [ ] Errores: mapa claro entre código y ID de HotelDO, mensajes descriptivos.
- [ ] Precios: desglose, cargos adicionales y en destino, políticas de cancelación visibles y cómo se calcula la penalidad.
- [ ] Contenido: declarar que se usa el contenido en vivo de `/modalities` (no hay estático); imágenes.

## Ambigüedades abiertas (preguntar a Despegar)

1. `schedule`: ¿texto `HH:mm` o número? (`number` con ejemplo `"09:30"`).
2. `hours[].hour` en modalities: ¿`930`, `9` u otra cosa?
3. Casing de `language` (`ES` en modalities, `es` en availability) y de `site` (`br` / `AR`).
4. Availability 503 por «sin disponibilidad»: ¿503 o 200 vacío? ¿Cómo distinguirlo de una caída?
5. Shopping con `to` > 7 días: ¿trunca o 400?
6. Rangos de edad (adultos 10+ vs. menores 0–17, bebé hasta 23 meses vs. `infant_max_age: 2`) y el caso «adulto de 11».
7. Orlando en la certificación: ¿por `/shopping` o por `/modalities` + `/availability`?
8. `exchange_policies` de actividades: ¿clave `K0`?
9. Book a cuenta corriente: ¿`invoices` vacío alcanza? ¿`traveler_reference_id` es el campo correcto?
10. Voucher de HotelDO: ¿`download_voucher_url` de `/reservations`, absoluta o relativa, y para TICKET y TOUR?
11. UAT: ¿`Authorization` en vez de `x-apikey`?
12. Motivo de cancelación para actividades (el enum no tiene uno propio).

## Implementación en la plataforma

| Pieza           | Dónde                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modelo canónico | `packages/canonical/src/activity.ts` (`ActivitySummary`, `ActivityDetail`, `ActivityOffer`, cancelación por tramos, validez)                                                                                                    |
| ACL             | `providers/despegar-activities` (reusa `DespegarHttpClient` y los mappers de rutas compartidas de `@sales-travel/despegar-hotels`)                                                                                              |
| Factory BYOC    | `apps/api/src/providers-despegar/despegar-activities.factory.ts`: cuenta `despegar-hotels` del tenant (propia o heredada), si no `DESPEGAR_API_KEY`. Bóveda de payloads con código `despegar-activities` (redactor de Despegar) |
| API             | `apps/api/src/activities/*`, rutas bajo `/api/activities`                                                                                                                                                                       |
| Web             | `apps/web-b2b/src/app/(app)/actividades` (menú «Actividades»)                                                                                                                                                                   |
| Humo            | `tools/despegar/activities-smoke.mjs`                                                                                                                                                                                           |

Rutas (rol vendedor; las de venta con `@SalesOperation`):

| Método y ruta                                      | Qué hace                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /activities/status`                           | Si está encendido y el registro de capacidades (`validatedAgainstApi: false`)                        |
| `GET /activities/search?destination=ORL`           | Discovery                                                                                            |
| `GET /activities/:id/modalities`                   | Ficha y modalidades                                                                                  |
| `POST /activities/availability`                    | Una fecha + participantes por edad → tarifa con `price` (una moneda) y `pricing` (cascada)           |
| `POST /activities/shopping`                        | Orlando, 7 días                                                                                      |
| `POST /activities/prebook`                         | Prebook + verificación de cuenta corriente en `/payments`                                            |
| `POST /activities/book`                            | Book a cuenta corriente; guarda la orden (`provider = 'despegar-activities'`) con el precio de venta |
| `GET /activities/reservations/:id`                 | Estado y voucher de HotelDO (sólo reservas de la agencia)                                            |
| `POST /activities/reservations/:id/cancel-preview` | Pasos 1 y 2 de la cancelación                                                                        |
| `POST /activities/reservations/:id/cancel`         | Los tres pasos; la orden queda cancelada                                                             |

- **Apagado por defecto**: `DESPEGAR_ACTIVITIES_ENABLED=true` lo enciende para vender. El apagado de emergencia (`PROVIDERS_DISABLED=despegar-activities` o el panel) le gana; `despegar-activities:ventas` frena la venta y deja la post-venta.
- **Pricing**: cascada de la vertical `activities` (`markup_rules.vertical = 'activities'`) sobre el **bruto** (`gross = net + tax`) de la moneda elegida: la pedida, si no la de la agencia, si no la local, si no USD. En una moneda que no es la de la agencia sólo se aplican los porcentajes. **Despegar no informa piso de venta** para actividades: no hay `provider_floor` (capacidad `providerFloor: false`). Cómo se relaciona `agency_commission` con lo que cobra la cuenta corriente **(sin verificar)**.
- **Paquetes** (contrato de `docs/platform/20-paquetes.md`): `toPackageItemInput` arma `vertical: 'activities'`, `providerName: 'despegar-activities'`, `providerItemId = choice_id`, `baseFareMinor`/`taxesMinor` = neto e impuestos de HotelDO en la **moneda del paquete** (si no la hay, no se agrega: la plataforma no convierte) y `rawDetails` con `kind: 'activity'`. El `choice_id` vence: reservar desde un paquete exige volver a consultar disponibilidad.

## Revalidar cuando habiliten el acceso

1. Con la clave de sandbox en `.env.local` del checkout principal (`DESPEGAR_API_KEY`), correr:

   ```powershell
   node tools/despegar/activities-smoke.mjs
   ```

   Lee la clave del entorno o de `.env.local` sin imprimirla. Recorre discovery (`ORL`), modalities, availability de la primera modalidad y fecha disponible para `2-7-1`, y shopping de `UN_ORL` y `DY_ORL`. Sólo lee: **no hace prebook ni book**. Con `--save <carpeta>` guarda las respuestas (sin la clave) para convertirlas en fixtures.

2. Si da `403 "doesn't have access to this method"`, el acceso sigue sin habilitar.
3. Con 200: comparar las respuestas guardadas con los fixtures de `apps/api/src/providers-despegar/__fixtures__/despegar-activities.fixtures.ts` y corregir los mappers donde difieran (casing, tipos de `hour`/`schedule`, forma de discovery). Resolver las ambigüedades de arriba.
4. Encender el proveedor en un entorno de prueba: `DESPEGAR_ACTIVITIES_ENABLED=true` (el kill-switch del panel y `PROVIDERS_DISABLED=despegar-activities` siguen pudiendo apagarlo).
5. Hacer desde la web las seis reservas de la certificación (cuenta corriente), cancelar una, bajar los RQ/RS de la bóveda de payloads y armar el PDF.
