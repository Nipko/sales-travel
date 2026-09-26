import { ORDER_EVENTS, publicProviderStatus } from '../orders/order-events.js';
import type { HotelVerificationRead } from './hotel-booking-verification.js';
import {
  planHotelOrderObservation,
  type HotelOrderPlan,
  type HotelOrderSnapshot,
} from './hotel-order-state.js';

/**
 * La verificación de una cancelación de hotel, `verify-cancellation`: **las decisiones, sin I/O**
 * (docs/tbo/09 PR-5.3; 08 RF-25, RF-38; 04 §4.4 punto 6 y §10; D-TBO-25 A).
 *
 * La agenda la cancelación cuando el proveedor la aceptó sin terminarla, cuando su lectura posterior
 * no se pudo hacer o cuando no se sabe si se aplicó (`UNVERIFIED`). Mismo criterio que la
 * verificación del Book (`hotel-booking-verification.ts`): la cola y el barrido sólo despiertan, y
 * lo que decide vive aquí.
 *
 * Reglas que no se negocian:
 *
 *   - **Sólo se lee.** Ninguna rama vuelve a mandar la cancelación (08 §9 C-05): un segundo Cancel
 *     sobre una reserva que el proveedor procesa en diferido es un write doble con dinero.
 *   - **Sólo cierra en la dirección segura** (PV-B): una lectura que la muestra cancelada cierra la
 *     orden; una que la muestra vigente sobre una cancelación sin verificar la deja a una persona.
 *   - **Lo que dice una lectura lo decide la tabla de 04 §6.3** (`planHotelOrderObservation` con la
 *     fuente `verify`); aquí sólo se decide qué pasa con el calendario.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** La primera lectura: dos minutos después de la respuesta de la cancelación. */
export const HOTEL_CANCEL_VERIFY_FIRST_MS = 2 * MIN;

/**
 * Cuándo se lee, contado desde la respuesta de la cancelación: +2 min, +15 min, +1 h, +6 h y +24 h
 * (04 §10). Provisorio: TBO no publica cuánto tarda un hotel en contestar.
 */
export const HOTEL_CANCEL_VERIFY_SCHEDULE_MS: readonly number[] = Object.freeze([
  HOTEL_CANCEL_VERIFY_FIRST_MS,
  15 * MIN,
  HOUR,
  6 * HOUR,
  24 * HOUR,
]);

export const HOTEL_CANCEL_VERIFY_STEPS = HOTEL_CANCEL_VERIFY_SCHEDULE_MS.length;

/**
 * Cuánto después de su hora un paso se da por perdido en la cola: cubre los reintentos del job con
 * margen, y el barrido no pisa un job que sigue vivo. El mismo de la verificación del Book.
 */
export const HOTEL_CANCEL_VERIFY_GRACE_MS = 5 * MIN;

/** Cuántas órdenes de un tenant revisa el barrido por corrida: el resto, en la siguiente. */
export const HOTEL_CANCEL_VERIFY_SWEEP_LIMIT = 25;

/** Instante del paso `step`, o `undefined` si el calendario no tiene ese paso. */
export function cancellationVerifyAt(anchorAt: number, step: number): number | undefined {
  const offset = HOTEL_CANCEL_VERIFY_SCHEDULE_MS[step];
  return offset === undefined ? undefined : anchorAt + offset;
}

/**
 * Qué paso ejecuta el barrido: el de la fila o, si llegó tarde, el último que ya venció. Leer una
 * vez tarde dice lo mismo que las lecturas intermedias que se perdieron.
 */
export function sweepCancellationStep(stored: number, anchorAt: number, now: number): number {
  let step = stored;
  HOTEL_CANCEL_VERIFY_SCHEDULE_MS.forEach((offset, index) => {
    if (index > step && anchorAt + offset <= now) step = index;
  });
  return step;
}

/** El calendario tal como lo guarda la fila de seguimiento (0046). */
export interface HotelCancelVerifyCalendar {
  readonly anchorAt: number | null;
  readonly step: number | null;
  readonly nextAt: number | null;
}

/**
 * ¿El paso del job sigue siendo el de la fila? Un job de un paso que otro camino ya hizo, de un
 * calendario cerrado o de un calendario anterior (una cancelación nueva abre otro) no hace nada.
 */
export function cancellationStepIsCurrent(
  calendar: HotelCancelVerifyCalendar,
  step: number,
  anchorAt: number,
): boolean {
  return calendar.nextAt !== null && calendar.step === step && calendar.anchorAt === anchorAt;
}

/** Por qué una persona tiene que mirar la cancelación, además de lo que decide la tabla. */
export type HotelCancelVerifyEscalation =
  /** El último paso la sigue viendo sin cancelar. */
  | 'cancellation-stuck'
  /** La lectura no se pudo hacer (o no se puede hacer nunca). */
  | 'verification-unavailable'
  /** La cuenta no puede leer: avisar a su dueño. */
  | 'provider-account-issue'
  /** La cuenta que hizo la reserva ya no está disponible para el tenant (RF-29; D-TBO-28 A). */
  | 'provider-account-changed';

export type HotelCancelVerifyDecision =
  /** La ve cancelada: la orden pasa a `cancelled` y el calendario se cierra. */
  | { readonly kind: 'close'; readonly plan: HotelOrderPlan }
  /** Sigue en curso: se registra lo leído y se lee otra vez a la hora del paso siguiente. */
  | {
      readonly kind: 'advance';
      readonly plan: HotelOrderPlan;
      readonly step: number;
      readonly at: number;
    }
  /** Último paso y todavía sin cancelar: se registra, se cierra el calendario y se escala. */
  | { readonly kind: 'stuck'; readonly plan: HotelOrderPlan }
  /**
   * Se registra lo leído y el calendario se cierra: la tabla pidió una persona, o la orden ya no
   * espera una cancelación (un rechazo cuya lectura posterior falló sólo necesitaba una lectura).
   */
  | { readonly kind: 'settle'; readonly plan: HotelOrderPlan }
  /** Fallo de transporte con reintentos de la cola por delante: que la cola lo repita. */
  | { readonly kind: 'retry' }
  /** La lectura no se hizo; el paso queda vencido y el barrido lo vuelve a intentar. */
  | {
      readonly kind: 'unavailable';
      readonly reason: Extract<
        HotelCancelVerifyEscalation,
        'verification-unavailable' | 'provider-account-issue'
      >;
      /** Sólo una vez por job: el barrido no repite el aviso cada 15 minutos. */
      readonly escalate: boolean;
    }
  /** No se va a poder leer: el calendario se cierra y la mira una persona. */
  | {
      readonly kind: 'hold';
      readonly reason: Extract<
        HotelCancelVerifyEscalation,
        'verification-unavailable' | 'provider-account-changed'
      >;
    };

export interface HotelCancelVerifyFacts {
  /** La orden y su seguimiento cuando se leyó para ejecutar el paso. */
  readonly order: HotelOrderSnapshot;
  readonly read: HotelVerificationRead;
  /** El paso que se ejecutó. */
  readonly step: number;
  readonly anchorAt: number;
  readonly runner: 'job' | 'sweep';
  /** Es el último intento que la cola le da a este job. */
  readonly finalAttempt: boolean;
}

const HUMAN_ACTIONS = new Set(['human-review', 'urgent-human-review']);

/**
 * El cierre deja `OrderProviderStatusChanged` aunque la fila no tuviera lectura anterior. La tabla
 * no cuenta la primera lectura como un cambio (y sólo así omite el evento), y el Book no registra
 * la suya en el seguimiento: sin esto, una cancelación sin verificar (o cuya lectura posterior
 * falló) pasaría a `cancelled`, y liberaría la retención, sin un solo evento que lo diga.
 */
function withClosingEvent(order: HotelOrderSnapshot, plan: HotelOrderPlan): HotelOrderPlan {
  if (order.providerStatus !== null || plan.record === undefined) return plan;
  return {
    ...plan,
    events: [
      ...plan.events,
      {
        type: ORDER_EVENTS.providerStatusChanged,
        previous: null,
        current: publicProviderStatus(plan.record.providerStatus, true),
      },
    ],
  };
}

export function decideCancellationVerification(
  facts: HotelCancelVerifyFacts,
): HotelCancelVerifyDecision {
  const { read } = facts;

  if (read.kind === 'account-changed') return { kind: 'hold', reason: 'provider-account-changed' };

  if (read.kind === 'failed') {
    switch (read.error) {
      case 'permanent':
        return { kind: 'hold', reason: 'verification-unavailable' };
      case 'account':
        return {
          kind: 'unavailable',
          reason: 'provider-account-issue',
          escalate: facts.runner === 'job',
        };
      case 'transient':
        if (facts.runner === 'job' && !facts.finalAttempt) return { kind: 'retry' };
        return {
          kind: 'unavailable',
          reason: 'verification-unavailable',
          escalate: facts.runner === 'job',
        };
    }
  }

  const plan = planHotelOrderObservation(facts.order, {
    kind: 'read',
    source: 'verify',
    read: read.view,
  });
  if (plan.orderStatus === 'cancelled') {
    return { kind: 'close', plan: withClosingEvent(facts.order, plan) };
  }
  if (plan.actions.some((action) => HUMAN_ACTIONS.has(action))) return { kind: 'settle', plan };
  if (facts.order.status !== 'pending') return { kind: 'settle', plan };

  const next = facts.step + 1;
  const at = cancellationVerifyAt(facts.anchorAt, next);
  return at === undefined ? { kind: 'stuck', plan } : { kind: 'advance', plan, step: next, at };
}
