import { expect, test, type Browser, type Page } from '@playwright/test';
import { sql } from '../api/support/cliente';
import { submitCredentials, typeSixDigits } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { freshTotp } from '../support/totp';
import { E2E_PASSWORD, USERS, type UserKey } from '../support/users';

/**
 * Tanda 23 en el navegador (docs/qa/01 §5 ACC y CTA), con usuarios propios del seed:
 *
 * - ACC-22 (mitad E): «Restablecer contraseña» dice lo mismo exista o no el correo.
 * - ACC-23: /restablecer sin token, corta, larga, distintas, éxito, enlace usado y enlace vencido.
 * - CTA-08: cambiar la contraseña con la actual errada, corta, distintas o igual a la actual; con éxito
 *   entra con la nueva.
 * - CTA-06: regenerar los códigos de recuperación pide un código de la app; los viejos dejan de servir y
 *   el aviso aparece con 3, 1 y 0 códigos.
 */

const corrida = Date.now().toString(36);
const NUEVA = `Nueva-Clave-QA23-${corrida}`;
const appShell = (page: Page) => page.getByRole('link', { name: 'Inicio', exact: true });

async function contexto(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

async function entrar(page: Page, key: UserKey, clave = E2E_PASSWORD): Promise<void> {
  await submitCredentials(page, USERS[key].email, clave);
  await expect(appShell(page)).toBeVisible({ timeout: 45_000 });
}

/** Sin `minLength`/`maxLength`: así el mensaje que se prueba es el del servidor, no el del navegador. */
async function sinLimites(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const i of Array.from(document.querySelectorAll('input'))) {
      i.removeAttribute('minlength');
      i.removeAttribute('maxlength');
    }
  });
}

test.describe('restablecer la contraseña', { tag: '@auth' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeEach(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  });

  test('ACC-22 / ACC-23 mismo aviso, validaciones, éxito, enlace usado y vencido', async ({
    browser,
  }) => {
    const page = await contexto(browser);
    const email = USERS.restablecer.email;
    const aviso =
      'Si ese correo tiene una cuenta activa, te llega un enlace en unos minutos. El enlace vence en 1 hora.';

    const pedir = async (correo: string) => {
      await page.goto('/olvide-password');
      await expect(page.getByRole('heading', { name: 'Restablecer contraseña' })).toBeVisible();
      await page.getByLabel('Correo electrónico').fill(correo);
      await page.getByRole('button', { name: 'Enviar enlace' }).click();
      await expect(page.getByRole('status')).toHaveText(aviso);
    };

    await pedir(`nadie-${corrida}@e2e.test`);
    let desde = new Date(Date.now() - 1_000);
    await pedir(email);
    const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
    const enlace = correo?.enlaces.find((e) => /\/restablecer\?token=/.test(e));
    expect(enlace, 'el enlace llega').toBeTruthy();
    const ruta = new URL(enlace!).pathname + new URL(enlace!).search;

    await page.goto('/restablecer');
    await expect(page.getByRole('heading', { name: 'Enlace inválido' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pide uno nuevo' })).toHaveAttribute(
      'href',
      '/olvide-password',
    );

    await page.goto(ruta);
    await expect(page.getByRole('heading', { name: 'Elige tu contraseña nueva' })).toBeVisible();
    const nueva = page.getByLabel('Contraseña nueva');
    const repetir = page.getByLabel('Repetir contraseña');
    const guardar = page.getByRole('button', { name: 'Guardar contraseña' });
    const error = page.getByRole('alert').filter({ hasText: /\S/ });

    await sinLimites(page);
    await nueva.fill('Corta-123');
    await repetir.fill('Corta-123');
    await guardar.click();
    await expect(error).toHaveText('La contraseña debe tener al menos 12 caracteres.');

    await sinLimites(page);
    const larga = 'L'.repeat(129);
    await nueva.fill(larga);
    await repetir.fill(larga);
    await guardar.click();
    await expect(error).toHaveText('La contraseña puede tener hasta 128 caracteres.');

    await nueva.fill(NUEVA);
    await repetir.fill(`${NUEVA}-otra`);
    await guardar.click();
    await expect(error).toHaveText('Las contraseñas no coinciden.');

    await nueva.fill(NUEVA);
    await repetir.fill(NUEVA);
    await guardar.click();
    await expect(page.getByRole('heading', { name: 'Contraseña actualizada' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      'Por seguridad cerramos todas las sesiones abiertas en otros dispositivos.',
    );
    await expect(page.getByRole('link', { name: 'Iniciar sesión' })).toBeVisible();

    await page.goto(ruta);
    await page.getByLabel('Contraseña nueva').fill(`${NUEVA}-2`);
    await page.getByLabel('Repetir contraseña').fill(`${NUEVA}-2`);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toHaveText('El enlace ya se usó o venció. Pide uno nuevo.');

    desde = new Date(Date.now() - 1_000);
    await pedir(email);
    const otro = (await ultimoCorreo(email, { desde, esperaMs: 15_000 }))?.enlaces.find((e) =>
      /\/restablecer\?token=/.test(e),
    );
    expect(otro).toBeTruthy();
    await sql(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND used_at IS NULL`,
      [email],
    );
    await page.goto(new URL(otro!).pathname + new URL(otro!).search);
    await page.getByLabel('Contraseña nueva').fill(`${NUEVA}-3`);
    await page.getByLabel('Repetir contraseña').fill(`${NUEVA}-3`);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(error).toHaveText('El enlace ya se usó o venció. Pide uno nuevo.');

    const otraPagina = await contexto(browser);
    await entrar(otraPagina, 'restablecer', NUEVA);
  });
});

test.describe('CTA-08 cambiar la contraseña', { tag: '@auth' }, () => {
  test.setTimeout(120_000);

  test('actual errada, corta, distintas, igual a la actual y éxito', async ({ browser }) => {
    const page = await contexto(browser);
    await entrar(page, 'clave');
    await page.goto('/configuracion/seguridad');
    const seccion = page.getByRole('region', { name: 'Contraseña' });
    const actual = seccion.getByLabel('Contraseña actual');
    const nueva = seccion.getByLabel('Nueva', { exact: true });
    const repetir = seccion.getByLabel('Repetir la nueva');
    const cambiar = seccion.getByRole('button', { name: 'Cambiar contraseña' });
    const aviso = seccion.getByRole('alert');

    await actual.fill('No-Es-La-Clave-2026!');
    await nueva.fill(NUEVA);
    await repetir.fill(NUEVA);
    await cambiar.click();
    await expect(aviso).toContainText('La contraseña actual no es correcta.');

    await sinLimites(page);
    await actual.fill(E2E_PASSWORD);
    await nueva.fill('Corta-123');
    await repetir.fill('Corta-123');
    await cambiar.click();
    await expect(aviso).toContainText('La contraseña nueva debe tener al menos 12 caracteres.');

    await nueva.fill(NUEVA);
    await repetir.fill(`${NUEVA}-otra`);
    await cambiar.click();
    await expect(aviso).toContainText('Las contraseñas nuevas no coinciden.');

    await nueva.fill(E2E_PASSWORD);
    await repetir.fill(E2E_PASSWORD);
    await cambiar.click();
    await expect(aviso).toContainText('La contraseña nueva tiene que ser distinta de la actual.');

    await nueva.fill(NUEVA);
    await repetir.fill(NUEVA);
    await cambiar.click();
    await expect(seccion.getByRole('status')).toContainText('Contraseña actualizada');
    await expect(appShell(page), 'esta sesión sigue abierta').toBeVisible();

    const otra = await contexto(browser);
    await entrar(otra, 'clave', NUEVA);
  });
});

test.describe('CTA-06 regenerar códigos de recuperación', { tag: '@auth' }, () => {
  test.setTimeout(240_000);

  test('pide la app, los viejos dejan de servir y avisa con 3, 1 y 0', async ({ browser }) => {
    const page = await contexto(browser);
    await entrar(page, 'codigos');
    await page.goto('/configuracion/seguridad');
    const dosPasos = page.getByRole('region', { name: 'Verificación en dos pasos' });

    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await page.getByText('¿No puedes escanear? Ingresa la clave a mano').click();
    const etiqueta = await page
      .getByLabel(/^Clave: /)
      .first()
      .getAttribute('aria-label');
    const clave = etiqueta?.replace(/^Clave: /, '').replace(/\s/g, '') ?? '';
    expect(clave).toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByLabel('Tu contraseña').fill(E2E_PASSWORD);
    let paso = await freshTotp(clave, undefined);
    await typeSixDigits(page, paso.code);
    const leer = async () => {
      const lista = page.getByRole('list', { name: 'Códigos de recuperación' });
      await expect(lista).toBeVisible();
      return [
        ...new Set(
          (await lista.locator('li').allInnerTexts())
            .map((t) => t.replace(/^\d+\.\s*/, '').trim())
            .filter((t) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(t)),
        ),
      ];
    };
    const viejos = await leer();
    expect(viejos).toHaveLength(10);
    await page.getByRole('checkbox', { name: 'Los guardé en un lugar seguro' }).check();
    await page.getByRole('button', { name: 'Listo' }).click();

    await dosPasos.getByRole('button', { name: 'Regenerar' }).click();
    await expect(
      page.getByRole('heading', { name: 'Generar códigos de recuperación nuevos' }),
    ).toBeVisible();
    await typeSixDigits(page, '000000');
    await expect(
      page.getByText('El código no es válido. Espera el siguiente en tu app e inténtalo de nuevo.'),
    ).toBeVisible();
    paso = await freshTotp(clave, paso.step);
    await typeSixDigits(page, paso.code);
    await expect(
      page.getByRole('heading', { name: 'Generamos códigos de recuperación nuevos' }),
    ).toBeVisible();
    const nuevos = await leer();
    expect(nuevos).toHaveLength(10);
    expect(nuevos.filter((c) => viejos.includes(c))).toHaveLength(0);
    const listo = page.getByRole('button', { name: 'Listo' });
    await expect(listo).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Los guardé en un lugar seguro' }).check();
    await listo.click();

    const usar = async (restantes: number) => {
      await sql(
        `UPDATE mfa_recovery_codes SET used_at = now()
          WHERE id IN (SELECT id FROM mfa_recovery_codes
                        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND used_at IS NULL
                        ORDER BY id OFFSET $2)`,
        [USERS.codigos.email, restantes],
      );
      await page.reload();
    };
    await usar(3);
    await expect(page.getByText('Te quedan 3 códigos de recuperación')).toBeVisible();
    await usar(1);
    await expect(page.getByText('Te queda 1 código de recuperación')).toBeVisible();

    const login = await contexto(browser);
    await submitCredentials(login, USERS.codigos.email);
    await login.getByRole('button', { name: 'Usar un código de recuperación' }).click();
    await login.getByLabel('Código de recuperación').fill(viejos[0]!);
    await login.getByRole('button', { name: 'Verificar' }).click();
    await expect(login.getByRole('alert'), 'un código viejo ya no sirve').toBeVisible();
    await expect(appShell(login)).toHaveCount(0);

    const vigente = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM mfa_recovery_codes
        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND used_at IS NULL`,
      [USERS.codigos.email],
    );
    expect(vigente[0]?.n).toBe('1');

    await usar(0);
    await expect(page.getByText('No te quedan códigos de recuperación')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generar códigos nuevos' })).toBeVisible();
  });
});
