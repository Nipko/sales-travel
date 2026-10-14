import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SABRE_NON_IDEMPOTENT_PATHS, isNonIdempotentSabrePath } from '../http/sabre-http.client';
import {
  SABRE_ANCILLARIES_ADD_PATH,
  SabreAncillaryAddRequestSchema,
  buildSabreAncillaryAddRequest,
  type SabreAncillaryAddLineInput,
} from './add.request.builder';
import { SabreAncillaryRequestError } from './shop.request.builder';
import {
  mapSabreAncillaryShopResponse,
  type SabreAncillaryOfferBinding,
  type SabreAncillaryShopMapResult,
} from './shop.response.mapper';

/**
 * `/add` en MODO RECURSO (`stateless-ancillaries-api-1.0.yml:165-218` y el ejemplo «Adding
 * ancillary using resource mode» de `help/stateless-ancillaries-api-1.0/1.0-index.txt`), armado
 * desde la consulta del fixture derivado (ver la cabecera de `shop.response.mapper.test.ts`).
 */

type Json = Record<string, unknown>;

const PNR = 'SXZRGJ';

function mapped(patch: (raw: Json) => void = () => undefined): SabreAncillaryShopMapResult {
  const raw = JSON.parse(
    readFileSync(
      join(__dirname, '..', '__fixtures__', 'stateless-ancillaries-shop-pnr-200.derived.json'),
      'utf8',
    ),
  ) as Json;
  patch(raw);
  return mapSabreAncillaryShopResponse(raw, {
    pnrLocator: PNR,
    passengers: [{ paxType: 'ADT' }, { paxType: 'CHD' }],
  });
}

function binding(
  result: SabreAncillaryShopMapResult,
  serviceCode: string,
  segment = 0,
): SabreAncillaryOfferBinding {
  const found = [...result.bindings.values()].find(
    (entry) => entry.offer.serviceCode === serviceCode && entry.offer.segmentRefs[0] === segment,
  );
  if (found === undefined) throw new Error(`sin binding ${serviceCode}/${String(segment)}`);
  return found;
}

function build(lines: (result: SabreAncillaryShopMapResult) => SabreAncillaryAddLineInput[]) {
  const result = mapped();
  return buildSabreAncillaryAddRequest({ snapshot: result.snapshot, lines: lines(result) });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('buildSabreAncillaryAddRequest — la forma del cuerpo', () => {
  it('es la del ejemplo de modo recurso, con commit explícito y sin nombres', () => {
    const plan = build((r) => [{ binding: binding(r, '0CC'), passengerIndexes: [0, 1] }]);
    expect(plan.path).toBe('/v1/dc/ancillaries/add');
    expect(Object.keys(plan.body).sort()).toEqual([
      'ancillaries',
      'isCommitEnabled',
      'itinerary',
      'itineraryParts',
      'offers',
      'passengers',
      'pnrLocator',
      'segments',
    ]);
    expect(plan.body.pnrLocator).toBe(PNR);
    expect(plan.body.isCommitEnabled).toBe(true);
    expect(plan.body.passengers).toEqual([
      { id: 'PAX-1', nameNumber: '01.01', typeCode: 'ADT' },
      { id: 'PAX-2', nameNumber: '02.01', typeCode: 'CNN' },
    ]);
    const raw = JSON.stringify(plan.body);
    for (const leak of ['TEST MR', 'givenName', 'surname', 'loyalty', '987654321', 'WCHR']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('el ítem es el de la consulta, con su precio, y sin priceOverrideType', () => {
    const plan = build((r) => [{ binding: binding(r, '0CC'), passengerIndexes: [0, 1] }]);
    expect(plan.body.offers).toEqual([
      {
        id: 'b891aae1-836f-447e-ae2c-16d64d9c76e2',
        items: [
          {
            id: 'b891aae1-836f-447e-ae2c-16d64d9c76e2-1',
            segmentReferenceIds: ['SEG-1'],
            passengerReferenceIds: ['PAX-1', 'PAX-2'],
            details: {
              type: 'AncillaryOfferItem',
              ancillaryReferenceId: 'ancillary_ancillary_1',
              quantity: 1,
              isAvailable: false,
              sectorPortionIndicator: 'Sector',
            },
            price: {
              unitPrices: [
                {
                  total: { amount: { amount: '35.00', currencyCode: 'USD' } },
                  totalBreakdown: { base: { amount: { amount: '35.00', currencyCode: 'USD' } } },
                },
              ],
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(plan.body)).not.toContain('priceOverrideType');
  });

  it('para un pasajero de dos, sólo viaja ese pasajero y su precio', () => {
    const plan = build((r) => [{ binding: binding(r, '0CC', 1), passengerIndexes: [1] }]);
    const item = plan.body.offers[0]!.items[0]!;
    expect(item.passengerReferenceIds).toEqual(['PAX-2']);
    expect(item.price?.unitPrices).toEqual([
      {
        total: { amount: { amount: '26.25', currencyCode: 'USD' } },
        passengerReferenceIds: ['PAX-2'],
      },
    ]);
    expect(plan.sent).toEqual([
      {
        serviceOfferItemId: binding(mapped(), '0CC', 1).offer.serviceOfferItemId,
        passengerIndex: 1,
        ancillaryId: 'ancillary_ancillary_1',
      },
    ]);
  });

  it('un unitPrice que nombra a dos pasajeros se recorta al que compra', () => {
    const result = mapped((raw) => {
      const items = (raw['offers'] as Json[])[0]!['items'] as Json[];
      const unit = ((items[0]!['price'] as Json)['unitPrices'] as Json[])[0]!;
      unit['passengerReferenceIds'] = ['PAX-1', 'PAX-2'];
    });
    const plan = buildSabreAncillaryAddRequest({
      snapshot: result.snapshot,
      lines: [{ binding: binding(result, '0CC'), passengerIndexes: [0] }],
    });
    expect(plan.body.offers[0]!.items[0]!.price?.unitPrices).toEqual([
      {
        total: { amount: { amount: '35.00', currencyCode: 'USD' } },
        totalBreakdown: { base: { amount: { amount: '35.00', currencyCode: 'USD' } } },
        passengerReferenceIds: ['PAX-1'],
      },
    ]);
  });

  it('un servicio incluido viaja sin precio; uno de viaje completo conserva su itinerario', () => {
    const plan = build((r) => [
      { binding: binding(r, '0GO'), passengerIndexes: [0] },
      { binding: binding(r, '0B3'), passengerIndexes: [0] },
    ]);
    const [carryOn, meal] = plan.body.offers[0]!.items;
    expect(carryOn?.price).toBeUndefined();
    expect(carryOn?.itineraryPartReferenceIds).toEqual(['IP-1']);
    expect(meal?.itineraryReferenceId).toBe('I-1');
    expect(meal?.segmentReferenceIds).toBeUndefined();
  });

  it('las definiciones van una vez y sólo con lo que el alta necesita', () => {
    const plan = build((r) => [
      { binding: binding(r, '0CC', 0), passengerIndexes: [0] },
      { binding: binding(r, '0CC', 1), passengerIndexes: [0] },
      { binding: binding(r, 'GTS'), passengerIndexes: [0] },
    ]);
    expect(plan.body.ancillaries.map((a) => a.id)).toEqual([
      'ancillary_ancillary_1',
      'ancillary_ancillary_2',
    ]);
    // La definición del ejemplo de la ayuda, campo por campo.
    expect(plan.body.ancillaries[1]).toEqual({
      id: 'ancillary_ancillary_2',
      groupCode: '99',
      groupName: 'MISCELLANEOUS FEES',
      subCode: 'GTS',
      reasonForIssuanceCode: 'D',
      reasonForIssuance: 'FinancialImpact',
      commercialName: 'GDS TICKET SERVICE FEE',
      airlineCode: 'X0',
      vendorCode: 'MMGR',
      emdType: { code: '1', value: 'Standalone', isConsumedAtIssuance: true },
    });
    // Ni reglas, ni formas de pago excluidas, ni el detalle libre del SSR.
    const first = JSON.stringify(plan.body.ancillaries[0]);
    for (const absent of ['ancillaryRule', 'excludedFormOfPayments', 'Excess bag', 'purchaseBy']) {
      expect(first).not.toContain(absent);
    }
  });

  it('todos los segmentos e itinerario de la reserva, en el orden en que los dio Sabre', () => {
    const plan = build((r) => [{ binding: binding(r, 'GTS'), passengerIndexes: [0] }]);
    expect(plan.body.segments.map((s) => s.id)).toEqual(['SEG-1', 'SEG-2']);
    expect(plan.body.itinerary).toEqual({ id: 'I-1', itineraryPartReferenceIds: ['IP-1', 'IP-2'] });
    expect(plan.body.itineraryParts).toHaveLength(2);
  });
});

describe('buildSabreAncillaryAddRequest — escribe en la reserva', () => {
  it('/add y /remove están en SABRE_NON_IDEMPOTENT_PATHS: el cliente nunca los reintenta', () => {
    expect(SABRE_NON_IDEMPOTENT_PATHS).toContain(SABRE_ANCILLARIES_ADD_PATH);
    expect(SABRE_NON_IDEMPOTENT_PATHS).toContain('/v1/dc/ancillaries/remove');
    expect(isNonIdempotentSabrePath(SABRE_ANCILLARIES_ADD_PATH)).toBe(true);
    expect(isNonIdempotentSabrePath(`${SABRE_ANCILLARIES_ADD_PATH}/`)).toBe(true);
    expect(isNonIdempotentSabrePath(`${SABRE_ANCILLARIES_ADD_PATH}?x=1`)).toBe(true);
  });
});

describe('buildSabreAncillaryAddRequest — lo que no sale', () => {
  it('sin líneas no hay alta', () => {
    const error = thrown(() => build(() => []));
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect((error as SabreAncillaryRequestError).operation).toBe('add');
  });

  it('una oferta no vendible no se agrega', () => {
    const error = thrown(() =>
      build((r) => [{ binding: binding(r, '0BX'), passengerIndexes: [0] }]),
    );
    expect((error as SabreAncillaryRequestError).issues).toEqual(['lines.0:not_sellable']);
  });

  it('un pasajero que la oferta no admite no se agrega', () => {
    const error = thrown(() =>
      build((r) => [{ binding: binding(r, 'GTS'), passengerIndexes: [1] }]),
    );
    expect((error as SabreAncillaryRequestError).issues).toEqual([
      'lines.0.passengerIndexes:not_eligible',
    ]);
  });

  it('pasajeros repetidos o vacíos, y la misma oferta dos veces', () => {
    expect(
      (
        thrown(() =>
          build((r) => [{ binding: binding(r, 'GTS'), passengerIndexes: [0, 0] }]),
        ) as SabreAncillaryRequestError
      ).issues,
    ).toEqual(['lines.0.passengerIndexes:invalid']);
    expect(
      (
        thrown(() =>
          build((r) => [{ binding: binding(r, 'GTS'), passengerIndexes: [] }]),
        ) as SabreAncillaryRequestError
      ).issues,
    ).toEqual(['lines.0.passengerIndexes:invalid']);
    expect(
      (
        thrown(() =>
          build((r) => [
            { binding: binding(r, 'GTS'), passengerIndexes: [0] },
            { binding: binding(r, 'GTS'), passengerIndexes: [0] },
          ]),
        ) as SabreAncillaryRequestError
      ).issues,
    ).toEqual(['lines.1:duplicate']);
  });

  it('un snapshot con un PNR inválido no sale (defensa en profundidad)', () => {
    const result = mapped();
    const error = thrown(() =>
      buildSabreAncillaryAddRequest({
        snapshot: { ...result.snapshot, pnrLocator: '4111111111111111' },
        lines: [{ binding: binding(result, 'GTS'), passengerIndexes: [0] }],
      }),
    );
    expect((error as SabreAncillaryRequestError).issues).toEqual(['pnrLocator:invalid_string']);
  });
});

describe('SabreAncillaryAddRequestSchema — estricto', () => {
  function body(): Json {
    const plan = build((r) => [{ binding: binding(r, '0CC'), passengerIndexes: [0, 1] }]);
    return structuredClone(plan.body);
  }
  function item(candidate: Json): Json {
    return ((candidate['offers'] as Json[])[0]!['items'] as Json[])[0]!;
  }

  it('el cuerpo armado pasa', () => {
    expect(SabreAncillaryAddRequestSchema.safeParse(body()).success).toBe(true);
  });

  it.each([
    ['priceOverrideType en el ítem', (b: Json) => (item(b)['priceOverrideType'] = 'Base')],
    ['priceTaxExempt en el ítem', (b: Json) => (item(b)['priceTaxExempt'] = {})],
    [
      'nombre del pasajero',
      (b: Json) => ((b['passengers'] as Json[])[0]!['givenName'] = 'TEST MR'),
    ],
    [
      'viajero frecuente',
      (b: Json) => ((b['passengers'] as Json[])[0]!['loyaltyPrograms'] = [{ number: '1' }]),
    ],
    ['clientContext', (b: Json) => (b['clientContext'] = { pseudoCityCode: 'ZZZ' })],
    ['commit apagado', (b: Json) => (b['isCommitEnabled'] = false)],
    [
      'más de dos ofertas',
      (b: Json) =>
        (b['offers'] = [
          ...(b['offers'] as Json[]),
          ...(b['offers'] as Json[]),
          ...(b['offers'] as Json[]),
        ]),
    ],
    [
      'una tarjeta en el SSR',
      (b: Json) =>
        ((b['ancillaries'] as Json[])[0]!['specialService'] = { code: '4111111111111111' }),
    ],
    [
      'un nombre comercial con forma de PAN',
      (b: Json) => ((b['ancillaries'] as Json[])[0]!['commercialName'] = 'BAG 4111111111111111'),
    ],
    [
      'un servicio sólo para mostrar',
      (b: Json) => ((b['ancillaries'] as Json[])[0]!['isDisplayOnly'] = true),
    ],
    [
      'un servicio que el pasajero ya tiene',
      (b: Json) => ((item(b)['details'] as Json)['isAvailable'] = true),
    ],
    [
      'un importe negativo',
      (b: Json) => {
        const unit = ((item(b)['price'] as Json)['unitPrices'] as Json[])[0]!;
        ((unit['total'] as Json)['amount'] as Json)['amount'] = -1;
      },
    ],
  ])('rechaza %s', (_label, mutate) => {
    const candidate = body();
    mutate(candidate);
    expect(SabreAncillaryAddRequestSchema.safeParse(candidate).success).toBe(false);
  });
});
