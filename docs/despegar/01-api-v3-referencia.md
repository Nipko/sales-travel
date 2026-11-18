# Despegar / HotelDO — referencia de la API v3 de hoteles

> Resumen técnico de https://api-docs.despegar.com (Hotels v3), leído el 2026-11-18. Es la base de
> `providers/despegar-hotels` y del plan de `02-brechas-y-plan.md`. Donde la documentación se
> contradice, se anota. Lo marcado **(sin verificar)** salió de un resumen de una página truncada:
> confirmarlo en sandbox antes de depender de ello.

## Conexión

| Entorno    | Base URL                           |
| ---------- | ---------------------------------- |
| Sandbox    | `https://api-dev.despegar.com/v3`  |
| UAT        | `https://apis-uat.despegar.com/v3` |
| Producción | `https://api.despegar.com/v3`      |

- Autenticación: header `x-apikey`. Una clave por entorno; la misma sirve para hoteles, actividades y post-venta.
- Errores: JSON `{ code, message }` (post-venta suma `errors[] { field, message }`; content-api usa `{ error_code, message, details }`). Estados: 400, 401, 403, 404, 409, 410 (prebook), 429, 500. **No hay números de rate limit publicados**; el 429 existe en availability, detail y content.
- No hay clave de idempotencia. Un Book duplicado responde `DUPLICATED_RESERVATION` o 500 `BAD_REQUEST`.

## Reglas de búsqueda

- 1 a 4 habitaciones; al menos 1 adulto por habitación; máximo 8 personas por habitación; edades de niños obligatorias, 0–17.
- Estadía de 1 a 30 noches; check-in hasta 540 días adelante; nunca fechas pasadas.
- Hasta 100 hoteles por búsqueda (50 recomendado). Orden sólo por precio ascendente.
- Todas las tarifas son prepagas. No se informa cuántas habitaciones quedan.
- Tarifas por contexto (`context`, `alternative_rates`) no soportadas: otro tipo de tarifa = otra credencial.

## Flujo de venta

`availability` → `availability/{hotel_id}` (detalle, da `choice_id`) → `POST /prebook` → [`PUT /commissions/update`] → `GET /payments` → `POST /book` → [`GET|PATCH /book/{id}/recovery`]

### Availability — `GET /hotels-api/availability`

Query: `country_code`, `checkin_date`, `checkout_date`, `currency`, `hotels` (ids separados por coma), `distribution` (`adultos-edad-edad`, habitaciones con `!`: `2!2-8-5`), opcionales `language` (`EN|ES|PT`), `ttl` (3000–6200 ms), `refundable_only`, `limit`.

Respuesta `items[]`: `id`, `hotel_info { name, type, stars, location { latitude, longitude } }`, `roompacks[]`:

- `id`, `meal_plan.id`, `promo`, `tags`
- `rooms[] { name, reference, bed_options[], room_type_id, max_capacity }` (en el detalle además `choice_id`)
- `cancellation_policy { status (non_refundable|partially_refundable|fully_refundable), hours_before_penalty, vendor_notes, cancellation_policy_rules[] { type (cancellation|no_show), penalty { percentage, night_count }, anticipation { from, to } } }`
- `price_detail { currency, total, taxes, taxes_detail[], agency_commission, charge_at_destination, charge_at_destination_detail[] { code, amount }, taxes_at_destination, binding_public_rate_enabled, binding_public_rate_value }`

Reglas: `total` = subtotal + impuestos, **sin** `charge_at_destination`. Con `binding_public_rate_enabled`, `binding_public_rate_value` es el **precio mínimo de venta** y `total` sigue siendo el neto. Roompacks sin `room_type_id`: se recomienda descartarlos. Códigos de `charge_at_destination_detail[].code`: TT, TA, RF, TM, EF, DO, TL, DS, ISS, TS, TE, CT, SH (catálogo en `fee-types`).

### Detail — `GET /hotels-api/availability/{hotel_id}`

Mismos parámetros que availability (sin `hotels`) más `roompack_id`. Agrega `rooms[].choice_id` (lo que pide el prebook), `cancellation_policy.vendor_notes` y `categorized_notices { primary, secondary }` con `{ title, notices[] }`. Puede diferir un poco del listado por caché del proveedor.

### Prebook — `POST /prebook`

Body: `choice_id` (obligatorio), `lang` (`es|en|pt`), `include[]` (`EXCHANGE_POLICIES`, `HINTS`; `IMPORTANT_DATA` es de vuelos).

Respuesta: `prebook_id`, `expiration`, `status`, `flow`, `total`, `currency` (la de la cuenta, no la buscada), `commission { amount, min_amount, max_amount }`, `extended_info { exchange_policies (clave H0), hints }`.

Reglas: vale **15 minutos**; no retiene inventario (si no se reserva, no hay nada que cancelar). Errores 400 (`INVALID_ITINERARY_ID_OR_COUNTRY`, `MISSING_REQUEST_BODY_REQUIRED_FIELD`…) y **410 `PRODUCT_GONE`** (choice vencido o desconocido).

### Commission update — `PUT /commissions/update`

Body: `prebook_id`, `commission` (número entre `min_amount` y `max_amount`). Respuesta: `commission { amount, min_amount, max_amount }`, `total`, `currency`. Sólo para el modelo comisionable; va **antes** de `/payments`.

### Payments — `GET /payments`

Query: `prebook_id` **o** `reservation_id` (no ambos), `input_points`, `include_hints`.

Respuesta `modalities[]`: `modality` (`PAYINADVANCE`), `price_information`, `payment_options[]`:

- `option_type`: `ONE_CARD` | `CURRENT_ACCOUNT` | `DEFERRED`.
- `group_plans[]` (no en `CURRENT_ACCOUNT`): `{ type (CARD|DEFERRED), plans[] { id, type (CREDIT|DEFERRED), price { currency, total }, installments, card_brand, deferred_conditions { deadline, reason } } }`.
- `CURRENT_ACCOUNT` no trae plan: el Book no lleva `plan_id`.
- `DEFERRED` sólo con `prebook_id` y si Despegar habilitó `REMOTE`.

Para el modelo sólo cuenta corriente, `/payments` se puede saltar; para el comisionable es obligatorio.

### Book — `POST /book`

Query opcional `test_case=pricejump` (sandbox). Body:

- `prebook_id`, `external_booking_reference` (nuestra; sirve para consultar después), `modality` (`PAYINADVANCE`).
- `contact_data { email, phones[] { country_code, area_code, number, type (HOME|MOBILE) } }`.
- `travelers[] { traveler_reference_id, first_name, last_name, gender?, nationality?, birth_date?, identification? { type (LOCAL|PASSPORT), number, issue_country } }`. **Hoteles: un único huésped principal por habitación.** Nombres sólo con letras (latinas extendidas incluidas).
- `payment`:
  - `CURRENT_ACCOUNT`: `{ option_type, payment_units: [{ type: "CURRENT_ACCOUNT" }], invoices[] }` — `invoices` obligatorio.
  - `ONE_CARD`: `payment_units[] { type, plan_id, secure_token, invoice_reference, card_holder_identification { type, number } }` + `invoices[]`. El token sale de la tokenización de Koin; en producción exige certificado PCI.
  - `DEFERRED`: `payment_units: [{ type: "DEFERRED", plan_id }]`, sin `invoices`.
- `invoices[]`: obligatorios `fiscal_status` (`PERSONA_FISICA`…) y `fiscal_identification { type, number, issue_country? }`; opcionales `reference`, `fiscal_name`, `first_name`, `last_name`, `fiscal_address { city_id, zip_code, street, number, neighbourhood, apartment, floor }`.

Respuesta: `status` `SUCCESS` | `PROCESSING` | `ERROR` (+ `sub_status`: `PRICE_JUMP`, `INSUFFICIENT_FUNDS`, `NOT_ENOUGH_BALANCE`, `CHANNEL_REJECTED`, `DUPLICATED_RESERVATION`…), `reservationId` (a veces `reservation_id`), `products[] { type, plataform_id (sic), pnr }`.

Errores: 400 `INVALID_FIELD`, `INVALID_PREBOOK_ID`, `PAYMENT_ERROR`, `PAYMENT_OPTION_NOT_FOUND`, `NOT_ENOUGH_BALANCE`; 409; 500 (pasajeros que no coinciden con el prebook, producto duplicado).

No documentados en el Book (se enviaban): `context_information` (sólo existe en los `hints` del prebook) y `disable_sync_result`.

### Recovery — `GET|PATCH /book/{reservationId}/recovery`

- GET: `status`, `sub_status` (`PRICE_JUMP`, `RESERVATION_AWAITING_PAYMENT_SELECTION`), `price_jump { difference, price_before_price_jump, price_after_price_jump, currency, timeout, message { message_type, price_jump_confirmations[] { flavor_id, confirm } } }`, `payment_selection { timeout }`.
- PATCH (204 sin cuerpo): `message_type` (`PRICE_JUMP` | `WAITING_PAYMENT_SELECTION`), `price_jump_confirmations[]`, `payment_type` (`CURRENT_ACCOUNT` | `CREDIT_CARD`), `credit_cards[] { payment_id, secure_token, document_type, document_number }`.
- Price jump y on-hold se habilitan del lado de Despegar.

### Estado — `GET /book/{reservationId}`

Acepta el id de reserva **o** la `external_booking_reference`. Respuesta `reservation_id`, `status`, `products[] { type, platform_id, pnr }`.

## Post-venta (hoteles: sólo CANCEL y SPECIAL REQUEST)

### Reservas — `GET /reservations`

Query: `reservation_id`, `product_id`, `product_type` (`HOTEL`…), `flow_id`, `external_transaction_id`, `by_api_key` + `from_purchase_date` / `to_purchase_date` (YYYY-MM-DD), `limit` (50), `page` (desde 0).

Respuesta `items[] { id, product }`; `product`: `product_id`, `product_type`, `transaction_id`, `status` (`IN_PROCESS` | `ISSUED` | `CANCELLED`; también aparece `DELETED`), `purchase_date_time`, `pnr` (referencia del hotel para el check-in), `external_reservation_id`, `reservation_id`, `sale_price { currency, price, conversion_rate, charges[] }`, `purchase_customer`, y para HOTEL `check_in_date_time`, `check_out_date_time`, `hotel_id`, `hotel_name`, `rooms[] { code, meal_plan_code, meal_plan_description, description, bed_type_description, holder_first_name, holder_last_name, adults, minor_ages[] }`. **(sin verificar)** `download_voucher_url` en cada item.

Ruta: `POST /book` → `reservationId` → `GET /reservations?reservation_id=…` → `product.product_id` y `product.transaction_id`.

### Cancelación (tres pasos obligatorios, en orden)

1. `GET /reservations/{productId}/cancels/allowance` → `product_allowance { allowance (ALLOWED|DISALLOWED|UNKNOWN), disallowed_reason (ALREADY_CANCELLED, CANCEL_IN_PROCESS, AFTERSALE_NOT_ALLOWED, INVALID_MINIMUM_HOURS, CHANGE_IN_PROGRESS…), refund_policy (TOTAL_REFUND|WITH_PENALTY|TAX_ONLY|NO_REFUND), policy (BY_POLICIES), expiration_date_time }`.
2. `POST /reservations/cancels/quote` body `{ transaction_id, quote_type: "BY_POLICIES" }` → `allowance_info.quote.product_quote { quote_id, refund_policy, resolution (MANUAL|AUTOMATIC), guaranteed, status (QUOTING|QUOTED), price_box { payment_methods[], refunds[] { refund_method_price_box { payment_amount, applied_penalty, refund_amount } } } }`.
3. `POST /reservations/{productId}/cancels` body `{ reason }` (`ILLNESS`, `FAMILY_OR_WORK_PROBLEM`, `TRAVEL_ANOTHER_DESTINATION`, `NATURAL_DISASTER`, `WRONG_PURCHASE_DATA`, `DUPLICATE_RESERVATION`, `CHANGE_PROBLEM`, `CREDIT_CARD_PROBLEM`, `HOTEL_PROBLEM`, `DEATH`, `OTHER`). Respuesta `{ flow_id, product_id, product_type }`; un `flow_id` `CAN-…` = cancelada. Irreversible. Esperar ≥ 60 s después de confirmar antes de cancelar. Sin cancelación parcial: un multi-habitación se cancela entero.

### Pedidos especiales

- `GET /special-requests/catalog?product_type=HOTEL&product_id=…` → `items[] { code, description, requires_value }` (p. ej. `CRADLE`, `LATE_CHECK_IN`).
- `POST /reservations/{productId}/specials-requests` body `{ product_type: "HOTEL", code, value? }` → `{ flow_id, product_id, product_type }`.

## Contenido estático

- `GET /content-api/hotels-inventory` (`city_id`, `product`, `last_modified_date`, `limit`, `offset`): `id`, `hotel_name`, `stars`, `location { city.id, address, zipcode, latitude, longitude }`, `merged_ids[]`, `published`, `last_modified_date`. La FAQ dice que no pagina; la spec sí: verificar.
- `GET /content-api/hotels?ids=…&language=ES` (máx. 100): `name`, `location`, `checkin { from, to }`, `checkout { to }`, `information`, `notices`, `categorized_notices`, `main_picture`, `pictures[]`, `amenities[]`, `room_types[]`, `fees[]`, `special_requests[]`, `stars`, `rating`.
- `GET /content-api/hotels/meal-plans` → `[{ id, description { es, en, pt }, sub_categories[] }]` (p. ej. `B`, `BRA`, `BRB`). Los códigos v3 difieren de la API anterior.
- `GET /content-api/hotels/fee-types` → `[{ id, description { es, en, pt } }]`.
- `GET /content-api/hotels/amenities` → `[{ id, description, amenity_category }]`.

## Certificación (checklist de HotelDO)

1. Logs de reserva y cancelación + vouchers en sandbox para: 1 hab. 1 adulto; 1 hab. 2 adultos + niño de 7; 2 hab. de 2 adultos; 2 hab. (1 adulto + niño de 3) y (2 adultos + niño de 1).
2. Edades de menores enviadas en la búsqueda (0–17).
3. Búsquedas de hasta 100 hoteles.
4. Nombres sólo con letras.
5. Mostrar hotel, tipo de habitación, camas y régimen en resultados.
6. Mostrar el desglose de cargos en destino y los avisos en el flujo de reserva.
7. Mostrar las políticas de cancelación y cómo se calculan.
8. Declarar el tipo de pago (cuenta corriente y/o tarjeta) con logs de cada uno; PCI para tarjeta.
9. Declarar el origen del contenido estático y mapear hoteles, regímenes, tipos de cargo y amenities.
10. Un huésped principal por habitación.
11. Manejo de errores del Book, mapeado a los códigos de HotelDO.
12. Respetar `binding_public_rate_*` (precio mínimo de venta).
13. Reservas con comisión en distintos valores entre `min_amount` y `max_amount` (logs).
14. Flujo completo con `include` `HINTS` y `EXCHANGE_POLICIES` en el prebook.
15. Voucher con: fecha de reserva, número HotelDO (`platform_id`), habitación, régimen, ocupación, huésped, fechas, titular, política de cancelación, cargos en destino y avisos.
16. Post-venta validada contra `/reservations`.
