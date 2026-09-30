import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Puestos simultáneos de un nodo (decisiones del founder del 2026-09-29), sin base: cómo se arma la
 * vista de puestos que ve un admin y qué sesiones le corresponden. La base resuelve el cupo
 * (`seat_pool_of`), la inactividad efectiva y quién ocupa cada puesto (`pool_active_sessions`,
 * db/migrations/0055); esto decide qué de eso se muestra.
 */

/** Fijar puestos o inactividad de un nodo es sólo del superadmin, también al crearlo. 403. */
export class TenantSeatsSuperadminOnlyError extends ForbiddenException {
  readonly reason = 'TENANT_SEATS_SUPERADMIN_ONLY';

  constructor() {
    super('Sólo el superadmin fija los puestos simultáneos y la inactividad de un nodo.');
    this.name = 'TenantSeatsSuperadminOnlyError';
  }
}

/**
 * La sesión no ocupa un puesto de este nodo: no existe, ya se cerró, venció, superó su inactividad
 * o es de un nodo que no cuelga de éste. Un solo motivo para todo, así no se puede sondear si una
 * sesión ajena existe. 404.
 */
export class SeatSessionNotFoundError extends NotFoundException {
  readonly reason = 'SEAT_SESSION_NOT_FOUND';

  constructor() {
    super('Esa sesión ya no ocupa un puesto en este nodo.');
    this.name = 'SeatSessionNotFoundError';
  }
}

/** Liberar el propio puesto desde Equipo: para eso está "Cerrar sesión". 403. */
export class SeatReleaseSelfError extends ForbiddenException {
  readonly reason = 'SEAT_RELEASE_SELF';

  constructor() {
    super('No podés liberar tu propio puesto desde acá: usá "Cerrar sesión".');
    this.name = 'SeatReleaseSelfError';
  }
}

/** Una fila de `pool_active_sessions` con el `path` del nodo de la sesión. */
export interface PoolSessionRow {
  session_id: string;
  user_id: string;
  email: string;
  name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  issued_at: Date;
  last_seen_at: Date;
  ip: string | null;
  user_agent: string | null;
  /** `tenants.path` del nodo de la sesión, como texto (ltree). */
  tenant_path: string | null;
}

/** Quién ocupa un puesto, como lo ve el admin. */
export interface SeatSession {
  sessionId: string;
  userId: string;
  name: string | null;
  email: string;
  tenantId: string;
  tenantName: string | null;
  issuedAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  /** User-agent crudo: la web lo resume ("Chrome en Windows"). */
  device: string | null;
  /** Es la sesión de quien mira: la web no le ofrece desconectarse a sí mismo. */
  current: boolean;
}

/** `GET /tenants/:id/seats`. */
export interface SeatsView {
  /** Nodo cuyo cupo consume éste (él mismo o un ancestro). `null` = sin límite. */
  poolTenantId: string | null;
  poolTenantName: string | null;
  /** El cupo es de un ancestro: los puestos se comparten con el resto de su red. */
  inherited: boolean;
  /** Puestos del cupo. `null` = sin límite. */
  limit: number | null;
  /** Puestos ocupados en TODO el cupo, no sólo en este subárbol: es lo que se compara con `limit`. */
  inUse: number;
  /** Minutos de inactividad que rigen en el nodo (propios, heredados o los 30 por defecto). */
  idleTimeoutMinutes: number;
  /** El nodo no fija su inactividad: la hereda. */
  idleInherited: boolean;
  /** Lo que fija el propio nodo (lo que edita el superadmin). `null` = hereda. */
  ownSeats: number | null;
  ownIdleTimeoutMinutes: number | null;
  /** Las sesiones del cupo abiertas en este nodo o debajo, de la más reciente a la más vieja. */
  sessions: SeatSession[];
}

/**
 * ¿`path` es `rootPath` o cuelga de él? Es el `path <@ root` de ltree: etiquetas separadas por
 * punto, así que `a.b` no es descendiente de `a.bc`.
 */
export function isWithinSubtree(path: string | null, rootPath: string): boolean {
  if (path === null || rootPath === '') return false;
  return path === rootPath || path.startsWith(`${rootPath}.`);
}

export interface SeatsViewInput {
  tenantId: string;
  tenantPath: string;
  ownSeats: number | null;
  ownIdleTimeoutMinutes: number | null;
  idleTimeoutMinutes: number;
  pool: { id: string; name: string; limit: number } | null;
  /** Todas las sesiones que ocupan el cupo (`pool_active_sessions`), de cualquier nodo. */
  poolSessions: readonly PoolSessionRow[];
  /** La sesión de quien pide la vista, para marcarla. */
  currentSessionId?: string | undefined;
}

/**
 * La vista de puestos de un nodo.
 *
 * Las sesiones se acotan al subárbol del nodo: un cupo compartido lo usan varias agencias hermanas y
 * el admin de una no tiene por qué ver quién está conectado en la otra, ni desconectarlo. El conteo
 * (`inUse`) sí es el del cupo entero, porque es lo que decide si alguien más puede entrar.
 *
 * Sin cupo no hay sesiones que mostrar: sólo las que consumen puesto guardan su nodo de cupo.
 */
export function buildSeatsView(input: SeatsViewInput): SeatsView {
  const { pool } = input;
  const sessions =
    pool === null
      ? []
      : input.poolSessions.flatMap((row) =>
          row.tenant_id !== null && isWithinSubtree(row.tenant_path, input.tenantPath)
            ? [toSeatSession(row, row.tenant_id, row.session_id === input.currentSessionId)]
            : [],
        );

  return {
    poolTenantId: pool?.id ?? null,
    poolTenantName: pool?.name ?? null,
    inherited: pool !== null && pool.id !== input.tenantId,
    limit: pool?.limit ?? null,
    inUse: pool === null ? 0 : input.poolSessions.length,
    idleTimeoutMinutes: input.idleTimeoutMinutes,
    idleInherited: input.ownIdleTimeoutMinutes === null,
    ownSeats: input.ownSeats,
    ownIdleTimeoutMinutes: input.ownIdleTimeoutMinutes,
    sessions,
  };
}

function toSeatSession(row: PoolSessionRow, tenantId: string, current: boolean): SeatSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    tenantId,
    tenantName: row.tenant_name,
    issuedAt: row.issued_at,
    lastSeenAt: row.last_seen_at,
    ip: row.ip,
    device: row.user_agent,
    current,
  };
}
