import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from '@sales-travel/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { ReconciliationService, type ReconciliationForced } from './reconciliation.service.js';

/** El dueño de la cuenta, que es quien concilia: la cuenta es suya y la corrida también. */
export const ReconciliationRequestSchema = z.object({ tenantId: z.string().uuid() }).strict();

const IdSchema = z.string().uuid();

/** Una corrida tal como sale por la API: conteos y códigos, nunca datos de reservas de nadie. */
export interface PublicReconciliationRun {
  readonly id: string;
  readonly trigger: string;
  readonly status: string;
  readonly windows: unknown;
  readonly rowsRead: number;
  readonly rowsMatched: number;
  readonly discrepancies: number;
  readonly summary: unknown;
  readonly errorClass: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface PublicReconciliationItem {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly severity: string;
  readonly action: string;
  readonly providerBookingId: string | null;
  readonly details: unknown;
  readonly createdAt: string;
}

/**
 * La conciliación de una cuenta de proveedor, desde el panel de su dueño (docs/tbo/09 PR-5.5;
 * D-TBO-24 A, D-TBO-27 A).
 *
 * - `POST /provider-accounts/:accountId/reconciliation`: el botón "forzar conciliación". Acorta la
 *   espera de una reserva que quedó bloqueada sin respuesta hasta la próxima corrida diaria. 202: la
 *   corrida se encola, o corre en segundo plano sin cola.
 * - `GET /provider-accounts/:accountId/reconciliation`: las últimas corridas y el reporte del dueño
 *   (reservas de la cuenta que no son de ninguna orden, R2, y divergencias de monto, R6).
 *
 * Sólo admins que gestionan el tenant dueño de la cuenta, como las credenciales. Lo que ve cada
 * agencia de lo que se concilió son los avisos sobre SUS órdenes, no esto.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('provider-accounts')
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly network: NetworkService,
  ) {}

  @Post(':accountId/reconciliation')
  @HttpCode(202)
  async force(
    @CurrentUser() userId: string | undefined,
    @Param('accountId', new ZodValidationPipe(IdSchema)) accountId: string,
    @Body(new ZodValidationPipe(ReconciliationRequestSchema)) body: { tenantId: string },
  ): Promise<ReconciliationForced> {
    const actor = await this.assertCanManage(userId, body.tenantId);
    return this.reconciliation.force(body.tenantId, accountId, actor);
  }

  @Get(':accountId/reconciliation')
  async report(
    @CurrentUser() userId: string | undefined,
    @Param('accountId', new ZodValidationPipe(IdSchema)) accountId: string,
    @Query('tenantId', new ZodValidationPipe(IdSchema)) tenantId: string,
  ): Promise<{ runs: PublicReconciliationRun[]; items: PublicReconciliationItem[] }> {
    await this.assertCanManage(userId, tenantId);
    const { runs, items } = await this.reconciliation.report(tenantId, accountId);
    return {
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        windows: r.windows,
        rowsRead: r.rowsRead,
        rowsMatched: r.rowsMatched,
        discrepancies: r.discrepancies,
        summary: r.summary,
        errorClass: r.errorClass,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
      items: items.map((i) => ({
        id: i.id,
        runId: i.runId,
        kind: i.kind,
        severity: i.severity,
        action: i.action,
        providerBookingId: i.providerBookingId,
        details: i.details,
        createdAt: i.createdAt.toISOString(),
      })),
    };
  }

  /** Mismo criterio que las credenciales: el tenant, o un ancestro que lo administra. */
  private async assertCanManage(userId: string | undefined, tenantId: string): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }
    return userId;
  }
}
