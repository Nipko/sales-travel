import { describe, expect, it } from 'vitest';
import {
  isIdempotencyKey,
  newIdempotencyKey,
  parseHotelBookRequest,
  type HotelBookRequest,
} from './hotel-book';

const REQUEST: HotelBookRequest = {
  providerCode: 'tbo-hotels',
  prebookRef: '0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b',
  acceptedTotal: { amountMinor: 32134, currency: 'USD' },
  atPropertyAcknowledged: true,
  rooms: [
    {
      guests: [
        { paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Pérez' },
        { paxType: 'CHD', title: 'Ms', firstName: 'Sofía', lastName: 'Pérez' },
      ],
    },
    { guests: [{ paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Muñoz' }] },
  ],
  contact: { email: 'ana@correo.com', phone: { countryCode: '+57', number: '300 123 4567' } },
};

describe('newIdempotencyKey — una clave por intento de reserva', () => {
  it('usa randomUUID cuando el navegador lo tiene', () => {
    const key = newIdempotencyKey({
      getRandomValues: (a) => a,
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    });
    expect(key).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('sin contexto seguro arma un UUID v4 válido con getRandomValues', () => {
    const key = newIdempotencyKey({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xff);
        return array;
      },
    });
    expect(key).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(isIdempotencyKey(key)).toBe(true);
  });

  it('dos intentos nunca comparten clave', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(isIdempotencyKey(key)).toBe(true);
  });

  it('el formato es el que exige el API: UUID de versión 1 a 5', () => {
    expect(isIdempotencyKey('0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b')).toBe(true);
    expect(isIdempotencyKey('0f8e7d6c-5b4a-0392-8a1b-0c9d8e7f6a5b')).toBe(false);
    expect(isIdempotencyKey('q:0f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b')).toBe(false);
    expect(isIdempotencyKey(undefined)).toBe(false);
  });
});

describe('parseHotelBookRequest — lo que la ruta reenvía al API', () => {
  it('rearma el cuerpo neutral completo', () => {
    expect(parseHotelBookRequest(REQUEST)).toEqual(REQUEST);
  });

  it('descarta lo que venga de más, incluidos campos de tarjeta (D1)', () => {
    const parsed = parseHotelBookRequest({
      ...REQUEST,
      PaymentInfo: { CardNumber: '4111111111111111', CvvNumber: '123' },
      payment: { secureToken: 'x' },
      rooms: REQUEST.rooms.map((room) => ({ ...room, cardNumber: '4111' })),
      contact: { ...REQUEST.contact, cvv: '123' },
    });
    expect(parsed).toEqual(REQUEST);
    expect(JSON.stringify(parsed)).not.toMatch(/card|cvv|payment|secureToken/i);
  });

  it('sólo manda el reconocimiento de cargos en el hotel si es `true`', () => {
    const { atPropertyAcknowledged: _drop, ...rest } = REQUEST;
    expect(parseHotelBookRequest({ ...rest, atPropertyAcknowledged: 'true' })).toEqual(rest);
    expect(parseHotelBookRequest(rest)).toEqual(rest);
  });

  it('recorta los nombres sin cambiarlos: la transliteración es del servidor', () => {
    const parsed = parseHotelBookRequest({
      ...REQUEST,
      rooms: [
        {
          guests: [{ paxType: 'ADT', title: 'Mr', firstName: '  José  Luis ', lastName: 'Muñoz' }],
        },
      ],
    });
    expect(parsed?.rooms[0]?.guests[0]).toEqual({
      paxType: 'ADT',
      title: 'Mr',
      firstName: 'José Luis',
      lastName: 'Muñoz',
    });
  });

  it.each([
    ['otro proveedor con formato inválido', { providerCode: 'TBO Hotels' }],
    ['prebookRef que no es UUID', { prebookRef: 'abc' }],
    ['importe no entero', { acceptedTotal: { amountMinor: 1.5, currency: 'USD' } }],
    ['importe en cero', { acceptedTotal: { amountMinor: 0, currency: 'USD' } }],
    ['moneda en minúsculas', { acceptedTotal: { amountMinor: 100, currency: 'usd' } }],
    ['sin habitaciones', { rooms: [] }],
    ['habitación sin huéspedes', { rooms: [{ guests: [] }] }],
    [
      'título Dr (Q-41)',
      { rooms: [{ guests: [{ paxType: 'ADT', title: 'Dr', firstName: 'A', lastName: 'B' }] }] },
    ],
    [
      'tipo de pasajero INF',
      { rooms: [{ guests: [{ paxType: 'INF', title: 'Mr', firstName: 'A', lastName: 'B' }] }] },
    ],
    [
      'nombre vacío',
      { rooms: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: '  ', lastName: 'B' }] }] },
    ],
    ['email sin dominio', { contact: { ...REQUEST.contact, email: 'ana@' } }],
    [
      'prefijo de 4 dígitos',
      { contact: { ...REQUEST.contact, phone: { countryCode: '+5712', number: '3001234' } } },
    ],
    [
      'teléfono con letras',
      { contact: { ...REQUEST.contact, phone: { countryCode: '+57', number: 'tel 300' } } },
    ],
  ])('rechaza %s', (_name, patch) => {
    expect(parseHotelBookRequest({ ...REQUEST, ...patch })).toBeUndefined();
  });

  it('rechaza más habitaciones o huéspedes que los topes del API', () => {
    const guest = { paxType: 'ADT', title: 'Mr', firstName: 'Ana', lastName: 'Paz' };
    expect(
      parseHotelBookRequest({
        ...REQUEST,
        rooms: Array.from({ length: 9 }, () => ({ guests: [guest] })),
      }),
    ).toBeUndefined();
    expect(
      parseHotelBookRequest({
        ...REQUEST,
        rooms: [{ guests: Array.from({ length: 17 }, () => guest) }],
      }),
    ).toBeUndefined();
  });
});
