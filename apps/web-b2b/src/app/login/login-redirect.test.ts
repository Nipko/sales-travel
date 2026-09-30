import { describe, expect, it } from 'vitest';
import { isTokenExpired, loginUrlFor, requestedPathOf, tokenExpiresAtMs } from './login-redirect';

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.firma`;
}

describe('loginUrlFor', () => {
  const at = (path: string) => new URL(path, 'https://panel.planetour.cloud');

  it('guarda la ruta y la query pedidas en ?next=', () => {
    const url = loginUrlFor(at('/reservas/123?tab=pagos'));
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('next')).toBe('/reservas/123?tab=pagos');
    expect(url.origin).toBe('https://panel.planetour.cloud');
  });

  it('al inicio no agrega next: ya es el destino por defecto', () => {
    expect(loginUrlFor(at('/')).search).toBe('');
  });

  it('descarta el _rsc de las navegaciones del cliente', () => {
    const url = loginUrlFor(at('/cotizaciones?_rsc=abc123&id=9'));
    expect(url.searchParams.get('next')).toBe('/cotizaciones?id=9');
    expect(loginUrlFor(at('/cotizaciones?_rsc=abc123')).searchParams.get('next')).toBe(
      '/cotizaciones',
    );
  });

  it('no arma un next que safeNextPath rechazaría', () => {
    expect(loginUrlFor(at('/login')).searchParams.has('next')).toBe(false);
  });

  it('agrega el motivo cuando lo hay', () => {
    const url = loginUrlFor(at('/hoteles'), { motivo: 'expirada' });
    expect(url.searchParams.get('motivo')).toBe('expirada');
    expect(url.searchParams.get('next')).toBe('/hoteles');
  });
});

describe('requestedPathOf', () => {
  const at = (path: string) => new URL(path, 'https://panel.planetour.cloud');

  it('ruta y query, sin los parámetros internos de Next', () => {
    expect(requestedPathOf(at('/reservas/123?tab=pagos'))).toBe('/reservas/123?tab=pagos');
    expect(requestedPathOf(at('/reservas/123?_rsc=x&tab=pagos'))).toBe('/reservas/123?tab=pagos');
    expect(requestedPathOf(at('/hoteles?_rsc=x'))).toBe('/hoteles');
    expect(requestedPathOf(at('/'))).toBe('/');
  });
});

describe('vencimiento del token', () => {
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  const inSeconds = (s: number) => Math.floor(now / 1000) + s;

  it('lee el exp sin verificar la firma', () => {
    expect(tokenExpiresAtMs(jwtWith({ exp: inSeconds(60) }))).toBe(inSeconds(60) * 1000);
  });

  it('vencido y vigente', () => {
    expect(isTokenExpired(jwtWith({ exp: inSeconds(-1) }), now)).toBe(true);
    expect(isTokenExpired(jwtWith({ exp: inSeconds(0) }), now)).toBe(true);
    expect(isTokenExpired(jwtWith({ exp: inSeconds(3600) }), now)).toBe(false);
  });

  it('lo que no se puede leer se da por vivo: decide la API', () => {
    for (const token of [
      '',
      'opaco',
      'a.b.c',
      'a.%%%.c',
      jwtWith({ sub: 'u' }),
      jwtWith({ exp: 'x' }),
    ]) {
      expect(isTokenExpired(token, now)).toBe(false);
    }
  });
});
