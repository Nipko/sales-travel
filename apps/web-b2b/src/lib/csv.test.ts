import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { csvCell, csvDecimal, csvLine, minorToDecimal, toCsv } from './csv';

/*
 * Las reglas de los CSV del panel. Son las de la consola de la plataforma
 * (apps/api/src/admin-console/csv.ts): el último caso compara el código de los dos archivos, leído
 * como texto (web-b2b no depende del API), para que una guarda que se arregla en un lado no quede
 * vieja en el otro.
 */

describe('csvCell', () => {
  it('el texto común va tal cual', () => {
    expect(csvCell('Ana Ruiz')).toBe('Ana Ruiz');
    expect(csvCell('ana@agencia.com')).toBe('ana@agencia.com');
  });

  it('coma, comillas o salto de línea: entre comillas, con las comillas duplicadas', () => {
    expect(csvCell('Ruiz, Ana')).toBe('"Ruiz, Ana"');
    expect(csvCell('El "Mejor"')).toBe('"El ""Mejor"""');
    expect(csvCell('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
  });

  it.each(['=HYPERLINK("http://x")', '+57 300', '-1+1', '@SUM(A1)', '\tcmd', '\r=1'])(
    '%j no puede ser una fórmula: apóstrofo delante',
    (value) => {
      const cell = csvCell(value);
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(value);
    },
  );

  it('punto y coma o tabulación: entre comillas, así ninguna planilla parte la celda', () => {
    // Excel en es-CO, es-PE o pt-BR separa por `;`: sin comillas, lo que sigue al `;` sería otra
    // celda, que empieza con `=` sin apóstrofo.
    expect(csvCell('Ana;=HYPERLINK("http://x")')).toBe('"Ana;=HYPERLINK(""http://x"")"');
    expect(csvCell('a\t=1+1')).toBe('"a\t=1+1"');
    expect(csvCell('Ana;=1+1')).toBe('"Ana;=1+1"');
  });

  it('los demás caracteres de control se quitan, sin dejar una fórmula sin su apóstrofo', () => {
    expect(csvCell('a\u0000b\u0007c\u001bd')).toBe('abcd');
    expect(csvCell('\u0000=1')).toBe("'=1");
  });

  it('vacíos, números, booleanos e importes', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(csvDecimal(-5, 2))).toBe('-0.05');
    // Un texto con forma de número negativo sí lleva apóstrofo: no lo armó csvDecimal.
    expect(csvCell('-0.05')).toBe("'-0.05");
    expect(csvCell({ decimal: '=1+1' })).toBe('');
  });
});

describe('minorToDecimal', () => {
  it('unidades menores con su exponente, exacto y con punto', () => {
    expect(minorToDecimal(150_000, 2)).toBe('1500.00');
    expect(minorToDecimal(1, 2)).toBe('0.01');
    expect(minorToDecimal(-5, 2)).toBe('-0.05');
    expect(minorToDecimal(150_000, 0)).toBe('150000');
    expect(minorToDecimal('90071992547409931', 2)).toBe('900719925474099.31');
    expect(minorToDecimal('12.5', 2)).toBeNull();
    expect(minorToDecimal(10, 7)).toBeNull();
  });
});

describe('toCsv', () => {
  it('BOM, encabezado y filas con CRLF, también al final', () => {
    expect(toCsv(['a', 'b'], [['x', 1]])).toBe('\uFEFFa,b\r\nx,1\r\n');
    expect(toCsv(['a'], [])).toBe('\uFEFFa\r\n');
    expect(csvLine(['x', null, csvDecimal(1, 2)])).toBe('x,,0.01');
  });
});

/** El código de un archivo de CSV sin comentarios ni espacios: lo que hace, no cómo se explica. */
function codeOf(source: string): string {
  const body = source.slice(source.indexOf('export interface CsvDecimal'));
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('las mismas reglas que la consola de la plataforma', () => {
  it('el código es el de apps/api/src/admin-console/csv.ts', () => {
    const read = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const api = codeOf(read('../../../api/src/admin-console/csv.ts'));
    const web = codeOf(read('./csv.ts'));
    // Si la lectura se rompe, el test tiene que fallar y no comparar dos vacíos.
    expect(api).toContain('const FORMULA_START = /^[=+\\-@\\t\\r]/;');
    expect(api).toContain('const NEEDS_QUOTES = /[",;\\t\\r\\n]/;');
    expect(web).toBe(api);
  });
});
