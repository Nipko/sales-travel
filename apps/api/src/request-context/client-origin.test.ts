import { describe, expect, it } from 'vitest';
import { proxySecretMatches, resolveClientOrigin } from './client-origin.js';

const SECRET = 'a'.repeat(64);

/** Un request del panel: IP del contenedor web, user-agent de Node y lo que vio del navegador. */
function fromPanel(presented: string | undefined, extra: Record<string, string> = {}) {
  return {
    ip: '172.18.0.5',
    headers: {
      'user-agent': 'node',
      'x-client-ip': '190.24.8.9',
      'x-client-user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
      ...(presented === undefined ? {} : { 'x-internal-proxy': presented }),
      ...extra,
    },
  };
}

/** Un request que llegó directo al api por Caddy: `req.ip` es Caddy en la red de Docker. */
function viaCaddy(headers: Record<string, string>) {
  return { ip: '172.18.0.2', headers: { 'user-agent': 'curl/8', ...headers } };
}

describe('resolveClientOrigin: por el panel', () => {
  it('con el secreto correcto confía en los x-client-*: IP del usuario y su clave', () => {
    expect(resolveClientOrigin(fromPanel(SECRET), SECRET)).toEqual({
      ip: '190.24.8.9',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
      trackerKey: '190.24.8.9',
      viaInternalProxy: true,
    });
  });

  it('el mismo usuario comparte cupo entre por el panel o directo al api', () => {
    const panel = resolveClientOrigin(fromPanel(SECRET), SECRET);
    const direct = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': '190.24.8.9' }), SECRET);
    expect(panel.trackerKey).toBe(direct.trackerKey);
    expect(panel.ip).toBe(direct.ip);
  });

  it('formato viejo `peer|cf` (panel anterior): vale sólo la primera, la que resolvió Caddy', () => {
    const origin = resolveClientOrigin(
      fromPanel(SECRET, { 'x-client-ip': '190.24.8.9|203.0.113.66' }),
      SECRET,
    );
    expect(origin).toMatchObject({ ip: '190.24.8.9', trackerKey: '190.24.8.9' });
  });

  it('formato viejo con la primera inválida: no cae a la segunda, que la elige quien llama', () => {
    const origin = resolveClientOrigin(
      fromPanel(SECRET, { 'x-client-ip': 'basura|203.0.113.66' }),
      SECRET,
    );
    expect(origin.ip).toBeUndefined();
    expect(origin.trackerKey).toBe('172.18.0.5');
  });

  it('rotar la segunda del formato viejo no abre cupo nuevo', () => {
    const keys = ['203.0.113.1', '203.0.113.2', '198.51.100.9'].map(
      (claimed) =>
        resolveClientOrigin(fromPanel(SECRET, { 'x-client-ip': `190.24.8.9|${claimed}` }), SECRET)
          .trackerKey,
    );
    expect(new Set(keys)).toEqual(new Set(['190.24.8.9']));
  });

  it('sin secreto configurado no confía nunca: todo como antes', () => {
    expect(resolveClientOrigin(fromPanel(SECRET), undefined)).toEqual({
      ip: '172.18.0.5',
      userAgent: 'node',
      trackerKey: '172.18.0.5',
      viaInternalProxy: false,
    });
  });

  it('con un secreto corto configurado tampoco (se adivina)', () => {
    const short = 'corto';
    expect(resolveClientOrigin(fromPanel(short), short).viaInternalProxy).toBe(false);
  });

  it('con un secreto incorrecto no confía: un cliente directo no se inventa la IP', () => {
    const origin = resolveClientOrigin(fromPanel('b'.repeat(64)), SECRET);
    expect(origin).toMatchObject({ ip: '172.18.0.5', userAgent: 'node', viaInternalProxy: false });
  });

  it('sin la cabecera del secreto no confía', () => {
    expect(resolveClientOrigin(fromPanel(undefined), SECRET).viaInternalProxy).toBe(false);
  });

  it('sin el secreto, x-client-ip no le gana a la IP que resolvió Caddy', () => {
    const origin = resolveClientOrigin(
      viaCaddy({ 'x-edge-peer-ip': '190.24.8.9', 'x-client-ip': '203.0.113.66' }),
      SECRET,
    );
    expect(origin).toMatchObject({ ip: '190.24.8.9', trackerKey: '190.24.8.9' });
  });

  it('del panel sin IP válida: no inventa una y cuenta contra el cupo del contenedor', () => {
    const origin = resolveClientOrigin(
      fromPanel(SECRET, { 'x-client-ip': 'no-es-una-ip', 'x-client-user-agent': '' }),
      SECRET,
    );
    expect(origin.ip).toBeUndefined();
    expect(origin.userAgent).toBeUndefined();
    expect(origin.trackerKey).toBe('172.18.0.5');
  });

  it('acota el user-agent a 512 caracteres', () => {
    const origin = resolveClientOrigin(
      fromPanel(SECRET, { 'x-client-user-agent': 'x'.repeat(2000) }),
      SECRET,
    );
    expect(origin.userAgent).toHaveLength(512);
  });
});

describe('resolveClientOrigin: directo al api por Caddy', () => {
  it('la IP y la clave son X-Edge-Peer-IP, la que resolvió Caddy', () => {
    expect(resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': '190.24.8.9' }), SECRET)).toEqual({
      ip: '190.24.8.9',
      userAgent: 'curl/8',
      trackerKey: '190.24.8.9',
      viaInternalProxy: false,
    });
  });

  it('rotar CF-Connecting-IP no cambia la clave ni la IP', () => {
    const origins = ['203.0.113.1', '203.0.113.2', '2001:db8::66'].map((claimed) =>
      resolveClientOrigin(
        viaCaddy({ 'x-edge-peer-ip': '198.51.100.7', 'cf-connecting-ip': claimed }),
        SECRET,
      ),
    );
    expect(new Set(origins.map((o) => o.trackerKey))).toEqual(new Set(['198.51.100.7']));
    expect(new Set(origins.map((o) => o.ip))).toEqual(new Set(['198.51.100.7']));
  });

  it('CF-Connecting-IP sola, sin X-Edge-Peer-IP, no se usa: queda req.ip', () => {
    const origin = resolveClientOrigin(viaCaddy({ 'cf-connecting-ip': '190.24.8.9' }), SECRET);
    expect(origin).toMatchObject({ ip: '172.18.0.2', trackerKey: '172.18.0.2' });
  });

  it('descarta cabeceras que no son IP y cae a req.ip', () => {
    for (const junk of ['basura', '1.2.3', '1.2.3.4, 5.6.7.8', '190.24.8.9|203.0.113.1', '']) {
      const origin = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': junk }), SECRET);
      expect(origin).toMatchObject({ ip: '172.18.0.2', trackerKey: '172.18.0.2' });
    }
  });

  it('sin nada identificable la clave es "unknown", no undefined', () => {
    expect(resolveClientOrigin({}, SECRET)).toEqual({
      trackerKey: 'unknown',
      viaInternalProxy: false,
    });
  });
});

describe('resolveClientOrigin: IPv6', () => {
  it('la IP se guarda entera; la clave es su red /64', () => {
    const origin = resolveClientOrigin(
      viaCaddy({ 'x-edge-peer-ip': '2800:e2:5c80:1a:3d1f:9b2e:47a0:c1d8' }),
      SECRET,
    );
    expect(origin.ip).toBe('2800:e2:5c80:1a:3d1f:9b2e:47a0:c1d8');
    expect(origin.trackerKey).toBe('2800:e2:5c80:1a::/64');
  });

  it('cambiar de dirección dentro del mismo /64 no abre cupo nuevo', () => {
    const keys = [
      '2800:e2:5c80:1a::1',
      '2800:e2:5c80:1a:ffff:ffff:ffff:fffe',
      '2800:E2:5C80:1A::9',
    ].map((ip) => resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': ip }), SECRET).trackerKey);
    expect(new Set(keys)).toEqual(new Set(['2800:e2:5c80:1a::/64']));
  });

  it('otro /64 es otro cupo', () => {
    const a = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': '2800:e2:5c80:1a::1' }), SECRET);
    const b = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': '2800:e2:5c80:1b::1' }), SECRET);
    expect(a.trackerKey).not.toBe(b.trackerKey);
  });

  it('`::` al principio, al medio y al final', () => {
    const key = (ip: string) =>
      resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': ip }), SECRET).trackerKey;
    expect(key('::1')).toBe('0:0:0:0::/64');
    expect(key('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(key('2001:db8:0:0:1::1')).toBe('2001:db8:0:0::/64');
  });

  it('por el panel, la misma regla: el usuario IPv6 comparte cupo panel/directo', () => {
    const panel = resolveClientOrigin(
      fromPanel(SECRET, { 'x-client-ip': '2800:e2:5c80:1a::abcd' }),
      SECRET,
    );
    const direct = resolveClientOrigin(
      viaCaddy({ 'x-edge-peer-ip': '2800:e2:5c80:1a::1234' }),
      SECRET,
    );
    expect(panel.ip).toBe('2800:e2:5c80:1a::abcd');
    expect(panel.trackerKey).toBe(direct.trackerKey);
  });

  it('la IPv4 mapeada es la misma IPv4: misma IP y misma clave', () => {
    for (const mapped of ['::ffff:190.24.8.9', '::FFFF:190.24.8.9', '0:0:0:0:0:ffff:be18:809']) {
      const origin = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': mapped }), SECRET);
      expect(origin).toMatchObject({ ip: '190.24.8.9', trackerKey: '190.24.8.9' });
    }
  });

  it('`req.ip` mapeado de Express (socket dual) también se escribe como IPv4', () => {
    const origin = resolveClientOrigin({ ip: '::ffff:172.18.0.5', headers: {} }, SECRET);
    expect(origin).toMatchObject({ ip: '172.18.0.5', trackerKey: '172.18.0.5' });
  });

  it('IPv4 embebida que no es mapeada (NAT64): IPv6 con su /64', () => {
    const origin = resolveClientOrigin(
      viaCaddy({ 'x-edge-peer-ip': '64:ff9b::190.24.8.9' }),
      SECRET,
    );
    expect(origin.ip).toBe('64:ff9b::190.24.8.9');
    expect(origin.trackerKey).toBe('64:ff9b:0:0::/64');
  });

  it('una zona (`%eth0`) no es una IP que Postgres acepte: se descarta', () => {
    const origin = resolveClientOrigin(viaCaddy({ 'x-edge-peer-ip': 'fe80::1%eth0' }), SECRET);
    expect(origin.ip).toBe('172.18.0.2');
  });
});

describe('proxySecretMatches', () => {
  it('compara sin importar el largo de lo presentado', () => {
    expect(proxySecretMatches(SECRET, SECRET)).toBe(true);
    expect(proxySecretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(proxySecretMatches('', SECRET)).toBe(false);
    expect(proxySecretMatches(undefined, SECRET)).toBe(false);
  });
});
