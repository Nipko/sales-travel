import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * La regla de lint anti-tarjeta de `eslint.config.mjs`, probada de verdad.
 *
 * Una regla de lint es una defensa como cualquier otra, y este paquete ya sabe lo que cuesta una
 * defensa sin test que la fije: la regla se escribe, alguien la afloja seis meses después —o un
 * refactor del glob deja de cubrir los ficheros de siempre— y nadie se entera porque el linter
 * sigue saliendo verde sobre código que no infringe nada. Aquí se ejecuta ESLint DE VERDAD, con la
 * configuración real del repo, sobre ficheros escritos a disco, y se comprueban las **tres**
 * afirmaciones que hacen útil a la regla:
 *
 *  1. **Dispara** cuando un builder de salida escribe un campo de tarjeta.
 *  2. **No dispara** sobre la declaración de tipo `?: never`, que es la barrera de compilación de
 *     D1 y una defensa más fuerte que este lint. Una regla más ancha la borraría.
 *  3. **No dispara** fuera de alcance: `*.response.mapper.ts` es el carril de LECTURA, donde Sabre
 *     devuelve la tarjeta ya enmascarada y enseñar los cuatro últimos dígitos al vendedor es
 *     funcionalidad legítima que obliga a nombrar el campo.
 *
 * Sin la 2 y la 3 esto no sería un test de la regla: sería un test de que existe alguna regla.
 */

/** Los ficheros de sonda se escriben aquí y se borran al terminar. Nombres que ningún build usa. */
const PROBE_DIR_NAME = '__d1-lint-probe__';

/** Un builder que escribe campos de tarjeta en dos formas: clave desnuda y clave entre comillas. */
const OFFENDING_SOURCE = `interface Wire {
  readonly cardNumber?: never;
  readonly cardSecurityCode?: never;
}

export function build(input: { readonly pan: string }): Record<string, unknown> {
  return { cardNumber: input.pan, 'cardSecurityCode': '123' };
}

export type { Wire };
`;

/** Sólo la barrera de tipo. No escribe nada: la regla no puede tener nada que decir. */
const TYPE_ONLY_SOURCE = `export interface PanFree {
  readonly cardNumber?: never;
  readonly cardSecurityCode?: never;
  readonly cardHolder?: never;
}
`;

function findPackageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/sabre') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

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

const PKG_DIR = findPackageRoot();
const REPO_ROOT = findRepoRoot(PKG_DIR);
const PROBE_DIR = join(PKG_DIR, 'src', PROBE_DIR_NAME);

/**
 * ESLint se resuelve desde la raíz del monorepo, que es donde está declarado y desde donde lo
 * ejecuta CI. Igual que en `format.guard.test.ts`: medir con otra copia sería medir otra regla.
 */
const require_ = createRequire(join(REPO_ROOT, 'package.json'));

interface LintMessage {
  readonly ruleId: string | null;
  readonly message: string;
  readonly line: number;
}
interface LintResult {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
}
interface EslintCtor {
  new (options: { cwd: string }): { lintFiles(patterns: string[]): Promise<LintResult[]> };
}

const { ESLint } = require_('eslint') as { ESLint: EslintCtor };

/** Escribe la sonda, la pasa por ESLint y devuelve sólo los mensajes de la regla que interesa. */
async function lintProbe(fileName: string, source: string): Promise<readonly LintMessage[]> {
  const filePath = join(PROBE_DIR, fileName);
  writeFileSync(filePath, source, 'utf8');
  const results = await new ESLint({ cwd: REPO_ROOT }).lintFiles([filePath]);
  const messages = results.flatMap((result) => result.messages);
  // Los errores de OTRAS reglas se ignoran a propósito: la sonda es código sintético y aquí sólo
  // se mide `no-restricted-syntax`. Mezclarlos haría que endurecer cualquier otra regla del repo
  // pusiera rojo este guard por algo que no tiene que ver con D1.
  return messages.filter((message) => message.ruleId === 'no-restricted-syntax');
}

beforeAll(() => {
  mkdirSync(PROBE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(PROBE_DIR, { recursive: true, force: true });
});

describe('la regla de lint anti-tarjeta de eslint.config.mjs está viva y acotada', () => {
  it('la configuración del repo declara la regla: sin esto no hay nada que probar', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    expect(config).toContain('no-restricted-syntax');
    expect(config).toContain('cardSecurityCode');
    // El alcance en el propio fichero de configuración. Si alguien lo amplía a `**/*.ts`, esta
    // línea no lo detecta —lo detecta el caso del mapper de lectura de más abajo—, pero si lo
    // reduce hasta dejar fuera los builders, esto se pone rojo antes.
    expect(config).toContain('**/*.request.builder.ts');
    expect(config).toContain('**/*.serializer.ts');
  });

  it('dispara sobre un *.request.builder.ts que ESCRIBE campos de tarjeta', async () => {
    const messages = await lintProbe('probe.request.builder.ts', OFFENDING_SOURCE);
    expect(messages.length, 'la regla no disparó: el glob o el selector han dejado de cubrir').toBe(
      2,
    );
    expect(messages.every((message) => message.message.startsWith('D1:'))).toBe(true);
  });

  it('dispara igual sobre un *.serializer.ts: el otro carril de salida', async () => {
    const messages = await lintProbe('probe.serializer.ts', OFFENDING_SOURCE);
    expect(messages.length).toBe(2);
  });

  it('NO dispara sobre la barrera de tipo `?: never`, que es la defensa fuerte de D1', async () => {
    // Si esto se pusiera rojo, el arreglo NO sería tocar la sonda: sería estrechar el selector. Una
    // regla que obligue a borrar los `?: never` de `create.request.builder.ts` cambia una defensa
    // de compilador por una de linter, que es un cambio a peor disfrazado de limpieza.
    const messages = await lintProbe('probe.types.request.builder.ts', TYPE_ONLY_SOURCE);
    expect(messages).toEqual([]);
  });

  it('NO dispara sobre un *.response.mapper.ts: la lectura enmascarada es legítima', async () => {
    // `getBooking` devuelve la tarjeta ya enmascarada por Sabre. Enseñar los cuatro últimos
    // dígitos al vendedor exige nombrar el campo en el mapper de LECTURA, y una regla global
    // obligaría a desactivarla justo ahí — que es como mueren las reglas de lint.
    const messages = await lintProbe('probe.response.mapper.ts', OFFENDING_SOURCE);
    expect(
      messages,
      'la regla se ha desbordado al carril de lectura: acótala en eslint.config.mjs',
    ).toEqual([]);
  });
});
