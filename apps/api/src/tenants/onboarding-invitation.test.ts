import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AdminController } from './admin.controller.js';
import { CreateTenantSchema, TenantIdParamSchema, UuidParamSchema } from './dto.js';
import { InvitationsController } from './invitations.controller.js';
import type { InvitationsService } from './invitations.service.js';
import { UserCreationRetiredError } from './onboarding.errors.js';

/**
 * Alta sólo por invitación (docs/platform/14, decisión del founder del 2026-09-29). Lo que se prueba
 * sin base: que `POST /admin/users` ya no mira nada antes de responder 410, que el alta de un nodo no
 * acepta contraseña para su admin y que reenviar una invitación exige administrar el nodo.
 */

const ACTOR = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const INVITACION = '33333333-3333-4333-8333-333333333333';

describe('POST /admin/users: retirado (410)', () => {
  // Sin dependencias a propósito: si el handler tocara la base, la red o la auditoría fallaría con un
  // TypeError y no con el 410. Nada que cronometrar ni comparar entre un email conocido y uno nuevo.
  const controller = Object.create(AdminController.prototype) as AdminController;

  it('410 con motivo, sin leer nada', () => {
    let error: unknown;
    try {
      controller.createUser();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(UserCreationRetiredError);
    expect(error).toBeInstanceOf(GoneException);
    expect(error).toMatchObject({ reason: 'USER_CREATION_RETIRED' });
  });

  it('el mensaje manda a invitar, sin datos de nadie', () => {
    expect(() => controller.createUser()).toThrow(/invitaci[oó]n/i);
    expect(new UserCreationRetiredError().getResponse()).not.toHaveProperty('user');
  });
});

describe('alta de un nodo: el admin inicial siempre se invita', () => {
  const alta = new ZodValidationPipe(CreateTenantSchema);
  const base = {
    name: 'Agencia Sur',
    slug: 'agencia-sur',
    countryCode: 'CO',
    defaultCurrency: 'COP',
  };

  it('con email de admin pasa y no lleva contraseña', () => {
    const parsed = alta.transform({ ...base, adminEmail: 'Admin@Example.com' });
    expect(parsed.adminEmail).toBe('admin@example.com');
    expect(parsed).not.toHaveProperty('adminPassword');
  });

  it('rechaza una contraseña para el admin, con o sin email: 400 que lo explica', () => {
    for (const extra of [
      { adminEmail: 'admin@example.com', adminPassword: 'una-clave-larga-de-verdad' },
      { adminPassword: 'una-clave-larga-de-verdad' },
    ]) {
      let error: unknown;
      try {
        alta.transform({ ...base, ...extra });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        fields: { field: string; message: string }[];
      };
      expect(body.fields.map((f) => f.field)).toContain('adminPassword');
      expect(body.fields.find((f) => f.field === 'adminPassword')?.message).toMatch(/invita/i);
    }
  });

  it('un campo de contraseña vacío es "no enviado", como el resto del formulario', () => {
    expect(() =>
      alta.transform({ ...base, adminEmail: 'admin@example.com', adminPassword: '' }),
    ).not.toThrow();
    expect(() => alta.transform({ ...base, adminPassword: '   ' })).not.toThrow();
  });

  it('el nombre del admin ya no viaja: lo pone el invitado al aceptar', () => {
    const parsed = alta.transform({ ...base, adminEmail: 'admin@example.com', adminName: 'Ana' });
    expect(parsed).not.toHaveProperty('adminName');
  });
});

describe('POST /invitations/:id/resend', () => {
  function invitaciones(roleOver: Role | undefined) {
    const service = {
      invite: vi.fn(),
      resend: vi.fn(() => Promise.resolve({ id: INVITACION, expiresAt: new Date() })),
    };
    const network = {
      roleOver: vi.fn(() => Promise.resolve(roleOver)),
      isSuperadmin: vi.fn(() => Promise.resolve(false)),
      canManageTenant: vi.fn(() => Promise.resolve(roleOver !== undefined)),
    };
    const controller = new InvitationsController(
      service as unknown as InvitationsService,
      network as unknown as NetworkService,
    );
    return { controller, service, network };
  }

  it('sin sesión 401 y fuera de la red 403; el servicio no se entera', async () => {
    const { controller, service } = invitaciones(undefined);

    await expect(controller.resend(undefined, INVITACION, NODO)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.resend(ACTOR, INVITACION, NODO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.resend).not.toHaveBeenCalled();
  });

  it('el rango del actor se mide sobre el nodo de la invitación y llega al servicio', async () => {
    const { controller, service, network } = invitaciones('tenant_admin');

    await controller.resend(ACTOR, INVITACION, NODO);

    expect(network.roleOver).toHaveBeenCalledWith(ACTOR, NODO);
    expect(service.resend).toHaveBeenCalledWith({
      actorUserId: ACTOR,
      actorRole: 'tenant_admin',
      tenantId: NODO,
      invitationId: INVITACION,
    });
  });

  it('Zod en el borde: el id y el nodo son uuid', () => {
    expect(() => new ZodValidationPipe(UuidParamSchema).transform('no-es-uuid')).toThrow(
      BadRequestException,
    );
    expect(() => new ZodValidationPipe(TenantIdParamSchema).transform(undefined)).toThrow(
      BadRequestException,
    );
  });
});
