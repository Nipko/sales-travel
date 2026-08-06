import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TestEmailSchema, type TestEmailDto } from './dto.js';
import { MailerService, type MailTestResult } from './mailer.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';

@Roles(...AGENCY_ADMIN_ROLES)
@Controller('mail')
export class MailController {
  constructor(
    private readonly mailer: MailerService,
    private readonly network: NetworkService,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Envía un correo de prueba al email del admin autenticado usando el remitente que se
   * resolvería para `tenantId` (propio/heredado/sistema). Sólo admins del nodo. Rate-limited.
   */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('test')
  @HttpCode(200)
  async test(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(TestEmailSchema)) body: TestEmailDto,
  ): Promise<MailTestResult & { to: string }> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.canManageTenant(userId, body.tenantId))) {
      throw new ForbiddenException('not authorized to manage this tenant');
    }
    const user = await this.db.db
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException();

    const result = await this.mailer.sendTest(body.tenantId, user.email);
    await this.audit.emit({
      eventType: 'mail.test',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: body.tenantId,
      payload: { sent: result.sent },
    });
    return { ...result, to: user.email };
  }
}
