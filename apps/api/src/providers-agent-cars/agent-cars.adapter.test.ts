import {
  AgentCarsAdapter,
  AgentCarsApiError,
  normalizeAgentCarsBaseUrl,
  type AgentCarsConfig,
} from '@sales-travel/agent-cars';
import { Money } from '@sales-travel/canonical';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Stub de global.fetch que captura cada llamada y responde el JSON dado. */
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

/** Lee un campo de un body FormData capturado por el stub. */
function field(init: RequestInit | undefined, key: string): unknown {
  const body = init?.body;
  if (!(body instanceof FormData)) throw new Error('body no es FormData');
  return body.get(key);
}

const cfg: AgentCarsConfig = {
  accessToken: 'tok-123',
  baseUrl: 'https://api.dev.agentcars.com/v2/sites',
  suggestUrl: 'https://suggest.agentcars.com/suggest',
  sourceCountry: 'CO',
  language: 'es',
};

function url(calls: FetchCall[]): string {
  return calls[0]?.url ?? '';
}

/** Cabecera enviada en la llamada capturada. El token va acá, NO en el query string. */
function header(calls: FetchCall[], key: string): string | undefined {
  const h = calls[0]?.init?.headers as Record<string, string> | undefined;
  return h?.[key];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentCarsAdapter — requests GET', () => {
  it('suggest() siempre envía lang (el endpoint público lo exige; sin lang → HTTP 400)', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.suggest({ query: 'miami' });

    const u = url(calls);
    expect(u).toContain('suggest.agentcars.com');
    expect(u).toContain('query=miami');
    expect(u).toContain('lang=es');
    expect(u).not.toContain('access-token');
  });

  it('getMatrix() arma GET con los query params y el token en la URL, como documenta la guía', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getMatrix({
      pickUpLocation: 'MIA',
      dropOffLocation: 'MIA',
      pickUpDate: '2026-07-01',
      dropOffDate: '2026-07-05',
      pickUpHour: '1000',
      dropOffHour: '1000',
      rateType: 'best',
      country: 'US',
      source: 'CO',
      paymentType: 'ppd',
      lat: 25.79,
      lng: -80.28,
    });

    const u = url(calls);
    expect(calls[0]?.init.method).toBe('GET');
    expect(u).toContain('https://api.dev.agentcars.com/v2/sites/get-matrix?');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(u).toContain('pickUpLocation=MIA');
    expect(u).toContain('dropOffLocation=MIA');
    expect(u).toContain('pickUpDate=2026-07-01');
    expect(u).toContain('dropOffDate=2026-07-05');
    expect(u).toContain('pickUpHour=1000');
    expect(u).toContain('dropOffHour=1000');
    expect(u).toContain('rateType=best');
    expect(u).toContain('country=US');
    expect(u).toContain('source=CO');
    expect(u).toContain('paymentType=ppd');
    expect(u).toContain('lat=25.79');
    expect(u).toContain('lng=-80.28');
  });

  it('getMatrix() omite los params opcionales no provistos', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getMatrix({
      pickUpLocation: 'Airport',
      dropOffLocation: 'Airport',
      pickUpDate: '2026-07-01',
      dropOffDate: '2026-07-05',
      pickUpHour: '1000',
      dropOffHour: '1000',
      rateType: 'best',
      country: 'US',
      source: 'CO',
    });
    const u = url(calls);
    expect(u).not.toContain('paymentType=');
    expect(u).not.toContain('lat=');
    expect(u).not.toContain('companyCode=');
  });

  it('getSelection() incluye companyCode/sippCode/ccrc', async () => {
    const { calls } = stubFetch({ uniqid: 'sess-1' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getSelection({
      pickUpLocation: 'MIA',
      dropOffLocation: 'MIA',
      pickUpDate: '2026-07-01',
      dropOffDate: '2026-07-05',
      pickUpHour: '1000',
      dropOffHour: '1000',
      rateType: 'best',
      country: 'US',
      source: 'CO',
      companyCode: 'ZE',
      sippCode: 'ECMR',
      ccrc: 'token-ccrc',
    });

    const u = url(calls);
    expect(u).toContain('/get-selection?');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(u).toContain('companyCode=ZE');
    expect(u).toContain('sippCode=ECMR');
    expect(u).toContain('ccrc=token-ccrc');
  });

  it('findOffices() arma GET con distance/source y lat/lng', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.findOffices({ distance: 25, source: 'CO', lat: 25.79, lng: -80.28 });

    const u = url(calls);
    expect(u).toContain('/find-offices?');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(u).toContain('distance=25');
    expect(u).toContain('source=CO');
    expect(u).toContain('lat=25.79');
    expect(u).toContain('lng=-80.28');
  });

  it('findOffices() por cityCode no incluye lat/lng', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.findOffices({ distance: 10, source: 'CO', cityCode: 'MIA' });
    const u = url(calls);
    expect(u).toContain('cityCode=MIA');
    expect(u).not.toContain('lat=');
    expect(u).not.toContain('lng=');
  });

  it('getRates() arma GET con country/source/language', async () => {
    const { calls } = stubFetch([]);
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getRates({ country: 'US', source: 'CO', language: 'es' });

    const u = url(calls);
    expect(u).toContain('/rates?');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(u).toContain('country=US');
    expect(u).toContain('source=CO');
    expect(u).toContain('language=es');
  });

  it('getRateDetail() arma GET con uniqid/paymentType/rateType', async () => {
    const { calls } = stubFetch({ base: '10', tax: '0' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getRateDetail({ uniqid: 'sess-1', paymentType: 'ppd', rateType: 'best' });

    const u = url(calls);
    expect(u).toContain('/get-rate-information?');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(u).toContain('uniqid=sess-1');
    expect(u).toContain('paymentType=ppd');
    expect(u).toContain('rateType=best');
  });
});

describe('AgentCarsAdapter — requests POST (multipart/FormData)', () => {
  it('confirm() hace POST con FormData y los montos como string fixed(2)', async () => {
    const { calls } = stubFetch({
      confirmationCode: 'ABC123',
      sippCode: 'ECMR',
      rateCode: 'RT-9',
      status: 'confirmed',
    });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.confirm({
      uniqid: 'sess-1',
      paymentType: 'ppd',
      rateType: 'best',
      companyCode: 'ZE',
      sippCode: 'ECMR',
      pickUpLocation: 'MIA',
      dropOffLocation: 'MIA',
      pickUpDate: '2026-07-01',
      dropOffDate: '2026-07-05',
      pickUpHour: '1000',
      dropOffHour: '1000',
      pickUpAddress: '',
      dropOffAddress: '',
      firstName: 'Ana',
      lastName: 'García',
      age: 1,
      email: 'ana@example.com',
      realBase: Money.fromMajor(118, 'USD'),
      realTax: Money.fromMajor(25.5, 'USD'),
      total: Money.fromMajor(143.5, 'USD'),
    });

    const { url: u, init } = calls[0] ?? { url: '', init: {} };
    expect(init.method).toBe('POST');
    expect(u).toContain('/confirmation');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);

    // age numérico se serializa como string en FormData
    expect(field(init, 'age')).toBe('1');
    // realBase '118.00' (toFixed(2)), realTax '25.50', total '143.50'
    expect(field(init, 'realBase')).toBe('118.00');
    expect(field(init, 'realTax')).toBe('25.50');
    expect(field(init, 'total')).toBe('143.50');
    expect(field(init, 'currency')).toBe('USD');
    expect(field(init, 'firstName')).toBe('Ana');
    expect(field(init, 'lastName')).toBe('García');
    expect(field(init, 'email')).toBe('ana@example.com');
    expect(field(init, 'sippCode')).toBe('ECMR');
    // direcciones vacías → 'NA'
    expect(field(init, 'pickUpAddress')).toBe('NA');
    expect(field(init, 'dropOffAddress')).toBe('NA');
    // sin onHold → no envía el flag
    expect(field(init, 'on_hold')).toBeNull();
  });

  it('confirm() con onHold envía on_hold="1" y mapea extras/frequentFlyer', async () => {
    const { calls } = stubFetch({ confirmationCode: 'X', status: 'on_hold' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.confirm({
      uniqid: 'sess-1',
      paymentType: 'ppd',
      rateType: 'best',
      companyCode: 'ZE',
      sippCode: 'ECMR',
      pickUpLocation: 'MIA',
      dropOffLocation: 'MIA',
      pickUpDate: '2026-07-01',
      dropOffDate: '2026-07-05',
      pickUpHour: '1000',
      dropOffHour: '1000',
      pickUpAddress: '123 Main St',
      dropOffAddress: '456 Ocean Dr',
      firstName: 'Ana',
      lastName: 'García',
      age: 2,
      email: 'ana@example.com',
      realBase: Money.fromMajor(100, 'USD'),
      realTax: Money.fromMajor(0, 'USD'),
      total: Money.fromMajor(100, 'USD'),
      onHold: true,
      extras: { gps: true, childBoosterSeat: true },
      frequentFlyer: { number: 'FF-1', carrier: 'AA' },
      flightNumber: 'AA123',
      membershipNumber: 'MEM-9',
    });

    const init = calls[0]?.init;
    expect(field(init, 'on_hold')).toBe('1');
    expect(field(init, 'age')).toBe('2');
    expect(field(init, 'pickUpAddress')).toBe('123 Main St');
    expect(field(init, 'gps')).toBe('1');
    expect(field(init, 'cbs')).toBe('1');
    expect(field(init, 'fFlyerNbr')).toBe('FF-1');
    expect(field(init, 'fFlyerCarrier')).toBe('AA');
    expect(field(init, 'flight_number')).toBe('AA123');
    expect(field(init, 'fmember')).toBe('MEM-9');
  });

  it('myReservation() hace POST con lastName/confirmationCode', async () => {
    const { calls } = stubFetch({ confirmationCode: 'ABC123', status: 'confirmed' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.myReservation({ lastName: 'García', confirmationCode: 'ABC123', language: 'es' });

    const { url: u, init } = calls[0] ?? { url: '', init: {} };
    expect(init.method).toBe('POST');
    expect(u).toContain('/my-reservation');
    expect(new URL(u).searchParams.get('access-token')).toBe('tok-123');
    expect(header(calls, 'access-token')).toBeUndefined();
    expect(field(init, 'lastName')).toBe('García');
    expect(field(init, 'confirmationCode')).toBe('ABC123');
    expect(field(init, 'language')).toBe('es');
  });

  it('cancel() hace POST con lastName/confirmationCode', async () => {
    const { calls } = stubFetch({ confirmationCode: 'ABC123' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.cancel({ lastName: 'García', confirmationCode: 'ABC123' });

    const { url: u, init } = calls[0] ?? { url: '', init: {} };
    expect(init.method).toBe('POST');
    expect(u).toContain('/cancel');
    expect(field(init, 'lastName')).toBe('García');
    expect(field(init, 'confirmationCode')).toBe('ABC123');
  });

  it('release() hace POST a /release-reservation con referenceCode', async () => {
    const { calls } = stubFetch({ confirmationCode: 'ABC123', status: 'confirmed' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.release({ lastName: 'García', referenceCode: 'REF-9' });

    const { url: u, init } = calls[0] ?? { url: '', init: {} };
    expect(init.method).toBe('POST');
    expect(u).toContain('/release-reservation');
    expect(field(init, 'lastName')).toBe('García');
    expect(field(init, 'referenceCode')).toBe('REF-9');
  });

  it('propaga AgentCarsApiError en respuestas no-2xx', async () => {
    stubFetch({ error: 'invalid token' }, 401);
    const adapter = new AgentCarsAdapter(cfg);
    await expect(adapter.getRates({ country: 'US', source: 'CO' })).rejects.toThrow(
      /AgentCars API 401/,
    );
  });
});

describe('URL base de la cuenta → raíz de la API (…/v2/sites)', () => {
  it.each([
    // La variable `api_url` de la colección Postman oficial: sólo el host.
    ['https://api.agentcars.com', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com/', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com/v2', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com/v2/sites/', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com/v2/sites/get-matrix', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com/V2/Sites', 'https://api.agentcars.com/v2/sites'],
    ['  https://api.dev.agentcars.com/v2/sites  ', 'https://api.dev.agentcars.com/v2/sites'],
    ['api.agentcars.com', 'https://api.agentcars.com/v2/sites'],
    ['https://api.agentcars.com?access-token=x#frag', 'https://api.agentcars.com/v2/sites'],
    // Un proxy propio con otra ruta se respeta.
    ['https://proxy.example.com/agentcars/api', 'https://proxy.example.com/agentcars/api'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeAgentCarsBaseUrl(raw)).toBe(expected);
  });

  it('lo que no es una URL http(s) queda como vino (falla con su propio error)', () => {
    expect(normalizeAgentCarsBaseUrl('')).toBe('');
    expect(normalizeAgentCarsBaseUrl('ftp://api.agentcars.com')).toBe('ftp://api.agentcars.com');
  });

  it('la búsqueda con la cuenta cargada sólo con el host llega a /v2/sites/get-matrix', async () => {
    const { calls } = stubFetch({});
    const adapter = new AgentCarsAdapter({ ...cfg, baseUrl: 'https://api.agentcars.com' });
    await adapter.getMatrix({
      pickUpLocation: 'BOG',
      dropOffLocation: 'BOG',
      pickUpDate: '2026-10-22',
      dropOffDate: '2026-10-29',
      pickUpHour: '1000',
      dropOffHour: '1000',
      rateType: 'best',
      country: 'CO',
    });
    expect(new URL(url(calls)).pathname).toBe('/v2/sites/get-matrix');
  });

  it('el error lleva la URL llamada sin query string, para el log', async () => {
    stubFetch({ error: 'x' }, 404);
    const adapter = new AgentCarsAdapter({ ...cfg, baseUrl: 'https://api.agentcars.com' });
    const err = await adapter.getRates({ country: 'CO', source: 'CO' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof AgentCarsApiError)) throw new Error('esperaba un AgentCarsApiError');
    expect(err.status).toBe(404);
    expect(err.path).toBe('/rates');
    expect(err.endpoint).toBe('https://api.agentcars.com/v2/sites/rates');
  });
});

describe('Guía v2.0 de AgentCars (revisada el 2026-09-30)', () => {
  const search = {
    pickUpLocation: 'BOG',
    dropOffLocation: 'BOG',
    pickUpDate: '2026-10-22',
    dropOffDate: '2026-10-29',
    pickUpHour: '1000',
    dropOffHour: '1000',
    rateType: 'best',
    country: 'CO',
  };

  async function apiError(p: Promise<unknown>): Promise<AgentCarsApiError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof AgentCarsApiError)) throw new Error('esperaba un AgentCarsApiError');
    return err;
  }

  it('getMatrix y getSelection mandan pickUpAddress/dropOffAddress = NA (obligatorios)', async () => {
    const { calls } = stubFetch({});
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.getMatrix(search);
    const params = new URL(url(calls)).searchParams;
    expect(params.get('pickUpAddress')).toBe('NA');
    expect(params.get('dropOffAddress')).toBe('NA');
  });

  it('"sin tarifas" deja la búsqueda vacía: 412 de hoy y 200 con code 13000 desde el 2026-10-13', async () => {
    const adapter = new AgentCarsAdapter(cfg);
    stubFetch(
      {
        error:
          "We don't have rates avaliable for the selected location. Please select another location ciu",
      },
      412,
    );
    await expect(adapter.getMatrix(search)).resolves.toEqual([]);
    stubFetch({
      success: false,
      error: "We don't have rates available for the selected location or Time.",
      message: "We don't have rates available for the selected location or Time.",
      code: 13000,
      data: [],
    });
    await expect(adapter.getMatrix(search)).resolves.toEqual([]);
  });

  it('un error con HTTP 200 no se lee como un auto: validación de hoy y 422 desde el 2026-10-13', async () => {
    const adapter = new AgentCarsAdapter(cfg);
    stubFetch({ error: { pickUpDate: ['the date should be minimal today'] } });
    const old = await apiError(adapter.getMatrix(search));
    expect(old.status).toBe(200);
    expect(old.body).toContain('the date should be minimal today');

    stubFetch(
      {
        success: false,
        error: 'Error Loading data',
        message: 'Error Loading data',
        code: 13001,
        data: { dropOffLocation: ['Dropoff Location cannot be blank.'] },
      },
      422,
    );
    expect((await apiError(adapter.getMatrix(search))).status).toBe(422);
  });

  it('getSelection sin tarifas (code 13000) es un error, no una selección vacía', async () => {
    stubFetch({ success: false, error: 'x', message: 'x', code: 13000, data: [] });
    const adapter = new AgentCarsAdapter(cfg);
    const err = await apiError(
      adapter.getSelection({ ...search, companyCode: 'ZE', sippCode: 'ECAR' }),
    );
    expect(err.path).toBe('/get-selection');
  });

  it('una cancelación rechazada con 200 {"error"} no se da por hecha', async () => {
    stubFetch({ error: 'Reservation already cancelled' });
    const adapter = new AgentCarsAdapter(cfg);
    await apiError(adapter.cancel({ lastName: 'Test', confirmationCode: 'ABC' }));
  });

  it('confirmación: manda el rateIdentifier y no da por hecha una respuesta sin código', async () => {
    const adapter = new AgentCarsAdapter(cfg);
    const req = {
      uniqid: 'u1',
      paymentType: 'ppd' as const,
      rateType: '3',
      companyCode: 'ZE',
      sippCode: 'ECAR',
      pickUpLocation: 'BOG',
      dropOffLocation: 'BOG',
      pickUpDate: '2026-10-22',
      dropOffDate: '2026-10-29',
      pickUpHour: '1000',
      dropOffHour: '1000',
      pickUpAddress: 'NA',
      dropOffAddress: 'NA',
      firstName: 'Ana',
      lastName: 'Test',
      age: 30,
      email: 'ana@example.com',
      realBase: Money.fromMajor(100, 'USD'),
      realTax: Money.fromMajor(10, 'USD'),
      total: Money.fromMajor(110, 'USD'),
      rateIdentifier: '9NWXS',
    };
    const { calls } = stubFetch({ confirmationCode: 'H123', status: 'Active' });
    await adapter.confirm(req);
    expect(field(calls[0]?.init, 'rateIdentifier')).toBe('9NWXS');

    stubFetch({ status: 'Active' });
    const err = await apiError(adapter.confirm(req));
    expect(err.body).toContain('sin código de confirmación');
  });

  it('un host que no existe deja el motivo real (ENOTFOUND y el host), no sólo "fetch failed"', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.dev.agencars.com'), {
      code: 'ENOTFOUND',
      hostname: 'api.dev.agencars.com',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed', { cause }))),
    );
    const adapter = new AgentCarsAdapter({ ...cfg, baseUrl: 'https://api.dev.agencars.com' });
    const err = await apiError(adapter.getMatrix(search));
    expect(err.status).toBe(0);
    expect(err.body).toBe('fetch failed (ENOTFOUND api.dev.agencars.com)');
    expect(err.endpoint).toBe('https://api.dev.agencars.com/v2/sites/get-matrix');
  });
});
