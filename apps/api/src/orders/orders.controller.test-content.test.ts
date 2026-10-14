import { describe, expect, it, vi } from 'vitest';
import type { BrandingService } from '../branding/branding.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { TEST_CONTENT_NOTICE } from '../mail/templates.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { ordersController } from './__fixtures__/orders-controller.js';
import type { CreateOrderDto, OrderRow, OrdersService } from './orders.service.js';

/**
 * Una reserva contra la cuenta de pruebas del proveedor, vista desde `/orders`: el pasajero no
 * recibe la confirmación automática, el vendedor puede reenviarla marcada, y la pantalla sabe que
 * es de prueba.
 *
 * El entorno lo lee el controlador de `selected_offer.provider.environment`, que escribió el
 * servicio al crear la orden (ver `order-provider-routing.test.ts`).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VUELOS = 'stub-air';

function fila(id: string, environment?: 'test' | 'live', extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: VUELOS,
    provider_order_id: `PNR${id}`,
    status: 'confirmed',
    search_criteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
    selected_offer: {
      provider: {
        name: VUELOS,
        offerRef: 'R-1',
        ...(environment === undefined ? {} : { environment }),
      },
    },
    passengers: [{ givenName: 'Ana', surname: 'Ríos' }],
    contact_info: { email: 'ana@x.test' },
    total_amount: 34012,
    currency: 'USD',
    order_number: 7,
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

function banco(filas: OrderRow[]) {
  const sendToTenant = vi.fn(
    (_tenantId: string, _mail: { to: string; subject: string; html: string; text: string }) =>
      Promise.resolve(true),
  );
  const orders = {
    findAll: vi.fn(() => Promise.resolve(filas)),
    findById: vi.fn((_tenantId: string, id: string) =>
      Promise.resolve(filas.find((f) => f.id === id)),
    ),
    createOrder: vi.fn((_tenantId: string, _userId: string, _dto: CreateOrderDto) =>
      Promise.resolve({
        order: filas[0]!,
        providerResult: {
          outcome: 'CONFIRMED',
          pnr: filas[0]!.provider_order_id ?? undefined,
          items: [],
          issues: [],
        },
        saga: { kind: 'settled', status: 'confirmed' },
      }),
    ),
  };
  const hotelReads = {
    handles: () => false,
    capabilitiesOf: () => undefined,
    trackingOf: () => Promise.resolve(new Map()),
  } as unknown as HotelOrderReadsService;
  const controller = ordersController({
    orders: orders as unknown as OrdersService,
    mailer: { sendToTenant } as unknown as MailerService,
    branding: {
      resolve: () => Promise.resolve({ name: 'Agencia Sur', color: null }),
    } as unknown as BrandingService,
    activeTenant: { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
    registry: new FlightProviderRegistry([new StubProviderFactory({ code: VUELOS })], {
      decisionFor: () => Promise.resolve(undefined),
    }),
    hotelReads: hotelReads,
  });
  return { controller, sendToTenant };
}

/** El correo automático sale con `void`: se deja correr la cola de microtareas antes de mirar. */
async function drenar(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('/orders con una reserva de la cuenta de pruebas del proveedor', () => {
  it('crear una reserva de prueba NO le manda la confirmación automática al pasajero', async () => {
    const b = banco([fila('o1', 'test')]);

    const res = await b.controller.create(USER, {} as CreateOrderDto);
    await drenar();

    expect(b.sendToTenant).not.toHaveBeenCalled();
    expect(res.order.testContent).toBe(true);
  });

  it('una reserva real confirmada sí sale por correo, como siempre', async () => {
    const b = banco([fila('o1')]);

    const res = await b.controller.create(USER, {} as CreateOrderDto);
    await drenar();

    expect(b.sendToTenant).toHaveBeenCalledTimes(1);
    expect(b.sendToTenant.mock.calls[0]?.[1].subject).not.toContain('[PRUEBA]');
    expect(res.order.testContent).toBe(false);
  });

  it('el vendedor puede reenviarla a mano: asunto «[PRUEBA] » y el aviso en el cuerpo', async () => {
    const b = banco([fila('o1', 'test')]);

    const res = await b.controller.sendConfirmation(USER, 'o1');

    expect(res).toEqual({ sent: true, to: 'ana@x.test' });
    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject).toBe('[PRUEBA] Reserva registrada #7 · PNR PNRo1');
    expect(mail?.html).toContain(TEST_CONTENT_NOTICE);
    expect(mail?.text.startsWith(TEST_CONTENT_NOTICE)).toBe(true);
  });

  it('reenviar una real no lleva prefijo ni aviso', async () => {
    const b = banco([fila('o1', 'live')]);

    await b.controller.sendConfirmation(USER, 'o1');

    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject).toBe('Reserva registrada #7 · PNR PNRo1');
    expect(mail?.html).not.toContain(TEST_CONTENT_NOTICE);
  });

  it('la lista y el detalle dicen cuál es de prueba', async () => {
    const b = banco([fila('o1', 'test'), fila('o2', 'live'), fila('o3')]);

    const { orders } = await b.controller.list(USER);
    expect(orders.map((o) => [o.id, o.testContent])).toEqual([
      ['o1', true],
      ['o2', false],
      ['o3', false],
    ]);
    expect((await b.controller.findOne(USER, 'o1')).order?.testContent).toBe(true);
  });

  it('una fila de otra vertical o sin oferta legible no se marca', async () => {
    const b = banco([
      fila('o1', undefined, { selected_offer: null }),
      fila('o2', undefined, { selected_offer: { category: 'Compacto' } }),
    ]);

    const { orders } = await b.controller.list(USER);
    expect(orders.every((o) => o.testContent === false)).toBe(true);
  });
});
