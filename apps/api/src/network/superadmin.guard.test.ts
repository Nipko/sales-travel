import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { requestContextStorage } from '../request-context/request-context.js';
import type { NetworkService } from './network.service.js';
import {
  ADMIN_SUPERADMIN_DB_DENIAL,
  SuperadminRequiredError,
  isAdminSuperadminDenial,
  rethrowAdminDbError,
} from './superadmin.errors.js';
import { SuperadminGuard } from './superadmin.guard.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const CTX = {} as ExecutionContext;

function guardWith(esSuperadmin: boolean) {
  const network = { isSuperadmin: vi.fn(() => Promise.resolve(esSuperadmin)) };
  return { guard: new SuperadminGuard(network as unknown as NetworkService), network };
}

describe('SuperadminGuard', () => {
  it('sin usuario en el request: 401, sin preguntar a la base', async () => {
    const { guard, network } = guardWith(true);
    await expect(
      requestContextStorage.run({}, () => guard.canActivate(CTX)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(CTX)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(network.isSuperadmin).not.toHaveBeenCalled();
  });

  it('quien no es superadmin (platform_admin incluido): 403 SUPERADMIN_REQUIRED', async () => {
    const { guard, network } = guardWith(false);
    const error = await requestContextStorage
      .run({ userId: USUARIO, role: 'platform_admin' }, () => guard.canActivate(CTX))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SuperadminRequiredError);
    expect((error as SuperadminRequiredError).getStatus()).toBe(403);
    expect((error as SuperadminRequiredError).reason).toBe('SUPERADMIN_REQUIRED');
    expect((error as SuperadminRequiredError).message).toBe(
      'Esta acción es sólo para el superadmin.',
    );
    expect(network.isSuperadmin).toHaveBeenCalledWith(USUARIO);
  });

  it('el superadmin pasa', async () => {
    const { guard } = guardWith(true);
    await expect(
      requestContextStorage.run({ userId: USUARIO, role: 'superadmin' }, () =>
        guard.canActivate(CTX),
      ),
    ).resolves.toBe(true);
  });
});

describe('rethrowAdminDbError', () => {
  it('el 42501 de la consola se vuelve el mismo 403 de la guarda', () => {
    const denial = Object.assign(new Error(ADMIN_SUPERADMIN_DB_DENIAL), { code: '42501' });
    expect(isAdminSuperadminDenial(denial)).toBe(true);
    expect(() => rethrowAdminDbError(denial)).toThrow(SuperadminRequiredError);
  });

  it.each([
    ['otro 42501 (un permiso que falta)', { code: '42501', message: 'permission denied' }],
    ['otro código con el mismo texto', { code: '22023', message: ADMIN_SUPERADMIN_DB_DENIAL }],
    ['un texto', 'boom'],
    ['null', null],
  ])('%s sale tal cual', (_caso, err) => {
    expect(isAdminSuperadminDenial(err)).toBe(false);
    let thrown: unknown;
    try {
      rethrowAdminDbError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
  });
});
