import { afterEach, describe, expect, it, vi } from 'vitest';
import { resendInvitation, revokeInvitation, sendInvitation } from './tenant-admin-seats-client';

const TENANT = '33333333-3333-4333-8333-333333333333';
const INVITATION = '44444444-4444-4444-8444-444444444444';

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
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

describe('resendInvitation', () => {
  it('pega al proxy del nodo y devuelve el nuevo vencimiento y si el correo salió', async () => {
    const fetchMock = respond(200, {
      id: INVITATION,
      expiresAt: '2026-10-06T15:00:00.000Z',
      emailSent: true,
    });

    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: true,
      data: { expiresAt: '2026-10-06T15:00:00.000Z', emailSent: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/invitations/${INVITATION}/resend?tenantId=${TENANT}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('un correo que no salió llega como emailSent: false', async () => {
    respond(200, { id: INVITATION, expiresAt: '2026-10-06T15:00:00.000Z', emailSent: false });
    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: true,
      data: { expiresAt: '2026-10-06T15:00:00.000Z', emailSent: false },
    });
  });

  it('el motivo del API tal cual (ya viene en castellano)', async () => {
    respond(404, { error: 'Esa invitación ya no está pendiente en este nodo.' });
    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'Esa invitación ya no está pendiente en este nodo.',
    });
  });

  it('si ya no está pendiente lo marca (gone), para recargar la fila vieja', async () => {
    respond(404, {
      error: 'Esa invitación ya no está pendiente en este nodo.',
      reason: 'INVITATION_NOT_PENDING',
    });
    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'Esa invitación ya no está pendiente en este nodo.',
      gone: true,
    });

    // Otro rechazo (el rango) no la da por desaparecida.
    respond(403, {
      error: 'No puedes reenviar una invitación con un rol igual o superior al tuyo.',
      reason: 'ROLE_NOT_GRANTABLE',
    });
    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'No puedes reenviar una invitación con un rol igual o superior al tuyo.',
    });
  });

  it('sesión vencida, sin conexión y respuesta ilegible', async () => {
    respond(401, {});
    expect(await resendInvitation(TENANT, INVITATION)).toMatchObject({
      ok: false,
      message: /sesión venció/,
    });
    respond(200, { ok: true });
    expect(await resendInvitation(TENANT, INVITATION)).toMatchObject({ ok: false });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await resendInvitation(TENANT, INVITATION)).toMatchObject({
      ok: false,
      message: /conectar/,
    });
  });
});

describe('revokeInvitation', () => {
  it('pega al proxy del nodo con POST', async () => {
    const fetchMock = respond(200, { ok: true });
    expect(await revokeInvitation(TENANT, INVITATION)).toEqual({ ok: true, data: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/invitations/${INVITATION}/revoke?tenantId=${TENANT}`,
      { method: 'POST', cache: 'no-store' },
    );
  });

  it('el rango: el mensaje del API tal cual, sin darla por desaparecida', async () => {
    respond(403, {
      error: 'No puedes revocar una invitación con un rol igual o superior al tuyo.',
      reason: 'ROLE_NOT_GRANTABLE',
    });
    expect(await revokeInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'No puedes revocar una invitación con un rol igual o superior al tuyo.',
    });
  });

  it('si ya no estaba pendiente lo marca (gone); sin mensaje, el genérico', async () => {
    respond(404, {
      error: 'Esa invitación ya no está pendiente en este nodo.',
      reason: 'INVITATION_NOT_PENDING',
    });
    expect(await revokeInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'Esa invitación ya no está pendiente en este nodo.',
      gone: true,
    });

    respond(500, {});
    expect(await revokeInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'No pudimos revocar la invitación. Inténtalo de nuevo.',
    });
  });
});

describe('sendInvitation', () => {
  const INPUT = { email: 'beto@agencia.co', tenantId: TENANT, role: 'vendedor' };

  it('manda el pedido al proxy y devuelve el vencimiento y si el correo salió', async () => {
    const fetchMock = respond(200, {
      id: INVITATION,
      expiresAt: '2026-10-18T15:00:00.000Z',
      emailSent: false,
    });

    expect(await sendInvitation(INPUT)).toEqual({
      ok: true,
      data: { expiresAt: '2026-10-18T15:00:00.000Z', emailSent: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invitations',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(INPUT) }),
    );
  });

  it('el 409 de una pendiente trae su id para ofrecer reenviarla', async () => {
    respond(409, {
      error: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
      reason: 'INVITATION_ALREADY_PENDING',
      details: { invitationId: INVITATION },
    });
    expect(await sendInvitation(INPUT)).toEqual({
      ok: false,
      message: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
      pendingInvitationId: INVITATION,
    });
  });

  it('el 409 sin id (o de otro motivo) es un error con su mensaje y nada más', async () => {
    respond(409, {
      error: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
      reason: 'INVITATION_ALREADY_PENDING',
    });
    expect(await sendInvitation(INPUT)).toEqual({
      ok: false,
      message: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
    });

    respond(409, { error: 'Ese correo ya es miembro de este nodo.' });
    expect(await sendInvitation(INPUT)).toEqual({
      ok: false,
      message: 'Ese correo ya es miembro de este nodo.',
    });
  });

  it('sesión vencida, error sin mensaje, sin conexión y respuesta ilegible', async () => {
    respond(401, { error: 'Unauthorized' });
    expect(await sendInvitation(INPUT)).toMatchObject({ ok: false, message: /sesión venció/ });

    respond(500, {});
    expect(await sendInvitation(INPUT)).toEqual({
      ok: false,
      message: 'No pudimos enviar la invitación. Inténtalo de nuevo.',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await sendInvitation(INPUT)).toMatchObject({ ok: false, message: /conectar/ });

    respond(200, { ok: true });
    expect(await sendInvitation(INPUT)).toMatchObject({ ok: false, message: /no pudimos leer/ });
  });
});
