import { HotelOfferSchema, type HotelOffer, type HotelRoompack } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { stubHotelOffer } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import {
  SKIP_REASON_TEXT,
  errorOutcome,
  gateByCurrency,
  mergeProviderOffers,
  occupancyViolation,
  respondedOutcome,
  skippedOutcome,
  sortOutcomes,
  telemetrySlices,
  unavailableOutcome,
  type HotelProviderOutcome,
} from './hotel-search.aggregate.js';

/**
 * Reglas de la búsqueda combinada, con datos y sin Nest: puerta de moneda (RF-13), parte por
 * proveedor (RF-14, RNF-13), topes de ocupación por proveedor, fusión de resultados (RF-34
 * preparada, RF-40) y filas de telemetría (RNF-07).
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

  it('apagada (hasta PR-2.6): concatena en el orden de los proveedores y de cada uno', () => {
    const merged = mergeProviderOffers([
      { code: 'alfa', offers: deA },
      { code: 'beta', offers: deB },
    ]);
    // El mismo id en dos proveedores son dos hoteles: no hay equivalencias todavía.
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
