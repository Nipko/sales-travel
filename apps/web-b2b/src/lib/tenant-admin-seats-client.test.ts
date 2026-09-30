import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadInvitations,
  loadMembers,
  loadSeats,
  releaseSeat,
  runMemberAction,
  saveSeatPolicy,
} from './tenant-admin-seats-client';

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
      message: 'No tenés permiso para ver el equipo de este nodo.',
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
    expect(await loadSeats(TENANT)).toMatchObject({ ok: false, message: /No administrás/ });
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
    respond(403, { error: 'Pertenece a otra red que no administrás.', reason: 'X' });
    expect(await runMemberAction(TENANT, 'u1', 'reset-mfa')).toEqual({
      ok: false,
      message: 'No lo pudimos hacer: Pertenece a otra red que no administrás.',
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

  it('una página HTML de error no rompe con un error de parser', async () => {
    respond(502, '<!DOCTYPE html><html></html>');
    const res = await runMemberAction(TENANT, 'u1', 'reset-mfa');
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).not.toMatch(/JSON/);
  });
});
