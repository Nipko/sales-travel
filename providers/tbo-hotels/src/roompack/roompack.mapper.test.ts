import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { TBO_SEARCH_ROOM_KEYS } from '../search/response.schema';
import { mapTboRoompack, type TboPackObserver, type TboPackScope } from './roompack.mapper';

/**
 * `RoomID` en Search: el enlace de cada habitación con el contenido por habitación de HotelDetails
 * (p. 57; Q-65). El PDF lo muestra sólo en una nota y nadie sabe si TBO lo manda: la métrica
 * `tbo.<op>.room_id` lo cuenta una vez por pack, por su FORMA.
 */

const P15 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'search-single-room.p15.json'), 'utf8'),
) as { HotelResult: { Rooms: Record<string, unknown>[] }[] };

const ROOM = P15.HotelResult[0]?.Rooms[0] ?? {};
const ONE: HotelRoomOccupancy[] = [{ adults: 2, childrenAges: [] }];
const TWO: HotelRoomOccupancy[] = [
  { adults: 2, childrenAges: [] },
  { adults: 1, childrenAges: [] },
];

function scope(
  rooms: readonly HotelRoomOccupancy[],
  op: TboPackScope['op'] = 'search',
): { scope: TboPackScope; counters: { name: string; tags: Record<string, string> }[] } {
  const counters: { name: string; tags: Record<string, string> }[] = [];
  const observer: TboPackObserver = {
    collectUnknownKeys: () => undefined,
    precisionLoss: () => undefined,
    count: (name, tags) => counters.push({ name, tags }),
    unknownMealType: () => undefined,
  };
  return {
    counters,
    scope: {
      op,
      source: op === 'search' ? 'search-indicative' : 'prebook-final',
      hotelCode: '1120548',
      currency: 'USD',
      searchId: 'srch_0001',
      expiresAt: '2026-09-25T15:27:00.000Z',
      rooms,
      knownRoomKeys: TBO_SEARCH_ROOM_KEYS,
      observer,
    },
  };
}

function roomIdCounters(counters: { name: string; tags: Record<string, string> }[]) {
  return counters.filter((counter) => counter.name.endsWith('.room_id'));
}

describe('mapTboRoompack: la métrica de RoomID (Q-65)', () => {
  it.each([
    ['sin RoomID (lo que trae el ejemplo de p. 15)', {}, 'absent'],
    ['RoomID con un id (la nota de p. 57)', { RoomID: ['197354'] }, 'present'],
    ['RoomID numérico', { RoomID: [197354] }, 'present'],
    ['RoomId con el casing de HotelDetails', { RoomId: ['197354'] }, 'present'],
    ['RoomID 0: "mapping isn\'t available"', { RoomID: ['0'] }, 'zero'],
    ['RoomID con ceros y vacíos', { RoomID: ['000', ' '] }, 'zero'],
    ['RoomID lista vacía', { RoomID: [] }, 'absent'],
    ['RoomID null', { RoomID: null }, 'absent'],
  ])('%s → `%s`', (_label, extra, shape) => {
    const { scope: s, counters } = scope(ONE);
    const outcome = mapTboRoompack({ ...ROOM, ...extra }, s);
    expect(outcome.ok).toBe(true);
    expect(roomIdCounters(counters)).toEqual([
      { name: 'tbo.search.room_id', tags: { op: 'search', shape } },
    ]);
  });

  it('una vez por PACK aunque tenga varias habitaciones; `present` si alguna trae id', () => {
    const { scope: s, counters } = scope(TWO);
    const outcome = mapTboRoompack(
      { ...ROOM, Name: ['Luxury Room', 'Twin Room'], RoomID: ['0', '197354'] },
      s,
    );
    expect(outcome.ok).toBe(true);
    expect(roomIdCounters(counters)).toEqual([
      { name: 'tbo.search.room_id', tags: { op: 'search', shape: 'present' } },
    ]);
    if (outcome.ok) {
      expect(outcome.pack.rooms.map((room) => room.roomTypeId)).toEqual([undefined, '197354']);
    }
  });

  it('PreBook la cuenta con su nombre de operación', () => {
    const { scope: s, counters } = scope(ONE, 'prebook');
    mapTboRoompack({ ...ROOM, RoomID: ['197354'] }, s);
    expect(roomIdCounters(counters)).toEqual([
      { name: 'tbo.prebook.room_id', tags: { op: 'prebook', shape: 'present' } },
    ]);
  });

  it('la métrica lleva la forma, nunca el id', () => {
    const { scope: s, counters } = scope(ONE);
    mapTboRoompack({ ...ROOM, RoomID: ['987654321'] }, s);
    expect(JSON.stringify(counters)).not.toContain('987654321');
  });

  it('un pack que no pasa el esquema no llega a contarse', () => {
    const { scope: s, counters } = scope(ONE);
    expect(mapTboRoompack({ ...ROOM, Name: 'no es lista', RoomID: ['1'] }, s).ok).toBe(false);
    expect(roomIdCounters(counters)).toEqual([]);
  });
});
