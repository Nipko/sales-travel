import {
  TBO_HOTELS_PROVIDER_CODE,
  type TboOperationName,
  type TboPayloadRecord,
  type TboPayloadVault,
} from '@sales-travel/tbo-hotels';
import type {
  ProviderPayloadWrite,
  ProviderPayloadWriter,
} from '../provider-payloads/provider-payloads.types.js';

/**
 * El puente entre el ACL de TBO (`deps.payloadVault`) y la bóveda genérica de payloads
 * (docs/tbo/01 §11.2; D-TBO-31 A). Decide QUÉ se guarda y traduce el registro de TBO al contrato
 * neutral; la bóveda no sabe nada de TBO.
 */

/**
 * Se guardan siempre: son la reserva y su post-venta. TBO pide sus RQ/RS completos para un `500`
 * (p. 9) y la certificación, todos los JSON; y con un Book incierto son la única evidencia de lo
 * que se mandó.
 */
export const TBO_ALWAYS_VAULTED_OPERATIONS: ReadonlySet<TboOperationName> =
  new Set<TboOperationName>(['prebook', 'book', 'bookingDetail', 'cancel', 'bookingDetailsByDate']);

/**
 * El resto (búsquedas y contenido estático), sólo si falló: una búsqueda que respondió no tiene
 * nada que reportar y su respuesta puede pesar cientos de kilobytes por cada vendedor que busca.
 */
const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['SUCCESS', 'NO_AVAILABILITY']);

export function shouldVaultTboPayload(
  entry: Pick<TboPayloadRecord, 'operation' | 'outcome'>,
): boolean {
  return TBO_ALWAYS_VAULTED_OPERATIONS.has(entry.operation) || !QUIET_OUTCOMES.has(entry.outcome);
}

/** La cuenta de la bóveda de credenciales con que se construyó el cliente. */
export interface TboPayloadVaultAccount {
  readonly accountId: string;
  readonly ownerTenantId: string;
}

export function toProviderPayloadWrite(
  entry: TboPayloadRecord,
  account: TboPayloadVaultAccount,
): ProviderPayloadWrite {
  return {
    providerCode: TBO_HOTELS_PROVIDER_CODE,
    requestId: entry.requestId,
    attempt: entry.attempt,
    operation: entry.operation,
    environment: entry.environment,
    ownerTenantId: account.ownerTenantId,
    providerAccountId: account.accountId,
    accountRef: entry.accountRef,
    sentAt: new Date(entry.sentAt),
    durationMs: entry.durationMs,
    httpStatus: entry.responseStatus,
    ...(entry.tboCode === undefined ? {} : { providerStatusCode: entry.tboCode }),
    outcome: entry.outcome,
    ...(entry.requestBody === undefined ? {} : { requestBody: entry.requestBody }),
    ...(entry.responseBody === undefined ? {} : { responseBody: entry.responseBody }),
  };
}

/** Uno por cliente (por cuenta): la cuenta viaja fija, la orden la pone el contexto de la llamada. */
export function tboPayloadVault(
  writer: ProviderPayloadWriter,
  account: TboPayloadVaultAccount,
): TboPayloadVault {
  return {
    record: (entry) =>
      shouldVaultTboPayload(entry)
        ? writer.record(toProviderPayloadWrite(entry, account))
        : undefined,
  };
}
