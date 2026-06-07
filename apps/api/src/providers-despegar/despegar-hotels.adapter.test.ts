import { DespegarHotelsAdapter } from '@sales-travel/despegar-hotels';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Stub de global.fetch que captura la última llamada y responde el JSON dado. */
function stubFetch(json: unknown, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(json)),
      } as Response);
    }),
  );
  return { calls };
}

const cfg = {
  apiKey: 'secret-key',
  baseUrl: 'https://api-dev.despegar.com/v3',
  language: 'ES' as const,
  countryCode: 'CO',
  locale: 'es-CO',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DespegarHotelsAdapter', () => {
  it('suggest() envía hint + locale y mapea las sugerencias', async () => {
    const { calls } = stubFetch({
      items: [
        {
          id: 1,
          target: { gid: 'CITY_1', type: 1, parents: { city: 'Bogotá', country: 'Colombia' } },
          display: 'Bogotá',
        },
      ],
    });
    const adapter = new DespegarHotelsAdapter(cfg);
    const out = await adapter.suggest('bogo');

    expect(calls[0]?.url).toContain('/suggestions/hotels');
    expect(calls[0]?.url).toContain('hint=bogo');
    expect(calls[0]?.url).toContain('locale=es-CO');
    expect((calls[0]?.init.headers as Record<string, string>)['x-apikey']).toBe('secret-key');
    expect(out).toEqual([
      { id: 1, gid: 'CITY_1', type: 1, display: 'Bogotá', city: 'Bogotá', country: 'Colombia' },
    ]);
  });

  it('searchAvailability() construye la query y mapea ofertas', async () => {
    const { calls } = stubFetch({
      items: [
        {
          id: 7,
          hotel_info: { name: 'H', type: 'HOTEL' },
          roompacks: [
            {
              id: 'r1',
              meal_plan: { id: 'ROOM_ONLY' },
              rooms: [{ name: 'Std', reference: 1 }],
              cancellation_policy: { status: 'non_refundable' },
              price_detail: { currency: 'USD', total: 100 },
            },
          ],
        },
      ],
    });
    const adapter = new DespegarHotelsAdapter(cfg);
    const out = await adapter.searchAvailability({
      checkinDate: '2026-07-01',
      checkoutDate: '2026-07-03',
      currency: 'USD',
      hotelIds: ['7', '8'],
      rooms: [{ adults: 2, childrenAges: [] }],
    });

    const url = calls[0]?.url ?? '';
    expect(url).toContain('/hotels-api/availability?');
    expect(url).toContain('hotels=7%2C8'); // "7,8" url-encoded
    expect(url).toContain('distribution=2');
    expect(url).toContain('country_code=CO'); // default desde cfg
    expect(url).toContain('language=ES');
    expect(out[0]?.hotelId).toBe('7');
    expect(out[0]?.roompacks[0]?.price.total).toEqual({ amountMinor: 10000, currency: 'USD' });
  });

  it('getHotelDetail() pega al endpoint del hotel y devuelve el choice_id', async () => {
    const { calls } = stubFetch({
      id: 7,
      hotel_info: { type: 'HOTEL' },
      roompacks: [
        {
          id: 'r1',
          meal_plan: { id: 'BREAKFAST' },
          rooms: [{ name: 'Std', reference: 1, choice_id: 'CH-1' }],
          cancellation_policy: { status: 'fully_refundable' },
          price_detail: { currency: 'USD', total: 120 },
        },
      ],
    });
    const adapter = new DespegarHotelsAdapter(cfg);
    const out = await adapter.getHotelDetail({
      hotelId: '7',
      checkinDate: '2026-07-01',
      checkoutDate: '2026-07-03',
      currency: 'USD',
      rooms: [{ adults: 2, childrenAges: [] }],
    });

    expect(calls[0]?.url).toContain('/hotels-api/availability/7?');
    expect(out.roompacks[0]?.rooms[0]?.choiceId).toBe('CH-1');
    expect(out.roompacks[0]?.board).toBe('BB');
  });

  it('propaga DespegarApiError en respuesta no-2xx', async () => {
    stubFetch({ message: 'bad request' }, 400);
    const adapter = new DespegarHotelsAdapter(cfg);
    await expect(adapter.suggest('x')).rejects.toThrow(/Despegar API 400/);
  });
});
