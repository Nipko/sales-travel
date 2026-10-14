import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadInvitations,
  loadMembers,
  loadMembershipImpact,
  loadSeats,
  releaseSeat,
  removeMembership,
  runMemberAction,
  saveSeatPolicy,
} from './tenant-admin-seats-client';
import { isStepUpCancelled, registerStepUpPrompt } from './step-up';

const TENANT = '33333333-3333-4333-8333-333333333333';

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadMembers: un error nunca es un equipo vacío', () => {
  it('el 403 del proxy (que trae users: []) es un error de permiso', async () => {
    respond(403, { users: [] });
    expect(await loadMembers(TENANT)).toEqual({
      ok: false,
      message: 'No tienes permiso para ver el equipo de este nodo.',
    });
  });

  it('un 500 también', async () => {
    respond(500, { users: [] });
    const res = await loadMembers(TENANT);
    expect(res.ok).toBe(false);
  });

  it('sin conexión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await loadMembers(TENANT)).toMatchObject({ ok: false, message: /conectar/ });
  });

  it('éxito, con la URL del nodo', async () => {
    const fetchMock = respond(200, {
      users: [{ userId: 'u', email: 'a@b.co', role: 'vendedor' }],
    });
    const res = await loadMembers(TENANT);
    expect(res.ok && res.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/network/users?tenantId=${TENANT}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('una forma inesperada no se pinta como vacío', async () => {
    respond(200, { nada: true });
    expect(await loadMembers(TENANT)).toMatchObject({ ok: false });
  });
});

describe('loadInvitations', () => {
  it('error de permiso', async () => {
    respond(403, { invitations: [] });
    expect(await loadInvitations(TENANT)).toMatchObject({ ok: false, message: /permiso/ });
  });
});

describe('puestos', () => {
  it('loadSeats lee la vista', async () => {
    respond(200, {
      poolTenantId: TENANT,
      poolTenantName: 'Norte',
      inherited: false,
      limit: 2,
      inUse: 1,
      idleTimeoutMinutes: 30,
      idleInherited: true,
      ownSeats: 2,
      ownIdleTimeoutMinutes: null,
      sessions: [],
    });
    expect(await loadSeats(TENANT)).toMatchObject({ ok: true, data: { limit: 2, inUse: 1 } });
  });

  it('loadSeats: 403 dice que no administra el nodo', async () => {
    respond(403, { error: '' });
    expect(await loadSeats(TENANT)).toMatchObject({ ok: false, message: /No administras/ });
  });

  it('releaseSeat: POST a la ruta del proxy', async () => {
    const fetchMock = respond(200, { released: true });
    expect(await releaseSeat(TENANT, 'sess')).toEqual({ ok: true, data: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/${TENANT}/seats/sessions/sess/release`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('releaseSeat: 404 es que ya se cerró', async () => {
    respond(404, { error: 'not found' });
    expect(await releaseSeat(TENANT, 'sess')).toMatchObject({ ok: false, message: /ya se había/ });
  });

  it('saveSeatPolicy manda el cuerpo y traduce el 403', async () => {
    const fetchMock = respond(403, { error: '' });
    const res = await saveSeatPolicy(TENANT, { concurrentSeats: 5, idleTimeoutMinutes: null });
    expect(res).toMatchObject({ ok: false, message: /superadmin/ });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/tenants/${TENANT}/seats`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ concurrentSeats: 5, idleTimeoutMinutes: null }),
      }),
    );
  });
});

describe('runMemberAction', () => {
  it('el 403 muestra el motivo del API', async () => {
    respond(403, { error: 'Pertenece a otra red que no administras.', reason: 'X' });
    expect(await runMemberAction(TENANT, 'u1', 'reset-mfa')).toEqual({
      ok: false,
      message: 'No lo pudimos hacer: Pertenece a otra red que no administras.',
      reason: 'X',
    });
  });

  it('éxito: "Cerrar sus sesiones" trae cuántas cerró', async () => {
    const fetchMock = respond(200, { revoked: 0 });
    expect(await runMemberAction(TENANT, 'u1', 'revoke-sessions')).toEqual({
      ok: true,
      data: { revoked: 0 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/${TENANT}/members/u1/revoke-sessions`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('éxito sin conteo (restablecer 2FA) sigue siendo un éxito', async () => {
    respond(200, { ok: true });
    const res = await runMemberAction(TENANT, 'u1', 'reset-mfa');
    expect(res.ok).toBe(true);
    expect(res.ok ? res.data.revoked : 'error').toBeUndefined();
  });

  it('enviar el enlace: si el correo no salió lo dice; el 429 trae el motivo del API', async () => {
    const fetchMock = respond(200, { sent: false, expiresAt: '2026-10-11T13:00:00.000Z' });
    const res = await runMemberAction(TENANT, 'u1', 'send-password-reset');
    expect(res.ok ? res.data.sent : 'error').toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/${TENANT}/members/u1/send-password-reset`,
      expect.objectContaining({ method: 'POST' }),
    );

    respond(429, {
      error: 'Ya se enviaron varios enlaces a esta persona hace poco.',
      reason: 'PASSWORD_RESET_RATE_LIMITED',
    });
    expect(await runMemberAction(TENANT, 'u1', 'send-password-reset')).toEqual({
      ok: false,
      message: 'Ya se enviaron varios enlaces a esta persona hace poco.',
      reason: 'PASSWORD_RESET_RATE_LIMITED',
    });
  });

  it('desbloquear: ya no estaba bloqueado', async () => {
    respond(200, { unlocked: false });
    const res = await runMemberAction(TENANT, 'u1', 'unlock');
    expect(res.ok ? res.data.unlocked : 'error').toBe(false);
  });

  it('una página HTML de error no rompe con un error de parser', async () => {
    respond(502, '<!DOCTYPE html><html></html>');
    const res = await runMemberAction(TENANT, 'u1', 'reset-mfa');
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).not.toMatch(/JSON/);
  });

  describe('con el 2FA de hace más de 10 minutos (USR-13)', () => {
    const STEP_UP_BODY = {
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    };

    function replies(...list: Array<[number, unknown]>) {
      const fetchMock = vi.fn();
      for (const [status, body] of list) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
      }
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('pide el código y repite la acción una vez', async () => {
      const fetchMock = replies([403, STEP_UP_BODY], [200, { ok: true }]);
      const prompt = vi.fn(() => Promise.resolve(true));
      const unregister = registerStepUpPrompt(prompt);
      try {
        expect(await runMemberAction(TENANT, 'u1', 'reset-mfa')).toEqual({
          ok: true,
          data: {},
        });
      } finally {
        unregister();
      }
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `/api/tenants/${TENANT}/members/u1/reset-mfa`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('si se cierra el diálogo, la acción no se repite y no hay error que mostrar', async () => {
      const fetchMock = replies([403, STEP_UP_BODY]);
      const unregister = registerStepUpPrompt(() => Promise.resolve(false));
      try {
        expect(isStepUpCancelled(await runMemberAction(TENANT, 'u1', 'reset-mfa'))).toBe(true);
      } finally {
        unregister();
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('loadMembershipImpact', () => {
  const USER = '22222222-2222-4222-8222-222222222222';

  it('pregunta por el cambio que se va a confirmar', async () => {
    const fetchMock = respond(200, { invitationsToRevoke: 2 });
    expect(await loadMembershipImpact(TENANT, USER, { status: 'suspended' })).toEqual({
      ok: true,
      data: { invitationsToRevoke: 2 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/memberships/impact?tenantId=${TENANT}&userId=${USER}&status=suspended`,
      expect.anything(),
    );

    respond(200, { invitationsToRevoke: 1 });
    await loadMembershipImpact(TENANT, USER, { status: 'removed' });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/admin/memberships/impact?tenantId=${TENANT}&userId=${USER}&status=removed`,
      expect.anything(),
    );

    respond(200, { invitationsToRevoke: 0 });
    await loadMembershipImpact(TENANT, USER, { role: 'admin' });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/admin/memberships/impact?tenantId=${TENANT}&userId=${USER}&role=admin`,
      expect.anything(),
    );
  });

  it('un error o una respuesta rara vuelve como error, no como cero', async () => {
    respond(403, { error: 'no administras este nodo' });
    expect(await loadMembershipImpact(TENANT, USER, { status: 'suspended' })).toMatchObject({
      ok: false,
    });
    respond(200, { invitationsToRevoke: 'dos' });
    expect(await loadMembershipImpact(TENANT, USER, { status: 'suspended' })).toMatchObject({
      ok: false,
    });
  });
});

describe('removeMembership: quitar a alguien del nodo (USR-11)', () => {
  const USER = '22222222-2222-4222-8222-222222222222';

  it('POST con el miembro y el nodo; trae lo que arrastró', async () => {
    const fetchMock = respond(200, {
      id: 'm-1',
      status: 'removed',
      revokedSessions: 2,
      revokedInvitations: 1,
    });
    expect(await removeMembership(TENANT, USER)).toEqual({
      ok: true,
      data: { revokedSessions: 2, revokedInvitations: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/memberships/remove', {
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, tenantId: TENANT }),
    });
  });

  it('el 409 de una ya quitada y el 403 del último admin traen el motivo del API', async () => {
    respond(409, {
      error: 'Esta persona ya no forma parte de este nodo: para que vuelva, invítala de nuevo.',
      reason: 'MEMBERSHIP_REMOVED',
    });
    expect(await removeMembership(TENANT, USER)).toEqual({
      ok: false,
      message: 'Esta persona ya no forma parte de este nodo: para que vuelva, invítala de nuevo.',
      reason: 'MEMBERSHIP_REMOVED',
    });

    respond(403, {
      error: 'Es el último administrador activo del nodo: asigna otro antes de quitarlo.',
    });
    expect(await removeMembership(TENANT, USER)).toMatchObject({
      ok: false,
      message:
        'No lo pudimos hacer: Es el último administrador activo del nodo: asigna otro antes de quitarlo.',
    });
  });

  it('quitar a un admin puede pedir el código: se pide y se repite una vez; cerrar el diálogo no hace nada', async () => {
    const STEP_UP = {
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    };
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(STEP_UP), { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'removed', revokedInvitations: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const unregister = registerStepUpPrompt(() => Promise.resolve(true));
    try {
      expect(await removeMembership(TENANT, USER)).toMatchObject({ ok: true });
    } finally {
      unregister();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const once = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(STEP_UP), { status: 403 })),
    );
    vi.stubGlobal('fetch', once);
    const closed = registerStepUpPrompt(() => Promise.resolve(false));
    try {
      expect(isStepUpCancelled(await removeMembership(TENANT, USER))).toBe(true);
    } finally {
      closed();
    }
    expect(once).toHaveBeenCalledTimes(1);
  });
});
