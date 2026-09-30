import { describe, expect, it } from 'vitest';
import type { Role } from '../database/database.types.js';
import {
  invitationDefect,
  InvitationNoLongerValidError,
  type InvitationBacking,
} from './invitation-validity.js';

function respaldo(extra: Partial<InvitationBacking> = {}): InvitationBacking {
  return {
    invitationId: 'inv-1',
    tenantId: 'nodo-1',
    role: 'vendedor',
    invitedBy: 'admin-1',
    inviterActive: true,
    tenantActive: true,
    inviterRoles: ['admin'],
    ...extra,
  };
}

describe('invitationDefect: una invitación vale mientras su invitador la pueda volver a emitir', () => {
  it('invitador activo, con rango sobre el nodo y nodo activo: vale', () => {
    expect(invitationDefect(respaldo())).toBeUndefined();
    expect(
      invitationDefect(respaldo({ role: 'tenant_admin', inviterRoles: ['consolidator_admin'] })),
    ).toBeUndefined();
  });

  it('el superadmin respalda cualquier rol asignable', () => {
    expect(
      invitationDefect(respaldo({ role: 'consolidator_admin', inviterRoles: ['superadmin'] })),
    ).toBeUndefined();
  });

  it('el invitador que ya no existe no respalda nada', () => {
    expect(invitationDefect(respaldo({ invitedBy: null }))).toBe('inviter_missing');
  });

  it('el invitador suspendido en la plataforma no respalda nada, aunque conserve roles', () => {
    expect(invitationDefect(respaldo({ inviterActive: false, inviterRoles: ['superadmin'] }))).toBe(
      'inviter_inactive',
    );
  });

  it('sin membership activa con potestad sobre el nodo (lo suspendieron ahí): no vale', () => {
    expect(invitationDefect(respaldo({ inviterRoles: [] }))).toBe('inviter_outranked');
  });

  it('el caso de la auditoría: un admin que invitó a un Manager y ya no es admin', () => {
    expect(invitationDefect(respaldo({ role: 'admin', inviterRoles: ['vendedor'] }))).toBe(
      'inviter_outranked',
    );
  });

  it.each<[Role, Role]>([
    ['admin', 'admin'],
    ['admin', 'tenant_admin'],
    ['tenant_admin', 'tenant_admin'],
    ['agency_admin', 'consolidator_admin'],
  ])('un %s no respalda una invitación como %s (G-06)', (inviter, role) => {
    expect(invitationDefect(respaldo({ role, inviterRoles: [inviter] }))).toBe('inviter_outranked');
  });

  it('degradado de tenant_admin a admin: sigue respaldando a los vendedores, no a los admins', () => {
    expect(
      invitationDefect(respaldo({ role: 'vendedor', inviterRoles: ['admin'] })),
    ).toBeUndefined();
    expect(invitationDefect(respaldo({ role: 'admin', inviterRoles: ['admin'] }))).toBe(
      'inviter_outranked',
    );
  });

  it('cuenta el mayor de sus roles de admin; los que no administran no suman', () => {
    expect(
      invitationDefect(respaldo({ role: 'admin', inviterRoles: ['vendedor', 'tenant_admin'] })),
    ).toBeUndefined();
    expect(invitationDefect(respaldo({ role: 'cliente_final', inviterRoles: ['vendedor'] }))).toBe(
      'inviter_outranked',
    );
    // `platform_admin` está retirado (D7 B) y roleOver no lo cuenta: tampoco respalda.
    expect(invitationDefect(respaldo({ inviterRoles: ['platform_admin'] }))).toBe(
      'inviter_outranked',
    );
  });

  it('el nodo o un ancestro suspendido: no vale', () => {
    expect(invitationDefect(respaldo({ tenantActive: false }))).toBe('tenant_inactive');
  });

  it('el error del canje dice qué hacer y trae su motivo', () => {
    const err = new InvitationNoLongerValidError();
    expect(err.getStatus()).toBe(400);
    expect(err.reason).toBe('INVITATION_NO_LONGER_VALID');
    expect(err.message).toBe('Esta invitación ya no es válida, pide una nueva.');
  });
});
