import { Logger } from '@nestjs/common';
import {
  HotelOfferSchema,
  type HotelOffer,
  type HotelRatesQuery,
  type HotelRoompack,
} from '@sales-travel/canonical';
import type { HotelRatesDetailPort } from '@sales-travel/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCascade,
  toTenantView,
  type ApplicableRule,
  type PricingService,
} from '../pricing/pricing.service.js';
import {
  StubHotelProviderFactory,
  stubHotelOffer,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  FakeDespegarHotelsAdapter,
  fakeDespegarFactory,
  hotelRegistry,
} from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb } from './__fixtures__/fake-hotels-db.js';
import { HotelSearchContextStore } from './hotel-search-context.store.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * El piso de precio del proveedor en la búsqueda y el detalle de hoteles (PR-2.5; RF-12 con
 * D-TBO-16 A).
 *
 * El proveedor con piso es el stub anónimo, con el pack del ejemplo de docs/tbo/02 §9.5: neto
 * 305.75 y piso 321.34 en USD. Despegar va al lado, con su factory real sobre el ACL falso, porque
 * lo que se protege es que sin `minimumSellingPrice` su precio no cambie.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const CIUDAD = 2345;
const DESPEGAR = 'despegar-hotels';
const STUB = 'stub-hotels';
const HOTEL_STUB = 'T-1';
const PACK_STUB = `${STUB}-${HOTEL_STUB}-RP`;

const NETO = 30_575;
const PISO = 32_134;

const MAS_3_CONSOLIDADOR: ApplicableRule = {
  tenantId: CONSOLIDADOR,
  tenantName: 'Consolidador',
  level: 1,
  ruleType: 'percentage',
  valueMinor: 300,
};
const MAS_1_AGENCIA: ApplicableRule = {
  tenantId: AGENCIA,
  tenantName: 'Agencia',
  level: 2,
  ruleType: 'percentage',
  valueMinor: 100,
};

function entrada(): HotelAvailabilityInput {
  return {
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-11',
    rooms: [{ adults: 2, childrenAges: [] }],
    destinationId: CIUDAD,
  };
}

/** El hotel del stub con una tarifa de neto 305.75 y, si se pide, un piso. */
function hotelConPiso(pisoMinor: number | undefined): HotelOffer {
  const base = stubHotelOffer(STUB, { hotelId: HOTEL_STUB, amountMinor: NETO });
  return HotelOfferSchema.parse({
    ...base,
    roompacks: base.roompacks.map((p) => ({
      ...p,
      price:
        pisoMinor === undefined
          ? p.price
          : { ...p.price, minimumSellingPrice: { amountMinor: pisoMinor, currency: 'USD' } },
    })),
  });
}

interface Banco {
  service: HotelsService;
  stub: StubHotelProviderFactory;
}

function banco(opts: { reglas?: ApplicableRule[]; piso?: number; conStub?: boolean } = {}): Banco {
  const stub = new StubHotelProviderFactory({
    code: STUB,
    offers: [hotelConPiso(opts.piso)],
  });
  const despegar = fakeDespegarFactory(new FakeDespegarHotelsAdapter()).factory;
  const conStub = opts.conStub ?? true;

  const service = new HotelsService(
    hotelRegistry(conStub ? [stub, despegar] : [despegar]),
    fakeHotelsDb({
      catalogo: { [DESPEGAR]: ['101', '205', '350', '412'], [STUB]: [HOTEL_STUB] },
    }).service,
    { getApplicableRules: () => Promise.resolve(opts.reglas ?? []) } as unknown as PricingService,
    {
      assertWithinQuota: () => Promise.resolve(),
      instrument: (_meta: unknown, run: () => Promise<unknown>) => run(),
    } as unknown as SearchTelemetryService,
    new CircuitBreakerService(),
    new HotelSearchContextStore(new MemoryCacheAdapter()),
  );
  return { service, stub };
}

function tarifaDelStub(hotels: readonly HotelOffer[]): HotelRoompack {
  const pack = hotels
    .find((o) => o.hotelId === HOTEL_STUB)
    ?.roompacks.find((rp) => rp.id === PACK_STUB);
  if (!pack) throw new Error('no está la tarifa del stub');
  return pack;
}

/** Los hoteles de Despegar, incluido el que llegó sin tarifas: todo lo que no es del stub. */
function deDespegar(hotels: readonly HotelOffer[]): HotelOffer[] {
  return hotels.filter((o) => o.hotelId !== HOTEL_STUB);
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HotelsService.searchAvailability — piso del proveedor (RF-12)', () => {
  it('CA 1: +3 % del consolidador y +1 % de la agencia dan 318.07 → la agencia vende a 321.34', async () => {
    const b = banco({ reglas: [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA], piso: PISO });
    const res = await b.service.searchAvailability(AGENCIA, entrada());

    // El aporte del piso (3.27) es margen de la agencia; su costo sigue siendo neto + 3 %: el
    // consolidador no cobra un margen que no configuró (CA 3).
    expect(tarifaDelStub(res.hotels).pricing).toEqual({
      costMinor: 31_492,
      finalMinor: PISO,
      ownMarkupMinor: 315 + 327,
      currency: 'USD',
    });
  });

  it('el neto y el piso del proveedor no se tocan: el precio de venta vive en `pricing`', async () => {
    const b = banco({ reglas: [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA], piso: PISO });
    const res = await b.service.searchAvailability(AGENCIA, entrada());

    const pack = tarifaDelStub(res.hotels);
    expect(pack.price.total).toEqual({ amountMinor: NETO, currency: 'USD' });
    expect(pack.price.minimumSellingPrice).toEqual({ amountMinor: PISO, currency: 'USD' });
  });

  it('CA 2: tenant sin reglas → el precio de venta es el piso, con la diferencia como margen propio', async () => {
    const b = banco({ piso: PISO });
    const res = await b.service.searchAvailability(AGENCIA, entrada());

    expect(tarifaDelStub(res.hotels).pricing).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO,
      currency: 'USD',
    });
  });

  it('CA 2: sin reglas, las tarifas de Despegar (sin piso) salen igual que sin el otro proveedor', async () => {
    const conPiso = await banco({ piso: PISO }).service.searchAvailability(AGENCIA, entrada());
    const soloDespegar = await banco({ conStub: false }).service.searchAvailability(
      AGENCIA,
      entrada(),
    );

    expect(deDespegar(conPiso.hotels)).toEqual(soloDespegar.hotels);
    const packs = deDespegar(conPiso.hotels).flatMap((o) => o.roompacks);
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.some((rp) => 'pricing' in rp)).toBe(false);
  });

  it('sin `minimumSellingPrice` no hay piso: con reglas, Despegar sigue con la cascada de siempre', async () => {
    const reglas = [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA];
    const res = await banco({ reglas, piso: PISO }).service.searchAvailability(AGENCIA, entrada());

    const packs = deDespegar(res.hotels).flatMap((o) => o.roompacks);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      expect(pack.provider.name).toBe(DESPEGAR);
      expect(pack.price.minimumSellingPrice).toBeUndefined();
      expect(pack.pricing).toEqual(
        toTenantView(
          applyCascade(pack.price.total.amountMinor, reglas),
          AGENCIA,
          pack.price.total.currency,
        ),
      );
    }
  });

  it('el mismo proveedor sin piso en la tarifa: sin reglas sale sin `pricing`', async () => {
    const res = await banco().service.searchAvailability(AGENCIA, entrada());

    expect(tarifaDelStub(res.hotels)).not.toHaveProperty('pricing');
  });

  it('un piso por debajo de la cascada no cambia nada: gana la cascada', async () => {
    const b = banco({ reglas: [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA], piso: 30_000 });
    const res = await b.service.searchAvailability(AGENCIA, entrada());

    expect(tarifaDelStub(res.hotels).pricing).toEqual({
      costMinor: 31_492,
      finalMinor: 31_807,
      ownMarkupMinor: 315,
      currency: 'USD',
    });
  });

  it('el consolidador que vende directo cobra el piso como margen propio', async () => {
    const b = banco({ reglas: [MAS_3_CONSOLIDADOR], piso: PISO });
    const res = await b.service.searchAvailability(CONSOLIDADOR, entrada());

    expect(tarifaDelStub(res.hotels).pricing).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO,
      currency: 'USD',
    });
  });
});

describe('HotelsService.getHotelDetail — piso del proveedor (RF-12)', () => {
  it('el detalle, que es desde donde se reserva, también aplica el piso sin reglas', async () => {
    const b = banco({ piso: PISO });
    const getHotelRates = vi.fn((_q: HotelRatesQuery) => Promise.resolve(hotelConPiso(PISO)));
    Object.assign(b.stub.adapterFor(AGENCIA), { getHotelRates } satisfies HotelRatesDetailPort);

    const { checkinDate, checkoutDate, rooms } = entrada();
    const offer = await b.service.getHotelDetail(AGENCIA, {
      hotelId: HOTEL_STUB,
      provider: STUB,
      checkinDate,
      checkoutDate,
      rooms,
    });

    expect(getHotelRates).toHaveBeenCalledTimes(1);
    expect(tarifaDelStub([offer]).pricing).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO,
      currency: 'USD',
    });
  });
});
