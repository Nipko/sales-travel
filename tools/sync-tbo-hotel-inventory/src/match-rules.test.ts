import { describe, expect, it } from 'vitest';
import {
  DESTINATION_MAP_RULES,
  E6_GUARD_MIN_LOSSES,
  HOTEL_MATCH_RULES,
  canonicalHotelId,
  decideDestination,
  haversineMeters,
  isMassLoss,
  matchName,
  pairEvidence,
  planDestinationMap,
  planHotelMatches,
  trigramSimilarity,
  type DestinationCandidate,
  type DestinationRow,
  type HotelMatchRow,
  type HotelPair,
  type MatchHotel,
  type SourceCity,
  type TargetCity,
} from './match-rules.js';

/**
 * Las reglas de E6 sin base de datos (docs/tbo/09 PR-3.4; 05 §8.3 y §9.1; 08 RF-33 y RF-34). Los
 * criterios de salida del PR están marcados: dos candidatos → `review`; una fila `manual` no se
 * pisa; `ambiguous` no se usa.
 */

const TBO = 'tbo-hotels';
const DESPEGAR = 'despegar-hotels';
/** Plaza de Mayo. 0,001° de latitud son ~111 m. */
const BA = { lat: -34.6083, lng: -58.3712 };
const north = (meters: number): { lat: number; lng: number } => ({
  lat: BA.lat + meters / 111_195,
  lng: BA.lng,
});

function hotel(hotelId: string, name: string, meters = 0, stars: number | null = 4): MatchHotel {
  return { hotelId, name, stars, location: north(meters) };
}

function pair(target: MatchHotel, source: MatchHotel): HotelPair {
  return { target, source };
}

function stored(
  providerCode: string,
  hotelId: string,
  canonical: string,
  extra: Partial<HotelMatchRow> = {},
): HotelMatchRow {
  return {
    canonicalHotelId: canonical,
    providerCode,
    hotelId,
    method: 'heuristic',
    score: 1,
    status: 'accepted',
    ...extra,
  };
}

function plan(
  pairs: readonly HotelPair[],
  storedRows: readonly HotelMatchRow[] = [],
  scope: readonly string[] = pairs.map((p) => p.target.hotelId),
): ReturnType<typeof planHotelMatches> {
  return planHotelMatches({
    sourceProvider: DESPEGAR,
    targetProvider: TBO,
    pairs,
    scopeTargetIds: new Set(scope),
    stored: storedRows,
  });
}

const byRef = (rows: readonly HotelMatchRow[]): Record<string, Partial<HotelMatchRow>> =>
  Object.fromEntries(
    rows.map((r) => [
      `${r.providerCode}:${r.hotelId}`,
      { canonicalHotelId: r.canonicalHotelId, status: r.status, method: r.method },
    ]),
  );

describe('nombres y distancia', () => {
  it('trigramSimilarity es la similarity() de pg_trgm', () => {
    // Ejemplo de la documentación de pg_trgm: similarity('word', 'two words') = 0.363636.
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(4 / 11, 6);
    expect(trigramSimilarity('alvear palace', 'alvear palace')).toBe(1);
    expect(trigramSimilarity('', 'algo')).toBe(0);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
  });

  it('matchName quita acentos, puntuación y palabras genéricas, y conserva la marca', () => {
    expect(matchName('Hotel Dann Carlton Bogotá')).toBe('dann carlton bogota');
    expect(matchName('The Hotel')).toBe('');
    expect(matchName('Pousada do Sol & Mar')).toBe('pousada sol mar');
    expect(matchName('Ibis Budget Bogotá Museo')).toBe('ibis budget bogota museo');
    expect(matchName(null)).toBe('');
  });

  it('haversine en metros', () => {
    expect(haversineMeters(BA, north(150))).toBeCloseTo(150, 0);
    expect(haversineMeters(BA, BA)).toBe(0);
    // Bogotá → Medellín, ~240 km en línea recta.
    const km =
      haversineMeters({ lat: 4.711, lng: -74.0721 }, { lat: 6.2442, lng: -75.5812 }) / 1_000;
    expect(km).toBeGreaterThan(235);
    expect(km).toBeLessThan(245);
  });
});

describe('pairEvidence: D-TBO-13 A (≤ 150 m, similitud ≥ 0,5, estrellas ± 1)', () => {
  const rules = HOTEL_MATCH_RULES;

  it('mismo hotel con el nombre escrito distinto: califica', () => {
    const evidence = pairEvidence(
      pair(hotel('T1', 'Alvear Palace Hotel', 0, 5), hotel('D1', 'Hotel Alvear Palace', 60, 5)),
      rules,
    );
    expect(evidence).toMatchObject({ similarity: 1, starsDiff: 0, qualifies: true });
    expect(evidence.distanceM).toBeCloseTo(60, 0);
  });

  it('a 151 m, con nombre distinto o con dos estrellas de diferencia, no', () => {
    const base = hotel('T1', 'Alvear Palace', 0, 5);
    expect(pairEvidence(pair(base, hotel('D1', 'Alvear Palace', 151, 5)), rules).qualifies).toBe(
      false,
    );
    expect(pairEvidence(pair(base, hotel('D1', 'Four Seasons', 10, 5)), rules).qualifies).toBe(
      false,
    );
    expect(pairEvidence(pair(base, hotel('D1', 'Alvear Palace', 10, 3)), rules).qualifies).toBe(
      false,
    );
  });

  it('sin estrellas de un lado, decide la distancia y el nombre', () => {
    const evidence = pairEvidence(
      pair(hotel('T1', 'Alvear Palace', 0, null), hotel('D1', 'Alvear Palace', 10, 5)),
      rules,
    );
    expect(evidence).toMatchObject({ starsDiff: null, qualifies: true });
  });
});

describe('planHotelMatches', () => {
  it('candidato único de los dos lados: ambos accepted con la clave del hotel de Despegar', () => {
    const result = plan([
      pair(hotel('T1', 'Alvear Palace Hotel'), hotel('D1', 'Hotel Alvear Palace', 40)),
      // Cerca pero otro hotel: no califica y no genera fila.
      pair(hotel('T1', 'Alvear Palace Hotel'), hotel('D9', 'Four Seasons', 80)),
    ]);

    expect(byRef(result.upserts)).toEqual({
      'tbo-hotels:T1': {
        canonicalHotelId: 'despegar-hotels:D1',
        status: 'accepted',
        method: 'heuristic',
      },
      'despegar-hotels:D1': {
        canonicalHotelId: 'despegar-hotels:D1',
        status: 'accepted',
        method: 'heuristic',
      },
    });
    expect(result.upserts.every((r) => r.score === 1)).toBe(true);
    expect(result.demotions).toEqual([]);
    expect(result.counts).toMatchObject({ pairsNear: 2, pairsQualifying: 1, acceptedPairs: 1 });
  });

  it('criterio de PR-3.4: dos candidatos → review, y nadie queda accepted', () => {
    // Dos hoteles de la misma cadena en el mismo edificio: el de TBO se parece a los dos.
    const tbo = hotel('T1', 'Ibis Bogota Museo', 0, 3);
    const result = plan([
      pair(tbo, hotel('D1', 'Ibis Bogotá Museo', 20, 3)),
      pair(tbo, hotel('D2', 'Ibis Budget Bogotá Museo', 30, 2)),
    ]);

    expect(byRef(result.upserts)).toEqual({
      // La clave del mejor candidato, sólo como pista para quien revise: `review` no agrupa.
      'tbo-hotels:T1': {
        canonicalHotelId: 'despegar-hotels:D1',
        status: 'review',
        method: 'heuristic',
      },
      'despegar-hotels:D1': {
        canonicalHotelId: 'despegar-hotels:D1',
        status: 'review',
        method: 'heuristic',
      },
      'despegar-hotels:D2': {
        canonicalHotelId: 'despegar-hotels:D2',
        status: 'review',
        method: 'heuristic',
      },
    });
    expect(result.counts).toMatchObject({ acceptedPairs: 0, reviewHotels: 3 });
  });

  it('dos hoteles de TBO para uno de Despegar: también review', () => {
    const despegar = hotel('D1', 'Sheraton Bogota', 0);
    const result = plan([
      pair(hotel('T1', 'Sheraton Bogota Hotel', 10), despegar),
      pair(hotel('T2', 'Sheraton Bogota', 90), despegar),
    ]);
    expect(result.upserts.map((r) => r.status)).toEqual(['review', 'review', 'review']);
    expect(result.counts.acceptedPairs).toBe(0);
  });

  it('criterio de PR-3.4: una fila manual no se pisa, y su pareja va a review', () => {
    const manual = stored(TBO, 'T1', 'grupo-curado-7', { method: 'manual', score: null });
    const result = plan(
      [pair(hotel('T1', 'Alvear Palace'), hotel('D1', 'Alvear Palace', 10))],
      [manual],
    );

    expect(result.upserts.map((r) => `${r.providerCode}:${r.hotelId}:${r.status}`)).toEqual([
      'despegar-hotels:D1:review',
    ]);
    expect(result.demotions).toEqual([]);
    expect(result.counts.protectedHotels).toBe(1);
  });

  it('una fila giata del lado de Despegar tampoco se pisa', () => {
    const giata = stored(DESPEGAR, 'D1', 'giata:123', { method: 'giata' });
    const result = plan(
      [pair(hotel('T1', 'Alvear Palace'), hotel('D1', 'Alvear Palace'))],
      [giata],
    );
    expect(result.upserts.map((r) => `${r.providerCode}:${r.hotelId}:${r.status}`)).toEqual([
      'tbo-hotels:T1:review',
    ]);
  });

  it('lo que ya no se sostiene pasa a rejected: el hotel de TBO del alcance y su pareja huérfana', () => {
    const result = plan(
      [],
      [stored(TBO, 'T1', 'despegar-hotels:D1'), stored(DESPEGAR, 'D1', 'despegar-hotels:D1')],
      ['T1'],
    );
    expect(result.upserts).toEqual([]);
    expect(result.demotions).toEqual([
      { providerCode: TBO, hotelId: 'T1' },
      { providerCode: DESPEGAR, hotelId: 'D1' },
    ]);
    expect(result.counts).toMatchObject({ acceptedInScope: 2, acceptedLost: 2 });
  });

  it('fuera de los países de la corrida no se toca nada, ni la pareja de Despegar de ese grupo', () => {
    const result = plan(
      [],
      [stored(TBO, 'T-MX', 'despegar-hotels:D7'), stored(DESPEGAR, 'D7', 'despegar-hotels:D7')],
      ['T1'],
    );
    expect(result.demotions).toEqual([]);
    expect(result.counts).toMatchObject({ acceptedInScope: 0, acceptedLost: 0 });
  });

  it('lo manual y lo ya rechazado no se dan de baja', () => {
    const result = plan(
      [],
      [
        stored(TBO, 'T1', 'x', { method: 'manual' }),
        stored(TBO, 'T2', 'y', { status: 'rejected' }),
        stored(DESPEGAR, 'D1', 'x', { method: 'manual' }),
      ],
      ['T1', 'T2'],
    );
    expect(result.demotions).toEqual([]);
  });

  it('un hotel que cambia de pareja se mueve de grupo y el grupo viejo queda sin nadie', () => {
    const result = plan(
      [pair(hotel('T1', 'Alvear Palace'), hotel('D2', 'Alvear Palace', 20))],
      [stored(TBO, 'T1', 'despegar-hotels:D1'), stored(DESPEGAR, 'D1', 'despegar-hotels:D1')],
    );
    expect(byRef(result.upserts)).toMatchObject({
      'tbo-hotels:T1': { canonicalHotelId: 'despegar-hotels:D2', status: 'accepted' },
      'despegar-hotels:D2': { canonicalHotelId: 'despegar-hotels:D2', status: 'accepted' },
    });
    expect(result.demotions).toEqual([{ providerCode: DESPEGAR, hotelId: 'D1' }]);
  });

  it('la pareja que pasa a review por una fila manual no cuenta para la guarda de caída', () => {
    // 21 de 40 equivalencias con el hotel de TBO curado a mano: sus parejas de Despegar van a
    // `review` por decisión humana. Contarlas retendría E6 en todas las corridas siguientes.
    const pairs: HotelPair[] = [];
    const rows: HotelMatchRow[] = [];
    for (let i = 0; i < 40; i += 1) {
      const canonical = canonicalHotelId(DESPEGAR, `D${i}`);
      pairs.push(
        pair(hotel(`T${i}`, `Posada ${i}`, i * 1_000), hotel(`D${i}`, `Posada ${i}`, i * 1_000)),
      );
      rows.push(
        stored(TBO, `T${i}`, canonical, i < 21 ? { method: 'manual', score: null } : {}),
        stored(DESPEGAR, `D${i}`, canonical),
      );
    }
    const result = plan(pairs, rows);

    expect(result.upserts.filter((r) => r.status === 'review')).toHaveLength(21);
    expect(result.counts).toMatchObject({ acceptedLost: 0, acceptedInScope: 38 });
    expect(isMassLoss(result.counts, 0.5)).toBe(false);
  });

  it('una fila igual a la guardada no se reescribe', () => {
    const canonical = canonicalHotelId(DESPEGAR, 'D1');
    const result = plan(
      [pair(hotel('T1', 'Alvear Palace'), hotel('D1', 'Alvear Palace', 20))],
      [stored(TBO, 'T1', canonical), stored(DESPEGAR, 'D1', canonical)],
    );
    expect(result.upserts).toEqual([]);
    expect(result.demotions).toEqual([]);
    expect(result.counts.unchanged).toBe(2);
  });

  it('un par repetido cuenta una vez', () => {
    const p = pair(hotel('T1', 'Alvear Palace'), hotel('D1', 'Alvear Palace', 20));
    expect(plan([p, p]).counts).toMatchObject({ pairsNear: 1, acceptedPairs: 1 });
  });
});

// ───────────────────────── Mapa de destinos ─────────────────────────

function target(cityCode: string, km: number | null, extra: Partial<TargetCity> = {}): TargetCity {
  return {
    cityCode,
    countryCode: 'AR',
    hotelCount: 100,
    centroid: km === null ? null : north(km * 1_000),
    attempted: true,
    ...extra,
  };
}

const SOURCE: SourceCity = { cityId: '6585', hotelCount: 100, centroid: BA };

function candidates(
  ...list: readonly [TargetCity, number, number][]
): readonly DestinationCandidate[] {
  return list.map(([city, distanceKm, overlap]) => ({ city, distanceKm, overlap }));
}

describe('decideDestination (05 §8.3)', () => {
  const none = new Set<string>();

  it('solapamiento fuerte y claro: accepted overlap', () => {
    expect(
      decideDestination(
        SOURCE,
        candidates([target('C1', 2), 2, 12], [target('C2', 9), 9, 4]),
        none,
      ),
    ).toEqual({ kind: 'accepted', method: 'overlap', targetCityCode: 'C1', score: 0.12 });
  });

  it('pueblos chicos: el 20 % del lado más chico basta aunque no llegue a k', () => {
    const small: SourceCity = { cityId: '7', hotelCount: 4, centroid: BA };
    expect(
      decideDestination(small, candidates([target('C1', 1, { hotelCount: 5 }), 1, 1]), none),
    ).toMatchObject({ kind: 'accepted', method: 'overlap', targetCityCode: 'C1', score: 0.25 });
  });

  it('dos ciudades con solapamiento parecido: ambiguous con las dos', () => {
    expect(
      decideDestination(SOURCE, candidates([target('C1', 2), 2, 6], [target('C2', 4), 4, 5]), none),
    ).toEqual({
      kind: 'ambiguous',
      method: 'overlap',
      targets: [
        { targetCityCode: 'C1', score: 0.06 },
        { targetCityCode: 'C2', score: 0.05 },
      ],
    });
  });

  it('solapamiento débil (1 de 100): ambiguous, no se cae al centroide', () => {
    expect(decideDestination(SOURCE, candidates([target('C1', 0.5), 0.5, 1]), none)).toMatchObject({
      kind: 'ambiguous',
      method: 'overlap',
    });
  });

  it('sin solapamiento: la más cercana a < 5 km con la segunda a más del doble', () => {
    expect(
      decideDestination(SOURCE, candidates([target('C1', 1), 1, 0], [target('C2', 3), 3, 0]), none),
    ).toEqual({ kind: 'accepted', method: 'centroid', targetCityCode: 'C1', score: 0.8 });
  });

  it('sin solapamiento y la segunda cerca: ambiguous', () => {
    expect(
      decideDestination(
        SOURCE,
        candidates([target('C1', 1), 1, 0], [target('C2', 1.5), 1.5, 0], [target('C3', 9), 9, 0]),
        none,
      ),
    ).toEqual({
      kind: 'ambiguous',
      method: 'centroid',
      targets: [
        { targetCityCode: 'C1', score: 0.8 },
        { targetCityCode: 'C2', score: 0.7 },
      ],
    });
  });

  it('sin solapamiento y la más cercana a más de r km: nada', () => {
    expect(decideDestination(SOURCE, candidates([target('C1', 8), 8, 0]), none)).toEqual({
      kind: 'none',
      reason: 'too-far',
    });
  });

  it('sin solapamiento en un país que E3 no terminó de recorrer: nada todavía', () => {
    expect(decideDestination(SOURCE, candidates([target('C1', 1), 1, 0]), new Set(['AR']))).toEqual(
      { kind: 'none', reason: 'catalog-incomplete' },
    );
  });
});

function dest(
  sourceCityId: string,
  targetCityCode: string,
  extra: Partial<DestinationRow> = {},
): DestinationRow {
  return {
    sourceCityId,
    targetCityCode,
    method: 'overlap',
    score: 0.5,
    status: 'accepted',
    ...extra,
  };
}

describe('planDestinationMap', () => {
  it('acepta por centroide y por solapamiento, y sólo mira ciudades a menos de R km', () => {
    const result = planDestinationMap({
      sources: [
        { cityId: '100', hotelCount: 30, centroid: BA },
        { cityId: '200', hotelCount: 10, centroid: north(40_000) },
        // Lejos de toda ciudad del proveedor: fuera del alcance.
        { cityId: '300', hotelCount: 10, centroid: { lat: 10, lng: 10 } },
        // Sin coordenadas: no se puede decidir.
        { cityId: '400', hotelCount: 3, centroid: null },
      ],
      targets: [target('C1', 0.4), target('C2', 40.5), target('C3', null)],
      overlaps: [{ sourceCityId: '100', targetCityCode: 'C1', matched: 9 }],
      stored: [],
    });

    expect(result.upserts).toEqual([
      {
        sourceCityId: '100',
        targetCityCode: 'C1',
        method: 'overlap',
        score: 0.3,
        status: 'accepted',
      },
      {
        sourceCityId: '200',
        targetCityCode: 'C2',
        method: 'centroid',
        score: 0.9,
        status: 'accepted',
      },
    ]);
    expect(result.counts).toMatchObject({
      sourcesInScope: 2,
      acceptedOverlap: 1,
      acceptedCentroid: 1,
    });
  });

  it('criterio de PR-3.4: ambiguous queda como ambiguous, nunca como accepted', () => {
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 1), target('C2', 1.5)],
      overlaps: [],
      stored: [],
    });
    expect(result.upserts.map((r) => [r.targetCityCode, r.status])).toEqual([
      ['C1', 'ambiguous'],
      ['C2', 'ambiguous'],
    ]);
    expect(result.upserts.some((r) => r.status === 'accepted')).toBe(false);
  });

  it('criterio de PR-3.4: un destino con fila manual no se recalcula; lo automático suyo se rechaza', () => {
    const manual = dest('6585', 'C9', { method: 'manual', score: null });
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 0.5)],
      overlaps: [{ sourceCityId: '6585', targetCityCode: 'C1', matched: 50 }],
      stored: [manual, dest('6585', 'C1', { method: 'centroid', score: 0.9 })],
    });
    expect(result.upserts).toEqual([]);
    expect(result.demotions).toEqual([{ sourceCityId: '6585', targetCityCode: 'C1' }]);
    expect(result.counts.manualOwned).toBe(1);
  });

  it('las bajas de destinos que una persona decidió no cuentan para la guarda de caída', () => {
    // 21 de 40 destinos corregidos a mano: sus filas automáticas pasan a `rejected`. Si contaran,
    // el mapa quedaría retenido en cada corrida y la fila vieja seguiría sumada a la manual.
    const sources: SourceCity[] = [];
    const targets: TargetCity[] = [];
    const overlaps = [];
    const storedRows: DestinationRow[] = [];
    for (let i = 0; i < 40; i += 1) {
      const centroid = north(i * 60_000);
      sources.push({ cityId: `S${i}`, hotelCount: 10, centroid });
      targets.push(target(`C${i}`, null, { centroid }));
      overlaps.push({ sourceCityId: `S${i}`, targetCityCode: `C${i}`, matched: 8 });
      storedRows.push(dest(`S${i}`, `C${i}`, { score: 0.8 }));
      if (i < 21) storedRows.push(dest(`S${i}`, `X${i}`, { method: 'manual', score: null }));
    }
    const result = planDestinationMap({ sources, targets, overlaps, stored: storedRows });

    expect(result.demotions).toHaveLength(21);
    expect(result.counts).toMatchObject({ manualOwned: 21, acceptedLost: 0, acceptedInScope: 19 });
    expect(isMassLoss(result.counts, 0.5)).toBe(false);
  });

  it('cambia de ciudad: la nueva accepted y la vieja rejected; una ya rechazada no se toca', () => {
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 0.5), target('C2', 12)],
      overlaps: [{ sourceCityId: '6585', targetCityCode: 'C1', matched: 20 }],
      stored: [dest('6585', 'C2'), dest('6585', 'C3', { status: 'rejected' })],
    });
    expect(result.upserts.map((r) => [r.targetCityCode, r.status])).toEqual([['C1', 'accepted']]);
    expect(result.demotions).toEqual([{ sourceCityId: '6585', targetCityCode: 'C2' }]);
  });

  it('un destino que desaparece del catálogo de origen pierde su fila; otro proveedor u otro país no', () => {
    const result = planDestinationMap({
      sources: [],
      targets: [target('C1', 0.5)],
      overlaps: [],
      stored: [dest('999', 'C1'), dest('999', 'MX-7')],
    });
    expect(result.demotions).toEqual([{ sourceCityId: '999', targetCityCode: 'C1' }]);
    expect(result.counts).toMatchObject({ acceptedInScope: 1, acceptedLost: 1 });
  });

  it('una fila igual a la guardada no se reescribe', () => {
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 1)],
      overlaps: [],
      stored: [dest('6585', 'C1', { method: 'centroid', score: 0.8 })],
    });
    expect(result.upserts).toEqual([]);
    expect(result.counts.unchanged).toBe(1);
  });

  it('un destino sin decidir por un país a medio recorrer conserva su mapeo', () => {
    // E2 trajo una ciudad nueva de AR que E3 todavía no pidió: la distancia ya no alcanza para
    // decidir, pero lo aceptado antes sigue valiendo hasta que E3 la recorra.
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 1), target('C-NEW', null, { attempted: false })],
      overlaps: [],
      stored: [dest('6585', 'C1', { method: 'centroid', score: 0.8 })],
    });
    expect(result.counts.catalogIncomplete).toBe(1);
    expect(result.upserts).toEqual([]);
    expect(result.demotions).toEqual([]);
    expect(result.counts.acceptedLost).toBe(0);
  });

  it('informa los países con ciudades nunca pedidas', () => {
    const result = planDestinationMap({
      sources: [SOURCE],
      targets: [target('C1', 1), target('C2', null, { attempted: false, countryCode: 'UY' })],
      overlaps: [],
      stored: [],
    });
    expect(result.incompleteCountries).toEqual(['UY']);
    // La candidata es de AR, que está completo: se acepta igual.
    expect(result.counts.acceptedCentroid).toBe(1);
  });

  it('el radio es configurable y el índice por celdas encuentra ciudades en celdas vecinas', () => {
    const result = planDestinationMap({
      // Con R = 1 km las celdas son de 0,01°: estas dos quedan en celdas distintas de ambos ejes.
      sources: [{ cityId: '1', hotelCount: 5, centroid: { lat: 0.001, lng: 0.001 } }],
      targets: [target('C1', null, { centroid: { lat: -0.001, lng: -0.002 } })],
      overlaps: [],
      stored: [],
      rules: { ...DESTINATION_MAP_RULES, radiusKm: 1 },
    });
    expect(result.counts.sourcesInScope).toBe(1);
  });
});

describe('isMassLoss: la guarda de caída de E6', () => {
  it('el recambio chico se aplica siempre; una caída masiva se retiene', () => {
    expect(isMassLoss({ acceptedInScope: 2, acceptedLost: 2 }, 0.5)).toBe(false);
    expect(isMassLoss({ acceptedInScope: 100, acceptedLost: E6_GUARD_MIN_LOSSES }, 0.5)).toBe(
      false,
    );
    expect(isMassLoss({ acceptedInScope: 30, acceptedLost: 20 }, 0.5)).toBe(true);
    expect(isMassLoss({ acceptedInScope: 1_000, acceptedLost: 501 }, 0.5)).toBe(true);
  });
});
