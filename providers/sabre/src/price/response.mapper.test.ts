import type { Offer } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import multipaxFixture from '../__fixtures__/price-multipax-2adt-200.json';
import onewayFixture from '../__fixtures__/price-oneway-adult-200.json';
import unusedTicketFixture from '../__fixtures__/price-unused-ticket-negative-200.json';
import { SABRE_RAW_KEYS } from './request.builder';
import {
  SABRE_BOOKING_OFFER_ID_MAX_LENGTH,
  SabrePriceMappingError,
  SabrePriceRejectedError,
  mapSabrePriceResponse,
  resolveSabrePriceExpiry,
  type SabrePriceMapResult,
  type SabrePriceRequestedTraveler,
  type SabrePriceWarning,
  type SabrePriceWarningCode,
} from './response.mapper';

/**
 * Los tres fixtures son los **ejemplos de respuesta oficiales** de Offer Price NDC, extraídos sin
 * tocar de `docs/sabre/evidence/specs/offer-price-ndc-v1.yml` (`:2080-2398` ida, `:2912-3483`
 * multipax, `:4149-4483` billete sin usar). El de billete sin usar es el único de los cinco que
 * devuelve importes NEGATIVOS, y por eso está aquí: es el caso que el `Money` canónico no puede
 * representar.
 *
 * Los casos que los ejemplos oficiales NO cubren —ADT+CNN con dos `offerItems`, ancillary
 * `type: "Service"`, `obFees[]`— se construyen **derivando del ejemplo oficial** y están marcados
 * como sintéticos en cada test. No hay ejemplo oficial de ninguno de los tres.
 */
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const FETCHED_AT = '2024-12-12T02:45:00.000Z';

type Json = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requestedTravelers(
  paxTypes: readonly ('ADT' | 'CHD' | 'INF')[] = ['ADT'],
): SabrePriceRequestedTraveler[] {
  return paxTypes.map((paxType, requestedTravelerIndex) => ({
    requestPassengerId: `Passenger${String(requestedTravelerIndex + 1)}`,
    requestedTravelerIndex,
    paxType,
    requestedPtc: paxType === 'CHD' ? 'CNN' : paxType,
  }));
}

function run(raw: unknown, ctx: Partial<Parameters<typeof mapSabrePriceResponse>[1]> = {}) {
  return mapSabrePriceResponse(raw, {
    tenantId: TENANT_ID,
    fetchedAt: FETCHED_AT,
    ...ctx,
    requestedTravelers: ctx.requestedTravelers ?? requestedTravelers(),
  });
}

function codes(warnings: readonly SabrePriceWarning[]): SabrePriceWarningCode[] {
  return warnings.map((warning) => warning.code);
}

function onlyPriced(result: SabrePriceMapResult) {
  expect(result.priced).toHaveLength(1);
  const entry = result.priced[0];
  if (entry === undefined) throw new Error('sin oferta revalidada');
  return entry;
}

/** Navega el fixture clonado hasta `response.offers[0]`. */
function firstOffer(payload: Json): Json {
  const response = payload['response'] as Json;
  const offers = response['offers'] as Json[];
  const offer = offers[0];
  if (offer === undefined) throw new Error('fixture sin ofertas');
  return offer;
}

function firstAirItem(payload: Json): Json {
  const items = firstOffer(payload)['offerItems'] as Json[];
  const item = items[0];
  if (item === undefined) throw new Error('fixture sin offerItems');
  return item;
}

function basisOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT_ID,
    products: ['flight'],
    provider: {
      name: 'sabre',
      offerRef: 'shop-ref',
      source: 'NDC',
      raw: { [SABRE_RAW_KEYS.shopOfferItemIds]: ['dd07bbd7fb57c88nclq1qixyj3-1-1'] },
    },
    total: { amountMinor: 11890, currency: 'USD' },
    baseFare: { amountMinor: 9674, currency: 'USD' },
    taxes: { amountMinor: 2216, currency: 'USD' },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AA',
            flightNumber: '76',
            origin: 'JFK',
            destination: 'SFO',
            departureAt: '2024-02-11T06:00:00-05:00',
            arrivalAt: '2024-02-11T09:43:00-08:00',
            durationMinutes: 403,
            cabin: 'economy',
            bookingClass: 'B',
          },
        ],
        totalDurationMinutes: 403,
        stops: 0,
      },
    ],
    fetchedAt: '2024-12-12T02:30:00.000Z',
    expiresAt: '2024-12-12T02:31:30.000Z',
    expiresAtSource: 'platform-policy',
    ...overrides,
  };
}

describe('el ejemplo oficial de ida', () => {
  it('devuelve una oferta con el precio confirmado y el desglose cuadrado', () => {
    const { offer } = onlyPriced(run(clone(onewayFixture)));

    expect(offer.total).toEqual({ amountMinor: 11890, currency: 'USD' });
    // Ni `totalTaxes` ni `baseAmount` vienen en `totalPrice` en este ejemplo: los impuestos salen
    // del nivel pasajero y la base se deriva. `base + impuestos = total`, siempre.
    expect(offer.taxes).toEqual({ amountMinor: 2216, currency: 'USD' });
    expect(offer.baseFare).toEqual({ amountMinor: 9674, currency: 'USD' });
    expect(offer.baseFare.amountMinor + offer.taxes.amountMinor).toBe(offer.total.amountMinor);
    expect(offer.provider.name).toBe('sabre');
    expect(offer.provider.source).toBe('NDC');
    expect(offer.provider.offerRef).toBe('dd07bbd7fb57c88nclq1qixyj3-1');
  });

  it('publica la cadena de identificadores que consume createBooking (RF-07 CA-1)', () => {
    const { handles, offer } = onlyPriced(run(clone(onewayFixture)));

    expect(handles).toMatchObject({
      offerId: 'dd07bbd7fb57c88nclq1qixyj3-1',
      offerItemIds: ['dd07bbd7fb57c88nclq1qixyj3-1-1'],
      passengerIds: ['Passenger1'],
      passengerBindings: [
        {
          pricePassengerId: 'Passenger1',
          requestedTravelerIndex: 0,
          paxType: 'ADT',
          requestedPtc: 'ADT',
          pricedPtc: 'ADT',
        },
      ],
      source: 'NDC',
      ttlSeconds: 1200,
      offerExpirationDateTime: '2024-12-12T03:00:23Z',
      paymentTimeLimitText: '2024-12-12T23:59:00',
    });

    // Y los mismos ids viajan dentro de la Offer, que es lo que sobrevive a Redis y al navegador.
    expect(offer.provider.raw?.[SABRE_RAW_KEYS.priceOfferId]).toBe(handles.offerId);
    expect(offer.provider.raw?.[SABRE_RAW_KEYS.priceOfferItemIds]).toEqual(handles.offerItemIds);
    expect(offer.provider.raw?.[SABRE_RAW_KEYS.pricePassengerIds]).toEqual(handles.passengerIds);
    expect(offer.provider.raw?.[SABRE_RAW_KEYS.pricePassengerBindings]).toEqual(
      handles.passengerBindings,
    );
  });

  it('el vencimiento se persiste del proveedor, no se calcula', () => {
    const { offer } = onlyPriced(run(clone(onewayFixture)));
    // 1.200 s de TTL, pero `expiresAt` sale de `offerExpirationDateTime`, no de `fetchedAt + ttl`
    // (que aquí daría 03:05:00). Ver docs/sabre/03 §3.3.
    expect(offer.expiresAt).toBe('2024-12-12T03:00:23.000Z');
    expect(offer.expiresAtSource).toBe('provider');
  });

  it('un desglose por pasajero con un solo adulto', () => {
    const { offer } = onlyPriced(run(clone(onewayFixture)));
    expect(offer.fareBreakdown).toEqual([
      {
        paxType: 'ADT',
        paxCount: 1,
        basePerPax: { amountMinor: 9674, currency: 'USD' },
        taxesPerPax: { amountMinor: 2216, currency: 'USD' },
      },
    ]);
  });
});

describe('el ejemplo oficial de varios pasajeros', () => {
  it('agrupa los dos adultos en una entrada de desglose que suma el total', () => {
    const { offer } = onlyPriced(
      run(clone(multipaxFixture), { requestedTravelers: requestedTravelers(['ADT', 'ADT']) }),
    );

    expect(offer.total).toEqual({ amountMinor: 23780, currency: 'USD' });
    expect(offer.fareBreakdown).toEqual([
      {
        paxType: 'ADT',
        paxCount: 2,
        basePerPax: { amountMinor: 9674, currency: 'USD' },
        taxesPerPax: { amountMinor: 2216, currency: 'USD' },
      },
    ]);
    const entry = offer.fareBreakdown?.[0];
    if (entry === undefined) throw new Error('sin desglose');
    expect((entry.basePerPax.amountMinor + entry.taxesPerPax.amountMinor) * entry.paxCount).toBe(
      offer.total.amountMinor,
    );
  });

  it('los dos pasajeros aparecen en los handles, sin duplicados', () => {
    const { handles, offer } = onlyPriced(
      run(clone(multipaxFixture), { requestedTravelers: requestedTravelers(['ADT', 'ADT']) }),
    );
    expect(handles.passengerIds).toEqual(['Passenger1', 'Passenger2']);
    expect(handles.offerItemIds).toEqual(['dd07bbd7fb57jkq5llq1qhzkd6-1-1']);
    expect(handles.passengerBindings.map((binding) => binding.requestedTravelerIndex)).toEqual([
      0, 1,
    ]);
    // El mismo componente repetido por ADT no se duplica por pasajero ni por precio.
    expect(offer.fareComponents).toHaveLength(1);
  });
});

describe('el ejemplo oficial de billete sin usar — el caso que el canónico no representa', () => {
  it('descarta la oferta de importe negativo en vez de publicar su valor absoluto', () => {
    // `totalPrice.totalAmount = "-220.30"` (`:4448-4478`): es un reembolso neto. `MoneySchema`
    // exige `nonnegative`, así que publicar 220,30 sería cobrar lo que hay que devolver.
    const result = run(clone(unusedTicketFixture));
    expect(result.priced).toHaveLength(0);
    expect(result.droppedOffers).toBe(1);
    expect(codes(result.warnings)).toContain('negative-amount-unsupported');
  });

  it('cero ofertas revalidadas no se confunde con "no hubo respuesta"', () => {
    const result = run(clone(unusedTicketFixture));
    expect(result.droppedOffers).toBeGreaterThan(0);
  });
});

describe('el cambio de precio se ve, no se traga', () => {
  it('sin oferta de referencia el veredicto es `unknown`, no `unchanged`', () => {
    const { priceChange } = onlyPriced(run(clone(onewayFixture)));
    expect(priceChange.kind).toBe('unknown');
    expect(priceChange.deltaMinor).toBeUndefined();
    expect(run(clone(onewayFixture)).priceChanged).toBe(false);
  });

  it('mismo importe que la búsqueda ⇒ `unchanged`, sin aviso', () => {
    const result = run(clone(onewayFixture), { basis: basisOffer() });
    expect(onlyPriced(result).priceChange).toMatchObject({ kind: 'unchanged', deltaMinor: 0 });
    expect(codes(result.warnings)).not.toContain('price-changed');
    expect(result.priceChanged).toBe(false);
  });

  it('subida ⇒ `increased`, delta en unidades menores y aviso', () => {
    const basis = basisOffer({ total: { amountMinor: 11000, currency: 'USD' } });
    const result = run(clone(onewayFixture), { basis });
    expect(onlyPriced(result).priceChange).toMatchObject({
      kind: 'increased',
      deltaMinor: 890,
      previousTotalMinor: 11000,
      pricedTotalMinor: 11890,
    });
    expect(codes(result.warnings)).toContain('price-changed');
    expect(result.priceChanged).toBe(true);
  });

  it('bajada ⇒ `decreased` con delta negativo', () => {
    const basis = basisOffer({ total: { amountMinor: 12000, currency: 'USD' } });
    const { priceChange } = onlyPriced(run(clone(onewayFixture), { basis }));
    expect(priceChange).toMatchObject({ kind: 'decreased', deltaMinor: -110 });
  });

  it('otra moneda ⇒ `currency-changed`, y NO se resta nada', () => {
    const basis = basisOffer({ total: { amountMinor: 11890, currency: 'COP' } });
    const { priceChange } = onlyPriced(run(clone(onewayFixture), { basis }));
    expect(priceChange.kind).toBe('currency-changed');
    expect(priceChange.deltaMinor).toBeUndefined();
    expect(priceChange.previousCurrency).toBe('COP');
  });
});

describe('la forma de pago y su efecto sobre el precio mostrado', () => {
  it('sin forma de pago declarada, el resultado avisa de que el precio está sujeto a ella', () => {
    const result = run(clone(onewayFixture));
    expect(result.priceSubjectToFormOfPayment).toBe(true);
    expect(codes(result.warnings)).toContain('price-subject-to-form-of-payment');
  });

  it('con forma de pago declarada, no', () => {
    const result = run(clone(onewayFixture), { formOfPaymentDeclared: true });
    expect(result.priceSubjectToFormOfPayment).toBe(false);
    expect(codes(result.warnings)).not.toContain('price-subject-to-form-of-payment');
  });

  it('los obFees NO se suman a `Offer.fees` y el BIN nunca sale del mapper', () => {
    // Sintético: ningún ejemplo oficial trae `obFees[]`. La forma es la del schema `ObFee`
    // (`:1363-1424`), que declara `binNumber` con comodín, `cardCode` y `cardType`.
    const payload = clone(onewayFixture) as Json;
    firstOffer(payload)['obFees'] = [
      {
        binNumber: '545251',
        cardCode: 'MC',
        cardType: 'FDA',
        serviceCode: 'OB',
        subCode: 'T05',
        airline: 'AA',
        description: 'Credit Card Fee',
        isRefundable: false,
        surcharge: { amount: { amount: '5.00', curCode: 'USD' } },
      },
    ];

    const result = run(payload);
    const { offer } = onlyPriced(result);

    expect(codes(result.warnings)).toContain('ob-fees-relation-unverified');
    // El contrato NO dice si el fee está dentro de `totalPrice.totalAmount`: no se rellena `fees`
    // ni se toca el total (docs/sabre/03 §2.4).
    expect(offer.fees).toBeUndefined();
    expect(offer.total.amountMinor).toBe(11890);
    expect(offer.provider.raw?.['obFeesIncludedInTotal']).toBeNull();

    // Puerta pública: se serializa el resultado ENTERO —oferta, handles, avisos, mensajes— y se
    // busca cada dato de tarjeta dentro. `provider.raw` viaja al navegador.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('545251');
    expect(serialized).not.toContain('cardCode');
    expect(serialized).not.toContain('Credit Card Fee');
  });
});

describe('mensajes del proveedor', () => {
  it('un `type: ERROR` rechaza la revalidación y no arrastra el texto libre', () => {
    const payload = clone(onewayFixture) as Json;
    payload['messages'] = [
      {
        type: 'ERROR',
        message: 'Passenger SMITH/JOHN could not be priced',
        service: 'OFFER_STORE_PUT',
        code: 404,
        system: 'OFFERSTORE',
        additionalDescription: 'Invalid form of payment reference.',
      },
    ];

    let thrown: unknown;
    try {
      run(payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRejectedError);
    expect(String(thrown)).toContain('ERROR/OFFER_STORE_PUT/404');
    expect(String(thrown)).not.toContain('SMITH');
    expect(JSON.stringify(thrown)).not.toContain('Invalid form of payment reference');
  });

  it('un `type: WARNING` se propaga sin texto y no impide el precio', () => {
    const payload = clone(onewayFixture) as Json;
    payload['messages'] = [
      { type: 'WARNING', message: 'Price may increase', service: 'NDCC_OFFER_PRICE', code: 0 },
    ];

    const result = run(payload);
    expect(result.priced).toHaveLength(1);
    expect(result.providerMessages).toEqual([
      { type: 'WARNING', code: 0, service: 'NDCC_OFFER_PRICE' },
    ]);
    expect(JSON.stringify(result)).not.toContain('Price may increase');
  });

  it('una respuesta sin `response` es un rechazo, no una respuesta vacía', () => {
    expect(() => run({ version: 'v1.0.0', messages: [{ type: 'INFO' }] })).toThrow(
      SabrePriceRejectedError,
    );
  });

  it('el ACL busca `messages`, no `errors`: un `errors[]` no se confunde con un rechazo', () => {
    // `OfferPriceResponseV1` no declara `errors` (docs/sabre/03 §2.5). Si alguien "arregla" el
    // mapper para leerlo, esta oferta dejaría de mapearse y el test se pone rojo.
    const payload = clone(onewayFixture) as Json;
    payload['errors'] = [{ type: 'ERROR', description: 'esto no existe en este producto' }];
    expect(run(payload).priced).toHaveLength(1);
  });
});

describe('el borde falla fuerte: aquí no hay precio aproximado', () => {
  it('un sobre fuera de contrato lanza con rutas de issue y sin valores', () => {
    const payload = clone(onewayFixture) as Json;
    // La forma que docs/sabre/03 §3.5 documenta en las respuestas reales: objeto de dinero vacío.
    firstOffer(payload)['totalPrice'] = { totalAmount: {} };

    let thrown: unknown;
    try {
      run(payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceMappingError);
    expect(String(thrown)).toContain('totalPrice.totalAmount.amount');
  });

  it('un offerItem aéreo malformado NO degrada a "tipo desconocido": tumba la respuesta', () => {
    // Sin el `refine` de `UnknownOfferItemSchema`, este item encajaría en la rama desconocida, su
    // `id` desaparecería de `selectedOfferItems[]` y se reservaría una oferta incompleta con 200
    // por respuesta. Quitar el `refine` pone este test en rojo.
    const payload = clone(onewayFixture) as Json;
    const item = firstAirItem(payload);
    delete item['passengers'];
    expect(() => run(payload)).toThrow(SabrePriceMappingError);
  });

  it('un tercer decimal distinto de cero no se redondea: se descarta la oferta', () => {
    const payload = clone(onewayFixture) as Json;
    (firstOffer(payload)['totalPrice'] as Json)['totalAmount'] = {
      amount: '118.905',
      curCode: 'USD',
    };
    const result = run(payload);
    expect(result.priced).toHaveLength(0);
    expect(codes(result.warnings)).toContain('amount-precision-unsupported');
  });

  it('un tercer decimal en cero sí se acepta: el contrato admite 3 y muchos importes los traen', () => {
    const payload = clone(onewayFixture) as Json;
    (firstOffer(payload)['totalPrice'] as Json)['totalAmount'] = {
      amount: '118.900',
      curCode: 'USD',
    };
    expect(onlyPriced(run(payload)).offer.total.amountMinor).toBe(11890);
  });

  it('los importes se parsean como texto, sin coma flotante', () => {
    // 402,53 es el ejemplo del propio `SignedCurrencyType` (`:1185-1208`). `parseFloat * 100` da
    // 40252.999999999996 antes de redondear; este test fija el resultado exacto.
    const payload = clone(onewayFixture) as Json;
    (firstOffer(payload)['totalPrice'] as Json)['totalAmount'] = {
      amount: '402.53',
      curCode: 'USD',
    };
    (firstOffer(payload)['totalPrice'] as Json)['totalTaxes'] = { amount: '0.00', curCode: 'USD' };
    expect(onlyPriced(run(payload)).offer.total.amountMinor).toBe(40253);
  });

  it('una moneda distinta dentro del mismo importe se avisa y no se mezcla', () => {
    const payload = clone(onewayFixture) as Json;
    (firstOffer(payload)['totalPrice'] as Json)['totalTaxes'] = { amount: '22.16', curCode: 'EUR' };
    const result = run(payload);
    expect(codes(result.warnings)).toContain('currency-mismatch');
    // El total sigue en USD y el desglose vuelve al nivel pasajero, que sí está en USD.
    expect(onlyPriced(result).offer.taxes).toEqual({ amountMinor: 2216, currency: 'USD' });
  });
});

describe('las cotas de createBooking se comprueban en el paso de precio', () => {
  it('avisa cuando el offerId no cabe en `flightOffer.offerId` (49 chars)', () => {
    const payload = clone(onewayFixture) as Json;
    firstOffer(payload)['id'] = 'a'.repeat(SABRE_BOOKING_OFFER_ID_MAX_LENGTH + 1);
    const result = run(payload);
    expect(codes(result.warnings)).toContain('offer-id-over-booking-limit');
    // Es un aviso, no un error: el precio es real y la oferta es válida.
    expect(result.priced).toHaveLength(1);
  });

  it('avisa cuando hay más de 9 offerItems para `selectedOfferItems`', () => {
    const payload = clone(onewayFixture) as Json;
    const offer = firstOffer(payload);
    const item = firstAirItem(payload);
    offer['offerItems'] = Array.from({ length: 10 }, (_, index) => ({
      ...clone(item),
      id: `dd07bbd7fb57c88nclq1qixyj3-1-${String(index + 1)}`,
    }));
    // El total acompaña a los 10 items: si no, la oferta se cae antes por impuestos > total y el
    // test pasaría a medir otra cosa.
    (offer['totalPrice'] as Json)['totalAmount'] = { amount: '1189.00', curCode: 'USD' };

    const result = run(payload);
    expect(codes(result.warnings)).toContain('selected-offer-items-over-booking-limit');
    expect(result.priced).toHaveLength(1);
  });
});

describe('casos que los ejemplos oficiales no traen', () => {
  it('un id de pasajero que no salió en el request invalida la oferta', () => {
    const payload = clone(onewayFixture) as Json;
    const passenger = (firstAirItem(payload)['passengers'] as Json[])[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    passenger['id'] = 'ProviderInventedId';

    const result = run(payload);
    expect(result.priced).toHaveLength(0);
    expect(codes(result.warnings)).toContain('passenger-binding-invalid');
  });

  it('si falta uno de los requestedTravelerIndex la oferta falla cerrada', () => {
    const result = run(clone(onewayFixture), {
      requestedTravelers: requestedTravelers(['ADT', 'ADT']),
    });
    expect(result.priced).toHaveLength(0);
    expect(codes(result.warnings)).toContain('passenger-binding-invalid');
  });

  it('el reorder de passengerOffer no cambia el binding: vuelve ordenado por índice explícito', () => {
    const payload = clone(multipaxFixture) as Json;
    const passengers = firstAirItem(payload)['passengers'] as Json[];
    passengers.reverse();

    const { handles } = onlyPriced(
      run(payload, { requestedTravelers: requestedTravelers(['ADT', 'ADT']) }),
    );
    expect(handles.passengerBindings.map((binding) => binding.pricePassengerId)).toEqual([
      'Passenger1',
      'Passenger2',
    ]);
  });

  it('ADT+CNN produce dos offerItems y dos entradas de desglose (RF-07 CA-2)', () => {
    // Sintético, derivado del ejemplo oficial de ida: no hay ejemplo oficial multi-PTC. La forma
    // —un `offerItem` por tipo de pasajero— es la que fijan los scripts de WF-18 de la colección
    // (docs/sabre/03 §2.5).
    const payload = clone(onewayFixture) as Json;
    const adult = firstAirItem(payload);
    const child = clone(adult);
    child['id'] = 'dd07bbd7fb57c88nclq1qixyj3-1-2';
    const childPassengers = child['passengers'] as Json[];
    const childPax = childPassengers[0];
    if (childPax === undefined) throw new Error('fixture sin pasajeros');
    childPax['id'] = 'Passenger2';
    childPax['ptc'] = 'CNN';
    childPax['requestedPtc'] = 'CNN';
    (childPax['price'] as Json)['baseAmount'] = { amount: '72.55', curCode: 'USD' };
    (childPax['price'] as Json)['totalAmount'] = { amount: '94.71', curCode: 'USD' };
    firstOffer(payload)['offerItems'] = [adult, child];
    (firstOffer(payload)['totalPrice'] as Json)['totalAmount'] = {
      amount: '213.61',
      curCode: 'USD',
    };

    const { offer, handles } = onlyPriced(
      run(payload, { requestedTravelers: requestedTravelers(['ADT', 'CHD']) }),
    );
    expect(handles.offerItemIds).toEqual([
      'dd07bbd7fb57c88nclq1qixyj3-1-1',
      'dd07bbd7fb57c88nclq1qixyj3-1-2',
    ]);
    expect(handles.passengerIds).toEqual(['Passenger1', 'Passenger2']);
    expect(offer.fareBreakdown).toEqual([
      {
        paxType: 'ADT',
        paxCount: 1,
        basePerPax: { amountMinor: 9674, currency: 'USD' },
        taxesPerPax: { amountMinor: 2216, currency: 'USD' },
      },
      {
        paxType: 'CHD',
        paxCount: 1,
        basePerPax: { amountMinor: 7255, currency: 'USD' },
        taxesPerPax: { amountMinor: 2216, currency: 'USD' },
      },
    ]);
  });

  it('un PTC tarificado distinto del pedido se avisa: es un cambio de precio silencioso', () => {
    const payload = clone(onewayFixture) as Json;
    const passengers = firstAirItem(payload)['passengers'] as Json[];
    const passenger = passengers[0];
    if (passenger === undefined) throw new Error('fixture sin pasajeros');
    passenger['requestedPtc'] = 'CNN';

    const result = run(payload);
    const warning = result.warnings.find((entry) => entry.code === 'ptc-repriced');
    expect(warning?.detail).toBe('CNN->ADT');
  });

  it('un Service opcional se avisa pero nunca entra en selectedOfferItems', () => {
    // Sintético: la forma es la de `ServiceOfferItem` (`:556-598`). El item existe en el contrato
    // de price aunque ningún ejemplo oficial lo traiga.
    const payload = clone(onewayFixture) as Json;
    const offer = firstOffer(payload);
    (offer['offerItems'] as Json[]).push({
      type: 'Service',
      id: 'dd07bbd7fb57c88nclq1qixyj3-1-2',
      mandatoryInd: false,
      passengerRefs: ['Passenger1'],
      segmentRefs: ['Isgm0a0067c77c814'],
      serviceDefinition: {},
      price: { totalAmount: { amount: '30.00', curCode: 'USD' } },
    });

    const result = run(payload);
    const { handles } = onlyPriced(result);
    expect(codes(result.warnings)).toContain('service-offer-item-not-mapped');
    expect(handles.offerItemIds).toEqual(['dd07bbd7fb57c88nclq1qixyj3-1-1']);
  });

  it('un Service obligatorio falla cerrado: no se omite ni se reserva como vuelo', () => {
    const payload = clone(onewayFixture) as Json;
    const offer = firstOffer(payload);
    (offer['offerItems'] as Json[]).push({
      type: 'Service',
      id: 'dd07bbd7fb57c88nclq1qixyj3-1-2',
      mandatoryInd: true,
      passengerRefs: ['Passenger1'],
      segmentRefs: ['Isgm0a0067c77c814'],
      serviceDefinition: {},
      price: { totalAmount: { amount: '30.00', curCode: 'USD' } },
    });

    const result = run(payload);
    expect(result.priced).toHaveLength(0);
    expect(result.warnings).toContainEqual({
      code: 'offer-invalid',
      path: 'response.offers[0].offerItems[1]',
      detail: 'mandatory-item-not-air',
    });
  });

  it('un Air opcional tampoco aporta offerItemId ni passengerId a los handles', () => {
    const payload = clone(onewayFixture) as Json;
    const optional = clone(firstAirItem(payload));
    optional['id'] = 'dd07bbd7fb57c88nclq1qixyj3-1-2';
    optional['mandatoryInd'] = false;
    const passengers = optional['passengers'] as Json[];
    const passenger = passengers[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero opcional');
    passenger['id'] = 'OptionalPassenger';
    (firstOffer(payload)['offerItems'] as Json[]).push(optional);

    const { handles } = onlyPriced(run(payload));
    expect(handles.offerItemIds).toEqual(['dd07bbd7fb57c88nclq1qixyj3-1-1']);
    expect(handles.passengerIds).toEqual(['Passenger1']);
  });

  it('un `type` desconocido se avisa sin tumbar la oferta', () => {
    const payload = clone(onewayFixture) as Json;
    (firstOffer(payload)['offerItems'] as Json[]).push({ type: 'Insurance', id: 'x-1-2' });
    const result = run(payload);
    expect(codes(result.warnings)).toContain('offer-item-type-unknown');
    expect(result.priced).toHaveLength(1);
  });
});

describe('el itinerario se arrastra de la búsqueda y no se reinventa', () => {
  it('con oferta de referencia, la revalidada conserva sus segmentos', () => {
    const basis = basisOffer();
    const { offer } = onlyPriced(run(clone(onewayFixture), { basis }));
    expect(offer.itineraries).toEqual(basis.itineraries);
  });

  it('reemplaza la identidad de shop por la confirmada y marca el cambio aunque el total sea igual', () => {
    const basis = basisOffer({
      fareComponents: [
        {
          segmentRefs: [0],
          brand: { code: 'BASIC', name: 'Basic', programCode: 'AVW' },
          fareBasisCode: 'BASIC1',
          bookingClasses: ['B'],
          origin: 'JFK',
          destination: 'SFO',
          cabin: 'economy',
        },
      ],
    });
    const result = run(clone(onewayFixture), { basis });
    const { offer, fareIdentityChanged, priceChange } = onlyPriced(result);

    expect(offer.fareComponents).toEqual([
      {
        fareBasisCode: 'OVAHZSBX',
        bookingClasses: ['B'],
        segmentRefs: [0],
        origin: 'JFK',
        destination: 'SFO',
        cabin: 'economy',
      },
    ]);
    expect(priceChange.kind).toBe('unchanged');
    expect(fareIdentityChanged).toBe(true);
    expect(result.priceChanged).toBe(true);
    expect(codes(result.warnings)).toContain('fare-identity-changed');
  });

  it('misma identidad real no dispara una aceptación de cambio', () => {
    const basis = basisOffer({
      fareComponents: [
        {
          fareBasisCode: 'OVAHZSBX',
          bookingClasses: ['B'],
          segmentRefs: [0],
          origin: 'JFK',
          destination: 'SFO',
          cabin: 'economy',
        },
      ],
    });
    const result = run(clone(onewayFixture), { basis });
    expect(onlyPriced(result).fareIdentityChanged).toBe(false);
    expect(result.priceChanged).toBe(false);
  });

  it('la cabina forma parte de la identidad: un cambio sólo de cabin también se detecta', () => {
    const basis = basisOffer({
      fareComponents: [
        {
          fareBasisCode: 'OVAHZSBX',
          bookingClasses: ['B'],
          segmentRefs: [0],
          origin: 'JFK',
          destination: 'SFO',
          cabin: 'business',
        },
      ],
    });
    const result = run(clone(onewayFixture), { basis });
    expect(onlyPriced(result).fareIdentityChanged).toBe(true);
    expect(result.priceChanged).toBe(true);
  });

  it('mapea marca y programa desde passengerOffer, no desde la búsqueda', () => {
    const payload = clone(onewayFixture) as Json;
    const passenger = (firstAirItem(payload)['passengers'] as Json[])[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    const component = (passenger['fareComponents'] as Json[])[0];
    if (component === undefined) throw new Error('fixture sin componente');
    component['brand'] = {
      code: 'ECONFLEX',
      brandName: 'Economy Flex',
      programCode: 'CFFBA',
      programID: 12345,
    };

    const { offer } = onlyPriced(run(payload, { basis: basisOffer() }));
    expect(offer.fareComponents?.[0]?.brand).toEqual({
      code: 'ECONFLEX',
      name: 'Economy Flex',
      programCode: 'CFFBA',
      programId: 12345,
    });
    expect(offer.fareFamily).toEqual({ name: 'Economy Flex', cabin: 'economy' });
  });

  it('si price omite fareComponents no conserva silenciosamente los de shop', () => {
    const payload = clone(onewayFixture) as Json;
    const passenger = (firstAirItem(payload)['passengers'] as Json[])[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    delete passenger['fareComponents'];

    const result = run(payload, {
      basis: basisOffer({
        fareComponents: [{ fareBasisCode: 'OLD', bookingClasses: ['B'], segmentRefs: [0] }],
      }),
    });
    expect(result.priced).toHaveLength(0);
    expect(codes(result.warnings)).toContain('fare-components-unavailable');
  });

  it('un segmento de price que no coincide de forma única con el itinerario falla cerrado', () => {
    const payload = clone(onewayFixture) as Json;
    const passenger = (firstAirItem(payload)['passengers'] as Json[])[0];
    if (passenger === undefined) throw new Error('fixture sin pasajero');
    const component = (passenger['fareComponents'] as Json[])[0];
    if (component === undefined) throw new Error('fixture sin componente');
    const responseSegment = (component['segments'] as Json[])[0];
    if (responseSegment === undefined) throw new Error('fixture sin segmento');
    responseSegment['flightNumber'] = '999';

    const result = run(payload, { basis: basisOffer() });
    expect(result.priced).toHaveLength(0);
    expect(codes(result.warnings)).toContain('fare-component-unmapped');
  });

  it('sin oferta de referencia sale SIN itinerario, no con uno a medias', () => {
    // Los segmentos de price traen `"2024-02-11T06:00:00"`, sin offset de zona, y
    // `SegmentSchema.departureAt` exige ISO con offset. Inventar la zona es inventar la hora.
    const { offer } = onlyPriced(run(clone(onewayFixture)));
    expect(offer.itineraries).toBeUndefined();
    expect(JSON.stringify(offer)).not.toContain('2024-02-11T06:00:00');
  });

  it('conserva los ids del shop para poder conciliar la orden con la búsqueda', () => {
    const { offer } = onlyPriced(run(clone(onewayFixture), { basis: basisOffer() }));
    expect(offer.provider.raw?.[SABRE_RAW_KEYS.shopOfferItemIds]).toEqual([
      'dd07bbd7fb57c88nclq1qixyj3-1-1',
    ]);
  });
});

describe('vencimiento', () => {
  it('una fecha sin offset cae al respaldo de TTL y lo avisa', () => {
    const payload = clone(onewayFixture) as Json;
    firstOffer(payload)['offerExpirationDateTime'] = '2024-12-12T03:00:23';

    const result = run(payload);
    expect(codes(result.warnings)).toContain('expiration-datetime-unparseable');
    // `fetchedAt` + 1.200 s. Sigue siendo dato del proveedor: `ttl` es obligatorio por contrato.
    expect(onlyPriced(result).offer.expiresAt).toBe('2024-12-12T03:05:00.000Z');
    expect(onlyPriced(result).offer.expiresAtSource).toBe('provider');
  });

  it('una oferta que llega ya vencida se avisa, pero se mapea igual', () => {
    // Vencer no borra el precio: Sabre dice qué hacer —volver a llamar a offers/price— y quien
    // decide es el caso de uso, no el mapper.
    const result = run(clone(onewayFixture), { fetchedAt: '2024-12-12T04:00:00.000Z' });
    expect(codes(result.warnings)).toContain('offer-already-expired');
    expect(result.priced).toHaveLength(1);
  });

  it('resolveSabrePriceExpiry prefiere la fecha declarada y sólo cae al ttl si no la hay', () => {
    expect(
      resolveSabrePriceExpiry(
        { offerExpirationDateTime: '2024-12-12T03:00:23Z', ttl: 1200 },
        FETCHED_AT,
      ),
    ).toEqual({ expiresAt: '2024-12-12T03:00:23.000Z', from: 'offerExpirationDateTime' });

    expect(
      resolveSabrePriceExpiry({ offerExpirationDateTime: 'mañana', ttl: 1200 }, FETCHED_AT),
    ).toEqual({ expiresAt: '2024-12-12T03:05:00.000Z', from: 'ttl' });

    expect(
      resolveSabrePriceExpiry({ offerExpirationDateTime: 'mañana', ttl: 0 }, FETCHED_AT),
    ).toBeNull();
  });

  it('un `paymentTimeLimitText` que no parece una fecha se descarta con aviso', () => {
    const payload = clone(onewayFixture) as Json;
    firstOffer(payload)['paymentTimeLimitText'] = 'CALL AGENCY BEFORE DEPARTURE — MR SMITH';

    const result = run(payload);
    expect(codes(result.warnings)).toContain('time-limit-text-discarded');
    expect(onlyPriced(result).handles.paymentTimeLimitText).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SMITH');
  });
});
