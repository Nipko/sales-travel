import { Injectable } from '@nestjs/common';
import { type UpdateObject } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { type DB } from '../database/database.types.js';

export interface CreateCustomerDto {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  documentType: string;
  documentNumber: string;
  documentIssuingCountry: string;
  birthdate: string | Date;
  gender: string;
  nationality: string;
  passportExpiry?: string | Date | null;
  preferences?: unknown;
}

export interface UpdateCustomerDto {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  documentType?: string;
  documentNumber?: string;
  documentIssuingCountry?: string;
  birthdate?: string | Date;
  gender?: string;
  nationality?: string;
  passportExpiry?: string | Date | null;
  preferences?: unknown;
}

export interface CustomerRow {
  id: string;
  tenant_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  document_type: string;
  document_number: string;
  document_issuing_country: string;
  birthdate: Date;
  gender: string;
  nationality: string;
  passport_expiry: Date | null;
  preferences: unknown;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class CustomersService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, dto: CreateCustomerDto): Promise<CustomerRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .insertInto('customers')
        .values({
          tenant_id: tenantId,
          first_name: dto.firstName,
          last_name: dto.lastName,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          document_type: dto.documentType,
          document_number: dto.documentNumber,
          document_issuing_country: dto.documentIssuingCountry,
          birthdate: new Date(dto.birthdate),
          gender: dto.gender,
          nationality: dto.nationality,
          passport_expiry: dto.passportExpiry ? new Date(dto.passportExpiry) : null,
          preferences: dto.preferences ? JSON.stringify(dto.preferences) : '{}',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as CustomerRow;
    });
  }

  async findAll(tenantId: string): Promise<CustomerRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('customers')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();
      return rows as unknown as CustomerRow[];
    });
  }

  async findById(tenantId: string, id: string): Promise<CustomerRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('customers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row as unknown as CustomerRow | undefined;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const updateData: UpdateObject<DB, 'customers'> = {};
      if (dto.firstName !== undefined) updateData.first_name = dto.firstName;
      if (dto.lastName !== undefined) updateData.last_name = dto.lastName;
      if (dto.email !== undefined) updateData.email = dto.email;
      if (dto.phone !== undefined) updateData.phone = dto.phone;
      if (dto.documentType !== undefined) updateData.document_type = dto.documentType;
      if (dto.documentNumber !== undefined) updateData.document_number = dto.documentNumber;
      if (dto.documentIssuingCountry !== undefined)
        updateData.document_issuing_country = dto.documentIssuingCountry;
      if (dto.birthdate !== undefined) updateData.birthdate = new Date(dto.birthdate);
      if (dto.gender !== undefined) updateData.gender = dto.gender;
      if (dto.nationality !== undefined) updateData.nationality = dto.nationality;
      if (dto.passportExpiry !== undefined)
        updateData.passport_expiry = dto.passportExpiry ? new Date(dto.passportExpiry) : null;
      if (dto.preferences !== undefined) updateData.preferences = JSON.stringify(dto.preferences);

      const row = await trx
        .updateTable('customers')
        .set(updateData)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row as unknown as CustomerRow | undefined;
    });
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const result = await trx.deleteFrom('customers').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }
}
