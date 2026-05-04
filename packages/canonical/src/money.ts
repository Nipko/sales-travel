import { CurrencyCodeSchema, z } from '@sales-travel/validation';

/**
 * Dinero en unidades menores (centavos). Evita binary float arithmetic.
 * Ej: USD 12.34 → { amountMinor: 1234, currency: 'USD' }
 */
export const MoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: CurrencyCodeSchema,
});
export type Money = z.infer<typeof MoneySchema>;

/** Helpers — sin clase, para que sean fáciles de tree-shake. */
export const Money = {
  zero: (currency: string): Money => ({ amountMinor: 0, currency }),

  add: (a: Money, b: Money): Money => {
    if (a.currency !== b.currency) {
      throw new Error(`Money.add: currency mismatch ${a.currency} vs ${b.currency}`);
    }
    return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
  },

  sub: (a: Money, b: Money): Money => {
    if (a.currency !== b.currency) {
      throw new Error(`Money.sub: currency mismatch ${a.currency} vs ${b.currency}`);
    }
    if (b.amountMinor > a.amountMinor) {
      throw new Error('Money.sub: result would be negative');
    }
    return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
  },

  mul: (a: Money, factor: number): Money => {
    if (!Number.isFinite(factor) || factor < 0) {
      throw new Error(`Money.mul: factor must be a non-negative finite number, got ${factor}`);
    }
    return { amountMinor: Math.round(a.amountMinor * factor), currency: a.currency };
  },

  fromMajor: (amountMajor: number, currency: string): Money => {
    if (!Number.isFinite(amountMajor) || amountMajor < 0) {
      throw new Error(`Money.fromMajor: amount must be non-negative finite, got ${amountMajor}`);
    }
    return { amountMinor: Math.round(amountMajor * 100), currency };
  },

  toMajor: (m: Money): number => m.amountMinor / 100,
};
