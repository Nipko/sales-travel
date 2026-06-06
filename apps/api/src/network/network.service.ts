import { ForbiddenException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

export interface NetworkTenant {
  id: string;
  slug: string;
  name: string;
  tenantType: string;
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
}

interface NetworkRow {
  id: string;
  slug: string;
  name: string;
  tenant_type: string;
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
        ) AS ok
      `.execute(trx);
      return result.rows[0]?.ok === true;
    });
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
      return rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: r.name,
        userStatus: r.userStatus,
        role: r.role,
        membershipStatus: r.membershipStatus,
        // pg devuelve Date para timestamptz; el tipo Kysely es ColumnType (Timestamp).
        createdAt: r.createdAt as unknown as Date,
      }));
    });
  }

  /** Subárbol de tenants que el usuario administra (su red). Superadmin ve todos. */
  async listNetwork(userId: string): Promise<NetworkTenant[]> {
    const superadmin = await this.isSuperadmin(userId);
    return this.db.withRequestContext({ userId }, async (trx) => {
      const result = superadmin
        ? await sql<NetworkRow>`
            SELECT t.id, t.slug, t.name, t.tenant_type, t.parent_tenant_id, t.status,
                   nlevel(t.path) AS depth
            FROM tenants t
            ORDER BY nlevel(t.path), t.name
          `.execute(trx)
        : await sql<NetworkRow>`
            SELECT DISTINCT t.id, t.slug, t.name, t.tenant_type, t.parent_tenant_id, t.status,
                   nlevel(t.path) AS depth
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
        parentTenantId: r.parent_tenant_id,
        status: r.status,
        depth: Number(r.depth),
      }));
    });
  }
}
