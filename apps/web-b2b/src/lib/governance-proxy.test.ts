import { describe, expect, it } from 'vitest';
import {
  archiveProfileTarget,
  assignProfilePlan,
  createProfilePlan,
  duplicateProfilePlan,
  setDefaultProfilePlan,
  setRulePlan,
  tenantGovernanceTarget,
  updateProfilePlan,
} from './governance-proxy';

/*
 * El borde del proxy del gobierno: un id o un código mal formado no compone otra ruta del API, y el
 * cuerpo llega rearmado campo por campo.
 */

const NODO = '10000000-0000-4000-8000-000000000002';
const PERFIL = '20000000-0000-4000-8000-000000000001';

describe('rutas con id', () => {
  it('normaliza el uuid y rechaza lo que no lo es', () => {
    expect(tenantGovernanceTarget(NODO.toUpperCase())).toEqual({
      ok: true,
      path: `/admin/governance/tenants/${NODO}`,
    });
    expect(tenantGovernanceTarget('../providers').ok).toBe(false);
    expect(archiveProfileTarget('x%2F..').ok).toBe(false);
    expect(archiveProfileTarget(PERFIL)).toEqual({
      ok: true,
      path: `/admin/governance/profiles/${PERFIL}/archive`,
    });
  });
});

describe('createProfilePlan', () => {
  it('rearma nombre, descripción y matriz; descarta lo demás', () => {
    const plan = createProfilePlan({
      name: '  Solo hoteles ',
      description: '   ',
      items: [{ provider: 'tbo-hotels', method: '', enabled: true, sneaky: 1 }],
      isDefaultForNewNodes: true,
    });
    expect(plan).toEqual({
      ok: true,
      path: '/admin/governance/profiles',
      body: {
        name: 'Solo hoteles',
        description: null,
        items: [{ provider: 'tbo-hotels', method: '', enabled: true }],
      },
    });
  });

  it('frena un nombre corto o una matriz rota', () => {
    expect(createProfilePlan({ name: 'a', items: [] }).ok).toBe(false);
    expect(
      createProfilePlan({ name: 'Solo hoteles', items: [{ provider: 'tbo-hotels' }] }).ok,
    ).toBe(false);
    expect(createProfilePlan({ name: 'Solo hoteles' }).ok).toBe(false);
  });
});

describe('updateProfilePlan', () => {
  it('sólo manda lo que viene', () => {
    expect(updateProfilePlan(PERFIL, { items: [] })).toEqual({
      ok: true,
      path: `/admin/governance/profiles/${PERFIL}`,
      body: { items: [] },
    });
  });

  it('un cambio vacío no viaja', () => {
    expect(updateProfilePlan(PERFIL, { archived: true }).ok).toBe(false);
  });
});

describe('acciones sobre un perfil', () => {
  it('duplicar exige nombre; predeterminado, un booleano', () => {
    expect(duplicateProfilePlan(PERFIL, { name: 'Copia' })).toMatchObject({
      ok: true,
      body: { name: 'Copia' },
    });
    expect(duplicateProfilePlan(PERFIL, {}).ok).toBe(false);
    expect(setDefaultProfilePlan(PERFIL, { isDefault: 'true' }).ok).toBe(false);
    expect(setDefaultProfilePlan(PERFIL, { isDefault: false })).toMatchObject({
      ok: true,
      path: `/admin/governance/profiles/${PERFIL}/default`,
      body: { isDefault: false },
    });
  });

  it('asignar acepta un perfil o null (heredar)', () => {
    expect(assignProfilePlan(NODO, { profileId: null })).toMatchObject({
      ok: true,
      body: { profileId: null },
    });
    expect(assignProfilePlan(NODO, { profileId: PERFIL.toUpperCase() })).toMatchObject({
      body: { profileId: PERFIL },
    });
    expect(assignProfilePlan(NODO, {}).ok).toBe(false);
    expect(assignProfilePlan(NODO, { profileId: 'ninguno' }).ok).toBe(false);
  });
});

describe('setRulePlan', () => {
  it('una regla global con motivo', () => {
    expect(
      setRulePlan({
        tenantId: null,
        provider: 'latam-ndc',
        method: 'card',
        enabled: false,
        reason: ' Fuera de SAQ-A ',
      }),
    ).toEqual({
      ok: true,
      path: '/admin/governance/rules',
      body: {
        tenantId: null,
        provider: 'latam-ndc',
        method: 'card',
        enabled: false,
        reason: 'Fuera de SAQ-A',
      },
    });
  });

  it('quitar una regla de un nodo no lleva motivo', () => {
    expect(
      setRulePlan({ tenantId: NODO, provider: 'sabre', enabled: null, reason: 'x' }),
    ).toMatchObject({
      ok: true,
      body: { tenantId: NODO, provider: 'sabre', method: '', enabled: null },
    });
  });

  it('el alcance tiene que ser explícito y los códigos, válidos', () => {
    expect(setRulePlan({ provider: 'sabre', enabled: true }).ok).toBe(false);
    expect(setRulePlan({ tenantId: null, provider: 'Sabre', enabled: true }).ok).toBe(false);
    expect(
      setRulePlan({ tenantId: null, provider: 'sabre', method: 'on-account', enabled: true }).ok,
    ).toBe(false);
    expect(setRulePlan({ tenantId: null, provider: 'sabre', enabled: 'yes' }).ok).toBe(false);
    expect(
      setRulePlan({ tenantId: null, provider: 'sabre', enabled: true, reason: 'x'.repeat(501) }).ok,
    ).toBe(false);
  });
});
