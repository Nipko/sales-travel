#!/usr/bin/env node
// Inventario de rutas de la API leído de los decoradores de cada controller (apps/api/src/**/*.controller.ts).
// Lo usa el arnés HTTP (apps/web-b2b/e2e/api) para la matriz endpoint × rol (TRV-01) y las pruebas de
// «sin sesión» (TRV-02). Uso: node tools/qa/rutas-api.mjs  →  apps/web-b2b/e2e/api/rutas.generated.json
//
// Lee decoradores, no ejecuta Nest: si alguien arma una ruta de otra forma (Reflect.metadata a mano, un
// decorador compuesto nuevo), no aparece aquí. Por eso el total se compara con el del plan (262) y la
// prueba TRV-02 falla si el inventario baja de golpe.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'apps/api/src');
const OUT = path.join(ROOT, 'apps/web-b2b/e2e/api/rutas.generated.json');
const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

const strArg = (s) => /\(\s*['"`]([^'"`]*)['"`]/.exec(s)?.[1] ?? '';

/** Junta decoradores que ocupan varias líneas (`@Throttle({\n ... })`) en una sola. */
function joinDecorators(lines) {
  const out = [];
  let buf = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (buf !== null) {
      buf += ' ' + line;
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (depth <= 0) {
        out.push(buf);
        buf = null;
      }
      continue;
    }
    if (line.startsWith('@')) {
      depth = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (depth > 0) buf = line;
      else out.push(line);
      continue;
    }
    out.push(line);
  }
  return out;
}

function flags(decorators) {
  const has = (re) => decorators.some((d) => re.test(d));
  const roles = decorators.map((d) => /^@Roles\(\.\.\.(\w+)\)/.exec(d)?.[1]).find(Boolean);
  return {
    public: has(/^@Public\(/),
    roles: roles ?? '',
    sale: has(/^@SalesOperation\(/),
    recentMfa: has(/^@RequireRecentMfa\(/),
    allowWithoutMfa: has(/^@AllowWithoutMfa\(/),
    superadmin: has(/^@UseGuards\([^)]*SuperadminGuard/),
    idempotent: has(/Idempotency/i),
  };
}

const rutas = [];
for (const file of walk(SRC)) {
  const lines = joinDecorators(readFileSync(file, 'utf8').split('\n'));
  let pending = [];
  let klass = null;
  for (const line of lines) {
    if (line.startsWith('@')) {
      pending.push(line);
      continue;
    }
    if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))
      continue;
    if (/^export class /.test(line)) {
      const ctrl = pending.find((d) => d.startsWith('@Controller('));
      klass = ctrl
        ? { base: strArg(ctrl), flags: flags(pending), name: /class (\w+)/.exec(line)[1] }
        : null;
      pending = [];
      continue;
    }
    const http = pending.find((d) => HTTP.some((m) => d.startsWith(`@${m}(`)));
    if (http && klass) {
      const method = /^@(\w+)\(/.exec(http)[1].toUpperCase();
      const sub = strArg(http);
      const p = ['/api', klass.base, sub].filter(Boolean).join('/').replace(/\/+/g, '/');
      const m = flags(pending);
      const c = klass.flags;
      rutas.push({
        method,
        path: p,
        controller: klass.name,
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        public: m.public || c.public,
        roles: m.roles || c.roles,
        sale: m.sale || c.sale,
        recentMfa: m.recentMfa || c.recentMfa,
        allowWithoutMfa: m.allowWithoutMfa || c.allowWithoutMfa,
        superadmin: m.superadmin || c.superadmin,
      });
    }
    pending = [];
  }
}

rutas.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
writeFileSync(OUT, JSON.stringify(rutas, null, 1) + '\n');
const count = (f) => rutas.filter(f).length;
console.log(
  `${rutas.length} rutas · públicas ${count((r) => r.public)} · venta ${count((r) => r.sale)} · ` +
    `superadmin ${count((r) => r.superadmin)} · MFA reciente ${count((r) => r.recentMfa)} · ` +
    `sin rol declarado ${count((r) => !r.public && !r.roles && !r.sale && !r.superadmin)}`,
);
