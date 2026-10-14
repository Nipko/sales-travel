import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventDetail, eventLabel } from './audit-format';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CATEGORY_CHIPS,
  ACTIVITY_CATEGORY_PREFIXES,
  activePreset,
  activityActorLabel,
  activityCategoryOf,
  activityErrorMessage,
  activityExportErrorMessage,
  activityFiltersFromSearchParams,
  activityHref,
  activityNodeLabel,
  activitySearch,
  actorEmailTerm,
  appendEvents,
  DEFAULT_ACTIVITY_FILTERS,
  effectivePeriod,
  exportDoneMessage,
  exportFilename,
  formatActivityDate,
  orderActivityHref,
  orderSheetHref,
  parseActivityPage,
  prettyPayload,
  withDate,
  withPreset,
  type ActivityFilters,
} from './platform-audit';

/** 13 oct 2026, 10:00 en Bogotá. */
const NOW = new Date('2026-10-13T15:00:00.000Z');
const NODO = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';

const filters = (extra: Partial<ActivityFilters> = {}): ActivityFilters => ({
  ...DEFAULT_ACTIVITY_FILTERS,
  ...extra,
});

function apiSource(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../api/src/${relative}`, import.meta.url)),
    'utf8',
  );
}

/** Los valores de `const <NOMBRE> = { … } as const` de un archivo del API, sin los comentarios. */
function constMap(source: string, name: string): string[] {
  const block =
    new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\} as const`).exec(source)?.[1] ?? '';
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/^\s*\w+:\s*'([A-Za-z0-9_.]+)',?\s*$/gm)].map((m) => m[1] ?? '');
}

function constValue(source: string, name: string): string {
  return new RegExp(`const ${name} = '([A-Za-z0-9_.]+)'`).exec(source)?.[1] ?? '';
}

describe('las categorías, espejo del API', () => {
  it('los mismos prefijos que audit-categories.ts', () => {
    const source = apiSource('audit/audit-categories.ts');
    // `SYSTEM_EVENT_PREFIX` es 'system.' en el API.
    const text = source.replace(/SYSTEM_EVENT_PREFIX/g, "'system.'");
    for (const category of ACTIVITY_CATEGORIES) {
      const entry = new RegExp(
        `\\n  ${category}: \\{\\s*include: \\[([^\\]]*)\\](?:,\\s*exclude: \\[([^\\]]*)\\])?`,
      ).exec(text);
      const list = (raw: string | undefined) =>
        [...(raw ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
      expect(entry, category).not.toBeNull();
      expect(list(entry?.[1]), category).toEqual([...ACTIVITY_CATEGORY_PREFIXES[category].include]);
      expect(list(entry?.[2]), category).toEqual([
        ...(ACTIVITY_CATEGORY_PREFIXES[category].exclude ?? []),
      ]);
    }
  });

  it('los chips del panel: Todo y las siete', () => {
    expect(ACTIVITY_CATEGORY_CHIPS.map((c) => c.label)).toEqual([
      'Todo',
      'Accesos',
      'Equipo',
      'Red',
      'Carteras',
      'Proveedores',
      'Reservas',
      'Sistema',
    ]);
    expect(activityCategoryOf('system.post_sale_sweep.completed')).toBe('system');
    expect(activityCategoryOf('tenant.provider_disclosure.updated')).toBe('providers');
    expect(activityCategoryOf('algo.nuevo')).toBeNull();
  });
});

describe('cada evento que escribe el API tiene su nombre', () => {
  const orderEvents = constMap(apiSource('orders/order-events.ts'), 'ORDER_EVENTS');
  const hotelEvents = constMap(apiSource('hotels/hotel-events.ts'), 'HOTEL_EVENTS');
  const others = [
    ...constMap(apiSource('portfolios/wallet-financing.service.ts'), 'WALLET_EVENTS'),
    ...constMap(apiSource('announcements/announcements.service.ts'), 'ANNOUNCEMENT_EVENTS'),
    ...constMap(apiSource('orders/post-sale-sweep-events.ts'), 'POST_SALE_SWEEP_EVENTS'),
    ...constMap(
      apiSource('provider-payloads/provider-payloads.types.ts'),
      'PROVIDER_PAYLOAD_EVENTS',
    ),
    ...constMap(
      apiSource('booking-permissions/booking-permissions.service.ts'),
      'BOOKING_PERMISSION_EVENTS',
    ),
    constValue(apiSource('provider-enablement/kill-switch.store.ts'), 'KILL_SWITCH_SET_EVENT'),
    constValue(apiSource('provider-enablement/kill-switch.store.ts'), 'KILL_SWITCH_CLEARED_EVENT'),
    constValue(
      apiSource('provider-enablement/provider-enablement.service.ts'),
      'PROVIDER_ENABLEMENT_EVENT',
    ),
    constValue(
      apiSource('provider-enablement/provider-health.service.ts'),
      'PROVIDER_CIRCUIT_RESET_EVENT',
    ),
    constValue(apiSource('orders/admin-orders.service.ts'), 'ADMIN_ORDER_VIEWED_EVENT'),
    constValue(apiSource('orders/admin-order-actions.service.ts'), 'ADMIN_ORDER_ACTION_EVENT'),
    constValue(apiSource('audit/admin-audit.service.ts'), 'PLATFORM_AUDIT_EXPORTED_EVENT'),
    constValue(apiSource('tenants/user-export.service.ts'), 'USERS_EXPORTED_EVENT'),
    constValue(apiSource('tenants/legacy-passwords.service.ts'), 'LEGACY_RESET_BATCH_EVENT'),
    constValue(
      apiSource('reconciliation/reconciliation.service.ts'),
      'RECONCILIATION_REQUESTED_EVENT',
    ),
  ];

  it('la lectura del API encuentra los eventos (si no, el test no prueba nada)', () => {
    expect(orderEvents).toEqual(expect.arrayContaining(['OrderCreated', 'OrderTicketsVoided']));
    expect(orderEvents.length).toBeGreaterThanOrEqual(17);
    expect(hotelEvents).toEqual([
      'HotelOfferRepriced',
      'ProviderAccountIssueDetected',
      'HotelNonRefundableAcknowledged',
    ]);
    expect(others).not.toContain('');
  });

  it.each([...orderEvents, ...hotelEvents])('%s (ORDER_EVENTS / HOTEL_EVENTS)', (type) => {
    expect(eventLabel(type, {}).raw).toBe(false);
  });

  it.each(others)('%s', (type) => {
    expect(eventLabel(type, {}).raw).toBe(false);
  });
});

describe('los nombres de la operación', () => {
  it('el nodo suspendido o reactivado se lee de payload.after.status', () => {
    expect(eventLabel('tenant.updated', { after: { status: 'suspended' } }).text).toBe(
      'Nodo suspendido',
    );
    expect(eventLabel('tenant.updated', { after: { status: 'active' } }).text).toBe(
      'Nodo reactivado',
    );
    expect(eventLabel('tenant.updated', { after: { isBranch: true } }).text).toBe(
      'Nodo actualizado',
    );
  });

  it('la acción del superadmin dice cuál y si salió', () => {
    expect(eventLabel('platform.order.action', { action: 'cancel', outcome: 'ok' }).text).toBe(
      'El superadmin canceló la reserva',
    );
    expect(eventLabel('platform.order.action', { action: 'retrieve', outcome: 'error' }).text).toBe(
      'El superadmin intentó consultar el estado al proveedor',
    );
    expect(eventLabel('platform.order.action', { action: 'otra' }).text).toBe(
      'Acción del superadmin sobre la reserva',
    );
  });

  it('el detalle: monedas, proveedores, motivos y conteos; nunca ids', () => {
    const detail = (eventType: string, payload: Record<string, unknown>) =>
      eventDetail({ eventType, payload, targetEmail: null });
    expect(detail('portfolio.deposit.recorded', { currency: 'USD', amountMinor: 1 })).toBe('USD');
    expect(
      detail('platform.provider_kill_switch.set', { providerCode: 'zz-x', reason: 'Caído' }),
    ).toBe('zz-x · Motivo: Caído');
    expect(
      detail('platform.order.action', { action: 'cancel', reason: 'Lo pidió', orderId: ORDEN }),
    ).toBe('Motivo: Lo pidió');
    expect(detail('platform.audit.exported', { rows: 5000, truncated: true })).toBe(
      '5.000 filas (hasta el tope)',
    );
    // Reservas de la red › Exportar CSV: cuántas reservas, y si se buscó por el correo de un
    // cliente (el correo no está en el rastro).
    expect(eventLabel('platform.orders.exported', {}).text).toBe('Exportó las reservas de la red');
    expect(
      detail('platform.orders.exported', { rows: 1234, filters: { statuses: ['confirmed'] } }),
    ).toBe('1.234 reservas');
    expect(
      detail('platform.orders.exported', { rows: 1, filters: { q: null, qByClientEmail: true } }),
    ).toBe('1 reserva · buscando por el correo de un cliente');
    expect(detail('platform.orders.exported', { rows: 0 })).toBe('0 reservas');
    expect(detail('system.post_sale_sweep.completed', { tenants: 12, tenantsFailed: 1 })).toBe(
      '12 nodos revisados · 1 nodo con error',
    );
    expect(detail('wallet_hold.policy_changed', { previousMode: 'enforce', mode: 'observe' })).toBe(
      'de aplicar a observar',
    );
    expect(
      detail('platform.announcement.published', {
        severity: 'critical',
        audience: { rootTenantId: NODO, adminsOnly: true },
      }),
    ).toBe('Crítico · sólo administradores');
    expect(detail('OrderCreated', { orderId: ORDEN })).not.toContain(ORDEN);
  });
});

describe('los filtros y la URL', () => {
  it('sin fechas: los últimos 7 días de Bogotá', () => {
    expect(effectivePeriod(DEFAULT_ACTIVITY_FILTERS, NOW)).toEqual({
      from: '2026-10-07',
      to: '2026-10-13',
    });
    expect(activePreset(DEFAULT_ACTIVITY_FILTERS, NOW)).toBe('7d');
  });

  it('cambiar una fecha nunca deja un período al revés ni de más de 92 días', () => {
    const f = withDate(DEFAULT_ACTIVITY_FILTERS, 'from', '2026-01-01', NOW);
    expect(f).toMatchObject({ from: '2026-01-01', to: '2026-04-02' });
    const g = withDate(filters({ from: '2026-10-10', to: '2026-10-12' }), 'to', '2026-10-01', NOW);
    expect(g).toMatchObject({ from: '2026-10-01', to: '2026-10-01' });
    expect(withDate(DEFAULT_ACTIVITY_FILTERS, 'from', '2026-02-30', NOW)).toBe(
      DEFAULT_ACTIVITY_FILTERS,
    );
  });

  it('los atajos: 7 días es lo de siempre (sin fechas en la URL)', () => {
    expect(withPreset(DEFAULT_ACTIVITY_FILTERS, '90d', NOW)).toMatchObject({
      from: '2026-07-16',
      to: '2026-10-13',
    });
    expect(withPreset(filters({ from: '2026-01-01', to: '2026-01-02' }), '7d', NOW)).toMatchObject({
      from: null,
      to: null,
    });
    expect(activePreset(filters({ from: '2026-10-13', to: '2026-10-13' }), NOW)).toBe('today');
  });

  it('la URL va y vuelve, sin el correo de quien actuó', () => {
    const f = filters({
      category: 'orders',
      from: '2026-10-01',
      to: '2026-10-13',
      tenantId: NODO,
      actorEmail: 'ana@agencia.com',
      eventType: 'OrderCreated',
      aggregateType: 'order',
      aggregateId: ORDEN,
    });
    const href = activityHref(f);
    expect(href).toBe(
      `/admin/plataforma/actividad?categoria=reservas&desde=2026-10-01&hasta=2026-10-13&nodo=${NODO}&tipo=OrderCreated&entidad=order&id=${ORDEN}`,
    );
    expect(href).not.toContain('ana');
    const back = activityFiltersFromSearchParams(new URL(`https://x.test${href}`).searchParams);
    expect(back).toEqual({ ...f, actorEmail: '' });
    expect(activityHref(DEFAULT_ACTIVITY_FILTERS)).toBe('/admin/plataforma/actividad');
  });

  it('un enlace raro abre la actividad, no un error', () => {
    expect(
      activityFiltersFromSearchParams({
        categoria: 'precios',
        desde: '2026-13-01',
        nodo: 'x',
        tipo: "a'b",
        entidad: 'Order',
        id: 'x',
      }),
    ).toEqual(DEFAULT_ACTIVITY_FILTERS);
    // Al revés se da vuelta; de más de 92 días se acorta desde "hasta".
    expect(
      activityFiltersFromSearchParams({ desde: '2026-10-13', hasta: '2026-01-01' }),
    ).toMatchObject({ from: '2026-07-14', to: '2026-10-13' });
    // Una entidad sin id no filtra nada.
    expect(activityFiltersFromSearchParams({ entidad: 'order' }).aggregateType).toBeNull();
  });

  it('la query del BFF lleva las fechas resueltas y el correo sólo si está completo', () => {
    expect(activitySearch(DEFAULT_ACTIVITY_FILTERS, NOW)).toBe('from=2026-10-07&to=2026-10-13');
    expect(
      activitySearch(
        filters({ category: 'system', actorEmail: ' Ana@Agencia.COM ', tenantId: NODO }),
        NOW,
        'abc_-1',
      ),
    ).toBe(
      `from=2026-10-07&to=2026-10-13&category=system&tenantId=${NODO}&actorEmail=ana%40agencia.com&cursor=abc_-1`,
    );
    expect(activitySearch(filters({ actorEmail: 'ana@' }), NOW)).not.toContain('actorEmail');
    // La actividad reciente de la ficha de un nodo pide menos; un tamaño que no es un entero, nada.
    expect(activitySearch(filters({ tenantId: NODO }), NOW, null, 10)).toBe(
      `from=2026-10-07&to=2026-10-13&tenantId=${NODO}&limit=10`,
    );
    expect(activitySearch(DEFAULT_ACTIVITY_FILTERS, NOW, null, 0)).not.toContain('limit');
    expect(activitySearch(DEFAULT_ACTIVITY_FILTERS, NOW, null, 2.5)).not.toContain('limit');
    expect(actorEmailTerm('ana@agencia')).toBeNull();
    expect(actorEmailTerm('ana@agencia.com')).toBe('ana@agencia.com');
  });

  it('la actividad de una reserva: su entidad y los 92 días desde que se creó', () => {
    expect(orderActivityHref(ORDEN.toUpperCase(), '2026-10-01T20:00:00.000Z', NOW)).toBe(
      `/admin/plataforma/actividad?desde=2026-10-01&hasta=2026-10-13&entidad=order&id=${ORDEN}`,
    );
    expect(orderActivityHref(ORDEN, '2026-01-10T20:00:00.000Z', NOW)).toContain(
      'desde=2026-01-10&hasta=2026-04-11',
    );
    expect(orderSheetHref(ORDEN)).toBe(`/admin/plataforma/reservas?orden=${ORDEN}`);
  });
});

describe('la respuesta', () => {
  const event = {
    id: 'e1',
    occurredAt: '2026-10-13T14:41:12.123Z',
    eventType: 'auth.login.failed',
    tenantId: null,
    tenantName: null,
    actorEmail: null,
    targetEmail: null,
    aggregateType: null,
    aggregateId: null,
    payload: { reason: 'bad_password' },
    meta: { ip: '190.1.2.3', userAgent: 'Mozilla/5.0', requestId: 'r1', sessionId: 'nunca' },
  };

  it('lee la página y descarta lo que no se entiende', () => {
    const page = parseActivityPage({
      events: [event, { id: 'x' }, { ...event, id: 'e2', occurredAt: 'ayer' }, 'raro'],
      nextCursor: 'abc',
    });
    expect(page?.events).toHaveLength(1);
    expect(page?.events[0]?.meta).toEqual({
      ip: '190.1.2.3',
      userAgent: 'Mozilla/5.0',
      requestId: 'r1',
    });
    expect(page?.nextCursor).toBe('abc');
    expect(parseActivityPage({ nope: true })).toBeUndefined();
    expect(parseActivityPage(null)).toBeUndefined();
  });

  it('sumar una página no repite eventos', () => {
    const [a] = parseActivityPage({ events: [event] })?.events ?? [];
    const b = { ...a!, id: 'e2' };
    expect(appendEvents([a!], [a!, b]).map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('nodo, quién y fecha', () => {
    expect(activityNodeLabel({ tenantId: null, tenantName: null })).toBe('Plataforma');
    expect(activityNodeLabel({ tenantId: NODO, tenantName: null })).toBe('Nodo eliminado');
    expect(activityNodeLabel({ tenantId: NODO, tenantName: 'Andes' })).toBe('Andes');
    expect(
      activityActorLabel({ actorEmail: null, eventType: 'system.post_sale_sweep.completed' }),
    ).toBe('Proceso automático');
    expect(activityActorLabel({ actorEmail: null, eventType: 'auth.login.failed' })).toBe(
      'Sin sesión',
    );
    expect(activityActorLabel({ actorEmail: 'a@b.co', eventType: 'x' })).toBe('a@b.co');
    expect(formatActivityDate('2026-10-13T14:41:12.123Z')).toMatch(/13 oct 2026.*09:41/);
    expect(prettyPayload({})).toBeNull();
    expect(prettyPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('los mensajes', () => {
    expect(activityErrorMessage(403, undefined)).toMatch(/superadmin/);
    expect(activityErrorMessage(400, 'El período puede tener hasta 92 días')).toBe(
      'El período puede tener hasta 92 días',
    );
    expect(activityExportErrorMessage(403, 'Para hacer esto necesitas la verificación')).toBe(
      'Para hacer esto necesitas la verificación',
    );
    expect(activityExportErrorMessage(500, undefined)).toMatch(/No pudimos exportar/);
    expect(exportDoneMessage(5000, true)).toBe(
      'Exportamos 5.000 eventos: los más nuevos. Acota las fechas o los filtros para ver el resto.',
    );
    expect(exportDoneMessage(1, false)).toBe('Exportamos 1 evento.');
    expect(
      exportFilename('attachment; filename="actividad-2026-10-07-a-2026-10-13.csv"', {
        from: 'a',
        to: 'b',
      }),
    ).toBe('actividad-2026-10-07-a-2026-10-13.csv');
    expect(
      exportFilename('attachment; filename="../../x.sh"', { from: '2026-10-07', to: '2026-10-13' }),
    ).toBe('actividad-2026-10-07-a-2026-10-13.csv');
  });
});
