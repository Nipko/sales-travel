import { DespegarHotelsAdapter, despegarLocale } from '@sales-travel/despegar-hotels';
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
  it('suggest() pide CIUDADES a /suggestions con el perfil de hoteles y deja sólo las ciudades', async () => {
    // Forma documentada de /suggestions: grupos por tipo, cada uno con sus items.
    const { calls } = stubFetch({
      items: [
        {
          group: 'CITY',
          display: 'Ciudades',
          items: [
            {
              id: 'CIT_6585',
              target: {
                id: '6585',
                gid: 'CIT_6585',
                type: 'CITY',
                parents: { city: 'CIT_6585', country: 'COU_CO' },
              },
              display: 'Bogotá, Colombia',
            },
          ],
        },
        {
          group: 'AIRPORT',
          display: 'Aeropuertos',
          items: [
            {
              id: 'AIR_BOG',
              target: { id: '1', gid: 'AIR_BOG', type: 'AIRPORT' },
              display: 'El Dorado',
            },
          ],
        },
      ],
    });
    const adapter = new DespegarHotelsAdapter(cfg);
    const out = await adapter.suggest('bogo');

    const url = new URL(calls[0]!.url);
    expect(url.pathname.endsWith('/suggestions')).toBe(true);
    expect(url.searchParams.get('hint')).toBe('bogo');
    expect(url.searchParams.get('locale')).toBe('es_CO');
    expect(url.searchParams.get('profile')).toBe('sbox-hotels');
    expect((calls[0]?.init.headers as Record<string, string>)['x-apikey']).toBe('secret-key');
    // El id es el de la ciudad (= location.city.id del inventario), numérico.
    expect(out).toEqual([
      {
        id: 6585,
        gid: 'CIT_6585',
        type: 0,
        display: 'Bogotá, Colombia',
        city: 'CIT_6585',
        country: 'COU_CO',
      },
    ]);
  });

  it('suggest() con respuesta plana: descarta hoteles y repetidos, toma el id del gid si falta', async () => {
    stubFetch({
      items: [
        { target: { id: '1', gid: 'HOT_1', type: 'HOTEL' }, display: 'Hotel' },
        { target: { gid: 'CIT_77' }, display: 'Cartagena' },
        { target: { gid: 'CIT_77' }, display: 'Cartagena (repetida)' },
        { target: { gid: 'CIT_x', type: 'CITY' }, display: 'sin id' },
      ],
    });
    const out = await new DespegarHotelsAdapter(cfg).suggest('cart');
    expect(out).toEqual([{ id: 77, gid: 'CIT_77', type: 0, display: 'Cartagena' }]);
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
              rooms: [{ name: 'Std', reference: 1, room_type_id: 'RT-1' }],
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
          rooms: [{ name: 'Std', reference: 1, room_type_id: 'RT-1', choice_id: 'CH-1' }],
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

describe('despegarLocale: Despegar exige `locale` como idioma_PAÍS y sin él responde 400', () => {
  it.each([
    [undefined, {}, 'es_AR'],
    [undefined, { language: 'ES' as const }, 'es_AR'],
    [undefined, { language: 'PT' as const }, 'pt_BR'],
    [undefined, { language: 'ES' as const, countryCode: 'co' }, 'es_CO'],
    ['es', { countryCode: 'co' }, 'es_CO'],
    ['es-CO', {}, 'es_CO'],
    ['ES_ar', {}, 'es_AR'],
    [undefined, { locale: 'pt-br' }, 'pt_BR'],
    ['xx-YYY', {}, 'es_AR'],
  ])('%s con %o → %s', (requested, cfg, expected) => {
    expect(despegarLocale(requested, cfg)).toBe(expected);
  });

  it('una cuenta sin locale ni país igual manda uno válido', async () => {
    const { calls } = stubFetch({ items: [] });
    await new DespegarHotelsAdapter({
      apiKey: 'k',
      baseUrl: 'https://x/v3',
      language: 'ES',
    }).suggest('bogo');
    expect(calls[0]?.url).toContain('locale=es_AR');
  });
});
