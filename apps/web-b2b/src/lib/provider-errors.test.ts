import { describe, expect, it } from 'vitest';
import { humanizeProviderError } from './provider-errors';

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
