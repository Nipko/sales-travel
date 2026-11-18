# Despegar / HotelDO — estado de la integración, decisiones y pendientes

> Auditoría del 2026-11-18 contra la API v3 (`01-api-v3-referencia.md`) y trabajo hecho a partir de
> ella. Lo que sigue abierto está al final, separado entre lo que depende del founder, de Despegar o
> de probar en el sandbox.

## 1. Dónde estábamos

- Búsqueda y detalle funcionaban (ACL `providers/despegar-hotels`, envoltorio neutral en
  `apps/api/src/providers-despegar`).
- **La web no podía reservar Despegar**: el checkout usa la saga con órdenes, y Despegar sólo tenía
  las rutas viejas con sus DTOs (`POST /hotels/prebook` con `choiceId`, `POST /hotels/book` con
  `prebookId`), sin orden, sin cartera ni voucher.
- El pago a cuenta corriente estaba bloqueado (sólo `ONE_CARD` con token, que exige PCI).
- `group_plans` se leía como texto: el `plan_id` que salía al Book era incorrecto.
- La cancelación iba directo a `POST /reservations/{id}/cancels` con el `reservationId`, sin la
  habilitación ni la cotización que Despegar exige, y sobre el id equivocado (es el `product_id`).
- Sin post-venta (`/reservations`), sin precio mínimo de venta, sin avisos del hotel ni desglose de
  cargos en destino, sin catálogo de regímenes, sin formulario para cargar la cuenta en el panel.
- El filtro de errores y el mensaje de `DespegarApiError` llevaban hasta 300 caracteres del cuerpo de
  Despegar al log (nombres, email, documentos).

## 2. Qué se hizo

### ACL (`providers/despegar-hotels`)

| Tema               | Cambio                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medios de pago     | `group_plans[].plans[]` con `id`, tipo, precio, cuotas, marca y condiciones del diferido. `CURRENT_ACCOUNT` sin plan.                                                                                                                                   |
| Book               | Cuerpo por forma de pago: cuenta corriente (`payment_units: [{type}]` + facturas), diferido (plan, sin facturas), tarjeta (plan + token + facturas). `neighbourhood` como lo escribe Despegar. Lee `plataform_id` (sic).                                |
| Post-venta         | `findReservations` / `findHotelReservation` (`GET /reservations`): `product_id`, `transaction_id`, estado `IN_PROCESS/ISSUED/CANCELLED`, PNR del hotel, voucher si viene.                                                                               |
| Cancelación        | Tres pasos: `previewCancellation` (habilitación + cotización) y `cancelReservation` (los tres, sobre el `product_id`). Si no está permitido, `DespegarCancelNotAllowedError` sin tocar nada.                                                            |
| Comisión           | `updateCommission` (`PUT /commissions/update`).                                                                                                                                                                                                         |
| Salto de precio    | `getPriceJump` (`GET /book/{id}/recovery`); el PATCH admite `WAITING_PAYMENT_SELECTION` con cuenta corriente.                                                                                                                                           |
| Pedidos especiales | Catálogo y alta (`/special-requests/catalog`, `/reservations/{id}/specials-requests`).                                                                                                                                                                  |
| Contenido          | `getHotelsContent`, `getMealPlans`, `getFeeTypes`, `getAmenities`.                                                                                                                                                                                      |
| Tarifas            | `binding_public_rate_*` → `minimumSellingPrice`; `charge_at_destination_detail`, `taxes_at_destination`, `promo`; avisos del hotel (`categorized_notices`) en el detalle; el detalle descarta roompacks sin `room_type_id` (recomendación de Despegar). |
| Prebook            | `extended_info` (`EXCHANGE_POLICIES`, `HINTS`).                                                                                                                                                                                                         |
| HTTP               | Sin `console.warn`; `PUT`; error sin cuerpo en el `message` (sólo el `code` de Despegar); gancho `onExchange` para la bóveda de payloads.                                                                                                               |
| Redactor           | `redactDespegarPayload` para exportar los RQ/RS de `live` sin datos personales.                                                                                                                                                                         |

### API

- **Despegar en la saga con órdenes** (`despegar-hotel-context.adapter.ts`), sólo con una cuenta de la
  bóveda (la clave de plataforma no tiene cuenta a la que atar la orden):
  - el detalle deja contexto en el servidor; lo que Despegar necesita reenviar (`choice_id`, estadía,
    numeración de habitaciones y luego el `prebook_id`) viaja en `providerData`, que nunca llega al
    navegador;
  - el PreBook vuelve a pedir el detalle de ESA tarifa (token fresco, políticas vigentes), abre el
    prebook y compara C1/C2; los avisos del hotel llegan al checkout como condiciones de la tarifa;
  - el Book sale a cuenta corriente con la factura de la cuenta y nuestra referencia (`SDT…`/`SDL…`),
    que se puede leer con `GET /book/{ref}` si la respuesta se corta;
  - `ERROR` = no reservó; red, timeout, 5xx o 409 = incierto, se verifica leyendo.
- Pago "al crédito de la cuenta" en el envoltorio: `CURRENT_ACCOUNT` (por defecto) o `DEFERRED`.
- Lectura de reservas desde `/reservations` (estado real, incluida la cancelada, y PNR del hotel);
  lectura por nuestra referencia; conciliación diaria por fecha de compra.
- Cancelación con el reembolso que cotizó Despegar; resolución `MANUAL` queda "en curso".
- Capacidades: `retrieveByClientReference` y `reconcileByDate` en `true`.
- Entorno de la cuenta por su URL (`live` sólo con `api.despegar.com`): la web avisa las de prueba.
- Bóveda de payloads: prebook, comisión, pagos, book, recovery, `/reservations` y cancelación se
  guardan siempre (son los "logs" que pide la certificación); búsquedas sólo si fallan.
- Rutas nuevas: `GET /hotels/reservations/:id/cancel-quote`, `GET /hotels/reservations/:id/recovery`,
  `POST /hotels/commission`, `GET|POST /hotels/reservations/:id/special-requests`.
- Errores: cada código de HotelDO (`PRODUCT_GONE`, `INVALID_PREBOOK_ID`, `NOT_ENOUGH_BALANCE`…) con
  su mensaje; 429; cancelación no permitida → 409; reserva aún no visible en post-venta → 404. El log
  ya no lleva el cuerpo.
- Validación: nombres sólo con letras y espacios (certificación, punto 4); pago por forma.
- Régimen desde el catálogo `/meal-plans` (cacheado un día): régimen canónico y etiqueta oficial.

### Web

- Formulario de la cuenta de Despegar en el panel (API key, entorno, forma de pago, datos fiscales).
- Despegar cuenta como proveedor que retiene cartera (`PROVIDERS_WITH_WALLET_HOLD`).

### Herramientas

- `sync-hotel-inventory`: recorre páginas si la respuesta viene paginada, omite hoteles no
  publicados y se niega a vaciar el catálogo si Despegar devuelve una lista vacía.

## 3. Decisiones tomadas por defecto (revisar)

1. **Forma de pago por defecto: cuenta corriente.** `paymentType` de la cuenta puede pasarla a
   diferido. Tarjeta sólo por la ruta directa y con token (exige certificado PCI de Despegar/Koin).
2. **Factura a nombre de la agencia titular de la cuenta**, cargada en la cuenta (cifrada). Sin esos
   datos, una reserva a cuenta corriente falla antes de salir, con mensaje claro.
3. **Precio mínimo**: si el waterfall queda por debajo de `binding_public_rate_value`, el precio de
   venta sube al mínimo (lo hace `hotel-pricing.ts` con `minimumSellingPrice`).
4. **Cancelación siempre en tres pasos**, mostrando el reembolso cotizado.
5. **Con la clave de plataforma (`DESPEGAR_API_KEY`) se busca pero no se reserva por órdenes.**
6. **Roompacks sin `room_type_id`**: se descartan en el detalle (desde donde se reserva), no en el
   listado, para no cambiar lo que ve el vendedor al buscar.

## 4. Pendientes

### Del founder

- Confirmar las decisiones de §3, en especial 1 (cuenta corriente) y 2 (datos fiscales de la agencia).
- ¿Modelo comisionable? Si la cuenta es comisionable, decidir qué comisión fijar entre el mínimo y el
  máximo del prebook (`POST /hotels/commission` ya existe; falta decidir quién la elige y conectarla
  al checkout con órdenes).
- Origen del contenido estático para la certificación (punto 9): HotelDO o el nuestro.
- Voucher: el de HotelDO (`download_voucher_url`) o uno propio con los campos del punto 15.

### De Despegar / del sandbox

- Credenciales de sandbox para correr los 4 casos de certificación y exportar los logs desde la bóveda.
- Confirmar en el sandbox lo que la documentación deja ambiguo: `context_information` y
  `disable_sync_result` en el Book (no están documentados; hoy se mandan sólo si se piden),
  `traveler_reference_id` (`"0"` en los ejemplos: usamos la `reference` de la habitación), si
  `/reservations?reservation_id=` acepta el id como texto, si `download_voucher_url` viene en hoteles,
  y si el inventario pagina.
- Habilitar price jump y on-hold en la cuenta si se van a usar.

### Técnicos

- Mostrar en la web el desglose del salto de precio, la cotización de cancelación y los pedidos
  especiales (las rutas existen; la web todavía no las usa).
- Mapear tipos de cargo (`fee-types`) y amenities del catálogo a textos en la web: hoy el cargo en
  destino se muestra con su código (`Cargo en destino (TT)`).
- Voucher propio con los campos del punto 15 si se decide no usar el de HotelDO.
- `bcrypt` no compila en Windows ARM sin herramientas de compilación: los tests de `src/auth`
  no corren en esta máquina (no es un cambio de esta tanda).

## 5. Checklist de certificación (estado)

| #   | Punto                                            | Estado                                                                   |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | Logs + vouchers de los 4 casos                   | Listo para ejecutar (bóveda de payloads); falta sandbox                  |
| 2   | Edades de menores en la búsqueda                 | ✅ `distribution`                                                        |
| 3   | Hasta 100 hoteles por búsqueda                   | ✅ el ACL admite 100; el perfil pide 50 (recomendado)                    |
| 4   | Nombres sólo letras                              | ✅ validado en las dos rutas                                             |
| 5   | Hotel, habitación, camas y régimen               | ✅ (régimen desde el catálogo en el detalle)                             |
| 6   | Cargos en destino y avisos                       | ✅ desglose por código; avisos como condiciones en el checkout           |
| 7   | Políticas de cancelación                         | ✅ tramos + cotización antes de cancelar                                 |
| 8   | Tipo de pago declarado                           | ✅ cuenta corriente (tarjeta requiere PCI)                               |
| 9   | Contenido estático                               | ◐ ACL listo; falta decidir origen y mapear fee-types/amenities en la web |
| 10  | Un pasajero por habitación                       | ✅                                                                       |
| 11  | Errores mapeados                                 | ✅ `DESPEGAR_CODE_MESSAGES`                                              |
| 12  | Precio mínimo (`binding_public_rate`)            | ✅ piso del waterfall                                                    |
| 13  | Comisión entre mínimo y máximo                   | ◐ ruta lista; falta la decisión de modelo                                |
| 14  | Flujo completo con `HINTS` y `EXCHANGE_POLICIES` | ✅ el prebook los pide                                                   |
| 15  | Voucher con todos los campos                     | ◐ decidir HotelDO o propio                                               |
| 16  | Post-venta contra `/reservations`                | ✅                                                                       |
