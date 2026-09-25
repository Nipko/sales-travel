import {
  HotelRoomOccupancySchema,
  HotelRoompackSchema,
  type HotelFee,
  type HotelOffer,
  type HotelPrice,
  type HotelRoom,
  type HotelRoomOccupancy,
  type HotelRoompack,
  type Money,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { mapTboCancellation } from '../cancellation/policy.mapper';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import {
  SUPPORTED_MINOR_UNIT_EXPONENT,
  decimalToMinor,
  isSupportedCurrency,
  minorUnitExponent,
  toMinorUnits,
  type MinorUnits,
} from '../internal/decimal';
import { MAX_ISSUE_REFS, zodIssueRefs } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import { mapTboMealType } from './meal-type';
import { tboOfferExpiresAt } from './offer-window';
import {
  TBO_CANCEL_POLICY_KEYS,
  TBO_DAY_RATE_KEYS,
  TBO_SEARCH_HOTEL_KEYS,
  TBO_SEARCH_ROOM_KEYS,
  TBO_SEARCH_ROOT_KEYS,
  TBO_SUPPLEMENT_KEYS,
  TboSearchHotelSchema,
  TboSearchRoomSchema,
  type TboDecimal,
  type TboSearchEnvelope,
  type TboSearchRoom,
  type TboSupplement,
} from './response.schema';

/**
 * Respuesta de Search → ofertas neutrales (docs/tbo/02 §9, §10 y §13; 08 RF-07, RF-09, RF-10 y
 * RF-11).
 *
 * - **Un elemento de `Rooms[]` es UN roompack** que cubre todas las habitaciones pedidas, con un
 *   `BookingCode` y un `TotalFare` (02 §9.3). El token va en el pack (`provider.offerRef`), no en
 *   la habitación: `choiceId` queda vacío.
 * - **Cada pack dice de dónde es** (`provider.name = 'tbo-hotels'`), se muestre o no según la
 *   divulgación del tenant: con eso se enruta el PreBook y la web pinta el proveedor de cada tarifa
 *   de la búsqueda combinada (RF-40; D-TBO-06 A, "me tiene que mostrar de dónde es").
 * - **La moneda sale de `HotelResult[].Currency`, sin valor por defecto** (S-08). Sin moneda, el
 *   hotel se descarta y se mide; con una moneda de exponente distinto de 2, también, y el adapter
 *   deja a TBO no disponible para esa cuenta con motivo (D-TBO-15 A).
 * - **Un pack inválido se descarta y se mide; nunca tumba la respuesta** (02 §10). Tampoco escapa
 *   un `Error` plano: los importes pasan por el decimal exacto del paquete, no por
 *   `Money.fromMajor`.
 * - **Los suplementos nunca se suman ni se convierten** (RF-10). `ExtraGuestCharges` es informativo
 *   y sólo para el vendedor (RF-11 CA-4): va a su campo y a ningún total.
 * - **El literal de `TotalFare` no viaja en el pack público** (RF-07 CA-5): se devuelve aparte, para
 *   el contexto de búsqueda del servidor (RF-08), junto a su `BookingCode`.
 *
 * La salida de cada pack se valida contra `HotelRoompackSchema` de `packages/canonical`: lo que no
 * cumple el contrato neutral no sale de aquí.
 */

// ───────────────────────── Contrato del mapper ─────────────────────────

/** Con qué se leyó la respuesta. Todo lo pone el adapter; nada viene del navegador. */
export interface TboSearchMapContext {
  /** Id NUESTRO de la búsqueda: va a `provider.raw` y es la clave del contexto del servidor. */
  readonly searchId: string;
  /** Epoch en ms del ENVÍO del Search: de ahí sale `expiresAt` (RF-09). */
  readonly searchSentAt: number;
  /** Ocupación pedida, en el orden del request: TBO devuelve los nombres en ese orden (p. 13). */
  readonly rooms: readonly HotelRoomOccupancy[];
}

export interface TboSearchMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

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

export interface TboSearchDiagnostics {
  readonly hotelsReceived: number;
  readonly packsReceived: number;
  readonly packsMapped: number;
  readonly hotelsRejected: Readonly<Partial<Record<TboHotelRejection, number>>>;
  readonly packsRejected: Readonly<Partial<Record<TboPackRejection, number>>>;
  /** Nombres de claves que el esquema no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
  readonly unknownMealTypes: number;
  /** Importes que traían más decimales que su moneda y se redondearon half-up. */
  readonly amountsWithPrecisionLoss: number;
  /**
   * Monedas de `HotelResult` con forma ISO pero exponente distinto de 2, ordenadas. Con ellas el
   * adapter deja a TBO no disponible para la cuenta con motivo (D-TBO-15 A; RF-07 CA-4).
   */
  readonly unsupportedCurrencies: readonly string[];
}

export interface TboSearchMapping {
  readonly offers: HotelOffer[];
  readonly packs: readonly TboSearchPackContext[];
  readonly diagnostics: TboSearchDiagnostics;
}

// ───────────────────────── Piezas ─────────────────────────

const SEARCH_PATH = TBO_OPERATIONS.search.path;
const OP = 'search';

/** Techos de `packages/canonical/src/hotel-offer.ts`: el texto de TBO se recorta, no rompe el pack. */
const ROOM_NAME_MAX = 500;
const PROMOTION_MAX = 500;
const ROOM_TYPE_ID_MAX = 64;
const FEE_DESCRIPTION_MAX = 200;
const INCLUSION_MAX = 2000;

const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;

/**
 * Códigos de `Supplements[].Description` que sabemos traducir. `mandatory_tax` es el único con
 * evidencia (p. 15); no hay catálogo (Q-27), así que el resto se muestra tal cual.
 */
const SUPPLEMENT_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['mandatorytax', 'Impuesto obligatorio'],
]);

type Rejection<R extends string> = {
  readonly ok: false;
  readonly reason: R;
  readonly issues: readonly string[];
};

function reject<R extends string>(reason: R, issues: readonly string[]): Rejection<R> {
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
  return reject<TboPackRejection>(
    result.reason === 'NEGATIVE' ? 'AMOUNT_NEGATIVE' : 'AMOUNT_INVALID',
    [`${field}:${result.reason.toLowerCase()}`],
  );
}

/**
 * Acumula lo observado y lo reporta sin que la observabilidad pueda cambiar el resultado: un
 * logger o unas métricas que lanzan no le quitan a nadie sus tarifas.
 */
class SearchObserver {
  hotelsReceived = 0;
  packsReceived = 0;
  packsMapped = 0;
  unknownMealTypes = 0;
  amountsWithPrecisionLoss = 0;
  readonly hotelsRejected: Partial<Record<TboHotelRejection, number>> = {};
  readonly packsRejected: Partial<Record<TboPackRejection, number>> = {};
  readonly unknownKeys = new Set<string>();
  readonly unsupportedCurrencies = new Set<string>();
  readonly rejectionIssues: string[] = [];

  constructor(private readonly deps: TboSearchMapDeps) {}

  count(name: string, tags: Record<string, string>): void {
    this.safely(() => this.deps.metrics?.counter(name, 1, tags));
  }

  rejectHotel(rejection: Rejection<TboHotelRejection>): void {
    this.hotelsRejected[rejection.reason] = (this.hotelsRejected[rejection.reason] ?? 0) + 1;
    this.count('tbo.search.hotel_rejected', { reason: rejection.reason });
    this.noteIssues(rejection);
  }

  rejectPack(rejection: Rejection<TboPackRejection>): void {
    this.packsRejected[rejection.reason] = (this.packsRejected[rejection.reason] ?? 0) + 1;
    this.count('tbo.search.pack_rejected', { reason: rejection.reason });
    this.noteIssues(rejection);
  }

  precisionLoss(field: string): void {
    this.amountsWithPrecisionLoss += 1;
    this.count('tbo.amount_precision_loss', { op: OP, field });
  }

  /** Nombres de claves de `value` que no están en `known`, con la ruta del nivel. */
  collectUnknownKeys(value: unknown, known: readonly string[], prefix: string): void {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key) || this.unknownKeys.size >= MAX_UNKNOWN_KEYS) continue;
      this.unknownKeys.add(`${prefix}${key}`.slice(0, UNKNOWN_KEY_MAX));
    }
  }

  finish(offers: HotelOffer[], packs: TboSearchPackContext[]): TboSearchMapping {
    const unknownKeys = [...this.unknownKeys];
    for (const key of unknownKeys) this.count('tbo.contract.unknown_key', { op: OP, key });
    if (unknownKeys.length > 0) {
      this.log('warn', 'tbo.search.unknown_keys', { unknownKeys });
    }
    if (this.rejectionIssues.length > 0) {
      this.log('warn', 'tbo.search.rejected', { issues: this.rejectionIssues });
    }
    this.log('debug', 'tbo.search.mapped', {
      hotelsReceived: this.hotelsReceived,
      packsReceived: this.packsReceived,
      packsMapped: this.packsMapped,
    });
    return {
      offers,
      packs,
      diagnostics: {
        hotelsReceived: this.hotelsReceived,
        packsReceived: this.packsReceived,
        packsMapped: this.packsMapped,
        hotelsRejected: { ...this.hotelsRejected },
        packsRejected: { ...this.packsRejected },
        unknownKeys,
        unknownMealTypes: this.unknownMealTypes,
        amountsWithPrecisionLoss: this.amountsWithPrecisionLoss,
        unsupportedCurrencies: [...this.unsupportedCurrencies].sort(),
      },
    };
  }

  private noteIssues(rejection: Rejection<string>): void {
    for (const issue of rejection.issues) {
      if (this.rejectionIssues.length >= MAX_ISSUE_REFS) return;
      this.rejectionIssues.push(`${rejection.reason} ${issue}`);
    }
  }

  private log(level: 'debug' | 'warn', message: string, meta: Record<string, unknown>): void {
    const logger = this.deps.logger;
    if (logger === undefined) return;
    this.safely(() =>
      logger[level](
        message,
        pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, op: OP, ...meta }),
      ),
    );
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }
}

// ───────────────────────── Contexto ─────────────────────────

interface ReadContext {
  readonly searchId: string;
  readonly searchSentAt: number;
  readonly expiresAt: string;
  readonly rooms: readonly HotelRoomOccupancy[];
}

/**
 * El contexto lo arma el adapter, pero sin él no hay forma honesta de leer la respuesta: sin
 * ocupación no se sabe a quién cubre cada habitación y sin instante de envío no hay vencimiento.
 */
function readContext(context: TboSearchMapContext): ReadContext {
  const issues: string[] = [];
  const searchId: unknown = context.searchId;
  if (typeof searchId !== 'string' || searchId.length === 0 || searchId.length > 128) {
    issues.push('context.searchId:invalid');
  }
  const expiresAt = tboOfferExpiresAt(context.searchSentAt);
  if (expiresAt === undefined || context.searchSentAt < 0) {
    issues.push('context.searchSentAt:invalid');
  }
  const rooms = HotelRoomOccupancySchema.array().min(1).max(8).safeParse(context.rooms);
  if (!rooms.success) issues.push(...zodIssueRefs(rooms.error, 'context.rooms'));
  if (issues.length > 0 || expiresAt === undefined || !rooms.success) {
    throw new TboResponseMappingError(SEARCH_PATH, issues);
  }
  return {
    searchId: context.searchId,
    searchSentAt: context.searchSentAt,
    expiresAt,
    rooms: rooms.data,
  };
}

// ───────────────────────── Hotel ─────────────────────────

type CurrencyRead =
  | { readonly ok: true; readonly currency: string }
  | (Rejection<TboHotelRejection> & {
      /** Sólo en `UNSUPPORTED_CURRENCY`: el código, que ya pasó la forma ISO. */
      readonly unsupported?: string;
    });

/** S-08: nunca `'USD'` por defecto. Todo importe del hotel, salvo los suplementos, va en ésta. */
function readCurrency(value: unknown): CurrencyRead {
  if (value === undefined || value === null) {
    return reject('CURRENCY_MISSING', ['HotelResult.Currency:missing']);
  }
  if (typeof value !== 'string')
    return reject('CURRENCY_INVALID', ['HotelResult.Currency:invalid_type']);
  const currency = value.trim();
  if (currency.length === 0) return reject('CURRENCY_MISSING', ['HotelResult.Currency:missing']);
  if (!/^[A-Z]{3}$/.test(currency)) {
    return reject('CURRENCY_INVALID', ['HotelResult.Currency:invalid_string']);
  }
  // Guarda de exponente (02 §8.3 punto 3): `Money` asume dos decimales y un perfil en CLP o KWD
  // saldría escalado por 100 o por 10 sin que nadie lo note.
  if (!isSupportedCurrency(currency)) {
    return {
      ...reject<TboHotelRejection>('UNSUPPORTED_CURRENCY', [
        'HotelResult.Currency:unsupported_exponent',
      ]),
      unsupported: currency,
    };
  }
  return { ok: true, currency };
}

// ───────────────────────── Pack ─────────────────────────

type PackOutcome =
  | { readonly ok: true; readonly pack: HotelRoompack; readonly context: TboSearchPackContext }
  | Rejection<TboPackRejection>;

interface PackScope {
  readonly hotelCode: string;
  readonly currency: string;
  readonly context: ReadContext;
  readonly observer: SearchObserver;
}

type MoneyRead = { readonly ok: true; readonly money: Money } | Rejection<TboPackRejection>;

function readMoney(value: TboDecimal, field: string, scope: PackScope): MoneyRead {
  const minor = toMinorUnits(value, scope.currency);
  if (!minor.ok) return amountRejection(field, minor);
  if (minor.precisionLoss) scope.observer.precisionLoss(field);
  return { ok: true, money: { amountMinor: minor.amountMinor, currency: scope.currency } };
}

type PriceRead = { readonly ok: true; readonly price: HotelPrice } | Rejection<TboPackRejection>;

/**
 * `TotalFare` es el NETO del pack e incluye `TotalTax` (aritmética de p. 24 y 28, INFERIDO): va a
 * `price.total` tal cual y nunca se recalcula desde `DayRates` ni se le suma nada (02 §9.4).
 */
function readPrice(room: TboSearchRoom, scope: PackScope): PriceRead {
  const total = readMoney(room.TotalFare, 'TotalFare', scope);
  if (!total.ok) return total;
  // Un neto de cero no es una tarifa gratis sino un dato roto: el waterfall lo vendería a cero (o
  // sólo con los fijos) y el Book reenviaría ese `TotalFare` a TBO.
  if (total.money.amountMinor === 0) return reject('AMOUNT_INVALID', ['TotalFare:zero']);

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
  | Rejection<TboPackRejection>;

/**
 * `DayRates[j][n].BasePrice`, sólo informativo y redondeado (02 §9.4; Q-21). Una fila vacía o una
 * lista vacía no dicen nada: se omite el desglose en vez de mandar una forma que el contrato
 * neutral rechaza.
 */
function readNightly(dayRates: TboSearchRoom['DayRates'], scope: PackScope): NightlyRead {
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

type FeesRead =
  | {
      readonly ok: true;
      readonly atProperty: HotelFee[] | undefined;
      readonly included: HotelFee[] | undefined;
    }
  | Rejection<TboPackRejection>;

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
function readFees(room: TboSearchRoom, scope: PackScope): FeesRead {
  if (room.Supplements === undefined || room.Supplements === null) {
    return { ok: true, atProperty: undefined, included: undefined };
  }
  const roomCount = scope.context.rooms.length;
  // Orden estable por habitación: la tarjeta los lista como TBO los numera (`Index`, base 1).
  const supplements = flattenSupplements(room.Supplements)
    .map((supplement, position) => ({ supplement, position }))
    .sort((a, b) => a.supplement.Index - b.supplement.Index || a.position - b.position);

  const atProperty: HotelFee[] = [];
  const included: HotelFee[] = [];
  for (const { supplement, position } of supplements) {
    const at = `Supplements.${position}`;
    if (supplement.Index > roomCount)
      return reject('SUPPLEMENT_INVALID', [`${at}.Index:out_of_range`]);
    const exponent = minorUnitExponent(supplement.Currency);
    if (exponent === undefined) {
      return reject('SUPPLEMENT_INVALID', [`${at}.Currency:no_minor_unit`]);
    }
    const minor = decimalToMinor(supplement.Price, exponent);
    if (!minor.ok) return amountRejection(`${at}.Price`, minor);
    if (minor.precisionLoss) scope.observer.precisionLoss('Supplements.Price');

    const type = normalizeCode(supplement.Type);
    const isIncluded = type === 'included';
    if (!isIncluded && type !== 'atproperty') {
      scope.observer.count('tbo.search.unknown_supplement_type', { op: OP });
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

function readRooms(room: TboSearchRoom, context: ReadContext): HotelRoom[] {
  return room.Name.map((name, j) => {
    const promotions = promotionsFor(room, j);
    const roomTypeId = roomTypeIdFor(room, j);
    const occupancy = context.rooms[j];
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

function decimalText(value: TboDecimal): string {
  return typeof value === 'string' ? value : String(value);
}

function mapPack(rawRoom: unknown, scope: PackScope): PackOutcome {
  const { observer, context } = scope;
  const prefix = 'HotelResult[].Rooms[].';
  observer.collectUnknownKeys(rawRoom, TBO_SEARCH_ROOM_KEYS, prefix);
  if (isRecord(rawRoom)) {
    for (const entry of asList(rawRoom['Supplements'])) {
      for (const supplement of Array.isArray(entry) ? asList(entry) : [entry]) {
        observer.collectUnknownKeys(supplement, TBO_SUPPLEMENT_KEYS, `${prefix}Supplements[].`);
      }
    }
    for (const policy of asList(rawRoom['CancelPolicies'])) {
      observer.collectUnknownKeys(policy, TBO_CANCEL_POLICY_KEYS, `${prefix}CancelPolicies[].`);
    }
    for (const row of asList(rawRoom['DayRates'])) {
      for (const day of asList(row)) {
        observer.collectUnknownKeys(day, TBO_DAY_RATE_KEYS, `${prefix}DayRates[][].`);
      }
    }
  }

  const parsed = TboSearchRoomSchema.safeParse(rawRoom);
  if (!parsed.success) return reject('PACK_SCHEMA', zodIssueRefs(parsed.error, 'Rooms'));
  const room = parsed.data;

  // Un nombre por habitación pedida (p. 13). Si no cuadra, no se sabe a quién cubre cada una y el
  // Book nombraría a los huéspedes en la habitación equivocada (02 §3.3).
  if (room.Name.length !== context.rooms.length) {
    return reject('ROOM_COUNT_MISMATCH', ['Rooms.Name:length_differs_from_request']);
  }

  const price = readPrice(room, scope);
  if (!price.ok) return price;
  const fees = readFees(room, scope);
  if (!fees.ok) return fees;

  const cancellation = mapTboCancellation({
    isRefundable: room.IsRefundable,
    policies: room.CancelPolicies,
    currency: scope.currency,
    roomCount: context.rooms.length,
    source: 'search-indicative',
  });
  if (!cancellation.ok) return reject('CANCEL_POLICY', cancellation.issues);
  if (cancellation.precisionLoss) observer.precisionLoss('CancelPolicies.CancellationCharge');
  for (let i = 0; i < cancellation.unknownChargeTypes; i += 1) {
    observer.count('tbo.search.unknown_charge_type', { op: OP });
  }

  const meal = mapTboMealType(room.MealType);
  if (!meal.known) {
    observer.unknownMealTypes += 1;
    observer.count('tbo.unknown_meal_type', {
      op: OP,
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
      raw: { searchId: context.searchId },
    },
    board: meal.board,
    boardLabel: meal.label,
    ...(meal.raw === undefined ? {} : { mealTypeRaw: meal.raw }),
    rooms: readRooms(room, context),
    cancellation: cancellation.cancellation,
    price: price.price,
    expiresAt: context.expiresAt,
    ...(fees.atProperty === undefined ? {} : { atPropertyCharges: fees.atProperty }),
    ...(fees.included === undefined ? {} : { includedSupplements: fees.included }),
    ...(typeof room.WithTransfers === 'boolean' ? { includesTransfers: room.WithTransfers } : {}),
    // "Free WiFi" es un único string y el separador de varias inclusiones no se conoce: no se
    // parte (02 §9.9; Q-28).
    ...(inclusion === undefined || inclusion.length === 0 ? {} : { inclusionText: inclusion }),
  };

  const valid = HotelRoompackSchema.safeParse(candidate);
  if (!valid.success) return reject('CONTRACT', zodIssueRefs(valid.error, 'roompack'));

  return {
    ok: true,
    pack: valid.data,
    context: {
      hotelCode: scope.hotelCode,
      bookingCode: room.BookingCode,
      totalFare: decimalText(room.TotalFare),
      currency: scope.currency,
    },
  };
}

// ───────────────────────── Entrada ─────────────────────────

/**
 * Lee un Search ya aceptado por el cliente HTTP (`TboSearchEnvelopeSchema` como `responseSchema`).
 *
 * - `Status.Code` 201, o sin `HotelResult`: lista vacía, no error (p. 18; 02 §9.10). Un hotel pedido
 *   que no vuelve se trata como sin disponibilidad (Q-20).
 * - Cualquier otro código no se lee como éxito: si llega aquí es un error de cableado del adapter.
 *
 * Lanza `TboResponseMappingError` sólo por eso o por un contexto inválido; lo demás se descarta,
 * se mide y se devuelve en `diagnostics`.
 */
export function mapTboSearchResponse(
  envelope: TboSearchEnvelope,
  context: TboSearchMapContext,
  deps: TboSearchMapDeps = {},
): TboSearchMapping {
  const read = readContext(context);
  const code = envelope.Status?.Code;
  if (code !== undefined && code !== 200 && code !== 201) {
    throw new TboResponseMappingError(SEARCH_PATH, ['Status.Code:not_a_success_code']);
  }

  const observer = new SearchObserver(deps);
  observer.collectUnknownKeys(envelope, TBO_SEARCH_ROOT_KEYS, '');
  observer.collectUnknownKeys(envelope.Status, ['Code', 'Description'], 'Status.');
  if (code === 201) return observer.finish([], []);

  const offers = new Map<string, HotelOffer>();
  const packs: TboSearchPackContext[] = [];
  const bookingCodes = new Set<string>();

  for (const rawHotel of envelope.HotelResult ?? []) {
    observer.hotelsReceived += 1;
    observer.collectUnknownKeys(rawHotel, TBO_SEARCH_HOTEL_KEYS, 'HotelResult[].');
    const hotel = TboSearchHotelSchema.safeParse(rawHotel);
    if (!hotel.success) {
      observer.rejectHotel(reject('HOTEL_SCHEMA', zodIssueRefs(hotel.error, 'HotelResult')));
      continue;
    }
    const rooms = hotel.data.Rooms ?? [];
    observer.packsReceived += rooms.length;
    const currency = readCurrency(hotel.data.Currency);
    if (!currency.ok) {
      if (currency.unsupported !== undefined) {
        observer.unsupportedCurrencies.add(currency.unsupported);
      }
      observer.rejectHotel(currency);
      continue;
    }

    const scope: PackScope = {
      hotelCode: hotel.data.HotelCode,
      currency: currency.currency,
      context: read,
      observer,
    };
    for (const rawRoom of rooms) {
      const outcome = mapPack(rawRoom, scope);
      if (!outcome.ok) {
        observer.rejectPack(outcome);
        continue;
      }
      // El `BookingCode` identifica la unidad reservable (p. 13): dos packs con el mismo token
      // enrutarían el PreBook a uno cualquiera. Gana el primero.
      if (bookingCodes.has(outcome.pack.id)) {
        observer.rejectPack(reject('DUPLICATE_BOOKING_CODE', ['Rooms.BookingCode:duplicated']));
        continue;
      }
      bookingCodes.add(outcome.pack.id);
      observer.packsMapped += 1;
      packs.push(outcome.context);
      const offer = offers.get(scope.hotelCode);
      if (offer === undefined) {
        offers.set(scope.hotelCode, { hotelId: scope.hotelCode, roompacks: [outcome.pack] });
      } else {
        offer.roompacks.push(outcome.pack);
      }
    }
  }

  // Un hotel sin ningún pack válido no se ofrece: para el vendedor es "sin disponibilidad", y el
  // motivo de cada descarte ya quedó medido.
  return observer.finish([...offers.values()], packs);
}
