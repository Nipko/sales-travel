import { afterEach, describe, expect, it, vi } from 'vitest';
import { busySummaryPayload, NODE_NORTE } from './platform-node-summary.fixture';
import {
  loadNodeImpact,
  loadNodeStats,
  loadNodeSummary,
  parseAdminNodes,
  parseCreatedNode,
  tenantAdminErrorMessage,
  updateNode,
} from './tenant-admin-client';

const PLANETOUR = {
  id: 'AAAAAAAA-0000-4000-8000-000000000001',
  slug: 'platform',
  name: 'Planetour S.A.S',
  tenantType: 'platform',
  isBranch: false,
  parentTenantId: null,
  status: 'active',
  depth: 1,
  parentName: null,
  countryCode: 'CO',
  defaultCurrency: 'COP',
  userCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('parseAdminNodes: GET /admin/tenants', () => {
  it('lee los nodos con tipo, sucursal, padre y profundidad; ids en minúsculas', () => {
    const branch = {
      ...PLANETOUR,
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      slug: 'planetour-bogota',
      name: 'Planetour Bogotá',
      tenantType: 'agency',
      isBranch: true,
      parentTenantId: PLANETOUR.id,
      depth: 2,
      parentName: 'Planetour S.A.S',
    };
    const nodes = parseAdminNodes({ tenants: [PLANETOUR, branch] });
    expect(nodes).toHaveLength(2);
    expect(nodes?.[0]?.id).toBe(PLANETOUR.id.toLowerCase());
    expect(nodes?.[1]).toMatchObject({
      isBranch: true,
      parentTenantId: PLANETOUR.id.toLowerCase(),
      parentName: 'Planetour S.A.S',
      depth: 2,
    });
  });

  it('descarta nodos incompletos o de un tipo que el panel no conoce', () => {
    const nodes = parseAdminNodes({
      tenants: [PLANETOUR, { ...PLANETOUR, id: 'x', tenantType: 'reseller' }, { id: 'y' }],
    });
    expect(nodes?.map((n) => n.slug)).toEqual(['platform']);
  });

  it('un API anterior sin isBranch se lee como no sucursal', () => {
    const { isBranch: _omit, ...legacy } = PLANETOUR;
    expect(parseAdminNodes({ tenants: [legacy] })?.[0]?.isBranch).toBe(false);
  });

  it('una forma inesperada no es una red vacía: es un error', () => {
    expect(parseAdminNodes({})).toBeUndefined();
    expect(parseAdminNodes(null)).toBeUndefined();
  });
});

describe('parseCreatedNode: POST /admin/tenants', () => {
  const tenant = { ...PLANETOUR, tenantType: 'agency', parentTenantId: PLANETOUR.id, depth: 2 };

  it('con el resultado del admin inicial', () => {
    expect(
      parseCreatedNode({
        tenant,
        admin: { email: 'a@b.co', role: 'tenant_admin', status: 'invited' },
      }),
    ).toMatchObject({
      tenant: { tenantType: 'agency' },
      admin: { email: 'a@b.co', status: 'invited' },
    });
  });

  it('invitado sin correo: la invitación existe (con su vencimiento) pero el correo no salió', () => {
    expect(
      parseCreatedNode({
        tenant,
        admin: {
          email: 'a@b.co',
          role: 'tenant_admin',
          status: 'invited_email_failed',
          invitationId: 'inv',
          expiresAt: '2026-10-18T15:00:00.000Z',
        },
      })?.admin,
    ).toEqual({
      email: 'a@b.co',
      status: 'invited_email_failed',
      expiresAt: '2026-10-18T15:00:00.000Z',
    });
  });

  it('la invitación que no se creó no trae vencimiento; un estado desconocido se ignora', () => {
    expect(
      parseCreatedNode({
        tenant,
        admin: { email: 'a@b.co', status: 'invite_failed', expiresAt: '2026-10-18T15:00:00.000Z' },
      })?.admin,
    ).toEqual({ email: 'a@b.co', status: 'invite_failed' });
    expect(parseCreatedNode({ tenant, admin: { email: 'a@b.co', status: 'linked' } })).toEqual({
      tenant: expect.any(Object),
    });
  });

  it('sin admin', () => {
    expect(parseCreatedNode({ tenant })).toEqual({ tenant: expect.any(Object) });
  });

  it('sin nodo, no se leyó', () => {
    expect(parseCreatedNode({ admin: {} })).toBeUndefined();
  });
});

describe('tenantAdminErrorMessage', () => {
  it('el mensaje del API, que ya viene en castellano, se muestra tal cual', () => {
    expect(
      tenantAdminErrorMessage(409, 'Una sucursal cuelga directamente de la plataforma.', 'write'),
    ).toBe('Una sucursal cuelga directamente de la plataforma.');
  });

  it('el 403 en inglés del guard de superadmin se dice en castellano', () => {
    expect(tenantAdminErrorMessage(403, 'superadmin access required', 'write')).toBe(
      'Sólo el superadmin de la plataforma puede armar y corregir la red.',
    );
  });

  it('sesión vencida y errores sin texto', () => {
    expect(tenantAdminErrorMessage(401, 'x', 'read')).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(tenantAdminErrorMessage(500, '', 'read')).toBe(
      'No se pudo cargar la red. Inténtalo de nuevo.',
    );
    expect(tenantAdminErrorMessage(500, undefined, 'write')).toBe(
      'No se pudo guardar el cambio. Inténtalo de nuevo.',
    );
  });
});

const NODE = 'cccccccc-0000-4000-8000-000000000003';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockFetch(res: Response) {
  const fn = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(res));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('Agencias: suspender con motivo y los números de cada nodo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updateNode manda el motivo con la suspensión', async () => {
    const tenant = { ...PLANETOUR, id: NODE, tenantType: 'agency', status: 'suspended' };
    const fetch = mockFetch(reply(200, { tenant }));
    const res = await updateNode(NODE, { status: 'suspended', reason: 'Deuda vencida' });
    expect(res).toMatchObject({ ok: true, data: { id: NODE, status: 'suspended' } });
    expect(fetch).toHaveBeenCalledWith(`/api/admin/tenants/${NODE}`, {
      cache: 'no-store',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Deuda vencida' }),
    });
  });

  it('el 400 del API (sin motivo) sale con su texto', async () => {
    mockFetch(reply(400, { error: 'Indica el motivo de la suspensión.' }));
    expect(await updateNode(NODE, { status: 'suspended', reason: '' })).toEqual({
      ok: false,
      message: 'Indica el motivo de la suspensión.',
    });
  });

  it('loadNodeStats lee los números por nodo', async () => {
    const fetch = mockFetch(
      reply(200, {
        nodes: [
          {
            tenantId: NODE,
            seatLimit: 5,
            seatsUsed: 5,
            liveSessions: 5,
            activeUsers: 6,
            orders30d: 0,
            sales30d: 0,
            lastOrderAt: null,
            openOrders: 0,
            pendingDepositReports: 2,
            pendingInvitations: 0,
            held: [],
          },
        ],
      }),
    );
    const res = await loadNodeStats();
    expect(fetch).toHaveBeenCalledWith('/api/admin/tenants/stats', { cache: 'no-store' });
    expect(res.ok && res.data.get(NODE)).toMatchObject({ seatsUsed: 5, pendingDepositReports: 2 });
  });

  it('loadNodeImpact pide el impacto del nodo; un 403 dice que es del superadmin', async () => {
    const fetch = mockFetch(reply(403, { error: '' }));
    expect(await loadNodeImpact(NODE)).toEqual({
      ok: false,
      message: 'Sólo el superadmin de la plataforma puede armar y corregir la red.',
    });
    expect(fetch).toHaveBeenCalledWith(`/api/admin/tenants/${NODE}/impact`, {
      cache: 'no-store',
    });
  });

  it('loadNodeSummary pide la pestaña Resumen del nodo y la lee; sin el nodo, no se puede leer', async () => {
    const fetch = mockFetch(reply(200, busySummaryPayload()));
    const res = await loadNodeSummary(NODE_NORTE);
    expect(fetch).toHaveBeenCalledWith(`/api/admin/tenants/${NODE_NORTE}/summary`, {
      cache: 'no-store',
    });
    expect(res.ok && res.data.tenant.name).toBe('Consolidador Norte');

    mockFetch(reply(200, { own: null }));
    expect(await loadNodeSummary(NODE_NORTE)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no pudimos leer/),
    });
  });
});
