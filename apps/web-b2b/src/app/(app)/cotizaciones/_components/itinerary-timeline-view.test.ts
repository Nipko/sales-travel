import { describe, expect, it } from 'vitest';
import type { Offer } from '../actions';
import { formatMoney } from '../../../../lib/flight-format';
import {
  buildTimeline,
  cabinLabel,
  calendarDayOffset,
  connectionAlerts,
  connectionLabel,
  formatDurationShort,
  inclusionChip,
  minutesBetween,
  routeTitle,
  stopsLabel,
  travelDates,
} from './itinerary-timeline-view';

function segment(
  origin: string,
  destination: string,
  departureAt: string,
  arrivalAt: string,
  extra: Partial<NonNullable<Offer['itineraries']>[number]['segments'][number]> = {},
) {
  return {
    carrier: 'LA',
    flightNumber: '4205',
    origin,
    destination,
    departureAt,
    arrivalAt,
    durationMinutes: 0,
    cabin: 'economy',
    bookingClass: 'Y',
    ...extra,
  };
}

function offer(patch: Partial<Offer> = {}): Offer {
  const money = { amountMinor: 100_00, currency: 'USD' };
  return {
    id: 'o1',
    tenantId: 't1',
    products: ['flight'],
    provider: { name: 'latam-ndc', offerRef: 'r' },
    total: money,
    baseFare: money,
    taxes: { amountMinor: 0, currency: 'USD' },
    fetchedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2026-10-01T00:00:00Z',
    itineraries: [
      {
        totalDurationMinutes: 0,
        stops: 1,
        segments: [
          segment('BOG', 'LIM', '2026-10-14T22:10:00-05:00', '2026-10-15T01:20:00-05:00', {
            operatingCarrier: 'LA',
            aircraft: '320',
          }),
          segment('LIM', 'CUZ', '2026-10-15T02:30:00-05:00', '2026-10-15T03:55:00-05:00', {
            carrier: 'LA',
            operatingCarrier: 'XL',
            flightNumber: '2041',
          }),
        ],
      },
      {
        totalDurationMinutes: 300,
        stops: 0,
        segments: [segment('CUZ', 'BOG', '2026-10-20T08:00:00-05:00', '2026-10-20T13:00:00-05:00')],
      },
    ],
    ...patch,
  };
}

describe('helpers de tiempo — la hora del aeropuerto, no la del navegador', () => {
  it('cuenta días entre fechas escritas, aunque cambie el offset', () => {
    expect(calendarDayOffset('2026-10-14T22:10:00-05:00', '2026-10-15T01:20:00-05:00')).toBe(1);
    // Sale el 14 a las 23:00 en Bogotá y llega el 15 a la mañana en Madrid: +1 por calendario.
    expect(calendarDayOffset('2026-10-14T23:00:00-05:00', '2026-10-15T15:00:00+02:00')).toBe(1);
    expect(calendarDayOffset('2026-10-14T08:00:00-05:00', '2026-10-14T10:00:00-05:00')).toBe(0);
    expect(calendarDayOffset('nada', '2026-10-14T10:00:00-05:00')).toBe(0);
  });

  it('mide minutos con los offsets de cada aeropuerto', () => {
    expect(minutesBetween('2026-10-14T23:00:00-05:00', '2026-10-15T15:00:00+02:00')).toBe(540);
    expect(minutesBetween('x', 'y')).toBeNull();
  });

  it('escribe duraciones, escalas y cabinas legibles', () => {
    expect(formatDurationShort(45)).toBe('45m');
    expect(formatDurationShort(125)).toBe('2h 05m');
    expect(stopsLabel(0)).toBe('Directo');
    expect(stopsLabel(1)).toBe('1 escala');
    expect(stopsLabel(2)).toBe('2 escalas');
    expect(cabinLabel('business')).toBe('Ejecutiva');
    expect(cabinLabel('PREMIUM_ECONOMY')).toBe('Premium economy');
    expect(cabinLabel('weird_cabin')).toBe('Weird cabin');
    expect(cabinLabel('  ')).toBeUndefined();
  });
});

describe('buildTimeline', () => {
  const legs = buildTimeline(offer(), formatMoney);

  it('arma un trayecto por itinerario con su etiqueta y su ruta', () => {
    expect(legs.map((leg) => leg.label)).toEqual(['Ida', 'Vuelta']);
    expect(legs[0]).toMatchObject({ origin: 'BOG', destination: 'CUZ', stops: 1 });
    expect(routeTitle(legs)).toBe('BOG ⇄ CUZ');
  });

  it('pone las horas del aeropuerto y el +1 de la llegada', () => {
    const ida = legs[0]!;
    expect(ida.departure.time).toBe('22:10');
    expect(ida.arrival).toMatchObject({ time: '03:55', dayOffset: 1 });
    // Sin duración del proveedor, se calcula de los instantes.
    expect(ida.durationMinutes).toBe(345);
  });

  it('intercala la escala entre los vuelos, con su espera y su alerta', () => {
    const ida = legs[0]!;
    expect(ida.items.map((item) => item.kind)).toEqual(['segment', 'connection', 'segment']);
    const escala = ida.items[1];
    if (escala?.kind !== 'connection') throw new Error('falta la escala');
    expect(escala.connection).toMatchObject({ arrivalAirport: 'LIM', minutes: 70, tight: false });
    expect(connectionLabel(escala.connection)).toBe('Escala en LIM · 1h 10m');
  });

  it('dice quién opera sólo cuando no es quien vende, y el detalle del tramo', () => {
    const [primero, , segundo] = legs[0]!.items;
    if (primero?.kind !== 'segment' || segundo?.kind !== 'segment') throw new Error('tramos');
    expect(primero.segment.operatedBy).toBeUndefined();
    expect(primero.segment).toMatchObject({
      flight: 'LA 4205',
      cabin: 'Económica',
      bookingClass: 'Y',
      aircraft: '320',
      durationMinutes: 190,
    });
    expect(segundo.segment.operatedBy).toBe('LATAM Ecuador');
  });

  it('sin atributos de marca, las condiciones salen del viaje completo', () => {
    const conPoliticas = buildTimeline(
      offer({
        baggage: { carryOn: { qty: 1, weightKg: 10 }, checked: { qty: 0 } },
        policies: { changeable: true, refundable: false },
      }),
      formatMoney,
    );
    const chips = conPoliticas[0]!.inclusions;
    expect(conPoliticas[0]!.inclusionsSource).toBe('offer');
    expect(chips.map((chip) => [chip.key, chip.state, chip.text])).toEqual([
      ['carry-on', 'yes', 'Equipaje de mano'],
      ['checked-bag', 'no', 'Sin maleta facturada'],
      ['change', 'partial', 'Cambios con cargo'],
      ['refund', 'no', 'No reembolsable'],
    ]);
    expect(chips[0]!.detail).toBe('10 kg');
  });

  it('con marca por trayecto, cada trayecto dice lo suyo y su tarifa', () => {
    const conMarcas = buildTimeline(
      offer({
        fareComponents: [
          {
            segmentRefs: [0, 1],
            brand: { name: 'LIGHT' },
            fareBasisCode: 'YLIGHT',
            includes: [
              { kind: 'carry-on', status: 'included', label: 'CARRY ON' },
              { kind: 'checked-bag', status: 'charge', label: 'BAG' },
              { kind: 'change', status: 'charge', label: 'CHANGE' },
              { kind: 'refund', status: 'not-offered', label: 'REFUND' },
            ],
          },
          {
            segmentRefs: [2],
            brand: { name: 'FULL' },
            includes: [
              { kind: 'carry-on', status: 'included', label: 'CARRY ON' },
              { kind: 'checked-bag', status: 'included', label: '23KG' },
              { kind: 'change', status: 'included', label: 'CHANGE' },
              { kind: 'refund', status: 'included', label: 'REFUND' },
            ],
          },
        ],
      }),
      formatMoney,
    );
    expect(conMarcas.map((leg) => leg.fares.map((fare) => fare.name))).toEqual([
      ['LIGHT'],
      ['FULL'],
    ]);
    expect(conMarcas[0]!.inclusionsSource).toBe('leg');
    expect(conMarcas[0]!.inclusions.map((chip) => chip.text)).toEqual([
      'Equipaje de mano',
      'Maleta con cargo',
      'Cambios con cargo',
      'No reembolsable',
    ]);
    expect(conMarcas[1]!.inclusions.map((chip) => chip.text)).toEqual([
      'Equipaje de mano',
      'Maleta facturada',
      'Cambios sin cargo',
      'Reembolsable',
    ]);
  });

  it('un itinerario sin vuelos no se pinta', () => {
    expect(
      buildTimeline(
        offer({ itineraries: [{ segments: [], stops: 0, totalDurationMinutes: 0 }] }),
        formatMoney,
      ),
    ).toEqual([]);
  });

  it('las fechas del viaje: la salida de la ida y la de la vuelta', () => {
    expect(travelDates(legs)).toBe(`${legs[0]!.departure.date} – ${legs[1]!.departure.date}`);
    expect(travelDates(legs.slice(0, 1))).toBe(legs[0]!.departure.date);
  });
});

describe('chips y escalas', () => {
  it('el detalle sólo acompaña si es corto y suma algo', () => {
    expect(inclusionChip('change', { value: 'partial', detail: 'Cargo US$ 50,00' })).toMatchObject({
      text: 'Cambios con cargo',
      detail: 'Cargo US$ 50,00',
    });
    expect(inclusionChip('change', { value: 'yes', detail: 'Sin cargo' }).detail).toBeUndefined();
    expect(
      inclusionChip('carry-on', { value: 'yes', detail: '1 cabin bag up to 10kg and 1 personal' })
        .detail,
    ).toBeUndefined();
    expect(inclusionChip('refund', { value: 'unknown' }).text).toBe('Reembolso sin informar');
  });

  it('un cambio de aeropuerto y una conexión corta se escriben', () => {
    const connection = {
      key: 'k',
      arrivalAirport: 'GRU',
      departureAirport: 'CGH',
      minutes: 40,
      changesAirport: true,
      tight: true,
      long: false,
    };
    expect(connectionLabel(connection)).toBe('Cambio de aeropuerto GRU → CGH · 40m');
    expect(connectionAlerts(connection)).toEqual(['Traslado entre aeropuertos', 'Conexión corta']);
  });

  it('varios trayectos encadenan la ruta', () => {
    expect(
      routeTitle([
        { origin: 'BOG', destination: 'LIM' },
        { origin: 'LIM', destination: 'CUZ' },
        { origin: 'CUZ', destination: 'BOG' },
      ]),
    ).toBe('BOG → LIM → CUZ → BOG');
  });
});
