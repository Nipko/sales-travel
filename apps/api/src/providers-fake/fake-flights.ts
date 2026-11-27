import { NotFoundException } from '@nestjs/common';
import type { Itinerary, Offer, Segment } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  OfferPriceResult,
  OrderCancelResult,
  OrderCreateRequest,
  OrderCreateResult,
  OrderPayRequest,
  OrderPayResult,
  OrderReshopRequest,
  OrderReshopResult,
  OrderView,
  SearchContext,
  ServiceListRequest,
  ServiceListResult,
} from '@sales-travel/domain';
import { createHash, randomUUID } from 'node:crypto';
import type {
  FlightProviderAdapter,
  ProviderCapabilities,
  TenantAdapter,
  TenantProviderFactory,
} from '../providers/provider.types.js';

/**
 * INF-4 (docs/qa/01 §7): un proveedor de vuelos FALSO para el stack E2E, que no tiene sandboxes.
 * Deja probar de punta a punta la búsqueda, el checkout y los desenlaces difíciles de una reserva
 * sin depender de un proveedor real.
 *
 * Sólo existe con `FAKE_PROVIDERS=1` y `APP_VERSION=e2e` (el stack de apps/web-b2b/e2e). Con la
 * variable y cualquier otra versión, el arranque falla: nunca puede quedar encendido en producción.
 * Sus ofertas salen con `environment: test`, como las de cualquier cuenta de pruebas.
 *
 * Perillas, sobre datos reales para que el autocompletado y los formularios los acepten:
 *
 * - búsqueda hacia SMR → sin disponibilidad; hacia ADZ → el proveedor se cae;
 * - cualquier otra ruta → dos ofertas; la segunda cambia de precio (+5 %) al revalidar;
 * - reserva según el apellido del primer pasajero: RECHAZO → rechazo cierto (FAILED, sin PNR),
 *   PARCIAL → PARTIAL con un ítem caído, INCIERTO → el proveedor no contesta (desenlace incierto);
 *   cualquier otro → confirmada.
 */
export const FAKE_FLIGHTS_CODE = 'fake-flights';

export const FAKE_KNOBS = {
  noAvailabilityTo: 'SMR',
  outageTo: 'ADZ',
  rejectSurname: 'RECHAZO',
  partialSurname: 'PARCIAL',
  uncertainSurname: 'INCIERTO',
} as const;

/** ¿El proveedor falso se registra? Lanza si lo piden fuera del stack E2E. */
export function fakeProvidersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['FAKE_PROVIDERS'] !== '1') return false;
  if (env['APP_VERSION'] !== 'e2e') {
    throw new Error(
      'FAKE_PROVIDERS=1 sólo vale en el stack E2E (APP_VERSION=e2e): un proveedor falso nunca puede quedar encendido en otro ambiente.',
    );
  }
  return true;
}

const CAPABILITIES: ProviderCapabilities = {
  retrieve: true,
  cancel: true,
  pay: false,
  services: false,
  reshop: false,
};

const HOUR = 60 * 60 * 1000;

/** Una hora de salida estable por ruta y día: dos búsquedas iguales ven los mismos vuelos. */
function seed(...parts: string[]): number {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

function segment(
  origin: string,
  destination: string,
  date: string,
  flightNumber: string,
  departHourUtc: number,
  minutes: number,
): Segment {
  const departure = new Date(`${date}T00:00:00.000Z`).getTime() + departHourUtc * HOUR;
  return {
    carrier: 'XQ',
    flightNumber,
    origin,
    destination,
    departureAt: new Date(departure).toISOString(),
    arrivalAt: new Date(departure + minutes * 60_000).toISOString(),
    durationMinutes: minutes,
    cabin: 'economy',
    bookingClass: 'Y',
  };
}

function itinerary(segments: Segment[]): Itinerary {
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  return {
    segments,
    totalDurationMinutes: Math.round(
      (Date.parse(last.arrivalAt) - Date.parse(first.departureAt)) / 60_000,
    ),
    stops: segments.length - 1,
  };
}

function legs(
  criteria: FlightSearchCriteria,
): { origin: string; destination: string; date: string }[] {
  if (criteria.legs !== undefined) {
    return criteria.legs.map((l) => ({
      origin: l.origin,
      destination: l.destination,
      date: l.departureDate,
    }));
  }
  const out = [
    { origin: criteria.origin, destination: criteria.destination, date: criteria.departureDate },
  ];
  if (criteria.returnDate !== undefined) {
    out.push({
      origin: criteria.destination,
      destination: criteria.origin,
      date: criteria.returnDate,
    });
  }
  return out;
}

function paxTotal(criteria: FlightSearchCriteria): number {
  const p = criteria.paxCount;
  return p.adults + p.children + p.infants;
}

export class FakeFlightsAdapter implements FlightProviderAdapter {
  /** Lo que se reservó en este proceso: la relectura y la cancelación lo consultan. */
  private readonly orders = new Map<string, { status: string; pnr: string }>();
  /**
   * Las ofertas que se dieron, por referencia: la revalidación sale de acá y no de lo que manda el
   * cliente, como en un proveedor real (CHK-06: un total tocado en el navegador no pasa).
   */
  private readonly given = new Map<string, Offer>();

  search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    const route = legs(criteria);
    const last = route[route.length - 1]!;
    if (
      route.some((l) => l.destination === FAKE_KNOBS.outageTo) ||
      last.destination === FAKE_KNOBS.outageTo
    ) {
      return Promise.reject(new Error('fake-flights: el proveedor no responde (perilla ADZ)'));
    }
    if (route.some((l) => l.destination === FAKE_KNOBS.noAvailabilityTo)) {
      return Promise.resolve([]);
    }
    const currency = criteria.currency ?? 'USD';
    const pax = paxTotal(criteria);
    const now = Date.now();
    const offer = (kind: 'directo' | 'escala', perPaxMinor: number): Offer => {
      const itineraries = route.map((l, i) => {
        const hour = 6 + (seed(l.origin, l.destination, l.date, kind) % 12);
        const n = String(100 + (seed(l.origin, l.destination, kind, String(i)) % 800));
        return kind === 'directo'
          ? itinerary([segment(l.origin, l.destination, l.date, n, hour, 75)])
          : itinerary([
              segment(l.origin, 'BOG' === l.origin ? 'PTY' : 'BOG', l.date, n, hour, 70),
              segment(
                'BOG' === l.origin ? 'PTY' : 'BOG',
                l.destination,
                l.date,
                String(Number(n) + 1),
                hour + 2,
                80,
              ),
            ]);
      });
      const total = perPaxMinor * pax;
      const taxes = Math.round(total * 0.2);
      return {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        products: ['flight'],
        provider: {
          name: FAKE_FLIGHTS_CODE,
          offerRef: `FAKE-${kind === 'directo' ? 'FIJO' : 'CAMBIA'}-${randomUUID().slice(0, 8)}`,
          environment: 'test',
        },
        total: { amountMinor: total, currency },
        baseFare: { amountMinor: total - taxes, currency },
        taxes: { amountMinor: taxes, currency },
        itineraries,
        fetchedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + HOUR).toISOString(),
      };
    };
    const offers = [offer('directo', 25_000), offer('escala', 19_000)];
    for (const o of offers) this.given.set(o.provider.offerRef, o);
    return Promise.resolve(offers);
  }

  priceOffer(
    offer: Offer,
    _criteria: FlightSearchCriteria,
    _ctx: SearchContext,
  ): Promise<OfferPriceResult> {
    // Cambia una sola vez: la oferta revalidada queda marcada y la revalidación de la reserva ya
    // no la vuelve a subir (si no, «Aceptar y reservar» chocaría siempre con otro precio).
    const original = this.given.get(offer.provider.offerRef);
    if (original === undefined) {
      return Promise.reject(new Error('fake-flights: la oferta ya no existe; vuelve a buscar'));
    }
    if (!offer.provider.offerRef.startsWith('FAKE-CAMBIA-')) {
      return Promise.resolve({ offer: original, priceChanged: false, warnings: [] });
    }
    const up = (m: number) => Math.round(m * 1.05);
    const repriced: Offer = {
      ...original,
      provider: {
        ...original.provider,
        offerRef: original.provider.offerRef.replace('FAKE-CAMBIA-', 'FAKE-CAMBIADA-'),
      },
      total: { ...original.total, amountMinor: up(original.total.amountMinor) },
      baseFare: { ...original.baseFare, amountMinor: up(original.baseFare.amountMinor) },
      taxes: { ...original.taxes, amountMinor: up(original.taxes.amountMinor) },
    };
    this.given.set(repriced.provider.offerRef, repriced);
    return Promise.resolve({ offer: repriced, priceChanged: true, warnings: [] });
  }

  createOrder(request: OrderCreateRequest, _ctx: SearchContext): Promise<OrderCreateResult> {
    const surname = (request.passengers[0]?.surname ?? '').toUpperCase();
    if (surname === FAKE_KNOBS.uncertainSurname) {
      return Promise.reject(new Error('fake-flights: el proveedor no contestó (perilla INCIERTO)'));
    }
    if (surname === FAKE_KNOBS.rejectSurname) {
      return Promise.resolve({
        outcome: 'FAILED',
        items: [],
        issues: [
          {
            severity: 'ERROR',
            category: 'BAD_REQUEST',
            type: 'FAKE_REJECTED',
            message: 'La aerolínea de prueba rechazó la reserva.',
          },
        ],
      });
    }
    const pnr = `FK${randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()}`;
    // El localizador es también el id de la orden: la saga relee por el que guardó.
    const orderId = pnr;
    if (surname === FAKE_KNOBS.partialSurname) {
      this.orders.set(orderId, { status: 'PARTIAL', pnr });
      return Promise.resolve({
        outcome: 'PARTIAL',
        orderId,
        pnr,
        items: [
          // Un asiento caído la saga lo tolera (queda confirmada): el parcial de verdad es un
          // tramo sin confirmar.
          { kind: 'flight', providerItemId: '1', status: 'CONFIRMED', statusCode: 'HK' },
          { kind: 'flight', providerItemId: '2', status: 'UNCONFIRMED', statusCode: 'UC' },
        ],
        issues: [
          {
            severity: 'WARNING',
            category: 'APPLICATION_ERROR',
            type: 'FAKE_SEGMENT_UNCONFIRMED',
            message: 'Un tramo de prueba quedó sin confirmar.',
          },
        ],
        compensation: { cancellableItemIds: ['1'] },
      });
    }
    this.orders.set(orderId, { status: 'CONFIRMED', pnr });
    return Promise.resolve({
      outcome: 'CONFIRMED',
      orderId,
      pnr,
      items: [{ kind: 'flight', providerItemId: '1', status: 'CONFIRMED', statusCode: 'HK' }],
      issues: [],
      compensation: { cancellableItemIds: ['1'] },
    });
  }

  retrieveForDisplay(orderId: string, _ctx: SearchContext): Promise<OrderView> {
    const o = this.orders.get(orderId);
    return Promise.resolve(
      o === undefined
        ? { found: false, airlineLocators: [], warnings: [] }
        : { found: true, orderId, pnr: o.pnr, status: o.status, airlineLocators: [], warnings: [] },
    );
  }

  cancelOrder(orderId: string, _ctx: SearchContext): Promise<OrderCancelResult> {
    const o = this.orders.get(orderId);
    if (o === undefined)
      return Promise.resolve({ success: false, warnings: [], error: 'no existe' });
    o.status = 'CANCELLED';
    return Promise.resolve({ success: true, warnings: [] });
  }

  cancelBnplOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult> {
    return this.cancelOrder(orderId, ctx);
  }

  payOrder(_request: OrderPayRequest, _ctx: SearchContext): Promise<OrderPayResult> {
    return Promise.reject(new Error('fake-flights: no cobra órdenes'));
  }

  listServices(_request: ServiceListRequest, _ctx: SearchContext): Promise<ServiceListResult> {
    return Promise.resolve({ services: [], warnings: [] });
  }

  reshopWithTickets(_request: OrderReshopRequest, _ctx: SearchContext): Promise<OrderReshopResult> {
    return Promise.reject(new Error('fake-flights: no recotiza'));
  }
}

export class FakeFlightsFactory implements TenantProviderFactory<FlightProviderAdapter> {
  readonly code = FAKE_FLIGHTS_CODE;
  readonly vertical = 'flights' as const;
  readonly capabilities = CAPABILITIES;
  readonly defaultCallPolicy = 'always' as const;
  /** Uno para todo el proceso: la relectura de una orden tiene que encontrarla. */
  private readonly adapter = new FakeFlightsAdapter();

  async forTenant(tenantId: string): Promise<FlightProviderAdapter> {
    return (await this.resolveForTenant(tenantId)).adapter;
  }

  resolveForTenant(tenantId: string): Promise<TenantAdapter<FlightProviderAdapter>> {
    if (tenantId === '') return Promise.reject(new NotFoundException('sin tenant'));
    return Promise.resolve({
      adapter: this.adapter,
      // `own`: cada nodo tiene su «cuenta» falsa. `env` pasaría por la puerta de credenciales de
      // plataforma, que protege a los proveedores reales y no hay por qué abrir.
      credentialSource: 'own',
      providerEnvironment: 'test',
    });
  }

  humanizeError(err: unknown): string {
    return err instanceof Error ? err.message.replace(/^fake-flights: /, '') : String(err);
  }
}
