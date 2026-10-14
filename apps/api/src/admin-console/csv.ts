/**
 * Los CSV que exporta la consola de la plataforma (la Actividad, ADM-8; las reservas de la red,
 * ADM-14). Sin I/O.
 *
 * Lo abre una persona en Excel o en Google Sheets, así que:
 *
 *   - va en UTF-8 con BOM (sin él, Excel lee "Bogotá" como "BogotÃ¡") y líneas CRLF (RFC 4180);
 *   - una celda con coma, punto y coma, tabulación, comillas o salto de línea va entre comillas, con
 *     las comillas duplicadas. El `;` y la tabulación también: Excel con la configuración regional
 *     de Colombia, Perú o Brasil separa por `;`, y sin comillas lo que sigue sería otra celda que
 *     empieza con `=` sin su apóstrofo;
 *   - una celda que empieza con `=`, `+`, `-` o `@` (o con tabulación o retorno de carro, que algunas
 *     planillas saltan antes de mirar) lleva un apóstrofo delante: el nombre de un nodo o un correo
 *     no pueden ser una fórmula que la planilla ejecute al abrir el archivo (CSV injection). Es la
 *     misma regla que el reporte de ventas del panel (lib/sales-reports.ts).
 *
 * Los saltos de línea dentro de una celda se conservan entre comillas; los demás caracteres de
 * control se quitan: no aportan nada en una planilla y algunos la rompen.
 */

export type CsvValue = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",;\t\r\n]/;
// Los de control salvo tabulación, salto de línea y retorno de carro.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Una celda lista para el archivo. `null` y `undefined` son una celda vacía. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  // Un número propio (un conteo) no es una fórmula aunque sea negativo: va tal cual.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const clean = value.replace(CONTROL, '');
  const safe = FORMULA_START.test(clean) ? `'${clean}` : clean;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
