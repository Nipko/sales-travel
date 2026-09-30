import type { HotelOffer } from '../../actions';
import type { HotelProviderHotelRef } from '../../_components/hotel-key';
import { hotelRateRows, type HotelRateRow } from '../../_components/hotel-rate-view';
import type { HotelStay } from '../../_components/hotel-search-handoff';
import type { RateRefundability } from '../../_components/rate-refundability';
import type { HotelContentResult, HotelDetailRatesResult } from '../actions';
import {
  addressLine,
  hasDescriptiveContent,
  mapsUrl,
  type HotelContent,
} from './hotel-content-view';
import type { HotelFacts } from './hotel-rate-detail-view';

/*
 * El detalle de un hotel sin React: el encabezado, el resumen de la estadía y las tarifas de todos
 * los proveedores que lo venden en una sola lista, cada una con la pastilla de SU proveedor y la
 * misma regla que la tarjeta del listado (RF-40 CA 4).
 */

/** El encabezado de la página. */
export interface DetailHeader {
  readonly name: string;
  readonly stars?: number;
  readonly address?: string;
  readonly location?: { readonly lat: number; readonly lng: number };
}

function contentOf(
  content: HotelContentResult | undefined,
  provider: string,
): HotelContent | undefined {
  return content?.outcomes.find((o) => o.ref.provider === provider)?.content;
}

function offerOf(
  rates: HotelDetailRatesResult | undefined,
  provider: string,
): HotelOffer | undefined {
  return rates?.outcomes.find((o) => o.ref.provider === provider)?.offer;
}

/**
 * Nombre, estrellas, dirección y ubicación del PRIMER hotel de la clave, que es el que puso nombre
 * a la tarjeta del listado: la ficha si la hay y, dato por dato, lo que dijo su búsqueda si no.
 */
export function detailHeader(
  refs: readonly HotelProviderHotelRef[],
  content: HotelContentResult | undefined,
  rates: HotelDetailRatesResult | undefined,
): DetailHeader {
  const primary = refs[0];
  const c = primary === undefined ? undefined : contentOf(content, primary.provider);
  const o = primary === undefined ? undefined : offerOf(rates, primary.provider);
  const name = c?.name || o?.name?.trim() || `Hotel ${primary?.hotelId ?? ''}`.trim();
  const stars = c?.stars ?? o?.stars;
  const address = c?.address ?? o?.address;
  const location = c?.location ?? o?.location;
  return {
    name,
    ...(stars !== undefined && stars !== null && stars > 0 ? { stars } : {}),
    ...(address ? { address } : {}),
    ...(location ? { location } : {}),
  };
}

/**
 * La ficha que se pinta: la del primer hotel de la clave. Si ese proveedor respondió sin nada que
 * contar —Despegar no tiene fichas en el catálogo y en una tarjeta agrupada suele ir primero—, la
 * del siguiente que sí lo tenga: la búsqueda ya los agrupó como el mismo hotel (RF-34), y sin esto
 * las fotos y las instrucciones de llegada de TBO no se verían nunca en un hotel que venden los
 * dos. Si la del primero FALLÓ, `undefined`: la pantalla lo dice y deja reintentar, sin tapar el
 * fallo con la de otro.
 */
export function contentToShow(
  refs: readonly HotelProviderHotelRef[],
  content: HotelContentResult | undefined,
): HotelContent | undefined {
  const [primary, ...others] = refs;
  const own = primary === undefined ? undefined : contentOf(content, primary.provider);
  if (own === undefined || hasDescriptiveContent(own)) return own;
  for (const ref of others) {
    const other = contentOf(content, ref.provider);
    if (other !== undefined && hasDescriptiveContent(other)) return other;
  }
  return own;
}

/**
 * Nombre y dirección con que CADA proveedor conoce al hotel: su ficha y, si no la hay, lo que dijo
 * su búsqueda. Es lo que figura en la reserva de sus tarifas.
 */
export function factsByProvider(
  refs: readonly HotelProviderHotelRef[],
  content: HotelContentResult | undefined,
  rates: HotelDetailRatesResult | undefined,
): Map<string, HotelFacts> {
  const out = new Map<string, HotelFacts>();
  for (const { provider } of refs) {
    const c = contentOf(content, provider);
    const o = offerOf(rates, provider);
    const name = c?.name || o?.name?.trim();
    const address = c?.address || o?.address?.trim();
    out.set(provider, { ...(name ? { name } : {}), ...(address ? { address } : {}) });
  }
  return out;
}

// ───────────────────────── Ubicación ─────────────────────────

export interface HotelLocationView {
  /** La dirección en una línea, con el código postal. */
  readonly address?: string;
  /** El país, por su nombre. */
  readonly country?: string;
  /** "4.60971, -74.08175": para dictarla o pegarla donde no hay enlace. */
  readonly coordinates?: string;
  /** El mapa externo, que se abre aparte: no se embebe (CSP, sin teselas de terceros). */
  readonly mapHref?: string;
}

/**
 * Dónde queda el hotel, con los datos del encabezado (los del primer hotel de la clave): su
 * dirección con el código postal de su ficha, el país y las coordenadas del catálogo. `undefined`
 * si no hay nada que decir.
 */
export function hotelLocationView(
  header: Pick<DetailHeader, 'address' | 'location'>,
  primary: Pick<HotelContent, 'address' | 'zipcode' | 'countryCode'> | undefined,
  countryName: (code: string) => string,
): HotelLocationView | undefined {
  const address = (primary?.address ? addressLine(primary) : null) ?? header.address;
  const code = primary?.countryCode ?? undefined;
  const country = code ? countryName(code) : undefined;
  const location = header.location;
  const view: HotelLocationView = {
    ...(address ? { address } : {}),
    ...(country ? { country } : {}),
    ...(location
      ? {
          coordinates: `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`,
          mapHref: mapsUrl(location),
        }
      : {}),
  };
  return view.address || view.coordinates ? view : undefined;
}

/** "Check-in desde 15:00 · Check-out hasta 12:00", en hora local del hotel; nada sin horarios. */
export function stayHoursLine(
  content: Pick<HotelContent, 'checkInTime' | 'checkOutTime'>,
): string | undefined {
  const parts = [
    content.checkInTime === null ? undefined : `Check-in desde ${content.checkInTime}`,
    content.checkOutTime === null ? undefined : `Check-out hasta ${content.checkOutTime}`,
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

// ───────────────────────── Tarifas ─────────────────────────

/**
 * El aviso del hotel sobre sus tarifas no reembolsables (pedido del 2026-09-29, punto a), además de
 * la etiqueta de cada una: si NINGUNA se puede cancelar sin perder el 100 %, el vendedor lo tiene
 * que saber antes de elegir; y si además quien financia a la agencia las bloqueó, que no hay nada
 * que pueda reservar.
 */
export type RatesRefundNotice = 'non-refundable-all' | 'blocked-all';

export function ratesRefundNotice(
  refunds: readonly Pick<RateRefundability, 'refundable'>[],
  blocked: boolean,
): RatesRefundNotice | undefined {
  if (refunds.length === 0 || refunds.some((r) => r.refundable)) return undefined;
  return blocked ? 'blocked-all' : 'non-refundable-all';
}

/** Un proveedor que no pudo dar tarifas: nombrado por su código, como el aviso del listado. */
export interface FailedProvider {
  readonly code: string;
  readonly reason: string;
}

export interface DetailRatesView {
  readonly rows: readonly HotelRateRow[];
  /** Las tarifas de todos los proveedores juntas, para el contador de vencimiento. */
  readonly offers: readonly Pick<HotelOffer, 'roompacks'>[];
  readonly failed: readonly FailedProvider[];
  /** Proveedores que respondieron, con tarifas o sin ellas. */
  readonly answered: number;
}

/**
 * Las tarifas de todos los proveedores en una lista, de la más barata a la más cara por precio de
 * VENTA, con la misma función que arma las filas de la tarjeta: misma pastilla, misma regla.
 */
export function detailRatesView(
  rates: HotelDetailRatesResult,
  showProvider: boolean,
): DetailRatesView {
  const offers = rates.outcomes.map((o) => o.offer).filter((o): o is HotelOffer => o !== undefined);
  const roompacks = offers.flatMap((o) => o.roompacks);
  return {
    rows: hotelRateRows({ roompacks }, showProvider),
    offers: [{ roompacks }],
    failed: rates.outcomes
      .filter((o) => o.offer === undefined)
      .map((o) => ({ code: o.ref.provider, reason: o.error ?? 'No respondió.' })),
    answered: offers.length,
  };
}

/** Qué decir cuando no hay ninguna tarifa, según quién respondió. */
export function emptyRatesView(view: Pick<DetailRatesView, 'failed' | 'answered'>): {
  title: string;
  hint: string;
} {
  if (view.answered === 0) {
    return {
      title: 'No pudimos traer las tarifas de este hotel.',
      hint: 'Revisa el aviso de arriba y prueba de nuevo en unos minutos. Que no haya tarifas no quiere decir que no haya lugar.',
    };
  }
  if (view.failed.length > 0) {
    return {
      title: 'Los proveedores que respondieron no tienen tarifas para estas fechas.',
      hint: 'Un proveedor no respondió: revisa el aviso de arriba antes de decirle al cliente que no hay lugar.',
    };
  }
  return {
    title: 'Este hotel no tiene disponibilidad para estas fechas.',
    hint: 'Vuelve a los resultados y prueba con otras fechas u otro hotel.',
  };
}

// ───────────────────────── Estadía ─────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDate(iso: string): Date | undefined {
  const m = DATE_RE.exec(iso);
  if (!m) return undefined;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "12 oct 2026", sin pasar por la zona del navegador: es una fecha del calendario del hotel. */
export function formatStayDate(iso: string): string {
  const date = utcDate(iso);
  if (date === undefined) return iso;
  return new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(date)
    .replace(/\./g, '');
}

export function stayNights(stay: Pick<HotelStay, 'checkinDate' | 'checkoutDate'>): number {
  const a = utcDate(stay.checkinDate);
  const b = utcDate(stay.checkoutDate);
  if (a === undefined || b === undefined) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export interface StaySummary {
  readonly dates: string;
  readonly nights: number;
  readonly details: string;
  readonly nationality: string;
  /** La moneda en que se cotiza, si la búsqueda eligió una (D-TBO-15). */
  readonly currency?: string;
}

/**
 * La estadía con la que se piden las tarifas, a la vista (D-TBO-14 A): la nacionalidad cambia el
 * precio en algunos proveedores, y el vendedor tiene que ver con cuál se cotizó.
 */
export function staySummary(stay: HotelStay, countryName: (code: string) => string): StaySummary {
  const nights = stayNights(stay);
  const rooms = stay.rooms.length;
  const adults = stay.rooms.reduce((n, r) => n + r.adults, 0);
  const children = stay.rooms.reduce((n, r) => n + r.childrenAges.length, 0);
  const parts = [
    `${nights} noche${nights === 1 ? '' : 's'}`,
    `${rooms} habitaci${rooms === 1 ? 'ón' : 'ones'}`,
    `${adults} adulto${adults === 1 ? '' : 's'}`,
  ];
  if (children > 0) parts.push(`${children} niño${children === 1 ? '' : 's'}`);
  if (stay.refundableOnly) parts.push('solo reembolsables');
  return {
    dates: `${formatStayDate(stay.checkinDate)} → ${formatStayDate(stay.checkoutDate)}`,
    nights,
    details: parts.join(' · '),
    nationality: countryName(stay.guestNationality),
    ...(stay.currency === undefined ? {} : { currency: stay.currency }),
  };
}
