import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { elegirDias, elegirLugar, fechaEn } from '../support/venta';

// F17 con proveedores reales (docs/platform/21 §8.2): paquete vuelo + hotel BOG → MDE con Sabre CERT
// y los hoteles de la red, cotización creada y su PDF.
test.use({ storageState: storageStateFile('vendedorA') });

const IDA = fechaEn(50);
const VUELTA = fechaEn(53);

test.describe('F17 · paquete real', { tag: ['@real', '@desktop'] }, () => {
  test.setTimeout(180_000);

  test('arma vuelo + hotel BOG → MDE y crea la cotización con su PDF', async ({ page }) => {
    await page.goto('/paquetes');
    await expect(page.getByRole('button', { name: 'Vuelo', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Hotel', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await elegirLugar(page, 'Desde', 'BOG', /^Bogot[aá] \(BOG\)/);
    await elegirLugar(page, 'Destino', 'MDE', /^Medellín.*MDE/);
    await page.getByRole('button', { name: /^Ida/ }).click();
    await elegirDias(page, IDA, VUELTA);
    await page.getByRole('button', { name: 'Buscar paquete' }).click();

    const vuelo = page.getByRole('region', { name: 'Vuelo' });
    const hotel = page.getByRole('region', { name: 'Hotel' });
    await expect(vuelo.getByRole('button', { name: /^Cambiar · \d+$/ })).toBeVisible({
      timeout: 90_000,
    });
    await expect(hotel.getByRole('button', { name: /^Cambiar · \d+$/ })).toBeVisible({
      timeout: 90_000,
    });
    await expect(vuelo.getByRole('alert')).toHaveCount(0);

    await page.getByRole('button', { name: 'Crear cotización' }).click();
    await expect(page).toHaveURL(/\/paquetes\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByText(/Cotización PQ-[0-9A-F]+/)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: /^Medellín · 3 noches$/ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vuelos', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alojamiento', level: 2 })).toBeVisible();

    const pdf = page.getByRole('link', { name: /PDF/ });
    const href = await pdf.getAttribute('href');
    expect(href, 'el enlace al PDF').toBeTruthy();
    // Desde la página: las cookies de sesión son Secure y el cliente de API de Playwright no las manda por http.
    const pdfRes = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return {
        status: r.status,
        type: r.headers.get('content-type'),
        bytes: (await r.arrayBuffer()).byteLength,
      };
    }, href!);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.type).toContain('application/pdf');
    expect(pdfRes.bytes).toBeGreaterThan(1_000);
  });
});
