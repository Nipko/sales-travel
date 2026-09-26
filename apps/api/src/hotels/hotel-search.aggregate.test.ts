import { HotelOfferSchema, type HotelOffer, type HotelRoompack } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { stubHotelOffer } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import {
  SKIP_REASON_TEXT,
  catalogFactsOf,
  errorOutcome,
  gateByCurrency,
  mergeProviderOffers,
  occupancyViolation,
  partialOutcome,
  respondedOutcome,
  searchEligibilitySkip,
  skippedOutcome,
  sortOutcomes,
  telemetrySlices,
  unavailableOutcome,
  withCatalogFacts,
  type HotelProviderOutcome,
} from './hotel-search.aggregate.js';

/**
 * Reglas de la búsqueda combinada, con datos y sin Nest: puerta de moneda (RF-13), parte por
 * proveedor y respuesta parcial (RF-14, RNF-13), topes de ocupación y nacionalidad por proveedor
 * (RF-06), contenido desde el catálogo, fusión por hotel canónico (RF-34, RF-40) y filas de
 * telemetría (RNF-07).
 */

/** Un pack del proveedor `code` en `currency`, válido contra el contrato neutral. */
function pack(code: string, id: string, currency: string, amountMinor = 100_000): HotelRoompack {
  const [p] = stubHotelOffer(code, { hotelId: id, currency, amountMinor }).roompacks;
  return { ...(p as HotelRoompack), id: `${code}-${id}-${currency}` };
}

function hotel(hotelId: string, packs: HotelRoompack[]): HotelOffer {
  return HotelOfferSchema.parse({ hotelId, roompacks: packs });
}

describe('occupancyViolation — topes del proveedor', () => {
  const dos = [
    { adults: 2, childrenAges: [4, 9] },
    { adults: 1, childrenAges: [] },
  ];

  it('sin topes declarados, el proveedor acepta lo que acepta el borde', () => {
    expect(occupancyViolation(dos, undefined)).toBeUndefined();
    expect(occupancyViolation(dos, {})).toBeUndefined();
  });

  it('dentro de todos los topes no hay motivo', () => {
    expect(
      occupancyViolation(dos, {
        maxRooms: 2,
        maxAdultsPerRoom: 2,
        maxChildrenPerRoom: 2,
        maxChildAge: 9,
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ maxRooms: 1 }, 'Admite hasta 1 habitaciones por búsqueda.'],
    [{ maxAdultsPerRoom: 1 }, 'Admite hasta 1 adultos por habitación.'],
    [{ maxChildrenPerRoom: 1 }, 'Admite hasta 1 niños por habitación.'],
    [{ maxChildAge: 8 }, 'Admite niños de hasta 8 años.'],
  ])('%o → "%s"', (limits, motivo) => {
    expect(occupancyViolation(dos, limits)).toBe(motivo);
  });

  it('se mira cada habitación, no sólo la primera', () => {
    const segundaLlena = [
      { adults: 1, childrenAges: [] },
      { adults: 3, childrenAges: [] },
    ];
    expect(occupancyViolation(segundaLlena, { maxAdultsPerRoom: 2 })).toBe(
      'Admite hasta 2 adultos por habitación.',
    );
  });
});

describe('searchEligibilitySkip — a quién no se le pregunta (RF-06, PR-2.4)', () => {
  const rooms = [{ adults: 2, childrenAges: [7] }];
  const cincoNinos = [{ adults: 2, childrenAges: [1, 3, 5, 7, 9] }];
  const exigeNacionalidad = {
    requiresGuestNationality: true,
    occupancy: { maxChildrenPerRoom: 4 },
  };

  it('RF-06 CA 1: sin nacionalidad, el que la exige queda `skipped` con un motivo para el vendedor', () => {
    expect(searchEligibilitySkip('alfa', { rooms }, exigeNacionalidad)).toEqual({
      code: 'alfa',
      status: 'skipped',
      count: 0,
      skipReason: 'guest-nationality-missing',
      reason:
        'Cotiza según la nacionalidad del pasajero principal: indicala en la búsqueda para ver sus tarifas.',
    });
  });

  it.each(['', '   '])(
    'una nacionalidad en blanco ("%s") cuenta como ausente, como en el ACL',
    (guestNationality) => {
      expect(
        searchEligibilitySkip('alfa', { rooms, guestNationality }, exigeNacionalidad)?.skipReason,
      ).toBe('guest-nationality-missing');
    },
  );

  it('con nacionalidad, puede buscar', () => {
    expect(
      searchEligibilitySkip('alfa', { rooms, guestNationality: 'CO' }, exigeNacionalidad),
    ).toBeUndefined();
  });

  it('el que no la exige busca sin ella, lo declare en `false` o no lo declare', () => {
    expect(searchEligibilitySkip('beta', { rooms }, {})).toBeUndefined();
    expect(
      searchEligibilitySkip('beta', { rooms }, { requiresGuestNationality: false }),
    ).toBeUndefined();
  });

  it('habitación con 5 niños y un tope de 4 → `occupancy-limits` con el tope en el motivo', () => {
    expect(
      searchEligibilitySkip(
        'alfa',
        { rooms: cincoNinos, guestNationality: 'CO' },
        exigeNacionalidad,
      ),
    ).toEqual({
      code: 'alfa',
      status: 'skipped',
      count: 0,
      skipReason: 'occupancy-limits',
      reason: 'Admite hasta 4 niños por habitación.',
    });
  });

  it('la ocupación va antes que la nacionalidad: completar el campo no lo haría entrar', () => {
    expect(
      searchEligibilitySkip('alfa', { rooms: cincoNinos }, exigeNacionalidad)?.skipReason,
    ).toBe('occupancy-limits');
  });
});

describe('gateByCurrency — puerta de moneda', () => {
  it('lo que ya está en la moneda de venta sale como llegó: el MISMO objeto', () => {
    const h = hotel('H-1', [pack('alfa', '1', 'COP')]);
    const r = gateByCurrency([h], 'COP');

    expect(r.offers[0]).toBe(h);
    expect(r.dropped).toBe(0);
    expect(r.droppedCurrencies).toEqual([]);
  });

  it('un hotel que llegó sin tarifas sale igual: la puerta filtra tarifas, no hoteles', () => {
    const vacio = hotel('H-0', []);
    expect(gateByCurrency([vacio], 'COP').offers).toEqual([vacio]);
  });

  it('descarta sólo las tarifas en otra moneda y cuenta cuáles', () => {
    const mixto = hotel('H-1', [
      pack('alfa', '1', 'COP'),
      pack('alfa', '2', 'USD'),
      pack('alfa', '3', 'EUR'),
    ]);
    const r = gateByCurrency([mixto], 'COP');

    expect(r.offers).toHaveLength(1);
    expect(r.offers[0]?.roompacks.map((p) => p.price.total.currency)).toEqual(['COP']);
    expect(r.dropped).toBe(2);
    expect(r.droppedCurrencies).toEqual(['EUR', 'USD']);
  });

  it('un hotel que se queda sin tarifas POR la puerta no sale', () => {
    const r = gateByCurrency([hotel('H-1', [pack('alfa', '1', 'USD')])], 'COP');

    expect(r.offers).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('no convierte: el importe que queda es el del proveedor', () => {
    const r = gateByCurrency([hotel('H-1', [pack('alfa', '1', 'COP', 12_345)])], 'COP');
    expect(r.offers[0]?.roompacks[0]?.price.total).toEqual({
      amountMinor: 12_345,
      currency: 'COP',
    });
  });
});

describe('respondedOutcome — parte de un proveedor que respondió', () => {
  it('sin descartes y con hoteles: `ok` con el conteo de hoteles', () => {
    const offers = [hotel('H-1', [pack('alfa', '1', 'COP')]), hotel('H-2', [])];
    const r = respondedOutcome('alfa', gateByCurrency(offers, 'COP'), 'COP');

    expect(r.outcome).toEqual({ code: 'alfa', status: 'ok', count: 2 });
    expect(r.offers).toEqual(offers);
  });

  it('sin hoteles: `empty`, que afirma que no había disponibilidad', () => {
    const r = respondedOutcome('alfa', gateByCurrency([], 'COP'), 'COP');
    expect(r.outcome).toEqual({ code: 'alfa', status: 'empty', count: 0 });
  });

  it('RF-13 CA 1: todo en otra moneda → `skipped` con el motivo de moneda, no "sin disponibilidad"', () => {
    const offers = [hotel('H-1', [pack('alfa', '1', 'USD')]), hotel('H-2', [])];
    const r = respondedOutcome('alfa', gateByCurrency(offers, 'COP'), 'COP');

    expect(r.outcome).toEqual({
      code: 'alfa',
      status: 'skipped',
      count: 0,
      skipReason: 'currency-mismatch',
      reason:
        'Cotiza en USD y esta búsqueda es en COP: sus tarifas no se pueden mostrar sin convertir la moneda. Revisá la moneda de la cuenta del proveedor en Mi Red → Credenciales.',
      droppedForCurrency: 1,
    });
    // Tampoco aporta sus hoteles sin tarifas: sin nada cotizable, sólo harían ruido.
    expect(r.offers).toEqual([]);
  });

  it('descarte parcial: sigue `ok` y dice cuántas tarifas no se muestran y por qué', () => {
    const offers = [hotel('H-1', [pack('alfa', '1', 'COP'), pack('alfa', '2', 'USD')])];
    const r = respondedOutcome('alfa', gateByCurrency(offers, 'COP'), 'COP');

    expect(r.outcome).toEqual({
      code: 'alfa',
      status: 'ok',
      count: 1,
      reason: '1 tarifa en USD no se muestra: esta búsqueda es en COP.',
      droppedForCurrency: 1,
    });
  });

  it('el motivo parcial va en plural con más de una tarifa', () => {
    const offers = [
      hotel('H-1', [pack('alfa', '1', 'COP'), pack('alfa', '2', 'USD'), pack('alfa', '3', 'USD')]),
    ];
    const r = respondedOutcome('alfa', gateByCurrency(offers, 'COP'), 'COP');
    expect(r.outcome.reason).toBe('2 tarifas en USD no se muestran: esta búsqueda es en COP.');
  });
});

describe('outcomes armados', () => {
  it('skippedOutcome y errorOutcome no aportan hoteles', () => {
    expect(skippedOutcome('alfa', 'catalog-empty', SKIP_REASON_TEXT['catalog-empty'])).toEqual({
      code: 'alfa',
      status: 'skipped',
      count: 0,
      skipReason: 'catalog-empty',
      reason: 'Su catálogo de hoteles para este destino todavía no está sincronizado.',
    });
    expect(errorOutcome('alfa', 'no respondió')).toEqual({
      code: 'alfa',
      status: 'error',
      count: 0,
      reason: 'no respondió',
    });
  });

  it('un ausente lleva su motivo del registry y, si lo hay, el detalle para el vendedor', () => {
    expect(
      unavailableOutcome({ code: 'alfa', reason: 'no-credentials', detail: 'Cargalas en Mi Red.' }),
    ).toEqual({
      code: 'alfa',
      status: 'unavailable',
      count: 0,
      unavailableReason: 'no-credentials',
      reason: 'Cargalas en Mi Red.',
    });
    expect(unavailableOutcome({ code: 'beta', reason: 'incomplete-account' })).toEqual({
      code: 'beta',
      status: 'unavailable',
      count: 0,
      unavailableReason: 'incomplete-account',
    });
  });

  it('el parte sale en orden alfabético por código, como el registry', () => {
    const outcomes: HotelProviderOutcome[] = [
      errorOutcome('zeta', 'x'),
      errorOutcome('alfa', 'x'),
      errorOutcome('mika', 'x'),
      errorOutcome('alfa', 'y'),
    ];
    expect(sortOutcomes(outcomes).map((o) => o.code)).toEqual(['alfa', 'alfa', 'mika', 'zeta']);
  });

  it('ningún motivo repite texto de un proveedor: son frases fijas', () => {
    for (const texto of Object.values(SKIP_REASON_TEXT)) {
      expect(texto).toMatch(/\.$/);
    }
  });
});

describe('mergeProviderOffers — fusión', () => {
  const deA = [hotel('1', [pack('alfa', '1', 'COP')]), hotel('2', [pack('alfa', '2', 'COP')])];
  const deB = [hotel('1', [pack('beta', '1', 'COP')])];

  it('sin equivalencias: concatena en el orden de los proveedores y de cada uno', () => {
    const merged = mergeProviderOffers([
      { code: 'alfa', offers: deA },
      { code: 'beta', offers: deB },
    ]);
    // El mismo id en dos proveedores son dos hoteles: sin equivalencia, nada los une.
    expect(merged.map((o) => [o.hotelId, o.roompacks[0]?.provider.name])).toEqual([
      ['1', 'alfa'],
      ['2', 'alfa'],
      ['1', 'beta'],
    ]);
  });

  it('con un solo proveedor la lista es exactamente la que devolvió', () => {
    expect(mergeProviderOffers([{ code: 'alfa', offers: deA }])).toEqual(deA);
  });

  it('encendida: una tarjeta por hotel canónico y cada tarifa conserva su proveedor (RF-40 CA 5)', () => {
    const canonico = (code: string, id: string): string | undefined =>
      code === 'alfa' && id === '1' ? 'C-1' : code === 'beta' && id === '1' ? 'C-1' : undefined;

    const merged = mergeProviderOffers(
      [
        { code: 'alfa', offers: deA },
        { code: 'beta', offers: deB },
      ],
      canonico,
    );

    expect(merged.map((o) => o.hotelId)).toEqual(['1', '2']);
    expect(merged[0]?.roompacks.map((p) => p.provider.name)).toEqual(['alfa', 'beta']);
  });

  it('encendida: el primero que aparece pone los datos del hotel y un hotel sin clave no se funde', () => {
    const conNombre = { ...hotel('9', [pack('alfa', '9', 'COP')]), name: 'Del primero' };
    const otroNombre = { ...hotel('7', [pack('beta', '7', 'COP')]), name: 'Del segundo' };
    const suelto = hotel('5', [pack('beta', '5', 'COP')]);

    const merged = mergeProviderOffers(
      [
        { code: 'alfa', offers: [conNombre] },
        { code: 'beta', offers: [otroNombre, suelto] },
      ],
      (_code, id) => (id === '5' ? undefined : 'C-X'),
    );

    expect(merged.map((o) => [o.name, o.roompacks.length])).toEqual([
      ['Del primero', 2],
      [undefined, 1],
    ]);
  });

  it('PR-2.6: la tarjeta fundida dice con qué id la conoce cada proveedor y cumple el contrato', () => {
    const merged = mergeProviderOffers(
      [
        { code: 'alfa', offers: [hotel('101', [pack('alfa', '101', 'USD')])] },
        { code: 'beta', offers: [hotel('B-9', [pack('beta', 'B-9', 'USD')])] },
      ],
      () => 'canon-1',
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.hotelId).toBe('101');
    expect(merged[0]?.providerHotels).toEqual([
      { provider: 'alfa', hotelId: '101' },
      { provider: 'beta', hotelId: 'B-9' },
    ]);
    expect(HotelOfferSchema.safeParse(merged[0]).success).toBe(true);
  });

  /*
   * MUTACIÓN: sin mirar el proveedor de la tarjeta, dos hoteles del mismo proveedor con la misma
   * clave serían una sola tarjeta con el nombre de uno y las tarifas de los dos.
   */
  it('PR-2.6: dos hoteles de un MISMO proveedor nunca se funden, aunque compartan clave', () => {
    const merged = mergeProviderOffers(
      [
        {
          code: 'alfa',
          offers: [hotel('1', [pack('alfa', '1', 'USD')]), hotel('2', [pack('alfa', '2', 'USD')])],
        },
      ],
      () => 'canon-1',
    );

    expect(merged.map((o) => o.hotelId)).toEqual(['1', '2']);
    expect(merged.every((o) => o.providerHotels === undefined)).toBe(true);
  });

  it('PR-2.6: un tercer hotel del proveedor que ya está en la tarjeta va aparte, y el de otro se suma', () => {
    const merged = mergeProviderOffers(
      [
        { code: 'alfa', offers: [hotel('1', [pack('alfa', '1', 'USD')])] },
        {
          code: 'beta',
          offers: [
            hotel('b1', [pack('beta', 'b1', 'USD')]),
            hotel('b2', [pack('beta', 'b2', 'USD')]),
          ],
        },
        { code: 'gama', offers: [hotel('g1', [pack('gama', 'g1', 'USD')])] },
      ],
      () => 'canon-1',
    );

    expect(merged.map((o) => o.hotelId)).toEqual(['1', 'b2']);
    expect(merged[0]?.roompacks.map((p) => p.provider.name)).toEqual(['alfa', 'beta', 'gama']);
    expect(merged[0]?.providerHotels?.map((h) => h.provider)).toEqual(['alfa', 'beta', 'gama']);
  });

  it('PR-2.6: si el primero no trae un dato, lo completa el siguiente; nunca lo pisa', () => {
    const sinNombre = { ...hotel('1', [pack('alfa', '1', 'USD')]), stars: 3 };
    const conTodo = {
      ...hotel('t1', [pack('beta', 't1', 'USD')]),
      name: 'Del catálogo del segundo',
      stars: 5,
      address: 'Av. 1',
    };

    const [tarjeta] = mergeProviderOffers(
      [
        { code: 'alfa', offers: [sinNombre] },
        { code: 'beta', offers: [conTodo] },
      ],
      () => 'canon-1',
    );

    expect(tarjeta).toMatchObject({
      hotelId: '1',
      name: 'Del catálogo del segundo',
      stars: 3,
      address: 'Av. 1',
    });
  });
});

describe('partialOutcome — respuesta parcial (RF-14 CA 3)', () => {
  it('marca `partial`, conserva estado y conteo, y antepone el motivo', () => {
    expect(partialOutcome({ code: 'x', status: 'ok', count: 4 }, 'Faltó el lote 2.')).toEqual({
      code: 'x',
      status: 'ok',
      count: 4,
      partial: true,
      reason: 'Faltó el lote 2.',
    });
  });

  it('se suma al motivo que ya hubiera, como el de moneda', () => {
    const conMoneda: HotelProviderOutcome = {
      code: 'x',
      status: 'ok',
      count: 1,
      reason: '1 tarifa en EUR no se muestra: esta búsqueda es en USD.',
      droppedForCurrency: 1,
    };
    expect(partialOutcome(conMoneda, 'Faltó el lote 2.').reason).toBe(
      'Faltó el lote 2. 1 tarifa en EUR no se muestra: esta búsqueda es en USD.',
    );
  });
});

describe('contenido desde el catálogo (PR-2.6)', () => {
  const fila = {
    hotel_id: '1120548',
    name: '  Hotel del Catálogo ',
    stars: '4.5',
    address: 'Calle 1 # 2-3   ',
    latitude: 4.6097,
    longitude: -74.0817,
  };

  it('lee la fila tal como la devuelve Postgres: NUMERIC como texto, espacios de sobra', () => {
    expect(catalogFactsOf(fila)).toEqual({
      name: 'Hotel del Catálogo',
      stars: 4.5,
      address: 'Calle 1 # 2-3',
      location: { lat: 4.6097, lng: -74.0817 },
    });
  });

  it('un dato que no cumple el contrato se omite, sin invalidar el resto', () => {
    expect(
      catalogFactsOf({
        ...fila,
        name: '   ',
        stars: '7.0',
        address: null,
        latitude: 95,
      }),
    ).toEqual({});
    expect(catalogFactsOf({ ...fila, name: 'x'.repeat(301), longitude: null })).toEqual({
      stars: 4.5,
      address: 'Calle 1 # 2-3',
    });
  });

  it('una columna en NULL es "el catálogo no lo tiene", no un cero', () => {
    expect(
      catalogFactsOf({
        hotel_id: '1',
        name: null,
        stars: null,
        address: null,
        latitude: null,
        longitude: null,
      }),
    ).toEqual({});
  });

  it('completa sólo lo que el proveedor no informó: lo del proveedor gana', () => {
    const delProveedor = { ...hotel('1120548', []), name: 'Nombre del proveedor' };
    expect(withCatalogFacts(delProveedor, catalogFactsOf(fila))).toEqual({
      ...delProveedor,
      stars: 4.5,
      address: 'Calle 1 # 2-3',
      location: { lat: 4.6097, lng: -74.0817 },
    });
  });

  it('sin nada que completar devuelve el mismo objeto', () => {
    const oferta = hotel('1', []);
    expect(withCatalogFacts(oferta, undefined)).toBe(oferta);
    expect(withCatalogFacts(oferta, {})).toBe(oferta);
  });
});

describe('telemetrySlices — una fila por proveedor LLAMADO', () => {
  const outcomes: HotelProviderOutcome[] = [
    { code: 'ok', status: 'ok', count: 3 },
    { code: 'vacio', status: 'empty', count: 0 },
    errorOutcome('caido', 'x'),
    { ...skippedOutcome('moneda', 'currency-mismatch', 'x'), droppedForCurrency: 2 },
    skippedOutcome('apagado', 'opt-in-disabled', 'x'),
    unavailableOutcome({ code: 'sin-cuenta', reason: 'no-credentials' }),
  ];
  const llamados = new Set(['ok', 'vacio', 'caido', 'moneda']);
  const duraciones = new Map([
    ['ok', 120],
    ['vacio', 80],
    ['caido', 15],
    ['moneda', 200],
  ]);

  it('los omitidos antes de llamar no dejan fila; los llamados sí, con su resultado', () => {
    expect(telemetrySlices(outcomes, llamados, duraciones)).toEqual([
      { providerCode: 'ok', durationMs: 120, resultCount: 3, outcome: 'ok' },
      { providerCode: 'vacio', durationMs: 80, resultCount: 0, outcome: 'empty' },
      {
        providerCode: 'caido',
        durationMs: 15,
        resultCount: 0,
        outcome: 'error',
        errorCode: 'ProviderCallError',
      },
      {
        providerCode: 'moneda',
        durationMs: 200,
        resultCount: 0,
        outcome: 'error',
        errorCode: 'CurrencyMismatch',
      },
    ]);
  });

  it('sin medida de duración, la fila va con 0 en vez de perderse', () => {
    const [fila] = telemetrySlices(
      [{ code: 'ok', status: 'ok', count: 1 }],
      new Set(['ok']),
      new Map(),
    );
    expect(fila?.durationMs).toBe(0);
  });
});
