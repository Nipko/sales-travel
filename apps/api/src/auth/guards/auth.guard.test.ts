import { HttpStatus, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  requestContextStorage,
  type RequestContext,
} from '../../request-context/request-context.js';
import { SessionCheckUnavailableError, SessionInvalidError } from '../auth-errors.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { AuthGuard } from './auth.guard.js';

/**
 * Cómo rechaza AuthGuard un request sin usuario: con el motivo de sesión (401), sin motivo (401
 * genérico) o, si la base no respondió al validar, 503 con SESSION_CHECK_UNAVAILABLE para que el
 * panel reintente en vez de mandar al login.
 */

function reflectorWith(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === IS_PUBLIC_KEY ? isPublic : undefined),
  } as unknown as Reflector;
}

const ctx = {
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

function failureOf(context: RequestContext, isPublic = false): unknown {
  const guard = new AuthGuard(reflectorWith(isPublic));
  try {
    requestContextStorage.run(context, () => guard.canActivate(ctx));
  } catch (err) {
    return err;
  }
  return null;
}

describe('AuthGuard', () => {
  it('con usuario, pasa', () => {
    expect(failureOf({ userId: 'u1', sessionId: 's1' })).toBeNull();
  });

  it('una ruta pública pasa aunque la base no haya respondido', () => {
    expect(failureOf({ sessionCheckUnavailable: true }, true)).toBeNull();
  });

  it('si la base no respondió al validar la sesión: 503 con SESSION_CHECK_UNAVAILABLE', () => {
    const err = failureOf({ sessionCheckUnavailable: true });
    expect(err).toBeInstanceOf(SessionCheckUnavailableError);
    expect((err as SessionCheckUnavailableError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as SessionCheckUnavailableError).reason).toBe('SESSION_CHECK_UNAVAILABLE');
  });

  it('una sesión terminada: 401 con su motivo', () => {
    const err = failureOf({ authFailure: 'SESSION_IDLE' });
    expect(err).toBeInstanceOf(SessionInvalidError);
    expect((err as SessionInvalidError).getStatus()).toBe(401);
    expect((err as SessionInvalidError).reason).toBe('SESSION_IDLE');
  });

  it('sin bearer ni motivo: 401 genérico', () => {
    const err = failureOf({});
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(SessionInvalidError);
  });
});
