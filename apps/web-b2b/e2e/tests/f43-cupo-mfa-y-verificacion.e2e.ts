import { expect, test, type Browser, type Page } from '@playwright/test';
import { enrollMfa, readMfa, submitCredentials, typeSixDigits, writeMfa } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { freshTotp } from '../support/totp';
import { E2E_PASSWORD, USERS, type UserKey } from '../support/users';

/**
 * Cuenta y acceso en el navegador (docs/qa/01 §5 ACC y CTA):
 *
 * - ACC-16: con el único puesto de e2e-agencia-cupo ocupado, un vendedor ve «No hay puestos libres»,
 *   «Volver a intentar» y ninguna sesión ajena.
 * - ACC-17: el admin del nodo ve quién ocupa el puesto, lo desconecta y entra; quien quedó afuera ve
 *   `motivo=liberada` al volver.
 * - ACC-26: el banner de correo sin verificar reenvía el correo (llega a Mailpit, el enlace verifica) y
 *   el 6.º reenvío del minuto se frena.
 * - CTA-03: un vendedor activa la verificación en dos pasos por su cuenta; «Listo» sólo tras «Los guardé».
 * - CTA-05: cambiar de teléfono pide contraseña + código actual; abandonarlo a la mitad deja el aviso de
 *   cambio pendiente y la app vieja sigue sirviendo; terminarlo cambia la clave.
 */

const appShell = (page: Page) => page.getByRole('link', { name: 'Inicio', exact: true });
const dosPasos = (page: Page) => page.getByRole('region', { name: 'Verificación en dos pasos' });
const sinPuestos = (page: Page) => page.getByRole('heading', { name: 'No hay puestos libres' });

async function contexto(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

async function entrar(page: Page, key: UserKey): Promise<void> {
  await submitCredentials(page, USERS[key].email);
  await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
}

/** Lee la clave que se muestra para cargar a mano en la app de autenticación. */
async function claveManual(page: Page): Promise<string> {
  await page.getByText('¿No puedes escanear? Ingresa la clave a mano').click();
  const etiqueta = await page
    .getByLabel(/^Clave: /)
    .first()
    .getAttribute('aria-label');
  const clave = etiqueta?.replace(/^Clave: /, '').replace(/\s/g, '') ?? '';
  expect(clave, 'la clave manual se ve en pantalla').toMatch(/^[A-Z2-7]{16,}$/);
  return clave;
}

async function guardarCodigos(page: Page): Promise<string[]> {
  const lista = page.getByLabel('Códigos de recuperación');
  await expect(lista).toBeVisible();
  const codigos = [
    ...new Set(
      (await lista.locator('li').allInnerTexts())
        .map((t) => t.replace(/^\d+\.\s*/, '').trim())
        .filter((t) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(t)),
    ),
  ];
  expect(codigos).toHaveLength(10);
  const listo = page.getByRole('button', { name: 'Listo' });
  await expect(listo).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Los guardé en un lugar seguro' }).check();
  await listo.click();
  return codigos;
}

/**
 * El código de la app actual en «Cambiar de teléfono». `POST /auth/mfa/enroll` admite 10 por minuto
 * por IP, y en el stack E2E todo el panel llega con la misma: si responde «Demasiados intentos»,
 * espera el minuto y repite con un código nuevo (como `submitCredentials` con el login).
 */
async function pasarPuerta(
  page: Page,
  secret: string,
  ultimo: number,
): Promise<{ code: string; step: number }> {
  const limitado = dosPasos(page).getByText('Demasiados intentos. Espera un minuto');
  let paso = await freshTotp(secret, ultimo);
  await typeSixDigits(page, paso.code);
  const salio = page.getByText('¿No puedes escanear? Ingresa la clave a mano');
  await expect(salio.or(limitado).first()).toBeVisible({ timeout: 20_000 });
  if (await limitado.isVisible()) {
    await page.waitForTimeout(61_000);
    paso = await freshTotp(secret, paso.step);
    await typeSixDigits(page, paso.code);
  }
  return paso;
}

test.describe('cupo de puestos lleno', { tag: '@auth' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let ocupante: Page;

  test.beforeAll(async ({ browser }) => {
    ocupante = await contexto(browser);
    await entrar(ocupante, 'cupoUno');
  });

  test.afterAll(async () => {
    await ocupante.context().close();
  });

  test('ACC-16 un vendedor sin puesto lo lee, puede reintentar y no ve sesiones ajenas', async ({
    page,
  }) => {
    await submitCredentials(page, USERS.cupoDos.email);
    await expect(sinPuestos(page)).toBeVisible();
    await expect(page.getByText('El único puesto de Agencia E2E Cupo está en uso.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Desconectar y entrar' })).toHaveCount(0);
    await expect(page.getByText(USERS.cupoUno.email)).toHaveCount(0);
    await expect(page.getByText('Vendedor Cupo Uno')).toHaveCount(0);

    await page.getByRole('button', { name: 'Volver a intentar' }).click();
    await expect(page.getByLabel('Correo electrónico')).toBeVisible();
    await expect(appShell(page)).toHaveCount(0);
  });

  test('ACC-17 el admin del nodo desconecta a quien ocupa el puesto y entra; el otro ve «liberada»', async ({
    page,
  }) => {
    await submitCredentials(page, USERS.cupoAdmin.email);
    await expect(sinPuestos(page)).toBeVisible();
    const fila = page.getByRole('listitem').filter({ hasText: 'Vendedor Cupo Uno' });
    await expect(fila).toBeVisible();
    await fila.getByRole('button', { name: 'Desconectar y entrar' }).click();

    const confirmar = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(confirmar.getByText('¿Desconectar a Vendedor Cupo Uno?')).toBeVisible();
    await confirmar.getByRole('button', { name: 'Desconectar y entrar' }).click();

    // El admin no tenía MFA: entra al gate de activarla (o al panel, si ya la tenía).
    const gate = page.getByRole('heading', { name: 'Activa la verificación en dos pasos' });
    const reto = page.getByRole('textbox', { name: 'Dígito 1 de 6' });
    await expect(gate.or(reto).or(appShell(page)).first()).toBeVisible({ timeout: 45_000 });
    if (await gate.isVisible()) await enrollMfa(page, 'cupoAdmin');
    await expect(sinPuestos(page)).toHaveCount(0);

    await ocupante.goto('/');
    await expect(ocupante).toHaveURL(/\/login\?.*motivo=liberada/, { timeout: 30_000 });
    await expect(
      ocupante.getByText(
        'Si necesitas seguir trabajando, vuelve a ingresar cuando haya un puesto libre.',
      ),
    ).toBeVisible();
  });
});

test.describe('correo sin verificar', { tag: '@auth' }, () => {
  test.setTimeout(120_000);

  test('ACC-26 «Reenviar correo» manda uno nuevo, el enlace verifica, y el 6.º del minuto se frena', async ({
    page,
  }) => {
    test.skip(!(await hayBuzon()), 'sin Mailpit no se puede leer el correo');
    await entrar(page, 'sinVerificar');
    const banner = page.getByText('Verifica tu correo para asegurar tu cuenta');
    await expect(banner).toBeVisible();

    const desde = new Date(Date.now() - 5_000);
    const reenviar = page.getByRole('button', { name: 'Reenviar correo' });
    await reenviar.click();
    await expect(page.getByText('Te enviamos un correo de verificación.')).toBeVisible();
    const correo = await ultimoCorreo(USERS.sinVerificar.email, { desde, esperaMs: 20_000 });
    expect(correo, 'llega el correo de verificación').toBeDefined();
    const enlace = correo!.enlaces.find((e) => /verif/i.test(e));
    expect(enlace, `un enlace para verificar en «${correo!.asunto}»`).toBeDefined();

    // Cuatro más pasan; el sexto del minuto ya no.
    for (let i = 0; i < 4; i++) {
      await reenviar.click();
      await expect(reenviar).toBeEnabled();
    }
    await reenviar.click();
    await expect(page.getByText('Te enviamos un correo de verificación.')).toHaveCount(0);
    await expect(
      page.getByText(/muchos intentos|demasiad|too many|No se pudo reenviar/i).first(),
    ).toBeVisible();

    // La página verifica al cargar (pide a la API desde el navegador): se espera el resultado.
    await page.goto(enlace!);
    await expect(page.getByRole('heading', { name: '¡Correo verificado!' })).toBeVisible();
    await page.getByRole('link', { name: 'Ir al panel' }).click();
    await expect(appShell(page)).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
});

test.describe('verificación en dos pasos voluntaria', { tag: '@auth' }, () => {
  test.describe.configure({ mode: 'serial' });
  // Cada código nuevo espera su paso de 30 s (no se reusa un paso ya usado).
  test.setTimeout(420_000);

  test('CTA-03 un vendedor la activa con contraseña + código y guarda sus códigos', async ({
    page,
  }) => {
    await entrar(page, 'voluntario');
    await page.goto('/configuracion/seguridad');
    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await expect(page.getByRole('img', { name: /código QR/i }).first()).toBeVisible();
    const clave = await claveManual(page);

    await page.getByLabel('Tu contraseña').fill(E2E_PASSWORD);
    const { code, step } = await freshTotp(clave, undefined);
    await typeSixDigits(page, code);
    const recoveryCodes = await guardarCodigos(page);
    writeMfa('voluntario', { secret: clave, lastStep: step, recoveryCodes });

    await expect(page.getByRole('button', { name: 'Cambiar de teléfono' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Desactivar' })).toBeVisible();
  });

  test('CTA-05 cambiar de teléfono: abandonado deja el aviso y la app vieja; terminado cambia la clave', async ({
    page,
    browser,
  }) => {
    const antes = readMfa('voluntario');
    expect(antes, 'CTA-03 dejó la clave').toBeDefined();

    await submitCredentials(page, USERS.voluntario.email);
    let actual = await freshTotp(antes!.secret, antes!.lastStep);
    await typeSixDigits(page, actual.code);
    await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
    await page.goto('/configuracion/seguridad');

    // Primero, la contraseña y el código de la app actual.
    await page.getByRole('button', { name: 'Cambiar de teléfono' }).click();
    await dosPasos(page).getByLabel('Contraseña actual').fill(E2E_PASSWORD);
    actual = await pasarPuerta(page, antes!.secret, actual.step);
    const nueva = await claveManual(page);
    expect(nueva).not.toBe(antes!.secret);

    // Lo abandona: al volver, el aviso; la app vieja sigue entrando.
    await page.goto('/configuracion/seguridad');
    await expect(page.getByText('Empezaste a cambiar de teléfono y no terminaste.')).toBeVisible();
    const otro = await contexto(browser);
    await submitCredentials(otro, USERS.voluntario.email);
    actual = await freshTotp(antes!.secret, actual.step);
    await typeSixDigits(otro, actual.code);
    await expect(appShell(otro)).toBeVisible({ timeout: 45_000 });
    await otro.context().close();

    // Lo termina (la otra entrada cerró esta sesión: una por persona). Este navegador quedó
    // recordado al pasar el primer reto («Recordar este equipo» viene marcado): no pide código.
    await submitCredentials(page, USERS.voluntario.email);
    await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
    await page.goto('/configuracion/seguridad');
    await page.getByRole('button', { name: 'Cambiar de teléfono' }).click();
    await dosPasos(page).getByLabel('Contraseña actual').fill(E2E_PASSWORD);
    actual = await pasarPuerta(page, antes!.secret, actual.step);
    const definitiva = await claveManual(page);
    // El api no acepta dos códigos del mismo paso de 30 s, aunque sean de claves distintas.
    const conNueva = await freshTotp(definitiva, actual.step);
    await typeSixDigits(page, conNueva.code);
    const recoveryCodes = await guardarCodigos(page);
    writeMfa('voluntario', { secret: definitiva, lastStep: conNueva.step, recoveryCodes });
    await expect(page.getByText('Empezaste a cambiar de teléfono y no terminaste.')).toHaveCount(0);

    // La clave vieja ya no entra; la nueva sí.
    const tercero = await contexto(browser);
    await submitCredentials(tercero, USERS.voluntario.email);
    const vieja = await freshTotp(antes!.secret, conNueva.step);
    await typeSixDigits(tercero, vieja.code);
    await expect(tercero.getByRole('textbox', { name: 'Dígito 1 de 6' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(appShell(tercero)).toHaveCount(0);
    const otraVez = await freshTotp(definitiva, conNueva.step);
    writeMfa('voluntario', { secret: definitiva, lastStep: otraVez.step, recoveryCodes });
    await tercero.getByRole('textbox', { name: 'Dígito 1 de 6' }).click();
    await tercero.keyboard.press('Control+A');
    await tercero.keyboard.press('Backspace');
    await typeSixDigits(tercero, otraVez.code);
    await expect(appShell(tercero)).toBeVisible({ timeout: 45_000 });
    await tercero.context().close();
  });
});
