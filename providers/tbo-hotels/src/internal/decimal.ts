/**
 * Importes de TBO a unidades menores sin aritmética en coma flotante (docs/tbo/02 §8.3, D02-5 A).
 *
 * `Money.fromMajor` hace `Math.round(x * 100)` sobre un float binario: redondea sin política
 * declarada, asume siempre dos decimales y lanza un `Error` plano ante un negativo
 * (`packages/canonical/src/money.ts`). TBO manda importes como número o como string, con hasta 8
 * decimales en `BasePrice` (p. 24) y 3 en otros campos (p. 26-27). Aquí el importe se lee como
 * texto decimal y se escala moviendo dígitos, con redondeo half-up y aviso de pérdida de precisión.
 */

/**
 * Exponentes ISO 4217 distintos de 2. Todo código bien formado que no esté aquí ni en
 * {@link NO_MINOR_UNIT} tiene exponente 2, que es la regla de la tabla ISO; por eso esta lista es
 * la de excepciones y no la de las ~180 monedas.
 */
const NON_TWO_EXPONENTS: ReadonlyMap<string, number> = new Map([
  ['BIF', 0],
  ['CLP', 0],
  ['DJF', 0],
  ['GNF', 0],
  ['ISK', 0],
  ['JPY', 0],
  ['KMF', 0],
  ['KRW', 0],
  ['PYG', 0],
  ['RWF', 0],
  ['UGX', 0],
  ['UYI', 0],
  ['VND', 0],
  ['VUV', 0],
  ['XAF', 0],
  ['XOF', 0],
  ['XPF', 0],
  ['BHD', 3],
  ['IQD', 3],
  ['JOD', 3],
  ['KWD', 3],
  ['LYD', 3],
  ['OMR', 3],
  ['TND', 3],
  ['CLF', 4],
  ['UYW', 4],
]);

/** Códigos ISO 4217 sin unidad menor ("N.A."): metales, unidades de cuenta y códigos de prueba. */
const NO_MINOR_UNIT: ReadonlySet<string> = new Set([
  'XAG',
  'XAU',
  'XBA',
  'XBB',
  'XBC',
  'XBD',
  'XDR',
  'XPD',
  'XPT',
  'XSU',
  'XTS',
  'XUA',
  'XXX',
]);

/**
 * El único exponente que el canónico sabe representar mientras `Money` asuma dos decimales.
 * Generalizarlo toca todas las verticales y queda fuera de TBO (docs/tbo/02 §8.3 punto 3).
 */
export const SUPPORTED_MINOR_UNIT_EXPONENT = 2;

/** Exponente ISO 4217, o `undefined` si el código está mal formado o no tiene unidad menor. */
export function minorUnitExponent(currency: string): number | undefined {
  if (!/^[A-Z]{3}$/.test(currency) || NO_MINOR_UNIT.has(currency)) return undefined;
  return NON_TWO_EXPONENTS.get(currency) ?? 2;
}

/**
 * La guarda de exponente: una cuenta TBO cuyo perfil cotiza en `CLP` o `KWD` produciría importes
 * errados por un factor de 100 o de 10 sin que nadie lo note. Con esa moneda el ACL no convierte y
 * TBO queda no disponible para la cuenta, con motivo visible.
 */
export function isSupportedCurrency(currency: string): boolean {
  return minorUnitExponent(currency) === SUPPORTED_MINOR_UNIT_EXPONENT;
}

export type AmountRejection =
  | 'NOT_A_DECIMAL'
  | 'NEGATIVE'
  | 'OUT_OF_RANGE'
  | 'UNSUPPORTED_CURRENCY';

/**
 * Resultado y no excepción: un importe malo invalida ESE pack, que se descarta y se mide; no tumba
 * la respuesta entera (docs/tbo/02 §8.3 punto 4).
 */
export type MinorUnits =
  | { readonly ok: true; readonly amountMinor: number; readonly precisionLoss: boolean }
  | { readonly ok: false; readonly reason: AmountRejection };

/**
 * Signo opcional, dígitos, fracción opcional con al menos un dígito y exponente opcional. El
 * exponente hace falta porque `String(1.5e-7)` es `"1.5e-7"`. Sin separador de miles ni espacios:
 * con dinero la tolerancia se paga en importes equivocados (RNF-12).
 */
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** `Number.MAX_SAFE_INTEGER` tiene 16 dígitos: un entero de más dígitos ya no es seguro. */
const MAX_SAFE_DIGITS = 16;

function rejected(reason: AmountRejection): MinorUnits {
  return { ok: false, reason };
}

function safeMinor(minor: bigint, precisionLoss: boolean): MinorUnits {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return rejected('OUT_OF_RANGE');
  return { ok: true, amountMinor: Number(minor), precisionLoss };
}

/**
 * Un número pasa por su representación decimal más corta (`String(n)`, la de ida y vuelta de JS):
 * así `17.22` y `"17.22"` dan exactamente el mismo importe (08 RF-07 CA-3).
 */
function decimalText(amount: unknown): string | undefined {
  if (typeof amount === 'number') return Number.isFinite(amount) ? String(amount) : undefined;
  if (typeof amount === 'string') return amount;
  return undefined;
}

/**
 * Convierte un decimal a unidades menores de `exponent` decimales, con redondeo half-up.
 *
 * Mueve dígitos en vez de multiplicar: el valor es `dígitos × 10^(exp − decimales)` y las unidades
 * menores son ese valor por `10^exponent`. `precisionLoss` avisa cuando se descartó algún dígito
 * distinto de cero, que es lo esperable en `BasePrice` y un aviso en cualquier total.
 */
export function decimalToMinor(amount: unknown, exponent: number): MinorUnits {
  const text = decimalText(amount);
  const match = text === undefined ? null : DECIMAL.exec(text);
  if (match === null) return rejected('NOT_A_DECIMAL');

  const [, sign, intPart = '', fracPart = '', expPart = '0'] = match;
  const exp10 = Number(expPart);
  if (!Number.isSafeInteger(exp10)) return rejected('OUT_OF_RANGE');

  const digits = `${intPart}${fracPart}`.replace(/^0+/, '');
  if (digits.length === 0) return { ok: true, amountMinor: 0, precisionLoss: false };
  if (sign === '-') return rejected('NEGATIVE');

  const shift = exp10 - fracPart.length + exponent;
  if (shift >= 0) {
    if (digits.length + shift > MAX_SAFE_DIGITS) return rejected('OUT_OF_RANGE');
    return safeMinor(BigInt(digits) * 10n ** BigInt(shift), false);
  }

  const drop = -shift;
  if (drop >= digits.length) {
    // Todo el valor queda por debajo de una unidad menor. Sube a 1 sólo si llega a media unidad:
    // eso pasa cuando el primer dígito descartado es la cifra más alta y vale 5 o más.
    const roundsUp = drop === digits.length && (digits[0] ?? '0') >= '5';
    return { ok: true, amountMinor: roundsUp ? 1 : 0, precisionLoss: true };
  }

  const kept = digits.slice(0, digits.length - drop);
  const dropped = digits.slice(digits.length - drop);
  if (kept.length > MAX_SAFE_DIGITS) return rejected('OUT_OF_RANGE');
  const roundsUp = (dropped[0] ?? '0') >= '5';
  return safeMinor(BigInt(kept) + (roundsUp ? 1n : 0n), /[1-9]/.test(dropped));
}

/**
 * La puerta de importes del ACL: guarda de exponente y decimal exacto a dos decimales. Es la que
 * usan los mappers para todo `Money` que sale de una respuesta de TBO.
 */
export function toMinorUnits(amount: unknown, currency: string): MinorUnits {
  if (!isSupportedCurrency(currency)) return rejected('UNSUPPORTED_CURRENCY');
  return decimalToMinor(amount, SUPPORTED_MINOR_UNIT_EXPONENT);
}
