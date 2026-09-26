import { NotFoundException } from '@nestjs/common';
import type { HotelBookingView, SearchContext } from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { OrderStatus } from '../database/database.types.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import {
  ProviderOrderAccountUnavailableError,
  type TenantAdapter,
} from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  HotelOrderReadsService,
  hotelOrderCapabilities,
  publicHotelOrderTracking,
} from './hotel-order-reads.service.js';
import type {
  HotelOrderReadTarget,
  HotelOrderReadWrite,
  HotelOrderTrackingRow,
  HotelOrderTrackingStore,
} from './hotel-order-tracking.store.js';
import { ORDER_EVENTS } from './order-events.js';

/**
 * La consulta manual de una orden de hotel por la puerta pública del servicio (docs/tbo/09 PR-5.2;
 * 08 RF-24, RF-26, RF-29).
 *
 * El registry es el REAL, con un proveedor anónimo que sabe resolver la cuenta de una orden; el
 * almacén es un doble con la regla de la RLS (una orden sólo existe para su tenant); el breaker es
 * el real, para que el alcance de post-venta se pruebe con el kill-switch de verdad.
 */

const PROVEEDOR = 'hoteles-anon';
const AGENCIA_A = '11111111-1111-4111-8111-111111111111';
const AGENCIA_B = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '33333333-3333-4333-8333-333333333333';
const USUARIO = '44444444-4444-4444-8444-444444444444';
const ORDEN_A = '55555555-5555-4555-8555-555555555555';
const CUENTA_VIEJA = '66666666-6666-4666-8666-666666666666';

interface OrdenSembrada {
  readonly tenantId: string;
  readonly status?: OrderStatus;
  readonly providerOrderId?: string | null;
  readonly providerAccountId?: string | null;
  readonly tracking?: Partial<HotelOrderTrackingRow> & { voucherStatus?: string | null };
}

/** El almacén con la regla de la RLS: lo que no es del tenant, no existe. */
function almacen(ordenes: Record<string, OrdenSembrada>) {
  const tracking = new Map<string, HotelOrderTrackingRow & { voucherStatus: string | null }>();
  for (const [id, o] of Object.entries(ordenes)) {
    if (o.tracking === undefined) continue;
    tracking.set(id, {
      orderId: id,
      subStatus: null,
      providerStatus: null,
      providerStatusAt: null,
      providerStatusSource: null,
      refundAwaited: false,
      hcn: null,
      hcnState: null,
      voucherStatus: null,
      ...o.tracking,
    });
  }
  const escrituras: { tenantId: string; orderId: string; write: HotelOrderReadWrite }[] = [];

  const store = {
    findReadTarget: vi.fn((tenantId: string, orderId: string) => {
      const o = ordenes[orderId];
      if (o === undefined || o.tenantId !== tenantId) return Promise.resolve(undefined);
      const t = tracking.get(orderId);
      const target: HotelOrderReadTarget = {
        orderId,
        provider: PROVEEDOR,
        userId: USUARIO,
        status: o.status ?? 'confirmed',
        providerOrderId: o.providerOrderId === undefined ? 'LOC-1' : o.providerOrderId,
        providerAccountId: o.providerAccountId === undefined ? CUENTA_VIEJA : o.providerAccountId,
        bookingReference: 'STTABC',
        snapshot: {
          status: o.status ?? 'confirmed',
          subStatus: t?.subStatus ?? null,
          providerStatus: t?.providerStatus ?? null,
          voucherStatus: t?.voucherStatus ?? null,
          refundAwaited: t?.refundAwaited ?? false,
          hcn: t?.hcn ?? null,
          hcnState: t?.hcnState ?? null,
        },
      };
      return Promise.resolve(target);
    }),
    recordRead: vi.fn((tenantId: string, orderId: string, write: HotelOrderReadWrite) => {
      if (ordenes[orderId]?.tenantId !== tenantId) {
        return Promise.reject(new Error('RLS: la fila no es del tenant'));
      }
      const actual = tracking.get(orderId);
      // El CAS del almacén real: si la fila cambió desde la foto, la lectura no se registra.
      if (
        actual !== undefined &&
        (actual.subStatus !== write.expected.subStatus ||
          actual.providerStatus !== write.expected.providerStatus ||
          actual.hcn !== write.expected.hcn ||
          actual.hcnState !== write.expected.hcnState)
      ) {
        return Promise.resolve(false);
      }
      escrituras.push({ tenantId, orderId, write });
      const t = actual ?? {
        orderId,
        subStatus: null,
        providerStatus: null,
        providerStatusAt: null,
        providerStatusSource: null,
        refundAwaited: false,
        hcn: null,
        hcnState: null,
        voucherStatus: null,
      };
      tracking.set(orderId, {
        ...t,
        ...(write.record === undefined
          ? {}
          : {
              providerStatus: write.record.providerStatus,
              providerStatusAt: new Date(write.at),
              providerStatusSource: write.source,
              refundAwaited: write.record.refundAwaited,
            }),
        ...(write.subStatus === undefined ? {} : { subStatus: write.subStatus }),
        ...(write.hcn === undefined
          ? {}
          : { hcn: write.hcn.hcn, ...(write.hcn.markReceived ? { hcnState: 'received' } : {}) }),
      });
      return Promise.resolve(true);
    }),
    listTracking: vi.fn((tenantId: string, ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids
            .filter((id) => ordenes[id]?.tenantId === tenantId && tracking.has(id))
            .map((id) => [id, tracking.get(id)!]),
        ),
      ),
    ),
  };
  return { store: store as unknown as HotelOrderTrackingStore, spies: store, escrituras, tracking };
}

/**
 * Proveedor que resuelve la cuenta VIGENTE del tenant con un adapter y la de UNA ORDEN con otro:
 * así se ve con cuál salió cada lectura.
 */
class ProveedorConCuentas extends StubHotelProviderFactory {
  readonly vigente = new StubHotelAdapter(PROVEEDOR);
  readonly deLaOrden = new StubHotelAdapter(PROVEEDOR);
  readonly ordenesResueltas: [string, string][] = [];

  constructor(
    private readonly ordenImpl: (tenantId: string, orderId: string) => Promise<void> = () =>
      Promise.resolve(),
  ) {
    super({ code: PROVEEDOR, capabilities: { retrieve: true, cancel: true } });
  }

  override resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    this.resolveCalls.push(tenantId);
    return Promise.resolve({ adapter: this.vigente, credentialSource: 'own' });
  }

  async resolveForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<TenantAdapter<HotelProviderAdapter>> {
    this.ordenesResueltas.push([tenantId, orderId]);
    await this.ordenImpl(tenantId, orderId);
    return {
      adapter: this.deLaOrden,
      credentialSource: 'inherited',
      accountOwnerTenantId: CONSOLIDADOR,
    };
  }
}

function lectura(view: Partial<HotelBookingView> & { found?: boolean }): HotelBookingView {
  return {
    found: true,
    providerBookingId: 'LOC-1',
    status: 'CONFIRMED',
    providerStatus: 'Confirmed',
    warnings: [],
    ...view,
  };
}

function banco(
  ordenes: Record<string, OrdenSembrada>,
  opciones: {
    read?: HotelBookingView;
    factory?: ProveedorConCuentas;
  } = {},
) {
  const factory = opciones.factory ?? new ProveedorConCuentas();
  factory.deLaOrden.getBooking.mockImplementation((_id: string, _ctx: SearchContext) =>
    Promise.resolve(opciones.read ?? lectura({})),
  );
  const a = almacen(ordenes);
  const audit = new RecordingAuditService();
  const service = new HotelOrderReadsService(
    hotelRegistry([factory], hotelFlags(false)),
    a.store,
    new CircuitBreakerService(),
    audit.asService(),
  );
  return { service, factory, audit, ...a };
}

afterEach(() => {
  delete process.env['PROVIDERS_DISABLED'];
});

describe('consulta manual de una orden de hotel', () => {
  it('sale con la cuenta que hizo la reserva, no con la vigente del tenant (RF-29 CA 1)', async () => {
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A } });

    const result = await b.service.retrieve(AGENCIA_A, ORDEN_A, USUARIO);

    expect(b.factory.ordenesResueltas).toEqual([[AGENCIA_A, ORDEN_A]]);
    expect(b.factory.resolveCalls).toEqual([]);
    expect(b.factory.vigente.getBooking).not.toHaveBeenCalled();
    expect(b.factory.deLaOrden.getBooking).toHaveBeenCalledWith('LOC-1', {
      tenantId: AGENCIA_A,
      requestId: ORDEN_A,
    });
    expect(result).toMatchObject({ vertical: 'hotels', orderId: ORDEN_A, found: true });
  });

  it('una orden sin cuenta guardada (anterior a 0042) sale con la vigente, como antes', async () => {
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A, providerAccountId: null } });

    await b.service.retrieve(AGENCIA_A, ORDEN_A);

    expect(b.factory.ordenesResueltas).toEqual([]);
    expect(b.factory.vigente.getBooking).toHaveBeenCalledTimes(1);
  });

  it('la agencia B no lee la orden de la A aunque compartan la cuenta: 404 y nada sale al proveedor (RF-29 CA 3)', async () => {
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A } });

    await expect(b.service.retrieve(AGENCIA_B, ORDEN_A)).rejects.toBeInstanceOf(NotFoundException);

    expect(b.factory.ordenesResueltas).toEqual([]);
    expect(b.factory.resolveCalls).toEqual([]);
    expect(b.factory.deLaOrden.getBooking).not.toHaveBeenCalled();
    expect(b.escrituras).toEqual([]);
    expect(b.audit.events).toEqual([]);
    expect(await b.service.trackingOf(AGENCIA_B, [ORDEN_A])).toEqual(new Map());
  });

  it('una orden sin localizador no se consulta', async () => {
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A, providerOrderId: null } });
    await expect(b.service.retrieve(AGENCIA_A, ORDEN_A)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.factory.ordenesResueltas).toEqual([]);
  });

  it('si la cuenta de la reserva salió de la red, 409 propio y no cae a la vigente', async () => {
    const factory = new ProveedorConCuentas(() =>
      Promise.reject(new NotFoundException('fuera de la red')),
    );
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A } }, { factory });

    const error = await b.service.retrieve(AGENCIA_A, ORDEN_A).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderOrderAccountUnavailableError);
    expect((error as ProviderOrderAccountUnavailableError).getStatus()).toBe(409);
    expect(factory.vigente.getBooking).not.toHaveBeenCalled();
    expect(factory.deLaOrden.getBooking).not.toHaveBeenCalled();
  });

  it('registra la lectura en el seguimiento y emite el cambio de estado, con la fuente', async () => {
    const b = banco(
      { [ORDEN_A]: { tenantId: AGENCIA_A, tracking: { providerStatus: 'Confirmed' } } },
      {
        read: lectura({
          providerStatus: 'Vouchered',
          voucherIssued: true,
          hotelConfirmationNumber: 'HCN-9',
        }),
      },
    );

    const result = await b.service.retrieve(AGENCIA_A, ORDEN_A, USUARIO);

    expect(b.escrituras).toEqual([
      {
        tenantId: AGENCIA_A,
        orderId: ORDEN_A,
        write: expect.objectContaining({
          source: 'retrieve',
          record: { providerStatus: 'Vouchered', voucherStatus: 'true', refundAwaited: false },
          hcn: { hcn: 'HCN-9', markReceived: true },
        }) as unknown,
      },
    ]);
    expect(b.audit.types()).toEqual([
      ORDER_EVENTS.providerStatusChanged,
      ORDER_EVENTS.hotelConfirmationNumberReceived,
    ]);
    expect(b.audit.first(ORDER_EVENTS.providerStatusChanged)).toMatchObject({
      tenantId: AGENCIA_A,
      actorUserId: USUARIO,
      aggregateType: 'order',
      aggregateId: ORDEN_A,
      payload: {
        provider: PROVEEDOR,
        vertical: 'hotels',
        source: 'retrieve',
        previous: 'Confirmed',
        current: 'Vouchered',
      },
    });
    expect(b.audit.first(ORDER_EVENTS.hotelConfirmationNumberReceived)?.payload).toMatchObject({
      hcn: 'HCN-9',
      confirmationNumber: 'LOC-1',
    });
    expect(result.tracking).toMatchObject({
      providerStatus: 'Vouchered',
      providerStatusSource: 'retrieve',
      hotelConfirmationNumber: 'HCN-9',
      hcnState: 'received',
    });
  });

  it('un estado desconocido escala sin cambiar el estado, y el valor crudo no sale de la fila (RF-26 CA)', async () => {
    const b = banco(
      { [ORDEN_A]: { tenantId: AGENCIA_A, tracking: { providerStatus: 'Confirmed' } } },
      {
        read: lectura({
          status: 'UNKNOWN',
          providerStatus: 'On_Request',
          warnings: ['BOOKING_STATUS_UNKNOWN'],
        }),
      },
    );

    const result = await b.service.retrieve(AGENCIA_A, ORDEN_A);

    expect(b.escrituras[0]?.write).toMatchObject({
      record: { providerStatus: 'On_Request' },
      subStatus: 'unknown',
    });
    expect(b.audit.types()).toEqual([ORDER_EVENTS.escalated]);
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'provider-status-unknown',
      providerStatus: 'unknown',
    });
    expect(b.audit.dump()).not.toContain('On_Request');
    expect(result.providerStatus).toBe('unknown');
    expect(result.tracking).toMatchObject({ subStatus: 'unknown', providerStatus: 'unknown' });
  });

  it('la ve cancelada desde el portal: avisa con la cuenta, y la orden sigue como estaba hasta la conciliación', async () => {
    const b = banco(
      { [ORDEN_A]: { tenantId: AGENCIA_A, tracking: { providerStatus: 'Confirmed' } } },
      { read: lectura({ status: 'CANCELLED', providerStatus: 'Cancelled' }) },
    );

    await b.service.retrieve(AGENCIA_A, ORDEN_A);

    // El almacén no tiene cómo escribir `orders.status`: sólo la fila de seguimiento.
    expect(b.escrituras.map((e) => e.write.subStatus)).toEqual([undefined]);
    expect(b.audit.first(ORDER_EVENTS.reconciliationDiscrepancy)?.payload).toMatchObject({
      kind: 'R3',
      severity: 'warning',
      accountId: CUENTA_VIEJA,
      confirmationNumber: 'LOC-1',
      source: 'retrieve',
    });
  });

  it('"no la encuentro" no escribe estado: sólo se escala si la orden dice confirmada', async () => {
    const b = banco(
      { [ORDEN_A]: { tenantId: AGENCIA_A, tracking: { providerStatus: 'Confirmed' } } },
      { read: { found: false, warnings: [] } },
    );

    const result = await b.service.retrieve(AGENCIA_A, ORDEN_A);

    expect(b.escrituras).toEqual([]);
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'verified-not-found',
    });
    expect(result).toMatchObject({ found: false, tracking: { providerStatus: 'Confirmed' } });
  });

  it('una lectura que llega tarde no pisa lo que otro camino escribió mientras tanto, ni avisa', async () => {
    const b = banco(
      { [ORDEN_A]: { tenantId: AGENCIA_A, tracking: { providerStatus: 'Confirmed' } } },
      { read: lectura({ status: 'CANCELLED', providerStatus: 'Cancelled' }) },
    );
    // Mientras el proveedor contesta, la cancelación toma el claim sobre la misma fila.
    b.factory.deLaOrden.getBooking.mockImplementation(() => {
      const fila = b.tracking.get(ORDEN_A)!;
      b.tracking.set(ORDEN_A, { ...fila, subStatus: 'cancel-requested' });
      return Promise.resolve(lectura({ status: 'CANCELLED', providerStatus: 'Cancelled' }));
    });

    const result = await b.service.retrieve(AGENCIA_A, ORDEN_A);

    expect(b.spies.recordRead).toHaveBeenCalledTimes(1);
    expect(b.escrituras).toEqual([]);
    expect(b.tracking.get(ORDEN_A)).toMatchObject({
      subStatus: 'cancel-requested',
      providerStatus: 'Confirmed',
    });
    // El R3 que decidió con la foto vieja sería falso: la orden ya está en manos de la cancelación.
    expect(b.audit.events).toEqual([]);
    expect(result).toMatchObject({ found: true, tracking: { subStatus: 'cancel-requested' } });
  });

  it('la escritura lleva la foto sobre la que se decidió', async () => {
    const b = banco({
      [ORDEN_A]: {
        tenantId: AGENCIA_A,
        tracking: { providerStatus: 'Confirmed', hcn: 'HCN-1', hcnState: 'received' },
      },
    });

    await b.service.retrieve(AGENCIA_A, ORDEN_A);

    expect(b.spies.recordRead).toHaveBeenCalledWith(
      AGENCIA_A,
      ORDEN_A,
      expect.objectContaining({
        expected: {
          subStatus: null,
          providerStatus: 'Confirmed',
          hcn: 'HCN-1',
          hcnState: 'received',
        },
      }),
    );
  });

  it('con las ventas apagadas por kill-switch, la consulta sale igual: es post-venta', async () => {
    process.env['PROVIDERS_DISABLED'] = `${PROVEEDOR}:ventas`;
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A } });

    await expect(b.service.retrieve(AGENCIA_A, ORDEN_A)).resolves.toMatchObject({ found: true });
    expect(b.factory.deLaOrden.getBooking).toHaveBeenCalledTimes(1);
  });

  it('con el proveedor apagado del todo, no sale y lo dice el breaker', async () => {
    process.env['PROVIDERS_DISABLED'] = PROVEEDOR;
    const b = banco({ [ORDEN_A]: { tenantId: AGENCIA_A } });

    await expect(b.service.retrieve(AGENCIA_A, ORDEN_A)).rejects.toMatchObject({
      sentToProvider: false,
    });
    expect(b.factory.deLaOrden.getBooking).not.toHaveBeenCalled();
    expect(b.escrituras).toEqual([]);
  });
});

describe('lo que el controlador de órdenes expone de una orden de hotel', () => {
  it('ofrece la consulta y la cancelación que declare el proveedor, que enruta por hoteles (PR-5.3)', () => {
    expect(
      hotelOrderCapabilities({
        retrieve: true,
        cancel: true,
        retrieveByClientReference: true,
        reconcileByDate: false,
      }),
    ).toEqual({ retrieve: true, cancel: true, pay: false, services: false, reshop: false });
    expect(
      hotelOrderCapabilities({
        retrieve: false,
        cancel: false,
        retrieveByClientReference: false,
        reconcileByDate: false,
      }),
    ).toEqual({ retrieve: false, cancel: false, pay: false, services: false, reshop: false });
  });

  it('reconoce sólo proveedores de hoteles registrados', () => {
    const b = banco({});
    expect(b.service.handles(PROVEEDOR)).toBe(true);
    expect(b.service.handles('un-proveedor-de-vuelos')).toBe(false);
    expect(b.service.capabilitiesOf('un-proveedor-de-vuelos')).toBeUndefined();
  });

  it('el seguimiento público lleva códigos y localizadores; un estado raro sale como unknown', () => {
    const fila: HotelOrderTrackingRow = {
      orderId: ORDEN_A,
      subStatus: null,
      providerStatus: 'CxlRequestSentToHotel',
      providerStatusAt: new Date('2026-09-26T10:00:00Z'),
      providerStatusSource: 'cancel',
      refundAwaited: false,
      hcn: 'HCN-1',
      hcnState: 'received',
    };
    expect(publicHotelOrderTracking(fila)).toEqual({
      subStatus: null,
      providerStatus: 'CxlRequestSentToHotel',
      providerStatusAt: '2026-09-26T10:00:00.000Z',
      providerStatusSource: 'cancel',
      refundAwaited: false,
      hotelConfirmationNumber: 'HCN-1',
      hcnState: 'received',
    });
    expect(
      publicHotelOrderTracking({ ...fila, subStatus: 'unknown', providerStatus: 'On_Request' })
        .providerStatus,
    ).toBe('unknown');
    // Algo con forma de texto libre no sale aunque nadie lo haya marcado como desconocido.
    expect(publicHotelOrderTracking({ ...fila, providerStatus: 'Juan Pérez' }).providerStatus).toBe(
      'unknown',
    );
  });
});
