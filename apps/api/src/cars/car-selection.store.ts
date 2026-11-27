import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CarSelection } from '@sales-travel/agent-cars';
import { MoneySchema, type Money } from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import { z } from '@sales-travel/validation';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';

/** Token de la caché donde viven las selecciones; el módulo le da su propia instancia. */
export const CARS_SELECTION_CACHE = 'CARS_SELECTION_CACHE';

/** La sesión (`uniqid`) de AgentCars dura 15 minutos: la selección guardada, lo mismo. */
const TTL_SECONDS = 15 * 60;

const KEY_PREFIX = 'cars:selection';

const StoredSelectionSchema = z
  .object({
    companyCode: z.string().min(1).max(16),
    sippCode: z.string().min(1).max(16),
    base: MoneySchema,
    tax: MoneySchema,
    rateAmount: MoneySchema,
  })
  .strict();

/** Lo que AgentCars cotizó para una sesión: el neto que la reserva tiene que mandar. */
export type StoredCarSelection = z.infer<typeof StoredSelectionSchema>;

/**
 * El precio de la selección de un auto, guardado en el servidor por `(tenantId, uniqid)` (AUT-05,
 * doc 21 §5.2).
 *
 * Antes el neto (`realBase`, `realTax`, `total`) llegaba en el cuerpo del Book y se le mandaba a
 * AgentCars tal cual; sobre ese número se calculaba además el precio de venta y la orden. Ahora el
 * Book sólo acepta el neto que AgentCars dio en la selección que pidió esta misma API: como en
 * vuelos y hoteles, el precio no sale del navegador.
 *
 * Vive en memoria, como el PreBook de hoteles: un despliegue la pierde y la reserva pide volver a
 * elegir el auto, igual que cuando la sesión de AgentCars vence.
 */
@Injectable()
export class CarSelectionStore {
  constructor(
    @Optional()
    @Inject(CARS_SELECTION_CACHE)
    private readonly cache: CachePort = new MemoryCacheAdapter(),
  ) {}

  private key(tenantId: string, uniqid: string): string {
    return `${KEY_PREFIX}:${tenantId}:${uniqid}`;
  }

  async remember(tenantId: string, selection: CarSelection): Promise<void> {
    if (!selection.uniqid) return;
    const stored = StoredSelectionSchema.parse({
      companyCode: selection.companyCode,
      sippCode: selection.sippCode,
      base: selection.base,
      tax: selection.tax,
      rateAmount: selection.rateAmount,
    } satisfies Record<keyof StoredCarSelection, unknown>);
    await this.cache.set(this.key(tenantId, selection.uniqid), stored, TTL_SECONDS);
  }

  async recall(tenantId: string, uniqid: string): Promise<StoredCarSelection | null> {
    const raw = await this.cache.get<unknown>(this.key(tenantId, uniqid));
    const parsed = StoredSelectionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** Una sesión reservada no se vuelve a reservar con el mismo precio guardado. */
  async forget(tenantId: string, uniqid: string): Promise<void> {
    await this.cache.delete(this.key(tenantId, uniqid));
  }
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}
