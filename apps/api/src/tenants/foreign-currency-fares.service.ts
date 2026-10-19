import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';

/** Lo que el panel del superadmin muestra y cambia. */
export interface ForeignCurrencyFaresView {
  tenantId: string;
  enabled: boolean;
  /** La moneda de venta de la agencia: la que deja de ser obligatoria con `enabled`. */
  currency: string;
}

/**
 * Tarifas de vuelo en otra moneda que la de la agencia (migración 0087).
 *
 * Es un interruptor de pruebas: con él la búsqueda deja de descartar las tarifas en otra moneda
 * (ver `SaleCurrencyPolicy` en search.service.ts). Por nodo y sin herencia, para que encenderlo en
 * la agencia de pruebas no lo encienda en toda la red. Sólo el superadmin lo cambia; cada cambio
 * deja `tenant.foreign_currency_fares.updated` con el antes y el después.
 */
@Injectable()
export class ForeignCurrencyFaresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async read(actorUserId: string, tenantId: string): Promise<ForeignCurrencyFaresView> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const row = await trx
        .selectFrom('tenants')
        .select(['id', 'foreign_currency_fares', 'default_currency'])
        .where('id', '=', tenantId)
        .executeTakeFirst();
      if (!row) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
      return toView(row);
    });
  }

  async update(
    actorUserId: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<ForeignCurrencyFaresView> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const before = await trx
        .selectFrom('tenants')
        .select(['id', 'foreign_currency_fares', 'default_currency'])
        .where('id', '=', tenantId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!before) throw new TenantHierarchyNotFoundError('TENANT_NOT_FOUND');
      if (before.foreign_currency_fares === enabled) return toView(before);

      await trx
        .updateTable('tenants')
        .set({ foreign_currency_fares: enabled })
        .where('id', '=', tenantId)
        .execute();

      await this.audit.emitWithin(trx, {
        eventType: 'tenant.foreign_currency_fares.updated',
        tenantId,
        actorUserId,
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: { before: before.foreign_currency_fares, after: enabled },
      });

      return toView({ ...before, foreign_currency_fares: enabled });
    });
  }
}

function toView(row: {
  id: string;
  foreign_currency_fares: boolean;
  default_currency: string;
}): ForeignCurrencyFaresView {
  return {
    tenantId: row.id,
    enabled: row.foreign_currency_fares,
    currency: row.default_currency.trim().toUpperCase(),
  };
}
