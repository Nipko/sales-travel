import { BadRequestException } from '@nestjs/common';
import { SeatMapSchema, type Offer, type Seat, type SeatMap } from '@sales-travel/canonical';
import type { Passenger, SeatSelection } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SEAT_SELECTION_MESSAGES,
  assertSeatRequestShape,
  bindSeatsToMap,
  seatNoInfantMessage,
  seatTakenMessage,
  seatTwiceMessage,
  type SeatRequest,
} from './seat-selection.js';

/**
 * Los asientos al reservar (SAB-16), del lado neutral: la forma del pedido y su atadura al mapa
 * leído justo antes de reservar. Los mensajes son los que lee el vendedor, así que se fijan enteros.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function pasajero(index: number, paxType: Passenger['paxType'], givenName: string): Passenger {
  return {
    paxId: `P${String(index)}`,
    requestedTravelerIndex: index,
    paxType,
    givenName,
    surname: 'Pérez',
    birthdate: paxType === 'INF' ? '2026-01-10' : paxType === 'CHD' ? '2018-05-02' : '1990-01-01',
    gender: 'F',
    citizenshipCountryCode: 'CO',
    identityDoc: { type: 'CC', number: `DOC${String(index)}`, issuingCountryCode: 'CO' },
  };
}

/** Ana (adulta, con el infante en brazos), Luis (adulto), Sofi (niña) e Inés (infante). */
const FAMILIA: readonly Passenger[] = [
  pasajero(0, 'ADT', 'Ana'),
  pasajero(1, 'ADT', 'Luis'),
  pasajero(2, 'CHD', 'Sofi'),
  pasajero(3, 'INF', 'Ines'),
];

function oferta(segmentos = 2): Offer {
  const segmento = (n: number) => ({
    carrier: 'AV',
    flightNumber: String(100 + n),
    origin: 'BOG',
    destination: 'LIM',
    departureAt: '2026-11-10T09:00:00-05:00',
    arrivalAt: '2026-11-10T12:00:00-05:00',
    durationMinutes: 180,
    cabin: 'economy' as const,
    bookingClass: 'Y',
  });
  return {
    id: 'offer-1',
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: 'air', offerRef: 'REF' },
    total: { amountMinor: 100_000, currency: 'USD' },
    baseFare: { amountMinor: 80_000, currency: 'USD' },
    taxes: { amountMinor: 20_000, currency: 'USD' },
    itineraries: [
      {
        segments: Array.from({ length: segmentos }, (_, n) => segmento(n)),
        totalDurationMinutes: 180 * segmentos,
        stops: segmentos - 1,
      },
    ],
    fetchedAt: '2026-10-13T12:00:00.000Z',
    expiresAt: '2099-10-13T12:30:00.000Z',
  };
}

interface AsientoOpts {
  /** Precio por pasajero: `0` sin cargo, `undefined` no informado. Sin la clave, no se le vende. */
  readonly precios?: Readonly<Record<number, number | undefined>>;
  readonly adultOnly?: boolean;
  readonly infantAllowed?: boolean;
}

/** Sin cargo para los tres pasajeros con asiento, salvo que se diga otra cosa. */
function asiento(row: number, column: string, opts: AsientoOpts = {}): Seat {
  const precios = opts.precios ?? { 0: 0, 1: 0, 2: 0 };
  const offers = Object.entries(precios).map(([index, amount]) => ({
    passengerIndex: Number(index),
    ...(amount === undefined ? {} : { price: { amountMinor: amount, currency: 'USD' } }),
    offerRef: `oferta-${String(row)}${column}-${index}`,
  }));
  return {
    column,
    available: offers.length > 0,
    characteristics: column === 'A' ? ['WINDOW'] : [],
    adultOnly: opts.adultOnly ?? false,
    infantAllowed: opts.infantAllowed ?? true,
    offers,
  };
}

function mapa(over: { cambioDeEquipo?: boolean; soloExhibicion?: boolean } = {}): SeatMap {
  const cabina = {
    cabin: 'economy' as const,
    columns: ['A', 'B', 'C', 'D'],
    aisleAfter: ['B'],
    rows: [
      {
        number: 12,
        seats: [
          asiento(12, 'A'),
          asiento(12, 'B', { infantAllowed: false }),
          asiento(12, 'C'),
          asiento(12, 'D', { precios: {} }),
        ],
      },
      {
        number: 14,
        seats: [
          asiento(14, 'A', { adultOnly: true, infantAllowed: false }),
          asiento(14, 'B', { precios: { 0: 3_500, 1: 3_500, 2: 3_500 } }),
          asiento(14, 'C', { precios: { 0: undefined, 1: undefined, 2: undefined } }),
        ],
      },
    ],
  };
  const sinVender = {
    ...cabina,
    rows: cabina.rows.map((row) => ({
      ...row,
      seats: row.seats.map((seat) => ({ ...seat, available: false, offers: [] })),
    })),
  };
  const segmentos = over.cambioDeEquipo
    ? [
        { segmentRef: 0, legIndex: 0, changeOfGauge: true, displayOnly: false, cabins: [cabina] },
        { segmentRef: 0, legIndex: 1, changeOfGauge: true, displayOnly: false, cabins: [cabina] },
      ]
    : [
        {
          segmentRef: 0,
          legIndex: 0,
          changeOfGauge: false,
          displayOnly: over.soloExhibicion ?? false,
          cabins: [over.soloExhibicion ? sinVender : cabina],
        },
      ];
  const map: SeatMap = {
    segments: [
      ...segmentos,
      { segmentRef: 1, legIndex: 0, changeOfGauge: false, displayOnly: false, cabins: [cabina] },
    ],
    warnings: [],
  };
  // El fixture cumple el canónico: si no, los tests probarían un mapa que ningún ACL entrega.
  return SeatMapSchema.parse(map);
}

function pedido(seats: SeatSelection[], passengers: readonly Passenger[] = FAMILIA): SeatRequest {
  return { offer: oferta(), passengers, seats };
}

function asientoPedido(over: Partial<SeatSelection> = {}): SeatSelection {
  return { passengerIndex: 0, segmentRef: 0, legIndex: 0, row: 12, column: 'C', ...over };
}

function rechazo(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  }
  throw new Error('se esperaba un 400');
}

describe('assertSeatRequestShape — la forma del pedido, antes de consultar a nadie', () => {
  it('sin asientos no mira nada: ni siquiera el índice de los pasajeros', () => {
    const sinIndice = FAMILIA.map(({ requestedTravelerIndex: _quitado, ...p }) => p);
    expect(() => assertSeatRequestShape({ offer: oferta(), passengers: sinIndice })).not.toThrow();
    expect(() =>
      assertSeatRequestShape({ offer: oferta(), passengers: sinIndice, seats: [] }),
    ).not.toThrow();
  });

  it('un pedido válido pasa: un asiento por pasajero y tramo', () => {
    expect(() =>
      assertSeatRequestShape(
        pedido([
          asientoPedido({ passengerIndex: 0 }),
          asientoPedido({ passengerIndex: 1, column: 'A' }),
          asientoPedido({ passengerIndex: 0, segmentRef: 1 }),
        ]),
      ),
    ).not.toThrow();
  });

  it('con asientos, cada pasajero lleva su lugar en la búsqueda, único y en orden', () => {
    const sinIndice = FAMILIA.map((p, i) =>
      i === 1 ? { ...p, requestedTravelerIndex: undefined } : p,
    );
    const repetido = FAMILIA.map((p, i) => (i === 1 ? { ...p, requestedTravelerIndex: 0 } : p));
    const desordenado = [
      { ...FAMILIA[2]!, requestedTravelerIndex: 0 },
      { ...FAMILIA[0]!, requestedTravelerIndex: 2 },
      FAMILIA[1]!,
      FAMILIA[3]!,
    ];
    const conHueco = [FAMILIA[0]!, { ...FAMILIA[1]!, requestedTravelerIndex: 5 }];
    for (const passengers of [sinIndice, repetido, desordenado, conHueco]) {
      expect(rechazo(() => assertSeatRequestShape(pedido([asientoPedido()], passengers)))).toBe(
        SEAT_SELECTION_MESSAGES.passengersUnindexed,
      );
    }
  });

  it('el formulario puede mandarlos en cualquier orden: manda el índice', () => {
    const alReves = [...FAMILIA].reverse();
    expect(() => assertSeatRequestShape(pedido([asientoPedido()], alReves))).not.toThrow();
  });

  it('un infante en brazos no ocupa asiento', () => {
    expect(
      rechazo(() => assertSeatRequestShape(pedido([asientoPedido({ passengerIndex: 3 })]))),
    ).toBe(SEAT_SELECTION_MESSAGES.infant);
  });

  it('un pasajero o un tramo que no existen', () => {
    expect(
      rechazo(() => assertSeatRequestShape(pedido([asientoPedido({ passengerIndex: 7 })]))),
    ).toBe(SEAT_SELECTION_MESSAGES.unknownPassenger);
    expect(rechazo(() => assertSeatRequestShape(pedido([asientoPedido({ segmentRef: 2 })])))).toBe(
      SEAT_SELECTION_MESSAGES.unknownSegment,
    );
  });

  it('dos asientos para el mismo pasajero en el mismo avión, o el mismo asiento dos veces', () => {
    expect(
      rechazo(() =>
        assertSeatRequestShape(pedido([asientoPedido(), asientoPedido({ column: 'A' })])),
      ),
    ).toBe(SEAT_SELECTION_MESSAGES.twoForOne);
    expect(
      rechazo(() =>
        assertSeatRequestShape(
          pedido([asientoPedido({ passengerIndex: 0 }), asientoPedido({ passengerIndex: 1 })]),
        ),
      ),
    ).toBe(seatTwiceMessage('12C'));
  });
});

describe('bindSeatsToMap — contra el mapa leído justo antes de reservar', () => {
  it('ata cada asiento a la oferta de ESE pasajero, sacada del mapa y no del navegador', () => {
    const bound = bindSeatsToMap(
      pedido([
        asientoPedido({ passengerIndex: 1, column: 'C', offerRef: 'del-navegador' }),
        asientoPedido({ passengerIndex: 2, segmentRef: 1, column: 'A' }),
      ]),
      mapa(),
    );
    expect(bound).toEqual([
      {
        passengerIndex: 1,
        segmentRef: 0,
        legIndex: 0,
        row: 12,
        column: 'C',
        offerRef: 'oferta-12C-1',
      },
      {
        passengerIndex: 2,
        segmentRef: 1,
        legIndex: 0,
        row: 12,
        column: 'A',
        offerRef: 'oferta-12A-2',
      },
    ]);
  });

  it('«El asiento 12C ya no está disponible. Elige otro.» si se ocupó, no existe o no es para él', () => {
    // 12D no tiene oferta para nadie (ocupado); 20A no existe; el tramo 0 avión 1 no está.
    for (const seat of [
      asientoPedido({ column: 'D' }),
      asientoPedido({ row: 20, column: 'A' }),
      asientoPedido({ legIndex: 1 }),
    ]) {
      expect(rechazo(() => bindSeatsToMap(pedido([seat]), mapa()))).toBe(
        seatTakenMessage(`${String(seat.row)}${seat.column}`),
      );
    }
    expect(seatTakenMessage('12C')).toBe('El asiento 12C ya no está disponible. Elige otro.');
  });

  it('salida de emergencia: un niño no se sienta ahí, un adulto sin infante sí', () => {
    const exit = asientoPedido({ row: 14, column: 'A' });
    expect(rechazo(() => bindSeatsToMap(pedido([{ ...exit, passengerIndex: 2 }]), mapa()))).toBe(
      'Las filas de salida de emergencia son sólo para adultos.',
    );
    expect(bindSeatsToMap(pedido([{ ...exit, passengerIndex: 1 }]), mapa())).toHaveLength(1);
  });

  it('el adulto con el infante en brazos no se sienta donde no puede ir un infante', () => {
    // Ana es la primera adulta y hay un infante: viaja con ella (la convención del mapa).
    expect(rechazo(() => bindSeatsToMap(pedido([asientoPedido({ column: 'B' })]), mapa()))).toBe(
      seatNoInfantMessage('12B'),
    );
    // Luis no lleva infante: el mismo asiento sí le sirve.
    expect(
      bindSeatsToMap(pedido([asientoPedido({ passengerIndex: 1, column: 'B' })]), mapa()),
    ).toHaveLength(1);
  });

  it('un asiento con cargo no se reserva desde aquí, y uno sin precio informado tampoco es gratis', () => {
    for (const column of ['B', 'C']) {
      expect(
        rechazo(() =>
          bindSeatsToMap(pedido([asientoPedido({ passengerIndex: 1, row: 14, column })]), mapa()),
        ),
      ).toBe('Los asientos con cargo todavía no se pueden reservar desde aquí.');
    }
  });

  it('un tramo de sólo exhibición no se reserva', () => {
    expect(
      rechazo(() => bindSeatsToMap(pedido([asientoPedido()]), mapa({ soloExhibicion: true }))),
    ).toBe(SEAT_SELECTION_MESSAGES.displayOnly);
  });

  it('cambio de equipo: asiento en los dos aviones o en ninguno', () => {
    const conCambio = mapa({ cambioDeEquipo: true });
    expect(
      rechazo(() => bindSeatsToMap(pedido([asientoPedido({ passengerIndex: 1 })]), conCambio)),
    ).toBe(SEAT_SELECTION_MESSAGES.changeOfGauge);

    const losDos = bindSeatsToMap(
      pedido([
        asientoPedido({ passengerIndex: 1, legIndex: 0 }),
        asientoPedido({ passengerIndex: 1, legIndex: 1, column: 'A' }),
      ]),
      conCambio,
    );
    expect(losDos.map((seat) => seat.legIndex)).toEqual([0, 1]);
    // Otro tramo sin cambio de equipo no exige nada.
    expect(
      bindSeatsToMap(pedido([asientoPedido({ passengerIndex: 1, segmentRef: 1 })]), conCambio),
    ).toHaveLength(1);
  });

  it('sin asientos no hay nada que atar', () => {
    expect(bindSeatsToMap({ offer: oferta(), passengers: FAMILIA }, mapa())).toEqual([]);
  });
});
