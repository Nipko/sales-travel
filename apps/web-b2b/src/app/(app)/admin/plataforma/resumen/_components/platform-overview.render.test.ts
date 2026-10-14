import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  parsePlatformOverview,
  type PlatformOverview,
} from '../../../../../../lib/platform-overview';
import {
  NODE_ANDES,
  NODE_SUR,
  overviewPayload,
  quietAttention,
  quietOrders,
  quietProviders,
} from '../../../../../../lib/platform-overview.fixture';
import { OverviewContent, PlatformOverview as PlatformOverviewScreen } from './platform-overview';
import { TrendStrip } from './trend-strip';

/** Formas del voseo que podrían colarse en esta pantalla (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|verificá|aprobá|rechazá|usá|buscá|cerrá|mirá|reintentá|vos)(?!\p{L})/giu;

const NOW = Date.parse('2026-10-11T15:00:00.000Z');

function overview(overrides: Record<string, unknown> = {}): PlatformOverview {
  const parsed = parsePlatformOverview(overviewPayload(overrides));
  if (parsed === undefined) throw new Error('el fixture no se pudo leer');
  return parsed;
}

function render(o: PlatformOverview, oldest: string | null | undefined = null): string {
  return renderToStaticMarkup(
    createElement(OverviewContent, { overview: o, oldestDeposit: oldest, now: NOW }),
  );
}

/** El texto visible (y el de lectores de pantalla), sin etiquetas. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function checkedValues(html: string): (string | undefined)[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('checked=""'))
    .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);
}

describe('PlatformOverview en su primer pintado', () => {
  const html = renderToStaticMarkup(
    createElement(PlatformOverviewScreen, { initialPeriod: '30d', tenantId: null }),
  );

  it('título, subtítulo, período con nombre y el resumen anunciando que carga', () => {
    expect(html).toContain('<h1');
    expect(html).toContain('Resumen de la plataforma');
    expect(html).toContain('Cómo va la red y qué necesita tu atención.');
    expect(html).toContain('Período del resumen');
    for (const label of ['Hoy', '7 días', '30 días', 'Este mes']) expect(html).toContain(label);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Cargando el resumen…');
    expect(html).toContain('Actualizar');
  });

  it('arranca en 30 días, o en el período de la URL', () => {
    expect(checkedValues(html)).toEqual(['30d']);
    const month = renderToStaticMarkup(
      createElement(PlatformOverviewScreen, { initialPeriod: 'month', tenantId: null }),
    );
    expect(checkedValues(month)).toEqual(['month']);
  });

  it('va en tú', () => {
    expect([...textOf(html).matchAll(VOSEO)]).toEqual([]);
  });
});

describe('OverviewContent: todo en orden', () => {
  const html = render(overview());
  const text = textOf(html);

  it('sin temas, lo dice con un ícono y como estado', () => {
    expect(html).toContain('role="status"');
    expect(text).toContain('Todo en orden. No hay nada que requiera tu atención.');
    expect(html).not.toContain('Urgente');
  });

  it('una tarjeta por moneda, sin sumarlas nunca', () => {
    const tiles = [...html.matchAll(/aria-label="Ventas confirmadas en ([A-Z]{3})"/g)].map(
      (m) => m[1],
    );
    expect(tiles).toEqual(['COP', 'USD']);
    expect(text).toContain('Ventas confirmadas · COP');
    expect(text).toContain('$ 18.500.000');
    expect(text).toContain('12 confirmadas · 2 canceladas · 1 fallida');
    expect(text).toContain('Ventas confirmadas · USD');
    expect(text).toContain('US$ 2.450');
    expect(text).toContain('3 confirmadas · 0 canceladas · 1 en curso');
    expect(text).toContain('Ticket promedio $ 1.541.667');
    expect(text).toContain('Ticket promedio US$ 817');
    expect(text).toContain(
      'Cada moneda va por separado: nunca sumamos montos de monedas distintas.',
    );
    expect(text).not.toMatch(/total/i);
  });

  it('verticales, tendencia y cotizaciones', () => {
    expect(text).toContain('Vuelos');
    expect(text).toContain('Hoteles');
    expect(text).toContain('Últimos 12 meses');
    expect(text).toContain('Cotizaciones del período: 40 creadas · 9 aceptadas.');
  });

  it('por proveedor y los nodos que más venden, cada uno con enlace a su ficha', () => {
    expect(text).toContain('Por proveedor');
    expect(text).toContain('LATAM NDC');
    expect(text).toContain('TBO Holidays');
    expect(text).toContain('Nodos con más ventas');
    expect(html).toContain(`href="/admin/tenants/${NODE_SUR}/resumen"`);
    expect(html).toContain(`href="/admin/tenants/${NODE_ANDES}/resumen"`);
    expect(text).toContain('Sucursal');
    expect(text).toContain('Suspendido');
  });

  it('la red y las carteras', () => {
    expect(text).toContain('Nodos activos');
    expect(text).toContain('de 24 · 2 suspendidos');
    expect(text).toContain('Altas en el período');
    expect(text).toContain('61 ingresaron en el período');
    expect(text).toContain('Conectados ahora');
    expect(text).toContain(
      'En la red: 2 consolidadores · 14 agencias · 3 sucursales · 5 sub-agencias.',
    );
    expect(text).toContain('Carteras de la red');
    expect(text).toContain('Deuda de la red');
    expect(text).toContain('Lo que financia Planetour: cupo $ 60.000.000 · deuda $ 19.000.000');
  });

  it('va en tú', () => {
    expect([...text.matchAll(VOSEO)]).toEqual([]);
  });
});

describe('OverviewContent: lo que requiere atención', () => {
  const o = overview({
    attention: {
      ...quietAttention(),
      depositReports: { total: 3, platform: 2, network: 1 },
      orders: {
        ...quietOrders(),
        total: 2,
        byReason: {
          ...(quietOrders()['byReason'] as Record<string, number>),
          'hold-conflict': 1,
          'cancel-failed': 1,
        },
        sample: [
          {
            orderId: '40000000-0000-4000-8000-000000000001',
            tenantId: NODE_SUR,
            tenantName: 'Agencia Sur',
            orderNumber: 1042,
            provider: 'latam-ndc',
            providerOrderId: 'XKJ7PQ',
            orderStatus: 'confirmed',
            reason: 'hold-conflict',
            since: '2026-10-10T15:00:00.000Z',
          },
        ],
      },
      postSale: { failed: 1, stuck: 0, byType: [{ type: 'pay', failed: 1, stuck: 0 }] },
      reconciliation: { critical: 1, warning: 0, sinceDays: 30 },
      invitations: { pending: 3, expired: 0, expiredSinceDays: 30 },
      seats: {
        saturated: [{ tenantId: NODE_ANDES, tenantName: 'Andes Travel', used: 4, limit: 4 }],
      },
      jobs: { postSaleSweepStale: true, lastOkAt: '2026-10-11T13:00:00.000Z' },
    },
    providers: {
      ...quietProviders(),
      openCircuits: [{ code: 'sabre', state: 'open', failures: 5 }],
      killSwitched: [{ code: 'tbo-hotels', level: 'sales' }],
    },
    catalogs: [
      {
        providerCode: 'tbo-hotels',
        cities: 10,
        syncedLast48h: 0,
        failedCities: 0,
        lastSyncedAt: '2026-10-08T15:00:00.000Z',
        stale: true,
      },
    ],
  });
  const html = render(o, '2026-10-10T09:00:00.000Z');
  const text = textOf(html);

  it('cada tarjeta con su frase', () => {
    expect(text).toContain('Requiere tu atención');
    expect(text).toContain('9 temas');
    expect(text).toContain('Proveedores');
    expect(text).toContain('Sabre GDS: no está respondiendo');
    expect(text).toContain('TBO Holidays: apagado de emergencia (solo ventas)');
    expect(text).toContain('Reservas con problemas');
    expect(text).toContain('2 reservas necesitan que alguien las revise.');
    expect(text).toContain('Retención de cartera en conflicto: 1');
    expect(text).toContain('Cancelación fallida: 1');
    expect(text).toContain('Agencia Sur · n.º 1042 · XKJ7PQ');
    expect(text).toContain('Retención de cartera en conflicto · desde ayer');
    expect(text).toContain('Post-venta con problemas');
    expect(text).toContain('1 operación falló.');
    expect(text).toContain('Pagos y emisiones: 1 fallida');
    expect(text).toContain('2 depósitos esperan tu aprobación · el más antiguo ayer.');
    expect(text).toContain('1 diferencia crítica en los últimos 30 días.');
    expect(text).toContain('Andes Travel: 4 de 4 puestos en uso');
    expect(text).toContain('TBO Holidays: última sincronización hace 3 días');
    expect(text).toContain('3 pendientes de aceptar.');
    expect(text).toContain('Procesos');
    expect(text).toContain('El barrido de post-venta no corre hace 2 horas.');
  });

  it('la severidad va escrita, no sólo en el color', () => {
    expect(text).toContain('Urgente');
    expect(text).toContain('Revisar');
    expect(text).toContain('Aviso');
  });

  it('lo más grave primero', () => {
    const titles = [...html.matchAll(/<h3 class="text-sm font-semibold[^"]*">([^<]+)<\/h3>/g)].map(
      (m) => m[1],
    );
    expect(titles.slice(0, 9)).toEqual([
      'Proveedores',
      'Reservas con problemas',
      'Post-venta con problemas',
      'Procesos',
      'Conciliación con los proveedores',
      'Depósitos por aprobar',
      'Puestos',
      'Catálogos de hoteles',
      'Invitaciones',
    ]);
  });

  it('cada tarjeta con destino lleva a su pantalla', () => {
    expect(html).toContain('href="/admin/plataforma/proveedores"');
    expect(html).toContain('href="/admin/plataforma/carteras"');
    expect(html).toContain(`href="/admin/tenants/${NODE_ANDES}/puestos"`);
    expect(html).toContain('href="/admin/usuarios"');
    expect(text).toContain('Ver proveedores');
    expect(text).toContain('Revisar depósitos');
    expect(text).toContain('Ver invitaciones');
    // El barrido detenido y los catálogos atrasados llevan a Sistema › Procesos.
    expect(html.match(/href="\/admin\/plataforma\/sistema"/g)?.length).toBe(2);
    expect(text).toContain('Ver procesos');
  });

  it('Reservas con problemas lleva a Reservas de la red: todas, o la ficha de cada una', () => {
    expect(html).toContain('href="/admin/plataforma/reservas?atencion=1"');
    expect(text).toContain('Ver todas · Reservas con problemas');
    expect(html).toContain(
      'href="/admin/plataforma/reservas?orden=40000000-0000-4000-8000-000000000001"',
    );
  });

  it('va en tú', () => {
    expect([...text.matchAll(VOSEO)]).toEqual([]);
  });
});

describe('OverviewContent sin ventas', () => {
  it('lo dice en vez de mostrar ceros por moneda', () => {
    const base = overviewPayload();
    const html = render(
      overview({
        sales: {
          ...(base['sales'] as Record<string, unknown>),
          byCurrency: [],
          byVertical: [],
          byProvider: [],
        },
        topNodes: [],
      }),
    );
    const text = textOf(html);
    expect(text).toContain('No hubo reservas en este período.');
    expect(text).toContain('Sin reservas en este período.');
    expect(text).toContain('Ningún nodo confirmó reservas en este período.');
    expect(html).not.toContain('aria-label="Ventas confirmadas en');
  });
});

describe('TrendStrip', () => {
  const series = overview().trend.series[0];
  if (series === undefined) throw new Error('sin serie');
  const html = renderToStaticMarkup(createElement(TrendStrip, { series }));
  const text = textOf(html);

  it('arranca leyendo el último mes', () => {
    expect(text).toContain('octubre de 2026: $ 11.000.000 · 11 confirmadas');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="11"');
    expect(html).toContain('aria-label="Ventas confirmadas por mes en COP"');
  });

  it('una tabla para lectores de pantalla con los 12 meses', () => {
    expect(html).toContain('<div class="sr-only"><table>');
    expect([...html.matchAll(/<th scope="row">/g)]).toHaveLength(12);
    expect(text).toContain('noviembre de 2025');
  });
});
