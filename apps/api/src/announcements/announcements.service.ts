import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import {
  AnnouncementArchivedError,
  AnnouncementAudienceNotFoundError,
  AnnouncementNotFoundError,
  AnnouncementWindowError,
} from './announcements.errors.js';
import {
  announcementWindowError,
  type AnnouncementAudience,
  type AnnouncementSeverity,
  type CreateAnnouncementDto,
  type UpdateAnnouncementDto,
} from './announcements.schemas.js';

/** El rastro de cada cambio, en la raíz `platform`: a quién iba y con qué gravedad, nunca el mensaje. */
export const ANNOUNCEMENT_EVENTS = {
  published: 'platform.announcement.published',
  updated: 'platform.announcement.updated',
  archived: 'platform.announcement.archived',
} as const;

export const ANNOUNCEMENT_AGGREGATE = 'system_announcement';

/** Cuántos anuncios lista el panel: los últimos publicados. */
export const ADMIN_ANNOUNCEMENTS_LIMIT = 50;

export type AnnouncementStatus = 'scheduled' | 'active' | 'expired' | 'archived';

/** Lo que ve cualquier usuario en la franja del panel. */
export interface ActiveAnnouncementView {
  readonly id: string;
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Un anuncio en Plataforma → Sistema › Anuncios. */
export interface AdminAnnouncementView extends ActiveAnnouncementView {
  readonly audience: {
    /** `null` = toda la red. */
    readonly rootTenantId: string | null;
    readonly rootTenantName: string | null;
    readonly adminsOnly: boolean;
  };
  readonly status: AnnouncementStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** Los campos que se pueden corregir, como los nombra el rastro de `.updated`. */
export type AnnouncementField = 'severity' | 'title' | 'body' | 'audience' | 'startsAt' | 'endsAt';

interface ActiveRow {
  id: string;
  severity: AnnouncementSeverity;
  title: string;
  body: string;
  starts_at: Date;
  ends_at: Date;
}

interface AdminRow extends ActiveRow {
  audience_root_tenant_id: string | null;
  audience_root_name: string | null;
  audience_admins_only: boolean;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  db_now: Date;
}

/**
 * Programado antes de empezar, vigente mientras dura, vencido al terminar; archivado gana a todo. Con
 * la hora de la base, la misma con la que active_announcements() decide qué se muestra.
 */
export function announcementStatus(
  row: { readonly starts_at: Date; readonly ends_at: Date; readonly archived_at: Date | null },
  now: Date,
): AnnouncementStatus {
  if (row.archived_at !== null) return 'archived';
  if (now.getTime() < row.starts_at.getTime()) return 'scheduled';
  if (now.getTime() >= row.ends_at.getTime()) return 'expired';
  return 'active';
}

function toActiveView(r: ActiveRow): ActiveAnnouncementView {
  return {
    id: r.id,
    severity: r.severity,
    title: r.title,
    body: r.body,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
  };
}

function toAdminView(r: AdminRow): AdminAnnouncementView {
  return {
    ...toActiveView(r),
    audience: {
      rootTenantId: r.audience_root_tenant_id,
      rootTenantName: r.audience_root_name,
      adminsOnly: r.audience_admins_only,
    },
    status: announcementStatus(
      {
        starts_at: new Date(r.starts_at),
        ends_at: new Date(r.ends_at),
        archived_at: r.archived_at === null ? null : new Date(r.archived_at),
      },
      new Date(r.db_now),
    ),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    archivedAt: r.archived_at === null ? null : new Date(r.archived_at).toISOString(),
  };
}

/** Lo que guarda el rastro: el anuncio, su gravedad y a quién iba. Nunca el título ni el mensaje. */
function auditPayload(
  id: string,
  severity: AnnouncementSeverity,
  audience: AnnouncementAudience,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    announcementId: id,
    severity,
    audience: { rootTenantId: audience.rootTenantId, adminsOnly: audience.adminsOnly },
    ...extra,
  };
}

function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * Los anuncios de la plataforma (0079): los publica, corrige y archiva el superadmin, y cualquier
 * usuario del panel ve los vigentes para su nodo activo.
 *
 * Las escrituras van en UNA transacción con su `domain_event` (emitWithin) y con el superadmin en el
 * contexto, que es lo que exige la RLS de 0079; antes de tocar nada se le pregunta a la base si quien
 * pide sigue siendo el superadmin (is_platform_superadmin()), así que dejar de serlo entre la guarda y
 * la escritura es el mismo 403 que da la guarda y no un 404 por no ver la fila.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Los vigentes para `userId` en su nodo activo: una sola llamada a active_announcements(), que toma
   * los dos del request. Sin nodo activo no hay a quién mostrarle nada.
   */
  async active(userId: string, tenantId: string | undefined): Promise<ActiveAnnouncementView[]> {
    if (tenantId === undefined) return [];
    const res = await this.db.withRequestContext({ userId, tenantId }, (trx) =>
      sql<ActiveRow>`
        SELECT id, severity, title, body, starts_at, ends_at FROM active_announcements()
      `.execute(trx),
    );
    return res.rows.map(toActiveView);
  }

  /** Los últimos {@link ADMIN_ANNOUNCEMENTS_LIMIT} publicados, con su estado. */
  async list(actor: string): Promise<AdminAnnouncementView[]> {
    return this.asSuperadmin(actor, async (trx) => {
      const rows = await this.views(trx).limit(ADMIN_ANNOUNCEMENTS_LIMIT).execute();
      return rows.map(toAdminView);
    });
  }

  async create(actor: string, dto: CreateAnnouncementDto): Promise<AdminAnnouncementView> {
    return this.asSuperadmin(actor, async (trx) => {
      await this.assertAudience(trx, dto.audience.rootTenantId);
      const now = await this.dbNow(trx);
      const startsAt = dto.startsAt ?? now;
      this.assertWindow(startsAt, dto.endsAt, now);

      const row = await trx
        .insertInto('system_announcements')
        .values({
          severity: dto.severity,
          title: dto.title,
          body: dto.body,
          audience_root_tenant_id: dto.audience.rootTenantId,
          audience_admins_only: dto.audience.adminsOnly,
          starts_at: startsAt,
          ends_at: dto.endsAt,
          created_by: actor,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.audit.emitWithin(trx, {
        eventType: ANNOUNCEMENT_EVENTS.published,
        tenantId: await this.platformTenantId(trx),
        actorUserId: actor,
        aggregateType: ANNOUNCEMENT_AGGREGATE,
        aggregateId: row.id,
        payload: auditPayload(row.id, dto.severity, dto.audience, {
          startsAt: startsAt.toISOString(),
          endsAt: dto.endsAt.toISOString(),
        }),
      });
      return this.readOne(trx, row.id);
    });
  }

  /**
   * Corrige un anuncio no archivado. La vigencia se revisa con lo que ya tiene: cambiar sólo el final
   * también respeta los 31 días desde el comienzo. Si nada cambia, no escribe ni audita.
   */
  async update(
    actor: string,
    id: string,
    dto: UpdateAnnouncementDto,
  ): Promise<AdminAnnouncementView> {
    return this.asSuperadmin(actor, async (trx) => {
      const current = await this.lock(trx, id);

      const audience: AnnouncementAudience = dto.audience ?? {
        rootTenantId: current.audience_root_tenant_id,
        adminsOnly: current.audience_admins_only,
      };
      const next = {
        severity: dto.severity ?? current.severity,
        title: dto.title ?? current.title,
        body: dto.body ?? current.body,
        startsAt: dto.startsAt ?? new Date(current.starts_at),
        endsAt: dto.endsAt ?? new Date(current.ends_at),
      };

      const changed: AnnouncementField[] = [];
      if (next.severity !== current.severity) changed.push('severity');
      if (next.title !== current.title) changed.push('title');
      if (next.body !== current.body) changed.push('body');
      if (
        audience.rootTenantId !== current.audience_root_tenant_id ||
        audience.adminsOnly !== current.audience_admins_only
      ) {
        changed.push('audience');
      }
      if (!sameInstant(next.startsAt, new Date(current.starts_at))) changed.push('startsAt');
      if (!sameInstant(next.endsAt, new Date(current.ends_at))) changed.push('endsAt');
      if (changed.length === 0) return this.readOne(trx, id);

      if (changed.includes('audience')) await this.assertAudience(trx, audience.rootTenantId);
      if (changed.includes('startsAt') || changed.includes('endsAt')) {
        this.assertWindow(next.startsAt, next.endsAt, await this.dbNow(trx));
      }

      await trx
        .updateTable('system_announcements')
        .set({
          severity: next.severity,
          title: next.title,
          body: next.body,
          audience_root_tenant_id: audience.rootTenantId,
          audience_admins_only: audience.adminsOnly,
          starts_at: next.startsAt,
          ends_at: next.endsAt,
        })
        .where('id', '=', id)
        .execute();

      await this.audit.emitWithin(trx, {
        eventType: ANNOUNCEMENT_EVENTS.updated,
        tenantId: await this.platformTenantId(trx),
        actorUserId: actor,
        aggregateType: ANNOUNCEMENT_AGGREGATE,
        aggregateId: id,
        payload: auditPayload(id, next.severity, audience, { changed }),
      });
      return this.readOne(trx, id);
    });
  }

  /** Lo archiva: deja de mostrarse en el acto y no vuelve. */
  async archive(actor: string, id: string): Promise<AdminAnnouncementView> {
    return this.asSuperadmin(actor, async (trx) => {
      const current = await this.lock(trx, id);
      await trx
        .updateTable('system_announcements')
        .set({ archived_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: ANNOUNCEMENT_EVENTS.archived,
        tenantId: await this.platformTenantId(trx),
        actorUserId: actor,
        aggregateType: ANNOUNCEMENT_AGGREGATE,
        aggregateId: id,
        payload: auditPayload(id, current.severity, {
          rootTenantId: current.audience_root_tenant_id,
          adminsOnly: current.audience_admins_only,
        }),
      });
      return this.readOne(trx, id);
    });
  }

  /**
   * La transacción del superadmin. La base vuelve a decir si lo es; la RLS rechaza con 42501 a quien
   * dejó de serlo a mitad de camino. La FK del nodo (borrado entre la comprobación y el INSERT) y el
   * CHECK de la vigencia se traducen a los mismos errores que da la comprobación de la app.
   */
  private async asSuperadmin<T>(
    actor: string,
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.withRequestContext({ userId: actor }, async (trx) => {
        const check = await sql<{
          ok: boolean;
        }>`SELECT public.is_platform_superadmin() AS ok`.execute(trx);
        if (check.rows[0]?.ok !== true) throw new SuperadminRequiredError();
        return fn(trx);
      });
    } catch (err) {
      const { code, constraint } = (err ?? {}) as { code?: unknown; constraint?: unknown };
      if (code === '42501') throw new SuperadminRequiredError();
      if (code === '23503' && constraint === 'system_announcements_audience_root_tenant_id_fkey') {
        throw new AnnouncementAudienceNotFoundError();
      }
      if (code === '23514' && constraint === 'system_announcements_window') {
        throw new AnnouncementWindowError('La vigencia del anuncio no es válida.');
      }
      throw err;
    }
  }

  private views(trx: Transaction<DB>) {
    return trx
      .selectFrom('system_announcements as a')
      .leftJoin('tenants as t', 't.id', 'a.audience_root_tenant_id')
      .select([
        'a.id',
        'a.severity',
        'a.title',
        'a.body',
        'a.starts_at',
        'a.ends_at',
        'a.audience_root_tenant_id',
        't.name as audience_root_name',
        'a.audience_admins_only',
        'a.created_at',
        'a.updated_at',
        'a.archived_at',
        sql<Date>`now()`.as('db_now'),
      ])
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id');
  }

  private async readOne(trx: Transaction<DB>, id: string): Promise<AdminAnnouncementView> {
    const row = await this.views(trx).where('a.id', '=', id).executeTakeFirst();
    if (row === undefined) throw new AnnouncementNotFoundError();
    return toAdminView(row);
  }

  /** El anuncio, bloqueado hasta el fin de la transacción; uno archivado ya no se toca. */
  private async lock(trx: Transaction<DB>, id: string) {
    const row = await trx
      .selectFrom('system_announcements')
      .select([
        'id',
        'severity',
        'title',
        'body',
        'audience_root_tenant_id',
        'audience_admins_only',
        'starts_at',
        'ends_at',
        'archived_at',
      ])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new AnnouncementNotFoundError();
    if (row.archived_at !== null) throw new AnnouncementArchivedError();
    return row;
  }

  /** `tenants` no tiene RLS: el nodo se busca tal cual. */
  private async assertAudience(trx: Transaction<DB>, rootTenantId: string | null): Promise<void> {
    if (rootTenantId === null) return;
    const node = await trx
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', rootTenantId)
      .executeTakeFirst();
    if (node === undefined) throw new AnnouncementAudienceNotFoundError();
  }

  /** Un período de hasta 31 días que todavía no terminó. */
  private assertWindow(startsAt: Date, endsAt: Date, now: Date): void {
    const error = announcementWindowError(startsAt, endsAt);
    if (error !== undefined) throw new AnnouncementWindowError(error);
    if (endsAt.getTime() <= now.getTime()) {
      throw new AnnouncementWindowError('Ese final ya pasó: elige uno en el futuro.');
    }
  }

  private async dbNow(trx: Transaction<DB>): Promise<Date> {
    const res = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    return new Date(res.rows[0]?.now ?? Date.now());
  }

  /** La raíz `platform` (0050: hay una sola), donde queda el rastro. Sin ella, sin tenant. */
  private async platformTenantId(trx: Transaction<DB>): Promise<string | null> {
    const row = await trx
      .selectFrom('tenants')
      .select('id')
      .where('tenant_type', '=', 'platform')
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
