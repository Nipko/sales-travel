import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { como, nodo, sql } from '../api/support/cliente';
import { storageStateFile, submitCredentials, typeSixDigits } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { USERS, type UserKey } from '../support/users';

/**
 * Tanda 29 en el navegador (docs/qa/01 §5 ACC, CTA e INI):
 *
 * - ACC-25 (mitad E): /verificar sin token, con un token que no sirve y con el mismo enlace dos veces.
 * - ACC-30: invitación vencida y ya usada → «Invitación no válida» (y el accept da 400); quien invitó
 *   quedó suspendido con el formulario abierto → «Esta invitación ya no es válida, pide una nueva.»
 * - CTA-04: activar el 2FA con la contraseña errada lo dice en su campo; al 5.º intento se bloquea.
 * - INI-02: el superadmin en / aterriza en /admin/plataforma/estado.
 * - INI-05: Reportes muestra el período, los KPI, las tablas por mes, vertical y vendedor y exporta CSV.
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

const rutaDe = (url: string) => new URL(url).pathname + new URL(url).search;

test.describe('ACC-25 verificar el correo', { tag: '@auth' }, () => {
  test.setTimeout(120_000);

  test('sin token, token inválido y el mismo enlace dos veces', async ({ browser }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const page = await contexto(browser);
    await page.goto('/verificar');
    await expect(page.getByRole('heading', { name: 'No pudimos verificar' })).toBeVisible();
    await expect(page.getByText('Enlace inválido: falta el token.')).toBeVisible();

    await page.goto(`/verificar?token=${'x'.repeat(40)}`);
    await expect(page.getByRole('heading', { name: 'No pudimos verificar' })).toBeVisible();
    await expect(
      page.getByText(
        'El enlace para verificar tu correo venció o no es válido. Pide uno nuevo desde el aviso del panel.',
      ),
    ).toBeVisible();

    await sql(`UPDATE users SET email_verified_at = NULL WHERE email = $1`, [
      USERS.sinVerificar.email,
    ]);
    const usuario = await contexto(browser);
    await entrar(usuario, 'sinVerificar');
    const desde = new Date(Date.now() - 1_000);
    await usuario.getByRole('button', { name: 'Reenviar correo' }).click();
    const correo = await ultimoCorreo(USERS.sinVerificar.email, { desde, esperaMs: 15_000 });
    const enlace = correo?.enlaces.find((e) => /\/verificar\?token=/.test(e));
    expect(enlace).toBeTruthy();
    for (const vez of ['primera', 'segunda']) {
      await page.goto(rutaDe(enlace!));
      await expect(
        page.getByRole('heading', { name: '¡Correo verificado!' }),
        `${vez} vez`,
      ).toBeVisible({ timeout: 20_000 });
    }
  });
});

test.describe('ACC-30 invitaciones que ya no sirven', { tag: '@auth' }, () => {
  test.setTimeout(150_000);

  test('vencida, usada y con quien invitó suspendido', async ({ browser }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const admin = await como('adminA');
    const nodoA = await nodo('e2e-agencia-a');
    const invitar = async (
      sufijo: string,
    ): Promise<{ email: string; ruta: string; token: string }> => {
      const email = `qa29-${corrida}-${sufijo}@e2e.test`;
      const desde = new Date(Date.now() - 1_000);
      const r = await admin.post('/invitations', { email, tenantId: nodoA, role: 'vendedor' });
      expect(r.status, r.text).toBeLessThan(300);
      const enlace = (await ultimoCorreo(email, { desde, esperaMs: 15_000 }))?.enlaces.find((e) =>
        /\/invitacion\?token=/.test(e),
      );
      expect(enlace).toBeTruthy();
      return { email, ruta: rutaDe(enlace!), token: new URL(enlace!).searchParams.get('token')! };
    };
    const page = await contexto(browser);
    const anon = await como('vendedorB');

    for (const [caso, columna] of [
      ['vencida', 'expires_at'],
      ['usada', 'accepted_at'],
    ] as const) {
      const inv = await invitar(caso);
      await sql(
        `UPDATE user_invitations SET ${columna} = now() - interval '1 minute' WHERE email = $1`,
        [inv.email],
      );
      await page.goto(inv.ruta);
      await expect(page.getByRole('heading', { name: 'Invitación no válida' }), caso).toBeVisible();
      const r = await anon.post('/invitations/accept', {
        token: inv.token,
        name: 'Persona QA',
        password: 'Clave-Nueva-QA29-2026!',
      });
      expect(r.status, caso).toBe(400);
    }

    const inv = await invitar('suspendido');
    await page.goto(inv.ruta);
    await expect(page.getByRole('heading', { name: /^Te invitaron a / })).toBeVisible();
    await page.getByLabel('Tu nombre').fill('Persona QA');
    await page.getByLabel('Contraseña', { exact: true }).fill('Clave-Nueva-QA29-2026!');
    await page.getByLabel('Repetir contraseña').fill('Clave-Nueva-QA29-2026!');
    const quien = `(SELECT id FROM users WHERE email = 'api-admin-a@e2e.test')`;
    await sql(
      `UPDATE memberships SET status = 'suspended' WHERE user_id = ${quien} AND tenant_id = $1`,
      [nodoA],
    );
    try {
      await page.getByRole('button', { name: 'Crear cuenta y aceptar' }).click();
      await expect(
        page.getByText('Esta invitación ya no es válida, pide una nueva.'),
      ).toBeVisible();
    } finally {
      await sql(
        `UPDATE memberships SET status = 'active' WHERE user_id = ${quien} AND tenant_id = $1`,
        [nodoA],
      );
    }
  });
});

test.describe('CTA-04 primera activación con la contraseña errada', { tag: '@auth' }, () => {
  test.setTimeout(420_000);

  test('cada intento lo dice en el campo; el 5.º bloquea', async ({ browser }) => {
    const page = await contexto(browser);
    await entrar(page, 'enrola');
    await page.goto('/configuracion/seguridad');
    // /auth/mfa/enroll y /confirm admiten 10 por minuto por IP, y en el stack E2E todo el panel llega
    // con la misma (otras pruebas activan 2FA antes): ante «Demasiados intentos. Espera un minuto»,
    // se espera el minuto y se repite, como `pasarPuerta` en f43.
    const limitado = page.getByText('Demasiados intentos. Espera un minuto e inténtalo de nuevo.');
    const conPausa = async (accion: () => Promise<void>, listo: ReturnType<Page['getByText']>) => {
      await accion();
      await expect(listo.or(limitado).first()).toBeVisible({ timeout: 20_000 });
      if (await limitado.isVisible()) {
        await page.waitForTimeout(61_000);
        await accion();
        await expect(listo).toBeVisible({ timeout: 20_000 });
      }
    };
    const clave = page.getByLabel('Tu contraseña');
    await conPausa(
      () => page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click(),
      page.getByText('¿No puedes escanear? Ingresa la clave a mano'),
    );
    const activar = page.getByRole('button', { name: 'Activar' });
    const errada = page.getByText('La contraseña no es correcta. Revísala e inténtalo de nuevo.');
    const bloqueo = page.getByText(
      'Demasiados intentos fallidos. Por seguridad pausamos la verificación 15 minutos; inténtalo de nuevo más tarde.',
    );

    await clave.fill('No-Es-Mi-Clave-2026!');
    await conPausa(() => typeSixDigits(page, '000000'), errada);
    await expect(clave).toHaveAttribute('aria-invalid', 'true');

    for (let i = 2; i <= 5 && !(await bloqueo.isVisible()); i++) {
      await clave.fill(`No-Es-Mi-Clave-2026-${i}`);
      await conPausa(() => activar.click(), i === 5 ? bloqueo : errada.or(bloqueo));
    }
    await expect(bloqueo).toBeVisible();
    const [u] = await sql<{ bloqueada: boolean }>(
      `SELECT locked_until > now() AS bloqueada FROM users WHERE email = $1`,
      [USERS.enrola.email],
    );
    expect(u?.bloqueada, 'la cuenta queda bloqueada 15 minutos').toBe(true);
  });
});

test.describe('INI-02 / INI-05', { tag: '@desktop' }, () => {
  test.describe('superadmin', () => {
    test.use({ storageState: storageStateFile('superadmin') });

    test('INI-02 en / aterriza en el estado de la plataforma', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/admin\/plataforma\/estado$/);
      await expect(page.getByRole('heading', { name: 'Estado', level: 1 })).toBeVisible();
    });
  });

  test.describe('vendedor', () => {
    test.use({ storageState: storageStateFile('vendedorA') });

    test('INI-05 período, KPI, tablas y CSV', async ({ page }) => {
      await page.goto('/reportes');
      await expect(page.getByRole('heading', { name: 'Reportes', level: 1 })).toBeVisible();
      await expect(page.getByText(/^Ventas confirmadas · .+ · hora de Bogotá$/)).toBeVisible();
      await expect(page.getByText('Ventas confirmadas · COP', { exact: true })).toBeVisible();
      await expect(page.getByText('Reservas confirmadas', { exact: true }).first()).toBeVisible();
      for (const t of ['Por mes · COP', 'Por vertical · COP', 'Por vendedor · COP']) {
        await expect(page.getByRole('heading', { name: t })).toBeVisible();
      }
      await expect(page.getByText('Comisiones y márgenes')).toBeVisible();

      const descarga = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Exportar CSV' }).click();
      const archivo = await descarga;
      expect(archivo.suggestedFilename()).toMatch(/^ventas-\d{4}-\d{2}-a-\d{4}-\d{2}\.csv$/);
      const texto = readFileSync(await archivo.path(), 'utf8').trimStart();
      expect(texto.split(/\r?\n/)[0]).toBe('Corte,Detalle,Moneda,Reservas confirmadas,Monto');
      expect(texto).toMatch(/\nVertical,[^,]+,COP,\d+,\d+\.\d{2}/);
    });
  });
});
