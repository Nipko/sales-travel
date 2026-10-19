import type { LoggerPort } from '@sales-travel/core';
import type { Itinerary, Offer, Segment } from '@sales-travel/canonical';
import {
  OrderCreateNotSentError,
  type BookingContactInfo,
  type OrderCreatePort,
  type OrderCreateRequest,
  type OrderCreateResult,
  type OrderItemKind,
  type OrderItemResult,
  type Passenger,
  type SearchContext,
  type SeatSelection,
} from '@sales-travel/domain';
import {
  SABRE_CREATE_BOOKING_PATH,
  SabreCreateBookingError,
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
  type SabreSeatInput,
  type SabreTitle,
  type SabreIdentityDocumentInput,
  type SabreTravelerInput,
} from './booking/create.request.builder';
import type { MissingAirlineRequirement } from './booking/airline-requirements';
import {
  mapSabreCreateBookingResponse,
  type SabreAssignedSeat,
  type SabreCreateBookingMapped,
} from './booking/create.response.mapper';
import {
  SabreTicketingPolicyError,
  SabreTicketingSettingsSchema,
  planSabreTicketingPolicy,
  type SabreTicketingDecision,
  type SabreTicketingSettingsInput,
} from './booking/ticketing-policy';
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
  /** El reloj contra el que se calcula el plazo de emisión. Inyectable para poder probarlo. */
  readonly now?: () => Date;
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
   * Qué se está vendiendo. Sin decirlo, lo dice el pedido: con asientos es `FLIGHT_WITH_EXTRAS`
   * (el asiento es el extra y su fallo no tumba el vuelo, SAB-16); sin ellos, `FLIGHT_ONLY`: nada es
   * accesorio y la política es `HALT_ON_ERROR`, que es el default del contrato y el nuestro.
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
   * La política de emisión de la cuenta. Con ella, el bloque `agency` sale con `ticketingPolicy` y
   * su plazo calculado contra ESTA oferta (ver `booking/ticketing-policy.ts`). Se elige aquí y no
   * en `agency` porque el plazo depende de la oferta, y quien la conoce es este adapter.
   *
   * Excluyente con los campos de emisión de {@link agency}: dos fuentes para la misma política no
   * tienen una respuesta correcta, y se rechaza antes de la red.
   */
  readonly ticketing?: SabreTicketingSettingsInput;
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
  /** La política de emisión que viajó, si se pidió con {@link SabreOrderCreateOptions.ticketing}. */
  readonly ticketing?: SabreTicketingDecision;
  /** Los asientos pedidos y cuántos no quedaron confirmados (SAB-16). Conteos, nunca números. */
  readonly seats: SabreSeatOutcome;
  /**
   * Lo que se puede persistir en `orders.provider_raw` **sin PAN y sin PII**: la reserva no
   * viaja entera. Ver {@link providerRawOf}.
   */
  readonly providerRaw: Record<string, unknown>;
}

/** Los asientos de una reserva, contados. */
export interface SabreSeatOutcome {
  readonly requested: number;
  /** Pedidos que la respuesta no trae asignados, o que trae `FAILED`/`UNCONFIRMED`. */
  readonly notConfirmed: number;
}

/** El plan del builder más la política de emisión que se decidió para esta oferta. */
export interface SabreOrderCreatePlan extends SabreCreateBookingPlan {
  readonly ticketing?: SabreTicketingDecision;
  /** Los asientos que viajaron, con la posición con que se pidieron: se cruzan con la respuesta. */
  readonly seats: readonly SabreRequestedSeat[];
}

/** Un asiento tal como viajó: vuelo, viajero y avión en posiciones base cero, y su número. */
export interface SabreRequestedSeat {
  readonly flightPosition: number;
  readonly travelerPosition: number;
  readonly legIndex: number;
  readonly number: string;
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
    // Todo lo que puede rechazar la petición va ANTES de la red, y se rechaza con el error que el
    // saga lee como «no salió»: una excepción después del POST es un resultado incierto.
    let plan: SabreOrderCreatePlan;
    let useCase: SabreBookingUseCase;
    let tolerance: readonly SabrePartialFailureDomain[];
    try {
      plan = this.plan(request, options);
      useCase = useCaseOf(request, options);
      tolerance = toleranceOf(useCase);
    } catch (err) {
      if (
        err instanceof SabreOrderCreateInputError ||
        err instanceof SabreCreateBookingError ||
        err instanceof SabreTicketingPolicyError
      ) {
        throw new OrderCreateNotSentError(err.message, { cause: err });
      }
      throw err;
    }

    // Sin `idempotent`. No es que sobre: es que decirlo sería mentir sobre lo que pasa si hay un
    // timeout. Un `ERR.2SG.GATEWAY.TIMEOUT` en createBooking no dice si el PNR se creó, y quien
    // decide qué hacer entonces es el saga, releyendo con getBooking.
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(plan.path, plan.body, {
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    });

    const mapped: SabreCreateBookingMapped = withRequestedSeats(
      mapSabreCreateBookingResponse(result.data),
      plan.seats,
      segmentsOf(request.offer).length,
    );
    const seats = seatOutcomeOf(mapped.order, plan.seats);
    const advisories = plan.advisories.map(describeAdvisory);
    const failures = classifySabrePartialFailure(mapped.order, tolerance);

    // `info` y no `debug` en el éxito: producción descarta `debug`, y una reserva es justo lo que
    // tiene que dejar traza aunque haya salido bien.
    this.log(mapped.order.outcome === 'CONFIRMED' ? 'info' : 'warn', 'sabre.createBooking', {
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
      ...ticketingLogMeta(plan.ticketing),
      ...(seats.requested === 0
        ? {}
        : { seatsRequested: seats.requested, seatsNotConfirmed: seats.notConfirmed }),
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
      ...(plan.ticketing === undefined ? {} : { ticketing: plan.ticketing }),
      seats,
      providerRaw: providerRawOf(
        mapped,
        plan,
        result.conversationId,
        useCase,
        tolerance,
        failures,
        seats,
      ),
    };
  }

  /**
   * Traduce y construye, **sin tocar la red**. Se expone para que un test pueda ejercitar la
   * traducción por la puerta pública sin montar un `fetch` falso.
   */
  plan(request: OrderCreateRequest, options: SabreOrderCreateOptions = {}): SabreOrderCreatePlan {
    const { travelers, order } = travelersOf(request);
    const seated = withSeats(
      productOf(request.offer, options.flightStatusCode ?? DEFAULT_FLIGHT_STATUS_CODE),
      request,
      order,
    );
    const product = seated.product;
    const ticketing =
      options.ticketing === undefined
        ? undefined
        : this.ticketingPlan(request.offer, options.ticketing, options.agency);
    const agency =
      ticketing === undefined ? options.agency : { ...options.agency, ...ticketing.agency };
    const input: SabreCreateBookingInput = {
      product,
      travelers,
      contactInfo: contactInfoOf(request.contactInfo),
      carriers: carriersOf(request.offer),
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(options.receivedFrom === undefined ? {} : { receivedFrom: options.receivedFrom }),
      ...(agency === undefined ? {} : { agency }),
    };

    const built = buildSabreCreateBookingRequest(input, this.cfg, {
      partialFailureTolerance: [...toleranceOf(useCaseOf(request, options))],
      ...(options.haltOnInvalidConnectingTime === undefined
        ? {}
        : { haltOnInvalidConnectingTime: options.haltOnInvalidConnectingTime }),
      ...(options.asynchronousUpdateWaitTimeMs === undefined
        ? {}
        : { asynchronousUpdateWaitTimeMs: options.asynchronousUpdateWaitTimeMs }),
      ...(options.omitPayment === undefined ? {} : { omitPayment: options.omitPayment }),
    });
    return {
      ...built,
      seats: seated.seats,
      ...(ticketing === undefined ? {} : { ticketing: ticketing.decision }),
    };
  }

  /**
   * La política de emisión para esta oferta. La configuración se vuelve a validar aquí aunque el
   * llamador ya la haya parseado: este es el borde del contrato, y un plazo calculado con un margen
   * o una zona que nadie validó acaba impreso en el PNR.
   */
  private ticketingPlan(
    offer: Offer,
    raw: SabreTicketingSettingsInput,
    agency: SabreAgencyInput | undefined,
  ): ReturnType<typeof planSabreTicketingPolicy> {
    if (
      agency?.ticketingPolicy !== undefined ||
      agency?.futureTicketingPolicy !== undefined ||
      agency?.ticketingTimeLimitPolicy !== undefined
    ) {
      throw new SabreOrderCreateInputError(
        'la política de emisión llegó por `ticketing` y por `agency` a la vez: tiene que tener una sola fuente',
      );
    }
    const parsed = SabreTicketingSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].sort();
      throw new SabreOrderCreateInputError(
        `la configuración de emisión no es válida (campos: ${fields.join(', ')})`,
      );
    }
    const planned = planSabreTicketingPolicy({
      offer,
      settings: parsed.data,
      ...(this.cfg.ticketingPcc === undefined ? {} : { ticketingPcc: this.cfg.ticketingPcc }),
      now: this.deps.now?.() ?? new Date(),
    });
    if (planned.decision.fallback !== undefined) {
      // La cuenta pidió emisión futura y no tiene a quién dejársela (sin PCC de emisión, o con uno
      // que el contrato no acepta). Se reserva igual, con plazo, porque no reservar por un campo de
      // configuración es peor; pero tiene que verse.
      this.log('warn', 'sabre.createBooking.ticketingPolicyFallback', {
        requestedPolicy: planned.decision.requestedPolicy,
        appliedPolicy: planned.decision.policy,
        reason: planned.decision.fallback,
      });
    }
    return planned;
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/** La política de emisión en la línea de log de la reserva, en vocabulario cerrado. */
function ticketingLogMeta(decision: SabreTicketingDecision | undefined): Record<string, unknown> {
  if (decision === undefined) return {};
  return {
    ticketingPolicy: decision.policy,
    ...(decision.fallback === undefined ? {} : { ticketingPolicyFallback: decision.fallback }),
    ...(decision.deadline === undefined
      ? {}
      : { ticketingDeadlineSource: decision.deadline.source }),
  };
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
 * El caso de uso de ESTA reserva. Lo declarado manda; si no se declaró nada, lo dice el pedido: con
 * asientos, el asiento es el extra (`FLIGHT_WITH_EXTRAS`) y un asiento que la aerolínea no confirma
 * no tumba el vuelo (`DO_NOT_HALT_ON_SEAT_BOOKING_ERROR`). Sin ellos, nada es accesorio.
 */
function useCaseOf(
  request: OrderCreateRequest,
  options: SabreOrderCreateOptions,
): SabreBookingUseCase {
  if (options.useCase !== undefined) return options.useCase;
  return (request.seats?.length ?? 0) > 0 ? 'FLIGHT_WITH_EXTRAS' : SABRE_DEFAULT_BOOKING_USE_CASE;
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

/**
 * Lo que el vendedor teclea, en la forma que el contrato acepta. El builder rechaza un espacio al
 * final del nombre o un pasaporte escrito «AB-123.456», y ese rechazo no le dice nada al cliente:
 * son el mismo nombre y el mismo documento. Se normaliza la FORMA, nunca el contenido.
 */
function nombreLimpio(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function numeroDocumentoLimpio(value: string): string {
  return value.replace(/[\s.-]/g, '');
}

/**
 * El bloque `identityDocuments`, o NADA.
 *
 * Sabre rechazaba la reserva con `MANDATORY_DATA_MISSING` sobre `identityDocuments[0]` sin decir
 * qué campo faltaba: no lo exige el esquema —su único `required` es `documentType`— sino el
 * carrier, así que no hay contrato que leer. Lo dice la colección, mirando SÓLO el carril que
 * usamos (ATPCO, `flightDetails`), sobre sus 26 documentos reales:
 *
 * - `documentType`, `givenName`, `surname`, `birthDate`, `gender`: **26/26**.
 * - `documentNumber`, `expiryDate`, `issuingCountryCode`: **21/21**, y siempre los tres juntos.
 * - Documentos con número y SIN vencimiento: **0**. Ni uno.
 * - Reservas ATPCO sin ningún documento: **9 de 23**.
 *
 * Las dos últimas líneas son la regla. En ATPCO el documento se convierte en un SSR DOCS, que es
 * de formato fijo y lleva vencimiento; un número sin vencimiento no compone un DOCS y por eso
 * falta «dato obligatorio». Y no mandar documento no es un caso raro: es lo que hacen 9 de 23
 * reservas, porque en un vuelo doméstico no hay APIS que declarar.
 *
 * Así que si el documento no compone un DOCS, **se omite el bloque entero** en vez de mandarlo a
 * medias. Es lo único que se puede hacer sin inventar un dato: una cédula colombiana NO VENCE, y
 * rellenar ese hueco con una fecha cualquiera sería mandarle a la aerolínea, en una reserva, un
 * dato que nadie verificó. El pasajero sigue identificado —nombre, nacimiento y género viajan en
 * el `traveler`, que es lo que necesita un vuelo doméstico—.
 *
 * CONTRAPARTIDA, escrita a propósito: en un vuelo internacional esto deja la reserva sin APIS y
 * la aerolínea los pedirá en el mostrador. Es un mal menor frente a no poder reservar, y el
 * documento que lo provoca —una cédula— tampoco sirve para volar fuera del país.
 */
function documentoDe(passenger: Passenger): { identityDocuments?: SabreIdentityDocumentInput[] } {
  const doc = passenger.identityDoc;
  const numero = numeroDocumentoLimpio(doc.number);
  const vencimiento = doc.expiryDate?.trim();

  // Con número hay que poder componer el DOCS entero. Sin vencimiento, no se manda nada.
  if (
    numero !== undefined &&
    numero.length > 0 &&
    (vencimiento === undefined || vencimiento === '')
  )
    return {};

  return {
    identityDocuments: [
      {
        documentType: DOCUMENT_TYPE_BY_DOMAIN_TYPE[doc.type],
        documentNumber: numero,
        issuingCountryCode: doc.issuingCountryCode,
        // 22 de los 26 documentos ATPCO reales lo llevan, y en TODOS los pasaportes vale lo
        // mismo que `issuingCountryCode` (12/12 comprobados: NG/NG, US/US…). No es una
        // suposición nuestra: es la convención de cada ejemplo que funciona.
        //
        // DEUDA, escrita para que no se olvide: la residencia NO es el país emisor del
        // documento, y hoy no se le pregunta al vendedor. Para un pasajero que reside fuera de
        // su país esto va mal, y lo correcto es un campo propio con este valor por defecto.
        residenceCountryCode: doc.issuingCountryCode,
        citizenshipCountryCode: passenger.citizenshipCountryCode,
        // El TITULAR, dentro del documento. Parece redundante —el traveler ya los lleva— y no lo
        // es: 26/26 de los documentos ATPCO reales los llevan.
        givenName: nombreLimpio(passenger.givenName),
        surname: nombreLimpio(passenger.surname),
        birthDate: passenger.birthdate,
        gender: genderOf(passenger),
        ...opcional('expiryDate', doc.expiryDate),
        ...opcional('issueDate', doc.issueDate),
      },
    ],
  };
}

function travelerOf(passenger: Passenger, boundProviderPaxId?: string): SabreTravelerInput {
  const providerPaxId = boundProviderPaxId ?? passenger.providerPaxId;
  return {
    givenName: nombreLimpio(passenger.givenName),
    surname: nombreLimpio(passenger.surname),
    birthDate: passenger.birthdate,
    gender: genderOf(passenger),
    passengerCode: PASSENGER_CODE_BY_PAX_TYPE[passenger.paxType],
    ...(passenger.title === undefined ? {} : { title: TITLE_BY_DOMAIN_TITLE[passenger.title] }),
    // `providerPaxId` es el id que EMITIÓ el proveedor en el paso de precio. Si no lo hay no se
    // inventa uno nuestro: el contrato se contradice sobre quién lo elige (ver `Passenger`), y un
    // id inventado que Sabre no reconozca rompe la referencia entre traveler y offerItem.
    ...(providerPaxId === undefined ? {} : { providerTravelerId: providerPaxId }),
    ...documentoDe(passenger),
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

interface PricePassengerBindingRaw {
  readonly pricePassengerId: string;
  readonly requestedTravelerIndex: number;
  readonly paxType: 'ADT' | 'CHD' | 'INF';
  readonly requestedPtc: string;
  readonly pricedPtc: string;
}

/**
 * NDC: el viajero se enlaza por `requestedTravelerIndex` + tipo y recibe el id de price. ATPCO por
 * `flightDetails` —revalidada o no con Flight Check— no lleva id. No hay fallback por orden ni por
 * «el único adulto» porque ese
 * atajo se vuelve intercambio de documentos en cuanto se reserva más de un pasajero.
 */
function travelersOf(request: OrderCreateRequest): {
  travelers: SabreTravelerInput[];
  /** Los pasajeros en el orden de `travelers`: la posición de cada uno es su `travelerIndex - 1`. */
  order: Passenger[];
} {
  const priceOfferId = rawId(request.offer, SABRE_RAW_KEYS.priceOfferId);
  const priceOfferItemIds = rawIds(request.offer, SABRE_RAW_KEYS.priceOfferItemIds);
  if (priceOfferId === null || priceOfferItemIds === null) {
    return {
      travelers: request.passengers.map((passenger) => travelerOf(passenger)),
      order: [...request.passengers],
    };
  }

  const bindings = rawPricePassengerBindings(request.offer);
  const declaredIds = rawIds(request.offer, SABRE_RAW_KEYS.pricePassengerIds);
  if (bindings === null || declaredIds === null) {
    throw new SabreOrderCreateInputError(
      'la oferta NDC no trae pricePassengerBindings/pricePassengerIds completos: no se puede ' +
        'asociar cada traveler con el id emitido por Offer Price',
    );
  }

  const expectedTypes = expectedPaxTypes(request);
  if (
    expectedTypes.length !== request.passengers.length ||
    bindings.length !== expectedTypes.length
  ) {
    throw new SabreOrderCreateInputError(
      'el binding de pasajeros de Offer Price no cubre exactamente los pasajeros solicitados',
    );
  }

  const bindingByIndex = new Map<number, PricePassengerBindingRaw>();
  const providerIds = new Set<string>();
  for (const binding of bindings) {
    const expected = expectedTypes[binding.requestedTravelerIndex];
    if (
      expected === undefined ||
      expected !== binding.paxType ||
      bindingByIndex.has(binding.requestedTravelerIndex) ||
      providerIds.has(binding.pricePassengerId) ||
      requestedPtcFor(expected) !== binding.requestedPtc
    ) {
      throw new SabreOrderCreateInputError(
        'pricePassengerBindings es ambiguo o no coincide con requestedTravelerIndex/paxType',
      );
    }
    bindingByIndex.set(binding.requestedTravelerIndex, binding);
    providerIds.add(binding.pricePassengerId);
  }
  const boundIds = [...bindings]
    .sort((left, right) => left.requestedTravelerIndex - right.requestedTravelerIndex)
    .map((binding) => binding.pricePassengerId);
  if (
    declaredIds.length !== boundIds.length ||
    declaredIds.some((id, index) => id !== boundIds[index])
  ) {
    throw new SabreOrderCreateInputError(
      'pricePassengerIds no coincide con el binding explícito de Offer Price',
    );
  }

  const passengerByIndex = new Map<number, Passenger>();
  for (const passenger of request.passengers) {
    const index = passenger.requestedTravelerIndex;
    if (
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      passengerByIndex.has(index) ||
      expectedTypes[index] !== passenger.paxType
    ) {
      throw new SabreOrderCreateInputError(
        'cada pasajero NDC debe declarar un requestedTravelerIndex único que coincida con su paxType',
      );
    }
    passengerByIndex.set(index, passenger);
  }

  const travelers: SabreTravelerInput[] = [];
  const order: Passenger[] = [];
  for (let index = 0; index < expectedTypes.length; index += 1) {
    const passenger = passengerByIndex.get(index);
    const binding = bindingByIndex.get(index);
    if (passenger === undefined || binding === undefined) {
      throw new SabreOrderCreateInputError(
        'el binding de Offer Price quedó incompleto para uno de los requestedTravelerIndex',
      );
    }
    if (
      passenger.providerPaxId !== undefined &&
      passenger.providerPaxId !== binding.pricePassengerId
    ) {
      throw new SabreOrderCreateInputError(
        'providerPaxId contradice el binding de pasajero confirmado por Offer Price',
      );
    }
    travelers.push(travelerOf(passenger, binding.pricePassengerId));
    order.push(passenger);
  }
  return { travelers, order };
}

function expectedPaxTypes(request: OrderCreateRequest): Array<'ADT' | 'CHD' | 'INF'> {
  return [
    ...Array.from({ length: request.criteria.paxCount.adults }, () => 'ADT' as const),
    ...Array.from({ length: request.criteria.paxCount.children }, () => 'CHD' as const),
    ...Array.from({ length: request.criteria.paxCount.infants }, () => 'INF' as const),
  ];
}

function requestedPtcFor(paxType: 'ADT' | 'CHD' | 'INF'): string {
  return paxType === 'CHD' ? 'CNN' : paxType;
}

function rawPricePassengerBindings(offer: Offer): PricePassengerBindingRaw[] | null {
  const value = (offer.provider.raw ?? {})[SABRE_RAW_KEYS.pricePassengerBindings];
  if (!Array.isArray(value) || value.length === 0) return null;
  const bindings: PricePassengerBindingRaw[] = [];
  for (const entry of value) {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const pricePassengerId = record['pricePassengerId'];
    const requestedTravelerIndex = record['requestedTravelerIndex'];
    const paxType = record['paxType'];
    const requestedPtc = record['requestedPtc'];
    const pricedPtc = record['pricedPtc'];
    if (
      typeof pricePassengerId !== 'string' ||
      pricePassengerId.length === 0 ||
      typeof requestedTravelerIndex !== 'number' ||
      !Number.isSafeInteger(requestedTravelerIndex) ||
      requestedTravelerIndex < 0 ||
      (paxType !== 'ADT' && paxType !== 'CHD' && paxType !== 'INF') ||
      typeof requestedPtc !== 'string' ||
      requestedPtc.length === 0 ||
      typeof pricedPtc !== 'string' ||
      pricedPtc.length === 0
    ) {
      return null;
    }
    bindings.push({
      pricePassengerId,
      requestedTravelerIndex,
      paxType,
      requestedPtc,
      pricedPtc,
    });
  }
  return bindings;
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

  // La oferta de Flight Check NO se reserva por sus handles (`flightOffer`): en CERT, con el
  // request ya válido, Sabre responde DOWNLINE_SERVICE_ERROR con JA y con LA (H-06, docs/sabre/12
  // §3), y la colección no tiene un solo ejemplo de ese carril. Flight Check revalida precio y
  // clase; la reserva va por `flightDetails` con los segmentos que devolvió, como el workflow «Air
  // Shop, Book, Cancel» (ATPCO) de la colección, y `flightPricing` fija marca y fare basis por vuelo.
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
    ...(isPassive(flightStatusCode) ? {} : { pricing: atpcoPricingFor(offer) }),
  };
}

/**
 * Por qué bloque viaja la reserva de esta oferta: `flightOffer` si trae la cadena de
 * `offers/price` (NDC), `flightDetails` si no —también la ATPCO revalidada con Flight Check—. Es la
 * misma pregunta que se hace {@link productOf}, y la usa también el mapa de asientos: lo que se
 * puede reservar depende del bloque (ver {@link withSeats}).
 */
export type SabreBookingLane = 'flightOffer' | 'flightDetails';

export function sabreBookingLaneOf(offer: Offer): SabreBookingLane {
  const price =
    rawId(offer, SABRE_RAW_KEYS.priceOfferId) !== null &&
    rawIds(offer, SABRE_RAW_KEYS.priceOfferItemIds) !== null;
  return price ? 'flightOffer' : 'flightDetails';
}

/**
 * Los asientos pedidos (SAB-16), en el bloque que ya eligió {@link productOf}.
 *
 * - **`flightOffer`** (NDC): `seatOffers[]` con el `seatOfferId` del mapa leído justo antes de
 *   reservar, el número y el viajero (`BookSeatOffer`, `:5273-5303`). El id es lo único que ata el
 *   asiento a SU tramo —el bloque no tiene posición de vuelo—, así que sin él no sale nada. El
 *   segundo avión de un cambio de equipo no tiene campo en este bloque: se rechaza, y el mapa ya lo
 *   marca no vendible.
 * - **`flightDetails`** (ATPCO, revalidada o no con Flight Check): `flights[].seats[]` por número,
 *   sin id, y `changeOfGaugeSeats[]` para el segundo avión.
 *
 * El viajero es la posición del pasajero en `travelers[]` (`order`), que es la que arma
 * {@link travelersOf}: el asiento nombra al pasajero por su `requestedTravelerIndex`, nunca por el
 * orden del formulario. Todo lo que no se puede pedir lanza antes de la red
 * (`SabreOrderCreateInputError`, que el saga lee como «no salió»).
 */
function withSeats(
  product: SabreBookingProductInput,
  request: OrderCreateRequest,
  order: readonly Passenger[],
): { product: SabreBookingProductInput; seats: SabreRequestedSeat[] } {
  const requested = request.seats ?? [];
  if (requested.length === 0) return { product, seats: [] };

  const segmentCount = segmentsOf(request.offer).length;
  const seats: SabreRequestedSeat[] = [];
  const travelerSlots = new Set<string>();
  const seatSlots = new Set<string>();
  for (const seat of requested) {
    const travelerPosition = travelerPositionOf(seat, order);
    if (
      !Number.isSafeInteger(seat.segmentRef) ||
      seat.segmentRef < 0 ||
      seat.segmentRef >= segmentCount
    ) {
      throw new SabreOrderCreateInputError('un asiento nombra un tramo que la oferta no tiene');
    }
    if (seat.legIndex !== 0 && seat.legIndex !== 1) {
      throw new SabreOrderCreateInputError(
        'un asiento nombra un avión que el tramo no tiene: sólo hay primero y segundo',
      );
    }
    const number = seatNumberOf(seat);
    const where = `${String(seat.segmentRef)}:${String(seat.legIndex)}`;
    const travelerSlot = `${where}:${String(travelerPosition)}`;
    const seatSlot = `${where}:${number}`;
    if (travelerSlots.has(travelerSlot) || seatSlots.has(seatSlot)) {
      // DUPLICATE_SEAT_ASSIGNMENT / SEATS_DUPLICATE_ASSOCIATION: se rechaza antes de la red.
      throw new SabreOrderCreateInputError(
        'un pasajero lleva dos asientos en el mismo avión, o un asiento está pedido dos veces',
      );
    }
    travelerSlots.add(travelerSlot);
    seatSlots.add(seatSlot);
    seats.push({
      flightPosition: seat.segmentRef,
      travelerPosition,
      legIndex: seat.legIndex,
      number,
    });
  }

  if (product.kind === 'ndc') {
    const seatOffers: SabreSeatInput[] = requested.map((seat, index) => {
      const wire = seats[index] as SabreRequestedSeat;
      if (seat.legIndex !== 0) {
        throw new SabreOrderCreateInputError(
          'una reserva por oferta no tiene dónde pedir el asiento del segundo avión de un cambio de equipo',
        );
      }
      const seatOfferId = seat.offerRef?.trim();
      if (seatOfferId === undefined || seatOfferId.length === 0) {
        throw new SabreOrderCreateInputError(
          'un asiento de una reserva por oferta necesita la oferta del asiento del mapa (seatOfferId)',
        );
      }
      return { seatOfferId, number: wire.number, travelerPosition: wire.travelerPosition };
    });
    return { product: { ...product, seatOffers }, seats };
  }

  const toInput = (seat: SabreRequestedSeat): SabreSeatInput => ({
    number: seat.number,
    travelerPosition: seat.travelerPosition,
  });
  const flights = product.flights.map((flight, position): SabreFlightInput => {
    const mine = seats.filter((seat) => seat.flightPosition === position);
    const first = mine.filter((seat) => seat.legIndex === 0).map(toInput);
    const second = mine.filter((seat) => seat.legIndex === 1).map(toInput);
    return {
      ...flight,
      ...(first.length === 0 ? {} : { seats: first }),
      ...(second.length === 0 ? {} : { changeOfGaugeSeats: second }),
    };
  });
  return { product: { ...product, flights }, seats };
}

/** La posición en `travelers[]` del pasajero que nombra el asiento. Un infante no tiene asiento. */
function travelerPositionOf(seat: SeatSelection, order: readonly Passenger[]): number {
  const matches = order.flatMap((passenger, position) =>
    passenger.requestedTravelerIndex === seat.passengerIndex ? [position] : [],
  );
  const position = matches[0];
  if (matches.length !== 1 || position === undefined) {
    throw new SabreOrderCreateInputError(
      'cada asiento tiene que nombrar a un único pasajero de la reserva por su requestedTravelerIndex',
    );
  }
  if (order[position]?.paxType === 'INF') {
    throw new SabreOrderCreateInputError('un infante en brazos no ocupa asiento');
  }
  return position;
}

/** `12` + `C` → `12C`, el `^[0-9]+[A-Z]$` del contrato (`:5293`). */
function seatNumberOf(seat: SeatSelection): string {
  if (!Number.isSafeInteger(seat.row) || seat.row < 1 || seat.row > 999) {
    throw new SabreOrderCreateInputError('la fila de un asiento no es un número de fila');
  }
  if (!/^[A-Z]$/.test(seat.column)) {
    throw new SabreOrderCreateInputError('la columna de un asiento no es una letra');
  }
  return `${String(seat.row)}${seat.column}`;
}

/**
 * Cada asiento PEDIDO tiene que volver en la respuesta. `SEAT_NOT_ALLOWED_FOR_BOOKING` es un
 * `WARNING` y la reserva se crea igual, sin asiento (docs/sabre/03 §4.5): leer sólo los asientos
 * que volvieron daría la reserva por completa. El que falta se agrega como asiento `FAILED`, con su
 * número, y la reserva pasa a `PARTIAL`: el vuelo está, el asiento no.
 *
 * Sólo si la respuesta trae vuelos: sin ellos (la reserva todavía se está armando) no hay contra
 * qué cruzar, y lo resuelve la lectura de cierre. Las posiciones de vuelo se cruzan sólo cuando la
 * respuesta trae tantos vuelos como tramos la oferta; si no, basta con viajero, avión y número.
 */
function withRequestedSeats(
  mapped: SabreCreateBookingMapped,
  requested: readonly SabreRequestedSeat[],
  segmentCount: number,
): SabreCreateBookingMapped {
  if (requested.length === 0) return mapped;
  if (!mapped.order.items.some((item) => item.kind === 'flight')) return mapped;

  const positional = mapped.flightCount === segmentCount;
  const returned = (wanted: SabreRequestedSeat): boolean =>
    mapped.seats.some(
      (seat: SabreAssignedSeat) =>
        seat.travelerPosition === wanted.travelerPosition &&
        seat.legIndex === wanted.legIndex &&
        seat.number === wanted.number &&
        (!positional || seat.flightPosition === wanted.flightPosition),
    );
  const missing = requested.filter((wanted) => !returned(wanted));
  if (missing.length === 0) return mapped;

  const items: OrderItemResult[] = [
    ...mapped.order.items,
    ...missing.map(
      (wanted): OrderItemResult => ({
        kind: 'seat',
        status: 'FAILED',
        seatNumber: wanted.number,
      }),
    ),
  ];
  return {
    ...mapped,
    order: {
      ...mapped.order,
      items,
      outcome: mapped.order.outcome === 'CONFIRMED' ? 'PARTIAL' : mapped.order.outcome,
    },
  };
}

/** Los asientos de la reserva, contados: los pedidos y los que no quedaron confirmados. */
function seatOutcomeOf(
  order: OrderCreateResult,
  requested: readonly SabreRequestedSeat[],
): SabreSeatOutcome {
  return {
    requested: requested.length,
    notConfirmed: order.items.filter((item) => item.kind === 'seat' && item.status !== 'CONFIRMED')
      .length,
  };
}

/** `YK` es el marcador de pasiva, y se compara normalizado porque llega por opción del llamador. */
function isPassive(flightStatusCode: string): boolean {
  return flightStatusCode.trim().toUpperCase() === SABRE_PASSIVE_FLIGHT_STATUS_CODE;
}

/**
 * La cotización del PNR ATPCO: la marca y el fare basis que se vendieron, vuelo por vuelo.
 *
 * Sin cualificadores (`[{}]`, «cotiza con defaults») Sabre elige la tarifa más baja válida para
 * las clases reservadas, y dos marcas pueden compartir RBD: el vendedor elige FLEX en la vuelta y
 * el PNR queda en LIGHT. Con `brandedFares` + `specificFares` por vuelo —el ejemplo «createBooking
 * - Branded fares» de la colección— cada vuelo se cotiza en lo que se eligió, aunque ida y vuelta
 * lleven marcas distintas (docs/sabre/15 §3.2).
 *
 * Sale de `offer.fareComponents`: `segmentRefs` indexa los segmentos aplanados de `itineraries`
 * en el mismo orden que `flightDetails.flights`. Un vuelo sin componente, o un componente sin
 * marca o sin fare basis, simplemente no lleva ese cualificador: no se inventa uno. Sin nada que
 * fijar se vuelve a `[{}]`.
 *
 * Los cualificadores del pricing waterfall —comisión, aerolínea validadora, `priceComparisons`—
 * existen en el builder y NO se rellenan aquí: no hay todavía un caso de uso que los pida.
 */
export function atpcoPricingFor(offer: Offer): SabrePricingInput[] {
  const flightCount = segmentsOf(offer).length;
  const brands = new Map<string, number[]>();
  const fareBases = new Map<string, number[]>();
  const brandedFlights = new Set<number>();
  const pricedFlights = new Set<number>();
  // `SpecificFare` no lleva tipo de pasajero: un fare basis vale para TODOS. Con niños o
  // infantes Flight Check devuelve un componente por tipo (CERT, 2026-10-19: KLEESCO1 adulto,
  // KLEESCO1CH niño, KLEESCO1IN infante en los mismos vuelos), y fijar el primero cotizaría al niño
  // con la tarifa de adulto. Sólo se fija el fare basis si en TODOS los vuelos hay uno solo; la
  // marca, que sí es la misma para todos los pasajeros, se fija siempre.
  const basesPorVuelo = new Map<number, Set<string>>();
  for (const component of offer.fareComponents ?? []) {
    const fareBasis = component.fareBasisCode?.trim().toUpperCase();
    if (fareBasis === undefined || fareBasis.length === 0) continue;
    for (const ref of component.segmentRefs) {
      basesPorVuelo.set(ref, (basesPorVuelo.get(ref) ?? new Set<string>()).add(fareBasis));
    }
  }
  const fijarFareBasis = [...basesPorVuelo.values()].every((bases) => bases.size === 1);

  for (const component of offer.fareComponents ?? []) {
    const positions = component.segmentRefs.filter((ref) => ref >= 0 && ref < flightCount);
    if (positions.length === 0) continue;
    const brandCode = component.brand?.code?.trim().toUpperCase();
    if (brandCode !== undefined && brandCode.length > 0) {
      appendPositions(brands, brandCode, positions, brandedFlights);
    }
    const fareBasis = component.fareBasisCode?.trim().toUpperCase();
    if (fijarFareBasis && fareBasis !== undefined && fareBasis.length > 0) {
      appendPositions(fareBases, fareBasis, positions, pricedFlights);
    }
  }

  const pricing: SabrePricingInput = {
    ...(brands.size === 0
      ? {}
      : {
          brandedFares: [...brands].map(([brandCode, flightPositions]) => ({
            brandCode,
            flightPositions,
          })),
        }),
    ...(fareBases.size === 0
      ? {}
      : {
          specificFares: [...fareBases].map(([fareBasisCode, flightPositions]) => ({
            fareBasisCode,
            flightPositions,
          })),
        }),
  };
  return [pricing];
}

/**
 * Un vuelo ya fijado por otro componente no se vuelve a fijar: dos valores para el mismo vuelo
 * no se pueden cotizar y el builder los rechazaría. Gana el primero, que es el del componente que
 * Sabre listó primero.
 */
function appendPositions(
  byValue: Map<string, number[]>,
  value: string,
  positions: readonly number[],
  taken: Set<number>,
): void {
  const free = positions.filter((position) => !taken.has(position));
  if (free.length === 0) return;
  for (const position of free) taken.add(position);
  byValue.set(value, [...(byValue.get(value) ?? []), ...free]);
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
  plan: SabreOrderCreatePlan,
  conversationId: string,
  useCase: SabreBookingUseCase,
  tolerance: readonly SabrePartialFailureDomain[],
  failures: SabrePartialFailureVerdict,
  seats: SabreSeatOutcome = { requested: 0, notConfirmed: 0 },
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
    ...ticketingRawOf(plan.ticketing),
    // Conteos de los asientos (SAB-16). El número de cada uno va en su ítem: no es un dato del
    // pasajero, y es lo que dice qué asiento no quedó.
    ...(seats.requested === 0
      ? {}
      : { seatsRequested: seats.requested, seatsNotConfirmed: seats.notConfirmed }),
    items: mapped.order.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      ...(item.providerItemId === undefined ? {} : { providerItemId: item.providerItemId }),
      ...(item.statusCode === undefined ? {} : { statusCode: item.statusCode }),
      ...(item.seatNumber === undefined ? {} : { seatNumber: item.seatNumber }),
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

/**
 * La política de emisión que viajó, para `orders.provider_raw`: vocabulario cerrado y el plazo
 * pedido como fecha y hora de la oficina, con su zona. Nada de esto es PII ni identifica una
 * oficina: el PCC de emisión NO se copia, igual que el de la reserva.
 */
function ticketingRawOf(decision: SabreTicketingDecision | undefined): Record<string, unknown> {
  if (decision === undefined) return {};
  return {
    ticketingPolicy: decision.policy,
    ...(decision.fallback === undefined ? {} : { ticketingPolicyFallback: decision.fallback }),
    ...(decision.deadline === undefined
      ? {}
      : {
          ticketingDeadline: {
            date: decision.deadline.date,
            time: decision.deadline.time,
            pccTimeZone: decision.deadline.pccTimeZone,
            source: decision.deadline.source,
          },
        }),
  };
}
