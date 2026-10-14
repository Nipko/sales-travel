import { describe, expect, it } from 'vitest';
import {
  DEADLINE_ALERT_WINDOW_MS,
  deadlineAlertClock,
  dueDeadlineAlert,
  flightRouteOf,
  passengerFirstNames,
  reservasLink,
} from './flight-deadline-alert.plan.js';

/*
 * El aviso del plazo de emisión por vencer (SAB-14), sin I/O: qué umbral toca y cómo se escribe la
 * hora para la agencia.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const AHORA = Date.parse('2026-10-14T15:00:00.000Z');

function estado(
  faltaMs: number,
  avisos: { alerted24hAt?: Date | null; alerted2hAt?: Date | null } = {},
) {
  return {
    deadlineAt: new Date(AHORA + faltaMs),
    alerted24hAt: avisos.alerted24hAt ?? null,
    alerted2hAt: avisos.alerted2hAt ?? null,
  };
}

describe('dueDeadlineAlert — qué aviso toca', () => {
  it('las ventanas son de 24 h y de 2 h', () => {
    expect(DEADLINE_ALERT_WINDOW_MS).toEqual({ '24h': 24 * HORA, '2h': 2 * HORA });
  });

  it('a más de 24 h, ninguno; dentro de las 24 h, el de 24 h', () => {
    expect(dueDeadlineAlert(estado(24 * HORA + MIN), AHORA)).toBeNull();
    expect(dueDeadlineAlert(estado(24 * HORA), AHORA)).toBe('24h');
    expect(dueDeadlineAlert(estado(3 * HORA), AHORA)).toBe('24h');
  });

  it('dentro de las 2 h, el de 2 h; aunque nunca haya salido el de 24 h', () => {
    expect(dueDeadlineAlert(estado(2 * HORA), AHORA)).toBe('2h');
    expect(dueDeadlineAlert(estado(30 * MIN), AHORA)).toBe('2h');
    expect(dueDeadlineAlert(estado(HORA, { alerted24hAt: new Date(AHORA - HORA) }), AHORA)).toBe(
      '2h',
    );
  });

  it('idempotente por umbral: el que ya salió no vuelve a tocar', () => {
    const ayer = new Date(AHORA - 20 * HORA);
    expect(dueDeadlineAlert(estado(10 * HORA, { alerted24hAt: ayer }), AHORA)).toBeNull();
    expect(
      dueDeadlineAlert(estado(HORA, { alerted24hAt: ayer, alerted2hAt: new Date(AHORA) }), AHORA),
    ).toBeNull();
    // El de 2 h marca los dos: ya no vuelve el de 24 h aunque la columna dijera otra cosa.
    expect(dueDeadlineAlert(estado(10 * HORA, { alerted2hAt: ayer }), AHORA)).toBeNull();
  });

  it('un plazo vencido no se avisa: la reserva no se cancela sola aquí', () => {
    expect(dueDeadlineAlert(estado(0), AHORA)).toBeNull();
    expect(dueDeadlineAlert(estado(-HORA), AHORA)).toBeNull();
    expect(
      dueDeadlineAlert({ ...estado(HORA), deadlineAt: new Date(Number.NaN) }, AHORA),
    ).toBeNull();
  });
});

describe('deadlineAlertClock — la hora del aviso', () => {
  // 18:00 de Bogotá = 23:00 UTC = 20:00 de São Paulo.
  const plazo = new Date('2026-10-14T23:00:00.000Z');

  it('en la hora de la agencia, hoy, sin línea de oficina si es la misma hora', () => {
    expect(
      deadlineAlertClock({
        at: plazo,
        now: AHORA,
        officeTimeZone: 'America/Bogota',
        agencyTimeZone: 'America/Lima',
      }),
    ).toEqual({ source: 'agency', when: 'hoy', day: 'mié 14 oct', time: '18:00', offset: 'GMT-5' });
  });

  it('con una agencia en otra hora, la de la oficina va aparte', () => {
    expect(
      deadlineAlertClock({
        at: plazo,
        now: AHORA,
        officeTimeZone: 'America/Bogota',
        agencyTimeZone: 'America/Sao_Paulo',
      }),
    ).toEqual({
      source: 'agency',
      when: 'hoy',
      day: 'mié 14 oct',
      time: '20:00',
      offset: 'GMT-3',
      office: { day: 'mié 14 oct', time: '18:00', offset: 'GMT-5' },
    });
  });

  it('sin agencia conocida, en la hora de la oficina; sin ninguna, en UTC', () => {
    expect(
      deadlineAlertClock({ at: plazo, now: AHORA, officeTimeZone: 'America/Bogota' }),
    ).toMatchObject({ source: 'office', time: '18:00', offset: 'GMT-5' });
    expect(deadlineAlertClock({ at: plazo, now: AHORA, agencyTimeZone: 'Marte/Olympus' })).toEqual({
      source: 'utc',
      when: 'hoy',
      day: 'mié 14 oct',
      time: '23:00',
      offset: 'GMT',
    });
  });

  it('«mañana» y una fecha más lejana con su día', () => {
    const manana = new Date('2026-10-15T14:00:00.000Z');
    expect(
      deadlineAlertClock({ at: manana, now: AHORA, agencyTimeZone: 'America/Bogota' }),
    ).toMatchObject({ when: 'mañana', time: '09:00' });
    const lejos = new Date('2026-10-17T14:00:00.000Z');
    expect(
      deadlineAlertClock({ at: lejos, now: AHORA, agencyTimeZone: 'America/Bogota' }).when,
    ).toBe('el sáb 17 oct');
  });

  it('el día lo decide la zona de quien lee: las 23:00 UTC ya son mañana en São Paulo', () => {
    const noche = new Date('2026-10-15T03:30:00.000Z');
    expect(
      deadlineAlertClock({ at: noche, now: AHORA, agencyTimeZone: 'America/Bogota' }),
    ).toMatchObject({ when: 'hoy', time: '22:30' });
    expect(
      deadlineAlertClock({ at: noche, now: AHORA, agencyTimeZone: 'America/Sao_Paulo' }),
    ).toMatchObject({ when: 'mañana', time: '00:30' });
  });
});

describe('lo que el aviso cuenta de la reserva', () => {
  it('sólo nombres de pila: ni apellidos, ni segundos nombres, ni documentos', () => {
    expect(
      passengerFirstNames([
        { givenName: 'Ana María', surname: 'Ríos', identityDoc: { number: '123' } },
        { givenName: '  Luis ', surname: 'Paz' },
        { givenName: '', surname: 'Sin Nombre' },
        { surname: 'Solo' },
        null,
        'texto',
      ]),
    ).toEqual(['Ana', 'Luis']);
    expect(passengerFirstNames({})).toEqual([]);
  });

  it('ruta y salida de la búsqueda, o vacías', () => {
    expect(
      flightRouteOf({ origin: 'BOG', destination: 'LIM', departureDate: '2026-10-20' }),
    ).toEqual({ route: 'BOG → LIM', departureDate: '2026-10-20' });
    expect(flightRouteOf({ origin: 'BOG' })).toEqual({ route: '', departureDate: '' });
    expect(flightRouteOf(null)).toEqual({ route: '', departureDate: '' });
  });

  it('el enlace abre la reserva en Reservas', () => {
    expect(reservasLink('abc-1', 'https://app.ejemplo.test/')).toBe(
      'https://app.ejemplo.test/reservas?orden=abc-1',
    );
    expect(reservasLink('a b', undefined)).toBe('https://app.planetour.cloud/reservas?orden=a%20b');
  });
});
