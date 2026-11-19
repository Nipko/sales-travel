import { describe, expect, it } from 'vitest';
import {
  dialCodeForCountry,
  FALLBACK_DIAL_CODE,
  flightContactPhone,
  normalizeDialCode,
  whatsappDigits,
} from './contact-phone';

describe('dialCodeForCountry', () => {
  it('sale del país de la agencia', () => {
    expect(dialCodeForCountry('CO')).toBe('57');
    expect(dialCodeForCountry('PE')).toBe('51');
    expect(dialCodeForCountry('BR')).toBe('55');
    expect(dialCodeForCountry('pe')).toBe('51');
  });

  it('sin país o con uno fuera de la tabla, queda el de antes a la vista', () => {
    expect(dialCodeForCountry(undefined)).toBe(FALLBACK_DIAL_CODE);
    expect(dialCodeForCountry('')).toBe(FALLBACK_DIAL_CODE);
    expect(dialCodeForCountry('ZZ')).toBe(FALLBACK_DIAL_CODE);
  });
});

describe('normalizeDialCode', () => {
  it('acepta el prefijo con o sin +', () => {
    expect(normalizeDialCode('+51')).toBe('51');
    expect(normalizeDialCode(' 593 ')).toBe('593');
    expect(normalizeDialCode('+ 55')).toBe('55');
  });

  it('rechaza lo que no es un prefijo', () => {
    expect(normalizeDialCode('')).toBeUndefined();
    expect(normalizeDialCode('+')).toBeUndefined();
    expect(normalizeDialCode('5x')).toBeUndefined();
    expect(normalizeDialCode('+5912')).toBeUndefined();
  });
});

describe('flightContactPhone', () => {
  it('manda el prefijo elegido y nunca un código de área inventado', () => {
    const contact = flightContactPhone('51', '987654321');
    expect(contact).toEqual({ phone: '987654321', countryDialingCode: '51' });
    expect(contact).not.toHaveProperty('areaCode');
  });

  it('si el número viene con su +prefijo delante, no lo repite', () => {
    expect(flightContactPhone('55', '+55 11 91234 5678')).toEqual({
      phone: '11 91234 5678',
      countryDialingCode: '55',
    });
  });
});

describe('whatsappDigits', () => {
  it('antepone el prefijo al número nacional', () => {
    expect(whatsappDigits('51', '987 654 321')).toBe('51987654321');
  });

  it('un número con + ya es internacional', () => {
    expect(whatsappDigits('57', '+51 987 654 321')).toBe('51987654321');
  });
});
