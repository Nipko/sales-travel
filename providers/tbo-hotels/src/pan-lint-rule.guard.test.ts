import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// El ESLint real arma el programa de TypeScript en frío para cada sonda: en CI tardó 6-9 s y los
// casos caían por el timeout de 5 s de vitest, no por la regla.
vi.setConfig({ testTimeout: 60_000 });

/**
 * La regla D1 de `eslint.config.mjs` sobre los builders de TBO, probada con el ESLint real del
 * repo (docs/tbo/03 §7.2 barrera 4 y §7.3; 08 RNF-04 capa 4; 09 PR-1.3).
 *
 * TBO escribe sus claves de tarjeta en PascalCase (`PaymentInfo`, `CardNumber`, `CvvNumber`,
 * p. 33-34) y la regla original sólo conocía las camelCase: un `book.request.builder.ts` que
 * escribiera `{ PaymentInfo: { CardNumber: pan } }` pasaba el lint. Además los modos `NewCard` y
 * `SavedCard` son los que obligan a mandar esa tarjeta. Este guard fija las mismas tres
 * propiedades que el de Sabre (`providers/sabre/src/pan-lint-rule.guard.test.ts`) y una cuarta
 * que es propia de TBO:
 *
 *  1. **Dispara**, y como error, con cada clave de TBO —desnuda, entre comillas y leída— y con los
 *     dos modos, escritos como literal o leídos como miembro de un enum.
 *  2. **No dispara** sobre la barrera de tipo `PaymentInfo?: never` ni sobre
 *     `PaymentMode: 'Limit'`, que es lo que escribirán los builders de PreBook, Book y
 *     BookingDetail.
 *  3. **No dispara** fuera de alcance: el mapper de LECTURA y el test del builder.
 *  4. El bloque de TBO **repite** los selectores de claves. En la configuración plana el bloque
 *     posterior reemplaza las opciones del anterior, y un bloque con sólo el `Literal` apagaría la
 *     prohibición de claves justo aquí. Además de las sondas, se mira la configuración efectiva,
 *     que dice cuál de las dos mitades falta.
 *
 * Las sondas van una clave por línea y se compara el conjunto de líneas señaladas: quitar UNA clave
 * de la lista deja su línea sin mensaje y el caso se pone rojo con el nombre de la clave.
 */

/** Las claves de 03 §7.3, en el casing del PDF (la tabla y los ejemplos no coinciden). */
const TBO_CARD_KEYS = [
  'PaymentInfo',
  'CardNumber',
  'CvvNumber',
  'CardExpirationMonth',
  'CardExpirationYear',
  'CardHolderFirstName',
  'CardHolderLastName',
  'CardHolderlastName',
  'CardHolderAddress',
] as const;

const PROBE_DIR_NAME = '__d1-lint-probe__';

function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'eslint.config.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('no se encontró eslint.config.mjs subiendo desde el paquete');
    dir = parent;
  }
}

const SRC_DIR = __dirname;
const REPO_ROOT = findRepoRoot(SRC_DIR);
const PROBE_DIR = join(SRC_DIR, PROBE_DIR_NAME);

/** ESLint desde la raíz del monorepo, que es donde está declarado y desde donde corre CI. */
const require_ = createRequire(join(REPO_ROOT, 'package.json'));

interface LintMessage {
  readonly ruleId: string | null;
  readonly severity: number;
  readonly message: string;
  readonly line: number;
}
interface LintResult {
  readonly messages: readonly LintMessage[];
}
interface EffectiveConfig {
  readonly rules?: Readonly<Record<string, unknown>>;
}
interface EslintInstance {
  lintFiles(patterns: string[]): Promise<LintResult[]>;
  calculateConfigForFile(filePath: string): Promise<EffectiveConfig | undefined>;
}
interface EslintCtor {
  new (options: { cwd: string }): EslintInstance;
}

const { ESLint } = require_('eslint') as { ESLint: EslintCtor };

/** Escribe la sonda, la pasa por ESLint y devuelve sólo los mensajes de D1. */
async function lintProbe(fileName: string, source: string): Promise<readonly LintMessage[]> {
  const filePath = join(PROBE_DIR, fileName);
  writeFileSync(filePath, source, 'utf8');
  const results = await new ESLint({ cwd: REPO_ROOT }).lintFiles([filePath]);
  // Las otras reglas se ignoran a propósito: la sonda es código sintético y endurecer cualquier
  // regla del repo no debe poner rojo este guard por algo ajeno a D1.
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'no-restricted-syntax');
}

/**
 * `no-restricted-syntax` tal como ESLint lo aplicaría a un fichero, exista o no. La severidad
 * llega normalizada a número (2 = error).
 */
async function effectiveRule(
  filePath: string,
): Promise<{ readonly severity: unknown; readonly selectors: readonly string[] }> {
  const config = await new ESLint({ cwd: REPO_ROOT }).calculateConfigForFile(filePath);
  const entry = config?.rules?.['no-restricted-syntax'];
  if (!Array.isArray(entry)) return { severity: undefined, selectors: [] };
  const [severity, ...options] = entry as readonly unknown[];
  return {
    severity,
    selectors: options.map((option) =>
      typeof option === 'string' ? option : (option as { selector: string }).selector,
    ),
  };
}

async function effectiveSelectors(filePath: string): Promise<readonly string[]> {
  return (await effectiveRule(filePath)).selectors;
}

/**
 * `eslint src` sale con 0 si sólo hay avisos (ningún script pasa `--max-warnings 0`): bajar la
 * regla a `warn` la dejaría viva en el editor y muerta en CI. Por eso cada caso que dispara
 * exige severidad de error y no sólo el mensaje.
 */
function allErrors(messages: readonly LintMessage[]): boolean {
  return messages.every((message) => message.severity === 2);
}

/** Una línea por clave, con su número de línea (1-based) para comparar contra los mensajes. */
function probeSource(
  header: readonly string[],
  lineFor: (key: string) => string,
  footer: readonly string[],
): { source: string; lineOf: ReadonlyMap<number, string> } {
  const lineOf = new Map<number, string>();
  TBO_CARD_KEYS.forEach((key, index) => lineOf.set(header.length + index + 1, key));
  const lines = [...header, ...TBO_CARD_KEYS.map(lineFor), ...footer];
  return { source: `${lines.join('\n')}\n`, lineOf };
}

/** Claves cuya línea no recibió exactamente un mensaje D1. Vacío es lo correcto. */
function keysNotFlaggedOnce(
  messages: readonly LintMessage[],
  lineOf: ReadonlyMap<number, string>,
): string[] {
  return [...lineOf]
    .filter(([line]) => messages.filter((message) => message.line === line).length !== 1)
    .map(([, key]) => key);
}

const WRITES_KEYS = probeSource(
  ['export function build(input: { readonly v: string }): Record<string, unknown> {', '  return {'],
  (key) => `    ${key}: input.v,`,
  ['  };', '}'],
);

const WRITES_QUOTED_KEYS = probeSource(
  ['export function build(input: { readonly v: string }): Record<string, unknown> {', '  return {'],
  (key) => `    '${key}': input.v,`,
  ['  };', '}'],
);

const READS_KEYS = probeSource(
  ['export function read(input: Record<string, string>): unknown[] {', '  return ['],
  (key) => `    input.${key},`,
  ['  ];', '}'],
);

/** Los dos modos con tarjeta, como valor, como tipo y dentro de una lista. */
const CARD_MODES_SOURCE = `export type Mode = 'Limit' | 'NewCard';

export function build(): Record<string, unknown> {
  return { PaymentMode: 'SavedCard' };
}

export const MODES: readonly string[] = ['NewCard'];
`;
const CARD_MODES_LINES = [1, 4, 7];

/**
 * Los modos leídos de un enum o de una constante declarados en OTRO fichero, que es como se
 * escribiría el enum `PaymentMode` del PDF (p. 70). En el builder no queda ningún `Literal`:
 * sólo el nombre del miembro.
 */
const CARD_MODES_BY_MEMBER_SOURCE = `export function build(modes: Readonly<Record<string, string>>): Record<string, unknown> {
  return {
    PaymentMode: modes.NewCard,
    Fallback: modes.SavedCard,
  };
}
`;
const CARD_MODES_BY_MEMBER_LINES = [3, 4];

/**
 * Lo que escribirá el builder de PreBook (03 §2.1 y §3.6; 06 §4.3 regla 2): el modo `Limit` como
 * literal y la barrera de compilación sobre `PaymentInfo`. Ni una línea de esto puede señalarse.
 */
const LIMIT_BUILDER_SOURCE = `interface PreBookWire {
  readonly BookingCode: string;
  readonly PaymentMode: 'Limit';
  readonly PaymentInfo?: never;
  readonly CardNumber?: never;
  readonly CvvNumber?: never;
  readonly CardHolderlastName?: never;
}

export function build(input: { readonly bookingCode: string }): PreBookWire {
  return { BookingCode: input.bookingCode, PaymentMode: 'Limit' };
}
`;

/** Todo lo prohibido junto: la sonda de los casos fuera de alcance. */
const EVERYTHING_SOURCE = `${WRITES_KEYS.source}
export function read(input: Record<string, string>): unknown[] {
  return [input.CardNumber, input.CvvNumber, 'NewCard', 'SavedCard'];
}
`;

beforeAll(() => {
  mkdirSync(PROBE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(PROBE_DIR, { recursive: true, force: true });
});

describe('D1 dispara en los builders de TBO', () => {
  it('con cada clave de tarjeta escrita como clave desnuda', async () => {
    const messages = await lintProbe('book.request.builder.ts', WRITES_KEYS.source);
    expect(keysNotFlaggedOnce(messages, WRITES_KEYS.lineOf)).toEqual([]);
    expect(messages).toHaveLength(TBO_CARD_KEYS.length);
    expect(messages.every((message) => message.message.startsWith('D1:'))).toBe(true);
    expect(allErrors(messages), 'D1 bajó a aviso: CI no la vería').toBe(true);
  });

  it('con cada clave de tarjeta entre comillas', async () => {
    const messages = await lintProbe('quoted.request.builder.ts', WRITES_QUOTED_KEYS.source);
    expect(keysNotFlaggedOnce(messages, WRITES_QUOTED_KEYS.lineOf)).toEqual([]);
    expect(messages).toHaveLength(TBO_CARD_KEYS.length);
    expect(allErrors(messages)).toBe(true);
  });

  it('con cada clave de tarjeta leída: es el paso previo a escribirla', async () => {
    const messages = await lintProbe('reads.request.builder.ts', READS_KEYS.source);
    expect(keysNotFlaggedOnce(messages, READS_KEYS.lineOf)).toEqual([]);
    expect(messages).toHaveLength(TBO_CARD_KEYS.length);
    expect(allErrors(messages)).toBe(true);
  });

  it('con NewCard y SavedCard como valor, como tipo y en una lista', async () => {
    const messages = await lintProbe('modes.request.builder.ts', CARD_MODES_SOURCE);
    expect(messages.map((message) => message.line)).toEqual(CARD_MODES_LINES);
    expect(messages.every((message) => message.message.includes('Limit'))).toBe(true);
    expect(allErrors(messages)).toBe(true);
  });

  it('con NewCard y SavedCard leídos como miembro de un enum o una constante', async () => {
    const messages = await lintProbe(
      'modes-member.request.builder.ts',
      CARD_MODES_BY_MEMBER_SOURCE,
    );
    expect(messages.map((message) => message.line)).toEqual(CARD_MODES_BY_MEMBER_LINES);
    expect(allErrors(messages)).toBe(true);
  });

  // Los tres globs de D1, no sólo el del plan: 03 §7.2 admite `.serializer.ts` para un cuerpo de
  // salida, y `request.builder.ts` a secas es el nombre que usan los demás proveedores.
  it.each(['book.serializer.ts', 'request.builder.ts'])(
    'también en %s, los otros nombres de salida de D1',
    async (fileName) => {
      const messages = await lintProbe(fileName, CARD_MODES_SOURCE);
      expect(messages.map((message) => message.line)).toEqual(CARD_MODES_LINES);
      expect(allErrors(messages)).toBe(true);
    },
  );
});

describe('D1 no dispara sobre lo que un builder de TBO sí escribe', () => {
  it('PaymentMode "Limit" y la barrera `PaymentInfo?: never`', async () => {
    // Si esto se pusiera rojo, el arreglo NO es tocar la sonda: es estrechar el selector. Una regla
    // que obligue a borrar los `?: never` cambia una defensa de compilador por una de linter.
    const messages = await lintProbe('prebook.request.builder.ts', LIMIT_BUILDER_SOURCE);
    expect(messages).toEqual([]);
  });
});

describe('D1 no sale de los builders', () => {
  it.each([
    // El carril de LECTURA: la regla prohíbe escribir hacia fuera, no nombrar lo que llega. Que
    // la respuesta no modele datos de tarjeta lo fija otra barrera (03 §7.2, la 5), no este lint.
    'booking-detail.response.mapper.ts',
    // El test del builder de Book tiene que poder afirmar que `PaymentInfo` y `NewCard` no salen.
    'book.request.builder.test.ts',
  ])('%s queda fuera', async (fileName) => {
    const messages = await lintProbe(fileName, EVERYTHING_SOURCE);
    expect(messages, 'la regla se desbordó fuera de los builders de salida').toEqual([]);
  });
});

describe('el bloque de TBO repite los selectores de claves de D1', () => {
  // El mismo fichero en este paquete y en otro: sólo cambia el directorio. Ninguno de los dos
  // tiene que existir, ESLint calcula la configuración por la ruta.
  const TBO_BUILDER = join(SRC_DIR, 'booking', 'book.request.builder.ts');
  const OTHER_BUILDER = join(
    REPO_ROOT,
    'providers',
    'otro',
    'src',
    'booking',
    'book.request.builder.ts',
  );

  it('un builder de TBO lleva los selectores de cualquier builder, más los modos', async () => {
    const tbo = await effectiveRule(TBO_BUILDER);
    const other = await effectiveRule(OTHER_BUILDER);
    expect(other.selectors.length, 'el builder de referencia perdió la regla D1').toBeGreaterThan(
      0,
    );
    expect(tbo.selectors).toEqual(expect.arrayContaining([...other.selectors]));
    expect(tbo.selectors.filter((selector) => selector.includes('NewCard'))).toHaveLength(1);
    expect(tbo.severity, 'D1 en los builders de TBO tiene que ser error').toBe(2);
  });

  it('los modos de TBO no alcanzan a los builders de otros proveedores', async () => {
    const other = await effectiveSelectors(OTHER_BUILDER);
    expect(other.some((selector) => /NewCard|SavedCard/.test(selector))).toBe(false);
  });
});
