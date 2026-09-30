import { describe, expect, it } from 'vitest';
import {
  pickMfaView,
  recoveryCodesLow,
  sortSessions,
  sortTrustedDevices,
  toMfaStatus,
  toSessionRows,
  toTrustedDeviceRows,
  type SessionRow,
  type TrustedDeviceRow,
} from './security-model';

const CODES = ['AAAAA-11111', 'BBBBB-22222'];

const ON = { enabled: true, required: false };
const ON_REQUIRED = { enabled: true, required: true };
const OFF = { enabled: false, required: false };

describe('pickMfaView', () => {
  it('los códigos recién entregados se muestran aunque el servidor ya diga que el 2FA está activo', () => {
    // Regresión de recovery-codes-never-displayed: la rama "activo" le ganaba a la de códigos.
    expect(pickMfaView({ revealedCodes: CODES, status: ON, panel: null })).toBe('codes');
    expect(pickMfaView({ revealedCodes: CODES, status: ON_REQUIRED, panel: 'disable' })).toBe(
      'codes',
    );
    expect(pickMfaView({ revealedCodes: CODES, status: OFF, panel: null })).toBe('codes');
    expect(pickMfaView({ revealedCodes: CODES, status: null, panel: null })).toBe('codes');
  });

  it('sin 2FA, el enrolamiento (aunque haya un panel abierto de antes)', () => {
    expect(pickMfaView({ revealedCodes: null, status: OFF, panel: null })).toBe('enroll');
    expect(pickMfaView({ revealedCodes: null, status: OFF, panel: 'rotate' })).toBe('enroll');
  });

  it('sin saber el estado, ni enrolamiento ni paneles', () => {
    // Antes un GET /auth/mfa caído se pintaba como "Desactivada" con el botón "Activar".
    expect(pickMfaView({ revealedCodes: null, status: null, panel: null })).toBe('unavailable');
    expect(pickMfaView({ revealedCodes: null, status: null, panel: 'disable' })).toBe(
      'unavailable',
    );
  });

  it('con 2FA activo, el resumen o el panel que se abrió', () => {
    const base = { revealedCodes: null, status: ON };
    expect(pickMfaView({ ...base, panel: null })).toBe('enabled');
    expect(pickMfaView({ ...base, panel: 'rotate' })).toBe('rotate');
    expect(pickMfaView({ ...base, panel: 'regenerate' })).toBe('regenerate');
    expect(pickMfaView({ ...base, panel: 'disable' })).toBe('disable');
  });

  it('si el rol exige 2FA, "desactivar" no se abre', () => {
    expect(pickMfaView({ revealedCodes: null, status: ON_REQUIRED, panel: 'disable' })).toBe(
      'enabled',
    );
  });

  it('una lista vacía de códigos no tapa nada', () => {
    expect(pickMfaView({ revealedCodes: [], status: ON, panel: null })).toBe('enabled');
  });
});

describe('toMfaStatus', () => {
  it('lee el estado completo', () => {
    expect(
      toMfaStatus({
        enabled: true,
        recoveryCodesRemaining: 7,
        required: true,
        pendingEnrollment: true,
      }),
    ).toEqual({
      enabled: true,
      recoveryCodesRemaining: 7,
      required: true,
      pendingEnrollment: true,
    });
  });

  it('un API anterior sin required ni pendingEnrollment: false', () => {
    expect(toMfaStatus({ enabled: true, recoveryCodesRemaining: 10 })).toEqual({
      enabled: true,
      recoveryCodesRemaining: 10,
      required: false,
      pendingEnrollment: false,
    });
  });

  it('sin un `enabled` booleano el estado es desconocido, no "desactivada"', () => {
    expect(toMfaStatus(null)).toBeNull();
    expect(toMfaStatus('x')).toBeNull();
    expect(toMfaStatus([])).toBeNull();
    expect(toMfaStatus({ recoveryCodesRemaining: 3 })).toBeNull();
    expect(toMfaStatus({ enabled: 'true', recoveryCodesRemaining: -2 })).toBeNull();
  });

  it('valores raros en lo demás no rompen la pantalla', () => {
    expect(toMfaStatus({ enabled: false, recoveryCodesRemaining: -2 })).toEqual({
      enabled: false,
      recoveryCodesRemaining: 0,
      required: false,
      pendingEnrollment: false,
    });
    expect(
      toMfaStatus({ enabled: true, recoveryCodesRemaining: 2.5 })?.recoveryCodesRemaining,
    ).toBe(0);
  });
});

describe('recoveryCodesLow', () => {
  it('avisa con 3 o menos, sólo si el 2FA está activo', () => {
    expect(recoveryCodesLow({ enabled: true, recoveryCodesRemaining: 3 })).toBe(true);
    expect(recoveryCodesLow({ enabled: true, recoveryCodesRemaining: 0 })).toBe(true);
    expect(recoveryCodesLow({ enabled: true, recoveryCodesRemaining: 4 })).toBe(false);
    expect(recoveryCodesLow({ enabled: false, recoveryCodesRemaining: 0 })).toBe(false);
  });
});

describe('filas de sesiones y equipos', () => {
  it('descarta filas sin id y completa lo opcional', () => {
    const rows = toSessionRows([
      { id: 's1', lastSeenAt: '2026-09-29T10:00:00Z', ip: '', userAgent: null, current: true },
      { lastSeenAt: '2026-09-29T10:00:00Z' },
      'basura',
    ]);
    expect(rows).toEqual([
      {
        id: 's1',
        issuedAt: '2026-09-29T10:00:00Z',
        lastSeenAt: '2026-09-29T10:00:00Z',
        expiresAt: '2026-09-29T10:00:00Z',
        ip: null,
        userAgent: null,
        current: true,
      },
    ]);
    expect(toSessionRows({ not: 'an array' })).toEqual([]);
  });

  it('equipos: exige id, createdAt y expiresAt', () => {
    const rows = toTrustedDeviceRows([
      {
        id: 'd1',
        createdAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-10-01T00:00:00Z',
        ip: '203.0.113.7',
        userAgent: 'UA',
        current: true,
      },
      { id: 'd2', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'd1', lastUsedAt: '2026-09-01T00:00:00Z', current: true });
  });

  it('la actual primero y después la más reciente', () => {
    const s = (id: string, lastSeenAt: string, current = false): SessionRow => ({
      id,
      issuedAt: lastSeenAt,
      lastSeenAt,
      expiresAt: lastSeenAt,
      ip: null,
      userAgent: null,
      current,
    });
    const sorted = sortSessions([
      s('old', '2026-09-29T08:00:00Z'),
      s('me', '2026-09-29T07:00:00Z', true),
      s('new', '2026-09-29T09:00:00Z'),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['me', 'new', 'old']);

    const d = (id: string, lastUsedAt: string, current = false): TrustedDeviceRow => ({
      id,
      createdAt: lastUsedAt,
      lastUsedAt,
      expiresAt: lastUsedAt,
      ip: null,
      userAgent: null,
      current,
    });
    expect(
      sortTrustedDevices([
        d('a', '2026-09-01T00:00:00Z'),
        d('b', '2026-09-20T00:00:00Z'),
        d('me', '2026-08-01T00:00:00Z', true),
      ]).map((r) => r.id),
    ).toEqual(['me', 'b', 'a']);
  });
});
