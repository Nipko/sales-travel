import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVITY_FILTERS,
  parseActivityPage,
  type ActivityEventView,
  type ActivityPage,
} from '../../../../../../lib/platform-audit';
import { ActivityFilters, PinnedFilters } from './activity-filters';
import { ActivityPanel, ActivityResults, type ActivityListState } from './activity-panel';
import { EventDetailContent } from './event-detail-sheet';

/** Formas del voseo que podrían colarse en esta pantalla (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|buscá|escribí|reintentá|exportá|filtrá|mirá|vos)(?!\p{L})/giu;

const NOW = new Date('2026-10-13T15:00:00.000Z');
const NODO = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const noop = () => undefined;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

const PAGE = parseActivityPage({
  events: [
    {
      id: 'e1',
      occurredAt: '2026-10-13T14:41:12.000Z',
      eventType: 'tenant.updated',
      tenantId: NODO,
      tenantName: 'Andes Travel',
      actorEmail: 'root@planetour.cloud',
      targetEmail: null,
      aggregateType: 'tenant',
      aggregateId: NODO,
      payload: { changed: ['status'], after: { status: 'suspended' }, reason: 'Deuda vencida' },
      meta: { ip: '190.1.2.3', userAgent: 'Mozilla/5.0', requestId: 'req-1' },
    },
    {
      id: 'e2',
      occurredAt: '2026-10-13T14:00:00.000Z',
      eventType: 'auth.login.failed',
      tenantId: null,
      tenantName: null,
      actorEmail: null,
      targetEmail: null,
      aggregateType: null,
      aggregateId: null,
      payload: { reason: 'bad_password' },
      meta: {},
    },
    {
      id: 'e3',
      occurredAt: '2026-10-13T13:00:00.000Z',
      eventType: 'algo.nuevo',
      tenantId: NODO,
      tenantName: null,
      actorEmail: null,
      targetEmail: null,
      aggregateType: null,
      aggregateId: null,
      payload: {},
      meta: {},
    },
  ],
  nextCursor: 'abc',
}) as ActivityPage;

const ORDER_EVENT: ActivityEventView = {
  id: 'e4',
  occurredAt: '2026-10-13T14:41:12.000Z',
  eventType: 'platform.order.action',
  tenantId: NODO,
  tenantName: 'Andes Travel',
  actorEmail: 'root@planetour.cloud',
  targetEmail: null,
  aggregateType: 'order',
  aggregateId: ORDEN,
  payload: { action: 'cancel', outcome: 'ok', reason: 'Lo pidió la agencia' },
  meta: { ip: '190.1.2.3', userAgent: 'Mozilla/5.0 (Macintosh)', requestId: 'req-9' },
};

function results(list: ActivityListState, filtered = false): string {
  return renderToStaticMarkup(
    createElement(ActivityResults, {
      list,
      filtered,
      selectedId: null,
      onOpen: noop,
      onRetry: noop,
      onLoadMore: noop,
      onClear: noop,
    }),
  );
}

describe('la Actividad de la plataforma', () => {
  it('el encabezado, las categorías y la nota de la exportación', () => {
    const html = renderToStaticMarkup(createElement(ActivityPanel, {}));
    const t = text(html);
    expect(t).toContain('Actividad de la plataforma');
    expect(t).toContain('Quién hizo qué, dónde y cuándo, en toda la red.');
    for (const chip of [
      'Todo',
      'Accesos',
      'Equipo',
      'Red',
      'Carteras',
      'Proveedores',
      'Reservas',
      'Sistema',
    ]) {
      expect(t).toContain(chip);
    }
    expect(t).toContain('Exportar CSV');
    expect(t).toContain('Se exportan hasta 5.000 eventos con estos filtros.');
    // "Todo" está puesto de entrada.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Todo</);
    expect(t).toContain('Cargando la actividad');
    expect(t).not.toMatch(VOSEO);
  });

  it('cada evento: fecha, nombre con su código debajo, nodo, quién y detalle', () => {
    const html = results({ status: 'ready', data: PAGE, more: 'idle', refreshing: false });
    const t = text(html);
    for (const column of ['Fecha', 'Evento', 'Nodo', 'Quién', 'Detalle']) {
      expect(html).toContain(`>${column}</th>`);
    }
    expect(t).toContain('Nodo suspendido');
    expect(t).toContain('tenant.updated');
    expect(t).toContain('Motivo: Deuda vencida');
    expect(t).toContain('Andes Travel');
    expect(t).toContain('root@planetour.cloud');
    // Sin nodo: "Plataforma"; sin persona en un ingreso: "Sin sesión".
    expect(t).toContain('Ingreso fallido');
    expect(t).toContain('Plataforma');
    expect(t).toContain('Sin sesión');
    expect(t).toContain('Contraseña incorrecta');
    // Un tipo sin nombre sale por su código; un nodo que ya no está, dicho.
    expect(html).toMatch(/font-mono[^"]*">algo\.nuevo</);
    expect(t).toContain('Nodo eliminado');
    expect(t).toContain('3 eventos · hay más');
    expect(t).toContain('Cargar más');
    expect(t).not.toMatch(VOSEO);
  });

  it('sin eventos: el vacío, y "Limpiar filtros" si hay alguno', () => {
    const empty = { events: [], nextCursor: null };
    const t = text(
      results({ status: 'ready', data: empty, more: 'idle', refreshing: false }, true),
    );
    expect(t).toContain('Sin actividad para estos filtros.');
    expect(t).toContain('Limpiar filtros');
    expect(
      text(results({ status: 'ready', data: empty, more: 'idle', refreshing: false }, false)),
    ).not.toContain('Limpiar filtros');
  });

  it('un error se puede reintentar', () => {
    const t = text(results({ status: 'error', message: 'No pudimos cargar la actividad.' }));
    expect(t).toContain('No pudimos cargar la actividad.');
    expect(t).toContain('Reintentar');
  });

  it('los filtros: nodo con toda la plataforma, correo, fechas y atajos', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityFilters, {
        filters: DEFAULT_ACTIVITY_FILTERS,
        onChange: noop,
        email: '',
        onEmailChange: noop,
        nodes: { status: 'ready', options: [{ id: NODO, label: 'Andes Travel · Agencia' }] },
        now: NOW,
      }),
    );
    const t = text(html);
    expect(t).toContain('Toda la plataforma');
    expect(t).toContain('Andes Travel · Agencia');
    expect(t).toContain('Correo de quien actuó');
    expect(t).toContain('Desde');
    expect(t).toContain('Hasta');
    expect(html).toContain('value="2026-10-07"');
    expect(html).toContain('value="2026-10-13"');
    expect(t).toContain('90 días');
    expect(html).toMatch(/aria-pressed="true"[^>]*>7 días</);
    expect(t).not.toMatch(VOSEO);
  });

  it('los filtros que llegan de un evento se ven y se pueden quitar', () => {
    const html = renderToStaticMarkup(
      createElement(PinnedFilters, {
        filters: {
          ...DEFAULT_ACTIVITY_FILTERS,
          eventType: 'OrderCreated',
          aggregateType: 'order',
          aggregateId: ORDEN,
        },
        onChange: noop,
      }),
    );
    expect(text(html)).toContain('Tipo: OrderCreated');
    expect(text(html)).toContain(`Entidad: order · ${ORDEN}`);
    expect(html).toContain('aria-label="Quitar el filtro tipo: OrderCreated"');
    expect(
      renderToStaticMarkup(
        createElement(PinnedFilters, { filters: DEFAULT_ACTIVITY_FILTERS, onChange: noop }),
      ),
    ).toBe('');
  });
});

describe('el detalle del evento', () => {
  it('los datos, el JSON del payload, de dónde vino y la reserva', () => {
    const html = renderToStaticMarkup(
      createElement(EventDetailContent, { event: ORDER_EVENT, onFilter: noop }),
    );
    const t = text(html);
    expect(t).toContain('Motivo: Lo pidió la agencia');
    expect(t).toContain('Reservas');
    expect(t).toContain('Andes Travel');
    expect(t).toContain('"action": "cancel"');
    expect(t).toContain('190.1.2.3');
    expect(t).toContain('Mozilla/5.0 (Macintosh)');
    expect(t).toContain('req-9');
    expect(t).toContain('Ver la reserva');
    expect(html).toContain(`href="/admin/plataforma/reservas?orden=${ORDEN}"`);
    expect(t).toContain('Sólo este tipo de evento');
    expect(t).toContain('Toda la actividad de esta entidad');
    expect(t).not.toMatch(VOSEO);
  });

  it('sin entidad de reserva no hay enlace; sin IP, lo dice', () => {
    const event = PAGE.events[1] as ActivityEventView;
    const t = text(
      renderToStaticMarkup(createElement(EventDetailContent, { event, onFilter: noop })),
    );
    expect(t).not.toContain('Ver la reserva');
    expect(t).not.toContain('Toda la actividad de esta entidad');
    expect(t).toContain('No quedó registrado');
    expect(t).toContain('Accesos');
  });
});
