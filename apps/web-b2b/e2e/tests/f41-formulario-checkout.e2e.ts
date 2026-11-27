import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, elegirLugar, fechaEn } from '../support/venta';

/**
 * Formularios de la venta (docs/qa/01 §5 VUE y CHK) en el navegador, contra el proveedor de vuelos
 * FALSO del stack E2E (INF-4). En la Mac con sandboxes (`E2E_REAL=1`) se salta.
 *
 * - VUE-05: pasajeros: total ≤ 9 (el «+» se apaga y lo dice), infantes ≤ adultos (bajar adultos baja
 *   infantes), una edad por niño.
 * - CHK-08: «Faltan N datos para reservar» e «Ir al primero»; la fecha de nacimiento (año < 1900,
 *   fecha que no existe, futura); pasaporte sin vencimiento.
 * - CHK-10: dos pasajeros con el mismo documento no se reservan.
 * - CHK-12: facturación: email inválido y teléfono corto se reclaman en el resumen.
 */
test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('vendedorA') });

const SALIDA = fechaEn(46);

const pax = (page: Page) => page.getByRole('dialog', { name: 'Pasajeros del viaje' });

async function abrirPasajeros(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Pasajeros/ }).click();
  await expect(pax(page)).toBeVisible();
}

async function buscarYElegir(page: Page, adultos = 1): Promise<void> {
  await page.goto('/cotizaciones');
  await page.getByText('Solo ida', { exact: true }).click();
  await elegirLugar(page, 'Origen', 'BOG', /^Bogot[aá] \(BOG\)/);
  await elegirLugar(page, 'Destino', 'MDE', /\(MDE\)/);
  await page.getByRole('button', { name: /^Ida / }).click();
  await elegirDias(page, SALIDA);
  if (adultos > 1) {
    await abrirPasajeros(page);
    for (let i = 1; i < adultos; i++) {
      await pax(page).getByRole('button', { name: 'Agregar un adulto' }).click();
    }
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByText(/\d+ vuelos? encontrados?/)).toBeVisible({ timeout: 60_000 });
  const vuelo = page
    .locator('article')
    .filter({ hasText: /Directo/i })
    .first();
  await vuelo.getByRole('button').first().click();
  await vuelo.getByRole('button', { name: 'Elegir' }).first().click();
  await expect(page.getByRole('heading', { name: 'Reservar vuelo' })).toBeVisible({
    timeout: 30_000,
  });
}

const resumen = (page: Page) => page.getByRole('complementary', { name: 'Resumen del precio' });
const reservar = (page: Page) => resumen(page).getByRole('button', { name: 'Reservar' }).click();

test.describe('formularios de la venta', { tag: '@desktop' }, () => {
  test.setTimeout(180_000);

  test('VUE-05 pasajeros: tope de 9, infantes ≤ adultos y edad por niño', async ({ page }) => {
    await page.goto('/cotizaciones');
    await abrirPasajeros(page);
    const dialogo = pax(page);
    const mas = (quien: string) =>
      dialogo.getByRole('button', { name: `Agregar un ${quien}`, exact: true });
    const menos = (quien: string) =>
      dialogo.getByRole('button', { name: `Quitar un ${quien}`, exact: true });

    // Dos adultos y dos infantes: no puede haber más infantes que adultos.
    await mas('adulto').click();
    await mas('infante').click();
    await mas('infante').click();
    await expect(mas('infante')).toHaveAttribute('aria-disabled', 'true');
    await menos('adulto').click();
    // Quedan 1 adulto y 1 infante: el pie dice el total.
    await expect(dialogo.getByText('2 pasajeros', { exact: true })).toBeVisible();

    // Un niño pide su edad.
    await mas('niño').click();
    await expect(dialogo.getByLabel('Edad del niño')).toHaveAttribute('aria-invalid', 'true');
    await dialogo.getByLabel('Edad del niño').selectOption('7');
    await expect(dialogo.getByLabel('Edad del niño')).not.toHaveAttribute('aria-invalid', 'true');

    // Hasta 9 en total: 1 adulto + 1 niño + 1 infante + 6 adultos más.
    for (let i = 0; i < 6; i++) await mas('adulto').click();
    await expect(mas('adulto')).toHaveAttribute('aria-disabled', 'true');
    await expect(mas('niño')).toHaveAttribute('aria-disabled', 'true');
    await expect(dialogo.getByText(/Máximo 9 pasajeros por reserva/)).toBeVisible();
  });

  test('CHK-08 / CHK-12 lo que falta se dice, «Ir al primero» lleva ahí, y la fecha se valida', async ({
    page,
  }) => {
    await buscarYElegir(page);
    await expect(resumen(page).getByText('Precio confirmado')).toBeVisible({ timeout: 30_000 });
    await reservar(page);
    await expect(page.getByText(/Faltan \d+ datos? para reservar/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Ir al primero' }).first().click();
    await expect(page.getByRole('textbox', { name: 'Nombre(s) *' })).toBeFocused();

    const nacimiento = page.getByRole('textbox', { name: 'Fecha de nacimiento' });
    for (const [valor, mensaje] of [
      ['15/05/1890', 'Revisa el año.'],
      ['31/02/1990', 'Esa fecha no existe.'],
      ['15/05/2090', 'La fecha de nacimiento no puede ser futura.'],
    ] as const) {
      await nacimiento.fill(valor);
      await nacimiento.blur();
      await expect(page.getByText(mensaje).first(), valor).toBeVisible();
    }
    await nacimiento.fill('15/05/1990');

    await page.getByRole('textbox', { name: 'Nombre(s) *' }).fill('PRUEBA');
    await page.getByRole('textbox', { name: 'Apellido(s) *' }).fill('FORMULARIO');
    await page.getByRole('textbox', { name: 'Número de documento *' }).fill('1020304050');

    // CHK-12: email y teléfono de facturación.
    await page.getByRole('textbox', { name: 'Email *' }).fill('no-es-un-correo');
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('123');
    await reservar(page);
    await expect(
      page.getByText(/Facturación: completa email válido, teléfono\./).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/cotizaciones\//);
  });

  test('CHK-10 dos pasajeros con el mismo documento no se reservan', async ({ page }) => {
    await buscarYElegir(page, 2);
    const nombres = page.getByRole('textbox', { name: 'Nombre(s) *' });
    const apellidos = page.getByRole('textbox', { name: 'Apellido(s) *' });
    const nacimientos = page.getByRole('textbox', { name: 'Fecha de nacimiento' });
    const documentos = page.getByRole('textbox', { name: 'Número de documento *' });
    await expect(nombres).toHaveCount(2);
    for (const [i, nombre] of [
      [0, 'ANA'],
      [1, 'LUISA'],
    ] as const) {
      await nombres.nth(i).fill(nombre);
      await apellidos.nth(i).fill('DUPLICADA');
      await nacimientos.nth(i).fill(i === 0 ? '15/05/1990' : '20/06/1992');
      await documentos.nth(i).fill('1020304050');
    }
    await page.getByRole('textbox', { name: 'Email *' }).fill('pasajero-falso@e2e.test');
    await page.getByRole('textbox', { name: 'Teléfono *' }).fill('3001234567');
    await reservar(page);
    await expect(page.getByText(/tiene el mismo número de documento que/).first()).toBeVisible();
    await expect(page).toHaveURL(/\/cotizaciones\//);
  });
});
