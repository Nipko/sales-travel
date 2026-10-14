import { describe, expect, it } from 'vitest';
import { overviewPlan } from './platform-overview-proxy';

const NODE = '10000000-0000-4000-8000-0000000000AA';
const NOW = new Date('2026-10-11T15:00:00.000Z');

const plan = (query: string, method = 'GET') =>
  overviewPlan(method, new URLSearchParams(query), NOW);

describe('overviewPlan', () => {
  it('sin período, los últimos 30 días de Bogotá', () => {
    expect(plan('')).toEqual({
      ok: true,
      method: 'GET',
      path: '/admin/overview?from=2026-09-12&to=2026-10-11',
    });
  });

  it('traduce cada período a sus días', () => {
    expect(plan('period=today')).toMatchObject({
      path: '/admin/overview?from=2026-10-11&to=2026-10-11',
    });
    expect(plan('period=7d')).toMatchObject({
      path: '/admin/overview?from=2026-10-05&to=2026-10-11',
    });
    expect(plan('period=month')).toMatchObject({
      path: '/admin/overview?from=2026-10-01&to=2026-10-11',
    });
  });

  it('"hoy" es el de Bogotá aunque en UTC ya sea mañana', () => {
    expect(
      overviewPlan('GET', new URLSearchParams('period=today'), new Date('2026-10-12T02:30:00Z')),
    ).toMatchObject({ path: '/admin/overview?from=2026-10-11&to=2026-10-11' });
  });

  it('el nodo viaja normalizado', () => {
    expect(plan(`period=30d&tenantId=${NODE}`)).toMatchObject({
      path: `/admin/overview?from=2026-09-12&to=2026-10-11&tenantId=${NODE.toLowerCase()}`,
    });
    expect(plan('tenantId=')).toMatchObject({ ok: true });
  });

  it('sólo acepta los períodos con nombre: fechas sueltas o un año, 400', () => {
    expect(plan('period=365d')).toEqual({
      ok: false,
      status: 400,
      error: 'Período inválido: elige hoy, 7 días, 30 días o este mes.',
    });
    expect(plan('from=2020-01-01')).toEqual({
      ok: false,
      status: 400,
      error: 'Filtro desconocido: from.',
    });
  });

  it('un nodo que no es uuid, 400', () => {
    expect(plan('tenantId=planetour')).toEqual({ ok: false, status: 400, error: 'Nodo inválido.' });
  });

  it('sólo lectura', () => {
    expect(plan('', 'POST')).toEqual({
      ok: false,
      status: 405,
      error: 'Operación no admitida en esta ruta.',
    });
  });
});
