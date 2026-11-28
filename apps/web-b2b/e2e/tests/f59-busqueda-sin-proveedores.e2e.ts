import { expect, test } from '@playwright/test';
import { como, nodo } from '../api/support/cliente';
import { submitCredentials } from '../support/auth';
import { USERS } from '../support/users';
import { elegirDias, elegirLugar, fechaEn } from '../support/venta';

/**
 * Tanda 34 en el navegador (docs/qa/01 §5 BYO): BYO-11. Con el falso apagado para la agencia (agencia B) y
 * LATAM y Sabre sin credenciales, la búsqueda no trae vuelos y dice qué proveedores no se consultaron y
 * por qué, en vez de un «Ningún vuelo disponible» a secas.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');

test.describe('BYO-11 por qué no hay vuelos', { tag: '@auth' }, () => {
  test.setTimeout(120_000);

  test('el vacío explica los proveedores que no se consultaron', async ({ browser }) => {
    const sa = await como('superadmin');
    const agencia = await nodo('e2e-agencia-b');
    const off = await sa.put(`/admin/providers/fake-flights/tenants/${agencia}`, {
      enabled: false,
      reason: 'QA34 sin proveedor',
    });
    expect(off.status, off.text).toBeLessThan(300);
    try {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await submitCredentials(page, USERS.doble.email);
      await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      await page.goto('/cotizaciones');
      await page.getByText('Solo ida', { exact: true }).click();
      await elegirLugar(page, 'Origen', 'BOG', /^Bogot[aá] \(BOG\)/);
      await elegirLugar(page, 'Destino', 'MDE', /\(MDE\)/);
      await page.getByRole('button', { name: /^Ida / }).click();
      await elegirDias(page, fechaEn(80));
      await expect(async () => {
        await page.getByRole('button', { name: 'Buscar', exact: true }).click();
        await expect(page.getByText(/^Ningún vuelo disponible para /)).toBeVisible({
          timeout: 15_000,
        });
      }).toPass({ timeout: 45_000 });
      const nota = page.getByRole('status').filter({ hasText: 'no se consultaron' });
      await expect(nota).toContainText('3 proveedores no se consultaron:');
      await expect(nota).toContainText(
        'fake-flights · Deshabilitado por la plataforma para esta agencia.',
      );
      await expect(nota).toContainText(
        'latam-ndc · Esta agencia no tiene credenciales propias ni heredadas',
      );
    } finally {
      await sa.delete(`/admin/providers/fake-flights/tenants/${agencia}`);
    }
  });
});
