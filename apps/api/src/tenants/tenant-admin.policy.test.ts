import { HttpStatus, type HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ASSIGNABLE_ROLES, highestRole, isAssignableRole, ROLE_RANK } from '../auth/roles.js';
import type { Role, TenantType } from '../database/database.types.js';
import {
  assertCanGrant,
  assertCanSupportMember,
  childTenantType,
  CREATABLE_TENANT_TYPES,
  derivedChildType,
  initialAdminRole,
  MemberNotFoundError,
  MemberOutsideNetworkError,
  MemberSelfActionError,
  RoleNotGrantableError,
  TenantParentRequiredError,
  TenantPlatformLockedError,
  TenantSlugTakenError,
  TenantSuperadminOnlyError,
  TenantTypeOpenBookingsError,
  type ChildTypeRequest,
  type CreatableTenantType,
} from './tenant-admin.policy.js';

/** `código HTTP/motivo` de lo que lanza `fn`, o `ok:<valor>` si no lanza. */
function outcome(fn: () => unknown): string {
  try {
    return `ok:${String(fn())}`;
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
}

function pedido(req: Partial<ChildTypeRequest> & { parentType: TenantType }): ChildTypeRequest {
  return { isBranch: false, superadmin: false, ...req };
}

describe('derivedChildType: D4 A', () => {
  it.each<[TenantType, string | undefined]>([
    ['platform', 'agency'],
    ['consolidator', 'agency'],
    ['agency', 'subagency'],
    ['subagency', undefined],
  ])('bajo %s nace %s', (parent, child) => {
    expect(derivedChildType(parent)).toBe(child);
  });
});

describe('childTenantType', () => {
  describe('sin pedir tipo, se deriva del padre', () => {
    it.each<[TenantType, boolean, string]>([
      ['platform', false, 'ok:agency'],
      ['platform', true, 'ok:agency'],
      ['consolidator', false, 'ok:agency'],
      ['consolidator', true, 'ok:agency'],
      ['agency', false, 'ok:subagency'],
      ['agency', true, 'ok:subagency'],
      ['subagency', false, '409/TENANT_PARENT_TYPE'],
      ['subagency', true, '409/TENANT_PARENT_TYPE'],
    ])('bajo %s (superadmin: %s) → %s', (parentType, superadmin, expected) => {
      expect(outcome(() => childTenantType(pedido({ parentType, superadmin })))).toBe(expected);
    });
  });

  it('un tipo pedido que coincide con el derivado se acepta; uno distinto es 409, no se corrige', () => {
    expect(
      outcome(() => childTenantType(pedido({ parentType: 'agency', requestedType: 'subagency' }))),
    ).toBe('ok:subagency');
    expect(
      outcome(() => childTenantType(pedido({ parentType: 'platform', requestedType: 'agency' }))),
    ).toBe('ok:agency');
    // Lo que manda hoy el modal de Mi Red bajo Planetour.
    expect(
      outcome(() =>
        childTenantType(pedido({ parentType: 'platform', requestedType: 'subagency' })),
      ),
    ).toBe('409/TENANT_PARENT_TYPE');
    expect(
      outcome(() => childTenantType(pedido({ parentType: 'agency', requestedType: 'agency' }))),
    ).toBe('409/TENANT_PARENT_TYPE');
  });

  describe('consolidador: sólo el superadmin, y sólo bajo la plataforma', () => {
    it.each<TenantType>(['platform', 'consolidator', 'agency', 'subagency'])(
      'un admin de red no lo crea ni bajo %s: 403',
      (parentType) => {
        expect(
          outcome(() => childTenantType(pedido({ parentType, requestedType: 'consolidator' }))),
        ).toBe('403/TENANT_SUPERADMIN_ONLY');
      },
    );

    it.each<[TenantType, string]>([
      ['platform', 'ok:consolidator'],
      ['consolidator', '409/TENANT_PARENT_TYPE'],
      ['agency', '409/TENANT_PARENT_TYPE'],
      ['subagency', '409/TENANT_PARENT_TYPE'],
    ])('el superadmin bajo %s → %s', (parentType, expected) => {
      expect(
        outcome(() =>
          childTenantType(pedido({ parentType, requestedType: 'consolidator', superadmin: true })),
        ),
      ).toBe(expected);
    });

    it('un consolidador no es sucursal', () => {
      expect(
        outcome(() =>
          childTenantType(
            pedido({
              parentType: 'platform',
              requestedType: 'consolidator',
              isBranch: true,
              superadmin: true,
            }),
          ),
        ),
      ).toBe('409/TENANT_BRANCH_TYPE');
    });
  });

  describe('sucursal: sólo el superadmin, agencia hija directa de la plataforma', () => {
    it('un admin de red no la crea: 403', () => {
      expect(
        outcome(() => childTenantType(pedido({ parentType: 'platform', isBranch: true }))),
      ).toBe('403/TENANT_SUPERADMIN_ONLY');
    });

    it.each<[TenantType, CreatableTenantType | undefined, string]>([
      ['platform', undefined, 'ok:agency'],
      ['platform', 'agency', 'ok:agency'],
      ['platform', 'subagency', '409/TENANT_BRANCH_TYPE'],
      ['consolidator', undefined, '409/TENANT_BRANCH_PARENT'],
      ['agency', undefined, '409/TENANT_BRANCH_PARENT'],
      ['subagency', undefined, '409/TENANT_BRANCH_PARENT'],
    ])('el superadmin bajo %s pidiendo %s → %s', (parentType, requestedType, expected) => {
      expect(
        outcome(() =>
          childTenantType(pedido({ parentType, requestedType, isBranch: true, superadmin: true })),
        ),
      ).toBe(expected);
    });
  });

  it('la plataforma no es un tipo creable', () => {
    expect(CREATABLE_TENANT_TYPES).not.toContain('platform');
  });
});

describe('initialAdminRole: nadie da un rol igual o superior al propio', () => {
  it.each<[CreatableTenantType, Role | undefined, Role | undefined]>([
    // El superadmin da el del tipo de nodo.
    ['consolidator', 'superadmin', 'consolidator_admin'],
    ['agency', 'superadmin', 'tenant_admin'],
    ['subagency', 'superadmin', 'tenant_admin'],
    // El admin de Planetour en producción (consolidator_admin) crea agencias con tenant_admin.
    ['agency', 'consolidator_admin', 'tenant_admin'],
    ['subagency', 'consolidator_admin', 'tenant_admin'],
    // Un consolidator_admin no crea otro consolidator_admin.
    ['consolidator', 'consolidator_admin', 'tenant_admin'],
    // El tenant_admin de una agencia le da agency_admin al de su sub-agencia.
    ['subagency', 'tenant_admin', 'agency_admin'],
    ['subagency', 'agency_admin', 'admin'],
    // Un `admin` no puede dar ningún rol de admin.
    ['subagency', 'admin', undefined],
    ['agency', 'vendedor', undefined],
    ['agency', undefined, undefined],
  ])('nodo %s creado por %s → admin %s', (type, actor, expected) => {
    expect(initialAdminRole(type, actor)).toBe(expected);
  });

  it('el rol que da siempre está estrictamente por debajo del actor', () => {
    for (const type of CREATABLE_TENANT_TYPES) {
      for (const actor of Object.keys(ROLE_RANK) as Role[]) {
        const role = initialAdminRole(type, actor);
        if (role !== undefined) expect(ROLE_RANK[role]).toBeLessThan(ROLE_RANK[actor]);
      }
    }
  });
});

describe('assertCanGrant', () => {
  it('estrictamente por encima pasa; igual o superior es 403 con motivo', () => {
    expect(outcome(() => assertCanGrant('tenant_admin', 'admin'))).toBe('ok:undefined');
    expect(outcome(() => assertCanGrant('admin', 'admin'))).toBe('403/ROLE_NOT_GRANTABLE');
    expect(outcome(() => assertCanGrant('admin', 'consolidator_admin'))).toBe(
      '403/ROLE_NOT_GRANTABLE',
    );
  });
});

describe('errores con motivo máquina', () => {
  it.each<[HttpException & { reason: string }, HttpStatus, string]>([
    [new TenantSuperadminOnlyError(), HttpStatus.FORBIDDEN, 'TENANT_SUPERADMIN_ONLY'],
    [new TenantParentRequiredError(), HttpStatus.BAD_REQUEST, 'TENANT_PARENT_REQUIRED'],
    [new TenantPlatformLockedError(), HttpStatus.CONFLICT, 'TENANT_PLATFORM_LOCKED'],
    [new TenantSlugTakenError(), HttpStatus.CONFLICT, 'TENANT_SLUG_TAKEN'],
    [new TenantTypeOpenBookingsError(), HttpStatus.CONFLICT, 'TENANT_TYPE_OPEN_BOOKINGS'],
    [new RoleNotGrantableError(), HttpStatus.FORBIDDEN, 'ROLE_NOT_GRANTABLE'],
    [new MemberSelfActionError(), HttpStatus.FORBIDDEN, 'MEMBER_SELF_ACTION'],
    [new MemberNotFoundError(), HttpStatus.NOT_FOUND, 'MEMBER_NOT_FOUND'],
    [new MemberOutsideNetworkError(), HttpStatus.FORBIDDEN, 'MEMBER_OUTSIDE_NETWORK'],
  ])('%s', (err, status, reason) => {
    expect(err.getStatus()).toBe(status);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe('roles (D7 B)', () => {
  it('platform_admin y superadmin no son asignables', () => {
    expect(isAssignableRole('platform_admin')).toBe(false);
    expect(isAssignableRole('superadmin')).toBe(false);
    for (const role of ASSIGNABLE_ROLES) expect(isAssignableRole(role)).toBe(true);
  });

  it('highestRole elige el de más rango, sin importar el orden', () => {
    expect(highestRole([])).toBeUndefined();
    expect(highestRole(['admin', 'consolidator_admin', 'tenant_admin'])).toBe('consolidator_admin');
    expect(highestRole(['vendedor', 'superadmin', 'admin'])).toBe('superadmin');
  });
});

describe('assertCanSupportMember: restablecer el 2FA o cerrar las sesiones de un miembro', () => {
  const ACTOR = 'actor';
  const TARGET = 'objetivo';
  const AGENCIA = 'agencia';
  const SUB = 'sub-agencia';
  const OTRA_RED = 'otra-red';

  function pedido(
    memberships: Array<[string, Role]>,
    actorRoles: Array<[string, Role]>,
    extra: { superadmin?: boolean; target?: string } = {},
  ): () => void {
    return () =>
      assertCanSupportMember({
        actorUserId: ACTOR,
        targetUserId: extra.target ?? TARGET,
        actorIsSuperadmin: extra.superadmin ?? false,
        targetMemberships: memberships.map(([tenantId, role]) => ({ tenantId, role })),
        actorRoles: new Map(actorRoles),
      });
  }

  it('administra el único nodo del objetivo y lo supera en rango: pasa', () => {
    expect(outcome(pedido([[AGENCIA, 'vendedor']], [[AGENCIA, 'tenant_admin']]))).toBe(
      'ok:undefined',
    );
    expect(outcome(pedido([[AGENCIA, 'admin']], [[AGENCIA, 'agency_admin']]))).toBe('ok:undefined');
  });

  it('varios nodos, todos administrados y superado en cada uno: pasa', () => {
    expect(
      outcome(
        pedido(
          [
            [AGENCIA, 'vendedor'],
            [SUB, 'agency_admin'],
          ],
          [
            [AGENCIA, 'tenant_admin'],
            [SUB, 'tenant_admin'],
          ],
        ),
      ),
    ).toBe('ok:undefined');
  });

  it('nunca sobre uno mismo, ni siendo superadmin', () => {
    expect(
      outcome(pedido([[AGENCIA, 'vendedor']], [[AGENCIA, 'tenant_admin']], { target: ACTOR })),
    ).toBe('403/MEMBER_SELF_ACTION');
    expect(
      outcome(
        pedido([[AGENCIA, 'vendedor']], [[AGENCIA, 'superadmin']], {
          target: ACTOR,
          superadmin: true,
        }),
      ),
    ).toBe('403/MEMBER_SELF_ACTION');
  });

  it('si el objetivo también trabaja en otra red que el actor no administra: 403', () => {
    expect(
      outcome(
        pedido(
          [
            [AGENCIA, 'vendedor'],
            [OTRA_RED, 'vendedor'],
          ],
          [[AGENCIA, 'consolidator_admin']],
        ),
      ),
    ).toBe('403/MEMBER_OUTSIDE_NETWORK');
  });

  it('fuera de la red pesa más que el rango: el motivo dice qué falta', () => {
    expect(
      outcome(
        pedido(
          [
            [AGENCIA, 'tenant_admin'],
            [OTRA_RED, 'vendedor'],
          ],
          [[AGENCIA, 'tenant_admin']],
        ),
      ),
    ).toBe('403/MEMBER_OUTSIDE_NETWORK');
  });

  it.each<[Role, Role]>([
    ['tenant_admin', 'tenant_admin'],
    ['admin', 'tenant_admin'],
    ['agency_admin', 'consolidator_admin'],
    ['consolidator_admin', 'superadmin'],
  ])('un %s no puede sobre un %s (rango igual o superior): 403', (actor, target) => {
    expect(outcome(pedido([[AGENCIA, target]], [[AGENCIA, actor]]))).toBe('403/ROLE_NOT_GRANTABLE');
  });

  it('basta con que en UNO de sus nodos no lo supere', () => {
    expect(
      outcome(
        pedido(
          [
            [AGENCIA, 'vendedor'],
            [SUB, 'tenant_admin'],
          ],
          [
            [AGENCIA, 'tenant_admin'],
            [SUB, 'tenant_admin'],
          ],
        ),
      ),
    ).toBe('403/ROLE_NOT_GRANTABLE');
  });

  it('el superadmin puede sobre cualquiera, en cualquier red y de cualquier rango', () => {
    expect(
      outcome(
        pedido(
          [
            [AGENCIA, 'consolidator_admin'],
            [OTRA_RED, 'superadmin'],
          ],
          [],
          { superadmin: true },
        ),
      ),
    ).toBe('ok:undefined');
  });

  it('sin memberships que lo aten al actor, se falla cerrado', () => {
    expect(outcome(pedido([], [[AGENCIA, 'tenant_admin']]))).toBe('404/MEMBER_NOT_FOUND');
    expect(outcome(pedido([], [], { superadmin: true }))).toBe('404/MEMBER_NOT_FOUND');
  });
});
