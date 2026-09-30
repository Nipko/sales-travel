import { describe, expect, it } from 'vitest';
import { LOGIN_MESSAGES, type SeatsFull } from '../app/login/login-state';
import type { ApiResponse } from './api';
import {
  SWITCH_MESSAGES,
  afterSwitchRelease,
  classifySwitchResponse,
  initialSwitchSeatsState,
  isTenantId,
  switchResultFor,
} from './tenant-switch';

function json(status: number, body: unknown): ApiResponse {
  return { kind: 'json', status, body };
}

const SEATS_DETAILS = {
  tenantName: 'Consolidador Sur',
  limit: 3,
  inUse: 3,
  release: {
    token: 'permiso',
    sessions: [{ sessionId: 's1', name: 'Ana', email: 'ana@sur.co', lastSeenAt: null }],
  },
};

const SEATS: SeatsFull = {
  tenantName: 'Consolidador Sur',
  limit: 3,
  inUse: 3,
  release: {
    token: 'permiso',
    sessions: [
      {
        sessionId: 's1',
        name: 'Ana',
        email: 'ana@sur.co',
        tenantName: null,
        lastSeenAt: null,
        device: null,
        ip: null,
      },
    ],
  },
};

describe('classifySwitchResponse', () => {
  it('200: la sesión nueva con su vencimiento y su tenant', () => {
    const outcome = classifySwitchResponse(
      json(200, { token: 'tk', expiresAt: '2026-09-30T00:00:00Z', tenantId: 't2', role: 'admin' }),
    );
    expect(outcome).toEqual({
      kind: 'switched',
      auth: { token: 'tk', expiresAt: '2026-09-30T00:00:00Z', tenantId: 't2', trustedDevice: null },
    });
  });

  it('200 sin token no es un cambio', () => {
    expect(classifySwitchResponse(json(200, { ok: true })).kind).toBe('unexpected');
  });

  it('409 SEATS_FULL: el cupo, igual que en el login', () => {
    const outcome = classifySwitchResponse(
      json(409, { statusCode: 409, reason: 'SEATS_FULL', details: SEATS_DETAILS }),
    );
    expect(outcome).toEqual({ kind: 'seats', seats: SEATS });
  });

  it('otro 409 no se confunde con el cupo', () => {
    expect(classifySwitchResponse(json(409, { reason: 'OTRA_COSA' })).kind).toBe('unexpected');
  });

  it('403 TENANT_SUSPENDED vs. 403 sin membership', () => {
    expect(classifySwitchResponse(json(403, { reason: 'TENANT_SUSPENDED' })).kind).toBe(
      'suspended',
    );
    expect(classifySwitchResponse(json(403, { message: 'no active membership' })).kind).toBe(
      'forbidden',
    );
  });

  it('401: la sesión actual murió, con el motivo para el login', () => {
    expect(classifySwitchResponse(json(401, { reason: 'SESSION_IDLE' }))).toEqual({
      kind: 'session-ended',
      motivo: 'inactividad',
    });
    expect(classifySwitchResponse(json(401, {}))).toEqual({
      kind: 'session-ended',
      motivo: 'expirada',
    });
  });

  it('429, 5xx, sin respuesta y lo que no es JSON', () => {
    expect(classifySwitchResponse(json(429, {})).kind).toBe('rate-limited');
    expect(classifySwitchResponse(json(502, {})).kind).toBe('unavailable');
    expect(
      classifySwitchResponse({ kind: 'unreachable', status: 503, message: 'caído' }).kind,
    ).toBe('unavailable');
    expect(classifySwitchResponse({ kind: 'not-json', status: 400, message: 'html' }).kind).toBe(
      'unexpected',
    );
  });
});

describe('switchResultFor', () => {
  it('suspendida o sin acceso piden refrescar la lista; el resto no', () => {
    expect(switchResultFor({ kind: 'suspended' })).toEqual({
      kind: 'error',
      message: SWITCH_MESSAGES.suspended,
      refresh: true,
    });
    expect(switchResultFor({ kind: 'forbidden' })).toMatchObject({ refresh: true });
    expect(switchResultFor({ kind: 'rate-limited' })).toMatchObject({ refresh: false });
    expect(switchResultFor({ kind: 'unavailable' })).toMatchObject({ refresh: false });
    expect(switchResultFor({ kind: 'unexpected' })).toMatchObject({ refresh: false });
  });

  it('el cupo y el cierre de sesión pasan tal cual', () => {
    expect(switchResultFor({ kind: 'seats', seats: SEATS })).toEqual({
      kind: 'seats',
      seats: SEATS,
    });
    expect(switchResultFor({ kind: 'session-ended', motivo: 'otro-dispositivo' })).toEqual({
      kind: 'ended',
      motivo: 'otro-dispositivo',
    });
  });

  it('ningún mensaje repite el texto crudo de la API', () => {
    for (const message of Object.values(SWITCH_MESSAGES)) {
      expect(message).not.toMatch(/membership|tenant/i);
    }
  });
});

describe('isTenantId', () => {
  it('sólo un uuid llega a la API', () => {
    expect(isTenantId('3f2b8c1e-5d4a-4c3b-9a8e-7f6d5c4b3a21')).toBe(true);
    expect(isTenantId('../admin')).toBe(false);
    expect(isTenantId(42)).toBe(false);
  });
});

describe('cupo lleno dentro del selector', () => {
  const LISTED_AT = 1_000_000;
  const NOW = 1_120_000;
  const ctx = { attempt: 2, seats: SEATS, listedAt: LISTED_AT };

  it('arranca en el paso de cupo del login, sin email y con la hora de la lista', () => {
    expect(initialSwitchSeatsState(SEATS, NOW)).toEqual({
      step: 'seats',
      attempt: 0,
      email: '',
      seats: SEATS,
      listedAt: NOW,
    });
  });

  it('alguien ocupó el puesto antes: la lista nueva, medida desde que llegó, con aviso', () => {
    const fresh = { ...SEATS, inUse: 3 };
    expect(afterSwitchRelease({ kind: 'seats', seats: fresh }, ctx, NOW)).toEqual({
      step: 'seats',
      attempt: 2,
      email: '',
      seats: fresh,
      listedAt: NOW,
      notice: LOGIN_MESSAGES.seatsTakenAgain,
    });
  });

  it('permiso vencido o sesión que ya no estaba: volver a elegir la agencia', () => {
    expect(afterSwitchRelease({ kind: 'release-invalid' }, ctx)).toEqual({
      step: 'retry',
      attempt: 2,
      message: SWITCH_MESSAGES.releaseExpired,
    });
    expect(afterSwitchRelease({ kind: 'release-session-gone' }, ctx)).toMatchObject({
      step: 'retry',
      message: SWITCH_MESSAGES.releaseSessionGone,
    });
  });

  it('dejó de administrar el nodo: la pantalla de quien no puede liberar', () => {
    const state = afterSwitchRelease({ kind: 'release-forbidden' }, ctx);
    expect(state).toMatchObject({ step: 'seats', error: LOGIN_MESSAGES.releaseForbidden });
    expect(state.step === 'seats' && state.seats.release).toBeNull();
  });

  it('errores de red: se queda en la lista con el error', () => {
    expect(afterSwitchRelease({ kind: 'unavailable' }, ctx, NOW)).toMatchObject({
      step: 'seats',
      error: LOGIN_MESSAGES.unavailable,
      seats: SEATS,
      // La misma lista: conserva su hora.
      listedAt: LISTED_AT,
    });
    expect(afterSwitchRelease({ kind: 'rate-limited' }, ctx)).toMatchObject({
      error: LOGIN_MESSAGES.rateLimited,
    });
    expect(afterSwitchRelease({ kind: 'unexpected' }, ctx)).toMatchObject({
      error: SWITCH_MESSAGES.unexpected,
    });
  });
});
