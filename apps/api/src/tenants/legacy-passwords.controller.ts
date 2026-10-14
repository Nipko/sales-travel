import { Body, Controller, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  LEGACY_RESET_BATCH_MAX,
  RequireLegacyResetSchema,
  type RequireLegacyResetDto,
} from './dto.js';
import {
  LEGACY_PASSWORDS_LIST_MAX,
  LegacyPasswordsService,
  type LegacyPasswordsList,
  type LegacyResetBatch,
} from './legacy-passwords.service.js';

/**
 * Lotes por minuto: los que hacen falta para la lista entera (500 / 50 = 10) y dos de margen. El
 * pedido que frena el 2FA (403, y el panel lo repite tras el código) también suma para el límite:
 * con 10 justos, el último lote de una lista llena salía 429.
 */
export const LEGACY_RESET_BATCHES_PER_MINUTE =
  Math.ceil(LEGACY_PASSWORDS_LIST_MAX / LEGACY_RESET_BATCH_MAX) + 2;

/**
 * Cuentas heredadas con una contraseña que eligió un admin (USR-14), en Plataforma → Usuarios. Sólo
 * el superadmin: lo decide LegacyPasswordsService antes de leer nada.
 *
 *   - `GET /admin/legacy-passwords`: la lista para revisar;
 *   - `POST /admin/legacy-passwords/require-reset` `{ userIds }`: forzar el cambio a las elegidas.
 *
 * No cuelgan de `/admin/users/…`: `GET /admin/users/:userId` es la ficha de una persona.
 *
 * Forzar es de alto impacto (founder D1 = C): pide el 2FA de los últimos 10 minutos y como mucho
 * {@link LEGACY_RESET_BATCHES_PER_MINUTE} lotes por minuto (cada uno de hasta 50 cuentas).
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('admin/legacy-passwords')
export class LegacyPasswordsController {
  constructor(private readonly legacy: LegacyPasswordsService) {}

  @Get()
  async list(@CurrentUser() userId: string | undefined): Promise<LegacyPasswordsList> {
    if (!userId) throw new UnauthorizedException();
    return this.legacy.list(userId);
  }

  @RequireRecentMfa()
  @Throttle({ default: { ttl: 60_000, limit: LEGACY_RESET_BATCHES_PER_MINUTE } })
  @Post('require-reset')
  @HttpCode(200)
  async requireReset(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(RequireLegacyResetSchema)) body: RequireLegacyResetDto,
  ): Promise<LegacyResetBatch> {
    if (!userId) throw new UnauthorizedException();
    return this.legacy.requireReset(userId, body.userIds);
  }
}
