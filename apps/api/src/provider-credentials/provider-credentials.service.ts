import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { ProviderAccountStatus } from '../database/database.types.js';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.js';

/** Resultado interno de resolución BYOC. Incluye el secreto descifrado: NUNCA exponer por API. */
export interface ResolvedProviderAccount {
  id: string;
  /** Dueño real de la cuenta resuelta (el propio tenant, o un ancestro si fue heredada). */
  ownerTenantId: string;
  providerCode: string;
  label: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
  /** true si la cuenta provino de un ancestro (consolidador), no del propio tenant. */
  inherited: boolean;
}

interface ResolveRow {
  id: string | null;
  tenant_id: string | null;
  provider_code: string | null;
  label: string | null;
  credentials_enc: Buffer | null;
  config: unknown;
  status: ProviderAccountStatus | null;
}

@Injectable()
export class ProviderCredentialsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Resuelve la cuenta de proveedor a usar para (tenant, provider): la propia del
   * tenant o, si no tiene, la del ancestro heredable más cercano (consolidador).
   * Descifra el secreto. SOLO uso interno (llamadas a proveedores).
   */
  async resolve(tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> {
    const result = await sql<ResolveRow>`
      SELECT id, tenant_id, provider_code, label, credentials_enc, config, status
      FROM resolve_provider_account(${tenantId}::uuid, ${providerCode})
    `.execute(this.db.db);

    const row = result.rows[0];
    if (!row?.id || !row.credentials_enc || !row.tenant_id) {
      throw new NotFoundException(
        `no active provider account for '${providerCode}' resolvable from tenant ${tenantId}`,
      );
    }

    return {
      id: row.id,
      ownerTenantId: row.tenant_id,
      providerCode: row.provider_code ?? providerCode,
      label: row.label ?? 'default',
      config: (row.config ?? {}) as Record<string, unknown>,
      credentials: JSON.parse(decryptCredentials(row.credentials_enc)) as Record<string, unknown>,
      inherited: row.tenant_id !== tenantId,
    };
  }

  /** Crea o actualiza (upsert) una cuenta de proveedor del tenant. Cifra el secreto. */
  async upsert(input: {
    tenantId: string;
    providerCode: string;
    label?: string;
    credentials: Record<string, unknown>;
    config?: Record<string, unknown>;
    isInheritable?: boolean;
    status?: ProviderAccountStatus;
  }): Promise<{ id: string }> {
    const label = input.label ?? 'default';
    const enc = encryptCredentials(JSON.stringify(input.credentials));

    return this.db.withTenant(input.tenantId, async (trx) => {
      const existing = await trx
        .selectFrom('provider_accounts')
        .select('id')
        .where('tenant_id', '=', input.tenantId)
        .where('provider_code', '=', input.providerCode)
        .where('label', '=', label)
        .executeTakeFirst();

      if (existing) {
        await trx
          .updateTable('provider_accounts')
          .set({
            credentials_enc: enc,
            config: JSON.stringify(input.config ?? {}),
            is_inheritable: input.isInheritable ?? true,
            status: input.status ?? 'sandbox',
          })
          .where('id', '=', existing.id)
          .execute();
        return { id: existing.id };
      }

      const created = await trx
        .insertInto('provider_accounts')
        .values({
          tenant_id: input.tenantId,
          provider_code: input.providerCode,
          label,
          credentials_enc: enc,
          config: JSON.stringify(input.config ?? {}),
          is_inheritable: input.isInheritable ?? true,
          status: input.status ?? 'sandbox',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: created.id };
    });
  }

  /** Lista las cuentas del tenant SIN exponer el secreto. */
  async listSafe(tenantId: string) {
    const rows = await this.db.withTenant(tenantId, async (trx) =>
      trx
        .selectFrom('provider_accounts')
        .select([
          'id',
          'provider_code',
          'label',
          'config',
          'is_inheritable',
          'status',
          'created_at',
          'updated_at',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('provider_code')
        .execute(),
    );

    return rows.map((r) => ({
      id: r.id,
      providerCode: r.provider_code,
      label: r.label,
      config: (r.config ?? {}) as Record<string, unknown>,
      isInheritable: r.is_inheritable,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
