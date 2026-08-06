import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, TotpService } from './totp.service.js';

// Secreto de referencia del RFC 6238 (Appendix B): "12345678901234567890" en ASCII.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

/**
 * Vectores oficiales del RFC 6238 Appendix B (variante SHA1).
 *
 * El RFC los publica con 8 dígitos. Nuestra implementación emite 6, y como
 * 10^6 divide a 10^8, el código de 6 dígitos son exactamente los 6 últimos del de 8
 * (binary % 10^6 === (binary % 10^8) % 10^6). Se listan ambos para dejar la derivación
 * explícita en vez de enterrarla en una constante.
 */
const VECTORS = [
  { unixTime: 59, eightDigit: '94287082' },
  { unixTime: 1111111109, eightDigit: '07081804' },
  { unixTime: 1111111111, eightDigit: '14050471' },
  { unixTime: 1234567890, eightDigit: '89005924' },
  { unixTime: 2000000000, eightDigit: '69279037' },
  { unixTime: 20000000000, eightDigit: '65353130' },
];

describe('TotpService — vectores RFC 6238', () => {
  const totp = new TotpService();

  for (const { unixTime, eightDigit } of VECTORS) {
    const expected = eightDigit.slice(-6);

    it(`genera ${expected} en T=${unixTime}`, () => {
      const step = totp.currentStep(new Date(unixTime * 1000));
      expect(totp.generate(RFC_SECRET, step)).toBe(expected);
    });

    it(`verifica ${expected} en T=${unixTime}`, () => {
      const at = new Date(unixTime * 1000);
      expect(totp.verify(RFC_SECRET, expected, { at })).toBe(totp.currentStep(at));
    });
  }
});

describe('TotpService — base32', () => {
  it('es reversible', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original)).equals(original)).toBe(true);
  });

  it('rechaza caracteres fuera del alfabeto', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow(/invalid base32/);
  });

  it('genera secretos de 160 bits', () => {
    expect(base32Decode(new TotpService().generateSecret())).toHaveLength(20);
  });
});

describe('TotpService — verificación', () => {
  const totp = new TotpService();
  const at = new Date(1111111111 * 1000);

  it('tolera un paso de desfase de reloj en ambos sentidos', () => {
    const step = totp.currentStep(at);
    expect(totp.verify(RFC_SECRET, totp.generate(RFC_SECRET, step - 1), { at })).toBe(step - 1);
    expect(totp.verify(RFC_SECRET, totp.generate(RFC_SECRET, step + 1), { at })).toBe(step + 1);
  });

  it('rechaza dos pasos de desfase', () => {
    const step = totp.currentStep(at);
    expect(totp.verify(RFC_SECRET, totp.generate(RFC_SECRET, step + 2), { at })).toBeNull();
  });

  it('rechaza el replay de un código ya consumido', () => {
    const step = totp.currentStep(at);
    const code = totp.generate(RFC_SECRET, step);
    expect(totp.verify(RFC_SECRET, code, { at })).toBe(step);
    // Segundo intento con el mismo paso ya registrado como usado.
    expect(totp.verify(RFC_SECRET, code, { at, minStep: step })).toBeNull();
  });

  it('rechaza formatos inválidos sin lanzar', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(totp.verify(RFC_SECRET, bad, { at })).toBeNull();
    }
  });

  it('ignora espacios que el usuario pega desde el authenticator', () => {
    const step = totp.currentStep(at);
    const code = totp.generate(RFC_SECRET, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(totp.verify(RFC_SECRET, spaced, { at })).toBe(step);
  });
});
