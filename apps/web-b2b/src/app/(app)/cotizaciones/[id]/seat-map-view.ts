import { readJson } from '../../../../lib/read-json';
import type { Offer } from '../actions';

/**
 * El mapa de asientos en el checkout (SAB-16), sin React: qué se pinta en cada celda, qué dice el
 * lector de pantalla, qué se puede elegir y cómo se mueve el foco con el teclado.
 *
 * Los tipos son una COPIA del `SeatMap` de `packages/canonical`, como el resto del checkout:
 * `apps/web-b2b` no depende de los paquetes del workspace. La respuesta se valida a mano, campo a
 * campo, igual que la revalidación (`offer-price-flow.ts`).
 *
 * Reglas que se deciden aquí y no en la pantalla:
 *
 * - **Sólo se elige un asiento sin cargo.** Uno con precio se ve con su precio —el del proveedor,
 *   sin el markup de la agencia— pero no se elige: se cobraría con un EMD al emitir y ese camino no
 *   existe todavía (D1, nunca con tarjeta). Un precio que el proveedor no informó tampoco es gratis.
 * - **Un niño no se sienta en la salida de emergencia**, ni un adulto con un infante en brazos donde
 *   no puede ir un infante.
 * - **Nada se dice sólo con color.** Cada estado lleva su texto en `aria-label` y su marca visible.
 */

// ─────────────────────────────── Tipos (copia del canónico) ───────────────────────────────

export type SeatCharacteristic =
  | 'WINDOW'
  | 'AISLE'
  | 'MIDDLE'
  | 'EXIT_ROW'
  | 'EXTRA_LEGROOM'
  | 'BASSINET'
  | 'NO_RECLINE';

export interface SeatPrice {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface SeatOfferView {
  readonly passengerIndex: number;
  /** Ausente = el proveedor no informó el precio, que NO es gratis. */
  readonly price?: SeatPrice;
  readonly offerRef: string;
}

export interface SeatView {
  readonly column: string;
  readonly available: boolean;
  readonly characteristics: readonly SeatCharacteristic[];
  readonly adultOnly: boolean;
  readonly infantAllowed: boolean;
  readonly offers: readonly SeatOfferView[];
}

export interface SeatRowView {
  readonly number: number;
  readonly seats: readonly SeatView[];
}

export interface SeatCabinView {
  readonly cabin?: string;
  readonly columns: readonly string[];
  readonly aisleAfter: readonly string[];
  readonly rows: readonly SeatRowView[];
}

export interface SeatMapSegmentView {
  readonly segmentRef: number;
  readonly legIndex: number;
  readonly changeOfGauge: boolean;
  readonly displayOnly: boolean;
  readonly cabins: readonly SeatCabinView[];
}

export interface SeatMapView {
  readonly segments: readonly SeatMapSegmentView[];
  readonly warnings: readonly string[];
}

export interface SeatMapResponseView {
  readonly seatMap: SeatMapView;
  /** Los precios son los del proveedor, sin el markup de la agencia (P-16). */
  readonly prices: 'provider';
  readonly paidSeatsBookable: boolean;
  readonly testContent: boolean;
}

/** Un asiento elegido: lo que viaja en `POST /orders` (`seats[]`). */
export interface SeatChoice {
  readonly passengerIndex: number;
  readonly segmentRef: number;
  readonly legIndex: number;
  readonly row: number;
  readonly column: string;
}

/** Un pasajero que ocupa asiento: adultos y niños. Un infante en brazos no tiene chip. */
export interface SeatPassenger {
  /** `requestedTravelerIndex`: adultos, luego niños, luego infantes. */
  readonly index: number;
  readonly paxType: 'ADT' | 'CHD';
  readonly label: string;
  /** Viaja con un infante en brazos (los primeros adultos, uno por infante, como el mapa). */
  readonly withInfant: boolean;
}

// ─────────────────────────────── Lectura de la respuesta ───────────────────────────────

export type SeatMapRead =
  | { readonly ok: true; readonly data: SeatMapResponseView }
  | { readonly ok: false; readonly message: string };

const CHARACTERISTICS: readonly SeatCharacteristic[] = [
  'WINDOW',
  'AISLE',
  'MIDDLE',
  'EXIT_ROW',
  'EXTRA_LEGROOM',
  'BASSINET',
  'NO_RECLINE',
];

export const SEAT_MAP_UNREADABLE =
  'El servidor respondió sin un mapa de asientos completo. Puedes reservar sin asiento.';

export async function readSeatMapResponse(response: Response): Promise<SeatMapRead> {
  const read = await readJson<unknown>(response);
  if (!read.ok) return { ok: false, message: read.message };
  if (!response.ok) {
    return {
      ok: false,
      message:
        errorMessage(read.data) ??
        `No se pudo leer el mapa de asientos (respuesta ${String(response.status)}).`,
    };
  }
  return isSeatMapResponse(read.data)
    ? { ok: true, data: read.data }
    : { ok: false, message: SEAT_MAP_UNREADABLE };
}

function isSeatMapResponse(value: unknown): value is SeatMapResponseView {
  return (
    isRecord(value) &&
    value['prices'] === 'provider' &&
    typeof value['paidSeatsBookable'] === 'boolean' &&
    typeof value['testContent'] === 'boolean' &&
    isRecord(value['seatMap']) &&
    Array.isArray(value['seatMap']['warnings']) &&
    value['seatMap']['warnings'].every((w) => typeof w === 'string') &&
    Array.isArray(value['seatMap']['segments']) &&
    value['seatMap']['segments'].every(isSegment)
  );
}

function isSegment(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIndex(value['segmentRef']) &&
    isIndex(value['legIndex']) &&
    typeof value['changeOfGauge'] === 'boolean' &&
    typeof value['displayOnly'] === 'boolean' &&
    Array.isArray(value['cabins']) &&
    value['cabins'].length > 0 &&
    value['cabins'].every(isCabin)
  );
}

function isCabin(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value['cabin'] === undefined || typeof value['cabin'] === 'string') &&
    isLetters(value['columns']) &&
    isLetters(value['aisleAfter']) &&
    Array.isArray(value['rows']) &&
    value['rows'].every(
      (row) =>
        isRecord(row) &&
        isIndex(row['number']) &&
        Array.isArray(row['seats']) &&
        row['seats'].every(isSeat),
    )
  );
}

function isSeat(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['column'] === 'string' &&
    /^[A-Z]$/.test(value['column']) &&
    typeof value['available'] === 'boolean' &&
    typeof value['adultOnly'] === 'boolean' &&
    typeof value['infantAllowed'] === 'boolean' &&
    Array.isArray(value['characteristics']) &&
    value['characteristics'].every(
      (c) => typeof c === 'string' && (CHARACTERISTICS as readonly string[]).includes(c),
    ) &&
    Array.isArray(value['offers']) &&
    value['offers'].every(
      (offer) =>
        isRecord(offer) &&
        isIndex(offer['passengerIndex']) &&
        typeof offer['offerRef'] === 'string' &&
        (offer['price'] === undefined ||
          (isRecord(offer['price']) &&
            isIndex(offer['price']['amountMinor']) &&
            typeof offer['price']['currency'] === 'string')),
    )
  );
}

function isLetters(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && /^[A-Z]$/.test(v));
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const message = value['message'] ?? value['error'];
  return typeof message === 'string' && message.trim() ? message : undefined;
}

// ─────────────────────────────── Pasajeros y tramos ───────────────────────────────

/**
 * Los pasajeros con asiento, con su nombre de pila si ya está escrito en el formulario y, si no,
 * «Adulto 1», «Niño 1». Los infantes no ocupan asiento y no aparecen.
 */
export function seatPassengers(
  paxCount: { adults: number; children: number; infants: number },
  names: readonly string[] = [],
): SeatPassenger[] {
  const out: SeatPassenger[] = [];
  for (let i = 0; i < paxCount.adults; i += 1) {
    out.push({
      index: i,
      paxType: 'ADT',
      label: names[i]?.trim() || `Adulto ${String(i + 1)}`,
      withInfant: i < paxCount.infants,
    });
  }
  for (let i = 0; i < paxCount.children; i += 1) {
    const index = paxCount.adults + i;
    out.push({
      index,
      paxType: 'CHD',
      label: names[index]?.trim() || `Niño ${String(i + 1)}`,
      withInfant: false,
    });
  }
  return out;
}

export interface SeatTab {
  readonly key: string;
  readonly segmentRef: number;
  readonly legIndex: number;
  readonly label: string;
  readonly displayOnly: boolean;
}

export function tabKey(segmentRef: number, legIndex: number): string {
  return `${String(segmentRef)}:${String(legIndex)}`;
}

/** Una pestaña por avión, en el orden de la oferta: «BOG → LIM», y «avión 2» si cambia de equipo. */
export function seatTabs(seatMap: SeatMapView, offer: Offer): SeatTab[] {
  const flat = (offer.itineraries ?? []).flatMap((itinerary) => itinerary.segments);
  return [...seatMap.segments]
    .sort((a, b) => a.segmentRef - b.segmentRef || a.legIndex - b.legIndex)
    .map((segment) => {
      const flight = flat[segment.segmentRef];
      const route =
        flight === undefined
          ? `Tramo ${String(segment.segmentRef + 1)}`
          : `${flight.origin} → ${flight.destination}`;
      return {
        key: tabKey(segment.segmentRef, segment.legIndex),
        segmentRef: segment.segmentRef,
        legIndex: segment.legIndex,
        label: segment.changeOfGauge ? `${route} · avión ${String(segment.legIndex + 1)}` : route,
        displayOnly: segment.displayOnly,
      };
    });
}

// ─────────────────────────────── La grilla ───────────────────────────────

export type SeatCellState =
  /** Sin cargo y para este pasajero: se puede elegir. */
  | 'free'
  /** Elegido para el pasajero activo. */
  | 'selected'
  /** Elegido para otro pasajero de esta reserva. */
  | 'taken'
  /** Ocupado, o no se le vende a este pasajero. */
  | 'occupied'
  /** Con cargo (o sin precio informado): se ve, no se elige. */
  | 'paid'
  /** Salida de emergencia y el pasajero es un niño. */
  | 'adult-only'
  /** El pasajero viaja con un infante en brazos y aquí no puede ir. */
  | 'no-infant'
  /** El tramo es de sólo exhibición. */
  | 'display-only';

export interface SeatCell {
  readonly kind: 'seat';
  readonly row: number;
  readonly column: string;
  readonly number: string;
  readonly state: SeatCellState;
  readonly selectable: boolean;
  readonly exit: boolean;
  /** «Asiento 12C, ventana, disponible». Lo que lee el lector de pantalla, con todo el estado. */
  readonly label: string;
  /** El precio del proveedor, si tiene cargo. */
  readonly price?: string;
  /** Quién lo tiene, si está elegido (para la marca visible y la etiqueta). */
  readonly holder?: string;
}

export interface SeatGap {
  readonly kind: 'gap';
  readonly column: string;
}

export interface SeatGridRow {
  readonly number: number;
  readonly exit: boolean;
  readonly cells: readonly (SeatCell | SeatGap)[];
}

export interface SeatGrid {
  readonly cabin?: string;
  readonly columns: readonly string[];
  readonly aisleAfter: readonly string[];
  readonly rows: readonly SeatGridRow[];
}

const CHARACTERISTIC_LABEL: Readonly<Record<SeatCharacteristic, string>> = {
  WINDOW: 'ventana',
  AISLE: 'pasillo',
  MIDDLE: 'centro',
  EXIT_ROW: 'salida de emergencia',
  EXTRA_LEGROOM: 'más espacio para las piernas',
  BASSINET: 'con cuna',
  NO_RECLINE: 'no reclina',
};

const STATE_LABEL: Readonly<Record<Exclude<SeatCellState, 'selected' | 'taken'>, string>> = {
  free: 'disponible',
  occupied: 'ocupado',
  paid: 'con cargo, no se puede elegir aquí',
  'adult-only': 'sólo adultos',
  'no-infant': 'no apto para viajar con un infante en brazos',
  'display-only': 'elección de asiento no disponible',
};

export interface SeatGridInput {
  readonly segment: SeatMapSegmentView;
  readonly passenger: SeatPassenger;
  readonly passengers: readonly SeatPassenger[];
  readonly choices: readonly SeatChoice[];
  readonly formatMoney: (amountMinor: number, currency: string) => string;
}

/** Las cabinas del avión, con cada celda decidida para el pasajero activo. */
export function seatGrids(input: SeatGridInput): SeatGrid[] {
  return input.segment.cabins.map((cabin) => ({
    ...(cabin.cabin === undefined ? {} : { cabin: cabin.cabin }),
    columns: cabin.columns,
    aisleAfter: cabin.aisleAfter,
    rows: cabin.rows.map((row) => {
      const byColumn = new Map(row.seats.map((seat) => [seat.column, seat]));
      const cells = cabin.columns.map((column): SeatCell | SeatGap => {
        const seat = byColumn.get(column);
        return seat === undefined ? { kind: 'gap', column } : seatCell(input, row.number, seat);
      });
      return {
        number: row.number,
        exit: row.seats.some((seat) => seat.characteristics.includes('EXIT_ROW') || seat.adultOnly),
        cells,
      };
    }),
  }));
}

function seatCell(input: SeatGridInput, row: number, seat: SeatView): SeatCell {
  const number = `${String(row)}${seat.column}`;
  const { segment, passenger } = input;
  const holderChoice = input.choices.find(
    (choice) =>
      choice.segmentRef === segment.segmentRef &&
      choice.legIndex === segment.legIndex &&
      choice.row === row &&
      choice.column === seat.column,
  );
  const holder =
    holderChoice === undefined
      ? undefined
      : input.passengers.find((p) => p.index === holderChoice.passengerIndex);
  const offer = seat.offers.find((candidate) => candidate.passengerIndex === passenger.index);
  const price =
    offer?.price !== undefined && offer.price.amountMinor > 0
      ? input.formatMoney(offer.price.amountMinor, offer.price.currency)
      : undefined;

  const state = cellState(seat, offer, input, holder);
  const exit = seat.characteristics.includes('EXIT_ROW') || seat.adultOnly;
  const features = seat.characteristics.map((c) => CHARACTERISTIC_LABEL[c]);
  const status =
    state === 'selected'
      ? `elegido para ${passenger.label}`
      : state === 'taken'
        ? `elegido para ${holder?.label ?? 'otro pasajero'}`
        : state === 'paid' && price !== undefined
          ? `con cargo de ${price}, no se puede elegir aquí`
          : STATE_LABEL[state];
  return {
    kind: 'seat',
    row,
    column: seat.column,
    number,
    state,
    selectable: state === 'free' || state === 'selected',
    exit,
    label: [`Asiento ${number}`, ...features, status].join(', '),
    ...(price === undefined ? {} : { price }),
    ...(holder === undefined ? {} : { holder: holder.label }),
  };
}

function cellState(
  seat: SeatView,
  offer: SeatOfferView | undefined,
  input: SeatGridInput,
  holder: SeatPassenger | undefined,
): SeatCellState {
  if (input.segment.displayOnly) return 'display-only';
  if (holder !== undefined) return holder.index === input.passenger.index ? 'selected' : 'taken';
  if (!seat.available) return 'occupied';
  if (seat.adultOnly && input.passenger.paxType !== 'ADT') return 'adult-only';
  if (input.passenger.withInfant && !seat.infantAllowed) return 'no-infant';
  if (offer === undefined) return 'occupied';
  if (offer.price === undefined || offer.price.amountMinor !== 0) return 'paid';
  return 'free';
}

// ─────────────────────────────── Elegir ───────────────────────────────

/**
 * Elige (o suelta) un asiento para un pasajero en un avión. Un pasajero lleva uno por avión: elegir
 * otro reemplaza el anterior; volver a pulsar el suyo lo suelta. Un asiento que no se puede elegir
 * no cambia nada.
 */
export function toggleSeat(
  choices: readonly SeatChoice[],
  cell: Pick<SeatCell, 'row' | 'column' | 'selectable'>,
  where: { readonly segmentRef: number; readonly legIndex: number },
  passengerIndex: number,
): SeatChoice[] {
  if (!cell.selectable) return [...choices];
  const mine = (choice: SeatChoice) =>
    choice.passengerIndex === passengerIndex &&
    choice.segmentRef === where.segmentRef &&
    choice.legIndex === where.legIndex;
  const current = choices.find(mine);
  const rest = choices.filter((choice) => !mine(choice));
  if (current !== undefined && current.row === cell.row && current.column === cell.column) {
    return rest;
  }
  return [...rest, { passengerIndex, ...where, row: cell.row, column: cell.column }];
}

/**
 * Lo que falta antes de guardar: con cambio de equipo, asiento en los dos aviones o en ninguno (la
 * aerolínea lo exige y el servidor lo vuelve a comprobar).
 */
export function seatChoicesProblem(
  choices: readonly SeatChoice[],
  seatMap: SeatMapView,
  passengers: readonly SeatPassenger[],
): string | undefined {
  const legsBySegment = new Map<number, number>();
  for (const segment of seatMap.segments) {
    if (!segment.changeOfGauge) continue;
    legsBySegment.set(segment.segmentRef, (legsBySegment.get(segment.segmentRef) ?? 0) + 1);
  }
  for (const [segmentRef, legs] of legsBySegment) {
    for (const passenger of passengers) {
      const chosen = choices.filter(
        (choice) => choice.segmentRef === segmentRef && choice.passengerIndex === passenger.index,
      ).length;
      if (chosen > 0 && chosen < legs) {
        return `${passenger.label}: en este tramo el avión cambia a mitad de camino. Elige asiento en los dos aviones o en ninguno.`;
      }
    }
  }
  return undefined;
}

/** «Asientos: Ana 12C · Luis 12D», y por tramo cuando hay más de uno. */
export function seatSummary(
  choices: readonly SeatChoice[],
  passengers: readonly SeatPassenger[],
  tabs: readonly SeatTab[],
): string | undefined {
  if (choices.length === 0) return undefined;
  const nameOf = (index: number) =>
    passengers.find((passenger) => passenger.index === index)?.label ?? `Pasajero ${index + 1}`;
  const groups = tabs
    .map((tab) => {
      const here = choices
        .filter((c) => c.segmentRef === tab.segmentRef && c.legIndex === tab.legIndex)
        .sort((a, b) => a.passengerIndex - b.passengerIndex)
        .map((c) => `${nameOf(c.passengerIndex)} ${String(c.row)}${c.column}`);
      return { tab, here };
    })
    .filter((group) => group.here.length > 0);
  if (groups.length === 0) return undefined;
  if (tabs.length <= 1) return `Asientos: ${groups[0]!.here.join(' · ')}`;
  return `Asientos: ${groups.map((g) => `${g.tab.label}: ${g.here.join(' · ')}`).join('; ')}`;
}

// ─────────────────────────────── Teclado ───────────────────────────────

export interface GridPosition {
  readonly row: number;
  readonly col: number;
}

/**
 * El foco de la grilla con flechas, Inicio y Fin (patrón `grid` de WAI-ARIA). Salta los huecos del
 * avión —un baño, una cocina—, pero no los asientos ocupados: el lector tiene que poder oír que
 * están ocupados. En los bordes se queda donde está.
 */
export function moveInGrid(grid: SeatGrid, from: GridPosition, key: string): GridPosition {
  const isSeat = (row: number, col: number) => grid.rows[row]?.cells[col]?.kind === 'seat';
  const width = grid.columns.length;
  const height = grid.rows.length;
  switch (key) {
    case 'ArrowRight':
      for (let col = from.col + 1; col < width; col += 1) {
        if (isSeat(from.row, col)) return { row: from.row, col };
      }
      return from;
    case 'ArrowLeft':
      for (let col = from.col - 1; col >= 0; col -= 1) {
        if (isSeat(from.row, col)) return { row: from.row, col };
      }
      return from;
    case 'ArrowDown':
      for (let row = from.row + 1; row < height; row += 1) {
        const col = nearestSeat(grid, row, from.col);
        if (col !== undefined) return { row, col };
      }
      return from;
    case 'ArrowUp':
      for (let row = from.row - 1; row >= 0; row -= 1) {
        const col = nearestSeat(grid, row, from.col);
        if (col !== undefined) return { row, col };
      }
      return from;
    case 'Home': {
      const col = grid.rows[from.row]?.cells.findIndex((cell) => cell.kind === 'seat') ?? -1;
      return col < 0 ? from : { row: from.row, col };
    }
    case 'End': {
      const cells = grid.rows[from.row]?.cells ?? [];
      for (let col = cells.length - 1; col >= 0; col -= 1) {
        if (cells[col]?.kind === 'seat') return { row: from.row, col };
      }
      return from;
    }
    default:
      return from;
  }
}

/** La misma columna si tiene asiento; si no, el asiento más cercano de esa fila. */
function nearestSeat(grid: SeatGrid, row: number, col: number): number | undefined {
  const cells = grid.rows[row]?.cells ?? [];
  for (let distance = 0; distance < cells.length; distance += 1) {
    if (cells[col - distance]?.kind === 'seat') return col - distance;
    if (cells[col + distance]?.kind === 'seat') return col + distance;
  }
  return undefined;
}

/** Dónde arranca el foco: el asiento elegido, o el primero que se puede elegir, o el primero. */
export function initialPosition(grid: SeatGrid): GridPosition | undefined {
  let first: GridPosition | undefined;
  let selectable: GridPosition | undefined;
  for (let row = 0; row < grid.rows.length; row += 1) {
    const cells = grid.rows[row]!.cells;
    for (let col = 0; col < cells.length; col += 1) {
      const cell = cells[col];
      if (cell?.kind !== 'seat') continue;
      if (cell.state === 'selected') return { row, col };
      first ??= { row, col };
      if (cell.selectable) selectable ??= { row, col };
    }
  }
  return selectable ?? first;
}

// ─────────────────────────────── Después de reservar ───────────────────────────────

export interface CreatedItem {
  readonly kind?: string;
  readonly status?: string;
  readonly seatNumber?: string;
}

/**
 * «El vuelo quedó reservado, pero la aerolínea no confirmó el asiento 12C.» Una línea por asiento
 * que no quedó, sólo si el vuelo sí quedó: un vuelo caído tiene su propio mensaje.
 */
export function seatOutcomeMessages(items: readonly CreatedItem[] | undefined): string[] {
  const list = items ?? [];
  const flightBooked =
    list.some((item) => item.kind === 'flight') &&
    list.every((item) => item.kind !== 'flight' || item.status === 'CONFIRMED');
  if (!flightBooked) return [];
  return list
    .filter((item) => item.kind === 'seat' && item.status !== 'CONFIRMED')
    .map((item) =>
      item.seatNumber === undefined
        ? 'El vuelo quedó reservado, pero la aerolínea no confirmó uno de los asientos.'
        : item.status === 'UNCONFIRMED'
          ? `El vuelo quedó reservado; la aerolínea todavía no confirmó el asiento ${item.seatNumber}.`
          : `El vuelo quedó reservado, pero la aerolínea no confirmó el asiento ${item.seatNumber}.`,
    );
}
