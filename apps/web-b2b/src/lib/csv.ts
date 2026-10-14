/**
 * Los CSV que arma el panel en el navegador (el reporte de ventas de Reportes). Sin I/O.
 *
 * Son las MISMAS reglas que los CSV de la consola de la plataforma
 * (apps/api/src/admin-console/csv.ts): web-b2b no depende del API, así que es una copia, y csv.test.ts
 * compara las expresiones de las dos para que no se separen.
 *
 * Lo abre una persona en Excel o en Google Sheets, así que:
 *
 *   - va en UTF-8 con BOM (sin él, Excel lee "Bogotá" como "BogotÃ¡") y líneas CRLF (RFC 4180);
 *   - una celda con coma, punto y coma, tabulación, comillas o salto de línea va entre comillas, con
 *     las comillas duplicadas. El `;` y la tabulación también: Excel con la configuración regional
 *     de Colombia, Perú o Brasil separa por `;`, y sin comillas lo que sigue sería otra celda que
 *     empieza con `=` sin su apóstrofo;
 *   - una celda que empieza con `=`, `+`, `-` o `@` (o con tabulación o retorno de carro, que algunas
 *     planillas saltan antes de mirar) lleva un apóstrofo delante: el nombre de un vendedor no puede
 *     ser una fórmula que la planilla ejecute al abrir el archivo (CSV injection);
 *   - un importe va con punto decimal y sin apóstrofo aunque sea negativo ({@link csvDecimal}): lo
 *     arma este módulo desde unidades enteras, no es un texto que venga de afuera.
 *
 * Los saltos de línea dentro de una celda se conservan entre comillas; los demás caracteres de
 * control se quitan: no aportan nada en una planilla y algunos la rompen.
 */

/** Un importe ya escrito por {@link csvDecimal}: `1500.00`, `-0.05`. */
export interface CsvDecimal {
  readonly decimal: string;
}

export type CsvValue = string | number | boolean | CsvDecimal | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",;\t\r\n]/;
// Los de control salvo tabulación, salto de línea y retorno de carro.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const INTEGER_TEXT = /^-?\d{1,30}$/;

/** Una celda lista para el archivo. `null` y `undefined` son una celda vacía. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  // Un número propio (un conteo) no es una fórmula aunque sea negativo: va tal cual.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Un importe sólo pasa si es un número decimal: cualquier otra cosa sería un texto sin su guarda.
  if (typeof value === 'object') return DECIMAL.test(value.decimal) ? value.decimal : '';
  const clean = value.replace(CONTROL, '');
  const safe = FORMULA_START.test(clean) ? `'${clean}` : clean;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * `minor` unidades menores con `exponent` decimales, con punto: (150000, 2) → `1500.00`;
 * (-5, 2) → `-0.05`; (150000, 0) → `150000`. Exacto (BigInt, nunca coma flotante). `null` si no es
 * un entero (o un texto de dígitos) o el exponente no es de 0 a 6.
 */
export function minorToDecimal(minor: number | bigint | string, exponent: number): string | null {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) return null;
  let units: bigint;
  if (typeof minor === 'bigint') {
    units = minor;
  } else if (typeof minor === 'number') {
    if (!Number.isFinite(minor)) return null;
    units = BigInt(Math.round(minor));
  } else {
    const text = minor.trim();
    if (!INTEGER_TEXT.test(text)) return null;
    units = BigInt(text);
  }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(exponent + 1, '0');
  const cut = digits.length - exponent;
  const text = exponent === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${text}` : text;
}

/** La celda de un importe (ver {@link minorToDecimal}); vacía si no se puede escribir. */
export function csvDecimal(minor: number | bigint | string, exponent: number): CsvDecimal | null {
  const decimal = minorToDecimal(minor, exponent);
  return decimal === null ? null : { decimal };
}

/** Una línea, sin el fin de línea. */
export function csvLine(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(',');
}

const BOM = '\uFEFF';
const EOL = '\r\n';

/** El archivo entero: BOM, encabezado y filas, cada línea con CRLF (también la última). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return `${BOM}${[header, ...rows].map(csvLine).join(EOL)}${EOL}`;
}
