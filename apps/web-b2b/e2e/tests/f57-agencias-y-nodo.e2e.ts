import { expect, test } from '@playwright/test';
import { sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';

/**
 * Tanda 32 en el navegador, como superadmin (docs/qa/01 §5 SUP):
 *
 * - SUP-23: Agencias busca por nombre o slug (sin tildes ni mayúsculas) y dice cuando nada coincide; el
 *   alta de un nodo viene con Colombia, COP y Español.
 * - SUP-24: en la ficha de un nodo, «Tarifas de vuelo en otra moneda» pide confirmar al encender y al
 *   apagar, y avisa cada cambio.
 */

test.use({ storageState: storageStateFile('superadmin') });

test.describe('Agencias y ficha del nodo', { tag: '@desktop' }, () => {
  test.setTimeout(90_000);

  test('SUP-23 buscar y los valores por defecto del alta', async ({ page }) => {
    await page.goto('/admin/tenants');
    await expect(page.getByRole('heading', { name: 'Agencias', level: 1 })).toBeVisible();
    const buscar = page.getByRole('searchbox', { name: 'Buscar un nodo por nombre o slug' });
    const arbol = page.getByRole('list', { name: 'Nodos de la red' });

    await buscar.fill('E2E-AGENCIA-B');
    await expect(arbol.getByRole('link', { name: 'Agencia E2E B', exact: true })).toBeVisible();
    await expect(arbol.getByRole('link', { name: 'Agencia E2E A', exact: true })).toHaveCount(0);
    await buscar.fill('zzz-qa32-nada');
    await expect(page.getByText('Ningún nodo coincide con la búsqueda.')).toBeVisible();
    await buscar.fill('');

    await page.getByRole('button', { name: 'Nuevo nodo' }).click();
    const alta = page.getByRole('dialog', { name: 'Nuevo nodo' });
    await expect(alta.getByLabel('País')).toHaveValue('CO');
    await expect(alta.getByLabel('Moneda')).toHaveValue('COP');
    await expect(alta.getByLabel('Idioma')).toHaveValue('es');
    await alta.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('SUP-24 tarifas en otra moneda con confirmación', async ({ page }) => {
    const [b] = await sql<{ id: string }>("SELECT id FROM tenants WHERE slug = 'e2e-agencia-b'");
    await page.goto(`/admin/tenants/${b!.id}`);
    const interruptor = page.getByRole('switch', { name: 'Tarifas de vuelo en otra moneda' });
    await expect(interruptor).toBeVisible({ timeout: 20_000 });
    const encendido = (await interruptor.getAttribute('aria-checked')) === 'true';
    try {
      await interruptor.click();
      const dialogo = page.getByRole('dialog', {
        name: encendido ? 'Apagar tarifas en otra moneda' : 'Encender tarifas en otra moneda',
      });
      await dialogo.getByRole('button', { name: encendido ? 'Apagar' : 'Encender' }).click();
      await expect(
        page.getByText(
          encendido
            ? 'Agencia E2E B vuelve a ver sólo tarifas en su moneda.'
            : 'Agencia E2E B ya ve tarifas en otra moneda.',
        ),
      ).toBeVisible();
      await expect(interruptor).toHaveAttribute('aria-checked', String(!encendido));
    } finally {
      if ((await interruptor.getAttribute('aria-checked')) !== String(encendido)) {
        await interruptor.click();
        await page
          .getByRole('dialog', { name: /tarifas en otra moneda$/ })
          .getByRole('button', { name: encendido ? 'Encender' : 'Apagar' })
          .click();
        await expect(interruptor).toHaveAttribute('aria-checked', String(encendido));
      }
    }
  });
});
