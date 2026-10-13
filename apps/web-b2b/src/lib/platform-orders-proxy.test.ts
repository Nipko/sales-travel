import { describe, expect, it } from 'vitest';
import {
  adminOrderActionPlan,
  adminOrderCancelPlan,
  adminOrderEstimateTarget,
  adminOrderPlan,
  adminOrderRetryPlan,
  adminOrdersPlan,
} from './platform-orders-proxy';

const NODE = '10000000-0000-4000-8000-0000000000AA';
const ORDER = '20000000-0000-4000-8000-0000000000BB';

const plan = (query: string, method = 'GET') => adminOrdersPlan(method, new URLSearchParams(query));
const bad = (error: string) => ({ ok: false, status: 400, error });

describe('adminOrdersPlan', () => {
  it('sin filtros, toda la red', () => {
    expect(plan('')).toEqual({ ok: true, method: 'GET', path: '/admin/orders' });
  });

  it('rearma cada filtro conocido, con el nodo normalizado', () => {
    const query = new URLSearchParams({
      tenantId: NODE,
      subtree: 'false',
      vertical: 'hotels',
      provider: 'tbo-hotels',
      status: 'pending,cancelled',
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'ana@cliente.com',
      attention: 'true',
      cursor: 'eyJhdCI6IjIwMjYifQ',
      limit: '25',
    });
    const res = plan(query.toString());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [path, search] = res.path.split('?');
    expect(path).toBe('/admin/orders');
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({
      tenantId: NODE.toLowerCase(),
      subtree: 'false',
      vertical: 'hotels',
      provider: 'tbo-hotels',
      status: 'pending,cancelled',
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'ana@cliente.com',
      attention: 'true',
      cursor: 'eyJhdCI6IjIwMjYifQ',
      limit: '25',
    });
  });

  it('un parámetro que no está en la lista blanca no viaja: 400', () => {
    expect(plan('tenant_id=x')).toEqual(bad('Filtro desconocido: tenant_id.'));
    expect(plan('status=pending&userId=1')).toEqual(bad('Filtro desconocido: userId.'));
    expect(plan(`${'x'.repeat(80)}=1`)).toEqual(bad(`Filtro desconocido: ${'x'.repeat(40)}.`));
  });

  it('un parámetro repetido es un error, no "el primero gana"', () => {
    expect(plan('status=pending&status=failed')).toEqual(bad('Filtro repetido: status.'));
  });

  it('los estados van separados por comas, cada uno conocido, sin repetir', () => {
    expect(plan('status=failed,pending,failed')).toMatchObject({
      path: '/admin/orders?status=failed%2Cpending',
    });
    expect(plan('status=pending,expired')).toEqual(bad('Estado inválido.'));
    expect(plan('status=pending,')).toEqual(bad('Estado inválido.'));
    expect(plan('status=PENDING')).toEqual(bad('Estado inválido.'));
  });

  it('sin nodo, "su red" no cambia nada y no se manda', () => {
    expect(plan('subtree=false')).toEqual({ ok: true, method: 'GET', path: '/admin/orders' });
    expect(plan('subtree=quizas')).toEqual(bad('Alcance del nodo inválido.'));
  });

  it('nodo, vertical y proveedor con su forma', () => {
    expect(plan('tenantId=planetour')).toEqual(bad('Nodo inválido.'));
    expect(plan('vertical=packages')).toEqual(bad('Vertical inválida.'));
    expect(plan('provider=TBO Hotels')).toEqual(bad('Proveedor inválido.'));
  });

  it('fechas: días que existen y en orden', () => {
    expect(plan('from=2026-02-30')).toEqual(bad('Fecha "desde" inválida.'));
    expect(plan('to=13/10/2026')).toEqual(bad('Fecha "hasta" inválida.'));
    expect(plan('from=2026-10-13&to=2026-10-01')).toEqual(
      bad('La fecha "hasta" no puede ser anterior a "desde".'),
    );
  });

  it('la búsqueda: sin caracteres de control, entre 2 y 100 caracteres', () => {
    expect(plan('q=a')).toEqual(bad('Escribe al menos 2 caracteres.'));
    expect(plan(`q=${'a'.repeat(101)}`)).toEqual(bad('La búsqueda es demasiado larga.'));
    expect(plan('q=AB%00C')).toEqual(bad('La búsqueda tiene caracteres no válidos.'));
    expect(plan('q=%20%20')).toEqual({ ok: true, method: 'GET', path: '/admin/orders' });
  });

  it('atención, página y límite', () => {
    expect(plan('attention=1')).toEqual(bad('Filtro de atención inválido.'));
    expect(plan('cursor=no%20vale')).toEqual(bad('Página inválida.'));
    expect(plan('limit=0')).toEqual(bad('Límite inválido.'));
    expect(plan('limit=101')).toEqual(bad('Límite inválido.'));
    expect(plan('limit=1e2')).toEqual(bad('Límite inválido.'));
    expect(plan('limit=007')).toMatchObject({ path: '/admin/orders?limit=7' });
  });

  it('sólo lectura', () => {
    expect(plan('', 'POST')).toEqual({
      ok: false,
      status: 405,
      error: 'Operación no admitida en esta ruta.',
    });
  });
});

describe('adminOrderPlan', () => {
  it('la ficha de una reserva, con el id normalizado', () => {
    expect(adminOrderPlan('GET', ORDER)).toEqual({
      ok: true,
      method: 'GET',
      path: `/admin/orders/${ORDER.toLowerCase()}`,
    });
  });

  it('un id que no es uuid no compone otra ruta del API', () => {
    expect(adminOrderPlan('GET', '..%2Fusers')).toEqual({
      ok: false,
      status: 404,
      error: 'Reserva inválida.',
    });
    expect(adminOrderPlan('GET', `${ORDER}/operations`)).toMatchObject({ ok: false, status: 404 });
  });

  it('sólo lectura', () => {
    expect(adminOrderPlan('DELETE', ORDER)).toMatchObject({ ok: false, status: 405 });
  });
});

const OPERATION = '40000000-0000-4000-8000-0000000000CC';
const BASE = `/admin/orders/${ORDER.toLowerCase()}`;

describe('las acciones de post-venta', () => {
  it('reenviar y consultar: sólo el motivo, aunque el navegador mande más', () => {
    expect(
      adminOrderActionPlan(ORDER, 'send-confirmation', { reason: 'Lo pidió el cliente', to: 'x' }),
    ).toEqual({
      ok: true,
      path: `${BASE}/send-confirmation`,
      body: { reason: 'Lo pidió el cliente' },
    });
    expect(adminOrderActionPlan(ORDER, 'retrieve', { reason: 'Revisar estado' })).toEqual({
      ok: true,
      path: `${BASE}/retrieve`,
      body: { reason: 'Revisar estado' },
    });
  });

  it('sin motivo de texto no viaja; lo corto lo rechaza el API con su mensaje', () => {
    const raws: unknown[] = [
      undefined,
      null,
      'texto',
      [],
      {},
      { reason: 42 },
      { reason: 'x'.repeat(2_001) },
    ];
    for (const raw of raws) {
      expect(adminOrderActionPlan(ORDER, 'retrieve', raw)).toEqual({
        ok: false,
        error: 'Escribe el motivo: queda en la auditoría.',
      });
    }
    expect(adminOrderActionPlan(ORDER, 'retrieve', { reason: 'abc' })).toMatchObject({ ok: true });
  });

  it('reintentar: la operación también es un uuid', () => {
    expect(adminOrderRetryPlan(ORDER, OPERATION, { reason: 'La agencia no entra' })).toEqual({
      ok: true,
      path: `${BASE}/operations/${OPERATION.toLowerCase()}/retry`,
      body: { reason: 'La agencia no entra' },
    });
    expect(adminOrderRetryPlan(ORDER, '../cancel', { reason: 'La agencia no entra' })).toEqual({
      ok: false,
      error: 'Operación inválida.',
    });
    expect(adminOrderRetryPlan(ORDER, OPERATION, {})).toMatchObject({ ok: false });
  });

  it('cancelar: el motivo y el número de la orden, un entero positivo', () => {
    expect(
      adminOrderCancelPlan(ORDER, { reason: 'Pedido del cliente', orderNumber: 1042, force: true }),
    ).toEqual({
      ok: true,
      path: `${BASE}/cancel`,
      body: { reason: 'Pedido del cliente', orderNumber: 1042 },
    });
    for (const orderNumber of [undefined, '1042', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(adminOrderCancelPlan(ORDER, { reason: 'Pedido del cliente', orderNumber })).toEqual({
        ok: false,
        error: 'Escribe el número de la orden para confirmar.',
      });
    }
    expect(adminOrderCancelPlan(ORDER, { orderNumber: 1042 })).toMatchObject({ ok: false });
  });

  it('la penalidad estimada: sólo lectura, sin cuerpo', () => {
    expect(adminOrderEstimateTarget(ORDER)).toEqual({
      ok: true,
      path: `${BASE}/cancellation-estimate`,
    });
  });

  it('un id de reserva que no es uuid no compone otra ruta del API', () => {
    const raw = { reason: 'Pedido del cliente', orderNumber: 1 };
    for (const id of ['..%2Fusers', `${ORDER}/x`, '']) {
      expect(adminOrderActionPlan(id, 'retrieve', raw)).toEqual({
        ok: false,
        error: 'Reserva inválida.',
      });
      expect(adminOrderRetryPlan(id, OPERATION, raw)).toMatchObject({ ok: false });
      expect(adminOrderCancelPlan(id, raw)).toMatchObject({ ok: false });
      expect(adminOrderEstimateTarget(id)).toMatchObject({ ok: false });
    }
  });
});
