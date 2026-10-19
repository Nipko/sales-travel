import type { AncillaryCatalog, Offer, SeatMap } from '@sales-travel/canonical';
import {
  OrderCreateNotSentError,
  type OrderCreateRequest,
  type TicketIssueResult,
} from '@sales-travel/domain';
import { SabreApiError, SabreCancelBookingBuildError } from '@sales-travel/sabre';
import { describe, expect, it } from 'vitest';
import {
  TicketVoidNotAvailableError,
  type OrderCancelAudit,
  type OrderCancelScope,
} from '../../providers/provider.types.js';
import { CertEvidenceRecorder } from './captures.js';
import { SabreCertGuardError } from './cert-guard.js';
import { CERT_SCENARIOS, buildCertPlan, type CertPlan, type CertPlanInput } from './plan.js';
import {
  certainCreateRejection,
  describeCertError,
  freeSeatFor,
  pricedBagFor,
  runCertPlan,
  type CertAclPort,
  type CertFlightPort,
  type CertRunnerDeps,
} from './scenarios.js';

/**
 * El runner con un adapter falso: sin red, sin base. Lo que se prueba es la disciplina de la
 * corrida —qué se anuncia antes de mover dinero, qué se limpia en `finally` y qué queda reportado
 * como colgado—, no Sabre.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function offer(source: string, amountMinor: number): Offer {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: TENANT,
    products: ['flight'],
    provider: { name: 'sabre', offerRef: `ref-${String(amountMinor)}`, source },
    total: { amountMinor, currency: 'USD' },
    baseFare: { amountMinor, currency: 'USD' },
    taxes: { amountMinor: 0, currency: 'USD' },
    fetchedAt: '2026-10-14T00:00:00Z',
    expiresAt: '2026-10-14T01:00:00Z',
    itineraries: [
      {
        segments: [
          {
            carrier: 'LA',
            flightNumber: '2401',
            origin: 'BOG',
            destination: 'LIM',
            departureAt: '2026-11-13T08:00:00-05:00',
            arrivalAt: '2026-11-13T11:00:00-05:00',
            durationMinutes: 180,
            cabin: 'economy',
            bookingClass: 'Y',
          },
        ],
      },
    ],
  } as unknown as Offer;
}

interface FakeOptions {
  readonly failRetrieveAfterCreate?: boolean;
  readonly createThrows?: Error;
  /** Responde a cada `createBooking`: un error lo rechaza, `undefined` lo deja pasar. */
  readonly createRejects?: (request: OrderCreateRequest) => Error | undefined;
  readonly issueThrows?: Error;
  readonly issueOutcome?: TicketIssueResult['outcome'];
  readonly voidThrows?: Error;
  readonly cancelThrows?: Error;
  readonly cancelUnverified?: boolean;
  readonly offers?: Offer[];
  /** Desenlace del `modifyTravelers` del viajero frecuente. */
  readonly loyaltyOutcome?: 'MODIFIED' | 'FAILED';
}

function fakeFlights(events: string[], options: FakeOptions = {}): CertFlightPort {
  let created = 0;
  let reads = 0;
  const cancelAudit = (scope?: OrderCancelScope): OrderCancelAudit => ({
    result: { success: true, warnings: [] },
    audit: { scope: scope?.ticketOperation ?? 'ALL' },
    verified: options.cancelUnverified !== true,
  });
  return {
    search: () => {
      events.push('search');
      return Promise.resolve(
        options.offers ?? [offer('NDC', 5_000), offer('ATPCO', 9_000), offer('ATPCO', 7_000)],
      );
    },
    priceOffer: (o) => {
      events.push(`price ${o.provider.offerRef}`);
      return Promise.resolve({ offer: o, priceChanged: false, warnings: [] });
    },
    createOrderAudited: (request: OrderCreateRequest) => {
      events.push(`create ${String(request.passengers.length)}pax${request.seats ? ' seat' : ''}`);
      if (options.createThrows) return Promise.reject(options.createThrows);
      const rejected = options.createRejects?.(request);
      if (rejected) return Promise.reject(rejected);
      created += 1;
      return Promise.resolve({
        result: {
          outcome: 'CONFIRMED',
          pnr: `PNR00${String(created)}`,
          items: [],
          issues: [],
        },
        audit: { audited: true },
        providerRaw: {},
        hasVersionStamp: false,
      });
    },
    retrieveForDisplay: (pnr) => {
      reads += 1;
      events.push(`read ${pnr}`);
      if (options.failRetrieveAfterCreate === true && reads === 1) {
        return Promise.reject(new Error('lectura caída'));
      }
      return Promise.resolve({ found: true, pnr, airlineLocators: [], warnings: [] });
    },
    cancelOrderAudited: (pnr, _ctx, scope) => {
      const op = scope?.ticketOperation ?? 'ALL';
      events.push(`cancel ${pnr} ${op}`);
      if (op === 'VOID' && options.voidThrows) return Promise.reject(options.voidThrows);
      if (op === 'ALL' && options.cancelThrows) return Promise.reject(options.cancelThrows);
      return Promise.resolve(cancelAudit(scope));
    },
    issueTickets: (pnr, _ctx, opts) => {
      events.push(
        `issue ${pnr} x${String(opts.travelerCount)}${opts.ancillaryCharge ? ` emd ${String(opts.ancillaryCharge.amountMinor)}` : ''}`,
      );
      if (options.issueThrows) return Promise.reject(options.issueThrows);
      const outcome = options.issueOutcome ?? 'ISSUED';
      return Promise.resolve({
        outcome,
        documents:
          outcome === 'ISSUED'
            ? [{ number: '0451234567890', kind: 'TICKET', status: 'ISSUED', travelerIndex: 0 }]
            : [],
        warnings: [],
        issues: [],
        idempotencyKey: 'k',
        formOfPaymentType: 'CASH',
      });
    },
    checkTickets: (pnr) => {
      events.push(`check ${pnr}`);
      return Promise.resolve({
        checkedAt: '2026-10-14T00:00:00Z',
        tickets: [
          {
            number: '0451234567890',
            voidable: 'yes',
            refundable: 'yes',
            refund: { totalMinor: 7_000, penaltyMinor: 1_000, currency: 'USD' },
          },
        ],
        cancelOffers: [],
      });
    },
    getSeatMap: () => {
      events.push('seats');
      return Promise.resolve(SEAT_MAP);
    },
    listAncillaries: (order) => {
      events.push(`ancillaries ${order.orderId} ${order.contentSource ?? '-'}`);
      return Promise.resolve(CATALOG);
    },
    addAncillaries: (order, selections) => {
      events.push(`add ${order.orderId} ${selections[0]?.serviceOfferItemId ?? ''}`);
      return Promise.resolve({
        outcome: 'ADDED',
        added: [
          {
            serviceOfferItemId: 'bag-1',
            passengerIndex: 0,
            providerItemIds: ['7'],
            providerItemIdsShared: false,
          },
        ],
        failed: [],
        unverified: [],
        issues: [],
      });
    },
    removeAncillaries: () => Promise.reject(new Error('no se usa')),
    readTravelers: (order) => {
      events.push(`travelers ${order.orderId}`);
      return Promise.resolve({
        travelers: [
          {
            index: 0,
            documents: [{ type: 'PASSPORT', numberLast4: '0999', issuingCountry: 'CO' }],
            loyalty: [],
            specialServices: ['WCHR'],
          },
        ],
        supported: ['identityDocuments', 'loyalty', 'specialServices'],
        warnings: [],
      });
    },
    modifyTravelers: (order, changes) => {
      const change = changes[0];
      const field = change?.loyalty !== undefined ? 'loyalty' : 'identityDocuments';
      events.push(
        `modify ${order.orderId} ${order.contentSource ?? '-'} ${order.passengers[0]?.surname ?? '-'} ${field}${change?.loyalty === undefined ? '' : ` ${change.loyalty.carrierCode}`}`,
      );
      const failed = field === 'loyalty' && options.loyaltyOutcome === 'FAILED';
      return Promise.resolve({
        outcome: failed ? 'FAILED' : 'MODIFIED',
        unchanged: false,
        applied: failed ? [] : [{ index: 0, field }],
        pending: failed ? [{ index: 0, field }] : [],
        attempts: 1,
        ...(failed ? { failureReason: 'REJECTED' as const } : {}),
        issues: failed
          ? [
              {
                severity: 'ERROR' as const,
                category: 'APPLICATION_ERROR',
                type: 'UNABLE_TO_UPDATE_RESERVATION_LOYALTY_NOT_ACCEPTED',
              },
            ]
          : [],
      });
    },
  };
}

const SEAT_MAP: SeatMap = {
  segments: [
    {
      segmentRef: 0,
      legIndex: 0,
      changeOfGauge: false,
      displayOnly: false,
      cabins: [
        {
          columns: ['A', 'B', 'C'],
          aisleAfter: [],
          rows: [
            {
              number: 12,
              seats: [
                {
                  column: 'A',
                  available: true,
                  characteristics: ['WINDOW'],
                  adultOnly: false,
                  infantAllowed: true,
                  offers: [
                    {
                      passengerIndex: 0,
                      price: { amountMinor: 2_500, currency: 'USD' },
                      offerRef: 's-12a',
                    },
                  ],
                },
                {
                  column: 'C',
                  available: true,
                  characteristics: ['AISLE'],
                  adultOnly: false,
                  infantAllowed: true,
                  offers: [
                    {
                      passengerIndex: 0,
                      price: { amountMinor: 0, currency: 'USD' },
                      offerRef: 's-12c',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  warnings: [],
};

const CATALOG = {
  segments: [{}],
  offers: [
    {
      serviceOfferItemId: 'meal-1',
      category: 'MEAL',
      name: 'Comida',
      serviceCode: '0B3',
      airlineCode: 'LA',
      segmentRefs: [0],
      passengers: [
        {
          passengerIndex: 0,
          charge: { type: 'PRICED', price: { amountMinor: 900, currency: 'USD' } },
        },
      ],
      quantity: 1,
      weights: [],
      sellable: true,
    },
    {
      serviceOfferItemId: 'bag-1',
      category: 'BAGGAGE',
      name: 'Maleta',
      serviceCode: '0C3',
      airlineCode: 'LA',
      segmentRefs: [0],
      passengers: [
        {
          passengerIndex: 0,
          charge: { type: 'PRICED', price: { amountMinor: 4_500, currency: 'USD' } },
        },
      ],
      quantity: 1,
      weights: [],
      sellable: true,
    },
  ],
  warnings: [],
} as unknown as AncillaryCatalog;

const ACL: CertAclPort = {
  authenticate: () => Promise.resolve(),
  shopNdc: () =>
    Promise.resolve({ offers: [offer('ATPCO', 1)], warnings: { 'ndc-content-skipped': 12 } }),
  refund: () =>
    Promise.resolve({
      outcome: 'CANCELLED',
      result: { success: true, warnings: [] },
      refundedDocuments: 1,
    }),
};

function plan(input: Partial<CertPlanInput>): CertPlan {
  return buildCertPlan({
    scenarios: ['auth'],
    allowMoney: false,
    routes: ['BOG-LIM'],
    pax: '1ADT',
    days: 30,
    ...input,
  });
}

function harness(options: FakeOptions = {}, overrides: Partial<CertRunnerDeps> = {}) {
  const events: string[] = [];
  const announced: string[] = [];
  const recorder = new CertEvidenceRecorder();
  const deps: CertRunnerDeps = {
    flights: fakeFlights(events, options),
    acl: ACL,
    recorder,
    ctx: { tenantId: TENANT },
    formOfPayment: 'CASH',
    announce: (line) => {
      announced.push(line);
      if (line.includes('[DINERO]')) events.push('ANUNCIO');
    },
    today: '2026-10-14',
    ...overrides,
  };
  return { events, announced, recorder, deps };
}

describe('runCertPlan — reservar y cancelar (SAB-12)', () => {
  it('busca, revalida la ATPCO más barata, reserva, lee, cancela y relee', async () => {
    const { events, deps, recorder } = harness();
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);

    expect(events).toEqual([
      'search',
      'price ref-7000',
      'create 1pax',
      'read PNR001',
      'cancel PNR001 ALL',
      'read PNR001',
    ]);
    expect(report.scenarios[0]).toMatchObject({ outcome: 'ok', pnr: 'PNR001' });
    expect(report.pnrs).toEqual([{ pnr: 'PNR001', scenario: 'book-cancel', state: 'cancelled' }]);
    expect(report.leftovers).toEqual([]);
    expect(recorder.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('si el escenario se cae a mitad, el PNR igual se cancela en finally', async () => {
    const { events, deps } = harness({ failRetrieveAfterCreate: true });
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);

    expect(report.scenarios[0]?.outcome).toBe('failed');
    expect(events.slice(-1)).toEqual(['cancel PNR001 ALL']);
    expect(report.pnrs[0]?.state).toBe('cancelled');
    expect(report.leftovers).toEqual([]);
  });

  it('lo que no se pudo limpiar queda reportado con el motivo', async () => {
    const { deps } = harness({ failRetrieveAfterCreate: true, cancelUnverified: true });
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);

    expect(report.leftovers).toEqual([
      {
        scenario: 'book-cancel',
        pnr: 'PNR001',
        state: 'booked',
        reason:
          'la cancelación quedó sin verificar (UNVERIFIED): releer el PNR antes de reintentar',
      },
    ]);
  });

  it('una creación en duda queda como posible PNR huérfano; una rechazada antes de salir, no', async () => {
    const enDuda = harness({ createThrows: new Error('timeout') });
    const r1 = await runCertPlan(plan({ scenarios: ['book-cancel'] }), enDuda.deps);
    expect(r1.leftovers).toHaveLength(1);
    expect(r1.leftovers[0]?.reason).toMatch(/Conversation-ID/);

    const noSalio = harness({ createThrows: new OrderCreateNotSentError('nombre inválido') });
    const r2 = await runCertPlan(plan({ scenarios: ['book-cancel'] }), noSalio.deps);
    expect(r2.scenarios[0]?.outcome).toBe('failed');
    expect(r2.leftovers).toEqual([]);
  });

  it('un rechazo de validación de Sabre es un fallo cierto, no un PNR en duda (H-02)', async () => {
    const { deps } = harness({ createThrows: validationRejection('MANDATORY_DATA_MISSING') });
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);
    expect(report.scenarios[0]?.outcome).toBe('failed');
    expect(report.leftovers).toEqual([]);
  });

  it('sin oferta ATPCO en la ruta no reserva nada', async () => {
    const { events, deps } = harness({ offers: [offer('NDC', 1)] });
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);
    expect(report.scenarios[0]?.error).toMatchObject({ name: 'CertScenarioError' });
    expect(events).toEqual(['search']);
  });
});

function validationRejection(
  type: string,
  overrides: { path?: string; category?: string; fieldPath?: string } = {},
): SabreApiError {
  return new SabreApiError(200, '{}', overrides.path ?? '/v1/trip/orders/createBooking', {
    conversationId: 'conv-h01',
    issues: [
      {
        source: 'application',
        severity: 'error',
        category: overrides.category ?? 'BAD_REQUEST',
        type,
        fieldPath: overrides.fieldPath ?? 'CreateBookingRequest.travelers[0]',
      },
    ],
  });
}

describe('certainCreateRejection — cuándo un createBooking rechazado no dejó nada', () => {
  it('validación del request: sí', () => {
    expect(certainCreateRejection(validationRejection('MANDATORY_DATA_MISSING'))).toBe(
      'MANDATORY_DATA_MISSING',
    );
    expect(certainCreateRejection(validationRejection('INVALID_TRAVELER_ID'))).toBe(
      'INVALID_TRAVELER_ID',
    );
  });

  it('cualquier otra cosa: no se puede afirmar', () => {
    expect(certainCreateRejection(new Error('timeout'))).toBeUndefined();
    expect(certainCreateRejection(validationRejection('SEGMENT_NOT_SOLD'))).toBeUndefined();
    expect(
      certainCreateRejection(
        validationRejection('MANDATORY_DATA_MISSING', { category: 'INTERNAL' }),
      ),
    ).toBeUndefined();
    expect(
      certainCreateRejection(
        validationRejection('MANDATORY_DATA_MISSING', { fieldPath: 'flights[0].airline' }),
      ),
    ).toBeUndefined();
    expect(
      certainCreateRejection(
        validationRejection('MANDATORY_DATA_MISSING', { path: '/v1/trip/orders/modifyBooking' }),
      ),
    ).toBeUndefined();
    expect(
      certainCreateRejection(
        new SabreApiError(200, '{}', '/v1/trip/orders/createBooking', { issues: [] }),
      ),
    ).toBeUndefined();
  });
});

describe('runCertPlan — lo que mueve dinero (SAB-13, SAB-21, SAB-24)', () => {
  it('emitir y anular se ANUNCIAN antes de llamar, con el PNR y la forma de pago', async () => {
    const { events, announced, deps } = harness();
    const report = await runCertPlan(
      plan({ scenarios: ['book-issue-void'], allowMoney: true }),
      deps,
    );

    expect(events).toEqual([
      'search',
      'price ref-7000',
      'create 1pax',
      'read PNR001',
      'ANUNCIO',
      'issue PNR001 x1',
      'read PNR001',
      'check PNR001',
      'ANUNCIO',
      'cancel PNR001 VOID',
      'read PNR001',
    ]);
    expect(announced.filter((l) => l.includes('[DINERO]'))).toEqual([
      '   [DINERO] Emitir los tiquetes del PNR PNR001 (1 pasajeros) con forma de pago CASH, en CERT.',
      '   [DINERO] Anular (VOID) los tiquetes del PNR PNR001 y cancelar la reserva, en CERT.',
    ]);
    expect(report.pnrs[0]?.state).toBe('voided');
    expect(report.leftovers).toEqual([]);
  });

  it('emitido y con el VOID caído, la limpieza vuelve a anular', async () => {
    const { events, deps } = harness({ voidThrows: new Error('caída') });
    const report = await runCertPlan(
      plan({ scenarios: ['book-issue-void'], allowMoney: true }),
      deps,
    );
    expect(events.filter((e) => e.startsWith('cancel'))).toEqual([
      'cancel PNR001 VOID',
      'cancel PNR001 VOID',
    ]);
    expect(report.leftovers[0]?.reason).toMatch(/la limpieza falló \(Error\)/);
  });

  it('tiquetes que ya no se anulan: la limpieza prueba cancelar y, si el ACL se niega, lo reporta', async () => {
    const { events, deps } = harness({
      voidThrows: new TicketVoidNotAvailableError(),
      cancelThrows: new SabreCancelBookingBuildError('TICKET_OPERATION_REQUIRED', 'emitida'),
    });
    const report = await runCertPlan(
      plan({ scenarios: ['book-issue-void'], allowMoney: true }),
      deps,
    );
    expect(events.filter((e) => e.startsWith('cancel'))).toEqual([
      'cancel PNR001 VOID',
      'cancel PNR001 VOID',
      'cancel PNR001 ALL',
    ]);
    expect(report.leftovers[0]?.reason).toMatch(/reembolso manual/);
  });

  it('una emisión que LANZA no emitió nada: la limpieza cancela a secas, sin anunciar dinero', async () => {
    const { events, deps } = harness({ issueThrows: new Error('no salió') });
    const report = await runCertPlan(
      plan({ scenarios: ['book-issue-void'], allowMoney: true }),
      deps,
    );
    expect(events.slice(-1)).toEqual(['cancel PNR001 ALL']);
    expect(events.filter((e) => e === 'ANUNCIO')).toHaveLength(1);
    expect(report.pnrs[0]?.state).toBe('cancelled');
  });

  it('una emisión en duda se limpia anulando', async () => {
    const { events, deps } = harness({ issueOutcome: 'UNVERIFIED', voidThrows: new Error('x') });
    await runCertPlan(plan({ scenarios: ['book-issue-void'], allowMoney: true }), deps);
    expect(events.filter((e) => e.startsWith('cancel'))).toEqual([
      'cancel PNR001 VOID',
      'cancel PNR001 VOID',
    ]);
  });

  it('servicios: agrega la maleta con precio y la cobra como EMD en la emisión', async () => {
    const { events, announced, deps } = harness();
    const report = await runCertPlan(plan({ scenarios: ['ancillaries'], allowMoney: true }), deps);
    expect(events).toContain('ancillaries PNR001 ATPCO');
    expect(events).toContain('add PNR001 bag-1');
    expect(events).toContain('issue PNR001 x1 emd 4500');
    expect(announced.some((l) => l.includes('0C3') && l.includes('USD 45.00'))).toBe(true);
    expect(report.pnrs[0]?.state).toBe('voided');
  });

  it('reembolso: anuncia el estimado de checkFlightTickets antes de llamar', async () => {
    const { announced, deps } = harness();
    const report = await runCertPlan(
      plan({ scenarios: ['book-issue-refund'], allowMoney: true }),
      deps,
    );
    expect(announced.find((l) => l.includes('[DINERO]') && l.includes('REFUND'))).toContain(
      'estimado: USD 70.00 (penalidad USD 10.00)',
    );
    expect(report.pnrs[0]?.state).toBe('refunded');
  });
});

describe('runCertPlan — datos de los pasajeros (SAB-25)', () => {
  it('reserva, lee, corrige pasaporte con WCHR y viajero frecuente en dos pedidos, relee y cancela', async () => {
    const { events, announced, deps, recorder } = harness();
    const report = await runCertPlan(plan({ scenarios: ['book-modify'] }), deps);

    expect(events).toEqual([
      'search',
      'price ref-7000',
      'create 1pax',
      'read PNR001',
      'travelers PNR001',
      'modify PNR001 ATPCO TEST identityDocuments',
      'modify PNR001 ATPCO TEST loyalty LA',
      'travelers PNR001',
      'cancel PNR001 ALL',
      'read PNR001',
    ]);
    // Cambia la reserva sin cobrar: no hay anuncio de dinero ni hace falta --allow-money.
    expect(announced.some((l) => l.includes('[DINERO]'))).toBe(false);
    expect(report.scenarios[0]).toMatchObject({ outcome: 'ok', notes: [] });
    expect(report.pnrs[0]?.state).toBe('cancelled');
    // La evidencia lleva campos y desenlaces, nunca el número de prueba entero.
    const evidencia = JSON.stringify(recorder.steps);
    expect(evidencia).not.toContain('TEST000999');
    expect(evidencia).not.toContain('TEST0099887');
    expect(evidencia).toContain('identityDocuments');
  });

  it('un viajero frecuente rechazado queda en las notas con su tipo, y la reserva igual se cancela', async () => {
    const { deps } = harness({ loyaltyOutcome: 'FAILED' });
    const report = await runCertPlan(plan({ scenarios: ['book-modify'] }), deps);
    expect(report.scenarios[0]?.notes).toEqual([
      'el viajero frecuente de LA terminó en FAILED (UNABLE_TO_UPDATE_RESERVATION_LOYALTY_NOT_ACCEPTED)',
    ]);
    expect(report.pnrs[0]?.state).toBe('cancelled');
  });
});

describe('runCertPlan — asientos, NDC y topes', () => {
  it('reserva con el primer asiento SIN cargo del pasajero', async () => {
    const { events, deps } = harness();
    const report = await runCertPlan(plan({ scenarios: ['book-with-seat'] }), deps);
    expect(events).toContain('create 1pax seat');
    expect(report.scenarios[0]?.notes).toContain('asiento pedido: 12C en el tramo 1');
  });

  it('el conteo de NDC descartado por el mapper queda en las notas', async () => {
    const { deps } = harness();
    const report = await runCertPlan(plan({ scenarios: ['shop-ndc'] }), deps);
    expect(report.scenarios[0]?.notes[0]).toMatch(/12 ofertas NDC/);
  });

  it('el tope de PNR también vive en el runner, no sólo en el plan', async () => {
    const base = plan({ scenarios: ['book-cancel'] });
    const forzado: CertPlan = {
      ...base,
      scenarios: Array.from({ length: 4 }, () => CERT_SCENARIOS['book-cancel']),
    };
    const { deps } = harness();
    const report = await runCertPlan(forzado, deps);
    expect(report.pnrs).toHaveLength(3);
    expect(report.scenarios[3]?.error).toMatchObject({ name: 'CertScenarioError' });
  });

  it('interrumpido: no abre más pasos pero limpia lo que hay', async () => {
    const abort = { requested: false };
    const { events, deps } = harness({}, { abort });
    const flights = deps.flights;
    const report = await runCertPlan(plan({ scenarios: ['book-cancel', 'shop-ndc'] }), {
      ...deps,
      flights: {
        ...flights,
        retrieveForDisplay: (pnr, ctx) => {
          abort.requested = true;
          return flights.retrieveForDisplay(pnr, ctx);
        },
      },
    });
    expect(report.scenarios.map((s) => s.outcome)).toEqual(['aborted', 'aborted']);
    expect(events.slice(-1)).toEqual(['cancel PNR001 ALL']);
    expect(report.pnrs[0]?.state).toBe('cancelled');
  });

  it('cada paso cerrado se entrega para escribir su archivo', async () => {
    const written: string[] = [];
    const { deps } = harness(
      {},
      {
        onStepEnd: (record) => {
          written.push(`${record.scenario}:${record.step}:${record.outcome}`);
          return Promise.resolve();
        },
      },
    );
    await runCertPlan(plan({ scenarios: ['auth'] }), deps);
    expect(written).toEqual(['auth:token:ok']);
  });
});

describe('runCertPlan — la evidencia que no se escribe no se lleva el reporte', () => {
  it('con el disco fallando en plena limpieza, el PNR colgado sigue en leftovers', async () => {
    const { deps, announced } = harness(
      { failRetrieveAfterCreate: true, cancelThrows: new Error('cancel caído') },
      {
        onStepEnd: (record) =>
          record.step.startsWith('limpieza')
            ? Promise.reject(new Error('ENOSPC'))
            : Promise.resolve(),
      },
    );
    const report = await runCertPlan(plan({ scenarios: ['book-cancel'] }), deps);

    expect(report.pnrs).toEqual([{ pnr: 'PNR001', scenario: 'book-cancel', state: 'booked' }]);
    expect(report.leftovers.map((l) => l.pnr)).toEqual(['PNR001']);
    expect(announced.join('\n')).toContain('no se pudo escribir la evidencia de limpieza');
  });
});

describe('las elecciones del runner', () => {
  it('freeSeatFor no elige un asiento con cargo ni uno de otro pasajero', () => {
    expect(freeSeatFor(SEAT_MAP, 0)).toMatchObject({ row: 12, column: 'C', offerRef: 's-12c' });
    expect(freeSeatFor(SEAT_MAP, 1)).toBeUndefined();
  });

  it('pricedBagFor sólo elige maletas vendibles con precio', () => {
    expect(pricedBagFor(CATALOG, 0)).toMatchObject({
      serviceOfferItemId: 'bag-1',
      serviceCode: '0C3',
    });
    expect(pricedBagFor(CATALOG, 1)).toBeUndefined();
  });
});

describe('describeCertError — qué queda de un error en la evidencia', () => {
  it('de la guarda, los motivos enteros', () => {
    expect(describeCertError(new SabreCertGuardError(['el host REST no es el de CERT']))).toEqual({
      name: 'SabreCertGuardError',
      reasons: ['el host REST no es el de CERT'],
    });
  });

  it('del ACL, el mensaje humanizado y los códigos, nunca el texto del proveedor', () => {
    const error = new SabreApiError(
      400,
      'PASAJERO UNO rejected by airline',
      '/v1/trip/orders/createBooking',
      {
        conversationId: 'conv-3',
      },
    );
    const descrito = describeCertError(error);
    expect(descrito).toMatchObject({
      name: 'SabreApiError',
      status: 400,
      conversationId: 'conv-3',
    });
    expect(JSON.stringify(descrito)).not.toContain('PASAJERO');
  });

  it('de los demás, el mensaje redactado', () => {
    expect(describeCertError(new Error('password=Pa55w0rd!'))['message']).not.toContain(
      'Pa55w0rd!',
    );
  });
});
