import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ACTOR,
  REMOVE_FROM_NODE_LABEL,
  canRemoveFromNode,
  memberRemovedMessage,
  parseMembershipRemoval,
  removeMemberCopy,
  MFA_REQUIRED_ROLES,
  PASSWORD_RESET_PENDING_HINT,
  PASSWORD_RESET_PENDING_LABEL,
  accessSuspended,
  canActOn,
  demotes,
  grantableRoles,
  invitationOrigin,
  isLocked,
  memberAccess,
  memberActionCopy,
  memberActionDoneMessage,
  memberActionError,
  memberActionNoticeTone,
  memberMenuGroups,
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
import { voseoIn } from './voseo';

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
  passwordResetRequired: false,
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
    const {
      lastLoginAt: _a,
      mfaEnabled: _b,
      lockedUntil: _c,
      activeSessions: _d,
      passwordResetRequired: _e,
      ...legacy
    } = RAW;
    const parsed = parseMembers({ users: [legacy] })?.[0];
    expect(parsed).toMatchObject({
      lastLoginAt: undefined,
      mfaEnabled: undefined,
      lockedUntil: undefined,
      activeSessions: undefined,
      passwordResetRequired: undefined,
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

describe('quitar a alguien del nodo (USR-11)', () => {
  it('se ofrece a quien está activo o suspendido en el nodo', () => {
    expect(REMOVE_FROM_NODE_LABEL).toBe('Quitar de este nodo');
    expect(canRemoveFromNode(member())).toBe(true);
    expect(canRemoveFromNode(member({ membershipStatus: 'suspended' }))).toBe(true);
    expect(canRemoveFromNode(member({ membershipStatus: 'invited' }))).toBe(false);
    expect(canRemoveFromNode(member({ membershipStatus: 'removed' }))).toBe(false);
  });

  it('a un rol de plataforma no: ninguna invitación lo devuelve', () => {
    expect(canRemoveFromNode(member({ role: 'superadmin' }))).toBe(false);
    expect(canRemoveFromNode(member({ role: 'platform_admin' }))).toBe(false);
    expect(canRemoveFromNode(member({ role: 'consolidator_admin' }))).toBe(true);
  });

  it('la confirmación: qué pierde, qué queda, cómo vuelve y las invitaciones que se revocan', () => {
    const copy = removeMemberCopy(member(), 'Agencia Norte', 2);
    expect(copy).toEqual({
      title: 'Quitar a Ana Pérez de Agencia Norte',
      description:
        'Deja de pertenecer a este nodo y se cierran sus sesiones en él. Se revocarán 2 invitaciones que envió. Su historial y sus reservas quedan como están. Si después quieres que vuelva, tienes que invitarlo de nuevo.',
      confirmLabel: 'Quitar del nodo',
    });
    expect(removeMemberCopy(member(), 'Agencia Norte', 0).description).not.toMatch(/invitaci.n/);
    // Sin saber cuántas, se avisa igual; sin nombre del nodo, "este nodo"; sin nombre, el correo.
    expect(removeMemberCopy(member(), undefined, null).description).toMatch(
      /invitaciones que ya no podría enviar, se revocan/,
    );
    expect(removeMemberCopy(member({ name: null }), '  ').title).toBe(
      'Quitar a ana@agencia.co de este nodo',
    );
    expect(voseoIn(Object.values(copy).join(' '))).toEqual([]);
  });

  it('el aviso de que salió bien, con las invitaciones que se revocaron', () => {
    expect(memberRemovedMessage(member(), 'Agencia Norte', { revokedInvitations: 0 })).toBe(
      'Quitamos a Ana Pérez de Agencia Norte.',
    );
    expect(memberRemovedMessage(member(), 'Agencia Norte', { revokedInvitations: 1 })).toBe(
      'Quitamos a Ana Pérez de Agencia Norte. Se revocó 1 invitación que envió.',
    );
    expect(memberRemovedMessage(member(), undefined, { revokedInvitations: 3 })).toBe(
      'Quitamos a Ana Pérez de este nodo. Se revocaron 3 invitaciones que envió.',
    );
    expect(memberRemovedMessage(member(), 'Norte', { revokedInvitations: undefined })).toBe(
      'Quitamos a Ana Pérez de Norte.',
    );
  });

  it('la respuesta del API nunca falla: sin conteos, se avisa sin ellos', () => {
    expect(
      parseMembershipRemoval({ status: 'removed', revokedSessions: 2, revokedInvitations: 0 }),
    ).toEqual({ revokedSessions: 2, revokedInvitations: 0 });
    expect(parseMembershipRemoval({ revokedSessions: -1, revokedInvitations: '1' })).toEqual({
      revokedSessions: undefined,
      revokedInvitations: undefined,
    });
    expect(parseMembershipRemoval(null)).toEqual({
      revokedSessions: undefined,
      revokedInvitations: undefined,
    });
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
    expect(memberActionError(400, 'No puedes hacerlo sobre ti mismo.')).toBe(
      'No puedes hacerlo sobre ti mismo.',
    );
    expect(memberActionError(500, '')).toMatch(/unos minutos/);
  });

  it('el error de carga no es un "no hay usuarios"', () => {
    expect(teamLoadError(403)).toMatch(/permiso/);
    expect(teamLoadError(500)).toMatch(/No pudimos cargar/);
  });
});

describe('enviar el enlace para restablecer la contraseña y desbloquear', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z');

  it('los textos de "Enviar enlace": a quién, que vence, que invalida los anteriores y que el admin no ve nada', () => {
    const copy = memberActionCopy('send-password-reset', member());
    expect(copy).toEqual({
      label: 'Enviar enlace para restablecer contraseña',
      title: 'Enviar a Ana Pérez un enlace para restablecer su contraseña',
      description:
        'Le enviamos a ana@agencia.co un enlace para que elija una contraseña nueva. Vence en 60 minutos y deja sin efecto los enlaces anteriores. Tú no ves el enlace ni la contraseña, y la actual sigue funcionando hasta que la cambie.',
      confirmLabel: 'Enviar enlace',
      done: 'Le enviamos a Ana Pérez un enlace para elegir una contraseña nueva. Vence en 1 hora.',
    });
  });

  it('los textos de "Desbloquear cuenta": qué no cambia y qué hacer si no reconoce los intentos', () => {
    const copy = memberActionCopy('unlock', member({ name: null }));
    expect(copy.label).toBe('Desbloquear cuenta');
    expect(copy.title).toBe('Desbloquear a ana@agencia.co');
    expect(copy.description).toMatch(/No cambia su contraseña ni su 2FA/);
    expect(copy.description).toMatch(/envíale un enlace para restablecer la contraseña/);
    expect(copy.confirmLabel).toBe('Desbloquear');
    expect(copy.done).toBe('Desbloqueamos la cuenta de ana@agencia.co.');
  });

  it('parseMemberActionResult lee `sent` y `unlocked` si son booleanos', () => {
    expect(parseMemberActionResult({ sent: false, expiresAt: '2026-10-11T13:00:00Z' })).toEqual({
      revoked: undefined,
      sent: false,
      unlocked: undefined,
    });
    expect(parseMemberActionResult({ unlocked: true })).toMatchObject({ unlocked: true });
    expect(parseMemberActionResult({ sent: 'sí', unlocked: 1 })).toMatchObject({
      sent: undefined,
      unlocked: undefined,
    });
  });

  it('el aviso: enviado, correo que no salió (advertencia), desbloqueado o ya no lo estaba', () => {
    const ana = member();
    const sent = { revoked: undefined, sent: true };
    const notSent = { revoked: undefined, sent: false };
    expect(memberActionDoneMessage('send-password-reset', ana, sent)).toBe(
      'Le enviamos a Ana Pérez un enlace para elegir una contraseña nueva. Vence en 1 hora.',
    );
    expect(memberActionNoticeTone('send-password-reset', sent)).toBe('success');
    expect(memberActionDoneMessage('send-password-reset', ana, notSent)).toBe(
      'Generamos el enlace, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo e inténtalo de nuevo.',
    );
    expect(memberActionNoticeTone('send-password-reset', notSent)).toBe('warning');

    expect(memberActionDoneMessage('unlock', ana, { revoked: undefined, unlocked: true })).toBe(
      'Desbloqueamos la cuenta de Ana Pérez.',
    );
    expect(memberActionDoneMessage('unlock', ana, { revoked: undefined, unlocked: false })).toBe(
      'Ana Pérez ya no estaba bloqueado.',
    );
    expect(memberActionNoticeTone('unlock', { revoked: undefined, unlocked: false })).toBe(
      'success',
    );
  });

  it('el 409 y el 429 muestran el motivo del API, o uno propio si no vino', () => {
    const suspended =
      'Su acceso a este nodo está suspendido: reactívalo antes de enviarle el enlace.';
    expect(memberActionError(409, suspended)).toBe(suspended);
    expect(memberActionError(409, '')).toMatch(/suspendido/);
    const limited =
      'Ya se enviaron varios enlaces a esta persona hace poco. Espera 15 minutos antes de enviar otro.';
    expect(memberActionError(429, limited)).toBe(limited);
    expect(memberActionError(429, undefined)).toMatch(/Espera unos minutos/);
  });

  it('bloqueado sólo con un bloqueo vigente; acceso suspendido en la plataforma o en el nodo', () => {
    expect(isLocked(member({ lockedUntil: '2026-10-11T12:10:00.000Z' }), NOW)).toBe(true);
    expect(isLocked(member({ lockedUntil: '2026-10-11T11:59:00.000Z' }), NOW)).toBe(false);
    expect(isLocked(member({ lockedUntil: null }), NOW)).toBe(false);
    expect(isLocked(member({ lockedUntil: undefined }), NOW)).toBe(false);

    expect(accessSuspended(member())).toBe(false);
    expect(accessSuspended(member({ userStatus: 'suspended' }))).toBe(true);
    expect(accessSuspended(member({ membershipStatus: 'suspended' }))).toBe(true);
  });

  it('el menú: Acceso (enlace y, si está bloqueado, desbloquear) y Seguridad', () => {
    const groups = memberMenuGroups(member({ mfaEnabled: true }), NOW);
    expect(groups.map((g) => g.heading)).toEqual(['Acceso', 'Seguridad']);
    expect(groups[0]?.items).toEqual([
      {
        action: 'send-password-reset',
        label: 'Enviar enlace para restablecer contraseña',
        disabled: false,
      },
      {
        action: 'require-password-reset',
        label: 'Forzar cambio de contraseña',
        disabled: false,
      },
    ]);
    expect(groups[1]?.items.map((i) => [i.action, i.disabled])).toEqual([
      ['revoke-sessions', false],
      ['reset-mfa', false],
    ]);

    const locked = memberMenuGroups(member({ lockedUntil: '2026-10-11T12:10:00.000Z' }), NOW);
    expect(locked[0]?.items.map((i) => i.action)).toEqual([
      'send-password-reset',
      'require-password-reset',
      'unlock',
    ]);
  });

  it('con el acceso suspendido, "Enviar enlace" y "Forzar cambio" se ven deshabilitados y dicen por qué', () => {
    for (const patch of [{ userStatus: 'suspended' }, { membershipStatus: 'suspended' }]) {
      const [access] = memberMenuGroups(member(patch), NOW);
      expect(access?.items).toEqual([
        {
          action: 'send-password-reset',
          label: 'Enviar enlace para restablecer contraseña (acceso suspendido)',
          disabled: true,
        },
        {
          action: 'require-password-reset',
          label: 'Forzar cambio de contraseña (acceso suspendido)',
          disabled: true,
        },
      ]);
    }
  });

  it('sin 2FA activo, "Restablecer 2FA" se ve deshabilitado', () => {
    const [, security] = memberMenuGroups(member({ mfaEnabled: false }), NOW);
    expect(security?.items[1]).toEqual({
      action: 'reset-mfa',
      label: 'Restablecer 2FA (no lo tiene activo)',
      disabled: true,
    });
  });
});

describe('forzar el cambio de contraseña', () => {
  it('lee la marca del API', () => {
    expect(
      parseMembers({ users: [{ ...RAW, passwordResetRequired: true }] })?.[0]
        ?.passwordResetRequired,
    ).toBe(true);
    expect(
      parseMembers({ users: [{ ...RAW, passwordResetRequired: 'sí' }] })?.[0]
        ?.passwordResetRequired,
    ).toBeUndefined();
  });

  it('los textos: que se cierran sus sesiones, que no entra hasta elegirla y para qué sirve', () => {
    expect(memberActionCopy('require-password-reset', member())).toEqual({
      label: 'Forzar cambio de contraseña',
      title: 'Forzar a Ana Pérez a cambiar su contraseña',
      description:
        'Se cierran todas sus sesiones y no puede volver a ingresar hasta que elija una contraseña nueva con el enlace que le enviamos a su correo. Úsalo si crees que su contraseña está comprometida.',
      confirmLabel: 'Forzar cambio',
      done: 'Ana Pérez tiene que elegir una contraseña nueva. Le enviamos el enlace y cerramos sus sesiones.',
    });
  });

  it('el aviso: hecho, o hecho sin correo (advertencia, con qué hacer)', () => {
    const ana = member();
    const done = parseMemberActionResult({ sent: true, revokedSessions: 2 });
    expect(done).toMatchObject({ sent: true, revokedSessions: 2 });
    expect(memberActionDoneMessage('require-password-reset', ana, done)).toBe(
      'Ana Pérez tiene que elegir una contraseña nueva. Le enviamos el enlace y cerramos sus sesiones.',
    );
    expect(memberActionNoticeTone('require-password-reset', done)).toBe('success');

    const notSent = parseMemberActionResult({ sent: false, revokedSessions: 0 });
    expect(memberActionDoneMessage('require-password-reset', ana, notSent)).toBe(
      'Ana Pérez tiene que elegir una contraseña nueva y cerramos sus sesiones, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y envíale el enlace de nuevo.',
    );
    expect(memberActionNoticeTone('require-password-reset', notSent)).toBe('warning');
    expect(parseMemberActionResult({ revokedSessions: -1 }).revokedSessions).toBeUndefined();
  });

  it('con el cambio pendiente, "Enviar enlace" no promete que la actual sigue funcionando', () => {
    const pending = memberActionCopy(
      'send-password-reset',
      member({ passwordResetRequired: true }),
    );
    expect(pending.label).toBe('Enviar enlace para restablecer contraseña');
    expect(pending.description).toBe(
      'Le enviamos a ana@agencia.co un enlace nuevo para que elija su contraseña. Vence en 60 minutos y deja sin efecto los enlaces anteriores. Tú no ves el enlace ni la contraseña, y hasta que la elija no puede ingresar.',
    );
    expect(pending.description).not.toMatch(/sigue funcionando/);
    expect(memberActionCopy('send-password-reset', member()).description).toMatch(
      /sigue funcionando/,
    );
  });

  it('la marca de la fila dice qué le pasa', () => {
    expect(PASSWORD_RESET_PENDING_LABEL).toBe('Cambio de contraseña pendiente');
    expect(PASSWORD_RESET_PENDING_HINT).toBe(
      'No puede ingresar hasta que elija una contraseña nueva con el enlace que le enviamos a su correo.',
    );
  });
});
