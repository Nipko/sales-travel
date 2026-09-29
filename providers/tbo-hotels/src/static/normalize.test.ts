import { describe, expect, it } from 'vitest';
import {
  joinTboAttractions,
  normalizeTboCheckTime,
  normalizeTboCountryCode,
  normalizeTboImageUrl,
  normalizeTboLatLng,
  normalizeTboMap,
  normalizeTboStars,
  normalizeTboText,
  normalizeTboWebsiteUrl,
  toTboTextList,
} from './normalize';

/**
 * La tabla de normalización de docs/tbo/05 §3, fila por fila. Cada caso cita la página del PDF de
 * donde sale la forma observada, o dice que es una forma defensiva.
 */

describe('HotelRating → 1-5 (CE-02; Q-68)', () => {
  it.each([
    ['ThreeStar', 3], // TBOHotelCodeList, p. 67
    ['OneStar', 1],
    ['TwoStar', 2],
    ['FourStar', 4],
    ['FiveStar', 5],
    ['threestar', 3],
    [' Three_Star ', 3],
    ['4', 4],
    ['4.5', 4.5],
  ] as const)('%j → %d', (raw, stars) => {
    expect(normalizeTboStars(raw)).toEqual({ stars, known: true });
  });

  it.each([5, 1, 3.5])('el número %d (HotelDetails, p. 62) pasa tal cual', (raw) => {
    expect(normalizeTboStars(raw)).toEqual({ stars: raw, known: true });
  });

  it.each(['All', 0, '0', ''] as const)('%j es "sin estrellas", no un valor raro', (raw) => {
    expect(normalizeTboStars(raw)).toEqual({ stars: null, known: true });
  });

  it.each(['SixStar', 6, -1, 3.3, 'Luxury', Number.NaN] as const)(
    '%j es desconocido: sin estrellas y marcado',
    (raw) => {
      expect(normalizeTboStars(raw)).toEqual({ stars: null, known: false });
    },
  );
});

describe('Map "lat|lon" → {lat, lng}', () => {
  it('lee los dos ejemplos del PDF (p. 62 y 69)', () => {
    expect(normalizeTboMap('24.08166|32.88985')).toEqual({
      location: { lat: 24.08166, lng: 32.88985 },
    });
    expect(normalizeTboMap('40.764167|-73.994468')).toEqual({
      location: { lat: 40.764167, lng: -73.994468 },
    });
  });

  it('"0|0" no es un hotel en el golfo de Guinea: sin coordenadas (RF-32 CA)', () => {
    expect(normalizeTboMap('0|0')).toEqual({ location: null, issue: 'MAP_ZERO' });
    expect(normalizeTboMap('0.0|0.000')).toEqual({ location: null, issue: 'MAP_ZERO' });
  });

  it('un solo eje en cero sí es una coordenada', () => {
    expect(normalizeTboMap('0|32.5')).toEqual({ location: { lat: 0, lng: 32.5 } });
  });

  it('tolera espacios alrededor del separador', () => {
    expect(normalizeTboMap(' 24.08 | 32.88 ')).toEqual({ location: { lat: 24.08, lng: 32.88 } });
  });

  it.each(['24.08166', '24.08166,32.88985', '1|2|3', 'abc|def', '91|10', '10|181', '1e3|2'])(
    '%j está malformado',
    (raw) => {
      expect(normalizeTboMap(raw)).toEqual({ location: null, issue: 'MAP_INVALID' });
    },
  );

  it('un texto vacío es ausencia, sin nota', () => {
    expect(normalizeTboMap('  ')).toEqual({ location: null });
  });
});

describe('Latitude / Longitude de TBOHotelCodeList (producción, 2026-09-29)', () => {
  it('número o string numérico, en cualquier combinación', () => {
    expect(normalizeTboLatLng(40.764167, -73.994468)).toEqual({
      location: { lat: 40.764167, lng: -73.994468 },
    });
    expect(normalizeTboLatLng(' 4.60971 ', '-74.08175')).toEqual({
      location: { lat: 4.60971, lng: -74.08175 },
    });
    expect(normalizeTboLatLng('10.4', -75.51)).toEqual({ location: { lat: 10.4, lng: -75.51 } });
  });

  it('los dos en cero son un dato vacío, como Map "0|0"', () => {
    expect(normalizeTboLatLng(0, 0)).toEqual({ location: null, issue: 'LAT_LNG_ZERO' });
    expect(normalizeTboLatLng('0.0', '0')).toEqual({ location: null, issue: 'LAT_LNG_ZERO' });
  });

  it('un solo eje en cero sí es una coordenada', () => {
    expect(normalizeTboLatLng(0, -78.5)).toEqual({ location: { lat: 0, lng: -78.5 } });
  });

  it('los dos ausentes o vacíos son ausencia, sin nota', () => {
    expect(normalizeTboLatLng(undefined, undefined)).toEqual({ location: null });
    expect(normalizeTboLatLng(' ', '')).toEqual({ location: null });
  });

  it.each<[string | number | undefined, string | number | undefined]>([
    [91, 10],
    [10, -181],
    ['4,6', '-74'],
    ['abc', '10'],
    ['1e1', '10'],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
    [4.6, undefined],
    [undefined, '-74.08'],
    ['', -74.08],
  ])('%j | %j no da un punto', (lat, lng) => {
    expect(normalizeTboLatLng(lat, lng)).toEqual({ location: null, issue: 'LAT_LNG_INVALID' });
  });
});

describe('CountryCode', () => {
  it('ISO2 en mayúsculas (p. 62, 68)', () => {
    expect(normalizeTboCountryCode('EG')).toBe('EG');
    expect(normalizeTboCountryCode(' us ')).toBe('US');
  });

  it.each(['USA', '1', 1, '', 'U5'])('%j no es ISO2', (raw) => {
    expect(normalizeTboCountryCode(raw)).toBeNull();
  });
});

describe('CheckInTime / CheckOutTime → HH:mm', () => {
  it.each([
    ['3:00 PM', '15:00'], // p. 62
    ['12:00 PM', '12:00'], // p. 62
    ['12:00 AM', '00:00'],
    ['11:30 am', '11:30'],
    ['3 PM', '15:00'],
    ['3:00 p.m.', '15:00'],
    ['14:00', '14:00'],
    ['09:05', '09:05'],
    ['14:00:00', '14:00'],
  ])('%j → %s', (raw, time) => {
    expect(normalizeTboCheckTime(raw)).toBe(time);
  });

  it.each(['noon', '3', '25:00', '13:00 PM', '0:00 AM', '10:75', 'after 3 PM', ''])(
    '%j no se adivina',
    (raw) => {
      expect(normalizeTboCheckTime(raw)).toBeNull();
    },
  );
});

describe('Images: sólo https (RNF-16)', () => {
  const tbo =
    'https://api.tbotechnology.in/imageresource.aspx?img=9eMP+0FIICgCIk6ZClzZH9Cs+1gwAq6BFWcc22yNLMF/UJIXMdxPdTX9IMA+gOFHIZ0e6X2r2Pe98Nnf1JsUZ4vSpJuSO2+iow8K6weUG+E=';

  it('la URL de p. 62 queda intacta, `+`, `/` y `=` incluidos', () => {
    expect(normalizeTboImageUrl(tbo)).toBe(tbo);
  });

  it.each([
    'http://api.tbotechnology.in/imageresource.aspx?img=x',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//api.tbotechnology.in/x.jpg',
    'imageresource.aspx?img=x',
    'https://user:pass@example.com/x.jpg',
    `https://example.com/${'a'.repeat(2_100)}`,
    '',
  ])('%j no es una imagen servible', (raw) => {
    expect(normalizeTboImageUrl(raw)).toBeNull();
  });

  it('un valor que no es texto no es una URL', () => {
    expect(normalizeTboImageUrl({ url: tbo })).toBeNull();
    expect(normalizeTboImageUrl(42)).toBeNull();
  });

  it('escapa lo que no puede ir crudo en un atributo', () => {
    expect(normalizeTboImageUrl('https://x.test/a b".jpg')).toBe('https://x.test/a%20b%22.jpg');
  });
});

describe('HotelWebsiteUrl: http o https (es un enlace, p. 69)', () => {
  it('conserva la web http del ejemplo', () => {
    expect(
      normalizeTboWebsiteUrl(
        'http://www.ihg.com/holidayinnexpress/hotels/us/en/new-york/nychk/hotel',
      ),
    ).toBe('http://www.ihg.com/holidayinnexpress/hotels/us/en/new-york/nychk/hotel');
  });

  it.each(['javascript:alert(1)', 'ftp://x.test', 'www.ihg.com', 'https://a:b@x.test'])(
    '%j no es un enlace que se pueda mostrar',
    (raw) => {
      expect(normalizeTboWebsiteUrl(raw)).toBeNull();
    },
  );
});

describe('texto de una línea', () => {
  it('recorta los espacios finales de la dirección de p. 67 sin "arreglarla"', () => {
    expect(normalizeTboText('538 West 48th Street New York CityNew York 10036 ', 500)).toBe(
      '538 West 48th Street New York CityNew York 10036',
    );
  });

  it('un número declarado Integer pasa a string (PinCode, p. 59)', () => {
    expect(normalizeTboText(81511, 20)).toBe('81511');
  });

  it('colapsa saltos, NBSP y controles; vacío es null; recorta al techo', () => {
    expect(normalizeTboText('a\n\u00a0 b\u0000\u001bc', 50)).toBe('a bc');
    expect(normalizeTboText(' \t ', 50)).toBeNull();
    expect(normalizeTboText('x'.repeat(10), 4)).toBe('xxxx');
  });
});

describe('listas', () => {
  it('HotelFacilities como array (p. 60) o como el String de la tabla, partido por comas', () => {
    expect(toTboTextList(['Library', 'Free WiFi'])).toEqual({
      items: ['Library', 'Free WiFi'],
      dropped: 0,
    });
    expect(toTboTextList('Library,Free WiFi')).toEqual({
      items: ['Library', 'Free WiFi'],
      dropped: 0,
    });
  });

  it('cuenta los elementos que no son texto', () => {
    expect(toTboTextList(['Library', 3, null, { x: 1 }])).toEqual({
      items: ['Library', '3'],
      dropped: 2,
    });
  });
});

describe('Attractions → un único HTML (CE-10)', () => {
  it('array de TBOHotelCodeList: se une con "," porque es un HTML cortado en cada coma (p. 67-68)', () => {
    expect(joinTboAttractions(['\u2026 New York', ' NY (NYS-Skyports)', ' NJ (TEB)'])).toEqual({
      html: '\u2026 New York, NY (NYS-Skyports), NJ (TEB)',
      dropped: 0,
    });
  });

  it('objeto de HotelDetails: valores en el orden numérico de sus claves (p. 61)', () => {
    expect(joinTboAttractions({ '10) ': 'c', '2) ': 'b', '1) ': 'a' })).toEqual({
      html: 'a b c',
      dropped: 0,
    });
  });

  it('claves sin número van al final, en su orden de llegada', () => {
    expect(joinTboAttractions({ x: 'x', '1) ': 'a', y: 'y' })).toEqual({
      html: 'a x y',
      dropped: 0,
    });
  });

  it('el String de la tabla pasa tal cual y los trozos que no son texto se cuentan', () => {
    expect(joinTboAttractions('<p>a</p>')).toEqual({ html: '<p>a</p>', dropped: 0 });
    expect(joinTboAttractions(['a', 1, 'b'])).toEqual({ html: 'a,b', dropped: 1 });
    expect(joinTboAttractions({ '1) ': 'a', '2) ': null })).toEqual({ html: 'a', dropped: 1 });
  });
});
