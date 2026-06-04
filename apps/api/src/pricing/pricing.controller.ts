import { Body, Controller, ForbiddenException, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { NetworkService } from '../network/network.service.js';
import { PricingService, type WaterfallResult } from './pricing.service.js';

interface WaterfallBody {
  tenantId: string;
  vertical: string;
  netMinor: number;
}

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly network: NetworkService,
  ) {}

  /** Simula el precio final aplicando la cascada de markups de la red sobre un neto. */
  @Post('waterfall')
  async waterfall(
    @CurrentUser() userId: string | undefined,
    @Body() body: WaterfallBody,
  ): Promise<WaterfallResult> {
    if (!userId) throw new UnauthorizedException();
    if (!body.tenantId) throw new ForbiddenException('tenantId required');
    if (!(await this.network.canAccessTenant(userId, body.tenantId))) {
      throw new ForbiddenException('not authorized for this tenant');
    }
    return this.pricing.computeWaterfall(
      body.tenantId,
      body.vertical || 'all',
      Math.max(0, Math.trunc(body.netMinor || 0)),
    );
  }
}
