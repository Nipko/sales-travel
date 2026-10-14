import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import {
  ReportsService,
  type CommissionsReport,
  type DashboardKpis,
  type SalesMetrics,
} from './reports.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  /** KPIs de la portada. Accesible a todo rol que vende: es su propio desempeño. */
  @Get('dashboard')
  async getDashboard(@CurrentUser() userId: string | undefined): Promise<DashboardKpis> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.reports.getDashboardKpis(tenantId);
  }

  @Get('sales-metrics')
  async getSalesMetrics(@CurrentUser() userId: string | undefined): Promise<SalesMetrics> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return this.reports.getSalesMetrics(tenantId);
  }

  /**
   * Comisiones y márgenes: todavía sin fuente real (ver {@link CommissionsReport}). La agencia activa
   * se resuelve igual, para que el endpoint siga exigiendo una membership vigente.
   */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Get('commissions')
  async getCommissions(@CurrentUser() userId: string | undefined): Promise<CommissionsReport> {
    if (!userId) throw new ForbiddenException();
    await this.activeTenant.resolve(userId);
    return this.reports.getCommissions();
  }
}
