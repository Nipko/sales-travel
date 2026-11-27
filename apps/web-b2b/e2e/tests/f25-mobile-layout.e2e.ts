import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

// F25 · Mobile-first a 375 px (docs/platform/21 §8.2): las rutas de venta del vendedor no tienen
// scroll horizontal y el contenido respeta un margen lateral.
test.use({ storageState: storageStateFile('vendedorA') });

const SALES_ROUTES = [
  '/',
  '/cotizaciones',
  '/cotizaciones/guardadas',
  '/hoteles',
  '/autos',
  '/paquetes',
  '/paquetes/guardados',
  '/reservas',
  '/clientes',
  '/carteras',
] as const;

const MIN_GUTTER_PX = 12;

/** Bugs conocidos (docs/platform/21 §4.1): el test se marca como falla esperada hasta que se arreglen. */
// BUG-E2E-02 (Paquetes sin margen lateral) se corrigió en la tanda 11 de QA: hoy no hay ninguno.
const KNOWN_BUGS: Partial<Record<(typeof SALES_ROUTES)[number], string>> = {};

test.describe('F25 · 375 px', { tag: '@mobile' }, () => {
  for (const route of SALES_ROUTES) {
    test(`${route} sin scroll horizontal y con margen lateral`, async ({ page }) => {
      const bug = KNOWN_BUGS[route];
      if (bug) {
        test.info().annotations.push({ type: 'bug', description: bug });
        test.fail(!process.env['E2E_SHOW_BUGS']);
      }
      await page.goto(route);
      const heading = page.locator('main h1').first();
      await expect(heading).toBeVisible();
      await page.waitForLoadState('networkidle');

      const { scrollWidth, innerWidth, headingLeft } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        headingLeft: document.querySelector('main h1')?.getBoundingClientRect().left ?? -1,
      }));
      expect(scrollWidth, 'ancho del documento').toBeLessThanOrEqual(innerWidth);
      expect(headingLeft, 'margen izquierdo del título').toBeGreaterThanOrEqual(MIN_GUTTER_PX);
    });
  }
});
