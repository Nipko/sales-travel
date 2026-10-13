import { describe, expect, it } from 'vitest';
import { describeTicketingDeadline } from '../../../lib/ticketing-deadline';
import {
  DOCUMENT_STATUS_LABEL,
  FLIGHT_DOCUMENT_STATUSES,
  copyLocatorLabel,
  documentKindLabel,
  documentPassengerLabel,
  documentStatusTone,
  locatorChipLabel,
  orderTicketingDeadline,
  parseFlightTracking,
  providerReportsCancelled,
  retrieveNotice,
  retrieveSummary,
} from './flight-order-view';

/**
 * `flightTracking` como lo devuelve `GET /orders` (espejo de `publicFlightOrderTracking` del API)
 * y lo que Mis Reservas pinta de él.
 */
const TRACKING = {
  airlineLocators: [
    { carrierCode: 'LA', locator: 'XKCD12' },
    { carrierCode: 'AV', locator: 'QWERT9' },
  ],
  documents: [
    { number: '0457123456789', kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 },
    { number: '1251934576908', kind: 'EMD', status: 'VOIDED', travelerIndex: 1 },
  ],
  ticketingDeadline: { date: '2026-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
};

describe('parseFlightTracking', () => {
  it('lee la forma del API', () => {
    expect(parseFlightTracking(TRACKING)).toEqual(TRACKING);
  });

  it('sin seguimiento, o con algo que no es un objeto, no hay nada que pintar', () => {
    expect(parseFlightTracking(null)).toBeNull();
    expect(parseFlightTracking(undefined)).toBeNull();
    expect(parseFlightTracking('LA XKCD12')).toBeNull();
    expect(parseFlightTracking([])).toBeNull();
  });

  it('lo que no encaja se descarta entrada por entrada', () => {
    expect(
      parseFlightTracking({
        airlineLocators: [
          { carrierCode: 'LA', locator: 'XKCD12' },
          { carrierCode: 'la', locator: 'XKCD12' },
          { carrierCode: 'LA', locator: '<b>x</b>' },
          'LA XKCD12',
        ],
        documents: [
          { number: '0457123456789', kind: 'TICKET', status: 'ISSUED', travelerIndex: -1 },
          { number: '12', kind: 'TICKET', status: 'ISSUED' },
          { number: '0457123456780', kind: 'BOLETO', status: 'ISSUED' },
          { number: '0457123456781', kind: 'TICKET', status: 'PAGADO' },
        ],
        ticketingDeadline: { date: '20/10/2026', zone: 'UTC' },
      }),
    ).toEqual({
      airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
      documents: [
        { number: '0457123456789', kind: 'TICKET', status: 'ISSUED', travelerIndex: null },
      ],
      ticketingDeadline: null,
    });
  });

  it('un plazo con zona desconocida no es un plazo; la hora y el instante ilegibles se pierden solos', () => {
    expect(
      parseFlightTracking({ ticketingDeadline: { date: '2026-10-20', zone: 'LOCAL' } })
        ?.ticketingDeadline,
    ).toBeNull();
    expect(
      parseFlightTracking({
        ticketingDeadline: { date: '2026-10-20', time: '25:00', zone: 'UTC', at: 'mañana' },
      })?.ticketingDeadline,
    ).toEqual({ date: '2026-10-20', zone: 'UTC' });
  });
});

describe('textos de la reserva', () => {
  it('cada estado tiene su rótulo, y el desconocido no se presenta como emitido', () => {
    expect(FLIGHT_DOCUMENT_STATUSES.map((s) => DOCUMENT_STATUS_LABEL[s])).toEqual([
      'Emitido',
      'Anulado',
      'Reembolsado',
      'Cambiado',
      'Sin confirmar',
    ]);
    expect(documentStatusTone('ISSUED')).toBe('ok');
    expect(documentStatusTone('UNKNOWN')).toBe('warning');
    expect(documentStatusTone('VOIDED')).toBe('muted');
  });

  it('el chip dice la aerolínea y el código, y el botón dice qué copia', () => {
    expect(locatorChipLabel({ carrierCode: 'LA', locator: 'ABC123' })).toBe('LA · ABC123');
    expect(copyLocatorLabel({ carrierCode: 'LA', locator: 'ABC123' })).toBe(
      'Copiar localizador ABC123',
    );
    expect(documentKindLabel('TICKET')).toBe('Tiquete');
    expect(documentKindLabel('EMD')).toBe('EMD');
  });

  it('el pasajero de un tiquete sale de la reserva por su posición', () => {
    const pasajeros = [
      { givenName: 'Ana', surname: 'Ríos' },
      { givenName: ' ', surname: '' },
    ];
    const doc = (travelerIndex: number | null) => ({
      number: '0457123456789',
      kind: 'TICKET' as const,
      status: 'ISSUED' as const,
      travelerIndex,
    });
    expect(documentPassengerLabel(doc(0), pasajeros)).toBe('Ana Ríos');
    expect(documentPassengerLabel(doc(1), pasajeros)).toBe('Pasajero 2');
    expect(documentPassengerLabel(doc(5), pasajeros)).toBe('Pasajero 6');
    expect(documentPassengerLabel(doc(null), pasajeros)).toBe('—');
    expect(documentPassengerLabel(doc(0), undefined)).toBe('Pasajero 1');
  });
});

describe('orderTicketingDeadline — el plazo que se muestra', () => {
  const ahora = new Date('2026-10-13T10:00:00-05:00');

  it('el guardado de la reserva, con la hora de la oficina emisora', () => {
    const plazo = orderTicketingDeadline({ flightTracking: TRACKING });
    expect(plazo).toEqual({
      deadline: { kind: 'provider-clock', date: '2026-10-20', time: '23:59' },
      clock: 'office',
      fromOrder: false,
    });
    const texto = describeTicketingDeadline(plazo!.deadline, ahora, {
      clock: plazo!.clock,
      fromOrder: plazo!.fromOrder,
    });
    expect(texto).toMatch(/^Emitir antes del /);
    expect(texto).toContain('23:59 (hora local de la oficina emisora)');
    expect(texto).not.toContain('Sabre');
  });

  it('uno UTC es un instante: con el suyo, o armado con la fecha y la hora', () => {
    expect(
      orderTicketingDeadline({
        flightTracking: {
          ticketingDeadline: {
            date: '2026-10-20',
            time: '20:00',
            zone: 'UTC',
            at: '2026-10-20T20:00:00.000Z',
          },
        },
      })?.deadline,
    ).toEqual({ kind: 'instant', at: '2026-10-20T20:00:00.000Z' });
    expect(
      orderTicketingDeadline({
        flightTracking: { ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC' } },
      })?.deadline,
    ).toEqual({ kind: 'instant', at: '2026-10-20T20:00:00.000Z' });
    expect(
      orderTicketingDeadline({
        flightTracking: { ticketingDeadline: { date: '2026-10-20', zone: 'UTC' } },
      })?.deadline,
    ).toEqual({ kind: 'provider-clock', date: '2026-10-20' });
  });

  it('sin plazo guardado, el de la tarifa con la que se reservó', () => {
    const plazo = orderTicketingDeadline({
      flightTracking: { airlineLocators: [], documents: [], ticketingDeadline: null },
      selectedOffer: {
        provider: { raw: { lastTicketDate: '2026-10-18', lastTicketTime: '12:00' } },
      },
    });
    expect(plazo).toEqual({
      deadline: { kind: 'provider-clock', date: '2026-10-18', time: '12:00' },
      clock: 'fare',
      fromOrder: true,
    });
    expect(
      describeTicketingDeadline(plazo!.deadline, ahora, {
        clock: plazo!.clock,
        fromOrder: plazo!.fromOrder,
      }),
    ).toMatch(/Plazo de la tarifa: emitir antes del/);
  });

  it('sin ninguno de los dos, no hay plazo', () => {
    expect(orderTicketingDeadline({})).toBeNull();
    expect(orderTicketingDeadline({ flightTracking: null, selectedOffer: {} })).toBeNull();
  });
});

describe('retrieveSummary — el aviso de «Consultar estado»', () => {
  it('cuenta lo que quedó guardado, sin repetir números de tiquete', () => {
    const texto = retrieveSummary(parseFlightTracking(TRACKING));
    expect(texto).toBe('Reserva consultada: 2 localizadores de la aerolínea y 2 tiquetes al día.');
    expect(texto).not.toContain('0457123456789');
  });

  it('en singular, y con sólo una de las dos cosas', () => {
    expect(
      retrieveSummary(
        parseFlightTracking({ airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }] }),
      ),
    ).toBe('Reserva consultada: 1 localizador de la aerolínea al día.');
    expect(
      retrieveSummary(
        parseFlightTracking({
          documents: [{ number: '0457123456789', kind: 'TICKET', status: 'ISSUED' }],
        }),
      ),
    ).toBe('Reserva consultada: 1 tiquete al día.');
  });

  it('sin nada guardado lo dice, y sin seguimiento (otro proveedor) sólo confirma la consulta', () => {
    expect(retrieveSummary(parseFlightTracking({}))).toBe(
      'Reserva consultada. La aerolínea todavía no informó localizador ni tiquetes.',
    );
    expect(retrieveSummary(null)).toBe('Reserva consultada en el proveedor.');
  });
});

describe('retrieveNotice — una reserva que el proveedor ya canceló no pasa como «al día»', () => {
  it('sólo el estado cancelado exacto, en el vocabulario de cada proveedor', () => {
    expect(providerReportsCancelled('CANCELLED')).toBe(true);
    expect(providerReportsCancelled('cancelled')).toBe(true);
    expect(providerReportsCancelled(' Canceled ')).toBe(true);
    expect(providerReportsCancelled('CANCEL_PENDING')).toBe(false);
    expect(providerReportsCancelled('ACTIVE')).toBe(false);
    expect(providerReportsCancelled(undefined)).toBe(false);
    expect(providerReportsCancelled(7)).toBe(false);
  });

  it('cancelada en el proveedor y viva aquí: alerta, antes que los conteos', () => {
    const notice = retrieveNotice(parseFlightTracking(TRACKING), 'CANCELLED', 'confirmed');
    expect(notice).toEqual({
      message: 'La reserva figura cancelada en el proveedor. Revísala antes de cobrar o emitir.',
      alert: true,
    });
    expect(retrieveNotice(null, 'cancelled', 'ticketed').alert).toBe(true);
  });

  it('cancelada en los dos lados no es alerta', () => {
    expect(retrieveNotice(parseFlightTracking(TRACKING), 'CANCELLED', 'cancelled')).toEqual({
      message: 'Reserva consultada: también figura cancelada en el proveedor.',
      alert: false,
    });
  });

  it('viva en el proveedor: el aviso de siempre, con lo guardado', () => {
    const tracking = parseFlightTracking(TRACKING);
    expect(retrieveNotice(tracking, 'ACTIVE', 'confirmed')).toEqual({
      message: retrieveSummary(tracking),
      alert: false,
    });
    expect(retrieveNotice(null, undefined, 'confirmed')).toEqual({
      message: 'Reserva consultada en el proveedor.',
      alert: false,
    });
  });
});
