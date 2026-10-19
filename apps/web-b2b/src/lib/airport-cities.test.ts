import { beforeAll, describe, expect, it } from 'vitest';
import {
  CITY_AREAS,
  describeOption,
  groupByCity,
  labelForCode,
  optionCode,
  optionKey,
  optionLabel,
  optionsFromCodes,
  type LocationOption,
} from './airport-cities';
import { loadFullDataset, normalizeAirport, searchAirports, type Airport } from './airports';

beforeAll(async () => {
  await loadFullDataset();
});

/** Lo que ve el vendedor, fila por fila: `city:MDE` es «Medellín, todos los aeropuertos». */
function rows(options: readonly LocationOption[]): string[] {
  return options.map((o) => (o.kind === 'city' ? `city:${o.area.code}` : o.airport.code));
}

function search(query: string): string[] {
  return rows(groupByCity(searchAirports(query, 8), query));
}

/** Filas como las devolvía el endpoint con el catálogo de OpenFlights, que ponía MDE en «Rio Negro». */
function fromServer(items: unknown[], query: string): string[] {
  const airports = items.map(normalizeAirport).filter((a): a is Airport => a !== null);
  return rows(groupByCity(airports, query));
}

describe('Medellín: el aeropuerto que todos conocen es MDE', () => {
  it('«medellin» muestra la ciudad, MDE primero y EOH debajo', () => {
    expect(search('medellin').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
  });

  it('con tilde y en mayúsculas, lo mismo', () => {
    expect(search('Medellín').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
    expect(search('MEDELLIN').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
  });

  it('aunque el servidor sólo devuelva EOH, la ciudad trae a MDE primero', () => {
    const servidor = [
      {
        code: 'EOH',
        name: 'Enrique Olaya Herrera',
        city: 'Medellin',
        countryCode: 'CO',
        countryName: 'Colombia',
      },
    ];
    expect(fromServer(servidor, 'medellin')).toEqual(['city:MDE', 'MDE', 'EOH']);
  });

  it('«rionegro», el municipio donde está la pista, también encuentra MDE', () => {
    expect(search('rionegro').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
    expect(fromServer([], 'rionegro')).toEqual(['city:MDE', 'MDE', 'EOH']);
  });

  it('por código y por nombre del aeropuerto', () => {
    expect(search('MDE').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
    expect(search('eoh').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
    expect(search('olaya').slice(0, 3)).toEqual(['city:MDE', 'MDE', 'EOH']);
  });

  it('dentro de su ciudad, MDE se llama Medellín y no Rionegro', () => {
    const [, mde] = groupByCity(searchAirports('medellin', 8), 'medellin');
    expect(mde?.kind).toBe('airport');
    if (mde?.kind !== 'airport') return;
    expect(mde.airport.city).toBe('Medellín');
    expect(mde.airport.name).toContain('José María Córdova');
    expect(mde.nested).toBe(true);
  });
});

describe('las ciudades con varios aeropuertos se agrupan', () => {
  it.each([
    ['sao paulo', ['city:SAO', 'GRU', 'CGH', 'VCP']],
    ['buenos aires', ['city:BUE', 'EZE', 'AEP']],
    ['nueva york', ['city:NYC', 'JFK', 'EWR', 'LGA']],
    ['new york', ['city:NYC', 'JFK', 'EWR', 'LGA']],
    ['rio de janeiro', ['city:RIO', 'GIG', 'SDU']],
    ['londres', ['city:LON', 'LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN']],
  ])('«%s»', (query, expected) => {
    expect(search(query).slice(0, expected.length)).toEqual(expected);
  });

  it('el código de ciudad también la encuentra: SAO, BUE, NYC', () => {
    expect(search('SAO')[0]).toBe('city:SAO');
    expect(search('bue')[0]).toBe('city:BUE');
    expect(search('nyc')[0]).toBe('city:NYC');
  });

  it('buscar un aeropuerto de la ciudad muestra la ciudad entera alrededor', () => {
    expect(search('GRU').slice(0, 4)).toEqual(['city:SAO', 'GRU', 'CGH', 'VCP']);
  });

  it('cada ciudad aparece una sola vez', () => {
    const r = search('sao');
    expect(r.filter((c) => c === 'city:SAO')).toHaveLength(1);
    expect(new Set(r).size).toBe(r.length);
  });
});

describe('ciudades de un solo aeropuerto', () => {
  it('Bogotá y Lima no llevan fila de ciudad: no hay nada que elegir', () => {
    expect(search('bogota')[0]).toBe('BOG');
    expect(search('lima')[0]).toBe('LIM');
    expect(search('lima')).not.toContain('city:LIM');
  });

  it('se encuentran por el municipio donde está la pista', () => {
    expect(search('palmira')[0]).toBe('CLO');
    expect(search('callao')[0]).toBe('LIM');
  });
});

describe('lo que no tiene que cambiar', () => {
  it('dos letras siguen dando Bogotá primero, sin ciudades metidas por nombre', () => {
    expect(search('bo')[0]).toBe('BOG');
  });

  it('«rio» es Río de Janeiro, no Rionegro', () => {
    expect(search('rio')).not.toContain('city:MDE');
    expect(search('rio')).toContain('city:RIO');
  });

  it('no se parte una ciudad a la mitad por el tope de filas', () => {
    const r = rows(groupByCity(searchAirports('londres', 8), 'londres', 2));
    expect(r).toEqual(['city:LON', 'LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN']);
  });

  it('las filas tienen clave única aunque MDE sea ciudad y aeropuerto', () => {
    const options = groupByCity(searchAirports('medellin', 8), 'medellin');
    const keys = options.map(optionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 2)).toEqual(['city-MDE', 'airport-MDE']);
  });
});

describe('texto del campo y del lector de pantalla', () => {
  const [ciudad, aeropuerto] = groupByCity(searchAirports('medellin', 8), 'medellin');

  it('la ciudad entera se distingue del aeropuerto en el campo', () => {
    if (!ciudad || !aeropuerto) throw new Error('sin resultados');
    expect(optionLabel(ciudad)).toBe('Medellín (MDE · todos)');
    expect(optionLabel(aeropuerto)).toBe('Medellín (MDE)');
    expect(optionCode(ciudad)).toBe('MDE');
  });

  it('el remonte (intercambiar) recupera el mismo texto', () => {
    expect(labelForCode('MDE', 'city')).toBe('Medellín (MDE · todos)');
    expect(labelForCode('MDE', 'airport')).toBe('Medellín (MDE)');
    expect(labelForCode('SAO', 'city')).toBe('São Paulo (SAO · todos)');
    expect(labelForCode('GRU', 'airport')).toBe('São Paulo (GRU)');
    expect(labelForCode('', undefined)).toBe('');
  });

  it('el lector de pantalla oye qué aeropuertos incluye la ciudad', () => {
    if (!ciudad) throw new Error('sin resultados');
    expect(describeOption(ciudad)).toBe(
      'Medellín, Colombia — todos los aeropuertos (MDE: MDE, EOH)',
    );
  });

  it('recientes distingue la ciudad del aeropuerto', () => {
    expect(rows(optionsFromCodes(['city:MDE', 'MDE', 'city:XXX', 'ZZZ']))).toEqual([
      'city:MDE',
      'MDE',
    ]);
  });
});

describe('la tabla de ciudades', () => {
  it('ningún aeropuerto pertenece a dos ciudades y ningún código se repite', () => {
    const airports = CITY_AREAS.flatMap((a) => a.airports.map((x) => x.code));
    expect(new Set(airports).size).toBe(airports.length);
    const codes = CITY_AREAS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('una ciudad de un solo aeropuerto tiene el código del aeropuerto y algún alias', () => {
    for (const area of CITY_AREAS.filter((a) => a.airports.length === 1)) {
      expect(area.airports[0]?.code).toBe(area.code);
      expect(area.aliases.length).toBeGreaterThan(0);
    }
  });
});
