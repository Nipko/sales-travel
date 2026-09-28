import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * El kill-switch y los `opt-in` tienen que LLEGAR al contenedor `api` de producción.
 *
 * Hasta PR-0.6 no llegaban (gap G13): `deploy.yml` escribía `FLIGHT_PROVIDERS_OPT_IN`
 * en `.env`, pero `docker-compose.prod.yml` no tiene `env_file` y sólo pasa al servicio las
 * variables que lista una por una. El código leía una variable que en producción no existía y
 * nadie se enteraba: el síntoma de un kill-switch roto es que no apaga nada justo el día que se
 * necesita.
 *
 * Se leen los archivos como texto, sin parser de YAML, a propósito: lo que se vigila es una línea
 * que alguien puede borrar sin darse cuenta, y la forma de esa línea es fija.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSE = join(RAIZ, 'infrastructure', 'hostinger', 'docker-compose.prod.yml');
const DEPLOY = join(RAIZ, '.github', 'workflows', 'deploy.yml');

/** Variable → archivo de `apps/api/src` que la lee. Si el código la renombra, esto falla. */
const GOBIERNO: Readonly<Record<string, string>> = {
  PROVIDERS_DISABLED: join(__dirname, 'circuit-breaker.service.ts'),
  FLIGHT_PROVIDERS_OPT_IN: join(__dirname, '..', 'providers', 'providers.module.ts'),
  HOTEL_PROVIDERS_OPT_IN: join(__dirname, '..', 'providers', 'hotel-providers.module.ts'),
};

/** El bloque del servicio `api`: desde `  api:` hasta el siguiente servicio del mismo nivel. */
function servicioApi(compose: string): string {
  const lineas = compose.split(/\r?\n/);
  const inicio = lineas.findIndex((l) => l === '  api:');
  if (inicio === -1) throw new Error('docker-compose.prod.yml ya no tiene el servicio `api`');
  const fin = lineas.findIndex((l, i) => i > inicio && /^ {2}[a-z0-9-]+:\s*$/.test(l));
  return lineas.slice(inicio, fin === -1 ? undefined : fin).join('\n');
}

/** El `.env` que arma el paso "Render .env" del deploy. */
function envDelDeploy(deploy: string): string {
  const cuerpo = /cat > \.env <<EOF\r?\n([\s\S]*?)\r?\n\s*EOF/.exec(deploy)?.[1];
  if (cuerpo === undefined) throw new Error('deploy.yml ya no arma el .env con `cat > .env <<EOF`');
  return cuerpo;
}

describe('kill-switch y opt-in cableados hasta el contenedor `api` (G13)', () => {
  const api = servicioApi(readFileSync(COMPOSE, 'utf8'));
  const env = envDelDeploy(readFileSync(DEPLOY, 'utf8'));

  it.each(Object.entries(GOBIERNO))('%s: el código la lee', (variable, archivo) => {
    expect(readFileSync(archivo, 'utf8')).toContain(`process.env['${variable}']`);
  });

  it.each(Object.keys(GOBIERNO))('%s: docker-compose la pasa al servicio `api`', (variable) => {
    expect(api).toMatch(new RegExp(`^ {6}${variable}: \\$\\{${variable}(:-[^}]*)?\\}\\s*$`, 'm'));
  });

  it.each(Object.keys(GOBIERNO))('%s: deploy.yml la escribe en el .env', (variable) => {
    expect(env).toMatch(new RegExp(`^\\s+${variable}=`, 'm'));
  });

  it('el kill-switch no trae valor por defecto: vacío es "nada apagado"', () => {
    // Un default en el deploy apagaría un proveedor en cada despliegue sin que nadie lo pidiera.
    expect(env).toMatch(/^\s+PROVIDERS_DISABLED=\$\{\{ vars\.PROVIDERS_DISABLED \}\}\s*$/m);
    expect(api).toMatch(/^ {6}PROVIDERS_DISABLED: \$\{PROVIDERS_DISABLED:-\}\s*$/m);
  });
});
