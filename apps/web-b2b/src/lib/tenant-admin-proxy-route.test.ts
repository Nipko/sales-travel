import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas proxy de soporte a miembros y de puestos (reset-mfa, revoke-sessions,
 * send-password-reset, unlock, liberar un puesto, PATCH del cupo) sólo reenvían al API lo que viene
 * del propio panel: la cookie Lax viaja también desde un subdominio hermano.
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

describe('las rutas de enviar el enlace y desbloquear', () => {
  const TENANT = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
  const MEMBER = '99999999-8888-4777-8666-555555555555';
  const params = (userId = MEMBER) => ({ params: Promise.resolve({ tenantId: TENANT, userId }) });

  it.each([
    [
      'send-password-reset',
      () => import('../app/api/tenants/[tenantId]/members/[userId]/send-password-reset/route'),
    ],
    ['unlock', () => import('../app/api/tenants/[tenantId]/members/[userId]/unlock/route')],
  ])(
    '%s: desde el panel reenvía al API; desde otro sitio o con un id raro, no',
    async (action, load) => {
      const { POST } = await load();

      const ok = await POST(post({ 'sec-fetch-site': 'same-origin' }), params());
      expect(ok.status).toBe(200);
      expect(mocks.apiWithStatus).toHaveBeenCalledWith(
        `/tenants/${TENANT}/members/${MEMBER}/${action}`,
        { method: 'POST' },
      );

      mocks.apiWithStatus.mockClear();
      expect((await POST(post({ 'sec-fetch-site': 'cross-site' }), params())).status).toBe(403);
      expect((await POST(post({ 'sec-fetch-site': 'same-origin' }), params('..'))).status).toBe(
        400,
      );
      expect(mocks.apiWithStatus).not.toHaveBeenCalled();
    },
  );

  it('el 429 del API llega con su mensaje y su motivo', async () => {
    const { POST } = await import(
      '../app/api/tenants/[tenantId]/members/[userId]/send-password-reset/route'
    );
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 429,
      body: {
        message: 'Ya se enviaron varios enlaces a esta persona hace poco.',
        reason: 'PASSWORD_RESET_RATE_LIMITED',
      },
    });

    const res = await POST(post({ 'sec-fetch-site': 'same-origin' }), params());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'Ya se enviaron varios enlaces a esta persona hace poco.',
      reason: 'PASSWORD_RESET_RATE_LIMITED',
    });
  });
});
