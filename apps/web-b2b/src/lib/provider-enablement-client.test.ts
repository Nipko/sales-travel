import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadPlatformProviders,
  loadTenantOptions,
  saveGlobal,
  saveTenant,
} from './provider-enablement-client';

const AGENCIA = '10000000-0000-4000-8000-000000000002';

const PROVIDER = {
  code: 'tbo-hotels',
  vertical: 'hotels',
  callPolicy: 'opt-in',
  defaultEnabled: false,
  killSwitch: null,
  legacyEnv: { allTenants: false, tenantIds: [] },
  global: null,
  overrides: [],
  baseline: { enabled: false, origin: 'default' },
};

function respond(status: number, body: unknown, asText = false): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(asText ? String(body) : JSON.stringify(body), {
        status,
        headers: { 'content-type': asText ? 'text/html' : 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPlatformProviders', () => {
  it('devuelve la lista validada', async () => {
    respond(200, [PROVIDER]);
    const res = await loadPlatformProviders();
    expect(res.ok && res.data[0]?.code).toBe('tbo-hotels');
  });

  it('una respuesta con forma rota no se pinta: se avisa', async () => {
    respond(200, [{ code: 'tbo-hotels' }]);
    const res = await loadPlatformProviders();
    expect(res).toEqual({ ok: false, message: expect.stringMatching(/no pudimos leer/) });
  });

  it('un 403 dice que es sólo para el superadmin', async () => {
    respond(403, { error: 'superadmin access required' });
    const res = await loadPlatformProviders();
    expect(res.ok ? '' : res.message).toMatch(/Sólo el superadmin/);
  });

  it('una página de error del proxy no revienta el parser', async () => {
    respond(502, '<!DOCTYPE html><html></html>', true);
    const res = await loadPlatformProviders();
    expect(res.ok).toBe(false);
  });

  it('sin conexión avisa, no lanza', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const res = await loadPlatformProviders();
    expect(res.ok ? '' : res.message).toMatch(/No pudimos conectar/);
  });
});

describe('escrituras', () => {
  it('Heredar es un DELETE sin cuerpo a la ruta del tenant', async () => {
    const fetchMock = respond(200, PROVIDER);
    await saveTenant('tbo-hotels', AGENCIA, { method: 'DELETE' });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/providers/tbo-hotels/tenants/${AGENCIA}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('fijar el global manda sólo `enabled` y `reason`', async () => {
    const fetchMock = respond(200, PROVIDER);
    const res = await saveGlobal('tbo-hotels', {
      method: 'PUT',
      body: { enabled: false, reason: 'Deuda' },
    });
    expect(res.ok).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false, reason: 'Deuda' });
  });

  it('un error de escritura trae el mensaje del API', async () => {
    respond(404, { error: 'El tenant no existe.' });
    const res = await saveTenant('tbo-hotels', AGENCIA, {
      method: 'PUT',
      body: { enabled: true, reason: null },
    });
    expect(res).toEqual({ ok: false, message: 'El tenant no existe.' });
  });
});

describe('loadTenantOptions', () => {
  it('toma id, nombre y slug, con el id en minúsculas', async () => {
    respond(200, {
      tenants: [
        { id: AGENCIA.toUpperCase(), name: 'Agencia Norte', slug: 'norte', status: 'active' },
        { id: 7, name: 'rota' },
      ],
    });
    const res = await loadTenantOptions();
    expect(res).toEqual({
      ok: true,
      data: [{ id: AGENCIA, name: 'Agencia Norte', slug: 'norte' }],
    });
  });
});
