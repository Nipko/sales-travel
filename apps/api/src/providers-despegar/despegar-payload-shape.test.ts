import { mapHotelDetail } from '@sales-travel/despegar-hotels';
import { describe, expect, it } from 'vitest';
import { payloadShape } from './despegar-payload-shape';

describe('payloadShape', () => {
  it('rutas de campos sin un solo valor', () => {
    const body = JSON.stringify({
      id: 123,
      roompacks: [{ id: 'RP-SECRETO', rooms: [{ choice_id: 'TOKEN', reference: 0 }] }],
      by_id: { '98765': { name: 'Juan Pérez' } },
    });
    const shape = payloadShape(body);
    expect(shape).toEqual([
      'by_id',
      'by_id.*',
      'by_id.*.name',
      'id',
      'roompacks',
      'roompacks[].id',
      'roompacks[].rooms',
      'roompacks[].rooms[].choice_id',
      'roompacks[].rooms[].reference',
    ]);
    expect(shape.join()).not.toMatch(/RP-SECRETO|TOKEN|Juan|98765|123/);
  });

  it('lo que no es JSON no tiene forma', () => {
    expect(payloadShape('<html>')).toEqual([]);
    expect(payloadShape(undefined)).toEqual([]);
  });
});

describe('mapHotelDetail — variantes de la respuesta', () => {
  const pack = (over: Record<string, unknown> = {}) => ({
    id: 'RP-1',
    rooms: [{ name: 'Doble', reference: 0, room_type_id: 'RT-1' }],
    price_detail: { currency: 'USD', total: 100 },
    ...over,
  });

  it('sin id en la respuesta, el hotel que se pidió', () => {
    expect(mapHotelDetail({ roompacks: [pack()] }, '555').hotelId).toBe('555');
  });

  it('el choice_id del roompack llega a cada habitación', () => {
    const offer = mapHotelDetail({ id: 555, roompacks: [pack({ choice_id: 'CH-9' })] }, '555');
    expect(offer.roompacks[0]?.rooms[0]?.choiceId).toBe('CH-9');
  });

  it('envuelta en items', () => {
    const offer = mapHotelDetail({ items: [{ id: 555, roompacks: [pack()] }] }, '555');
    expect(offer.hotelId).toBe('555');
    expect(offer.roompacks).toHaveLength(1);
  });
});
