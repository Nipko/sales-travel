import { describe, expect, it } from 'vitest';
import {
  ROOM_AMENITIES_MAX,
  ROOM_AMENITY_MAX_CHARS,
  roomAmenitiesOf,
} from './hotel-room-amenities.js';

/**
 * Los servicios de cada habitación como salen al navegador (TBO-12): una lista por habitación, en
 * su orden, hasta 60 por habitación, 80 caracteres cada uno y sin repetidos.
 */

describe('roomAmenitiesOf — el contrato con la web', () => {
  /*
   * MUTACIÓN: la web repite estos topes (checkout/_components/prebook-view.ts) y descarta el
   * servicio que pasa de 80 caracteres; subirlos acá sin bajarlos allá los haría desaparecer.
   */
  it('los topes son los que la web espera: 60 por habitación y 80 caracteres', () => {
    expect(ROOM_AMENITIES_MAX).toBe(60);
    expect(ROOM_AMENITY_MAX_CHARS).toBe(80);
  });

  it('una lista por habitación, en el orden del proveedor', () => {
    expect(
      roomAmenitiesOf([
        ['Free WiFi', 'Minibar'],
        ['Balcony', 'Free WiFi'],
      ]),
    ).toEqual([
      ['Free WiFi', 'Minibar'],
      ['Balcony', 'Free WiFi'],
    ]);
  });

  it('sin repetidos dentro de una habitación, sin distinguir mayúsculas ni espacios; queda la primera forma', () => {
    expect(roomAmenitiesOf([['Free WiFi', 'free  wifi', ' FREE WIFI ', 'Minibar']])).toEqual([
      ['Free WiFi', 'Minibar'],
    ]);
  });

  it('formas compatibles de Unicode cuentan como el mismo servicio', () => {
    // La ligadura «fi» (U+FB01) y las dos letras sueltas son lo mismo para quien lo lee.
    const ligadura = `Free Wi${String.fromCodePoint(0xfb01)}`;
    expect(roomAmenitiesOf([[ligadura, 'Free WiFi']])).toEqual([[ligadura]]);
  });

  it('una línea por servicio: saltos, tabuladores y controles salen; vacíos y no textos se saltan', () => {
    expect(
      roomAmenitiesOf([
        ['  Room\nservice\t(24 hours) ', '\u0000', '   ', 7, null, 'Safe\u0085box'],
      ]),
    ).toEqual([['Room service (24 hours)', 'Safe box']]);
  });

  it('los invisibles salen: sólo con ellos no hay etiqueta, y no esconden un repetido', () => {
    expect(
      roomAmenitiesOf([
        [
          '\u200B\u2060',
          '\u202EFree WiFi\u202C',
          'Free WiFi\u200B',
          '\u2066Mini\u200Bbar\u2069',
          'Family room \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
        ],
      ]),
    ).toEqual([['Free WiFi', 'Minibar', 'Family room \u{1F468}\u200D\u{1F469}\u200D\u{1F467}']]);
    expect(roomAmenitiesOf([['\u200E', '\u200F\u202A']])).toBeUndefined();
  });

  it(`a lo sumo ${ROOM_AMENITIES_MAX} por habitación, contados después de quitar los repetidos`, () => {
    const muchos = Array.from({ length: 90 }, (_, i) => `Servicio ${i % 70}`);
    const [lista] = roomAmenitiesOf([muchos]) ?? [];
    expect(lista).toHaveLength(ROOM_AMENITIES_MAX);
    expect(lista?.[0]).toBe('Servicio 0');
    expect(lista?.at(-1)).toBe(`Servicio ${ROOM_AMENITIES_MAX - 1}`);
  });

  it(`a lo sumo ${ROOM_AMENITY_MAX_CHARS} caracteres, con «…»; uno justo de largo queda entero`, () => {
    const justo = 'x'.repeat(ROOM_AMENITY_MAX_CHARS);
    const largo = 'z'.repeat(100);
    // El corte cae sobre un espacio: no queda «a …» sino «a…».
    const conEspacio = `${'a'.repeat(ROOM_AMENITY_MAX_CHARS - 2)} vista al mar`;
    const [lista] = roomAmenitiesOf([[justo, largo, conEspacio]]) ?? [];
    expect(lista).toEqual([
      justo,
      `${'z'.repeat(ROOM_AMENITY_MAX_CHARS - 1)}…`,
      `${'a'.repeat(ROOM_AMENITY_MAX_CHARS - 2)}…`,
    ]);
    expect(Array.from(lista?.[1] ?? '')).toHaveLength(ROOM_AMENITY_MAX_CHARS);
  });

  it('el recorte cuenta emojis enteros y nunca deja medio par UTF-16', () => {
    const emojis = '😀'.repeat(ROOM_AMENITY_MAX_CHARS + 5);
    const [lista] = roomAmenitiesOf([[emojis, `Spa ${'\uD83D'}`]]) ?? [];
    expect(lista?.[0]).toBe(`${'😀'.repeat(ROOM_AMENITY_MAX_CHARS - 1)}…`);
    expect(lista?.[1]).toBe('Spa');
    expect(JSON.stringify(lista)).not.toMatch(/\\ud[89a-f]/i);
  });

  it('dos servicios que sólo difieren después del recorte se ven iguales: queda uno', () => {
    const base = 'y'.repeat(ROOM_AMENITY_MAX_CHARS);
    expect(roomAmenitiesOf([[`${base}A`, `${base}B`]])).toEqual([
      [`${'y'.repeat(ROOM_AMENITY_MAX_CHARS - 1)}…`],
    ]);
  });

  it('una habitación sin servicios queda con su lista vacía, para no correr el orden', () => {
    expect(roomAmenitiesOf([[], ['Minibar']])).toEqual([[], ['Minibar']]);
  });

  it('sin ningún servicio que mostrar en ninguna habitación, nada', () => {
    expect(roomAmenitiesOf([])).toBeUndefined();
    expect(roomAmenitiesOf([[], ['  ', '']])).toBeUndefined();
  });
});
