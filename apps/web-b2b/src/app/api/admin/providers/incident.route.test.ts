import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel para las palancas de un incidente: el apagado de emergencia de un proveedor,
 * levantarlo y cerrar su circuito. Cortan un proveedor para toda la plataforma con la cookie de
 * quien las llama: sólo reenvían lo que viene del propio panel, con el cuerpo rearmado.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn(), api: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus, api: mocks.api }));

import { POST as reset } from './[code]/circuit/reset/route';
import { POST as clear } from './[code]/kill-switch/clear/route';
import { PUT as kill } from './[code]/kill-switch/route';
import { GET as health } from './health/route';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const APAGAR = { level: 'sales', reason: 'TBO cobra de más', expiresInMinutes: 60 };

function request(
  method: 'PUT' | 'POST',
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN,
): Request {
  return new Request('https://app.test/api/admin/providers/tbo-hotels/x', {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function params(code = 'tbo-hotels') {
  return { params: Promise.resolve({ code }) };
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.api.mockReset();
  mocks.apiWithStatus.mockResolvedValue({
    kind: 'json',
    status: 200,
    body: { code: 'tbo-hotels' },
  });
});

describe('sólo desde el panel', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se reenvía nada: 403', async (site) => {
    const headers = { 'sec-fetch-site': site, 'content-type': 'application/json' };
    expect((await kill(request('PUT', APAGAR, headers), params())).status).toBe(403);
    expect((await clear(request('POST', {}, headers), params())).status).toBe(403);
    expect(
      (await reset(request('POST', { reason: 'Sabre volvió' }, headers), params('sabre'))).status,
    ).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('cada palanca, con su cuerpo rearmado', () => {
  it('apagar: PUT con nivel, motivo y vencimiento, nada más', async () => {
    const res = await kill(request('PUT', { ...APAGAR, setBy: 'otro' }), params());

    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/providers/tbo-hotels/kill-switch', {
      method: 'PUT',
      body: JSON.stringify(APAGAR),
    });
  });

  it('levantar sin cuerpo: motivo nulo', async () => {
    await clear(
      new Request('https://app.test/x', { method: 'POST', headers: SAME_ORIGIN }),
      params(),
    );
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      '/admin/providers/tbo-hotels/kill-switch/clear',
      { method: 'POST', body: JSON.stringify({ reason: null }) },
    );
  });

  it('cerrar el circuito: POST con el motivo', async () => {
    await reset(request('POST', { reason: ' Sabre volvió ' }), params('sabre'));
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/providers/sabre/circuit/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Sabre volvió' }),
    });
  });

  it('un cuerpo inválido o un código raro es 400 sin llamar al API', async () => {
    expect((await kill(request('PUT', { level: 'all' }), params())).status).toBe(400);
    expect((await kill(request('PUT', 'no es json'), params())).status).toBe(400);
    expect((await reset(request('POST', {}), params('sabre'))).status).toBe(400);
    expect((await clear(request('POST', {}), params('../global'))).status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('el 409 del apagado por variable llega con su motivo y su mensaje', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 409,
      body: {
        statusCode: 409,
        message: 'Este apagado viene de la variable PROVIDERS_DISABLED: se quita desplegando.',
        reason: 'KILL_SWITCH_FROM_ENV',
      },
    });

    const res = await clear(request('POST', {}), params());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Este apagado viene de la variable PROVIDERS_DISABLED: se quita desplegando.',
      reason: 'KILL_SWITCH_FROM_ENV',
    });
  });
});

describe('la salud', () => {
  it('lee /admin/providers/health', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: [] });
    const res = await health();
    expect(res.status).toBe(200);
    expect(mocks.api).toHaveBeenCalledWith('/admin/providers/health');
  });
});
