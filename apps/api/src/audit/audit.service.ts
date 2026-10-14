import { Injectable, Logger } from '@nestjs/common';
import { sql, type Insertable, type RawBuilder, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { DB, DomainEventsTable } from '../database/database.types.js';
import { currentContext } from '../request-context/request-context.js';
import {
  encodeAuditCursor,
  NETWORK_AUDIT_MAX_PAGE,
  NETWORK_AUDIT_PAGE_SIZE,
  USER_AUDIT_MAX_PAGE,
  USER_AUDIT_PAGE_SIZE,
  type AuditCategory,
  type AuditCursor,
} from './audit.schemas.js';

export interface AuditEvent {
  eventType: string;
  tenantId?: string | null;
  actorUserId?: string | null;
  aggregateType?: string;
  aggregateId?: string;
  /** NUNCA incluir secretos/credenciales/PII sensible. */
  payload?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  eventType: string;
  tenantId: string | null;
  tenantName: string | null;
  actorEmail: string | null;
  /**
   * La cuenta sobre la que se hizo, si no es la de quien lo hizo (`payload.targetUserId`, o la
   * cuenta del agregado): "a quién". Ver audit_event_target_user (0065).
   */
  targetEmail: string | null;
  aggregateType: string | null;
  payload: Record<string, unknown>;
}

/**
 * Los eventos de las tareas automáticas (`system.*`, p. ej. cada corrida del barrido de post-venta,
 * orders/post-sale-sweep-events.ts). Son latidos, no acciones de una persona: la actividad de la red
 * los deja fuera y los lee Plataforma → Sistema › Procesos.
 */
export const SYSTEM_EVENT_PREFIX = 'system.';

/** Una página del audit log, del evento más nuevo al más viejo. */
export interface AuditPage {
  events: AuditEntry[];
  /** Lo que se manda como `before` para pedir la página siguiente; `null` si no hay más. */
  nextBefore: string | null;
}

export interface AuditPageOptions {
  /** Desde dónde sigue (el `nextBefore` de la página anterior, ya leído). */
  before?: AuditCursor;
  limit?: number;
}

export interface NetworkAuditOptions extends AuditPageOptions {
  category?: AuditCategory;
  /** Sólo lo que hizo esta persona. */
  actorUserId?: string;
}

/**
 * Qué eventos entran en cada filtro de la Actividad de la red, por el prefijo de `event_type`. La
 * web lo espeja en lib/audit-format (categoryOf). `LIKE` distingue mayúsculas: los eventos de
 * dominio van en PascalCase y los de seguridad en minúsculas con puntos.
 */
const CATEGORY_FILTERS: Readonly<Record<AuditCategory, RawBuilder<boolean>>> = {
  users: sql<boolean>`(e.event_type LIKE 'auth.%' OR e.event_type LIKE 'users.%'
    OR e.event_type LIKE 'User%' OR e.event_type LIKE 'Membership%')`,
  credentials: sql<boolean>`e.event_type LIKE 'ProviderCredentials%'`,
  pricing: sql<boolean>`e.event_type LIKE 'Markup%'`,
  network: sql<boolean>`(e.event_type LIKE 'Tenant%' OR e.event_type LIKE 'tenant.%')`,
};

const ALL = sql<boolean>`true`;

/** El patrón de los `system.*`, como literal: no corre los parámetros de la consulta. */
const NOT_SYSTEM_EVENT = sql.lit(`${SYSTEM_EVENT_PREFIX}%`);

/** Lo de antes del cursor, en el orden del historial: (occurred_at, id) descendente. */
function beforeCursor(before: AuditCursor | undefined): RawBuilder<boolean> {
  if (before === undefined) return ALL;
  return sql<boolean>`(e.occurred_at, e.id) < (${before.occurredAt}::timestamptz, ${before.id}::uuid)`;
}

/**
 * Un evento es de la persona si lo hizo ella, si el agregado es su cuenta o si el payload la nombra
 * como objetivo. El último término repite el predicado del índice parcial de 0065 para que el
 * planificador lo use; el `lower` cubre los bordes que guardan el id como lo mandó el cliente.
 */
function concerns(userId: string): RawBuilder<boolean> {
  return sql<boolean>`(
    e.actor_user_id = ${userId}::uuid
    OR (e.aggregate_type = 'user' AND e.aggregate_id = ${userId})
    OR (e.payload ? 'targetUserId' AND lower(e.payload ->> 'targetUserId') = ${userId})
  )`;
}

/** `column <@` el `path` del nodo raíz: el nodo y todo lo que cuelga de él. */
function withinRoot(column: string, rootTenantId: string): RawBuilder<boolean> {
  return sql<boolean>`${sql.ref(column)} OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${rootTenantId}::uuid)`;
}

function pageLimit(requested: number | undefined, fallback: number, max: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(requested)));
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  /** El instante en texto con microsegundos, para el cursor: un `Date` los pierde. */
  cursor_at: string;
  event_type: string;
  tenant_id: string | null;
  tenant_name: string | null;
  actor_email: string | null;
  target_email: string | null;
  aggregate_type: string | null;
  payload: unknown;
}

const CURSOR_AT = sql<string>`to_char(p.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * La página ya cortada (`page`, con una fila de más) con quién lo hizo y sobre quién. Los correos se
 * buscan después de cortar: sólo para las filas que se devuelven.
 *
 * El "a quién" sólo se nombra si esa persona tiene una membership (de cualquier estado) bajo
 * `rootTenantId`, leída con la RLS de quien mira. Un evento del subárbol puede apuntar a alguien de
 * otra red (la suspensión global queda con el nodo de la sesión del superadmin, y ése puede ser uno
 * de esta red): su correo no es de este subárbol y no sale.
 */
function pageSelect(rootTenantId: string): RawBuilder<AuditRow> {
  return sql<AuditRow>`
    SELECT p.id, p.occurred_at, ${CURSOR_AT} AS cursor_at, p.event_type, p.tenant_id,
           p.tenant_name, u.email AS actor_email, tu.email AS target_email, p.aggregate_type,
           p.payload
      FROM page p
      LEFT JOIN users u  ON u.id  = p.actor_user_id
      LEFT JOIN users tu ON tu.id = audit_event_target_user(
                                      p.payload, p.aggregate_type, p.aggregate_id, p.actor_user_id)
                        AND EXISTS (
                          SELECT 1
                            FROM memberships tm
                            JOIN tenants tt ON tt.id = tm.tenant_id
                           WHERE tm.user_id = tu.id
                             AND ${withinRoot('tt.path', rootTenantId)}
                        )
     ORDER BY p.occurred_at DESC, p.id DESC
  `;
}

/** Pide `limit + 1` filas: la de más sólo dice si hay otra página. */
function toPage(rows: readonly AuditRow[], limit: number): AuditPage {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    events: shown.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      eventType: r.event_type,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      actorEmail: r.actor_email,
      targetEmail: r.target_email,
      aggregateType: r.aggregate_type,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    })),
    nextBefore:
      rows.length > limit && last !== undefined
        ? encodeAuditCursor({ occurredAt: last.cursor_at, id: last.id })
        : null,
  };
}

/** La fila de `domain_events` de un evento, con el actor y el tenant del request si no vienen. */
function auditRow(event: AuditEvent): Insertable<DomainEventsTable> {
  const ctx = currentContext();
  return {
    tenant_id: event.tenantId ?? ctx?.tenantId ?? null,
    actor_user_id: event.actorUserId ?? ctx?.userId ?? null,
    event_type: event.eventType,
    aggregate_type: event.aggregateType ?? null,
    aggregate_id: event.aggregateId ?? null,
    payload: JSON.stringify(event.payload ?? {}),
    meta: JSON.stringify({
      requestId: ctx?.requestId ?? null,
      // Sin IP ni user-agent, un audit log de seguridad no sirve para investigar
      // un incidente: no se puede distinguir el acceso legítimo del robado.
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      sessionId: ctx?.sessionId ?? null,
    }),
  };
}

/**
 * Audit log append-only (`domain_events`). Registra acciones sensibles para trazabilidad.
 * `emit` es best-effort: un fallo de auditoría NUNCA debe romper la operación de negocio.
 *
 * Las lecturas devuelven el payload tal cual (nunca lleva secretos, 0015) y nunca `meta` (IP,
 * navegador, sesión). La AUTORIZACIÓN de cada lectura (administrar el nodo, ser superadmin) la
 * valida el controlador antes de llamar; la RLS de domain_events (0029) es la segunda barrera.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  async emit(event: AuditEvent): Promise<void> {
    try {
      await this.db.db.insertInto('domain_events').values(auditRow(event)).execute();
    } catch (err) {
      // No propagar: la auditoría no debe tumbar la acción principal.
      this.logger.warn(`no se pudo registrar ${event.eventType}: ${(err as Error).message}`);
    }
  }

  /**
   * Lo mismo que `emit`, pero dentro de la transacción de quien llama y SIN tragarse el fallo. Es
   * para las lecturas que sólo pueden devolver datos si su rastro quedó escrito (la bóveda de
   * payloads de proveedor): si el evento no entra, la transacción entera se deshace y la lectura
   * no devuelve nada.
   */
  async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
    await trx.insertInto('domain_events').values(auditRow(event)).execute();
  }

  /**
   * La Actividad de la red bajo `rootTenantId` (subárbol por path), con filtro opcional por
   * categoría y por quién lo hizo. Los eventos sin nodo no entran.
   *
   * Tampoco los `system.*` ({@link SYSTEM_EVENT_PREFIX}), con o sin filtro: el barrido deja uno en
   * la raíz `platform` cada 15 minutos y la actividad de la plataforma sólo mostraría eso.
   *
   * Corre con `viewerUserId` en `app.current_user_id`: desde 0029, domain_events tiene RLS por
   * subárbol (domain_events_subtree_read) y sin ese contexto la consulta devolvería cero filas EN
   * SILENCIO en vez de fallar, así que pasarlo es obligatorio, no una optimización.
   */
  async networkAudit(
    viewerUserId: string,
    rootTenantId: string,
    opts: NetworkAuditOptions = {},
  ): Promise<AuditPage> {
    const limit = pageLimit(opts.limit, NETWORK_AUDIT_PAGE_SIZE, NETWORK_AUDIT_MAX_PAGE);
    const category = opts.category === undefined ? ALL : CATEGORY_FILTERS[opts.category];
    const actor =
      opts.actorUserId === undefined
        ? ALL
        : sql<boolean>`e.actor_user_id = ${opts.actorUserId}::uuid`;

    const query = sql<AuditRow>`
      WITH page AS (
        SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, t.name AS tenant_name,
               e.actor_user_id, e.aggregate_type, e.aggregate_id, e.payload
          FROM domain_events e
          JOIN tenants t ON t.id = e.tenant_id
         WHERE ${withinRoot('t.path', rootTenantId)}
           AND e.event_type NOT LIKE ${NOT_SYSTEM_EVENT}
           AND ${category}
           AND ${actor}
           AND ${beforeCursor(opts.before)}
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ${limit + 1}
      )
      ${pageSelect(rootTenantId)}
    `;

    const res = await this.db.withRequestContext(
      { userId: viewerUserId, tenantId: rootTenantId },
      (trx) => query.execute(trx),
    );
    return toPage(res.rows, limit);
  }

  /**
   * El historial de `userId` visto desde el nodo `rootTenantId` (Equipo): lo que hizo y lo que le
   * hicieron en ese subárbol. Los eventos sin nodo (un login fallido) y los de otras redes no
   * entran: los acota la consulta y, de nuevo, la RLS del que mira.
   *
   * `undefined` si la persona no tiene ninguna membership en el subárbol, leída con la RLS de quien
   * mira: así nadie arma el historial de alguien de otra red pasando su id. Una membership
   * suspendida o quitada cuenta: su historial en el nodo sigue siendo del nodo.
   */
  async userAuditTrail(
    viewerUserId: string,
    rootTenantId: string,
    userId: string,
    opts: AuditPageOptions = {},
  ): Promise<AuditPage | undefined> {
    const limit = pageLimit(opts.limit, USER_AUDIT_PAGE_SIZE, USER_AUDIT_MAX_PAGE);
    return this.db.withRequestContext(
      { userId: viewerUserId, tenantId: rootTenantId },
      async (trx) => {
        const member = await trx
          .selectFrom('memberships as m')
          .innerJoin('tenants as t', 't.id', 'm.tenant_id')
          .select('m.id')
          .where('m.user_id', '=', userId)
          .where(withinRoot('t.path', rootTenantId))
          .limit(1)
          .executeTakeFirst();
        if (member === undefined) return undefined;

        const res = await sql<AuditRow>`
          WITH page AS (
            SELECT e.id, e.occurred_at, e.event_type, e.tenant_id, t.name AS tenant_name,
                   e.actor_user_id, e.aggregate_type, e.aggregate_id, e.payload
              FROM domain_events e
              JOIN tenants t ON t.id = e.tenant_id
             WHERE ${withinRoot('t.path', rootTenantId)}
               AND ${concerns(userId)}
               AND ${beforeCursor(opts.before)}
             ORDER BY e.occurred_at DESC, e.id DESC
             LIMIT ${limit + 1}
          )
          ${pageSelect(rootTenantId)}
        `.execute(trx);
        return toPage(res.rows, limit);
      },
    );
  }

  /**
   * El historial de `userId` en toda la plataforma (Plataforma → Usuarios), con los eventos sin
   * nodo: ingresos fallidos, pedidos de restablecer la contraseña, cambios de su 2FA. La RLS no le
   * deja leer ésos a nadie, así que va por platform_user_audit_trail (0065, SECURITY DEFINER), que
   * además no le responde a quien no es superadmin. `undefined` si la cuenta no existe.
   */
  async platformUserAuditTrail(
    viewerUserId: string,
    userId: string,
    opts: AuditPageOptions = {},
  ): Promise<AuditPage | undefined> {
    const limit = pageLimit(opts.limit, USER_AUDIT_PAGE_SIZE, USER_AUDIT_MAX_PAGE);
    return this.db.withRequestContext({ userId: viewerUserId }, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .executeTakeFirst();
      if (user === undefined) return undefined;

      const res = await sql<AuditRow>`
        SELECT p.id, p.occurred_at, ${CURSOR_AT} AS cursor_at, p.event_type, p.tenant_id,
               p.tenant_name, p.actor_email, p.target_email, p.aggregate_type, p.payload
          FROM platform_user_audit_trail(
                 ${userId}::uuid,
                 ${opts.before?.occurredAt ?? null}::timestamptz,
                 ${opts.before?.id ?? null}::uuid,
                 ${limit + 1}::int
               ) p
         ORDER BY p.occurred_at DESC, p.id DESC
      `.execute(trx);
      return toPage(res.rows, limit);
    });
  }
}
