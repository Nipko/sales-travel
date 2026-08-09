import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ReportsService } from './reports.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  /** KPIs de la portada. Accesible a todo rol que vende: es su propio desempeño. */
  @Get('dashboard')
  async getDashboard(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.reports.getDashboardKpis(tenantId);
  }

  @Get('sales-metrics')
  async getSalesMetrics(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.reports.getSalesMetrics(tenantId);
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Get('commissions')
  async getCommissions(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.reports.getCommissions(tenantId);
  }
}
