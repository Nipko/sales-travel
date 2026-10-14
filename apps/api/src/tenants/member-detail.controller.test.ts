import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Role } from '../database/database.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TenantIdParamSchema, UuidParamSchema } from './dto.js';
import { MemberDetailController } from './member-detail.controller.js';
import type { MemberDetailService } from './member-detail.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const OTRO = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const SESION = '44444444-4444-4444-8444-444444444444';

function banco() {
  const service = {
    detail: vi.fn(() => Promise.resolve({ user: { id: OTRO } })),
    platformDetail: vi.fn(() => Promise.resolve({ user: { id: OTRO } })),
    revokeSession: vi.fn(() => Promise.resolve({ ok: true as const })),
  };
  const controller = new MemberDetailController(service as unknown as MemberDetailService);
  return { service, controller };
}

/** Los pipes de cada parámetro de ruta del handler, por nombre del parámetro. */
function paramPipes(handler: string): Map<string, unknown[]> {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, MemberDetailController, handler) as Record<
    string,
    { data?: string; pipes: unknown[] }
  >;
  const out = new Map<string, unknown[]>();
  for (const arg of Object.values(args)) {
    if (typeof arg.data === 'string') out.set(arg.data, arg.pipes);
  }
  return out;
}

describe('MemberDetailController', () => {
  it('sin sesión: 401 y el servicio no se entera', async () => {
    const { service, controller } = banco();

    await expect(controller.memberDetail(undefined, NODO, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.platformUserDetail(undefined, OTRO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.revokeSession(undefined, NODO, OTRO, SESION)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('con sesión, el actor y los ids de la ruta llegan tal cual', async () => {
    const { service, controller } = banco();

    await controller.memberDetail(ACTOR, NODO, OTRO);
    await controller.platformUserDetail(ACTOR, OTRO);
    expect(await controller.revokeSession(ACTOR, NODO, OTRO, SESION)).toEqual({ ok: true });

    expect(service.detail).toHaveBeenCalledWith(ACTOR, NODO, OTRO);
    expect(service.platformDetail).toHaveBeenCalledWith(ACTOR, OTRO);
    expect(service.revokeSession).toHaveBeenCalledWith(ACTOR, NODO, OTRO, SESION);
  });

  it('cerrar una sesión responde 200, no 201', () => {
    const handler = Object.getOwnPropertyDescriptor(
      MemberDetailController.prototype,
      'revokeSession',
    )?.value as object;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('cada id de la ruta pasa por Zod: un id que no es UUID es 400 antes del servicio', () => {
    for (const [handler, params] of [
      ['memberDetail', ['id', 'userId']],
      ['platformUserDetail', ['userId']],
      ['revokeSession', ['id', 'userId', 'sessionId']],
    ] as const) {
      const pipes = paramPipes(handler);
      expect([...pipes.keys()].sort(), handler).toEqual([...params].sort());
      for (const param of params) {
        const [pipe] = pipes.get(param) ?? [];
        expect(pipe, `${handler}:${param}`).toBeInstanceOf(ZodValidationPipe);
      }
    }
    // `GET /admin/users/status` no llega como ficha de nadie.
    expect(UuidParamSchema.safeParse('status').success).toBe(false);
    expect(TenantIdParamSchema.safeParse('network').success).toBe(false);
    expect(UuidParamSchema.parse(OTRO.toUpperCase())).toBe(OTRO);
  });

  describe('RolesGuard con la metadata REAL del controlador', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => MemberDetailController,
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
