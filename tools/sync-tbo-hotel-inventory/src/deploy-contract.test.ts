import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DB_ENV_VARIABLES } from './cli.js';
import { resolveSyncEnv, SYNC_ENV_VARIABLES, SYNC_SECRET_VARIABLES } from './env.js';

/**
 * Contrato entre la herramienta y su despliegue (09 PR-3.5; 05 §6.6). El contenedor no hereda el
 * `.env` del VPS: cada variable tiene que estar en tres sitios (el Zod de `env.ts`, el render del
 * `.env` en `deploy.yml` y los `-e` del workflow), y una que falte en uno de ellos llega vacía y la
 * herramienta corre con su valor por defecto sin avisar. Nada de esto lo ve el CI de otra forma: los
 * workflows no corren en un PR y el de sync nunca se ha disparado.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);

function repoFile(path: string): string {
  return readFileSync(new URL(path, REPO_ROOT), 'utf8').replace(/\r\n/g, '\n');
}

const SYNC_WORKFLOW = repoFile('.github/workflows/sync-tbo-hotel-inventory.yml');
const DEPLOY_WORKFLOW = repoFile('.github/workflows/deploy.yml');
const README = repoFile('tools/sync-tbo-hotel-inventory/README.md');

const TOOL = 'sync-tbo-hotel-inventory';

/**
 * Descarga de la imagen, parada del huérfano, `--kill-after=90s` y `docker stop --time 60`: lo que
 * el job puede tardar además de `RUN_GUARD_MINUTES` sin que GitHub lo corte a mitad de camino.
 */
const SHUTDOWN_MARGIN_MINUTES = 7;

/** El `.env` que `deploy.yml` escribe en el VPS: nombre → expresión. */
function renderedEnv(): Map<string, string> {
  const block = /cat > \.env <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(DEPLOY_WORKFLOW)?.[1];
  if (block === undefined) throw new Error('deploy.yml ya no renderiza el .env con cat <<EOF');
  const entries = new Map<string, string>();
  for (const line of block.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) entries.set(match[1], (match[2] ?? '').trim());
  }
  return entries;
}

/** Los `-e` del `docker create`: nombre → valor literal, o `undefined` si lo toma del entorno. */
function containerEnv(): Map<string, string | undefined> {
  const create = /docker create [\s\S]*?"\$IMAGE"\)/.exec(SYNC_WORKFLOW)?.[0];
  if (create === undefined)
    throw new Error('el workflow ya no crea el contenedor con docker create');
  const flags = new Map<string, string | undefined>();
  for (const match of create.matchAll(/-e ([A-Z][A-Z0-9_]*)(?:=(\S+))?/g)) {
    if (match[1] !== undefined) flags.set(match[1], match[2]);
  }
  return flags;
}

function numberAfter(pattern: RegExp, text: string): number {
  const raw = pattern.exec(text)?.[1];
  if (raw === undefined) throw new Error(`no se encontró ${String(pattern)}`);
  return Number(raw);
}

/** Campo de horas de un cron (`6-9`, `7,8`, `8`) → las horas. */
function cronHours(field: string): number[] {
  return field.split(',').flatMap((part) => {
    const [from, to] = part.split('-').map(Number);
    if (from === undefined || Number.isNaN(from)) throw new Error(`hora de cron inválida: ${part}`);
    const last = to ?? from;
    return Array.from({ length: last - from + 1 }, (_, i) => from + i);
  });
}

describe('variables: env.ts ↔ deploy.yml ↔ workflow', () => {
  it('el workflow pasa al contenedor cada variable que lee la herramienta, y ninguna desconocida', () => {
    const flags = containerEnv();
    for (const name of [...SYNC_ENV_VARIABLES, ...DB_ENV_VARIABLES]) {
      expect(flags.has(name), `falta -e ${name}`).toBe(true);
    }
    const unknown = [...flags.keys()].filter(
      (name) => name.startsWith('TBO_') && !SYNC_ENV_VARIABLES.includes(name),
    );
    expect(unknown).toEqual([]);
  });

  it('deploy.yml escribe en el .env todas las TBO_SYNC_* y ninguna otra TBO_ (D-TBO-03 A)', () => {
    // Sin variables de venta `TBO_*` en el despliegue: la cuenta de venta vive en la bóveda del
    // consolidador, sin fallback de plataforma. Las únicas son las del catálogo (D-TBO-04 A).
    const rendered = [...renderedEnv().keys()].filter((name) => name.startsWith('TBO_'));
    expect([...rendered].sort()).toEqual([...SYNC_ENV_VARIABLES].sort());
  });

  it('las variables vacías que deja deploy.yml sin vars configuradas valen su valor por defecto', () => {
    // El .env tiene `TBO_SYNC_X=''` para cada variable no configurada en GitHub, y `-e` la pasa como
    // cadena vacía, no como ausente: el default tiene que salir igual en los dos casos.
    const credentials = { TBO_SYNC_USERNAME: 'catalogo', TBO_SYNC_PASSWORD: 'Pa55-catalogo' };
    const blank = Object.fromEntries(SYNC_ENV_VARIABLES.map((name) => [name, '']));
    expect(resolveSyncEnv({ ...blank, ...credentials })).toEqual(resolveSyncEnv(credentials));
  });

  it('cada TBO_SYNC_* va entre comillas simples: un valor raro no rompe los otros syncs', () => {
    // Los tres workflows de sync hacen `set -euo pipefail; source .env`. Sin comillas, `CO, PE`
    // (que el Zod acepta) o una contraseña con `&` sale con 127 al leer el `.env` y deja en rojo
    // también el sync de Despegar y el de aeropuertos, no sólo éste.
    const rendered = renderedEnv();
    for (const name of SYNC_ENV_VARIABLES) {
      expect(rendered.get(name), `${name} sin comillas simples`).toMatch(/^'\$\{\{[^\n]*\}\}'$/);
    }
  });

  it('las credenciales salen sólo de secrets y no viajan en la línea de comandos del VPS', () => {
    const rendered = renderedEnv();
    const flags = containerEnv();
    for (const name of SYNC_SECRET_VARIABLES) {
      expect(rendered.get(name)).toBe(`'\${{ secrets.${name} }}'`);
      expect(flags.get(name), `-e ${name}=… quedaría visible en ps`).toBeUndefined();
    }
    expect(flags.get('PGPASSWORD'), '-e PGPASSWORD=… quedaría visible en ps').toBeUndefined();
  });

  it('ninguna línea del workflow imprime un valor de credencial', () => {
    expect(SYNC_WORKFLOW).not.toMatch(/set -x|set -o xtrace/);
    const echoes = SYNC_WORKFLOW.split('\n').filter((line) => /\becho\b/.test(line));
    for (const line of echoes) {
      expect(line).not.toMatch(/\$\{?(TBO_SYNC_|PGPASSWORD|POSTGRES_ADMIN_PASSWORD)/);
    }
  });

  it('el README documenta cada variable', () => {
    for (const name of SYNC_ENV_VARIABLES) expect(README).toContain(`\`${name}\``);
  });
});

describe('imagen y ejecución', () => {
  it('la fila de la matriz construye la imagen que el workflow descarga', () => {
    const rows = new Map(
      [...DEPLOY_WORKFLOW.matchAll(/name: ([\w-]+),?\s+dockerfile: ([\w./-]+)/g)].map(
        (match) => [match[1], match[2]] as const,
      ),
    );
    const dockerfile = rows.get(TOOL);
    expect(dockerfile).toBe(`tools/${TOOL}/Dockerfile`);
    expect(existsSync(new URL(dockerfile ?? '', REPO_ROOT))).toBe(true);

    const env = (name: string): string | undefined =>
      new RegExp(`^\\s+${name}: (\\S+)$`, 'm').exec(DEPLOY_WORKFLOW)?.[1];
    const image = `${env('REGISTRY')}/${env('IMAGE_OWNER')}/${env('IMAGE_PREFIX')}-${TOOL}:latest`;
    expect(SYNC_WORKFLOW).toContain(`IMAGE=${image}\n`);
  });

  it('sin credenciales sale con 0 antes de descargar la imagen, como el sync de Despegar', () => {
    const skip = SYNC_WORKFLOW.indexOf(
      'if [ -z "${TBO_SYNC_USERNAME:-}" ] || [ -z "${TBO_SYNC_PASSWORD:-}" ]; then',
    );
    const pull = SYNC_WORKFLOW.indexOf('docker pull');
    expect(skip).toBeGreaterThan(-1);
    expect(SYNC_WORKFLOW.slice(skip, pull)).toContain('exit 0');
    expect(skip).toBeLessThan(pull);
  });

  it('el tope del VPS deja terminar la corrida por defecto y cabe en el timeout del job', () => {
    const resolution = resolveSyncEnv({ TBO_SYNC_USERNAME: 'u', TBO_SYNC_PASSWORD: 'p' });
    if (resolution.kind !== 'run') throw new Error('esperaba run');
    const budgetMinutes = resolution.settings.maxDurationMs / 60_000;
    const guardMinutes = numberAfter(/RUN_GUARD_MINUTES=(\d+)/, SYNC_WORKFLOW);
    const jobMinutes = numberAfter(/timeout-minutes: (\d+)/, SYNC_WORKFLOW);

    // La herramienta se corta sola por presupuesto y E6 (sólo SQL) todavía corre después: el tope
    // del VPS no puede llegar antes, o cada corrida normal terminaría con SIGTERM.
    expect(guardMinutes).toBeGreaterThan(budgetMinutes);
    expect(guardMinutes + SHUTDOWN_MARGIN_MINUTES).toBeLessThanOrEqual(jobMinutes);
  });

  it('corre cada hora alrededor de las 08:00 UTC, fuera de la venta de CO, PE y BR (D-TBO-12 A)', () => {
    const crons = [...SYNC_WORKFLOW.matchAll(/cron: '(\S+) (\S+) \* \* \*'/g)];
    expect(crons.length).toBeGreaterThan(0);
    const hours = crons.flatMap((match) => cronHours(match[2] ?? ''));
    expect(hours.length).toBeGreaterThan(1);
    // 06:00 UTC es la 01:00 en Bogotá y Lima; 10:59 UTC, las 07:59 en São Paulo.
    for (const hour of hours) {
      expect(hour).toBeGreaterThanOrEqual(6);
      expect(hour).toBeLessThanOrEqual(10);
    }
  });

  it('una ejecución a la vez, sin cancelar la que está escribiendo', () => {
    expect(SYNC_WORKFLOW).toMatch(
      /concurrency:\n\s+group: sync-tbo-hotel-inventory\n\s+cancel-in-progress: false/,
    );
  });
});
