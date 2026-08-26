import type {
  OrderCreateOutcome,
  OrderCreateResult,
  OrderItemKind,
  OrderItemResult,
  OrderItemStatus,
  ProviderIssue,
} from '@sales-travel/domain';
import { z } from 'zod';
import { sabreEnvelopeRecord, sabreEnvelopeString } from '../errors';

/**
 * Mapper de `CreateBookingResponse` (`booking-management-v1.yml:804-829`) al puerto de dominio
 * `OrderCreateResult` (RF-08).
 *
 * ## Por qué el resultado NO es un booleano
 *
 * `success: boolean` no puede representar «PNR creado, vuelo confirmado, hotel falló», y ese estado
 * **no es una anomalía**: es un modo que el cliente ELIGE antes de llamar, vía `errorHandlingPolicy`
 * (array de 8 valores, seis de ellos `DO_NOT_HALT_ON_*`, `:698` y `:8918-8940`). El contrato lo
 * confirma por otro lado: `CreateBookingResponse` puede traer `booking` **y** `errors[]` a la vez
 * (`:819-825`). De ahí `OrderCreateOutcome` con cuatro estados y `items[]` por `itemId`.
 *
 * ## Las tres cosas que este mapper hace y que un `JSON.parse` no
 *
 * **1. Nunca dice FAILED si hay localizador.** Si la respuesta trae `confirmationId` o
 * `booking.bookingId`, **hay un PNR ahí fuera** aunque venga con errores. Decir «no se creó nada»
 * cuando existe un PNR es exactamente cómo se generan localizadores huérfanos que nadie cancela.
 * `createBooking` no expone ninguna idempotency key (`:694-802`) y `getBooking` se direcciona por
 * `confirmationId`: perder ese dato es perder la reserva (docs/sabre/04 §5.5).
 *
 * **2. `bookingSignature` NO viene, y el tipo lo dice.** El campo aparece 5 veces en todo el
 * contrato —`GetBookingResponse:309` y `ModifyBookingRequest:836/:840/:881/:888`— y **ninguna en
 * `Booking` ni en `CreateBookingResponse`**. Por eso {@link SabreCreateBookingMapped.hasBookingSignature}
 * es del tipo literal `false` y `OrderCreateResult.revision` sale siempre vacío: **toda modificación
 * posterior exige encadenar un `getBooking`** (docs/sabre/04 §6.3).
 *
 * **3. Tira el eco del request, sin excepción.** `CreateBookingResponse.request` (`:827`) es una
 * copia íntegra del payload enviado: nombres, fechas de nacimiento, pasaportes, correos. **El body
 * de respuesta es tan sensible como el de petición.** Este mapper no lo lee, no lo copia y no lo
 * devuelve; lo que sale de aquí es lo único que puede persistirse en `orders.provider_raw`.
 *
 * **4. Lee el ASIENTO, porque el builder lo pide.** `create.request.builder.ts` sabe pedir asiento
 * por los dos carriles —`flights[].seats[]` en ATPCO (`:5243`) y `flightOffer.seatOffers[]` en NDC
 * (`:4975`)— y hasta tiene una política propia para tolerar su fallo
 * (`DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`, `:8929`). El estado del asiento vuelve en
 * `flights[].seats[]` (`:2027`, items `Seat` en `:2409`). Mientras este mapper no lo miraba, un
 * asiento denegado no aparecía en `items[]`, la orden salía `CONFIRMED` y el pasajero se enteraba
 * en el aeropuerto: se pedía una cosa y se leía otra. Ver {@link classifySeatStatus} para por qué
 * el criterio de un asiento **no** es el de un vuelo.
 *
 * ## Zod en el borde, y tolerante
 *
 * La respuesta es input externo (CLAUDE.md). El schema no declara ningún campo obligatorio porque
 * el contrato tampoco lo hace (`:804`, sin `required`), y las claves de producto **pueden
 * desaparecer**: tras un reembolso, `flights` y `journeys` no están en el objeto mientras
 * `allSegments` sobrevive (docs/sabre/04 §6.2). Un mapper que asuma que existen revienta.
 */

/**
 * `createBooking` **no devuelve** `bookingSignature`. Constante, no cálculo: es una propiedad del
 * contrato, y existe para que el llamador la pueda citar en vez de descubrirlo en producción.
 */
export const SABRE_CREATE_RETURNS_BOOKING_SIGNATURE = false;

/**
 * `StatusNameEnum` — `:9204-9222`. El único vocabulario de estado **cerrado** del contrato, y por
 * eso el criterio principal. Sabre deriva el nombre del código («Description of statusName based on
 * statusCode»), pero no publica la tabla.
 */
export const SABRE_STATUS_NAMES = [
  'Confirmed',
  'Waitlisted',
  'On Request',
  'Pending',
  'Cancelled',
  'Infant/No Seat',
  'Priority Waitlist',
  'Quote',
  'Space Available',
  'Unconfirmed',
  'Pending Quote',
  'No Seat',
  'Standby',
  'Unknown',
] as const;

export type SabreStatusName = (typeof SABRE_STATUS_NAMES)[number];

/**
 * Códigos de estado que valen por CONFIRMADO.
 *
 * `HK` y `GK` están [V] en los ejemplos oficiales del **mismo objeto `Booking`**
 * (`help-documentation-get-booking-examples.txt:361`, `…-modify-booking-examples-0.txt:2147` y
 * `:2425`+). `YK` es el estado de una **pasiva confirmada**: el propio request lo usa para
 * registrar un segmento reservado fuera de Sabre (`:5221`), y ⚠️ no está en
 * `HaltOnFlightStatusCodeEnum` (`:8777`), o sea que **no se puede abortar por él**.
 *
 * La lista es corta a propósito. Un código desconocido **no se asume confirmado**: cae en
 * `UNCONFIRMED`, que es el lado seguro —no promete un asiento que quizá no exista— sin llegar a
 * `FAILED`, que dispararía compensación sobre algo que probablemente esté bien.
 */
export const SABRE_CONFIRMED_STATUS_CODES: ReadonlySet<string> = new Set(['HK', 'GK', 'KK', 'YK']);

/**
 * Códigos que el contrato considera **inaceptables** y que significan que el proveedor NO dio el
 * espacio: `:5004-5010` lista los siete que abortan por defecto. Se parten en dos porque no
 * significan lo mismo para la compensación:
 *
 *   - rechazo (`NO`, `UC`, `US`, `UN`) → `FAILED`: no hay nada que esperar.
 *   - lista de espera (`UU`, `LL`, `HL`) → `UNCONFIRMED`: el ítem existe y puede confirmarse solo.
 *
 * ⚠️ El contrato **no publica** esa partición: los llama a los siete «unacceptable». La división es
 * regla NUESTRA, y el criterio es el de siempre —en la duda, no cancelar—. Si CERT demuestra otra
 * cosa, se cambia aquí y en ningún otro sitio.
 */
export const SABRE_REJECTED_STATUS_CODES: ReadonlySet<string> = new Set(['NO', 'UC', 'US', 'UN']);
export const SABRE_WAITLIST_STATUS_CODES: ReadonlySet<string> = new Set(['UU', 'LL', 'HL']);

/** `NN` = _need_: pedido a la aerolínea y sin respuesta todavía (`:5216`, default del request). */
export const SABRE_PENDING_STATUS_CODES: ReadonlySet<string> = new Set(['NN', 'HN', 'PN']);

/**
 * Nombres de `StatusNameEnum` que, **dichos de un asiento**, significan que no hay asiento.
 *
 * ⚠️ `'Infant/No Seat'` NO está aquí y no es un olvido: es el estado NORMAL de un infante en
 * brazos, no un asiento denegado. Contarlo como fallo degradaría a `PARTIAL` toda reserva con
 * un `INF`, que es la mitad de las familias que vende una agencia LATAM.
 */
const SABRE_SEAT_DENIED_STATUS_NAMES: ReadonlySet<string> = new Set(['Cancelled', 'No Seat']);

/**
 * Nombres de `StatusNameEnum` que dicen, con el vocabulario CERRADO del contrato, que el asiento
 * existe como petición pero **todavía no está retenido**. No es un rechazo: puede confirmarse
 * solo, igual que un vuelo en lista de espera.
 */
const SABRE_SEAT_UNHELD_STATUS_NAMES: ReadonlySet<string> = new Set([
  'Waitlisted',
  'Priority Waitlist',
  'Standby',
  'On Request',
  'Pending',
  'Unconfirmed',
]);

/**
 * Categorías de `Error.category` observadas en el catálogo oficial de errores de `createBooking`.
 * `WARNING` es una de ellas: **no corta la reserva** y por eso baja a `severity: 'WARNING'`
 * (docs/sabre/04 §6.4).
 */
export const SABRE_WARNING_ERROR_CATEGORY = 'WARNING';

/**
 * Categoría de las incidencias que genera **este ACL**, no el proveedor. Se distingue a propósito
 * de `BAD_REQUEST` / `APPLICATION_ERROR` / `EXTERNAL_SERVER_ERROR` / `WARNING`: un fallo nuestro
 * leyendo la respuesta no puede contarse como caída de Sabre ni disparar el circuit breaker.
 */
export const SABRE_ACL_ISSUE_CATEGORY = 'ACL';

// ---------------------------------------------------------------------------------------------
// Zod en el borde
// ---------------------------------------------------------------------------------------------

/** `Error` — `:4271-4302`. Required: `category` + `type`; el resto puede faltar. */
const SabreErrorSchema = z.object({
  category: z.string(),
  type: z.string(),
  description: z.string().optional(),
  fieldPath: z.string().optional(),
  fieldName: z.string().optional(),
  /** ⚠️ Es el VALOR que mandamos, devuelto tal cual: puede ser un número de pasaporte. */
  fieldValue: z.string().optional(),
});

/**
 * `itemId` es un **string** con patrón `^[A-Z0-9]+$` (`:1875`), pero su ejemplo oficial es `'12'`:
 * un proveedor que lo emita como número JSON es una deriva plausible, y perder por eso la unidad
 * de cancelación sería absurdo. Se acepta número y se normaliza a texto — sin volver a convertirlo
 * nunca a número, que es lo que rompería el `^[A-Z0-9]+$` de un id alfanumérico.
 */
const ItemIdSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .optional();

/**
 * `Seat` — `:2409-2444`. `number` es su ÚNICO campo obligatorio, y su presencia **es** el dato:
 * `flights[].seats[]` _"lists seats assigned to the travelers"_ y _"an empty Seat object or a null
 * value indicates that no seat is assigned to the corresponding traveler"_ (`:2027-2032`). O sea
 * que el array tiene HUECOS declarados —`null` y `{}`— que hay que poder distinguir de «hay
 * asiento y el vendor lo rechazó». Por eso todo es opcional y el elemento es anulable.
 *
 * `.catch(null)` degrada una entrada ilegible a hueco en vez de tumbar el parseo del sobre entero.
 * No es laxitud: sin él, un asiento con forma rara mandaría la respuesta a {@link salvageLocator},
 * que **descarta todos los ítems** —los vuelos incluidos— y devuelve una orden `PARTIAL` sin nada
 * que compensar. Perder el itinerario por no poder leer un `13A` es peor que no leer el `13A`.
 * El coste es explícito: un asiento cuya forma no entendemos **desaparece** y no degrada nada.
 */
const SabreSeatSchema = z
  .object({
    number: z.string().optional(),
    statusCode: z.string().optional(),
    statusName: z.string().optional(),
  })
  .nullable()
  .catch(null);

/** El mínimo común de `Flight`/`Hotel`/`Car`: `itemId` + un código de estado propio. */
const SabreFlightItemSchema = z.object({
  itemId: ItemIdSchema,
  flightStatusCode: z.string().optional(),
  flightStatusName: z.string().optional(),
  /**
   * `:2027`. ⚠️ `changeOfGaugeSeats` (`:2038`) NO se lee **porque el builder tampoco lo pide**
   * (`create.request.builder.ts`, nota de `SabreSeatInput`). Las dos mitades se mueven juntas o
   * no se mueven: leer un asiento que nunca pedimos no arregla nada y pedir uno que no leemos es
   * el fallo que este bloque existe para cerrar.
   */
  seats: z.array(SabreSeatSchema).optional(),
});

const SabreHotelItemSchema = z.object({
  itemId: ItemIdSchema,
  hotelStatusCode: z.string().optional(),
  hotelStatusName: z.string().optional(),
});

const SabreCarItemSchema = z.object({
  itemId: ItemIdSchema,
  carStatusCode: z.string().optional(),
  carStatusName: z.string().optional(),
});

/**
 * `Booking` — `:1053`. Sólo lo que este mapper necesita.
 *
 * ⚠️ `travelers`, `fares`, `payments` y los otros 25 campos **no se leen aquí**: llevan PII y
 * dinero, y RF-08 sólo necesita saber qué se creó y con qué estado. Lo demás es competencia de
 * `get.response.mapper.ts`, que además puede pedir `returnOnly` para no traerlo.
 */
const SabreBookingSchema = z.object({
  bookingId: z.string().optional(),
  flights: z.array(SabreFlightItemSchema).optional(),
  hotels: z.array(SabreHotelItemSchema).optional(),
  cars: z.array(SabreCarItemSchema).optional(),
});

/**
 * El sobre. Cinco propiedades y sólo cinco (`:804-829`).
 *
 * `request` **se declara y se ignora**: declararlo documenta que sabemos que viene y que su omisión
 * aquí es deliberada, no un descuido. Su tipo es `unknown` para que nadie pueda leerlo por accidente
 * sin escribir un cast que salte a la vista en la revisión.
 */
export const SabreCreateBookingResponseSchema = z.object({
  timestamp: z.string().optional(),
  confirmationId: z.string().optional(),
  booking: SabreBookingSchema.optional(),
  errors: z.array(SabreErrorSchema).optional(),
  /** Eco íntegro del payload enviado, PII incluida. NO se lee. Ver la cabecera del archivo. */
  request: z.unknown().optional(),
});

export type SabreCreateBookingResponse = z.infer<typeof SabreCreateBookingResponseSchema>;

/**
 * Un cuerpo que ni siquiera tiene la forma del contrato. No es «reserva fallida»: es «no sé qué me
 * han devuelto», y las dos cosas se tratan distinto —de la primera se informa al cliente, de la
 * segunda se reconcilia a mano—.
 */
export class SabreCreateBookingMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreCreateBookingMapError';
  }
}

/**
 * El resultado del ACL para una creación.
 *
 * `hasBookingSignature` es del tipo literal `false`, no `boolean`: no es un dato que varíe según la
 * respuesta, es una propiedad del endpoint, y el compilador impide escribir código que espere lo
 * contrario.
 */
export interface SabreCreateBookingMapped {
  readonly order: OrderCreateResult;
  /** Siempre `false`. Modificar exige encadenar `getBooking` (docs/sabre/04 §6.3). */
  readonly hasBookingSignature: typeof SABRE_CREATE_RETURNS_BOOKING_SIGNATURE;
  /**
   * `:808` — UTC. ⚠️ El ejemplo oficial lo manda **sin `Z`** (`'2025-10-29T10:17:18'`) pese a que
   * el contrato promete `YYYY-MM-DDTHH:MM:SSZ`: se pasa tal cual y se parsea con tolerancia arriba.
   */
  readonly timestamp?: string;
}

/**
 * `CreateBookingResponse` → `OrderCreateResult`.
 *
 * @param raw El cuerpo JSON ya parseado que devuelve `SabreHttpClient.postJson`.
 */
export function mapSabreCreateBookingResponse(raw: unknown): SabreCreateBookingMapped {
  const parsed = SabreCreateBookingResponseSchema.safeParse(raw);
  if (parsed.success) return toMapped(parsed.data, []);
  return salvageLocator(raw, shapeIssue(parsed.error));
}

/**
 * La respuesta no tiene la forma del contrato. **Antes de rendirse, se busca el localizador.**
 *
 * Perder el `confirmationId` es perder la reserva: `createBooking` no expone idempotency key
 * (`:694-802`), `getBooking` se direcciona por `confirmationId` (`:240`) y el contrato de Booking
 * Management **no ofrece ninguna búsqueda por remark**. Un PNR sin localizador queda huérfano y sólo
 * lo encuentra una persona (docs/sabre/04 §5.5, riesgo MAYOR).
 *
 * Si aparece el localizador, se devuelve una orden `PARTIAL` con la incidencia de forma dentro: hay
 * algo creado y hay que mirarlo. Sólo se lanza cuando **tampoco** hay localizador, que es el único
 * caso en el que no hay nada que perder.
 *
 * Los escalares se leen con `sabreEnvelopeString`/`sabreEnvelopeRecord`, que son los canónicos de
 * `errors.ts`. Aquí no hay copia: una copia de un helper de lectura fue exactamente lo que en su
 * día convirtió un `1e999` en el texto `"Infinity"` y tapó el error real (ver la cabecera de
 * `http/sabre-http.client.ts`).
 */
function salvageLocator(raw: unknown, issue: ProviderIssue): SabreCreateBookingMapped {
  const envelope = sabreEnvelopeRecord(raw);
  const confirmationId =
    envelope === null ? undefined : sabreEnvelopeString(envelope['confirmationId']);
  const booking = envelope === null ? null : sabreEnvelopeRecord(envelope['booking']);
  const bookingId = booking === null ? undefined : sabreEnvelopeString(booking['bookingId']);

  if (confirmationId === undefined && bookingId === undefined) {
    throw new SabreCreateBookingMapError(
      `la respuesta de createBooking no tiene la forma del contrato y no trae localizador ` +
        `(${issue.message ?? issue.type})`,
    );
  }

  return toMapped(
    {
      ...(confirmationId === undefined ? {} : { confirmationId }),
      ...(bookingId === undefined ? {} : { booking: { bookingId } }),
    },
    [issue],
  );
}

/**
 * La incidencia de forma. `category: 'ACL'` la distingue de las cuatro categorías del proveedor
 * (`BAD_REQUEST`, `APPLICATION_ERROR`, `EXTERNAL_SERVER_ERROR`, `WARNING`): el fallo es nuestro
 * leyendo, no de Sabre respondiendo, y no debe contarse como caída del proveedor.
 *
 * El detalle son rutas de campo y códigos de Zod, **nunca valores**: la respuesta lleva el eco del
 * request con pasaportes dentro.
 */
function shapeIssue(error: z.ZodError): ProviderIssue {
  return {
    severity: 'ERROR',
    category: SABRE_ACL_ISSUE_CATEGORY,
    type: 'RESPONSE_SHAPE_UNEXPECTED',
    message: error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
      .join(', '),
  };
}

function toMapped(
  response: SabreCreateBookingResponse,
  extraIssues: readonly ProviderIssue[],
): SabreCreateBookingMapped {
  const issues = [...extraIssues, ...(response.errors ?? []).map(toProviderIssue)];
  const items = collectItems(response.booking);
  const locator = response.confirmationId ?? response.booking?.bookingId;

  const order: OrderCreateResult = {
    outcome: resolveOutcome(locator, items, issues),
    ...(response.booking?.bookingId === undefined ? {} : { orderId: response.booking.bookingId }),
    ...(response.confirmationId === undefined ? {} : { pnr: response.confirmationId }),
    // `revision` se deja SIN ASIGNAR a propósito: Sabre no devuelve `bookingSignature` al crear.
    items,
    issues,
    ...buildCompensation(items),
  };

  return {
    order,
    hasBookingSignature: SABRE_CREATE_RETURNS_BOOKING_SIGNATURE,
    ...(response.timestamp === undefined ? {} : { timestamp: response.timestamp }),
  };
}

/**
 * `Error` → `ProviderIssue`, campo a campo y **sin aplanar a texto**.
 *
 * `CreateBookingResponse` sólo declara `errors[]` (no hay `warnings[]` en este endpoint), pero una
 * de las categorías observadas del catálogo oficial es `WARNING`, que no corta la reserva. Esa es
 * la única forma que tenemos de distinguir severidad aquí, y por eso se lee de `category`.
 *
 * `fieldValue` se conserva —el puerto lo declara— porque es lo único que permite saber QUÉ dato
 * rechazó el proveedor. ⚠️ Puede llevar un número de pasaporte: el propio puerto avisa de que no
 * puede salir en logs, spans ni cuerpos HTTP.
 */
function toProviderIssue(error: z.infer<typeof SabreErrorSchema>): ProviderIssue {
  return {
    severity: error.category === SABRE_WARNING_ERROR_CATEGORY ? 'WARNING' : 'ERROR',
    category: error.category,
    type: error.type,
    ...(error.description === undefined ? {} : { message: error.description }),
    ...(error.fieldPath === undefined ? {} : { fieldPath: error.fieldPath }),
    ...(error.fieldName === undefined ? {} : { fieldName: error.fieldName }),
    ...(error.fieldValue === undefined ? {} : { fieldValue: error.fieldValue }),
  };
}

// El puerto declara `items` mutable, así que aquí se devuelve un array normal en vez de un
// `readonly` que obligaría a copiarlo en el borde.
function collectItems(booking: z.infer<typeof SabreBookingSchema> | undefined): OrderItemResult[] {
  if (booking === undefined) return [];
  const items: OrderItemResult[] = [];

  for (const flight of booking.flights ?? []) {
    items.push(toItem('flight', flight.itemId, flight.flightStatusCode, flight.flightStatusName));
    // Los asientos van pegados a SU vuelo y no en un bloque aparte: `Seat` no trae `itemId`, así
    // que la posición en `items[]` es lo único que dice a qué tramo pertenece el asiento.
    for (const seat of flight.seats ?? []) {
      // `null` y el `Seat` vacío son el hueco que declara el contrato: ese pasajero no lleva
      // asiento en este tramo, y eso no es un fallo. `number` es el único campo obligatorio de
      // `Seat` (`:2413-2414`), así que sin él la entrada no describe ningún asiento.
      if (seat === null || seat.number === undefined) continue;
      items.push({
        kind: 'seat',
        // Sin `providerItemId`: ver {@link buildCompensation}.
        status: classifySeatStatus(seat.statusCode, seat.statusName),
        ...(seat.statusCode === undefined ? {} : { statusCode: seat.statusCode }),
        ...(seat.statusName === undefined ? {} : { message: seat.statusName }),
      });
    }
  }
  for (const hotel of booking.hotels ?? []) {
    items.push(toItem('hotel', hotel.itemId, hotel.hotelStatusCode, hotel.hotelStatusName));
  }
  for (const car of booking.cars ?? []) {
    items.push(toItem('car', car.itemId, car.carStatusCode, car.carStatusName));
  }

  return items;
}

function toItem(
  kind: OrderItemKind,
  itemId: string | undefined,
  statusCode: string | undefined,
  statusName: string | undefined,
): OrderItemResult {
  return {
    kind,
    ...(itemId === undefined ? {} : { providerItemId: itemId }),
    status: classifyItemStatus(statusCode, statusName),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(statusName === undefined ? {} : { message: statusName }),
  };
}

/**
 * Estado de un ítem, decidido en este orden:
 *
 *   1. `statusName`, que es el único enum CERRADO del contrato (`StatusNameEnum`, `:9204`).
 *   2. el código, contra las tres listas de arriba.
 *   3. si no hay ninguno de los dos, o el código es desconocido: `UNCONFIRMED`.
 *
 * El punto 3 es la decisión que importa. `UNCONFIRMED` **no es `FAILED`**: el ítem existe en la
 * reserva y el proveedor no lo dio por confirmado. Colapsar los dos lleva a cancelar lo que todavía
 * podía confirmarse; asumir `CONFIRMED` lleva a vender un asiento que no está.
 */
export function classifyItemStatus(
  statusCode: string | undefined,
  statusName: string | undefined,
): OrderItemStatus {
  const name = statusName?.trim();
  if (name === 'Confirmed') return 'CONFIRMED';
  if (name === 'Cancelled') return 'FAILED';

  const code = statusCode?.trim().toUpperCase();
  if (code !== undefined && code.length > 0) {
    if (SABRE_CONFIRMED_STATUS_CODES.has(code)) return 'CONFIRMED';
    if (SABRE_REJECTED_STATUS_CODES.has(code)) return 'FAILED';
    if (SABRE_WAITLIST_STATUS_CODES.has(code)) return 'UNCONFIRMED';
    if (SABRE_PENDING_STATUS_CODES.has(code)) return 'UNCONFIRMED';
  }

  return 'UNCONFIRMED';
}

/**
 * Estado de un ASIENTO. Deliberadamente **no** es {@link classifyItemStatus}, y la diferencia está
 * en el default.
 *
 * `classifyItemStatus` cae en `UNCONFIRMED` cuando no reconoce el código, porque para un vuelo ése
 * es el lado seguro: no prometer un asiento que quizá no exista. Aquí el lado seguro es el
 * CONTRARIO, por dos razones que se pueden citar:
 *
 *  1. **El contrato ya dice que el asiento está.** `flights[].seats[]` _"lists seats assigned to
 *     the travelers"_ y reserva `null`/`{}` para el hueco (`:2027-2032`). Un `Seat` con `number`
 *     es, por las palabras del propio contrato, un asiento asignado. Hace falta que el estado lo
 *     CONTRADIGA para degradarlo.
 *  2. **El vocabulario de `statusCode` de un asiento no es el de un vuelo, y no está publicado.**
 *     `Seat.statusCode` es _"the two-letter status code used by vendors"_ (`:2435-2437`), sin
 *     enum; `haltOnFlightStatusCodes` (`:5004-5010`) habla explícitamente de códigos de VUELO. El
 *     único ejemplo oficial de un asiento efectivamente asignado trae `statusCode: 'HD'` con
 *     `statusName: 'Unknown'` (`help-documentation-get-booking-examples.txt:336-349`), y `HD` no
 *     está en ninguna de nuestras tres listas. Con el default de vuelo, ese asiento —correcto—
 *     saldría `UNCONFIRMED`, la orden entera caería a `PARTIAL` y el saga compensaría: el
 *     pasajero perdería el vuelo por culpa de un asiento que sí tenía.
 *
 * Lo que SÍ degrada es un estado que CONTRADICE esa asignación, y se mira en este orden:
 *
 *   1. `statusName === 'Confirmed'` — el enum cerrado diciendo que sí.
 *   2. {@link SABRE_SEAT_DENIED_STATUS_NAMES} — el enum cerrado diciendo que no hay asiento.
 *   3. {@link SABRE_REJECTED_STATUS_CODES} — un rechazo explícito. Va ANTES que el resto de
 *      nombres a propósito: Sabre deriva el nombre del código, y un `UC` llega descrito como
 *      `'Unconfirmed'`. Si el nombre genérico ganase, un asiento **denegado** se contaría como
 *      «todavía puede confirmarse» y nadie volvería a mirarlo.
 *   4. {@link SABRE_SEAT_UNHELD_STATUS_NAMES} y los códigos de espera/pendiente — pedido, no
 *      retenido.
 *
 * Y sólo entonces el default `CONFIRMED`: se degrada por lo que el proveedor DICE, nunca por lo
 * que no entendemos.
 */
function classifySeatStatus(
  statusCode: string | undefined,
  statusName: string | undefined,
): OrderItemStatus {
  const name = statusName?.trim();
  const code = statusCode?.trim().toUpperCase();
  const hasCode = code !== undefined && code.length > 0;

  if (name === 'Confirmed') return 'CONFIRMED';
  if (name !== undefined && SABRE_SEAT_DENIED_STATUS_NAMES.has(name)) return 'FAILED';
  if (hasCode && SABRE_REJECTED_STATUS_CODES.has(code)) return 'FAILED';
  if (name !== undefined && SABRE_SEAT_UNHELD_STATUS_NAMES.has(name)) return 'UNCONFIRMED';
  if (hasCode) {
    if (SABRE_WAITLIST_STATUS_CODES.has(code)) return 'UNCONFIRMED';
    if (SABRE_PENDING_STATUS_CODES.has(code)) return 'UNCONFIRMED';
  }

  return 'CONFIRMED';
}

/**
 * El desenlace de la creación entera.
 *
 * - **`FAILED`** sólo cuando no hay localizador: sin `confirmationId` ni `bookingId` no hay nada
 *   creado que reconciliar. Con localizador, nunca se dice `FAILED` aunque vengan errores.
 * - **`PENDING`** cuando hay localizador pero **ningún ítem y ningún error**. Es exactamente el
 *   estado que produce un `asynchronousUpdateWaitTime` corto: la orden existe, la respuesta llegó
 *   antes de que la redisplay se sincronizara y todavía no sabemos qué contiene. Se resuelve con el
 *   `getBooking` de verificación, no cancelando.
 * - **`PARTIAL`** con localizador y algo que no cuadra: un ítem `FAILED`, un ítem `UNCONFIRMED`, o
 *   un `issue` de severidad `ERROR`.
 * - **`CONFIRMED`** cuando hay localizador, hay ítems y todos están confirmados sin errores.
 */
export function resolveOutcome(
  locator: string | undefined,
  items: readonly OrderItemResult[],
  issues: readonly ProviderIssue[],
): OrderCreateOutcome {
  if (locator === undefined || locator.length === 0) return 'FAILED';

  const hasErrors = issues.some((issue) => issue.severity === 'ERROR');
  if (items.length === 0) return hasErrors ? 'PARTIAL' : 'PENDING';
  if (hasErrors) return 'PARTIAL';
  if (items.some((item) => item.status !== 'CONFIRMED')) return 'PARTIAL';
  return 'CONFIRMED';
}

/**
 * Qué se puede deshacer — y **cuándo hay algo que deshacer**. Dos preguntas, y la segunda es la
 * que faltaba.
 *
 * **QUÉ**: sólo los ítems que **existen** —los que traen `itemId`— y que no están ya `FAILED`. Un
 * ítem que falló no llegó a crearse y no hay nada que cancelarle. La actividad de compensación
 * cancela por `itemId`, **nunca** con un `cancelAll: true` ciego (docs/sabre/04 §5.4).
 *
 * **CUÁNDO**: sólo si el proveedor declaró caído algo que su propio `cancelBooking` sabe nombrar,
 * o sea un ítem `FAILED` **con `itemId`**. Sin eso, esta lista no puede significar más que
 * «cancela el vuelo confirmado», porque lo único que se habrá caído es algo que no se puede
 * cancelar por separado.
 *
 * ⚠️ **Un asiento no tiene `itemId` y no lo puede tener.** `Seat` (`:2409-2444`) declara `number`,
 * `characteristics`, `statusCode` y `statusName`, y `CancelBookingRequest` no tiene carril de
 * asientos: sólo `flights`/`hotels`/`cars`/`trains`/`cruises`/`segments` (`:323-438`). Antes, el
 * filtro de `providerItemId` dejaba fuera el asiento pero metía dentro el `itemId` del VUELO al
 * que cuelga, y el resultado era literalmente **cancelar el vuelo porque falló el asiento**: la
 * puerta de arriba es lo que hace verdadera esta advertencia en vez de dejarla en una promesa. El
 * asiento degradado se ve en `items[]` y en el desenlace, que es donde tiene que verse.
 *
 * ⚠️ Esta puerta **no protege sola, y no pretende hacerlo**: quien decide si se compensa es el
 * saga (`apps/api/src/orders/order-create.saga.ts`, tabla `ORDER_ITEM_ROLE`), y cuando aquí no se
 * declara nada, el saga cae a su propia lista —los ítems confirmados con id, o sea el vuelo—. Lo
 * que esta mitad garantiza es más modesto y aun así hace falta: el ACL no entrega una lista cuyo
 * único significado posible sería «cancela el vuelo confirmado». La garantía de que un accesorio
 * caído no cancela un producto está allí, y allí es donde hay que ir a romperla.
 *
 * Se omite el bloque entero cuando no hay nada cancelable: un `cancellableItemIds: []` invita a
 * escribir «si está vacío, cancélalo todo», que es justo lo contrario de lo que hay que hacer.
 */
function buildCompensation(
  items: readonly OrderItemResult[],
): { compensation: { cancellableItemIds: string[] } } | Record<string, never> {
  const hasCancellableFailure = items.some((item) => item.status === 'FAILED' && hasItemId(item));
  if (!hasCancellableFailure) return {};

  const ids = items
    .filter((item) => item.status !== 'FAILED')
    .map((item) => item.providerItemId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return {};
  return { compensation: { cancellableItemIds: ids } };
}

/** Un id vacío no direcciona nada: `itemId` es `^[A-Z0-9]+$` (`:1875`), nunca la cadena vacía. */
function hasItemId(item: OrderItemResult): boolean {
  return typeof item.providerItemId === 'string' && item.providerItemId.length > 0;
}
