import {
  DESPEGAR_REDACTED,
  DespegarApiError,
  DespegarHotelsAdapter,
  buildBookBody,
  mapAmenities,
  mapCatalog,
  mapHotelContent,
  mapMealPlans,
  httpsUrl,
  mapReservations,
  redactDespegarPayload,
  type BookRequest,
} from '@sales-travel/despegar-hotels';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Lo que el ACL de Despegar suma para estar a la par de la API v3: contenido estático y catálogos
 * (regímenes, tipos de cargo, amenities), `/reservations`, el redactor de la bóveda, el cliente HTTP
 * sin el cuerpo en el mensaje de error y el Book por forma de pago.
 */

function stubFetch(status: number, body: unknown, calls: string[] = []): string[] {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      } as Response);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const acl = () =>
  new DespegarHotelsAdapter({ apiKey: 'k', baseUrl: 'https://api-dev.despegar.com/v3' });

describe('contenido y catálogos', () => {
  it('ficha de hoteles: nombre, ubicación, horarios, fotos https y amenities', async () => {
    const calls = stubFetch(200, [
      {
        id: 101,
        name: 'Hotel Andino',
        stars: 4,
        location: {
          address: 'Cra 12 # 93',
          zipcode: 110221,
          city: { id: 2345 },
          latitude: 4.6,
          longitude: -74.05,
        },
        checkin: { from: '15:00', to: '23:00' },
        checkout: { to: '12:00' },
        information: { es: 'Hotel céntrico', en: 'Central hotel' },
        notices: 'Piscina en obras',
        main_picture: { url: 'https://img.example/1.jpg' },
        pictures: [
          { url: 'https://img.example/1.jpg' },
          { url: 'ftp://inseguro/2.jpg' },
          { url: '/relativa.jpg' },
        ],
        amenities: [{ id: 'WIFI' }, { id: 7 }, {}],
        extra_details: { phone_numbers: ['+57 1 555', { number: 6015555 }, {}], email: 'h@x.co' },
      },
      { name: 'sin id' },
    ]);

    const out = await acl().getHotelsContent(['101', '102']);

    expect(calls[0]).toContain('/content-api/hotels?ids=101%2C102&language=ES');
    expect(out).toEqual([
      {
        id: '101',
        name: 'Hotel Andino',
        stars: 4,
        address: 'Cra 12 # 93',
        zipcode: '110221',
        cityId: '2345',
        location: { lat: 4.6, lng: -74.05 },
        checkInFrom: '15:00',
        checkInTo: '23:00',
        checkOutTo: '12:00',
        information: { es: 'Hotel céntrico', en: 'Central hotel' },
        notices: { es: 'Piscina en obras' },
        pictures: ['https://img.example/1.jpg'],
        amenityIds: ['WIFI', '7'],
        phones: ['+57 1 555', '6015555'],
        roomTypes: [],
        email: 'h@x.co',
      },
    ]);
    expect(mapHotelContent({ no: 'es lista' })).toEqual([]);
    expect(mapHotelContent([{ id: 1 }])).toEqual([
      {
        id: '1',
        information: {},
        notices: {},
        pictures: [],
        amenityIds: [],
        phones: [],
        roomTypes: [],
      },
    ]);
  });

  it('habitaciones (room_types) con sus fotos https, también dentro de `{ items }`', () => {
    expect(
      mapHotelContent({
        items: [
          {
            id: 9,
            room_types: [
              {
                id: 'RT-1',
                name: { es: 'Doble Estándar' },
                descriptions: { en: 'Two beds' },
                pictures: [
                  { url: 'https://media.staticontent.com/r.jpg' },
                  { url: '//media.staticontent.com/sin-protocolo.jpg' },
                ],
              },
              { name: 'sin id' },
            ],
          },
        ],
      })[0]?.roomTypes,
    ).toEqual([
      {
        id: 'RT-1',
        name: { es: 'Doble Estándar' },
        description: { en: 'Two beds' },
        pictures: [
          'https://media.staticontent.com/r.jpg',
          'https://media.staticontent.com/sin-protocolo.jpg',
        ],
      },
    ]);
  });

  it('regímenes con subcategorías, tipos de cargo y amenities con su categoría', async () => {
    stubFetch(200, [
      {
        id: 'B',
        description: { es: 'Desayuno', EN: 'Breakfast', pt: '' },
        sub_categories: [{ id: 'BRA', description: { es: 'Desayuno americano' } }, {}],
      },
      { description: 'sin id' },
    ]);
    expect(await acl().getMealPlans()).toEqual([
      {
        id: 'B',
        description: { es: 'Desayuno', en: 'Breakfast' },
        subCategories: [{ id: 'BRA', description: { es: 'Desayuno americano' } }],
      },
    ]);

    stubFetch(200, [{ id: 'TT', description: { es: 'Tasa turística' } }]);
    expect(await acl().getFeeTypes()).toEqual([
      { id: 'TT', description: { es: 'Tasa turística' } },
    ]);

    stubFetch(200, [
      { id: 1, description: 'Wifi', amenity_category: { id: 'NET' } },
      { id: 2, description: { pt: 'Piscina' } },
      {},
    ]);
    expect(await acl().getAmenities()).toEqual([
      { id: '1', description: { es: 'Wifi' }, categoryId: 'NET' },
      { id: '2', description: { pt: 'Piscina' } },
    ]);
    expect(mapCatalog(null)).toEqual([]);
    expect(mapMealPlans(undefined)).toEqual([]);
    expect(mapAmenities('x')).toEqual([]);
  });
});

describe('/reservations', () => {
  it('sin producto o con estado desconocido no se inventa nada', () => {
    expect(
      mapReservations({
        items: [
          { id: 'sin-producto' },
          {
            product: {
              product_id: 9,
              status: 'RARO',
              sale_price: { price: 10 },
              rooms: [
                {
                  code: 'DBL',
                  meal_plan_code: 'B',
                  meal_plan_description: 'Desayuno',
                  description: 'Doble',
                  bed_type_description: 'Queen',
                  holder_first_name: 'Ana',
                  holder_last_name: 'Gómez',
                  adults: 2,
                  minor_ages: [5],
                },
                {},
              ],
            },
            download_voucher_url: 'https://voucher.example/1',
          },
        ],
      }),
    ).toEqual([
      {
        id: '9',
        productId: '9',
        productType: '',
        status: 'UNKNOWN',
        rawStatus: 'RARO',
        downloadVoucherUrl: 'https://voucher.example/1',
        rooms: [
          {
            code: 'DBL',
            mealPlanCode: 'B',
            mealPlanDescription: 'Desayuno',
            description: 'Doble',
            bedTypeDescription: 'Queen',
            holderFirstName: 'Ana',
            holderLastName: 'Gómez',
            adults: 2,
            minorAges: [5],
          },
          { minorAges: [] },
        ],
      },
    ]);
    expect(mapReservations({})).toEqual([]);
  });

  it('el pedido por fecha va con `by_api_key`; uno por reserva, no', async () => {
    const calls = stubFetch(200, { items: [] });
    await acl().findReservations({ fromPurchaseDate: '2026-11-01', limit: 10, page: 2 });
    await acl().findReservations({ productId: 'P-1', externalTransactionId: 'X', flowId: 'CAN-1' });
    expect(calls[0]).toContain('by_api_key=true');
    expect(calls[0]).toContain('page=2');
    expect(calls[1]).not.toContain('by_api_key');
    expect(calls[1]).toContain('product_id=P-1');
    expect(calls[1]).toContain('flow_id=CAN-1');
  });

  it('product_type sólo viaja con su product_id: suelto, Despegar responde 400', async () => {
    const calls = stubFetch(200, { items: [] });
    await acl().findReservations({
      fromPurchaseDate: '2026-11-17',
      toPurchaseDate: '2026-11-19',
      productType: 'HOTEL',
    });
    await acl().findHotelReservation('R-9');
    await acl().findReservations({ productId: 'P-1', productType: 'HOTEL' });
    expect(calls[0]).not.toContain('product_type');
    expect(calls[1]).toContain('reservation_id=R-9');
    expect(calls[1]).not.toContain('product_type');
    expect(calls[2]).toContain('product_type=HOTEL');
  });

  it('el producto de hotel de una reserva; si sólo hay otro tipo, el primero', async () => {
    stubFetch(200, {
      items: [
        { product: { product_id: 'F-1', product_type: 'FLIGHT' } },
        { product: { product_id: 'H-1', product_type: 'HOTEL' } },
      ],
    });
    expect((await acl().findHotelReservation('R'))?.productId).toBe('H-1');
    stubFetch(200, { items: [{ product: { product_id: 'F-1', product_type: 'FLIGHT' } }] });
    expect((await acl().findHotelReservation('R'))?.productId).toBe('F-1');
  });

  it('pedidos especiales: catálogo por producto y pedido con su código', async () => {
    const calls = stubFetch(200, {
      items: [
        { code: 'CRADLE', description: 'Cuna', requires_value: false },
        { code: 'LATE_CHECK_IN', requires_value: true },
        { description: 'sin código' },
      ],
    });
    expect(await acl().getSpecialRequestsCatalog('P-1')).toEqual([
      { code: 'CRADLE', description: 'Cuna', requiresValue: false },
      { code: 'LATE_CHECK_IN', description: 'LATE_CHECK_IN', requiresValue: true },
    ]);
    expect(calls[0]).toContain('product_type=HOTEL');

    stubFetch(200, { flow_id: 'SR-1', product_id: 55 });
    expect(await acl().createSpecialRequest({ productId: 'P-1', code: 'CRADLE' })).toEqual({
      flowId: 'SR-1',
      productId: '55',
    });
    stubFetch(200, {});
    expect(await acl().createSpecialRequest({ productId: 'P-1', code: 'CRADLE' })).toEqual({});
  });
});

describe('bóveda y errores', () => {
  it('el redactor enmascara personas, documentos y pago, a cualquier profundidad', () => {
    const out = redactDespegarPayload({
      prebook_id: 'PB',
      contact_data: { email: 'a@b.co', phones: [{ number: '1' }] },
      travelers: [{ first_name: 'Ana', last_name: 'Gómez', identification: { number: '1' } }],
      payment: {
        payment_units: [{ secure_token: 'tok', card_holder_identification: { number: '1' } }],
        invoices: [{ fiscal_identification: { number: '9' }, fiscal_address: { street: 'x' } }],
      },
      items: [
        { product: { purchase_customer: { email: 'x' }, rooms: [{ holder_first_name: 'Ana' }] } },
      ],
      total: 120,
      ok: true,
      nada: null,
    }) as Record<string, unknown>;
    const texto = JSON.stringify(out);
    for (const dato of ['a@b.co', 'Ana', 'Gómez', '"tok"', '"9"', 'street']) {
      expect(texto).not.toContain(dato);
    }
    expect(out['prebook_id']).toBe('PB');
    expect(out['total']).toBe(120);
    expect(texto).toContain(DESPEGAR_REDACTED);

    let profundo: Record<string, unknown> = { first_name: 'x' };
    for (let i = 0; i < 40; i++) profundo = { n: profundo };
    expect(JSON.stringify(redactDespegarPayload(profundo))).toContain(DESPEGAR_REDACTED);
  });

  it('el mensaje de un error nombra el `code` de Despegar y nunca el cuerpo', () => {
    const err = new DespegarApiError(
      400,
      '{"code":"INVALID_FIELD","message":"Ana Gómez"}',
      '/book',
    );
    expect(err.message).toBe('Despegar API 400 on /book (INVALID_FIELD)');
    expect(err.providerCode).toBe('INVALID_FIELD');
    expect(new DespegarApiError(500, '<html>', '/book').message).toBe('Despegar API 500 on /book');
    expect(new DespegarApiError(400, '{"error_code":"E1"}', '/x').providerCode).toBe('E1');
    expect(
      new DespegarApiError(400, '{"code":"con espacios no"}', '/x').providerCode,
    ).toBeUndefined();
    expect(new DespegarApiError(400, '[]', '/x').providerCode).toBeUndefined();
  });

  it('una respuesta 2xx que no es JSON es un error sin eco del cuerpo', async () => {
    stubFetch(200, '<html>Ana Gómez</html>');
    const err = await acl()
      .getReservation('R')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DespegarApiError);
    expect((err as DespegarApiError).body).toBe('respuesta no-JSON');
  });

  it('timeout y red caída son status 0 y se reportan a la bóveda como TRANSPORT', async () => {
    const outcomes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
    );
    const a = new DespegarHotelsAdapter(
      { apiKey: 'k', baseUrl: 'https://x/v3' },
      {
        onExchange: (e) => {
          outcomes.push(e.outcome);
          throw new Error('la bóveda falla');
        },
      },
    );
    await expect(a.getReservation('R')).rejects.toMatchObject({ status: 0, body: 'timeout' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNRESET'))),
    );
    await expect(a.getReservation('R')).rejects.toMatchObject({ status: 0, body: 'ECONNRESET' });
    expect(outcomes).toEqual(['TRANSPORT', 'TRANSPORT']);
  });

  it('un fetch inyectado y un 4xx/5xx se clasifican', async () => {
    const outcomes: string[] = [];
    const fetchFalso = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"code":"NF"}'),
      } as Response),
    );
    const a = new DespegarHotelsAdapter(
      { apiKey: 'k', baseUrl: 'https://x/v3' },
      {
        fetch: fetchFalso as unknown as typeof fetch,
        timeoutMs: 1000,
        onExchange: (e) => outcomes.push(`${e.outcome}:${e.providerCode}`),
      },
    );
    await expect(a.getReservation('R')).rejects.toBeInstanceOf(DespegarApiError);
    expect(outcomes).toEqual(['REJECTED:NF']);
  });

  it('cada operación cabe en el alfabeto de la bóveda: con un punto, el RQ/RS se descartaba sin aviso', async () => {
    stubFetch(500, { code: 'X' });
    const operations: string[] = [];
    const a = new DespegarHotelsAdapter(
      { apiKey: 'k', baseUrl: 'https://x/v3' },
      { onExchange: (e) => operations.push(e.operation) },
    );
    await Promise.allSettled([
      a.suggest('bog'),
      a.getReservation('R'),
      a.getMealPlans(),
      a.getFeeTypes(),
      a.getAmenities(),
    ]);
    expect(operations.length).toBe(5);
    for (const op of operations) expect(op).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('Book por forma de pago', () => {
  const base: BookRequest = {
    prebookId: 'pb',
    externalBookingReference: 'SDT1',
    contact: { email: 'a@b.co' },
    travelers: [{ referenceId: '0', firstName: 'Ana', lastName: 'Gómez' }],
    payment: { optionType: 'CURRENT_ACCOUNT', units: [] },
  };
  const factura = {
    fiscalStatus: 'PERSONA_FISICA',
    fiscalIdentification: { type: 'CPF', number: '1' },
    fiscalAddress: { neighborhood: 'Centro', cityId: '9' },
  };

  it('cuenta corriente: la unidad sólo con su tipo, y el barrio como lo escribe Despegar', () => {
    const body = buildBookBody({ ...base, payment: { ...base.payment, invoices: [factura] } });
    expect(body['payment']).toEqual({
      option_type: 'CURRENT_ACCOUNT',
      payment_units: [{ type: 'CURRENT_ACCOUNT' }],
      invoices: [
        {
          fiscal_status: 'PERSONA_FISICA',
          fiscal_identification: { type: 'CPF', number: '1' },
          fiscal_address: { neighbourhood: 'Centro', city_id: '9' },
        },
      ],
    });
  });

  it('diferido: el plan y nunca facturas', () => {
    const body = buildBookBody({
      ...base,
      payment: { optionType: 'DEFERRED', units: [{ planId: 'PL' }], invoices: [factura] },
    });
    expect(body['payment']).toEqual({
      option_type: 'DEFERRED',
      payment_units: [{ type: 'DEFERRED', plan_id: 'PL' }],
    });
  });

  it('una factura sin dirección no manda dirección', () => {
    const body = buildBookBody({
      ...base,
      payment: {
        ...base.payment,
        invoices: [{ fiscalStatus: 'X', fiscalIdentification: { type: 'CC', number: '1' } }],
      },
    });
    expect(JSON.stringify(body)).not.toContain('fiscal_address');
  });
});

describe('httpsUrl: las fotos de Despegar llegan sin protocolo o en http', () => {
  it.each([
    [
      '//media.staticontent.com/media/pictures/abc',
      'https://media.staticontent.com/media/pictures/abc',
    ],
    ['http://media.staticontent.com/a.jpg', 'https://media.staticontent.com/a.jpg'],
    [' https://media.staticontent.com/a.jpg ', 'https://media.staticontent.com/a.jpg'],
    ['/relativa.jpg', undefined],
    ['ftp://x/y.jpg', undefined],
    ['https://', undefined],
    [42, undefined],
  ])('%s → %s', (raw, expected) => {
    expect(httpsUrl(raw)).toBe(expected);
  });
});
