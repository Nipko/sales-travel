import { describe, expect, it } from 'vitest';
import { optionalBoolean, optionalInteger, optionalNumber, optionalString, toList } from './coerce';

describe('optionalString', () => {
  it('deja pasar el texto y convierte números finitos (HotelCode llega de las dos formas)', () => {
    expect(optionalString('1120548')).toBe('1120548');
    expect(optionalString(1120548)).toBe('1120548');
    expect(optionalString('')).toBe('');
  });

  it.each<[unknown]>([[null], [undefined], [Number.NaN], [true], [{}], [['a']]])(
    '%j → undefined',
    (value) => {
      expect(optionalString(value)).toBeUndefined();
    },
  );
});

describe('optionalInteger', () => {
  it('acepta enteros como número o como string de dígitos (Status.Code, Index)', () => {
    expect(optionalInteger(200)).toBe(200);
    expect(optionalInteger('201')).toBe(201);
    expect(optionalInteger('-3')).toBe(-3);
    expect(optionalInteger(23.0)).toBe(23);
  });

  it.each<[unknown]>([
    ['23.0'],
    [' 1'],
    ['1e3'],
    [1.5],
    ['9007199254740993'],
    [Number.MAX_SAFE_INTEGER + 1],
    [''],
    [null],
    [false],
  ])('%j → undefined', (value) => {
    expect(optionalInteger(value)).toBeUndefined();
  });
});

describe('optionalNumber', () => {
  it('acepta número o string decimal (HotelRating "4" o 4, p. 62 y 67)', () => {
    expect(optionalNumber(4)).toBe(4);
    expect(optionalNumber('4')).toBe(4);
    expect(optionalNumber('25.2048')).toBe(25.2048);
    expect(optionalNumber('-55.27')).toBe(-55.27);
  });

  it.each<[unknown]>([
    ['4 stars'],
    ['FourStar'],
    ['1,5'],
    ['1.'],
    [''],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
  ])('%j → undefined', (value) => {
    expect(optionalNumber(value)).toBeUndefined();
  });
});

describe('optionalBoolean', () => {
  it('acepta booleanos y su texto sin distinguir mayúsculas', () => {
    expect(optionalBoolean(true)).toBe(true);
    expect(optionalBoolean(false)).toBe(false);
    expect(optionalBoolean('TRUE')).toBe(true);
    expect(optionalBoolean('False')).toBe(false);
  });

  it('no adivina: lo demás es undefined y no false', () => {
    // `VoucherStatus` se declara Boolean con "Possible Value; Confirm, Voucher" (p. 45): tratar
    // "Confirm" como false sería inventar un estado de reserva.
    for (const value of ['Confirm', 'Yes', '1', '0', 1, 0, '', null, undefined]) {
      expect(optionalBoolean(value)).toBeUndefined();
    }
  });
});

describe('toList', () => {
  it('un array queda igual y un objeto suelto pasa a lista de uno (BookingDetail, p. 63-64)', () => {
    const row = { ConfirmationNo: 'ABC123' };
    expect(toList([row])).toEqual([row]);
    expect(toList(row)).toEqual([row]);
  });

  it('ausente es lista vacía', () => {
    expect(toList(undefined)).toEqual([]);
    expect(toList(null)).toEqual([]);
  });

  it('un escalar es una forma inválida, distinta de "no hay nada"', () => {
    expect(toList('ABC123')).toBeUndefined();
    expect(toList(3)).toBeUndefined();
  });
});
