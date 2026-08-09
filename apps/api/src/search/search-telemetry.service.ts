import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { currentContext } from '../request-context/request-context.js';

export type SearchVertical = 'flights' | 'hotels' | 'cars';
export type SearchOutcome = 'ok' | 'empty' | 'error' | 'simulated';

/** Cuota por defecto cuando el tenant no define una propia. */
const DEFAULT_QUOTA_PER_HOUR = 600;
const QUOTA_WINDOW_MINUTES = 60;

export interface SearchRecord {
  tenantId: string;
  vertical: SearchVertical;
  providerCode: string;
  durationMs: number;
  resultCount: number;
  outcome: SearchOutcome;
  errorCode?: string;
  /** Criterio REDUCIDO. Nunca datos de pasajero ni del cliente final. */
  criteria?: Record<string, unknown>;
}

/**
 * Telemetría y cuota de búsquedas.
 *
 * Antes no existía ninguna medición: no se podía saber cuánto tarda cada proveedor, qué
 * porcentaje falla ni cuánto busca cada agencia. Y el rate limit era sólo por IP, con lo
 * que una agencia entera —que sale por la IP de su oficina— o se throttleaba junta o no
 * se throttleaba nunca, mientras consumía cuota contra proveedores que cobran por consulta.
 */
@Injectable()
export class SearchTelemetryService {
  private readonly logger = new Logger(SearchTelemetryService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Verifica la cuota horaria del tenant ANTES de salir al proveedor.
   * Lanza 403 si se excedió; nunca bloquea por un fallo de la propia medición.
   */
  async assertWithinQuota(tenantId: string): Promise<void> {
    try {
      const tenant = await this.db.db
        .selectFrom('tenants')
        .select('search_quota_per_hour')
        .where('id', '=', tenantId)
        .executeTakeFirst();

      const quota = tenant?.search_quota_per_hour ?? DEFAULT_QUOTA_PER_HOUR;
      if (quota <= 0) return; // 0 o negativo = sin tope

      const res = await sql<{ count_recent_searches: number }>`
        SELECT count_recent_searches(${tenantId}::uuid, ${QUOTA_WINDOW_MINUTES})
      `.execute(this.db.db);

      const used = res.rows[0]?.count_recent_searches ?? 0;
      if (used >= quota) {
        throw new ForbiddenException(
          `Se alcanzó el límite de ${quota} búsquedas por hora de esta agencia. Volvé a intentar más tarde.`,
        );
      }
    } catch (err) {
      // Un fallo midiendo la cuota no puede impedir vender: sólo se propaga el 403.
      if (err instanceof ForbiddenException) throw err;
      this.logger.warn(`no se pudo verificar la cuota del tenant ${tenantId}`);
    }
  }

  /** Registra la búsqueda. Best-effort: la telemetría nunca rompe la operación. */
  async record(rec: SearchRecord): Promise<void> {
    try {
      await this.db.db
        .insertInto('search_logs')
        .values({
          tenant_id: rec.tenantId,
          actor_user_id: currentContext()?.userId ?? null,
          vertical: rec.vertical,
          provider_code: rec.providerCode,
          duration_ms: Math.max(0, Math.round(rec.durationMs)),
          result_count: rec.resultCount,
          outcome: rec.outcome,
          error_code: rec.errorCode ?? null,
          criteria: JSON.stringify(rec.criteria ?? {}),
        })
        .execute();
    } catch {
      this.logger.warn(`no se pudo registrar la búsqueda (${rec.vertical}/${rec.providerCode})`);
    }
  }

  /**
   * Envuelve una búsqueda: mide, clasifica el resultado y lo registra pase lo que pase.
   * Devuelve lo que devuelva `run`, o propaga su error tras dejarlo asentado.
   */
  async instrument<T>(
    meta: {
      tenantId: string;
      vertical: SearchVertical;
      providerCode: string;
      criteria?: Record<string, unknown>;
    },
    run: () => Promise<T>,
    countOf: (result: T) => number,
    simulatedOf?: (result: T) => boolean,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      const count = countOf(result);
      const simulated = simulatedOf?.(result) ?? false;
      await this.record({
        ...meta,
        durationMs: Date.now() - startedAt,
        resultCount: count,
        // El modo mock se marca aparte: contarlo como éxito falsearía la tasa real.
        outcome: simulated ? 'simulated' : count > 0 ? 'ok' : 'empty',
      });
      return result;
    } catch (err) {
      await this.record({
        ...meta,
        durationMs: Date.now() - startedAt,
        resultCount: 0,
        outcome: 'error',
        errorCode: (err as { name?: string }).name ?? 'Error',
      });
      throw err;
    }
  }
}
