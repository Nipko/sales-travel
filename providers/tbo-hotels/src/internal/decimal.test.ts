import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_MINOR_UNIT_EXPONENT,
  decimalToMinor,
  isSupportedCurrency,
  minorUnitExponent,
  toMinorUnits,
} from './decimal';

describe('toMinorUnits', () => {
  it('"17.22" y 17.22 dan exactamente el mismo importe (08 RF-07 CA-3)', () => {
    // `ExtraGuestCharges` llega como string (p. 17) y el resto de los importes como número.
    expect(toMinorUnits('17.22', 'USD')).toEqual({
      ok: true,
      amountMinor: 1722,
      precisionLoss: false,
    });
    expect(toMinorUnits(17.22, 'USD')).toEqual(toMinorUnits('17.22', 'USD'));
  });

  it('coincide con el importe exacto para todos los centavos de 0 a 100 000, en número y en texto', () => {
    for (let cents = 0; cents <= 100_000; cents += 1) {
      const major = cents / 100;
      const fromNumber = toMinorUnits(major, 'USD');
      const fromText = toMinorUnits(major.toFixed(2), 'USD');
      if (!fromNumber.ok || fromNumber.amountMinor !== cents || fromNumber.precisionLoss) {
        throw new Error(`número ${major} → ${JSON.stringify(fromNumber)}, esperado ${cents}`);
      }
      if (!fromText.ok || fromText.amountMinor !== cents || fromText.precisionLoss) {
        throw new Error(
          `texto ${major.toFixed(2)} → ${JSON.stringify(fromText)}, esperado ${cents}`,
        );
      }
    }
  });

  it.each([
    ['CLP', 0],
    ['JPY', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['CLF', 4],
  ])('rechaza %s, de exponente %i: Money lo escalaría mal', (currency, exponent) => {
    expect(minorUnitExponent(currency)).toBe(exponent);
    expect(isSupportedCurrency(currency)).toBe(false);
    expect(toMinorUnits('25.81', currency)).toEqual({ ok: false, reason: 'UNSUPPORTED_CURRENCY' });
  });

  it('rechaza los códigos sin unidad menor y los mal formados', () => {
    for (const currency of ['XAU', 'XDR', 'XXX', 'usd', 'US', 'USDT', '']) {
      expect(isSupportedCurrency(currency)).toBe(false);
      expect(toMinorUnits('1.00', currency)).toEqual({ ok: false, reason: 'UNSUPPORTED_CURRENCY' });
    }
  });

  it.each(['USD', 'COP', 'PEN', 'BRL', 'EUR', 'AED', 'IDR'])(
    'acepta %s, de exponente 2',
    (currency) => {
      expect(minorUnitExponent(currency)).toBe(SUPPORTED_MINOR_UNIT_EXPONENT);
      expect(isSupportedCurrency(currency)).toBe(true);
    },
  );

  it('IDR con decimales se convierte tal cual (p. 27: "1244728.99")', () => {
    expect(toMinorUnits('1244728.99', 'IDR')).toEqual({
      ok: true,
      amountMinor: 124472899,
      precisionLoss: false,
    });
  });
});

describe('decimalToMinor: redondeo half-up y pérdida de precisión', () => {
  it.each<[string | number, number, boolean]>([
    ['0.125', 13, true],
    ['0.124', 12, true],
    ['0.005', 1, true],
    ['0.0049', 0, true],
    ['0.0051', 1, true],
    ['0.00049', 0, true],
    ['15.15762150', 1516, true], // BasePrice de p. 24, con 8 decimales
    ['124.7564850', 12476, true],
    ['85.822', 8582, true], // 3 decimales en USD, p. 26
    ['85.825', 8583, true],
    ['100', 10000, false],
    ['100.50000', 10050, false], // ceros de más no son pérdida
    ['0.00', 0, false],
    ['-0.00', 0, false],
    [0, 0, false],
    [1.5e-7, 0, true], // String(1.5e-7) es "1.5e-7"
    ['2.5e2', 25000, false],
    ['1E-2', 1, false],
  ])('%s → %i (pérdida %s)', (amount, amountMinor, precisionLoss) => {
    expect(decimalToMinor(amount, 2)).toEqual({ ok: true, amountMinor, precisionLoss });
  });

  it('usa aritmética de enteros: 0.1 + 0.2 no se convierte en 30 exactos', () => {
    // 0.1 + 0.2 === 0.30000000000000004: el decimal existe y tiene cola, que se declara.
    expect(decimalToMinor(0.1 + 0.2, 2)).toEqual({
      ok: true,
      amountMinor: 30,
      precisionLoss: true,
    });
  });

  it('funciona con otros exponentes, para cuando Money los soporte', () => {
    expect(decimalToMinor('1234.5', 0)).toEqual({
      ok: true,
      amountMinor: 1235,
      precisionLoss: true,
    });
    expect(decimalToMinor('25.81', 3)).toEqual({
      ok: true,
      amountMinor: 25810,
      precisionLoss: false,
    });
  });
});

describe('decimalToMinor: lo que no es un importe', () => {
  it.each<[unknown]>([
    ['abc'],
    [''],
    [' 1.00'],
    ['1.00 '],
    ['1,234.00'],
    ['1.'],
    ['.5'],
    ['+1'],
    ['0x10'],
    ['1e'],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
    [true],
    [{}],
    [[1]],
  ])('%j → NOT_A_DECIMAL', (amount) => {
    expect(decimalToMinor(amount, 2)).toEqual({ ok: false, reason: 'NOT_A_DECIMAL' });
  });

  it.each<[unknown]>([['-1.00'], [-1], ['-0.01'], [-0.001]])('%j → NEGATIVE', (amount) => {
    // Un negativo invalida ESE pack y se mide; nunca llega a Money.fromMajor, que lanzaría un
    // Error plano (docs/tbo/02 §8.3 punto 4).
    expect(decimalToMinor(amount, 2)).toEqual({ ok: false, reason: 'NEGATIVE' });
  });

  it('el límite es Number.MAX_SAFE_INTEGER en unidades menores', () => {
    expect(decimalToMinor('90071992547409.91', 2)).toEqual({
      ok: true,
      amountMinor: Number.MAX_SAFE_INTEGER,
      precisionLoss: false,
    });
    expect(decimalToMinor('90071992547409.92', 2)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(decimalToMinor(1e21, 2)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
  });

  it('un exponente desmesurado se rechaza sin construir el número', () => {
    const started = Date.now();
    expect(decimalToMinor('1e999999999', 2)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(decimalToMinor('1e99999999999999999999', 2)).toEqual({
      ok: false,
      reason: 'OUT_OF_RANGE',
    });
    expect(decimalToMinor('1e-999999999', 2)).toEqual({
      ok: true,
      amountMinor: 0,
      precisionLoss: true,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
