/**
 * Respuestas de `GET /admin/orders` y `GET /admin/orders/:id` como las arma el API
 * (apps/api/src/orders/admin-order-view.ts), para los tests de la consola de Reservas de la red.
 */

export const NODE_SUR = '10000000-0000-4000-8000-0000000000a1';
export const PLATFORM_NODE = '10000000-0000-4000-8000-0000000000f1';
export const ORDER_1 = '20000000-0000-4000-8000-000000000001';
export const ORDER_2 = '20000000-0000-4000-8000-000000000002';

/** Una fila de la lista: una reserva de hotel de una sucursal con la cancelación fallida. */
export function rowPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_1,
    tenantId: NODE_SUR,
    tenantName: 'Agencia Sur',
    tenantType: 'agency',
    isBranch: true,
    provider: 'tbo-hotels',
    vertical: 'hotels',
    providerOrderId: 'TBO-778',
    providerBookingRef: 'PT-1042-A',
    orderNumber: 1042,
    status: 'pending',
    subStatus: 'cancel-unverified',
    totalAmountMinor: 125_000_00,
    currency: 'COP',
    createdAt: '2026-10-10T16:48:00.000Z',
    updatedAt: '2026-10-12T15:00:00.000Z',
    sellerEmail: 'vende@sur.co',
    attention: { reason: 'cancel-failed', since: '2026-10-12T15:00:00.000Z' },
    ...over,
  };
}

/**
 * La ficha de una reserva de hotel que aquí figura confirmada y el proveedor tiene cancelada, con
 * la cancelación fallida y la retención en conflicto.
 */
export const DETAIL_PAYLOAD: Record<string, unknown> = {
  order: {
    id: ORDER_1,
    tenantId: NODE_SUR,
    userId: '30000000-0000-4000-8000-000000000001',
    quotationId: null,
    provider: 'tbo-hotels',
    pnr: 'TBO-778',
    providerBookingRef: 'PT-1042-A',
    status: 'confirmed',
    searchCriteria: {
      vertical: 'hotels',
      hotelId: '123',
      checkIn: '2026-11-02',
      checkOut: '2026-11-05',
    },
    selectedOffer: {},
    passengers: [
      { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT', room: 0 },
      { givenName: 'Luis', surname: 'Pérez', paxType: 'CHD', room: 0 },
    ],
    contactInfo: { email: 'ana@cliente.com', phone: '+57 300 1234567' },
    totalAmount: 125_000_00,
    currency: 'COP',
    orderNumber: 1042,
    errorMessage: null,
    providerTracking: {
      subStatus: null,
      providerStatus: 'Cancelled',
      providerStatusAt: '2026-10-12T14:00:00.000Z',
      providerStatusSource: 'reconciliation',
      refundAwaited: false,
      hotelConfirmationNumber: 'HCN-5521',
      hcnState: 'received',
    },
    createdAt: '2026-10-10T16:48:00.000Z',
    updatedAt: '2026-10-12T15:00:00.000Z',
  },
  tenant: {
    id: NODE_SUR,
    name: 'Agencia Sur',
    slug: 'agencia-sur',
    tenantType: 'agency',
    isBranch: true,
    status: 'active',
    path: [
      { id: PLATFORM_NODE, name: 'Planetour' },
      { id: NODE_SUR, name: 'Agencia Sur' },
    ],
  },
  seller: {
    id: '30000000-0000-4000-8000-000000000001',
    email: 'vende@sur.co',
    name: 'Vendedora Sur',
  },
  capabilities: { retrieve: true, cancel: true },
  operations: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      type: 'cancel',
      status: 'failed',
      attempts: 1,
      last_error: 'Timeout',
      created_at: '2026-10-12T14:30:00.000Z',
      retryable: true,
      outcome: 'FAILED',
      reconciliationRequired: false,
    },
  ],
  providerTracking: null,
  walletHold: {
    status: 'conflict',
    mode: 'enforce',
    currency: 'COP',
    saleAmountMinor: 125_000_00,
    credentialSource: 'root',
    createdAt: '2026-10-10T16:48:00.000Z',
    capturedAt: null,
    closedAt: null,
  },
  reconciliation: [
    { kind: 'R3', severity: 'warning', action: 'review', createdAt: '2026-10-12T14:00:00.000Z' },
  ],
  attention: [
    { reason: 'hold-conflict', since: '2026-10-12T14:00:00.000Z' },
    { reason: 'cancel-failed', since: '2026-10-12T14:30:00.000Z' },
  ],
  events: [
    {
      id: '50000000-0000-4000-8000-000000000003',
      occurredAt: '2026-10-12T15:10:00.000Z',
      eventType: 'platform.order.action',
      tenantId: NODE_SUR,
      actorUserId: '30000000-0000-4000-8000-0000000000ff',
      actorEmail: 'founder@planetour.cloud',
      payload: {
        action: 'retrieve',
        orderId: ORDER_1,
        reason: 'La agencia pidió revisar el estado',
        outcome: 'ok',
        result: { found: true, providerStatus: 'Cancelled' },
      },
    },
    {
      id: '50000000-0000-4000-8000-000000000002',
      occurredAt: '2026-10-12T14:30:00.000Z',
      eventType: 'OrderCancellationAttempted',
      tenantId: NODE_SUR,
      actorUserId: '30000000-0000-4000-8000-000000000001',
      actorEmail: 'vende@sur.co',
      payload: {},
    },
    {
      id: '50000000-0000-4000-8000-000000000001',
      occurredAt: '2026-10-10T16:48:00.000Z',
      eventType: 'OrderCreated',
      tenantId: NODE_SUR,
      actorUserId: null,
      actorEmail: null,
      payload: {},
    },
  ],
};
