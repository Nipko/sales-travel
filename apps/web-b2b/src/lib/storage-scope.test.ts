import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readRateSelection,
  saveRateSelection,
  type RateSelection,
} from '../app/(app)/hoteles/_components/hotel-rate-selection';
import {
  readSearchHandoff,
  saveSearchHandoff,
  type SearchHandoff,
} from '../app/(app)/hoteles/_components/hotel-search-handoff';
import {
  forgetScopedStorage,
  scopedStorageKey,
  setStorageScope,
  storageScopeOf,
} from './storage-scope';

/** Un `localStorage` en memoria con lo que usa el alcance: get/set/remove, `length` y `key`. */
function memoryStorage({ throwing = false } = {}): Storage {
  const data = new Map<string, string>();
  const fail = () => {
    if (throwing) throw new Error('SecurityError');
  };
  return {
    get length() {
      fail();
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => {
      fail();
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      fail();
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

function inBrowser(storage: Storage): Storage {
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

const USER_A = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const USER_B = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const AGENCY_1 = '11111111-1111-4111-8111-111111111111';
const AGENCY_2 = '22222222-2222-4222-8222-222222222222';
const TOKEN = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

const HANDOFF: SearchHandoff = {
  stay: {
    checkinDate: '2026-12-10',
    checkoutDate: '2026-12-12',
    rooms: [{ adults: 2, childrenAges: [] }],
    guestNationality: 'CO',
    refundableOnly: false,
  },
  showProviderInResults: false,
  savedAt: Date.now(),
};

afterEach(() => {
  setStorageScope(undefined);
  vi.unstubAllGlobals();
});

describe('storageScopeOf', () => {
  it('usuario + agencia; sin uno de los dos, o con otra forma, no hay alcance', () => {
    expect(storageScopeOf(USER_A, AGENCY_1)).toBe(`${USER_A}.${AGENCY_1}`);
    expect(storageScopeOf(undefined, AGENCY_1)).toBeUndefined();
    expect(storageScopeOf(USER_A, undefined)).toBeUndefined();
    expect(storageScopeOf('a:b', AGENCY_1)).toBeUndefined();
  });
});

describe('setStorageScope', () => {
  it('en el servidor no fija nada: el módulo lo comparten todos los pedidos', () => {
    setStorageScope(storageScopeOf(USER_A, AGENCY_1));
    expect(scopedStorageKey('hoteles:busquedas')).toBeUndefined();
  });
});

describe('búsquedas y tarifas de hoteles con alcance (H6)', () => {
  it('otro usuario u otra agencia en el mismo navegador no ve lo guardado', () => {
    inBrowser(memoryStorage());
    setStorageScope(storageScopeOf(USER_A, AGENCY_1));
    saveSearchHandoff(TOKEN, HANDOFF);
    expect(readSearchHandoff(TOKEN)?.stay.guestNationality).toBe('CO');

    setStorageScope(storageScopeOf(USER_B, AGENCY_1));
    expect(readSearchHandoff(TOKEN)).toBeUndefined();
    setStorageScope(storageScopeOf(USER_A, AGENCY_2));
    expect(readSearchHandoff(TOKEN)).toBeUndefined();
  });

  it('al guardar se borra lo de otra sesión y la clave vieja sin alcance', () => {
    const storage = inBrowser(memoryStorage());
    storage.setItem('hoteles:busquedas', '{}');
    storage.setItem(`hoteles:busquedas:${USER_B}.${AGENCY_1}`, '{}');
    storage.setItem('tema', 'oscuro');

    setStorageScope(storageScopeOf(USER_A, AGENCY_1));
    saveSearchHandoff(TOKEN, HANDOFF);

    expect(storage.getItem('hoteles:busquedas')).toBeNull();
    expect(storage.getItem(`hoteles:busquedas:${USER_B}.${AGENCY_1}`)).toBeNull();
    expect(storage.getItem(`hoteles:busquedas:${USER_A}.${AGENCY_1}`)).not.toBeNull();
    expect(storage.getItem('tema')).toBe('oscuro');
  });

  it('sin alcance no se guarda ni se lee: la tarifa no se puede llevar al checkout', () => {
    const storage = inBrowser(memoryStorage());
    saveSearchHandoff(TOKEN, HANDOFF);
    expect(storage.length).toBe(0);
    expect(saveRateSelection(TOKEN, {} as RateSelection)).toBe(false);
    expect(readRateSelection(TOKEN)).toBeUndefined();
  });

  it('con el almacenamiento bloqueado nada tira', () => {
    inBrowser(memoryStorage({ throwing: true }));
    setStorageScope(storageScopeOf(USER_A, AGENCY_1));
    expect(() => saveSearchHandoff(TOKEN, HANDOFF)).not.toThrow();
    expect(readSearchHandoff(TOKEN)).toBeUndefined();
    expect(() => forgetScopedStorage()).not.toThrow();
  });
});

describe('forgetScopedStorage — al cerrar sesión', () => {
  it('borra búsquedas y tarifas de toda sesión y deja lo demás', () => {
    const storage = inBrowser(memoryStorage());
    storage.setItem(`hoteles:busquedas:${USER_A}.${AGENCY_1}`, '{}');
    storage.setItem(`hoteles:tarifas:${USER_A}.${AGENCY_1}`, '{}');
    storage.setItem('hoteles:tarifas', '{}');
    storage.setItem('hoteles:ultima-nacionalidad', 'CO');

    forgetScopedStorage();

    expect(storage.length).toBe(1);
    expect(storage.getItem('hoteles:ultima-nacionalidad')).toBe('CO');
  });
});
