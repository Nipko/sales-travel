/**
 * Cuándo vuelve a intentar el barrido una lectura que falló: **la decisión, sin I/O** (HARD-2; la
 * usan la verificación del Book, la de una cancelación y el seguimiento del HCN).
 *
 * Una lectura fallida no prueba nada y no avanza el plan, pero tampoco puede dejar la fila con su
 * hora vieja: cada barrido toma las vencidas de a 25 por tenant, la más atrasada primero, y un grupo
 * que falla siempre (una cuenta bloqueada, un proveedor caído) ocuparía todas las corridas y taparía
 * al resto del tenant. La fila se reprograma:
 *
 * - la espera se mide desde que la lectura tocaba según el plan, así que se duplica con cada corrida
 *   fallida sin guardar un contador;
 * - nunca es menor que una corrida del barrido ni mayor que el techo;
 * - nunca pasa el plazo siguiente del plan: llegado ese momento, el plan ya dice qué leer.
 */

const MIN = 60_000;

/** Una corrida del barrido (`POST_SALE_SWEEP_EVERY_MS`): esperar menos no cambia nada. */
export const SWEEP_RETRY_MIN_MS = 15 * MIN;

/** Aunque siga fallando, una reserva en duda se vuelve a mirar al menos cuatro veces por día. */
export const SWEEP_RETRY_MAX_MS = 6 * 60 * MIN;

export interface SweepRetryFacts {
  readonly now: number;
  /** Cuándo tocaba la lectura según el plan: el ancla del backoff. */
  readonly dueAt: number;
  /** El plazo siguiente del plan, si lo hay. */
  readonly deadline?: number;
  /** Techo propio, cuando la cadencia del plan es más corta que el general. */
  readonly maxWaitMs?: number;
}

export function sweepRetryAt(facts: SweepRetryFacts): number {
  const ceiling = Math.min(SWEEP_RETRY_MAX_MS, facts.maxWaitMs ?? SWEEP_RETRY_MAX_MS);
  const overdue = Math.max(0, facts.now - facts.dueAt);
  const at = facts.now + Math.min(ceiling, Math.max(SWEEP_RETRY_MIN_MS, overdue));
  if (facts.deadline === undefined) return at;
  return Math.max(facts.now, Math.min(at, facts.deadline));
}
