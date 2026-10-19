import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  TenantIdParamSchema,
  UpdateForeignCurrencyFaresSchema,
  type UpdateForeignCurrencyFaresDto,
} from './dto.js';
import {
  ForeignCurrencyFaresService,
  type ForeignCurrencyFaresView,
} from './foreign-currency-fares.service.js';

/**
 * Tarifas de vuelo en otra moneda que la de la agencia (0087), para probar de punta a punta un
 * proveedor cuyo punto de venta todavía cotiza en otra (LATAM NDC en BRL). Leer y cambiar es sólo
 * del superadmin: es un interruptor de plataforma, no un ajuste que la agencia administre.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/tenants/:id/foreign-currency-fares')
export class ForeignCurrencyFaresController {
  constructor(private readonly foreignFares: ForeignCurrencyFaresService) {}

  @Get()
  async read(
    @CurrentUser() userId: string,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<ForeignCurrencyFaresView> {
    return this.foreignFares.read(userId, tenantId);
  }

  /** Enciende o apaga el interruptor. Auditado con el antes y el después. */
  @Patch()
  async update(
    @CurrentUser() userId: string,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(UpdateForeignCurrencyFaresSchema))
    body: UpdateForeignCurrencyFaresDto,
  ): Promise<ForeignCurrencyFaresView> {
    return this.foreignFares.update(userId, tenantId, body.enabled);
  }
}
