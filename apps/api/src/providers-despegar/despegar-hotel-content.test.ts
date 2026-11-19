import type { DespegarHotelContent } from '@sales-travel/despegar-hotels';
import { describe, expect, it, vi } from 'vitest';
import {
  despegarContentRecord,
  despegarRoomContent,
  hhmm,
  roomNameKey,
  toDespegarLanguage,
} from './despegar-hotel-content.js';
import {
  DespegarHotelProviderAdapter,
  type DespegarHotelsAcl,
} from './despegar-hotel-provider.adapter.js';

/*
 * Las fotos de los resultados y de las habitaciones de Despegar salen de `/content-api/hotels`:
 * la disponibilidad no las trae. Se guardan en el catálogo por los puertos de contenido.
 */

const CTX = { tenantId: 't1', requestId: 'r1' };
const OPTS = { timeoutMs: 1000 };

function hotel(over: Partial<DespegarHotelContent> = {}): DespegarHotelContent {
  return {
    id: '101',
    name: 'Hotel Andino',
    stars: 4,
    information: { es: '<p>Hotel <b>céntrico</b></p>', en: 'Central hotel' },
    notices: {},
    pictures: ['https://media.staticontent.com/a.jpg', 'https://media.staticontent.com/b.jpg'],
    amenityIds: [],
    phones: ['+57 1 555'],
    checkInFrom: '15:00:00',
    checkOutTo: '12:00',
    roomTypes: [
      {
        id: 'RT-1',
        name: { es: 'Doble Estándar' },
        description: { es: 'Dos camas' },
        pictures: ['https://media.staticontent.com/r.jpg'],
      },
    ],
    ...over,
  };
}

function adapterWith(found: DespegarHotelContent[]) {
  const getHotelsContent = vi.fn(() => Promise.resolve(found));
  const acl = { getHotelsContent } as unknown as DespegarHotelsAcl;
  return { adapter: new DespegarHotelProviderAdapter(acl), getHotelsContent };
}

describe('piezas', () => {
  it('idioma, horario y nombre normalizado como la web', () => {
    expect([toDespegarLanguage('es'), toDespegarLanguage('en'), toDespegarLanguage('pt')]).toEqual([
      'ES',
      'EN',
      'PT',
    ]);
    expect([hhmm('15:00:00'), hhmm('2:30 PM'), hhmm('12:00 am'), hhmm('mediodía')]).toEqual([
      '15:00',
      '14:30',
      '00:00',
      null,
    ]);
    expect(roomNameKey('Doble Estándar  (Vista)')).toBe('doble estandar vista');
  });

  it('la fila del catálogo: texto plano, fotos y una huella estable', () => {
    const a = despegarContentRecord(hotel(), 'es');
    expect(a).toMatchObject({
      hotelId: '101',
      lang: 'es',
      source: 'details',
      name: 'Hotel Andino',
      descriptionHtml: 'Hotel céntrico',
      images: ['https://media.staticontent.com/a.jpg', 'https://media.staticontent.com/b.jpg'],
      phone: '+57 1 555',
      checkInTime: '15:00',
      checkOutTime: '12:00',
    });
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(despegarContentRecord(hotel(), 'es').contentHash).toBe(a.contentHash);
    expect(despegarContentRecord(hotel({ pictures: [] }), 'es').contentHash).not.toBe(
      a.contentHash,
    );
    // Sin el idioma pedido, el español.
    expect(despegarContentRecord(hotel(), 'pt').descriptionHtml).toBe('Hotel céntrico');
  });

  it('una habitación con id inválido no sale', () => {
    expect(
      despegarRoomContent({ id: 'con espacios', name: {}, description: {}, pictures: [] }, 'es'),
    ).toBeUndefined();
    expect(
      despegarRoomContent({ id: '0', name: {}, description: {}, pictures: [] }, 'es'),
    ).toBeUndefined();
  });
});

describe('puertos de contenido del adaptador', () => {
  it('lote: los que volvieron con su fila, los demás confirmados sin contenido', async () => {
    const { adapter, getHotelsContent } = adapterWith([hotel()]);
    const batch = await adapter.fetchHotelContents(['101', '102'], 'en', CTX, OPTS);
    expect(getHotelsContent).toHaveBeenCalledWith(['101', '102'], 'EN');
    expect(batch.contents.map((c) => [c.hotelId, c.lang, c.images.length])).toEqual([
      ['101', 'en', 2],
    ]);
    expect(batch.missingHotelIds).toEqual(['102']);
    expect(adapter.contentBatchSize).toBe(50);
  });

  it('ficha de un hotel; si Despegar no lo trae, null', async () => {
    expect(
      await adapterWith([hotel()]).adapter.fetchHotelContent('101', 'es', CTX, OPTS),
    ).toMatchObject({ hotelId: '101', stars: 4, images: expect.any(Array) as unknown });
    expect(await adapterWith([]).adapter.fetchHotelContent('101', 'es', CTX, OPTS)).toBeNull();
  });

  it('habitaciones con su id = el roomTypeId de las tarifas', async () => {
    expect(
      await adapterWith([hotel()]).adapter.fetchHotelRoomContent('101', 'es', CTX, OPTS),
    ).toEqual({
      lang: 'es',
      outcome: 'rooms',
      rooms: [
        {
          roomKey: 'RT-1',
          roomRef: 'RT-1',
          nameKey: 'doble estandar',
          name: 'Doble Estándar',
          sizeText: null,
          description: 'Dos camas',
          images: ['https://media.staticontent.com/r.jpg'],
        },
      ],
    });
    expect(
      await adapterWith([hotel({ roomTypes: [] })]).adapter.fetchHotelRoomContent(
        '101',
        'es',
        CTX,
        OPTS,
      ),
    ).toEqual({ lang: 'es', outcome: 'unreadable', rooms: [] });
    expect(await adapterWith([]).adapter.fetchHotelRoomContent('101', 'es', CTX, OPTS)).toEqual({
      lang: 'es',
      outcome: 'none',
      rooms: [],
    });
  });
});

describe('fotos que el CDN ya no tiene', () => {
  const dead = new Set([
    'https://media.staticontent.com/a.jpg',
    'https://media.staticontent.com/r.jpg',
  ]);
  const pictures = vi.fn((urls: readonly string[]) =>
    Promise.resolve(urls.filter((u) => !dead.has(u))),
  );

  function filtered(found: DespegarHotelContent[]) {
    const acl = {
      getHotelsContent: vi.fn(() => Promise.resolve(found)),
    } as unknown as DespegarHotelsAcl;
    return new DespegarHotelProviderAdapter(acl, { pictures });
  }

  it('la ficha y el lote guardan sólo las que abren: la tarjeta toma la primera buena', async () => {
    const one = await filtered([hotel()]).fetchHotelContent('101', 'es', CTX, OPTS);
    expect(one?.images).toEqual(['https://media.staticontent.com/b.jpg']);
    const batch = await filtered([hotel()]).fetchHotelContents(['101'], 'es', CTX, OPTS);
    expect(batch.contents[0]?.images).toEqual(['https://media.staticontent.com/b.jpg']);
  });

  it('las habitaciones también', async () => {
    const rooms = await filtered([hotel()]).fetchHotelRoomContent('101', 'es', CTX, OPTS);
    expect(rooms.rooms[0]?.images).toEqual([]);
  });
});
