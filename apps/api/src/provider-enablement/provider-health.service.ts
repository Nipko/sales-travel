import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { HOTEL_EVENTS } from '../hotels/hotel-events.js';
import type { ProviderVertical, RegisteredProvider } from '../providers/provider.types.js';
import {
  CircuitBreakerService,
  killLevel,
  type AdminCircuitView,
} from '../search/circuit-breaker.service.js';
import { KillSwitchStore } from './kill-switch.store.js';
import {
  killSwitchDetailOf,
  ProviderEnablementService,
  type KillSwitchDetail,
} from './provider-enablement.service.js';
import type { SetKillSwitchDto } from './provider-enablement.schemas.js';

/** El `domain_event` de cerrar un circuito desde el panel. */
export const PROVIDER_CIRCUIT_RESET_EVENT = 'platform.provider_circuit.reset';

/** La ventana de los avisos de cuenta que cuenta el panel. */
const ACCOUNT_ISSUES_WINDOW_MS = 24 * 60 * 60 * 1000;

/** El circuito de un proveedor en el panel. Fechas en ISO 8601; `null` si no aplica. */
export interface ProviderCircuitView {
  readonly state: AdminCircuitView['state'];
  readonly failures: number;
  readonly openedAt: string | null;
  readonly lastFailureAt: string | null;
}

/** Un proveedor en "¿está respondiendo?" del panel. */
export interface ProviderHealthView {
  readonly code: string;
  readonly vertical: ProviderVertical;
  readonly circuit: ProviderCircuitView;
  /** Cuántas cuentas del proveedor están en pausa por una credencial rechazada. Nunca cuáles. */
  readonly suspendedAccounts: number;
  readonly killSwitch: KillSwitchDetail;
  /**
   * Avisos de cuenta (`ProviderAccountIssueDetected`: sin saldo, bloqueada) de las últimas 24 h, en
   * toda la red. `null` si no se pudieron leer: el resto de la vista sale igual.
   */
  readonly accountIssues24h: number | null;
}

/**
 * Levantar el apagado de un proveedor que sólo está apagado por la variable: eso no se quita desde
 * el panel, se quita desplegando. 409 con su motivo, para que el panel lo diga tal cual.
 */
export class KillSwitchFromEnvError extends ConflictException {
  readonly reason = 'KILL_SWITCH_FROM_ENV';

  constructor() {
    super('Este apagado viene de la variable PROVIDERS_DISABLED: se quita desplegando.');
    this.name = 'KillSwitchFromEnvError';
  }
}

const CLOSED: AdminCircuitView = {
  state: 'closed',
  failures: 0,
  openedAt: null,
  lastFailureAt: null,
  suspendedAccounts: 0,
};

function circuitView(c: AdminCircuitView): ProviderCircuitView {
  return {
    state: c.state,
    failures: c.failures,
    openedAt: c.openedAt === null ? null : c.openedAt.toISOString(),
    lastFailureAt: c.lastFailureAt === null ? null : c.lastFailureAt.toISOString(),
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

/**
 * La salud de cada proveedor y las palancas de un incidente, para el superadmin: ¿está respondiendo
 * (circuito, cuentas en pausa, avisos de cuenta)?, el apagado de emergencia desde el panel y cerrar
 * a mano un circuito abierto.
 *
 * El circuito y las cuentas en pausa son los de ESTA réplica (el breaker vive en memoria; hoy hay un
 * solo contenedor de API). La AUTORIZACIÓN (sólo superadmin) la valida el controlador; la base la
 * vuelve a exigir al escribir el apagado (RLS de 0077).
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly enablement: ProviderEnablementService,
    private readonly breaker: CircuitBreakerService,
    private readonly killSwitches: KillSwitchStore,
    private readonly audit: AuditService,
  ) {}

  /** Todos los proveedores de los registries, con su salud. */
  async health(actorUserId: string, now: Date = new Date()): Promise<ProviderHealthView[]> {
    const issues = await this.accountIssues(actorUserId, now);
    const circuits = this.breaker.adminSnapshot(now.getTime());
    return this.enablement
      .registered()
      .map((p) =>
        this.view(p, circuits[p.code], issues === null ? null : (issues.get(p.code) ?? 0)),
      );
  }

  /** Apaga el proveedor para toda la plataforma. 404 si no está registrado. */
  async setKillSwitch(
    actorUserId: string,
    providerCode: string,
    dto: SetKillSwitchDto,
  ): Promise<ProviderHealthView> {
    this.enablement.provider(providerCode);
    await this.killSwitches.set(actorUserId, providerCode, {
      level: dto.level,
      reason: dto.reason,
      expiresInMinutes: dto.expiresInMinutes,
    });
    return this.viewOf(actorUserId, providerCode);
  }

  /**
   * Levanta el apagado del panel. Si no hay ninguno vigente y la variable lo apaga, 409: eso se
   * quita desplegando. Si no hay ninguno de los dos, no hace nada (el panel puede reenviar).
   */
  async clearKillSwitch(
    actorUserId: string,
    providerCode: string,
    reason: string | null,
  ): Promise<ProviderHealthView> {
    this.enablement.provider(providerCode);
    const removed = await this.killSwitches.clear(actorUserId, providerCode, reason);
    if (removed === undefined && killLevel(providerCode) !== undefined) {
      throw new KillSwitchFromEnvError();
    }
    return this.viewOf(actorUserId, providerCode);
  }

  /**
   * Cierra el circuito del proveedor en esta réplica: vuelve a recibir llamadas de inmediato y, si
   * sigue fallando, el circuito se abre otra vez. Primero la auditoría y después el cierre: un
   * cierre sin rastro no ocurre. Con el circuito ya cerrado y sin fallos, no hace nada.
   */
  async resetCircuit(
    actorUserId: string,
    providerCode: string,
    reason: string,
  ): Promise<ProviderHealthView> {
    this.enablement.provider(providerCode);
    const before = this.breaker.adminSnapshot()[providerCode];
    if (before !== undefined && (before.state !== 'closed' || before.failures > 0)) {
      await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
        const platform = await trx
          .selectFrom('tenants')
          .select('id')
          .where('tenant_type', '=', 'platform')
          .executeTakeFirst();
        await this.audit.emitWithin(trx, {
          eventType: PROVIDER_CIRCUIT_RESET_EVENT,
          tenantId: platform?.id,
          actorUserId,
          aggregateType: 'provider_circuit',
          aggregateId: providerCode,
          payload: {
            providerCode,
            reason,
            before: { ...circuitView(before), suspendedAccounts: before.suspendedAccounts },
          },
        });
      });
      this.breaker.reset(providerCode);
    }
    return this.viewOf(actorUserId, providerCode);
  }

  private async viewOf(actorUserId: string, providerCode: string): Promise<ProviderHealthView> {
    const view = (await this.health(actorUserId)).find((p) => p.code === providerCode);
    if (view === undefined)
      throw new Error(`el proveedor ${providerCode} dejó de estar registrado`);
    return view;
  }

  private view(
    provider: RegisteredProvider,
    circuit: AdminCircuitView | undefined,
    accountIssues24h: number | null,
  ): ProviderHealthView {
    const c = circuit ?? CLOSED;
    return {
      code: provider.code,
      vertical: provider.vertical,
      circuit: circuitView(c),
      suspendedAccounts: c.suspendedAccounts,
      killSwitch: killSwitchDetailOf(provider.code, this.killSwitches),
      accountIssues24h,
    };
  }

  /**
   * `ProviderAccountIssueDetected` de las últimas 24 h por proveedor, con la RLS del superadmin
   * (`domain_events_subtree_read`, 0029: el superadmin lee toda la red). Si la lectura falla, `null`
   * y un aviso en el log: la salud del breaker se muestra igual.
   */
  private async accountIssues(
    actorUserId: string,
    now: Date,
  ): Promise<ReadonlyMap<string, number> | null> {
    const since = new Date(now.getTime() - ACCOUNT_ISSUES_WINDOW_MS);
    try {
      const rows = await this.db.withRequestContext({ userId: actorUserId }, (trx) =>
        trx
          .selectFrom('domain_events')
          .select([
            sql<string | null>`payload->>'provider'`.as('provider'),
            sql<string>`count(*)`.as('n'),
          ])
          .where('event_type', '=', HOTEL_EVENTS.providerAccountIssue)
          .where(sql<boolean>`occurred_at >= ${since}`)
          .groupBy(sql`payload->>'provider'`)
          .execute(),
      );
      return new Map(
        rows.flatMap((r) => (r.provider === null ? [] : [[r.provider, Number(r.n)] as const])),
      );
    } catch (err) {
      this.logger.warn(`no se pudieron contar los avisos de cuenta: ${errorName(err)}`);
      return null;
    }
  }
}
