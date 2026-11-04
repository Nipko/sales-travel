import { describe, expect, it } from 'vitest';
import { declinedMessage } from './orders.service.js';

describe('declinedMessage', () => {
  it('H-07 se explica: es configuración de la oficina en Sabre, no un error del vendedor', () => {
    const m = declinedMessage(['UNABLE_TO_ADD_TRAVELER_PASSENGER_TYPE_NOT_ENABLED']);
    expect(m).toContain('no se creó nada');
    expect(m).toContain('Store Passenger Type In PNR');
    expect(m).toContain('La cotización sigue disponible');
  });

  it('un código desconocido va tal cual, para que soporte lo ubique', () => {
    expect(declinedMessage(['UNABLE_TO_SELL_SEGMENT'])).toContain(
      'Motivo: UNABLE_TO_SELL_SEGMENT.',
    );
  });
});
