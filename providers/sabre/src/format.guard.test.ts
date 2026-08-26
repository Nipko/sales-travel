import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Por qué existe este guard: el formato de este paquete se degradó DOS veces, y las dos veces se
 * descubrió a mano corriendo `pnpm format:check` desde la raíz. No fue mala suerte: las dos redes
 * que existen miran en un momento en el que este paquete todavía no está.
 *
 *   - `.githooks/pre-commit` (ronda 7) comprueba el ÍNDICE. Sólo dispara en `git commit`.
 *   - `pnpm format:check` en `.github/workflows/ci.yml` comprueba la RAMA. Sólo dispara en push/PR.
 *
 * `providers/sabre/` lleva ocho rondas de auditoría ENTERO SIN TRACKEAR: nunca se ha estado en un
 * índice ni en una rama, así que ninguna de las dos redes ha llegado a ejecutarse una sola vez
 * sobre estos ficheros. No están rotas —se ha verificado que el hook rechaza correctamente un
 * fichero sin formatear—, simplemente vigilan una puerta por la que este código todavía no ha
 * pasado. Entre commit y commit, el árbol de trabajo no lo mira nadie, y una ronda de auditoría
 * son horas de ediciones sin un solo commit.
 *
 * Este guard mueve la comprobación al único bucle que SÍ se ejecuta en cada ronda: la propia suite
 * del paquete. No sustituye a las otras dos —el hook sigue siendo la primera red y CI la que
 * decide—; cubre el hueco temporal entre ambas, que es exactamente donde ocurrieron las dos
 * regresiones.
 *
 * ## Por qué falla ruidosamente si no encuentra prettier
 *
 * La tentación es `describe.skipIf(!prettier)`. Este paquete ya lleva dos notas escritas sobre lo
 * que cuesta eso —las PG* de `turbo.json` y el `skipIf(!existsSync(DIST_DIR))` de los guards de
 * artefacto, que en CI se saltaban en silencio dejando el build verde sin haber corrido el guard
 * del incidente—. Verde por omisión no es verde. Si prettier no se resuelve, esto es un fallo.
 *
 * `prettier` no se declara como dependencia del paquete a propósito: es una devDependency de la
 * raíz y se resuelve subiendo por `node_modules`, igual que la resuelve el script `format:check`
 * que corre CI. Declararla aquí duplicaría la versión y abriría la puerta a que este guard midiera
 * con una regla distinta de la que aplica CI, que es el fallo original en otra forma.
 */

/** Extensiones que cubre el glob de `format:check` en la raíz. Se replican para medir lo mismo. */
const PRETTIER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);

/** Directorios que son salida o dependencias, nunca fuente. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  '.git',
]);

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
  const fromWorkspace = resolvePath(process.cwd(), 'providers', 'sabre');
  if (existsSync(join(fromWorkspace, 'package.json'))) return fromWorkspace;
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

/** La raíz del monorepo es la que tiene el `.prettierignore` y el `.prettierrc.json` que usa CI. */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, '.prettierrc.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('no se encontró .prettierrc.json subiendo desde el paquete');
    dir = parent;
  }
}

const PKG_DIR = findPackageRoot();
const REPO_ROOT = findRepoRoot(PKG_DIR);
const IGNORE_PATH = join(REPO_ROOT, '.prettierignore');

/**
 * Se resuelve prettier desde la raíz del monorepo, que es donde está declarado, con el mismo
 * `createRequire` que ya usan los guards de artefacto.
 */
const require_ = createRequire(join(REPO_ROOT, 'package.json'));

interface PrettierApi {
  readonly version: string;
  resolveConfig(filePath: string): Promise<Record<string, unknown> | null>;
  getFileInfo(
    filePath: string,
    options: { ignorePath: string },
  ): Promise<{ ignored: boolean; inferredParser: string | null }>;
  check(source: string, options: Record<string, unknown>): Promise<boolean>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
}

const prettier = require_('prettier') as PrettierApi;

function collectFiles(dir: string, out: string[]): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      collectFiles(join(dir, item.name), out);
      continue;
    }
    if (item.isFile() && PRETTIER_EXTENSIONS.has(extname(item.name)))
      out.push(join(dir, item.name));
  }
  return out;
}

/** Ruta relativa al repo y con `/`, para que el mensaje de fallo sea pegable en `pnpm format`. */
function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

describe('el paquete está formateado (misma regla que `pnpm format:check` de CI)', () => {
  it('prettier se resuelve: sin él este guard no puede afirmar nada', () => {
    // Ver la cabecera: aquí NO se salta, se falla. Un guard que se salta solo es un guard que no
    // existe, y este paquete ya ha pagado esa lección dos veces.
    expect(typeof prettier.check, 'prettier no expone check(): resolución rota').toBe('function');
    expect(prettier.version, 'prettier sin versión: resolución sospechosa').toMatch(/^\d+\./);
  });

  // 60 s, no los 5 s por defecto: este guard LANZA prettier como subproceso sobre todo el
  // paquete, así que su coste es el de arrancar un Node y parsear ~60 ficheros, no el de una
  // aserción. En el runner de CI tardó 5.028 ms contra el límite de 5.000 y se cayó por 28 ms —
  // rojo por lentitud del runner, sin un solo fichero mal formateado. Un guard que falla por el
  // reloj enseña a ignorarlo, que es justo lo contrario de para lo que existe.
  it('los ficheros del paquete pasan prettier --check', { timeout: 60_000 }, async () => {
    const files = collectFiles(PKG_DIR, []);
    // Si el recorrido no encuentra nada, el test pasaría vacío y volveríamos a verde-por-omisión.
    expect(
      files.length,
      'el recorrido no encontró ficheros: el guard no estaría midiendo nada',
    ).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const info = await prettier.getFileInfo(file, { ignorePath: IGNORE_PATH });
      if (info.ignored || info.inferredParser === null) continue;

      const source = readFileSync(file, 'utf8');
      const config = (await prettier.resolveConfig(file)) ?? {};
      const options = { ...config, filepath: file };
      if (!(await prettier.check(source, options))) offenders.push(repoRelative(file));
    }

    expect(
      offenders,
      `sin formatear (arréglalo con \`pnpm format\`):\n  - ${offenders.join('\n  - ')}\n\n` +
        'Es el mismo comando que corre CI como PRIMER paso del job build: si esto está rojo, ' +
        'CI se para antes de lint, typecheck y test.',
    ).toEqual([]);
  });
});
