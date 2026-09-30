import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, NonRefundableRatesPermission } from '../database/database.types.js';
import {
  BookingPermissionsForbiddenError,
  rethrowBookingPermissionsError,
} from './booking-permissions.errors.js';
import type { UpdateBookingPermissionsDto } from './booking-permissions.schemas.js';

export const BOOKING_PERMISSION_EVENTS = {
  /** Quien financia al nodo cambió si puede reservar tarifas no reembolsables. */
  nonRefundableRatesChanged: 'booking.permissions.non_refundable_rates.changed',
} as const;

const AGGREGATE = 'tenant_booking_permissions';

/** De dónde viene un bloqueo que rige: el propio nodo o uno de arriba. */
export type NonRefundableRatesBlock = 'own' | 'inherited';

/** Lo que rige para un nodo al reservar. */
export interface NonRefundableRatesPolicy {
  /** `blocked` si el nodo o un ancestro lo bloqueó. */
  readonly effective: NonRefundableRatesPermission;
  readonly blockedBy?: NonRefundableRatesBlock;
}

/** El nodo cuyos permisos se gestionan. */
export interface BookingPermissionsNodeView {
  id: string;
  name: string;
  tenantType: string;
  isBranch: boolean;
  status: string;
}

/** Lo que ve quien financia al nodo en Gestión de Agencias o Mi Red. */
export interface FinancedBookingPermissionsView {
  tenant: BookingPermissionsNodeView;
  nonRefundableRates: {
    /** Lo que se fijó para ESTE nodo. Sin fila, `allowed`. */
    setting: NonRefundableRatesPermission;
    /** Lo que rige: `blocked` también si lo bloquea un ancestro. */
    effective: NonRefundableRatesPermission;
    /** Un nivel de arriba lo bloquea: cambiar `setting` no lo habilita. */
    inheritedBlock: boolean;
    /** Cuándo y quién fijó el valor vigente; `null` si nunca se fijó. */
    updatedAt: string | null;
    updatedByName: string | null;
  };
}

interface NodeRow {
  id: string;
  name: string;
  tenant_type: string;
  is_branch: boolean;
  status: string;
  allowed: boolean;
}

/**
 * Los permisos de reserva de un nodo, que fija QUIEN LO FINANCIA (pedido del founder del 2026-09-29,
 * tarifas no reembolsables, punto e; mismo modelo que las carteras, db/migrations/0052 y 0055): por
 * ahora, "Puede reservar tarifas no reembolsables". Permitido por defecto, con la confirmación
 * obligatoria del checkout; bloqueado, la API rechaza el PreBook y el Book de una no reembolsable.
 *
 * Quién financia a quién lo decide la base (`can_finance_tenant`). Este servicio lo pregunta antes de
 * escribir para responder 403 con motivo, y la RLS de 0055 lo vuelve a exigir en la escritura. Cada
 * cambio corre con `withRequestContext({ userId: quien actúa, tenantId: el nodo })` y deja su
 * `domain_event` en la misma transacción: sin rastro, no entra.
 */
@Injectable()
export class BookingPermissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lo que rige para el tenant que reserva. Corre con SU tenant: `non_refundable_rates_block` sólo
   * responde por un nodo visible, y lanza por cualquier otro (una llamada mal cableada no puede leer
   * "permitido"). Un fallo de lectura sube: la reserva no sigue sin saber si está bloqueada.
   */
  async nonRefundableRates(tenantId: string): Promise<NonRefundableRatesPolicy> {
    const block = await this.db.withTenant(tenantId, (trx) => blockOf(trx, tenantId));
    return block === null ? { effective: 'allowed' } : { effective: 'blocked', blockedBy: block };
  }

  /** Lo que ve quien financia al nodo. */
  async financedView(
    actorUserId: string,
    tenantId: string,
  ): Promise<FinancedBookingPermissionsView> {
    return this.run(actorUserId, tenantId, (trx, node) => this.viewOf(trx, node));
  }

  /**
   * Fija si el nodo puede reservar tarifas no reembolsables. Lo que no cambia no se escribe ni se
   * audita: el panel puede reenviar el mismo valor.
   */
  async setNonRefundableRates(
    actorUserId: string,
    tenantId: string,
    input: UpdateBookingPermissionsDto,
  ): Promise<FinancedBookingPermissionsView> {
    return this.run(actorUserId, tenantId, async (trx, node) => {
      const current = await trx
        .selectFrom('tenant_booking_permissions')
        .select('non_refundable_rates')
        .where('tenant_id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst();
      // Sin fila rige `allowed`: fijar `allowed` sobre nada no cambia nada y no se escribe.
      const from: NonRefundableRatesPermission = current?.non_refundable_rates ?? 'allowed';
      if (from === input.nonRefundableRates) return this.viewOf(trx, node);

      await trx
        .insertInto('tenant_booking_permissions')
        .values({
          tenant_id: tenantId,
          non_refundable_rates: input.nonRefundableRates,
          updated_by: actorUserId,
        })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet({
            non_refundable_rates: input.nonRefundableRates,
            updated_by: actorUserId,
          }),
        )
        .execute();

      await this.audit.emitWithin(trx, {
        eventType: BOOKING_PERMISSION_EVENTS.nonRefundableRatesChanged,
        tenantId,
        actorUserId,
        aggregateType: AGGREGATE,
        aggregateId: tenantId,
        payload: {
          from,
          to: input.nonRefundableRates,
          reason: input.reason,
          source: 'api',
        },
      });
      return this.viewOf(trx, node);
    });
  }

  // ───────────────────────────── Internos ─────────────────────────────

  private async run<T>(
    actorUserId: string,
    tenantId: string,
    fn: (trx: Transaction<DB>, node: BookingPermissionsNodeView) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.withRequestContext({ userId: actorUserId, tenantId }, async (trx) =>
        fn(trx, await this.financedNode(trx, tenantId)),
      );
    } catch (error) {
      return rethrowBookingPermissionsError(error);
    }
  }

  /**
   * El nodo, si quien actúa lo financia. Uno que no existe responde lo mismo que uno ajeno: 403, sin
   * confirmar qué ids existen fuera de la red de quien pregunta.
   */
  private async financedNode(
    trx: Transaction<DB>,
    tenantId: string,
  ): Promise<BookingPermissionsNodeView> {
    const row: NodeRow | undefined = await trx
      .selectFrom('tenants')
      .select([
        'id',
        'name',
        'tenant_type',
        'is_branch',
        'status',
        sql<boolean>`can_finance_tenant(id)`.as('allowed'),
      ])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row?.allowed !== true) {
      throw new BookingPermissionsForbiddenError('BOOKING_PERMISSIONS_FINANCIER_REQUIRED');
    }
    return {
      id: row.id,
      name: row.name,
      tenantType: row.tenant_type,
      isBranch: row.is_branch,
      status: row.status,
    };
  }

  private async viewOf(
    trx: Transaction<DB>,
    node: BookingPermissionsNodeView,
  ): Promise<FinancedBookingPermissionsView> {
    const row = await trx
      .selectFrom('tenant_booking_permissions as p')
      .leftJoin('users as u', 'u.id', 'p.updated_by')
      .select(['p.non_refundable_rates', 'p.updated_at', 'u.name as updated_by_name'])
      .where('p.tenant_id', '=', node.id)
      .executeTakeFirst();
    const block = await blockOf(trx, node.id);
    const setting: NonRefundableRatesPermission = row?.non_refundable_rates ?? 'allowed';
    return {
      tenant: node,
      nonRefundableRates: {
        setting,
        effective: block === null ? 'allowed' : 'blocked',
        inheritedBlock: block === 'inherited',
        updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
        updatedByName: row?.updated_by_name ?? null,
      },
    };
  }
}

async function blockOf(
  trx: Transaction<DB>,
  tenantId: string,
): Promise<NonRefundableRatesBlock | null> {
  const { rows } = await sql<{
    block: string | null;
  }>`SELECT non_refundable_rates_block(${tenantId}::uuid) AS block`.execute(trx);
  const block = rows[0]?.block ?? null;
  if (block === null) return null;
  // Un valor que la función no devuelve no se lee como "permitido".
  return block === 'own' ? 'own' : 'inherited';
}
