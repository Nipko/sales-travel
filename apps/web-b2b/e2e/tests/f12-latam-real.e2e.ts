import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, elegirLugar, fechaEn, prepararAgenciaBrasil } from '../support/venta';

// F10 · F12 con LATAM NDC (sandbox): el vendedor de la agencia B, que vende en BRL, busca
// GRU → GIG, reserva sin cobro (BNPL), revisa el pago y cancela. La moneda: el sandbox de LATAM cotiza
// en BRL; con una agencia en COP sus tarifas se descartan (puerta de moneda del buscador), así que
// la prueba usa una agencia en Brasil en vez de convertir.
test.use({ storageState: storageStateFile('vendedorB') });
test.describe.configure({ mode: 'serial' });

const SALIDA = fechaEn(50);

let reservaUrl: string | undefined;
let cancelada = false;

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

test.describe('F12 · LATAM real', { tag: ['@real', '@desktop'] }, () => {
  test.setTimeout(180_000);

  test.beforeAll(async () => {
    await prepararAgenciaBrasil();
  });

  test.afterAll(async ({ browser }) => {
    if (!reservaUrl || cancelada) return;
    const ctx = await browser.newContext({ storageState: storageStateFile('vendedorB') });
    await cancelarReserva(await ctx.newPage(), reservaUrl).finally(() => ctx.close());
  });

  test('busca GRU → GIG y LATAM cotiza en BRL, marcado como de prueba', async ({ page }) => {
    await page.goto('/cotizaciones');
    await page.getByText('Solo ida', { exact: true }).click();
    await elegirLugar(page, 'Origen', 'GRU', /\(GRU\)/);
    await elegirLugar(page, 'Destino', 'GIG', /\(GIG\)/);
    await page.getByRole('button', { name: /^Ida / }).click();
    await elegirDias(page, SALIDA);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page.getByText(/\d+ vuelos encontrados/)).toBeVisible({ timeout: 60_000 });

    const vuelo = page.locator('article').first();
    await expect(vuelo).toContainText('LATAM Airlines');
    await expect(vuelo).toContainText('Tarifa del entorno de pruebas del proveedor');
    await expect(page.getByText(/devolvió tarifas en .* y esta agencia vende en/)).toHaveCount(0);

    await vuelo.getByRole('button').first().click();
    await vuelo.getByRole('button', { name: 'Elegir' }).first().click();
    await expect(page).toHaveURL(/\/cotizaciones\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await page.getByRole('textbox', { name: 'Nombre(s) *' }).fill('PRUEBA');
    await page.getByRole('textbox', { name: 'Apellido(s) *' }).fill('LATAMREAL');
    await page.getByRole('textbox', { name: 'Fecha de nacimiento' }).fill('15/05/1990');
    await page.getByRole('textbox', { name: 'Número de documento *' }).fill('1020304050');
    await page.getByRole('textbox', { name: 'Email *' }).fill('pasajero-latam@e2e.test');
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('11987654321');
    const resumen = page.getByRole('complementary', { name: 'Resumen del precio' });
    await expect(resumen).toContainText('BRL');
    await expect(page.getByRole('region', { name: 'Pago y emisión' })).toContainText(
      'Reserva sin cobro',
    );
    await resumen.getByRole('button', { name: 'Reservar' }).click();

    await expect(page).toHaveURL(/\/reservas\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    reservaUrl = page.url();
    await expect(estado(page, 'Pendiente de pago')).toBeVisible();
    await expect(
      page.getByText('Reserva hecha en el entorno de pruebas del proveedor'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Copiar localizador/ })).toBeVisible();
  });

  test('el pago muestra el total en BRL y no se confirma sin datos', async ({ page }) => {
    test.skip(!reservaUrl, 'No hubo reserva');
    await page.goto(reservaUrl!);
    await page.getByRole('button', { name: 'Pagar' }).click();
    const pago = page.getByRole('dialog', { name: /^Pagar reserva/ });
    await expect(pago).toContainText('BRL');
    await expect(pago.getByRole('button', { name: 'Confirmar pago' })).toBeDisabled();
    await pago.getByRole('button', { name: 'Cancelar' }).click();
    await expect(pago).toBeHidden();
  });

  test('LATAM-PRUEBA-01: pagar y emitir con la tarjeta de prueba del sandbox', async () => {
    test.fixme(
      true,
      'Falta la tarjeta de prueba publicada por LATAM para su sandbox, y la forma de pago con ' +
        'tarjeta manda número y CVV por el servidor (fuera de PCI SAQ-A): decisión del founder.',
    );
  });

  test('cancela la reserva sin pago (BNPL) y queda en el historial', async ({ page }) => {
    test.skip(!reservaUrl, 'No hubo reserva que cancelar');
    await cancelarReserva(page, reservaUrl!);
    await expect(page.getByRole('region', { name: 'Historial de operaciones' })).toContainText(
      'Cancelación',
    );
  });
});
