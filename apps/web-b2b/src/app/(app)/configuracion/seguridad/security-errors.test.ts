import { describe, expect, it } from 'vitest';
import {
  attemptsLeftOf,
  failureFrom,
  failureMessage,
  sessionEndMotivo,
  UNREACHABLE_MESSAGE,
  type ApiFailure,
} from './security-errors';

describe('failureFrom', () => {
  it('toma estado, mensaje, reason y details del cuerpo del filtro de excepciones', () => {
    expect(
      failureFrom({
        kind: 'json',
        status: 401,
        body: {
          statusCode: 401,
          message: 'Código inválido',
          reason: 'MFA_CODE_INVALID',
          details: { attemptsLeft: 3 },
        },
      }),
    ).toEqual({
      status: 401,
      message: 'Código inválido',
      reason: 'MFA_CODE_INVALID',
      details: { attemptsLeft: 3 },
    });
  });

  it('un reason que no es máquina no pasa; mensajes en lista se unen', () => {
    expect(
      failureFrom({
        kind: 'json',
        status: 400,
        body: { message: ['a', 'b'], reason: 'texto libre del proveedor' },
      }),
    ).toEqual({ status: 400, message: 'a, b' });
  });

  it('sin respuesta, el mensaje de conexión', () => {
    expect(failureFrom({ kind: 'unreachable', status: 503, message: UNREACHABLE_MESSAGE })).toEqual(
      { status: 503, message: UNREACHABLE_MESSAGE },
    );
  });
});

describe('sessionEndMotivo', () => {
  const f = (status: number, reason?: string): ApiFailure => ({
    status,
    message: '',
    ...(reason ? { reason } : {}),
  });

  it('un 401 con motivo de sesión manda al login con su motivo', () => {
    expect(sessionEndMotivo(f(401, 'SESSION_REPLACED'))).toBe('otro-dispositivo');
    expect(sessionEndMotivo(f(401, 'SESSION_IDLE'))).toBe('inactividad');
    expect(sessionEndMotivo(f(401, 'SESSION_RELEASED'))).toBe('liberada');
    expect(sessionEndMotivo(f(401, 'SESSION_EXPIRED'))).toBe('expirada');
    expect(sessionEndMotivo(f(401, 'SESSION_REVOKED'))).toBe('cerrada');
    expect(sessionEndMotivo(f(401, 'MFA_STEP_UP_REQUIRED'))).toBe('cerrada');
  });

  it('un 401 sin motivo de sesión es un error del formulario (contraseña o código)', () => {
    expect(sessionEndMotivo(f(401))).toBeNull();
    expect(sessionEndMotivo(f(401, 'MFA_CODE_INVALID'))).toBeNull();
    expect(sessionEndMotivo(f(403, 'SESSION_REVOKED'))).toBeNull();
  });
});

describe('failureMessage', () => {
  it('reasons conocidos, con texto propio', () => {
    expect(
      failureMessage({ status: 401, message: 'x', reason: 'MFA_CODE_INVALID' }, 'code'),
    ).toMatch(/El código no es válido/);
    expect(
      failureMessage({ status: 403, message: 'x', reason: 'MFA_REQUIRED_BY_ROLE' }, 'other'),
    ).toMatch(/Tu rol exige/);
    expect(
      failureMessage({ status: 409, message: 'x', reason: 'MFA_ALREADY_ENABLED' }, 'other'),
    ).toMatch(/ya está activa/);
    // Lo que responde el API al cambiar de teléfono o desactivar con la contraseña o el código mal.
    expect(
      failureMessage({ status: 400, message: 'x', reason: 'MFA_REAUTH_INVALID' }, 'other'),
    ).toBe('La contraseña o el código no son correctos.');
  });

  it('400/401 sin reason: lo que pedía el formulario', () => {
    expect(failureMessage({ status: 401, message: 'Unauthorized' }, 'password')).toBe(
      'La contraseña actual no es correcta.',
    );
    expect(failureMessage({ status: 400, message: 'code must be…' }, 'code')).toMatch(
      /El código no es válido/,
    );
    expect(failureMessage({ status: 400, message: 'x' }, 'password-and-code')).toBe(
      'La contraseña o el código no son correctos.',
    );
  });

  it('throttle, permisos y fallas del servidor en castellano', () => {
    expect(failureMessage({ status: 429, message: 'Too Many Requests' }, 'code')).toMatch(
      /Demasiados intentos/,
    );
    expect(failureMessage({ status: 403, message: 'Forbidden resource' }, 'other')).toBe(
      'No tenés permiso para hacer esto.',
    );
    expect(failureMessage({ status: 500, message: 'db exploded' }, 'other')).toMatch(
      /No pudimos completar/,
    );
    expect(failureMessage({ status: 503, message: UNREACHABLE_MESSAGE }, 'other')).toBe(
      UNREACHABLE_MESSAGE,
    );
  });

  it('otros errores: el mensaje del API (ya humanizado por el filtro)', () => {
    expect(failureMessage({ status: 404, message: 'No existe la sesión' }, 'other')).toBe(
      'No existe la sesión',
    );
    expect(failureMessage({ status: 404, message: '' }, 'other')).toMatch(/No pudimos completar/);
  });
});

describe('attemptsLeftOf', () => {
  it('sólo un entero no negativo', () => {
    expect(attemptsLeftOf({ status: 401, message: '', details: { attemptsLeft: 2 } })).toBe(2);
    expect(attemptsLeftOf({ status: 401, message: '', details: { attemptsLeft: '2' } })).toBeNull();
    expect(attemptsLeftOf({ status: 401, message: '' })).toBeNull();
  });
});
