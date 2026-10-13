import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDERS_FILTERS,
  ordersHref,
  parsePlatformOrderDetail,
  parsePlatformOrderRow,
  type PlatformOrderDetail,
  type PlatformOrderRow,
} from '../../../../../../lib/platform-orders';
import {
  DETAIL_PAYLOAD,
  ORDER_1,
  ORDER_2,
  rowPayload,
} from '../../../../../../lib/platform-orders.fixture';
import { AUDIT_FOOTNOTE, OrderDetailContent, OrderDetailSheet } from './order-detail-sheet';
import { OrdersConsole, OrdersResults, type ListState } from './orders-console';

/** Formas del voseo que podrían colarse en esta pantalla (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|buscá|escribí|reintentá|abriste\s+vos|vos)(?!\p{L})/giu;

const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const noop = () => undefined;

const ROW = parsePlatformOrderRow(rowPayload()) as PlatformOrderRow;
const FLIGHT = parsePlatformOrderRow(
  rowPayload({
    id: ORDER_2,
    tenantName: 'Andes Travel',
    isBranch: false,
    provider: 'latam-ndc',
    vertical: 'flights',
    providerOrderId: 'XYZ789',
    orderNumber: 7,
    status: 'ticketed',
    subStatus: null,
    totalAmountMinor: 45_990,
    currency: 'USD',
    sellerEmail: null,
    attention: null,
  }),
) as PlatformOrderRow;
const DETAIL = parsePlatformOrderDetail(DETAIL_PAYLOAD) as PlatformOrderDetail;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function results(list: ListState, filters = DEFAULT_ORDERS_FILTERS): string {
  return renderToStaticMarkup(
    createElement(OrdersResults, {
      list,
      filters,
      now: NOW,
      selectedId: null,
      hrefFor: (row: PlatformOrderRow) => ordersHref(filters, row.id),
      onOpen: noop,
      onRetry: noop,
      onLoadMore: noop,
      onClear: noop,
    }),
  );
}

const READY = (orders: PlatformOrderRow[], nextCursor: string | null = null): ListState => ({
  status: 'ready',
  data: { orders, nextCursor },
  more: 'idle',
  refreshing: false,
});

describe('OrdersConsole en su primer pintado', () => {
  const html = renderToStaticMarkup(createElement(OrdersConsole));

  it('título, búsqueda y la lista anunciando que carga', () => {
    expect(html).toContain('<h1');
    expect(html).toContain('Reservas de la red');
    expect(html).toContain('Busca y revisa cualquier reserva de todos los nodos.');
    expect(html).toContain(
      'placeholder="Busca por PNR, localizador, n.º de orden o correo del cliente"',
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Cargando las reservas…');
  });

  it('los chips de estado, sin ninguno puesto', () => {
    for (const label of [
      'Requieren atención',
      'Pendientes',
      'Confirmadas',
      'Emitidas',
      'Canceladas',
      'Fallidas',
    ]) {
      expect(html).toMatch(new RegExp(`aria-pressed="false"[^>]*>(<svg[^]*?</svg>)?${label}<`));
    }
  });

  it('los filtros con nombre: vertical, proveedor, nodo con su red y fechas con atajos', () => {
    const t = text(html);
    for (const label of ['Vertical', 'Proveedor', 'Nodo', 'Incluir su red', 'Desde', 'Hasta']) {
      expect(t).toContain(label);
    }
    expect(html).toMatch(/<option value=""[^>]*>Todas<\/option>/);
    expect(html).toContain('<option value="hotels">Hoteles</option>');
    expect(html).toContain('>TBO Holidays</option>');
    expect(html).toContain('Cargando la red…');
    expect(html.match(/type="date"/g)).toHaveLength(2);
    for (const preset of ['Hoy', '7 días', '30 días']) expect(t).toContain(preset);
    // Sin nodo, "Incluir su red" no se puede tocar.
    const subtree = /<input type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(subtree).toContain('checked=""');
    expect(subtree).toContain('disabled=""');
  });

  it('en el teléfono los filtros van en una hoja que abre un botón', () => {
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*Filtros/);
  });

  it('desde el Resumen (?atencion=1): "Requieren atención" ya puesto', () => {
    const attention = renderToStaticMarkup(
      createElement(OrdersConsole, {
        initialFilters: { ...DEFAULT_ORDERS_FILTERS, attention: true },
      }),
    );
    expect(attention).toMatch(/aria-pressed="true"[^>]*>(<svg[^]*?<\/svg>)?Requieren atención</);
    expect(attention).toContain('Limpiar filtros');
  });

  it('con ?orden= la ficha espera a la página hidratada: así abre en el <body> y con el foco', () => {
    const open = renderToStaticMarkup(createElement(OrdersConsole, { initialOrderId: ORDER_1 }));
    expect(open).not.toContain('role="dialog"');
  });

  it('la ficha dice "Reserva" mientras llega, o lo de la fila que se tocó', () => {
    const fromLink = renderToStaticMarkup(
      createElement(OrderDetailSheet, { orderId: ORDER_1, preview: null, onClose: noop }),
    );
    expect(fromLink).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(fromLink).toMatch(/<h2 id="[^"]+"[^>]*>Reserva<\/h2>/);
    expect(fromLink).toContain('Cargando la reserva…');
    expect(fromLink).toContain('aria-label="Cerrar la ficha"');
    const fromRow = renderToStaticMarkup(
      createElement(OrderDetailSheet, { orderId: ORDER_1, preview: ROW, onClose: noop }),
    );
    expect(fromRow).toMatch(/<h2 id="[^"]+"[^>]*>Reserva #1042 · Agencia Sur<\/h2>/);
  });

  it('va en tú', () => {
    expect([...text(html).matchAll(VOSEO)]).toEqual([]);
  });
});

describe('OrdersResults', () => {
  it('la tabla: columnas, sucursal, producto, estado con su bandera ámbar y total', () => {
    const html = results(READY([ROW, FLIGHT]));
    const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    const headers = [...table.matchAll(/<th scope="col"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(headers).toEqual([
      'Fecha',
      'Nodo',
      'Producto',
      'Localizador',
      'N.º',
      'Estado',
      'Total',
      'Vendedor',
    ]);
    const t = text(table);
    expect(t).toContain('Agencia Sur Sucursal');
    expect(t).toContain('TBO Holidays');
    expect(t).toContain('TBO-778');
    expect(t).toContain('#1042');
    // Un hotel pendiente con la cancelación sin confirmar: lo mismo que ve la agencia.
    expect(t).toContain('Cancelación en curso');
    expect(t).toContain('Requiere atención: Cancelación fallida · desde ayer');
    expect(t).toContain('vende@sur.co');
    expect(t).toContain('LATAM NDC');
    expect(t).toContain('Emitida');
    expect(t).toMatch(/US\$\s?459,90/);
    expect(table).toContain(`href="/admin/plataforma/reservas?orden=${ORDER_1}"`);
    expect(table).toMatch(/class="[^"]*text-right[^"]*"[^>]*>Total</);
    expect(text(html)).toContain('hora de Bogotá');
  });

  it('en el teléfono, tarjetas con lo mismo', () => {
    const html = results(READY([ROW]));
    const cards = html.slice(html.indexOf('<ul class="space-y-2 xl:hidden"'));
    const t = text(cards);
    expect(t).toContain('#1042');
    expect(t).toContain('Agencia Sur');
    expect(t).toContain('Cancelación fallida · desde ayer');
    expect(cards).toContain(`href="/admin/plataforma/reservas?orden=${ORDER_1}"`);
  });

  it('"Cargar más" sólo si hay otra página', () => {
    expect(results(READY([ROW], 'next'))).toContain('Cargar más');
    expect(results(READY([ROW]))).not.toContain('Cargar más');
    expect(text(results(READY([ROW], 'next')))).toContain('1 reserva · hay más');
  });

  it('vacía: lo dice y ofrece limpiar los filtros puestos', () => {
    const filtered = results(READY([]), { ...DEFAULT_ORDERS_FILTERS, statuses: ['failed'] });
    expect(filtered).toContain('No hay reservas con estos filtros.');
    expect(filtered).toContain('Limpiar filtros');
    expect(results(READY([]))).not.toContain('Limpiar filtros');
  });

  it('error: el mensaje y Reintentar', () => {
    const html = results({
      status: 'error',
      message: 'Sólo el superadmin de la plataforma ve las reservas de toda la red.',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Sólo el superadmin de la plataforma ve las reservas de toda la red.');
    expect(html).toContain('Reintentar');
  });

  it('va en tú', () => {
    const all = [
      results(READY([ROW, FLIGHT], 'x')),
      results(READY([]), { ...DEFAULT_ORDERS_FILTERS, q: 'ana@x.co' }),
      results(READY([]), { ...DEFAULT_ORDERS_FILTERS, attention: true }),
    ].join(' ');
    expect([...text(all).matchAll(VOSEO)]).toEqual([]);
  });
});

describe('OrderDetailContent', () => {
  const html = renderToStaticMarkup(
    createElement(OrderDetailContent, { detail: DETAIL, now: NOW }),
  );
  const t = text(html);

  it('las secciones, en orden', () => {
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual([
      'Estado',
      'Cliente y pasajeros',
      'Importe',
      'Historial de operaciones',
      'Cartera',
      'Conciliación',
      'Actividad',
    ]);
  });

  it('estado: plataforma y proveedor por separado, y el desacuerdo a la vista', () => {
    expect(t).toContain('En la plataforma Confirmada');
    expect(t).toContain('En el proveedor Cancelada Cancelled');
    expect(t).toContain('Aquí figura confirmada, pero el proveedor la tiene cancelada.');
    expect(t).toContain('Confirmación del hotel (HCN): HCN-5521');
    expect(t).toContain('Leído 12 oct 2026, 09:00 · en la conciliación diaria');
    expect(t).toContain('Requiere atención: Retención de cartera en conflicto · desde ayer');
    expect(t).toContain('Requiere atención: Cancelación fallida · desde ayer');
  });

  it('cliente: nombres, correo y teléfono; nada de documentos', () => {
    expect(t).toContain('Ana Pérez · Adulto · Habitación 1');
    expect(t).toContain('Luis Pérez · Niño · Habitación 1');
    expect(t).toContain('ana@cliente.com');
    expect(t).toContain('+57 300 1234567');
  });

  it('importe, historial sin reintentar, cartera, conciliación y actividad', () => {
    expect(t).toMatch(/\$\s?125\.000/);
    expect(t).toContain('Cancelación');
    expect(t).toContain('Falló');
    // Sin `onRetry` no hay reintento: lo ofrece la ficha con su post-venta (order-actions.render).
    expect(html).not.toContain('>Reintentar<');
    expect(t).toContain('En conflicto');
    expect(t).toContain('Cancelada fuera de la plataforma');
    expect(t).toContain('Revisar');
    expect(t).toContain('Se intentó cancelar');
    expect(t).toContain('Respondió el proveedor');
    expect(t).toContain('vende@sur.co');
  });

  it('cierra con la nota de auditoría', () => {
    expect(AUDIT_FOOTNOTE).toBe(
      'Abriste esta reserva como superadmin: queda registrado en la auditoría.',
    );
    expect(t).toContain(AUDIT_FOOTNOTE);
  });

  it('sin historial, cartera, conciliación ni actividad, lo dice', () => {
    const bare = text(
      renderToStaticMarkup(
        createElement(OrderDetailContent, {
          detail: {
            ...DETAIL,
            operations: [],
            walletHold: null,
            reconciliation: [],
            events: [],
            attention: [],
          },
          now: NOW,
        }),
      ),
    );
    expect(bare).toContain('Sin operaciones de post-venta.');
    expect(bare).toContain('Sin retención de cartera para esta reserva.');
    expect(bare).toContain('Sin diferencias con el proveedor.');
    expect(bare).toContain('Sin actividad registrada.');
  });

  it('va en tú', () => {
    expect([...t.matchAll(VOSEO)]).toEqual([]);
  });
});
