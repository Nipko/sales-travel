import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  incoming: null as Headers | null,
  session: null as string | null,
  tenant: null as string | null,
  trusted: null as string | null,
}));

vi.mock('next/headers', () => ({
  headers: () =>
    mocks.incoming
      ? Promise.resolve(mocks.incoming)
      : Promise.reject(new Error('fuera de un request')),
}));
vi.mock('./session', () => ({
  getSession: () => Promise.resolve(mocks.session),
  getActiveTenant: () => Promise.resolve(mocks.tenant),
  getTrustedDevice: () => Promise.resolve(mocks.trusted),
}));

import {
  api,
  apiErrorFromBody,
  apiWithStatus,
  clientOriginHeaders,
  estadoHttpValido,
  readApiResponse,
  sendsTrustedDevice,
  SERVICIO_NO_DISPONIBLE,
} from './api';

const SECRET = 'x'.repeat(40);

describe('apiErrorFromBody: reason y details llegan a quien decide', () => {
  it('lee message, reason y details del cuerpo del API', () => {
    const error = apiErrorFromBody(401, 'Unauthorized', {
      statusCode: 401,
      message: 'Tu sesión se abrió en otro dispositivo.',
      reason: 'SESSION_REPLACED',
      details: { attemptsLeft: 3 },
    });
    expect(error).toEqual({
      status: 401,
      message: 'Tu sesión se abrió en otro dispositivo.',
      reason: 'SESSION_REPLACED',
      details: { attemptsLeft: 3 },
    });
  });

  it('message como lista, como antes', () => {
    expect(apiErrorFromBody(400, 'Bad Request', { message: ['a', 'b', 3] }).message).toBe('a, b');
  });

  it('sin cuerpo o sin mensaje: statusText, sin reason ni details', () => {
    expect(apiErrorFromBody(502, 'Bad Gateway', null)).toEqual({
      status: 502,
      message: 'Bad Gateway',
    });
    expect(apiErrorFromBody(500, 'Internal', { message: '' })).toEqual({
      status: 500,
      message: 'Internal',
    });
  });

  it('un reason que no es un motivo máquina no se usa', () => {
    expect(apiErrorFromBody(401, 'x', { reason: 'sesión vencida' }).reason).toBeUndefined();
    expect(apiErrorFromBody(401, 'x', { reason: 42 }).reason).toBeUndefined();
  });

  it('el estado sigue saneado', () => {
    expect(apiErrorFromBody(0, 'x', {}).status).toBe(SERVICIO_NO_DISPONIBLE);
  });
});

describe('clientOriginHeaders: el API ve la IP y el navegador del usuario, no los del contenedor', () => {
  const browser = new Headers({
    'x-edge-peer-ip': '172.68.10.1',
    'cf-connecting-ip': '190.24.8.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
  });

  it('peer y CF-Connecting-IP juntos, como la clave del throttler; más el secreto', () => {
    expect(clientOriginHeaders(browser, SECRET)).toEqual({
      'x-internal-proxy': SECRET,
      'x-client-ip': '172.68.10.1|190.24.8.9',
      'x-client-user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
    });
  });

  it('sin Cloudflare: sólo el peer', () => {
    const direct = new Headers({ 'x-edge-peer-ip': '203.0.113.7' });
    expect(clientOriginHeaders(direct, SECRET)['x-client-ip']).toBe('203.0.113.7');
  });

  it('una CF-Connecting-IP sin peer no se reenvía: nadie la respalda', () => {
    const forged = new Headers({ 'cf-connecting-ip': '1.2.3.4' });
    expect(clientOriginHeaders(forged, SECRET)['x-client-ip']).toBeUndefined();
  });

  it('basura en las cabeceras de IP no se reenvía', () => {
    const junk = new Headers({ 'x-edge-peer-ip': '1.2.3.4, 5.6.7.8', 'cf-connecting-ip': 'evil' });
    expect(clientOriginHeaders(junk, SECRET)['x-client-ip']).toBeUndefined();
  });

  it('user-agent recortado y sin caracteres raros', () => {
    const long = new Headers({ 'user-agent': `Agente ñ ${'a'.repeat(600)}` });
    const ua = clientOriginHeaders(long, SECRET)['x-client-user-agent'] ?? '';
    expect(ua.length).toBe(512);
    expect(ua).not.toContain('ñ');
  });

  it('sin secreto (o con uno corto) no manda nada', () => {
    expect(clientOriginHeaders(browser, undefined)).toEqual({});
    expect(clientOriginHeaders(browser, '')).toEqual({});
    expect(clientOriginHeaders(browser, 'corto')).toEqual({});
  });

  it('fuera de un request no manda nada', () => {
    expect(clientOriginHeaders(null, SECRET)).toEqual({});
  });
});

describe('sendsTrustedDevice: el token de 30 días sólo va a /auth/*', () => {
  it.each([
    ['/auth/trusted-devices', true],
    ['/auth/login', true],
    ['/me', false],
    ['/search/flights', false],
    ['/authors', false],
  ])('%s → %s', (path, expected) => {
    expect(sendsTrustedDevice(path)).toBe(expected);
  });
});

describe('api() y apiWithStatus(): cabeceras de cada llamado', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('INTERNAL_PROXY_SECRET', SECRET);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.incoming = new Headers({
      'x-edge-peer-ip': '203.0.113.7',
      'user-agent': 'Mozilla/5.0 Firefox/130',
    });
    mocks.session = 'tok';
    mocks.tenant = 't-1';
    mocks.trusted = 'equipo-123';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function sentHeaders(): Headers {
    const init = fetchMock.mock.calls[0]?.[1];
    return new Headers(init?.headers);
  }

  it('reenvía sesión, tenant, origen del usuario y, en /auth/*, el equipo de confianza', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await api('/auth/trusted-devices');
    const sent = sentHeaders();
    expect(sent.get('authorization')).toBe('Bearer tok');
    expect(sent.get('x-tenant-id')).toBe('t-1');
    expect(sent.get('x-internal-proxy')).toBe(SECRET);
    expect(sent.get('x-client-ip')).toBe('203.0.113.7');
    expect(sent.get('x-client-user-agent')).toBe('Mozilla/5.0 Firefox/130');
    expect(sent.get('x-trusted-device')).toBe('equipo-123');
  });

  it('fuera de /auth/* el equipo de confianza no viaja', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    await api('/me/memberships');
    expect(sentHeaders().get('x-trusted-device')).toBeNull();
  });

  it('las cabeceras del llamador se respetan (x-session-ping del ping pasivo)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await api('/auth/session', { headers: { 'x-session-ping': 'passive' } });
    expect(sentHeaders().get('x-session-ping')).toBe('passive');
  });

  it('fuera de un request (next/headers tira) sigue funcionando, sin origen', async () => {
    mocks.incoming = null;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await api('/me');
    expect(res.ok).toBe(true);
    expect(sentHeaders().get('x-internal-proxy')).toBeNull();
    expect(sentHeaders().get('x-client-ip')).toBeNull();
  });

  it('el error trae reason y details del cuerpo', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 403,
          message: 'Activá el 2FA.',
          reason: 'MFA_ENROLLMENT_REQUIRED',
        }),
        { status: 403, statusText: 'Forbidden' },
      ),
    );
    const res = await api('/orders');
    expect(res).toEqual({
      ok: false,
      error: { status: 403, message: 'Activá el 2FA.', reason: 'MFA_ENROLLMENT_REQUIRED' },
    });
  });

  it('apiWithStatus manda las mismas cabeceras', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    await apiWithStatus('/hotels/book', { method: 'POST', body: '{}' });
    const sent = sentHeaders();
    expect(sent.get('x-internal-proxy')).toBe(SECRET);
    expect(sent.get('x-client-ip')).toBe('203.0.113.7');
    expect(sent.get('x-trusted-device')).toBeNull();
  });
});

/**
 * La avería concreta: `ApiError.status` viaja sin mirar a 48 rutas de `app/api/`, que hacen
 * `NextResponse.json(cuerpo, { status })`. Ese `status` tiene que estar entre 200 y 599; con
 * cualquier otra cosa lanza `RangeError`, Next responde su página HTML de error, y el cliente
 * —que espera JSON— muere con «Unexpected token '<', "<!DOCTYPE "... is not valid JSON».
 *
 * Un fallo de conexión al API devolvía `status: 0`. O sea: el mensaje que veía el vendedor no se
 * parecía en nada a lo que había pasado, y apuntaba al sitio equivocado para depurarlo.
 */
describe('estadoHttpValido: ningún estado puede reventar NextResponse.json', () => {
  it('el 0 del fallo de conexión se convierte en 503, que es lo que de verdad pasó', () => {
    expect(estadoHttpValido(0)).toBe(SERVICIO_NO_DISPONIBLE);
    expect(SERVICIO_NO_DISPONIBLE).toBe(503);
  });

  it('los estados reales del API pasan intactos', () => {
    for (const status of [200, 201, 400, 401, 403, 404, 409, 422, 500, 502, 503, 599]) {
      expect(estadoHttpValido(status)).toBe(status);
    }
  });

  it('todo lo que está fuera del rango cae a 503 en vez de reventar la ruta', () => {
    for (const status of [-1, 0, 1, 100, 199, 600, 999, 1000]) {
      expect(estadoHttpValido(status)).toBe(SERVICIO_NO_DISPONIBLE);
    }
  });

  it('lo que ni siquiera es un entero tampoco se cuela', () => {
    for (const status of [Number.NaN, Number.POSITIVE_INFINITY, 200.5]) {
      expect(estadoHttpValido(status)).toBe(SERVICIO_NO_DISPONIBLE);
    }
  });
});

/**
 * `readApiResponse` es lo que usa la ruta de reserva de hotel (RF-22): tiene que dejar pasar el
 * estado y el cuerpo ENTEROS, porque ahí viajan el `202` de una reserva en curso, el precio nuevo
 * de un `409` y las marcas que prohíben repetirla.
 */
describe('readApiResponse: estado y cuerpo completos', () => {
  it('un 202 sigue siendo 202, con su cuerpo', async () => {
    const body = { orderId: 'o-1', status: 'pending', retryForbidden: true };
    const read = await readApiResponse(new Response(JSON.stringify(body), { status: 202 }));
    expect(read).toEqual({ kind: 'json', status: 202, body });
  });

  it('un error conserva todo su cuerpo, no sólo `message`', async () => {
    const body = {
      statusCode: 409,
      message: 'El precio subió.',
      reason: 'PRICE_INCREASED',
      details: { currentTotal: { amountMinor: 1, currency: 'USD' } },
      orderId: 'o-1',
      duplicateRequest: true,
    };
    const read = await readApiResponse(new Response(JSON.stringify(body), { status: 409 }));
    expect(read).toEqual({ kind: 'json', status: 409, body });
  });

  it('una página de un proxy no rompe: queda el estado y un mensaje que dice qué hacer', async () => {
    const read = await readApiResponse(
      new Response('<!DOCTYPE html><html>timeout</html>', { status: 524 }),
    );
    expect(read.kind).toBe('not-json');
    expect(read.status).toBe(524);
    if (read.kind === 'not-json') expect(read.message).toMatch(/NO la repitas/);
  });
});
