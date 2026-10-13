import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboStaticObserver } from './observer';
import {
  TBO_ROOM_CONTAINER_KEYS,
  TBO_ROOM_DETAIL_LIMITS,
  normalizeTboRoomName,
  readTboRoomDetails,
  tboSyntheticRoomKey,
  type TboRoomDetailScope,
} from './room-detail.reader';

/**
 * El lector tolerante del detalle por habitación (`IsRoomDetailRequired`, p. 56-57; 05 §2.6.3;
 * Q-65). Sin un fixture real, lo que se fija es que cada forma plausible se lee, que la forma se
 * informa y que nada lanza ni se filtra al log.
 */

const INFERRED = join(__dirname, '..', '__fixtures__', 'inferred');

type Json = Record<string, unknown>;

function inferred(name: string): { HotelDetails: Json[] } & Json {
  return JSON.parse(readFileSync(join(INFERRED, name), 'utf8')) as { HotelDetails: Json[] } & Json;
}

function firstHotel(envelope: { HotelDetails: Json[] }): Json {
  const hotel = envelope.HotelDetails[0];
  if (hotel === undefined) throw new Error('fixture sin hoteles');
  return hotel;
}

interface Recorded {
  readonly logs: { level: string; message: string; meta: Json }[];
  readonly counters: { name: string; tags: Json }[];
}

function deps(): { logger: LoggerPort; metrics: MetricsPort; recorded: Recorded } {
  const recorded: Recorded = { logs: [], counters: [] };
  const record =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      recorded.logs.push({ level, message, meta: meta ?? {} });
    };
  const logger: LoggerPort = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const metrics = {
    counter: (name: string, _value: number, tags?: Record<string, string>) => {
      recorded.counters.push({ name, tags: tags ?? {} });
    },
    histogram: () => undefined,
    gauge: () => undefined,
  } as unknown as MetricsPort;
  return { logger, metrics, recorded };
}

function read(hotel: unknown, root: unknown = {}, extra: Partial<TboRoomDetailScope> = {}) {
  const d = deps();
  const observer = new TboStaticObserver('hotelDetails', { logger: d.logger, metrics: d.metrics });
  const result = readTboRoomDetails(hotel, root, {
    observer,
    at: 'HotelDetails.0',
    hotelId: '1000000',
    ...extra,
  });
  const diagnostics = observer.finish();
  return { result, diagnostics, recorded: d.recorded };
}

const HOTEL: Json = { HotelCode: '1000000', HotelName: 'Sofitel Legend Old Cataract Aswan' };

function withRooms(rooms: unknown, key = 'Rooms'): Json {
  return { ...HOTEL, [key]: rooms };
}

const EXAMPLE1 = 'https://www.tboholidays.com/imageresource.aspx?img=example1';
const EXAMPLE2 = 'https://www.tboholidays.com/imageresource.aspx?img=example2';
const EXAMPLE3 = 'https://www.tboholidays.com/imageresource.aspx?img=example3';

describe('readTboRoomDetails: los fixtures INFERIDOS (__fixtures__/inferred)', () => {
  it('array: `Rooms` con los campos LITERALES de p. 57 → la habitación entera, normalizada', () => {
    const { result, diagnostics } = read(firstHotel(inferred('hotel-details-room-array.json')));
    expect(result.shape).toBe('array');
    expect(result.hotelKey).toBe('Rooms');
    expect(result.rooms[0]).toEqual({
      roomKey: '197354',
      roomId: '197354',
      nameKey: 'deluxe room 1 king bed garden view',
      name: 'Deluxe Room, 1 King Bed, Garden View',
      sizeText: '1830 ft',
      description: '1 King Bed Overlooking the garden, Free WiFi, Cable channels...',
      images: [EXAMPLE1, EXAMPLE2],
    });
    expect(result.rooms[1]).toMatchObject({
      roomId: '197355',
      sizeText: '60 sq m',
      description: 'Balcony overlooking the Nile\n\n• Free WiFi\n• Minibar',
      images: [EXAMPLE3],
    });
    // `RoomId: 0` es "mapping isn't available" (p. 57): sin id, con la clave del nombre.
    expect(result.rooms[2]).toEqual({
      roomKey: tboSyntheticRoomKey('standard room 2 twin beds'),
      roomId: null,
      nameKey: 'standard room 2 twin beds',
      name: 'Standard Room, 2 Twin Beds',
      sizeText: '25 m²',
      description: 'Garden side, Free WiFi',
      images: [],
    });
    expect(diagnostics.notes).toEqual({ ROOM_ID_MISSING: 1 });
    expect(diagnostics.unknownKeys).toEqual([]);
  });

  it('map: `RoomDetails` indexado por id; el índice es el id y un texto trae dos URLs', () => {
    const { result } = read(firstHotel(inferred('hotel-details-room-map.json')));
    expect(result.shape).toBe('map');
    expect(result.hotelKey).toBe('RoomDetails');
    expect(result.rooms.map((room) => [room.roomKey, room.roomId, room.images])).toEqual([
      ['197354', '197354', [EXAMPLE1, EXAMPLE2]],
      ['197355', '197355', [EXAMPLE3]],
    ]);
  });

  it('root: `RoomDetails[]` en la raíz con `HotelCode` texto o número; las de otro hotel no', () => {
    const envelope = inferred('hotel-details-room-root.json');
    const { result, diagnostics } = read(firstHotel(envelope), envelope);
    expect(result.shape).toBe('root');
    expect(result.rootKey).toBe('RoomDetails');
    expect(result.hotelKey).toBeUndefined();
    expect(result.rooms.map((room) => [room.roomId, room.images])).toEqual([
      ['197354', [EXAMPLE1, EXAMPLE2]],
      ['197355', [EXAMPLE3]],
    ]);
    expect(JSON.stringify(result)).not.toContain('another hotel');
    expect(diagnostics.unknownKeys).toEqual([]);
  });

  it('single: `RoomInfo` como un objeto que ya es la habitación', () => {
    const { result } = read(firstHotel(inferred('hotel-details-room-single.json')));
    expect(result.shape).toBe('single');
    expect(result.hotelKey).toBe('RoomInfo');
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0]?.roomId).toBe('197354');
  });

  it('unknown: otra clave con objetos con forma de habitación → heuristic, con un warn del NOMBRE', () => {
    const { result, diagnostics, recorded } = read(
      firstHotel(inferred('hotel-details-room-unknown.json')),
    );
    expect(result.shape).toBe('heuristic');
    expect(result.hotelKey).toBeUndefined();
    expect(result.rooms).toEqual([
      {
        roomKey: tboSyntheticRoomKey('deluxe room 1 king bed garden view'),
        roomId: null,
        nameKey: 'deluxe room 1 king bed garden view',
        name: 'Deluxe Room, 1 King Bed, Garden View',
        sizeText: '1830 ft',
        description: null,
        images: [EXAMPLE1],
      },
    ]);
    expect(diagnostics.unknownKeys).toEqual(['HotelDetails[].AccommodationUnits[].UnitCode']);
    const warn = recorded.logs.find((log) => log.message === 'tbo.static.room_container_heuristic');
    expect(warn).toEqual({
      level: 'warn',
      message: 'tbo.static.room_container_heuristic',
      meta: {
        provider: 'tbo-hotels',
        op: 'hotelDetails',
        roomContainerKey: 'AccommodationUnits',
        roomShape: 'heuristic',
      },
    });
  });
});

describe('readTboRoomDetails: dónde busca el contenedor', () => {
  const room = { RoomName: 'Doble Estándar', RoomId: 1 };

  it.each(TBO_ROOM_CONTAINER_KEYS.map((key) => [key]))(
    '`%s` en el hotel, sin distinguir mayúsculas',
    (key) => {
      for (const variant of [key, key.toLowerCase(), key.toUpperCase()]) {
        const { result } = read(withRooms([room], variant));
        expect(result.shape).toBe('array');
        expect(result.hotelKey).toBe(variant);
        expect(result.rooms.map((r) => r.roomId)).toEqual(['1']);
      }
    },
  );

  it('con dos claves, gana la de mayor preferencia y la otra sigue desconocida para el mapper', () => {
    const { result } = read({
      ...HOTEL,
      RoomList: [{ RoomName: 'Suite', RoomId: 2 }],
      Rooms: [room],
    });
    expect(result.hotelKey).toBe('Rooms');
    expect(result.rooms.map((r) => r.roomId)).toEqual(['1']);
  });

  it('una clave preferida VACÍA no tapa a otra con habitaciones', () => {
    const { result } = read({ ...HOTEL, Rooms: [], RoomDetails: [room] });
    expect(result).toMatchObject({ shape: 'array', hotelKey: 'RoomDetails' });
    expect(result.rooms.map((r) => r.roomId)).toEqual(['1']);
    expect(read({ ...HOTEL, Rooms: {}, RoomList: [] }).result).toEqual({
      rooms: [],
      shape: 'map',
      hotelKey: 'Rooms',
    });
  });

  it('una lista de listas se aplana un nivel', () => {
    const { result } = read(withRooms([[room], [{ RoomName: 'Suite', RoomId: 2 }]]));
    expect(result.shape).toBe('array');
    expect(result.rooms.map((r) => r.roomId)).toEqual(['1', '2']);
  });

  it('una lista vacía es `array` sin habitaciones: TBO dijo "ninguna", sin warn', () => {
    const { result, recorded } = read(withRooms([]));
    expect(result).toEqual({ rooms: [], shape: 'array', hotelKey: 'Rooms' });
    expect(recorded.logs.filter((log) => log.level === 'warn')).toEqual([]);
  });

  it('un objeto vacío es `map` sin habitaciones', () => {
    expect(read(withRooms({})).result).toEqual({ rooms: [], shape: 'map', hotelKey: 'Rooms' });
  });

  it('un map con índices de posición no usa el índice como id', () => {
    const { result, diagnostics } = read(
      withRooms({ 0: { RoomName: 'Doble' }, 1: { RoomName: 'Suite' } }),
    );
    expect(result.shape).toBe('map');
    expect(result.rooms.map((r) => r.roomId)).toEqual([null, null]);
    expect(diagnostics.notes).toEqual({ ROOM_ID_MISSING: 2 });
  });

  it('en un map, el id de la habitación manda sobre el índice', () => {
    const { result } = read(withRooms({ abc: { RoomName: 'Doble', RoomId: 77 } }));
    expect(result.rooms[0]?.roomId).toBe('77');
  });

  it('una clave contenedora `null` no es un bloque, pero se consume', () => {
    const { result } = read(withRooms(null));
    expect(result).toMatchObject({ shape: 'none', hotelKey: 'Rooms', rooms: [] });
  });

  it('root indexado por hotel: `{ "Rooms": { "1000000": [ … ] } }`', () => {
    const { result } = read(HOTEL, { Rooms: { '1000000': [room], '2000000': [room] } });
    expect(result).toMatchObject({ shape: 'root', rootKey: 'Rooms' });
    expect(result.rooms).toHaveLength(1);
  });

  it('root con envoltorio por hotel: `{ HotelCode, Rooms: [ … ] }`', () => {
    const { result, diagnostics } = read(HOTEL, {
      HotelRooms: [
        { HotelCode: '1000000', Rooms: [room, { RoomName: 'Suite', RoomId: 2 }], Extra: 1 },
        { HotelCode: '3000000', Rooms: [{ RoomName: 'Otra', RoomId: 9 }] },
      ],
    });
    expect(result).toMatchObject({ shape: 'root', rootKey: 'HotelRooms' });
    expect(result.rooms.map((r) => r.roomId)).toEqual(['1', '2']);
    expect(diagnostics.unknownKeys).toEqual(['HotelRooms[].Extra']);
  });

  it('root sin `HotelCode`: sólo se atribuye si la respuesta es de un único hotel', () => {
    expect(read(HOTEL, { Rooms: [room] }, { soleHotel: true }).result).toMatchObject({
      shape: 'root',
      rooms: [{ roomId: '1' }],
    });
    const multi = read(HOTEL, { Rooms: [room] });
    expect(multi.result).toEqual({ rooms: [], shape: 'unreadable', rootKey: 'Rooms' });
    expect(multi.diagnostics.notes).toEqual({ FIELD_INVALID: 1 });
  });

  it('root sólo con habitaciones de otros hoteles: `root` sin habitaciones', () => {
    expect(read(HOTEL, { Rooms: [{ ...room, HotelCode: '2' }] }).result).toEqual({
      rooms: [],
      shape: 'root',
      rootKey: 'Rooms',
    });
  });

  it('el contenedor del hotel manda sobre el de la raíz', () => {
    const { result } = read(withRooms([room]), { Rooms: [{ ...room, HotelCode: '1000000' }] });
    expect(result.shape).toBe('array');
    expect(result.rootKey).toBeUndefined();
  });

  it('heuristic exige DOS campos de habitación: una lista con sólo `Name` no alcanza', () => {
    const { result } = read({ ...HOTEL, Amenidades: [{ Name: 'Piscina' }] });
    expect(result.shape).toBe('none');
  });

  it('none: un warn UNA vez por respuesta con `Clave:tipo` de cada clave, nunca valores', () => {
    const d = deps();
    const observer = new TboStaticObserver('hotelDetails', {
      logger: d.logger,
      metrics: d.metrics,
    });
    const hotel = {
      ...HOTEL,
      HotelRating: 5,
      Images: ['https://api.tbotechnology.in/imageresource.aspx?img=secreto'],
      Vacia: [],
      Mapa: { a: 1 },
      Nada: null,
      Activo: true,
    };
    for (const at of ['HotelDetails.0', 'HotelDetails.1']) {
      expect(readTboRoomDetails(hotel, {}, { observer, at, hotelId: '1000000' }).shape).toBe(
        'none',
      );
    }
    observer.finish();
    const warns = d.recorded.logs.filter(
      (log) => log.message === 'tbo.static.room_container_not_found',
    );
    expect(warns).toEqual([
      {
        level: 'warn',
        message: 'tbo.static.room_container_not_found',
        meta: {
          provider: 'tbo-hotels',
          op: 'hotelDetails',
          roomShape: 'none',
          hotelKeyShapes: [
            'HotelCode:string',
            'HotelName:string',
            'HotelRating:number',
            'Images:array<string>',
            'Vacia:array<empty>',
            'Mapa:object',
            'Nada:null',
            'Activo:boolean',
          ],
        },
      },
    ]);
    expect(JSON.stringify(d.recorded.logs)).not.toMatch(/Sofitel|secreto|1000000/);
    expect(d.recorded.counters.filter((c) => c.name === 'tbo.hotelDetails.room_detail')).toEqual([
      { name: 'tbo.hotelDetails.room_detail', tags: { shape: 'none' } },
      { name: 'tbo.hotelDetails.room_detail', tags: { shape: 'none' } },
    ]);
  });

  it('el log de `none` llega hasta 40 claves (no se pierde la clave nueva entre las conocidas)', () => {
    const hotel: Json = { ...HOTEL };
    for (let i = 0; i < 45; i += 1) hotel[`Campo${i}`] = i;
    const { recorded } = read(hotel);
    const shapes = recorded.logs.find(
      (log) => log.message === 'tbo.static.room_container_not_found',
    )?.meta['hotelKeyShapes'];
    expect(shapes).toHaveLength(TBO_ROOM_DETAIL_LIMITS.maxHotelKeyShapes);
  });
});

describe('readTboRoomDetails: ilegible', () => {
  it.each([
    ['un texto', 'Deluxe, Suite'],
    ['un número', 3],
    ['una lista de textos', ['Deluxe', 'Suite']],
    ['un objeto sin habitaciones', { total: 3, moneda: 'USD' }],
  ])('el contenedor es %s → `unreadable` sin habitaciones, con un warn', (_label, value) => {
    const { result, recorded } = read(withRooms(value));
    expect(result).toEqual({ rooms: [], shape: 'unreadable', hotelKey: 'Rooms' });
    expect(recorded.logs.map((log) => log.message)).toContain(
      'tbo.static.room_container_unreadable',
    );
  });

  it('habitaciones que no se pueden identificar → `unreadable`, no "sin habitaciones"', () => {
    const { result, diagnostics } = read(withRooms([{ RoomSize: '20 m2' }, { RoomName: '!!!' }]));
    expect(result.shape).toBe('unreadable');
    expect(diagnostics.notes).toEqual({ ROOM_EMPTY: 2 });
  });

  it('un hotel que no es objeto → `unreadable`', () => {
    expect(read('1000000').result).toEqual({ rooms: [], shape: 'unreadable' });
  });
});

describe('readTboRoomDetails: alias de campo', () => {
  function single(fields: Json) {
    return read(withRooms([fields])).result.rooms[0];
  }

  it.each(['RoomId', 'RoomID', 'roomId', 'RoomTypeId', 'RoomTypeID', 'RoomCode', 'Id', 'ID'])(
    'id: `%s`',
    (key) => {
      expect(single({ RoomName: 'Doble', [key]: 197354 })?.roomId).toBe('197354');
    },
  );

  it('id: con varios alias gana el del PDF', () => {
    expect(single({ RoomName: 'Doble', Id: 9, RoomId: 197354 })?.roomId).toBe('197354');
  });

  it.each(['RoomName', 'Name', 'RoomType', 'RoomTypeName', 'roomname'])('nombre: `%s`', (key) => {
    expect(single({ [key]: '  Doble   Estándar ' })).toMatchObject({
      name: 'Doble Estándar',
      nameKey: 'doble estandar',
    });
  });

  it.each(['RoomSize', 'Size', 'RoomArea', 'Area'])('tamaño: `%s`, texto o número', (key) => {
    expect(single({ RoomName: 'Doble', [key]: '1830 ft' })?.sizeText).toBe('1830 ft');
    expect(single({ RoomName: 'Doble', [key]: 35 })?.sizeText).toBe('35');
  });

  it.each(['RoomDescription', 'Description', 'RoomDesc', 'RoomFeatures', 'Details'])(
    'descripción: `%s`',
    (key) => {
      expect(single({ RoomName: 'Doble', [key]: 'Vista al mar' })?.description).toBe(
        'Vista al mar',
      );
    },
  );

  it('descripción: una lista de textos se une con "; " y se descartan los que no son texto', () => {
    const { result, diagnostics } = read(
      withRooms([{ RoomName: 'Doble', RoomFeatures: ['Free WiFi', ' ', 'Minibar', 3] }]),
    );
    expect(result.rooms[0]?.description).toBe('Free WiFi; Minibar');
    expect(diagnostics.notes).toEqual({ ROOM_ID_MISSING: 1, FIELD_INVALID: 1 });
  });

  it('descripción: el HTML pasa a texto plano y no queda ningún < ni >', () => {
    const room = single({
      RoomName: 'Doble',
      RoomDescription:
        '<p onclick="x()">Cama &lt;king&gt;</p><script>alert(1)</script><b>Vista</b> 2 > 1',
    });
    expect(room?.description).toBe('Cama king\n\nVista 2 1');
    expect(room?.description).not.toMatch(/[<>]|alert|script|onclick/);
  });

  it.each([
    ['imageURL', [EXAMPLE1, EXAMPLE2]],
    ['ImageURL', [EXAMPLE1, EXAMPLE2]],
    ['ImageUrl', `${EXAMPLE1},${EXAMPLE2}`],
    ['ImageUrls', `${EXAMPLE1}|${EXAMPLE2}`],
    ['ImageURLs', `${EXAMPLE1} ${EXAMPLE2}`],
    ['Images', [{ Url: EXAMPLE1 }, { URL: EXAMPLE2 }]],
    ['RoomImages', [{ ImageUrl: EXAMPLE1 }, { Path: EXAMPLE2 }]],
    ['Image', [{ src: EXAMPLE1 }, EXAMPLE2]],
    ['Photos', [[EXAMPLE1], [EXAMPLE2]]],
  ])('imágenes: `%s`', (key, value) => {
    expect(single({ RoomName: 'Doble', [key]: value })?.images).toEqual([EXAMPLE1, EXAMPLE2]);
  });

  it('un alias en blanco deja paso al siguiente: `RoomName: ""` con `Name`', () => {
    expect(
      single({ RoomName: ' ', Name: 'Deluxe', RoomId: '', RoomID: 7, Description: 'Vista' }),
    ).toMatchObject({ name: 'Deluxe', nameKey: 'deluxe', roomId: '7', description: 'Vista' });
  });

  it('imágenes: un texto DENTRO de una lista o de un objeto es UNA URL, no se parte', () => {
    const withSpace = 'https://www.tboholidays.com/imageresource.aspx?img=ab cd';
    const encoded = 'https://www.tboholidays.com/imageresource.aspx?img=ab%20cd';
    expect(single({ RoomName: 'Doble', imageURL: [withSpace] })?.images).toEqual([encoded]);
    expect(single({ RoomName: 'Doble', Image: { Url: withSpace } })?.images).toEqual([encoded]);
  });

  it('imágenes: de varias claves, sin repetir', () => {
    expect(
      single({ RoomName: 'Doble', imageURL: [EXAMPLE1], Photos: [EXAMPLE1, EXAMPLE2] })?.images,
    ).toEqual([EXAMPLE1, EXAMPLE2]);
  });

  it('las claves que no conoce se registran por NOMBRE, con su ruta', () => {
    const { diagnostics } = read(withRooms([{ RoomName: 'Doble', RoomId: 1, BedType: 'King' }]));
    expect(diagnostics.unknownKeys).toEqual(['HotelDetails[].Rooms[].BedType']);
  });
});

describe('readTboRoomDetails: normalización', () => {
  function idOf(value: unknown) {
    const { result, diagnostics } = read(withRooms([{ RoomName: 'Doble', RoomId: value }]));
    return { id: result.rooms[0]?.roomId, notes: diagnostics.notes };
  }

  it.each([
    [197354, '197354'],
    ['197354', '197354'],
    [' 42 ', '42'],
    [['197354'], '197354'],
    [[197354], '197354'],
    ['AB-12_x', 'AB-12_x'],
    ['x'.repeat(64), 'x'.repeat(64)],
  ])('id %j → %j', (value, id) => {
    expect(idOf(value)).toEqual({ id, notes: {} });
  });

  it.each([[0], ['0'], ['000'], [''], [[]], [['0']]])(
    'id %j es "sin mapeo" (p. 57) → null con ROOM_ID_MISSING',
    (value) => {
      expect(idOf(value)).toEqual({ id: null, notes: { ROOM_ID_MISSING: 1 } });
    },
  );

  it.each([[1.5], [-3], ['197 354'], ['x'.repeat(65)], [['1', '2']], [{ id: 1 }], [true]])(
    'id %j → null con ROOM_ID_INVALID',
    (value) => {
      expect(idOf(value)).toEqual({ id: null, notes: { ROOM_ID_INVALID: 1 } });
    },
  );

  it('roomKey sin id: `n-` y 16 hex del SHA-256 de la clave del nombre, estable', () => {
    const key = tboSyntheticRoomKey('deluxe room');
    expect(key).toBe(
      `n-${createHash('sha256').update('deluxe room', 'utf8').digest('hex').slice(0, 16)}`,
    );
    expect(key).toMatch(/^n-[0-9a-f]{16}$/);
    expect(read(withRooms([{ RoomName: 'DELUXE  ROOM' }])).result.rooms[0]?.roomKey).toBe(key);
  });

  it('el mismo roomKey dos veces: gana la primera (ROOM_DUPLICATE)', () => {
    const { result, diagnostics } = read(
      withRooms([
        { RoomName: 'Deluxe Room', imageURL: [EXAMPLE1] },
        { RoomName: 'DELUXE ROOM', imageURL: [EXAMPLE2] },
        { RoomName: 'Suite', RoomId: 5 },
        { RoomName: 'Otra', RoomId: '5' },
      ]),
    );
    expect(result.rooms.map((room) => [room.name, room.images.length])).toEqual([
      ['Deluxe Room', 1],
      ['Suite', 0],
    ]);
    expect(diagnostics.notes).toMatchObject({ ROOM_DUPLICATE: 2 });
  });

  it('sin nombre y sin id se descarta (ROOM_EMPTY); con id y sin nombre queda, con nombre vacío', () => {
    const { result, diagnostics } = read(
      withRooms([{ RoomSize: '20 m2' }, { RoomId: 7, imageURL: [EXAMPLE1] }]),
    );
    expect(result.rooms).toEqual([
      {
        roomKey: '7',
        roomId: '7',
        nameKey: '',
        name: '',
        sizeText: null,
        description: null,
        images: [EXAMPLE1],
      },
    ]);
    expect(diagnostics.notes).toEqual({ ROOM_EMPTY: 1 });
  });

  it('un nombre que no es texto se ignora con nota', () => {
    const { result, diagnostics } = read(withRooms([{ RoomName: 12, RoomId: 7 }]));
    expect(result.rooms[0]?.name).toBe('');
    expect(diagnostics.notes).toEqual({ FIELD_INVALID: 1 });
  });

  it('imágenes de TBO sin esquema o con http pasan a https (IMAGE_HTTPS_UPGRADED)', () => {
    const { result, diagnostics } = read(
      withRooms([
        {
          RoomName: 'Doble',
          RoomId: 1,
          imageURL: [
            'http://www.tboholidays.com/imageresource.aspx?img=a',
            'HTTP://api.tbotechnology.in/imageresource.aspx?img=b',
            'www.tboholidays.com/imageresource.aspx?img=c',
            '//api.tbotechnology.in/imageresource.aspx?img=d',
            'https://www.tboholidays.com/imageresource.aspx?img=e',
          ],
        },
      ]),
    );
    expect(result.rooms[0]?.images).toEqual([
      'https://www.tboholidays.com/imageresource.aspx?img=a',
      'https://api.tbotechnology.in/imageresource.aspx?img=b',
      'https://www.tboholidays.com/imageresource.aspx?img=c',
      'https://api.tbotechnology.in/imageresource.aspx?img=d',
      'https://www.tboholidays.com/imageresource.aspx?img=e',
    ]);
    expect(diagnostics.notes).toEqual({ IMAGE_HTTPS_UPGRADED: 4 });
  });

  it('subir a https o un `RoomId` 0 se cuentan, pero no son anomalías: sin warn por lote', () => {
    const { diagnostics, recorded } = read(
      withRooms([
        {
          RoomName: 'Doble',
          RoomId: 0,
          imageURL: ['www.tboholidays.com/imageresource.aspx?img=a'],
        },
      ]),
    );
    expect(diagnostics.notes).toEqual({ IMAGE_HTTPS_UPGRADED: 1, ROOM_ID_MISSING: 1 });
    expect(recorded.logs.filter((log) => log.message === 'tbo.static.anomalies')).toEqual([]);
  });

  it('fuera de los dominios de TBO no se sube nada: se descarta (IMAGE_DROPPED)', () => {
    const { result, diagnostics } = read(
      withRooms([
        {
          RoomName: 'Doble',
          RoomId: 1,
          imageURL: [
            'http://evil.test/x.jpg',
            'https://evil.test/x.jpg',
            'evil.test/x.jpg',
            'javascript:alert(1)',
            'https://user:pw@www.tboholidays.com/x',
            'https://www.tboholidays.com:8443/x',
          ],
        },
      ]),
    );
    expect(result.rooms[0]?.images).toEqual([]);
    expect(diagnostics.notes).toEqual({ IMAGE_DROPPED: 6 });
  });

  it('topes: 30 fotos, 300 de nombre, 60 de tamaño y 4.000 de descripción', () => {
    const images = Array.from(
      { length: 35 },
      (_, i) => `https://www.tboholidays.com/imageresource.aspx?img=${i}`,
    );
    const { result, diagnostics } = read(
      withRooms([
        {
          RoomName: 'N'.repeat(400),
          RoomId: 1,
          RoomSize: 'S'.repeat(80),
          RoomDescription: 'D'.repeat(5_000),
          imageURL: [...images, images[0]],
        },
      ]),
    );
    const room = result.rooms[0];
    expect(room?.images).toEqual(images.slice(0, 30));
    expect(room?.name).toHaveLength(300);
    expect(room?.nameKey).toHaveLength(300);
    expect(room?.sizeText).toHaveLength(60);
    expect(room?.description).toHaveLength(4_000);
    expect(diagnostics.notes).toEqual({ IMAGE_DROPPED: 5 });
  });

  it('tope: 100 habitaciones por hotel; el resto, ROOM_LIMIT', () => {
    const rooms = Array.from({ length: 103 }, (_, i) => ({ RoomName: `Hab ${i}`, RoomId: i + 1 }));
    const { result, diagnostics } = read(withRooms(rooms));
    expect(result.rooms).toHaveLength(100);
    expect(result.rooms.at(-1)?.roomId).toBe('100');
    expect(diagnostics.notes).toEqual({ ROOM_LIMIT: 3 });
  });

  it('cada habitación sale con un roomKey válido para el catálogo', () => {
    const { result } = read(firstHotel(inferred('hotel-details-room-array.json')));
    for (const room of result.rooms) expect(room.roomKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('readTboRoomDetails: nunca lanza', () => {
  const throwing = Object.defineProperty({ ...HOTEL }, 'Rooms', {
    enumerable: true,
    get: () => {
      throw new Error('getter roto');
    },
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['un número', 3],
    ['una lista', [1, 2]],
    ['un getter que lanza', throwing],
    ['habitaciones con cualquier cosa', withRooms([null, 1, 'x', [null], { RoomName: {} }])],
    ['campos de tipos imposibles', withRooms([{ RoomName: 'Doble', RoomId: () => 1, Size: {} }])],
  ])('%s', (_label, hotel) => {
    expect(() => read(hotel, { Rooms: 'x' })).not.toThrow();
  });

  it('un getter que lanza deja la forma `unreadable` y su métrica', () => {
    const { result, recorded } = read(throwing);
    expect(result).toEqual({ rooms: [], shape: 'unreadable' });
    expect(recorded.counters).toContainEqual({
      name: 'tbo.hotelDetails.room_detail',
      tags: { shape: 'unreadable' },
    });
  });

  it('una métrica o un logger que lanzan no cambian el resultado', () => {
    const observer = new TboStaticObserver('hotelDetails', {
      metrics: {
        counter: () => {
          throw new Error('metrics caídas');
        },
      } as unknown as MetricsPort,
      logger: {
        warn: () => {
          throw new Error('logger caído');
        },
      } as unknown as LoggerPort,
    });
    const result = readTboRoomDetails(HOTEL, {}, { observer, at: 'x', hotelId: '1000000' });
    expect(result.shape).toBe('none');
  });

  it('ni el log ni la métrica llevan valores de las habitaciones', () => {
    const { recorded } = read(
      withRooms([{ RoomName: 'Suite Secreta', RoomId: 'ID-SECRETO', Extra: 'valor-secreto' }]),
    );
    expect(JSON.stringify(recorded)).not.toMatch(/Secreta|SECRETO|secreto/);
  });
});

describe('normalizeTboRoomName: ESPEJO de `normalizeRoomName` de la web', () => {
  const WEB = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'apps',
    'web-b2b',
    'src',
    'app',
    '(app)',
    'hoteles',
    '_components',
    'room-type-groups.ts',
  );

  it('da la misma clave que la web con la MISMA tabla de vectores (ROOM_NAME_VECTORS)', async () => {
    const web = (await import(pathToFileURL(WEB).href)) as {
      ROOM_NAME_VECTORS: readonly { name: string; key: string }[];
      normalizeRoomName: (name: string) => string;
    };
    expect(web.ROOM_NAME_VECTORS.length).toBeGreaterThanOrEqual(10);
    for (const { name, key } of web.ROOM_NAME_VECTORS) {
      expect(normalizeTboRoomName(name), name).toBe(key);
      expect(web.normalizeRoomName(name), name).toBe(key);
    }
  });

  it('la clave sale del nombre TAL COMO VINO: un carácter de control separa como en la web', async () => {
    const web = (await import(pathToFileURL(WEB).href)) as {
      normalizeRoomName: (name: string) => string;
    };
    const name = 'Doble\u0001Estándar';
    const { result } = read(withRooms([{ RoomName: name, RoomId: 1 }]));
    expect(result.rooms[0]?.nameKey).toBe(web.normalizeRoomName(name));
    expect(result.rooms[0]?.name).toBe('DobleEstándar');
  });

  it('el lector guarda esa clave en `nameKey`', () => {
    const { result } = read(withRooms([{ RoomName: 'Suite Júnior (Vista al mar)', RoomId: 1 }]));
    expect(result.rooms[0]?.nameKey).toBe('suite junior vista al mar');
  });
});
