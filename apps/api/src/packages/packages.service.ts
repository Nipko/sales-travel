import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { assertCrmReferences } from '../crm/crm-references.js';
import { DatabaseService } from '../database/database.service.js';
import {
  applyCascade,
  applyProviderFloor,
  PricingService,
  type ApplicableRule,
} from '../pricing/pricing.service.js';
import { currentContext } from '../request-context/request-context.js';
import {
  MANUAL_PROVIDER,
  type CreatePackageDto,
  type PackageItemInput,
  type UpdatePackageDto,
} from './packages.schemas.js';

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
  position: number;
}

export interface PackageRow {
  id: string;
  status: string;
  title: string;
  total_amount_minor: string | number;
  currency: string;
  customer_id: string | null;
  notes: string | null;
  search_criteria: unknown;
  show_breakdown: boolean;
  expires_at: Date;
  created_at: Date;
}

export interface PricedItem {
  markupMinor: number;
  totalMinor: number;
}

/**
 * El precio de venta de UN ítem: el neto (base + impuestos) por la cascada de SU vertical y, en
 * hoteles, el piso del proveedor encima (RF-12), igual que en la búsqueda. Sin el piso, el total
 * del paquete podía quedar por debajo del precio que el vendedor vio en los resultados.
 *
 * Un servicio manual ya trae el precio de venta que escribió el vendedor: no lleva markup.
 */
export function priceItem(
  item: Pick<
    PackageItemInput,
    'providerName' | 'baseFareMinor' | 'taxesMinor' | 'minimumSellingMinor'
  >,
  rules: ApplicableRule[],
  sellerTenantId: string,
): PricedItem {
  const net = item.baseFareMinor + item.taxesMinor;
  if (item.providerName === MANUAL_PROVIDER) return { markupMinor: 0, totalMinor: net };
  const waterfall = applyProviderFloor(
    applyCascade(net, rules),
    item.minimumSellingMinor,
    sellerTenantId,
  );
  return { markupMinor: waterfall.totalMarkupMinor, totalMinor: waterfall.finalMinor };
}

/** Un paquete se arma en una sola moneda: sumar COP con USD daría un total sin sentido. */
export function assertSameCurrency(item: Pick<PackageItemInput, 'currency'>, pkgCurrency: string) {
  if (item.currency !== undefined && item.currency.toUpperCase() !== pkgCurrency.toUpperCase()) {
    throw new ConflictException(
      `Este servicio está en ${item.currency.toUpperCase()} y el paquete en ${pkgCurrency.toUpperCase()}. Busca la opción en la misma moneda.`,
    );
  }
}

type Trx = Parameters<Parameters<DatabaseService['withRequestContext']>[1]>[0];

/**
 * Cotización multi-producto: vuelo + hotel + auto (y servicios manuales) en un solo presupuesto.
 *
 * El markup se aplica por ítem con las reglas de SU vertical: el consolidador puede cobrar
 * distinto sobre vuelos que sobre hoteles, y un markup global al paquete borraría esa diferencia.
 * El total se recalcula sumando los ítems en SQL, no acumulando en la app: así no se desincroniza
 * si un ítem se borra.
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
    const items = dto.items ?? [];
    for (const item of items) assertSameCurrency(item, dto.currency);
    const priced = await this.priceAll(tenantId, items);

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await assertCrmReferences(trx, tenantId, { customerId: dto.customerId });
      const row = await trx
        .insertInto('package_quotations')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          title: dto.title,
          currency: dto.currency.toUpperCase(),
          customer_id: dto.customerId ?? null,
          notes: dto.notes ?? null,
          expires_at: expiresAt,
          search_criteria: dto.searchCriteria ? JSON.stringify(dto.searchCriteria) : null,
          show_breakdown: dto.showBreakdown ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const [index, item] of items.entries()) {
        await this.insertItem(trx, row.id, item, priced[index]!, index);
      }
      return this.recalculate(trx, tenantId, row.id);
    });
  }

  async update(tenantId: string, packageId: string, dto: UpdatePackageDto): Promise<PackageRow> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await assertCrmReferences(trx, tenantId, { customerId: dto.customerId });
      const row = await trx
        .updateTable('package_quotations')
        .set({
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.customerId !== undefined ? { customer_id: dto.customerId } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.showBreakdown !== undefined ? { show_breakdown: dto.showBreakdown } : {}),
          ...(dto.expiresAt !== undefined ? { expires_at: new Date(dto.expiresAt) } : {}),
        })
        .where('id', '=', packageId)
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('paquete no encontrado');
      return row as unknown as PackageRow;
    });
  }

  /** Agrega un ítem al final y RECALCULA el total del paquete en la base. */
  async addItem(tenantId: string, packageId: string, dto: PackageItemInput): Promise<PackageRow> {
    const userId = currentContext()?.userId;
    const [priced] = await this.priceAll(tenantId, [dto]);

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const pkg = await this.lockedPackage(trx, tenantId, packageId);
      assertSameCurrency(dto, pkg.currency);
      const last = await trx
        .selectFrom('package_items')
        .select((e) => e.fn.max('position').as('max'))
        .where('package_id', '=', packageId)
        .executeTakeFirst();
      const position = Number(last?.max ?? -1) + 1;
      await this.insertItem(trx, packageId, dto, priced!, position);
      return this.recalculate(trx, tenantId, packageId);
    });
  }

  async removeItem(tenantId: string, packageId: string, itemId: string): Promise<PackageRow> {
    const userId = currentContext()?.userId;
    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      // El paquete se comprueba contra la agencia antes de borrar: no se deja todo a la RLS.
      await this.lockedPackage(trx, tenantId, packageId);
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
        .orderBy('position')
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

  /** Las reglas se leen una vez por vertical, no una por ítem. */
  private async priceAll(tenantId: string, items: PackageItemInput[]): Promise<PricedItem[]> {
    const rulesByVertical = new Map<string, Promise<ApplicableRule[]>>();
    const rulesFor = (vertical: string) => {
      let rules = rulesByVertical.get(vertical);
      if (!rules) {
        rules = this.pricing.getApplicableRules(tenantId, vertical);
        rulesByVertical.set(vertical, rules);
      }
      return rules;
    };
    return Promise.all(
      items.map(async (item) =>
        priceItem(
          item,
          item.providerName === MANUAL_PROVIDER ? [] : await rulesFor(item.vertical),
          tenantId,
        ),
      ),
    );
  }

  private async insertItem(
    trx: Trx,
    packageId: string,
    item: PackageItemInput,
    priced: PricedItem,
    position: number,
  ): Promise<void> {
    await trx
      .insertInto('package_items')
      .values({
        package_id: packageId,
        vertical: item.vertical,
        provider_name: item.providerName,
        provider_item_id: item.providerItemId,
        raw_details: JSON.stringify(item.rawDetails ?? {}),
        base_fare_minor: item.baseFareMinor,
        taxes_minor: item.taxesMinor,
        markup_minor: priced.markupMinor,
        total_minor: priced.totalMinor,
        position,
      })
      .execute();
  }

  private async lockedPackage(
    trx: Trx,
    tenantId: string,
    packageId: string,
  ): Promise<{ id: string; currency: string }> {
    const pkg = await trx
      .selectFrom('package_quotations')
      .select(['id', 'currency'])
      .where('id', '=', packageId)
      .where('tenant_id', '=', tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!pkg) throw new NotFoundException('paquete no encontrado');
    return pkg;
  }

  /** Total = suma de los ítems, recalculada en SQL para que no pueda desincronizarse. */
  private async recalculate(trx: Trx, tenantId: string, packageId: string): Promise<PackageRow> {
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
