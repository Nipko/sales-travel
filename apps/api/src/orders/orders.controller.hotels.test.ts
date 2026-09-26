import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type {
  HotelOrderTrackingRow,
  HotelOrderTrackingStore,
} from './hotel-order-tracking.store.js';
import { OrdersController } from './orders.controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * Lo que `/orders` hace con una orden de hotel (docs/tbo/09 PR-5.2): capacidades del registry de
 * hoteles en vez de fijas, el seguimiento en la respuesta sin PII, y la consulta manual enrutada
 * por vertical. La cancelación de una orden de hotel se rechaza ANTES de tocar nada hasta que la
 * cancelación enrute por hoteles (PR-5.3): hoy iría al adapter de vuelos después de tomar el claim.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const HOTEL = 'hoteles-anon';
const VUELOS = 'stub-air';

function fila(id: string, provider: string, extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider,
    provider_order_id: `LOC-${id}`,
    status: 'confirmed',
    search_criteria: { vertical: provider === HOTEL ? 'hotels' : 'flights' },
    selected_offer: {},
    passengers: [{ firstName: 'Ana' }],
    contact_info: { email: 'ana@x.test' },
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

const SEGUIMIENTO: HotelOrderTrackingRow = {
  orderId: 'h1',
  subStatus: 'unknown',
  providerStatus: 'On_Request',
  providerStatusAt: new Date('2026-09-26T10:00:00Z'),
  providerStatusSource: 'retrieve',
  refundAwaited: false,
  hcn: 'HCN-1',
  hcnState: 'received',
};

function banco(filas: OrderRow[]) {
  const listTracking = vi.fn((_tenantId: string, ids: readonly string[]) =>
    Promise.resolve(
      new Map(ids.filter((id) => id === 'h1').map((id) => [id, { ...SEGUIMIENTO, orderId: id }])),
    ),
  );
  const store = { listTracking } as unknown as HotelOrderTrackingStore;
  const reads = new HotelOrderReadsService(
    hotelRegistry(
      [
        new StubHotelProviderFactory({
          code: HOTEL,
          capabilities: { retrieve: true, cancel: true },
        }),
      ],
      hotelFlags(false),
    ),
    store,
    new CircuitBreakerService(),
    new RecordingAuditService().asService(),
  );
  const orders = {
    findAll: vi.fn(() => Promise.resolve(filas)),
    findById: vi.fn((_tenantId: string, id: string) =>
      Promise.resolve(filas.find((f) => f.id === id)),
    ),
    retrieveOrder: vi.fn(() => Promise.resolve({ vertical: 'hotels' })),
    cancelOrder: vi.fn(() => Promise.resolve({ result: { success: true, warnings: [] } })),
  };
  const controller = new OrdersController(
    orders as unknown as OrdersService,
    {} as unknown as DatabaseService,
    {} as unknown as MailerService,
    {} as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    new FlightProviderRegistry([new StubProviderFactory({ code: VUELOS })], {
      isEnabledForTenant: () => Promise.resolve(false),
    }),
    reads,
  );
  return { controller, orders, listTracking };
}

describe('/orders con una orden de hotel', () => {
  it('las capacidades salen del registry de hoteles: consulta sí, cancelación todavía no', async () => {
    const b = banco([fila('h1', HOTEL), fila('f1', VUELOS)]);

    const { orders } = await b.controller.list(USER);

    expect(orders.find((o) => o.id === 'h1')?.capabilities).toEqual({
      retrieve: true,
      cancel: false,
      pay: false,
      services: false,
      reshop: false,
    });
    // Los vuelos siguen con lo que declara su registry.
    expect(orders.find((o) => o.id === 'f1')?.capabilities).toMatchObject({
      retrieve: true,
      cancel: true,
    });
  });

  it('el listado lleva el seguimiento de las de hotel, sin el valor crudo que no reconocimos', async () => {
    const b = banco([fila('h1', HOTEL), fila('f1', VUELOS)]);

    const { orders } = await b.controller.list(USER);

    expect(orders.find((o) => o.id === 'h1')?.providerTracking).toEqual({
      subStatus: 'unknown',
      providerStatus: 'unknown',
      providerStatusAt: '2026-09-26T10:00:00.000Z',
      providerStatusSource: 'retrieve',
      refundAwaited: false,
      hotelConfirmationNumber: 'HCN-1',
      hcnState: 'received',
    });
    expect(orders.find((o) => o.id === 'f1')?.providerTracking).toBeNull();
    // Sólo se consulta el seguimiento de las órdenes de hotel.
    expect(b.listTracking).toHaveBeenCalledWith(TENANT, ['h1']);
    expect(JSON.stringify(orders.map((o) => o.providerTracking))).not.toContain('On_Request');
  });

  it('el detalle también, y una orden de vuelos no pregunta por seguimiento', async () => {
    const b = banco([fila('h1', HOTEL), fila('f1', VUELOS)]);

    expect((await b.controller.findOne(USER, 'h1')).order?.providerTracking).toMatchObject({
      hotelConfirmationNumber: 'HCN-1',
    });
    expect((await b.controller.findOne(USER, 'f1')).order?.providerTracking).toBeNull();
    expect(b.listTracking).toHaveBeenCalledTimes(1);
  });

  it('la consulta manual pasa la fila leída con el tenant al servicio, que enruta por vertical', async () => {
    const b = banco([fila('h1', HOTEL)]);

    await b.controller.retrieve(USER, 'h1');

    expect(b.orders.retrieveOrder).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ id: 'h1', provider: HOTEL }),
      USER,
    );
  });

  it('una orden que el tenant no lee es 404 y no llega al servicio', async () => {
    const b = banco([]);
    await expect(b.controller.retrieve(USER, 'h1')).rejects.toBeInstanceOf(NotFoundException);
    expect(b.orders.retrieveOrder).not.toHaveBeenCalled();
  });

  it('cancelar una orden de hotel se rechaza antes de tomar el claim (PR-5.3 la cablea)', async () => {
    const b = banco([fila('h1', HOTEL)]);

    await expect(b.controller.cancel(USER, 'h1')).rejects.toBeInstanceOf(BadRequestException);
    expect(b.orders.cancelOrder).not.toHaveBeenCalled();
  });
});
