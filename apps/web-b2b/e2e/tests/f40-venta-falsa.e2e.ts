import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, elegirLugar, fechaEn } from '../support/venta';

/**
 * Ola 4 del plan de QA (docs/qa/01 §5 CHK), en el navegador contra el proveedor de vuelos FALSO del
 * stack E2E (INF-4, apps/api/src/providers-fake). Corre en CI en cada PR, sin sandboxes:
 *
 * - CHK-02 / F27: de la búsqueda a la reserva confirmada, cronometrado (< 2 min).
 * - CHK-04: la tarifa que cambia de precio al revalidar avisa y reserva con «Aceptar y reservar».
 * - CHK-15: los desenlaces de la saga según el apellido del pasajero (perillas del falso):
 *   rechazo cierto (el formulario vuelve), incierto (no vuelve) y parcial (abre la reserva y avisa).
 *
 * En la Mac (`E2E_REAL=1`) no hay proveedor falso: se salta.
 */
test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('vendedorA') });

const SALIDA = fechaEn(45);
const PRESUPUESTO_VENTA_MS = 120_000;

async function buscar(page: Page): Promise<void> {
  await page.goto('/cotizaciones');
  await page.getByText('Solo ida', { exact: true }).click();
  await elegirLugar(page, 'Origen', 'BOG', /^Bogot[aá] \(BOG\)/);
  await elegirLugar(page, 'Destino', 'MDE', /\(MDE\)/);
  await page.getByRole('button', { name: /^Ida / }).click();
  await elegirDias(page, SALIDA);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByText(/\d+ vuelos? encontrados?/)).toBeVisible({ timeout: 60_000 });
}

/** Elige el vuelo directo (precio fijo) o el de una escala (sube 5 % al revalidar). */
async function elegir(page: Page, cual: 'directo' | 'escala'): Promise<void> {
  const vuelo = page
    .locator('article')
    .filter({ hasText: cual === 'directo' ? /Directo/i : /1 escala/i })
    .first();
  await vuelo.getByRole('button').first().click();
  await vuelo.getByRole('button', { name: 'Elegir' }).first().click();
  await expect(page).toHaveURL(/\/cotizaciones\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Reservar vuelo' })).toBeVisible();
}

async function pasajero(page: Page, apellido: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Nombre(s) *' }).fill('PRUEBA');
  await page.getByRole('textbox', { name: 'Apellido(s) *' }).fill(apellido);
  await page.getByRole('textbox', { name: 'Fecha de nacimiento' }).fill('15/05/1990');
  await page.getByRole('textbox', { name: 'Número de documento *' }).fill('1020304050');
  await page.getByRole('textbox', { name: 'Email *' }).fill('pasajero-falso@e2e.test');
  await page.getByRole('textbox', { name: 'Teléfono *' }).fill('3001234567');
}

const resumen = (page: Page) => page.getByRole('complementary', { name: 'Resumen del precio' });

test.describe('venta con el proveedor falso', { tag: '@desktop' }, () => {
  test.setTimeout(180_000);

  test('CHK-02 / F27 reserva confirmada en menos de 2 minutos', async ({ page }) => {
    const inicio = Date.now();
    await buscar(page);
    await elegir(page, 'directo');
    await expect(resumen(page).getByText('Precio confirmado')).toBeVisible({ timeout: 30_000 });
    await pasajero(page, 'CONFIRMADA');
    await resumen(page).getByRole('button', { name: 'Reservar' }).click();
    await expect(page).toHaveURL(/\/reservas\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    const ms = Date.now() - inicio;
    test.info().annotations.push({ type: 'tiempo a venta', description: `${ms} ms` });
    await expect(page.getByRole('status').filter({ hasText: /^Confirmada$/ })).toBeVisible();
    expect(ms, 'F27: de la búsqueda a la reserva confirmada').toBeLessThan(PRESUPUESTO_VENTA_MS);
  });

  test('CHK-04 el precio cambia al revalidar: aviso y «Aceptar y reservar»', async ({ page }) => {
    await buscar(page);
    await elegir(page, 'escala');
    await expect(page.getByText(/El precio cambió a/).first()).toBeVisible({ timeout: 30_000 });
    await pasajero(page, 'CAMBIO');
    await resumen(page).getByRole('button', { name: 'Aceptar y reservar' }).click();
    await expect(page).toHaveURL(/\/reservas\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  });

  for (const [apellido, titulo] of [
    ['RECHAZO', 'No se pudo crear la reserva'],
    ['INCIERTO', 'Creación incierta'],
  ] as const) {
    test(`CHK-15 ${apellido.toLowerCase()}: «${titulo}»`, async ({ page }) => {
      await buscar(page);
      await elegir(page, 'directo');
      await expect(resumen(page).getByText('Precio confirmado')).toBeVisible({ timeout: 30_000 });
      await pasajero(page, apellido);
      await resumen(page).getByRole('button', { name: 'Reservar' }).click();
      await expect(page.getByText(new RegExp(titulo)).first()).toBeVisible({ timeout: 90_000 });
      // Sólo un rechazo cierto deja volver a reservar: un incierto ya puede haber dejado algo.
      await expect(page.getByRole('textbox', { name: 'Apellido(s) *' })).toHaveCount(
        apellido === 'RECHAZO' ? 1 : 0,
      );
    });
  }

  test('CHK-15 parcial: hay reserva, no vuelve el formulario y se puede abrir la reserva', async ({
    page,
  }) => {
    await buscar(page);
    await elegir(page, 'directo');
    await expect(resumen(page).getByText('Precio confirmado')).toBeVisible({ timeout: 30_000 });
    await pasajero(page, 'PARCIAL');
    await resumen(page).getByRole('button', { name: 'Reservar' }).click();
    // Un tramo sin confirmar: la saga la deja para conciliar. Hay algo reservado, así que el
    // formulario no vuelve y el aviso lleva a la reserva (o el panel ya la abrió).
    await expect(
      page
        .getByRole('link', { name: /Ver la reserva/ })
        .or(page.getByText(/Hay servicios sin confirmar/)),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('textbox', { name: 'Apellido(s) *' })).toHaveCount(0);
  });
});
