import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { canGrantRole, ROLE_RANK } from '../auth/roles.js';
import type { Role, TenantType } from '../database/database.types.js';
import { TenantHierarchyError } from '../database/tenant-hierarchy-errors.js';

/**
 * Las reglas de la API para armar la red (D4 A), sin base: qué tipo nace bajo cada padre, quién
 * puede crear consolidadores y sucursales, y qué rol recibe el admin inicial de un nodo nuevo.
 *
 * La base aplica la misma matriz con su trigger (0050) y es la última palabra: esto existe para
 * responder antes y con el motivo exacto, y para no pedirle a la web que adivine el tipo. El test
 * de integración compara esta derivación con `tenant_hierarchy_rule` en todas las combinaciones.
 */

/** Los tipos que se crean por API. `platform` es la raíz única (Planetour): nunca se crea así. */
export const CREATABLE_TENANT_TYPES = [
  'consolidator',
  'agency',
  'subagency',
] as const satisfies readonly TenantType[];
export type CreatableTenantType = (typeof CREATABLE_TENANT_TYPES)[number];

/** Crear un consolidador o una sucursal es sólo del superadmin (G-05). 403. */
export class TenantSuperadminOnlyError extends ForbiddenException {
  readonly reason = 'TENANT_SUPERADMIN_ONLY';

  constructor() {
    super('Sólo el superadmin crea consolidadores y sucursales, y sólo bajo la plataforma.');
    this.name = 'TenantSuperadminOnlyError';
  }
}

/** Quien no es superadmin tiene que decir de qué nodo cuelga el nuevo. 400. */
export class TenantParentRequiredError extends BadRequestException {
  readonly reason = 'TENANT_PARENT_REQUIRED';

  constructor() {
    super('Indicá de qué nodo de tu red cuelga el nuevo.');
    this.name = 'TenantParentRequiredError';
  }
}

/** La plataforma no se suspende: dejaría sin acceso a toda la red, superadmin incluido. 409. */
export class TenantPlatformLockedError extends ConflictException {
  readonly reason = 'TENANT_PLATFORM_LOCKED';

  constructor() {
    super('La plataforma no se puede suspender: es la raíz de toda la red.');
    this.name = 'TenantPlatformLockedError';
  }
}

/**
 * Un consolidador con reservas abiertas hechas con sus propias credenciales no deja de serlo: la
 * post-venta sale con la cuenta de la venta, y la de TBO sólo opera si su dueño es la plataforma o
 * un consolidador. Es la regla con que move_tenant_subtree (0051) bloquea un movimiento. 409.
 */
export class TenantTypeOpenBookingsError extends ConflictException {
  readonly reason = 'TENANT_TYPE_OPEN_BOOKINGS';

  constructor() {
    super(
      'El consolidador tiene reservas abiertas hechas con sus credenciales: hay que cerrarlas o ' +
        'cancelarlas antes de cambiarle el tipo.',
    );
    this.name = 'TenantTypeOpenBookingsError';
  }
}

/** El slug ya lo usa otro nodo. 409. */
export class TenantSlugTakenError extends ConflictException {
  readonly reason = 'TENANT_SLUG_TAKEN';

  constructor() {
    super('Ese slug ya lo usa otro nodo de la red.');
    this.name = 'TenantSlugTakenError';
  }
}

/** El actor no está por encima del rol que quiere dar o tocar sobre ese nodo (G-06). 403. */
export class RoleNotGrantableError extends ForbiddenException {
  readonly reason = 'ROLE_NOT_GRANTABLE';

  constructor(
    message = 'No podés asignar ni modificar un rol igual o superior al tuyo en ese nodo.',
  ) {
    super(message);
    this.name = 'RoleNotGrantableError';
  }
}

/**
 * El único tipo que admite un padre según D4 A, fuera del consolidador (que se pide aparte):
 * bajo la plataforma o un consolidador, agencia; bajo una agencia, sub-agencia. Una sub-agencia
 * no tiene hijos.
 */
export function derivedChildType(parentType: TenantType): 'agency' | 'subagency' | undefined {
  switch (parentType) {
    case 'platform':
    case 'consolidator':
      return 'agency';
    case 'agency':
      return 'subagency';
    case 'subagency':
      return undefined;
  }
}

export interface ChildTypeRequest {
  readonly parentType: TenantType;
  /** Lo que mandó el cliente. Sólo decide para 'consolidator'; lo demás tiene que coincidir. */
  readonly requestedType?: CreatableTenantType;
  readonly isBranch: boolean;
  readonly superadmin: boolean;
}

/**
 * El tipo del nodo nuevo (D4 A, G-05).
 *
 * - 'consolidator' y la sucursal: sólo el superadmin, y sólo bajo la plataforma.
 * - lo demás se deriva del padre; un tipo pedido que no coincide es un error, no se corrige en
 *   silencio: el cliente que pide una sub-agencia bajo la plataforma tiene un bug que hay que ver.
 */
export function childTenantType(req: ChildTypeRequest): CreatableTenantType {
  const { parentType, requestedType, isBranch, superadmin } = req;

  if ((requestedType === 'consolidator' || isBranch) && !superadmin) {
    throw new TenantSuperadminOnlyError();
  }

  if (requestedType === 'consolidator') {
    if (isBranch) throw new TenantHierarchyError('TENANT_BRANCH_TYPE');
    if (parentType !== 'platform') throw new TenantHierarchyError('TENANT_PARENT_TYPE');
    return 'consolidator';
  }

  if (isBranch) {
    if (requestedType !== undefined && requestedType !== 'agency') {
      throw new TenantHierarchyError('TENANT_BRANCH_TYPE');
    }
    if (parentType !== 'platform') throw new TenantHierarchyError('TENANT_BRANCH_PARENT');
    return 'agency';
  }

  const derived = derivedChildType(parentType);
  if (derived === undefined || (requestedType !== undefined && requestedType !== derived)) {
    throw new TenantHierarchyError('TENANT_PARENT_TYPE');
  }
  return derived;
}

/** El rol que corresponde al admin de cada tipo de nodo: el techo del admin inicial. */
const NODE_ADMIN_ROLE: Readonly<Record<CreatableTenantType, Role>> = {
  consolidator: 'consolidator_admin',
  agency: 'tenant_admin',
  subagency: 'tenant_admin',
};

/** Los roles de admin de un nodo, de mayor a menor rango. */
const NODE_ADMIN_LADDER = [
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
] as const satisfies readonly Role[];

/**
 * El rol del admin inicial de un nodo nuevo de tipo `type`, creado por alguien que actúa sobre el
 * padre con `actorRole`: el del tipo de nodo si el actor está por encima; si no, el mayor rol de
 * admin que el actor puede dar. `undefined` si no puede dar ninguno.
 *
 * Así nadie da un rol igual o superior al propio (G-06) y la regla es la misma que al invitar: un
 * tenant_admin que crea una sub-agencia le da `agency_admin` a su admin, porque tampoco podría
 * invitarlo como tenant_admin después. El superadmin da siempre el del tipo de nodo.
 */
export function initialAdminRole(
  type: CreatableTenantType,
  actorRole: Role | undefined,
): Role | undefined {
  if (actorRole === undefined) return undefined;
  const ceiling = ROLE_RANK[NODE_ADMIN_ROLE[type]];
  return NODE_ADMIN_LADDER.find(
    (role) => ROLE_RANK[role] <= ceiling && canGrantRole(actorRole, role),
  );
}

/** Lanza {@link RoleNotGrantableError} si `actorRole` no está estrictamente por encima de `target`. */
export function assertCanGrant(actorRole: Role, target: Role): void {
  if (!canGrantRole(actorRole, target)) throw new RoleNotGrantableError();
}

/**
 * El actor no administra el nodo de la ruta (ni un ancestro suyo): Puestos y el soporte a un
 * miembro. 403. En castellano porque la pantalla de Equipo muestra el mensaje de un 403 tal cual;
 * el motivo es para que la web no tenga que interpretar el texto.
 */
export class TenantNotManagedError extends ForbiddenException {
  readonly reason = 'TENANT_NOT_MANAGED';

  constructor() {
    super('No administrás este nodo.');
    this.name = 'TenantNotManagedError';
  }
}

// ============================================================================
// Soporte a un miembro: restablecer su 2FA y cerrar sus sesiones
// ============================================================================

/** Restablecer el 2FA o cerrar las sesiones propias no pasa por acá: lo hace otro admin. 403. */
export class MemberSelfActionError extends ForbiddenException {
  readonly reason = 'MEMBER_SELF_ACTION';

  constructor() {
    super('No podés hacer esto sobre tu propio usuario: pedíselo a otro administrador.');
    this.name = 'MemberSelfActionError';
  }
}

/** El usuario no tiene membership en el nodo de la ruta. 404. */
export class MemberNotFoundError extends NotFoundException {
  readonly reason = 'MEMBER_NOT_FOUND';

  constructor() {
    super('Ese usuario no es miembro de este nodo.');
    this.name = 'MemberNotFoundError';
  }
}

/** El usuario también trabaja en nodos que el actor no administra. 403. */
export class MemberOutsideNetworkError extends ForbiddenException {
  readonly reason = 'MEMBER_OUTSIDE_NETWORK';

  constructor() {
    super(
      'Este usuario también trabaja en nodos que no administrás: sólo puede hacerlo quien ' +
        'administre todos sus nodos, o el superadmin.',
    );
    this.name = 'MemberOutsideNetworkError';
  }
}

/** Una membership del objetivo que cuenta para decidir. */
export interface TargetMembership {
  readonly tenantId: string;
  readonly role: Role;
}

export interface MemberSupportRequest {
  readonly actorUserId: string;
  readonly targetUserId: string;
  /** El actor es superadmin (roleOver devolvió `superadmin` sobre el nodo de la ruta). */
  readonly actorIsSuperadmin: boolean;
  /**
   * Las memberships del objetivo que cuentan: TODAS sus activas, en cualquier red, más la del nodo
   * de la ruta aunque esté suspendida.
   */
  readonly targetMemberships: readonly TargetMembership[];
  /** El rol con que el actor administra cada nodo (roleOver). Sin entrada = no lo administra. */
  readonly actorRoles: ReadonlyMap<string, Role>;
}

/**
 * ¿Puede el actor restablecer el 2FA o cerrar las sesiones de otro usuario? (decisión del founder del
 * 2026-09-29).
 *
 * El 2FA y las sesiones son de la identidad global (`users`), no de un nodo: restablecerlo le abre
 * la puerta a esa persona en TODAS sus redes. Por eso no alcanza con administrar el nodo desde donde
 * se pide: el actor tiene que administrar cada nodo donde el usuario tiene membership activa y
 * superarlo en rango en cada uno (la misma regla que para cambiarle el rol, G-06). Si el usuario
 * también trabaja en otra red, sólo el superadmin. Nunca sobre uno mismo: un admin que perdió el
 * teléfono lo pide a otro, así un robo de sesión no alcanza para sacarle el segundo factor a la
 * cuenta.
 */
export function assertCanSupportMember(req: MemberSupportRequest): void {
  if (req.actorUserId === req.targetUserId) throw new MemberSelfActionError();
  // Sin memberships no hay nada que lo ate a la red del actor: se falla cerrado.
  if (req.targetMemberships.length === 0) throw new MemberNotFoundError();
  if (req.actorIsSuperadmin) return;

  if (req.targetMemberships.some((m) => !req.actorRoles.has(m.tenantId))) {
    throw new MemberOutsideNetworkError();
  }
  for (const m of req.targetMemberships) {
    const actorRole = req.actorRoles.get(m.tenantId);
    if (actorRole === undefined || !canGrantRole(actorRole, m.role)) {
      throw new RoleNotGrantableError(
        'No podés hacerlo sobre alguien de rango igual o superior al tuyo en alguno de sus nodos.',
      );
    }
  }
}
