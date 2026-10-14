import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseSalesMetrics, type SalesMetrics } from '../../../lib/sales-reports';
import { NO_SALES, salesPayload } from '../../../lib/sales-reports.fixture';
import { voseoIn } from '../../../lib/voseo';
import { COMMISSIONS_NOTICE, NO_SALES_TEXT, ReportesClient, SalesReport } from './ReportesClient';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../lib/api', () => ({ api: mocks.api }));

import ReportesPage from './page';

/** Formas de usted que tenía la pantalla (va en tú neutro). */
const USTED = /(?<!\p{L})(?:audite|revise|exporte|su|sus|usted)(?!\p{L})/giu;

/** Lo que la pantalla inventaba hasta G-16. */
const DEMO = [
  'Carlos Mendoza',
  'Diana Ortega',
  'Juan Restrepo',
  'vs mes anterior',
  'eficiencia global',
  'Proyectado',
  'Comisiones Recibidas',
  'Markup Propietario',
];

function metrics(overrides: Record<string, unknown> = {}): SalesMetrics {
  const parsed = parseSalesMetrics(salesPayload(overrides));
  if (parsed === undefined) throw new Error('el fixture no se pudo leer');
  return parsed;
}

function render(m: SalesMetrics | null, error: string | null = null): string {
  return renderToStaticMarkup(createElement(ReportesClient, { metrics: m, error }));
}

/** El texto visible (y el de lectores de pantalla), sin etiquetas. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

function checkedValues(html: string): (string | undefined)[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('checked=""'))
    .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);
}

function expectInTu(text: string) {
  expect(voseoIn(text)).toEqual([]);
  expect([...text.matchAll(USTED)].map((m) => m[0])).toEqual([]);
}

describe('Reportes sin ventas', () => {
  const html = render(metrics(NO_SALES));
  const text = textOf(html);

  it('lo dice, sin números inventados', () => {
    expect(html).toContain('<h1');
    expect(text).toContain('Reportes');
    expect(text).toContain('Revisa tus ventas por vertical, por mes y por vendedor.');
    expect(text).toContain(NO_SALES_TEXT);
    for (const demo of DEMO) expect(text).not.toContain(demo);
    expect(text).not.toMatch(/\$\s?\d/);
  });

  it('el aviso de comisiones, y Exportar CSV deshabilitado: no hay filas reales', () => {
    expect(text).toContain('Comisiones y márgenes');
    expect(text).toContain(COMMISSIONS_NOTICE);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Exportar CSV/s);
  });

  it('dice qué período mira', () => {
    expect(text).toContain(
      'Ventas confirmadas · De noviembre de 2025 a octubre de 2026 · hora de Bogotá',
    );
  });

  it('va en tú', () => {
    expectInTu(text);
  });
});

describe('Reportes con ventas en COP y USD', () => {
  const html = render(metrics());
  const text = textOf(html);

  it('una moneda a la vez, con selector; arranca en la que más reservas tuvo', () => {
    expect(text).toContain('Moneda del reporte');
    expect(checkedValues(html)).toEqual(['COP']);
    expect(text).toContain(
      'Cada moneda va por separado: nunca sumamos montos de monedas distintas.',
    );
    expect(text).toContain('Ventas confirmadas · COP');
    expect(text).toContain('$ 707.000');
    expect(text).toContain('Ticket promedio $ 176.750');
    // Nada de USD en la vista de COP, y nunca un total entre monedas.
    expect(text).not.toContain('US$');
    expect(text).not.toMatch(/total/i);
  });

  it('por mes, por vertical y por vendedor, en COP', () => {
    expect(text).toContain('Por mes · COP');
    expect(text).toContain('octubre de 2026');
    expect(text).toContain('$ 700.000');
    // Los meses sin ventas se ven en cero, no se saltan.
    expect(text).toContain('febrero de 2026');
    expect(text).toContain('Por vertical · COP');
    expect(text).toContain('Hoteles');
    expect(text).toContain('Vuelos');
    expect(text).toContain('57 %');
    expect(text).toContain('Por vendedor · COP');
    expect(text.indexOf('Bruno Díaz')).toBeLessThan(text.indexOf('Ana Ruiz'));
    expect(text).toContain('3 reservas');
    for (const demo of DEMO) expect(text).not.toContain(demo);
  });

  it('el aviso de comisiones sigue, y se puede exportar', () => {
    expect(text).toContain(COMMISSIONS_NOTICE);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Exportar CSV/s);
  });

  it('va en tú', () => {
    expectInTu(text);
  });
});

describe('SalesReport en otra moneda', () => {
  it('USD con su símbolo, sin mezclar COP', () => {
    const m = metrics();
    const summaries = [
      { currency: 'COP', amountMinor: 707_000_00, count: 4, averageMinor: 176_750_00 },
      { currency: 'USD', amountMinor: 500_50, count: 1, averageMinor: 500_50 },
    ];
    const html = renderToStaticMarkup(
      createElement(SalesReport, {
        metrics: m,
        summaries,
        selected: summaries[1]!,
        onPick: () => undefined,
      }),
    );
    const text = textOf(html);
    expect(checkedValues(html)).toEqual(['USD']);
    expect(text).toContain('Ventas confirmadas · USD');
    expect(text).toContain('US$ 500,50');
    expect(text).toContain('Ana Ruiz');
    expect(text).not.toContain('Bruno Díaz');
    expect(text).not.toContain('Hoteles');
  });

  it('con una sola moneda no hay selector', () => {
    const m = metrics({
      byVertical: [{ vertical: 'cars', currency: 'PEN', totalAmountMinor: 120_00, count: 2 }],
      monthlyTrend: [{ month: '2026-10', currency: 'PEN', amountMinor: 120_00, count: 2 }],
      topPerformers: [
        { userId: 'u3', name: 'ana@agencia.test', currency: 'PEN', salesMinor: 120_00, count: 2 },
      ],
    });
    const html = render(m);
    const text = textOf(html);
    expect(text).not.toContain('Moneda del reporte');
    expect(text).toContain('Ventas confirmadas · PEN');
    expect(text).toContain('Autos');
    expect(text).toContain('ana@agencia.test');
  });
});

describe('Reportes que no se pudieron leer', () => {
  it('lo dice como alerta, sin ceros ni estado vacío', () => {
    const html = render(null, 'No pudimos cargar tus reportes. Reintenta en unos segundos.');
    const text = textOf(html);
    expect(html).toContain('role="alert"');
    expect(text).toContain('No pudimos cargar tus reportes. Reintenta en unos segundos.');
    expect(text).not.toContain(NO_SALES_TEXT);
    expect(text).toContain(COMMISSIONS_NOTICE);
    expectInTu(text);
  });
});

describe('la página', () => {
  async function page(res: unknown): Promise<string> {
    mocks.api.mockReset();
    mocks.api.mockResolvedValue(res);
    const html = renderToStaticMarkup(await ReportesPage());
    expect(mocks.api).toHaveBeenCalledWith('/reports/sales-metrics');
    expect(mocks.api).toHaveBeenCalledTimes(1);
    return textOf(html);
  }

  it('con datos, el reporte', async () => {
    expect(await page({ ok: true, data: salesPayload() })).toContain('Ventas confirmadas · COP');
  });

  it('la forma vieja del API no se dibuja como si fueran datos', async () => {
    const text = await page({
      ok: true,
      data: { byVertical: [{ vertical: 'Vuelos', totalAmountMinor: 125000000, count: 42 }] },
    });
    expect(text).toContain('No pudimos cargar tus reportes. Reintenta en unos segundos.');
    expect(text).not.toContain('42');
  });

  it.each([
    [401, 'Tu sesión venció. Vuelve a iniciar sesión.'],
    [403, 'Tu rol en esta agencia no puede ver los reportes.'],
    [503, 'No pudimos cargar tus reportes. Reintenta en unos segundos.'],
  ])('API con %i → "%s"', async (status, message) => {
    expect(await page({ ok: false, error: { status, message: 'x' } })).toContain(message);
  });
});
