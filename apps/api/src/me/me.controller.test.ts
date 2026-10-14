import { BadRequestException, RequestMethod, UnauthorizedException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { PERSON_NAME_MESSAGES } from '@sales-travel/validation';
import { describe, expect, it, vi } from 'vitest';
import { ALLOW_WITHOUT_MFA_KEY } from '../auth/decorators/allow-without-mfa.decorator.js';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import type { DatabaseService } from '../database/database.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { MeController } from './me.controller.js';
import type { ProfileService } from './profile.service.js';

const USER = '6f1c2a0e-4b3d-4e5f-8a9b-0c1d2e3f4a5b';

function banco() {
  const profile = {
    updateName: vi.fn((_userId: string, name: string) => Promise.resolve({ name })),
  };
  const controller = new MeController({} as DatabaseService, profile as unknown as ProfileService);
  return { controller, profile };
}

/** El pipe del cuerpo de PATCH /me, como lo arma Nest. */
function bodyPipe(): ZodValidationPipe<unknown> {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, MeController, 'updateProfile') as Record<
    string,
    { pipes: unknown[] }
  >;
  const body = Object.entries(args).find(([key]) => key.startsWith(`${RouteParamtypes.BODY}:`));
  const pipe = body?.[1].pipes[0];
  if (!(pipe instanceof ZodValidationPipe)) throw new Error('PATCH /me sin ZodValidationPipe');
  return pipe as ZodValidationPipe<unknown>;
}

function rejectionOf(fn: () => unknown): BadRequestException {
  try {
    fn();
  } catch (err) {
    if (err instanceof BadRequestException) return err;
    throw err;
  }
  throw new Error('esperaba un 400');
}

describe('PATCH /me (editar tu nombre)', () => {
  const handler = Object.getOwnPropertyDescriptor(MeController.prototype, 'updateProfile')!
    .value as object;

  it('es PATCH /me, sin id en la ruta', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MeController)).toBe('me');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
  });

  it('pide sesión y el 2FA obligatorio de siempre; la abre cualquier rol', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_WITHOUT_MFA_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ALLOW_WITHOUT_MFA_KEY, MeController)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, MeController)).toBeUndefined();
  });

  it('tiene tope: 10 cambios por minuto', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('cambia el nombre de la cuenta de la sesión y devuelve el guardado', async () => {
    const { controller, profile } = banco();
    await expect(controller.updateProfile(USER, { name: 'Laura Gómez' })).resolves.toEqual({
      name: 'Laura Gómez',
    });
    expect(profile.updateName).toHaveBeenCalledWith(USER, 'Laura Gómez');
  });

  it('sin sesión: 401 y el servicio no se entera', async () => {
    const { controller, profile } = banco();
    await expect(controller.updateProfile(undefined, { name: 'Laura' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(profile.updateName).not.toHaveBeenCalled();
  });

  it('el cuerpo pasa por el borde Zod: normaliza el nombre', () => {
    expect(bodyPipe().transform({ name: '  Laura   Gómez ' })).toEqual({ name: 'Laura Gómez' });
  });

  it('un correo o el id de otra cuenta en el cuerpo: 400 que dice por qué', () => {
    for (const body of [
      { name: 'Laura', email: 'otra@agencia.com' },
      { name: 'Laura', userId: '11111111-1111-4111-8111-111111111111' },
      { email: 'otra@agencia.com' },
    ]) {
      const err = rejectionOf(() => bodyPipe().transform(body));
      expect(JSON.stringify(err.getResponse())).toContain('fields');
    }
    const err = rejectionOf(() => bodyPipe().transform({ name: 'Laura', email: 'x@y.com' }));
    expect(err.getResponse()).toMatchObject({
      fields: [{ field: '(general)', message: 'Desde tu perfil sólo puedes cambiar tu nombre.' }],
    });
  });

  it('un nombre con un control de dirección: 400 en el campo `name`', () => {
    const err = rejectionOf(() =>
      bodyPipe().transform({ name: `Laura${String.fromCodePoint(0x202e)}zemóG` }),
    );
    expect(err.getResponse()).toMatchObject({
      fields: [{ field: 'name', message: PERSON_NAME_MESSAGES.invisible }],
    });
  });
});
