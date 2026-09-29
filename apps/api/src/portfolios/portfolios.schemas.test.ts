import { describe, expect, it } from 'vitest';
import {
  ApproveDepositReportSchema,
  EnableWalletSchema,
  HoldBookingSchema,
  IdempotencyKeySchema,
  MAX_WALLET_AMOUNT_MINOR,
  RecordAdjustmentSchema,
  RecordDepositSchema,
  RejectDepositReportSchema,
  SubmitDepositReportSchema,
  UpdateWalletSchema,
  WalletCurrencySchema,
} from './portfolios.schemas.js';
import {
  MONEY_EXPONENT,
  currencyExponent,
  isWalletCurrency,
  walletCurrencies,
} from './wallet-currency.js';

/** Los mensajes de un rechazo de Zod, para afirmar sobre el motivo. */
function issues(result: { success: boolean; error?: { issues: { message: string }[] } }): string {
  return result.success ? '' : (result.error?.issues.map((i) => i.message).join(' | ') ?? '');
}

describe('ISO 4217: monedas y exponentes', () => {
  it.each([
    ['COP', 2],
    ['USD', 2],
    ['BRL', 2],
    ['PEN', 2],
    ['CLP', 0],
    ['PYG', 0],
    ['KWD', 3],
  ])('%s tiene exponente %i', (code, exponent) => {
    expect(currencyExponent(code)).toBe(exponent);
  });

  it('no son monedas: un código inventado, un fondo (COU) o un metal (XAU)', () => {
    for (const code of ['ABC', 'COU', 'XAU', 'XXX', 'cop']) {
      expect(currencyExponent(code)).toBeUndefined();
    }
  });

  it('sólo se habilitan carteras en monedas con centésimos, como asume Money', () => {
    expect(MONEY_EXPONENT).toBe(2);
    expect(isWalletCurrency('COP')).toBe(true);
    expect(isWalletCurrency('CLP')).toBe(false);
    expect(isWalletCurrency('KWD')).toBe(false);
  });

  it('la lista para habilitar pone primero la del nodo y el dólar, sin repetir', () => {
    const list = walletCurrencies(['COP', 'USD', 'COP']);
    expect(list.slice(0, 2)).toEqual(['COP', 'USD']);
    expect(new Set(list).size).toBe(list.length);
    expect(list).not.toContain('CLP');
    expect(list).toContain('BRL');
  });
});

describe('WalletCurrencySchema', () => {
  it('normaliza a mayúsculas', () => {
    expect(WalletCurrencySchema.parse(' usd ')).toBe('USD');
  });

  it('rechaza lo que no es ISO 4217 vigente', () => {
    const r = WalletCurrencySchema.safeParse('ABC');
    expect(r.success).toBe(false);
    expect(issues(r)).toContain('ISO 4217');
  });

  it('rechaza una moneda sin centésimos diciendo por qué', () => {
    const r = WalletCurrencySchema.safeParse('CLP');
    expect(r.success).toBe(false);
    expect(issues(r)).toContain('CLP usa 0 decimales');
  });
});

describe('quien financia: bordes', () => {
  it('habilitar una moneda: cupo 0 por defecto y motivo obligatorio', () => {
    expect(EnableWalletSchema.parse({ currency: 'usd', reason: 'Opera en dólares' })).toEqual({
      currency: 'USD',
      creditLimitMinor: 0,
      reason: 'Opera en dólares',
    });
    expect(EnableWalletSchema.safeParse({ currency: 'USD' }).success).toBe(false);
    expect(EnableWalletSchema.safeParse({ currency: 'USD', reason: '  ' }).success).toBe(false);
  });

  it('el cupo es un entero no negativo en unidades menores y con tope', () => {
    for (const creditLimitMinor of [-1, 1.5, MAX_WALLET_AMOUNT_MINOR + 1, '100']) {
      expect(
        EnableWalletSchema.safeParse({ currency: 'USD', creditLimitMinor, reason: 'Cupo' }).success,
      ).toBe(false);
    }
  });

  it('no deja colar campos: ni el saldo ni el tenant van en el cuerpo', () => {
    expect(
      EnableWalletSchema.safeParse({ currency: 'USD', reason: 'Cupo', balanceMinor: 1 }).success,
    ).toBe(false);
  });

  it('actualizar pide el cupo o el estado, y el estado es active o suspended', () => {
    expect(UpdateWalletSchema.safeParse({ reason: 'Nada' }).success).toBe(false);
    expect(
      UpdateWalletSchema.safeParse({ status: 'overlimit', reason: 'x'.repeat(5) }).success,
    ).toBe(false);
    expect(UpdateWalletSchema.parse({ status: 'suspended', reason: 'Mora de 60 días' })).toEqual({
      status: 'suspended',
      reason: 'Mora de 60 días',
    });
  });

  it('un depósito es positivo; un ajuste tiene signo y no es cero', () => {
    expect(RecordDepositSchema.safeParse({ amountMinor: 0, reason: 'Depósito' }).success).toBe(
      false,
    );
    expect(RecordDepositSchema.safeParse({ amountMinor: -1, reason: 'Depósito' }).success).toBe(
      false,
    );
    expect(RecordAdjustmentSchema.parse({ amountMinor: -500, reason: 'Reintegro' })).toEqual({
      amountMinor: -500,
      reason: 'Reintegro',
    });
    expect(RecordAdjustmentSchema.safeParse({ amountMinor: 0, reason: 'Nada' }).success).toBe(
      false,
    );
    expect(
      RecordAdjustmentSchema.safeParse({
        amountMinor: -(MAX_WALLET_AMOUNT_MINOR + 1),
        reason: 'Demasiado',
      }).success,
    ).toBe(false);
  });

  it('aprobar admite un motivo opcional; rechazar lo exige', () => {
    expect(ApproveDepositReportSchema.parse(undefined)).toEqual({ reason: null });
    expect(ApproveDepositReportSchema.parse({ reason: '   ' })).toEqual({ reason: null });
    expect(RejectDepositReportSchema.safeParse({}).success).toBe(false);
    expect(RejectDepositReportSchema.parse({ reason: ' Sin soporte ' })).toEqual({
      reason: 'Sin soporte',
    });
  });

  it('la Idempotency-Key es un UUID, en minúsculas', () => {
    expect(IdempotencyKeySchema.parse('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(IdempotencyKeySchema.safeParse(undefined).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('clave-1').success).toBe(false);
  });
});

describe('la agencia informa un depósito', () => {
  const base = { currency: 'cop', amountMinor: 5_000_000, reference: ' TRX-991 ' };

  it('normaliza moneda y referencia, y lo opcional queda en null', () => {
    expect(SubmitDepositReportSchema.parse(base)).toEqual({
      currency: 'COP',
      amountMinor: 5_000_000,
      reference: 'TRX-991',
      depositedOn: null,
      notes: null,
    });
  });

  it('exige referencia y un monto entero positivo', () => {
    expect(SubmitDepositReportSchema.safeParse({ ...base, reference: '  ' }).success).toBe(false);
    expect(SubmitDepositReportSchema.safeParse({ ...base, amountMinor: 10.5 }).success).toBe(false);
    expect(SubmitDepositReportSchema.safeParse({ ...base, amountMinor: 0 }).success).toBe(false);
  });

  it('la fecha existe y no es futura', () => {
    expect(
      SubmitDepositReportSchema.parse({ ...base, depositedOn: '2026-09-28' }).depositedOn,
    ).toBe('2026-09-28');
    expect(
      SubmitDepositReportSchema.safeParse({ ...base, depositedOn: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      SubmitDepositReportSchema.safeParse({ ...base, depositedOn: '2999-01-01' }).success,
    ).toBe(false);
    expect(
      SubmitDepositReportSchema.safeParse({ ...base, depositedOn: '28/09/2026' }).success,
    ).toBe(false);
  });

  it('no puede elegir a nombre de quién ni en qué cartera: esos campos no entran', () => {
    expect(SubmitDepositReportSchema.safeParse({ ...base, reportedBy: 'x' }).success).toBe(false);
    expect(SubmitDepositReportSchema.safeParse({ ...base, portfolioId: 'x' }).success).toBe(false);
  });
});

describe('HoldBookingSchema (vuelos y autos)', () => {
  const ORDER = '22222222-2222-4222-8222-2222222222AA';

  it('canonicaliza el UUID y la moneda', () => {
    expect(HoldBookingSchema.parse({ orderId: ORDER, currency: ' cop ' })).toEqual({
      orderId: ORDER.toLowerCase(),
      currency: 'COP',
    });
  });

  it.each([
    [{ orderId: 'not-a-uuid' }],
    [{ orderId: ORDER, amountMinor: 0 }],
    [{ orderId: ORDER, amountMinor: 1.5 }],
    [{ orderId: ORDER, currency: 'US' }],
  ])('rechaza un borde inválido: %o', (body) => {
    expect(HoldBookingSchema.safeParse(body).success).toBe(false);
  });
});
