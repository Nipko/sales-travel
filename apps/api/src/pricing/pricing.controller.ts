import { z } from '@sales-travel/validation';
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
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { NetworkService } from '../network/network.service.js';
import { PricingService, type WaterfallResult } from './pricing.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';

/**
 * Antes estas rutas no tenían Zod (docs/qa/01 QA-H-10): un `ruleType` malo daba 403, un valor
 * negativo se truncaba a 0 y se guardaba, un 200 % entraba, la vertical era texto libre y un
 * `tenantId` mal formado terminaba en 500.
 */
export const PRICING_VERTICALS = [
  'all',
  'flights',
  'hotels',
  'cars',
  'assistance',
  'activities',
] as const;
/** `percentage` va en centésimas de punto: 10000 = 100 %. */
const PERCENT_MAX = 10_000;
const AMOUNT_MAX = Number.MAX_SAFE_INTEGER;

export const CreateRuleSchema = z
  .object({
    tenantId: z.string().uuid(),
    vertical: z.enum(PRICING_VERTICALS).default('all'),
    ruleType: z.enum(['percentage', 'fixed']),
    valueMinor: z.number().int().positive().max(AMOUNT_MAX),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((b) => b.ruleType !== 'percentage' || b.valueMinor <= PERCENT_MAX, {
    message: 'un porcentaje no puede pasar de 100 %',
    path: ['valueMinor'],
  });
type CreateRuleBody = z.infer<typeof CreateRuleSchema>;

export const WaterfallSchema = z
  .object({
    tenantId: z.string().uuid(),
    vertical: z.enum(PRICING_VERTICALS).default('all'),
    netMinor: z.number().int().min(0).max(AMOUNT_MAX),
  })
  .strict();
type WaterfallBody = z.infer<typeof WaterfallSchema>;

const TenantQuerySchema = z.string().uuid();
const RuleIdSchema = z.string().uuid();

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
  async listRules(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId', new ZodValidationPipe(TenantQuerySchema)) tenantId: string,
  ) {
    await this.assertAccess(userId, tenantId);
    const rules = await this.pricing.listRules(tenantId);
    return { rules };
  }

  /** Crea una regla de markup en un tenant. Requiere gestionar ese tenant. */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('rules')
  async createRule(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateRuleSchema)) body: CreateRuleBody,
  ) {
    await this.assertManage(userId, body.tenantId);
    const result = await this.pricing.createRule(body.tenantId, {
      vertical: body.vertical,
      ruleType: body.ruleType,
      valueMinor: body.valueMinor,
      ...(body.priority === undefined ? {} : { priority: body.priority }),
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
    @Param('id', new ZodValidationPipe(RuleIdSchema)) id: string,
    @Query('tenantId', new ZodValidationPipe(TenantQuerySchema)) tenantId: string,
  ) {
    await this.assertManage(userId, tenantId);
    const ok = await this.pricing.deleteRule(tenantId, id);
    // Una regla de otro nodo (o inexistente) no se borra: decirlo, en vez de un 200 que el panel
    // lee como «borrada» (QA-H-37).
    if (!ok) throw new NotFoundException('La regla no existe en este nodo.');
    await this.audit.emit({
      eventType: 'MarkupRuleDeleted',
      tenantId,
      actorUserId: userId,
      aggregateType: 'markup_rule',
      aggregateId: id,
    });
    return { deleted: true };
  }

  /** Simula el precio final aplicando la cascada de markups de la red sobre un neto. */
  @Post('waterfall')
  async waterfall(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(WaterfallSchema)) body: WaterfallBody,
  ): Promise<WaterfallResult> {
    await this.assertAccess(userId, body.tenantId);
    return this.pricing.computeWaterfall(body.tenantId, body.vertical, body.netMinor);
  }

  private async assertAccess(userId: string | undefined, tenantId: string): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('Falta el nodo (tenantId).');
    if (!(await this.network.canAccessTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized for this tenant');
    }
  }

  private async assertManage(userId: string | undefined, tenantId: string): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('Falta el nodo (tenantId).');
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('No administras este nodo.');
    }
  }
}
