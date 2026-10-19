# Sabre — hallazgos en el sandbox CERT

> **Estado:** primera corrida registrada (sab-12, 2026-10-19). La reserva ATPCO está bloqueada por H-01. Se llena con las corridas del arnés de certificación
> (`apps/api/src/providers-sabre/cert-run/`, SAB-11). Cómo correrlo y dónde quedan las capturas:
> [`evidence/README.md`](./evidence/README.md#arnés-de-certificación-contra-cert-sab-11).

Éste es el entregable que decide ([11 §4.3 y §4.5](./11-plan-implementacion.md#43-entregables)): los JSON son la
prueba, pero lo que cuenta es lo que aquí se concluye con su número. Los paquetes que certifican contra CERT
(SAB-12, SAB-13, SAB-21, SAB-22 y SAB-24) escriben sus hallazgos aquí, cada uno en su sección, en vez de abrir un
documento nuevo.

## Cómo se registra una corrida

1. Correr el arnés y copiar la carpeta de la corrida a `docs/sabre/evidence/cert/<AAAA-MM-DD>-<runId>/`, **después de
   revisarla**: el arnés redacta en tres capas, pero la última palabra antes de versionar es de quien la lee. Si
   `summary.json` trae `evidence.secretsScrubbed > 0`, la redacción por clave dejó pasar un secreto conocido: no se
   versiona hasta entender por qué (y se anota abajo como hallazgo).
2. Pegar en [§1](#1-corridas) la fila de la corrida y, en la sección del paquete, las filas de `summary.md`.
3. Cada diferencia contra lo que el ACL espera se anota en [§3](#3-hallazgos) con el `Conversation-ID` del paso (sale
   en `summary.md`) y se corrige con un test de regresión que usa la captura como fixture.
4. Lo que quedó sin limpiar (salida `2`) va a [§5](#5-pnr-que-quedaron-vivos) hasta que se cierre en Sabre Red.

## 1. Corridas

| Fecha             | runId                 | Build     | Escenarios                                                                           | Desenlace                                                                                 | PNR | Sin limpiar                                                | Evidencia                                                                      |
| ----------------- | --------------------- | --------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-10-19 05:34Z | `2026-10-18-sab12-01` | `016c87b` | `auth`, `shop`, `book-cancel` (sab-12) · BOG-LIM, LIM-GRU, BOG-MIA · 1ADT · +30 días | `leftovers` (salida 2): `auth` y `shop` ok, `book-cancel` falló en `createBooking` (H-01) | —   | 1 «en duda» sin localizador (§5) — casi seguro inexistente | Sin versionar todavía (ver nota). `secretsScrubbed: 0`, `callsOutsideSteps: 0` |

> **Evidencia de `2026-10-18-sab12-01`.** Revisada: redactada en las tres capas (`secretsScrubbed: 0`; el token y
> el cuerpo de `/v2/auth/token` quedan como marcadores). No está en `evidence/cert/` todavía: copiarla al repo, que es
> público, es una decisión del founder. Pesa 2,6 MB, casi todo las tres respuestas de BFM. Mientras tanto, los datos
> de esta página salen de `summary.json` y de los pasos `06-book-cancel-flightcheck.json` y
> `07-book-cancel-createbooking.json`.

## 2. Por paquete

### 2.1 SAB-12 — reserva ATPCO de punta a punta (`sab-12`: `auth`, `shop`, `book-cancel`)

| Pregunta                                                                                        | Respuesta                                                                                                                                                                                                                                                                                                                                                                | Evidencia       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| P-08 — vida real del token (`expires_in` del paso `token`)                                      | **604 800 s = 7 días.** `token_type` + `expires_in` + `access_token` (redactado). 375 ms                                                                                                                                                                                                                                                                                 | `01-auth-token` |
| P-06 — entitlements: BFM v5, Flight Check, Booking Management                                   | **Los tres responden con el PCC de CERT.** BFM v5: 200 en las tres rutas. Flight Check: 200 con oferta. `createBooking`: 200 con error de negocio, no 403. El entitlement está; lo que falló fue el request (H-01)                                                                                                                                                       | `02`–`07`       |
| P-04 — aporte en CO/PE/BR (`shop` en BOG-LIM, LIM-GRU, BOG-MIA): ofertas por carril             | **Sólo ATPCO** (NDC apagado por la cuenta, SAB-18): BOG-LIM 49, LIM-GRU 50, BOG-MIA 50 (BFM corta en 50). Más baratas: BOG-LIM USD 242,20 (JA vía MDE), LIM-GRU USD 236,74 (H2 directo, MAX FLEX), BOG-MIA USD 446,96 (LA directo, LIGHT). Marcas en el 86-100 % de las ofertas. **No mide todavía el aporte incremental**: falta la misma búsqueda en LATAM NDC directo | `02`–`04`       |
| Cómo interpreta Sabre `ticketingDate`/`ticketingTime` (zona) y qué trae `futureTicketingPolicy` | **Sin respuesta**: la reserva no se creó. Lo que se vio: Flight Check da `paymentTimeLimit` 12:34Z (7 h después de cotizar, para un vuelo a 30 días) y el plan mandó 05:34 hora de Bogotá (= 10:34Z, 2 h de margen), como se diseñó                                                                                                                                      | `06`, `07`      |
| `MANDATORY_DATA` por aerolínea al reservar                                                      | **`MANDATORY_DATA_MISSING` en `travelers[0].id`** — no es de la aerolínea, es del carril `flightOffer` con oferta de Flight Check (H-01)                                                                                                                                                                                                                                 | `07`            |
| Vuelo nocturno con cambio de día (lo que mantiene el paquete en `experimental`)                 | Sin probar: la reserva no se creó                                                                                                                                                                                                                                                                                                                                        | —               |
| Precio de Flight Check frente al de shop                                                        | **Cambió**: shop USD 242,20 → Flight Check USD 197,00, misma combinación JA5110/JA7753 clase U (H-04)                                                                                                                                                                                                                                                                    | `05`, `06`      |

### 2.2 SAB-13 — emisión con CASH y anulación (`sab-13`: `book-issue-void`, con `--allow-money`)

| Pregunta                                                          | Respuesta | Evidencia |
| ----------------------------------------------------------------- | --------- | --------- |
| D1 — ¿emite ATPCO con la forma de pago de la cuenta, sin tarjeta? |           |           |
| Forma de pago aceptada (CASH u ON_ACCOUNT)                        |           |           |
| ¿Emite ATPCO sin qualifiers? (06 Q7)                              |           |           |
| Ventana de void (P-11) y lo que dice `checkFlightTickets`         |           |           |
| ¿El VOID deshace lo anulado si falla a medias? (06 Q3)            |           |           |
| Avisos reales de la emisión                                       |           |           |

### 2.3 SAB-21 — asientos y servicios (`sab-21`: `seatmap`, `book-with-seat`, `ancillaries`)

| Pregunta                                                                      | Respuesta | Evidencia |
| ----------------------------------------------------------------------------- | --------- | --------- |
| P-06 — versión de Get Seats que sirve el PCC (v3 o v1)                        |           |           |
| ¿Hay asientos sin cargo? ¿Se confirman con la reserva (`FLIGHT_WITH_EXTRAS`)? |           |           |
| ¿Los servicios traen precio? Stateless Ancillaries o Manage Ancillary 1.1     |           |           |
| ¿El EMD se emite con CASH? (06 pregunta 6)                                    |           |           |
| Comportamiento con cambio de equipo (R-24)                                    |           |           |

### 2.4 SAB-22 — contenido NDC (`sab-22`: `shop-ndc`)

| Pregunta                                                                      | Respuesta | Evidencia |
| ----------------------------------------------------------------------------- | --------- | --------- |
| ¿CERT devuelve NDC en las rutas LATAM? Cuántas ofertas descarta hoy el mapper |           |           |
| P-03 — ¿la emisión NDC admite CASH? (queda para `ndc-issue-void`, SAB-22)     |           |           |

### 2.5 SAB-24 — reembolso (`sab-24`: `book-issue-refund`, con `--allow-money`)

| Pregunta                                                        | Respuesta | Evidencia |
| --------------------------------------------------------------- | --------- | --------- |
| ¿Automated Refunds está activo en el PCC de CERT?               |           |           |
| Montos del reembolso frente al estimado de `checkFlightTickets` |           |           |
| Estado del tiquete después (`TR`)                               |           |           |

## 3. Hallazgos

| #    | Fecha      | Escenario · paso                | Conversation-ID                                   | Qué se vio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Impacto                                                                                                                                                                                | Acción (PR / test)                                                                                                                                                                                                                                                              |
| ---- | ---------- | ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-01 | 2026-10-19 | `book-cancel` · `createBooking` | `sales-travel-sabre-cert-run-2026-10-18-sab12-01` | 200 con `errors[0]`: `BAD_REQUEST` / `MANDATORY_DATA_MISSING`, `fieldPath: CreateBookingRequest.travelers[0]`, `fieldName: id`. La reserva ATPCO salió por `flightOffer` (`offerId` + `selectedOfferItems` `dummy-…` de Flight Check), y en ese bloque Sabre exige `travelers[].id`. Flight Check **no devuelve** id de viajero: sólo `passengerTypeCode` + `requestedTravelerIndex`. El carril «ATPCO con Flight Check → `flightOffer`» es una inferencia nuestra: la colección no tiene ningún ejemplo, y sus 77 reservas ATPCO van por `flightDetails`, sin `id` | **Bloqueante.** Ninguna reserva Sabre ATPCO sale hoy: Flight Check corre siempre antes de reservar, así que todas toman ese carril (`productOf`, `sabre-order-create.adapter.ts:1028`) | Por decidir: (a) reservar ATPCO por `flightDetails` + `flightPricing`, el carril de la colección, y usar Flight Check sólo para revalidar el precio; o (b) probar en CERT qué `id` acepta `flightOffer` con una oferta de Flight Check. Test de regresión con `07` como fixture |
| H-02 | 2026-10-19 | `book-cancel` · desenlace       | ídem                                              | Un `MANDATORY_DATA_MISSING` con `HALT_ON_ERROR`, sin `confirmationId` y con el `request` devuelto entero, queda como «`createBooking` en duda» (salida 2)                                                                                                                                                                                                                                                                                                                                                                                                           | Falso positivo en el arnés. En producto sería una escalación de más por cada reserva rechazada por validación                                                                          | Tratar como fallo cierto el `BAD_REQUEST` de validación sin `confirmationId` ni `booking` en la respuesta. Test con `07`                                                                                                                                                        |
| H-03 | 2026-10-19 | `shop` · las tres rutas         | ídem                                              | `baggage-not-mapped` («sólo franquicia facturada») en el 100 % de las ofertas (149/149). La franquicia facturada sí llega al `Offer` (`conEquipaje` 49/50/50); lo que falta es equipaje de mano y cargos (`utaDescs`/`baggageChargeDescs`, docs/sabre/02 §7.4)                                                                                                                                                                                                                                                                                                      | Limitación conocida, ahora con número: afecta al 100 % de las ofertas en CERT                                                                                                          | Decodificar `utaDescs`/`baggageChargeDescs` con fixture de `02`. No bloquea                                                                                                                                                                                                     |
| H-04 | 2026-10-19 | `book-cancel` · `flightCheck`   | ídem                                              | Misma combinación y clase (JA5110 + JA7753, U): shop USD 242,20, Flight Check USD 197,00 (`price-changed`, `same-cabin-alternative`). Fare basis `ULRDCL` en ambos tramos, BASIC                                                                                                                                                                                                                                                                                                                                                                                    | Es información, no un error: Flight Check cotiza distinto que BFM. Confirma que revalidar antes de reservar es obligatorio                                                             | Ninguna. Repetir en más rutas para ver si es sistemático                                                                                                                                                                                                                        |

## 4. Recomendación Go / No-Go

Pendiente. Tiene que llevar su número ([11 §4.5](./11-plan-implementacion.md#45-criterios-de-salida)): el porcentaje
de búsquedas en las que Sabre aporta una oferta que no está en LATAM NDC directo, o el mismo vuelo a mejor neto,
comparado con el umbral acordado antes de medir.

## 5. PNR que quedaron vivos

Lo que el arnés no pudo cancelar ni anular (salida `2`), con el motivo que dejó en `summary.json` →
`leftovers`. Se borra la fila cuando el PNR queda cerrado en Sabre Red.

| PNR             | runId                 | Escenario     | Estado    | Motivo                                                                                                                                                                                                                                              | Cerrado el |
| --------------- | --------------------- | ------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| sin localizador | `2026-10-18-sab12-01` | `book-cancel` | `unknown` | «`createBooking` en duda». La respuesta es un rechazo de validación con `HALT_ON_ERROR`, sin `confirmationId` (H-02): **casi seguro no hay PNR**. Confirmarlo en Sabre Red con el Conversation-ID `sales-travel-sabre-cert-run-2026-10-18-sab12-01` | —          |
