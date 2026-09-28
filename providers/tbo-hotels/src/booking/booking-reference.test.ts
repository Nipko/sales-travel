import { describe, expect, it } from 'vitest';
import { TboConfigError } from '../errors';
import {
  TBO_BOOKING_REFERENCE_ALPHABET,
  TBO_BOOKING_REFERENCE_PATTERN,
  generateTboBookingReference,
  isTboBookingReference,
  isTboConfirmationNumber,
  tboBookingReferenceEnvironment,
  type TboRandomBytes,
} from './booking-reference';

/**
 * El generador de `BookingReferenceId` (docs/tbo/03 §3.3; 08 RF-19 CA-1, BK-03): las propiedades
 * que hacen que una referencia identifique UN Book sin ambigüedad entre todos los tenants que
 * comparten la cuenta del consolidador.
 */

/** Generador determinista: devuelve exactamente estos bytes. */
function fixed(bytes: readonly number[]): TboRandomBytes {
  return (size) => {
    expect(size).toBe(11);
    return Uint8Array.from(bytes);
  };
}

const ZEROS = Array.from({ length: 11 }, () => 0);
const ONES = Array.from({ length: 11 }, () => 0xff);

describe('forma', () => {
  it('ST + entorno + 17 caracteres Crockford: 20 en total', () => {
    const reference = generateTboBookingReference('test');
    expect(reference).toHaveLength(20);
    expect(reference).toMatch(/^STT[0-9A-HJKMNP-TV-Z]{17}$/);
    expect(TBO_BOOKING_REFERENCE_PATTERN.test(reference)).toBe(true);
  });

  it('el carácter de entorno es T en test y P en producción', () => {
    expect(generateTboBookingReference('test').charAt(2)).toBe('T');
    expect(generateTboBookingReference('live').charAt(2)).toBe('P');
  });

  it('el alfabeto es Crockford: 32 símbolos, sin I, L, O ni U', () => {
    expect(TBO_BOOKING_REFERENCE_ALPHABET).toHaveLength(32);
    expect(new Set(TBO_BOOKING_REFERENCE_ALPHABET).size).toBe(32);
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      expect(TBO_BOOKING_REFERENCE_ALPHABET).not.toContain(forbidden);
    }
    expect(TBO_BOOKING_REFERENCE_ALPHABET).toMatch(/^[0-9A-Z]+$/);
  });

  it('los extremos: todo ceros y todo unos', () => {
    expect(generateTboBookingReference('test', fixed(ZEROS))).toBe('STT00000000000000000');
    expect(generateTboBookingReference('live', fixed(ONES))).toBe('STPZZZZZZZZZZZZZZZZZ');
  });
});

describe('entropía: 85 bits, todos usados', () => {
  it('cambiar cualquiera de los 85 bits altos cambia la referencia', () => {
    const base = generateTboBookingReference('test', fixed(ZEROS));
    const seen = new Set<string>([base]);
    for (let bit = 0; bit < 85; bit += 1) {
      const bytes = [...ZEROS];
      const index = Math.floor(bit / 8);
      bytes[index] = (bytes[index] ?? 0) | (0x80 >> bit % 8);
      const reference = generateTboBookingReference('test', fixed(bytes));
      expect(reference, `bit ${bit}`).not.toBe(base);
      seen.add(reference);
    }
    // Cada bit da una referencia distinta de las otras: ninguno se pisa con otro.
    expect(seen.size).toBe(86);
  });

  it('los 3 bits sobrantes del último byte no cuentan', () => {
    const base = generateTboBookingReference('test', fixed(ZEROS));
    for (const low of [0b001, 0b010, 0b100, 0b111]) {
      const bytes = [...ZEROS];
      bytes[10] = low;
      expect(generateTboBookingReference('test', fixed(bytes))).toBe(base);
    }
  });

  it('con el generador por defecto no se repite en 20 000 referencias', () => {
    const references = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) references.add(generateTboBookingReference('test'));
    expect(references.size).toBe(20_000);
  });

  it('cada posición recorre los 32 símbolos: no hay un carácter fijo escondido', () => {
    const perPosition = Array.from({ length: 17 }, () => new Set<string>());
    for (let i = 0; i < 4_000; i += 1) {
      const body = generateTboBookingReference('live').slice(3);
      [...body].forEach((char, position) => perPosition[position]?.add(char));
    }
    for (const symbols of perPosition) expect(symbols.size).toBe(32);
  });
});

describe('falla cerrado', () => {
  it('un generador que da menos bytes no se completa con ceros', () => {
    expect(() => generateTboBookingReference('test', () => new Uint8Array(10))).toThrow(
      TboConfigError,
    );
  });

  it('un generador que no devuelve bytes no produce nada', () => {
    const broken = (() => [1, 2, 3]) as unknown as TboRandomBytes;
    expect(() => generateTboBookingReference('test', broken)).toThrow(TboConfigError);
  });

  it('un entorno que no es de TBO no se traduce a ningún carácter', () => {
    expect(() => generateTboBookingReference('staging' as never)).toThrow(TboConfigError);
    expect(() => generateTboBookingReference('__proto__' as never)).toThrow(TboConfigError);
  });
});

describe('lectura de referencias', () => {
  it('reconoce sólo las nuestras', () => {
    expect(isTboBookingReference('STP7K2M9QX4D8R1VZ6AB')).toBe(true);
    for (const other of [
      'AVw12118', // ejemplo del PDF (p. 36)
      '742955723103628', // Postman
      'STP7K2M9QX4D8R1VZ6A', // 19
      'STP7K2M9QX4D8R1VZ6ABC', // 21
      'STX7K2M9QX4D8R1VZ6AB', // entorno desconocido
      'STP7K2M9QX4D8R1VZ6AI', // I no es Crockford
      'stp7k2m9qx4d8r1vz6ab', // minúsculas
      '9d3b1a52-4c1f-4d8e-8b1a-0f2e5c7d9a10', // un Idempotency-Key
    ]) {
      expect(isTboBookingReference(other), other).toBe(false);
    }
    expect(isTboBookingReference(undefined)).toBe(false);
  });

  it('dice de qué entorno es', () => {
    expect(tboBookingReferenceEnvironment('STP7K2M9QX4D8R1VZ6AB')).toBe('live');
    expect(tboBookingReferenceEnvironment('STT7K2M9QX4D8R1VZ6AB')).toBe('test');
    expect(tboBookingReferenceEnvironment('AVw12118')).toBeUndefined();
  });

  it('el localizador de TBO: alfanumérico, sin espacios ni puntuación', () => {
    for (const valid of ['FL1IMA', 'YOSUR8', 'KOI5G4', 'ab-12']) {
      expect(isTboConfirmationNumber(valid), valid).toBe(true);
    }
    for (const invalid of ['', ' FL1IMA', 'FL1 IMA', 'FL1IMA;', '-FL1IMA', 'x'.repeat(65), 12]) {
      expect(isTboConfirmationNumber(invalid), String(invalid)).toBe(false);
    }
  });
});
