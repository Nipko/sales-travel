import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { grantableRoles, requiresMfa, teamActorOf } from '../../../../../lib/tenant-admin-team';
import { INVITABLE_ROLES, ROLE_CONFIG, invitableRolesIn } from './roles';

/**
 * ASSIGNABLE_ROLES del API (`apps/api/src/auth/roles.ts`), leído como texto: web-b2b no depende del
 * API. Un rol que el API asigna y Equipo no ofrece deja al superadmin sin poder darlo (pasó con el
 * de consolidador); uno que Equipo ofrece y el API no acepta es un botón que siempre falla.
 */
function apiAssignableRoles(): string[] {
  const path = fileURLToPath(
    new URL('../../../../../../../api/src/auth/roles.ts', import.meta.url),
  );
  const block = /export const ASSIGNABLE_ROLES = \[([^\]]*)\]/.exec(readFileSync(path, 'utf8'));
  return [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

const values = (roles: readonly { readonly value: string }[]) => roles.map((r) => r.value);

describe('INVITABLE_ROLES — espejo de ASSIGNABLE_ROLES del API', () => {
  it('ofrece exactamente los roles que el API asigna', () => {
    const api = apiAssignableRoles();
    // Si la lectura de la fuente se rompe, el test tiene que fallar y no comparar dos vacíos.
    expect(api).toEqual([
      'consolidator_admin',
      'tenant_admin',
      'agency_admin',
      'admin',
      'vendedor',
      'cliente_final',
    ]);
    expect(values(INVITABLE_ROLES).sort()).toEqual([...api].sort());
  });

  it('cada rol tiene su etiqueta en Equipo', () => {
    for (const { value } of INVITABLE_ROLES) expect(ROLE_CONFIG[value]).toBeDefined();
  });

  it('el texto avisa del 2FA justo en los roles que lo exigen', () => {
    for (const { value, hint } of INVITABLE_ROLES) {
      expect(hint.includes('verificación en dos pasos'), value).toBe(requiresMfa(value));
    }
  });
});

describe('el admin de consolidador', () => {
  const superadmin = teamActorOf('root', [{ role: 'superadmin', status: 'active' }]);

  it('lo da el superadmin; un admin de consolidador no da su propio rol', () => {
    const roles = invitableRolesIn('consolidator');
    expect(values(grantableRoles(roles, superadmin))).toContain('consolidator_admin');
    for (const role of ['consolidator_admin', 'tenant_admin', 'agency_admin']) {
      const actor = teamActorOf('me', [{ role, status: 'active' }]);
      expect(values(grantableRoles(roles, actor)), role).not.toContain('consolidator_admin');
    }
  });

  it('sólo se ofrece en un consolidador, no en la raíz ni en una agencia', () => {
    expect(values(invitableRolesIn('consolidator'))).toContain('consolidator_admin');
    for (const type of ['platform', 'agency', 'subagency', undefined]) {
      const roles = values(invitableRolesIn(type));
      expect(roles, String(type)).not.toContain('consolidator_admin');
      expect(roles).toHaveLength(INVITABLE_ROLES.length - 1);
    }
  });
});
