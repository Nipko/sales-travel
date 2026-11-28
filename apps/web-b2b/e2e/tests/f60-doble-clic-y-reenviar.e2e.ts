import { expect, test, type Page } from '@playwright/test';
import { sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';
import { apiComo, fechaEn } from '../support/venta';

/**
 * Tanda 35 en el navegador (docs/qa/01 §5 CHK y POS):
 *
 * - CHK-14: doble clic en «Reservar» del resumen deja una sola reserva y lleva a su ficha (antes el
 *   segundo clic mandaba otro pedido y el 409 llevaba a la conciliación).
 * - POS-15: la ficha de esa reserva ofrece «Reenviar confirmación» en «Más acciones»; al cancelarla ya no.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('vendedorA') });

const resumen = (page: Page) => page.getByRole('complementary', { name: 'Resumen del precio' });

async function cotizacion(): Promise<string> {
  const api = await apiComo('vendedorA');
  try {
    const searchCriteria = {
      origin: 'BOG',
      destination: 'MDE',
      departureDate: fechaEn(91).toISOString().slice(0, 10),
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
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { quotation: { id: string } }).quotation.id;
  } finally {
    await api.dispose();
  }
}

test.describe('doble clic y reenviar', { tag: '@desktop' }, () => {
  test.setTimeout(180_000);

  test('CHK-14 / POS-15 una sola reserva; reenviar sólo mientras está confirmada', async ({
    page,
  }) => {
    const email = `qa35-doble-${Date.now().toString(36)}@e2e.test`;
    const id = await cotizacion();
    await page.goto(`/cotizaciones/${id}`);
    await expect(resumen(page).getByText('Precio confirmado')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('textbox', { name: 'Nombre(s) *' }).fill('PRUEBA');
    await page.getByRole('textbox', { name: 'Apellido(s) *' }).fill('DOBLECLIC');
    await page.getByRole('textbox', { name: 'Fecha de nacimiento' }).fill('15/05/1990');
    await page.getByRole('textbox', { name: 'Número de documento *' }).first().fill('1020304050');
    await page.getByRole('textbox', { name: 'Email *' }).first().fill(email);
    await page.getByRole('textbox', { name: 'Teléfono *' }).first().fill('3001234567');

    await resumen(page).getByRole('button', { name: 'Reservar' }).dblclick();
    await expect(page).toHaveURL(/\/reservas\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    await expect(page.getByRole('status').filter({ hasText: /^Confirmada$/ })).toBeVisible();
    const [n] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE contact_info ->> 'email' = $1`,
      [email],
    );
    expect(n?.n, 'una sola reserva').toBe('1');

    await page.getByRole('button', { name: 'Más acciones' }).click();
    await expect(page.getByRole('menuitem', { name: 'Reenviar confirmación' })).toBeVisible();
    await page.keyboard.press('Escape');

    const ordenId = page.url().split('/').pop()!;
    const api = await apiComo('vendedorA');
    try {
      const c = await api.post(`orders/${ordenId}/cancel`, { data: {} });
      expect(c.ok(), await c.text()).toBeTruthy();
    } finally {
      await api.dispose();
    }
    await page.reload();
    const mas = page.getByRole('button', { name: 'Más acciones' });
    if (await mas.isVisible()) {
      await mas.click();
      await expect(page.getByRole('menuitem', { name: 'Reenviar confirmación' })).toHaveCount(0);
    }
  });
});
