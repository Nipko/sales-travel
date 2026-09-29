import { describe, expect, it } from 'vitest';
import { parseAdminNodes, parseCreatedNode, tenantAdminErrorMessage } from './tenant-admin-client';

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
      'Tu sesión venció. Volvé a iniciar sesión.',
    );
    expect(tenantAdminErrorMessage(500, '', 'read')).toBe(
      'No se pudo cargar la red. Probá de nuevo.',
    );
    expect(tenantAdminErrorMessage(500, undefined, 'write')).toBe(
      'No se pudo guardar el cambio. Probá de nuevo.',
    );
  });
});
