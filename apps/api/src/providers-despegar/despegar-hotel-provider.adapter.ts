import { BadRequestException } from '@nestjs/common';
import {
  ProviderRawValueSchema,
  type HotelOffer,
  type HotelRatesQuery,
  type HotelRoompack,
  type HotelSearchCriteria,
  type ProviderRawValue,
  type ProviderRef,
} from '@sales-travel/canonical';
import type {
  BookInvoice,
  BookPayment,
  BookResult,
  BookStatus,
  BookTraveler,
  DespegarHotelsAdapter,
  HotelOffer as DespegarHotelOffer,
  HotelRoompack as DespegarHotelRoompack,
  IdentificationType,
  PrebookResult,
  RoomDistribution,
} from '@sales-travel/despegar-hotels';
import type {
  HotelBookOutcome,
  HotelBookPayment,
  HotelBookRequest,
  HotelBookResult,
  HotelBookingStatus,
  HotelBookingView,
  HotelCancelRequest,
  HotelCancelResult,
  HotelDestinationSuggestion,
  HotelFiscalInvoice,
  HotelGuest,
  HotelGuestDocument,
  HotelPaymentModality,
  HotelPaymentOptionsPort,
  HotelPaymentOptionsQuery,
  HotelPrebookRequest,
  HotelPrebookResult,
  HotelPriceJumpDecision,
  HotelPriceJumpRecoveryPort,
  HotelPriceJumpResult,
  HotelProviderOptions,
  HotelRatesDetailPort,
  HotelSuggestPort,
  SearchContext,
} from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';

/** Código de Despegar en el registry de hoteles y en `provider.name` de cada tarifa. */
export const DESPEGAR_HOTELS_PROVIDER_CODE = 'despegar-hotels';

/** La superficie pública del ACL: lo único que este envoltorio puede llamar. */
export type DespegarHotelsAcl = Pick<DespegarHotelsAdapter, keyof DespegarHotelsAdapter>;

// ───────────────────────── Errores ─────────────────────────

/**
 * Por qué un pedido neutral no se puede traducir a Despegar. Vocabulario cerrado: el mensaje
 * nunca repite valores del pedido, sólo nombres de campo.
 */
export type DespegarHotelInputReason =
  | 'foreign-offer'
  | 'missing-choice'
  | 'missing-prebook'
  | 'room-references'
  | 'room-without-guest'
  | 'unsupported-payment'
  | 'invalid-options';

/**
 * El pedido no llegó a Despegar: faltaba algo que el contrato neutral deja opcional y Despegar
 * exige. Es 400 porque el dato viene del cliente, y su nombre termina en `InputError` para que
 * la política de cancelación lo lea como determinista (no salió nada, no hay que conciliar).
 */
export class DespegarHotelInputError extends BadRequestException {
  constructor(
    readonly reason: DespegarHotelInputReason,
    message: string,
  ) {
    super(message);
    this.name = 'DespegarHotelInputError';
  }
}

// ───────────────────────── Esquemas de lo que vuelve del cliente ─────────────────────────

/*
 * `provider.raw` y `providerOptions` viajan al navegador y vuelven: son entrada externa y pasan
 * por Zod antes de llegar al ACL. Los de opciones son estrictos porque una opción mal escrita que
 * se ignora en silencio (un `testcase` en minúscula) convierte un ensayo de sandbox en una
 * reserva de verdad.
 */

const ChoiceRawSchema = z.object({ choiceId: z.string().min(1).max(4096) });
const RoomReferencesRawSchema = z.object({
  roomReferences: z.array(z.number().int().nonnegative()).min(1).max(8),
});

const PrebookOptionsSchema = z
  .object({ include: z.array(z.enum(['EXCHANGE_POLICIES', 'IMPORTANT_DATA', 'HINTS'])) })
  .partial()
  .strict();

const BookOptionsSchema = z
  .object({
    modality: z.string().min(1).max(40),
    phoneType: z.enum(['HOME', 'MOBILE', 'WORK']),
    disableSyncResult: z.boolean(),
    testCase: z.literal('pricejump'),
  })
  .partial()
  .strict();

const CancelOptionsSchema = z
  .object({
    reason: z.enum([
      'FAMILY_OR_WORK_PROBLEM',
      'TRAVEL_ANOTHER_DESTINATION',
      'NATURAL_DISASTER',
      'WRONG_PURCHASE_DATA',
      'ILLNESS',
      'DEATH',
      'DUPLICATE_RESERVATION',
      'CHANGE_PROBLEM',
      'CREDIT_CARD_PROBLEM',
      'HOTEL_PROBLEM',
      'OTHER',
    ]),
  })
  .partial()
  .strict();

const RecoveryOptionsSchema = z
  .object({ testCase: z.literal('pricejump') })
  .partial()
  .strict();

const ProviderDetailSchema = z.record(ProviderRawValueSchema);

const ZonedDateTimeSchema = z.string().datetime({ offset: true });

/** Sólo nombres de campo: el valor de una opción puede ser un dato del viajero. */
function issuePaths(error: z.ZodError): string {
  return error.issues
    .flatMap((i) => (i.code === z.ZodIssueCode.unrecognized_keys ? i.keys : [i.path.join('.')]))
    .join(', ');
}

function parseOptions<TOut>(
  schema: z.ZodType<TOut, z.ZodTypeDef, unknown>,
  options: HotelProviderOptions | undefined,
): TOut {
  const parsed = schema.safeParse(options ?? {});
  if (!parsed.success) {
    throw new DespegarHotelInputError(
      'invalid-options',
      `Opciones de Despegar Hoteles inválidas (${issuePaths(parsed.error)}).`,
    );
  }
  return parsed.data;
}

function parseRaw<TOut>(
  schema: z.ZodType<TOut, z.ZodTypeDef, unknown>,
  offer: ProviderRef,
  reason: DespegarHotelInputReason,
  message: string,
): TOut {
  const parsed = schema.safeParse(offer.raw ?? {});
  if (!parsed.success) throw new DespegarHotelInputError(reason, message);
  return parsed.data;
}

// ───────────────────────── Oferta: de Despegar al contrato neutral ─────────────────────────

const DESPEGAR_LANGUAGE = { es: 'ES', pt: 'PT', en: 'EN' } as const;

type StayCriteria = Pick<
  HotelSearchCriteria,
  | 'checkinDate'
  | 'checkoutDate'
  | 'currency'
  | 'rooms'
  | 'pointOfSaleCountry'
  | 'language'
  | 'refundableOnly'
>;

/**
 * Lo común a la búsqueda y al detalle. Un opcional ausente viaja como `undefined` y el ACL cae a
 * lo que declara la cuenta (`countryCode`, `language`), igual que hoy.
 *
 * `guestNationality` no se manda: Despegar no la recibe. El país del punto de venta sí, y es otro
 * dato.
 */
function stayQuery(c: StayCriteria): {
  checkinDate: string;
  checkoutDate: string;
  currency: string;
  rooms: RoomDistribution[];
  countryCode: string | undefined;
  language: 'ES' | 'PT' | 'EN' | undefined;
  refundableOnly: boolean | undefined;
} {
  return {
    checkinDate: c.checkinDate,
    checkoutDate: c.checkoutDate,
    currency: c.currency,
    rooms: c.rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
    countryCode: c.pointOfSaleCountry,
    language: c.language === undefined ? undefined : DESPEGAR_LANGUAGE[c.language],
    refundableOnly: c.refundableOnly,
  };
}

/**
 * Lo que hace falta para reservar el pack desde el contrato neutral, que sólo transporta un
 * `ProviderRef`: el `choiceId` que pide el prebook y la `reference` de cada habitación, que es
 * como Despegar asocia cada huésped con su habitación en el Book.
 *
 * Sólo se escribe si el pack trae UN único `choiceId` en todas sus habitaciones. Si trae varios,
 * elegir uno sería adivinar con qué habitación se reserva, y el prebook falla con motivo en vez
 * de revalidar otra cosa. El token sigue además en cada habitación, como hoy.
 */
function bookingRawOf(pack: DespegarHotelRoompack): Record<string, ProviderRawValue> | undefined {
  const choices = new Set(pack.rooms.map((r) => r.choiceId ?? ''));
  const [choiceId] = [...choices];
  if (choices.size !== 1 || !choiceId) return undefined;
  return { choiceId, roomReferences: pack.rooms.map((r) => r.reference) };
}

/**
 * Suma a cada pack de dónde es (RF-40) y no toca nada más: precios, habitaciones y políticas
 * salen como los entrega el ACL, para que la búsqueda por registry muestre lo mismo que hoy.
 *
 * `offerRef` es el id del roompack, que es con lo que Despegar acota el detalle. No se valida
 * contra el esquema neutral ni se descarta nada aquí: una tarifa que hoy se ve no puede
 * desaparecer por pasar por el envoltorio.
 */
function attributeOffer(offer: DespegarHotelOffer, withBookingRef: boolean): HotelOffer {
  return {
    ...offer,
    roompacks: offer.roompacks.map((pack): HotelRoompack => {
      const raw = withBookingRef ? bookingRawOf(pack) : undefined;
      return {
        ...pack,
        provider:
          raw === undefined
            ? { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: pack.id }
            : { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: pack.id, raw },
      };
    }),
  };
}

// ───────────────────────── Reserva: del contrato neutral a Despegar ─────────────────────────

const DESPEGAR_ID_TYPE: Readonly<Record<HotelGuestDocument['type'], IdentificationType>> = {
  PASSPORT: 'PASSPORT',
  NATIONAL_ID: 'LOCAL',
};

const DESPEGAR_GENDER = { M: 'MALE', F: 'FEMALE' } as const;

/**
 * Despegar recibe UN huésped por habitación, el principal. Los demás de la habitación no tienen
 * dónde ir en su Book y no se mandan.
 */
function toTraveler(lead: HotelGuest, roomReference: number): BookTraveler {
  return {
    referenceId: String(roomReference),
    firstName: lead.firstName,
    lastName: lead.lastName,
    gender: lead.gender === undefined ? undefined : DESPEGAR_GENDER[lead.gender],
    nationality: lead.nationality,
    birthDate: lead.birthDate,
    identification:
      lead.document === undefined
        ? undefined
        : {
            type: DESPEGAR_ID_TYPE[lead.document.type],
            number: lead.document.number,
            issueCountry: lead.document.issuingCountry,
          },
  };
}

function toInvoice(inv: HotelFiscalInvoice): BookInvoice {
  return {
    reference: inv.reference,
    fiscalName: inv.fiscalName,
    firstName: inv.firstName,
    lastName: inv.lastName,
    fiscalStatus: inv.fiscalStatus,
    fiscalIdentification: {
      type: inv.fiscalId.type,
      number: inv.fiscalId.number,
      issueCountry: inv.fiscalId.issuingCountry,
      expirationDate: inv.fiscalId.expirationDate,
    },
    fiscalAddress: { ...inv.fiscalAddress },
  };
}

function toPayment(payment: HotelBookPayment): BookPayment {
  if (payment.kind !== 'hosted-token') {
    throw new DespegarHotelInputError(
      'unsupported-payment',
      'Despegar Hoteles cobra con el checkout alojado: esta reserva no se puede cargar al crédito de la cuenta.',
    );
  }
  return {
    optionType: payment.optionType,
    units: payment.units.map((u) => ({
      planId: u.planId,
      secureToken: u.secureToken,
      type: u.type,
      invoiceReference: u.invoiceReference,
      cardHolderIdentification:
        u.cardHolderDocument === undefined
          ? undefined
          : {
              type: DESPEGAR_ID_TYPE[u.cardHolderDocument.type],
              number: u.cardHolderDocument.number,
            },
    })),
    invoices: payment.invoices?.map(toInvoice),
  };
}

/*
 * El ACL pliega en `ERROR` cualquier estado que no sea SUCCESS/PROCESSING/ERROR
 * (`booking/book.mapper.ts`), así que aquí no se puede distinguir un error declarado de un estado
 * nuevo. Se traduce según el vocabulario documentado; `providerStatus` lleva el estado ya plegado
 * por el ACL, no el literal del cable, y el `subStatus` (p. ej. `PRICE_JUMP`) sí llega tal cual.
 */
const BOOK_OUTCOME: Readonly<Record<BookStatus, HotelBookOutcome>> = {
  SUCCESS: 'CONFIRMED',
  PROCESSING: 'PENDING',
  ERROR: 'FAILED',
};

const BOOKING_STATUS: Readonly<Record<BookStatus, HotelBookingStatus>> = {
  SUCCESS: 'CONFIRMED',
  PROCESSING: 'PENDING',
  ERROR: 'FAILED',
};

function toBookResult(r: BookResult): HotelBookResult {
  const out: HotelBookResult = {
    // Sin localizador, ni un SUCCESS ni un PROCESSING prueban una reserva que se pueda consultar:
    // puede existir, y se verifica leyendo, nunca reservando otra vez.
    outcome: r.reservationId || r.status === 'ERROR' ? BOOK_OUTCOME[r.status] : 'UNCERTAIN',
    providerStatus: r.status,
    // El `message` de Despegar es texto libre del proveedor: no entra en el contrato neutral.
    warnings: [],
  };
  if (r.reservationId) out.providerBookingId = r.reservationId;
  if (r.subStatus) out.providerSubStatus = r.subStatus;
  return out;
}

function toPrebookResult(r: PrebookResult): HotelPrebookResult {
  const out: HotelPrebookResult = { total: r.total, rateConditions: [], signals: [], warnings: [] };
  if (r.prebookId) out.prebookRef = r.prebookId;
  if (r.status) out.providerStatus = r.status;
  if (r.commission) out.agencyCommission = r.commission;
  if (r.expiration !== undefined) {
    // El contrato promete un instante con zona. Uno sin zona no se convierte inventándola: se
    // avisa, y quien reserva sabe que no tiene un vencimiento fiable.
    if (ZonedDateTimeSchema.safeParse(r.expiration).success) out.expiresAt = r.expiration;
    else out.warnings.push('prebook-expiration-without-zone');
  }
  return out;
}

// ───────────────────────── Envoltorio ─────────────────────────

/**
 * Despegar Hoteles detrás del contrato neutral de la vertical.
 *
 * El ACL (`providers/despegar-hotels`) no se toca: habla en sus tipos y así lo siguen usando las
 * rutas de reserva con DTOs de Despegar (`DespegarHotelReservationsService`). La búsqueda, las
 * sugerencias y el detalle pasan por aquí. Aquí se traduce, en los dos
 * sentidos, y se atribuye cada tarifa a Despegar en `provider.name`, que es por donde se enruta
 * el PreBook y con lo que la web dice de qué proveedor es cada tarifa. Es el mismo molde que
 * `SabreFlightProviderAdapter`.
 *
 * Además de los puertos obligatorios implementa los opcionales que Despegar sí tiene
 * (sugerencias, tarifas de un hotel, medios de pago y salto de precio). No implementa la lectura
 * por nuestra referencia ni las reservas por fecha: su factory las declara en `false` y no hay
 * un test que respalde que el endpoint las sirva.
 */
export class DespegarHotelProviderAdapter
  implements
    HotelProviderAdapter,
    HotelSuggestPort,
    HotelRatesDetailPort,
    HotelPaymentOptionsPort,
    HotelPriceJumpRecoveryPort
{
  constructor(private readonly acl: DespegarHotelsAcl) {}

  // ───────────────────────── Búsqueda ─────────────────────────

  async searchAvailability(
    criteria: HotelSearchCriteria,
    _ctx: SearchContext,
  ): Promise<HotelOffer[]> {
    const offers = await this.acl.searchAvailability({
      ...stayQuery(criteria),
      hotelIds: [...criteria.hotelIds],
    });
    return offers.map((offer) => attributeOffer(offer, false));
  }

  async getHotelRates(query: HotelRatesQuery, _ctx: SearchContext): Promise<HotelOffer> {
    const offer = await this.acl.getHotelDetail({
      ...stayQuery(query),
      hotelId: query.hotelId,
      roompackId: query.roompackId,
    });
    return attributeOffer(offer, true);
  }

  suggestDestinations(
    query: string,
    _ctx: SearchContext,
    locale?: string,
  ): Promise<HotelDestinationSuggestion[]> {
    return this.acl.suggest(query, locale);
  }

  // ───────────────────────── Reserva ─────────────────────────

  async prebook(request: HotelPrebookRequest, _ctx: SearchContext): Promise<HotelPrebookResult> {
    this.assertOwnOffer(request.offer);
    const { choiceId } = parseRaw(
      ChoiceRawSchema,
      request.offer,
      'missing-choice',
      'La tarifa no trae un único token de reserva de Despegar. Volvé a pedir las tarifas del hotel y elegí la habitación.',
    );
    const options = parseOptions(PrebookOptionsSchema, request.providerOptions);
    const result = await this.acl.prebook({
      choiceId,
      lang: request.language,
      include: options.include,
    });
    return toPrebookResult(result);
  }

  getPaymentOptions(
    query: HotelPaymentOptionsQuery,
    _ctx: SearchContext,
  ): Promise<HotelPaymentModality[]> {
    return this.acl.getPaymentOptions({
      prebookId: query.prebookRef,
      inputPoints: query.inputPoints,
      includeHints: query.includeHints,
    });
  }

  async book(request: HotelBookRequest, _ctx: SearchContext): Promise<HotelBookResult> {
    this.assertOwnOffer(request.offer);
    if (!request.prebookRef) {
      throw new DespegarHotelInputError(
        'missing-prebook',
        'Despegar Hoteles reserva sobre un prebook vigente: falta la referencia del prebook.',
      );
    }
    const { roomReferences } = parseRaw(
      RoomReferencesRawSchema,
      request.offer,
      'room-references',
      'La tarifa no trae la numeración de habitaciones de Despegar. Volvé a pedir las tarifas del hotel.',
    );
    if (roomReferences.length !== request.rooms.length) {
      throw new DespegarHotelInputError(
        'room-references',
        `La tarifa tiene ${roomReferences.length} habitaciones y la reserva trae huéspedes para ${request.rooms.length}.`,
      );
    }
    const options = parseOptions(BookOptionsSchema, request.providerOptions);

    const travelers = roomReferences.map((reference, j) => {
      const lead = request.rooms[j]?.guests[0];
      if (lead === undefined) {
        throw new DespegarHotelInputError(
          'room-without-guest',
          `La habitación ${j + 1} no tiene huésped principal.`,
        );
      }
      return toTraveler(lead, reference);
    });

    const result = await this.acl.book({
      prebookId: request.prebookRef,
      externalBookingReference: request.bookingReference,
      modality: options.modality,
      contact: {
        email: request.contact.email,
        phones: [{ ...request.contact.phone, type: options.phoneType }],
      },
      travelers,
      payment: toPayment(request.payment),
      context:
        request.client === undefined
          ? undefined
          : { clientIp: request.client.ip, userAgent: request.client.userAgent },
      disableSyncResult: options.disableSyncResult,
      testCase: options.testCase,
    });
    return toBookResult(result);
  }

  async confirmPriceJump(
    decision: HotelPriceJumpDecision,
    _ctx: SearchContext,
  ): Promise<HotelPriceJumpResult> {
    const options = parseOptions(RecoveryOptionsSchema, decision.providerOptions);
    const result = await this.acl.recoverBooking({
      reservationId: decision.providerBookingId,
      messageType: decision.messageType,
      confirmations: decision.confirmations.map((c) => ({
        flavorId: c.productRef,
        confirm: c.accept,
      })),
      testCase: options.testCase,
    });
    // Es el mismo `item` que la ruta de hoy le devuelve al cliente; sale de un `JSON.parse`, así
    // que la validación sólo fija que es JSON y no lo recorta.
    return result.item === undefined
      ? {}
      : { providerDetail: ProviderDetailSchema.parse(result.item) };
  }

  // ───────────────────────── Post-venta ─────────────────────────

  async getBooking(providerBookingId: string, _ctx: SearchContext): Promise<HotelBookingView> {
    const result = await this.acl.getReservation(providerBookingId);
    const view: HotelBookingView = {
      found: true,
      status: BOOKING_STATUS[result.status],
      providerStatus: result.status,
      warnings: [],
    };
    if (result.reservationId) view.providerBookingId = result.reservationId;
    if (result.subStatus) view.providerSubStatus = result.subStatus;
    return view;
  }

  async cancelBooking(
    request: HotelCancelRequest,
    _ctx: SearchContext,
  ): Promise<HotelCancelResult> {
    const options = parseOptions(CancelOptionsSchema, request.providerOptions);
    const result = await this.acl.cancelReservation({
      reservationId: request.providerBookingId,
      reason: options.reason,
    });
    // Despegar no devuelve importes ni el estado posterior en la cancelación: no se inventan.
    return { success: result.success, warnings: [] };
  }

  /**
   * Una tarifa de otro proveedor nunca llega a Despegar. El registry ya enruta por
   * `provider.name`; esto es la segunda barrera, en el último punto antes del cable.
   */
  private assertOwnOffer(offer: ProviderRef): void {
    if (offer.name !== DESPEGAR_HOTELS_PROVIDER_CODE) {
      throw new DespegarHotelInputError(
        'foreign-offer',
        'La tarifa es de otro proveedor y no se puede operar con Despegar Hoteles.',
      );
    }
  }
}
