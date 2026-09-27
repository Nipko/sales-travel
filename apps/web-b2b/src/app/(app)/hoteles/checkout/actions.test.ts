import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api', () => ({ api: apiMock }));

import { hotelOrderStatusAction, prebookRateAction } from './actions';

const REFERENCE = {
  providerCode: 'tbo-hotels',
  searchId: 'b1d4c1c2-6a8e-4c7f-9d0e-3f2a1b0c9d8e',
  offerRef: '1402689!TB!1!TB!3f9c',
};

const PREBOOK = {
  prebookRef: '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b',
  providerCode: 'tbo-hotels',
  hotelId: '1402689',
  expiresAt: '2026-09-26T12:27:00.000Z',
  roompack: {
    id: 'pack-1',
    provider: {
      name: 'tbo-hotels',
      offerRef: REFERENCE.offerRef,
      raw: { searchId: REFERENCE.searchId },
    },
    board: 'RO',
    rooms: [{ name: 'Deluxe King', reference: 1 }],
    cancellation: {
      refundable: false,
      status: 'non_refundable',
      policySource: 'prebook-final',
      rules: [],
    },
    price: { total: { amountMinor: 30575, currency: 'USD' }, taxesDetail: [] },
  },
  rateConditions: [{ category: 'checkIn', text: 'CheckIn Time-Begin: 3:00 PM' }],
  signals: [],
  repricing: {
    outcome: 'INCREASED',
    price: 'UP',
    changes: [],
    previousTotal: { amountMinor: 30000, currency: 'USD' },
    currentTotal: { amountMinor: 30575, currency: 'USD' },
  },
  warnings: [],
};

beforeEach(() => {
  apiMock.mockReset();
});

describe('prebookRateAction — el PreBook de la tarifa elegida (U-09)', () => {
  it('manda el cuerpo neutral con sus tres campos y nada más (RF-08 CA-4)', async () => {
    apiMock.mockResolvedValue({ ok: true, data: PREBOOK });
    await prebookRateAction({ ...REFERENCE, total: 1, rooms: [{ adults: 9 }], choiceId: 'CH-1' });
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/hotels/prebook');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(REFERENCE);
  });

  it('devuelve la tarifa revalidada sin los netos de la comparación', async () => {
    apiMock.mockResolvedValue({ ok: true, data: PREBOOK });
    const res = await prebookRateAction(REFERENCE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prebook.prebookRef).toBe(PREBOOK.prebookRef);
    expect(res.prebook.repricing).toEqual({ outcome: 'INCREASED', price: 'UP', changes: [] });
    expect(JSON.stringify(res)).not.toContain('previousTotal');
    expect(typeof res.receivedAt).toBe('number');
  });

  it('una referencia que no es nuestra no llega al API', async () => {
    const res = await prebookRateAction({
      providerCode: 'tbo-hotels',
      searchId: '../x',
      offerRef: 'a',
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('un 409 del API (venció, ya no está) se muestra y no se ofrece repetir', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      error: {
        status: 409,
        message: 'Esta tarifa ya no está disponible. Elegí otra de la misma búsqueda.',
      },
    });
    expect(await prebookRateAction(REFERENCE)).toEqual({
      ok: false,
      error: 'Esta tarifa ya no está disponible. Elegí otra de la misma búsqueda.',
      retryable: false,
    });
  });

  it('un fallo del proveedor o de conexión se puede reintentar: el PreBook no mueve dinero', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      error: { status: 503, message: 'No pudimos conectar.' },
    });
    expect(await prebookRateAction(REFERENCE)).toMatchObject({ ok: false, retryable: true });
  });

  it('una respuesta incompleta o de otro proveedor no se ofrece reservar', async () => {
    apiMock.mockResolvedValue({ ok: true, data: { ...PREBOOK, prebookRef: undefined } });
    expect(await prebookRateAction(REFERENCE)).toMatchObject({ ok: false, retryable: true });
    apiMock.mockResolvedValue({ ok: true, data: { ...PREBOOK, providerCode: 'despegar-hotels' } });
    expect(await prebookRateAction(REFERENCE)).toMatchObject({ ok: false, retryable: true });
  });
});

describe('hotelOrderStatusAction — la orden de una reserva en curso (U-13, U-14)', () => {
  const ORDER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  it('lee GET /orders/:id y devuelve sólo el estado, sin huéspedes ni contacto', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: {
        order: {
          id: ORDER_ID,
          status: 'confirmed',
          pnr: 'FL1IMA',
          orderNumber: 42,
          totalAmount: 32134,
          currency: 'USD',
          passengers: [{ firstName: 'Juan', lastName: 'Perez' }],
          contactInfo: { email: 'juan@correo.com' },
          providerTracking: { subStatus: null },
        },
      },
    });
    const res = await hotelOrderStatusAction(ORDER_ID);
    expect(apiMock).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
    expect(res).toEqual({
      ok: true,
      order: {
        status: 'confirmed',
        orderNumber: 42,
        providerBookingId: 'FL1IMA',
        total: { amountMinor: 32134, currency: 'USD' },
      },
    });
    expect(JSON.stringify(res)).not.toMatch(/Juan|correo/);
  });

  it('un id que no es UUID no llega al API', async () => {
    expect(await hotelOrderStatusAction('../admin')).toMatchObject({ ok: false, notFound: true });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('una orden que no existe para esta agencia se dice como tal', async () => {
    apiMock.mockResolvedValue({ ok: true, data: { order: null } });
    expect(await hotelOrderStatusAction(ORDER_ID)).toMatchObject({ ok: false, notFound: true });
  });

  it('un fallo al consultar no es "no existe": la espera sigue', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 503, message: 'Sin conexión.' } });
    expect(await hotelOrderStatusAction(ORDER_ID)).toEqual({
      ok: false,
      error: 'Sin conexión.',
      notFound: false,
    });
  });
});
