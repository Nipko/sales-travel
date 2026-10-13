import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HotelRoompack } from '../actions';
import { encodeHotelKey } from './hotel-key';
import { RATE_SELECTION_STORAGE_KEY, parseRateSelections } from './hotel-rate-selection';
import { hotelRateRows, type HotelRateRow } from './hotel-rate-view';
import type { HotelStay } from './hotel-search-handoff';
import {
  RATE_SAVE_FAILED_MESSAGE,
  useBookRate,
  type BookRate,
  type UseBookRateOptions,
} from './use-book-rate';

const mocks = vi.hoisted(() => ({ push: vi.fn(), toastError: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

/*
 * Elegir una tarifa para reservarla: cuándo se puede y qué deja para el checkout. El hook se corre
 * en un pintado del servidor —sin navegador— y sus funciones se llaman después, como un clic.
 */

const SEARCH_ID = 'srch_01J9ZK4Q';
const HOTEL_KEY = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1' }]);
const SEARCH_TOKEN = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const STAY: HotelStay = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-13',
  rooms: [{ adults: 2, childrenAges: [] }],
  guestNationality: 'CO',
  refundableOnly: false,
  currency: 'USD',
};

function tarifa(id: string, extra: Partial<HotelRoompack> = {}): HotelRoompack {
  return {
    id,
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF`, raw: { searchId: SEARCH_ID } },
    board: 'RO',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: true, status: 'fully_refundable', rules: [] },
    price: { total: { amountMinor: 450_00, currency: 'USD' }, taxesDetail: [] },
    ...extra,
  };
}

function rowOf(pack: HotelRoompack): HotelRateRow {
  const [row] = hotelRateRows({ roompacks: [pack] }, false);
  return row!;
}

const BOOKABLE = rowOf(tarifa('A'));
const NO_SEARCH = rowOf(tarifa('B', { provider: { name: 'despegar-hotels', offerRef: 'B-REF' } }));
const NO_PROVIDER = rowOf(tarifa('C', { provider: undefined }));

function hookWith(options: Partial<UseBookRateOptions> = {}): BookRate {
  let captured: BookRate | undefined;
  function Probe() {
    captured = useBookRate({
      hotelKey: HOTEL_KEY,
      searchToken: SEARCH_TOKEN,
      stay: STAY,
      showProvider: false,
      shownFacts: { name: 'Hotel de la tarjeta', address: 'Calle 1' },
      ...options,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return captured!;
}

function memoryStorage({ failOnWrite = false } = {}) {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failOnWrite) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

function tokenOfPush(call: number): string {
  const href = mocks.push.mock.calls[call]?.[0] as string;
  const match = /^\/hoteles\/checkout\?tarifa=([^&]+)$/.exec(href);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useBookRate — canBook', () => {
  it('con hotel, estadía y referencia del PreBook, se puede reservar', () => {
    expect(hookWith().canBook(BOOKABLE)).toBe(true);
  });

  it('sin estadía no hay qué llevar al checkout', () => {
    expect(hookWith({ stay: undefined }).canBook(BOOKABLE)).toBe(false);
  });

  it('sin la clave del hotel no hay a dónde volver', () => {
    expect(hookWith({ hotelKey: undefined }).canBook(BOOKABLE)).toBe(false);
  });

  it('sin referencia del PreBook (sin searchId o sin proveedor) no se reserva desde el panel', () => {
    const hook = hookWith();
    expect(hook.canBook(NO_SEARCH)).toBe(false);
    expect(hook.canBook(NO_PROVIDER)).toBe(false);
  });
});

describe('useBookRate — book', () => {
  it('guarda la elección en "hoteles:tarifas" y va al checkout con su identificador', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });

    hookWith({
      factsFor: (code) => (code === 'tbo-hotels' ? { name: 'Hotel según TBO' } : undefined),
    }).book(BOOKABLE);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    const token = tokenOfPush(0);
    const saved = parseRateSelections(storage.getItem(RATE_SELECTION_STORAGE_KEY))[token];
    expect(saved).toMatchObject({
      reference: { providerCode: 'tbo-hotels', searchId: SEARCH_ID, offerRef: 'A-REF' },
      hotelKey: HOTEL_KEY,
      searchToken: SEARCH_TOKEN,
      stay: STAY,
      showProviderInResults: false,
      // El nombre del proveedor que vende; lo que no dice, del encabezado.
      hotel: { name: 'Hotel según TBO', address: 'Calle 1' },
      shownSale: { amountMinor: 450_00, currency: 'USD' },
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('cada clic con su identificador: dos pestañas no se pisan', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });

    const hook = hookWith();
    hook.book(BOOKABLE);
    hook.book(BOOKABLE);

    const first = tokenOfPush(0);
    const second = tokenOfPush(1);
    expect(first).not.toBe(second);
    const saved = parseRateSelections(storage.getItem(RATE_SELECTION_STORAGE_KEY));
    expect(Object.keys(saved).sort()).toEqual([first, second].sort());
  });

  it('sin almacenamiento, avisa y no navega', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage({ failOnWrite: true }) });

    hookWith().book(BOOKABLE);

    expect(mocks.toastError).toHaveBeenCalledWith(RATE_SAVE_FAILED_MESSAGE);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('una tarifa que no se puede reservar no guarda ni navega', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });

    hookWith().book(NO_SEARCH);
    hookWith({ stay: undefined }).book(BOOKABLE);
    hookWith({ hotelKey: undefined }).book(BOOKABLE);

    expect(storage.getItem(RATE_SELECTION_STORAGE_KEY)).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
