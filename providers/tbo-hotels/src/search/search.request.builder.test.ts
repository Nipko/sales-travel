import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import {
  TBO_SEARCH_LIMITS,
  buildTboSearchRequest,
  checkTboSearchEligibility,
  type TboSearchCriteria,
  type TboSearchRequest,
} from './search.request.builder';

/**
 * El builder de Search contra las reglas S-01 a S-06 (docs/tbo/02 §2.3; 08 RF-05) y contra los
 * PaxRooms exactos de la certificación (07 §4.2).
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');

function readFixture<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...segments), 'utf8')) as T;
}

/** Los 13 códigos de la colección, que el arnés usa por defecto (07 §4.1). */
const POSTMAN_CODES = [
  '376565',
  '1345318',
  '1345320',
  '1200255',
  '1128760',
  '1250333',
  '1078234',
  '1347149',
  '1358855',
  '1345321',
  '1108025',
  '1356271',
  '1267547',
];

function criteria(overrides: Partial<TboSearchCriteria> = {}): TboSearchCriteria {
  return {
    hotelIds: ['1120548'],
    checkinDate: '2026-11-07',
    checkoutDate: '2026-11-09',
    rooms: [{ adults: 2, childrenAges: [] }],
    guestNationality: 'CO',
    ...overrides,
  };
}

function buildError(run: () => unknown): TboRequestBuildError {
  try {
    run();
  } catch (err) {
    if (err instanceof TboRequestBuildError) return err;
    throw err;
  }
  throw new Error('se esperaba TboRequestBuildError y el builder devolvió un body');
}

describe('los casos 1 a 7 de certificación salen con el PaxRooms exacto de 07 §4.2 (RF-05 CA-3)', () => {
  // [caso, ocupación del vendedor, PaxRooms exactos de la tabla, GuestNationality]
  const CASES: readonly [number, HotelRoomOccupancy[], string, string][] = [
    [1, [{ adults: 1, childrenAges: [] }], '[{"Adults":1,"Children":0,"ChildrenAges":[]}]', 'CO'],
    [2, [{ adults: 1, childrenAges: [7] }], '[{"Adults":1,"Children":1,"ChildrenAges":[7]}]', 'PE'],
    [
      3,
      [{ adults: 2, childrenAges: [4, 10] }],
      '[{"Adults":2,"Children":2,"ChildrenAges":[4,10]}]',
      'BR',
    ],
    [
      4,
      [
        { adults: 1, childrenAges: [] },
        { adults: 1, childrenAges: [] },
      ],
      '[{"Adults":1,"Children":0,"ChildrenAges":[]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
      'MX',
    ],
    [
      5,
      [
        { adults: 1, childrenAges: [8] },
        { adults: 1, childrenAges: [] },
      ],
      '[{"Adults":1,"Children":1,"ChildrenAges":[8]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
      'CL',
    ],
    [
      6,
      [
        { adults: 1, childrenAges: [3, 11] },
        { adults: 2, childrenAges: [] },
      ],
      '[{"Adults":1,"Children":2,"ChildrenAges":[3,11]},{"Adults":2,"Children":0,"ChildrenAges":[]}]',
      'AR',
    ],
    // Caso 7: la ocupación del caso 4 con otra nacionalidad (07 §4.2 y §4.9).
    [
      7,
      [
        { adults: 1, childrenAges: [] },
        { adults: 1, childrenAges: [] },
      ],
      '[{"Adults":1,"Children":0,"ChildrenAges":[]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
      'EC',
    ],
  ];

  it.each(CASES)('caso %i', (_caso, rooms, paxRooms, nationality) => {
    const body = buildTboSearchRequest(
      criteria({ hotelIds: POSTMAN_CODES, rooms, guestNationality: nationality }),
    );
    expect(JSON.stringify(body.PaxRooms)).toBe(paxRooms);
    expect(body.GuestNationality).toBe(nationality);
    expect(body.IsDetailedResponse).toBe(false);
  });

  it('la guarda G-6 tendría material: los siete casos llevan nacionalidades distintas', () => {
    expect(new Set(CASES.map(([, , , nationality]) => nationality)).size).toBe(CASES.length);
  });

  it('el RQ completo del caso 1 es, byte a byte, el de 07 §4.3', () => {
    const body = buildTboSearchRequest(
      criteria({ hotelIds: POSTMAN_CODES, rooms: [{ adults: 1, childrenAges: [] }] }),
    );
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        CheckIn: '2026-11-07',
        CheckOut: '2026-11-09',
        HotelCodes: POSTMAN_CODES.join(','),
        GuestNationality: 'CO',
        PaxRooms: [{ Adults: 1, Children: 0, ChildrenAges: [] }],
        ResponseTime: 10,
        IsDetailedResponse: false,
        Filters: { Refundable: false, NoOfRooms: 0, MealType: 'All' },
      }),
    );
  });

  it('el request propuesto en 02 §2.3 sale igual', () => {
    const body = buildTboSearchRequest({
      hotelIds: ['1120548', '1247101', '1435427'],
      checkinDate: '2026-11-20',
      checkoutDate: '2026-11-24',
      guestNationality: 'CO',
      rooms: [
        { adults: 2, childrenAges: [7] },
        { adults: 1, childrenAges: [] },
      ],
    });
    expect(body).toEqual({
      CheckIn: '2026-11-20',
      CheckOut: '2026-11-24',
      HotelCodes: '1120548,1247101,1435427',
      GuestNationality: 'CO',
      PaxRooms: [
        { Adults: 2, Children: 1, ChildrenAges: [7] },
        { Adults: 1, Children: 0, ChildrenAges: [] },
      ],
      ResponseTime: 10,
      IsDetailedResponse: false,
      Filters: { Refundable: false, NoOfRooms: 0, MealType: 'All' },
    });
  });
});

describe('S-01: HotelCodes', () => {
  it('es un único CSV sin espacios, deduplicado y en el orden en que llegaron', () => {
    const body = buildTboSearchRequest(criteria({ hotelIds: ['30', '10', '30', '20', '10'] }));
    expect(body.HotelCodes).toBe('30,10,20');
  });

  it('acepta 100 códigos distintos y rechaza 101 sin recortar (partir en lotes es del adapter)', () => {
    const codes = Array.from({ length: 101 }, (_, i) => String(1_000_000 + i));
    expect(
      buildTboSearchRequest(criteria({ hotelIds: codes.slice(0, 100) })).HotelCodes.split(','),
    ).toHaveLength(100);
    const error = buildError(() => buildTboSearchRequest(criteria({ hotelIds: codes })));
    expect(error.reason).toBe('SCHEMA');
    expect(error.issues).toEqual(['hotelIds:too_many_codes']);
  });

  it('101 códigos con un repetido son 100 distintos: pasan', () => {
    const codes = Array.from({ length: 100 }, (_, i) => String(1_000_000 + i));
    const body = buildTboSearchRequest(criteria({ hotelIds: [...codes, codes[0] ?? ''] }));
    expect(body.HotelCodes.split(',')).toHaveLength(100);
  });

  it('la opción sólo ACORTA el tope de 100', () => {
    const codes = ['1', '2', '3'];
    expect(
      buildError(() =>
        buildTboSearchRequest(criteria({ hotelIds: codes }), { maxHotelCodesPerRequest: 2 }),
      ).issues,
    ).toEqual(['hotelIds:too_many_codes']);
    expect(
      buildError(() =>
        buildTboSearchRequest(criteria({ hotelIds: codes }), { maxHotelCodesPerRequest: 101 }),
      ).issues,
    ).toEqual(['options.maxHotelCodesPerRequest:out_of_range']);
  });

  it.each([
    ['con coma', '1120548,1247101'],
    ['con espacio', ' 1120548'],
    ['vacío', ''],
    ['con separador', '1120-548'],
  ])('un código %s partiría el CSV: se rechaza por posición y sin eco del valor', (_name, code) => {
    const error = buildError(() => buildTboSearchRequest(criteria({ hotelIds: ['1', code] })));
    expect(error.reason).toBe('SCHEMA');
    expect(error.issues).toEqual(['hotelIds.1:invalid_code']);
    if (code.trim().length > 0) expect(error.message).not.toContain(code.trim());
  });

  it('sin códigos no hay búsqueda', () => {
    expect(buildError(() => buildTboSearchRequest(criteria({ hotelIds: [] }))).issues).toEqual([
      'hotelIds:too_small',
    ]);
  });
});

describe('S-02 y S-03: Filters', () => {
  it('sólo los tres filtros documentados; nunca OrderBy, StarRating ni HotelName', () => {
    const body = buildTboSearchRequest(criteria());
    expect(Object.keys(body.Filters)).toEqual(['Refundable', 'NoOfRooms', 'MealType']);
    expect(JSON.stringify(body)).not.toMatch(/OrderBy|StarRating|HotelName/);
  });

  it('MealType va como string del enum, nunca como ordinal', () => {
    expect(buildTboSearchRequest(criteria()).Filters.MealType).toBe('All');
    expect(buildTboSearchRequest(criteria(), { mealPlan: 'RoomOnly' }).Filters.MealType).toBe(
      'RoomOnly',
    );
    const error = buildError(() =>
      buildTboSearchRequest(criteria(), { mealPlan: 0 as unknown as 'All' }),
    );
    expect(error.issues).toEqual(['options.mealPlan:invalid_enum_value']);
  });

  it('Refundable sale de refundableOnly y es false si no vino', () => {
    expect(buildTboSearchRequest(criteria()).Filters.Refundable).toBe(false);
    expect(buildTboSearchRequest(criteria({ refundableOnly: true })).Filters.Refundable).toBe(true);
  });

  it('NoOfRooms es 0 aunque haya varias habitaciones (02 §7; Q-18)', () => {
    const body = buildTboSearchRequest(
      criteria({
        rooms: [
          { adults: 1, childrenAges: [] },
          { adults: 1, childrenAges: [] },
        ],
      }),
    );
    expect(body.Filters.NoOfRooms).toBe(0);
  });
});

describe('S-04: IsDetailedResponse', () => {
  it('false en todo listado (KP-2)', () => {
    expect(buildTboSearchRequest(criteria({ hotelIds: POSTMAN_CODES })).IsDetailedResponse).toBe(
      false,
    );
  });

  it('true sólo en el detalle de UN hotel (D-TBO-19 A)', () => {
    expect(buildTboSearchRequest(criteria(), { detailed: true }).IsDetailedResponse).toBe(true);
  });

  it('el detalle con más de un código se niega: sería un listado con detalle', () => {
    const error = buildError(() =>
      buildTboSearchRequest(criteria({ hotelIds: ['1', '2'] }), { detailed: true }),
    );
    expect(error.reason).toBe('SCHEMA');
    expect(error.issues).toEqual(['IsDetailedResponse:detail_requires_single_hotel']);
  });
});

describe('S-05: GuestNationality', () => {
  it('es la del huésped líder, tal cual', () => {
    expect(buildTboSearchRequest(criteria({ guestNationality: 'VE' })).GuestNationality).toBe('VE');
  });

  it.each([undefined, '', '  '])(
    'sin nacionalidad (%j) no hay valor por defecto: NOT_ELIGIBLE',
    (nationality) => {
      const error = buildError(() =>
        buildTboSearchRequest(criteria({ guestNationality: nationality })),
      );
      expect(error.reason).toBe('NOT_ELIGIBLE');
      expect(error.issues).toEqual(['GuestNationality:missing']);
      expect(error.path).toBe(TBO_OPERATIONS.search.path);
    },
  );

  it('alfa-2 en mayúsculas; otra forma es un criterio roto y no se corrige', () => {
    for (const nationality of ['co', 'COL', 'C0']) {
      const error = buildError(() =>
        buildTboSearchRequest(criteria({ guestNationality: nationality })),
      );
      expect(error.reason).toBe('SCHEMA');
      expect(error.issues).toEqual(['GuestNationality:invalid_string']);
      expect(error.message).not.toContain(nationality);
    }
  });
});

describe('S-06: PaxRooms', () => {
  it('conserva el orden del vendedor: invertir las habitaciones invierte el PaxRooms', () => {
    const rooms: HotelRoomOccupancy[] = [
      { adults: 1, childrenAges: [3, 11] },
      { adults: 2, childrenAges: [] },
    ];
    const forward = buildTboSearchRequest(criteria({ rooms })).PaxRooms;
    const backward = buildTboSearchRequest(criteria({ rooms: [...rooms].reverse() })).PaxRooms;
    expect(backward).toEqual([...forward].reverse());
  });

  it('Children es la longitud de ChildrenAges, y las edades van en el orden cargado', () => {
    const [room] = buildTboSearchRequest(
      criteria({ rooms: [{ adults: 2, childrenAges: [10, 4, 0] }] }),
    ).PaxRooms;
    expect(room).toEqual({ Adults: 2, Children: 3, ChildrenAges: [10, 4, 0] });
  });

  it("habitación sin niños: [] por defecto; 'omit' y 'zero' existen para la sonda PR-01 (Q-13)", () => {
    const adultsOnly = criteria({ rooms: [{ adults: 1, childrenAges: [] }] });
    expect(buildTboSearchRequest(adultsOnly).PaxRooms).toEqual([
      { Adults: 1, Children: 0, ChildrenAges: [] },
    ]);
    expect(buildTboSearchRequest(adultsOnly, { emptyChildrenAges: 'omit' }).PaxRooms).toEqual([
      { Adults: 1, Children: 0 },
    ]);
    expect(buildTboSearchRequest(adultsOnly, { emptyChildrenAges: 'zero' }).PaxRooms).toEqual([
      { Adults: 1, Children: 0, ChildrenAges: [0] },
    ]);
  });

  it('la estrategia no toca las habitaciones con niños', () => {
    const body = buildTboSearchRequest(criteria({ rooms: [{ adults: 1, childrenAges: [5] }] }), {
      emptyChildrenAges: 'zero',
    });
    expect(body.PaxRooms).toEqual([{ Adults: 1, Children: 1, ChildrenAges: [5] }]);
  });

  it('el builder no altera la ocupación que recibe', () => {
    const rooms = [{ adults: 1, childrenAges: [5] }];
    const body = buildTboSearchRequest(criteria({ rooms }));
    body.PaxRooms[0]?.ChildrenAges?.push(9);
    expect(rooms).toEqual([{ adults: 1, childrenAges: [5] }]);
  });
});

describe('ocupaciones que TBO no admite quedan fuera, sin truncar (RF-05 CA-2)', () => {
  it('5 niños en una habitación: motivo visible con la habitación, y el builder se niega', () => {
    const rooms = [
      { adults: 2, childrenAges: [] },
      { adults: 2, childrenAges: [1, 2, 3, 4, 5] },
    ];
    expect(checkTboSearchEligibility({ rooms, guestNationality: 'CO' })).toEqual({
      eligible: false,
      reason: 'TOO_MANY_CHILDREN',
      roomIndex: 2,
    });
    const error = buildError(() => buildTboSearchRequest(criteria({ rooms })));
    expect(error.reason).toBe('NOT_ELIGIBLE');
    expect(error.issues).toEqual(['PaxRooms.1.Children:too_many_children']);
  });

  it('4 niños es el máximo de TBO (p. 11) y pasa', () => {
    const rooms = [{ adults: 1, childrenAges: [1, 2, 3, 4] }];
    expect(checkTboSearchEligibility({ rooms, guestNationality: 'CO' })).toEqual({
      eligible: true,
    });
    expect(buildTboSearchRequest(criteria({ rooms })).PaxRooms[0]?.Children).toBe(4);
  });

  it('una edad fuera de 0-18 deja a TBO fuera', () => {
    expect(
      checkTboSearchEligibility({
        rooms: [{ adults: 1, childrenAges: [19] }],
        guestNationality: 'CO',
      }),
    ).toEqual({ eligible: false, reason: 'CHILD_AGE_OUT_OF_RANGE', roomIndex: 1 });
    expect(TBO_SEARCH_LIMITS.maxChildAge).toBe(18);
  });

  it('más habitaciones que el tope configurado', () => {
    const rooms = Array.from({ length: 3 }, () => ({ adults: 1, childrenAges: [] }));
    expect(
      checkTboSearchEligibility({ rooms, guestNationality: 'CO' }, { maxRoomsPerSearch: 2 }),
    ).toEqual({ eligible: false, reason: 'TOO_MANY_ROOMS' });
    expect(
      buildError(() => buildTboSearchRequest(criteria({ rooms }), { maxRoomsPerSearch: 2 })).issues,
    ).toEqual(['PaxRooms:too_many_rooms']);
  });

  it('la ocupación se evalúa antes que la nacionalidad: completar un campo no la arregla', () => {
    expect(
      checkTboSearchEligibility({ rooms: [{ adults: 1, childrenAges: [1, 2, 3, 4, 5] }] }),
    ).toMatchObject({ reason: 'TOO_MANY_CHILDREN' });
    expect(checkTboSearchEligibility({ rooms: [{ adults: 1, childrenAges: [] }] })).toEqual({
      eligible: false,
      reason: 'GUEST_NATIONALITY_MISSING',
    });
  });
});

describe('ResponseTime y fechas', () => {
  it('10 s por defecto (D-TBO-17 A) y configurable de 5 a 20', () => {
    expect(buildTboSearchRequest(criteria()).ResponseTime).toBe(10);
    expect(buildTboSearchRequest(criteria(), { responseTimeSeconds: 20 }).ResponseTime).toBe(20);
    expect(buildTboSearchRequest(criteria(), { responseTimeSeconds: 5 }).ResponseTime).toBe(5);
  });

  it.each([4, 21, 10.5, Number.NaN])('ResponseTime %s se rechaza', (seconds) => {
    expect(
      buildError(() => buildTboSearchRequest(criteria(), { responseTimeSeconds: seconds })).issues,
    ).toEqual(['options.responseTimeSeconds:out_of_range']);
  });

  it('una fecha que no existe o una salida que no es posterior a la entrada', () => {
    expect(
      buildError(() => buildTboSearchRequest(criteria({ checkinDate: '2026-02-30' }))).issues,
    ).toContain('CheckIn:invalid_date');
    expect(
      buildError(() =>
        buildTboSearchRequest(criteria({ checkinDate: '2026-11-09', checkoutDate: '2026-11-09' })),
      ).issues,
    ).toEqual(['CheckOut:not_after_checkin']);
  });
});

describe('contra los ejemplos del contrato', () => {
  type PdfRequest = TboSearchRequest & { Filters: Record<string, unknown> };

  function keyPaths(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => keyPaths(item, `${prefix}${index}.`));
    }
    if (typeof value === 'object' && value !== null) {
      return Object.entries(value).flatMap(([key, child]) => [
        `${prefix}${key}`,
        ...keyPaths(child, `${prefix}${key}.`),
      ]);
    }
    return [];
  }

  it('6.1.2 (p. 12, normalizado): mismas claves y mismo PaxRooms; difiere sólo en lo decidido', () => {
    const pdf = readFixture<PdfRequest>('pdf', 'search-request-multi-room.p12.json');
    const ours = buildTboSearchRequest({
      hotelIds: pdf.HotelCodes.split(','),
      checkinDate: pdf.CheckIn,
      checkoutDate: pdf.CheckOut,
      guestNationality: pdf.GuestNationality,
      refundableOnly: pdf.Filters['Refundable'] === true,
      rooms: pdf.PaxRooms.map((room) => ({
        adults: room.Adults,
        childrenAges: room.ChildrenAges ?? [],
      })),
    });
    // C-01: el PDF no dice qué es obligatorio, así que se mandan todos los campos documentados y
    // ninguno más.
    expect(keyPaths(ours).sort()).toEqual(keyPaths(pdf).sort());
    expect(ours.PaxRooms).toEqual(pdf.PaxRooms);
    expect({ ...ours, ResponseTime: 0, Filters: { ...ours.Filters, NoOfRooms: 0 } }).toEqual({
      ...pdf,
      ResponseTime: 0,
      Filters: { ...pdf.Filters, NoOfRooms: 0 },
    });
    // Las dos diferencias son decisiones escritas: ResponseTime 10 (D-TBO-17 A) y NoOfRooms 0 (Q-18).
    expect([ours.ResponseTime, pdf.ResponseTime]).toEqual([10, 23]);
    expect([ours.Filters.NoOfRooms, pdf.Filters['NoOfRooms']]).toEqual([0, 2]);
  });

  interface PostmanFixture {
    readonly discrepancies: readonly { readonly path: string; readonly rule: string }[];
    readonly body: Record<string, unknown>;
  }

  function at(value: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, key) => {
      if (typeof node !== 'object' || node === null) return undefined;
      return (node as Record<string, unknown>)[key];
    }, value);
  }

  function leafPaths(value: unknown, prefix = ''): string[] {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([key, child]) => leafPaths(child, `${prefix}${key}.`));
    }
    if (Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null)) {
      return value.flatMap((item, index) => leafPaths(item, `${prefix}${index}.`));
    }
    return [prefix.slice(0, -1)];
  }

  it('Postman: Search — el builder no repite ninguna de las discrepancias anotadas', () => {
    const postman = readFixture<PostmanFixture>('postman', 'search.request.json');
    const annotated = new Set(postman.discrepancies.map((entry) => entry.path));
    const ours = buildTboSearchRequest({
      hotelIds: String(postman.body['HotelCodes']).split(','),
      checkinDate: '2026-11-20',
      checkoutDate: '2026-11-24',
      guestNationality: 'CO',
      rooms: [{ adults: 1, childrenAges: [] }],
    });

    const postmanLeaves = leafPaths(postman.body);
    for (const path of postmanLeaves) {
      if (annotated.has(path)) {
        expect(at(ours, path), `${path} está anotado como discrepancia`).not.toEqual(
          at(postman.body, path),
        );
      } else {
        expect(at(ours, path), `${path} no está anotado: tiene que coincidir`).toEqual(
          at(postman.body, path),
        );
      }
    }
    // Cada anotación del cuerpo apunta a un campo que existe en Postman: una anotación huérfana
    // es una discrepancia que nadie verifica.
    for (const path of annotated) {
      if (path !== 'url') expect(postmanLeaves, path).toContain(path);
    }
    // Y lo que agregamos está en el contrato: ninguna clave nuestra falta en Postman.
    expect(leafPaths(ours).filter((path) => !postmanLeaves.includes(path))).toEqual([]);
  });

  it("la forma 'zero' reproduce el PaxRooms de Postman, y sólo si se pide", () => {
    const postman = readFixture<PostmanFixture>('postman', 'search.request.json');
    const rooms = [{ adults: 1, childrenAges: [] }];
    expect(
      buildTboSearchRequest(criteria({ rooms }), { emptyChildrenAges: 'zero' }).PaxRooms,
    ).toEqual(postman.body['PaxRooms']);
  });
});
