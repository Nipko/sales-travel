import { createHash } from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator.js';
import type { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { InvitationTokenBodySchema } from './dto.js';
import { InvitationPreviewController } from './invitation-preview.controller.js';
import { InvitationPreviewService } from './invitation-preview.service.js';
import { InvitationsController } from './invitations.controller.js';
import type { InvitationsService } from './invitations.service.js';

/**
 * La vista previa de la invitación (USR-17) sin base: qué se consulta, que toda invitación que no
 * se puede aceptar da la misma respuesta y que lo que sale no trae ids ni correos. Que el SQL hace
 * lo que dice lo prueba invitation-preview.integration.test.ts contra Postgres.
 */

const TOKEN = 'token-del-correo-de-la-invitacion';
const INVITACION = '33333333-3333-4333-8333-333333333333';
const NODO = '11111111-1111-4111-8111-111111111111';
const INVITADOR = '44444444-4444-4444-8444-444444444444';
const DUENA = '55555555-5555-4555-8555-555555555555';
const OTRA = '66666666-6666-4666-8666-666666666666';
const VENCE = new Date('2026-10-20T15:00:00.000Z');

interface Escena {
  /** La fila de preview_pending_invitation, o `null` si no hay. */
  row?: Partial<{
    role: Role;
    inviter_name: string | null;
    invitee_user_id: string | null;
  }> | null;
  /** La fila de invitation_backing, o `null` si no vino. */
  backing?: Partial<{
    invited_by: string | null;
    inviter_active: boolean;
    tenant_active: boolean;
    inviter_roles: Role[];
  }> | null;
}

function escena(opts: Escena = {}) {
  const k = scriptedKysely((q) => {
    if (q.sql.includes('preview_pending_invitation')) {
      if (opts.row === null) return [];
      return [
        {
          invitation_id: INVITACION,
          tenant_name: 'Viajes Norte',
          role: 'vendedor',
          inviter_name: 'Laura Gómez',
          expires_at: VENCE,
          invitee_user_id: null,
          ...opts.row,
        },
      ];
    }
    if (q.sql.includes('invitation_backing')) {
      if (opts.backing === null) return [];
      return [
        {
          invitation_id: INVITACION,
          tenant_id: NODO,
          role: opts.row?.role ?? 'vendedor',
          invited_by: INVITADOR,
          inviter_active: true,
          tenant_active: true,
          inviter_roles: ['tenant_admin'],
          ...opts.backing,
        },
      ];
    }
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const service = new InvitationPreviewService({ db: k.db } as unknown as DatabaseService);
  return { service, k };
}

describe('InvitationPreviewService.preview', () => {
  it('vigente: nodo, rol, quién invitó, vencimiento y si hay cuenta; nada más', async () => {
    const { service, k } = escena();

    const preview = await service.preview(TOKEN, undefined);

    expect(preview).toEqual({
      valid: true,
      tenantName: 'Viajes Norte',
      role: 'vendedor',
      inviterName: 'Laura Gómez',
      expiresAt: '2026-10-20T15:00:00.000Z',
      existingAccount: false,
      viewer: 'anonymous',
    });
    const json = JSON.stringify(preview);
    for (const id of [INVITACION, NODO, INVITADOR]) expect(json).not.toContain(id);
    // Se busca por el hash del token, nunca por el token en claro.
    const hash = createHash('sha256').update(TOKEN).digest('hex');
    expect(k.queries[0]?.parameters).toEqual([hash]);
    expect(JSON.stringify(k.queries.map((q) => q.parameters))).not.toContain(TOKEN);
    // Sólo lee: ni claim ni update.
    expect(k.queries.map((q) => q.sql).join('\n')).not.toMatch(/claim_pending_invitation|update/i);
  });

  it('con cuenta: dice si la sesión es la de la cuenta invitada, la de otra o ninguna', async () => {
    const { service } = escena({ row: { invitee_user_id: DUENA } });

    expect(await service.preview(TOKEN, undefined)).toMatchObject({
      existingAccount: true,
      viewer: 'anonymous',
    });
    expect(await service.preview(TOKEN, DUENA)).toMatchObject({ viewer: 'invitee' });
    expect(await service.preview(TOKEN, DUENA.toUpperCase())).toMatchObject({ viewer: 'invitee' });
    expect(await service.preview(TOKEN, OTRA)).toMatchObject({ viewer: 'other' });
  });

  it('sin cuenta, cualquier sesión es de otra cuenta', async () => {
    const { service } = escena({ row: { invitee_user_id: null } });

    expect(await service.preview(TOKEN, OTRA)).toMatchObject({
      existingAccount: false,
      viewer: 'other',
    });
  });

  it('quien invitó sin nombre: null', async () => {
    const { service } = escena({ row: { inviter_name: null } });
    expect(await service.preview(TOKEN, undefined)).toMatchObject({ inviterName: null });
  });

  it.each<[string, Escena]>([
    ['no existe, se usó, se revocó o venció', { row: null }],
    ['su rol no se asigna', { row: { role: 'superadmin' } }],
    ['sin respaldo', { backing: null }],
    ['su invitador ya no existe', { backing: { invited_by: null } }],
    ['su invitador está suspendido', { backing: { inviter_active: false } }],
    ['su invitador ya no tiene el rango', { backing: { inviter_roles: ['vendedor'] } }],
    ['su nodo no opera', { backing: { tenant_active: false } }],
  ])('neutral si %s: { valid: false } y nada más', async (_caso, opts) => {
    const { service } = escena(opts);
    expect(await service.preview(TOKEN, DUENA)).toEqual({ valid: false });
  });

  it('un rol que no se asigna ni se revalida', async () => {
    const { service, k } = escena({ row: { role: 'superadmin' } });
    await service.preview(TOKEN, undefined);
    expect(k.indexOf('invitation_backing')).toBe(-1);
  });
});

describe('POST /invitations/preview', () => {
  const handler = Object.getOwnPropertyDescriptor(InvitationPreviewController.prototype, 'preview')!
    .value as object;

  it('pública, con el throttle de lo que acepta un token sin sesión', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('pasa el token y la cuenta de la sesión, si la hay', async () => {
    const previews = { preview: vi.fn(() => Promise.resolve({ valid: false as const })) };
    const controller = new InvitationPreviewController(
      previews as unknown as InvitationPreviewService,
    );

    await controller.preview(undefined, { token: TOKEN });
    await controller.preview(DUENA, { token: TOKEN });

    expect(previews.preview.mock.calls).toEqual([
      [TOKEN, undefined],
      [TOKEN, DUENA],
    ]);
  });

  it('el borde: sólo el token, ni corto ni de más', () => {
    const pipe = new ZodValidationPipe(InvitationTokenBodySchema);
    expect(pipe.transform({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(() => pipe.transform({ token: 'corto' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ token: 'x'.repeat(513) })).toThrow(BadRequestException);
    expect(() => pipe.transform({ token: TOKEN, email: 'a@b.co' })).toThrow(BadRequestException);
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });
});

describe('POST /invitations/join', () => {
  const handler = Object.getOwnPropertyDescriptor(InvitationsController.prototype, 'join')!
    .value as object;

  function controller() {
    const invitations = {
      acceptSignedIn: vi.fn(() => Promise.resolve({ userId: DUENA, tenantId: NODO })),
    };
    const c = new InvitationsController(
      invitations as unknown as InvitationsService,
      {} as NetworkService,
    );
    return { c, invitations };
  }

  it('con sesión (no es pública) y con throttle', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
  });

  it('sin cuenta en la sesión: 401 sin llegar al servicio', () => {
    const { c, invitations } = controller();
    expect(() => c.join(undefined, { token: TOKEN })).toThrow(UnauthorizedException);
    expect(invitations.acceptSignedIn).not.toHaveBeenCalled();
  });

  it('acepta con la cuenta de la sesión, nunca con una que venga en el cuerpo', async () => {
    const { c, invitations } = controller();
    await c.join(DUENA, { token: TOKEN });
    expect(invitations.acceptSignedIn).toHaveBeenCalledWith({ token: TOKEN, userId: DUENA });
  });
});
