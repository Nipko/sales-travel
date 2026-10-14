import { describe, expect, it } from 'vitest';
import {
  SALES_CSV_HEADER,
  amountWithCode,
  bookingsText,
  currencySummaries,
  monthName,
  monthlySeries,
  parseDashboardKpis,
  parseSalesMetrics,
  periodMonths,
  periodText,
  reportCurrencies,
  salesReportCsv,
  salesReportFilename,
  salesThisMonthLines,
  salesVerticalName,
  shortMonthName,
  topPerformersIn,
  verticalShares,
  type SalesMetrics,
} from './sales-reports';
import { NO_SALES, salesPayload } from './sales-reports.fixture';

function metrics(overrides: Record<string, unknown> = {}): SalesMetrics {
  const parsed = parseSalesMetrics(salesPayload(overrides));
  if (parsed === undefined) throw new Error('el fixture no se pudo leer');
  return parsed;
}

const EMPTY = NO_SALES;

describe('parseSalesMetrics', () => {
  it('lee la respuesta del API', () => {
    const m = metrics();
    expect(m.period).toEqual({ from: '2025-11', to: '2026-10' });
    expect(m.byVertical).toHaveLength(3);
    expect(m.monthlyTrend).toHaveLength(3);
    expect(m.topPerformers).toHaveLength(3);
  });

  it('sin ventas, listas vacías', () => {
    expect(parseSalesMetrics(salesPayload(EMPTY))).toEqual({
      period: { from: '2025-11', to: '2026-10' },
      ...EMPTY,
    });
  });

  it.each([
    ['no es objeto', null],
    ['sin período', salesPayload({ period: undefined })],
    ['mes inválido', salesPayload({ period: { from: '2025-13', to: '2026-10' } })],
    ['período al revés', salesPayload({ period: { from: '2026-10', to: '2025-11' } })],
    [
      'la forma vieja (montos sin moneda)',
      salesPayload({ byVertical: [{ vertical: 'Vuelos', totalAmountMinor: 1, count: 1 }] }),
    ],
    [
      'monto negativo',
      salesPayload({
        monthlyTrend: [{ month: '2026-10', currency: 'COP', amountMinor: -1, count: 1 }],
      }),
    ],
    [
      'vendedor sin nombre',
      salesPayload({
        topPerformers: [{ userId: 'u', name: ' ', currency: 'COP', salesMinor: 1, count: 1 }],
      }),
    ],
    ['lista que no es lista', salesPayload({ topPerformers: {} })],
  ])('%s → undefined', (_label, payload) => {
    expect(parseSalesMetrics(payload)).toBeUndefined();
  });
});

describe('parseDashboardKpis', () => {
  const base = { quotationsThisMonth: 4, confirmedThisMonth: 3, activeCustomers: 7 };

  it('las ventas del mes por moneda', () => {
    expect(
      parseDashboardKpis({
        ...base,
        salesThisMonth: [
          { currency: 'COP', amountMinor: 700_000_00 },
          { currency: 'USD', amountMinor: 500_50 },
        ],
      }),
    ).toEqual({
      ...base,
      salesThisMonth: [
        { currency: 'COP', amountMinor: 700_000_00 },
        { currency: 'USD', amountMinor: 500_50 },
      ],
    });
  });

  it('la forma vieja (un monto y una moneda) no se lee', () => {
    expect(
      parseDashboardKpis({ ...base, salesThisMonthMinor: 1_000, currency: 'COP' }),
    ).toBeUndefined();
    expect(
      parseDashboardKpis({ ...base, quotationsThisMonth: -1, salesThisMonth: [] }),
    ).toBeUndefined();
    expect(parseDashboardKpis([])).toBeUndefined();
    expect(
      parseDashboardKpis({ ...base, salesThisMonth: [{ currency: 'pesos', amountMinor: 1 }] }),
    ).toBeUndefined();
  });
});

describe('por moneda, nunca sumadas', () => {
  it('un resumen por moneda: la que más reservas confirmó primero', () => {
    expect(currencySummaries(metrics())).toEqual([
      { currency: 'COP', amountMinor: 707_000_00, count: 4, averageMinor: 176_750_00 },
      { currency: 'USD', amountMinor: 500_50, count: 1, averageMinor: 500_50 },
    ]);
    expect(reportCurrencies(metrics())).toEqual(['COP', 'USD']);
  });

  it('a igual cantidad, en orden alfabético', () => {
    const m = metrics({
      byVertical: [
        { vertical: 'flights', currency: 'USD', totalAmountMinor: 1, count: 1 },
        { vertical: 'flights', currency: 'PEN', totalAmountMinor: 1, count: 1 },
      ],
    });
    expect(reportCurrencies(m)).toEqual(['PEN', 'USD']);
  });

  it('sin ventas, ninguna moneda', () => {
    expect(currencySummaries(metrics(EMPTY))).toEqual([]);
  });

  it('verticales de la moneda, de mayor a menor, con su parte', () => {
    expect(verticalShares(metrics(), 'COP').map((v) => [v.vertical, Math.round(v.share)])).toEqual([
      ['hotels', 57],
      ['flights', 43],
    ]);
    expect(verticalShares(metrics(), 'USD').map((v) => v.share)).toEqual([100]);
    expect(verticalShares(metrics(), 'BRL')).toEqual([]);
  });

  it('vendedores de la moneda, en el orden del API', () => {
    expect(topPerformersIn(metrics(), 'COP').map((p) => p.name)).toEqual([
      'Bruno Díaz',
      'Ana Ruiz',
    ]);
    expect(topPerformersIn(metrics(), 'USD').map((p) => p.salesMinor)).toEqual([500_50]);
  });
});

describe('meses', () => {
  it('los 12 meses del período, cruzando el año', () => {
    const months = periodMonths({ from: '2025-11', to: '2026-10' });
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-11');
    expect(months[2]).toBe('2026-01');
    expect(months[11]).toBe('2026-10');
    expect(periodMonths({ from: '2026-10', to: '2026-10' })).toEqual(['2026-10']);
  });

  it('la serie de una moneda tiene todos los meses; los que no vendieron, en cero', () => {
    const series = monthlySeries(metrics(), 'COP');
    expect(series).toHaveLength(12);
    expect(series.find((m) => m.month === '2026-01')).toEqual({
      month: '2026-01',
      currency: 'COP',
      amountMinor: 7_000_00,
      count: 1,
    });
    expect(series.find((m) => m.month === '2026-02')).toEqual({
      month: '2026-02',
      currency: 'COP',
      amountMinor: 0,
      count: 0,
    });
    expect(monthlySeries(metrics(), 'USD').filter((m) => m.count > 0)).toHaveLength(1);
  });

  it('nombres de mes y del período', () => {
    expect(monthName('2026-10')).toBe('octubre de 2026');
    expect(shortMonthName('2026-10')).toBe('oct 2026');
    expect(shortMonthName('raro')).toBe('raro');
    expect(monthName('raro')).toBe('raro');
    expect(periodText({ from: '2025-11', to: '2026-10' })).toBe(
      'De noviembre de 2025 a octubre de 2026',
    );
    expect(periodText({ from: '2026-10', to: '2026-10' })).toBe('octubre de 2026');
  });
});

describe('textos', () => {
  it('"{monto} {moneda}", sin centavos en COP', () => {
    expect(amountWithCode(1_500_000_00, 'COP')).toBe('1.500.000 COP');
    expect(amountWithCode(80_50, 'USD')).toBe('80,50 USD');
    expect(salesThisMonthLines([])).toEqual([]);
    expect(
      salesThisMonthLines([
        { currency: 'COP', amountMinor: 700_000_00 },
        { currency: 'USD', amountMinor: 500_50 },
      ]),
    ).toEqual(['700.000 COP', '500,50 USD']);
  });

  it('verticales y reservas', () => {
    expect(salesVerticalName('flights')).toBe('Vuelos');
    expect(salesVerticalName('assistance')).toBe('Asistencias');
    expect(salesVerticalName('cruceros')).toBe('cruceros');
    expect(salesVerticalName('toString')).toBe('toString');
    expect(bookingsText(1)).toBe('1 reserva');
    expect(bookingsText(3)).toBe('3 reservas');
  });
});

describe('salesReportCsv', () => {
  function lines(csv: string): string[] {
    return csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
  }

  it('sólo filas reales, todas las monedas, cada fila con la suya', () => {
    const csv = salesReportCsv(metrics());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)).toEqual([
      SALES_CSV_HEADER.join(','),
      'Vertical,Hoteles,COP,1,400000.00',
      'Vertical,Vuelos,COP,3,307000.00',
      'Vertical,Vuelos,USD,1,500.50',
      'Mes,2026-01,COP,1,7000.00',
      'Mes,2026-10,COP,3,700000.00',
      'Mes,2026-10,USD,1,500.50',
      'Vendedor,Bruno Díaz,COP,1,400000.00',
      'Vendedor,Ana Ruiz,COP,3,307000.00',
      'Vendedor,Ana Ruiz,USD,1,500.50',
    ]);
    expect(SALES_CSV_HEADER).toContain('Moneda');
    expect(csv).not.toMatch(/TOTAL|Comisi|Markup/i);
  });

  it('sin ventas, sólo el encabezado', () => {
    expect(lines(salesReportCsv(metrics(EMPTY)))).toEqual([SALES_CSV_HEADER.join(',')]);
  });

  it('un nombre con comas o comillas va entre comillas; uno que parece fórmula, neutralizado', () => {
    const csv = salesReportCsv(
      metrics({
        topPerformers: [
          { userId: 'a', name: 'Ruiz, Ana "la jefa"', currency: 'COP', salesMinor: 1, count: 1 },
          { userId: 'b', name: '=HYPERLINK("x")', currency: 'COP', salesMinor: 1, count: 1 },
          { userId: 'c', name: '@SUM(A1)', currency: 'COP', salesMinor: 1, count: 1 },
        ],
      }),
    );
    expect(csv).toContain('Vendedor,"Ruiz, Ana ""la jefa""",COP,1,0.01');
    expect(csv).toContain(`Vendedor,"'=HYPERLINK(""x"")",COP,1,0.01`);
    expect(csv).toContain("Vendedor,'@SUM(A1),COP,1,0.01");
  });

  it('el archivo se llama por su período', () => {
    expect(salesReportFilename({ from: '2025-11', to: '2026-10' })).toBe(
      'ventas-2025-11-a-2026-10.csv',
    );
  });
});
