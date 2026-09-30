import { BadRequestException } from '@nestjs/common';
import { AGENCY_ADMIN_ROLES, canGrantRole, highestRole } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';

/**
 * Cuándo sigue valiendo una invitación pendiente (brecha de la auditoría del 2026-09-29): mientras
 * quien la emitió la pueda volver a emitir. Es la misma regla con que InvitationsController deja
 * invitar (roleOver sobre el nodo y rango estrictamente superior, G-06), aplicada otra vez al
 * suspender o degradar al invitador y al canjearla. Sin I/O: los datos los junta
 * `invitation_backing` (0056).
 */

/** Una fila de `invitation_backing`. */
export interface InvitationBacking {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly role: Role;
  /** `null` si el invitador ya no existe (`ON DELETE SET NULL`). */
  readonly invitedBy: string | null;
  readonly inviterActive: boolean;
  /** El nodo de la invitación y todos sus ancestros están activos. */
  readonly tenantActive: boolean;
  /** Roles activos del invitador con potestad sobre el nodo (sin filtrar los de admin). */
  readonly inviterRoles: readonly Role[];
}

/** Por qué una invitación ya no vale. Viaja en la auditoría. */
export type InvitationDefect =
  | 'inviter_missing'
  | 'inviter_inactive'
  | 'inviter_outranked'
  | 'tenant_inactive';

/**
 * El rol con que el invitador administra el nodo de la invitación, como NetworkService.roleOver:
 * superadmin en cualquier nodo o un rol de admin de nodo en el nodo o un ancestro.
 */
function inviterAuthority(roles: readonly Role[]): Role | undefined {
  return highestRole(
    roles.filter((r) => r === 'superadmin' || (AGENCY_ADMIN_ROLES as readonly Role[]).includes(r)),
  );
}

/** Qué le falta a la invitación para valer, o `undefined` si vale. */
export function invitationDefect(backing: InvitationBacking): InvitationDefect | undefined {
  if (backing.invitedBy === null) return 'inviter_missing';
  if (!backing.inviterActive) return 'inviter_inactive';
  const authority = inviterAuthority(backing.inviterRoles);
  if (authority === undefined) return 'inviter_outranked';
  if (authority !== 'superadmin' && !canGrantRole(authority, backing.role)) {
    return 'inviter_outranked';
  }
  if (!backing.tenantActive) return 'tenant_inactive';
  return undefined;
}

/**
 * La invitación era auténtica y vigente, pero quien la emitió ya no podría emitirla o su nodo no
 * opera. 400, como la inválida o vencida, con un motivo propio para que la pantalla diga qué hacer.
 */
export class InvitationNoLongerValidError extends BadRequestException {
  readonly reason = 'INVITATION_NO_LONGER_VALID';

  constructor() {
    super('Esta invitación ya no es válida, pedí una nueva.');
    this.name = 'InvitationNoLongerValidError';
  }
}
