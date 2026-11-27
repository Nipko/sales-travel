import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

/**
 * Ola 3 del plan de QA (docs/qa/01 §5 VUE, HOT), en el navegador: los formularios de búsqueda dicen
 * qué falta antes de salir a buscar. Las reglas una por una las cubren search-form-model.test.ts y
 * hoteles/actions.test.ts; acá, que el aviso llegue a la pantalla y que no se busque nada.
 *
 * El stack E2E no tiene proveedores: ninguna de estas búsquedas debe llegar a uno.
 */

test.describe('búsquedas', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('VUE-04 vuelos sin origen: lo pide y no busca', async ({ page }) => {
    await page.goto('/cotizaciones');
    const busquedas: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /search|cotizaciones/.test(r.url())) busquedas.push(r.url());
    });
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page.getByText('Elige el aeropuerto de origen.')).toBeVisible();
    expect(busquedas).toEqual([]);
  });

  test('HOT-04 hoteles sin destino: lo pide', async ({ page }) => {
    await page.goto('/hoteles');
    await page.getByRole('button', { name: 'Buscar hoteles' }).click();
    await expect(page.getByText(/Elige un destino|indica IDs de hotel/).first()).toBeVisible();
  });
});
