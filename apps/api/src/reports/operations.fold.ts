/**
 * Inicio → Hoy: lo que la agencia tiene que atender hoy, de sus propias reservas y cotizaciones.
 * Sin I/O: de las filas que lee {@link ReportsService.getOperations} a la vista. Sin datos de
 * pasajeros ni clientes: números de reserva y de cotización, y fechas.
 */

export type OperationsLevel = 'ok' | 'warn' | 'critical';

/** Los plazos de emisión que se miran: los vencidos y los que vencen en esta ventana. */
export const DEADLINE_WINDOW_HOURS = 72;
/** Un plazo en esta ventana ya es urgente. */
export const DEADLINE_URGENT_HOURS = 24;
/** Las cotizaciones vigentes que vencen en esta ventana. */
export const QUOTATION_WINDOW_HOURS = 48;
/** Una reserva en creación más vieja que esto quedó trabada: alguien tiene que mirarla. */
export const PENDING_STUCK_MINUTES = 30;
/** Las reservas fallidas recientes que se cuentan. */
export const FAILED_WINDOW_DAYS = 7;
/** Cuántas filas se listan de cada cosa. */
export const OPERATIONS_LIST_LIMIT = 5;

const HOUR_MS = 3_600_000;

type DbNumber = string | number | bigint | null | undefined;

export interface DeadlineRow {
  order_id: string;
  order_number: DbNumber;
  deadline_at: Date | string;
}

export interface QuotationExpiryRow {
  quotation_id: string;
  quote_number: DbNumber;
  expires_at: Date | string;
}

export interface PendingOrdersRow {
  pending: DbNumber;
  stuck: DbNumber;
  oldest_at: Date | string | null;
}

export interface OperationsRows {
  deadlines: readonly DeadlineRow[];
  pending: PendingOrdersRow | undefined;
  failed: DbNumber;
  quotations: readonly QuotationExpiryRow[];
}

export interface DeadlineItem {
  orderId: string;
  orderNumber: number;
  /** ISO 8601. */
  deadlineAt: string;
  overdue: boolean;
}

export interface QuotationItem {
  quotationId: string;
  quoteNumber: number;
  /** ISO 8601. */
  expiresAt: string;
}

export interface AgencyOperations {
  /** ISO 8601. */
  generatedAt: string;
  /** El peor de todo: la pantalla lo usa para el tono del bloque. */
  level: OperationsLevel;
  deadlines: {
    windowHours: number;
    /** Confirmadas sin tiquete con el plazo ya vencido. */
    overdue: number;
    /** Vencen en las próximas {@link DEADLINE_URGENT_HOURS} horas. */
    within24h: number;
    /** Vencen después de 24 horas y dentro de la ventana. */
    later: number;
    /** Las más próximas primero, hasta {@link OPERATIONS_LIST_LIMIT}. */
    items: DeadlineItem[];
  };
  pendingOrders: {
    count: number;
    /** En creación hace más de {@link PENDING_STUCK_MINUTES} minutos. */
    stuck: number;
    /** ISO 8601 de la más vieja, o `null`. */
    oldestAt: string | null;
  };
  failedOrders: { days: number; count: number };
  quotationsExpiring: { windowHours: number; count: number; items: QuotationItem[] };
}

function count(value: DbNumber): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function foldOperations(rows: OperationsRows, now: Date): AgencyOperations {
  const nowMs = now.getTime();
  const deadlines = rows.deadlines
    .flatMap((r): DeadlineItem[] => {
      const at = iso(r.deadline_at);
      if (at === null) return [];
      return [
        {
          orderId: r.order_id,
          orderNumber: count(r.order_number),
          deadlineAt: at,
          overdue: Date.parse(at) <= nowMs,
        },
      ];
    })
    .sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt));
  const overdue = deadlines.filter((d) => d.overdue).length;
  const within24h = deadlines.filter(
    (d) => !d.overdue && Date.parse(d.deadlineAt) - nowMs <= DEADLINE_URGENT_HOURS * HOUR_MS,
  ).length;
  const later = deadlines.length - overdue - within24h;

  const quotations = rows.quotations
    .flatMap((r): QuotationItem[] => {
      const at = iso(r.expires_at);
      return at === null
        ? []
        : [{ quotationId: r.quotation_id, quoteNumber: count(r.quote_number), expiresAt: at }];
    })
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

  const pending = count(rows.pending?.pending);
  const stuck = count(rows.pending?.stuck);
  const failed = count(rows.failed);

  const level: OperationsLevel =
    overdue + within24h + stuck > 0
      ? 'critical'
      : later + pending + failed + quotations.length > 0
        ? 'warn'
        : 'ok';

  return {
    generatedAt: now.toISOString(),
    level,
    deadlines: {
      windowHours: DEADLINE_WINDOW_HOURS,
      overdue,
      within24h,
      later,
      items: deadlines.slice(0, OPERATIONS_LIST_LIMIT),
    },
    pendingOrders: { count: pending, stuck, oldestAt: iso(rows.pending?.oldest_at ?? null) },
    failedOrders: { days: FAILED_WINDOW_DAYS, count: failed },
    quotationsExpiring: {
      windowHours: QUOTATION_WINDOW_HOURS,
      count: quotations.length,
      items: quotations.slice(0, OPERATIONS_LIST_LIMIT),
    },
  };
}
