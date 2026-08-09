import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { applyCascade, PricingService } from '../pricing/pricing.service.js';
import { currentContext } from '../request-context/request-context.js';
import type { AddPackageItemDto, CreatePackageDto } from './packages.schemas.js';

/** Vigencia por defecto de una cotización de paquete. */
const DEFAULT_TTL_DAYS = 7;

export interface PackageItemRow {
  id: string;
  vertical: string;
  provider_name: string;
  provider_item_id: string;
  raw_details: unknown;
  base_fare_minor: string | number;
  taxes_minor: string | number;
  markup_minor: string | number;
  total_minor: string | number;
}

export interface PackageRow {
  id: string;
  status: string;
  title: string;
  total_amount_minor: string | number;
  currency: string;
  customer_id: string | null;
  notes: string | null;
  expires_at: Date;
  created_at: Date;
}

/**
 * Cotización multi-producto: vuelo + hotel + auto en un solo presupuesto.
 *
 * CLAUDE.md declara el Package Studio "el corazón del producto", y las tablas
 * `package_quotations`/`package_items` existían desde 0010 — pero SIN una sola línea de
 * código que las usara. En la práctica un vendedor que armaba un viaje completo tenía
 * que mandar tres cotizaciones sueltas y sumar a mano, que es exactamente lo que un
 * consolidador debería evitarle.
 *
 * Esto es la base: composición, precio y persistencia. El lienzo drag-and-drop se monta
 * encima de estos endpoints.
 */
@Injectable()
export class PackagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
  ) {}

  async create(tenantId: string, userId: string, dto: CreatePackageDto): Promise<PackageRow> {
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60_000);

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const row = await trx
        .insertInto('package_quotations')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          title: dto.title,
          currency: dto.currency,
          customer_id: dto.customerId ?? null,
          notes: dto.notes ?? null,
          expires_at: expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as unknown as PackageRow;
    });
  }

  /**
   * Agrega un ítem y RECALCULA el total del paquete en la base.
   *
   * El markup se aplica por ítem con las reglas de SU vertical: el consolidador puede
   * cobrar distinto sobre vuelos que sobre hoteles, y un markup global al paquete
   * borraría esa diferencia. El total se recalcula sumando los ítems en SQL, no
   * acumulando en la app: así no se desincroniza si un ítem se borra.
   */
  async addItem(tenantId: string, packageId: string, dto: AddPackageItemDto): Promise<PackageRow> {
    const userId = currentContext()?.userId;
    const rules = await this.pricing.getApplicableRules(tenantId, dto.vertical);
    const waterfall = applyCascade(dto.baseFareMinor + dto.taxesMinor, rules);

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const pkg = await trx
        .selectFrom('package_quotations')
        .select('id')
        .where('id', '=', packageId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!pkg) throw new NotFoundException('paquete no encontrado');

      await trx
        .insertInto('package_items')
        .values({
          package_id: packageId,
          vertical: dto.vertical,
          provider_name: dto.providerName,
          provider_item_id: dto.providerItemId,
          raw_details: JSON.stringify(dto.rawDetails ?? {}),
          base_fare_minor: dto.baseFareMinor,
          taxes_minor: dto.taxesMinor,
          markup_minor: waterfall.totalMarkupMinor,
          total_minor: waterfall.finalMinor,
        })
        .execute();

      return this.recalculate(trx, tenantId, packageId);
    });
  }

  async removeItem(tenantId: string, packageId: string, itemId: string): Promise<PackageRow> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await trx
        .deleteFrom('package_items')
        .where('id', '=', itemId)
        .where('package_id', '=', packageId)
        .execute();
      return this.recalculate(trx, tenantId, packageId);
    });
  }

  async findById(
    tenantId: string,
    packageId: string,
  ): Promise<{ pkg: PackageRow; items: PackageItemRow[] }> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const pkg = await trx
        .selectFrom('package_quotations')
        .selectAll()
        .where('id', '=', packageId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!pkg) throw new NotFoundException('paquete no encontrado');

      const items = await trx
        .selectFrom('package_items')
        .selectAll()
        .where('package_id', '=', packageId)
        .orderBy('created_at')
        .execute();

      return {
        pkg: pkg as unknown as PackageRow,
        items: items as unknown as PackageItemRow[],
      };
    });
  }

  async findAll(tenantId: string): Promise<PackageRow[]> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const rows = await trx
        .selectFrom('package_quotations')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows as unknown as PackageRow[];
    });
  }

  /** Total = suma de los ítems, recalculada en SQL para que no pueda desincronizarse. */
  private async recalculate(
    trx: Parameters<Parameters<DatabaseService['withRequestContext']>[1]>[0],
    tenantId: string,
    packageId: string,
  ): Promise<PackageRow> {
    const row = await trx
      .updateTable('package_quotations')
      .set((eb) => ({
        total_amount_minor: eb
          .selectFrom('package_items')
          .select((e) => e.fn.coalesce(e.fn.sum<number>('total_minor'), e.lit(0)).as('sum'))
          .where('package_id', '=', packageId),
      }))
      .where('id', '=', packageId)
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as PackageRow;
  }
}
