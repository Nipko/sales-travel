import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERVIEW_PERIOD,
  INVITATIONS_HREF,
  OVERVIEW_PERIODS,
  PLATFORM_HOME,
  SEVERITY_LABEL,
  attentionItems,
  monthLabel,
  overviewErrorMessage,
  overviewHref,
  overviewSearch,
  parsePlatformOverview,
  periodCaption,
  periodDates,
  periodFromParam,
  periodParam,
  postSaleTypeLabel,
  providerName,
  salesVerticalLabel,
  shouldLandOnPlatformOverview,
  todayIn,
  updatedLabel,
  wholeUnits,
  type AttentionItem,
  type PlatformOverview,
} from './platform-overview';
import {
  NODE_SUR,
  overviewPayload,
  quietAttention,
  quietProviders,
} from './platform-overview.fixture';

/** Formas del voseo que no pueden colarse en el Resumen (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|verificá|aprobá|rechazá|usá|buscá|cerrá|mirá|vos)(?!\p{L})/giu;

const NOW = Date.parse('2026-10-11T15:00:00.000Z');

function parsed(overrides: Record<string, unknown> = {}): PlatformOverview {
  const overview = parsePlatformOverview(overviewPayload(overrides));
  if (overview === undefined) throw new Error('el fixture no se pudo leer');
  return overview;
}

function itemsWith(
  attention: Record<string, unknown> = {},
  rest: Record<string, unknown> = {},
  oldest: string | null | undefined = undefined,
): AttentionItem[] {
  return attentionItems(
    parsed({ attention: { ...quietAttention(), ...attention }, ...rest }),
    oldest,
    NOW,
  );
}

function only(items: AttentionItem[], id: AttentionItem['id']): AttentionItem {
  const item = items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no hay tarjeta ${id}`);
  return item;
}

describe('período', () => {
  it('cuatro opciones, por omisión 30 días', () => {
    expect(OVERVIEW_PERIODS.map((p) => p.label)).toEqual(['Hoy', '7 días', '30 días', 'Este mes']);
    expect(DEFAULT_OVERVIEW_PERIOD).toBe('30d');
  });

  it('?periodo= ida y vuelta; uno desconocido es el de siempre', () => {
    for (const p of OVERVIEW_PERIODS) expect(periodFromParam(periodParam(p.value))).toBe(p.value);
    expect(periodFromParam('hoy')).toBe('today');
    expect(periodFromParam('mes')).toBe('month');
    expect(periodFromParam('anio')).toBe('30d');
    expect(periodFromParam(undefined)).toBe('30d');
  });

  it('la URL de la pantalla no repite el período por omisión y conserva el nodo', () => {
    expect(overviewHref('30d', null)).toBe(PLATFORM_HOME);
    expect(overviewHref('7d', null)).toBe('/admin/plataforma/resumen?periodo=7d');
    expect(overviewHref('month', NODE_SUR)).toBe(
      `/admin/plataforma/resumen?periodo=mes&nodo=${NODE_SUR}`,
    );
  });

  it('la query del BFF', () => {
    expect(overviewSearch('today', null)).toBe('period=today');
    expect(overviewSearch('30d', NODE_SUR)).toBe(`period=30d&tenantId=${NODE_SUR}`);
  });

  it('los días son de Bogotá: a las 22:00 del 10 en Bogotá ya es 11 en UTC, pero sigue siendo 10', () => {
    const late = new Date('2026-10-11T03:00:00.000Z');
    expect(todayIn('America/Bogota', late)).toBe('2026-10-10');
    expect(periodDates('today', late)).toEqual({ from: '2026-10-10', to: '2026-10-10' });
  });

  it('7 y 30 días cuentan hoy; este mes arranca el día 1', () => {
    const now = new Date(NOW);
    expect(periodDates('7d', now)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(periodDates('30d', now)).toEqual({ from: '2026-09-12', to: '2026-10-11' });
    expect(periodDates('month', now)).toEqual({ from: '2026-10-01', to: '2026-10-11' });
  });

  it('cruzando el año', () => {
    const jan = new Date('2026-01-03T12:00:00.000Z');
    expect(periodDates('7d', jan)).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(periodDates('month', jan)).toEqual({ from: '2026-01-01', to: '2026-01-03' });
  });
});

describe('parsePlatformOverview', () => {
  it('lee la respuesta del API', () => {
    const o = parsed();
    expect(o.period).toEqual({ from: '2026-09-12', to: '2026-10-11' });
    expect(o.scope).toBeNull();
    expect(o.sales.byCurrency.map((c) => c.currency)).toEqual(['COP', 'USD']);
    expect(o.sales.quotations).toEqual({ created: 40, accepted: 9 });
    expect(o.trend.series[0]?.points).toHaveLength(12);
    expect(o.topNodes[0]).toMatchObject({
      tenantId: NODE_SUR,
      name: 'Agencia Sur',
      isBranch: true,
    });
    expect(o.network.liveSessions).toBe(17);
    expect(o.wallets[0]?.debtMinor).toBe(2_400_000_000);
  });

  it('nunca junta monedas: dos filas de la misma moneda siguen siendo dos', () => {
    const base = overviewPayload();
    const sales = base['sales'] as Record<string, unknown>;
    const cop = (sales['byCurrency'] as unknown[])[0];
    const o = parsePlatformOverview({
      ...base,
      sales: { ...sales, byCurrency: [cop, cop] },
    });
    expect(o?.sales.byCurrency).toHaveLength(2);
    expect(o?.sales.byCurrency.every((c) => c.confirmedAmountMinor === 1_850_000_000)).toBe(true);
  });

  it('descarta la fila rota de una lista, no la respuesta', () => {
    const base = overviewPayload();
    const sales = base['sales'] as Record<string, unknown>;
    const o = parsePlatformOverview({
      ...base,
      sales: {
        ...sales,
        byCurrency: [
          ...(sales['byCurrency'] as unknown[]),
          { currency: 'pesos', exponent: 2, confirmedCount: 1 },
        ],
      },
      topNodes: [{ tenantId: 'no-es-uuid', name: 'X', confirmedCount: 1, amounts: [] }],
    });
    expect(o?.sales.byCurrency.map((c) => c.currency)).toEqual(['COP', 'USD']);
    expect(o?.topNodes).toEqual([]);
  });

  it('ignora un nivel de apagado o un estado de circuito que no conoce', () => {
    const o = parsed({
      providers: {
        ...quietProviders(),
        killSwitched: [
          { code: 'sabre', level: 'parcial' },
          { code: 'tbo-hotels', level: 'sales' },
        ],
        openCircuits: [
          { code: 'latam-ndc', state: 'closed', failures: 0 },
          { code: 'sabre', state: 'open', failures: 5 },
        ],
      },
    });
    expect(o.providers.killSwitched).toEqual([{ code: 'tbo-hotels', level: 'sales' }]);
    expect(o.providers.openCircuits).toEqual([{ code: 'sabre', state: 'open' }]);
  });

  it('un contador de atención que no se lee rompe la lectura: no se muestra "Todo en orden" por error', () => {
    expect(
      parsePlatformOverview(
        overviewPayload({ attention: { ...quietAttention(), walletHoldConflicts: '3' } }),
      ),
    ).toBeUndefined();
    expect(parsePlatformOverview(overviewPayload({ attention: undefined }))).toBeUndefined();
    expect(parsePlatformOverview(overviewPayload({ providers: null }))).toBeUndefined();
  });

  it('una respuesta que no es el Resumen no se lee', () => {
    expect(parsePlatformOverview(null)).toBeUndefined();
    expect(parsePlatformOverview([])).toBeUndefined();
    expect(parsePlatformOverview(overviewPayload({ generatedAt: 'ayer' }))).toBeUndefined();
    expect(
      parsePlatformOverview(overviewPayload({ period: { from: '12/09', to: '2026-10-11' } })),
    ).toBeUndefined();
  });

  it('la tendencia trae un punto por mes, aunque el API omita los meses sin venta', () => {
    const o = parsed({
      trend: {
        months: ['2026-09', '2026-10'],
        series: [
          {
            currency: 'USD',
            exponent: 2,
            points: [{ month: '2026-10', count: 2, amountMinor: 5000 }],
          },
        ],
      },
    });
    expect(o.trend.series[0]?.points).toEqual([
      { month: '2026-09', count: 0, amountMinor: 0 },
      { month: '2026-10', count: 2, amountMinor: 5000 },
    ]);
  });

  it('el alcance de un nodo', () => {
    const o = parsed({
      scope: {
        tenantId: NODE_SUR.toUpperCase(),
        name: 'Agencia Sur',
        slug: 'agencia-sur',
        tenantType: 'agency',
        isBranch: true,
      },
    });
    expect(o.scope).toEqual({
      tenantId: NODE_SUR,
      name: 'Agencia Sur',
      tenantType: 'agency',
      isBranch: true,
    });
  });
});

describe('attentionItems', () => {
  it('sin nada pendiente, no hay tarjetas', () => {
    expect(itemsWith()).toEqual([]);
  });

  it('depósitos: los que esperan a Planetour, con el más antiguo, y a qué cola lleva', () => {
    const item = only(
      itemsWith(
        { depositReports: { total: 4, platform: 3, network: 1 } },
        {},
        '2026-10-10T15:00:00.000Z',
      ),
      'deposits',
    );
    expect(item).toMatchObject({
      severity: 'warning',
      title: 'Depósitos por aprobar',
      summary: '3 depósitos esperan tu aprobación · el más antiguo ayer.',
      details: ['1 espera a otro nodo de la red, que normalmente lo aprueba.'],
      action: { label: 'Revisar depósitos', href: '/admin/plataforma/aprobaciones' },
    });
  });

  it('depósitos: pasadas 48 horas es urgente; sin saber la antigüedad, sólo cuántos', () => {
    const stale = only(
      itemsWith(
        { depositReports: { total: 1, platform: 1, network: 0 } },
        {},
        '2026-10-07T15:00:00Z',
      ),
      'deposits',
    );
    expect(stale.severity).toBe('critical');
    expect(stale.summary).toBe('1 depósito espera tu aprobación · informado hace 4 días.');
    const unknown = only(
      itemsWith({ depositReports: { total: 2, platform: 2, network: 0 } }),
      'deposits',
    );
    expect(unknown).toMatchObject({
      severity: 'warning',
      summary: '2 depósitos esperan tu aprobación.',
    });
  });

  it('depósitos que sólo esperan a otros nodos: un aviso', () => {
    const item = only(
      itemsWith({ depositReports: { total: 2, platform: 0, network: 2 } }),
      'deposits',
    );
    expect(item).toMatchObject({
      severity: 'info',
      summary: '2 depósitos esperan a otros nodos de la red.',
    });
  });

  it('proveedores: caído, en recuperación, apagado de emergencia y apagado para la plataforma', () => {
    const item = only(
      itemsWith(
        {},
        {
          providers: {
            ...quietProviders(),
            openCircuits: [
              { code: 'sabre', state: 'open', failures: 5 },
              { code: 'latam-ndc', state: 'half-open', failures: 3 },
            ],
            killSwitched: [{ code: 'tbo-hotels', level: 'sales' }],
            disabledGlobally: [
              { code: 'agent-cars', reason: 'Contrato vencido', updatedAt: '2026-10-01T00:00:00Z' },
            ],
          },
        },
      ),
      'providers',
    );
    expect(item.severity).toBe('critical');
    expect(item.summary).toBe('4 proveedores no están vendiendo con normalidad.');
    expect(item.details).toEqual([
      'Sabre GDS: no está respondiendo',
      'LATAM NDC: se está recuperando, lo probamos con pocas búsquedas',
      'TBO Holidays: apagado de emergencia (solo ventas)',
      'AgentCars: apagado para toda la plataforma · Contrato vencido',
    ]);
    expect(item.action).toEqual({
      label: 'Ver proveedores',
      href: '/admin/plataforma/proveedores',
    });
  });

  it('proveedores: apagar todo es urgente; sólo ventas, revisar; apagado a propósito, aviso', () => {
    const level = (providers: Record<string, unknown>) =>
      only(itemsWith({}, { providers: { ...quietProviders(), ...providers } }), 'providers');
    expect(level({ killSwitched: [{ code: 'sabre', level: 'all' }] })).toMatchObject({
      severity: 'critical',
      summary: '1 proveedor no está vendiendo con normalidad.',
      details: ['Sabre GDS: apagado de emergencia (ventas y post-venta)'],
    });
    expect(level({ killSwitched: [{ code: 'sabre', level: 'sales' }] }).severity).toBe('warning');
    expect(
      level({
        disabledGlobally: [{ code: 'sabre', reason: null, updatedAt: '2026-10-01T00:00:00Z' }],
      }),
    ).toMatchObject({ severity: 'info', details: ['Sabre GDS: apagado para toda la plataforma'] });
  });

  it('post-venta: fallidas y sin terminar por tipo', () => {
    const item = only(
      itemsWith({
        postSale: {
          failed: 2,
          stuck: 3,
          byType: [
            { type: 'cancel', failed: 2, stuck: 1 },
            { type: 'hcn-ticket', failed: 0, stuck: 2 },
          ],
        },
      }),
      'post-sale',
    );
    expect(item).toMatchObject({
      severity: 'critical',
      title: 'Post-venta con problemas',
      summary: '2 operaciones fallaron y 3 siguen sin terminar.',
      details: [
        'Cancelaciones: 2 fallidas · 1 sin terminar',
        'Tareas para conseguir el número de confirmación del hotel: 2 abiertas',
      ],
    });
    const stuckOnly = only(
      itemsWith({
        postSale: { failed: 0, stuck: 1, byType: [{ type: 'pay', failed: 0, stuck: 1 }] },
      }),
      'post-sale',
    );
    expect(stuckOnly).toMatchObject({
      severity: 'warning',
      summary: '1 operación sigue sin terminar hace rato.',
      details: ['Pagos y emisiones: 1 sin terminar'],
    });
  });

  it('retenciones, hoteles, conciliación, carteras, seguridad e invitaciones', () => {
    const items = itemsWith(
      {
        walletHoldConflicts: 1,
        hotelOrdersUnverified: 2,
        reconciliation: { critical: 1, warning: 3, sinceDays: 30 },
        invitations: { pending: 4, expired: 1, expiredSinceDays: 30 },
      },
      {
        network: {
          ...(overviewPayload()['network'] as Record<string, unknown>),
          users: { active: 87, suspended: 0, locked: 2, adminsWithoutMfa: 1, loggedInPeriod: 61 },
        },
        wallets: [
          {
            ...((overviewPayload()['wallets'] as unknown[])[0] as Record<string, unknown>),
            overlimit: 2,
          },
        ],
      },
    );
    expect(only(items, 'wallet-holds')).toMatchObject({
      severity: 'critical',
      summary:
        '1 retención figuró confirmada con el proveedor y después no: hay que conciliarla a mano.',
    });
    expect(only(items, 'hotel-orders')).toMatchObject({
      severity: 'warning',
      summary: '2 reservas de hotel no tienen su estado confirmado con el proveedor.',
    });
    expect(only(items, 'reconciliation')).toMatchObject({
      severity: 'critical',
      summary: '1 diferencia crítica y 3 advertencias en los últimos 30 días.',
    });
    expect(only(items, 'wallets')).toMatchObject({
      severity: 'warning',
      summary: '2 carteras pasaron su cupo.',
      details: ['COP: 2 carteras'],
    });
    expect(only(items, 'security')).toMatchObject({
      severity: 'info',
      summary: '1 administrador no activó la verificación en dos pasos.',
      details: ['2 cuentas están bloqueadas por intentos fallidos.'],
    });
    expect(only(items, 'invitations')).toMatchObject({
      severity: 'info',
      summary: '4 pendientes de aceptar · 1 venció sin aceptar en los últimos 30 días.',
      action: { label: 'Ver invitaciones', href: INVITATIONS_HREF },
    });
  });

  it('las advertencias de conciliación solas son un aviso', () => {
    const item = only(
      itemsWith({ reconciliation: { critical: 0, warning: 1, sinceDays: 30 } }),
      'reconciliation',
    );
    expect(item).toMatchObject({
      severity: 'info',
      summary: '1 advertencia en los últimos 30 días.',
    });
  });

  it('de lo más grave a lo menos, y a igual severidad lo que corta la venta primero', () => {
    const items = itemsWith(
      {
        depositReports: { total: 1, platform: 1, network: 0 },
        walletHoldConflicts: 1,
        invitations: { pending: 1, expired: 0, expiredSinceDays: 30 },
        hotelOrdersUnverified: 1,
      },
      { providers: { ...quietProviders(), openCircuits: [{ code: 'sabre', state: 'open' }] } },
    );
    expect(items.map((i) => [i.id, i.severity])).toEqual([
      ['providers', 'critical'],
      ['wallet-holds', 'critical'],
      ['deposits', 'warning'],
      ['hotel-orders', 'warning'],
      ['invitations', 'info'],
    ]);
  });

  it('todas las tarjetas van en tú', () => {
    const items = itemsWith(
      {
        depositReports: { total: 4, platform: 3, network: 1 },
        postSale: { failed: 1, stuck: 1, byType: [{ type: 'cancel', failed: 1, stuck: 1 }] },
        hotelOrdersUnverified: 1,
        walletHoldConflicts: 2,
        reconciliation: { critical: 2, warning: 1, sinceDays: 30 },
        invitations: { pending: 1, expired: 2, expiredSinceDays: 30 },
      },
      {
        providers: {
          ...quietProviders(),
          openCircuits: [{ code: 'sabre', state: 'open' }],
          killSwitched: [{ code: 'tbo-hotels', level: 'all' }],
        },
      },
      '2026-10-01T00:00:00.000Z',
    );
    expect(items).toHaveLength(7);
    const copy = items
      .flatMap((i) => [i.title, i.summary, ...i.details, i.action?.label ?? ''])
      .join(' ');
    expect([...copy.matchAll(VOSEO)]).toEqual([]);
  });
});

describe('textos', () => {
  it('la severidad va escrita', () => {
    expect(SEVERITY_LABEL).toEqual({ critical: 'Urgente', warning: 'Revisar', info: 'Aviso' });
  });

  it('tipos de post-venta, verticales y proveedores; lo desconocido, por su código', () => {
    expect(postSaleTypeLabel('cancel')).toBe('Cancelaciones');
    expect(postSaleTypeLabel('void')).toBe('void');
    expect(salesVerticalLabel('hotels')).toBe('Hoteles');
    expect(salesVerticalLabel('assistance')).toBe('Asistencia al viajero');
    expect(salesVerticalLabel('cruises')).toBe('cruises');
    expect(providerName('tbo-hotels')).toBe('TBO Holidays');
    expect(providerName('nuevo-gds')).toBe('nuevo-gds');
  });

  it('el ticket promedio, en unidades enteras de la moneda', () => {
    expect(wholeUnits(154_166_667, 2)).toBe(154_166_700);
    expect(wholeUnits(81_667, 2)).toBe(81_700);
    expect(wholeUnits(1_234, 0)).toBe(1_234);
    expect(wholeUnits(1_550, null)).toBe(1_600);
  });

  it('cuándo se actualizó', () => {
    expect(updatedLabel('2026-10-11T14:59:40.000Z', NOW)).toBe('Actualizado hace un momento');
    expect(updatedLabel('2026-10-11T14:55:00.000Z', NOW)).toBe('Actualizado hace 5 minutos');
    expect(updatedLabel('no-es-fecha', NOW)).toBe('');
  });

  it('el período en palabras', () => {
    expect(periodCaption({ from: '2026-09-12', to: '2026-10-11' })).toBe(
      'Del 12 de septiembre al 11 de octubre de 2026',
    );
    expect(periodCaption({ from: '2026-10-11', to: '2026-10-11' })).toBe('11 de octubre de 2026');
    expect(periodCaption({ from: '2025-12-28', to: '2026-01-03' })).toBe(
      'Del 28 de diciembre de 2025 al 3 de enero de 2026',
    );
  });

  it('el mes de la tendencia', () => {
    expect(monthLabel('2026-10')).toBe('octubre de 2026');
    expect(monthLabel('raro')).toBe('raro');
  });

  it('el error: el mensaje del API cuando explica, uno propio cuando no', () => {
    expect(overviewErrorMessage(401, 'Unauthorized')).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(overviewErrorMessage(404, 'Ese nodo no existe: elige otro o mira toda la red.')).toBe(
      'Ese nodo no existe: elige otro o mira toda la red.',
    );
    expect(overviewErrorMessage(403)).toBe(
      'Sólo el superadmin de la plataforma ve el resumen de toda la red.',
    );
    expect(overviewErrorMessage(500, 'Internal server error')).toBe(
      'No pudimos cargar el resumen. Reintenta en unos segundos.',
    );
    expect(overviewErrorMessage(0)).toBe(
      'No pudimos cargar el resumen. Reintenta en unos segundos.',
    );
  });
});

describe('shouldLandOnPlatformOverview', () => {
  const superadmin = { platformUser: true, superadmin: true };

  it('el superadmin operando como plataforma entra al Resumen', () => {
    expect(shouldLandOnPlatformOverview('superadmin', superadmin)).toBe(true);
  });

  it('operando como vendedor de una sucursal, ve su Inicio', () => {
    expect(shouldLandOnPlatformOverview('vendedor', superadmin)).toBe(false);
  });

  it('nadie más cambia de entrada', () => {
    const agency = { platformUser: false, superadmin: false };
    expect(shouldLandOnPlatformOverview('tenant_admin', agency)).toBe(false);
    expect(shouldLandOnPlatformOverview('platform_admin', { ...agency, platformUser: true })).toBe(
      false,
    );
    expect(shouldLandOnPlatformOverview(undefined, agency)).toBe(false);
    expect(shouldLandOnPlatformOverview('superadmin', agency)).toBe(false);
  });
});
