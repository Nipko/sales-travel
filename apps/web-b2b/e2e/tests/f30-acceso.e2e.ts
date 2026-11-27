import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { E2E_PASSWORD, USERS } from '../support/users';

/**
 * Ola 3 del plan de QA (docs/qa/01 §5 ACC, AGE, RED), en el navegador:
 *
 * - ACC-03: campos vacíos → el navegador frena el envío; no sale ninguna llamada.
 * - ACC-12: `?next=` sólo lleva a una ruta propia (el resto de las formas raras las cubre
 *   safe-next.test.ts sin gastar ingresos: el api deja 10 por minuto por IP).
 * - ACC-13: con sesión, /login lleva directo a `next`.
 * - ACC-14: `?motivo=` muestra su aviso; uno fuera de la lista, nada.
 * - AGE-03 / RED-07 (QA-H-06, QA-H-09): un vendedor ve «sin acceso» en Ajustes y en Mi Red.
 *
 * Ingresa con `acceso@e2e.test`, que no usa nadie más.
 */

async function ingresar(page: Page, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Correo electrónico').fill(USERS.acceso.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

test.describe('ingreso', { tag: '@desktop' }, () => {
  test.describe.configure({ mode: 'serial' });

  test('ACC-03 sin correo ni contraseña avisa y no llama a la API', async ({ page }) => {
    const llamadas: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') llamadas.push(r.url());
    });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    // Los campos son `required`: el navegador frena el envío y marca el correo; el mensaje propio
    // («Ingresa tu correo y tu contraseña.») queda de respaldo en el servidor (login/actions.ts).
    const correo = page.getByLabel('Correo electrónico');
    expect(await correo.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(
      true,
    );
    await expect(page).toHaveURL(/\/login/);
    expect(llamadas).toEqual([]);
  });

  test('ACC-14 cada motivo muestra su aviso; uno inventado, ninguno', async ({ page }) => {
    await page.goto('/login?motivo=inactividad&minutos=15');
    await expect(
      page.getByText('Cerramos tu sesión después de 15 minutos sin actividad.'),
    ).toBeVisible();
    await page.goto('/login?motivo=otro-dispositivo');
    await expect(page.getByText('Tu sesión se abrió en otro dispositivo.')).toBeVisible();
    await page.goto('/login?motivo=liberada');
    await expect(page.getByText('Un administrador liberó tu puesto.')).toBeVisible();
    await page.goto('/login?motivo=hackeada');
    await expect(page.getByText(/Tu sesión|Cerramos tu sesión|liberó tu puesto/)).toHaveCount(0);
  });

  test('ACC-12 un next a otro sitio lleva al inicio', async ({ page }) => {
    await ingresar(page, '//evil.example.com/robar');
    const url = new URL(page.url());
    expect(url.host).toBe(new URL(test.info().project.use.baseURL!).host);
    expect(url.pathname).toBe('/');
  });

  test('ACC-13 con sesión, /login con next lleva directo a esa ruta propia', async ({ page }) => {
    await ingresar(page, '/reservas');
    await expect(page).toHaveURL(/\/reservas$/);
    await page.goto('/login?next=%2Fcotizaciones%2Fguardadas');
    await expect(page).toHaveURL(/\/cotizaciones\/guardadas$/);
  });
});

test.describe('guardas de página', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('AGE-03 / RED-07 un vendedor ve «sin acceso» en Ajustes y en Mi Red', async ({ page }) => {
    await page.goto('/configuracion');
    await expect(
      page.getByRole('heading', { name: 'Los ajustes son de quien administra la agencia' }),
    ).toBeVisible();
    await page.goto('/red');
    await expect(
      page.getByRole('heading', { name: 'Mi Red es de quien administra la agencia' }),
    ).toBeVisible();
  });
});
