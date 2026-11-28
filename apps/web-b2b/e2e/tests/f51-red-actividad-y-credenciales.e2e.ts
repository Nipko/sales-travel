import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

/**
 * Tanda 26 en el navegador, con admin-a (docs/qa/01 §5 RED y BYO):
 *
 * - RED-02: la agencia ofrece «Sub-agencia bajo …»; la sub-agencia (nivel 4) no ofrece crear nada.
 * - RED-03: un slug con mayúsculas escrito a mano vuelve con el motivo en castellano.
 * - RED-12: «Actividad de la red» filtra por categoría con botones que dicen cuál está activo.
 */

test.use({ storageState: storageStateFile('adminA') });

test.describe('Mi Red', { tag: '@desktop' }, () => {
  test('RED-02 / RED-03 qué se puede crear y el slug mal escrito', async ({ page }) => {
    await page.goto('/red');
    await expect(
      page.getByRole('button', { name: /^(Sub-agencia|Agregar) bajo Agencia E2E A$/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /bajo Subagencia E2E$/ })).toHaveCount(0);

    await page.getByRole('button', { name: /^(Sub-agencia|Agregar) bajo Agencia E2E A$/ }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('Nombre', { exact: true }).fill('QA26 Mayúsculas');
    await expect(dialogo.getByLabel('Slug (URL)')).toHaveValue('qa26-mayusculas');
    await dialogo.getByLabel('Slug (URL)').fill('QA26 Mal');
    await dialogo.getByRole('button', { name: /^Crear/ }).click();
    await expect(dialogo.getByRole('alert')).toContainText('el slug va en minúsculas');
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('RED-12 actividad de la red por categoría', async ({ page }) => {
    await page.goto('/red');
    await page.getByRole('button', { name: 'Actividad' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Actividad de la red' });
    await expect(dialogo).toBeVisible();
    const filtros = dialogo.getByRole('group', { name: 'Filtrar la actividad' });
    await expect(filtros.getByRole('button', { name: 'Todo', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const eventos = dialogo.getByRole('list', { name: 'Eventos de la red' });
    await expect(eventos.or(dialogo.getByText('Sin actividad registrada todavía.'))).toBeVisible({
      timeout: 20_000,
    });

    await filtros.getByRole('button', { name: 'Red', exact: true }).click();
    await expect(filtros.getByRole('button', { name: 'Red', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(filtros.getByRole('button', { name: 'Todo', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(
      eventos.or(dialogo.getByText('Sin actividad para este filtro.')).first(),
    ).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cerrar' }).last().click();
    await expect(dialogo).toBeHidden();
  });
});
