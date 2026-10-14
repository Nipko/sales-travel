import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { SuperadminOnlyError } from '../tenants/member-detail.errors.js';
import { UserNotFoundError } from '../tenants/platform-users.errors.js';
import { MemberNotFoundError } from '../tenants/tenant-admin.policy.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { encodeAuditCursor, UserAuditQuerySchema } from './audit.schemas.js';
import type { AuditPage, AuditService } from './audit.service.js';
import { UserAuditController } from './user-audit.controller.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const OTRO = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const PAGINA: AuditPage = { events: [], nextBefore: null };

function banco(opts: { manages?: boolean; superadmin?: boolean; page?: AuditPage | undefined }) {
  const page = 'page' in opts ? opts.page : PAGINA;
  const audit = {
    userAuditTrail: vi.fn(() => Promise.resolve(page)),
    platformUserAuditTrail: vi.fn(() => Promise.resolve(page)),
  };
  const network = {
    canManageTenant: vi.fn(() => Promise.resolve(opts.manages ?? false)),
    isSuperadmin: vi.fn(() => Promise.resolve(opts.superadmin ?? false)),
  };
  const controller = new UserAuditController(
    audit as unknown as AuditService,
    network as unknown as NetworkService,
  );
  return { audit, network, controller };
}

/** `código HTTP/motivo` del error con que falla `p`. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const http = err as ForbiddenException & { reason?: string };
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
  throw new Error('esperaba un error HTTP');
}

/** Los pipes de cada argumento del handler: por nombre del parámetro, o `query` si es la consulta. */
function argPipes(handler: string): Map<string, unknown[]> {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, UserAuditController, handler) as Record<
    string,
    { data?: string; pipes: unknown[] }
  >;
  const out = new Map<string, unknown[]>();
  for (const [key, arg] of Object.entries(args)) {
    if (typeof arg.data === 'string') out.set(arg.data, arg.pipes);
    // RouteParamtypes.QUERY es 4: la consulta entera, sin nombre.
    else if (key.startsWith('4:')) out.set('query', arg.pipes);
  }
  return out;
}

describe('UserAuditController', () => {
  it('sin sesión: 401 y nadie se entera', async () => {
    const { audit, network, controller } = banco({ manages: true, superadmin: true });

    await expect(controller.memberAudit(undefined, NODO, OTRO, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.platformUserAudit(undefined, OTRO, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    for (const fn of [...Object.values(audit), ...Object.values(network)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  describe('desde Equipo', () => {
    it('quien no administra el nodo: 403 sin leer nada de la persona', async () => {
      const { audit, network, controller } = banco({ manages: false });

      expect(await rejection(controller.memberAudit(ACTOR, NODO, OTRO, {}))).toBe(
        '403/TENANT_NOT_MANAGED',
      );
      expect(network.canManageTenant).toHaveBeenCalledWith(ACTOR, NODO);
      expect(audit.userAuditTrail).not.toHaveBeenCalled();
    });

    it('un admin del nodo, sobre alguien fuera de su subárbol: 404', async () => {
      const { audit, controller } = banco({ manages: true, page: undefined });

      const err = await controller.memberAudit(ACTOR, NODO, OTRO, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MemberNotFoundError);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(audit.userAuditTrail).toHaveBeenCalledWith(ACTOR, NODO, OTRO, {
        before: undefined,
        limit: undefined,
      });
    });

    it('un admin del nodo, sobre alguien de su subárbol: la página, con el cursor ya leído', async () => {
      const page: AuditPage = { events: [], nextBefore: 'siguiente' };
      const { audit, controller } = banco({ manages: true, page });
      const before = encodeAuditCursor({ occurredAt: '2026-10-13T12:00:00.000001Z', id: OTRO });

      expect(await controller.memberAudit(ACTOR, NODO, OTRO, { before, limit: 5 })).toBe(page);
      expect(audit.userAuditTrail).toHaveBeenCalledWith(ACTOR, NODO, OTRO, {
        before: { occurredAt: '2026-10-13T12:00:00.000001Z', id: OTRO },
        limit: 5,
      });
    });
  });

  describe('desde Plataforma → Usuarios', () => {
    it('quien no es superadmin: 403 sin leer nada, aunque administre nodos', async () => {
      const { audit, network, controller } = banco({ manages: true, superadmin: false });

      const err = await controller.platformUserAudit(ACTOR, OTRO, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SuperadminOnlyError);
      expect(await rejection(controller.platformUserAudit(ACTOR, OTRO, {}))).toBe(
        '403/SUPERADMIN_ONLY',
      );
      expect(network.isSuperadmin).toHaveBeenCalledWith(ACTOR);
      expect(audit.platformUserAuditTrail).not.toHaveBeenCalled();
    });

    it('el superadmin, sobre una cuenta que no existe: 404', async () => {
      const { controller } = banco({ superadmin: true, page: undefined });

      const err = await controller.platformUserAudit(ACTOR, OTRO, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserNotFoundError);
    });

    it('el superadmin: la página de toda la plataforma', async () => {
      const { audit, controller } = banco({ superadmin: true });

      expect(await controller.platformUserAudit(ACTOR, OTRO, { limit: 10 })).toBe(PAGINA);
      expect(audit.platformUserAuditTrail).toHaveBeenCalledWith(ACTOR, OTRO, {
        before: undefined,
        limit: 10,
      });
    });
  });

  it('los ids de la ruta y la consulta pasan por Zod antes del controlador', () => {
    for (const [handler, params] of [
      ['memberAudit', ['id', 'userId', 'query']],
      ['platformUserAudit', ['userId', 'query']],
    ] as const) {
      const pipes = argPipes(handler);
      expect([...pipes.keys()].sort(), handler).toEqual([...params].sort());
      for (const param of params) {
        const [pipe] = pipes.get(param) ?? [];
        expect(pipe, `${handler}:${param}`).toBeInstanceOf(ZodValidationPipe);
      }
    }
    expect(new ZodValidationPipe(UserAuditQuerySchema).transform({ limit: '20' })).toEqual({
      limit: 20,
    });
    expect(() =>
      new ZodValidationPipe(UserAuditQuerySchema).transform({ tenantId: NODO }),
    ).toThrow();
  });

  describe('RolesGuard con la metadata REAL del controlador', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => UserAuditController,
    } as unknown as ExecutionContext;

    it('ni vendedor ni cliente_final llegan; un admin de nodo y el superadmin sí', () => {
      for (const role of ['vendedor', 'cliente_final'] as Role[]) {
        expect(() =>
          requestContextStorage.run({ userId: ACTOR, role }, () => guard.canActivate(ctx)),
        ).toThrow(ForbiddenException);
      }
      for (const role of ['admin', 'tenant_admin', 'superadmin'] as Role[]) {
        expect(
          requestContextStorage.run({ userId: ACTOR, role }, () => guard.canActivate(ctx)),
        ).toBe(true);
      }
    });
  });
});
