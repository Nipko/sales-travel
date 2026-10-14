import { Controller, Get, Header, Param, Query, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { EXPORT_ROWS_HEADER, EXPORT_TRUNCATED_HEADER } from '../audit/admin-audit.controller.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  PlatformUsersExportQuerySchema,
  TenantIdParamSchema,
  type PlatformUsersExportQuery,
} from './dto.js';
import { TenantNotManagedError } from './tenant-admin.policy.js';
import { UserExportService, type UsersExport } from './user-export.service.js';

/** Cuántas personas trae el archivo (las filas son una por persona y nodo: `X-Export-Rows`). */
export const EXPORT_USERS_HEADER = 'X-Export-Users';

/**
 * Exportar la lista de usuarios a CSV (USR-16):
 *
 *   - `GET /admin/exports/users?<los filtros del directorio>`: Plataforma → Usuarios, sólo el
 *     superadmin (la misma puerta que `GET /admin/users`);
 *   - `GET /tenants/:id/members-export`: el equipo del nodo, para quien lo administra
 *     (`canManageTenant`, como Equipo).
 *
 * Las rutas no terminan en `.csv`: un borde que guarda en caché por extensión no tiene que poder
 * quedarse con una lista de personas. Tampoco cuelgan de `/admin/users/…` ni de
 * `/tenants/:id/members/…`, que son la ficha de una persona (`:userId`).
 *
 * Exportar es de alto impacto (founder D1 = C): pide el 2FA de los últimos 10 minutos
 * (`@RequireRecentMfa`) y queda en la auditoría (`users.exported`). Como mucho 5 por minuto.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller()
export class UserExportController {
  constructor(
    private readonly exports: UserExportService,
    private readonly network: NetworkService,
  ) {}

  @Get('admin/exports/users')
  @RequireRecentMfa()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Header('Cache-Control', 'no-store')
  async exportPlatform(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(PlatformUsersExportQuerySchema)) query: PlatformUsersExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) throw new SuperadminRequiredError();
    return send(res, await this.exports.exportPlatform(userId, query));
  }

  @Get('tenants/:id/members-export')
  @RequireRecentMfa()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Header('Cache-Control', 'no-store')
  async exportTeam(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new TenantNotManagedError();
    }
    return send(res, await this.exports.exportTeam(userId, tenantId));
  }
}

/**
 * Las cabeceras de la descarga (las lee el panel) y el archivo. El tipo va acá y no en `@Header`: un
 * error del handler (403, 401) sale como el JSON que es, no rotulado como CSV.
 */
function send(res: Response, out: UsersExport): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader(EXPORT_USERS_HEADER, String(out.users));
  res.setHeader(EXPORT_ROWS_HEADER, String(out.rows));
  res.setHeader(EXPORT_TRUNCATED_HEADER, String(out.truncated));
  return out.csv;
}
