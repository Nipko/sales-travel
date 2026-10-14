import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type {
  DB,
  MembershipStatus,
  Role,
  TenantType,
  UserStatus,
} from '../database/database.types.js';
import {
  decodePlatformUsersCursor,
  encodePlatformUsersCursor,
  PLATFORM_USERS_PAGE_SIZE,
  type ListPlatformUsersQuery,
} from './dto.js';
import { LastSuperadminError, UserNotFoundError } from './platform-users.errors.js';

/** Un nodo de la persona, con su rol y el estado de su acceso a él. */
export interface PlatformUserMembership {
  tenantId: string;
  tenantName: string;
  tenantType: TenantType;
  isBranch: boolean;
  role: Role;
  status: MembershipStatus;
}

/** Una persona del directorio: su identidad global y todos sus nodos. */
export interface PlatformUser {
  id: string;
  email: string;
  name: string | null;
  /** El de la cuenta en toda la plataforma; el de cada nodo va en `memberships`. */
  status: UserStatus;
  emailVerified: boolean;
  mfaEnabled: boolean;
  /** Sólo mientras el bloqueo por intentos fallidos siga vigente. */
  lockedUntil: string | null;
  lastLoginAt: string | null;
  /** Su última actividad en cualquier sesión. */
  lastSeenAt: string | null;
  /** Sesiones vivas ahora (no revocadas, no vencidas, dentro de su inactividad). */
  activeSessions: number;
  createdAt: string;
  memberships: PlatformUserMembership[];
}

export interface PlatformUsersPage {
  users: PlatformUser[];
  /** Para pedir la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
}

/** Lo que pierde una cuenta si se la suspende en toda la plataforma, para decirlo antes. */
export interface UserFootprint {
  activeMemberships: number;
  liveSessions: number;
}

/**
 * El texto de la búsqueda como patrón de ILIKE que lo busca tal cual: `%` y `_` son comodines y la
 * barra es el escape por defecto de LIKE. Sin esto, buscar "_" traía a todos.
 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Cuántas personas trae la página. */
export function pageSize(query: Pick<ListPlatformUsersQuery, 'limit'>): number {
  return query.limit ?? PLATFORM_USERS_PAGE_SIZE;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * La página de personas, sin sus nodos ni sus sesiones: los filtros, el orden (altas más recientes
 * primero, desempate por id) y una fila de más para saber si hay otra página.
 *
 * El instante del cursor sale de Postgres en texto con microsegundos: un `Date` de JavaScript los
 * trunca a milisegundos y la comparación con la fila siguiente podía saltarla.
 */
export function directoryQuery(db: Kysely<DB>, query: ListPlatformUsersQuery) {
  const { q, status, role, tenantId, mfa, locked, neverLoggedIn } = query;
  const cursor = query.cursor === undefined ? undefined : decodePlatformUsersCursor(query.cursor);
  const limit = pageSize(query);
  return db
    .selectFrom('users as u')
    .select([
      'u.id',
      'u.email',
      'u.name',
      'u.status',
      'u.email_verified_at',
      'u.mfa_enabled_at',
      'u.last_login_at',
      // Generated<Timestamp> se selecciona como ColumnType anidado, no como Date.
      sql<Date>`u.created_at`.as('created_at'),
      sql<Date | null>`CASE WHEN u.locked_until > now() THEN u.locked_until END`.as('locked_until'),
      sql<string>`to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursor_at',
      ),
    ])
    .$if(q !== undefined, (qb) => {
      const pattern = likePattern(q ?? '');
      return qb.where((eb) =>
        eb.or([eb('u.email', 'ilike', pattern), eb('u.name', 'ilike', pattern)]),
      );
    })
    .$if(status !== undefined, (qb) => qb.where('u.status', '=', status as UserStatus))
    .$if(role !== undefined || tenantId !== undefined, (qb) =>
      qb.where((eb) =>
        eb.exists(
          eb
            .selectFrom('memberships as m')
            .innerJoin('tenants as t', 't.id', 'm.tenant_id')
            .select(sql<number>`1`.as('one'))
            .whereRef('m.user_id', '=', 'u.id')
            .where('m.status', '!=', 'removed')
            .$if(role !== undefined, (sub) => sub.where('m.role', '=', role as Role))
            .$if(tenantId !== undefined, (sub) =>
              sub.where(
                sql<boolean>`t.path OPERATOR(public.<@) (SELECT root.path FROM tenants root WHERE root.id = ${tenantId}::uuid)`,
              ),
            ),
        ),
      ),
    )
    .$if(mfa === 'on', (qb) => qb.where('u.mfa_enabled_at', 'is not', null))
    .$if(mfa === 'off', (qb) => qb.where('u.mfa_enabled_at', 'is', null))
    .$if(locked === 'true', (qb) => qb.where(sql<boolean>`u.locked_until > now()`))
    .$if(neverLoggedIn === 'true', (qb) => qb.where('u.last_login_at', 'is', null))
    .$if(cursor !== undefined, (qb) =>
      qb.where(
        sql<boolean>`(u.created_at, u.id) < (${cursor?.createdAt}::timestamptz, ${cursor?.id}::uuid)`,
      ),
    )
    .orderBy('u.created_at', 'desc')
    .orderBy('u.id', 'desc')
    .limit(limit + 1);
}

interface SessionStats {
  user_id: string;
  last_seen_at: Date | null;
  active_sessions: number | string;
}

function sessionStats(db: Kysely<DB>, userIds: readonly string[]) {
  return sql<SessionStats>`
    SELECT user_id, last_seen_at, active_sessions
      FROM platform_user_session_stats(${[...userIds]}::uuid[])
  `.execute(db);
}

/**
 * El directorio de personas de toda la red para el superadmin (Plataforma → Usuarios) y lo que
 * necesita la suspensión de una cuenta en toda la plataforma.
 *
 * Quién puede lo decide el controlador (sólo superadmin) ANTES de llamar acá. Todo corre con el
 * contexto del actor: `users` no tiene RLS (identidad global) y la RLS de memberships le deja al
 * superadmin leerlas todas (0020). Las sesiones tienen RLS por usuario: de ellas sólo se lee el
 * resumen de `platform_user_session_stats` (0063), nunca las sesiones.
 */
@Injectable()
export class PlatformUsersService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Una página del directorio: una fila por persona, con todos sus nodos y roles. Quien no tiene
   * ninguna membership también aparece (una cuenta que quedó sin nodos sigue existiendo).
   */
  async list(actorUserId: string, query: ListPlatformUsersQuery): Promise<PlatformUsersPage> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const limit = pageSize(query);
      const rows = await directoryQuery(trx, query).execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodePlatformUsersCursor({ createdAt: last.cursor_at, id: last.id })
          : null;
      if (page.length === 0) return { users: [], nextCursor };

      const ids = page.map((r) => r.id);
      const memberships = await trx
        .selectFrom('memberships as m')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .select([
          'm.user_id',
          'm.tenant_id',
          't.name as tenant_name',
          't.tenant_type',
          't.is_branch',
          'm.role',
          'm.status',
        ])
        .where('m.user_id', 'in', ids)
        // Los nodos de los que la quitaron (USR-11) ya no son suyos; su historial lo cuenta.
        .where('m.status', '!=', 'removed')
        // Primero los accesos activos y los nodos más altos: el primero es el que abre "Ver en
        // Equipo".
        .orderBy(sql`(m.status = 'active')`, 'desc')
        .orderBy(sql`nlevel(t.path)`)
        .orderBy('t.name')
        .orderBy('m.tenant_id')
        .execute();
      const stats = await sessionStats(trx, ids);

      const nodesOf = new Map<string, PlatformUserMembership[]>();
      for (const m of memberships) {
        const list = nodesOf.get(m.user_id) ?? [];
        list.push({
          tenantId: m.tenant_id,
          tenantName: m.tenant_name,
          tenantType: m.tenant_type,
          isBranch: m.is_branch,
          role: m.role,
          status: m.status,
        });
        nodesOf.set(m.user_id, list);
      }
      const statsOf = new Map(stats.rows.map((s) => [s.user_id, s]));

      return {
        users: page.map((r): PlatformUser => {
          const s = statsOf.get(r.id);
          return {
            id: r.id,
            email: r.email,
            name: r.name,
            status: r.status,
            emailVerified: r.email_verified_at !== null,
            mfaEnabled: r.mfa_enabled_at !== null,
            lockedUntil: iso(r.locked_until),
            lastLoginAt: iso(r.last_login_at),
            lastSeenAt: iso(s?.last_seen_at),
            activeSessions: Number(s?.active_sessions ?? 0),
            createdAt: iso(r.created_at) ?? r.cursor_at,
            memberships: nodesOf.get(r.id) ?? [],
          };
        }),
        nextCursor,
      };
    });
  }

  /** Sus accesos activos y sus sesiones vivas. 404 si la cuenta no existe. */
  async footprint(actorUserId: string, targetUserId: string): Promise<UserFootprint> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', targetUserId)
        .executeTakeFirst();
      if (!user) throw new UserNotFoundError();

      const memberships = await trx
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', targetUserId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const stats = await sessionStats(trx, [targetUserId]);
      return {
        activeMemberships: Number(memberships?.n ?? 0),
        liveSessions: Number(stats.rows[0]?.active_sessions ?? 0),
      };
    });
  }

  /**
   * 409 si suspender a `targetUserId` dejaría la plataforma sin ningún superadmin activo (cuenta
   * activa con una membership de superadmin activa). Va en la transacción de la suspensión.
   *
   * Quien suspende ya es un superadmin activo, así que esto sólo se da en una carrera: dos
   * superadmins que se suspenden uno al otro a la vez. Para que la segunda vea la primera, bloquea
   * las filas de los superadmins activos (en orden de id, para no cruzarse) antes de contarlas: la
   * otra transacción espera y, al seguir, Postgres vuelve a evaluar la fila que cambió y ya no la
   * cuenta.
   */
  async assertNotLastSuperadmin(trx: Transaction<DB>, targetUserId: string): Promise<void> {
    const target = await trx
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', targetUserId)
      .where('role', '=', 'superadmin')
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!target) return;

    const active = await trx
      .selectFrom('users as u')
      .select('u.id')
      .where('u.status', '=', 'active')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('memberships as m')
            .select(sql<number>`1`.as('one'))
            .whereRef('m.user_id', '=', 'u.id')
            .where('m.role', '=', 'superadmin')
            .where('m.status', '=', 'active'),
        ),
      )
      .orderBy('u.id')
      .forUpdate()
      .execute();
    if (!active.some((u) => u.id !== targetUserId)) throw new LastSuperadminError();
  }
}
