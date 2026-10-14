import { BadRequestException } from '@nestjs/common';
import type { Offer, Seat, SeatMap, SeatMapSegment } from '@sales-travel/canonical';
import type { Passenger, SeatSelection } from '@sales-travel/domain';

/**
 * Los asientos elegidos al reservar (SAB-16), del lado neutral: lo que se decide sin saber qué
 * proveedor pinta el mapa.
 *
 * Dos pasos, los dos antes de reservar:
 *
 *  1. {@link assertSeatRequestShape} — la forma del pedido, sin consultar a nadie: cada asiento nombra
 *     a un pasajero real que ocupa asiento, un tramo de la oferta y uno solo por avión.
 *  2. {@link bindSeatsToMap} — contra el mapa leído JUSTO ANTES de reservar, con la oferta ya
 *     revalidada: el asiento sigue libre, se le vende a ESE pasajero y no tiene cargo. De ese mapa, y
 *     nunca del navegador, sale la oferta opaca del asiento (`offerRef`) que el ACL manda al proveedor.
 *
 * **Sólo asientos sin cargo** (D1): un asiento con precio se cobra con un EMD al emitir, con la forma
 * de pago de la tarifa (CASH/ON_ACCOUNT) y nunca con tarjeta, y ese camino no existe todavía. Un
 * precio que el proveedor no informó tampoco es «gratis»: el canónico lo distingue de `0` para que
 * nadie regale un asiento que la aerolínea va a cobrar.
 *
 * Los mensajes los lee el vendedor tal cual (400): en tú y diciendo qué hacer.
 */

export const SEAT_SELECTION_MESSAGES = {
  passengersUnindexed:
    'Para elegir asientos, cada pasajero tiene que llevar su lugar en la búsqueda. Vuelve a cargar la cotización.',
  infant: 'Un infante en brazos no ocupa asiento. Quita su asiento para reservar.',
  unknownPassenger: 'Uno de los asientos es de un pasajero que no está en la reserva.',
  unknownSegment: 'Uno de los asientos es de un tramo que esta tarifa no tiene.',
  twoForOne: 'Cada pasajero lleva un solo asiento por tramo.',
  adultOnly: 'Las filas de salida de emergencia son sólo para adultos.',
  paid: 'Los asientos con cargo todavía no se pueden reservar desde aquí.',
  changeOfGauge:
    'En uno de los tramos el avión cambia a mitad de camino: elige asiento en los dos aviones o en ninguno.',
  displayOnly:
    'La aerolínea no deja elegir asiento en uno de los tramos. Quita ese asiento para reservar.',
} as const;

/** «El asiento 12C ya no está disponible. Elige otro.» */
export function seatTakenMessage(number: string): string {
  return `El asiento ${number} ya no está disponible. Elige otro.`;
}

/** «El asiento 12C está elegido dos veces.» */
export function seatTwiceMessage(number: string): string {
  return `El asiento ${number} está elegido dos veces.`;
}

/** «Un adulto que viaja con un infante en brazos no puede sentarse en el 12C.» */
export function seatNoInfantMessage(number: string): string {
  return `Un adulto que viaja con un infante en brazos no puede sentarse en el ${number}. Elige otro.`;
}

export function seatNumberOf(seat: Pick<SeatSelection, 'row' | 'column'>): string {
  return `${String(seat.row)}${seat.column}`;
}

/** Lo que pide la reserva: lo justo para validar los asientos. */
export interface SeatRequest {
  readonly offer: Offer;
  readonly passengers: readonly Passenger[];
  readonly seats?: readonly SeatSelection[];
}

const PAX_ORDER: Readonly<Record<Passenger['paxType'], number>> = { ADT: 0, CHD: 1, INF: 2 };

/**
 * La forma del pedido, antes de resolver credenciales o llamar a nadie. Sin asientos no mira nada:
 * una reserva sin asiento se valida igual que antes.
 *
 * El asiento nombra al pasajero por su `requestedTravelerIndex` —el mismo índice del mapa—, así que
 * con asientos ese índice deja de ser opcional: tiene que ser único y respetar el orden de la
 * búsqueda (adultos, niños, infantes). Sin eso, el 12C de Ana se le asignaría a Luis.
 */
export function assertSeatRequestShape(request: SeatRequest): void {
  const seats = request.seats ?? [];
  if (seats.length === 0) return;

  const byIndex = passengersByIndex(request.passengers);
  const segmentCount = (request.offer.itineraries ?? []).reduce(
    (total, itinerary) => total + itinerary.segments.length,
    0,
  );

  const travelerSlots = new Set<string>();
  const seatSlots = new Set<string>();
  for (const seat of seats) {
    const passenger = byIndex.get(seat.passengerIndex);
    if (passenger === undefined)
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.unknownPassenger);
    if (passenger.paxType === 'INF') throw new BadRequestException(SEAT_SELECTION_MESSAGES.infant);
    if (seat.segmentRef >= segmentCount) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.unknownSegment);
    }
    const where = `${String(seat.segmentRef)}:${String(seat.legIndex)}`;
    const travelerSlot = `${where}:${String(seat.passengerIndex)}`;
    if (travelerSlots.has(travelerSlot)) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.twoForOne);
    }
    const number = seatNumberOf(seat);
    const seatSlot = `${where}:${number}`;
    if (seatSlots.has(seatSlot)) throw new BadRequestException(seatTwiceMessage(number));
    travelerSlots.add(travelerSlot);
    seatSlots.add(seatSlot);
  }
}

/**
 * Pasajeros por `requestedTravelerIndex`. Con asientos, el índice es obligatorio, único, contiguo
 * desde 0 y en el orden de la búsqueda: es lo que hace que el pasajero 0 del mapa sea el pasajero 0
 * de la reserva.
 */
function passengersByIndex(passengers: readonly Passenger[]): Map<number, Passenger> {
  const byIndex = new Map<number, Passenger>();
  for (const passenger of passengers) {
    const index = passenger.requestedTravelerIndex;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || byIndex.has(index)) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.passengersUnindexed);
    }
    byIndex.set(index, passenger);
  }
  const ordered = [...byIndex.entries()].sort(([a], [b]) => a - b);
  ordered.forEach(([index, passenger], position) => {
    const previous = ordered[position - 1]?.[1];
    if (
      index !== position ||
      (previous !== undefined && PAX_ORDER[previous.paxType] > PAX_ORDER[passenger.paxType])
    ) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.passengersUnindexed);
    }
  });
  return byIndex;
}

/**
 * Ata cada asiento al mapa leído justo antes de reservar y le pone la oferta del asiento para ese
 * pasajero. Lanza un 400 con el motivo —el que lee el vendedor— al primer asiento que no se puede
 * reservar: ya no está libre, no se le vende a ese pasajero, es de salida de emergencia y viaja un
 * niño, o tiene cargo.
 *
 * Quién viaja con un infante en brazos sigue la convención del mapa: los primeros adultos, uno por
 * infante (`isAccompaniedByInfant` en la consulta).
 */
export function bindSeatsToMap(request: SeatRequest, seatMap: SeatMap): SeatSelection[] {
  const seats = request.seats ?? [];
  if (seats.length === 0) return [];
  const byIndex = passengersByIndex(request.passengers);
  const infants = request.passengers.filter((passenger) => passenger.paxType === 'INF').length;

  const bound = seats.map((seat): SeatSelection => {
    const number = seatNumberOf(seat);
    const segment = seatMap.segments.find(
      (candidate) =>
        candidate.segmentRef === seat.segmentRef && candidate.legIndex === seat.legIndex,
    );
    if (segment === undefined) throw new BadRequestException(seatTakenMessage(number));
    if (segment.displayOnly) throw new BadRequestException(SEAT_SELECTION_MESSAGES.displayOnly);

    const found = seatAt(segment, seat.row, seat.column);
    if (found === undefined) throw new BadRequestException(seatTakenMessage(number));

    const passenger = byIndex.get(seat.passengerIndex);
    if (passenger === undefined) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.unknownPassenger);
    }
    if (found.adultOnly && passenger.paxType !== 'ADT') {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.adultOnly);
    }
    const carriesInfant = passenger.paxType === 'ADT' && seat.passengerIndex < infants;
    if (carriesInfant && !found.infantAllowed) {
      throw new BadRequestException(seatNoInfantMessage(number));
    }

    const offer = found.offers.find(
      (candidate) => candidate.passengerIndex === seat.passengerIndex,
    );
    if (!found.available || offer === undefined) {
      throw new BadRequestException(seatTakenMessage(number));
    }
    if (offer.price === undefined || offer.price.amountMinor !== 0) {
      throw new BadRequestException(SEAT_SELECTION_MESSAGES.paid);
    }
    return {
      passengerIndex: seat.passengerIndex,
      segmentRef: seat.segmentRef,
      legIndex: seat.legIndex,
      row: seat.row,
      column: seat.column,
      offerRef: offer.offerRef,
    };
  });

  assertBothAircraft(bound, seatMap);
  return bound;
}

function seatAt(segment: SeatMapSegment, row: number, column: string): Seat | undefined {
  for (const cabin of segment.cabins) {
    const found = cabin.rows
      .find((candidate) => candidate.number === row)
      ?.seats.find((candidate) => candidate.column === column);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Cambio de equipo: el mismo vuelo cambia de avión a mitad de camino, y la aerolínea exige asiento
 * en los dos aviones o en ninguno. Un pasajero con asiento en uno solo se quedaría sin asiento en
 * la otra mitad sin que nadie se entere.
 */
function assertBothAircraft(seats: readonly SeatSelection[], seatMap: SeatMap): void {
  const legsBySegment = new Map<number, Set<number>>();
  for (const segment of seatMap.segments) {
    if (!segment.changeOfGauge) continue;
    const legs = legsBySegment.get(segment.segmentRef) ?? new Set<number>();
    legs.add(segment.legIndex);
    legsBySegment.set(segment.segmentRef, legs);
  }
  for (const [segmentRef, legs] of legsBySegment) {
    const byPassenger = new Map<number, Set<number>>();
    for (const seat of seats) {
      if (seat.segmentRef !== segmentRef) continue;
      const chosen = byPassenger.get(seat.passengerIndex) ?? new Set<number>();
      chosen.add(seat.legIndex);
      byPassenger.set(seat.passengerIndex, chosen);
    }
    for (const chosen of byPassenger.values()) {
      if (chosen.size !== legs.size) {
        throw new BadRequestException(SEAT_SELECTION_MESSAGES.changeOfGauge);
      }
    }
  }
}
