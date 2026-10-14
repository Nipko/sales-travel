import type {
  AncillaryCatalog,
  AncillaryCategory,
  AncillaryNotSellableReason,
  AncillaryOffer,
  AncillarySegment,
  AncillaryWeight,
} from '@sales-travel/canonical';
import type {
  AncillaryAddResult,
  AncillaryRemoveResult,
  AncillarySelection,
} from '@sales-travel/domain';
import type { OrderAncillaryLineStatus } from '../database/database.types.js';

/*
 * Maletas y servicios adicionales sobre una reserva de vuelo confirmada, antes de emitir (SAB-20):
 * las decisiones puras —qué se puede agregar, a qué precio, en qué quedó cada línea— sin I/O, para
 * probarlas sin base ni proveedor. Neutral de proveedor: habla el vocabulario de `AncillaryPort`.
 *
 * El precio que ve y paga el vendedor es el de la aerolínea, SIN markup de nadie (P-16 sigue abierta
 * en docs/sabre/10: sobre qué precio de un ancillary se aplicaría). Es lo que suma al total de la
 * orden y lo que la retención de cartera suma en cada nivel de la red.
 */

/** Tope de servicios elegidos en un pedido. El ACL acepta más; la pantalla nunca manda tantos. */
export const SERVICES_MAX_SELECTIONS = 20;

/** Tope de líneas que se quitan de una vez. */
export const SERVICES_MAX_REMOVALS = 20;

/** Lo que el vendedor lee. En «tú»; sin datos del proveedor. */
export const SERVICES_MESSAGES = {
  notFound: 'La reserva no existe o no tiene localizador.',
  notConfirmed: 'Sólo se pueden agregar o quitar servicios en una reserva confirmada y sin emitir.',
  unavailable: 'Los servicios adicionales no están disponibles para esta reserva.',
  currencyChanged: 'La moneda de la reserva cambió. Vuelve a abrir la reserva antes de seguir.',
  alreadyPending:
    'Ya hay un cambio en curso en esta reserva (una emisión o servicios adicionales). Espera a que termine.',
  previousUnverified:
    'Un cambio de servicios anterior quedó sin confirmar. No lo repitas: lo revisamos con la aerolínea.',
  priceChanged:
    'El precio de los servicios cambió desde que los viste. Vuelve a abrir la lista antes de agregarlos.',
  notOffered:
    'Uno de los servicios elegidos ya no se ofrece para esta reserva. Vuelve a abrir la lista.',
  notAddable: 'Uno de los servicios elegidos no se puede agregar desde aquí.',
  passengerNotEligible: 'Uno de los servicios elegidos no está disponible para ese pasajero.',
  added: 'Servicios agregados. Se emiten junto con el tiquete.',
  partial: 'La aerolínea no confirmó todos los servicios: revisa el detalle.',
  failed: 'La aerolínea no agregó los servicios. No se cobró nada.',
  unverified:
    'No sabemos si la aerolínea agregó los servicios. No lo repitas: lo revisamos con la aerolínea y el saldo queda retenido mientras tanto.',
  removed: 'Servicios quitados de la reserva.',
  removeFailed: 'La aerolínea no quitó los servicios: siguen en la reserva.',
  removeUnverified:
    'No sabemos si la aerolínea quitó todos los servicios. No lo repitas: lo revisamos con la aerolínea.',
  lineNotRemovable: 'Uno de los servicios elegidos no se puede quitar desde aquí.',
  sharedGroup:
    'Algunos servicios se agregaron juntos y sólo se pueden quitar juntos: elige todos los del grupo.',
  totalChanged: 'El total cambió desde que abriste la reserva. Vuelve a abrirla antes de seguir.',
} as const;

/** Por qué un servicio del catálogo se muestra y no se puede agregar. Vocabulario de la pantalla. */
export type ServiceNotAddableReason = AncillaryNotSellableReason | 'CURRENCY_MISMATCH';

const NOT_ADDABLE_TEXT: Readonly<Record<ServiceNotAddableReason, string>> = {
  DISPLAY_ONLY: 'La aerolínea lo muestra sólo como información.',
  CONTACT_AIRLINE: 'Se compra directo con la aerolínea.',
  NO_BOOKING_REQUIRED: 'Ya viene con la tarifa o el pasajero ya lo tiene.',
  REQUIRES_DETAILS: 'Pide datos del pasajero que todavía no se cargan desde aquí.',
  PRICE_NOT_INFORMED: 'La aerolínea no informó el precio: no se puede cobrar a ciegas.',
  UNSUPPORTED: 'Todavía no se puede agregar desde la plataforma.',
  CURRENCY_MISMATCH: 'Se cobra en otra moneda que la reserva.',
};

export function serviceNotAddableText(reason: ServiceNotAddableReason): string {
  return NOT_ADDABLE_TEXT[reason];
}

// ---------------------------------------------------------------------------------------------
// El catálogo para la pantalla
// ---------------------------------------------------------------------------------------------

export interface PublicServicePassengerPrice {
  readonly passengerIndex: number;
  /** Precio para ese pasajero en unidades menores; `0` si viene incluido; `null` si no se informó. */
  readonly amountMinor: number | null;
  readonly included: boolean;
}

export interface PublicServiceOffer {
  readonly serviceOfferItemId: string;
  readonly category: AncillaryCategory;
  readonly name: string;
  readonly serviceCode: string;
  readonly airlineCode: string;
  readonly segmentRefs: readonly number[];
  readonly quantity: number;
  readonly weights: readonly AncillaryWeight[];
  readonly refundable: boolean | null;
  readonly passengers: readonly PublicServicePassengerPrice[];
  readonly addable: boolean;
  readonly notAddableReason: ServiceNotAddableReason | null;
  readonly notAddableText: string | null;
}

/** Lo que ya se agregó, como lo ve la pantalla. Sin ids del proveedor. */
export interface PublicServiceLine {
  readonly id: string;
  readonly passengerIndex: number;
  readonly name: string;
  readonly category: AncillaryCategory;
  readonly serviceCode: string;
  readonly segments: readonly AncillarySegment[];
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: OrderAncillaryLineStatus;
  /** Se puede quitar desde la plataforma (activo y con ids del proveedor). */
  readonly removable: boolean;
  /**
   * Las líneas con la misma `removalGroup` se quitan juntas: el proveedor dio un solo id para
   * todas. `null` = se quita sola.
   */
  readonly removalGroup: string | null;
}

export interface PublicServicesCatalog {
  readonly kind: 'ancillaries';
  readonly currency: string;
  readonly orderTotalMinor: number;
  readonly testContent: boolean;
  readonly segments: readonly (AncillarySegment & { readonly index: number })[];
  readonly offers: readonly PublicServiceOffer[];
  readonly added: readonly PublicServiceLine[];
  /** Avisos del catálogo, en códigos (p. ej. `ancillary-partial-unauthorized`). */
  readonly warnings: readonly string[];
  /** Hay un cambio pendiente o uno anterior en duda: la pantalla no ofrece agregar ni quitar. */
  readonly blocked: string | null;
}

/** Por qué una oferta no se puede agregar desde aquí, o `null` si se puede. */
export function notAddableReasonOf(
  offer: AncillaryOffer,
  currency: string,
): ServiceNotAddableReason | null {
  if (!offer.sellable) return offer.notSellableReason ?? 'UNSUPPORTED';
  for (const entry of offer.passengers) {
    if (entry.charge.type === 'NOT_INFORMED') return 'PRICE_NOT_INFORMED';
    if (entry.charge.type === 'PRICED' && entry.charge.price.currency !== currency) {
      return 'CURRENCY_MISMATCH';
    }
  }
  return null;
}

export function publicServiceOffer(offer: AncillaryOffer, currency: string): PublicServiceOffer {
  const reason = notAddableReasonOf(offer, currency);
  return {
    serviceOfferItemId: offer.serviceOfferItemId,
    category: offer.category,
    name: offer.name,
    serviceCode: offer.serviceCode,
    airlineCode: offer.airlineCode,
    segmentRefs: [...offer.segmentRefs],
    quantity: offer.quantity,
    weights: [...offer.weights],
    refundable: offer.refundable ?? null,
    passengers: offer.passengers.map((entry) => ({
      passengerIndex: entry.passengerIndex,
      amountMinor:
        entry.charge.type === 'PRICED'
          ? entry.charge.price.amountMinor
          : entry.charge.type === 'INCLUDED'
            ? 0
            : null,
      included: entry.charge.type === 'INCLUDED',
    })),
    addable: reason === null,
    notAddableReason: reason,
    notAddableText: reason === null ? null : serviceNotAddableText(reason),
  };
}

// ---------------------------------------------------------------------------------------------
// El precio de lo elegido
// ---------------------------------------------------------------------------------------------

/** Una línea del pedido: un servicio para un pasajero, con el precio del catálogo que se vio. */
export interface PricedServiceLine {
  readonly serviceOfferItemId: string;
  readonly passengerIndex: number;
  readonly amountMinor: number;
  readonly currency: string;
  readonly name: string;
  readonly category: AncillaryCategory;
  readonly serviceCode: string;
  readonly airlineCode: string;
  readonly segments: readonly AncillarySegment[];
}

export type ServicesPricing =
  | {
      readonly ok: true;
      readonly lines: readonly PricedServiceLine[];
      readonly totalMinor: number;
    }
  | {
      readonly ok: false;
      readonly refusal: 'not-offered' | 'not-addable' | 'passenger-not-eligible';
      readonly message: string;
    };

/**
 * El precio de lo elegido con el catálogo recién leído, línea por línea y en la moneda de la orden.
 * Nada del navegador participa en el precio: sólo dice qué y para quién.
 */
export function priceSelections(
  catalog: AncillaryCatalog,
  selections: readonly AncillarySelection[],
  currency: string,
): ServicesPricing {
  const byId = new Map(catalog.offers.map((offer) => [offer.serviceOfferItemId, offer]));
  const lines: PricedServiceLine[] = [];
  let total = 0;
  for (const selection of selections) {
    const offer = byId.get(selection.serviceOfferItemId);
    if (offer === undefined) {
      return { ok: false, refusal: 'not-offered', message: SERVICES_MESSAGES.notOffered };
    }
    if (notAddableReasonOf(offer, currency) !== null) {
      return { ok: false, refusal: 'not-addable', message: SERVICES_MESSAGES.notAddable };
    }
    const segments = offer.segmentRefs.flatMap((ref) => {
      const segment = catalog.segments[ref];
      return segment === undefined ? [] : [segment];
    });
    for (const passengerIndex of selection.passengerIndexes) {
      const entry = offer.passengers.find((p) => p.passengerIndex === passengerIndex);
      if (entry === undefined) {
        return {
          ok: false,
          refusal: 'passenger-not-eligible',
          message: SERVICES_MESSAGES.passengerNotEligible,
        };
      }
      const amountMinor = entry.charge.type === 'PRICED' ? entry.charge.price.amountMinor : 0;
      total += amountMinor;
      lines.push({
        serviceOfferItemId: offer.serviceOfferItemId,
        passengerIndex,
        amountMinor,
        currency,
        name: offer.name,
        category: offer.category,
        serviceCode: offer.serviceCode,
        airlineCode: offer.airlineCode,
        segments,
      });
    }
  }
  if (!Number.isSafeInteger(total)) {
    return { ok: false, refusal: 'not-addable', message: SERVICES_MESSAGES.notAddable };
  }
  return { ok: true, lines, totalMinor: total };
}

// ---------------------------------------------------------------------------------------------
// En qué quedó cada línea
// ---------------------------------------------------------------------------------------------

/** Una línea del pedido después del alta: la que quedó, la que no y la que está en duda. */
export interface SettledServiceLine extends PricedServiceLine {
  readonly status: 'active' | 'unverified' | 'failed';
  readonly providerItemIds: readonly string[];
  readonly providerItemIdsShared: boolean;
}

function lineKey(line: { serviceOfferItemId: string; passengerIndex: number }): string {
  return `${line.serviceOfferItemId}\u0000${String(line.passengerIndex)}`;
}

/**
 * Cruza lo pedido con el resultado del alta. Una línea pedida que el resultado no nombra no se da
 * por agregada ni por caída: se trata como `unverified`, porque salió y nadie dijo qué pasó.
 */
export function settleAddedLines(
  requested: readonly PricedServiceLine[],
  result: AncillaryAddResult,
): SettledServiceLine[] {
  const added = new Map(result.added.map((line) => [lineKey(line), line]));
  const failed = new Set(result.failed.map(lineKey));
  return requested.map((line) => {
    const key = lineKey(line);
    const ok = added.get(key);
    if (ok !== undefined) {
      return {
        ...line,
        status: 'active',
        providerItemIds: [...ok.providerItemIds],
        providerItemIdsShared: ok.providerItemIdsShared,
      };
    }
    // Rechazada por línea: no quedó en la reserva, aunque otras del mismo pedido estén en duda (el
    // puerto lo garantiza para `failed`).
    if (failed.has(key)) {
      return { ...line, status: 'failed', providerItemIds: [], providerItemIdsShared: false };
    }
    return { ...line, status: 'unverified', providerItemIds: [], providerItemIdsShared: false };
  });
}

/** Lo que se le devuelve al vendedor de un alta, en vocabulario de la pantalla. */
export type ServicesAddOutcome = 'ADDED' | 'PARTIAL' | 'FAILED' | 'UNVERIFIED';

export function addOutcomeOf(lines: readonly SettledServiceLine[]): ServicesAddOutcome {
  if (lines.some((line) => line.status === 'unverified')) return 'UNVERIFIED';
  const active = lines.filter((line) => line.status === 'active').length;
  if (active === 0) return 'FAILED';
  return active === lines.length ? 'ADDED' : 'PARTIAL';
}

export function addMessageOf(outcome: ServicesAddOutcome): string {
  switch (outcome) {
    case 'ADDED':
      return SERVICES_MESSAGES.added;
    case 'PARTIAL':
      return SERVICES_MESSAGES.partial;
    case 'FAILED':
      return SERVICES_MESSAGES.failed;
    case 'UNVERIFIED':
      return SERVICES_MESSAGES.unverified;
  }
}

/** Una línea guardada, lo que hace falta para quitarla. */
export interface StoredServiceLine {
  readonly id: string;
  readonly addedOperationId: string;
  readonly amountMinor: number;
  readonly status: OrderAncillaryLineStatus;
  readonly providerItemIds: readonly string[];
  readonly providerItemIdsShared: boolean;
}

/** La clave del grupo que se quita junto: mismo alta y mismos ids compartidos. */
export function removalGroupOf(line: StoredServiceLine): string | null {
  if (!line.providerItemIdsShared || line.providerItemIds.length === 0) return null;
  return `${line.addedOperationId}:${[...line.providerItemIds].sort().join(',')}`;
}

export function isRemovable(line: StoredServiceLine): boolean {
  return line.status === 'active' && line.providerItemIds.length > 0;
}

export type RemovalPlan<T extends StoredServiceLine = StoredServiceLine> =
  | {
      readonly ok: true;
      readonly lines: readonly T[];
      readonly providerItemIds: readonly string[];
      readonly totalMinor: number;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Qué se quita: las líneas pedidas, todas quitables, con cada grupo compartido completo. Un grupo a
 * medias se rechaza en vez de completarlo solo: quitar «la maleta del adulto» no puede quitar
 * también la del niño sin que el vendedor lo vea.
 */
export function planRemoval<T extends StoredServiceLine>(
  stored: readonly T[],
  lineIds: readonly string[],
): RemovalPlan<T> {
  const wanted = new Set(lineIds);
  const chosen = stored.filter((line) => wanted.has(line.id));
  if (chosen.length !== wanted.size || chosen.some((line) => !isRemovable(line))) {
    return { ok: false, message: SERVICES_MESSAGES.lineNotRemovable };
  }
  for (const line of chosen) {
    const group = removalGroupOf(line);
    if (group === null) continue;
    const members = stored.filter((other) => removalGroupOf(other) === group);
    if (members.some((member) => !wanted.has(member.id))) {
      return { ok: false, message: SERVICES_MESSAGES.sharedGroup };
    }
  }
  const ids = [...new Set(chosen.flatMap((line) => line.providerItemIds))];
  // Un id que también nombra a una línea que sigue en la reserva y no se eligió (de otra alta, o
  // un proveedor que repite ids) la quitaría en la aerolínea mientras acá sigue contando: no se
  // manda nada.
  const sending = new Set(ids);
  const collateral = stored.some(
    (other) =>
      !wanted.has(other.id) &&
      other.status !== 'removed' &&
      other.providerItemIds.some((id) => sending.has(id)),
  );
  if (collateral) return { ok: false, message: SERVICES_MESSAGES.sharedGroup };
  const total = chosen.reduce((sum, line) => sum + line.amountMinor, 0);
  return { ok: true, lines: chosen, providerItemIds: ids, totalMinor: total };
}

/** Las líneas que el proveedor confirmó quitadas: todas sus ids salieron. */
export function removedLinesOf<T extends StoredServiceLine>(
  lines: readonly T[],
  result: AncillaryRemoveResult,
): { readonly removed: T[]; readonly pending: T[] } {
  const gone = new Set(result.removed);
  const removed: T[] = [];
  const pending: T[] = [];
  for (const line of lines) {
    if (line.providerItemIds.every((id) => gone.has(id))) removed.push(line);
    else pending.push(line);
  }
  return { removed, pending };
}

export type ServicesRemoveOutcome = 'REMOVED' | 'FAILED' | 'UNVERIFIED';

export function removeMessageOf(outcome: ServicesRemoveOutcome): string {
  switch (outcome) {
    case 'REMOVED':
      return SERVICES_MESSAGES.removed;
    case 'FAILED':
      return SERVICES_MESSAGES.removeFailed;
    case 'UNVERIFIED':
      return SERVICES_MESSAGES.removeUnverified;
  }
}

// ---------------------------------------------------------------------------------------------
// La operación durable
// ---------------------------------------------------------------------------------------------

/**
 * Lo que guarda `order_operations.result` de un cambio de servicios. Sin ids del proveedor ni
 * texto libre: el historial lo ve cualquiera que vea la reserva.
 *
 * - `stage: 'sent'`: el claim se tomó y el pedido pudo salir. Desde aquí nunca se reenvía.
 * - `stage: 'settled'`: el desenlace quedó escrito.
 */
export interface ServicesOperationResult {
  readonly kind: 'add' | 'remove';
  readonly stage: 'sent' | 'settled';
  readonly requestedAt: string;
  readonly testContent: boolean;
  readonly currency: string;
  /** Lo pedido, en unidades menores: agregar o quitar. */
  readonly totalMinor: number;
  readonly lines: number;
  /** Alta: lo pedido línea por línea, para dejarlo a la vista si el pedido queda sin desenlace. */
  readonly requested?: readonly PricedServiceLine[];
  /** Baja: las líneas guardadas que se pidió quitar. */
  readonly lineIds?: readonly string[];
  readonly outcome?: ServicesAddOutcome | ServicesRemoveOutcome | 'NOT_SENT';
  readonly settledAt?: string;
  readonly done?: number;
  readonly failed?: number;
  readonly unverified?: number;
  /** Qué hizo la retención de cartera: `adjusted`, `no-hold`, `exempt`, `unchanged`. */
  readonly hold?: string;
  readonly reconciliationRequired: boolean;
  readonly retryForbidden: boolean;
  readonly escalated?: boolean;
  readonly issueTypes?: readonly string[];
}

/** Lo que el historial dice de un cambio de servicios. Nunca se reintenta desde ahí. */
export function servicesOperationPolicy(
  status: string,
  raw: unknown,
): { readonly retryable: false; readonly reconciliationRequired: boolean } {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  // Pendiente o ilegible cuenta como en duda: no se repite sin mirar.
  const reconciliationRequired =
    status === 'pending' ||
    (status === 'failed' && (record === undefined || record['reconciliationRequired'] !== false));
  return { retryable: false, reconciliationRequired };
}

/** ¿Un cambio de servicios anterior bloquea uno nuevo (y la emisión)? */
export function servicesOperationBlocks(status: string, raw: unknown): boolean {
  return status !== 'success' && servicesOperationPolicy(status, raw).reconciliationRequired;
}

/** El vocabulario cerrado de los avisos del proveedor que se guardan: sólo `type`. */
export function auditableServiceIssueTypes(issues: readonly { readonly type: string }[]): string[] {
  return [
    ...new Set(issues.map((issue) => issue.type).filter((type) => /^[A-Z0-9_]{1,64}$/.test(type))),
  ];
}
