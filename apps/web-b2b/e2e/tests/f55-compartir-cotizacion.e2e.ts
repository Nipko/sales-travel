import { expect, test } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { apiComo, fechaEn } from '../support/venta';

/**
 * Tanda 30 en el navegador (docs/qa/01 §5 CHK y COT): «Compartir cotización» en el checkout de vuelos.
 *
 * - CHK-13: sin email ni teléfono de facturación, «Enviar por email» y «Enviar por WhatsApp» quedan
 *   deshabilitados con su motivo; con ellos, el correo llega a Mailpit y WhatsApp abre wa.me con el
 *   número y el texto de la cotización.
 * - COT-04 (mitad E): el envío por correo avisa «Cotización enviada a …».
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('vendedorA') });

async function cotizacion(): Promise<string> {
  const api = await apiComo('vendedorA');
  try {
    const searchCriteria = {
      origin: 'BOG',
      destination: 'MDE',
      departureDate: fechaEn(56).toISOString().slice(0, 10),
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: 'COP',
    };
    const b = await api.post('search/flights', { data: searchCriteria });
    const { offers } = (await b.json()) as {
      offers: { provider: { name: string; offerRef: string } }[];
    };
    const offer = offers.find(
      (o) => o.provider.name === 'fake-flights' && o.provider.offerRef.startsWith('FAKE-FIJO'),
    );
    const r = await api.post('quotations', {
      data: {
        searchCriteria,
        selectedOffer: offer,
        customerName: 'Cliente Compartir',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { quotation: { id: string } }).quotation.id;
  } finally {
    await api.dispose();
  }
}

test.describe('CHK-13 compartir la cotización', { tag: '@desktop' }, () => {
  test.setTimeout(120_000);

  test('deshabilitado sin datos; con ellos, correo y WhatsApp', async ({ page }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    await page.addInitScript(() => {
      const w = window as unknown as { __abiertas: string[] };
      w.__abiertas = [];
      window.open = (url?: string | URL) => {
        w.__abiertas.push(String(url));
        return null;
      };
    });
    const id = await cotizacion();
    await page.goto(`/cotizaciones/${id}`);

    const compartir = page.getByRole('button', { name: 'Compartir cotización' });
    await expect(compartir).toBeVisible({ timeout: 30_000 });
    await compartir.click();
    await expect(page.getByRole('menuitem', { name: /^Enviar por email/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByRole('menuitem', { name: /^Enviar por email/ })).toContainText(
      'Escribe el email en «Facturación»',
    );
    await expect(page.getByRole('menuitem', { name: /^Enviar por WhatsApp/ })).toContainText(
      'Escribe el teléfono en «Facturación»',
    );
    await page.keyboard.press('Escape');

    const email = `qa30-ui-${Date.now().toString(36)}@e2e.test`;
    await page.locator('#billing-email').fill(email);
    await page.locator('#billing-phone').fill('3001234567');

    const desde = new Date(Date.now() - 1_000);
    await compartir.click();
    await page.getByRole('menuitem', { name: /^Enviar por email/ }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `Cotización enviada a ${email}` }),
    ).toBeVisible({
      timeout: 20_000,
    });
    const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
    expect(correo?.asunto).toMatch(/^\[PRUEBA\] Tu cotización de vuelo #\d+ · BOG → MDE$/);

    await compartir.click();
    await page.getByRole('menuitem', { name: /^Enviar por WhatsApp/ }).click();
    const abiertas = await page.evaluate(
      () => (window as unknown as { __abiertas: string[] }).__abiertas,
    );
    const wa = abiertas.find((u) => u.startsWith('https://wa.me/'));
    expect(wa, 'abre WhatsApp').toBeTruthy();
    expect(wa).toMatch(/^https:\/\/wa\.me\/\d*3001234567\?text=/);
    expect(decodeURIComponent(wa!.split('?text=')[1]!)).toContain('Te envío cotización #');
  });
});
