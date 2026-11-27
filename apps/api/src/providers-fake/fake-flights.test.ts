import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlightSearchCriteria, OrderCreateRequest } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { FakeFlightsAdapter, FakeFlightsFactory, fakeProvidersEnabled } from './fake-flights.js';

const CTX = { tenantId: '11111111-1111-4111-8111-111111111111' };
const criteria = (destination: string, extra: Partial<FlightSearchCriteria> = {}) => ({
  origin: 'BOG',
  destination,
  departureDate: '2027-03-10',
  paxCount: { adults: 2, children: 0, infants: 0 },
  currency: 'COP',
  ...extra,
});

const reserva = (surname: string) =>
  ({ passengers: [{ surname }] }) as unknown as OrderCreateRequest;

describe('fakeProvidersEnabled (INF-4)', () => {
  it('apagado sin la variable; encendido sólo en el stack E2E', () => {
    expect(fakeProvidersEnabled({})).toBe(false);
    expect(fakeProvidersEnabled({ FAKE_PROVIDERS: '1', APP_VERSION: 'e2e' })).toBe(true);
  });

  it('pedido en otro ambiente, el arranque falla en vez de encenderlo', () => {
    expect(() => fakeProvidersEnabled({ FAKE_PROVIDERS: '1', APP_VERSION: 'abc1234' })).toThrow(
      /sólo vale en el stack E2E/,
    );
    expect(() => fakeProvidersEnabled({ FAKE_PROVIDERS: '1' })).toThrow();
  });

  it('ningún compose de un ambiente real lo enciende', () => {
    for (const f of [
      ['infrastructure', 'hostinger', 'docker-compose.prod.yml'],
      ['infrastructure', 'hostinger', 'docker-compose.cert.yml'],
      ['infrastructure', 'pruebas', 'docker-compose.yml'],
    ]) {
      const text = readFileSync(join(__dirname, '..', '..', '..', '..', ...f), 'utf8');
      expect(text, f.join('/')).not.toMatch(/FAKE_PROVIDERS/);
    }
  });
});

describe('FakeFlightsAdapter — perillas', () => {
  const a = new FakeFlightsAdapter();

  it('dos ofertas de prueba, por pasajero, ida y vuelta con su vuelta', async () => {
    const offers = await a.search(criteria('MDE', { returnDate: '2027-03-15' }), CTX);
    expect(offers).toHaveLength(2);
    for (const o of offers) {
      expect(o.provider).toMatchObject({ name: 'fake-flights', environment: 'test' });
      expect(o.itineraries).toHaveLength(2);
      expect(o.total.currency).toBe('COP');
      expect(o.total.amountMinor).toBe(o.baseFare.amountMinor + o.taxes.amountMinor);
    }
  });

  it('SMR sin disponibilidad; ADZ con el proveedor caído', async () => {
    expect(await a.search(criteria('SMR'), CTX)).toEqual([]);
    await expect(a.search(criteria('ADZ'), CTX)).rejects.toThrow(/no responde/);
  });

  it('la segunda oferta sube 5 % al revalidar; la primera no', async () => {
    const [fija, cambia] = await a.search(criteria('MDE'), CTX);
    expect((await a.priceOffer(fija!, criteria('MDE'), CTX)).priceChanged).toBe(false);
    const p = await a.priceOffer(cambia!, criteria('MDE'), CTX);
    expect(p.priceChanged).toBe(true);
    expect(p.offer.total.amountMinor).toBe(Math.round(cambia!.total.amountMinor * 1.05));
    // Una sola vez: la revalidación de la reserva ya no la vuelve a subir.
    expect((await a.priceOffer(p.offer, criteria('MDE'), CTX)).priceChanged).toBe(false);
  });

  it('reserva según el apellido: confirmada, rechazada, parcial o incierta', async () => {
    const ok = await a.createOrder(reserva('Prueba'), CTX);
    expect(ok).toMatchObject({ outcome: 'CONFIRMED' });
    expect(await a.retrieveForDisplay(ok.orderId!, CTX)).toMatchObject({ found: true });
    expect(await a.createOrder(reserva('Rechazo'), CTX)).toMatchObject({
      outcome: 'FAILED',
      items: [],
    });
    expect(await a.createOrder(reserva('PARCIAL'), CTX)).toMatchObject({ outcome: 'PARTIAL' });
    await expect(a.createOrder(reserva('Incierto'), CTX)).rejects.toThrow(/no contestó/);
  });

  it('la cancelación la ve la relectura', async () => {
    const ok = await a.createOrder(reserva('Prueba'), CTX);
    expect(await a.cancelOrder(ok.orderId!, CTX)).toMatchObject({ success: true });
    expect(await a.retrieveForDisplay(ok.orderId!, CTX)).toMatchObject({ status: 'CANCELLED' });
  });

  it('el factory entrega siempre el mismo adapter, como cuenta de pruebas', async () => {
    const f = new FakeFlightsFactory();
    const r1 = await f.resolveForTenant(CTX.tenantId);
    const r2 = await f.resolveForTenant('22222222-2222-4222-8222-222222222222');
    expect(r1.adapter).toBe(r2.adapter);
    expect(r1.providerEnvironment).toBe('test');
  });
});
