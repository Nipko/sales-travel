import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { HotelBookingView, SearchContext } from '@sales-travel/domain';
import { TboDispatchRejectedError } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { HotelProviderCapabilities } from '../providers/hotel-provider.types.js';
import { memoryDb, type Row } from '../orders/__fixtures__/memory-orders-db.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import { CREATE_PENDING_RECONCILIATION_MARKER } from '../orders/order-create-intent.store.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { MemoryVerificationStore } from './__fixtures__/memory-verification-store.js';
import {
  HOTEL_BOOK_VERIFY_ENQUEUE_WAIT_MS,
  HotelBookingVerificationService,
  HotelVerificationJobInvalidError,
  type HotelVerificationSweepReport,
} from './hotel-booking-verification.service.js';

/**
 * La verificación de una reserva de hotel sin respuesta (docs/tbo/09 PR-4.7; 08 RF-21 CA 1 a 4,
 * RNF-10; 03 §4.2, §4.3 y §4.6; 04 §7), con el registry, el breaker, el intent de órdenes y la
 * cola REALES sobre sus dobles (Postgres en memoria, cola que graba) y un proveedor ANÓNIMO.
 *
 * El reloj es falso: lo que se afirma es CUÁNDO sale cada lectura, no sólo que sale.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const USUARIO = '55555555-5555-4555-8555-555555555555';
const CUENTA = '66666666-6666-4666-8666-666666666666';
const OTRA_CUENTA = '77777777-7777-4777-8777-777777777777';
const STUB = 'stub-hotels';
const REF = 'STT7K2M9QX4D8R1VZ6AB';
const MIN = 60_000;
const TF = Date.parse('2026-09-25T15:02:00Z');

type Leer = Mock<(ref: string, ctx: SearchContext) => Promise<HotelBookingView>>;

interface Opciones {
  capabilities?: Partial<HotelProviderCapabilities>;
  redis?: boolean;
  /** La cuenta con la que lee hoy el adapter del tenant. */
  cuenta?: string;
  failResolveWith?: Error;
}

function banco(opts: Opciones = {}) {
  const stub = new StubHotelProviderFactory({
    code: STUB,
    ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
    ...(opts.failResolveWith === undefined ? {} : { failResolveWith: opts.failResolveWith }),
    circuit: { accountRef: 'huella-de-la-cuenta' },
  });
  const adapter = stub.adapterFor(AGENCIA);
  const leer: Leer = vi.fn(() => Promise.resolve<HotelBookingView>({ found: false, warnings: [] }));
  const bookWithContext = vi.fn();
  Object.assign(adapter, {
    getBookingByClientReference: leer,
    bookWithContext,
    searchAccount: { accountId: opts.cuenta ?? CUENTA, updatedAt: '2026-09-01T00:00:00.000Z' },
  });
  const memory = memoryDb();
  const intents = new ExternalOrderIntentService(memory.db);
  const tracking = new MemoryVerificationStore(() => memory.rows());
  const queue = new RecordingQueueService(opts.redis ?? true);
  const emit = vi.fn((_event: unknown) => Promise.resolve());
  const service = new HotelBookingVerificationService(
    hotelRegistry([stub], hotelFlags(true)),
    tracking.asStore(),
    intents,
    new CircuitBreakerService(),
    { emit } as unknown as AuditService,
    queue.asService(),
  );
  return { service, adapter, leer, bookWithContext, memory, intents, tracking, queue, emit };
}

type Banco = ReturnType<typeof banco>;

/** Una orden de hotel abierta con su referencia, como la deja la saga antes del Book. */
async function orden(
  b: Banco,
  opts: { tenantId?: string; cuenta?: string | null; ref?: string } = {},
): Promise<Row> {
  const intent = await b.intents.openExternalCreateIntent(opts.tenantId ?? AGENCIA, USUARIO, {
    provider: STUB,
    vertical: 'hotels',
    idempotencyKey: randomUUID(),
    searchCriteria: { hotelId: 'H-1' },
    selectedOffer: { offerRef: 'R-1' },
    passengers: [{ room: 0 }],
    contactInfo: { email: 'cliente@example.com' },
    totalAmountMinor: 34_012,
    currency: 'USD',
    providerBookingRef: opts.ref ?? REF,
    providerAccountId: opts.cuenta === undefined ? CUENTA : opts.cuenta,
  });
  const row = b.memory.rows().find((r) => r['id'] === intent.id);
  if (row === undefined) throw new Error('sin orden');
  return row;
}

/** Orden incierta con su calendario abierto a `tf`. */
async function incierta(b: Banco, tf = TF): Promise<string> {
  const row = await orden(b);
  const id = String(row['id']);
  await b.service.scheduleAfterUncertainBook({
    tenantId: AGENCIA,
    orderId: id,
    failedAt: tf,
    actorUserId: USUARIO,
  });
  return id;
}

function eventos(b: Banco): { eventType: string; payload: Record<string, unknown> }[] {
  return b.emit.mock.calls.map(
    ([e]) => e as { eventType: string; payload: Record<string, unknown> },
  );
}

function escalados(b: Banco): Record<string, unknown>[] {
  return eventos(b)
    .filter((e) => e.eventType === ORDER_EVENTS.escalated)
    .map((e) => e.payload);
}

function job(orderId: string, step: number) {
  return { tenantId: AGENCIA, orderId, step, actorUserId: USUARIO };
}

const CONFIRMADA: HotelBookingView = {
  found: true,
  providerBookingId: 'CONF-1',
  bookingReference: REF,
  status: 'CONFIRMED',
  providerStatus: 'Confirmed',
  warnings: [],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: TF });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('la saga abre el calendario: primera lectura a `tf + 120 s` (RF-21 CA-1)', () => {
  it('lo escribe en Postgres y encola el paso 0 con el retardo que falta hasta su hora', async () => {
    const b = banco();
    const row = await orden(b);
    const id = String(row['id']);
    vi.setSystemTime(TF + 30_000);

    const res = await b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: id,
      failedAt: TF,
      actorUserId: USUARIO,
    });

    expect(res).toEqual({ verifyAt: TF + 120_000, tracked: true, queued: true });
    expect(b.tracking.tracking.get(id)).toMatchObject({
      anchorAt: TF,
      step: 0,
      nextAt: TF + 120_000,
      subStatus: 'create-uncertain',
    });
    expect(b.queue.jobs).toEqual([
      {
        name: 'verify-hotel-booking',
        data: { tenantId: AGENCIA, orderId: id, step: 0, actorUserId: USUARIO },
        jobId: `verify-hotel-booking:${id}:0`,
        delayMs: 90_000,
      },
    ]);
    // Encolar no es leer: nada sale hacia el proveedor antes de la hora.
    expect(b.leer).not.toHaveBeenCalled();
  });

  it('sin actor, el job no lo inventa', async () => {
    const b = banco();
    const id = String((await orden(b))['id']);

    await b.service.scheduleAfterUncertainBook({ tenantId: AGENCIA, orderId: id, failedAt: TF });

    expect(b.queue.hotelVerifications).toEqual([{ tenantId: AGENCIA, orderId: id, step: 0 }]);
  });

  it('sin Redis: el calendario queda escrito y `queued: false`', async () => {
    const b = banco({ redis: false });
    const id = String((await orden(b))['id']);

    const res = await b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: id,
      failedAt: TF,
    });

    expect(res).toEqual({ verifyAt: TF + 120_000, tracked: true, queued: false });
    expect(b.tracking.tracking.get(id)?.step).toBe(0);
  });

  it('con Redis configurado pero caído la cola no contesta: a los 5 s sigue con `queued: false`', async () => {
    // El `beforeEach` sólo falsea `Date`: sin volver a los reales, `useFakeTimers` no se reconfigura.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: TF });
    const b = banco();
    const id = String((await orden(b))['id']);
    // BullMQ espera la conexión sin límite (`maxRetriesPerRequest: null`).
    vi.spyOn(b.queue, 'enqueueVerifyHotelBooking').mockReturnValue(new Promise(() => undefined));

    const programado = b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: id,
      failedAt: TF,
    });
    let res: unknown;
    void programado.then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(HOTEL_BOOK_VERIFY_ENQUEUE_WAIT_MS - 1);
    expect(res).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(programado).resolves.toEqual({
      verifyAt: TF + 120_000,
      tracked: true,
      queued: false,
    });
    expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
  });

  it('si Postgres no lo escribe, no encola nada y no lanza: lo adopta el barrido', async () => {
    const b = banco();
    const id = String((await orden(b))['id']);
    b.tracking.fallas.startCalendar = new Error('hotel_order_tracking no disponible');

    const res = await b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: id,
      failedAt: TF,
    });

    expect(res).toEqual({ verifyAt: TF + 120_000, tracked: false, queued: false });
    expect(b.queue.jobs).toEqual([]);
  });

  it('si la orden ya tenía calendario, no lo reinicia ni encola otro paso 0', async () => {
    const b = banco();
    const id = await incierta(b);

    const res = await b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: id,
      failedAt: TF + MIN,
    });

    expect(res.tracked).toBe(false);
    expect(b.tracking.tracking.get(id)?.anchorAt).toBe(TF);
    expect(b.queue.jobs).toHaveLength(1);
  });
});

describe('el job `verify-hotel-booking`: un paso, sólo si sigue vigente', () => {
  it('un payload que no es el de la cola se rechaza sin leer, sin eco de valores', async () => {
    const b = banco();

    const err = await b.service
      .runJob({ tenantId: 'no-uuid', orderId: 'a:b', step: 9, extra: 1 }, { final: false })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelVerificationJobInvalidError);
    expect((err as Error).message).toBe(
      'job verify-hotel-booking inválido (tenantId:invalid_string, orderId:invalid_string, step:too_big, (raíz):unrecognized_keys)',
    );
    expect(b.leer).not.toHaveBeenCalled();
  });

  it.each([
    [
      'de otro tenant',
      async (b: Banco) => ({ ...job(await incierta(b), 0), tenantId: OTRA_AGENCIA }),
    ],
    ['de un paso que otro camino ya hizo', async (b: Banco) => job(await incierta(b), 1)],
    [
      'de una orden ya consolidada',
      async (b: Banco) => {
        const id = await incierta(b);
        await b.intents.settleExternalCreateIntent(
          AGENCIA,
          { id },
          {
            status: 'confirmed',
            providerOrderId: 'CONF-1',
            providerRaw: { reason: 'confirmed' },
          },
        );
        return job(id, 0);
      },
    ],
    ['de una orden sin calendario', async (b: Banco) => job(String((await orden(b))['id']), 0)],
  ])('un job %s no lee ni escribe nada', async (_caso, armar) => {
    const b = banco();
    const data = await armar(b);
    vi.setSystemTime(TF + 120_000);
    b.emit.mockClear();

    await b.service.runJob(data, { final: false });

    expect(b.leer).not.toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
  });

  describe('la encuentra confirmada (03 §4.3)', () => {
    it('consolida con el mismo CAS de la saga y el localizador de la lectura', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue(CONFIRMADA);
      vi.setSystemTime(TF + 120_000);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.leer).toHaveBeenCalledWith(REF, { tenantId: AGENCIA, requestId: id });
      const row = b.memory.rows()[0];
      expect(row).toMatchObject({
        status: 'confirmed',
        provider_order_id: 'CONF-1',
        error_message: null,
        create_request_key: expect.stringMatching(/^c:/) as unknown,
      });
      expect(JSON.parse(String(row?.['provider_raw']))).toEqual({
        vertical: 'hotels',
        bookingReference: REF,
        reason: 'recovered-by-reference',
        providerStatus: 'Confirmed',
        recoveredBy: 'booking-reference',
        phase: 'create',
        outcome: 'CONFIRMED',
      });
      expect(b.tracking.tracking.get(id)).toMatchObject({
        step: 1,
        nextAt: null,
        subStatus: null,
        providerStatus: 'Confirmed',
        providerStatusAt: TF + 120_000,
      });
      expect(eventos(b).map((e) => e.eventType)).toEqual([ORDER_EVENTS.verified]);
      expect(eventos(b)[0]?.payload).toEqual({
        provider: STUB,
        vertical: 'hotels',
        bookingReference: REF,
        verified: true,
        found: true,
        status: 'CONFIRMED',
        recoveredBy: 'booking-reference',
        providerBookingId: 'CONF-1',
        providerStatus: 'Confirmed',
        step: 0,
      });
      // Consolidada, el calendario no encola nada más.
      expect(b.queue.hotelVerifications).toHaveLength(1);
    });

    it('sin estado crudo, no inventa uno', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue({ ...CONFIRMADA, providerStatus: undefined });

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.tracking.tracking.get(id)).toMatchObject({ providerStatus: null, subStatus: null });
      expect(eventos(b)[0]?.payload).not.toHaveProperty('providerStatus');
    });

    it('si otro camino la cerró antes, no emite nada: que emita quien la cerró', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue(CONFIRMADA);
      vi.spyOn(b.intents, 'settleExternalCreateIntent').mockResolvedValue(undefined);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.emit).not.toHaveBeenCalled();
      expect(b.tracking.tracking.get(id)?.step).toBe(0);
    });

    it('si el seguimiento no se escribe, la orden ya dice `confirmed` y el evento sale igual', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue(CONFIRMADA);
      b.tracking.fallas.advance = new Error('hotel_order_tracking no disponible');

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.memory.rows()[0]?.['status']).toBe('confirmed');
      expect(eventos(b).map((e) => e.eventType)).toEqual([ORDER_EVENTS.verified]);
    });
  });

  describe('no aparece: el calendario sigue, y agotado queda para la conciliación (D-TBO-24 A)', () => {
    it('paso 0 sin reserva → paso 1 a `tf + 5 min`, encolado con su retardo', async () => {
      const b = banco();
      const id = await incierta(b);
      vi.setSystemTime(TF + 121_000);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 1, nextAt: TF + 5 * MIN });
      expect(b.queue.jobs[1]).toEqual({
        name: 'verify-hotel-booking',
        data: { tenantId: AGENCIA, orderId: id, step: 1, actorUserId: USUARIO },
        jobId: `verify-hotel-booking:${id}:1`,
        delayMs: 5 * MIN - 121_000,
      });
      expect(b.emit).not.toHaveBeenCalled();
    });

    it('sin Redis para el paso siguiente, la fila ya tiene su hora: lo recoge el barrido', async () => {
      const b = banco({ redis: false });
      const id = await incierta(b);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 1, nextAt: TF + 5 * MIN });
      expect(b.emit).not.toHaveBeenCalled();
    });

    it('si otro camino avanzó el paso, no encola un duplicado', async () => {
      const b = banco();
      const id = await incierta(b);
      vi.spyOn(b.tracking, 'advance').mockResolvedValue(false);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.queue.hotelVerifications).toHaveLength(1);
    });

    it('el último paso sin reserva: `create-not-found-yet`, `pending` con la clave, nunca `failed`', async () => {
      const b = banco();
      const id = await incierta(b);
      const fila = b.tracking.tracking.get(id);
      if (fila) Object.assign(fila, { step: 3, nextAt: TF + 60 * MIN });
      vi.setSystemTime(TF + 60 * MIN);

      await b.service.runJob(job(id, 3), { final: false });

      expect(b.memory.rows()[0]).toMatchObject({
        status: 'pending',
        provider_raw: null,
        error_message: CREATE_PENDING_RECONCILIATION_MARKER,
        create_request_key: expect.stringMatching(/^c:/) as unknown,
      });
      expect(b.tracking.tracking.get(id)).toMatchObject({
        step: 4,
        nextAt: null,
        subStatus: 'create-not-found-yet',
      });
      expect(escalados(b)).toEqual([
        {
          provider: STUB,
          vertical: 'hotels',
          bookingReference: REF,
          reason: 'create-not-found',
          queued: false,
          step: 3,
          steps: 4,
          retryForbidden: true,
          reconciliationRequired: true,
        },
      ]);
    });

    it('el último paso ya cerrado por otro camino no escala dos veces', async () => {
      const b = banco();
      const id = await incierta(b);
      const fila = b.tracking.tracking.get(id);
      if (fila) Object.assign(fila, { step: 3, nextAt: TF + 60 * MIN });
      vi.spyOn(b.tracking, 'advance').mockResolvedValue(false);

      await b.service.runJob(job(id, 3), { final: false });

      expect(b.emit).not.toHaveBeenCalled();
    });
  });

  describe('lo encontrado no es una reserva confirmada: se deja de preguntar y la mira una persona', () => {
    it('cancelada del otro lado → `verified-cancelled-upstream`, con su localizador', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue({ ...CONFIRMADA, status: 'CANCELLED', providerStatus: 'Cancelled' });

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.memory.rows()[0]?.['status']).toBe('pending');
      expect(b.tracking.tracking.get(id)).toMatchObject({
        step: 1,
        nextAt: null,
        subStatus: 'create-uncertain',
        providerStatus: 'Cancelled',
      });
      expect(escalados(b)).toEqual([
        expect.objectContaining({
          reason: 'verified-cancelled-upstream',
          providerStatus: 'Cancelled',
          providerBookingId: 'CONF-1',
          step: 0,
        }),
      ]);
      expect(escalados(b)[0]).not.toHaveProperty('errorName');
    });

    it('un estado fuera del vocabulario → subestado `unknown`', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue({ found: true, status: 'UNKNOWN', warnings: [] });

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.tracking.tracking.get(id)).toMatchObject({ subStatus: 'unknown', nextAt: null });
      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'provider-status-unknown' }),
      ]);
      expect(escalados(b)[0]).not.toHaveProperty('providerStatus');
      expect(escalados(b)[0]).not.toHaveProperty('providerBookingId');
    });

    it('si otro camino ya detuvo el calendario, no escala dos veces', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockResolvedValue({ found: true, status: 'UNKNOWN', warnings: [] });
      vi.spyOn(b.tracking, 'advance').mockResolvedValue(false);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.emit).not.toHaveBeenCalled();
    });
  });

  describe('la lectura que falla no prueba nada', () => {
    it('transporte con intentos por delante: relanza el MISMO error para que la cola repita', async () => {
      const b = banco();
      const id = await incierta(b);
      const red = Object.assign(new Error('ECONNRESET'), { status: 0, retryable: true });
      b.leer.mockRejectedValue(red);

      await expect(b.service.runJob(job(id, 0), { final: false })).rejects.toBe(red);

      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
      expect(b.emit).not.toHaveBeenCalled();
    });

    it('en el último intento de la cola: escala, no avanza y deja el paso vencido al barrido', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { status: 503 }));

      await b.service.runJob(job(id, 0), { final: true });

      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
      expect(escalados(b)).toEqual([
        {
          provider: STUB,
          vertical: 'hotels',
          bookingReference: REF,
          reason: 'verification-unavailable',
          queued: false,
          step: 0,
          errorName: 'Error',
          retryForbidden: true,
          reconciliationRequired: true,
        },
      ]);
    });

    it('lo que se lanza sin ser un Error se nombra como desconocido, nunca con su contenido', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockRejectedValue('texto del proveedor con datos');

      await b.service.runJob(job(id, 0), { final: true });

      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'verification-unavailable', errorName: 'UnknownError' }),
      ]);
      expect(JSON.stringify(escalados(b))).not.toContain('texto del proveedor');
    });

    it('un job sin actor escala en nombre de quien hizo la orden', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockRejectedValue(new Error('red'));

      await b.service.runJob({ tenantId: AGENCIA, orderId: id, step: 0 }, { final: true });

      expect(b.emit.mock.calls.map(([e]) => (e as { actorUserId: string }).actorUserId)).toEqual([
        USUARIO,
      ]);
    });

    it('la cuenta no puede leer (401/402): escala al primer intento, sin reintentos', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockRejectedValue(
        Object.assign(new Error('401'), {
          name: 'TboApiError',
          failure: { kind: 'CREDENTIALS_INVALID', retry: 'NO_RETRY', notifyAccountOwner: true },
        }),
      );

      await b.service.runJob(job(id, 0), { final: false });

      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'provider-account-issue', errorName: 'TboApiError' }),
      ]);
      expect(b.tracking.tracking.get(id)?.step).toBe(0);
    });

    it('un error permanente detiene el calendario con escalamiento', async () => {
      const b = banco();
      const id = await incierta(b);
      b.leer.mockRejectedValue(Object.assign(new Error('x'), { name: 'TboRequestBuildError' }));

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 1, nextAt: null });
      expect(escalados(b)).toEqual([
        expect.objectContaining({
          reason: 'verification-unavailable',
          errorName: 'TboRequestBuildError',
        }),
      ]);
    });

    it('sin cupo en el limitador de la cuenta la lectura no salió: la cola repite, el calendario sigue', async () => {
      const b = banco();
      const id = await incierta(b);
      const sinCupo = new TboDispatchRejectedError('/BookingDetail', 'QUEUE_TIMEOUT', 30_000);
      b.leer.mockRejectedValue(sinCupo);

      await expect(b.service.runJob(job(id, 0), { final: false })).rejects.toBe(sinCupo);
      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });

      // Agotados los intentos queda vencido para el barrido; nunca se detiene como si fuera
      // un error determinista.
      await b.service.runJob(job(id, 0), { final: true });
      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
      expect(escalados(b)).toEqual([
        expect.objectContaining({
          reason: 'verification-unavailable',
          errorName: 'TboDispatchRejectedError',
        }),
      ]);
    });

    it('con el kill-switch de ventas la lectura sale igual: es post-venta', async () => {
      vi.stubEnv('PROVIDERS_DISABLED', `${STUB}:ventas`);
      const b = banco();
      const id = await incierta(b);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.leer).toHaveBeenCalledOnce();
    });

    it('con el proveedor apagado del todo, el breaker no la deja salir: que la cola repita', async () => {
      vi.stubEnv('PROVIDERS_DISABLED', STUB);
      const b = banco();
      const id = await incierta(b);

      await expect(b.service.runJob(job(id, 0), { final: false })).rejects.toMatchObject({
        name: 'BreakerRejectionError',
        sentToProvider: false,
      });
      expect(b.leer).not.toHaveBeenCalled();
    });
  });

  describe('lo que se sabe antes de leer', () => {
    it('el proveedor ya no está habilitado para el tenant → detenida, sin leer', async () => {
      // Sin cuenta resoluble, el registry responde `ProviderNotAvailableError` (400).
      const b = banco({ failResolveWith: new NotFoundException('sin cuenta') });
      const id = await incierta(b);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.leer).not.toHaveBeenCalled();
      expect(b.tracking.tracking.get(id)).toMatchObject({ nextAt: null });
      expect(escalados(b)).toEqual([
        expect.objectContaining({
          reason: 'verification-unavailable',
          errorName: 'ProviderNotAvailableError',
        }),
      ]);
    });

    it('la bóveda caída no detiene nada: es transitorio y la cola repite', async () => {
      const caida = new Error('bóveda no disponible');
      const b = banco({ failResolveWith: caida });
      const id = await incierta(b);

      await expect(b.service.runJob(job(id, 0), { final: false })).rejects.toBe(caida);
      expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
    });

    it('un proveedor que no lee por nuestra referencia nunca va a poder: detenida, sin leer', async () => {
      const b = banco({ capabilities: { retrieveByClientReference: false } });
      const id = await incierta(b);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.leer).not.toHaveBeenCalled();
      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'verification-unavailable' }),
      ]);
      expect(escalados(b)[0]).not.toHaveProperty('errorName');
    });

    it('un adapter sin el método de lectura tampoco', async () => {
      const b = banco();
      const id = await incierta(b);
      delete (b.adapter as unknown as Record<string, unknown>)['getBookingByClientReference'];

      await b.service.runJob(job(id, 0), { final: false });

      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'verification-unavailable' }),
      ]);
    });

    it('la agencia ya lee con otra cuenta: no se lee con ésa (diría "no está")', async () => {
      const b = banco({ cuenta: OTRA_CUENTA });
      const id = await incierta(b);

      await b.service.runJob(job(id, 0), { final: false });

      expect(b.leer).not.toHaveBeenCalled();
      expect(b.tracking.tracking.get(id)).toMatchObject({
        nextAt: null,
        subStatus: 'create-uncertain',
      });
      expect(escalados(b)).toEqual([
        expect.objectContaining({ reason: 'provider-account-changed' }),
      ]);
    });

    it('una orden sin cuenta guardada, o un adapter que no la expone, se lee igual', async () => {
      const b = banco({ cuenta: OTRA_CUENTA });
      const row = await orden(b, { cuenta: null });
      const id = String(row['id']);
      await b.service.scheduleAfterUncertainBook({ tenantId: AGENCIA, orderId: id, failedAt: TF });
      await b.service.runJob(job(id, 0), { final: false });

      const c = banco();
      delete (c.adapter as unknown as Record<string, unknown>)['searchAccount'];
      const id2 = await incierta(c);
      await c.service.runJob(job(id2, 0), { final: false });

      expect(b.leer).toHaveBeenCalledOnce();
      expect(c.leer).toHaveBeenCalledOnce();
    });
  });

  it('RF-21 CA-4: ninguna rama vuelve a reservar', async () => {
    const vistas: (HotelBookingView | Error)[] = [
      CONFIRMADA,
      { found: false, warnings: [] },
      { ...CONFIRMADA, status: 'CANCELLED' },
      { found: true, status: 'UNKNOWN', warnings: [] },
      Object.assign(new Error('red'), { status: 0 }),
      Object.assign(new Error('x'), { name: 'TboRequestBuildError' }),
    ];
    for (const vista of vistas) {
      for (const final of [false, true]) {
        const b = banco();
        const id = await incierta(b);
        if (vista instanceof Error) b.leer.mockRejectedValue(vista);
        else b.leer.mockResolvedValue(vista);

        await b.service.runJob(job(id, 0), { final }).catch(() => undefined);

        expect(b.bookWithContext).not.toHaveBeenCalled();
        expect(b.adapter.book).not.toHaveBeenCalled();
      }
    }
  });
});

describe('el barrido: lo que la cola perdió, tenant por tenant (RNF-10; RF-21 CA 2 y 3)', () => {
  it('RF-21 CA-3: sin Redis el paso 0 no se encoló, y el barrido lo ejecuta pasado su margen', async () => {
    const b = banco({ redis: false });
    const id = await incierta(b);

    // Antes de `tf + 120 s + margen` no lo toca: podría estar corriendo como job.
    let report = await b.service.sweepTenant(AGENCIA, TF + 120_000 + 4 * MIN);
    expect(report.examined).toBe(0);
    expect(b.leer).not.toHaveBeenCalled();

    vi.setSystemTime(TF + 7 * MIN);
    report = await b.service.sweepTenant(AGENCIA);

    // Llegó tarde: lee una vez, como el paso 1 que ya venció, y deja programado el 2.
    expect(b.leer).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ examined: 1, advanced: 1, adopted: 0, failed: 0 });
    expect(b.tracking.tracking.get(id)).toMatchObject({ step: 2, nextAt: TF + 15 * MIN });
  });

  it('con la cola colgada (Redis configurado y caído), el barrido avanza igual y no se queda esperando', async () => {
    // El `beforeEach` sólo falsea `Date`: sin volver a los reales, `useFakeTimers` no se reconfigura.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: TF });
    const b = banco({ redis: false });
    const id = await incierta(b);
    vi.spyOn(b.queue, 'enqueueVerifyHotelBooking').mockReturnValue(new Promise(() => undefined));
    vi.setSystemTime(TF + 7 * MIN);

    const barrido = b.service.sweepTenant(AGENCIA);
    let report: HotelVerificationSweepReport | undefined;
    void barrido.then((r) => (report = r));
    await vi.advanceTimersByTimeAsync(HOTEL_BOOK_VERIFY_ENQUEUE_WAIT_MS - 1);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(barrido).resolves.toMatchObject({ examined: 1, advanced: 1, failed: 0 });
    expect(b.tracking.tracking.get(id)).toMatchObject({ step: 2, nextAt: TF + 15 * MIN });
  });

  it('RF-21 CA-2: una orden abierta sin calendario (el proceso murió con el Book en vuelo) se adopta', async () => {
    const b = banco();
    const row = await orden(b);
    const id = String(row['id']);
    const escrita = TF - 20 * MIN;
    row['updated_at'] = new Date(escrita);
    b.leer.mockResolvedValue(CONFIRMADA);

    const report = await b.service.sweepTenant(AGENCIA, TF);

    const ancla = escrita + 150_000;
    expect(report).toMatchObject({ examined: 1, adopted: 1, consolidated: 1 });
    expect(b.tracking.tracking.get(id)).toMatchObject({ anchorAt: ancla, step: 3, nextAt: null });
    expect(escalados(b)).toEqual([
      {
        provider: STUB,
        vertical: 'hotels',
        bookingReference: REF,
        reason: 'create-uncertain',
        queued: false,
        detectedBy: 'sweeper',
        step: 2,
        verifyAfter: new Date(ancla + 15 * MIN).toISOString(),
        retryForbidden: true,
        reconciliationRequired: true,
      },
    ]);
    expect(b.memory.rows()[0]).toMatchObject({ status: 'confirmed', provider_order_id: 'CONF-1' });
    // Actor de los eventos: el de la orden.
    expect(b.emit.mock.calls.map(([e]) => (e as { actorUserId: string }).actorUserId)).toEqual([
      USUARIO,
      USUARIO,
    ]);
  });

  it('una orden recién escrita no es huérfana: el Book puede seguir en vuelo', async () => {
    const b = banco();
    const row = await orden(b);
    row['updated_at'] = new Date(TF - 6 * MIN);

    expect((await b.service.sweepTenant(AGENCIA, TF)).examined).toBe(0);
  });

  it('si la saga o otro barrido abrieron el calendario primero, no la adopta', async () => {
    const b = banco();
    const row = await orden(b);
    row['updated_at'] = new Date(TF - 20 * MIN);
    vi.spyOn(b.tracking, 'startCalendar').mockResolvedValue(false);

    const report = await b.service.sweepTenant(AGENCIA, TF);

    expect(report).toMatchObject({ examined: 1, skipped: 1, adopted: 0 });
    expect(b.leer).not.toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
  });

  it('un fallo de transporte en el barrido no avanza ni repite el aviso: la próxima corrida reintenta', async () => {
    const b = banco();
    const id = await incierta(b);
    b.leer.mockRejectedValue(Object.assign(new Error('red'), { status: 0 }));

    const report = await b.service.sweepTenant(AGENCIA, TF + 10 * MIN);

    expect(report).toMatchObject({ examined: 1, unavailable: 1 });
    expect(b.emit).not.toHaveBeenCalled();
    expect(b.tracking.tracking.get(id)).toMatchObject({ step: 0, nextAt: TF + 120_000 });
  });

  it('una orden que falla no frena a las demás', async () => {
    const b = banco();
    const primera = await incierta(b);
    const otra = await orden(b, { ref: 'STTOTRAREFERENCIA0001' });
    await b.service.scheduleAfterUncertainBook({
      tenantId: AGENCIA,
      orderId: String(otra['id']),
      failedAt: TF,
    });
    const advance = b.tracking.advance.bind(b.tracking);
    vi.spyOn(b.tracking, 'advance').mockImplementation((tenantId, orderId, from, next) =>
      orderId === primera
        ? Promise.reject(new Error('base caída'))
        : advance(tenantId, orderId, from, next),
    );

    const report = await b.service.sweepTenant(AGENCIA, TF + 10 * MIN);

    expect(report).toMatchObject({ examined: 2, failed: 1, advanced: 1 });
  });

  it('sólo el tenant que se barre: las órdenes de otro no se ven', async () => {
    const b = banco();
    await incierta(b);

    const report = await b.service.sweepTenant(OTRA_AGENCIA, TF + 10 * MIN);

    expect(report.examined).toBe(0);
    expect(b.leer).not.toHaveBeenCalled();
  });

  it('un calendario detenido o agotado no se vuelve a mirar', async () => {
    const b = banco();
    const id = await incierta(b);
    const fila = b.tracking.tracking.get(id);
    if (fila) Object.assign(fila, { step: 4, nextAt: null, subStatus: 'create-not-found-yet' });

    expect((await b.service.sweepTenant(AGENCIA, TF + 5 * 60 * MIN)).examined).toBe(0);
  });
});
