import { createHash } from 'node:crypto';
import type {
  HotelRateCondition,
  HotelRateConditionCategory,
  HotelRateSignal,
} from '@sales-travel/domain';
import { decodeTboHtmlEntities, tboHtmlToText } from '../static/html-sanitizer';

/**
 * `RateConditions` de PreBook → texto plano con categoría y señales críticas (docs/tbo/03 §2.4 y
 * §2.11; 08 RF-16 y RF-17).
 *
 * El contrato sólo dice "Hotel/Room norms associated with the bookable unit" (p. 23), y los
 * ejemplos traen HTML escapado como entidades (`&lt;ul&gt;&lt;li&gt;…`), prefijos con espacios
 * inconsistentes y un enlace externo (p. 25-26, 30-32). Por KP-3 (p. 71) estas normas son finales.
 *
 * **El HTML del proveedor nunca se renderiza.** Cada ítem se convierte a texto plano con el
 * algoritmo de 03 §2.4:
 *
 * 1. `null` o ausente es `[]`; cada ítem se procesa por separado y se conserva su original.
 * 2. Las entidades se decodifican UNA sola vez. Una segunda pasada convertiría
 *    `&amp;lt;script&amp;gt;` en marcado activo; con una sola queda el texto `&lt;script&gt;`.
 * 3. La estructura pasa a texto con el saneador de lista blanca del paquete (el mismo del contenido
 *    estático, RNF-16): `<li>` es una viñeta, `<br>`, `</p>` y `</ul>` son saltos, `script` y
 *    `style` se van con su contenido, el resto de las etiquetas sin él y ningún atributo sobrevive.
 * 4. Espacios colapsados, bordes recortados, NFC. No se parte por comas: rompería frases. Las URLs
 *    quedan como texto.
 * 5. Categoría heurística por prefijo y señales críticas como códigos cerrados. El texto completo
 *    se conserva siempre: la categoría es ayuda visual, no contrato.
 *
 * La detección de señales es heurística y puede fallar si TBO cambia la redacción o el idioma
 * (03 §2.11 punto 3): por eso cada texto que menciona "package" sin disparar la regla se cuenta.
 */

/** Las señales en el orden en que se informan. Vocabulario del puerto de dominio. */
export const TBO_RATE_SIGNALS = [
  'PACKAGE_WITH_FLIGHT_ONLY',
  'NO_NAME_CHANGE',
  'MARKET_RESTRICTION',
] as const satisfies readonly HotelRateSignal[];

/**
 * Prefijos de 03 §2.4 paso 7, en orden: "Minimum CheckIn Age" tiene que ganarle a "CheckIn". Los
 * ejemplos escriben `CheckIn` pegado, con espacios alrededor de los dos puntos y con un espacio
 * inicial (p. 26, 30-31); por eso se clasifica sobre el texto ya recortado.
 */
const CATEGORY_PREFIXES: readonly (readonly [HotelRateConditionCategory, RegExp])[] = [
  ['minCheckInAge', /^minimum\s+check[\s-]*in\s+age\b/i],
  ['checkIn', /^check[\s-]*in\b/i],
  ['checkOut', /^check[\s-]*out\b/i],
  ['mandatoryFees', /^mandatory\s+fees?\b/i],
  ['optionalFees', /^optional\s+fees?\b/i],
  ['cardsAccepted', /^cards?\s+accepted\b/i],
  ['specialInstructions', /^special\s+instructions?\b/i],
];

/**
 * "should be sold only with an airline ticket as part of a package" (p. 25, 30). Patrón
 * conservador de 03 §2.11: "sold only with" junto a un billete aéreo, o bien "as part of a
 * package". Preferimos bloquear de más: vender suelta una tarifa de paquete es el riesgo
 * contractual (R-32).
 */
const SOLD_ONLY_WITH = /\bsold\s+only\s+with\b/i;
const AIR_TICKET = /\b(?:airline|flight|air)\s+tickets?\b/i;
const PART_OF_A_PACKAGE = /\bas\s+part\s+of\s+a\s+package\b/i;
const PACKAGE_WORD = /\bpackages?\b/i;

/** "No Name change allowed any time of the year" (p. 51). */
const NO_NAME_CHANGE = [
  /\bno\s+name\s+changes?\b/i,
  /\bname\s+changes?\s+(?:is\s+|are\s+)?not\s+(?:allowed|permitted|possible)\b/i,
];

/**
 * "NOT VALID FOR Germany Market" (p. 51), pegado a la palabra anterior en el ejemplo ("yearNOT"):
 * por eso el patrón no exige un límite de palabra delante. El país entre medio va acotado.
 */
const MARKET_RESTRICTION = [
  /not\s+valid\s+for\s+[^.;\n]{1,60}?\s*markets?/i,
  /(?:valid|applicable)\s+only\s+for\s+[^.;\n]{1,60}?\s*markets?/i,
  /only\s+(?:valid|applicable)\s+for\s+[^.;\n]{1,60}?\s*markets?/i,
];

export interface TboRateConditionsReading {
  readonly conditions: HotelRateCondition[];
  /** Sin repetir, en el orden de {@link TBO_RATE_SIGNALS}. */
  readonly signals: HotelRateSignal[];
  /** Ítems que mencionan "package" sin disparar la señal: posibles falsos negativos (03 §2.11). */
  readonly packageMentionsWithoutSignal: number;
  /** Ítems que no dejan texto tras el saneo (sólo marcado o espacios). No se muestran. */
  readonly emptyItems: number;
  /** {@link tboRateConditionsHash} de `conditions`: lo que compara C2 (03 §2.9). */
  readonly textHash: string;
}

/**
 * Un ítem de `RateConditions` → texto plano, o `null` si no queda nada que mostrar.
 *
 * Tras la decodificación única, cada `&` se vuelve a escapar antes de pasar por el saneador: el
 * saneador decodifica entidades al leer texto, y sin ese escape haría la segunda pasada que el paso
 * 2 prohíbe. Así `&amp;lt;script&amp;gt;` termina como el texto `&lt;script&gt;` (RF-16 CA-1).
 */
export function tboRateConditionToText(raw: string): string | null {
  const decoded = decodeTboHtmlEntities(raw).replace(/\u00a0/g, ' ');
  const text = tboHtmlToText(decoded.replace(/&/g, '&amp;'));
  return text === null ? null : text.normalize('NFC');
}

export function classifyTboRateCondition(text: string): HotelRateConditionCategory {
  const trimmed = text.trimStart();
  for (const [category, prefix] of CATEGORY_PREFIXES) {
    if (prefix.test(trimmed)) return category;
  }
  return 'other';
}

/** Señales de UN texto ya saneado. Se busca sobre una sola línea: el saneo parte en viñetas. */
export function detectTboRateSignals(text: string): HotelRateSignal[] {
  const flat = text.replace(/\s+/g, ' ');
  const signals: HotelRateSignal[] = [];
  if ((SOLD_ONLY_WITH.test(flat) && AIR_TICKET.test(flat)) || PART_OF_A_PACKAGE.test(flat)) {
    signals.push('PACKAGE_WITH_FLIGHT_ONLY');
  }
  if (NO_NAME_CHANGE.some((pattern) => pattern.test(flat))) signals.push('NO_NAME_CHANGE');
  if (MARKET_RESTRICTION.some((pattern) => pattern.test(flat))) {
    signals.push('MARKET_RESTRICTION');
  }
  return signals;
}

/**
 * Huella del texto saneado, en orden (03 §2.9, C2). Sirve para comparar el snapshot que el vendedor
 * aceptó con la revalidación sin guardar dos veces el texto; el servidor la puede recalcular desde
 * el snapshot persistido.
 */
export function tboRateConditionsHash(
  conditions: readonly Pick<HotelRateCondition, 'text'>[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(conditions.map((condition) => condition.text)))
    .digest('hex');
}

export function readTboRateConditions(
  raw: readonly string[] | null | undefined,
): TboRateConditionsReading {
  const conditions: HotelRateCondition[] = [];
  const found = new Set<HotelRateSignal>();
  let packageMentionsWithoutSignal = 0;
  let emptyItems = 0;

  for (const item of raw ?? []) {
    const text = tboRateConditionToText(item);
    if (text === null) {
      emptyItems += 1;
      continue;
    }
    const signals = detectTboRateSignals(text);
    for (const signal of signals) found.add(signal);
    if (!signals.includes('PACKAGE_WITH_FLIGHT_ONLY') && PACKAGE_WORD.test(text)) {
      packageMentionsWithoutSignal += 1;
    }
    conditions.push({ category: classifyTboRateCondition(text), text, raw: item });
  }

  return {
    conditions,
    signals: TBO_RATE_SIGNALS.filter((signal) => found.has(signal)),
    packageMentionsWithoutSignal,
    emptyItems,
    textHash: tboRateConditionsHash(conditions),
  };
}
