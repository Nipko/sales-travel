import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import type { MailerService } from '../mail/mailer.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type {
  FlightOrderTrackingRecord,
  FlightOrderTrackingStore,
} from './flight-order-tracking.store.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * Lo que `/orders` devuelve de una orden de VUELO desde 0082: `flightTracking`, con los
 * localizadores de la aerolínea, los tiquetes con su estado y el plazo de emisión guardados. Se lee
 * en lote (una consulta para toda la lista, sólo con los vuelos), y si la base falla la lista sale
 * igual, sin él.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const HOTEL = 'hoteles-anon';
const VUELOS = 'stub-air';
const TIQUETE = '0457123456789';

function fila(id: string, provider: string, extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider,
    provider_order_id: `LOC-${id}`,
    status: 'confirmed',
    search_criteria: {},
    selected_offer: {},
    passengers: [],
    contact_info: {},
    total_amount: 34012,
    currency: 'USD',
    order_number: 1,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-09-26T00:00:00Z'),
    updated_at: new Date('2026-09-26T00:00:00Z'),
    ...extra,
  };
}

function registro(orderId: string): FlightOrderTrackingRecord {
  return {
    orderId,
    airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
    documents: [
      {
        number: TIQUETE,
        kind: 'TICKET',
        travelerIndex: 0,
        status: 'ISSUED',
        providerStatusCode: 'TE',
      },
    ],
    ticketingDeadline: { date: '2026-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
    lastReadAt: new Date('2026-10-13T15:00:00Z'),
  };
}

const PUBLICO = {
  airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
  documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 }],
  ticketingDeadline: { date: '2026-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
};

function banco(filas: OrderRow[], opciones: { store?: 'ok' | 'falla' | 'ninguno' } = {}) {
  const listTracking = vi.fn((_tenantId: string, ids: readonly string[]) =>
    opciones.store === 'falla'
      ? Promise.reject(new Error('flight_order_tracking no disponible'))
      : Promise.resolve(new Map(ids.filter((id) => id !== 'f2').map((id) => [id, registro(id)]))),
  );
  const flightStore =
    opciones.store === 'ninguno'
      ? undefined
      : ({ listTracking } as unknown as FlightOrderTrackingStore);
  const reads = new HotelOrderReadsService(
    hotelRegistry(
      [new StubHotelProviderFactory({ code: HOTEL, capabilities: { retrieve: true } })],
      hotelFlags(false),
    ),
    { listTracking: () => Promise.resolve(new Map()) } as unknown as HotelOrderTrackingStore,
    new CircuitBreakerService(),
    new RecordingAuditService().asService(),
  );
  const orders = {
    findAll: vi.fn(() => Promise.resolve(filas)),
    findById: vi.fn((_tenantId: string, id: string) =>
      Promise.resolve(filas.find((f) => f.id === id)),
    ),
    retrieveOrder: vi.fn((_tenantId: string, row: OrderRow) =>
      Promise.resolve(
        row.provider === HOTEL
          ? { vertical: 'hotels' }
          : { found: true, status: 'ACTIVE', airlineLocators: [], warnings: [] },
      ),
    ),
  };
  const controller = new OrdersController(
    orders as unknown as OrdersService,
    {} as unknown as DatabaseService,
    {} as unknown as MailerService,
    {} as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    new FlightProviderRegistry([new StubProviderFactory({ code: VUELOS })], {
      decisionFor: () => Promise.resolve(undefined),
    }),
    reads,
    flightStore,
  );
  return { controller, listTracking, orders };
}

describe('/orders con el seguimiento de un vuelo (0082)', () => {
  it('la lista lee el seguimiento en UNA consulta, sólo de los vuelos', async () => {
    const b = banco([
      fila('f1', VUELOS),
      fila('h1', HOTEL),
      fila('c1', 'agent-cars'),
      fila('f2', VUELOS),
    ]);

    const { orders } = await b.controller.list(USER);

    expect(b.listTracking).toHaveBeenCalledTimes(1);
    expect(b.listTracking).toHaveBeenCalledWith(TENANT, ['f1', 'f2']);
    expect(Object.fromEntries(orders.map((o) => [o.id, o.flightTracking]))).toEqual({
      f1: PUBLICO,
      h1: null,
      c1: null,
      // Un vuelo sin lecturas guardadas todavía.
      f2: null,
    });
    // El código del proveedor y el momento de la lectura no salen.
    expect(JSON.stringify(orders)).not.toContain('"TE"');
    expect(JSON.stringify(orders)).not.toContain('lastReadAt');
  });

  it('sin vuelos en la lista no consulta', async () => {
    const b = banco([fila('h1', HOTEL)]);
    await b.controller.list(USER);
    expect(b.listTracking).not.toHaveBeenCalled();
  });

  it('el detalle de un vuelo trae su seguimiento; el de un hotel, null', async () => {
    const b = banco([fila('f1', VUELOS), fila('h1', HOTEL)]);

    expect((await b.controller.findOne(USER, 'f1')).order?.flightTracking).toEqual(PUBLICO);
    expect((await b.controller.findOne(USER, 'h1')).order?.flightTracking).toBeNull();
    expect(b.listTracking).toHaveBeenCalledTimes(1);
  });

  it('si la base falla, la lista y el detalle salen igual, sin seguimiento', async () => {
    const b = banco([fila('f1', VUELOS)], { store: 'falla' });

    const { orders } = await b.controller.list(USER);
    expect(orders.map((o) => [o.id, o.flightTracking])).toEqual([['f1', null]]);
    expect((await b.controller.findOne(USER, 'f1')).order?.flightTracking).toBeNull();
  });

  it('sin store (dobles de otras suites), `flightTracking: null`', async () => {
    const b = banco([fila('f1', VUELOS)], { store: 'ninguno' });
    const { orders } = await b.controller.list(USER);
    expect(orders[0]?.flightTracking).toBeNull();
  });

  it('la consulta de un vuelo devuelve la lectura más lo que quedó guardado', async () => {
    const b = banco([fila('f1', VUELOS), fila('h1', HOTEL)]);

    const vuelo = await b.controller.retrieve(USER, 'f1');
    expect(vuelo).toEqual({
      found: true,
      status: 'ACTIVE',
      airlineLocators: [],
      warnings: [],
      flightTracking: PUBLICO,
    });
    // El orden importa: primero la consulta (que guarda), después la lectura de lo guardado.
    expect(b.orders.retrieveOrder.mock.invocationCallOrder[0]).toBeLessThan(
      b.listTracking.mock.invocationCallOrder[0] ?? 0,
    );

    const hotel = await b.controller.retrieve(USER, 'h1');
    expect(hotel).toEqual({ vertical: 'hotels' });
  });

  it('si leer lo guardado falla después de consultar, la consulta contesta igual', async () => {
    const b = banco([fila('f1', VUELOS)], { store: 'falla' });
    expect(await b.controller.retrieve(USER, 'f1')).toMatchObject({
      found: true,
      flightTracking: null,
    });
  });
});
