import {
  TRAVELER_MODIFICATIONS,
  type OrderModifyRejection,
  type OrderModifyResult,
  type OrderTravelersView,
  type ProviderIssue,
  type TravelerChange,
  type TravelerFieldRef,
  type TravelerModification,
  type TravelerSpecialServiceCode,
} from '@sales-travel/domain';

/*
 * Corregir los datos de los pasajeros de una reserva hecha (SAB-25): las decisiones puras —qué se
 * le dice al vendedor, qué queda en la operación y en el rastro, cómo se guarda en la orden lo que
 * cambió— sin I/O. Neutral de proveedor: habla el vocabulario de `OrderModifyPort`.
 *
 * PII. Lo que el vendedor manda (pasaporte, viajero frecuente) y los servicios especiales (salud,
 * religión) NO se guardan en ningún lado de la plataforma ni van al rastro: la fuente es la reserva
 * en la aerolínea. La operación y los eventos nombran CAMPOS (`identityDocuments`, `loyalty`,
 * `specialServices`) y posiciones de pasajero, nunca valores. En la orden sólo queda lo que la
 * pantalla ya mostraba, enmascarado: el tipo, el país, el vencimiento y los últimos caracteres.
 */

/** Lo que el vendedor lee. En «tú»; sin datos del proveedor ni del pasajero. */
export const TRAVELERS_MESSAGES = {
  notFound: 'La reserva no existe o todavía no tiene localizador.',
  notModifiable:
    'Sólo se pueden cambiar los datos de los pasajeros de una reserva confirmada o emitida.',
  unavailable: 'Esta reserva no permite cambiar los datos de los pasajeros desde aquí.',
  alreadyPending:
    'Ya hay un cambio en curso en esta reserva (una emisión, servicios o datos de pasajeros). Espera a que termine e inténtalo de nuevo.',
  unknownPassenger: 'Uno de los pasajeros del cambio no está en la reserva.',
  infant: 'Un infante en brazos no lleva número de viajero frecuente ni servicios especiales.',
  notSupportedForContent:
    'La aerolínea de esta reserva no permite cambiar los servicios especiales desde aquí.',
  travelerMismatch:
    'Los pasajeros de la reserva no coinciden con los de esta orden. Pide ayuda a soporte antes de cambiar sus datos.',
  sharedSpecialService:
    'Ese servicio especial está pedido para varios pasajeros a la vez y no se puede quitar sólo para uno desde aquí.',
  invalidChange: 'Revisa los datos: hay uno que la aerolínea no aceptaría.',
  notModifiableBooking:
    'No pudimos leer la reserva para cambiarla. Inténtalo de nuevo en unos minutos.',
  saved: 'Cambios guardados en la reserva.',
  unchanged: 'La reserva ya tenía esos datos: no había nada que cambiar.',
  rejectedDocument: 'La aerolínea rechazó el cambio: revisa el número de documento.',
  rejectedLoyalty:
    'La aerolínea rechazó el número de viajero frecuente: revisa la aerolínea y el número.',
  rejectedSpecialServices: 'La aerolínea no aceptó el servicio especial pedido para esta reserva.',
  rejected: 'La aerolínea rechazó el cambio: revisa los datos e inténtalo de nuevo.',
  concurrent: 'La reserva cambió mientras guardábamos. Vuelve a abrirla e inténtalo de nuevo.',
  unverified:
    'No pudimos confirmar si la aerolínea guardó los cambios. Revisa la reserva antes de volver a intentarlo.',
  partial:
    'La aerolínea guardó sólo una parte de los cambios. Revisa la reserva antes de volver a intentarlo.',
} as const;

/** Qué se le dice al vendedor por un cambio rechazado antes de salir. */
export const TRAVELERS_REJECTION_MESSAGES: Readonly<Record<OrderModifyRejection, string>> = {
  INVALID_CHANGE: TRAVELERS_MESSAGES.invalidChange,
  TRAVELER_MISMATCH: TRAVELERS_MESSAGES.travelerMismatch,
  NOT_SUPPORTED_FOR_CONTENT: TRAVELERS_MESSAGES.notSupportedForContent,
  SHARED_SPECIAL_SERVICE: TRAVELERS_MESSAGES.sharedSpecialService,
  NOT_MODIFIABLE: TRAVELERS_MESSAGES.notModifiableBooking,
};

/** Estados de la orden en los que se cambian los datos de los pasajeros. */
export const TRAVELERS_MODIFIABLE_STATUSES: readonly string[] = ['confirmed', 'ticketed'];

/** El desenlace que ve el vendedor. */
export type TravelersOutcome = OrderModifyResult['outcome'];

/** Lo que vuelve al vendedor de un cambio. */
export interface TravelersReply {
  readonly outcome: TravelersOutcome;
  readonly message: string;
  readonly operationId: string;
  readonly unchanged: boolean;
  readonly applied: readonly TravelerFieldRef[];
  readonly pending: readonly TravelerFieldRef[];
}

/**
 * Lo que la operación `modify` guarda en `order_operations.result`: campos y desenlace, NUNCA
 * valores. `retryForbidden: false` a propósito, a diferencia de emitir o de los servicios: volver a
 * pedir el cambio es seguro, porque cada intento parte de una lectura nueva de la reserva y sólo
 * manda la diferencia que falte (lo que ya quedó no se repite).
 */
export interface TravelersOperationResult {
  readonly kind: 'travelers';
  readonly stage: 'sent' | 'settled';
  readonly requestedAt: string;
  readonly testContent: boolean;
  readonly fields: readonly TravelerFieldRef[];
  readonly settledAt?: string;
  readonly outcome?: TravelersOutcome | 'NOT_SENT';
  readonly unchanged?: boolean;
  readonly applied?: readonly TravelerFieldRef[];
  readonly pending?: readonly TravelerFieldRef[];
  readonly attempts?: number;
  readonly failureReason?: string;
  readonly issueTypes?: readonly string[];
  readonly reconciliationRequired: boolean;
  readonly retryForbidden: false;
  readonly escalated?: boolean;
}

/** Los campos pedidos, por pasajero y en orden. */
export function requestedFields(changes: readonly TravelerChange[]): TravelerFieldRef[] {
  const fields: TravelerFieldRef[] = [];
  for (const change of changes) {
    if (change.identityDocument !== undefined) {
      fields.push({ index: change.index, field: 'identityDocuments' });
    }
    if (change.loyalty !== undefined) fields.push({ index: change.index, field: 'loyalty' });
    if (change.specialServices !== undefined) {
      fields.push({ index: change.index, field: 'specialServices' });
    }
  }
  return fields;
}

/** Los nombres de campo, sin repetir y en el orden del vocabulario: lo que lleva el rastro. */
export function fieldNames(fields: readonly TravelerFieldRef[]): TravelerModification[] {
  const present = new Set(fields.map((ref) => ref.field));
  return TRAVELER_MODIFICATIONS.filter((field) => present.has(field));
}

/** Cuántos pasajeros distintos toca el cambio. */
export function travelerCount(fields: readonly TravelerFieldRef[]): number {
  return new Set(fields.map((ref) => ref.index)).size;
}

/** El vocabulario cerrado de los avisos del proveedor que se guardan: sólo `type`. */
export function auditableTravelerIssueTypes(issues: readonly ProviderIssue[]): string[] {
  return [
    ...new Set(issues.map((issue) => issue.type).filter((type) => /^[A-Z0-9_]{1,96}$/.test(type))),
  ];
}

/**
 * Qué se le dice al vendedor de un rechazo de la aerolínea. Por el tipo del error cuando lo dice
 * (viajero frecuente, servicio especial); si no, por lo que se pidió: un cambio de documento se
 * rechaza casi siempre por el número.
 */
function rejectionMessage(
  result: OrderModifyResult,
  requested: readonly TravelerFieldRef[],
): string {
  const types = result.issues.map((issue) => issue.type);
  const paths = result.issues.map((issue) => issue.fieldPath ?? '');
  if (types.some((type) => /LOYALTY/.test(type)) || paths.some((p) => /loyalty/i.test(p))) {
    return TRAVELERS_MESSAGES.rejectedLoyalty;
  }
  if (
    types.some((type) => /SPECIAL_SERVICE|SSR/.test(type)) ||
    paths.some((p) => /specialServices/i.test(p))
  ) {
    return TRAVELERS_MESSAGES.rejectedSpecialServices;
  }
  const fields = fieldNames(requested);
  if (fields.includes('identityDocuments') || paths.some((p) => /identityDocuments/i.test(p))) {
    return TRAVELERS_MESSAGES.rejectedDocument;
  }
  if (fields.length === 1 && fields[0] === 'loyalty') return TRAVELERS_MESSAGES.rejectedLoyalty;
  if (fields.length === 1 && fields[0] === 'specialServices') {
    return TRAVELERS_MESSAGES.rejectedSpecialServices;
  }
  return TRAVELERS_MESSAGES.rejected;
}

/** El texto del desenlace. */
export function travelersMessageOf(
  result: OrderModifyResult,
  requested: readonly TravelerFieldRef[],
): string {
  if (result.outcome === 'MODIFIED') {
    return result.unchanged ? TRAVELERS_MESSAGES.unchanged : TRAVELERS_MESSAGES.saved;
  }
  if (result.outcome === 'FAILED') {
    return result.failureReason === 'CONCURRENT_CHANGE'
      ? TRAVELERS_MESSAGES.concurrent
      : rejectionMessage(result, requested);
  }
  return result.applied.length > 0 ? TRAVELERS_MESSAGES.partial : TRAVELERS_MESSAGES.unverified;
}

/** Cómo sale una operación `modify` en el historial de la orden. */
export function travelersOperationPolicy(
  status: string,
  raw: unknown,
): { readonly retryable: false; readonly reconciliationRequired: boolean } {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  // Pendiente cuenta como en duda: puede haber salido. Fallida, sólo si lo dice la operación.
  const reconciliationRequired =
    status === 'pending' || (status === 'failed' && record?.['reconciliationRequired'] === true);
  return { retryable: false, reconciliationRequired };
}

// ---------------------------------------------------------------------------------------------
// Lo que queda en la orden
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Los últimos caracteres de un número, nunca más de la mitad (como la lectura del proveedor). */
export function last4(value: string): string {
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key.slice(key.length - Math.min(4, Math.max(0, key.length - 4)));
}

/** El tipo de documento de la orden (`Passenger.identityDoc.type`) para uno corregido. */
function orderDocumentType(previous: unknown, type: 'PASSPORT' | 'NATIONAL_ID'): string {
  if (type === 'PASSPORT') return 'P';
  return previous === 'DNI' || previous === 'CC' ? previous : 'DNI';
}

/**
 * Los pasajeros de la orden después de un cambio, para lo que la reserva YA muestra aplicado.
 *
 * El documento y el viajero frecuente corregidos quedan ENMASCARADOS: tipo, país, vencimiento y los
 * últimos caracteres del número (`numberLast4`), sin el número entero —que vive en la aerolínea—.
 * El número viejo, si estaba, se va con el cambio: la orden no guarda un documento que ya no es el
 * de la reserva. Los servicios especiales no se guardan (son datos de salud y religión): se leen de
 * la reserva cuando hace falta. Devuelve `undefined` si no hay nada que cambiar en la orden.
 */
export function passengersAfterChange(
  passengers: unknown,
  changes: readonly TravelerChange[],
  applied: readonly TravelerFieldRef[],
): Json[] | undefined {
  if (!Array.isArray(passengers)) return undefined;
  const done = new Set(applied.map((ref) => `${String(ref.index)}:${ref.field}`));
  let touched = false;
  const next = passengers.map((raw, index) => {
    if (!isRecord(raw)) return raw as Json;
    const change = changes.find((candidate) => candidate.index === index);
    if (change === undefined) return raw;
    let passenger: Json = raw;
    const document = change.identityDocument;
    if (document !== undefined && done.has(`${String(index)}:identityDocuments`)) {
      const previous = isRecord(raw['identityDoc']) ? raw['identityDoc']['type'] : undefined;
      passenger = {
        ...passenger,
        citizenshipCountryCode: document.nationality,
        identityDoc: {
          type: orderDocumentType(previous, document.type),
          numberLast4: last4(document.number),
          issuingCountryCode: document.issuingCountry,
          expiryDate: document.expiryDate,
        },
      };
      touched = true;
    }
    const loyalty = change.loyalty;
    if (loyalty !== undefined && done.has(`${String(index)}:loyalty`)) {
      passenger = {
        ...passenger,
        loyaltyProgramAccount: {
          airlineDesigCode: loyalty.carrierCode,
          accountNumberLast4: last4(loyalty.number),
        },
      };
      touched = true;
    }
    return passenger;
  });
  return touched ? next : undefined;
}

// ---------------------------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------------------------

export interface PublicTravelerView {
  readonly index: number;
  readonly givenName: string;
  readonly surname: string;
  readonly paxType: string;
  readonly documents: OrderTravelersView['travelers'][number]['documents'];
  readonly loyalty: OrderTravelersView['travelers'][number]['loyalty'];
  readonly specialServices: readonly TravelerSpecialServiceCode[];
}

/** Lo que manda `GET /orders/:id/travelers`: la reserva enmascarada, con los nombres de la orden. */
export interface PublicTravelersView {
  readonly kind: 'travelers';
  readonly testContent: boolean;
  readonly supported: readonly TravelerModification[];
  /** Por qué no se puede guardar ahora, o `null`. */
  readonly blocked: string | null;
  readonly travelers: readonly PublicTravelerView[];
  readonly warnings: readonly string[];
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Une los nombres de la orden (los que la pantalla ya muestra) con la reserva enmascarada. */
export function publicTravelersView(
  passengers: unknown,
  view: OrderTravelersView,
  context: { readonly testContent: boolean; readonly blocked: string | null },
): PublicTravelersView {
  const list = Array.isArray(passengers) ? (passengers as unknown[]) : [];
  return {
    kind: 'travelers',
    testContent: context.testContent,
    supported: [...view.supported],
    blocked: context.blocked,
    travelers: view.travelers.map((traveler) => {
      const raw = list[traveler.index];
      const record = isRecord(raw) ? raw : {};
      return {
        index: traveler.index,
        givenName: text(record['givenName'], 80),
        surname: text(record['surname'], 80),
        paxType: text(record['paxType'], 3),
        documents: traveler.documents,
        loyalty: traveler.loyalty,
        specialServices: traveler.specialServices,
      };
    }),
    warnings: [...view.warnings],
  };
}
