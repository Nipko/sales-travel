import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { QuotationStatus } from '../database/database.types.js';
import { MailerService } from '../mail/mailer.service.js';
import { quotationEmailHtml } from '../mail/templates.js';
import { BrandingService } from '../branding/branding.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  CreateQuotationSchema,
  QuotationStatusSchema,
  UpdateQuotationCustomerSchema,
} from './dto.js';
import { QuotationsService, type CreateQuotationDto } from './quotations.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly db: DatabaseService,
    private readonly mailer: MailerService,
    private readonly branding: BrandingService,
  ) {}

  /** Envía la cotización por email al cliente (usa el BYO-email del tenant / fallback sistema). */
  @Post(':id/send-email')
  @HttpCode(200)
  async sendEmail(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<{ sent: boolean; to: string }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.findById(tenantId, id);
    if (!row) throw new NotFoundException();
    if (!row.customer_email) {
      throw new BadRequestException('La cotización no tiene email de cliente. Guardalo primero.');
    }
    const mail = quotationEmailHtml({
      quoteNumber: row.quote_number,
      customerName: row.customer_name,
      searchCriteria: row.search_criteria,
      selectedOffer: row.selected_offer,
      // El correo lo recibe el cliente final: lleva la marca de SU agencia.
      brand: await this.branding.resolve(tenantId),
    });
    const sent = await this.mailer.sendToTenant(tenantId, {
      to: row.customer_email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    return { sent, to: row.customer_email };
  }

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateQuotationSchema)) body: CreateQuotationDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.create(tenantId, userId, body);
    return { quotation: this.serialize(row) };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const rows = await this.quotations.findAll(tenantId);
    return { quotations: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.findById(tenantId, id);
    if (!row) throw new NotFoundException();
    return { quotation: this.serialize(row) };
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body('status', new ZodValidationPipe(QuotationStatusSchema)) status: QuotationStatus,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.updateStatus(tenantId, id, status);
    if (!row) throw new NotFoundException();
    return { quotation: this.serialize(row) };
  }

  @Patch(':id/customer')
  async updateCustomer(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateQuotationCustomerSchema))
    body: {
      customerName?: string | null;
      customerEmail?: string | null;
      customerPhone?: string | null;
      notes?: string | null;
    },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.quotations.updateCustomer(tenantId, id, body);
    if (!row) throw new NotFoundException();
    return { quotation: this.serialize(row) };
  }

  private serialize(row: {
    id: string;
    status: string;
    search_criteria: unknown;
    selected_offer: unknown;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    notes: string | null;
    quote_number: number;
    expires_at: Date;
    created_at: Date;
  }) {
    return {
      id: row.id,
      status: row.status,
      quoteNumber: row.quote_number,
      searchCriteria: row.search_criteria,
      selectedOffer: row.selected_offer,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      notes: row.notes,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private async resolveActiveTenant(userId: string): Promise<string> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
  }
}
