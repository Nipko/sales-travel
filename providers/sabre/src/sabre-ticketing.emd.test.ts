import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort } from '@sales-travel/core';
import type { SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import type { SabreFetch } from './auth/token.service';
import { SABRE_GET_BOOKING_PATH } from './booking/get.request.builder';
import { mapSabreGetBookingForDisplay } from './booking/get.response.mapper';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import {
  SabreTicketingAdapter,
  type SabreTicketingAdapterSettings,
} from './sabre-ticketing.adapter';
import { pendingSabreAncillaryEmds } from './ticketing/ancillary-emd';
import { SABRE_FULFILL_PATH } from './ticketing/fulfill.request.builder';

/**
 * Los servicios adicionales de la reserva salen como EMD en la misma emisión (SAB-20), por la puerta
 * pública: `SabreHttpClient` real con `fetch` interceptado. Se mide la lectura previa (pide
 * `ANCILLARIES` sólo con la opción encendida), el cuerpo de `fulfillFlightTickets` (una segunda
 * entrada con `ancillaryIds`) y que del bloque de viajeros no sale nada más que la posición.
 *
 * La forma de `travelers[].ancillaries[]` es la del contrato (`Ancillary`,
 * `booking-management-v1.yml:7287-7392`); el expediente no trae una lectura real con servicios, así
 * que el fixture es derivado del schema. Ningún test llama a Sabre.
 */

type Json = Record<string, unknown>;

const CTX: SearchContext = { tenantId: '11111111-2222-4333-8444-555555555555', requestId: 'r-emd' };
const PNR = 'QWERTY';

const cfg: SabreConfig = {
  host: SABRE_HOSTS.cert.rest,
  epr: '500001',
  homePcc: 'ZZZZ',
  password: 'Pa55w0rd!',
  conversationIdPrefix: 'sales-travel',
};

const fulfilled = (): Json =>
  JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'fulfill-atpco-cash-200.json'), 'utf8'),
  ) as Json;

/** Un servicio de la reserva tal como lo devuelve `getBooking`. */
function ancillary(
  itemId: string,
  options: {
    readonly status?: string;
    readonly total?: string;
    readonly emd?: string;
  } = {},
): Json {
  return {
    itemId,
    commercialName: 'UPTO33LB 15KG BAGGAGE',
    numberOfItems: 1,
    subcode: '0C3',
    airlineCode: 'AV',
    statusCode: 'HD',
    statusName: options.status ?? 'Confirmed with pending payment',
    ...(options.emd === undefined ? {} : { electronicMiscellaneousDocumentNumber: options.emd }),
    ...(options.total === undefined
      ? {}
      : {
          totals: {
            subtotal: options.total,
            taxes: '0.00',
            total: options.total,
            currencyCode: 'USD',
          },
        }),
  };
}

/** La reserva sin emitir, con un pasajero que trae nombre (PII) y sus servicios. */
function booking(ancillaries?: readonly Json[]): Json {
  return {
    bookingId: PNR,
    isCancelable: true,
    flights: [
      {
        itemId: '1',
        confirmationId: 'AB123',
        airlineCode: 'AV',
        sourceType: 'ATPCO',
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
      },
    ],
    travelers: [
      {
        givenName: 'JUANA',
        surname: 'PEREZSECRETA',
        birthDate: '1990-01-01',
        ...(ancillaries === undefined ? {} : { ancillaries }),
      },
    ],
  };
}

function wire(getBooking: Json, settings: SabreTicketingAdapterSettings = {}) {
  const calls: { path: string; raw: string }[] = [];
  const logs: { message: string; meta: unknown }[] = [];
  const queues = new Map<string, Json[]>([
    [SABRE_GET_BOOKING_PATH, [getBooking]],
    [SABRE_FULFILL_PATH, [fulfilled()]],
  ]);
  const fetchImpl: SabreFetch = (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, raw: typeof init.body === 'string' ? init.body : '' });
    const next = queues.get(path)?.shift();
    if (next === undefined) throw new Error(`llamada no preparada a ${path}`);
    return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
  };
  const logger: LoggerPort = {
    debug: (message, meta) => logs.push({ message, meta }),
    info: (message, meta) => logs.push({ message, meta }),
    warn: (message, meta) => logs.push({ message, meta }),
    error: (message, meta) => logs.push({ message, meta }),
    child: () => logger,
  };
  const http = new SabreHttpClient(
    cfg,
    { getToken: () => Promise.resolve('ATK'), invalidate: () => Promise.resolve() },
    { fetch: fetchImpl, logger, sleep: () => Promise.resolve(), jitter: () => 0, uuid: () => 'c' },
  );
  const adapter = new SabreTicketingAdapter(cfg, http, { logger }, settings);
  const bodyAt = (path: string): Json => {
    const call = calls.find((c) => c.path === path);
    if (call === undefined) throw new Error(`no hubo POST a ${path}`);
    return JSON.parse(call.raw) as Json;
  };
  return { adapter, calls, logs, bodyAt };
}

describe('la emisión cobra como EMD los servicios confirmados y sin cobrar (SAB-20)', () => {
  it('con la opción: pide ANCILLARIES, y el EMD va en una segunda entrada con la misma forma de pago', async () => {
    const h = wire(
      booking([
        ancillary('7', { total: '45.00' }),
        ancillary('8', {
          total: '45.00',
          emd: '0457766554433',
          status: 'Confirmed with EMD issued',
        }),
        ancillary('9', { total: '0.00', status: 'Confirmed' }),
        ancillary('10', { total: '30.00', status: 'Pending' }),
        ancillary('11', { status: 'Confirmed' }),
        ancillary('12', { total: '20.00', status: 'Confirmed' }),
      ]),
      { issueAncillaryEmds: true },
    );

    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });

    expect(h.bodyAt(SABRE_GET_BOOKING_PATH)['returnOnly']).toContain('ANCILLARIES');
    // Sin TRAVELERS: los nombres no se piden.
    expect(h.bodyAt(SABRE_GET_BOOKING_PATH)['returnOnly']).not.toContain('TRAVELERS');
    expect(h.bodyAt(SABRE_FULFILL_PATH)['fulfillments']).toEqual([
      { payment: { primaryFormOfPayment: 1 } },
      { ancillaryIds: ['12', '7'], payment: { primaryFormOfPayment: 1 } },
    ]);
    const line = h.logs.find((l) => l.message === 'sabre.fulfillFlightTickets');
    expect(line?.meta).toMatchObject({
      ancillaries: 2,
      ancillariesSkipped: {
        'emd-issued': 1,
        included: 1,
        'not-confirmed': 1,
        'price-unreadable': 1,
      },
    });
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain('PEREZSECRETA');
    expect(logged).not.toContain('0457766554433');
  });

  it('sin la opción: la lectura no pide servicios y la emisión es sólo de tiquetes', async () => {
    const h = wire(booking([ancillary('7', { total: '45.00' })]));

    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });

    expect(h.bodyAt(SABRE_GET_BOOKING_PATH)['returnOnly']).not.toContain('ANCILLARIES');
    expect(h.bodyAt(SABRE_FULFILL_PATH)['fulfillments']).toEqual([
      { payment: { primaryFormOfPayment: 1 } },
    ]);
  });

  it('con la opción y nada que cobrar: una sola entrada, como siempre', async () => {
    const h = wire(booking([ancillary('9', { total: '0.00', status: 'Confirmed' })]), {
      issueAncillaryEmds: true,
    });

    await h.adapter.issueTickets(PNR, CTX, { travelerCount: 1 });

    expect(h.bodyAt(SABRE_FULFILL_PATH)['fulfillments']).toEqual([
      { payment: { primaryFormOfPayment: 1 } },
    ]);
  });
});

describe('getBooking: los servicios de cada viajero, sin el viajero', () => {
  it('lee itemId, estado, si tiene EMD y su total; del viajero sólo la posición', () => {
    const snapshot = mapSabreGetBookingForDisplay(
      booking([ancillary('7', { total: '45.00' }), ancillary('8', { emd: '0457766554433' })]),
    );

    expect(snapshot.ancillaries).toEqual([
      {
        itemId: '7',
        travelerIndex: 0,
        statusName: 'Confirmed with pending payment',
        statusCode: 'HD',
        hasEmd: false,
        totals: { total: '45.00', currencyCode: 'USD' },
      },
      {
        itemId: '8',
        travelerIndex: 0,
        statusName: 'Confirmed with pending payment',
        statusCode: 'HD',
        hasEmd: true,
      },
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('PEREZSECRETA');
    expect(serialized).not.toContain('JUANA');
    expect(serialized).not.toContain('0457766554433');
  });

  it('sin la clave ancillaries no se sabe: ausente, no vacío', () => {
    expect(mapSabreGetBookingForDisplay(booking()).ancillaries).toBeUndefined();
    expect(mapSabreGetBookingForDisplay(booking([])).ancillaries).toEqual([]);
  });

  it('un servicio fuera de contrato se descarta con aviso y no tumba la lectura', () => {
    const snapshot = mapSabreGetBookingForDisplay(
      booking([
        { itemId: 'no válido', statusName: 'Confirmed' },
        ancillary('7', { total: '1.00' }),
      ]),
    );
    expect(snapshot.ancillaries?.map((a) => a.itemId)).toEqual(['7']);
    expect(snapshot.warnings).toContain('ancillary-malformed');
  });

  it('el plan de EMD no repite un itemId', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      ...booking([ancillary('7', { total: '45.00' })]),
      travelers: [
        { ancillaries: [ancillary('7', { total: '45.00' })] },
        { ancillaries: [ancillary('7', { total: '45.00' })] },
      ],
    });
    expect(pendingSabreAncillaryEmds(snapshot).itemIds).toEqual(['7']);
  });
});
