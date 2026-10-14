import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTENTION_REASON_LABEL } from './attention-labels';
import { ATTENTION_ORDERS_HREF, attentionOrdersHref, platformOrderHref } from './platform-overview';
import {
  DEFAULT_ORDERS_FILTERS,
  ORDERS_EXPORT_MAX_ROWS,
  ORDERS_EXPORT_NOTE,
  ORDER_STATUS_VIEW,
  activeFilterCount,
  activePreset,
  appendOrders,
  attentionText,
  clearedFilters,
  emptyCopy,
  eventLabel,
  eventText,
  filtersFromSearchParams,
  filtersToSearchParams,
  formatOrderDate,
  isCalendarDay,
  nodeOptions,
  orderFromSearchParams,
  orderSheetTitle,
  ordersErrorMessage,
  ordersExportDoneMessage,
  ordersExportErrorMessage,
  ordersExportFilename,
  ordersHref,
  ordersSearch,
  parsePlatformOrderDetail,
  parsePlatformOrderRow,
  parsePlatformOrdersPage,
  passengerLine,
  providerOptions,
  reconciliationKindLabel,
  searchTerm,
  statusMismatch,
  toggleStatus,
  walletHoldHint,
  withDate,
  withPreset,
  type OrdersFilters,
} from './platform-orders';
import { DETAIL_PAYLOAD, NODE_SUR, ORDER_1, ORDER_2, rowPayload } from './platform-orders.fixture';

/** Formas del voseo que no pueden colarse en la consola (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|buscá|escribí|reintentá|vos)(?!\p{L})/giu;

const NOW = new Date('2026-10-13T15:00:00.000Z');

const FULL: OrdersFilters = {
  attention: true,
  statuses: ['pending', 'cancelled'],
  vertical: 'hotels',
  provider: 'tbo-hotels',
  tenantId: NODE_SUR,
  subtree: false,
  from: '2026-10-01',
  to: '2026-10-13',
  q: '',
};

describe('la URL de la pantalla', () => {
  it('ida y vuelta: los filtros salen iguales de su URL', () => {
    const params = filtersToSearchParams(FULL, ORDER_1);
    expect(Object.fromEntries(params)).toEqual({
      atencion: '1',
      estado: 'pendiente,cancelada',
      vertical: 'hoteles',
      proveedor: 'tbo-hotels',
      nodo: NODE_SUR,
      red: 'no',
      desde: '2026-10-01',
      hasta: '2026-10-13',
      orden: ORDER_1,
    });
    expect(filtersFromSearchParams(params)).toEqual(FULL);
    expect(orderFromSearchParams(params)).toBe(ORDER_1);
    // También desde el objeto que entrega Next a la página.
    expect(filtersFromSearchParams(Object.fromEntries(params))).toEqual(FULL);
  });

  it('sin filtros, la pantalla a secas', () => {
    expect(ordersHref(DEFAULT_ORDERS_FILTERS)).toBe('/admin/plataforma/reservas');
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual(DEFAULT_ORDERS_FILTERS);
  });

  it('la búsqueda NO va en la URL: puede ser el correo de un cliente', () => {
    const href = ordersHref({ ...DEFAULT_ORDERS_FILTERS, q: 'ana@cliente.com' });
    expect(href).toBe('/admin/plataforma/reservas');
    expect(filtersFromSearchParams(new URLSearchParams('q=ana@cliente.com')).q).toBe('');
  });

  it('"su red" sólo cuenta con un nodo', () => {
    expect(ordersHref({ ...DEFAULT_ORDERS_FILTERS, subtree: false })).toBe(
      '/admin/plataforma/reservas',
    );
    expect(filtersFromSearchParams(new URLSearchParams('red=no')).subtree).toBe(true);
  });

  it('un enlace viejo o editado a mano abre la lista: lo que no se conoce se ignora', () => {
    expect(
      filtersFromSearchParams(
        new URLSearchParams(
          'estado=pendiente,borrada,FALLIDA&vertical=paquetes&proveedor=TBO%20X&nodo=x&desde=2026-02-30&atencion=2',
        ),
      ),
    ).toEqual({ ...DEFAULT_ORDERS_FILTERS, statuses: ['pending', 'failed'] });
    expect(orderFromSearchParams(new URLSearchParams('orden=1042'))).toBeNull();
  });

  it('un rango al revés se da vuelta', () => {
    const f = filtersFromSearchParams(new URLSearchParams('desde=2026-10-13&hasta=2026-10-01'));
    expect([f.from, f.to]).toEqual(['2026-10-01', '2026-10-13']);
  });

  it('los estados salen siempre en el mismo orden: dos URLs con los mismos filtros son iguales', () => {
    const a = toggleStatus(toggleStatus(DEFAULT_ORDERS_FILTERS, 'failed'), 'pending');
    const b = toggleStatus(toggleStatus(DEFAULT_ORDERS_FILTERS, 'pending'), 'failed');
    expect(ordersHref(a)).toBe(ordersHref(b));
    expect(toggleStatus(a, 'failed').statuses).toEqual(['pending']);
  });

  it('los enlaces del Resumen abren la consola con lo que prometen', () => {
    const attention = new URL(ATTENTION_ORDERS_HREF, 'https://x').searchParams;
    expect(filtersFromSearchParams(attention)).toEqual({
      ...DEFAULT_ORDERS_FILTERS,
      attention: true,
    });
    const one = new URL(platformOrderHref(ORDER_2), 'https://x').searchParams;
    expect(orderFromSearchParams(one)).toBe(ORDER_2);
    expect(filtersFromSearchParams(one)).toEqual(DEFAULT_ORDERS_FILTERS);
    // El Resumen acotado a un nodo: las mismas que cuenta su tarjeta, el nodo con su red.
    const scoped = new URL(attentionOrdersHref(NODE_SUR), 'https://x').searchParams;
    expect(filtersFromSearchParams(scoped)).toEqual({
      ...DEFAULT_ORDERS_FILTERS,
      attention: true,
      tenantId: NODE_SUR,
      subtree: true,
    });
  });
});

describe('el pedido', () => {
  it('rearma los filtros con los nombres del API', () => {
    expect(
      Object.fromEntries(new URLSearchParams(ordersSearch({ ...FULL, q: 'ABC123' }, 'cur'))),
    ).toEqual({
      tenantId: NODE_SUR,
      subtree: 'false',
      vertical: 'hotels',
      provider: 'tbo-hotels',
      status: 'pending,cancelled',
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'ABC123',
      attention: 'true',
      cursor: 'cur',
    });
    expect(ordersSearch(DEFAULT_ORDERS_FILTERS)).toBe('');
  });

  it('la búsqueda: sin caracteres de control y con al menos 2 caracteres', () => {
    expect(searchTerm('  A ')).toBe('');
    expect(searchTerm(' ab\tc ')).toBe('ab c');
    expect(searchTerm('x'.repeat(150))).toHaveLength(100);
    expect(ordersSearch({ ...DEFAULT_ORDERS_FILTERS, q: 'a' })).toBe('');
    expect(searchTerm('#')).toBe('');
  });

  it('el n.º de orden como se ve en la pantalla, también el de un dígito', () => {
    expect(searchTerm('#1042')).toBe('1042');
    expect(searchTerm(' # 1042 ')).toBe('1042');
    expect(searchTerm('1042')).toBe('1042');
    // El API pide 2 caracteres y lee "07" como el número 7.
    expect(searchTerm('7')).toBe('07');
    expect(searchTerm('#7')).toBe('07');
    expect(ordersSearch({ ...DEFAULT_ORDERS_FILTERS, q: '#7' })).toBe('q=07');
    // Lo demás no se toca: un "#" en medio no es un número de orden.
    expect(searchTerm('AB#12')).toBe('AB#12');
    expect(searchTerm('#1234567890')).toBe('#1234567890');
  });
});

describe('fechas', () => {
  it('días que existen', () => {
    expect(isCalendarDay('2026-10-13')).toBe(true);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('13-10-2026')).toBe(false);
  });

  it('un rango nunca queda al revés: el otro extremo acompaña', () => {
    const base = { ...DEFAULT_ORDERS_FILTERS, from: '2026-10-05', to: '2026-10-08' };
    expect(withDate(base, 'from', '2026-10-10')).toMatchObject({
      from: '2026-10-10',
      to: '2026-10-10',
    });
    expect(withDate(base, 'to', '2026-10-01')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(withDate(base, 'from', '')).toMatchObject({ from: null, to: '2026-10-08' });
  });

  it('los atajos son días de Bogotá y se reconocen', () => {
    const today = withPreset(DEFAULT_ORDERS_FILTERS, 'today', NOW);
    expect([today.from, today.to]).toEqual(['2026-10-13', '2026-10-13']);
    const week = withPreset(DEFAULT_ORDERS_FILTERS, '7d', NOW);
    expect([week.from, week.to]).toEqual(['2026-10-07', '2026-10-13']);
    expect(activePreset(week, NOW)).toBe('7d');
    expect(activePreset(withPreset(week, '30d', NOW), NOW)).toBe('30d');
    expect(activePreset(DEFAULT_ORDERS_FILTERS, NOW)).toBeNull();
    // A las 21:00 de Bogotá ya es mañana en UTC: "hoy" sigue siendo el día de Bogotá.
    const late = withPreset(DEFAULT_ORDERS_FILTERS, 'today', new Date('2026-10-14T02:00:00Z'));
    expect(late.from).toBe('2026-10-13');
  });
});

describe('contadores y limpiar', () => {
  it('cuenta lo filtrado, sin la búsqueda', () => {
    expect(activeFilterCount(DEFAULT_ORDERS_FILTERS)).toBe(0);
    expect(activeFilterCount(FULL)).toBe(7);
    expect(clearedFilters({ ...FULL, q: 'ABC' })).toEqual({ ...DEFAULT_ORDERS_FILTERS, q: 'ABC' });
  });
});

describe('parsePlatformOrdersPage', () => {
  it('lee la página y descarta la fila rota', () => {
    const page = parsePlatformOrdersPage({
      orders: [rowPayload(), rowPayload({ id: 'no-es-uuid' }), rowPayload({ status: 'archived' })],
      nextCursor: 'abc',
    });
    expect(page?.nextCursor).toBe('abc');
    expect(page?.orders).toHaveLength(1);
    expect(page?.orders[0]).toMatchObject({
      id: ORDER_1,
      tenantName: 'Agencia Sur',
      isBranch: true,
      vertical: 'hotels',
      status: 'pending',
      subStatus: 'cancel-unverified',
      totalAmountMinor: 125_000_00,
      attention: { reason: 'cancel-failed', since: '2026-10-12T15:00:00.000Z' },
    });
  });

  it('un motivo que esta versión no conoce no se inventa: la fila sale sin bandera', () => {
    const row = parsePlatformOrderRow(
      rowPayload({ attention: { reason: 'brand-new', since: '2026-10-12T15:00:00.000Z' } }),
    );
    expect(row?.attention).toBeNull();
  });

  it('la respuesta rota, entera', () => {
    expect(parsePlatformOrdersPage({ orders: 'x', nextCursor: null })).toBeUndefined();
    expect(parsePlatformOrdersPage({ orders: [], nextCursor: 3 })).toBeUndefined();
    expect(parsePlatformOrdersPage(null)).toBeUndefined();
  });

  it('una página nueva no repite filas', () => {
    const a = parsePlatformOrderRow(rowPayload())!;
    const b = parsePlatformOrderRow(rowPayload({ id: ORDER_2, orderNumber: 7 }))!;
    expect(appendOrders([a], [a, b]).map((o) => o.id)).toEqual([ORDER_1, ORDER_2]);
  });
});

describe('parsePlatformOrderDetail', () => {
  it('lee la ficha completa', () => {
    const detail = parsePlatformOrderDetail(DETAIL_PAYLOAD);
    expect(detail?.order).toMatchObject({
      id: ORDER_1,
      pnr: 'TBO-778',
      status: 'confirmed',
      orderNumber: 1042,
      totalAmount: 125_000_00,
      currency: 'COP',
      contact: { email: 'ana@cliente.com', phone: '+57 300 1234567' },
    });
    expect(detail?.order.passengers).toEqual([
      { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT', room: 0 },
      { givenName: 'Luis', surname: 'Pérez', paxType: 'CHD', room: 0 },
    ]);
    expect(detail?.tenant.path.map((n) => n.name)).toEqual(['Planetour', 'Agencia Sur']);
    expect(detail?.seller).toEqual({ email: 'vende@sur.co', name: 'Vendedora Sur' });
    expect(detail?.operations).toHaveLength(1);
    expect(detail?.operations[0]).toMatchObject({ type: 'cancel', status: 'failed' });
    expect(detail?.walletHold).toMatchObject({ status: 'conflict', mode: 'enforce' });
    expect(detail?.reconciliation).toEqual([
      expect.objectContaining({ kind: 'R3', severity: 'warning' }),
    ]);
    expect(detail?.attention.map((a) => a.reason)).toEqual(['hold-conflict', 'cancel-failed']);
    expect(detail?.events.map((e) => e.eventType)).toEqual([
      'platform.order.action',
      'OrderCancellationAttempted',
      'OrderCreated',
    ]);
    expect(detail?.capabilities).toEqual({ retrieve: true, cancel: true });
  });

  it('las capacidades fallan cerradas: ausentes o raras, ninguna', () => {
    const { capabilities: _omit, ...withoutCapabilities } = DETAIL_PAYLOAD;
    expect(parsePlatformOrderDetail(withoutCapabilities)?.capabilities).toEqual({
      retrieve: false,
      cancel: false,
    });
    expect(
      parsePlatformOrderDetail({ ...DETAIL_PAYLOAD, capabilities: { retrieve: 'true', cancel: 1 } })
        ?.capabilities,
    ).toEqual({ retrieve: false, cancel: false });
  });

  it('una acción del superadmin trae qué hizo, si salió y el motivo; otro evento no', () => {
    const detail = parsePlatformOrderDetail(DETAIL_PAYLOAD);
    expect(detail?.events[0]?.adminAction).toEqual({
      action: 'retrieve',
      ok: true,
      reason: 'La agencia pidió revisar el estado',
    });
    expect(detail?.events[1]?.adminAction).toBeNull();
    const raro = parsePlatformOrderDetail({
      ...DETAIL_PAYLOAD,
      events: [
        {
          id: 'e1',
          occurredAt: '2026-10-12T15:10:00.000Z',
          eventType: 'platform.order.action',
          payload: { action: 'pay', outcome: 'ok' },
        },
      ],
    });
    expect(raro?.events[0]?.adminAction).toBeNull();
  });

  it('sin la orden o sin su nodo no hay ficha; lo demás se lee por partes', () => {
    expect(parsePlatformOrderDetail({ ...DETAIL_PAYLOAD, tenant: null })).toBeUndefined();
    expect(parsePlatformOrderDetail({ ...DETAIL_PAYLOAD, order: {} })).toBeUndefined();
    const partial = parsePlatformOrderDetail({
      ...DETAIL_PAYLOAD,
      operations: 'x',
      walletHold: { status: 'raro' },
      events: [{ id: 'e' }],
      seller: null,
    });
    expect(partial).toMatchObject({ operations: [], walletHold: null, events: [], seller: null });
  });
});

describe('textos', () => {
  it('la Actividad nombra la acción del superadmin y si no se completó', () => {
    const base = { eventType: 'platform.order.action' } as const;
    expect(eventText({ ...base, adminAction: { action: 'cancel', ok: true, reason: null } })).toBe(
      'El superadmin canceló la reserva',
    );
    expect(
      eventText({ ...base, adminAction: { action: 'send-confirmation', ok: false, reason: null } }),
    ).toBe('El superadmin intentó reenviar la confirmación');
    expect(
      eventText({ ...base, adminAction: { action: 'retry-cancel', ok: true, reason: null } }),
    ).toBe('El superadmin reintentó la cancelación');
    expect(
      eventText({ ...base, adminAction: { action: 'retrieve', ok: true, reason: null } }),
    ).toBe('El superadmin consultó el estado al proveedor');
    expect(eventText({ eventType: 'OrderCreated', adminAction: null })).toBe(
      'Respondió el proveedor',
    );
  });

  it('la bandera de atención dice el motivo y desde cuándo', () => {
    expect(
      attentionText({ reason: 'cancel-failed', since: '2026-10-12T15:00:00.000Z' }, NOW.getTime()),
    ).toBe('Cancelación fallida · desde ayer');
  });

  it('pasajeros con su tipo y habitación', () => {
    expect(passengerLine({ givenName: 'Ana', surname: 'Pérez', paxType: 'ADT', room: 1 })).toBe(
      'Ana Pérez · Adulto · Habitación 2',
    );
    expect(passengerLine({ givenName: 'Leo', surname: '', paxType: 'DRIVER', room: null })).toBe(
      'Leo · Conductor',
    );
  });

  it('la retención dice hasta dónde subió por la red (0060): el que vende siempre retuvo', () => {
    expect(walletHoldHint({ status: 'held', mode: 'enforce' })).toBeNull();
    expect(walletHoldHint({ status: 'held', mode: 'observe' })).toBe(
      'Red en observación: retuvo el nodo que vende; los nodos de arriba sólo se evaluaron, sin bloquear su saldo.',
    );
    expect(walletHoldHint({ status: 'captured', mode: 'off' })).toBe(
      'Retención en la red apagada: retuvo sólo el nodo que vende.',
    );
    expect(walletHoldHint({ status: 'released', mode: 'legacy' })).toContain(
      'sólo en el nodo que vende',
    );
    // Exenta: con cualquier modo, nadie retuvo.
    expect(walletHoldHint({ status: 'exempt', mode: 'off' })).toBe(
      'No retuvo ninguna cartera: se reservó con la cuenta propia del nodo con el proveedor.',
    );
    expect(walletHoldHint({ status: 'held', mode: null })).toBeNull();
  });

  it('un evento o una divergencia que no conocemos sale por su código', () => {
    expect(eventLabel('OrderCreated')).toBe('Respondió el proveedor');
    expect(eventLabel('SomethingNew')).toBe('SomethingNew');
    expect(reconciliationKindLabel('R4')).toBe('Cancelada aquí y activa en el proveedor');
    expect(reconciliationKindLabel('R9')).toBe('R9');
  });

  it('la fecha va en hora de Bogotá', () => {
    expect(formatOrderDate('2026-10-13T16:48:00.000Z')).toMatch(/13 oct 2026.*11:48/);
    expect(formatOrderDate('no')).toBe('');
  });

  it('el título de la ficha', () => {
    expect(orderSheetTitle(1042, 'Agencia Sur')).toBe('Reserva #1042 · Agencia Sur');
    expect(orderSheetTitle(null, null)).toBe('Reserva');
  });

  it('plataforma y proveedor que no cierran saltan a la vista', () => {
    expect(
      statusMismatch({ status: 'cancelled', providerTracking: { providerStatus: 'Confirmed' } }),
    ).toBe('Aquí figura cancelada, pero el proveedor la tiene activa.');
    expect(
      statusMismatch({ status: 'confirmed', providerTracking: { providerStatus: 'Cancelled' } }),
    ).toBe('Aquí figura confirmada, pero el proveedor la tiene cancelada.');
    expect(
      statusMismatch({ status: 'failed', providerTracking: { providerStatus: 'Vouchered' } }),
    ).toBe('Aquí figura fallida, pero el proveedor la tiene activa.');
    expect(
      statusMismatch({ status: 'confirmed', providerTracking: { providerStatus: 'unknown' } }),
    ).toBe('El proveedor informó un estado que no reconocemos.');
    expect(
      statusMismatch({ status: 'confirmed', providerTracking: { providerStatus: 'Confirmed' } }),
    ).toBeNull();
    expect(statusMismatch({ status: 'cancelled', providerTracking: null })).toBeNull();
  });

  it('los errores distinguen permisos, lo que no existe y la caída del servidor', () => {
    expect(ordersErrorMessage(403, 'Forbidden', 'list')).toBe(
      'Sólo el superadmin de la plataforma ve las reservas de toda la red.',
    );
    expect(ordersErrorMessage(503, undefined, 'list')).toBe(
      'No pudimos cargar las reservas. Reintenta en unos segundos.',
    );
    expect(ordersErrorMessage(500, 'boom', 'detail')).toBe(
      'No pudimos abrir la reserva. Reintenta en unos segundos.',
    );
    expect(ordersErrorMessage(404, undefined, 'detail')).toBe(
      'Esa reserva no existe o ya no está disponible.',
    );
    expect(ordersErrorMessage(404, undefined, 'list')).toBe(
      'Ese nodo no existe: busca en toda la red.',
    );
    expect(ordersErrorMessage(400, 'la búsqueda puede tener hasta 100 caracteres', 'list')).toBe(
      'la búsqueda puede tener hasta 100 caracteres',
    );
    expect(ordersErrorMessage(401, undefined, 'list')).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(ordersErrorMessage(0, undefined, 'list')).toMatch(/Revisa tu conexión/);
  });

  it('vacío: con atención sola dice que no hay nada esperando; si no, que pruebe otros filtros', () => {
    expect(emptyCopy({ ...DEFAULT_ORDERS_FILTERS, attention: true }).title).toBe(
      'No hay reservas que requieran atención.',
    );
    expect(emptyCopy(FULL).title).toBe('No hay reservas con estos filtros.');
    expect(emptyCopy({ ...DEFAULT_ORDERS_FILTERS, q: 'ana@x.co' }).text).toMatch(/correo exacto/);
  });

  it('va en tú', () => {
    const copy = [
      emptyCopy(FULL).text,
      emptyCopy({ ...DEFAULT_ORDERS_FILTERS, q: 'abc' }).text,
      ...[0, 400, 401, 403, 404, 500].flatMap((s) => [
        ordersErrorMessage(s, undefined, 'list'),
        ordersErrorMessage(s, undefined, 'detail'),
      ]),
    ].join(' ');
    expect([...copy.matchAll(VOSEO)]).toEqual([]);
  });
});

describe('selectores', () => {
  it('los nodos en el orden del árbol, con sangría y su tipo', () => {
    const options = nodeOptions([
      {
        id: NODE_SUR,
        slug: 'sur',
        name: 'Agencia Sur',
        tenantType: 'agency',
        isBranch: true,
        parentTenantId: 'p',
        status: 'active',
        depth: 2,
      },
      {
        id: 'p',
        slug: 'planetour',
        name: 'Planetour',
        tenantType: 'platform',
        parentTenantId: null,
        status: 'active',
        depth: 1,
      },
      {
        id: 'c',
        slug: 'andes',
        name: 'Andes',
        tenantType: 'consolidator',
        parentTenantId: 'p',
        status: 'active',
        depth: 2,
      },
      {
        id: 'a',
        slug: 'cumbre',
        name: 'Cumbre',
        tenantType: 'agency',
        parentTenantId: 'c',
        status: 'active',
        depth: 3,
      },
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'Planetour · Plataforma',
      '   Agencia Sur · Sucursal',
      '   Andes · Consolidador',
      '      Cumbre · Agencia',
    ]);
  });

  it('los proveedores con ficha, y el filtrado aunque no la tenga', () => {
    const labels = providerOptions(null).map((p) => p.label);
    expect(labels).toContain('TBO Holidays');
    expect(labels).toContain('LATAM NDC');
    expect(providerOptions('nuevo-bedbank').map((p) => p.value)).toContain('nuevo-bedbank');
  });
});

describe('Exportar CSV', () => {
  it('la nota dice qué se lleva el archivo y qué no', () => {
    expect(ORDERS_EXPORT_NOTE).toBe(
      'Exporta las reservas con los filtros actuales (hasta 5.000), sin datos de pasajeros.',
    );
    expect(ORDERS_EXPORT_NOTE.match(VOSEO)).toBeNull();
  });

  it('cuántas se exportaron', () => {
    expect(ordersExportDoneMessage(0)).toBe(
      'Exportamos el archivo: no hay reservas con estos filtros.',
    );
    expect(ordersExportDoneMessage(1)).toBe('Exportamos 1 reserva.');
    expect(ordersExportDoneMessage(5000)).toBe('Exportamos 5.000 reservas.');
  });

  it('los errores: el 422 y el 403 del 2FA con su texto; lo demás, el de la consola', () => {
    const tooLarge = 'Hay más de 5.000 reservas con estos filtros: acota las fechas o el nodo.';
    expect(ordersExportErrorMessage(422, tooLarge)).toBe(tooLarge);
    expect(ordersExportErrorMessage(422, undefined)).toBe(tooLarge);
    expect(
      ordersExportErrorMessage(403, 'Para hacer esto necesitas la verificación en dos pasos.'),
    ).toBe('Para hacer esto necesitas la verificación en dos pasos.');
    expect(ordersExportErrorMessage(403, undefined)).toBe(
      'Sólo el superadmin de la plataforma ve las reservas de toda la red.',
    );
    expect(ordersExportErrorMessage(400, 'Filtro desconocido: x.')).toBe('Filtro desconocido: x.');
    expect(ordersExportErrorMessage(0, undefined)).toMatch(/No pudimos conectar/);
    expect(ordersExportErrorMessage(500, 'stack')).toBe(
      'No pudimos exportar las reservas. Reintenta en unos segundos.',
    );
  });

  it('el nombre del archivo: el del API si es limpio; si no, el de hoy en Bogotá', () => {
    const lateInBogota = new Date('2026-10-14T03:30:00.000Z');
    expect(ordersExportFilename('attachment; filename="reservas-2026-10-13.csv"', NOW)).toBe(
      'reservas-2026-10-13.csv',
    );
    expect(ordersExportFilename('attachment; filename="../x.csv"', lateInBogota)).toBe(
      'reservas-2026-10-13.csv',
    );
    expect(ordersExportFilename(null, lateInBogota)).toBe('reservas-2026-10-13.csv');
  });
});

/**
 * Un archivo del API leído como texto: web-b2b no depende del API, pero el CSV que arma el API y la
 * pantalla tienen que nombrar igual cada cosa y contar con el mismo tope.
 */
function apiSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../api/src/${path}`, import.meta.url)), 'utf8');
}

/** Las entradas `clave: 'texto'` del objeto `name` de un archivo del API. */
function apiLabels(source: string, name: string): Record<string, string> {
  const block = new RegExp(`export const ${name}[^=]*= [{]([^}]*)[}]`).exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/^\s*'?([a-z-]+)'?: '([^']+)',$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

describe('el CSV del API y la consola dicen lo mismo', () => {
  const source = apiSource('orders/admin-orders-export.ts');

  it('los motivos de atención con los nombres de la consola', () => {
    const api = apiLabels(source, 'ATTENTION_REASON_LABEL');
    // Si la lectura se rompe, el test tiene que fallar y no comparar dos vacíos.
    expect(Object.keys(api)).toHaveLength(8);
    expect(api).toEqual(ATTENTION_REASON_LABEL);
  });

  it('los estados con los nombres de la tabla', () => {
    const api = apiLabels(source, 'ORDER_STATUS_LABEL');
    expect(Object.keys(api)).toHaveLength(5);
    expect(api).toEqual(
      Object.fromEntries(Object.entries(ORDER_STATUS_VIEW).map(([k, v]) => [k, v.label])),
    );
  });

  it('el mismo tope de 5.000', () => {
    const cap = /export const ADMIN_ORDERS_EXPORT_MAX_ROWS = (\d+);/.exec(
      apiSource('orders/admin-orders.schemas.ts'),
    )?.[1];
    expect(Number(cap)).toBe(ORDERS_EXPORT_MAX_ROWS);
  });
});
