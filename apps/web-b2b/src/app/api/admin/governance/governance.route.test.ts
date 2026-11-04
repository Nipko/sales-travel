import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Las rutas del panel de gobierno: deciden qué se vende y qué se cobra en toda la plataforma con
 * la cookie de quien las llama. Sólo reenvían lo que viene del propio panel, con el cuerpo rearmado.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn(), api: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus, api: mocks.api }));

import { POST as archive } from './profiles/[id]/archive/route';
import { PUT as updateProfile } from './profiles/[id]/route';
import { GET as listProfiles, POST as createProfile } from './profiles/route';
import { PUT as setRule } from './rules/route';
import { PUT as assign } from './tenants/[tenantId]/profile/route';
import { GET as tenantView } from './tenants/[tenantId]/route';

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const NODO = '10000000-0000-4000-8000-000000000002';
const PERFIL = '20000000-0000-4000-8000-000000000001';

function request(
  method: 'PUT' | 'POST' | 'GET',
  body?: unknown,
  headers: Record<string, string> = SAME_ORIGIN,
): Request {
  return new Request('https://app.test/api/admin/governance/x', {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function tenantParams(tenantId: string) {
  return { params: Promise.resolve({ tenantId }) };
}

beforeEach(() => {
  mocks.apiWithStatus.mockReset();
  mocks.apiWithStatus.mockResolvedValue({ kind: 'json', status: 200, body: {} });
});

describe('sólo desde el panel', () => {
  it.each(['same-site', 'cross-site'])('desde %s no se reenvía nada: 403', async (site) => {
    const headers = { 'sec-fetch-site': site, 'content-type': 'application/json' };
    const rule = { tenantId: null, provider: 'sabre', method: '', enabled: true };
    expect((await setRule(request('PUT', rule, headers))).status).toBe(403);
    expect(
      (await createProfile(request('POST', { name: 'Solo hoteles', items: [] }, headers))).status,
    ).toBe(403);
    expect((await archive(request('POST', undefined, headers), idParams(PERFIL))).status).toBe(403);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });
});

describe('reenvío', () => {
  it('lecturas: perfiles y la vista de un nodo', async () => {
    await listProfiles();
    await tenantView(request('GET'), tenantParams(NODO));
    expect(mocks.apiWithStatus).toHaveBeenNthCalledWith(1, '/admin/governance/profiles');
    expect(mocks.apiWithStatus).toHaveBeenNthCalledWith(2, `/admin/governance/tenants/${NODO}`);
  });

  it('un id raro se frena con 400 sin llamar al API', async () => {
    const res = await updateProfile(request('PUT', { items: [] }), idParams('..%2Fusers'));
    expect(res.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
  });

  it('la regla viaja rearmada', async () => {
    await setRule(
      request('PUT', {
        tenantId: NODO,
        provider: 'latam-ndc',
        method: 'payment_link',
        enabled: true,
        reason: 'Piloto',
        actor: 'otro',
      }),
    );
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/governance/rules', {
      method: 'PUT',
      body: JSON.stringify({
        tenantId: NODO,
        provider: 'latam-ndc',
        method: 'payment_link',
        enabled: true,
        reason: 'Piloto',
      }),
    });
  });

  it('asignar perfil y archivar', async () => {
    await assign(request('PUT', { profileId: PERFIL }), tenantParams(NODO));
    await archive(request('POST'), idParams(PERFIL));
    expect(mocks.apiWithStatus).toHaveBeenNthCalledWith(
      1,
      `/admin/governance/tenants/${NODO}/profile`,
      { method: 'PUT', body: JSON.stringify({ profileId: PERFIL }) },
    );
    expect(mocks.apiWithStatus).toHaveBeenNthCalledWith(
      2,
      `/admin/governance/profiles/${PERFIL}/archive`,
      { method: 'POST' },
    );
  });

  it('el 409 del API llega con su mensaje', async () => {
    const message = 'El perfil está asignado a 2 nodo(s). Reasígnalos antes de archivarlo.';
    mocks.apiWithStatus.mockResolvedValue({ kind: 'json', status: 409, body: { message } });
    const res = await archive(request('POST'), idParams(PERFIL));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message });
  });
});
