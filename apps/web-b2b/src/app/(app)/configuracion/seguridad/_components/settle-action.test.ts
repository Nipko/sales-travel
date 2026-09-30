import { describe, expect, it } from 'vitest';
import { isNextNavigation, settleAction, TRANSPORT_FAILURE_MESSAGE } from './settle-action';

function nextSignal(digest: string): Error {
  return Object.assign(new Error('NEXT'), { digest });
}

describe('settleAction', () => {
  it('devuelve lo que devolvió la acción, también sus errores del API', async () => {
    await expect(settleAction(() => Promise.resolve({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(
      settleAction(() => Promise.resolve({ error: 'Esa sesión ya estaba cerrada.' })),
    ).resolves.toEqual({ error: 'Esa sesión ya estaba cerrada.' });
  });

  it('una acción que redirigió sin devolver nada sigue sin devolver nada', async () => {
    await expect(settleAction(() => Promise.resolve(undefined))).resolves.toBeUndefined();
  });

  it('un corte de red no se escapa a la transición: vuelve como error del formulario', async () => {
    // Lo que rechaza el fetch de la server action con la red caída o tras un deploy nuevo.
    await expect(
      settleAction(() => Promise.reject(new TypeError('Failed to fetch'))),
    ).resolves.toEqual({ transport: true, error: TRANSPORT_FAILURE_MESSAGE });
    await expect(
      settleAction(() =>
        Promise.reject(new Error('An unexpected response was received from the server.')),
      ),
    ).resolves.toMatchObject({ error: TRANSPORT_FAILURE_MESSAGE });
    await expect(
      settleAction(() =>
        Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
      ),
    ).resolves.toMatchObject({ transport: true });
  });

  it('el redirect de Next pasa de largo: la navegación tiene que seguir', async () => {
    const redirect = nextSignal('NEXT_REDIRECT;replace;/login?motivo=cerrada;307;');
    await expect(settleAction(() => Promise.reject(redirect))).rejects.toBe(redirect);
  });
});

describe('isNextNavigation', () => {
  it('reconoce redirect, notFound y los errores HTTP de Next', () => {
    expect(isNextNavigation(nextSignal('NEXT_REDIRECT;push;/login;307;'))).toBe(true);
    expect(isNextNavigation(nextSignal('NEXT_NOT_FOUND'))).toBe(true);
    expect(isNextNavigation(nextSignal('NEXT_HTTP_ERROR_FALLBACK;404'))).toBe(true);
  });

  it('lo demás no es una navegación', () => {
    expect(isNextNavigation(new TypeError('Failed to fetch'))).toBe(false);
    expect(isNextNavigation(nextSignal('123456789'))).toBe(false);
    expect(isNextNavigation(null)).toBe(false);
    expect(isNextNavigation(undefined)).toBe(false);
    expect(isNextNavigation('NEXT_REDIRECT')).toBe(false);
  });
});
