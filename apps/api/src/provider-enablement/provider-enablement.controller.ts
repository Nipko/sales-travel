import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
  type OnModuleInit,
} from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { SupervisionService } from '../platform-admins/supervision.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ClearKillSwitchSchema,
  ProviderCodeParamSchema,
  ResetCircuitSchema,
  SetKillSwitchSchema,
  SetProviderEnablementSchema,
  TenantIdParamSchema,
  type ClearKillSwitchDto,
  type ResetCircuitDto,
  type SetKillSwitchDto,
  type SetProviderEnablementDto,
} from './provider-enablement.schemas.js';
import {
  ProviderEnablementService,
  type PlatformProviderView,
  type TenantProvidersView,
} from './provider-enablement.service.js';
import { ProviderHealthService, type ProviderHealthView } from './provider-health.service.js';

/**
 * Lo que un superadmin supervisado no aplica solo (docs/platform/16): levantar un apagado de
 * emergencia y encender o apagar un proveedor. Apagar en una emergencia y cerrar un circuito sí los
 * hace: cortan o recuperan durante un incidente, y esperar una aprobación sería peor.
 */
export const PROVIDER_CHANGE_KINDS = {
  clearKillSwitch: 'providers.kill_switch.clear',
  setGlobal: 'providers.enablement.set_global',
  clearGlobal: 'providers.enablement.clear_global',
  setTenant: 'providers.enablement.set_tenant',
  clearTenant: 'providers.enablement.clear_tenant',
} as const;

const ClearKillSwitchInput = z
  .object({ code: ProviderCodeParamSchema, dto: ClearKillSwitchSchema })
  .strict();
const SetGlobalInput = z
  .object({ code: ProviderCodeParamSchema, dto: SetProviderEnablementSchema })
  .strict();
const ClearGlobalInput = z.object({ code: ProviderCodeParamSchema }).strict();
const SetTenantInput = z
  .object({
    code: ProviderCodeParamSchema,
    tenantId: TenantIdParamSchema,
    dto: SetProviderEnablementSchema,
  })
  .strict();
const ClearTenantInput = z
  .object({ code: ProviderCodeParamSchema, tenantId: TenantIdParamSchema })
  .strict();

function onOff(enabled: boolean): string {
  return enabled ? 'encender' : 'apagar';
}

/**
 * Qué proveedores puede usar cada tenant, desde el panel de la plataforma.
 *
 * También la salud de cada proveedor y las palancas de un incidente: el apagado de emergencia desde
 * el panel (0077) y cerrar a mano un circuito abierto.
 *
 * Sólo el superadmin: `@Roles` deja fuera a todo rol de nodo (un consolidador no enciende ni apaga
 * proveedores de la plataforma, ni siquiera para su red), y {@link SuperadminGuard} —antes de los
 * pipes: quien no es superadmin recibe 403 aunque el cuerpo sea inválido— y la comprobación
 * explícita de cada ruta, que además da el actor, dejan fuera a `platform_admin`, como el resto del
 * panel de plataforma. La base lo vuelve a exigir al escribir (RLS de 0048 y 0077).
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/providers')
export class ProviderEnablementController implements OnModuleInit {
  constructor(
    private readonly enablement: ProviderEnablementService,
    private readonly network: NetworkService,
    private readonly health: ProviderHealthService,
    private readonly supervision: SupervisionService,
  ) {}

  onModuleInit(): void {
    const k = PROVIDER_CHANGE_KINDS;
    this.supervision.register(k.clearKillSwitch, {
      schema: ClearKillSwitchInput,
      summary: (i) => `Proveedores: levantar el apagado de emergencia de ${i.code}`,
      execute: (actor, i) => this.health.clearKillSwitch(actor, i.code, i.dto.reason ?? null),
    });
    this.supervision.register(k.setGlobal, {
      schema: SetGlobalInput,
      summary: (i) => `Proveedores: ${onOff(i.dto.enabled)} ${i.code} para toda la plataforma`,
      execute: (actor, i) =>
        this.enablement.setGlobal(actor, i.code, {
          enabled: i.dto.enabled,
          reason: i.dto.reason ?? null,
        }),
    });
    this.supervision.register(k.clearGlobal, {
      schema: ClearGlobalInput,
      summary: (i) => `Proveedores: quitar el ajuste global de ${i.code}`,
      execute: (actor, i) => this.enablement.clearGlobal(actor, i.code),
    });
    this.supervision.register(k.setTenant, {
      schema: SetTenantInput,
      summary: (i) => `Proveedores: ${onOff(i.dto.enabled)} ${i.code} en el nodo ${i.tenantId}`,
      execute: (actor, i) =>
        this.enablement.setTenant(actor, i.code, i.tenantId, {
          enabled: i.dto.enabled,
          reason: i.dto.reason ?? null,
        }),
    });
    this.supervision.register(k.clearTenant, {
      schema: ClearTenantInput,
      summary: (i) => `Proveedores: quitar el ajuste de ${i.code} en el nodo ${i.tenantId}`,
      execute: (actor, i) => this.enablement.clearTenant(actor, i.code, i.tenantId),
    });
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined): Promise<PlatformProviderView[]> {
    await this.assertSuperadmin(userId);
    return this.enablement.list();
  }

  /** ¿Está respondiendo cada proveedor? Circuito, cuentas en pausa, apagado y avisos de cuenta. */
  @Get('health')
  async providersHealth(@CurrentUser() userId: string | undefined): Promise<ProviderHealthView[]> {
    const actor = await this.assertSuperadmin(userId);
    return this.health.health(actor);
  }

  /** Apagado de emergencia: corta el proveedor para toda la plataforma, sin desplegar. */
  @Put(':code/kill-switch')
  async setKillSwitch(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Body(new ZodValidationPipe(SetKillSwitchSchema)) dto: SetKillSwitchDto,
  ): Promise<ProviderHealthView> {
    const actor = await this.assertSuperadmin(userId);
    return this.health.setKillSwitch(actor, code, dto);
  }

  /** Levanta el apagado del panel. El de la variable PROVIDERS_DISABLED se quita desplegando (409). */
  @Post(':code/kill-switch/clear')
  @HttpCode(200)
  async clearKillSwitch(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Body(new ZodValidationPipe(ClearKillSwitchSchema)) dto: ClearKillSwitchDto,
  ): Promise<ProviderHealthView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, PROVIDER_CHANGE_KINDS.clearKillSwitch, { code, dto });
    return this.health.clearKillSwitch(actor, code, dto.reason ?? null);
  }

  /** Cierra el circuito abierto del proveedor: vuelve a recibir llamadas de inmediato. */
  @Post(':code/circuit/reset')
  @HttpCode(200)
  async resetCircuit(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Body(new ZodValidationPipe(ResetCircuitSchema)) dto: ResetCircuitDto,
  ): Promise<ProviderHealthView> {
    const actor = await this.assertSuperadmin(userId);
    return this.health.resetCircuit(actor, code, dto.reason);
  }

  @Get('tenants/:tenantId')
  async forTenant(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<TenantProvidersView> {
    await this.assertSuperadmin(userId);
    return this.enablement.forTenant(tenantId);
  }

  @Put(':code/global')
  async setGlobal(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Body(new ZodValidationPipe(SetProviderEnablementSchema)) dto: SetProviderEnablementDto,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, PROVIDER_CHANGE_KINDS.setGlobal, { code, dto });
    return this.enablement.setGlobal(actor, code, {
      enabled: dto.enabled,
      reason: dto.reason ?? null,
    });
  }

  @Delete(':code/global')
  async clearGlobal(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, PROVIDER_CHANGE_KINDS.clearGlobal, { code });
    return this.enablement.clearGlobal(actor, code);
  }

  @Put(':code/tenants/:tenantId')
  async setTenant(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(SetProviderEnablementSchema)) dto: SetProviderEnablementDto,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, PROVIDER_CHANGE_KINDS.setTenant, { code, tenantId, dto });
    return this.enablement.setTenant(actor, code, tenantId, {
      enabled: dto.enabled,
      reason: dto.reason ?? null,
    });
  }

  @Delete(':code/tenants/:tenantId')
  async clearTenant(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, PROVIDER_CHANGE_KINDS.clearTenant, { code, tenantId });
    return this.enablement.clearTenant(actor, code, tenantId);
  }

  private async assertSuperadmin(userId: string | undefined): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
    return userId;
  }
}
