import { expect, test, type Browser, type Page } from '@playwright/test';
import { submitCredentials } from '../support/auth';
import { atrasar } from '../support/reloj';
import { USERS, type UserKey } from '../support/users';

/**
 * Tanda 31 en el navegador (docs/qa/01 §5 ACC):
 *
 * - ACC-19: con la última actividad 31 minutos atrás (el nodo tiene 30), la sesión cae: el panel lleva a
 *   /login?motivo=inactividad y lo explica.
 * - ACC-20: el mismo usuario entra en otro navegador; el primero queda afuera con
 *   /login?motivo=otro-dispositivo y el consejo de cambiar la contraseña.
 */

const appShell = (page: Page) => page.getByRole('link', { name: 'Inicio', exact: true });

async function entrar(browser: Browser, key: UserKey): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await submitCredentials(page, USERS[key].email);
  await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
  return page;
}

test.describe('sesiones', { tag: '@auth' }, () => {
  test.setTimeout(120_000);

  test('ACC-19 la sesión inactiva cae y el login dice por qué', async ({ browser }) => {
    const page = await entrar(browser, 'inactivo');
    const n = await atrasar(
      'sessions',
      '31 minutes',
      'user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL',
      [USERS.inactivo.email],
    );
    expect(n, 'tiene una sesión abierta').toBeGreaterThan(0);
    await page.goto('/reportes');
    await expect(page).toHaveURL(/\/login\?.*motivo=inactividad/, { timeout: 20_000 });
    await expect(
      page.getByText(/Cerramos tu sesión (por inactividad|después de \d+ minutos sin actividad)\./),
    ).toBeVisible();
  });

  test('ACC-20 entrar en otro navegador saca al primero', async ({ browser }) => {
    const primero = await entrar(browser, 'doble');
    await entrar(browser, 'doble');
    await primero.goto('/reportes');
    await expect(primero).toHaveURL(/\/login\?.*motivo=otro-dispositivo/, { timeout: 20_000 });
    await expect(primero.getByText('Tu sesión se abrió en otro dispositivo.')).toBeVisible();
    await expect(
      primero.getByText('Si no fuiste tú, cambia tu contraseña después de ingresar.'),
    ).toBeVisible();
  });
});
