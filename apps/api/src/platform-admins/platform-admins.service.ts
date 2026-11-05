import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { platformTenantId } from '../audit/admin-audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, MembershipStatus } from '../database/database.types.js';
import {
  LastFullSuperadminError,
  PlatformAdminCandidateNotFoundError,
  PlatformAdminNotFoundError,
  SelfPlatformAdminChangeError,
} from './platform-admins.errors.js';

/** Los eventos de la gestión de superadmins. Categoría «Superadmins» de Plataforma → Actividad. */
export const PLATFORM_ADMIN_EVENTS = {
  granted: 'platform.superadmin.granted',
  supervisionChanged: 'platform.superadmin.supervision_changed',
  revoked: 'platform.superadmin.revoked',
} as const;

export interface PlatformAdminView {
  userId: string;
  email: string;
  name: string | null;
  /** `true`: sus cambios sensibles los aprueba un superadmin pleno. */
  supervised: boolean;
  membershipStatus: MembershipStatus;
  userStatus: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  since: string;
}

/** Lo que queda en el evento: el acceso antes y después, sin datos de la cuenta. */
interface AccessSnapshot {
  role: string;
  status: string;
  supervised: boolean;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Plataforma → Superadmins: quién es superadmin, pleno o supervisado, y darlo, cambiarlo o quitarlo
 * desde el panel (founder 2026-11-05; antes sólo con tools/seed-superadmin en el VPS, que sigue de
 * respaldo).
 *
 * La autorización (superadmin, 2FA reciente, la puerta de supervisión) la hace el controlador; acá
 * van las reglas que no dependen de quién llama: nadie se toca a sí mismo y nunca queda la plataforma
 * sin un superadmin pleno activo. Cada cambio deja su evento con el antes, el después y el motivo.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async list(viewer: string): Promise<PlatformAdminView[]> {
    return this.db.withRequestContext({ userId: viewer }, async (trx) => {
      const rows = await trx
        .selectFrom('memberships as m')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select([
          'u.id as user_id',
          sql<string>`u.email::text`.as('email'),
          'u.name',
          'u.status as user_status',
          'u.mfa_enabled_at',
          'u.last_login_at',
          'm.platform_supervised',
          'm.status as membership_status',
          sql<Date>`m.created_at`.as('created_at'),
        ])
        .where('t.tenant_type', '=', 'platform')
        .where('m.role', '=', 'superadmin')
        .where('m.status', 'in', ['active', 'suspended'])
        .orderBy('m.platform_supervised', 'asc')
        .orderBy('u.email', 'asc')
        .execute();
      return rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        name: r.name,
        supervised: r.platform_supervised,
        membershipStatus: r.membership_status,
        userStatus: r.user_status,
        mfaEnabled: r.mfa_enabled_at !== null,
        lastLoginAt: iso(r.last_login_at),
        since: iso(r.created_at) ?? '',
      }));
    });
  }

  /**
   * Hace superadmin (pleno o supervisado) a una cuenta activa que ya existe. Si ya lo era, deja el
   * tipo pedido. El 2FA se le exige al entrar (MFA_REQUIRED_ROLES).
   */
  async grant(
    actor: string,
    input: { email: string; supervised: boolean; reason: string | null },
  ): Promise<PlatformAdminView[]> {
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', input.email)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (user === undefined) throw new PlatformAdminCandidateNotFoundError();
      if (user.id === actor) throw new SelfPlatformAdminChangeError();

      const platformId = await platformTenantId(trx);
      if (platformId === null) throw new PlatformAdminNotFoundError();

      const current = await trx
        .selectFrom('memberships')
        .select(['id', 'role', 'status', 'platform_supervised'])
        .where('user_id', '=', user.id)
        .where('tenant_id', '=', platformId)
        .forUpdate()
        .executeTakeFirst();

      const before: AccessSnapshot | null =
        current === undefined
          ? null
          : { role: current.role, status: current.status, supervised: current.platform_supervised };
      // Pasar de pleno a supervisado también le quita a la plataforma un pleno.
      if (
        before?.role === 'superadmin' &&
        before.status === 'active' &&
        !before.supervised &&
        input.supervised
      ) {
        await assertAnotherFullSuperadmin(trx, user.id);
      }

      let membershipId: string;
      if (current === undefined) {
        const row = await trx
          .insertInto('memberships')
          .values({
            tenant_id: platformId,
            user_id: user.id,
            role: 'superadmin',
            status: 'active',
            invited_by: actor,
            platform_supervised: input.supervised,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        membershipId = row.id;
      } else {
        await trx
          .updateTable('memberships')
          .set({
            role: 'superadmin',
            status: 'active',
            platform_supervised: input.supervised,
            removed_at: null,
            removed_by: null,
          })
          .where('id', '=', current.id)
          .execute();
        membershipId = current.id;
      }

      await this.audit.emitWithin(trx, {
        eventType: PLATFORM_ADMIN_EVENTS.granted,
        tenantId: platformId,
        actorUserId: actor,
        aggregateType: 'membership',
        aggregateId: membershipId,
        payload: {
          targetUserId: user.id,
          before,
          after: { role: 'superadmin', status: 'active', supervised: input.supervised },
          ...(input.reason !== null ? { reason: input.reason } : {}),
        },
      });
    });
    return this.list(actor);
  }

  /** Pleno ↔ supervisado. */
  async setSupervised(
    actor: string,
    input: { userId: string; supervised: boolean; reason: string | null },
  ): Promise<PlatformAdminView[]> {
    if (input.userId === actor) throw new SelfPlatformAdminChangeError();
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const current = await lockPlatformAdmin(trx, input.userId);
      if (current.status !== 'active') throw new PlatformAdminNotFoundError();
      if (current.platform_supervised === input.supervised) return;
      if (input.supervised) await assertAnotherFullSuperadmin(trx, input.userId);

      await trx
        .updateTable('memberships')
        .set({ platform_supervised: input.supervised })
        .where('id', '=', current.id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: PLATFORM_ADMIN_EVENTS.supervisionChanged,
        tenantId: current.tenant_id,
        actorUserId: actor,
        aggregateType: 'membership',
        aggregateId: current.id,
        payload: {
          targetUserId: input.userId,
          before: { supervised: current.platform_supervised },
          after: { supervised: input.supervised },
          ...(input.reason !== null ? { reason: input.reason } : {}),
        },
      });
    });
    return this.list(actor);
  }

  /** Le quita el acceso de superadmin: la membership de la plataforma queda quitada (0067). */
  async revoke(
    actor: string,
    input: { userId: string; reason: string | null },
  ): Promise<PlatformAdminView[]> {
    if (input.userId === actor) throw new SelfPlatformAdminChangeError();
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const current = await lockPlatformAdmin(trx, input.userId);
      if (current.status === 'active' && !current.platform_supervised) {
        await assertAnotherFullSuperadmin(trx, input.userId);
      }
      await trx
        .updateTable('memberships')
        .set({
          status: 'removed',
          removed_at: sql<Date>`now()`,
          removed_by: actor,
        })
        .where('id', '=', current.id)
        .execute();
      const revokedSessions = await this.sessions.revokeForTenant(
        input.userId,
        current.tenant_id,
        'membership_removed',
        trx,
      );
      await this.audit.emitWithin(trx, {
        eventType: PLATFORM_ADMIN_EVENTS.revoked,
        tenantId: current.tenant_id,
        actorUserId: actor,
        aggregateType: 'membership',
        aggregateId: current.id,
        payload: {
          targetUserId: input.userId,
          before: {
            role: current.role,
            status: current.status,
            supervised: current.platform_supervised,
          },
          after: { role: current.role, status: 'removed', supervised: current.platform_supervised },
          revokedSessions,
          ...(input.reason !== null ? { reason: input.reason } : {}),
        },
      });
    });
    return this.list(actor);
  }
}

async function lockPlatformAdmin(trx: Transaction<DB>, userId: string) {
  const row = await trx
    .selectFrom('memberships as m')
    .innerJoin('tenants as t', 't.id', 'm.tenant_id')
    .select(['m.id', 'm.tenant_id', 'm.role', 'm.status', 'm.platform_supervised'])
    .where('m.user_id', '=', userId)
    .where('m.role', '=', 'superadmin')
    .where('m.status', 'in', ['active', 'suspended'])
    .where('t.tenant_type', '=', 'platform')
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new PlatformAdminNotFoundError();
  return row;
}

/**
 * 409 si, sin `excludeUserId`, no queda ningún superadmin PLENO activo: nadie podría aprobar las
 * solicitudes ni nombrar a otro. Bloquea las filas en orden de id antes de contar, como
 * PlatformUsersService.assertNotLastSuperadmin: dos plenos que se bajan uno al otro a la vez no
 * dejan la plataforma sin ninguno.
 */
export async function assertAnotherFullSuperadmin(
  trx: Transaction<DB>,
  excludeUserId: string,
): Promise<void> {
  const full = await trx
    .selectFrom('users as u')
    .select('u.id')
    .where('u.status', '=', 'active')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('memberships as m')
          .innerJoin('tenants as t', 't.id', 'm.tenant_id')
          .select(sql<number>`1`.as('one'))
          .whereRef('m.user_id', '=', 'u.id')
          .where('m.role', '=', 'superadmin')
          .where('m.status', '=', 'active')
          .where('m.platform_supervised', '=', false)
          .where('t.tenant_type', '=', 'platform'),
      ),
    )
    .orderBy('u.id')
    .forUpdate()
    .execute();
  if (!full.some((u) => u.id !== excludeUserId)) throw new LastFullSuperadminError();
}
