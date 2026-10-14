import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import {
  SEAT_MAP_UNREADABLE,
  initialPosition,
  moveInGrid,
  readSeatMapResponse,
  seatChoicesProblem,
  seatGrids,
  seatOutcomeMessages,
  seatPassengers,
  seatSummary,
  seatTabs,
  toggleSeat,
  type SeatCell,
  type SeatChoice,
  type SeatMapSegmentView,
  type SeatMapView,
  type SeatView,
} from './seat-map-view';

const money = (amountMinor: number, currency: string) =>
  `${currency} ${(amountMinor / 100).toFixed(2)}`;

function asiento(
  column: string,
  over: Partial<SeatView> = {},
  precio: number | null = 0,
): SeatView {
  const offers =
    precio === null
      ? []
      : [0, 1, 2].map((passengerIndex) => ({
          passengerIndex,
          ...(Number.isNaN(precio) ? {} : { price: { amountMinor: precio, currency: 'USD' } }),
          offerRef: `o-${column}-${String(passengerIndex)}`,
        }));
  return {
    column,
    available: offers.length > 0,
    characteristics: column === 'A' || column === 'D' ? ['WINDOW'] : ['AISLE'],
    adultOnly: false,
    infantAllowed: true,
    offers,
    ...over,
  };
}

/** A-B | C-D. Fila 12 completa; fila 13 sin el C (un hueco); fila 14 de salida de emergencia. */
function tramo(over: Partial<SeatMapSegmentView> = {}): SeatMapSegmentView {
  return {
    segmentRef: 0,
    legIndex: 0,
    changeOfGauge: false,
    displayOnly: false,
    cabins: [
      {
        cabin: 'economy',
        columns: ['A', 'B', 'C', 'D'],
        aisleAfter: ['B'],
        rows: [
          {
            number: 12,
            seats: [
              asiento('A'),
              asiento('B', { infantAllowed: false }),
              asiento('C'),
              asiento('D', {}, null),
            ],
          },
          { number: 13, seats: [asiento('A'), asiento('B', {}, 3_500), asiento('D', {}, NaN)] },
          {
            number: 14,
            seats: [
              asiento('A', { adultOnly: true, characteristics: ['WINDOW', 'EXIT_ROW'] }),
              asiento('B', { adultOnly: true }),
              asiento('C', { adultOnly: true }),
              asiento('D', { adultOnly: true }),
            ],
          },
        ],
      },
    ],
    ...over,
  };
}

const MAPA: SeatMapView = { segments: [tramo()], warnings: [] };

/** Ana (adulta, con un infante en brazos), Luis (adulto) y Sofi (niña). */
const PASAJEROS = seatPassengers({ adults: 2, children: 1, infants: 1 }, ['Ana', 'Luis', 'Sofi']);

function grilla(passengerIndex: number, choices: SeatChoice[] = [], segment = tramo()) {
  return seatGrids({
    segment,
    passenger: PASAJEROS[passengerIndex]!,
    passengers: PASAJEROS,
    choices,
    formatMoney: money,
  })[0]!;
}

function celda(grid: ReturnType<typeof grilla>, number: string): SeatCell {
  for (const row of grid.rows) {
    for (const cell of row.cells) if (cell.kind === 'seat' && cell.number === number) return cell;
  }
  throw new Error(`sin asiento ${number}`);
}

describe('seatPassengers', () => {
  it('adultos y niños con su nombre de pila; el infante en brazos no ocupa asiento', () => {
    expect(PASAJEROS).toEqual([
      { index: 0, paxType: 'ADT', label: 'Ana', withInfant: true },
      { index: 1, paxType: 'ADT', label: 'Luis', withInfant: false },
      { index: 2, paxType: 'CHD', label: 'Sofi', withInfant: false },
    ]);
  });

  it('sin nombre todavía, «Adulto 1» y «Niño 1»', () => {
    expect(
      seatPassengers({ adults: 1, children: 1, infants: 0 }, ['  ']).map((p) => p.label),
    ).toEqual(['Adulto 1', 'Niño 1']);
  });
});

describe('seatGrids — cada celda, decidida para el pasajero activo', () => {
  it('«Asiento 12C, pasillo, disponible»: el estado va en palabras, no sólo en color', () => {
    const cell = celda(grilla(1), '12C');
    expect(cell).toMatchObject({ state: 'free', selectable: true });
    expect(cell.label).toBe('Asiento 12C, pasillo, disponible');
    expect(celda(grilla(1), '12A').label).toBe('Asiento 12A, ventana, disponible');
  });

  it('ocupado, o sin oferta para este pasajero', () => {
    expect(celda(grilla(1), '12D')).toMatchObject({ state: 'occupied', selectable: false });
    expect(celda(grilla(1), '12D').label).toBe('Asiento 12D, ventana, ocupado');
  });

  it('un asiento con cargo se ve con su precio y no se elige; sin precio informado, tampoco', () => {
    const conCargo = celda(grilla(1), '13B');
    expect(conCargo).toMatchObject({ state: 'paid', selectable: false, price: 'USD 35.00' });
    expect(conCargo.label).toBe(
      'Asiento 13B, pasillo, con cargo de USD 35.00, no se puede elegir aquí',
    );
    expect(celda(grilla(1), '13D')).toMatchObject({ state: 'paid', selectable: false });
    expect(celda(grilla(1), '13D').price).toBeUndefined();
  });

  it('un niño no puede elegir la salida de emergencia; un adulto sí', () => {
    expect(celda(grilla(2), '14A')).toMatchObject({ state: 'adult-only', selectable: false });
    expect(celda(grilla(2), '14A').label).toBe(
      'Asiento 14A, ventana, salida de emergencia, sólo adultos',
    );
    expect(celda(grilla(1), '14A')).toMatchObject({ state: 'free', selectable: true, exit: true });
    expect(grilla(1).rows[2]?.exit).toBe(true);
  });

  it('el adulto con el infante en brazos no se sienta donde no puede ir un infante', () => {
    expect(celda(grilla(0), '12B')).toMatchObject({ state: 'no-infant', selectable: false });
    expect(celda(grilla(1), '12B')).toMatchObject({ state: 'free', selectable: true });
  });

  it('el elegido es del pasajero activo o de otro, y lo dice', () => {
    const choices: SeatChoice[] = [
      { passengerIndex: 0, segmentRef: 0, legIndex: 0, row: 12, column: 'A' },
      { passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 12, column: 'C' },
    ];
    const deAna = grilla(0, choices);
    expect(celda(deAna, '12A')).toMatchObject({ state: 'selected', selectable: true });
    expect(celda(deAna, '12A').label).toBe('Asiento 12A, ventana, elegido para Ana');
    expect(celda(deAna, '12C')).toMatchObject({
      state: 'taken',
      selectable: false,
      holder: 'Luis',
    });
    expect(celda(deAna, '12C').label).toBe('Asiento 12C, pasillo, elegido para Luis');
  });

  it('un hueco del avión es un hueco, no un asiento ocupado', () => {
    expect(grilla(1).rows[1]?.cells[2]).toEqual({ kind: 'gap', column: 'C' });
  });

  it('un tramo de sólo exhibición no ofrece nada', () => {
    const grid = grilla(1, [], tramo({ displayOnly: true }));
    const seats = grid.rows.flatMap((row) => row.cells).filter((c) => c.kind === 'seat');
    expect(seats.every((cell) => cell.kind === 'seat' && cell.state === 'display-only')).toBe(true);
    expect(seats.some((cell) => cell.kind === 'seat' && cell.selectable)).toBe(false);
  });
});

describe('toggleSeat — un asiento por pasajero y avión', () => {
  const donde = { segmentRef: 0, legIndex: 0 };

  it('elige, reemplaza el anterior y suelta al volver a pulsar el suyo', () => {
    const grid = grilla(1);
    const una = toggleSeat([], celda(grid, '12A'), donde, 1);
    expect(una).toEqual([{ passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 12, column: 'A' }]);
    const otra = toggleSeat(una, celda(grid, '12C'), donde, 1);
    expect(otra).toEqual([{ passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 12, column: 'C' }]);
    expect(toggleSeat(otra, celda(grilla(1, otra), '12C'), donde, 1)).toEqual([]);
  });

  it('un asiento que no se puede elegir no cambia nada', () => {
    const antes: SeatChoice[] = [
      { passengerIndex: 2, segmentRef: 0, legIndex: 0, row: 12, column: 'A' },
    ];
    expect(toggleSeat(antes, celda(grilla(2), '14A'), donde, 2)).toEqual(antes);
    expect(toggleSeat(antes, celda(grilla(2), '13B'), donde, 2)).toEqual(antes);
  });
});

describe('seatTabs y seatSummary', () => {
  const offer = {
    itineraries: [
      {
        segments: [
          { origin: 'BOG', destination: 'LIM' },
          { origin: 'LIM', destination: 'CUZ' },
        ],
      },
    ],
  } as unknown as Offer;

  it('una pestaña por avión, con «avión 2» si el tramo cambia de equipo', () => {
    const map: SeatMapView = {
      segments: [
        tramo({ segmentRef: 1 }),
        tramo({ changeOfGauge: true }),
        tramo({ changeOfGauge: true, legIndex: 1 }),
      ],
      warnings: [],
    };
    expect(seatTabs(map, offer).map((tab) => tab.label)).toEqual([
      'BOG → LIM · avión 1',
      'BOG → LIM · avión 2',
      'LIM → CUZ',
    ]);
  });

  it('«Asientos: Ana 12C · Luis 12D», y por tramo cuando hay más de uno', () => {
    const una = seatTabs(MAPA, offer);
    const choices: SeatChoice[] = [
      { passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 12, column: 'D' },
      { passengerIndex: 0, segmentRef: 0, legIndex: 0, row: 12, column: 'C' },
    ];
    expect(seatSummary(choices, PASAJEROS, una)).toBe('Asientos: Ana 12C · Luis 12D');
    expect(seatSummary([], PASAJEROS, una)).toBeUndefined();

    const dos = seatTabs({ segments: [tramo(), tramo({ segmentRef: 1 })], warnings: [] }, offer);
    expect(
      seatSummary(
        [...choices, { passengerIndex: 0, segmentRef: 1, legIndex: 0, row: 4, column: 'A' }],
        PASAJEROS,
        dos,
      ),
    ).toBe('Asientos: BOG → LIM: Ana 12C · Luis 12D; LIM → CUZ: Ana 4A');
  });

  it('cambio de equipo: asiento en los dos aviones o en ninguno', () => {
    const map: SeatMapView = {
      segments: [tramo({ changeOfGauge: true }), tramo({ changeOfGauge: true, legIndex: 1 })],
      warnings: [],
    };
    const uno: SeatChoice[] = [
      { passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 12, column: 'A' },
    ];
    expect(seatChoicesProblem(uno, map, PASAJEROS)).toMatch(/^Luis: .*dos aviones o en ninguno/);
    expect(
      seatChoicesProblem(
        [...uno, { passengerIndex: 1, segmentRef: 0, legIndex: 1, row: 12, column: 'A' }],
        map,
        PASAJEROS,
      ),
    ).toBeUndefined();
    expect(seatChoicesProblem([], map, PASAJEROS)).toBeUndefined();
  });
});

describe('moveInGrid — flechas, Inicio y Fin', () => {
  const grid = grilla(1);

  it('a los lados salta los huecos y se queda en el borde', () => {
    expect(moveInGrid(grid, { row: 1, col: 1 }, 'ArrowRight')).toEqual({ row: 1, col: 3 });
    expect(moveInGrid(grid, { row: 0, col: 3 }, 'ArrowRight')).toEqual({ row: 0, col: 3 });
    expect(moveInGrid(grid, { row: 0, col: 0 }, 'ArrowLeft')).toEqual({ row: 0, col: 0 });
  });

  it('arriba y abajo van a la misma columna, o al asiento más cercano si ahí hay un hueco', () => {
    expect(moveInGrid(grid, { row: 0, col: 2 }, 'ArrowDown')).toEqual({ row: 1, col: 1 });
    expect(moveInGrid(grid, { row: 1, col: 1 }, 'ArrowDown')).toEqual({ row: 2, col: 1 });
    expect(moveInGrid(grid, { row: 0, col: 1 }, 'ArrowUp')).toEqual({ row: 0, col: 1 });
  });

  it('Inicio y Fin van al primer y al último asiento de la fila', () => {
    expect(moveInGrid(grid, { row: 1, col: 1 }, 'Home')).toEqual({ row: 1, col: 0 });
    expect(moveInGrid(grid, { row: 1, col: 0 }, 'End')).toEqual({ row: 1, col: 3 });
    expect(moveInGrid(grid, { row: 1, col: 0 }, 'Tab')).toEqual({ row: 1, col: 0 });
  });

  it('el foco arranca en el elegido, o en el primero que se puede elegir', () => {
    expect(initialPosition(grid)).toEqual({ row: 0, col: 0 });
    expect(initialPosition(grilla(0))).toEqual({ row: 0, col: 0 });
    const conElegido = grilla(1, [
      { passengerIndex: 1, segmentRef: 0, legIndex: 0, row: 14, column: 'C' },
    ]);
    expect(initialPosition(conElegido)).toEqual({ row: 2, col: 2 });
  });
});

describe('readSeatMapResponse', () => {
  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('acepta el sobre del API', async () => {
    const read = await readSeatMapResponse(
      ok({ seatMap: MAPA, prices: 'provider', paidSeatsBookable: false, testContent: true }),
    );
    expect(read).toMatchObject({ ok: true, data: { testContent: true } });
  });

  it('el motivo del API llega al vendedor; un sobre a medias no se pinta', async () => {
    expect(
      await readSeatMapResponse(
        ok({ message: 'La elección de asiento no está disponible para esta tarifa.' }, 400),
      ),
    ).toEqual({
      ok: false,
      message: 'La elección de asiento no está disponible para esta tarifa.',
    });
    expect(await readSeatMapResponse(ok({ seatMap: { segments: 'x' } }))).toEqual({
      ok: false,
      message: SEAT_MAP_UNREADABLE,
    });
    const columnaRara = {
      seatMap: {
        segments: [tramo({ cabins: [{ ...tramo().cabins[0]!, columns: ['<b>'] }] })],
        warnings: [],
      },
      prices: 'provider',
      paidSeatsBookable: false,
      testContent: false,
    };
    expect((await readSeatMapResponse(ok(columnaRara))).ok).toBe(false);
  });
});

describe('seatOutcomeMessages — después de reservar', () => {
  it('«El vuelo quedó reservado, pero la aerolínea no confirmó el asiento 12C.»', () => {
    expect(
      seatOutcomeMessages([
        { kind: 'flight', status: 'CONFIRMED' },
        { kind: 'seat', status: 'FAILED', seatNumber: '12C' },
        { kind: 'seat', status: 'CONFIRMED', seatNumber: '12D' },
        { kind: 'seat', status: 'UNCONFIRMED', seatNumber: '4A' },
      ]),
    ).toEqual([
      'El vuelo quedó reservado, pero la aerolínea no confirmó el asiento 12C.',
      'El vuelo quedó reservado; la aerolínea todavía no confirmó el asiento 4A.',
    ]);
  });

  it('con el vuelo caído no se habla del asiento: el vuelo tiene su propio mensaje', () => {
    expect(
      seatOutcomeMessages([
        { kind: 'flight', status: 'FAILED' },
        { kind: 'seat', status: 'FAILED', seatNumber: '12C' },
      ]),
    ).toEqual([]);
    expect(seatOutcomeMessages(undefined)).toEqual([]);
  });
});
