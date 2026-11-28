import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFile, submitCredentials, typeSixDigits } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { freshTotp } from '../support/totp';
import { E2E_PASSWORD, USERS, type UserKey } from '../support/users';

/**
 * Tanda 24 en el navegador (docs/qa/01 §5 CTA, AGE y EQU):
 *
 * - CTA-01: «Tu nombre» normaliza espacios y valida vacío, largo, invisibles y sin letras; el correo no
 *   se edita; el nombre nuevo aparece en el menú de la cuenta.
 * - CTA-07: un vendedor desactiva el 2FA con contraseña + código (uno errado se rechaza); un admin ve
 *   «Obligatoria para tu rol» sin botón para desactivar.
 * - AGE-01: General valida el nombre (2–120) antes de mandar, guarda nombre normalizado, país, moneda e
 *   idioma y los relee al recargar; el slug no se edita. Al final devuelve los valores originales.
 * - EQU-02: un admin sólo ofrece Vendedor y Cliente; un correo inválido se rechaza en castellano; la
 *   invitación llega a Mailpit.
 * - EQU-05: «Reenviar» deja sin efecto el enlace anterior; «Revocar» (con confirmación) el nuevo.
 */

const corrida = Date.now().toString(36);
const appShell = (page: Page) => page.getByRole('link', { name: 'Inicio', exact: true });

async function contexto(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

async function entrar(page: Page, key: UserKey): Promise<void> {
  await submitCredentials(page, USERS[key].email);
  await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
}

test.describe('CTA-01 tu nombre', { tag: '@auth' }, () => {
  test('valida, normaliza y se ve en el menú de la cuenta', async ({ browser }) => {
    const page = await contexto(browser);
    await entrar(page, 'perfil');
    await page.goto('/configuracion/perfil');
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    await expect(page.getByText(USERS.perfil.email)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /correo/i })).toHaveCount(0);

    const nombre = page.getByLabel('Tu nombre');
    const guardar = page.getByRole('button', { name: 'Guardar' });
    const error = page.getByRole('alert').filter({ hasText: /\S/ });

    for (const [valor, mensaje] of [
      ['   ', 'Escribe tu nombre.'],
      ['N'.repeat(121), 'Tu nombre puede tener hasta 120 caracteres.'],
      [
        'Ana​Ruiz',
        'Tu nombre tiene caracteres invisibles o de control. Escríbelo de nuevo a mano.',
      ],
      ['123 456', 'Tu nombre tiene que tener al menos una letra.'],
    ] as const) {
      await nombre.fill(valor);
      await guardar.click();
      await expect(error, valor).toHaveText(mensaje);
      await expect(nombre).toHaveAttribute('aria-invalid', 'true');
    }

    const nuevo = `Ana  María\tPérez ${corrida}`;
    await nombre.fill(nuevo);
    await guardar.click();
    const normalizado = `Ana María Pérez ${corrida}`;
    await expect(page.getByText('Guardamos tu nombre.')).toBeVisible();
    await expect(nombre).toHaveValue(normalizado);
    await page.reload();
    await expect(page.getByRole('button', { name: `Tu cuenta: ${normalizado}` })).toBeVisible();
  });
});

test.describe('CTA-07 desactivar el 2FA', { tag: '@auth' }, () => {
  test.setTimeout(180_000);

  test('un vendedor la desactiva con contraseña y código', async ({ browser }) => {
    const page = await contexto(browser);
    await entrar(page, 'desactiva');
    await page.goto('/configuracion/seguridad');
    const dosPasos = page.getByRole('region', { name: 'Verificación en dos pasos' });

    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await page.getByText('¿No puedes escanear? Ingresa la clave a mano').click();
    const etiqueta = await page
      .getByLabel(/^Clave: /)
      .first()
      .getAttribute('aria-label');
    const clave = etiqueta?.replace(/^Clave: /, '').replace(/\s/g, '') ?? '';
    await page.getByLabel('Tu contraseña').fill(E2E_PASSWORD);
    let paso = await freshTotp(clave, undefined);
    await typeSixDigits(page, paso.code);
    await page.getByRole('checkbox', { name: 'Los guardé en un lugar seguro' }).check();
    await page.getByRole('button', { name: 'Listo' }).click();

    await dosPasos.getByRole('button', { name: 'Desactivar' }).click();
    await expect(
      page.getByRole('heading', { name: 'Desactivar la verificación en dos pasos' }),
    ).toBeVisible();
    const formulario = page.locator('form').filter({
      has: page.getByRole('heading', { name: 'Desactivar la verificación en dos pasos' }),
    });
    const desactivar = formulario.getByRole('button', { name: 'Desactivar' });

    await desactivar.click();
    expect(
      await formulario
        .getByLabel('Contraseña actual')
        .evaluate((i) => (i as HTMLInputElement).validity.valueMissing),
      'sin contraseña no se manda',
    ).toBe(true);

    await formulario.getByLabel('Contraseña actual').fill(E2E_PASSWORD);
    await typeSixDigits(page, '000000');
    await desactivar.click();
    await expect(formulario.getByRole('alert')).toContainText(
      'La contraseña o el código no son correctos.',
    );

    await formulario.getByLabel('Contraseña actual').fill(E2E_PASSWORD);
    paso = await freshTotp(clave, paso.step);
    await typeSixDigits(page, paso.code);
    await desactivar.click();
    await expect(dosPasos.getByText('Desactivada', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(appShell(page), 'esta sesión sigue abierta').toBeVisible();
  });

  test.describe('admin', () => {
    test.use({ storageState: storageStateFile('adminA') });

    test('su rol la exige: no hay botón para desactivarla', async ({ page }) => {
      await page.goto('/configuracion/seguridad');
      const dosPasos = page.getByRole('region', { name: 'Verificación en dos pasos' });
      await expect(dosPasos.getByText('Obligatoria para tu rol')).toBeVisible();
      await expect(dosPasos.getByRole('button', { name: 'Desactivar' })).toHaveCount(0);
    });
  });
});

test.describe('AGE-01 General de la agencia', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('adminA') });

  test('valida el nombre, guarda y relee; el slug no se edita', async ({ page }) => {
    await page.goto('/configuracion');
    const original = (await (await page.request.get('/api/tenant/config')).json()) as {
      name: string;
      countryCode: string;
      defaultCurrency: string;
      defaultLanguage: string;
    };
    try {
      const nombre = page.getByLabel('Nombre de la agencia');
      await expect(nombre).toHaveValue(original.name);
      await expect(page.getByLabel('Identificador único (Slug)')).toBeDisabled();
      const guardar = page.getByRole('button', { name: 'Guardar configuración' });

      await nombre.fill(' A ');
      await guardar.click();
      await expect(page.getByRole('alert').filter({ hasText: 'nombre de la agencia' })).toHaveText(
        'El nombre de la agencia tiene que tener al menos 2 caracteres.',
      );
      await nombre.fill('N'.repeat(121));
      await guardar.click();
      await expect(page.getByRole('alert').filter({ hasText: 'nombre de la agencia' })).toHaveText(
        'El nombre de la agencia puede tener hasta 120 caracteres.',
      );

      await nombre.fill(`  ${original.name.split(' ').join('   ')}  `);
      await page.getByLabel('País de Operación').selectOption('PE');
      await page.getByLabel('Moneda Base').selectOption('USD');
      await page.getByLabel('Idioma Preferido').selectOption('pt');
      await guardar.click();
      await expect(page.getByRole('status').filter({ hasText: 'guardada' })).toHaveText(
        'Configuración general guardada exitosamente.',
      );

      await page.reload();
      await expect(page.getByLabel('Nombre de la agencia')).toHaveValue(original.name);
      await expect(page.getByLabel('País de Operación')).toHaveValue('PE');
      await expect(page.getByLabel('Moneda Base')).toHaveValue('USD');
      await expect(page.getByLabel('Idioma Preferido')).toHaveValue('pt');

      await page.getByRole('button', { name: 'Dominio' }).click();
      await expect(page.getByRole('textbox', { name: 'Subdominio por defecto' })).toBeDisabled();
    } finally {
      const r = await page.request.patch('/api/tenant/config', {
        data: {
          name: original.name,
          countryCode: original.countryCode,
          defaultCurrency: original.defaultCurrency,
          defaultLanguage: original.defaultLanguage,
        },
      });
      expect(r.ok(), 'devuelve la configuración original').toBeTruthy();
    }
  });
});

test.describe('EQU-02 / EQU-05 invitar, reenviar y revocar', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('adminA') });
  test.setTimeout(120_000);

  test.beforeEach(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  });

  test('roles ofrecidos, correo inválido, invitación, reenvío y revocación', async ({
    page,
    browser,
  }) => {
    const email = `qa24-${corrida}@e2e.test`;
    await page.goto('/admin/usuarios');
    await page.getByRole('button', { name: 'Invitar usuario' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Invitar usuario' });
    const opciones = await dialogo.getByLabel('Rol').locator('option').allInnerTexts();
    expect(
      opciones.map((o) => o.trim()),
      'un admin sólo da roles por debajo del suyo',
    ).toEqual(['Vendedor', 'Cliente']);

    await dialogo.getByLabel('Correo electrónico').fill('persona@agencia');
    await dialogo.getByRole('button', { name: 'Enviar invitación' }).click();
    await expect(dialogo.getByRole('alert')).toContainText('escribe un correo válido');

    let desde = new Date(Date.now() - 1_000);
    await dialogo.getByLabel('Correo electrónico').fill(email);
    await dialogo.getByRole('button', { name: 'Enviar invitación' }).click();
    await expect(page.getByText(`Invitación enviada a ${email}.`)).toBeVisible();
    const primero = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
    expect(primero?.asunto).toMatch(/^Te invitaron a /);
    const enlace = (c: typeof primero) => {
      const e = c?.enlaces.find((x) => /\/invitacion\?token=/.test(x));
      expect(e).toBeTruthy();
      return new URL(e!).pathname + new URL(e!).search;
    };
    const viejo = enlace(primero);

    const pendientes = page.getByRole('region', { name: /^Invitaciones pendientes/ });
    desde = new Date(Date.now() - 1_000);
    await pendientes.getByRole('button', { name: `Reenviar la invitación a ${email}` }).click();
    await expect(page.getByText(`Reenviamos la invitación a ${email}.`)).toBeVisible();
    const nuevo = enlace(await ultimoCorreo(email, { desde, esperaMs: 15_000 }));
    expect(nuevo).not.toBe(viejo);

    const invitado = await contexto(browser);
    await invitado.goto(viejo);
    await expect(invitado.getByRole('heading', { name: 'Invitación no válida' })).toBeVisible();
    await invitado.goto(nuevo);
    await expect(invitado.getByRole('heading', { name: /^Te invitaron a / })).toBeVisible();

    await pendientes.getByRole('button', { name: `Revocar la invitación a ${email}` }).click();
    const confirmar = page.getByRole('dialog', { name: `Revocar la invitación a ${email}` });
    await confirmar.getByRole('button', { name: 'Revocar' }).click();
    await expect(page.getByText(`Revocamos la invitación a ${email}.`)).toBeVisible();
    await invitado.goto(nuevo);
    await expect(invitado.getByRole('heading', { name: 'Invitación no válida' })).toBeVisible();
  });
});
