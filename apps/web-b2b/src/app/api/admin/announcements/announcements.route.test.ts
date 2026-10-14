import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel para los anuncios de la plataforma: publicar, corregir y archivar con la
 * cookie de quien las llama. Sólo reenvían lo que viene del propio panel, con el cuerpo rearmado; la
 * lista y la franja sólo leen.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn(), api: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus, api: mocks.api }));

import { GET as active } from '../../announcements/active/route';
import { POST as archive } from './[id]/archive/route';
import { PATCH as update } from './[id]/route';
import { GET as list, POST as create } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const ANUNCIO = {
  severity: 'warning',
  title: 'TBO en mantenimiento',
  body: 'Sábado de 02:00 a 04:00.',
  audience: { rootTenantId: null, adminsOnly: false },
  endsAt: '2026-10-18T09:00:00.000Z',
};

function request(
  method: 'POST' | 'PATCH',
  body?: unknown,
  headers: Record<string, string> = SAME_ORIGIN,
): Request {
  return new Request('https://app.test/api/admin/announcements/x', {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.api.mockReset();
  mocks.apiWithStatus.mockResolvedValue({ kind: 'json', status: 200, body: { id: ID } });
});

describe('sólo desde el panel', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se escribe nada: 403', async (site) => {
    const headers = { 'sec-fetch-site': site, 'content-type': 'application/json' };
    expect((await create(request('POST', ANUNCIO, headers))).status).toBe(403);
    expect((await update(request('PATCH', { title: 'Otro' }, headers), params())).status).toBe(403);
    expect((await archive(request('POST', undefined, headers), params())).status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('cada acción, con su cuerpo rearmado', () => {
  it('publicar: sólo los campos del anuncio', async () => {
    const res = await create(request('POST', { ...ANUNCIO, createdBy: 'otro' }));
    expect(res.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(ANUNCIO),
    });
  });

  it('un cuerpo sin forma no llega al API: 400', async () => {
    expect((await create(request('POST', { ...ANUNCIO, severity: 'urgent' }))).status).toBe(400);
    expect((await update(request('PATCH', { title: 'x' }), params('../tenants'))).status).toBe(400);
    expect((await archive(request('POST'), params('nada'))).status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('corregir y archivar van al anuncio, en minúsculas', async () => {
    await update(request('PATCH', { title: 'Otro', extra: true }), params(ID.toUpperCase()));
    expect(mocks.apiWithStatus).toHaveBeenCalledWith(`/admin/announcements/${ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Otro' }),
    });
    await archive(request('POST'), params());
    expect(mocks.apiWithStatus).toHaveBeenLastCalledWith(`/admin/announcements/${ID}/archive`, {
      method: 'POST',
    });
  });

  it('el error del API llega con su mensaje y su motivo, nunca el cuerpo crudo', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 409,
      body: {
        message: 'Ese anuncio ya está archivado.',
        reason: 'ANNOUNCEMENT_ARCHIVED',
        stack: 'x',
      },
    });
    const res = await archive(request('POST'), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Ese anuncio ya está archivado.',
      reason: 'ANNOUNCEMENT_ARCHIVED',
    });
  });
});

describe('las lecturas', () => {
  it('la lista del panel y la franja de avisos', async () => {
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 200,
      body: { announcements: [] },
    });
    expect(await (await list()).json()).toEqual({ announcements: [] });
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/announcements');

    mocks.api.mockResolvedValue({ ok: true, data: { announcements: [] } });
    expect(await (await active()).json()).toEqual({ announcements: [] });
    expect(mocks.api).toHaveBeenCalledWith('/announcements/active');

    mocks.api.mockResolvedValue({ ok: false, error: { status: 401, message: 'Sin sesión' } });
    expect((await active()).status).toBe(401);
  });
});
