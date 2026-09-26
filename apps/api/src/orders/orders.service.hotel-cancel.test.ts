import { ConflictException } from '@nestjs/common';
import type {
  HotelBookingView,
  HotelCancelRequest,
  HotelCancelResult,
  SearchContext,
} from '@sales-travel/domain';
import { TboApiError, TboCancelMappingError } from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { hotelFlags, hotelRegistry } from '../hotels/__fixtures__/fake-despegar-hotels.adapter.js';
import type { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import type { PricingService } from '../pricing/pricing.service.js';
import {
  StubHotelAdapter,
  StubHotelProviderFactory,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import {
  ProviderOrderAccountUnavailableError,
  type TenantAdapter,
} from '../providers/provider.types.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import {
  RecordingQueueService,
  bullMqJobIdRejection,
} from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { memoryHotelCancellation, type Row } from './__fixtures__/memory-hotel-cancellation.js';
import { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import { ORDER_EVENTS } from './order-events.js';
import { OrdersService } from './orders.service.js';

/**
 * La cancelación de una orden de hotel por la puerta pública de `OrdersService` (docs/tbo/09 PR-5.3;
 * 08 RF-25 CA 1 a 4; 04 §4.4; D-TBO-25 A). El proveedor es anónimo y contesta lo que contestaría el
 * ACL de TBO (`HotelCancelResult`, y sus errores tal cual); la base es un doble con transacciones
 * que se deshacen enteras. El SQL real, con RLS, lo prueba la suite de integración.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CUENTA = '33333333-3333-4333-8333-333333333333';
const PROVEEDOR = 'hoteles-anon';
const ORDEN = 'h1';
const LOCALIZADOR = 'FL1IMA';
const MIN = 60_000;

const PRICING = { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService;

function ordenHotel(extra: Row = {}): Row {
  return {
    id: ORDEN,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: PROVEEDOR,
    provider_order_id: LOCALIZADOR,
    status: 'confirmed',
    search_criteria: { vertical: 'hotels', checkoutDate: '2099-10-12' },
    selected_offer: {
      vertical: 'hotels',
      checkinDate: '2099-10-10',
      roompack: {
        price: { total: { amountMinor: 80_000, currency: 'USD' } },
        rooms: [{ name: 'Doble' }],
        cancellation: {
          refundable: true,
          status: 'partially_refundable',
          policySource: 'prebook-final',
          rules: [
            {
              type: 'Percentage',
              fromLocalDateTime: '2000-01-01T00:00:00',
              penaltyPercentage: 25,
            },
          ],
        },
      },
    },
    passengers: [{ room: 0, guests: [{ firstName: 'Ana', lastName: 'Pérez' }] }],
    contact_info: { email: 'ana@x.test' },
    total_amount: 95_000,
    currency: 'USD',
    order_number: 1,
    provider_raw: { phase: 'create' },
    error_message: null,
    create_request_key: null,
    provider_booking_ref: 'STTABC0000000000001',
    provider_account_id: CUENTA,
    created_at: new Date('2026-09-26T00:00:00Z'),
    updated_at: new Date('2026-09-26T00:00:00Z'),
    ...extra,
  };
}

/** El proveedor de la orden: resuelve SU cuenta (RF-29), o la da por no disponible. */
class ProveedorDeLaOrden extends StubHotelProviderFactory {
  readonly adapter = new StubHotelAdapter(PROVEEDOR);
  cuentaDisponible = true;

  constructor() {
    super({ code: PROVEEDOR, capabilities: { retrieve: true, cancel: true } });
  }

  resolveForOrder(): Promise<TenantAdapter<HotelProviderAdapter>> {
    if (!this.cuentaDisponible) {
      return Promise.reject(new ProviderOrderAccountUnavailableError(PROVEEDOR));
    }
    return Promise.resolve({ adapter: this.adapter, credentialSource: 'inherited' });
  }
}

function respuesta(parcial: Partial<HotelCancelResult>): HotelCancelResult {
  return { success: true, warnings: [], ...parcial };
}

function banco(orders: Row[] = [ordenHotel()]) {
  const mem = memoryHotelCancellation({ orders });
  const audit = new RecordingAuditService();
  const queue = new RecordingQueueService();
  const releaseCancelled = vi.fn(() => Promise.resolve('released' as const));
  const holds = { releaseCancelled } as unknown as BookingHoldLedger;
  const proveedor = new ProveedorDeLaOrden();
  const vuelos = new StubProviderFactory({ code: 'stub-air' });
  const cancellations = new HotelOrderCancellationService(
    hotelRegistry([proveedor], hotelFlags(false)),
    mem.store,
    new CircuitBreakerService(),
    audit.asService(),
    queue.asService(),
    holds,
  );
  const service = new OrdersService(
    mem.db,
    new FlightProviderRegistry([vuelos], { isEnabledForTenant: () => Promise.resolve(false) }),
    queue.asService(),
    {} as unknown as AgentCarsProviderFactory,
    audit.asService(),
    PRICING,
    undefined,
    cancellations,
  );
  const cancelBooking = proveedor.adapter.cancelBooking;
  return {
    mem,
    audit,
    queue,
    releaseCancelled,
    proveedor,
    vuelos,
    cancellations,
    service,
    cancelBooking,
    getBooking: proveedor.adapter.getBooking,
    cancelar: () => service.cancelOrder(TENANT, ORDEN, LOCALIZADOR, USER),
    ultimaOperacion: () => mem.operations(ORDEN).at(-1),
  };
}

type Banco = ReturnType<typeof banco>;

function pedido(): [HotelCancelRequest, SearchContext] {
  return [{ providerBookingId: LOCALIZADOR }, { tenantId: TENANT, requestId: ORDEN }];
}

/** Corre el paso pendiente de la verificación como lo haría el worker. */
async function correrVerificacion(b: Banco, final = false): Promise<void> {
  const job = b.queue.cancelVerifications.at(-1);
  if (job === undefined) throw new Error('no se encoló ninguna verificación');
  await b.cancellations.runJob(job, { final });
}

describe('RF-25 CA-1: 479 con la reserva vigente', () => {
  it('la orden vuelve a su estado, la operación queda rechazada y se emite el intento fallido', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({
        success: false,
        error: 'TBO_CANCEL_FAIL',
        bookingStatus: 'CONFIRMED',
        providerStatus: 'Confirmed',
      }),
    );

    const { result, order } = await b.cancelar();

    expect(result).toMatchObject({ success: false, error: 'TBO_CANCEL_FAIL' });
    expect(order).toBeUndefined();
    expect(b.mem.order(ORDEN)?.['status']).toBe('confirmed');
    expect(b.ultimaOperacion()).toMatchObject({ status: 'failed' });
    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({
      outcome: 'FAILED',
      retryable: false,
      reconciliationRequired: false,
      reason: 'provider-rejected',
      priorOrderStatus: 'confirmed',
      vertical: 'hotels',
      bookingStatus: 'CONFIRMED',
      errorCode: 'TBO_CANCEL_FAIL',
    });
    expect(b.audit.ofType(ORDER_EVENTS.cancelled)).toMatchObject([
      { payload: { provider: PROVEEDOR, success: false } },
    ]);
    // El claim no queda puesto y la lectura quedó registrada; no hay nada que verificar.
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      sub_status: null,
      provider_status: 'Confirmed',
      provider_status_source: 'cancel',
      cancel_verify_next_at: null,
    });
    expect(b.queue.cancelVerifications).toEqual([]);
    expect(b.releaseCancelled).not.toHaveBeenCalled();
  });
});

describe('RF-25 CA-2: 200 con la cancelación en curso (D-TBO-25 A)', () => {
  it('"Cancelación en curso": pending, operación exitosa, sin reembolso del proveedor y con la lectura agendada', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({
        bookingStatus: 'CANCELLATION_IN_PROGRESS',
        providerStatus: 'CxlRequestSentToHotel',
        refundAmount: { amountMinor: 1, currency: 'USD' },
      }),
    );
    const antes = Date.now();

    const { result, order } = await b.cancelar();

    expect(b.cancelBooking).toHaveBeenCalledOnce();
    expect(b.cancelBooking).toHaveBeenCalledWith(...pedido());
    expect(result).toEqual({
      success: true,
      warnings: [],
      settlement: 'in-progress',
      estimatedPenalty: { amountMinor: 20_000, currency: 'USD' },
      bookingStatus: 'CANCELLATION_IN_PROGRESS',
      providerStatus: 'CxlRequestSentToHotel',
    });
    // `refundAmount` nunca, aunque el adapter lo mande: una estimación no es dato del proveedor.
    expect(result).not.toHaveProperty('refundAmount');
    expect(order?.status).toBe('pending');
    expect(b.ultimaOperacion()).toMatchObject({ status: 'success' });
    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({
      outcome: 'SUCCEEDED',
      settlement: 'in-progress',
      verifyScheduled: true,
      estimate: { kind: 'estimated', penalty: { amountMinor: 20_000 }, basis: 'charged' },
    });

    const t = b.mem.tracking(ORDEN);
    expect(t).toMatchObject({ sub_status: null, provider_status: 'CxlRequestSentToHotel' });
    expect(t?.cancel_verify_step).toBe(0);
    expect(t?.cancel_verify_anchor_at).toBeGreaterThanOrEqual(antes);
    expect(t?.cancel_verify_next_at).toBe((t?.cancel_verify_anchor_at ?? 0) + 2 * MIN);

    // RF-38: un job por paso, con `delay` y un jobId que BullMQ acepta.
    const [job] = b.queue.jobs.filter((j) => j.name === 'verify-cancellation');
    expect(job?.rejection).toBeUndefined();
    expect(job?.jobId?.split(':')).toHaveLength(3);
    expect(job?.delayMs).toBeGreaterThan(MIN);
    expect(bullMqJobIdRejection(job?.jobId ?? '')).toBeUndefined();
    // La retención sigue: la habitación todavía es cobrable.
    expect(b.releaseCancelled).not.toHaveBeenCalled();
  });

  it('una segunda cancelación no sale: la primera sigue pedida', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(respuesta({ bookingStatus: 'CANCELLATION_IN_PROGRESS' }));
    await b.cancelar();

    await expect(b.cancelar()).rejects.toBeInstanceOf(ConflictException);
    expect(b.cancelBooking).toHaveBeenCalledOnce();
  });

  it('la verificación la cierra cuando el proveedor la muestra cancelada, y libera la retención', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({ bookingStatus: 'CANCELLATION_IN_PROGRESS', providerStatus: 'CancelPending' }),
    );
    await b.cancelar();
    b.getBooking.mockResolvedValue({
      found: true,
      providerBookingId: LOCALIZADOR,
      status: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    });

    await correrVerificacion(b);

    expect(b.getBooking).toHaveBeenCalledWith(LOCALIZADOR, { tenantId: TENANT, requestId: ORDEN });
    expect(b.cancelBooking).toHaveBeenCalledOnce();
    expect(b.mem.order(ORDEN)?.['status']).toBe('cancelled');
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      provider_status: 'Cancelled',
      provider_status_source: 'verify',
      cancel_verify_next_at: null,
    });
    expect(b.releaseCancelled).toHaveBeenCalledWith(TENANT, ORDEN, USER);
    expect(b.audit.ofType(ORDER_EVENTS.providerStatusChanged).at(-1)?.payload).toMatchObject({
      source: 'verify',
      previous: 'CancelPending',
      current: 'Cancelled',
    });
  });

  it('mientras siga en curso, lee en el paso siguiente; agotado el calendario, escala cancellation-stuck', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(respuesta({ bookingStatus: 'CANCELLATION_IN_PROGRESS' }));
    await b.cancelar();
    b.getBooking.mockResolvedValue({
      found: true,
      providerBookingId: LOCALIZADOR,
      status: 'CANCELLATION_IN_PROGRESS',
      providerStatus: 'CxlRequestSentToHotel',
      warnings: [],
    });

    for (let paso = 0; paso < 5; paso += 1) await correrVerificacion(b);

    expect(b.queue.cancelVerifications.map((j) => j.step)).toEqual([0, 1, 2, 3, 4]);
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      cancel_verify_step: 5,
      cancel_verify_next_at: null,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated).map((e) => e.payload?.['reason'])).toEqual([
      'cancellation-stuck',
    ]);
    expect(b.cancelBooking).toHaveBeenCalledOnce();
  });

  it('200 y ya cancelada: cancelled en el acto, final, y la retención se libera', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({
        bookingStatus: 'CANCELLED',
        providerStatus: 'CancelledAndRefundAwaited',
        refundAwaited: true,
      }),
    );

    const { result, order } = await b.cancelar();

    expect(result).toMatchObject({ success: true, settlement: 'final', refundAwaited: true });
    expect(order?.status).toBe('cancelled');
    expect(b.mem.tracking(ORDEN)).toMatchObject({ refund_awaited: true, sub_status: null });
    expect(b.queue.cancelVerifications).toEqual([]);
    expect(b.releaseCancelled).toHaveBeenCalledWith(TENANT, ORDEN, USER);
  });
});

describe('RF-25 CA-3: timeout en /Cancel', () => {
  function timeout(): TboApiError {
    return new TboApiError({
      status: 0,
      path: '/Cancel',
      kind: 'TRANSPORT',
      requestId: 'req-timeout',
      timedOut: true,
    });
  }

  it('UNVERIFIED, cero segundos Cancel, y una lectura de sólo lectura que la cierra en la dirección segura', async () => {
    const b = banco();
    b.cancelBooking.mockRejectedValue(timeout());

    await expect(b.cancelar()).rejects.toThrow(/no confirmó si la cancelación se aplicó/);

    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({
      outcome: 'UNVERIFIED',
      retryable: false,
      reconciliationRequired: true,
    });
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      sub_status: 'cancel-unverified',
      cancel_verify_step: 0,
    });
    // Nada entra a la cola de reintentos del write; sólo la lectura.
    expect(b.queue.cancels).toEqual([]);
    expect(b.queue.cancelVerifications).toHaveLength(1);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toMatchObject([
      { payload: { reason: 'write-unverified', verifyScheduled: true } },
    ]);

    // Ni el endpoint principal, ni el reintento, ni un job viejo mandan otro Cancel.
    await expect(b.cancelar()).rejects.toBeInstanceOf(ConflictException);
    const op = String(b.ultimaOperacion()?.['id']);
    await expect(b.service.retryOperation(TENANT, ORDEN, op, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await b.service.runCancelById(TENANT, ORDEN);
    expect(b.cancelBooking).toHaveBeenCalledOnce();

    // PV-B: la lectura la ve cancelada → se cierra, y la operación deja de pedir conciliación.
    b.getBooking.mockResolvedValue({
      found: true,
      providerBookingId: LOCALIZADOR,
      status: 'CANCELLED',
      providerStatus: 'Cancelled',
      warnings: [],
    });
    await correrVerificacion(b);

    expect(b.mem.order(ORDEN)?.['status']).toBe('cancelled');
    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({
      outcome: 'SUCCEEDED',
      resolvedBy: 'verify-cancellation',
    });
    // La fila no tenía lectura anterior (el Book no la registra): el cierre igual deja su evento.
    expect(b.audit.ofType(ORDER_EVENTS.providerStatusChanged)).toMatchObject([
      { payload: { source: 'verify', previous: null, current: 'Cancelled' } },
    ]);
    expect(b.cancelBooking).toHaveBeenCalledOnce();
  });

  it('PV-B: si la lectura la ve vigente, a una persona con la evidencia; nunca otro Cancel', async () => {
    const b = banco();
    b.cancelBooking.mockRejectedValue(timeout());
    await b.cancelar().catch(() => undefined);
    b.getBooking.mockResolvedValue({
      found: true,
      providerBookingId: LOCALIZADOR,
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      warnings: [],
    });

    await correrVerificacion(b);

    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.mem.tracking(ORDEN)).toMatchObject({
      sub_status: 'cancel-unverified',
      provider_status: 'Confirmed',
      cancel_verify_next_at: null,
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'cancellation-unverified',
      source: 'verify',
    });
    expect(b.cancelBooking).toHaveBeenCalledOnce();
  });

  it('una respuesta de /Cancel ilegible también es UNVERIFIED, nunca FAILED', async () => {
    const b = banco();
    b.cancelBooking.mockRejectedValue(
      new TboCancelMappingError('/Cancel', ['Status.Code:unknown_code'], 'req-x'),
    );

    await expect(b.cancelar()).rejects.toBeInstanceOf(ConflictException);

    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({ outcome: 'UNVERIFIED' });
    expect(b.mem.tracking(ORDEN)).toMatchObject({ sub_status: 'cancel-unverified' });
  });
});

describe('RF-25 CA-4: falla la lectura previa, antes de enviar', () => {
  it('fallo previo al envío y reintentable, con un jobId que BullMQ acepta; el reintento cancela', async () => {
    const b = banco();
    const lecturaPrevia = new TboApiError({
      status: 0,
      path: '/BookingDetail',
      kind: 'TRANSPORT',
      requestId: 'req-pre',
    });
    b.cancelBooking.mockRejectedValueOnce(lecturaPrevia);

    await expect(b.cancelar()).rejects.toBe(lecturaPrevia);

    expect(b.mem.order(ORDEN)?.['status']).toBe('confirmed');
    expect(b.mem.result(b.ultimaOperacion())).toMatchObject({
      outcome: 'FAILED',
      retryable: true,
      reason: 'pre-write-transient',
    });
    // El claim se soltó y no hay lectura que agendar: el write nunca salió.
    expect(b.mem.tracking(ORDEN)).toMatchObject({ sub_status: null, cancel_verify_next_at: null });
    expect(b.queue.cancelVerifications).toEqual([]);
    const [reintento] = b.queue.jobs.filter((j) => j.name === 'cancel');
    expect(reintento?.jobId).toBe(`cancel:${ORDEN}:${String(b.ultimaOperacion()?.['id'])}`);
    expect(reintento?.rejection).toBeUndefined();

    // El worker toma el mismo claim y, esta vez, el proveedor contesta.
    b.cancelBooking.mockResolvedValue(respuesta({ bookingStatus: 'CANCELLED' }));
    await b.service.runCancelById(TENANT, ORDEN);

    expect(b.cancelBooking).toHaveBeenCalledTimes(2);
    expect(b.mem.order(ORDEN)?.['status']).toBe('cancelled');
    expect(b.mem.calls.filter((c) => c.method === 'markRequested')).toHaveLength(2);
  });

  it('el rechazo del breaker (no salió nada) también es reintentable', async () => {
    process.env['PROVIDERS_DISABLED'] = PROVEEDOR;
    try {
      const b = banco();
      await expect(b.cancelar()).rejects.toMatchObject({ sentToProvider: false });
      expect(b.cancelBooking).not.toHaveBeenCalled();
      expect(b.mem.result(b.ultimaOperacion())).toMatchObject({ retryable: true });
      expect(b.mem.order(ORDEN)?.['status']).toBe('confirmed');
    } finally {
      delete process.env['PROVIDERS_DISABLED'];
    }
  });
});

describe('la cuenta de la reserva y lo que no es de hoteles', () => {
  it('con la cuenta de la reserva fuera de la red, el 409 sale antes del claim y sin llamar', async () => {
    const b = banco();
    b.proveedor.cuentaDisponible = false;

    await expect(b.cancelar()).rejects.toBeInstanceOf(ProviderOrderAccountUnavailableError);

    expect(b.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.operations(ORDEN)).toEqual([]);
    expect(b.mem.tracking(ORDEN)).toBeUndefined();
  });

  it('una orden de vuelos sigue por el adapter de vuelos, sin tocar el seguimiento de hoteles', async () => {
    const vuelo = ordenHotel({ id: 'f1', provider: 'stub-air', provider_order_id: 'PNR1' });
    const b = banco([vuelo]);

    const { result } = await b.service.cancelOrder(TENANT, 'f1', 'PNR1', USER);

    expect(result.success).toBe(true);
    expect(b.vuelos.adapterFor(TENANT).cancelOrder).toHaveBeenCalledOnce();
    expect(b.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.calls).toEqual([]);
  });

  it('la compensación selectiva no existe para un hotel', async () => {
    const b = banco();
    await b.service.runCompensation(TENANT, ORDEN, ['1'], USER);
    expect(b.cancelBooking).not.toHaveBeenCalled();
    expect(b.mem.operations(ORDEN)).toEqual([]);
  });

  it('la penalidad estimada sale del snapshot del PreBook; una orden de vuelos no la tiene', () => {
    const b = banco();
    expect(b.service.cancellationEstimate(ordenHotel() as never)).toMatchObject({
      kind: 'estimated',
      penalty: { amountMinor: 20_000, currency: 'USD' },
      base: { amountMinor: 80_000, currency: 'USD' },
    });
    expect(() =>
      b.service.cancellationEstimate({ provider: 'stub-air', selected_offer: {} }),
    ).toThrow(/sólo existe para reservas de hotel/);
  });

  it('ningún evento lleva datos del huésped', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(respuesta({ bookingStatus: 'CANCELLED' }));
    await b.cancelar();

    expect(b.audit.dump()).not.toContain('Ana');
    expect(b.audit.dump()).not.toContain('ana@x.test');
  });
});

describe('un estado que el proveedor no documenta', () => {
  it('aceptada: sigue en curso con el subestado unknown; nunca sale crudo por la API', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({ bookingStatus: 'UNKNOWN', providerStatus: 'estado raro del hotel' }),
    );

    const { result } = await b.cancelar();

    expect(result).toMatchObject({ settlement: 'in-progress', providerStatus: 'unknown' });
    expect(b.mem.order(ORDEN)?.['status']).toBe('pending');
    expect(b.mem.tracking(ORDEN)?.sub_status).toBe('unknown');
    expect(b.audit.dump()).not.toContain('estado raro del hotel');
  });

  it('rechazada sin mandar nada: la orden vuelve a su estado, a revisión', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({
        success: false,
        error: 'TBO_BOOKING_STATUS_UNKNOWN',
        bookingStatus: 'UNKNOWN',
        providerStatus: 'Frozen',
      }),
    );

    await b.cancelar();

    expect(b.mem.order(ORDEN)?.['status']).toBe('confirmed');
    expect(b.mem.tracking(ORDEN)?.sub_status).toBe('unknown');
    expect(b.audit.ofType(ORDER_EVENTS.escalated).at(-1)?.payload).toMatchObject({
      reason: 'provider-status-unknown',
      source: 'cancel',
    });
  });
});

describe('la lectura que sigue a un 479 sin lectura', () => {
  it('un rechazo cuya lectura falló agenda UNA lectura; si ve la reserva vigente, no queda nada que hacer', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValue(
      respuesta({
        success: false,
        error: 'TBO_CANCEL_FAIL',
        warnings: ['POST_CANCEL_READ_FAILED'],
      }),
    );
    await b.cancelar();
    expect(b.mem.order(ORDEN)?.['status']).toBe('confirmed');
    const vista: HotelBookingView = {
      found: true,
      providerBookingId: LOCALIZADOR,
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      warnings: [],
    };
    b.getBooking.mockResolvedValue(vista);

    await correrVerificacion(b);

    expect(b.mem.tracking(ORDEN)).toMatchObject({
      provider_status: 'Confirmed',
      cancel_verify_next_at: null,
    });
    expect(b.queue.cancelVerifications).toHaveLength(1);
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
  });

  it('una cancelación nueva de la misma orden apaga ese calendario y abre el suyo', async () => {
    const b = banco();
    b.cancelBooking.mockResolvedValueOnce(
      respuesta({
        success: false,
        error: 'TBO_CANCEL_FAIL',
        warnings: ['POST_CANCEL_READ_FAILED'],
      }),
    );
    await b.cancelar();
    const viejo = b.queue.cancelVerifications[0];

    // Un rechazo no reintentable bloquea otra cancelación por el endpoint; aquí operaciones ya
    // resolvió ese intento y el vendedor vuelve a cancelar, más tarde.
    b.mem.state.operations.splice(0);
    b.cancelBooking.mockResolvedValue(respuesta({ bookingStatus: 'CANCELLATION_IN_PROGRESS' }));
    const despues = Date.now() + 10 * MIN;
    const reloj = vi.spyOn(Date, 'now').mockReturnValue(despues);
    try {
      await b.cancelar();
    } finally {
      reloj.mockRestore();
    }

    const nuevo = b.queue.cancelVerifications.at(-1);
    expect(nuevo?.anchorAt).not.toBe(viejo?.anchorAt);
    // El job del calendario anterior ya no ejecuta nada.
    await b.cancellations.runJob(viejo, { final: false });
    expect(b.getBooking).not.toHaveBeenCalled();
  });
});
