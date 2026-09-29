import { describe, expect, it } from 'vitest';
import { tenantMovePlan, tenantUpdatePlan } from './tenant-admin-proxy';

const ID = '0B6F6A52-7A47-4C8E-9A3B-1A2B3C4D5E6F';
const PARENT = '11111111-2222-4333-8444-555555555555';

describe('tenantUpdatePlan: PATCH /admin/tenants/:id', () => {
  it('reconstruye el cuerpo campo por campo, con el id en minúsculas', () => {
    expect(tenantUpdatePlan(ID, { status: 'suspended', extra: 'x' })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}`,
      body: { status: 'suspended' },
    });
    expect(tenantUpdatePlan(ID, { isBranch: true })).toMatchObject({ body: { isBranch: true } });
    expect(tenantUpdatePlan(ID, { tenantType: 'agency' })).toMatchObject({
      body: { tenantType: 'agency' },
    });
  });

  it('un id que no es UUID no compone otra ruta del API', () => {
    expect(tenantUpdatePlan('../users/status', { status: 'active' })).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });

  it('rechaza valores fuera de lo que admite el API', () => {
    expect(tenantUpdatePlan(ID, { status: 'archived' }).ok).toBe(false);
    expect(tenantUpdatePlan(ID, { isBranch: 'true' }).ok).toBe(false);
    expect(tenantUpdatePlan(ID, { tenantType: 'platform' }).ok).toBe(false);
  });

  it('sin nada que cambiar, o sin cuerpo, no viaja', () => {
    expect(tenantUpdatePlan(ID, {}).ok).toBe(false);
    expect(tenantUpdatePlan(ID, undefined).ok).toBe(false);
    expect(tenantUpdatePlan(ID, [{ status: 'active' }]).ok).toBe(false);
  });
});

describe('tenantMovePlan: POST /admin/tenants/:id/move', () => {
  it('manda sólo el nuevo padre', () => {
    expect(tenantMovePlan(ID, { parentTenantId: PARENT.toUpperCase(), tenantType: 'x' })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}/move`,
      body: { parentTenantId: PARENT },
    });
  });

  it('sin padre válido no se mueve nada', () => {
    expect(tenantMovePlan(ID, {}).ok).toBe(false);
    expect(tenantMovePlan(ID, { parentTenantId: 'planetour' }).ok).toBe(false);
    expect(tenantMovePlan('x', { parentTenantId: PARENT }).ok).toBe(false);
  });
});
