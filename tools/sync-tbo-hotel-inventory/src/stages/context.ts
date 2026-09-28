import type { TboStaticContentClient, TboStaticDiagnostics } from '@sales-travel/tbo-hotels';
import type { CallFailure, CallGate } from '../call-gate.js';
import type { CatalogStore } from '../catalog-store.js';
import type { SyncSettings } from '../env.js';
import { SyncAccountError } from '../errors.js';
import type { SyncLogger } from '../log.js';

/**
 * Sólo los métodos de catálogo del cliente de contenido del ACL, que ya no expone venta (06 §4.2).
 * Tomarlos por `Pick` deja a los tests pasar el cliente real con un `fetch` falso.
 */
export type CatalogSource = Pick<
  TboStaticContentClient,
  'listCountries' | 'listCities' | 'listCityHotels' | 'getHotelDetails' | 'listAllHotelCodes'
>;

export interface StageContext {
  readonly settings: SyncSettings;
  readonly source: CatalogSource;
  readonly store: CatalogStore;
  readonly gate: CallGate;
  readonly logger: SyncLogger;
  /** `last_seen_at` de todo lo que esta corrida ve, y frontera de los barridos. */
  readonly runStart: Date;
  readonly now: () => number;
}

/** Una cuenta rechazada corta la corrida en cualquier etapa que la necesite. */
export function throwIfAccountFailure(
  failure: CallFailure,
  stage: string,
): asserts failure is Exclude<CallFailure, { readonly type: 'account' }> {
  if (failure.type === 'account') throw new SyncAccountError(failure.code, stage);
}

/** Lo que el log lleva de los diagnósticos del ACL: conteos y nombres de claves, nunca valores. */
export function diagnosticsMeta(diagnostics: TboStaticDiagnostics): Record<string, unknown> {
  return {
    received: diagnostics.received,
    mapped: diagnostics.mapped,
    rejected: diagnostics.rejected,
    notes: diagnostics.notes,
    ...(diagnostics.unknownKeys.length > 0 ? { unknownKeys: diagnostics.unknownKeys } : {}),
  };
}

export function unreadableItems(diagnostics: TboStaticDiagnostics): number {
  return diagnostics.rejected.ITEM_SCHEMA ?? 0;
}
