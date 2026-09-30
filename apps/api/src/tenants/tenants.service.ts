import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role, TenantStatus, TenantType } from '../database/database.types.js';
import {
  TenantHierarchyNotFoundError,
  tenantHierarchyHttpError,
} from '../database/tenant-hierarchy-errors.js';
import { NetworkService } from '../network/network.service.js';
import { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import type { CreateTenantDto, UpdateTenantDto } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import { TenantSeatsSuperadminOnlyError } from './seats.policy.js';
import {
  childTenantType,
  initialAdminRole,
  RoleNotGrantableError,
  TenantParentRequiredError,
  TenantPlatformLockedError,
  TenantSlugTakenError,
  TenantTypeOpenBookingsError,
} from './tenant-admin.policy.js';

/** Un nodo tal como queda después de crearlo, corregirlo o moverlo. */
export interface TenantState {
  id: string;
  slug: string;
  name: string;
  tenantType: TenantType;
  /** Sucursal de Planetour (0050). La UI la muestra como "Sucursal". */
  isBranch: boolean;
  parentTenantId: string | null;
  status: TenantStatus;
  /** Nivel en el árbol: 1 es la plataforma. */
  depth: number;
}

/** Un nodo de la red en el panel del superadmin. */
export interface NetworkNode extends TenantState {
  parentName: string | null;
  countryCode: string;
  defaultCurrency: string;
  userCount: number;
  createdAt: Date;
}

/**
 * Qué pasó con el admin inicial:
 * - `created`: no tenía cuenta; se creó con la contraseña del formulario.
 * - `invited`: ya tenía cuenta, o no vino contraseña; acepta por invitación y elige la suya.
 * - `invite_failed`: el nodo se creó pero la invitación no; se reenvía desde Usuarios.
 */
export type InitialAdminOutcome = 'created' | 'invited' | 'invite_failed';

export interface CreatedTenant {
  tenant: TenantState;
  admin?: { email: string; role: Role; status: InitialAdminOutcome };
}

/**
 * Motivo con que quedan revocadas las sesiones que un movimiento deja consumiendo el cupo de una
 * red a la que su nodo ya no pertenece. El panel lo informa como una sesión cerrada sin más
 * (SESSION_REVOKED, ver auth/session-revocation.ts).
 */
export const TENANT_MOVED_REASON = 'tenant_moved';

export interface MovedTenant {
  /** Nodos movidos (el nodo y sus descendientes); 0 si ya colgaba de ese padre. */
  moved: number;
  tenant: TenantState;
}

/** Una sesión que el movimiento deja en un cupo que ya no está por encima de su nodo. */
interface StrandedSessionRow {
  session_id: string;
  user_id: string;
  tenant_id: string;
  pool_tenant_id: string;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  tenant_type: TenantType;
  is_branch: boolean;
  parent_tenant_id: string | null;
  status: TenantStatus;
  depth: number | string;
}

const STATE_COLUMNS = [
  'tenants.id',
  'tenants.slug',
  'tenants.name',
  'tenants.tenant_type',
  'tenants.is_branch',
  'tenants.parent_tenant_id',
  'tenants.status',
] as const;

function toState(row: TenantRow): TenantState {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tenantType: row.tenant_type,
    isBranch: row.is_branch,
    parentTenantId: row.parent_tenant_id,
    status: row.status,
    depth: Number(row.depth),
  };
}

/** Los campos que corrige el PATCH, con su nombre en la API y en la tabla. */
const EDITABLE = [
  ['status', 'status'],
  ['isBranch', 'is_branch'],
  ['tenantType', 'tenant_type'],
] as const;

/**
 * El error de la base traducido: una regla de la jerarquía (STH01/STH02, 0050-0051) sale como su
 * excepción HTTP con motivo; cualquier otro sigue su camino.
 */
function rethrow(err: unknown): never {
  throw tenantHierarchyHttpError(err) ?? err;
}

/**
 * La estructura de la red: alta de nodos, corrección de tipo, estado y sucursal, y movimiento de
 * un nodo con su subárbol. La autorización fina vive acá porque depende del padre que se resuelve
 * en la base; el controlador sólo decide quién llega (superadmin o admin de red).
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly password: PasswordService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
    private readonly enablement: ProviderEnablementStore,
  ) {}

  /** La raíz `platform` (Planetour). La base admite una sola (0050). */
  async platformRootId(): Promise<string | undefined> {
    const row = await this.db.db
      .selectFrom('tenants')
      .select('id')
      .where('tenant_type', '=', 'platform')
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Alta de un nodo (G-05, G-07, G-06).
   *
   * - Padre: el indicado; si el superadmin no indica ninguno, la plataforma. Otro admin tiene que
   *   indicarlo y administrarlo.
   * - Tipo: derivado del padre (D4 A). Consolidador y sucursal, sólo el superadmin y bajo la
   *   plataforma.
   * - Admin inicial: nunca con un rol igual o superior al del actor sobre el padre. Si el email ya
   *   tiene cuenta no se le vincula: se le invita, y la acepta él. Sin contraseña, también se le
   *   invita.
   * - Puestos simultáneos e inactividad: sólo el superadmin (403 si los manda otro). Sin valor, el
   *   nodo los hereda de su cadena.
   *
   * El nodo, el admin creado y el `TenantCreated` van en una transacción. La invitación sale
   * después: si falla, el nodo queda y la respuesta lo dice.
   */
  async create(actorUserId: string, input: CreateTenantDto): Promise<CreatedTenant> {
    const superadmin = await this.network.isSuperadmin(actorUserId);
    // Los puestos son la licencia que vende la plataforma: los fija sólo el superadmin (decisión
    // del founder). Un admin de red que los manda recibe 403 en vez de verlos ignorados en silencio.
    const seatsRequested =
      input.concurrentSeats !== undefined || input.idleTimeoutMinutes !== undefined;
    if (seatsRequested && !superadmin) throw new TenantSeatsSuperadminOnlyError();

    const parentId = input.parentTenantId ?? (superadmin ? await this.platformRootId() : undefined);
    if (parentId === undefined) {
      if (superadmin) throw new TenantHierarchyNotFoundError('TENANT_PARENT_NOT_FOUND');
      throw new TenantParentRequiredError();
    }

    const actorRole = await this.network.roleOver(actorUserId, parentId);
    if (actorRole === undefined) {
      throw new ForbiddenException('el nodo padre está fuera de tu red');
    }

    const parent = await this.db.db
      .selectFrom('tenants')
      .select(['id', 'tenant_type'])
      .where('id', '=', parentId)
      .executeTakeFirst();
    if (!parent) throw new TenantHierarchyNotFoundError('TENANT_PARENT_NOT_FOUND');

    const isBranch = input.isBranch ?? false;
    const tenantType = childTenantType({
      parentType: parent.tenant_type,
      requestedType: input.tenantType,
      isBranch,
      superadmin,
    });

    const adminEmail = input.adminEmail;
    const adminRole =
      adminEmail === undefined ? undefined : initialAdminRole(tenantType, actorRole);
    if (adminEmail !== undefined && adminRole === undefined) {
      throw new RoleNotGrantableError(
        'Tu rol no alcanza para darle un admin al nodo nuevo: crealo sin admin y pedíselo a tu red.',
      );
    }

    const existingAdmin =
      adminEmail === undefined
        ? undefined
        : await this.db.db
            .selectFrom('users')
            .select('id')
            .where('email', '=', adminEmail)
            .executeTakeFirst();
    const passwordHash =
      adminEmail !== undefined && existingAdmin === undefined && input.adminPassword !== undefined
        ? await this.password.hash(input.adminPassword)
        : undefined;

    const { tenant, adminCreated } = await this.db
      .withRequestContext({ userId: actorUserId }, async (trx) => {
        const row = await trx
          .insertInto('tenants')
          .values({
            slug: input.slug,
            name: input.name,
            country_code: input.countryCode,
            default_currency: input.defaultCurrency,
            default_language: input.defaultLanguage ?? 'es',
            parent_tenant_id: parent.id,
            tenant_type: tenantType,
            is_branch: isBranch,
            concurrent_seats: input.concurrentSeats ?? null,
            idle_timeout_minutes: input.idleTimeoutMinutes ?? null,
          })
          .onConflict((oc) => oc.column('slug').doNothing())
          .returning(['id'])
          .executeTakeFirst();
        if (!row) throw new TenantSlugTakenError();

        const created =
          adminEmail !== undefined && adminRole !== undefined && passwordHash !== undefined
            ? await this.createAdmin(trx, {
                tenantId: row.id,
                email: adminEmail,
                name: input.adminName,
                passwordHash,
                role: adminRole,
                invitedBy: actorUserId,
              })
            : false;

        await this.audit.emitWithin(trx, {
          eventType: 'TenantCreated',
          tenantId: row.id,
          actorUserId,
          aggregateType: 'tenant',
          aggregateId: row.id,
          payload: {
            slug: input.slug,
            tenantType,
            isBranch,
            parentTenantId: parent.id,
            ...(input.concurrentSeats === undefined
              ? {}
              : { concurrentSeats: input.concurrentSeats }),
            ...(input.idleTimeoutMinutes === undefined
              ? {}
              : { idleTimeoutMinutes: input.idleTimeoutMinutes }),
            ...(adminRole === undefined
              ? {}
              : { adminRole, admin: created ? 'created' : 'invited' }),
          },
        });

        return { tenant: await this.stateOf(trx, row.id), adminCreated: created };
      })
      .catch(rethrow);

    if (adminEmail === undefined || adminRole === undefined) return { tenant };
    if (adminCreated)
      return { tenant, admin: { email: adminEmail, role: adminRole, status: 'created' } };

    try {
      await this.invitations.invite({
        actorUserId,
        tenantId: tenant.id,
        email: adminEmail,
        role: adminRole,
      });
      return { tenant, admin: { email: adminEmail, role: adminRole, status: 'invited' } };
    } catch (err) {
      // Sin el email: es PII y el id del nodo alcanza para encontrarlo en la auditoría.
      this.logger.warn(
        `el nodo ${tenant.id} se creó pero la invitación de su admin falló: ${(err as Error).name}`,
      );
      return { tenant, admin: { email: adminEmail, role: adminRole, status: 'invite_failed' } };
    }
  }

  /**
   * Corrección de un nodo por el superadmin: estado, sucursal y tipo (G-09). La matriz D4, los
   * hijos que tiene que seguir admitiendo y la sucursal los valida la base (0050); sus errores
   * salen como 409 con motivo.
   *
   * Suspender un nodo corta el acceso de sus usuarios y los de todo su subárbol (SessionService no
   * resuelve rol bajo un nodo suspendido). La plataforma no se suspende. Un consolidador con
   * reservas abiertas hechas con sus credenciales no cambia de tipo (409).
   *
   * El cambio y su `tenant.updated`, con el antes y el después, van en una transacción.
   */
  async update(
    actorUserId: string,
    tenantId: string,
    patch: UpdateTenantDto,
  ): Promise<TenantState> {
    return this.db
      .withRequestContext({ userId: actorUserId }, async (trx) => {
        const before = await trx
          .selectFrom('tenants')
          .select([...STATE_COLUMNS, sql<number>`nlevel(tenants.path)`.as('depth')])
          .where('tenants.id', '=', tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
        if (before.tenant_type === 'platform' && patch.status === 'suspended') {
          throw new TenantPlatformLockedError();
        }

        const changed = EDITABLE.filter(
          ([field, column]) => patch[field] !== undefined && patch[field] !== before[column],
        );
        if (changed.length === 0) return toState(before);

        if (
          before.tenant_type === 'consolidator' &&
          patch.tenantType !== undefined &&
          patch.tenantType !== 'consolidator'
        ) {
          await this.assertNoOpenOwnBookings(trx, tenantId);
        }

        await trx
          .updateTable('tenants')
          .set({
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.isBranch === undefined ? {} : { is_branch: patch.isBranch }),
            ...(patch.tenantType === undefined ? {} : { tenant_type: patch.tenantType }),
          })
          .where('id', '=', tenantId)
          .execute();
        const after = await this.stateOf(trx, tenantId);

        await this.audit.emitWithin(trx, {
          eventType: 'tenant.updated',
          tenantId,
          actorUserId,
          aggregateType: 'tenant',
          aggregateId: tenantId,
          payload: {
            changed: changed.map(([field]) => field),
            before: Object.fromEntries(changed.map(([field, column]) => [field, before[column]])),
            after: Object.fromEntries(changed.map(([field]) => [field, after[field]])),
          },
        });

        return after;
      })
      .catch(rethrow);
  }

  /**
   * Mueve un nodo con su subárbol bajo otro padre (D6 A, G-09), con `move_tenant_subtree` (0051):
   * recalcula el `path`, rechaza ciclos, más de 4 niveles y lo que prohíbe D4, bloquea con
   * reservas abiertas pagadas con cartera, y deja el `tenant.moved` con el actor de la petición.
   * Por eso corre con el usuario en el contexto y no escribe un segundo `tenant.moved`.
   *
   * Lo histórico no se toca; desde el cambio rigen las credenciales, reglas y marca del nuevo
   * padre, porque se heredan leyendo el `path`. La caché de habilitación de esta réplica se olvida
   * para que la búsqueda lo vea al instante.
   *
   * Las sesiones abiertas no se heredan así: cada una guardó al emitirse el nodo del cupo que
   * consume (`seat_tenant_id`). Las que quedarían consumiendo el de la red vieja se cierran en la
   * misma transacción (closeStrandedSessions).
   */
  async move(actorUserId: string, tenantId: string, newParentId: string): Promise<MovedTenant> {
    const result = await this.db
      .withRequestContext({ userId: actorUserId }, async (trx) => {
        // ANTES de mover: move_tenant_subtree bloquea el subárbol `FOR UPDATE`, y un ingreso en
        // curso que ya reemplazó su sesión anterior espera ese bloqueo para insertar la nueva (su
        // FK a tenants). Revocar después sería esperarlo a él mientras él nos espera: deadlock.
        // Si el movimiento se rechaza, las revocaciones se deshacen con él.
        await this.closeStrandedSessions(trx, actorUserId, tenantId, newParentId);
        const res = await sql<{ moved: number | string }>`
          SELECT move_tenant_subtree(${tenantId}::uuid, ${newParentId}::uuid) AS moved
        `.execute(trx);
        return {
          moved: Number(res.rows[0]?.moved ?? 0),
          tenant: await this.stateOf(trx, tenantId),
        };
      })
      .catch(rethrow);

    if (result.moved > 0) this.enablement.invalidate();
    return result;
  }

  /**
   * Cierra (`tenant_moved`) las sesiones abiertas del subárbol de `tenantId` que ocupan un puesto de
   * un cupo que deja de estar por encima de ellas al colgarlo de `newParentId`: el del padre de hoy
   * o el de un ancestro suyo que no lo es también del padre nuevo. Si no, seguirían ocupando un
   * puesto en una red a la que ya no pertenecen, sin que su admin pudiera verlas ni liberarlas
   * desde Equipo (la vista las acota al subárbol), mientras el 409 de cupo lleno de esa red le
   * mostraría a su admin nombre, email, IP y dispositivo de gente de otra red, y no contarían contra
   * el cupo nuevo. Al volver a entrar consumen del cupo que les toca (o se topan con el 409).
   *
   * No se tocan las que consumen un cupo del propio subárbol ni el de un ancestro común (la
   * plataforma, un consolidador al mover entre sus agencias): siguen en su red y bien contadas. Las
   * que no consumían puesto (plataforma, o cadena sin límite) siguen sin consumirlo hasta cerrarse,
   * igual que cuando el superadmin le pone cupo a un nodo que no tenía (SeatsService.updatePolicy).
   *
   * `sessions` tiene RLS por usuario: se leen y revocan con las funciones DEFINER de 0055
   * (`pool_active_sessions`, `revoke_session`), que no autorizan. Autoriza el controlador (sólo
   * superadmin) y, de nuevo, move_tenant_subtree en esta misma transacción. Queda un evento con
   * cada sesión cerrada.
   */
  private async closeStrandedSessions(
    trx: Transaction<DB>,
    actorUserId: string,
    tenantId: string,
    newParentId: string,
  ): Promise<void> {
    const stranded = await sql<StrandedSessionRow>`
      WITH node AS (
        SELECT id, path FROM tenants WHERE id = ${tenantId}::uuid
      ),
      leaving AS (
        SELECT a.id
        FROM node
        JOIN tenants a ON a.path OPERATOR(public.@>) node.path AND a.id <> node.id
        WHERE NOT EXISTS (
          SELECT 1 FROM tenants np
          WHERE np.id = ${newParentId}::uuid
            AND a.path OPERATOR(public.@>) np.path
        )
      )
      SELECT pas.session_id, pas.user_id, pas.tenant_id, leaving.id AS pool_tenant_id
      FROM leaving
      CROSS JOIN LATERAL pool_active_sessions(leaving.id) pas
      JOIN tenants t ON t.id = pas.tenant_id
      JOIN node ON t.path OPERATOR(public.<@) node.path
    `.execute(trx);
    if (stranded.rows.length === 0) return;

    const res = await sql<{ session_id: string; revoked: boolean }>`
      SELECT s.id AS session_id, revoke_session(s.id, ${TENANT_MOVED_REASON}) AS revoked
      FROM unnest(${stranded.rows.map((r) => r.session_id)}::uuid[]) AS s(id)
    `.execute(trx);
    // Una que se cerró entre la lectura y la revocación (logout, inactividad) no es de este evento.
    const revoked = new Set(res.rows.filter((r) => r.revoked).map((r) => r.session_id));
    const closed = stranded.rows.filter((r) => revoked.has(r.session_id));
    if (closed.length === 0) return;

    await this.audit.emitWithin(trx, {
      eventType: 'auth.sessions.revoked_by_tenant_move',
      tenantId,
      actorUserId,
      aggregateType: 'tenant',
      aggregateId: tenantId,
      payload: {
        toParentId: newParentId,
        sessions: closed.map((r) => ({
          sessionId: r.session_id,
          userId: r.user_id,
          tenantId: r.tenant_id,
          poolTenantId: r.pool_tenant_id,
        })),
      },
    });
  }

  /** Toda la red para el panel del superadmin, con tipo, sucursal, padre y profundidad. */
  async listNetwork(actorUserId: string): Promise<NetworkNode[]> {
    const rows = await this.db.db
      .selectFrom('tenants')
      .leftJoin('tenants as parent', 'parent.id', 'tenants.parent_tenant_id')
      .select([
        ...STATE_COLUMNS,
        sql<number>`nlevel(tenants.path)`.as('depth'),
        'parent.name as parent_name',
        'tenants.country_code',
        'tenants.default_currency',
        'tenants.created_at',
      ])
      .orderBy('tenants.created_at', 'desc')
      .execute();

    const ids = rows.map((r) => r.id);
    const counts =
      ids.length === 0
        ? []
        : await this.db.withRequestContext({ userId: actorUserId }, (trx) =>
            trx
              .selectFrom('memberships')
              .select(['tenant_id'])
              .select((eb) => eb.fn.countAll<number>().as('count'))
              .where('tenant_id', 'in', ids)
              .groupBy('tenant_id')
              .execute(),
          );
    const countOf = new Map(counts.map((c) => [c.tenant_id, Number(c.count)]));

    return rows.map((r) => ({
      ...toState(r),
      parentName: r.parent_name,
      countryCode: r.country_code,
      defaultCurrency: r.default_currency,
      userCount: countOf.get(r.id) ?? 0,
      // pg devuelve Date para timestamptz; el tipo Kysely es ColumnType (Timestamp).
      createdAt: r.created_at as unknown as Date,
    }));
  }

  /**
   * Un consolidador que deja de serlo no puede tener reservas abiertas hechas con sus propias
   * credenciales: su post-venta sale con esa cuenta, y la de TBO sólo opera con dueño plataforma o
   * consolidador (TboHotelsProviderFactory). Sin esto el cambio de tipo dejaba sin cancelación una
   * reserva abierta, lo mismo que move_tenant_subtree bloquea al mover (STH02).
   *
   * Basta con las órdenes del propio nodo: la base sólo deja cambiarle el tipo a un consolidador
   * sin hijos (sus hijos son agencias, que no cuelgan de otra agencia), así que nadie hereda su
   * cuenta. Las lee con el nodo como tenant (RLS de orders y provider_accounts). Nadie le abre una
   * orden mientras tanto: el nodo está `FOR UPDATE` y el alta de una orden verifica su FK contra él.
   */
  private async assertNoOpenOwnBookings(trx: Transaction<DB>, tenantId: string): Promise<void> {
    await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.execute(trx);
    const res = await sql<{ open: number | string }>`
      SELECT count(*) AS open
      FROM orders o
      JOIN provider_accounts pa ON pa.id = o.provider_account_id
      WHERE pa.tenant_id = ${tenantId}::uuid
        AND order_is_active(o.status, o.search_criteria)
    `.execute(trx);
    if (Number(res.rows[0]?.open ?? 0) > 0) throw new TenantTypeOpenBookingsError();
  }

  private async stateOf(trx: Transaction<DB>, tenantId: string): Promise<TenantState> {
    const row = await trx
      .selectFrom('tenants')
      .select([...STATE_COLUMNS, sql<number>`nlevel(tenants.path)`.as('depth')])
      .where('tenants.id', '=', tenantId)
      .executeTakeFirst();
    if (!row) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
    return toState(row);
  }

  /**
   * Crea la cuenta del admin inicial y su membership. `false` si el email ya tenía cuenta (se creó
   * entre la consulta y el alta): a ése no se le vincula, se le invita.
   */
  private async createAdmin(
    trx: Transaction<DB>,
    admin: {
      tenantId: string;
      email: string;
      name: string | undefined;
      passwordHash: string;
      role: Role;
      invitedBy: string;
    },
  ): Promise<boolean> {
    const user = await trx
      .insertInto('users')
      .values({ email: admin.email, name: admin.name ?? null, password_hash: admin.passwordHash })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!user) return false;

    await sql`SELECT set_config('app.current_tenant_id', ${admin.tenantId}, true)`.execute(trx);
    await trx
      .insertInto('memberships')
      .values({
        tenant_id: admin.tenantId,
        user_id: user.id,
        role: admin.role,
        invited_by: admin.invitedBy,
      })
      .execute();
    return true;
  }
}
