import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { MemoryWalletHolds, type MemoryGroup } from './__fixtures__/memory-wallet-holds.js';
import { PortfolioReleaseBusyError, WalletHoldStateConflictError } from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';

/**
 * Lo que la cartera hace con una reserva retenida —emitir, rechazar, liberar—, con un doble de las
 * funciones de 0060. Desde 0060 la liberación no escribe asientos desde la API: la hace
 * `wallet_hold_settle` en todos los niveles de la red, sobre lo que se retuvo, y la API sólo le pasa
 * la precondición (la orden `failed` o `cancelled`) y traduce el resultado.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const SELLER = '44444444-4444-4444-8444-444444444444';
const HELD = 125_000;

const capabilities = (overrides: Partial<Record<'cancel' | 'pay', boolean>> = {}) => ({
  retrieve: true,
  cancel: overrides.cancel ?? true,
  pay: overrides.pay ?? false,
  services: false,
  reshop: false,
});

function harness(options?: {
  provider?: string;
  providerOrderId?: string | null;
  cancel?: boolean;
  pay?: boolean;
  cancelSuccess?: boolean;
  persistedStatus?: string;
  orderStatus?: string;
  /** `search_criteria.vertical`; ausente como en vuelos. */
  vertical?: string;
  /** `false`: el registry de hoteles no conoce al proveedor. */
  knownHotel?: boolean;
  /** Estado de la retención; `null` = la orden no tiene. */
  holdStatus?: MemoryGroup['status'] | null;
}) {
  const provider = options?.provider ?? 'sabre';
  const wallet = MemoryWalletHolds.wallet(TENANT, { balance_minor: 500_000 - HELD });
  const holdStatus = options?.holdStatus === undefined ? 'captured' : options.holdStatus;
  const entryId = randomUUID();
  const groupId = randomUUID();
  const bank = new MemoryWalletHolds({
    orders: [
      {
        id: ORDER,
        tenant_id: TENANT,
        status: options?.orderStatus ?? 'confirmed',
        total_amount: HELD,
        currency: 'USD',
        provider,
        provider_order_id:
          options?.providerOrderId === undefined ? 'PNR123' : options.providerOrderId,
        provider_raw: { phase: 'create' },
        create_request_key: null,
        ...(options?.vertical === undefined ? {} : { vertical: options.vertical }),
      },
    ],
    wallets: [wallet],
    entries:
      holdStatus === null
        ? []
        : [
            {
              id: entryId,
              portfolio_id: wallet.id,
              amount_minor: -HELD,
              transaction_type: 'BOOKING_HOLD',
              reference_id: ORDER,
              idempotency_key: null,
              notes: 'retención',
              created_by: SELLER,
              created_at: new Date(),
            },
          ],
    groups:
      holdStatus === null
        ? []
        : [
            {
              id: groupId,
              order_id: ORDER,
              origin_tenant_id: TENANT,
              status: holdStatus,
              created_by: SELLER,
            },
          ],
    levels:
      holdStatus === null
        ? []
        : [
            {
              group_id: groupId,
              order_id: ORDER,
              depth: 0,
              tenant_id: TENANT,
              portfolio_id: wallet.id,
              amount_minor: HELD,
              hold_transaction_id: entryId,
              release_transaction_id: null,
              status: holdStatus,
            },
          ],
  });

  const registry = {
    capabilitiesOf: vi.fn(() => capabilities({ cancel: options?.cancel, pay: options?.pay })),
  } as unknown as FlightProviderRegistry;
  const cancelOrder = vi.fn(() => {
    const success = options?.cancelSuccess ?? true;
    const status = options?.persistedStatus === undefined ? 'cancelled' : options.persistedStatus;
    // Como OrdersService: la cancelación confirmada deja la orden `cancelled` en la base.
    if (success && status) bank.state.orders[0]!.status = status;
    return Promise.resolve({
      result: { success, warnings: [] },
      ...(status ? { order: { id: ORDER, status } } : {}),
    });
  });
  const orders = { cancelOrder } as unknown as OrdersService;
  const hotelRegistry = {
    capabilitiesOf: vi.fn(() =>
      options?.knownHotel === false
        ? undefined
        : { retrieve: true, cancel: true, retrieveByClientReference: true, reconcileByDate: true },
    ),
  } as unknown as HotelProviderRegistry;

  const settles = () => bank.calls.filter((c) => c.fn === 'wallet_hold_settle');
  const released = () =>
    bank.state.entries.filter((e) => e.transaction_type === 'BOOKING_RELEASED');
  return {
    service: new PortfoliosService(bank.asDatabase(), registry, orders, hotelRegistry),
    bank,
    registry: registry as unknown as { capabilitiesOf: ReturnType<typeof vi.fn> },
    hotelRegistry: hotelRegistry as unknown as { capabilitiesOf: ReturnType<typeof vi.fn> },
    cancelOrder,
    settles,
    released,
    balance: () => bank.wallet(TENANT, 'USD')?.balance_minor,
  };
}

describe('PortfoliosService — acciones sobre reservas retenidas', () => {
  it('bloquea Sabre antes de debitar o confirmar porque no tiene emisión diferida', async () => {
    const h = harness({ provider: 'sabre', pay: false });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(/No se debitó/i);
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.settles()).toHaveLength(0);
  });

  it('con la operación de pago declarada tampoco emite: no está conectada a una real', async () => {
    const h = harness({ provider: 'sabre', pay: true });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(
      /todavía no está conectada/i,
    );
    expect(h.balance()).toBe(500_000 - HELD);
  });

  it('bloquea el rechazo sin capacidad de cancelación antes de tocar saldo', async () => {
    const h = harness({ cancel: false });

    await expect(h.service.rejectBooking(TENANT, ORDER)).rejects.toThrow(
      /no admite cancelación real/i,
    );
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.settles()).toHaveLength(0);
  });

  it('sin localizador del proveedor no hay nada que cancelar ni liberar', async () => {
    const h = harness({ providerOrderId: null });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no tiene un localizador/i,
    );
    expect(h.settles()).toHaveLength(0);
  });

  it('no libera el hold cuando el proveedor rechaza la cancelación', async () => {
    const h = harness({ cancelSuccess: false, persistedStatus: '' });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no confirmó la cancelación/i,
    );
    expect(h.cancelOrder).toHaveBeenCalledWith(TENANT, ORDER, 'PNR123', ADMIN);
    expect(h.settles()).toHaveLength(0);
    expect(h.balance()).toBe(500_000 - HELD);
  });

  it('un error del proveedor al cancelar tampoco libera', async () => {
    const h = harness();
    h.cancelOrder.mockRejectedValueOnce(new Error('timeout'));

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /No fue posible confirmar la cancelación/i,
    );
    expect(h.settles()).toHaveLength(0);
  });

  it('libera en todos los niveles por wallet_hold_settle sólo tras la cancelación persistida', async () => {
    const h = harness({ cancelSuccess: true, persistedStatus: 'cancelled' });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toEqual({
      success: true,
      message: 'Cancelación confirmada por el proveedor y saldo retenido liberado.',
    });

    expect(h.cancelOrder).toHaveBeenCalledWith(TENANT, ORDER, 'PNR123', ADMIN);
    expect(h.settles().map((c) => c.params)).toEqual([[ORDER, ADMIN, 'cancelled']]);
    expect(h.released()).toEqual([
      expect.objectContaining({ amount_minor: HELD, reference_id: ORDER, created_by: ADMIN }),
    ]);
    expect(h.balance()).toBe(500_000);
    // La liberación bloquea con lock_timeout, como la retención.
    expect(h.bank.log).toContain("SET LOCAL lock_timeout = '2s'");
  });

  it('la red contenida al liberar responde que falta devolver el saldo, no que no se canceló; repetir lo termina', async () => {
    const h = harness({ cancelSuccess: true, persistedStatus: 'cancelled' });
    h.bank.settleLockErrors.push('55P03', '55P03', '55P03');

    const err = await h.service.rejectBooking(TENANT, ORDER, ADMIN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PortfolioReleaseBusyError);
    expect((err as PortfolioReleaseBusyError).reason).toBe('PORTFOLIO_RELEASE_BUSY');
    expect(h.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.balance()).toBe(500_000 - HELD);

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toMatchObject({
      success: true,
    });
    expect(h.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.balance()).toBe(500_000);
  });

  it('sin actor firma quien retuvo', async () => {
    const h = harness({ orderStatus: 'cancelled', cancel: false });

    await h.service.rejectBooking(TENANT, ORDER);

    expect(h.settles()[0]?.params).toEqual([ORDER, SELLER, 'cancelled']);
  });

  it('recuperación: si la cancelación quedó y la liberación no, termina la liberación sin cancelar otra vez', async () => {
    const h = harness({ orderStatus: 'cancelled', cancel: false });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toMatchObject({
      success: true,
    });

    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.released()).toHaveLength(1);
  });

  it('un segundo rechazo después del primero no acredita otra vez: ya no hay retención pendiente', async () => {
    const h = harness({ orderStatus: 'cancelled', cancel: false });

    await h.service.rejectBooking(TENANT, ORDER, ADMIN);
    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /No existe una retención pendiente/,
    );

    expect(h.released()).toHaveLength(1);
    expect(h.balance()).toBe(500_000);
  });

  it('sin retención no hay nada que rechazar desde la cartera', async () => {
    const h = harness({ holdStatus: null });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(
      /No existe una retención pendiente/,
    );
  });

  it('la reserva de otro tenant no existe para éste', async () => {
    const h = harness();

    await expect(
      h.service.rejectBooking('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ORDER, ADMIN),
    ).rejects.toThrow(/No se encontró la reserva/);
  });
});

describe('PortfoliosService — la vertical de la orden decide con qué registry se resuelve', () => {
  it('un hotel no se busca en el registry de vuelos, y su voucher no se emite desde la cartera', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', pay: true, cancel: true });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(
      /no admite emisión diferida/i,
    );
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.hotelRegistry.capabilitiesOf).toHaveBeenCalledWith('tbo-hotels');
    expect(h.settles()).toHaveLength(0);
  });

  it('el rechazo de un hotel confirmado no cancela con el camino de vuelos ni libera', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', cancel: true });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no admite cancelación real/i,
    );
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.settles()).toHaveLength(0);
  });

  it.each([
    ['un hotel de un proveedor que el registry no conoce', 'hotels'],
    ['una vertical sin registry propio (autos)', 'cars'],
  ])('%s no se resuelve con el registry de vuelos', async (_caso, vertical) => {
    const h = harness({ provider: 'otro', vertical, knownHotel: false, cancel: true, pay: true });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(
      /no admite emisión diferida/i,
    );
    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no admite cancelación real/i,
    );
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it('una reserva `failed` libera su retención desde el rechazo sin tocar al proveedor', async () => {
    const h = harness({
      provider: 'tbo-hotels',
      vertical: 'hotels',
      orderStatus: 'failed',
      holdStatus: 'held',
      cancel: false,
    });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toEqual({
      success: true,
      message: 'El proveedor no hizo la reserva y el saldo retenido quedó liberado.',
    });
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.hotelRegistry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.settles()[0]?.params).toEqual([ORDER, ADMIN, 'failed']);
    expect(h.released()).toEqual([
      expect.objectContaining({
        amount_minor: HELD,
        reference_id: ORDER,
        notes: 'El proveedor no hizo la reserva; saldo retenido liberado',
      }),
    ]);
  });

  it('una reserva `failed` que figuró confirmada queda en conflicto: no libera y lo dice', async () => {
    const h = harness({ orderStatus: 'failed', holdStatus: 'captured', cancel: false });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toBeInstanceOf(
      WalletHoldStateConflictError,
    );
    expect(h.released()).toHaveLength(0);
    expect(h.bank.groupOf(ORDER)?.status).toBe('conflict');
  });
});

describe('PortfoliosService.releaseFailedBookingHold (RF-23 CA-2)', () => {
  it('libera la retención de una orden `failed` por wallet_hold_settle, con la precondición', async () => {
    const h = harness({
      provider: 'tbo-hotels',
      vertical: 'hotels',
      orderStatus: 'failed',
      holdStatus: 'held',
    });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'released',
    );
    expect(h.settles().map((c) => c.params)).toEqual([[ORDER, ADMIN, 'failed']]);
    expect(h.released()).toEqual([
      expect.objectContaining({ amount_minor: HELD, reference_id: ORDER, created_by: ADMIN }),
    ]);
    expect(h.balance()).toBe(500_000);
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it('es idempotente: con la retención liberada no acredita otra vez', async () => {
    const h = harness({ orderStatus: 'failed', holdStatus: 'held' });

    await h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN);
    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'already-released',
    );
    expect(h.released()).toHaveLength(1);
  });

  it('sin retención no hace nada', async () => {
    const h = harness({ orderStatus: 'failed', holdStatus: null });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe('no-hold');
    expect(h.released()).toHaveLength(0);
  });

  it.each([
    ['pending', 'held'],
    ['confirmed', 'captured'],
    ['cancelled', 'captured'],
  ] as const)(
    'una orden `%s` conserva su retención: sólo `failed` prueba que no hubo reserva',
    async (orderStatus, holdStatus) => {
      const h = harness({ orderStatus, holdStatus });

      const err = await h.service
        .releaseFailedBookingHold(TENANT, ORDER, ADMIN)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toBe(
        'La reserva no está cerrada como no realizada: su retención de saldo se mantiene.',
      );
      expect(h.released()).toHaveLength(0);
    },
  );

  it('una orden que figuró confirmada y quedó `failed`: conflicto, sin mover saldo', async () => {
    const h = harness({ orderStatus: 'failed', holdStatus: 'captured' });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).rejects.toBeInstanceOf(
      WalletHoldStateConflictError,
    );
    expect(h.balance()).toBe(500_000 - HELD);
  });

  it('una retención liberada con la orden abierta tampoco se da por liberada otra vez', async () => {
    const h = harness({ orderStatus: 'pending', holdStatus: 'released' });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('PortfoliosService.releaseCancelledBookingHold (docs/tbo/09 PR-5.3)', () => {
  it('libera la retención de una orden que el proveedor ya muestra cancelada', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', orderStatus: 'cancelled' });

    await expect(h.service.releaseCancelledBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'released',
    );
    expect(h.released()).toEqual([
      expect.objectContaining({
        amount_minor: HELD,
        reference_id: ORDER,
        notes: 'Cancelación confirmada por el proveedor; saldo retenido liberado',
      }),
    ]);
    // La cancelación ya ocurrió: liberar no vuelve a llamar al proveedor.
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it('es idempotente, y sin retención no hace nada', async () => {
    const liberada = harness({ orderStatus: 'cancelled', holdStatus: 'released' });
    await expect(liberada.service.releaseCancelledBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'already-released',
    );
    expect(liberada.released()).toHaveLength(0);

    const sinRetencion = harness({ orderStatus: 'cancelled', holdStatus: null });
    await expect(
      sinRetencion.service.releaseCancelledBookingHold(TENANT, ORDER, ADMIN),
    ).resolves.toBe('no-hold');
  });

  it.each(['pending', 'confirmed', 'failed'])(
    'una orden `%s` conserva su retención: una cancelación en curso sigue cobrable (D-TBO-25 A)',
    async (orderStatus) => {
      const h = harness({ orderStatus });

      const err = await h.service
        .releaseCancelledBookingHold(TENANT, ORDER, ADMIN)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toBe(
        'La reserva no figura cancelada: su retención de saldo se mantiene.',
      );
      expect(h.released()).toHaveLength(0);
    },
  );

  it('una retención en conflicto no se libera sola', async () => {
    const h = harness({ orderStatus: 'cancelled', holdStatus: 'conflict' });

    await expect(
      h.service.releaseCancelledBookingHold(TENANT, ORDER, ADMIN),
    ).rejects.toBeInstanceOf(WalletHoldStateConflictError);
  });
});
