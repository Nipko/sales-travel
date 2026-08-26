import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreConfigError } from '../errors';
import {
  SABRE_BFM_VERSION,
  SABRE_SHOP_PATH,
  buildSabreShopRequest,
  type SabreShopOptions,
  type SabreShopRequest,
} from './request.builder';

/**
 * PCC ajeno: el único que puede aparecer en un body construido en test. Cualquier otro token con
 * pinta de PCC significa que se coló un literal (docs/sabre/11 §6.4).
 */
const FAKE_PCC = 'ZZZZ';

/**
 * Los seis PCC que aparecen en la colección de Sabre, más el `client_id` de su Postman. Ninguno
 * puede acabar en un body nuestro: serían credenciales de terceros viajando con nuestras
 * búsquedas (docs/sabre/11 §6.4, R-28).
 */
const PCC_DENYLIST = ['U9PK', 'G7RE', '7KFA', 'G7HE', 'N87F', 'GF1I', 'SBR-BMAPI'] as const;

function cfg(overrides: Partial<SabreConfig> = {}): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    password: 'Pa55w0rd!',
    homePcc: FAKE_PCC,
    ...overrides,
  };
}

function criteria(overrides: Partial<FlightSearchCriteria> = {}): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-11-12',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'COP',
    ...overrides,
  };
}

function build(
  c: Partial<FlightSearchCriteria> = {},
  config: Partial<SabreConfig> = {},
  options: SabreShopOptions = {},
): SabreShopRequest['OTA_AirLowFareSearchRQ'] {
  return buildSabreShopRequest(criteria(c), cfg(config), options).OTA_AirLowFareSearchRQ;
}

/** Recolecta todos los valores de una clave, a cualquier profundidad del árbol serializado. */
function collectValues(node: unknown, key: string): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => collectValues(child, key));
  if (node === null || typeof node !== 'object') return [];
  const entries = Object.entries(node as Record<string, unknown>);
  return entries.flatMap(([k, v]) =>
    k === key && typeof v === 'string' ? [v] : collectValues(v, key),
  );
}

describe('versión del servicio', () => {
  it('manda Version "5" y la ruta es /v5 — el contrato exige que coincidan', () => {
    expect(build().Version).toBe(SABRE_BFM_VERSION);
    expect(SABRE_SHOP_PATH).toBe('/v5/offers/shop');
    expect(SABRE_SHOP_PATH).toContain(`/v${SABRE_BFM_VERSION}/`);
  });
});

describe('POS: el PCC sale de la config, nunca del código', () => {
  it.each([['ZZZZ'], ['ABC'], ['Q7X1']])('homePcc %s viaja tal cual a PseudoCityCode', (pcc) => {
    const body = build({}, { homePcc: pcc });
    expect(body.POS.Source).toHaveLength(1);
    expect(collectValues(body, 'PseudoCityCode')).toEqual([pcc]);
  });

  it('RequestorID lleva las constantes documentadas del contrato', () => {
    expect(build().POS.Source[0]?.RequestorID).toEqual({
      Type: '1',
      ID: '1',
      CompanyName: { Code: 'TN' },
    });
  });

  it('sin homePcc falla con error tipado en vez de mandar "undefined" al cable', () => {
    expect(() => build({}, { homePcc: undefined })).toThrow(SabreConfigError);
  });

  it('MaximumNumberOfPCCs se omite por defecto y sólo aparece si se configura', () => {
    expect(build().POS.MultiSourceControl).toBeUndefined();
    expect(build({}, {}, { maxPccs: 3 }).POS.MultiSourceControl).toEqual({
      MaximumNumberOfPCCs: 3,
    });
  });
});

describe('PTC: el niño es CNN, no CHD', () => {
  const paxCases = [
    {
      name: '1 adulto',
      paxCount: { adults: 1, children: 0, infants: 0 },
      expected: [{ Code: 'ADT', Quantity: 1 }],
    },
    {
      name: '2 adultos + 1 niño',
      paxCount: { adults: 2, children: 1, infants: 0 },
      expected: [
        { Code: 'ADT', Quantity: 2 },
        { Code: 'CNN', Quantity: 1 },
      ],
    },
    {
      name: '2 adultos + 1 niño + 1 infante',
      paxCount: { adults: 2, children: 1, infants: 1 },
      expected: [
        { Code: 'ADT', Quantity: 2 },
        { Code: 'CNN', Quantity: 1 },
        { Code: 'INF', Quantity: 1 },
      ],
    },
    {
      name: '1 adulto + 1 infante (sin niños)',
      paxCount: { adults: 1, children: 0, infants: 1 },
      expected: [
        { Code: 'ADT', Quantity: 1 },
        { Code: 'INF', Quantity: 1 },
      ],
    },
  ] as const;

  it.each(paxCases)('$name', ({ paxCount, expected }) => {
    const ptq = build({ paxCount }).TravelerInfoSummary.AirTravelerAvail[0].PassengerTypeQuantity;
    expect(ptq.map(({ Code, Quantity }) => ({ Code, Quantity }))).toEqual(expected);
  });

  it('CHD no aparece nunca: mandarlo sería no recibir tarifa de niño', () => {
    const json = JSON.stringify(build({ paxCount: { adults: 2, children: 2, infants: 1 } }));
    expect(json).not.toContain('"CHD"');
    expect(json).toContain('"CNN"');
  });
});

describe('moneda: PriceRequestInformation.CurrencyCode siempre presente', () => {
  it.each([['COP'], ['USD'], ['BRL'], ['PEN']])('%s llega a CurrencyCode', (currency) => {
    expect(build({ currency }).TravelerInfoSummary.PriceRequestInformation).toEqual({
      CurrencyCode: currency,
    });
  });

  it('está presente en toda variante del request', () => {
    const variants: Partial<FlightSearchCriteria>[] = [
      {},
      { returnDate: '2026-11-20' },
      { cabin: 'business' },
      { paxCount: { adults: 2, children: 1, infants: 1 } },
    ];
    for (const variant of variants) {
      expect(build(variant).TravelerInfoSummary.PriceRequestInformation.CurrencyCode).toBe('COP');
    }
  });
});

describe('MultipleSourcePerItinerary es constante, no opción', () => {
  const optionCases: [string, SabreShopOptions][] = [
    ['por defecto', {}],
    ['con tier 200ITINS', { itineraryTier: '200ITINS' }],
    ['con numTrips 1', { numTrips: 1 }],
    ['sin preferencia NDC en empate', { preferNdcSourceOnTie: false }],
  ];

  it.each(optionCases)('%s sigue valiendo true', (_name, options) => {
    expect(build({}, {}, options).TPA_Extensions.IntelliSellTransaction).toMatchObject({
      MultipleSourcePerItinerary: { Value: true },
    });
  });
});

describe('DataSources: NDC y ATPCO a la vez, LCC fuera', () => {
  it('las tres propiedades viajan con su valor de Ola 1', () => {
    expect(build().TravelPreferences.TPA_Extensions.DataSources).toEqual({
      NDC: 'Enable',
      ATPCO: 'Enable',
      LCC: 'Disable',
    });
  });

  it('PreferNDCSourceOnTie va activo por defecto y es configurable', () => {
    expect(build().TravelPreferences.TPA_Extensions.PreferNDCSourceOnTie).toEqual({ Value: true });
    expect(
      build({}, {}, { preferNdcSourceOnTie: false }).TravelPreferences.TPA_Extensions
        .PreferNDCSourceOnTie,
    ).toEqual({ Value: false });
  });
});

describe('equipaje y penalidades: los dos interruptores, siempre', () => {
  it('Baggage.RequestType "C" pide franquicia y cargos', () => {
    expect(build().TravelPreferences.Baggage).toEqual({
      RequestType: 'C',
      Description: true,
      CarryOnInfo: true,
    });
  });

  it('VoluntaryChanges va en CADA tipo de pasajero', () => {
    const ptq = build({ paxCount: { adults: 2, children: 1, infants: 1 } }).TravelerInfoSummary
      .AirTravelerAvail[0].PassengerTypeQuantity;
    expect(ptq).toHaveLength(3);
    for (const pax of ptq) {
      expect(pax.TPA_Extensions.VoluntaryChanges).toEqual({
        Match: 'All',
        Penalty: [{ Type: 'Refund' }, { Type: 'Exchange' }],
      });
    }
  });
});

describe('tramos e índices RPH', () => {
  it('sólo ida: un tramo con RPH "1"', () => {
    const ods = build().OriginDestinationInformation;
    expect(ods).toHaveLength(1);
    expect(ods[0]).toEqual({
      RPH: '1',
      DepartureDateTime: '2026-11-12T00:00:00',
      OriginLocation: { LocationCode: 'BOG' },
      DestinationLocation: { LocationCode: 'LIM' },
    });
  });

  it('ida y vuelta: el segundo tramo invierte origen y destino y lleva RPH "2"', () => {
    const ods = build({ returnDate: '2026-11-20' }).OriginDestinationInformation;
    expect(ods).toHaveLength(2);
    expect(ods[1]).toEqual({
      RPH: '2',
      DepartureDateTime: '2026-11-20T00:00:00',
      OriginLocation: { LocationCode: 'LIM' },
      DestinationLocation: { LocationCode: 'BOG' },
    });
  });

  it.each([
    ['sólo ida', undefined, ['1']],
    ['ida y vuelta', '2026-11-20', ['1', '2']],
  ] as const)('%s: RPH base-1, consecutivos y sin repetir', (_name, returnDate, expected) => {
    const ods = build(returnDate === undefined ? {} : { returnDate }).OriginDestinationInformation;
    const rphs = ods.map((od) => od.RPH);
    expect(rphs).toEqual(expected);
    expect(new Set(rphs).size).toBe(ods.length);
  });
});

describe('cabina: el enum de Sabre, no el de LATAM', () => {
  it.each([
    ['economy', 'Y'],
    ['premium_economy', 'S'],
    ['business', 'C'],
    ['first', 'F'],
  ] as const)('%s → %s', (cabin, code) => {
    expect(build({ cabin }).TravelPreferences.CabinPref).toEqual([
      { Cabin: code, PreferLevel: 'Preferred' },
    ]);
  });

  it('sin cabina pedida, el bloque CabinPref no se manda', () => {
    expect(build().TravelPreferences.CabinPref).toBeUndefined();
  });

  it('no usa el vocabulario de LATAM: W no existe en el enum de Sabre y J es otra cabina', () => {
    const json = JSON.stringify([
      build({ cabin: 'premium_economy' }),
      build({ cabin: 'business' }),
    ]);
    expect(json).not.toContain('"Cabin":"W"');
    expect(json).not.toContain('"Cabin":"J"');
  });
});

describe('volumen: tier e itinerarios', () => {
  it('por defecto 50ITINS con NumTrips 20', () => {
    const body = build();
    expect(body.TPA_Extensions.IntelliSellTransaction.RequestType).toEqual({ Name: '50ITINS' });
    expect(body.TravelPreferences.TPA_Extensions.NumTrips).toEqual({ Number: 20 });
  });

  it('un tier fuera del enum del contrato no se manda: falla en el borde', () => {
    expect(() =>
      build({}, {}, { itineraryTier: '500ITINS' } as unknown as SabreShopOptions),
    ).toThrow(SabreConfigError);
  });

  it('NumTrips por debajo del mínimo del contrato falla en el borde', () => {
    expect(() => build({}, {}, { numTrips: 0 })).toThrow(SabreConfigError);
  });
});

describe('seguridad: ningún PCC de terceros en el body saliente (§6.4)', () => {
  const variants: [string, Partial<FlightSearchCriteria>, SabreShopOptions][] = [
    ['sólo ida, 1 adulto', {}, {}],
    [
      'ida y vuelta, familia',
      { returnDate: '2026-11-20', paxCount: { adults: 2, children: 1, infants: 1 } },
      {},
    ],
    ['con cabina y multi-PCC', { cabin: 'business' }, { maxPccs: 5 }],
    ['tier alto', {}, { itineraryTier: '200ITINS', numTrips: 200 }],
  ];

  it.each(variants)('%s: el único PCC del JSON es el de la config', (_name, c, options) => {
    const body = build(c, { homePcc: FAKE_PCC }, options);
    expect(collectValues(body, 'PseudoCityCode')).toEqual([FAKE_PCC]);
  });

  it.each(variants)('%s: ningún PCC de la colección aparece en el JSON', (_name, c, options) => {
    const json = JSON.stringify(build(c, { homePcc: FAKE_PCC }, options)).toUpperCase();
    for (const banned of PCC_DENYLIST) {
      expect(json).not.toContain(banned.toUpperCase());
    }
  });

  it('cambiar el PCC de la config cambia el body y no deja rastro del anterior', () => {
    const first = JSON.stringify(build({}, { homePcc: 'AB1C' }));
    const second = JSON.stringify(build({}, { homePcc: FAKE_PCC }));
    expect(first).toContain('AB1C');
    expect(second).not.toContain('AB1C');
    expect(second).toContain(FAKE_PCC);
  });

  it('las credenciales nunca entran en el body: sólo el PCC lo hace', () => {
    const json = JSON.stringify(build({}, { epr: '500001', password: 'Pa55w0rd!' }));
    expect(json).not.toContain('Pa55w0rd!');
    expect(json).not.toContain('500001');
  });
});
