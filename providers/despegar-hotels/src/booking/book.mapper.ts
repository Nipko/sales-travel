import type { BookResult, BookStatus, BookedProduct } from './types';

interface RawBookProduct {
  type?: string;
  platform_id?: number | string;
  pnr?: string;
}

interface RawBookResponse {
  reservationId?: string;
  reservation_id?: string;
  status?: string;
  sub_status?: string;
  message?: string | string[];
  products?: RawBookProduct[];
}

function mapStatus(s: string | undefined): BookStatus {
  return s === 'SUCCESS' || s === 'PROCESSING' || s === 'ERROR' ? s : 'ERROR';
}

function mapMessage(m: string | string[] | undefined): string | undefined {
  if (Array.isArray(m)) return m.length > 0 ? String(m[0]) : undefined;
  return typeof m === 'string' ? m : undefined;
}

function mapProduct(p: RawBookProduct): BookedProduct {
  const product: BookedProduct = { type: p.type ?? '' };
  if (p.platform_id != null) product.platformId = String(p.platform_id);
  if (p.pnr) product.pnr = p.pnr;
  return product;
}

/**
 * Mapea la respuesta de /book y de /book/{id} (getreservation). Ambas comparten forma
 * (reservationId|reservation_id + status + products). El status ERROR/PROCESSING llega con HTTP 200,
 * por eso el consumidor debe inspeccionar `status`, no asumir éxito por el 2xx.
 */
export function mapBookResult(raw: RawBookResponse): BookResult {
  const result: BookResult = {
    reservationId: raw.reservationId ?? raw.reservation_id ?? '',
    status: mapStatus(raw.status),
    products: (raw.products ?? []).map(mapProduct),
  };
  if (raw.sub_status) result.subStatus = raw.sub_status;
  const message = mapMessage(raw.message);
  if (message) result.message = message;
  return result;
}
