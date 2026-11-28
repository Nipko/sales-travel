import { expect, test } from '@playwright/test';
import { sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';
import { USERS } from '../support/users';

/**
 * Tanda 22 en el navegador (docs/qa/01 §5 TRV):
 *
 * - TRV-19: teclado en el combobox de ruta (flechas, Enter, Escape), el calendario (flechas, Enter,
 *   Escape devuelve el foco), el menú «Acciones» (Enter, flechas, Escape) y su confirmación (foco en
 *   «Cancelar», Tab atrapado, Escape devuelve el foco al menú).
 * - TRV-20: con ventas confirmadas en COP y USD en el mismo mes, Inicio, Reportes y el resumen de la
 *   plataforma muestran cada moneda por separado; ningún total las suma.
 */

test.describe('TRV-19 teclado', { tag: '@desktop' }, () => {
  test.describe('vendedor en la búsqueda de vuelos', () => {
    test.use({ storageState: storageStateFile('vendedorA') });

    test('combobox de ruta y calendario sólo con teclado', async ({ page }) => {
      await page.goto('/cotizaciones');
      const origen = page.getByRole('combobox', { name: 'Origen', exact: true });
      const activaEs = async () => {
        const id = await origen.getAttribute('aria-activedescendant');
        return id ? ((await page.locator(`[id="${id}"]`).getAttribute('aria-label')) ?? '') : '';
      };
      // La lista se vuelve a filtrar cuando llegan los resultados y, en CI, a veces después de
      // marcar la opción: borra lo marcado. Se repite la secuencia entera (escribir, flechas, Enter)
      // hasta que el campo queda con Medellín, que es lo que se prueba: que el teclado basta.
      await expect(async () => {
        await origen.focus();
        await origen.fill('MDE');
        await expect(origen).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('option', { name: /MDE|Medellín/ }).first()).toBeVisible();
        for (let i = 0; i < 10 && !/MDE|Medellín/.test(await activaEs()); i++) {
          await page.keyboard.press('ArrowDown');
        }
        const activa = await origen.getAttribute('aria-activedescendant');
        expect(activa, 'la flecha marca una opción').toBeTruthy();
        await expect(page.locator(`[id="${activa}"]`)).toHaveAttribute('aria-selected', 'true', {
          timeout: 2_000,
        });
        await page.keyboard.press('Enter');
        await expect(origen).toHaveAttribute('aria-expanded', 'false', { timeout: 2_000 });
        await expect(origen).toHaveValue(/MDE|Medellín/, { timeout: 2_000 });
      }).toPass({ timeout: 45_000 });

      const destino = page.getByRole('combobox', { name: 'Destino', exact: true });
      await destino.focus();
      await destino.fill('CTG');
      await expect(destino).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(destino).toHaveAttribute('aria-expanded', 'false');
      await expect(destino).toBeFocused();

      const ida = page.getByRole('button', { name: /^Ida/ });
      await ida.focus();
      await page.keyboard.press('Enter');
      const calendario = page.getByRole('dialog', { name: /^Elegir fecha/ });
      await expect(calendario).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(calendario).toBeHidden();
      await expect(ida, 'Escape devuelve el foco al botón').toBeFocused();

      await page.keyboard.press('Enter');
      await expect(calendario).toBeVisible();
      const enfocado = calendario.getByRole('gridcell').and(page.locator('[tabindex="0"]'));
      await enfocado.first().focus();
      const antes = await enfocado.first().getAttribute('aria-label');
      await page.keyboard.press('ArrowRight');
      const despues = await calendario
        .getByRole('gridcell')
        .and(page.locator('[tabindex="0"]'))
        .first()
        .getAttribute('aria-label');
      expect(despues, 'la flecha mueve el día enfocado').not.toBe(antes);
      await page.keyboard.press('PageDown');
      await page.keyboard.press('Enter');
      await expect(
        calendario.locator('[role="gridcell"][aria-selected="true"]').first(),
      ).toBeVisible();
    });
  });

  test.describe('admin en Equipo', () => {
    test.use({ storageState: storageStateFile('adminA') });

    test('menú «Acciones» y su confirmación sin mouse', async ({ page }) => {
      await page.goto('/admin/usuarios');
      const disparador = page
        .locator('tr, li')
        .filter({ has: page.getByText('api-multi@e2e.test', { exact: true }) })
        .getByRole('button', { name: /^Acciones sobre / })
        .first();
      await disparador.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(disparador, 'Escape vuelve al botón del menú').toBeFocused();

      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      const suspender = menu.getByRole('menuitem', { name: /^Suspender/ });
      for (
        let i = 0;
        i < 10 && !(await suspender.evaluate((e) => e === document.activeElement));
        i++
      ) {
        await page.keyboard.press('ArrowDown');
      }
      await expect(suspender).toBeFocused();
      await page.keyboard.press('Enter');

      const confirmar = page.getByRole('dialog', { name: /^Suspender a / });
      await expect(confirmar).toBeVisible();
      const cancelar = confirmar.getByRole('button', { name: 'Cancelar' });
      await expect(cancelar, 'el foco empieza en lo que no hace daño').toBeFocused();
      for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
      expect(
        await confirmar.evaluate((d) => d.contains(document.activeElement)),
        'Tab no sale del diálogo',
      ).toBe(true);
      await page.keyboard.press('Escape');
      await expect(confirmar).toBeHidden();
      await expect(disparador, 'al cerrar, el foco vuelve al menú').toBeFocused();
      await expect(
        page
          .locator('tr, li')
          .filter({ has: page.getByText('api-multi@e2e.test', { exact: true }) }),
      ).not.toContainText('Suspendido');
    });
  });
});

test.describe('TRV-20 una moneda por total', { tag: '@desktop' }, () => {
  let clon = '';

  test.beforeAll(async () => {
    const cols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'orders' AND is_generated = 'NEVER'
          AND column_name NOT IN ('id', 'order_number', 'currency', 'status', 'create_request_key',
                                  'provider_booking_ref', 'created_at', 'updated_at')
        ORDER BY ordinal_position`,
    );
    const lista = cols.map((c) => `"${c.column_name}"`).join(', ');
    const [fila] = await sql<{ id: string }>(
      `INSERT INTO orders (${lista}, order_number, currency, status, created_at, updated_at)
       SELECT ${lista},
              (SELECT coalesce(max(order_number), 0) + 1 FROM orders WHERE tenant_id = o.tenant_id),
              'USD', 'confirmed', now(), now()
         FROM orders o
        WHERE o.status = 'confirmed' AND o.currency = 'COP'
          AND o.user_id = (SELECT id FROM users WHERE email = $1)
        ORDER BY o.created_at DESC LIMIT 1
       RETURNING id`,
      [USERS.vendedorA.email],
    );
    expect(fila?.id, 'hay una venta COP de vendedor-a para copiar en USD').toBeTruthy();
    clon = fila!.id;
  });

  test.afterAll(async () => {
    if (clon) await sql('DELETE FROM orders WHERE id = $1', [clon]).catch(() => []);
  });

  test.describe('agencia', () => {
    test.use({ storageState: storageStateFile('vendedorA') });

    test('Inicio y Reportes: COP y USD por separado', async ({ page }) => {
      await page.goto('/');
      const tarjeta = page
        .locator('div')
        .filter({ has: page.getByText('Ventas del mes', { exact: true }) })
        .filter({ hasText: 'Confirmadas y emitidas' })
        .last();
      const lineas = (await tarjeta.locator('span.block').allInnerTexts()).map((t) => t.trim());
      expect(lineas.some((l) => / COP$/.test(l))).toBe(true);
      expect(lineas.some((l) => / USD$/.test(l))).toBe(true);
      for (const l of lineas) expect(l).toMatch(/^[\d.,]+ [A-Z]{3}$/);

      await page.goto('/reportes');
      await expect(page.getByText('USD', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('COP', { exact: true }).first()).toBeVisible();
    });
  });

  test.describe('plataforma', () => {
    test.use({ storageState: storageStateFile('superadmin') });

    test('el resumen tiene una tarjeta de ventas por moneda', async ({ page }) => {
      await page.goto('/admin/plataforma/resumen');
      await expect(page.getByLabel('Ventas confirmadas en COP')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel('Ventas confirmadas en USD')).toBeVisible();
    });
  });
});
