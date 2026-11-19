import { describe, expect, it, vi } from 'vitest';
import { encodeHotelKey } from '../../../(app)/hoteles/_components/hotel-key';
import type { ApiResponse } from '../../../../lib/api';
import {
  INVALID_KEY,
  MISSING_STAY,
  proxyHotelRates,
  type HotelProviderRatesReply,
} from './hotel-rates-proxy';

/*
 * `POST /api/hotels/rates`: las tarifas de UN proveedor del hotel (D-TBO-19 A), validadas aquí
 * porque llegan del navegador. La ficha hace un pedido por proveedor y pinta cada uno al llegar.
 */

const DESPEGAR = { provider: 'despegar-hotels', hotelId: '555' };
const TBO = { provider: 'tbo-hotels', hotelId: '1402689' };
const KEY = encodeHotelKey([DESPEGAR, TBO]) ?? '';
const PERMISOS = '/hotels/booking-permissions';

const STAY = {
  checkinDate: '2026-10-12',
  checkoutDate: '2026-10-15',
  rooms: [{ adults: 2, childrenAges: [5] }],
  guestNationality: 'CO',
  refundableOnly: true,
};

const json = (body: unknown, status = 200): ApiResponse => ({ kind: 'json', status, body });

/** El API: el permiso de la agencia aparte y `POST /hotels/detail` con `detalle`. */
function apiCon(
  detalle: (init: RequestInit) => ApiResponse,
  effective: 'allowed' | 'blocked' = 'allowed',
) {
  return vi.fn((path: string, init: RequestInit) =>
    Promise.resolve(
      path === PERMISOS ? json({ nonRefundableRates: { effective } }) : detalle(init),
    ),
  );
}

const ofertaDe = (init: RequestInit) => {
  const body = JSON.parse(init.body as string) as { hotelId: string };
  return json({ hotelId: body.hotelId, roompacks: [] });
};

function replyOf(body: unknown): HotelProviderRatesReply {
  return body as HotelProviderRatesReply;
}

describe('proxyHotelRates', () => {
  it('una búsqueda de ESE hotel en ESE proveedor, con la estadía en el cuerpo', async () => {
    const call = apiCon(ofertaDe);
    const reply = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      call,
    );
    expect(reply.status).toBe(200);
    const detail = call.mock.calls.filter(([path]) => path !== PERMISOS);
    expect(detail).toHaveLength(1);
    expect(detail[0]![0]).toBe('/hotels/detail');
    expect(detail[0]![1].method).toBe('POST');
    expect(JSON.parse(detail[0]![1].body as string)).toEqual({
      hotelId: '1402689',
      provider: 'tbo-hotels',
      checkinDate: '2026-10-12',
      checkoutDate: '2026-10-15',
      rooms: [{ adults: 2, childrenAges: [5] }],
      guestNationality: 'CO',
      refundableOnly: true,
    });
    const body = replyOf(reply.body);
    expect(body.outcome).toEqual({ ref: TBO, offer: { hotelId: '1402689', roompacks: [] } });
    expect(typeof body.receivedAt).toBe('number');
    expect(body.nonRefundableBlocked).toBeUndefined();
  });

  it('D-TBO-15: con la moneda de la búsqueda, el detalle la pide igual; sin ella, no se manda', async () => {
    const call = apiCon(ofertaDe);
    await proxyHotelRates(
      { hotelKey: KEY, provider: 'despegar-hotels', stay: { ...STAY, currency: 'USD' } },
      call,
    );
    await proxyHotelRates({ hotelKey: KEY, provider: 'despegar-hotels', stay: STAY }, call);
    const bodies = call.mock.calls
      .filter(([path]) => path !== PERMISOS)
      .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ currency: 'USD' });
    expect(bodies[1]).not.toHaveProperty('currency');
  });

  it('un proveedor que no está en la clave, o una clave ajena, no llega al API', async () => {
    const call = apiCon(ofertaDe);
    for (const input of [
      { hotelKey: KEY, provider: 'hotelbeds', stay: STAY },
      { hotelKey: '../../admin', provider: 'tbo-hotels', stay: STAY },
      undefined,
    ]) {
      const reply = await proxyHotelRates(input, call);
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ message: INVALID_KEY });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('sin estadía válida no se busca: moneda o nacionalidad que no son códigos no viajan', async () => {
    const call = apiCon(ofertaDe);
    for (const stay of [
      { ...STAY, currency: 'dolares' },
      { ...STAY, guestNationality: 'Colombia' },
    ]) {
      const reply = await proxyHotelRates({ hotelKey: KEY, provider: 'tbo-hotels', stay }, call);
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ message: MISSING_STAY });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('un error del proveedor vuelve como el desenlace de ese proveedor, con su motivo', async () => {
    const call = apiCon(() => json({ statusCode: 503, message: 'TBO no está disponible.' }, 503));
    const reply = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      call,
    );
    expect(reply.status).toBe(200);
    expect(replyOf(reply.body).outcome).toEqual({ ref: TBO, error: 'TBO no está disponible.' });

    const cut = vi.fn((path: string) =>
      Promise.resolve<ApiResponse>(
        path === PERMISOS
          ? json({})
          : { kind: 'unreachable', status: 503, message: 'No pudimos conectar.' },
      ),
    );
    const res = await proxyHotelRates({ hotelKey: KEY, provider: 'tbo-hotels', stay: STAY }, cut);
    expect(replyOf(res.body).outcome).toEqual({ ref: TBO, error: 'No pudimos conectar.' });
  });

  it('no reembolsables (e): un `blocked` de la agencia viaja; un fallo al leerlo, no', async () => {
    const blocked = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      apiCon(ofertaDe, 'blocked'),
    );
    expect(replyOf(blocked.body).nonRefundableBlocked).toBe(true);

    const failing = vi.fn((path: string, init: RequestInit) =>
      Promise.resolve(path === PERMISOS ? json({ message: 'caído' }, 503) : ofertaDe(init)),
    );
    const res = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      failing,
    );
    expect(replyOf(res.body).nonRefundableBlocked).toBeUndefined();
    expect(replyOf(res.body).outcome.offer).toBeDefined();
  });

  it('el entorno de la cuenta viaja si es uno conocido; otro texto, no', async () => {
    const test = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      apiCon(() => json({ hotelId: '1402689', roompacks: [], accountEnvironment: 'test' })),
    );
    expect(replyOf(test.body).outcome.accountEnvironment).toBe('test');
    const other = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      apiCon(() => json({ hotelId: '1402689', roompacks: [], accountEnvironment: 'sandbox' })),
    );
    expect(replyOf(other.body).outcome).not.toHaveProperty('accountEnvironment');
  });

  it('una respuesta sin tarifas legibles no se pinta como oferta', async () => {
    const reply = await proxyHotelRates(
      { hotelKey: KEY, provider: 'tbo-hotels', stay: STAY },
      apiCon(() => json({ hotels: [] })),
    );
    const { outcome } = replyOf(reply.body);
    expect(outcome.offer).toBeUndefined();
    expect(outcome.error).toBe('La respuesta del proveedor llegó incompleta.');
  });
});
