import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * El api cree la IP que Caddy le pone en `X-Edge-Peer-IP` (client-origin.ts). Que esa IP sea la del
 * usuario depende del Caddyfile, que no corre en ningún test: se vigila como texto, igual que el
 * cableado de INTERNAL_PROXY_SECRET (internal-proxy-wiring.guard.test.ts).
 *
 * El error que motivó esto: `header_up -X-Edge-Peer-IP` seguido de `header_up X-Edge-Peer-IP ...`.
 * Caddy aplica primero lo que escribe y DESPUÉS lo que borra (HeaderOps.ApplyTo en
 * modules/caddyhttp/headers/headers.go), así que la cabecera no llegaba nunca y el panel no podía
 * reenviar ninguna IP: todo el panel contaba como UN cliente para el throttler.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..');
const CADDYFILE = readFileSync(join(RAIZ, 'infrastructure', 'hostinger', 'Caddyfile'), 'utf8');
const COMPOSE = readFileSync(
  join(RAIZ, 'infrastructure', 'hostinger', 'docker-compose.prod.yml'),
  'utf8',
);
const DEPLOY = readFileSync(join(RAIZ, '.github', 'workflows', 'deploy.yml'), 'utf8');

/**
 * https://www.cloudflare.com/ips-v4 y https://www.cloudflare.com/ips-v6 al 2026-09-29, en ese
 * orden. Cuando Cloudflare los cambie se actualizan acá y en `trusted_proxies` del Caddyfile
 * (infrastructure/hostinger/README.md §10.2). SÓLO lo que publican esas dos listas: una IP de
 * Cloudflare que no esté en ellas (104.28.x de WARP o iCloud Private Relay) es de un usuario, y
 * confiar en ella le dejaría inventar CF-Connecting-IP llegando directo al origen.
 */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** Líneas de configuración: sin comentarios (un `#` al principio o tras un espacio) ni vacías. */
function configLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** Un bloque abre con un `{` suelto al final de la línea; `{client_ip}` es un placeholder. */
function opensBlock(line: string): boolean {
  return line === '{' || line.endsWith(' {');
}

interface Block {
  head: string;
  body: string[];
}

/** Los bloques cuya cabecera casa con `head`, con todo lo que tienen dentro (sin la llave final). */
function blocksOf(lines: readonly string[], head: RegExp): Block[] {
  const found: Block[] = [];
  lines.forEach((line, start) => {
    if (!head.test(line) || !opensBlock(line)) return;
    const body: string[] = [];
    let depth = 1;
    for (const inner of lines.slice(start + 1)) {
      if (inner === '}' && --depth === 0) break;
      if (opensBlock(inner)) depth++;
      body.push(inner);
    }
    found.push({ head: line, body });
  });
  return found;
}

/** Los snippets `(nombre) { ... }` por nombre. */
function snippets(lines: readonly string[]): Map<string, string[]> {
  return new Map(
    blocksOf(lines, /^\([a-z0-9_-]+\) \{$/).map((block) => [
      /^\(([^)]+)\)/.exec(block.head)?.[1] ?? '',
      block.body,
    ]),
  );
}

/** Reemplaza cada `import <snippet>` por su contenido, como hace Caddy antes de parsear. */
function expandImports(lines: readonly string[]): string[] {
  const defined = snippets(lines);
  return lines.flatMap((line) => {
    const name = /^import (\S+)$/.exec(line)?.[1];
    return name !== undefined && defined.has(name) ? (defined.get(name) ?? []) : [line];
  });
}

const CONFIG = configLines(CADDYFILE);
const EXPANDED = expandImports(CONFIG);
/** Los `reverse_proxy` de los sitios vivos, con sus `import` ya resueltos. */
const PROXIES = blocksOf(EXPANDED, /^reverse_proxy\s/);

/** Los `header_up` de un bloque: nombre de la cabecera (en minúsculas) y si la borra. */
function headerUps(block: Block): { name: string; deletes: boolean; line: string }[] {
  return block.body
    .filter((line) => line.startsWith('header_up '))
    .map((line) => {
      const field = line.split(/\s+/)[1] ?? '';
      const deletes = field.startsWith('-');
      return { name: field.replace(/^[-+]/, '').toLowerCase(), deletes, line };
    });
}

function argumentsOf(directive: string): string[] {
  const lines = CONFIG.filter((line) => line.split(/\s+/)[0] === directive);
  expect(lines, `el Caddyfile tiene que tener UN \`${directive}\``).toHaveLength(1);
  return (lines[0] ?? '').split(/\s+/).slice(1);
}

describe('Caddyfile: la IP del usuario la resuelve Caddy', () => {
  it('cree CF-Connecting-IP sólo desde los rangos de Cloudflare, sin rangos privados', () => {
    const [source, ...ranges] = argumentsOf('trusted_proxies');
    expect(source).toBe('static');
    expect(ranges).toEqual(CLOUDFLARE_RANGES);
    // El docker-proxy de la IPv6 del VPS conecta desde la red privada de Docker: confiar en ella
    // dejaría inventar CF-Connecting-IP a quien llegue directo al origen por IPv6.
    expect(ranges).not.toContain('private_ranges');
  });

  it('la IP sale de CF-Connecting-IP (una IP que Cloudflare pisa), no de X-Forwarded-For', () => {
    expect(argumentsOf('client_ip_headers')).toEqual(['CF-Connecting-IP']);
  });

  it('sin trusted_proxies_strict: saltaría la IP de los Workers y volvería al borde que rota', () => {
    expect(CONFIG.some((line) => line.startsWith('trusted_proxies_strict'))).toBe(false);
  });

  it('los tres sitios vivos llegan a su upstream por reverse_proxy', () => {
    expect(PROXIES.map((block) => block.head)).toEqual([
      'reverse_proxy api:3000 {',
      'reverse_proxy web-b2b:3001 {',
      'reverse_proxy cert-web-b2b:3001 {',
    ]);
  });

  it.each(PROXIES.map((block) => [block.head, block] as const))(
    '%s manda la IP que resolvió Caddy y escribe las X-Forwarded-* como antes',
    (_head, block) => {
      expect(block.body).toEqual(
        expect.arrayContaining([
          'header_up X-Edge-Peer-IP {client_ip}',
          'header_up X-Real-IP {client_ip}',
          'header_up X-Forwarded-For {client_ip}',
          'header_up X-Forwarded-Host {hostport}',
          'header_up X-Forwarded-Proto {scheme}',
        ]),
      );
    },
  );

  it.each(PROXIES.map((block) => [block.head, block] as const))(
    '%s borra las cabeceras con las que el panel habla con el api',
    (_head, block) => {
      const deleted = headerUps(block)
        .filter((op) => op.deletes)
        .map((op) => op.name);
      expect(deleted).toEqual(
        expect.arrayContaining(['x-internal-proxy', 'x-client-ip', 'x-client-user-agent']),
      );
    },
  );

  it.each(PROXIES.map((block) => [block.head, block] as const))(
    '%s no borra ninguna cabecera que también escribe (el borrado corre después y gana)',
    (_head, block) => {
      const ops = headerUps(block);
      const written = new Set(ops.filter((op) => !op.deletes).map((op) => op.name));
      expect(ops.filter((op) => op.deletes && written.has(op.name)).map((op) => op.line)).toEqual(
        [],
      );
    },
  );

  it('ninguna línea, tampoco comentada, borra X-Edge-Peer-IP ni usa {remote_host} hacia arriba', () => {
    expect(CADDYFILE).not.toMatch(/header_up\s+-X-Edge-Peer-IP/i);
    expect(CADDYFILE).not.toMatch(/header_up\s+\S+\s+\{remote_host\}/);
  });

  it('las plantillas comentadas (B2C, superadmin, white-label) también importan client_origin', () => {
    const raw = CADDYFILE.split(/\r?\n/);
    const templates = raw.flatMap((line, i) =>
      /^#\s*reverse_proxy\s.*\{$/.test(line) ? [[line, raw[i + 1] ?? ''] as const] : [],
    );
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const [head, next] of templates) {
      expect(next, head).toMatch(/^#\s*import client_origin$/);
    }
  });

  it('el snippet se define antes del primer import (Caddy los resuelve en orden)', () => {
    const defined = CONFIG.indexOf('(client_origin) {');
    expect(defined).toBeGreaterThanOrEqual(0);
    expect(defined).toBeLessThan(CONFIG.indexOf('import client_origin'));
  });
});

describe('deploy.yml aplica el Caddyfile sin esperar a que se recree Caddy', () => {
  it('Caddy monta ./Caddyfile como archivo suelto en /etc/caddy/Caddyfile', () => {
    expect(COMPOSE).toMatch(/^\s+- \.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro\s*$/m);
  });

  it('rsync no reemplaza el Caddyfile montado: viaja como Caddyfile.next', () => {
    expect(DEPLOY).toContain(
      'cp infrastructure/hostinger/Caddyfile "$RUNNER_TEMP/stack/Caddyfile.next"',
    );
    expect(DEPLOY).not.toMatch(/^\s+infrastructure\/hostinger\/Caddyfile \\$/m);
  });

  it('lo valida, lo escribe encima del montado ANTES de `up` y después recarga', () => {
    // Antes de `up`: si el pull trajo otra imagen de Caddy, `up` lo recrea y tiene que arrancar
    // con el archivo que se validó en ella.
    const steps = [
      'caddy validate --adapter caddyfile --config - < Caddyfile.next',
      'cp -p Caddyfile Caddyfile.prev',
      'cat Caddyfile.next > Caddyfile',
      'up -d --remove-orphans',
      'caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile < /dev/null',
      'cat Caddyfile.prev > Caddyfile',
      'up -d --no-deps --force-recreate caddy',
    ].map((step) => [step, DEPLOY.indexOf(step)] as const);
    expect(steps.filter(([, index]) => index < 0).map(([step]) => step)).toEqual([]);
    const indexes = steps.map(([, index]) => index);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it('reintenta el reload antes de darlo por fallido (un Caddy recién recreado no escucha aún)', () => {
    const deploy = DEPLOY.replace(/\r\n/g, '\n');
    const loop = /for attempt in [\d ]+; do\n([\s\S]*?)\n\s*done\n/.exec(deploy);
    expect(loop, 'el reload va dentro de un bucle de reintentos').not.toBeNull();
    expect(loop?.[1]).toContain('caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile');
    expect(loop?.[1]).toContain('break');
    // El rollback va DESPUÉS del bucle, no en el primer intento fallido.
    expect(deploy.indexOf('cat Caddyfile.prev > Caddyfile')).toBeGreaterThan(
      (loop?.index ?? 0) + (loop?.[0].length ?? 0),
    );
  });

  it('un Caddyfile.prev de otro despliegue no se devuelve nunca', () => {
    expect(DEPLOY.indexOf('rm -f Caddyfile.prev')).toBeGreaterThanOrEqual(0);
    expect(DEPLOY.indexOf('rm -f Caddyfile.prev')).toBeLessThan(
      DEPLOY.indexOf('cp -p Caddyfile Caddyfile.prev'),
    );
  });

  it('avisa, sin bloquear, si los rangos de Cloudflare cambiaron', () => {
    const step = /- name: Cloudflare ranges vs trusted_proxies\n([\s\S]*?)\n\s*- name: /.exec(
      DEPLOY.replace(/\r\n/g, '\n'),
    )?.[1];
    expect(step, 'el job deploy compara trusted_proxies con la lista publicada').toBeDefined();
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('https://www.cloudflare.com/ips-v4');
    expect(step).toContain('https://www.cloudflare.com/ips-v6');
    expect(step).toContain("grep -m1 'trusted_proxies static' infrastructure/hostinger/Caddyfile");
    expect(step).toContain('::warning::');
  });
});
