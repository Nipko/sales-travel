import type { LoggerPort } from '@sales-travel/core';
import type { Itinerary, Offer, Segment } from '@sales-travel/canonical';
import type {
  BookingContactInfo,
  OrderCreatePort,
  OrderCreateRequest,
  OrderCreateResult,
  OrderItemKind,
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
  type SabrePricingInput,
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
 * 3. **Publica lo que hay que auditar.** El caso de uso elegido, la tolerancia que produjo,
 *    `errorHandlingPolicy`, `asynchronousUpdateWaitTimeMs`, `advisories`, `hasBookingSignature` y
 *    el veredicto de fallo parcial salen en {@link SabreOrderCreateOutcome} para que el
 *    `domain_event` los pueda citar (RNF-08). Un `PARTIAL` sin la política que se pidió es una
 *    reserva a medias que nadie puede explicar tres semanas después.
 *
 * Y una regla de negocio que gobierna las tres: **un fallo de accesorio nunca cancela el
 * producto.** Cancelar un vuelo confirmado porque no había asiento deja al cliente sin viaje —la
 * tarifa puede haber desaparecido— por culpa de un extra. Por eso la tolerancia no se pide como una
 * lista suelta de dominios sino como un **caso de uso** ({@link SabreBookingUseCase}), que es lo que
 * dice de qué DEPENDE la compra, y por eso el resultado vuelve con el veredicto ya hecho
 * ({@link SabrePartialFailureVerdict}) en vez de dejar que cada saga lo reinvente.
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

// ---------------------------------------------------------------------------------------------
// El caso de uso: quién decide qué es accesorio
// ---------------------------------------------------------------------------------------------

/**
 * Qué se está vendiendo, y por tanto **de qué depende la compra**.
 *
 * El éxito parcial es un modo que se ELIGE antes de llamar (`booking-management-v1.yml:698`,
 * `:8918-8940`), no una anomalía que se detecta después. Pero elegirlo como una lista suelta de
 * dominios deja la decisión sin dueño: cualquiera puede tolerar cualquier cosa y nada queda escrito
 * sobre por qué. Aquí se pide por caso de uso, que es una frase que alguien puede defender.
 *
 *  - **`FLIGHT_ONLY`** — venta de vuelo suelto. Nada es accesorio: `HALT_ON_ERROR`. Un vuelo a
 *    medias no es vendible (docs/sabre/04 §5.4).
 *  - **`FLIGHT_WITH_EXTRAS`** — vuelo con extras dentro de la misma oferta (asiento o ancillary de
 *    los `selectedOfferItems` de NDC). El vuelo es la compra; el extra es accesorio y su fallo no
 *    la tumba. Es literalmente el caso «perder el 12A no debe tumbar la venta»: el extra se
 *    reintenta después contra el PNR ya creado.
 *
 * Lo que NO hay, y por qué:
 *
 *  - **Ningún caso de uso tolera `PRICING`.** `DO_NOT_HALT_ON_FLIGHT_PRICING_ERROR` deja el PNR
 *    **sin price quote** y el billete puede emitirse a otra tarifa (docs/sabre/04 §5.1). El precio
 *    no es un accesorio: es aquello de lo que la compra depende. Quien lo necesite alguna vez lo
 *    pedirá por el builder, con una razón escrita, no por aquí.
 *  - **Ninguno tolera `IDENTITY_DOC_WARNING`.** Un aviso de documento habla de si el pasajero puede
 *    embarcar, no de un extra: seguir adelante es vender un viaje que quizá no se pueda hacer.
 *  - `HOTEL` y `CAR` ya no existen en el vocabulario del builder: éste es el carril aéreo y un body
 *    salido de él no lleva esos bloques.
 */
export const SABRE_BOOKING_USE_CASES = ['FLIGHT_ONLY', 'FLIGHT_WITH_EXTRAS'] as const;

export type SabreBookingUseCase = (typeof SABRE_BOOKING_USE_CASES)[number];

/**
 * Caso de uso → dominios que ese caso declara accesorios.
 *
 * Es la ÚNICA tabla que decide qué se tolera. El orden dentro de cada lista da igual: el builder
 * reordena las políticas al orden del enum del contrato para que dos llamadas equivalentes
 * produzcan el mismo array y el `domain_event` sea comparable.
 */
export const SABRE_TOLERANCE_BY_USE_CASE = {
  FLIGHT_ONLY: [],
  FLIGHT_WITH_EXTRAS: ['ANCILLARY', 'SEAT'],
} as const satisfies Record<SabreBookingUseCase, readonly SabrePartialFailureDomain[]>;

/** Sin caso de uso declarado, nada es accesorio. El default seguro es no tolerar nada. */
export const SABRE_DEFAULT_BOOKING_USE_CASE: SabreBookingUseCase = 'FLIGHT_ONLY';

/**
 * Tolerancia → el `kind` de ítem cuyo fallo esa tolerancia declara accesorio.
 *
 * `null` significa «este dominio no nombra ningún ítem de la orden»: `PRICING` es una propiedad del
 * PNR entero e `IDENTITY_DOC_WARNING` habla de un traveler, y ninguno de los dos aparece en
 * `OrderCreateResult.items[]`. Escribirlos con `null` en vez de omitirlos no es adorno: el
 * `satisfies` obliga a decidir qué hacer con cualquier dominio nuevo en vez de dejarlo caer en el
 * silencio de un `Partial<Record<…>>`.
 */
const ACCESSORY_ITEM_KIND_BY_TOLERANCE = {
  PRICING: null,
  ANCILLARY: 'ancillary',
  SEAT: 'seat',
  IDENTITY_DOC_WARNING: null,
} as const satisfies Record<SabrePartialFailureDomain, OrderItemKind | null>;

export interface SabreOrderCreateOptions {
  /**
   * Qué se está vendiendo. **Default `FLIGHT_ONLY`**: sin decirlo, nada es accesorio y la política
   * es `HALT_ON_ERROR`, que es el default del contrato y el nuestro.
   */
  readonly useCase?: SabreBookingUseCase;
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
   * `default: NN`). `YK` construye una **pasiva** y no se pone por accidente: además de registrar
   * un segmento reservado fuera de Sabre, es lo único que hace que la reserva salga SIN cotizar
   * (ver {@link productOf}).
   */
  readonly flightStatusCode?: string;
}

/**
 * Qué falló, leído contra lo que el caso de uso declaró accesorio.
 *
 * Existe porque la política de tolerancia sin veredicto es media función: se elige tolerar el fallo
 * del asiento, la política viaja al cable, Sabre devuelve `200` con la reserva y `errors[]` al
 * lado… y arriba nadie sabe si eso obliga a compensar. Aquí se decide UNA vez, con la lista de
 * accesorios que se pidió, y el resultado se registra.
 */
export interface SabrePartialFailureVerdict {
  /** `kind` de los ítems `FAILED` que el caso de uso declaró accesorios. No cancelan la compra. */
  readonly accessoryFailures: readonly OrderItemKind[];
  /** `kind` de los ítems `FAILED` que NO son accesorios: de eso depende la compra. */
  readonly dependencyFailures: readonly OrderItemKind[];
  /**
   * La señal que dispara la compensación: `dependencyFailures.length > 0`.
   *
   * ⚠️ **Se dispara por un fallo DEMOSTRADO, no por un desenlace parcial cualquiera.** Es la
   * dirección que fija la regla de negocio: compensar de más significa cancelar un vuelo confirmado
   * —y la tarifa puede no volver—, mientras que compensar de menos deja un extra colgando que se
   * puede deshacer después. Un `errors[]` que no llegue a marcar ningún ítem como fallido **no**
   * pone esto a `true`; para eso está {@link hasUnattributedErrors}.
   */
  readonly dependencyFailed: boolean;
  /**
   * Hay incidencias de severidad `ERROR` y ningún ítem fallido que las explique.
   *
   * Es el borde honesto de este veredicto: `ProviderIssue` trae `category`/`type`/`fieldPath`, y
   * atribuir esos códigos a un dominio de producto exigiría una taxonomía que no tenemos verificada
   * contra CERT. Cuando esto viene a `true` la decisión NO está tomada: hay que releer la reserva
   * con `getBooking` —que además es obligatorio para modificar, porque `createBooking` no devuelve
   * `bookingSignature`— y mirar `result.issues`.
   */
  readonly hasUnattributedErrors: boolean;
}

/**
 * Lo que la creación entrega arriba: el resultado del dominio MÁS las decisiones que se tomaron
 * al mandarlo. Las decisiones no son adorno de log: son lo que el `domain_event` cita.
 */
export interface SabreOrderCreateOutcome {
  readonly result: OrderCreateResult;
  /** El caso de uso con el que se llamó. Es la decisión, en el vocabulario en que se tomó. */
  readonly useCase: SabreBookingUseCase;
  /** Los dominios que ese caso de uso declaró accesorios, antes de traducirlos al enum de Sabre. */
  readonly partialFailureTolerance: readonly SabrePartialFailureDomain[];
  /** Qué falló y si obliga a compensar, resuelto contra la tolerancia que se pidió. */
  readonly failures: SabrePartialFailureVerdict;
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
    const useCase = options.useCase ?? SABRE_DEFAULT_BOOKING_USE_CASE;
    const tolerance = toleranceOf(useCase);
    const failures = classifySabrePartialFailure(mapped.order, tolerance);

    this.log(mapped.order.outcome === 'CONFIRMED' ? 'debug' : 'warn', 'sabre.createBooking', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      outcome: mapped.order.outcome,
      // La política aplicada va en CADA línea, no sólo en el evento: leer un `PARTIAL` sin saber
      // qué se pidió tolerar no permite decidir si hay que compensar. Y el caso de uso va al lado,
      // porque es el vocabulario en el que se tomó la decisión: `errorHandlingPolicy` dice qué se
      // mandó, `useCase` dice por qué.
      useCase,
      errorHandlingPolicy: [...plan.errorHandlingPolicy],
      asynchronousUpdateWaitTimeMs: plan.asynchronousUpdateWaitTimeMs,
      items: mapped.order.items.length,
      issues: mapped.order.issues.length,
      dependencyFailed: failures.dependencyFailed,
      hasBookingSignature: mapped.hasBookingSignature,
      ...(advisories.length === 0 ? {} : { advisories }),
    });

    return {
      result: mapped.order,
      useCase,
      partialFailureTolerance: tolerance,
      failures,
      errorHandlingPolicy: [...plan.errorHandlingPolicy],
      asynchronousUpdateWaitTimeMs: plan.asynchronousUpdateWaitTimeMs,
      advisories,
      carriers: plan.carriers,
      hasBookingSignature: mapped.hasBookingSignature,
      conversationId: result.conversationId,
      ...(mapped.timestamp === undefined ? {} : { timestamp: mapped.timestamp }),
      providerRaw: providerRawOf(mapped, plan, result.conversationId, useCase, tolerance, failures),
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
      partialFailureTolerance: [...toleranceOf(options.useCase ?? SABRE_DEFAULT_BOOKING_USE_CASE)],
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

/**
 * El `flightStatusCode` que construye una **pasiva**: un segmento reservado FUERA de Sabre que sólo
 * se registra (`booking-management-v1.yml:5221`, docs/sabre/04 §2 `createBooking - Passive Air
 * segment`). Es el único caso en el que este adapter no cotiza — ver {@link productOf}.
 */
export const SABRE_PASSIVE_FLIGHT_STATUS_CODE = 'YK';

// ---------------------------------------------------------------------------------------------
// Tolerancia y veredicto
// ---------------------------------------------------------------------------------------------

/**
 * Los dominios que el caso de uso declara accesorios. Se devuelve una copia, para que nadie mute
 * la tabla.
 *
 * El caso de uso se comprueba en tiempo de ejecución además de en el tipo: un llamador en
 * JavaScript puro —o un `unknown` que cruce un borde sin parsear— acabaría indexando la tabla con
 * una llave que no existe, y `[...undefined]` revienta con un `TypeError` que no dice nada. Aquí
 * falla con el error tipado del adapter y nombrando el campo.
 */
function toleranceOf(useCase: SabreBookingUseCase): readonly SabrePartialFailureDomain[] {
  const tolerance = SABRE_TOLERANCE_BY_USE_CASE[useCase] as
    | readonly SabrePartialFailureDomain[]
    | undefined;
  if (tolerance === undefined) {
    throw new SabreOrderCreateInputError(
      `useCase no es uno de los casos de uso declarados (${SABRE_BOOKING_USE_CASES.join(', ')}): ` +
        'la tolerancia a fallo parcial no se elige campo a campo, se elige por caso de uso',
    );
  }
  return [...tolerance];
}

/**
 * Clasifica lo que falló contra lo que se declaró accesorio.
 *
 * Sólo cuenta `status === 'FAILED'`. **`UNCONFIRMED` no es `FAILED`**: el ítem existe en la reserva
 * y el proveedor no lo dio por confirmado —lista de espera, `NN` pendiente de respuesta de la
 * aerolínea—, y colapsar los dos lleva a cancelar lo que todavía podía confirmarse. Es la misma
 * distinción que ya fija `classifyItemStatus` en el mapper, y aquí no se vuelve a decidir.
 *
 * Se expone para poder ejercitarla desde un test sin montar una respuesta HTTP, pero el camino de
 * producción es {@link SabreOrderCreateAdapter.createBooking}, que es por donde entran los tests
 * que importan.
 */
export function classifySabrePartialFailure(
  result: OrderCreateResult,
  tolerance: readonly SabrePartialFailureDomain[],
): SabrePartialFailureVerdict {
  const accessoryKinds = new Set<OrderItemKind>();
  for (const domain of tolerance) {
    const kind = ACCESSORY_ITEM_KIND_BY_TOLERANCE[domain];
    if (kind !== null) accessoryKinds.add(kind);
  }

  const failed = result.items.filter((item) => item.status === 'FAILED');
  const accessoryFailures = failed
    .filter((item) => accessoryKinds.has(item.kind))
    .map((item) => item.kind);
  const dependencyFailures = failed
    .filter((item) => !accessoryKinds.has(item.kind))
    .map((item) => item.kind);
  const errors = result.issues.filter((issue) => issue.severity === 'ERROR');

  return {
    accessoryFailures,
    dependencyFailures,
    dependencyFailed: dependencyFailures.length > 0,
    hasUnattributedErrors: errors.length > 0 && failed.length === 0,
  };
}

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

/**
 * Un campo opcional, o nada.
 *
 * Existe porque `undefined` y `''` llegan aquí queriendo decir lo mismo —«no lo rellené»— y sólo
 * uno de los dos es inofensivo. El ACL es el borde: lo que salga de aquí va al cable.
 */
function opcional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  const limpio = value?.trim();
  return limpio === undefined || limpio.length === 0 ? {} : { [key]: limpio };
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
        issuingCountryCode: doc.issuingCountryCode,
        citizenshipCountryCode: passenger.citizenshipCountryCode,
        // El TITULAR, repetido dentro del documento. Parece redundante —el traveler ya los
        // lleva— y no lo es: Sabre rechazaba la reserva con `MANDATORY_DATA_MISSING` sobre
        // `travelers[0].identityDocuments[0]` sin decir qué campo faltaba, porque no es el
        // esquema quien lo exige (su único `required` es `documentType`) sino el carrier.
        //
        // Lo dice la evidencia: de los 115 documentos de los `createBooking` reales de la
        // colección, los 45 pasaportes llevan estos cuatro campos SIN EXCEPCIÓN, y `birthDate`
        // y `gender` aparecen en 79 y 80 del total. No es un extra de algunos carriers: es la
        // forma normal de un documento en este contrato.
        givenName: passenger.givenName,
        surname: passenger.surname,
        birthDate: passenger.birthdate,
        gender: genderOf(passenger),
        // Los opcionales se OMITEN cuando vienen en blanco, no se mandan vacíos. Un `''` que
        // sale de un formulario significa «no lo rellené», nunca «el valor es la cadena vacía»,
        // y el contrato de Sabre no distingue: `expiryDate: ''` es `invalid_string` y tumba la
        // reserva entera. Pasó: nadie podía reservar con cédula, que no vence.
        ...opcional('expiryDate', doc.expiryDate),
        ...opcional('issueDate', doc.issueDate),
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
 *
 * **El carril ATPCO cotiza siempre.** `flightPricing` es opcional en el contrato (`:4994`) y su
 * ausencia significa literalmente «reserva sin cotizar» (docs/sabre/04 §3.3.2): el PNR queda sin
 * price quote y el precio que se le dio al cliente no es el que queda guardado, así que la emisión
 * puede salir a otra tarifa. `[{}]` es «cotiza con defaults», que es el mínimo que garantiza que la
 * reserva lleve precio. La ÚNICA excepción es la pasiva
 * ({@link SABRE_PASSIVE_FLIGHT_STATUS_CODE}): ahí el segmento se reservó fuera de Sabre y no hay
 * nada que cotizar — el patrón de la colección es `flightStatusCode: "YK"` **sin `flightPricing`**.
 *
 * El carril NDC no lleva `flightPricing`: el precio vive dentro de la oferta que ya pasó por
 * `offers/price`, y `flightOffer` ni siquiera declara el bloque (`:4952-4981`).
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

  return {
    kind: 'atpco',
    flights: segments.map((s) => flightOf(s, flightStatusCode)),
    ...(isPassive(flightStatusCode) ? {} : { pricing: defaultAtpcoPricing() }),
  };
}

/** `YK` es el marcador de pasiva, y se compara normalizado porque llega por opción del llamador. */
function isPassive(flightStatusCode: string): boolean {
  return flightStatusCode.trim().toUpperCase() === SABRE_PASSIVE_FLIGHT_STATUS_CODE;
}

/**
 * `flightPricing: [{}]` — «cotiza con defaults».
 *
 * Se construye fresco en cada reserva en vez de compartir una constante: el array cruza a Zod y de
 * ahí al body, y un objeto compartido entre reservas es la clase de estado que acaba mutado por
 * accidente. Los cualificadores del pricing waterfall del consolidador —comisión, aerolínea
 * validadora, `priceComparisons`— existen en el builder y NO se rellenan aquí: no hay todavía un
 * caso de uso que los pida por este puerto, y un campo sin caso de uso es superficie que nadie
 * prueba.
 */
function defaultAtpcoPricing(): SabrePricingInput[] {
  return [{}];
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
  useCase: SabreBookingUseCase,
  tolerance: readonly SabrePartialFailureDomain[],
  failures: SabrePartialFailureVerdict,
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
    // La decisión, en los dos vocabularios: `useCase` es por qué se toleró, `partialFailureTolerance`
    // qué se toleró y `errorHandlingPolicy` lo que de verdad viajó al cable. Los tres son
    // vocabulario CERRADO —enums nuestros y del contrato—, así que no hay PII que redactar.
    useCase,
    partialFailureTolerance: [...tolerance],
    accessoryFailures: [...failures.accessoryFailures],
    dependencyFailures: [...failures.dependencyFailures],
    dependencyFailed: failures.dependencyFailed,
    hasUnattributedErrors: failures.hasUnattributedErrors,
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
