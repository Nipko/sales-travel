import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { z, type ZodError } from 'zod';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { PROVIDER_PAYLOAD_ENVIRONMENTS } from '../database/database.types.js';
import { currentTenantId } from '../request-context/request-context.js';
import { sealPayload, type PayloadKey, type PayloadPart } from './provider-payload-crypto.js';
import {
  redactorFor,
  renderPayloadBody,
  type PayloadRenderMode,
} from './provider-payload-redaction.js';
import { currentProviderPayloadScope } from './provider-payload-scope.js';
import {
  PROVIDER_PAYLOADS_CONFIG,
  type ProviderPayloadsConfig,
} from './provider-payloads.config.js';
import {
  PROVIDER_PAYLOADS_REPOSITORY,
  type ProviderPayloadAuditOf,
  type ProviderPayloadsRepository,
  type StoredProviderPayload,
} from './provider-payloads.store.js';
import {
  PROVIDER_PAYLOAD_EVENTS,
  type ProviderPayloadExport,
  type ProviderPayloadExportEntry,
  type ProviderPayloadLookup,
  type ProviderPayloadReader,
  type ProviderPayloadReveal,
  type ProviderPayloadWrite,
  type ProviderPayloadWriter,
} from './provider-payloads.types.js';

/**
 * Tope de un cuerpo guardado. Los RQ/RS de una reserva pesan kilobytes; lo que pasa de esto es una
 * búsqueda o un listado estático, que el ACL de todos modos no manda a la bóveda salvo que falle,
 * y un error no pesa megas. Guardar el tamaño sin el cuerpo deja constancia de que existió.
 */
export const PROVIDER_PAYLOAD_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Lote de la purga: corto para no sostener locks, y hasta 100 por corrida. */
export const PROVIDER_PAYLOADS_PURGE_BATCH = 1_000;
export const PROVIDER_PAYLOADS_PURGE_MAX_BATCHES = 100;

const PROVIDER_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_REF = /^[A-Za-z0-9._:-]{1,64}$/;
const INT32_MAX = 2_147_483_647;

/** Los mismos formatos que los CHECK de 0043: una fila que la base rechazaría no llega a salir. */
const WriteSchema = z.object({
  providerCode: z.string().regex(PROVIDER_CODE),
  requestId: z.string().regex(REQUEST_ID),
  attempt: z.number().int().min(1).max(20),
  operation: z.string().regex(TOKEN),
  environment: z.enum(PROVIDER_PAYLOAD_ENVIRONMENTS),
  // En minúsculas, como lo devuelve Postgres: el sobre cifrado lo compara con la columna leída.
  ownerTenantId: z
    .string()
    .uuid()
    .transform((id) => id.toLowerCase()),
  providerAccountId: z.string().uuid().nullable(),
  accountRef: z.string().regex(ACCOUNT_REF).optional(),
  sentAt: z.date(),
  // Sin `.min(0)`: un reloj que retrocede durante la llamada (un salto de NTP) daría una duración
  // negativa, y rechazarla perdería la única evidencia de un Book incierto.
  durationMs: z
    .number()
    .finite()
    .max(INT32_MAX)
    .transform((ms) => Math.max(0, Math.round(ms))),
  httpStatus: z.number().int().min(0).max(599),
  providerStatusCode: z.number().int().min(-INT32_MAX).max(INT32_MAX).optional(),
  outcome: z.string().regex(TOKEN),
  requestBody: z.string().optional(),
  responseBody: z.string().optional(),
});

type ValidWrite = z.infer<typeof WriteSchema>;

const Uuid = z.string().uuid();

const SupportTicketSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._#/-]{2,63}$/, 'referencia de ticket inválida');

const ExportOptionsSchema = z.object({
  providerCode: z.string().regex(PROVIDER_CODE, 'código de proveedor inválido').optional(),
  reveal: z.object({ supportTicket: SupportTicketSchema }).optional(),
});

export interface ProviderPayloadExportOptions {
  readonly providerCode?: string;
  readonly reveal?: ProviderPayloadReveal;
}

/** Un pedido de exportación mal formado. Dice qué campo, nunca repite el valor. */
export class ProviderPayloadExportInputError extends BadRequestException {
  constructor(readonly fields: readonly string[]) {
    super(`Pedido de exportación inválido: ${fields.join(', ')}.`);
    this.name = 'ProviderPayloadExportInputError';
  }
}

/** `ruta:código`. Nunca `message`: el de un enum inválido repite el valor recibido. */
function issueRefs(error: ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
}

/**
 * Qué se puede decir de un fallo al guardar: el SQLSTATE o la clase. El `message` de Postgres puede
 * citar valores de la fila, y `detail` los cita siempre.
 */
function errorRef(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `sqlstate ${code}`;
  return err instanceof Error ? err.constructor.name : 'desconocido';
}

function uuidOrNull(value: string | undefined): string | null {
  return value !== undefined && Uuid.safeParse(value).success ? value : null;
}

interface SealedBody {
  readonly bytes: number | null;
  readonly sealed: Buffer | null;
}

function sealBody(
  body: string | undefined,
  write: ValidWrite,
  part: PayloadPart,
  key: PayloadKey,
): SealedBody {
  if (body === undefined) return { bytes: null, sealed: null };
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > PROVIDER_PAYLOAD_MAX_BODY_BYTES) return { bytes, sealed: null };
  const binding = {
    providerCode: write.providerCode,
    requestId: write.requestId,
    attempt: write.attempt,
    part,
    ownerTenantId: write.ownerTenantId,
    environment: write.environment,
  };
  return { bytes, sealed: sealPayload(body, binding, key) };
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * La bóveda de payloads de proveedor (D-TBO-31 A; docs/tbo/01 §11.2; 08 RNF-05 punto 3).
 *
 * - **Escribe** lo que le entrega el ACL de un proveedor, cifrado, con la orden y el tenant del
 *   contexto en que corrió la llamada. Nunca rechaza ni lanza hacia el ACL.
 * - **Exporta** por id de llamada o por orden: tal cual lo de `test`, redactado lo de `live` salvo
 *   pedido con ticket. Toda lectura deja su evento en `domain_events` en la misma transacción.
 * - **Purga** lo vencido.
 *
 * Lo que nunca hace es escribir un cuerpo en el log: las líneas de este servicio llevan ids,
 * nombres de operación, tamaños y códigos de error, y nada más.
 */
@Injectable()
export class ProviderPayloadsService implements ProviderPayloadWriter {
  private readonly logger = new Logger('ProviderPayloads');

  constructor(
    @Inject(PROVIDER_PAYLOADS_REPOSITORY) private readonly repo: ProviderPayloadsRepository,
    @Inject(PROVIDER_PAYLOADS_CONFIG) private readonly config: ProviderPayloadsConfig,
    private readonly audit: AuditService,
  ) {
    if (config.keyring === undefined) {
      this.logger.warn(
        `bóveda de payloads de proveedor apagada (${config.disabledReason ?? 'sin clave'}): los ACL no guardan RQ/RS`,
      );
    }
  }

  get enabled(): boolean {
    return this.config.keyring !== undefined;
  }

  async record(write: ProviderPayloadWrite): Promise<void> {
    const keyring = this.config.keyring;
    if (keyring === undefined) return;
    const scope = currentProviderPayloadScope();

    const parsed = WriteSchema.safeParse(write);
    if (!parsed.success) {
      this.logger.warn(`payload de proveedor no guardado: [${issueRefs(parsed.error)}]`);
      return;
    }
    const w = parsed.data;
    const where = `${w.providerCode}/${w.operation} ${w.requestId}#${w.attempt}`;
    try {
      const request = sealBody(w.requestBody, w, 'request', keyring.current);
      const response = sealBody(w.responseBody, w, 'response', keyring.current);
      await this.repo.insert({
        providerCode: w.providerCode,
        requestId: w.requestId,
        attempt: w.attempt,
        operation: w.operation,
        environment: w.environment,
        ownerTenantId: w.ownerTenantId,
        providerAccountId: w.providerAccountId,
        accountRef: w.accountRef ?? null,
        tenantId: uuidOrNull(scope?.tenantId ?? currentTenantId()),
        orderId: uuidOrNull(scope?.orderId),
        sentAt: w.sentAt,
        durationMs: w.durationMs,
        httpStatus: w.httpStatus,
        providerStatusCode: w.providerStatusCode ?? null,
        outcome: w.outcome,
        keyId: keyring.current.id,
        requestBytes: request.bytes,
        requestEnc: request.sealed,
        responseBytes: response.bytes,
        responseEnc: response.sealed,
        retentionDays: this.config.retentionDays,
      });
      if (request.bytes !== null && request.sealed === null) {
        this.logger.warn(
          `payload ${where}: request de ${request.bytes} bytes, guardado sin cuerpo`,
        );
      }
      if (response.bytes !== null && response.sealed === null) {
        this.logger.warn(
          `payload ${where}: response de ${response.bytes} bytes, guardada sin cuerpo`,
        );
      }
    } catch (err) {
      this.logger.warn(`payload ${where} no guardado (${errorRef(err)})`);
    }
  }

  async exportByRequestId(
    requestId: string,
    reader: ProviderPayloadReader,
    options: ProviderPayloadExportOptions = {},
  ): Promise<ProviderPayloadExport> {
    if (!REQUEST_ID.test(requestId)) throw new ProviderPayloadExportInputError(['requestId']);
    return this.export({ kind: 'request', requestId }, reader, options);
  }

  async exportByOrderId(
    orderId: string,
    reader: ProviderPayloadReader,
    options: ProviderPayloadExportOptions = {},
  ): Promise<ProviderPayloadExport> {
    if (!Uuid.safeParse(orderId).success) throw new ProviderPayloadExportInputError(['orderId']);
    return this.export({ kind: 'order', orderId }, reader, options);
  }

  /**
   * Borra lo vencido por lotes. Lo vencido ya no se lee (la policy lo oculta): esto es para que
   * además deje de existir. Idempotente: dos réplicas corriéndola a la vez no se estorban.
   */
  async purgeExpired(): Promise<number> {
    let total = 0;
    let exhausted = false;
    for (let batch = 0; batch < PROVIDER_PAYLOADS_PURGE_MAX_BATCHES; batch++) {
      const purged = await this.repo.purgeExpiredBatch(PROVIDER_PAYLOADS_PURGE_BATCH);
      total += purged;
      if (purged < PROVIDER_PAYLOADS_PURGE_BATCH) {
        exhausted = true;
        break;
      }
    }
    if (total > 0) {
      this.logger.log(
        `purga de la bóveda de payloads: ${total} fila(s) vencida(s) borradas${exhausted ? '' : '; quedan más para la próxima corrida'}`,
      );
      await this.audit.emit({
        eventType: PROVIDER_PAYLOAD_EVENTS.purged,
        tenantId: null,
        actorUserId: null,
        aggregateType: 'provider_payload',
        payload: { purged: total, complete: exhausted },
      });
    }
    return total;
  }

  private async export(
    base: ProviderPayloadLookup,
    reader: ProviderPayloadReader,
    options: ProviderPayloadExportOptions,
  ): Promise<ProviderPayloadExport> {
    const parsed = ExportOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ProviderPayloadExportInputError(
        distinct(parsed.error.issues.map((issue) => issue.path.join('.') || '<root>')),
      );
    }
    const { providerCode, reveal } = parsed.data;
    const lookup: ProviderPayloadLookup =
      providerCode === undefined ? base : { ...base, providerCode };

    const rows = await this.repo.readAudited(lookup, reader, this.auditOf(lookup, reader, reveal));
    const keys = this.config.keyring?.byId ?? new Map<string, Buffer>();
    const entries = rows.map((row) => this.toEntry(row, reveal, keys));

    const redacted = entries.filter((e) => e.redacted).length;
    this.logger.log(
      `exportación de payloads por ${lookup.kind === 'request' ? `llamada ${lookup.requestId}` : `orden ${lookup.orderId}`}: ${entries.length} intento(s), ${redacted} redactado(s)${reveal === undefined ? '' : ', con ticket'}`,
    );
    return { lookup, entries };
  }

  /**
   * Un evento por dueño de cuenta: el rastro queda donde lo ve quien administra la cuenta. Una
   * lectura que no encontró nada también se registra, con el tenant activo del lector.
   */
  private auditOf(
    lookup: ProviderPayloadLookup,
    reader: ProviderPayloadReader,
    reveal: ProviderPayloadReveal | undefined,
  ): ProviderPayloadAuditOf {
    const aggregateId = lookup.kind === 'request' ? lookup.requestId : lookup.orderId;
    const common: Record<string, unknown> = {
      lookup: lookup.kind,
      ...(lookup.kind === 'request'
        ? { requestId: lookup.requestId }
        : { orderId: lookup.orderId }),
      ...(lookup.providerCode === undefined ? {} : { providerCode: lookup.providerCode }),
      ...(reveal === undefined ? {} : { supportTicket: reveal.supportTicket }),
    };
    const event = (tenantId: string | null, payload: Record<string, unknown>): AuditEvent => ({
      eventType: PROVIDER_PAYLOAD_EVENTS.exported,
      tenantId,
      actorUserId: reader.userId,
      aggregateType: 'provider_payload',
      aggregateId,
      payload: { ...common, ...payload },
    });

    return (rows: readonly StoredProviderPayload[]) => {
      if (rows.length === 0)
        return [event(reader.tenantId ?? null, { records: 0, revealed: false })];
      const byOwner = new Map<string, StoredProviderPayload[]>();
      for (const row of rows)
        byOwner.set(row.ownerTenantId, [...(byOwner.get(row.ownerTenantId) ?? []), row]);
      return [...byOwner].map(([owner, owned]) =>
        event(owner, {
          records: owned.length,
          providers: distinct(owned.map((r) => r.providerCode)),
          environments: distinct(owned.map((r) => r.environment)),
          revealed: reveal !== undefined && owned.some((r) => r.environment === 'live'),
        }),
      );
    };
  }

  private toEntry(
    row: StoredProviderPayload,
    reveal: ProviderPayloadReveal | undefined,
    keys: ReadonlyMap<string, Buffer>,
  ): ProviderPayloadExportEntry {
    // `test` sale tal cual: los datos son sintéticos y el proveedor necesita ver los nombres
    // (D-TBO-31 A). `live`, redactado, salvo que el proveedor haya pedido el dato real.
    const redact = row.environment === 'live' && reveal === undefined;
    const mode: PayloadRenderMode = redact
      ? { redact: true, redactor: redactorFor(row.providerCode) }
      : { redact: false };
    const bindingOf = (part: PayloadPart) => ({
      providerCode: row.providerCode,
      requestId: row.requestId,
      attempt: row.attempt,
      part,
      ownerTenantId: row.ownerTenantId,
      environment: row.environment,
    });
    return {
      providerCode: row.providerCode,
      requestId: row.requestId,
      attempt: row.attempt,
      operation: row.operation,
      environment: row.environment,
      accountRef: row.accountRef,
      orderId: row.orderId,
      sentAt: row.sentAt.toISOString(),
      durationMs: row.durationMs,
      httpStatus: row.httpStatus,
      providerStatusCode: row.providerStatusCode,
      outcome: row.outcome,
      redacted: redact,
      request: renderPayloadBody(
        { bytes: row.requestBytes, sealed: row.requestEnc, keyId: row.keyId },
        bindingOf('request'),
        keys,
        mode,
      ),
      response: renderPayloadBody(
        { bytes: row.responseBytes, sealed: row.responseEnc, keyId: row.keyId },
        bindingOf('response'),
        keys,
        mode,
      ),
    };
  }
}
