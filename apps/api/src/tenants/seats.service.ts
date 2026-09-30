import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';
import { NetworkService } from '../network/network.service.js';
import { currentContext } from '../request-context/request-context.js';
import type { UpdateSeatsDto } from './dto.js';
import {
  buildSeatsView,
  isWithinSubtree,
  SeatReleaseSelfError,
  SeatSessionNotFoundError,
  type PoolSessionRow,
  type SeatsView,
} from './seats.policy.js';
import { TenantNotManagedError } from './tenant-admin.policy.js';

/** Motivo con que queda revocada la sesión que un admin desconecta desde Equipo (SESSION_RELEASED). */
export const ADMIN_RELEASED_REASON = 'admin_released';

interface NodeRow {
  id: string;
  path: string;
  concurrent_seats: number | null;
  idle_timeout_minutes: number | null;
  pool_id: string | null;
  idle_minutes: number | string;
}

interface PoolRow {
  id: string;
  name: string;
  concurrent_seats: number | null;
}

/** Los campos que edita el PATCH, con su nombre en la API y en la tabla. */
const SEAT_FIELDS = [
  ['concurrentSeats', 'concurrent_seats'],
  ['idleTimeoutMinutes', 'idle_timeout_minutes'],
] as const;

/**
 * Puestos simultáneos e inactividad de un nodo: la vista del admin, desconectar a alguien para
 * liberar su puesto, y fijar el cupo (sólo superadmin).
 *
 * `sessions` tiene RLS por usuario: todo lo que toca sesiones ajenas pasa por las funciones
 * SECURITY DEFINER de 0055 (`seat_pool_of`, `pool_active_sessions`, `revoke_session`,
 * `refresh_session_idle_timeouts`), que NO autorizan. La autorización vive acá y se valida antes.
 */
@Injectable()
export class SeatsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /tenants/:id/seats`: cupo, uso, inactividad y quién ocupa un puesto en este subárbol. */
  async view(actorUserId: string, tenantId: string): Promise<SeatsView> {
    await this.assertCanManage(actorUserId, tenantId);
    return this.db.withRequestContext({ userId: actorUserId }, (trx) =>
      this.readView(trx, tenantId),
    );
  }

  /**
   * Desconecta una sesión para liberar su puesto (`revoke_session(id, 'admin_released')`): su
   * próximo request al API responde SESSION_RELEASED. El panel muestra "Un administrador liberó tu
   * puesto" en la próxima pantalla que cargue, apenas un fetch suyo recibe el 401 (le pide a la
   * guardia que confirme ya) o, si no hace nada, en el próximo ping de la guardia (≤ 60 s con la
   * pestaña visible, o al volver a ella).
   *
   * Sólo sesiones que ocupan un puesto del cupo de `tenantId` y cuelgan de su subárbol, las mismas
   * que muestra la vista: un admin no desconecta a una agencia hermana aunque compartan cupo. El
   * actor tiene que administrar el nodo de ESA sesión y no puede ser la suya.
   */
  async release(actorUserId: string, tenantId: string, sessionId: string): Promise<{ ok: true }> {
    await this.assertCanManage(actorUserId, tenantId);

    const target = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const node = await this.node(trx, tenantId);
      if (node.pool_id === null) return undefined;
      const rows = await this.poolSessions(trx, node.pool_id, sessionId);
      const row = rows[0];
      if (row === undefined || row.tenant_id === null) return undefined;
      if (!isWithinSubtree(row.tenant_path, node.path)) return undefined;
      return { userId: row.user_id, tenantId: row.tenant_id, poolId: node.pool_id };
    });
    if (target === undefined) throw new SeatSessionNotFoundError();
    if (target.userId === actorUserId) throw new SeatReleaseSelfError();
    // Implícito si administra `tenantId` y la sesión cuelga de él; se mira igual porque es la regla
    // que se promete (administrar el nodo de ESA sesión) y no cuesta nada.
    await this.assertCanManage(actorUserId, target.tenantId);

    const released = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const res = await sql<{ released: boolean }>`
        SELECT revoke_session(${sessionId}::uuid, ${ADMIN_RELEASED_REASON}) AS released
      `.execute(trx);
      if (res.rows[0]?.released !== true) return false;
      // En la misma transacción: no queda un puesto liberado sin su rastro.
      await this.audit.emitWithin(trx, {
        eventType: 'auth.session.released_by_admin',
        tenantId: target.tenantId,
        actorUserId,
        aggregateType: 'session',
        aggregateId: sessionId,
        payload: {
          targetUserId: target.userId,
          poolTenantId: target.poolId,
          viaTenantId: tenantId,
        },
      });
      return true;
    });
    // Se cerró entre la lectura y la revocación (logout, inactividad, otro admin).
    if (!released) throw new SeatSessionNotFoundError();
    return { ok: true };
  }

  /**
   * `PATCH /admin/tenants/:id/seats`. El superadmin lo valida el controlador.
   *
   * - `concurrentSeats` rige para los ingresos nuevos: las sesiones abiertas conservan el cupo con
   *   que entraron hasta que se cierran. Bajar el cupo no desconecta a nadie; sólo impide entrar
   *   hasta que haya lugar.
   * - `idleTimeoutMinutes`: si la inactividad efectiva del nodo BAJA, se aplica también a las
   *   sesiones abiertas de su subárbol (`refresh_session_idle_timeouts`, que respeta un override más
   *   profundo): quien la baja lo hace por seguridad y no puede esperar 12 h. Si SUBE, rige para las
   *   sesiones nuevas: subirle el tope a una sesión que ya superó el viejo sin que nadie la revocara
   *   la reviviría. Por lo mismo, la bajada sólo le baja el tope a las sesiones que lo tienen más
   *   alto que el efectivo de su nodo; nunca se lo sube a una que entró con menos (una que entró
   *   antes de que su sub-agencia subiera el suyo, por ejemplo).
   *
   * El cambio y su `tenant.seats.updated`, con el antes y el después, van en una transacción.
   * Devuelve la vista actualizada.
   */
  async updatePolicy(
    actorUserId: string,
    tenantId: string,
    patch: UpdateSeatsDto,
  ): Promise<SeatsView> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      // FOR NO KEY UPDATE y no FOR UPDATE: serializa dos PATCH del mismo nodo igual, pero no choca
      // con el FOR KEY SHARE que toman las FK hacia tenants (sessions.seat_tenant_id/tenant_id,
      // orders, memberships) al insertar. Con FOR UPDATE cada login del cupo esperaba el PATCH
      // entero, y uno que ya había bloqueado su sesión anterior (replaceSessions) cerraba un
      // deadlock con refresh_session_idle_timeouts. El UPDATE de abajo sigue siendo "no key": sólo
      // cambia concurrent_seats e idle_timeout_minutes, y tenants_maintain_path recalcula `path`
      // al mismo valor.
      const before = await trx
        .selectFrom('tenants')
        .select(['id', 'concurrent_seats', 'idle_timeout_minutes'])
        .where('id', '=', tenantId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!before) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');

      const changed = SEAT_FIELDS.filter(
        ([field, column]) => patch[field] !== undefined && patch[field] !== before[column],
      );
      if (changed.length === 0) return this.readView(trx, tenantId);

      const idleBefore = await this.effectiveIdleMinutes(trx, tenantId);
      await trx
        .updateTable('tenants')
        .set({
          ...(patch.concurrentSeats === undefined
            ? {}
            : { concurrent_seats: patch.concurrentSeats }),
          ...(patch.idleTimeoutMinutes === undefined
            ? {}
            : { idle_timeout_minutes: patch.idleTimeoutMinutes }),
        })
        .where('id', '=', tenantId)
        .execute();
      const idleAfter = await this.effectiveIdleMinutes(trx, tenantId);

      let sessionsRefreshed = 0;
      if (idleAfter < idleBefore) {
        const res = await sql<{ refreshed: number | string }>`
          SELECT refresh_session_idle_timeouts(${tenantId}::uuid) AS refreshed
        `.execute(trx);
        sessionsRefreshed = Number(res.rows[0]?.refreshed ?? 0);
      }

      const after = await trx
        .selectFrom('tenants')
        .select(['concurrent_seats', 'idle_timeout_minutes'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();

      await this.audit.emitWithin(trx, {
        eventType: 'tenant.seats.updated',
        tenantId,
        actorUserId,
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: {
          changed: changed.map(([field]) => field),
          before: Object.fromEntries(changed.map(([field, column]) => [field, before[column]])),
          after: Object.fromEntries(changed.map(([field, column]) => [field, after[column]])),
          effectiveIdleTimeoutMinutes: { before: idleBefore, after: idleAfter },
          sessionsRefreshed,
        },
      });

      return this.readView(trx, tenantId);
    });
  }

  private async assertCanManage(actorUserId: string, tenantId: string): Promise<void> {
    if (!(await this.network.canManageTenant(actorUserId, tenantId))) {
      throw new TenantNotManagedError();
    }
  }

  private async readView(trx: Transaction<DB>, tenantId: string): Promise<SeatsView> {
    const node = await this.node(trx, tenantId);

    let pool: { id: string; name: string; limit: number } | null = null;
    let poolSessions: PoolSessionRow[] = [];
    if (node.pool_id !== null) {
      const res = await sql<PoolRow>`
        SELECT id, name, concurrent_seats FROM tenants WHERE id = ${node.pool_id}::uuid
      `.execute(trx);
      const row = res.rows[0];
      // seat_pool_of sólo devuelve nodos con cupo; si se borró entre las dos lecturas, sin límite.
      if (row !== undefined && row.concurrent_seats !== null) {
        pool = { id: row.id, name: row.name, limit: Number(row.concurrent_seats) };
        poolSessions = await this.poolSessions(trx, row.id);
      }
    }

    return buildSeatsView({
      tenantId: node.id,
      tenantPath: node.path,
      ownSeats: node.concurrent_seats,
      ownIdleTimeoutMinutes: node.idle_timeout_minutes,
      idleTimeoutMinutes: Number(node.idle_minutes),
      pool,
      poolSessions,
      currentSessionId: currentContext()?.sessionId,
    });
  }

  /** El nodo con su `path`, su cupo propio y los efectivos. 404 si no existe. */
  private async node(trx: Transaction<DB>, tenantId: string): Promise<NodeRow> {
    const res = await sql<NodeRow>`
      SELECT t.id,
             t.path::text AS path,
             t.concurrent_seats,
             t.idle_timeout_minutes,
             seat_pool_of(t.id) AS pool_id,
             effective_idle_timeout_minutes(t.id) AS idle_minutes
      FROM tenants t
      WHERE t.id = ${tenantId}::uuid
    `.execute(trx);
    const row = res.rows[0];
    if (!row) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
    return row;
  }

  private async effectiveIdleMinutes(trx: Transaction<DB>, tenantId: string): Promise<number> {
    const res = await sql<{ minutes: number | string }>`
      SELECT effective_idle_timeout_minutes(${tenantId}::uuid) AS minutes
    `.execute(trx);
    return Number(res.rows[0]?.minutes ?? 30);
  }

  /**
   * Las sesiones que ocupan el cupo `poolId`, con el `path` de su nodo para acotarlas a un subárbol.
   * Con `sessionId`, sólo esa (si ocupa un puesto de este cupo).
   */
  private async poolSessions(
    trx: Transaction<DB>,
    poolId: string,
    sessionId?: string,
  ): Promise<PoolSessionRow[]> {
    const res = await sql<PoolSessionRow>`
      SELECT pas.session_id, pas.user_id, pas.email, pas.name, pas.tenant_id, pas.tenant_name,
             pas.issued_at, pas.last_seen_at, pas.ip, pas.user_agent,
             t.path::text AS tenant_path
      FROM pool_active_sessions(${poolId}::uuid) pas
      LEFT JOIN tenants t ON t.id = pas.tenant_id
      ${sessionId === undefined ? sql`` : sql`WHERE pas.session_id = ${sessionId}::uuid`}
      ORDER BY pas.last_seen_at DESC
    `.execute(trx);
    return res.rows;
  }
}
