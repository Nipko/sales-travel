import type { PaxType, ProviderContentSource } from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';
import type { ProviderIssue } from './order-create.port';

/**
 * Corregir o completar los datos de los pasajeros de una reserva YA HECHA, sin cancelarla: el
 * documento de viaje (APIS), el número de viajero frecuente y los servicios especiales (SSR).
 *
 * Puerto propio y no un método más de `OrderManagePort` (docs/sabre/10 RF-17 CA-6): no todos los
 * proveedores lo tienen, y obligar a uno sin modificación de reserva a implementarlo es obligarlo a
 * fingirla. Quien lo implementa declara qué sabe cambiar con {@link OrderModifyPort.supportedModifications}.
 *
 * La regla de excepciones, igual que en `AncillaryPort`: **si lanza, no se escribió nada en la
 * reserva**. Lanza lo que se rechaza antes de salir —datos inválidos, un pasajero que no casa con la
 * reserva, un cambio que el carril de contenido no admite— y una lectura que falla. Todo lo que pasa
 * después de mandar el cambio, incluido no saber si se aplicó, vuelve como resultado: `UNVERIFIED`
 * cuando hay que mirar la reserva antes de darlo por hecho.
 *
 * Los datos de este puerto son PII de categoría alta (número de pasaporte) y, en los servicios
 * especiales, datos sensibles (salud, religión). Ningún implementador los loguea, los guarda ni los
 * devuelve sin enmascarar: la lectura sale enmascarada ({@link OrderTravelersView}) y el resultado
 * de una modificación sólo nombra campos, nunca valores.
 */

/** Lo que se puede cambiar de un pasajero. Es el vocabulario de `supportedModifications()`. */
export const TRAVELER_MODIFICATIONS = ['identityDocuments', 'loyalty', 'specialServices'] as const;
export type TravelerModification = (typeof TRAVELER_MODIFICATIONS)[number];

/**
 * Documentos de viaje que se corrigen desde la plataforma. Los demás (visas, direcciones, el ID
 * fiscal) siguen en la reserva tal cual: no se tocan ni se borran.
 */
export const TRAVELER_DOCUMENT_TYPES = ['PASSPORT', 'NATIONAL_ID'] as const;
export type TravelerDocumentType = (typeof TRAVELER_DOCUMENT_TYPES)[number];

/**
 * Los servicios especiales que se piden desde la plataforma: lista CERRADA de códigos IATA, nunca
 * texto libre. Un SSR es un mensaje a la aerolínea; con texto libre, un campo de la pantalla sería
 * una línea de comandos hacia el sistema de reservas.
 *
 * - `WCHR`: silla de ruedas para el trayecto; sube y baja escaleras.
 * - `WCHS`: silla de ruedas; no sube ni baja escaleras.
 * - `VGML`: comida vegetariana.
 * - `MOML`: comida musulmana (halal).
 * - `DBML`: comida para diabéticos.
 */
export const TRAVELER_SPECIAL_SERVICE_CODES = ['WCHR', 'WCHS', 'VGML', 'MOML', 'DBML'] as const;
export type TravelerSpecialServiceCode = (typeof TRAVELER_SPECIAL_SERVICE_CODES)[number];

/** El documento nuevo (o corregido) del pasajero. Reemplaza al de ese tipo; si no había, se agrega. */
export interface TravelerIdentityDocumentChange {
  readonly type: TravelerDocumentType;
  /** Letras y dígitos, en mayúsculas, sin espacios ni separadores. */
  readonly number: string;
  /** ISO 3166-1 alfa-2. */
  readonly issuingCountry: string;
  /** ISO 3166-1 alfa-2. */
  readonly nationality: string;
  /** `YYYY-MM-DD`, posterior a hoy. */
  readonly expiryDate: string;
  /** `YYYY-MM-DD`. Ausente: el de la reserva. El titular es siempre el pasajero de la reserva. */
  readonly birthDate?: string;
}

/** El número de viajero frecuente para una aerolínea. Reemplaza al de esa aerolínea, o se agrega. */
export interface TravelerLoyaltyChange {
  /** Código IATA de dos caracteres de la aerolínea del programa. */
  readonly carrierCode: string;
  /** Letras y dígitos, en mayúsculas. */
  readonly number: string;
}

/**
 * Lo que cambia de UN pasajero. Lo ausente no se toca.
 *
 * `specialServices` es el conjunto que tiene que quedar, dentro de la lista cerrada: un código que
 * el pasajero tenía y no está se quita, uno nuevo se pide. `[]` quita todos los de la lista. Los SSR
 * que no son de la lista (los del documento, los de contacto, los de la aerolínea) no se tocan.
 */
export interface TravelerChange {
  /** Posición del pasajero en la reserva, empezando en 0. */
  readonly index: number;
  readonly identityDocument?: TravelerIdentityDocumentChange;
  readonly loyalty?: TravelerLoyaltyChange;
  readonly specialServices?: readonly TravelerSpecialServiceCode[];
}

/** La reserva sobre la que se opera. */
export interface OrderModifyRef {
  /** Orden en el proveedor. Sabre: el PNR (`confirmationId`). */
  readonly orderId: string;
  /** Carril de contenido con que se reservó (`Offer.providerRef.source`), si se sabe. */
  readonly contentSource?: ProviderContentSource;
  /**
   * Los pasajeros de la orden en el orden en que se reservaron: el índice del array es el
   * `TravelerChange.index`. El proveedor los cruza con los de su reserva por posición, tipo y
   * apellido, y si no casan lanza en vez de adivinar a quién cambiarle el pasaporte.
   */
  readonly passengers: readonly {
    readonly paxType: PaxType;
    readonly surname?: string;
    /** `M`/`F`: el género del titular si la reserva no lo trae y hay que componer el documento. */
    readonly gender?: 'M' | 'F';
  }[];
}

/** Un campo de un pasajero: lo que nombran el resultado, el rastro y la pantalla. */
export interface TravelerFieldRef {
  readonly index: number;
  readonly field: TravelerModification;
}

/**
 * - `MODIFIED`: la reserva muestra todo lo pedido (o ya lo tenía: `unchanged`).
 * - `FAILED`: el proveedor lo rechazó y la reserva no muestra nada de lo pedido. Se puede corregir y
 *   volver a pedir.
 * - `UNVERIFIED`: se mandó y no se sabe si quedó, o quedó sólo una parte. No se da por hecho:
 *   hay que mirar la reserva. Volver a pedirlo es seguro —cada intento parte de una lectura nueva y
 *   sólo manda lo que falta—, pero alguien tiene que saber que la reserva pudo cambiar.
 */
export type OrderModifyOutcome = 'MODIFIED' | 'FAILED' | 'UNVERIFIED';

/**
 * Por qué no se aplicó (`FAILED`):
 *
 * - `REJECTED`: el proveedor rechazó el cambio (un dato que la aerolínea no acepta).
 * - `CONCURRENT_CHANGE`: la reserva cambió entre la lectura y la escritura en todos los intentos.
 */
export type OrderModifyFailureReason = 'REJECTED' | 'CONCURRENT_CHANGE';

export interface OrderModifyResult {
  readonly outcome: OrderModifyOutcome;
  /** La reserva ya tenía lo pedido: no se mandó nada. */
  readonly unchanged: boolean;
  /** Lo que la reserva muestra aplicado después del cambio. */
  readonly applied: readonly TravelerFieldRef[];
  /** Lo que no se pudo confirmar (o, en `FAILED`, lo que no quedó). */
  readonly pending: readonly TravelerFieldRef[];
  /** Cuántas escrituras se mandaron (0 si `unchanged`). */
  readonly attempts: number;
  readonly failureReason?: OrderModifyFailureReason;
  /** Problemas del proveedor, sin texto libre ni valores (pueden llevar datos del pasajero). */
  readonly issues: readonly ProviderIssue[];
}

/** Un documento de la reserva, enmascarado: el número sólo por sus últimos caracteres. */
export interface TravelerDocumentView {
  readonly type: TravelerDocumentType;
  /** Los 4 últimos caracteres del número (o menos, si es más corto). Nunca el número entero. */
  readonly numberLast4: string;
  readonly issuingCountry?: string;
  readonly nationality?: string;
  readonly expiryDate?: string;
}

/** Un programa de viajero frecuente de la reserva, enmascarado. */
export interface TravelerLoyaltyView {
  readonly carrierCode: string;
  readonly numberLast4: string;
}

/** Un pasajero tal como lo tiene la reserva ahora, sin un solo dato completo de persona. */
export interface TravelerStateView {
  readonly index: number;
  readonly documents: readonly TravelerDocumentView[];
  readonly loyalty: readonly TravelerLoyaltyView[];
  /** Sólo los de la lista cerrada que la reserva tiene para este pasajero. */
  readonly specialServices: readonly TravelerSpecialServiceCode[];
}

export interface OrderTravelersView {
  readonly travelers: readonly TravelerStateView[];
  /** Lo que se puede cambiar en ESTA reserva (el carril de contenido puede restringirlo). */
  readonly supported: readonly TravelerModification[];
  /** Avisos de la lectura, en vocabulario cerrado. */
  readonly warnings: readonly string[];
}

/**
 * Por qué no salió un cambio (lo lanza el puerto ANTES de mandar nada):
 *
 * - `INVALID_CHANGE`: los datos no pasan las reglas (formato, fechas, duplicados).
 * - `TRAVELER_MISMATCH`: los pasajeros de la orden no casan con los de la reserva.
 * - `NOT_SUPPORTED_FOR_CONTENT`: el carril de la reserva no admite ese cambio.
 * - `SHARED_SPECIAL_SERVICE`: el servicio especial que se quiere quitar está pedido para varios
 *   pasajeros a la vez; quitarlo se lo quitaría a todos.
 * - `NOT_MODIFIABLE`: la reserva no se puede modificar (sin firma de versión, sin vuelos).
 */
export type OrderModifyRejection =
  | 'INVALID_CHANGE'
  | 'TRAVELER_MISMATCH'
  | 'NOT_SUPPORTED_FOR_CONTENT'
  | 'SHARED_SPECIAL_SERVICE'
  | 'NOT_MODIFIABLE';

/**
 * El cambio se rechazó ANTES de salir: la reserva no se tocó. `message` nombra campos y reglas,
 * nunca valores del pasajero: acaba en un log y en `domain_events`.
 */
export class OrderModifyRejectedError extends Error {
  constructor(
    readonly code: OrderModifyRejection,
    message: string,
  ) {
    super(message);
    this.name = 'OrderModifyRejectedError';
  }
}

export interface OrderModifyPort {
  /** Lo que este proveedor sabe cambiar, en cualquier reserva. */
  supportedModifications(): readonly TravelerModification[];
  /** La reserva como está ahora, enmascarada. Es una lectura: no cambia nada. */
  readTravelers(order: OrderModifyRef, ctx: SearchContext): Promise<OrderTravelersView>;
  /**
   * Aplica los cambios en bloque, sobre una lectura fresca de la reserva. Un solo pedido por
   * reserva a la vez: quien llama sostiene el lock.
   */
  modifyTravelers(
    order: OrderModifyRef,
    changes: readonly TravelerChange[],
    ctx: SearchContext,
  ): Promise<OrderModifyResult>;
}

export const ORDER_MODIFY_PORT = 'ORDER_MODIFY_PORT';
