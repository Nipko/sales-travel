import { describe, expect, it } from 'vitest';
import type { TenantProviders } from './provider-enablement';
import {
  attentionLines,
  createdLabel,
  descendantsLabel,
  heldIn,
  isQuietNode,
  nodeActivityFilters,
  nodeActivityHref,
  nodeOrdersHref,
  nodeTabHref,
  parseNodeSummary,
  providersCount,
  salesCountsLabel,
  salesTiles,
  withNetworkLabel,
  type NodeSummary,
} from './platform-node-summary';
import {
  NODE_HIJA,
  NODE_NORTE,
  NODE_PLANETOUR,
  busySummaryPayload,
  quietSummaryPayload,
} from './platform-node-summary.fixture';

const NOW = new Date('2026-10-13T15:00:00.000Z');

function parsed(payload: Record<string, unknown>): NodeSummary {
  const summary = parseNodeSummary(payload);
  if (summary === undefined) throw new Error('el fixture no se pudo leer');
  return summary;
}

describe('las pestañas del nodo y a dónde lleva cada número', () => {
  it('Resumen es /resumen; Proveedores sigue en la raíz del nodo para no romper enlaces', () => {
    const id = NODE_NORTE.toUpperCase();
    expect(nodeTabHref(id, 'summary')).toBe(`/admin/tenants/${NODE_NORTE}/resumen`);
    expect(nodeTabHref(id, 'providers')).toBe(`/admin/tenants/${NODE_NORTE}`);
    expect(nodeTabHref(id, 'wallets')).toBe(`/admin/tenants/${NODE_NORTE}/carteras`);
    expect(nodeTabHref(id, 'seats')).toBe(`/admin/tenants/${NODE_NORTE}/puestos`);
  });

  it('Reservas de la red acotada al nodo con su red: las vigentes o las que requieren atención', () => {
    expect(nodeOrdersHref(NODE_NORTE, 'attention')).toBe(
      `/admin/plataforma/reservas?atencion=1&nodo=${NODE_NORTE}`,
    );
    expect(nodeOrdersHref(NODE_NORTE, 'open')).toBe(
      `/admin/plataforma/reservas?estado=pendiente%2Cconfirmada%2Cemitida&nodo=${NODE_NORTE}`,
    );
  });

  it('la actividad del nodo y su red en los últimos 30 días, en hora de Bogotá', () => {
    expect(nodeActivityFilters(NODE_NORTE.toUpperCase(), NOW)).toMatchObject({
      tenantId: NODE_NORTE,
      from: '2026-09-14',
      to: '2026-10-13',
      category: null,
    });
    expect(nodeActivityHref(NODE_NORTE, NOW)).toBe(
      `/admin/plataforma/actividad?desde=2026-09-14&hasta=2026-10-13&nodo=${NODE_NORTE}`,
    );
  });
});

describe('parseNodeSummary: GET /admin/tenants/:id/summary', () => {
  it('lee el nodo con su padre, lo suyo, su red, las ventas por moneda y lo que espera', () => {
    const summary = parsed(busySummaryPayload());
    expect(summary.tenant).toEqual({
      id: NODE_NORTE,
      name: 'Consolidador Norte',
      slug: 'norte',
      tenantType: 'consolidator',
      isBranch: false,
      status: 'active',
      parent: { id: NODE_PLANETOUR, name: 'Planetour' },
      countryCode: 'CO',
      defaultCurrency: 'COP',
      createdAt: '2026-01-05T17:00:00.000Z',
    });
    expect(summary.own).toMatchObject({ tenantId: NODE_NORTE, seatLimit: 5, openOrders: 2 });
    expect(summary.subtree).toMatchObject({ descendants: 2, activeUsers: 9, openOrders: 7 });
    expect(summary.sales?.own).toHaveLength(1);
    expect(summary.sales?.subtree.map((s) => s.currency)).toEqual(['COP', 'USD']);
    expect(summary.attention).toMatchObject({
      total: 3,
      byReason: { 'cancel-failed': 1, review: 2, 'hold-orphan': 0 },
    });
  });

  it('una sección que el API no pudo leer (null) o que no se entiende queda sin leer; el resto sí', () => {
    const summary = parsed(
      busySummaryPayload({
        own: null,
        sales: { days: 30, own: [{ currency: 'pesos' }], subtree: [] },
        attention: { total: -1, byReason: {} },
      }),
    );
    expect(summary.own).toBeNull();
    expect(summary.sales).toBeNull();
    expect(summary.attention).toBeNull();
    expect(summary.subtree).not.toBeNull();
    expect(summary.tenant.name).toBe('Consolidador Norte');
  });

  it('la fila de otro nodo no se toma como la suya; un monto no entero tampoco se lee', () => {
    const own = busySummaryPayload().own as Record<string, unknown>;
    expect(parsed(busySummaryPayload({ own: { ...own, tenantId: NODE_HIJA } })).own).toBeNull();
    const sales = busySummaryPayload().sales as Record<string, unknown>;
    const bad = { ...sales, own: [{ ...(sales.own as object[])[0], confirmedAmountMinor: 1.5 }] };
    expect(parsed(busySummaryPayload({ sales: bad })).sales).toBeNull();
  });

  it('la raíz no tiene padre; sin el nodo no hay ficha', () => {
    const tenant = busySummaryPayload().tenant as Record<string, unknown>;
    expect(
      parsed(busySummaryPayload({ tenant: { ...tenant, tenantType: 'platform', parent: null } }))
        .tenant.parent,
    ).toBeNull();
    expect(
      parseNodeSummary(busySummaryPayload({ tenant: { ...tenant, id: 'x' } })),
    ).toBeUndefined();
    expect(parseNodeSummary({ own: null })).toBeUndefined();
    expect(parseNodeSummary(null)).toBeUndefined();
  });
});

describe('las ventas: una tarjeta por moneda, nunca sumadas', () => {
  it('une lo del nodo y lo de su red por moneda; la del nodo primero', () => {
    const summary = parsed(busySummaryPayload());
    const tiles = salesTiles(summary.sales!, 'COP');
    expect(
      tiles.map((t) => [t.currency, t.own?.confirmedCount ?? null, t.subtree?.confirmedCount]),
    ).toEqual([
      ['COP', 4, 7],
      // El nodo no vendió en USD; su red sí.
      ['USD', null, 1],
    ]);
    expect(salesTiles(summary.sales!, 'USD').map((t) => t.currency)).toEqual(['USD', 'COP']);
  });

  it('cuenta confirmadas, canceladas, fallidas y en curso', () => {
    const summary = parsed(busySummaryPayload());
    expect(salesCountsLabel(summary.sales!.own[0]!)).toBe(
      '4 confirmadas · 1 cancelada · 1 en curso',
    );
    expect(salesCountsLabel(summary.sales!.subtree[0]!)).toBe(
      '7 confirmadas · 2 canceladas · 1 fallida',
    );
    expect(salesCountsLabel(null)).toBe('Sin reservas');
  });
});

describe('lo que se dice de cada número', () => {
  it('los motivos de atención con reservas, de lo más grave a lo menos', () => {
    const summary = parsed(busySummaryPayload());
    expect(attentionLines(summary.attention!)).toEqual([
      { reason: 'cancel-failed', label: 'Cancelación fallida', count: 1, critical: true },
      { reason: 'review', label: 'En revisión con el proveedor', count: 2, critical: false },
    ]);
  });

  it('"con su red" y "cuelgan" sólo si cuelgan nodos de él', () => {
    const busy = parsed(busySummaryPayload());
    const quiet = parsed(quietSummaryPayload());
    expect(withNetworkLabel(busy.subtree, 1500)).toBe('Con su red: 1.500');
    expect(withNetworkLabel(quiet.subtree, 0)).toBeUndefined();
    expect(withNetworkLabel(null, 3)).toBeUndefined();
    expect(descendantsLabel(busy.subtree)).toBe('Cuelgan 2 nodos de él');
    expect(descendantsLabel({ ...busy.subtree!, descendants: 1 })).toBe('Cuelga 1 nodo de él');
    expect(descendantsLabel(quiet.subtree)).toBeNull();
  });

  it('lo retenido de una moneda, o nada', () => {
    const busy = parsed(busySummaryPayload());
    expect(heldIn(busy.own!.held, 'COP')).toMatchObject({ amountMinor: 80_000_00 });
    expect(heldIn(busy.own!.held, 'USD')).toBeNull();
  });

  it('la fecha de alta en hora de Bogotá; sin fecha, nada', () => {
    expect(createdLabel('2026-01-05T17:00:00.000Z')).toBe('Alta: 5 ene 2026');
    expect(createdLabel('')).toBeNull();
    expect(createdLabel('ayer')).toBeNull();
  });
});

describe('isQuietNode: el nodo que todavía no tiene ventas ni actividad', () => {
  it('sin reservas nunca, sin ventas en su red y sin actividad', () => {
    const quiet = parsed(quietSummaryPayload());
    expect(isQuietNode(quiet, 0)).toBe(true);
    expect(isQuietNode(quiet, 2)).toBe(false);
  });

  it('si falta una lectura no se afirma', () => {
    const quiet = parsed(quietSummaryPayload());
    expect(isQuietNode(quiet, null)).toBe(false);
    expect(isQuietNode({ ...quiet, sales: null }, 0)).toBe(false);
    expect(isQuietNode({ ...quiet, own: null }, 0)).toBe(false);
    expect(isQuietNode({ ...quiet, attention: null }, 0)).toBe(false);
  });

  it('con una reserva de su red que espera a una persona, ya no (aunque sea vieja y sin ventas)', () => {
    const quiet = parsed(quietSummaryPayload());
    const byReason = { ...quiet.attention!.byReason, 'hold-orphan': 1 };
    expect(isQuietNode({ ...quiet, attention: { total: 1, byReason } }, 0)).toBe(false);
  });

  it('con ventas de su red, o una reserva alguna vez, ya no', () => {
    const busy = parsed(busySummaryPayload());
    expect(isQuietNode(busy, 0)).toBe(false);
    const quiet = parsed(quietSummaryPayload());
    expect(
      isQuietNode({ ...quiet, own: { ...quiet.own!, lastOrderAt: '2026-01-01T00:00:00Z' } }, 0),
    ).toBe(false);
  });
});

describe('providersCount: cuántos proveedores puede usar el nodo', () => {
  it('cuenta los habilitados y nombra los apagados de emergencia', () => {
    const provider = (code: string, enabled: boolean, killSwitch: 'all' | 'sales' | null) => ({
      code,
      vertical: 'flights' as const,
      callPolicy: 'always' as const,
      defaultEnabled: true,
      killSwitch,
      legacyEnv: { allTenants: false, tenantIds: [] },
      own: null,
      effective: { enabled, origin: 'default' as const },
    });
    const view: TenantProviders = {
      tenantId: NODE_NORTE,
      tenantName: 'Consolidador Norte',
      tenantSlug: 'norte',
      providers: [
        provider('latam-ndc', true, null),
        provider('tbo-hotels', false, 'all'),
        provider('agent-cars', true, 'sales'),
      ],
    };
    expect(providersCount(view)).toEqual({
      enabled: 2,
      total: 3,
      killSwitched: [
        { name: 'TBO Holidays', salesOnly: false },
        { name: expect.any(String), salesOnly: true },
      ],
    });
  });
});
