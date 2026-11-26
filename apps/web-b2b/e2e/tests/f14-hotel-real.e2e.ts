import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, fechaEn, prepararRedParaVender } from '../support/venta';

// F14 con proveedores reales (docs/platform/21 §8.2): búsqueda de hoteles en Medellín con Despegar
// (api-dev) y TBO (test), y revalidación de una tarifa de TBO en el checkout. La red se prepara como
// lo haría el consolidador: carteras con saldo y contacto de soporte (sin eso el checkout no sigue).
test.use({ storageState: storageStateFile('vendedorA') });
test.describe.configure({ mode: 'serial' });

const ENTRADA = fechaEn(50);
const SALIDA = fechaEn(53);
const SOLO_PAQUETE = /sólo se vende en un paquete con aéreo/;

async function buscarHoteles(
  page: Page,
  opts: { moneda: 'COP' | 'USD'; nacionalidad?: string },
): Promise<void> {
  await page.goto('/hoteles');
  const destino = page.getByRole('combobox', { name: 'Destino' });
  await destino.fill('Medellín');
  await page.getByRole('option', { name: /^Medellín, Antioquia, Colombia/ }).click();
  await page.getByRole('button', { name: /^Entrada/ }).click();
  await elegirDias(page, ENTRADA, SALIDA);
  if (opts.nacionalidad) {
    await page
      .getByRole('combobox', { name: /Nacionalidad del pasajero principal/ })
      .selectOption(opts.nacionalidad);
  }
  await page.getByRole('combobox', { name: 'Moneda' }).selectOption({
    label: opts.moneda === 'USD' ? 'USD · dólar estadounidense' : 'COP · peso colombiano',
  });
  await page.getByRole('button', { name: 'Buscar hoteles' }).click();
  await expect(page.getByRole('heading', { name: /hoteles con disponibilidad/ })).toBeVisible({
    timeout: 60_000,
  });
}

/** Aviso de un proveedor que no respondió a tiempo en la búsqueda. */
function avisoDe(page: Page, proveedor: string) {
  return page.getByRole('alert').filter({ hasText: proveedor });
}

test.describe('F14 · hotel real', { tag: ['@real', '@desktop'] }, () => {
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    await prepararRedParaVender();
  });

  test('en COP muestra hoteles de Despegar, que todavía no se reservan desde el panel', async ({
    page,
  }) => {
    await buscarHoteles(page, { moneda: 'COP' });
    await expect(page.getByRole('heading', { name: /precios de venta en COP/ })).toBeVisible();
    await expect(avisoDe(page, 'despegar-hotels')).toHaveCount(0);

    const hotel = page.locator('article').filter({
      has: page.getByRole('button', { name: /^Ver habitaciones de/ }),
    });
    await hotel
      .first()
      .getByRole('button', { name: /^Ver habitaciones de/ })
      .click();
    // D-TBO-08 A: Despegar reserva por su flujo propio y el panel lo dice en vez de ofrecer el botón.
    await expect(
      page.getByText('Esta tarifa todavía no se puede reservar desde el panel.').first(),
    ).toBeVisible();
  });

  test('en USD con nacionalidad, TBO cotiza y su tarifa se revalida en el checkout', async ({
    page,
  }) => {
    // TBO test a veces pasa de los 8 s del fan-out: se reintenta como lo haría el vendedor.
    for (let intento = 1; intento <= 4; intento++) {
      await buscarHoteles(page, { moneda: 'USD', nacionalidad: 'CO' });
      if ((await avisoDe(page, 'tbo-hotels').count()) === 0) break;
      test.info().annotations.push({
        type: 'proveedor lento',
        description: `TBO no respondió a tiempo en el intento ${intento}`,
      });
      expect(intento, 'TBO no respondió en 4 búsquedas seguidas').toBeLessThan(4);
    }

    const reservar = page.getByRole('button', { name: /^Reservar :/ });
    const hoteles = page.locator('article');
    for (let i = 0; i < (await hoteles.count()) && (await reservar.count()) === 0; i++) {
      const ver = hoteles.nth(i).getByRole('button', { name: /^Ver habitaciones de/ });
      if (await ver.count()) await ver.click();
    }
    await expect(reservar.first(), 'ninguna tarifa de TBO se puede reservar').toBeVisible();
    await reservar.first().click();

    await expect(page).toHaveURL(/\/hoteles\/checkout\?tarifa=/);
    await expect(
      page.getByRole('status').filter({ hasText: /^Tarifa revalidada\. Total/ }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Falta el contacto de soporte de tu agencia.')).toHaveCount(0);

    const continuar = page.getByRole('button', { name: 'Continuar con los huéspedes' });
    if (await page.getByText(SOLO_PAQUETE).count()) {
      // TBO-PRUEBA-01: la cuenta de test de TBO sólo trae tarifas «sold only with an airline ticket
      // as part of a package» en Colombia. El panel debe bloquearlas, no dejarlas reservar.
      test.info().annotations.push({
        type: 'proveedor',
        description: 'TBO-PRUEBA-01: la tarifa de TBO test es sólo para paquete con aéreo',
      });
      await expect(continuar).toBeDisabled();
      return;
    }
    await expect(continuar).toBeEnabled();
  });

  test('TBO-PRUEBA-01: reservar y cancelar un hotel de TBO suelto', async () => {
    test.fixme(
      true,
      'La cuenta de test de TBO sólo devuelve tarifas de paquete con aéreo en CO (docs/tbo/10). ' +
        'Cuando TBO habilite tarifas sueltas, completar: huéspedes → reservar → cancelar.',
    );
  });
});
