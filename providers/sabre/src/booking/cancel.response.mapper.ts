import type { OrderCancelResult } from '@sales-travel/domain';
import { z } from 'zod';
import { SABRE_CANCEL_DEFAULT_POLICY, type SabreCancelErrorPolicy } from './cancel.request.builder';
import { mapSabreGetBookingForDisplay, type SabreBookingSnapshot } from './get.response.mapper';

/**
 * Mapper de `CancelBookingResponse` (`booking-management-v1.yml:440-487`) — RF-10.
 *
 * ## No hay campo booleano de éxito, y el HTTP tampoco lo dice
 *
 * Las tres operaciones declaran **una sola** respuesta, `200` (`:58-62`, `:184-188`, `:233-237`):
 * no hay 4xx en el contrato. Una cancelación **exitosa** puede devolver un cuerpo cuyo único
 * contenido sea el eco de la request. El criterio es del fabricante, palabra por palabra:
 * _"Errors and warnings (if applicable). If not present (empty or contains warnings only) then
 * execution is successful"_ (`help-documentation-cancel-booking.txt`).
 *
 * ## La colisión con el clasificador de sobres — RESUELTA, y cómo
 *
 * Hubo un cruce real: `classifySabreEnvelope` trataba **cualquier** nodo bajo `errors` como
 * severidad error, así que un cuerpo de cancelación con `errors: [{category: 'WARNING', …}]`
 * —que el fabricante declara ÉXITO— salía `ok: false` y `SabreHttpClient.postJson` lanzaba antes
 * de que este mapper viera nada. Como `SabreApiError` sólo conserva un resumen redactado,
 * `voidedTickets[]` y `flightRefunds[]` se perdían.
 *
 * Lo cierra `SABRE_PARTIAL_OUTCOME_CONTRACTS` en `errors.ts`: una segunda pregunta, más estrecha,
 * que sólo se hace cuando la regla dura ya dijo que no, y sólo para las operaciones cuyo contrato
 * declara ese desenlace. Para cancelación exige que **todo** el fallo viva en el `errors` de la
 * raíz y que cada entrada declare `category` Y `type` — con eso, un entitlement o un error de
 * servidor dentro de ese mismo array siguen siendo `SabreApiError`, con su breaker y su alerta.
 * Las 6 ramas de este mapper son alcanzables por `postJson` y hay test de cada una, incluido el
 * ejemplo oficial de `NO_ITEMS_CANCELLED`.
 */

/** `Value.amount` / `TotalValues.*` — patrón `^[0-9]+(\.[0-9]{1,3})?$` (`:4095-4111`, `:8299-8325`). */
const DECIMAL_AMOUNT = /^[0-9]+(\.[0-9]{1,3})?$/;

/**
 * Divisas cuyo exponente **no es 2** y que aparecen en nuestros mercados o en el material de
 * Sabre. La lista es corta a propósito: no es una tabla ISO 4217 completa, es lo que evita
 * multiplicar por 100 un peso chileno (0 decimales) o un dinar (3).
 *
 * `packages/canonical/src/money.ts` trabaja en unidades menores y su helper `fromMajor` asume
 * ×100 sobre un `number`; aquí no se usa, porque el importe llega como **string decimal** y
 * `parseFloat` sobre dinero es exactamente el error que 05 §3.6 prohíbe.
 */
export const SABRE_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  CLP: 0,
  PYG: 0,
  JPY: 0,
  KRW: 0,
  VND: 0,
  ISK: 0,
  XOF: 0,
  XAF: 0,
  XPF: 0,
  BIF: 0,
  DJF: 0,
  GNF: 0,
  KMF: 0,
  RWF: 0,
  UGX: 0,
  VUV: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
});

export const SABRE_DEFAULT_CURRENCY_EXPONENT = 2;

export function sabreCurrencyExponent(currency: string): number {
  return SABRE_CURRENCY_EXPONENTS[currency] ?? SABRE_DEFAULT_CURRENCY_EXPONENT;
}

/** Código de aviso de mapeo. Estable, sin valores del proveedor. */
export type SabreCancelWarningCode =
  | 'refund-amount-not-representable'
  | 'refund-currency-mixed'
  | 'refund-amount-malformed'
  | 'ticket-estimate-only'
  | 'provider-warning'
  | 'provider-error'
  | 'partial-cancel-under-halt-policy'
  | 'remaining-booking-unmappable';

/**
 * Qué pasó de verdad con la cancelación.
 *
 *  - `CANCELLED` — sin errores ni warnings que obliguen a nada. Éxito.
 *  - `ALREADY_CANCELLED` — la reserva ya estaba cancelada (`BOOKING_ALREADY_CANCELED`). **Es el
 *    mismo estado final que `CANCELLED`**, y por eso también cuenta como éxito: cancelar dos veces
 *    no puede dar dos resultados distintos. Lo que cambia es que la segunda vez no se reembolsa
 *    nada, y eso se ve en `refunds` vacío.
 *  - `PARTIALLY_CANCELLED` — parte del contenido no se canceló. **No es éxito** (RF-10 CA-1): un
 *    `UNABLE_TO_CANCEL` con `category: WARNING` es un fallo parcial, no un aviso. El fabricante
 *    dice que esa forma sólo aparece bajo `ALLOW_PARTIAL_CANCEL` —bajo `HALT_ON_ERROR` el mismo
 *    `type` llega como `CANCELLATION_ERROR`—, pero la clasificación **no depende de esa promesa**:
 *    si llegara con `HALT_ON_ERROR`, tratarlo como aviso convertiría una cancelación a medias en
 *    un éxito. Se clasifica igual en los dos modos y, cuando la política era `HALT_ON_ERROR`, se
 *    añade además `partial-cancel-under-halt-policy`, porque entonces el proveedor contradijo su
 *    propia promesa de rollback y eso hay que verlo.
 *  - `NOTHING_CANCELLED` — `NO_ITEMS_CANCELLED`: el rollback de `HALT_ON_ERROR` dejó la reserva
 *    como estaba. No es éxito, pero tampoco deja estado ambiguo.
 *  - `UNVERIFIED` — se mandó y no se pudo confirmar (`END_TRANSACTION_PROBLEM` y compañía).
 *    **Prohibido reintentar la escritura**: hay que releer con `getBooking` y comparar.
 *  - `FAILED` — error no ambiguo. Bajo `HALT_ON_ERROR` hubo rollback y el estado es el original.
 */
export type SabreCancelOutcome =
  | 'CANCELLED'
  | 'ALREADY_CANCELLED'
  | 'PARTIALLY_CANCELLED'
  | 'NOTHING_CANCELLED'
  | 'UNVERIFIED'
  | 'FAILED';

/** Un problema del proveedor, **sin su texto libre**: `description` puede arrastrar nombres. */
export interface SabreCancelIssue {
  readonly category: string;
  readonly type: string;
  /** Ruta del campo señalado, cuando la hay. Es estructura, no valor. */
  readonly fieldPath?: string;
}

export interface SabreCancelRefund {
  readonly airlineCode?: string;
  /** Localizador en el sistema de la aerolínea que emitió el reembolso (`FlightRefund`, `:4148`). */
  readonly confirmationId?: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** El decimal exacto tal como llegó. Se conserva para auditoría: el minor es una conversión. */
  readonly rawAmount: string;
}

/** Estimación de reembolsabilidad por billete. **No es dinero movido.** */
export interface SabreCancelRefundEstimate {
  readonly ticketNumber?: string;
  readonly isVoidable?: boolean;
  readonly isRefundable?: boolean;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly rawAmount?: string;
}

export interface SabreCancelResult {
  readonly outcome: SabreCancelOutcome;
  /** `true` sólo en `CANCELLED` y `ALREADY_CANCELLED`. Ver {@link SabreCancelOutcome}. */
  readonly success: boolean;
  readonly voidedTickets: readonly string[];
  readonly refundedTickets: readonly string[];
  /**
   * Dinero **efectivamente reembolsado**, de `flightRefunds[]` (`:471-476`, _"Lists all
   * successfully refunded flight bookings"_).
   */
  readonly refunds: readonly SabreCancelRefund[];
  /**
   * Estimaciones de `tickets[]` (`:456-460`, _"cancellation eligibility and refundable amounts"_;
   * y `PenaltyItem`: _"Estimates assume the highest possible refund penalty is applied"_).
   *
   * Van SEPARADAS de `refunds` a propósito. Sumar las dos listas duplicaría el importe de cada
   * billete reembolsado: una dice lo que se podría recuperar y la otra lo que se recuperó.
   */
  readonly estimates: readonly SabreCancelRefundEstimate[];
  /** Lo que quedó vivo, si se pidió `retrieveBooking: true`. */
  readonly remaining?: SabreBookingSnapshot;
  readonly errors: readonly SabreCancelIssue[];
  readonly warnings: readonly SabreCancelIssue[];
  readonly mapWarnings: readonly SabreCancelWarningCode[];
}

/** La respuesta no encaja con el contrato. Lleva **rutas de Zod, nunca valores**. */
export class SabreCancelMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(`respuesta de cancelBooking fuera de contrato (${issuePaths.join(', ') || '<root>'})`);
    this.name = 'SabreCancelMappingError';
  }
}

// ---------------------------------------------------------------------------------------------
// Vocabulario de errores que decide el outcome
// ---------------------------------------------------------------------------------------------

/**
 * La categoría que el fabricante declara como "no es fallo" (05 §9.1). Se compara por `category`
 * y **nunca por `type`**: `UNABLE_TO_CANCEL` sale como `CANCELLATION_ERROR` bajo `HALT_ON_ERROR`
 * y como `WARNING` bajo `ALLOW_PARTIAL_CANCEL` (`help-documentation-cancel-booking.txt`,
 * _Dependence between Error Policy and Error Category_). El mismo `type` significa cosas
 * distintas según lo que pedimos.
 */
export const SABRE_WARNING_CATEGORY = 'WARNING';

/**
 * La reserva ya estaba cancelada. Es el eje de la idempotencia: cancelar dos veces tiene que
 * producir el mismo resultado de dominio que la primera, no un fallo nuevo.
 * `BOOKING_ALREADY_CANCELED` — `help-documentation-cancel-booking-error-list.txt:403-407`.
 */
export const SABRE_ALREADY_CANCELLED_TYPES: ReadonlySet<string> = new Set([
  'BOOKING_ALREADY_CANCELED',
]);

/**
 * "Se mandó y no puedo confirmarlo". La operación **probablemente sí ocurrió**, así que reintentar
 * la escritura duplica el efecto: hay que releer con `getBooking` (05 §9.4).
 */
export const SABRE_UNVERIFIED_TYPES: ReadonlySet<string> = new Set([
  'END_TRANSACTION_PROBLEM',
  'UNABLE_TO_RETRIEVE_BOOKING',
  'UNABLE_TO_RETRIEVE_BOOKING_WARNING',
  'UNABLE_TO_CONFIRM_MODIFICATION_STATUS',
  'SYSTEM_SLOW_DOWN',
  'TIMEOUT',
  'INTERNAL_SERVER_TIMEOUT',
  'INTERNAL_PROCESSING_TIMEOUT',
]);

/** Nada se canceló y hubo rollback. `NO_ITEMS_CANCELLED` — error-list:298-303. */
export const SABRE_NOTHING_CANCELLED_TYPES: ReadonlySet<string> = new Set(['NO_ITEMS_CANCELLED']);

/**
 * Bajo `ALLOW_PARTIAL_CANCEL` estos llegan como `WARNING` y significan que **algo no se canceló**.
 * Los `*_PROBLEM` son los errores reescritos de los servicios internos de Sabre (05 §9.5).
 */
export const SABRE_PARTIAL_FAILURE_TYPES: ReadonlySet<string> = new Set([
  'UNABLE_TO_CANCEL',
  'UNABLE_TO_VOID_TICKET',
  'UNABLE_TO_REFUND_BOOKING',
  'UNABLE_TO_PRICE_REFUND',
  'OTA_CANCEL_PROBLEM',
  'CSL_CANCEL_PROBLEM',
  'NDC_CANCEL_PROBLEM',
  'AIR_PRICE_PROBLEM',
  'NDC_RESHOP_PROBLEM',
]);

// ---------------------------------------------------------------------------------------------
// Zod en el borde
// ---------------------------------------------------------------------------------------------

const TicketNumberSchema = z.string().regex(/^[0-9A-Z/-]+$/);

const TotalValuesSchema = z.object({
  /** `GenericTotalValues` declara `total` y `currencyCode` como `required` (`:8299-8325`). */
  total: z.string().optional(),
  subtotal: z.string().optional(),
  taxes: z.string().optional(),
  fees: z.string().optional(),
  currencyCode: z.string().optional(),
});

const IssueSchema = z.object({
  category: z.string().optional(),
  type: z.string().optional(),
  fieldPath: z.string().optional(),
});

export const SabreCancelBookingResponseSchema = z.object({
  timestamp: z.string().optional(),
  booking: z.unknown().optional(),
  tickets: z
    .array(
      z.object({
        number: z.string().optional(),
        isVoidable: z.boolean().optional(),
        isRefundable: z.boolean().optional(),
        refundTotals: TotalValuesSchema.optional(),
      }),
    )
    .optional(),
  errors: z.array(IssueSchema).optional(),
  voidedTickets: z.array(z.string()).optional(),
  refundedTickets: z.array(z.string()).optional(),
  flightRefunds: z
    .array(
      z.object({
        airlineCode: z.string().optional(),
        confirmationId: z.string().optional(),
        refundTotals: TotalValuesSchema.optional(),
      }),
    )
    .optional(),
});

export type SabreCancelBookingResponse = z.infer<typeof SabreCancelBookingResponseSchema>;

export interface SabreCancelMapContext {
  /**
   * La política que se **pidió**. Decide cómo se lee un `UNABLE_TO_CANCEL` con
   * `category: WARNING`: bajo `ALLOW_PARTIAL_CANCEL` es fallo parcial, bajo `HALT_ON_ERROR` ese
   * mismo caso ya habría llegado como `CANCELLATION_ERROR`.
   */
  readonly requestedPolicy?: SabreCancelErrorPolicy;
}

/**
 * Decimal en string → unidades menores, **exacto**, sin `parseFloat` y sin aritmética de coma
 * flotante en ningún punto. `'66.00'` PLN → `6600`; `'66'` CLP → `66` (exponente 0);
 * `'12.345'` KWD → `12345` (exponente 3).
 *
 * Devuelve `undefined` cuando el importe no se puede representar sin perder dígitos —más
 * decimales de los que la divisa admite y no son ceros—. **No se redondea dinero en silencio**:
 * quien llama emite un aviso y deja el importe fuera, que es visible; redondear no lo es.
 */
export function parseSabreDecimalToMinor(amount: string, currency: string): number | undefined {
  if (!DECIMAL_AMOUNT.test(amount)) return undefined;
  const exponent = sabreCurrencyExponent(currency);
  const [whole = '0', fraction = ''] = amount.split('.');

  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) return undefined;

  const scaled = fraction.slice(0, exponent).padEnd(exponent, '0');
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(scaled === '' ? '0' : scaled);
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(minor);
}

const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

function issueOf(raw: z.infer<typeof IssueSchema>): SabreCancelIssue {
  return {
    category: raw.category ?? 'UNKNOWN',
    type: raw.type ?? 'UNKNOWN',
    ...(raw.fieldPath === undefined ? {} : { fieldPath: raw.fieldPath }),
  };
}

function addWarning(sink: SabreCancelWarningCode[], code: SabreCancelWarningCode): void {
  if (!sink.includes(code)) sink.push(code);
}

function resolveOutcome(
  errors: readonly SabreCancelIssue[],
  warnings: readonly SabreCancelIssue[],
): SabreCancelOutcome {
  if (errors.length > 0) {
    // Idempotencia: si lo ÚNICO que falló es que ya estaba cancelada, el estado final es el
    // mismo que buscábamos. Tratarlo como fallo nuevo haría que el segundo intento del saga
    // contradijese al primero, que es justo lo que no puede pasar.
    const onlyAlready = errors.every((issue) => SABRE_ALREADY_CANCELLED_TYPES.has(issue.type));
    return onlyAlready ? 'ALREADY_CANCELLED' : 'FAILED';
  }

  if (warnings.some((issue) => SABRE_UNVERIFIED_TYPES.has(issue.type))) return 'UNVERIFIED';
  if (warnings.some((issue) => SABRE_NOTHING_CANCELLED_TYPES.has(issue.type))) {
    return 'NOTHING_CANCELLED';
  }
  if (warnings.some((issue) => SABRE_ALREADY_CANCELLED_TYPES.has(issue.type))) {
    return 'ALREADY_CANCELLED';
  }
  if (warnings.some((issue) => SABRE_PARTIAL_FAILURE_TYPES.has(issue.type))) {
    return 'PARTIALLY_CANCELLED';
  }
  return 'CANCELLED';
}

const SUCCESSFUL_OUTCOMES: ReadonlySet<SabreCancelOutcome> = new Set<SabreCancelOutcome>([
  'CANCELLED',
  'ALREADY_CANCELLED',
]);

export function mapSabreCancelResponse(
  raw: unknown,
  ctx: SabreCancelMapContext = {},
): SabreCancelResult {
  const parsed = SabreCancelBookingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreCancelMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }
  const response = parsed.data;
  const policy = ctx.requestedPolicy ?? SABRE_CANCEL_DEFAULT_POLICY;
  const mapWarnings: SabreCancelWarningCode[] = [];

  const issues = (response.errors ?? []).map(issueOf);
  const warnings = issues.filter((issue) => issue.category === SABRE_WARNING_CATEGORY);
  const errors = issues.filter((issue) => issue.category !== SABRE_WARNING_CATEGORY);
  if (errors.length > 0) addWarning(mapWarnings, 'provider-error');
  if (warnings.length > 0) addWarning(mapWarnings, 'provider-warning');

  const refunds: SabreCancelRefund[] = [];
  for (const refund of response.flightRefunds ?? []) {
    const amount = refund.refundTotals?.total;
    const currency = CurrencySchema.safeParse(refund.refundTotals?.currencyCode);
    if (amount === undefined || !currency.success) {
      addWarning(mapWarnings, 'refund-amount-malformed');
      continue;
    }
    const amountMinor = parseSabreDecimalToMinor(amount, currency.data);
    if (amountMinor === undefined) {
      addWarning(mapWarnings, 'refund-amount-not-representable');
      continue;
    }
    refunds.push({
      amountMinor,
      currency: currency.data,
      rawAmount: amount,
      ...(refund.airlineCode === undefined ? {} : { airlineCode: refund.airlineCode }),
      ...(refund.confirmationId === undefined ? {} : { confirmationId: refund.confirmationId }),
    });
  }

  const estimates: SabreCancelRefundEstimate[] = [];
  for (const ticket of response.tickets ?? []) {
    const currency = CurrencySchema.safeParse(ticket.refundTotals?.currencyCode);
    const amount = ticket.refundTotals?.total;
    const amountMinor =
      amount !== undefined && currency.success
        ? parseSabreDecimalToMinor(amount, currency.data)
        : undefined;
    estimates.push({
      ...(ticket.number === undefined ? {} : { ticketNumber: ticket.number }),
      ...(ticket.isVoidable === undefined ? {} : { isVoidable: ticket.isVoidable }),
      ...(ticket.isRefundable === undefined ? {} : { isRefundable: ticket.isRefundable }),
      ...(amountMinor === undefined ? {} : { amountMinor }),
      ...(currency.success ? { currency: currency.data } : {}),
      ...(amount === undefined ? {} : { rawAmount: amount }),
    });
  }
  if (estimates.length > 0 && refunds.length === 0) addWarning(mapWarnings, 'ticket-estimate-only');

  const voidedTickets = (response.voidedTickets ?? []).filter(
    (number) => TicketNumberSchema.safeParse(number).success,
  );
  const refundedTickets = (response.refundedTickets ?? []).filter(
    (number) => TicketNumberSchema.safeParse(number).success,
  );

  let remaining: SabreBookingSnapshot | undefined;
  if (response.booking !== undefined) {
    try {
      remaining = mapSabreGetBookingForDisplay(response.booking);
    } catch {
      // Que no se pueda leer lo que quedó vivo no invalida la cancelación: el dato de si se
      // canceló está en `errors[]`, no aquí. Se avisa y se sigue.
      addWarning(mapWarnings, 'remaining-booking-unmappable');
    }
  }

  const outcome = resolveOutcome(errors, warnings);
  if (outcome === 'PARTIALLY_CANCELLED' && policy === 'HALT_ON_ERROR') {
    // Pedimos rollback y llegó un fallo parcial: o el proveedor no cumplió la promesa de
    // `HALT_ON_ERROR`, o alguien mandó otra política que la que dice el contexto. En ambos casos
    // el estado de la reserva no es el que creemos y hay que releerla.
    addWarning(mapWarnings, 'partial-cancel-under-halt-policy');
  }

  return {
    outcome,
    success: SUCCESSFUL_OUTCOMES.has(outcome),
    voidedTickets,
    refundedTickets,
    refunds,
    estimates,
    errors,
    warnings,
    mapWarnings,
    ...(remaining === undefined ? {} : { remaining }),
  };
}

/**
 * Al tipo del puerto (`OrderCancelResult`).
 *
 * `refundAmount` es un único importe y sólo se rellena con dinero **efectivamente reembolsado**
 * (`refunds`, o sea `flightRefunds[]`). Nunca con las estimaciones de `tickets[]`: sumar las dos
 * listas duplicaría el reembolso de cada billete.
 *
 * Si hay reembolsos en más de una divisa **no se suman**: no existe tipo de cambio en este
 * contexto y un total en la divisa equivocada es peor que ningún total. Se deja el campo vacío y
 * se avisa; el detalle por divisa sigue disponible en {@link SabreCancelResult.refunds}.
 */
export function toOrderCancelResult(result: SabreCancelResult): OrderCancelResult {
  const currencies = new Set(result.refunds.map((refund) => refund.currency));
  const warnings = [
    ...result.mapWarnings,
    ...result.warnings.map((issue) => `sabre.${issue.type}`),
    ...(currencies.size > 1 ? ['refund-currency-mixed'] : []),
  ];

  const cancelResult: {
    success: boolean;
    refundAmount?: { amountMinor: number; currency: string };
    warnings: string[];
    error?: string;
  } = { success: result.success, warnings };

  if (currencies.size === 1) {
    const currency = [...currencies][0];
    if (currency !== undefined) {
      cancelResult.refundAmount = {
        amountMinor: result.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0),
        currency,
      };
    }
  }

  if (!result.success) {
    // El `type` es vocabulario cerrado del proveedor y no lleva PII; la `description`, que sí
    // podría llevarla, no se copia nunca.
    const first = result.errors[0] ?? result.warnings[0];
    cancelResult.error = first === undefined ? result.outcome : `${result.outcome}:${first.type}`;
  }

  return cancelResult;
}
