import type { CompiledQuery, Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  ReportsService,
  foldMonthlyTrend,
  foldSalesByCurrency,
  foldSalesByVertical,
  salesVertical,
  salesVerticalLabel,
  topPerformersByCurrency,
  type SellerSalesRow,
} from './reports.service.js';

/**
 * La vertical de cada orden en los reportes de ventas (docs/tbo/09 PR-4.6). Antes, cualquier
 * proveedor fuera de una lista fija contaba como vuelo: una reserva de hotel de TBO sumaba a
 * "Vuelos".
 */

describe('salesVerticalLabel', () => {
  it.each([
    ['tbo-hotels', 'hotels', 'Hoteles'],
    ['despegar-hotels', 'hotels', 'Hoteles'],
    ['agent-cars', 'cars', 'Autos'],
    ['sabre', 'flights', 'Vuelos'],
  ])('%s con `vertical: %s` → %s', (provider, vertical, label) => {
    expect(salesVerticalLabel(provider, vertical)).toBe(label);
  });

  it.each([
    ['hotelbeds', 'Hoteles'],
    ['hoteldo', 'Hoteles'],
    ['despegar-hotels', 'Hoteles'],
    ['assistcard', 'Asistencias'],
    ['latam-ndc', 'Vuelos'],
    // Las órdenes de vuelos no escriben `vertical`: un proveedor de vuelos nuevo sigue en Vuelos.
    ['sabre', 'Vuelos'],
  ])('sin vertical declarada, %s → %s', (provider, label) => {
    expect(salesVerticalLabel(provider, null)).toBe(label);
  });

  it('una vertical declarada que no se conoce cae a la de su proveedor', () => {
    expect(salesVerticalLabel('hotelbeds', 'cruceros')).toBe('Hoteles');
    expect(salesVerticalLabel('otro', 'cruceros')).toBe('Vuelos');
  });
});

describe('salesVertical: el código de la vertical, para quien no muestra etiquetas', () => {
  it.each([
    ['tbo-hotels', 'hotels', 'hotels'],
    ['agent-cars', 'cars', 'cars'],
    ['assistcard', null, 'assistance'],
    ['latam-ndc', null, 'flights'],
    ['hotelbeds', 'cruceros', 'hotels'],
    ['otro', 'cruceros', 'flights'],
  ] as const)('%s con `vertical: %s` → %s', (provider, vertical, code) => {
    expect(salesVertical(provider, vertical)).toBe(code);
  });

  it('una clave heredada de Object no es una vertical', () => {
    expect(salesVertical('otro', 'toString')).toBe('flights');
    expect(salesVerticalLabel('otro', 'constructor')).toBe('Vuelos');
  });
});

/** Los nombres de demostración que devolvía el servicio hasta G-16. */
const DEMO_NAMES = ['Carlos Mendoza', 'Diana Ortega', 'Juan Restrepo'];

describe('foldSalesByVertical: por vertical, nunca entre monedas', () => {
  it('sin filas, nada (antes: tres verticales inventadas)', () => {
    expect(foldSalesByVertical([])).toEqual([]);
  });

  it('COP y USD van aparte aunque sean de la misma vertical', () => {
    expect(
      foldSalesByVertical([
        {
          provider: 'latam-ndc',
          declared_vertical: null,
          currency: 'USD',
          orders: '1',
          amount_minor: '50000',
        },
        {
          provider: 'latam-ndc',
          declared_vertical: null,
          currency: 'COP',
          orders: '2',
          amount_minor: '300000',
        },
        {
          provider: 'tbo-hotels',
          declared_vertical: 'hotels',
          currency: 'COP',
          orders: 1,
          amount_minor: 70000,
        },
      ]),
    ).toEqual([
      { vertical: 'flights', currency: 'COP', totalAmountMinor: 300_000, count: 2 },
      { vertical: 'hotels', currency: 'COP', totalAmountMinor: 70_000, count: 1 },
      { vertical: 'flights', currency: 'USD', totalAmountMinor: 50_000, count: 1 },
    ]);
  });

  it('junta los proveedores de una vertical en la misma moneda', () => {
    expect(
      foldSalesByVertical([
        {
          provider: 'hotelbeds',
          declared_vertical: null,
          currency: 'COP',
          orders: '1',
          amount_minor: '10000',
        },
        {
          provider: 'tbo-hotels',
          declared_vertical: 'hotels',
          currency: 'COP',
          orders: '2',
          amount_minor: '20000',
        },
        // Una fila sin órdenes no es una vertical vendida.
        {
          provider: 'agent-cars',
          declared_vertical: 'cars',
          currency: 'COP',
          orders: 0,
          amount_minor: 0,
        },
      ]),
    ).toEqual([{ vertical: 'hotels', currency: 'COP', totalAmountMinor: 30_000, count: 3 }]);
  });

  it('a igual monto, en el orden de las verticales', () => {
    const rows = foldSalesByVertical([
      {
        provider: 'agent-cars',
        declared_vertical: 'cars',
        currency: 'PEN',
        orders: 1,
        amount_minor: 5,
      },
      {
        provider: 'latam-ndc',
        declared_vertical: null,
        currency: 'PEN',
        orders: 1,
        amount_minor: 5,
      },
    ]);
    expect(rows.map((r) => r.vertical)).toEqual(['flights', 'cars']);
  });

  it('un monto que no es número cuenta como cero', () => {
    expect(
      foldSalesByVertical([
        {
          provider: 'x',
          declared_vertical: null,
          currency: 'COP',
          orders: '1',
          amount_minor: null,
        },
        {
          provider: 'x',
          declared_vertical: null,
          currency: 'USD',
          orders: '1',
          amount_minor: 'n/a',
        },
      ]).map((r) => r.totalAmountMinor),
    ).toEqual([0, 0]);
  });
});

describe('foldMonthlyTrend: por mes y moneda', () => {
  it('sin filas, nada (antes: cinco meses inventados)', () => {
    expect(foldMonthlyTrend([])).toEqual([]);
  });

  it('del mes más viejo al más nuevo, cada moneda en su fila', () => {
    expect(
      foldMonthlyTrend([
        { month: '2026-10', currency: 'USD', orders: '1', amount_minor: '50000' },
        { month: '2026-09', currency: 'COP', orders: '3', amount_minor: '999' },
        { month: '2026-10', currency: 'COP', orders: '2', amount_minor: '300000' },
        { month: '2026-08', currency: 'COP', orders: '0', amount_minor: '0' },
      ]),
    ).toEqual([
      { month: '2026-09', currency: 'COP', amountMinor: 999, count: 3 },
      { month: '2026-10', currency: 'COP', amountMinor: 300_000, count: 2 },
      { month: '2026-10', currency: 'USD', amountMinor: 50_000, count: 1 },
    ]);
  });
});

function seller(
  userId: string,
  currency: string,
  amount: number,
  orders: number,
  name: string | null = `Vendedor ${userId}`,
): SellerSalesRow {
  return {
    user_id: userId,
    name,
    email: `${userId}@agencia.test`,
    currency,
    orders: String(orders),
    amount_minor: String(amount),
  };
}

describe('topPerformersByCurrency: los vendedores reales, por moneda', () => {
  it('sin ventas, nadie (antes: tres vendedores fijos)', () => {
    expect(topPerformersByCurrency([])).toEqual([]);
  });

  it('cinco por moneda, de mayor a menor; quien vendió en dos monedas va en las dos', () => {
    const rows = [
      seller('u1', 'COP', 100, 1),
      seller('u2', 'COP', 600, 2),
      seller('u3', 'COP', 300, 1),
      seller('u4', 'COP', 500, 1),
      seller('u5', 'COP', 200, 4),
      seller('u6', 'COP', 400, 1),
      seller('u1', 'USD', 80, 1),
    ];
    const top = topPerformersByCurrency(rows);
    expect(top.filter((t) => t.currency === 'COP').map((t) => t.userId)).toEqual([
      'u2',
      'u4',
      'u6',
      'u3',
      'u5',
    ]);
    expect(top.filter((t) => t.currency === 'USD')).toEqual([
      { userId: 'u1', name: 'Vendedor u1', currency: 'USD', salesMinor: 80, count: 1 },
    ]);
    expect(top.map((t) => t.currency)).toEqual(['COP', 'COP', 'COP', 'COP', 'COP', 'USD']);
  });

  it('a igual monto, más reservas primero; después por nombre', () => {
    const top = topPerformersByCurrency([
      seller('a', 'COP', 100, 1, 'Zoe'),
      seller('b', 'COP', 100, 3, 'Ana'),
      seller('c', 'COP', 100, 1, 'Beto'),
    ]);
    expect(top.map((t) => t.name)).toEqual(['Ana', 'Beto', 'Zoe']);
  });

  it('sin nombre, el correo', () => {
    const [only] = topPerformersByCurrency([seller('u9', 'COP', 1, 1, '  ')]);
    expect(only?.name).toBe('u9@agencia.test');
    const [other] = topPerformersByCurrency([seller('u8', 'COP', 1, 1, null)]);
    expect(other?.name).toBe('u8@agencia.test');
  });

  it('respeta el límite pedido y salta filas sin órdenes', () => {
    expect(
      topPerformersByCurrency([seller('a', 'COP', 9, 1), seller('b', 'COP', 8, 1)], 1),
    ).toHaveLength(1);
    expect(topPerformersByCurrency([seller('a', 'COP', 0, 0)])).toEqual([]);
  });
});

describe('foldSalesByCurrency: un monto por moneda', () => {
  it('sin ventas, vacío', () => {
    expect(foldSalesByCurrency([])).toEqual([]);
  });

  it('en orden alfabético y sin sumar monedas', () => {
    expect(
      foldSalesByCurrency([
        { currency: 'USD', amount_minor: '50000' },
        { currency: 'COP', amount_minor: '300000' },
        { currency: 'COP', amount_minor: 1 },
      ]),
    ).toEqual([
      { currency: 'COP', amountMinor: 300_001 },
      { currency: 'USD', amountMinor: 50_000 },
    ]);
  });
});

// ─────────────────────────── El servicio, sin Postgres ───────────────────────────

const TENANT = '00000000-0000-4000-8000-000000000a01';

function serviceWith(respond: (q: CompiledQuery) => unknown[]) {
  const k = scriptedKysely(respond);
  const db = {
    withTenant: <T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>) => {
      expect(tenantId).toBe(TENANT);
      return k.db.transaction().execute(fn);
    },
  };
  return { service: new ReportsService(db as unknown as DatabaseService), k };
}

const WINDOW_ROW = {
  from_at: new Date('2025-11-01T05:00:00.000Z'),
  from_month: '2025-11',
  to_month: '2026-10',
};

describe('ReportsService.getSalesMetrics', () => {
  it('sin ventas devuelve listas vacías, nunca los datos de demostración', async () => {
    const { service, k } = serviceWith((q) => (q.sql.includes('from_month') ? [WINDOW_ROW] : []));
    const metrics = await service.getSalesMetrics(TENANT);
    expect(metrics).toEqual({
      period: { from: '2025-11', to: '2026-10', timeZone: 'America/Bogota' },
      byVertical: [],
      monthlyTrend: [],
      topPerformers: [],
    });
    const json = JSON.stringify(metrics);
    for (const name of DEMO_NAMES) expect(json).not.toContain(name);
    // Toda consulta a orders va acotada al tenant y a lo confirmado del período.
    const ordersQueries = k.queries.filter((q) => q.sql.includes('FROM orders'));
    expect(ordersQueries).toHaveLength(3);
    for (const q of ordersQueries) {
      expect(q.sql).toContain('o.tenant_id = $');
      expect(q.parameters).toContain(TENANT);
      expect(q.sql).toContain("o.status IN ('confirmed', 'ticketed')");
      expect(q.parameters).toContain(WINDOW_ROW.from_at);
    }
  });

  it('COP y USD van aparte en verticales, meses y vendedores', async () => {
    const { service } = serviceWith((q) => {
      if (q.sql.includes('from_month')) return [WINDOW_ROW];
      if (q.sql.includes('JOIN users')) {
        return [
          seller('u1', 'COP', 300_000, 2, 'Ana Ruiz'),
          seller('u1', 'USD', 50_000, 1, 'Ana Ruiz'),
        ];
      }
      if (q.sql.includes('s.month')) {
        return [
          { month: '2026-10', currency: 'COP', orders: '2', amount_minor: '300000' },
          { month: '2026-10', currency: 'USD', orders: '1', amount_minor: '50000' },
        ];
      }
      return [
        {
          provider: 'latam-ndc',
          declared_vertical: null,
          currency: 'COP',
          orders: '2',
          amount_minor: '300000',
        },
        {
          provider: 'latam-ndc',
          declared_vertical: null,
          currency: 'USD',
          orders: '1',
          amount_minor: '50000',
        },
      ];
    });
    const metrics = await service.getSalesMetrics(TENANT);
    expect(metrics.byVertical).toEqual([
      { vertical: 'flights', currency: 'COP', totalAmountMinor: 300_000, count: 2 },
      { vertical: 'flights', currency: 'USD', totalAmountMinor: 50_000, count: 1 },
    ]);
    expect(metrics.monthlyTrend.map((m) => [m.currency, m.amountMinor])).toEqual([
      ['COP', 300_000],
      ['USD', 50_000],
    ]);
    expect(metrics.topPerformers.map((t) => [t.name, t.currency, t.salesMinor])).toEqual([
      ['Ana Ruiz', 'COP', 300_000],
      ['Ana Ruiz', 'USD', 50_000],
    ]);
  });

  it('si Postgres no devuelve el período, falla en voz alta', async () => {
    const { service } = serviceWith(() => []);
    await expect(service.getSalesMetrics(TENANT)).rejects.toThrow(
      'Postgres no devolvió el período del reporte',
    );
  });
});

describe('ReportsService.getCommissions', () => {
  it('no hay comisiones reales todavía: lo dice, sin números', () => {
    const { service, k } = serviceWith(() => []);
    expect(service.getCommissions()).toEqual({ available: false, byVertical: [], summary: null });
    expect(k.queries).toEqual([]);
  });
});

describe('ReportsService.getDashboardKpis', () => {
  it('las ventas del mes van por moneda; sin ventas, lista vacía', async () => {
    const { service, k } = serviceWith((q) => {
      if (q.sql.includes('"currency"')) {
        return [
          { currency: 'USD', amount_minor: '50000' },
          { currency: 'COP', amount_minor: '300000' },
        ];
      }
      if (q.sql.includes('"quotations"')) return [{ count: '4' }];
      if (q.sql.includes('"customers"')) return [{ count: '7' }];
      return [{ count: '3' }];
    });
    expect(await service.getDashboardKpis(TENANT)).toEqual({
      quotationsThisMonth: 4,
      confirmedThisMonth: 3,
      activeCustomers: 7,
      salesThisMonth: [
        { currency: 'COP', amountMinor: 300_000 },
        { currency: 'USD', amountMinor: 50_000 },
      ],
    });
    // El mes es el de Bogotá, como en Reportes.
    const monthly = k.queries.filter((q) => q.sql.includes('date_trunc'));
    expect(monthly).toHaveLength(3);
    for (const q of monthly) expect(q.parameters).toContain('America/Bogota');

    const empty = serviceWith(() => []);
    expect(await empty.service.getDashboardKpis(TENANT)).toEqual({
      quotationsThisMonth: 0,
      confirmedThisMonth: 0,
      activeCustomers: 0,
      salesThisMonth: [],
    });
  });
});
