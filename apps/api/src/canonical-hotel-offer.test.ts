import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HotelCancellationSchema,
  HotelOfferSchema,
  HotelRatesQuerySchema,
  HotelRoompackSchema,
  HotelSearchCriteriaSchema,
  type HotelOffer,
  type HotelRoompack,
} from '@sales-travel/canonical';
import {
  HOTEL_BOOK_PORT,
  HOTEL_BOOKING_READ_PORT,
  HOTEL_CANCEL_PORT,
  HOTEL_PREBOOK_PORT,
  HOTEL_SEARCH_PORT,
  type HotelBookingByClientReferencePort,
  type HotelBookingReadPort,
  type HotelBookPort,
  type HotelCancelPort,
  type HotelPrebookPort,
  type HotelSearchPort,
  type OrderCancelResult,
} from '@sales-travel/domain';
import type { z } from '@sales-travel/validation';
import { describe, expect, it } from 'vitest';

/**
 * Contrato neutral de la oferta de hotel y sus puertos (PR-0.2 del plan de hoteles
 * multi-proveedor, RF-35).
 *
 * Vive en `apps/api`, como `canonical-provider-ref.test.ts`, porque `packages/canonical` no
 * tiene script `test`. Nada de producción importa todavía este contrato: estos tests son su
 * única red hasta que el registry de hoteles lo use.
 *
 * El segundo proveedor es un stub anónimo (`stub-hotels`) con la forma de un bedbank que
 * reserva por pack: una sola referencia para varias habitaciones, suplementos en otra moneda y
 * políticas en hora local del hotel.
 */

/** Lo mínimo que un roompack necesita para validar: sin ninguno de los campos opcionales. */
const packMinimo = {
  id: 'RP-1',
  provider: { name: 'stub-hotels', offerRef: 'OFFER-1' },
  board: 'RO',
  rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
  cancellation: { refundable: false, status: 'non_refundable', rules: [] },
  price: { total: { amountMinor: 30575, currency: 'USD' }, taxesDetail: [] },
};

/** Un pack de dos habitaciones con una sola referencia reservable, como lo entrega un bedbank. */
const packPorPaquete: HotelRoompack = {
  id: 'STUB-1120548-2-9a47646b-1bba-4746-91d5-969149db1185',
  provider: {
    name: 'stub-hotels',
    offerRef: 'STUB-1120548-2-9a47646b-1bba-4746-91d5-969149db1185',
    raw: { searchId: 'b6f1d2c4-5e7a-4c1b-9d3e-2f8a7b6c5d4e' },
  },
  board: 'RO',
  boardLabel: 'Solo alojamiento',
  mealTypeRaw: 'Room_Only',
  rooms: [
    {
      name: 'Luxury Room, 1 King Bed',
      reference: 1,
      bedOptions: [],
      occupancy: { adults: 2, childrenAges: [] },
      promotions: ['Private sale'],
    },
    {
      name: 'Luxury Room, 1 King Bed',
      reference: 2,
      bedOptions: [],
      occupancy: { adults: 1, childrenAges: [4, 9] },
      promotions: ['Private sale'],
    },
  ],
  cancellation: {
    refundable: true,
    // El primer tramo cobra 0: así se lee "reembolsable del todo" hasta el tramo siguiente.
    status: 'fully_refundable',
    policySource: 'search-indicative',
    rules: [
      {
        type: 'Fixed',
        fromLocalDateTime: '2026-10-12T00:00:00',
        fromDateRaw: '12-10-2026 00:00:00',
        penaltyAmount: { amountMinor: 0, currency: 'USD' },
      },
      {
        type: 'Percentage',
        penaltyPercentage: 100,
        fromLocalDateTime: '2026-10-14T00:00:00',
        fromDateRaw: '14-10-2026 00:00:00',
        roomIndex: 2,
      },
    ],
    freeCancellationUntilLocal: '2026-10-14T00:00:00',
  },
  price: {
    total: { amountMinor: 30575, currency: 'USD' },
    taxes: { amountMinor: 5624, currency: 'USD' },
    taxesDetail: [],
    minimumSellingPrice: { amountMinor: 32134, currency: 'USD' },
    extraGuestCharges: { amountMinor: 1722, currency: 'USD' },
    nightly: [[{ amountMinor: 12476, currency: 'USD' }], [{ amountMinor: 12476, currency: 'USD' }]],
  },
  expiresAt: '2026-10-01T10:27:00-05:00',
  atPropertyCharges: [
    {
      roomIndex: 1,
      description: 'Impuesto obligatorio',
      descriptionRaw: 'mandatory_tax',
      amount: { amountMinor: 2000, currency: 'AED' },
    },
    {
      roomIndex: 2,
      description: 'Impuesto obligatorio',
      descriptionRaw: 'mandatory_tax',
      amount: { amountMinor: 2000, currency: 'AED' },
    },
  ],
  includesTransfers: false,
  inclusionText: 'Free WiFi',
};

/** Rutas de los problemas que encontró el esquema: afirma POR QUÉ falla, no sólo que falla. */
function rutasDelError(schema: z.ZodTypeAny, valor: unknown): string[] {
  const parsed = schema.safeParse(valor);
  // Un mismo campo puede fallar dos reglas (largo y formato): interesa dónde, no cuántas veces.
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
}

/** El pack de arriba con un cambio aplicado sobre una copia profunda. */
function variante(mutar: (p: HotelRoompack) => void): unknown {
  const copia = structuredClone(packPorPaquete);
  mutar(copia);
  return copia;
}

const criterio = {
  hotelIds: ['101', '205'],
  checkinDate: '2026-10-15',
  checkoutDate: '2026-10-18',
  rooms: [
    { adults: 2, childrenAges: [] },
    { adults: 1, childrenAges: [4, 9] },
  ],
  currency: 'USD',
  guestNationality: 'CO',
};

describe('HotelRoompackSchema — lo mínimo y lo que trae un bedbank', () => {
  it('un pack mínimo valida', () => {
    expect(HotelRoompackSchema.safeParse(packMinimo).success).toBe(true);
  });

  it('un pack de dos habitaciones con una sola referencia valida con todo lo nuevo', () => {
    const parsed = HotelRoompackSchema.safeParse(packPorPaquete);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rooms.map((r) => r.occupancy)).toEqual([
        { adults: 2, childrenAges: [] },
        { adults: 1, childrenAges: [4, 9] },
      ]);
      expect(parsed.data.provider.raw).toEqual({
        searchId: 'b6f1d2c4-5e7a-4c1b-9d3e-2f8a7b6c5d4e',
      });
    }
  });

  it('no rellena nada: un opcional ausente sigue ausente ("no informado")', () => {
    const parsed = HotelRoompackSchema.parse(packMinimo);
    expect(parsed.expiresAt).toBeUndefined();
    expect(parsed.includesTransfers).toBeUndefined();
    expect(parsed.atPropertyCharges).toBeUndefined();
    expect(parsed.cancellation.policySource).toBeUndefined();
  });
});

describe('HotelRoompack.provider — de qué proveedor es cada tarifa', () => {
  it('un pack sin proveedor no valida', () => {
    const { provider: _sinProveedor, ...resto } = packMinimo;
    expect(rutasDelError(HotelRoompackSchema, resto)).toEqual(['provider']);
  });

  it('exige el código del registry, no un nombre legible', () => {
    for (const name of ['despegar-hotels', 'stub-hotels', 'sabre']) {
      const parsed = HotelRoompackSchema.safeParse({
        ...packMinimo,
        provider: { ...packMinimo.provider, name },
      });
      expect(parsed.success, `${name} debería validar`).toBe(true);
    }
    for (const name of ['Despegar Hotels', 'DESPEGAR', 'stub_hotels', '-stub', 'x']) {
      const rutas = rutasDelError(HotelRoompackSchema, {
        ...packMinimo,
        provider: { ...packMinimo.provider, name },
      });
      expect(rutas, JSON.stringify(name)).toEqual(['provider.name']);
    }
  });

  it('provider.raw hereda las reglas de ProviderRefSchema: sólo JSON', () => {
    const conFecha = rutasDelError(HotelRoompackSchema, {
      ...packMinimo,
      provider: { ...packMinimo.provider, raw: { searchedAt: new Date() } },
    });
    expect(conFecha).toEqual(['provider.raw.searchedAt']);

    const conUndefined = rutasDelError(HotelRoompackSchema, {
      ...packMinimo,
      provider: { ...packMinimo.provider, raw: { searchId: undefined } },
    });
    expect(conUndefined).toEqual(['provider.raw.searchId']);

    const anidado = HotelRoompackSchema.safeParse({
      ...packMinimo,
      provider: { ...packMinimo.provider, raw: { searchId: 's-1', ids: [1, 'a', null] } },
    });
    expect(anidado.success).toBe(true);
  });

  it('hereda también el techo de offerRef y la forma de source', () => {
    expect(
      rutasDelError(HotelRoompackSchema, {
        ...packMinimo,
        provider: { ...packMinimo.provider, offerRef: 'x'.repeat(256) },
      }),
    ).toEqual(['provider.offerRef']);
    expect(
      rutasDelError(HotelRoompackSchema, {
        ...packMinimo,
        provider: { ...packMinimo.provider, source: 'direct contract' },
      }),
    ).toEqual(['provider.source']);
  });
});

describe('Monedas del pack', () => {
  it('atPropertyCharges admite una moneda distinta de la del pack', () => {
    // El fixture ya lo hace (AED en un pack en USD); se afirma aparte para que no dependa de él.
    const parsed = HotelRoompackSchema.safeParse(
      variante((p) => {
        p.atPropertyCharges = [
          {
            roomIndex: 1,
            description: 'Tasa municipal',
            descriptionRaw: 'city_tax',
            amount: { amountMinor: 2581, currency: 'KWD' },
          },
        ];
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('includedSupplements también lleva su propia moneda', () => {
    const parsed = HotelRoompackSchema.safeParse(
      variante((p) => {
        p.includedSupplements = [
          {
            roomIndex: 1,
            description: 'Desayuno',
            descriptionRaw: 'breakfast',
            amount: { amountMinor: 1500, currency: 'EUR' },
          },
        ];
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('todo lo que se cobra en la reserva va en la moneda de price.total', () => {
    const casos: Array<[string, (p: HotelRoompack) => void]> = [
      [
        'price.taxes',
        (p) => {
          p.price.taxes = { amountMinor: 5624, currency: 'EUR' };
        },
      ],
      [
        'price.taxesDetail.0.amount',
        (p) => {
          p.price.taxesDetail = [{ code: 'IVA', amount: { amountMinor: 1, currency: 'EUR' } }];
        },
      ],
      [
        'price.minimumSellingPrice',
        (p) => {
          p.price.minimumSellingPrice = { amountMinor: 1, currency: 'COP' };
        },
      ],
      [
        'price.extraGuestCharges',
        (p) => {
          p.price.extraGuestCharges = { amountMinor: 1, currency: 'AED' };
        },
      ],
      [
        'price.chargeAtDestination',
        (p) => {
          p.price.chargeAtDestination = { amountMinor: 1, currency: 'AED' };
        },
      ],
      [
        'price.agencyCommission.amount',
        (p) => {
          p.price.agencyCommission = {
            amount: { amountMinor: 1, currency: 'EUR' },
            percentage: 10,
          };
        },
      ],
      [
        'price.nightly.0.0',
        (p) => {
          p.price.nightly = [[{ amountMinor: 1, currency: 'BRL' }]];
        },
      ],
      [
        'cancellation.rules.0.penaltyAmount',
        (p) => {
          const [primera] = p.cancellation.rules;
          if (primera) primera.penaltyAmount = { amountMinor: 0, currency: 'EUR' };
        },
      ],
    ];
    for (const [ruta, mutar] of casos) {
      expect(rutasDelError(HotelRoompackSchema, variante(mutar))).toEqual([ruta]);
    }
  });

  it('el pricing del waterfall también va en la moneda del pack', () => {
    const conPricing = {
      ...packMinimo,
      pricing: { costMinor: 31000, finalMinor: 33000, ownMarkupMinor: 2000, currency: 'USD' },
    };
    expect(HotelRoompackSchema.safeParse(conPricing).success).toBe(true);
    expect(
      rutasDelError(HotelRoompackSchema, {
        ...conPricing,
        pricing: { ...conPricing.pricing, currency: 'COP' },
      }),
    ).toEqual(['pricing.currency']);
  });

  it('amountText sólo acepta un decimal sin signo', () => {
    const conTexto = (amountText: string): unknown =>
      variante((p) => {
        const [primero] = p.atPropertyCharges ?? [];
        if (primero) primero.amountText = amountText;
      });
    expect(HotelRoompackSchema.safeParse(conTexto('25.810')).success).toBe(true);
    expect(HotelRoompackSchema.safeParse(conTexto('1244729')).success).toBe(true);
    for (const malo of ['-1', '25,81', '1e3', '']) {
      expect(rutasDelError(HotelRoompackSchema, conTexto(malo)), malo).toEqual([
        'atPropertyCharges.0.amountText',
      ]);
    }
  });
});

describe('Índices de habitación', () => {
  it('un cargo o un tramo no pueden apuntar a una habitación que el pack no tiene', () => {
    const cargo = variante((p) => {
      const [primero] = p.atPropertyCharges ?? [];
      if (primero) primero.roomIndex = 3;
    });
    const tramo = variante((p) => {
      const [, segundo] = p.cancellation.rules;
      if (segundo) segundo.roomIndex = 3;
    });
    const incluido = variante((p) => {
      p.includedSupplements = [
        { roomIndex: 3, description: 'Desayuno', amount: { amountMinor: 1500, currency: 'USD' } },
      ];
    });
    expect(rutasDelError(HotelRoompackSchema, cargo)).toEqual(['atPropertyCharges.0.roomIndex']);
    expect(rutasDelError(HotelRoompackSchema, tramo)).toEqual(['cancellation.rules.1.roomIndex']);
    expect(rutasDelError(HotelRoompackSchema, incluido)).toEqual([
      'includedSupplements.0.roomIndex',
    ]);
  });

  it('los índices son base 1: el 0 no es una habitación', () => {
    const cero = variante((p) => {
      const [primero] = p.atPropertyCharges ?? [];
      if (primero) primero.roomIndex = 0;
    });
    expect(rutasDelError(HotelRoompackSchema, cero)).toEqual(['atPropertyCharges.0.roomIndex']);
  });
});

describe('Fechas: vencimiento con zona, políticas en hora local', () => {
  it('expiresAt exige offset', () => {
    expect(
      HotelRoompackSchema.safeParse({ ...packMinimo, expiresAt: '2026-10-01T10:27:00-05:00' })
        .success,
    ).toBe(true);
    expect(
      HotelRoompackSchema.safeParse({ ...packMinimo, expiresAt: '2026-10-01T15:27:00Z' }).success,
    ).toBe(true);
    expect(
      rutasDelError(HotelRoompackSchema, { ...packMinimo, expiresAt: '2026-10-01T10:27:00' }),
    ).toEqual(['expiresAt']);
  });

  it('fromLocalDateTime rechaza cualquier zona, Z incluida', () => {
    const conInicio = (fromLocalDateTime: string): unknown =>
      variante((p) => {
        const [primera] = p.cancellation.rules;
        if (primera) primera.fromLocalDateTime = fromLocalDateTime;
      });
    expect(HotelRoompackSchema.safeParse(conInicio('2026-10-12T00:00:00')).success).toBe(true);
    for (const malo of [
      '2026-10-12T00:00:00-05:00',
      '2026-10-12T00:00:00Z',
      '2026-10-12T00:00',
      '12-10-2026 00:00:00',
      '2026-02-30T00:00:00',
      '2026-10-12T24:00:00',
    ]) {
      expect(rutasDelError(HotelRoompackSchema, conInicio(malo)), malo).toEqual([
        'cancellation.rules.0.fromLocalDateTime',
      ]);
    }
  });

  it('freeCancellationUntilLocal sigue la misma regla', () => {
    const conZona = variante((p) => {
      p.cancellation.freeCancellationUntilLocal = '2026-10-14T00:00:00-05:00';
    });
    expect(rutasDelError(HotelRoompackSchema, conZona)).toEqual([
      'cancellation.freeCancellationUntilLocal',
    ]);
  });
});

describe('HotelCancellationSchema — origen de la política', () => {
  const sinTramos = { refundable: true, status: 'partially_refundable', rules: [] };

  it('reembolsable sin tramos: partially_refundable con origen none', () => {
    expect(HotelCancellationSchema.safeParse({ ...sinTramos, policySource: 'none' }).success).toBe(
      true,
    );
  });

  it('sin haber visto tramos no se puede afirmar fully_refundable', () => {
    expect(
      rutasDelError(HotelCancellationSchema, {
        ...sinTramos,
        status: 'fully_refundable',
        policySource: 'none',
      }),
    ).toEqual(['status']);
  });

  it('sin haber visto tramos tampoco hay fecha de cancelación gratuita', () => {
    expect(
      rutasDelError(HotelCancellationSchema, {
        ...sinTramos,
        policySource: 'none',
        freeCancellationUntilLocal: '2026-10-14T00:00:00',
      }),
    ).toEqual(['freeCancellationUntilLocal']);
  });

  it("origen 'none' con tramos se contradice", () => {
    expect(
      rutasDelError(HotelCancellationSchema, {
        ...sinTramos,
        policySource: 'none',
        rules: [{ type: 'Percentage', penaltyPercentage: 100 }],
      }),
    ).toEqual(['rules']);
  });

  it('acepta los tres orígenes declarables y ninguno más', () => {
    for (const policySource of ['none', 'search-indicative', 'prebook-final']) {
      expect(HotelCancellationSchema.safeParse({ ...sinTramos, policySource }).success).toBe(true);
    }
    expect(
      rutasDelError(HotelCancellationSchema, { ...sinTramos, policySource: 'provider' }),
    ).toEqual(['policySource']);
  });

  it('refundable y status no pueden contradecirse', () => {
    expect(
      rutasDelError(HotelCancellationSchema, {
        refundable: true,
        status: 'non_refundable',
        rules: [],
      }),
    ).toEqual(['refundable']);
    expect(
      rutasDelError(HotelCancellationSchema, {
        refundable: false,
        status: 'partially_refundable',
        rules: [],
      }),
    ).toEqual(['refundable']);
  });
});

describe('HotelOfferSchema — regresión con Despegar', () => {
  /**
   * La salida de `/hotels/availability` de hoy (snapshot de PR-0.1, producido por el mapper
   * real de Despegar) con lo único que el envoltorio del registry le suma: `provider` en cada
   * pack. Si esto deja de validar, el contrato neutral rompió a Despegar.
   */
  const snapshot = JSON.parse(
    readFileSync(join(__dirname, 'hotels', '__fixtures__', 'availability.snapshot.json'), 'utf8'),
  ) as { hotels: Array<{ roompacks: Array<{ id: string }> }> };

  const conProveedor = snapshot.hotels.map((h) => ({
    ...h,
    roompacks: h.roompacks.map((rp) => ({
      ...rp,
      provider: { name: 'despegar-hotels', offerRef: rp.id },
    })),
  }));

  it('cada hotel del snapshot valida con provider en sus packs', () => {
    expect(conProveedor.length).toBeGreaterThan(0);
    for (const hotel of conProveedor) {
      const parsed = HotelOfferSchema.safeParse(hotel);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('validar no pierde ni agrega campos de lo que hoy ve la web', () => {
    for (const hotel of conProveedor) {
      expect(HotelOfferSchema.parse(hotel)).toEqual(hotel);
    }
  });

  it('sin provider en los packs, el mismo snapshot no valida', () => {
    const conPacks = snapshot.hotels.filter((h) => h.roompacks.length > 0);
    expect(conPacks.length).toBeGreaterThan(0);
    for (const hotel of conPacks) {
      const rutas = rutasDelError(HotelOfferSchema, hotel);
      expect(rutas).toEqual(hotel.roompacks.map((_, i) => `roompacks.${i}.provider`));
    }
  });

  it('un hotel sin disponibilidad es una lista de packs vacía, no un error', () => {
    expect(HotelOfferSchema.safeParse({ hotelId: '350', roompacks: [] }).success).toBe(true);
  });
});

describe('HotelOfferSchema — dirección y tarjeta de varios proveedores (PR-2.6)', () => {
  const base = { hotelId: '101', roompacks: [] };

  it('la dirección es una línea opcional, no vacía', () => {
    expect(HotelOfferSchema.safeParse({ ...base, address: 'Calle 1 # 2-3' }).success).toBe(true);
    expect(rutasDelError(HotelOfferSchema, { ...base, address: '' })).toEqual(['address']);
    expect(rutasDelError(HotelOfferSchema, { ...base, address: 'x'.repeat(501) })).toEqual([
      'address',
    ]);
  });

  it('`providerHotels` dice con qué id conoce cada proveedor el hotel de la tarjeta', () => {
    const tarjeta = {
      ...base,
      providerHotels: [
        { provider: 'despegar-hotels', hotelId: '101' },
        { provider: 'tbo-hotels', hotelId: '1120548' },
      ],
    };
    expect(HotelOfferSchema.parse(tarjeta)).toEqual(tarjeta);
  });

  it('sólo existe para una tarjeta que reúne a más de uno, y con códigos del registry', () => {
    expect(
      rutasDelError(HotelOfferSchema, {
        ...base,
        providerHotels: [{ provider: 'despegar-hotels', hotelId: '101' }],
      }),
    ).toEqual(['providerHotels']);
    expect(
      rutasDelError(HotelOfferSchema, {
        ...base,
        providerHotels: [
          { provider: 'Despegar Hotels', hotelId: '101' },
          { provider: 'tbo-hotels', hotelId: '' },
        ],
      }),
    ).toEqual(['providerHotels.0.provider', 'providerHotels.1.hotelId']);
  });
});

describe('HotelSearchCriteriaSchema', () => {
  it('valida un criterio con nacionalidad y moneda de venta', () => {
    expect(HotelSearchCriteriaSchema.safeParse(criterio).success).toBe(true);
  });

  it('la moneda de venta es obligatoria: no hay USD por defecto', () => {
    const { currency: _sinMoneda, ...resto } = criterio;
    expect(rutasDelError(HotelSearchCriteriaSchema, resto)).toEqual(['currency']);
  });

  it('la nacionalidad es opcional pero, si llega, es alfa-2 en mayúsculas', () => {
    const { guestNationality: _sinNacionalidad, ...resto } = criterio;
    expect(HotelSearchCriteriaSchema.safeParse(resto).success).toBe(true);
    for (const malo of ['COL', 'co', 'C']) {
      expect(
        rutasDelError(HotelSearchCriteriaSchema, { ...criterio, guestNationality: malo }),
        malo,
      ).toEqual(['guestNationality']);
    }
  });

  it('la salida tiene que ser posterior a la entrada', () => {
    expect(
      rutasDelError(HotelSearchCriteriaSchema, { ...criterio, checkoutDate: criterio.checkinDate }),
    ).toEqual(['checkoutDate']);
    expect(
      rutasDelError(HotelSearchCriteriaSchema, { ...criterio, checkoutDate: '2026-10-14' }),
    ).toEqual(['checkoutDate']);
  });

  it('entre 1 y 100 hoteles y entre 1 y 8 habitaciones', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));
    expect(HotelSearchCriteriaSchema.safeParse({ ...criterio, hotelIds: ids(100) }).success).toBe(
      true,
    );
    expect(rutasDelError(HotelSearchCriteriaSchema, { ...criterio, hotelIds: ids(101) })).toEqual([
      'hotelIds',
    ]);
    expect(rutasDelError(HotelSearchCriteriaSchema, { ...criterio, hotelIds: [] })).toEqual([
      'hotelIds',
    ]);
    const habitaciones = (n: number): unknown[] =>
      Array.from({ length: n }, () => ({ adults: 1, childrenAges: [] }));
    expect(
      rutasDelError(HotelSearchCriteriaSchema, { ...criterio, rooms: habitaciones(9) }),
    ).toEqual(['rooms']);
  });

  it('las edades de los niños van de 0 a 17: con 18 se viaja como adulto', () => {
    const conEdades = (childrenAges: number[]): unknown => ({
      ...criterio,
      rooms: [{ adults: 1, childrenAges }],
    });
    expect(HotelSearchCriteriaSchema.safeParse(conEdades([0, 17])).success).toBe(true);
    expect(rutasDelError(HotelSearchCriteriaSchema, conEdades([18]))).toEqual([
      'rooms.0.childrenAges.0',
    ]);
    expect(rutasDelError(HotelSearchCriteriaSchema, conEdades([1, 2, 3, 4, 5, 6, 7]))).toEqual([
      'rooms.0.childrenAges',
    ]);
  });

  it('HotelRatesQuery comparte las reglas de la estadía y apunta a un solo hotel', () => {
    const { hotelIds: _ids, ...estadia } = criterio;
    expect(
      HotelRatesQuerySchema.safeParse({ ...estadia, hotelId: '101', roompackId: 'RP-101-A' })
        .success,
    ).toBe(true);
    expect(
      rutasDelError(HotelRatesQuerySchema, {
        ...estadia,
        hotelId: '101',
        checkoutDate: estadia.checkinDate,
      }),
    ).toEqual(['checkoutDate']);
  });
});

describe('Puertos de hotel — chequeo de tipos', () => {
  /**
   * Un adapter con los cinco puertos obligatorios más una capacidad opcional. Si un puerto
   * cambia de forma, esto deja de compilar antes de que lo note el registry.
   */
  type AdapterDeHoteles = HotelSearchPort &
    HotelPrebookPort &
    HotelBookPort &
    HotelBookingReadPort &
    HotelCancelPort &
    HotelBookingByClientReferencePort;

  const pack: HotelRoompack = HotelRoompackSchema.parse(packPorPaquete);

  const adapter: AdapterDeHoteles = {
    searchAvailability: (criteria) =>
      Promise.resolve<HotelOffer[]>(
        criteria.hotelIds.map((hotelId) => ({ hotelId, roompacks: [pack] })),
      ),
    prebook: (request) =>
      Promise.resolve({
        total: pack.price.total,
        roompack: { ...pack, provider: { ...pack.provider, offerRef: request.offer.offerRef } },
        rateConditions: [
          {
            category: 'checkIn',
            text: 'Check-in desde las 15:00',
            raw: 'CheckIn Time-Begin: 3:00 PM ',
          },
        ],
        signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
        warnings: [],
      }),
    book: (request) =>
      Promise.resolve({
        outcome: 'UNCERTAIN',
        bookingReference: request.bookingReference,
        warnings: [],
      }),
    getBooking: (providerBookingId) =>
      Promise.resolve({ found: true, providerBookingId, status: 'CONFIRMED', warnings: [] }),
    getBookingByClientReference: (bookingReference) =>
      Promise.resolve({ found: false, bookingReference, warnings: [] }),
    cancelBooking: () =>
      Promise.resolve({ success: true, bookingStatus: 'CANCELLATION_IN_PROGRESS', warnings: [] }),
  };

  const ctx = { tenantId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };

  it('la búsqueda devuelve ofertas que validan contra el contrato', async () => {
    const offers = await adapter.searchAvailability(HotelSearchCriteriaSchema.parse(criterio), ctx);
    expect(offers).toHaveLength(2);
    for (const offer of offers) {
      expect(HotelOfferSchema.safeParse(offer).success).toBe(true);
      expect(offer.roompacks.map((rp) => rp.provider.name)).toEqual(['stub-hotels']);
    }
  });

  it('el PreBook recibe la referencia y devuelve condiciones y señales cerradas', async () => {
    const result = await adapter.prebook({ offer: pack.provider }, ctx);
    expect(result.roompack?.provider.offerRef).toBe(pack.provider.offerRef);
    expect(result.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
  });

  it('el Book paga con crédito de la cuenta sin ningún dato de tarjeta', async () => {
    const result = await adapter.book(
      {
        offer: pack.provider,
        bookingReference: 'STB-0001',
        rooms: [
          { guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Perez' }] },
          {
            guests: [
              { paxType: 'ADT', title: 'Ms', firstName: 'Ana', lastName: 'Perez' },
              { paxType: 'CHD', firstName: 'Sofia', lastName: 'Perez', age: 4 },
              { paxType: 'CHD', firstName: 'Mateo', lastName: 'Perez', age: 9 },
            ],
          },
        ],
        contact: {
          email: 'reservas@example.com',
          phone: { countryCode: '57', number: '3001234567' },
        },
        payment: { kind: 'agency-credit' },
      },
      ctx,
    );
    expect(result.outcome).toBe('UNCERTAIN');
    expect(result.bookingReference).toBe('STB-0001');
  });

  it('una cancelación aceptada pero no terminada es un OrderCancelResult válido', async () => {
    const result = await adapter.cancelBooking({ providerBookingId: 'CONF-1' }, ctx);
    const generico: OrderCancelResult = result;
    expect(generico.success).toBe(true);
    expect(result.bookingStatus).toBe('CANCELLATION_IN_PROGRESS');
  });

  it('las lecturas distinguen localizador del proveedor y referencia propia', async () => {
    await expect(adapter.getBooking('CONF-1', ctx)).resolves.toMatchObject({
      found: true,
      providerBookingId: 'CONF-1',
    });
    await expect(adapter.getBookingByClientReference('STB-0001', ctx)).resolves.toMatchObject({
      found: false,
      bookingReference: 'STB-0001',
    });
  });

  it('los tokens de DI de los puertos obligatorios salen del paquete compilado', () => {
    expect([
      HOTEL_SEARCH_PORT,
      HOTEL_PREBOOK_PORT,
      HOTEL_BOOK_PORT,
      HOTEL_BOOKING_READ_PORT,
      HOTEL_CANCEL_PORT,
    ]).toEqual([
      'HOTEL_SEARCH_PORT',
      'HOTEL_PREBOOK_PORT',
      'HOTEL_BOOK_PORT',
      'HOTEL_BOOKING_READ_PORT',
      'HOTEL_CANCEL_PORT',
    ]);
  });
});
