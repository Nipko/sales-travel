import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Los errores de la jerarquía de tenants que la base lanza con SQLSTATE propio, traducidos a una
 * respuesta HTTP con motivo máquina en vez de un 500 genérico.
 *
 * - `STH01`: la operación viola una regla de la jerarquía (matriz D4, profundidad, ciclo;
 *   db/migrations/0050 y 0051).
 * - `STH02`: mover un nodo está bloqueado por reservas abiertas (db/migrations/0051).
 * - `42501` con la regla `tenant_move_forbidden`: quien llamó a `move_tenant_subtree` no es el
 *   superadmin de la plataforma (0051). La API lo comprueba antes; si un endpoint lo olvida, la base
 *   lo rechaza y sale como 403, no como 500.
 *
 * La regla viene en el campo `constraint` del error de Postgres. El mensaje que ve el usuario sale
 * de la tabla de abajo y no del texto de la base: una regla que esta tabla no conoce se publica
 * con un mensaje genérico, así un texto nuevo del SQL nunca llega al navegador sin revisarlo.
 */
export const TENANT_HIERARCHY_SQLSTATE = 'STH01';
export const TENANT_MOVE_BLOCKED_SQLSTATE = 'STH02';
/** `insufficient_privilege`: sólo cuenta con la regla de 0051, no cualquier 42501 (RLS, 0025). */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';
const TENANT_MOVE_FORBIDDEN_CONSTRAINT = 'tenant_move_forbidden';

/** Los motivos que la web puede recibir. Es el nombre de la regla en mayúsculas. */
export type TenantHierarchyReason =
  | 'TENANT_ROOT_MUST_BE_PLATFORM'
  | 'TENANT_SINGLE_PLATFORM'
  | 'TENANT_PLATFORM_IS_ROOT'
  | 'TENANT_BRANCH_TYPE'
  | 'TENANT_BRANCH_PARENT'
  | 'TENANT_PARENT_TYPE'
  | 'TENANT_CHILDREN_TYPE'
  | 'TENANT_DEPTH_LIMIT'
  | 'TENANT_PARENT_NOT_FOUND'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_MOVE_CYCLE'
  | 'TENANT_MOVE_REQUIRED'
  | 'TENANT_MOVE_OPEN_WALLET_BOOKINGS'
  | 'TENANT_MOVE_OPEN_INHERITED_BOOKINGS'
  | 'TENANT_MOVE_FORBIDDEN'
  | 'TENANT_HIERARCHY_VIOLATION';

const MESSAGES: Readonly<Record<TenantHierarchyReason, string>> = {
  TENANT_ROOT_MUST_BE_PLATFORM:
    'Sólo la plataforma puede ser raíz: el nodo tiene que colgar de un nodo de la red.',
  TENANT_SINGLE_PLATFORM: 'La red ya tiene su plataforma: sólo puede haber una.',
  TENANT_PLATFORM_IS_ROOT: 'La plataforma es la raíz de la red: no puede colgar de otro nodo.',
  TENANT_BRANCH_TYPE: 'Una sucursal es una agencia: no puede ser de otro tipo.',
  TENANT_BRANCH_PARENT: 'Una sucursal cuelga directamente de la plataforma.',
  TENANT_PARENT_TYPE:
    'Ese tipo de nodo no puede colgar de ese padre. Bajo la plataforma van consolidadores y ' +
    'agencias; bajo un consolidador, agencias; bajo una agencia, sub-agencias.',
  TENANT_CHILDREN_TYPE: 'El nodo tiene hijos que no pueden colgar de un nodo de ese tipo.',
  TENANT_DEPTH_LIMIT: 'La red admite como máximo 4 niveles.',
  TENANT_PARENT_NOT_FOUND: 'El nodo padre no existe.',
  TENANT_NOT_FOUND: 'El nodo no existe.',
  TENANT_MOVE_CYCLE: 'Un nodo no puede moverse debajo de sí mismo ni de uno de sus descendientes.',
  TENANT_MOVE_REQUIRED: 'El padre de un nodo sólo se cambia moviéndolo con todo su subárbol.',
  TENANT_MOVE_OPEN_WALLET_BOOKINGS:
    'El nodo o su red tiene reservas abiertas pagadas con cartera: hay que cerrarlas o ' +
    'cancelarlas antes de moverlo.',
  TENANT_MOVE_OPEN_INHERITED_BOOKINGS:
    'El nodo o su red tiene reservas abiertas hechas con credenciales que dejaría de heredar: ' +
    'hay que cerrarlas o cancelarlas antes de moverlo.',
  TENANT_MOVE_FORBIDDEN: 'Sólo el superadmin de la plataforma puede mover un nodo de la red.',
  TENANT_HIERARCHY_VIOLATION: 'La operación no respeta las reglas de la red.',
};

/**
 * Las reglas que la base garantiza sin trigger (0050): la plataforma única es un índice único (una
 * segunda plataforma es un 23505 sobre él), y los CHECK respaldan dos reglas del trigger por si
 * alguien escribiera sin pasar por él. Dicen lo mismo que la regla.
 */
const BACKSTOP_CONSTRAINTS: Readonly<Record<string, TenantHierarchyReason>> = {
  uq_tenants_single_platform: 'TENANT_SINGLE_PLATFORM',
  tenants_platform_is_root: 'TENANT_PLATFORM_IS_ROOT',
  tenants_branch_is_agency: 'TENANT_BRANCH_TYPE',
};

const NOT_FOUND: ReadonlySet<TenantHierarchyReason> = new Set([
  'TENANT_NOT_FOUND',
  'TENANT_PARENT_NOT_FOUND',
]);

function isReason(value: string): value is TenantHierarchyReason {
  return Object.prototype.hasOwnProperty.call(MESSAGES, value);
}

/** Una regla de la jerarquía violada. 409, o 404 si el nodo o su padre no existen. */
export class TenantHierarchyError extends ConflictException {
  readonly reason: TenantHierarchyReason;

  constructor(reason: TenantHierarchyReason) {
    super(MESSAGES[reason]);
    this.reason = reason;
    this.name = 'TenantHierarchyError';
  }
}

/** Quien pidió mover el nodo no es el superadmin de la plataforma. 403. */
export class TenantMoveForbiddenError extends ForbiddenException {
  readonly reason: TenantHierarchyReason = 'TENANT_MOVE_FORBIDDEN';

  constructor() {
    super(MESSAGES.TENANT_MOVE_FORBIDDEN);
    this.name = 'TenantMoveForbiddenError';
  }
}

/** El nodo o el padre que nombra la operación no existe. */
export class TenantHierarchyNotFoundError extends NotFoundException {
  readonly reason: TenantHierarchyReason;

  constructor(reason: TenantHierarchyReason) {
    super(MESSAGES[reason]);
    this.reason = reason;
    this.name = 'TenantHierarchyNotFoundError';
  }
}

interface PgErrorFields {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function reasonOf(code: string, constraint: string | undefined): TenantHierarchyReason | undefined {
  if (code === TENANT_HIERARCHY_SQLSTATE || code === TENANT_MOVE_BLOCKED_SQLSTATE) {
    const candidate = constraint?.toUpperCase() ?? '';
    return isReason(candidate) ? candidate : 'TENANT_HIERARCHY_VIOLATION';
  }
  if (code === INSUFFICIENT_PRIVILEGE_SQLSTATE && constraint === TENANT_MOVE_FORBIDDEN_CONSTRAINT) {
    return 'TENANT_MOVE_FORBIDDEN';
  }
  // 23505 (unique_violation) y 23514 (check_violation): sólo los respaldos de la jerarquía.
  if ((code === '23505' || code === '23514') && constraint !== undefined) {
    return BACKSTOP_CONSTRAINTS[constraint];
  }
  return undefined;
}

/**
 * La excepción HTTP de un error de la jerarquía de tenants, o `undefined` si el error es otra cosa
 * (y sigue su camino: un error de base desconocido es un 500).
 */
export function tenantHierarchyHttpError(
  error: unknown,
): TenantHierarchyError | TenantHierarchyNotFoundError | TenantMoveForbiddenError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as PgErrorFields;
  if (typeof code !== 'string') return undefined;
  const reason = reasonOf(code, typeof constraint === 'string' ? constraint : undefined);
  if (reason === undefined) return undefined;
  if (reason === 'TENANT_MOVE_FORBIDDEN') return new TenantMoveForbiddenError();
  return NOT_FOUND.has(reason)
    ? new TenantHierarchyNotFoundError(reason)
    : new TenantHierarchyError(reason);
}
