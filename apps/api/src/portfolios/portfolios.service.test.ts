import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { PortfoliosService } from './portfolios.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-28T12:00:00.000Z');

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
  holdAmount?: number;
  existingRelease?: boolean;
  releaseUniqueRace?: boolean;
  /** `search_criteria.vertical`; ausente como en vuelos. */
  vertical?: string;
  /** `false`: el registry de hoteles no conoce al proveedor. */
  knownHotel?: boolean;
  /** La orden no tiene retención. */
  noHold?: boolean;
}) {
  const provider = options?.provider ?? 'sabre';
  const order = {
    id: ORDER,
    provider,
    ...(options?.vertical === undefined ? {} : { vertical: options.vertical }),
    provider_order_id: options?.providerOrderId === undefined ? 'PNR123' : options.providerOrderId,
    status: options?.orderStatus ?? 'confirmed',
  };
  const hold = {
    id: 'hold-1',
    portfolio_id: 'portfolio-1',
    amount_minor: options?.holdAmount ?? -125_000,
    created_by: ADMIN,
  };
  let release = options?.existingRelease
    ? {
        id: 'release-1',
        portfolio_id: 'portfolio-1',
        amount_minor: 125_000,
        transaction_type: 'BOOKING_RELEASED',
        reference_id: ORDER,
        idempotency_key: null,
        notes: 'released',
        created_by: ADMIN,
        created_at: NOW,
      }
    : undefined;
  const insertedValues: Record<string, unknown>[] = [];

  const selectFrom = vi.fn((table: string) => {
    const filters = new Map<string, unknown>();
    const query = {
      select: () => query,
      selectAll: () => query,
      where: (column: unknown, _operator?: unknown, value?: unknown) => {
        if (typeof column === 'string') filters.set(column, value);
        return query;
      },
      executeTakeFirst: () => {
        if (table === 'orders') return Promise.resolve(order);
        if (filters.get('transaction_type') === 'BOOKING_RELEASED') return Promise.resolve(release);
        return Promise.resolve(options?.noHold === true ? undefined : hold);
      },
    };
    return query;
  });

  const insertInto = vi.fn((table: string) => {
    let values: Record<string, unknown> | undefined;
    const query = {
      values: (next: Record<string, unknown>) => {
        values = next;
        return query;
      },
      returningAll: () => query,
      executeTakeFirstOrThrow: () => {
        if (table !== 'portfolio_transactions' || !values) {
          throw new Error(`Unexpected insert into ${table}`);
        }
        insertedValues.push(values);
        const row = {
          id: 'release-1',
          portfolio_id: String(values['portfolio_id']),
          amount_minor: Number(values['amount_minor']),
          transaction_type: String(values['transaction_type']),
          reference_id: String(values['reference_id']),
          idempotency_key: null,
          notes: String(values['notes']),
          created_by: String(values['created_by']),
          created_at: NOW,
        };
        if (options?.releaseUniqueRace) {
          release = row;
          throw Object.assign(new Error('concurrent release'), { code: '23505' });
        }
        release = row;
        return Promise.resolve(row);
      },
    };
    return query;
  });

  const agencyUpdate = {
    set: vi.fn(() => agencyUpdate),
    where: vi.fn(() => agencyUpdate),
    returning: vi.fn(() => agencyUpdate),
    executeTakeFirst: vi.fn(() => Promise.resolve({ id: 'portfolio-1' })),
  };
  const updateTable = vi.fn((table: string) => {
    if (table !== 'agency_portfolios') throw new Error(`Unexpected update of ${table}`);
    return agencyUpdate;
  });
  const trx = { selectFrom, insertInto, updateTable };
  const db = {
    withTenant: <T>(_tenantId: string, callback: (value: typeof trx) => Promise<T>) =>
      callback(trx),
  } as unknown as DatabaseService;

  const registry = {
    capabilitiesOf: vi.fn(() => capabilities({ cancel: options?.cancel, pay: options?.pay })),
  } as unknown as FlightProviderRegistry;
  const cancelOrder = vi.fn(() => {
    const success = options?.cancelSuccess ?? true;
    const status = options?.persistedStatus === undefined ? 'cancelled' : options.persistedStatus;
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

  return {
    service: new PortfoliosService(db, registry, orders, hotelRegistry),
    registry: registry as unknown as { capabilitiesOf: ReturnType<typeof vi.fn> },
    hotelRegistry: hotelRegistry as unknown as { capabilitiesOf: ReturnType<typeof vi.fn> },
    cancelOrder,
    insertInto,
    insertedValues,
    updateTable,
    hold,
  };
}

describe('PortfoliosService — acciones sobre reservas retenidas', () => {
  it('bloquea Sabre antes de debitar o confirmar porque no tiene emisión diferida', async () => {
    const h = harness({ provider: 'sabre', pay: false });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(/No se debitó/i);
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('bloquea el rechazo sin capacidad de cancelación antes de tocar saldo', async () => {
    const h = harness({ cancel: false });

    await expect(h.service.rejectBooking(TENANT, ORDER)).rejects.toThrow(
      /no admite cancelación real/i,
    );
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('no libera el hold cuando el proveedor rechaza la cancelación', async () => {
    const h = harness({ cancelSuccess: false, persistedStatus: '' });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no confirmó la cancelación/i,
    );
    expect(h.cancelOrder).toHaveBeenCalledWith(TENANT, ORDER, 'PNR123', ADMIN);
    expect(h.insertInto).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('conserva el hold y crea un asiento positivo sólo tras cancelación persistida', async () => {
    const h = harness({ cancelSuccess: true, persistedStatus: 'cancelled' });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toEqual({
      success: true,
      message: 'Cancelación confirmada por el proveedor y saldo retenido liberado.',
    });

    expect(h.cancelOrder).toHaveBeenCalledWith(TENANT, ORDER, 'PNR123', ADMIN);
    expect(h.insertedValues).toEqual([
      expect.objectContaining({
        portfolio_id: 'portfolio-1',
        amount_minor: 125_000,
        transaction_type: 'BOOKING_RELEASED',
        reference_id: ORDER,
        created_by: ADMIN,
      }),
    ]);
    expect(h.updateTable).toHaveBeenCalledTimes(1);
    expect(h.updateTable).toHaveBeenCalledWith('agency_portfolios');
    expect(h.hold).toMatchObject({ amount_minor: -125_000 });
  });

  it('un retry después del commit devuelve éxito sin cancelar ni acreditar otra vez', async () => {
    const h = harness({ orderStatus: 'cancelled', cancel: false, existingRelease: true });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toMatchObject({
      success: true,
    });

    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.insertInto).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('tolera la carrera del índice de release sin un segundo crédito', async () => {
    const h = harness({ orderStatus: 'cancelled', releaseUniqueRace: true });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toMatchObject({
      success: true,
    });

    expect(h.insertInto).toHaveBeenCalledTimes(1);
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza hold amount corrupto (%s) antes de cancelar o acreditar',
    async (holdAmount) => {
      const h = harness({ holdAmount });

      await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
        /monto inválido/i,
      );
      expect(h.cancelOrder).not.toHaveBeenCalled();
      expect(h.insertInto).not.toHaveBeenCalled();
      expect(h.updateTable).not.toHaveBeenCalled();
    },
  );
});

describe('PortfoliosService — la vertical de la orden decide con qué registry se resuelve', () => {
  it('un hotel no se busca en el registry de vuelos, y su voucher no se emite desde la cartera', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', pay: true, cancel: true });

    await expect(h.service.approveBooking(TENANT, ORDER)).rejects.toThrow(
      /no admite emisión diferida/i,
    );
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.hotelRegistry.capabilitiesOf).toHaveBeenCalledWith('tbo-hotels');
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('el rechazo de un hotel confirmado no cancela con el camino de vuelos ni libera', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', cancel: true });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).rejects.toThrow(
      /no admite cancelación real/i,
    );
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.registry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.insertInto).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
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
      cancel: false,
    });

    await expect(h.service.rejectBooking(TENANT, ORDER, ADMIN)).resolves.toEqual({
      success: true,
      message: 'El proveedor no hizo la reserva y el saldo retenido quedó liberado.',
    });
    expect(h.cancelOrder).not.toHaveBeenCalled();
    expect(h.hotelRegistry.capabilitiesOf).not.toHaveBeenCalled();
    expect(h.insertedValues).toEqual([
      expect.objectContaining({
        amount_minor: 125_000,
        transaction_type: 'BOOKING_RELEASED',
        reference_id: ORDER,
        notes: 'El proveedor no hizo la reserva; saldo retenido liberado',
      }),
    ]);
  });
});

describe('PortfoliosService.releaseFailedBookingHold (RF-23 CA-2)', () => {
  it('libera la retención de una orden `failed` con un asiento positivo', async () => {
    const h = harness({ provider: 'tbo-hotels', vertical: 'hotels', orderStatus: 'failed' });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'released',
    );
    expect(h.insertedValues).toEqual([
      expect.objectContaining({
        portfolio_id: 'portfolio-1',
        amount_minor: 125_000,
        transaction_type: 'BOOKING_RELEASED',
        reference_id: ORDER,
        created_by: ADMIN,
      }),
    ]);
    expect(h.updateTable).toHaveBeenCalledWith('agency_portfolios');
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it('es idempotente: con la liberación ya escrita no acredita otra vez', async () => {
    const h = harness({ orderStatus: 'failed', existingRelease: true });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'already-released',
    );
    expect(h.insertInto).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('la carrera del índice de liberación tampoco acredita dos veces', async () => {
    const h = harness({ orderStatus: 'failed', releaseUniqueRace: true });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe(
      'already-released',
    );
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it('sin retención no hace nada', async () => {
    const h = harness({ orderStatus: 'failed', noHold: true });

    await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).resolves.toBe('no-hold');
    expect(h.insertInto).not.toHaveBeenCalled();
    expect(h.updateTable).not.toHaveBeenCalled();
  });

  it.each(['pending', 'confirmed', 'cancelled'])(
    'una orden `%s` conserva su retención: sólo `failed` prueba que no hubo reserva',
    async (orderStatus) => {
      const h = harness({ orderStatus });

      await expect(h.service.releaseFailedBookingHold(TENANT, ORDER, ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(h.insertInto).not.toHaveBeenCalled();
      expect(h.updateTable).not.toHaveBeenCalled();
    },
  );
});
