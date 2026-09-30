import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ACTOR,
  MFA_REQUIRED_ROLES,
  canActOn,
  demotes,
  grantableRoles,
  invitationOrigin,
  memberAccess,
  memberActionCopy,
  memberActionDoneMessage,
  memberActionError,
  memberStatus,
  mfaState,
  parseInvitations,
  parseMemberActionResult,
  parseMembers,
  parseMembershipImpact,
  revokedInvitationsNotice,
  roleChangeCopy,
  statusChangeCopy,
  teamActorOf,
  teamLoadError,
  type NetworkMember,
} from './tenant-admin-team';

const RAW = {
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'ana@agencia.co',
  name: 'Ana Pérez',
  userStatus: 'active',
  role: 'vendedor',
  membershipStatus: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-09-29T12:00:00.000Z',
  mfaEnabled: false,
  lockedUntil: null,
  activeSessions: 1,
};

function member(patch: Partial<NetworkMember> = {}): NetworkMember {
  const parsed = parseMembers({ users: [RAW] })?.[0];
  if (parsed === undefined) throw new Error('fixture inválida');
  return { ...parsed, ...patch };
}

describe('parseMembers: GET /tenants/network/users', () => {
  it('lee los campos nuevos del API', () => {
    expect(parseMembers({ users: [RAW] })).toEqual([RAW]);
  });

  it('un API anterior sin los campos nuevos: "no lo dice", no "nunca"', () => {
    const { lastLoginAt: _a, mfaEnabled: _b, lockedUntil: _c, activeSessions: _d, ...legacy } = RAW;
    const parsed = parseMembers({ users: [legacy] })?.[0];
    expect(parsed).toMatchObject({
      lastLoginAt: undefined,
      mfaEnabled: undefined,
      lockedUntil: undefined,
      activeSessions: undefined,
    });
  });

  it('lastLoginAt null es "nunca ingresó"', () => {
    expect(parseMembers({ users: [{ ...RAW, lastLoginAt: null }] })?.[0]?.lastLoginAt).toBeNull();
  });

  it('una forma inesperada es un error, no un equipo vacío', () => {
    expect(parseMembers({})).toBeUndefined();
    expect(parseMembers([])).toBeUndefined();
    expect(parseMembers({ users: [{ email: 'x' }] })).toEqual([]);
  });
});

describe('parseInvitations', () => {
  it('lee las pendientes y descarta las incompletas', () => {
    const inv = {
      id: 'i1',
      email: 'b@c.co',
      role: 'vendedor',
      invitedByEmail: null,
      expiresAt: '2026-10-05T00:00:00.000Z',
      createdAt: '2026-09-28T00:00:00.000Z',
    };
    expect(parseInvitations({ invitations: [inv, { id: 'x' }] })).toEqual([inv]);
    expect(parseInvitations({ error: 'x' })).toBeUndefined();
  });
});

describe('invitationOrigin: quién la mandó y cuándo', () => {
  const NOW = Date.parse('2026-09-30T12:00:00.000Z');

  it('"Invitado por X · hace N días"', () => {
    expect(
      invitationOrigin(
        { invitedByEmail: 'ana@agencia.co', createdAt: '2026-09-28T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('Invitado por ana@agencia.co · hace 2 días');
    expect(
      invitationOrigin(
        { invitedByEmail: 'ana@agencia.co', createdAt: '2026-09-30T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('Invitado por ana@agencia.co · hace 3 h');
  });

  it('sin invitador (se borró la cuenta) o sin fecha legible, lo dice igual', () => {
    expect(
      invitationOrigin({ invitedByEmail: null, createdAt: '2026-09-29T12:00:00.000Z' }, NOW),
    ).toBe('Invitado por un usuario eliminado · hace 1 día');
    expect(invitationOrigin({ invitedByEmail: 'ana@agencia.co', createdAt: '' }, NOW)).toBe(
      'Invitado por ana@agencia.co',
    );
  });
});

describe('invitaciones que revoca un cambio', () => {
  it('parseMembershipImpact: un entero no negativo, o nada', () => {
    expect(parseMembershipImpact({ invitationsToRevoke: 2 })).toEqual({ invitationsToRevoke: 2 });
    expect(parseMembershipImpact({ invitationsToRevoke: 0 })).toEqual({ invitationsToRevoke: 0 });
    for (const bad of [{}, { invitationsToRevoke: -1 }, { invitationsToRevoke: 1.5 }, null, []]) {
      expect(parseMembershipImpact(bad)).toBeUndefined();
    }
    expect(parseMembershipImpact({ invitationsToRevoke: '2' })).toBeUndefined();
  });

  it('la frase: ninguna, una, varias o no sabemos cuántas', () => {
    expect(revokedInvitationsNotice(0)).toBe('');
    expect(revokedInvitationsNotice(1)).toBe(' Se revocará 1 invitación que envió.');
    expect(revokedInvitationsNotice(3)).toBe(' Se revocarán 3 invitaciones que envió.');
    expect(revokedInvitationsNotice(null)).toMatch(
      /invitaciones que ya no podría enviar, se revocan/,
    );
  });

  it('suspender aclara que corta sólo este nodo y cuenta las invitaciones', () => {
    const copy = statusChangeCopy(member(), 'suspended', 2);
    expect(copy.title).toBe('Suspender a Ana Pérez');
    expect(copy.confirmLabel).toBe('Suspender');
    expect(copy.description).toMatch(/este nodo/);
    expect(copy.description).toMatch(/en otros nodos, ahí sigue operando/);
    expect(copy.description).toMatch(/Se revocarán 2 invitaciones que envió\.$/);
    expect(statusChangeCopy(member(), 'suspended', 0).description).not.toMatch(/invitaci/);
  });

  it('reactivar no habla de invitaciones', () => {
    const copy = statusChangeCopy(member({ name: null }), 'active', 5);
    expect(copy.title).toBe('Reactivar a ana@agencia.co');
    expect(copy.description).not.toMatch(/invitaci/);
  });

  it('degradar cuenta las invitaciones; promover no', () => {
    expect(demotes('tenant_admin', 'admin')).toBe(true);
    expect(demotes('admin', 'tenant_admin')).toBe(false);
    const down = roleChangeCopy(member({ role: 'tenant_admin' }), 'admin', (r) => r, 1);
    expect(down.description).toMatch(/Se revocará 1 invitación que envió\.$/);
    const up = roleChangeCopy(member({ role: 'vendedor' }), 'admin', (r) => r, 4);
    expect(up.description).not.toMatch(/invitaci/);
    expect(roleChangeCopy(member({ role: 'admin' }), 'vendedor', (r) => r).description).not.toMatch(
      /invitaci/,
    );
  });
});

describe('mfaState: 2FA activo / pendiente / no requerido', () => {
  it('activo si lo tiene', () => {
    expect(mfaState(member({ mfaEnabled: true }))).toBe('active');
  });

  it('pendiente si su rol lo exige y no lo activó', () => {
    for (const role of MFA_REQUIRED_ROLES) {
      expect(mfaState(member({ role, mfaEnabled: false }))).toBe('pending');
    }
  });

  it('no requerido para vendedores y managers sin 2FA', () => {
    expect(mfaState(member({ role: 'vendedor' }))).toBe('not-required');
    expect(mfaState(member({ role: 'admin' }))).toBe('not-required');
    expect(mfaState(member({ role: 'agency_admin' }))).toBe('not-required');
  });

  it('desconocido si el API no lo dice', () => {
    expect(mfaState(member({ mfaEnabled: undefined }))).toBe('unknown');
  });

  it('el espejo coincide con MFA_REQUIRED_ROLES del API', () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(
      ['consolidator_admin', 'platform_admin', 'superadmin', 'tenant_admin'].sort(),
    );
  });
});

describe('memberStatus', () => {
  it('la cuenta suspendida pesa más que la membership activa', () => {
    expect(memberStatus({ userStatus: 'suspended', membershipStatus: 'active' })).toEqual({
      label: 'Cuenta suspendida',
      tone: 'danger',
    });
  });

  it('membership', () => {
    expect(memberStatus({ userStatus: 'active', membershipStatus: 'active' }).label).toBe('Activo');
    expect(memberStatus({ userStatus: 'active', membershipStatus: 'suspended' }).tone).toBe(
      'danger',
    );
  });
});

describe('memberAccess', () => {
  const NOW = Date.parse('2026-09-29T15:00:00.000Z');

  it('último acceso relativo, en línea y bloqueo vigente', () => {
    const access = memberAccess(
      member({ lockedUntil: '2026-09-29T15:10:00.000Z', activeSessions: 2 }),
      NOW,
    );
    expect(access.lastAccess).toBe('hace 3 h');
    expect(access.online).toBe(true);
    expect(access.locked).toMatch(/^Bloqueado hasta/);
  });

  it('nunca ingresó; sin sesiones; sin datos', () => {
    expect(memberAccess(member({ lastLoginAt: null, activeSessions: 0 }), NOW)).toEqual({
      lastAccess: 'Nunca ingresó',
      locked: undefined,
      online: false,
    });
    expect(memberAccess(member({ lastLoginAt: undefined }), NOW).lastAccess).toBeUndefined();
  });
});

describe('quién puede qué (guía; decide el API)', () => {
  const agencyAdmin = teamActorOf('actor', [
    { role: 'agency_admin', status: 'active' },
    { role: 'tenant_admin', status: 'suspended' },
  ]);
  const superadmin = teamActorOf('root', [{ role: 'superadmin', status: 'active' }]);

  it('el rango sale de las memberships activas', () => {
    expect(agencyAdmin).toEqual({ userId: 'actor', superadmin: false, rank: 50 });
    expect(superadmin.superadmin).toBe(true);
  });

  it('nunca sobre sí mismo ni sobre un par o superior', () => {
    expect(canActOn(agencyAdmin, member({ userId: 'actor', role: 'vendedor' }))).toBe(false);
    expect(canActOn(agencyAdmin, member({ role: 'agency_admin' }))).toBe(false);
    expect(canActOn(agencyAdmin, member({ role: 'tenant_admin' }))).toBe(false);
    expect(canActOn(agencyAdmin, member({ role: 'vendedor' }))).toBe(true);
    expect(canActOn(superadmin, member({ role: 'tenant_admin' }))).toBe(true);
    expect(canActOn(superadmin, member({ userId: 'root' }))).toBe(false);
  });

  it('sin saber quién mira, se ofrece y decide el API', () => {
    expect(canActOn(ANONYMOUS_ACTOR, member({ role: 'tenant_admin' }))).toBe(true);
  });

  it('roles asignables: estrictamente por debajo', () => {
    const roles = [{ value: 'vendedor' }, { value: 'admin' }, { value: 'agency_admin' }];
    expect(grantableRoles(roles, agencyAdmin).map((r) => r.value)).toEqual(['vendedor', 'admin']);
    expect(grantableRoles(roles, superadmin)).toHaveLength(3);
  });
});

describe('textos de las acciones', () => {
  it('restablecer 2FA explica qué se borra y si tiene que volver a enrolarse', () => {
    const copy = memberActionCopy('reset-mfa', member({ role: 'tenant_admin' }));
    expect(copy.title).toBe('Restablecer el 2FA de Ana Pérez');
    expect(copy.description).toMatch(/códigos de recuperación/);
    expect(copy.description).toMatch(/tiene que configurarlo de nuevo/);
    expect(memberActionCopy('reset-mfa', member({ role: 'vendedor' })).description).toMatch(
      /sólo con su contraseña/,
    );
  });

  it('cerrar sesiones aclara que no suspende', () => {
    const copy = memberActionCopy('revoke-sessions', member({ name: null }));
    expect(copy.title).toBe('Cerrar las sesiones de ana@agencia.co');
    expect(copy.description).toMatch(/no se suspende/);
  });

  it('el aviso de "Cerrar sus sesiones" dice si no había ninguna', () => {
    // Se ofrece aunque la lista no la vea en línea: puede tener la sesión en otro de sus nodos.
    const ana = member({ activeSessions: 0 });
    expect(memberActionDoneMessage('revoke-sessions', ana, { revoked: 0 })).toBe(
      'Ana Pérez no tenía sesiones abiertas.',
    );
    expect(memberActionDoneMessage('revoke-sessions', ana, { revoked: 2 })).toBe(
      'Cerramos las sesiones de Ana Pérez.',
    );
    expect(memberActionDoneMessage('revoke-sessions', ana, { revoked: undefined })).toBe(
      'Cerramos las sesiones de Ana Pérez.',
    );
    expect(memberActionDoneMessage('reset-mfa', ana, { revoked: 0 })).toMatch(
      /Restablecimos el 2FA/,
    );
  });

  it('parseMemberActionResult: el conteo si viene; si no, igual es un éxito', () => {
    expect(parseMemberActionResult({ revoked: 3 })).toEqual({ revoked: 3 });
    expect(parseMemberActionResult({ ok: true })).toEqual({ revoked: undefined });
    expect(parseMemberActionResult({ revoked: -1 })).toEqual({ revoked: undefined });
    expect(parseMemberActionResult(null)).toEqual({ revoked: undefined });
  });

  it('promover a un rol con 2FA obligatorio lo avisa', () => {
    const copy = roleChangeCopy(member({ role: 'vendedor' }), 'tenant_admin', (r) => r);
    expect(copy.title).toBe('Promover Ana Pérez');
    expect(copy.description).toMatch(/exige verificación en dos pasos/);
    const down = roleChangeCopy(member({ role: 'admin' }), 'vendedor', (r) => r);
    expect(down.confirmLabel).toBe('Cambiar rol');
    expect(down.description).not.toMatch(/dos pasos/);
  });

  it('el 403 muestra el motivo del API', () => {
    expect(memberActionError(403, 'El usuario también pertenece a otra red.')).toBe(
      'No lo pudimos hacer: El usuario también pertenece a otra red.',
    );
    expect(memberActionError(403, undefined)).toMatch(/superadmin/);
    expect(memberActionError(401, 'x')).toMatch(/sesión venció/);
    expect(memberActionError(404, '')).toMatch(/ya no está/);
    expect(memberActionError(400, 'No podés hacerlo sobre vos mismo.')).toBe(
      'No podés hacerlo sobre vos mismo.',
    );
    expect(memberActionError(500, '')).toMatch(/unos minutos/);
  });

  it('el error de carga no es un "no hay usuarios"', () => {
    expect(teamLoadError(403)).toMatch(/permiso/);
    expect(teamLoadError(500)).toMatch(/No pudimos cargar/);
  });
});
