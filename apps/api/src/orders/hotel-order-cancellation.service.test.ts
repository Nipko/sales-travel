import { NotFoundException } from '@nestjs/common';
import type { HotelBookingView } from '@sales-travel/domain';
import { TboApiError } from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import {
  HOTEL_CANCEL_VERIFY_STEPS,
  HOTEL_CANCEL_VERIFY_SWEEP_LIMIT,
} from '../hotels/hotel-cancellation-verification.js';
import { HotelProviderCapabilityError } from '../hotels/hotel-provider-errors.js';
import type { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
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
  type ProviderFlagsPort,
  type TenantAdapter,
} from '../providers/provider.types.js';
import { APAGADO_GLOBAL, apagadoPara } from '../providers/__fixtures__/provider-flags.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import {
  memoryHotelCancellation,
  type Row,
  type TrackingRow,
} from './__fixtures__/memory-hotel-cancellation.js';
import {
  HotelCancelVerifyJobInvalidError,
  HotelOrderCancellationService,
} from './hotel-order-cancellation.service.js';
import { CANCEL_UNVERIFIED_POLICY } from './cancel-retry-policy.js';
import { ORDER_EVENTS } from './order-events.js';

/**
 * `verify-cancellation` y las piezas de la cancelación de hoteles por la puerta pública del
 * servicio (docs/tbo/09 PR-5.3; 08 RF-38; 04 §4.4 punto 6 y §10). El registry y el breaker son los
 * reales; la base, un doble con los CAS del calendario (0046).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTRO_TENANT = '44444444-4444-4444-8444-444444444444';
const USER = '22222222-2222-4222-8222-222222222222';
const CUENTA = '33333333-3333-4333-8333-333333333333';
const PROVEEDOR = 'hoteles-anon';
const ORDEN = 'h1';
const ANCLA = Date.parse('2026-09-26T15:00:00Z');
const MIN = 60_000;

function orden(extra: Row = {}): Row {
  return {
    id: ORDEN,
    tenant_id: TENANT,
    user_id: USER,
    provider: PROVEEDOR,
    provider_order_id: 'FL1IMA',
    provider_account_id: CUENTA,
    provider_booking_ref: 'STTABC0000000000001',
    status: 'pending',
    selected_offer: {},
    ...extra,
  };
}

/** La fila de una cancelación en curso con el calendario en `step`. */
function enCurso(step = 0, extra: Partial<TrackingRow> = {}): TrackingRow {
  return {
    sub_status: null,
    provider_status: 'CxlRequestSentToHotel',
    provider_status_source: 'cancel',
    provider_voucher_status: 'true',
    refund_awaited: false,
    hcn: null,
    hcn_state: 'scheduled',
    cancel_verify_anchor_at: ANCLA,
    cancel_verify_step: step,
    cancel_verify_next_at: ANCLA + 2 * MIN,
    ...extra,
  };
}

class Proveedor extends StubHotelProviderFactory {
  readonly adapter = new StubHotelAdapter(PROVEEDOR);
  falla: Error | undefined;

  constructor(capabilities: Partial<HotelProviderCapabilities> = {}) {
    super({ code: PROVEEDOR, capabilities: { retrieve: true, cancel: true, ...capabilities } });
  }

  resolveForOrder(): Promise<TenantAdapter<HotelProviderAdapter>> {
    if (this.falla !== undefined) return Promise.reject(this.falla);
    return Promise.resolve({ adapter: this.adapter, credentialSource: 'own' });
  }
}

function vista(parcial: Partial<HotelBookingView>): HotelBookingView {
  return { found: true, providerBookingId: 'FL1IMA', warnings: [], ...parcial };
}

function banco(
  opts: {
    orders?: Row[];
    tracking?: TrackingRow;
    capabilities?: Partial<HotelProviderCapabilities>;
    queueAccepts?: boolean;
    operations?: Row[];
    flags?: ProviderFlagsPort;
  } = {},
) {
  const mem = memoryHotelCancellation({
    orders: opts.orders ?? [orden()],
    operations: opts.operations ?? [],
    tracking: new Map(opts.tracking === undefined ? [] : [[ORDEN, opts.tracking]]),
  });
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService(opts.queueAccepts ?? true);
  const releaseCancelled = vi.fn<BookingHoldLedger['releaseCancelled']>(() =>
    Promise.resolve('released'),
  );
  const proveedor = new Proveedor(opts.capabilities);
  const service = new HotelOrderCancellationService(
    hotelRegistry([proveedor], opts.flags ?? hotelFlags(false)),
    mem.store,
    new CircuitBreakerService(),
    audit.asService(),
    queue.asService(),
    { releaseCancelled } as unknown as BookingHoldLedger,
  );
  return { mem, audit, queue, releaseCancelled, proveedor, service };
}

function job(step = 0, extra: Record<string, unknown> = {}) {
  return { tenantId: TENANT, orderId: ORDEN, step, anchorAt: ANCLA, ...extra };
}

function razones(audit: RecordingAuditService): unknown[] {
  return audit.ofType(ORDER_EVENTS.escalated).map((e) => e.payload?.['reason']);
}

describe('el job verify-cancellation: sólo el paso vigente', () => {
  it('un payload que no armó la cola se rechaza con rutas y códigos, sin valores', async () => {
    const b = banco();
    const error = await b.service
      .runJob({ tenantId: 'no-es-un-uuid', orderId: 'x:y', step: 9 }, { final: false })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HotelCancelVerifyJobInvalidError);
    expect((error as Error).message).toContain('tenantId:invalid_string');
    expect((error as Error).message).not.toContain('no-es-un-uuid');
    await expect(b.service.runJob(null, { final: false })).rejects.toThrow(/\(raíz\)/);
  });

  it('un paso que ya no es el de la fila, de otro calendario o de una orden ajena no lee nada', async () => {
    const b = banco({ tracking: enCurso(1) });

    await b.service.runJob(job(0), { final: false });
    await b.service.runJob(job(1, { anchorAt: ANCLA - 1 }), { final: false });
    await b.service.runJob(job(1, { tenantId: OTRO_TENANT }), { final: false });

    expect(b.proveedor.adapter.getBooking).not.toHaveBeenCalled();
  });

  it('lee con la cuenta de la reserva, por el localizador, y conserva el actor del job', async () => {
    const b = banco({ tracking: enCurso() });
    b.proveedor.adapter.getBooking.mockResolvedValue(
      vista({ status: 'CANCELLATION_IN_PROGRESS', providerStatus: 'CancelPending' }),
    );

    await b.service.runJob(job(0, { actorUserId: 'actor-1' }), { final: false });

    // Un job: por el cupo de fondo del proveedor, que cede ante las ventas (PV-41).
    expect(b.proveedor.adapter.getBooking).toHaveBeenCalledWith(
      'FL1IMA',
      { tenantId: TENANT, requestId: ORDEN },
      { purpose: 'background' },
    );
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 1,
      cancel_verify_next_at: ANCLA + 15 * MIN,
      provider_status: 'CancelPending',
    });
    expect(b.queue.cancelVerifications).toEqual([
      { tenantId: TENANT, orderId: ORDEN, step: 1, anchorAt: ANCLA, actorUserId: 'actor-1' },
    ]);
    expect(b.audit.ofType(ORDER_EVENTS.providerStatusChanged)[0]).toMatchObject({
      actorUserId: 'actor-1',
      payload: { source: 'verify', step: 0, providerBookingId: 'FL1IMA' },
    });
  });

  it('si la cola no acepta el paso siguiente, la fila ya tiene su hora: lo toma el barrido', async () => {
    const b = banco({ tracking: enCurso(), queueAccepts: false });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLATION_IN_PROGRESS' }));

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.tracking(ORDEN)?.cancel_verify_next_at).toBe(ANCLA + 15 * MIN);
  });
});

describe('verify-cancellation: la lectura cierra, espera o escala', () => {
  it('la ve cancelada: cierra, corta el HCN y libera la retención; si la retención no se libera, escala', async () => {
    const b = banco({ tracking: enCurso() });
    b.proveedor.adapter.getBooking.mockResolvedValue(
      vista({
        status: 'CANCELLED',
        providerStatus: 'CancelledAndRefundAwaited',
        refundAwaited: true,
      }),
    );
    b.releaseCancelled.mockRejectedValue(new Error('cartera caída'));

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.order(ORDEN)?.['status']).toBe('cancelled');
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      hcn_state: 'stopped',
      refund_awaited: true,
      cancel_verify_next_at: null,
    });
    expect(b.releaseCancelled).toHaveBeenCalledWith(TENANT, ORDEN, USER);
    expect(b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'portfolio-hold-release-failed',
      bookingReference: 'STTABC0000000000001',
      errorName: 'Error',
    });
  });

  it('si otra ejecución ya la cerró, no escribe ni libera dos veces', async () => {
    const b = banco({ orders: [orden({ status: 'cancelled' })], tracking: enCurso() });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLED' }));
    // Una orden ya cancelada con el calendario abierto: la lectura sólo se registra.
    await b.service.runJob(job(0), { final: false });

    expect(b.releaseCancelled).not.toHaveBeenCalled();
    expect(b.mem.tracking(ORDEN)?.cancel_verify_next_at).toBeNull();
  });

  it('el último paso todavía en curso escala cancellation-stuck con el estado del proveedor', async () => {
    const b = banco({ tracking: enCurso(HOTEL_CANCEL_VERIFY_STEPS - 1) });
    b.proveedor.adapter.getBooking.mockResolvedValue(
      vista({ status: 'CANCELLATION_IN_PROGRESS', providerStatus: 'CxlRequestSentToHotel' }),
    );

    await b.service.runJob(job(HOTEL_CANCEL_VERIFY_STEPS - 1), { final: false });

    expect(b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'cancellation-stuck',
      providerStatus: 'CxlRequestSentToHotel',
      steps: HOTEL_CANCEL_VERIFY_STEPS,
      retryForbidden: true,
    });
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: HOTEL_CANCEL_VERIFY_STEPS,
      cancel_verify_next_at: null,
    });
  });

  it('no encontrada en el último paso: se escala sin inventar un estado', async () => {
    const b = banco({ tracking: enCurso(HOTEL_CANCEL_VERIFY_STEPS - 1) });
    b.proveedor.adapter.getBooking.mockResolvedValue({ found: false, warnings: [] });

    await b.service.runJob(job(HOTEL_CANCEL_VERIFY_STEPS - 1), { final: false });

    const payload = b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload;
    expect(payload).toMatchObject({ reason: 'cancellation-stuck' });
    expect(payload).not.toHaveProperty('providerStatus');
  });

  it('un fallo de transporte con intentos por delante se relanza a la cola; en el último, queda vencido y avisa', async () => {
    const b = banco({ tracking: enCurso() });
    const red = new TboApiError({
      status: 0,
      path: '/BookingDetail',
      kind: 'TRANSPORT',
      requestId: 'r',
    });
    b.proveedor.adapter.getBooking.mockRejectedValue(red);

    await expect(b.service.runJob(job(0), { final: false })).rejects.toBe(red);
    await b.service.runJob(job(0), { final: true });

    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 0,
      cancel_verify_next_at: ANCLA + 2 * MIN,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'verification-unavailable',
      errorName: 'TboApiError',
      step: 0,
    });
  });

  it('la cuenta que no puede leer avisa a su dueño y el paso queda vencido', async () => {
    const b = banco({ tracking: enCurso() });
    b.proveedor.adapter.getBooking.mockRejectedValue(
      new TboApiError({
        status: 200,
        tboCode: 401,
        path: '/BookingDetail',
        kind: 'CREDENTIALS_INVALID',
        requestId: 'r',
      }),
    );

    await b.service.runJob(job(0), { final: false });

    expect(razones(b.audit)).toEqual(['provider-account-issue']);
    expect(b.mem.tracking(ORDEN)?.cancel_verify_next_at).not.toBeNull();
  });

  it('la cuenta de la reserva ya no está en la red: deja de leer (leer con otra diría "no está")', async () => {
    const b = banco({ tracking: enCurso() });
    b.proveedor.falla = new ProviderOrderAccountUnavailableError(PROVEEDOR);

    await b.service.runJob(job(0), { final: false });

    expect(razones(b.audit)).toEqual(['provider-account-changed']);
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 1,
      cancel_verify_next_at: null,
    });
    expect(b.proveedor.adapter.getBooking).not.toHaveBeenCalled();
  });

  it.each([
    ['el proveedor ya no está registrado', { orders: [orden({ provider: 'otro-proveedor' })] }],
    ['el proveedor no lee reservas', { capabilities: { retrieve: false } }],
    ['la orden no tiene localizador', { orders: [orden({ provider_order_id: null })] }],
  ])('%s: no se va a poder leer nunca, se deja de intentar', async (_caso, opts) => {
    const b = banco({ tracking: enCurso(), ...opts });

    await b.service.runJob(job(0), { final: false });

    expect(razones(b.audit)).toEqual(['verification-unavailable']);
    expect(b.mem.tracking(ORDEN)?.cancel_verify_next_at).toBeNull();
    expect(b.proveedor.adapter.getBooking).not.toHaveBeenCalled();
  });

  it('una lectura que la ve vigente sobre una cancelación sin verificar va a una persona', async () => {
    const b = banco({
      tracking: enCurso(0, { sub_status: 'cancel-unverified', provider_status: null }),
    });
    b.proveedor.adapter.getBooking.mockResolvedValue(
      vista({ status: 'CONFIRMED', providerStatus: 'Confirmed' }),
    );

    await b.service.runJob(job(0), { final: false });

    expect(razones(b.audit)).toEqual(['cancellation-unverified']);
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      sub_status: 'cancel-unverified',
      provider_status: 'Confirmed',
      cancel_verify_next_at: null,
    });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
  });
});

describe('el barrido de cancelaciones, tenant por tenant', () => {
  it('ejecuta lo vencido más allá del margen de la cola, saltando al último paso ya vencido', async () => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLATION_IN_PROGRESS' }));

    // 20 minutos después: el paso 1 (+15 min) ya venció; el 0 también.
    const report = await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN);

    expect(report).toMatchObject({ examined: 1, advanced: 1, failed: 0 });
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 2,
      cancel_verify_next_at: ANCLA + 60 * MIN,
    });
    expect(b.queue.cancelVerifications.at(-1)).toMatchObject({ step: 2, actorUserId: USER });
  });

  it('lo que todavía está dentro del margen lo deja para la cola', async () => {
    const b = banco({ tracking: enCurso(0) });
    expect((await b.service.sweepTenant(TENANT, ANCLA + 3 * MIN)).examined).toBe(0);
    // Otro tenant no ve nada de éste.
    expect((await b.service.sweepTenant(OTRO_TENANT, ANCLA + 60 * MIN)).examined).toBe(0);
  });

  it('un fallo de transporte en el barrido no relanza ni avisa: reprograma con backoff, sin avanzar', async () => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockRejectedValue(
      new TboApiError({ status: 503, path: '/BookingDetail', kind: 'UPSTREAM', requestId: 'r' }),
    );

    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({
      unavailable: 1,
      failed: 0,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
    // Leyó como el paso 1 (+15 min), vencido hace 5: la espera mínima, una corrida del barrido.
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 0,
      cancel_verify_next_at: ANCLA + 35 * MIN,
    });
    expect((await b.service.sweepTenant(TENANT, ANCLA + 39 * MIN)).examined).toBe(0);
  });

  it('la espera crece con la demora, pero nunca pasa el paso siguiente del calendario', async () => {
    const b = banco({ tracking: enCurso(2, { cancel_verify_next_at: ANCLA + 60 * MIN }) });
    b.proveedor.adapter.getBooking.mockRejectedValue(
      new TboApiError({ status: 503, path: '/BookingDetail', kind: 'UPSTREAM', requestId: 'r' }),
    );

    // El paso 2 (+1 h) vencido hace casi 5 h: esperaría otro tanto, pero el paso 3 toca a +6 h.
    await b.service.sweepTenant(TENANT, ANCLA + 350 * MIN);

    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 2,
      cancel_verify_next_at: ANCLA + 360 * MIN,
    });
  });

  it('HARD-2: 25+ lecturas que fallan siempre no tapan al resto del tenant', async () => {
    const atascadas = Array.from(
      { length: HOTEL_CANCEL_VERIFY_SWEEP_LIMIT + 1 },
      (_, i) => `a${i}`,
    );
    const b = banco({
      orders: [
        ...atascadas.map((id) => orden({ id, provider_order_id: `LOC${id}` })),
        orden({ id: 'sana' }),
      ],
    });
    for (const id of atascadas) b.mem.state.tracking.set(id, enCurso(0));
    b.mem.state.tracking.set('sana', enCurso(0, { cancel_verify_next_at: ANCLA + 3 * MIN }));
    // 429 de la cuenta: el breaker no lo cuenta, así que el proveedor sigue respondiendo a las demás.
    const limitada = Object.assign(new Error('429'), {
      name: 'TboApiError',
      retryable: true,
      failure: { kind: 'THROTTLED', circuit: 'IGNORE', retry: 'RETRY_BACKOFF' },
    });
    b.proveedor.adapter.getBooking.mockImplementation((locator) =>
      locator === 'FL1IMA'
        ? Promise.resolve(vista({ status: 'CANCELLATION_IN_PROGRESS' }))
        : Promise.reject(limitada),
    );

    expect(await b.service.sweepTenant(TENANT, ANCLA + 10 * MIN)).toMatchObject({
      examined: HOTEL_CANCEL_VERIFY_SWEEP_LIMIT,
      unavailable: HOTEL_CANCEL_VERIFY_SWEEP_LIMIT,
    });
    expect(b.mem.tracking('sana')?.cancel_verify_step).toBe(0);

    // Sin el backoff, las mismas 25 volverían a ocupar la corrida.
    expect(await b.service.sweepTenant(TENANT, ANCLA + 11 * MIN)).toMatchObject({
      examined: 2,
      unavailable: 1,
      advanced: 1,
    });
    expect(b.mem.tracking('sana')?.cancel_verify_step).toBe(1);
  });

  it('si la base no deja reprogramar, la orden cuenta como fallida y sigue vencida', async () => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockRejectedValue(
      new TboApiError({ status: 503, path: '/BookingDetail', kind: 'UPSTREAM', requestId: 'r' }),
    );
    vi.spyOn(b.mem.store, 'postpone').mockRejectedValue(new Error('base caída'));

    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({
      examined: 1,
      unavailable: 0,
      failed: 1,
    });
    expect(b.mem.tracking(ORDEN)?.cancel_verify_next_at).toBe(ANCLA + 2 * MIN);
  });

  it('una orden que falla por otra cosa se cuenta y no frena a las demás', async () => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLED' }));
    vi.spyOn(b.mem.store, 'close').mockRejectedValue(new Error('base caída'));

    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({
      examined: 1,
      failed: 1,
    });
  });

  it('un paso que otra ejecución ya avanzó no emite nada', async () => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLATION_IN_PROGRESS' }));
    vi.spyOn(b.mem.store, 'advance').mockResolvedValue(false);

    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({ skipped: 1 });
    expect(b.queue.cancelVerifications).toEqual([]);
    expect(b.audit.events).toEqual([]);
  });

  it.each([
    ['cerrar', vista({ status: 'CANCELLED' }), 'close'],
    ['dejar a una persona', vista({ status: 'UNKNOWN', providerStatus: 'Frozen' }), 'advance'],
  ] as const)('perder el CAS al %s no emite nada', async (_caso, leida, metodo) => {
    const b = banco({ tracking: enCurso(0) });
    b.proveedor.adapter.getBooking.mockResolvedValue(leida);
    vi.spyOn(b.mem.store, metodo).mockResolvedValue(false);

    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({ skipped: 1 });
    expect(b.audit.events).toEqual([]);
    expect(b.releaseCancelled).not.toHaveBeenCalled();
  });

  it('perder el CAS al atascarse o al dejar de leer tampoco emite', async () => {
    const atascada = banco({ tracking: enCurso(HOTEL_CANCEL_VERIFY_STEPS - 1) });
    atascada.proveedor.adapter.getBooking.mockResolvedValue(
      vista({ status: 'CANCELLATION_IN_PROGRESS' }),
    );
    vi.spyOn(atascada.mem.store, 'advance').mockResolvedValue(false);
    expect(await atascada.service.sweepTenant(TENANT, ANCLA + 25 * 60 * MIN)).toMatchObject({
      skipped: 1,
    });

    const sinCuenta = banco({ tracking: enCurso(0) });
    sinCuenta.proveedor.falla = new ProviderOrderAccountUnavailableError(PROVEEDOR);
    vi.spyOn(sinCuenta.mem.store, 'advance').mockResolvedValue(false);
    expect(await sinCuenta.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({
      skipped: 1,
    });
    expect([...atascada.audit.events, ...sinCuenta.audit.events]).toEqual([]);
  });

  it('una fila vencida sin calendario (el CHECK de 0046 no lo deja) se salta', async () => {
    const b = banco({
      tracking: enCurso(0, { cancel_verify_anchor_at: null, cancel_verify_step: null }),
    });
    expect(await b.service.sweepTenant(TENANT, ANCLA + 20 * MIN)).toMatchObject({
      examined: 1,
      skipped: 1,
    });
  });
});

describe('las piezas de la cancelación', () => {
  it('assertCancellable: un proveedor que no cancela es 400 antes de tomar nada', async () => {
    const b = banco({ capabilities: { cancel: false } });
    await expect(
      b.service.assertCancellable(TENANT, {
        id: ORDEN,
        provider: PROVEEDOR,
        provider_account_id: CUENTA,
        selected_offer: {},
      }),
    ).rejects.toBeInstanceOf(HotelProviderCapabilityError);
  });

  it('con el proveedor apagado por la plataforma, la cancelación de lo ya vendido sale igual', async () => {
    const b = banco({ flags: hotelFlags(() => apagadoPara(TENANT)) });
    const pedido = {
      id: ORDEN,
      provider: PROVEEDOR,
      provider_account_id: CUENTA,
      selected_offer: {},
    };

    await expect(b.service.assertCancellable(TENANT, pedido)).resolves.toBeUndefined();
    await b.service.send(TENANT, pedido);

    expect(b.proveedor.adapter.cancelBooking).toHaveBeenCalledWith(
      { providerBookingId: 'FL1IMA' },
      { tenantId: TENANT, requestId: ORDEN },
      { purpose: 'background' },
    );
  });

  it('con el proveedor apagado para todos, la verificación de una cancelación sigue leyendo', async () => {
    const b = banco({ tracking: enCurso(), flags: hotelFlags(() => APAGADO_GLOBAL) });
    b.proveedor.adapter.getBooking.mockResolvedValue(vista({ status: 'CANCELLATION_IN_PROGRESS' }));

    await b.service.runJob(job(0), { final: false });

    expect(b.proveedor.adapter.getBooking).toHaveBeenCalledTimes(1);
  });

  it('send: una orden que el tenant no lee, o sin localizador, no sale al proveedor', async () => {
    const b = banco({ orders: [orden({ provider_order_id: null })] });
    const pedido = {
      id: ORDEN,
      provider: PROVEEDOR,
      provider_account_id: CUENTA,
      selected_offer: {},
    };

    await expect(b.service.send(TENANT, pedido)).rejects.toBeInstanceOf(NotFoundException);
    await expect(b.service.send(OTRO_TENANT, pedido)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.proveedor.adapter.cancelBooking).not.toHaveBeenCalled();
  });

  it('un pedido que lanzó sin saber si se aplicó abre la lectura; uno que no salió suelta el claim', () => {
    const b = banco();
    expect(b.service.thrownTracking(CANCEL_UNVERIFIED_POLICY, ANCLA)).toEqual({
      at: ANCLA,
      source: 'cancel',
      subStatus: 'cancel-unverified',
      openCalendar: { anchorAt: ANCLA, nextAt: ANCLA + 2 * MIN },
    });
    expect(
      b.service.thrownTracking(
        {
          outcome: 'FAILED',
          retryable: true,
          reconciliationRequired: false,
          reason: 'pre-write-transient',
        },
        ANCLA,
      ),
    ).toEqual({ at: ANCLA, source: 'cancel', subStatus: null });
  });

  it('afterThrow sin calendario no encola nada', async () => {
    const b = banco();
    await b.service.afterThrow(
      TENANT,
      { id: ORDEN, provider: PROVEEDOR },
      { at: ANCLA, source: 'cancel', subStatus: null },
      USER,
    );
    expect(b.queue.jobs).toEqual([]);
  });

  it('una cola que no contesta a tiempo no cuelga la cancelación', async () => {
    vi.useFakeTimers();
    try {
      const b = banco();
      vi.spyOn(b.queue, 'enqueueVerifyCancellation').mockReturnValue(new Promise(() => undefined));
      const listo = b.service.afterThrow(
        TENANT,
        { id: ORDEN, provider: PROVEEDOR },
        b.service.thrownTracking(CANCEL_UNVERIFIED_POLICY, Date.now()),
        USER,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(listo).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles: sólo proveedores de hoteles registrados', () => {
    const b = banco();
    expect(b.service.handles(PROVEEDOR)).toBe(true);
    expect(b.service.handles('stub-air')).toBe(false);
  });
});

describe('el resultado durable de la operación resuelta por la lectura', () => {
  it('una cancelación sin verificar que la lectura ve cancelada queda exitosa en el historial', async () => {
    const b = banco({
      tracking: enCurso(0, { sub_status: 'cancel-unverified' }),
      operations: [
        {
          id: 'op-1',
          tenant_id: TENANT,
          order_id: ORDEN,
          type: 'cancel',
          status: 'failed',
          created_at: 1,
          result: JSON.stringify({
            status: 'failed',
            ...CANCEL_UNVERIFIED_POLICY,
            priorOrderStatus: 'confirmed',
          }),
        },
      ],
    });
    b.proveedor.adapter.getBooking.mockResolvedValue(
      vista({ status: 'CANCELLED', providerStatus: 'Cancelled' }),
    );

    await b.service.runJob(job(0), { final: false });

    expect(b.mem.operations(ORDEN)[0]).toMatchObject({ status: 'success' });
    expect(b.mem.result(b.mem.operations(ORDEN)[0])).toMatchObject({
      outcome: 'SUCCEEDED',
      priorOrderStatus: 'confirmed',
      resolvedBy: 'verify-cancellation',
    });
  });
});
