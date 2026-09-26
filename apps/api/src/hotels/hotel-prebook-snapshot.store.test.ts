import { HttpStatus, Logger } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import {
  HotelPrebookSnapshotStore,
  HotelPrebookSnapshotUnavailableError,
  type HotelPrebookSnapshot,
} from './hotel-prebook-snapshot.store.js';
import { HotelSearchContextExpiredError } from './hotel-search-context.store.js';

/**
 * El PreBook aceptable en el servidor (docs/tbo/09 PR-4.5): lo que la saga del Book (PR-4.6) lee por
 * `prebookRef`. Mismas reglas que el contexto de búsqueda: vence con la oferta, es del tenant y se
 * valida al entrar y al salir.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const PREBOOK_REF = '8b0f4a52-6f4e-4c1e-9a55-0d3c1c2b7e10';
const BOOKING_CODE = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';

const T0 = Date.parse('2026-09-25T15:00:00Z');
const MIN = 60_000;
const VENCE = T0 + 27 * MIN;

function snapshot(overrides: Partial<HotelPrebookSnapshot> = {}): HotelPrebookSnapshot {
  return {
    prebookRef: PREBOOK_REF,
    tenantId: AGENCIA,
    providerCode: 'tbo-hotels',
    searchId: '6110a41c-558c-405c-a0d3-6bdd3e131146',
    account: { accountId: 'acc-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' },
    hotelId: '1120548',
    offerRef: BOOKING_CODE,
    totalText: '305.75',
    currency: 'USD',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-11',
    rooms: [{ adults: 2, childrenAges: [] }],
    guestNationality: 'CO',
    searchSentAt: T0,
    expiresAt: VENCE,
    roompack: {
      id: BOOKING_CODE,
      provider: {
        name: 'tbo-hotels',
        offerRef: BOOKING_CODE,
        raw: { searchId: '6110a41c-558c-405c-a0d3-6bdd3e131146' },
      },
      board: 'RO',
      rooms: [{ name: 'Luxury Room', reference: 0, bedOptions: [] }],
      cancellation: {
        refundable: false,
        status: 'non_refundable',
        rules: [{ type: 'Percentage', penaltyPercentage: 100 }],
        policySource: 'prebook-final',
      },
      price: { total: { amountMinor: 30_575, currency: 'USD' }, taxesDetail: [] },
      pricing: { costMinor: 31_492, finalMinor: 32_134, ownMarkupMinor: 642, currency: 'USD' },
    },
    rateConditions: [
      { category: 'checkOut', text: 'CheckOut Time: 12:00 PM', raw: 'CheckOut Time: 12:00 PM' },
    ],
    signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
    rateConditionsHash: 'a'.repeat(64),
    comparison: {
      stage: 'C1',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: 30_575, currency: 'USD' },
      currentTotal: { amountMinor: 30_575, currency: 'USD' },
    },
    createdAt: T0,
    ...overrides,
  };
}

interface Banco {
  store: HotelPrebookSnapshotStore;
  cache: MemoryCacheAdapter;
  set: MockInstance<MemoryCacheAdapter['set']>;
}

function banco(): Banco {
  const cache = new MemoryCacheAdapter();
  const set = vi.spyOn(cache, 'set');
  return { store: new HotelPrebookSnapshotStore(cache), cache, set };
}

const CLAVE = `hotels:prebook:${AGENCIA}:${PREBOOK_REF}`;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 + 2 * MIN });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('guardar y leer por (tenantId, prebookRef)', () => {
  it('lo guardado se lee igual, y sólo lo lee el tenant que lo guardó', async () => {
    const b = banco();
    await b.store.save(snapshot());

    await expect(b.store.get(AGENCIA, PREBOOK_REF)).resolves.toEqual(snapshot());
    await expect(b.store.get(OTRA_AGENCIA, PREBOOK_REF)).resolves.toBeUndefined();
  });

  it('vence con la oferta: el TTL es lo que le queda, y en `expiresAt` ya no resuelve', async () => {
    const b = banco();
    await b.store.save(snapshot());
    expect(b.set.mock.calls[0]?.[2]).toBe(25 * 60);
  });

  /*
   * MUTACIÓN: sin la comparación con `expiresAt` en `get`, el TTL de la caché —en segundos
   * enteros, redondeado hacia arriba— deja aceptar un PreBook hasta un segundo después de vencido.
   */
  it('el TTL en segundos enteros no estira el vencimiento: en `expiresAt` ya no resuelve', async () => {
    const b = banco();
    vi.setSystemTime(T0 + 2 * MIN + 500);
    await b.store.save(snapshot());

    vi.setSystemTime(VENCE);
    await expect(b.store.get(AGENCIA, PREBOOK_REF)).resolves.toBeUndefined();
    await expect(b.cache.get(CLAVE)).resolves.toBeNull();
  });

  it('un PreBook que llega con la oferta vencida no se guarda: volver a buscar', async () => {
    const b = banco();
    vi.setSystemTime(VENCE);

    await expect(b.store.save(snapshot())).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
    expect(b.set).not.toHaveBeenCalled();
  });

  it('ids que no son UUID no llegan a la caché', async () => {
    const b = banco();
    const get = vi.spyOn(b.cache, 'get');

    await expect(b.store.get(AGENCIA, 'hotels:*')).resolves.toBeUndefined();
    await expect(b.store.get('no-es-uuid', PREBOOK_REF)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('lo que no está no existe', async () => {
    await expect(banco().store.get(AGENCIA, PREBOOK_REF)).resolves.toBeUndefined();
  });
});

describe('falla hacia el lado seguro', () => {
  it('un registro ilegible (otra versión) no existe, se borra y el log no cita valores', async () => {
    const b = banco();
    await b.cache.set(CLAVE, { ...snapshot(), totalText: 'x305', guestNationality: 'COL' }, 600);

    await expect(b.store.get(AGENCIA, PREBOOK_REF)).resolves.toBeUndefined();
    await expect(b.cache.get(CLAVE)).resolves.toBeNull();
    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain('hotels.prebook_snapshot.unreadable');
    for (const valor of ['x305', 'COL', BOOKING_CODE]) expect(logueado).not.toContain(valor);
  });

  it('un valor de otro tenant bajo la clave de éste no resuelve', async () => {
    const cache: CachePort = {
      get: <T>() => Promise.resolve(snapshot({ tenantId: OTRA_AGENCIA }) as T),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      invalidatePattern: () => Promise.resolve(),
    };

    await expect(
      new HotelPrebookSnapshotStore(cache).get(AGENCIA, PREBOOK_REF),
    ).resolves.toBeUndefined();
  });
});

describe('validado con Zod al entrar', () => {
  it.each<[string, Partial<HotelPrebookSnapshot> | Record<string, unknown>]>([
    ['un total que no es el literal decimal', { totalText: '305,75' }],
    ['una moneda distinta de la del pack', { currency: 'EUR' }],
    ['un vencimiento anterior a la búsqueda', { expiresAt: T0 - 1 }],
    ['una huella de condiciones que no es sha256', { rateConditionsHash: 'abc' }],
    ['una señal fuera del vocabulario', { signals: ['VENDER_SOLO_LOS_MARTES'] }],
    ['un campo que no es del snapshot', { leadGuestName: 'Juan Pérez' }],
    [
      'una huella de cuenta con el secreto al lado',
      { account: { accountId: 'a', updatedAt: '2026-09-01T00:00:00Z', password: 'x' } },
    ],
  ])('%s → 503 y no se guarda', async (_caso, cambio) => {
    const b = banco();

    const err: unknown = await b.store.save({ ...snapshot(), ...cambio }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HotelPrebookSnapshotUnavailableError);
    expect((err as HotelPrebookSnapshotUnavailableError).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((err as HotelPrebookSnapshotUnavailableError).reason).toBe(
      'PREBOOK_SNAPSHOT_UNAVAILABLE',
    );
    expect(b.set).not.toHaveBeenCalled();
  });

  it('el log de un rechazo lleva rutas y códigos, nunca valores', async () => {
    const b = banco();

    await b.store
      .save(snapshot({ guestNationality: 'COL', rooms: [{ adults: 2, childrenAges: [99] }] }))
      .catch(() => undefined);

    const logueado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logueado).toContain('hotels.prebook_snapshot.rejected provider=tbo-hotels');
    expect(logueado).toContain('guestNationality:');
    for (const valor of ['COL', '99', BOOKING_CODE]) expect(logueado).not.toContain(valor);
  });
});
