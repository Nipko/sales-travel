import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStorageScope, storageScopeOf } from '../../lib/storage-scope';
import { endSession, logout, resetLeaving } from './session-sync';

/*
 * Al salir del panel (cerrar sesión, o una sesión que cortó el servidor) se olvidan las búsquedas y
 * tarifas de hoteles que la sesión dejó en este navegador (auditoría de flujos de venta, H6).
 */

function browser() {
  const data = new Map<string, string>();
  const localStorage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const replace = vi.fn();
  vi.stubGlobal('window', {
    localStorage,
    location: { replace, pathname: '/hoteles', search: '' },
  });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  const scope = storageScopeOf(
    '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    '11111111-1111-4111-8111-111111111111',
  );
  localStorage.setItem(`hoteles:busquedas:${scope}`, '{}');
  localStorage.setItem(`hoteles:tarifas:${scope}`, '{}');
  setStorageScope(scope);
  return { data, replace };
}

afterEach(() => {
  setStorageScope(undefined);
  resetLeaving();
  vi.unstubAllGlobals();
});

describe('session-sync — salir borra lo guardado para hoteles', () => {
  it('cerrar sesión', async () => {
    const { data, replace } = browser();
    await logout();
    expect([...data.keys()].filter((k) => k.startsWith('hoteles:'))).toEqual([]);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('una sesión que el servidor ya cortó', () => {
    const { data, replace } = browser();
    endSession('inactividad');
    expect([...data.keys()].filter((k) => k.startsWith('hoteles:'))).toEqual([]);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
