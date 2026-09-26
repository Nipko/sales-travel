import { Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  ProviderPayloadEnvironment,
  ProviderPayloadsTable,
} from '../database/database.types.js';
import type { ProviderPayloadLookup, ProviderPayloadReader } from './provider-payloads.types.js';

/** Una fila de la bóveda, con los cuerpos todavía cifrados. */
export interface StoredProviderPayload {
  readonly providerCode: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly operation: string;
  readonly environment: ProviderPayloadEnvironment;
  readonly ownerTenantId: string;
  readonly providerAccountId: string | null;
  readonly accountRef: string | null;
  readonly tenantId: string | null;
  readonly orderId: string | null;
  readonly sentAt: Date;
  readonly durationMs: number;
  readonly httpStatus: number;
  readonly providerStatusCode: number | null;
  readonly outcome: string;
  readonly keyId: string;
  readonly requestBytes: number | null;
  readonly requestEnc: Buffer | null;
  readonly responseBytes: number | null;
  readonly responseEnc: Buffer | null;
}

export interface NewProviderPayload extends StoredProviderPayload {
  /**
   * El vencimiento lo calcula la base con su reloj, el mismo contra el que mide el CHECK de
   * retención: con el reloj de la app, un desfase de segundos haría fallar una fila de 90 días.
   */
  readonly retentionDays: number;
}

/** Arma los eventos de auditoría de una lectura a partir de lo que encontró. */
export type ProviderPayloadAuditOf = (
  rows: readonly StoredProviderPayload[],
) => readonly AuditEvent[];

/**
 * La persistencia de la bóveda, detrás de una interfaz para que el servicio se pruebe sin base.
 * La implementación real es {@link ProviderPayloadsStore}; la prueba contra Postgres está en
 * `provider-payloads.integration.test.ts`.
 */
export interface ProviderPayloadsRepository {
  insert(row: NewProviderPayload): Promise<void>;
  /**
   * Lee con la RLS del lector y escribe los eventos de `auditOf` en la MISMA transacción: si el
   * rastro no entra, no sale ninguna fila.
   */
  readAudited(
    lookup: ProviderPayloadLookup,
    reader: ProviderPayloadReader,
    auditOf: ProviderPayloadAuditOf,
  ): Promise<StoredProviderPayload[]>;
  /** Borra hasta `limit` filas vencidas y devuelve cuántas. */
  purgeExpiredBatch(limit: number): Promise<number>;
}

export const PROVIDER_PAYLOADS_REPOSITORY = 'PROVIDER_PAYLOADS_REPOSITORY';

/** Tope de filas de una exportación. Una orden normal no llega a veinte llamadas. */
export const PROVIDER_PAYLOADS_MAX_EXPORT_ROWS = 200;

function toStored(row: Selectable<ProviderPayloadsTable>): StoredProviderPayload {
  return {
    providerCode: row.provider_code,
    requestId: row.request_id,
    attempt: row.attempt,
    operation: row.operation,
    environment: row.environment,
    ownerTenantId: row.owner_tenant_id,
    providerAccountId: row.provider_account_id,
    accountRef: row.account_ref,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    sentAt: row.sent_at,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
    providerStatusCode: row.provider_status_code,
    outcome: row.outcome,
    keyId: row.key_id,
    requestBytes: row.request_bytes,
    requestEnc: row.request_enc,
    responseBytes: row.response_bytes,
    responseEnc: row.response_enc,
  };
}

@Injectable()
export class ProviderPayloadsStore implements ProviderPayloadsRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Sin contexto de tenant: la policy de INSERT es permisiva a propósito (0043). */
  async insert(row: NewProviderPayload): Promise<void> {
    await this.db.db
      .insertInto('provider_payloads')
      .values({
        provider_code: row.providerCode,
        request_id: row.requestId,
        attempt: row.attempt,
        operation: row.operation,
        environment: row.environment,
        owner_tenant_id: row.ownerTenantId,
        provider_account_id: row.providerAccountId,
        account_ref: row.accountRef,
        tenant_id: row.tenantId,
        order_id: row.orderId,
        sent_at: row.sentAt,
        duration_ms: row.durationMs,
        http_status: row.httpStatus,
        provider_status_code: row.providerStatusCode,
        outcome: row.outcome,
        key_id: row.keyId,
        request_bytes: row.requestBytes,
        request_enc: row.requestEnc,
        response_bytes: row.responseBytes,
        response_enc: row.responseEnc,
        expires_at: sql<Date>`now() + make_interval(days => ${row.retentionDays}::integer)`,
      })
      .execute();
  }

  async readAudited(
    lookup: ProviderPayloadLookup,
    reader: ProviderPayloadReader,
    auditOf: ProviderPayloadAuditOf,
  ): Promise<StoredProviderPayload[]> {
    // `app.current_user_id` es lo que mira `can_read_provider_payloads`; sin él la policy no deja
    // ver nada, en silencio.
    return this.db.withRequestContext(
      { userId: reader.userId, tenantId: reader.tenantId },
      async (trx) => {
        let query = trx
          .selectFrom('provider_payloads')
          .selectAll()
          // La policy ya lo exige; repetirlo deja el filtro a la vista de quien lea la consulta.
          .where('expires_at', '>', sql<Date>`now()`);
        query =
          lookup.kind === 'request'
            ? query.where('request_id', '=', lookup.requestId)
            : query.where('order_id', '=', lookup.orderId);
        if (lookup.providerCode !== undefined) {
          query = query.where('provider_code', '=', lookup.providerCode);
        }
        const rows = await query
          .orderBy('sent_at')
          .orderBy('request_id')
          .orderBy('attempt')
          .limit(PROVIDER_PAYLOADS_MAX_EXPORT_ROWS)
          .execute();
        const stored = rows.map(toStored);
        for (const event of auditOf(stored)) await this.audit.emitWithin(trx, event);
        return stored;
      },
    );
  }

  async purgeExpiredBatch(limit: number): Promise<number> {
    const { rows } = await sql<{
      purged: number;
    }>`SELECT purge_expired_provider_payloads(${limit}::integer) AS purged`.execute(this.db.db);
    return rows[0]?.purged ?? 0;
  }
}
