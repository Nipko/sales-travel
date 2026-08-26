import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { currentContext } from '../request-context/request-context.js';

export type SearchVertical = 'flights' | 'hotels' | 'cars';
export type SearchOutcome = 'ok' | 'empty' | 'error' | 'simulated';

/** Cuota por defecto cuando el tenant no define una propia. */
const DEFAULT_QUOTA_PER_HOUR = 600;
const QUOTA_WINDOW_MINUTES = 60;

/**
 * Código con el que se deja constancia de una búsqueda que no llegó a consultar a nadie
 * (el tenant no tiene ningún proveedor activo). Sin fila, esa búsqueda no contaría para la
 * cuota y un tenant mal configurado podría machacar el endpoint sin tope.
 */
const NO_PROVIDER_CODE = 'none';

/**
 * Lo que hizo UN proveedor dentro de una búsqueda. Cada una es una fila de `search_logs`.
 *
 * La latencia y el resultado van por proveedor porque es la única forma de responder las dos
 * preguntas operativas del fan-out: cuánto tarda cada uno y cuál está degradado. Agregarlas
 * en una sola fila con los códigos concatenados las hace incontestables.
 */
export interface ProviderSearchSlice {
  providerCode: string;
  durationMs: number;
  resultCount: number;
  outcome: SearchOutcome;
  errorCode?: string;
}

export interface SearchRecord {
  tenantId: string;
  vertical: SearchVertical;
  /**
   * Una entrada por proveedor consultado. Todas se escriben con el MISMO `search_group_id`,
   * así que `count_recent_searches` las cuenta como una búsqueda: la telemetría se parte por
   * proveedor sin que la cuota del tenant se divida entre N.
   */
  providers: readonly ProviderSearchSlice[];
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

  /**
   * Registra la búsqueda: UNA FILA POR PROVEEDOR, todas del mismo grupo.
   *
   * Best-effort: la telemetría nunca rompe la operación.
   */
  async record(rec: SearchRecord): Promise<void> {
    const slices: readonly ProviderSearchSlice[] =
      rec.providers.length > 0
        ? rec.providers
        : [{ providerCode: NO_PROVIDER_CODE, durationMs: 0, resultCount: 0, outcome: 'empty' }];

    // El grupo se genera acá y no en la BD: las N filas van en un solo INSERT y todas tienen
    // que llevar EL MISMO valor, cosa que un DEFAULT por fila no garantizaría.
    const searchGroupId = randomUUID();
    const actorUserId = currentContext()?.userId ?? null;
    const criteria = JSON.stringify(rec.criteria ?? {});

    try {
      await this.db.db
        .insertInto('search_logs')
        .values(
          slices.map((slice) => ({
            tenant_id: rec.tenantId,
            search_group_id: searchGroupId,
            actor_user_id: actorUserId,
            vertical: rec.vertical,
            provider_code: slice.providerCode,
            duration_ms: Math.max(0, Math.round(slice.durationMs)),
            result_count: slice.resultCount,
            outcome: slice.outcome,
            error_code: slice.errorCode ?? null,
            criteria,
          })),
        )
        .execute();
    } catch {
      this.logger.warn(
        `no se pudo registrar la búsqueda (${rec.vertical}, ${slices.length} proveedor/es)`,
      );
    }
  }

  /**
   * Envuelve una búsqueda: mide, clasifica el resultado y lo registra pase lo que pase.
   * Devuelve lo que devuelva `run`, o propaga su error tras dejarlo asentado.
   *
   * `breakdownOf` es lo que hace real la telemetría por proveedor: el llamador que consulta
   * a varios sabe qué hizo cada uno y lo devuelve desglosado. Sin él, la búsqueda se atribuye
   * por igual a todos los códigos declarados, que sólo es fiel cuando hay UNO.
   */
  async instrument<T>(
    meta: {
      tenantId: string;
      vertical: SearchVertical;
      /**
       * Proveedores que se van a consultar. Define las filas cuando `run` explota y no hay
       * resultado del que sacar el desglose.
       */
      providerCodes: readonly string[];
      criteria?: Record<string, unknown>;
    },
    run: () => Promise<T>,
    countOf: (result: T) => number,
    simulatedOf?: (result: T) => boolean,
    breakdownOf?: (result: T) => readonly ProviderSearchSlice[],
  ): Promise<T> {
    const { providerCodes, ...base } = meta;
    const startedAt = Date.now();
    try {
      const result = await run();
      const durationMs = Date.now() - startedAt;
      const desglose = breakdownOf?.(result) ?? [];
      await this.record({
        ...base,
        providers:
          desglose.length > 0
            ? desglose
            : uniformSlices(providerCodes, durationMs, countOf(result), simulatedOf?.(result)),
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorCode = (err as { name?: string }).name ?? 'Error';
      await this.record({
        ...base,
        providers: providerCodes.map((providerCode) => ({
          providerCode,
          durationMs,
          resultCount: 0,
          outcome: 'error' as const,
          errorCode,
        })),
      });
      throw err;
    }
  }
}

/** Atribuye la búsqueda entera a cada código declarado. Sólo es fiel con UN proveedor. */
function uniformSlices(
  providerCodes: readonly string[],
  durationMs: number,
  resultCount: number,
  simulated = false,
): ProviderSearchSlice[] {
  // El modo mock se marca aparte: contarlo como éxito falsearía la tasa real.
  const outcome: SearchOutcome = simulated ? 'simulated' : resultCount > 0 ? 'ok' : 'empty';
  return providerCodes.map((providerCode) => ({
    providerCode,
    durationMs,
    resultCount,
    outcome,
  }));
}
