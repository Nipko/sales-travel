import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../../lib/session', () => ({ getSession: mocks.getSession }));

import { POST as legacyLogout } from '../auth/logout/route';
import { GET as end } from './end/route';
import { POST as logout } from './logout/route';
import { POST as ping } from './ping/route';

const SNAPSHOT = {
  sessionId: 's-1',
  idleTimeoutSeconds: 1800,
  lastSeenAt: '2026-09-29T15:00:00.000Z',
  expiresAt: '2026-09-30T03:00:00.000Z',
  serverNow: '2026-09-29T15:00:30.000Z',
  mfaVerified: true,
};

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.firma`;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.test${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Las cookies de sesión quedan borradas en la respuesta, y `st_trusted` ni se toca. */
function expectSessionCookiesCleared(res: Response): void {
  const setCookie = res.headers.getSetCookie().join('\n');
  expect(setCookie).toMatch(/st_session=;/);
  expect(setCookie).toMatch(/st_tenant=;/);
  expect(setCookie).not.toMatch(/st_trusted/);
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.getSession.mockReset();
  mocks.getSession.mockResolvedValue('token');
});

describe('POST /api/session/ping', () => {
  it('activo: consulta la sesión refrescando last_seen_at y devuelve el estado', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: SNAPSHOT });
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(await res.json()).toEqual({ ok: true, ...SNAPSHOT });
    expect(mocks.api).toHaveBeenCalledWith('/auth/session', {
      headers: { 'x-session-ping': 'active' },
    });
  });

  it('pasivo: manda x-session-ping para que el ping no mantenga viva una pestaña abandonada', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: SNAPSHOT });
    await ping(post('/api/session/ping', { active: false }));
    expect(mocks.api).toHaveBeenCalledWith('/auth/session', {
      headers: { 'x-session-ping': 'passive' },
    });
  });

  it('un cuerpo roto es pasivo', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: SNAPSHOT });
    await ping(
      new Request('https://app.test/api/session/ping', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        body: 'no es json',
      }),
    );
    expect(mocks.api).toHaveBeenCalledWith('/auth/session', {
      headers: { 'x-session-ping': 'passive' },
    });
  });

  it('401 con motivo: cierre con el motivo y cookies borradas', async () => {
    mocks.api.mockResolvedValue({
      ok: false,
      error: { status: 401, message: 'x', reason: 'SESSION_REPLACED' },
    });
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, motivo: 'otro-dispositivo' });
    expectSessionCookiesCleared(res);
  });

  it('401 SESSION_REVOKED: cerrada, pero SIN borrar cookies (la guardia lo confirma antes de salir)', async () => {
    // Puede ser el cambio de contraseña de este equipo: la cookie nueva llega con la respuesta de
    // la acción, y un Set-Cookie que la borra llegando después la pisaría.
    mocks.api.mockResolvedValue({
      ok: false,
      error: { status: 401, message: 'x', reason: 'SESSION_REVOKED' },
    });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, motivo: 'cerrada' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('inactividad', async () => {
    mocks.api.mockResolvedValue({
      ok: false,
      error: { status: 401, message: 'x', reason: 'SESSION_IDLE' },
    });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(await res.json()).toEqual({ ok: false, motivo: 'inactividad' });
  });

  it('reenvía el estado del 2FA: la guardia se entera si el rol pasó a exigirlo', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      data: { ...SNAPSHOT, mfaRequired: true, mfaEnabled: false, mfaVerified: false },
    });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(await res.json()).toMatchObject({
      ok: true,
      mfaRequired: true,
      mfaEnabled: false,
      mfaVerified: false,
    });
  });

  it('401 sin motivo con el token vigente (la base no respondió): se reintenta, no se cierra', async () => {
    mocks.getSession.mockResolvedValue(jwtWith({ exp: Date.now() / 1000 + 3600 }));
    mocks.api.mockResolvedValue({ ok: false, error: { status: 401, message: 'Unauthorized' } });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, retry: true });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('401 sin motivo con el token vencido: expirada', async () => {
    mocks.getSession.mockResolvedValue(jwtWith({ exp: Date.now() / 1000 - 5 }));
    mocks.api.mockResolvedValue({ ok: false, error: { status: 401, message: 'Unauthorized' } });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, motivo: 'expirada' });
    expectSessionCookiesCleared(res);
  });

  it('503 SESSION_CHECK_UNAVAILABLE del API: se reintenta', async () => {
    mocks.api.mockResolvedValue({
      ok: false,
      error: { status: 503, message: 'x', reason: 'SESSION_CHECK_UNAVAILABLE' },
    });
    const res = await ping(post('/api/session/ping', { active: false }));
    expect(await res.json()).toEqual({ ok: false, retry: true });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('sin cookie no pregunta nada: expirada', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(await res.json()).toEqual({ ok: false, motivo: 'expirada' });
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('API caído: no es un cierre, se reintenta', async () => {
    mocks.api.mockResolvedValue({ ok: false, error: { status: 503, message: 'x' } });
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, retry: true });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('respuesta del API con otra forma: se reintenta', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { hola: 1 } });
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, retry: true });
  });

  it('una excepción también responde JSON, nunca la página de error de Next', async () => {
    mocks.api.mockRejectedValue(new Error('boom'));
    const res = await ping(post('/api/session/ping', { active: true }));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: false, retry: true });
  });

  it('desde otro sitio: 403 y no toca la sesión', async () => {
    const res = await ping(
      post('/api/session/ping', { active: true }, { 'sec-fetch-site': 'same-site' }),
    );
    expect(res.status).toBe(403);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

describe('POST /api/session/logout', () => {
  it('por inactividad: revoca con reason idle y borra las cookies salvo st_trusted', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: {} });
    const res = await logout(post('/api/session/logout', { reason: 'idle' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.api).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      body: '{"reason":"idle"}',
    });
    expectSessionCookiesCleared(res);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('a mano: sin reason', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: {} });
    await logout(post('/api/session/logout', {}));
    expect(mocks.api).toHaveBeenCalledWith('/auth/logout', { method: 'POST', body: '{}' });
  });

  it('con el API caído igual borra las cookies', async () => {
    mocks.api.mockRejectedValue(new Error('down'));
    const res = await logout(post('/api/session/logout', undefined));
    expect(res.status).toBe(200);
    expectSessionCookiesCleared(res);
  });

  it('desde otro sitio: 403 y la sesión sigue', async () => {
    const res = await logout(post('/api/session/logout', {}, { 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('/api/auth/logout (el de antes) hace lo mismo', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: {} });
    const res = await legacyLogout(post('/api/auth/logout', undefined));
    expect(res.status).toBe(200);
    expect(mocks.api).toHaveBeenCalledWith('/auth/logout', { method: 'POST', body: '{}' });
    expectSessionCookiesCleared(res);
  });
});

describe('GET /api/session/end', () => {
  function get(query: string, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`https://app.test/api/session/end${query}`, { headers });
  }

  it('borra las cookies y manda al login con el motivo y la vuelta', () => {
    const res = end(get('?motivo=inactividad&next=%2Freservas%3Fid%3D7'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?motivo=inactividad&next=%2Freservas%3Fid%3D7');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expectSessionCookiesCleared(res);
  });

  it('reenvía los minutos de inactividad al login, sólo si son del rango válido', () => {
    expect(
      end(get('?motivo=inactividad&minutos=30&next=%2Freservas')).headers.get('location'),
    ).toBe('/login?motivo=inactividad&minutos=30&next=%2Freservas');
    expect(end(get('?motivo=inactividad&minutos=9999')).headers.get('location')).toBe(
      '/login?motivo=inactividad',
    );
    expect(end(get('?motivo=cerrada&minutos=30')).headers.get('location')).toBe(
      '/login?motivo=cerrada',
    );
  });

  it('un motivo fuera de la lista blanca no llega al login', () => {
    expect(end(get('?motivo=%3Cscript%3E')).headers.get('location')).toBe('/login');
  });

  it('sin motivo: login a secas, aunque traiga next', () => {
    expect(end(get('?next=%2Freservas')).headers.get('location')).toBe('/login');
  });

  it('un next externo se descarta', () => {
    expect(end(get('?motivo=expirada&next=%2F%2Fevil.example')).headers.get('location')).toBe(
      '/login?motivo=expirada',
    );
  });

  it('pedido del router de Next: respuesta no-RSC para forzar una navegación dura', () => {
    const res = end(get('?motivo=cerrada', { rsc: '1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(res.headers.get('location')).toBeNull();
    expectSessionCookiesCleared(res);
  });
});
