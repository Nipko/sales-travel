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

describe('las rutas de invitaciones y de memberships: mismo origen y cuerpo reconstruido', () => {
  const TENANT = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
  const MEMBER = '99999999-8888-4777-8666-555555555555';
  const INVITATION = '44444444-4444-4444-8444-444444444444';

  function request(
    method: 'POST' | 'PATCH',
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Request {
    return new Request(`https://app.test${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body }),
    });
  }
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const CROSS = { 'sec-fetch-site': 'same-site' };

  it('invitar: reenvía el cuerpo campo por campo y el 409 trae el id de la pendiente', async () => {
    const { POST } = await import('../app/api/invitations/route');
    const body = JSON.stringify({
      email: ' beto@agencia.co ',
      tenantId: TENANT,
      role: 'vendedor',
      extra: 1,
    });

    expect((await POST(request('POST', '/api/invitations', SAME, body))).status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'beto@agencia.co', tenantId: TENANT, role: 'vendedor' }),
    });

    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 409,
      body: {
        message: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
        reason: 'INVITATION_ALREADY_PENDING',
        details: { invitationId: INVITATION },
      },
    });
    const conflict = await POST(request('POST', '/api/invitations', SAME, body));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
      reason: 'INVITATION_ALREADY_PENDING',
      details: { invitationId: INVITATION },
    });
  });

  it('invitar: un JSON roto es 400, no 500, y no llega al API', async () => {
    const { POST } = await import('../app/api/invitations/route');
    const res = await POST(request('POST', '/api/invitations', SAME, '{"email":'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'La invitación no se pudo leer.' });
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('listar: el nodo se valida antes de componer la consulta', async () => {
    const { GET } = await import('../app/api/invitations/route');
    const ok = await GET(new Request(`https://app.test/api/invitations?tenantId=${TENANT}`));
    expect(ok.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/invitations?tenantId=${TENANT}`);

    mocks.apiWithStatus.mockClear();
    const raro = await GET(
      new Request('https://app.test/api/invitations?tenantId=x%26role%3Dsuperadmin'),
    );
    expect(raro.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['resend', () => import('../app/api/invitations/[id]/resend/route')],
    ['revoke', () => import('../app/api/invitations/[id]/revoke/route')],
  ])('%s: sólo desde el panel y con ids que no componen otra ruta', async (action, load) => {
    const { POST } = await load();
    const url = `/api/invitations/${INVITATION}/${action}?tenantId=${TENANT}`;
    const params = (id = INVITATION) => ({ params: Promise.resolve({ id }) });

    expect((await POST(request('POST', url, SAME), params())).status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      `/invitations/${INVITATION}/${action}?tenantId=${TENANT}`,
      { method: 'POST' },
    );

    mocks.apiWithStatus.mockClear();
    expect((await POST(request('POST', url, CROSS), params())).status).toBe(403);
    expect((await POST(request('POST', url, SAME), params('../../admin'))).status).toBe(400);
    expect(
      (await POST(request('POST', `/api/invitations/${INVITATION}/${action}`, SAME), params()))
        .status,
    ).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it.each([
    [
      'role',
      () => import('../app/api/admin/memberships/role/route'),
      { userId: MEMBER, tenantId: TENANT, role: 'vendedor' },
    ],
    [
      'status',
      () => import('../app/api/admin/memberships/status/route'),
      { userId: MEMBER, tenantId: TENANT, status: 'suspended' },
    ],
  ])(
    'membership %s: sólo desde el panel, cuerpo reconstruido y JSON roto = 400',
    async (kind, load, change) => {
      const { PATCH } = await load();
      const url = `/api/admin/memberships/${kind}`;

      const ok = await PATCH(
        request('PATCH', url, SAME, JSON.stringify({ ...change, extra: true })),
      );
      expect(ok.status).toBe(200);
      expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/admin/memberships/${kind}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      });

      mocks.apiWithStatus.mockClear();
      expect((await PATCH(request('PATCH', url, CROSS, JSON.stringify(change)))).status).toBe(403);
      expect((await PATCH(request('PATCH', url, SAME, 'no-json'))).status).toBe(400);
      expect(mocks.apiWithStatus).not.toHaveBeenCalled();
    },
  );
});
