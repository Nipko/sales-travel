import type { ProviderPayloadEnvironment, Role } from '../database/database.types.js';

/**
 * Contrato de la bóveda de payloads de proveedor (migración 0043): lo que un ACL le entrega, lo
 * que sale de una exportación y quién puede pedirla. Genérico: ningún tipo nombra a un proveedor.
 */

/**
 * Un intento de llamada a un proveedor, completo, tal como lo ve su ACL. Los cuerpos van en texto
 * y así se cifran: re-serializar un JSON cambiaría los bytes que el proveedor pide ver.
 */
export interface ProviderPayloadWrite {
  readonly providerCode: string;
  /** Id de la llamada que el ACL pone en su log. Los reintentos lo comparten. */
  readonly requestId: string;
  readonly attempt: number;
  readonly operation: string;
  readonly environment: ProviderPayloadEnvironment;
  /** Dueño de la cuenta con que salió la llamada: decide quién puede leer la fila. */
  readonly ownerTenantId: string;
  readonly providerAccountId: string | null;
  /** Huella de la cuenta que el ACL pone en su log. */
  readonly accountRef?: string;
  readonly sentAt: Date;
  readonly durationMs: number;
  /** 0 = no llegó una respuesta completa. */
  readonly httpStatus: number;
  readonly providerStatusCode?: number;
  /** Desenlace clasificado por el ACL, en su vocabulario (`SUCCESS`, `TRANSPORT`…). */
  readonly outcome: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
}

/**
 * Lo que un factory de proveedor necesita de la bóveda. `record` nunca rechaza: un fallo de la
 * bóveda se registra y no puede cambiar el desenlace de la llamada que la alimenta.
 */
export interface ProviderPayloadWriter {
  /** `false` sin clave configurada: el factory ni siquiera conecta la bóveda al ACL. */
  readonly enabled: boolean;
  record(write: ProviderPayloadWrite): Promise<void>;
}

/** Token DI del escritor. Opcional para los factories: sin él, el ACL no guarda cuerpos. */
export const PROVIDER_PAYLOAD_WRITER = 'PROVIDER_PAYLOAD_WRITER';

/**
 * Roles de nodo que leen la bóveda, además de los de plataforma (que `RolesGuard` deja pasar
 * siempre). Es la lista de `can_read_provider_payloads` en 0043, y un test las compara.
 */
export const PROVIDER_PAYLOAD_READER_ROLES = [
  'consolidator_admin',
] as const satisfies readonly Role[];

/** Cómo se busca una exportación. `providerCode` acota cuando dos ACL compartieran un id. */
export type ProviderPayloadLookup =
  | { readonly kind: 'request'; readonly requestId: string; readonly providerCode?: string }
  | { readonly kind: 'order'; readonly orderId: string; readonly providerCode?: string };

/** Quién lee. La base filtra por su usuario (`app.current_user_id`), no por su tenant activo. */
export interface ProviderPayloadReader {
  readonly userId: string;
  /** Tenant activo: sólo para el evento de auditoría de una lectura que no encontró nada. */
  readonly tenantId?: string;
}

/**
 * Pedido de exportar sin redactar lo de `live` (D-TBO-31 A: "salvo que el proveedor pida el dato
 * real"). El ticket queda en el evento de auditoría; quién puede pedirlo lo decide el controlador.
 */
export interface ProviderPayloadReveal {
  readonly supportTicket: string;
}

/** Por qué un cuerpo no sale en una exportación. Ninguno filtra su contenido. */
export type WithheldPayloadReason =
  /** Superaba el tope al guardarse: nunca se cifró. */
  | 'too_large'
  /** No es JSON y era de `live`: no hay claves que redactar, así que no sale. */
  | 'not_json'
  /** Clave desconocida (rotada y retirada), cifrado alterado o sobre de otra fila. */
  | 'undecryptable'
  /** `live` de un proveedor sin redactor registrado: se falla cerrado. */
  | 'no_redactor';

export type ExportedPayloadBody =
  | { readonly kind: 'absent' }
  | { readonly kind: 'json'; readonly value: unknown }
  /** Sólo sin redactar: un cuerpo que no es JSON (una página de error de un proxy) sale tal cual. */
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'withheld'; readonly reason: WithheldPayloadReason; readonly bytes: number };

export interface ProviderPayloadExportEntry {
  readonly providerCode: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly operation: string;
  readonly environment: ProviderPayloadEnvironment;
  readonly accountRef: string | null;
  readonly orderId: string | null;
  /** ISO 8601. */
  readonly sentAt: string;
  readonly durationMs: number;
  readonly httpStatus: number;
  readonly providerStatusCode: number | null;
  readonly outcome: string;
  /** Si los cuerpos de ESTE intento salieron redactados. */
  readonly redacted: boolean;
  readonly request: ExportedPayloadBody;
  readonly response: ExportedPayloadBody;
}

export interface ProviderPayloadExport {
  readonly lookup: ProviderPayloadLookup;
  readonly entries: readonly ProviderPayloadExportEntry[];
}

/** Vocabulario de `domain_events` de la bóveda. Constantes: un nombre mal escrito no falla, desaparece. */
export const PROVIDER_PAYLOAD_EVENTS = {
  /** Toda lectura, encuentre algo o no. Se escribe en la misma transacción que la lectura. */
  exported: 'ProviderPayloadsExported',
  /** La purga borró filas vencidas. */
  purged: 'ProviderPayloadsPurged',
} as const;
