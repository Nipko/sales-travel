import { expect, test } from '@playwright/test';
import { como, nodo, sql } from '../api/support/cliente';
import { submitCredentials } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { E2E_PASSWORD, USERS } from '../support/users';

/**
 * Invitaciones a quien ya tiene cuenta, y a un rol de admin (docs/qa/01 §5 ACC):
 *
 * - ACC-29: con la sesión de otra cuenta, la invitación lo dice y ofrece salir.
 * - ACC-28: sin sesión → «Ingresar para aceptar» → login → vuelve a la invitación → la acepta.
 * - ACC-31: una cuenta nueva invitada como admin entra al gate de 2FA antes que al panel.
 *
 * `invitado@e2e.test` es de la agencia B; el seed lo vuelve a sacar de la A en cada corrida.
 */
test.describe.configure({ mode: 'serial' });

async function enlaceDeInvitacion(email: string, role: 'vendedor' | 'admin'): Promise<string> {
  // Un admin no invita a otro admin: lo hace el tenant_admin de la agencia.
  const admin = await como(role === 'admin' ? 'tenantAdminA' : 'adminA');
  const desde = new Date(Date.now() - 5_000);
  const inv = await admin.post('/invitations', {
    email,
    tenantId: await nodo('e2e-agencia-a'),
    role,
  });
  // Un reintento del test encuentra la del intento anterior pendiente: se reenvía (enlace nuevo).
  if (inv.status === 409 && inv.text.includes('INVITATION_ALREADY_PENDING')) {
    const { details } = inv.body as { details?: { invitationId?: string } };
    const reenvio = await admin.post(
      `/invitations/${details?.invitationId}/resend?tenantId=${await nodo('e2e-agencia-a')}`,
    );
    expect(reenvio.status, reenvio.text).toBeLessThan(300);
  } else {
    expect(inv.status, inv.text).toBeLessThan(300);
  }
  const correo = await ultimoCorreo(email, { desde });
  const enlace = correo?.enlaces.find((e) => /\/invitacion\?token=/.test(e));
  expect(enlace, 'el correo trae el enlace').toBeDefined();
  const { pathname, search } = new URL(enlace!);
  return `${pathname}${search}`;
}

test.describe('invitación a una cuenta que ya existe', { tag: '@desktop' }, () => {
  let ruta: string;

  test.beforeAll(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    ruta = await enlaceDeInvitacion('invitado@e2e.test', 'vendedor');
  });

  test('ACC-29 con la sesión de otra cuenta: lo dice y ofrece salir', async ({ page }) => {
    await submitCredentials(page, USERS.acceso.email);
    await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
    await page.goto(ruta);
    await expect(page.getByText('Esta invitación es para otra cuenta.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aceptar invitación' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Salir e ingresar con la cuenta invitada' }).click();
    await expect(page.getByLabel('Correo electrónico')).toBeVisible();
  });

  test('ACC-28 sin sesión: ingresa para aceptar, vuelve a la invitación y la acepta', async ({
    page,
  }) => {
    await page.goto(ruta);
    await expect(page.getByText('Te invitaron a Agencia E2E A', { exact: false })).toBeVisible();
    const ingresar = page.getByRole('link', { name: 'Ingresar para aceptar' });
    const login = await ingresar.getAttribute('href');
    expect(login).toMatch(/^\/login\?next=/);
    // Con reintento si el login está limitado por tasa (en CI todos entran desde la misma IP).
    await submitCredentials(page, 'invitado@e2e.test', E2E_PASSWORD, login!);

    await expect(page).toHaveURL(/\/invitacion\?token=/);
    await page.getByRole('button', { name: 'Aceptar invitación' }).click();
    await expect(
      page.getByRole('heading', { name: 'Ya formas parte de Agencia E2E A' }),
    ).toBeVisible();

    const [m] = await sql<{ role: string; status: string }>(
      `SELECT m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'invitado@e2e.test' AND m.tenant_id = $1`,
      [await nodo('e2e-agencia-a')],
    );
    expect(m).toEqual({ role: 'vendedor', status: 'active' });

    // Usada: abrirla otra vez ya no la acepta.
    await page.goto(ruta);
    await expect(page.getByRole('button', { name: 'Aceptar invitación' })).toHaveCount(0);
  });
});

test.describe('invitación a un rol de admin', { tag: '@desktop' }, () => {
  test('ACC-31 la cuenta nueva de un admin entra al gate de 2FA', async ({ page }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const email = `invitada-admin-${Date.now().toString(36)}@e2e.test`;
    await page.goto(await enlaceDeInvitacion(email, 'admin'));
    await page.getByLabel('Tu nombre').fill('Admin Invitada');
    await page.getByLabel('Contraseña', { exact: true }).fill('Clave-De-Prueba-2026!');
    await page.getByLabel('Repetir contraseña').fill('Clave-De-Prueba-2026!');
    await page.getByRole('button', { name: 'Crear cuenta y aceptar' }).click();
    await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();

    await submitCredentials(page, email, 'Clave-De-Prueba-2026!');
    await expect(
      page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }),
    ).toBeVisible();
    await page.goto('/cotizaciones');
    await expect(
      page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toHaveCount(0);
  });
});
