import type { AuditEvent } from '../../audit/audit.service.js';
import type {
  NewProviderPayload,
  ProviderPayloadAuditOf,
  ProviderPayloadsRepository,
  StoredProviderPayload,
} from '../provider-payloads.store.js';
import type { ProviderPayloadLookup, ProviderPayloadReader } from '../provider-payloads.types.js';

/**
 * La bóveda en memoria, para probar el servicio sin Postgres. Imita lo que el servicio da por
 * supuesto de la base: la lectura y su evento de auditoría van juntos (si el evento falla, no sale
 * ninguna fila). La RLS y la purga reales se prueban en `provider-payloads.integration.test.ts`.
 */
export class InMemoryProviderPayloadsRepository implements ProviderPayloadsRepository {
  readonly rows: NewProviderPayload[] = [];
  readonly audits: AuditEvent[] = [];
  readonly readers: ProviderPayloadReader[] = [];
  readonly purgeLimits: number[] = [];
  /** Lo que devuelve cada lote de la purga, en orden; vacío = 0. */
  readonly purgeResults: number[] = [];
  insertError: Error | undefined = undefined;
  auditError: Error | undefined = undefined;

  insert(row: NewProviderPayload): Promise<void> {
    if (this.insertError !== undefined) return Promise.reject(this.insertError);
    this.rows.push(row);
    return Promise.resolve();
  }

  readAudited(
    lookup: ProviderPayloadLookup,
    reader: ProviderPayloadReader,
    auditOf: ProviderPayloadAuditOf,
  ): Promise<StoredProviderPayload[]> {
    const found = this.rows
      .filter((row) =>
        lookup.kind === 'request'
          ? row.requestId === lookup.requestId
          : row.orderId === lookup.orderId,
      )
      .filter(
        (row) => lookup.providerCode === undefined || row.providerCode === lookup.providerCode,
      )
      .map((row): StoredProviderPayload => {
        const { retentionDays: _retention, ...stored } = row;
        return stored;
      });
    const events = auditOf(found);
    if (this.auditError !== undefined) return Promise.reject(this.auditError);
    this.audits.push(...events);
    this.readers.push(reader);
    return Promise.resolve(found);
  }

  purgeExpiredBatch(limit: number): Promise<number> {
    this.purgeLimits.push(limit);
    return Promise.resolve(this.purgeResults.shift() ?? 0);
  }
}
