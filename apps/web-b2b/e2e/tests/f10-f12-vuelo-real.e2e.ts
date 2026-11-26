import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, elegirLugar, fechaEn } from '../support/venta';

// F10 · F12 · F27 con proveedores reales (docs/platform/21 §8.2): el vendedor de la agencia A busca
// BOG → MDE, elige una tarifa, carga un pasajero y reserva en Sabre CERT; la prueba cronometra la
// venta y cancela el PNR al final para no dejar reservas vivas en el sandbox.
test.use({ storageState: storageStateFile('vendedorA') });
test.describe.configure({ mode: 'serial' });

const SALIDA = fechaEn(50);
/** Principio 1 de CLAUDE.md: tiempo a venta < 2 minutos. */
const PRESUPUESTO_VENTA_MS = 120_000;

let reservaUrl: string | undefined;
let cancelada = false;

/** La etiqueta de estado de la reserva («Confirmada», «Cancelada»), no los avisos que la acompañan. */
function estado(page: Page, texto: string) {
  return page.getByRole('status').filter({ hasText: new RegExp(`^${texto}$`) });
}

async function cancelarReserva(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (await estado(page, 'Cancelada').count()) {
    cancelada = true;
    return;
  }
  await page.getByRole('button', { name: 'Más acciones' }).click();
  await page.getByRole('menuitem', { name: 'Cancelar reserva' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sí, cancelar reserva' }).click();
  await expect(estado(page, 'Cancelada')).toBeVisible({ timeout: 60_000 });
  cancelada = true;
}

async function buscarSoloIda(page: Page): Promise<void> {
  await page.goto('/cotizaciones');
  await page.getByText('Solo ida', { exact: true }).click();
  await elegirLugar(page, 'Origen', 'BOG', /^Bogot[aá] \(BOG\)/);
  await elegirLugar(page, 'Destino', 'MDE', /\(MDE\)/);
  await page.getByRole('button', { name: /^Ida / }).click();
  await elegirDias(page, SALIDA);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByText(/\d+ vuelos encontrados/)).toBeVisible({ timeout: 60_000 });
}

test.describe('F10 · F12 · vuelo real', { tag: ['@real', '@desktop'] }, () => {
  test.setTimeout(180_000);

  // Si algo falla después de reservar, el modo serial salta la cancelación: el PNR no queda vivo.
  test.afterAll(async ({ browser }) => {
    if (!reservaUrl || cancelada) return;
    const ctx = await browser.newContext({ storageState: storageStateFile('vendedorA') });
    await cancelarReserva(await ctx.newPage(), reservaUrl).finally(() => ctx.close());
  });

  test('F10 · la búsqueda BOG → MDE trae tarifas de Sabre CERT marcadas como de prueba', async ({
    page,
  }) => {
    await buscarSoloIda(page);
    const vuelos = page.locator('article');
    expect(await vuelos.count()).toBeGreaterThan(0);
    await expect(vuelos.first()).toContainText('Tarifa del entorno de pruebas del proveedor');
    await expect(vuelos.first()).toContainText(/BOG.*MDE/s);
  });

  test('F12 · F27 · reserva un pasajero en menos de 2 minutos y queda confirmada', async ({
    page,
  }) => {
    const inicio = Date.now();
    await buscarSoloIda(page);

    const vuelo = page.locator('article').first();
    await vuelo.getByRole('button').first().click();
    await vuelo.getByRole('button', { name: 'Elegir' }).first().click();
    await expect(page).toHaveURL(/\/cotizaciones\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Reservar vuelo' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Nombre(s) *' }).fill('PRUEBA');
    await page.getByRole('textbox', { name: 'Apellido(s) *' }).fill('VENTAREAL');
    await page.getByRole('textbox', { name: 'Fecha de nacimiento' }).fill('15/05/1990');
    await page.getByRole('textbox', { name: 'Número de documento *' }).fill('1020304050');
    await page.getByRole('textbox', { name: 'Email *' }).fill('pasajero-f12@e2e.test');
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('3001234567');
    await expect(page.getByRole('region', { name: 'Pago y emisión' })).toContainText(
      'Reserva sin cobro',
    );
    await page
      .getByRole('complementary', { name: 'Resumen del precio' })
      .getByRole('button', { name: 'Reservar' })
      .click();

    await expect(page).toHaveURL(/\/reservas\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    reservaUrl = page.url();
    const ms = Date.now() - inicio;
    test.info().annotations.push({ type: 'tiempo a venta', description: `${ms} ms` });

    await expect(estado(page, 'Confirmada')).toBeVisible();
    await expect(
      page.getByText('Reserva hecha en el entorno de pruebas del proveedor'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Copiar localizador/ })).toBeVisible();
    expect
      .soft(ms, 'F27: de la búsqueda a la reserva confirmada')
      .toBeLessThan(PRESUPUESTO_VENTA_MS);
  });

  test('F12 · cancela el PNR de prueba y queda en el historial', async ({ page }) => {
    test.skip(!reservaUrl, 'No hubo reserva que cancelar');
    await cancelarReserva(page, reservaUrl!);
    await expect(page.getByRole('region', { name: 'Historial de operaciones' })).toContainText(
      'Cancelación',
    );
  });
});
