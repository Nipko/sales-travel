import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas proxy de soporte a miembros y de puestos (reset-mfa, revoke-sessions, liberar un
 * puesto, PATCH del cupo) sólo reenvían al API lo que viene del propio panel: la cookie Lax viaja
 * también desde un subdominio hermano.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('./api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import { forwardAction, forwardPlan } from './tenant-admin-proxy-route';

function post(headers: Record<string, string>): Request {
  return new Request('https://app.test/api/tenants/t/members/u/reset-mfa', {
    method: 'POST',
    headers,
  });
}

const TARGET = { ok: true, path: '/tenants/t/members/u/reset-mfa' } as const;
const PLAN = {
  ok: true,
  path: '/admin/tenants/t/seats',
  body: { concurrentSeats: 5 },
} as const;

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({ kind: 'json', status: 200, body: { ok: true } });
});

describe('forwardAction / forwardPlan: sólo desde el panel', () => {
  it('desde el panel (same-origin) se reenvía', async () => {
    const res = await forwardAction(post({ 'sec-fetch-site': 'same-origin' }), TARGET);
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/tenants/t/members/u/reset-mfa', {
      method: 'POST',
    });
  });

  it('desde un subdominio hermano (same-site) se rechaza sin llegar al API', async () => {
    const res = await forwardAction(post({ 'sec-fetch-site': 'same-site' }), TARGET);
    expect(res.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('un navegador viejo sin Sec-Fetch-Site: se compara Origin con el host', async () => {
    const ajeno = await forwardPlan(
      post({ origin: 'https://agencia.app.test', host: 'app.test' }),
      PLAN,
      'PATCH',
    );
    expect(ajeno.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    const propio = await forwardPlan(
      post({ origin: 'https://app.test', host: 'app.test' }),
      PLAN,
      'PATCH',
    );
    expect(propio.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/tenants/t/seats', {
      method: 'PATCH',
      body: JSON.stringify({ concurrentSeats: 5 }),
    });
  });
});
