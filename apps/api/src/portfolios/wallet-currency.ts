/**
 * Las monedas en que puede operar una cartera (ISO 4217) y el exponente de cada una.
 *
 * El saldo, el cupo y los movimientos de una cartera van en unidades MENORES de su moneda: un
 * monto de 150000 en COP (exponente 2) son 1.500,00 pesos, y en CLP (exponente 0) serían 150.000.
 * Las vistas llevan el exponente para que nadie tenga que suponerlo al mostrar o al cargar un monto.
 *
 * Sólo se habilitan carteras en monedas de exponente {@link MONEY_EXPONENT}: las reservas llegan en
 * `Money` de `@sales-travel/canonical`, que asume centavos (`fromMajor` multiplica por 100), y una
 * retención en CLP o en KWD compararía cifras con un factor de 100 o de 10 de diferencia. Cuando el
 * modelo de dinero lleve el exponente, esta guarda se levanta aquí y en ningún otro lado.
 *
 * Es la lista de monedas en circulación de ISO 4217 (sin fondos como COU o CLF, ni metales, ni
 * códigos de prueba), con su columna "minor unit". Una moneda retirada no se puede habilitar; una
 * cartera que ya exista en ella se sigue mostrando, con exponente `null`.
 */

/** Exponente que asume `Money`: unidades menores = centésimos. */
export const MONEY_EXPONENT = 2;

const EXPONENT_0 = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF';
const EXPONENT_3 = 'BHD IQD JOD KWD LYD OMR TND';
const EXPONENT_2 = [
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BRL BSD BTN BWP BYN BZD',
  'CAD CDF CHF CNY COP CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS',
  'GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP',
  'LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK',
  'NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS',
  'SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD UYU UZS VED VES WST',
  'XCD XCG YER ZAR ZMW ZWG',
].join(' ');

function table(): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [codes, exponent] of [
    [EXPONENT_0, 0],
    [EXPONENT_2, 2],
    [EXPONENT_3, 3],
  ] as const) {
    for (const code of codes.split(' ')) out.set(code, exponent);
  }
  return out;
}

const ISO_4217 = table();

/** El exponente ISO 4217 de una moneda en circulación, o `undefined` si el código no lo es. */
export function currencyExponent(code: string): number | undefined {
  return ISO_4217.get(code);
}

export function isIsoCurrency(code: string): boolean {
  return ISO_4217.has(code);
}

/** ¿Se puede habilitar una cartera en esta moneda? Ver la nota del módulo. */
export function isWalletCurrency(code: string): boolean {
  return currencyExponent(code) === MONEY_EXPONENT;
}

/**
 * Las monedas que se pueden habilitar, con la del nodo y el dólar primero (son las que se piden
 * casi siempre) y el resto por orden alfabético.
 */
export function walletCurrencies(preferred: readonly string[] = []): string[] {
  const all = [...ISO_4217.keys()].filter(isWalletCurrency).sort();
  const first = [...new Set(preferred)].filter(isWalletCurrency);
  return [...first, ...all.filter((code) => !first.includes(code))];
}
