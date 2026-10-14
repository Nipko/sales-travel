import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AncillaryCatalogSchema,
  AncillaryOfferSchema,
  type AncillaryOffer,
  type PaxType,
} from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  SabreAncillaryMappingError,
  SabreAncillaryPassengerMismatchError,
  SabreAncillaryRejectedError,
  mapSabreAncillaryShopResponse,
  parseSabreAncillaryOfferRef,
  type SabreAncillaryShopMapResult,
} from './shop.response.mapper';

/**
 * EL CATÁLOGO DE ANCILLARES CONTRA EL CONTRATO.
 *
 * La spec de Stateless Ancillaries 1.0 no trae ejemplos de respuesta completos, así que el fixture
 * `__fixtures__/stateless-ancillaries-shop-pnr-200.derived.json` está ARMADO a partir de ella y lo
 * dice en el nombre (`.derived`). De dónde sale cada pieza:
 *
 * - Segmento BOS-SFO X0 133, pasajero `TEST MR SABRE` `01.01` y la oferta
 *   `b891aae1-836f-447e-ae2c-16d64d9c76e2`: los ejemplos de `/shop` de
 *   `help/stateless-ancillaries-api-1.0/1.0-index.txt` (modo payload y modo recurso).
 * - Ítem `-3` y su servicio `GTS` («GDS TICKET SERVICE FEE», 50.00 USD como número): el ejemplo de
 *   `/add` de la misma página, que es la única oferta de ancillary completa que publica Sabre.
 * - Lo demás (vuelta SFO-BOS, niño `CNN`, maletas, comida, sala, mascota, bicicleta, asiento):
 *   derivado del schema y de los `example` por propiedad (`groupCode 'BG'`, `subCode`,
 *   `freeOfChargeRules`, `isDisplayOnly`, `bookingMethod`, `specialService.type`,
 *   `requiredProperties`, `weights`, `unitPrices[].passengerReferenceIds`, `:349-1908`).
 * - Los segmentos vienen en orden inverso y con `bookingFlightNumber: '0134'` a propósito: el
 *   mapper ordena por `sequence` y normaliza el número.
 *
 * Ningún test llama a Sabre.
 */

type Json = Record<string, unknown>;

const PNR = 'SXZRGJ';
const ADT_CHD: readonly { paxType: PaxType }[] = [{ paxType: 'ADT' }, { paxType: 'CHD' }];

function shop(): Json {
  return JSON.parse(
    readFileSync(
      join(__dirname, '..', '__fixtures__', 'stateless-ancillaries-shop-pnr-200.derived.json'),
      'utf8',
    ),
  ) as Json;
}

function map(
  raw: unknown = shop(),
  passengers: readonly { paxType: PaxType }[] = ADT_CHD,
  pnrLocator = PNR,
): SabreAncillaryShopMapResult {
  return mapSabreAncillaryShopResponse(raw, { pnrLocator, passengers });
}

function items(raw: Json): Json[] {
  return (raw['offers'] as Json[])[0]!['items'] as Json[];
}

function ancillaries(raw: Json): Json[] {
  return raw['ancillaries'] as Json[];
}

function byCode(result: SabreAncillaryShopMapResult, code: string): AncillaryOffer[] {
  return result.catalog.offers.filter((offer) => offer.serviceCode === code);
}

function only(result: SabreAncillaryShopMapResult, code: string): AncillaryOffer {
  const found = byCode(result, code);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('mapSabreAncillaryShopResponse — el fixture derivado de la spec', () => {
  it('ordena los tramos por sequence y normaliza el número de vuelo', () => {
    expect(map().catalog.segments).toEqual([
      {
        origin: 'BOS',
        destination: 'SFO',
        departureAt: '2024-07-09T06:00:00',
        carrier: 'X0',
        flightNumber: '133',
      },
      {
        origin: 'SFO',
        destination: 'BOS',
        departureAt: '2024-07-16T10:00:00',
        carrier: 'X0',
        flightNumber: '134',
      },
    ]);
  });

  it('cada ítem de ancillary llega al catálogo con su servicio, tramos, pasajeros y precio', () => {
    const offers = map().catalog.offers;
    expect(
      offers.map((offer) => ({
        code: offer.serviceCode,
        category: offer.category,
        segments: offer.segmentRefs,
        sellable: offer.sellable,
        reason: offer.notSellableReason,
      })),
    ).toEqual([
      { code: '0CC', category: 'BAGGAGE', segments: [0], sellable: true, reason: undefined },
      { code: '0CC', category: 'BAGGAGE', segments: [1], sellable: true, reason: undefined },
      { code: 'GTS', category: 'FEE', segments: [0], sellable: true, reason: undefined },
      { code: '0GO', category: 'BAGGAGE', segments: [0], sellable: true, reason: undefined },
      { code: '0B3', category: 'MEAL', segments: [0, 1], sellable: true, reason: undefined },
      { code: '0BX', category: 'LOUNGE', segments: [0], sellable: false, reason: 'DISPLAY_ONLY' },
      { code: '0BS', category: 'PET', segments: [0], sellable: false, reason: 'CONTACT_AIRLINE' },
      {
        code: '0EG',
        category: 'BAGGAGE',
        segments: [0],
        sellable: false,
        reason: 'REQUIRES_DETAILS',
      },
      {
        code: '0CD',
        category: 'BAGGAGE',
        segments: [0],
        sellable: false,
        reason: 'PRICE_NOT_INFORMED',
      },
    ]);
  });

  it('precio en unidades menores y por pasajero; un unitPrice sin pasajeros aplica a todos', () => {
    const [outbound, inbound] = byCode(map(), '0CC');
    expect(outbound?.passengers).toEqual([
      {
        passengerIndex: 0,
        charge: { type: 'PRICED', price: { amountMinor: 3500, currency: 'USD' } },
      },
      {
        passengerIndex: 1,
        charge: { type: 'PRICED', price: { amountMinor: 3500, currency: 'USD' } },
      },
    ]);
    expect(inbound?.passengers).toEqual([
      {
        passengerIndex: 0,
        charge: { type: 'PRICED', price: { amountMinor: 3500, currency: 'USD' } },
      },
      {
        passengerIndex: 1,
        charge: { type: 'PRICED', price: { amountMinor: 2625, currency: 'USD' } },
      },
    ]);
  });

  it('el importe como número JSON (ejemplo de la ayuda) también se lee exacto', () => {
    expect(only(map(), 'GTS').passengers).toEqual([
      {
        passengerIndex: 0,
        charge: { type: 'PRICED', price: { amountMinor: 5000, currency: 'USD' } },
      },
    ]);
  });

  it('servicio sin precio = incluido, y se puede agregar sin cargo', () => {
    const carryOn = only(map(), '0GO');
    expect(carryOn.passengers.map((entry) => entry.charge)).toEqual([
      { type: 'INCLUDED' },
      { type: 'INCLUDED' },
    ]);
    expect(carryOn.sellable).toBe(true);
    expect(carryOn.refundable).toBe(true);
  });

  it('el precio ilegible queda «no informado» y no se vende', () => {
    const secondBag = only(map(), '0CD');
    expect(secondBag.passengers).toEqual([{ passengerIndex: 0, charge: { type: 'NOT_INFORMED' } }]);
    expect(secondBag.notSellableReason).toBe('PRICE_NOT_INFORMED');
  });

  it('nombre comercial, cantidad, pesos y reembolso', () => {
    const bag = byCode(map(), '0CC')[0]!;
    expect(bag).toMatchObject({
      name: 'FIRST BAG UP TO 23KG',
      airlineCode: 'X0',
      quantity: 1,
      weights: [
        { value: 23, unit: 'KG' },
        { value: 50, unit: 'LB' },
      ],
      refundable: false,
    });
    expect(only(map(), 'GTS').refundable).toBeUndefined();
  });

  it('avisa de lo que descarta: asiento, precio ilegible e ítem de vuelo', () => {
    const result = map();
    expect(result.catalog.warnings).toEqual([
      'seat-ancillary-skipped',
      'ancillary-price-undetermined',
      'offer-item-not-ancillary',
    ]);
    expect(result.warnings.find((w) => w.code === 'offer-item-not-ancillary')?.detail).toBe(
      'AirOfferItem',
    );
    expect(byCode(result, '0B5')).toEqual([]);
  });

  it('el catálogo cumple el canónico', () => {
    expect(AncillaryCatalogSchema.safeParse(map().catalog).success).toBe(true);
  });
});

describe('mapSabreAncillaryShopResponse — identidad de la oferta', () => {
  it('serviceOfferItemId es opaco, versionado, único y estable entre consultas', () => {
    const first = map();
    const ids = first.catalog.offers.map((offer) => offer.serviceOfferItemId);
    for (const id of ids) expect(id).toMatch(/^SA1\.[0-9a-f]{24}\.[0-9a-f]{24}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(map().catalog.offers.map((offer) => offer.serviceOfferItemId)).toEqual(ids);
  });

  it('no depende de los ids de Sabre: otra oferta con otros UUID da las mismas identidades', () => {
    const raw = shop();
    const offer = (raw['offers'] as Json[])[0]!;
    offer['id'] = '00000000-0000-4000-8000-000000000000';
    items(raw).forEach((item, index) => {
      item['id'] = `00000000-0000-4000-8000-000000000000-${String(index + 1)}`;
    });
    expect(map(raw).catalog.offers.map((o) => o.serviceOfferItemId)).toEqual(
      map().catalog.offers.map((o) => o.serviceOfferItemId),
    );
  });

  it('otro precio cambia la parte con precio y conserva la identidad sin precio', () => {
    const raw = shop();
    const price = items(raw)[0]!['price'] as Json;
    ((price['unitPrices'] as Json[])[0]!['total'] as Json)['amount'] = {
      amount: '40.00',
      currencyCode: 'USD',
    };
    const before = parseSabreAncillaryOfferRef(map().catalog.offers[0]!.serviceOfferItemId)!;
    const after = parseSabreAncillaryOfferRef(map(raw).catalog.offers[0]!.serviceOfferItemId)!;
    expect(after.semantic).toBe(before.semantic);
    expect(after.priced).not.toBe(before.priced);
    expect(map(raw).semanticDigests.has(before.semantic)).toBe(true);
  });

  it('la identidad está atada al PNR: la misma oferta en otra reserva es otra', () => {
    const here = map().catalog.offers[0]!.serviceOfferItemId;
    const there = map(shop(), ADT_CHD, 'ABC123').catalog.offers[0]!.serviceOfferItemId;
    expect(parseSabreAncillaryOfferRef(there)!.semantic).not.toBe(
      parseSabreAncillaryOfferRef(here)!.semantic,
    );
  });

  it('parseSabreAncillaryOfferRef rechaza lo que no escribió', () => {
    expect(parseSabreAncillaryOfferRef('b891aae1-836f-447e-ae2c-16d64d9c76e2-1')).toBeUndefined();
    expect(parseSabreAncillaryOfferRef('SA1.zz.yy')).toBeUndefined();
  });

  it('dos ítems que describen la misma compra al mismo precio: se queda el primero', () => {
    const raw = shop();
    const list = items(raw);
    list.push({ ...structuredClone(list[0]!), id: 'b891aae1-836f-447e-ae2c-16d64d9c76e2-99' });
    const result = map(raw);
    expect(byCode(result, '0CC')).toHaveLength(2);
    expect(result.catalog.warnings).toContain('offer-item-duplicate');
  });
});

describe('mapSabreAncillaryShopResponse — pasajeros', () => {
  it('los nombres, SSR y viajero frecuente no pasan del mapper', () => {
    const result = map();
    const text = JSON.stringify({
      catalog: result.catalog,
      snapshot: result.snapshot,
      bindings: [...result.bindings.values()].map((binding) => ({
        ...binding,
        passengerRefByIndex: [...binding.passengerRefByIndex],
        unitPriceByIndex: [...binding.unitPriceByIndex],
      })),
    });
    for (const value of ['TEST MR', 'JUNIOR MSTR', 'givenName', '987654321', 'WCHR', 'GLD']) {
      expect(text).not.toContain(value);
    }
    expect(result.snapshot.passengers).toEqual([
      { id: 'PAX-1', nameNumber: '01.01', typeCode: 'ADT' },
      { id: 'PAX-2', nameNumber: '02.01', typeCode: 'CNN' },
    ]);
  });

  it('se cruzan por nameNumber, no por el orden en que llegan', () => {
    const raw = shop();
    (raw['passengers'] as Json[]).reverse();
    const inbound = byCode(map(raw), '0CC')[1]!;
    expect(inbound.passengers.map((entry) => entry.charge)).toEqual([
      { type: 'PRICED', price: { amountMinor: 3500, currency: 'USD' } },
      { type: 'PRICED', price: { amountMinor: 2625, currency: 'USD' } },
    ]);
  });

  it('otra cantidad de pasajeros que la orden: se lanza, no se adivina', () => {
    const error = thrown(() => map(shop(), [{ paxType: 'ADT' }]));
    expect(error).toBeInstanceOf(SabreAncillaryPassengerMismatchError);
    expect((error as SabreAncillaryPassengerMismatchError).detail).toEqual({
      expectedCount: 1,
      receivedCount: 2,
    });
  });

  it('un tipo que no casa en la misma posición: se lanza', () => {
    const error = thrown(() => map(shop(), [{ paxType: 'ADT' }, { paxType: 'ADT' }]));
    expect(error).toBeInstanceOf(SabreAncillaryPassengerMismatchError);
    expect((error as SabreAncillaryPassengerMismatchError).reason).toBe('type');
    expect((error as SabreAncillaryPassengerMismatchError).detail.position).toBe(1);
  });

  it('niño C05 e infante INF/INS casan con CHD e INF', () => {
    const raw = shop();
    const passengers = raw['passengers'] as Json[];
    passengers[1]!['typeCode'] = 'C05';
    passengers.push({ id: 'PAX-3', nameNumber: '03.01', typeCode: 'INS' });
    expect(() =>
      map(raw, [{ paxType: 'ADT' }, { paxType: 'CHD' }, { paxType: 'INF' }]),
    ).not.toThrow();
  });

  it('sin typeCode el cruce queda por posición y se avisa', () => {
    const raw = shop();
    for (const pax of raw['passengers'] as Json[]) delete pax['typeCode'];
    expect(map(raw).catalog.warnings).toContain('passenger-type-unverified');
  });

  it('un pasajero desconocido en un ítem se omite; si no queda ninguno, el ítem se descarta', () => {
    const raw = shop();
    const list = items(raw);
    list[0]!['passengerReferenceIds'] = ['PAX-1', 'PAX-9'];
    list[2]!['passengerReferenceIds'] = ['PAX-9'];
    const result = map(raw);
    expect(byCode(result, '0CC')[0]!.passengers.map((p) => p.passengerIndex)).toEqual([0]);
    expect(byCode(result, 'GTS')).toEqual([]);
    expect(result.catalog.warnings).toEqual(
      expect.arrayContaining(['offer-item-passenger-unknown', 'offer-item-passenger-unresolved']),
    );
  });

  it('un ítem sin passengerReferenceIds no se atribuye a nadie', () => {
    const raw = shop();
    delete items(raw)[2]!['passengerReferenceIds'];
    const result = map(raw);
    expect(byCode(result, 'GTS')).toEqual([]);
    expect(result.catalog.warnings).toContain('offer-item-passenger-unresolved');
  });

  it('pasajeros con id o nameNumber repetido rompen las referencias: se rechaza', () => {
    const raw = shop();
    (raw['passengers'] as Json[])[1]!['nameNumber'] = '01.01';
    expect(thrown(() => map(raw))).toBeInstanceOf(SabreAncillaryMappingError);
  });
});

describe('mapSabreAncillaryShopResponse — precio', () => {
  function withPrice(price: unknown): SabreAncillaryShopMapResult {
    const raw = shop();
    items(raw)[2]!['price'] = price;
    return map(raw);
  }

  it('`price` presente sin unitPrices no es «incluido»: es no informado', () => {
    const fee = only(withPrice({}), 'GTS');
    expect(fee.passengers[0]!.charge).toEqual({ type: 'NOT_INFORMED' });
    expect(fee.notSellableReason).toBe('PRICE_NOT_INFORMED');
  });

  it.each([
    ['negativo', '-5.00', 'USD'],
    ['tercer decimal', '50.005', 'USD'],
    ['vacío', '', 'USD'],
    ['sin moneda válida', '50.00', 'US'],
    ['texto', 'gratis', 'USD'],
  ])('%s → no informado, nunca gratis', (_label, amount, currencyCode) => {
    const fee = only(
      withPrice({ unitPrices: [{ total: { amount: { amount, currencyCode } } }] }),
      'GTS',
    );
    expect(fee.passengers[0]!.charge).toEqual({ type: 'NOT_INFORMED' });
    expect(fee.sellable).toBe(false);
  });

  it.each([
    ['35', 3500],
    ['35.5', 3550],
    ['0.00', 0],
    ['19.990', 1999],
  ])('importe %s → %d unidades menores', (amount, minor) => {
    const fee = only(
      withPrice({ unitPrices: [{ total: { amount: { amount, currencyCode: ' usd ' } } }] }),
      'GTS',
    );
    expect(fee.passengers[0]!.charge).toEqual({
      type: 'PRICED',
      price: { amountMinor: minor, currency: 'USD' },
    });
  });

  it('un número con coma flotante se convierte sin error de redondeo', () => {
    const fee = only(
      withPrice({ unitPrices: [{ total: { amount: { amount: 19.99, currencyCode: 'USD' } } }] }),
      'GTS',
    );
    expect(fee.passengers[0]!.charge).toEqual({
      type: 'PRICED',
      price: { amountMinor: 1999, currency: 'USD' },
    });
  });

  it('dos unitPrices sin pasajeros son ambiguos', () => {
    const unit = { total: { amount: { amount: '50.00', currencyCode: 'USD' } } };
    expect(only(withPrice({ unitPrices: [unit, unit] }), 'GTS').passengers[0]!.charge).toEqual({
      type: 'NOT_INFORMED',
    });
  });

  it('un unitPrice sólo para otro pasajero deja a éste sin precio', () => {
    const raw = shop();
    const inbound = items(raw)[1]!;
    (inbound['price'] as Json)['unitPrices'] = [
      {
        total: { amount: { amount: '35.00', currencyCode: 'USD' } },
        passengerReferenceIds: ['PAX-1'],
      },
    ];
    const offer = byCode(map(raw), '0CC')[1]!;
    expect(offer.passengers.map((entry) => entry.charge.type)).toEqual(['PRICED', 'NOT_INFORMED']);
    expect(offer.sellable).toBe(false);
  });

  it('sin precio y sin regla de cargo cero: incluido, con aviso', () => {
    const raw = shop();
    delete items(raw)[2]!['price'];
    const result = map(raw);
    expect(only(result, 'GTS').passengers[0]!.charge).toEqual({ type: 'INCLUDED' });
    expect(result.catalog.warnings).toContain('included-without-free-of-charge-rule');
  });
});

describe('mapSabreAncillaryShopResponse — venta por código', () => {
  function withAncillary(patch: Json, code = 'GTS'): AncillaryOffer {
    const raw = shop();
    const target = ancillaries(raw).find((a) => a['subCode'] === code)!;
    Object.assign(target, patch);
    return only(map(raw), code);
  }

  it.each([
    [{ bookingMethod: { value: 'NoBookingRequired' } }, 'NO_BOOKING_REQUIRED'],
    [{ bundledAncillaryRefs: ['12', '24'] }, 'UNSUPPORTED'],
    [{ specialService: { code: 'PETC', type: 'Structured' } }, 'REQUIRES_DETAILS'],
    [{ specialService: { code: 'PETC', requiredProperties: { nope: true } } }, 'REQUIRES_DETAILS'],
  ])('%j → %s', (patch, reason) => {
    expect(withAncillary(patch).notSellableReason).toBe(reason);
  });

  it('propiedades todas opcionales no impiden la venta', () => {
    const offer = withAncillary({
      specialService: {
        code: 'PETC',
        type: 'Optional',
        requiredProperties: {
          propertyDefinitions: [
            { name: 'WEIGHT', type: 'Int', isOptional: true, allowedValues: ['1'] },
          ],
        },
      },
    });
    expect(offer.sellable).toBe(true);
  });

  it('isAvailable: true es «el pasajero ya lo tiene»: se muestra y no se vende otra vez', () => {
    // El `/add` de la ayuda de Sabre agrega un ítem con `isAvailable: false`: `false` es lo normal
    // en lo que se compra, y `true` («exists and is available to consume», `:1870-1873`) es lo que
    // ya está en la reserva.
    const raw = shop();
    const gts = ancillaries(raw).find((a) => a['subCode'] === 'GTS')!['id'];
    const target = items(raw).filter(
      (entry) => (entry['details'] as Json)['ancillaryReferenceId'] === gts,
    );
    expect(target).toHaveLength(1);
    (target[0]!['details'] as Json)['isAvailable'] = true;
    const offer = only(map(raw), 'GTS');
    expect(offer.sellable).toBe(false);
    expect(offer.notSellableReason).toBe('NO_BOOKING_REQUIRED');
    expect(only(map(), 'GTS').sellable).toBe(true);
  });

  it('isDisplayOnly gana sobre cualquier otro motivo', () => {
    expect(
      withAncillary({ isDisplayOnly: true, bookingMethod: { value: 'ContactAirline' } })
        .notSellableReason,
    ).toBe('DISPLAY_ONLY');
  });

  it('la categoría sale del grupo y del RFIC, no del nombre', () => {
    expect(withAncillary({ groupCode: 'ZZ', commercialName: 'EXTRA BAGGAGE' }).category).toBe(
      'FEE',
    );
    expect(withAncillary({ groupCode: 'ZZ', reasonForIssuanceCode: 'C' }).category).toBe('BAGGAGE');
    expect(withAncillary({ groupCode: 'ZZ', reasonForIssuanceCode: 'G' }).category).toBe('OTHER');
    expect(withAncillary({ groupCode: undefined, reasonForIssuanceCode: undefined }).category).toBe(
      'OTHER',
    );
  });

  it('un nombre comercial con forma de número largo no se muestra: cae al nombre del grupo', () => {
    expect(withAncillary({ commercialName: 'FEE 4111111111111111' }).name).toBe(
      'MISCELLANEOUS FEES',
    );
    expect(withAncillary({ commercialName: undefined, groupName: undefined }).name).toBe('GTS');
  });

  it('una definición rota se descarta y sus ítems se quedan sin servicio', () => {
    const raw = shop();
    ancillaries(raw).find((a) => a['subCode'] === 'GTS')!['subCode'] = 'gts!';
    const result = map(raw);
    expect(result.catalog.offers.some((o) => o.name === 'GDS TICKET SERVICE FEE')).toBe(false);
    expect(result.catalog.warnings).toEqual(
      expect.arrayContaining(['ancillary-invalid', 'offer-item-ancillary-missing']),
    );
  });

  it('definición repetida: gana la primera', () => {
    const raw = shop();
    ancillaries(raw).push({ ...ancillaries(raw)[1]!, commercialName: 'OTRA' });
    const result = map(raw);
    expect(only(result, 'GTS').name).toBe('GDS TICKET SERVICE FEE');
    expect(result.catalog.warnings).toContain('ancillary-duplicate');
  });

  it('cantidad cero o negativa: el ítem no tiene sentido y se descarta', () => {
    const raw = shop();
    (items(raw)[2]!['details'] as Json)['quantity'] = 0;
    const result = map(raw);
    expect(byCode(result, 'GTS')).toEqual([]);
    expect(result.catalog.warnings).toContain('offer-item-quantity-invalid');
  });

  it('sin quantity cuenta como una unidad', () => {
    const raw = shop();
    delete (items(raw)[2]!['details'] as Json)['quantity'];
    expect(only(map(raw), 'GTS').quantity).toBe(1);
  });
});

describe('mapSabreAncillaryShopResponse — tramos', () => {
  it('un segmento desconocido invalida el ítem: no se vende «para algunos tramos»', () => {
    const raw = shop();
    items(raw)[0]!['segmentReferenceIds'] = ['SEG-1', 'SEG-9'];
    const result = map(raw);
    expect(byCode(result, '0CC').map((o) => o.segmentRefs)).toEqual([[1]]);
    expect(result.catalog.warnings).toContain('offer-item-segment-unresolved');
  });

  it('una parte de itinerario desconocida tampoco se resuelve', () => {
    const raw = shop();
    items(raw)[3]!['itineraryPartReferenceIds'] = ['IP-9'];
    expect(byCode(map(raw), '0GO')).toEqual([]);
  });

  it('un itinerario que no es el de la respuesta no se resuelve', () => {
    const raw = shop();
    items(raw)[4]!['itineraryReferenceId'] = 'I-2';
    expect(byCode(map(raw), '0B3')).toEqual([]);
  });

  it('una parte de itinerario rota se descarta con aviso', () => {
    const raw = shop();
    (raw['itineraryParts'] as Json[]).push({ id: 'X', segmentReferenceIds: [] });
    expect(map(raw).catalog.warnings).toContain('itinerary-part-invalid');
  });

  it('sin sequence completo: el orden de llegada, con aviso', () => {
    const raw = shop();
    delete (raw['segments'] as Json[])[0]!['sequence'];
    const result = map(raw);
    expect(result.catalog.segments.map((s) => s.origin)).toEqual(['SFO', 'BOS']);
    expect(result.catalog.warnings).toContain('segment-order-unverified');
  });

  it('un id de segmento repetido rompe todas las referencias: se rechaza', () => {
    const raw = shop();
    (raw['segments'] as Json[])[1]!['id'] = 'SEG-2';
    expect(thrown(() => map(raw))).toBeInstanceOf(SabreAncillaryMappingError);
  });

  it('un número de vuelo que no es número de vuelo no se inventa', () => {
    const raw = shop();
    (raw['segments'] as Json[])[1]!['bookingFlightNumber'] = '1B33';
    expect((thrown(() => map(raw)) as SabreAncillaryMappingError).issues).toEqual([
      'segments.0.bookingFlightNumber:invalid',
    ]);
  });

  it('un brandCode con forma de PAN se omite del snapshot que vuelve en el alta', () => {
    const raw = shop();
    (raw['segments'] as Json[])[1]!['brandCode'] = '4111111111111111';
    expect(map(raw).snapshot.segments[0]!.brandCode).toBeUndefined();
  });
});

describe('mapSabreAncillaryShopResponse — sobres', () => {
  it('errors[] es un rechazo del proveedor, no un catálogo vacío', () => {
    const error = thrown(() =>
      map({
        errors: [{ category: 'BUSINESS_ERROR', type: 'ANCILLARY_SHOP_FAILED', description: 'x' }],
      }),
    );
    expect(error).toBeInstanceOf(SabreAncillaryRejectedError);
    expect((error as SabreAncillaryRejectedError).errorCount).toBe(1);
  });

  it('sin segmentos o sin pasajeros no hay nada que ubicar', () => {
    const noSegments = shop();
    delete noSegments['segments'];
    expect((thrown(() => map(noSegments)) as SabreAncillaryMappingError).issues).toEqual([
      'segments:required',
    ]);
    const noPassengers = shop();
    delete noPassengers['passengers'];
    expect((thrown(() => map(noPassengers)) as SabreAncillaryMappingError).issues).toEqual([
      'passengers:required',
    ]);
  });

  it('una forma fuera de contrato se rechaza con rutas, sin valores', () => {
    const raw = shop();
    (raw['segments'] as Json[])[0]!['departureAirportCode'] = 'Boston TEST MR';
    const error = thrown(() => map(raw)) as SabreAncillaryMappingError;
    expect(error).toBeInstanceOf(SabreAncillaryMappingError);
    expect(error.message).not.toContain('TEST MR');
    expect(error.issues[0]).toMatch(/^segments\.0\.departureAirportCode:/);
  });

  it('sin ofertas: catálogo vacío con aviso, que no es «ya tiene todo»', () => {
    const raw = shop();
    delete raw['offers'];
    const result = map(raw);
    expect(result.catalog.offers).toEqual([]);
    expect(result.catalog.warnings).toEqual(['catalog-empty']);
  });

  it('una oferta sin items se descarta con aviso', () => {
    const raw = shop();
    (raw['offers'] as Json[]).push({ id: 'otra', items: [] });
    expect(map(raw).catalog.warnings).toContain('offer-invalid');
  });

  it('un ítem roto se descarta con aviso y los demás siguen', () => {
    const raw = shop();
    items(raw)[2]!['id'] = '4111111111111111';
    const result = map(raw);
    expect(byCode(result, 'GTS')).toEqual([]);
    expect(result.catalog.offers).toHaveLength(8);
    expect(result.catalog.warnings).toContain('offer-item-invalid');
  });

  it('warnings[] de Sabre se cuentan, su texto no viaja', () => {
    const raw = shop();
    raw['warnings'] = [{ category: 'X', type: 'Y', description: 'TEST MR SABRE' }];
    const result = map(raw);
    expect(result.catalog.warnings[0]).toBe('provider-warning');
    expect(JSON.stringify(result.warnings)).not.toContain('TEST MR');
  });
});

describe('AncillaryCatalogSchema — invariantes del canónico', () => {
  const offer = (): AncillaryOffer => structuredClone(map().catalog.offers[0]!);

  it('vendible sin motivo; no vendible con exactamente un motivo', () => {
    expect(
      AncillaryOfferSchema.safeParse({ ...offer(), notSellableReason: 'DISPLAY_ONLY' }).success,
    ).toBe(false);
    expect(AncillaryOfferSchema.safeParse({ ...offer(), sellable: false }).success).toBe(false);
  });

  it('un precio no informado no se puede vender', () => {
    const candidate = offer();
    candidate.passengers[0]!.charge = { type: 'NOT_INFORMED' };
    expect(AncillaryOfferSchema.safeParse(candidate).success).toBe(false);
  });

  it('PRICE_NOT_INFORMED exige un precio no informado', () => {
    expect(
      AncillaryOfferSchema.safeParse({
        ...offer(),
        sellable: false,
        notSellableReason: 'PRICE_NOT_INFORMED',
      }).success,
    ).toBe(false);
  });

  it('un pasajero por entrada y tramos únicos', () => {
    const twice = offer();
    twice.passengers[1]!.passengerIndex = 0;
    expect(AncillaryOfferSchema.safeParse(twice).success).toBe(false);
    expect(AncillaryOfferSchema.safeParse({ ...offer(), segmentRefs: [0, 0] }).success).toBe(false);
  });

  it('un PRICED necesita dinero válido', () => {
    const candidate = offer() as unknown as { passengers: { charge: unknown }[] };
    candidate.passengers[0]!.charge = { type: 'PRICED' };
    expect(AncillaryOfferSchema.safeParse(candidate).success).toBe(false);
  });

  it('el catálogo no admite tramos fuera de rango ni ids repetidos', () => {
    const catalog = map().catalog;
    expect(
      AncillaryCatalogSchema.safeParse({
        ...catalog,
        offers: [{ ...catalog.offers[0]!, segmentRefs: [2] }],
      }).success,
    ).toBe(false);
    expect(
      AncillaryCatalogSchema.safeParse({
        ...catalog,
        offers: [catalog.offers[0]!, catalog.offers[0]!],
      }).success,
    ).toBe(false);
  });
});
