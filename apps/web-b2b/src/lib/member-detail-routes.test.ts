import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel de la ficha de un usuario (Equipo y el directorio): leen con el estado y el
 * motivo del API, validan los ids y reconstruyen la consulta antes de llegar a él, y cerrar una
 * sesión sólo sale desde el propio panel (mismo origen).
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('./api', () => ({ apiWithStatus: mocks.apiWithStatus }));

const NODE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
const USER = '99999999-8888-4777-8666-555555555555';
const SESSION = '11111111-2222-4333-8444-555555555555';
const CURSOR = 'eyJvY2N1cnJlZEF0IjoiMjAyNi0xMC0xM1QxMjowMDowMFoifQ';

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { user: { id: USER } },
  });
});

describe('GET /api/tenants/:tenantId/members/:userId', () => {
  it('reenvía con los ids validados y devuelve el cuerpo del API', async () => {
    const { GET } = await import('../app/api/tenants/[tenantId]/members/[userId]/route');
    const res = await GET(
      new Request('https://app.test/x'),
      params({ tenantId: NODE, userId: USER }),
    );
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/tenants/${NODE}/members/${USER}`);
    expect(await res.json()).toEqual({ user: { id: USER } });
  });

  it('un id raro es 400 sin llegar al API', async () => {
    const { GET } = await import('../app/api/tenants/[tenantId]/members/[userId]/route');
    const res = await GET(
      new Request('https://app.test/x'),
      params({ tenantId: NODE, userId: '..' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el 403 y el 404 del API llegan con su estado y su motivo, no el cuerpo crudo', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 404,
      body: {
        message: 'Ese miembro no está en este nodo.',
        reason: 'MEMBER_NOT_FOUND',
        stack: 'x',
      },
    });
    const { GET } = await import('../app/api/tenants/[tenantId]/members/[userId]/route');
    const res = await GET(
      new Request('https://app.test/x'),
      params({ tenantId: NODE, userId: USER }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Ese miembro no está en este nodo.',
      reason: 'MEMBER_NOT_FOUND',
    });
  });
});

describe('GET /api/tenants/:tenantId/members/:userId/audit', () => {
  it('reconstruye cursor y tamaño; un parámetro de más es 400', async () => {
    const { GET } = await import('../app/api/tenants/[tenantId]/members/[userId]/audit/route');
    const ok = await GET(
      new Request(`https://app.test/x?before=${CURSOR}&limit=30`),
      params({ tenantId: NODE, userId: USER }),
    );
    expect(ok.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      `/tenants/${NODE}/members/${USER}/audit?before=${CURSOR}&limit=30`,
    );

    mocks.apiWithStatus.mockClear();
    const bad = await GET(
      new Request('https://app.test/x?category=users'),
      params({ tenantId: NODE, userId: USER }),
    );
    expect(bad.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('POST /api/tenants/:tenantId/members/:userId/sessions/:sessionId/revoke', () => {
  function post(headers: Record<string, string>): Request {
    return new Request('https://app.test/x', { method: 'POST', headers });
  }

  it('desde el panel se reenvía; desde un subdominio hermano, no', async () => {
    const { POST } = await import(
      '../app/api/tenants/[tenantId]/members/[userId]/sessions/[sessionId]/revoke/route'
    );
    const ids = { tenantId: NODE, userId: USER, sessionId: SESSION };

    const ajeno = await POST(post({ 'sec-fetch-site': 'same-site' }), params(ids));
    expect(ajeno.status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    mocks.apiWithStatus.mockResolvedValueOnce({ kind: 'json', status: 200, body: { ok: true } });
    const propio = await POST(post({ 'sec-fetch-site': 'same-origin' }), params(ids));
    expect(propio.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      `/tenants/${NODE}/members/${USER}/sessions/${SESSION}/revoke`,
      { method: 'POST' },
    );
  });

  it('una sesión que no es UUID no compone otra ruta', async () => {
    const { POST } = await import(
      '../app/api/tenants/[tenantId]/members/[userId]/sessions/[sessionId]/revoke/route'
    );
    const res = await POST(
      post({ 'sec-fetch-site': 'same-origin' }),
      params({ tenantId: NODE, userId: USER, sessionId: '../../reset-mfa' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/users/:userId y su historial', () => {
  it('la ficha del directorio valida el id antes de llegar al API', async () => {
    const { GET } = await import('../app/api/admin/users/[userId]/route');
    const bad = await GET(new Request('https://app.test/x'), params({ userId: 'nadie' }));
    expect(bad.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    const ok = await GET(new Request('https://app.test/x'), params({ userId: USER.toUpperCase() }));
    expect(ok.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/admin/users/${USER}`);
  });

  it('el historial del directorio reconstruye la consulta', async () => {
    const { GET } = await import('../app/api/admin/users/[userId]/audit/route');
    await GET(new Request(`https://app.test/x?before=${CURSOR}`), params({ userId: USER }));
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/admin/users/${USER}/audit?before=${CURSOR}`);

    mocks.apiWithStatus.mockClear();
    const bad = await GET(new Request('https://app.test/x?limit=500'), params({ userId: USER }));
    expect(bad.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});
