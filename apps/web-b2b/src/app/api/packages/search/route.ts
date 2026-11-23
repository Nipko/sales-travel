import { NextResponse } from 'next/server';
import { searchCarsAction, type CarSearchValues } from '../../../(app)/autos/actions';
import { searchFlightsAction, type SearchResult } from '../../../(app)/cotizaciones/actions';
import { searchHotelsAction, type HotelSearchResult } from '../../../(app)/hoteles/actions';

/*
 * `POST /api/packages/search`: una vertical de la búsqueda de paquete.
 *
 * Existe sólo para que las tres búsquedas salgan A LA VEZ: el cliente de Next despacha las acciones
 * del servidor de a una, y vuelos (Sabre puede tardar) habría frenado a hoteles y autos. Acá no hay
 * lógica propia: llama a las mismas acciones de cada sección, con la sesión del vendedor, y cada
 * una valida su entrada, descuenta su cuota y aplica su pricing.
 */

const FLIGHT_FIELDS = [
  'tripType',
  'origin',
  'destination',
  'originKind',
  'destinationKind',
  'departureDate',
  'returnDate',
  'cabin',
  'adults',
  'children',
  'infants',
  'childAges',
] as const;

const HOTEL_FIELDS = [
  'checkinDate',
  'checkoutDate',
  'rooms',
  'destinationId',
  'destinationLabel',
  'guestNationality',
  'currency',
] as const;

const MAX_FIELD = 2000;

function formFrom(raw: unknown, fields: readonly string[]): FormData | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fd = new FormData();
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const text = String(value);
    if (text.length > MAX_FIELD) return undefined;
    fd.set(field, text);
  }
  return fd;
}

const EMPTY_FLIGHTS: SearchResult = {
  ok: false,
  offers: [],
  providers: [],
  showProviderInResults: false,
};
const EMPTY_HOTELS: HotelSearchResult = {
  ok: false,
  hotels: [],
  providers: [],
  showProviderInResults: false,
};

function reply(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request): Promise<Response> {
  let raw: { vertical?: unknown; form?: unknown; values?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return reply({ ok: false, error: 'Pedido inválido.' }, 400);
  }

  if (raw.vertical === 'flights') {
    const fd = formFrom(raw.form, FLIGHT_FIELDS);
    if (!fd) return reply({ ok: false, error: 'Pedido inválido.' }, 400);
    return reply(await searchFlightsAction(EMPTY_FLIGHTS, fd));
  }
  if (raw.vertical === 'hotels') {
    const fd = formFrom(raw.form, HOTEL_FIELDS);
    if (!fd) return reply({ ok: false, error: 'Pedido inválido.' }, 400);
    return reply(await searchHotelsAction(EMPTY_HOTELS, fd));
  }
  if (raw.vertical === 'cars') {
    if (typeof raw.values !== 'object' || raw.values === null) {
      return reply({ ok: false, error: 'Pedido inválido.' }, 400);
    }
    // `searchCarsAction` valida cada campo (fechas, horas, país) antes de llamar al API.
    return reply(await searchCarsAction(raw.values as CarSearchValues));
  }
  return reply({ ok: false, error: 'Pedido inválido.' }, 400);
}
