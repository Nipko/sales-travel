import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { sql } from 'kysely';
import { AllowWithoutMfa } from '../auth/decorators/allow-without-mfa.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { toMembershipViews, type MembershipRow, type MembershipView } from './membership-view.js';

interface MeView {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

interface MembershipSqlRow {
  id: string;
  role: string;
  status: string;
  created_at: Date;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_status: string;
  tenant_type: string;
  logo_url: string | null;
  blocker_id: string | null;
  blocker_name: string | null;
}

@Controller('me')
export class MeController {
  constructor(private readonly db: DatabaseService) {}

  // Sin MFA todavía: el panel necesita saber quién es para mostrarle el enrolamiento obligatorio.
  @AllowWithoutMfa()
  @Get()
  async me(@CurrentUser() userId: string | undefined): Promise<MeView> {
    if (!userId) throw new UnauthorizedException();
    const row = await this.db.db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'email_verified_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new UnauthorizedException();
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: row.email_verified_at != null,
    };
  }

  /**
   * Las agencias del usuario, en orden alfabético, con lo que necesita el selector de agencia:
   * logo efectivo, si se puede operar (y por qué no) y cuál es la agencia por defecto del login,
   * calculada con el mismo criterio que la API (`isDefault`, ver auth/default-tenant.ts).
   *
   * El bloqueante es el nodo no activo de la cadena: el propio primero, si no el más alto.
   * `tenants` no tiene RLS (0001): leer los ancestros no expone más que su nombre.
   */
  @AllowWithoutMfa()
  @Get('memberships')
  async memberships(@CurrentUser() userId: string | undefined): Promise<MembershipView[]> {
    if (!userId) throw new UnauthorizedException();

    const [rows, user] = await Promise.all([
      this.db.withRequestContext({ userId }, async (trx) => {
        const res = await sql<MembershipSqlRow>`
          SELECT m.id,
                 m.role,
                 m.status,
                 m.created_at,
                 t.id            AS tenant_id,
                 t.slug          AS tenant_slug,
                 t.name          AS tenant_name,
                 t.status        AS tenant_status,
                 t.tenant_type   AS tenant_type,
                 b.logo_url      AS logo_url,
                 blocker.id      AS blocker_id,
                 blocker.name    AS blocker_name
          FROM memberships m
          JOIN tenants t ON t.id = m.tenant_id
          LEFT JOIN LATERAL resolve_tenant_branding(t.id) b ON true
          LEFT JOIN LATERAL (
            SELECT a.id, a.name
            FROM tenants a
            WHERE a.path OPERATOR(public.@>) t.path
              AND a.status <> 'active'
            ORDER BY (a.id = t.id) DESC, nlevel(a.path) ASC
            LIMIT 1
          ) blocker ON true
          WHERE m.user_id = ${userId}::uuid
          ORDER BY t.name, t.id
        `.execute(trx);
        return res.rows;
      }),
      this.db.db
        .selectFrom('users')
        .select('last_tenant_id')
        .where('id', '=', userId)
        .executeTakeFirst(),
    ]);

    return toMembershipViews(rows.map(toMembershipRow), user?.last_tenant_id ?? null);
  }
}

function toMembershipRow(r: MembershipSqlRow): MembershipRow {
  return {
    id: r.id,
    role: r.role,
    status: r.status,
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    tenantStatus: r.tenant_status,
    tenantType: r.tenant_type,
    logoUrl: r.logo_url,
    createdAt: r.created_at,
    blockerId: r.blocker_id,
    blockerName: r.blocker_name,
  };
}
