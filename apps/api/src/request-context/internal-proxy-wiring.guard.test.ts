import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `INTERNAL_PROXY_SECRET` tiene que llegar IGUAL al api y al panel de producción.
 *
 * Si falta en uno de los dos, nada se rompe a la vista: el api simplemente deja de creer la IP que
 * reenvía el panel y vuelve a ver a todos los usuarios con la IP del contenedor web (un solo cupo de
 * login para toda la plataforma, dispositivos iguales en "Seguridad"). Por eso se vigila el
 * cableado como el del kill-switch (search/kill-switch-wiring.guard.test.ts): como texto.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..');
const COMPOSE = readFileSync(
  join(RAIZ, 'infrastructure', 'hostinger', 'docker-compose.prod.yml'),
  'utf8',
);
const DEPLOY = readFileSync(join(RAIZ, '.github', 'workflows', 'deploy.yml'), 'utf8');

/** El bloque de un servicio: desde `  <nombre>:` hasta el siguiente servicio del mismo nivel. */
function servicio(nombre: string): string {
  const lineas = COMPOSE.split(/\r?\n/);
  const inicio = lineas.findIndex((l) => l === `  ${nombre}:`);
  if (inicio === -1)
    throw new Error(`docker-compose.prod.yml ya no tiene el servicio \`${nombre}\``);
  const fin = lineas.findIndex((l, i) => i > inicio && /^ {2}[a-z0-9-]+:\s*$/.test(l));
  return lineas.slice(inicio, fin === -1 ? undefined : fin).join('\n');
}

function envDelDeploy(): string {
  const cuerpo = /cat > \.env <<EOF\r?\n([\s\S]*?)\r?\n\s*EOF/.exec(DEPLOY)?.[1];
  if (cuerpo === undefined) throw new Error('deploy.yml ya no arma el .env con `cat > .env <<EOF`');
  return cuerpo;
}

describe('INTERNAL_PROXY_SECRET cableado hasta el api y el panel', () => {
  it('el api la lee', () => {
    expect(readFileSync(join(__dirname, 'client-origin.ts'), 'utf8')).toContain(
      `process.env['INTERNAL_PROXY_SECRET']`,
    );
  });

  it.each(['api', 'web-b2b'])('docker-compose la pasa al servicio `%s`', (nombre) => {
    expect(servicio(nombre)).toMatch(
      /^ {6}INTERNAL_PROXY_SECRET: \$\{INTERNAL_PROXY_SECRET(:-[^}]*)?\}\s*$/m,
    );
  });

  it('deploy.yml la escribe en el .env, derivada del JWT_SECRET y no de un secreto nuevo', () => {
    expect(envDelDeploy()).toMatch(/^\s+INTERNAL_PROXY_SECRET=\$\{INTERNAL_PROXY_SECRET\}\s*$/m);
    expect(DEPLOY).toMatch(
      /INTERNAL_PROXY_SECRET=\$\(printf 'internal-proxy:%s' "\$JWT_SECRET_FOR_PROXY" \| sha256sum \| cut -d' ' -f1\)/,
    );
    expect(DEPLOY).toContain('JWT_SECRET_FOR_PROXY: ${{ secrets.JWT_SECRET }}');
    expect(DEPLOY).not.toMatch(/secrets\.INTERNAL_PROXY_SECRET/);
  });
});
