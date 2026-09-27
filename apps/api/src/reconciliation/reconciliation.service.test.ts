import { NotFoundException } from '@nestjs/common';
import type {
  HotelBookingDateRange,
  HotelBookingSummary,
  HotelBookingView,
  HotelBookingsByDatePort,
  HotelBookingsByDateResult,
  SearchContext,
} from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import type { TenantAdapter } from '../providers/provider.types.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  MemoryReconciliationBank,
  emptyTracking,
  type MemoryOrder,
} from './__fixtures__/memory-reconciliation.js';
import {
  RECONCILIATION_REQUESTED_EVENT,
  ReconciliationJobInvalidError,
  ReconciliationRunningError,
  ReconciliationService,
  reconciliationDayStart,
  reconciliationSweepDue,
} from './reconciliation.service.js';

/**
 * La conciliación por la puerta pública del servicio (docs/tbo/09 PR-5.5; 08 RF-28 CA; 04 §9;
 * D-TBO-24 A, D-TBO-27 A). El registry, el breaker y la cola que graba son los reales; la base, un
 * doble con la RLS por tenant (`memory-reconciliation.ts`); el proveedor, un stub que lista por
 * fecha y lee por localizador.
 *
 * La red es la del caso que motiva todo esto: un consolidador con una cuenta heredada por dos
 * agencias, y otro consolidador con su agencia, fuera de esa red.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const PROVEEDOR = 'hoteles-anon';

const CONSOLIDADOR = 'c0000000-0000-4000-8000-000000000001';
const AGENCIA_A = 'a0000000-0000-4000-8000-00000000000a';
const AGENCIA_B = 'b0000000-0000-4000-8000-00000000000b';
const OTRO = 'd0000000-0000-4000-8000-000000000002';
const AGENCIA_AJENA = 'e0000000-0000-4000-8000-00000000000e';
const CUENTA = '10000000-0000-4000-8000-000000000001';
const CUENTA_AJENA = '20000000-0000-4000-8000-000000000002';
const USUARIO = '30000000-0000-4000-8000-000000000003';
const OPERADOR = '40000000-0000-4000-8000-000000000004';

const PII = ['Xiomara', 'Quintanilla'];

/** Adapter con reservas por fecha: el stub más el puerto opcional de la conciliación. */
class ListadoPorFecha extends StubHotelAdapter implements HotelBookingsByDatePort {
  readonly maxBookingDateWindowDays = 60;
  filas: HotelBookingSummary[] = [];
  falla: Error | undefined;
  readonly listBookingsByDate = vi.fn(
    (range: HotelBookingDateRange, _ctx: SearchContext): Promise<HotelBookingsByDateResult> => {
      if (this.falla !== undefined) return Promise.reject(this.falla);
      return Promise.resolve({
        range,
        bookings: this.filas.filter(
          (f) => f.bookingDate >= range.from && f.bookingDate <= range.to,
        ),
      });
    },
  );
  /** Lo que devuelve la lectura por localizador. */
  lecturas = new Map<string, HotelBookingView>();

  constructor() {
    super(PROVEEDOR);
    this.getBooking.mockImplementation((locator: string) =>
      Promise.resolve(this.lecturas.get(locator) ?? { found: false, warnings: [] }),
    );
  }
}

class Proveedor extends StubHotelProviderFactory {
  readonly listado = new ListadoPorFecha();
  readonly cuentasResueltas: [string, string][] = [];

  constructor() {
    super({ code: PROVEEDOR });
  }

  resolveForAccount(
    owner: string,
    accountId: string,
  ): Promise<TenantAdapter<HotelProviderAdapter>> {
    this.cuentasResueltas.push([owner, accountId]);
    if (owner !== CONSOLIDADOR || accountId !== CUENTA) {
      return Promise.reject(new NotFoundException('no es una cuenta del tenant'));
    }
    return Promise.resolve({
      adapter: this.listado,
      credentialSource: 'own',
      accountOwnerTenantId: CONSOLIDADOR,
    });
  }

  resolveForOrder(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    if (![CONSOLIDADOR, AGENCIA_A, AGENCIA_B].includes(tenantId)) {
      return Promise.reject(new NotFoundException('fuera de la red'));
    }
    return Promise.resolve({ adapter: this.listado, credentialSource: 'inherited' });
  }
}

function vista(locator: string, extra: Partial<HotelBookingView> = {}): HotelBookingView {
  return {
    found: true,
    providerBookingId: locator,
    status: 'CONFIRMED',
    providerStatus: 'Confirmed',
    voucherIssued: true,
    warnings: [],
    ...extra,
  };
}

function fila(locator: string, extra: Partial<HotelBookingSummary> = {}): HotelBookingSummary {
  return {
    providerBookingId: locator,
    bookingDate: '2026-09-25',
    status: 'CONFIRMED',
    providerStatus: 'Confirmed',
    ...extra,
  };
}

let numero = 0;
function orden(extra: Partial<MemoryOrder> & Pick<MemoryOrder, 'tenantId'>): MemoryOrder {
  numero += 1;
  return {
    id: `orden-${numero}`,
    userId: USUARIO,
    provider: PROVEEDOR,
    status: 'confirmed',
    providerOrderId: `LOC${numero}`,
    bookingReference: `STTREF${String(numero).padStart(15, '0')}`,
    accountId: CUENTA,
    providerRawNull: false,
    createdAt: NOW - 2 * DAY,
    checkout: '2026-12-10',
    net: null,
    createRequestKey: null,
    guests: PII,
    ...extra,
  };
}

function banco(orders: MemoryOrder[], opts: { queueAccepts?: boolean } = {}) {
  const mem = new MemoryReconciliationBank(
    [
      { id: CONSOLIDADOR, parent: null },
      { id: AGENCIA_A, parent: CONSOLIDADOR },
      { id: AGENCIA_B, parent: CONSOLIDADOR },
      { id: OTRO, parent: null },
      { id: AGENCIA_AJENA, parent: OTRO },
    ],
    orders,
    [
      { id: CUENTA, tenantId: CONSOLIDADOR, providerCode: PROVEEDOR, active: true },
      { id: CUENTA_AJENA, tenantId: OTRO, providerCode: PROVEEDOR, active: true },
    ],
  );
  const proveedor = new Proveedor();
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService(opts.queueAccepts ?? true);
  const work = new InflightWorkRegistry();
  const service = new ReconciliationService(
    hotelRegistry([proveedor], hotelFlags(false)),
    mem.asCredentials(),
    mem.asStore(),
    mem.asTracking(),
    mem.asCancellations(),
    mem.asIntents(),
    mem.asHolds(),
    mem.asHcn(),
    new CircuitBreakerService(),
    audit.asService(),
    queue.asService(),
    work,
  );
  return { mem, proveedor, adapter: proveedor.listado, audit, queue, service, work };
}

function correr(
  b: ReturnType<typeof banco>,
  extra: { now?: number; rethrowTransient?: boolean } = {},
) {
  return b.service.reconcileAccount({
    ownerTenantId: CONSOLIDADOR,
    accountId: CUENTA,
    providerCode: PROVEEDOR,
    trigger: 'scheduled',
    now: extra.now ?? NOW,
    ...(extra.rethrowTransient === undefined ? {} : { rethrowTransient: extra.rethrowTransient }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('una corrida por cuenta: el listado nunca sale de la red del dueño sin pasar por sus órdenes (RNF-06; 06 §7.5)', () => {
  it('cada agencia recibe sólo lo de SUS órdenes; lo que no es de nadie, sólo el dueño', async () => {
    const deA = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA01' });
    const deB = orden({ tenantId: AGENCIA_B, status: 'cancelled', providerOrderId: 'LOCB01' });
    const ajena = orden({
      tenantId: AGENCIA_AJENA,
      accountId: CUENTA_AJENA,
      providerOrderId: 'LOCZ01',
    });
    const b = banco([deA, deB, ajena]);
    b.mem.tracking.set(
      deA.id,
      emptyTracking({ providerStatus: 'Confirmed', hcnState: 'scheduled' }),
    );
    b.mem.tracking.set(deB.id, emptyTracking({ providerStatus: 'Cancelled' }));
    b.adapter.filas = [
      fila('LOCA01', { status: 'CANCELLED', providerStatus: 'Cancelled' }),
      fila('LOCB01'),
      fila('EXT001', { bookingReference: 'PORTAL-1', agencyName: 'Otra agencia' }),
      // Una reserva de la otra red con el mismo localizador que una orden de esa red: nunca cruza.
      fila('LOCZ01'),
    ];
    b.adapter.lecturas.set(
      'LOCA01',
      vista('LOCA01', { status: 'CANCELLED', providerStatus: 'Cancelled' }),
    );
    b.adapter.lecturas.set('LOCB01', vista('LOCB01'));

    const report = await correr(b);

    expect(report).toMatchObject({ status: 'completed', rowsRead: 4, matched: 2 });
    // Sólo se consultaron las órdenes de la red del dueño, tenant por tenant.
    expect(new Set(b.mem.orderQueries)).toEqual(new Set([CONSOLIDADOR, AGENCIA_A, AGENCIA_B]));

    const porTenant = (tenantId: string) => b.audit.events.filter((e) => e.tenantId === tenantId);
    expect(JSON.stringify(porTenant(AGENCIA_A))).toContain('LOCA01');
    expect(JSON.stringify(porTenant(AGENCIA_A))).not.toMatch(
      /LOCB01|EXT001|LOCZ01|PORTAL-1|Otra agencia/,
    );
    expect(JSON.stringify(porTenant(AGENCIA_B))).toContain('LOCB01');
    expect(JSON.stringify(porTenant(AGENCIA_B))).not.toMatch(
      /LOCA01|EXT001|LOCZ01|PORTAL-1|Otra agencia/,
    );
    expect(porTenant(AGENCIA_AJENA)).toEqual([]);
    expect(porTenant(OTRO)).toEqual([]);

    // ProviderBookingUnmatched sólo al dueño de la cuenta, sobre la cuenta y no sobre una orden.
    const externas = b.audit.ofType(ORDER_EVENTS.providerBookingUnmatched);
    expect(externas.map((e) => e.tenantId)).toEqual([CONSOLIDADOR, CONSOLIDADOR]);
    expect(externas[0]).toMatchObject({
      aggregateType: 'provider_account',
      aggregateId: CUENTA,
      payload: expect.objectContaining({
        confirmationNumber: 'EXT001',
        accountId: CUENTA,
      }) as unknown,
    });
    // El nombre de la agencia es del reporte del dueño, no de un evento.
    expect(b.audit.dump()).not.toContain('Otra agencia');

    // Los ítems: cada uno en el tenant que lo puede ver.
    const items = b.mem.items.map((i) => [i.kind, i.tenantId]);
    expect(items).toEqual(
      expect.arrayContaining([
        ['R3', AGENCIA_A],
        ['R4', AGENCIA_B],
        ['R2', CONSOLIDADOR],
      ]),
    );
    expect(
      b.mem.items.find((i) => i.kind === 'R2' && i.providerBookingId === 'EXT001')?.details,
    ).toMatchObject({
      agencyName: 'Otra agencia',
    });
    expect(b.audit.dump()).not.toMatch(new RegExp(PII.join('|')));
  });

  it('la corrida se registra en el tenant del dueño, con sus ventanas y conteos', async () => {
    // Creada hace una hora: sólo el tramo A.
    const b = banco([orden({ tenantId: AGENCIA_A, createdAt: NOW - HOUR })]);

    await correr(b);

    expect(b.mem.runs).toEqual([
      expect.objectContaining({
        tenantId: CONSOLIDADOR,
        accountId: CUENTA,
        status: 'completed',
        windows: [{ from: '2026-09-24', to: '2026-09-26', leg: 'A' }],
      }),
    ]);
    expect(b.proveedor.cuentasResueltas).toEqual([[CONSOLIDADOR, CUENTA]]);
  });

  it('una cuenta que no es del dueño no se concilia: la corrida falla sin llamar al proveedor', async () => {
    const b = banco([]);
    const report = await b.service.reconcileAccount({
      ownerTenantId: AGENCIA_A,
      accountId: CUENTA,
      providerCode: PROVEEDOR,
      trigger: 'forced',
      now: NOW,
    });

    expect(report).toMatchObject({ status: 'failed', errorClass: 'ProviderNotAvailableError' });
    expect(b.adapter.listBookingsByDate).not.toHaveBeenCalled();
  });
});

describe('una respuesta que no vale no cambia nada (08 RF-28 CA)', () => {
  it('una fila fuera de la ventana invalida la corrida entera: ni un intent pasa a fallido', async () => {
    const intent = orden({
      tenantId: AGENCIA_A,
      status: 'pending',
      providerOrderId: null,
      providerRawNull: true,
      createdAt: NOW - 3 * DAY,
      createRequestKey: 'idem-1',
    });
    const b = banco([intent]);
    b.adapter.listBookingsByDate.mockImplementation((range) =>
      Promise.resolve({ range, bookings: [fila('X', { bookingDate: '2026-01-01' })] }),
    );

    const report = await correr(b);

    expect(report.status).toBe('invalid');
    expect(report.errorClass).toBe('ReconciliationWindowMismatchError');
    expect(b.mem.settles).toEqual([]);
    expect(b.mem.items).toEqual([]);
    expect(b.audit.events).toEqual([]);
    expect(b.mem.order(intent.id)).toMatchObject({ status: 'pending', createRequestKey: 'idem-1' });
    expect(b.mem.runs[0]).toMatchObject({ status: 'invalid' });
  });

  it('una ventana que el ACL rechazó (mapping) también: invalid y sin relanzar', async () => {
    const b = banco([]);
    const rechazo = new Error('fila fuera de ventana');
    rechazo.name = 'TboResponseMappingError';
    b.adapter.falla = rechazo;

    await expect(correr(b, { rethrowTransient: true })).resolves.toMatchObject({
      status: 'invalid',
    });
  });

  it('una respuesta de otra ventana que la pedida tampoco vale: ni un intent pasa a fallido', async () => {
    const prueba = orden({ tenantId: AGENCIA_B, providerOrderId: 'LOCOK2' });
    const intent = orden({
      tenantId: AGENCIA_A,
      status: 'pending',
      providerOrderId: null,
      providerRawNull: true,
      createdAt: Date.parse('2026-09-24T15:00:00Z'),
      createRequestKey: 'idem-otra-ventana',
    });
    const b = banco([prueba, intent]);
    b.adapter.listBookingsByDate.mockImplementation((range) =>
      Promise.resolve({
        range: { from: range.from, to: '2026-09-25' },
        bookings: [fila('LOCOK2', { bookingReference: prueba.bookingReference! })],
      }),
    );

    const report = await correr(b);

    expect(report).toMatchObject({
      status: 'invalid',
      errorClass: 'ReconciliationWindowMismatchError',
    });
    expect(b.mem.order(intent.id)).toMatchObject({
      status: 'pending',
      createRequestKey: 'idem-otra-ventana',
    });
    expect(b.audit.events).toEqual([]);
  });

  it('un fallo de transporte deja la corrida fallida y se relanza para que la cola la repita', async () => {
    const b = banco([]);
    const corte = Object.assign(new Error('socket hang up'), { retryable: true });
    b.adapter.falla = corte;

    await expect(correr(b, { rethrowTransient: true })).rejects.toBe(corte);
    expect(b.mem.runs[0]).toMatchObject({ status: 'failed' });

    // En el último intento (o desde el barrido) no se relanza.
    b.mem.runs.length = 0;
    await expect(correr(b)).resolves.toMatchObject({ status: 'failed' });
  });

  it('con otra corrida en curso para la cuenta no hace nada', async () => {
    const b = banco([]);
    b.mem.busy = true;

    await expect(correr(b)).resolves.toMatchObject({ status: 'busy' });
    expect(b.adapter.listBookingsByDate).not.toHaveBeenCalled();
  });
});

describe('R5: un intent incierto pasa a fallido SÓLO con evidencia fuerte (D-TBO-24 A)', () => {
  function red() {
    // Una confirmada de la misma cuenta: prueba que ClientReferenceNumber trae nuestra referencia.
    const prueba = orden({ tenantId: AGENCIA_B, providerOrderId: 'LOCOK1' });
    const intent = orden({
      tenantId: AGENCIA_A,
      status: 'pending',
      providerOrderId: null,
      providerRawNull: true,
      createdAt: Date.parse('2026-09-24T15:00:00Z'),
      createRequestKey: 'idem-intent',
    });
    const b = banco([prueba, intent]);
    b.mem.tracking.set(intent.id, emptyTracking({ subStatus: 'create-not-found-yet' }));
    b.adapter.filas = [fila('LOCOK1', { bookingReference: prueba.bookingReference! })];
    return { b, intent, prueba };
  }

  it('una respuesta válida que cubre su día de creación tampoco lo tiene: fallido, clave y retención liberadas', async () => {
    const { b, intent } = red();

    const report = await correr(b);

    expect(report.findings).toMatchObject({ R5: 1 });
    expect(b.mem.order(intent.id)).toMatchObject({ status: 'failed', createRequestKey: null });
    expect(b.mem.settles[0]).toMatchObject({
      tenantId: AGENCIA_A,
      outcome: {
        status: 'failed',
        providerRaw: expect.objectContaining({
          reason: 'not-found-by-reconciliation',
          closedBy: 'reconciliation',
        }) as unknown,
      },
    });
    expect(b.mem.trackingOf(intent.id).subStatus).toBeNull();
    expect(b.mem.holdsReleased).toEqual([
      { tenantId: AGENCIA_A, orderId: intent.id, as: 'failed' },
    ]);
    expect(b.audit.types()).toEqual([ORDER_EVENTS.created, ORDER_EVENTS.reconciliationDiscrepancy]);
    expect(b.audit.first(ORDER_EVENTS.reconciliationDiscrepancy)).toMatchObject({
      tenantId: AGENCIA_A,
      payload: expect.objectContaining({
        kind: 'R5',
        resolution: 'failed',
        // La evidencia: las ventanas que cubren el 23, el 24 y el 25.
        windows: ['2026-09-23/2026-09-26'],
      }) as unknown,
    });
    expect(b.mem.items).toEqual([
      expect.objectContaining({
        kind: 'R5',
        tenantId: AGENCIA_A,
        action: 'failed',
        orderId: intent.id,
      }),
    ]);
  });

  it('si el ítem no se puede registrar, la orden ya fallida igual avisa y libera la retención', async () => {
    const { b, intent } = red();
    b.mem.itemFailure = new Error('base caída');

    const report = await correr(b);

    expect(report.outcomes).toMatchObject({ failed: 1 });
    expect(b.mem.order(intent.id).status).toBe('failed');
    expect(b.mem.holdsReleased).toEqual([
      { tenantId: AGENCIA_A, orderId: intent.id, as: 'failed' },
    ]);
    expect(b.audit.types()).toEqual([ORDER_EVENTS.created, ORDER_EVENTS.reconciliationDiscrepancy]);
  });

  it('una fila con su referencia y el localizador repetido no es ausencia: sigue bloqueado', async () => {
    const { b, intent } = red();
    const suya = fila('NEW001', { bookingReference: intent.bookingReference! });
    b.adapter.filas.push(suya, { ...suya, bookingDate: '2026-09-24' });

    const report = await correr(b);

    expect(report.held).toEqual({ 'ambiguous-booking': 1 });
    expect(b.mem.order(intent.id)).toMatchObject({
      status: 'pending',
      createRequestKey: 'idem-intent',
    });
    expect(b.mem.holdsReleased).toEqual([]);
  });

  it('si la respuesta lo tiene, se recupera (R1) y nunca pasa a fallido', async () => {
    const { b, intent } = red();
    b.adapter.filas.push(fila('NEW001', { bookingReference: intent.bookingReference! }));
    b.adapter.lecturas.set(
      'NEW001',
      vista('NEW001', {
        bookingReference: intent.bookingReference!,
        hotelConfirmationNumber: 'HCN1',
      }),
    );

    const report = await correr(b);

    expect(report.outcomes).toMatchObject({ recovered: 1 });
    expect(b.mem.order(intent.id)).toMatchObject({
      status: 'confirmed',
      providerOrderId: 'NEW001',
    });
    expect(b.mem.settles[0]?.outcome).toMatchObject({
      status: 'confirmed',
      providerRaw: expect.objectContaining({ recoveredBy: 'reconciliation' }) as unknown,
    });
    expect(b.audit.first(ORDER_EVENTS.verified)).toMatchObject({
      tenantId: AGENCIA_A,
      payload: expect.objectContaining({
        recoveredBy: 'reconciliation',
        providerBookingId: 'NEW001',
      }) as unknown,
    });
    expect(b.mem.hcnScheduled).toEqual([{ tenantId: AGENCIA_A, orderId: intent.id }]);
    expect(b.mem.holdsReleased).toEqual([]);
  });

  it('una lectura que dice que la reserva es de otra referencia no consolida: una persona', async () => {
    const { b, intent } = red();
    b.adapter.filas.push(fila('NEW001', { bookingReference: intent.bookingReference! }));
    b.adapter.lecturas.set('NEW001', vista('NEW001', { bookingReference: 'OTRA-REF' }));

    const report = await correr(b);

    expect(report.outcomes).toMatchObject({ review: 1 });
    expect(b.mem.order(intent.id).status).toBe('pending');
    expect(b.audit.first(ORDER_EVENTS.escalated)).toMatchObject({
      payload: expect.objectContaining({ reason: 'verified-status-unexpected' }) as unknown,
    });
  });

  it('el propio intent estira el tramo B: su día de creación queda cubierto con un día a cada lado', async () => {
    const { b, intent } = red();
    // Creado hace 20 días: el tramo A solo no lo cubriría.
    b.mem.orders.splice(
      b.mem.orders.findIndex((o) => o.id === intent.id),
      1,
      { ...intent, createdAt: Date.parse('2026-09-06T23:30:00Z') },
    );

    const report = await correr(b);

    expect(report.windows).toEqual([{ from: '2026-09-05', to: '2026-09-26', leg: 'A' }]);
    expect(report.findings).toMatchObject({ R5: 1 });
  });

  it('sin evidencia de que ClientReferenceNumber es nuestra referencia, sigue bloqueado (PV-31)', async () => {
    const { b, intent } = red();
    b.adapter.filas = [];

    const report = await correr(b);

    expect(report.held).toEqual({ 'reference-unproven': 1 });
    expect(b.mem.order(intent.id)).toMatchObject({
      status: 'pending',
      createRequestKey: 'idem-intent',
    });
    expect(b.audit.events).toEqual([]);
  });

  it('con menos de 24 h, o con la verificación todavía buscándola, sigue bloqueado', async () => {
    const joven = red();
    joven.b.mem.orders.splice(
      joven.b.mem.orders.findIndex((o) => o.id === joven.intent.id),
      1,
      { ...joven.intent, createdAt: NOW - 3 * HOUR },
    );
    expect((await correr(joven.b)).held).toEqual({ 'too-recent': 1 });

    const buscando = red();
    buscando.b.mem.tracking.set(
      buscando.intent.id,
      emptyTracking({ subStatus: 'create-uncertain', verifyNextAt: NOW + HOUR }),
    );
    expect((await correr(buscando.b)).held).toEqual({ 'verification-running': 1 });
  });

  it('si otro camino la cerró mientras se leía el listado, se relee antes de escribir y no pisa nada', async () => {
    const { b, intent } = red();
    const listar = b.adapter.listBookingsByDate.getMockImplementation();
    b.adapter.listBookingsByDate.mockImplementation((range, ctx) => {
      // La verificación la consolida justo después de que la corrida juntó sus órdenes.
      Object.assign(b.mem.order(intent.id), {
        status: 'confirmed',
        providerRawNull: false,
        providerOrderId: 'VERIF1',
      });
      return listar!(range, ctx);
    });

    const report = await correr(b);

    expect(report.findings).toMatchObject({ R5: 1 });
    expect(report.outcomes).toMatchObject({ skipped: 1 });
    expect(b.mem.settles).toEqual([]);
    expect(b.mem.holdsReleased).toEqual([]);
    expect(b.audit.events).toEqual([]);
  });
});

describe('R3, R4 y R7 se confirman leyendo la reserva antes de tocar nada (PV-33)', () => {
  it('R3: cancelada fuera de la plataforma → cancelled, retención liberada, HCN cortado, aviso a la agencia', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA01' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Confirmed', hcnState: 'scheduled' }));
    b.adapter.filas = [fila('LOCA01', { status: 'CANCELLED', providerStatus: 'Cancelled' })];
    b.adapter.lecturas.set(
      'LOCA01',
      vista('LOCA01', { status: 'CANCELLED', providerStatus: 'Cancelled' }),
    );

    const report = await correr(b);

    expect(report.outcomes).toEqual({ cancelled: 1 });
    expect(b.mem.order(o.id).status).toBe('cancelled');
    expect(b.mem.trackingOf(o.id)).toMatchObject({
      providerStatus: 'Cancelled',
      providerStatusSource: 'reconciliation',
      hcnState: 'stopped',
    });
    expect(b.mem.holdsReleased).toEqual([{ tenantId: AGENCIA_A, orderId: o.id, as: 'cancelled' }]);
    expect(b.audit.types()).toEqual([
      ORDER_EVENTS.reconciliationDiscrepancy,
      ORDER_EVENTS.providerStatusChanged,
    ]);
    expect(b.audit.first(ORDER_EVENTS.reconciliationDiscrepancy)?.payload).toMatchObject({
      kind: 'R3',
      severity: 'warning',
      source: 'reconciliation',
      accountId: CUENTA,
      confirmationNumber: 'LOCA01',
    });
    expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
  });

  it('R3 en curso: la orden queda en "Cancelación en curso" y se agenda verify-cancellation', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA02' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Confirmed' }));
    b.adapter.filas = [fila('LOCA02', { status: 'CANCELLATION_IN_PROGRESS' })];
    b.adapter.lecturas.set(
      'LOCA02',
      vista('LOCA02', {
        status: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CxlRequestSentToHotel',
      }),
    );

    const report = await correr(b);

    expect(report.outcomes).toEqual({ 'cancellation-verifying': 1 });
    expect(b.mem.order(o.id).status).toBe('pending');
    expect(b.mem.trackingOf(o.id).cancelAnchorAt).toBe(NOW);
    expect(b.queue.cancelVerifications).toEqual([
      { tenantId: AGENCIA_A, orderId: o.id, step: 0, anchorAt: NOW },
    ]);
    expect(b.mem.holdsReleased).toEqual([]);
  });

  it('R3 que la lectura ve vigente: el listado traía un estado viejo y no se toca nada', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA03' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Confirmed' }));
    b.adapter.filas = [fila('LOCA03', { status: 'CANCELLED' })];
    b.adapter.lecturas.set('LOCA03', vista('LOCA03'));

    const report = await correr(b);

    expect(report.outcomes).toEqual({ unconfirmed: 1 });
    expect(b.mem.order(o.id).status).toBe('confirmed');
    expect(b.mem.items).toEqual([]);
    expect(b.audit.events).toEqual([]);
    // La lectura de confirmación sale por el cupo de fondo del proveedor (PV-41).
    expect(b.adapter.getBooking).toHaveBeenCalledWith(
      'LOCA03',
      { tenantId: AGENCIA_A, requestId: o.id },
      { purpose: 'background' },
    );
  });

  it('R4: nunca reenvía un Cancel; revisión urgente y un solo aviso aunque la ventana se repita', async () => {
    const o = orden({ tenantId: AGENCIA_B, status: 'cancelled', providerOrderId: 'LOCB01' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Cancelled' }));
    b.adapter.filas = [fila('LOCB01')];
    b.adapter.lecturas.set('LOCB01', vista('LOCB01'));

    await correr(b);
    await correr(b);

    expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.order(o.id).status).toBe('cancelled');
    expect(b.mem.items).toEqual([
      expect.objectContaining({
        kind: 'R4',
        severity: 'critical',
        action: 'review',
        tenantId: AGENCIA_B,
      }),
    ]);
    const r4 = b.audit.ofType(ORDER_EVENTS.reconciliationDiscrepancy);
    expect(r4).toHaveLength(1);
    expect(r4[0]?.payload).toMatchObject({ kind: 'R4', severity: 'critical' });
  });

  it('R7: un estado desconocido se guarda crudo y lo mira una persona, en la orden de su tenant', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA04' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Confirmed' }));
    b.adapter.filas = [fila('LOCA04', { status: 'UNKNOWN', providerStatus: 'OnHold' })];
    b.adapter.lecturas.set(
      'LOCA04',
      vista('LOCA04', { status: 'UNKNOWN', providerStatus: 'OnHold' }),
    );

    const report = await correr(b);

    expect(report.outcomes).toEqual({ review: 1 });
    expect(b.mem.trackingOf(o.id)).toMatchObject({
      providerStatus: 'OnHold',
      subStatus: 'unknown',
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'provider-status-unknown',
      providerStatus: 'unknown',
    });
  });

  it('R7: una orden confirmada que el proveedor informa PENDING o FAILED se escala y no se toca', async () => {
    for (const status of ['PENDING', 'FAILED'] as const) {
      const o = orden({ tenantId: AGENCIA_B, providerOrderId: `LOCB-${status}` });
      const b = banco([o]);
      b.mem.tracking.set(
        o.id,
        emptyTracking({ providerStatus: 'Confirmed', hcnState: 'scheduled' }),
      );
      b.adapter.filas = [fila(`LOCB-${status}`, { status, providerStatus: status })];
      b.adapter.lecturas.set(
        `LOCB-${status}`,
        vista(`LOCB-${status}`, { status, providerStatus: status }),
      );

      await correr(b);
      const repetida = await correr(b);

      // Nunca a ciegas: se lee, la orden sigue confirmada y con su retención, y nada sale al proveedor.
      expect(b.adapter.getBooking).toHaveBeenCalledWith(
        `LOCB-${status}`,
        { tenantId: AGENCIA_B, requestId: o.id },
        { purpose: 'background' },
      );
      expect(b.mem.order(o.id).status).toBe('confirmed');
      expect(b.mem.holdsReleased).toEqual([]);
      expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
      expect(b.mem.trackingOf(o.id)).toMatchObject({
        providerStatus: status,
        hcnState: 'scheduled',
      });
      expect(b.mem.items).toEqual([
        expect.objectContaining({
          kind: 'R7',
          severity: 'warning',
          action: 'review',
          orderId: o.id,
          tenantId: AGENCIA_B,
        }),
      ]);
      // Un solo aviso aunque la ventana se repita.
      expect(b.audit.types()).toEqual([ORDER_EVENTS.escalated]);
      expect(b.audit.first(ORDER_EVENTS.escalated)).toMatchObject({
        tenantId: AGENCIA_B,
        aggregateId: o.id,
        payload: expect.objectContaining({
          reason: 'verified-status-unexpected',
          source: 'reconciliation',
        }) as unknown,
      });
      expect(repetida.outcomes).toEqual({ review: 1 });
    }
  });

  it('R7 que la lectura ve confirmada: el listado traía un estado viejo y no se registra nada', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA07' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Confirmed' }));
    b.adapter.filas = [fila('LOCA07', { status: 'FAILED', providerStatus: 'FAILED' })];
    b.adapter.lecturas.set('LOCA07', vista('LOCA07'));

    const report = await correr(b);

    expect(report.outcomes).toEqual({ unconfirmed: 1 });
    expect(b.mem.order(o.id).status).toBe('confirmed');
    expect(b.mem.items).toEqual([]);
    expect(b.audit.events).toEqual([]);
  });

  it('el ítem dice lo que confirmó la lectura: un R7 del listado que se lee vivo sobre una orden cancelada es R4', async () => {
    const o = orden({ tenantId: AGENCIA_B, status: 'cancelled', providerOrderId: 'LOCB02' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: 'Cancelled' }));
    b.adapter.filas = [fila('LOCB02', { status: 'PENDING', providerStatus: 'PENDING' })];
    b.adapter.lecturas.set('LOCB02', vista('LOCB02'));

    const report = await correr(b);

    expect(report.findings).toEqual({ R7: 1 });
    expect(report.outcomes).toEqual({ review: 1 });
    expect(b.mem.order(o.id).status).toBe('cancelled');
    expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.items).toEqual([
      expect.objectContaining({ kind: 'R4', severity: 'critical', action: 'review' }),
    ]);
    expect(b.audit.first(ORDER_EVENTS.reconciliationDiscrepancy)?.payload).toMatchObject({
      kind: 'R4',
      severity: 'critical',
    });
  });

  it('una orden fallida que se lee viva es R4 crítico aunque el listado la traiga PENDING: un solo ítem para el mismo hecho', async () => {
    const o = orden({ tenantId: AGENCIA_A, status: 'failed', providerOrderId: 'LOCA08' });
    const b = banco([o]);
    b.mem.tracking.set(o.id, emptyTracking({ providerStatus: null }));
    b.adapter.lecturas.set('LOCA08', vista('LOCA08'));

    b.adapter.filas = [fila('LOCA08', { status: 'PENDING', providerStatus: 'PENDING' })];
    const pendiente = await correr(b);
    b.adapter.filas = [fila('LOCA08')];
    const confirmada = await correr(b);

    expect(pendiente.findings).toEqual({ R7: 1 });
    expect(confirmada.findings).toEqual({ R4: 1 });
    expect(b.mem.order(o.id).status).toBe('failed');
    expect(b.mem.holdsReleased).toEqual([]);
    expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.items).toEqual([
      expect.objectContaining({
        kind: 'R4',
        severity: 'critical',
        action: 'review',
        orderId: o.id,
      }),
    ]);
  });

  it('una lectura que no se puede hacer no cambia nada: la próxima corrida la reintenta', async () => {
    const o = orden({ tenantId: AGENCIA_A, providerOrderId: 'LOCA05' });
    const b = banco([o]);
    b.adapter.filas = [fila('LOCA05', { status: 'CANCELLED' })];
    b.adapter.getBooking.mockRejectedValueOnce(
      Object.assign(new Error('503'), { retryable: true }),
    );

    const report = await correr(b);

    expect(report.outcomes).toEqual({ unavailable: 1 });
    expect(b.mem.order(o.id).status).toBe('confirmed');
    expect(b.mem.items).toEqual([]);
  });

  it('una cancelación nuestra que el proveedor ya terminó se cierra sin ítem (y libera la retención)', async () => {
    const o = orden({ tenantId: AGENCIA_A, status: 'pending', providerOrderId: 'LOCA06' });
    const b = banco([o]);
    b.mem.tracking.set(
      o.id,
      emptyTracking({
        providerStatus: 'CancelPending',
        cancelAnchorAt: NOW - 30 * HOUR,
        cancelNextAt: NOW + 5 * HOUR,
      }),
    );
    b.adapter.filas = [fila('LOCA06', { status: 'CANCELLED', providerStatus: 'Cancelled' })];
    b.adapter.lecturas.set(
      'LOCA06',
      vista('LOCA06', { status: 'CANCELLED', providerStatus: 'Cancelled' }),
    );

    const report = await correr(b);

    expect(report.outcomes).toEqual({ settled: 1 });
    expect(report.discrepancies).toBe(0);
    expect(b.mem.order(o.id).status).toBe('cancelled');
    expect(b.mem.items).toEqual([]);
    expect(b.mem.holdsReleased).toEqual([{ tenantId: AGENCIA_A, orderId: o.id, as: 'cancelled' }]);
    // Cerrada, el paso que quedaba de la verificación de la cancelación ya no se ejecuta.
    expect(b.mem.trackingOf(o.id).cancelNextAt).toBeNull();
  });
});

describe('R6 y R8 sólo se registran', () => {
  it('R6: los montos quedan con el dueño de la cuenta; la agencia recibe el aviso sin montos', async () => {
    const o = orden({
      tenantId: AGENCIA_A,
      providerOrderId: 'LOCA07',
      net: { amountMinor: 50_000, currency: 'USD' },
    });
    const b = banco([o]);
    b.adapter.filas = [
      fila('LOCA07', {
        total: { amountMinor: 60_000, currency: 'USD' },
        agencyCommission: { amountMinor: 5_000, currency: 'USD' },
      }),
    ];

    const report = await correr(b);
    await correr(b);

    expect(report.outcomes).toEqual({ recorded: 1 });
    expect(b.mem.items).toEqual([
      expect.objectContaining({
        kind: 'R6',
        tenantId: CONSOLIDADOR,
        orderId: null,
        providerBookingId: 'LOCA07',
        details: expect.objectContaining({
          providerNet: { amountMinor: 55_000, currency: 'USD' },
          storedNet: { amountMinor: 50_000, currency: 'USD' },
        }) as unknown,
      }),
    ]);
    const avisos = b.audit.ofType(ORDER_EVENTS.reconciliationDiscrepancy);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      tenantId: AGENCIA_A,
      payload: expect.objectContaining({ kind: 'R6' }) as unknown,
    });
    expect(JSON.stringify(avisos[0]?.payload)).not.toMatch(/60000|55000|50000|5000/);
    expect(b.adapter.getBooking).not.toHaveBeenCalled();
  });

  it('R8: una cancelación nuestra atascada más de 72 h: aviso a la agencia y a revisión, sin tocar la orden', async () => {
    const o = orden({ tenantId: AGENCIA_A, status: 'pending', providerOrderId: 'LOCA08' });
    const b = banco([o]);
    b.mem.tracking.set(
      o.id,
      emptyTracking({ providerStatus: 'CxlRequestSentToHotel', cancelAnchorAt: NOW - 80 * HOUR }),
    );
    b.adapter.filas = [fila('LOCA08', { status: 'CANCELLATION_IN_PROGRESS' })];

    const report = await correr(b);

    expect(report.outcomes).toEqual({ review: 1 });
    expect(b.mem.order(o.id).status).toBe('pending');
    expect(b.mem.items).toEqual([expect.objectContaining({ kind: 'R8', tenantId: AGENCIA_A })]);
    expect(b.adapter.cancelBooking).not.toHaveBeenCalled();
  });
});

describe('disparos: planificador, barrido, botón y job', () => {
  it('el planificador diario encola una corrida por cuenta activa, con el día como turno', async () => {
    const b = banco([]);

    const report = await b.service.runDaily(NOW);

    expect(report).toEqual({ accounts: 2, queued: 2, ran: 0, failed: 0 });
    expect(b.queue.reconciliations).toEqual([
      expect.objectContaining({
        ownerTenantId: CONSOLIDADOR,
        accountId: CUENTA,
        trigger: 'scheduled',
        slot: '2026-09-26',
      }),
      expect.objectContaining({
        ownerTenantId: OTRO,
        accountId: CUENTA_AJENA,
        trigger: 'scheduled',
        slot: '2026-09-26',
      }),
    ]);
    expect(b.queue.jobs.every((j) => j.rejection === undefined)).toBe(true);
    expect(b.queue.jobs[0]?.jobId).toBe(`reconcile-provider-account:${CUENTA}:2026-09-26`);
  });

  it('sin cola, el planificador (o el barrido) corre la conciliación en este proceso', async () => {
    const b = banco([], { queueAccepts: false });

    const report = await b.service.runDaily(NOW);

    expect(report).toMatchObject({ accounts: 2, queued: 0 });
    expect(b.mem.runs.map((r) => r.status)).toEqual(['completed', 'failed']);
  });

  it('el barrido recupera la cuenta sin corrida del día, desde las 05:00 UTC y con un turno por hora', async () => {
    const b = banco([]);

    expect(
      await b.service.sweepTenant(CONSOLIDADOR, Date.parse('2026-09-26T04:45:00Z')),
    ).toMatchObject({
      accounts: 0,
    });
    const report = await b.service.sweepTenant(CONSOLIDADOR, Date.parse('2026-09-26T07:10:00Z'));

    expect(report).toEqual({ accounts: 1, queued: 1, ran: 0, failed: 0 });
    expect(b.queue.reconciliations).toEqual([
      expect.objectContaining({ accountId: CUENTA, trigger: 'sweep', slot: '2026-09-26T07' }),
    ]);
  });

  it('la decisión del barrido: una terminada, una viva, tres intentos o una hace menos de una hora bastan', () => {
    const t = Date.parse('2026-09-26T09:00:00Z');
    expect(reconciliationSweepDue([], t)).toBe(true);
    expect(reconciliationSweepDue([], Date.parse('2026-09-26T04:59:00Z'))).toBe(false);
    expect(reconciliationSweepDue([{ status: 'completed', startedAt: t - 3 * HOUR }], t)).toBe(
      false,
    );
    expect(reconciliationSweepDue([{ status: 'running', startedAt: t - 10 * 60_000 }], t)).toBe(
      false,
    );
    expect(reconciliationSweepDue([{ status: 'running', startedAt: t - 2 * HOUR }], t)).toBe(true);
    expect(reconciliationSweepDue([{ status: 'failed', startedAt: t - 30 * 60_000 }], t)).toBe(
      false,
    );
    expect(
      reconciliationSweepDue(
        [1, 2, 3].map((h) => ({ status: 'failed', startedAt: t - h * 2 * HOUR })),
        t,
      ),
    ).toBe(false);
    expect(reconciliationDayStart(t)).toBe(Date.parse('2026-09-26T04:30:00Z'));
    expect(reconciliationDayStart(Date.parse('2026-09-26T04:30:00Z'))).toBe(
      Date.parse('2026-09-26T04:30:00Z'),
    );
    // De madrugada, el día de conciliación todavía es el anterior: nunca un instante futuro.
    expect(reconciliationDayStart(Date.parse('2026-09-27T01:23:00Z'))).toBe(
      Date.parse('2026-09-26T04:30:00Z'),
    );
  });

  it('el job valida su payload y no repite una cuenta ya conciliada hoy (salvo el botón)', async () => {
    const b = banco([]);
    await expect(b.service.runJob({ accountId: 'x' }, { final: false })).rejects.toBeInstanceOf(
      ReconciliationJobInvalidError,
    );

    const job = {
      ownerTenantId: CONSOLIDADOR,
      accountId: CUENTA,
      providerCode: PROVEEDOR,
      trigger: 'scheduled' as const,
      slot: '2026-09-26',
    };
    await b.service.runJob(job, { final: false });
    await b.service.runJob(job, { final: false });
    expect(b.mem.runs).toHaveLength(1);

    await b.service.runJob(
      { ...job, trigger: 'forced', slot: 'm1', requestedBy: OPERADOR },
      { final: true },
    );
    expect(b.mem.runs).toHaveLength(2);
  });

  it('el botón: sólo una cuenta activa del tenant, nunca con otra corrida viva, encolado y auditado', async () => {
    vi.useFakeTimers({ now: NOW });
    const b = banco([]);

    await expect(b.service.force(AGENCIA_A, CUENTA, OPERADOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(b.service.force(CONSOLIDADOR, CUENTA_AJENA, OPERADOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const forzada = await b.service.force(CONSOLIDADOR, CUENTA, OPERADOR);

    expect(forzada).toEqual({ accountId: CUENTA, providerCode: PROVEEDOR, queued: true });
    expect(b.queue.reconciliations).toEqual([
      expect.objectContaining({
        trigger: 'forced',
        requestedBy: OPERADOR,
        slot: `m${Math.floor(NOW / 60_000)}`,
      }),
    ]);
    expect(b.audit.first(RECONCILIATION_REQUESTED_EVENT)).toMatchObject({
      tenantId: CONSOLIDADOR,
      actorUserId: OPERADOR,
      aggregateType: 'provider_account',
      aggregateId: CUENTA,
    });

    b.mem.runs.push({
      id: 'viva',
      tenantId: CONSOLIDADOR,
      accountId: CUENTA,
      trigger: 'scheduled',
      status: 'running',
      windows: [],
      rowsRead: 0,
      rowsMatched: 0,
      discrepancies: 0,
      summary: {},
      errorClass: null,
      startedAt: new Date(NOW - 60_000),
      finishedAt: null,
    });
    await expect(b.service.force(CONSOLIDADOR, CUENTA, OPERADOR)).rejects.toBeInstanceOf(
      ReconciliationRunningError,
    );
  });

  it('el botón sin cola corre la conciliación en segundo plano, registrada como trabajo en vuelo', async () => {
    const b = banco([], { queueAccepts: false });

    await expect(b.service.force(CONSOLIDADOR, CUENTA, OPERADOR)).resolves.toMatchObject({
      queued: false,
    });
    await b.work.whenIdle();

    expect(b.mem.runs).toEqual([
      expect.objectContaining({ trigger: 'forced', status: 'completed' }),
    ]);
  });

  it('el reporte del dueño trae sus corridas y sólo los ítems que él puede ver', async () => {
    const o = orden({ tenantId: AGENCIA_A, status: 'cancelled', providerOrderId: 'LOCA09' });
    const b = banco([o]);
    b.adapter.filas = [fila('LOCA09'), fila('EXT009')];
    b.adapter.lecturas.set('LOCA09', vista('LOCA09'));
    await correr(b);

    const report = await b.service.report(CONSOLIDADOR, CUENTA);

    expect(report.runs).toHaveLength(1);
    expect(report.items.map((i) => i.kind)).toEqual(['R2']);
  });
});
