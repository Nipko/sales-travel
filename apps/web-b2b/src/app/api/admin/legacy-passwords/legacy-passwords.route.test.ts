import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel de las cuentas heredadas (USR-14): la lista sin parámetros y forzar el cambio
 * sólo desde el panel, con el cuerpo reconstruido (`{ userIds }`: de 1 a 50 ids, sin repetir y en
 * minúsculas). El `reason` del 403 del 2FA llega a la pantalla para que pida el código.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import { legacyPasswordsTarget, legacyResetPlan } from '../../../../lib/platform-users-proxy';
import { POST as requireReset } from './require-reset/route';
import { GET as list } from './route';

const ANA = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

function ids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
  );
}

function post(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request('https://app.test/api/admin/legacy-passwords/require-reset', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { results: [], counts: { sent: 0, emailFailed: 0, skipped: 0, failed: 0 } },
  });
});

describe('legacyPasswordsTarget: la lista, sin parámetros', () => {
  it('sin nada, la ruta del API; con cualquier parámetro, 400', () => {
    expect(legacyPasswordsTarget(new URLSearchParams(''))).toEqual({
      ok: true,
      path: '/admin/legacy-passwords',
    });
    expect(legacyPasswordsTarget(new URLSearchParams('limit=1000')).ok).toBe(false);
  });
});

describe('legacyResetPlan: el cuerpo, reconstruido', () => {
  it('sólo los ids, sin repetir y en minúsculas', () => {
    expect(legacyResetPlan({ userIds: [ANA, BETO, ANA.toLowerCase()], extra: true })).toEqual({
      ok: true,
      path: '/admin/legacy-passwords/require-reset',
      body: { userIds: [ANA.toLowerCase(), BETO] },
    });
  });

  it('de 1 a 50; un id que no es UUID o un cuerpo raro no pasan', () => {
    expect(legacyResetPlan({ userIds: ids(50) }).ok).toBe(true);
    expect(legacyResetPlan({ userIds: ids(51) })).toEqual({
      ok: false,
      error: 'Como mucho 50 cuentas por pedido.',
    });
    expect(legacyResetPlan({ userIds: [] })).toEqual({
      ok: false,
      error: 'Elige al menos una cuenta.',
    });
    expect(legacyResetPlan({ userIds: [ANA, '../../admin'] }).ok).toBe(false);
    expect(legacyResetPlan({ userIds: [ANA, 7] }).ok).toBe(false);
    expect(legacyResetPlan({ userIds: ANA }).ok).toBe(false);
    expect(legacyResetPlan([ANA]).ok).toBe(false);
    expect(legacyResetPlan(undefined).ok).toBe(false);
  });
});

describe('las rutas', () => {
  it('GET reenvía la lista y devuelve lo del API', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 200,
      body: { users: [], truncated: false },
    });
    const res = await list(new Request('https://app.test/api/admin/legacy-passwords'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [], truncated: false });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/legacy-passwords');
  });

  it('GET con un parámetro de más: 400 sin llegar al API', async () => {
    const res = await list(new Request('https://app.test/api/admin/legacy-passwords?x=1'));
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('POST desde el panel reenvía el cuerpo reconstruido', async () => {
    const res = await requireReset(post({ userIds: [ANA] }));
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/legacy-passwords/require-reset', {
      method: 'POST',
      body: JSON.stringify({ userIds: [ANA.toLowerCase()] }),
    });
  });

  it('POST desde otro sitio, o con un JSON roto: rechazado sin llegar al API', async () => {
    const ajeno = await requireReset(
      post(
        { userIds: [ANA] },
        { 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
      ),
    );
    expect(ajeno.status).toBe(403);
    const roto = await requireReset(post('{"userIds": ['));
    expect(roto.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el 403 del 2FA llega con su motivo, para que el panel pida el código', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 403,
      body: {
        message: 'Confirma con tu código de verificación en dos pasos para seguir.',
        reason: 'MFA_RECENT_REQUIRED',
      },
    });
    const res = await requireReset(post({ userIds: [ANA] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Confirma con tu código de verificación en dos pasos para seguir.',
      reason: 'MFA_RECENT_REQUIRED',
    });
  });
});
