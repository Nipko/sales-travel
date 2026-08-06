import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { NetworkService } from '../network/network.service.js';
import { PricingService, type WaterfallResult } from './pricing.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';

interface WaterfallBody {
  tenantId: string;
  vertical: string;
  netMinor: number;
}

interface CreateRuleBody {
  tenantId: string;
  vertical: string;
  ruleType: 'percentage' | 'fixed';
  valueMinor: number;
  priority?: number;
}

@Roles(...SELLING_ROLES)
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  /** Reglas de markup propias de un tenant. Requiere poder ver ese tenant. */
  @Get('rules')
  async listRules(@CurrentUser() userId: string | undefined, @Query('tenantId') tenantId: string) {
    await this.assertAccess(userId, tenantId);
    const rules = await this.pricing.listRules(tenantId);
    return { rules };
  }

  /** Crea una regla de markup en un tenant. Requiere gestionar ese tenant. */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('rules')
  async createRule(@CurrentUser() userId: string | undefined, @Body() body: CreateRuleBody) {
    await this.assertManage(userId, body.tenantId);
    if (body.ruleType !== 'percentage' && body.ruleType !== 'fixed') {
      throw new ForbiddenException('invalid ruleType');
    }
    const result = await this.pricing.createRule(body.tenantId, {
      vertical: body.vertical || 'all',
      ruleType: body.ruleType,
      valueMinor: Math.max(0, Math.trunc(body.valueMinor || 0)),
      priority: body.priority,
    });
    await this.audit.emit({
      eventType: 'MarkupRuleCreated',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'markup_rule',
      aggregateId: result.id,
      payload: { vertical: body.vertical, ruleType: body.ruleType, valueMinor: body.valueMinor },
    });
    return result;
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Delete('rules/:id')
  async deleteRule(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
  ) {
    await this.assertManage(userId, tenantId);
    const ok = await this.pricing.deleteRule(tenantId, id);
    if (ok) {
      await this.audit.emit({
        eventType: 'MarkupRuleDeleted',
        tenantId,
        actorUserId: userId,
        aggregateType: 'markup_rule',
        aggregateId: id,
      });
    }
    return { deleted: ok };
  }

  /** Simula el precio final aplicando la cascada de markups de la red sobre un neto. */
  @Post('waterfall')
  async waterfall(
    @CurrentUser() userId: string | undefined,
    @Body() body: WaterfallBody,
  ): Promise<WaterfallResult> {
    await this.assertAccess(userId, body.tenantId);
    return this.pricing.computeWaterfall(
      body.tenantId,
      body.vertical || 'all',
      Math.max(0, Math.trunc(body.netMinor || 0)),
    );
  }

  private async assertAccess(userId: string | undefined, tenantId: string): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    if (!(await this.network.canAccessTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized for this tenant');
    }
  }

  private async assertManage(userId: string | undefined, tenantId: string): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }
  }
}
