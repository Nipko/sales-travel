import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AncillaryCatalog } from '@sales-travel/canonical';
import type { AncillaryAddResult, AncillaryRemoveResult } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type {
  BookingHoldPolicyService,
  HoldAdjuster,
} from '../portfolios/booking-hold-policy.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  ProviderDisabledByPlatformError,
  type ProviderCapabilities,
} from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { ORDER_EVENTS } from './order-events.js';
import { SERVICES_MESSAGES } from './order-services.plan.js';
import { FlightServicesService, ancillaryOrderRefOf } from './order-services.service.js';
import {
  ServicesClaimRefusedError,
  type OrderServicesStore,
  type ServiceLineRecord,
} from './order-services.store.js';
import type { OrderRow } from './orders.service.js';

/**
 * `FlightServicesService` sin base (SAB-20): las compuertas, los rechazos que no tocan nada y lo que
 * queda en el rastro. El dinero contra Postgres lo prueba `order-services.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const AIR = 'stub-air';

function fila(extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: 'ABC123',
    status: 'confirmed',
    search_criteria: {},
    selected_offer: { provider: { name: AIR, offerRef: 'R-1', source: 'ATPCO' } },
    passengers: [{ paxType: 'ADT', givenName: 'Ana', surname: 'Secreta' }],
    contact_info: {},
    total_amount: '100000' as unknown as number,
    currency: 'USD',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-10-13T00:00:00Z'),
    updated_at: new Date('2026-10-13T00:00:00Z'),
    ...extra,
  };
}

function catalogo(): AncillaryCatalog {
  return {
    segments: [
      {
        origin: 'BOG',
        destination: 'LIM',
        departureAt: '2099-09-10T09:00',
        carrier: 'AV',
        flightNumber: '123',
      },
    ],
    offers: [
      {
        serviceOfferItemId: 'BAG-1',
        category: 'BAGGAGE',
        name: 'Maleta 23 kg',
        serviceCode: '0C3',
        airlineCode: 'AV',
        segmentRefs: [0],
        passengers: [
          {
            passengerIndex: 0,
            charge: { type: 'PRICED', price: { amountMinor: 4500, currency: 'USD' } },
          },
        ],
        quantity: 1,
        weights: [],
        sellable: true,
      },
    ],
    warnings: ['ancillary-partial-unauthorized'],
  };
}

const ALTA = {
  selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0] }],
  expectedTotalMinor: 4500,
  currency: 'USD',
};

const LINEA: ServiceLineRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  addedOperationId: 'op-0',
  passengerIndex: 0,
  name: 'Maleta 23 kg',
  category: 'BAGGAGE',
  serviceCode: '0C3',
  segments: [],
  amountMinor: 4500,
  currency: 'USD',
  status: 'active',
  providerItemIds: ['XSECRETO1'],
  providerItemIdsShared: false,
};

function banco(
  o: {
    capabilities?: Partial<ProviderCapabilities>;
    apagado?: boolean;
    lines?: ServiceLineRecord[];
    blocking?: 'pending' | 'unverified' | null;
  } = {},
) {
  const factory = new StubProviderFactory({
    code: AIR,
    capabilities: { addServices: true, ...o.capabilities },
  });
  const registry = new FlightProviderRegistry([factory], {
    decisionFor: () =>
      Promise.resolve(o.apagado === true ? { enabled: false, origin: 'global' } : undefined),
  });
  const adapter = factory.adapterFor(TENANT);
  const listAncillaries = vi.fn(() => Promise.resolve(catalogo()));
  const addAncillaries = vi.fn(
    (): Promise<AncillaryAddResult> =>
      Promise.resolve({
        outcome: 'ADDED',
        added: [
          {
            serviceOfferItemId: 'BAG-1',
            passengerIndex: 0,
            providerItemIds: ['XSECRETO1'],
            providerItemIdsShared: false,
          },
        ],
        failed: [],
        unverified: [],
        issues: [],
      }),
  );
  const removeAncillaries = vi.fn(
    (): Promise<AncillaryRemoveResult> =>
      Promise.resolve({
        outcome: 'REMOVED',
        removed: ['XSECRETO1'],
        failed: [],
        unverified: [],
        issues: [],
      }),
  );
  Object.assign(adapter, { listAncillaries, addAncillaries, removeAncillaries });

  const store = {
    run: vi.fn((_tenant: string, fn: (trx: unknown) => Promise<unknown>) => fn({})),
    listLines: vi.fn(() => Promise.resolve(o.lines ?? [])),
    blocking: vi.fn(() => Promise.resolve(o.blocking ?? null)),
    claimWithin: vi.fn(() => Promise.resolve({ operationId: 'op-1', totalMinor: 100000 })),
    addToTotalWithin: vi.fn(() => Promise.resolve(104500)),
    insertLinesWithin: vi.fn(() => Promise.resolve()),
    markLinesWithin: vi.fn(() => Promise.resolve(1)),
    settleWithin: vi.fn(() => Promise.resolve(true)),
  };
  const adjust = vi.fn<HoldAdjuster>(() =>
    Promise.resolve({ outcome: 'adjusted' as const, deltaMinor: 4500, levels: 3 }),
  );
  const holds = {
    adjustOrderHold: vi.fn(
      (
        _tenant: string,
        _order: unknown,
        _dir: string,
        work: (trx: unknown, adjust: HoldAdjuster) => Promise<unknown>,
      ) => work({}, adjust),
    ),
  };
  const audit = new RecordingAuditService();
  const service = new FlightServicesService(
    store as unknown as OrderServicesStore,
    registry,
    holds as unknown as BookingHoldPolicyService,
    audit.asService(),
  );
  return {
    service,
    store,
    holds,
    adjust,
    audit,
    listAncillaries,
    addAncillaries,
    removeAncillaries,
  };
}

describe('la reserva como la entiende el puerto', () => {
  it('localizador, carril de la oferta y pasajeros por posición y tipo; nada del pasajero', () => {
    expect(ancillaryOrderRefOf(fila())).toEqual({
      orderId: 'ABC123',
      contentSource: 'ATPCO',
      passengers: [{ paxType: 'ADT' }],
    });
  });

  it('un pasajero sin tipo legible no se adivina: 400', () => {
    expect(() => ancillaryOrderRefOf(fila({ passengers: [{ givenName: 'Ana' }] }))).toThrow(
      BadRequestException,
    );
  });
});

describe('catalog — lo que se puede agregar y lo ya agregado', () => {
  it('sin ids del proveedor en lo que sale, y con el motivo si no se puede cambiar', async () => {
    const b = banco({ lines: [LINEA], blocking: 'unverified' });
    const view = await b.service.catalog(TENANT, fila());

    expect(view).toMatchObject({
      kind: 'ancillaries',
      currency: 'USD',
      orderTotalMinor: 100000,
      warnings: ['ancillary-partial-unauthorized'],
      blocked: SERVICES_MESSAGES.previousUnverified,
    });
    expect(view.offers[0]).toMatchObject({ addable: true, passengers: [{ amountMinor: 4500 }] });
    expect(view.added[0]).toMatchObject({ id: LINEA.id, removable: true, removalGroup: null });
    expect(JSON.stringify(view)).not.toContain('XSECRETO1');
  });

  it('una reserva emitida se ve, pero no se cambia', async () => {
    const view = await banco().service.catalog(TENANT, fila({ status: 'ticketed' }));
    expect(view.blocked).toBe(SERVICES_MESSAGES.notConfirmed);
  });

  it('sin la capacidad, 400 sin consultar al proveedor', async () => {
    const b = banco({ capabilities: { addServices: false } });
    await expect(b.service.catalog(TENANT, fila())).rejects.toBeInstanceOf(BadRequestException);
    expect(b.listAncillaries).not.toHaveBeenCalled();
  });
});

describe('requestAdd — lo que se rechaza antes de tocar nada', () => {
  it('con el proveedor apagado por la plataforma no se agrega: agregar es venta', async () => {
    const b = banco({ apagado: true });
    await expect(b.service.requestAdd(TENANT, fila(), USER, ALTA)).rejects.toBeInstanceOf(
      ProviderDisabledByPlatformError,
    );
    expect(b.store.claimWithin).not.toHaveBeenCalled();
  });

  it('en otra moneda que la reserva, 409', async () => {
    const b = banco();
    await expect(
      b.service.requestAdd(TENANT, fila(), USER, { ...ALTA, currency: 'COP' }),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.currencyChanged));
    expect(b.listAncillaries).not.toHaveBeenCalled();
  });

  it('si el catálogo de ahora da otro total, 409 y nada se reserva ni se retiene', async () => {
    const b = banco();
    await expect(
      b.service.requestAdd(TENANT, fila(), USER, { ...ALTA, expectedTotalMinor: 4000 }),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.priceChanged));
    expect(b.holds.adjustOrderHold).not.toHaveBeenCalled();
    expect(b.addAncillaries).not.toHaveBeenCalled();
  });

  it.each([
    ['already-pending', ConflictException, SERVICES_MESSAGES.alreadyPending],
    ['previous-unverified', ConflictException, SERVICES_MESSAGES.previousUnverified],
    ['not-confirmed', ConflictException, SERVICES_MESSAGES.notConfirmed],
    ['not-found', NotFoundException, SERVICES_MESSAGES.notFound],
  ] as const)('el claim rechazado (%s) no llama al proveedor', async (refusal, Type, message) => {
    const b = banco();
    b.store.claimWithin.mockRejectedValueOnce(new ServicesClaimRefusedError(refusal));
    await expect(b.service.requestAdd(TENANT, fila(), USER, ALTA)).rejects.toThrow(
      new Type(message),
    );
    expect(b.addAncillaries).not.toHaveBeenCalled();
  });

  it('el índice de 0083 (otra escritura que se coló) se lee como «ya hay un cambio en curso»', async () => {
    const b = banco();
    b.store.claimWithin.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_order_operations_pending_provider_write',
      }),
    );
    await expect(b.service.requestAdd(TENANT, fila(), USER, ALTA)).rejects.toThrow(
      new ConflictException(SERVICES_MESSAGES.alreadyPending),
    );
  });
});

describe('requestAdd — el desenlace', () => {
  it('ADDED: suma al total, retiene, guarda las líneas y lo cuenta sin datos del pasajero ni del proveedor', async () => {
    const b = banco();
    const reply = await b.service.requestAdd(TENANT, fila(), USER, ALTA);

    expect(reply).toEqual({
      outcome: 'ADDED',
      message: SERVICES_MESSAGES.added,
      operationId: 'op-1',
      addedMinor: 4500,
      failed: 0,
      unverified: 0,
    });
    expect(b.store.addToTotalWithin).toHaveBeenCalledWith({}, ORDER, 4500);
    expect(b.adjust).toHaveBeenCalledWith(USER, 'op-1');
    expect(b.addAncillaries).toHaveBeenCalledWith(
      { orderId: 'ABC123', contentSource: 'ATPCO', passengers: [{ paxType: 'ADT' }] },
      ALTA.selections,
      { tenantId: TENANT, requestId: 'op-1' },
    );
    expect(b.audit.types()).toEqual([ORDER_EVENTS.servicesRequested, ORDER_EVENTS.servicesAdded]);
    const dump = b.audit.dump();
    expect(dump).not.toContain('Secreta');
    expect(dump).not.toContain('XSECRETO1');
  });

  it('UNVERIFIED: nada se devuelve, se escala y se le dice al vendedor que no repita', async () => {
    const b = banco();
    b.addAncillaries.mockResolvedValueOnce({
      outcome: 'UNVERIFIED',
      added: [],
      failed: [],
      unverified: [{ serviceOfferItemId: 'BAG-1', passengerIndex: 0 }],
      issues: [{ severity: 'ERROR', category: 'INTERNAL', type: 'RESERVATION_SERVICE_FAILED' }],
    });

    const reply = await b.service.requestAdd(TENANT, fila(), USER, ALTA);

    expect(reply).toMatchObject({ outcome: 'UNVERIFIED', message: SERVICES_MESSAGES.unverified });
    // Sólo la retención del pedido; ninguna liberación.
    expect(b.adjust).toHaveBeenCalledTimes(1);
    expect(b.store.settleWithin).toHaveBeenCalledWith(
      {},
      'op-1',
      'failed',
      expect.objectContaining({
        outcome: 'UNVERIFIED',
        reconciliationRequired: true,
        retryForbidden: true,
        issueTypes: ['RESERVATION_SERVICE_FAILED'],
      }),
      SERVICES_MESSAGES.unverified,
    );
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'services-unverified',
    });
  });

  it('si el proveedor contestó y no se pudo guardar, se escala y se responde en duda', async () => {
    const b = banco();
    b.store.insertLinesWithin.mockRejectedValueOnce(new Error('base caída'));

    const reply = await b.service.requestAdd(TENANT, fila(), USER, ALTA);

    expect(reply.outcome).toBe('UNVERIFIED');
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'services-settle-failed',
    });
  });
});

describe('requestRemove', () => {
  const BAJA = { lineIds: [LINEA.id], expectedTotalMinor: 4500, currency: 'USD' };

  it('quita con los ids guardados, nunca con lo que mande la pantalla, y libera su parte', async () => {
    const b = banco({ lines: [LINEA] });
    const reply = await b.service.requestRemove(TENANT, fila(), USER, BAJA);

    expect(reply).toEqual({
      outcome: 'REMOVED',
      message: SERVICES_MESSAGES.removed,
      operationId: 'op-1',
      removedMinor: 4500,
    });
    expect(b.removeAncillaries).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ABC123' }),
      ['XSECRETO1'],
      { tenantId: TENANT, requestId: 'op-1' },
    );
    expect(b.store.addToTotalWithin).toHaveBeenCalledWith({}, ORDER, -4500);
    expect(b.adjust).toHaveBeenCalledWith(USER, 'op-1');
    expect(b.audit.first(ORDER_EVENTS.servicesRemoved)?.payload).toMatchObject({
      count: 1,
      totalMinor: 4500,
    });
  });

  it('rechazada por el proveedor: los servicios siguen, nada se libera y se puede volver a pedir', async () => {
    const b = banco({ lines: [LINEA] });
    b.removeAncillaries.mockResolvedValueOnce({
      outcome: 'FAILED',
      removed: [],
      failed: ['XSECRETO1'],
      unverified: [],
      issues: [],
    });

    const reply = await b.service.requestRemove(TENANT, fila(), USER, BAJA);

    expect(reply).toMatchObject({ outcome: 'FAILED', message: SERVICES_MESSAGES.removeFailed });
    expect(b.store.markLinesWithin).not.toHaveBeenCalled();
    expect(b.adjust).not.toHaveBeenCalled();
    expect(b.store.settleWithin).toHaveBeenCalledWith(
      {},
      'op-1',
      'failed',
      expect.objectContaining({ reconciliationRequired: false, retryForbidden: false }),
      SERVICES_MESSAGES.removeFailed,
    );
  });

  it('con otro total que el que vio el vendedor, 409 sin llamar a nadie', async () => {
    const b = banco({ lines: [LINEA] });
    await expect(
      b.service.requestRemove(TENANT, fila(), USER, { ...BAJA, expectedTotalMinor: 1 }),
    ).rejects.toThrow(new ConflictException(SERVICES_MESSAGES.totalChanged));
    expect(b.store.claimWithin).not.toHaveBeenCalled();
  });

  it('quitar sale aunque la plataforma haya apagado el proveedor: deshace lo vendido', async () => {
    const b = banco({ lines: [LINEA], apagado: true });
    await expect(b.service.requestRemove(TENANT, fila(), USER, BAJA)).resolves.toMatchObject({
      outcome: 'REMOVED',
    });
  });
});
