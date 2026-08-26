import type { LoggerPort } from '@sales-travel/core';
import type { Itinerary, Offer, Segment } from '@sales-travel/canonical';
import type {
  BookingContactInfo,
  OrderCreatePort,
  OrderCreateRequest,
  OrderCreateResult,
  Passenger,
  SearchContext,
} from '@sales-travel/domain';
import {
  SABRE_CREATE_BOOKING_PATH,
  buildSabreCreateBookingRequest,
  type SabreAgencyInput,
  type SabreBookingProductInput,
  type SabreCreateBookingInput,
  type SabreCreateBookingPlan,
  type SabreDocumentType,
  type SabreFlightInput,
  type SabreGender,
  type SabrePartialFailureDomain,
  type SabreTitle,
  type SabreTravelerInput,
} from './booking/create.request.builder';
import type { MissingAirlineRequirement } from './booking/airline-requirements';
import {
  mapSabreCreateBookingResponse,
  type SabreCreateBookingMapped,
} from './booking/create.response.mapper';
import { sabreConversationIdPrefix, type SabreConfig } from './config';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { SABRE_RAW_KEYS } from './price/request.builder';
import { logRedacted, type SabreLogLevel } from './redaction';

/**
 * Adapter de `POST /v1/trip/orders/createBooking` — `OrderCreatePort` de `@sales-travel/domain`
 * sobre el builder y el mapper de `booking/` (docs/sabre/11 §8.1, RF-08).
 *
 * Hace tres cosas que el builder y el mapper no pueden hacer solos:
 *
 * 1. **Traduce el dominio al contrato.** `OrderCreateRequest` habla en `paxType: 'CHD'`,
 *    `title: 'Mr'` y un `identityDoc` singular; `createBooking` habla en `passengerCode: 'CNN'`,
 *    `TitleEnum` de 18 valores e `identityDocuments[]`. Esa traducción vive AQUÍ y no en el
 *    builder, que es el borde del contrato y no debe conocer nuestro dominio.
 * 2. **Elige el carril.** NDC si la oferta trae los identificadores de `offers/price`; ATPCO si
 *    trae itinerario. No hay un tercer caso silencioso: sin ninguna de las dos cosas, lanza.
 * 3. **Publica lo que hay que auditar.** `errorHandlingPolicy`, `asynchronousUpdateWaitTimeMs`,
 *    `advisories` y `hasBookingSignature` salen en {@link SabreOrderCreateOutcome} para que el
 *    `domain_event` los pueda citar (RNF-08). Un `PARTIAL` sin la política que se pidió es una
 *    reserva a medias que nadie puede explicar tres semanas después.
 *
 * **`createBooking` NO se reintenta.** Está en `SABRE_NON_IDEMPOTENT_PATHS`, así que el cliente
 * HTTP lo impide aunque quien llame pida `idempotent: true`; aquí ni se pide.
 */

/** El request no se puede construir a partir de esta oferta. Bug nuestro, no del proveedor. */
export class SabreOrderCreateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreOrderCreateInputError';
  }
}

export interface SabreOrderCreateDeps {
  readonly logger?: LoggerPort;
}

export interface SabreOrderCreateOptions {
  /**
   * Dominios cuyo fallo NO debe tumbar la reserva. **Vacío = `HALT_ON_ERROR`**, que es el default
   * del contrato y el nuestro. El éxito parcial es un modo que se ELIGE antes de llamar
   * (`booking-management-v1.yml:698`, `:8918-8935`), no una anomalía que se detecta después.
   */
  readonly partialFailureTolerance?: readonly SabrePartialFailureDomain[];
  readonly haltOnInvalidConnectingTime?: boolean;
  /**
   * Espera asíncrona en ms. **Siempre explícita**: con el default 0 del contrato (`:714-722`) la
   * respuesta puede llegar antes de que la reserva esté completa. Si se omite manda el default
   * del builder, que no es 0.
   */
  readonly asynchronousUpdateWaitTimeMs?: number;
  /** Reservar sin bloque `payment` (82 de 176 requests de la colección). */
  readonly omitPayment?: boolean;
  /** BYOC: reservar bajo el PCC de la sub-agencia. Exige `sabreGroup`/`sabreCurrentCity`. */
  readonly targetPcc?: string;
  readonly receivedFrom?: string;
  readonly agency?: SabreAgencyInput;
  /**
   * Estado con el que se piden los vuelos ATPCO. Default `NN` — el del contrato (`:5216`,
   * `default: NN`). `YK` construye una **pasiva** y no se pone por accidente.
   */
  readonly flightStatusCode?: string;
}

/**
 * Lo que la creación entrega arriba: el resultado del dominio MÁS las decisiones que se tomaron
 * al mandarlo. Las decisiones no son adorno de log: son lo que el `domain_event` cita.
 */
export interface SabreOrderCreateOutcome {
  readonly result: OrderCreateResult;
  /** La política que se mandó, tal cual viajó en el body. */
  readonly errorHandlingPolicy: readonly string[];
  readonly asynchronousUpdateWaitTimeMs: number;
  /** Requisitos de aerolínea que faltan y no bloquean. Sólo nombres de campo, nunca valores. */
  readonly advisories: readonly string[];
  readonly carriers: readonly string[];
  /**
   * Siempre `false`. `createBooking` no devuelve `bookingSignature`, así que toda modificación
   * posterior exige encadenar un `getBooking`. Es la señal de que el paso de verificación del
   * saga no es opcional.
   */
  readonly hasBookingSignature: boolean;
  readonly conversationId: string;
  readonly timestamp?: string;
  /**
   * Lo que se puede persistir en `orders.provider_raw` **sin PAN y sin PII**: la reserva no
   * viaja entera. Ver {@link providerRawOf}.
   */
  readonly providerRaw: Record<string, unknown>;
}

export class SabreOrderCreateAdapter implements OrderCreatePort {
  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreOrderCreateDeps = {},
  ) {}

  /** El puerto del dominio. Quien necesite auditar la llamada usa {@link createBooking}. */
  async createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult> {
    return (await this.createBooking(request, ctx)).result;
  }

  /** La creación completa, con las decisiones que se tomaron al mandarla. */
  async createBooking(
    request: OrderCreateRequest,
    ctx: SearchContext,
    options: SabreOrderCreateOptions = {},
  ): Promise<SabreOrderCreateOutcome> {
    const plan = this.plan(request, options);

    // Sin `idempotent`. No es que sobre: es que decirlo sería mentir sobre lo que pasa si hay un
    // timeout. Un `ERR.2SG.GATEWAY.TIMEOUT` en createBooking no dice si el PNR se creó, y quien
    // decide qué hacer entonces es el saga, releyendo con getBooking.
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(plan.path, plan.body, {
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    });

    const mapped: SabreCreateBookingMapped = mapSabreCreateBookingResponse(result.data);
    const advisories = plan.advisories.map(describeAdvisory);

    this.log(mapped.order.outcome === 'CONFIRMED' ? 'debug' : 'warn', 'sabre.createBooking', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      outcome: mapped.order.outcome,
      // La política aplicada va en CADA línea, no sólo en el evento: leer un `PARTIAL` sin saber
      // qué se pidió tolerar no permite decidir si hay que compensar.
      errorHandlingPolicy: [...plan.errorHandlingPolicy],
      asynchronousUpdateWaitTimeMs: plan.asynchronousUpdateWaitTimeMs,
      items: mapped.order.items.length,
      issues: mapped.order.issues.length,
      hasBookingSignature: mapped.hasBookingSignature,
      ...(advisories.length === 0 ? {} : { advisories }),
    });

    return {
      result: mapped.order,
      errorHandlingPolicy: [...plan.errorHandlingPolicy],
      asynchronousUpdateWaitTimeMs: plan.asynchronousUpdateWaitTimeMs,
      advisories,
      carriers: plan.carriers,
      hasBookingSignature: mapped.hasBookingSignature,
      conversationId: result.conversationId,
      ...(mapped.timestamp === undefined ? {} : { timestamp: mapped.timestamp }),
      providerRaw: providerRawOf(mapped, plan, result.conversationId),
    };
  }

  /**
   * Traduce y construye, **sin tocar la red**. Se expone para que un test pueda ejercitar la
   * traducción por la puerta pública sin montar un `fetch` falso.
   */
  plan(request: OrderCreateRequest, options: SabreOrderCreateOptions = {}): SabreCreateBookingPlan {
    const input: SabreCreateBookingInput = {
      product: productOf(request.offer, options.flightStatusCode ?? DEFAULT_FLIGHT_STATUS_CODE),
      travelers: request.passengers.map(travelerOf),
      contactInfo: contactInfoOf(request.contactInfo),
      carriers: carriersOf(request.offer),
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(options.receivedFrom === undefined ? {} : { receivedFrom: options.receivedFrom }),
      ...(options.agency === undefined ? {} : { agency: options.agency }),
    };

    return buildSabreCreateBookingRequest(input, this.cfg, {
      partialFailureTolerance: [...(options.partialFailureTolerance ?? [])],
      ...(options.haltOnInvalidConnectingTime === undefined
        ? {}
        : { haltOnInvalidConnectingTime: options.haltOnInvalidConnectingTime }),
      ...(options.asynchronousUpdateWaitTimeMs === undefined
        ? {}
        : { asynchronousUpdateWaitTimeMs: options.asynchronousUpdateWaitTimeMs }),
      ...(options.omitPayment === undefined ? {} : { omitPayment: options.omitPayment }),
    });
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/**
 * Un requisito de aerolínea que falta y no bloquea, en una línea sin valores.
 *
 * Se citan `id`, `carrier`, `field` y severidad — nombres de regla y de campo, vocabulario
 * cerrado. `reason` no entra: es texto libre, y el `field` ya dice qué falta.
 */
function describeAdvisory(item: MissingAirlineRequirement): string {
  return `${item.id}/${item.carrier}/${item.field}/${item.severity}`;
}

/** `FlightStatusCode` por defecto del contrato (`booking-management-v1.yml:5216`). */
export const DEFAULT_FLIGHT_STATUS_CODE = 'NN';

// ---------------------------------------------------------------------------------------------
// Traducción dominio → contrato
// ---------------------------------------------------------------------------------------------

/**
 * `Passenger.paxType` → `travelers[].passengerCode` (`^[A-Z][A-Z0-9]{2}$`).
 *
 * `CHD` → **`CNN`**. No es un capricho de nomenclatura: `CNN` es el PTC de niño en Sabre y
 * mandar `CHD` tarifica como adulto o rebota, según la aerolínea.
 */
const PASSENGER_CODE_BY_PAX_TYPE = {
  ADT: 'ADT',
  CHD: 'CNN',
  INF: 'INF',
} as const satisfies Record<Passenger['paxType'], string>;

/**
 * `Passenger.title` → `TitleEnum`. Los cuatro títulos del dominio existen literalmente en el enum
 * de 18 valores del contrato, así que el mapa es la identidad — escrito, y no asumido, para que
 * añadir un título al dominio que Sabre no tenga se vea como un error de compilación.
 */
const TITLE_BY_DOMAIN_TITLE = {
  Mr: 'Mr',
  Mrs: 'Mrs',
  Miss: 'Miss',
  Dr: 'Dr',
} as const satisfies Record<NonNullable<Passenger['title']>, SabreTitle>;

/**
 * `Passenger.identityDoc.type` → `DocumentTypeEnum`.
 *
 * `DNI` y `CC` (cédula de ciudadanía) caen en `NATIONAL_ID_CARD`; `CE` (cédula de extranjería)
 * en `ALIEN_RESIDENT`, que es lo que describe: un residente que no es nacional. El enum del
 * contrato **no tiene** un valor propio para ninguno de los tres documentos LATAM, así que esta
 * tabla es una equivalencia razonada y no una correspondencia declarada por Sabre. Está
 * pendiente de confirmar contra CERT, igual que el hueco de `DocumentSubTypeEnum` para el ID
 * fiscal CO/PE/BR (docs/sabre/04 §3.4.2.1).
 */
const DOCUMENT_TYPE_BY_DOMAIN_TYPE = {
  P: 'PASSPORT',
  DNI: 'NATIONAL_ID_CARD',
  CC: 'NATIONAL_ID_CARD',
  CE: 'ALIEN_RESIDENT',
} as const satisfies Record<Passenger['identityDoc']['type'], SabreDocumentType>;

/**
 * `M`/`F` → `GenderEnum`, con la variante de infante.
 *
 * Los valores `INFANT_*` no son decorativos: Secure Flight los exige para un pasajero sin asiento
 * y mandar `MALE` para un `INF` es lo que devuelve un requisito de aerolínea incumplido.
 */
function genderOf(passenger: Passenger): SabreGender {
  if (passenger.paxType === 'INF')
    return passenger.gender === 'F' ? 'INFANT_FEMALE' : 'INFANT_MALE';
  return passenger.gender === 'F' ? 'FEMALE' : 'MALE';
}

function travelerOf(passenger: Passenger): SabreTravelerInput {
  const doc = passenger.identityDoc;
  return {
    givenName: passenger.givenName,
    surname: passenger.surname,
    birthDate: passenger.birthdate,
    gender: genderOf(passenger),
    passengerCode: PASSENGER_CODE_BY_PAX_TYPE[passenger.paxType],
    ...(passenger.title === undefined ? {} : { title: TITLE_BY_DOMAIN_TITLE[passenger.title] }),
    // `providerPaxId` es el id que EMITIÓ el proveedor en el paso de precio. Si no lo hay no se
    // inventa uno nuestro: el contrato se contradice sobre quién lo elige (ver `Passenger`), y un
    // id inventado que Sabre no reconozca rompe la referencia entre traveler y offerItem.
    ...(passenger.providerPaxId === undefined
      ? {}
      : { providerTravelerId: passenger.providerPaxId }),
    identityDocuments: [
      {
        documentType: DOCUMENT_TYPE_BY_DOMAIN_TYPE[doc.type],
        documentNumber: doc.number,
        expiryDate: doc.expiryDate,
        issuingCountryCode: doc.issuingCountryCode,
        citizenshipCountryCode: passenger.citizenshipCountryCode,
        ...(doc.issueDate === undefined ? {} : { issueDate: doc.issueDate }),
      },
    ],
    ...(passenger.loyaltyProgramAccount === undefined
      ? {}
      : {
          loyaltyPrograms: [
            {
              programNumber: passenger.loyaltyProgramAccount.accountNumber,
              ...(passenger.loyaltyProgramAccount.airlineDesigCode === undefined
                ? {}
                : { supplierCode: passenger.loyaltyProgramAccount.airlineDesigCode }),
            },
          ],
        }),
  };
  // `linkedInfantPosition` NO se rellena: el dominio no dice con qué adulto viaja cada infante, y
  // elegir "el primer adulto" sería inventar un dato que acaba impreso en un billete. Quien lo
  // sepa lo pasa por el builder, que sí lo admite.
}

/**
 * `phone` del dominio → `^[0-9+-]+$` del contrato.
 *
 * Se quitan **sólo separadores visuales** —espacios, paréntesis, puntos— porque son formato de
 * presentación y no dígitos del número. Nada más: si después de eso queda un carácter que el
 * contrato no admite, el builder lanza. Truncar o sustituir dígitos sería cambiar el teléfono del
 * pasajero para que un regex pase, y entonces la aerolínea no lo puede localizar.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/[\s().]/g, '');
}

function contactInfoOf(contact: BookingContactInfo): SabreCreateBookingInput['contactInfo'] {
  const phone = normalizePhone(contact.phone);
  return {
    ...(contact.email.length === 0 ? {} : { emails: [contact.email] }),
    ...(phone.length === 0 ? {} : { phones: [phone] }),
  };
}

/** Los tramos de la oferta, en orden, aplanados sobre todos los itinerarios. */
function segmentsOf(offer: Offer): readonly Segment[] {
  const itineraries: readonly Itinerary[] = offer.itineraries ?? [];
  return itineraries.flatMap((itinerary) => itinerary.segments);
}

/** Aerolíneas comercializadoras. Es lo que evalúa la tabla de requisitos por aerolínea. */
function carriersOf(offer: Offer): string[] {
  return [...new Set(segmentsOf(offer).map((segment) => segment.carrier.toUpperCase()))];
}

/** Lista de strings de `provider.raw`, o `null` si la llave no está. Nunca inventa. */
function rawIds(offer: Offer, key: string): string[] | null {
  const value = (offer.provider.raw ?? {})[key];
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.filter((entry): entry is string => typeof entry === 'string');
  return ids.length === value.length ? ids : null;
}

function rawId(offer: Offer, key: string): string | null {
  const value = (offer.provider.raw ?? {})[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Elige el carril y construye el bloque de producto.
 *
 * **NDC gana si la oferta trae los identificadores de `offers/price`.** No es una preferencia:
 * `flightOffer` y `flightDetails` son mutuamente excluyentes, y una oferta que ya pasó por price
 * tiene un `offerId` con reloj —lo que Sabre espera que se reserve— mientras que reconstruir sus
 * vuelos como ATPCO reservaría otra cosa al precio de la búsqueda.
 *
 * Sin ids de price y sin itinerario **lanza**. El fallback que fabrica un id —el que tiene el ACL
 * de LATAM— no arregla nada: mueve el fallo al paso de reserva, con el cliente delante.
 */
function productOf(offer: Offer, flightStatusCode: string): SabreBookingProductInput {
  const offerId = rawId(offer, SABRE_RAW_KEYS.priceOfferId);
  const offerItemIds = rawIds(offer, SABRE_RAW_KEYS.priceOfferItemIds);
  const segments = segmentsOf(offer);

  if (offerId !== null && offerItemIds !== null) {
    return {
      kind: 'ndc',
      offerId,
      selectedOfferItems: offerItemIds,
      ...(segments.length === 0 ? {} : { segmentCount: segments.length }),
    };
  }

  if (offerId !== null || offerItemIds !== null) {
    throw new SabreOrderCreateInputError(
      `la oferta trae sólo la mitad de la cadena de identificadores de offers/price ` +
        `(${SABRE_RAW_KEYS.priceOfferId}: ${String(offerId !== null)}, ` +
        `${SABRE_RAW_KEYS.priceOfferItemIds}: ${String(offerItemIds !== null)}): ` +
        'reservar con media cadena es reservar otra cosa',
    );
  }

  if (segments.length === 0) {
    throw new SabreOrderCreateInputError(
      'la oferta no trae ni los identificadores de offers/price ni itinerario: no hay nada que ' +
        'reservar (revalidá con offers/price antes de crear la reserva)',
    );
  }

  return { kind: 'atpco', flights: segments.map((s) => flightOf(s, flightStatusCode)) };
}

/**
 * `Segment` canónico → `flights[]` de `flightDetails`.
 *
 * `departureAt` es ISO 8601 **con offset** por contrato del canónico, y de ahí salen `YYYY-MM-DD`
 * y `HH:MM` **locales del aeropuerto de salida**, que es lo que Sabre espera. Por eso se parte el
 * string y no se pasa por `Date`: `new Date(...)` los convertiría a UTC y adelantaría o atrasaría
 * el vuelo hasta un día entero.
 */
function flightOf(segment: Segment, flightStatusCode: string): SabreFlightInput {
  const departure = splitLocalIso(segment.departureAt, 'departureAt');
  const arrival = splitLocalIso(segment.arrivalAt, 'arrivalAt');
  const flightNumber = Number.parseInt(segment.flightNumber, 10);
  if (!Number.isInteger(flightNumber) || flightNumber < 1) {
    throw new SabreOrderCreateInputError(
      'el número de vuelo del segmento no es un entero reservable (createBooking lo exige numérico)',
    );
  }

  return {
    flightNumber,
    airlineCode: segment.carrier.toUpperCase(),
    fromAirportCode: segment.origin,
    toAirportCode: segment.destination,
    departureDate: departure.date,
    departureTime: departure.time,
    arrivalDate: arrival.date,
    arrivalTime: arrival.time,
    bookingClass: segment.bookingClass,
    flightStatusCode,
  };
}

/** `2026-08-15T14:30:00-05:00` → `{ date: '2026-08-15', time: '14:30' }`. Sin pasar por `Date`. */
function splitLocalIso(value: string, field: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new SabreOrderCreateInputError(
      `${field} del segmento no es ISO 8601 con hora: no se puede derivar la fecha local del vuelo`,
    );
  }
  return { date: match[1], time: match[2] };
}

/**
 * Lo que se persiste en `orders.provider_raw`.
 *
 * Es una lista BLANCA, no un volcado con campos quitados. Un volcado de la respuesta de
 * `createBooking` arrastra `request` —el eco íntegro de lo que mandamos, con la PII de los
 * viajeros— y, si algún día se activara el flag de tarjeta, el bloque de pago. Aquí sólo entran
 * identificadores de reserva, estados y las decisiones de la llamada; ni nombres, ni documentos,
 * ni PAN, ni texto libre del proveedor.
 */
export function providerRawOf(
  mapped: SabreCreateBookingMapped,
  plan: SabreCreateBookingPlan,
  conversationId: string,
): Record<string, unknown> {
  return {
    provider: 'sabre',
    operation: SABRE_CREATE_BOOKING_PATH,
    conversationId,
    outcome: mapped.order.outcome,
    ...(mapped.order.pnr === undefined ? {} : { pnr: mapped.order.pnr }),
    ...(mapped.order.orderId === undefined ? {} : { orderId: mapped.order.orderId }),
    ...(mapped.timestamp === undefined ? {} : { timestamp: mapped.timestamp }),
    hasBookingSignature: mapped.hasBookingSignature,
    errorHandlingPolicy: [...plan.errorHandlingPolicy],
    asynchronousUpdateWaitTimeMs: plan.asynchronousUpdateWaitTimeMs,
    carriers: [...plan.carriers],
    items: mapped.order.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      ...(item.providerItemId === undefined ? {} : { providerItemId: item.providerItemId }),
      ...(item.statusCode === undefined ? {} : { statusCode: item.statusCode }),
    })),
    // `message` y `fieldValue` NO se copian: `fieldValue` es el valor que mandamos —documento del
    // pasajero— devuelto tal cual, y `message` es texto libre del proveedor.
    issues: mapped.order.issues.map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      type: issue.type,
      ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
    })),
  };
}
