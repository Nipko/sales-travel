import type { Offer } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  SABRE_PRICE_CARDLESS_SUBCODES,
  SABRE_PRICE_MAX_PASSENGERS,
  SABRE_PRICE_PATH,
  SABRE_RAW_KEYS,
  SabrePriceRequestError,
  buildSabrePriceRequest,
  readSabreOfferItemIds,
  type SabrePriceInput,
} from './request.builder';

/**
 * Los ids de este fichero son los de los ejemplos oficiales de
 * `docs/sabre/evidence/specs/offer-price-ndc-v1.yml` (`:2059-2078` el request mínimo,
 * `:2080-2398` la respuesta de ida). No son inventados: cumplen el patrón del contrato y sirven
 * de prueba de que el patrón que compilamos es el que Sabre publica.
 */
const OFFER_ITEM_ID = 'dd07bbd7fb57c88nclq1qixyj3-1-1';
const OTHER_OFFER_ITEM_ID = 'dd07bbd7fb57c88nclq1qixyj3-1-2';

/** Un PAN de prueba del propio contrato de `createBooking` (`booking-management-v1.yml:5314`). */
const TEST_PAN = '4537156488578956';

function baseOffer(raw: Record<string, unknown> | undefined): Offer {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '11111111-2222-4333-8444-555555555555',
    products: ['flight'],
    provider: {
      name: 'sabre',
      offerRef: 'dd07bbd7fb57c88nclq1qixyj3-1',
      ...(raw === undefined ? {} : { raw: raw as Offer['provider']['raw'] }),
    },
    total: { amountMinor: 11890, currency: 'USD' },
    baseFare: { amountMinor: 9674, currency: 'USD' },
    taxes: { amountMinor: 2216, currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:20:00.000Z',
  };
}

function build(input: SabrePriceInput, options = {}): unknown {
  return buildSabrePriceRequest(input, options);
}

describe('buildSabrePriceRequest — el caso mínimo es el del contrato', () => {
  it('con sólo offerItemIds produce exactamente el ejemplo oficial más común', () => {
    // `offer-price-ndc-v1.yml:2059-2078`: `{"query":[{"offerItemId":["…"]}]}`. Sin `params`, sin
    // `passengers`, sin forma de pago. Se compara la forma ENTERA, no campo a campo: un `params`
    // vacío añadido "por si acaso" tiene que poner este test en rojo.
    expect(build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }] })).toEqual({
      query: [{ offerItemId: [OFFER_ITEM_ID] }],
    });
  });

  it('la ruta es la del contrato', () => {
    expect(SABRE_PRICE_PATH).toBe('/v1/offers/price');
  });

  it('omite `params` cuando no hay nada que poner, y lo incluye cerrado cuando sí', () => {
    const request = buildSabrePriceRequest({
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      accountCode: 'ACC01',
      allowBundles: true,
    });
    expect(request.params).toEqual({ accountCode: 'ACC01', allowBundles: true });
  });

  it('propaga passengerId y la referencia de forma de pago dentro de query', () => {
    const request = buildSabrePriceRequest({
      query: [
        {
          offerItemIds: [OFFER_ITEM_ID, OTHER_OFFER_ITEM_ID],
          passengerIds: ['Passenger1', 'Passenger2'],
          formOfPaymentRef: 'FOP1',
        },
      ],
    });
    expect(request.query[0]).toEqual({
      offerItemId: [OFFER_ITEM_ID, OTHER_OFFER_ITEM_ID],
      passengerId: ['Passenger1', 'Passenger2'],
      formOfPayment: 'FOP1',
    });
  });

  it('rechaza un offerItemId fuera del patrón del contrato sin repetir el valor', () => {
    let thrown: unknown;
    try {
      build({ query: [{ offerItemIds: ['no-es-un-id'] }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRequestError);
    expect(String(thrown)).toContain('query.0.offerItemIds.0');
    expect(String(thrown)).not.toContain('no-es-un-id');
  });

  it('no admite más de 9 pasajeros (`:91-96`)', () => {
    const passengers = Array.from({ length: SABRE_PRICE_MAX_PASSENGERS + 1 }, (_, i) => ({
      id: `Passenger${String(i + 1)}`,
    }));
    expect(() => build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }], passengers })).toThrow(
      SabrePriceRequestError,
    );
  });
});

describe('D1 — la compuerta de la forma de pago', () => {
  const cardFop = { subCode: 'FDA', cardType: 'MC', binNumber: '545251' };

  it('sin el interruptor, un BIN de tarjeta es un error duro y el mensaje NO lo repite', () => {
    let thrown: unknown;
    try {
      build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }], formOfPayment: cardFop });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRequestError);
    expect(String(thrown)).toContain('allowCardBinPricing');
    expect(String(thrown)).not.toContain('545251');
  });

  it('sin el interruptor tampoco pasa un subCode de tarjeta a secas', () => {
    expect(() =>
      build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }], formOfPayment: { subCode: 'FCA' } }),
    ).toThrow(SabrePriceRequestError);
  });

  it.each(SABRE_PRICE_CARDLESS_SUBCODES)(
    'el subcódigo sin tarjeta %s no necesita interruptor',
    (subCode) => {
      const request = buildSabrePriceRequest({
        query: [{ offerItemIds: [OFFER_ITEM_ID] }],
        formOfPayment: { subCode },
      });
      expect(request.params?.formOfPayment).toEqual([{ subCode }]);
    },
  );

  it('con el interruptor encendido el BIN sí viaja, y sólo el BIN', () => {
    const request = buildSabrePriceRequest(
      { query: [{ offerItemIds: [OFFER_ITEM_ID] }], formOfPayment: cardFop },
      { allowCardBinPricing: true },
    );
    expect(request.params?.formOfPayment).toEqual([
      { subCode: 'FDA', cardType: 'MC', binNumber: '545251' },
    ]);
  });

  it('un PAN completo no cabe en binNumber ni con el interruptor encendido', () => {
    // 6-8 dígitos (`:296-300`). El interruptor abre la puerta al BIN, no a la tarjeta.
    let thrown: unknown;
    try {
      build(
        {
          query: [{ offerItemIds: [OFFER_ITEM_ID] }],
          formOfPayment: { subCode: 'FDA', binNumber: TEST_PAN },
        },
        { allowCardBinPricing: true },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRequestError);
    expect(String(thrown)).not.toContain(TEST_PAN);
  });
});

describe('el guardia anti-PAN cubre los campos de texto libre del request', () => {
  it('`customQualifiers` no admite una tirada de 9 o más dígitos', () => {
    let thrown: unknown;
    try {
      build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }], customQualifiers: { QCI: [TEST_PAN] } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRequestError);
    expect(String(thrown)).toContain('customQualifiers.QCI');
    expect(String(thrown)).not.toContain(TEST_PAN);
  });

  it('`customQualifiers` sí admite el valor del ejemplo oficial (`:263-264`)', () => {
    const request = buildSabrePriceRequest({
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      customQualifiers: { QCI: ['12345'] },
    });
    expect(request.params?.customQualifiers).toEqual({ QCI: ['12345'] });
  });

  it('`trxId` tampoco puede llevar dígitos de tarjeta', () => {
    expect(() =>
      build({ query: [{ offerItemIds: [OFFER_ITEM_ID] }] }, { trxId: `trace-${TEST_PAN}` }),
    ).toThrow(SabrePriceRequestError);
  });

  it('un `trxId` legítimo viaja en payloadAttributes', () => {
    const request = buildSabrePriceRequest(
      { query: [{ offerItemIds: [OFFER_ITEM_ID] }] },
      { trxId: 'b213e940-c89c-4dbb-96b1-d16a6c0249fb' },
    );
    expect(request.payloadAttributes).toEqual({ trxID: 'b213e940-c89c-4dbb-96b1-d16a6c0249fb' });
  });

  it('el número de billete sin usar SÍ puede tener 14 dígitos: es su forma de contrato', () => {
    // Prueba de que el guardia anti-PAN no se aplicó donde no debía. Sin esta distinción, la
    // reemisión con valor residual (`:233-240`) sería imposible de construir.
    const request = buildSabrePriceRequest({
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      passengers: [{ id: 'Passenger1', unusedTicketNumber: '00157446945530' }],
    });
    expect(request.passengers?.[0]?.unusedTicketNumber).toBe('00157446945530');
  });
});

describe('lo que el builder nunca pone en el cable', () => {
  it('no manda `personName` aunque venga en la entrada', () => {
    const input = {
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      passengers: [{ id: 'Passenger1', personName: { surname: 'Smith', givenName: 'John' } }],
    } as unknown as SabrePriceInput;

    // Por la puerta pública y sobre el cuerpo SERIALIZADO, que es lo que sale al cable.
    const body = JSON.stringify(buildSabrePriceRequest(input));
    expect(body).not.toContain('Smith');
    expect(body).not.toContain('personName');
  });

  it('del bloque de socio frecuente sólo viajan airline y accountNumber', () => {
    const input = {
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      passengers: [
        {
          id: 'Passenger1',
          frequentFlyer: [{ airline: 'AA', accountNumber: '3255310', signInID: 'usuario-1234' }],
        },
      ],
    } as unknown as SabrePriceInput;

    const request = buildSabrePriceRequest(input);
    expect(request.passengers?.[0]?.frequentFlyer).toEqual([
      { airline: 'AA', accountNumber: '3255310' },
    ]);
    expect(JSON.stringify(request)).not.toContain('signInID');
  });

  it('no manda `diags`: los diagnósticos son depuración interna, no producción', () => {
    const input = {
      query: [{ offerItemIds: [OFFER_ITEM_ID] }],
      diags: ['NDCC_OFFER_PRICE_REQUEST'],
    } as unknown as SabrePriceInput;
    expect(JSON.stringify(buildSabrePriceRequest(input))).not.toContain('diags');
  });

  it('un request completo con BIN de 8 y sin billete no lleva ninguna tirada de tamaño PAN', () => {
    const body = JSON.stringify(
      buildSabrePriceRequest(
        {
          query: [{ offerItemIds: [OFFER_ITEM_ID], passengerIds: ['Passenger1'] }],
          passengers: [{ id: 'Passenger1', type: 'ADT' }],
          formOfPayment: { subCode: 'FDA', cardType: 'MC', binNumber: '54525100' },
          accountCode: 'ACC01',
        },
        { allowCardBinPricing: true, trxId: 'b213e940-c89c-4dbb-96b1-d16a6c0249fb' },
      ),
    );
    expect(body).not.toMatch(/[0-9]{9,}/);
  });
});

describe('readSabreOfferItemIds — la cadena de identificadores, sin inventar nada', () => {
  it('lee el nivel tarifa del shop por defecto', () => {
    const offer = baseOffer({ [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID] });
    expect(readSabreOfferItemIds(offer)).toEqual({
      offerItemIds: [OFFER_ITEM_ID],
      origin: 'shop-fare',
    });
  });

  it('lee el nivel por pasajero cuando se pide, y no lo deriva del nivel tarifa', () => {
    const onlyFare = baseOffer({ [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID] });
    expect(() => readSabreOfferItemIds(onlyFare, 'passenger')).toThrow(SabrePriceRequestError);

    const withPassenger = baseOffer({
      [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID],
      [SABRE_RAW_KEYS.shopPassengerOfferItemIds]: [OTHER_OFFER_ITEM_ID],
    });
    expect(readSabreOfferItemIds(withPassenger, 'passenger')).toEqual({
      offerItemIds: [OTHER_OFFER_ITEM_ID],
      origin: 'shop-passenger',
    });
  });

  it('los ids de price ganan a los del shop: es lo que exige repricear una oferta vencida', () => {
    const offer = baseOffer({
      [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID],
      [SABRE_RAW_KEYS.priceOfferItemIds]: [OTHER_OFFER_ITEM_ID],
    });
    expect(readSabreOfferItemIds(offer)).toEqual({
      offerItemIds: [OTHER_OFFER_ITEM_ID],
      origin: 'price',
    });
  });

  it('sin ids en provider.raw lanza en vez de fabricar un `-ITEM1`', () => {
    // La regresión que docs/sabre/03 §3.6 documenta en el ACL de LATAM. Si alguien "arregla" la
    // ausencia con un id sintético, este test se pone rojo.
    let thrown: unknown;
    try {
      readSabreOfferItemIds(baseOffer(undefined));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SabrePriceRequestError);
    expect(String(thrown)).not.toContain('ITEM1');
  });

  it('una lista con un id malformado lanza entera: no se manda media oferta a tarificar', () => {
    const offer = baseOffer({
      [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID, 'roto'],
    });
    expect(() => readSabreOfferItemIds(offer)).toThrow(/\[1\]/);
  });

  it('rechaza una oferta de otro proveedor', () => {
    const foreign = { ...baseOffer({ [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID] }) };
    const offer: Offer = { ...foreign, provider: { ...foreign.provider, name: 'latam-ndc' } };
    expect(() => readSabreOfferItemIds(offer)).toThrow(SabrePriceRequestError);
  });

  it('una oferta vencida se puede revalidar: vencer no es motivo para negarse', () => {
    // `expiresAt` en el pasado no es un caso de error: repricear una oferta vencida es JUSTO lo
    // que Sabre indica hacer, y por eso la lectura de ids no mira el reloj.
    const expired: Offer = {
      ...baseOffer({ [SABRE_RAW_KEYS.priceOfferItemIds]: [OFFER_ITEM_ID] }),
      expiresAt: '2020-01-01T00:00:00.000Z',
    };
    expect(readSabreOfferItemIds(expired).origin).toBe('price');
  });

  it('los ids leídos arman el request exactamente como los compone el adapter', () => {
    // Los dos pasos que `SabreOfferPriceAdapter.priceQuote` da por su cuenta, en el mismo orden.
    // No es un atajo publicado —ver la nota de `request.builder.ts`—: es la comprobación de que
    // la mitad que LEE la oferta encaja con la mitad que CONSTRUYE el cuerpo.
    const offer = baseOffer({ [SABRE_RAW_KEYS.shopOfferItemIds]: [OFFER_ITEM_ID] });
    const { offerItemIds, origin } = readSabreOfferItemIds(offer);

    expect(buildSabrePriceRequest({ query: [{ offerItemIds: [...offerItemIds] }] })).toEqual({
      query: [{ offerItemId: [OFFER_ITEM_ID] }],
    });
    expect(origin).toBe('shop-fare');
  });
});
