import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Test de contrato de RNF-15.
 *
 * Los 21 `.yml` oficiales **no viven dentro de este paquete**. Copiarlos aquí dejaría dos
 * originales de 3,9 MB divergiendo en silencio, que es justamente el fallo contra el que existe
 * el requisito (docs/sabre/11 §6.1, R-25). Lo que se pinea es `{slug, info.version, sha256}` en
 * `spec/manifest.json`, y este test es lo que convierte ese pineo en algo vivo: si alguien baja
 * una versión nueva del devhub y la deja caer encima de `docs/sabre/evidence/specs/`, el build
 * falla y obliga a mirar el diff. Sin él, el ACL se seguiría creyendo un contrato que ya cambió.
 *
 * Las ~185 citas `archivo.yml:línea` del expediente apuntan a esa carpeta: un `.yml` que se mueve
 * bajo los pies también invalida las citas.
 */

const SpecEntrySchema = z.object({
  slug: z.string().min(1),
  file: z.string().regex(/^[a-z0-9.-]+\.yml$/),
  version: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const SpecManifestSchema = z.object({
  specDir: z.string().min(1),
  algorithm: z.literal('sha256'),
  count: z.number().int().positive(),
  specs: z.array(SpecEntrySchema).min(1),
});

/** El expediente cerró con 21 contratos (`docs/sabre/evidence/specs/00-fuentes.md` §3). */
const EXPECTED_SPEC_COUNT = 21;

/**
 * Raíz del monorepo. Se busca subiendo desde el cwd en vez de contar `../` porque vitest puede
 * arrancar desde la raíz (`pnpm test`) o desde el paquete (`pnpm --filter … test`).
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('no se encontró la raíz del monorepo (pnpm-workspace.yaml)');
    dir = parent;
  }
}

/**
 * `info.version` de un OpenAPI, sin dependencia de YAML.
 *
 * Se lee sólo el bloque `info:` de primer nivel y sólo su hijo directo `version:`. Un parser
 * completo cargaría 3,9 MB de esquemas para leer un campo, y el resto del contrato ya está
 * verificado a mano con `grep` en el expediente.
 */
export function readInfoVersion(yaml: string): string | null {
  let inInfo = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^info:\s*$/.test(line)) {
      inInfo = true;
      continue;
    }
    if (!inInfo) continue;
    if (/^\S/.test(line)) break;
    const match = /^ {2}version:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[1];
    if (raw === undefined) continue;
    const quoted =
      (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'));
    return quoted ? raw.slice(1, -1) : raw;
  }
  return null;
}

const repoRoot = findRepoRoot();
const manifestPath = join(repoRoot, 'providers', 'sabre', 'spec', 'manifest.json');
const manifest = SpecManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
const specDir = resolve(repoRoot, manifest.specDir);

describe('spec/manifest.json', () => {
  it('declara los 21 contratos del expediente', () => {
    expect(manifest.specs).toHaveLength(EXPECTED_SPEC_COUNT);
    expect(manifest.count).toBe(EXPECTED_SPEC_COUNT);
  });

  it('no repite slugs ni ficheros', () => {
    const slugs = manifest.specs.map((spec) => spec.slug);
    const files = manifest.specs.map((spec) => spec.file);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it('el slug es el nombre del fichero sin extensión', () => {
    for (const spec of manifest.specs) {
      expect(spec.slug).toBe(spec.file.replace(/\.yml$/, ''));
    }
  });

  it('cubre exactamente los .yml de docs/sabre/evidence/specs/', () => {
    // Las dos direcciones importan: un contrato nuevo sin pinear es tan malo como uno pineado que
    // ya no está, y sólo comparar una lista contra la otra detecta el primero.
    const onDisk = readdirSync(specDir)
      .filter((file) => file.endsWith('.yml'))
      .sort();
    const declared = manifest.specs.map((spec) => spec.file).sort();
    expect(declared).toEqual(onDisk);
  });
});

describe('contratos congelados', () => {
  it.each(manifest.specs.map((spec) => [spec.slug, spec] as const))(
    '%s conserva su sha256 y su info.version',
    (_slug, spec) => {
      const bytes = readFileSync(join(specDir, spec.file));

      expect(bytes.length).toBe(spec.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(spec.sha256);
      expect(readInfoVersion(bytes.toString('utf8'))).toBe(spec.version);
    },
  );
});

describe('readInfoVersion', () => {
  // El extractor se prueba aparte: si devolviera siempre `null`, el test de arriba pasaría sólo
  // porque el manifest también diría `null`. Aquí se fija su comportamiento contra literales.
  it('lee el valor desnudo, entre comillas simples y entre dobles', () => {
    expect(readInfoVersion('info:\n  title: X\n  version: v5\npaths: {}\n')).toBe('v5');
    expect(readInfoVersion("info:\n  version: '1.5'\n")).toBe('1.5');
    expect(readInfoVersion('info:\n  version: "2.3"\n')).toBe('2.3');
  });

  it('ignora versiones que no cuelgan del bloque info de primer nivel', () => {
    expect(readInfoVersion('components:\n  info:\n    version: v9\n')).toBeNull();
    expect(readInfoVersion('info:\n  contact:\n    version: v9\n')).toBeNull();
    expect(readInfoVersion('info:\n  title: X\npaths:\n  version: v9\n')).toBeNull();
  });

  it('devuelve null cuando no hay bloque info', () => {
    expect(readInfoVersion('openapi: 3.0.0\npaths: {}\n')).toBeNull();
  });
});
