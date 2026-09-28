import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Humo de 05 §6.2: la herramienta es ESM y el ACL es CommonJS. Node 20 deja importar nombres de un
 * módulo CJS sólo si su análisis estático (`cjs-module-lexer`) los encuentra en el `dist`; vitest
 * no lo prueba, porque transforma los módulos a su manera. Este test lanza un `node` de verdad en
 * modo ESM, desde la carpeta de la herramienta, e importa EXACTAMENTE los nombres que usa el
 * código que corre en el contenedor: si alguien agrega un import que Node no puede resolver, falla
 * aquí y no a las 08:00 UTC en el VPS.
 */

const TOOL_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const ACL = '@sales-travel/tbo-hotels';

function runtimeSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : runtimeSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Los nombres de VALOR importados del ACL (los `import type` se borran al compilar). */
function aclValueImports(): string[] {
  const names = new Set<string>();
  for (const file of runtimeSources(SRC_DIR)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || specifier.text !== ACL) continue;
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text);
      }
    }
  }
  return [...names].sort();
}

describe('la herramienta ESM importa el ACL CommonJS', () => {
  it('Node, en modo ESM, resuelve cada nombre que el código de producción importa del ACL', () => {
    const names = aclValueImports();
    expect(names).toEqual(
      expect.arrayContaining([
        'TboStaticContentClient',
        'TboInMemoryRateLimiter',
        'parseTboConfig',
      ]),
    );
    const script = [
      `import { ${names.join(', ')} } from '${ACL}';`,
      `const values = { ${names.join(', ')} };`,
      `const missing = Object.entries(values).filter(([, v]) => v === undefined).map(([k]) => k);`,
      `process.stdout.write(JSON.stringify({ missing, count: Object.keys(values).length }));`,
    ].join('\n');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: TOOL_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual({ missing: [], count: names.length });
  });
});
