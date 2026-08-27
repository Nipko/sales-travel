import { describe, expect, it } from 'vitest';
import {
  buildItineraryView,
  dayOffset,
  layoverLabel,
  spreadPositions,
  summarizeCarriers,
  LONG_LAYOVER_MINUTES,
  TIGHT_LAYOVER_MINUTES,
  type ItineraryInput,
  type ItinerarySegmentInput,
} from './itinerary-view';

/**
 * Fechas SIN zona: `new Date` las lee en hora local, así que el resultado no depende del
 * TZ del runner. Es además la forma en que varios GDS mandan las horas locales del vuelo.
 * Junio evita los cambios de horario de verano de cualquier hemisferio.
 */
function seg(
  origin: string,
  destination: string,
  departureAt: string,
  arrivalAt: string,
  carrier = 'AV',
  flightNumber = '8020',
): ItinerarySegmentInput {
  return { carrier, flightNumber, origin, destination, departureAt, arrivalAt };
}

function itin(segments: ItinerarySegmentInput[], stops = segments.length - 1): ItineraryInput {
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const totalDurationMinutes = Math.round(
    (new Date(last.arrivalAt).getTime() - new Date(first.departureAt).getTime()) / 60_000,
  );
  return { segments, totalDurationMinutes, stops };
}

/** Lo que la fila necesita: dos marcas seguidas se tienen que leer como dos. */
const VISIBLY_APART = 0.08;

const DIRECT = itin([seg('BOG', 'LIM', '2026-06-15T08:00:00', '2026-06-15T11:20:00')]);

const ONE_STOP = itin([
  seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T08:50:00'),
  seg('MDE', 'LIM', '2026-06-15T10:30:00', '2026-06-15T13:40:00'),
]);

describe('buildItineraryView — directo', () => {
  it('no deja ninguna marca en la línea', () => {
    const view = buildItineraryView(DIRECT);
    expect(view.stops).toBe(0);
    expect(view.layovers).toEqual([]);
    expect(view.hasAlert).toBe(false);
  });
});

describe('buildItineraryView — escalas', () => {
  it('describe la escala con su aeropuerto y su espera real', () => {
    const [layover, ...rest] = buildItineraryView(ONE_STOP).layovers;
    expect(rest).toEqual([]);
    expect(layover?.arrivalAirport).toBe('MDE');
    expect(layover?.departureAirport).toBe('MDE');
    expect(layover?.minutes).toBe(100);
    expect(layover?.alerts).toEqual([]);
  });

  it('ubica la marca por tiempo transcurrido, no en un punto fijo', () => {
    // Mismo trayecto y misma duración total; la escala cambia de momento.
    const early = itin([
      seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T08:40:00'),
      seg('MDE', 'LIM', '2026-06-15T09:20:00', '2026-06-15T16:00:00'),
    ]);
    const late = itin([
      seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T14:20:00'),
      seg('MDE', 'LIM', '2026-06-15T15:00:00', '2026-06-15T16:00:00'),
    ]);
    const earlyPos = buildItineraryView(early).layovers[0]!.position;
    const latePos = buildItineraryView(late).layovers[0]!.position;
    expect(earlyPos).toBeLessThan(latePos - VISIBLY_APART);
    expect(earlyPos).toBeGreaterThan(0);
    expect(latePos).toBeLessThan(1);
  });

  it('separa dos escalas pegadas en el tiempo para que no se pisen', () => {
    // Dos saltos cortos al principio de un itinerario largo: por tiempo puro las dos marcas
    // caerían a menos de tres centésimas de la línea, o sea encima una de la otra.
    const twoQuick = itin([
      seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T08:30:00'),
      seg('MDE', 'CLO', '2026-06-15T08:50:00', '2026-06-15T09:10:00'),
      seg('CLO', 'GRU', '2026-06-15T09:35:00', '2026-06-15T20:00:00'),
    ]);
    const [a, b, ...rest] = buildItineraryView(twoQuick).layovers.map((l) => l.position);
    expect(rest).toEqual([]);
    expect(b! - a!).toBeGreaterThanOrEqual(VISIBLY_APART);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(1);
  });

  it('marca el cambio de aeropuerto: se llega a uno y se sale de otro', () => {
    const view = buildItineraryView(
      itin([
        seg('BOG', 'GRU', '2026-06-15T08:00:00', '2026-06-15T14:00:00'),
        seg('CGH', 'MVD', '2026-06-15T17:00:00', '2026-06-15T19:30:00'),
      ]),
    );
    const layover = view.layovers[0]!;
    expect(layover.arrivalAirport).toBe('GRU');
    expect(layover.departureAirport).toBe('CGH');
    expect(layover.alerts).toContain('airport-change');
    expect(view.hasAlert).toBe(true);
  });

  it('avisa la escala larga a partir del umbral, no antes', () => {
    const at = (minutes: number) =>
      buildItineraryView(
        itin([
          seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T09:00:00'),
          seg(
            'MDE',
            'LIM',
            new Date(new Date('2026-06-15T09:00:00').getTime() + minutes * 60_000).toISOString(),
            '2026-06-16T06:00:00',
          ),
        ]),
      ).layovers[0]!;

    expect(at(LONG_LAYOVER_MINUTES).alerts).toContain('long');
    expect(at(LONG_LAYOVER_MINUTES - 1).alerts).toEqual([]);
  });

  it('avisa la conexión corta por debajo del umbral, no en el umbral', () => {
    const at = (minutes: number) =>
      buildItineraryView(
        itin([
          seg('BOG', 'MDE', '2026-06-15T08:00:00', '2026-06-15T09:00:00'),
          seg(
            'MDE',
            'LIM',
            new Date(new Date('2026-06-15T09:00:00').getTime() + minutes * 60_000).toISOString(),
            '2026-06-15T13:00:00',
          ),
        ]),
      ).layovers[0]!;

    expect(at(TIGHT_LAYOVER_MINUTES - 1).alerts).toContain('tight');
    expect(at(TIGHT_LAYOVER_MINUTES).alerts).toEqual([]);
  });

  it('nunca reporta una espera negativa aunque el proveedor mande horas incoherentes', () => {
    const broken = buildItineraryView(
      itin([
        seg('BOG', 'MDE', '2026-06-15T10:00:00', '2026-06-15T12:00:00'),
        seg('MDE', 'LIM', '2026-06-15T09:00:00', '2026-06-15T11:00:00'),
      ]),
    );
    expect(broken.layovers[0]!.minutes).toBe(0);
    expect(broken.layovers[0]!.position).toBeGreaterThanOrEqual(0);
    expect(broken.layovers[0]!.position).toBeLessThanOrEqual(1);
  });

  it('el conteo nunca queda por debajo de las escalas que sí se dibujan', () => {
    // El proveedor declara 0 pero manda dos tramos: el texto no puede decir "Directo".
    expect(buildItineraryView(itin(ONE_STOP.segments, 0)).stops).toBe(1);
    // Al revés —escala técnica que no parte el itinerario— manda el número del proveedor.
    expect(buildItineraryView(itin(ONE_STOP.segments, 2)).stops).toBe(2);
  });
});

describe('dayOffset', () => {
  it('cuenta el día que se cruza aunque el vuelo dure poco', () => {
    expect(dayOffset('2026-06-15T21:50:00', '2026-06-16T00:40:00')).toBe(1);
  });

  it('no inventa un día en un vuelo largo que aterriza el mismo día', () => {
    expect(dayOffset('2026-06-15T06:00:00', '2026-06-15T23:30:00')).toBe(0);
  });

  it('cuenta dos días en un itinerario con noche en tierra', () => {
    expect(dayOffset('2026-06-15T22:00:00', '2026-06-17T05:00:00')).toBe(2);
  });

  it('devuelve 0 ante una fecha ilegible en vez de romper la fila', () => {
    expect(dayOffset('no-es-una-fecha', '2026-06-16T00:40:00')).toBe(0);
  });
});

describe('spreadPositions', () => {
  it('no coloca nada cuando no hay escalas', () => {
    expect(spreadPositions([])).toEqual([]);
  });

  it('conserva el orden de las escalas', () => {
    const out = spreadPositions([0.1, 0.5, 0.9]);
    expect(out[0]).toBeLessThan(out[1]!);
    expect(out[1]).toBeLessThan(out[2]!);
  });

  it('abre hueco entre marcas prácticamente superpuestas', () => {
    const out = spreadPositions([0.2, 0.21, 0.22]);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(VISIBLY_APART);
    }
  });

  it('mantiene las marcas dentro de la línea y lejos de los extremos', () => {
    const cases = [
      spreadPositions([0, 1]),
      spreadPositions([0.5, 0.5, 0.5]),
      // Amontonadas contra el final: abrir hueco hacia adelante las empuja fuera de la
      // línea, así que el reacomodo tiene que devolverlas hacia atrás.
      spreadPositions([0.9, 0.95, 1, 1]),
    ];
    for (const out of cases) {
      for (const p of out) {
        expect(p).toBeGreaterThan(0.05);
        expect(p).toBeLessThan(0.95);
      }
    }
  });

  it('reparte parejo cuando no caben con separación mínima', () => {
    const out = spreadPositions([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(out).toHaveLength(10);
    expect(new Set(out).size).toBe(10);
    for (let i = 0; i < out.length; i += 1) {
      // Ninguna se sale de la línea, aunque para eso haya que perder la proporción.
      expect(out[i]).toBeGreaterThan(0.05);
      expect(out[i]).toBeLessThan(0.95);
      if (i > 0) expect(out[i]).toBeGreaterThan(out[i - 1]!);
    }
  });

  it('no se descoloca con valores fuera de rango o no numéricos', () => {
    for (const p of spreadPositions([-5, Number.NaN, 12])) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('summarizeCarriers', () => {
  it('toma la aerolínea y el vuelo del primer tramo', () => {
    const s = summarizeCarriers([ONE_STOP]);
    expect(s.main).toBe('AV');
    expect(s.firstFlight).toBe('AV 8020');
    expect(s.carriers).toEqual(['AV']);
  });

  it('detecta el interlínea sin repetir la misma aerolínea', () => {
    const s = summarizeCarriers([
      itin([
        seg('BOG', 'LIM', '2026-06-15T08:00:00', '2026-06-15T11:00:00', 'AV', '80'),
        seg('LIM', 'SCL', '2026-06-15T13:00:00', '2026-06-15T17:00:00', 'LA', '600'),
        seg('SCL', 'MVD', '2026-06-15T19:00:00', '2026-06-15T21:00:00', 'AV', '90'),
      ]),
    ]);
    expect(s.carriers).toEqual(['AV', 'LA']);
    expect(s.main).toBe('AV');
  });

  it('no explota sin itinerarios', () => {
    expect(summarizeCarriers([])).toEqual({ main: '', carriers: [], firstFlight: '' });
  });
});

describe('layoverLabel', () => {
  const hhmm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  const base = { arrivalAirport: 'MDE', departureAirport: 'MDE', minutes: 100, position: 0.5 };

  it('escribe aeropuerto y espera cuando la escala es normal', () => {
    expect(layoverLabel({ ...base, alerts: [] }, hhmm)).toBe('MDE 1h 40m');
  });

  it('dice por qué la escala es un problema, sin depender del color', () => {
    expect(layoverLabel({ ...base, minutes: 300, alerts: ['long'] }, hhmm)).toContain(
      'escala larga',
    );
    expect(layoverLabel({ ...base, minutes: 30, alerts: ['tight'] }, hhmm)).toContain(
      'conexión corta',
    );
  });

  it('el cambio de aeropuerto manda y muestra los dos aeropuertos', () => {
    const label = layoverLabel(
      {
        arrivalAirport: 'GRU',
        departureAirport: 'CGH',
        minutes: 300,
        position: 0.5,
        alerts: ['airport-change', 'long'],
      },
      hhmm,
    );
    expect(label).toBe('GRU → CGH 5h 00m · cambio de aeropuerto');
  });
});
