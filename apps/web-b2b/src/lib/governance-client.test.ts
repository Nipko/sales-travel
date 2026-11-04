import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveProfile, loadProfiles, saveRule, updateProfile } from './governance-client';

const PERFIL = '20000000-0000-4000-8000-000000000001';

const PROFILE = {
  id: PERFIL,
  name: 'Solo hoteles',
  description: null,
  isDefaultForNewNodes: false,
  archived: false,
  items: [],
  tenantCount: 2,
  updatedAt: '2026-11-04T12:00:00.000Z',
};

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
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

describe('loadProfiles', () => {
  it('devuelve la lista validada', async () => {
    respond(200, [PROFILE]);
    const res = await loadProfiles();
    expect(res.ok && res.data[0]?.tenantCount).toBe(2);
  });

  it('una respuesta con forma rota no se pinta', async () => {
    respond(200, [{ id: PERFIL }]);
    expect(await loadProfiles()).toEqual({
      ok: false,
      message: expect.stringMatching(/no pudimos leer/),
    });
  });

  it('un 403 del API dice que es sólo del superadmin', async () => {
    respond(403, { error: 'superadmin access required' });
    const res = await loadProfiles();
    expect(res.ok ? '' : res.message).toMatch(/Sólo el superadmin/);
  });

  it('sin red no lanza', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect((await loadProfiles()).ok).toBe(false);
  });
});

describe('escrituras', () => {
  it('archivar un perfil asignado muestra el 409 del API', async () => {
    respond(409, {
      error: 'El perfil está asignado a 2 nodo(s). Reasígnalos antes de archivarlo.',
    });
    const res = await archiveProfile(PERFIL);
    expect(res.ok ? '' : res.message).toMatch(/asignado a 2 nodo/);
  });

  it('editar manda nombre, descripción y la matriz entera', async () => {
    const fetchMock = respond(200, PROFILE);
    await updateProfile(PERFIL, {
      name: ' Solo hoteles ',
      description: '',
      items: [{ provider: 'tbo-hotels', method: '', enabled: true }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/admin/governance/profiles/${PERFIL}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Solo hoteles',
      description: null,
      items: [{ provider: 'tbo-hotels', method: '', enabled: true }],
    });
  });

  it('quitar una regla manda enabled null y sin motivo', async () => {
    const fetchMock = respond(200, []);
    await saveRule({
      tenantId: null,
      provider: 'sabre',
      method: 'cash',
      enabled: null,
      reason: 'x',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      tenantId: null,
      provider: 'sabre',
      method: 'cash',
      enabled: null,
    });
  });
});
