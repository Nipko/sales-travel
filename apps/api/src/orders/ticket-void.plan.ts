import type { OrderView, TicketCheckResult, TicketEligibility } from '@sales-travel/domain';
import {
  TICKET_OPERATIONS,
  TICKET_VOID_NOT_AVAILABLE_MESSAGE,
  type TicketOperation,
} from '../providers/provider.types.js';

/*
 * Anular (VOID) los tiquetes de una reserva emitida (SAB-09), sin I/O: qué se le muestra al vendedor
 * de las condiciones de los tiquetes, cuándo se ofrece anular y cómo se lee una anulación guardada.
 *
 * La regla de fondo: la ventana de anulación se LEE del proveedor en cada consulta y nunca se
 * calcula. Un cálculo propio que discrepe del de la aerolínea promete una anulación gratis que ya no
 * lo es, o regala una penalidad (docs/sabre/06 §5.3). Por eso no hay caché ni contador: la pantalla
 * muestra un semáforo con lo que el proveedor dijo y la hora a la que lo dijo.
 */

/** Lo que lee el vendedor. En «tú», como todo el panel. */
export const TICKET_VOID_MESSAGES = {
  voided: 'Tiquetes anulados. La reserva quedó cancelada.',
  unverified:
    'No pudimos confirmar la anulación. No reintentes: revisamos la reserva con el proveedor.',
  notAvailable: TICKET_VOID_NOT_AVAILABLE_MESSAGE,
  rejected:
    'La aerolínea rechazó la anulación y los tiquetes siguen emitidos. Revisa las condiciones de reembolso.',
  notSent:
    'No pudimos comunicarnos con la aerolínea antes de anular. No se anuló nada: vuelve a intentarlo en unos minutos.',
  notFound: 'La reserva no existe o no tiene localizador.',
  notTicketed: 'Sólo se pueden anular los tiquetes de una reserva emitida.',
  notTicketedCheck: 'Las condiciones de los tiquetes sólo se consultan en una reserva emitida.',
  ticketedCancel: 'La reserva está emitida. Para cancelarla, anula o reembolsa los tiquetes.',
  unsupported: 'La anulación de tiquetes no está disponible para esta reserva.',
  noRetry:
    'Una anulación no se reintenta desde el historial. Vuelve a consultar las condiciones de los tiquetes y anúlalos de nuevo.',
} as const;

/**
 * El motivo máquina de cada rechazo de `POST /orders/:id/void` (sale como `reason` en el cuerpo).
 * Con él la pantalla distingue un 409 «quedó en duda, no repitas» de un 409 «la aerolínea dijo que
 * no» sin comparar textos, y un 503 en el que no salió nada de un 5xx que no se sabe si llegó.
 */
export const TICKET_VOID_REASONS = {
  /** Ya no se puede anular sin costo (lo lleva `TicketVoidNotAvailableError`). */
  notAvailable: 'TICKET_VOID_NOT_AVAILABLE',
  /** Pudo llegar al proveedor y no se sabe qué hizo: se concilia, nunca se repite. */
  unverified: 'TICKET_VOID_UNVERIFIED',
  /** La aerolínea la rechazó y la reserva sigue con sus tiquetes emitidos. */
  rejected: 'TICKET_VOID_REJECTED',
  /** No salió nada: se puede volver a pedir, con una consulta nueva de las condiciones. */
  notSent: 'TICKET_VOID_NOT_SENT',
} as const;

/** El cuerpo de un rechazo de la anulación: el texto para el vendedor y su motivo máquina. */
export function ticketVoidRefusal(
  kind: Exclude<keyof typeof TICKET_VOID_REASONS, 'notAvailable'>,
): { readonly message: string; readonly reason: string } {
  return { message: TICKET_VOID_MESSAGES[kind], reason: TICKET_VOID_REASONS[kind] };
}

/** El `last_error` durable de la operación: qué se puede hacer, nunca el error del proveedor. */
export const VOID_UNVERIFIED_LAST_ERROR = 'Anulación sin confirmar; requiere conciliación.';
export const VOID_REJECTED_LAST_ERROR = 'Anulación rechazada por la aerolínea.';

/**
 * En qué quedó una anulación.
 *
 * - `VOIDED`: el proveedor la confirmó. La reserva queda cancelada.
 * - `PARTIAL`: anuló unos tiquetes y otros no. Se concilia y lo mira una persona.
 * - `UNVERIFIED`: no se sabe qué pasó (sin respuesta, o un rechazo que no se pudo contrastar con una
 *   lectura de la reserva). Prohibido repetirla hasta conciliar.
 * - `REJECTED`: el proveedor dijo que no y la reserva sigue con sus tiquetes emitidos.
 * - `NOT_SENT`: no llegó a salir (falló la lectura o la comprobación previas). Se puede volver a
 *   pedir, con una consulta nueva de las condiciones.
 */
export const TICKET_VOID_OUTCOMES = [
  'VOIDED',
  'PARTIAL',
  'UNVERIFIED',
  'REJECTED',
  'NOT_SENT',
] as const;
export type TicketVoidOutcome = (typeof TICKET_VOID_OUTCOMES)[number];

/**
 * Lo que responde `POST /orders/:id/void` cuando la anulación salió y no fue rechazada. Un rechazo,
 * con la reserva intacta, es un 409 con el motivo.
 */
export interface TicketVoidReply {
  readonly outcome: Extract<TicketVoidOutcome, 'VOIDED' | 'PARTIAL' | 'UNVERIFIED'>;
  readonly message: string;
  /** `cancelled` si se anuló; `pending` mientras se concilia. */
  readonly orderStatus: string;
}

/** Lo que una anulación que salió deja decidido, antes de cerrar la operación. */
export interface TicketVoidSettlement {
  readonly outcome: Exclude<TicketVoidOutcome, 'NOT_SENT'>;
  /** La relectura de la reserva después de la anulación, si se pudo hacer. */
  readonly read?: OrderView;
  /** Cuántos tiquetes muestra anulados esa relectura. */
  readonly voidedTickets?: number;
}

/**
 * En qué quedó una anulación que el proveedor contestó, contrastada con la relectura.
 *
 * - Sin respuesta verificable, `UNVERIFIED` sin mirar más: no se sabe qué hizo el proveedor.
 * - Confirmada, `VOIDED`.
 * - Declarada a medias, `PARTIAL`.
 * - Rechazada: la documentación del proveedor no garantiza que un rechazo deshaga los tiquetes ya
 *   anulados (docs/sabre/06 §5.2), así que manda la relectura. Con tiquetes anulados es `PARTIAL`;
 *   sin relectura no se puede saber y es `UNVERIFIED`; sólo con la reserva intacta es `REJECTED`.
 */
export function settleTicketVoid(attempt: {
  readonly success: boolean;
  readonly verified: boolean;
  readonly partial: boolean;
  readonly read: OrderView | undefined;
}): TicketVoidSettlement {
  if (!attempt.verified) return { outcome: 'UNVERIFIED' };
  const read = attempt.read;
  const seen = read === undefined ? {} : { read, voidedTickets: voidedTicketCount(read) };
  if (attempt.success) return { outcome: 'VOIDED', ...seen };
  if (attempt.partial) return { outcome: 'PARTIAL', ...seen };
  if (read === undefined) return { outcome: 'UNVERIFIED' };
  return { outcome: voidedTicketCount(read) > 0 ? 'PARTIAL' : 'REJECTED', ...seen };
}

/**
 * El semáforo de la anulación.
 *
 * - `available`: se puede anular sin costo (verde).
 * - `unavailable`: el proveedor dijo que ya no (rojo).
 * - `unknown`: el proveedor no lo informó (gris). No es «no»: no se ofrece anular.
 */
export type TicketVoidStatus = 'available' | 'unavailable' | 'unknown';

export interface TicketVoidAvailability {
  readonly status: TicketVoidStatus;
  /** Hasta cuándo, ISO 8601 en UTC, si el proveedor lo dio. Nunca se calcula. */
  readonly expiresAt?: string;
}

/** Una oferta sigue viva hasta su minuto de caducidad. Una fecha ilegible no promete nada. */
function offerAlive(expiresAt: string | undefined, now: number): boolean {
  if (expiresAt === undefined) return true;
  const at = Date.parse(expiresAt);
  return !Number.isNaN(at) && at >= now;
}

/**
 * ¿Se pueden anular los tiquetes, según la comprobación que acaba de hacer el proveedor?
 *
 * 1. Un tiquete que el proveedor declara no anulable cierra la puerta: anular es todo o nada.
 * 2. Una oferta `VOID` vigente la abre (contenido que se anula por oferta, con su caducidad).
 * 3. Si no, hace falta que cada tiquete se declare anulable.
 * 4. Si el proveedor ofreció otras formas de cancelar y ninguna es una anulación vigente, ya no se
 *    puede. Sin tiquetes ni ofertas, no lo dijo.
 *
 * Es la misma compuerta que vuelve a aplicar el adapter justo antes de mandar la anulación.
 */
export function ticketVoidAvailability(
  check: TicketCheckResult,
  now: Date,
): TicketVoidAvailability {
  if (check.tickets.some((ticket) => ticket.voidable === 'no')) return { status: 'unavailable' };
  const at = now.getTime();
  const [offer] = check.cancelOffers.filter(
    (candidate) => candidate.kind === 'VOID' && offerAlive(candidate.expiresAt, at),
  );
  if (offer !== undefined) {
    return {
      status: 'available',
      ...(offer.expiresAt === undefined ? {} : { expiresAt: offer.expiresAt }),
    };
  }
  if (check.tickets.length > 0 && check.tickets.every((ticket) => ticket.voidable === 'yes')) {
    return { status: 'available' };
  }
  if (check.cancelOffers.length > 0) return { status: 'unavailable' };
  return { status: 'unknown' };
}

/** Lo que sale por `GET /orders/:id/ticket-check`. Sin importes: el reembolso es otro flujo. */
export interface PublicTicketCheck {
  readonly checkedAt: string;
  readonly tickets: readonly {
    readonly number: string;
    readonly voidable: TicketEligibility;
    readonly refundable: TicketEligibility;
  }[];
  readonly voidAvailable: boolean;
  readonly voidStatus: TicketVoidStatus;
  readonly voidExpiresAt?: string;
}

/** El número principal de un tiquete, como lo guarda la reserva (0082). */
const DOCUMENT_NUMBER = /^[0-9]{10,16}$/;
const ELIGIBILITY: ReadonlySet<string> = new Set(['yes', 'no', 'unknown']);

function eligibilityOf(value: string): TicketEligibility {
  return ELIGIBILITY.has(value) ? (value as TicketEligibility) : 'unknown';
}

/** La vista pública de una comprobación. Lo que no tiene forma de número de tiquete no sale. */
export function publicTicketCheck(check: TicketCheckResult, now: Date): PublicTicketCheck {
  const availability = ticketVoidAvailability(check, now);
  const checkedAt = Number.isNaN(Date.parse(check.checkedAt)) ? now.toISOString() : check.checkedAt;
  return {
    checkedAt,
    tickets: check.tickets
      .filter((ticket) => DOCUMENT_NUMBER.test(ticket.number))
      .map((ticket) => ({
        number: ticket.number,
        voidable: eligibilityOf(ticket.voidable),
        refundable: eligibilityOf(ticket.refundable),
      })),
    voidAvailable: availability.status === 'available',
    voidStatus: availability.status,
    ...(availability.expiresAt === undefined ? {} : { voidExpiresAt: availability.expiresAt }),
  };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

/** La operación con tiquetes que guardó una cancelación, o `undefined` si fue una genérica. */
export function persistedTicketOperation(result: unknown): TicketOperation | undefined {
  const raw = jsonObject(result)?.['ticketOperation'];
  return TICKET_OPERATIONS.find((operation) => operation === raw);
}

/** Cuántos tiquetes muestra anulados una lectura de la reserva. */
export function voidedTicketCount(view: OrderView): number {
  if (!view.found) return 0;
  return (view.documents ?? []).filter(
    (document) => document.kind === 'TICKET' && document.status === 'VOIDED',
  ).length;
}
