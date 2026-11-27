import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/support/env';

/**
 * E2E del panel contra el stack de e2e/docker-compose.e2e.yml (ver e2e/README.md).
 *
 * - `setup`: inicia sesión con cada usuario de prueba (activando MFA donde el rol lo exige) y guarda
 *   el estado en e2e/.auth para que el resto no repita el login: el api limita /auth/login a 10 por
 *   minuto por IP y todo el E2E sale de la misma.
 * - `desktop` y `mobile` (375 px): los tests con @auth o @desktop sólo corren en desktop, y los
 *   @mobile sólo en mobile.
 *
 * - `@real`: ventas con proveedores reales (Sabre CERT, TBO test, Despegar api-dev). Sólo desktop y
 *   sólo con `E2E_REAL=1`; el stack local de docker-compose.e2e.yml no tiene proveedores.
 *
 * - `api`: el arnés HTTP (e2e/api/*.api.ts, INF-1 de docs/qa/01). Pega a la API sin navegador, con sus
 *   propias personas `api-*@e2e.test` (una por rol); no depende de `setup`.
 *
 * `PW_CHANNEL=chrome` (o `msedge`) usa el navegador instalado en vez del Chromium de Playwright.
 */
const channel = process.env['PW_CHANNEL'];
/** `E2E_REAL=1`: corre también las ventas `@real` contra los sandboxes (sólo el ambiente de pruebas). */
const real = process.env['E2E_REAL'] === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  // `next dev` compila cada ruta la primera vez que se pide (5–15 s).
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    // Lo lee tools/qa/resultados.mjs para pasar los resultados al tablero de QA (docs/qa/estado.json).
    ['json', { outputFile: 'playwright-report/resultados.json' }],
  ],
  use: {
    baseURL: E2E.webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts$/ },
    { name: 'api', testMatch: /.*\.api\.ts$/, timeout: 300_000 },
    {
      name: 'desktop',
      dependencies: ['setup'],
      grepInvert: real ? /@mobile/ : /@mobile|@real/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        ...(channel ? { channel } : {}),
      },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      grepInvert: /@auth|@desktop|@real/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 812 },
        ...(channel ? { channel } : {}),
      },
    },
  ],
  webServer: {
    command: 'node ./node_modules/next/dist/bin/next dev --port 3101',
    url: `${E2E.webUrl}/login`,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    env: { INTERNAL_API_URL: E2E.apiUrl },
  },
});
