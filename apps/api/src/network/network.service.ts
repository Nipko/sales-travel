import { ForbiddenException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AGENCY_ADMIN_ROLES, highestRole } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';

export interface NetworkTenant {
  id: string;
  slug: string;
  name: string;
  tenantType: string;
  /** Sucursal de Planetour (0050): la UI la muestra como "Sucursal". */
  isBranch: boolean;
  parentTenantId: string | null;
  status: string;
  depth: number;
}

export interface NetworkSalesRow {
  tenantId: string;
  tenantName: string;
  tenantType: string;
  depth: number;
  ordersTotal: number;
  ordersConfirmed: number;
  quotationsTotal: number;
}

export interface NetworkUser {
  userId: string;
  email: string;
  name: string | null;
  userStatus: string;
  role: string;
  membershipStatus: string;
  createdAt: Date;
  /** Último ingreso a la plataforma (en cualquier nodo). `null` = nunca ingresó. */
  lastLoginAt: Date | null;
  /** Tiene el segundo factor activo. */
  mfaEnabled: boolean;
  /** Bloqueado por intentos fallidos hasta ese instante; `null` si no está bloqueado ahora. */
  lockedUntil: Date | null;
  /** Sesiones vivas (no revocadas, no vencidas, dentro de su inactividad) en el subárbol del nodo. */
  activeSessions: number;
}

/** Una fila de `user_admin_overview` (0055). */
interface UserOverviewRow {
  user_id: string;
  last_login_at: Date | null;
  mfa_enabled: boolean;
  locked_until: Date | null;
  active_sessions: number | string;
}

interface NetworkRow {
  id: string;
  slug: string;
  name: string;
  tenant_type: string;
  is_branch: boolean;
  parent_tenant_id: string | null;
  status: string;
  depth: number;
}

/**
 * Autorización jerárquica del modelo consolidador. Un admin sólo puede ver/gestionar
 * tenants dentro de SU subárbol (nodo donde es admin + descendientes), salvo superadmin.
 * Se apoya en `tenants.path` (ltree): `admin_t.path @> target_t.path` = el nodo admin es
 * ancestro-o-igual del target.
 *
 * NOTA: esto es autorización a nivel de aplicación. La RLS descendente sobre datos
 * operativos (orders/quotations/...) para agregación de red queda pendiente hasta poder
 * probarla contra una DB (ver docs/platform/12-modelo-consolidador-y-plan.md §6, Fase 0 paso 5).
 */
@Injectable()
export class NetworkService {
  constructor(private readonly db: DatabaseService) {}

  /** ¿El usuario tiene rol superadmin en algún nodo? (acceso global). */
  async isSuperadmin(userId: string): Promise<boolean> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('role', '=', 'superadmin')
        .executeTakeFirst();
      return Boolean(row);
    });
  }

  /**
   * ¿Puede el usuario administrar `targetTenantId`? True si es superadmin, o si tiene
   * una membership admin en un nodo ancestro-o-igual del target.
   *
   * Una membership en un nodo suspendido (o colgado de uno suspendido) no da potestad, igual que
   * en SessionService.validate: el admin de una agencia suspendida que además opera en otra red no
   * la sigue administrando desde allá. Su ancestro activo sí.
   */
  async canManageTenant(userId: string, targetTenantId: string): Promise<boolean> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const result = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM memberships m
          JOIN tenants admin_t  ON admin_t.id  = m.tenant_id
          JOIN tenants target_t ON target_t.id = ${targetTenantId}::uuid
          WHERE m.user_id = ${userId}::uuid
            AND m.status = 'active'
            AND (
              m.role = 'superadmin'
              OR (m.role IN ('tenant_admin', 'admin', 'consolidator_admin', 'agency_admin') AND admin_t.path OPERATOR(public.@>) target_t.path)
            )
            AND NOT EXISTS (
              SELECT 1 FROM tenants anc
              WHERE anc.path OPERATOR(public.@>) admin_t.path
                AND anc.status <> 'active'
            )
        ) AS ok
      `.execute(trx);
      return result.rows[0]?.ok === true;
    });
  }

  /**
   * El rol con que el usuario ACTÚA sobre `tenantId`: el de más rango entre sus memberships
   * activas que le dan potestad sobre ese nodo (superadmin en cualquier nodo, o un rol de admin
   * en el nodo o en un ancestro, como canManageTenant). `undefined` si no lo administra.
   *
   * El rango para asignar o tocar un rol se compara contra ESTE rol y no contra el del tenant
   * activo del request (G-06): quien es consolidator_admin en su red y admin en otra no puede
   * usar el primero para repartir roles en la segunda.
   *
   * Como canManageTenant, una membership en un nodo suspendido (o bajo uno suspendido) no cuenta.
   */
  async roleOver(userId: string, tenantId: string): Promise<Role | undefined> {
    const roles = await this.db.withRequestContext({ userId }, async (trx) => {
      const result = await sql<{ role: Role }>`
        SELECT m.role
        FROM memberships m
        JOIN tenants admin_t ON admin_t.id = m.tenant_id
        WHERE m.user_id = ${userId}::uuid
          AND m.status = 'active'
          AND (
            m.role = 'superadmin'
            OR (
              m.role = ANY(${[...AGENCY_ADMIN_ROLES]}::text[])
              AND admin_t.path OPERATOR(public.@>) (
                SELECT target_t.path FROM tenants target_t WHERE target_t.id = ${tenantId}::uuid
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM tenants anc
            WHERE anc.path OPERATOR(public.@>) admin_t.path
              AND anc.status <> 'active'
          )
      `.execute(trx);
      return result.rows.map((r) => r.role);
    });
    return highestRole(roles);
  }

  /**
   * {@link roleOver} para varios nodos en una consulta: el rol con que el usuario administra cada
   * uno. Un nodo que no administra (o que no existe) no aparece en el mapa.
   *
   * Lo usa la regla del soporte a un miembro, que exige administrar TODOS los nodos donde el
   * objetivo tiene membership activa.
   */
  async rolesOver(userId: string, tenantIds: readonly string[]): Promise<Map<string, Role>> {
    const ids = [...new Set(tenantIds)];
    if (ids.length === 0) return new Map();

    const rows = await this.db.withRequestContext({ userId }, async (trx) => {
      const result = await sql<{ tenant_id: string; role: Role }>`
        SELECT target_t.id AS tenant_id, m.role
        FROM tenants target_t
        JOIN memberships m ON m.user_id = ${userId}::uuid AND m.status = 'active'
        JOIN tenants admin_t ON admin_t.id = m.tenant_id
        WHERE target_t.id = ANY(${ids}::uuid[])
          AND (
            m.role = 'superadmin'
            OR (
              m.role = ANY(${[...AGENCY_ADMIN_ROLES]}::text[])
              AND admin_t.path OPERATOR(public.@>) target_t.path
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM tenants anc
            WHERE anc.path OPERATOR(public.@>) admin_t.path
              AND anc.status <> 'active'
          )
      `.execute(trx);
      return result.rows;
    });

    const byTenant = new Map<string, Role[]>();
    for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.role]);

    const out = new Map<string, Role>();
    for (const [tenantId, roles] of byTenant) {
      const best = highestRole(roles);
      if (best !== undefined) out.set(tenantId, best);
    }
    return out;
  }

  /**
   * ¿Puede el usuario OPERAR en `tenantId`? True si es miembro directo (cualquier rol),
   * superadmin, o admin de un nodo ancestro (act-as descendiente). Se usa para validar el
   * header `x-tenant-id` y evitar que un cliente opere bajo un tenant ajeno.
   */
  async canAccessTenant(userId: string, tenantId: string): Promise<boolean> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const result = await sql<{ ok: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM memberships m
          WHERE m.user_id = ${userId}::uuid AND m.status = 'active'
            AND (
              m.tenant_id = ${tenantId}::uuid
              OR m.role = 'superadmin'
              OR (
                m.role IN ('tenant_admin','admin','consolidator_admin','agency_admin','platform_admin')
                AND EXISTS (
                  SELECT 1
                  FROM tenants admin_t
                  JOIN tenants target_t ON target_t.id = ${tenantId}::uuid
                  WHERE admin_t.id = m.tenant_id
                    AND admin_t.path OPERATOR(public.@>) target_t.path
                )
              )
            )
        ) AS ok
      `.execute(trx);
      return result.rows[0]?.ok === true;
    });
  }

  /**
   * Agregado de ventas de la red bajo `rootTenantId` (orders/quotations por nodo del
   * subárbol). Gateado: el usuario debe poder gestionar el root (su nodo o un ancestro).
   * La función SQL es SECURITY DEFINER y agrega a través de la RLS; la autorización vive acá.
   */
  async networkSalesSummary(userId: string, rootTenantId: string): Promise<NetworkSalesRow[]> {
    if (!(await this.canManageTenant(userId, rootTenantId))) {
      throw new ForbiddenException('not authorized to view this network');
    }
    const result = await sql<{
      t_id: string;
      t_name: string;
      t_type: string;
      t_depth: number;
      orders_total: string | number;
      orders_confirmed: string | number;
      quotations_total: string | number;
    }>`SELECT * FROM network_sales_summary(${rootTenantId}::uuid)`.execute(this.db.db);

    return result.rows.map((r) => ({
      tenantId: r.t_id,
      tenantName: r.t_name,
      tenantType: r.t_type,
      depth: Number(r.t_depth),
      ordersTotal: Number(r.orders_total),
      ordersConfirmed: Number(r.orders_confirmed),
      quotationsTotal: Number(r.quotations_total),
    }));
  }

  /**
   * Usuarios (memberships) de un nodo de la red. Gateado: el usuario debe poder gestionar
   * `tenantId` (su nodo, un descendiente, o superadmin). Se lee con el contexto del tenant
   * destino → la policy `memberships_tenant_isolation` devuelve sólo sus memberships.
   *
   * Suma lo que el admin necesita para dar soporte (último ingreso, 2FA, bloqueo, sesiones abiertas)
   * con `user_admin_overview` (0055): `sessions` tiene RLS por usuario, así que sin esa función
   * SECURITY DEFINER el admin no podría contar las de su equipo. La autorización es la de arriba.
   */
  async listTenantUsers(userId: string, tenantId: string): Promise<NetworkUser[]> {
    if (!(await this.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const rows = await trx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'users.id as userId',
          'users.email as email',
          'users.name as name',
          'users.status as userStatus',
          'memberships.role as role',
          'memberships.status as membershipStatus',
          'memberships.created_at as createdAt',
        ])
        .where('memberships.tenant_id', '=', tenantId)
        .orderBy('memberships.created_at')
        .execute();

      const overview = await sql<UserOverviewRow>`
        SELECT user_id, last_login_at, mfa_enabled, locked_until, active_sessions
        FROM user_admin_overview(${tenantId}::uuid)
      `.execute(trx);
      const byUser = new Map(overview.rows.map((o) => [o.user_id, o]));

      return rows.map((r) => {
        const o = byUser.get(r.userId);
        return {
          userId: r.userId,
          email: r.email,
          name: r.name,
          userStatus: r.userStatus,
          role: r.role,
          membershipStatus: r.membershipStatus,
          // pg devuelve Date para timestamptz; el tipo Kysely es ColumnType (Timestamp).
          createdAt: r.createdAt as unknown as Date,
          lastLoginAt: o?.last_login_at ?? null,
          mfaEnabled: o?.mfa_enabled === true,
          lockedUntil: o?.locked_until ?? null,
          activeSessions: Number(o?.active_sessions ?? 0),
        };
      });
    });
  }

  /** Subárbol de tenants que el usuario administra (su red). Superadmin ve todos. */
  async listNetwork(userId: string): Promise<NetworkTenant[]> {
    const superadmin = await this.isSuperadmin(userId);
    return this.db.withRequestContext({ userId }, async (trx) => {
      const result = superadmin
        ? await sql<NetworkRow>`
            SELECT t.id, t.slug, t.name, t.tenant_type, t.is_branch, t.parent_tenant_id, t.status,
                   nlevel(t.path) AS depth
            FROM tenants t
            ORDER BY nlevel(t.path), t.name
          `.execute(trx)
        : await sql<NetworkRow>`
            SELECT DISTINCT t.id, t.slug, t.name, t.tenant_type, t.is_branch, t.parent_tenant_id,
                   t.status, nlevel(t.path) AS depth
            FROM tenants t
            JOIN memberships m ON m.user_id = ${userId}::uuid AND m.status = 'active'
                              AND m.role IN ('tenant_admin', 'admin', 'consolidator_admin', 'agency_admin')
            JOIN tenants admin_t ON admin_t.id = m.tenant_id
            WHERE admin_t.path OPERATOR(public.@>) t.path
            ORDER BY depth, t.name
          `.execute(trx);

      return result.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        tenantType: r.tenant_type,
        isBranch: r.is_branch,
        parentTenantId: r.parent_tenant_id,
        status: r.status,
        depth: Number(r.depth),
      }));
    });
  }

  /**
   * Tenant dueño de un host propio VERIFICADO (0033).
   *
   * Sólo resuelve dominios ya comprobados: si bastara con declararlo, cualquier agencia
   * podría reclamar el host de otra y servir su marca bajo él.
   */
  async resolveTenantByHost(host: string): Promise<string | null> {
    try {
      const res = await sql<{
        resolve_tenant_by_host: string | null;
      }>`SELECT resolve_tenant_by_host(${host})`.execute(this.db.db);
      return res.rows[0]?.resolve_tenant_by_host ?? null;
    } catch {
      // Resolver el host es mejor-esfuerzo: no puede tumbar el request.
      return null;
    }
  }
}
