import { describe, expect, it } from 'vitest';
import type { Order } from './order-model';
import { flightOfferOf } from './order-model';
import {
  billingView,
  chargeSummary,
  deadlineCountdown,
  maskedDocument,
  reservationActions,
  reservationHero,
  reservationLocator,
} from './reservation-detail-view';

const NOW = new Date('2026-11-04T12:00:00Z');

function order(patch: Partial<Order> = {}): Order {
  return {
    id: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
    pnr: 'ABC123',
    status: 'confirmed',
    orderNumber: 42,
    searchCriteria: { origin: 'BOG', destination: 'LIM' },
    passengers: [{ givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' }],
    contactInfo: { email: 'ana@example.com' },
    totalAmount: 500_00,
    currency: 'USD',
    createdAt: '2026-11-04T10:00:00Z',
    capabilities: { retrieve: true, cancel: true, pay: false, services: false, reshop: false },
    ...patch,
  };
}

describe('reservationHero — el estado como titular', () => {
  it('confirmada con pago diferido: «Pendiente de pago» con el plazo escrito', () => {
    const hero = reservationHero(
      order({
        capabilities: { retrieve: true, cancel: true, pay: true, services: false, reshop: false },
        flightTracking: {
          airlineLocators: [],
          documents: [],
          ticketingDeadline: { date: '2026-11-05', zone: 'UTC', time: '18:00' },
        },
      }),
      NOW,
    );
    expect(hero).toMatchObject({ kind: 'awaiting-payment', label: 'Pendiente de pago' });
    expect(hero.description).toContain('Emitir antes del');
  });

  it('confirmada con emisión sin tarjeta: «Pendiente de emisión»', () => {
    const hero = reservationHero(
      order({
        capabilities: {
          retrieve: true,
          cancel: true,
          pay: false,
          services: false,
          reshop: false,
          issue: true,
        },
      }),
      NOW,
    );
    expect(hero.label).toBe('Pendiente de emisión');
  });

  it('emitida, cancelada, fallida y confirmada sin nada pendiente', () => {
    expect(reservationHero(order({ status: 'ticketed' }), NOW).label).toBe('Emitida');
    expect(reservationHero(order({ status: 'cancelled' }), NOW).tone).toBe('danger');
    expect(
      reservationHero(order({ status: 'failed', errorMessage: 'Sin cupo' }), NOW).description,
    ).toBe('Sin cupo');
    expect(reservationHero(order(), NOW)).toMatchObject({ kind: 'confirmed', tone: 'info' });
  });

  it('una creación sin PNR y con error queda «Pendiente de conciliación»', () => {
    const hero = reservationHero(
      order({ status: 'pending', pnr: null, errorMessage: 'Timeout del proveedor.' }),
      NOW,
    );
    expect(hero.kind).toBe('reconciliation');
    expect(hero.description).toContain('No vuelvas a reservar');
  });
});

describe('deadlineCountdown', () => {
  const withDeadline = (at: string) =>
    order({
      flightTracking: {
        airlineLocators: [],
        documents: [],
        ticketingDeadline: { date: at.slice(0, 10), zone: 'UTC', at },
      },
    });

  it('cuenta días, horas y minutos', () => {
    expect(deadlineCountdown(withDeadline('2026-11-06T15:00:00Z'), NOW)).toEqual({
      text: 'Quedan 2 d 3 h',
      expired: false,
      urgent: false,
    });
    expect(deadlineCountdown(withDeadline('2026-11-04T14:30:00Z'), NOW)).toEqual({
      text: 'Quedan 2 h 30 min',
      expired: false,
      urgent: true,
    });
    expect(deadlineCountdown(withDeadline('2026-11-04T12:00:20Z'), NOW)?.text).toBe('Quedan 1 min');
  });

  it('vencido, sin instante o ya no confirmada: lo dice o no cuenta', () => {
    expect(deadlineCountdown(withDeadline('2026-11-04T11:00:00Z'), NOW)?.expired).toBe(true);
    expect(
      deadlineCountdown(
        order({
          flightTracking: {
            airlineLocators: [],
            documents: [],
            ticketingDeadline: { date: '2026-11-05', zone: 'PROVIDER_LOCAL', time: '18:00' },
          },
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      deadlineCountdown({ ...withDeadline('2026-11-06T15:00:00Z'), status: 'ticketed' }, NOW),
    ).toBeNull();
  });
});

describe('reservationLocator', () => {
  it('el de la aerolínea primero, el del proveedor de segundo', () => {
    expect(
      reservationLocator(
        order({
          flightTracking: {
            airlineLocators: [
              { carrierCode: 'LA', locator: 'XYZ789' },
              { carrierCode: 'AV', locator: 'QWE456' },
            ],
            documents: [],
            ticketingDeadline: null,
          },
        }),
      ),
    ).toEqual({
      code: 'XYZ789',
      label: 'Localizador de la aerolínea (LA)',
      secondary: { code: 'ABC123', label: 'Reserva en el proveedor' },
      others: [{ code: 'QWE456', label: 'Aerolínea AV' }],
    });
  });

  it('sin localizador de aerolínea, el de la reserva; sin ninguno, nada', () => {
    expect(reservationLocator(order())).toEqual({
      code: 'ABC123',
      label: 'Código de reserva',
      others: [],
    });
    expect(reservationLocator(order({ pnr: null }))).toBeNull();
  });
});

describe('reservationActions — la principal a la vista, el resto en el menú', () => {
  const free = { issueInFlight: false, cancelBlocked: false };

  it('con pago: «Pagar» primero y cancelar al final', () => {
    const actions = reservationActions(
      order({
        capabilities: { retrieve: true, cancel: true, pay: true, services: false, reshop: false },
      }),
      free,
    );
    expect(actions).toEqual({ primary: 'pay', secondary: ['retrieve', 'resend', 'cancel'] });
  });

  it('con emisión sin tarjeta: «Emitir tiquete», y mientras se emite no se ofrece otra vez', () => {
    const conEmision = order({
      capabilities: {
        retrieve: true,
        cancel: true,
        pay: false,
        services: false,
        reshop: false,
        issue: true,
        addServices: true,
        modify: true,
      },
    });
    expect(reservationActions(conEmision, free)).toEqual({
      primary: 'issue',
      secondary: ['retrieve', 'services', 'travelers', 'resend', 'cancel'],
    });
    expect(reservationActions(conEmision, { ...free, issueInFlight: true })).toEqual({
      primary: 'retrieve',
      secondary: ['resend', 'cancel'],
    });
  });

  it('sin historial confiable no se ofrece cancelar', () => {
    expect(reservationActions(order(), { ...free, cancelBlocked: true }).secondary).not.toContain(
      'cancel',
    );
  });

  it('cancelada: sólo reenviar la confirmación', () => {
    expect(reservationActions(order({ status: 'cancelled' }), free)).toEqual({
      primary: null,
      secondary: ['resend'],
    });
  });

  it('emitida: no se cancela (eso es anular tiquetes)', () => {
    expect(reservationActions(order({ status: 'ticketed' }), free)).toEqual({
      primary: 'retrieve',
      secondary: ['resend'],
    });
  });
});

describe('billingView', () => {
  it('lee la facturación guardada en la cotización', () => {
    expect(
      billingView({
        billing: {
          mode: 'other',
          customerType: 'company',
          name: 'Viajes SAS',
          documentType: 'NIT',
          documentNumber: '900123456',
          email: 'fact@viajes.co',
          phone: '',
          address: 'Cra 7 # 1',
          city: 'Bogotá',
          countryCode: 'CO',
        },
      }),
    ).toEqual({
      name: 'Viajes SAS',
      company: true,
      document: 'NIT 900123456',
      email: 'fact@viajes.co',
      address: 'Cra 7 # 1, Bogotá, CO',
    });
  });

  it('al pasajero sin nombre guardado: el del pasajero 1; sin nada: null', () => {
    expect(
      billingView(
        { billing: { mode: 'passenger', email: 'ana@example.com' } },
        { givenName: 'Ana', surname: 'Pérez' },
      ),
    ).toMatchObject({ name: 'Ana Pérez', email: 'ana@example.com' });
    expect(billingView({ billing: null })).toBeNull();
    expect(billingView(null)).toBeNull();
  });
});

describe('flightOfferOf y documentos', () => {
  it('sólo una oferta con itinerario y montos se pinta como vuelo', () => {
    expect(flightOfferOf({ selectedOffer: { category: 'SUV' } })).toBeNull();
    const money = { amountMinor: 1, currency: 'USD' };
    const offer = {
      itineraries: [
        {
          totalDurationMinutes: 60,
          stops: 0,
          segments: [
            {
              carrier: 'LA',
              flightNumber: '1',
              origin: 'BOG',
              destination: 'LIM',
              departureAt: '2026-11-10T08:00:00-05:00',
              arrivalAt: '2026-11-10T11:00:00-05:00',
              durationMinutes: 180,
            },
          ],
        },
      ],
      total: money,
      taxes: money,
      baseFare: money,
      provider: { name: 'latam-ndc' },
    };
    expect(flightOfferOf({ selectedOffer: offer })).not.toBeNull();
    expect(flightOfferOf({ selectedOffer: { ...offer, total: undefined } })).toBeNull();
  });

  it('el documento va enmascarado', () => {
    expect(maskedDocument({ type: 'CC', numberLast4: '4821' })).toBe('CC ••••4821');
    expect(maskedDocument({ type: 'P' })).toBe('P');
    expect(maskedDocument(undefined)).toBe('');
  });
});

describe('chargeSummary', () => {
  it('dice qué se cobró según el estado y la cartera', () => {
    expect(chargeSummary(order())).toBe('Sin cobro todavía: la reserva se creó sin pagar');
    expect(chargeSummary(order({ walletHold: 'held' }))).toContain('retenido');
    expect(chargeSummary(order({ walletHold: 'captured', status: 'ticketed' }))).toBe(
      'Cobrado de la cartera de la agencia',
    );
    expect(chargeSummary(order({ status: 'ticketed' }))).toBe('Pagada y emitida');
    expect(chargeSummary(order({ status: 'cancelled', walletHold: 'held' }))).toBe('Sin cobro');
  });
});
