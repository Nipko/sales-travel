import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { ProviderAccountStatus } from '../database/database.types.js';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.js';
import {
  accountReadiness,
  safeConfigView,
  type ProviderAccountReadiness,
} from './provider-specs.js';

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
  /** Última actualización de la cuenta resuelta — útil para invalidar caches de credenciales. */
  updatedAt: Date;
}

interface ResolveRow {
  id: string | null;
  tenant_id: string | null;
  provider_code: string | null;
  label: string | null;
  credentials_enc: Buffer | null;
  config: unknown;
  status: ProviderAccountStatus | null;
  updated_at: Date | null;
}

/** Fila del listado. NUNCA lleva el secreto: sólo metadata y NOMBRES de campo. */
export interface SafeProviderAccount {
  id: string;
  providerCode: string;
  label: string;
  /** Sólo las claves de `config` declaradas seguras para este proveedor. */
  config: Record<string, unknown>;
  /** Nombres —nunca valores— de las claves de `config` que no se devuelven. */
  redactedConfigKeys: readonly string[];
  /** `false` ⇒ el proveedor no declara lista blanca: no se sabe qué es seguro mostrar. */
  configVerified: boolean;
  /** Qué se sabe sobre si la cuenta puede autenticar. `unknown` = no se sabe, no "está bien". */
  readiness: ProviderAccountReadiness;
  /** Campos obligatorios que faltan, por NOMBRE. Vacío salvo en `incomplete`. */
  missingRequiredFields: readonly string[];
  isInheritable: boolean;
  status: ProviderAccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProviderCredentialsService {
  private readonly logger = new Logger(ProviderCredentialsService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Resuelve la cuenta de proveedor a usar para (tenant, provider): la propia del
   * tenant o, si no tiene, la del ancestro heredable más cercano (consolidador).
   * Descifra el secreto. SOLO uso interno (llamadas a proveedores).
   */
  async resolve(tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> {
    const result = await sql<ResolveRow>`
      SELECT id, tenant_id, provider_code, label, credentials_enc, config, status, updated_at
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
      updatedAt: row.updated_at ?? new Date(0),
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

  /**
   * Lista las cuentas del tenant SIN exponer el secreto.
   *
   * `config` NO sale verbatim. Es un JSONB en claro y por API se le puede meter cualquier cosa
   * —un `epr`, una contraseña—, así que se filtra por la lista blanca declarada del proveedor y
   * lo que no está declarado sale sólo como NOMBRE de clave (ver `safeConfigView`).
   *
   * El blob cifrado se descifra acá para saber QUÉ CLAVES trae y poder decir si la cuenta está
   * completa. Sólo se leen los nombres: el texto plano no sale de este método ni entra en ningún
   * log. Es la única forma de contestar la pregunta, porque una cuenta incompleta nunca llega a
   * `resolve` (que además filtra por `status = 'active'`).
   */
  async listSafe(tenantId: string): Promise<SafeProviderAccount[]> {
    const rows = await this.db.withTenant(tenantId, async (trx) =>
      trx
        .selectFrom('provider_accounts')
        .select([
          'id',
          'provider_code',
          'label',
          'config',
          'credentials_enc',
          'is_inheritable',
          'status',
          'created_at',
          'updated_at',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('provider_code')
        .execute(),
    );

    return rows.map((r) => {
      const config = (r.config ?? {}) as Record<string, unknown>;
      const view = safeConfigView(r.provider_code, config);
      const completeness = accountReadiness(
        r.provider_code,
        this.credentialKeyNames(r.credentials_enc, r.id, r.provider_code),
        config,
      );

      return {
        id: r.id,
        providerCode: r.provider_code,
        label: r.label,
        config: view.config,
        redactedConfigKeys: view.redactedConfigKeys,
        configVerified: view.configVerified,
        readiness: completeness.readiness,
        missingRequiredFields: completeness.missingRequiredFields,
        isInheritable: r.is_inheritable,
        status: r.status,
        createdAt: r.created_at as unknown as Date,
        updatedAt: r.updated_at as unknown as Date,
      };
    });
  }

  /**
   * NOMBRES de las credenciales que traen valor útil, o `null` si el blob no se pudo leer
   * (clave rotada, cifrado corrupto). `null` es "no sé", y quien lo consume no puede convertirlo
   * en "está completa".
   *
   * El `catch` no propaga a propósito: una cuenta ilegible no puede tumbar el listado entero de
   * la agencia, que es justo la pantalla desde la que se arregla.
   */
  private credentialKeyNames(
    blob: Buffer,
    accountId: string,
    providerCode: string,
  ): readonly string[] | null {
    try {
      const parsed: unknown = JSON.parse(decryptCredentials(blob));
      if (typeof parsed !== 'object' || parsed === null) return null;
      return Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .map(([key]) => key);
    } catch {
      // Ni el error ni el blob entran en el log: sólo qué cuenta y de qué proveedor.
      this.logger.warn(
        `credenciales ilegibles en la cuenta ${accountId} (${providerCode}): completitud desconocida`,
      );
      return null;
    }
  }
}
