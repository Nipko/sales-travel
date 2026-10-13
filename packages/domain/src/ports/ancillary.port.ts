import type { AncillaryCatalog, PaxType, ProviderContentSource } from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';
import type { ProviderIssue } from './order-create.port';

/**
 * Servicios adicionales (maletas, comidas, cargos de la aerolínea) sobre una reserva YA HECHA.
 *
 * Puerto propio y no un método más de `OrderManagePort` (docs/sabre/10 RF-16 CA-5): no todos los
 * proveedores lo tienen y el que lo tiene puede tenerlo sólo para un carril de contenido. Un
 * método opcional trasladaría esa duda a cada llamador.
 *
 * La regla de excepciones, igual para los tres métodos: **si lanza, no se escribió nada en la
 * reserva**. Lanza lo que se rechaza antes de salir (datos inválidos, carril no soportado) y una
 * lectura que falla. Todo lo que pasa después de mandar un cambio —incluido no saber si se
 * aplicó— vuelve como resultado, con `UNVERIFIED` cuando hay que releer la orden.
 */

/** La reserva sobre la que se opera. */
export interface AncillaryOrderRef {
  /** Orden en el proveedor. Sabre ATPCO: el PNR (`confirmationId`). */
  readonly orderId: string;
  /**
   * Carril de contenido con el que se reservó (`Offer.providerRef.source` de la oferta). Un
   * proveedor que sólo vende servicios en un carril rechaza los demás, y también la ausencia: sin
   * carril no puede descartar que la reserva sea de uno que no soporta.
   */
  readonly contentSource?: ProviderContentSource;
  /**
   * Pasajeros de la orden en el orden en que se reservaron: el índice del array es el
   * `passengerIndex` del catálogo y de las selecciones. El proveedor los cruza con los de su
   * reserva por posición y tipo, y si no casan lanza en vez de adivinar a quién cobrarle.
   */
  readonly passengers: readonly { readonly paxType: PaxType }[];
}

/** Lo que el vendedor eligió agregar. */
export interface AncillarySelection {
  /** `AncillaryOffer.serviceOfferItemId` tal cual vino del catálogo. */
  readonly serviceOfferItemId: string;
  /** Para quién, de entre los pasajeros que la oferta admite. */
  readonly passengerIndexes: readonly number[];
}

/** Una compra concreta: un servicio para un pasajero. */
export interface AncillaryLine {
  readonly serviceOfferItemId: string;
  readonly passengerIndex: number;
}

export interface AncillaryAddedLine extends AncillaryLine {
  /**
   * Ids que el proveedor asignó a lo agregado y con los que se quita después
   * (`removeAncillaries`). Vacío = el proveedor no los devolvió y hay que leerlos de la orden.
   */
  readonly providerItemIds: readonly string[];
  /**
   * `true`: los ids no son sólo de esta línea. El proveedor los devolvió para el servicio entero
   * (Sabre: `airExtraIds` por definición de servicio, no por pasajero ni por tramo) y otras líneas
   * de `added` llevan la misma lista. Quitarlos quita TODAS esas líneas; para quitar sólo una hay
   * que leer de la orden los ids de ese pasajero y ese tramo.
   *
   * Va como campo y no como nota porque el error que evita es silencioso: quitar «la maleta del
   * adulto» con estos ids le quita también la del niño, y nadie se entera hasta el aeropuerto.
   */
  readonly providerItemIdsShared: boolean;
}

/**
 * Por qué una línea no se agregó. Todas significan que NO quedó en la reserva:
 *
 * - `NOT_OFFERED`: la oferta ya no aparece al volver a consultar.
 * - `PRICE_CHANGED`: aparece con otro precio. No se cobra un precio que el vendedor no vio.
 * - `NOT_SELLABLE`: aparece, pero no se puede agregar desde aquí (`notSellableReason`).
 * - `PASSENGER_NOT_ELIGIBLE`: ese pasajero no puede comprarla.
 * - `REJECTED`: el proveedor rechazó la petición antes de ejecutarla.
 */
export type AncillaryAddFailureReason =
  | 'NOT_OFFERED'
  | 'PRICE_CHANGED'
  | 'NOT_SELLABLE'
  | 'PASSENGER_NOT_ELIGIBLE'
  | 'REJECTED';

export interface AncillaryFailedLine extends AncillaryLine {
  readonly reason: AncillaryAddFailureReason;
}

/**
 * - `ADDED`: todas las líneas quedaron en la reserva.
 * - `PARTIAL`: unas sí y otras no (ninguna en duda).
 * - `FAILED`: ninguna quedó.
 * - `UNVERIFIED`: al menos una se mandó y no se sabe si quedó. Gana sobre los demás: hay que
 *   releer la orden antes de volver a intentarlo, porque repetir puede cobrar dos veces.
 */
export type AncillaryAddOutcome = 'ADDED' | 'PARTIAL' | 'FAILED' | 'UNVERIFIED';

export interface AncillaryAddResult {
  readonly outcome: AncillaryAddOutcome;
  readonly added: readonly AncillaryAddedLine[];
  readonly failed: readonly AncillaryFailedLine[];
  /** Mandadas sin confirmación: pueden estar o no en la reserva. */
  readonly unverified: readonly AncillaryLine[];
  /** Problemas del proveedor, sin texto libre (puede llevar datos del pasajero). */
  readonly issues: readonly ProviderIssue[];
}

/**
 * - `REMOVED`: todos los ids pedidos se quitaron.
 * - `FAILED`: el proveedor rechazó la petición; no se quitó nada.
 * - `UNVERIFIED`: se mandó y al menos un id no se confirmó. Releer la orden.
 */
export type AncillaryRemoveOutcome = 'REMOVED' | 'FAILED' | 'UNVERIFIED';

export interface AncillaryRemoveResult {
  readonly outcome: AncillaryRemoveOutcome;
  readonly removed: readonly string[];
  readonly failed: readonly string[];
  readonly unverified: readonly string[];
  readonly issues: readonly ProviderIssue[];
}

export interface AncillaryPort {
  /** Lo que se puede agregar hoy a la reserva. Es una lectura: no cambia nada. */
  listAncillaries(order: AncillaryOrderRef, ctx: SearchContext): Promise<AncillaryCatalog>;
  /**
   * Agrega lo elegido. Vuelve a consultar antes de mandar, así que una oferta que cambió de precio
   * o desapareció se rechaza por línea sin cobrarse.
   */
  addAncillaries(
    order: AncillaryOrderRef,
    selections: readonly AncillarySelection[],
    ctx: SearchContext,
  ): Promise<AncillaryAddResult>;
  /**
   * Quita servicios ya agregados, por los `providerItemIds` que devolvió el alta o la orden. Con
   * ids compartidos (`providerItemIdsShared`) se quitan todas las líneas que los comparten.
   */
  removeAncillaries(
    order: AncillaryOrderRef,
    providerItemIds: readonly string[],
    ctx: SearchContext,
  ): Promise<AncillaryRemoveResult>;
}

export const ANCILLARY_PORT = 'ANCILLARY_PORT';
