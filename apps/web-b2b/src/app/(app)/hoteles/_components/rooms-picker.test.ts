import { describe, expect, it } from 'vitest';
import {
  adjustAdults,
  adjustChildren,
  canAddRoom,
  childAgeOptions,
  DEFAULT_ROOM,
  HOTEL_OCCUPANCY_LIMITS,
  roomsSpoken,
  roomsSummary,
  serializeRooms,
  setChildAge,
  type RoomDraft,
} from './rooms-picker';

describe('HOTEL_OCCUPANCY_LIMITS — los topes del borde (U-04)', () => {
  it('son los mismos que valida el API: 8 habitaciones, 8 adultos, 6 niños de 0 a 17', () => {
    expect(HOTEL_OCCUPANCY_LIMITS).toEqual({
      maxRooms: 8,
      maxAdultsPerRoom: 8,
      maxChildrenPerRoom: 6,
      maxChildAge: 17,
    });
  });

  it('las edades que se pueden elegir van de 0 al tope', () => {
    const ages = childAgeOptions();
    expect(ages[0]).toBe(0);
    expect(ages.at(-1)).toBe(17);
    expect(ages).toHaveLength(18);
  });
});

describe('adjustAdults / adjustChildren', () => {
  it('siempre al menos un adulto y nunca más del tope', () => {
    expect(adjustAdults({ adults: 1, children: [] }, -1).adults).toBe(1);
    expect(adjustAdults({ adults: 8, children: [] }, 1).adults).toBe(8);
    expect(adjustAdults(DEFAULT_ROOM, 1).adults).toBe(3);
  });

  it('un niño nuevo entra con una edad visible; el tope no se pasa', () => {
    const one = adjustChildren(DEFAULT_ROOM, 1);
    expect(one.children).toHaveLength(1);
    const full: RoomDraft = { adults: 2, children: [1, 2, 3, 4, 5, 6] };
    expect(adjustChildren(full, 1)).toBe(full);
    expect(adjustChildren(full, -1).children).toEqual([1, 2, 3, 4, 5]);
  });

  it('la edad de un niño queda dentro de 0 a 17', () => {
    const room: RoomDraft = { adults: 2, children: [8, 8] };
    expect(setChildAge(room, 1, 18).children).toEqual([8, 17]);
    expect(setChildAge(room, 0, -1).children).toEqual([0, 8]);
  });
});

describe('canAddRoom', () => {
  it('hasta 8 habitaciones', () => {
    expect(canAddRoom(Array.from({ length: 7 }, () => DEFAULT_ROOM))).toBe(true);
    expect(canAddRoom(Array.from({ length: 8 }, () => DEFAULT_ROOM))).toBe(false);
  });
});

describe('resumen y valor del formulario', () => {
  const rooms: RoomDraft[] = [
    { adults: 2, children: [5] },
    { adults: 1, children: [] },
  ];

  it('el disparador resume y el lector de pantalla lo escucha entero', () => {
    expect(roomsSummary(rooms)).toBe('2 hab · 4 huéspedes');
    expect(roomsSpoken(rooms)).toBe('2 habitaciones, 3 adultos, 1 niño');
    expect(roomsSpoken([DEFAULT_ROOM])).toBe('1 habitación, 2 adultos');
  });

  it('el campo oculto lleva la forma que espera la búsqueda, en el orden de carga', () => {
    expect(JSON.parse(serializeRooms(rooms))).toEqual([
      { adults: 2, childrenAges: [5] },
      { adults: 1, childrenAges: [] },
    ]);
  });
});
