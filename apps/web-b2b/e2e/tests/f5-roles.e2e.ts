import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

// F5 · Roles y permisos en la navegación (docs/platform/21 §8.2). La guarda que manda es la del api;
// esto comprueba que el panel no muestra ni deja entrar a lo que el rol no tiene.

const PLATFORM_ROUTES = [
  '/admin/plataforma/estado',
  '/admin/plataforma/proveedores',
  '/admin/tenants',
];

test.describe('F5 · vendedor', () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('entra sin que se le exija MFA y ve las operaciones de venta', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }),
    ).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  });

  for (const route of PLATFORM_ROUTES) {
    test(`no entra a ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page).not.toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
    });
  }

  test(
    'su menú no ofrece la plataforma ni la administración',
    { tag: '@desktop' },
    async ({ page }) => {
      await page.goto('/');
      const nav = page.locator('aside').first();
      await expect(nav.getByRole('link', { name: 'Vuelos', exact: true })).toBeVisible();
      for (const name of ['Estado', 'Salud', 'Agencias', 'Activación', 'Usuarios']) {
        await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
      }
    },
  );
});

test.describe('F5 · admin de agencia', () => {
  test.use({ storageState: storageStateFile('adminA') });

  test('administra su equipo pero no la plataforma', async ({ page }) => {
    await page.goto('/admin/usuarios');
    await expect(page).toHaveURL(/\/admin\/usuarios/);
    await expect(page.getByText('Vendedor Agencia A').first()).toBeVisible();
    // Gente de otra agencia (agencia B, fuera de su subárbol) no aparece.
    await expect(page.getByText('Vendedor Agencia B')).toHaveCount(0);

    await page.goto('/admin/plataforma/estado');
    await expect(page).not.toHaveURL(/\/admin\/plataforma/);
  });
});

test.describe('F5 · superadmin', () => {
  test.use({ storageState: storageStateFile('superadmin') });

  test('ve la consola de la plataforma', async ({ page }) => {
    await page.goto('/admin/plataforma/estado');
    await expect(page.getByRole('heading', { name: 'Estado', exact: true })).toBeVisible();
  });
});
