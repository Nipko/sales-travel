import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import type { DisclosureView } from './provider-disclosure.policy.js';
import {
  UpdateProviderDisclosureSchema,
  type UpdateProviderDisclosureDto,
} from './provider-disclosure.schemas.js';
import { ProviderDisclosureService } from './provider-disclosure.service.js';

/**
 * Gobierno de "¿se ve de qué proveedor viene cada oferta?".
 *
 * Autorización JERÁRQUICA, no por membership directa, igual que el branding de la red: el
 * consolidador decide para sus agencias sin ser miembro de cada una. Que un `agency_admin`
 * pueda tocar el suyo es deliberado —puede ocultarlo a sus vendedores— pero NO puede
 * mostrarlo si su consolidador lo ocultó: eso lo impone el plegado de la política, no este
 * controlador.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('provider-disclosure')
export class ProviderDisclosureController {
  constructor(
    private readonly disclosure: ProviderDisclosureService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
  ): Promise<DisclosureView> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    await this.assertCanManage(userId, tenantId);

    return this.disclosure.view(tenantId);
  }

  @Patch()
  async update(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(UpdateProviderDisclosureSchema)) dto: UpdateProviderDisclosureDto,
  ): Promise<DisclosureView> {
    if (!userId) throw new UnauthorizedException();
    await this.assertCanManage(userId, dto.tenantId);

    const view = await this.disclosure.setOwn(dto.tenantId, dto.showProviderInResults, userId);

    // Queda auditado con el valor: destapar la cadena de suministro del consolidador a toda
    // una red es exactamente el tipo de cambio del que después hay que saber quién lo hizo.
    await this.audit.emit({
      eventType: 'tenant.provider_disclosure.updated',
      tenantId: dto.tenantId,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: dto.tenantId,
      payload: { own: dto.showProviderInResults, effective: view.effective },
    });

    return view;
  }

  private async assertCanManage(userId: string, tenantId: string): Promise<void> {
    if (await this.network.isSuperadmin(userId)) return;
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }
  }
}
