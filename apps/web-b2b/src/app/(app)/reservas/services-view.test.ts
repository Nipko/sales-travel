import { describe, expect, it } from 'vitest';
import { operationStatusView, operationTypeLabel } from './order-operations-view';
import {
  SERVICES_UI,
  addServicesBody,
  canManageServices,
  parseServicesCatalog,
  passengerLabel,
  removalSet,
  removeServicesBody,
  selectionKey,
  selectionTotal,
  servicesByPassenger,
  servicesChangeReplyOf,
} from './services-view';

/*
 * Maletas y servicios antes de emitir (SAB-20), sin React: cuándo se ofrecen, cómo se lee el
 * catálogo del API, cuánto suma lo elegido y qué se manda.
 */

const LINE = '44444444-4444-4444-8444-444444444444';
const LINE2 = '55555555-5555-4555-8555-555555555555';

function api(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ancillaries',
    currency: 'USD',
    orderTotalMinor: 100000,
    testContent: false,
    segments: [
      {
        index: 0,
        origin: 'BOG',
        destination: 'LIM',
        carrier: 'AV',
        flightNumber: '123',
        departureAt: '2099-09-10T09:00',
      },
      {
        index: 1,
        origin: 'LIM',
        destination: 'BOG',
        carrier: 'AV',
        flightNumber: '124',
        departureAt: '2099-09-17T09:00',
      },
    ],
    offers: [
      {
        serviceOfferItemId: 'BAG-1',
        category: 'BAGGAGE',
        name: 'Maleta 23 kg',
        segmentRefs: [0, 1],
        weights: [{ value: 23, unit: 'KG' }],
        passengers: [
          { passengerIndex: 0, amountMinor: 4500, included: false },
          { passengerIndex: 1, amountMinor: 3000, included: false },
        ],
        addable: true,
        notAddableText: null,
      },
      {
        serviceOfferItemId: 'MEAL-1',
        category: 'MEAL',
        name: 'Comida',
        segmentRefs: [0],
        weights: [],
        passengers: [{ passengerIndex: 0, amountMinor: null, included: false }],
        addable: false,
        notAddableText: 'La aerolínea no informó el precio: no se puede cobrar a ciegas.',
      },
    ],
    added: [
      {
        id: LINE,
        passengerIndex: 1,
        name: 'Maleta 23 kg',
        category: 'BAGGAGE',
        segments: [{ origin: 'BOG', destination: 'LIM' }],
        amountMinor: 3000,
        currency: 'USD',
        status: 'active',
        removable: true,
        removalGroup: 'op:9',
      },
      {
        id: LINE2,
        passengerIndex: 0,
        name: 'Maleta 23 kg',
        category: 'BAGGAGE',
        segments: [],
        amountMinor: 4500,
        currency: 'USD',
        status: 'active',
        removable: true,
        removalGroup: 'op:9',
      },
    ],
    warnings: [],
    blocked: null,
    ...extra,
  };
}

describe('cuándo se ofrece', () => {
  const caps = {
    retrieve: true,
    cancel: true,
    pay: false,
    services: true,
    reshop: false,
    addServices: true,
  };

  it('confirmada, con localizador y con la capacidad', () => {
    expect(canManageServices({ status: 'confirmed', pnr: 'ABC123', capabilities: caps })).toBe(
      true,
    );
  });

  it.each([
    ['emitida', { status: 'ticketed', pnr: 'ABC123', capabilities: caps }],
    ['sin localizador', { status: 'confirmed', pnr: null, capabilities: caps }],
    [
      'sin la capacidad',
      { status: 'confirmed', pnr: 'ABC123', capabilities: { ...caps, addServices: false } },
    ],
    ['sin capacidades (API viejo)', { status: 'confirmed', pnr: 'ABC123' }],
  ])('no, si está %s', (_caso, order) => {
    expect(canManageServices(order)).toBe(false);
  });
});

describe('parseServicesCatalog', () => {
  it('lee el catálogo, sus tramos y lo agregado', () => {
    const view = parseServicesCatalog(api());
    expect(view).toMatchObject({ currency: 'USD', orderTotalMinor: 100000, blocked: null });
    expect(view?.offers).toHaveLength(2);
    expect(view?.offers[1]).toMatchObject({ addable: false, passengers: [{ amountMinor: null }] });
    expect(view?.added.map((l) => l.id)).toEqual([LINE, LINE2]);
  });

  it('un listado de equipaje de otro proveedor no es este catálogo', () => {
    expect(parseServicesCatalog({ services: [], warnings: [] })).toBeNull();
    expect(parseServicesCatalog(null)).toBeNull();
  });

  it('una oferta sin id se descarta; nada lanza', () => {
    const view = parseServicesCatalog(api({ offers: [{ name: 'sin id' }, 'basura'] }));
    expect(view?.offers).toEqual([]);
  });
});

describe('por pasajero y por tramo', () => {
  it('cada pasajero ve lo suyo, agrupado por los tramos que cubre', () => {
    const catalog = parseServicesCatalog(api())!;
    const [adulto, nino] = servicesByPassenger(catalog, 2);
    expect(adulto?.groups.map((g) => g.label)).toEqual(['BOG → LIM, LIM → BOG', 'BOG → LIM']);
    expect(adulto?.added.map((l) => l.id)).toEqual([LINE2]);
    expect(nino?.groups.map((g) => g.offers.map((o) => o.amountMinor))).toEqual([[3000]]);
  });

  it('el nombre del pasajero con su posición y tipo', () => {
    expect(passengerLabel(0, { givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' })).toBe(
      'Pasajero 1 · Ana Pérez (adulto)',
    );
    expect(passengerLabel(1, undefined)).toBe('Pasajero 2');
  });
});

describe('lo que se manda', () => {
  it('suma con el precio del catálogo y manda qué y para quién, nunca el precio por línea', () => {
    const catalog = parseServicesCatalog(api())!;
    const selected = new Set([selectionKey('BAG-1', 0), selectionKey('BAG-1', 1)]);
    expect(selectionTotal(catalog, selected)).toBe(7500);
    expect(addServicesBody(catalog, selected)).toEqual({
      selections: [{ serviceOfferItemId: 'BAG-1', passengerIndexes: [0, 1] }],
      expectedTotalMinor: 7500,
      currency: 'USD',
    });
  });

  it('quitar una línea de un grupo quita el grupo entero, y lo dice', () => {
    const catalog = parseServicesCatalog(api())!;
    const lines = removalSet(catalog, LINE);
    expect(lines.map((l) => l.id)).toEqual([LINE, LINE2]);
    expect(removeServicesBody(catalog, lines)).toEqual({
      lineIds: [LINE, LINE2],
      expectedTotalMinor: 7500,
      currency: 'USD',
    });
  });
});

describe('la respuesta', () => {
  it('agregado o quitado es un éxito; parcial o en duda, un aviso con el texto del API', () => {
    expect(
      servicesChangeReplyOf(200, { outcome: 'ADDED', message: 'Servicios agregados.' }),
    ).toEqual({
      ok: true,
      done: true,
      message: 'Servicios agregados.',
    });
    expect(servicesChangeReplyOf(200, { outcome: 'PARTIAL', message: 'revisa' })).toEqual({
      ok: true,
      done: false,
      message: 'revisa',
    });
  });

  it('un rechazo trae su motivo; sin motivo, el genérico', () => {
    expect(servicesChangeReplyOf(409, { message: 'El precio cambió.', error: 'Conflict' })).toEqual(
      {
        ok: false,
        message: 'El precio cambió.',
      },
    );
    expect(servicesChangeReplyOf(500, null)).toEqual({
      ok: false,
      message: SERVICES_UI.sendFailed,
    });
  });
});

describe('el historial', () => {
  it('nombra los cambios de servicios y uno en duda no «falló»', () => {
    expect(operationTypeLabel('add-services')).toBe('Servicios adicionales');
    expect(operationTypeLabel('remove-services')).toBe('Quitar servicios adicionales');
    expect(
      operationStatusView({ type: 'add-services', status: 'failed', reconciliationRequired: true }),
    ).toEqual({ tone: 'pending', label: 'Sin confirmar' });
    expect(operationStatusView({ type: 'add-services', status: 'success' })).toEqual({
      tone: 'ok',
      label: 'Hecho',
    });
  });
});
