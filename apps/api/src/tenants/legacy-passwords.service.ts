import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { platformTenantId } from '../audit/admin-audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { mailNodeOf, type MailNode } from '../mail/mail-node.js';
import { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';

/**
 * Cuentas heredadas con una contraseña que eligió un admin (USR-14, founder D3 = B).
 *
 * Hasta el alta sólo por invitación (2026-09-30, docs/platform/14), `POST /admin/users` con un correo
 * nuevo y `POST /admin/tenants` con `adminPassword` creaban la cuenta con la contraseña que escribía
 * el admin. Esas cuentas siguen con ella hasta que la persona la cambie. El superadmin las ve en una
 * lista, elige cuáles y les fuerza el cambio: a cada una le pasa lo mismo que con "Forzar cambio de
 * contraseña" de Equipo (USR-3): se cierran sus sesiones, el login la frena y le llega su propio
 * enlace de un solo uso.
 *
 * **El criterio** sale de los datos, no de los eventos. Una cuenta es heredada si:
 *
 *   - nació en la MISMA transacción que una membership que le dio OTRA cuenta: `memberships.invited_by`
 *     no nulo y distinto de ella, con `memberships.created_at = users.created_at` (`now()` es el inicio
 *     de la transacción). Sólo los dos caminos retirados hacían eso: el alta pública, aceptar una
 *     invitación y los seeds nunca ponen `invited_by` en la membership, y vincular una cuenta que ya
 *     existía crea la membership en otra transacción;
 *   - conserva la contraseña con que nació: `password_hash` no nulo y `password_changed_at` nulo (el
 *     canje del enlace y Mi cuenta → Seguridad lo fijan; antes de 0026 no había cómo cambiarla);
 *   - está activa y sin un cambio forzado pendiente (`password_reset_required_at` nulo);
 *   - se creó antes de {@link LEGACY_CREATED_BEFORE}, el tope de seguridad.
 *
 * Los eventos (`UserCreated`, que existe desde 2026-08-06, y `TenantCreated` con `admin: 'created'`,
 * desde 2026-09-28) dicen lo mismo, pero no cubren las cuentas de mayo a agosto. No se reconoce una
 * cuenta cuyo admin creador ya no existe (`invited_by` pasa a NULL) o cuya membership original se
 * borró con su nodo: esas se fuerzan una por una desde Equipo.
 *
 * Quién puede: sólo el superadmin, y nunca sobre sí mismo. Forzar pide el 2FA de los últimos 10
 * minutos (lo pone el controlador). Volver a correrlo no le escribe de nuevo a nadie: quien ya tiene
 * el cambio pendiente deja de ser candidato y se omite.
 */

/** Como mucho tantas cuentas en la lista; las más recientes primero. */
export const LEGACY_PASSWORDS_LIST_MAX = 500;

/**
 * Tope de seguridad del criterio: sólo cuentan las cuentas creadas antes de este instante. Los
 * caminos retirados salieron de producción con el alta por invitación (2026-09-30); el tope va dos
 * semanas después para no perder ninguna aunque ese despliegue se hubiera demorado. Lo que cuida: la
 * cuenta de quien acepta una invitación nace en la misma transacción que su membership, así que si
 * algún día el canje le pone `invited_by` (quién la invitó), sin el tope cada cuenta nueva pasaría a
 * ser "heredada" y el panel ofrecería forzarle el cambio a gente que eligió su propia contraseña.
 */
export const LEGACY_CREATED_BEFORE = '2026-10-14T00:00:00Z';

/** Correos que salen a la vez dentro de un lote. Cada uno abre su propia conexión SMTP. */
export const LEGACY_RESET_MAIL_CONCURRENCY = 5;

/** El rastro de cada lote, en la raíz `platform`. Su nombre legible está en el panel (audit-format.ts). */
export const LEGACY_RESET_BATCH_EVENT = 'auth.password_reset.required_bulk';

/** Una cuenta heredada, con lo que el superadmin necesita para decidir. */
export interface LegacyPasswordAccount {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  /** Sus accesos activos hoy. Con cero igual se lista: puede volver a entrar con una invitación. */
  activeNodes: number;
  /** Dónde nació y quién eligió la contraseña. `createdByEmail` es null si esa cuenta ya no está. */
  origin: { tenantId: string; tenantName: string; createdByEmail: string | null };
}

export interface LegacyPasswordsList {
  users: LegacyPasswordAccount[];
  /** Había más de {@link LEGACY_PASSWORDS_LIST_MAX}: al terminar con éstas, la lista trae el resto. */
  truncated: boolean;
}

/**
 * Por qué una cuenta pedida no se forzó:
 *   - `self`: es quien lo pide;
 *   - `suspended`: la cuenta está suspendida en la plataforma (no entra igual);
 *   - `already_required`: ya tiene el cambio pendiente (otro lote, o Equipo): no se le escribe otra vez;
 *   - `password_changed`: ya eligió su propia contraseña;
 *   - `not_candidate`: no existe o no nació con una contraseña de un admin.
 */
export type LegacyResetSkipReason =
  | 'self'
  | 'suspended'
  | 'already_required'
  | 'password_changed'
  | 'not_candidate';

export type LegacyResetResult =
  | { userId: string; status: 'sent'; revokedSessions: number }
  /** El cambio quedó forzado pero el correo no salió: al intentar ingresar le llega otro. */
  | { userId: string; status: 'email_failed'; revokedSessions: number }
  | { userId: string; status: 'skipped'; reason: LegacyResetSkipReason }
  /** No se pudo aplicar (la base falló): la cuenta quedó como estaba. */
  | { userId: string; status: 'failed' };

export interface LegacyResetCounts {
  sent: number;
  emailFailed: number;
  skipped: number;
  failed: number;
}

export interface LegacyResetBatch {
  results: LegacyResetResult[];
  counts: LegacyResetCounts;
}

// ─────────────────────────── El criterio, en SQL ───────────────────────────

/**
 * La membership con que nació la cuenta `u`, si se la dio otra cuenta en la misma transacción y antes
 * del tope. Una sola: los caminos retirados creaban una. Cuenta aunque hoy esté quitada o suspendida.
 */
const ORIGIN_MEMBERSHIP = sql`
  SELECT m.tenant_id, m.invited_by
    FROM memberships m
   WHERE m.user_id = u.id
     AND m.invited_by IS NOT NULL
     AND m.invited_by <> u.id
     AND m.created_at = u.created_at
     AND u.created_at < ${LEGACY_CREATED_BEFORE}::timestamptz
   ORDER BY m.id
   LIMIT 1`;

/** Sigue con la contraseña con que nació, activa y sin un cambio forzado pendiente. */
const KEEPS_ORIGINAL_PASSWORD = sql`
      u.status = 'active'
  AND u.password_hash IS NOT NULL
  AND u.password_changed_at IS NULL
  AND u.password_reset_required_at IS NULL`;

interface CandidateRow {
  id: string;
  email: string;
  name: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
  active_nodes: number | string;
  origin_tenant_id: string;
  origin_tenant_name: string;
  created_by_email: string | null;
}

/**
 * Las cuentas heredadas, sin la de quien mira, de la más reciente a la más vieja, con una de más
 * para saber si había más. Corre con el contexto del superadmin: `users` y `tenants` no tienen RLS y
 * la de memberships le deja leerlas todas (0020).
 */
export function legacyCandidatesQuery(actorUserId: string, limit = LEGACY_PASSWORDS_LIST_MAX) {
  return sql<CandidateRow>`
    SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
           (SELECT count(*) FROM memberships a
             WHERE a.user_id = u.id AND a.status = 'active')::int AS active_nodes,
           o.tenant_id AS origin_tenant_id,
           t.name AS origin_tenant_name,
           c.email AS created_by_email
      FROM users u
     CROSS JOIN LATERAL (${ORIGIN_MEMBERSHIP}) o
      JOIN tenants t ON t.id = o.tenant_id
      LEFT JOIN users c ON c.id = o.invited_by
     WHERE ${KEEPS_ORIGINAL_PASSWORD}
       AND u.id <> ${actorUserId}::uuid
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ${limit + 1}`;
}

/** La cuenta pedida, tomada (`FOR NO KEY UPDATE`) para decidir y forzar sin que cambie en el medio. */
interface LockedAccount {
  email: string;
  status: string;
  has_password: boolean;
  changed: boolean;
  required: boolean;
  /** El nodo donde nació con la contraseña de un admin; `null` si no es heredada. */
  origin_tenant_id: string | null;
}

/**
 * La misma fila que forzar el cambio desde Equipo y en el mismo orden (usuario → enlaces): un canje
 * en paralelo se ordena con ésta y no se traba.
 */
function lockAccount(trx: Transaction<DB>, userId: string) {
  return sql<LockedAccount>`
    SELECT u.email, u.status,
           u.password_hash IS NOT NULL AS has_password,
           u.password_changed_at IS NOT NULL AS changed,
           u.password_reset_required_at IS NOT NULL AS required,
           (SELECT o.tenant_id FROM (${ORIGIN_MEMBERSHIP}) o) AS origin_tenant_id
      FROM users u
     WHERE u.id = ${userId}::uuid
       FOR NO KEY UPDATE OF u`.execute(trx);
}

// ─────────────────────────── Plegados (sin I/O) ───────────────────────────

/** Por qué no se fuerza esta cuenta, o `null` si sigue siendo heredada. El orden es el del panel. */
export function legacySkipReason(row: LockedAccount | undefined): LegacyResetSkipReason | null {
  if (row === undefined) return 'not_candidate';
  if (row.status !== 'active') return 'suspended';
  if (row.required) return 'already_required';
  if (row.changed) return 'password_changed';
  if (!row.has_password || row.origin_tenant_id === null) return 'not_candidate';
  return null;
}

/** Los ids sin repetir, en el orden en que llegaron. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

export function countResults(results: readonly LegacyResetResult[]): LegacyResetCounts {
  const counts: LegacyResetCounts = { sent: 0, emailFailed: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    if (r.status === 'sent') counts.sent += 1;
    else if (r.status === 'email_failed') counts.emailFailed += 1;
    else if (r.status === 'skipped') counts.skipped += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** Corre `fn` sobre cada elemento con hasta `limit` a la vez; los resultados, en el orden de `items`. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Lo que dejó forzada una cuenta, para el correo que sale después del commit. */
interface Forced {
  userId: string;
  email: string;
  token: string;
  revokedSessions: number;
  /** El nodo por cuyo correo se le escribe; sin accesos activos, el correo del sistema. */
  node: MailNode | undefined;
  /** El nodo de su rastro: el de su correo o, sin accesos activos, donde nació. */
  auditTenantId: string;
}

// ─────────────────────────── El servicio ───────────────────────────

@Injectable()
export class LegacyPasswordsService {
  private readonly logger = new Logger(LegacyPasswordsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly resets: PasswordResetService,
  ) {}

  /**
   * Las cuentas heredadas de toda la plataforma, sin la propia. 403 a quien no es superadmin antes de
   * leer nada: el chequeo vive acá para que ningún llamador pueda saltearlo.
   */
  async list(actorUserId: string): Promise<LegacyPasswordsList> {
    await this.assertSuperadmin(actorUserId);
    const { rows } = await this.db.withRequestContext({ userId: actorUserId }, (trx) =>
      legacyCandidatesQuery(actorUserId).execute(trx),
    );
    return {
      users: rows.slice(0, LEGACY_PASSWORDS_LIST_MAX).map(
        (r): LegacyPasswordAccount => ({
          id: r.id,
          email: r.email,
          name: r.name,
          createdAt: iso(r.created_at),
          lastLoginAt: r.last_login_at === null ? null : iso(r.last_login_at),
          activeNodes: Number(r.active_nodes),
          origin: {
            tenantId: r.origin_tenant_id,
            tenantName: r.origin_tenant_name,
            createdByEmail: r.created_by_email,
          },
        }),
      ),
      truncated: rows.length > LEGACY_PASSWORDS_LIST_MAX,
    };
  }

  /**
   * Fuerza el cambio de contraseña a las cuentas pedidas que sigan siendo heredadas.
   *
   * Primero los cambios, uno por cuenta y cada uno en su transacción: la cuenta se toma, se vuelve a
   * mirar el criterio (la lista pudo quedar vieja) y `PasswordResetService.requireReset` la marca,
   * cierra sus sesiones, deja un solo enlace y lo audita (`bulk: true` y el lote). Una cuenta que
   * falla no frena a las demás. Después los correos, hasta {@link LEGACY_RESET_MAIL_CONCURRENCY} a
   * la vez, cada uno por el correo de su nodo activo más antiguo (el mismo de los avisos de USR-12),
   * o por el del sistema si no tiene ninguno; el que
   * no sale queda auditado (`via: 'legacy'`) y la persona recibe otro al intentar ingresar. Al final,
   * el rastro del lote en la raíz `platform`, con cuántas de cada resultado.
   */
  async requireReset(actorUserId: string, userIds: readonly string[]): Promise<LegacyResetBatch> {
    await this.assertSuperadmin(actorUserId);
    const batchId = randomUUID();
    const ids = uniqueIds(userIds);

    const outcomes: (LegacyResetResult | Forced)[] = [];
    for (const userId of ids) {
      outcomes.push(await this.force(actorUserId, userId, batchId));
    }

    const results = await mapWithConcurrency(
      outcomes,
      LEGACY_RESET_MAIL_CONCURRENCY,
      async (outcome): Promise<LegacyResetResult> =>
        'token' in outcome ? this.mail(actorUserId, outcome, batchId) : outcome,
    );
    const counts = countResults(results);
    await this.traceBatch(actorUserId, batchId, ids.length, counts);
    return { results, counts };
  }

  /** Una cuenta: decidir y forzar, en su transacción. El correo va después del commit. */
  private async force(
    actorUserId: string,
    userId: string,
    batchId: string,
  ): Promise<LegacyResetResult | Forced> {
    if (userId === actorUserId) return { userId, status: 'skipped', reason: 'self' };
    try {
      // Su nodo activo más antiguo: el del correo y el del rastro, así su Actividad lo muestra.
      const node = await mailNodeOf(this.db, userId);
      return await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const { rows } = await lockAccount(trx, userId);
        const row = rows[0];
        const reason = legacySkipReason(row);
        if (reason !== null || row === undefined || row.origin_tenant_id === null) {
          return { userId, status: 'skipped', reason: reason ?? 'not_candidate' } as const;
        }
        // Sin accesos activos (la quitaron de todos sus nodos) el rastro va al nodo donde nació: sin
        // nodo no aparecería en ninguna Actividad.
        const auditTenantId = node?.tenantId ?? row.origin_tenant_id;
        const { token, revokedSessions } = await this.resets.requireReset(trx, {
          actorUserId,
          targetUserId: userId,
          tenantId: auditTenantId,
          batchId,
        });
        return { userId, email: row.email, token, revokedSessions, node, auditTenantId };
      });
    } catch (err) {
      // Sin el correo ni el mensaje de la base (puede citarlo): el id y la clase alcanzan.
      this.logger.error(
        `no se pudo forzar el cambio de contraseña (user=${userId}, lote=${batchId}): ${(err as Error).name}`,
      );
      return { userId, status: 'failed' };
    }
  }

  private async mail(
    actorUserId: string,
    forced: Forced,
    batchId: string,
  ): Promise<LegacyResetResult> {
    const sent = await this.resets.sendResetEmail(
      forced.node?.tenantId ?? null,
      forced.email,
      this.resets.resetLink(forced.token),
      'legacy',
      forced.node?.name ?? null,
    );
    if (!sent) {
      await this.audit.emit({
        eventType: 'auth.password_reset.email_failed',
        tenantId: forced.auditTenantId,
        actorUserId,
        aggregateType: 'user',
        aggregateId: forced.userId,
        payload: { targetUserId: forced.userId, via: 'legacy', batchId },
      });
    }
    return {
      userId: forced.userId,
      status: sent ? 'sent' : 'email_failed',
      revokedSessions: forced.revokedSessions,
    };
  }

  /**
   * El rastro del lote. Cada cuenta ya dejó el suyo en su transacción: si éste no entra, se avisa en
   * el log y la respuesta sale igual (los cambios ya están hechos).
   */
  private async traceBatch(
    actorUserId: string,
    batchId: string,
    requested: number,
    counts: LegacyResetCounts,
  ): Promise<void> {
    try {
      await this.db.withRequestContext({ userId: actorUserId }, async (trx) =>
        this.audit.emitWithin(trx, {
          eventType: LEGACY_RESET_BATCH_EVENT,
          tenantId: await platformTenantId(trx),
          actorUserId,
          payload: { batchId, requested, ...counts },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `no se pudo registrar ${LEGACY_RESET_BATCH_EVENT} (lote=${batchId}): ${(err as Error).name}`,
      );
    }
  }

  private async assertSuperadmin(actorUserId: string): Promise<void> {
    if (!(await this.network.isSuperadmin(actorUserId))) throw new SuperadminRequiredError();
  }
}
