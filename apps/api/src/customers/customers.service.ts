import { Injectable } from '@nestjs/common';
import { sql, type UpdateObject } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { type DB } from '../database/database.types.js';
import { blindIndex, decryptPii, encryptPii } from './pii-cipher.js';

interface RawCustomer {
  document_number: string | null;
  document_number_enc: Buffer | null;
  document_number_hash: string | null;
  [k: string]: unknown;
}

/** Descifra el documento (o usa el plano legacy) y quita las columnas internas enc/hash. */
function toCustomerRow(raw: RawCustomer): CustomerRow {
  let documentNumber = '';
  if (raw.document_number_enc) {
    try {
      documentNumber = decryptPii(raw.document_number_enc);
    } catch {
      documentNumber = '';
    }
  } else {
    documentNumber = raw.document_number ?? '';
  }
  const { document_number_enc, document_number_hash, ...rest } = raw;
  void document_number_enc;
  void document_number_hash;
  return { ...rest, document_number: documentNumber } as unknown as CustomerRow;
}

export interface CreateCustomerDto {
  customerType?: 'person' | 'company';
  firstName: string;
  lastName: string;
  address?: string | null;
  city?: string | null;
  countryCode?: string | null;
  email?: string | null;
  phone?: string | null;
  documentType: string;
  documentNumber: string;
  documentIssuingCountry: string;
  birthdate?: string | Date | null;
  gender?: string | null;
  nationality?: string | null;
  passportExpiry?: string | Date | null;
  preferences?: unknown;
}

export interface UpdateCustomerDto {
  customerType?: 'person' | 'company';
  address?: string | null;
  city?: string | null;
  countryCode?: string | null;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  documentType?: string;
  documentNumber?: string;
  documentIssuingCountry?: string;
  birthdate?: string | Date | null;
  gender?: string | null;
  nationality?: string | null;
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
  birthdate: Date | null;
  gender: string | null;
  nationality: string | null;
  customer_type: 'person' | 'company';
  address: string | null;
  city: string | null;
  country_code: string | null;
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
          // PII cifrada: el documento va en _enc, su blind index en _hash; sin plano.
          document_number: null,
          document_number_enc: encryptPii(dto.documentNumber),
          document_number_hash: blindIndex(dto.documentNumber),
          document_issuing_country: dto.documentIssuingCountry,
          birthdate: dto.birthdate ? new Date(dto.birthdate) : null,
          gender: dto.gender ?? null,
          nationality: dto.nationality ?? null,
          customer_type: dto.customerType ?? 'person',
          address: dto.address ?? null,
          city: dto.city ?? null,
          country_code: dto.countryCode ?? null,
          passport_expiry: dto.passportExpiry ? new Date(dto.passportExpiry) : null,
          preferences: dto.preferences ? JSON.stringify(dto.preferences) : '{}',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toCustomerRow(row);
    });
  }

  async findAll(tenantId: string): Promise<CustomerRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('customers')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => toCustomerRow(r));
    });
  }

  /**
   * Clientes registrados que coinciden con `q`: por nombre o email (contiene, sin mayúsculas), o por
   * número de documento EXACTO —el documento va cifrado y sólo se puede buscar por su índice ciego—.
   */
  async search(tenantId: string, q: string, limit: number): Promise<CustomerRow[]> {
    // Los comodines de ILIKE que escriba el vendedor se buscan literales.
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const hash = blindIndex(q);
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('customers')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('document_number_hash', '=', hash),
            eb(sql<string>`first_name || ' ' || last_name`, 'ilike', like),
            eb('email', 'ilike', like),
          ]),
        )
        .orderBy('updated_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => toCustomerRow(r));
    });
  }

  /**
   * Alta o actualización por documento (tipo + número) dentro del tenant: lo usa la reserva para
   * guardar en Clientes al pasajero o al facturador que el vendedor escribió. Si ya existe, se
   * actualizan sólo los campos que llegan con valor (no se borra nada que el CRM ya tenía).
   */
  async upsertByDocument(
    tenantId: string,
    dto: CreateCustomerDto,
  ): Promise<{ customer: CustomerRow; created: boolean }> {
    const hash = blindIndex(dto.documentNumber);
    const existing = await this.db.withTenant(tenantId, (trx) =>
      trx
        .selectFrom('customers')
        .select('id')
        .where('document_type', '=', dto.documentType)
        .where('document_number_hash', '=', hash)
        .orderBy('updated_at', 'desc')
        .executeTakeFirst(),
    );
    if (!existing) return { customer: await this.create(tenantId, dto), created: true };
    const patch: UpdateCustomerDto = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined && v !== null && v !== '') (patch as Record<string, unknown>)[k] = v;
    }
    const updated = await this.update(tenantId, existing.id, patch);
    return { customer: updated!, created: false };
  }

  async findById(tenantId: string, id: string): Promise<CustomerRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('customers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toCustomerRow(row) : undefined;
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
      if (dto.documentNumber !== undefined) {
        updateData.document_number = null;
        updateData.document_number_enc = encryptPii(dto.documentNumber);
        updateData.document_number_hash = blindIndex(dto.documentNumber);
      }
      if (dto.documentIssuingCountry !== undefined)
        updateData.document_issuing_country = dto.documentIssuingCountry;
      if (dto.birthdate !== undefined)
        updateData.birthdate = dto.birthdate ? new Date(dto.birthdate) : null;
      if (dto.customerType !== undefined) updateData.customer_type = dto.customerType;
      if (dto.address !== undefined) updateData.address = dto.address;
      if (dto.city !== undefined) updateData.city = dto.city;
      if (dto.countryCode !== undefined) updateData.country_code = dto.countryCode;
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
      return row ? toCustomerRow(row) : undefined;
    });
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const result = await trx.deleteFrom('customers').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }
}
