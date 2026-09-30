import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import {
  requestContextStorage,
  type RequestContext,
} from '../../request-context/request-context.js';
import {
  MfaEnrollmentRequiredError,
  MfaStepUpRequiredError,
  SessionInvalidError,
} from '../auth-errors.js';
import { ALLOW_WITHOUT_MFA_KEY } from '../decorators/allow-without-mfa.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { AuthGuard } from './auth.guard.js';
import { MfaEnforcementGuard } from './mfa-enforcement.guard.js';

/** Reflector de mentira: devuelve la metadata que el test declare, sin Nest de por medio. */
function reflectorWith(meta: { isPublic?: boolean; allowWithoutMfa?: boolean }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return meta.isPublic;
      if (key === ALLOW_WITHOUT_MFA_KEY) return meta.allowWithoutMfa;
      return undefined;
    },
  } as unknown as Reflector;
}

const ctx = {
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

function run(
  guard: { canActivate(c: ExecutionContext): boolean },
  context: RequestContext,
): unknown {
  try {
    return requestContextStorage.run(context, () => guard.canActivate(ctx));
  } catch (err) {
    return err;
  }
}

const ADMIN_SIN_MFA: RequestContext = {
  userId: 'u-1',
  role: 'tenant_admin',
  mfaRequired: true,
  mfaEnabled: false,
  mfaVerified: false,
};

describe('MfaEnforcementGuard', () => {
  const guard = new MfaEnforcementGuard(reflectorWith({}));

  it('tenant_admin sin MFA → 403 MFA_ENROLLMENT_REQUIRED', () => {
    const err = run(guard, ADMIN_SIN_MFA);
    expect(err).toBeInstanceOf(MfaEnrollmentRequiredError);
    expect((err as MfaEnrollmentRequiredError).getStatus()).toBe(403);
    expect((err as MfaEnrollmentRequiredError).reason).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('con MFA activo pero una sesión sin segundo factor → 401 MFA_STEP_UP_REQUIRED', () => {
    const err = run(guard, { ...ADMIN_SIN_MFA, mfaEnabled: true, mfaVerified: false });
    expect(err).toBeInstanceOf(MfaStepUpRequiredError);
    expect((err as MfaStepUpRequiredError).getStatus()).toBe(401);
    expect((err as MfaStepUpRequiredError).reason).toBe('MFA_STEP_UP_REQUIRED');
  });

  it('con MFA activo y la sesión verificada, pasa', () => {
    expect(run(guard, { ...ADMIN_SIN_MFA, mfaEnabled: true, mfaVerified: true })).toBe(true);
  });

  it('un vendedor sin MFA pasa: su rol no lo exige', () => {
    expect(
      run(guard, {
        userId: 'u-2',
        role: 'vendedor',
        mfaRequired: false,
        mfaEnabled: false,
        mfaVerified: false,
      }),
    ).toBe(true);
  });

  it('una ruta @AllowWithoutMfa() deja pasar al admin sin MFA', () => {
    const exempt = new MfaEnforcementGuard(reflectorWith({ allowWithoutMfa: true }));
    expect(run(exempt, ADMIN_SIN_MFA)).toBe(true);
  });

  it('una ruta pública no exige nada', () => {
    const open = new MfaEnforcementGuard(reflectorWith({ isPublic: true }));
    expect(run(open, ADMIN_SIN_MFA)).toBe(true);
  });

  it('sin usuario no opina (AuthGuard ya cortó)', () => {
    expect(run(guard, {})).toBe(true);
  });
});

describe('AuthGuard', () => {
  const guard = new AuthGuard(reflectorWith({}));

  it('sin sesión y con motivo → 401 con ese reason', () => {
    const err = run(guard, { authFailure: 'SESSION_IDLE' });
    expect(err).toBeInstanceOf(SessionInvalidError);
    expect((err as SessionInvalidError).reason).toBe('SESSION_IDLE');
    expect((err as SessionInvalidError).getStatus()).toBe(401);
  });

  it('sin sesión ni motivo → 401 genérico', () => {
    const err = run(guard, {});
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(SessionInvalidError);
  });

  it('con usuario pasa', () => {
    expect(run(guard, { userId: 'u-1' })).toBe(true);
  });
});

/**
 * Qué rutas quedan fuera del MFA obligatorio es una decisión de seguridad: cada una abre la API a
 * una sesión sin segundo factor. Esto fija la lista del SPEC contra la metadata REAL de AppModule.
 */
describe('rutas exentas del MFA obligatorio', () => {
  const EXENTAS = [
    'GET /me',
    'GET /me/memberships',
    'GET /tenants/:id/branding',
    'GET /auth/mfa',
    'POST /auth/mfa/enroll',
    'POST /auth/mfa/confirm',
    'POST /auth/mfa/recovery-codes',
    'POST /auth/mfa/disable',
    'POST /auth/logout',
    'POST /auth/logout-all',
    'GET /auth/session',
    'GET /auth/sessions',
  ];

  type Controller = abstract new (...args: never[]) => unknown;

  function controllers(root: unknown): Set<Controller> {
    const seen = new Set<unknown>();
    const out = new Set<Controller>();
    const visit = (mod: unknown): void => {
      if (mod === undefined || mod === null) return;
      if (typeof mod === 'object' && 'forwardRef' in mod) {
        visit((mod as { forwardRef: () => unknown }).forwardRef());
        return;
      }
      if (typeof mod === 'object' && 'module' in mod) {
        const dyn = mod as { module: unknown; imports?: unknown[]; controllers?: Controller[] };
        for (const c of dyn.controllers ?? []) out.add(c);
        for (const i of dyn.imports ?? []) visit(i);
        visit(dyn.module);
        return;
      }
      if (typeof mod !== 'function' || seen.has(mod)) return;
      seen.add(mod);
      for (const c of (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) ??
        []) as Controller[]) {
        out.add(c);
      }
      for (const i of (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? []) as unknown[]) {
        visit(i);
      }
    };
    visit(root);
    return out;
  }

  function segments(path: unknown): string[] {
    return typeof path === 'string' ? path.split('/').filter((s) => s.length > 0) : [];
  }

  it('son exactamente las del SPEC', () => {
    const reflector = new Reflector();
    const scanner = new MetadataScanner();
    const exempt: string[] = [];
    for (const controller of controllers(AppModule)) {
      const base = segments(Reflect.getMetadata(PATH_METADATA, controller));
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== 'number') continue;
        const targets = [handler, controller];
        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
        const allowed =
          reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MFA_KEY, targets) === true;
        if (!allowed || isPublic) continue;
        const path = [...base, ...segments(Reflect.getMetadata(PATH_METADATA, handler))];
        exempt.push(`${RequestMethod[method]} /${path.join('/')}`);
      }
    }
    expect(exempt.sort()).toEqual([...EXENTAS].sort());
  });
});
