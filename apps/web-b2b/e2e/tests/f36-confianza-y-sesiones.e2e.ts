import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, passMfaChallenge, submitCredentials } from '../support/auth';
import { USERS } from '../support/users';

/**
 * Equipos de confianza y sesiones abiertas (docs/qa/01 §5 ACC y CTA), con `confianza@e2e.test`, un
 * admin de la agencia B que sólo usa este archivo (llega sin MFA y sin sesiones en cada corrida).
 *
 * - ACC-10: «Recordar este equipo» viene marcado; el siguiente ingreso desde ese navegador no pide
 *   el código.
 * - CTA-10 / ACC-11: quitar el equipo desde Seguridad; el siguiente ingreso vuelve a pedirlo.
 * - CTA-09: una sesión por persona: la del otro navegador cae al ingresar acá; «Esta sesión» no
 *   tiene «Cerrar»; «Cerrar sesión en todos los dispositivos» lleva al login.
 */
test.describe.configure({ mode: 'serial' });

const INICIO = (p: Page) => p.getByRole('link', { name: 'Inicio', exact: true });
const DESAFIO = (p: Page) => p.getByRole('textbox', { name: 'Dígito 1 de 6' });

/** Sale sin olvidar el equipo: borra sólo la cookie de la sesión, como al vencer. */
async function soltarSesion(ctx: BrowserContext): Promise<void> {
  await ctx.clearCookies({ name: 'st_session' });
}

test.describe('equipos de confianza y sesiones', { tag: '@desktop' }, () => {
  let principal: BrowserContext;
  let otro: BrowserContext;
  let pagina: Page;
  let segunda: Page;

  test.beforeAll(async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL;
    principal = await browser.newContext({ baseURL });
    otro = await browser.newContext({ baseURL });
    pagina = await principal.newPage();
    segunda = await otro.newPage();
    // Primer ingreso: activa el 2FA (su rol lo exige).
    await loginAs(pagina, 'confianza');
    await expect(INICIO(pagina)).toBeVisible();
  });

  test.afterAll(async () => {
    await principal?.close();
    await otro?.close();
  });

  test('ACC-10 «Recordar este equipo» viene marcado y el siguiente ingreso no pide el código', async () => {
    await submitCredentials(segunda, USERS.confianza.email);
    await expect(DESAFIO(segunda)).toBeVisible();
    await expect(segunda.getByRole('checkbox', { name: /Recordar este equipo/ })).toBeChecked();
    await passMfaChallenge(segunda, 'confianza');
    await expect(INICIO(segunda)).toBeVisible();

    await soltarSesion(otro);
    await submitCredentials(segunda, USERS.confianza.email);
    await expect(INICIO(segunda), 'equipo de confianza: entra sin código').toBeVisible();
    await expect(DESAFIO(segunda)).toHaveCount(0);
  });

  test('CTA-10 / ACC-11 quitar el equipo de confianza: el siguiente ingreso pide el código', async () => {
    // Sigue adentro desde ACC-10, en el equipo de confianza.
    await segunda.goto('/configuracion/seguridad');
    const quitar = segunda.getByRole('button', { name: 'Quitar este equipo' });
    await expect(quitar).toBeVisible();
    await quitar.click();
    await segunda.getByRole('dialog').getByRole('button', { name: 'Quitar' }).click();
    await expect(quitar).toHaveCount(0);

    await soltarSesion(otro);
    await submitCredentials(segunda, USERS.confianza.email);
    await expect(DESAFIO(segunda), 'sin equipo de confianza: pide el código').toBeVisible();
    await passMfaChallenge(segunda, 'confianza');
    await expect(INICIO(segunda)).toBeVisible();
  });

  test('CTA-09 sesiones: una por persona; «Esta sesión» no se cierra; «Cerrar en todos» lleva al login', async () => {
    // Una sola sesión por persona (seat.service: ingresar en otro equipo cierra la anterior), así
    // que «Cerrar» en otra sesión no se puede dar desde el panel (QA-M-10).
    await loginAs(pagina, 'confianza');
    await segunda.goto('/');
    await expect(segunda).toHaveURL(/\/login/);
    await expect(segunda.getByText('Tu sesión se abrió en otro dispositivo.')).toBeVisible();

    await pagina.goto('/configuracion/seguridad');
    const actual = pagina.locator('li', { hasText: 'Esta sesión' });
    await expect(actual).toHaveCount(1);
    await expect(pagina.getByRole('button', { name: /Cerrar la sesión de/ })).toHaveCount(0);

    await pagina.getByRole('button', { name: 'Cerrar sesión en todos los dispositivos' }).click();
    await pagina.getByRole('dialog').getByRole('button', { name: 'Cerrar todas' }).click();
    await expect(pagina).toHaveURL(/\/login/);
    await pagina.goto('/');
    await expect(pagina).toHaveURL(/\/login/);
  });
});
