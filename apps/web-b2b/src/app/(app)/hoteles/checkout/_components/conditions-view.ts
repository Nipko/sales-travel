import type { HotelRoompack } from '../../actions';
import { formatHotelLocalDateTime } from '../../_components/hotel-format';
import {
  ratePolicyView,
  type PolicyTier,
} from '../../[hotelKey]/_components/hotel-rate-detail-view';
import type { HotelPrebookCondition, HotelRateConditionCategory } from './prebook-view';

/*
 * Las condiciones del hotel y la política de cancelación del PreBook, que el proveedor da por
 * finales (docs/tbo/03 §2.4 y §2.5; U-10 y U-11), sin React.
 */

// ───────────────────────── Condiciones del hotel (U-11) ─────────────────────────

const CATEGORY_ORDER: readonly HotelRateConditionCategory[] = [
  'checkIn',
  'checkOut',
  'minCheckInAge',
  'mandatoryFees',
  'optionalFees',
  'cardsAccepted',
  'specialInstructions',
  'other',
];

const CATEGORY_LABELS: Readonly<Record<HotelRateConditionCategory, string>> = {
  checkIn: 'Check-in',
  checkOut: 'Check-out',
  minCheckInAge: 'Edad mínima para el check-in',
  mandatoryFees: 'Cargos obligatorios',
  optionalFees: 'Cargos opcionales',
  cardsAccepted: 'Tarjetas que acepta el hotel',
  specialInstructions: 'Instrucciones especiales',
  other: 'Otras condiciones',
};

export interface ConditionGroup {
  readonly category: HotelRateConditionCategory;
  readonly label: string;
  /** Texto plano completo, con sus saltos de línea: se pinta como texto, nunca como HTML. */
  readonly items: readonly string[];
}

/**
 * Las condiciones agrupadas por categoría, en un orden fijo que empieza por lo que el huésped
 * necesita al llegar. El texto va completo (U-11): la clasificación del API es una ayuda para
 * ubicarlo, no un resumen. Sólo se descartan los vacíos y las repeticiones exactas dentro de un
 * grupo, que no agregan nada.
 */
export function conditionGroups(conditions: readonly HotelPrebookCondition[]): ConditionGroup[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const items = [
      ...new Set(
        conditions
          .filter((c) => c.category === category)
          .map((c) => c.text.trim())
          .filter((text) => text.length > 0),
      ),
    ];
    return items.length === 0 ? [] : [{ category, label: CATEGORY_LABELS[category], items }];
  });
}

// ───────────────────────── Política de cancelación (U-10) ─────────────────────────

export interface CancelPolicyView {
  /** La política en una frase: hasta cuándo sin cargo o que no es reembolsable. */
  readonly headline: string;
  readonly refundable: boolean;
  /** Sólo el PreBook la da por definitiva. */
  readonly final: boolean;
  /**
   * Los tramos, cada uno con su penalidad estimada en el precio de VENTA cuando se puede calcular.
   * Nunca el importe neto del proveedor (G3).
   */
  readonly tiers: readonly PolicyTier[];
  /** Algún tramo o la fecha sin cargo están en hora local del hotel, que el proveedor no zonifica. */
  readonly hotelLocalTime: boolean;
  readonly hasEstimates: boolean;
  /** Notas del proveedor sobre la política, como texto. */
  readonly notes?: string;
}

/**
 * La política de cancelación como se muestra antes de reservar: con qué se cancela sin cargo, los
 * tramos con su fecha en la hora del hotel y lo que costaría cancelar en cada uno.
 */
export function cancelPolicyView(
  pack: Pick<HotelRoompack, 'cancellation' | 'price' | 'pricing'>,
): CancelPolicyView {
  const c = pack.cancellation;
  const policy = ratePolicyView(pack);
  const freeUntil =
    c.refundable && c.freeCancellationUntilLocal
      ? formatHotelLocalDateTime(c.freeCancellationUntilLocal)
      : undefined;
  const headline = !c.refundable
    ? 'No reembolsable.'
    : freeUntil
      ? `Cancelación sin cargo hasta el ${freeUntil}.`
      : c.policySource === 'none'
        ? 'Reembolsable. El proveedor no informó los plazos.'
        : 'Reembolsable con cargo según la fecha de cancelación.';
  const tiers = policy?.tiers ?? [];
  const notes = policy?.notes;
  return {
    headline,
    refundable: c.refundable,
    final: c.policySource === 'prebook-final',
    tiers,
    hotelLocalTime: freeUntil !== undefined || (policy?.hotelLocalTime ?? false),
    hasEstimates: tiers.some((t) => t.approx !== undefined),
    ...(notes ? { notes } : {}),
  };
}
