import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';

// F3 · Alta de nodos y jerarquía (docs/platform/21 §8.2), como superadmin desde «Mi Red».
test.use({ storageState: storageStateFile('superadmin') });
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const AGENCY = `Agencia F3 ${stamp}`;
const SUBAGENCY = `Subagencia F3 ${stamp}`;

async function openRed(page: Page): Promise<void> {
  await page.goto('/red');
  await expect(page.getByRole('heading', { name: 'Mi Red' })).toBeVisible();
  await expect(page.getByText('Planetour E2E').first()).toBeVisible();
}

test.describe('F3 · nodos de la red', { tag: '@desktop' }, () => {
  test('crea una agencia bajo la plataforma', async ({ page }) => {
    await openRed(page);
    await page.getByRole('button', { name: 'Nuevo nodo' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Agencia Sur').fill(AGENCY);
    await expect(dialog.getByRole('radio', { name: /Agencia/ }).first()).toBeChecked();
    await dialog.getByLabel('Puestos simultáneos').fill('3');
    await dialog.getByRole('button', { name: 'Crear agencia' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${AGENCY}`, { exact: true }).first()).toBeVisible();
  });

  test('crea una sub-agencia bajo esa agencia', async ({ page }) => {
    await openRed(page);
    await page.getByRole('button', { name: `Sub-agencia bajo ${AGENCY}` }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Agencia Sur').fill(SUBAGENCY);
    const seats = dialog.getByLabel('Puestos simultáneos');
    if (await seats.count()) await seats.fill('2');
    await dialog.getByRole('button', { name: /^Crear/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/creada bajo/).first()).toContainText(SUBAGENCY);
  });

  test('la jerarquía sólo ofrece los tipos válidos bajo cada nodo', async ({ page }) => {
    await openRed(page);
    // Bajo un consolidador sólo cuelgan agencias (tenant_hierarchy_rule, migración 0050).
    await expect(page.getByRole('button', { name: 'Agencia bajo Consolidador E2E' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Sub-agencia bajo Consolidador E2E/ }),
    ).toHaveCount(0);
  });

  // BUG-E2E-01 (docs/platform/21 §4.1), corregido en la tanda 11 de QA: el error quedaba fuera de
  // la vista del diálogo y el foco seguía en «Crear agencia».
  test('BUG-E2E-01: si falta «Puestos simultáneos», el error se ve y recibe el foco', async ({
    page,
  }) => {
    await openRed(page);
    await page.getByRole('button', { name: 'Nuevo nodo' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Agencia Sur').fill(`Sin puestos ${stamp}`);
    await dialog.getByRole('button', { name: 'Crear agencia' }).click();

    const seats = dialog.getByLabel('Puestos simultáneos');
    await expect(seats).toHaveAttribute('aria-invalid', 'true');
    await expect(seats).toBeFocused({ timeout: 3_000 });
    await expect(seats).toBeInViewport();
  });
});
