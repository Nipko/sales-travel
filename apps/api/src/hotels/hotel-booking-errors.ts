import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Money } from '@sales-travel/canonical';
import type {
  HotelPriceDirection,
  HotelRateConditionChange,
  HotelRepriceOutcome,
} from '../providers/hotel-provider.types.js';
import type { HotelRepricedReason } from './hotel-booking.saga.js';
import type { HotelNonRefundableTerms } from './hotel-non-refundable.js';

/**
 * Los rechazos de la reserva de hotel con órdenes (docs/tbo/09 PR-4.6). Todos ocurren ANTES de
 * llamar al Book, y los que ocurren después de abrir la orden la cierran como no enviada y liberan
 * la clave: el vendedor puede corregir y volver a pedir.
 *
 * Cada uno declara su `reason` máquina, que el filtro global publica, y los que llevan datos para
 * que la web decida los declaran en `publicDetails`: vocabulario cerrado, importes y referencias
 * nuestras, nunca texto del proveedor ni datos de huéspedes.
 */

/** El snapshot del PreBook venció, se perdió o no es de esta agencia: la misma respuesta. */
export class HotelPrebookExpiredError extends ConflictException {
  readonly reason = 'PREBOOK_EXPIRED';

  constructor() {
    super(
      'La revalidación de esta tarifa ya no está vigente. Volvé a revalidarla (o a buscar) para reservar.',
    );
    this.name = 'HotelPrebookExpiredError';
  }
}

/**
 * La tarifa sólo se vende con un billete aéreo del mismo viaje (RF-17; D-TBO-22 A). Mientras no
 * haya reservas de paquete que vinculen un vuelo, no se vende.
 */
export class HotelPackageOnlyRateError extends ConflictException {
  readonly reason = 'PACKAGE_ONLY_RATE';

  constructor() {
    super('Esta tarifa sólo se vende en un paquete con aéreo. Elegí otra tarifa del hotel.');
    this.name = 'HotelPackageOnlyRateError';
  }
}

/** La tarifa tiene cargos que se pagan en el hotel y el vendedor no confirmó mostrarlos (RF-10). */
export class HotelAtPropertyNotAcknowledgedError extends BadRequestException {
  readonly reason = 'AT_PROPERTY_NOT_ACKNOWLEDGED';

  constructor() {
    super(
      'Esta tarifa tiene cargos que el huésped paga en el hotel. Confirmá que se los mostraste al cliente para reservar.',
    );
    this.name = 'HotelAtPropertyNotAcknowledgedError';
  }
}

/** Un importe como lo lee el vendedor: `1.234.567,00 COP`. */
function moneyText(money: Money): string {
  const amount = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(money.amountMinor / 100);
  return `${amount} ${money.currency}`;
}

/**
 * Quien financia a la agencia (su consolidador, su agencia o Planetour) le bloqueó las tarifas no
 * reembolsables (db/migrations/0055), a ella o a un nivel de arriba. Se rechaza el PreBook y el Book
 * sin reservar nada, y la web las muestra como no disponibles para la agencia.
 */
export class HotelNonRefundableBlockedError extends ForbiddenException {
  readonly reason = 'NON_REFUNDABLE_BLOCKED';

  constructor(
    message = 'Tu agencia no puede reservar tarifas no reembolsables: quien la financia las tiene bloqueadas. Elegí una tarifa reembolsable del hotel o pedile a tu consolidador que las habilite.',
  ) {
    super(message);
    this.name = 'HotelNonRefundableBlockedError';
  }
}

/**
 * El flujo directo de Despegar (`choiceId` / `prebookId`) no informa la política de cancelación
 * antes de reservar: no hay con qué saber si la tarifa es no reembolsable. Con las no reembolsables
 * bloqueadas para la agencia, se rechaza entero en vez de dejar pasar una que lo sea.
 */
export const DESPEGAR_DIRECT_FLOW_BLOCKED_MESSAGE =
  'Tu agencia tiene bloqueadas las tarifas no reembolsables y la reserva directa de Despegar no informa la política de cancelación antes de reservar, así que no se puede usar. Pedile a quien financia a tu agencia que las habilite.';

/**
 * La tarifa es no reembolsable (declarada, o con el 100 % ya vigente) y el vendedor no confirmó que
 * lo entiende (pedido del founder del 2026-09-29, punto c). Los datos para pintar el aviso van en
 * `publicDetails`: el 100 % en el precio de venta y, si aplica, desde cuándo rige.
 */
export class HotelNonRefundableNotAcknowledgedError extends BadRequestException {
  readonly reason = 'NON_REFUNDABLE_NOT_ACKNOWLEDGED';
  readonly publicDetails: {
    readonly penalty: Money;
    readonly nonRefundableReason: HotelNonRefundableTerms['reason'];
    readonly fullPenaltySinceLocal?: string;
  };

  constructor(terms: HotelNonRefundableTerms) {
    super(
      `Esta tarifa no es reembolsable: si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 % (${moneyText(terms.penalty)}). Confirmá que lo entendés para reservar.`,
    );
    this.name = 'HotelNonRefundableNotAcknowledgedError';
    this.publicDetails = {
      penalty: { ...terms.penalty },
      nonRefundableReason: terms.reason,
      ...(terms.fullPenaltySinceLocal === undefined
        ? {}
        : { fullPenaltySinceLocal: terms.fullPenaltySinceLocal }),
    };
  }
}

/** El precio que el navegador dice aceptado no es el que el servidor mostró en el PreBook. */
export class HotelAcceptedTotalMismatchError extends ConflictException {
  readonly reason = 'ACCEPTED_TOTAL_MISMATCH';
  readonly publicDetails: { readonly currentTotal: Money };

  constructor(currentTotal: Money) {
    super(
      'El precio que aceptaste no es el de la revalidación vigente. Revisá el precio actualizado y confirmalo para reservar.',
    );
    this.name = 'HotelAcceptedTotalMismatchError';
    this.publicDetails = { currentTotal: { ...currentTotal } };
  }
}

/**
 * Qué decirle al vendedor de cada `ruta:código` de la validación de huéspedes. Lo que no está aquí
 * sale con el mensaje general: la lista completa viaja igual en `publicDetails.issues`.
 */
const GUEST_ISSUE_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [
    /:duplicate_guest$/,
    'Hay dos huéspedes con el mismo nombre y apellido en la reserva. Agregá un segundo nombre o un sufijo para distinguirlos.',
  ],
  [
    /\.title:(required|not_allowed)$/,
    'Elegí el título de cada huésped: Sr. (Mr), Sra. (Mrs) o Srta. (Ms).',
  ],
  [/:lead_not_adult$/, 'El primer huésped de cada habitación tiene que ser un adulto.'],
  [
    /:(adults_mismatch|children_mismatch|count_mismatch)$/,
    'Los huéspedes no coinciden con las habitaciones, adultos y niños de la búsqueda.',
  ],
  [
    /Name:(contains_digits|invalid_characters)$/,
    'Los nombres y apellidos sólo pueden tener letras, espacios, guiones y apóstrofos, sin números.',
  ],
  [/Name:(too_short|required)$/, 'Cada nombre y apellido tiene que tener al menos 2 letras.'],
  [/Name:too_long$/, 'Cada nombre y apellido puede tener hasta 40 caracteres.'],
];

const GUESTS_GENERIC =
  'Revisá los datos de los huéspedes: no cumplen lo que el proveedor exige para reservar.';

/** Los huéspedes no cumplen las reglas del proveedor contra la ocupación de la búsqueda (RF-18). */
export class HotelGuestsInvalidError extends BadRequestException {
  readonly reason = 'GUESTS_INVALID';
  readonly publicDetails: { readonly issues: readonly string[] };

  constructor(issues: readonly string[]) {
    const first = GUEST_ISSUE_MESSAGES.find(([pattern]) =>
      issues.some((issue) => pattern.test(issue)),
    );
    super(first?.[1] ?? GUESTS_GENERIC);
    this.name = 'HotelGuestsInvalidError';
    this.publicDetails = { issues: [...issues] };
  }
}

/**
 * La agencia no tiene email y teléfono de soporte utilizables, ni los hereda: es el contacto que
 * viaja al proveedor (D-TBO-23 A) y el del huésped no lo reemplaza.
 */
export class HotelAgencyContactMissingError extends UnprocessableEntityException {
  readonly reason = 'AGENCY_CONTACT_MISSING';

  constructor() {
    super(
      'Para reservar hoteles, la agencia necesita un email y un teléfono de soporte en formato internacional (por ejemplo, +57 300 123 4567). Configuralos en Mi agencia → Marca, o pedíselos a tu consolidador.',
    );
    this.name = 'HotelAgencyContactMissingError';
  }
}

export interface HotelBookRepricedDetails {
  readonly outcome: HotelRepriceOutcome;
  readonly price: HotelPriceDirection;
  readonly changes: readonly HotelRateConditionChange[];
  /** Precio de venta que el vendedor había aceptado. */
  readonly acceptedTotal: Money;
  /** Precio de venta sobre el neto revalidado. */
  readonly currentTotal: Money;
  /** Con esto se reserva la tarifa revalidada sin volver a pedir el PreBook, si se pudo guardar. */
  readonly prebookRef?: string;
}

const REPRICED_MESSAGES: Readonly<Record<HotelRepricedReason, string>> = {
  PRICE_INCREASED:
    'El precio de la tarifa subió al revalidarla antes de reservar. Revisá el precio nuevo y confirmalo para continuar.',
  CONDITIONS_CHANGED:
    'Las condiciones de la tarifa cambiaron al revalidarla antes de reservar. Revisalas y confirmalas para continuar.',
  PACKAGE_ONLY_RATE:
    'Al revalidarla, la tarifa quedó como de venta sólo en paquete con aéreo. Elegí otra tarifa del hotel.',
};

/**
 * La revalidación previa al Book (C2) cambió el precio de venta o las condiciones: no se reserva y
 * se devuelven los valores nuevos (RF-20; D-TBO-20 A). La orden se cerró como no enviada.
 */
export class HotelBookRepricedError extends ConflictException {
  readonly publicDetails: HotelBookRepricedDetails;

  constructor(
    readonly reason: HotelRepricedReason,
    details: HotelBookRepricedDetails,
  ) {
    super(REPRICED_MESSAGES[reason]);
    this.name = 'HotelBookRepricedError';
    this.publicDetails = details;
  }
}

/**
 * La orden dejó de estar abierta entre que se abrió y el Book (otro camino la cerró). No se llama
 * al proveedor, y el vendedor tiene que mirar la orden antes de volver a intentar.
 */
export class HotelBookIntentClosedError extends ConflictException {
  readonly reason = 'BOOKING_NOT_OPEN';

  constructor(orderId: string) {
    super({
      statusCode: 409,
      error: 'Conflict',
      message:
        'La reserva ya no está abierta. Revisala en Mis Reservas antes de volver a intentar.',
      orderId,
      retryForbidden: true,
      reconciliationRequired: true,
    });
    this.name = 'HotelBookIntentClosedError';
  }
}
