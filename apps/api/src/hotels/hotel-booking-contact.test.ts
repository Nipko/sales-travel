import { describe, expect, it } from 'vitest';
import { agencyBookingContact, parseInternationalPhone } from './hotel-booking-contact.js';

/**
 * El contacto que viaja al proveedor es el operativo de la agencia (docs/tbo/03 §3.5; D-TBO-23 A).
 */

describe('parseInternationalPhone: prefijo de país sin adivinar', () => {
  it.each([
    ['+57 300 123 4567', '57', '3001234567'],
    ['+51 (1) 555-0123', '51', '15550123'],
    ['+55 11 91234-5678', '55', '11912345678'],
    ['+1 305 555 0100', '1', '3055550100'],
    ['+7 495 123 45 67', '7', '4951234567'],
    ['+593 2 123 4567', '593', '21234567'],
    ['+506 2222 3333', '506', '22223333'],
  ])('%s → %s + %s', (raw, countryCode, number) => {
    expect(parseInternationalPhone(raw)).toEqual({ countryCode, number });
  });

  it.each([
    ['sin + no se sabe de qué país es', '300 123 4567'],
    ['vacío', ''],
    ['ausente', null],
    ['con letras', '+57 300 ABC 4567'],
    ['un prefijo que empieza en 0', '+057 300 123 4567'],
    ['demasiado corto', '+57 123'],
    ['más de 15 dígitos', '+57 3001234567890123'],
  ])('%s → sin teléfono', (_caso, raw) => {
    expect(parseInternationalPhone(raw)).toBeUndefined();
  });
});

describe('agencyBookingContact', () => {
  it('email y teléfono utilizables → el contacto neutral', () => {
    expect(
      agencyBookingContact({ email: ' reservas@agencia.example ', phone: '+57 300 123 4567' }),
    ).toEqual({
      email: 'reservas@agencia.example',
      phone: { countryCode: '57', number: '3001234567' },
    });
  });

  it.each([
    ['sin email', { email: null, phone: '+57 300 123 4567' }],
    ['con un email inválido', { email: 'reservas', phone: '+57 300 123 4567' }],
    ['sin teléfono', { email: 'reservas@agencia.example', phone: null }],
    ['con un teléfono local', { email: 'reservas@agencia.example', phone: '3001234567' }],
  ])('%s → no hay contacto que mandar (y no se inventa)', (_caso, soporte) => {
    expect(agencyBookingContact(soporte)).toBeUndefined();
  });
});
