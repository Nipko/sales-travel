import { Body, Controller, Delete, ForbiddenException, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AddPackageItemSchema,
  CreatePackageSchema,
  type AddPackageItemDto,
  type CreatePackageDto,
} from './packages.schemas.js';
import { PackagesService, type PackageItemRow, type PackageRow } from './packages.service.js';

/**
 * Cotización multi-producto: vuelo + hotel + auto en un solo presupuesto.
 *
 * Sin esto, un vendedor que armaba un viaje completo mandaba tres cotizaciones sueltas
 * y sumaba a mano — justo lo que un consolidador debería evitarle.
 */
@Roles(...SELLING_ROLES)
@Controller('packages')
export class PackagesController {
  constructor(
    private readonly packages: PackagesService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreatePackageSchema)) body: CreatePackageDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { package: serializePackage(await this.packages.create(tenantId, userId, body)) };
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const rows = await this.packages.findAll(tenantId);
    return { packages: rows.map(serializePackage) };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const { pkg, items } = await this.packages.findById(tenantId, id);
    return { package: serializePackage(pkg), items: items.map(serializeItem) };
  }

  @Post(':id/items')
  async addItem(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddPackageItemSchema)) body: AddPackageItemDto,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { package: serializePackage(await this.packages.addItem(tenantId, id, body)) };
  }

  @Delete(':id/items/:itemId')
  async removeItem(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    return { package: serializePackage(await this.packages.removeItem(tenantId, id, itemId)) };
  }
}

function serializePackage(row: PackageRow) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    // BIGINT llega como string desde el driver: se normaliza para que el cliente no
    // tenga que adivinar el tipo según el tamaño del número.
    totalAmountMinor: Number(row.total_amount_minor),
    currency: row.currency,
    customerId: row.customer_id,
    notes: row.notes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function serializeItem(row: PackageItemRow) {
  return {
    id: row.id,
    vertical: row.vertical,
    providerName: row.provider_name,
    providerItemId: row.provider_item_id,
    details: row.raw_details,
    baseFareMinor: Number(row.base_fare_minor),
    taxesMinor: Number(row.taxes_minor),
    // El markup del ítem NO se expone: es el margen de la red sobre esta agencia.
    totalMinor: Number(row.total_minor),
  };
}
