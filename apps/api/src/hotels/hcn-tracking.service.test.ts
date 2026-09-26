import { NotFoundException } from '@nestjs/common';
import type { HotelBookingView } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelProviderAdapter,
  HotelProviderCapabilities,
} from '../providers/hotel-provider.types.js';
import {
  ProviderOrderAccountUnavailableError,
  type TenantAdapter,
} from '../providers/provider.types.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import {
  MemoryHcnTracking,
  emptyHcnRow,
  type MemoryHcnOrder,
  type MemoryHcnRow,
} from './__fixtures__/memory-hcn-tracking.js';
import { HCN_CHECK_GRACE_MS, HCN_READS } from './hcn-plan.js';
import {
  HCN_ENQUEUE_WAIT_MS,
  HcnCheckJobInvalidError,
  HcnTrackingService,
} from './hcn-tracking.service.js';
import type { HcnTarget } from './hcn-tracking.store.js';

/**
 * El seguimiento del HCN por la puerta pública del servicio (docs/tbo/09 PR-5.4; 08 RF-27 CA; 04
 * §8.5 y §8.6). El registry, el breaker y la cola que graba son los reales; la base, un doble con
 * RLS por tenant y los CAS del plan. El reloj es falso: lo que se afirma es CUÁNDO sale cada lectura.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '44444444-4444-4444-8444-444444444444';
const USER = '22222222-2222-4222-8222-222222222222';
const CUENTA = '33333333-3333-4333-8333-333333333333';
const PROVEEDOR = 'hoteles-anon';
const ORDEN = 'h1';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Reserva el 2026-10-01 10:00 UTC con entrada el 2026-10-04 (00:00 UTC sin zona): W = 62 h, P2. */
const RESERVA = Date.parse('2026-10-01T10:00:00Z');
const PRIMERA = RESERVA + 6 * HOUR;

/** Datos del huésped que ninguna tarea ni evento puede copiar. */
const PII = ['Xiomara', 'Quintanilla', 'xiomara@example.com', '+57 300 555 0101'];

function orden(extra: Partial<MemoryHcnOrder> = {}): MemoryHcnOrder {
  return {
    id: ORDEN,
    tenant_id: TENANT,
    user_id: USER,
    provider: PROVEEDOR,
    status: 'confirmed',
    provider_order_id: 'FL1IMA',
    provider_account_id: CUENTA,
    provider_booking_ref: 'STTABC0000000000001',
    created_at: RESERVA,
    search_criteria: {
      vertical: 'hotels',
      hotelId: '1402689',
      checkinDate: '2026-10-04',
      checkoutDate: '2026-10-06',
    },
    passengers: [{ room: 0, guests: [{ firstName: 'Xiomara', lastName: 'Quintanilla' }] }],
    contact_info: { email: 'xiomara@example.com', phone: '+57 300 555 0101' },
    ...extra,
  };
}

/** Plan en curso con `attempts` lecturas hechas. */
function programada(attempts = 0, extra: Partial<MemoryHcnRow> = {}): MemoryHcnRow {
  return {
    ...emptyHcnRow(),
    provider_status: 'Confirmed',
    provider_status_source: 'retrieve',
    provider_status_at: RESERVA,
    provider_voucher_status: 'true',
    hcn_state: 'scheduled',
    hcn_priority: 'P2',
    hcn_next_check_at: PRIMERA + attempts * HOUR,
    hcn_attempts: attempts,
    ...extra,
  };
}

class Proveedor extends StubHotelProviderFactory {
  readonly adapter = new StubHotelAdapter(PROVEEDOR);
  falla: Error | undefined;

  constructor(capabilities: Partial<HotelProviderCapabilities> = {}) {
    super({ code: PROVEEDOR, capabilities: { retrieve: true, ...capabilities } });
  }

  resolveForOrder(): Promise<TenantAdapter<HotelProviderAdapter>> {
    if (this.falla !== undefined) return Promise.reject(this.falla);
    return Promise.resolve({ adapter: this.adapter, credentialSource: 'own' });
  }
}

function vista(parcial: Partial<HotelBookingView> = {}): HotelBookingView {
  return {
    found: true,
    providerBookingId: 'FL1IMA',
    status: 'CONFIRMED',
    providerStatus: 'Confirmed',
    voucherIssued: true,
    warnings: [],
    ...parcial,
  };
}

function banco(
  opts: {
    orders?: MemoryHcnOrder[];
    tracking?: [string, MemoryHcnRow][];
    capabilities?: Partial<HotelProviderCapabilities>;
    queueAccepts?: boolean;
  } = {},
) {
  const mem = new MemoryHcnTracking(opts.orders ?? [orden()], opts.tracking ?? []);
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService(opts.queueAccepts ?? true);
  const proveedor = new Proveedor(opts.capabilities);
  proveedor.adapter.getBooking.mockResolvedValue(vista());
  const service = new HcnTrackingService(
    hotelRegistry([proveedor], hotelFlags(false)),
    mem.asStore(),
    new CircuitBreakerService(),
    audit.asService(),
    queue.asService(),
  );
  return { mem, audit, queue, proveedor, service, leer: proveedor.adapter.getBooking };
}

function job(attempt = 0, extra: Record<string, unknown> = {}) {
  return { tenantId: TENANT, orderId: ORDEN, attempt, ...extra };
}

/** Todo lo que el seguimiento dejó a la vista de otros: eventos y tareas. */
function volcado(b: ReturnType<typeof banco>): string {
  return b.audit.dump() + JSON.stringify(b.mem.operations);
}

class TransporteError extends Error {
  override readonly name = 'TransporteError';
  readonly retryable = true;
}

/** Un error de configuración: repetir la lectura da lo mismo. */
class CuentaConfigError extends Error {
  override readonly name = 'CuentaConfigError';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(RESERVA + 5_000);
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────── La confirmación abre el plan ─────────────────────────

describe('schedule: la confirmación abre el plan y encola la lectura del SLA', () => {
  it('dentro de ventana: P2, la primera lectura a +6 h con su jobId de tres segmentos', async () => {
    const b = banco();

    expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: true,
      queued: true,
    });

    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'scheduled',
      hcn_priority: 'P2',
      hcn_next_check_at: PRIMERA,
      hcn_attempts: 0,
    });
    expect(b.queue.jobs).toEqual([
      {
        name: 'hcn-check',
        data: { tenantId: TENANT, orderId: ORDEN, attempt: 0 },
        jobId: `hcn-check:${ORDEN}:0`,
        delayMs: PRIMERA - (RESERVA + 5_000),
      },
    ]);
    expect(b.leer).not.toHaveBeenCalled();
  });

  it('fuera de ventana: guarda la entrada en ventana y no deja un job de un mes en Redis', async () => {
    const b = banco({
      orders: [orden({ search_criteria: { vertical: 'hotels', checkinDate: '2026-12-15' } })],
    });

    expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: true,
      queued: false,
    });
    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'out-of-window',
      hcn_priority: null,
      hcn_next_check_at: Date.parse('2026-11-15T00:00:00Z'),
    });
    expect(b.queue.jobs).toEqual([]);
  });

  it('con el día de entrada terminado, el plan nace cortado', async () => {
    const b = banco({
      orders: [orden({ search_criteria: { vertical: 'hotels', checkinDate: '2026-09-29' } })],
    });

    expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: true,
      queued: false,
    });
    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'stopped', hcn_next_check_at: null });
  });

  it('un plan ya abierto (o terminado) no se reabre ni se vuelve a encolar', async () => {
    const b = banco({ tracking: [[ORDEN, programada(2)]] });

    expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: false,
      queued: false,
    });
    expect(b.mem.row(ORDEN)?.hcn_attempts).toBe(2);
    expect(b.queue.jobs).toEqual([]);
  });

  it.each([
    ['no confirmada', { status: 'pending' as const }],
    ['sin localizador', { provider_order_id: null }],
    ['de un proveedor que no es de hoteles', { provider: 'otro' }],
  ])('%s: no hay HCN que seguir', async (_caso, extra) => {
    const b = banco({ orders: [orden(extra)] });

    expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: false,
      queued: false,
    });
    expect(b.mem.row(ORDEN)).toBeUndefined();
  });

  it('un proveedor que no sabe leer reservas no tiene plan', async () => {
    const b = banco({ capabilities: { retrieve: false } });

    expect((await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).opened).toBe(false);
  });

  it('sin una fecha de entrada legible no se inventa un SLA', async () => {
    for (const checkinDate of [undefined, '2026-02-31']) {
      const b = banco({
        orders: [orden({ search_criteria: { vertical: 'hotels', checkinDate } })],
      });
      expect(await b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
        opened: false,
        queued: false,
      });
      expect(b.mem.row(ORDEN)).toBeUndefined();
    }
  });

  it('una orden de otro tenant no existe para esta llamada', async () => {
    const b = banco();

    expect(await b.service.schedule({ tenantId: OTRO_TENANT, orderId: ORDEN })).toEqual({
      opened: false,
      queued: false,
    });
    expect(b.mem.row(ORDEN)).toBeUndefined();
  });

  it('nunca lanza: si la base falla, el barrido la encuentra sin plan', async () => {
    const b = banco();
    b.mem.fallas.findTarget = new Error('base caída');

    await expect(b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).resolves.toEqual({
      opened: false,
      queued: false,
    });
    b.mem.fallas.findTarget = undefined;
    b.mem.fallas.open = 'no es un Error' as unknown as Error;
    await expect(b.service.schedule({ tenantId: TENANT, orderId: ORDEN })).resolves.toEqual({
      opened: false,
      queued: false,
    });
  });

  it('sin Redis el plan queda escrito igual, y si la cola no contesta se deja de esperar', async () => {
    const sinRedis = banco({ queueAccepts: false });
    expect(await sinRedis.service.schedule({ tenantId: TENANT, orderId: ORDEN })).toEqual({
      opened: true,
      queued: false,
    });
    expect(sinRedis.mem.row(ORDEN)?.hcn_next_check_at).toBe(PRIMERA);

    const colgada = banco();
    vi.spyOn(colgada.queue, 'enqueueHcnCheck').mockReturnValue(new Promise(() => undefined));
    const programado = colgada.service.schedule({ tenantId: TENANT, orderId: ORDEN });
    await vi.advanceTimersByTimeAsync(HCN_ENQUEUE_WAIT_MS);
    expect(await programado).toEqual({ opened: true, queued: false });
  });
});

// ───────────────────────── El job ─────────────────────────

describe('el job hcn-check: sólo la lectura vigente', () => {
  it('un payload que no armó la cola se rechaza con rutas y códigos, sin valores', async () => {
    const b = banco();
    const error = await b.service
      .runJob({ tenantId: 'no-es-un-uuid', orderId: 'x:y', attempt: HCN_READS }, { final: false })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HcnCheckJobInvalidError);
    expect((error as Error).message).toContain('tenantId:invalid_string');
    expect((error as Error).message).toContain('attempt:too_big');
    expect((error as Error).message).not.toContain('no-es-un-uuid');
    await expect(b.service.runJob(null, { final: false })).rejects.toThrow(/\(raíz\)/);
  });

  it('otra lectura, un tenant ajeno, un plan terminado o un job adelantado no leen nada', async () => {
    const b = banco({ tracking: [[ORDEN, programada(1)]] });
    vi.setSystemTime(PRIMERA + HOUR);

    await b.service.runJob(job(0), { final: false });
    await b.service.runJob(job(1, { tenantId: OTRO_TENANT }), { final: false });
    vi.setSystemTime(PRIMERA + HOUR - 2 * MIN);
    await b.service.runJob(job(1), { final: false });
    b.mem.row(ORDEN)!.hcn_state = 'received';
    vi.setSystemTime(PRIMERA + HOUR);
    await b.service.runJob(job(1), { final: false });

    expect(b.leer).not.toHaveBeenCalled();
    expect(b.audit.events).toEqual([]);
  });

  it('lee por el localizador con la cuenta de la reserva; sin HCN, la siguiente a una hora', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockResolvedValue(vista({ providerStatus: 'Vouchered' }));
    vi.setSystemTime(PRIMERA + 30_000);

    await b.service.runJob(job(0), { final: false });

    expect(b.leer).toHaveBeenCalledWith('FL1IMA', { tenantId: TENANT, requestId: ORDEN });
    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'scheduled',
      hcn_attempts: 1,
      hcn_next_check_at: PRIMERA + 30_000 + HOUR,
      provider_status: 'Vouchered',
      provider_status_source: 'hcn',
    });
    expect(b.queue.hcnChecks).toEqual([{ tenantId: TENANT, orderId: ORDEN, attempt: 1 }]);
    expect(b.queue.jobs[0]).toMatchObject({ jobId: `hcn-check:${ORDEN}:1`, delayMs: HOUR });
    // Lo que cambió del proveedor sale con la fuente `hcn`; "todavía sin HCN" no es un evento.
    expect(b.audit.types()).toEqual([ORDER_EVENTS.providerStatusChanged]);
    expect(b.audit.first(ORDER_EVENTS.providerStatusChanged)?.payload).toMatchObject({
      source: 'hcn',
      previous: 'Confirmed',
      current: 'Vouchered',
      priority: 'P2',
      attempt: 1,
    });
  });

  it('llegó el HCN: se guarda, se emite HotelConfirmationNumberReceived y el seguimiento termina', async () => {
    const b = banco({ tracking: [[ORDEN, programada(1)]] });
    b.leer.mockResolvedValue(vista({ hotelConfirmationNumber: 'HCN-4711' }));
    const ahora = PRIMERA + HOUR;
    vi.setSystemTime(ahora);

    await b.service.runJob(job(1), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn: 'HCN-4711',
      hcn_received_at: ahora,
      hcn_state: 'received',
      hcn_next_check_at: null,
      hcn_attempts: 2,
    });
    expect(b.queue.hcnChecks).toEqual([]);
    expect(b.audit.types()).toEqual([ORDER_EVENTS.hotelConfirmationNumberReceived]);
    const [evento] = b.audit.events;
    expect(evento).toMatchObject({
      tenantId: TENANT,
      actorUserId: USER,
      aggregateType: 'order',
      aggregateId: ORDEN,
    });
    expect(evento?.payload).toEqual({
      provider: PROVEEDOR,
      vertical: 'hotels',
      source: 'hcn',
      providerBookingId: 'FL1IMA',
      bookingReference: 'STTABC0000000000001',
      confirmationNumber: 'FL1IMA',
      hcn: 'HCN-4711',
      priority: 'P2',
      attempt: 2,
    });
    // Un job repetido de esa lectura ya no hace nada.
    await b.service.runJob(job(1), { final: false });
    expect(b.leer).toHaveBeenCalledTimes(1);
  });

  it('la cuarta lectura sin HCN: HotelConfirmationNumberMissing y tarea de operaciones sin PII', async () => {
    const b = banco({ tracking: [[ORDEN, programada(HCN_READS - 1)]] });
    vi.setSystemTime(PRIMERA + 3 * HOUR);

    await b.service.runJob(job(HCN_READS - 1), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'missing',
      hcn_attempts: HCN_READS,
      hcn_next_check_at: null,
    });
    expect(b.queue.hcnChecks).toEqual([]);
    expect(b.mem.operations).toHaveLength(1);
    const [tarea] = b.mem.operations;
    expect(tarea).toMatchObject({
      tenant_id: TENANT,
      order_id: ORDEN,
      type: 'hcn-ticket',
      status: 'pending',
      actor_user_id: null,
    });
    expect(JSON.parse(tarea!.result)).toEqual({
      vertical: 'hotels',
      provider: PROVEEDOR,
      reason: 'sla-exhausted',
      priority: 'P2',
      attempts: HCN_READS,
      confirmationNumber: 'FL1IMA',
      bookingReference: 'STTABC0000000000001',
      hotelId: '1402689',
      checkinDate: '2026-10-04',
      checkoutDate: '2026-10-06',
    });
    expect(b.audit.first(ORDER_EVENTS.hotelConfirmationNumberMissing)?.payload).toEqual({
      provider: PROVEEDOR,
      vertical: 'hotels',
      source: 'hcn',
      providerBookingId: 'FL1IMA',
      bookingReference: 'STTABC0000000000001',
      confirmationNumber: 'FL1IMA',
      priority: 'P2',
      attempts: HCN_READS,
      reason: 'sla-exhausted',
      ticketOpened: true,
    });
    for (const dato of PII) expect(volcado(b)).not.toContain(dato);
  });

  it('lo que va a la tarea desde la orden pasa sólo con forma de código o de fecha', async () => {
    const b = banco({
      orders: [
        orden({
          provider_booking_ref: null,
          search_criteria: {
            vertical: 'hotels',
            hotelId: 'Hotel de Xiomara Quintanilla',
            checkinDate: '2026-10-04',
            checkoutDate: 'el martes',
          },
        }),
      ],
      tracking: [[ORDEN, programada(HCN_READS - 1)]],
    });
    vi.setSystemTime(PRIMERA + 3 * HOUR);

    await b.service.runJob(job(HCN_READS - 1), { final: true });

    expect(JSON.parse(b.mem.operations[0]!.result)).toMatchObject({
      bookingReference: null,
      hotelId: null,
      checkoutDate: null,
    });
    expect(b.audit.first(ORDER_EVENTS.hotelConfirmationNumberMissing)?.payload).not.toHaveProperty(
      'bookingReference',
    );
    for (const dato of PII) expect(volcado(b)).not.toContain(dato);
  });

  it('una reserva que nació fuera de ventana agota el plan sin tarea automática (PV-38)', async () => {
    const b = banco({
      orders: [orden({ search_criteria: { vertical: 'hotels', checkinDate: '2026-12-15' } })],
      tracking: [
        [
          ORDEN,
          programada(HCN_READS - 1, {
            hcn_priority: 'P5',
            hcn_next_check_at: Date.parse('2026-11-20T03:00:00Z'),
          }),
        ],
      ],
    });
    vi.setSystemTime(Date.parse('2026-11-20T03:00:00Z'));

    await b.service.runJob(job(HCN_READS - 1), { final: false });

    expect(b.mem.row(ORDEN)?.hcn_state).toBe('missing');
    expect(b.mem.operations).toEqual([]);
    expect(b.audit.first(ORDER_EVENTS.hotelConfirmationNumberMissing)?.payload).toMatchObject({
      priority: 'P5',
      reason: 'sla-exhausted',
      ticketOpened: false,
    });
  });

  it('si la cola no acepta la lectura siguiente, la fila ya tiene su hora: la toma el barrido', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]], queueAccepts: false });
    vi.setSystemTime(PRIMERA);

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_attempts: 1, hcn_next_check_at: PRIMERA + HOUR });
  });

  it('si otro camino escribió durante la lectura (el claim de una cancelación), no pisa ni emite', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockResolvedValue(vista({ hotelConfirmationNumber: 'HCN-4711' }));
    b.mem.antesDeEscribir = () => {
      b.mem.row(ORDEN)!.sub_status = 'cancel-requested';
    };
    vi.setSystemTime(PRIMERA);

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({
      sub_status: 'cancel-requested',
      hcn: null,
      hcn_state: 'scheduled',
      hcn_attempts: 0,
    });
    expect(b.audit.events).toEqual([]);
    expect(b.queue.hcnChecks).toEqual([]);
  });
});

describe('hcn-check: cuándo se corta el seguimiento (RF-27)', () => {
  it('la reserva se ve cancelada del lado del proveedor: se corta, avisa (R3) y no mueve la orden', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockResolvedValue(vista({ status: 'CANCELLED', providerStatus: 'Cancelled' }));
    vi.setSystemTime(PRIMERA);

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'stopped',
      hcn_next_check_at: null,
      provider_status: 'Cancelled',
    });
    expect(b.mem.orders[0]?.status).toBe('confirmed');
    expect(b.audit.types()).toEqual([
      ORDER_EVENTS.reconciliationDiscrepancy,
      ORDER_EVENTS.providerStatusChanged,
    ]);
    expect(b.audit.first(ORDER_EVENTS.reconciliationDiscrepancy)?.payload).toMatchObject({
      kind: 'R3',
      accountId: CUENTA,
      source: 'hcn',
    });
    expect(b.queue.hcnChecks).toEqual([]);
  });

  it('la orden ya está cancelada (la cortó la cancelación) o fallida: se corta sin leer', async () => {
    for (const status of ['cancelled', 'failed'] as const) {
      const b = banco({ orders: [orden({ status })], tracking: [[ORDEN, programada(1)]] });
      vi.setSystemTime(PRIMERA + HOUR);

      await b.service.runJob(job(1), { final: false });

      expect(b.leer).not.toHaveBeenCalled();
      expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'stopped', hcn_attempts: 1 });
    }
  });

  it('terminó el día de entrada: se corta sin leer', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    // 2026-10-04 sin zona: el día terminó para todos a las 12:00 UTC del 5.
    vi.setSystemTime(Date.parse('2026-10-05T12:00:00Z'));

    await b.service.runJob(job(0), { final: false });

    expect(b.leer).not.toHaveBeenCalled();
    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'stopped', hcn_next_check_at: null });
  });

  it('una cancelación en curso deja la orden pending: se espera una hora sin leer ni gastar intento', async () => {
    const b = banco({
      orders: [orden({ status: 'pending' })],
      tracking: [[ORDEN, programada(1, { sub_status: 'cancel-requested' })]],
    });
    vi.setSystemTime(PRIMERA + HOUR);

    await b.service.runJob(job(1), { final: false });

    expect(b.leer).not.toHaveBeenCalled();
    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'scheduled',
      hcn_attempts: 1,
      hcn_next_check_at: PRIMERA + 2 * HOUR,
    });
    // El jobId de esta lectura sigue tomado en BullMQ: la retoma el barrido.
    expect(b.queue.jobs).toEqual([]);
  });

  it('si la pausa o el corte pierden el CAS, no escriben nada', async () => {
    for (const status of ['pending', 'cancelled'] as const) {
      const b = banco({ orders: [orden({ status })], tracking: [[ORDEN, programada(1)]] });
      b.mem.antesDeEscribir = () => {
        b.mem.row(ORDEN)!.hcn_attempts = 2;
      };
      vi.setSystemTime(PRIMERA + HOUR);

      await b.service.runJob(job(1), { final: false });

      expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'scheduled', hcn_attempts: 2 });
    }
  });
});

describe('hcn-check: una lectura que no se hace no cuenta', () => {
  it('transporte con intentos por delante: relanza el mismo error y la fila no cambia', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    const error = new TransporteError('socket hang up');
    b.leer.mockRejectedValue(error);
    vi.setSystemTime(PRIMERA);

    await expect(b.service.runJob(job(0), { final: false })).rejects.toBe(error);

    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_attempts: 0, hcn_next_check_at: PRIMERA });
    expect(b.audit.events).toEqual([]);
  });

  it('en el último intento de la cola queda vencida para el barrido, sin avisar', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockRejectedValue(new TransporteError('socket hang up'));
    vi.setSystemTime(PRIMERA);

    await b.service.runJob(job(0), { final: true });

    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_attempts: 0, hcn_next_check_at: PRIMERA });
    expect(b.audit.events).toEqual([]);
  });

  it('la cuenta no puede leer: queda vencida y se avisa una vez, con el nombre del error', async () => {
    const b = banco({ tracking: [[ORDEN, programada(2)]] });
    b.leer.mockRejectedValue(Object.assign(new Error('credencial vencida'), { status: 401 }));
    vi.setSystemTime(PRIMERA + 2 * HOUR);

    await b.service.runJob(job(2), { final: false });

    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'scheduled', hcn_attempts: 2 });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toEqual({
      provider: PROVEEDOR,
      vertical: 'hotels',
      source: 'hcn',
      providerBookingId: 'FL1IMA',
      bookingReference: 'STTABC0000000000001',
      reason: 'provider-account-issue',
      queued: false,
      attempt: 2,
      errorName: 'Error',
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.audit.dump()).not.toContain('credencial vencida');
  });

  it.each([
    ['la cuenta que hizo la reserva ya no está en la red', 'account-changed'],
    ['la cuenta dejó de estar disponible (el registry lo traduce)', 'account-changed'],
    ['un error de configuración que no se repite', 'read-unavailable'],
  ])('%s: tarea de operaciones sin contar la lectura', async (caso, reason) => {
    const b = banco({ tracking: [[ORDEN, programada(1)]] });
    b.proveedor.falla = caso.startsWith('la cuenta que')
      ? new ProviderOrderAccountUnavailableError(PROVEEDOR)
      : caso.startsWith('la cuenta dejó')
        ? new NotFoundException(caso)
        : new CuentaConfigError(caso);
    vi.setSystemTime(PRIMERA + HOUR);

    await b.service.runJob(job(1), { final: false });

    expect(b.leer).not.toHaveBeenCalled();
    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'missing',
      hcn_attempts: 1,
      provider_status_source: 'retrieve',
    });
    expect(JSON.parse(b.mem.operations[0]!.result)).toMatchObject({ reason, attempts: 1 });
    expect(b.audit.types()).toEqual([ORDER_EVENTS.hotelConfirmationNumberMissing]);
  });

  it('un error de transporte al resolver la cuenta se repite como cualquier lectura', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.proveedor.falla = new TransporteError('bóveda lenta');
    vi.setSystemTime(PRIMERA);

    await expect(b.service.runJob(job(0), { final: false })).rejects.toBe(b.proveedor.falla);
  });

  it('un proveedor que dejó de leer reservas, o una orden sin localizador: tarea de operaciones', async () => {
    const sinLectura = banco({ tracking: [[ORDEN, programada(0)]] });
    // Con el plan abierto, el proveedor deja de declarar la lectura.
    Object.assign(sinLectura.proveedor, {
      capabilities: { ...sinLectura.proveedor.capabilities, retrieve: false },
    });
    vi.setSystemTime(PRIMERA);
    await sinLectura.service.runJob(job(0), { final: false });
    expect(sinLectura.mem.row(ORDEN)?.hcn_state).toBe('missing');

    const sinLocalizador = banco({
      orders: [orden({ provider_order_id: null })],
      tracking: [[ORDEN, programada(0)]],
    });
    await sinLocalizador.service.runJob(job(0), { final: false });
    expect(sinLocalizador.leer).not.toHaveBeenCalled();
    expect(sinLocalizador.mem.row(ORDEN)?.hcn_state).toBe('missing');
    expect(
      sinLocalizador.audit.first(ORDER_EVENTS.hotelConfirmationNumberMissing)?.payload,
    ).not.toHaveProperty('providerBookingId');
  });

  it('si el "perdido" pierde el CAS, no hay tarea ni evento', async () => {
    const b = banco({ tracking: [[ORDEN, programada(HCN_READS - 1)]] });
    b.mem.antesDeEscribir = () => {
      b.mem.row(ORDEN)!.hcn_state = 'stopped';
      b.mem.row(ORDEN)!.hcn_next_check_at = null;
    };
    vi.setSystemTime(PRIMERA + 3 * HOUR);

    await b.service.runJob(job(HCN_READS - 1), { final: false });

    expect(b.mem.operations).toEqual([]);
    expect(b.audit.events).toEqual([]);

    const sinLeer = banco({ tracking: [[ORDEN, programada(0)]] });
    sinLeer.proveedor.falla = new ProviderOrderAccountUnavailableError(PROVEEDOR);
    sinLeer.mem.antesDeEscribir = () => {
      sinLeer.mem.row(ORDEN)!.hcn_attempts = 1;
    };
    vi.setSystemTime(PRIMERA);
    await sinLeer.service.runJob(job(0), { final: false });
    expect(sinLeer.mem.operations).toEqual([]);
  });

  it('lo que la tabla manda a una persona queda en el log con el id y códigos', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockResolvedValue({ found: false, warnings: [] });
    vi.setSystemTime(PRIMERA);

    await b.service.runJob(job(0), { final: false });

    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'verified-not-found',
      source: 'hcn',
    });
    // "No la encuentro" cuenta como una lectura sin HCN.
    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_attempts: 1, provider_status: 'Confirmed' });

    const sinVoucher = banco({ tracking: [[ORDEN, programada(0)]] });
    sinVoucher.leer.mockResolvedValue(vista({ voucherIssued: false }));
    await sinVoucher.service.runJob(job(0), { final: false });
    expect(sinVoucher.mem.row(ORDEN)?.provider_voucher_status).toBe('false');
  });
});

// ───────────────────────── El barrido ─────────────────────────

describe('sweepTenant: lo que la cola perdió, tenant por tenant', () => {
  it('abre el plan de una confirmada que se quedó sin él y encola su lectura', async () => {
    const b = banco();
    const ahora = RESERVA + HOUR;

    const report = await b.service.sweepTenant(TENANT, ahora);

    expect(report).toMatchObject({ examined: 1, adopted: 1, failed: 0 });
    expect(b.mem.row(ORDEN)).toMatchObject({ hcn_state: 'scheduled', hcn_next_check_at: PRIMERA });
    expect(b.queue.hcnChecks).toEqual([{ tenantId: TENANT, orderId: ORDEN, attempt: 0 }]);
  });

  it('adopta sólo lo que se puede seguir: hoteles confirmados, legibles y con la entrada en curso', async () => {
    const b = banco({
      orders: [
        orden({ id: 'vuelo', search_criteria: { checkinDate: '2026-10-04' } }),
        orden({ id: 'vieja', search_criteria: { vertical: 'hotels', checkinDate: '2026-09-20' } }),
        orden({ id: 'pendiente', status: 'pending' }),
        orden({ id: 'ajena', tenant_id: OTRO_TENANT }),
      ],
    });

    expect(await b.service.sweepTenant(TENANT, RESERVA)).toMatchObject({
      examined: 0,
      adopted: 0,
    });
    expect(b.mem.tracking.size).toBe(0);
  });

  it('sin proveedores que sepan leer, no adopta nada', async () => {
    const b = banco({ capabilities: { retrieve: false } });
    expect((await b.service.sweepTenant(TENANT, RESERVA)).adopted).toBe(0);
  });

  it('una adopción que pierde la carrera o que falla no frena a las demás', async () => {
    const b = banco({ orders: [orden({ id: 'a' }), orden({ id: 'b', created_at: RESERVA + 1 })] });
    const open = vi.spyOn(b.mem, 'open');
    open.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('base caída'));

    expect(await b.service.sweepTenant(TENANT, RESERVA)).toMatchObject({
      examined: 2,
      adopted: 0,
      skipped: 1,
      failed: 1,
    });
  });

  it('una lectura vencida más allá del margen la ejecuta el barrido; dentro del margen es de la cola', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });

    const dentro = await b.service.sweepTenant(TENANT, PRIMERA + HCN_CHECK_GRACE_MS - 1);
    expect(dentro.examined).toBe(0);
    vi.setSystemTime(PRIMERA + HCN_CHECK_GRACE_MS);
    const fuera = await b.service.sweepTenant(TENANT, PRIMERA + HCN_CHECK_GRACE_MS);

    expect(fuera).toMatchObject({ examined: 1, advanced: 1 });
    expect(b.leer).toHaveBeenCalledTimes(1);
    expect(b.mem.row(ORDEN)?.hcn_attempts).toBe(1);
  });

  it('en el barrido un fallo de transporte no lanza: queda vencida para la corrida siguiente', async () => {
    const b = banco({ tracking: [[ORDEN, programada(0)]] });
    b.leer.mockRejectedValue(new TransporteError('socket hang up'));
    const ahora = PRIMERA + HCN_CHECK_GRACE_MS;
    vi.setSystemTime(ahora);

    expect(await b.service.sweepTenant(TENANT, ahora)).toMatchObject({
      examined: 1,
      unavailable: 1,
    });
    expect(b.mem.row(ORDEN)?.hcn_next_check_at).toBe(PRIMERA);
  });

  it('entrada en ventana (PV-38): P5 desde la entrada, sin margen porque no hay job que esperar', async () => {
    const entrada = Date.parse('2026-11-15T00:00:00Z');
    const b = banco({
      orders: [orden({ search_criteria: { vertical: 'hotels', checkinDate: '2026-12-15' } })],
      tracking: [
        [ORDEN, { ...emptyHcnRow(), hcn_state: 'out-of-window', hcn_next_check_at: entrada }],
      ],
    });
    vi.setSystemTime(entrada);

    const report = await b.service.sweepTenant(TENANT, entrada);

    expect(report).toMatchObject({ examined: 1, 'window-entered': 1 });
    expect(b.mem.row(ORDEN)).toMatchObject({
      hcn_state: 'scheduled',
      hcn_priority: 'P5',
      hcn_attempts: 0,
      hcn_next_check_at: entrada + 120 * HOUR,
    });
    expect(b.queue.jobs).toEqual([
      expect.objectContaining({ jobId: `hcn-check:${ORDEN}:0`, delayMs: 120 * HOUR }),
    ]);
    expect(b.leer).not.toHaveBeenCalled();
  });

  it('una entrada en ventana que otro camino cortó antes no se reabre', async () => {
    const entrada = Date.parse('2026-11-15T00:00:00Z');
    const b = banco({
      tracking: [
        [ORDEN, { ...emptyHcnRow(), hcn_state: 'out-of-window', hcn_next_check_at: entrada }],
      ],
    });
    b.mem.antesDeEscribir = () => {
      b.mem.row(ORDEN)!.hcn_state = 'stopped';
      b.mem.row(ORDEN)!.hcn_next_check_at = null;
    };

    expect(await b.service.sweepTenant(TENANT, entrada)).toMatchObject({ skipped: 1 });
    expect(b.queue.jobs).toEqual([]);
  });

  it('una entrada sin hora (fila inconsistente) se salta; un paso que falla se cuenta y sigue', async () => {
    const b = banco();
    const base = await b.service.sweepTenant(TENANT, RESERVA);
    expect(base.adopted).toBe(1);

    const sinHora = {
      ...(await b.mem.findTarget(TENANT, ORDEN)),
      tracking: { state: 'out-of-window', priority: null, nextAt: null, attempts: 0 },
    } as HcnTarget;
    const programadaTarget = (await b.mem.findTarget(TENANT, ORDEN)) as HcnTarget;
    vi.spyOn(b.mem, 'listUnplanned').mockResolvedValue([]);
    vi.spyOn(b.mem, 'listDue').mockResolvedValue([sinHora, programadaTarget]);
    b.mem.fallas.advance = new Error('base caída');
    vi.setSystemTime(PRIMERA);

    expect(await b.service.sweepTenant(TENANT, PRIMERA + HCN_CHECK_GRACE_MS)).toMatchObject({
      examined: 2,
      skipped: 1,
      failed: 1,
    });
  });

  it('un tenant sólo ve y mueve lo suyo', async () => {
    const b = banco({
      orders: [orden(), orden({ id: 'h2', tenant_id: OTRO_TENANT })],
      tracking: [
        [ORDEN, programada(0)],
        ['h2', programada(0)],
      ],
    });
    const ahora = PRIMERA + HCN_CHECK_GRACE_MS;
    vi.setSystemTime(ahora);

    await b.service.sweepTenant(OTRO_TENANT, ahora);

    expect(b.mem.row('h2')?.hcn_attempts).toBe(1);
    expect(b.mem.row(ORDEN)?.hcn_attempts).toBe(0);
    expect(b.leer).toHaveBeenCalledWith('FL1IMA', { tenantId: OTRO_TENANT, requestId: 'h2' });
  });
});
