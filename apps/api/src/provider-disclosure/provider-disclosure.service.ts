import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import {
  DISCLOSURE_DEFAULT,
  foldDisclosure,
  type DisclosureNode,
  type DisclosureView,
} from './provider-disclosure.policy.js';

interface ChainRow {
  tenant_id: string;
  lvl: number;
  show_provider_in_results: boolean | null;
}

function toNode(row: ChainRow): DisclosureNode {
  return {
    tenantId: row.tenant_id,
    depth: Number(row.lvl),
    showProviderInResults: row.show_provider_in_results,
  };
}

/**
 * Quién puede ver de qué proveedor viene cada oferta.
 *
 * La cadena de ancestros se lee con `provider_disclosure_chain` (0036, SECURITY DEFINER)
 * porque la RLS del tenant activo no llega a las filas de sus ancestros; el plegado vive en
 * `provider-disclosure.policy.ts`.
 */
@Injectable()
export class ProviderDisclosureService {
  private readonly logger = new Logger(ProviderDisclosureService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Vista completa: lo efectivo, lo propio y si un ancestro lo tiene bloqueado. */
  async view(tenantId: string): Promise<DisclosureView> {
    const res = await sql<ChainRow>`
      SELECT * FROM provider_disclosure_chain(${tenantId}::uuid)
    `.execute(this.db.db);

    return foldDisclosure(tenantId, res.rows.map(toNode));
  }

  /**
   * Sólo el booleano, para el camino de búsqueda.
   *
   * Un fallo acá NO puede tumbar una búsqueda: el vendedor está frente a un cliente y la
   * lista de vuelos importa más que la etiqueta del proveedor. Se cae al default, que es
   * ocultar: ante la duda, no se filtra de dónde compra el consolidador.
   */
  async effective(tenantId: string): Promise<boolean> {
    try {
      return (await this.view(tenantId)).effective;
    } catch (err) {
      this.logger.warn(
        `no se pudo resolver la divulgación de proveedor: ${(err as Error).message}`,
      );
      return DISCLOSURE_DEFAULT;
    }
  }

  /**
   * Fija el valor PROPIO del tenant. `null` vuelve a heredar.
   *
   * Devuelve la vista ya recalculada: guardar `true` bajo un consolidador que lo oculta
   * deja el ajuste guardado pero sin efecto, y la pantalla tiene que poder decirlo.
   * La AUTORIZACIÓN se valida en el controlador antes de llamar.
   */
  async setOwn(tenantId: string, value: boolean | null, userId: string): Promise<DisclosureView> {
    await this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await trx
        .updateTable('tenants')
        .set({ show_provider_in_results: value })
        .where('id', '=', tenantId)
        .execute();
    });

    return this.view(tenantId);
  }
}
