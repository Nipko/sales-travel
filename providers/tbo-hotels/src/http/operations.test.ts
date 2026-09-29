import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  TBO_OPERATIONS,
  TBO_SEARCH_TIMEOUT_CEILING_MS,
  isTboMoneyPath,
  tboSearchTimeoutMs,
  type TboOperationName,
} from './operations';

const NAMES = Object.keys(TBO_OPERATIONS) as TboOperationName[];

describe('TBO_OPERATIONS: la tabla de 01 §3.1 y 08 RNF-01', () => {
  it('tiene las 11 operaciones del contrato V2.1', () => {
    expect(NAMES).toHaveLength(11);
  });

  // Casing del PDF, fila por fila (01 §3.1, última columna). La sonda PR-04 puede cambiarlo; el
  // cambio tiene que pasar por aquí a la vista.
  it.each<[TboOperationName, string, 'GET' | 'POST']>([
    ['search', '/Search', 'POST'],
    ['prebook', '/PreBook', 'POST'],
    ['book', '/Book', 'POST'],
    ['bookingDetail', '/BookingDetail', 'POST'],
    ['cancel', '/Cancel', 'POST'],
    ['bookingDetailsByDate', '/BookingDetailsbasedondate', 'POST'],
    ['countryList', '/CountryList', 'GET'],
    ['cityList', '/CityList', 'POST'],
    ['hotelCodeList', '/hotelcodelist', 'GET'],
    ['tboHotelCodeList', '/TBOHotelCodeList', 'POST'],
    ['hotelDetails', '/HotelDetails', 'POST'],
  ])('%s → %s %s', (name, path, method) => {
    expect(TBO_OPERATIONS[name].path).toBe(path);
    expect(TBO_OPERATIONS[name].method).toBe(method);
  });

  // RNF-01: timeout e intentos máximos.
  it.each<[TboOperationName, number, number]>([
    ['search', 13_000, 2],
    ['prebook', 23_000, 2],
    ['book', 120_000, 1],
    ['bookingDetail', 30_000, 3],
    ['cancel', 60_000, 1],
    ['bookingDetailsByDate', 60_000, 3],
    ['countryList', 30_000, 5],
    ['cityList', 30_000, 5],
    ['tboHotelCodeList', 60_000, 5],
    ['hotelDetails', 60_000, 5],
    ['hotelCodeList', 180_000, 3],
  ])('%s: %i ms y %i intentos', (name, timeoutMs, maxAttempts) => {
    expect(TBO_OPERATIONS[name].timeoutMs).toBe(timeoutMs);
    expect(TBO_OPERATIONS[name].maxAttempts).toBe(maxAttempts);
  });

  it('Book y Cancel son las únicas de dinero, con un solo intento y en el cupo de dinero', () => {
    const money = NAMES.filter((name) => TBO_OPERATIONS[name].money);
    expect(money.sort()).toEqual(['book', 'cancel']);
    for (const name of money) {
      expect(TBO_OPERATIONS[name].maxAttempts).toBe(1);
      expect(TBO_OPERATIONS[name].lanes).toEqual(['money']);
    }
  });

  it('la configuración sólo puede acortar: el techo es el timeout salvo en Search', () => {
    for (const name of NAMES) {
      const spec = TBO_OPERATIONS[name];
      if (name === 'search') continue;
      expect(spec.maxTimeoutMs, name).toBe(spec.timeoutMs);
    }
    expect(TBO_OPERATIONS.search.maxTimeoutMs).toBe(TBO_SEARCH_TIMEOUT_CEILING_MS);
  });

  it('sólo Search y PreBook comparten plazo entre intentos (esperas del vendedor)', () => {
    expect(NAMES.filter((name) => TBO_OPERATIONS[name].sharedDeadline).sort()).toEqual([
      'prebook',
      'search',
    ]);
  });

  it('sólo hotelcodelist tiene el envelope opcional (p. 55; Q-61)', () => {
    expect(NAMES.filter((name) => TBO_OPERATIONS[name].envelope === 'optional')).toEqual([
      'hotelCodeList',
    ]);
  });

  it('sólo Search trata el 201 como resultado vacío (01 §8.3)', () => {
    expect(NAMES.filter((name) => TBO_OPERATIONS[name].emptyOnNoAvailability)).toEqual(['search']);
  });

  it('sólo TBOHotelCodeList trata el 500 "No Hotels Found" como resultado vacío (01 §8.5)', () => {
    // Es la única operación donde se observó (producción, 2026-09-29). CityList y HotelDetails no:
    // sin evidencia, un 500 suyo sigue siendo UPSTREAM.
    expect(NAMES.filter((name) => TBO_OPERATIONS[name].emptyOnNoHotelsFound)).toEqual([
      'tboHotelCodeList',
    ]);
  });

  it('Status.Description no se loguea donde el request lleva datos personales (01 §11.1)', () => {
    expect(NAMES.filter((name) => !TBO_OPERATIONS[name].logDescription).sort()).toEqual([
      'book',
      'bookingDetail',
      'bookingDetailsByDate',
      'cancel',
    ]);
  });

  it('la recuperación tras un Book incierto puede pedir el cupo de dinero o el de verificación', () => {
    expect(TBO_OPERATIONS.bookingDetail.lanes).toContain('money');
    expect(TBO_OPERATIONS.bookingDetail.lanes).toContain('verification');
    expect(TBO_OPERATIONS.bookingDetail.lanes[0]).toBe('background');
  });

  it('sólo BookingDetail admite el cupo de verificación', () => {
    for (const name of NAMES) {
      if (name === 'bookingDetail') continue;
      expect(TBO_OPERATIONS[name].lanes, name).not.toContain('verification');
    }
  });

  it('está congelada, filas y cupos incluidos', () => {
    expect(Object.isFrozen(TBO_OPERATIONS)).toBe(true);
    for (const name of NAMES) {
      expect(Object.isFrozen(TBO_OPERATIONS[name]), name).toBe(true);
      expect(Object.isFrozen(TBO_OPERATIONS[name].lanes), name).toBe(true);
    }
  });
});

describe('tboSearchTimeoutMs (08 §9 C-01)', () => {
  it.each([
    [10, 13_000],
    [5, 8_000],
    [20, 23_000],
    [23, 23_000],
    [1, 8_000],
    [Number.NaN, 13_000],
    [12.4, 15_000],
  ])('ResponseTime %s s → %i ms', (responseTime, expected) => {
    expect(tboSearchTimeoutMs(responseTime)).toBe(expected);
  });

  it('el timeout por defecto de la tabla es el de ResponseTime 10', () => {
    expect(TBO_OPERATIONS.search.timeoutMs).toBe(tboSearchTimeoutMs(10));
  });
});

describe('isTboMoneyPath (01 §10.2: sin distinguir mayúsculas)', () => {
  it.each(['/Book', '/book', '/BOOK', '/Book/', '/Cancel', '/cancel?x=1', '/x/Cancel#y', 'Book'])(
    '%s es de dinero',
    (path) => {
      expect(isTboMoneyPath(path)).toBe(true);
    },
  );

  it.each([
    '/BookingDetail',
    '/BookingDetailsbasedondate',
    '/PreBook',
    '/Search',
    '/HotelBook',
    '',
  ])('%s no lo es', (path) => {
    expect(isTboMoneyPath(path)).toBe(false);
  });
});

/**
 * 08 RF-02 CA-5: ningún literal de path de TBO fuera de `TBO_OPERATIONS`. Se leen los literales con
 * el parser de TypeScript y no con una regex sobre el texto, porque los comentarios citan los paths
 * (`/Cancel`, `/Book`) y un comentario no llega al cable.
 */
describe('ningún literal de path de TBO fuera de operations.ts', () => {
  const srcRoot = dirname(__dirname);
  const paths = NAMES.map((name) => TBO_OPERATIONS[name].path.slice(1).toLowerCase());
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])/(?:${paths.join('|')})(?![A-Za-z0-9_])`, 'i');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return entry === '__fixtures__' ? [] : sourceFiles(full);
      return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
    });
  }

  /**
   * Los literales de un archivo, salvo los especificadores de `import`/`export … from`: `'./search/…'`
   * o `'./cancel/…'` nombran carpetas del paquete (06 §4.2) y no llegan al cable.
   */
  function literalsIn(fileName: string, text: string): string[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        found.push(node.text);
      if (ts.isTemplateExpression(node)) {
        found.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  function literalsOf(file: string): string[] {
    return literalsIn(file, readFileSync(file, 'utf8'));
  }

  it('el detector ve un literal y no ve un comentario ni un import (si no, el test sería vacuo)', () => {
    const probe = [
      "import { buildTboSearchRequest } from './search/search.request.builder';",
      "export { mapTboCancel } from './cancel/response.mapper';",
      '// llama a `/Search`',
      'const url = `${base}/search`;',
      "const other = '/BookingDetail';",
    ].join('\n');
    expect(literalsIn('probe.ts', probe).filter((text) => pattern.test(text))).toEqual([
      '/search',
      '/BookingDetail',
    ]);
  });

  it('sólo operations.ts escribe paths de TBO', () => {
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files
      .filter((file) => !file.endsWith(join('http', 'operations.ts')))
      .flatMap((file) =>
        literalsOf(file)
          .filter((text) => pattern.test(text))
          .map((text) => `${relative(srcRoot, file)}: ${JSON.stringify(text)}`),
      );
    expect(offenders).toEqual([]);
  });
});
