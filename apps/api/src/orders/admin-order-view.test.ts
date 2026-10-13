import { describe, expect, it } from 'vitest';
import {
  adminContact,
  adminOrderEvent,
  adminOrderListItem,
  adminOrdersPage,
  adminOrderTenant,
  adminOrderView,
  adminPassengers,
  adminReconciliationItem,
  adminWalletHold,
  sortAttention,
  type AdminOrderSearchRow,
} from './admin-order-view.js';
import { decodeAdminOrdersCursor } from './admin-orders.schemas.js';
import type { OrderRow } from './orders.service.js';

const CREATED = new Date('2026-10-13T15:04:05.123Z');

function searchRow(over: Partial<AdminOrderSearchRow> = {}): AdminOrderSearchRow {
  return {
    id: '7f1d2c3b-4a5f-4e60-8b0e-4b7c9a3d4c1e',
    tenant_id: '0b0e4b7c-9a3d-4c1e-8f2a-1d2c3b4a5f60',
    tenant_name: 'Agencia Uno',
    tenant_type: 'agency',
    is_branch: false,
    provider: 'latam-ndc',
    vertical: 'flights',
    provider_order_id: 'ABC123',
    provider_booking_ref: null,
    order_number: 42,
    status: 'confirmed',
    sub_status: null,
    // BIGINT: `pg` lo entrega como texto.
    total_amount: '125000',
    currency: 'COP',
    created_at: CREATED,
    updated_at: CREATED,
    seller_email: 'vendedor@agencia.test',
    attention_reason: null,
    attention_since: null,
    cursor_at: '2026-10-13T15:04:05.123456Z',
    ...over,
  };
}

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'o-1',
    tenant_id: 't-1',
    user_id: 'u-1',
    quotation_id: null,
    provider: 'latam-ndc',
    provider_order_id: 'ABC123',
    status: 'confirmed',
    search_criteria: { origin: 'BOG', destination: 'LIM' },
    selected_offer: { offerId: 'of-1' },
    passengers: [],
    contact_info: {},
    total_amount: '99900' as unknown as number,
    currency: 'USD',
    order_number: 7,
    provider_raw: { secreto: 'no sale' },
    error_message: null,
    create_request_key: 'clave-de-idempotencia',
    provider_booking_ref: null,
    provider_account_id: 'cuenta-1',
    created_at: CREATED,
    updated_at: CREATED,
    ...over,
  };
}

describe('la fila de la lista', () => {
  it('identifica la reserva sin pasajeros ni contacto, con el importe como número', () => {
    const item = adminOrderListItem(searchRow());
    expect(item).toEqual({
      id: '7f1d2c3b-4a5f-4e60-8b0e-4b7c9a3d4c1e',
      tenantId: '0b0e4b7c-9a3d-4c1e-8f2a-1d2c3b4a5f60',
      tenantName: 'Agencia Uno',
      tenantType: 'agency',
      isBranch: false,
      provider: 'latam-ndc',
      vertical: 'flights',
      providerOrderId: 'ABC123',
      providerBookingRef: null,
      orderNumber: 42,
      status: 'confirmed',
      subStatus: null,
      totalAmountMinor: 125_000,
      currency: 'COP',
      createdAt: '2026-10-13T15:04:05.123Z',
      updatedAt: '2026-10-13T15:04:05.123Z',
      sellerEmail: 'vendedor@agencia.test',
      attention: null,
    });
  });

  it('el motivo de atención, sólo si es del vocabulario', () => {
    const since = new Date('2026-10-13T10:00:00Z');
    expect(
      adminOrderListItem(searchRow({ attention_reason: 'cancel-failed', attention_since: since }))
        .attention,
    ).toEqual({ reason: 'cancel-failed', since: '2026-10-13T10:00:00.000Z' });
    expect(
      adminOrderListItem(searchRow({ attention_reason: 'otro-motivo', attention_since: since }))
        .attention,
    ).toBeNull();
    expect(
      adminOrderListItem(searchRow({ attention_reason: 'review', attention_since: null }))
        .attention,
    ).toBeNull();
  });
});

describe('la página', () => {
  const rows = [
    searchRow({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      cursor_at: '2026-10-13T15:00:00.000003Z',
    }),
    searchRow({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      cursor_at: '2026-10-13T15:00:00.000002Z',
    }),
    searchRow({
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      cursor_at: '2026-10-13T15:00:00.000001Z',
    }),
  ];

  it('con una fila de más hay otra página, y el cursor apunta a la última que se muestra', () => {
    const page = adminOrdersPage(rows, 2);
    expect(page.orders.map((o) => o.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(decodeAdminOrdersCursor(page.nextCursor ?? '')).toEqual({
      at: '2026-10-13T15:00:00.000002Z',
      id: rows[1]!.id,
    });
  });

  it('sin la fila de más, no hay cursor', () => {
    expect(adminOrdersPage(rows, 3).nextCursor).toBeNull();
    expect(adminOrdersPage([], 50)).toEqual({ orders: [], nextCursor: null });
  });
});

describe('los pasajeros de la ficha: sólo nombre y tipo', () => {
  it('vuelos: se van el documento, la fecha de nacimiento y todo lo demás', () => {
    const passengers = adminPassengers([
      {
        paxId: 'PAX1',
        paxType: 'ADT',
        title: 'Mr',
        givenName: ' Ana ',
        surname: 'Pérez',
        birthdate: '1990-01-01',
        gender: 'F',
        identityDoc: { type: 'PT', number: 'AB123456', expiryDate: '2030-01-01' },
        loyalty: { programCode: 'LA', accountNumber: '999' },
      },
      { paxType: 'INF', givenName: 'Leo', surname: 'Pérez', birthdate: '2026-01-01' },
    ]);

    expect(passengers).toEqual([
      { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' },
      { givenName: 'Leo', surname: 'Pérez', paxType: 'INF' },
    ]);
    const serialized = JSON.stringify(passengers);
    expect(serialized).not.toContain('AB123456');
    expect(serialized).not.toContain('1990-01-01');
    expect(serialized).not.toContain('identityDoc');
    expect(serialized).not.toContain('birthdate');
  });

  it('hoteles: los huéspedes de cada habitación, con su habitación', () => {
    expect(
      adminPassengers([
        {
          room: 0,
          guests: [
            {
              paxType: 'ADT',
              title: 'Mrs',
              firstName: 'Ana',
              lastName: 'Pérez',
              sent: { firstName: 'ANA', lastName: 'PEREZ' },
            },
            { paxType: 'CHD', firstName: 'Leo', lastName: 'Pérez', age: 7 },
          ],
        },
        { room: 1, guests: [{ paxType: 'ADT', firstName: 'Juan', lastName: 'Gómez' }] },
        { room: -1, guests: [{ firstName: 'Sin', lastName: 'Habitación' }] },
      ]),
    ).toEqual([
      { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT', room: 0 },
      { givenName: 'Leo', surname: 'Pérez', paxType: 'CHD', room: 0 },
      { givenName: 'Juan', surname: 'Gómez', paxType: 'ADT', room: 1 },
      { givenName: 'Sin', surname: 'Habitación', paxType: null },
    ]);
  });

  it('autos: el conductor', () => {
    expect(adminPassengers([{ givenName: 'Ana', surname: 'Pérez', paxType: 'DRIVER' }])).toEqual([
      { givenName: 'Ana', surname: 'Pérez', paxType: 'DRIVER' },
    ]);
  });

  it('lo que no tiene forma de pasajero no sale, y hay un tope', () => {
    expect(adminPassengers(null)).toEqual([]);
    expect(adminPassengers({ givenName: 'Ana' })).toEqual([]);
    expect(adminPassengers(['Ana', 7, null, { paxType: 'ADT' }, { guests: ['x'] }])).toEqual([]);
    expect(adminPassengers([{ givenName: 'Ana', surname: '  ' }])).toEqual([
      { givenName: 'Ana', surname: '', paxType: null },
    ]);
    const many = Array.from({ length: 80 }, (_, i) => ({ givenName: `P${i}`, surname: 'X' }));
    expect(adminPassengers(many)).toHaveLength(50);
    const guests = Array.from({ length: 80 }, (_, i) => ({ firstName: `H${i}`, lastName: 'X' }));
    const crowded = [{ room: 0, guests }];
    expect(adminPassengers(crowded)).toHaveLength(50);
  });
});

describe('el contacto de la ficha: sólo correo y teléfono', () => {
  it('vuelos: teléfono con su prefijo y código de área; la dirección no sale', () => {
    expect(
      adminContact({
        email: 'cliente@correo.com',
        phone: '3001234567',
        countryDialingCode: '57',
        areaCode: '1',
        postalAddress: { countryCode: 'CO', postalCode: '110111', street: 'Calle 1 # 2-3' },
      }),
    ).toEqual({ email: 'cliente@correo.com', phone: '+57 1 3001234567' });
  });

  it('hoteles: el teléfono es un objeto', () => {
    expect(
      adminContact({
        email: 'huesped@correo.com',
        phone: { countryCode: '+51', number: '987 654 321' },
      }),
    ).toEqual({ email: 'huesped@correo.com', phone: '+51 987 654 321' });
  });

  it('autos: sólo el correo; sin contacto, nada', () => {
    expect(adminContact({ email: 'conductor@correo.com' })).toEqual({
      email: 'conductor@correo.com',
      phone: null,
    });
    expect(adminContact(null)).toEqual({ email: null, phone: null });
    expect(adminContact({ phone: { countryCode: '57' } })).toEqual({ email: null, phone: null });
  });
});

describe('la orden de la ficha', () => {
  it('la forma de GET /orders/:id sin capacidades, con pasajeros y contacto recortados', () => {
    const view = adminOrderView(
      orderRow({
        passengers: [
          {
            givenName: 'Ana',
            surname: 'Pérez',
            paxType: 'ADT',
            birthdate: '1990-01-01',
            identityDoc: { number: 'AB123456' },
          },
        ],
        contact_info: { email: 'cliente@correo.com', phone: '3001234567' },
        provider_booking_ref: 'ST-REF-1',
      }),
      null,
    );

    expect(view).toEqual({
      id: 'o-1',
      tenantId: 't-1',
      userId: 'u-1',
      quotationId: null,
      provider: 'latam-ndc',
      pnr: 'ABC123',
      providerBookingRef: 'ST-REF-1',
      status: 'confirmed',
      searchCriteria: { origin: 'BOG', destination: 'LIM' },
      selectedOffer: { offerId: 'of-1' },
      passengers: [{ givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' }],
      contactInfo: { email: 'cliente@correo.com', phone: '3001234567' },
      totalAmount: 99_900,
      currency: 'USD',
      orderNumber: 7,
      errorMessage: null,
      providerTracking: null,
      createdAt: '2026-10-13T15:04:05.123Z',
      updatedAt: '2026-10-13T15:04:05.123Z',
    });
    expect(view).not.toHaveProperty('capabilities');
    expect(JSON.stringify(view)).not.toContain('provider_raw');
    expect(JSON.stringify(view)).not.toContain('clave-de-idempotencia');
  });

  it('el nodo, la retención y la conciliación', () => {
    expect(
      adminOrderTenant(
        {
          id: 't-1',
          name: 'Agencia Uno',
          slug: 'agencia-uno',
          tenant_type: 'agency',
          is_branch: true,
          status: 'active',
        },
        [
          { id: 'p', name: 'Planetour' },
          { id: 't-1', name: 'Agencia Uno' },
        ],
      ),
    ).toEqual({
      id: 't-1',
      name: 'Agencia Uno',
      slug: 'agencia-uno',
      tenantType: 'agency',
      isBranch: true,
      status: 'active',
      path: [
        { id: 'p', name: 'Planetour' },
        { id: 't-1', name: 'Agencia Uno' },
      ],
    });

    expect(
      adminWalletHold({
        status: 'held',
        mode: 'enforce',
        currency: 'cop ',
        sale_amount_minor: '125000',
        credential_source: 'resolved',
        created_at: CREATED,
        captured_at: '2026-10-13T16:00:00Z',
        closed_at: null,
      }),
    ).toEqual({
      status: 'held',
      mode: 'enforce',
      currency: 'COP',
      saleAmountMinor: 125_000,
      credentialSource: 'resolved',
      createdAt: '2026-10-13T15:04:05.123Z',
      capturedAt: '2026-10-13T16:00:00.000Z',
      closedAt: null,
    });

    expect(
      adminReconciliationItem({
        kind: 'R3',
        severity: 'critical',
        action: 'review',
        created_at: CREATED,
      }),
    ).toEqual({
      kind: 'R3',
      severity: 'critical',
      action: 'review',
      createdAt: '2026-10-13T15:04:05.123Z',
    });
  });
});

describe('los motivos de atención de la ficha', () => {
  it('del más grave al menos grave y, a igual motivo, del más viejo; lo desconocido no sale', () => {
    expect(
      sortAttention([
        { reason: 'verifying-long', since: new Date('2026-10-01T00:00:00Z') },
        { reason: 'review', since: new Date('2026-10-03T00:00:00Z') },
        { reason: 'otro', since: new Date('2026-10-01T00:00:00Z') },
        { reason: 'hold-orphan', since: new Date('2026-10-05T00:00:00Z') },
        { reason: 'review', since: new Date('2026-10-02T00:00:00Z') },
      ]),
    ).toEqual([
      { reason: 'hold-orphan', since: '2026-10-05T00:00:00.000Z' },
      { reason: 'review', since: '2026-10-02T00:00:00.000Z' },
      { reason: 'review', since: '2026-10-03T00:00:00.000Z' },
      { reason: 'verifying-long', since: '2026-10-01T00:00:00.000Z' },
    ]);
  });
});

describe('los eventos de la ficha', () => {
  it('el payload sale sin claves sensibles', () => {
    expect(
      adminOrderEvent({
        id: 'e-1',
        occurred_at: CREATED,
        event_type: 'order.cancelled',
        tenant_id: 't-1',
        actor_user_id: 'u-1',
        actor_email: 'vendedor@agencia.test',
        payload: { orderId: 'o-1', provider: { apiKey: 'k', code: 'latam-ndc' }, token: 't' },
      }),
    ).toEqual({
      id: 'e-1',
      occurredAt: '2026-10-13T15:04:05.123Z',
      eventType: 'order.cancelled',
      tenantId: 't-1',
      actorUserId: 'u-1',
      actorEmail: 'vendedor@agencia.test',
      payload: { orderId: 'o-1', provider: { code: 'latam-ndc' } },
    });
  });
});
