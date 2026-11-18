import { createHash, randomBytes } from 'node:crypto';
import type {
  HotelRatesQuery,
  HotelRoomOccupancy,
  HotelRoompack,
  Money,
} from '@sales-travel/canonical';
import {
  DespegarApiError,
  type HotelNotice,
  type PrebookResult,
} from '@sales-travel/despegar-hotels';
import type {
  HotelBookingRoomGuests,
  HotelRateCondition,
  SearchContext,
} from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import type {
  HotelAccountIssuePort,
  HotelBookContextRequest,
  HotelBookFailure,
  HotelBookWithContext,
  HotelBookingContextPort,
  HotelGuestCheck,
  HotelGuestSent,
  HotelOfferInvalidation,
  HotelPrebookContextPort,
  HotelPrebookContextRequest,
  HotelPrebookWithContext,
  HotelPriceDirection,
  HotelProviderAccountFingerprint,
  HotelProviderAccountIssue,
  HotelProviderData,
  HotelRateBaseline,
  HotelRateConditionChange,
  HotelRatesContextPort,
  HotelRatesWithContext,
  HotelRepriceComparison,
  HotelSearchPackContext,
} from '../providers/hotel-provider.types.js';
import {
  DESPEGAR_HOTELS_PROVIDER_CODE,
  DespegarHotelInputError,
  DespegarHotelProviderAdapter,
  type DespegarHotelsAcl,
  type DespegarNeutralOptions,
} from './despegar-hotel-provider.adapter.js';

/*
 * Despegar en el flujo de reserva con órdenes (el de la web): detalle con contexto en el servidor,
 * PreBook revalidado contra lo mostrado (C1) y contra lo aceptado (C2), y Book con una referencia
 * NUESTRA persistida antes de llamar, que se puede leer si la respuesta no llega
 * (`GET /book/{external_booking_reference}`).
 *
 * Lo que Despegar necesita reenviar y no cabe en `offerRef` —el `choice_id`, la estadía con la que
 * se vuelve a pedir el detalle y, después del PreBook, el `prebook_id`— viaja en `providerData`,
 * que queda en el servidor y nunca llega al navegador.
 */

/** Cuánto vive el contexto de un detalle. Despegar no publica la vida de un `choice_id`. */
export const DESPEGAR_DETAIL_CONTEXT_TTL_MS = 30 * 60_000;

/** `providerData` de una tarifa: lo que hace falta para volver a pedirla y reservarla. */
const DespegarPackDataSchema = z
  .object({
    roompackId: z.string().min(1).max(255),
    hotelId: z.string().min(1).max(64),
    checkinDate: z.string().date(),
    checkoutDate: z.string().date(),
    currency: z.string().length(3),
    countryCode: z.string().length(2).optional(),
    language: z.enum(['ES', 'PT', 'EN']).optional(),
    roomReferences: z.array(z.number().int().nonnegative()).min(1).max(8),
    /** Sólo después del PreBook. */
    prebookId: z.string().min(1).max(255).optional(),
  })
  .strict();
type DespegarPackData = z.infer<typeof DespegarPackDataSchema>;

function packDataOf(data: HotelProviderData | undefined): DespegarPackData {
  const parsed = DespegarPackDataSchema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new DespegarHotelInputError(
      'missing-choice',
      'La tarifa de Despegar no trae lo que hace falta para reservarla. Abre el hotel y vuelve a elegirla.',
    );
  }
  return parsed.data;
}

/** El literal decimal de un `Money` (dos decimales): lo que el contexto guarda como `totalText`. */
export function moneyText(m: Money): string {
  const minor = Math.max(0, Math.round(m.amountMinor));
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Los avisos del hotel como condiciones de la tarifa: así llegan al checkout y a la orden. */
function noticeConditions(notices: readonly HotelNotice[] | undefined): HotelRateCondition[] {
  return (notices ?? []).map((n) => {
    const text = n.title ? `${n.title}: ${n.text}` : n.text;
    return {
      category: n.level === 'primary' ? 'specialInstructions' : 'other',
      text: text.slice(0, 20_000),
      raw: text.slice(0, 20_000),
    };
  });
}

function conditionsHash(conditions: readonly HotelRateCondition[]): string {
  const texts = conditions.map((c) => `${c.category}|${c.text}`).sort();
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex');
}

// ───────────────────────── Comparación C1 / C2 ─────────────────────────

const CHANGE_ORDER: readonly HotelRateConditionChange[] = [
  'CURRENCY',
  'REFUNDABLE',
  'MEAL_TYPE',
  'AT_PROPERTY_CHARGES',
  'CANCEL_POLICIES',
  'SIGNALS',
  'RATE_CONDITIONS',
];

function feeKey(pack: Pick<HotelRoompack, 'atPropertyCharges'>): string {
  return (pack.atPropertyCharges ?? [])
    .map((f) => `${f.descriptionRaw ?? f.description}|${f.amount.currency}|${f.amount.amountMinor}`)
    .sort()
    .join(';');
}

function rulesKey(pack: HotelRoompack): string {
  return pack.cancellation.rules
    .map((r) =>
      [
        r.type,
        r.fromHours ?? '',
        r.toHours ?? '',
        r.penaltyPercentage ?? '',
        r.penaltyNights ?? '',
      ].join('|'),
    )
    .sort()
    .join(';');
}

/**
 * Lo mismo que compara TBO (docs/tbo/03 §2.9), sobre las unidades menores: Despegar da importes
 * numéricos, no un literal que reenviar. C1 mira precio, moneda, reembolsable, régimen y cargos en
 * el hotel; C2 suma políticas y el texto de los avisos.
 */
export function compareDespegarRates(
  baseline: HotelRateBaseline,
  current: HotelRoompack,
  currentHash: string,
): HotelRepriceComparison {
  const changed = new Set<HotelRateConditionChange>();
  let previousTotal: Money;
  if (baseline.stage === 'C1') {
    const seen = baseline.seen;
    previousTotal = seen.total;
    if (seen.refundable !== current.cancellation.refundable) changed.add('REFUNDABLE');
    if ((seen.mealTypeRaw ?? seen.board) !== (current.mealTypeRaw ?? current.board)) {
      changed.add('MEAL_TYPE');
    }
    if (feeKey({ atPropertyCharges: [...seen.atPropertyCharges] }) !== feeKey(current)) {
      changed.add('AT_PROPERTY_CHARGES');
    }
  } else {
    const accepted = baseline.accepted.roompack;
    previousTotal = accepted.price.total;
    if (accepted.cancellation.refundable !== current.cancellation.refundable)
      changed.add('REFUNDABLE');
    if ((accepted.mealTypeRaw ?? accepted.board) !== (current.mealTypeRaw ?? current.board)) {
      changed.add('MEAL_TYPE');
    }
    if (feeKey(accepted) !== feeKey(current)) changed.add('AT_PROPERTY_CHARGES');
    if (
      accepted.cancellation.status !== current.cancellation.status ||
      rulesKey(accepted) !== rulesKey(current)
    ) {
      changed.add('CANCEL_POLICIES');
    }
    if (baseline.accepted.rateConditionsHash !== currentHash) changed.add('RATE_CONDITIONS');
  }
  const currentTotal = current.price.total;
  let price: HotelPriceDirection;
  if (previousTotal.currency !== currentTotal.currency) {
    changed.add('CURRENCY');
    price = 'NOT_COMPARABLE';
  } else {
    const diff = currentTotal.amountMinor - previousTotal.amountMinor;
    price = diff === 0 ? 'SAME' : diff < 0 ? 'DOWN' : 'UP';
  }
  const changes = CHANGE_ORDER.filter((c) => changed.has(c));
  return {
    stage: baseline.stage,
    outcome:
      changes.length > 0
        ? 'CONDITIONS_CHANGED'
        : price === 'UP'
          ? 'INCREASED'
          : price === 'DOWN'
            ? 'DECREASED'
            : 'UNCHANGED',
    price,
    changes,
    previousTotal: { ...previousTotal },
    currentTotal: { ...currentTotal },
  };
}

// ───────────────────────── Errores ─────────────────────────

/** El detalle ya no trae la tarifa (o la trae sin `choice_id`): no hay qué revalidar. */
export class DespegarOfferGoneError extends Error {
  constructor() {
    super('Despegar ya no ofrece esta tarifa');
    this.name = 'DespegarOfferGoneError';
  }
}

const OFFER_GONE_CODES: ReadonlySet<string> = new Set([
  'PRODUCT_GONE',
  'INVALID_ITINERARY_ID_OR_COUNTRY',
]);

const BALANCE_CODES: ReadonlySet<string> = new Set(['NOT_ENOUGH_BALANCE', 'INSUFFICIENT_FUNDS']);

/** Un `sub_status` de un Book que respondió `ERROR`: se lanza para que el breaker y la saga lo vean. */
export class DespegarBookRejectedError extends Error {
  constructor(readonly subStatus: string | undefined) {
    super(`Despegar rechazó el Book${subStatus ? ` (${subStatus})` : ''}`);
    this.name = 'DespegarBookRejectedError';
  }
}

/** `SD` + entorno + 18 caracteres: única por intento de Book y legible por `GET /book/{ref}`. */
export function newDespegarBookingReference(environment: 'test' | 'live'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(18);
  let out = environment === 'live' ? 'SDL' : 'SDT';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Sólo letras (latinas, con tildes y ñ) y espacios: HotelDO rechaza el resto. */
const DESPEGAR_NAME = /^[A-Za-zÀ-ÖØ-öø-ÿ]+( [A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

// ───────────────────────── Adapter ─────────────────────────

/**
 * Despegar con una cuenta de la bóveda: además de lo de {@link DespegarHotelProviderAdapter},
 * reserva por la saga con órdenes. Con la clave de plataforma (`env`) no hay cuenta a la que atar
 * la orden y se usa el adapter base, que no reserva por órdenes.
 */
export class DespegarContextHotelProviderAdapter
  extends DespegarHotelProviderAdapter
  implements
    HotelRatesContextPort,
    HotelPrebookContextPort,
    HotelBookingContextPort,
    HotelAccountIssuePort
{
  readonly #account: HotelProviderAccountFingerprint;
  readonly #acl: DespegarHotelsAcl;
  readonly #options: DespegarNeutralOptions;

  constructor(
    acl: DespegarHotelsAcl,
    options: DespegarNeutralOptions,
    account: HotelProviderAccountFingerprint,
  ) {
    super(acl, options);
    this.#acl = acl;
    this.#options = options;
    this.#account = { accountId: account.accountId, updatedAt: account.updatedAt };
  }

  get searchAccount(): HotelProviderAccountFingerprint {
    return { ...this.#account };
  }

  // ───────────────────────── Detalle con contexto ─────────────────────────

  async getHotelRatesWithContext(
    query: HotelRatesQuery,
    ctx: SearchContext,
  ): Promise<HotelRatesWithContext> {
    const searchSentAt = Date.now();
    const offer = await this.getHotelRates(query, ctx);
    const packs: HotelSearchPackContext[] = offer.roompacks.flatMap((pack) => {
      const raw = pack.provider.raw;
      const choiceId = typeof raw?.['choiceId'] === 'string' ? raw['choiceId'] : undefined;
      const references = raw?.['roomReferences'];
      if (choiceId === undefined || !Array.isArray(references)) return [];
      const providerData: DespegarPackData = {
        roompackId: pack.id,
        hotelId: offer.hotelId,
        checkinDate: query.checkinDate,
        checkoutDate: query.checkoutDate,
        currency: query.currency,
        roomReferences: references.filter((r): r is number => typeof r === 'number'),
        ...(query.pointOfSaleCountry === undefined
          ? {}
          : { countryCode: query.pointOfSaleCountry }),
        ...(query.language === undefined
          ? {}
          : { language: query.language.toUpperCase() as 'ES' | 'PT' | 'EN' }),
      };
      return [
        {
          hotelId: offer.hotelId,
          offerRef: pack.provider.offerRef,
          totalText: moneyText(pack.price.total),
          currency: pack.price.total.currency,
          providerData: { ...providerData, roomReferences: [...providerData.roomReferences] },
        },
      ];
    });
    return {
      searchId: `dsp-${randomBytes(12).toString('hex')}`,
      searchSentAt,
      expiresAt: searchSentAt + DESPEGAR_DETAIL_CONTEXT_TTL_MS,
      packs,
      offer,
    };
  }

  // ───────────────────────── PreBook con contexto ─────────────────────────

  /**
   * Vuelve a pedir el detalle de ESA tarifa (un `choice_id` fresco y las políticas vigentes) y abre
   * el prebook con él. Así C2, minutos después de C1, no depende de un token viejo.
   */
  async prebookWithContext(
    request: HotelPrebookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelPrebookWithContext> {
    const data = packDataOf(request.providerData);
    const offer = await this.getHotelRates(
      {
        hotelId: data.hotelId,
        roompackId: data.roompackId,
        checkinDate: data.checkinDate,
        checkoutDate: data.checkoutDate,
        currency: data.currency,
        rooms: request.rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
        ...(data.countryCode === undefined ? {} : { pointOfSaleCountry: data.countryCode }),
        ...(data.language === undefined
          ? {}
          : { language: data.language.toLowerCase() as 'es' | 'pt' | 'en' }),
      },
      ctx,
    );
    const pack = offer.roompacks.find((p) => p.id === data.roompackId);
    const raw = pack?.provider.raw;
    const choiceId = typeof raw?.['choiceId'] === 'string' ? raw['choiceId'] : undefined;
    if (pack === undefined || choiceId === undefined) throw new DespegarOfferGoneError();

    const prebook: PrebookResult = await this.#acl.prebook({
      choiceId,
      include: ['EXCHANGE_POLICIES', 'HINTS'],
      ...(data.language === undefined
        ? {}
        : { lang: data.language.toLowerCase() as 'es' | 'pt' | 'en' }),
    });

    const warnings: string[] = [];
    // El prebook cotiza en la moneda de la CUENTA: sólo reemplaza el total si es la del pack.
    const total =
      prebook.total.currency === pack.price.total.currency && prebook.total.amountMinor > 0
        ? prebook.total
        : pack.price.total;
    if (prebook.total.currency !== pack.price.total.currency) {
      warnings.push('prebook-account-currency-differs');
    }
    const roompack: HotelRoompack = {
      ...pack,
      price: { ...pack.price, total },
      cancellation: { ...pack.cancellation, policySource: 'prebook-final' },
      provider: { name: DESPEGAR_HOTELS_PROVIDER_CODE, offerRef: pack.provider.offerRef },
    };
    const rateConditions = noticeConditions(offer.notices);
    const hash = conditionsHash(rateConditions);
    const references = Array.isArray(raw?.['roomReferences'])
      ? (raw['roomReferences'] as unknown[]).filter((r): r is number => typeof r === 'number')
      : data.roomReferences;

    const result: HotelPrebookWithContext['result'] = {
      total,
      roompack,
      rateConditions,
      signals: [],
      warnings,
      ...(prebook.prebookId ? { prebookRef: prebook.prebookId } : {}),
      ...(prebook.status ? { providerStatus: prebook.status } : {}),
      ...(prebook.commission === undefined ? {} : { agencyCommission: prebook.commission }),
    };
    if (prebook.expiration !== undefined && !Number.isNaN(Date.parse(prebook.expiration))) {
      if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(prebook.expiration)) result.expiresAt = prebook.expiration;
    }

    return {
      result,
      pack: {
        hotelId: data.hotelId,
        offerRef: pack.provider.offerRef,
        totalText: moneyText(total),
        currency: total.currency,
        providerData: {
          ...data,
          roomReferences: [...references],
          ...(prebook.prebookId ? { prebookId: prebook.prebookId } : {}),
        },
      },
      rateConditionsHash: hash,
      comparison: compareDespegarRates(request.baseline, roompack, hash),
    };
  }

  offerInvalidatedBy(err: unknown): HotelOfferInvalidation | undefined {
    if (err instanceof DespegarOfferGoneError) return 'offer';
    if (err instanceof DespegarApiError) {
      if (err.status === 410) return 'offer';
      const code = err.providerCode;
      if (code !== undefined && OFFER_GONE_CODES.has(code)) return 'offer';
    }
    return undefined;
  }

  accountIssueOf(err: unknown): HotelProviderAccountIssue | undefined {
    if (
      err instanceof DespegarBookRejectedError &&
      err.subStatus &&
      BALANCE_CODES.has(err.subStatus)
    ) {
      return 'insufficient-balance';
    }
    if (
      err instanceof DespegarApiError &&
      err.providerCode &&
      BALANCE_CODES.has(err.providerCode)
    ) {
      return 'insufficient-balance';
    }
    return undefined;
  }

  // ───────────────────────── Book con contexto ─────────────────────────

  newBookingReference(): string {
    return newDespegarBookingReference(this.#options.environment ?? 'test');
  }

  /**
   * Despegar recibe UN huésped por habitación, el principal, con nombre sólo de letras. Los demás
   * quedan en la orden, no salen al proveedor.
   */
  checkBookingGuests(
    rooms: readonly HotelBookingRoomGuests[],
    occupancy: readonly HotelRoomOccupancy[],
  ): HotelGuestCheck {
    const issues: string[] = [];
    if (rooms.length !== occupancy.length) issues.push('rooms:count_mismatch');
    const sent: HotelGuestSent[][] = rooms.map((room, j) => {
      const lead = room.guests[0];
      if (lead === undefined) {
        issues.push(`rooms.${j}.guests:missing_lead`);
        return [];
      }
      if (lead.paxType !== 'ADT') issues.push(`rooms.${j}.guests.0.paxType:lead_not_adult`);
      if (lead.title === undefined) issues.push(`rooms.${j}.guests.0.title:required`);
      for (const field of ['firstName', 'lastName'] as const) {
        const value = lead[field].trim();
        if (value.length < 2) issues.push(`rooms.${j}.guests.0.${field}:too_short`);
        else if (!DESPEGAR_NAME.test(value))
          issues.push(`rooms.${j}.guests.0.${field}:invalid_characters`);
      }
      return [
        {
          title: lead.title ?? 'Mr',
          firstName: lead.firstName.trim(),
          lastName: lead.lastName.trim(),
          paxType: 'ADT',
        },
      ];
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, rooms: sent };
  }

  /**
   * UN intento, con el `prebook_id` del PreBook de revalidación (C2) y nuestra referencia. Un
   * `ERROR` de Despegar se lanza ({@link DespegarBookRejectedError}) para que el breaker lo cuente y
   * {@link bookFailureOf} diga que no se reservó; `PROCESSING` queda para verificar leyendo.
   */
  async bookWithContext(
    request: HotelBookContextRequest,
    ctx: SearchContext,
  ): Promise<HotelBookWithContext> {
    const data = packDataOf(request.providerData);
    if (data.prebookId === undefined) {
      throw new DespegarHotelInputError(
        'missing-prebook',
        'Despegar Hoteles reserva sobre un prebook vigente: falta la referencia del prebook.',
      );
    }
    const result = await this.book(
      {
        offer: {
          name: DESPEGAR_HOTELS_PROVIDER_CODE,
          offerRef: request.offerRef,
          raw: { choiceId: 'prebooked', roomReferences: [...data.roomReferences] },
        },
        prebookRef: data.prebookId,
        bookingReference: request.bookingReference,
        rooms: request.rooms.map((r) => ({ guests: [...r.guests] })),
        contact: request.contact,
        payment: { kind: 'agency-credit' },
      },
      ctx,
    );
    if (result.outcome === 'FAILED') throw new DespegarBookRejectedError(result.providerSubStatus);
    const reason =
      result.outcome === 'CONFIRMED'
        ? 'confirmed'
        : result.providerSubStatus === 'PRICE_JUMP'
          ? 'price-jump'
          : result.outcome === 'PENDING'
            ? 'processing'
            : 'missing-confirmation-number';
    return { result, reason };
  }

  /**
   * Qué significa lo que lanzó el Book: un rechazo local no salió; un `ERROR` o un 4xx de Despegar
   * es un "no reservé"; lo demás (red, timeout, 5xx, 409) puede haber reservado y se verifica
   * leyendo por nuestra referencia, nunca reservando otra vez.
   */
  bookFailureOf(err: unknown): HotelBookFailure {
    if (err instanceof DespegarHotelInputError) {
      return { outcome: 'FAILED', reason: err.reason, dispatched: false, errorClass: err.name };
    }
    if (err instanceof DespegarBookRejectedError) {
      return {
        outcome: 'FAILED',
        reason: 'provider-rejected',
        dispatched: true,
        ...(err.subStatus ? { providerStatus: err.subStatus } : {}),
        errorClass: err.name,
      };
    }
    if (err instanceof DespegarApiError) {
      const definite =
        err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;
      return {
        outcome: definite ? 'FAILED' : 'UNCERTAIN',
        reason: definite ? 'provider-rejected' : err.status === 0 ? 'transport' : 'provider-error',
        dispatched: true,
        providerStatus: err.providerCode ?? String(err.status),
        errorClass: err.name,
      };
    }
    return {
      outcome: 'UNCERTAIN',
      reason: 'unknown-error',
      dispatched: true,
      ...(err instanceof Error ? { errorClass: err.name } : {}),
    };
  }
}
