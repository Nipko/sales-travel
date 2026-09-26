import { HttpStatus, Logger } from '@nestjs/common';
import type { HotelRoompack } from '@sales-travel/canonical';
import type { CachePort } from '@sales-travel/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { HotelProviderAccountFingerprint } from '../providers/hotel-provider.types.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import {
  HOTEL_SEARCH_CONTEXT_MAX_LIFETIME_MS,
  HotelOfferNotInSearchError,
  HotelOfferReferenceSchema,
  HotelOfferUnavailableError,
  HotelSearchAccountChangedError,
  HotelSearchContextExpiredError,
  HotelSearchContextStore,
  HotelSearchContextUnavailableError,
  HotelSearchNationalityMissingError,
  isStorablePackContext,
  searchRateFactsOf,
  type HotelOfferReference,
  type HotelSearchContext,
  type HotelSearchContextPack,
} from './hotel-search-context.store.js';

/**
 * El contexto de búsqueda en el servidor (docs/tbo/09 PR-2.3; 08 RF-08 CA 1 a 5, RNF-06 punto 2).
 *
 * Sobre el adapter REAL del `CachePort` que usa `apps/api` y con el reloj falso: el vencimiento es
 * lo que se prueba, y un doble de caché a medida podría vencer distinto que el de producción.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const PROVEEDOR = 'tbo-hotels';
const SEARCH_ID = '6110a41c-558c-405c-a0d3-6bdd3e131146';
const BOOKING_CODE = `1120548!TB!2!TB!${SEARCH_ID}`;
const OTRO_BOOKING_CODE = `1120548!TB!4!TB!${SEARCH_ID}`;

const T0 = Date.parse('2026-09-25T15:00:00Z');
const MIN = 60_000;
/** La ventana de TBO: `searchSentAt + 27 min` (RF-09). */
const VENCE = T0 + 27 * MIN;

const CUENTA: HotelProviderAccountFingerprint = {
  accountId: 'acc-consolidador',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

/** Lo que la búsqueda mostró de la tarifa: la base de C1 (RF-15). */
function visto(amountMinor: number): HotelSearchContextPack['seen'] {
  return {
    total: { amountMinor, currency: 'USD' },
    refundable: false,
    board: 'RO',
    mealTypeRaw: 'Room_Only',
    atPropertyCharges: [
      {
        roomIndex: 1,
        description: 'Impuesto obligatorio',
        descriptionRaw: 'mandatory_tax',
        amount: { amountMinor: 2000, currency: 'AED' },
      },
    ],
  };
}

function tarifa(offerRef: string, totalText: string, amountMinor: number): HotelSearchContextPack {
  return { hotelId: '1120548', offerRef, totalText, currency: 'USD', seen: visto(amountMinor) };
}

function contexto(overrides: Partial<HotelSearchContext> = {}): HotelSearchContext {
  return {
    tenantId: AGENCIA,
    providerCode: PROVEEDOR,
    searchId: SEARCH_ID,
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: [
      { adults: 2, childrenAges: [7] },
      { adults: 1, childrenAges: [] },
    ],
    guestNationality: 'CO',
    searchSentAt: T0,
    expiresAt: VENCE,
    account: CUENTA,
    packs: [tarifa(BOOKING_CODE, '305.750', 30_575), tarifa(OTRO_BOOKING_CODE, '310.10', 31_010)],
    ...overrides,
  };
}

function referencia(overrides: Partial<HotelOfferReference> = {}): HotelOfferReference {
  return { providerCode: PROVEEDOR, searchId: SEARCH_ID, offerRef: BOOKING_CODE, ...overrides };
}

interface Banco {
  store: HotelSearchContextStore;
  cache: MemoryCacheAdapter;
  set: MockInstance<MemoryCacheAdapter['set']>;
}

function banco(cache = new MemoryCacheAdapter()): Banco {
  const set = vi.spyOn(cache, 'set');
  return { store: new HotelSearchContextStore(cache), cache, set };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guardar y leer por (tenantId, searchId)', () => {
  it('lo guardado se lee igual, con la huella de la cuenta y el literal del total de cada tarifa', async () => {
    const b = banco();
    await b.store.save(contexto());

    await expect(b.store.get(AGENCIA, SEARCH_ID)).resolves.toEqual(contexto());
  });

  it('lo leído es una copia: quien la cambia no toca el registro', async () => {
    const b = banco();
    await b.store.save(contexto());

    const leido = await b.store.get(AGENCIA, SEARCH_ID);
    leido?.rooms[0]?.childrenAges.push(3);

    expect((await b.store.get(AGENCIA, SEARCH_ID))?.rooms[0]?.childrenAges).toEqual([7]);
  });

  it('RF-08 CA-1: un `searchId` de otro tenant no resuelve, aunque compartan la cuenta heredada', async () => {
    const b = banco();
    await b.store.save(contexto());

    await expect(b.store.get(OTRA_AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
    const err = await b.store
      .resolveOffer(OTRA_AGENCIA, referencia(), CUENTA)
      .catch((e: unknown) => e);
    // La MISMA respuesta que una búsqueda inexistente: no confirma que el id ajeno existe.
    expect(err).toBeInstanceOf(HotelSearchContextExpiredError);
    const inexistente = await b.store
      .resolveOffer(AGENCIA, referencia({ searchId: 'no-existe' }), CUENTA)
      .catch((e: unknown) => e);
    expect((inexistente as Error).message).toBe((err as Error).message);
  });

  /*
   * MUTACIÓN: sin el tenant en la clave, la segunda puerta de `get` sigue negando el registro
   * ajeno, pero el guardado del segundo tenant pisa el del primero y su tarifa deja de resolver.
   */
  it('RNF-06 punto 2: el mismo `searchId` en dos tenants son dos contextos y ninguno pisa al otro', async () => {
    const b = banco();
    await b.store.save(contexto());
    await b.store.save(
      contexto({
        tenantId: OTRA_AGENCIA,
        packs: [tarifa(OTRO_BOOKING_CODE, '999.00', 99_900)],
      }),
    );

    await expect(b.store.resolveOffer(AGENCIA, referencia(), CUENTA)).resolves.toMatchObject({
      tenantId: AGENCIA,
      pack: { offerRef: BOOKING_CODE, totalText: '305.750' },
    });
    await expect(
      b.store.resolveOffer(OTRA_AGENCIA, referencia({ offerRef: OTRO_BOOKING_CODE }), CUENTA),
    ).resolves.toMatchObject({ tenantId: OTRA_AGENCIA, pack: { totalText: '999.00' } });
    await expect(b.store.resolveOffer(OTRA_AGENCIA, referencia(), CUENTA)).rejects.toBeInstanceOf(
      HotelOfferNotInSearchError,
    );
  });

  it('la clave es del tenant: un id con forma de comodín o un tenant que no es UUID no llega a la caché', async () => {
    const b = banco();
    const get = vi.spyOn(b.cache, 'get');

    await expect(b.store.get(AGENCIA, '*')).resolves.toBeUndefined();
    await expect(b.store.get('no-es-uuid', SEARCH_ID)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('RF-08 CA-2: una referencia fuera del contexto es 400 antes de llamar al proveedor', () => {
  /** Un PreBook con la puerta del contexto delante, como lo cablea PR-4.5. */
  async function prebookConPuerta(
    b: Banco,
    ref: HotelOfferReference,
    prebook: ReturnType<typeof vi.fn>,
  ): Promise<unknown> {
    const oferta = await b.store.resolveOffer(AGENCIA, ref, CUENTA);
    return prebook(oferta.pack.offerRef);
  }

  it.each([
    [
      'un `BookingCode` que la búsqueda no emitió',
      referencia({ offerRef: `9999!TB!1!TB!${SEARCH_ID}` }),
    ],
    [
      'una tarifa de la búsqueda, atribuida a otro proveedor',
      referencia({ providerCode: 'despegar-hotels' }),
    ],
    ['una referencia malformada', referencia({ searchId: 'a:b*' })],
  ])('%s', async (_caso, ref) => {
    const b = banco();
    await b.store.save(contexto());
    const prebook = vi.fn();

    const err: unknown = await prebookConPuerta(b, ref, prebook).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelOfferNotInSearchError);
    expect((err as HotelOfferNotInSearchError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as HotelOfferNotInSearchError).reason).toBe('OFFER_NOT_IN_SEARCH');
    expect(prebook).not.toHaveBeenCalled();
  });

  it('una tarifa de la búsqueda resuelve con lo que dejó el servidor', async () => {
    const b = banco();
    await b.store.save(contexto());

    const oferta = await b.store.resolveOffer(
      AGENCIA,
      referencia({ offerRef: OTRO_BOOKING_CODE }),
      CUENTA,
    );

    const { packs: _packs, ...busqueda } = contexto();
    expect(oferta).toEqual({
      ...busqueda,
      pack: {
        hotelId: '1120548',
        offerRef: OTRO_BOOKING_CODE,
        totalText: '310.10',
        currency: 'USD',
        seen: visto(31_010),
      },
    });
  });
});

describe('RF-08 CA-3: la cuenta que reserva tiene que ser la que buscó', () => {
  it.each([
    ['la credencial rotó', { ...CUENTA, updatedAt: '2026-09-20T10:00:00.000Z' }],
    ['la agencia pasó de la cuenta heredada a una propia', { ...CUENTA, accountId: 'acc-agencia' }],
  ])('%s → volver a buscar (409), sin reenviar la referencia', async (_caso, ahora) => {
    const b = banco();
    await b.store.save(contexto());

    const err: unknown = await b.store
      .resolveOffer(AGENCIA, referencia(), ahora)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelSearchAccountChangedError);
    expect((err as HotelSearchAccountChangedError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as Error).message).toContain('Volvé a buscar');
  });

  it('la misma versión escrita de otra forma es la misma cuenta', async () => {
    const b = banco();
    await b.store.save(contexto());

    await expect(
      b.store.resolveOffer(AGENCIA, referencia(), { ...CUENTA, updatedAt: '2026-09-01T00:00:00Z' }),
    ).resolves.toMatchObject({ pack: { offerRef: BOOKING_CODE } });
  });
});

describe('RF-08 CA-4: el navegador no aporta ocupación ni importe', () => {
  it('la referencia sólo tiene proveedor, búsqueda y tarifa', () => {
    expect(Object.keys(HotelOfferReferenceSchema.shape).sort()).toEqual([
      'offerRef',
      'providerCode',
      'searchId',
    ]);
  });

  it('lo que el navegador mande de más se ignora: ocupación, nacionalidad e importe salen del servidor', async () => {
    const b = banco();
    await b.store.save(contexto());
    const adulterada = {
      ...referencia(),
      rooms: [{ adults: 1, childrenAges: [] }],
      guestNationality: 'AR',
      totalText: '1.00',
      checkinDate: '2027-01-01',
    } as HotelOfferReference;

    const oferta = await b.store.resolveOffer(AGENCIA, adulterada, CUENTA);

    expect(oferta.rooms).toEqual(contexto().rooms);
    expect(oferta.guestNationality).toBe('CO');
    expect(oferta.pack.totalText).toBe('305.750');
    expect(oferta.checkinDate).toBe('2026-11-10');
  });
});

describe('vence con la oferta (RF-09)', () => {
  it('el TTL es el que le queda a la oferta, no uno fijo', async () => {
    const b = banco();
    await b.store.save(contexto());
    expect(b.set.mock.calls[0]?.[2]).toBe(27 * 60);

    vi.setSystemTime(T0 + 2 * MIN);
    await b.store.save(contexto({ searchId: 'otra-busqueda' }));
    expect(b.set.mock.calls[1]?.[2]).toBe(25 * 60);
  });

  it('un instante antes de `expiresAt` resuelve; en `expiresAt`, pide volver a buscar', async () => {
    const b = banco();
    await b.store.save(contexto());

    vi.setSystemTime(VENCE - 1);
    await expect(b.store.resolveOffer(AGENCIA, referencia(), CUENTA)).resolves.toBeDefined();

    vi.setSystemTime(VENCE);
    const err: unknown = await b.store
      .resolveOffer(AGENCIA, referencia(), CUENTA)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelSearchContextExpiredError);
    expect((err as HotelSearchContextExpiredError).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('un acierto de caché conserva el `searchSentAt` original', async () => {
    const b = banco();
    await b.store.save(contexto());

    vi.setSystemTime(T0 + 25 * MIN);
    const leido = await b.store.get(AGENCIA, SEARCH_ID);

    expect(leido?.searchSentAt).toBe(T0);
    expect(leido?.expiresAt).toBe(VENCE);
  });

  it('guardar otra vez la misma búsqueda no reinicia el reloj ni estira el vencimiento', async () => {
    const b = banco();
    await b.store.save(contexto());

    vi.setSystemTime(T0 + 10 * MIN);
    await b.store.save(contexto({ searchSentAt: T0 + 10 * MIN, expiresAt: VENCE + 10 * MIN }));

    expect((await b.store.get(AGENCIA, SEARCH_ID))?.searchSentAt).toBe(T0);
    vi.setSystemTime(VENCE);
    await expect(b.store.get(AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
  });

  it('un contexto que ya llegó vencido no se guarda', async () => {
    const b = banco();
    vi.setSystemTime(VENCE);

    await expect(b.store.save(contexto())).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(b.set).not.toHaveBeenCalled();
  });

  /*
   * MUTACIÓN: sin la comparación con `expiresAt` en `get`, el TTL de la caché —en segundos
   * enteros, redondeado hacia arriba— deja resolver una tarifa hasta un segundo después de vencida.
   */
  it('el TTL en segundos enteros no estira el vencimiento: en `expiresAt` ya no resuelve', async () => {
    const b = banco();
    vi.setSystemTime(T0 + 500);
    await b.store.save(contexto());
    const clave = `hotels:search-context:${AGENCIA}:${SEARCH_ID}`;

    vi.setSystemTime(VENCE);
    await expect(b.store.get(AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
    // La caché todavía lo tenía; se borra al leerlo vencido.
    expect(b.set.mock.calls[0]?.[2]).toBe(27 * 60);
    await expect(b.cache.get(clave)).resolves.toBeNull();
  });

  it('el mismo `searchId` de otro proveedor no pisa el primero, y queda a la vista', async () => {
    const b = banco();
    await b.store.save(contexto());

    await b.store.save(contexto({ providerCode: 'stub-hotels' }));

    expect((await b.store.get(AGENCIA, SEARCH_ID))?.providerCode).toBe(PROVEEDOR);
    expect(b.set).toHaveBeenCalledTimes(1);
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain(
      'hotels.search_context.duplicate_search_id provider=stub-hotels kept=tbo-hotels',
    );
    expect(logueado).not.toContain(SEARCH_ID);
  });
});

describe('falla hacia el lado seguro', () => {
  it('un contexto perdido (un despliegue vacía la memoria) pide volver a buscar', async () => {
    await banco().store.save(contexto());
    const trasElDespliegue = banco();

    const err: unknown = await trasElDespliegue.store
      .resolveOffer(AGENCIA, referencia(), CUENTA)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelSearchContextExpiredError);
    expect((err as HotelSearchContextExpiredError).reason).toBe('SEARCH_CONTEXT_EXPIRED');
    expect((err as Error).message).toContain('Volvé a buscar');
  });

  it('un registro ilegible en la caché (otra versión) no existe y se borra', async () => {
    const cache = new MemoryCacheAdapter();
    const b = banco(cache);
    const clave = `hotels:search-context:${AGENCIA}:${SEARCH_ID}`;
    await cache.set(clave, { ...contexto(), packs: [{ offerRef: BOOKING_CODE }] }, 600);

    await expect(b.store.get(AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
    await expect(cache.get(clave)).resolves.toBeNull();
  });

  it('un valor de otro tenant bajo la clave de éste no resuelve', async () => {
    const cache: CachePort = {
      get: <T>() => Promise.resolve(contexto({ tenantId: OTRA_AGENCIA }) as T),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      invalidatePattern: () => Promise.resolve(),
    };

    await expect(
      new HotelSearchContextStore(cache).get(AGENCIA, SEARCH_ID),
    ).resolves.toBeUndefined();
  });

  it('`forget` lo olvida (TBO `315`): la siguiente resolución pide volver a buscar', async () => {
    const b = banco();
    await b.store.save(contexto());

    await b.store.forget(AGENCIA, SEARCH_ID);

    await expect(b.store.resolveOffer(AGENCIA, referencia(), CUENTA)).rejects.toBeInstanceOf(
      HotelSearchContextExpiredError,
    );
  });

  it('`forget` con ids malformados no toca la caché', async () => {
    const b = banco();
    const del = vi.spyOn(b.cache, 'delete');

    await b.store.forget(AGENCIA, 'hotels:*');
    await b.store.forget('no-es-uuid', SEARCH_ID);

    expect(del).not.toHaveBeenCalled();
  });
});

describe('entradas validadas con Zod', () => {
  it.each<[string, Partial<HotelSearchContext> | Record<string, unknown>]>([
    [
      'un total que no es el literal decimal',
      { packs: [{ ...contexto().packs[0], totalText: '305,75' }] },
    ],
    ['un total negativo', { packs: [{ ...contexto().packs[0], totalText: '-1.00' }] }],
    ['sin tarifas', { packs: [] }],
    ['dos tarifas con la misma referencia', { packs: [contexto().packs[0], contexto().packs[0]] }],
    ['una nacionalidad que no es alfa-2', { guestNationality: 'COL' }],
    ['una habitación sin adultos', { rooms: [{ adults: 0, childrenAges: [] }] }],
    ['salida antes que entrada', { checkoutDate: '2026-11-09' }],
    ['un vencimiento anterior a la búsqueda', { expiresAt: T0 - 1 }],
    [
      'una vida más larga que el techo',
      { expiresAt: T0 + HOTEL_SEARCH_CONTEXT_MAX_LIFETIME_MS + 1 },
    ],
    ['una huella con el secreto al lado', { account: { ...CUENTA, password: 'x' } }],
    ['un campo que no es del contexto', { leadGuestName: 'Juan Pérez' }],
    [
      'una habitación con un dato de más',
      { rooms: [{ adults: 2, childrenAges: [], names: ['Ana'] }] },
    ],
    [
      'una tarifa sin lo que mostró la búsqueda',
      { packs: [{ ...tarifa(BOOKING_CODE, '305.75', 30_575), seen: undefined }] },
    ],
    [
      'lo mostrado con un dato de más',
      {
        packs: [
          {
            ...tarifa(BOOKING_CODE, '305.75', 30_575),
            seen: { ...visto(30_575), leadGuest: 'Ana' },
          },
        ],
      },
    ],
    [
      'un cargo en el hotel con un dato de más en el importe',
      {
        packs: [
          {
            ...tarifa(BOOKING_CODE, '305.75', 30_575),
            seen: {
              ...visto(30_575),
              atPropertyCharges: [
                {
                  description: 'Impuesto',
                  amount: { amountMinor: 1, currency: 'AED', raw: '1.00' },
                },
              ],
            },
          },
        ],
      },
    ],
  ])('%s → no se guarda y la búsqueda de ese proveedor falla con motivo', async (_caso, cambio) => {
    const b = banco();

    const err: unknown = await b.store.save({ ...contexto(), ...cambio }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelSearchContextUnavailableError);
    expect((err as HotelSearchContextUnavailableError).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(b.set).not.toHaveBeenCalled();
  });

  it('pack por pack: los literales que el decimal del ACL de TBO admite y el registro no, se detectan antes de guardar', () => {
    const pack = tarifa(BOOKING_CODE, '305.750', 30_575);

    expect(isStorablePackContext(pack)).toBe(true);
    for (const totalText of ['3.0575E2', '1e-7', '-0.00', ' 305.75', '+305.75']) {
      expect(isStorablePackContext({ ...pack, totalText })).toBe(false);
    }
    expect(isStorablePackContext({ ...pack, leadGuest: 'Ana' } as typeof pack)).toBe(false);
  });

  it('el log de un rechazo lleva rutas y códigos, nunca valores del huésped ni de la tarifa', async () => {
    const b = banco();

    await b.store
      .save(
        contexto({
          guestNationality: 'COL',
          rooms: [{ adults: 2, childrenAges: [99] }],
          packs: [tarifa(BOOKING_CODE, 'x305', 30_500)],
        }),
      )
      .catch(() => undefined);

    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain('hotels.search_context.rejected provider=tbo-hotels');
    expect(logueado).toContain('guestNationality:');
    for (const valor of ['COL', '99', 'x305', BOOKING_CODE, SEARCH_ID]) {
      expect(logueado).not.toContain(valor);
    }
  });
});

describe('lo que la búsqueda mostró de cada tarifa (base de C1, RF-15)', () => {
  const PACK: HotelRoompack = {
    id: BOOKING_CODE,
    provider: { name: PROVEEDOR, offerRef: BOOKING_CODE, raw: { searchId: SEARCH_ID } },
    board: 'RO',
    boardLabel: 'Sólo alojamiento',
    mealTypeRaw: 'Room_Only',
    rooms: [{ name: 'Luxury Room', reference: 0, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [], policySource: 'none' },
    price: {
      total: { amountMinor: 30_575, currency: 'USD' },
      taxesDetail: [],
      minimumSellingPrice: { amountMinor: 32_134, currency: 'USD' },
    },
    atPropertyCharges: [
      {
        roomIndex: 1,
        description: 'Impuesto obligatorio',
        descriptionRaw: 'mandatory_tax',
        amount: { amountMinor: 2000, currency: 'AED' },
      },
    ],
    inclusionText: 'Free WiFi',
  };

  it('neto, reembolsable, régimen y cargos en el hotel; nada del resto del pack', () => {
    expect(searchRateFactsOf(PACK)).toEqual(visto(30_575));
  });

  it('sin literal de régimen ni cargos en el hotel: sin régimen crudo y lista vacía', () => {
    const { mealTypeRaw: _meal, atPropertyCharges: _fees, ...sinNada } = PACK;

    expect(searchRateFactsOf(sinNada)).toEqual({
      total: { amountMinor: 30_575, currency: 'USD' },
      refundable: false,
      board: 'RO',
      atPropertyCharges: [],
    });
  });

  it('es una copia: cambiar el pack después no cambia lo que se mostró', () => {
    const pack = structuredClone(PACK);
    const hechos = searchRateFactsOf(pack);

    pack.price.total.amountMinor = 1;
    const cargo = pack.atPropertyCharges?.[0];
    if (cargo !== undefined) cargo.amount.amountMinor = 1;

    expect(hechos).toEqual(visto(30_575));
  });
});

describe('RF-15 CA-4: una tarifa que el proveedor dio por no disponible', () => {
  it('responde 409 sin volver a preguntar; las otras tarifas de la búsqueda siguen', async () => {
    const b = banco();
    await b.store.save(contexto());

    await b.store.invalidateOffer(AGENCIA, SEARCH_ID, BOOKING_CODE);

    const err: unknown = await b.store
      .resolveOffer(AGENCIA, referencia(), CUENTA)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotelOfferUnavailableError);
    expect((err as HotelOfferUnavailableError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((err as HotelOfferUnavailableError).reason).toBe('OFFER_UNAVAILABLE');
    await expect(
      b.store.resolveOffer(AGENCIA, referencia({ offerRef: OTRO_BOOKING_CODE }), CUENTA),
    ).resolves.toMatchObject({ pack: { offerRef: OTRO_BOOKING_CODE } });
  });

  it('la marca es del tenant y vence con la búsqueda', async () => {
    const b = banco();
    await b.store.save(contexto());
    await b.store.save(contexto({ tenantId: OTRA_AGENCIA }));

    vi.setSystemTime(T0 + 7 * MIN);
    await b.store.invalidateOffer(AGENCIA, SEARCH_ID, BOOKING_CODE);

    expect(b.set.mock.calls[2]?.[2]).toBe(20 * 60);
    // La referencia va digerida: el `BookingCode` no aparece en la clave.
    expect(String(b.set.mock.calls[2]?.[0])).not.toContain(BOOKING_CODE);
    await expect(b.store.resolveOffer(OTRA_AGENCIA, referencia(), CUENTA)).resolves.toMatchObject({
      tenantId: OTRA_AGENCIA,
    });
  });

  it('sin búsqueda vigente no deja ninguna marca', async () => {
    const b = banco();

    await b.store.invalidateOffer(AGENCIA, SEARCH_ID, BOOKING_CODE);

    expect(b.set).not.toHaveBeenCalled();
  });
});

describe('errores con motivo máquina', () => {
  it('sin la nacionalidad del pasajero principal: 409, volver a buscar indicándola', () => {
    const err = new HotelSearchNationalityMissingError();

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe('GUEST_NATIONALITY_MISSING');
    expect(err.name).toBe('HotelSearchNationalityMissingError');
    expect(err.message).toContain('Volvé a buscar');
  });
});
