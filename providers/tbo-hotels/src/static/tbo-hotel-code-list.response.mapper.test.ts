import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import { TboCityHotelsEnvelopeSchema, type TboCityHotelsEnvelope } from './response.schema';
import { mapTboCityHotelsResponse } from './tbo-hotel-code-list.response.mapper';

/**
 * TBOHotelCodeList contra el ejemplo de p. 67-69 (normalizado, ver __fixtures__/README.md) y contra
 * los criterios de RF-32: `"ThreeStar"` → 3, `Map` `"0|0"` → sin coordenadas.
 */

function envelope(raw: unknown): TboCityHotelsEnvelope {
  return TboCityHotelsEnvelopeSchema.parse(raw);
}

type HotelFixture = Record<string, unknown>;

const P67 = JSON.parse(
  readFileSync(
    join(__dirname, '..', '__fixtures__', 'pdf', 'tbo-hotel-code-list.p67.json'),
    'utf8',
  ),
) as { Status: unknown; Hotels: HotelFixture[] };

function hotelP67(): HotelFixture {
  const hotel = P67.Hotels[0];
  if (hotel === undefined) throw new Error('fixture sin hoteles');
  return { ...hotel };
}

/** Una ciudad con los hoteles dados, pedida con el `CityCode` del ejemplo de p. 65. */
function mapCity(hotels: unknown[], countryCode?: string) {
  return mapTboCityHotelsResponse(
    envelope({ Status: { Code: 200, Description: 'Success' }, Hotels: hotels }),
    { cityCode: '130452', ...(countryCode === undefined ? {} : { countryCode }) },
  );
}

describe('mapTboCityHotelsResponse: el ejemplo de p. 67-69', () => {
  const mapping = mapTboCityHotelsResponse(envelope(P67), {
    cityCode: '130452',
    countryCode: 'US',
  });

  it('la fila de catálogo: estrellas 3 desde "ThreeStar" (RF-32 CA), Map, país y dirección', () => {
    expect(mapping.cityCode).toBe('130452');
    expect(mapping.hotels).toEqual([
      {
        hotelId: '1010099',
        name: 'Holiday Inn Express New York - Manhattan West Side',
        stars: 3,
        location: { lat: 40.764167, lng: -73.994468 },
        // Sin el espacio final de p. 67, y sin "arreglar" el `CityNew` pegado (CE-12).
        address: '538 West 48th Street New York CityNew York 10036',
        zipcode: '10036',
        countryCode: 'US',
        // El `CityCode` de la REQUEST: el ejemplo no trae `CityId` (p. 66-69).
        cityCode: '130452',
      },
    ]);
  });

  it('el contenido `listing`: en inglés por inferencia, sin imágenes ni horarios (CE-09)', () => {
    const [content] = mapping.listingContents;
    expect(content).toMatchObject({
      hotelId: '1010099',
      lang: 'en',
      source: 'listing',
      images: [],
      checkInTime: null,
      checkOutTime: null,
      phone: '1-212-582-0692',
      // Es un enlace: `http` se admite (p. 69).
      websiteUrl: 'http://www.ihg.com/holidayinnexpress/hotels/us/en/new-york/nychk/hotel',
      unavailableFacilities: [],
    });
    expect(content?.facilities).toHaveLength(26);
    expect(content?.facilities).toContain('Wheelchair accessible (may have limitations)');
    expect(content?.sections.map((section) => section.label)).toEqual([
      'HeadLine',
      'Location',
      'Rooms',
      'Dining',
      'CheckIn Instructions',
      'Special Instructions',
    ]);
    expect(content?.descriptionHtml).toBe(hotelP67()['Description']);
  });

  it('Attractions: los tres trozos se unen con "," y vuelve a leerse el HTML entero (p. 67-68)', () => {
    const html = mapping.listingContents[0]?.attractionsHtml ?? '';
    expect(html).toContain('<br> New York, NY (NYS-Skyports Seaplane Base) - 4.9 km / 3 mi');
    expect(html).toContain('<br> Teterboro, NJ (TEB) - 18.7 km / 11.6 mi');
    expect(html.startsWith('Distances are displayed to the nearest 0.1 mile and kilometer.')).toBe(
      true,
    );
    expect(html).not.toContain('<br />');
  });

  it('sin anomalías: ninguna nota, ningún descarte, ninguna clave desconocida', () => {
    expect(mapping.diagnostics).toEqual({
      received: 1,
      mapped: 1,
      rejected: {},
      notes: {},
      unknownKeys: [],
    });
  });
});

describe('mapTboCityHotelsResponse: tolerancia (05 §3)', () => {
  it('RF-32 CA: `Map` "0|0" → sin coordenadas, y el hotel sigue en el catálogo', () => {
    const mapping = mapCity([{ ...hotelP67(), Map: '0|0' }]);
    expect(mapping.hotels).toHaveLength(1);
    expect(mapping.hotels[0]?.location).toBeNull();
    expect(mapping.diagnostics.notes).toEqual({ MAP_ZERO: 1 });
  });

  it('un `CountryCode` inválido o ausente toma el país de la ciudad', () => {
    const mapping = mapCity(
      [
        { ...hotelP67(), HotelCode: '1', CountryCode: 'USA' },
        { HotelCode: '2', HotelName: 'Sin país' },
      ],
      'US',
    );
    expect(mapping.hotels.map((hotel) => hotel.countryCode)).toEqual(['US', 'US']);
    expect(mapping.diagnostics.notes).toMatchObject({ COUNTRY_INVALID: 1, COUNTRY_FROM_CITY: 2 });
  });

  it('sin país de ciudad, un `CountryCode` inválido queda null', () => {
    const mapping = mapCity([{ HotelCode: '1', CountryCode: 1 }]);
    expect(mapping.hotels[0]?.countryCode).toBeNull();
  });

  it('un campo con un tipo imposible se ignora con nota; el hotel no se pierde', () => {
    const mapping = mapCity([
      {
        HotelCode: '1',
        HotelName: 'Hotel',
        HotelFacilities: 42,
        HotelRating: { stars: 3 },
        Map: ['1', '2'],
        Attractions: 7,
      },
    ]);
    expect(mapping.hotels).toEqual([
      {
        hotelId: '1',
        name: 'Hotel',
        stars: null,
        location: null,
        address: null,
        zipcode: null,
        countryCode: null,
        cityCode: '130452',
      },
    ]);
    expect(mapping.diagnostics.notes).toEqual({ FIELD_INVALID: 4 });
  });

  it('una clasificación desconocida no inventa estrellas', () => {
    const mapping = mapCity([
      { HotelCode: '1', HotelRating: 'SevenStar' },
      { HotelCode: '2', HotelRating: 'All' },
    ]);
    expect(mapping.hotels.map((hotel) => hotel.stars)).toEqual([null, null]);
    expect(mapping.diagnostics.notes).toEqual({ STARS_UNKNOWN: 1 });
  });

  it('un hotel sin `HotelCode` legible o repetido se descarta; los demás siguen', () => {
    const mapping = mapCity([
      { HotelName: 'Sin código' },
      { HotelCode: '12,3' },
      { HotelCode: 1010099, HotelName: 'Número' },
      { HotelCode: '1010099', HotelName: 'Repetido' },
      'no soy un hotel',
    ]);
    expect(mapping.hotels.map((hotel) => [hotel.hotelId, hotel.name])).toEqual([
      ['1010099', 'Número'],
    ]);
    expect(mapping.diagnostics).toMatchObject({
      received: 5,
      mapped: 1,
      rejected: { ITEM_SCHEMA: 3, DUPLICATE: 1 },
    });
  });

  it('la ciudad es la de la request aunque la respuesta traiga otro `CityId`', () => {
    const mapping = mapCity([{ HotelCode: '1', CityId: '999999' }]);
    expect(mapping.hotels[0]?.cityCode).toBe('130452');
  });

  it('un hotel sin nada de contenido entra al catálogo pero no a `listingContents`', () => {
    const mapping = mapCity([{ HotelCode: '1', HotelName: 'Sólo catálogo', Map: '1|2' }]);
    expect(mapping.hotels).toHaveLength(1);
    expect(mapping.listingContents).toEqual([]);
  });

  it('las dos grafías de la web (CE-09) y una clave con otro casing', () => {
    const mapping = mapCity([
      { HotelCode: '1', HotelWebsiteURL: 'https://a.test/' },
      { HotelCode: '2', hotelname: 'minúsculas' },
      { HotelCode: '3', hotelname: 'a', HOTELNAME: 'b' },
    ]);
    expect(mapping.listingContents[0]?.websiteUrl).toBe('https://a.test/');
    expect(mapping.hotels.map((hotel) => hotel.name)).toEqual([null, 'minúsculas', null]);
    expect(mapping.diagnostics.notes).toMatchObject({ CASING_VARIANT: 1, FIELD_INVALID: 1 });
  });

  it('registra el NOMBRE de una clave nueva, nunca su valor', () => {
    const mapping = mapCity([{ HotelCode: '1', Altitude: '2640', GiataId: 'secret-value' }]);
    expect(mapping.diagnostics.unknownKeys).toEqual(['Hotels[].Altitude', 'Hotels[].GiataId']);
    expect(JSON.stringify(mapping.diagnostics)).not.toContain('secret-value');
  });

  it('una web que no es http(s) se descarta con nota', () => {
    const mapping = mapCity([{ HotelCode: '1', HotelWebsiteUrl: 'javascript:alert(1)' }]);
    expect(mapping.listingContents).toEqual([]);
    expect(mapping.diagnostics.notes).toEqual({ WEBSITE_DROPPED: 1 });
  });

  it('el contexto sin `cityCode` válido es un error de cableado', () => {
    expect(() => mapTboCityHotelsResponse(envelope(P67), { cityCode: '' })).toThrow(
      TboResponseMappingError,
    );
    expect(() =>
      mapTboCityHotelsResponse(envelope(P67), { cityCode: '1', countryCode: 'usa' }),
    ).toThrow(TboResponseMappingError);
  });
});

describe('mapTboCityHotelsResponse: Latitude/Longitude (producción, 2026-09-29; 05 §2.5)', () => {
  // Claves observadas en producción; valores y tipos construidos (ver __fixtures__/README.md).
  const OBSERVED = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        '__fixtures__',
        'observed',
        'tbo-hotel-code-list.latitude-longitude.json',
      ),
      'utf8',
    ),
  ) as unknown;
  const mapping = mapTboCityHotelsResponse(envelope(OBSERVED), {
    cityCode: '130452',
    countryCode: 'US',
  });

  it('número o string numérico mandan sobre Map; 0/0 o vacías ceden a Map', () => {
    expect(mapping.hotels.map((hotel) => [hotel.hotelId, hotel.location])).toEqual([
      // Números, iguales a su Map (el hotel de p. 67).
      ['1010099', { lat: 40.764167, lng: -73.994468 }],
      // Strings numéricos: se usan aunque Map sea "0|0", que ni se consulta.
      ['1010100', { lat: 40.758, lng: -73.9855 }],
      // 0/0 es un dato vacío: cae a Map.
      ['1010101', { lat: 40.7484, lng: -73.9857 }],
      // Vacías son ausencia: Map, sin nota.
      ['1010102', { lat: 40.7527, lng: -73.9772 }],
    ]);
  });

  it('ya no son claves desconocidas; sólo el 0/0 deja nota', () => {
    expect(mapping.diagnostics).toMatchObject({
      received: 4,
      mapped: 4,
      rejected: {},
      notes: { LAT_LNG_ZERO: 1 },
      unknownKeys: [],
    });
  });

  it('una pareja inválida deja su nota y cede a Map; sin Map, sin coordenadas', () => {
    const mapped = mapCity([
      { HotelCode: '1', Latitude: '91', Longitude: '10', Map: '4.6|-74.08' },
      { HotelCode: '2', Latitude: 4.6, Map: '4.61|-74.09' },
      { HotelCode: '3', Latitude: { deg: 4 }, Longitude: -74, Map: '4.62|-74.1' },
      { HotelCode: '4', Latitude: 'x', Longitude: 'y' },
    ]);
    expect(mapped.hotels.map((hotel) => hotel.location)).toEqual([
      { lat: 4.6, lng: -74.08 },
      { lat: 4.61, lng: -74.09 },
      { lat: 4.62, lng: -74.1 },
      null,
    ]);
    expect(mapped.diagnostics.notes).toEqual({ LAT_LNG_INVALID: 4, FIELD_INVALID: 1 });
    expect(mapped.diagnostics.unknownKeys).toEqual([]);
  });
});
