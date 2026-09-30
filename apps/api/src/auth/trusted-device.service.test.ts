import { describe, expect, it } from 'vitest';
import { hashDeviceToken, trustedDeviceUsable } from './trusted-device.service.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function device(createdDaysAgo: number, opts: { expiresInDays?: number; revoked?: boolean } = {}) {
  return {
    createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY),
    expiresAt: new Date(NOW.getTime() + (opts.expiresInDays ?? 20) * DAY),
    revokedAt: opts.revoked ? new Date(NOW.getTime() - DAY) : null,
  };
}

const OWNER = { passwordChangedAt: null, mfaEnabledAt: new Date(NOW.getTime() - 60 * DAY) };

describe('trustedDeviceUsable', () => {
  it('vigente, sin revocar y posterior a la contraseña y al MFA: vale', () => {
    expect(trustedDeviceUsable(device(5), OWNER, NOW)).toBe(true);
  });

  it('un cambio de contraseña posterior lo invalida, sin barrer la tabla', () => {
    const owner = { ...OWNER, passwordChangedAt: new Date(NOW.getTime() - 2 * DAY) };
    expect(trustedDeviceUsable(device(5), owner, NOW)).toBe(false);
    // Uno creado DESPUÉS del cambio sigue valiendo.
    expect(trustedDeviceUsable(device(1), owner, NOW)).toBe(true);
  });

  it('un re-enrolamiento de MFA posterior ("cambiar de teléfono") lo invalida', () => {
    const owner = { ...OWNER, mfaEnabledAt: new Date(NOW.getTime() - DAY) };
    expect(trustedDeviceUsable(device(5), owner, NOW)).toBe(false);
  });

  it('creado en el mismo instante que el cambio no vale', () => {
    const d = device(3);
    expect(trustedDeviceUsable(d, { ...OWNER, passwordChangedAt: d.createdAt }, NOW)).toBe(false);
  });

  it('vencido o revocado no vale', () => {
    expect(trustedDeviceUsable(device(40, { expiresInDays: -10 }), OWNER, NOW)).toBe(false);
    expect(trustedDeviceUsable(device(5, { expiresInDays: 0 }), OWNER, NOW)).toBe(false);
    expect(trustedDeviceUsable(device(5, { revoked: true }), OWNER, NOW)).toBe(false);
  });
});

describe('hashDeviceToken', () => {
  it('es sha256 hex en minúscula: lo único que acepta trusted_devices.token_hash', () => {
    expect(hashDeviceToken('token-de-prueba')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken('token-de-prueba')).toBe(hashDeviceToken('token-de-prueba'));
    expect(hashDeviceToken('otro')).not.toBe(hashDeviceToken('token-de-prueba'));
  });
});
