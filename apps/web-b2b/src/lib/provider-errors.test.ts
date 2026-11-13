import { describe, expect, it } from 'vitest';
import { humanizeBookingFailure, humanizeProviderError } from './provider-errors';

describe('humanizeProviderError — la red de seguridad de los errores crudos de vuelos', () => {
  it.each([
    [
      'Passport is mandatory for all passengers',
      'En "Pasajeros", cambia el tipo de documento a "Pasaporte", completa el número y la fecha de vencimiento, y vuelve a reservar.',
    ],
    ['Price changed since quote', 'Usa "Verificar precio" para actualizarlo y reintenta.'],
    ['Sold out', 'La tarifa ya no está disponible. Vuelve a buscar para ver opciones vigentes.'],
    ['Error 933: not suitable for void', 'gestiona la cancelación con la aerolínea.'],
    ['911 not ready for this flow', 'Usa "Pagar / Emitir tiquete" primero y luego reintenta'],
    ['Missing agent info', 'Cárgalo en Mi Red → Credenciales → LATAM NDC y reintenta.'],
  ])('%s → texto en tú', (raw, esperado) => {
    expect(humanizeProviderError(raw)).toContain(esperado);
  });

  it('un error desconocido pierde el prefijo técnico y se muestra tal cual', () => {
    expect(humanizeProviderError('LATAM NDC error 400: Invalid segment')).toBe('Invalid segment');
  });
});

describe('humanizeBookingFailure', () => {
  it('un pasajero repetido se explica en palabras', () => {
    expect(humanizeBookingFailure('DUPLICATE NAME IN PNR')).toMatch(/pasajeros repetidos/);
  });

  it('un error técnico se cambia por qué hacer, sin el texto crudo', () => {
    const out = humanizeBookingFailure('passengers.1.identityDoc.expiryDate: invalid_string');
    expect(out).toMatch(/^No pudimos crear la reserva/);
    expect(out).not.toMatch(/passengers/);
    expect(humanizeBookingFailure('Error desconocido')).toMatch(/^No pudimos crear la reserva/);
  });

  it('una frase ya humana del API se deja como está', () => {
    const humana = 'La cartera de tu agencia no tiene saldo para esta reserva.';
    expect(humanizeBookingFailure(humana)).toBe(humana);
  });
});
