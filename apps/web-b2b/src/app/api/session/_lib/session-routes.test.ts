import { describe, expect, it } from 'vitest';
import {
  apiLogoutBody,
  clearSessionCookies,
  isRouterRequest,
  isSameOriginRequest,
  parseLogoutBody,
  parsePingBody,
  unauthorizedEndsSession,
} from './session-routes';

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.firma`;
}

function h(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('isSameOriginRequest: los POST de /api/session/* sólo desde el propio panel', () => {
  it('Sec-Fetch-Site same-origin pasa', () => {
    expect(isSameOriginRequest(h({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it.each(['same-site', 'cross-site', 'none'])('Sec-Fetch-Site %s no pasa', (site) => {
    expect(
      isSameOriginRequest(
        h({ 'sec-fetch-site': site, origin: 'https://app.test', host: 'app.test' }),
      ),
    ).toBe(false);
  });

  it('sin Sec-Fetch-Site: Origin contra el host', () => {
    expect(
      isSameOriginRequest(
        h({ origin: 'https://app.planetour.cloud', host: 'app.planetour.cloud' }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        h({
          origin: 'https://app.planetour.cloud',
          host: 'web-b2b:3001',
          'x-forwarded-host': 'app.planetour.cloud',
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        h({ origin: 'https://cert-app.planetour.cloud', host: 'app.planetour.cloud' }),
      ),
    ).toBe(false);
    expect(isSameOriginRequest(h({ origin: 'null', host: 'app.planetour.cloud' }))).toBe(false);
  });

  it('sin Sec-Fetch-Site ni Origin no es un navegador: pasa', () => {
    expect(isSameOriginRequest(h({ host: 'app.planetour.cloud' }))).toBe(true);
  });
});

describe('cuerpos', () => {
  it('ping: activo sólo con true', () => {
    expect(parsePingBody({ active: true })).toEqual({ active: true });
    expect(parsePingBody({ active: 'true' })).toEqual({ active: false });
    expect(parsePingBody(null)).toEqual({ active: false });
    expect(parsePingBody([true])).toEqual({ active: false });
  });

  it('logout: idle sólo con reason idle', () => {
    expect(parseLogoutBody({ reason: 'idle' })).toEqual({ idle: true });
    expect(parseLogoutBody({ reason: 'IDLE' })).toEqual({ idle: false });
    expect(parseLogoutBody(undefined)).toEqual({ idle: false });
    expect(apiLogoutBody(true)).toBe('{"reason":"idle"}');
    expect(apiLogoutBody(false)).toBe('{}');
  });
});

describe('clearSessionCookies', () => {
  it('borra la sesión y el tenant, NO el equipo de confianza', () => {
    const deleted: string[] = [];
    clearSessionCookies({ delete: (name: string) => deleted.push(name) });
    expect(deleted).toEqual(['st_session', 'st_tenant']);
    expect(deleted).not.toContain('st_trusted');
  });
});

describe('isRouterRequest', () => {
  it('reconoce el pedido del router de Next', () => {
    expect(isRouterRequest(h({ rsc: '1' }))).toBe(true);
    expect(isRouterRequest(h({}))).toBe(false);
  });
});

describe('unauthorizedEndsSession: qué 401 del ping termina la sesión', () => {
  const now = Date.parse('2026-09-29T15:00:00.000Z');
  const live = jwtWith({ exp: now / 1000 + 3600 });
  const expired = jwtWith({ exp: now / 1000 - 1 });

  it.each([
    'SESSION_IDLE',
    'SESSION_REPLACED',
    'SESSION_RELEASED',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'MFA_STEP_UP_REQUIRED',
  ])('con motivo %s, sí', (reason) => {
    expect(unauthorizedEndsSession(reason, live, now)).toBe(true);
  });

  it('sin motivo y con el token vigente, no: puede ser la base que no respondió', () => {
    expect(unauthorizedEndsSession(undefined, live, now)).toBe(false);
  });

  it('un motivo que no es de sesión tampoco alcanza', () => {
    expect(unauthorizedEndsSession('SOMETHING_ELSE', live, now)).toBe(false);
  });

  it('sin motivo pero con el token vencido por su exp, sí', () => {
    expect(unauthorizedEndsSession(undefined, expired, now)).toBe(true);
  });

  it('un token ilegible se da por vivo: decide el API con su motivo', () => {
    expect(unauthorizedEndsSession(undefined, 'no-es-un-jwt', now)).toBe(false);
  });
});
