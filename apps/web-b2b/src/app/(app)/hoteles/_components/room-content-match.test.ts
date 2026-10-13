import { describe, expect, it } from 'vitest';
import type { HotelRoompack } from '../actions';
import { hotelRateRows } from './hotel-rate-view';
import {
  ROOM_PHOTOS_MAX,
  groupRoomContent,
  matchRoomContent,
  roomsWithDescription,
  roomsWithPhotos,
  slotSizeLabel,
} from './room-content-match';
import type { RoomContent, RoomContentReply, RoomContentState } from './room-content-view';
import { roomTypeGroups } from './room-type-groups';

/*
 * D-TBO-H2, opción 2: la foto de una habitación de la tarifa es la de su RoomID en el catálogo; si
 * no hay id que coincida, la de la única habitación con el mismo nombre normalizado («Foto de
 * referencia»). Ante la duda, sin foto.
 */

const TBO = 'tbo-hotels';
const PHOTO = '/api/hotels/images/aGVsbG8';

function room(extra: Partial<RoomContent> & Pick<RoomContent, 'roomKey'>): RoomContent {
  return {
    roomId: null,
    nameKey: null,
    name: null,
    sizeText: null,
    sizeM2: null,
    description: null,
    images: [PHOTO],
    ...extra,
  };
}

const slot = (nameKey: string, ids: Record<string, string> = {}) => ({
  nameKey,
  roomTypeIds: ids,
});

describe('matchRoomContent', () => {
  const deluxe = room({ roomKey: '197354', roomId: '197354', nameKey: 'deluxe king' });
  const superior = room({ roomKey: 'n-1', nameKey: 'superior twin' });

  it('id exacto: la misma habitación, sin «Foto de referencia»', () => {
    expect(
      matchRoomContent(slot('otro nombre', { [TBO]: '197354' }), [deluxe, superior], {
        providerCode: TBO,
      }),
    ).toEqual({ room: deluxe, exact: true });
  });

  it('el id que cuenta es el de ESE proveedor', () => {
    expect(
      matchRoomContent(slot('otro nombre', { 'despegar-hotels': '197354' }), [deluxe], {
        providerCode: TBO,
      }),
    ).toBeUndefined();
  });

  it('sin id, el nombre idéntico con un único candidato: por nombre', () => {
    expect(
      matchRoomContent(slot('superior twin'), [deluxe, superior], { providerCode: TBO }),
    ).toEqual({ room: superior, exact: false });
  });

  it('con un id que el catálogo no tiene, el nombre vale si el candidato no tiene otro id', () => {
    expect(
      matchRoomContent(slot('superior twin', { [TBO]: '555' }), [superior], { providerCode: TBO }),
    ).toEqual({ room: superior, exact: false });
    // El catálogo da OTRO id para ese nombre: son habitaciones distintas.
    expect(
      matchRoomContent(slot('deluxe king', { [TBO]: '555' }), [deluxe], { providerCode: TBO }),
    ).toBeUndefined();
  });

  it('nombre ambiguo (dos candidatos): nada', () => {
    const otra = room({ roomKey: 'n-2', nameKey: 'superior twin' });
    expect(
      matchRoomContent(slot('superior twin'), [superior, otra], { providerCode: TBO }),
    ).toBeUndefined();
  });

  it('sin datos: sin nombre, sin habitaciones o sin coincidencia, nada', () => {
    expect(
      matchRoomContent(slot(''), [room({ roomKey: 'x' })], { providerCode: TBO }),
    ).toBeUndefined();
    expect(matchRoomContent(slot('deluxe king'), [], { providerCode: TBO })).toBeUndefined();
    expect(
      matchRoomContent(slot('junior suite'), [deluxe, superior], { providerCode: TBO }),
    ).toBeUndefined();
  });

  it('el inicio del nombre sólo con allowPrefix (opción 3, apagada)', () => {
    const garden = room({ roomKey: 'n-3', nameKey: 'deluxe room 1 king bed garden view' });
    const s = slot('deluxe room 1 king bed');
    expect(matchRoomContent(s, [garden], { providerCode: TBO })).toBeUndefined();
    expect(matchRoomContent(s, [garden], { providerCode: TBO, allowPrefix: true })).toEqual({
      room: garden,
      exact: false,
    });
    // Al revés también, y nunca a mitad de palabra ni con dos candidatos.
    expect(
      matchRoomContent(
        slot('deluxe room 1 king bed garden view'),
        [room({ roomKey: 'n-4', nameKey: 'deluxe room 1 king bed' })],
        { providerCode: TBO, allowPrefix: true },
      )?.exact,
    ).toBe(false);
    expect(
      matchRoomContent(slot('deluxe'), [room({ roomKey: 'n-5', nameKey: 'deluxeroom' })], {
        providerCode: TBO,
        allowPrefix: true,
      }),
    ).toBeUndefined();
    expect(
      matchRoomContent(
        s,
        [garden, room({ roomKey: 'n-6', nameKey: 'deluxe room 1 king bed sea view' })],
        { providerCode: TBO, allowPrefix: true },
      ),
    ).toBeUndefined();
  });

  it('un nombre idéntico ambiguo no cae al inicio del nombre', () => {
    const a = room({ roomKey: 'n-7', nameKey: 'doble' });
    const b = room({ roomKey: 'n-8', nameKey: 'doble' });
    const c = room({ roomKey: 'n-9', nameKey: 'doble vista al mar' });
    expect(
      matchRoomContent(slot('doble'), [a, b, c], { providerCode: TBO, allowPrefix: true }),
    ).toBeUndefined();
  });
});

// ───────────────────────── Por tipo de habitación ─────────────────────────

function pack(
  id: string,
  rooms: { name: string; roomTypeId?: string }[],
  provider = TBO,
): HotelRoompack {
  return {
    id,
    provider: { name: provider, offerRef: `${id}-REF` },
    board: 'RO',
    rooms: rooms.map((r, i) => ({ ...r, reference: i + 1, bedOptions: [] })),
    cancellation: { refundable: true, status: 'fully_refundable', rules: [] },
    price: { total: { amountMinor: 100_00, currency: 'USD' }, taxesDetail: [] },
  };
}

function groupsOf(packs: HotelRoompack[]) {
  const rows = hotelRateRows({ roompacks: packs }, false);
  return roomTypeGroups(rows.map((row) => ({ row })));
}

const done = (reply: RoomContentReply): RoomContentState => ({ status: 'done', reply });

describe('groupRoomContent', () => {
  const doble = room({
    roomKey: '11',
    roomId: '11',
    nameKey: 'doble',
    sizeM2: 25,
    description: 'Dos camas.',
  });
  const suite = room({ roomKey: 'n-s', nameKey: 'suite', images: [], sizeText: 'Amplia' });
  const reply: RoomContentReply = {
    byProvider: { [TBO]: { status: 'ready', rooms: [doble, suite] } },
  };

  it('sin proveedor que dé contenido, o sin nada que pedir: como siempre', () => {
    const [g] = groupsOf([pack('A', [{ name: 'Doble', roomTypeId: '11' }], 'despegar-hotels')]);
    expect(groupRoomContent(g!, done(reply))).toBeUndefined();
    const [t] = groupsOf([pack('A', [{ name: 'Doble', roomTypeId: '11' }])]);
    expect(groupRoomContent(t!, { status: 'idle' })).toBeUndefined();
  });

  it('pidiéndolo, o pending sin nada que mostrar todavía: el esqueleto', () => {
    const [g] = groupsOf([pack('A', [{ name: 'Doble', roomTypeId: '11' }])]);
    expect(groupRoomContent(g!, { status: 'loading' })).toEqual({ kind: 'loading' });
    expect(
      groupRoomContent(g!, done({ byProvider: { [TBO]: { status: 'pending', rooms: [] } } })),
    ).toEqual({ kind: 'loading' });
    expect(
      groupRoomContent(g!, done({ byProvider: { [TBO]: { status: 'none', rooms: [] } } })),
    ).toBeUndefined();
  });

  it('una habitación: su foto por id, su tamaño y su descripción', () => {
    const [g] = groupsOf([pack('A', [{ name: 'Doble', roomTypeId: '11' }])]);
    const content = groupRoomContent(g!, done(reply));
    expect(content?.kind).toBe('ready');
    expect(roomsWithPhotos(content).map((r) => [r.name, r.exact])).toEqual([['Doble', true]]);
    expect(slotSizeLabel(content, 0)).toBe('≈ 25 m²');
    expect(roomsWithDescription(content).map((r) => r.room.description)).toEqual(['Dos camas.']);
  });

  it('varias habitaciones: una entrada por habitación distinta, con las que va', () => {
    const [g] = groupsOf([
      pack('A', [
        { name: 'Doble', roomTypeId: '11' },
        { name: 'Doble', roomTypeId: '11' },
        { name: 'Suite' },
      ]),
    ]);
    const content = groupRoomContent(g!, done(reply));
    if (content?.kind !== 'ready') throw new Error('sin contenido');
    expect(content.rooms.map((r) => [r.key, r.slotIndexes, r.exact])).toEqual([
      ['tbo-hotels:11', [0, 1], true],
      ['tbo-hotels:n-s', [2], false],
    ]);
    // La suite no tiene fotos: sólo la doble lleva miniatura; su tamaño, el texto tal cual.
    expect(roomsWithPhotos(content).map((r) => r.name)).toEqual(['Doble']);
    expect(slotSizeLabel(content, 2)).toBe('Amplia');
    expect(slotSizeLabel(content, 5)).toBeUndefined();
  });

  it(`hasta ${ROOM_PHOTOS_MAX} miniaturas por tipo`, () => {
    const rooms = ['a', 'b', 'c', 'd'].map((n) => room({ roomKey: `n-${n}`, nameKey: n }));
    const [g] = groupsOf([
      pack(
        'A',
        ['A', 'B', 'C', 'D'].map((name) => ({ name })),
      ),
    ]);
    const content = groupRoomContent(
      g!,
      done({ byProvider: { [TBO]: { status: 'ready', rooms } } }),
    );
    expect(roomsWithPhotos(content)).toHaveLength(ROOM_PHOTOS_MAX);
  });

  it('nada coincide: como siempre', () => {
    const [g] = groupsOf([pack('A', [{ name: 'Junior' }])]);
    expect(groupRoomContent(g!, done(reply))).toBeUndefined();
    expect(roomsWithPhotos(undefined)).toEqual([]);
    expect(roomsWithDescription({ kind: 'loading' })).toEqual([]);
  });
});
