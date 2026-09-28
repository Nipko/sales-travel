import { describe, expect, it } from 'vitest';
import {
  addressLine,
  contentLanguageNote,
  hasArrivalInfo,
  hasContactInfo,
  hasDescriptiveContent,
  isAllowlistedHtml,
  mapsUrl,
  parseHotelContent,
  parseRichText,
  safeImageUrls,
  safeWebsiteUrl,
  splitSections,
} from './hotel-content-view';

const REF = { provider: 'tbo-hotels', hotelId: '1402689' };

function view(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerCode: 'tbo-hotels',
    hotelId: '1402689',
    requestedLang: 'es',
    lang: 'es',
    origin: 'catalog',
    name: 'Hotel Plaza',
    stars: 4,
    address: 'Av. 5 # 10-20',
    zipcode: '110111',
    countryCode: 'CO',
    location: { lat: 4.6, lng: -74.08 },
    descriptionHtml: '<p>Frente al parque.</p>',
    sections: [{ label: 'CheckIn Instructions', text: 'Depósito de USD 50.' }],
    facilities: ['WiFi gratis', 'Piscina'],
    attractionsHtml: null,
    images: ['https://img.tbo.com/1.jpg'],
    phone: '+57 1 555 0000',
    websiteUrl: 'https://hotelplaza.example',
    checkInTime: '15:00',
    checkOutTime: '12:00',
    ...extra,
  };
}

describe('parseRichText — el HTML de la ficha como texto de React (RNF-16)', () => {
  it('párrafos, negritas y saltos', () => {
    expect(parseRichText('<p><b>Ubicación:</b> frente al parque<br>a 2 cuadras</p>')).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'Ubicación:', bold: true },
          { kind: 'text', text: ' frente al parque', bold: false },
          { kind: 'break' },
          { kind: 'text', text: 'a 2 cuadras', bold: false },
        ],
      },
    ]);
  });

  it('listas con sus viñetas, y el texto suelto en su propio párrafo', () => {
    expect(parseRichText('Aviso<ul><li>Piscina</li><li>Spa</li></ul>')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Aviso', bold: false }] },
      {
        kind: 'list',
        items: [
          [{ kind: 'text', text: 'Piscina', bold: false }],
          [{ kind: 'text', text: 'Spa', bold: false }],
        ],
      },
    ]);
  });

  it('decodifica las entidades UNA sola vez: `&amp;lt;` es el texto `&lt;`', () => {
    const [block] = parseRichText('<p>&lt;b&gt; &amp;lt; &quot;A&quot; &#39;B&#39;</p>');
    expect(block).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'text', text: `<b> &lt; "A" 'B'`, bold: false }],
    });
  });

  it('una etiqueta fuera de la lista blanca no entra: queda sólo su texto', () => {
    const blocks = parseRichText('<p>Hola<script>alert(1)</script><img src=x onerror=y></p>');
    expect(JSON.stringify(blocks)).not.toMatch(/script|img|onerror/);
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'Hola', bold: false },
          { kind: 'text', text: 'alert(1)', bold: false },
        ],
      },
    ]);
  });

  it('bloques vacíos y saltos de borde no se pintan', () => {
    expect(parseRichText('<p> </p><p><br></p><ul><li> </li></ul>')).toEqual([]);
  });
});

describe('isAllowlistedHtml — la gramática del saneador', () => {
  it('acepta sólo las cinco etiquetas sin atributos y el texto escapado', () => {
    expect(isAllowlistedHtml('<p>A &amp; B<br></p><ul><li><b>x</b></li></ul>')).toBe(true);
    expect(isAllowlistedHtml('<p class="x">A</p>')).toBe(false);
    expect(isAllowlistedHtml('<a href="javascript:1">A</a>')).toBe(false);
    expect(isAllowlistedHtml('A & B')).toBe(false);
  });
});

describe('parseHotelContent — la ficha verificada otra vez en la pantalla', () => {
  it('lee la ficha completa', () => {
    const c = parseHotelContent(view(), REF);
    expect(c?.name).toBe('Hotel Plaza');
    expect(c?.images).toEqual(['https://img.tbo.com/1.jpg']);
    expect(c?.checkInTime).toBe('15:00');
    expect(c?.location).toEqual({ lat: 4.6, lng: -74.08 });
  });

  it('una ficha de otro hotel no se muestra', () => {
    expect(parseHotelContent(view({ hotelId: '999' }), REF)).toBeUndefined();
    expect(parseHotelContent(null, REF)).toBeUndefined();
  });

  it('sólo imágenes https: ni http, ni data:, ni javascript:', () => {
    const c = parseHotelContent(
      view({
        images: [
          'http://img.tbo.com/1.jpg',
          'data:image/png;base64,AAAA',
          'javascript:alert(1)',
          'https://user:pw@img.tbo.com/x.jpg',
          'https://img.tbo.com/2.jpg',
          'https://img.tbo.com/2.jpg',
        ],
      }),
      REF,
    );
    expect(c?.images).toEqual(['https://img.tbo.com/2.jpg']);
  });

  it('un HTML fuera de la lista blanca no sale; el sitio sólo http o https', () => {
    const c = parseHotelContent(
      view({ descriptionHtml: '<p onclick="x">A</p>', websiteUrl: 'javascript:alert(1)' }),
      REF,
    );
    expect(c?.descriptionHtml).toBeNull();
    expect(c?.websiteUrl).toBeNull();
    expect(safeWebsiteUrl('http://hotel.example/')).toBe('http://hotel.example/');
  });

  it('sin contenido: la ficha vacía, no un error', () => {
    const c = parseHotelContent(
      view({
        origin: 'none',
        lang: null,
        descriptionHtml: null,
        sections: [],
        facilities: [],
        images: [],
        checkInTime: null,
        checkOutTime: null,
      }),
      REF,
    );
    expect(c).toMatchObject({ origin: 'none', images: [], sections: [], lang: null });
  });

  it('valores fuera de rango se descartan', () => {
    const c = parseHotelContent(
      view({ stars: 9, location: { lat: 200, lng: 0 }, checkInTime: '3 PM', origin: 'otro' }),
      REF,
    );
    expect(c).toMatchObject({ stars: null, location: null, checkInTime: null, origin: 'none' });
  });

  it('safeImageUrls tolera cualquier cosa', () => {
    expect(safeImageUrls('https://x')).toEqual([]);
    expect(safeImageUrls([1, null, {}])).toEqual([]);
  });
});

describe('presentación de la ficha', () => {
  it('avisa cuando el texto vino en otro idioma', () => {
    expect(contentLanguageNote({ lang: 'en', requestedLang: 'es' })).toBe(
      'La descripción de este hotel está disponible sólo en inglés.',
    );
    expect(contentLanguageNote({ lang: 'es', requestedLang: 'es' })).toBeUndefined();
    expect(contentLanguageNote({ lang: null, requestedLang: 'es' })).toBeUndefined();
  });

  it('las instrucciones de llegada van con los horarios', () => {
    const { arrival, other } = splitSections([
      { label: 'HeadLine', text: 'Frente al parque' },
      { label: 'CheckIn Instructions', text: 'Depósito' },
      { label: 'Special Instructions', text: 'Llegada tarde' },
    ]);
    expect(arrival.map((s) => s.label)).toEqual(['CheckIn Instructions', 'Special Instructions']);
    expect(other.map((s) => s.label)).toEqual(['HeadLine']);
  });

  it('qué partes de la ficha hay para mostrar', () => {
    const full = parseHotelContent(view(), REF);
    const bare = parseHotelContent(
      view({
        descriptionHtml: null,
        sections: [],
        facilities: [],
        images: [],
        phone: null,
        websiteUrl: null,
        checkInTime: null,
        checkOutTime: null,
      }),
      REF,
    );
    if (full === undefined || bare === undefined) throw new Error('ficha ilegible');
    expect([hasDescriptiveContent(full), hasArrivalInfo(full), hasContactInfo(full)]).toEqual([
      true,
      true,
      true,
    ]);
    expect([hasDescriptiveContent(bare), hasArrivalInfo(bare), hasContactInfo(bare)]).toEqual([
      false,
      false,
      false,
    ]);
    // Sólo las instrucciones de llegada ya cuentan como llegada.
    const onlyInstructions = { ...bare, sections: [{ label: 'CheckIn Instructions', text: 'x' }] };
    expect(hasArrivalInfo(onlyInstructions)).toBe(true);
  });

  it('mapa externo con las coordenadas y dirección con su código postal', () => {
    expect(mapsUrl({ lat: 4.6, lng: -74.08 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=4.600000%2C-74.080000',
    );
    expect(addressLine({ address: 'Av. 5', zipcode: '110111' })).toBe('Av. 5 (110111)');
    expect(addressLine({ address: 'Av. 5, 110111', zipcode: '110111' })).toBe('Av. 5, 110111');
    expect(addressLine({ address: null, zipcode: null })).toBeNull();
  });
});
