import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { USERS } from '../support/users';

/**
 * Tanda 19 en el navegador, con admin-a (docs/qa/01 §5 RED, BYO, AGE y EQU):
 *
 * - RED-05: un `admin` no puede darle admin al nodo nuevo, así que el formulario no le ofrece el campo y
 *   lo explica (la invitación por correo se prueba por HTTP con el consolidador, nodo-correo-y-marca).
 * - BYO-10: «Email» del nodo pide servidor, usuario y clave; puerto 465 se guarda con `secure`;
 *   «Enviar correo de prueba» llega al admin desde el remitente del nodo.
 * - AGE-04: «Marca» rechaza colores que no son hex de 6 dígitos y logos http://; la vista previa y el
 *   panel recargado usan los colores; «Quitar logo» lo quita. Al final devuelve la marca original.
 * - EQU-14: los filtros de Equipo quedan en la URL y sobreviven a recargar; «Quitar filtros» los limpia.
 *   La búsqueda NO viaja en la URL (así está hecho: queda anotado en el caso).
 */

test.use({ storageState: storageStateFile('adminA') });

const corrida = Date.now().toString(36);
const NOMBRE = `QA19 Sub ${corrida}`;

const fila = (page: Page, texto: string) => page.getByRole('row').filter({ hasText: texto });

test.describe('red: nodo nuevo y su correo', { tag: '@desktop' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeEach(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  });

  test('RED-05 un admin (sin rango para dar admin) crea la sub-agencia sin el campo de admin', async ({
    page,
  }) => {
    await page.goto('/red');
    await page
      .getByRole('button', { name: /^(Agencia|Sub-agencia|Agregar) bajo Agencia E2E A$/ })
      .click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText('Colgará de Agencia E2E A.')).toBeVisible();

    await dialogo.getByRole('button', { name: /^Crear/ }).click();
    await expect(dialogo.getByRole('alert')).toHaveText('Nombre y slug son requeridos.');

    await expect(dialogo.getByLabel('Email admin')).toHaveCount(0);
    await expect(
      dialogo.getByText(/Tu rol no alcanza para darle un admin al nodo nuevo/),
    ).toBeVisible();

    await dialogo.getByLabel('Nombre', { exact: true }).fill(NOMBRE);
    await expect(dialogo.getByLabel('Slug (URL)')).toHaveValue(/^qa19-sub-/);
    await dialogo.getByRole('button', { name: /^Crear/ }).click();

    await expect(page.getByText(new RegExp(`${NOMBRE} creada bajo Agencia E2E A`))).toBeVisible({
      timeout: 20_000,
    });
    await expect(fila(page, NOMBRE)).toBeVisible();
  });

  test('BYO-10 correo del nodo: requeridos, 465 → secure y correo de prueba', async ({ page }) => {
    await page.goto('/red');
    await fila(page, NOMBRE)
      .getByRole('button', { name: `Email de ${NOMBRE}` })
      .click();
    const dialogo = page.getByRole('dialog', { name: `Email · ${NOMBRE}` });
    await expect(dialogo).toBeVisible();
    await expect(
      dialogo.getByLabel('Heredable: las sub-agencias sin correo propio usan éste'),
    ).toBeChecked();

    await dialogo.getByLabel('Servidor SMTP').fill('');
    await dialogo.getByRole('button', { name: 'Guardar email' }).click();
    await expect(
      dialogo.getByText('Servidor, correo y clave de aplicación son requeridos.'),
    ).toBeVisible();

    const remitente = `avisos-${corrida}@qa19.test`;
    const llenar = async (puerto: string) => {
      await dialogo.getByLabel('Correo del remitente').fill(remitente);
      await dialogo.getByLabel('Servidor SMTP').fill('mailpit');
      await dialogo.getByLabel('Puerto').fill(puerto);
      await dialogo.getByLabel('Usuario (correo de la cuenta)').fill(remitente);
      await dialogo.getByLabel('Clave de aplicación').fill('clave-de-prueba');
    };
    const guardar = async () => {
      const pedido = page.waitForRequest(
        (r) => r.url().endsWith('/api/provider-accounts') && r.method() === 'POST',
      );
      await dialogo.getByRole('button', { name: 'Guardar email' }).click();
      const cuerpo = (await pedido).postDataJSON() as { config: { port: number; secure: boolean } };
      await expect(dialogo.getByText('Configuración de email guardada.')).toBeVisible();
      return cuerpo.config;
    };

    await llenar('465');
    expect(await guardar()).toMatchObject({ port: 465, secure: true });

    await llenar('1025');
    expect(await guardar()).toMatchObject({ port: 1025, secure: false });

    const desde = new Date(Date.now() - 1_000);
    await dialogo.getByRole('button', { name: 'Enviar correo de prueba' }).click();
    await expect(dialogo.getByText(`Correo de prueba enviado a ${USERS.adminA.email}`)).toBeVisible(
      { timeout: 30_000 },
    );
    const correo = await ultimoCorreo(USERS.adminA.email, { desde, esperaMs: 15_000 });
    expect(correo?.asunto).toBe('Correo de prueba · PlaneTour');
  });
});

test.describe('AGE-04 marca de la agencia', { tag: '@desktop' }, () => {
  test.setTimeout(120_000);

  test('validaciones, vista previa, recarga y quitar logo', async ({ page }) => {
    await page.goto('/configuracion');
    const original = (await (await page.request.get('/api/tenant/branding')).json()) as Record<
      string,
      unknown
    >;
    const devolver = {
      logoUrl: original['logoUrl'] ?? null,
      primaryColor: original['primaryColor'] ?? null,
      accentColor: original['accentColor'] ?? null,
    };

    try {
      await page.getByRole('button', { name: 'Marca' }).click();
      const primario = page.getByLabel('Color primario (hexadecimal)');
      const acento = page.getByLabel('Color de acento (hexadecimal)');
      const logo = page.getByLabel('URL del logotipo (Alternativa)');
      const guardar = page.getByRole('button', { name: 'Guardar identidad' });

      await primario.fill('#abc');
      await guardar.click();
      await expect(page.getByText(/hexadecimal de 6 dígitos/)).toBeVisible();

      await primario.fill('#1d4ed8');
      await acento.fill('#be123c');
      await logo.fill('http://cdn.example.com/logo.png');
      await guardar.click();
      await expect(page.getByText(/https:\/\//).filter({ hasText: /debe empezar/ })).toBeVisible();

      await logo.fill('https://cdn.example.com/logo.png');
      await expect(
        page.getByRole('heading', { name: 'Previsualización en tiempo real' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Botón Primario' })).toHaveCSS(
        'background-color',
        'rgb(29, 78, 216)',
      );
      await expect(page.getByText('Badge secundario')).toHaveCSS('color', 'rgb(190, 18, 60)');
      await guardar.click();
      await expect(
        page.getByText(
          'Identidad corporativa guardada. Recargue la página para aplicar los cambios.',
        ),
      ).toBeVisible();

      await page.reload();
      const variable = (nombre: string) =>
        page.evaluate(
          (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
          nombre,
        );
      await expect.poll(() => variable('--color-primary')).toBe('#1d4ed8');
      expect(await variable('--color-accent')).toBe('#be123c');

      await page.getByRole('button', { name: 'Marca' }).click();
      await expect(page.getByText('Logo actual activo')).toBeVisible();
      await page.getByRole('button', { name: 'Quitar logo' }).click();
      await guardar.click();
      await expect(
        page.getByText('Identidad corporativa guardada.', { exact: false }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: 'Marca' }).click();
      await expect(page.getByText('Arrastre o seleccione su logotipo')).toBeVisible();
      await expect(page.getByText('Logo actual activo')).toHaveCount(0);
    } finally {
      const r = await page.request.patch('/api/tenant/branding', { data: devolver });
      expect(r.ok(), 'devuelve la marca original').toBeTruthy();
    }
  });
});

test.describe('EQU-14 filtros de Equipo', { tag: '@desktop' }, () => {
  test('los filtros viajan en la URL, sobreviven a recargar y se limpian', async ({ page }) => {
    await page.goto('/admin/usuarios');
    await expect(page.getByRole('heading', { name: /^Miembros/ })).toBeVisible({ timeout: 20_000 });
    const chips = page.getByRole('group', { name: 'Filtrar miembros' });
    const miembro = (email: string) => page.getByText(email, { exact: true });
    await expect(miembro('api-reset@e2e.test')).toBeVisible();
    await expect(miembro(USERS.vendedorA.email)).toBeVisible();

    await chips.getByRole('button', { name: /^Cambio de contraseña pendiente/ }).click();
    await expect(page).toHaveURL(/[?&]filtro=cambio-de-contrasena/);
    await expect(miembro('api-reset@e2e.test')).toBeVisible();
    await expect(miembro(USERS.vendedorA.email)).toHaveCount(0);

    await page.getByLabel('Filtrar por rol').selectOption('vendedor');
    await expect(page).toHaveURL(/[?&]rol=vendedor/);

    await page.reload();
    await expect(
      chips.getByRole('button', { name: /^Cambio de contraseña pendiente/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Filtrar por rol')).toHaveValue('vendedor');
    await expect(miembro('api-reset@e2e.test')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Miembros \(\d+ de \d+\)/ })).toBeVisible();

    await page.getByRole('button', { name: 'Quitar filtros' }).first().click();
    await expect(page).not.toHaveURL(/filtro=|rol=/);
    await expect(miembro(USERS.vendedorA.email)).toBeVisible();

    await expect(miembro('api-suspendido@e2e.test')).toBeVisible();
    await page.getByLabel(/^Ocultar suspendidos/).check();
    await expect(page).toHaveURL(/[?&]suspendidos=ocultos/);
    await expect(miembro('api-suspendido@e2e.test')).toHaveCount(0);

    await page.getByRole('button', { name: /^Último acceso/ }).click();
    await expect(page).toHaveURL(/[?&]orden=acceso-reciente/);
    await page.reload();
    await expect(page.getByLabel(/^Ocultar suspendidos/)).toBeChecked();
    await expect(miembro('api-suspendido@e2e.test')).toHaveCount(0);
    await expect(page).toHaveURL(/orden=acceso-reciente/);

    await chips.getByRole('button', { name: /^Nunca ingresaron/ }).click();
    await expect(page).toHaveURL(/[?&]filtro=nunca-ingresaron/);
    await expect(miembro(USERS.adminA.email), 'admin-a ya entró').toHaveCount(0);

    await chips.getByRole('button', { name: 'Todos' }).click();
    await page.getByLabel('Buscar').fill('api-reset');
    await expect(miembro('api-reset@e2e.test')).toBeVisible();
    await expect(miembro(USERS.vendedorA.email)).toHaveCount(0);
    await page.getByLabel('Buscar').fill('zzz-nadie-qa19');
    await expect(page.getByText('Ningún usuario coincide con la búsqueda.')).toBeVisible();
  });
});
