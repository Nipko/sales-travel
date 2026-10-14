import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActivityEventView } from '../../../../../../../lib/platform-audit';
import {
  NODE_SUMMARY_EMPTY,
  parseNodeSummary,
  type NodeSummary as Summary,
} from '../../../../../../../lib/platform-node-summary';
import {
  NODE_HIJA,
  NODE_NORTE,
  NODE_PLANETOUR,
  busySummaryPayload,
  quietSummaryPayload,
} from '../../../../../../../lib/platform-node-summary.fixture';
import type { TenantProviders } from '../../../../../../../lib/provider-enablement';
import { voseoIn } from '../../../../../../../lib/voseo';
import type { FinancedWallets } from '../../../../../../../lib/wallets';
import {
  NodeSummary,
  NodeSummaryContent,
  NodeSummaryHeading,
  type NodeSummaryState,
} from './node-summary';

const NOW = Date.parse('2026-10-13T15:00:00.000Z');

function summary(payload: Record<string, unknown>): Summary {
  const parsed = parseNodeSummary(payload);
  if (parsed === undefined) throw new Error('el fixture no se pudo leer');
  return parsed;
}

function wallets(
  tenantId: string,
  portfolios: FinancedWallets['portfolios'] = [],
): FinancedWallets {
  return {
    tenant: {
      id: tenantId,
      name: 'Nodo',
      tenantType: 'consolidator',
      isBranch: false,
      status: 'active',
      defaultCurrency: 'COP',
    },
    portfolios,
    pendingDepositReports: 0,
    availableCurrencies: ['USD'],
  };
}

const WALLET_COP = {
  id: '30000000-0000-4000-8000-000000000001',
  tenantId: NODE_NORTE,
  currency: 'COP',
  exponent: 2,
  creditLimitMinor: 5_000_000_00,
  balanceMinor: -1_200_000_00,
  availableMinor: 3_800_000_00,
  status: 'active',
  updatedAt: '2026-10-12T15:00:00.000Z',
};

const WALLET_USD = {
  ...WALLET_COP,
  id: '30000000-0000-4000-8000-000000000002',
  currency: 'USD',
  creditLimitMinor: 0,
  balanceMinor: 100_00,
  availableMinor: 100_00,
  status: 'suspended',
};

function providers(tenantId: string): TenantProviders {
  const provider = (code: string, enabled: boolean, killSwitch: 'all' | 'sales' | null) => ({
    code,
    vertical: 'hotels' as const,
    callPolicy: 'always' as const,
    defaultEnabled: true,
    killSwitch,
    legacyEnv: { allTenants: false, tenantIds: [] },
    own: null,
    effective: { enabled, origin: 'default' as const },
  });
  return {
    tenantId,
    tenantName: 'Nodo',
    tenantSlug: 'nodo',
    providers: [provider('latam-ndc', true, null), provider('tbo-hotels', false, 'all')],
  };
}

function event(id: string, extra: Partial<ActivityEventView> = {}): ActivityEventView {
  return {
    id,
    occurredAt: '2026-10-13T14:00:00.000Z',
    eventType: 'auth.login.success',
    tenantId: NODE_NORTE,
    tenantName: 'Consolidador Norte',
    actorEmail: 'ana@norte.test',
    targetEmail: null,
    aggregateType: null,
    aggregateId: null,
    payload: {},
    meta: { ip: null, userAgent: null, requestId: null },
    ...extra,
  };
}

function busyState(extra: Partial<NodeSummaryState> = {}): NodeSummaryState {
  return {
    summary: { status: 'ready', data: summary(busySummaryPayload()) },
    wallets: { status: 'ready', data: wallets(NODE_NORTE, [WALLET_COP, WALLET_USD]) },
    providers: { status: 'ready', data: providers(NODE_NORTE) },
    activity: {
      status: 'ready',
      data: [
        event('e1'),
        event('e2', {
          eventType: 'nada.que.conocemos',
          tenantId: NODE_HIJA,
          tenantName: 'Agencia Nueva',
          actorEmail: null,
        }),
      ],
    },
    ...extra,
  };
}

function quietState(): NodeSummaryState {
  return {
    summary: { status: 'ready', data: summary(quietSummaryPayload()) },
    wallets: { status: 'ready', data: wallets(NODE_HIJA) },
    providers: { status: 'ready', data: providers(NODE_HIJA) },
    activity: { status: 'ready', data: [] },
  };
}

function render(tenantId: string, state: NodeSummaryState): string {
  return renderToStaticMarkup(
    createElement(NodeSummaryContent, { tenantId, state, now: NOW, onRetry: () => undefined }),
  );
}

/** El texto visible (y el de lectores de pantalla), sin etiquetas. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('NodeSummary en su primer pintado', () => {
  const html = renderToStaticMarkup(createElement(NodeSummary, { tenantId: NODE_NORTE }));

  it('vuelve a Agencias, anuncia que carga y marca Resumen como la pestaña actual', () => {
    expect(html).toContain('href="/admin/tenants"');
    expect(html).toContain('<h1');
    expect(textOf(html)).toContain('Cargando el resumen del nodo…');
    expect(textOf(html)).toContain('Cargando las carteras…');
    expect(textOf(html)).toContain('Cargando la actividad…');
    const current = /<a[^>]*aria-current="page"[^>]*>.*?<\/a>/.exec(html)?.[0] ?? '';
    expect(current).toContain(`href="/admin/tenants/${NODE_NORTE}/resumen"`);
    expect(current).toContain('Resumen');
  });

  it('va en tú', () => {
    expect(voseoIn(textOf(html))).toEqual([]);
  });
});

describe('NodeSummaryHeading', () => {
  it('nombre, tipo, estado, de quién cuelga (con enlace a su resumen), su red y el alta', () => {
    const html = renderToStaticMarkup(
      createElement(NodeSummaryHeading, { summary: summary(busySummaryPayload()) }),
    );
    const text = textOf(html);
    expect(text).toContain('Consolidador Norte');
    expect(text).toContain('Consolidador');
    expect(text).toContain('Activo');
    expect(text).toContain('Cuelga de Planetour');
    expect(html).toContain(`href="/admin/tenants/${NODE_PLANETOUR}/resumen"`);
    expect(text).toContain('Cuelgan 2 nodos de él');
    expect(text).toContain('CO COP');
    expect(text).toContain('Alta: 5 ene 2026');
  });

  it('un nodo suspendido lo dice escrito; la raíz no cuelga de nadie', () => {
    const tenant = busySummaryPayload().tenant as Record<string, unknown>;
    const html = renderToStaticMarkup(
      createElement(NodeSummaryHeading, {
        summary: summary(
          busySummaryPayload({
            tenant: { ...tenant, status: 'suspended', tenantType: 'platform', parent: null },
          }),
        ),
      }),
    );
    expect(textOf(html)).toContain('Suspendido');
    expect(textOf(html)).toContain('Raíz de la red');
  });
});

describe('NodeSummaryContent con un nodo con movimiento', () => {
  const html = render(NODE_NORTE, busyState());
  const text = textOf(html);

  it('ventas de 30 días por moneda: lo suyo y con su red, nunca sumadas', () => {
    expect(text).toContain('Ventas · últimos 30 días');
    expect(text).toContain('Ventas 30 días · COP');
    expect(text).toContain('Ventas 30 días · USD');
    expect(text).toMatch(/\$\s?1\.500\.000/);
    expect(text).toContain('4 confirmadas · 1 cancelada · 1 en curso');
    expect(text).toContain('Con su red');
    expect(text).toMatch(/\$\s?2\.600\.000/);
    expect(text).toContain('7 confirmadas · 2 canceladas · 1 fallida');
    expect(text).toContain('Vuelos');
    expect(text).toContain('Hoteles');
    // El nodo no vendió en USD: su tarjeta dice 0 y lo de su red aparte.
    expect(text).toMatch(/US\$\s?0/);
    expect(text).toMatch(/US\$\s?450/);
  });

  it('lo que requiere atención, con los motivos y el enlace a Reservas de la red', () => {
    expect(text).toContain('Requieren atención');
    expect(text).toContain('Cancelación fallida: 1');
    expect(text).toContain('En revisión con el proveedor: 2');
    expect(html).toContain(`href="/admin/plataforma/reservas?atencion=1&amp;nodo=${NODE_NORTE}"`);
    expect(html).toContain('data-tone="warning"');
  });

  it('reservas vigentes, depósitos, puestos, personas y sesiones, con su red y su pestaña', () => {
    expect(text).toContain('Reservas vigentes');
    expect(text).toContain('Con su red: 7');
    expect(html).toContain(
      `href="/admin/plataforma/reservas?estado=pendiente%2Cconfirmada%2Cemitida&amp;nodo=${NODE_NORTE}"`,
    );
    expect(text).toContain('Depósitos por aprobar');
    expect(text).toContain('Con su red: 3');
    expect(html).toContain(`href="/admin/plataforma/carteras?nodo=${NODE_NORTE}`);
    expect(text).toContain('5 de 5 puestos en uso, al límite');
    expect(html).toContain(`href="/admin/tenants/${NODE_NORTE}/puestos"`);
    expect(text).toContain('Personas activas');
    expect(text).toContain('Con su red: 9');
    expect(text).toContain('2 invitaciones sin aceptar');
    expect(html).toContain(`href="/admin/usuarios?tenant=${NODE_NORTE}"`);
    expect(text).toContain('Conectadas ahora');
    expect(text).toContain('Con su red: 5');
  });

  it('carteras por moneda con disponible, saldo, cupo, estado y lo retenido', () => {
    expect(text).toContain('Carteras');
    expect(html).toContain(`href="/admin/tenants/${NODE_NORTE}/carteras"`);
    expect(text).toContain('Disponible para reservar');
    expect(text).toMatch(/\$\s?3\.800\.000/);
    expect(text).toContain('Suspendida');
    expect(text).toContain('Retenido por reservas en curso');
    expect(text).toMatch(/\$\s?80\.000/);
  });

  it('proveedores: cuántos puede usar y cuáles están apagados de emergencia', () => {
    expect(text).toContain('1 de 2 proveedores habilitados para este nodo.');
    expect(text).toContain('Apagado de emergencia');
    expect(text).toContain('TBO Holidays, en toda la plataforma');
    expect(html).toContain(`href="/admin/tenants/${NODE_NORTE}"`);
  });

  it('actividad reciente: qué pasó, quién, dónde (si fue en su red) y el enlace a toda', () => {
    expect(text).toContain('Actividad reciente');
    expect(text).toContain('Ingresó');
    expect(text).toContain('ana@norte.test');
    expect(text).toContain('nada.que.conocemos');
    expect(text).toContain('en Agencia Nueva');
    expect(html).toContain(
      `href="/admin/plataforma/actividad?desde=2026-09-14&amp;hasta=2026-10-13&amp;nodo=${NODE_NORTE}"`,
    );
    expect(text).not.toContain(NODE_SUMMARY_EMPTY);
  });

  it('va en tú', () => {
    expect(voseoIn(text)).toEqual([]);
  });
});

describe('NodeSummaryContent con un nodo recién creado', () => {
  const html = render(NODE_HIJA, quietState());
  const text = textOf(html);

  it('dice que todavía no tiene ventas ni actividad, sin tarjetas de ventas ni lista vacía', () => {
    expect(text).toContain(NODE_SUMMARY_EMPTY);
    expect(text).not.toContain('Ventas · últimos 30 días');
    expect(text).not.toContain('Actividad reciente');
  });

  it('igual muestra cómo está armado: puestos compartidos, personas, carteras y proveedores', () => {
    expect(text).toContain('Comparte el cupo de su red');
    expect(text).toContain('Personas activas');
    expect(text).not.toContain('Con su red');
    expect(text).toContain('Ninguna reserva de su red espera a una persona.');
    expect(text).toContain('Este nodo no tiene carteras habilitadas.');
    expect(text).toContain('proveedores habilitados');
    // Sin nada por revisar, no hay enlaces a revisar.
    expect(html).not.toContain('atencion=1');
    expect(html).not.toContain('/admin/plataforma/carteras');
  });

  it('con una reserva en su historia ya no es un nodo vacío', () => {
    const quiet = summary(quietSummaryPayload());
    const html2 = render(NODE_HIJA, {
      ...quietState(),
      summary: {
        status: 'ready',
        data: { ...quiet, own: { ...quiet.own!, lastOrderAt: '2026-09-01T00:00:00.000Z' } },
      },
    });
    expect(textOf(html2)).not.toContain(NODE_SUMMARY_EMPTY);
    expect(textOf(html2)).toContain('Sin reservas en los últimos 30 días.');
    expect(textOf(html2)).toContain('Sin actividad en los últimos 30 días.');
  });

  it('con una reserva de su red que espera a una persona no dice que está vacío', () => {
    const quiet = summary(quietSummaryPayload());
    const byReason = { ...quiet.attention!.byReason, 'hold-orphan': 1 };
    const html2 = render(NODE_HIJA, {
      ...quietState(),
      summary: { status: 'ready', data: { ...quiet, attention: { total: 1, byReason } } },
    });
    expect(textOf(html2)).not.toContain(NODE_SUMMARY_EMPTY);
    expect(html2).toContain('atencion=1');
  });

  it('va en tú', () => {
    expect(voseoIn(text)).toEqual([]);
  });
});

describe('NodeSummaryContent: una sección que falla no rompe la pestaña', () => {
  it('sin carteras, proveedores ni actividad: cada una lo dice y deja reintentar; el resto se ve', () => {
    const html = render(
      NODE_NORTE,
      busyState({
        wallets: {
          status: 'error',
          message: 'Sólo quien financia a este nodo gestiona sus carteras.',
        },
        providers: { status: 'error', message: 'No se pudo cargar.' },
        activity: { status: 'error', message: 'No pudimos conectar con el servidor.' },
      }),
    );
    const text = textOf(html);
    expect(text).toContain('No pudimos leer las carteras.');
    expect(text).toContain('Sólo quien financia a este nodo gestiona sus carteras.');
    expect(text).toContain('No pudimos leer los proveedores.');
    expect(text).toContain('No pudimos leer la actividad.');
    expect(html.match(/role="alert"/g)).toHaveLength(3);
    expect(text.match(/Reintentar/g)).toHaveLength(3);
    // Lo demás, intacto.
    expect(text).toContain('Ventas 30 días · COP');
    expect(text).toContain('Reservas vigentes');
    // Sin la actividad no se afirma que el nodo esté vacío.
    expect(text).not.toContain(NODE_SUMMARY_EMPTY);
  });

  it('secciones del resumen que el API no pudo leer: cada una por su lado', () => {
    const html = render(
      NODE_NORTE,
      busyState({
        summary: {
          status: 'ready',
          data: summary(busySummaryPayload({ sales: null, attention: null, own: null })),
        },
      }),
    );
    const text = textOf(html);
    expect(text).toContain('No pudimos leer las ventas del nodo.');
    expect(text.match(/No pudimos leerlo\./g)).toHaveLength(6);
    expect(text).toContain('Carteras');
    expect(text).toContain('Actividad reciente');
  });

  it('sin el resumen: lo dice una vez y carteras, proveedores y actividad siguen', () => {
    const html = render(
      NODE_NORTE,
      busyState({ summary: { status: 'error', message: 'No pudimos conectar con el servidor.' } }),
    );
    const text = textOf(html);
    expect(text).toContain('No pudimos leer el resumen del nodo.');
    expect(text).not.toContain('Reservas vigentes');
    expect(text).toContain('Disponible para reservar');
    expect(text).toContain('1 de 2 proveedores habilitados');
    expect(text).toContain('Ingresó');
    // Sin el resumen, lo retenido no se puede decir: no se inventa.
    expect(text).not.toContain('Retenido por reservas en curso');
  });
});
