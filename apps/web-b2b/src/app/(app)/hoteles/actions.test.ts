import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', () => ({ api: apiMock }));

import {
  customerForHotelSearchAction,
  hotelSearchCurrenciesAction,
  hotelSearchWalletsAction,
  searchHotelsAction,
  suggestDestinationsAction,
  type HotelSearchResult,
} from './actions';
import { SUGGESTIONS_UNAVAILABLE } from './_components/destination-suggestions';

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

describe('searchHotelsAction — la entrada de hoy, con el reloj del servidor en UTC', () => {
  it('a las 20:30 de Bogotá (ya mañana en UTC) la entrada de esa noche sigue valiendo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T01:30:00Z'));
    try {
      const res = await searchHotelsAction(
        INITIAL,
        form({ checkinDate: '2026-09-30', checkoutDate: '2026-10-02' }),
      );
      expect(res.error).toBeUndefined();
      expect(apiMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('una entrada que ya pasó en todas partes se rechaza', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T13:00:00Z'));
    try {
      const res = await searchHotelsAction(
        INITIAL,
        form({ checkinDate: '2026-09-30', checkoutDate: '2026-10-02' }),
      );
      expect(res.error).toBe('La fecha de entrada no puede ser anterior a hoy.');
      expect(apiMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('searchHotelsAction — destino del autocompletado (docs/tbo/05 §8.5)', () => {
  function destinoEnviado(): unknown {
    const [, init] = apiMock.mock.calls[0] as [string, { body: string }];
    return (JSON.parse(init.body) as { destinationId?: unknown }).destinationId;
  }

  it('el de la plataforma viaja como número, como siempre', async () => {
    await searchHotelsAction(INITIAL, form({ destinationId: '982' }));
    expect(destinoEnviado()).toBe(982);
  });

  it('una ciudad del catálogo local de un proveedor viaja tal cual', async () => {
    await searchHotelsAction(INITIAL, form({ destinationId: 'tbo-hotels:150184' }));
    expect(destinoEnviado()).toBe('tbo-hotels:150184');
  });

  it.each(['TBO:150184', 'tbo-hotels:', 'bogota', 'tbo-hotels:1 2'])(
    '%s no es un destino: no se busca',
    async (destinationId) => {
      const res = await searchHotelsAction(INITIAL, form({ destinationId }));
      expect(res.error).toBe('Elegí un destino del autocompletado o indicá IDs de hotel.');
      expect(apiMock).not.toHaveBeenCalled();
    },
  );
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

  it('no reembolsables: sólo `blocked` las marca no disponibles; ausente o permitido, nada', async () => {
    expect((await searchHotelsAction(INITIAL, form({}))).nonRefundableBlocked).toBeUndefined();
    apiMock.mockResolvedValue({
      ok: true,
      data: { hotels: [], providers: [], nonRefundableRates: 'allowed' },
    });
    expect((await searchHotelsAction(INITIAL, form({}))).nonRefundableBlocked).toBeUndefined();
    apiMock.mockResolvedValue({
      ok: true,
      data: { hotels: [], providers: [], nonRefundableRates: 'blocked' },
    });
    expect((await searchHotelsAction(INITIAL, form({}))).nonRefundableBlocked).toBe(true);
  });

  it('devuelve lo que se buscó: noches, habitaciones, huéspedes y nacionalidad', async () => {
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(res.criteria).toMatchObject({ nights: 3, rooms: 1, guests: 3, guestNationality: 'CO' });
    expect(typeof res.receivedAt).toBe('number');
  });

  it('el destino como lo mostró el autocompletado vuelve para la barra de la búsqueda', async () => {
    const res = await searchHotelsAction(
      INITIAL,
      form({ destinationLabel: '  Bogotá,\n Colombia\u0007 ' }),
    );
    expect(res.criteria?.destinationLabel).toBe('Bogotá, Colombia');
    expect(res.criteria?.hotelIdsCount).toBeUndefined();
    // No viaja al API: es sólo para la pantalla.
    expect(JSON.parse(String(apiMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      'destinationLabel',
    );
  });

  it('sin destino elegido no hay etiqueta; por IDs, cuántos se pidieron', async () => {
    const res = await searchHotelsAction(
      INITIAL,
      form({ destinationId: '', destinationLabel: 'Bogotá', hotelIds: '123, 456' }),
    );
    expect(res.criteria?.destinationLabel).toBeUndefined();
    expect(res.criteria?.hotelIdsCount).toBe(2);
  });

  it('un error del API se muestra con su mensaje', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 400, message: 'Algo falló' } });
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(res).toMatchObject({ ok: false, error: 'Algo falló', showProviderInResults: false });
  });
});

describe('searchHotelsAction — moneda de la búsqueda (D-TBO-15)', () => {
  function cuerpo(): Record<string, unknown> {
    const [, init] = apiMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it('la moneda elegida viaja en el cuerpo y vuelve en lo que se buscó', async () => {
    const res = await searchHotelsAction(INITIAL, form({ currency: 'USD' }));
    expect(cuerpo()).toMatchObject({ currency: 'USD' });
    expect(res.criteria?.currency).toBe('USD');
  });

  it('sin moneda (el selector no cargó) no se manda: el API busca en la de la agencia', async () => {
    const res = await searchHotelsAction(INITIAL, form({}));
    expect(cuerpo()).not.toHaveProperty('currency');
    expect(res.criteria).not.toHaveProperty('currency');
  });

  it('una moneda que no es un código ISO no llega al API', async () => {
    const res = await searchHotelsAction(INITIAL, form({ currency: 'dólares' }));
    expect(res.error).toBe('Elegí la moneda de la búsqueda de la lista.');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('el rechazo del API (moneda no permitida) se muestra con su motivo', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      error: {
        status: 400,
        message:
          'Los hoteles se buscan en COP o USD: la moneda EUR no está disponible para esta agencia.',
      },
    });
    const res = await searchHotelsAction(INITIAL, form({ currency: 'EUR' }));
    expect(res.error).toContain('COP o USD');
  });

  it('las monedas en que cotizó un proveedor fuera por moneda llegan a la pantalla', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: {
        hotels: [],
        providers: [
          {
            code: 'tbo-hotels',
            status: 'skipped',
            count: 0,
            skipReason: 'currency-mismatch',
            droppedForCurrency: 3,
            droppedCurrencies: ['USD'],
          },
        ],
      },
    });
    const res = await searchHotelsAction(INITIAL, form({ currency: 'COP' }));
    expect(res.providers[0]?.droppedCurrencies).toEqual(['USD']);
  });
});

describe('hotelSearchCurrenciesAction — las monedas del selector', () => {
  it('la lista del API, con la de la agencia primero', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: { defaultCurrency: 'COP', currencies: ['COP', 'USD'] },
    });
    expect(await hotelSearchCurrenciesAction()).toEqual({
      defaultCurrency: 'COP',
      currencies: ['COP', 'USD'],
    });
    expect(apiMock.mock.calls[0]?.[0]).toBe('/hotels/currencies');
  });

  it('un fallo o una respuesta sin forma: null, y se busca en la de la agencia', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 503, message: 'x' } });
    expect(await hotelSearchCurrenciesAction()).toBeNull();
    apiMock.mockResolvedValue({ ok: true, data: { currencies: 'USD' } });
    expect(await hotelSearchCurrenciesAction()).toBeNull();
  });
});

describe('hotelSearchWalletsAction — las carteras para el aviso temprano', () => {
  it('sólo las monedas con cartera, las que operan y a quién pedirle', async () => {
    apiMock.mockResolvedValue({
      ok: true,
      data: {
        portfolios: [
          {
            id: '20000000-0000-4000-8000-000000000001',
            tenantId: '10000000-0000-4000-8000-000000000001',
            currency: 'COP',
            exponent: 2,
            creditLimitMinor: 0,
            balanceMinor: 0,
            status: 'active',
          },
        ],
        financier: { tenantId: '10000000-0000-4000-8000-000000000002', name: 'Andino' },
        ownProviderAccounts: ['latam-ndc'],
      },
    });
    expect(await hotelSearchWalletsAction()).toEqual({
      enabled: ['COP'],
      operating: ['COP'],
      suspended: [],
      financierName: 'Andino',
      ownHotelAccounts: false,
    });
    expect(apiMock.mock.calls[0]?.[0]).toBe('/portfolios');
  });

  it('si no se pudieron leer: null, y no se avisa nada', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 503, message: 'x' } });
    expect(await hotelSearchWalletsAction()).toBeNull();
    apiMock.mockResolvedValue({ ok: true, data: { portfolio: {} } });
    expect(await hotelSearchWalletsAction()).toBeNull();
  });
});

describe('suggestDestinationsAction — "no hay ciudades" no es "no se pudo consultar"', () => {
  it('las sugerencias del API, sin error', async () => {
    const items = [{ id: 982, gid: 'g-1', type: 1, display: 'Bogotá, Colombia' }];
    apiMock.mockResolvedValue({ ok: true, data: { items } });
    expect(await suggestDestinationsAction(' bogo ')).toEqual({ items });
    expect(apiMock.mock.calls[0]?.[0]).toBe('/hotels/suggestions?q=bogo');
  });

  it('ninguna ciudad coincide: lista vacía y sin error', async () => {
    apiMock.mockResolvedValue({ ok: true, data: { items: [] } });
    expect(await suggestDestinationsAction('zzzz')).toEqual({ items: [] });
  });

  it('el API falló: el motivo, sin su texto técnico', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      error: { status: 502, message: 'despegar-hotels: upstream 500 {"trace":"abc"}' },
    });
    const res = await suggestDestinationsAction('bogo');
    expect(res).toEqual({ items: [], error: SUGGESTIONS_UNAVAILABLE });
    expect(res.error).not.toContain('despegar');
  });

  it('la sesión venció: se dice así', async () => {
    apiMock.mockResolvedValue({ ok: false, error: { status: 401, message: 'Unauthorized' } });
    expect((await suggestDestinationsAction('bogo')).error).toBe(
      'Tu sesión venció. Volvé a iniciar sesión para buscar destinos.',
    );
  });

  it('una respuesta sin lista tampoco es "no hay ciudades"', async () => {
    apiMock.mockResolvedValue({ ok: true, data: { resultados: [] } });
    expect(await suggestDestinationsAction('bogo')).toEqual({
      items: [],
      error: SUGGESTIONS_UNAVAILABLE,
    });
  });

  it('muy corto no pregunta', async () => {
    expect(await suggestDestinationsAction('b')).toEqual({ items: [] });
    expect(apiMock).not.toHaveBeenCalled();
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
