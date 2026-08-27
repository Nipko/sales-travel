import { beforeAll, describe, expect, it } from 'vitest';
import {
  describeAirport,
  getAirportByCode,
  getPopularAirports,
  loadFullDataset,
  normalizeAirport,
  rankAirports,
  searchAirports,
  type Airport,
} from './airports';

/**
 * Todo se ejerce contra el dataset real de 8800 aeropuertos, no contra un fixture: el bug
 * que reportó el founder ("Bo, Sierra Leona" arriba de Bogotá) sólo existe cuando están
 * presentes los 8800. Con la lista curada de 20 no se reproduce nada.
 */
beforeAll(async () => {
  await loadFullDataset();
});

function codes(query: string, limit = 8): string[] {
  return searchAirports(query, limit).map((a) => a.code);
}

describe('el desplegable no puede prometer banderas que no se ven', () => {
  it('ningún aeropuerto expone `flag`: en Windows los indicadores regionales son cuadros vacíos', () => {
    const muestra = [...getPopularAirports(20), ...searchAirports('bogota', 5)];
    for (const airport of muestra) {
      expect(airport).not.toHaveProperty('flag');
    }
  });

  it('trae el código ISO del país, que sí es texto que renderiza en cualquier fuente', () => {
    const bog = getAirportByCode('BOG');
    expect(bog?.countryCode).toBe('CO');
    expect(bog?.country).toBe('Colombia');
  });
});

describe('relevancia para un vendedor LATAM', () => {
  /**
   * La tabla del founder: lo que de verdad teclea alguien vendiendo desde Bogotá.
   * `mustBeFirst` es el resultado que tiene que quedar arriba; `mustRankAbove` fija los
   * duelos concretos que estaban al revés en producción.
   */
  const casos: {
    query: string;
    mustBeFirst: string;
    mustRankAbove?: [string, string];
    why: string;
  }[] = [
    {
      query: 'bo',
      mustBeFirst: 'BOG',
      mustRankAbove: ['BOG', 'KBS'],
      why: 'dos letras: Bogotá le gana a "Bo" (Sierra Leona, sin vuelos regulares)',
    },
    {
      query: 'bo',
      mustBeFirst: 'BOG',
      mustRankAbove: ['BOG', 'BOD'],
      why: 'Bogotá antes que Bordeaux, que ganaba el desempate por `size`',
    },
    { query: 'bog', mustBeFirst: 'BOG', why: 'código IATA exacto' },
    { query: 'lim', mustBeFirst: 'LIM', why: 'código IATA exacto' },
    { query: 'gru', mustBeFirst: 'GRU', why: 'código IATA exacto' },
    { query: 'mia', mustBeFirst: 'MIA', why: 'código IATA exacto' },
    {
      query: 'med',
      mustBeFirst: 'MED',
      mustRankAbove: ['MDE', 'MFR'],
      why: 'MED es un IATA exacto de un aeropuerto que opera (Medina) y manda',
    },
    {
      query: 'car',
      mustBeFirst: 'CTG',
      mustRankAbove: ['CTG', 'CAR'],
      why: 'CAR es un IATA exacto SIN vuelos regulares (Caribou): no tapa a Cartagena',
    },
    {
      query: 'nei',
      mustBeFirst: 'NVA',
      mustRankAbove: ['NVA', 'NEI'],
      why: 'NEI es una pista rusa sin vuelos; el vendedor buscaba Neiva',
    },
    {
      query: 'man',
      mustBeFirst: 'MAN',
      mustRankAbove: ['MAO', 'MJC'],
      why: 'Manaus por encima de "Man" (Costa de Marfil), que coincide exacto con 3 letras',
    },
    {
      query: 'cart',
      mustBeFirst: 'CTG',
      mustRankAbove: ['CTG', 'CRC'],
      why: 'Cartagena antes que Cartago',
    },
    {
      query: 'sao',
      mustBeFirst: 'GRU',
      mustRankAbove: ['GRU', 'TMS'],
      why: 'São Paulo/Guarulhos antes que São Tomé',
    },
  ];

  for (const caso of casos) {
    it(`«${caso.query}» → ${caso.mustBeFirst} primero (${caso.why})`, () => {
      const result = codes(caso.query);
      expect(result[0]).toBe(caso.mustBeFirst);
      if (caso.mustRankAbove) {
        const [arriba, abajo] = caso.mustRankAbove;
        const iArriba = result.indexOf(arriba);
        expect(iArriba).toBeGreaterThanOrEqual(0);
        const iAbajo = result.indexOf(abajo);
        // Si el perdedor ni siquiera entra en los 8, mejor todavía.
        expect(iAbajo === -1 || iArriba < iAbajo).toBe(true);
      }
    });
  }

  it('«med» deja Medellín segundo, justo debajo del IATA exacto', () => {
    expect(codes('med')[1]).toBe('MDE');
  });

  it('un IATA exacto que SÍ opera no lo desbanca ningún hub: teclear el código es una orden', () => {
    // MED (Medina, Arabia Saudita, mayor y con vuelos regulares) compite contra MDE, un hub
    // del mercado inicial con todos los bonus posibles. Si esto se pusiera rojo, escribir
    // códigos dejaría de ser predecible, que es la herramienta de precisión del vendedor.
    expect(codes('med')[0]).toBe('MED');
  });

  it('el IATA exacto sin vuelos regulares cede: es la mitad del reclamo del founder', () => {
    // Contraparte exacta del test de arriba. La diferencia entre MED y CAR no es el país
    // ni el tamaño: es que a Caribou no se vuela, así que esas tres letras no pueden ser
    // lo que quiso decir alguien armando una cotización.
    expect(codes('car')[0]).toBe('CTG');
    expect(codes('car').indexOf('CAR')).toBeGreaterThan(0);
  });

  it('no todo es LATAM: una búsqueda de fuera sigue encontrando lo suyo', () => {
    expect(codes('bordeaux')[0]).toBe('BOD');
    expect(codes('madrid')[0]).toBe('MAD');
    expect(codes('miami')[0]).toBe('MIA');
  });

  it('respeta el límite y devuelve algo para cada búsqueda de la tabla', () => {
    for (const caso of casos) {
      const result = codes(caso.query, 8);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('el mercado es un parámetro, no una creencia del componente', () => {
  it('cambiar `homeMarkets` cambia el orden: el sesgo LATAM es el default, no una constante', () => {
    const conLatam = searchAirports('bo', 8).map((a) => a.code);
    // Un consolidador francés: Bordeaux pasa a mercado local y Bogotá deja de tener bonus.
    const conFrancia = searchAirports('bo', 8, { homeMarkets: ['FR'] }).map((a) => a.code);
    expect(conLatam.indexOf('BOG')).toBeLessThan(conLatam.indexOf('BOD'));
    expect(conFrancia.indexOf('BOD')).toBeLessThan(conFrancia.indexOf('BOG'));
  });
});

describe('filas del endpoint /api/airports', () => {
  /** Forma literal que devuelve `AirportsService.search` en apps/api. */
  const filaDelServidor = {
    code: 'BOG',
    name: 'El Dorado Intl',
    city: 'Bogota',
    countryCode: 'CO',
    countryName: 'Colombia',
  };

  it('rellena `country` desde `countryName`: antes quedaba un «·» colgando sin país', () => {
    const a = normalizeAirport(filaDelServidor);
    expect(a?.country).toBe('Colombia');
  });

  it('sin `size` ni `scheduled` no inventa importancia: quedan en 0 / null', () => {
    const a = normalizeAirport(filaDelServidor);
    expect(a?.size).toBe(0);
    // null, no false: false significaría "sabemos que no tiene vuelos" y degradaría la
    // fila en el ranking por un dato que el endpoint sencillamente no devuelve.
    expect(a?.scheduled).toBeNull();
  });

  it('no saber si hay vuelos NO es lo mismo que saber que no los hay', () => {
    // Aeropuertos inventados a propósito: lo que se prueba es la diferencia entre `null` y
    // `false`, y hace falta un rival lo bastante fuerte para que la degradación se note.
    const rival: Airport = {
      code: 'ZZZ',
      name: 'Rival',
      city: 'Volcan',
      country: 'Colombia',
      countryCode: 'CO',
      size: 3,
      scheduled: true,
    };
    const sinDato: Airport = {
      code: 'VOL',
      name: 'Fila del endpoint',
      city: 'Ciudad Sin Datos',
      country: '',
      countryCode: '',
      size: 0,
      scheduled: null,
    };

    // `null`: el IATA exacto manda igual, porque no hay nada que le reproche.
    expect(rankAirports([rival, sinDato], 'vol').map((a) => a.code)).toEqual(['VOL', 'ZZZ']);
    // `false`: sabemos que no se vuela, y ahí sí cede ante el hub del mercado.
    const cerrado: Airport = { ...sinDato, scheduled: false };
    expect(rankAirports([rival, cerrado], 'vol').map((a) => a.code)).toEqual(['ZZZ', 'VOL']);
  });

  it('descarta la fila sin código IATA, que no sería seleccionable', () => {
    expect(normalizeAirport({ city: 'Bogotá', countryName: 'Colombia' })).toBeNull();
    expect(normalizeAirport(null)).toBeNull();
    expect(normalizeAirport('BOG')).toBeNull();
  });

  it('reordena lo que llega del servidor con el mismo criterio que el dataset local', () => {
    // El servidor ordena por código alfabético: para "bo" manda BOD antes que BOG.
    const delServidor: Airport[] = [
      normalizeAirport({ code: 'BOD', name: 'Bordeaux', city: 'Bordeaux', countryCode: 'FR' }),
      normalizeAirport({ code: 'BOG', name: 'El Dorado Intl', city: 'Bogota', countryCode: 'CO' }),
      normalizeAirport({ code: 'BOS', name: 'Logan Intl', city: 'Boston', countryCode: 'US' }),
    ].filter((a): a is Airport => a !== null);

    expect(rankAirports(delServidor, 'bo').map((a) => a.code)).toEqual(['BOG', 'BOS', 'BOD']);
  });

  it('el aeropuerto al que se vuela le gana al más grande al que no', () => {
    // Nada que se pueda cotizar sale de una pista sin vuelos regulares, por grande que sea.
    const rows: Airport[] = [
      {
        code: 'AAA',
        name: 'Grande',
        city: 'Volcan Alto',
        country: 'X',
        countryCode: 'XX',
        size: 3,
        scheduled: false,
      },
      {
        code: 'ZZZ',
        name: 'Mediano',
        city: 'Volcan Bajo',
        country: 'X',
        countryCode: 'XX',
        size: 2,
        scheduled: true,
      },
    ];
    expect(rankAirports(rows, 'volcan').map((a) => a.code)).toEqual(['ZZZ', 'AAA']);
  });

  it('dos aeropuertos idénticos salen siempre en el mismo orden, entren como entren', () => {
    // Sin desempate estable, el orden dependería de cómo venga la lista y la misma
    // búsqueda daría resultados distintos entre el dataset local y el endpoint.
    const base = { name: 'Gemelo', country: 'X', countryCode: 'XX', size: 2, scheduled: true };
    const a: Airport = { ...base, code: 'AAA', city: 'Gemela Uno' };
    const z: Airport = { ...base, code: 'ZZZ', city: 'Gemela Dos' };
    expect(rankAirports([a, z], 'gemela').map((x) => x.code)).toEqual(['AAA', 'ZZZ']);
    expect(rankAirports([z, a], 'gemela').map((x) => x.code)).toEqual(['AAA', 'ZZZ']);
  });

  it('sin búsqueda deja la lista como vino', () => {
    const items = searchAirports('bogota', 3);
    expect(rankAirports(items, '   ').map((a) => a.code)).toEqual(items.map((a) => a.code));
  });
});

describe('lectura por lector de pantalla', () => {
  it('arma una frase con ciudad, código, aeropuerto y país', () => {
    const bog = getAirportByCode('BOG');
    expect(bog && describeAirport(bog)).toBe('Bogota (BOG) — El Dorado Intl, Colombia');
  });

  it('no deja separadores huérfanos cuando falta el país', () => {
    const parcial = normalizeAirport({ code: 'XXX', city: 'Nowhere', name: 'Nowhere Field' });
    expect(parcial && describeAirport(parcial)).toBe('Nowhere (XXX) — Nowhere Field');
  });
});
