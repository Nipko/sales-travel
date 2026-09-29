import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import { BookingHoldRejectedError } from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';

/**
 * Retención de cartera sobre la orden ABIERTA, antes del Book (docs/tbo/09 PR-4.8; 08 RF-23 CA 1
 * y 2; D-TBO-21 A). La SQL real la prueba `portfolios.hold-intent.integration.test.ts`; aquí, con un
 * banco transaccional mínimo, lo que decide el servicio: qué orden admite, qué lee, cuánto retiene
 * y que un rechazo no deja nada escrito.
 */

const SUBAGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDEN = '22222222-2222-4222-8222-2222222222aa';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const CARTERA = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-26T12:00:00.000Z');

const USD = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

interface Estado {
  order: Record<string, unknown> | null;
  portfolio: {
    id: string;
    tenant_id: string;
    credit_limit_minor: number;
    balance_minor: number;
    currency: string;
    status: string;
    created_at: Date;
    updated_at: Date;
  };
  tenant: { id: string; credit_limit: string; default_currency: string };
  transactions: Record<string, unknown>[];
  /** Qué tablas se leyeron con `FOR UPDATE`. */
  locks: string[];
  tenantReads: number;
}

function copia(s: Estado): Estado {
  return {
    ...s,
    order: s.order ? { ...s.order } : null,
    portfolio: { ...s.portfolio },
    transactions: s.transactions.map((t) => ({ ...t })),
    locks: [...s.locks],
  };
}

function banco(inicial: Partial<Estado> = {}) {
  const estado: Estado = {
    order: {
      id: ORDEN,
      tenant_id: SUBAGENCIA,
      status: 'pending',
      total_amount: 34_012,
      currency: 'USD',
      provider_raw: null,
      create_request_key: 'c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    portfolio: {
      id: CARTERA,
      tenant_id: SUBAGENCIA,
      credit_limit_minor: 0,
      balance_minor: 100_000,
      currency: 'USD',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
    tenant: { id: SUBAGENCIA, credit_limit: '0.00', default_currency: 'USD' },
    transactions: [],
    locks: [],
    tenantReads: 0,
    ...inicial,
  };

  let cola = Promise.resolve();
  const db = {
    withTenant: async <T>(tenantId: string, fn: (trx: unknown) => Promise<T>): Promise<T> => {
      let liberar!: () => void;
      const turno = new Promise<void>((resolve) => {
        liberar = resolve;
      });
      const anterior = cola;
      cola = anterior.then(() => turno);
      await anterior;

      const local = copia(estado);
      let retenido = 0;

      const selectFrom = (tabla: string) => {
        const filtros: [string, unknown][] = [];
        let bloqueo = false;
        const fila = (): Record<string, unknown> | undefined => {
          const r: Record<string, unknown> | null =
            tabla === 'orders'
              ? local.order
              : tabla === 'agency_portfolios'
                ? local.portfolio
                : tabla === 'tenants'
                  ? local.tenant
                  : null;
          if (!r) return undefined;
          // RLS: sólo lo del tenant de la transacción (y `tenants` no tiene RLS).
          if (tabla !== 'tenants' && r['tenant_id'] !== tenantId) return undefined;
          return filtros.every(([c, v]) => !(c in r) || r[c] === v) ? r : undefined;
        };
        const q = {
          select: () => q,
          selectAll: () => q,
          where: (c: unknown, _op?: unknown, v?: unknown) => {
            if (typeof c === 'string') filtros.push([c, v]);
            return q;
          },
          forUpdate: () => {
            bloqueo = true;
            return q;
          },
          executeTakeFirst: () => {
            if (bloqueo) local.locks.push(tabla);
            if (tabla === 'tenants') local.tenantReads += 1;
            return Promise.resolve(fila());
          },
          executeTakeFirstOrThrow: () => {
            if (bloqueo) local.locks.push(tabla);
            const r = fila();
            return r ? Promise.resolve(r) : Promise.reject(new Error('no result'));
          },
        };
        return q;
      };

      const insertInto = (tabla: string) => {
        let valores: Record<string, unknown> = {};
        const q = {
          values: (v: Record<string, unknown>) => {
            valores = v;
            return q;
          },
          returningAll: () => q,
          executeTakeFirstOrThrow: () => {
            if (tabla !== 'portfolio_transactions') throw new Error(`insert en ${tabla}`);
            const ref = String(valores['reference_id']).toLowerCase();
            if (
              local.transactions.some(
                (t) =>
                  t['transaction_type'] === valores['transaction_type'] &&
                  String(t['reference_id']).toLowerCase() === ref,
              )
            ) {
              return Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' }));
            }
            retenido = Math.abs(Number(valores['amount_minor']));
            const row = { id: `tx-${local.transactions.length + 1}`, ...valores, created_at: NOW };
            local.transactions.push(row);
            return Promise.resolve(row);
          },
        };
        return q;
      };

      const updateTable = (tabla: string) => {
        const q = {
          set: () => q,
          where: () => q,
          returningAll: () => q,
          executeTakeFirst: () => {
            if (tabla !== 'agency_portfolios' || local.portfolio.status !== 'active') {
              return Promise.resolve(undefined);
            }
            local.portfolio.balance_minor -= retenido;
            return Promise.resolve(local.portfolio);
          },
        };
        return q;
      };

      try {
        const out = await fn({ selectFrom, insertInto, updateTable });
        Object.assign(estado, local);
        return out;
      } finally {
        liberar();
      }
    },
  } as unknown as DatabaseService;

  const service = new PortfoliosService(
    db,
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  return { service, estado };
}

async function rechazo(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

describe('PortfoliosService.assertBookingHoldAffordable: el control previo, sin escribir', () => {
  it('sin cartera en la moneda de la tarifa → rechazo con motivo, sin abrir una ni escribir', async () => {
    const b = banco({ portfolio: { ...banco().estado.portfolio, currency: 'COP' } });

    const err = await rechazo(b.service.assertBookingHoldAffordable(SUBAGENCIA, USD(34_012)));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect((err as BookingHoldRejectedError).message).toBe(
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    );
    expect(b.estado.transactions).toHaveLength(0);
  });

  it('el cupo que fija quien financia alcanza, y no retiene nada', async () => {
    const b = banco({
      portfolio: { ...banco().estado.portfolio, balance_minor: 0, credit_limit_minor: 34_012 },
    });

    await expect(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, USD(34_012)),
    ).resolves.toBeUndefined();
    expect(b.estado.transactions).toHaveLength(0);
    expect(b.estado.portfolio.balance_minor).toBe(0);
  });

  it('ya no lee el crédito interno de 0007: sólo manda la cartera', async () => {
    const b = banco({
      portfolio: { ...banco().estado.portfolio, balance_minor: 0, credit_limit_minor: 34_011 },
      tenant: { id: SUBAGENCIA, credit_limit: '1000000.00', default_currency: 'USD' },
    });

    const err = await rechazo(b.service.assertBookingHoldAffordable(SUBAGENCIA, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect(b.estado.tenantReads).toBe(0);
  });

  it.each([
    ['monto cero', { amountMinor: 0, currency: 'USD' }],
    ['monto no entero', { amountMinor: 1.5, currency: 'USD' }],
    ['moneda inválida', { amountMinor: 100, currency: 'dólares' }],
  ])('%s → 400 sin tocar la base', async (_caso, amount) => {
    const b = banco();

    await expect(b.service.assertBookingHoldAffordable(SUBAGENCIA, amount)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(b.estado.tenantReads).toBe(0);
  });
});

describe('PortfoliosService.holdBookingIntent: la retención sobre la orden abierta', () => {
  it('retiene el total de la orden, con la orden y la cartera bloqueadas antes de decidir', async () => {
    const b = banco();

    const { transaction, portfolio } = await b.service.holdBookingIntent(
      SUBAGENCIA,
      ORDEN,
      USUARIO,
      USD(34_012),
    );

    expect(transaction).toMatchObject({
      portfolio_id: CARTERA,
      amount_minor: -34_012,
      transaction_type: 'BOOKING_HOLD',
      reference_id: ORDEN,
      created_by: USUARIO,
      notes: 'Retención de saldo antes de reservar con el proveedor',
    });
    expect(portfolio.balance_minor).toBe(100_000 - 34_012);
    expect(b.estado.locks).toEqual(['orders', 'agency_portfolios']);
  });

  it('el cupo de la cartera acota lo que se retiene, también con una cuenta heredada', async () => {
    const b = banco({
      portfolio: { ...banco().estado.portfolio, balance_minor: 10_000, credit_limit_minor: 24_011 },
      tenant: { id: SUBAGENCIA, credit_limit: '1000000.00', default_currency: 'USD' },
    });

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect(b.estado.transactions).toHaveLength(0);
    expect(b.estado.portfolio.balance_minor).toBe(10_000);

    b.estado.portfolio.credit_limit_minor = 24_012;
    await b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012));
    expect(b.estado.portfolio.balance_minor).toBe(10_000 - 34_012);
  });

  it('sin cartera en la moneda de la orden no retiene ni deja el asiento', async () => {
    const b = banco({ portfolio: { ...banco().estado.portfolio, currency: 'COP' } });

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect(b.estado.transactions).toHaveLength(0);
    expect(b.estado.portfolio.balance_minor).toBe(100_000);
  });

  it('la cartera sin saldo ni cupo no retiene y no deja el asiento', async () => {
    const b = banco({ portfolio: { ...banco().estado.portfolio, balance_minor: 34_011 } });

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect(b.estado.transactions).toHaveLength(0);
  });

  it.each([
    ['confirmada', { status: 'confirmed' }],
    ['fallida', { status: 'failed' }],
    ['ya consolidada', { provider_raw: { phase: 'create' } }],
    ['sin clave de creación', { create_request_key: null }],
  ])('una orden %s no es un intent abierto: 400 sin retener', async (_caso, cambio) => {
    const base = banco().estado.order ?? {};
    const b = banco({ order: { ...base, ...cambio } });

    await expect(
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ).rejects.toThrow(/Sólo una reserva abierta/);
    expect(b.estado.transactions).toHaveLength(0);
  });

  it('la orden de otro tenant no existe para este (RLS)', async () => {
    const b = banco();

    await expect(b.service.holdBookingIntent(OTRA, ORDEN, USUARIO, USD(34_012))).rejects.toThrow(
      /No se encontró la reserva/,
    );
  });

  it('retiene lo que la orden dice: si la saga espera otro total, no retiene nada', async () => {
    const b = banco();

    for (const esperado of [USD(34_000), { amountMinor: 34_012, currency: 'EUR' }]) {
      await expect(
        b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, esperado),
      ).rejects.toThrow(/El total de la reserva cambió/);
    }
    expect(b.estado.transactions).toHaveLength(0);
  });

  it('una segunda retención de la misma orden es 409 y no debita dos veces', async () => {
    const b = banco();

    const resultados = await Promise.allSettled([
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const perdida = resultados.find((r) => r.status === 'rejected');
    expect(perdida?.status === 'rejected' ? perdida.reason : undefined).toBeInstanceOf(
      ConflictException,
    );
    expect(b.estado.transactions).toHaveLength(1);
    expect(b.estado.portfolio.balance_minor).toBe(100_000 - 34_012);
  });
});
