import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { BrandingService } from '../branding/branding.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import type { MailerService } from '../mail/mailer.service.js';
import type { BookingHoldLedger, OpenWalletHold } from '../portfolios/booking-hold.ledger.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { ordersController } from './__fixtures__/orders-controller.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * Lo que `/orders` dice de la retención de cartera de cada orden (SAB-10): `walletHold`, para que
 * Reservas avise que cancelar o anular libera el saldo retenido, sólo cuando hay algo que liberar.
 * Se lee en lote, y si la base falla la lista sale igual, sin el aviso.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VUELOS = 'stub-air';

function fila(id: string): OrderRow {
  return {
    id,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: VUELOS,
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
    created_at: new Date('2026-10-13T00:00:00Z'),
    updated_at: new Date('2026-10-13T00:00:00Z'),
  };
}

function banco(
  filas: OrderRow[],
  ledger: 'ok' | 'falla' | 'ninguno' = 'ok',
  abiertas: Readonly<Record<string, OpenWalletHold>> = {},
) {
  const openHoldsOf = vi.fn((_tenantId: string, ids: readonly string[]) =>
    ledger === 'falla'
      ? Promise.reject(new Error('wallet_hold_groups no disponible'))
      : Promise.resolve(
          new Map(
            ids.flatMap((id) => (abiertas[id] === undefined ? [] : [[id, abiertas[id]] as const])),
          ),
        ),
  );
  const reads = new HotelOrderReadsService(
    hotelRegistry(
      [new StubHotelProviderFactory({ code: 'hoteles-anon', capabilities: { retrieve: true } })],
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
  };
  const controller = ordersController({
    orders: orders as unknown as OrdersService,
    mailer: {} as unknown as MailerService,
    branding: {} as unknown as BrandingService,
    activeTenant: { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    registry: new FlightProviderRegistry([new StubProviderFactory({ code: VUELOS })], {
      decisionFor: () => Promise.resolve(undefined),
    }),
    hotelReads: reads,
    walletHolds:
      ledger === 'ninguno' ? undefined : ({ openHoldsOf } as unknown as BookingHoldLedger),
  });
  return { controller, openHoldsOf };
}

describe('/orders dice qué reservas tienen saldo retenido (SAB-10)', () => {
  it('la lista lee las retenciones en UNA consulta y marca sólo las abiertas', async () => {
    const b = banco([fila('o1'), fila('o2'), fila('o3')], 'ok', { o1: 'captured', o3: 'held' });

    const { orders } = await b.controller.list(USER);

    expect(b.openHoldsOf).toHaveBeenCalledOnce();
    expect(b.openHoldsOf).toHaveBeenCalledWith(TENANT, ['o1', 'o2', 'o3']);
    expect(Object.fromEntries(orders.map((o) => [o.id, o.walletHold]))).toEqual({
      o1: 'captured',
      o2: null,
      o3: 'held',
    });
  });

  it('el detalle trae la suya', async () => {
    const b = banco([fila('o1'), fila('o2')], 'ok', { o1: 'captured' });
    expect((await b.controller.findOne(USER, 'o1')).order?.walletHold).toBe('captured');
    expect((await b.controller.findOne(USER, 'o2')).order?.walletHold).toBeNull();
  });

  it('si la base falla, la lista sale igual y sin el aviso', async () => {
    const b = banco([fila('o1')], 'falla');
    const { orders } = await b.controller.list(USER);
    expect(orders.map((o) => o.walletHold)).toEqual([null]);
  });

  it('sin órdenes no consulta, y sin el ledger nada dice que haya retención', async () => {
    const vacia = banco([]);
    await vacia.controller.list(USER);
    expect(vacia.openHoldsOf).not.toHaveBeenCalled();

    const sin = banco([fila('o1')], 'ninguno');
    expect((await sin.controller.list(USER)).orders[0]?.walletHold).toBeNull();
  });
});
