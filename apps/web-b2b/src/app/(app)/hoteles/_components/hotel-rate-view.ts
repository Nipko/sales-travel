import type { HotelOffer, HotelRoompack, Money } from '../actions';
import { cancellationView, formatFee, rateBoardLabel, type CancellationView } from './hotel-format';
import { rateProviderLabel } from './hotel-provider-view';

/*
 * Qué muestra la tarjeta de un hotel y cada una de sus tarifas, sin React: precio de VENTA,
 * cargos a pagar en el hotel, política según su origen y, con la divulgación encendida, el
 * proveedor de cada tarifa (RF-40).
 */

/**
 * Precio de VENTA de una tarifa: el waterfall de la red con el piso del proveedor, o el neto si
 * el tenant no tiene reglas ni hay piso (el API no manda `pricing` en ese caso). Antes la tarjeta
 * pintaba siempre el neto: una sub-agencia veía el precio de compra del proveedor (G3).
 */
export function saleTotal(pack: Pick<HotelRoompack, 'price' | 'pricing'>): Money {
  return {
    amountMinor: pack.pricing?.finalMinor ?? pack.price.total.amountMinor,
    currency: pack.price.total.currency,
  };
}

/**
 * Costo y margen propio del tenant, sólo cuando hay margen propio: es lo que la fila de vuelos
 * muestra como "neto + markup". El costo es el de ESTE tenant (neto más lo que suma su red por
 * encima), nunca el neto del proveedor, que le diría a una agencia cuánto gana el consolidador.
 */
export function ownMarginOf(
  pack: Pick<HotelRoompack, 'price' | 'pricing'>,
): { cost: Money; margin: Money } | undefined {
  const pricing = pack.pricing;
  if (pricing === undefined || pricing.ownMarkupMinor <= 0) return undefined;
  const currency = pack.price.total.currency;
  return {
    cost: { amountMinor: pricing.costMinor, currency },
    margin: { amountMinor: pricing.ownMarkupMinor, currency },
  };
}

/** Un cargo que se paga en el hotel, ya formateado en SU moneda. */
export interface AtHotelCharge {
  readonly amount: string;
  readonly description: string;
  /** Habitación, base 1; ausente si es de toda la reserva. */
  readonly room?: number;
}

/**
 * Lo que el huésped paga en el hotel, aparte del total (RF-10, U-07): el cargo único de un
 * proveedor que lo informa así y los cargos por habitación, cada uno en su moneda. Nunca se suman
 * entre sí ni al total: pueden venir en otra moneda, y sumarlos es cobrar en la reserva lo que se
 * paga en el hotel.
 */
export function atHotelCharges(
  pack: Pick<HotelRoompack, 'price' | 'atPropertyCharges'>,
): AtHotelCharge[] {
  const charges: AtHotelCharge[] = [];
  if (pack.price.chargeAtDestination) {
    charges.push({
      amount: formatFee({ amount: pack.price.chargeAtDestination }),
      description: 'Cargo en destino',
    });
  }
  for (const fee of pack.atPropertyCharges ?? []) {
    charges.push({
      amount: formatFee(fee),
      description: fee.description,
      ...(fee.roomIndex === undefined ? {} : { room: fee.roomIndex }),
    });
  }
  return charges;
}

/** Una fila de la lista de tarifas de una tarjeta. */
export interface HotelRateRow {
  /** Única dentro de la tarjeta: el id de una tarifa sólo es único dentro de SU proveedor. */
  readonly key: string;
  readonly pack: HotelRoompack;
  /** Nombre legible del proveedor, o nada: con la divulgación apagada no se pinta. */
  readonly providerLabel?: string;
  readonly board: string;
  readonly rooms: string;
  readonly cancellation: CancellationView;
  readonly sale: Money;
  readonly ownMargin?: { cost: Money; margin: Money };
  readonly atHotel: AtHotelCharge[];
  /** Suplementos ya incluidos en el precio, informativos. */
  readonly included: string[];
  readonly promotions: string[];
  readonly inclusion?: string;
  readonly transfers: boolean;
  readonly extraGuest?: Money;
  readonly commission?: { amount: Money; percentage: number };
  readonly expiresAt?: string;
}

function roomsText(pack: HotelRoompack): string {
  return (
    pack.rooms
      .map((r) => r.name.trim())
      .filter(Boolean)
      .join(' + ') || 'Habitación'
  );
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function rowOf(pack: HotelRoompack, showProvider: boolean): HotelRateRow {
  const providerLabel = rateProviderLabel(pack, showProvider);
  const ownMargin = ownMarginOf(pack);
  return {
    key: `${pack.provider?.name ?? ''}:${pack.id}`,
    pack,
    ...(providerLabel === undefined ? {} : { providerLabel }),
    board: rateBoardLabel(pack),
    rooms: roomsText(pack),
    cancellation: cancellationView(pack.cancellation),
    sale: saleTotal(pack),
    ...(ownMargin === undefined ? {} : { ownMargin }),
    atHotel: atHotelCharges(pack),
    included: uniq(
      (pack.includedSupplements ?? []).map((f) => `${f.description} (${formatFee(f)})`),
    ),
    promotions: uniq(pack.rooms.flatMap((r) => r.promotions ?? [])),
    ...(pack.inclusionText?.trim() ? { inclusion: pack.inclusionText.trim() } : {}),
    transfers: pack.includesTransfers === true,
    ...(pack.price.extraGuestCharges ? { extraGuest: pack.price.extraGuestCharges } : {}),
    ...(pack.price.agencyCommission ? { commission: pack.price.agencyCommission } : {}),
    ...(pack.expiresAt ? { expiresAt: pack.expiresAt } : {}),
  };
}

/**
 * Las tarifas de una tarjeta, de la más barata a la más cara por precio de VENTA; ante un empate,
 * en el orden en que llegaron. Una tarjeta puede reunir tarifas de varios proveedores (RF-34):
 * cada fila lleva la pastilla de SU proveedor, nunca la del hotel (RF-40 CA 4 y 5).
 */
export function hotelRateRows(
  offer: Pick<HotelOffer, 'roompacks'>,
  showProvider: boolean,
): HotelRateRow[] {
  return offer.roompacks
    .map((pack, index) => ({ row: rowOf(pack, showProvider), index }))
    .sort((a, b) => a.row.sale.amountMinor - b.row.sale.amountMinor || a.index - b.index)
    .map(({ row }) => row);
}

/** La cabecera de una tarjeta: el "desde" es una fila, con SU pastilla. */
export interface HotelCardView {
  readonly rows: HotelRateRow[];
  readonly from?: HotelRateRow;
  /** El "desde" ya venció: vencieron todas las tarifas del hotel. */
  readonly fromExpired: boolean;
  readonly anyRefundable: boolean;
}

/**
 * El "desde" es la tarifa más barata que todavía se puede reservar: una vencida no es un precio
 * que se le pueda dar al cliente. Si vencieron todas, la más barata, marcada como vencida.
 */
export function hotelCardView(
  offer: Pick<HotelOffer, 'roompacks'>,
  showProvider: boolean,
  isExpired: (row: HotelRateRow) => boolean = () => false,
): HotelCardView {
  const rows = hotelRateRows(offer, showProvider);
  const from = rows.find((r) => !isExpired(r)) ?? rows[0];
  return {
    rows,
    ...(from === undefined ? {} : { from }),
    fromExpired: from !== undefined && isExpired(from),
    anyRefundable: rows.some((r) => r.cancellation.refundable),
  };
}
