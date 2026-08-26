import type { AirlineLocator, OrderForModification, OrderView } from '@sales-travel/domain';
import { z } from 'zod';
import { SabreIndexError, parseSabreIndex, toArrayPosition } from '../indices';
import { SABRE_EXTRA_FEATURES } from './get.request.builder';

/**
 * Mapper de `GetBookingResponse` (`booking-management-v1.yml:296-322`) al dominio — RF-09 y RF-23.
 *
 * `GetBookingResponse` es `allOf(Booking + timestamp + bookingSignature + request + errors)`, y
 * `Booking` (`:1053-1254`) tiene **32 propiedades de nivel raíz**. Este mapper NO las traduce
 * todas y no debería: traduce lo que el puerto de dominio expone hoy y **descarta el resto sin
 * copiarlo a ningún sitio**. La razón es de privacidad, no de pereza — ver el bloque siguiente.
 *
 * ## Lo que este mapper NO deja pasar, y por qué
 *
 *  - **El eco de la request** (`:314-316`, `request: GetBookingRequest`). Sabre devuelve la
 *    petición entera dentro de la respuesta, incluido el `surname` que mandamos como validación de
 *    primera línea. Copiarlo a la vista lo duplicaría en la caché y en el log.
 *  - **`travelers[]`** (`:1099-1105`): nombres, `birthDate`, `emails[]`, `phones[]`, `address` y
 *    `identityDocuments[]` con número de pasaporte, nacionalidad y lugar de nacimiento (05 §3.2).
 *    Es PII de categoría alta. La vista de orden no lleva ni un campo de persona.
 *  - **`accountingItems[]`** (`:1228-1233`), que incluye `cardNumber` enmascarado. Enmascarado o
 *    no, un fragmento de PAN no entra en un objeto que se cachea y se loguea (D1, PCI SAQ-A).
 *  - **`bookingSignature`** en la lectura de display. Ver {@link mapSabreGetBookingForDisplay}.
 *
 * El test de privacidad de este módulo serializa la salida y busca dentro cada valor sensible del
 * payload de entrada: si alguien añade un campo de persona a la vista, se pone rojo.
 *
 * ## El estado de la reserva NO se lee de la ausencia de claves
 *
 * Sabre purga `flights[]` cuando queda vacío, y durante una época se dedujo "cancelada" de que la
 * clave desapareciera. Es una **consecuencia**, no el mecanismo, y confundirlas hace que una
 * lectura filtrada por `returnOnly` (que también carece de la clave) parezca una cancelación.
 * El estado se lee de `isCancelable`/`isTicketed` (`:1075-1085`) y de
 * `flights[].flightStatusName` / `hotels[].hotelStatusName`, tipados con `StatusNameEnum`
 * (`:9204-9219`). RF-10 CA-4.
 */

/** `StatusNameEnum` — `booking-management-v1.yml:9204-9219`. **Son 14 valores, no 12.** */
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
 * El único valor de `StatusNameEnum` que significa cancelado. Se compara contra la constante y no
 * contra un literal suelto para que `Cancelled` no acabe escrito de tres formas distintas.
 */
export const SABRE_STATUS_CANCELLED: SabreStatusName = 'Cancelled';

/** `FlightSourceEnum` — `:9157-9164`. Decide si la cancelación exige `checkFlightTickets`. */
export const SABRE_CONTENT_LANES = ['ATPCO', 'LCC', 'NDC'] as const;
export type SabreContentLane = (typeof SABRE_CONTENT_LANES)[number];

/** Tipos de ítem cancelables por `itemId` (`CancelBookingRequest`, `:360-390`). */
export const SABRE_ITEM_KINDS = ['FLIGHT', 'HOTEL', 'CAR', 'TRAIN', 'CRUISE'] as const;
export type SabreItemKind = (typeof SABRE_ITEM_KINDS)[number];

/**
 * Estado agregado de la reserva. `NO_CONTENT` **no es sinónimo de cancelada**: es "no hay ítems
 * que mirar", que es lo que devuelve tanto una reserva vaciada como una lectura filtrada que no
 * pidió `FLIGHTS`. Afirmar "cancelada" con eso es exactamente el error que RF-10 CA-4 prohíbe.
 */
export type SabreBookingStatus = 'CANCELLED' | 'ACTIVE' | 'NO_CONTENT';

/** Código estable de aviso de mapeo. Viaja al log y a `OrderView.warnings`. Nunca lleva valores. */
export type SabreBookingWarningCode =
  | 'airline-locator-absent'
  | 'airline-locator-malformed'
  | 'flight-without-airline-code'
  | 'flight-without-item-id'
  | 'ticket-number-malformed'
  | 'traveler-index-out-of-range'
  | 'booking-signature-absent'
  | 'booking-signature-in-display-response'
  | 'provider-reported-issue';

/** Un ítem cancelable. `itemId` es **string** con patrón `^[A-Z0-9]+$` (`:1874-1880`), no número. */
export interface SabreBookingItem {
  readonly itemId: string;
  readonly kind: SabreItemKind;
  readonly statusName?: SabreStatusName;
  readonly statusCode?: string;
  /** Sólo en vuelos. Es lo que decide el carril de cancelación. */
  readonly lane?: SabreContentLane;
}

/**
 * Lo que sale de un `getBooking` ya normalizado. **No tiene —ni puede tener— firma**: el tipo de
 * la lectura de display no la declara, así que `retrieveForDisplay` no puede devolverla ni por
 * accidente (RF-09 CA-1, criterio de compilación).
 */
export interface SabreBookingSnapshot {
  /** Lo que el puerto expone. Sin PII. */
  readonly view: OrderView;
  readonly status: SabreBookingStatus;
  readonly isCancelable?: boolean;
  readonly isTicketed?: boolean;
  readonly items: readonly SabreBookingItem[];
  /** Carriles de contenido presentes. Si contiene `NDC`, cancelar exige `checkFlightTickets`. */
  readonly contentLanes: readonly SabreContentLane[];
  readonly retentionEndDate?: string;
  readonly warnings: readonly SabreBookingWarningCode[];
}

/**
 * Resultado de la lectura CARA. Unión discriminada a propósito: sin `narrowing` no se llega al
 * sello de versión, así que no hay forma de construir un write sobre una lectura que falló.
 */
export type SabreBookingForModification =
  | { readonly retrieved: false; readonly warnings: readonly SabreBookingWarningCode[] }
  | {
      readonly retrieved: true;
      readonly snapshot: SabreBookingSnapshot;
      readonly signature: string;
      readonly retrievedAt: string;
    };

export interface SabreGetBookingMapContext {
  /** ISO 8601. Se inyecta para que los tests sean deterministas. */
  readonly now?: string;
}

/** La respuesta no encaja con el contrato. El mensaje lleva **rutas de Zod, nunca valores**. */
export class SabreGetBookingMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(`respuesta de getBooking fuera de contrato (${issuePaths.join(', ') || '<root>'})`);
    this.name = 'SabreGetBookingMappingError';
  }
}

// ---------------------------------------------------------------------------------------------
// Zod en el borde de SALIDA del proveedor. Todo opcional salvo lo que el contrato marca
// `required`: una lectura con `returnOnly` devuelve un documento con casi todas las claves
// ausentes, y un schema estricto convertiría la proyección —que es la ruta barata y normal— en un
// fallo de mapeo.
// ---------------------------------------------------------------------------------------------

const StatusNameSchema = z.enum(SABRE_STATUS_NAMES);
const ItemIdSchema = z.string().regex(/^[A-Z0-9]+$/);

/** `FlightItem.airlineCode` — `:1911-1916`, IATA de dos caracteres. */
const AirlineCodeSchema = z.string().regex(/^[A-Z0-9]{2}$/);

/**
 * `FlightItem.confirmationId` — `:1896-1902`. **El patrón es `{5,}`, no `{6,}`**: el localizador
 * de una aerolínea puede tener cinco caracteres, y aplicarle el patrón del PNR de Sabre
 * (`^[A-Z0-9]{6,}$`) descartaría localizadores válidos. Son campos distintos con patrones
 * distintos, y ésa es justamente la confusión que RF-23 CA-2 existe para impedir.
 */
const AirlineLocatorSchema = z.string().regex(/^[A-Z0-9]{5,}$/);

/** `FlightTicket.number` / `Ticket.number` — `:3838-3842`. Admite `/` de billetes conjuntivos. */
const TicketNumberSchema = z.string().regex(/^[0-9A-Z/-]+$/);

const FlightSchema = z.object({
  itemId: ItemIdSchema.optional(),
  confirmationId: z.unknown().optional(),
  airlineCode: z.unknown().optional(),
  sourceType: z.enum(SABRE_CONTENT_LANES).optional(),
  flightStatusCode: z.string().optional(),
  flightStatusName: StatusNameSchema.optional(),
});

const ProductSchema = z.object({
  itemId: ItemIdSchema.optional(),
  hotelStatusCode: z.string().optional(),
  hotelStatusName: StatusNameSchema.optional(),
  carStatusCode: z.string().optional(),
  carStatusName: StatusNameSchema.optional(),
  trainStatusCode: z.string().optional(),
  trainStatusName: StatusNameSchema.optional(),
  cruiseStatusCode: z.string().optional(),
  cruiseStatusName: StatusNameSchema.optional(),
});

const FlightTicketSchema = z.object({
  number: z.unknown().optional(),
  travelerIndex: z.unknown().optional(),
});

const ProviderIssueSchema = z.object({
  category: z.string().optional(),
  type: z.string().optional(),
});

/**
 * `Booking` + los cuatro campos que `GetBookingResponse` le añade. `travelers` se declara como
 * array de `unknown`: **hace falta la longitud** para validar `flightTickets[].travelerIndex`
 * contra el array real, y nada más. Declararlo con su forma invitaría a leer un nombre.
 */
export const SabreGetBookingResponseSchema = z.object({
  bookingId: z.string().optional(),
  isCancelable: z.boolean().optional(),
  isTicketed: z.boolean().optional(),
  retentionEndDate: z.string().optional(),
  flights: z.array(FlightSchema).optional(),
  hotels: z.array(ProductSchema).optional(),
  cars: z.array(ProductSchema).optional(),
  trains: z.array(ProductSchema).optional(),
  cruises: z.array(ProductSchema).optional(),
  flightTickets: z.array(FlightTicketSchema).optional(),
  travelers: z.array(z.unknown()).optional(),
  bookingSignature: z.string().optional(),
  timestamp: z.string().optional(),
  errors: z.array(ProviderIssueSchema).optional(),
});

export type SabreGetBookingResponse = z.infer<typeof SabreGetBookingResponseSchema>;

function parseResponse(raw: unknown): SabreGetBookingResponse {
  const parsed = SabreGetBookingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreGetBookingMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }
  return parsed.data;
}

/** Añade sin repetir. Los avisos van a un log estructurado; repetirlos N veces no informa más. */
function addWarning(sink: SabreBookingWarningCode[], code: SabreBookingWarningCode): void {
  if (!sink.includes(code)) sink.push(code);
}

/**
 * RF-23: el localizador **de la aerolínea**, que no es el PNR de Sabre ni nuestro `orderId`.
 *
 * Sale de `flights[].confirmationId` + `flights[].airlineCode` (`:1896-1902`, cuyo `#source`
 * empalma explícitamente con `OrderViewResponse.order.externalOrders.bookingReference.id`). Es un
 * dato **por transportista**: una reserva interlínea tiene varios, y por eso el campo es array.
 *
 * Un vuelo sin `confirmationId` no es un error: en contenido no emitido la aerolínea aún no ha
 * dado código. Lo que no puede pasar es que el hueco sea invisible (RNF-13), así que la ausencia
 * total en una reserva emitida sale como aviso — ver {@link mapSabreGetBookingForDisplay}.
 */
function collectAirlineLocators(
  flights: readonly z.infer<typeof FlightSchema>[],
  warnings: SabreBookingWarningCode[],
): AirlineLocator[] {
  const locators: AirlineLocator[] = [];
  const seen = new Set<string>();

  for (const flight of flights) {
    if (flight.confirmationId === undefined) continue;

    const locator = AirlineLocatorSchema.safeParse(flight.confirmationId);
    if (!locator.success) {
      addWarning(warnings, 'airline-locator-malformed');
      continue;
    }
    const carrier = AirlineCodeSchema.safeParse(flight.airlineCode);
    if (!carrier.success) {
      // Un localizador sin transportista es inútil para el pasajero: no sabe a quién llamar ni en
      // qué web hacer el check-in. Se descarta en vez de publicarse a medias.
      addWarning(warnings, 'flight-without-airline-code');
      continue;
    }

    const key = `${carrier.data}|${locator.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push({ carrierCode: carrier.data, locator: locator.data });
  }

  return locators;
}

function collectItems(
  response: SabreGetBookingResponse,
  warnings: SabreBookingWarningCode[],
): SabreBookingItem[] {
  const items: SabreBookingItem[] = [];

  for (const flight of response.flights ?? []) {
    if (flight.itemId === undefined) continue;
    const item: {
      itemId: string;
      kind: SabreItemKind;
      statusName?: SabreStatusName;
      statusCode?: string;
      lane?: SabreContentLane;
    } = { itemId: flight.itemId, kind: 'FLIGHT' };
    if (flight.flightStatusName !== undefined) item.statusName = flight.flightStatusName;
    if (flight.flightStatusCode !== undefined) item.statusCode = flight.flightStatusCode;
    if (flight.sourceType !== undefined) item.lane = flight.sourceType;
    items.push(item);
  }

  const products: readonly [SabreItemKind, readonly z.infer<typeof ProductSchema>[]][] = [
    ['HOTEL', response.hotels ?? []],
    ['CAR', response.cars ?? []],
    ['TRAIN', response.trains ?? []],
    ['CRUISE', response.cruises ?? []],
  ];

  for (const [kind, list] of products) {
    for (const product of list) {
      if (product.itemId === undefined) continue;
      const statusName =
        product.hotelStatusName ??
        product.carStatusName ??
        product.trainStatusName ??
        product.cruiseStatusName;
      const statusCode =
        product.hotelStatusCode ??
        product.carStatusCode ??
        product.trainStatusCode ??
        product.cruiseStatusCode;
      const item: {
        itemId: string;
        kind: SabreItemKind;
        statusName?: SabreStatusName;
        statusCode?: string;
      } = { itemId: product.itemId, kind };
      if (statusName !== undefined) item.statusName = statusName;
      if (statusCode !== undefined) item.statusCode = statusCode;
      items.push(item);
    }
  }

  if ((response.flights ?? []).some((flight) => flight.itemId === undefined)) {
    // Un vuelo sin `itemId` no se puede cancelar selectivamente: sólo queda la vía frágil de
    // `segments[].sequence`, que se renumera. Quede constancia en vez de desaparecer de la lista.
    addWarning(warnings, 'flight-without-item-id');
  }

  return items;
}

function collectTicketNumbers(
  response: SabreGetBookingResponse,
  warnings: SabreBookingWarningCode[],
): string[] {
  const numbers: string[] = [];
  const travelerCount = response.travelers?.length;

  for (const ticket of response.flightTickets ?? []) {
    const number = TicketNumberSchema.safeParse(ticket.number);
    if (!number.success) {
      addWarning(warnings, 'ticket-number-malformed');
    } else if (!numbers.includes(number.data)) {
      numbers.push(number.data);
    }

    // `travelerIndex` es 1-BASED (`:3861-3867`, `minimum: 1`) y apunta a `travelers[]`. No se usa
    // para leer un nombre —esta vista no lleva personas— sino para detectar que el proveedor nos
    // manda un índice que no apunta a nadie, que es la señal de que el documento llegó
    // desalineado. Pasa por `indices.ts`, que es el único sitio con aritmética de índices.
    if (ticket.travelerIndex === undefined || travelerCount === undefined) continue;
    try {
      const index = parseSabreIndex(ticket.travelerIndex, 'flightTickets[].travelerIndex');
      if (toArrayPosition(index) >= travelerCount) {
        addWarning(warnings, 'traveler-index-out-of-range');
      }
    } catch (error) {
      if (!(error instanceof SabreIndexError)) throw error;
      addWarning(warnings, 'traveler-index-out-of-range');
    }
  }

  return numbers;
}

/**
 * Cancelada sólo si HAY ítems y **todos** están en `Cancelled`. Con cero ítems el resultado es
 * `NO_CONTENT`, nunca `CANCELLED`: no distinguiríamos una reserva vaciada de una lectura filtrada
 * que no pidió la sección.
 */
function resolveStatus(items: readonly SabreBookingItem[]): SabreBookingStatus {
  if (items.length === 0) return 'NO_CONTENT';
  return items.every((item) => item.statusName === SABRE_STATUS_CANCELLED) ? 'CANCELLED' : 'ACTIVE';
}

function buildSnapshot(
  response: SabreGetBookingResponse,
  warnings: SabreBookingWarningCode[],
): SabreBookingSnapshot {
  const flights = response.flights ?? [];
  const airlineLocators = collectAirlineLocators(flights, warnings);
  const items = collectItems(response, warnings);
  const ticketNumbers = collectTicketNumbers(response, warnings);
  const status = resolveStatus(items);

  // RF-23 CA-4: una reserva emitida sin ningún localizador es un DATO AUSENTE Y VISIBLE, no "la
  // aerolínea no da código". Sin este aviso, el mensaje de WhatsApp que cierra la venta le da al
  // cliente un código con el que NO puede hacer check-in y nadie se entera.
  if (response.isTicketed === true && airlineLocators.length === 0) {
    addWarning(warnings, 'airline-locator-absent');
  }

  if ((response.errors ?? []).length > 0) {
    // El texto del proveedor NO se copia: `description` puede arrastrar nombres. Que hubo issues
    // se dice; qué decían, lo cuenta el clasificador de `errors.ts` por su propio carril.
    addWarning(warnings, 'provider-reported-issue');
  }

  const view: OrderView = {
    found: true,
    airlineLocators,
    warnings: [...warnings],
    ...(response.bookingId === undefined ? {} : { orderId: response.bookingId }),
    ...(ticketNumbers.length === 0 ? {} : { ticketNumbers }),
    status,
  };

  return {
    view,
    status,
    items,
    contentLanes: [...new Set(flights.flatMap((f) => (f.sourceType ? [f.sourceType] : [])))],
    warnings: [...warnings],
    ...(response.isCancelable === undefined ? {} : { isCancelable: response.isCancelable }),
    ...(response.isTicketed === undefined ? {} : { isTicketed: response.isTicketed }),
    ...(response.retentionEndDate === undefined
      ? {}
      : { retentionEndDate: response.retentionEndDate }),
  };
}

/**
 * Lectura para PINTAR. Alimenta `retrieveForDisplay`.
 *
 * **Nunca devuelve la firma, aunque venga en el cuerpo.** Que venga significa que el request se
 * construyó sin `returnOnly` —o sea, que alguien pagó la lectura cara creyendo pagar la barata—,
 * así que se avisa con `booking-signature-in-display-response` y el valor se descarta. El tipo de
 * retorno no tiene dónde ponerla; el aviso está para que el bug se vea en vez de esconderse tras
 * una lectura que "funciona".
 */
export function mapSabreGetBookingForDisplay(raw: unknown): SabreBookingSnapshot {
  const response = parseResponse(raw);
  const warnings: SabreBookingWarningCode[] = [];
  if (response.bookingSignature !== undefined) {
    addWarning(warnings, 'booking-signature-in-display-response');
  }
  return buildSnapshot(response, warnings);
}

/**
 * Lectura para MODIFICAR. Alimenta `retrieveForModification`.
 *
 * La ausencia de firma es **fallo duro del paso**, no un campo opcional: el contrato dice
 * _"Available only if obtaining the booking state does not result in any errors"_ (`:309-313`), y
 * sin firma no hay `modifyBooking` posible. Devolver un snapshot "casi bueno" invitaría a
 * construir el write igualmente y a estrellarse contra
 * `UNABLE_TO_MODIFY_BOOKING_WRONG_SIGNATURE` con la reserva ya tocada.
 */
export function mapSabreGetBookingForModification(
  raw: unknown,
  ctx: SabreGetBookingMapContext = {},
): SabreBookingForModification {
  const response = parseResponse(raw);
  const warnings: SabreBookingWarningCode[] = [];
  const snapshot = buildSnapshot(response, warnings);

  if (response.bookingSignature === undefined || response.bookingSignature.length === 0) {
    addWarning(warnings, 'booking-signature-absent');
    return { retrieved: false, warnings: [...warnings] };
  }

  return {
    retrieved: true,
    snapshot,
    signature: response.bookingSignature,
    // El `timestamp` del proveedor es el instante en que Sabre generó la respuesta; es el momento
    // exacto al que se refiere la firma. Se prefiere al reloj nuestro cuando viene.
    retrievedAt: response.timestamp ?? ctx.now ?? new Date().toISOString(),
  };
}

/**
 * Al tipo del puerto. El `featureProfile` que acompaña a la firma es
 * {@link SABRE_EXTRA_FEATURES} y no un objeto recompuesto aquí: el contrato exige que el
 * `modifyBooking` mande **los mismos** flags que el `getBooking` previo (`:884-889`), y dos
 * lugares que construyan el perfil son dos lugares que pueden divergir.
 */
export function toOrderForModification(result: SabreBookingForModification): OrderForModification {
  if (!result.retrieved) return { retrieved: false, warnings: [...result.warnings] };
  return {
    retrieved: true,
    order: result.snapshot.view,
    versionStamp: {
      signature: result.signature,
      featureProfile: { ...SABRE_EXTRA_FEATURES },
      retrievedAt: result.retrievedAt,
    },
  };
}

/** Reserva inexistente o inaccesible. `found: false` con la forma que el puerto exige. */
export function notFoundOrderView(warnings: readonly string[] = []): OrderView {
  return { found: false, airlineLocators: [], warnings: [...warnings] };
}

// ---------------------------------------------------------------------------------------------
// Carril NDC de segunda llamada: `/v1/orders/view`
// ---------------------------------------------------------------------------------------------

/**
 * `bookingReferences[].carrierCode` **no siempre es un código IATA de dos letras**.
 *
 * En la respuesta real guardada conviven `F1` (dos) y `UAD` (tres, un identificador de sistema).
 * Aplicarle `^[A-Z]{2}$` —el patrón que sí usa `Booking.flights[].airlineCode`— descartaría la
 * mitad de los localizadores del único fixture real que tenemos. Son dos endpoints distintos con
 * vocabularios distintos (05 §11 lectura 5) y confundirlos cuesta datos.
 */
const OrdersViewCarrierCodeSchema = z.string().regex(/^[A-Z0-9]{2,4}$/);

/**
 * `/v1/orders/view` — **otro endpoint, otro modelo de datos**, y no está en
 * `booking-management-v1.yml`: pertenece a otro producto. Su vocabulario es NDC puro
 * (`order.orderItems[]`, `order.passengers[]`, `order.externalOrders[]`) frente al mixto de
 * `getBooking` (`flights[]`, `travelers[]`). No confundirlos (05 §11).
 */
const OrdersViewSchema = z.object({
  order: z
    .object({
      externalOrders: z
        .array(
          z.object({
            bookingReferences: z
              .array(z.object({ id: z.unknown().optional(), carrierCode: z.unknown().optional() }))
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * RF-23, carril NDC: los localizadores de aerolínea de `order.externalOrders[].bookingReferences[]`.
 *
 * Existe porque queda **abierto** (05 «Preguntas abiertas» nº 3, RF-23 CA-6) si `getBooking`
 * puebla `flights[].confirmationId` para contenido NDC o si hace falta esta segunda llamada. Si
 * hace falta, recuperar una orden NDC cuesta dos llamadas y hay que presupuestarlo; hasta
 * comprobarlo en CERT, esta función es la red de seguridad y **no se afirma que sea innecesaria**.
 *
 * El orden de la respuesta se preserva: es el orden en que el pasajero los ve.
 */
export function mapOrdersViewAirlineLocators(raw: unknown): AirlineLocator[] {
  const parsed = OrdersViewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreGetBookingMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }

  const locators: AirlineLocator[] = [];
  const seen = new Set<string>();

  for (const external of parsed.data.order?.externalOrders ?? []) {
    for (const reference of external.bookingReferences ?? []) {
      const locator = AirlineLocatorSchema.safeParse(reference.id);
      const carrier = OrdersViewCarrierCodeSchema.safeParse(reference.carrierCode);
      if (!locator.success || !carrier.success) continue;
      const key = `${carrier.data}|${locator.data}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locators.push({ carrierCode: carrier.data, locator: locator.data });
    }
  }

  return locators;
}
