import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CrmTasksService, type CrmTaskRow } from './crm-tasks.service.js';
import {
  CreateTaskSchema,
  ReassignPortfolioSchema,
  type CreateTaskDto,
  type ReassignPortfolioDto,
} from './crm.schemas.js';

@Roles(...SELLING_ROLES)
@Controller('crm/tasks')
export class CrmTasksController {
  constructor(
    private readonly tasks: CrmTasksService,
    private readonly activeTenant: ActiveTenantService,
    private readonly network: NetworkService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateTaskSchema)) body: CreateTaskDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { task: serialize(await this.tasks.create(tenantId, body)) };
  }

  /** Tareas pendientes, primero lo vencido. La RLS acota a las propias si no sos admin. */
  @Get()
  async listPending(@CurrentUser() userId: string | undefined, @Query('limit') limit?: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const rows = await this.tasks.listPending(tenantId, Number(limit) || 50);
    return { tasks: rows.map(serialize) };
  }

  @Post(':id/complete')
  async complete(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.tasks.complete(tenantId, id);
    if (!row) throw new NotFoundException();
    return { task: serialize(row) };
  }

  /**
   * Traspasa la cartera de un vendedor a otro.
   *
   * Sólo admins del nodo: mover oportunidades entre vendedores es una decisión de
   * gestión, y ademas alcanza filas que el llamador no necesariamente ve.
   */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post('reassign')
  async reassign(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ReassignPortfolioSchema)) body: ReassignPortfolioDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }
    if (body.fromUserId === body.toUserId) {
      throw new ForbiddenException('el origen y el destino son el mismo usuario');
    }

    return this.tasks.reassignPortfolio(tenantId, body.fromUserId, body.toUserId);
  }
}

function serialize(row: CrmTaskRow) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    customerId: row.customer_id,
    assignedUserId: row.assigned_user_id,
    title: row.title,
    notes: row.notes,
    kind: row.kind,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    /** Vencida: el panel la resalta sin recalcular la fecha en cada fila. */
    overdue: row.completed_at === null && new Date(row.due_at).getTime() < Date.now(),
  };
}
