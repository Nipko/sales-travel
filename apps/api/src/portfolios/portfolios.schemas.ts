import { z } from '@sales-travel/validation';
import { MONEY_EXPONENT, currencyExponent, isIsoCurrency } from './wallet-currency.js';

/**
 * Los bordes de las carteras: lo que manda la agencia (Cartera B2B) y lo que manda quien la
 * financia (Gestión de Agencias o Mi Red → nodo → Carteras).
 *
 * Los montos van en unidades MENORES de la moneda de la cartera (ver wallet-currency.ts), enteros y
 * acotados: 10^12 es un tope de cordura que ninguna operación real alcanza y que frena un cero de
 * más antes de que llegue a la base.
 */
export const MAX_WALLET_AMOUNT_MINOR = 1_000_000_000_000;

/** En minúsculas, como lo devuelve Postgres: el mismo id en mayúsculas no encontraría su fila. */
const Uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

export const TenantIdParamSchema = Uuid;
export const PortfolioIdParamSchema = Uuid;
export const DepositReportIdParamSchema = Uuid;
export const OrderIdParamSchema = Uuid;

/**
 * La cabecera `Idempotency-Key`: un UUID que el cliente genera por movimiento y reenvía si no sabe
 * si el primero llegó.
 */
export const IdempotencyKeySchema = z
  .string({ required_error: 'la cabecera Idempotency-Key es obligatoria (un UUID)' })
  .uuid('la cabecera Idempotency-Key tiene que ser un UUID')
  .transform((v) => v.toLowerCase());

/** Un código ISO 4217 en circulación, normalizado a mayúsculas. */
export const IsoCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isIsoCurrency, { message: 'no es un código de moneda ISO 4217 vigente' });

/** Una moneda en la que se puede habilitar una cartera: ISO 4217 y con centésimos. */
export const WalletCurrencySchema = IsoCurrencySchema.superRefine((code, ctx) => {
  const exponent = currencyExponent(code);
  if (exponent !== undefined && exponent !== MONEY_EXPONENT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `${code} usa ${exponent} decimales y las reservas se cobran en centésimos: todavía no se ` +
        'puede operar una cartera en esa moneda',
    });
  }
});

const AmountMinor = z
  .number({ invalid_type_error: 'el monto va en unidades menores, como número entero' })
  .int('el monto va en unidades menores, sin decimales')
  .max(MAX_WALLET_AMOUNT_MINOR, 'el monto supera el máximo que admite una cartera');

const PositiveAmountMinor = AmountMinor.positive('el monto tiene que ser mayor que cero');

const CreditLimitMinor = AmountMinor.nonnegative('el cupo no puede ser negativo');

/**
 * El motivo de quien financia: obligatorio en todo lo que mueve plata o crédito, porque es lo que
 * explica el movimiento en la auditoría. Entre 3 y 500 caracteres, como la columna de 0052.
 */
const Reason = z
  .string({ required_error: 'el motivo es obligatorio' })
  .trim()
  .min(3, 'el motivo es obligatorio (al menos 3 caracteres)')
  .max(500, 'el motivo admite hasta 500 caracteres');

/** Opcional: vacío o sólo espacios es "sin texto" (`null`), no un texto en blanco. */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `admite hasta ${max} caracteres`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

// ─────────────────────────── Quien financia ───────────────────────────

/** Habilitar una moneda: abre la cartera, con su cupo inicial (0 si no se dice). */
export const EnableWalletSchema = z
  .object({
    currency: WalletCurrencySchema,
    creditLimitMinor: CreditLimitMinor.default(0),
    reason: Reason,
  })
  .strict();
export type EnableWalletDto = z.infer<typeof EnableWalletSchema>;

/** Fijar el cupo o suspender y reactivar una cartera. Al menos uno de los dos. */
export const UpdateWalletSchema = z
  .object({
    creditLimitMinor: CreditLimitMinor.optional(),
    status: z.enum(['active', 'suspended']).optional(),
    reason: Reason,
  })
  .strict()
  .refine((v) => v.creditLimitMinor !== undefined || v.status !== undefined, {
    message: 'indicá el cupo o el estado que querés fijar',
  });
export type UpdateWalletDto = z.infer<typeof UpdateWalletSchema>;

/** Un depósito que quien financia ya verificó (transferencia, consignación). */
export const RecordDepositSchema = z
  .object({
    amountMinor: PositiveAmountMinor,
    reason: Reason,
  })
  .strict();
export type RecordDepositDto = z.infer<typeof RecordDepositSchema>;

/** Un ajuste con signo: positivo acredita, negativo debita (un reintegro, una corrección). */
export const RecordAdjustmentSchema = z
  .object({
    amountMinor: AmountMinor.min(-MAX_WALLET_AMOUNT_MINOR, 'el monto supera el máximo').refine(
      (v) => v !== 0,
      'un ajuste de cero no mueve nada',
    ),
    reason: Reason,
  })
  .strict();
export type RecordAdjustmentDto = z.infer<typeof RecordAdjustmentSchema>;

export const ApproveDepositReportSchema = z
  .object({ reason: OptionalText(500) })
  .strict()
  .default({});
export type ApproveDepositReportDto = z.infer<typeof ApproveDepositReportSchema>;

export const RejectDepositReportSchema = z.object({ reason: Reason }).strict();
export type RejectDepositReportDto = z.infer<typeof RejectDepositReportSchema>;

// ─────────────────────────── La agencia ───────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Un día de margen: la agencia puede estar en otra zona horaria que el servidor. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` de un día que existe y que no es futuro. */
const DepositDate = z
  .string()
  .regex(DATE_RE, 'la fecha va como AAAA-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'la fecha no existe en el calendario')
  .refine(
    (v) => new Date(`${v}T00:00:00Z`).getTime() <= Date.now() + FUTURE_TOLERANCE_MS,
    'la fecha del depósito no puede ser futura',
  );

/**
 * La agencia informa que depositó. Queda pendiente hasta que quien la financia lo verifica contra
 * su banco. La referencia (número de la transferencia o de la consignación) es lo que permite
 * conciliarlo, por eso es obligatoria.
 */
export const SubmitDepositReportSchema = z
  .object({
    currency: IsoCurrencySchema,
    amountMinor: PositiveAmountMinor,
    reference: z
      .string({ required_error: 'indicá la referencia del depósito' })
      .trim()
      .min(1, 'indicá la referencia del depósito')
      .max(100, 'la referencia admite hasta 100 caracteres'),
    depositedOn: DepositDate.nullable()
      .optional()
      .transform((v) => v ?? null),
    notes: OptionalText(500),
  })
  .strict();
export type SubmitDepositReportDto = z.infer<typeof SubmitDepositReportSchema>;

export const TransactionsQuerySchema = z.object({ currency: IsoCurrencySchema.optional() });
export type TransactionsQuery = z.infer<typeof TransactionsQuerySchema>;

/**
 * Las reservas de la red retenidas en las carteras del nodo (0060): por moneda y por estado. Sin
 * `.strict()`, como los demás filtros de listado.
 */
export const NetworkHoldsQuerySchema = z.object({
  currency: IsoCurrencySchema.optional(),
  status: z.enum(['held', 'captured', 'released', 'conflict']).optional(),
});
export type NetworkHoldsQuery = z.infer<typeof NetworkHoldsQuerySchema>;

export const DepositReportsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
export type DepositReportsQuery = z.infer<typeof DepositReportsQuerySchema>;

/**
 * Retener saldo por una reserva confirmada (vuelos y autos). Monto y moneda son sólo el control de
 * que la pantalla no quedó vieja: el débito sale de la orden. Sin `.strict()`, como antes de Zod: un
 * cliente de vuelos o autos que mande un campo de más no deja de retener.
 */
export const HoldBookingSchema = z.object({
  orderId: Uuid,
  amountMinor: PositiveAmountMinor.optional(),
  currency: IsoCurrencySchema.optional(),
});
export type HoldBookingDto = z.infer<typeof HoldBookingSchema>;
