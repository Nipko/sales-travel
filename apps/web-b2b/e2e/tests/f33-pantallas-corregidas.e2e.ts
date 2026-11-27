import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

/**
 * Ola 3 del plan de QA, en el navegador: lo que se corrigió en la pantalla (tanda 11) y el aviso de
 * que la plataforma no vende.
 *
 * - COT-02 (QA-H-18): Cotizaciones guardadas tiene la pestaña «Canceladas».
 * - CLI-02 (QA-H-19): el alta de un viajero pide nacimiento, género y nacionalidad, sin relleno.
 * - VUE-16: el superadmin ve en /cotizaciones que la plataforma no vende.
 */

test.describe('vendedor', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('COT-02 Cotizaciones guardadas tiene la pestaña Canceladas', async ({ page }) => {
    await page.goto('/cotizaciones/guardadas');
    await expect(page.getByRole('button', { name: /^Canceladas/ })).toBeVisible();
  });

  test('CLI-02 el alta de un viajero pide nacimiento, género y nacionalidad, sin valores de relleno', async ({
    page,
  }) => {
    await page.goto('/clientes');
    await page.getByRole('button', { name: /Directorio Viajeros/ }).click();
    await page.getByRole('button', { name: /Nuevo Viajero/ }).click();
    await expect(page.getByLabel('Nacimiento')).toHaveValue('');
    await expect(page.getByLabel('Género')).toHaveValue('');
    await expect(page.getByLabel('Nacionalidad')).toBeVisible();
  });
});

test.describe('superadmin', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('superadmin') });

  test('VUE-16 la plataforma no vende: el aviso en /cotizaciones', async ({ page }) => {
    await page.goto('/cotizaciones');
    await expect(page.getByText(/El superadministrador no vende/).first()).toBeVisible();
  });
});
