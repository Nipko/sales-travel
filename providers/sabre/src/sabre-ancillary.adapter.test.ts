import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AncillaryCatalog, AncillaryOffer } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type {
  AncillaryOrderRef,
  AncillaryPort,
  AncillarySelection,
  SearchContext,
} from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_ANCILLARIES_ADD_PATH } from './ancillaries/add.request.builder';
import { SABRE_ANCILLARIES_REMOVE_PATH } from './ancillaries/remove.request.builder';
import {
  SABRE_ANCILLARIES_SHOP_PATH,
  SabreAncillaryRequestError,
} from './ancillaries/shop.request.builder';
import {
  SabreAncillaryMappingError,
  SabreAncillaryPassengerMismatchError,
} from './ancillaries/shop.response.mapper';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError, SabreConfigError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { SabreAncillaryAdapter, SabreAncillaryLaneError } from './sabre-ancillary.adapter';

/**
 * LOS ANCILLARES POR LA PUERTA PÚBLICA.
 *
 * El adapter corre sobre un `SabreHttpClient` real con un `fetch` interceptado: por ahí pasan de
 * verdad la clasificación del sobre, la política de reintentos (`SABRE_NON_IDEMPOTENT_PATHS`) y la
 * redacción del log. Se mide el cuerpo SERIALIZADO que sale y lo que vuelve por el puerto.
 *
 * El `fetch` falso sólo contesta lo que el test preparó y tantas veces como lo preparó: una llamada
 * de más, o a otra ruta, lanza. Los fixtures son los derivados de la spec (ver la cabecera de
 * `ancillaries/shop.response.mapper.test.ts`) y los errores, los de
 * `help/stateless-ancillaries-api-1.0/1.0-errors.txt`. Ningún test llama a Sabre.
 */

type Json = Record<string, unknown>;

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const CTX: SearchContext = { tenantId: TENANT_ID, requestId: 'req-anc' };
const TOKEN = 'ATK-SUPERSECRETO';
const PCC = 'ZZZZ';
const PNR = 'SXZRGJ';
const OFFER_UUID = 'b891aae1-836f-447e-ae2c-16d64d9c76e2';

const ORDER: AncillaryOrderRef = {
  orderId: PNR,
  contentSource: 'ATPCO',
  passengers: [{ paxType: 'ADT' }, { paxType: 'CHD' }],
};

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as Json;
}

const shopFixture = (): Json => fixture('stateless-ancillaries-shop-pnr-200.derived.json');
const addFixture = (): Json => fixture('stateless-ancillaries-add-200.derived.json');
const removeFixture = (): Json => fixture('stateless-ancillaries-remove-200.derived.json');

function config(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: PCC,
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// El arnés
// ---------------------------------------------------------------------------------------------

interface LogCall {
  readonly level: string;
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

interface WireCall {
  readonly path: string;
  readonly raw: string;
  readonly headers: Record<string, string>;
}

type Reply = { readonly status: number; readonly body: unknown } | { readonly network: true };

const ok = (body: unknown): Reply => ({ status: 200, body });

function wire(
  routes: Record<string, readonly Reply[]>,
  options: { cfg?: SabreConfig; tokens?: SabreTokenProvider } = {},
) {
  const cfg = options.cfg ?? config();
  const calls: WireCall[] = [];
  const logs: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  const queues = new Map(Object.entries(routes).map(([path, replies]) => [path, [...replies]]));

  const fetchImpl: SabreFetch = (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      raw: typeof init.body === 'string' ? init.body : '',
      headers: { ...(init.headers as Record<string, string>) },
    });
    const next = queues.get(path)?.shift();
    if (next === undefined) {
      throw new Error(`el ACL llamó a ${path}, que este test no preparó (o ya agotó)`);
    }
    if ('network' in next) return Promise.reject(new Error('socket hang up'));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };

  const tokens: SabreTokenProvider = options.tokens ?? {
    getToken: () => Promise.resolve(TOKEN),
    invalidate: () => Promise.resolve(),
  };
  const http = new SabreHttpClient(cfg, tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const adapter = new SabreAncillaryAdapter(cfg, http, { logger });
  const pathsCalled = (): string[] => calls.map((call) => call.path);
  return { adapter, calls, logs, pathsCalled, port: adapter as AncillaryPort };
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un rechazo');
}

function logText(logs: readonly LogCall[]): string {
  return JSON.stringify(logs);
}

function find(catalog: AncillaryCatalog, code: string, segment = 0): AncillaryOffer {
  const offer = catalog.offers.find(
    (entry) => entry.serviceCode === code && entry.segmentRefs[0] === segment,
  );
  if (offer === undefined) throw new Error(`sin oferta ${code}/${String(segment)}`);
  return offer;
}

/** El catálogo que vio el vendedor, sin red: el mismo fixture por la misma puerta. */
async function catalogSeen(raw: Json = shopFixture()): Promise<AncillaryCatalog> {
  const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(raw)] });
  return h.port.listAncillaries(ORDER, CTX);
}

async function selection(
  code: string,
  passengerIndexes: number[],
  segment = 0,
): Promise<AncillarySelection> {
  return {
    serviceOfferItemId: find(await catalogSeen(), code, segment).serviceOfferItemId,
    passengerIndexes,
  };
}

// ---------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------

describe('SabreAncillaryAdapter.listAncillaries', () => {
  it('una llamada a /shop con sólo el PNR y el catálogo por el puerto del dominio', async () => {
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    const catalog = await h.port.listAncillaries(ORDER, CTX);

    expect(h.pathsCalled()).toEqual([SABRE_ANCILLARIES_SHOP_PATH]);
    expect(JSON.parse(h.calls[0]!.raw)).toEqual({ pnrLocator: PNR });
    expect(h.calls[0]!.headers['Conversation-ID']).toBe('sales-travel-req-anc');
    expect(catalog.offers).toHaveLength(9);
    expect(catalog.offers.filter((offer) => offer.sellable)).toHaveLength(5);
  });

  it('loguea sólo conteos: ni token, ni PNR, ni nombres, ni ids de oferta', async () => {
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    await h.adapter.listAncillaries(ORDER, CTX);

    const shop = h.logs.find((log) => log.message === 'sabre.ancillaries.shop');
    expect(shop?.level).toBe('debug');
    expect(shop?.meta).toMatchObject({
      segments: 2,
      passengers: 2,
      offers: 9,
      sellable: 5,
      notSellable: {
        DISPLAY_ONLY: 1,
        CONTACT_AIRLINE: 1,
        REQUIRES_DETAILS: 1,
        PRICE_NOT_INFORMED: 1,
      },
      warnings: {
        'seat-ancillary-skipped': 1,
        'ancillary-price-undetermined': 1,
        'offer-item-not-ancillary': 1,
      },
      partialUnauthorized: 0,
    });
    const text = logText(h.logs);
    for (const value of [TOKEN, PNR, 'TEST MR', 'JUNIOR', '987654321', OFFER_UUID, 'SA1.']) {
      expect(text).not.toContain(value);
    }
  });

  it('es una lectura: un 503 se reintenta', async () => {
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [
        { status: 503, body: { message: 'down' } },
        ok(shopFixture()),
      ],
    });
    const catalog = await h.adapter.listAncillaries(ORDER, CTX);
    expect(h.calls).toHaveLength(2);
    expect(catalog.offers).toHaveLength(9);
  });

  it('el carril en minúsculas se acepta', async () => {
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    await h.adapter.listAncillaries({ ...ORDER, contentSource: 'atpco' }, CTX);
    expect(h.calls).toHaveLength(1);
  });

  it('el entitlement parcial llega al vendedor como aviso del catálogo', async () => {
    const body = shopFixture();
    body['warnings'] = [
      { category: 'UNAUTHORIZED', type: 'ANCILLARIES_NOT_AUTHORIZED_FOR_CARRIER' },
    ];
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(body)] });
    const catalog = await h.adapter.listAncillaries(ORDER, CTX);
    expect(catalog.warnings).toEqual(
      expect.arrayContaining(['provider-warning', 'ancillary-partial-unauthorized']),
    );
  });

  it('catálogo vacío: se loguea en warn', async () => {
    const body = shopFixture();
    delete body['offers'];
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(body)] });
    const catalog = await h.adapter.listAncillaries(ORDER, CTX);
    expect(catalog.offers).toEqual([]);
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.shop')?.level).toBe('warn');
  });

  it('un 200 con errors[] es un rechazo del proveedor, no un catálogo vacío', async () => {
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [
        ok({
          errors: [
            {
              category: 'BUSINESS_ERROR',
              type: 'ANCILLARY_SHOP_FAILED',
              description: 'No ancillaries for TEST MR SABRE',
            },
          ],
        }),
      ],
    });
    const error = await rejection(() => h.adapter.listAncillaries(ORDER, CTX));
    expect(error).toBeInstanceOf(SabreApiError);
    expect(logText(h.logs)).not.toContain('TEST MR');
  });

  it('pasajeros que no casan con la orden: se lanza después de leer, sin escribir nada', async () => {
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    const error = await rejection(() =>
      h.adapter.listAncillaries({ ...ORDER, passengers: [{ paxType: 'ADT' }] }, CTX),
    );
    expect(error).toBeInstanceOf(SabreAncillaryPassengerMismatchError);
  });

  it('sin requestId el cliente genera la correlación con el prefijo de la cuenta', async () => {
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    const read = await h.adapter.readAncillaries(ORDER, { tenantId: TENANT_ID });
    expect(read.conversationId).toBe('sales-travel-conv-fijo');
  });
});

// ---------------------------------------------------------------------------------------------
// Carril: NDC fuera (P-12), y todo lo que no sea ATPCO
// ---------------------------------------------------------------------------------------------

describe('SabreAncillaryAdapter — sólo carril ATPCO', () => {
  it.each([
    ['NDC', 'NDC_NOT_SUPPORTED'],
    ['ndc', 'NDC_NOT_SUPPORTED'],
    ['LCC', 'LANE_NOT_SUPPORTED'],
    [undefined, 'LANE_UNKNOWN'],
  ])('carril %s → %s, sin tocar el cable en ninguna operación', async (lane, code) => {
    const h = wire({});
    const order: AncillaryOrderRef = {
      orderId: PNR,
      passengers: ORDER.passengers,
      ...(lane === undefined ? {} : { contentSource: lane }),
    };
    for (const run of [
      () => h.port.listAncillaries(order, CTX),
      () =>
        h.port.addAncillaries(
          order,
          [{ serviceOfferItemId: 'SA1.x.y', passengerIndexes: [0] }],
          CTX,
        ),
      () => h.port.removeAncillaries(order, ['12'], CTX),
    ]) {
      const error = await rejection(run);
      expect(error).toBeInstanceOf(SabreAncillaryLaneError);
      expect((error as SabreAncillaryLaneError).code).toBe(code);
    }
    expect(h.calls).toEqual([]);
  });

  it('un carril con forma rara no se repite en el error', async () => {
    const h = wire({});
    const error = await rejection(() =>
      h.port.listAncillaries({ ...ORDER, contentSource: 'X 4111111111111111' }, CTX),
    );
    expect((error as SabreAncillaryLaneError).lane).toBeUndefined();
    expect((error as Error).message).not.toContain('4111');
  });

  it('un PNR inválido no sale', async () => {
    const h = wire({});
    const error = await rejection(() => h.port.listAncillaries({ ...ORDER, orderId: 'x' }, CTX));
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect(h.calls).toEqual([]);
  });

  it('una orden sin pasajeros (o con más de nueve) no sale', async () => {
    const h = wire({});
    for (const passengers of [
      [],
      Array.from({ length: 10 }, () => ({ paxType: 'ADT' as const })),
    ]) {
      const error = await rejection(() => h.port.listAncillaries({ ...ORDER, passengers }, CTX));
      expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    }
    expect(h.calls).toEqual([]);
  });

  it('sin credenciales falla antes del cable', async () => {
    const h = wire({}, { cfg: config({ password: '' }) });
    const error = await rejection(() => h.port.listAncillaries(ORDER, CTX));
    expect(error).toBeInstanceOf(SabreConfigError);
    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------------------------

describe('SabreAncillaryAdapter.addAncillaries — camino feliz', () => {
  it('vuelve a consultar, agrega en modo recurso y devuelve los airExtraIds', async () => {
    const choice = await selection('0CC', [0, 1]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
    });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);

    expect(h.pathsCalled()).toEqual([SABRE_ANCILLARIES_SHOP_PATH, SABRE_ANCILLARIES_ADD_PATH]);
    expect(result).toEqual({
      outcome: 'ADDED',
      // Sabre da los airExtraIds por servicio: los dos pasajeros comparten la lista, y lo dice.
      added: [
        {
          serviceOfferItemId: choice.serviceOfferItemId,
          passengerIndex: 0,
          providerItemIds: ['12', '17'],
          providerItemIdsShared: true,
        },
        {
          serviceOfferItemId: choice.serviceOfferItemId,
          passengerIndex: 1,
          providerItemIds: ['12', '17'],
          providerItemIdsShared: true,
        },
      ],
      failed: [],
      unverified: [],
      issues: [],
    });
    const sent = JSON.parse(h.calls[1]!.raw) as Json;
    expect(sent['pnrLocator']).toBe(PNR);
    expect(sent['isCommitEnabled']).toBe(true);
    expect(h.calls[1]!.headers['Conversation-ID']).toBe('sales-travel-req-anc');
  });

  it('los ids de Sabre cambian entre consultas y la selección sigue valiendo', async () => {
    const choice = await selection('0CC', [0]);
    const fresh = shopFixture();
    const offer = (fresh['offers'] as Json[])[0]!;
    offer['id'] = 'c0ffee00-0000-4000-8000-000000000000';
    (offer['items'] as Json[]).forEach((item, index) => {
      item['id'] = `c0ffee00-0000-4000-8000-000000000000-${String(index + 1)}`;
    });
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(fresh)],
      [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
    });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);

    expect(result.outcome).toBe('ADDED');
    // Lo que viaja es la oferta NUEVA, no la que vio el vendedor.
    expect(h.calls[1]!.raw).toContain('c0ffee00-0000-4000-8000-000000000000-1');
    expect(h.calls[1]!.raw).not.toContain(OFFER_UUID);
  });

  it('la misma maleta a la ida y a la vuelta: una sola definición, ids compartidos', async () => {
    const outbound = await selection('0CC', [0], 0);
    const inbound = await selection('0CC', [0], 1);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
    });
    const result = await h.port.addAncillaries(ORDER, [outbound, inbound], CTX);

    const sent = JSON.parse(h.calls[1]!.raw) as {
      ancillaries: Json[];
      offers: { items: Json[] }[];
    };
    expect(sent.ancillaries.map((a) => a['id'])).toEqual(['ancillary_ancillary_1']);
    expect(sent.offers[0]!.items).toHaveLength(2);
    expect(result.outcome).toBe('ADDED');
    expect(result.added.map((line) => line.providerItemIdsShared)).toEqual([true, true]);
  });

  it('menos airExtraIds que líneas: no se da por agregado a nadie del servicio', async () => {
    const choice = await selection('0CC', [0, 1]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [
        ok({ results: [{ ancillaryId: 'ancillary_ancillary_1', airExtraIds: ['12'] }] }),
      ],
    });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.added).toEqual([]);
    expect(result.unverified.map((line) => line.passengerIndex)).toEqual([0, 1]);
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.add')?.meta).toMatchObject({
      mapWarnings: ['add-result-incomplete'],
    });
  });

  it('el alta loguea el desenlace con conteos, sin ids ni PNR', async () => {
    const choice = await selection('0CC', [0]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
    });
    await h.port.addAncillaries(ORDER, [choice], CTX);
    const add = h.logs.find((log) => log.message === 'sabre.ancillaries.add');
    expect(add?.level).toBe('debug');
    expect(add?.meta).toMatchObject({ outcome: 'ADDED', sent: 1, added: 1, unverified: 0 });
    const text = logText(h.logs);
    for (const value of [PNR, OFFER_UUID, choice.serviceOfferItemId, '"12"', 'TEST MR']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('SabreAncillaryAdapter.addAncillaries — lo que se rechaza por línea, sin cobrar', () => {
  it('cambió el precio: PRICE_CHANGED y /add no se llama', async () => {
    const choice = await selection('0CC', [0, 1]);
    const fresh = shopFixture();
    const item = ((fresh['offers'] as Json[])[0]!['items'] as Json[])[0]!;
    item['price'] = {
      unitPrices: [{ total: { amount: { amount: '40.00', currencyCode: 'USD' } } }],
    };
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(fresh)] });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);

    expect(h.pathsCalled()).toEqual([SABRE_ANCILLARIES_SHOP_PATH]);
    expect(result.outcome).toBe('FAILED');
    expect(result.failed.map((line) => line.reason)).toEqual(['PRICE_CHANGED', 'PRICE_CHANGED']);
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.add')?.level).toBe('warn');
  });

  it('ya no se ofrece: NOT_OFFERED', async () => {
    const choice = await selection('GTS', [0]);
    const fresh = shopFixture();
    const items = (fresh['offers'] as Json[])[0]!['items'] as Json[];
    items.splice(2, 1);
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(fresh)] });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);
    expect(result.failed).toEqual([
      { serviceOfferItemId: choice.serviceOfferItemId, passengerIndex: 0, reason: 'NOT_OFFERED' },
    ]);
    expect(h.calls).toHaveLength(1);
  });

  it('una selección de otro PNR no vale aquí', async () => {
    const choice = await selection('GTS', [0]);
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    const result = await h.port.addAncillaries({ ...ORDER, orderId: 'ABC123' }, [choice], CTX);
    expect(result.failed.map((line) => line.reason)).toEqual(['NOT_OFFERED']);
    expect(h.calls).toHaveLength(1);
  });

  it('no vendible: NOT_SELLABLE', async () => {
    const choice = await selection('0BX', [0]);
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);
    expect(result.failed.map((line) => line.reason)).toEqual(['NOT_SELLABLE']);
    expect(h.calls).toHaveLength(1);
  });

  it('un pasajero no elegible no frena al que sí: PARTIAL', async () => {
    const choice = await selection('GTS', [0, 1]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [
        ok({ results: [{ ancillaryId: 'ancillary_ancillary_2', airExtraIds: ['21'] }] }),
      ],
    });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);
    expect(result.outcome).toBe('PARTIAL');
    expect(result.added).toEqual([
      {
        serviceOfferItemId: choice.serviceOfferItemId,
        passengerIndex: 0,
        providerItemIds: ['21'],
        providerItemIdsShared: false,
      },
    ]);
    expect(result.failed).toEqual([
      {
        serviceOfferItemId: choice.serviceOfferItemId,
        passengerIndex: 1,
        reason: 'PASSENGER_NOT_ELIGIBLE',
      },
    ]);
    expect(
      (JSON.parse(h.calls[1]!.raw) as { offers: { items: Json[] }[] }).offers[0]!.items[0]![
        'passengerReferenceIds'
      ],
    ).toEqual(['PAX-1']);
  });

  it.each([
    ['vacía', []],
    [
      'con la misma oferta dos veces',
      [
        { serviceOfferItemId: 'SA1.x', passengerIndexes: [0] },
        { serviceOfferItemId: 'SA1.x', passengerIndexes: [1] },
      ],
    ],
    ['con un pasajero fuera de la orden', [{ serviceOfferItemId: 'SA1.x', passengerIndexes: [2] }]],
    ['con un pasajero repetido', [{ serviceOfferItemId: 'SA1.x', passengerIndexes: [0, 0] }]],
    ['sin pasajeros', [{ serviceOfferItemId: 'SA1.x', passengerIndexes: [] }]],
  ])('una selección %s se rechaza antes de consultar', async (_label, selections) => {
    const h = wire({});
    const error = await rejection(() => h.port.addAncillaries(ORDER, selections, CTX));
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect(h.calls).toEqual([]);
  });
});

describe('SabreAncillaryAdapter.addAncillaries — escritura sin reintentos (SABRE_NON_IDEMPOTENT_PATHS)', () => {
  async function addWith(reply: Reply) {
    const choice = await selection('0CC', [0, 1]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [reply, ok(addFixture())],
    });
    const result = await h.port.addAncillaries(ORDER, [choice], CTX);
    const addCalls = h.calls.filter((call) => call.path === SABRE_ANCILLARIES_ADD_PATH);
    return { result, addCalls, h, choice };
  }

  it('un 503 en /add NO se reintenta y queda UNVERIFIED', async () => {
    const { result, addCalls, h } = await addWith({ status: 503, body: { message: 'down' } });
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.unverified.map((line) => line.passengerIndex)).toEqual([0, 1]);
    expect(result.added).toEqual([]);
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.add')?.meta).toMatchObject({
      outcome: 'UNVERIFIED',
      status: 503,
    });
  });

  it('un timeout o socket roto tampoco se reintenta', async () => {
    const { result, addCalls } = await addWith({ network: true });
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('UNVERIFIED');
  });

  it('un 401 no se reintenta ni re-autentica: rechazo antes de ejecutar → FAILED', async () => {
    const { result, addCalls } = await addWith({
      status: 401,
      body: { errorCode: 'ERR.2SG.SEC.INVALID_CREDENTIALS', message: 'bad token' },
    });
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('FAILED');
    expect(result.failed.map((line) => line.reason)).toEqual(['REJECTED', 'REJECTED']);
  });

  it('un 400 de validación es un rechazo: FAILED con REJECTED', async () => {
    const { result } = await addWith({
      status: 400,
      body: {
        errors: [
          {
            category: 'BAD_REQUEST',
            type: 'INVALID_VALUE',
            description: 'Validation Failed: pnrLocator',
          },
        ],
      },
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.unverified).toEqual([]);
  });

  it('un 200 con errores sólo de validación (BAD_REQUEST) también es rechazo', async () => {
    const { result, addCalls } = await addWith(
      ok({
        errors: [
          {
            category: 'BAD_REQUEST',
            type: 'INVALID_VALUE',
            description: 'Validation Failed: offers',
          },
        ],
      }),
    );
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('FAILED');
    expect(result.issues).toEqual([
      { severity: 'ERROR', category: 'BAD_REQUEST', type: 'INVALID_VALUE' },
    ]);
  });

  it('RESERVATION_SERVICE_FAILED («Required fields missing in the response») queda en duda', async () => {
    const { result, addCalls } = await addWith(
      ok({
        errors: [
          {
            category: 'BUSINESS_ERROR',
            type: 'RESERVATION_SERVICE_FAILED',
            description: 'Required fields missing in the response.',
          },
        ],
      }),
    );
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.issues[0]).toMatchObject({
      category: 'BUSINESS_ERROR',
      type: 'RESERVATION_SERVICE_FAILED',
    });
    expect(JSON.stringify(result.issues)).not.toContain('Required fields');
  });

  it('un {} en /add no es éxito: el cliente lo rechaza y queda en duda', async () => {
    const { result, addCalls } = await addWith(ok({}));
    expect(addCalls).toHaveLength(1);
    expect(result.outcome).toBe('UNVERIFIED');
  });

  it('una respuesta ilegible después de escribir es duda, no error', async () => {
    const { result, h } = await addWith(ok({ results: 'ok' }));
    expect(result.outcome).toBe('UNVERIFIED');
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.add')?.meta).toMatchObject({
      mapWarnings: ['add-response-unreadable'],
    });
  });

  it('un servicio que results no nombra queda sin confirmar', async () => {
    const choice = await selection('0CC', [0]);
    const fee = await selection('GTS', [0]);
    const h = wire({
      [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())],
      [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
    });
    const result = await h.port.addAncillaries(ORDER, [choice, fee], CTX);
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.added.map((line) => line.serviceOfferItemId)).toEqual([
      choice.serviceOfferItemId,
    ]);
    expect(result.unverified.map((line) => line.serviceOfferItemId)).toEqual([
      fee.serviceOfferItemId,
    ]);
  });

  it('si falla el token del alta, lanza y /add no sale: «si lanza, no se escribió»', async () => {
    const choice = await selection('0CC', [0]);
    let calls = 0;
    const tokens: SabreTokenProvider = {
      getToken: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(TOKEN) : Promise.reject(new Error('token caído'));
      },
      invalidate: () => Promise.resolve(),
    };
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture())] }, { tokens });
    const error = await rejection(() => h.port.addAncillaries(ORDER, [choice], CTX));
    expect((error as Error).message).toBe('token caído');
    expect(h.pathsCalled()).toEqual([SABRE_ANCILLARIES_SHOP_PATH]);
  });

  it('si la consulta previa falla, lanza y /add no sale', async () => {
    const choice = await selection('0CC', [0]);
    const h = wire({ [SABRE_ANCILLARIES_SHOP_PATH]: [ok({ segments: 'roto' })] });
    const error = await rejection(() => h.port.addAncillaries(ORDER, [choice], CTX));
    expect(error).toBeInstanceOf(SabreAncillaryMappingError);
    expect(h.pathsCalled()).toEqual([SABRE_ANCILLARIES_SHOP_PATH]);
  });
});

// ---------------------------------------------------------------------------------------------
// Baja
// ---------------------------------------------------------------------------------------------

describe('SabreAncillaryAdapter.removeAncillaries', () => {
  it('quita por airExtraId con commit explícito', async () => {
    const h = wire({ [SABRE_ANCILLARIES_REMOVE_PATH]: [ok(removeFixture())] });
    const result = await h.port.removeAncillaries(ORDER, ['12', '17'], CTX);
    expect(JSON.parse(h.calls[0]!.raw)).toEqual({
      pnrLocator: PNR,
      isCommitEnabled: true,
      airExtraIds: ['12', '17'],
    });
    expect(result).toEqual({
      outcome: 'REMOVED',
      removed: ['12', '17'],
      failed: [],
      unverified: [],
      issues: [],
    });
    expect(h.logs.find((log) => log.message === 'sabre.ancillaries.remove')?.level).toBe('debug');
    expect(logText(h.logs)).not.toContain(PNR);
  });

  it('un 503 NO se reintenta y queda UNVERIFIED', async () => {
    const h = wire({
      [SABRE_ANCILLARIES_REMOVE_PATH]: [
        { status: 503, body: { message: 'down' } },
        ok(removeFixture()),
      ],
    });
    const result = await h.port.removeAncillaries(ORDER, ['12'], CTX);
    expect(h.calls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'UNVERIFIED', unverified: ['12'], failed: [] });
  });

  it('un 400 es rechazo: FAILED', async () => {
    const h = wire({
      [SABRE_ANCILLARIES_REMOVE_PATH]: [
        { status: 400, body: { errors: [{ category: 'BAD_REQUEST', type: 'INVALID_VALUE' }] } },
      ],
    });
    const result = await h.port.removeAncillaries(ORDER, ['12'], CTX);
    expect(result).toMatchObject({ outcome: 'FAILED', failed: ['12'], unverified: [] });
  });

  it('SABRE_COMMAND_SERVICE_FAILED queda en duda', async () => {
    const h = wire({
      [SABRE_ANCILLARIES_REMOVE_PATH]: [
        ok({ errors: [{ category: 'BUSINESS_ERROR', type: 'SABRE_COMMAND_SERVICE_FAILED' }] }),
      ],
    });
    const result = await h.port.removeAncillaries(ORDER, ['12'], CTX);
    expect(result.outcome).toBe('UNVERIFIED');
  });

  it('un {} NO es éxito aquí (sí lo es en Manage Ancillary): queda en duda', async () => {
    const h = wire({ [SABRE_ANCILLARIES_REMOVE_PATH]: [ok({})] });
    const result = await h.port.removeAncillaries(ORDER, ['12'], CTX);
    expect(h.calls).toHaveLength(1);
    expect(result.outcome).toBe('UNVERIFIED');
  });

  it('un id que no vuelve, o una respuesta ilegible, queda en duda', async () => {
    const partial = wire({
      [SABRE_ANCILLARIES_REMOVE_PATH]: [ok({ results: [{ airExtraId: '12' }] })],
    });
    expect(await partial.port.removeAncillaries(ORDER, ['12', '17'], CTX)).toMatchObject({
      outcome: 'UNVERIFIED',
      removed: ['12'],
      unverified: ['17'],
    });
    const unreadable = wire({ [SABRE_ANCILLARIES_REMOVE_PATH]: [ok({ results: 'ok' })] });
    expect(await unreadable.port.removeAncillaries(ORDER, ['12'], CTX)).toMatchObject({
      outcome: 'UNVERIFIED',
      unverified: ['12'],
    });
    expect(
      unreadable.logs.find((log) => log.message === 'sabre.ancillaries.remove')?.meta,
    ).toMatchObject({ mapWarnings: ['remove-response-unreadable'] });
  });

  it('un id inválido no sale', async () => {
    const h = wire({});
    const error = await rejection(() => h.port.removeAncillaries(ORDER, ['4111111111111111'], CTX));
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// D1 — barrido de salida por `SabreHttpClient.postJson`. Va aquí y no en
// `pan-egress.guard.test.ts` para no chocar con la otra línea de trabajo; la regla es la misma: se
// miden los bytes que salen, con un PAN de prueba inyectado en cada hoja de texto.
// ---------------------------------------------------------------------------------------------

const TEST_PAN = '4111111111111111';

type LeafPath = readonly (string | number)[];

function stringLeaves(value: unknown, path: LeafPath = []): LeafPath[] {
  if (typeof value === 'string') return [path];
  if (Array.isArray(value))
    return value.flatMap((item, index) => stringLeaves(item, [...path, index]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, [...path, key]));
  }
  return [];
}

function setLeaf(root: unknown, path: LeafPath, value: string): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
}

type Outcome = 'rejected' | 'dropped' | 'carried';

const carriedPan = (calls: readonly WireCall[]): boolean =>
  calls.some((call) => call.raw.includes(TEST_PAN));

/**
 * El PAN en una hoja de la RESPUESTA de /shop: el alta reenvía datos de la consulta, así que lo
 * que Sabre devuelva en texto libre no puede salir de vuelta con forma de tarjeta.
 */
async function sweepShopLeaf(path: LeafPath): Promise<Outcome> {
  const mutated = shopFixture();
  setLeaf(mutated, path, TEST_PAN);
  const h = wire({
    [SABRE_ANCILLARIES_SHOP_PATH]: [ok(mutated), ok(mutated)],
    [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
  });
  try {
    const catalog = await h.port.listAncillaries(ORDER, CTX);
    const selections = catalog.offers
      .filter((offer) => offer.sellable)
      .map((offer) => ({
        serviceOfferItemId: offer.serviceOfferItemId,
        passengerIndexes: offer.passengers.map((entry) => entry.passengerIndex),
      }));
    if (selections.length > 0) await h.port.addAncillaries(ORDER, selections, CTX);
  } catch {
    // Que falle después no importa aquí: se mide lo que salió.
  }
  if (!h.calls.some((call) => call.path === SABRE_ANCILLARIES_ADD_PATH)) return 'rejected';
  return carriedPan(h.calls) ? 'carried' : 'dropped';
}

describe('SabreAncillaryAdapter — D1: ningún PAN llega al cable', () => {
  it('lo que manda el llamador (orden, carril, selección, ids a quitar) nunca viaja', async () => {
    const choice = await selection('0CC', [0]);
    const outcomes = new Map<string, Outcome>();
    const run = async (label: string, call: (h: ReturnType<typeof wire>) => Promise<unknown>) => {
      const h = wire({
        [SABRE_ANCILLARIES_SHOP_PATH]: [ok(shopFixture()), ok(shopFixture())],
        [SABRE_ANCILLARIES_ADD_PATH]: [ok(addFixture())],
        [SABRE_ANCILLARIES_REMOVE_PATH]: [ok(removeFixture())],
      });
      try {
        await call(h);
      } catch {
        // Se mide el cable.
      }
      outcomes.set(
        label,
        h.calls.length === 0 ? 'rejected' : carriedPan(h.calls) ? 'carried' : 'dropped',
      );
    };
    await run('list.orderId', (h) => h.port.listAncillaries({ ...ORDER, orderId: TEST_PAN }, CTX));
    await run('list.contentSource', (h) =>
      h.port.listAncillaries({ ...ORDER, contentSource: TEST_PAN }, CTX),
    );
    await run('add.orderId', (h) =>
      h.port.addAncillaries({ ...ORDER, orderId: TEST_PAN }, [choice], CTX),
    );
    await run('add.serviceOfferItemId', (h) =>
      h.port.addAncillaries(ORDER, [{ serviceOfferItemId: TEST_PAN, passengerIndexes: [0] }], CTX),
    );
    await run('remove.orderId', (h) =>
      h.port.removeAncillaries({ ...ORDER, orderId: TEST_PAN }, ['12'], CTX),
    );
    await run('remove.providerItemIds', (h) => h.port.removeAncillaries(ORDER, [TEST_PAN], CTX));

    expect(Object.fromEntries(outcomes)).toEqual({
      'list.orderId': 'rejected',
      'list.contentSource': 'rejected',
      'add.orderId': 'rejected',
      // Consulta (sin el PAN), la selección no casa con nada y /add no sale.
      'add.serviceOfferItemId': 'dropped',
      'remove.orderId': 'rejected',
      'remove.providerItemIds': 'rejected',
    });
  });

  it('cada hoja de texto de la respuesta de /shop: el alta la omite o no sale, nunca la reenvía', async () => {
    const base = shopFixture();
    const outcomes = new Map<string, Outcome>();
    for (const path of stringLeaves(base)) outcomes.set(path.join('.'), await sweepShopLeaf(path));

    expect([...outcomes].filter(([, outcome]) => outcome === 'carried')).toEqual([]);
    // El barrido no es hueco: las dos ramas que no viajan aparecen, por las razones esperadas.
    // Texto libre que el alta reenvía: se omite el campo y el alta sale igual.
    expect(outcomes.get('ancillaries.0.commercialName')).toBe('dropped');
    expect(outcomes.get('ancillaries.0.groupName')).toBe('dropped');
    expect(outcomes.get('segments.1.brandCode')).toBe('dropped');
    // Lo que nunca se reenvía.
    expect(outcomes.get('passengers.0.givenName')).toBe('dropped');
    expect(outcomes.get('passengers.0.loyaltyPrograms.0.number')).toBe('dropped');
    expect(outcomes.get('ancillaries.0.specialService.detail')).toBe('dropped');
    // Ids y estructura: la respuesta o el ítem se rechazan y lo afectado no se agrega.
    expect(outcomes.get('segments.1.id')).toBe('rejected');
    expect(outcomes.get('passengers.0.nameNumber')).toBe('rejected');
    expect(outcomes.get('offers.0.items.0.id')).toBe('dropped');
    expect(outcomes.get('ancillaries.0.subCode')).toBe('dropped');
    expect(outcomes.size).toBeGreaterThan(150);
  });
});
