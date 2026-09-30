import { describe, expect, it } from 'vitest';
import { proxySecretMatches, resolveClientOrigin } from './client-origin.js';

const SECRET = 'a'.repeat(64);

/** Un request del panel: IP del contenedor web, user-agent de Node y lo que vio del navegador. */
function fromPanel(presented: string | undefined, extra: Record<string, string> = {}) {
  return {
    ip: '172.18.0.5',
    headers: {
      'user-agent': 'node',
      'x-client-ip': '172.68.10.1|190.24.8.9',
      'x-client-user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
      ...(presented === undefined ? {} : { 'x-internal-proxy': presented }),
      ...extra,
    },
  };
}

describe('resolveClientOrigin', () => {
  it('con el secreto correcto confía en los x-client-*: IP del usuario y clave propia', () => {
    expect(resolveClientOrigin(fromPanel(SECRET), SECRET)).toEqual({
      ip: '190.24.8.9',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/129',
      trackerKey: '172.68.10.1|190.24.8.9',
      viaInternalProxy: true,
    });
  });

  it('una sola IP en x-client-ip también sirve', () => {
    const origin = resolveClientOrigin(fromPanel(SECRET, { 'x-client-ip': '190.24.8.9' }), SECRET);
    expect(origin).toMatchObject({ ip: '190.24.8.9', trackerKey: '190.24.8.9' });
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

  it('directo: combina X-Edge-Peer-IP con CF-Connecting-IP, como el throttler de siempre', () => {
    const origin = resolveClientOrigin(
      {
        ip: '10.0.0.2',
        headers: { 'x-edge-peer-ip': '172.70.1.1', 'cf-connecting-ip': '190.24.8.9' },
      },
      SECRET,
    );
    expect(origin.trackerKey).toBe('172.70.1.1|190.24.8.9');
    expect(origin.viaInternalProxy).toBe(false);
  });

  it('directo: descarta cabeceras que no son IP', () => {
    const origin = resolveClientOrigin(
      { ip: '10.0.0.2', headers: { 'x-edge-peer-ip': 'basura', 'cf-connecting-ip': '1.2.3' } },
      SECRET,
    );
    expect(origin.trackerKey).toBe('10.0.0.2');
  });

  it('sin nada identificable la clave es "unknown", no undefined', () => {
    expect(resolveClientOrigin({}, SECRET).trackerKey).toBe('unknown');
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
