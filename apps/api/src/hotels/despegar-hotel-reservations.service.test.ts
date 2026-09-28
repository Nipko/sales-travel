import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DespegarApiError,
  type BookRequest,
  type CancelReservationRequest,
  type PaymentOptionsQuery,
  type PrebookQuery,
  type RecoveryRequest,
} from '@sales-travel/despegar-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HotelProviderAdapter } from '../providers/hotel-provider.types.js';
import { ProviderNotAvailableError } from '../providers/provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { StubHotelProviderFactory } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelRegistry,
  type FakeDespegarFactory,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';

/**
 * Rutas de reserva con los DTOs de Despegar (prebook, medios de pago, book, lectura,
 * cancelación y salto de precio).
 *
 * Los casos de "paso directo" son los de PR-0.1 (`hotels.service.test.ts`), que se mudaron con
 * las rutas: pedido y respuesta siguen pasando intactos. Lo que PR-0.5 cambia está marcado:
 * Despegar se resuelve por el registry, cada ruta se gatea por capacidad y todas pasan por el
 * circuito.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CODIGO = 'despegar-hotels';

const PREBOOK: PrebookQuery = { choiceId: 'CH-1', lang: 'es', include: ['HINTS'] };
const PAGOS: PaymentOptionsQuery = { prebookId: 'PB-0001', includeHints: true };
const BOOK: BookRequest = {
  prebookId: 'PB-0001',
  externalBookingReference: 'ISO-0001',
  contact: { email: 'reservas@agencia.example' },
  travelers: [{ referenceId: '1', firstName: 'Ana', lastName: 'Prueba' }],
  payment: { optionType: 'ONE_CARD', units: [{ planId: 'PL-1', secureToken: 'tok_hosted' }] },
};
const CANCEL: CancelReservationRequest = { reservationId: 'RES-0001', reason: 'ILLNESS' };
const RECOVERY: RecoveryRequest = {
  reservationId: 'RES-0001',
  messageType: 'PRICE_JUMP',
  confirmations: [{ flavorId: 'H0', confirm: true }],
};

interface Banco {
  service: DespegarHotelReservationsService;
  adapter: FakeDespegarHotelsAdapter;
  forTenant: FakeDespegarFactory['forTenant'];
  resolveForTenant: FakeDespegarFactory['resolveForTenant'];
  breaker: CircuitBreakerService;
}

function banco(): Banco {
  const adapter = new FakeDespegarHotelsAdapter();
  const { factory, forTenant, resolveForTenant } = fakeDespegarFactory(adapter);
  const breaker = new CircuitBreakerService();
  const service = new DespegarHotelReservationsService(hotelRegistry([factory]), factory, breaker);
  return { service, adapter, forTenant, resolveForTenant, breaker };
}

interface PasoDirecto {
  nombre: string;
  llamar: (s: DespegarHotelReservationsService) => Promise<unknown>;
  mock: (a: FakeDespegarHotelsAdapter) => Mock;
  argumento: unknown;
}

const PASOS: PasoDirecto[] = [
  {
    nombre: 'prebook',
    llamar: (s) => s.prebook(TENANT, PREBOOK),
    mock: (a) => a.prebook,
    argumento: PREBOOK,
  },
  {
    nombre: 'getPaymentOptions',
    llamar: (s) => s.getPaymentOptions(TENANT, PAGOS),
    mock: (a) => a.getPaymentOptions,
    argumento: PAGOS,
  },
  { nombre: 'book', llamar: (s) => s.book(TENANT, BOOK), mock: (a) => a.book, argumento: BOOK },
  {
    nombre: 'getReservation',
    llamar: (s) => s.getReservation(TENANT, 'RES-0001'),
    mock: (a) => a.getReservation,
    argumento: 'RES-0001',
  },
  {
    nombre: 'cancelReservation',
    llamar: (s) => s.cancelReservation(TENANT, CANCEL),
    mock: (a) => a.cancelReservation,
    argumento: CANCEL,
  },
  {
    nombre: 'recoverBooking',
    llamar: (s) => s.recoverBooking(TENANT, RECOVERY),
    mock: (a) => a.recoverBooking,
    argumento: RECOVERY,
  },
];

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('DespegarHotelReservationsService — paso directo (PR-0.1)', () => {
  it.each(PASOS)(
    '$nombre: el ACL del tenant recibe el MISMO objeto y su respuesta sale intacta',
    async ({ llamar, mock, argumento }) => {
      const b = banco();
      const res = await llamar(b.service);

      const m = mock(b.adapter);
      expect(b.forTenant).toHaveBeenCalledWith(TENANT);
      expect(m).toHaveBeenCalledTimes(1);
      expect(m.mock.calls[0]?.[0]).toBe(argumento);
      expect(res).toBe(await m.mock.results[0]?.value);
    },
  );

  it.each(PASOS)('$nombre: un error de Despegar sale sin traducir', async ({ llamar, mock }) => {
    const b = banco();
    const rechazo = new DespegarApiError(410, '{"message":"product expired"}', '/prebook');
    mock(b.adapter).mockRejectedValueOnce(rechazo);

    await expect(llamar(b.service)).rejects.toBe(rechazo);
  });
});

describe('DespegarHotelReservationsService — por el registry (PR-0.5)', () => {
  it.each(PASOS)(
    '$nombre: resuelve Despegar con las reglas del registry antes de tocar su ACL',
    async ({ llamar }) => {
      const b = banco();
      await llamar(b.service);

      expect(b.resolveForTenant).toHaveBeenCalledWith(TENANT);
      const [registry] = b.resolveForTenant.mock.invocationCallOrder;
      const [acl] = b.forTenant.mock.invocationCallOrder;
      expect(registry).toBeLessThan(acl ?? 0);
    },
  );

  it.each(PASOS)(
    '$nombre: Despegar fuera del registry → 400 y ninguna llamada',
    async ({ llamar, mock }) => {
      // Un registry sin Despegar: ninguna ruta sale con las credenciales de la plataforma.
      const adapter = new FakeDespegarHotelsAdapter();
      const { factory, forTenant } = fakeDespegarFactory(adapter);
      const service = new DespegarHotelReservationsService(
        hotelRegistry([new StubHotelProviderFactory()]),
        factory,
        new CircuitBreakerService(),
      );

      await expect(llamar(service)).rejects.toBeInstanceOf(ProviderNotAvailableError);
      expect(forTenant).not.toHaveBeenCalled();
      expect(mock(adapter)).not.toHaveBeenCalled();
    },
  );

  it.each(PASOS)(
    '$nombre: pasa por el circuito de Despegar: el kill-switch lo frena sin llamar',
    async ({ llamar, mock }) => {
      vi.stubEnv('PROVIDERS_DISABLED', CODIGO);
      const b = banco();

      await expect(llamar(b.service)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mock(b.adapter)).not.toHaveBeenCalled();
    },
  );
});

describe('DespegarHotelReservationsService — kill-switch en dos niveles (PR-0.6)', () => {
  /** Leer y cancelar lo ya vendido. Todo lo demás es parte de vender. */
  const POST_VENTA = new Set(['getReservation', 'cancelReservation']);

  it.each(PASOS.filter((p) => !POST_VENTA.has(p.nombre)))(
    '$nombre es venta: `despegar-hotels:ventas` lo frena sin llamar',
    async ({ llamar, mock }) => {
      vi.stubEnv('PROVIDERS_DISABLED', `${CODIGO}:ventas`);
      const b = banco();

      await expect(llamar(b.service)).rejects.toMatchObject({
        reason: 'kill-switch',
        sentToProvider: false,
      });
      expect(mock(b.adapter)).not.toHaveBeenCalled();
    },
  );

  it.each(PASOS.filter((p) => POST_VENTA.has(p.nombre)))(
    '$nombre es post-venta: `despegar-hotels:ventas` lo deja pasar',
    async ({ llamar, mock }) => {
      // Frenar la venta de un proveedor no puede dejar a una agencia sin poder consultar ni
      // cancelar lo que ya vendió.
      vi.stubEnv('PROVIDERS_DISABLED', `${CODIGO}:ventas`);
      const b = banco();

      await llamar(b.service);
      expect(mock(b.adapter)).toHaveBeenCalledTimes(1);
    },
  );
});

describe('DespegarHotelReservationsService — qué cuenta en el circuito (PR-0.5)', () => {
  /** Lo que ve la búsqueda: el MISMO circuito, uno por código para todos los tenants. */
  function estado(b: Banco): { state: string; failures: number } | undefined {
    return b.breaker.snapshot()[CODIGO];
  }

  it.each(PASOS)(
    '$nombre: cinco rechazos de Despegar (4xx) no abren el circuito y la siguiente llamada llega',
    async ({ llamar, mock }) => {
      // Una tarifa vencida o una reserva que no existe son Despegar RESPONDIENDO. Si contaran,
      // cinco reintentos de un vendedor cortarían 30 s la búsqueda de hoteles de toda la red.
      const b = banco();
      const m = mock(b.adapter);
      for (let i = 0; i < 5; i++) {
        const rechazo = new DespegarApiError(404, '{"message":"not found"}', '/reservations');
        m.mockRejectedValueOnce(rechazo);
        await expect(llamar(b.service)).rejects.toBe(rechazo);
      }

      expect(estado(b)).toEqual({ state: 'closed', failures: 0 });
      await llamar(b.service);
      expect(m).toHaveBeenCalledTimes(6);
    },
  );

  it.each([
    ['sin conexión', new DespegarApiError(0, 'fetch failed', '/prebook')],
    ['un 5xx', new DespegarApiError(503, 'Service Unavailable', '/prebook')],
    ['un 2xx que no es JSON', new DespegarApiError(200, 'respuesta no-JSON', '/prebook')],
    ['un error que no es de Despegar', new Error('socket hang up')],
  ])('%s SÍ cuenta: cinco seguidos abren el circuito y la sexta no sale', async (_caso, caida) => {
    const b = banco();
    for (let i = 0; i < 5; i++) {
      b.adapter.prebook.mockRejectedValueOnce(caida);
      await expect(b.service.prebook(TENANT, PREBOOK)).rejects.toBe(caida);
    }

    expect(estado(b)?.state).toBe('open');
    await expect(b.service.prebook(TENANT, PREBOOK)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(b.adapter.prebook).toHaveBeenCalledTimes(5);
  });
});

describe('DespegarHotelReservationsService — capacidades (PR-0.5)', () => {
  /** Un Despegar que declara no saber leer ni cancelar, y cuyo adapter no tiene los opcionales. */
  function sinCapacidades(): {
    service: DespegarHotelReservationsService;
    adapter: FakeDespegarHotelsAdapter;
  } {
    const adapter = new FakeDespegarHotelsAdapter();
    const { factory, resolveForTenant } = fakeDespegarFactory(adapter);
    Object.assign(factory, {
      capabilities: { ...factory.capabilities, retrieve: false, cancel: false },
    });
    const soloObligatorios = {
      searchAvailability: vi.fn(),
      prebook: vi.fn(),
      book: vi.fn(),
      getBooking: vi.fn(),
      cancelBooking: vi.fn(),
    } as unknown as HotelProviderAdapter;
    resolveForTenant.mockImplementation(() =>
      Promise.resolve({ adapter: soloObligatorios, credentialSource: 'own' }),
    );
    const service = new DespegarHotelReservationsService(
      hotelRegistry([factory]),
      factory,
      new CircuitBreakerService(),
    );
    return { service, adapter };
  }

  it.each([
    ['getPaymentOptions', 'medios de pago por prebook'],
    ['getReservation', 'la consulta de reservas'],
    ['cancelReservation', 'la cancelación de reservas'],
    ['recoverBooking', 'la confirmación de salto de precio'],
  ])('%s sin la capacidad → 400 que la nombra, sin llamar', async (nombre, operacion) => {
    const { service, adapter } = sinCapacidades();
    const paso = PASOS.find((p) => p.nombre === nombre);
    if (!paso) throw new Error(`no hay paso ${nombre}`);

    const err = await paso.llamar(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelProviderCapabilityError);
    expect((err as HotelProviderCapabilityError).message).toBe(
      `El proveedor '${CODIGO}' no ofrece ${operacion}.`,
    );
    expect(paso.mock(adapter)).not.toHaveBeenCalled();
  });

  it.each(['prebook', 'book'])('%s no depende de capacidades opcionales', async (nombre) => {
    const { service, adapter } = sinCapacidades();
    const paso = PASOS.find((p) => p.nombre === nombre);
    if (!paso) throw new Error(`no hay paso ${nombre}`);

    await paso.llamar(service);
    expect(paso.mock(adapter)).toHaveBeenCalledTimes(1);
  });
});
