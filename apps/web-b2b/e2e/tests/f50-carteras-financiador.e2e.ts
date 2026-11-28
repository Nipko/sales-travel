import { expect, test, type Page } from '@playwright/test';
import { loginAs, storageStateFile } from '../support/auth';

/**
 * Tanda 25 en el navegador (docs/qa/01 §5 CAR). admin-a financia a e2e-subagencia: desde Mi Red →
 * «Carteras de Subagencia E2E» opera sus carteras. sub-admin (admin de la sub-agencia) informa depósitos.
 *
 * - CAR-01 (mitad E): habilitar una moneda valida el motivo y el cupo inicial.
 * - CAR-02 (mitad E): el depósito valida separadores de miles, signo, cero y decimales; pide confirmar.
 * - CAR-04: cupo (igual al actual → error; nuevo con confirmación), suspender y reactivar.
 * - CAR-06: informar un depósito valida referencia y fecha futura; queda «Pendiente».
 * - CAR-07: el financiador aprueba uno (con comentario) y rechaza otro (motivo 3–500); la agencia ve el
 *   resultado y el motivo.
 *
 * Cada corrida habilita una moneda nueva en la sub-agencia (la primera que le quede libre).
 */

const corrida = Date.now().toString(36).toUpperCase();
const REF_OK = `QA25-OK-${corrida}`;
const REF_NO = `QA25-NO-${corrida}`;
let moneda = '';

test.describe.configure({ mode: 'serial' });

async function panelDeLaSub(page: Page): Promise<void> {
  await page.goto('/red');
  await page.getByRole('link', { name: 'Carteras de Subagencia E2E' }).click();
  await expect(page.getByRole('heading', { name: 'Subagencia E2E', level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

const dialogo = (page: Page) => page.getByRole('dialog');
const errorDe = (page: Page, texto: string | RegExp) =>
  dialogo(page).getByRole('alert').filter({ hasText: texto });

test.describe('financiador', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('adminA') });
  test.setTimeout(120_000);

  test('CAR-01 / CAR-02 / CAR-04 habilitar, depositar, cupo, suspender y reactivar', async ({
    page,
  }) => {
    await panelDeLaSub(page);

    await page.getByRole('button', { name: 'Habilitar moneda' }).click();
    await expect(dialogo(page)).toHaveAccessibleName('Habilitar una moneda');
    const select = dialogo(page).getByLabel('Moneda');
    const libres = await select
      .locator('option:not([disabled])')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(libres.length, 'le queda alguna moneda por habilitar').toBeGreaterThan(0);
    moneda = libres.includes('USD') ? 'USD' : libres[0]!;
    await select.selectOption(moneda);

    await dialogo(page).getByLabel(`Cupo inicial (${moneda})`).fill('1.500.000');
    await dialogo(page).getByLabel('Motivo').fill('ab');
    await dialogo(page)
      .getByRole('button', { name: `Habilitar ${moneda}` })
      .click();
    await expect(errorDe(page, 'sin separadores de miles')).toBeVisible();
    await expect(errorDe(page, 'Escribe el motivo (al menos 3 caracteres)')).toBeVisible();

    await dialogo(page).getByLabel(`Cupo inicial (${moneda})`).fill('0');
    await dialogo(page).getByLabel('Motivo').fill('QA25 habilitar');
    await dialogo(page)
      .getByRole('button', { name: `Habilitar ${moneda}` })
      .click();
    await expect(page.getByText(`Subagencia E2E ya tiene cartera en ${moneda}.`)).toBeVisible();

    // CAR-02
    await page.getByRole('button', { name: `Depósito en ${moneda}` }).click();
    const monto = dialogo(page).getByLabel(`Monto (${moneda})`);
    const motivo = dialogo(page).getByLabel('Motivo');
    const revisar = dialogo(page).getByRole('button', { name: 'Revisar' });
    for (const [valor, mensaje] of [
      ['1.500.000', 'Escribe sólo números, sin separadores de miles'],
      ['-50', 'Escribe el monto sin signo.'],
      ['0', 'El monto tiene que ser mayor que cero.'],
      ['10,555', 'Usa la coma sólo para los centavos (hasta 2 decimales)'],
      ['', 'Indica el monto.'],
    ] as const) {
      await monto.fill(valor);
      await motivo.fill('QA25 depósito');
      await revisar.click();
      await expect(errorDe(page, mensaje), `monto «${valor}»`).toBeVisible();
    }
    await monto.fill('1500,50');
    await revisar.click();
    await expect(dialogo(page)).toHaveAccessibleName('Confirma el depósito');
    await dialogo(page)
      .getByRole('button', { name: /^Acreditar / })
      .click();
    await expect(
      page.getByText(`Depósito acreditado en la cartera ${moneda} de Subagencia E2E.`),
    ).toBeVisible();

    // CAR-04 cupo
    await page.getByRole('button', { name: `Cupo en ${moneda}` }).click();
    await dialogo(page).getByLabel(`Nuevo cupo (${moneda})`).fill('0');
    await dialogo(page).getByLabel('Motivo').fill('QA25 cupo');
    await dialogo(page).getByRole('button', { name: 'Revisar' }).click();
    await expect(errorDe(page, 'Es el cupo que ya tiene: escribe el nuevo.')).toBeVisible();
    await dialogo(page).getByLabel(`Nuevo cupo (${moneda})`).fill('2000');
    await dialogo(page).getByRole('button', { name: 'Revisar' }).click();
    await expect(dialogo(page)).toHaveAccessibleName('Confirma el cupo');
    await dialogo(page).getByRole('button', { name: 'Fijar cupo' }).click();
    await expect(
      page.getByText(`Cupo en ${moneda} actualizado para Subagencia E2E.`),
    ).toBeVisible();

    // CAR-04 suspender y reactivar
    await page.getByRole('button', { name: `Suspender en ${moneda}` }).click();
    await expect(dialogo(page)).toHaveAccessibleName(`Suspender la cartera ${moneda}`);
    await dialogo(page).getByLabel('Motivo').fill('QA25 suspender');
    await dialogo(page).getByRole('button', { name: 'Suspender cartera' }).click();
    await expect(
      page.getByText(`La cartera ${moneda} de Subagencia E2E quedó suspendida.`),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `Reactivar en ${moneda}` })).toBeVisible();

    await page.getByRole('button', { name: `Reactivar en ${moneda}` }).click();
    await dialogo(page).getByLabel('Motivo').fill('QA25 reactivar');
    await dialogo(page).getByRole('button', { name: 'Reactivar cartera' }).click();
    await expect(
      page.getByText(`La cartera ${moneda} de Subagencia E2E quedó activa.`),
    ).toBeVisible();
  });
});

test.describe('agencia que informa y financiador que resuelve', { tag: '@auth' }, () => {
  test.setTimeout(180_000);

  test('CAR-06 / CAR-07 informar, aprobar y rechazar', async ({ browser }) => {
    test.skip(!moneda, 'necesita la cartera que habilita el caso anterior');
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const sub = await ctx.newPage();
    await loginAs(sub, 'subAdmin');
    await sub.goto('/carteras');

    const informar = async (ref: string) => {
      await sub.getByRole('button', { name: 'Informar depósito' }).first().click();
      await expect(dialogo(sub)).toHaveAccessibleName('Informar un depósito');
      const cartera = dialogo(sub).getByLabel('Cartera');
      if (await cartera.count()) await cartera.selectOption(moneda);
      await dialogo(sub)
        .getByLabel(new RegExp(`^Monto depositado \\(${moneda}\\)`))
        .fill('250');
      await dialogo(sub).getByLabel('Referencia').fill(ref);
      await dialogo(sub).getByRole('button', { name: 'Informar depósito' }).click();
      await expect(sub.getByText('Depósito informado.', { exact: true })).toBeVisible();
    };

    await sub.getByRole('button', { name: 'Informar depósito' }).first().click();
    const cartera = dialogo(sub).getByLabel('Cartera');
    if (await cartera.count()) await cartera.selectOption(moneda);
    await dialogo(sub)
      .getByLabel(new RegExp(`^Monto depositado \\(${moneda}\\)`))
      .fill('250');
    const manana = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await dialogo(sub).getByLabel('Fecha del depósito').fill(manana);
    await dialogo(sub).getByRole('button', { name: 'Informar depósito' }).click();
    await expect(
      errorDe(sub, 'Indica la referencia del depósito (el número de la transferencia).'),
    ).toBeVisible();
    await expect(errorDe(sub, 'La fecha del depósito no puede ser futura.')).toBeVisible();
    await dialogo(sub).getByRole('button', { name: 'Cancelar' }).click();

    await informar(REF_OK);
    await informar(REF_NO);
    await expect(sub.getByText(REF_OK).first()).toBeVisible();

    const fin = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: storageStateFile('adminA'),
    });
    const page = await fin.newPage();
    await panelDeLaSub(page);
    await expect(page.getByText(/depósitos? informados? esperan? revisión/)).toBeVisible();

    await page
      .getByRole('button', { name: `Aprobar el depósito con referencia ${REF_OK}` })
      .click();
    await expect(dialogo(page)).toHaveAccessibleName('Aprobar el depósito informado');
    await dialogo(page).getByLabel('Comentario (opcional)').fill('Llegó a la cuenta');
    await dialogo(page)
      .getByRole('button', { name: /^Aprobar y acreditar / })
      .click();
    await expect(
      page.getByText(`Depósito aprobado y acreditado en la cartera ${moneda} de Subagencia E2E.`),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Aprobar el depósito con referencia ${REF_OK}` }),
    ).toHaveCount(0);

    await page
      .getByRole('button', { name: `Rechazar el depósito con referencia ${REF_NO}` })
      .click();
    await dialogo(page).getByLabel('Motivo del rechazo').fill('no');
    await dialogo(page).getByRole('button', { name: 'Rechazar depósito' }).click();
    await expect(errorDe(page, 'Escribe el motivo (al menos 3 caracteres)')).toBeVisible();
    await dialogo(page).getByLabel('Motivo del rechazo').fill('No llegó: revisa la referencia');
    await dialogo(page).getByRole('button', { name: 'Rechazar depósito' }).click();
    await expect(page.getByText('Depósito rechazado: Subagencia E2E ve el motivo.')).toBeVisible();

    await sub.reload();
    await sub.getByRole('tab', { name: /^Depósitos informados/ }).click();
    const item = (ref: string) => sub.locator('li').filter({ hasText: ref });
    await expect(item(REF_OK)).toContainText('Aprobado');
    await expect(item(REF_OK)).toContainText('Comentario: Llegó a la cuenta');
    await expect(item(REF_NO)).toContainText('Rechazado');
    await expect(item(REF_NO)).toContainText('Motivo del rechazo: No llegó: revisa la referencia');
  });
});
