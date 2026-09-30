import { describe, expect, it } from 'vitest';
import type { ApiError } from '../../lib/api';
import { decideLayoutGate, mfaDemand, type ApiResult, type LayoutGateInputs } from './session-gate';

function ok(data: unknown): ApiResult {
  return { ok: true, data };
}

function fail(status: number, reason?: string): ApiResult {
  const error: ApiError = { status, message: 'x', ...(reason ? { reason } : {}) };
  return { ok: false, error };
}

function inputs(overrides: Partial<LayoutGateInputs> = {}): LayoutGateInputs {
  return {
    session: ok({ sessionId: 's-1', mfaVerified: false }),
    me: ok({ email: 'ana@agencia.test' }),
    memberships: ok([]),
    mfa: ok({ enabled: false, required: false, recoveryCodesRemaining: 0 }),
    ...overrides,
  };
}

describe('decideLayoutGate: el layout ya no dibuja un panel roto con la sesión muerta', () => {
  it('sesión sana y sin 2FA obligatorio: el panel', () => {
    expect(decideLayoutGate(inputs())).toEqual({ kind: 'shell' });
  });

  it.each([
    ['SESSION_IDLE', 'inactividad'],
    ['SESSION_REPLACED', 'otro-dispositivo'],
    ['SESSION_RELEASED', 'liberada'],
    ['SESSION_EXPIRED', 'expirada'],
    ['SESSION_REVOKED', 'cerrada'],
    ['MFA_STEP_UP_REQUIRED', 'cerrada'],
  ])('401 %s → termina con motivo %s', (reason, motivo) => {
    expect(decideLayoutGate(inputs({ me: fail(401, reason) }))).toEqual({ kind: 'end', motivo });
  });

  it('401 sin motivo (token vencido, API vieja) → expirada', () => {
    expect(decideLayoutGate(inputs({ memberships: fail(401) }))).toEqual({
      kind: 'end',
      motivo: 'expirada',
    });
  });

  it('entre varios 401, el que trae motivo de sesión', () => {
    const gate = decideLayoutGate(
      inputs({ me: fail(401), session: fail(401, 'SESSION_REPLACED'), mfa: fail(401) }),
    );
    expect(gate).toEqual({ kind: 'end', motivo: 'otro-dispositivo' });
  });

  it('un motivo que no es de sesión no se usa', () => {
    expect(decideLayoutGate(inputs({ me: fail(401, 'SOMETHING_ELSE') }))).toEqual({
      kind: 'end',
      motivo: 'expirada',
    });
  });

  it('el API caído no cierra la sesión: se dibuja el panel', () => {
    const down = fail(503);
    expect(decideLayoutGate({ session: down, me: down, memberships: down, mfa: down })).toEqual({
      kind: 'shell',
    });
  });

  it('403 MFA_ENROLLMENT_REQUIRED → enrolamiento', () => {
    expect(decideLayoutGate(inputs({ memberships: fail(403, 'MFA_ENROLLMENT_REQUIRED') }))).toEqual(
      { kind: 'mfa-enrollment' },
    );
  });

  it('el rol exige 2FA y no lo tiene → enrolamiento', () => {
    expect(
      decideLayoutGate(
        inputs({ mfa: ok({ enabled: false, required: true, pendingEnrollment: true }) }),
      ),
    ).toEqual({ kind: 'mfa-enrollment' });
  });

  it('el rol exige 2FA, lo tiene y la sesión lo pasó → panel', () => {
    expect(
      decideLayoutGate(
        inputs({
          mfa: ok({ enabled: true, required: true }),
          session: ok({ mfaVerified: true }),
        }),
      ),
    ).toEqual({ kind: 'shell' });
  });

  it('el rol exige 2FA, lo tiene pero ESTA sesión no pasó el código → volver a ingresar', () => {
    expect(
      decideLayoutGate(
        inputs({
          mfa: ok({ enabled: true, required: true }),
          session: ok({ mfaVerified: false }),
        }),
      ),
    ).toEqual({ kind: 'end', motivo: 'cerrada' });
  });

  it('sin el dato mfaVerified (API vieja) no se echa a nadie', () => {
    expect(
      decideLayoutGate(inputs({ mfa: ok({ enabled: true, required: true }), session: ok({}) })),
    ).toEqual({ kind: 'shell' });
  });

  it('2FA activo sin ser obligatorio y sesión sin verificar (equipo de confianza viejo): panel', () => {
    expect(
      decideLayoutGate(
        inputs({
          mfa: ok({ enabled: true, required: false }),
          session: ok({ mfaVerified: false }),
        }),
      ),
    ).toEqual({ kind: 'shell' });
  });

  it('sin `required` en la respuesta (API vieja) no hay enrolamiento forzado', () => {
    expect(decideLayoutGate(inputs({ mfa: ok({ enabled: false }) }))).toEqual({ kind: 'shell' });
  });

  it('con /auth/mfa caído, el estado del 2FA sale de /auth/session (lo mismo que mira la guardia)', () => {
    const session = ok({
      sessionId: 's-1',
      mfaRequired: true,
      mfaEnabled: false,
      mfaVerified: false,
    });
    expect(decideLayoutGate(inputs({ mfa: fail(503), session }))).toEqual({
      kind: 'mfa-enrollment',
    });
  });

  it('si /auth/mfa respondió, manda /auth/mfa', () => {
    const session = ok({ mfaRequired: true, mfaEnabled: false, mfaVerified: true });
    expect(
      decideLayoutGate(inputs({ mfa: ok({ enabled: true, required: true }), session })),
    ).toEqual({ kind: 'shell' });
  });

  it('la base no respondió al validar la sesión (503 con motivo): no es un cierre', () => {
    const unavailable = fail(503, 'SESSION_CHECK_UNAVAILABLE');
    expect(
      decideLayoutGate({
        session: unavailable,
        me: unavailable,
        memberships: unavailable,
        mfa: unavailable,
      }),
    ).toEqual({ kind: 'shell' });
  });
});

describe('mfaDemand: la regla del API, compartida por el layout y la guardia', () => {
  it.each([
    [{ required: true, enabled: false, verified: false }, 'enroll'],
    [{ required: true, enabled: undefined, verified: undefined }, 'enroll'],
    [{ required: true, enabled: true, verified: false }, 'step-up'],
    [{ required: true, enabled: true, verified: true }, null],
    [{ required: true, enabled: true, verified: undefined }, null],
    [{ required: false, enabled: false, verified: false }, null],
    [{ required: undefined, enabled: false, verified: false }, null],
    [{ required: 'true', enabled: false, verified: false }, null],
  ])('%o → %s', (state, demand) => {
    expect(mfaDemand(state)).toBe(demand);
  });
});
