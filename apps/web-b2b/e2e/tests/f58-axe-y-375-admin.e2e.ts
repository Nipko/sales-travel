import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { storageStateFile } from '../support/auth';

/**
 * Tanda 33 (docs/qa/01 §5 TRV): TRV-17 y TRV-18 en las rutas que F25 y F26 no cubrían, las de
 * administración (admin-a) y las de la plataforma (superadmin).
 *
 * - TRV-18: axe WCAG 2.1 A/AA, temas claro y oscuro; falla con cualquier violación seria o crítica que
 *   no esté en e2e/a11y-baseline.json (la línea base sólo se achica).
 * - TRV-17: a 375 px el documento no se pasa del ancho de la pantalla y el título deja margen.
 */

type Theme = 'dark' | 'light';
const BASELINE = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'a11y-baseline.json'), 'utf8'),
) as Record<string, string[]>;

const ADMIN_ROUTES = [
  '/red',
  '/admin/usuarios',
  '/admin/proveedores',
  '/configuracion',
  '/configuracion/perfil',
  '/configuracion/seguridad',
  '/reportes',
  '/autos/oficinas',
  '/autos/reporte',
] as const;

const PLATFORM_ROUTES = [
  '/admin/plataforma/estado',
  '/admin/plataforma/salud',
  '/admin/plataforma/resumen',
  '/admin/plataforma/actividad',
  '/admin/plataforma/sistema',
  '/admin/plataforma/sistema/anuncios',
  '/admin/plataforma/proveedores',
  '/admin/plataforma/reservas',
  '/admin/plataforma/carteras',
  '/admin/plataforma/usuarios',
  '/admin/plataforma/superadmins',
  '/admin/tenants',
] as const;

async function abrir(page: Page, route: string, theme?: Theme): Promise<void> {
  if (theme) {
    await page.addInitScript((t) => {
      try {
        window.localStorage.setItem('st-theme', t);
      } catch {
        /* sin storage: queda el tema por defecto */
      }
    }, theme);
  }
  await page.goto(route);
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

async function axe(page: Page, route: string, theme: Theme, testInfo: TestInfo): Promise<void> {
  await abrir(page, route, theme);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('nextjs-portal')
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  await testInfo.attach('axe-serious.json', {
    body: JSON.stringify(serious, null, 2),
    contentType: 'application/json',
  });
  const key = `${testInfo.project.name} ${theme} ${route}`;
  const known = new Set(BASELINE[key] ?? []);
  const fresh = serious.filter((v) => !known.has(v.rule));
  expect(fresh, `violaciones nuevas en ${key}`).toEqual([]);
}

async function sinScroll(page: Page, route: string): Promise<void> {
  await abrir(page, route);
  const { scrollWidth, innerWidth, left } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    left: document.querySelector('main h1')?.getBoundingClientRect().left ?? -1,
  }));
  expect(scrollWidth, `ancho del documento en ${route}`).toBeLessThanOrEqual(innerWidth);
  expect(left, `margen del título en ${route}`).toBeGreaterThanOrEqual(12);
}

for (const [quien, rutas] of [
  ['adminA', ADMIN_ROUTES],
  ['superadmin', PLATFORM_ROUTES],
] as const) {
  test.describe(`TRV-18 axe · ${quien}`, { tag: '@desktop' }, () => {
    test.use({ storageState: storageStateFile(quien) });
    for (const theme of ['dark', 'light'] as const) {
      for (const route of rutas) {
        test(`${route} · tema ${theme}`, async ({ page }, testInfo) => {
          await axe(page, route, theme, testInfo);
        });
      }
    }
  });

  test.describe(`TRV-17 375 px · ${quien}`, { tag: '@mobile' }, () => {
    test.use({ storageState: storageStateFile(quien) });
    for (const route of rutas) {
      test(`${route} sin scroll horizontal`, async ({ page }) => {
        await sinScroll(page, route);
      });
    }
  });
}
