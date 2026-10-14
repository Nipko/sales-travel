import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactPayload } from './redact-payload.js';

describe('redactPayload', () => {
  it('quita las claves sensibles a cualquier profundidad, también dentro de listas', () => {
    const payload = {
      orderId: 'o-1',
      status: 'confirmed',
      apiKey: 'k',
      nested: {
        client_secret: 's',
        deeper: { refreshToken: 't', reason: 'ok', 'x-api-key': 'k2' },
      },
      attempts: [
        { Authorization: 'Bearer x', step: 1 },
        { card: { number: '4111', brand: 'VI' }, cvv: '123', step: 2 },
      ],
      passwordHash: 'h',
    };

    expect(redactPayload(payload)).toEqual({
      orderId: 'o-1',
      status: 'confirmed',
      nested: { deeper: { reason: 'ok' } },
      attempts: [{ step: 1 }, { step: 2 }],
    });
  });

  it('pan sólo como palabra: se va cardPan o pan_number, se queda company', () => {
    expect(isSensitiveKey('pan')).toBe(true);
    expect(isSensitiveKey('PAN')).toBe(true);
    expect(isSensitiveKey('pan_number')).toBe(true);
    expect(isSensitiveKey('cardPan')).toBe(true);
    expect(isSensitiveKey('company')).toBe(false);
    expect(isSensitiveKey('expand')).toBe(false);
    expect(isSensitiveKey('companyName')).toBe(false);

    expect(redactPayload({ company: 'Planetour', pan: '4111', meta: { panNumber: '1' } })).toEqual({
      company: 'Planetour',
      meta: {},
    });
  });

  it('el resto de las claves de la lista', () => {
    for (const key of [
      'secret',
      'password',
      'passwd',
      'token',
      'api_key',
      'api-key',
      'apikey',
      'authorisation',
      'cvc',
      'cardBrand',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ['orderId', 'reason', 'provider', 'amountMinor', 'tenantId']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('ni el id de una sesión, ni claves privadas, cookies, códigos de recuperación u OTP', () => {
    for (const key of [
      'sessionId',
      'session_id',
      'replacedSessionIds',
      'privateKey',
      'private_key',
      'cookie',
      'setCookie',
      'recoveryCodes',
      'recovery_code',
      'otp',
      'totp',
      'otpauthUrl',
      'mfa_otp',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    // Conteos y marcas que sí sirven para investigar.
    for (const key of ['revokedSessions', 'sessionsRefreshed', 'footprint', 'credentialSource']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
    // auth.sessions.revoked_by_tenant_move: quién perdió la sesión queda, el id de la sesión no.
    expect(
      redactPayload({
        toParentId: 'p',
        sessions: [{ sessionId: 's-1', userId: 'u-1', tenantId: 't-1' }],
        replacedSessionIds: ['s-2'],
        revokedSessions: 2,
      }),
    ).toEqual({
      toParentId: 'p',
      sessions: [{ userId: 'u-1', tenantId: 't-1' }],
      revokedSessions: 2,
    });
  });

  it('no toca el original', () => {
    const payload = { token: 't', keep: { secret: 's' } };
    redactPayload(payload);
    expect(payload).toEqual({ token: 't', keep: { secret: 's' } });
  });

  it('un payload que no es un objeto sale vacío', () => {
    expect(redactPayload(null)).toEqual({});
    expect(redactPayload(undefined)).toEqual({});
    expect(redactPayload('texto')).toEqual({});
    expect(redactPayload(7)).toEqual({});
    expect(redactPayload([{ a: 1 }])).toEqual({});
  });

  it('corta lo que es más hondo que cualquier evento legítimo', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    let list: unknown[] = ['x'];
    for (let i = 0; i < 20; i += 1) {
      deep = { next: deep };
      list = [list];
    }
    const out = JSON.stringify(redactPayload({ deep, list }));
    expect(out).not.toContain('leaf');
    expect(out).not.toContain('"x"');
  });
});
