import type { FareComponent, Offer, Segment } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_PREFERENCE,
  OfferDedupeError,
  dedupeFlightOffers,
  flightProductKey,
} from './offer-dedupe.js';

interface SegmentSpec {
  carrier?: string;
  flightNumber?: string;
  departureAt?: string;
  cabin?: Segment['cabin'];
  bookingClass?: string;
  operatingCarrier?: string;
  operatingFlightNumber?: string;
}

function segment(spec: SegmentSpec = {}): Segment {
  return {
    carrier: spec.carrier ?? 'LA',
    flightNumber: spec.flightNumber ?? '2437',
    origin: 'BOG',
    destination: 'LIM',
    departureAt: spec.departureAt ?? '2026-12-01T08:00:00-05:00',
    arrivalAt: '2026-12-01T11:30:00-05:00',
    durationMinutes: 210,
    cabin: spec.cabin ?? 'economy',
    bookingClass: spec.bookingClass ?? 'Y',
    ...(spec.operatingCarrier === undefined ? {} : { operatingCarrier: spec.operatingCarrier }),
    ...(spec.operatingFlightNumber === undefined
      ? {}
      : { operatingFlightNumber: spec.operatingFlightNumber }),
  };
}

type FareComponentSpec = FareComponent;

interface OfferSpec {
  id?: string;
  provider?: string;
  source?: string;
  offerRef?: string;
  amountMinor?: number;
  currency?: string;
  products?: Offer['products'];
  itineraries?: Segment[][] | null;
  checkedBags?: number;
  policies?: { refundable: boolean; changeable: boolean };
  fareFamilyName?: string;
  fareComponents?: readonly FareComponentSpec[];
  providerRaw?: NonNullable<Offer['provider']['raw']>;
  priced?: boolean;
}

function offer(spec: OfferSpec = {}): Offer {
  const provider = spec.provider ?? 'latam-ndc';
  const amountMinor = spec.amountMinor ?? 100_000;
  const currency = spec.currency ?? 'USD';
  const segs = spec.itineraries === undefined ? [[segment()]] : spec.itineraries;

  const result = {
    id: spec.id ?? `${provider}-${amountMinor}`,
    tenantId: '11111111-1111-4111-8111-111111111111',
    products: spec.products ?? ['flight'],
    provider: {
      name: provider,
      offerRef: spec.offerRef ?? `${provider}-REF`,
      ...(spec.source === undefined ? {} : { source: spec.source }),
      ...(spec.providerRaw === undefined ? {} : { raw: spec.providerRaw }),
    },
    total: { amountMinor, currency },
    baseFare: { amountMinor: Math.round(amountMinor * 0.8), currency },
    taxes: { amountMinor: Math.round(amountMinor * 0.2), currency },
    ...(segs === null
      ? {}
      : {
          itineraries: segs.map((s) => ({
            segments: s,
            totalDurationMinutes: 210,
            stops: s.length - 1,
          })),
        }),
    ...(spec.checkedBags === undefined
      ? {}
      : {
          baggage: {
            personalItem: 1,
            carryOn: { qty: 1 },
            checked: { qty: spec.checkedBags },
          },
        }),
    ...(spec.policies === undefined ? {} : { policies: spec.policies }),
    ...(spec.fareFamilyName === undefined
      ? {}
      : { fareFamily: { name: spec.fareFamilyName, cabin: 'economy' as const } }),
    ...(spec.fareComponents === undefined ? {} : { fareComponents: spec.fareComponents }),
    ...(spec.priced === true
      ? {
          pricing: {
            costMinor: amountMinor,
            finalMinor: amountMinor + 5_000,
            ownMarkupMinor: 5_000,
            currency,
          },
        }
      : {}),
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
  return result as Offer;
}

const codes = (offers: Offer[]): string[] => offers.map((o) => o.provider.name);

describe('dedupeFlightOffers — el mismo vuelo por dos fuentes', () => {
  it('colapsa en UNA oferta y gana LATAM NDC directo', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', source: 'ATPCO', checkedBags: 1 }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.provider.name).toBe('latam-ndc');
  });

  it('LATAM directo gana AUNQUE la copia por Sabre sea más barata', () => {
    // Es preferencia declarada, no precio (RF-06 CA-5): una copia más barata por un carril sin
    // post-venta no es más barata.
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', amountMinor: 50_000, checkedBags: 1 }),
      offer({ provider: 'latam-ndc', amountMinor: 100_000, checkedBags: 1 }),
    ]);
    expect(out.map((o) => o.provider.name)).toEqual(['latam-ndc']);
  });

  it('la preferencia por defecto es exactamente LATAM NDC directo', () => {
    expect(DEFAULT_PROVIDER_PREFERENCE).toEqual([{ provider: 'latam-ndc' }]);
  });
});

describe('dedupeFlightOffers — familias tarifarias del mismo proveedor', () => {
  it('conserva diferencias de marca, programa, base y clase en CADA componente', () => {
    const first: FareComponentSpec = {
      segmentRefs: [0],
      brand: { code: 'MAIN', name: 'Main Cabin', programCode: 'AA', programId: 1 },
      fareBasisCode: 'YMAIN1',
      bookingClasses: ['Y'],
    };
    const second: FareComponentSpec = {
      segmentRefs: [1],
      brand: { code: 'MAIN', name: 'Main Cabin', programCode: 'AA', programId: 1 },
      fareBasisCode: 'YMAIN2',
      bookingClasses: ['Y'],
    };
    const family = (secondComponent: FareComponentSpec): readonly FareComponentSpec[] => [
      first,
      secondComponent,
    ];
    const roundTrip = [
      [segment()],
      [segment({ flightNumber: '2440', departureAt: '2026-12-08T08:00:00-05:00' })],
    ];

    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'base',
        itineraries: roundTrip,
        fareComponents: family(second),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'brand-code',
        itineraries: roundTrip,
        fareComponents: family({ ...second, brand: { ...second.brand, code: 'MAINFL' } }),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'brand-name',
        itineraries: roundTrip,
        fareComponents: family({ ...second, brand: { ...second.brand, name: 'Main Flexible' } }),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'program-code',
        itineraries: roundTrip,
        fareComponents: family({ ...second, brand: { ...second.brand, programCode: 'AA-FLEX' } }),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'program-id',
        itineraries: roundTrip,
        fareComponents: family({ ...second, brand: { ...second.brand, programId: 2 } }),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'fare-basis',
        itineraries: roundTrip,
        fareComponents: family({ ...second, fareBasisCode: 'YFLEX2' }),
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'booking-class',
        itineraries: roundTrip,
        fareComponents: family({ ...second, bookingClasses: ['B'] }),
      }),
    ]);

    expect(out.map((item) => item.id)).toEqual([
      'base',
      'brand-code',
      'brand-name',
      'program-code',
      'program-id',
      'fare-basis',
      'booking-class',
    ]);
  });

  it('colapsa copias de la MISMA identidad normalizando espacios y mayúsculas', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'cara',
        amountMinor: 120_000,
        fareComponents: [
          {
            segmentRefs: [0],
            brand: { code: ' main ', name: ' Main   Cabin ', programCode: ' aa ', programId: 1 },
            fareBasisCode: ' ymain ',
            bookingClasses: [' y '],
          },
        ],
      }),
      offer({
        provider: 'sabre',
        checkedBags: 1,
        id: 'barata',
        amountMinor: 90_000,
        fareComponents: [
          {
            segmentRefs: [0],
            brand: { code: 'MAIN', name: 'MAIN CABIN', programCode: 'AA', programId: 1 },
            fareBasisCode: 'YMAIN',
            bookingClasses: ['Y'],
          },
        ],
      }),
    ]);

    expect(out.map((item) => item.id)).toEqual(['barata']);
  });

  it('soporta las ofertas Sabre antiguas con brandCode, nombre y flights en provider.raw', () => {
    const main = offer({
      provider: 'sabre',
      checkedBags: 1,
      id: 'main',
      fareFamilyName: 'Main Cabin',
      providerRaw: { brandCode: 'MAIN', flights: [{ bookingClass: 'Y' }] },
    });
    const flexible = offer({
      provider: 'sabre',
      checkedBags: 1,
      id: 'flexible',
      fareFamilyName: 'Main Cabin Flexible',
      providerRaw: { brandCode: 'MAINFL', flights: [{ bookingClass: 'B' }] },
    });

    expect(dedupeFlightOffers([main, flexible]).map((item) => item.id)).toEqual([
      'main',
      'flexible',
    ]);
  });

  it('mantiene el dedupe cross-provider aunque las marcas y clases se llamen distinto', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        fareFamilyName: 'Main Cabin',
        providerRaw: { brandCode: 'MAIN', flights: [{ bookingClass: 'Y' }] },
      }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        fareFamilyName: 'Full',
        itineraries: [[segment({ bookingClass: 'B' })]],
      }),
    ]);

    expect(codes(out)).toEqual(['latam-ndc']);
  });

  it('conserva todas las familias únicas del proveedor que gana el producto', () => {
    const out = dedupeFlightOffers(
      [
        offer({
          provider: 'sabre',
          checkedBags: 1,
          id: 'main',
          providerRaw: { brandCode: 'MAIN', flights: [{ bookingClass: 'Y' }] },
        }),
        offer({ provider: 'otro', checkedBags: 1, id: 'otro' }),
        offer({
          provider: 'sabre',
          checkedBags: 1,
          id: 'flex',
          providerRaw: { brandCode: 'MAINFL', flights: [{ bookingClass: 'B' }] },
        }),
      ],
      { preference: [{ provider: 'sabre' }] },
    );

    expect(out.map((item) => item.id)).toEqual(['main', 'flex']);
  });
});

describe('dedupeFlightOffers — identidad del vuelo operado (RF-06 CA-2)', () => {
  it('un codeshare con transportista Y número operados colapsa con el vuelo directo', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        itineraries: [
          [
            segment({
              carrier: 'IB',
              flightNumber: '6025',
              operatingCarrier: 'LA',
              operatingFlightNumber: '2437',
            }),
          ],
        ],
      }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ]);
    expect(codes(out)).toEqual(['latam-ndc']);
  });

  it('con transportista operador pero SIN número operado NO se inventa la identidad', () => {
    // Fabricar `LA` + el número de IB daría un vuelo que no existe y que puede chocar con un
    // `LA` real distinto: eso escondería una opción real, no un duplicado.
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        itineraries: [[segment({ carrier: 'IB', flightNumber: '2437', operatingCarrier: 'LA' })]],
      }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('si el operador es el propio comercializador, el número comercializado ES el operado', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        itineraries: [[segment({ carrier: 'LA', flightNumber: '2437', operatingCarrier: 'LA' })]],
      }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ]);
    expect(codes(out)).toEqual(['latam-ndc']);
  });

  it('dos vuelos distintos del mismo transportista no colapsan', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1 }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        itineraries: [[segment({ flightNumber: '2438' })]],
      }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('dedupeFlightOffers — la clave es de PRODUCTO, no de itinerario', () => {
  it('la misma aeronave con y sin maleta son DOS productos', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1 }),
      offer({ provider: 'latam-ndc', checkedBags: 0 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('"no declara equipaje" NO es "no lleva equipaje"', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre' }),
      offer({ provider: 'latam-ndc', checkedBags: 0 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('políticas de cambio/devolución distintas son dos productos', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        policies: { refundable: true, changeable: true },
      }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        policies: { refundable: false, changeable: true },
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('"no declara políticas" NO es "no reembolsable ni cambiable"', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1 }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        policies: { refundable: false, changeable: false },
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('el mismo tramo en cabinas distintas son dos productos', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1 }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        itineraries: [[segment({ cabin: 'business' })]],
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('ida y vuelta invertidas no son el mismo producto', () => {
    const ida = segment({ flightNumber: '2437' });
    const vuelta = segment({ flightNumber: '2440', departureAt: '2026-12-08T08:00:00-05:00' });
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1, itineraries: [[ida], [vuelta]] }),
      offer({ provider: 'latam-ndc', checkedBags: 1, itineraries: [[vuelta], [ida]] }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('dedupeFlightOffers — horas en UTC (RF-06 CA-3)', () => {
  it('el mismo instante escrito con offset y con Z colapsa', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        itineraries: [[segment({ departureAt: '2026-12-01T13:00:00Z' })]],
      }),
      offer({
        provider: 'latam-ndc',
        checkedBags: 1,
        itineraries: [[segment({ departureAt: '2026-12-01T08:00:00-05:00' })]],
      }),
    ]);
    expect(codes(out)).toEqual(['latam-ndc']);
  });

  it('una salida a otra hora no colapsa', () => {
    const out = dedupeFlightOffers([
      offer({
        provider: 'sabre',
        checkedBags: 1,
        itineraries: [[segment({ departureAt: '2026-12-01T14:00:00Z' })]],
      }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('una fecha no interpretable deja la oferta fuera del dedupe', () => {
    const rota = { departureAt: 'mañana temprano' };
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1, itineraries: [[segment(rota)]] }),
      offer({ provider: 'latam-ndc', checkedBags: 1, itineraries: [[segment(rota)]] }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('dedupeFlightOffers — con más de una moneda no se deduplica NADA', () => {
  it('deja intacto hasta el par que sí comparte moneda', () => {
    const entrada = [
      offer({ provider: 'sabre', checkedBags: 1, currency: 'USD' }),
      offer({ provider: 'latam-ndc', checkedBags: 1, currency: 'USD' }),
      offer({ provider: 'otro', checkedBags: 1, currency: 'COP', amountMinor: 400_000_000 }),
    ];
    expect(dedupeFlightOffers(entrada)).toHaveLength(3);
  });

  it('con una sola moneda sí deduplica', () => {
    const entrada = [
      offer({ provider: 'sabre', checkedBags: 1, currency: 'COP', amountMinor: 400_000_000 }),
      offer({ provider: 'latam-ndc', checkedBags: 1, currency: 'COP', amountMinor: 400_000_000 }),
    ];
    expect(dedupeFlightOffers(entrada)).toHaveLength(1);
  });
});

describe('dedupeFlightOffers — desempate total y estable', () => {
  it('sin preferencia declarada gana el más barato', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', checkedBags: 1, amountMinor: 120_000 }),
      offer({ provider: 'otro', checkedBags: 1, amountMinor: 90_000 }),
    ]);
    expect(codes(out)).toEqual(['otro']);
  });

  it('a igual preferencia y precio, el ganador no depende del orden de llegada', () => {
    const a = offer({ provider: 'sabre', checkedBags: 1, id: 'a' });
    const b = offer({ provider: 'otro', checkedBags: 1, id: 'b' });
    expect(codes(dedupeFlightOffers([a, b]))).toEqual(codes(dedupeFlightOffers([b, a])));
  });

  it('a igual proveedor y precio desempata por offerRef y luego por id', () => {
    const base = { provider: 'sabre', checkedBags: 1 } as const;
    const uno = offer({ ...base, offerRef: 'B', id: 'z' });
    const dos = offer({ ...base, offerRef: 'A', id: 'y' });
    expect(dedupeFlightOffers([uno, dos])[0]?.provider.offerRef).toBe('A');

    const mismoRef1 = offer({ ...base, offerRef: 'A', id: 'z' });
    const mismoRef2 = offer({ ...base, offerRef: 'A', id: 'y' });
    expect(dedupeFlightOffers([mismoRef1, mismoRef2])[0]?.id).toBe('y');
  });

  it('la preferencia puede distinguir el CARRIL de contenido dentro de un proveedor', () => {
    const out = dedupeFlightOffers(
      [
        offer({ provider: 'sabre', source: 'ATPCO', checkedBags: 1, amountMinor: 90_000 }),
        offer({ provider: 'sabre', source: 'NDC', checkedBags: 1, amountMinor: 120_000 }),
      ],
      { preference: [{ provider: 'sabre', source: 'NDC' }] },
    );
    expect(out[0]?.provider.source).toBe('NDC');
  });

  it('una preferencia con `source` no casa con la oferta que no declara carril', () => {
    const out = dedupeFlightOffers(
      [
        offer({ provider: 'sabre', checkedBags: 1, amountMinor: 120_000, id: 'sin-carril' }),
        offer({ provider: 'sabre', source: 'NDC', checkedBags: 1, amountMinor: 130_000 }),
      ],
      { preference: [{ provider: 'sabre', source: 'NDC' }] },
    );
    expect(out[0]?.provider.source).toBe('NDC');
  });
});

describe('dedupeFlightOffers — orden de salida', () => {
  it('el ganador ocupa la posición del PRIMERO de su grupo y el resto no se mueve', () => {
    const sabre = offer({ provider: 'sabre', checkedBags: 1 });
    const otroVuelo = offer({
      provider: 'otro',
      checkedBags: 1,
      itineraries: [[segment({ flightNumber: '9999' })]],
    });
    const latam = offer({ provider: 'latam-ndc', checkedBags: 1 });

    expect(codes(dedupeFlightOffers([sabre, otroVuelo, latam]))).toEqual(['latam-ndc', 'otro']);
  });

  it('no muta la lista de entrada', () => {
    const entrada = [
      offer({ provider: 'sabre', checkedBags: 1 }),
      offer({ provider: 'latam-ndc', checkedBags: 1 }),
    ];
    dedupeFlightOffers(entrada);
    expect(entrada).toHaveLength(2);
  });

  it('listas de 0 y 1 oferta salen tal cual', () => {
    expect(dedupeFlightOffers([])).toEqual([]);
    const una = [offer()];
    expect(dedupeFlightOffers(una)).toEqual(una);
  });
});

describe('flightProductKey — qué NO participa del dedupe', () => {
  it('un paquete vuelo+hotel no participa aunque comparta itinerario', () => {
    const paquete = offer({ products: ['flight', 'hotel'], checkedBags: 1 });
    expect(flightProductKey(paquete)).toBeNull();

    const out = dedupeFlightOffers([paquete, offer({ provider: 'latam-ndc', checkedBags: 1 })]);
    expect(out).toHaveLength(2);
  });

  it('una oferta sin itinerarios no participa', () => {
    expect(flightProductKey(offer({ itineraries: null }))).toBeNull();
    expect(flightProductKey(offer({ itineraries: [] }))).toBeNull();
  });

  it('dos ofertas sin itinerarios no colapsan entre sí', () => {
    const out = dedupeFlightOffers([
      offer({ provider: 'sabre', itineraries: null }),
      offer({ provider: 'latam-ndc', itineraries: null }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('dos ofertas del mismo producto sí comparten clave', () => {
    const a = flightProductKey(offer({ provider: 'sabre', checkedBags: 1 }));
    const b = flightProductKey(offer({ provider: 'latam-ndc', checkedBags: 1 }));
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});

describe('dedupeFlightOffers — corre ANTES de withPricing (RF-06 CA-4)', () => {
  it('falla ruidosamente si le llegan ofertas con el waterfall ya aplicado', () => {
    expect(() =>
      dedupeFlightOffers([
        offer({ provider: 'sabre', checkedBags: 1, priced: true }),
        offer({ provider: 'latam-ndc', checkedBags: 1 }),
      ]),
    ).toThrow(OfferDedupeError);
  });

  it('el motivo dice cuántas venían con pricing, para que el cableado sea evidente', () => {
    expect(() => dedupeFlightOffers([offer({ priced: true })])).toThrow(/1 de 1/);
  });

  it('sin pricing no molesta', () => {
    expect(() => dedupeFlightOffers([offer(), offer({ provider: 'sabre' })])).not.toThrow();
  });
});
