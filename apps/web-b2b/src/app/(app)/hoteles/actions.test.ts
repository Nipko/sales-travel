import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', () => ({ api: apiMock }));

import {
  customerForHotelSearchAction,
  searchHotelsAction,
  type HotelSearchResult,
} from './actions';

const INITIAL: HotelSearchResult = {
  ok: false,
  hotels: [],
  providers: [],
  showProviderInResults: false,
};

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    checkinDate: isoInDays(30),
    checkoutDate: isoInDays(33),
    rooms: JSON.stringify([{ adults: 2, childrenAges: [5] }]),
    destinationId: '982',
    guestNationality: 'CO',
  };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ok: true, data: { hotels: [], providers: [] } });
});

describe('searchHotelsAction — nacionalidad del pasajero principal (RF-06, U-03)', () => {
  it('sin nacionalidad no se busca: nunca un valor por defecto', async () => {
    const res = await searchHotelsAction(INITIAL, form({ guestNationality: '' }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Indicá la nacionalidad del pasajero principal.');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('un valor que no es un país oficial no se manda', async () => {
    const res = await searchHotelsAction(INITIAL, form({ guestNationality: 'Colombia' }));
    expect(res.error).toBe('No reconocemos esa nacionalidad: elegila de la lista.');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('viaja en alfa-2 en el cuerpo de la búsqueda', async () => {
    await searchHotelsAction(INITIAL, form({ guestNationality: 'COL' }));
    const [, init] = apiMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ guestNationality: 'CO' });
  });
});

describe('searchHotelsAction — el sobre de la respuesta', () => {
  it('RF-40 CA 6: sin el booleano, el proveedor queda oculto', async () => {
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(res.showProviderInResults).toBe(false);
  });

  it('sólo `true` enciende la pastilla: un texto no cuenta', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: { hotels: [], providers: [], showProviderInResults: 'true' },
    });
    expect((await searchHotelsAction(INITIAL, form({}))).showProviderInResults).toBe(false);

    apiMock.mockResolvedValue({
      ok: true,
      data: { hotels: [], providers: [], showProviderInResults: true },
    });
    expect((await searchHotelsAction(INITIAL, form({}))).showProviderInResults).toBe(true);
  });

  it('devuelve lo que se buscó: noches, habitaciones, huéspedes y nacionalidad', async () => {
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(res.criteria).toMatchObject({ nights: 3, rooms: 1, guests: 3, guestNationality: 'CO' });
    expect(typeof res.receivedAt).toBe('number');
  });

  it('un error del API se muestra con su mensaje', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 400, message: 'Algo falló' } });
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(res).toMatchObject({ ok: false, error: 'Algo falló', showProviderInResults: false });
  });
});

describe('customerForHotelSearchAction — prellenado desde el CRM', () => {
  const ID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

  it('devuelve sólo nombre y nacionalidad, nada más de la ficha', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: {
        customer: {
          firstName: 'Ana',
          lastName: 'Pérez',
          nationality: 'COL',
          documentNumber: '123',
          email: 'ana@example.com',
        },
      },
    });
    expect(await customerForHotelSearchAction(ID)).toEqual({
      name: 'Ana Pérez',
      nationality: 'COL',
    });
  });

  it('un id que no es un UUID no llega al API', async () => {
    expect(await customerForHotelSearchAction('../tenants')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('una ficha que no se pudo leer devuelve null', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 404, message: 'Not Found' } });
    expect(await customerForHotelSearchAction(ID)).toBeNull();
  });
});
