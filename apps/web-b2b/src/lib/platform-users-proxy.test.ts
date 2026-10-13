import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * El borde de Plataforma → Usuarios: la consulta del directorio se reconstruye parámetro por
 * parámetro (lo desconocido no pasa), el cuerpo de la suspensión campo por campo, y las rutas del
 * panel reenvían sólo eso, con el estado y el motivo del API.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('./api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import {
  DIRECTORY_ROLES,
  platformUserImpactTarget,
  platformUsersListTarget,
  platformUserStatusPlan,
} from './platform-users-proxy';

const USER = '99999999-8888-4777-8666-555555555555';
const NODE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';

function target(search: string) {
  return platformUsersListTarget(new URLSearchParams(search));
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { users: [], nextCursor: null },
  });
});

describe('platformUsersListTarget: la consulta del directorio', () => {
  it('sin filtros va a /admin/users tal cual', () => {
    expect(target('')).toEqual({ ok: true, path: '/admin/users' });
  });

  it('reconstruye cada filtro: búsqueda recortada, nodo en minúsculas y tamaño normalizado', () => {
    const res = target(
      `q=%20%20ana%20p%C3%A9rez%20&status=suspended&role=vendedor&tenantId=${NODE.toUpperCase()}` +
        '&mfa=off&locked=true&neverLoggedIn=true&cursor=eyJh_-Z9&limit=020',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [path, qs] = res.path.split('?');
    expect(path).toBe('/admin/users');
    expect(Object.fromEntries(new URLSearchParams(qs))).toEqual({
      q: 'ana pérez',
      status: 'suspended',
      role: 'vendedor',
      tenantId: NODE,
      mfa: 'off',
      locked: 'true',
      neverLoggedIn: 'true',
      cursor: 'eyJh_-Z9',
      limit: '20',
    });
  });

  it('una búsqueda de sólo espacios es "sin búsqueda"', () => {
    expect(target('q=%20%20%20')).toEqual({ ok: true, path: '/admin/users' });
  });

  it('acepta cada rol del directorio, también el superadmin', () => {
    for (const role of DIRECTORY_ROLES) {
      expect(target(`role=${role}`)).toEqual({ ok: true, path: `/admin/users?role=${role}` });
    }
  });

  it.each([
    ['un parámetro desconocido', 'q=ana&page=2'],
    ['un parámetro repetido', 'status=active&status=suspended'],
    ['un estado desconocido', 'status=invited'],
    ['un rol retirado', 'role=platform_admin'],
    ['un rol con otra forma', 'role=Vendedor'],
    ['un nodo que no es uuid', 'tenantId=planetour'],
    ['2FA que no es on/off', 'mfa=1'],
    ['una bandera en false', 'locked=false'],
    ['una bandera vacía', 'neverLoggedIn='],
    ['un cursor con caracteres raros', 'cursor=abc%2Fdef'],
    ['un cursor larguísimo', `cursor=${'a'.repeat(201)}`],
    ['tamaño 0', 'limit=0'],
    ['tamaño 101', 'limit=101'],
    ['tamaño con decimales', 'limit=5.5'],
    ['tamaño negativo', 'limit=-1'],
    ['una búsqueda de más de 100', `q=${'a'.repeat(101)}`],
  ])('rechaza: %s', (_q, search) => {
    const res = target(search);
    expect(res.ok).toBe(false);
  });

  it('el rechazo de la búsqueda larga dice el tope; los demás, que recargue', () => {
    expect(target(`q=${'a'.repeat(101)}`)).toEqual({
      ok: false,
      error: 'La búsqueda puede tener hasta 100 caracteres.',
    });
    expect(target('page=2')).toEqual({
      ok: false,
      error: 'Los filtros del directorio no son válidos. Recarga la página.',
    });
  });
});

describe('platformUserImpactTarget y platformUserStatusPlan', () => {
  it('el impacto va al id en minúsculas; otro id no compone ruta', () => {
    expect(platformUserImpactTarget(USER.toUpperCase())).toEqual({
      ok: true,
      path: `/admin/users/${USER}/impact`,
    });
    expect(platformUserImpactTarget('../tenants')).toEqual({
      ok: false,
      error: 'Usuario inválido.',
    });
  });

  it('la suspensión reconstruye { userId, status } y descarta el resto', () => {
    expect(
      platformUserStatusPlan({ userId: USER.toUpperCase(), status: 'suspended', force: true }),
    ).toEqual({
      ok: true,
      path: '/admin/users/status',
      body: { userId: USER, status: 'suspended' },
    });
  });

  it.each([
    ['sin cuerpo', undefined, 'El cambio no se pudo leer.'],
    ['una lista', [USER], 'El cambio no se pudo leer.'],
    ['sin usuario', { status: 'active' }, 'Usuario inválido.'],
    [
      'un estado desconocido',
      { userId: USER, status: 'archived' },
      'El estado tiene que ser activo o suspendido.',
    ],
  ])('rechaza: %s', (_q, raw, error) => {
    expect(platformUserStatusPlan(raw)).toEqual({ ok: false, error });
  });
});

describe('las rutas del panel', () => {
  it('GET /api/admin/users reenvía la consulta reconstruida y devuelve el cuerpo del API', async () => {
    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(new Request('https://app.test/api/admin/users?q=ana&page=2'));
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    const ok = await GET(new Request('https://app.test/api/admin/users?q=ana&locked=true'));
    expect(ok.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/users?q=ana&locked=true');
    expect(await ok.json()).toEqual({ users: [], nextCursor: null });
  });

  it('GET /api/admin/users deja pasar el estado y el motivo del API, no el cuerpo crudo', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 403,
      body: { message: 'Esta acción es sólo para el superadmin.', stack: 'no' },
    });
    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(new Request('https://app.test/api/admin/users'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Esta acción es sólo para el superadmin.' });
  });

  it('GET del impacto valida el id antes de llegar al API', async () => {
    const { GET } = await import('../app/api/admin/users/[userId]/impact/route');
    const bad = await GET(new Request('https://app.test/x'), {
      params: Promise.resolve({ userId: 'nadie' }),
    });
    expect(bad.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    await GET(new Request('https://app.test/x'), { params: Promise.resolve({ userId: USER }) });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/admin/users/${USER}/impact`);
  });

  it('PATCH de la suspensión: sólo desde el panel, cuerpo reconstruido, JSON roto es 400', async () => {
    const { PATCH } = await import('../app/api/admin/users/status/route');
    const body = JSON.stringify({ userId: USER, status: 'suspended', extra: 1 });

    const ajeno = await PATCH(
      new Request('https://app.test/api/admin/users/status', {
        method: 'PATCH',
        headers: { 'sec-fetch-site': 'same-site' },
        body,
      }),
    );
    expect(ajeno.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    const roto = await PATCH(
      new Request('https://app.test/api/admin/users/status', {
        method: 'PATCH',
        headers: { 'sec-fetch-site': 'same-origin' },
        body: '{',
      }),
    );
    expect(roto.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 409,
      body: {
        message: 'Es el último superadmin activo: no se puede suspender.',
        reason: 'LAST_SUPERADMIN',
      },
    });
    const conflicto = await PATCH(
      new Request('https://app.test/api/admin/users/status', {
        method: 'PATCH',
        headers: { 'sec-fetch-site': 'same-origin' },
        body,
      }),
    );
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/users/status', {
      method: 'PATCH',
      body: JSON.stringify({ userId: USER, status: 'suspended' }),
    });
    expect(conflicto.status).toBe(409);
    expect(await conflicto.json()).toEqual({
      error: 'Es el último superadmin activo: no se puede suspender.',
      reason: 'LAST_SUPERADMIN',
    });
  });
});
