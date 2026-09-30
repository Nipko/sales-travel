import { describe, expect, it } from 'vitest';
import {
  COOKIES_CLEARED_ON_LOGOUT,
  SESSION_FALLBACK_SECONDS,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_FALLBACK_SECONDS,
  sessionCookieMaxAge,
  trustedDeviceCookieMaxAge,
} from './session-cookies';

/*
 * La cookie de sesión vivía 7 días con un token de 12 h: el navegador seguía mandando un token
 * muerto y el panel quedaba abierto pero vacío. Ahora muere con el token.
 */

const NOW = Date.parse('2026-09-29T12:00:00.000Z');

describe('sessionCookieMaxAge', () => {
  it('dura hasta que vence el token (ISO o Date)', () => {
    expect(sessionCookieMaxAge('2026-09-30T00:00:00.000Z', NOW)).toBe(12 * 60 * 60);
    expect(sessionCookieMaxAge(new Date(NOW + 90 * 60 * 1000), NOW)).toBe(90 * 60);
  });

  it('sin vencimiento, o con uno ilegible, lo que dura un token: 12 h', () => {
    expect(SESSION_FALLBACK_SECONDS).toBe(12 * 60 * 60);
    expect(sessionCookieMaxAge(undefined, NOW)).toBe(SESSION_FALLBACK_SECONDS);
    expect(sessionCookieMaxAge(null, NOW)).toBe(SESSION_FALLBACK_SECONDS);
    expect(sessionCookieMaxAge('', NOW)).toBe(SESSION_FALLBACK_SECONDS);
    expect(sessionCookieMaxAge('mañana', NOW)).toBe(SESSION_FALLBACK_SECONDS);
  });

  it('un token ya vencido deja igual un minuto: el próximo request trae el motivo del 401', () => {
    expect(sessionCookieMaxAge('2026-09-29T11:00:00.000Z', NOW)).toBe(60);
  });

  it('una fecha absurda no deja una cookie eterna', () => {
    expect(sessionCookieMaxAge('2030-01-01T00:00:00.000Z', NOW)).toBe(24 * 60 * 60);
  });
});

describe('trustedDeviceCookieMaxAge', () => {
  it('dura hasta que vence el equipo de confianza', () => {
    expect(trustedDeviceCookieMaxAge(new Date(NOW + 30 * 24 * 60 * 60 * 1000), NOW)).toBe(
      30 * 24 * 60 * 60,
    );
  });

  it('sin vencimiento legible, 30 días', () => {
    expect(trustedDeviceCookieMaxAge(undefined, NOW)).toBe(TRUSTED_DEVICE_FALLBACK_SECONDS);
    expect(trustedDeviceCookieMaxAge('x', NOW)).toBe(TRUSTED_DEVICE_FALLBACK_SECONDS);
  });

  it('con techo de 90 días', () => {
    expect(trustedDeviceCookieMaxAge('2027-09-29T12:00:00.000Z', NOW)).toBe(90 * 24 * 60 * 60);
  });
});

describe('cerrar sesión', () => {
  it('borra la sesión y el tenant, pero no el equipo de confianza', () => {
    expect([...COOKIES_CLEARED_ON_LOGOUT].sort()).toEqual(['st_session', 'st_tenant']);
    expect(COOKIES_CLEARED_ON_LOGOUT).not.toContain(TRUSTED_DEVICE_COOKIE);
  });
});
