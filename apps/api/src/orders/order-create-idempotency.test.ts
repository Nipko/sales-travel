import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type { OrderCreateResult, Passenger } from '@sales-travel/domain';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { OrdersService, type CreateOrderDto } from './orders.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const QUOTATION = '33333333-3333-4333-8333-333333333333';
const FOREIGN_QUOTATION = '44444444-4444-4444-8444-444444444444';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROVIDER = 'idempotent-air';

interface MemoryDbOptions {
  /** Simula que el primero liberó la key justo después de que PostgreSQL decidió el 23505. */
  releaseKeyOnNextUniqueViolation?: boolean;
  uniqueConstraintName?: string;
}

/**
 * PostgreSQL mínimo en memoria. `withTenant` serializa las transacciones como el `FOR UPDATE` del
 * tenant y el INSERT aplica el mismo índice parcial de 0038.
 */
function memoryDb(options: MemoryDbOptions = {}) {
  const rows: Record<string, unknown>[] = [];
  const operations: Record<string, unknown>[] = [];
  let transactionTail = Promise.resolve();

  const matches = (row: Record<string, unknown>, filters: readonly [string, unknown][]): boolean =>
    filters.every(([field, value]) => row[field] === value);

  const selectFrom = (table: string) => {
    const filters: [string, unknown][] = [];
    let aggregateNextNumber = false;
    const source = (): Record<string, unknown>[] => {
      const base =
        table === 'orders'
          ? rows
          : table === 'order_operations'
            ? operations
            : table === 'tenants'
              ? [{ id: TENANT }]
              : table === 'quotations'
                ? [{ id: QUOTATION, tenant_id: TENANT }]
                : [];
      return base.filter((row) => matches(row, filters));
    };
    const query = {
      select: (selection: unknown) => {
        aggregateNextNumber = table === 'orders' && typeof selection === 'object';
        return query;
      },
      selectAll: () => query,
      where: (field: string, _operator: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      },
      forUpdate: () => query,
      orderBy: () => query,
      limit: () => query,
      execute: () => Promise.resolve(source()),
      executeTakeFirst: () => Promise.resolve(source()[0]),
      executeTakeFirstOrThrow: () => {
        if (aggregateNextNumber) {
          const maximum = rows
            .filter((row) => row['tenant_id'] === TENANT)
            .reduce((value, row) => Math.max(value, Number(row['order_number'] ?? 0)), 0);
          return Promise.resolve({ next: maximum + 1 });
        }
        const row = source()[0];
        if (row === undefined) return Promise.reject(new Error(`${table} not found`));
        return Promise.resolve(row);
      },
    };
    return query;
  };

  const insertInto = (table: string) => {
    let values: Record<string, unknown> | undefined;
    let inserted: Record<string, unknown> | undefined;
    const executeInsert = () => {
      if (inserted !== undefined) return inserted;
      if (values === undefined) throw new Error('insert sin values');
      if (table === 'orders') {
        const key = values['create_request_key'];
        const duplicate =
          key === null
            ? undefined
            : rows.find(
                (row) =>
                  row['tenant_id'] === values?.['tenant_id'] && row['create_request_key'] === key,
              );
        if (duplicate !== undefined) {
          if (options.releaseKeyOnNextUniqueViolation) {
            options.releaseKeyOnNextUniqueViolation = false;
            duplicate['create_request_key'] = null;
          }
          throw Object.assign(new Error('duplicate create key'), {
            code: '23505',
            constraint: options.uniqueConstraintName ?? 'uq_orders_create_request_key',
          });
        }
        inserted = {
          id: `order-${rows.length + 1}`,
          created_at: new Date(1_700_000_000_000 + rows.length),
          updated_at: new Date(1_700_000_000_000 + rows.length),
          ...values,
        };
        rows.push(inserted);
        return inserted;
      }
      inserted = { id: `operation-${operations.length + 1}`, ...values };
      operations.push(inserted);
      return inserted;
    };
    const query = {
      values: (next: Record<string, unknown>) => {
        values = next;
        return query;
      },
      returning: () => query,
      returningAll: () => query,
      execute: () => Promise.resolve([executeInsert()]),
      executeTakeFirst: () => Promise.resolve(executeInsert()),
      executeTakeFirstOrThrow: () => Promise.resolve(executeInsert()),
    };
    return query;
  };

  const updateTable = (table: string) => {
    const filters: [string, unknown][] = [];
    let values: Record<string, unknown> = {};
    let applied = false;
    let updated: Record<string, unknown> | undefined;
    const apply = () => {
      if (applied) return updated;
      applied = true;
      const source = table === 'orders' ? rows : operations;
      updated = source.find((row) => matches(row, filters));
      if (updated !== undefined) Object.assign(updated, values);
      return updated;
    };
    const query = {
      set: (next: Record<string, unknown>) => {
        values = next;
        return query;
      },
      where: (field: string, _operator: string, value: unknown) => {
        filters.push([field, value]);
        return query;
      },
      returning: () => query,
      returningAll: () => query,
      execute: () => Promise.resolve(apply() === undefined ? [] : [{}]),
      executeTakeFirst: () => Promise.resolve(apply()),
    };
    return query;
  };

  const trx = { selectFrom, insertInto, updateTable };
  const db = {
    withTenant: async <T>(_tenantId: string, callback: (value: unknown) => Promise<T>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(trx);
      } finally {
        release();
      }
    },
  } as unknown as DatabaseService;
  return { db, rows };
}

function offer(): Offer {
  return {
    id: 'offer-idempotent',
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: PROVIDER, offerRef: 'offer-ref-idempotent' },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AV',
            flightNumber: '123',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-09-10T09:00:00-05:00',
            arrivalAt: '2026-09-10T12:00:00-05:00',
            durationMinutes: 180,
            cabin: 'economy',
            bookingClass: 'Y',
          },
        ],
        totalDurationMinutes: 180,
        stops: 0,
      },
    ],
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2099-08-26T12:30:00.000Z',
  };
}

const PASSENGER: Passenger = {
  paxId: 'P1',
  paxType: 'ADT',
  title: 'Mr',
  givenName: 'Juan',
  surname: 'Pérez',
  birthdate: '1990-01-01',
  gender: 'M',
  citizenshipCountryCode: 'CO',
  identityDoc: { type: 'CC', number: '123456789', issuingCountryCode: 'CO' },
};

function dto(quotationId?: string): CreateOrderDto {
  return {
    offer: offer(),
    searchCriteria: {
      origin: 'BOG',
      destination: 'LIM',
      departureDate: '2026-09-10',
      paxCount: { adults: 1, children: 0, infants: 0 },
      cabin: 'economy',
      currency: 'USD',
    },
    passengers: [PASSENGER],
    contactInfo: { email: 'passenger@example.test', phone: '+573000000000' },
    ...(quotationId === undefined ? {} : { quotationId }),
  };
}

function bank(options: MemoryDbOptions = {}) {
  const factory = new StubProviderFactory({ code: PROVIDER });
  const registry = new FlightProviderRegistry([factory], {
    isEnabledForTenant: () => Promise.resolve(false),
  });
  const { db, rows } = memoryDb(options);
  const adapter = factory.adapterFor(TENANT);
  const service = new OrdersService(
    db,
    registry,
    new RecordingQueueService().asService(),
    {} as AgentCarsProviderFactory,
    new RecordingAuditService().asService(),
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
  );
  return { service, factory, adapter, rows };
}

function conflictBody(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as Record<string, unknown>;
}

describe('OrdersService.createOrder — idempotencia cross-request', () => {
  it('dos requests seriales confirmados conservan una sola orden y una sola llamada externa', async () => {
    const b = bank();
    await b.service.createOrder(TENANT, USER, dto(), KEY_A);

    let duplicate: unknown;
    try {
      await b.service.createOrder(TENANT, USER, dto(), KEY_A);
    } catch (error) {
      duplicate = error;
    }

    expect(conflictBody(duplicate)).toMatchObject({
      orderId: 'order-1',
      pnr: `${PROVIDER}-PNR`,
      duplicateRequest: true,
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.adapter.priceOffer).toHaveBeenCalledTimes(1);
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
    expect(b.rows).toHaveLength(1);
  });

  it('el concurrente ve pending; un timeout conserva la key y prohíbe un tercer create', async () => {
    const b = bank();
    let rejectProvider!: (error: Error) => void;
    const gate = new Promise<OrderCreateResult>((_resolve, reject) => {
      rejectProvider = reject;
    });
    b.adapter.createOrder.mockImplementation(() => gate);

    const first = b.service.createOrder(TENANT, USER, dto(), KEY_A);
    await vi.waitFor(() => expect(b.adapter.createOrder).toHaveBeenCalledTimes(1));

    await expect(b.service.createOrder(TENANT, USER, dto(), KEY_A)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(b.adapter.priceOffer).toHaveBeenCalledTimes(1);
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);

    rejectProvider(new Error('timeout con posible PNR'));
    await expect(first).rejects.toBeInstanceOf(ConflictException);
    await expect(b.service.createOrder(TENANT, USER, dto(), KEY_A)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
    expect(b.rows[0]).toMatchObject({ status: 'pending', create_request_key: `c:${KEY_A}` });
  });

  it('FAILED explícito libera la key en el CAS y permite un intent nuevo con otro número', async () => {
    const b = bank();
    b.adapter.createOrder.mockResolvedValue({ outcome: 'FAILED', items: [], issues: [] });

    await b.service.createOrder(TENANT, USER, dto(), KEY_A);
    await b.service.createOrder(TENANT, USER, dto(), KEY_A);

    expect(b.adapter.createOrder).toHaveBeenCalledTimes(2);
    expect(b.rows).toHaveLength(2);
    expect(b.rows.map((row) => row['order_number'])).toEqual([1, 2]);
    expect(b.rows.every((row) => row['create_request_key'] === null)).toBe(true);
  });

  it('si la key se libera entre el 23505 y la lectura, reintenta sólo el INSERT una vez', async () => {
    const b = bank({ releaseKeyOnNextUniqueViolation: true });
    await b.service.createOrder(TENANT, USER, dto(), KEY_A);

    await b.service.createOrder(TENANT, USER, dto(), KEY_A);

    expect(b.adapter.priceOffer).toHaveBeenCalledTimes(2);
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(2);
    expect(b.rows).toHaveLength(2);
  });

  it('no confunde un 23505 de order_number con la colisión de create_request_key', async () => {
    const b = bank({ uniqueConstraintName: 'uq_orders_tenant_order_number' });
    await b.service.createOrder(TENANT, USER, dto(), KEY_A);

    let thrown: unknown;
    try {
      await b.service.createOrder(TENANT, USER, dto(), KEY_A);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(ConflictException);
    expect(thrown).toMatchObject({ code: '23505', constraint: 'uq_orders_tenant_order_number' });
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
  });

  it('dos keys concurrentes reciben números distintos dentro del tenant', async () => {
    const b = bank();

    await Promise.all([
      b.service.createOrder(TENANT, USER, dto(), KEY_A),
      b.service.createOrder(TENANT, USER, dto(), KEY_B),
    ]);

    expect(b.rows.map((row) => row['order_number']).sort()).toEqual([1, 2]);
  });

  it('una cotización ajena se rechaza antes de priceOffer/createOrder', async () => {
    const b = bank();

    await expect(
      b.service.createOrder(TENANT, USER, dto(FOREIGN_QUOTATION)),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(b.adapter.priceOffer).not.toHaveBeenCalled();
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
    expect(b.rows).toEqual([]);
  });

  it('sin quotation ni Idempotency-Key válido falla antes de resolver/tocar proveedor', async () => {
    const b = bank();

    await expect(b.service.createOrder(TENANT, USER, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(b.service.createOrder(TENANT, USER, dto(), 'no-es-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(b.factory.resolveCalls).toEqual([]);
    expect(b.adapter.priceOffer).not.toHaveBeenCalled();
    expect(b.adapter.createOrder).not.toHaveBeenCalled();
  });

  it('quotationId deriva q:<uuid> y bloquea el segundo request sin header', async () => {
    const b = bank();
    await b.service.createOrder(TENANT, USER, dto(QUOTATION));

    await expect(b.service.createOrder(TENANT, USER, dto(QUOTATION))).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(b.rows[0]?.['create_request_key']).toBe(`q:${QUOTATION}`);
    expect(b.adapter.createOrder).toHaveBeenCalledTimes(1);
  });
});
