import type { HcnPriority, HcnState, OrderStatus } from '../database/database.types.js';
import type { HotelVerificationRead } from './hotel-booking-verification.js';
import {
  planHotelOrderObservation,
  type HotelOrderPlan,
  type HotelOrderSnapshot,
} from './hotel-order-state.js';

/**
 * El seguimiento del número de confirmación del hotel (HCN): **las decisiones, sin I/O**
 * (docs/tbo/09 PR-5.4; 08 RF-27; 04 §8.3 a §8.6; D-TBO-27 A, D-TBO-29 A).
 *
 * El proveedor da el HCN sólo si el check-in está a 30 días o menos de la reserva, con un SLA que
 * depende de esa distancia (p. 42-43): una primera lectura cuando vence el SLA, un reintento cada
 * hora hasta tres, y si sigue sin llegar, un "operations ticket". Aquí vive el plan (`hcnPlan`, la
 * función de 04 §8.3), cuándo se deja de seguir y qué hacer con cada lectura. La cola y el barrido
 * sólo despiertan (D9): migrar a Temporal es reescribir el runner, no esto.
 *
 * Lo que el PDF no fija y aquí se decide (INFERIDO, → Q-54):
 *
 * - **Intervalos `[a, b)`** (PV-35): el límite pertenece al tramo superior. Así sale el ejemplo del
 *   PDF ("check-in in 2 days (P2)") y nunca se lee antes del SLA de TBO.
 * - **El check-in es las 00:00 del día de entrada en la hora del hotel** (PV-36); sin la zona, las
 *   00:00 UTC.
 * - **Cuatro lecturas** (PV-37): la del SLA y tres reintentos, cada una una hora después de la
 *   anterior. El ticket sale después de la cuarta.
 * - **Fuera de ventana** (PV-38): con el check-in a 720 h o más, el plan entra en ventana a
 *   `check-in − 720 h` con el SLA de P5, como si se hubiera reservado en ese momento, y sin ticket
 *   automático.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * La zona que termina un día más tarde es UTC−12. Sin la zona del hotel, el día de entrada terminó
 * para todos recién 12 h después de las 00:00 UTC del día siguiente.
 */
const LATEST_OFFSET_MS = 12 * HOUR;

interface HcnTier {
  readonly priority: HcnPriority;
  /** El tramo cubre `W < belowHours` (y `W ≥` el límite del tramo anterior). */
  readonly belowHours: number;
  /** "HCN SLA (From Booking Time)". */
  readonly slaHours: number;
}

const P5: HcnTier = { priority: 'P5', belowHours: 720, slaHours: 120 };

/** La tabla de p. 43, en el orden en que se busca el tramo. */
export const HCN_TIERS: readonly HcnTier[] = Object.freeze([
  { priority: 'P0', belowHours: 24, slaHours: 3 },
  { priority: 'P1', belowHours: 48, slaHours: 4 },
  { priority: 'P2', belowHours: 72, slaHours: 6 },
  { priority: 'P3', belowHours: 120, slaHours: 12 },
  { priority: 'P4', belowHours: 192, slaHours: 48 },
  { priority: 'P4+', belowHours: 336, slaHours: 72 },
  P5,
]);

/** "HCN will only be provided if the check-in is within 30 days of the booking" (p. 42). */
export const HCN_WINDOW_MS = P5.belowHours * HOUR;

/** "Maximum 3 retries can be made" (p. 43). */
export const HCN_RETRIES = 3;

/** La lectura del SLA más los reintentos (PV-37). */
export const HCN_READS = HCN_RETRIES + 1;

/** "If HCN is not available, Retry every 1 hour" (p. 43). */
export const HCN_RETRY_EVERY_MS = HOUR;

/**
 * Cuánto después de su hora una lectura se da por perdida en la cola (04 §8.5): cubre los
 * reintentos del job con margen, y el barrido no pisa un job que sigue vivo.
 */
export const HCN_CHECK_GRACE_MS = 15 * MIN;

/**
 * Cuánto antes de su hora se acepta un job: el reloj de Redis y el de la API no son el mismo. Más
 * temprano no, porque leer antes del SLA gasta un intento del plan.
 */
export const HCN_EARLY_TOLERANCE_MS = MIN;

/** Cuántas órdenes de un tenant revisa el barrido por corrida y por clase: el resto, en la siguiente. */
export const HCN_SWEEP_LIMIT = 25;

// ───────────────────────── El plan (04 §8.3) ─────────────────────────

export interface HcnInWindowPlan {
  readonly kind: 'in-window';
  readonly priority: HcnPriority;
  /** La lectura del SLA. */
  readonly firstCheckAt: number;
  /** Los tres reintentos, una hora después de la lectura anterior. */
  readonly retryAt: readonly number[];
  /** Si la cuarta lectura tampoco trae el HCN, la tarea de operaciones sale en ese momento. */
  readonly ticketAt: number;
}

export interface HcnOutOfWindowPlan {
  readonly kind: 'out-of-window';
  /** `check-in − 720 h`: desde ahí corre el SLA de P5 (PV-38). */
  readonly windowEntryAt: number;
}

export type HcnPlan = HcnInWindowPlan | HcnOutOfWindowPlan;

function inWindow(tier: HcnTier, from: number): HcnInWindowPlan {
  const firstCheckAt = from + tier.slaHours * HOUR;
  const retryAt = Array.from(
    { length: HCN_RETRIES },
    (_, index) => firstCheckAt + (index + 1) * HCN_RETRY_EVERY_MS,
  );
  return {
    kind: 'in-window',
    priority: tier.priority,
    firstCheckAt,
    retryAt,
    ticketAt: firstCheckAt + HCN_RETRIES * HCN_RETRY_EVERY_MS,
  };
}

/**
 * `hcnPlan(bookedAt, checkInInstant)` de 04 §8.3. `W = checkInAt − bookedAt`; todos los tiempos se
 * miden desde `bookedAt`. Una reserva hecha el mismo día de entrada (W negativo) es P0.
 */
export function hcnPlan(bookedAt: number, checkInAt: number): HcnPlan {
  const distance = checkInAt - bookedAt;
  const tier = HCN_TIERS.find((t) => distance < t.belowHours * HOUR);
  if (tier === undefined) {
    return { kind: 'out-of-window', windowEntryAt: checkInAt - HCN_WINDOW_MS };
  }
  return inWindow(tier, bookedAt);
}

/**
 * El plan de una reserva que acaba de entrar en ventana: P5 contado desde la entrada (PV-38). No
 * pasa por `hcnPlan`: con `[a, b)`, `W = 720 h` justo en la entrada seguiría fuera de ventana.
 */
export function hcnPlanAtWindowEntry(windowEntryAt: number): HcnInWindowPlan {
  return inWindow(P5, windowEntryAt);
}

// ───────────────────────── El check-in (PV-36) ─────────────────────────

export interface HcnCheckIn {
  /** Las 00:00 del día de entrada en la hora del hotel. */
  readonly checkInAt: number;
  /**
   * Desde cuándo el check-in "ya pasó" y el seguimiento se corta: cuando termina el día de entrada
   * en la hora del hotel. No en `checkInAt`: una reserva hecha ese mismo día es P0 y el huésped
   * todavía no llegó.
   */
  readonly endsAt: number;
  readonly clock: 'hotel-time-zone' | 'utc';
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** El reloj de pared de la zona, o `undefined` si la zona no existe. */
function zoneClock(timeZone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return undefined;
  }
}

/** Cuánto adelanta la zona a UTC en ese instante. */
function offsetAt(clock: Intl.DateTimeFormat, epochMs: number): number {
  const v: Record<string, string> = {};
  for (const part of clock.formatToParts(epochMs)) v[part.type] = part.value;
  const local = Date.UTC(
    Number(v['year']),
    Number(v['month']) - 1,
    Number(v['day']),
    Number(v['hour']),
    Number(v['minute']),
    Number(v['second']),
  );
  return local - Math.floor(epochMs / 1000) * 1000;
}

/** Las 00:00 locales del día cuyo 00:00 UTC es `utcMidnight`. */
function zonedMidnight(clock: Intl.DateTimeFormat, utcMidnight: number): number {
  // Segunda vuelta con el desplazamiento del instante estimado: corrige un cambio de horario
  // entre las 00:00 UTC y las 00:00 locales.
  const guess = offsetAt(clock, utcMidnight);
  return utcMidnight - offsetAt(clock, utcMidnight - guess);
}

/**
 * El check-in de `orders.search_criteria.checkinDate` (`YYYY-MM-DD`). `timeZone` es la zona IANA
 * del hotel; hoy el catálogo no la tiene (05 §9.6) y se usan las 00:00 UTC. `undefined` si la
 * fecha no es una fecha real.
 */
export function hcnCheckIn(checkinDate: string, timeZone?: string): HcnCheckIn | undefined {
  const match = ISO_DATE.exec(checkinDate);
  if (match === null) return undefined;
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // `Date.UTC` acepta el 31 de febrero y lo corre al 3 de marzo: una fecha así no es la del hotel.
  if (new Date(utcMidnight).toISOString().slice(0, 10) !== checkinDate) return undefined;

  const clock = timeZone === undefined ? undefined : zoneClock(timeZone);
  if (clock === undefined) {
    return {
      checkInAt: utcMidnight,
      endsAt: utcMidnight + DAY + LATEST_OFFSET_MS,
      clock: 'utc',
    };
  }
  return {
    checkInAt: zonedMidnight(clock, utcMidnight),
    endsAt: zonedMidnight(clock, utcMidnight + DAY),
    clock: 'hotel-time-zone',
  };
}

// ───────────────────────── Abrir el plan ─────────────────────────

/** Lo que se escribe en la fila de seguimiento al abrir el plan de una orden confirmada. */
export type HcnOpening =
  | { readonly state: 'scheduled'; readonly priority: HcnPriority; readonly nextAt: number }
  /** `nextAt` es la entrada en ventana: la despierta el barrido, sin job. */
  | { readonly state: 'out-of-window'; readonly priority: null; readonly nextAt: number }
  /** El check-in ya pasó: no hay nada que seguir. */
  | { readonly state: 'stopped'; readonly priority: null; readonly nextAt: null };

export interface HcnOpeningFacts {
  /** Epoch ms de la reserva: `orders.created_at`. */
  readonly bookedAt: number;
  readonly checkIn: HcnCheckIn;
  readonly now: number;
}

/**
 * El plan de una orden recién confirmada, o de una que el barrido encontró sin plan. Una lectura
 * que ya venció queda con su hora en el pasado: sale enseguida.
 */
export function openHcnTracking(facts: HcnOpeningFacts): HcnOpening {
  if (facts.now >= facts.checkIn.endsAt) return { state: 'stopped', priority: null, nextAt: null };
  const plan = hcnPlan(facts.bookedAt, facts.checkIn.checkInAt);
  if (plan.kind === 'in-window') {
    return { state: 'scheduled', priority: plan.priority, nextAt: plan.firstCheckAt };
  }
  if (plan.windowEntryAt > facts.now) {
    return { state: 'out-of-window', priority: null, nextAt: plan.windowEntryAt };
  }
  const entered = hcnPlanAtWindowEntry(plan.windowEntryAt);
  return { state: 'scheduled', priority: entered.priority, nextAt: entered.firstCheckAt };
}

/** ¿El plan nació fuera de ventana? Entonces no hay ticket automático (PV-38). */
export function hcnBornOutOfWindow(bookedAt: number, checkIn: HcnCheckIn): boolean {
  return hcnPlan(bookedAt, checkIn.checkInAt).kind === 'out-of-window';
}

// ───────────────────────── Antes de leer ─────────────────────────

/** Lo que el seguimiento hace con una lectura que tocó, antes de llamar al proveedor. */
export type HcnGate =
  | { readonly kind: 'read' }
  /** Se corta: la orden ya no está viva, o el día de entrada terminó. */
  | { readonly kind: 'stop'; readonly reason: 'order-closed' | 'check-in-passed' }
  /**
   * Otro proceso tiene la orden (una cancelación en curso la deja `pending`): no se lee ni se gasta
   * un intento. Si la cancelación termina, ella corta el seguimiento; si se rechaza, la orden vuelve
   * a `confirmed` y el plan sigue.
   */
  | { readonly kind: 'pause'; readonly until: number };

export interface HcnGateFacts {
  readonly status: OrderStatus;
  readonly now: number;
  /** `undefined` = no se sabe cuándo es el check-in: no se corta por fecha. */
  readonly endsAt: number | undefined;
}

export function hcnGate(facts: HcnGateFacts): HcnGate {
  if (facts.status === 'cancelled' || facts.status === 'failed') {
    return { kind: 'stop', reason: 'order-closed' };
  }
  if (facts.endsAt !== undefined && facts.now >= facts.endsAt) {
    return { kind: 'stop', reason: 'check-in-passed' };
  }
  if (facts.status === 'pending') return { kind: 'pause', until: facts.now + HCN_RETRY_EVERY_MS };
  return { kind: 'read' };
}

/** ¿El job sigue siendo la lectura que toca? Uno viejo, repetido o adelantado no lee nada. */
export function hcnCheckIsCurrent(
  tracking: {
    readonly state: HcnState | null;
    readonly attempts: number;
    readonly nextAt: number | null;
  },
  attempt: number,
  now: number,
): boolean {
  return (
    tracking.state === 'scheduled' &&
    tracking.attempts === attempt &&
    tracking.nextAt !== null &&
    tracking.nextAt <= now + HCN_EARLY_TOLERANCE_MS
  );
}

// ───────────────────────── Después de leer ─────────────────────────

/** Por qué el HCN quedó sin llegar. Vocabulario cerrado: va al evento y a la tarea. */
export type HcnMissingReason =
  /** SLA y los tres reintentos agotados (p. 43). */
  | 'sla-exhausted'
  /** La reserva no se puede leer nunca (pedido o respuesta que no se entienden, proveedor sin lectura). */
  | 'read-unavailable'
  /** La cuenta que hizo la reserva ya no está disponible para el tenant (RF-29; D-TBO-28 A). */
  | 'account-changed';

export type HcnReadDecision =
  /** Llegó: se guarda y el seguimiento termina. */
  | { readonly kind: 'received'; readonly plan: HotelOrderPlan }
  /** La lectura la ve cancelada o cancelándose: no va a haber HCN. */
  | { readonly kind: 'stop'; readonly plan: HotelOrderPlan }
  /** Todavía sin HCN: otra lectura a `at`. No es un error y no lanza (04 §8.5). */
  | { readonly kind: 'next'; readonly plan: HotelOrderPlan; readonly at: number }
  /** Se deja de preguntar: evento y, salvo PV-38, tarea de operaciones (D-TBO-27 A). */
  | {
      readonly kind: 'missing';
      readonly reason: HcnMissingReason;
      readonly ticket: boolean;
      /** Lo que dejó la última lectura; ausente si no se pudo leer. */
      readonly plan?: HotelOrderPlan;
    }
  /** Fallo de transporte con reintentos de la cola por delante: que la cola lo repita. */
  | { readonly kind: 'retry' }
  /**
   * La lectura no se hizo y no cuenta como intento: la fila queda vencida y el barrido la retoma.
   * `escalate` sólo una vez por job.
   */
  | {
      readonly kind: 'unavailable';
      readonly reason: 'verification-unavailable' | 'provider-account-issue';
      readonly escalate: boolean;
    };

export interface HcnReadFacts {
  /** La orden y su seguimiento cuando se decidió leer. */
  readonly order: HotelOrderSnapshot;
  readonly read: HotelVerificationRead;
  /** Lecturas hechas antes de ésta. */
  readonly attempt: number;
  /** El plan nació fuera de ventana (PV-38). */
  readonly bornOutOfWindow: boolean;
  readonly now: number;
  readonly runner: 'job' | 'sweep';
  /** Es el último intento que la cola le da a este job. */
  readonly finalAttempt: boolean;
}

/**
 * Qué hacer con una lectura del plan. Lo que la lectura dice de la reserva (estado, voucher, HCN,
 * divergencias) lo decide la tabla de 04 §6.3 con la fuente `hcn`, que nunca mueve `orders.status`;
 * aquí sólo se decide qué pasa con el seguimiento.
 */
export function decideHcnRead(facts: HcnReadFacts): HcnReadDecision {
  const { read } = facts;

  if (read.kind === 'account-changed') {
    return { kind: 'missing', reason: 'account-changed', ticket: true };
  }
  if (read.kind === 'failed') {
    switch (read.error) {
      case 'permanent':
        return { kind: 'missing', reason: 'read-unavailable', ticket: true };
      case 'account':
        return {
          kind: 'unavailable',
          reason: 'provider-account-issue',
          escalate: facts.runner === 'job',
        };
      case 'transient':
        if (facts.runner === 'job' && !facts.finalAttempt) return { kind: 'retry' };
        return { kind: 'unavailable', reason: 'verification-unavailable', escalate: false };
    }
  }

  const plan = planHotelOrderObservation(facts.order, {
    kind: 'read',
    source: 'hcn',
    read: read.view,
  });
  if (plan.hcn?.markReceived === true) return { kind: 'received', plan };
  const status = read.view.status;
  if (read.view.found && (status === 'CANCELLED' || status === 'CANCELLATION_IN_PROGRESS')) {
    return { kind: 'stop', plan };
  }
  if (facts.attempt + 1 < HCN_READS) {
    return { kind: 'next', plan, at: facts.now + HCN_RETRY_EVERY_MS };
  }
  return { kind: 'missing', reason: 'sla-exhausted', ticket: !facts.bornOutOfWindow, plan };
}
