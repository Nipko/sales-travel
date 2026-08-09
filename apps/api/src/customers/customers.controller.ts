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
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CreateCustomerSchema, UpdateCustomerSchema } from './dto.js';
import {
  CustomersService,
  type CreateCustomerDto,
  type UpdateCustomerDto,
  type CustomerRow,
} from './customers.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.customers.create(tenantId, body);
    return { customer: this.serialize(row) };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const rows = await this.customers.findAll(tenantId);
    return { customers: rows.map((r) => this.serialize(r)) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
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
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.customers.update(tenantId, id, body);
    if (!row) throw new NotFoundException();
    return { customer: this.serialize(row) };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Delete(':id')
  async remove(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
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
}
