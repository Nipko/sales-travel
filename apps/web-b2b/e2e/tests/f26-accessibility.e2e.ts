import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';

// F26 · Accesibilidad con axe (WCAG 2.1 A/AA) en las rutas principales, tema oscuro y claro
// (docs/platform/21 §8.2). Falla con cualquier violación seria o crítica que NO esté en la línea base
// (e2e/a11y-baseline.json). La línea base registra lo que ya se sabe roto: sólo debe achicarse.

type Theme = 'dark' | 'light';
type Baseline = Record<string, string[]>;

const BASELINE: Baseline = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'a11y-baseline.json'), 'utf8'),
) as Baseline;

const ROUTES = [
  '/',
  '/cotizaciones',
  '/hoteles',
  '/autos',
  '/paquetes',
  '/reservas',
  '/clientes',
] as const;
const THEMES: Theme[] = ['dark', 'light'];

test.use({ storageState: storageStateFile('vendedorA') });

test.describe('F26 · axe', () => {
  for (const theme of THEMES) {
    for (const route of ROUTES) {
      test(`${route} · tema ${theme}`, async ({ page }, testInfo) => {
        await page.addInitScript((t) => {
          try {
            window.localStorage.setItem('st-theme', t);
          } catch {
            /* sin storage: queda el tema por defecto */
          }
        }, theme);
        await page.goto(route);
        await expect(page.locator('main h1').first()).toBeVisible();
        await page.waitForLoadState('networkidle');

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          // El overlay de desarrollo de Next no es parte del panel.
          .exclude('nextjs-portal')
          .analyze();

        const serious = results.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        const summary = serious.map((v) => ({
          rule: v.id,
          impact: v.impact,
          nodes: v.nodes.length,
          sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        }));
        await testInfo.attach('axe-serious.json', {
          body: JSON.stringify(summary, null, 2),
          contentType: 'application/json',
        });

        const key = `${testInfo.project.name} ${theme} ${route}`;
        const known = new Set(BASELINE[key] ?? []);
        const fresh = summary.filter((v) => !known.has(v.rule));
        expect(fresh, `violaciones nuevas en ${key}`).toEqual([]);
      });
    }
  }
});
