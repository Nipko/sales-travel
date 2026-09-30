import { afterEach, describe, expect, it, vi } from 'vitest';
import { resendInvitation } from './tenant-admin-seats-client';

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
  it('pega al proxy del nodo y devuelve el nuevo vencimiento', async () => {
    const fetchMock = respond(200, { id: INVITATION, expiresAt: '2026-10-06T15:00:00.000Z' });

    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: true,
      data: { expiresAt: '2026-10-06T15:00:00.000Z' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/invitations/${INVITATION}/resend?tenantId=${TENANT}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('el motivo del API tal cual (ya viene en castellano)', async () => {
    respond(404, { error: 'Esa invitación ya no está pendiente en este nodo.' });
    expect(await resendInvitation(TENANT, INVITATION)).toEqual({
      ok: false,
      message: 'Esa invitación ya no está pendiente en este nodo.',
    });
  });

  it('sesión vencida y respuesta ilegible', async () => {
    respond(401, {});
    expect(await resendInvitation(TENANT, INVITATION)).toMatchObject({
      ok: false,
      message: /sesión venció/,
    });
    respond(200, { ok: true });
    expect(await resendInvitation(TENANT, INVITATION)).toMatchObject({ ok: false });
  });
});
