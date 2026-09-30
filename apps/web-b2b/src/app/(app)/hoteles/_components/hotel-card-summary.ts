import type { Money } from '../actions';
import type { FilteredHotel, ResultRate } from './hotel-results-filters';
import { refundBadge, type RefundBadge } from './rate-refundability';

/*
 * Lo que la tarjeta de un hotel muestra arriba de todo, sin React: la tarifa que pone el precio,
 * el precio por noche y el total, y las etiquetas que el vendedor tiene que ver antes de abrir las
 * habitaciones —régimen, si se recupera algo al cancelar, promoción y cargos en el hotel—.
 */

export interface HotelCardSummary {
  /**
   * La tarifa que pone el precio: la más barata de las que cumplen los filtros y siguen vigentes;
   * si vencieron todas, la más barata, marcada como vencida.
   */
  readonly headline?: ResultRate;
  readonly headlineExpired: boolean;
  /** El total de la estadía de esa tarifa, dividido por las noches. */
  readonly perNight?: Money;
  readonly total?: Money;
  readonly refund?: RefundBadge;
  /**
   * Con el precio de una no reembolsable arriba, la reembolsable más barata del hotel (que cumple
   * los filtros): que el vendedor sepa que existe sin abrir la lista.
   */
  readonly refundableFrom?: ResultRate;
  /** El hotel no tiene NINGUNA tarifa reembolsable en esta búsqueda, filtros aparte. */
  readonly noRefundableAtAll: boolean;
  /** La primera promoción de la tarifa del precio. */
  readonly promotion?: string;
  /** La tarifa del precio tiene cargos que se pagan en el hotel, aparte del total. */
  readonly atHotelCharges: boolean;
}

/**
 * El total dividido por las noches. Es una referencia —lo que se cobra es el total—, así que si el
 * total no tiene centavos tampoco los tiene el por noche: "703.333 COP" y no "703.333,33 COP".
 * Sin noches, nada.
 */
export function perNightOf(total: Money, nights: number | undefined): Money | undefined {
  if (nights === undefined || !Number.isInteger(nights) || nights < 1) return undefined;
  const exact = total.amountMinor / nights;
  const amountMinor =
    total.amountMinor % 100 === 0 ? Math.round(exact / 100) * 100 : Math.round(exact);
  return { amountMinor, currency: total.currency };
}

export function hotelCardSummary(
  item: FilteredHotel,
  nights: number | undefined,
  isExpired: (rate: ResultRate) => boolean = () => false,
): HotelCardSummary {
  const headline = item.rates.find((r) => !isExpired(r)) ?? item.rates[0];
  const noRefundableAtAll = !item.hotel.rates.some((r) => r.refund.refundable);
  if (headline === undefined) {
    return { headlineExpired: false, noRefundableAtAll, atHotelCharges: false };
  }
  const total = headline.row.sale;
  const perNight = perNightOf(total, nights);
  const refundableFrom = headline.refund.refundable
    ? undefined
    : item.rates.find((r) => r.refund.refundable && !isExpired(r));
  const promotion = headline.row.promotions[0];
  return {
    headline,
    headlineExpired: isExpired(headline),
    ...(perNight === undefined ? {} : { perNight }),
    total,
    refund: refundBadge(headline.refund),
    ...(refundableFrom === undefined ? {} : { refundableFrom }),
    noRefundableAtAll,
    ...(promotion === undefined ? {} : { promotion }),
    atHotelCharges: headline.row.atHotel.length > 0,
  };
}

/** "3 noches · 2 habitaciones", lo que acompaña al total. */
export function stayShortLabel(nights: number | undefined, rooms: number | undefined): string {
  const parts: string[] = [];
  if (nights !== undefined && nights >= 1) parts.push(`${nights} noche${nights === 1 ? '' : 's'}`);
  if (rooms !== undefined && rooms > 1) parts.push(`${rooms} habitaciones`);
  return parts.join(' · ');
}
