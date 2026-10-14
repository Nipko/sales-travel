import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AdminAuditExportQuerySchema,
  AdminAuditQuerySchema,
  type AdminAuditExportQuery,
  type AdminAuditQuery,
} from './admin-audit.schemas.js';
import { AdminAuditService, type AdminAuditPage } from './admin-audit.service.js';

/** Cabeceras de la exportación que lee el panel (y deja leer a su BFF). */
export const EXPORT_ROWS_HEADER = 'X-Export-Rows';
export const EXPORT_TRUNCATED_HEADER = 'X-Export-Truncated';

/**
 * Plataforma → Actividad: quién hizo qué, dónde y cuándo, en toda la plataforma (`GET /admin/audit`),
 * y la misma vista en CSV (`GET /admin/audit/export`).
 *
 * Sólo el superadmin, como el resto de la consola: `@Roles` deja fuera a los roles de nodo y
 * {@link SuperadminGuard} a `platform_admin`; admin_audit_events (0078) lo vuelve a exigir en la
 * base. Sólo lee: nunca vende ni cambia nada, salvo el rastro de la exportación.
 *
 * Exportar es de alto impacto (founder D1 = C): pide el 2FA de los últimos 10 minutos
 * (`@RequireRecentMfa`) y queda en la auditoría (`platform.audit.exported`).
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(AdminAuditQuerySchema)) query: AdminAuditQuery,
  ): Promise<AdminAuditPage> {
    return this.audit.list(userId, query);
  }

  /**
   * Hasta 5.000 eventos con estos filtros, los más nuevos, en CSV. `X-Export-Rows` dice cuántos y
   * `X-Export-Truncated: true` que había más.
   */
  @Get('export')
  @RequireRecentMfa()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(AdminAuditExportQuerySchema)) query: AdminAuditExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const out = await this.audit.exportCsv(userId, query);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader(EXPORT_ROWS_HEADER, String(out.rows));
    res.setHeader(EXPORT_TRUNCATED_HEADER, String(out.truncated));
    return out.csv;
  }
}
