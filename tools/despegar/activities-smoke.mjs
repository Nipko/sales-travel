/**
 * Humo de la API de ACTIVIDADES de Despegar/HotelDO en sandbox (docs/despegar/03-actividades-api.md
 * § Revalidar). Sólo LEE: discovery → modalities → availability (una fecha) → shopping de Orlando.
 * No hace prebook ni book: no crea reservas.
 *
 *   node tools/despegar/activities-smoke.mjs
 *   node tools/despegar/activities-smoke.mjs --destination ORL --site br --distribution 2-7-1
 *   node tools/despegar/activities-smoke.mjs --save tmp/despegar-activities
 *
 * La clave se lee de `DESPEGAR_API_KEY` o de un `.env.local` (el de este checkout o el del checkout
 * principal, si esto corre en un worktree). NUNCA se imprime ni se guarda: las capturas de `--save`
 * llevan sólo los cuerpos de respuesta, para convertirlos en fixtures.
 *
 * Código de salida: 0 si todo respondió 2xx; 2 si la clave todavía no tiene acceso (403);
 * 1 ante cualquier otro error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** El checkout principal, si esto corre en un worktree (ahí vive el `.env.local`). */
function mainCheckout() {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ).trim();
    return dirname(common);
  } catch {
    return undefined;
  }
}

async function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
  return true;
}

function isoPlusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Lo que se muestra de un cuerpo: el `code` y el `message` de Despegar, recortados. El 403 trae el
 * id del cliente de la api (derivado de la clave, a medio enmascarar): se oculta entero.
 */
function errorSummary(text, apiKey) {
  let out;
  try {
    const o = JSON.parse(text);
    out = [o.code, o.message].filter(Boolean).join(': ') || text;
  } catch {
    out = text;
  }
  return out
    .split(apiKey)
    .join('[clave]')
    .replace(/api client \S+/gi, 'api client [oculto]')
    .slice(0, 200);
}

async function main() {
  const candidates = [resolve(root, '.env.local')];
  const main = mainCheckout();
  if (main && main !== root) candidates.push(resolve(main, '.env.local'));
  for (const c of candidates) if (await loadEnvFile(c)) break;

  const apiKey = (process.env.DESPEGAR_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('Falta DESPEGAR_API_KEY (en el entorno o en .env.local).');
    process.exit(1);
  }
  const base = (process.env.DESPEGAR_BASE_URL ?? 'https://api-dev.despegar.com/v3').replace(
    /\/$/,
    '',
  );
  if (!base.includes('api-dev.')) {
    console.error(
      `Este humo es para sandbox; la base es ${base}. Usa DESPEGAR_BASE_URL de sandbox.`,
    );
    process.exit(1);
  }
  const destination = arg('destination', 'ORL');
  const site = arg('site', 'br');
  const language = arg('language', 'es');
  const distribution = arg('distribution', '2-7-1');
  const saveDir = arg('save', undefined);
  console.log(
    `Sandbox ${base} · destino ${destination} · site ${site} · distribución ${distribution}`,
  );

  let forbidden = false;
  let failed = false;

  async function call(label, path, query) {
    const url = `${base}${path}?${new URLSearchParams(query)}`;
    const started = Date.now();
    let res;
    let text;
    try {
      res = await fetch(url, { headers: { 'x-apikey': apiKey, accept: 'application/json' } });
      text = await res.text();
    } catch (err) {
      failed = true;
      console.log(`✗ ${label}: sin respuesta (${err instanceof Error ? err.message : err})`);
      return undefined;
    }
    const ms = Date.now() - started;
    if (!res.ok) {
      if (res.status === 403) forbidden = true;
      else failed = true;
      console.log(`✗ ${label}: HTTP ${res.status} en ${ms} ms — ${errorSummary(text, apiKey)}`);
      return undefined;
    }
    console.log(`✓ ${label}: HTTP ${res.status} en ${ms} ms (${text.length} bytes)`);
    if (saveDir) {
      const file = resolve(root, saveDir, `${label}.json`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    try {
      return JSON.parse(text);
    } catch {
      failed = true;
      console.log(`  la respuesta de ${label} no es JSON`);
      return undefined;
    }
  }

  // 1. Discovery
  const discovery = await call('discovery', '/activities-api/discovery', {
    destination,
    site,
    language,
  });
  const groups = Array.isArray(discovery) ? discovery : discovery ? [discovery] : [];
  const items = groups.flatMap((g) => g.items ?? g.available_tickets ?? []);
  if (discovery) {
    console.log(
      `  ${items.length} actividades. Primeras: ${items
        .slice(0, 5)
        .map((i) => `${i.tracking_id} (${i.type})`)
        .join(', ')}`,
    );
  }

  // 2. Modalities de la primera (o de UN_ORL si no hubo discovery)
  const id = items[0]?.tracking_id ?? 'UN_ORL';
  const modalities = await call('modalities', '/activities-api/modalities', {
    id,
    site,
    language: language.toUpperCase(),
  });
  const modality = modalities?.modalities?.[0];
  if (modalities) {
    console.log(
      `  ${modalities.modalities?.length ?? 0} modalidades de ${id}. Tipo de hours[].hour: ${typeof modality?.available_dates?.[0]?.hours?.[0]?.hour}`,
    );
  }

  // 3. Availability de UNA fecha
  const date = modality?.available_dates?.[0]?.date ?? isoPlusDays(30);
  const availability = await call('availability', '/activities-api/availability', {
    id,
    modality: modality?.id ?? 'ORL_1P1D_EPIC',
    date,
    site,
    language,
    distribution,
  });
  if (availability) {
    const prices = (availability.price_details ?? [])
      .map((p) => `${p.currency} ${p.total}`)
      .join(' / ');
    console.log(
      `  ${date}: choice_id ${availability.choice_id ? 'presente' : 'AUSENTE'}, ${prices}, cancelable=${availability.cancellation_policy?.cancellable}`,
    );
  }

  // 4. Shopping de los parques de la certificación
  for (const park of ['UN_ORL', 'DY_ORL']) {
    const shopping = await call(`shopping-${park}`, '/activities-api/shopping', {
      id: park,
      site: site.toUpperCase(),
      language,
      from: isoPlusDays(30),
      distribution,
    });
    if (shopping) {
      const offers = (shopping[0]?.modalities ?? []).flatMap((m) => m.availabilities ?? []);
      console.log(
        `  ${park}: ${shopping[0]?.modalities?.length ?? 0} modalidades, ${offers.length} tarifas por día`,
      );
    }
  }

  if (forbidden) {
    console.log(
      '\nLa clave todavía NO tiene acceso a actividades (403). Pedirle a Despegar que lo habilite.',
    );
    process.exit(2);
  }
  if (failed) process.exit(1);
  console.log(
    '\nOK: la API de actividades responde. Siguiente paso: docs/despegar/03 § Revalidar, punto 3.',
  );
}

await main();
