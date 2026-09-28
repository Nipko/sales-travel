import { describe, expect, it } from 'vitest';
import {
  TBO_SEARCH_HOTEL_KEYS,
  TBO_SEARCH_ROOM_KEYS,
  TBO_SEARCH_ROOT_KEYS,
  TBO_SUPPLEMENT_KEYS,
  TboDecimalSchema,
  TboSearchEnvelopeSchema,
  TboSearchHotelSchema,
  TboSearchRoomSchema,
} from './response.schema';

/** Tolerancias del esquema de Search, una por contradicción del contrato (docs/tbo/02 §10-§11). */

const ROOM = {
  Name: ['Luxury Room, 1 King Bed'],
  BookingCode: '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
  TotalFare: 152.88,
};

describe('importes (C-16)', () => {
  it.each([152.88, 0, '17.22', ' 17.22 ', '305.750', '20'])('%j es un importe', (value) => {
    expect(TboDecimalSchema.safeParse(value).success).toBe(true);
  });

  it.each(['1,234.00', '-5', '+5', '1e3', '', 'NaN', Number.NaN, Number.POSITIVE_INFINITY, null])(
    '%j no lo es',
    (value) => {
      expect(TboDecimalSchema.safeParse(value).success).toBe(false);
    },
  );

  it('un número negativo pasa el esquema: lo rechaza la conversión con su propio motivo', () => {
    expect(TboDecimalSchema.safeParse(-1).success).toBe(true);
  });

  it('opcionales: vacío, espacios y null son "no vino"', () => {
    for (const value of ['', '   ', null, undefined]) {
      const parsed = TboSearchRoomSchema.parse({ ...ROOM, RecommendedSellingRate: value });
      expect(parsed.RecommendedSellingRate).toBeUndefined();
    }
  });
});

describe('formas que el contrato declara de una manera y los ejemplos traen de otra', () => {
  const supplement = { Index: 1, Type: 'AtProperty', Price: 20, Currency: 'AED' };

  it('Supplements como array de arrays (p. 15-17) o plano (la tabla, p. 14) (C-17)', () => {
    expect(TboSearchRoomSchema.safeParse({ ...ROOM, Supplements: [[supplement]] }).success).toBe(
      true,
    );
    expect(TboSearchRoomSchema.safeParse({ ...ROOM, Supplements: [supplement] }).success).toBe(
      true,
    );
    expect(TboSearchRoomSchema.safeParse({ ...ROOM, Supplements: [] }).success).toBe(true);
  });

  it('Supplements[].Index como número o texto de dígitos, base 1', () => {
    const parse = (index: unknown) =>
      TboSearchRoomSchema.safeParse({ ...ROOM, Supplements: [[{ ...supplement, Index: index }]] });
    expect(parse('2').success).toBe(true);
    expect(parse(0).success).toBe(false);
    expect(parse(true).success).toBe(false);
    expect(parse('1a').success).toBe(false);
  });

  it('la moneda de un suplemento es ISO en mayúsculas: con dinero no se adivina', () => {
    const parse = (currency: unknown) =>
      TboSearchRoomSchema.safeParse({
        ...ROOM,
        Supplements: [[{ ...supplement, Currency: currency }]],
      });
    expect(parse('AED').success).toBe(true);
    expect(parse('aed').success).toBe(false);
    expect(parse(undefined).success).toBe(false);
  });

  it('RoomPromotion plano (p. 15) o anidado (la tabla, C-18)', () => {
    expect(
      TboSearchRoomSchema.safeParse({ ...ROOM, RoomPromotion: ['Private sale'] }).success,
    ).toBe(true);
    expect(
      TboSearchRoomSchema.safeParse({ ...ROOM, RoomPromotion: [['Private sale']] }).success,
    ).toBe(true);
  });

  it('RoomID de Search y RoomId de HotelDetails, como texto o número (p. 56-57)', () => {
    expect(TboSearchRoomSchema.safeParse({ ...ROOM, RoomID: ['197354'] }).success).toBe(true);
    expect(TboSearchRoomSchema.safeParse({ ...ROOM, RoomId: [197354] }).success).toBe(true);
  });

  it('HotelCode como String (p. 13) o como número (catálogo, p. 55)', () => {
    expect(TboSearchHotelSchema.parse({ HotelCode: 1120548, Rooms: [] }).HotelCode).toBe('1120548');
    expect(TboSearchHotelSchema.parse({ HotelCode: ' 1120548 ' }).HotelCode).toBe('1120548');
    expect(TboSearchHotelSchema.safeParse({ HotelCode: '' }).success).toBe(false);
  });

  it('un pack sin Name, BookingCode o TotalFare no es un pack', () => {
    for (const key of ['Name', 'BookingCode', 'TotalFare'] as const) {
      const { [key]: _omitted, ...rest } = ROOM;
      expect(TboSearchRoomSchema.safeParse(rest).success, key).toBe(false);
    }
  });
});

describe('el sobre', () => {
  it('conserva las claves desconocidas de la raíz para registrar sus nombres', () => {
    const parsed = TboSearchEnvelopeSchema.parse({
      Status: { Code: 200 },
      HotelResult: [],
      TraceId: 'x',
    });
    expect(Object.keys(parsed)).toContain('TraceId');
  });

  it('Status es opcional: el desenlace ya lo decidió el cliente, que acepta variantes de casing', () => {
    expect(
      TboSearchEnvelopeSchema.safeParse({ status: { code: 200 }, HotelResult: [] }).success,
    ).toBe(true);
    expect(TboSearchEnvelopeSchema.parse({ Status: { Code: '201' } }).Status?.Code).toBe(201);
  });

  it('un HotelResult que no es lista hace ilegible la respuesta (S-16)', () => {
    expect(TboSearchEnvelopeSchema.safeParse({ HotelResult: {} }).success).toBe(false);
  });

  it('las claves conocidas salen de los esquemas, no de una lista paralela', () => {
    expect(TBO_SEARCH_ROOT_KEYS).toEqual(['Status', 'HotelResult']);
    expect(TBO_SEARCH_HOTEL_KEYS).toEqual(['HotelCode', 'Currency', 'Rooms']);
    expect(TBO_SUPPLEMENT_KEYS).toEqual(['Index', 'Type', 'Description', 'Price', 'Currency']);
    expect(TBO_SEARCH_ROOM_KEYS).toEqual(
      expect.arrayContaining([
        'Name',
        'BookingCode',
        'TotalFare',
        'Supplements',
        'RoomID',
        'RoomId',
      ]),
    );
  });
});
