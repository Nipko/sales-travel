import { describe, expect, it } from 'vitest';
import { hotelImageProxyUrl } from '../../../../lib/hotel-image-proxy';
import {
  REFERENCE_PHOTO_NOTE,
  ROOM_CONTENT_MAX_IMAGES,
  ROOM_CONTENT_MAX_ROOMS,
  ROOM_CONTENT_NONE,
  ROOM_CONTENT_RETRY_DEFAULT_MS,
  clampRoomContentRetry,
  hasPendingRoomContent,
  parseRoomContent,
  parseRoomContentReply,
  roomPhotosLabel,
  roomSizeLabel,
  settlePendingRoomContent,
} from './room-content-view';

/*
 * La respuesta de las habitaciones de un hotel (TBO-06) leída por la pantalla: sólo rutas del proxy
 * propio, texto plano con topes y, ante cualquier cosa que no se entienda, `none`.
 */

const PHOTO = (n: number) =>
  hotelImageProxyUrl(`https://www.tboholidays.com/imageresource.aspx?img=room-${n}.jpg`) ?? '';

function habitacion(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roomKey: '197354',
    roomId: '197354',
    nameKey: 'deluxe room 1 king bed',
    name: 'Deluxe Room, 1 King Bed',
    sizeText: '1830 ft',
    sizeM2: 170,
    description: 'Vista al jardín, escritorio y baño con ducha.',
    images: [PHOTO(1), PHOTO(2)],
    ...extra,
  };
}

function ready(rooms: unknown[]): Record<string, unknown> {
  return {
    providerCode: 'tbo-hotels',
    hotelId: '1402689',
    requestedLang: 'es',
    lang: 'es',
    langFallback: false,
    status: 'ready',
    rooms,
  };
}

describe('parseRoomContent', () => {
  it('una habitación completa llega tal cual, con sus fotos por el proxy', () => {
    const res = parseRoomContent(ready([habitacion()]));
    expect(res).toEqual({
      status: 'ready',
      rooms: [
        {
          roomKey: '197354',
          roomId: '197354',
          nameKey: 'deluxe room 1 king bed',
          name: 'Deluxe Room, 1 King Bed',
          sizeText: '1830 ft',
          sizeM2: 170,
          description: 'Vista al jardín, escritorio y baño con ducha.',
          images: [PHOTO(1), PHOTO(2)],
        },
      ],
    });
  });

  it('sólo rutas del proxy propio: la URL del proveedor, http o rutas con query no entran', () => {
    const res = parseRoomContent(
      ready([
        habitacion({
          images: [
            'https://www.tboholidays.com/imageresource.aspx?img=room-1.jpg',
            'http://www.tboholidays.com/x.jpg',
            '/api/hotels/images/abc?w=1',
            '/api/hotels/../admin',
            42,
            PHOTO(3),
            PHOTO(3),
          ],
        }),
      ]),
    );
    expect(res.rooms[0]?.images).toEqual([PHOTO(3)]);
    expect(JSON.stringify(res)).not.toContain('tboholidays.com');
  });

  it(`hasta ${ROOM_CONTENT_MAX_IMAGES} fotos por habitación y ${ROOM_CONTENT_MAX_ROOMS} habitaciones`, () => {
    const images = Array.from({ length: 40 }, (_, i) => PHOTO(i));
    const rooms = Array.from({ length: 120 }, (_, i) =>
      habitacion({ roomKey: `r${i}`, roomId: `${i + 1}`, images }),
    );
    const res = parseRoomContent(ready(rooms));
    expect(res.rooms).toHaveLength(ROOM_CONTENT_MAX_ROOMS);
    expect(res.rooms[0]?.images).toHaveLength(ROOM_CONTENT_MAX_IMAGES);
  });

  it('una habitación sin roomKey válido se descarta; un roomKey repetido, también', () => {
    const res = parseRoomContent(
      ready([
        habitacion({ roomKey: '0' }),
        habitacion({ roomKey: 'con espacio' }),
        habitacion({ roomKey: 7 }),
        habitacion({ roomKey: 'n-abc' }),
        habitacion({ roomKey: 'n-abc', name: 'Otra' }),
      ]),
    );
    expect(res.rooms.map((r) => r.roomKey)).toEqual(['n-abc']);
  });

  it('id 0, vacío o con caracteres raros: sin id (se enlaza sólo por nombre)', () => {
    for (const roomId of ['0', '', 'a b', null, 197354]) {
      expect(parseRoomContent(ready([habitacion({ roomId })])).rooms[0]?.roomId).toBeNull();
    }
  });

  it('la clave del nombre se normaliza como la de la tarifa; sin clave, sale del nombre', () => {
    expect(
      parseRoomContent(ready([habitacion({ nameKey: 'DELUXE ROOM - 1 King Bed' })])).rooms[0]
        ?.nameKey,
    ).toBe('deluxe room 1 king bed');
    expect(
      parseRoomContent(ready([habitacion({ nameKey: null, name: 'Suite Júnior' })])).rooms[0]
        ?.nameKey,
    ).toBe('suite junior');
    const sinNada = parseRoomContent(ready([habitacion({ nameKey: '!!!', name: null })]));
    expect(sinNada.rooms[0]?.nameKey).toBeNull();
  });

  it('textos con topes; una descripción con marcas no se muestra', () => {
    const res = parseRoomContent(
      ready([
        habitacion({
          name: 'x'.repeat(301),
          sizeText: 'y'.repeat(61),
          description: '<b>Suite</b> con vista',
        }),
      ]),
    );
    expect(res.rooms[0]).toMatchObject({ name: null, sizeText: null, description: null });
    expect(
      parseRoomContent(ready([habitacion({ description: 'z'.repeat(4_001) })])).rooms[0]
        ?.description,
    ).toBeNull();
  });

  it('el tamaño en m² sólo dentro de 5..500', () => {
    for (const sizeM2 of [4, 501, Number.NaN, '25', null]) {
      expect(parseRoomContent(ready([habitacion({ sizeM2 })])).rooms[0]?.sizeM2).toBeNull();
    }
    expect(parseRoomContent(ready([habitacion({ sizeM2: 25.5 })])).rooms[0]?.sizeM2).toBe(25.5);
  });

  it('pending lleva su espera acotada; none y disabled, sin habitaciones', () => {
    expect(parseRoomContent({ status: 'pending', retryAfterMs: 3_000, rooms: [] })).toEqual({
      status: 'pending',
      retryAfterMs: 3_000,
      rooms: [],
    });
    expect(parseRoomContent({ status: 'pending', retryAfterMs: 0 }).retryAfterMs).toBe(1_000);
    expect(parseRoomContent({ status: 'pending' }).retryAfterMs).toBe(
      ROOM_CONTENT_RETRY_DEFAULT_MS,
    );
    expect(parseRoomContent({ status: 'none', rooms: [habitacion()] })).toEqual({
      status: 'none',
      rooms: [],
    });
    expect(parseRoomContent({ status: 'disabled', rooms: [] }).status).toBe('disabled');
  });

  it('lo que no se entiende es none: nunca rompe la ficha', () => {
    for (const raw of [
      null,
      undefined,
      'ready',
      [],
      { status: 'otro' },
      { status: 'ready' },
      { status: 'ready', rooms: 'x' },
      ready([]),
      ready([null, 'x', [], habitacion({ roomKey: '' })]),
    ]) {
      expect(parseRoomContent(raw)).toEqual(ROOM_CONTENT_NONE);
    }
  });
});

describe('parseRoomContentReply', () => {
  it('sólo los proveedores que dan contenido; cada uno por el lector', () => {
    const reply = parseRoomContentReply({
      byProvider: { 'tbo-hotels': ready([habitacion()]), 'despegar-hotels': ready([habitacion()]) },
    });
    expect(Object.keys(reply?.byProvider ?? {})).toEqual(['tbo-hotels']);
    expect(reply?.byProvider['tbo-hotels']?.status).toBe('ready');
  });

  it('sin byProvider no es una respuesta', () => {
    expect(parseRoomContentReply(null)).toBeUndefined();
    expect(parseRoomContentReply({})).toBeUndefined();
    expect(parseRoomContentReply({ byProvider: [] })).toBeUndefined();
    expect(parseRoomContentReply({ byProvider: {} })).toEqual({ byProvider: {} });
  });
});

describe('pending', () => {
  const pending = { byProvider: { 'tbo-hotels': parseRoomContent({ status: 'pending' }) } };

  it('se detecta, y al darlo por terminado queda none', () => {
    expect(hasPendingRoomContent(pending)).toBe(true);
    const settled = settlePendingRoomContent(pending);
    expect(settled.byProvider['tbo-hotels']).toEqual(ROOM_CONTENT_NONE);
    expect(hasPendingRoomContent(settled)).toBe(false);
  });

  it('sin pending, la misma respuesta', () => {
    const reply = { byProvider: { 'tbo-hotels': ROOM_CONTENT_NONE } };
    expect(settlePendingRoomContent(reply)).toBe(reply);
  });

  it('la espera se acota entre 1 y 10 s', () => {
    expect(clampRoomContentRetry(50)).toBe(1_000);
    expect(clampRoomContentRetry(60_000)).toBe(10_000);
    expect(clampRoomContentRetry('3000')).toBe(ROOM_CONTENT_RETRY_DEFAULT_MS);
  });
});

describe('textos', () => {
  it('el tamaño en m² con «≈»; si no se pudo convertir, el texto del proveedor', () => {
    expect(roomSizeLabel({ sizeM2: 25, sizeText: '25 m2' })).toBe('≈ 25 m²');
    expect(roomSizeLabel({ sizeM2: 22.5, sizeText: null })).toBe('≈ 22,5 m²');
    expect(roomSizeLabel({ sizeM2: null, sizeText: 'Amplia' })).toBe('Amplia');
    expect(roomSizeLabel({ sizeM2: null, sizeText: null })).toBeUndefined();
  });

  it('el botón de la miniatura dice cuántas fotos abre', () => {
    expect(roomPhotosLabel(1, 'Doble')).toBe('Ver la foto de Doble');
    expect(roomPhotosLabel(6, 'Doble')).toBe('Ver 6 fotos de Doble');
    expect(REFERENCE_PHOTO_NOTE).toBe(
      'Es la foto de una habitación con el mismo nombre en el catálogo del proveedor.',
    );
  });
});
