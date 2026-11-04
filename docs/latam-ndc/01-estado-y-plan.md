# LATAM NDC: estado del carril, huecos y plan

> Fecha: 2026-11-04. Alcance: `providers/latam-ndc` (la capa anticorrupción, ACL), su cableado en `apps/api` y lo que ve `apps/web-b2b`.
> Estado: **contrastado con la documentación oficial del portal de LATAM** (§1). Falta la prueba contra el sandbox (§5) y acordar el plan (§7).

## 0. Resumen

1. Hay código para 10 operaciones NDC: búsqueda, revalidación de precio, crear reserva, consultar, cancelar, pagar o emitir, servicios y recotización. **El paquete no tiene ni un test** y nunca se había probado contra respuestas reales.
2. Pasé los **ejemplos oficiales de respuesta** del portal por nuestros mappers reales. La forma general encaja: el ida y vuelta llega en una sola oferta y el total cubre a todos los pasajeros. **Pero el ACL lee mal datos que el vendedor y el cliente ven:**
   - las horas, que se guardan en UTC sin serlo;
   - si la tarifa permite cambios;
   - la clase de reserva;
   - los impuestos después de revalidar;
   - el localizador, los tiquetes y el estado de la orden.
3. **Después de pagar, la orden queda con estado `CLOSED` y no `ticketed`.** La API guarda tal cual el estado de LATAM (`apps/api/src/orders/orders.service.ts:2914`). Para la pantalla, una orden emitida sigue sin emitir: ofrece cancelar y esconde servicios.
4. La revalidación **no falla si LATAM responde con error**: deja pasar la oferta original como «confirmada».
5. **El pago tiene salida sin tocar la tarjeta.** LATAM ofrece un **enlace de pago** que le llega al pagador por correo. Con eso salimos de la deuda PCI (hoy el número y el CVV pasan por nuestro servidor).
6. Faltan funciones: reembolso, VOID de tiquete emitido, cambio (exchange), asientos, compra de servicios, multidestino, notificaciones de cambios de LATAM, datos fiscales y la reforma tributaria de Brasil.
7. Plan propuesto: P0 son correcciones confirmadas más evidencia de sandbox (≈5–7 d); P1 es mapeo y ciclo de la reserva sin pago (≈4–5 d); P2 es pago y postventa (≈8–11 d); P3 son extras.

---

## 1. Fuentes

| Fuente                                                                                                                                                                                                                                                                                                                                                                                                                  | Qué es                                                                                                                                          | Cómo se usó                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portal oficial LATAM** `latamxp-sandboxdirectconnect.apigee.io` (sesión de `integrations@planetour.com.co`)                                                                                                                                                                                                                                                                                                           | Guía por operación, ejemplos de request y response, códigos de error, avisos y FAQ. Unas 50 páginas bajo `/ndc/*`                               | Descargué el texto a un archivo **fuera del repo** (scratchpad de la sesión). Es documentación de socio y el repo es público, así que aquí solo se citan rutas y se resume. |
| `/ndc/air-shopping-v2`, `/ndc/price-offer-v2`, `/ndc/order-create`, `/ndc/order-retrieve`, `/ndc/order-change-pay-later`, `/ndc/order-cancel`, `/ndc/order-void`, `/ndc/calculate-refund`, `/ndc/order-reshop`, `/ndc/payment-link-page`, `/ndc/order-payment-link-generation`, `/ndc/bnpl`, `/ndc/change-booking`, `/ndc/order-tickets-unused`, `/ndc/headers`, `/ndc/status`, `/ndc/announcements`, `/faqs`, `/tools` | Páginas citadas en este documento                                                                                                               | Se citan como `[portal:/ruta]`.                                                                                                                                             |
| Especificación OpenAPI del portal (`/apis` → «download spec»)                                                                                                                                                                                                                                                                                                                                                           | Swagger 2.0 con 5 rutas y sin esquemas                                                                                                          | No sirve como contrato. La referencia real son las guías.                                                                                                                   |
| `API_LATAM_V2.json` (raíz del repo)                                                                                                                                                                                                                                                                                                                                                                                     | Colección Postman de 20 requests                                                                                                                | Solo requests, ninguna respuesta.                                                                                                                                           |
| Colección Postman oficial nueva                                                                                                                                                                                                                                                                                                                                                                                         | `[portal:/ndc/postman]` enlaza una colección rehecha con flujos de 1 a 6 pasajeros, equipaje, asientos, exchange, refund, void y pago posterior | No la importé. Probablemente es la de 160 requests que citan `docs/sabre/00-fuentes.md:24` y `docs/tbo/00-fuentes.md:164`.                                                  |
| Código                                                                                                                                                                                                                                                                                                                                                                                                                  | `main` en `694288b`                                                                                                                             | Citado como `archivo:línea`.                                                                                                                                                |

**Cómo se comprobó:**

1. **Tests de la API:** 7 archivos y 210 tests en verde. Usan adaptadores stub, no el XML real.
2. **Respuestas oficiales pasadas por el código real:** los ejemplos de AirShoppingRS (2 adultos, 1 niño y 1 infante, ida y vuelta SCL–MIA), OfferPriceRS y OrderViewRS (pagada y sin pagar), parseados con la misma configuración de `fast-xml-parser` que `providers/latam-ndc/src/http/latam-http.client.ts:105-111`. Los resultados marcados con ✔︎ en §3 y §4 salen de aquí.
3. **Sandbox: pendiente.** Leer el VPS de producción quedó bloqueado por permisos (§5).

---

## 2. Estado por operación

Leyenda: ✅ hecho · 🟡 parcial o con errores · ❌ falta.

| Operación (endpoint `[portal]`)                                                                               | Código                                                  | Estado       | Notas                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token `/oauth/cc/token`                                                                                       | `auth/token.service.ts:250-307`                         | ✅           | El token dura 59 minutos (`[portal:/ndc/headers]`); refrescamos 60 s antes. Un 401 no fuerza el refresco.                                                                                                                                                                                         |
| AirShopping `/ndc/v192/airshopping` (v2)                                                                      | `latam-flight-search.adapter.ts:72-94`, `airshopping/*` | 🟡           | La forma encaja. Errores de mapeo en §4: H-03, H-04, M-01 a M-05. **Multidestino y open jaw están disponibles desde 17/10/2025** (`[portal:/ndc/multicity]`); nosotros solo armamos solo ida o ida y vuelta (`airshopping/request.builder.ts:328-362`).                                           |
| OfferPrice `/ndc/v192/offerPrice`                                                                             | `adapter.ts:96-122`, `offerprice/*`                     | 🟡           | Con varios pasajeros es **obligatoria** para tener el precio final (`[portal:/ndc/order-create]`, Advice). Problemas: H-03 y M-06. Trae multas con monto (`PenaltyList`) que no leemos.                                                                                                           |
| Asientos `/ndc/v192/seats/availability`                                                                       | —                                                       | ❌           | La API rechaza el mapa de asientos para LATAM (`apps/api/src/search/search.service.ts:589-595`). El asiento se manda en `SelectedOfferItem/SelectedSeat` del OrderCreate.                                                                                                                         |
| ServiceList `/ndc/v192/services/list`                                                                         | `adapter.ts:183-190`, `servicelist/*`                   | 🟡           | Solo lectura y solo equipaje (`apps/api/src/orders/orders.service.ts:2641-2652`). Comprar equipaje en la reserva va en `SelectedBundleServices`; después de emitir, por OrderChange.                                                                                                              |
| Reservar sin pago (BNPL) `/ndc/v192/order/create`                                                             | `adapter.ts:124-139`, `ordercreate/*`                   | 🟡           | Es el flujo que usamos: la UI no manda pago (`apps/web-b2b/src/app/(app)/cotizaciones/[id]/page.tsx:349`). Faltan el plazo de pago (H-07), la aceptación de un cambio de precio con Change Booking (H-08) y `POS/City` (M-09).                                                                    |
| Reservar con pago `/ndc/v192/order/create/payment`                                                            | —                                                       | ❌           | Endpoint aparte. No lo usamos.                                                                                                                                                                                                                                                                    |
| Consultar `/ndc/v192/order/retrieve`                                                                          | `adapter.ts:141-148`, `ordermanage/*`                   | 🟡           | H-05: localizador, tiquetes y estado mal leídos.                                                                                                                                                                                                                                                  |
| Pagar después `/ndc/v192/order/change/payment`                                                                | `adapter.ts:168-181`, `orderchange/*`                   | 🟡           | Funciona con tarjeta, efectivo o GOV. **Envía el número y el CVV de la tarjeta por nuestro servidor** (`ordercreate/request.builder.ts:202-257`, `orderchange/request.builder.ts:78-121`). H-02 y H-05.                                                                                           |
| **Enlace de pago** `/ndc/v192/order/change/send/payment/link`                                                 | —                                                       | ❌           | LATAM le manda al pagador un enlace para pagar en su sitio (`[portal:/ndc/payment-link-page]`). **Es la salida PCI SAQ-A** (§7, P2-0).                                                                                                                                                            |
| Cancelar una reserva sin pago `/ndc/v192/order/cancel/bnpl`                                                   | `adapter.ts:159-166`                                    | 🟡 muerto    | Nadie lo llama. Para cancelar una reserva sin pago la API usa `cancelOrder`, que va a `/order/cancel` con el cuerpo de VOID (H-06).                                                                                                                                                               |
| VOID `/ndc/v192/order/cancel` (sin monto)                                                                     | `adapter.ts:150-157`                                    | 🟡           | El cuerpo coincide con `[portal:/ndc/order-void]`, pero solo se usa antes de emitir. No hay VOID de un tiquete emitido (la API lo bloquea: `apps/api/src/orders/order-capabilities.service.ts:44-54`). Existe una validación previa del VOID (`[portal:/ndc/validate-void]`).                     |
| Reembolso: calcular `/order/reshop` y cancelar `/order/cancel` con `ExpectedRefundAmount`                     | —                                                       | ❌           | `[portal:/ndc/calculate-refund]`, `[portal:/ndc/order-cancel]`: el monto que devuelve la recotización es obligatorio para cancelar.                                                                                                                                                               |
| Cambio (exchange): `/order/reshop`, `/order/reshop/offerprice` y `/order/change/payment`                      | —                                                       | ❌           | `[portal:/ndc/post-booking-page]`, `[portal:/ndc/order-reshop]`, `[portal:/ndc/order-offer-price-exchange]`.                                                                                                                                                                                      |
| Change Booking `/ndc/v192/order/change/booking`                                                               | —                                                       | ❌           | Acepta el nuevo precio cuando LATAM recotiza al crear la reserva (`[portal:/ndc/change-booking]`).                                                                                                                                                                                                |
| Tiquetes sin usar `/ndc/v192/order/requote`                                                                   | `adapter.ts:192-202`                                    | 🟡 mal usado | Sirve para aplicar el crédito de **tiquetes sin usar de otra orden pagada** a una reserva sin pago (`[portal:/ndc/order-tickets-unused]`). La UI lo ofrece como «Repricing» de una orden emitida y manda el mismo PNR en los dos campos (`apps/web-b2b/src/app/(app)/reservas/page.tsx:603-608`). |
| Viajero frecuente después de emitir `/order/passenger`                                                        | —                                                       | ❌           | Al crear la reserva sí se envía (`ordercreate/request.builder.ts:126-128`).                                                                                                                                                                                                                       |
| Cambios involuntarios, Split PNR, notificaciones de cambio (webhook), auditoría de la orden (`/orders/audit`) | —                                                       | ❌           | `[portal:/ndc/announcements]`, `[portal:/ndc/orderchangenotif]`, `[portal:/ndc/order-audit]`. Las notificaciones son push de LATAM hacia nosotros cuando la aerolínea cambia un vuelo.                                                                                                            |
| Datos fiscales `/order/tax/info`; reforma tributaria de Brasil                                                | —                                                       | ❌           | `[portal:/ndc/billing-information-page]`, `[portal:/ndc/brazil-tax-reform-page]`. Con punto de venta BR exige datos del receptor fiscal al pagar.                                                                                                                                                 |
| Listado de órdenes y reportes de tiquetes y cupones                                                           | —                                                       | ❌           | Sirven para conciliación.                                                                                                                                                                                                                                                                         |

Capacidades declaradas (`apps/api/src/providers-latam/latam-ndc.factory.ts:52-58`): `retrieve`, `cancel`, `pay`, `services`, `reshop`. LATAM **no implementa `resolveForOrder`**, así que la postventa usa la cuenta **actual** del tenant (`apps/api/src/providers/flight-provider.registry.ts:194`, `:240-242`).

---

## 3. Hallazgos que bloquean o falsean la venta

**H-01 · Después de pagar, la orden queda en `CLOSED` y no en `ticketed`.** ✔︎

- Qué devuelve LATAM: `OPENED` (sin pagar), `FROZEN` (pago rechazado) y `CLOSED` (pagada y emitida) (`[portal:/ndc/order-create]`, tabla StatusCode).
- Qué hacemos con eso:
  - `orderchange/response.mapper.ts:34-42` solo traduce cadenas que contienen «confirmed», «ticketed», «cancel» o «pending». Los tres estados reales pasan tal cual.
  - `apps/api/src/orders/orders.service.ts:2914` guarda ese valor en `orders.status`. No hay CHECK en la base (`db/migrations/0005_orders.sql:12`).
- Efecto: una orden emitida de LATAM queda con `status = 'CLOSED'`.
  - Toda la app compara contra `'ticketed'` (`order-capabilities.service.ts:45`, `orders.controller.ts:437`, `order-confirmation.service.ts:89`).
  - El resultado: se sigue ofreciendo «Cancelar», no aparecen «Servicios» ni el resto de la postventa, y el correo no dice «emitido».

**H-02 · Los tiquetes y el localizador real no se leen.** ✔︎

- Los números de tiquete viajan en `Response/TicketDocInfo/.../TicketNumber`, **al lado** de `Order` y no dentro. `ordermanage/response.mappers.ts:113-118` los busca dentro de `Order`.
- Con el ejemplo oficial de una orden pagada: `ticketNumbers` sale vacío.
- `pnr` queda con el `OrderID` (`LA0455440NHBO`). El localizador de 6 letras está en `Order/BookingRef/BookingID` (`NEIILB` en el ejemplo).
- Pasa lo mismo con la respuesta del pago, que trae los 3 tiquetes emitidos y no los leemos.

**H-03 · Una revalidación con error pasa como confirmada.** ✔︎

- `offerprice/response.mapper.ts:135-147` devuelve la oferta original con `priceChanged: false`.
- `apps/api/src/orders/orders.service.ts:898-925` solo mira precio, familia y vigencia, y deja reservar.
- LATAM documenta errores propios de OfferPrice: 400116010 «número de ítems distinto» y 409116001 «oferta de contingencia».
- Viola el principio 9 de `CLAUDE.md`, «fail loud».

**H-04 · Un error en AirShopping cuenta como «0 vuelos».**

- `latam-flight-search.adapter.ts:86-93` devuelve `[]`.
- LATAM documenta códigos concretos en `[portal:/ndc/air-shopping-v2]`, sección Error Handling, por ejemplo:
  - 400122006 «fecha pasada»;
  - 400122004 «más de 330 días»;
  - 404122006 y 404122007 «ruta no operada».
- Puede mandar **varios `<Error>`**; el mapper lee uno solo (`airshopping/response.mapper.ts:48`).
- El error 914 es transitorio y LATAM pide reintentar 1 o 2 veces (`[portal:/ndc/status]`).

**H-05 · El estado de la orden se lee mal también al consultar.** ✔︎ `ordermanage/response.mappers.ts:120-128` deja `CLOSED`, `OPENED` y `FROZEN` sin traducir. Mismo origen que H-01.

**H-06 · Una reserva sin pago se cancela por el endpoint equivocado.** La guía del flujo BNPL manda usar `/order/cancel/bnpl` (`[portal:/ndc/bnpl]`). La API llama `cancelOrder`, que es el VOID de `/order/cancel` (`latam-flight-search.adapter.ts:150-157`). Hay que confirmarlo en el sandbox.

**H-07 · El plazo para pagar no se muestra.**

- LATAM informa `PaymentTimeLimitDateTime` dentro del `OrderItem`, en UTC; puede tardar unos 20 minutos en aparecer (`[portal:/ndc/order-retrieve]`).
- No lo leemos ni al crear ni al consultar. La UI ya sabe pintarlo desde `provider.raw.paymentTimeLimitDateTime` (`apps/web-b2b/src/lib/ticketing-deadline.ts:7,40`).
- La reserva vence sin aviso.

**H-08 · Si LATAM cambia el precio al crear la reserva, no lo manejamos.** Ante un aviso de recotización hay que aceptarlo con Change Booking (`[portal:/ndc/bnpl]`, `[portal:/ndc/change-booking]`). Hoy no se lee el aviso.

### Hallazgos de la v1 de este documento que la documentación oficial descarta

- **«Cada ítem lleva a todos los pasajeros» no es un error.** En LATAM cada `OfferItem` es un **trayecto** y lleva a todos los pasajeros. Lo que viene por tipo de pasajero es el `FareDetail`. Los ejemplos oficiales de OfferPrice y OrderCreate mandan todos los `PaxRefID` en cada `SelectedOfferItem` (`[portal:/ndc/price-offer-v2]`, `[portal:/ndc/order-create]`). Nuestro builder coincide.
- **El `|` del `offerRef` no rompe.** El `OfferID` es un UUID; los `|` están en los `OfferItemID`. `parseOfferRef` corta por el primer `|`, que es el nuestro, y separa los ítems por coma, que no aparece en esos ids. Funciona, aunque es frágil: conviene moverlo a `provider.raw` (P1).
- **El infante no necesita asociarse a un adulto.** Ningún ejemplo de LATAM lo hace. Tampoco documentan un infante con asiento propio.

---

## 4. Huecos de mapeo al canónico

✔︎ = verificado con las respuestas oficiales de ejemplo.

| Id       | Campo canónico                         | Qué hacemos                                                                                                                                                                                                                                  | Qué manda LATAM                                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-01 ✔︎ | `Segment.departureAt/arrivalAt`        | Hora local con `Z` agregada (`airshopping/response.mapper.ts:611-613`, `:634-637`): **08:15 de Lima sale como 08:15 UTC**.                                                                                                                   | El offset viene en el atributo `TimeZoneCode="-05:00"` de `AircraftScheduledDateTime`. Hay que usarlo.                                                                                                                                                                                                                                                             |
| M-02 ✔︎ | `Policies.changeable/refundable`       | `ChangeRestrictions` llega como **lista por pasajero** y el código lo lee como objeto (`:577-588`). Resultado: **`changeable: false` en una tarifa LIGHT que sí permite cambios**.                                                           | Lista por `PaxRefID` con `AllowedModificationInd`. Las multas vienen en `DataLists/PenaltyList`: en búsqueda solo el indicador; en OfferPrice con monto (`CLP 215510`) o porcentaje (`PERCENT 100`), ligadas por `FareComponent/FareRule/PenaltyRefID`.                                                                                                            |
| M-03 ✔︎ | `Segment.bookingClass`                 | Fija en `'Y'` (`:391`).                                                                                                                                                                                                                      | `FareDetail/FareComponent/RBD/RBD_Code` (Q en el ejemplo). La base tarifaria está en `FareBasisCode` y también dentro del `PaxSegmentID` (`SEG_ORIG_DEST_VUELO_CABINA_BASE_FECHA`, `[portal:/faqs]`).                                                                                                                                                              |
| M-04     | `fareComponents` por trayecto          | No se llena; `fareFamily` toma la primera marca (`:508-530`).                                                                                                                                                                                | Cada `OfferItem` es un trayecto con su `FareRefText` (LIGHT, STANDARD…), su `PriceClassRefID` y su RBD. Los atributos de marca premium llegan como `BRAND_INCLUDED_*` en `ServiceDefinitionList`. **Coordinar con la sesión de tarifas por trayecto.**                                                                                                             |
| M-05 ✔︎ | `fareBreakdown`                        | No se llena.                                                                                                                                                                                                                                 | `FareDetail` por grupo de pasajeros con su precio. Comprobado: la suma de precio por pasajero × cantidad da exactamente el total de la oferta.                                                                                                                                                                                                                     |
| M-06 ✔︎ | `taxes` después de OfferPrice          | Busca `TaxSummary/TotalTaxAmount` (`offerprice/response.mapper.ts:177-178`). El ejemplo trae `Tax/Amount`, así que **se quedan los impuestos de la búsqueda** mientras el total y la base sí cambian: base + impuestos deja de dar el total. | Sumar `Tax/Amount` o calcular total − base.                                                                                                                                                                                                                                                                                                                        |
| M-07     | `Segment.operatingCarrier`, `aircraft` | No se mapean.                                                                                                                                                                                                                                | `OperatingCarrierInfo` y `DatedOperatingLeg/CarrierAircraftType`, este último solo cuando el vuelo hace escala.                                                                                                                                                                                                                                                    |
| M-08     | `baggage`                              | Máximo a nivel oferta. Lo que no es `Checked` se trata como de mano (`:489-491`).                                                                                                                                                            | `PERSONAL_ITEM_*` y `CARRY_ON_*` llegan ambos como `TypeCode=CarryOn`; se distinguen por el id. Trae `DescText` en el idioma del header.                                                                                                                                                                                                                           |
| M-09     | `POS/City` en OrderCreate              | No se envía.                                                                                                                                                                                                                                 | La tabla de campos de `[portal:/ndc/order-create]` lo marca como obligatorio.                                                                                                                                                                                                                                                                                      |
| M-10     | Moneda por defecto                     | `USD` cuando falta `CurCode` (`airshopping/response.mapper.ts:147,151`).                                                                                                                                                                     | Siempre trae `CurCode`. Si falta, debería ser error.                                                                                                                                                                                                                                                                                                               |
| M-11     | Datos inventados en OrderCreate        | Valores fijos: `IssueDate 2020-01-01`, calle «Calle 1», código postal 110001, área 1, «Mrs» (`ordercreate/request.builder.ts:83-84,136,156,178-179`).                                                                                        | `IssueDate`, `ExpiryDate`, `GenderCode`, `TitleName` y los códigos de área y país del teléfono son **opcionales** en el caso base: se pueden **omitir**, no hace falta inventarlos. `IN` es un tipo de documento válido (enum P, I, A, C, F, M, N, T, V, IN). Ojo: la variante con equipaje marca `IssueDate` como obligatorio. Hay que confirmarlo en el sandbox. |
| M-12     | Headers                                | `X-latam-Application-Name` = nombre de la agencia; `X-latam-Lang: EN` fijo; el mismo `Track-Id` para todo el flujo (`http/latam-http.client.ts:155-169`).                                                                                    | Application-Name es el nombre de **la app creada en el portal**; el idioma depende del país (CL/PE → ES, BR → PT); el Track-Id es **único por request** (`[portal:/ndc/headers]`).                                                                                                                                                                                 |

---

## 5. Prueba en el sandbox (pendiente de tu decisión)

No existe un arnés LATAM; Sabre sí lo tiene (`apps/api/src/providers-sabre/cert-run/`). Propuesta, sin mover dinero:

1. AirShopping solo ida y ida y vuelta, con 1 adulto y con 2 adultos, 1 niño y 1 infante.
2. OfferPrice, ServiceList y SeatAvailability.
3. OrderCreate **sin pago** → OrderRetrieve (ver `PaymentTimeLimitDateTime`) → cancelación con `cancel/bnpl` (H-06).
4. Opcional: generar un enlace de pago a un correo nuestro, sin pagar.

Las respuestas se guardan **redactadas** como fixtures de los tests del ACL. El arnés solo acepta `sandbox.api.latam.com`.

El portal deja crear una app de desarrollo (`[portal:/tools]`). Elige una forma de correrlo:

- **(a)** Credenciales de sandbox en un `.env` local, sin commitear.
- **(b)** Autorizar el uso de las variables `LATAM_*` del VPS.
- **(c)** Un workflow manual como `sabre-cert-run.yml`.

---

## 5b. Moneda: por qué LATAM responde en BRL y no en pesos

**La documentación oficial no tiene ningún campo para pedir la moneda.** Ni AirShopping, ni OfferPrice, ni OrderCreate tienen un parámetro de moneda (`[portal:/ndc/air-shopping-v2]`, tabla de campos del request).

- **Cotiza en la moneda del punto de venta con que LATAM dio de alta la cuenta de la agencia.** El ejemplo de AirShopping lo dice así: «Insert your `<AgencyID>` configured for New Shopping flow». El `AgencyID` y el `IATA_Number` los configura LATAM por país.
- **La señal que mandamos ya es la correcta.** Pedimos COP, enviamos `X-latam-Country: CO` y `POS/Country/CountryCode = CO` (`providers/latam-ndc/src/airshopping/request.builder.ts:81-98`), y desde esta versión también `POS/City = BOG`. **Si aun así LATAM responde en BRL, la cuenta (AgencyID/IATA/app) está habilitada solo para el punto de venta BR.**
- **No se arregla en código:** hay que pedirle a LATAM que habilite el punto de venta **CO** (y PE, si aplica) para nuestro `AgencyID`, o que entregue credenciales de una agencia colombiana.
- **Cómo pedirlo:**
  - Escribir a `grp_ndcsupport@latam.com` (`[portal:/faqs]`, Contact Us).
  - Adjuntar lo que piden: país afectado (CO), Track ID, fecha y hora, interfaz (API), entorno (sandbox o producción), descripción y evidencia.
  - Desde esta versión **el Track-Id de cada llamada queda en el log** junto al aviso `currency mismatch: requested COP, LATAM returned BRL`, así que la evidencia sale directo de los logs de la API.
- **En el modelo consolidador:**
  - La moneda queda atada a la cuenta, así que cada país de la red necesita su propia cuenta LATAM (BYOC, en la bóveda) con su `country`.
  - El campo nuevo `posCity` (bóveda, `config.posCity`) permite declarar la ciudad del punto de venta; si falta, se usa el aeropuerto principal del país.
  - Mientras tanto, la plataforma ya puede **mostrar y vender en BRL para pruebas** con `tenants.foreign_currency_fares` (`db/migrations/0087_tenant_foreign_currency_fares.sql`).

## 6. Lo que la documentación oficial no responde

- Cuánto dura una reserva sin pago. La guía dice «según reglas de LATAM»; una nota de `[portal:/ndc/order-create]` menciona 15 minutos como máximo para pagar.
- Si nuestra agencia o consolidador está habilitada para efectivo o GOV (pago de agencia, sin tarjeta) y para el enlace de pago, por país.
- Requisitos para pasar a producción. El portal solo dice que hay que avisar al contacto de LATAM y firmar un contrato estándar (`[portal:/faqs]`, `[portal:/tools]`).
- La forma del `AccountCode`. La colección usa `ProgramCriteria/ProgramAccount/AccountID`; nosotros, `AccountCriteria/AccountCode` (`airshopping/request.builder.ts:255`). La respuesta lo devuelve en `FareDetail/AccountCode`.

---

## 7. Plan priorizado (propuesta para acordar)

Estimaciones en días-persona.

### Avance

**2026-11-04, P0 hecho salvo el arnés del sandbox:**

- **Tests del ACL:**
  - El paquete ahora tiene `test` (vitest) y un build que excluye los tests.
  - `providers/latam-ndc/src/mappers.test.ts` suma 26 tests sobre fixtures sintéticos con la forma oficial.
  - Además, los ejemplos oficiales se pasaron por el código, sin copiarlos al repo.
- **Corregido:** H-01, H-02, H-03, H-04, H-05, M-01, M-02, M-03, M-06, M-07, M-10 y parte de M-09, M-11 y M-12:
  - estados `OPENED`/`FROZEN`/`CLOSED`;
  - tiquetes y localizador;
  - errores lanzados como `LatamBusinessError` (reintento del 914);
  - hora con `TimeZoneCode`;
  - cambios y reembolsos por pasajero;
  - clase de reserva por trayecto;
  - impuestos de OfferPrice;
  - operador y avión;
  - sin moneda supuesta;
  - `POS/City`;
  - Track-Id por request e idioma por país;
  - plazo de pago en la lectura;
  - aviso 70K;
  - cancelación exitosa reconocida.
- **Encontrado al probar:**
  - El parser convertía los textos numéricos en números, así que el tiquete `0452…` perdía el 0 del emisor. Ahora todo se lee como texto.
  - La respuesta de cancelación no trae `Order` y se marcaba como fallida aunque LATAM la hubiera aceptado.
- **Migración `0088`:** pasa a `ticketed`/`confirmed` las órdenes LATAM que quedaron guardadas con `CLOSED`/`OPENED`/`FROZEN`.
- **Pendiente:**
  - P0-1 (arnés del sandbox), que espera tu decisión de §5.

**2026-11-04, P1 hecho salvo el aviso de recotización:**

- **P1-1 · `fareComponents` por trayecto** (`providers/latam-ndc/src/airshopping/fare-components.ts`). Cada componente lleva:
  - marca (`FareRefText`), base tarifaria, clase y cabina;
  - `includes`, que es el equipaje del trayecto asociado por `BaggageFlightAssociations`, la maleta «no incluida» si LATAM informa el equipaje y no trae facturada, cambios y reembolso (`included`/`charge`/`not-offered`) según la restricción y la multa, y los atributos premium `BRAND_INCLUDED_*`.
  - Con los ejemplos oficiales, LIGHT sale sin maleta facturada y STANDARD con ella, cada trayecto con su propia clase.
- **P1-2 · Desglose y multas:**
  - `fareBreakdown` por tipo de pasajero, que solo se publica si cuadra exactamente con el total. Con el ejemplo oficial de 2 adultos, 1 niño y 1 infante cuadra.
  - `policies.changeFee`/`refundFee` desde `PenaltyList` de OfferPrice, sin contar los porcentajes.
  - Si el precio cambia y el desglose nuevo no cuadra, el anterior se descarta.
- **P1-3 · Cancelar una reserva sin pago:** va por `/order/cancel/bnpl` (H-06), con respaldo a `/order/cancel` solo si la cuenta no tiene ese endpoint (404/405). Un error de negocio no dispara un segundo intento.
- **P1-4 · OrderCreate y cuenta:**
  - OrderCreate ya no inventa `IssueDate`, `TitleName` ni código de área.
  - `resolveForOrder`: la postventa sale con la cuenta BYOC con que se reservó. La orden guarda `provider_account_id`.
  - **Encontrado de paso:** LATAM no declaraba entorno, así que las tarifas de `sandbox.api.latam.com` se presentaban como reales. Ahora la cuenta es `test` si la URL es el sandbox o si `config.environment` es `test`/`cert`/`sandbox`.
- **Pendiente:**
  - Aceptar la recotización 70K con Change Booking. Necesita un paso en la UI de reservas: pasa a P2.
  - El desglose de OfferPrice desde `DataLists/FareList`.

### P0: correcciones confirmadas y evidencia (≈5–7 d)

| #    | Trabajo                                                                                                                                                                                                                              | Est.    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| P0-1 | Tests del ACL con fixtures construidos a partir de los ejemplos oficiales (forma, no copia) y luego de respuestas redactadas del sandbox. Arnés de §5.                                                                               | 2–3 d   |
| P0-2 | Estados `OPENED`/`FROZEN`/`CLOSED` a `confirmed`/`pending-payment`/`ticketed` en pago y consulta. Tiquetes desde `TicketDocInfo`. Localizador desde `BookingRef`. Arreglar las órdenes ya guardadas con `CLOSED` (H-01, H-02, H-05). | 1 d     |
| P0-3 | Fallar en voz alta: OfferPrice con error → error tipado; AirShopping con error → fallo de proveedor, con todos los `<Error>`, códigos humanizados y reintento del 914; consulta con error distinta de «no existe» (H-03, H-04).      | 1 d     |
| P0-4 | Hora con `TimeZoneCode`; cambios y reembolsos por pasajero; RBD y base tarifaria; impuestos de OfferPrice (M-01, M-02, M-03, M-06).                                                                                                  | 1–1.5 d |

### P1: mapeo y ciclo de la reserva sin pago (≈4–5 d)

| #    | Trabajo                                                                                                                                     | Est.  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| P1-1 | `fareComponents` por trayecto e `includes` (incluye `BRAND_INCLUDED_*`), coordinado con la sesión de tarifas por trayecto (M-04)            | 1.5 d |
| P1-2 | `fareBreakdown`, multas con monto desde `PenaltyList`, `operatingCarrier`, avión, equipaje (M-05, M-07, M-08)                               | 1 d   |
| P1-3 | Plazo de pago en `provider.raw` y en la orden (H-07); cancelación por `cancel/bnpl` (H-06); aviso de recotización con Change Booking (H-08) | 1.5 d |
| P1-4 | OrderCreate sin datos inventados, `POS/City`, headers según el portal (M-09, M-11, M-12); `offerRef` a `provider.raw`; `resolveForOrder`    | 1 d   |

### P2: pago y postventa (≈8–11 d)

| #    | Trabajo                                                                                                                                                                                                                                                                              | Est.    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| P2-0 | **Pago sin PAN.** Recomiendo el **enlace de pago de LATAM** (`/order/change/send/payment/link`) para tarjeta del cliente, más **efectivo o GOV** cuando la agencia factura a crédito. Retirar el envío de PAN y CVV. Requiere tu decisión y confirmar con LATAM qué está habilitado. | 1.5–2 d |
| P2-1 | Reembolso (recotizar y luego cancelar con `ExpectedRefundAmount`) y VOID de tiquete emitido con validación previa                                                                                                                                                                    | 2–3 d   |
| P2-2 | Cambio (exchange): recotizar, revalidar y aplicar el cambio                                                                                                                                                                                                                          | 2–3 d   |
| P2-3 | Asientos (`SeatMapPort`) y compra de equipaje en la reserva y después de emitir                                                                                                                                                                                                      | 2–3 d   |
| P2-4 | Notificaciones de cambio (webhook) y cambios involuntarios                                                                                                                                                                                                                           | 1–2 d   |

### P3: extras

- Multidestino y open jaw.
- Datos fiscales y reforma tributaria de Brasil (punto de venta BR).
- Listado de órdenes y reportes para conciliación y BSP.
- Tiquetes sin usar como función propia: retirar el botón «Repricing» actual.
- Viajero frecuente después de emitir.
- Split PNR y auditoría de la orden.
- Retirar `LATAM_FORCE_MOCK` (`.github/workflows/deploy.yml:189-197`) y la clave `mock` del spec de la bóveda (`apps/api/src/provider-credentials/provider-specs.ts:287-299`).
- Actualizar `docs/research/api-latam-v2-reference.md` §5 y §8.

---

## 8. Riesgos

| Riesgo                                                     | Impacto                                                           | Mitigación            |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| Orden emitida vista como no emitida (H-01)                 | Se puede cancelar algo ya emitido desde la UI; falta la postventa | P0-2, el primero      |
| Hora mal impresa (M-01)                                    | PDF y WhatsApp con horas corridas de 3 a 5 horas                  | P0-4                  |
| «Permite cambios: no» en tarifas que sí lo permiten (M-02) | Se pierde la venta o el cliente recibe información falsa          | P0-4                  |
| Precio confirmado falso (H-03)                             | Se cotiza un precio que LATAM ya no respeta                       | P0-3                  |
| La reserva vence sin aviso (H-07)                          | Se pierde el cupo                                                 | P1-3                  |
| PAN y CVV por nuestro servidor                             | Fuera de PCI SAQ-A                                                | P2-0 (enlace de pago) |
| Sin fixtures ni tests                                      | Regresiones silenciosas                                           | P0-1                  |
