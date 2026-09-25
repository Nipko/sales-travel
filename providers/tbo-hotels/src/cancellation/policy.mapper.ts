import type {
  HotelCancellation,
  HotelCancellationRule,
  HotelCancellationStatus,
} from '@sales-travel/canonical';
import { decimalToMinor, toMinorUnits } from '../internal/decimal';
import { parseTboCancelPolicyDate } from '../internal/tbo-date';

/**
 * `CancelPolicies` + `IsRefundable` → cancelación neutral (docs/tbo/02 §9.6; 08 RF-11).
 *
 * Lo comparten Search (con `IsDetailedResponse: true`, políticas indicativas) y PreBook (finales,
 * KP-3, p. 71): por eso vive fuera de `search/` y recibe el origen como dato.
 *
 * Reglas que no se negocian:
 *
 * - **`IsRefundable` y los tramos se guardan sin derivar uno del otro** (C-24, Q-26). En p. 50 hay un
 *   `IsRefundable: false` con dos tramos `Fixed 0.00` antes del 100 %. Se guarda lo que TBO dijo.
 * - **Nunca `fully_refundable` sin haber visto los tramos**: un listado sin detalle sólo sabe si la
 *   tarifa es reembolsable, y "cancelación gratuita" sin tramos sería inventarla (RF-11 CA-1).
 * - **`FromDate` es hora local del hotel, sin offset** (Q-24): se guarda el literal y el valor
 *   parseado. Pasarlo a un instante exige inventar la zona.
 * - **Un `ChargeType` desconocido cuenta como 100 %**: el "etc." de p. 14 deja la lista abierta, y
 *   el error menos dañino es avisar de más.
 */

/** Forma de un tramo tal como la valida el esquema de respuesta de cada operación. */
export interface TboCancelPolicyInput {
  readonly Index?: string | number | null | undefined;
  readonly FromDate: string;
  readonly ChargeType: string;
  readonly CancellationCharge: number | string;
}

/** Search con detalle da políticas indicativas; PreBook, las finales (KP-3). */
export type TboPolicySource = 'search-indicative' | 'prebook-final';

export interface TboCancellationInput {
  /** Ausente se lee como `false`: es lo conservador (02 §9.9). */
  readonly isRefundable: boolean | null | undefined;
  readonly policies: readonly TboCancelPolicyInput[] | null | undefined;
  /** Moneda del `HotelResult`: la de un cargo `Fixed`, que el contrato no declara (Q-24). */
  readonly currency: string;
  /** Habitaciones del pack: un `Index` fuera de rango atribuiría un cargo a una que no existe. */
  readonly roomCount: number;
  readonly source: TboPolicySource;
}

export type TboCancellationMapping =
  | {
      readonly ok: true;
      readonly cancellation: HotelCancellation;
      /** Tramos con un `ChargeType` fuera de `Fixed`/`Percentage`: se miden. */
      readonly unknownChargeTypes: number;
      /** Algún importe traía más decimales que su moneda y se redondeó. */
      readonly precisionLoss: boolean;
    }
  | {
      readonly ok: false;
      /** `ruta:código`, nunca valores. */
      readonly issues: readonly string[];
    };

/** Techos de `packages/canonical/src/hotel-offer.ts`. */
const TYPE_MAX = 40;
const DATE_RAW_MAX = 40;

type ChargeKind = 'fixed' | 'percentage' | 'unknown';

function chargeKind(chargeType: string): ChargeKind {
  const normalized = chargeType.trim().toLowerCase();
  if (normalized === 'fixed') return 'fixed';
  if (normalized === 'percentage') return 'percentage';
  return 'unknown';
}

/**
 * `Index` es String en la tabla y no aparece en ningún ejemplo (p. 14). Se acepta número o texto
 * de dígitos, base 1 por analogía con `Supplements` (Q-24). Ausente, vacío o `null`: aplica a toda
 * la reserva.
 */
function readRoomIndex(
  raw: TboCancelPolicyInput['Index'],
  roomCount: number,
): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'string' && raw.trim().length === 0) return { ok: true, value: undefined };
  const value =
    typeof raw === 'number' ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > roomCount) return { ok: false };
  return { ok: true, value };
}

interface MappedRule {
  readonly rule: HotelCancellationRule;
  readonly charged: boolean;
}

type RuleOutcome =
  | { readonly ok: true; readonly mapped: MappedRule; readonly precisionLoss: boolean }
  | { readonly ok: false; readonly issue: string };

function mapRule(
  policy: TboCancelPolicyInput,
  index: number,
  input: TboCancellationInput,
): RuleOutcome {
  const at = `CancelPolicies.${index}`;
  const fromLocalDateTime = parseTboCancelPolicyDate(policy.FromDate);
  if (fromLocalDateTime === undefined) return { ok: false, issue: `${at}.FromDate:invalid_date` };
  const roomIndex = readRoomIndex(policy.Index, input.roomCount);
  if (!roomIndex.ok) return { ok: false, issue: `${at}.Index:out_of_range` };

  const base = {
    type: policy.ChargeType.trim().slice(0, TYPE_MAX),
    fromLocalDateTime,
    fromDateRaw: policy.FromDate.slice(0, DATE_RAW_MAX),
    ...(roomIndex.value === undefined ? {} : { roomIndex: roomIndex.value }),
  };

  const kind = chargeKind(policy.ChargeType);
  if (kind === 'fixed') {
    const amount = toMinorUnits(policy.CancellationCharge, input.currency);
    if (!amount.ok)
      return { ok: false, issue: `${at}.CancellationCharge:${amount.reason.toLowerCase()}` };
    return {
      ok: true,
      mapped: {
        rule: {
          ...base,
          penaltyAmount: { amountMinor: amount.amountMinor, currency: input.currency },
        },
        charged: amount.amountMinor > 0,
      },
      precisionLoss: amount.precisionLoss,
    };
  }

  if (kind === 'percentage') {
    // Centésimas de punto con el mismo decimal exacto que el dinero: `CancellationCharge` llega
    // como `100.0` o `"100.00"` (p. 24, 50) y un float no decide si 33.335 redondea arriba.
    const hundredths = decimalToMinor(policy.CancellationCharge, 2);
    if (!hundredths.ok) {
      return { ok: false, issue: `${at}.CancellationCharge:${hundredths.reason.toLowerCase()}` };
    }
    if (hundredths.amountMinor > 100_00)
      return { ok: false, issue: `${at}.CancellationCharge:too_big` };
    return {
      ok: true,
      mapped: {
        rule: { ...base, penaltyPercentage: hundredths.amountMinor / 100 },
        charged: hundredths.amountMinor > 0,
      },
      precisionLoss: hundredths.precisionLoss,
    };
  }

  // El importe de un tipo desconocido no se sabe interpretar: se valida que sea un decimal para no
  // tragarse basura, pero la penalidad que se promete es la máxima.
  const check = decimalToMinor(policy.CancellationCharge, 2);
  if (!check.ok)
    return { ok: false, issue: `${at}.CancellationCharge:${check.reason.toLowerCase()}` };
  return {
    ok: true,
    mapped: { rule: { ...base, penaltyPercentage: 100 }, charged: true },
    precisionLoss: false,
  };
}

/**
 * Estado y fin de la cancelación gratuita (02 §9.6, traducción al contrato).
 *
 * Los tramos se ordenan por su inicio (la hora local sin zona ordena igual como texto) porque la
 * semántica de TBO es "el tramo vale hasta el `FromDate` del siguiente": un orden que dependiera de
 * cómo llegaron cambiaría qué penalidad rige. El orden es estable, así que dos tramos del mismo
 * instante —de habitaciones distintas— conservan el de TBO.
 */
function summarize(
  refundable: boolean,
  rules: readonly MappedRule[],
): { status: HotelCancellationStatus; freeCancellationUntilLocal: string | undefined } {
  if (!refundable) return { status: 'non_refundable', freeCancellationUntilLocal: undefined };
  const [first] = rules;
  if (first === undefined) {
    return { status: 'partially_refundable', freeCancellationUntilLocal: undefined };
  }
  // Los tramos que arrancan en el mismo instante que el primero —de habitaciones distintas— rigen
  // a la vez: si cualquiera cobra, no hubo ventana gratuita, aunque el orden estable ponga delante
  // uno de cargo 0.
  const start = first.rule.fromLocalDateTime;
  if (rules.some((mapped) => mapped.charged && mapped.rule.fromLocalDateTime === start)) {
    return { status: 'partially_refundable', freeCancellationUntilLocal: undefined };
  }
  // Si ningún tramo cobra, no hay fecha límite que TBO haya dicho: se deja vacía antes que
  // inventar "hasta el check-in".
  const firstCharged = rules.find((mapped) => mapped.charged);
  return {
    status: 'fully_refundable',
    freeCancellationUntilLocal: firstCharged?.rule.fromLocalDateTime,
  };
}

export function mapTboCancellation(input: TboCancellationInput): TboCancellationMapping {
  const refundable = input.isRefundable === true;
  const policies = input.policies ?? [];

  const mapped: MappedRule[] = [];
  const issues: string[] = [];
  let unknownChargeTypes = 0;
  let precisionLoss = false;
  policies.forEach((policy, index) => {
    const outcome = mapRule(policy, index, input);
    if (!outcome.ok) {
      issues.push(outcome.issue);
      return;
    }
    mapped.push(outcome.mapped);
    precisionLoss ||= outcome.precisionLoss;
    if (chargeKind(policy.ChargeType) === 'unknown') unknownChargeTypes += 1;
  });
  // Un tramo ilegible invalida la política entera: mostrar las demás callaría justo la penalidad
  // que no se entendió.
  if (issues.length > 0) return { ok: false, issues };

  // Comparación de código de carácter y no `localeCompare`, que depende del ICU del runtime.
  const ordered = [...mapped].sort((a, b) => {
    const left = a.rule.fromLocalDateTime ?? '';
    const right = b.rule.fromLocalDateTime ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const { status, freeCancellationUntilLocal } = summarize(refundable, ordered);

  return {
    ok: true,
    cancellation: {
      refundable,
      status,
      rules: ordered.map((entry) => entry.rule),
      // Sin tramos, lo único que se sabe es `IsRefundable`: el origen lo dice para que la web no
      // pinte "parcialmente reembolsable" como si hubiera visto una penalidad (02 §9.6).
      policySource: ordered.length === 0 ? 'none' : input.source,
      ...(freeCancellationUntilLocal === undefined ? {} : { freeCancellationUntilLocal }),
    },
    unknownChargeTypes,
    precisionLoss,
  };
}
