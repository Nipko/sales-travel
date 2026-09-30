import { RequestMethod, UnauthorizedException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { BookingPermissionsController } from './booking-permissions.controller.js';
import {
  BookingPermissionsForbiddenError,
  rethrowBookingPermissionsError,
} from './booking-permissions.errors.js';
import {
  BookingPermissionsTenantIdSchema,
  UpdateBookingPermissionsSchema,
} from './booking-permissions.schemas.js';
import type { BookingPermissionsService } from './booking-permissions.service.js';

const NODO = '11111111-1111-4111-8111-111111111111';
const USUARIO = '55555555-5555-4555-8555-555555555555';

function handler(nombre: string): object {
  const d = Object.getOwnPropertyDescriptor(BookingPermissionsController.prototype, nombre);
  if (typeof d?.value !== 'function') throw new Error(`no existe ${nombre}`);
  return d.value as object;
}

describe('BookingPermissionsController', () => {
  it('cuelga de /tenants/:tenantId/booking-permissions, sólo para quien administra un nodo', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BookingPermissionsController)).toBe(
      'tenants/:tenantId/booking-permissions',
    );
    expect(Reflect.getMetadata(ROLES_KEY, BookingPermissionsController)).toEqual([
      ...AGENCY_ADMIN_ROLES,
    ]);
    expect(Reflect.getMetadata(METHOD_METADATA, handler('view'))).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, handler('update'))).toBe(RequestMethod.PUT);
  });

  it('pasa quién actúa y el nodo al servicio; sin usuario, 401 sin tocarlo', async () => {
    const service = {
      financedView: vi.fn(() => Promise.resolve({ ok: 1 })),
      setNonRefundableRates: vi.fn(() => Promise.resolve({ ok: 2 })),
    };
    const controller = new BookingPermissionsController(
      service as unknown as BookingPermissionsService,
    );
    const body = { nonRefundableRates: 'blocked' as const, reason: 'Riesgo' };

    await expect(controller.view(USUARIO, NODO)).resolves.toEqual({ ok: 1 });
    await expect(controller.update(USUARIO, NODO, body)).resolves.toEqual({ ok: 2 });
    expect(service.financedView).toHaveBeenCalledWith(USUARIO, NODO);
    expect(service.setNonRefundableRates).toHaveBeenCalledWith(USUARIO, NODO, body);

    await expect(controller.view(undefined, NODO)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.update(undefined, NODO, body)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.financedView).toHaveBeenCalledTimes(1);
  });
});

describe('los bordes', () => {
  it('el id del nodo es un UUID, en minúsculas', () => {
    expect(BookingPermissionsTenantIdSchema.parse(NODO.toUpperCase())).toBe(NODO);
    expect(BookingPermissionsTenantIdSchema.safeParse('no-uuid').success).toBe(false);
  });

  it('el cambio es allowed | blocked con motivo obligatorio, y nada más', () => {
    expect(
      UpdateBookingPermissionsSchema.parse({ nonRefundableRates: 'blocked', reason: '  Riesgo ' }),
    ).toEqual({ nonRefundableRates: 'blocked', reason: 'Riesgo' });
    for (const body of [
      { nonRefundableRates: 'blocked' },
      { nonRefundableRates: 'blocked', reason: 'ab' },
      { nonRefundableRates: 'maybe', reason: 'Riesgo' },
      { nonRefundableRates: 'blocked', reason: 'Riesgo', tenantId: NODO },
    ]) {
      expect(UpdateBookingPermissionsSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('los errores de la base', () => {
  it('un 42501 (la RLS o la guarda de 0055) es el mismo 403 con motivo', () => {
    expect(() => rethrowBookingPermissionsError({ code: '42501' })).toThrow(
      BookingPermissionsForbiddenError,
    );
    try {
      rethrowBookingPermissionsError({ code: '42501', constraint: 'booking_permissions_author' });
    } catch (err) {
      expect((err as BookingPermissionsForbiddenError).getStatus()).toBe(403);
      expect((err as BookingPermissionsForbiddenError).reason).toBe(
        'BOOKING_PERMISSIONS_FINANCIER_REQUIRED',
      );
    }
  });

  it('cualquier otro error sigue su camino', () => {
    const otro = new Error('conexión perdida');
    expect(() => rethrowBookingPermissionsError(otro)).toThrow(otro);
  });
});
