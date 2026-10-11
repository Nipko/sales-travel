import { describe, expect, it } from 'vitest';
import { depositApprovalsPlan } from './deposit-approvals-proxy';

const NODE = '10000000-0000-4000-8000-0000000000AA';

const plan = (query: string, segments: string[] = [], method = 'GET') =>
  depositApprovalsPlan(method, segments, new URLSearchParams(query));

describe('depositApprovalsPlan: la cola', () => {
  it('sin filtros, la ruta del API sin query', () => {
    expect(plan('')).toEqual({ ok: true, method: 'GET', path: '/admin/deposit-reports' });
  });

  it('rearma cada filtro conocido, normalizado', () => {
    expect(
      plan(
        `status=approved&financedBy=network&currency=usd&tenantId=${NODE}&q=+Sur+&cursor=a_b-1&limit=20`,
      ),
    ).toEqual({
      ok: true,
      method: 'GET',
      path: `/admin/deposit-reports?status=approved&financedBy=network&currency=USD&tenantId=${NODE.toLowerCase()}&q=Sur&cursor=a_b-1&limit=20`,
    });
  });

  it('los vacíos no viajan', () => {
    expect(plan('status=&financedBy=&currency=&q=%20&cursor=')).toEqual({
      ok: true,
      method: 'GET',
      path: '/admin/deposit-reports',
    });
  });

  it.each([
    ['un estado raro', 'status=held'],
    ['un alcance raro', 'financedBy=all'],
    ['una moneda rota', 'currency=dollar'],
    ['un nodo que no es uuid', 'tenantId=abc'],
    ['una búsqueda larguísima', `q=${'x'.repeat(101)}`],
    ['una búsqueda con un NUL', 'q=TRX%001'],
    ['un cursor con caracteres raros', 'cursor=a%2Fb'],
    ['un límite fuera de rango', 'limit=101'],
    ['un límite que no es número', 'limit=1e2'],
    ['un parámetro desconocido', 'sort=amount'],
  ])('rechaza %s con 400', (_caso, query) => {
    const p = plan(query);
    expect(p.ok).toBe(false);
    expect(p.ok ? 0 : p.status).toBe(400);
  });
});

describe('depositApprovalsPlan: el contador y lo demás', () => {
  it('el contador, sin filtros', () => {
    expect(plan('', ['pending-count'])).toEqual({
      ok: true,
      method: 'GET',
      path: '/admin/deposit-reports/pending-count',
    });
    expect(plan('status=pending', ['pending-count']).ok).toBe(false);
  });

  it('otra ruta es 404 y otro método 405: esta ruta sólo lee', () => {
    expect(plan('', ['x'])).toMatchObject({ ok: false, status: 404 });
    expect(plan('', ['pending-count', 'x'])).toMatchObject({ ok: false, status: 404 });
    expect(plan('', [], 'POST')).toMatchObject({ ok: false, status: 405 });
  });
});
