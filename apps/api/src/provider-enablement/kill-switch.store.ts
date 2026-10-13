import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import type { KillLevel } from '../search/circuit-breaker.service.js';

/**
 * Cada cuánto se relee `provider_kill_switches`. La réplica que recibe el cambio lo aplica al
 * instante; las demás, como mucho en esto. El mismo plazo que la caché de la habilitación (0048).
 */
export const KILL_SWITCH_REFRESH_MS = 10_000;

export const KILL_SWITCH_SET_EVENT = 'platform.provider_kill_switch.set';
export const KILL_SWITCH_CLEARED_EVENT = 'platform.provider_kill_switch.cleared';

/** Un apagado de emergencia puesto desde el panel (0077). */
export interface PanelKillSwitch {
  readonly providerCode: string;
  readonly level: KillLevel;
  readonly reason: string;
  readonly setBy: string;
  readonly setByEmail: string | null;
  readonly setAt: Date;
  /** `null` = hasta que alguien lo levante. */
  readonly expiresAt: Date | null;
}

/** Lo que guarda la auditoría de un apagado: sin el correo, que ya está en `actor_user_id`. */
interface KillSwitchAuditView {
  readonly level: KillLevel;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly expiresAt: string | null;
}

interface KillSwitchDbRow {
  provider_code: string;
  level: KillLevel;
  reason: string;
  set_by: string;
  set_by_email: string | null;
  set_at: Date | string;
  expires_at: Date | string | null;
}

function fromRow(r: KillSwitchDbRow): PanelKillSwitch {
  return {
    providerCode: r.provider_code,
    level: r.level,
    reason: r.reason,
    setBy: r.set_by,
    setByEmail: r.set_by_email,
    setAt: new Date(r.set_at),
    expiresAt: r.expires_at === null ? null : new Date(r.expires_at),
  };
}

function auditView(k: PanelKillSwitch): KillSwitchAuditView {
  return {
    level: k.level,
    reason: k.reason,
    setBy: k.setBy,
    setAt: k.setAt.toISOString(),
    expiresAt: k.expiresAt === null ? null : k.expiresAt.toISOString(),
  };
}

function isActive(k: PanelKillSwitch, now: number): boolean {
  return k.expiresAt === null || k.expiresAt.getTime() > now;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/**
 * Los apagados de emergencia del panel (`provider_kill_switches`, 0077), en memoria para el circuit
 * breaker, que los consulta en CADA llamada a un proveedor y no puede ir a la base cada vez.
 *
 * Se leen al arrancar y cada {@link KILL_SWITCH_REFRESH_MS}. Una lectura que falla deja la última
 * que salió bien y avisa en el log: un error de la base nunca enciende un proveedor que estaba
 * apagado. Las filas vencidas se descartan al leer y, entre lectura y lectura, al consultar.
 *
 * Una sola instancia (la provee `ProviderEnablementModule`): poner o levantar un apagado actualiza
 * al instante la copia que usa el breaker de esta réplica.
 */
@Injectable()
export class KillSwitchStore implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KillSwitchStore.name);
  private snapshot: ReadonlyMap<string, PanelKillSwitch> = new Map();
  /**
   * Cada lectura y cada escritura local toma un número; sólo se aplica una lectura más nueva que lo
   * que ya está en la copia. Una lectura que empezó antes de un cambio y termina después no lo pisa.
   */
  private sequence = 0;
  private applied = 0;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Optional() private readonly work?: InflightWorkRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Al llegar la señal y no en `onModuleDestroy`: una lectura que empezara durante el drenaje se
    // quedaría sin pool.
    this.work?.onShutdown('provider-kill-switch-timer', () => {
      this.stop();
      return Promise.resolve();
    });
    // Con `await`: la API no atiende antes de saber qué está apagado. Si la base no responde, sigue
    // sin apagados del panel (la variable PROVIDERS_DISABLED vale igual) y reintenta en 10 s.
    await this.refresh();
    if (this.stopped) return;
    // `unref`: un temporizador de mantenimiento no mantiene vivo al proceso durante un apagado.
    this.timer = setInterval(() => this.tick(), KILL_SWITCH_REFRESH_MS).unref();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** El nivel apagado desde el panel para el proveedor, o `undefined` si no hay uno vigente. */
  panelLevel(providerCode: string, now: number = Date.now()): KillLevel | undefined {
    return this.active(providerCode, now)?.level;
  }

  /** El apagado vigente del proveedor, si lo hay. */
  active(providerCode: string, now: number = Date.now()): PanelKillSwitch | undefined {
    const k = this.snapshot.get(providerCode);
    return k !== undefined && isActive(k, now) ? k : undefined;
  }

  /**
   * Relee la tabla. `true` si la lectura quedó aplicada. Nunca lanza: si falla, se queda la copia
   * anterior.
   */
  async refresh(): Promise<boolean> {
    const seq = ++this.sequence;
    let rows: PanelKillSwitch[];
    try {
      rows = await this.read();
    } catch (err) {
      this.logger.warn(
        `no se pudieron releer los apagados de emergencia; se mantiene la última lectura: ${errorName(err)}`,
      );
      return false;
    }
    if (seq < this.applied) return false;
    this.applied = seq;
    this.snapshot = new Map(rows.map((r) => [r.providerCode, r]));
    return true;
  }

  /**
   * Pone (o reemplaza) el apagado del proveedor, con su `domain_event`, en UNA transacción y con el
   * superadmin en el contexto, que es lo que exige la RLS de 0077. Al confirmar, el breaker de esta
   * réplica ya lo aplica.
   */
  async set(
    actorUserId: string,
    providerCode: string,
    input: {
      readonly level: KillLevel;
      readonly reason: string;
      /** `null` = sin vencimiento. */
      readonly expiresInMinutes: number | null;
    },
  ): Promise<PanelKillSwitch> {
    const written = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const before = await this.lockActive(trx, providerCode);
      const expiresAt =
        input.expiresInMinutes === null
          ? sql<Date | null>`NULL::timestamptz`
          : sql<Date>`now() + make_interval(mins => ${input.expiresInMinutes}::int)`;
      const row = await trx
        .insertInto('provider_kill_switches')
        .values({
          provider_code: providerCode,
          level: input.level,
          reason: input.reason,
          set_by: actorUserId,
          set_at: sql<Date>`now()`,
          expires_at: expiresAt,
        })
        .onConflict((oc) =>
          oc.column('provider_code').doUpdateSet({
            level: input.level,
            reason: input.reason,
            set_by: actorUserId,
            set_at: sql<Date>`now()`,
            expires_at: expiresAt,
          }),
        )
        .returning(['provider_code', 'level', 'reason', 'set_by', 'set_at', 'expires_at'])
        .executeTakeFirstOrThrow();
      const email = await trx
        .selectFrom('users')
        .select('email')
        .where('id', '=', actorUserId)
        .executeTakeFirst();
      const after = fromRow({ ...row, set_by_email: email?.email ?? null });

      await this.audit.emitWithin(trx, {
        eventType: KILL_SWITCH_SET_EVENT,
        tenantId: await this.platformTenantId(trx),
        actorUserId,
        aggregateType: 'provider_kill_switch',
        aggregateId: providerCode,
        payload: {
          providerCode,
          level: after.level,
          reason: after.reason,
          expiresAt: after.expiresAt === null ? null : after.expiresAt.toISOString(),
          before: before === undefined ? null : auditView(before),
        },
      });
      return after;
    });

    this.applyLocal((m) => m.set(providerCode, written));
    await this.refresh();
    return written;
  }

  /**
   * Levanta el apagado vigente del proveedor, con su `domain_event`, en UNA transacción. Devuelve el
   * que había, o `undefined` si no había ninguno vigente (no escribe ni audita: el panel puede
   * reenviar el pedido).
   */
  async clear(
    actorUserId: string,
    providerCode: string,
    reason: string | null,
  ): Promise<PanelKillSwitch | undefined> {
    const removed = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const before = await this.lockActive(trx, providerCode);
      if (before === undefined) return undefined;
      const res = await trx
        .deleteFrom('provider_kill_switches')
        .where('provider_code', '=', providerCode)
        .executeTakeFirst();
      // La lectura es abierta y el borrado no: una fila que se ve y no se borra es la RLS de 0077
      // diciendo que quien pide ya no es el superadmin.
      if (Number(res.numDeletedRows) === 0) throw new SuperadminRequiredError();

      await this.audit.emitWithin(trx, {
        eventType: KILL_SWITCH_CLEARED_EVENT,
        tenantId: await this.platformTenantId(trx),
        actorUserId,
        aggregateType: 'provider_kill_switch',
        aggregateId: providerCode,
        payload: { providerCode, reason, before: auditView(before) },
      });
      return before;
    });

    if (removed !== undefined) {
      this.applyLocal((m) => m.delete(providerCode));
      await this.refresh();
    }
    return removed;
  }

  /** La lectura de verdad. Protegida para poder simular una base que falla en los tests. */
  protected async read(): Promise<PanelKillSwitch[]> {
    const rows = await this.db.db
      .selectFrom('provider_kill_switches as k')
      .leftJoin('users as u', 'u.id', 'k.set_by')
      .select([
        'k.provider_code',
        'k.level',
        'k.reason',
        'k.set_by',
        'u.email as set_by_email',
        'k.set_at',
        'k.expires_at',
      ])
      .where((eb) =>
        eb.or([eb('k.expires_at', 'is', null), eb('k.expires_at', '>', sql<Date>`now()`)]),
      )
      .orderBy('k.provider_code')
      .execute();
    return rows.map(fromRow);
  }

  /** El apagado vigente del proveedor, bloqueado hasta el fin de la transacción. */
  private async lockActive(
    trx: Transaction<DB>,
    providerCode: string,
  ): Promise<PanelKillSwitch | undefined> {
    const row = await trx
      .selectFrom('provider_kill_switches as k')
      .leftJoin('users as u', 'u.id', 'k.set_by')
      .select([
        'k.provider_code',
        'k.level',
        'k.reason',
        'k.set_by',
        'u.email as set_by_email',
        'k.set_at',
        'k.expires_at',
        sql<boolean>`(k.expires_at IS NULL OR k.expires_at > now())`.as('active'),
      ])
      .where('k.provider_code', '=', providerCode)
      .forUpdate('k')
      .executeTakeFirst();
    return row === undefined || !row.active ? undefined : fromRow(row);
  }

  /**
   * El tenant de la plataforma, donde queda el evento: el apagado es de toda la plataforma y no del
   * nodo que el superadmin tenga activo en el selector.
   */
  private async platformTenantId(trx: Transaction<DB>): Promise<string | undefined> {
    const row = await trx
      .selectFrom('tenants')
      .select('id')
      .where('tenant_type', '=', 'platform')
      .executeTakeFirst();
    return row?.id;
  }

  private applyLocal(change: (m: Map<string, PanelKillSwitch>) => void): void {
    const next = new Map(this.snapshot);
    change(next);
    this.applied = ++this.sequence;
    this.snapshot = next;
  }

  private tick(): void {
    // Una lectura lenta no se solapa con la siguiente.
    if (this.stopped || this.refreshing) return;
    this.refreshing = true;
    const run = this.refresh().finally(() => {
      this.refreshing = false;
    });
    void (this.work === undefined ? run : this.work.track('provider-kill-switch-refresh', run));
  }

  private stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
