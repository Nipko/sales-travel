import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOSEO_WORDS, voseoIn } from './__fixtures__/voseo.js';

/*
 * Los mensajes del acceso, las invitaciones y Equipo salen de estas carpetas y llegan tal cual al
 * panel y a los correos. Van en "tú" neutro (decisión del founder): este guarda falla con
 * archivo:línea si vuelve a entrar un voseo, en un texto o en un comentario que lo cite.
 *
 * Los tests quedan afuera: arman nombres de nodo hostiles y otros textos de prueba a propósito.
 */

const SRC_DIR = __dirname;
const SCANNED_DIRS = ['auth', 'tenants'];

/**
 * Líneas que pueden llevar una de las palabras sin ser voseo (`archivo` relativo a `src/` con `/`,
 * y un fragmento de la línea). Cada entrada tiene que seguir haciendo falta.
 */
const ALLOWED: readonly { file: string; line: string }[] = [];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function allowed(file: string, line: string): boolean {
  return ALLOWED.some((entry) => entry.file === file && line.includes(entry.line));
}

describe('los textos del acceso, las invitaciones y Equipo van en tú', () => {
  const files = SCANNED_DIRS.flatMap((dir) => sources(join(SRC_DIR, dir)));

  it('recorre las carpetas de verdad', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(`${sep}auth-errors.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}invitations.service.ts`))).toBe(true);
  });

  it('ningún archivo de auth/ ni de tenants/ usa voseo', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_DIR, file).split(sep).join('/');
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const words = voseoIn(line);
          if (words.length > 0 && !allowed(rel, line)) {
            offenders.push(`${rel}:${i + 1} (${words.join(', ')}): ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('cada excepción de la lista sigue haciendo falta', () => {
    for (const entry of ALLOWED) {
      const text = readFileSync(join(SRC_DIR, entry.file), 'utf8');
      const line = text.split(/\r?\n/).find((l) => l.includes(entry.line));
      expect(line, `${entry.file}: "${entry.line}"`).toBeDefined();
      expect(voseoIn(line ?? '')).not.toEqual([]);
    }
  });
});

describe('voseoIn', () => {
  it('encuentra las formas del voseo, con o sin mayúscula y al final de la frase', () => {
    expect(voseoIn('No podés hacerlo. Probá de nuevo.')).toEqual(['podés', 'Probá']);
    expect(voseoIn('Sólo vos la vas a conocer; activala.')).toEqual(['vos', 'activala']);
  });

  it('no confunde el tú, los futuros ni las palabras que contienen una forma', () => {
    expect(
      voseoIn('No puedes hacerlo: inténtalo de nuevo. Podrá elegir, estás a tiempo. Votos y usos.'),
    ).toEqual([]);
  });

  it('la lista no tiene repetidas', () => {
    expect(new Set(VOSEO_WORDS).size).toBe(VOSEO_WORDS.length);
  });
});
