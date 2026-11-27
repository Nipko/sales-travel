import { expect, test } from '@playwright/test';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { E2E_PASSWORD } from '../support/users';

/**
 * Ola 3 del plan de QA (docs/qa/01 §5 ACC), ACC-15: quien tiene que cambiar la contraseña (un admin
 * se lo pidió) no entra; el panel lo dice, el correo trae el enlace y, cambiada, entra con la nueva.
 *
 * `cambio@e2e.test` (seed.sql) llega en cada corrida con el cambio pendiente.
 */

const EMAIL = 'cambio@e2e.test';
const NUEVA = 'Cambiada-En-El-Panel-2026!';

test.describe('cambio de contraseña pedido', { tag: '@desktop' }, () => {
  test('ACC-15 aviso + correo con enlace; al cambiarla entra', async ({ page }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const desde = new Date(Date.now() - 1_000);

    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(EMAIL);
    await page.getByLabel('Contraseña', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(page.getByText(/Tienes que elegir una contraseña nueva/)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    const correo = await ultimoCorreo(EMAIL, { desde });
    const enlace = correo?.enlaces.find((e) => /\/restablecer\?token=/.test(e));
    expect(enlace, 'el correo trae el enlace').toBeDefined();
    const { pathname, search } = new URL(enlace!);

    await page.goto(`${pathname}${search}`);
    await page.getByLabel('Contraseña nueva').fill(NUEVA);
    await page.getByLabel('Repetir contraseña').fill(NUEVA);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('heading', { name: 'Contraseña actualizada' })).toBeVisible();

    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(EMAIL);
    await page.getByLabel('Contraseña', { exact: true }).fill(NUEVA);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  });
});
