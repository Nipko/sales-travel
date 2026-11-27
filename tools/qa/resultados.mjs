#!/usr/bin/env node
// Pasa el resultado de una corrida de Playwright al estado del tablero de QA (docs/qa/estado.json).
//
//   node tools/qa/resultados.mjs <resultados.json> --ambiente mac|vps|ci
//
// Cada test se nombra con el caso que cubre al principio («TRV-08 …») y, si confirma o descarta un
// hallazgo, con su id entre paréntesis («(QA-H-01)»). Con eso:
// - caso: todos sus tests pasan → `pasa`; alguno falla → `falla`. Si estado.json marca el caso con
//   `"cobertura": "parcial"` (los tests cubren sólo una parte), pasar lo deja en `parcial`.
//   Un caso que tenía `arreglo` y ahora pasa sube el arreglo al ambiente de la corrida.
// - hallazgo: su test falla → `confirmado`; pasa después de haber estado confirmado o corregido →
//   `en_mac` / `en_vps`; pasa sin haber fallado nunca → `descartado`.
// Después corre tools/qa/tablero.mjs para regenerar los datos del tablero.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESTADO = path.join(ROOT, 'docs/qa/estado.json');

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const ambiente = args[args.indexOf('--ambiente') + 1] ?? 'mac';
if (!archivo || !['mac', 'vps', 'ci'].includes(ambiente)) {
  console.error('uso: node tools/qa/resultados.mjs <resultados.json> --ambiente mac|vps|ci');
  process.exit(2);
}

const reporte = JSON.parse(readFileSync(archivo, 'utf8'));
const hoy = new Date().toISOString().slice(0, 10);

/** Recorre las suites del reporte JSON de Playwright y devuelve {titulo, archivo, ok}. */
function tests(suite, file, out = []) {
  for (const s of suite.suites ?? []) tests(s, s.file ?? file, out);
  for (const spec of suite.specs ?? []) {
    const resultados = (spec.tests ?? []).flatMap((t) => t.results ?? []);
    const ultimo = resultados[resultados.length - 1];
    if (!ultimo || ultimo.status === 'skipped') continue;
    out.push({ titulo: spec.title, archivo: spec.file ?? file, ok: ultimo.status === 'passed' });
  }
  return out;
}

const todos = (reporte.suites ?? []).flatMap((s) => tests(s, s.file));
const estado = JSON.parse(readFileSync(ESTADO, 'utf8'));
estado.casos ??= {};
estado.hallazgos ??= {};

const porCaso = new Map();
const porHallazgo = new Map();
for (const t of todos) {
  const caso = /^([A-Z]{3}-\d{2})\b/.exec(t.titulo)?.[1];
  if (caso) porCaso.set(caso, [...(porCaso.get(caso) ?? []), t]);
  for (const h of t.titulo.matchAll(/QA-H-\d{2}/g))
    porHallazgo.set(h[0], [...(porHallazgo.get(h[0]) ?? []), t]);
}

const cambios = [];
for (const [id, ts] of porCaso) {
  const prev = estado.casos[id] ?? {};
  const ok = ts.every((t) => t.ok);
  const fallan = ts.filter((t) => !t.ok).map((t) => t.titulo.replace(/^[A-Z]{3}-\d{2}\s*/, ''));
  let fase = ok ? (prev.cobertura === 'parcial' ? 'parcial' : 'pasa') : 'falla';
  const next = {
    ...prev,
    fase,
    prueba: [...new Set(ts.map((t) => `apps/web-b2b/e2e/${t.archivo}`))].join(', '),
    fecha: hoy,
    corrida: ambiente,
    ...(ok ? {} : { fallan: fallan.join(' · ') }),
  };
  if (ok) delete next.fallan;
  if (ok && prev.arreglo && ambiente !== 'ci') next.arreglo = ambiente;
  if (prev.fase !== next.fase) cambios.push(`${id}: ${prev.fase ?? '—'} → ${fase}`);
  estado.casos[id] = next;
}

for (const [id, ts] of porHallazgo) {
  const prev = estado.hallazgos[id] ?? {};
  const ok = ts.every((t) => t.ok);
  const antes = prev.estado ?? 'por_confirmar';
  let est;
  if (!ok) est = 'confirmado';
  else if (['confirmado', 'corregido', 'en_mac', 'en_vps'].includes(antes))
    est =
      ambiente === 'vps'
        ? 'en_vps'
        : ambiente === 'mac'
          ? 'en_mac'
          : antes === 'confirmado'
            ? 'corregido'
            : antes;
  else est = 'descartado';
  if (est !== antes) cambios.push(`${id}: ${antes} → ${est}`);
  estado.hallazgos[id] = { ...prev, estado: est, fecha: hoy };
}

estado.ultimaCorrida = {
  ambiente,
  fecha: new Date().toISOString(),
  tests: todos.length,
  fallan: todos.filter((t) => !t.ok).length,
};
writeFileSync(ESTADO, JSON.stringify(estado, null, 2) + '\n');
console.log(`${todos.length} tests (${todos.filter((t) => !t.ok).length} fallan) en ${ambiente}`);
console.log(cambios.length ? cambios.join('\n') : 'sin cambios de fase');
execFileSync(process.execPath, [path.join(ROOT, 'tools/qa/tablero.mjs')], { stdio: 'inherit' });
