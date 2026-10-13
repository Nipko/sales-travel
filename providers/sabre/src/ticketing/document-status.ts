import type { TicketDocumentKind, TicketDocumentStatus } from '@sales-travel/domain';

/**
 * El estado de un tiquete o EMD de Sabre, traducido al vocabulario del dominio (RF-15).
 *
 * La fuente es `FlightTicket.ticketStatusCode` (`booking-management-v1.yml:3900-3905`): patrón
 * `^[A-Z]{1,2}$` y **sin enum** en el contrato. `ticketStatusName` (`TicketStatusEnum`, `:9195`)
 * no sirve para esto: sólo tiene `Issued | Voided | Refunded/Exchanged`, así que no distingue un
 * reembolso de un canje ni un tiquete de un EMD (06 §10).
 *
 * La tabla lleva sólo códigos observados en el expediente (06 §10):
 *
 * | Código | Documento | Estado   | Fuente                                                     |
 * | ------ | --------- | -------- | ---------------------------------------------------------- |
 * | `TE`   | tiquete   | emitido  | WF-26/27 y ejemplo oficial de fulfill                       |
 * | `TO`   | tiquete   | emitido  | NDC: ejemplos oficiales de fulfill y de checkFlightTickets |
 * | `ME`   | EMD       | emitido  | WF-26/27 y ejemplo oficial de fulfill                       |
 * | `OV`   | tiquete   | anulado  | WF-14 (la aserción dice `OV`; el nombre del test, `TV`)    |
 * | `MV`   | EMD       | anulado  | el par de `OV` para EMD, como `MR` lo es de `TR`            |
 * | `TR`   | tiquete   | devuelto | WF-26/27 y ejemplo oficial de getBooking                    |
 * | `MR`   | EMD       | devuelto | WF-26/27                                                    |
 *
 * Perder `TO` es dar por no emitida toda orden NDC (06 §10, «Consecuencia de `TO`»).
 *
 * El canje (`EXCHANGED`) existe en el dominio pero ningún código de Sabre lo produce todavía: la
 * reemisión está fuera del alcance de la primera integración (06 §11) y el expediente no tiene un
 * solo código de canje observado. Un código que no está en la tabla —un canje, `TV`, uno nuevo—
 * sale como `UNKNOWN` con el código guardado, que es un dato visible y revisable. Adivinarlo
 * sería mostrar «Anulado» un tiquete vivo o «Emitido» uno canjeado.
 */

/** `FlightTicket.ticketStatusCode` — `:3900-3905`. */
export const SABRE_TICKET_STATUS_CODE_PATTERN = /^[A-Z]{1,2}$/;

export interface SabreDocumentClassification {
  readonly kind: TicketDocumentKind;
  readonly status: TicketDocumentStatus;
}

/** La tabla de arriba. Congelada: un código no se agrega en tiempo de ejecución. */
export const SABRE_TICKET_STATUS_CODES: Readonly<Record<string, SabreDocumentClassification>> =
  Object.freeze({
    TE: Object.freeze({ kind: 'TICKET', status: 'ISSUED' }),
    TO: Object.freeze({ kind: 'TICKET', status: 'ISSUED' }),
    ME: Object.freeze({ kind: 'EMD', status: 'ISSUED' }),
    OV: Object.freeze({ kind: 'TICKET', status: 'VOIDED' }),
    MV: Object.freeze({ kind: 'EMD', status: 'VOIDED' }),
    TR: Object.freeze({ kind: 'TICKET', status: 'REFUNDED' }),
    MR: Object.freeze({ kind: 'EMD', status: 'REFUNDED' }),
  } satisfies Record<string, SabreDocumentClassification>);

export interface SabreDocumentStatus extends SabreDocumentClassification {
  /** El código tal como vino, sólo si tiene la forma del contrato. Nunca texto libre. */
  readonly providerStatusCode?: string;
}

/**
 * El código de estado de un `FlightTicket` al vocabulario del dominio.
 *
 * Un código desconocido o ausente es `UNKNOWN`, y su `kind` es `TICKET` sólo porque el dominio no
 * tiene un tipo "desconocido": quien guarda el documento no deja que un `UNKNOWN` le cambie el
 * tipo a uno que ya conoce. Un valor que no tiene la forma del contrato (`^[A-Z]{1,2}$`) no se
 * conserva: podría ser texto libre del proveedor.
 */
export function classifySabreTicketStatus(code: unknown): SabreDocumentStatus {
  if (typeof code !== 'string' || !SABRE_TICKET_STATUS_CODE_PATTERN.test(code)) {
    return { kind: 'TICKET', status: 'UNKNOWN' };
  }
  const known = Object.hasOwn(SABRE_TICKET_STATUS_CODES, code)
    ? SABRE_TICKET_STATUS_CODES[code]
    : undefined;
  return known === undefined
    ? { kind: 'TICKET', status: 'UNKNOWN', providerStatusCode: code }
    : { kind: known.kind, status: known.status, providerStatusCode: code };
}

/**
 * Cuál de dos observaciones del MISMO documento en una misma lectura describe su estado actual.
 *
 * Pasa con los tiquetes conjuntivos: el reembolso deja un ítem `TR` con el número principal y
 * getBooking devuelve también el `TE` original con el número conjuntivo
 * (`help-documentation-get-booking-examples.txt:79-163` y la nota final del mismo archivo). Es el
 * mismo tiquete: gana el estado terminal (anulado, devuelto, canjeado), que es posterior a
 * cualquier emisión; después, uno conocido gana a `UNKNOWN`.
 */
export function sabreDocumentStatusRank(status: TicketDocumentStatus): number {
  switch (status) {
    case 'VOIDED':
    case 'REFUNDED':
    case 'EXCHANGED':
      return 2;
    case 'ISSUED':
      return 1;
    case 'UNKNOWN':
      return 0;
  }
}
