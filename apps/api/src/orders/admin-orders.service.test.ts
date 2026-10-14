import { describe, expect, it, vi } from 'vitest';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { AdminOrderNotFoundError } from './admin-orders.errors.js';
import { AdminOrdersQuerySchema } from './admin-orders.schemas.js';
import { ADMIN_ORDER_VIEWED_EVENT, AdminOrdersService } from './admin-orders.service.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { OrderCapabilitiesService } from './order-capabilities.service.js';
import type { OrderRow, OrdersService } from './orders.service.js';

/**
 * La orquestación de Reservas de la red, sin base: qué se lee con qué tenant, cuándo es 404 y que
 * cada ficha abierta (y sólo una abierta) quede en la auditoría del nodo. Las consultas mismas las
 * prueba admin-orders.integration.test.ts contra Postgres.
 */

const ACTOR = '99999999-9999-4999-8999-999999999999';
const ORDEN = '7F1D2C3B-4A5F-4E60-8B0E-4B7C9A3D4C1E';
const ORDEN_ID = ORDEN.toLowerCase();
const DUENO = '0b0e4b7c-9a3d-4c1e-8f2a-1d2c3b4a5f60';
const RECHAZO_DE_LA_BASE = Object.assign(new Error('admin_superadmin_required'), {
  code: '42501',
});

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDEN_ID,
    tenant_id: DUENO,
    user_id: 'u-1',
    quotation_id: null,
    provider: 'tbo-hotels',
    provider_order_id: 'TBO-1',
    status: 'confirmed',
    search_criteria: { vertical: 'hotels' },
    selected_offer: {},
    passengers: [
      { room: 0, guests: [{ firstName: 'Ana', lastName: 'Pérez', paxType: 'ADT', doc: 'X1' }] },
    ],
    contact_info: { email: 'huesped@correo.com', phone: { countryCode: '57', number: '300' } },
    total_amount: 1000,
    currency: 'COP',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: 'ST-1',
    provider_account_id: null,
    created_at: new Date('2026-10-13T10:00:00Z'),
    updated_at: new Date('2026-10-13T10:00:00Z'),
    ...over,
  };
}

const TRACKING = {
  subStatus: null,
  providerStatus: 'Confirmed',
  providerStatusAt: '2026-10-13T10:05:00.000Z',
  providerStatusSource: 'book' as const,
  refundAwaited: false,
  hotelConfirmationNumber: 'HCN-1',
  hcnState: 'present' as const,
};

/**
 * Los dobles. `withRequestContext` y `withTenant` no corren la función: devuelven, en orden, lo que
 * cada lectura habría leído (el dueño, la retención y la conciliación, lo de la red).
 */
function banco(opts: { owner?: string | null; row?: OrderRow | undefined; hotel?: boolean } = {}) {
  const network = {
    tenant: {
      id: DUENO,
      name: 'Agencia Uno',
      slug: 'agencia-uno',
      tenant_type: 'agency' as const,
      is_branch: false,
      status: 'active',
    },
    path: [{ id: DUENO, name: 'Agencia Uno' }],
    seller: { id: 'u-1', email: 'vendedor@agencia.test', name: 'Vendedor' },
    attention: [{ reason: 'hcn-missing', since: new Date('2026-10-13T11:00:00Z') }],
    events: [],
  };
  const db = {
    withRequestContext: vi
      .fn()
      .mockResolvedValueOnce(opts.owner === undefined ? DUENO : opts.owner)
      .mockResolvedValueOnce(network),
    withTenant: vi.fn().mockResolvedValue({ hold: undefined, reconciliation: [] }),
  };
  const orders = {
    findById: vi.fn(() => Promise.resolve('row' in opts ? opts.row : orderRow())),
    listOperations: vi.fn(() => Promise.resolve([])),
  };
  const hotelReads = {
    handles: vi.fn(() => opts.hotel ?? true),
    trackingOf: vi.fn(() => Promise.resolve(new Map([[ORDEN_ID, TRACKING]]))),
  };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const capabilities = {
    capabilitiesForOrder: vi.fn(() => ({
      retrieve: true,
      cancel: true,
      pay: true,
      services: true,
      reshop: true,
    })),
  };
  const service = new AdminOrdersService(
    db as unknown as DatabaseService,
    orders as unknown as OrdersService,
    hotelReads as unknown as HotelOrderReadsService,
    audit as unknown as AuditService,
    capabilities as unknown as OrderCapabilitiesService,
  );
  return { service, db, orders, hotelReads, audit, capabilities };
}

describe('la ficha', () => {
  it('lee con el tenant de la orden, recorta lo sensible y deja platform.order.viewed en ese nodo', async () => {
    const { service, db, orders, hotelReads, audit } = banco();

    const detail = await service.detail(ACTOR, ORDEN);

    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: ACTOR }, expect.any(Function));
    expect(orders.findById).toHaveBeenCalledWith(DUENO, ORDEN_ID);
    expect(orders.listOperations).toHaveBeenCalledWith(DUENO, ORDEN_ID);
    expect(hotelReads.trackingOf).toHaveBeenCalledWith(DUENO, [ORDEN_ID]);
    expect(db.withTenant).toHaveBeenCalledWith(DUENO, expect.any(Function));

    expect(detail.order.passengers).toEqual([
      { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT', room: 0 },
    ]);
    expect(detail.order.contactInfo).toEqual({ email: 'huesped@correo.com', phone: '+57 300' });
    expect(detail.providerTracking).toEqual(TRACKING);
    expect(detail.order.providerTracking).toEqual(TRACKING);
    expect(detail.tenant).toMatchObject({ id: DUENO, tenantType: 'agency' });
    expect(detail.seller).toEqual({ id: 'u-1', email: 'vendedor@agencia.test', name: 'Vendedor' });
    expect(detail.walletHold).toBeNull();
    expect(detail.attention).toEqual([
      { reason: 'hcn-missing', since: '2026-10-13T11:00:00.000Z' },
    ]);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledWith({
      eventType: ADMIN_ORDER_VIEWED_EVENT,
      tenantId: DUENO,
      actorUserId: ACTOR,
      aggregateType: 'order',
      aggregateId: ORDEN_ID,
      payload: { orderId: ORDEN_ID },
    });
  });

  it('una orden que no es de hoteles no pide seguimiento', async () => {
    const { service, hotelReads } = banco({
      hotel: false,
      row: orderRow({ provider: 'latam-ndc' }),
    });
    const detail = await service.detail(ACTOR, ORDEN);
    expect(hotelReads.trackingOf).not.toHaveBeenCalled();
    expect(detail.providerTracking).toBeNull();
  });

  it('una orden que no existe es un 404 y no audita nada', async () => {
    const { service, orders, audit } = banco({ owner: null });
    await expect(service.detail(ACTOR, ORDEN)).rejects.toBeInstanceOf(AdminOrderNotFoundError);
    expect(orders.findById).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('una orden que desaparece entre las dos lecturas también es un 404', async () => {
    const { service, audit } = banco({ row: undefined });
    await expect(service.detail(ACTOR, ORDEN)).rejects.toBeInstanceOf(AdminOrderNotFoundError);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('si la base dice que no es el superadmin, 403 y nada en la auditoría', async () => {
    const { service, db, audit } = banco();
    db.withRequestContext.mockReset().mockRejectedValue(RECHAZO_DE_LA_BASE);
    await expect(service.detail(ACTOR, ORDEN)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('cualquier otro error de la base sale tal cual', async () => {
    const { service, db } = banco();
    const caida = new Error('connection terminated');
    db.withRequestContext.mockReset().mockRejectedValue(caida);
    await expect(service.detail(ACTOR, ORDEN)).rejects.toBe(caida);
  });
});

describe('las capacidades de la ficha', () => {
  it('salen de OrderCapabilitiesService, sólo las de post-venta: lo de vender no aparece', async () => {
    const { service, capabilities } = banco();
    const detail = await service.detail(ACTOR, ORDEN);
    expect(capabilities.capabilitiesForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: ORDEN_ID, provider: 'tbo-hotels', status: 'confirmed' }),
    );
    expect(detail.capabilities).toEqual({ retrieve: true, cancel: true });
  });
});

describe('lo que usan las acciones', () => {
  it('snapshot: la misma ficha, sin dejar platform.order.viewed', async () => {
    const { service, audit } = banco();
    const detail = await service.snapshot(ACTOR, ORDEN);
    expect(detail.order.id).toBe(ORDEN_ID);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('snapshot: el rechazo de la base es el 403 de la guarda', async () => {
    const { service, db } = banco();
    db.withRequestContext.mockReset().mockRejectedValue(RECHAZO_DE_LA_BASE);
    await expect(service.snapshot(ACTOR, ORDEN)).rejects.toBeInstanceOf(SuperadminRequiredError);
  });

  it('ownerOf: el nodo de la reserva, con el superadmin en la base', async () => {
    const { service, db } = banco();
    await expect(service.ownerOf(ACTOR, ORDEN)).resolves.toBe(DUENO);
    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: ACTOR }, expect.any(Function));
  });

  it('ownerOf: 404 si no existe y 403 si la base dice que no es el superadmin', async () => {
    await expect(banco({ owner: null }).service.ownerOf(ACTOR, ORDEN)).rejects.toBeInstanceOf(
      AdminOrderNotFoundError,
    );
    const { service, db } = banco();
    db.withRequestContext.mockReset().mockRejectedValue(RECHAZO_DE_LA_BASE);
    await expect(service.ownerOf(ACTOR, ORDEN)).rejects.toBeInstanceOf(SuperadminRequiredError);
  });
});

describe('la búsqueda', () => {
  it('el rechazo de la base es el mismo 403 de la guarda', async () => {
    const { service, db } = banco();
    db.withRequestContext.mockReset().mockRejectedValue(RECHAZO_DE_LA_BASE);
    await expect(service.search(ACTOR, AdminOrdersQuerySchema.parse({}))).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
  });

  it('un nodo que no existe es el 404 de la consola', async () => {
    const { service, db } = banco();
    db.withRequestContext.mockReset().mockRejectedValue(new PlatformConsoleScopeNotFoundError());
    await expect(
      service.search(ACTOR, AdminOrdersQuerySchema.parse({ tenantId: DUENO })),
    ).rejects.toBeInstanceOf(PlatformConsoleScopeNotFoundError);
  });
});
