import { BadRequestException } from '@nestjs/common';
import {
  ProviderRawValueSchema,
  type BoardType,
  type HotelFee,
  type HotelOffer,
  type Money,
  type HotelRatesQuery,
  type HotelRoompack,
  type HotelSearchCriteria,
  type ProviderRawValue,
  type ProviderRef,
} from '@sales-travel/canonical';
import { DespegarApiError } from '@sales-travel/despegar-hotels';
import type {
  AftersaleReservation,
  AftersaleStatus,
  BookInvoice,
  BookPayment,
  BookResult,
  BookStatus,
  CancelQuote,
  MealPlanEntry,
  BookTraveler,
  DespegarHotelContent,
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
  HotelBookingByClientReferencePort,
  HotelBookingDateRange,
  HotelBookingStatus,
  HotelBookingSummary,
  HotelBookingView,
  HotelBookingsByDatePort,
  HotelBookingsByDateResult,
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
import type {
  HotelAccountEnvironmentPort,
  HotelContentBatch,
  HotelContentBatchPort,
  HotelContentFetchOptions,
  HotelContentLanguage,
  HotelContentPort,
  HotelProviderAdapter,
  HotelProviderContent,
  HotelProviderRoomContent,
  HotelRoomContentFetch,
  HotelRoomContentPort,
} from '../providers/hotel-provider.types.js';
import {
  DESPEGAR_CONTENT_BATCH_SIZE,
  despegarContentRecord,
  despegarProviderContent,
  despegarRoomContent,
  toDespegarLanguage,
} from './despegar-hotel-content.js';
import {
  DESPEGAR_PICTURES_PER_HOTEL,
  DESPEGAR_PICTURES_PER_ROOM,
  type PictureFilter,
} from './despegar-picture-check.js';

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
  | 'missing-invoice'
  | 'invalid-guest-name'
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
/**
 * Lo que se paga en el hotel, por código de `fee-types` (TT, TA…). Sin catálogo cargado se
 * muestra el código: traducirlo a ojo sería inventar qué cobra el hotel. Los impuestos en destino
 * van aparte sólo si no vinieron ya en el desglose.
 */
function atPropertyChargesOf(pack: DespegarHotelRoompack): HotelFee[] | undefined {
  const detail = pack.price.chargeAtDestinationDetail ?? [];
  const charges: HotelFee[] = detail
    .filter((c) => c.amount.amountMinor > 0)
    .map((c) => ({
      description: c.code ? `Cargo en destino (${c.code})` : 'Cargo en destino',
      ...(c.code ? { descriptionRaw: c.code } : {}),
      amount: c.amount,
    }));
  const taxes = pack.price.taxesAtDestination;
  if (charges.length === 0 && taxes !== undefined && taxes.amountMinor > 0) {
    charges.push({ description: 'Impuestos a pagar en el hotel', amount: taxes });
  }
  return charges.length > 0 ? charges : undefined;
}

/** El pack del ACL en la forma canónica: sólo los campos del contrato neutral. */
function neutralPack(pack: DespegarHotelRoompack, withBookingRef: boolean): HotelRoompack {
  const raw = withBookingRef ? bookingRawOf(pack) : undefined;
  const {
    mealPlanId,
    promo: _promo,
    price: { chargeAtDestinationDetail: _detail, taxesAtDestination: _taxes, ...price },
    ...rest
  } = pack;
  const out: HotelRoompack = {
    ...rest,
    price,
    provider:
      raw === undefined
        ? { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: pack.id }
        : { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: pack.id, raw },
  };
  // El literal del régimen y el desglose de cargos van en el detalle, que es desde donde se reserva
  // y lo que compara el PreBook; el listado sigue con el contrato de siempre.
  if (withBookingRef) {
    if (mealPlanId !== undefined) out.mealTypeRaw = mealPlanId.slice(0, 80);
    const charges = atPropertyChargesOf(pack);
    if (charges !== undefined) out.atPropertyCharges = charges;
  }
  return out;
}

function attributeOffer(offer: DespegarHotelOffer, withBookingRef: boolean): HotelOffer {
  const { notices, ...rest } = offer;
  const out: HotelOffer = {
    ...rest,
    roompacks: offer.roompacks.map((pack) => neutralPack(pack, withBookingRef)),
  };
  if (notices !== undefined && notices.length > 0) out.notices = notices;
  return out;
}

// ───────────────────────── Regímenes (catálogo de Despegar) ─────────────────────────

const MEAL_PLAN_TTL_MS = 24 * 60 * 60_000;
const MEAL_PLAN_RETRY_MS = 5 * 60_000;

/** De la descripción oficial (es/en/pt) al régimen canónico; `undefined` si no se reconoce. */
export function boardFromMealPlan(entry: MealPlanEntry): BoardType | undefined {
  const text = [entry.description.es, entry.description.en, entry.description.pt]
    .filter((t): t is string => t !== undefined)
    .join(' | ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (text === '') return undefined;
  if (/todo incluido|all inclusive|tudo incluido/.test(text)) return 'AI';
  if (/pension completa|full board|pensao completa/.test(text)) return 'FB';
  if (/media pension|half board|meia pensao/.test(text)) return 'HB';
  if (/desayuno|breakfast|cafe da manha/.test(text)) return 'BB';
  if (/solo alojamiento|sin comidas|room only|sem refeic|somente hospedagem/.test(text))
    return 'RO';
  return undefined;
}

/**
 * El régimen de cada pack del detalle según el catálogo: la etiqueta en español que da Despegar y,
 * si se reconoce, el régimen canónico. Un código que no está en el catálogo queda como lo dejó el
 * mapeo por palabra.
 */
function withMealPlans(offer: HotelOffer, catalog: ReadonlyMap<string, MealPlanEntry>): HotelOffer {
  if (catalog.size === 0) return offer;
  return {
    ...offer,
    roompacks: offer.roompacks.map((pack) => {
      const entry =
        pack.mealTypeRaw === undefined ? undefined : catalog.get(pack.mealTypeRaw.toUpperCase());
      if (entry === undefined) return pack;
      const board = boardFromMealPlan(entry);
      const label = entry.description.es ?? entry.description.en ?? entry.description.pt;
      return {
        ...pack,
        ...(board === undefined ? {} : { board }),
        ...(label === undefined ? {} : { boardLabel: label.slice(0, 120) }),
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

/**
 * Opciones de la CUENTA de Despegar que el envoltorio necesita para reservar y que no son del ACL:
 * contra qué entorno sale, cómo se le paga a Despegar y a nombre de quién factura.
 */
export interface DespegarNeutralOptions {
  environment?: 'test' | 'live';
  /**
   * Cómo se paga una reserva "al crédito de la cuenta" (`agency-credit`). Por defecto
   * `CURRENT_ACCOUNT`; `DEFERRED` si Despegar habilitó el pago remoto para la cuenta.
   */
  paymentType?: 'CURRENT_ACCOUNT' | 'ONE_CARD' | 'DEFERRED';
  /** Datos fiscales de la agencia titular: Despegar los exige con cuenta corriente y tarjeta. */
  invoice?: BookInvoice;
  /**
   * Descarta las fotos que el CDN de Despegar ya no tiene (despegar-picture-check.ts). Sin él, las
   * fotos se guardan como llegan.
   */
  pictures?: PictureFilter;
}

const MISSING_INVOICE =
  'La cuenta de Despegar no tiene cargados los datos de facturación de la agencia (credentials.invoice): Despegar los exige para reservar a cuenta corriente.';

/**
 * El pago "al crédito de la cuenta" en la forma que pide Despegar. `ONE_CARD` no se puede cargar
 * a la cuenta: necesita el token de un checkout alojado. `DEFERRED` toma el plan de `/payments`.
 */
async function agencyCreditPayment(
  acl: DespegarHotelsAcl,
  options: DespegarNeutralOptions,
  prebookRef: string,
): Promise<BookPayment> {
  const type = options.paymentType ?? 'CURRENT_ACCOUNT';
  if (type === 'ONE_CARD') {
    throw new DespegarHotelInputError(
      'unsupported-payment',
      'La cuenta de Despegar está configurada para pagar con tarjeta: esta reserva necesita el token del checkout alojado.',
    );
  }
  if (type === 'DEFERRED') {
    const modalities = await acl.getPaymentOptions({ prebookId: prebookRef });
    const plan = modalities
      .flatMap((m) => m.options)
      .find((o) => o.optionType === 'DEFERRED' && o.planId !== undefined);
    if (plan?.planId === undefined) {
      throw new DespegarHotelInputError(
        'unsupported-payment',
        'Despegar no ofreció pago diferido para esta tarifa. Cambia la forma de pago de la cuenta a cuenta corriente.',
      );
    }
    return { optionType: 'DEFERRED', units: [{ planId: plan.planId }] };
  }
  if (options.invoice === undefined) {
    throw new DespegarHotelInputError('missing-invoice', MISSING_INVOICE);
  }
  return {
    optionType: 'CURRENT_ACCOUNT',
    units: [{ type: 'CURRENT_ACCOUNT' }],
    invoices: [options.invoice],
  };
}

function toPayment(payment: HotelBookPayment, options: DespegarNeutralOptions): BookPayment {
  if (payment.kind !== 'hosted-token') {
    throw new DespegarHotelInputError(
      'unsupported-payment',
      'El pago a la cuenta se resuelve con agencyCreditPayment.',
    );
  }
  const invoices =
    payment.invoices?.map(toInvoice) ?? (options.invoice ? [options.invoice] : undefined);
  return {
    optionType: payment.optionType,
    invoices,
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

// ───────────────────────── Post-venta: de Despegar al contrato neutral ─────────────────────────

/** Sólo letras (latinas con tildes y ñ) y espacios: HotelDO rechaza el resto (certificación, 4). */
const DESPEGAR_NAME = /^[A-Za-zÀ-ÖØ-öø-ÿ]+( [A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

function assertDespegarName(name: string, roomIndex: number): void {
  if (!DESPEGAR_NAME.test(name.trim())) {
    throw new DespegarHotelInputError(
      'invalid-guest-name',
      `El huésped principal de la habitación ${roomIndex + 1} tiene caracteres que Despegar no acepta: use sólo letras y espacios.`,
    );
  }
}

const AFTERSALE_BOOKING_STATUS: Readonly<Record<AftersaleStatus, HotelBookingStatus>> = {
  ISSUED: 'CONFIRMED',
  IN_PROCESS: 'PENDING',
  CANCELLED: 'CANCELLED',
  DELETED: 'UNKNOWN',
  UNKNOWN: 'UNKNOWN',
};

function aftersaleView(r: AftersaleReservation, providerBookingId: string): HotelBookingView {
  const view: HotelBookingView = {
    found: true,
    providerBookingId: r.reservationId ?? providerBookingId,
    status: AFTERSALE_BOOKING_STATUS[r.status],
    providerStatus: r.rawStatus,
    warnings: [],
  };
  if (r.externalReservationId) view.bookingReference = r.externalReservationId;
  // El PNR del producto es la referencia del hotel para el check-in.
  if (r.pnr) view.hotelConfirmationNumber = r.pnr;
  if (r.downloadVoucherUrl) view.voucherIssued = true;
  return view;
}

function bookView(result: BookResult): HotelBookingView {
  const view: HotelBookingView = {
    found: true,
    status: BOOKING_STATUS[result.status],
    providerStatus: result.status,
    warnings: [],
  };
  if (result.reservationId) view.providerBookingId = result.reservationId;
  if (result.subStatus) view.providerSubStatus = result.subStatus;
  const pnr = result.products.find((p) => p.pnr)?.pnr;
  if (pnr) view.hotelConfirmationNumber = pnr;
  return view;
}

function bookingSummaryOf(
  r: AftersaleReservation,
  range: HotelBookingDateRange,
): HotelBookingSummary | undefined {
  const date = r.purchaseDateTime?.slice(0, 10);
  if (date === undefined || date < range.from || date > range.to) return undefined;
  const summary: HotelBookingSummary = {
    providerBookingId: r.reservationId ?? r.id,
    bookingDate: date,
    status: AFTERSALE_BOOKING_STATUS[r.status],
    providerStatus: r.rawStatus,
    providerRecordId: r.productId,
  };
  if (r.externalReservationId) summary.bookingReference = r.externalReservationId;
  if (r.checkIn) summary.checkinDate = r.checkIn.slice(0, 10);
  if (r.checkOut) summary.checkoutDate = r.checkOut.slice(0, 10);
  if (r.hotelId) summary.hotelId = r.hotelId;
  if (r.salePrice) {
    summary.total = r.salePrice;
    summary.currency = r.salePrice.currency;
  }
  return summary;
}

/** El reembolso que cotizó Despegar, sumado si viene por varios medios de pago. */
function refundOf(quote: CancelQuote | undefined): Money | undefined {
  const amounts = (quote?.refunds ?? [])
    .map((r) => r.refundAmount)
    .filter((m): m is Money => m !== undefined);
  const [first] = amounts;
  if (first === undefined || amounts.some((m) => m.currency !== first.currency)) return undefined;
  return {
    amountMinor: amounts.reduce((sum, m) => sum + m.amountMinor, 0),
    currency: first.currency,
  };
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
    HotelPriceJumpRecoveryPort,
    HotelBookingByClientReferencePort,
    HotelBookingsByDatePort,
    HotelContentPort,
    HotelContentBatchPort,
    HotelRoomContentPort
{
  constructor(
    private readonly acl: DespegarHotelsAcl,
    private readonly options: DespegarNeutralOptions = {},
  ) {}

  /**
   * El entorno de la cuenta (por su `baseUrl`): con `test` la web avisa que las reservas no son
   * habitaciones de verdad. Ausente si quien armó el adapter no lo dijo: `hasAccountEnvironment`
   * lo lee por valor, así que sin dato no se declara.
   */
  get accountEnvironment(): HotelAccountEnvironmentPort['accountEnvironment'] | undefined {
    return this.options.environment;
  }

  /** Una ventana de un mes: `/reservations` pagina, pero una ventana corta acota cada lectura. */
  readonly maxBookingDateWindowDays = 31;

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
    const [offer, mealPlans] = await Promise.all([
      this.acl.getHotelDetail({
        ...stayQuery(query),
        hotelId: query.hotelId,
        roompackId: query.roompackId,
      }),
      this.mealPlans(),
    ]);
    return withMealPlans(attributeOffer(offer, true), mealPlans);
  }

  #mealPlans: { at: number; value: Promise<ReadonlyMap<string, MealPlanEntry>> } | undefined;

  /**
   * El catálogo de regímenes de Despegar (`/content-api/hotels/meal-plans`), una vez al día. Los
   * códigos v3 no son los de la API anterior (docs/despegar/01): el régimen sale de su descripción
   * oficial. Si el catálogo no responde, se sigue con el mapeo por palabra y se reintenta en 5 min.
   */
  private mealPlans(): Promise<ReadonlyMap<string, MealPlanEntry>> {
    const now = Date.now();
    const cached = this.#mealPlans;
    if (cached !== undefined && now - cached.at < MEAL_PLAN_TTL_MS) return cached.value;
    const value = this.acl
      .getMealPlans()
      .then((entries) => {
        const map = new Map<string, MealPlanEntry>();
        for (const e of entries) {
          map.set(e.id.toUpperCase(), e);
          for (const sub of e.subCategories)
            map.set(sub.id.toUpperCase(), { ...sub, subCategories: [] });
        }
        return map;
      })
      .catch(() => {
        this.#mealPlans = { at: now - MEAL_PLAN_TTL_MS + MEAL_PLAN_RETRY_MS, value };
        return new Map<string, MealPlanEntry>();
      });
    this.#mealPlans = { at: now, value };
    return value;
  }

  suggestDestinations(
    query: string,
    _ctx: SearchContext,
    locale?: string,
  ): Promise<HotelDestinationSuggestion[]> {
    return this.acl.suggest(query, locale);
  }

  // ───────────────────────── Contenido estático ─────────────────────────

  /** `/content-api/hotels` acepta hasta 100 ids; de a 50 para no alargar la espera. */
  get contentBatchSize(): number {
    return DESPEGAR_CONTENT_BATCH_SIZE;
  }

  /**
   * Fotos y ficha de un lote, para GUARDARLAS en el catálogo (fotos de los resultados). Lo que
   * Despegar no devolvió es contenido confirmado como ausente: no tiene un idioma de respaldo que
   * cambie la respuesta (las fotos no dependen del idioma).
   */
  async fetchHotelContents(
    hotelIds: readonly string[],
    lang: HotelContentLanguage,
    _ctx: SearchContext,
    _options: HotelContentFetchOptions,
  ): Promise<HotelContentBatch> {
    const found = await this.livePictures(
      await this.acl.getHotelsContent(hotelIds, toDespegarLanguage(lang)),
    );
    const byId = new Map(found.map((c) => [c.id, c]));
    return {
      contents: hotelIds.flatMap((id) => {
        const c = byId.get(id);
        return c === undefined ? [] : [despegarContentRecord(c, lang)];
      }),
      missingHotelIds: hotelIds.filter((id) => !byId.has(id)),
      calls: { total: 1, fallback: 0, isolation: 0 },
    };
  }

  async fetchHotelContent(
    hotelId: string,
    lang: HotelContentLanguage,
    _ctx: SearchContext,
    _options: HotelContentFetchOptions,
  ): Promise<HotelProviderContent | null> {
    const [c] = await this.livePictures(
      await this.acl.getHotelsContent([hotelId], toDespegarLanguage(lang)),
    );
    return c === undefined || c.id !== hotelId ? null : despegarProviderContent(c, lang);
  }

  /** Las fotos de hoteles y habitaciones sin las que el CDN ya no tiene. */
  private async livePictures(
    contents: readonly DespegarHotelContent[],
  ): Promise<DespegarHotelContent[]> {
    const filter = this.options.pictures;
    if (filter === undefined) return [...contents];
    return Promise.all(
      contents.map(async (c) => {
        const [pictures, roomTypes] = await Promise.all([
          filter(c.pictures, DESPEGAR_PICTURES_PER_HOTEL),
          Promise.all(
            c.roomTypes.map(async (rt) => ({
              ...rt,
              pictures: await filter(rt.pictures, DESPEGAR_PICTURES_PER_ROOM),
            })),
          ),
        ]);
        return { ...c, pictures, roomTypes };
      }),
    );
  }

  /** Las habitaciones del hotel (`room_types[]`), con su id = el `roomTypeId` de las tarifas. */
  async fetchHotelRoomContent(
    hotelId: string,
    lang: HotelContentLanguage,
    _ctx: SearchContext,
    _options: HotelContentFetchOptions,
  ): Promise<HotelRoomContentFetch> {
    const [c] = await this.livePictures(
      await this.acl.getHotelsContent([hotelId], toDespegarLanguage(lang)),
    );
    if (c === undefined || c.id !== hotelId) return { lang, outcome: 'none', rooms: [] };
    const rooms = c.roomTypes
      .map((rt) => despegarRoomContent(rt, lang))
      .filter((r): r is HotelProviderRoomContent => r !== undefined);
    return rooms.length === 0
      ? { lang, outcome: 'unreadable', rooms: [] }
      : { lang, outcome: 'rooms', rooms };
  }

  // ───────────────────────── Reserva ─────────────────────────

  async prebook(request: HotelPrebookRequest, _ctx: SearchContext): Promise<HotelPrebookResult> {
    this.assertOwnOffer(request.offer);
    const { choiceId } = parseRaw(
      ChoiceRawSchema,
      request.offer,
      'missing-choice',
      'La tarifa no trae un único token de reserva de Despegar. Vuelve a pedir las tarifas del hotel y elige la habitación.',
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
      'La tarifa no trae la numeración de habitaciones de Despegar. Vuelve a pedir las tarifas del hotel.',
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
      assertDespegarName(lead.firstName, j);
      assertDespegarName(lead.lastName, j);
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
      payment:
        request.payment.kind === 'agency-credit'
          ? await agencyCreditPayment(this.acl, this.options, request.prebookRef)
          : toPayment(request.payment, this.options),
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

  /**
   * El estado de post-venta (`/reservations`: emitida, en proceso, cancelada) manda sobre el del
   * Book, que nunca dice "cancelada". Si `/reservations` todavía no trae el producto —pasa en el
   * primer minuto—, se lee `/book/{id}`.
   */
  async getBooking(providerBookingId: string, _ctx: SearchContext): Promise<HotelBookingView> {
    const product = await this.acl.findHotelReservation(providerBookingId);
    if (product !== undefined) return aftersaleView(product, providerBookingId);
    return bookView(await this.acl.getReservation(providerBookingId));
  }

  /** `GET /book/{external_booking_reference}`: Despegar documenta que acepta nuestra referencia. */
  async getBookingByClientReference(
    bookingReference: string,
    _ctx: SearchContext,
  ): Promise<HotelBookingView> {
    try {
      const view = bookView(await this.acl.getReservation(bookingReference));
      return { ...view, bookingReference };
    } catch (err) {
      if (err instanceof DespegarApiError && err.status === 404) {
        return { found: false, bookingReference, warnings: [] };
      }
      throw err;
    }
  }

  async listBookingsByDate(
    range: HotelBookingDateRange,
    _ctx: SearchContext,
  ): Promise<HotelBookingsByDateResult> {
    const bookings: HotelBookingSummary[] = [];
    const limit = 50;
    // Tope de páginas: una cuenta con miles de reservas en un mes no cuelga la conciliación.
    for (let page = 0; page < 40; page++) {
      const items = await this.acl.findReservations({
        fromPurchaseDate: range.from,
        toPurchaseDate: range.to,
        productType: 'HOTEL',
        limit,
        page,
      });
      for (const r of items) {
        // `by_api_key` trae todos los productos de la cuenta (vuelos, tickets…): sólo hoteles.
        if (r.productType !== '' && r.productType !== 'HOTEL') continue;
        const summary = bookingSummaryOf(r, range);
        if (summary !== undefined) bookings.push(summary);
      }
      if (items.length < limit) return { range, bookings };
    }
    throw new Error('Despegar devolvió más reservas de las que se leen en una ventana');
  }

  /**
   * Los tres pasos de Despegar (habilitación, cotización, cancelación). El reembolso es el que
   * cotizó Despegar; una cancelación con resolución `MANUAL` o un `flow_id` que no es `CAN-` queda
   * en curso, no cancelada.
   */
  async cancelBooking(
    request: HotelCancelRequest,
    _ctx: SearchContext,
  ): Promise<HotelCancelResult> {
    const options = parseOptions(CancelOptionsSchema, request.providerOptions);
    const result = await this.acl.cancelReservation({
      reservationId: request.providerBookingId,
      reason: options.reason,
    });
    const out: HotelCancelResult = { success: result.success, warnings: [] };
    const refund = refundOf(result.quote);
    if (refund !== undefined) out.refundAmount = refund;
    const final =
      result.flowId?.startsWith('CAN-') === true && result.quote?.resolution !== 'MANUAL';
    out.settlement = final ? 'final' : 'in-progress';
    out.bookingStatus = final ? 'CANCELLED' : 'CANCELLATION_IN_PROGRESS';
    if (result.quote?.resolution === 'MANUAL') out.warnings.push('cancel-manual-resolution');
    return out;
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
