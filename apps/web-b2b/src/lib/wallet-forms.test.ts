import { describe, expect, it } from 'vitest';
import {
  MAX_WALLET_AMOUNT_MINOR,
  approveReportSummary,
  creditLimitSummary,
  depositDateError,
  depositReportHelp,
  enableCurrencyOptions,
  entrySummary,
  initialEnableCurrency,
  minorToInput,
  parseAmountInput,
  reasonError,
  referenceError,
  rejectReportSummary,
  savedMessage,
  todayLocal,
  validateApproveNote,
  validateCreditLimit,
  validateDepositReport,
  validateEnableWallet,
  validateEntry,
  validateReason,
  walletStatusSummary,
} from './wallet-forms';
import type { DepositReport, Wallet } from './wallets';

const USD: Wallet = {
  id: '20000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
  creditLimitMinor: 100_000,
  balanceMinor: 20_000,
  availableMinor: 120_000,
  status: 'active',
  updatedAt: '',
};

const REPORT: DepositReport = {
  id: '30000000-0000-4000-8000-000000000001',
  portfolioId: USD.id,
  currency: 'USD',
  exponent: 2,
  amountMinor: 50_000,
  reference: 'TRX-54223',
  depositedOn: '2026-09-28',
  notes: null,
  status: 'pending',
  reportedByName: 'Ana',
  reportedAt: '2026-09-29T12:00:00.000Z',
  resolvedByName: null,
  resolvedAt: null,
  resolutionReason: null,
};

describe('parseAmountInput — lo que escribe una persona, en unidades menores', () => {
  it.each([
    ['1500000', 150_000_000],
    ['1500000,5', 150_000_050],
    ['1500000.50', 150_000_050],
    [' 1 500 000 ', 150_000_000],
    ['$250', 25_000],
    ['0,01', 1],
  ])('"%s" → %d', (text, minor) => {
    expect(parseAmountInput(text, 2)).toEqual({ ok: true, value: minor });
  });

  it('sin separadores de miles: "1.500.000" y "1.500" no se adivinan', () => {
    expect(parseAmountInput('1.500.000', 2)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sin separadores de miles/),
    });
    expect(parseAmountInput('1.500', 2)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sólo para los centavos/),
    });
  });

  it('una moneda sin centavos no admite decimales', () => {
    expect(parseAmountInput('1500', 0)).toEqual({ ok: true, value: 1500 });
    expect(parseAmountInput('1500,5', 0)).toMatchObject({ ok: false });
  });

  it('vacío, con signo, cero o por encima del tope: error con motivo', () => {
    expect(parseAmountInput('', 2)).toMatchObject({ ok: false, error: 'Indicá el monto.' });
    expect(parseAmountInput('-5', 2)).toMatchObject({ ok: false, error: /sin signo/ });
    expect(parseAmountInput('0', 2)).toMatchObject({ ok: false, error: /mayor que cero/ });
    expect(parseAmountInput('0', 2, { allowZero: true })).toEqual({ ok: true, value: 0 });
    expect(parseAmountInput(String(MAX_WALLET_AMOUNT_MINOR), 2)).toMatchObject({ ok: false });
    expect(parseAmountInput('9'.repeat(40), 2)).toMatchObject({ ok: false, error: /máximo/ });
    expect(parseAmountInput('10000000000', 2)).toEqual({
      ok: true,
      value: MAX_WALLET_AMOUNT_MINOR,
    });
  });

  it('ida y vuelta con minorToInput', () => {
    for (const minor of [0, 1, 150_000_000, 150_000_050, 99]) {
      const text = minorToInput(minor, 2);
      expect(parseAmountInput(text, 2, { allowZero: true })).toEqual({ ok: true, value: minor });
    }
    expect(minorToInput(150_000_050, 2)).toBe('1500000,5');
    expect(minorToInput(1500, 0)).toBe('1500');
  });
});

describe('textos', () => {
  it('el motivo: al menos 3 caracteres y hasta 500', () => {
    expect(reasonError('  ab ')).toMatch(/al menos 3/);
    expect(reasonError('x'.repeat(501))).toMatch(/hasta 500/);
    expect(reasonError('Contrato firmado')).toBeUndefined();
  });

  it('la referencia es obligatoria y corta', () => {
    expect(referenceError(' ')).toMatch(/referencia/);
    expect(referenceError('x'.repeat(101))).toMatch(/100/);
    expect(referenceError('54223')).toBeUndefined();
  });

  it('la fecha del depósito: opcional, real y no futura', () => {
    expect(depositDateError('', '2026-09-29')).toBeUndefined();
    expect(depositDateError('2026-09-29', '2026-09-29')).toBeUndefined();
    expect(depositDateError('2026-09-30', '2026-09-29')).toMatch(/futura/);
    expect(depositDateError('2026-02-30', '2026-09-29')).toMatch(/no existe/);
    expect(depositDateError('29/09/2026', '2026-09-29')).toMatch(/AAAA-MM-DD/);
  });

  it('hoy en la zona del navegador', () => {
    expect(todayLocal(new Date(2026, 8, 5, 23, 59))).toBe('2026-09-05');
  });
});

describe('habilitar una moneda — qué se ofrece y qué se elige', () => {
  const AVAILABLE = ['AED', 'BRL', 'COP', 'EUR', 'MXN', 'USD'];

  it('la moneda del nodo primero, después las frecuentes que falten; el resto aparte', () => {
    expect(enableCurrencyOptions(AVAILABLE, 'MXN')).toEqual({
      featured: ['MXN', 'USD', 'COP', 'BRL'],
      others: ['AED', 'EUR'],
    });
    // COP ya tiene cartera: no se ofrece ni se repite.
    expect(enableCurrencyOptions(['AED', 'USD'], 'COP')).toEqual({
      featured: ['USD'],
      others: ['AED'],
    });
    expect(enableCurrencyOptions(['AED'], '')).toEqual({ featured: [], others: ['AED'] });
  });

  it('elige la moneda del nodo si le falta; si no, ninguna (nunca la primera del alfabeto)', () => {
    expect(initialEnableCurrency(AVAILABLE, 'COP')).toBe('COP');
    expect(initialEnableCurrency(['AED', 'USD'], 'COP')).toBe('');
    expect(initialEnableCurrency(AVAILABLE, '')).toBe('');
    expect(
      validateEnableWallet({ currency: '', creditLimit: '', reason: 'Contrato' }, AVAILABLE),
    ).toMatchObject({ ok: false, errors: { currency: expect.any(String) } });
  });
});

describe('validaciones de quien financia', () => {
  it('habilitar: una moneda ofrecida, cupo opcional y motivo', () => {
    expect(
      validateEnableWallet({ currency: 'USD', creditLimit: '', reason: 'Contrato' }, ['USD']),
    ).toEqual({ ok: true, value: { currency: 'USD', creditLimitMinor: 0, reason: 'Contrato' } });
    expect(
      validateEnableWallet({ currency: 'USD', creditLimit: '5000', reason: ' Contrato ' }, ['USD']),
    ).toMatchObject({ ok: true, value: { creditLimitMinor: 500_000, reason: 'Contrato' } });
    const bad = validateEnableWallet({ currency: 'EUR', creditLimit: '1.500', reason: '' }, [
      'USD',
    ]);
    expect(bad.ok ? {} : bad.errors).toEqual({
      currency: expect.any(String),
      creditLimit: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('cupo: el nuevo, distinto del actual, con motivo', () => {
    expect(validateCreditLimit({ creditLimit: '2000', reason: 'Aumento' }, USD)).toEqual({
      ok: true,
      value: { creditLimitMinor: 200_000, reason: 'Aumento' },
    });
    const same = validateCreditLimit({ creditLimit: '1000', reason: 'Aumento' }, USD);
    expect(same.ok ? '' : same.errors.creditLimit).toMatch(/ya tiene/);
    expect(validateCreditLimit({ creditLimit: '0', reason: 'Sin crédito' }, USD).ok).toBe(true);
  });

  it('depósito siempre suma; el ajuste suma o resta según la dirección', () => {
    expect(
      validateEntry('deposit', { direction: 'debit', amount: '100', reason: 'Transf' }, USD),
    ).toEqual({
      ok: true,
      value: { amountMinor: 10_000, reason: 'Transf' },
    });
    expect(
      validateEntry('adjustment', { direction: 'debit', amount: '100', reason: 'Cargo' }, USD),
    ).toMatchObject({ ok: true, value: { amountMinor: -10_000 } });
    expect(
      validateEntry('adjustment', { direction: 'credit', amount: '0', reason: 'x' }, USD).ok,
    ).toBe(false);
  });

  it('rechazar exige motivo; aprobar admite un comentario vacío', () => {
    expect(validateReason('no')).toMatchObject({ ok: false });
    expect(validateReason(' No llegó ')).toEqual({ ok: true, value: { reason: 'No llegó' } });
    expect(validateApproveNote('  ')).toEqual({ ok: true, value: { reason: null } });
    expect(validateApproveNote('x'.repeat(501)).ok).toBe(false);
  });
});

describe('validateDepositReport — lo que informa la agencia', () => {
  const wallets = [USD, { ...USD, id: 'x', currency: 'COP' }];

  it('arma el cuerpo del API con lo opcional en null', () => {
    expect(
      validateDepositReport(
        { currency: 'USD', amount: '500', reference: ' 54223 ', depositedOn: '', notes: ' ' },
        wallets,
        '2026-09-29',
      ),
    ).toEqual({
      ok: true,
      value: {
        currency: 'USD',
        amountMinor: 50_000,
        reference: '54223',
        depositedOn: null,
        notes: null,
      },
    });
  });

  it('una moneda sin cartera, sin referencia o con fecha futura no se manda', () => {
    const res = validateDepositReport(
      { currency: 'EUR', amount: '', reference: '', depositedOn: '2026-10-01', notes: '' },
      wallets,
      '2026-09-29',
    );
    expect(res.ok ? {} : Object.keys(res.errors).sort()).toEqual([
      'amount',
      'currency',
      'depositedOn',
      'reference',
    ]);
  });
});

describe('confirmaciones', () => {
  it('un depósito muestra el saldo antes y después', () => {
    const s = entrySummary('deposit', USD, 'Agencia Sur', 50_000);
    expect(s.description).toMatch(/acreditar US\$\s?500 en la cartera USD de Agencia Sur/);
    expect(s.lines.find((l) => l.label === 'Saldo')?.value).toMatch(/200 → US\$\s?700/);
    expect(s.warning).toBeUndefined();
    expect(s.destructive).toBe(false);
  });

  it('un débito que deja el disponible negativo lo advierte y se confirma como destructivo', () => {
    const s = entrySummary('adjustment', USD, 'Agencia Sur', -150_000);
    expect(s.confirmLabel).toMatch(/^Debitar/);
    expect(s.destructive).toBe(true);
    expect(s.warning).toMatch(/no podrá reservar en USD/);
  });

  it('el cupo: antes y después, y el aviso si deja el disponible negativo', () => {
    const debtor = { ...USD, balanceMinor: -50_000, availableMinor: 50_000 };
    expect(creditLimitSummary(debtor, 'Agencia Sur', 200_000).warning).toBeUndefined();
    const s = creditLimitSummary(debtor, 'Agencia Sur', 0);
    expect(s.lines[0]?.value).toMatch(/1000 → US\$\s?0|1\.000 → US\$\s?0/);
    expect(s.warning).toMatch(/no podrá reservar/);
    expect(s.destructive).toBe(true);
  });

  it('suspender explica qué se corta; reactivar, qué vuelve', () => {
    expect(walletStatusSummary(USD, 'Agencia Sur', 'suspended')).toMatchObject({
      destructive: true,
      confirmLabel: 'Suspender cartera',
    });
    expect(walletStatusSummary(USD, 'Agencia Sur', 'active').description).toMatch(
      /vuelve a poder reservar en USD/,
    );
  });

  it('aprobar dice cuánto se acredita; rechazar, que no se acredita nada', () => {
    expect(approveReportSummary(REPORT, 'Agencia Sur').confirmLabel).toMatch(
      /Aprobar y acreditar US\$\s?500/,
    );
    expect(rejectReportSummary(REPORT, 'Agencia Sur')).toMatchObject({
      destructive: true,
      description: expect.stringMatching(/No se acredita nada/),
    });
  });

  it('los avisos de guardado nombran el nodo y la moneda', () => {
    expect(savedMessage('enable', 'Agencia Sur', 'USD')).toBe(
      'Agencia Sur ya tiene cartera en USD.',
    );
    expect(savedMessage('reject', 'Agencia Sur', 'USD')).toMatch(/ve el motivo/);
  });

  it('la ayuda del informe nombra a quien financia, o a Planetour', () => {
    expect(depositReportHelp('Consolidador Andino')).toMatch(/hasta que Consolidador Andino/);
    expect(depositReportHelp(null)).toMatch(/hasta que Planetour/);
  });
});
