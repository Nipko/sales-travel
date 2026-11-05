import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { z } from '@sales-travel/validation';
import { sql, type Transaction } from 'kysely';
import { platformTenantId } from '../audit/admin-audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, PlatformChangeRequestStatus } from '../database/database.types.js';
import { approvalContextStorage, currentApproval } from './approval-context.js';
import {
  ChangeKindUnknownError,
  ChangeRequestNotFoundError,
  ChangeRequestNotPendingError,
  ChangeRequestPendingError,
  FullSuperadminRequiredError,
  NotRequesterError,
  OwnChangeRequestError,
} from './platform-admins.errors.js';

/** Qué es quien pide en la plataforma: superadmin pleno, supervisado o ninguno. */
export type PlatformStanding = 'full' | 'supervised' | null;

/** Los eventos de las solicitudes. Caen en la categoría «Superadmins» de Plataforma → Actividad. */
export const CHANGE_REQUEST_EVENTS = {
  created: 'platform.change_request.created',
  approved: 'platform.change_request.approved',
  rejected: 'platform.change_request.rejected',
  cancelled: 'platform.change_request.cancelled',
  failed: 'platform.change_request.failed',
} as const;

/**
 * Cómo se aplica un tipo de cambio cuando se aprueba: el esquema con que se vuelve a validar lo
 * guardado, una línea para la lista y la acción, con el actor de quien lo pidió.
 */
export interface ChangeKindDefinition<I> {
  readonly schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  readonly summary: (input: I) => string;
  readonly execute: (actor: string, input: I) => Promise<unknown>;
}

export interface ChangeRequestView {
  id: string;
  kind: string;
  summary: string;
  input: Record<string, unknown>;
  status: PlatformChangeRequestStatus;
  requestedBy: { id: string; email: string | null };
  decidedBy: { id: string; email: string | null } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  error: string | null;
  createdAt: string;
}

interface ChangeRequestRow {
  id: string;
  kind: string;
  summary: string;
  input: unknown;
  status: PlatformChangeRequestStatus;
  requested_by: string;
  requested_email: string | null;
  decided_by: string | null;
  decided_email: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  error: string | null;
  created_at: Date;
}

const SUMMARY_MAX = 300;
const ERROR_MAX = 500;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function changeRequestView(row: ChangeRequestRow): ChangeRequestView {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    input: asRecord(row.input),
    status: row.status,
    requestedBy: { id: row.requested_by, email: row.requested_email },
    decidedBy: row.decided_by === null ? null : { id: row.decided_by, email: row.decided_email },
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    error: row.error,
    createdAt: iso(row.created_at) ?? '',
  };
}

/** El mensaje que queda en la solicitud si aplicarla falló: el de la API, nunca el stack. */
export function failureMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message =
      typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? err.message);
    const text = Array.isArray(message)
      ? message.filter((m): m is string => typeof m === 'string').join('. ')
      : typeof message === 'string'
        ? message
        : err.message;
    return text.slice(0, ERROR_MAX);
  }
  return 'No se pudo aplicar el cambio. Revisa el estado actual y pídelo de nuevo si hace falta.';
}

/**
 * El superadmin supervisado (docs/platform/16, founder 2026-11-05: «pleno + supervisado»).
 *
 * Cada ruta sensible llama a {@link gate} con su tipo de cambio y lo que se pidió, después de
 * comprobar que quien pide es superadmin. Un pleno sigue de largo; un supervisado deja la solicitud
 * en platform_change_requests y recibe 409 CHANGE_REQUEST_PENDING. Cuando un pleno la aprueba, se
 * vuelve a validar lo guardado y se aplica con el actor de quien la pidió, dentro del
 * {@link approvalContextStorage}: cada evento que deja lleva quién la pidió y quién la aprobó.
 *
 * Es la puerta de la app; la RLS de platform_change_requests (0092) exige de nuevo que sólo un pleno
 * decida.
 */
@Injectable()
export class SupervisionService {
  private readonly logger = new Logger(SupervisionService.name);
  private readonly kinds = new Map<string, ChangeKindDefinition<unknown>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Lo llama cada controlador con sus rutas sensibles, al iniciar el módulo. */
  register<I>(kind: string, definition: ChangeKindDefinition<I>): void {
    if (this.kinds.has(kind)) throw new Error(`tipo de cambio repetido: ${kind}`);
    this.kinds.set(kind, definition as ChangeKindDefinition<unknown>);
  }

  registeredKinds(): string[] {
    return [...this.kinds.keys()].sort();
  }

  async standing(userId: string): Promise<PlatformStanding> {
    return this.db.withRequestContext({ userId }, async (trx) => standingWithin(trx, userId));
  }

  /** 403 si no es un superadmin pleno. */
  async assertFull(userId: string, message?: string): Promise<void> {
    if ((await this.standing(userId)) !== 'full') throw new FullSuperadminRequiredError(message);
  }

  /**
   * La puerta de una ruta sensible. Sigue de largo con un pleno, con quien no es superadmin (la ruta
   * tiene su propia autorización) y con el cambio que se está aplicando al aprobar. Con un
   * supervisado, deja la solicitud y corta con {@link ChangeRequestPendingError}.
   */
  async gate(actor: string, kind: string, input: unknown): Promise<void> {
    const approval = currentApproval();
    if (approval !== undefined && approval.kind === kind && approval.requestedBy === actor) return;
    const standing = await this.standing(actor);
    if (standing !== 'supervised') return;

    const definition = this.kinds.get(kind);
    if (definition === undefined) throw new Error(`tipo de cambio sin registrar: ${kind}`);
    const parsed = definition.schema.parse(input);
    const summary = definition.summary(parsed).slice(0, SUMMARY_MAX);

    const id = await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const row = await trx
        .insertInto('platform_change_requests')
        .values({
          kind,
          summary,
          input: JSON.stringify(parsed ?? {}),
          requested_by: actor,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.emitWithin(trx, {
        eventType: CHANGE_REQUEST_EVENTS.created,
        tenantId: await platformTenantId(trx),
        actorUserId: actor,
        aggregateType: 'change_request',
        aggregateId: row.id,
        payload: { kind, summary, input: parsed ?? {} },
      });
      return row.id;
    });
    throw new ChangeRequestPendingError(id);
  }

  async list(
    viewer: string,
    status: PlatformChangeRequestStatus | undefined,
  ): Promise<ChangeRequestView[]> {
    return this.db.withRequestContext({ userId: viewer }, async (trx) => {
      const rows = await selectRequests(trx)
        .$if(status !== undefined, (qb) => qb.where('r.status', '=', status!))
        .orderBy('r.created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map(changeRequestView);
    });
  }

  /**
   * Aprobar: la toma (pending → approved, con quién y cuándo) y la aplica. Si aplicarla falla, queda
   * `failed` con el motivo y el error sale tal cual: el pleno ve por qué.
   */
  async approve(approver: string, id: string, note: string | null): Promise<ChangeRequestView> {
    await this.assertFull(approver);
    const claimed = await this.db.withRequestContext({ userId: approver }, async (trx) => {
      const row = await this.lockPending(trx, id);
      if (row.requested_by === approver) throw new OwnChangeRequestError();
      if (!this.kinds.has(row.kind)) throw new ChangeKindUnknownError();
      await trx
        .updateTable('platform_change_requests')
        .set({
          status: 'approved',
          decided_by: approver,
          decided_at: sql<Date>`now()`,
          decision_note: note,
        })
        .where('id', '=', id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: CHANGE_REQUEST_EVENTS.approved,
        tenantId: await platformTenantId(trx),
        actorUserId: approver,
        aggregateType: 'change_request',
        aggregateId: id,
        payload: {
          kind: row.kind,
          summary: row.summary,
          requestedBy: row.requested_by,
          ...(note !== null ? { note } : {}),
        },
      });
      return row;
    });

    const definition = this.kinds.get(claimed.kind)!;
    try {
      const input = definition.schema.parse(claimed.input);
      await approvalContextStorage.run(
        {
          changeRequestId: id,
          kind: claimed.kind,
          requestedBy: claimed.requested_by,
          approvedBy: approver,
          note,
        },
        () => definition.execute(claimed.requested_by, input),
      );
    } catch (err) {
      const message = failureMessage(err);
      this.logger.warn(`solicitud ${id} (${claimed.kind}) aprobada pero no aplicada: ${message}`);
      await this.db.withRequestContext({ userId: approver }, async (trx) => {
        await trx
          .updateTable('platform_change_requests')
          .set({ status: 'failed', error: message })
          .where('id', '=', id)
          .execute();
        await this.audit.emitWithin(trx, {
          eventType: CHANGE_REQUEST_EVENTS.failed,
          tenantId: await platformTenantId(trx),
          actorUserId: approver,
          aggregateType: 'change_request',
          aggregateId: id,
          payload: { kind: claimed.kind, summary: claimed.summary, error: message },
        });
      });
      throw err;
    }
    return this.get(approver, id);
  }

  async reject(approver: string, id: string, note: string | null): Promise<ChangeRequestView> {
    await this.assertFull(approver);
    await this.db.withRequestContext({ userId: approver }, async (trx) => {
      const row = await this.lockPending(trx, id);
      if (row.requested_by === approver) throw new OwnChangeRequestError();
      await trx
        .updateTable('platform_change_requests')
        .set({
          status: 'rejected',
          decided_by: approver,
          decided_at: sql<Date>`now()`,
          decision_note: note,
        })
        .where('id', '=', id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: CHANGE_REQUEST_EVENTS.rejected,
        tenantId: await platformTenantId(trx),
        actorUserId: approver,
        aggregateType: 'change_request',
        aggregateId: id,
        payload: {
          kind: row.kind,
          summary: row.summary,
          requestedBy: row.requested_by,
          ...(note !== null ? { note } : {}),
        },
      });
    });
    return this.get(approver, id);
  }

  /** Quien la pidió la retira mientras está pendiente. */
  async cancel(actor: string, id: string): Promise<ChangeRequestView> {
    await this.db.withRequestContext({ userId: actor }, async (trx) => {
      const row = await this.lockPending(trx, id);
      if (row.requested_by !== actor) throw new NotRequesterError();
      await trx
        .updateTable('platform_change_requests')
        .set({ status: 'cancelled', decided_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      await this.audit.emitWithin(trx, {
        eventType: CHANGE_REQUEST_EVENTS.cancelled,
        tenantId: await platformTenantId(trx),
        actorUserId: actor,
        aggregateType: 'change_request',
        aggregateId: id,
        payload: { kind: row.kind, summary: row.summary },
      });
    });
    return this.get(actor, id);
  }

  private async get(viewer: string, id: string): Promise<ChangeRequestView> {
    return this.db.withRequestContext({ userId: viewer }, async (trx) => {
      const row = await selectRequests(trx).where('r.id', '=', id).executeTakeFirst();
      if (row === undefined) throw new ChangeRequestNotFoundError();
      return changeRequestView(row);
    });
  }

  private async lockPending(
    trx: Transaction<DB>,
    id: string,
  ): Promise<{ kind: string; summary: string; input: unknown; requested_by: string }> {
    const row = await trx
      .selectFrom('platform_change_requests')
      .select(['kind', 'summary', 'input', 'requested_by', 'status'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new ChangeRequestNotFoundError();
    if (row.status !== 'pending') throw new ChangeRequestNotPendingError();
    return row;
  }
}

function selectRequests(trx: Transaction<DB>) {
  return trx
    .selectFrom('platform_change_requests as r')
    .leftJoin('users as ru', 'ru.id', 'r.requested_by')
    .leftJoin('users as du', 'du.id', 'r.decided_by')
    .select([
      'r.id',
      'r.kind',
      'r.summary',
      'r.input',
      'r.status',
      'r.requested_by',
      sql<string | null>`ru.email::text`.as('requested_email'),
      'r.decided_by',
      sql<string | null>`du.email::text`.as('decided_email'),
      'r.decided_at',
      'r.decision_note',
      'r.error',
      'r.created_at',
    ]);
}

/** Pleno, supervisado o nada, con el mismo criterio que is_platform_superadmin (0075). */
export async function standingWithin(
  trx: Transaction<DB>,
  userId: string,
): Promise<PlatformStanding> {
  const row = await trx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('tenants as t', 't.id', 'm.tenant_id')
    .select('m.platform_supervised')
    .where('m.user_id', '=', userId)
    .where('m.role', '=', 'superadmin')
    .where('m.status', '=', 'active')
    .where('u.status', '=', 'active')
    .where('t.tenant_type', '=', 'platform')
    .orderBy('m.platform_supervised', 'asc')
    .executeTakeFirst();
  if (row === undefined) return null;
  return row.platform_supervised ? 'supervised' : 'full';
}
