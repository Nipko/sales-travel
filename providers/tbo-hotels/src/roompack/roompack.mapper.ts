import {
  HotelRoompackSchema,
  type HotelFee,
  type HotelPrice,
  type HotelRoom,
  type HotelRoomOccupancy,
  type HotelRoompack,
  type Money,
} from '@sales-travel/canonical';
import { mapTboCancellation, type TboPolicySource } from '../cancellation/policy.mapper';
import {
  SUPPORTED_MINOR_UNIT_EXPONENT,
  decimalToMinor,
  isSupportedCurrency,
  minorUnitExponent,
  toMinorUnits,
  type MinorUnits,
} from '../internal/decimal';
import { zodIssueRefs } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { mapTboMealType } from '../search/meal-type';
import {
  TBO_CANCEL_POLICY_KEYS,
  TBO_DAY_RATE_KEYS,
  TBO_SUPPLEMENT_KEYS,
  TboSearchRoomSchema,
  type TboDecimal,
  type TboSearchRoom,
  type TboSupplement,
} from '../search/response.schema';

/**
 * Un elemento de `HotelResult[].Rooms[]` → roompack neutral (docs/tbo/02 §9; 03 §2.2; 08 RF-07,
 * RF-10, RF-11 y RF-15).
 *
 * Lo comparten Search y PreBook, como `cancellation/policy.mapper.ts`: la habitación de PreBook
 * tiene la forma de la de Search más `Amenities` (p. 20-23), y la comparación de precio y
 * condiciones (C1, 03 §2.9) sólo es honesta si los dos lados salen del MISMO mapeo. Dos copias
 * derivarían en la siguiente edición y un pack idéntico se leería como "condiciones cambiadas".
 *
 * Lo que cambia entre operaciones viaja en el `scope`: el origen de las políticas (indicativas en
 * Search, finales en PreBook, KP-3 p. 71), el nombre de la operación en las métricas y las claves
 * que la operación conoce. Qué se hace con un pack rechazado lo decide quien llama: Search lo
 * descarta y lo mide; PreBook no tiene otro y falla.
 */

// ───────────────────────── Contrato ─────────────────────────

/** Lo que el servidor guarda por pack para el PreBook y el Book (RF-08). Nunca va al navegador. */
export interface TboSearchPackContext {
  readonly hotelCode: string;
  readonly bookingCode: string;
  /**
   * `TotalFare` como texto decimal: el Book lo reenvía ("Total fare for the booking", p. 33) y el
   * valor reenviado no puede ser una reconstrucción desde unidades menores (02 §8.3 punto 2).
   */
  readonly totalFare: string;
  readonly currency: string;
}

export type TboHotelRejection =
  | 'HOTEL_SCHEMA'
  | 'CURRENCY_MISSING'
  | 'CURRENCY_INVALID'
  | 'UNSUPPORTED_CURRENCY';

export type TboPackRejection =
  | 'PACK_SCHEMA'
  | 'ROOM_COUNT_MISMATCH'
  | 'AMOUNT_NEGATIVE'
  | 'AMOUNT_INVALID'
  | 'SUPPLEMENT_INVALID'
  | 'CANCEL_POLICY'
  | 'DUPLICATE_BOOKING_CODE'
  | 'CONTRACT';

export type TboRejection<R extends string> = {
  readonly ok: false;
  readonly reason: R;
  readonly issues: readonly string[];
};

/**
 * Lo que el mapeo de un pack reporta mientras lee. La implementación nunca puede cambiar el
 * resultado: un logger o unas métricas que lanzan no le quitan a nadie su tarifa.
 */
export interface TboPackObserver {
  /** Nombres de claves de `value` que no están en `known`, con la ruta del nivel. */
  collectUnknownKeys(value: unknown, known: readonly string[], prefix: string): void;
  precisionLoss(field: string): void;
  count(name: string, tags: Record<string, string>): void;
  unknownMealType(): void;
}

export interface TboPackScope {
  /** Nombre de la operación en las métricas: `tbo.search.…` o `tbo.prebook.…`. */
  readonly op: 'search' | 'prebook';
  /** Search con detalle da políticas indicativas; PreBook, las finales (KP-3, p. 71). */
  readonly source: TboPolicySource;
  readonly hotelCode: string;
  /** La de `HotelResult[].Currency`, ya validada con {@link readTboHotelCurrency}. */
  readonly currency: string;
  /** Id NUESTRO de la búsqueda: única clave que va en `provider.raw`. */
  readonly searchId: string;
  /** Instante ISO de vencimiento, calculado desde el envío del Search (RF-09). */
  readonly expiresAt: string;
  /** Ocupación pedida, en el orden del request: TBO devuelve los nombres en ese orden (p. 13). */
  readonly rooms: readonly HotelRoomOccupancy[];
  /** Claves de la habitación que la operación conoce: el resto se registra por nombre (C-12). */
  readonly knownRoomKeys: readonly string[];
  readonly observer: TboPackObserver;
}

export type TboPackOutcome =
  | { readonly ok: true; readonly pack: HotelRoompack; readonly context: TboSearchPackContext }
  | TboRejection<TboPackRejection>;

// ───────────────────────── Piezas ─────────────────────────

/** Techos de `packages/canonical/src/hotel-offer.ts`: el texto de TBO se recorta, no rompe el pack. */
const ROOM_NAME_MAX = 500;
const PROMOTION_MAX = 500;
const ROOM_TYPE_ID_MAX = 64;
const FEE_DESCRIPTION_MAX = 200;
const INCLUSION_MAX = 2000;

const ROOM_PREFIX = 'HotelResult[].Rooms[].';

/**
 * Códigos de `Supplements[].Description` que sabemos traducir. `mandatory_tax` es el único con
 * evidencia (p. 15); no hay catálogo (Q-27), así que el resto se muestra tal cual.
 */
const SUPPLEMENT_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['mandatorytax', 'Impuesto obligatorio'],
]);

export function rejectTbo<R extends string>(reason: R, issues: readonly string[]): TboRejection<R> {
  return { ok: false, reason, issues };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function normalizeCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Unidades menores → texto decimal con el exponente ISO de la moneda (`25810`, 3 → `"25.810"`). */
function formatMinor(amountMinor: number, exponent: number): string {
  if (exponent === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

function amountRejection(field: string, result: Extract<MinorUnits, { ok: false }>) {
  return rejectTbo<TboPackRejection>(
    result.reason === 'NEGATIVE' ? 'AMOUNT_NEGATIVE' : 'AMOUNT_INVALID',
    [`${field}:${result.reason.toLowerCase()}`],
  );
}

// ───────────────────────── Moneda del hotel ─────────────────────────

export type TboCurrencyRead =
  | { readonly ok: true; readonly currency: string }
  | (TboRejection<TboHotelRejection> & {
      /** Sólo en `UNSUPPORTED_CURRENCY`: el código, que ya pasó la forma ISO. */
      readonly unsupported?: string;
    });

/** S-08: nunca `'USD'` por defecto. Todo importe del hotel, salvo los suplementos, va en ésta. */
export function readTboHotelCurrency(value: unknown): TboCurrencyRead {
  if (value === undefined || value === null) {
    return rejectTbo('CURRENCY_MISSING', ['HotelResult.Currency:missing']);
  }
  if (typeof value !== 'string') {
    return rejectTbo('CURRENCY_INVALID', ['HotelResult.Currency:invalid_type']);
  }
  const currency = value.trim();
  if (currency.length === 0) return rejectTbo('CURRENCY_MISSING', ['HotelResult.Currency:missing']);
  if (!/^[A-Z]{3}$/.test(currency)) {
    return rejectTbo('CURRENCY_INVALID', ['HotelResult.Currency:invalid_string']);
  }
  // Guarda de exponente (02 §8.3 punto 3): `Money` asume dos decimales y un perfil en CLP o KWD
  // saldría escalado por 100 o por 10 sin que nadie lo note.
  if (!isSupportedCurrency(currency)) {
    return {
      ...rejectTbo<TboHotelRejection>('UNSUPPORTED_CURRENCY', [
        'HotelResult.Currency:unsupported_exponent',
      ]),
      unsupported: currency,
    };
  }
  return { ok: true, currency };
}

// ───────────────────────── Precio ─────────────────────────

type MoneyRead = { readonly ok: true; readonly money: Money } | TboRejection<TboPackRejection>;

function readMoney(value: TboDecimal, field: string, scope: TboPackScope): MoneyRead {
  const minor = toMinorUnits(value, scope.currency);
  if (!minor.ok) return amountRejection(field, minor);
  if (minor.precisionLoss) scope.observer.precisionLoss(field);
  return { ok: true, money: { amountMinor: minor.amountMinor, currency: scope.currency } };
}

type PriceRead = { readonly ok: true; readonly price: HotelPrice } | TboRejection<TboPackRejection>;

/**
 * `TotalFare` es el NETO del pack e incluye `TotalTax` (aritmética de p. 24 y 28, INFERIDO): va a
 * `price.total` tal cual y nunca se recalcula desde `DayRates` ni se le suma nada (02 §9.4).
 */
function readPrice(room: TboSearchRoom, scope: TboPackScope): PriceRead {
  const total = readMoney(room.TotalFare, 'TotalFare', scope);
  if (!total.ok) return total;
  // Un neto de cero no es una tarifa gratis sino un dato roto: el waterfall lo vendería a cero (o
  // sólo con los fijos) y el Book reenviaría ese `TotalFare` a TBO.
  if (total.money.amountMinor === 0) return rejectTbo('AMOUNT_INVALID', ['TotalFare:zero']);

  const optional: Partial<Record<'taxes' | 'minimumSellingPrice' | 'extraGuestCharges', Money>> =
    {};
  const fields = [
    ['taxes', 'TotalTax', room.TotalTax],
    ['minimumSellingPrice', 'RecommendedSellingRate', room.RecommendedSellingRate],
    ['extraGuestCharges', 'ExtraGuestCharges', room.ExtraGuestCharges],
  ] as const;
  for (const [key, field, value] of fields) {
    if (value === undefined) continue;
    const money = readMoney(value, field, scope);
    if (!money.ok) return money;
    optional[key] = money.money;
  }

  const nightly = readNightly(room.DayRates, scope);
  if (!nightly.ok) return nightly;

  return {
    ok: true,
    price: {
      total: total.money,
      // TBO no desglosa impuestos (p. 13): lista vacía, no inventada.
      taxesDetail: [],
      ...optional,
      ...(nightly.nightly === undefined ? {} : { nightly: nightly.nightly }),
    },
  };
}

type NightlyRead =
  | { readonly ok: true; readonly nightly: Money[][] | undefined }
  | TboRejection<TboPackRejection>;

/**
 * `DayRates[j][n].BasePrice`, sólo informativo y redondeado (02 §9.4; Q-21). Una fila vacía o una
 * lista vacía no dicen nada: se omite el desglose en vez de mandar una forma que el contrato
 * neutral rechaza.
 */
function readNightly(dayRates: TboSearchRoom['DayRates'], scope: TboPackScope): NightlyRead {
  if (dayRates === undefined || dayRates === null || dayRates.length === 0) {
    return { ok: true, nightly: undefined };
  }
  if (dayRates.some((row) => row.length === 0)) return { ok: true, nightly: undefined };
  const nightly: Money[][] = [];
  for (const row of dayRates) {
    const nights: Money[] = [];
    for (const day of row) {
      const money = readMoney(day.BasePrice, 'DayRates.BasePrice', scope);
      if (!money.ok) return money;
      nights.push(money.money);
    }
    nightly.push(nights);
  }
  return { ok: true, nightly };
}

// ───────────────────────── Suplementos ─────────────────────────

type FeesRead =
  | {
      readonly ok: true;
      readonly atProperty: HotelFee[] | undefined;
      readonly included: HotelFee[] | undefined;
    }
  | TboRejection<TboPackRejection>;

/** Array de arrays (lo observado, p. 15-17) o plano (lo que dice la tabla): se acepta el que venga. */
function flattenSupplements(value: TboSearchRoom['Supplements']): TboSupplement[] {
  if (value === undefined || value === null) return [];
  const entries: readonly (TboSupplement | TboSupplement[])[] = value;
  return entries.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

function feeDescription(description: string | null | undefined, atProperty: boolean) {
  const raw = typeof description === 'string' ? description.trim() : '';
  if (raw.length === 0) {
    return {
      description: atProperty ? 'Cargo a pagar en el hotel' : 'Suplemento incluido en la tarifa',
    };
  }
  const literal = raw.slice(0, FEE_DESCRIPTION_MAX);
  return {
    description: SUPPLEMENT_DESCRIPTIONS.get(normalizeCode(raw)) ?? literal,
    descriptionRaw: literal,
  };
}

/**
 * `Supplements` → cargos en el hotel y suplementos incluidos (02 §9.7; RF-10).
 *
 * - Cada uno en SU moneda (`AED` en un hotel que cotiza en `USD`, p. 15), nunca convertido ni sumado.
 * - Un `Type` desconocido se trata como `AtProperty`: avisar de un cargo posible es el error menos
 *   dañino.
 * - En una moneda de exponente distinto de 2, `amount` va en las unidades menores ISO y `amountText`
 *   lleva el decimal para mostrar: un `Money` a dos decimales lo mostraría por 10 o por 100.
 * - Un suplemento que no se puede mostrar bien invalida el pack: TBO exige que se vean (p. 14; KP-4,
 *   p. 71), y vender la tarifa callándolo es el reclamo en el mostrador del hotel.
 */
function readFees(room: TboSearchRoom, scope: TboPackScope): FeesRead {
  if (room.Supplements === undefined || room.Supplements === null) {
    return { ok: true, atProperty: undefined, included: undefined };
  }
  const roomCount = scope.rooms.length;
  // Orden estable por habitación: la tarjeta los lista como TBO los numera (`Index`, base 1).
  const supplements = flattenSupplements(room.Supplements)
    .map((supplement, position) => ({ supplement, position }))
    .sort((a, b) => a.supplement.Index - b.supplement.Index || a.position - b.position);

  const atProperty: HotelFee[] = [];
  const included: HotelFee[] = [];
  for (const { supplement, position } of supplements) {
    const at = `Supplements.${position}`;
    if (supplement.Index > roomCount) {
      return rejectTbo('SUPPLEMENT_INVALID', [`${at}.Index:out_of_range`]);
    }
    const exponent = minorUnitExponent(supplement.Currency);
    if (exponent === undefined) {
      return rejectTbo('SUPPLEMENT_INVALID', [`${at}.Currency:no_minor_unit`]);
    }
    const minor = decimalToMinor(supplement.Price, exponent);
    if (!minor.ok) return amountRejection(`${at}.Price`, minor);
    if (minor.precisionLoss) scope.observer.precisionLoss('Supplements.Price');

    const type = normalizeCode(supplement.Type);
    const isIncluded = type === 'included';
    if (!isIncluded && type !== 'atproperty') {
      scope.observer.count(`tbo.${scope.op}.unknown_supplement_type`, { op: scope.op });
    }
    const fee: HotelFee = {
      roomIndex: supplement.Index,
      ...feeDescription(supplement.Description, !isIncluded),
      amount: { amountMinor: minor.amountMinor, currency: supplement.Currency },
      ...(exponent === SUPPORTED_MINOR_UNIT_EXPONENT
        ? {}
        : { amountText: formatMinor(minor.amountMinor, exponent) }),
    };
    (isIncluded ? included : atProperty).push(fee);
  }
  // Con `Supplements` presente, una lista vacía es un dato ("no hay cargos en el hotel"); sin la
  // clave, el campo queda ausente ("TBO no lo informó"), como pide el contrato neutral.
  return { ok: true, atProperty, included };
}

// ───────────────────────── Habitaciones ─────────────────────────

/** `RoomPromotion[j]`: plano en los ejemplos (p. 15), "List of String Array" en la tabla (C-18). */
function promotionsFor(room: TboSearchRoom, j: number): string[] | undefined {
  const entry: unknown = room.RoomPromotion?.[j];
  const texts = (Array.isArray(entry) ? asList(entry) : [entry])
    .filter((text): text is string => typeof text === 'string')
    .map((text) => text.trim().slice(0, PROMOTION_MAX))
    .filter((text) => text.length > 0);
  return texts.length > 0 ? texts : undefined;
}

/** `RoomID[j]` distinto de 0 enlaza con el contenido de HotelDetails; 0 es "sin mapeo" (p. 57). */
function roomTypeIdFor(room: TboSearchRoom, j: number): string | undefined {
  const raw = (room.RoomID ?? room.RoomId)?.[j];
  if (raw === undefined) return undefined;
  const id = String(raw).trim();
  if (id.length === 0 || /^0+$/.test(id) || id.length > ROOM_TYPE_ID_MAX) return undefined;
  return id;
}

function readRooms(room: TboSearchRoom, scope: TboPackScope): HotelRoom[] {
  return room.Name.map((name, j) => {
    const promotions = promotionsFor(room, j);
    const roomTypeId = roomTypeIdFor(room, j);
    const occupancy = scope.rooms[j];
    return {
      name: name.slice(0, ROOM_NAME_MAX),
      reference: j + 1,
      ...(roomTypeId === undefined ? {} : { roomTypeId }),
      // TBO no informa camas aparte del nombre ("Luxury Room, 1 King Bed"): no se deducen.
      bedOptions: [],
      ...(occupancy === undefined
        ? {}
        : { occupancy: { adults: occupancy.adults, childrenAges: [...occupancy.childrenAges] } }),
      ...(promotions === undefined ? {} : { promotions }),
    };
  });
}

/**
 * El literal decimal tal como vino (el esquema ya recortó los espacios): un número pasa por su
 * representación más corta de ida y vuelta.
 */
export function tboDecimalText(value: TboDecimal): string {
  return typeof value === 'string' ? value : String(value);
}

// ───────────────────────── Pack ─────────────────────────

function collectRoomUnknownKeys(rawRoom: unknown, scope: TboPackScope): void {
  const { observer } = scope;
  observer.collectUnknownKeys(rawRoom, scope.knownRoomKeys, ROOM_PREFIX);
  if (!isRecord(rawRoom)) return;
  for (const entry of asList(rawRoom['Supplements'])) {
    for (const supplement of Array.isArray(entry) ? asList(entry) : [entry]) {
      observer.collectUnknownKeys(supplement, TBO_SUPPLEMENT_KEYS, `${ROOM_PREFIX}Supplements[].`);
    }
  }
  for (const policy of asList(rawRoom['CancelPolicies'])) {
    observer.collectUnknownKeys(policy, TBO_CANCEL_POLICY_KEYS, `${ROOM_PREFIX}CancelPolicies[].`);
  }
  for (const row of asList(rawRoom['DayRates'])) {
    for (const day of asList(row)) {
      observer.collectUnknownKeys(day, TBO_DAY_RATE_KEYS, `${ROOM_PREFIX}DayRates[][].`);
    }
  }
}

/**
 * Una habitación cruda de TBO → roompack validado contra `HotelRoompackSchema`, más el contexto
 * que el Book reenvía. Nunca lanza por un dato de TBO: devuelve el motivo del rechazo.
 */
export function mapTboRoompack(rawRoom: unknown, scope: TboPackScope): TboPackOutcome {
  const { observer } = scope;
  collectRoomUnknownKeys(rawRoom, scope);

  const parsed = TboSearchRoomSchema.safeParse(rawRoom);
  if (!parsed.success) return rejectTbo('PACK_SCHEMA', zodIssueRefs(parsed.error, 'Rooms'));
  const room = parsed.data;

  // Un nombre por habitación pedida (p. 13). Si no cuadra, no se sabe a quién cubre cada una y el
  // Book nombraría a los huéspedes en la habitación equivocada (02 §3.3).
  if (room.Name.length !== scope.rooms.length) {
    return rejectTbo('ROOM_COUNT_MISMATCH', ['Rooms.Name:length_differs_from_request']);
  }

  const price = readPrice(room, scope);
  if (!price.ok) return price;
  const fees = readFees(room, scope);
  if (!fees.ok) return fees;

  const cancellation = mapTboCancellation({
    isRefundable: room.IsRefundable,
    policies: room.CancelPolicies,
    currency: scope.currency,
    roomCount: scope.rooms.length,
    source: scope.source,
  });
  if (!cancellation.ok) return rejectTbo('CANCEL_POLICY', cancellation.issues);
  if (cancellation.precisionLoss) observer.precisionLoss('CancelPolicies.CancellationCharge');
  for (let i = 0; i < cancellation.unknownChargeTypes; i += 1) {
    observer.count(`tbo.${scope.op}.unknown_charge_type`, { op: scope.op });
  }

  const meal = mapTboMealType(room.MealType);
  if (!meal.known) {
    observer.unknownMealType();
    observer.count('tbo.unknown_meal_type', {
      op: scope.op,
      kind: meal.raw === undefined ? 'missing' : 'unknown',
    });
  }

  const inclusion = room.Inclusion?.trim().slice(0, INCLUSION_MAX);
  const candidate: HotelRoompack = {
    id: room.BookingCode,
    provider: {
      name: TBO_HOTELS_PROVIDER_CODE,
      offerRef: room.BookingCode,
      // Sólo nuestra clave: `raw` viaja al navegador y nunca lleva PII (offer.ts), y el `HotelCode`
      // que PreBook y Book reenvían se lee del contexto del servidor (08 §9 C-11).
      raw: { searchId: scope.searchId },
    },
    board: meal.board,
    boardLabel: meal.label,
    ...(meal.raw === undefined ? {} : { mealTypeRaw: meal.raw }),
    rooms: readRooms(room, scope),
    cancellation: cancellation.cancellation,
    price: price.price,
    expiresAt: scope.expiresAt,
    ...(fees.atProperty === undefined ? {} : { atPropertyCharges: fees.atProperty }),
    ...(fees.included === undefined ? {} : { includedSupplements: fees.included }),
    ...(typeof room.WithTransfers === 'boolean' ? { includesTransfers: room.WithTransfers } : {}),
    // "Free WiFi" es un único string y el separador de varias inclusiones no se conoce: no se
    // parte (02 §9.9; Q-28).
    ...(inclusion === undefined || inclusion.length === 0 ? {} : { inclusionText: inclusion }),
  };

  const valid = HotelRoompackSchema.safeParse(candidate);
  if (!valid.success) return rejectTbo('CONTRACT', zodIssueRefs(valid.error, 'roompack'));

  return {
    ok: true,
    pack: valid.data,
    context: {
      hotelCode: scope.hotelCode,
      bookingCode: room.BookingCode,
      totalFare: tboDecimalText(room.TotalFare),
      currency: scope.currency,
    },
  };
}
