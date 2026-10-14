import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../../__fixtures__/app-routes.js';
import { AppModule } from '../../app.module.js';
import {
  requestContextStorage,
  type RequestContext,
} from '../../request-context/request-context.js';
import { MfaRecentRequiredError, MfaRequiredForActionError } from '../auth-errors.js';
import {
  REQUIRE_RECENT_MFA_KEY,
  RequireRecentMfa,
} from '../decorators/require-recent-mfa.decorator.js';
import { assertRecentMfa, mfaVerifiedWithin, RECENT_MFA_WINDOW_MINUTES } from '../recent-mfa.js';
import { verifiedAtOnLocalClock } from '../session.service.js';
import { MfaEnforcementGuard } from './mfa-enforcement.guard.js';
import { RecentMfaGuard } from './recent-mfa.guard.js';
import { RolesGuard } from './roles.guard.js';

/*
 * La reconfirmación del 2FA de las acciones de alto impacto (USR-13, founder D1 = C): la ventana y
 * sus bordes, que una ruta sin la marca no la ve, y qué rutas la llevan, contra la metadata REAL de
 * AppModule. Una marca de más bloquea el soporte de todos los días; una de menos deja una acción
 * crítica al alcance de una sesión robada.
 */

const NOW = new Date('2026-10-13T15:00:00.000Z');
const MIN = 60_000;

// `this: void`: el test los usa sueltos, como handlers, igual que Nest.
class Rutas {
  @RequireRecentMfa()
  critica(this: void): void {}

  @RequireRecentMfa(5)
  masEstricta(this: void): void {}

  soporte(this: void): void {}
}

function contextFor(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Rutas,
  } as unknown as ExecutionContext;
}

/** El admin con 2FA activo que lo pasó hace `minutes` minutos. */
function admin(minutes: number | null): RequestContext {
  return {
    userId: 'u-1',
    role: 'tenant_admin',
    mfaRequired: true,
    mfaEnabled: true,
    mfaVerified: minutes !== null,
    ...(minutes !== null ? { mfaVerifiedAt: new Date(NOW.getTime() - minutes * MIN) } : {}),
  };
}

const guard = new RecentMfaGuard(new Reflector());

function run(handler: () => void, context: RequestContext | undefined): unknown {
  try {
    return context === undefined
      ? guard.canActivate(contextFor(handler))
      : requestContextStorage.run(context, () => guard.canActivate(contextFor(handler)));
  } catch (err) {
    return err;
  }
}

function reasonOf(err: unknown): string {
  if (err === true) return 'pasa';
  const http = err as { getStatus?: () => number; reason?: string };
  return `${http.getStatus?.() ?? '?'}/${http.reason ?? '?'}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecentMfaGuard', () => {
  const critica = Rutas.prototype.critica;

  it('la ventana por defecto es de 10 minutos', () => {
    expect(RECENT_MFA_WINDOW_MINUTES).toBe(10);
    expect(Reflect.getMetadata(REQUIRE_RECENT_MFA_KEY, critica)).toBe(10);
  });

  it('dentro de la ventana pasa; el borde exacto cuenta como reciente', () => {
    expect(run(critica, admin(0))).toBe(true);
    expect(run(critica, admin(9.99))).toBe(true);
    expect(run(critica, admin(10))).toBe(true);
  });

  it('un instante después del borde: 403 MFA_RECENT_REQUIRED', () => {
    const err = run(critica, admin(10 + 1 / MIN));
    expect(err).toBeInstanceOf(MfaRecentRequiredError);
    expect(reasonOf(err)).toBe('403/MFA_RECENT_REQUIRED');
    expect((err as MfaRecentRequiredError).message).toBe(
      'Confirma con tu código de verificación en dos pasos para seguir.',
    );
  });

  it('una sesión que nunca pasó el segundo factor también lo pide', () => {
    expect(reasonOf(run(critica, admin(null)))).toBe('403/MFA_RECENT_REQUIRED');
  });

  it('sin el 2FA activo no hay código que pedir: 403 MFA_REQUIRED_FOR_ACTION', () => {
    const err = run(critica, {
      userId: 'u-2',
      role: 'agency_admin',
      mfaRequired: false,
      mfaEnabled: false,
      mfaVerified: false,
    });
    expect(err).toBeInstanceOf(MfaRequiredForActionError);
    expect(reasonOf(err)).toBe('403/MFA_REQUIRED_FOR_ACTION');
  });

  it('sin usuario (o sin contexto) no deja pasar: 401', () => {
    expect(run(critica, {})).toBeInstanceOf(UnauthorizedException);
    expect(run(critica, undefined)).toBeInstanceOf(UnauthorizedException);
  });

  it('la ventana se configura por ruta', () => {
    const estricta = Rutas.prototype.masEstricta;
    expect(run(estricta, admin(5))).toBe(true);
    expect(reasonOf(run(estricta, admin(6)))).toBe('403/MFA_RECENT_REQUIRED');
  });

  it('una ruta sin la marca no la ve, ni sin 2FA ni sin contexto', () => {
    const soporte = Rutas.prototype.soporte;
    expect(run(soporte, admin(null))).toBe(true);
    expect(run(soporte, { userId: 'u-2', mfaEnabled: false })).toBe(true);
    expect(run(soporte, undefined)).toBe(true);
  });

  it('una ventana que no es un número positivo no compila la ruta', () => {
    expect(() => RequireRecentMfa(0)).toThrow(/ventana inválida/);
    expect(() => RequireRecentMfa(-1)).toThrow(/ventana inválida/);
    expect(() => RequireRecentMfa(Number.NaN)).toThrow(/ventana inválida/);
  });
});

describe('assertRecentMfa y mfaVerifiedWithin', () => {
  it('miden contra el reloj que se les pasa', () => {
    const at = new Date(NOW.getTime() - 3 * MIN);
    expect(mfaVerifiedWithin({ mfaVerifiedAt: at }, 3, NOW.getTime())).toBe(true);
    expect(mfaVerifiedWithin({ mfaVerifiedAt: at }, 2, NOW.getTime())).toBe(false);
    expect(mfaVerifiedWithin({}, 10, NOW.getTime())).toBe(false);
    expect(mfaVerifiedWithin({ mfaVerifiedAt: new Date(Number.NaN) }, 10, NOW.getTime())).toBe(
      false,
    );
  });

  it('el instante sale de la antigüedad que mide la base, no de comparar dos relojes', () => {
    // La base dice que pasó hace 120 s; su reloj va 1 h adelantado respecto de la API.
    const dbClock = new Date(NOW.getTime() + 3600_000 - 120_000);
    const local = verifiedAtOnLocalClock(dbClock, 120, NOW.getTime());
    expect(local).toEqual(new Date(NOW.getTime() - 120_000));
    expect(mfaVerifiedWithin({ mfaVerifiedAt: local }, 2, NOW.getTime())).toBe(true);
    // Sin la antigüedad, el instante de la base tal cual.
    const past = new Date(NOW.getTime() - 120_000);
    expect(verifiedAtOnLocalClock(past, null, NOW.getTime())).toEqual(past);
    expect(verifiedAtOnLocalClock(past, Number.NaN, NOW.getTime())).toEqual(past);
  });

  it('un instante en el futuro cuenta como recién, no alarga la ventana', () => {
    // Una antigüedad negativa (heredado de un reloj adelantado) o, sin ella, un instante adelantado.
    const ahead = verifiedAtOnLocalClock(new Date(NOW.getTime()), -3600, NOW.getTime());
    expect(ahead).toEqual(NOW);
    const future = new Date(NOW.getTime() + 3600_000);
    expect(verifiedAtOnLocalClock(future, null, NOW.getTime())).toEqual(NOW);
    // Once minutos después ya no vale: con el instante adelantado habría valido una hora más.
    expect(mfaVerifiedWithin({ mfaVerifiedAt: ahead }, 10, NOW.getTime() + 11 * MIN)).toBe(false);
  });

  it('el servicio la llama con el contexto del request', () => {
    expect(() => requestContextStorage.run(admin(2), () => assertRecentMfa())).not.toThrow();
    expect(() => requestContextStorage.run(admin(11), () => assertRecentMfa())).toThrow(
      MfaRecentRequiredError,
    );
  });
});

describe('dónde corre y qué rutas la llevan', () => {
  it('es el último guard global: después de RolesGuard, así sólo se le pide a quien llegó', () => {
    const guards = (
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? []) as Array<{
        provide?: unknown;
        useClass?: unknown;
      }>
    )
      .filter((p) => p.provide === APP_GUARD)
      .map((p) => p.useClass);
    expect(guards.at(-1)).toBe(RecentMfaGuard);
    expect(guards.indexOf(RolesGuard)).toBeLessThan(guards.indexOf(RecentMfaGuard));
    expect(guards.indexOf(MfaEnforcementGuard)).toBeLessThan(guards.indexOf(RolesGuard));
  });

  it('son exactamente las de la decisión del founder (D1 = C), con 10 minutos', () => {
    const reflector = new Reflector();
    const marked = appRoutes(AppModule)
      .map(({ route, handler }) => ({
        route,
        minutes: reflector.get<number | undefined>(REQUIRE_RECENT_MFA_KEY, handler),
      }))
      .filter((r) => r.minutes !== undefined);
    // Enviar el enlace la pide sólo si la persona es admin: lo decide MemberSupportService. Cerrar
    // sesiones y desbloquear son el soporte de todos los días: no la llevan. Exportar a CSV sí
    // (la Actividad de la plataforma, ADM-8; las Reservas de la red, ADM-14).
    expect(marked.sort((a, b) => a.route.localeCompare(b.route))).toEqual([
      { route: 'GET /admin/audit/export', minutes: 10 },
      { route: 'GET /admin/orders/export', minutes: 10 },
      { route: 'PATCH /admin/users/status', minutes: 10 },
      { route: 'POST /tenants/:id/members/:userId/require-password-reset', minutes: 10 },
      { route: 'POST /tenants/:id/members/:userId/reset-mfa', minutes: 10 },
    ]);
  });
});
