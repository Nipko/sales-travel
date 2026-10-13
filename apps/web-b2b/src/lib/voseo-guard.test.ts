import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VOSEO_WORDS, voseoIn } from './voseo';

/*
 * El acceso (login, contraseña, invitación, verificación), Equipo, Plataforma → Usuarios y la
 * seguridad de la cuenta van en "tú" neutro (decisión del founder). Este guarda falla con
 * archivo:línea si vuelve a entrar un voseo, en un texto o en un comentario que lo cite. Los tests
 * quedan afuera.
 */

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Carpetas y archivos sueltos que se recorren, relativos a `src/`. */
const SCANNED = [
  'app/login',
  'app/olvide-password',
  'app/restablecer',
  'app/invitacion',
  'app/verificar',
  'app/(app)/admin/usuarios',
  'app/(app)/admin/plataforma/usuarios',
  'app/(app)/configuracion',
  'app/api/auth',
  'app/api/invitations',
  'app/api/session',
  'app/api/admin/users',
  'components/auth',
  'components/layout',
  // El "no pudimos conectar" de cada pedido al API: llega al acceso y a Equipo.
  'lib/api.ts',
  'lib/read-json.ts',
  'lib/session-reasons.ts',
  'lib/viewer.ts',
  // Plataforma → Usuarios: el directorio de toda la red y la suspensión de una cuenta.
  'lib/platform-users.ts',
  'lib/platform-users-proxy.ts',
];

/** Además, todo `lib/tenant-admin-*.ts`. */
const LIB_PREFIX = 'tenant-admin-';

/**
 * Líneas que pueden llevar una de las palabras sin ser voseo (`archivo` relativo a `src/` con `/`,
 * y un fragmento de la línea). Cada entrada tiene que seguir haciendo falta.
 */
const ALLOWED: readonly { file: string; line: string }[] = [];

function isSource(name: string): boolean {
  return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name);
}

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return isSource(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => sources(join(path, name)));
}

function toRel(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

function allowed(file: string, line: string): boolean {
  return ALLOWED.some((entry) => entry.file === file && line.includes(entry.line));
}

describe('los textos del acceso, Equipo, Plataforma → Usuarios y la seguridad de la cuenta van en tú', () => {
  const libDir = join(SRC_DIR, 'lib');
  const files = [
    ...SCANNED.flatMap((p) => sources(join(SRC_DIR, p))),
    ...readdirSync(libDir)
      .filter((name) => name.startsWith(LIB_PREFIX) && isSource(name))
      .map((name) => join(libDir, name)),
  ];

  it('recorre lo que dice recorrer', () => {
    for (const p of SCANNED) expect(existsSync(join(SRC_DIR, p)), p).toBe(true);
    const rels = files.map(toRel);
    expect(rels).toContain('app/login/login-state.ts');
    expect(rels).toContain('app/(app)/admin/usuarios/_components/member-list.tsx');
    expect(rels).toContain('lib/tenant-admin-team.ts');
    expect(rels).toContain(
      'app/(app)/admin/plataforma/usuarios/_components/platform-users-panel.tsx',
    );
    expect(rels.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('ningún archivo usa voseo', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = toRel(file);
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
    expect(voseoIn('Vos')).toEqual(['Vos']);
    expect(voseoIn('Si no fuiste vos, cambiá tu contraseña.')).toEqual(['vos', 'cambiá']);
  });

  it('no confunde el tú, los futuros ni las palabras que contienen una forma', () => {
    expect(
      voseoIn('No puedes hacerlo: inténtalo de nuevo. Podrá elegir, estás a tiempo. Votos y usos.'),
    ).toEqual([]);
    expect(voseoIn('Tú')).toEqual([]);
  });

  it('la lista no tiene repetidas', () => {
    expect(new Set(VOSEO_WORDS).size).toBe(VOSEO_WORDS.length);
  });
});
