import { AgentCarsAdapter, type AgentCarsConfig } from '@sales-travel/agent-cars';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentCarsAdapter — requests GET', () => {
  it('getMatrix() arma GET con todos los query params + access-token', async () => {
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
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('/confirmation?');
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('/my-reservation?');
    expect(u).toContain('access-token=tok-123');
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
    expect(u).toContain('/cancel?');
    expect(field(init, 'lastName')).toBe('García');
    expect(field(init, 'confirmationCode')).toBe('ABC123');
  });

  it('release() hace POST a /release-reservation con referenceCode', async () => {
    const { calls } = stubFetch({ confirmationCode: 'ABC123', status: 'confirmed' });
    const adapter = new AgentCarsAdapter(cfg);
    await adapter.release({ lastName: 'García', referenceCode: 'REF-9' });

    const { url: u, init } = calls[0] ?? { url: '', init: {} };
    expect(init.method).toBe('POST');
    expect(u).toContain('/release-reservation?');
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
