import { expect, test } from '@playwright/test';
import { como, nodo, sql } from '../api/support/cliente';
import { hayBuzon, ultimoCorreo } from '../support/correo';

/**
 * Ola 3 del plan de QA (docs/qa/01 §5 ACC), ACC-27: invitación a un correo sin cuenta, de punta a
 * punta. El admin invita por la API, el enlace sale del buzón (INF-3) y la persona crea su cuenta
 * en /invitacion: nombre sin letras y contraseñas distintas se rechazan con su mensaje; el alta
 * crea la cuenta y la membresía con el rol invitado.
 */

test.describe('invitación', { tag: '@desktop' }, () => {
  test('ACC-27 correo nuevo: valida nombre y contraseña, y crea cuenta y membresía', async ({
    page,
  }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const admin = await como('adminA');
    const nodoA = await nodo('e2e-agencia-a');
    const email = `invitada-${Date.now().toString(36)}@e2e.test`;
    const desde = new Date(Date.now() - 1_000);

    const inv = await admin.post('/invitations', { email, tenantId: nodoA, role: 'vendedor' });
    expect(inv.status, inv.text).toBeLessThan(300);
    const correo = await ultimoCorreo(email, { desde });
    const enlace = correo?.enlaces.find((e) => /\/invitacion\?token=/.test(e));
    expect(enlace, 'el correo trae el enlace').toBeDefined();
    const { pathname, search } = new URL(enlace!);

    await page.goto(`${pathname}${search}`);
    const clave = 'Clave-De-Prueba-2026!';
    const llenar = async (nombre: string, repetida = clave) => {
      await page.getByLabel('Tu nombre').fill(nombre);
      await page.getByLabel('Contraseña', { exact: true }).fill(clave);
      await page.getByLabel('Repetir contraseña').fill(repetida);
      await page.getByRole('button', { name: 'Crear cuenta y aceptar' }).click();
    };

    await llenar('12345');
    await expect(page.getByText('Tu nombre tiene que tener al menos una letra.')).toBeVisible();
    await llenar('Ana Invitada', 'Otra-Clave-De-Prueba-2026!');
    await expect(page.getByText('Las contraseñas no coinciden.')).toBeVisible();

    await llenar('Ana Invitada');
    await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();

    const [m] = await sql<{ role: string; name: string }>(
      `SELECT m.role, u.name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND m.tenant_id = $2 AND m.status = 'active'`,
      [email, nodoA],
    );
    expect(m).toEqual({ role: 'vendedor', name: 'Ana Invitada' });
  });
});
