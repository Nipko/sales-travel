import { HttpStatus } from '@nestjs/common';
import type {
  HotelOffer,
  HotelRatesQuery,
  HotelRoompack,
  HotelSearchCriteria,
} from '@sales-travel/canonical';
import type {
  HotelBookRequest,
  HotelBookResult,
  HotelBookingView,
  HotelPrebookResult,
} from '@sales-travel/domain';
import {
  TBO_BOOKING_REFERENCE_PATTERN,
  TBO_FAILURE_KINDS,
  TBO_OFFER_TTL_MS,
  TboApiError,
  TboDispatchRejectedError,
  TboHotelsAdapter,
  TboOfferExpiredError,
  TboRequestBuildError,
  TboResponseMappingError,
  tboBookingReferenceEnvironment,
  TBO_CONTENT_LANGUAGES,
  type TboBookReport,
  type TboFailureKind,
  type TboHotelDetailsResult,
  type TboHotelRatesReport,
  type TboPrebookReport,
  type TboSearchReport,
} from '@sales-travel/tbo-hotels';
import { LanguageCodeSchema } from '@sales-travel/validation';
import { describe, expect, it, vi } from 'vitest';
import {
  HOTEL_CONTENT_LANGUAGES,
  supportsHotelBookingByClientReference,
  supportsHotelBookingContext,
  supportsHotelContent,
  supportsHotelPrebookContext,
  supportsHotelRatesContext,
  supportsHotelSearchContext,
  type HotelBookContextRequest,
  type HotelPrebookContextRequest,
  type HotelProviderCapabilities,
  type HotelSearchRateFacts,
} from '../providers/hotel-provider.types.js';
import {
  TBO_PENDING_OPERATIONS,
  TboContentClientMissingError,
  TboHotelProviderAdapter,
  TboOperationNotSupportedError,
  type TboContentAcl,
  type TboHotelsAcl,
} from './tbo-hotel-provider.adapter.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

/**
 * El envoltorio neutral de TBO: delega lo que el ACL sabe hacer y rechaza, tipado y sin salir al
 * cable, lo que todavía no.
 */

const CTX = { tenantId: '11111111-1111-4111-8111-111111111111' };

const CRITERIO: HotelSearchCriteria = {
  hotelIds: ['1120548'],
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  currency: 'USD',
  guestNationality: 'CO',
};

const OFERTA: HotelOffer = { hotelId: '1120548', roompacks: [] };

const CUENTA = { accountId: 'acc-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' };

const T0 = Date.parse('2026-09-25T15:00:00Z');

/** El reporte del ACL: lo que el contexto del servidor necesita además de las ofertas. */
const REPORTE: Omit<TboSearchReport, 'offers'> = {
  searchId: '6110a41c-558c-405c-a0d3-6bdd3e131146',
  searchSentAt: T0,
  accountRef: '0123456789abcdef',
  packs: [
    {
      hotelCode: '1120548',
      bookingCode: '1120548!TB!2!TB!6110a41c-558c-405c-a0d3-6bdd3e131146',
      totalFare: '305.750',
      currency: 'USD',
    },
  ],
  batches: [],
  partial: false,
  omittedHotelCodes: 0,
  diagnostics: {
    hotelsReceived: 1,
    packsReceived: 1,
    packsMapped: 1,
    hotelsRejected: {},
    packsRejected: {},
    unknownKeys: [],
    unknownMealTypes: 0,
    amountsWithPrecisionLoss: 0,
    unsupportedCurrencies: [],
  },
};

/** Lo que BookingDetail devuelve ya en vocabulario neutral. */
const RESERVA: HotelBookingView = {
  found: true,
  status: 'CONFIRMED',
  providerBookingId: '7584263',
  bookingReference: 'STT0123456789ABCDEFGH',
  providerStatus: 'Confirmed',
  warnings: [],
};

const BOOKING_CODE = '1120548!TB!4!TB!6110a41c-558c-405c-a0d3-6bdd3e131146';

/** El pack del PreBook de p. 28, ya neutral: el mismo que mostró la búsqueda de p. 16. */
const PACK_PREBOOK: HotelRoompack = {
  id: BOOKING_CODE,
  provider: { name: 'tbo-hotels', offerRef: BOOKING_CODE, raw: { searchId: REPORTE.searchId } },
  board: 'RO',
  boardLabel: 'Sólo alojamiento',
  mealTypeRaw: 'Room_Only',
  rooms: [
    { name: 'Luxury Room, 2 Twin Beds', reference: 0, bedOptions: [] },
    { name: 'Luxury Room, 2 Twin Beds', reference: 1, bedOptions: [] },
  ],
  cancellation: {
    refundable: false,
    status: 'non_refundable',
    rules: [
      { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2022-05-05T00:00:00' },
    ],
    policySource: 'prebook-final',
  },
  price: {
    total: { amountMinor: 30_575, currency: 'USD' },
    taxesDetail: [],
    minimumSellingPrice: { amountMinor: 32_134, currency: 'USD' },
  },
  atPropertyCharges: [1, 2].map((roomIndex) => ({
    roomIndex,
    description: 'Impuesto obligatorio',
    descriptionRaw: 'mandatory_tax',
    amount: { amountMinor: 2000, currency: 'AED' },
  })),
};

/** Lo que la búsqueda mostró de esa tarifa: igual en todo lo que C1 mira. */
const VISTO: HotelSearchRateFacts = {
  total: { amountMinor: 30_575, currency: 'USD' },
  refundable: false,
  board: 'RO',
  mealTypeRaw: 'Room_Only',
  atPropertyCharges: PACK_PREBOOK.atPropertyCharges ?? [],
};

const RESULTADO_PREBOOK: HotelPrebookResult = {
  total: { amountMinor: 30_575, currency: 'USD' },
  expiresAt: new Date(T0 + TBO_OFFER_TTL_MS).toISOString(),
  roompack: PACK_PREBOOK,
  rateConditions: [
    { category: 'checkOut', text: 'CheckOut Time: 12:00 PM', raw: 'CheckOut Time: 12:00 PM' },
  ],
  signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
  providerStatus: '200',
  warnings: [],
};

const HASH = 'a'.repeat(64);

function reportePrebook(overrides: Partial<TboPrebookReport> = {}): TboPrebookReport {
  return {
    result: RESULTADO_PREBOOK,
    pack: { hotelCode: '1120548', bookingCode: BOOKING_CODE, totalFare: '305.75', currency: 'USD' },
    rateConditionsHash: HASH,
    amenities: [],
    diagnostics: {
      unknownKeys: [],
      unknownMealTypes: 0,
      amountsWithPrecisionLoss: 0,
      cardBillingOptionsIgnored: false,
      bookingCodeChanged: false,
      emptyRateConditions: 0,
      packageMentionsWithoutSignal: 0,
    },
    requestId: 'req-prebook-1',
    accountRef: '0123456789abcdef',
    attempts: 1,
    durationMs: 800,
    ...overrides,
  };
}

function pedidoC1(
  visto: HotelSearchRateFacts = VISTO,
  totalText = '305.750',
): HotelPrebookContextRequest {
  return {
    searchId: REPORTE.searchId,
    hotelId: '1120548',
    offerRef: BOOKING_CODE,
    searchSentAt: T0,
    rooms: [
      { adults: 2, childrenAges: [] },
      { adults: 2, childrenAges: [] },
    ],
    baseline: { stage: 'C1', totalText, seen: visto },
  };
}

type AclDoble = TboHotelsAcl & {
  searchAvailability: ReturnType<typeof vi.fn>;
  getHotelRates: ReturnType<typeof vi.fn>;
  searchAvailabilityReport: ReturnType<typeof vi.fn>;
  getHotelRatesReport: ReturnType<typeof vi.fn>;
  getBooking: ReturnType<typeof vi.fn>;
  getBookingByClientReference: ReturnType<typeof vi.fn>;
  prebook: ReturnType<typeof vi.fn>;
  prebookReport: ReturnType<typeof vi.fn>;
  book: ReturnType<typeof vi.fn>;
  bookReport: ReturnType<typeof vi.fn>;
};

const REFERENCIA = 'STT0123456789ABCDEFGH';

const RESULTADO_BOOK: HotelBookResult = {
  outcome: 'CONFIRMED',
  providerBookingId: 'FL1IMA',
  bookingReference: REFERENCIA,
  providerStatus: '200',
  warnings: [],
};

function reporteBook(overrides: Partial<TboBookReport> = {}): TboBookReport {
  return {
    result: RESULTADO_BOOK,
    classification: {
      outcome: 'CONFIRMED',
      reason: 'confirmed',
      dispatched: true,
      verifyByReference: false,
      confirmationNumber: 'FL1IMA',
      tboCode: 200,
    },
    reply: { confirmationNumber: 'FL1IMA', clientReferenceId: REFERENCIA },
    bookingReferenceId: REFERENCIA,
    requestId: 'req-book-1',
    accountRef: '0123456789abcdef',
    attempts: 1,
    durationMs: 900,
    diagnostics: {
      unknownKeys: [],
      confirmationNumberMalformed: false,
      clientReferenceIdMalformed: false,
    },
    ...overrides,
  };
}

function acl(): AclDoble {
  return {
    accountRef: '0123456789abcdef',
    searchAvailability: vi.fn(() => Promise.resolve([OFERTA])),
    getHotelRates: vi.fn(() => Promise.resolve(OFERTA)),
    searchAvailabilityReport: vi.fn(() =>
      Promise.resolve<TboSearchReport>({ ...REPORTE, offers: [OFERTA] }),
    ),
    getHotelRatesReport: vi.fn(() =>
      Promise.resolve<TboHotelRatesReport>({ ...REPORTE, offer: OFERTA }),
    ),
    getBooking: vi.fn(() => Promise.resolve(RESERVA)),
    getBookingByClientReference: vi.fn(() => Promise.resolve(RESERVA)),
    prebook: vi.fn(() => Promise.resolve(RESULTADO_PREBOOK)),
    prebookReport: vi.fn(() => Promise.resolve(reportePrebook())),
    book: vi.fn(() => Promise.resolve(RESULTADO_BOOK)),
    bookReport: vi.fn(() => Promise.resolve(reporteBook())),
  };
}

describe('TboHotelProviderAdapter', () => {
  it('búsqueda y detalle van al ACL tal cual', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');
    const query: HotelRatesQuery = { ...CRITERIO, hotelId: '1120548' };

    await expect(adapter.searchAvailability(CRITERIO, CTX)).resolves.toEqual([OFERTA]);
    await expect(adapter.getHotelRates(query, CTX)).resolves.toBe(OFERTA);
    expect(a.searchAvailability).toHaveBeenCalledWith(CRITERIO, CTX);
    expect(a.getHotelRates).toHaveBeenCalledWith(query, CTX);
    expect(adapter.accountRef).toBe('0123456789abcdef');
  });

  it.each(TBO_PENDING_OPERATIONS)(
    '`%s` todavía no existe: 501 tipado, sin tocar el ACL',
    async (operacion) => {
      const a = acl();
      const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');

      const err: unknown = await adapter[operacion]().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TboOperationNotSupportedError);
      expect((err as TboOperationNotSupportedError).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
      expect((err as TboOperationNotSupportedError).operation).toBe(operacion);
      expect((err as Error).message).toContain('Elegí una tarifa de otro proveedor');
      expect(a.searchAvailability).not.toHaveBeenCalled();
      expect(a.getHotelRates).not.toHaveBeenCalled();
      expect(a.searchAvailabilityReport).not.toHaveBeenCalled();
      expect(a.getHotelRatesReport).not.toHaveBeenCalled();
      expect(a.getBooking).not.toHaveBeenCalled();
      expect(a.getBookingByClientReference).not.toHaveBeenCalled();
      expect(a.prebook).not.toHaveBeenCalled();
      expect(a.prebookReport).not.toHaveBeenCalled();
      expect(a.book).not.toHaveBeenCalled();
      expect(a.bookReport).not.toHaveBeenCalled();
    },
  );

  it('PR-4.2: la lectura de una reserva, por localizador o por nuestra referencia, va al ACL tal cual', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');

    await expect(adapter.getBooking('7584263', CTX)).resolves.toBe(RESERVA);
    await expect(adapter.getBookingByClientReference('STT0123456789ABCDEFGH', CTX)).resolves.toBe(
      RESERVA,
    );
    expect(a.getBooking).toHaveBeenCalledWith('7584263', CTX);
    expect(a.getBookingByClientReference).toHaveBeenCalledWith('STT0123456789ABCDEFGH', CTX);
    expect(supportsHotelBookingByClientReference(adapter)).toBe(true);
  });

  it('PR-4.6: el Book salió de las pendientes con la saga de órdenes; sólo queda la cancelación (PR-5.1)', () => {
    expect(TBO_PENDING_OPERATIONS).toEqual(['cancelBooking']);
    expect(typeof TboHotelsAdapter.prototype.book).toBe('function');
    expect(supportsHotelBookingContext(new TboHotelProviderAdapter(acl(), CUENTA, 'test'))).toBe(
      true,
    );
  });

  it('PR-4.5: el PreBook del puerto neutral va al ACL tal cual', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');
    const pedido = {
      offer: { name: 'tbo-hotels', offerRef: BOOKING_CODE, raw: { searchId: REPORTE.searchId } },
      searchSentAt: new Date(T0).toISOString(),
      providerOptions: { hotelCode: '1120548', rooms: [{ adults: 2, childrenAges: [] }] },
    };

    await expect(adapter.prebook(pedido, CTX)).resolves.toBe(RESULTADO_PREBOOK);
    expect(a.prebook).toHaveBeenCalledWith(pedido, CTX);
    expect(supportsHotelPrebookContext(adapter)).toBe(true);
  });

  it('con contexto (RF-08): el reporte del ACL en vocabulario neutral, con el vencimiento de la oferta', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');
    const query: HotelRatesQuery = { ...CRITERIO, hotelId: '1120548' };
    const contexto = {
      searchId: REPORTE.searchId,
      searchSentAt: T0,
      expiresAt: T0 + TBO_OFFER_TTL_MS,
      packs: [
        {
          hotelId: '1120548',
          offerRef: '1120548!TB!2!TB!6110a41c-558c-405c-a0d3-6bdd3e131146',
          // El literal, sin pasar por número: `305.750` no es `305.75` para quien lo reenvía.
          totalText: '305.750',
          currency: 'USD',
        },
      ],
    };

    await expect(adapter.searchAvailabilityWithContext(CRITERIO, CTX)).resolves.toEqual({
      ...contexto,
      offers: [OFERTA],
    });
    await expect(adapter.getHotelRatesWithContext(query, CTX)).resolves.toEqual({
      ...contexto,
      offer: OFERTA,
    });
    expect(a.searchAvailabilityReport).toHaveBeenCalledWith(CRITERIO, CTX);
    expect(a.getHotelRatesReport).toHaveBeenCalledWith(query, CTX);
    expect(TBO_OFFER_TTL_MS).toBe(27 * 60_000);
  });

  it('PR-2.6: un reporte completo no dice `partial`', async () => {
    const found = await new TboHotelProviderAdapter(
      acl(),
      CUENTA,
      'test',
    ).searchAvailabilityWithContext(CRITERIO, CTX);
    expect(found).not.toHaveProperty('partial');
  });

  /*
   * MUTACIÓN: sin pasar `report.partial`, el lote caído desaparece y el vendedor ve menos hoteles
   * sin ningún aviso (RF-14 CA-3; RNF-13).
   */
  it('PR-2.6: un lote que no aportó llega como `partial`, con el error tipado del primero que falló', async () => {
    const a = acl();
    const limite = new TboDispatchRejectedError('/Search', 'DEADLINE', 0);
    a.searchAvailabilityReport.mockResolvedValue({
      ...REPORTE,
      offers: [OFERTA],
      partial: true,
      batches: [
        { index: 0, hotelCodeCount: 100, status: 'ok', durationMs: 900 },
        { index: 1, hotelCodeCount: 100, status: 'not-dispatched', durationMs: 0, error: limite },
      ],
    } satisfies TboSearchReport);

    const found = await new TboHotelProviderAdapter(
      a,
      CUENTA,
      'test',
    ).searchAvailabilityWithContext(CRITERIO, CTX);

    expect(found.offers).toEqual([OFERTA]);
    expect(found.partial).toEqual({ cause: limite });
  });

  it('expone la huella de la cuenta de la bóveda como copia, y los puertos de contexto por presencia', () => {
    const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test');

    expect(adapter.searchAccount).toEqual(CUENTA);
    (adapter.searchAccount as { accountId: string }).accountId = 'otra';
    expect(adapter.searchAccount).toEqual(CUENTA);
    expect(supportsHotelSearchContext(adapter)).toBe(true);
    expect(supportsHotelRatesContext(adapter)).toBe(true);
  });

  it('volcado a un log no arrastra el ACL', () => {
    expect(JSON.stringify(new TboHotelProviderAdapter(acl(), CUENTA, 'test'))).toBe('{}');
  });
});

describe('las capacidades se encienden a medida que el ACL implementa cada puerto', () => {
  /**
   * Qué método del ACL enciende cada capacidad. Si el ACL de TBO gana uno, este test se pone en
   * rojo: hay que cablearlo en el envoltorio, sacarlo de `TBO_PENDING_OPERATIONS` y encender la
   * capacidad en el factory. Así la post-venta nunca confía en un método que responde "no
   * disponible", ni se queda sin usar uno que ya existe.
   */
  const METODO_DEL_ACL: Readonly<Record<keyof HotelProviderCapabilities, string>> = {
    retrieve: 'getBooking',
    cancel: 'cancelBooking',
    retrieveByClientReference: 'getBookingByClientReference',
    reconcileByDate: 'listBookingsByDate',
  };

  const factory = new TboHotelsProviderFactory({} as ProviderCredentialsService);

  it.each(Object.entries(METODO_DEL_ACL))('%s ⇔ el ACL implementa `%s`', (capacidad, metodo) => {
    const implementa =
      typeof (TboHotelsAdapter.prototype as unknown as Record<string, unknown>)[metodo] ===
      'function';
    expect(factory.capabilities[capacidad as keyof HotelProviderCapabilities]).toBe(implementa);
  });
});

describe('PR-4.5: PreBook con el contexto de la búsqueda', () => {
  it('arma la consulta del ACL con lo que dejó el servidor y devuelve lo que el Book reenvía', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');

    const found = await adapter.prebookWithContext(pedidoC1(), CTX);

    expect(a.prebookReport).toHaveBeenCalledWith(
      {
        hotelCode: '1120548',
        bookingCode: BOOKING_CODE,
        searchId: REPORTE.searchId,
        searchSentAt: T0,
        rooms: pedidoC1().rooms,
      },
      CTX,
    );
    expect(found.result).toEqual(RESULTADO_PREBOOK);
    expect(found.pack).toEqual({
      hotelId: '1120548',
      offerRef: BOOKING_CODE,
      totalText: '305.75',
      currency: 'USD',
    });
    expect(found.rateConditionsHash).toBe(HASH);
    expect(found.requestId).toBe('req-prebook-1');
  });

  it('C1 igual en todo lo que mira: UNCHANGED, aunque las políticas y las señales sólo existan en el PreBook', async () => {
    const found = await new TboHotelProviderAdapter(acl(), CUENTA, 'test').prebookWithContext(
      pedidoC1(),
      CTX,
    );

    // `305.750` de la búsqueda y `305.75` del PreBook son el mismo decimal (03 §2.9 regla 1).
    expect(found.comparison).toEqual({
      stage: 'C1',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: 30_575, currency: 'USD' },
      currentTotal: { amountMinor: 30_575, currency: 'USD' },
    });
  });

  it.each<[string, Partial<HotelSearchRateFacts>, string]>([
    ['era reembolsable', { refundable: true }, 'REFUNDABLE'],
    ['otro régimen', { board: 'BB', mealTypeRaw: 'Breakfast_For_2' }, 'MEAL_TYPE'],
    ['sin cargos en el hotel', { atPropertyCharges: [] }, 'AT_PROPERTY_CHARGES'],
    ['en otra moneda', { total: { amountMinor: 30_575, currency: 'EUR' } }, 'CURRENCY'],
  ])('C1: %s → CONDITIONS_CHANGED con su código', async (_caso, cambio, codigo) => {
    const found = await new TboHotelProviderAdapter(acl(), CUENTA, 'test').prebookWithContext(
      pedidoC1({ ...VISTO, ...cambio }),
      CTX,
    );

    expect(found.comparison.outcome).toBe('CONDITIONS_CHANGED');
    expect(found.comparison.changes).toContain(codigo);
  });

  it('C1 sin literal de régimen en la búsqueda compara por el régimen normalizado', async () => {
    const { mealTypeRaw: _meal, ...sinLiteral } = VISTO;

    const found = await new TboHotelProviderAdapter(acl(), CUENTA, 'test').prebookWithContext(
      pedidoC1(sinLiteral),
      CTX,
    );

    expect(found.comparison.changes).toEqual(['MEAL_TYPE']);
  });

  it.each([
    ['300.00', 30_000, 'INCREASED', 'UP'],
    ['310.10', 31_010, 'DECREASED', 'DOWN'],
  ])(
    'C1: la búsqueda mostró %s (%i en unidades menores) → %s, con los netos para el evento',
    async (totalText, amountMinor, outcome, price) => {
      const found = await new TboHotelProviderAdapter(acl(), CUENTA, 'test').prebookWithContext(
        pedidoC1({ ...VISTO, total: { amountMinor, currency: 'USD' } }, totalText),
        CTX,
      );

      expect(found.comparison).toMatchObject({
        outcome,
        price,
        changes: [],
        previousTotal: { amountMinor, currency: 'USD' },
        currentTotal: { amountMinor: 30_575, currency: 'USD' },
      });
    },
  );

  it('C2 compara contra lo aceptado, con políticas, señales y texto de las condiciones', async () => {
    const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test');
    const aceptado = {
      totalText: '305.75',
      roompack: PACK_PREBOOK,
      signals: ['PACKAGE_WITH_FLIGHT_ONLY'] as const,
      rateConditionsHash: HASH,
    };

    const igual = await adapter.prebookWithContext(
      {
        ...pedidoC1(),
        baseline: { stage: 'C2', accepted: { ...aceptado, signals: [...aceptado.signals] } },
      },
      CTX,
    );
    const otroTexto = await adapter.prebookWithContext(
      {
        ...pedidoC1(),
        baseline: {
          stage: 'C2',
          accepted: { ...aceptado, signals: [], rateConditionsHash: 'b'.repeat(64) },
        },
      },
      CTX,
    );

    expect(igual.comparison).toMatchObject({ stage: 'C2', outcome: 'UNCHANGED' });
    expect(otroTexto.comparison).toMatchObject({
      stage: 'C2',
      outcome: 'CONDITIONS_CHANGED',
      changes: ['SIGNALS', 'RATE_CONDITIONS'],
    });
  });

  it('Q-30: si el PreBook trae otro `BookingCode`, lo que se reenvía es el del PreBook', async () => {
    const a = acl();
    const nuevo = '1120548!TB!9!TB!6110a41c-558c-405c-a0d3-6bdd3e131146';
    a.prebookReport.mockResolvedValue(
      reportePrebook({
        pack: { hotelCode: '1120548', bookingCode: nuevo, totalFare: '305.75', currency: 'USD' },
      }),
    );

    const found = await new TboHotelProviderAdapter(a, CUENTA, 'test').prebookWithContext(
      pedidoC1(),
      CTX,
    );

    expect(found.pack.offerRef).toBe(nuevo);
  });

  it('un PreBook sin pack neutral no se compara ni se acepta: error de lectura con su `requestId`', async () => {
    const a = acl();
    const { roompack: _pack, ...sinPack } = RESULTADO_PREBOOK;
    a.prebookReport.mockResolvedValue(reportePrebook({ result: sinPack }));

    const err: unknown = await new TboHotelProviderAdapter(a, CUENTA, 'test')
      .prebookWithContext(pedidoC1(), CTX)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TboResponseMappingError);
    expect((err as TboResponseMappingError).requestId).toBe('req-prebook-1');
  });

  it('lo que el ACL lanza sale tal cual', async () => {
    const a = acl();
    const vencida = new TboOfferExpiredError(new Date(T0 + TBO_OFFER_TTL_MS).toISOString());
    a.prebookReport.mockRejectedValue(vencida);

    await expect(
      new TboHotelProviderAdapter(a, CUENTA, 'test').prebookWithContext(pedidoC1(), CTX),
    ).rejects.toBe(vencida);
  });
});

describe('PR-4.5: qué deja inservible cada error del PreBook', () => {
  const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test');

  function error(kind: TboFailureKind): TboApiError {
    return new TboApiError({ status: 200, tboCode: 1, path: '/PreBook', kind, requestId: 'req-1' });
  }

  const ESPERADO: Readonly<Record<TboFailureKind, 'offer' | 'search' | undefined>> = {
    TRANSPORT: undefined,
    MALFORMED_RESPONSE: undefined,
    UNKNOWN_CODE: undefined,
    CLIENT_BUG: undefined,
    CREDENTIALS_INVALID: undefined,
    ACCOUNT_BLOCKED: undefined,
    INSUFFICIENT_BALANCE: undefined,
    THROTTLED: undefined,
    UPSTREAM: undefined,
    NO_AVAILABILITY: 'offer',
    RATE_UNAVAILABLE: 'offer',
    OFFER_EXPIRED: 'search',
    BOOKING_FAILED: undefined,
    CANCEL_FAILED: undefined,
  };

  it.each(TBO_FAILURE_KINDS.map((kind) => [kind, ESPERADO[kind]] as const))(
    '%s → %s',
    (kind, esperado) => {
      expect(adapter.offerInvalidatedBy(error(kind))).toBe(esperado);
    },
  );

  it('la ventana vencida en nuestro reloj olvida la búsqueda, como un 315', () => {
    expect(adapter.offerInvalidatedBy(new TboOfferExpiredError('2026-09-25T15:27:00Z'))).toBe(
      'search',
    );
  });

  it('lo que no es de TBO no invalida nada', () => {
    expect(adapter.offerInvalidatedBy(new Error('breaker'))).toBeUndefined();
    expect(
      adapter.offerInvalidatedBy(new TboDispatchRejectedError('/PreBook', 'DEADLINE', 0)),
    ).toBeUndefined();
  });
});

describe('PR-4.8: qué errores son de la cuenta y no de la tarifa (RF-23; 03 §6)', () => {
  const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test');

  function error(kind: TboFailureKind): TboApiError {
    return new TboApiError({ status: 200, tboCode: 1, path: '/Book', kind, requestId: 'req-1' });
  }

  const ESPERADO: Readonly<
    Record<TboFailureKind, 'insufficient-balance' | 'agent-blocked' | undefined>
  > = {
    TRANSPORT: undefined,
    MALFORMED_RESPONSE: undefined,
    UNKNOWN_CODE: undefined,
    CLIENT_BUG: undefined,
    // La credencial rechazada ya tiene su camino: circuito de la cuenta y mensaje al dueño.
    CREDENTIALS_INVALID: undefined,
    ACCOUNT_BLOCKED: 'agent-blocked',
    INSUFFICIENT_BALANCE: 'insufficient-balance',
    THROTTLED: undefined,
    UPSTREAM: undefined,
    NO_AVAILABILITY: undefined,
    RATE_UNAVAILABLE: undefined,
    OFFER_EXPIRED: undefined,
    BOOKING_FAILED: undefined,
    CANCEL_FAILED: undefined,
  };

  it.each(TBO_FAILURE_KINDS.map((kind) => [kind, ESPERADO[kind]] as const))(
    '%s → %s',
    (kind, esperado) => {
      expect(adapter.accountIssueOf(error(kind))).toBe(esperado);
    },
  );

  it('el rechazo de nuestro breaker o de nuestro reloj no dice nada de la cuenta', () => {
    expect(adapter.accountIssueOf(new Error('breaker'))).toBeUndefined();
    expect(
      adapter.accountIssueOf(new TboDispatchRejectedError('/Book', 'DEADLINE', 0)),
    ).toBeUndefined();
    expect(adapter.accountIssueOf(undefined)).toBeUndefined();
  });
});

describe('PR-4.6: el Book de la saga con órdenes', () => {
  const PEDIDO_BOOK: HotelBookContextRequest = {
    offerRef: BOOKING_CODE,
    totalText: '305.750',
    bookingReference: REFERENCIA,
    searchSentAt: T0,
    occupancy: [{ adults: 1, childrenAges: [5] }],
    rooms: [
      {
        guests: [
          { paxType: 'ADT', title: 'Mr', firstName: 'Juan', lastName: 'Pérez' },
          { paxType: 'CHD', title: 'Ms', firstName: 'Sofía', lastName: 'Pérez' },
        ],
      },
    ],
    contact: {
      email: 'reservas@agencia.example',
      phone: { countryCode: '57', number: '3001234567' },
    },
  };

  it('arma la consulta del ACL con lo que dejó el servidor: el literal del total va tal cual', async () => {
    const a = acl();

    const found = await new TboHotelProviderAdapter(a, CUENTA, 'test').bookWithContext(
      PEDIDO_BOOK,
      CTX,
    );

    expect(a.bookReport).toHaveBeenCalledTimes(1);
    expect(a.bookReport).toHaveBeenCalledWith(
      {
        bookingCode: BOOKING_CODE,
        totalFare: '305.750',
        bookingReferenceId: REFERENCIA,
        searchSentAt: T0,
        occupancy: PEDIDO_BOOK.occupancy,
        rooms: PEDIDO_BOOK.rooms,
        contact: PEDIDO_BOOK.contact,
      },
      CTX,
    );
    expect(found).toEqual({ result: RESULTADO_BOOK, reason: 'confirmed', requestId: 'req-book-1' });
    expect(a.book).not.toHaveBeenCalled();
  });

  it('un `200` sin localizador vuelve como incierto con su motivo, no se lanza', async () => {
    const a = acl();
    a.bookReport.mockResolvedValue(
      reporteBook({
        result: { outcome: 'UNCERTAIN', providerStatus: '200', warnings: [] },
        classification: {
          outcome: 'UNCERTAIN',
          reason: 'missing-confirmation-number',
          dispatched: true,
          verifyByReference: true,
          tboCode: 200,
        },
      }),
    );

    const found = await new TboHotelProviderAdapter(a, CUENTA, 'test').bookWithContext(
      PEDIDO_BOOK,
      CTX,
    );

    expect(found.result.outcome).toBe('UNCERTAIN');
    expect(found.reason).toBe('missing-confirmation-number');
  });

  it('lo que el ACL lanza sale tal cual, para que el breaker lo cuente', async () => {
    const a = acl();
    const rechazo = new TboApiError({
      status: 200,
      tboCode: 207,
      path: '/Book',
      kind: 'RATE_UNAVAILABLE',
      requestId: 'req-book-1',
    });
    a.bookReport.mockRejectedValue(rechazo);

    await expect(
      new TboHotelProviderAdapter(a, CUENTA, 'test').bookWithContext(PEDIDO_BOOK, CTX),
    ).rejects.toBe(rechazo);
  });

  function apiError(
    tboCode: number | undefined,
    kind: TboFailureKind,
    timedOut = false,
  ): TboApiError {
    return new TboApiError({
      status: tboCode === undefined ? 0 : 200,
      ...(tboCode === undefined ? {} : { tboCode }),
      path: '/Book',
      kind,
      requestId: 'req-book-1',
      timedOut,
    });
  }

  it.each([
    ['207', apiError(207, 'RATE_UNAVAILABLE'), 'FAILED', 'rate-unavailable', true, '207'],
    ['315', apiError(315, 'OFFER_EXPIRED'), 'FAILED', 'session-expired', true, '315'],
    ['300', apiError(300, 'INSUFFICIENT_BALANCE'), 'FAILED', 'insufficient-balance', true, '300'],
    ['402', apiError(402, 'ACCOUNT_BLOCKED'), 'FAILED', 'agent-blocked', true, '402'],
    ['405', apiError(405, 'BOOKING_FAILED'), 'UNCERTAIN', 'booking-failed', true, '405'],
    ['500', apiError(500, 'UPSTREAM'), 'UNCERTAIN', 'provider-error', true, '500'],
    [
      'timeout de 120 s',
      apiError(undefined, 'TRANSPORT', true),
      'UNCERTAIN',
      'timeout',
      true,
      undefined,
    ],
    [
      'ventana vencida en nuestro reloj',
      new TboOfferExpiredError('2026-09-25T15:27:00.000Z'),
      'FAILED',
      'not-dispatched',
      false,
      undefined,
    ],
    [
      'cuerpo que no se pudo armar',
      new TboRequestBuildError('/Book', 'SCHEMA', ['rooms:count_mismatch']),
      'FAILED',
      'not-dispatched',
      false,
      undefined,
    ],
    ['un error que no es de TBO', new Error('x'), 'UNCERTAIN', 'unexpected-error', true, undefined],
  ])('03 §3.9: %s → %s (%s)', (_caso, err, outcome, reason, dispatched, providerStatus) => {
    const failure = new TboHotelProviderAdapter(acl(), CUENTA, 'test').bookFailureOf(err);

    expect(failure.outcome).toBe(outcome);
    expect(failure.reason).toBe(reason);
    expect(failure.dispatched).toBe(dispatched);
    expect(failure.providerStatus).toBe(providerStatus);
    // El nombre de la clase, nunca el mensaje.
    expect(JSON.stringify(failure)).not.toContain('"x"');
  });

  it('RF-19: la referencia nueva lleva el entorno de la cuenta y la forma declarada, distinta cada vez', () => {
    const test = new TboHotelProviderAdapter(acl(), CUENTA, 'test');
    const live = new TboHotelProviderAdapter(acl(), CUENTA, 'live');

    const referencias = new Set(Array.from({ length: 50 }, () => test.newBookingReference()));
    const deLive = live.newBookingReference();

    expect(referencias.size).toBe(50);
    for (const r of referencias) {
      expect(r).toMatch(TBO_BOOKING_REFERENCE_PATTERN);
      expect(tboBookingReferenceEnvironment(r)).toBe('test');
    }
    expect(tboBookingReferenceEnvironment(deLive)).toBe('live');
  });

  it('RF-18: los huéspedes se validan con la regla del builder del Book, sin llamar al ACL', () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');

    const ok = adapter.checkBookingGuests(PEDIDO_BOOK.rooms, PEDIDO_BOOK.occupancy);
    const dr = adapter.checkBookingGuests(
      [
        {
          guests: [
            { paxType: 'ADT', title: 'Dr' as 'Mr', firstName: 'Juan', lastName: 'Perez' },
            { paxType: 'CHD', title: 'Ms', firstName: 'Sofia', lastName: 'Perez' },
          ],
        },
      ],
      PEDIDO_BOOK.occupancy,
    );

    // RF-18 CA-3 (D-TBO-23 A): `Pérez` y `Sofía` salen en ASCII.
    expect(ok).toEqual({
      ok: true,
      rooms: [
        [
          { title: 'Mr', firstName: 'Juan', lastName: 'Perez', paxType: 'ADT' },
          { title: 'Ms', firstName: 'Sofia', lastName: 'Perez', paxType: 'CHD' },
        ],
      ],
    });
    // RF-18 CA-2: `Dr` no, hasta que TBO lo confirme.
    expect(dr).toEqual({ ok: false, issues: ['rooms.0.guests.0.title:not_allowed'] });
    expect(a.bookReport).not.toHaveBeenCalled();
  });

  it('el puerto neutral va al ACL tal cual', async () => {
    const a = acl();
    const pedido: HotelBookRequest = {
      offer: { name: 'tbo-hotels', offerRef: BOOKING_CODE },
      bookingReference: REFERENCIA,
      rooms: PEDIDO_BOOK.rooms.map((r) => ({ guests: [...r.guests] })),
      contact: PEDIDO_BOOK.contact,
      payment: { kind: 'agency-credit' },
      providerOptions: {
        totalFare: '305.750',
        searchSentAt: new Date(T0).toISOString(),
        rooms: [...PEDIDO_BOOK.occupancy],
      },
    };

    await expect(new TboHotelProviderAdapter(a, CUENTA, 'test').book(pedido, CTX)).resolves.toBe(
      RESULTADO_BOOK,
    );
    expect(a.book).toHaveBeenCalledWith(pedido, CTX);
  });
});

describe('PR-3.6: contenido de un hotel bajo demanda (HotelDetails)', () => {
  const DIAGNOSTICO = { received: 1, mapped: 1, rejected: {}, notes: {}, unknownKeys: [] };

  /** Lo que devuelve el cliente de contenido del ACL: ya saneado y normalizado. */
  function detalle(overrides: Partial<TboHotelDetailsResult> = {}): TboHotelDetailsResult {
    return {
      lang: 'es',
      contents: [
        {
          hotelId: '1000000',
          lang: 'es',
          source: 'details',
          name: 'Sofitel Legend Old Cataract Aswan',
          descriptionHtml: '<p>HeadLine : Cerca del Museo Nubio</p>',
          descriptionText: 'HeadLine : Cerca del Museo Nubio',
          sections: [{ label: 'HeadLine', text: 'Cerca del Museo Nubio' }],
          facilities: ['Biblioteca'],
          unavailableFacilities: ['Wheelchair accessible'],
          attractionsHtml: '<p>Museo Nubio - 0,4 km</p>',
          images: ['https://api.tbotechnology.in/imageresource.aspx?img=abc'],
          phone: '+20972316000',
          websiteUrl: null,
          checkInTime: '15:00',
          checkOutTime: '12:00',
        },
      ],
      hotels: [
        {
          hotelId: '1000000',
          name: 'Sofitel Legend Old Cataract Aswan',
          stars: 5,
          location: { lat: 24.08166, lng: 32.88985 },
          address: 'Abtal El Tahrir Street, Aswan',
          zipcode: '81511',
          countryCode: 'EG',
          cityCode: '109642',
        },
      ],
      missingHotelCodes: [],
      diagnostics: DIAGNOSTICO,
      requestId: 'req-details-1',
      durationMs: 300,
      attempts: 1,
      ...overrides,
    };
  }

  function contenido(
    result: TboHotelDetailsResult = detalle(),
  ): TboContentAcl & { getHotelDetails: ReturnType<typeof vi.fn> } {
    return { getHotelDetails: vi.fn(() => Promise.resolve(result)) };
  }

  it('pide UN código en el idioma, en un solo intento, con el plazo y la señal de quien llama', async () => {
    const c = contenido();
    const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test', c);
    const signal = new AbortController().signal;

    const ficha = await adapter.fetchHotelContent('1000000', 'es', CTX, {
      timeoutMs: 6_000,
      signal,
    });

    expect(c.getHotelDetails).toHaveBeenCalledWith(['1000000'], 'es', {
      timeoutMs: 6_000,
      maxAttempts: 1,
      signal,
    });
    expect(ficha).toEqual({
      hotelId: '1000000',
      lang: 'es',
      name: 'Sofitel Legend Old Cataract Aswan',
      stars: 5,
      address: 'Abtal El Tahrir Street, Aswan',
      zipcode: '81511',
      countryCode: 'EG',
      location: { lat: 24.08166, lng: 32.88985 },
      descriptionHtml: '<p>HeadLine : Cerca del Museo Nubio</p>',
      sections: [{ label: 'HeadLine', text: 'Cerca del Museo Nubio' }],
      facilities: ['Biblioteca'],
      attractionsHtml: '<p>Museo Nubio - 0,4 km</p>',
      images: ['https://api.tbotechnology.in/imageresource.aspx?img=abc'],
      phone: '+20972316000',
      websiteUrl: null,
      checkInTime: '15:00',
      checkOutTime: '12:00',
    });
    // Sólo el neutral: ni el texto plano, ni los servicios negados, ni el origen de TBO.
    expect(Object.keys(ficha ?? {})).not.toContain('unavailableFacilities');
    expect(Object.keys(ficha ?? {})).not.toContain('source');
  });

  it('sin señal no inventa una: el plazo va igual', async () => {
    const c = contenido();
    await new TboHotelProviderAdapter(acl(), CUENTA, 'test', c).fetchHotelContent(
      '1000000',
      'en',
      CTX,
      { timeoutMs: 6_000 },
    );

    expect(c.getHotelDetails).toHaveBeenCalledWith(['1000000'], 'en', {
      timeoutMs: 6_000,
      maxAttempts: 1,
    });
  });

  it('el hotel no volvió en la respuesta → `null`, no un contenido vacío inventado', async () => {
    const c = contenido(detalle({ contents: [], hotels: [], missingHotelCodes: ['1000000'] }));

    await expect(
      new TboHotelProviderAdapter(acl(), CUENTA, 'test', c).fetchHotelContent(
        '1000000',
        'es',
        CTX,
        {
          timeoutMs: 6_000,
        },
      ),
    ).resolves.toBeNull();
  });

  it('con sólo los datos del hotel, o sólo el texto, sale lo que hay y el resto vacío', async () => {
    const base = detalle();
    const soloHotel = await new TboHotelProviderAdapter(
      acl(),
      CUENTA,
      'test',
      contenido({ ...base, contents: [] }),
    ).fetchHotelContent('1000000', 'es', CTX, { timeoutMs: 6_000 });
    const soloTexto = await new TboHotelProviderAdapter(
      acl(),
      CUENTA,
      'test',
      contenido({ ...base, hotels: [] }),
    ).fetchHotelContent('1000000', 'es', CTX, { timeoutMs: 6_000 });

    expect(soloHotel).toMatchObject({
      name: 'Sofitel Legend Old Cataract Aswan',
      stars: 5,
      descriptionHtml: null,
      sections: [],
      facilities: [],
      images: [],
      checkInTime: null,
    });
    expect(soloTexto).toMatchObject({
      name: 'Sofitel Legend Old Cataract Aswan',
      stars: null,
      location: null,
      images: ['https://api.tbotechnology.in/imageresource.aspx?img=abc'],
    });
  });

  it('armado sin cliente de contenido: error tipado, sin tocar el ACL de venta', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA, 'test');

    await expect(
      adapter.fetchHotelContent('1000000', 'es', CTX, { timeoutMs: 6_000 }),
    ).rejects.toBeInstanceOf(TboContentClientMissingError);
    expect(a.searchAvailability).not.toHaveBeenCalled();
    expect(a.getHotelRates).not.toHaveBeenCalled();
  });

  it('se detecta por presencia y, volcado a un log, no arrastra el cliente de contenido', () => {
    const adapter = new TboHotelProviderAdapter(acl(), CUENTA, 'test', contenido());

    expect(supportsHotelContent(adapter)).toBe(true);
    expect(JSON.stringify(adapter)).toBe('{}');
  });

  it('los idiomas del contenido neutral son los del ACL y los de `hotel_content.lang`', () => {
    expect([...HOTEL_CONTENT_LANGUAGES].sort()).toEqual([...TBO_CONTENT_LANGUAGES].sort());
    expect([...HOTEL_CONTENT_LANGUAGES].sort()).toEqual([...LanguageCodeSchema.options].sort());
  });
});
