import { describe, expect, it } from 'vitest';
import { isInternationalPhone, supportPhoneHint, trimmedSupportContact } from './support-contact';

describe('isInternationalPhone — el teléfono que el Book de hoteles manda al proveedor', () => {
  it('con + y el código de país, con o sin separadores', () => {
    for (const phone of [
      '+57 300 123 4567',
      '+573001234567',
      '+1 (305) 555-0100',
      ' +51 1 555 0000 ',
    ]) {
      expect(isInternationalPhone(phone)).toBe(true);
    }
  });

  it('sin +, con letras, con un prefijo 0, demasiado corto o demasiado largo, no', () => {
    for (const phone of [
      '300 123 4567',
      '+57 300 ABC 4567',
      '+0 300 123 4567',
      '+57 123',
      '+57 300 123 4567 8901',
      '',
      null,
    ]) {
      expect(isInternationalPhone(phone)).toBe(false);
    }
  });
});

describe('supportPhoneHint — el aviso mientras se escribe', () => {
  it('un teléfono local avisa que así no se reservan hoteles', () => {
    expect(supportPhoneHint('300 123 4567')).toBe(
      'Así no se pueden reservar hoteles: escríbelo con + y el código de país.',
    );
  });

  it('vacío (se hereda del consolidador) o internacional, no avisa nada', () => {
    expect(supportPhoneHint(null)).toBeUndefined();
    expect(supportPhoneHint('   ')).toBeUndefined();
    expect(supportPhoneHint('+57 300 123 4567')).toBeUndefined();
  });
});

describe('trimmedSupportContact — lo que se guarda', () => {
  it('quita los espacios de más y deja vacío como null para heredar; lo demás no lo toca', () => {
    expect(
      trimmedSupportContact({
        logoUrl: 'https://cdn.example/logo.png',
        supportEmail: '  reservas@agencia.example ',
        supportPhone: '   ',
      }),
    ).toEqual({
      logoUrl: 'https://cdn.example/logo.png',
      supportEmail: 'reservas@agencia.example',
      supportPhone: null,
    });
    expect(trimmedSupportContact({ supportEmail: null, supportPhone: '+57 300 123 4567' })).toEqual(
      { supportEmail: null, supportPhone: '+57 300 123 4567' },
    );
  });
});
