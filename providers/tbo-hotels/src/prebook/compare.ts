import type {
  HotelCancellationRule,
  HotelFee,
  HotelRoompack,
  Money,
} from '@sales-travel/canonical';
import type { HotelRateSignal } from '@sales-travel/domain';
import { compareDecimals } from '../internal/decimal';

/**
 * Detección de cambio de precio y de condiciones entre dos lecturas de la misma tarifa (docs/tbo/03
 * §2.9; 08 RF-15 CA-3 y RF-20; D-TBO-20 A).
 *
 * PreBook no trae ningún indicador de cambio ni precio anterior (p. 20-23): la comparación es
 * nuestra, en dos momentos.
 *
 * | Momento | Qué se compara                                                                 | Contra qué                         |
 * | ------- | ------------------------------------------------------------------------------ | ---------------------------------- |
 * | C1      | `TotalFare`, moneda, `IsRefundable`, `MealType` y el conjunto de `AtProperty`  | La tarifa del contexto de búsqueda |
 * | C2      | Lo de C1, más políticas de cancelación, señales críticas y el texto saneado    | El snapshot que aceptó el vendedor |
 *
 * Reglas (03 §2.9):
 *
 * 1. Los importes se comparan como decimales EXACTOS, sin tolerancia, sobre el literal de
 *    `TotalFare`: `305.75` y `305.750` son iguales; `305.75` y `305.76`, no.
 * 2. El resultado es `UNCHANGED`, `DECREASED`, `INCREASED` o `CONDITIONS_CHANGED`; si cambian a la
 *    vez el precio y las condiciones, prevalece `CONDITIONS_CHANGED`. La dirección del precio se
 *    informa igual, porque la pantalla muestra las dos cosas.
 * 3. Una moneda distinta no se "compara": es un cambio de condiciones.
 *
 * Es una función pura sobre tipos neutrales: la usan el servidor para C1 y la saga para C2
 * (PR-4.5). Qué se hace con cada resultado —reconfirmar, avisar, `409`— es del servidor; el evento
 * `HotelOfferRepriced` se arma con {@link TboRepriceComparison}, que no lleva texto del proveedor.
 */

export type TboRepriceStage = 'C1' | 'C2';

export const TBO_REPRICE_OUTCOMES = [
  'UNCHANGED',
  'DECREASED',
  'INCREASED',
  'CONDITIONS_CHANGED',
] as const;
export type TboRepriceOutcome = (typeof TBO_REPRICE_OUTCOMES)[number];

/** Qué condición cambió. Vocabulario cerrado: el evento y la UI razonan por código, no por texto. */
export const TBO_RATE_CONDITION_CHANGES = [
  'CURRENCY',
  'REFUNDABLE',
  'MEAL_TYPE',
  'AT_PROPERTY_CHARGES',
  'CANCEL_POLICIES',
  'SIGNALS',
  'RATE_CONDITIONS',
] as const;
export type TboRateConditionChange = (typeof TBO_RATE_CONDITION_CHANGES)[number];

/** Dirección del precio. `NOT_COMPARABLE` cuando cambió la moneda. */
export type TboPriceDirection = 'SAME' | 'DOWN' | 'UP' | 'NOT_COMPARABLE';

/** Una lectura de la tarifa: la de Search guardada por el servidor o la de un PreBook. */
export interface TboRateSnapshot {
  /**
   * Literal decimal de `TotalFare` (`TboSearchPackContext.totalFare`), nunca reconstruido desde
   * unidades menores: es lo que se compara exacto y lo que viaja al Book.
   */
  readonly totalFare: string;
  readonly roompack: HotelRoompack;
  /** Sólo de un PreBook: señales críticas de `RateConditions`. Entran en C2. */
  readonly signals?: readonly HotelRateSignal[];
  /** Sólo de un PreBook: `tboRateConditionsHash` del texto saneado. Entra en C2. */
  readonly rateConditionsHash?: string;
}

export interface TboRepriceComparison {
  readonly stage: TboRepriceStage;
  readonly outcome: TboRepriceOutcome;
  readonly price: TboPriceDirection;
  /** En el orden de {@link TBO_RATE_CONDITION_CHANGES}. Vacía si sólo cambió el precio. */
  readonly changes: readonly TboRateConditionChange[];
  /** Para el evento `HotelOfferRepriced`: unidades menores y moneda, sin texto del proveedor. */
  readonly previousTotal: Money;
  readonly currentTotal: Money;
}

// ───────────────────────── Piezas ─────────────────────────

function normalizeCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameSortedKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((key, index) => key === b[index]);
}

/** `MealType` sin distinguir mayúsculas ni guiones bajos (02 §9.8); sin literal, el régimen. */
function mealKey(pack: HotelRoompack): string {
  return pack.mealTypeRaw === undefined ? `board:${pack.board}` : normalizeCode(pack.mealTypeRaw);
}

/**
 * Un cargo en el hotel como (`Index`, `Description`, `Price`, `Currency`) de 03 §2.9. El importe va
 * en las unidades menores ISO de SU moneda y, si la moneda no tiene dos decimales, con su literal.
 * Sin `Supplements` y con una lista vacía son lo mismo para el vendedor: no hay nada que pagar.
 */
function feeKeys(fees: readonly HotelFee[] | undefined): string[] {
  return (fees ?? []).map((fee) =>
    [
      fee.roomIndex ?? '*',
      normalizeCode(fee.descriptionRaw ?? fee.description),
      fee.amount.currency,
      fee.amount.amountMinor,
      fee.amountText ?? '',
    ].join('|'),
  );
}

function ruleKey(rule: HotelCancellationRule): string {
  return [
    normalizeCode(rule.type),
    rule.roomIndex ?? '*',
    rule.fromLocalDateTime ?? '',
    rule.fromHours ?? '',
    rule.toHours ?? '',
    rule.penaltyPercentage ?? '',
    rule.penaltyNights ?? '',
    rule.penaltyAmount === undefined
      ? ''
      : `${rule.penaltyAmount.currency}${rule.penaltyAmount.amountMinor}`,
  ].join('|');
}

function priceDirection(previous: TboRateSnapshot, current: TboRateSnapshot): TboPriceDirection {
  const before = previous.roompack.price.total;
  const after = current.roompack.price.total;
  if (before.currency !== after.currency) return 'NOT_COMPARABLE';
  // El literal manda. Sólo si alguno no se puede leer —nunca pasa con lo que emite este paquete—
  // se cae a las unidades menores, que siguen siendo exactas a dos decimales.
  const exact = compareDecimals(current.totalFare, previous.totalFare);
  const order = exact ?? Math.sign(after.amountMinor - before.amountMinor);
  return order === 0 ? 'SAME' : order < 0 ? 'DOWN' : 'UP';
}

function conditionChanges(
  stage: TboRepriceStage,
  previous: TboRateSnapshot,
  current: TboRateSnapshot,
): TboRateConditionChange[] {
  const before = previous.roompack;
  const after = current.roompack;
  const changed = new Set<TboRateConditionChange>();

  if (before.price.total.currency !== after.price.total.currency) changed.add('CURRENCY');
  if (before.cancellation.refundable !== after.cancellation.refundable) changed.add('REFUNDABLE');
  if (mealKey(before) !== mealKey(after)) changed.add('MEAL_TYPE');
  if (!sameSortedKeys(feeKeys(before.atPropertyCharges), feeKeys(after.atPropertyCharges))) {
    changed.add('AT_PROPERTY_CHARGES');
  }

  if (stage === 'C2') {
    if (
      before.cancellation.status !== after.cancellation.status ||
      !sameSortedKeys(before.cancellation.rules.map(ruleKey), after.cancellation.rules.map(ruleKey))
    ) {
      changed.add('CANCEL_POLICIES');
    }
    if (!sameSortedKeys([...(previous.signals ?? [])], [...(current.signals ?? [])])) {
      changed.add('SIGNALS');
    }
    // Sin huella no se puede demostrar que el texto sea el mismo, falte en un lado o en los dos: un
    // servidor que olvidara persistirla no puede convertir C2 en un UNCHANGED que nadie verificó.
    const acceptedHash = previous.rateConditionsHash;
    const currentHash = current.rateConditionsHash;
    if (acceptedHash === undefined || currentHash === undefined || acceptedHash !== currentHash) {
      changed.add('RATE_CONDITIONS');
    }
  }

  return TBO_RATE_CONDITION_CHANGES.filter((change) => changed.has(change));
}

// ───────────────────────── Entrada ─────────────────────────

/**
 * Compara `current` contra `previous`. C1: `previous` es la tarifa de Search guardada en el contexto
 * del servidor y `current`, el PreBook de la pantalla de confirmación. C2: `previous` es el snapshot
 * que aceptó el vendedor y `current`, el PreBook de revalidación justo antes del Book.
 */
export function compareTboRates(
  stage: TboRepriceStage,
  previous: TboRateSnapshot,
  current: TboRateSnapshot,
): TboRepriceComparison {
  const price = priceDirection(previous, current);
  const changes = conditionChanges(stage, previous, current);
  const outcome: TboRepriceOutcome =
    changes.length > 0
      ? 'CONDITIONS_CHANGED'
      : price === 'UP'
        ? 'INCREASED'
        : price === 'DOWN'
          ? 'DECREASED'
          : 'UNCHANGED';
  return {
    stage,
    outcome,
    price,
    changes,
    previousTotal: { ...previous.roompack.price.total },
    currentTotal: { ...current.roompack.price.total },
  };
}
