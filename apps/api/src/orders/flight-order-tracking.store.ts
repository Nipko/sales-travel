import { Injectable } from '@nestjs/common';
import {
  TICKET_DOCUMENT_KINDS,
  TICKET_DOCUMENT_STATUSES,
  TICKETING_DEADLINE_ZONES,
  type AirlineLocator,
  type OrderView,
  type TicketDocument,
  type TicketDocumentKind,
  type TicketDocumentStatus,
  type TicketingDeadline,
  type TicketingDeadlineZone,
} from '@sales-travel/domain';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import type {
  FlightDocumentKind,
  FlightDocumentStatus,
  TicketingDeadlineZone as DbTicketingDeadlineZone,
} from '../database/database.types.js';

/**
 * Lo que una lectura del proveedor dice de una reserva de VUELO, guardado en Postgres (0082): los
 * localizadores de la aerolínea, el plazo de emisión y los documentos con su estado.
 *
 * Lo escriben la lectura de cierre de la creación, la verificación diferida y la consulta manual,
 * siempre con el tenant fijado (`withTenant`): las dos tablas tienen RLS forzada y su FK compuesta
 * no deja colgar una fila de la orden de otro tenant. Lo lee Reservas, en lote, para pintar la
 * lista y el detalle sin volver a llamar al proveedor.
 *
 * Nada aquí sabe de un proveedor concreto: entra un `OrderView` del dominio.
 */

// El vocabulario de la base y el del dominio son el mismo; si uno cambia sin el otro, no compila.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const VOCABULARIO_ALINEADO: [
  Same<TicketDocumentKind, FlightDocumentKind>,
  Same<TicketDocumentStatus, FlightDocumentStatus>,
  Same<TicketingDeadlineZone, DbTicketingDeadlineZone>,
] = [true, true, true];
void VOCABULARIO_ALINEADO;

/** Un documento tal como queda guardado. */
export interface StoredFlightDocument {
  readonly number: string;
  readonly kind: TicketDocumentKind;
  readonly travelerIndex: number | null;
  readonly status: TicketDocumentStatus;
  readonly providerStatusCode: string | null;
}

/** El plazo guardado. `at` sólo existe con zona `UTC`. */
export interface StoredTicketingDeadline extends TicketingDeadline {
  readonly at?: Date;
}

/** El seguimiento de una orden de vuelo tal como lo lee la API, antes de pasar a la vista. */
export interface FlightOrderTrackingRecord {
  readonly orderId: string;
  readonly airlineLocators: readonly AirlineLocator[];
  readonly documents: readonly StoredFlightDocument[];
  readonly ticketingDeadline: StoredTicketingDeadline | null;
  readonly lastReadAt: Date | null;
}

/** Lo que una lectura deja escrito, ya validado. */
export interface FlightOrderRead {
  readonly at: Date;
  readonly airlineLocators: readonly AirlineLocator[];
  readonly documents: readonly TicketDocument[];
  readonly ticketingDeadline?: TicketingDeadline;
}

/** Qué cambió en los documentos. Es lo único que va al evento: conteos, nunca números. */
export interface FlightDocumentChanges {
  readonly added: number;
  readonly statusChanged: number;
}

/**
 * La vista pública del seguimiento, la que sale por la API (`flightTracking`). Sin código del
 * proveedor ni momentos de lectura: lo que el vendedor necesita para el check-in, la emisión y el
 * plazo.
 */
export interface PublicFlightOrderTracking {
  readonly airlineLocators: readonly { carrierCode: string; locator: string }[];
  readonly documents: readonly {
    number: string;
    kind: TicketDocumentKind;
    status: TicketDocumentStatus;
    travelerIndex: number | null;
  }[];
  readonly ticketingDeadline: {
    date: string;
    time?: string;
    zone: TicketingDeadlineZone;
    at?: string;
  } | null;
}

// ---------------------------------------------------------------------------------------------
// El borde: lo que entra de un adapter se valida antes de tocar la base. Una entrada que no encaja
// se descarta sola; nunca tumba la lectura de las demás.
// ---------------------------------------------------------------------------------------------

const LocatorSchema = z.object({
  // Dos letras IATA o el código de sistema de tres o cuatro que da NDC (`UAD`).
  carrierCode: z.string().regex(/^[A-Z0-9]{2,4}$/),
  locator: z.string().regex(/^[A-Z0-9]{5,16}$/),
});

/** El número principal del documento, como el CHECK de 0082. */
const DOCUMENT_NUMBER = /^[0-9]{10,16}$/;

const DocumentSchema = z.object({
  number: z.string().regex(DOCUMENT_NUMBER),
  kind: z.enum(TICKET_DOCUMENT_KINDS),
  travelerIndex: z.number().int().min(0).max(999).optional(),
  status: z.enum(TICKET_DOCUMENT_STATUSES),
  providerStatusCode: z
    .string()
    .regex(/^[A-Z0-9]{1,4}$/)
    .optional(),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `YYYY-MM-DD` que existe en el calendario: un `DATE` de Postgres rechaza `2026-02-30`. */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const DeadlineSchema = z.object({
  date: z.string().refine(isCalendarDate),
  time: z.string().regex(TIME).optional(),
  zone: z.enum(TICKETING_DEADLINE_ZONES),
});

/** Rango de cada estado al juntar dos observaciones del mismo número en una lectura. */
function rank(status: TicketDocumentStatus): number {
  if (status === 'ISSUED') return 1;
  if (status === 'UNKNOWN') return 0;
  return 2;
}

/**
 * Los documentos de la lectura, validados y uno por número.
 *
 * Con `documents` ausente, el adapter no sabe leer estados (LATAM): sus `ticketNumbers` se guardan
 * como tiquetes de estado `UNKNOWN`, que es lo que se sabe de ellos. Con `documents` presente, ésa
 * es la lista, aunque venga vacía.
 */
function documentsOf(view: OrderView): TicketDocument[] {
  const observed: unknown[] =
    view.documents ??
    (view.ticketNumbers ?? []).map((number) => ({ number, kind: 'TICKET', status: 'UNKNOWN' }));
  const byNumber = new Map<string, TicketDocument>();
  for (const raw of observed) {
    const parsed = DocumentSchema.safeParse(raw);
    if (!parsed.success) continue;
    const document: TicketDocument = {
      number: parsed.data.number,
      kind: parsed.data.kind,
      status: parsed.data.status,
      ...(parsed.data.travelerIndex === undefined
        ? {}
        : { travelerIndex: parsed.data.travelerIndex }),
      ...(parsed.data.providerStatusCode === undefined
        ? {}
        : { providerStatusCode: parsed.data.providerStatusCode }),
    };
    const previous = byNumber.get(document.number);
    if (previous === undefined || rank(document.status) > rank(previous.status)) {
      byNumber.set(document.number, document);
    }
  }
  return [...byNumber.values()];
}

/** Lo que una lectura encontrada deja escrito. Pura: el instante se inyecta. */
export function flightReadOf(view: OrderView, at: Date): FlightOrderRead {
  const seen = new Set<string>();
  const airlineLocators: AirlineLocator[] = [];
  for (const raw of view.airlineLocators) {
    const parsed = LocatorSchema.safeParse(raw);
    if (!parsed.success) continue;
    const key = `${parsed.data.carrierCode}|${parsed.data.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    airlineLocators.push({ carrierCode: parsed.data.carrierCode, locator: parsed.data.locator });
  }
  const deadline = DeadlineSchema.safeParse(view.ticketingDeadline);
  return {
    at,
    airlineLocators,
    documents: documentsOf(view),
    ...(deadline.success
      ? {
          ticketingDeadline: {
            date: deadline.data.date,
            zone: deadline.data.zone,
            ...(deadline.data.time === undefined ? {} : { time: deadline.data.time }),
          },
        }
      : {}),
  };
}

/** El instante de un plazo UTC con hora. Con la hora de la oficina, o sin hora, no hay instante. */
function deadlineInstant(deadline: TicketingDeadline): Date | null {
  if (deadline.zone !== 'UTC' || deadline.time === undefined) return null;
  return new Date(`${deadline.date}T${deadline.time}:00.000Z`);
}

/** Lo que hay que escribir de un documento, o `null` si la lectura no cambia nada. */
export interface FlightDocumentWrite {
  readonly change: 'added' | 'status' | 'detail';
  readonly kind: TicketDocumentKind;
  readonly status: TicketDocumentStatus;
  readonly travelerIndex: number | null;
  readonly providerStatusCode: string | null;
  readonly issuedAt?: Date;
  readonly voidedAt?: Date;
  readonly refundedAt?: Date;
}

const TERMINAL: ReadonlySet<TicketDocumentStatus> = new Set(['VOIDED', 'REFUNDED', 'EXCHANGED']);

/**
 * La transición de un documento con una lectura nueva. Pura.
 *
 * - Un estado terminal (anulado, devuelto, canjeado) no vuelve a emitido ni a desconocido: un
 *   tiquete anulado no se reactiva, y una lectura que lo trae "emitido" es la entrada vieja de un
 *   conjuntivo o una lectura atrasada.
 * - `UNKNOWN` no pisa un estado conocido ni el tipo del documento: dice que no se supo leer, no
 *   que cambió. Sí deja su código, que es lo que una persona revisa.
 * - Entre estados conocidos, manda la lectura nueva.
 *
 * Cada `*_at` se escribe la primera vez que se ve su estado, con el instante de la lectura.
 */
export function nextFlightDocumentState(
  existing: StoredFlightDocument | undefined,
  observed: TicketDocument,
  at: Date,
): FlightDocumentWrite | null {
  const travelerIndex = observed.travelerIndex ?? existing?.travelerIndex ?? null;
  const providerStatusCode = observed.providerStatusCode ?? existing?.providerStatusCode ?? null;
  const stamps = (status: TicketDocumentStatus) => ({
    ...(status === 'ISSUED' ? { issuedAt: at } : {}),
    ...(status === 'VOIDED' ? { voidedAt: at } : {}),
    ...(status === 'REFUNDED' ? { refundedAt: at } : {}),
  });

  if (existing === undefined) {
    return {
      change: 'added',
      kind: observed.kind,
      status: observed.status,
      travelerIndex,
      providerStatusCode,
      ...stamps(observed.status),
    };
  }

  const keepsStatus =
    observed.status === 'UNKNOWN' ||
    (TERMINAL.has(existing.status) && !TERMINAL.has(observed.status));
  const status = keepsStatus ? existing.status : observed.status;
  const kind = observed.status === 'UNKNOWN' ? existing.kind : observed.kind;

  if (status !== existing.status) {
    return { change: 'status', kind, status, travelerIndex, providerStatusCode, ...stamps(status) };
  }
  if (
    kind !== existing.kind ||
    travelerIndex !== existing.travelerIndex ||
    providerStatusCode !== existing.providerStatusCode
  ) {
    return { change: 'detail', kind, status, travelerIndex, providerStatusCode };
  }
  return null;
}

/** La vista pública de un seguimiento guardado. */
export function publicFlightOrderTracking(
  record: FlightOrderTrackingRecord,
): PublicFlightOrderTracking {
  const deadline = record.ticketingDeadline;
  return {
    airlineLocators: record.airlineLocators.map((l) => ({
      carrierCode: l.carrierCode,
      locator: l.locator,
    })),
    documents: record.documents.map((d) => ({
      number: d.number,
      kind: d.kind,
      status: d.status,
      travelerIndex: d.travelerIndex,
    })),
    ticketingDeadline:
      deadline === null
        ? null
        : {
            date: deadline.date,
            zone: deadline.zone,
            ...(deadline.time === undefined ? {} : { time: deadline.time }),
            ...(deadline.at === undefined ? {} : { at: deadline.at.toISOString() }),
          },
  };
}

/** `pg` entrega TIMESTAMPTZ como `Date`; un driver que lo entregue como texto también sirve. */
function dateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Los localizadores guardados, leídos con la misma regla que al escribir. */
function storedLocators(raw: unknown): AirlineLocator[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const parsed = LocatorSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

@Injectable()
export class FlightOrderTrackingStore {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Registra una lectura de la orden `orderId` de ESTE tenant y devuelve qué cambió en sus
   * documentos.
   *
   * Todo en una transacción, y la fila de seguimiento va primero: su upsert toma el lock de la fila
   * y serializa dos lecturas de la misma orden, así que la segunda ve los documentos de la primera
   * y no cuenta dos veces el mismo alta.
   *
   * Una lectura sin localizadores o sin plazo no borra los guardados: puede venir filtrada, y el
   * vendedor no puede perder el localizador del check-in porque una consulta no lo trajo. Una que
   * los trae, los reemplaza. Un documento que la lectura no trae no se toca.
   */
  async recordRead(
    tenantId: string,
    orderId: string,
    read: FlightOrderRead,
  ): Promise<FlightDocumentChanges> {
    const deadline = read.ticketingDeadline;
    const updates = {
      last_read_at: read.at,
      ...(read.airlineLocators.length === 0
        ? {}
        : { airline_locators: JSON.stringify(read.airlineLocators) }),
      ...(deadline === undefined
        ? {}
        : {
            ticketing_deadline_date: deadline.date,
            ticketing_deadline_time: deadline.time ?? null,
            ticketing_deadline_zone: deadline.zone,
            ticketing_deadline_at: deadlineInstant(deadline),
          }),
    };

    return this.db.withTenant(tenantId, async (trx) => {
      await trx
        .insertInto('flight_order_tracking')
        .values({ order_id: orderId, tenant_id: tenantId, ...updates })
        .onConflict((oc) => oc.column('order_id').doUpdateSet(updates))
        .execute();

      if (read.documents.length === 0) return { added: 0, statusChanged: 0 };

      const rows = await trx
        .selectFrom('order_flight_documents')
        .select(['number', 'kind', 'traveler_index', 'status', 'provider_status_code'])
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', tenantId)
        .execute();
      const existing = new Map<string, StoredFlightDocument>(
        rows.map((row) => [
          row.number,
          {
            number: row.number,
            kind: row.kind,
            travelerIndex: row.traveler_index,
            status: row.status,
            providerStatusCode: row.provider_status_code,
          },
        ]),
      );

      let added = 0;
      let statusChanged = 0;
      for (const observed of read.documents) {
        const write = nextFlightDocumentState(existing.get(observed.number), observed, read.at);
        if (write === null) continue;
        const columns = {
          kind: write.kind,
          status: write.status,
          traveler_index: write.travelerIndex,
          provider_status_code: write.providerStatusCode,
          ...(write.issuedAt === undefined ? {} : { issued_at: write.issuedAt }),
          ...(write.voidedAt === undefined ? {} : { voided_at: write.voidedAt }),
          ...(write.refundedAt === undefined ? {} : { refunded_at: write.refundedAt }),
        };
        if (write.change === 'added') {
          await trx
            .insertInto('order_flight_documents')
            .values({ tenant_id: tenantId, order_id: orderId, number: observed.number, ...columns })
            .execute();
          added += 1;
          continue;
        }
        // El primer instante de cada estado no se pisa: `coalesce` deja el que ya estaba.
        await trx
          .updateTable('order_flight_documents')
          .set({
            kind: columns.kind,
            status: columns.status,
            traveler_index: columns.traveler_index,
            provider_status_code: columns.provider_status_code,
            ...(write.issuedAt === undefined
              ? {}
              : { issued_at: sql<Date>`coalesce(issued_at, ${write.issuedAt})` }),
            ...(write.voidedAt === undefined
              ? {}
              : { voided_at: sql<Date>`coalesce(voided_at, ${write.voidedAt})` }),
            ...(write.refundedAt === undefined
              ? {}
              : { refunded_at: sql<Date>`coalesce(refunded_at, ${write.refundedAt})` }),
          })
          .where('order_id', '=', orderId)
          .where('tenant_id', '=', tenantId)
          .where('number', '=', observed.number)
          .execute();
        if (write.change === 'status') statusChanged += 1;
      }
      return { added, statusChanged };
    });
  }

  /** El seguimiento de las órdenes pedidas que lo tienen. Las de otro tenant no aparecen. */
  async listTracking(
    tenantId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, FlightOrderTrackingRecord>> {
    if (orderIds.length === 0) return new Map();
    const ids = [...orderIds];
    const { tracking, documents } = await this.db.withTenant(tenantId, async (trx) => ({
      tracking: await trx
        .selectFrom('flight_order_tracking')
        .select([
          'order_id',
          'airline_locators',
          sql<string | null>`to_char(ticketing_deadline_date, 'YYYY-MM-DD')`.as(
            'ticketing_deadline_date',
          ),
          'ticketing_deadline_time',
          'ticketing_deadline_zone',
          'ticketing_deadline_at',
          'last_read_at',
        ])
        .where('tenant_id', '=', tenantId)
        .where('order_id', 'in', ids)
        .execute(),
      documents: await trx
        .selectFrom('order_flight_documents')
        .select(['order_id', 'number', 'kind', 'traveler_index', 'status', 'provider_status_code'])
        .where('tenant_id', '=', tenantId)
        .where('order_id', 'in', ids)
        .orderBy('order_id')
        .orderBy('created_at')
        .orderBy('number')
        .execute(),
    }));

    const docsByOrder = new Map<string, StoredFlightDocument[]>();
    for (const row of documents) {
      const list = docsByOrder.get(row.order_id) ?? [];
      list.push({
        number: row.number,
        kind: row.kind,
        travelerIndex: row.traveler_index,
        status: row.status,
        providerStatusCode: row.provider_status_code,
      });
      docsByOrder.set(row.order_id, list);
    }

    const result = new Map<string, FlightOrderTrackingRecord>();
    for (const row of tracking) {
      const at = dateOrNull(row.ticketing_deadline_at);
      const deadline: StoredTicketingDeadline | null =
        row.ticketing_deadline_date === null || row.ticketing_deadline_zone === null
          ? null
          : {
              date: row.ticketing_deadline_date,
              zone: row.ticketing_deadline_zone,
              ...(row.ticketing_deadline_time === null
                ? {}
                : { time: row.ticketing_deadline_time }),
              ...(at === null ? {} : { at }),
            };
      result.set(row.order_id, {
        orderId: row.order_id,
        airlineLocators: storedLocators(row.airline_locators),
        documents: docsByOrder.get(row.order_id) ?? [],
        ticketingDeadline: deadline,
        lastReadAt: dateOrNull(row.last_read_at),
      });
    }
    // Una orden con documentos y sin fila de seguimiento no existe: la fila se escribe primero, en
    // la misma transacción. Si apareciera, sus documentos igual se muestran.
    for (const [orderId, docs] of docsByOrder) {
      if (result.has(orderId)) continue;
      result.set(orderId, {
        orderId,
        airlineLocators: [],
        documents: docs,
        ticketingDeadline: null,
        lastReadAt: null,
      });
    }
    return result;
  }
}
