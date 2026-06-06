import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CreateCustomerSchema, UpdateCustomerSchema } from './dto.js';
import {
  CustomersService,
  type CreateCustomerDto,
  type UpdateCustomerDto,
  type CustomerRow,
} from './customers.service.js';

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.customers.create(tenantId, body);
    return { customer: this.serialize(row) };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const rows = await this.customers.findAll(tenantId);
    return { customers: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.customers.findById(tenantId, id);
    if (!row) throw new NotFoundException();
    return { customer: this.serialize(row) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCustomerSchema)) body: UpdateCustomerDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const row = await this.customers.update(tenantId, id, body);
    if (!row) throw new NotFoundException();
    return { customer: this.serialize(row) };
  }

  @Delete(':id')
  async remove(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.resolveActiveTenant(userId);
    const deleted = await this.customers.remove(tenantId, id);
    if (!deleted) throw new NotFoundException();
    return { success: true };
  }

  private serialize(row: CustomerRow) {
    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      documentType: row.document_type,
      documentNumber: row.document_number,
      documentIssuingCountry: row.document_issuing_country,
      birthdate: row.birthdate,
      gender: row.gender,
      nationality: row.nationality,
      passportExpiry: row.passport_expiry,
      preferences:
        typeof row.preferences === 'string'
          ? (JSON.parse(row.preferences) as unknown)
          : row.preferences,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
