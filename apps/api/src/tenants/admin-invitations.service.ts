import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import {
  decodePlatformUsersCursor,
  encodePlatformUsersCursor,
  PLATFORM_INVITATIONS_PAGE_SIZE,
  type ListPlatformInvitationsQuery,
  type PlatformInvitationState,
} from './dto.js';
import { SuperadminOnlyError } from './member-detail.errors.js';
import { likePattern } from './platform-users.service.js';

/** Una invitación sin aceptar ni revocar, con su nodo y quién la respalda. */
export interface PlatformInvitation {
  id: string;
  email: string;
  role: Role;
  tenantId: string;
  tenantName: string;
  /** Quien la emitió o la reenvió por última vez; `null` si esa cuenta ya no existe. */
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
  /** Si el enlace ya venció. Se reenvía igual: es la forma de que la persona reciba uno que sirva. */
  expired: boolean;
}

/** Cuántas hay de cada estado con la búsqueda y el nodo pedidos, sin importar `state` ni el cursor. */
export interface PlatformInvitationCounts {
  pending: number;
  expired: number;
}

export interface PlatformInvitationsPage {
  invitations: PlatformInvitation[];
  /** Para pedir la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
  counts: PlatformInvitationCounts;
}

/** El estado pedido; sin él, las pendientes. */
export function invitationState(query: Pick<ListPlatformInvitationsQuery, 'state'>) {
  return query.state ?? 'pending';
}

/** Cuántas invitaciones trae la página. */
export function invitationsPageSize(query: Pick<ListPlatformInvitationsQuery, 'limit'>): number {
  return query.limit ?? PLATFORM_INVITATIONS_PAGE_SIZE;
}

/**
 * Las invitaciones que no se aceptaron ni se revocaron, con la búsqueda por correo y el nodo (con su
 * subárbol) pedidos. Lo comparten la página y los contadores, para que digan lo mismo.
 */
function unanswered(db: Kysely<DB>, query: ListPlatformInvitationsQuery) {
  const { q, tenantId } = query;
  return db
    .selectFrom('user_invitations as i')
    .innerJoin('tenants as t', 't.id', 'i.tenant_id')
    .where('i.accepted_at', 'is', null)
    .where('i.revoked_at', 'is', null)
    .$if(q !== undefined, (qb) => qb.where('i.email', 'ilike', likePattern(q ?? '')))
    .$if(tenantId !== undefined, (qb) =>
      qb.where(
        sql<boolean>`t.path OPERATOR(public.<@) (SELECT root.path FROM tenants root WHERE root.id = ${tenantId}::uuid)`,
      ),
    );
}

/**
 * La página de invitaciones: el estado, el orden (las más recientes primero, desempate por id) y una
 * fila de más para saber si hay otra página. Vencida es `expires_at <= now()`, el mismo corte que el
 * canje (claim_pending_invitation, 0056): una que vence en este instante ya no se puede aceptar.
 *
 * El instante del cursor sale de Postgres en texto con microsegundos: un `Date` de JavaScript los
 * trunca a milisegundos y la comparación con la fila siguiente podía saltarla.
 */
export function invitationsQuery(db: Kysely<DB>, query: ListPlatformInvitationsQuery) {
  const state: PlatformInvitationState = invitationState(query);
  const cursor = query.cursor === undefined ? undefined : decodePlatformUsersCursor(query.cursor);
  return unanswered(db, query)
    .leftJoin('users as u', 'u.id', 'i.invited_by')
    .select([
      'i.id',
      'i.email',
      'i.role',
      'i.tenant_id',
      't.name as tenant_name',
      'u.email as invited_by_email',
      'i.created_at',
      'i.expires_at',
      sql<boolean>`i.expires_at <= now()`.as('expired'),
      sql<string>`to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'cursor_at',
      ),
    ])
    .$if(state === 'pending', (qb) => qb.where(sql<boolean>`i.expires_at > now()`))
    .$if(state === 'expired', (qb) => qb.where(sql<boolean>`i.expires_at <= now()`))
    .$if(cursor !== undefined, (qb) =>
      qb.where(
        sql<boolean>`(i.created_at, i.id) < (${cursor?.createdAt}::timestamptz, ${cursor?.id}::uuid)`,
      ),
    )
    .orderBy('i.created_at', 'desc')
    .orderBy('i.id', 'desc')
    .limit(invitationsPageSize(query) + 1);
}

/** Pendientes y vencidas con la búsqueda y el nodo pedidos. */
export function invitationCountsQuery(db: Kysely<DB>, query: ListPlatformInvitationsQuery) {
  return unanswered(db, query).select([
    sql<string>`count(*) FILTER (WHERE i.expires_at > now())`.as('pending'),
    sql<string>`count(*) FILTER (WHERE i.expires_at <= now())`.as('expired'),
  ]);
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Las invitaciones que nadie aceptó todavía, de todos los nodos de la red, para el superadmin
 * (Plataforma → Usuarios → Invitaciones). Antes había que recorrerlas nodo por nodo desde Equipo.
 *
 * Sólo lee: reenviar y revocar van por las rutas de siempre (`/invitations/:id/resend|revoke`), con
 * el nodo de cada fila, y ahí se decide el rango. Corre con el contexto del actor: la RLS de
 * user_invitations (0028, can_read_membership) le deja al superadmin leerlas todas, y `users` y
 * `tenants` no tienen RLS. Nunca sale el hash del token.
 */
@Injectable()
export class AdminInvitationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
  ) {}

  /**
   * Una página, con los contadores de pendientes y vencidas. 403 a quien no es superadmin, antes de
   * leer nada: el chequeo vive acá y no en el controlador para que ningún llamador pueda saltearlo.
   * La página y los contadores van en la misma transacción, así que comparten el `now()`.
   */
  async list(
    actorUserId: string,
    query: ListPlatformInvitationsQuery,
  ): Promise<PlatformInvitationsPage> {
    if (!(await this.network.isSuperadmin(actorUserId))) throw new SuperadminOnlyError();

    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const limit = invitationsPageSize(query);
      const rows = await invitationsQuery(trx, query).execute();
      const counted = await invitationCountsQuery(trx, query).executeTakeFirst();

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        invitations: page.map(
          (r): PlatformInvitation => ({
            id: r.id,
            email: r.email,
            role: r.role,
            tenantId: r.tenant_id,
            tenantName: r.tenant_name,
            invitedByEmail: r.invited_by_email,
            createdAt: iso(r.created_at),
            expiresAt: iso(r.expires_at),
            expired: r.expired,
          }),
        ),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodePlatformUsersCursor({ createdAt: last.cursor_at, id: last.id })
            : null,
        counts: {
          pending: Number(counted?.pending ?? 0),
          expired: Number(counted?.expired ?? 0),
        },
      };
    });
  }
}
