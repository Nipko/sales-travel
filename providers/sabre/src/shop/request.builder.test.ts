import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreConfigError } from '../errors';
import {
  SABRE_BFM_VERSION,
  SABRE_DATA_SOURCES,
  SABRE_SHOP_PATH,
  buildSabreShopRequest,
  type SabreShopOptions,
  type SabreShopRequestScope,
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
  scope: SabreShopRequestScope = {},
): SabreShopRequest['OTA_AirLowFareSearchRQ'] {
  return buildSabreShopRequest(criteria(c), cfg(config), options, scope).OTA_AirLowFareSearchRQ;
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

/** Sube hasta la raíz del monorepo: vitest puede arrancar desde la raíz o desde el paquete. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

/**
 * Fuentes de `TPA_Extensions.DataSources` y su `enum`, leídas de `bargain-finder-max-v5.yml`
 * (`:6237-6262`) sin cargar un parser de YAML de 3,9 MB. El bloque es plano y de indentación fija,
 * y `spec-manifest.test.ts` ya vigila que el `.yml` no cambie por debajo.
 */
function specDataSources(): ReadonlyMap<string, readonly string[]> {
  const spec = readFileSync(
    join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'specs', 'bargain-finder-max-v5.yml'),
    'utf8',
  ).split(/\r?\n/);
  const header = '    OTA_AirLowFareSearchRQ.TravelPreferences.TPA_Extensions.DataSources:';
  const start = spec.findIndex((line) => line === header);
  if (start < 0) throw new Error('no se encontró DataSources en el contrato de BFM v5');

  const sources = new Map<string, string[]>();
  let current: string[] | undefined;
  let insideEnum = false;
  for (const line of spec.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) break;
    const property = /^ {8}([A-Za-z]+):\s*$/.exec(line);
    if (property?.[1] !== undefined) {
      current = [];
      sources.set(property[1], current);
      insideEnum = false;
      continue;
    }
    if (/^ {10}enum:\s*$/.test(line)) {
      insideEnum = true;
      continue;
    }
    const value = /^ {12}- (.+)$/.exec(line);
    if (insideEnum && current !== undefined && value?.[1] !== undefined) {
      current.push(value[1].trim());
      continue;
    }
    insideEnum = false;
  }
  if (sources.size === 0) throw new Error('DataSources sin propiedades en el contrato');
  return sources;
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
    // Sobre el CAMPO, no sobre el objeto entero: `PriceRequestInformation` es también donde
    // cuelgan las marcas tarifarias, y un `toEqual` del objeto convierte este test de moneda
    // en un test de "qué más hay ahí dentro", que no es lo suyo.
    expect(build({ currency }).TravelerInfoSummary.PriceRequestInformation.CurrencyCode).toBe(
      currency,
    );
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
    ['con contenido NDC', { ndcContent: true }],
    ['sin contenido NDC', { ndcContent: false }],
  ];

  it.each(optionCases)('%s sigue valiendo true', (_name, options) => {
    expect(build({}, {}, options).TPA_Extensions.IntelliSellTransaction).toMatchObject({
      MultipleSourcePerItinerary: { Value: true },
    });
  });
});

describe('DataSources: ATPCO siempre, NDC sólo si la cuenta lo habilita, LCC fuera', () => {
  it('por defecto NO pide NDC: el mapper lo descartaría y se paga en latencia y payload', () => {
    expect(build().TravelPreferences.TPA_Extensions.DataSources).toEqual({
      NDC: 'Disable',
      ATPCO: 'Enable',
      LCC: 'Disable',
    });
  });

  it('con ndcContent pide NDC y ATPCO en la misma llamada', () => {
    expect(
      build({}, {}, { ndcContent: true }).TravelPreferences.TPA_Extensions.DataSources,
    ).toEqual({ NDC: 'Enable', ATPCO: 'Enable', LCC: 'Disable' });
  });

  it('ndcContent false explícito es lo mismo que no decir nada', () => {
    expect(
      build({}, {}, { ndcContent: false }).TravelPreferences.TPA_Extensions.DataSources,
    ).toEqual(build().TravelPreferences.TPA_Extensions.DataSources);
  });

  it('el valor llega así al cable, no sólo al objeto', () => {
    const encendido = JSON.stringify(
      buildSabreShopRequest(criteria(), cfg(), { ndcContent: true }),
    );
    const apagado = JSON.stringify(buildSabreShopRequest(criteria(), cfg()));
    expect(encendido).toContain('"DataSources":{"NDC":"Enable","ATPCO":"Enable","LCC":"Disable"}');
    expect(apagado).toContain('"DataSources":{"NDC":"Disable","ATPCO":"Enable","LCC":"Disable"}');
  });

  it('encender NDC en una petición no lo enciende en la siguiente: el default no se muta', () => {
    const encendida = build({}, {}, { ndcContent: true });
    const siguiente = build();
    expect(encendida.TravelPreferences.TPA_Extensions.DataSources.NDC).toBe('Enable');
    expect(siguiente.TravelPreferences.TPA_Extensions.DataSources.NDC).toBe('Disable');
    expect(SABRE_DATA_SOURCES.NDC).toBe('Disable');
    expect(encendida.TravelPreferences.TPA_Extensions.DataSources).not.toBe(SABRE_DATA_SOURCES);
  });

  it.each([['true'], ['Enable'], [1], [null]])(
    'ndcContent=%j no es un booleano: falla con error tipado y sin repetir el valor',
    (valor) => {
      const options = { ndcContent: valor } as unknown as SabreShopOptions;
      let mensaje = '';
      try {
        build({}, {}, options);
      } catch (err) {
        expect(err).toBeInstanceOf(SabreConfigError);
        mensaje = (err as Error).message;
      }
      expect(mensaje).toContain('ndcContent');
      expect(mensaje).not.toContain('Enable');
    },
  );

  it('ndcContent no cambia nada fuera de DataSources.NDC', () => {
    const conNdc = build({}, {}, { ndcContent: true });
    const sinNdc = build();
    const { DataSources: _a, ...restoConNdc } = conNdc.TravelPreferences.TPA_Extensions;
    const { DataSources: _b, ...restoSinNdc } = sinNdc.TravelPreferences.TPA_Extensions;
    expect(restoConNdc).toEqual(restoSinNdc);
    expect(conNdc.TPA_Extensions).toEqual(sinNdc.TPA_Extensions);
    expect(conNdc.TravelerInfoSummary).toEqual(sinNdc.TravelerInfoSummary);
    expect(conNdc.POS).toEqual(sinNdc.POS);
  });

  it.each([
    ['apagado por defecto', {}],
    ['encendido por cuenta', { ndcContent: true }],
  ] as const)(
    'con NDC %s, cada fuente y cada valor existen en el contrato congelado',
    (_caso, options) => {
      // `Disable` en NDC es un valor que este builder nunca había mandado. El enum sale del `.yml`
      // y no de memoria: una errata (`Disabled`) no la rechaza nadie hasta que Sabre responde.
      const contrato = specDataSources();
      const enviadas = build({}, {}, options).TravelPreferences.TPA_Extensions.DataSources;

      expect(Object.keys(enviadas).sort()).toEqual([...contrato.keys()].sort());
      for (const [fuente, valor] of Object.entries(enviadas)) {
        expect(contrato.get(fuente)).toContain(valor);
      }
    },
  );

  it('el contrato declara las tres fuentes con Enable|Disable', () => {
    expect(Object.fromEntries(specDataSources())).toEqual({
      ATPCO: ['Enable', 'Disable'],
      LCC: ['Enable', 'Disable'],
      NDC: ['Enable', 'Disable'],
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

describe('scope interno de carrier para BrandFilters', () => {
  it('la búsqueda normal permanece multi-carrier y no manda VendorPref', () => {
    expect(build().TravelPreferences.VendorPref).toBeUndefined();
  });

  it('una ronda auxiliar pide sólo el marketing carrier indicado', () => {
    const body = build({}, {}, { excludeBrands: ['BASIC'] }, { onlyMarketingCarrier: 'AA' });

    expect(body.TravelPreferences.VendorPref).toEqual([
      { Code: 'AA', PreferLevel: 'Only', Type: 'Marketing' },
    ]);
    expect(
      body.TravelerInfoSummary.PriceRequestInformation.TPA_Extensions?.BrandedFareIndicators
        .BrandFilters,
    ).toEqual({ Brand: [{ Code: 'BASIC', PreferLevel: 'Unacceptable' }] });
  });

  it('no permite construir BrandFilters globales sin aislar una aerolínea', () => {
    expect(() => build({}, {}, { excludeBrands: ['BASIC'] })).toThrow(
      /excludeBrands requiere onlyMarketingCarrier/,
    );
  });

  it('rechaza un carrier inválido antes de construir el request', () => {
    expect(() => build({}, {}, {}, { onlyMarketingCarrier: 'aa' })).toThrow(SabreConfigError);
    expect(() => build({}, {}, {}, { onlyMarketingCarrier: 'AAAA' })).toThrow(SabreConfigError);
  });
});

describe('Anchored Search y marcas por trayecto (docs/sabre/15 §2.5)', () => {
  const IDA = {
    flightNumber: 4402,
    departureDateTime: '2026-11-12T07:00:00',
    arrivalDateTime: '2026-11-12T11:10:00',
    origin: 'BOG',
    destination: 'MIA',
    marketingCarrier: 'LA',
    operatingCarrier: 'LA',
  } as const;
  const idaYVuelta = { returnDate: '2026-11-19' };

  it('fija la ida con sus vuelos y deja la vuelta libre', () => {
    const body = build(idaYVuelta, {}, {}, { fixedOutbound: [IDA] });

    expect(body.OriginDestinationInformation[0]).toMatchObject({
      Fixed: true,
      TPA_Extensions: {
        SegmentType: { Code: 'O' },
        Flight: [
          {
            Number: 4402,
            DepartureDateTime: '2026-11-12T07:00:00',
            ArrivalDateTime: '2026-11-12T11:10:00',
            Type: 'A',
            OriginLocation: { LocationCode: 'BOG' },
            DestinationLocation: { LocationCode: 'MIA' },
            Airline: { Marketing: 'LA', Operating: 'LA' },
          },
        ],
      },
    });
    expect(body.OriginDestinationInformation[1]).not.toHaveProperty('Fixed');
    expect(body.OriginDestinationInformation[1]).not.toHaveProperty('TPA_Extensions');
  });

  it('el filtro de marca va en el trayecto pedido, no en el request', () => {
    const body = build(
      idaYVuelta,
      {},
      {},
      {
        onlyMarketingCarrier: 'LA',
        legBrandFilters: [
          { leg: 0, preferred: ['SL'] },
          { leg: 1, excluded: ['SL'] },
        ],
      },
    );

    expect(body.OriginDestinationInformation[0]?.TPA_Extensions?.BrandFilters).toEqual({
      Brand: [{ Code: 'SL', PreferLevel: 'Preferred' }],
    });
    expect(body.OriginDestinationInformation[1]?.TPA_Extensions?.BrandFilters).toEqual({
      Brand: [{ Code: 'SL', PreferLevel: 'Unacceptable' }],
    });
    expect(
      body.TravelerInfoSummary.PriceRequestInformation.TPA_Extensions?.BrandedFareIndicators,
    ).toEqual({ SingleBrandedFare: true, ReturnBrandAncillaries: true });
  });

  it('excluir marcas en un trayecto también exige aislar la aerolínea', () => {
    expect(() =>
      build(idaYVuelta, {}, {}, { legBrandFilters: [{ leg: 1, excluded: ['SL'] }] }),
    ).toThrow(/onlyMarketingCarrier/);
  });

  it('rechaza lo que no se puede mandar: solo ida anclada, trayecto inexistente, marcas apagadas', () => {
    expect(() => build({}, {}, {}, { fixedOutbound: [IDA] })).toThrow(/ida y vuelta/);
    expect(() => build({}, {}, {}, { legBrandFilters: [{ leg: 1, preferred: ['SL'] }] })).toThrow(
      /trayecto/,
    );
    expect(() =>
      build(
        idaYVuelta,
        {},
        { brandedFares: 'off' },
        { legBrandFilters: [{ leg: 0, preferred: ['SL'] }] },
      ),
    ).toThrow(/pedir marcas/);
    expect(() =>
      build(idaYVuelta, {}, {}, { fixedOutbound: [{ ...IDA, departureDateTime: '2026-11-12' }] }),
    ).toThrow(SabreConfigError);
    expect(() =>
      build(idaYVuelta, {}, {}, { legBrandFilters: [{ leg: 0, preferred: ['s l'] }] }),
    ).toThrow(SabreConfigError);
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
  it('por defecto pide la capacidad ENTERA del tier, no un número suelto', () => {
    const body = build();
    expect(body.TPA_Extensions.IntelliSellTransaction.RequestType).toEqual({ Name: '50ITINS' });
    expect(body.TravelPreferences.TPA_Extensions.NumTrips).toEqual({ Number: 50 });
  });

  it('subir el tier sube los itinerarios pedidos sin tocar nada más', () => {
    const body = build({}, {}, { itineraryTier: '200ITINS' });
    expect(body.TravelPreferences.TPA_Extensions.NumTrips).toEqual({ Number: 200 });
  });

  it('pedir más de lo que da el tier se acota al tier, no se manda de más', () => {
    // Sabre no rechaza el exceso: devuelve los del tier —o cero— y el request queda mintiendo
    // sobre lo que se pidió. Acotar acá deja el log y el cable diciendo lo mismo.
    const body = build({}, {}, { itineraryTier: '50ITINS', numTrips: 200 });
    expect(body.TravelPreferences.TPA_Extensions.NumTrips).toEqual({ Number: 50 });
  });

  it('un número explícito por debajo del tier se respeta tal cual', () => {
    const body = build({}, {}, { numTrips: 12 });
    expect(body.TravelPreferences.TPA_Extensions.NumTrips).toEqual({ Number: 12 });
  });

  it('POR DEFECTO pide una sola marca: CERT rechaza el upsell nativo', () => {
    // El PCC certificado devuelve MIP/PROCESS con MultipleBrandedFares. La cuenta que tenga ese
    // entitlement puede encender `upsell`, pero una cuenta nueva no debe pagar un rechazo y una
    // segunda llamada en cada arranque del proceso.
    expect(build().TravelerInfoSummary.PriceRequestInformation.TPA_Extensions).toEqual({
      BrandedFareIndicators: {
        SingleBrandedFare: true,
        ReturnBrandAncillaries: true,
      },
    });
  });

  it('los atributos de marca se apagan solos, sin tocar la marca (docs/sabre/15 D3)', () => {
    expect(
      build({}, {}, { brandAncillaries: false }).TravelerInfoSummary.PriceRequestInformation
        .TPA_Extensions,
    ).toEqual({ BrandedFareIndicators: { SingleBrandedFare: true } });
  });

  it('sin marcas no se piden atributos: no hay marca de la que colgarlos', () => {
    expect(
      build({}, {}, { brandedFares: 'off', brandAncillaries: true }).TravelerInfoSummary
        .PriceRequestInformation.TPA_Extensions,
    ).toBeUndefined();
  });

  it('`single` pide UNA marca por itinerario y no arrastra el upsell', () => {
    expect(
      build({}, {}, { brandedFares: 'single' }).TravelerInfoSummary.PriceRequestInformation
        .TPA_Extensions,
    ).toEqual({ BrandedFareIndicators: { SingleBrandedFare: true, ReturnBrandAncillaries: true } });
  });

  it('el upsell manda las DOS banderas juntas, como el ejemplo oficial', () => {
    // «Request Example for Single and Multiple Branded Fares» del devhub:
    //   <BrandedFareIndicators SingleBrandedFare="true" MultipleBrandedFares="true"/>
    //
    // Este test existe porque antes afirmaba lo CONTRARIO —que eran excluyentes— sobre una
    // suposición mía que el ejemplo oficial desmiente. Mandar el upsell solo puede haber sido
    // lo que el motor rechazaba con `MIP/PROCESS`.
    const pri = build({}, {}, { brandedFares: 'upsell' }).TravelerInfoSummary
      .PriceRequestInformation;
    expect(pri.TPA_Extensions).toEqual({
      BrandedFareIndicators: {
        SingleBrandedFare: true,
        MultipleBrandedFares: true,
        UpsellLimit: 3,
        ReturnBrandAncillaries: true,
      },
    });
  });

  it('el límite del upsell se respeta tal cual', () => {
    const pri = build({}, {}, { brandedFares: 'upsell', upsellLimit: 5 }).TravelerInfoSummary
      .PriceRequestInformation;
    expect(pri.TPA_Extensions).toEqual({
      BrandedFareIndicators: {
        SingleBrandedFare: true,
        MultipleBrandedFares: true,
        UpsellLimit: 5,
        ReturnBrandAncillaries: true,
      },
    });
  });

  it('apagado, no viaja ningún bloque de marcas', () => {
    const pri = build({}, {}, { brandedFares: 'off' }).TravelerInfoSummary.PriceRequestInformation;
    expect(pri.TPA_Extensions).toBeUndefined();
  });

  it('upsell con límite 0 equivale a apagarlo', () => {
    // Un bloque pidiendo cero marcas es una instrucción; no mandarlo deja el default del
    // proveedor en paz. No es lo mismo.
    const pri = build({}, {}, { brandedFares: 'upsell', upsellLimit: 0 }).TravelerInfoSummary
      .PriceRequestInformation;
    expect(pri.TPA_Extensions).toBeUndefined();
  });

  it('un límite negativo falla en el borde, no se acota en silencio', () => {
    expect(() => build({}, {}, { upsellLimit: -1 })).toThrow(SabreConfigError);
  });

  it('el bloque de MARCAS no se cuela en TravelPreferences: ahí es donde rompía', () => {
    // La avería original: `BrandedFareIndicators` bajo `TravelPreferences…FlexibleFares`. Esa
    // rama acepta el mismo objeto y es OTRA función —MFPI—, y el motor respondió con un fallo
    // de negocio en todas las búsquedas.
    //
    // Ojo: `FlexibleFares` SÍ vive ahí legítimamente, porque es donde se pide MFPI. Lo que no
    // puede aparecer nunca es `BrandedFareIndicators`, ni suelto ni dentro de un grupo.
    const ext = JSON.stringify(build().TravelPreferences.TPA_Extensions);
    expect(ext).not.toContain('BrandedFareIndicators');
    expect(ext).not.toContain('NDCIndicators');
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
