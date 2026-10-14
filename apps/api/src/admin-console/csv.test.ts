import { describe, expect, it } from 'vitest';
import { csvCell, csvDecimal, csvLine, minorToDecimal, toCsv } from './csv.js';

describe('csvCell', () => {
  it('el texto común va tal cual', () => {
    expect(csvCell('Andes Travel')).toBe('Andes Travel');
    expect(csvCell('auth.login.failed')).toBe('auth.login.failed');
    expect(csvCell('ana@agencia.com')).toBe('ana@agencia.com');
  });

  it('coma, comillas o salto de línea: entre comillas, con las comillas duplicadas', () => {
    expect(csvCell('Viajes, S.A.')).toBe('"Viajes, S.A."');
    expect(csvCell('El "Mejor"')).toBe('"El ""Mejor"""');
    expect(csvCell('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
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
    expect(csvCell('Agencia;=HYPERLINK("http://x")')).toBe('"Agencia;=HYPERLINK(""http://x"")"');
    expect(csvCell('a\t=1+1')).toBe('"a\t=1+1"');
  });

  it('el apóstrofo va antes de mirar si hacen falta comillas', () => {
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
    expect(csvCell('=A1')).toBe("'=A1");
  });

  it('los demás caracteres de control se quitan', () => {
    expect(csvCell('a\u0000b\u0007c\u001bd')).toBe('abcd');
    // Quitarlos no deja una fórmula sin su apóstrofo.
    expect(csvCell('\u0000=1')).toBe("'=1");
  });

  it('vacíos, números y booleanos', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
    expect(csvCell(5000)).toBe('5000');
    // Un número propio no es una fórmula: un conteo negativo va sin apóstrofo.
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(true)).toBe('true');
  });
});

describe('minorToDecimal y csvDecimal', () => {
  it('unidades menores con su exponente, exacto y con punto', () => {
    expect(minorToDecimal(150_000, 2)).toBe('1500.00');
    expect(minorToDecimal('45990', 2)).toBe('459.90');
    expect(minorToDecimal(5, 2)).toBe('0.05');
    expect(minorToDecimal(0, 2)).toBe('0.00');
    expect(minorToDecimal(-5, 2)).toBe('-0.05');
    expect(minorToDecimal(150_000, 0)).toBe('150000');
    expect(minorToDecimal(1_234_567, 3)).toBe('1234.567');
    // Más allá de lo que un double guarda exacto: BIGINT llega de `pg` como texto.
    expect(minorToDecimal('90071992547409931', 2)).toBe('900719925474099.31');
    expect(minorToDecimal(12n, 2)).toBe('0.12');
  });

  it('lo que no es un entero o un exponente raro no se escribe', () => {
    expect(minorToDecimal('12.5', 2)).toBeNull();
    expect(minorToDecimal('=1+1', 2)).toBeNull();
    expect(minorToDecimal(Number.NaN, 2)).toBeNull();
    expect(minorToDecimal(10, -1)).toBeNull();
    expect(minorToDecimal(10, 1.5)).toBeNull();
    expect(minorToDecimal(10, 7)).toBeNull();
    expect(csvDecimal('x', 2)).toBeNull();
  });

  it('la celda del importe va tal cual, sin apóstrofo aunque sea negativo', () => {
    expect(csvCell(csvDecimal(150_000, 2))).toBe('1500.00');
    expect(csvCell(csvDecimal(-5, 2))).toBe('-0.05');
    // Un texto con forma de número negativo sí lleva apóstrofo: no lo armó csvDecimal.
    expect(csvCell('-0.05')).toBe("'-0.05");
    // Un objeto que no trae un decimal no pasa como texto sin guarda.
    expect(csvCell({ decimal: '=1+1' })).toBe('');
    expect(csvCell(csvDecimal('no', 2))).toBe('');
  });
});

describe('toCsv', () => {
  it('BOM, encabezado y filas con CRLF, también al final', () => {
    const csv = toCsv(
      ['fecha', 'nodo'],
      [
        ['2026-10-13', 'Andes, Sur'],
        ['2026-10-12', null],
      ],
    );
    expect(csv).toBe('\uFEFFfecha,nodo\r\n2026-10-13,"Andes, Sur"\r\n2026-10-12,\r\n');
  });

  it('sin filas, sólo el encabezado', () => {
    expect(toCsv(['a', 'b'], [])).toBe('\uFEFFa,b\r\n');
    expect(csvLine(['x', 1, null])).toBe('x,1,');
  });
});
