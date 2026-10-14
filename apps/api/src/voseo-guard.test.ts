import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOSEO_WORDS, voseoIn } from './__fixtures__/voseo.js';

/*
 * Los mensajes del acceso, las invitaciones, Equipo, la consola del superadmin, Carteras y las
 * cuentas de proveedor salen de estas carpetas y llegan tal cual al panel y a los correos. Van en "tú" neutro (decisión del founder): este guarda falla con
 * archivo:línea si vuelve a entrar un voseo, en un texto o en un comentario que lo cite.
 *
 * Además del filtro global y del pipe de Zod: traducen el 401/403/429 y envuelven cada 400 de
 * validación, así que su texto también llega a /verificar, al alta por invitación y a Equipo.
 *
 * Los tests quedan afuera: arman nombres de nodo hostiles y otros textos de prueba a propósito.
 */

const SRC_DIR = __dirname;
/**
 * Carpetas y archivos sueltos que se recorren, relativos a `src/`. Los avisos de seguridad van por
 * archivo: el resto de `mail/` son correos al cliente final, fuera de esta decisión.
 */
const SCANNED = [
  'auth',
  'tenants',
  'zod',
  // Plataforma → Actividad y el historial de una persona (sus mensajes llegan al panel).
  'audit',
  // La consola del superadmin entera: Resumen, Agencias, Carteras, Reservas de la red y sus CSV.
  'admin-console',
  'all-exceptions.filter.ts',
  'mail/security-notices.ts',
  'mail/security-notice.service.ts',
  // La prueba de correo de Mi Red devuelve su motivo al panel.
  'mail/mailer.service.ts',
  // Carteras, permisos de reserva, conciliación, marca, bóveda de payloads y cuentas de proveedor:
  // sus 400/403/409 llegan tal cual a Carteras, Mi Red y la ficha de la agencia.
  'portfolios',
  'booking-permissions',
  'reconciliation',
  'storage',
  'provider-payloads',
  'provider-disclosure',
  'provider-credentials',
];

/**
 * Líneas que pueden llevar una de las palabras sin ser voseo (`archivo` relativo a `src/` con `/`,
 * y un fragmento de la línea). Cada entrada tiene que seguir haciendo falta.
 */
const ALLOWED: readonly { file: string; line: string }[] = [];

function isSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return isSource(path) ? [path] : [];
  return readdirSync(path).flatMap((name) => sources(join(path, name)));
}

function allowed(file: string, line: string): boolean {
  return ALLOWED.some((entry) => entry.file === file && line.includes(entry.line));
}

describe('los textos de las carpetas recorridas van en tú', () => {
  const files = SCANNED.flatMap((p) => sources(join(SRC_DIR, p)));

  it('recorre las carpetas de verdad', () => {
    for (const p of SCANNED) expect(existsSync(join(SRC_DIR, p)), p).toBe(true);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(`${sep}auth-errors.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}invitations.service.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}zod-validation.pipe.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}all-exceptions.filter.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}security-notices.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}portfolios.controller.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith(`${sep}provider-specs.ts`))).toBe(true);
  });

  it('ningún archivo recorrido usa voseo', () => {
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
