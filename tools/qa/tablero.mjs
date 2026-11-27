#!/usr/bin/env node
// Datos del tablero de QA. Une la DEFINICIÓN de cada caso (docs/qa/01-plan-pruebas-funcionales.md) con
// su ESTADO (docs/qa/estado.json) y escribe docs/qa/tablero/{casos,hallazgos,infra}.json, que son los
// archivos que se suben al tablero. Uso: node tools/qa/tablero.mjs [--check]
//
// --check: falla si estado.json nombra un caso, hallazgo o infra que el plan no tiene (un typo dejaría
// un caso «por crear» para siempre sin que nadie lo note).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = path.join(ROOT, 'docs/qa/01-plan-pruebas-funcionales.md');
const ESTADO = path.join(ROOT, 'docs/qa/estado.json');
const OUT = path.join(ROOT, 'docs/qa/tablero');

/**
 * Fases de un caso, en el orden en que avanza:
 * por_crear → (falla → corregido →) pasa. `parcial` = algo lo cubre pero no todo. `bloqueado` lo
 * calcula este script: falta la prueba y la infraestructura que necesita no está lista.
 */
const FASES = ['por_crear', 'bloqueado', 'parcial', 'falla', 'corregido', 'pasa'];
/** Dónde está el arreglo de un caso que falló: en la rama, probado en la Mac, o ya en el VPS. */
const ARREGLO = ['rama', 'mac', 'vps'];
const HALLAZGO = [
  'propuesta',
  'por_confirmar',
  'confirmado',
  'descartado',
  'corregido',
  'en_mac',
  'en_vps',
];
const INFRA = ['falta', 'en_curso', 'listo'];

/** Qué infraestructura necesita cada ola antes de poder escribir sus pruebas (plan §7). */
const NECESITA = { 2: ['INF-1'], 3: ['INF-3', 'INF-6'], 4: ['INF-4'], 5: ['INF-7'] };

const plain = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

function cells(line) {
  return line
    .slice(1, line.lastIndexOf('|'))
    .split('|')
    .map((c) => c.trim());
}

function parsePlan(md) {
  const areas = { TRV: 'Transversales' };
  const casos = [];
  const hallazgos = [];
  const infra = [];
  for (const line of md.split('\n')) {
    const area = /^### 5\.\d+ ([A-Z]{3}) · (.+)$/.exec(line);
    if (area) {
      areas[area[1]] = plain(area[2]).replace(/\s*\(.*\)$/, '');
      continue;
    }
    if (!line.startsWith('| ')) continue;
    const c = cells(line);
    const id = c[0] ?? '';
    if (/^[A-Z]{3}-\d{2}$/.test(id) && c.length === 6) {
      const [, caso, nivel, pri, ola, estado] = c;
      casos.push({
        id,
        area: id.slice(0, 3),
        caso: plain(caso),
        nivel: plain(nivel),
        prioridad: pri,
        ola: Number(ola),
        planEstado: estado,
      });
    } else if (/^QA-[HM]-\d{2}$/.test(id) && c.length === 5) {
      const [, grav, que, donde, caso] = c;
      hallazgos.push({
        id,
        gravedad: grav,
        que: plain(que),
        donde: plain(donde),
        casos: caso.split(',').map((s) => s.trim()),
      });
    } else if (/^INF-\d$/.test(id) && c.length === 4) {
      const [, que, desbloquea, ola] = c;
      infra.push({ id, que: plain(que), desbloquea: plain(desbloquea), ola: Number(ola) });
    }
  }
  return { areas, casos, hallazgos, infra };
}

function faseDesdePlan(simbolo) {
  if (simbolo === '✅') return 'pasa';
  if (simbolo === '🟡') return 'parcial';
  return 'por_crear';
}

function main() {
  const check = process.argv.includes('--check');
  const plan = parsePlan(readFileSync(PLAN, 'utf8'));
  const estado = JSON.parse(readFileSync(ESTADO, 'utf8'));
  const errores = [];

  const ids = new Set(plan.casos.map((c) => c.id));
  for (const id of Object.keys(estado.casos ?? {}))
    if (!ids.has(id)) errores.push(`caso ${id} no está en el plan`);
  for (const id of Object.keys(estado.hallazgos ?? {}))
    if (!plan.hallazgos.some((h) => h.id === id)) errores.push(`hallazgo ${id} no está en el plan`);
  for (const id of Object.keys(estado.infra ?? {}))
    if (!plan.infra.some((i) => i.id === id)) errores.push(`infra ${id} no está en el plan`);

  const infra = plan.infra.map((i) => {
    const e = estado.infra?.[i.id] ?? {};
    const est = e.estado ?? 'falta';
    if (!INFRA.includes(est)) errores.push(`infra ${i.id}: estado «${est}» inválido`);
    return { ...i, estado: est, nota: e.nota ?? '', donde: e.donde ?? '' };
  });
  const infraLista = new Set(infra.filter((i) => i.estado === 'listo').map((i) => i.id));

  const hallazgoDeCaso = new Map();
  for (const h of plan.hallazgos) for (const c of h.casos) hallazgoDeCaso.set(c, h.id);

  const casos = plan.casos.map((c) => {
    const e = estado.casos?.[c.id] ?? {};
    let fase = e.fase ?? faseDesdePlan(c.planEstado);
    if (!FASES.includes(fase)) errores.push(`caso ${c.id}: fase «${fase}» inválida`);
    if (e.arreglo && !ARREGLO.includes(e.arreglo))
      errores.push(`caso ${c.id}: arreglo «${e.arreglo}» inválido`);
    const faltan = (NECESITA[c.ola] ?? []).filter((inf) => !infraLista.has(inf));
    if (fase === 'por_crear' && faltan.length > 0) fase = 'bloqueado';
    return {
      id: c.id,
      area: c.area,
      areaNombre: plan.areas[c.area] ?? c.area,
      caso: c.caso,
      nivel: c.nivel,
      prioridad: c.prioridad,
      ola: c.ola,
      fase,
      arreglo: e.arreglo ?? '',
      bloqueadoPor: fase === 'bloqueado' ? faltan.join(' ') : '',
      hallazgo: e.hallazgo ?? hallazgoDeCaso.get(c.id) ?? '',
      prueba: e.prueba ?? '',
      nota: e.nota ?? '',
      fecha: e.fecha ?? '',
    };
  });

  const hallazgos = plan.hallazgos.map((h) => {
    const e = estado.hallazgos?.[h.id] ?? {};
    const est = e.estado ?? 'por_confirmar';
    if (!HALLAZGO.includes(est)) errores.push(`hallazgo ${h.id}: estado «${est}» inválido`);
    return {
      id: h.id,
      gravedad: h.gravedad,
      que: h.que,
      donde: h.donde,
      casos: h.casos.join(', '),
      estado: est,
      nota: e.nota ?? '',
      fecha: e.fecha ?? '',
    };
  });

  if (errores.length > 0) {
    console.error(errores.map((e) => `✗ ${e}`).join('\n'));
    if (check) process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });
  const write = (name, rows) =>
    writeFileSync(path.join(OUT, name), JSON.stringify(rows, null, 1) + '\n');
  write('casos.json', casos);
  write('hallazgos.json', hallazgos);
  write('infra.json', infra);

  const porFase = Object.fromEntries(
    FASES.map((f) => [f, casos.filter((c) => c.fase === f).length]),
  );
  console.log(
    `${casos.length} casos · ${hallazgos.length} hallazgos · ${infra.length} infra → docs/qa/tablero/`,
  );
  console.log(
    Object.entries(porFase)
      .map(([f, n]) => `${f} ${n}`)
      .join(' · '),
  );
}

main();
